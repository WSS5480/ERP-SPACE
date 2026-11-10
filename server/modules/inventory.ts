// inventory module -- warehousing and tracking. See docs/MODULES.md for the contract.
// Routes under /api/c/<company>/inventory/... The rules live in
// packages/core/inventory.ts; this file checks who may do what, reads the
// request, and shapes the screens' data.
import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { need, requireRole, str, uuid, int, minor, ModuleError } from "./kit.ts";
import { q } from "../../packages/core/db.ts";
import { scopeOf } from "../actions.ts";
import * as inv from "../../packages/core/inventory.ts";
import * as wms from "../../packages/core/wms.ts";
import { PostingError } from "../../packages/core/posting.ts";

const ID = "([0-9a-fA-F-]{36})";
const LABEL = "([A-Za-z0-9-]{1,40})";

/** The engine's refusals are sentences; send them back as such. */
export function refusal(e: unknown): unknown {
  if (e instanceof inv.InventoryError || e instanceof PostingError || e instanceof wms.WmsError) return new ModuleError(e.message);
  return e;
}
const safe = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
  try { return await fn(...a); } catch (e) { throw refusal(e); }
};

const WAREHOUSE = ["warehouse", "store_manager"];
const MANAGER = ["store_manager"];
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const labels = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : [])
  .map((x) => String(x).trim().toUpperCase()).filter(Boolean).slice(0, 500);
const urls = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/\s+/) : []).map((x) => String(x).trim()).filter(Boolean);
const day = (v: unknown) => { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; };

async function locations(c: Client, co: Company) {
  return q<{ id: string; code: string; name: string; kind: string }>(c,
    `select id, code, name, kind from location where entity_id = $1 and status = 'active' and kind not in ('web','in_transit','dropship')
      order by case kind when 'warehouse' then 0 else 1 end, name`, [co.id]);
}

async function overview(c: Client, co: Company) {
  // One client: ask in turn.
  const locs = await locations(c, co);
  const val = await inv.valuation(c, co.id);
  const dmg = await q<{ n: string }>(c, `select count(*) n from inv_damage where entity_id = $1 and status <> 'resolved'`, [co.id]);
  const counts = await q<{ n: string }>(c, `select count(*) n from inv_count where entity_id = $1 and status = 'submitted'`, [co.id]);
  const transfers = await q<{ n: string }>(c, `select count(*) n from inv_transfer where entity_id = $1 and status = 'in_transit'`, [co.id]);
  const appts = await q<{ n: string }>(c, `select count(*) n from inv_receiving_appt where entity_id = $1 and status = 'booked' and day between current_date and current_date + 7`, [co.id]);
  const pieces = await q<{ status: string; n: string }>(c, `select status, count(*) n from inv_piece where entity_id = $1 group by status`, [co.id]);
  return { locations: locs, valueMinor: val.totalMinor, inTransitMinor: val.inTransitMinor, openDamage: Number(dmg[0].n),
    countsToApprove: Number(counts[0].n), transfersInTransit: Number(transfers[0].n), receivingThisWeek: Number(appts[0].n),
    pieces: Object.fromEntries(pieces.map((p) => [p.status, Number(p.n)])), tie: await inv.tieOut(c, co.id) };
}

async function layout(c: Client, co: Company) {
  const [locs, zones, bins, docks] = await Promise.all([
    locations(c, co),
    q(c, `select id, location_id, code, name, kind from inv_zone where entity_id = $1 and active order by code`, [co.id]),
    q(c, `select b.id, b.location_id, b.zone_id, b.code, b.aisle, b.rack, b.level,
             (select count(*) from inv_piece p where p.bin_id = b.id and p.entity_id = b.entity_id) pieces,
             (select coalesce(sum(s.qty),0) from inv_bin_stock s where s.bin_id = b.id and s.entity_id = b.entity_id)::text qty
        from inv_bin b where b.entity_id = $1 and b.active order by b.code`, [co.id]),
    q(c, `select location_id, daily_piece_limit, receiving_bin_id from inv_dock where entity_id = $1`, [co.id]),
  ]);
  return { locations: locs, zones, bins, docks };
}

