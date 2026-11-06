// pos module -- point of sale. See docs/MODULES.md for the contract.
// Routes under /api/c/<company>/pos/... The rules live in packages/core/pos.ts;
// this file decides who may do what, reads requests and shapes screen data.
import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { need, requireRole, str, uuid, int, minor, ModuleError } from "./kit.ts";
import { q, one } from "../../packages/core/db.ts";
import { scopeOf, rolesOf } from "../actions.ts";
import * as pos from "../../packages/core/pos.ts";
import { InventoryError } from "../../packages/core/inventory.ts";
import { PostingError } from "../../packages/core/posting.ts";
import { PricingError, priceConfigured, type Choice } from "../../packages/core/pricing.ts";
import { ArError } from "../../packages/core/ar.ts";
import { ShopError } from "../../packages/core/shop.ts";

const ID = "([0-9a-fA-F-]{36})";

export function refusal(e: unknown): unknown {
  if (e instanceof pos.PosError || e instanceof InventoryError || e instanceof PostingError || e instanceof PricingError || e instanceof ArError || e instanceof ShopError)
    return new ModuleError(e.message);
  return e;
}
const safe = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
  try { return await fn(...a); } catch (e) { throw refusal(e); }
};

const SELL = ["sales", "cashier", "store_manager"];
const TILL = ["cashier", "store_manager"];
const MANAGER = ["store_manager"];
const day = (v: unknown) => { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const sc = (co: Company, a: Actor) => scopeOf(co, a);

function choices(v: unknown): Choice[] {
  if (Array.isArray(v)) return v.map((x: Record<string, unknown>) => ({ group: str(x.group, 40), option: Array.isArray(x.option) ? x.option.map((o) => str(o, 60)) : str(x.option, 60) }));
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([g, o]) => ({ group: str(g, 40), option: Array.isArray(o) ? o.map((x) => str(x, 60)) : str(o, 60) }));
  return [];
}
function lines(v: unknown): pos.LineIn[] {
  return (Array.isArray(v) ? v : []).slice(0, 60).map((l: Record<string, unknown>) => ({
    productId: uuid(l.productId) ?? "", qty: Number(l.qty ?? 1), choices: choices(l.choices),
    fulfillment: (str(l.fulfillment, 10) || undefined) as pos.Fulfil | undefined,
    discountMinor: l.discount != null && l.discount !== "" ? minor(l.discount) : undefined,
    discountBps: l.discountPct != null && l.discountPct !== "" ? Math.round(Number(l.discountPct) * 100) : undefined,
    fulfilFromId: uuid(l.fulfilFromId), promisedOn: day(l.promisedOn), shipAddressId: uuid(l.shipAddressId) }));
}
function tenders(v: unknown): pos.Tender[] {
  return (Array.isArray(v) ? v : []).slice(0, 8).map((t: Record<string, unknown>) => ({ method: str(t.method, 20), amountMinor: minor(t.amount ?? 0),
    reference: str(t.reference, 40) || null }));
}

async function setup(c: Client, co: Company, personId: string | null) {
  const [registers, stores, people, set] = await Promise.all([
    q(c, `select r.id, r.code, r.name, r.location_id, l.name location, s.id session_id, s.number session_number, s.opened_at, u.name opened_by
        from pos_register r join location l on l.id = r.location_id
        left join pos_session s on s.register_id = r.id and s.entity_id = r.entity_id and s.status = 'open' left join app_user u on u.id = s.opened_by
       where r.entity_id = $1 and r.active order by l.name, r.code`, [co.id]),
    q(c, `select id, code, name, kind, tax_rate_bps from location where entity_id = $1 and status = 'active' and kind in ('store','outlet','warehouse') order by kind desc, name`, [co.id]),
    q(c, `select distinct u.id, u.name from app_user u join role_grant g on g.app_user_id = u.id
       where u.status = 'active' and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = $2)) and g.role in ('sales','store_manager','cashier','owner')
       order by u.name`, [co.id, co.tenantId]),
    pos.settings(c, co.id),
  ]);
  const roles = personId ? [...await rolesOf(c, co, personId)] : [];
  return { registers, stores, people, settings: set, roles, tenders: pos.TENDERS, returnReasons: pos.RETURN_REASONS, denominations: pos.DENOMS };
}

