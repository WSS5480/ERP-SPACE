// purchasing module -- see docs/MODULES.md for the contract.
// The owner's buying program: budgets and open-to-buy, the order form, POs
// per vendor per ship-to, the special-order queue, acknowledgments and ETAs,
// landed cost, reorder points and the vendor CSV files.
import { today as bizToday } from "../../packages/core/clock.ts";
import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { ModuleError, need, requireRole, str, uuid, int, minor } from "./kit.ts";
import { q } from "../../packages/core/db.ts";
import { scopeOf } from "../actions.ts";
import * as pur from "../../packages/core/purchasing.ts";
import { CatalogError, saveVendorProfile } from "../../packages/core/catalog.ts";
import { InventoryError } from "../../packages/core/inventory.ts";
import { PricingError } from "../../packages/core/pricing.ts";
import { FeedError } from "../../packages/core/vendor_feeds.ts";
import { currentFeedEnv } from "./catalog.ts";

const ID = "([0-9a-fA-F-]{36})";
const BUY = ["buyer"];
const STORE = ["buyer", "store_manager"];
const monthParam = async (c: Client, co: Company, url: URL) => {
  const m = str(url.searchParams.get("month"), 10);
  if (/^\d{4}-\d{2}$/.test(m)) return m + "-01";
  if (/^\d{4}-\d{2}-\d{2}$/.test(m)) return m.slice(0, 8) + "01";
  return (await bizToday(c, co.id)).slice(0, 8) + "01";
};

async function refuse<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof pur.PurchasingError || e instanceof CatalogError || e instanceof InventoryError || e instanceof PricingError || e instanceof FeedError) throw new ModuleError(e.message);
    throw e;
  }
}

const placedOut = (p: pur.Placed[]) => ({ placed: p.map((x) => ({ ...x, totalMinor: x.totalMinor.toString() })) });

// ----------------------------------------------------------------- reads

async function home(c: Client, co: Company) {
  const [pos] = await q<{ open_n: string; open_minor: string; unack_n: string; late_n: string }>(c, `
    select count(*) filter (where po.status = 'open') open_n,
           coalesce(sum(t.total) filter (where po.status = 'open'), 0) open_minor,
           count(*) filter (where po.status = 'open' and po.acknowledged_on is null) unack_n,
           count(*) filter (where po.status = 'open' and po.expected_on < business_today($1)) late_n
      from purchase_order po
      left join lateral (select sum(round((l.quantity - l.cancelled_qty) * l.unit_price_minor))::bigint total
                           from purchase_order_line l where l.purchase_order_id = po.id) t on true
     where po.entity_id = $1 and po.ship_to_location_id is not null`, [co.id]);
  const queue = await pur.specialOrderQueue(c, co.id);
  const sugg = await pur.replenishment(c, co.id);
  const otb = await pur.openToBuy(c, co.id, (await bizToday(c, co.id)).slice(0, 8) + "01");
  const sum = (k: "budget_minor" | "committed_minor" | "open_minor") => otb.reduce((a, r) => a + BigInt(r[k]), 0n).toString();
  return { pos, queue: queue.length, suggestions: sugg.length, otb: { budget: sum("budget_minor"), committed: sum("committed_minor"), open: sum("open_minor"),
    over: otb.filter((r) => BigInt(r.open_minor) < 0n).length } };
}

async function listPOs(c: Client, co: Company, url: URL) {
  const status = str(url.searchParams.get("status"), 20) || "open";
  const vendor = uuid(url.searchParams.get("vendor"));
  return { pos: await q(c, `
    select po.id, po.number, po.status, po.kind, po.ordered_on::text, po.expected_on::text, po.acknowledged_on::text, po.vendor_ref,
           po.exported_at, coalesce(v.dba, v.legal_name) vendor, po.vendor_id, l.name ship_to,
           t.total total_minor, t.lines, t.landed landed_minor,
           (select count(*) from po_line_sales_line k join purchase_order_line x on x.id = k.purchase_order_line_id
             where k.entity_id = po.entity_id and x.purchase_order_id = po.id and k.active) customer_lines,
           (po.status = 'open' and po.expected_on < business_today($1)) late
      from purchase_order po join vendor v on v.id = po.vendor_id join location l on l.id = po.ship_to_location_id
      left join lateral (select sum(round((x.quantity - x.cancelled_qty) * x.unit_price_minor))::bigint total, count(*) lines, sum(x.landed_minor) landed
                           from purchase_order_line x where x.purchase_order_id = po.id) t on true
     where po.entity_id = $1 and ($2 = 'all' or po.status = $2) and ($3::uuid is null or po.vendor_id = $3)
     order by po.ordered_on desc, po.number desc limit 200`, [co.id, status, vendor]) };
}