async function stock(c: Client, co: Company, url: URL) {
  const loc = uuid(url.searchParams.get("locationId"));
  const term = str(url.searchParams.get("q"), 80);
  return q(c, `
    select p.id, p.sku, p.name, p.category, p.serialized, p.cost_minor, p.price_minor,
           coalesce(sum(s.on_hand),0)::text on_hand, coalesce(sum(s.reserved),0)::text reserved, coalesce(sum(s.held),0)::text held,
           coalesce(sum(s.on_hand - s.reserved - s.held),0)::text available, coalesce(sum(s.on_order),0)::text on_order,
           (select count(distinct unit_id) from inv_piece x where x.entity_id = p.entity_id and x.product_id = p.id and x.status = 'as_is'
               and ($2::uuid is null or x.location_id = $2))::int as_is
      from product p left join stock_level s on s.product_id = p.id and s.entity_id = p.entity_id and ($2::uuid is null or s.location_id = $2)
     where p.entity_id = $1 and p.kind in ('stock','configurable','special_order') and p.status <> 'discontinued'
       and ($3 = '' or p.name ilike '%' || $3 || '%' or p.sku ilike '%' || $3 || '%')
     group by p.id order by p.category, p.name limit 200`, [co.id, loc, term]);
}

async function receiving(c: Client, co: Company) {
  const pos = await inv.openPurchaseOrders(c, co.id);
  const appts = await q(c, `
    select a.id, a.location_id, l.name location, a.day::text, a.window_label, v.legal_name vendor, po.number po_number, a.purchase_order_id,
           a.carrier, a.expected_pieces, a.status, a.note
      from inv_receiving_appt a join location l on l.id = a.location_id
      left join vendor v on v.id = a.vendor_id left join purchase_order po on po.id = a.purchase_order_id
     where a.entity_id = $1 and a.day >= current_date - 1 and a.status <> 'cancelled' order by a.day, a.window_label`, [co.id]);
  const docks = await q(c, `select d.location_id, l.name location, d.daily_piece_limit from inv_dock d join location l on l.id = d.location_id
     where d.entity_id = $1`, [co.id]);
  const recent = await q(c, `select gr.id, po.number, gr.received_on::text, u.name received_by, count(gl.id)::int lines, coalesce(sum(gl.quantity),0)::text qty
      from goods_receipt gr join purchase_order po on po.id = gr.purchase_order_id left join app_user u on u.id = gr.received_by
      left join goods_receipt_line gl on gl.goods_receipt_id = gr.id
     where po.entity_id = $1 group by gr.id, po.number, u.name order by gr.received_on desc, po.number limit 15`, [co.id]);
  return { purchaseOrders: pos, appointments: appts, docks, recent };
}

async function transfers(c: Client, co: Company) {
  return q(c, `
    select t.id, t.number, t.status, t.note, fl.name from_name, tl.name to_name, t.from_location_id, t.to_location_id,
           t.created_at, t.shipped_at, t.received_at,
           (select json_agg(json_build_object('sku', p.sku, 'name', p.name, 'qty', x.qty, 'units', cardinality(x.unit_ids)) order by p.sku)
              from inv_transfer_line x join product p on p.id = x.product_id where x.transfer_id = t.id and x.entity_id = t.entity_id) lines,
           (select coalesce(sum(round(x.qty * x.cost_minor)),0)::bigint from inv_transfer_line x where x.transfer_id = t.id and x.entity_id = t.entity_id)::text value_minor
      from inv_transfer t join location fl on fl.id = t.from_location_id join location tl on tl.id = t.to_location_id
     where t.entity_id = $1 and (t.status in ('draft','in_transit') or t.created_at > now() - interval '30 days')
     order by case t.status when 'in_transit' then 0 when 'draft' then 1 else 2 end, t.created_at desc limit 60`, [co.id]);
}

async function damage(c: Client, co: Company) {
  return q(c, `
    select d.id, d.number, d.status, d.resolution, d.source, d.description, d.photo_urls, d.qty, d.cost_minor, d.opened_at, d.resolved_at,
           p.sku, p.name, p.serialized, l.name location, u.name opened_by,
           (select string_agg(x.label, ' ' order by x.carton_seq) from inv_piece x where x.unit_id = d.unit_id and x.entity_id = d.entity_id) labels,
           (select json_agg(json_build_object('id', vc.id, 'number', vc.number, 'status', vc.status, 'vendorRef', vc.vendor_ref,
                 'claimed', vc.amount_claimed_minor::text, 'credit', vc.credit_minor::text, 'resolution', vc.resolution) order by vc.opened_at)
              from inv_vendor_claim vc where vc.damage_id = d.id and vc.entity_id = d.entity_id) claims
      from inv_damage d join product p on p.id = d.product_id join location l on l.id = d.location_id
      left join app_user u on u.id = d.opened_by
     where d.entity_id = $1 and (d.status <> 'resolved' or d.resolved_at > now() - interval '30 days')
     order by case d.status when 'resolved' then 1 else 0 end, d.opened_at desc limit 80`, [co.id]);
}