async function customers(c: Client, co: Company, url: URL) {
  const term = str(url.searchParams.get("q"), 80);
  if (term.length < 2) return [];
  return q(c, `select cu.id, cu.number, cu.name, cu.phone, cu.email, cu.kind, cu.tax_exempt_ref, cu.status,
      (select json_agg(json_build_object('id', a.id, 'label', a.label, 'line1', a.line1, 'city', a.city, 'state', a.state, 'postal', a.postal, 'isDefault', a.is_default)
               order by a.is_default desc) from customer_address a where a.customer_id = cu.id and a.entity_id = cu.entity_id) addresses
    from customer cu where cu.entity_id = $1 and cu.status <> 'inactive'
      and (cu.name ilike '%' || $2 || '%' or cu.phone ilike '%' || $2 || '%' or cu.email ilike '%' || $2 || '%' or cu.number ilike '%' || $2 || '%')
    order by cu.name limit 20`, [co.id, term]);
}

async function addCustomer(c: Client, co: Company, b: Record<string, unknown>) {
  const name = str(b.name, 120), phone = str(b.phone, 30) || null, email = str(b.email, 120).toLowerCase() || null;
  need(name, "a customer needs a name");
  need(phone || email, "a phone number or an email, so the store can reach them");
  if (email) {
    need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), "that email does not look right");
    const dup = await q<{ name: string }>(c, `select name from customer where entity_id = $1 and lower(email) = $2`, [co.id, email]);
    need(!dup.length, `${dup[0]?.name} already has that email; look them up instead`);
  }
  await c.query(`insert into doc_sequence (entity_id, kind, prefix, next_no)
      values ($1, 'customer', 'C-', (select coalesce(max(nullif(substring(number from '[0-9]+$'), '')::bigint), 0) + 1 from customer where entity_id = $1))
      on conflict (entity_id, kind) do nothing`, [co.id]);
  let number = "";
  for (let i = 0; i < 20 && !number; i++) {
    const n = (await one<{ n: string }>(c, `select next_doc_no($1, 'customer', 'C-') n /* unscoped: numbering keyed by entity */`, [co.id])).n;
    const taken = await q(c, `select id from customer where entity_id = $1 and number = $2`, [co.id, n]);
    if (!taken.length) number = n;
  }
  const exempt = str(b.taxExemptRef, 60) || null;
  const kind = b.kind === "business" ? "business" : "person";
  const cu = await one<{ id: string }>(c, `insert into customer (entity_id, number, kind, name, email, phone, tax_exempt_ref, home_location_id, marketing_ok)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [co.id, number, kind, name, email, phone, exempt, uuid(b.homeLocationId), b.marketingOk === true]);
  const a = b.address as Record<string, unknown> | undefined;
  if (a && str(a.line1)) await addAddress(c, co, cu.id, a, true);
  return { id: cu.id, number };
}

async function addAddress(c: Client, co: Company, customerId: string, a: Record<string, unknown>, isDefault: boolean) {
  const line1 = str(a.line1, 120), city = str(a.city, 60), state = str(a.state, 2).toUpperCase(), postal = str(a.postal, 10);
  need(line1 && city && postal, "an address needs a street, a city and a postal code");
  need(/^[A-Z]{2}$/.test(state), "the state is two letters");
  const cu = await q(c, `select id from customer where id = $1 and entity_id = $2`, [customerId, co.id]);
  need(cu.length, "no such customer");
  if (isDefault) await c.query(`update customer_address set is_default = false where entity_id = $1 and customer_id = $2`, [co.id, customerId]);
  return one<{ id: string }>(c, `insert into customer_address (entity_id, customer_id, label, line1, line2, city, state, postal, stairs, notes, is_default)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`, [co.id, customerId, str(a.label, 40) || "Home", line1, str(a.line2, 120) || null, city, state, postal,
    Math.max(0, int(a.stairs)), str(a.notes, 300) || null, isDefault]);
}

async function products(c: Client, co: Company, url: URL) {
  const term = str(url.searchParams.get("q"), 80);
  const loc = uuid(url.searchParams.get("locationId"));
  return q(c, `
    select p.id, p.sku, p.name, p.kind, p.category, p.collection, p.color, p.price_minor::text, p.taxable, p.ship_class, p.status,
           coalesce((select sum(s.on_hand - s.reserved - s.held) from stock_level s where s.entity_id = p.entity_id and s.product_id = p.id and s.location_id = $3), 0)::text here,
           coalesce((select sum(s.on_hand - s.reserved - s.held) from stock_level s where s.entity_id = p.entity_id and s.product_id = p.id), 0)::text everywhere,
           exists (select 1 from product_option_group g where g.entity_id = p.entity_id and g.product_id = p.id) configurable
      from product p
     where p.entity_id = $1 and p.status not in ('draft','discontinued')
       and ($2 = '' or p.name ilike '%' || $2 || '%' or p.sku ilike '%' || $2 || '%' or p.collection ilike '%' || $2 || '%' or p.category ilike '%' || $2 || '%')
     order by case when p.kind in ('fee','warranty','service') then 1 else 0 end, p.category, p.name limit 40`, [co.id, term, loc]);
}

async function product(c: Client, co: Company, id: string) {
  const p = await q(c, `select id, sku, name, kind, price_minor::text, taxable, description from product where id = $1 and entity_id = $2`, [id, co.id]);
  if (!p.length) return null;
  const groups = await q(c, `select g.code, g.label, g.required, g.multi,
      (select json_agg(json_build_object('code', o.code, 'label', o.label, 'delta', o.price_delta_minor::text, 'leadDays', o.lead_days, 'swatch', o.swatch) order by o.seq)
         from product_option o where o.group_id = g.id and o.entity_id = g.entity_id and o.active) options
    from product_option_group g where g.entity_id = $1 and g.product_id = $2 order by g.seq`, [co.id, id]);
  return { ...p[0], groups };
}

async function sessions(c: Client, co: Company) {
  return q(c, `select s.id, s.number, s.status, r.name register, l.name location, s.opened_at, s.closed_at, s.float_minor::text, s.over_short_minor::text,
      ou.name opened_by, cu.name closed_by
    from pos_session s join pos_register r on r.id = s.register_id join location l on l.id = s.location_id
    left join app_user ou on ou.id = s.opened_by left join app_user cu on cu.id = s.closed_by
   where s.entity_id = $1 order by s.opened_at desc limit 30`, [co.id]);
}

export const module: ErpModule = {
  id: "pos",
  register({ coGet, coPost }) {
    coGet("/pos/setup", safe((c, co, _u, _m, p) => setup(c, co, p)));
    coGet("/pos/customers", safe((c, co, url) => customers(c, co, url)));
    coGet("/pos/products", safe((c, co, url) => products(c, co, url)));
    coGet(`/pos/products/${ID}`, safe((c, co, _u, m) => product(c, co, m[2])));
    coGet("/pos/orders", safe((c, co, url) => pos.listOrders(c, co.id, { kind: str(url.searchParams.get("kind"), 10), status: str(url.searchParams.get("status"), 12),
      q: str(url.searchParams.get("q"), 60), locationId: uuid(url.searchParams.get("locationId")) })));
    coGet(`/pos/orders/${ID}`, safe((c, co, _u, m) => pos.orderView(c, co.id, m[2])));
    coGet("/pos/sessions", safe((c, co) => sessions(c, co)));
    coGet(`/pos/sessions/${ID}/z`, safe((c, co, _u, m) => pos.zReport(c, co.id, m[2])));
    coGet(`/pos/customers/${ID}/credit`, safe(async (c, co, _u, m) => ({ storeCreditMinor: await pos.storeCredit(c, co.id, m[2]) })));

    coPost("/pos/price", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, SELL, "pricing an item");
      const p = await priceConfigured(c, co.id, uuid(b.productId) ?? "", choices(b.choices));
      return { unitPriceMinor: p.unitPriceMinor, description: p.description, leadDays: p.leadDays };
    }));

    // ---- registers and the drawer
    coPost("/pos/registers", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, MANAGER, "adding a register");
      const loc = await q(c, `select id from location where id = $1 and entity_id = $2 and kind in ('store','outlet')`, [uuid(b.locationId), co.id]);
      need(loc.length, "pick the store the register is in");
      need(str(b.code, 8) && str(b.name, 60), "a register needs a code and a name");
      return one(c, `insert into pos_register (entity_id, location_id, code, name) values ($1,$2,$3,$4) returning id`,
        [co.id, uuid(b.locationId), str(b.code, 8).toUpperCase(), str(b.name, 60)]);
    }));
    coPost("/pos/sessions", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, TILL, "opening a register");
      return pos.openSession(c, sc(co, a), { registerId: uuid(b.registerId) ?? "", floatMinor: minor(b.float ?? 0) });
    }));
    coPost(`/pos/sessions/${ID}/cash`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, TILL, "moving cash in or out of the drawer");
      return pos.cashMovement(c, sc(co, a), m[2], { kind: str(b.kind, 10), amountMinor: minor(b.amount ?? 0), note: str(b.note) || undefined });
    }));
    coPost(`/pos/sessions/${ID}/close`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, TILL, "closing a register");
      const counts: Record<string, number> = {};
      for (const [k, v] of Object.entries((b.counts as Record<string, unknown>) ?? {})) counts[k] = Number(v);
      return pos.closeSession(c, sc(co, a), m[2], { counts, note: str(b.note) || undefined });
    }));

    // ---- customers
    coPost("/pos/customers", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, SELL, "adding a customer");
      return addCustomer(c, co, b);
    }));
    coPost(`/pos/customers/${ID}/addresses`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, SELL, "adding an address");
      return addAddress(c, co, m[2], b, b.isDefault === true);
    }));

    // ---- orders
    coPost("/pos/orders", safe(async (c, co, a, b) => {
      const roles = await requireRole(c, co, a, SELL, "ringing a sale");
      const kind = (str(b.kind, 10) || "sale") as pos.OrderIn["kind"];
      return pos.createOrder(c, sc(co, a), roles, { kind, locationId: uuid(b.locationId) ?? "", customerId: uuid(b.customerId), sessionId: uuid(b.sessionId),
        lines: lines(b.lines), salespeople: (Array.isArray(b.salespeople) ? b.salespeople : []).map((x: Record<string, unknown>) =>
          ({ id: uuid(x.id) ?? "", splitBps: Math.round(Number(x.splitPct ?? (Number(x.splitBps ?? 0) / 100)) * 100) })),
        taxExemptRef: str(b.taxExemptRef, 60) || null, notes: str(b.notes) || undefined, shipAddressId: uuid(b.shipAddressId),
        promisedOn: day(b.promisedOn), overrideReason: str(b.overrideReason) || undefined });
    }));
    coPost(`/pos/orders/${ID}/lines`, safe(async (c, co, a, b, m) => {
      const roles = await requireRole(c, co, a, SELL, "changing a sale");
      return pos.addLines(c, sc(co, a), roles, m[2], lines(b.lines), str(b.overrideReason) || undefined);
    }));
    coPost(`/pos/orders/${ID}/lines/${ID}/void`, safe(async (c, co, a, b, m) => {
      const roles = await requireRole(c, co, a, SELL, "taking a line off a sale");
      return pos.voidLine(c, sc(co, a), m[2], m[3], str(b.reason), roles);
    }));
    coPost(`/pos/orders/${ID}/override`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, MANAGER, "a price override");
      return pos.approveOverride(c, sc(co, a), m[2], uuid(b.lineId) ?? "", str(b.reason));
    }));
    coPost(`/pos/orders/${ID}/convert`, safe(async (c, co, a, _b, m) => {
      await requireRole(c, co, a, SELL, "converting a quote");
      return pos.convertQuote(c, sc(co, a), m[2]);
    }));
    coPost(`/pos/orders/${ID}/checkout`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, SELL, "checking out a sale");
      return pos.checkout(c, sc(co, a), m[2], { sessionId: uuid(b.sessionId), tenders: tenders(b.tenders),
        signatureDataUrl: typeof b.signature === "string" ? b.signature : undefined, signedName: str(b.signedName, 120) });
    }));
    coPost(`/pos/orders/${ID}/pay`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, TILL.concat("sales"), "taking a payment");
      return pos.pay(c, sc(co, a), m[2], { sessionId: uuid(b.sessionId), tenders: tenders(b.tenders) });
    }));
    coPost(`/pos/orders/${ID}/fulfil`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, [...TILL, "sales", "warehouse"], "handing goods over");
      return pos.fulfilAtCounter(c, sc(co, a), m[2], (Array.isArray(b.lineIds) ? b.lineIds : []).map(uuid).filter(Boolean) as string[], { sessionId: uuid(b.sessionId) });
    }));
    coPost(`/pos/orders/${ID}/cancel`, safe(async (c, co, a, b, m) => {
      const st = await q<{ status: string }>(c, `select status from sales_order where id = $1 and entity_id = $2`, [m[2], co.id]);
      need(st.length, "no such order");
      await requireRole(c, co, a, st[0].status === "draft" ? SELL : MANAGER, st[0].status === "draft" ? "cancelling a draft" : "cancelling a placed order");
      return pos.cancelOrder(c, sc(co, a), m[2], { reason: str(b.reason), sessionId: uuid(b.sessionId), refundMethod: str(b.refundMethod, 20) || undefined,
        reference: str(b.reference, 40) || undefined });
    }));
    coPost(`/pos/orders/${ID}/signature`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, SELL, "taking a signature");
      return pos.saveSignature(c, sc(co, a), m[2], typeof b.signature === "string" ? b.signature : "", str(b.signedName, 120));
    }));
    coPost(`/pos/orders/${ID}/return`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, TILL, "taking a return");
      return pos.returnGoods(c, sc(co, a), m[2], {
        lines: (Array.isArray(b.lines) ? b.lines : []).map((l: Record<string, unknown>) => ({ lineId: uuid(l.lineId) ?? "", qty: Number(l.qty ?? 0),
          reason: str(l.reason, 30), disposition: (str(l.disposition, 10) || "restock") as "restock" | "damage", note: str(l.note) || undefined })),
        tenders: tenders(b.tenders), sessionId: uuid(b.sessionId), note: str(b.note) || undefined });
    }));
  },
};