async function poDetail(c: Client, co: Company, id: string) {
  const po = (await q(c, `
    select po.*, po.ordered_on::text ordered_on, po.expected_on::text expected_on, po.acknowledged_on::text acknowledged_on,
           coalesce(v.dba, v.legal_name) vendor, l.name ship_to, l.code ship_to_code, u.name created_by_name,
           vp.order_email, vp.freight_min_minor
      from purchase_order po join vendor v on v.id = po.vendor_id left join location l on l.id = po.ship_to_location_id
      left join app_user u on u.id = po.created_by
      left join vendor_profile vp on vp.entity_id = po.entity_id and vp.vendor_id = po.vendor_id
     where po.id = $1 and po.entity_id = $2`, [id, co.id]))[0];
  if (!po) return null;
  const lines = await q(c, `
    select pol.id, pol.seq, pol.description, pol.quantity, pol.cancelled_qty, pol.unit_price_minor, pol.landed_minor, pol.vendor_sku,
           pol.category, pol.config, pol.expected_on::text, pol.ack_status, pol.agreement_ref, p.sku, p.id product_id, pol.price_review_note, pol.price_changed_from,
           coalesce((select sum(g.quantity) from goods_receipt_line g where g.purchase_order_line_id = pol.id), 0) received,
           (select json_agg(json_build_object('order', so.number, 'orderId', so.id, 'customer', cu.name, 'expected', k.expected_on))
              from po_line_sales_line k join sales_order_line sl on sl.id = k.sales_order_line_id
              join sales_order so on so.id = sl.sales_order_id left join customer cu on cu.id = so.customer_id
             where k.purchase_order_line_id = pol.id and k.active) customers
      from purchase_order_line pol left join product p on p.id = pol.product_id
     where pol.purchase_order_id = $1 and pol.entity_id = $2 order by pol.seq`, [id, co.id]);
  const landed = await q(c, `select lc.kind, lc.amount_minor, lc.basis, lc.note, lc.created_at, u.name by_name
                               from po_landed_cost lc left join app_user u on u.id = lc.created_by
                              where lc.entity_id = $1 and lc.purchase_order_id = $2 order by lc.created_at`, [co.id, id]);
  const sent = await q(c, `select t.method, t.status, t.destination, t.detail, t.vendor_ref, t.sent_at, u.name by_name
                             from po_transmission t left join app_user u on u.id = t.sent_by
                            where t.entity_id = $1 and t.purchase_order_id = $2 order by t.sent_at desc`, [co.id, id]);
  return { po, lines, landed, sent };
}