async function counts(c: Client, co: Company) {
  return q(c, `
    select ct.id, ct.number, ct.status, l.name location, b.code bin, ct.created_at, ct.variance_minor::text,
           mk.name created_by, sb.name submitted_by, dc.name decided_by, ct.decision_note, ct.created_by created_by_id, ct.submitted_by submitted_by_id,
           (select count(*) from inv_count_line x where x.count_id = ct.id and x.entity_id = ct.entity_id)::int lines
      from inv_count ct join location l on l.id = ct.location_id left join inv_bin b on b.id = ct.bin_id
      left join app_user mk on mk.id = ct.created_by left join app_user sb on sb.id = ct.submitted_by left join app_user dc on dc.id = ct.decided_by
     where ct.entity_id = $1 order by case ct.status when 'submitted' then 0 when 'open' then 1 else 2 end, ct.created_at desc limit 50`, [co.id]);
}

async function countDetail(c: Client, co: Company, id: string) {
  const h = (await counts(c, co)).find((x) => (x as { id: string }).id === id);
  if (!h) return null;
  const lines = await q(c, `select x.product_id, p.sku, p.name, x.serialized, x.expected_qty::text, x.counted_qty::text, x.expected_labels, x.scanned_labels,
      x.unit_cost_minor::text, case when x.counted_qty is null then null else round((x.counted_qty - x.expected_qty) * x.unit_cost_minor)::bigint::text end variance_minor
    from inv_count_line x join product p on p.id = x.product_id where x.entity_id = $1 and x.count_id = $2 order by p.name`, [co.id, id]);
  return { ...h, lines };
}

async function adjustments(c: Client, co: Company) {
  return q(c, `select a.id, a.number, a.qty::text, a.reason_code, a.note, a.labels, a.value_minor::text, a.at, p.sku, p.name, l.name location, u.name by_name
      from inv_adjustment a join product p on p.id = a.product_id join location l on l.id = a.location_id join app_user u on u.id = a.by_user
     where a.entity_id = $1 order by a.at desc limit 50`, [co.id]);
}

async function ordersToPick(c: Client, co: Company) {
  return q(c, `
    select so.id, so.number, so.fulfillment, so.promised_on::text, cu.name customer, count(l.id)::int lines,
           string_agg(distinct lo.name, ', ') from_locations
      from sales_order so join sales_order_line l on l.sales_order_id = so.id and l.entity_id = so.entity_id
      join product p on p.id = l.product_id left join customer cu on cu.id = so.customer_id left join location lo on lo.id = l.fulfil_from_id
     where so.entity_id = $1 and so.status in ('open','fulfilling') and l.line_status in ('reserved','ready') and l.qty > 0
       and p.kind in ('stock','configurable','special_order')
     group by so.id, cu.name order by so.promised_on nulls last, so.number limit 100`, [co.id]);
}

/** Customer goods reserved somewhere other than the store they are picked up from: special orders received at the DC, mostly. */
async function ordersToMove(c: Client, co: Company) {
  return q(c, `
    select l.id line_id, so.number, cu.name customer, l.description, l.qty::text, fl.name from_name, l.fulfil_from_id from_id, so.location_id to_id, tl.name to_name
      from sales_order_line l join sales_order so on so.id = l.sales_order_id join location fl on fl.id = l.fulfil_from_id join location tl on tl.id = so.location_id
      left join customer cu on cu.id = so.customer_id left join pos_line pl on pl.sales_order_line_id = l.id and pl.entity_id = l.entity_id
     where l.entity_id = $1 and l.line_status = 'reserved' and l.fulfil_from_id <> so.location_id
       and coalesce(pl.fulfillment, so.fulfillment) in ('pickup','carry') and so.status in ('open','fulfilling')
       and not exists (select 1 from inv_transfer_line x join inv_transfer t on t.id = x.transfer_id where x.entity_id = l.entity_id and x.sales_order_line_id = l.id and t.status = 'draft')
     order by so.ordered_at limit 50`, [co.id]);
}