async function orderForm(c: Client, co: Company, url: URL) {
  const vendors = await q<{ id: string; name: string; order_email: string | null; lead_days: number; freight_min_minor: string; freight_min_qty: number }>(c, `
    select v.id, coalesce(v.dba, v.legal_name) as name, vp.order_email, coalesce(vp.lead_days, 30) lead_days,
           coalesce(vp.freight_min_minor, 0) freight_min_minor, coalesce(vp.freight_min_qty, 0) freight_min_qty
      from vendor_entity ve join vendor v on v.id = ve.vendor_id
      left join vendor_profile vp on vp.entity_id = ve.entity_id and vp.vendor_id = v.id
     where ve.entity_id = $1 and ve.status = 'active' and exists (select 1 from vendor_merchandise vm where vm.entity_id = ve.entity_id and vm.vendor_id = ve.vendor_id and vm.is_merchandise)
       and exists (select 1 from product p where p.entity_id = ve.entity_id and p.vendor_id = v.id and p.kind = 'stock')
     order by 2`, [co.id]);
  const locations = await q(c, `select id, code, name, kind from location where entity_id = $1 and status = 'active' and kind in ('warehouse','store','outlet')
                                 order by kind <> 'warehouse', name`, [co.id]);
  const vendorId = uuid(url.searchParams.get("vendor")) ?? vendors[0]?.id ?? null;
  const month = await monthParam(c, co, url);
  if (!vendorId) return { vendors, locations, vendor: null, products: [], otb: [], month };
  const vendor = vendors.find((v) => v.id === vendorId);
  need(vendor, "that vendor is not active for this company");
  const products = await q(c, `
    select p.id, p.sku, p.name, p.vendor_sku, p.category, p.collection, p.color, p.status, p.cost_minor, p.price_minor,
           (select url from product_image i where i.entity_id = p.entity_id and i.product_id = p.id order by seq limit 1) image,
           coalesce((select json_agg(json_build_object('location', a.location_id, 'available', a.available, 'onOrder', a.on_order))
                       from product_availability a where a.entity_id = p.entity_id and a.product_id = p.id), '[]') stock,
           coalesce((select json_agg(json_build_object('location', r.location_id, 'min', r.min_qty, 'max', r.max_qty))
                       from reorder_rule r where r.entity_id = p.entity_id and r.product_id = p.id and r.active), '[]') rules,
           (select json_build_object('qty', va.qty_available, 'leadDays', va.lead_days, 'exception', va.exception, 'asOf', va.as_of)
              from vendor_availability va where va.entity_id = p.entity_id and va.vendor_id = p.vendor_id and upper(va.vendor_sku) = upper(p.vendor_sku)) vendor_atp,
           coalesce((select json_agg(json_build_object('location', f.location_id, 'freight', f.freight_minor))
                       from vendor_sku_freight f where f.entity_id = p.entity_id and f.vendor_id = p.vendor_id and upper(f.vendor_sku) = upper(p.vendor_sku)), '[]') sku_freight
      from product p
     where p.entity_id = $1 and p.vendor_id = $2 and p.kind = 'stock' and p.status = 'active'
     order by p.category, p.collection nulls last, p.name`, [co.id, vendorId]);
  const sugg = await pur.replenishment(c, co.id, { vendorId });
  return { vendors, locations, vendor, month, products, otb: await pur.openToBuy(c, co.id, month),
    suggestions: sugg.map((s) => ({ productId: s.product_id, locationId: s.location_id, qty: s.suggest })) };
}

// --------------------------------------------------------------- module

export const module: ErpModule = {
  id: "purchasing",
  register(kit) {
    const { coGet, coPost } = kit;
    const sc = (co: Company, a: Actor) => scopeOf(co, a);

    coGet("/purchasing/home", (c, co) => home(c, co));
    coGet("/purchasing/pos", (c, co, url) => listPOs(c, co, url));
    coGet(`/purchasing/pos/${ID}`, (c, co, _u, m) => poDetail(c, co, m[2]));
    coGet("/purchasing/order-form", (c, co, url) => refuse(() => orderForm(c, co, url)));
    coGet("/purchasing/special-orders", async (c, co) => ({ lines: await pur.specialOrderQueue(c, co.id) }));
    coGet("/purchasing/replenishment", async (c, co, url) => ({
      suggestions: await pur.replenishment(c, co.id, { vendorId: uuid(url.searchParams.get("vendor")), locationId: uuid(url.searchParams.get("location")) }),
    }));
    coGet("/purchasing/reorder-rules", async (c, co) => ({
      rules: await q(c, `select r.product_id, p.sku, p.name, r.location_id, l.name location, r.min_qty, r.max_qty, r.active
                           from reorder_rule r join product p on p.id = r.product_id join location l on l.id = r.location_id
                          where r.entity_id = $1 order by p.name, l.name`, [co.id]),
    }));
    coGet("/purchasing/budgets", async (c, co, url) => {
      const month = await monthParam(c, co, url);
      const locations = await q(c, `select id, name, kind from location where entity_id = $1 and status = 'active' and kind in ('warehouse','store','outlet') order by kind <> 'warehouse', name`, [co.id]);
      const categories = await q<{ category: string }>(c, `select distinct category from product where entity_id = $1 and category is not null and kind = 'stock' order by 1`, [co.id]);
      return { month, rows: await pur.openToBuy(c, co.id, month), locations, categories: categories.map((x) => x.category) };
    });
    coGet(`/purchasing/eta/${ID}`, async (c, co, _u, m) => ({ lines: await pur.etaForOrder(c, co.id, m[2]) }));
    coGet("/purchasing/ack-runs", async (c, co) => ({
      runs: await q(c, `select r.id, r.filename, r.rows, r.applied, r.problems, r.created_at, u.name by_name
                          from po_ack_run r left join app_user u on u.id = r.created_by where r.entity_id = $1 order by r.created_at desc limit 30`, [co.id]),
    }));

    coPost("/purchasing/order-form", async (c, co, a, b) => {
      const held = await requireRole(c, co, a, BUY, "placing purchase orders");
      const lines = (Array.isArray(b.lines) ? b.lines as Record<string, unknown>[] : []).map((l) => {
        const p = uuid(l.productId), loc = uuid(l.locationId);
        need(p && loc, "each line names a product and a ship-to");
        return { productId: p!, locationId: loc!, qty: Number(l.qty) };
      });
      return placedOut(await refuse(() => pur.placeOrderForm(c, sc(co, a), { lines, expectedOn: str(b.expectedOn, 10) || null,
        overBudgetReason: str(b.overBudgetReason, 300) || null }, held.has("owner"))));
    });
    coPost(`/purchasing/pos/${ID}/send`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, BUY, "sending a purchase order");
      return refuse(() => pur.sendPO(c, scopeOf(co, a), m[2], str(b.method, 10) as pur.SendMethod, currentFeedEnv()));
    });
    coPost(`/purchasing/pos/${ID}/cancel`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, BUY, "cancelling a purchase order");
      return refuse(() => pur.cancelPO(c, sc(co, a), m[2], str(b.reason, 300)));
    });
    coPost(`/purchasing/pos/${ID}/ack`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, STORE, "entering a vendor acknowledgment");
      const lines = (Array.isArray(b.lines) ? b.lines as Record<string, unknown>[] : []).map((l) => ({
        lineId: uuid(l.lineId) ?? undefined, status: str(l.status, 20), qty: l.qty == null || l.qty === "" ? null : Number(l.qty),
        expectedOn: str(l.expectedOn, 10) || null }));
      return refuse(() => pur.acknowledgePO(c, sc(co, a), m[2], { vendorRef: str(b.vendorRef, 60) || null, expectedOn: str(b.expectedOn, 10) || null, lines }));
    });
    coPost(`/purchasing/pos/${ID}/landed`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, BUY, "adding landed cost");
      await refuse(() => pur.addLandedCost(c, sc(co, a), m[2], { kind: str(b.kind, 20) || "freight", amountMinor: minor(b.amount),
        basis: str(b.basis, 10) || "value", note: str(b.note, 300) || null }));
      return { ok: true };
    });
    coPost("/purchasing/budgets", async (c, co, a, b) => {
      await requireRole(c, co, a, ["owner"], "setting buying budgets");
      const loc = uuid(b.locationId); need(loc, "pick a store or warehouse");
      return { id: await refuse(() => pur.setBudget(c, sc(co, a), { month: str(b.month, 10), category: str(b.category, 80), locationId: loc!, budgetMinor: minor(b.budget) })) };
    });
    coPost("/purchasing/special-orders", async (c, co, a, b) => {
      await requireRole(c, co, a, STORE, "ordering customers' special orders");
      const ids = (Array.isArray(b.lineIds) ? b.lineIds : []).map(uuid).filter(Boolean) as string[];
      return placedOut(await refuse(() => pur.placeSpecialOrders(c, sc(co, a), ids)));
    });
    coPost("/purchasing/reorder-rules", async (c, co, a, b) => {
      await requireRole(c, co, a, STORE, "setting reorder points");
      const p = uuid(b.productId), loc = uuid(b.locationId);
      need(p && loc, "pick a product and a store or warehouse");
      await refuse(() => pur.setReorderRule(c, sc(co, a), { productId: p!, locationId: loc!, min: Number(b.min), max: Number(b.max), active: b.active !== false }));
      return { ok: true };
    });
    coPost("/purchasing/export", async (c, co, a, b) => {
      await requireRole(c, co, a, BUY, "sending purchase orders");
      const v = uuid(b.vendorId); need(v, "pick a vendor");
      return refuse(() => pur.exportForVendor(c, sc(co, a), v!, { onlyNew: b.onlyNew === true, poId: uuid(b.poId) }));
    });
    coPost("/purchasing/acks/import", async (c, co, a, b) => {
      await requireRole(c, co, a, STORE, "importing vendor acknowledgments");
      need(typeof b.csv === "string" && b.csv.trim(), "choose the vendor's acknowledgment file first");
      return refuse(() => pur.importAcks(c, sc(co, a), { csv: b.csv as string, filename: str(b.filename, 200) || null }));
    });
    coPost(`/purchasing/vendors/${ID}`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, BUY, "changing a vendor's lead time");
      await refuse(() => saveVendorProfile(c, sc(co, a), m[2], {
        leadDays: b.leadDays === undefined ? undefined : int(b.leadDays, -1),
        freightMinMinor: b.freightMin === undefined ? undefined : minor(b.freightMin || "0"),
        orderEmail: b.orderEmail === undefined ? undefined : (str(b.orderEmail, 200) || null),
      }));
      return { ok: true };
    });
  },
};