async function moves(c: Client, co: Company, url: URL) {
  const pid = uuid(url.searchParams.get("productId"));
  return q(c, `select m.at, m.kind, m.qty::text, m.from_status, m.to_status, p.sku, p.name, pc.label, fl.name from_loc, tl.name to_loc,
      fb.code from_bin, tb.code to_bin, m.reason, u.name by_name
      from inv_move m join product p on p.id = m.product_id left join inv_piece pc on pc.id = m.piece_id
      left join location fl on fl.id = m.from_location_id left join location tl on tl.id = m.to_location_id
      left join inv_bin fb on fb.id = m.from_bin_id left join inv_bin tb on tb.id = m.to_bin_id left join app_user u on u.id = m.by_user
     where m.entity_id = $1 and ($2::uuid is null or m.product_id = $2) order by m.id desc limit 100`, [co.id, pid]);
}

const sc = (co: Company, a: Actor) => scopeOf(co, a);

export const module: ErpModule = {
  id: "inventory",
  register({ coGet, coPost }) {
    coGet("/inventory/overview", safe((c, co) => overview(c, co)));
    coGet("/inventory/layout", safe((c, co) => layout(c, co)));
    coGet("/inventory/stock", safe((c, co, url) => stock(c, co, url)));
    coGet(`/inventory/atp/${ID}`, safe((c, co, _u, m) => inv.availableToPromise(c, co.id, m[2])));
    coGet("/inventory/valuation", safe((c, co) => inv.valuation(c, co.id)));
    coGet("/inventory/tie-out", safe((c, co) => inv.tieOut(c, co.id)));
    coGet(`/inventory/scan/${LABEL}`, safe((c, co, _u, m) => inv.scan(c, co.id, m[2])));
    coGet("/inventory/receiving", safe((c, co) => receiving(c, co)));
    coGet("/inventory/transfers", safe((c, co) => transfers(c, co)));
    coGet("/inventory/orders-to-move", safe((c, co) => ordersToMove(c, co)));
    coGet("/inventory/damage", safe((c, co) => damage(c, co)));
    coGet("/inventory/counts", safe((c, co) => counts(c, co)));
    coGet(`/inventory/counts/${ID}`, safe((c, co, _u, m) => countDetail(c, co, m[2])));
    coGet("/inventory/adjustments", safe(async (c, co) => ({ reasons: inv.REASONS, rows: await adjustments(c, co) })));
    coGet("/inventory/orders-to-pick", safe((c, co) => ordersToPick(c, co)));
    coGet("/inventory/moves", safe((c, co, url) => moves(c, co, url)));

    // ---- layout
    coPost("/inventory/zones", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, MANAGER, "adding a zone");
      return inv.addZone(c, co.id, { locationId: uuid(b.locationId) ?? "", code: str(b.code, 12), name: str(b.name, 80), kind: str(b.kind, 20) || undefined });
    }));
    coPost("/inventory/bins", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, WAREHOUSE, "adding a bin");
      return inv.addBin(c, co.id, { zoneId: uuid(b.zoneId) ?? "", aisle: str(b.aisle, 8) || undefined, rack: str(b.rack, 8) || undefined,
        level: str(b.level, 8) || undefined, code: str(b.code, 20) || undefined });
    }));
    coPost("/inventory/docks", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, MANAGER, "setting a dock's limit");
      await inv.setDock(c, co.id, { locationId: uuid(b.locationId) ?? "", dailyPieceLimit: int(b.dailyPieceLimit), receivingBinId: uuid(b.receivingBinId) });
      return { ok: true };
    }));
    coPost("/inventory/move-qty", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, WAREHOUSE, "moving stock between bins");
      await inv.moveQty(c, sc(co, a), { productId: uuid(b.productId) ?? "", fromBinId: uuid(b.fromBinId), toBinId: uuid(b.toBinId) ?? "", qty: num(b.qty) });
      return { ok: true };
    }));

    // ---- scanning
    coPost(`/inventory/pieces/${LABEL}/([a-z_]+)`, safe(async (c, co, a, b, m) => {
      const action = m[3];
      const roles = ["allocate", "unallocate"].includes(action) ? [...WAREHOUSE, "sales"]
        : ["write_off", "vendor_return"].includes(action) ? MANAGER : [...WAREHOUSE, "driver"];
      await requireRole(c, co, a, roles, `${action.replace(/_/g, " ")} on a piece`);
      return inv.pieceAction(c, sc(co, a), m[2], action, { binId: uuid(b.binId), lineId: uuid(b.lineId) ?? undefined, reason: str(b.reason) || undefined,
        description: str(b.description) || undefined, photoUrls: urls(b.photoUrls), source: str(b.source, 30) || undefined,
        asIsPriceMinor: b.asIsPrice != null && b.asIsPrice !== "" ? minor(b.asIsPrice) : null });
    }));

    // ---- receiving
    coPost("/inventory/receiving", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, WAREHOUSE, "receiving goods");
      const lines = (Array.isArray(b.lines) ? b.lines : []).map((l: Record<string, unknown>) => ({ poLineId: uuid(l.poLineId) ?? "", qty: num(l.qty),
        damagedQty: num(l.damagedQty ?? 0) || 0, damageNote: str(l.damageNote) || undefined })).filter((l) => l.qty > 0);
      return inv.receivePurchaseOrder(c, sc(co, a), { purchaseOrderId: uuid(b.purchaseOrderId) ?? "", locationId: uuid(b.locationId) ?? "",
        binId: uuid(b.binId), lines, note: str(b.note) || undefined, appointmentId: uuid(b.appointmentId) });
    }));
    coPost("/inventory/appointments", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, [...WAREHOUSE, "buyer"], "booking a receiving appointment");
      return inv.bookReceiving(c, sc(co, a), { locationId: uuid(b.locationId) ?? "", day: day(b.day), window: str(b.window, 40) || undefined,
        vendorId: uuid(b.vendorId), purchaseOrderId: uuid(b.purchaseOrderId), carrier: str(b.carrier, 80) || undefined,
        expectedPieces: int(b.expectedPieces), note: str(b.note) || undefined });
    }));
    coPost(`/inventory/appointments/${ID}/status`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, [...WAREHOUSE, "buyer"], "updating an appointment");
      const s = str(b.status, 20);
      need(["arrived", "received", "no_show", "cancelled"].includes(s), "an appointment is marked arrived, received, no show or cancelled");
      const r = await q(c, `update inv_receiving_appt set status = $3 where id = $1 and entity_id = $2 and status in ('booked','arrived') returning id`, [m[2], co.id, s]);
      need(r.length, "that appointment is not open");
      return { ok: true };
    }));

    // ---- transfers
    // To another of the client's companies the engine asks for the owner or a controller in both
    // (it makes a sale and a bill); within the company it is warehouse work, as before.
    const acrossTo = async (c: Client, co: Company, locationId: string | null) => !!locationId && !!(await q(c,
      `select 1 from location l join entity e on e.id = l.entity_id where l.id = $1 and e.tenant_id = $2 and l.entity_id <> $3 /* unscoped: a sister company's location */`,
      [locationId, co.tenantId, co.id])).length;
    coPost("/inventory/transfers", safe(async (c, co, a, b) => {
      if (!(await acrossTo(c, co, uuid(b.toId)))) await requireRole(c, co, a, WAREHOUSE, "starting a transfer");
      const lines = (Array.isArray(b.lines) ? b.lines : []).map((l: Record<string, unknown>) => ({ productId: uuid(l.productId) ?? "", qty: num(l.qty), labels: labels(l.labels),
        salesOrderLineId: uuid(l.salesOrderLineId) }));
      return inv.createTransfer(c, sc(co, a), { fromId: uuid(b.fromId) ?? "", toId: uuid(b.toId) ?? "", lines, note: str(b.note) || undefined });
    }));
    coPost(`/inventory/transfers/${ID}/ship`, safe(async (c, co, a, b, m) => {
      const t = await q<{ to_entity_id: string | null }>(c, `select to_entity_id from inv_transfer where id = $1 and entity_id = $2`, [m[2], co.id]);
      if (!t[0]?.to_entity_id) await requireRole(c, co, a, WAREHOUSE, "shipping a transfer");
      return inv.shipTransfer(c, sc(co, a), m[2], { expectedOn: day(b.expectedOn) || null });
    }));
    coPost(`/inventory/transfers/${ID}/receive`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, WAREHOUSE, "receiving a transfer");
      return inv.receiveTransfer(c, sc(co, a), m[2], { binId: uuid(b.binId) });
    }));
    coPost(`/inventory/transfers/${ID}/cancel`, safe(async (c, co, a, _b, m) => {
      await requireRole(c, co, a, WAREHOUSE, "cancelling a transfer");
      await inv.cancelTransfer(c, sc(co, a), m[2]);
      return { ok: true };
    }));

    coPost("/inventory/backorders/recheck", safe(async (c, co, a) => {
      await requireRole(c, co, a, [...WAREHOUSE, "sales", "buyer"], "re-checking back orders");
      return inv.recheckBackorders(c, co.id, {});
    }));

    // ---- allocation and pick lists
    coPost("/inventory/allocate", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, [...WAREHOUSE, "sales"], "allocating a piece to an order");
      return inv.allocate(c, sc(co, a), str(b.label, 40), uuid(b.lineId) ?? "");
    }));
    coPost("/inventory/pick-list", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, [...WAREHOUSE, "dispatcher"], "building a pick list");
      const ids = (Array.isArray(b.orderIds) ? b.orderIds : []).map(uuid).filter(Boolean) as string[];
      need(ids.length, "pick at least one order");
      const list = await inv.pickListFor(c, co.id, ids);
      // Staging goods whose prep is not done: warned about, or refused, as the company chose.
      const lineIds = list.lines.map((l) => l.lineId);
      const gate = await wms.prepGate(c, co.id, lineIds, "staging this pick list");
      need(!gate.refuse, gate.message ?? "");
      if (gate.open.some((x) => x.status === "not_queued")) await wms.queueForLines(c, sc(co, a), lineIds);
      return { ...list, prepWarning: gate.message };
    }));

    // ---- damage and claims
    coPost("/inventory/damage", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, [...WAREHOUSE, "driver", "sales"], "reporting damage");
      return inv.reportDamage(c, sc(co, a), { label: str(b.label, 40) || undefined, productId: uuid(b.productId) ?? undefined, locationId: uuid(b.locationId) ?? undefined,
        qty: num(b.qty) || undefined, source: str(b.source, 30) || "warehouse", description: str(b.description), photoUrls: urls(b.photoUrls) });
    }));
    coPost(`/inventory/damage/${ID}/repair`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, WAREHOUSE, "sending to repair");
      return inv.sendToRepair(c, sc(co, a), m[2], str(b.note) || undefined);
    }));
    coPost(`/inventory/damage/${ID}/claim`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, [...WAREHOUSE, "buyer"], "opening a vendor claim");
      return inv.openVendorClaim(c, sc(co, a), m[2], { vendorRef: str(b.vendorRef, 80) || undefined, amountClaimedMinor: minor(b.amount ?? 0), photoUrls: urls(b.photoUrls) });
    }));
    coPost(`/inventory/damage/${ID}/resolve`, safe(async (c, co, a, b, m) => {
      const res = str(b.resolution, 30);
      await requireRole(c, co, a, ["written_off", "returned_to_vendor"].includes(res) ? MANAGER : WAREHOUSE,
        res === "written_off" ? "writing off damaged stock" : "resolving damage");
      return inv.resolveDamage(c, sc(co, a), m[2], { resolution: res, note: str(b.note) || undefined,
        asIsPriceMinor: b.asIsPrice != null && b.asIsPrice !== "" ? minor(b.asIsPrice) : null });
    }));
    coPost(`/inventory/claims/${ID}`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, [...MANAGER, "buyer"], "updating a vendor claim");
      return inv.updateClaim(c, sc(co, a), m[2], { status: str(b.status, 20), vendorRef: str(b.vendorRef, 80) || undefined,
        creditMinor: b.credit != null && b.credit !== "" ? minor(b.credit) : null, resolution: str(b.resolution) || undefined });
    }));

    // ---- counts
    coPost("/inventory/counts", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, WAREHOUSE, "starting a count");
      return inv.createCount(c, sc(co, a), { locationId: uuid(b.locationId) ?? "", binId: uuid(b.binId), note: str(b.note) || undefined });
    }));
    coPost(`/inventory/counts/${ID}/submit`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, WAREHOUSE, "submitting a count");
      const lines = (Array.isArray(b.lines) ? b.lines : []).map((l: Record<string, unknown>) => ({ productId: uuid(l.productId) ?? "",
        countedQty: l.countedQty === "" || l.countedQty == null ? null : num(l.countedQty), scannedLabels: labels(l.scannedLabels) }));
      return inv.submitCount(c, sc(co, a), m[2], lines);
    }));
    coPost(`/inventory/counts/${ID}/decide`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, MANAGER, "approving a count");
      return inv.decideCount(c, sc(co, a), m[2], { approve: b.approve === true, note: str(b.note) || undefined });
    }));

    // ---- adjustments
    coPost("/inventory/adjustments", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, MANAGER, "adjusting stock");
      return inv.adjust(c, sc(co, a), { locationId: uuid(b.locationId) ?? "", productId: uuid(b.productId) ?? "", qty: num(b.qty),
        reasonCode: str(b.reasonCode, 40), note: str(b.note) || undefined, binId: uuid(b.binId), labels: labels(b.labels) });
    }));
  },
};
