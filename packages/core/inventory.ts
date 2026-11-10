// Inventory: the only writer of stock_level. Owned by the inventory module.
//
// The first block is the contract other modules call -- POS and the web store
// to reserve, delivery and pickup to fulfil, returns to restock, fleet to
// build a pick list. Keep those signatures.
//
// The rest is the warehouse: bins, pieces with barcode labels, receiving
// against purchase orders, transfers, allocation of pieces to order lines,
// available-to-promise, damage with repair and vendor claims, cycle counts,
// adjustments and valuation.
//
// Quantities, in one place:
//   on_hand   units physically at the location that the company owns
//   reserved  units promised to open order lines (a quantity; which piece is
//             allocation, below)
//   held      units here that cannot be sold: damaged, in repair, on a vendor
//             claim, or back from a customer awaiting inspection
//   available on_hand - reserved - held
// A serialized product's on_hand always equals the number of its units whose
// pieces are in an on-hand status at that location; every piece move below
// keeps that true.
//
// Accounting (accounts by code):
//   transfer shipped          Dr 1310 inventory in transit   Cr 1300 inventory   (when the company keeps 1310;
//   transfer received         Dr 1300                         Cr 1310              otherwise in-transit value stays in 1300
//                                                                                  and the receipt only moves it between stores)
//   count / adjustment loss   Dr 5040 shrink and damage       Cr 1300
//   count / adjustment gain   Dr 1300                         Cr 5040
//   damage written off        Dr 5040                         Cr 1300
// Receiving posts nothing: inventory reaches the ledger when the vendor's
// merchandise invoice posts in payables (Dr 1300 Cr 2010), as it already does.

import { q, one, type Client, type Scope } from "./db.ts";
import { post, profitObjectFor } from "./posting.ts";

export class InventoryError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new InventoryError(msg); };
const today = () => new Date().toISOString().slice(0, 10);

/** Statuses in which a unit counts toward on_hand at its location. */
export const ON_HAND = ["in_stock", "reserved", "picked", "loaded", "damaged", "in_repair", "vendor_claim", "as_is", "returned"];
/** Of those, the ones that cannot be sold. */
export const HELD = ["damaged", "in_repair", "vendor_claim", "returned"];
const STOCKED_KINDS = ["stock", "configurable", "special_order"];

async function bump(c: Client, entityId: string, productId: string, locationId: string,
  d: { onHand?: number; reserved?: number; onOrder?: number; held?: number }) {
  await c.query(
    `insert into stock_level (entity_id, product_id, location_id, on_hand, reserved, on_order, held)
     values ($1,$2,$3,$4,greatest($5,0),greatest($6,0),greatest($7,0))
     on conflict (entity_id, product_id, location_id) do update set
       on_hand = stock_level.on_hand + $4,
       reserved = greatest(stock_level.reserved + $5, 0),
       on_order = greatest(stock_level.on_order + $6, 0),
       held = greatest(stock_level.held + $7, 0),
       updated_at = now()`,
    [entityId, productId, locationId, d.onHand ?? 0, d.reserved ?? 0, d.onOrder ?? 0, d.held ?? 0]);
}

// ============================================================ the contract

/**
 * Reserve stock for an order's open stock lines at their fulfil-from
 * location. A line that cannot be covered is marked on_order (a special or
 * back order for purchasing to pick up) rather than over-reserved.
 */
export async function reserveOrder(c: Client, entityId: string, orderId: string): Promise<{ reserved: number; shortLines: number }> {
  const lines = await q<{ id: string; product_id: string; qty: string; fulfil_from_id: string | null; kind: string }>(c, `
    select l.id, l.product_id, l.qty, l.fulfil_from_id, p.kind
      from sales_order_line l join product p on p.id = l.product_id
     where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status = 'open' and l.qty > 0
     order by l.seq for update of l`, [entityId, orderId]);
  let reserved = 0, short = 0;
  for (const l of lines) {
    if (!STOCKED_KINDS.includes(l.kind)) continue;
    const qty = Number(l.qty);
    // Read availability per line, so two lines for the same product cannot both take the last one.
    const av = l.fulfil_from_id ? await q<{ a: string }>(c,
      `select on_hand - reserved - held a from stock_level where entity_id = $1 and product_id = $2 and location_id = $3 for update`,
      [entityId, l.product_id, l.fulfil_from_id]) : [];
    if (l.kind === "stock" && l.fulfil_from_id && Number(av[0]?.a ?? 0) >= qty) {
      await bump(c, entityId, l.product_id, l.fulfil_from_id, { reserved: qty });
      await c.query(`update sales_order_line set line_status = 'reserved' where id = $1 and entity_id = $2`, [l.id, entityId]);
      reserved++;
    } else {
      await c.query(`update sales_order_line set line_status = 'on_order' where id = $1 and entity_id = $2`, [l.id, entityId]);
      short++;
    }
  }
  return { reserved, shortLines: short };
}

/**
 * Reserve only what can be covered now, for the named open stock lines (a
 * quote holding stock for the customer). Lines that cannot be covered stay
 * open -- nothing goes on order. Released with releaseLines.
 */
export async function reserveLines(c: Client, entityId: string, orderId: string, lineIds: string[]): Promise<string[]> {
  if (!lineIds.length) return [];
  const lines = await q<{ id: string; product_id: string; qty: string; fulfil_from_id: string | null; kind: string }>(c, `
    select l.id, l.product_id, l.qty, l.fulfil_from_id, p.kind
      from sales_order_line l join product p on p.id = l.product_id
     where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status = 'open' and l.qty > 0 and l.id = any($3)
     order by l.seq for update of l`, [entityId, orderId, lineIds]);
  const out: string[] = [];
  for (const l of lines) {
    if (l.kind !== "stock" || !l.fulfil_from_id) continue;
    const av = await q<{ a: string }>(c, `select on_hand - reserved - held a from stock_level where entity_id = $1 and product_id = $2 and location_id = $3 for update`,
      [entityId, l.product_id, l.fulfil_from_id]);
    if (Number(av[0]?.a ?? 0) < Number(l.qty)) continue;
    await bump(c, entityId, l.product_id, l.fulfil_from_id, { reserved: Number(l.qty) });
    await c.query(`update sales_order_line set line_status = 'reserved' where id = $1 and entity_id = $2`, [l.id, entityId]);
    out.push(l.id);
  }
  return out;
}

/**
 * Hand goods to the customer (carry-out, pickup, delivery). Relieves on hand
 * and any reservation, marks the lines fulfilled, and returns their cost for
 * the COGS posting. Fees, services and warranties fulfil with no stock.
 * Serialized pieces allocated to the line (or, if none were, the oldest free
 * ones at the location) are marked delivered.
 */
export async function fulfilLines(c: Client, entityId: string, orderId: string, lineIds: string[] | "all"):
  Promise<{ lines: number; costMinor: bigint }> {
  const lines = await q<{ id: string; product_id: string | null; qty: string; fulfil_from_id: string | null; line_status: string; kind: string | null; cost_minor: string | null; serialized: boolean | null }>(c, `
    select l.id, l.product_id, l.qty, l.fulfil_from_id, l.line_status, p.kind, p.cost_minor, p.serialized
      from sales_order_line l left join product p on p.id = l.product_id
     where l.entity_id = $1 and l.sales_order_id = $2
       and l.line_status in ('open','reserved','ready','on_order') and l.qty > 0
       and ($3::uuid[] is null or l.id = any($3))
     for update of l`, [entityId, orderId, lineIds === "all" ? null : lineIds]);
  let cost = 0n;
  for (const l of lines) {
    const stocked = l.product_id && STOCKED_KINDS.includes(l.kind ?? "");
    if (stocked) {
      if (!l.fulfil_from_id) throw new InventoryError("a line has no location to fulfil from");
      const qty = Number(l.qty);
      cost += await costOut(c, entityId, l.product_id!, qty);      // the value valuation loses is the cost of goods
      await bump(c, entityId, l.product_id!, l.fulfil_from_id, {
        onHand: -qty, reserved: l.line_status === "reserved" || l.line_status === "ready" ? -qty : 0 });
      if (l.serialized) {
        const units = await unitsForLine(c, entityId, l.id, l.product_id!, l.fulfil_from_id, qty);
        for (const u of units) await transitionUnit(c, entityId, null, u, "delivered", { kind: "deliver", refType: "order_line", refId: l.id, stock: false, salesOrderLineId: l.id });
      }
    }
    await c.query(`update sales_order_line set line_status = 'fulfilled' where id = $1 and entity_id = $2`, [l.id, entityId]);
  }
  return { lines: lines.length, costMinor: cost };
}

/** Release reservations on cancelled lines, and free any pieces allocated to them. */
export async function releaseLines(c: Client, entityId: string, orderId: string, lineIds: string[] | "all"): Promise<number> {
  const lines = await q<{ id: string; product_id: string; qty: string; fulfil_from_id: string }>(c, `
    select id, product_id, qty, fulfil_from_id from sales_order_line
     where entity_id = $1 and sales_order_id = $2 and line_status in ('reserved','ready')
       and ($3::uuid[] is null or id = any($3)) for update`, [entityId, orderId, lineIds === "all" ? null : lineIds]);
  for (const l of lines) {
    await bump(c, entityId, l.product_id, l.fulfil_from_id, { reserved: -Number(l.qty) });
    const units = await q<{ unit_id: string }>(c, `select distinct unit_id from inv_piece
      where entity_id = $1 and sales_order_line_id = $2 and status in ('reserved','picked','loaded')`, [entityId, l.id]);
    for (const u of units) await transitionUnit(c, entityId, null, u.unit_id, "in_stock", { kind: "unallocate", refType: "order_line", refId: l.id, salesOrderLineId: null });
  }
  return lines.length;
}

/**
 * Goods coming back in sellable condition: add to on hand at a location.
 * For serialized products the pieces delivered on opts.lineIds come back to
 * stock (the same labels); any shortfall gets new labels.
 */
export async function restock(c: Client, entityId: string, productId: string, locationId: string, qty: number,
  opts: { lineIds?: string[]; binId?: string | null; by?: string | null; unitCostMinor?: bigint } = {}): Promise<void> {
  if (qty <= 0) throw new InventoryError("restock a positive quantity");
  // Back into the cost pool at the unit cost the caller posts to 1300 (default: today's average).
  const unit = opts.unitCostMinor ?? await unitCost(c, entityId, productId);
  await costIn(c, entityId, productId, qty, BigInt(Math.round(qty * Number(unit))));
  await bump(c, entityId, productId, locationId, { onHand: qty });
  await returnUnits(c, entityId, productId, locationId, qty, "in_stock", opts);
}

/** Low-level adjust, for the inventory module's own receiving/transfer/count code. */
export const _bump = bump;

/**
 * Goods coming back damaged (a customer return that cannot be resold as is).
 * They are on hand but held, and a damage record opens for repair, a vendor
 * claim or a write-off.
 */
export async function returnToDamage(c: Client, scope: Scope, e: { productId: string; locationId: string; qty: number;
  lineIds?: string[]; description: string; photoUrls?: string[]; unitCostMinor?: bigint }): Promise<{ damageId: string; number: string }> {
  need(e.qty > 0, "return a positive quantity");
  need(e.description?.trim(), "say what is wrong with it");
  const by = scope.actor.id || null;
  const unit = e.unitCostMinor ?? await unitCost(c, scope.entityId, e.productId);
  await costIn(c, scope.entityId, e.productId, e.qty, BigInt(Math.round(e.qty * Number(unit))));
  await bump(c, scope.entityId, e.productId, e.locationId, { onHand: e.qty, held: e.qty });
  const units = await returnUnits(c, scope.entityId, e.productId, e.locationId, e.qty, "damaged", { lineIds: e.lineIds, by });
  let first: { damageId: string; number: string } | null = null;
  if (units.length) {
    for (const u of units) {
      const d = await insertDamage(c, scope.entityId, { productId: e.productId, locationId: e.locationId, unitId: u, qty: 1,
        source: "customer_return", description: e.description, photoUrls: e.photoUrls ?? [], cost: unit, by });
      first ??= d;
    }
  } else {
    first = await insertDamage(c, scope.entityId, { productId: e.productId, locationId: e.locationId, unitId: null, qty: e.qty,
      source: "customer_return", description: e.description, photoUrls: e.photoUrls ?? [], cost: unit, by });
  }
  return first!;
}

// ============================================================ cost pool
//
// Perpetual average cost per product per company: the quantity on hand and
// what it is worth. Every caller takes value out (costOut) or puts it in
// (costIn) before it moves the quantity, and posts the same amount to 1300.

async function poolOf(c: Client, entityId: string, productId: string): Promise<{ qty: number; value: bigint }> {
  const r = await q<{ qty: string; value_minor: string }>(c, `select qty, value_minor from inv_cost where entity_id = $1 and product_id = $2 for update`, [entityId, productId]);
  if (r.length) return { qty: Number(r[0].qty), value: BigInt(r[0].value_minor) };
  // Stock that predates the pool comes in at the catalog cost (the demo seed posts its opening entry).
  const init = await one<{ qty: string; cost: string }>(c, `select coalesce((select sum(on_hand) from stock_level where entity_id = $1 and product_id = $2), 0)::text qty,
      (select cost_minor from product where id = $2 and entity_id = $1)::text cost`, [entityId, productId]);
  const qty = Number(init.qty), value = BigInt(Math.round(qty * Number(init.cost ?? 0)));
  await c.query(`insert into inv_cost (entity_id, product_id, qty, value_minor) values ($1,$2,$3,$4) on conflict do nothing`, [entityId, productId, qty, value.toString()]);
  return { qty, value };
}

/** Today's average cost of one unit; the catalog cost when none is on hand. */
export async function unitCost(c: Client, entityId: string, productId: string): Promise<bigint> {
  const p = await poolOf(c, entityId, productId);
  if (p.qty > 0 && p.value > 0n) return BigInt(Math.round(Number(p.value) / p.qty));
  const r = await q<{ cost_minor: string }>(c, `select cost_minor from product where id = $1 and entity_id = $2`, [productId, entityId]);
  return BigInt(r[0]?.cost_minor ?? 0);
}

async function costIn(c: Client, entityId: string, productId: string, qty: number, valueMinor: bigint) {
  const p = await poolOf(c, entityId, productId);
  await c.query(`update inv_cost set qty = $3, value_minor = $4, updated_at = now() where entity_id = $1 and product_id = $2`,
    [entityId, productId, p.qty + qty, (p.value + valueMinor).toString()]);
}

/**
 * Take qty out of the pool at its average; returns the value taken (the last unit takes whatever is left).
 * Goods bought from a sibling carry inter-company markup (ic_markup_move): the same share of it leaves
 * with them -- realized when they leave the group ('out'), carried on when they go to another sibling
 * ('carry_out'), and kept when they only move between this company's own locations ('none').
 */
async function costOut(c: Client, entityId: string, productId: string, qty: number,
  markup: "out" | "carry_out" | "none" = "out", transferId: string | null = null): Promise<bigint> {
  if (qty <= 0) return 0n;
  const p = await poolOf(c, entityId, productId);
  if (markup !== "none") await takeMarkup(c, entityId, productId, qty, p.qty, markup, transferId);
  let v: bigint;
  if (p.qty <= 0) v = BigInt(Math.round(qty * Number(await unitCost(c, entityId, productId))));
  else if (qty >= p.qty) v = p.value + (qty > p.qty ? BigInt(Math.round((qty - p.qty) * Number(p.value) / p.qty)) : 0n);
  else v = BigInt(Math.round(Number(p.value) * qty / p.qty));
  if (v < 0n) v = 0n;
  await c.query(`update inv_cost set qty = $3, value_minor = $4, updated_at = now() where entity_id = $1 and product_id = $2`,
    [entityId, productId, p.qty - qty, (p.value - v).toString()]);
  return v;
}

/** The share of a product's inter-company markup that leaves with qty units out of a pool of poolQty. */
async function takeMarkup(c: Client, entityId: string, productId: string, qty: number, poolQty: number, kind: "out" | "carry_out", transferId: string | null) {
  const rows = await q<{ from_entity_id: string; qty: string; m: string }>(c, `
    select from_entity_id, sum(qty)::text qty, sum(markup_minor)::text m from ic_markup_move
     where entity_id = $1 and product_id = $2 group by from_entity_id having sum(qty) > 0 or sum(markup_minor) <> 0`, [entityId, productId]);
  if (!rows.length) return;
  const all = poolQty <= 0 || qty >= poolQty;
  for (const r of rows) {
    const dq = all ? Number(r.qty) : Number(r.qty) * qty / poolQty;
    const dm = all ? BigInt(r.m) : BigInt(Math.round(Number(r.m) * qty / poolQty));
    if (dq === 0 && dm === 0n) continue;
    await c.query(`insert into ic_markup_move (entity_id, from_entity_id, product_id, qty, markup_minor, kind, transfer_id) values ($1,$2,$3,$4,$5,$6,$7)`,
      [entityId, r.from_entity_id, productId, -dq, (-dm).toString(), kind, transferId]);
  }
}

// ================================================================ helpers

type Product = { id: string; sku: string; name: string; kind: string; serialized: boolean; cost_minor: string;
  cubic_ft: string | null; weight_lb: string | null; category: string | null; vendor_id: string | null };

async function productOf(c: Client, entityId: string, productId: string): Promise<Product> {
  const r = await q<Product>(c, `select id, sku, name, kind, serialized, cost_minor, cubic_ft, weight_lb, category, vendor_id
    from product where id = $1 and entity_id = $2`, [productId, entityId]);
  need(r.length, "no such product");
  return r[0];
}

async function hasRelation(c: Client, name: string): Promise<boolean> {
  const r = await q<{ r: string | null }>(c, `select to_regclass($1)::text r /* unscoped: schema lookup */`, [name]);
  return !!r[0]?.r;
}

async function columnsOf(c: Client, table: string): Promise<Set<string>> {
  const r = await q<{ column_name: string }>(c, `select column_name from information_schema.columns
    where table_schema = current_schema() and table_name = $1 /* unscoped: schema lookup */`, [table]);
  return new Set(r.map((x) => x.column_name));
}

/** A company setting (entity_setting), or the default. Read here so inventory needs nothing from setup. */
export async function settingOf<T>(c: Client, entityId: string, key: string, dflt: T): Promise<T> {
  const r = await q<{ value: T }>(c, `select value from entity_setting where entity_id = $1 and key = $2`, [entityId, key]);
  return r.length ? r[0].value : dflt;
}

/** Whether same-company transfers ship and receive as two steps, and which account holds them on the road. */
export async function transferSettings(c: Client, entityId: string): Promise<{ twoStep: boolean; transitGl: "1300" | "1310"; transitDays: number }> {
  const twoStep = (await settingOf<unknown>(c, entityId, "inventory.transfers_two_step", false)) === true;
  const gl = await settingOf<unknown>(c, entityId, "inventory.in_transit_gl", "1300");
  const days = Number(await settingOf<unknown>(c, entityId, "inventory.transfer_days", 1));
  return { twoStep, transitGl: gl === "1310" ? "1310" : "1300", transitDays: Number.isInteger(days) && days >= 0 && days <= 60 ? days : 1 };
}

const VIRTUAL: Record<string, [code: string, name: string, kind: string]> = {
  vendor: ["VT-VENDOR", "In transit · vendor to DC", "in_transit"],
  store: ["VT-STORE", "In transit · store to store", "in_transit"],
  dropship: ["VT-DROP", "Supplier-held (drop ship)", "dropship"],
};
/** Kinds of location nothing is ever on hand at. */
export const VIRTUAL_KINDS = ["in_transit", "dropship"];

/**
 * The company's virtual location for goods on the road (vendor to DC, or
 * store to store) or for stock a supplier holds and ships for us. Made the
 * first time it is needed.
 */
export async function virtualLocation(c: Client, entityId: string, which: "vendor" | "store" | "dropship"): Promise<string> {
  const [code, name, kind] = VIRTUAL[which];
  const r = await q<{ id: string; kind: string }>(c, `select id, kind from location where entity_id = $1 and code = $2`, [entityId, code]);
  if (r.length) { need(r[0].kind === kind, `location ${code} is taken by a place that is not ${kind.replace("_", " ")}; rename it in Setup`); return r[0].id; }
  return (await one<{ id: string }>(c, `insert into location (entity_id, code, name, kind, status) values ($1,$2,$3,$4,'active') returning id`,
    [entityId, code, name, kind])).id;
}

export async function nextNo(c: Client, entityId: string, kind: string, prefix: string): Promise<string> {
  return (await q<{ n: string }>(c, `select next_doc_no($1, $2, $3) n /* unscoped: numbering keyed by entity argument */`, [entityId, kind, prefix]))[0].n;
}

/** The cartons one unit of a product ships in: the catalog's product_piece rows, else one. */
export async function cartonsFor(c: Client, entityId: string, p: Product):
  Promise<{ seq: number; label: string | null; cubic_ft: string | null; weight_lb: string | null }[]> {
  if (await hasRelation(c, "product_piece")) {
    const r = await q<{ seq: number; label: string | null; cubic_ft: string | null; weight_lb: string | null }>(c,
      `select seq, label, cubic_ft::text, weight_lb::text from product_piece where entity_id = $1 and product_id = $2 order by seq`,
      [entityId, p.id]);
    if (r.length) return r;
  }
  return [{ seq: 1, label: null, cubic_ft: p.cubic_ft, weight_lb: p.weight_lb }];
}

type Move = { kind: string; pieceId?: string | null; productId: string; qty: number; fromLoc?: string | null; toLoc?: string | null;
  fromBin?: string | null; toBin?: string | null; fromStatus?: string | null; toStatus?: string | null;
  refType?: string | null; refId?: string | null; reason?: string | null; by?: string | null };

async function logMove(c: Client, entityId: string, m: Move) {
  await c.query(`insert into inv_move (entity_id, kind, piece_id, product_id, qty, from_location_id, to_location_id, from_bin_id, to_bin_id,
      from_status, to_status, ref_type, ref_id, reason, by_user)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [entityId, m.kind, m.pieceId ?? null, m.productId, m.qty, m.fromLoc ?? null, m.toLoc ?? null, m.fromBin ?? null, m.toBin ?? null,
     m.fromStatus ?? null, m.toStatus ?? null, m.refType ?? null, m.refId ?? null, m.reason ?? null, m.by || null]);
}

async function binAt(c: Client, entityId: string, binId: string | null | undefined, locationId: string): Promise<string | null> {
  if (!binId) return null;
  const r = await q<{ id: string; location_id: string }>(c, `select id, location_id from inv_bin where id = $1 and entity_id = $2 and active`, [binId, entityId]);
  need(r.length, "no such bin");
  need(r[0].location_id === locationId, "that bin is at a different location");
  return r[0].id;
}

/**
 * Make new units of a serialized product, each with a label per carton.
 * Does not touch stock_level; the caller bumps.
 */
async function createUnits(c: Client, entityId: string, p: Product, e: { locationId: string; binId: string | null; qty: number; status: string;
  costMinor: bigint; kind: string; refType?: string; refId?: string | null; reason?: string | null; by?: string | null;
  grLineId?: string | null; salesOrderLineId?: string | null }): Promise<{ unitIds: string[]; labels: string[] }> {
  need(Number.isInteger(e.qty) && e.qty > 0, `${p.name} is tracked piece by piece, so the quantity must be a whole number`);
  const cartons = await cartonsFor(c, entityId, p);
  const unitIds: string[] = [], labels: string[] = [];
  for (let i = 0; i < e.qty; i++) {
    const unit = (await q<{ u: string }>(c, `select gen_random_uuid()::text u /* unscoped: no table */`))[0].u;
    unitIds.push(unit);
    for (const ct of cartons) {
      const label = await nextNo(c, entityId, "piece", "P");
      const pc = await one<{ id: string }>(c, `insert into inv_piece (entity_id, label, product_id, unit_id, carton_seq, carton_count, carton_label,
          cubic_ft, weight_lb, location_id, bin_id, status, cost_minor, goods_receipt_line_id, sales_order_line_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
        [entityId, label, p.id, unit, ct.seq, cartons.length, ct.label, ct.cubic_ft, ct.weight_lb, e.locationId, e.binId, e.status,
         e.costMinor.toString(), e.grLineId ?? null, e.salesOrderLineId ?? null]);
      labels.push(label);
      await logMove(c, entityId, { kind: e.kind, pieceId: pc.id, productId: p.id, qty: 1 / cartons.length, toLoc: e.locationId, toBin: e.binId,
        toStatus: e.status, refType: e.refType, refId: e.refId, reason: e.reason, by: e.by });
    }
  }
  return { unitIds, labels };
}

type PieceRow = { id: string; label: string; product_id: string; unit_id: string; carton_seq: number; carton_count: number;
  location_id: string; bin_id: string | null; status: string; sales_order_line_id: string | null; cost_minor: string; transfer_id: string | null };

async function piecesOfUnit(c: Client, entityId: string, unitId: string): Promise<PieceRow[]> {
  return q<PieceRow>(c, `select id, label, product_id, unit_id, carton_seq, carton_count, location_id, bin_id, status,
      sales_order_line_id, cost_minor, transfer_id
    from inv_piece where entity_id = $1 and unit_id = $2 order by carton_seq for update`, [entityId, unitId]);
}

/**
 * Move every carton of a unit to a new status (and optionally a new
 * location, bin or order line), log a move per carton, and keep stock_level
 * true unless the caller has already moved the quantities (stock: false).
 */
async function transitionUnit(c: Client, entityId: string, by: string | null, unitId: string, to: string, o: {
  kind: string; reason?: string | null; refType?: string; refId?: string | null; toBin?: string | null; toLocation?: string;
  salesOrderLineId?: string | null; transferId?: string | null; stock?: boolean; asIsPriceMinor?: bigint | null; asIsNote?: string | null }) {
  const pcs = await piecesOfUnit(c, entityId, unitId);
  need(pcs.length, "no such unit");
  const from = pcs[0];
  const toLoc = o.toLocation ?? from.location_id;
  const leaving = !ON_HAND.includes(to);
  for (const p of pcs) {
    const toBin = leaving ? null : o.toBin !== undefined ? o.toBin : toLoc !== p.location_id ? null : p.bin_id;
    await c.query(`update inv_piece set status = $3, location_id = $4, bin_id = $5,
        sales_order_line_id = case when $6::boolean then $7::uuid else sales_order_line_id end,
        transfer_id = case when $8::boolean then $9::uuid else transfer_id end,
        as_is_price_minor = case when $3 = 'as_is' then coalesce($10::bigint, as_is_price_minor) else null end,
        as_is_note = case when $3 = 'as_is' then coalesce($11, as_is_note) else null end,
        updated_at = now()
      where id = $1 and entity_id = $2`,
      [p.id, entityId, to, toLoc, toBin, o.salesOrderLineId !== undefined, o.salesOrderLineId ?? null,
       o.transferId !== undefined, o.transferId ?? null, o.asIsPriceMinor?.toString() ?? null, o.asIsNote ?? null]);
    await logMove(c, entityId, { kind: o.kind, pieceId: p.id, productId: p.product_id, qty: 1 / p.carton_count,
      fromLoc: p.location_id, toLoc: leaving ? null : toLoc, fromBin: p.bin_id, toBin, fromStatus: p.status, toStatus: to,
      refType: o.refType, refId: o.refId, reason: o.reason, by });
  }
  if (o.stock === false) return;
  const was = { on: ON_HAND.includes(from.status) ? 1 : 0, held: HELD.includes(from.status) ? 1 : 0 };
  const now = { on: ON_HAND.includes(to) ? 1 : 0, held: HELD.includes(to) ? 1 : 0 };
  if (toLoc === from.location_id) {
    if (was.on !== now.on || was.held !== now.held)
      await bump(c, entityId, from.product_id, toLoc, { onHand: now.on - was.on, held: now.held - was.held });
  } else {
    if (was.on || was.held) await bump(c, entityId, from.product_id, from.location_id, { onHand: -was.on, held: -was.held });
    if (now.on || now.held) await bump(c, entityId, from.product_id, toLoc, { onHand: now.on, held: now.held });
  }
}

/** Units to hand over for a line: those allocated to it first, then the oldest free ones at the location. */
async function unitsForLine(c: Client, entityId: string, lineId: string, productId: string, locationId: string, qty: number): Promise<string[]> {
  const mine = await q<{ unit_id: string }>(c, `select unit_id from inv_piece
     where entity_id = $1 and sales_order_line_id = $2 and status in ('reserved','picked','loaded')
     group by unit_id order by min(created_at)`, [entityId, lineId]);
  const out = mine.map((u) => u.unit_id).slice(0, qty);
  if (out.length < qty) {
    const free = await freeUnits(c, entityId, productId, locationId, qty - out.length);
    out.push(...free);
  }
  return out;
}

/** The oldest in-stock, unallocated units of a product at a location (whole units: every carton free). */
async function freeUnits(c: Client, entityId: string, productId: string, locationId: string, n: number, statuses = ["in_stock"]): Promise<string[]> {
  if (n <= 0) return [];
  const r = await q<{ unit_id: string }>(c, `select unit_id from inv_piece
     where entity_id = $1 and product_id = $2 and location_id = $3
     group by unit_id
     having bool_and(status = any($4) and sales_order_line_id is null)
     order by min(created_at) limit $5`, [entityId, productId, locationId, statuses, n]);
  return r.map((x) => x.unit_id);
}

/** Bring delivered units back (returns), or make new ones for any shortfall. */
async function returnUnits(c: Client, entityId: string, productId: string, locationId: string, qty: number, status: string,
  opts: { lineIds?: string[]; binId?: string | null; by?: string | null }): Promise<string[]> {
  const p = await productOf(c, entityId, productId);
  if (!p.serialized) {
    if (opts.binId && status === "in_stock") await binStockAdd(c, entityId, opts.binId, productId, qty);
    await logMove(c, entityId, { kind: "return", productId, qty, toLoc: locationId, toBin: opts.binId ?? null, toStatus: status, by: opts.by });
    return [];
  }
  const binId = await binAt(c, entityId, opts.binId, locationId);
  const units: string[] = [];
  if (opts.lineIds?.length) {
    const back = await q<{ unit_id: string }>(c, `select unit_id from inv_piece
       where entity_id = $1 and product_id = $2 and status = 'delivered' and sales_order_line_id = any($3)
       group by unit_id order by min(created_at) limit $4`, [entityId, productId, opts.lineIds, Math.trunc(qty)]);
    for (const u of back) {
      await transitionUnit(c, entityId, opts.by ?? null, u.unit_id, status, { kind: "return", toLocation: locationId, toBin: binId,
        salesOrderLineId: null, stock: false });
      units.push(u.unit_id);
    }
  }
  const rest = Math.trunc(qty) - units.length;
  if (rest > 0) {
    const made = await createUnits(c, entityId, p, { locationId, binId, qty: rest, status, costMinor: BigInt(p.cost_minor), kind: "return", by: opts.by });
    units.push(...made.unitIds);
  }
  return units;
}

async function binStockAdd(c: Client, entityId: string, binId: string, productId: string, qty: number) {
  if (qty >= 0) {
    await c.query(`insert into inv_bin_stock (entity_id, bin_id, product_id, qty) values ($1,$2,$3,$4)
      on conflict (bin_id, product_id) do update set qty = inv_bin_stock.qty + $4`, [entityId, binId, productId, qty]);
  } else {
    const r = await q<{ qty: string }>(c, `select qty from inv_bin_stock where entity_id = $1 and bin_id = $2 and product_id = $3 for update`, [entityId, binId, productId]);
    need(Number(r[0]?.qty ?? 0) >= -qty, "that bin does not hold that many");
    await c.query(`update inv_bin_stock set qty = qty + $4 where entity_id = $1 and bin_id = $2 and product_id = $3`, [entityId, binId, productId, qty]);
  }
}

/** Take a quantity out of whichever bins at a location hold it, fullest first (non-serialized stock). */
async function binStockTake(c: Client, entityId: string, productId: string, locationId: string, qty: number) {
  let left = qty;
  const bins = await q<{ bin_id: string; qty: string }>(c, `select s.bin_id, s.qty from inv_bin_stock s join inv_bin b on b.id = s.bin_id
     where s.entity_id = $1 and s.product_id = $2 and b.location_id = $3 and s.qty > 0 order by s.qty desc for update of s`,
    [entityId, productId, locationId]);
  for (const b of bins) {
    if (left <= 0) break;
    const take = Math.min(left, Number(b.qty));
    await c.query(`update inv_bin_stock set qty = qty - $4 where entity_id = $1 and bin_id = $2 and product_id = $3`, [entityId, b.bin_id, productId, take]);
    left -= take;
  }
  // Whatever was not binned came off the unbinned floor stock; nothing more to do.
}

async function level(c: Client, entityId: string, productId: string, locationId: string) {
  const r = await q<{ on_hand: string; reserved: string; held: string; on_order: string }>(c,
    `select on_hand, reserved, held, on_order from stock_level where entity_id = $1 and product_id = $2 and location_id = $3 for update`,
    [entityId, productId, locationId]);
  const x = r[0];
  return { onHand: Number(x?.on_hand ?? 0), reserved: Number(x?.reserved ?? 0), held: Number(x?.held ?? 0), onOrder: Number(x?.on_order ?? 0),
    available: Number(x?.on_hand ?? 0) - Number(x?.reserved ?? 0) - Number(x?.held ?? 0) };
}

/** Post a stock value change: positive = inventory up. Returns the journal entry, or null for zero. */
async function postValue(c: Client, scope: Scope, locationId: string, valueMinor: bigint, sourceId: string, description: string,
  other = "5040"): Promise<string | null> {
  if (valueMinor === 0n) return null;
  const po = await profitObjectFor(c, scope.entityId, locationId);
  const abs = valueMinor < 0n ? -valueMinor : valueMinor;
  const lines = valueMinor > 0n
    ? [{ code: "1300", debit: abs, profitObjectId: po }, { code: other, credit: abs, profitObjectId: po }]
    : [{ code: other, debit: abs, profitObjectId: po }, { code: "1300", credit: abs, profitObjectId: po }];
  return post(c, scope, { date: today(), sourceType: "inventory", sourceId, description, lines });
}

// ============================================================ bins, docks

export async function addZone(c: Client, entityId: string, e: { locationId: string; code: string; name: string; kind?: string }) {
  need(e.code && e.name, "a zone needs a code and a name");
  const loc = await q(c, `select id from location where id = $1 and entity_id = $2`, [e.locationId, entityId]);
  need(loc.length, "no such location");
  return one<{ id: string }>(c, `insert into inv_zone (entity_id, location_id, code, name, kind) values ($1,$2,$3,$4,$5) returning id`,
    [entityId, e.locationId, e.code.toUpperCase(), e.name, e.kind ?? "storage"]);
}

export async function addBin(c: Client, entityId: string, e: { zoneId: string; aisle?: string; rack?: string; level?: string; code?: string; maxCubicFt?: number | null }) {
  const z = await q<{ id: string; location_id: string; code: string }>(c, `select id, location_id, code from inv_zone where id = $1 and entity_id = $2`, [e.zoneId, entityId]);
  need(z.length, "no such zone");
  const code = (e.code || [e.aisle, e.rack, e.level].filter(Boolean).join("-") || "").toUpperCase();
  need(code, "a bin needs a code, or an aisle and rack to make one");
  return one<{ id: string; code: string }>(c, `insert into inv_bin (entity_id, location_id, zone_id, aisle, rack, level, code, max_cubic_ft)
    values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, code`,
    [entityId, z[0].location_id, z[0].id, e.aisle ?? null, e.rack ?? null, e.level ?? null, code, e.maxCubicFt ?? null]);
}

export async function setDock(c: Client, entityId: string, e: { locationId: string; dailyPieceLimit: number; receivingBinId?: string | null }) {
  need(e.dailyPieceLimit > 0, "the daily piece limit must be more than zero");
  const bin = await binAt(c, entityId, e.receivingBinId, e.locationId);
  await c.query(`insert into inv_dock (entity_id, location_id, daily_piece_limit, receiving_bin_id) values ($1,$2,$3,$4)
    on conflict (location_id) do update set daily_piece_limit = $3, receiving_bin_id = $4`, [entityId, e.locationId, e.dailyPieceLimit, bin]);
}

/** Move non-serialized stock between bins at one location (putaway, re-slot). */
export async function moveQty(c: Client, scope: Scope, e: { productId: string; fromBinId?: string | null; toBinId: string; qty: number }) {
  need(e.qty > 0, "move a positive quantity");
  const to = await q<{ location_id: string }>(c, `select location_id from inv_bin where id = $1 and entity_id = $2`, [e.toBinId, scope.entityId]);
  need(to.length, "no such bin");
  const p = await productOf(c, scope.entityId, e.productId);
  need(!p.serialized, `${p.name} is tracked piece by piece; scan each piece to move it`);
  if (e.fromBinId) {
    await binAt(c, scope.entityId, e.fromBinId, to[0].location_id);
    await binStockAdd(c, scope.entityId, e.fromBinId, e.productId, -e.qty);
  } else {
    const lv = await level(c, scope.entityId, e.productId, to[0].location_id);
    const binned = await q<{ s: string }>(c, `select coalesce(sum(s.qty),0) s from inv_bin_stock s join inv_bin b on b.id = s.bin_id
      where s.entity_id = $1 and s.product_id = $2 and b.location_id = $3`, [scope.entityId, e.productId, to[0].location_id]);
    need(lv.onHand - Number(binned[0].s) >= e.qty, "there is not that much unbinned stock here to put away");
  }
  await binStockAdd(c, scope.entityId, e.toBinId, e.productId, e.qty);
  await logMove(c, scope.entityId, { kind: e.fromBinId ? "move" : "putaway", productId: e.productId, qty: e.qty, fromLoc: to[0].location_id,
    toLoc: to[0].location_id, fromBin: e.fromBinId ?? null, toBin: e.toBinId, by: scope.actor.id });
}

// ================================================================ receiving

/** Open purchase orders with what is left to receive per line. Robust when purchasing has not linked products. */
export async function openPurchaseOrders(c: Client, entityId: string) {
  const cols = await columnsOf(c, "purchase_order_line");
  const prod = cols.has("product_id") ? "l.product_id" : "null::uuid";
  const hcols = await columnsOf(c, "purchase_order");
  const lineEta = cols.has("expected_on") ? "l.expected_on" : "null::date";
  const eta = hcols.has("expected_on") ? `coalesce(${lineEta}, po.expected_on)` : lineEta;
  const cancelled = cols.has("cancelled_qty") ? "l.cancelled_qty" : "0";
  const shipTo = hcols.has("ship_to_location_id") ? "po.ship_to_location_id" : "null::uuid";
  const landed = cols.has("landed_minor") ? "l.landed_minor" : "0";
  return q<{ po_id: string; number: string; vendor: string; ordered_on: string; line_id: string; seq: number; description: string;
    product_id: string | null; sku: string | null; serialized: boolean | null; ordered: string; received: string; expected_on: string | null; unit_price_minor: string;
    ship_to_id: string | null; landed_minor: string; agreement_ref: string | null }>(c, `
    select po.id po_id, po.number, v.legal_name vendor, po.ordered_on::text, l.id line_id, l.seq, l.description,
           ${prod} product_id, p.sku, p.serialized, (l.quantity - ${cancelled})::text ordered, ${shipTo} ship_to_id,
           coalesce((select sum(gl.quantity) from goods_receipt_line gl where gl.purchase_order_line_id = l.id), 0)::text received,
           ${eta}::text expected_on, l.unit_price_minor::text, ${landed}::text landed_minor, l.agreement_ref
      from purchase_order po join purchase_order_line l on l.purchase_order_id = po.id
      join vendor v on v.id = po.vendor_id
      left join product p on p.id = ${prod} and p.entity_id = po.entity_id
     where po.entity_id = $1 and po.status = 'open'
     order by po.ordered_on, po.number, l.seq`, [entityId]);
}

/** extraMinor: cost carried by these units on top of the PO line's (a container's freight and duty share for what came off it). */
export type ReceiveLine = { poLineId: string; qty: number; damagedQty?: number; damageNote?: string; extraMinor?: bigint };

/**
 * Receive goods against a purchase order, partially or in full. Writes the
 * goods receipt, makes labelled pieces for serialized products, raises on
 * hand at the receiving location, lowers on order, and closes the PO when
 * every line is in. Units that arrive damaged are received held, with a
 * damage record opened.
 */
export async function receivePurchaseOrder(c: Client, scope: Scope, e: { purchaseOrderId: string; locationId: string; binId?: string | null;
  lines: ReceiveLine[]; note?: string; appointmentId?: string | null }) {
  const entityId = scope.entityId, by = scope.actor.id || null;
  const po = await q<{ id: string; number: string; status: string }>(c,
    `select id, number, status from purchase_order where id = $1 and entity_id = $2 for update`, [e.purchaseOrderId, entityId]);
  need(po.length, "no such purchase order");
  need(po[0].status === "open", `purchase order ${po[0].number} is ${po[0].status}, not open`);
  const open = await openPurchaseOrders(c, entityId);
  if (!e.locationId) e.locationId = open.find((x) => x.po_id === po[0].id)?.ship_to_id ?? "";
  need(e.locationId, "pick the location receiving the goods");
  const loc = await q<{ id: string; kind: string }>(c, `select id, kind from location where id = $1 and entity_id = $2 and status = 'active'`, [e.locationId, entityId]);
  need(loc.length, "no such location");
  need(!VIRTUAL_KINDS.includes(loc[0].kind), "goods are received where they are unloaded, not into an in-transit or supplier-held location");
  let binId = await binAt(c, entityId, e.binId, e.locationId);
  if (!binId) {
    const d = await q<{ receiving_bin_id: string | null }>(c, `select receiving_bin_id from inv_dock where entity_id = $1 and location_id = $2`, [entityId, e.locationId]);
    binId = d[0]?.receiving_bin_id ?? null;
  }
  need(e.lines?.length, "say what arrived");
  const cols = await columnsOf(c, "purchase_order_line");
  need(cols.has("product_id"), "purchase order lines do not name products yet, so nothing can be received into stock");
  const gr = await one<{ id: string }>(c, `insert into goods_receipt (purchase_order_id, received_on, received_by, note) values ($1,$2,$3,$4) returning id`,
    [po[0].id, today(), by, e.note ?? null]);
  const out: { poLineId: string; sku: string; qty: number; labels: string[]; unitCostMinor: bigint; reservedFor: string[] }[] = [];
  const seen = new Set<string>();
  const received = new Set<string>(), linked = new Set<string>();
  let total = 0n;
  for (const ln of e.lines) {
    const l = open.find((x) => x.line_id === ln.poLineId && x.po_id === po[0].id);
    need(l, "that line is not on this purchase order");
    need(!seen.has(ln.poLineId), "each line once per receipt");
    seen.add(ln.poLineId);
    need(l!.product_id, `line ${l!.seq} (${l!.description}) names no product; link it in purchasing before receiving it`);
    const qty = Number(ln.qty), dmg = Number(ln.damagedQty ?? 0);
    need(qty > 0, "receive a positive quantity");
    need(dmg >= 0 && dmg <= qty, "the damaged count cannot be more than what arrived");
    const remaining = Number(l!.ordered) - Number(l!.received);
    need(qty <= remaining, `line ${l!.seq} (${l!.sku}) has ${remaining} left to receive, not ${qty}`);
    const p = await productOf(c, entityId, l!.product_id!);
    // What a unit cost: the PO price plus its share of any landed cost purchasing spread over the line.
    const ordered = Number(l!.ordered);
    const extra = ln.extraMinor ?? 0n;
    need(extra >= 0n, "extra landed cost cannot be negative");
    const unitCost = BigInt(l!.unit_price_minor) + (ordered > 0 ? BigInt(Math.round(Number(l!.landed_minor ?? 0) / ordered)) : 0n)
      + (qty > 0 ? BigInt(Math.round(Number(extra) / qty)) : 0n);
    const value = BigInt(Math.round(qty * Number(unitCost - (qty > 0 ? BigInt(Math.round(Number(extra) / qty)) : 0n)))) + extra;
    const grl = await one<{ id: string }>(c, `insert into goods_receipt_line (goods_receipt_id, purchase_order_line_id, quantity) values ($1,$2,$3) returning id`,
      [gr.id, l!.line_id, qty]);
    const labels: string[] = [];
    let good: string[] = [];
    if (p.serialized) {
      if (qty - dmg > 0) {
        const made = await createUnits(c, entityId, p, { locationId: e.locationId, binId, qty: qty - dmg, status: "in_stock", costMinor: unitCost,
          kind: "receive", refType: "receipt", refId: gr.id, by, grLineId: grl.id });
        labels.push(...made.labels); good = made.unitIds;
      }
      if (dmg > 0) {
        const made = await createUnits(c, entityId, p, { locationId: e.locationId, binId: null, qty: dmg, status: "damaged", costMinor: unitCost,
          kind: "receive", refType: "receipt", refId: gr.id, by, grLineId: grl.id, reason: "arrived damaged" });
        labels.push(...made.labels);
        for (const u of made.unitIds) await insertDamage(c, entityId, { productId: p.id, locationId: e.locationId, unitId: u, qty: 1, source: "receiving",
          description: ln.damageNote || `Arrived damaged on PO ${po[0].number}`, photoUrls: [], cost: unitCost, by });
      }
      await c.query(`update goods_receipt_line set unit_ids = $2 where id = $1 /* unscoped: row just written under this entity's PO */`, [grl.id, labels]);
    } else {
      if (binId && qty - dmg > 0) await binStockAdd(c, entityId, binId, p.id, qty - dmg);
      await logMove(c, entityId, { kind: "receive", productId: p.id, qty, toLoc: e.locationId, toBin: binId, toStatus: "in_stock", refType: "receipt", refId: gr.id, by });
      if (dmg > 0) await insertDamage(c, entityId, { productId: p.id, locationId: e.locationId, unitId: null, qty: dmg, source: "receiving",
        description: ln.damageNote || `Arrived damaged on PO ${po[0].number}`, photoUrls: [], cost: unitCost, by });
    }
    await costIn(c, entityId, p.id, qty, value);
    total += value;
    await bump(c, entityId, p.id, e.locationId, { onHand: qty, onOrder: -qty, held: dmg });
    // A customer's special order (or back order) on this PO line gets these goods: reserved, and the pieces allocated to it.
    const reservedFor: string[] = [];
    let free = qty - dmg;
    for (const sl of await salesLinesFor(c, entityId, l!.line_id, l!.agreement_ref, p.id)) {
      const n = Number(sl.qty);
      if (n > free || (p.serialized && good.length < n)) break;
      await bump(c, entityId, p.id, e.locationId, { reserved: n });
      await c.query(`update sales_order_line set line_status = 'reserved', fulfil_from_id = $3 where id = $1 and entity_id = $2`, [sl.id, entityId, e.locationId]);
      if (p.serialized) for (const u of good.splice(0, n)) await transitionUnit(c, entityId, by, u, "reserved",
        { kind: "allocate", refType: "order_line", refId: sl.id, salesOrderLineId: sl.id, reason: `special order ${sl.number}` });
      free -= n;
      linked.add(sl.id);
      reservedFor.push(sl.number);
    }
    received.add(p.id);
    out.push({ poLineId: l!.line_id, sku: p.sku, qty, labels, unitCostMinor: unitCost, reservedFor });
  }
  // Received, not yet invoiced: the vendor's bill clears 2050.
  if (total > 0n) {
    const pobj = await profitObjectFor(c, entityId, e.locationId);
    await post(c, scope, { date: today(), sourceType: "inventory", sourceId: gr.id, description: `Received on ${po[0].number}`,
      lines: [{ code: "1300", debit: total, profitObjectId: pobj }, { code: "2050", credit: total, profitObjectId: pobj, memo: "received not invoiced" }] });
  }
  // Closed when every line is in.
  const after = await openPurchaseOrders(c, entityId);
  const left = after.filter((x) => x.po_id === po[0].id && Number(x.received) < Number(x.ordered));
  if (!left.length) await c.query(`update purchase_order set status = 'received' where id = $1 and entity_id = $2`, [po[0].id, entityId]);
  if (e.appointmentId) await c.query(`update inv_receiving_appt set status = 'received' where id = $1 and entity_id = $2`, [e.appointmentId, entityId]);
  // Other back orders for what just arrived can be covered now.
  const backorders = await recheckBackorders(c, entityId, { productIds: [...received] });
  // Goods whose product or category needs deluxing, touch-up or assembly go on the warehouse's prep queue.
  const wms = await import("./wms.ts");
  const prep = await wms.queueForReceipt(c, scope, gr.id, e.locationId);
  return { receiptId: gr.id, poNumber: po[0].number, lines: out, poStatus: left.length ? "open" : "received", valueMinor: total, backordersReserved: backorders.reserved,
    prepQueued: prep.queued };
}

/** The customer order lines waiting on a PO line: purchasing's link table, else the PO line's agreement_ref naming the order. */
async function salesLinesFor(c: Client, entityId: string, poLineId: string, agreementRef: string | null, productId: string) {
  type SL = { id: string; qty: string; number: string };
  if (await hasRelation(c, "po_line_sales_line")) {
    const r = await q<SL>(c, `select l.id, l.qty, so.number from po_line_sales_line k join sales_order_line l on l.id = k.sales_order_line_id
        join sales_order so on so.id = l.sales_order_id
       where k.entity_id = $1 and k.purchase_order_line_id = $2 and k.active and l.line_status = 'on_order' and l.product_id = $3
       order by so.ordered_at, l.seq for update of l`, [entityId, poLineId, productId]);
    if (r.length) return r;
  }
  if (!agreementRef) return [];
  return q<SL>(c, `select l.id, l.qty, so.number from sales_order_line l join sales_order so on so.id = l.sales_order_id
     where l.entity_id = $1 and so.number = $2 and l.product_id = $3 and l.line_status = 'on_order' order by l.seq for update of l`,
    [entityId, agreementRef.trim(), productId]);
}

/**
 * Re-check back orders: stock order lines waiting on_order that can be
 * covered now. A line takes stock where it ships from; a delivery line may
 * take it from a warehouse instead. Lines whose own goods are on a transfer
 * are left alone. Returns how many lines were reserved.
 */
export async function recheckBackorders(c: Client, entityId: string, f: { productIds?: string[]; orderIds?: string[] } = {}): Promise<{ reserved: number; lines: string[] }> {
  const posLine = await hasRelation(c, "pos_line");
  const lines = await q<{ id: string; product_id: string; qty: string; fulfil_from_id: string | null; how: string }>(c, `
    select l.id, l.product_id, l.qty, l.fulfil_from_id,
           ${posLine ? "coalesce((select pl.fulfillment from pos_line pl where pl.sales_order_line_id = l.id and pl.entity_id = l.entity_id), so.fulfillment)" : "so.fulfillment"} how
      from sales_order_line l join sales_order so on so.id = l.sales_order_id join product p on p.id = l.product_id
     where l.entity_id = $1 and l.line_status = 'on_order' and l.qty > 0 and p.kind = 'stock' and so.status in ('open','fulfilling')
       and ($2::uuid[] is null or l.product_id = any($2)) and ($3::uuid[] is null or l.sales_order_id = any($3))
       and not exists (select 1 from inv_piece x where x.entity_id = l.entity_id and x.sales_order_line_id = l.id and x.status = 'in_transit')
     order by so.ordered_at, l.seq for update of l`, [entityId, f.productIds ?? null, f.orderIds ?? null]);
  const done: string[] = [];
  for (const l of lines) {
    const qty = Number(l.qty);
    const where = [l.fulfil_from_id].filter(Boolean) as string[];
    if (["delivery", "ship"].includes(l.how)) {
      const wh = await q<{ id: string }>(c, `select id from location where entity_id = $1 and kind = 'warehouse' and status = 'active' order by name`, [entityId]);
      where.push(...wh.map((x) => x.id).filter((x) => x !== l.fulfil_from_id));
    }
    for (const loc of where) {
      const lv = await level(c, entityId, l.product_id, loc);
      if (lv.available < qty) continue;
      await bump(c, entityId, l.product_id, loc, { reserved: qty });
      await c.query(`update sales_order_line set line_status = 'reserved', fulfil_from_id = $3 where id = $1 and entity_id = $2`, [l.id, entityId, loc]);
      done.push(l.id);
      break;
    }
  }
  return { reserved: done.length, lines: done };
}

/** Book a delivery slot at a dock. Refused when the day would go over the dock's piece limit. */
export async function bookReceiving(c: Client, scope: Scope, e: { locationId: string; day: string; window?: string; vendorId?: string | null;
  purchaseOrderId?: string | null; carrier?: string; expectedPieces: number; note?: string }) {
  need(/^\d{4}-\d{2}-\d{2}$/.test(e.day), "pick a day");
  need(e.day >= today(), "that day has passed");
  need(Number.isInteger(e.expectedPieces) && e.expectedPieces > 0, "how many pieces are coming?");
  const loc = await q(c, `select id from location where id = $1 and entity_id = $2`, [e.locationId, scope.entityId]);
  need(loc.length, "no such location");
  const lim = await q<{ daily_piece_limit: number }>(c, `select daily_piece_limit from inv_dock where entity_id = $1 and location_id = $2`, [scope.entityId, e.locationId]);
  const limit = lim[0]?.daily_piece_limit ?? 200;
  // Lock the location so two bookings for the same day cannot both squeeze in.
  await q(c, `select id from location where id = $1 and entity_id = $2 for update`, [e.locationId, scope.entityId]);
  const booked = await q<{ s: string }>(c, `select coalesce(sum(expected_pieces),0) s from inv_receiving_appt
     where entity_id = $1 and location_id = $2 and day = $3 and status in ('booked','arrived')`, [scope.entityId, e.locationId, e.day]);
  const have = Number(booked[0].s);
  need(have + e.expectedPieces <= limit, `that day already has ${have} of ${limit} pieces booked; ${e.expectedPieces} more will not fit. Pick another day`);
  if (e.purchaseOrderId) {
    const po = await q(c, `select id from purchase_order where id = $1 and entity_id = $2`, [e.purchaseOrderId, scope.entityId]);
    need(po.length, "no such purchase order");
  }
  return one<{ id: string }>(c, `insert into inv_receiving_appt (entity_id, location_id, day, window_label, vendor_id, purchase_order_id, carrier,
      expected_pieces, note, booked_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [scope.entityId, e.locationId, e.day, e.window ?? null, e.vendorId ?? null, e.purchaseOrderId ?? null, e.carrier ?? null,
     e.expectedPieces, e.note ?? null, scope.actor.id || null]);
}

// ================================================================ transfers

export type TransferLineIn = { productId?: string; qty?: number; labels?: string[]; salesOrderLineId?: string | null };

/**
 * Draft a transfer. A line is a product and a quantity (optionally the exact
 * labels), or a customer's order line: its reserved goods move with it, still
 * theirs -- a special order received at the DC going to the store it is
 * picked up from.
 */
export async function createTransfer(c: Client, scope: Scope, e: { fromId: string; toId: string; lines: TransferLineIn[]; note?: string }) {
  need(e.fromId !== e.toId, "a transfer goes between two different locations");
  const locs = await q<{ id: string }>(c, `select id from location where entity_id = $1 and id = any($2) and status = 'active' and kind not in ('in_transit','dropship')`, [scope.entityId, [e.fromId, e.toId]]);
  // To a store of another of the client's companies: the group module pairs a sale here with a bill there when it ships.
  const toEntity = locs.length === 1 && locs[0].id === e.fromId ? await siblingOf(c, scope.entityId, e.toId) : null;
  need(locs.length === 2 || toEntity, "pick two of this company's locations");
  if (toEntity) await groupRole(c, scope, toEntity, "a transfer to another of the client's companies");
  need(e.lines?.length, "a transfer needs at least one line");
  const number = await nextNo(c, scope.entityId, "transfer", "TR-");
  const t = await one<{ id: string }>(c, `insert into inv_transfer (entity_id, number, from_location_id, to_location_id, note, created_by, to_entity_id)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`, [scope.entityId, number, e.fromId, e.toId, e.note ?? null, scope.actor.id || null, toEntity]);
  const addCustomerLine = async (lineId: string) => {
      need(!toEntity, "a customer's order moves only between the selling company's own locations");
      const sl = await lineOf(c, scope.entityId, lineId);
      need(sl.product_id, "that order line has no product to move");
      need(["reserved", "ready"].includes(sl.line_status), `${sl.number}'s line is ${sl.line_status.replace("_", " ")}; only reserved goods move for a customer`);
      need(sl.fulfil_from_id === e.fromId, `${sl.number}'s goods are not reserved at the origin`);
      const units = (await q<{ unit_id: string }>(c, `select distinct unit_id from inv_piece where entity_id = $1 and sales_order_line_id = $2 and status = 'reserved' and location_id = $3`,
        [scope.entityId, sl.id, e.fromId])).map((x) => x.unit_id);
      const p = await productOf(c, scope.entityId, sl.product_id!);
      if (p.serialized) need(units.length === Number(sl.qty), `${sl.number}: ${units.length} of ${Number(sl.qty)} pieces are allocated; allocate them before moving the order`);
      await c.query(`insert into inv_transfer_line (entity_id, transfer_id, product_id, qty, unit_ids, cost_minor, sales_order_line_id) values ($1,$2,$3,$4,$5,0,$6)`,
        [scope.entityId, t.id, p.id, sl.qty, units, sl.id]);
      return Number(sl.qty);
  };
  for (const l of e.lines) {
    if (l.salesOrderLineId) { await addCustomerLine(l.salesOrderLineId); continue; }
    const p = await productOf(c, scope.entityId, l.productId ?? "");
    let want = Number(l.qty);
    need(want > 0, "transfer a positive quantity");
    need(!p.serialized || Number.isInteger(want), `${p.name} moves in whole units`);
    let units: string[] = [];
    if (l.labels?.length) {
      need(p.serialized, `${p.name} is not tracked by label`);
      const r = await q<{ unit_id: string; line_id: string | null; status: string; number: string | null }>(c, `
        select distinct pc.unit_id, pc.sales_order_line_id line_id, pc.status, so.number from inv_piece pc
          left join sales_order_line sl on sl.id = pc.sales_order_line_id left join sales_order so on so.id = sl.sales_order_id
         where pc.entity_id = $1 and pc.product_id = $2 and upper(pc.label) = any($3)`, [scope.entityId, p.id, l.labels.map((x) => x.toUpperCase())]);
      need(new Set(r.map((x) => x.unit_id)).size === want, `the labels name ${new Set(r.map((x) => x.unit_id)).size} unit${r.length === 1 ? "" : "s"} of ${p.name}, not ${want}`);
      // Pieces reserved for a customer travel as that customer's order line, reservation and all.
      const byLine = new Map<string, string[]>();
      for (const x of r) if (x.line_id && ["reserved", "picked"].includes(x.status)) byLine.set(x.line_id, [...(byLine.get(x.line_id) ?? []), x.unit_id]);
      for (const [lineId, us] of byLine) {
        const sl = await lineOf(c, scope.entityId, lineId);
        need(us.length === Number(sl.qty), `those labels are part of ${sl.number}'s order; move its whole line`);
        want -= await addCustomerLine(lineId);
      }
      units = r.filter((x) => !(x.line_id && byLine.has(x.line_id))).map((x) => x.unit_id);
    } else {
      // Not enough free stock here? A customer's goods reserved here for pickup at the destination are what is moving.
      const free = (await level(c, scope.entityId, p.id, e.fromId)).available;
      if (free < want && !toEntity) {
        const cust = await q<{ id: string; qty: string }>(c, `
          select l.id, l.qty from sales_order_line l join sales_order so on so.id = l.sales_order_id
            left join pos_line pl on pl.sales_order_line_id = l.id and pl.entity_id = l.entity_id
           where l.entity_id = $1 and l.product_id = $2 and l.fulfil_from_id = $3 and so.location_id = $4 and l.line_status in ('reserved','ready')
             and coalesce(pl.fulfillment, so.fulfillment) in ('pickup','carry') order by so.ordered_at, l.seq`, [scope.entityId, p.id, e.fromId, e.toId]);
        for (const sl of cust) {
          if (want - Math.max(free, 0) <= 0) break;
          if (Number(sl.qty) > want) continue;
          want -= await addCustomerLine(sl.id);
        }
      }
    }
    if (want > 0) await c.query(`insert into inv_transfer_line (entity_id, transfer_id, product_id, qty, unit_ids, cost_minor) values ($1,$2,$3,$4,$5,0)`,
      [scope.entityId, t.id, p.id, want, units]);
  }
  return { id: t.id, number };
}

/**
 * Ship: stock leaves the origin at its average cost and is on the road (its
 * pieces sit at the company's store-to-store in-transit location). With
 * 1310 kept, Dr 1310 Cr 1300; otherwise the value stays in 1300. When the
 * company has two-step transfers off, it lands at the destination at once.
 */
export async function shipTransfer(c: Client, scope: Scope, id: string, opts: { expectedOn?: string | null } = {}) {
  const t = await transferOf(c, scope.entityId, id);
  need(t.status === "draft", `transfer ${t.number} is ${t.status.replace("_", " ")}, so it cannot ship`);
  if (opts.expectedOn) need(/^\d{4}-\d{2}-\d{2}$/.test(opts.expectedOn) && opts.expectedOn >= today(), "the arrival day is a day from today on");
  // To another of the client's companies: the goods leave this company's books (sold to the sibling at transfer price).
  const across = !!t.to_entity_id;
  if (across) await groupRole(c, scope, t.to_entity_id!, "shipping to another of the client's companies");
  const outStatus = across ? "delivered" : "in_transit";
  const ts = await transferSettings(c, scope.entityId);
  const road = across ? undefined : await virtualLocation(c, scope.entityId, "store");
  const gl: "1300" | "1310" = ts.twoStep ? ts.transitGl : "1300";
  const lines = await q<{ id: string; product_id: string; qty: string; unit_ids: string[]; sales_order_line_id: string | null }>(c,
    `select id, product_id, qty, unit_ids, sales_order_line_id from inv_transfer_line where entity_id = $1 and transfer_id = $2`, [scope.entityId, id]);
  let value = 0n;
  const by = scope.actor.id || null;
  for (const l of lines) {
    const p = await productOf(c, scope.entityId, l.product_id);
    const qty = Number(l.qty);
    if (l.sales_order_line_id) {
      // A customer's goods: they stay theirs. The reservation leaves with them; the line waits on the transfer.
      const sl = await lineOf(c, scope.entityId, l.sales_order_line_id);
      need(["reserved", "ready"].includes(sl.line_status) && sl.fulfil_from_id === t.from_location_id, `${sl.number}'s goods are no longer reserved at the origin`);
      const lineValue = await costOut(c, scope.entityId, p.id, qty, "none");
      if (p.serialized) {
        for (const u of l.unit_ids) {
          const pcs = await piecesOfUnit(c, scope.entityId, u);
          need(pcs.every((x) => ["reserved", "picked"].includes(x.status) && x.sales_order_line_id === sl.id && x.location_id === t.from_location_id),
            `${pcs[0]?.label ?? "a piece"} is no longer this order's at the origin`);
          await transitionUnit(c, scope.entityId, by, u, "in_transit", { kind: "transfer_out", refType: "transfer", refId: id, transferId: id, toLocation: road });
        }
        await bump(c, scope.entityId, p.id, t.from_location_id, { reserved: -qty });
      } else {
        await bump(c, scope.entityId, p.id, t.from_location_id, { onHand: -qty, reserved: -qty });
        await binStockTake(c, scope.entityId, p.id, t.from_location_id, qty);
        await logMove(c, scope.entityId, { kind: "transfer_out", productId: p.id, qty, fromLoc: t.from_location_id, toLoc: road, toStatus: "in_transit", refType: "transfer", refId: id, by });
      }
      await c.query(`update sales_order_line set line_status = 'on_order' where id = $1 and entity_id = $2`, [sl.id, scope.entityId]);
      await c.query(`update inv_transfer_line set value_minor = $3, cost_minor = $4 where id = $1 and entity_id = $2`, [l.id, scope.entityId, lineValue.toString(),
        (qty ? BigInt(Math.round(Number(lineValue) / qty)) : 0n).toString()]);
      value += lineValue;
      continue;
    }
    const lv = await level(c, scope.entityId, p.id, t.from_location_id);
    need(lv.available >= qty, `${p.name}: ${lv.available} available at the origin, ${qty} on the transfer`);
    const lineValue = await costOut(c, scope.entityId, p.id, qty, across ? "carry_out" : "none", id);
    if (p.serialized) {
      let units = l.unit_ids;
      if (units.length) {
        for (const u of units) {
          const pcs = await piecesOfUnit(c, scope.entityId, u);
          need(pcs.every((x) => x.status === "in_stock" && x.location_id === t.from_location_id && !x.sales_order_line_id),
            `${pcs[0]?.label ?? "a piece"} is not free stock at the origin`);
        }
      } else {
        units = await freeUnits(c, scope.entityId, p.id, t.from_location_id, qty);
        need(units.length === qty, `${p.name}: only ${units.length} free labelled unit${units.length === 1 ? "" : "s"} at the origin`);
        await c.query(`update inv_transfer_line set unit_ids = $3 where id = $1 and entity_id = $2`, [l.id, scope.entityId, units]);
      }
      for (const u of units) await transitionUnit(c, scope.entityId, by, u, outStatus,
        { kind: "transfer_out", refType: "transfer", refId: id, transferId: id, toLocation: road });
    } else {
      await bump(c, scope.entityId, p.id, t.from_location_id, { onHand: -qty });
      await binStockTake(c, scope.entityId, p.id, t.from_location_id, qty);
      await logMove(c, scope.entityId, { kind: "transfer_out", productId: p.id, qty, fromLoc: t.from_location_id, toLoc: road ?? null, toStatus: outStatus,
        refType: "transfer", refId: id, by: scope.actor.id });
    }
    await c.query(`update inv_transfer_line set value_minor = $3, cost_minor = $4 where id = $1 and entity_id = $2`, [l.id, scope.entityId, lineValue.toString(),
      (qty ? BigInt(Math.round(Number(lineValue) / qty)) : 0n).toString()]);
    value += lineValue;
  }
  if (across) {
    // Shipped and landed in one step: the sibling holds the goods from here, at transfer price, on a bill from this company.
    await c.query(`update inv_transfer set status = 'received', shipped_by = $3, shipped_at = now(), received_by = $3, received_at = now()
                    where id = $1 and entity_id = $2`, [id, scope.entityId, by]);
    const group = await import("./group.ts");
    const docs = await group.completeAcross(c, scope, id);
    return { number: t.number, valueMinor: value, ...docs };
  }
  const arrive = opts.expectedOn || addDaysIso(today(), ts.transitDays);
  await c.query(`update inv_transfer set status = 'in_transit', shipped_by = $3, shipped_at = now(), transit_gl = $4, expected_on = $5 where id = $1 and entity_id = $2`,
    [id, scope.entityId, by, gl, arrive]);
  if (value > 0n && gl === "1310") {
    const po = await profitObjectFor(c, scope.entityId, t.from_location_id);
    await post(c, scope, { date: today(), sourceType: "inventory", sourceId: id, description: `Transfer ${t.number} shipped`,
      lines: [{ code: "1310", debit: value, profitObjectId: po }, { code: "1300", credit: value, profitObjectId: po }] });
  }
  if (!ts.twoStep) {
    // One step: shipped and landed together.
    await receiveTransfer(c, scope, id);
    return { number: t.number, valueMinor: value, transitGl: gl, expectedOn: null, received: true };
  }
  return { number: t.number, valueMinor: value, transitGl: gl, expectedOn: arrive, received: false };
}

const addDaysIso = (iso: string, n: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * Receive: stock lands at the destination at the value that left. Shipped
 * through 1310, the receipt reverses it (Dr 1300 Cr 1310); left in 1300, it
 * moves the value from the origin's P&L column to the destination's. A
 * customer's goods arrive reserved to them.
 */
export async function receiveTransfer(c: Client, scope: Scope, id: string, e: { binId?: string | null } = {}) {
  const t = await transferOf(c, scope.entityId, id);
  need(t.status === "in_transit", `transfer ${t.number} is ${t.status.replace("_", " ")}, not in transit`);
  const bin = await binAt(c, scope.entityId, e.binId, t.to_location_id);
  const lines = await q<{ product_id: string; qty: string; unit_ids: string[]; value_minor: string; sales_order_line_id: string | null }>(c,
    `select product_id, qty, unit_ids, value_minor, sales_order_line_id from inv_transfer_line where entity_id = $1 and transfer_id = $2`, [scope.entityId, id]);
  let value = 0n;
  const by = scope.actor.id || null;
  const products = new Set<string>();
  for (const l of lines) {
    const qty = Number(l.qty);
    await costIn(c, scope.entityId, l.product_id, qty, BigInt(l.value_minor));
    // Still the customer's? A line cancelled meanwhile lands as free stock.
    let forLine: string | null = null;
    if (l.sales_order_line_id) {
      const sl = await lineOf(c, scope.entityId, l.sales_order_line_id);
      if (sl.line_status === "on_order") forLine = sl.id;
    }
    if (l.unit_ids.length) {
      for (const u of l.unit_ids) await transitionUnit(c, scope.entityId, by, u, forLine ? "reserved" : "in_stock",
        { kind: "transfer_in", toLocation: t.to_location_id, toBin: bin, refType: "transfer", refId: id, transferId: null, salesOrderLineId: forLine });
    } else {
      await bump(c, scope.entityId, l.product_id, t.to_location_id, { onHand: qty });
      if (bin) await binStockAdd(c, scope.entityId, bin, l.product_id, qty);
      await logMove(c, scope.entityId, { kind: "transfer_in", productId: l.product_id, qty, toLoc: t.to_location_id, toBin: bin, fromStatus: "in_transit",
        toStatus: forLine ? "reserved" : "in_stock", refType: "transfer", refId: id, by });
    }
    if (forLine) {
      await bump(c, scope.entityId, l.product_id, t.to_location_id, { reserved: qty });
      await c.query(`update sales_order_line set line_status = 'reserved', fulfil_from_id = $3 where id = $1 and entity_id = $2`, [forLine, scope.entityId, t.to_location_id]);
    } else products.add(l.product_id);
    value += BigInt(l.value_minor);
  }
  await c.query(`update inv_transfer set status = 'received', received_by = $3, received_at = now() where id = $1 and entity_id = $2`, [id, scope.entityId, by]);
  if (value > 0n) {
    const po = await profitObjectFor(c, scope.entityId, t.to_location_id);
    // Shipped before the account was chosen per transfer: it went through 1310.
    if ((t.transit_gl ?? "1310") === "1310") {
      await post(c, scope, { date: today(), sourceType: "inventory", sourceId: id, description: `Transfer ${t.number} received`,
        lines: [{ code: "1300", debit: value, profitObjectId: po }, { code: "1310", credit: value, profitObjectId: po }] });
    } else {
      const from = await profitObjectFor(c, scope.entityId, t.from_location_id);
      if (from !== po) await post(c, scope, { date: today(), sourceType: "inventory", sourceId: id, description: `Transfer ${t.number} received`,
        lines: [{ code: "1300", debit: value, profitObjectId: po }, { code: "1300", credit: value, profitObjectId: from }] });
    }
  }
  if (products.size) await recheckBackorders(c, scope.entityId, { productIds: [...products] });
  return { number: t.number, valueMinor: value };
}

export async function cancelTransfer(c: Client, scope: Scope, id: string) {
  const t = await transferOf(c, scope.entityId, id);
  need(t.status === "draft", "only a transfer that has not shipped can be cancelled");
  await c.query(`update inv_transfer set status = 'cancelled' where id = $1 and entity_id = $2`, [id, scope.entityId]);
}

async function transferOf(c: Client, entityId: string, id: string) {
  const r = await q<{ id: string; number: string; status: string; from_location_id: string; to_location_id: string; to_entity_id: string | null; transit_gl: string | null }>(c,
    `select id, number, status, from_location_id, to_location_id, to_entity_id, transit_gl from inv_transfer where id = $1 and entity_id = $2 for update`, [id, entityId]);
  need(r.length, "no such transfer");
  return r[0];
}

/**
 * Stock to a sibling makes a sales invoice here and a bill there, so it is for the owner, or a
 * controller in both companies -- not every warehouse hand (group.requireGroupRole).
 */
async function groupRole(c: Client, scope: Scope, toEntity: string, doing: string) {
  const g = await import("./group.ts");
  try { await g.requireGroupRole(c, scope.tenantId, scope.actor.id || null, [scope.entityId, toEntity], doing); }
  catch (e) { if (e instanceof g.GroupError) throw new InventoryError(e.message); throw e; }
}

/** The company of a location that belongs to another open company of the same client, else null. */
async function siblingOf(c: Client, entityId: string, locationId: string): Promise<string | null> {
  const r = await q<{ entity_id: string }>(c, `select l.entity_id from location l join entity e on e.id = l.entity_id join entity me on me.id = $1
     where l.id = $2 and l.status = 'active' and e.tenant_id = me.tenant_id and e.id <> me.id and e.status = 'active'
     /* unscoped: a location of a sister company of this one */`, [entityId, locationId]);
  return r[0]?.entity_id ?? null;
}

/**
 * The receiving end of a transfer from another of the client's companies:
 * the goods land here at the transfer price (the group module posts the bill,
 * Dr 1300 Cr 2190). Lines name this company's own products. Recorded as a
 * received transfer here too, so the history shows where the stock came from.
 */
export async function landAcross(c: Client, scope: Scope, e: { fromEntityId: string; fromLocationId: string; toLocationId: string; senderNumber: string;
  lines: { productId: string; qty: number; valueMinor: bigint }[]; binId?: string | null }): Promise<{ transferId: string; number: string; valueMinor: bigint }> {
  const loc = await q<{ id: string }>(c, `select id from location where id = $1 and entity_id = $2 and status = 'active'`, [e.toLocationId, scope.entityId]);
  need(loc.length, "no such location");
  const bin = await binAt(c, scope.entityId, e.binId, e.toLocationId);
  const by = scope.actor.id || null;
  const number = await nextNo(c, scope.entityId, "transfer", "TR-");
  const t = await one<{ id: string }>(c, `insert into inv_transfer (entity_id, number, from_location_id, to_location_id, status, note, created_by,
      shipped_by, shipped_at, received_by, received_at, from_entity_id)
    values ($1,$2,$3,$4,'received',$5,$6,$6,now(),$6,now(),$7) returning id`,
    [scope.entityId, number, e.fromLocationId, e.toLocationId, `from ${e.senderNumber}`, by, e.fromEntityId]);
  let value = 0n;
  const products = new Set<string>();
  for (const l of e.lines) {
    const p = await productOf(c, scope.entityId, l.productId);
    const qty = Number(l.qty);
    need(qty > 0, "transfer a positive quantity");
    await c.query(`insert into inv_transfer_line (entity_id, transfer_id, product_id, qty, cost_minor, value_minor) values ($1,$2,$3,$4,$5,$6)`,
      [scope.entityId, t.id, p.id, qty, (BigInt(Math.round(Number(l.valueMinor) / qty))).toString(), l.valueMinor.toString()]);
    await costIn(c, scope.entityId, p.id, qty, l.valueMinor);
    if (p.serialized) {
      await createUnits(c, scope.entityId, p, { locationId: e.toLocationId, binId: bin, qty, status: "in_stock", costMinor: BigInt(Math.round(Number(l.valueMinor) / qty)),
        kind: "transfer_in", refType: "transfer", refId: t.id, by, reason: `from ${e.senderNumber}` });
    } else {
      if (bin) await binStockAdd(c, scope.entityId, bin, p.id, qty);
      await logMove(c, scope.entityId, { kind: "transfer_in", productId: p.id, qty, toLoc: e.toLocationId, toBin: bin, toStatus: "in_stock",
        refType: "transfer", refId: t.id, reason: `from ${e.senderNumber}`, by });
    }
    await bump(c, scope.entityId, p.id, e.toLocationId, { onHand: qty });
    products.add(p.id);
    value += l.valueMinor;
  }
  if (products.size) await recheckBackorders(c, scope.entityId, { productIds: [...products] });
  return { transferId: t.id, number, valueMinor: value };
}

// =============================================================== allocation

async function lineOf(c: Client, entityId: string, lineId: string) {
  const r = await q<{ id: string; sales_order_id: string; product_id: string | null; qty: string; fulfil_from_id: string | null; line_status: string; number: string }>(c,
    `select l.id, l.sales_order_id, l.product_id, l.qty, l.fulfil_from_id, l.line_status, so.number
       from sales_order_line l join sales_order so on so.id = l.sales_order_id
      where l.id = $1 and l.entity_id = $2`, [lineId, entityId]);
  need(r.length, "no such order line");
  return r[0];
}

async function allocatedUnits(c: Client, entityId: string, lineId: string): Promise<number> {
  const r = await q<{ n: string }>(c, `select count(distinct unit_id) n from inv_piece
    where entity_id = $1 and sales_order_line_id = $2 and status in ('reserved','picked','loaded')`, [entityId, lineId]);
  return Number(r[0].n);
}

/** Put a specific unit (by any of its labels) on a customer order line. */
export async function allocate(c: Client, scope: Scope, label: string, lineId: string) {
  const pc = await pieceByLabel(c, scope.entityId, label);
  const l = await lineOf(c, scope.entityId, lineId);
  need(l.product_id === pc.product_id, "that piece is a different product from the order line");
  need(["reserved", "ready"].includes(l.line_status), `the line is ${l.line_status.replace("_", " ")}; only a reserved line takes pieces`);
  need(l.fulfil_from_id === pc.location_id, "that piece is at a different location from where the line ships");
  const pcs = await piecesOfUnit(c, scope.entityId, pc.unit_id);
  need(pcs.every((x) => (x.status === "in_stock" || x.status === "as_is") && !x.sales_order_line_id), `${label} is ${pc.status.replace("_", " ")}, not free stock`);
  need(await allocatedUnits(c, scope.entityId, lineId) < Number(l.qty), "that line already has all its pieces");
  await transitionUnit(c, scope.entityId, scope.actor.id || null, pc.unit_id, "reserved", { kind: "allocate", refType: "order_line", refId: lineId, salesOrderLineId: lineId });
  return { order: l.number };
}

export async function unallocate(c: Client, scope: Scope, label: string) {
  const pc = await pieceByLabel(c, scope.entityId, label);
  need(["reserved", "picked", "loaded"].includes(pc.status) && pc.sales_order_line_id, `${label} is not on an order`);
  await transitionUnit(c, scope.entityId, scope.actor.id || null, pc.unit_id, "in_stock", { kind: "unallocate", refType: "order_line", refId: pc.sales_order_line_id, salesOrderLineId: null });
}

export type PickLine = { orderId: string; orderNumber: string; customer: string | null; lineId: string; sku: string; description: string;
  qty: number; locationId: string | null; location: string | null; serialized: boolean;
  pieces: { id: string; label: string; carton: string; bin: string | null; status: string; cubicFt: number; weightLb: number }[];
  bins: { bin: string; qty: number }[]; short: number; cubicFt: number; weightLb: number;
  prep: { number: string; type: string; status: string; label: string | null }[] };

/**
 * The pick list for one or more orders: every open stock line, the exact
 * pieces to pull (allocating the oldest free units to lines that have none
 * yet) and where they sit. Fleet calls this to load a truck; a line that
 * cannot be covered shows its shortfall rather than failing the list.
 */
export async function pickListFor(c: Client, entityId: string, orderIds: string[]):
  Promise<{ lines: PickLine[]; pieces: number; cubicFt: number; weightLb: number; short: number; prepPending: number }> {
  if (!orderIds.length) return { lines: [], pieces: 0, cubicFt: 0, weightLb: 0, short: 0, prepPending: 0 };
  const rows = await q<{ order_id: string; number: string; customer: string | null; line_id: string; sku: string; description: string; qty: string;
    fulfil_from_id: string | null; location: string | null; product_id: string; serialized: boolean; cubic_ft: string | null; weight_lb: string | null }>(c, `
    select so.id order_id, so.number, cu.name customer, l.id line_id, l.sku, l.description, l.qty, l.fulfil_from_id, lo.name location,
           p.id product_id, p.serialized, p.cubic_ft, p.weight_lb
      from sales_order_line l join sales_order so on so.id = l.sales_order_id
      join product p on p.id = l.product_id
      left join customer cu on cu.id = so.customer_id
      left join location lo on lo.id = l.fulfil_from_id
     where l.entity_id = $1 and l.sales_order_id = any($2) and l.line_status in ('reserved','ready') and l.qty > 0
       and p.kind in ('stock','configurable','special_order')
     order by so.number, l.seq`, [entityId, orderIds]);
  const out: PickLine[] = [];
  let pieces = 0, cube = 0, weight = 0, short = 0;
  for (const r of rows) {
    const qty = Number(r.qty);
    const line: PickLine = { orderId: r.order_id, orderNumber: r.number, customer: r.customer, lineId: r.line_id, sku: r.sku, description: r.description,
      qty, locationId: r.fulfil_from_id, location: r.location, serialized: r.serialized, pieces: [], bins: [], short: 0, cubicFt: 0, weightLb: 0, prep: [] };
    if (r.serialized && r.fulfil_from_id) {
      const have = await allocatedUnits(c, entityId, r.line_id);
      if (have < qty) {
        const free = await freeUnits(c, entityId, r.product_id, r.fulfil_from_id, qty - have);
        for (const u of free) await transitionUnit(c, entityId, null, u, "reserved", { kind: "allocate", refType: "order_line", refId: r.line_id, salesOrderLineId: r.line_id });
        line.short = qty - have - free.length;
      }
      const pcs = await q<{ id: string; label: string; carton_seq: number; carton_count: number; carton_label: string | null; bin: string | null; status: string;
        cubic_ft: string | null; weight_lb: string | null }>(c, `
        select pc.id, pc.label, pc.carton_seq, pc.carton_count, pc.carton_label, b.code bin, pc.status, pc.cubic_ft, pc.weight_lb
          from inv_piece pc left join inv_bin b on b.id = pc.bin_id
         where pc.entity_id = $1 and pc.sales_order_line_id = $2 and pc.status in ('reserved','picked','loaded')
         order by b.code nulls last, pc.unit_id, pc.carton_seq`, [entityId, r.line_id]);
      line.pieces = pcs.map((x) => ({ id: x.id, label: x.label, carton: x.carton_count > 1 ? `${x.carton_seq} of ${x.carton_count}${x.carton_label ? ` · ${x.carton_label}` : ""}` : "1 of 1",
        bin: x.bin, status: x.status, cubicFt: Number(x.cubic_ft ?? 0), weightLb: Number(x.weight_lb ?? 0) }));
      line.cubicFt = line.pieces.reduce((a, x) => a + x.cubicFt, 0);
      line.weightLb = line.pieces.reduce((a, x) => a + x.weightLb, 0);
      pieces += line.pieces.length;
    } else {
      if (r.fulfil_from_id) {
        const bins = await q<{ code: string; qty: string }>(c, `select b.code, s.qty from inv_bin_stock s join inv_bin b on b.id = s.bin_id
          where s.entity_id = $1 and s.product_id = $2 and b.location_id = $3 and s.qty > 0 order by b.code`, [entityId, r.product_id, r.fulfil_from_id]);
        line.bins = bins.map((b) => ({ bin: b.code, qty: Number(b.qty) }));
      }
      line.cubicFt = qty * Number(r.cubic_ft ?? 0);
      line.weightLb = qty * Number(r.weight_lb ?? 0);
      pieces += qty;
    }
    cube += line.cubicFt; weight += line.weightLb; short += line.short;
    out.push(line);
  }
  // Prep not finished on what is about to go out (deluxing, touch-up, assembly).
  const wms = await import("./wms.ts");
  const open = await wms.prepOpenForLines(c, entityId, out.map((l) => l.lineId));
  for (const l of out) l.prep = open.get(l.lineId) ?? [];
  const prepPending = out.reduce((a, l) => a + l.prep.length, 0);
  return { lines: out, pieces, cubicFt: Math.round(cube * 100) / 100, weightLb: Math.round(weight * 100) / 100, short, prepPending };
}

// ============================================================ scanning

export type PieceView = PieceRow & { sku: string; name: string; location: string; bin: string | null; carton_label: string | null;
  order_number: string | null; order_id: string | null; as_is_price_minor: string | null };

async function pieceByLabel(c: Client, entityId: string, label: string): Promise<PieceRow> {
  const r = await q<PieceRow>(c, `select id, label, product_id, unit_id, carton_seq, carton_count, location_id, bin_id, status,
      sales_order_line_id, cost_minor, transfer_id from inv_piece where entity_id = $1 and upper(label) = upper($2)`, [entityId, String(label ?? "").trim()]);
  need(r.length, `no piece is labelled ${label}`);
  return r[0];
}

/** What a person can do next with a piece, by its status. */
export const NEXT: Record<string, string[]> = {
  in_stock: ["move", "allocate", "damage", "as_is", "transfer"],
  reserved: ["pick", "move", "unallocate", "damage"],
  picked: ["load", "unpick", "damage"],
  loaded: ["unload", "damage"],
  delivered: [],
  damaged: ["repair", "claim", "restore", "as_is", "write_off"],
  in_repair: ["restore", "as_is", "write_off"],
  vendor_claim: ["restore", "write_off", "vendor_return"],
  as_is: ["move", "allocate", "clear_as_is", "damage"],
  returned: ["restore", "damage"],
  in_transit: ["receive_transfer"],
  written_off: [],
  returned_to_vendor: [],
};

export async function scan(c: Client, entityId: string, label: string) {
  const r = await q<PieceView>(c, `
    select pc.id, pc.label, pc.product_id, pc.unit_id, pc.carton_seq, pc.carton_count, pc.carton_label, pc.location_id, pc.bin_id, pc.status,
           pc.sales_order_line_id, pc.cost_minor, pc.transfer_id, pc.as_is_price_minor,
           p.sku, p.name, lo.name location, b.code bin, so.number order_number, so.id order_id
      from inv_piece pc join product p on p.id = pc.product_id join location lo on lo.id = pc.location_id
      left join inv_bin b on b.id = pc.bin_id
      left join sales_order_line l on l.id = pc.sales_order_line_id
      left join sales_order so on so.id = l.sales_order_id
     where pc.entity_id = $1 and upper(pc.label) = upper($2)`, [entityId, String(label ?? "").trim()]);
  need(r.length, `no piece is labelled ${label}`);
  const pc = r[0];
  const unit = await q<{ label: string; carton_seq: number; status: string; bin: string | null }>(c, `
    select pc.label, pc.carton_seq, pc.status, b.code bin from inv_piece pc left join inv_bin b on b.id = pc.bin_id
     where pc.entity_id = $1 and pc.unit_id = $2 order by pc.carton_seq`, [entityId, pc.unit_id]);
  const history = await q<{ at: string; kind: string; from_status: string | null; to_status: string | null; from_bin: string | null; to_bin: string | null;
    from_loc: string | null; to_loc: string | null; reason: string | null; by_name: string | null }>(c, `
    select m.at, m.kind, m.from_status, m.to_status, fb.code from_bin, tb.code to_bin, fl.name from_loc, tl.name to_loc, m.reason, u.name by_name
      from inv_move m left join inv_bin fb on fb.id = m.from_bin_id left join inv_bin tb on tb.id = m.to_bin_id
      left join location fl on fl.id = m.from_location_id left join location tl on tl.id = m.to_location_id
      left join app_user u on u.id = m.by_user
     where m.entity_id = $1 and m.piece_id = $2 order by m.id desc limit 25`, [entityId, pc.id]);
  const damage = await q<{ id: string; number: string; status: string }>(c, `select id, number, status from inv_damage
     where entity_id = $1 and unit_id = $2 and status <> 'resolved' order by opened_at desc limit 1`, [entityId, pc.unit_id]);
  return { piece: pc, unit, history, openDamage: damage[0] ?? null, actions: NEXT[pc.status] ?? [] };
}

/** One scanned action on a piece. Unit-level actions (damage, as-is) apply to every carton of the unit. */
export async function pieceAction(c: Client, scope: Scope, label: string, action: string, b: { binId?: string | null; lineId?: string; reason?: string;
  description?: string; photoUrls?: string[]; source?: string; asIsPriceMinor?: bigint | null }) {
  const pc = await pieceByLabel(c, scope.entityId, label);
  const allowed = NEXT[pc.status] ?? [];
  need(allowed.includes(action), `a piece that is ${pc.status.replace(/_/g, " ")} cannot ${action.replace(/_/g, " ")}`);
  const by = scope.actor.id || null;
  const setOne = async (to: string, kind: string, extra: { bin?: string | null } = {}) => {
    const bin = extra.bin !== undefined ? extra.bin : to === "loaded" ? null : pc.bin_id;
    await c.query(`update inv_piece set status = $3, bin_id = $4, updated_at = now() where id = $1 and entity_id = $2`, [pc.id, scope.entityId, to, bin]);
    await logMove(c, scope.entityId, { kind, pieceId: pc.id, productId: pc.product_id, qty: 1 / pc.carton_count, fromLoc: pc.location_id, toLoc: pc.location_id,
      fromBin: pc.bin_id, toBin: bin, fromStatus: pc.status, toStatus: to, refType: pc.sales_order_line_id ? "order_line" : null, refId: pc.sales_order_line_id, reason: b.reason, by });
  };
  switch (action) {
    case "move": {
      const bin = await binAt(c, scope.entityId, b.binId, pc.location_id);
      need(bin, "pick the bin it is going to");
      await setOne(pc.status, "move", { bin });
      break;
    }
    case "pick": await setOne("picked", "pick"); break;
    case "unpick": await setOne("reserved", "unpick"); break;
    case "load": await setOne("loaded", "load"); break;
    case "unload": await setOne("picked", "unload"); break;
    case "allocate": need(b.lineId, "pick the order line"); await allocate(c, scope, label, b.lineId!); break;
    case "unallocate": await unallocate(c, scope, label); break;
    case "as_is":
      await transitionUnit(c, scope.entityId, by, pc.unit_id, "as_is", { kind: "as_is", reason: b.reason, asIsPriceMinor: b.asIsPriceMinor ?? null, asIsNote: b.reason ?? null });
      break;
    case "clear_as_is": await transitionUnit(c, scope.entityId, by, pc.unit_id, "in_stock", { kind: "restore", reason: b.reason }); break;
    case "damage":
      return reportDamage(c, scope, { label, source: b.source ?? "warehouse", description: b.description ?? b.reason ?? "", photoUrls: b.photoUrls ?? [] });
    case "repair": case "claim": case "restore": case "write_off": case "vendor_return": {
      const d = await q<{ id: string }>(c, `select id from inv_damage where entity_id = $1 and unit_id = $2 and status <> 'resolved' order by opened_at desc limit 1`,
        [scope.entityId, pc.unit_id]);
      if (action === "restore" && pc.status === "returned" && !d.length) {
        await transitionUnit(c, scope.entityId, by, pc.unit_id, "in_stock", { kind: "restore", reason: b.reason });
        break;
      }
      need(d.length, "there is no open damage record for this piece");
      if (action === "repair") return sendToRepair(c, scope, d[0].id, b.reason);
      if (action === "claim") return { damageId: d[0].id, needClaim: true };
      return resolveDamage(c, scope, d[0].id, { resolution: action === "restore" ? "restocked" : action === "write_off" ? "written_off" : "returned_to_vendor", note: b.reason });
    }
    default: need(false, `${action} is not something a scan can do`);
  }
  return { ok: true };
}

// ============================================================ damage, claims

async function insertDamage(c: Client, entityId: string, e: { productId: string; locationId: string; unitId: string | null; qty: number; source: string;
  description: string; photoUrls: string[]; cost: bigint; by: string | null }) {
  const number = await nextNo(c, entityId, "damage", "DMG-");
  const r = await one<{ id: string }>(c, `insert into inv_damage (entity_id, number, product_id, location_id, unit_id, qty, source, description, photo_urls, cost_minor, opened_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [entityId, number, e.productId, e.locationId, e.unitId, e.qty, e.source, e.description, cleanUrls(e.photoUrls), e.cost.toString(), e.by]);
  return { damageId: r.id, number };
}

function cleanUrls(urls: unknown): string[] {
  const list = Array.isArray(urls) ? urls : [];
  const out = list.map((u) => String(u ?? "").trim()).filter(Boolean).slice(0, 12);
  // A link (https), or a picture taken on the phone (service tickets and delivery proof keep them the same way).
  for (const u of out) need((/^https:\/\/\S+$/i.test(u) && u.length <= 1000) || (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(u) && u.length <= 1_500_000),
    "photo links must be https addresses, or pictures taken here");
  return out;
}

/** Put goods on damage hold: a labelled unit, or a quantity of a non-serialized product at a location. */
export async function reportDamage(c: Client, scope: Scope, e: { label?: string; productId?: string; locationId?: string; qty?: number;
  source: string; description: string; photoUrls?: string[] }) {
  need(String(e.description ?? "").trim(), "say what is wrong with it");
  const by = scope.actor.id || null;
  if (e.label) {
    const pc = await pieceByLabel(c, scope.entityId, e.label);
    need(["in_stock", "reserved", "picked", "loaded", "as_is", "returned"].includes(pc.status), `${e.label} is ${pc.status.replace(/_/g, " ")}; it cannot go on damage hold`);
    const open = await q(c, `select id from inv_damage where entity_id = $1 and unit_id = $2 and status <> 'resolved'`, [scope.entityId, pc.unit_id]);
    need(!open.length, "this unit already has an open damage record");
    await transitionUnit(c, scope.entityId, by, pc.unit_id, "damaged", { kind: "damage", reason: e.description, salesOrderLineId: null });
    return insertDamage(c, scope.entityId, { productId: pc.product_id, locationId: pc.location_id, unitId: pc.unit_id, qty: 1, source: e.source,
      description: e.description, photoUrls: e.photoUrls ?? [], cost: BigInt(pc.cost_minor), by });
  }
  need(e.productId && e.locationId, "scan the piece, or pick the product and location");
  const p = await productOf(c, scope.entityId, e.productId!);
  need(!p.serialized, `${p.name} is tracked piece by piece; scan the damaged piece`);
  const qty = Number(e.qty ?? 0);
  need(qty > 0, "how many are damaged?");
  const lv = await level(c, scope.entityId, p.id, e.locationId!);
  need(lv.onHand - lv.held >= qty, `only ${lv.onHand - lv.held} of ${p.name} are here and not already held`);
  await bump(c, scope.entityId, p.id, e.locationId!, { held: qty });
  await binStockTake(c, scope.entityId, p.id, e.locationId!, qty);
  await logMove(c, scope.entityId, { kind: "damage", productId: p.id, qty, fromLoc: e.locationId, toLoc: e.locationId, fromStatus: "in_stock", toStatus: "damaged", reason: e.description, by });
  return insertDamage(c, scope.entityId, { productId: p.id, locationId: e.locationId!, unitId: null, qty, source: e.source, description: e.description,
    photoUrls: e.photoUrls ?? [], cost: BigInt(p.cost_minor), by });
}

async function damageOf(c: Client, entityId: string, id: string) {
  const r = await q<{ id: string; number: string; product_id: string; location_id: string; unit_id: string | null; qty: string; status: string; cost_minor: string }>(c,
    `select id, number, product_id, location_id, unit_id, qty, status, cost_minor from inv_damage where id = $1 and entity_id = $2 for update`, [id, entityId]);
  need(r.length, "no such damage record");
  return r[0];
}

export async function sendToRepair(c: Client, scope: Scope, id: string, note?: string) {
  const d = await damageOf(c, scope.entityId, id);
  need(d.status === "open", `${d.number} is ${d.status.replace("_", " ")}; only an open record goes to repair`);
  if (d.unit_id) await transitionUnit(c, scope.entityId, scope.actor.id || null, d.unit_id, "in_repair", { kind: "repair", reason: note, refType: "damage", refId: id });
  await c.query(`update inv_damage set status = 'in_repair' where id = $1 and entity_id = $2`, [id, scope.entityId]);
  return { number: d.number, status: "in_repair" };
}

export async function openVendorClaim(c: Client, scope: Scope, damageId: string, e: { vendorRef?: string; amountClaimedMinor: bigint; photoUrls?: string[] }) {
  const d = await damageOf(c, scope.entityId, damageId);
  need(["open", "in_repair"].includes(d.status), `${d.number} is ${d.status.replace("_", " ")}`);
  need(e.amountClaimedMinor >= 0n, "the claim amount cannot be negative");
  const p = await productOf(c, scope.entityId, d.product_id);
  need(p.vendor_id, `${p.name} has no vendor to claim against`);
  const number = await nextNo(c, scope.entityId, "claim", "VC-");
  const r = await one<{ id: string }>(c, `insert into inv_vendor_claim (entity_id, number, damage_id, vendor_id, vendor_ref, amount_claimed_minor, photo_urls, status, opened_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [scope.entityId, number, d.id, p.vendor_id, e.vendorRef || null, e.amountClaimedMinor.toString(),
    cleanUrls(e.photoUrls), e.vendorRef ? "submitted" : "open", scope.actor.id || null]);
  if (d.unit_id) await transitionUnit(c, scope.entityId, scope.actor.id || null, d.unit_id, "vendor_claim", { kind: "claim", refType: "damage", refId: d.id, reason: `claim ${number}` });
  await c.query(`update inv_damage set status = 'vendor_claim' where id = $1 and entity_id = $2`, [d.id, scope.entityId]);
  return { id: r.id, number };
}

/** Move a vendor claim along. Credited and denied close it and need a sentence. */
export async function updateClaim(c: Client, scope: Scope, id: string, e: { status: string; vendorRef?: string; creditMinor?: bigint | null; resolution?: string }) {
  const r = await q<{ id: string; number: string; status: string }>(c, `select id, number, status from inv_vendor_claim where id = $1 and entity_id = $2 for update`, [id, scope.entityId]);
  need(r.length, "no such claim");
  const order = ["open", "submitted", "approved", "credited"];
  need(!["credited", "denied"].includes(r[0].status), `claim ${r[0].number} is closed`);
  need(["submitted", "approved", "denied", "credited"].includes(e.status), "a claim moves to submitted, approved, denied or credited");
  if (e.status !== "denied") need(order.indexOf(e.status) > order.indexOf(r[0].status), `claim ${r[0].number} is already ${r[0].status}`);
  if (["credited", "denied"].includes(e.status)) need(String(e.resolution ?? "").trim(), "say how the vendor settled it");
  if (e.status === "credited") need(e.creditMinor != null && e.creditMinor >= 0n, "how much did the vendor credit?");
  const closing = ["credited", "denied"].includes(e.status);
  await c.query(`update inv_vendor_claim set status = $3, vendor_ref = coalesce($4, vendor_ref), credit_minor = coalesce($5, credit_minor),
      resolution = coalesce($6, resolution), closed_by = case when $7 then $8::uuid else closed_by end, closed_at = case when $7 then now() else closed_at end
    where id = $1 and entity_id = $2`, [id, scope.entityId, e.status, e.vendorRef || null, e.creditMinor?.toString() ?? null, e.resolution || null,
    closing, scope.actor.id || null]);
  return { number: r[0].number, status: e.status };
}

/**
 * Close a damage record. Restocked and as-is put the goods back on sale;
 * written off and returned to the vendor take them out of stock at cost
 * (Dr 5040 Cr 1300). A vendor credit, if any, is the claim's business and
 * reaches the books through payables.
 */
export async function resolveDamage(c: Client, scope: Scope, id: string, e: { resolution: string; note?: string; asIsPriceMinor?: bigint | null }) {
  const d = await damageOf(c, scope.entityId, id);
  need(d.status !== "resolved", `${d.number} is already resolved`);
  need(["restocked", "as_is", "written_off", "returned_to_vendor"].includes(e.resolution), "resolve as restocked, as is, written off or returned to vendor");
  if (["written_off", "returned_to_vendor"].includes(e.resolution)) need(String(e.note ?? "").trim(), "say why it is leaving stock");
  const by = scope.actor.id || null;
  const qty = Number(d.qty);
  let je: string | null = null;
  const leaving = ["written_off", "returned_to_vendor"].includes(e.resolution);
  const value = leaving ? await costOut(c, scope.entityId, d.product_id, qty) : 0n;
  if (d.unit_id) {
    const to = e.resolution === "restocked" ? "in_stock" : e.resolution === "as_is" ? "as_is" : e.resolution;
    await transitionUnit(c, scope.entityId, by, d.unit_id, to, { kind: e.resolution === "restocked" ? "restore" : e.resolution === "as_is" ? "as_is" : e.resolution === "written_off" ? "write_off" : "vendor_return",
      reason: e.note, refType: "damage", refId: d.id, asIsPriceMinor: e.asIsPriceMinor ?? null, asIsNote: e.note ?? null });
  } else {
    const gone = ["written_off", "returned_to_vendor"].includes(e.resolution);
    await bump(c, scope.entityId, d.product_id, d.location_id, { held: -qty, onHand: gone ? -qty : 0 });
    await logMove(c, scope.entityId, { kind: gone ? (e.resolution === "written_off" ? "write_off" : "vendor_return") : "restore", productId: d.product_id, qty,
      fromLoc: d.location_id, toLoc: gone ? null : d.location_id, fromStatus: "damaged", toStatus: gone ? e.resolution : "in_stock", refType: "damage", refId: d.id, reason: e.note, by });
  }
  if (["written_off", "returned_to_vendor"].includes(e.resolution)) {
    je = await postValue(c, scope, d.location_id, -value, d.id,
      `${d.number} ${e.resolution === "written_off" ? "written off" : "returned to vendor"}`);
  }
  await c.query(`update inv_damage set status = 'resolved', resolution = $3, resolution_note = $4, resolved_by = $5, resolved_at = now(), journal_entry_id = $6
    where id = $1 and entity_id = $2`, [d.id, scope.entityId, e.resolution, e.note ?? null, by, je]);
  return { number: d.number, resolution: e.resolution, journalEntryId: je };
}

// ============================================================== cycle counts

const COUNTABLE = ["in_stock", "reserved", "as_is"];

/** A count sheet for one bin (or the unbinned stock at a location), with what the system expects there. */
export async function createCount(c: Client, scope: Scope, e: { locationId: string; binId?: string | null; note?: string }) {
  const loc = await q(c, `select id from location where id = $1 and entity_id = $2`, [e.locationId, scope.entityId]);
  need(loc.length, "no such location");
  const bin = await binAt(c, scope.entityId, e.binId, e.locationId);
  need(scope.actor.id, "a count is made by a person");
  const number = await nextNo(c, scope.entityId, "count", "CC-");
  const ct = await one<{ id: string }>(c, `insert into inv_count (entity_id, number, location_id, bin_id, note, created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
    [scope.entityId, number, e.locationId, bin, e.note ?? null, scope.actor.id]);
  // Serialized: units whose pieces sit here.
  const ser = await q<{ product_id: string; units: string; labels: string[]; cost: string }>(c, `
    select pc.product_id, count(distinct pc.unit_id) units, array_agg(pc.label order by pc.label) labels, max(p.cost_minor) cost
      from inv_piece pc join product p on p.id = pc.product_id
     where pc.entity_id = $1 and pc.location_id = $2 and pc.bin_id is not distinct from $3 and pc.status = any($4)
     group by pc.product_id`, [scope.entityId, e.locationId, bin, COUNTABLE]);
  for (const s of ser) await c.query(`insert into inv_count_line (entity_id, count_id, product_id, serialized, expected_qty, expected_labels, unit_cost_minor)
    values ($1,$2,$3,true,$4,$5,$6)`, [scope.entityId, ct.id, s.product_id, s.units, s.labels, s.cost]);
  // Non-serialized: the bin's quantity, or for no bin, on hand less what is binned and held.
  const non = bin
    ? await q<{ product_id: string; qty: string; cost: string }>(c, `select s.product_id, s.qty, p.cost_minor cost from inv_bin_stock s join product p on p.id = s.product_id
        where s.entity_id = $1 and s.bin_id = $2 and s.qty > 0`, [scope.entityId, bin])
    : await q<{ product_id: string; qty: string; cost: string }>(c, `
        select sl.product_id, (sl.on_hand - sl.held - coalesce((select sum(bs.qty) from inv_bin_stock bs join inv_bin b on b.id = bs.bin_id
                 where bs.entity_id = sl.entity_id and bs.product_id = sl.product_id and b.location_id = sl.location_id), 0))::text qty, p.cost_minor cost
          from stock_level sl join product p on p.id = sl.product_id
         where sl.entity_id = $1 and sl.location_id = $2 and not p.serialized and p.kind = 'stock'`, [scope.entityId, e.locationId]);
  for (const s of non) if (Number(s.qty) > 0) await c.query(`insert into inv_count_line (entity_id, count_id, product_id, serialized, expected_qty, unit_cost_minor)
    values ($1,$2,$3,false,$4,$5)`, [scope.entityId, ct.id, s.product_id, s.qty, s.cost]);
  return { id: ct.id, number };
}

async function countOf(c: Client, entityId: string, id: string) {
  const r = await q<{ id: string; number: string; status: string; location_id: string; bin_id: string | null; created_by: string; submitted_by: string | null }>(c,
    `select id, number, status, location_id, bin_id, created_by, submitted_by from inv_count where id = $1 and entity_id = $2 for update`, [id, entityId]);
  need(r.length, "no such count");
  return r[0];
}

/** Enter what was found: a quantity, or the labels scanned (which then decide the count for that product). */
export async function submitCount(c: Client, scope: Scope, id: string, lines: { productId: string; countedQty?: number | null; scannedLabels?: string[] }[]) {
  const ct = await countOf(c, scope.entityId, id);
  need(ct.status === "open", `count ${ct.number} is ${ct.status}`);
  for (const l of lines) {
    const p = await productOf(c, scope.entityId, l.productId);
    let counted = l.countedQty == null ? null : Number(l.countedQty);
    const labels = (l.scannedLabels ?? []).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
    if (labels.length) {
      need(p.serialized, `${p.name} has no labels; enter a quantity`);
      const u = await q<{ n: string }>(c, `select count(distinct unit_id) n from inv_piece where entity_id = $1 and product_id = $2 and upper(label) = any($3)`,
        [scope.entityId, p.id, labels]);
      counted = Number(u[0].n);
    }
    need(counted != null && counted >= 0, `enter a count for ${p.name}`);
    if (p.serialized) need(Number.isInteger(counted), `${p.name} is counted in whole units`);
    const has = await q(c, `select id from inv_count_line where entity_id = $1 and count_id = $2 and product_id = $3`, [scope.entityId, id, p.id]);
    if (has.length) await c.query(`update inv_count_line set counted_qty = $4, scanned_labels = $5 where entity_id = $1 and count_id = $2 and product_id = $3`,
      [scope.entityId, id, p.id, counted, labels]);
    else await c.query(`insert into inv_count_line (entity_id, count_id, product_id, serialized, expected_qty, counted_qty, scanned_labels, unit_cost_minor)
      values ($1,$2,$3,$4,0,$5,$6,$7)`, [scope.entityId, id, p.id, p.serialized, counted, labels, p.cost_minor]);
  }
  const missing = await q<{ n: string }>(c, `select count(*) n from inv_count_line where entity_id = $1 and count_id = $2 and counted_qty is null`, [scope.entityId, id]);
  need(Number(missing[0].n) === 0, missing[0].n === "1" ? "1 line on the sheet still needs a count (enter 0 if none were found)" : `${missing[0].n} lines on the sheet still need a count (enter 0 if none were found)`);
  const v = await q<{ v: string }>(c, `select coalesce(sum(round((counted_qty - expected_qty) * unit_cost_minor)),0)::text v from inv_count_line where entity_id = $1 and count_id = $2`,
    [scope.entityId, id]);
  await c.query(`update inv_count set status = 'submitted', submitted_by = $3, submitted_at = now(), variance_minor = $4 where id = $1 and entity_id = $2`,
    [id, scope.entityId, scope.actor.id || null, v[0].v]);
  return { number: ct.number, varianceMinor: BigInt(v[0].v) };
}

/**
 * Approve or reject a submitted count. The person deciding must not be the
 * one who made or submitted it (role is checked by the caller). Approving
 * moves stock to what was counted and posts the variance at cost.
 */
export async function decideCount(c: Client, scope: Scope, id: string, e: { approve: boolean; note?: string }) {
  const ct = await countOf(c, scope.entityId, id);
  need(ct.status === "submitted", `count ${ct.number} is ${ct.status}; only a submitted count is decided`);
  const me = scope.actor.id || "";
  need(me !== ct.created_by && me !== ct.submitted_by, "the person who made or submitted a count cannot also approve it");
  if (!e.approve) {
    need(String(e.note ?? "").trim(), "say why the count is rejected");
    await c.query(`update inv_count set status = 'rejected', decided_by = $3, decided_at = now(), decision_note = $4 where id = $1 and entity_id = $2`, [id, scope.entityId, me, e.note]);
    return { number: ct.number, status: "rejected", varianceMinor: 0n, journalEntryId: null };
  }
  const lines = await q<{ product_id: string; serialized: boolean; expected_qty: string; counted_qty: string; expected_labels: string[]; scanned_labels: string[]; unit_cost_minor: string }>(c,
    `select product_id, serialized, expected_qty, counted_qty, expected_labels, scanned_labels, unit_cost_minor from inv_count_line where entity_id = $1 and count_id = $2`,
    [scope.entityId, id]);
  let value = 0n;
  for (const l of lines) {
    const delta = Number(l.counted_qty) - Number(l.expected_qty);
    if (l.serialized) {
      const scanned = new Set(l.scanned_labels.map((x) => x.toUpperCase()));
      if (scanned.size) {
        // Units expected here and not scanned are gone; scanned units that were elsewhere at this location are moved here.
        const exp = await q<{ unit_id: string; labels: string[] }>(c, `select unit_id, array_agg(upper(label)) labels from inv_piece
          where entity_id = $1 and upper(label) = any($2) group by unit_id`, [scope.entityId, l.expected_labels.map((x) => x.toUpperCase())]);
        for (const u of exp) if (!u.labels.some((x) => scanned.has(x))) {
          value -= await costOut(c, scope.entityId, l.product_id, 1);
          await transitionUnit(c, scope.entityId, me, u.unit_id, "written_off", { kind: "count", refType: "count", refId: id, reason: `not found in count ${ct.number}`, salesOrderLineId: null });
        }
        const found = await q<{ unit_id: string; location_id: string; status: string }>(c, `select unit_id, min(location_id::text)::uuid location_id, min(status) status from inv_piece
          where entity_id = $1 and upper(label) = any($2) and not (upper(label) = any($3)) group by unit_id`,
          [scope.entityId, [...scanned], l.expected_labels.map((x) => x.toUpperCase())]);
        for (const u of found) {
          const sameHere = u.location_id === ct.location_id && COUNTABLE.includes(u.status);
          // A unit already on hand somewhere only moves; one that had left the books comes back at today's average.
          if (!ON_HAND.includes(u.status)) {
            const unit = await unitCost(c, scope.entityId, l.product_id);
            await costIn(c, scope.entityId, l.product_id, 1, unit);
            value += unit;
          }
          await transitionUnit(c, scope.entityId, me, u.unit_id, sameHere ? u.status : "in_stock", { kind: "count", toLocation: ct.location_id, toBin: ct.bin_id,
            refType: "count", refId: id, reason: `found in count ${ct.number}` });
        }
      } else if (delta < 0) {
        const units = await q<{ unit_id: string }>(c, `select unit_id from inv_piece where entity_id = $1 and label = any($2)
          group by unit_id order by bool_or(sales_order_line_id is not null), max(created_at) desc limit $3`, [scope.entityId, l.expected_labels, -delta]);
        for (const u of units) {
          value -= await costOut(c, scope.entityId, l.product_id, 1);
          await transitionUnit(c, scope.entityId, me, u.unit_id, "written_off", { kind: "count", refType: "count", refId: id, reason: `short in count ${ct.number}`, salesOrderLineId: null });
        }
      } else if (delta > 0) {
        const p = await productOf(c, scope.entityId, l.product_id);
        const unit = await unitCost(c, scope.entityId, l.product_id);
        await costIn(c, scope.entityId, l.product_id, delta, BigInt(delta) * unit);
        await createUnits(c, scope.entityId, p, { locationId: ct.location_id, binId: ct.bin_id, qty: delta, status: "in_stock", costMinor: unit,
          kind: "count", refType: "count", refId: id, reason: `over in count ${ct.number}`, by: me });
        await bump(c, scope.entityId, l.product_id, ct.location_id, { onHand: delta });
        value += BigInt(delta) * unit;
      }
    } else if (delta !== 0) {
      if (delta < 0) value -= await costOut(c, scope.entityId, l.product_id, -delta);
      else {
        const v = BigInt(Math.round(delta * Number(await unitCost(c, scope.entityId, l.product_id))));
        await costIn(c, scope.entityId, l.product_id, delta, v);
        value += v;
      }
      await bump(c, scope.entityId, l.product_id, ct.location_id, { onHand: delta });
      if (ct.bin_id) await c.query(`insert into inv_bin_stock (entity_id, bin_id, product_id, qty) values ($1,$2,$3,$4)
        on conflict (bin_id, product_id) do update set qty = $4`, [scope.entityId, ct.bin_id, l.product_id, l.counted_qty]);
      await logMove(c, scope.entityId, { kind: "count", productId: l.product_id, qty: delta, fromLoc: ct.location_id, toLoc: ct.location_id, toBin: ct.bin_id,
        refType: "count", refId: id, reason: `count ${ct.number}`, by: me });
    }
  }
  const je = await postValue(c, scope, ct.location_id, value, id, `Cycle count ${ct.number} variance`);
  await c.query(`update inv_count set status = 'approved', decided_by = $3, decided_at = now(), decision_note = $4, variance_minor = $5, journal_entry_id = $6
    where id = $1 and entity_id = $2`, [id, scope.entityId, me, e.note ?? null, value.toString(), je]);
  return { number: ct.number, status: "approved", varianceMinor: value, journalEntryId: je };
}

// ============================================================== adjustments

export const REASONS = ["found", "lost", "theft", "damaged_beyond_repair", "data_correction", "sample", "donation", "opening_balance", "other"];

/** A stock adjustment with a reason code, posted at cost. Serialized write-downs name the pieces by label. */
export async function adjust(c: Client, scope: Scope, e: { locationId: string; productId: string; qty: number; reasonCode: string; note?: string;
  binId?: string | null; labels?: string[] }) {
  need(REASONS.includes(e.reasonCode), "pick a reason");
  const qty = Number(e.qty);
  need(qty !== 0 && Number.isFinite(qty), "adjust by a quantity other than zero");
  if (e.reasonCode === "other") need(String(e.note ?? "").trim(), "say what the adjustment is for");
  const p = await productOf(c, scope.entityId, e.productId);
  need(STOCKED_KINDS.includes(p.kind), `${p.name} is not a stocked product`);
  const loc = await q(c, `select id from location where id = $1 and entity_id = $2`, [e.locationId, scope.entityId]);
  need(loc.length, "no such location");
  const bin = await binAt(c, scope.entityId, e.binId, e.locationId);
  const by = scope.actor.id || null;
  const number = await nextNo(c, scope.entityId, "adjustment", "ADJ-");
  const adjId = (await q<{ u: string }>(c, `select gen_random_uuid()::text u /* unscoped: no table */`))[0].u;
  // The value moves through the cost pool first: out at the average, or in at today's average.
  const unitNow = await unitCost(c, scope.entityId, p.id);
  let value: bigint;
  if (qty < 0) value = -(await costOut(c, scope.entityId, p.id, -qty));
  else { value = BigInt(Math.round(qty * Number(unitNow))); await costIn(c, scope.entityId, p.id, qty, value); }
  let labels: string[] = [];
  if (p.serialized) {
    need(Number.isInteger(qty), `${p.name} is adjusted in whole units`);
    if (qty < 0) {
      const given = (e.labels ?? []).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
      need(given.length, `name the ${p.name} pieces being taken out by label`);
      const units = await q<{ unit_id: string; ok: boolean }>(c, `select unit_id, bool_and(location_id = $3 and status = any($4) and sales_order_line_id is null) ok
        from inv_piece where entity_id = $1 and product_id = $2 and upper(label) = any($5) group by unit_id`,
        [scope.entityId, p.id, e.locationId, ["in_stock", "as_is", "damaged", "in_repair", "returned"], given]);
      need(units.length === -qty, `the labels name ${units.length} unit${units.length === 1 ? "" : "s"}, not ${-qty}`);
      need(units.every((u) => u.ok), "every piece taken out must be free stock at this location");
      for (const u of units) await transitionUnit(c, scope.entityId, by, u.unit_id, "written_off", { kind: "adjust", refType: "adjustment", refId: adjId, reason: e.reasonCode });
      labels = given;
    } else {
      const made = await createUnits(c, scope.entityId, p, { locationId: e.locationId, binId: bin, qty, status: "in_stock", costMinor: unitNow,
        kind: "adjust", refType: "adjustment", refId: adjId, reason: e.reasonCode, by });
      await bump(c, scope.entityId, p.id, e.locationId, { onHand: qty });
      labels = made.labels;
    }
  } else {
    if (qty < 0) {
      const lv = await level(c, scope.entityId, p.id, e.locationId);
      need(lv.available >= -qty, `only ${lv.available} of ${p.name} are free here to take out`);
      if (bin) await binStockAdd(c, scope.entityId, bin, p.id, qty); else await binStockTake(c, scope.entityId, p.id, e.locationId, -qty);
    } else if (bin) await binStockAdd(c, scope.entityId, bin, p.id, qty);
    await bump(c, scope.entityId, p.id, e.locationId, { onHand: qty });
    await logMove(c, scope.entityId, { kind: "adjust", productId: p.id, qty, fromLoc: e.locationId, toLoc: e.locationId, toBin: bin, refType: "adjustment", refId: adjId,
      reason: e.reasonCode, by });
  }
  const je = await postValue(c, scope, e.locationId, value, adjId, `Adjustment ${number}: ${e.reasonCode.replace(/_/g, " ")}`);
  await c.query(`insert into inv_adjustment (id, entity_id, number, location_id, bin_id, product_id, qty, reason_code, note, labels, value_minor, journal_entry_id, by_user)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [adjId, scope.entityId, number, e.locationId, bin, p.id, qty, e.reasonCode, e.note ?? null, labels,
    value.toString(), je, by]);
  return { id: adjId, number, valueMinor: value, labels, journalEntryId: je };
}

// ======================================================== availability, value

/** Available to promise: free stock by location, and when the next purchase order lands. */
export async function availableToPromise(c: Client, entityId: string, productId: string) {
  const p = await productOf(c, entityId, productId);
  const locs = await q<{ location_id: string; name: string; kind: string; on_hand: string; reserved: string; held: string; available: string; on_order: string }>(c, `
    select l.id location_id, l.name, l.kind, coalesce(s.on_hand,0)::text on_hand, coalesce(s.reserved,0)::text reserved, coalesce(s.held,0)::text held,
           coalesce(s.on_hand - s.reserved - s.held,0)::text available, coalesce(s.on_order,0)::text on_order
      from location l left join stock_level s on s.location_id = l.id and s.entity_id = l.entity_id and s.product_id = $2
     where l.entity_id = $1 and l.status = 'active' and l.kind not in ('web','in_transit')
     order by case l.kind when 'warehouse' then 0 when 'dropship' then 2 else 1 end, l.name`, [entityId, productId]);
  const asIs = await q<{ n: string }>(c, `select count(distinct unit_id) n from inv_piece where entity_id = $1 and product_id = $2 and status = 'as_is'`, [entityId, productId]);
  let next: { number: string; expectedOn: string | null; qty: number } | null = null;
  const cols = await columnsOf(c, "purchase_order_line");
  if (cols.has("product_id")) {
    const etaLine = cols.has("expected_on") ? "l.expected_on" : "null::date";
    const cancelled = cols.has("cancelled_qty") ? "l.cancelled_qty" : "0";
    const poCols = await columnsOf(c, "purchase_order");
    const etaHead = ["expected_on", "eta", "expected_date", "promised_on"].find((x) => poCols.has(x));
    const eta = etaHead ? `coalesce(${etaLine}, po.${etaHead})` : etaLine;
    const r = await q<{ number: string; eta: string | null; left: string }>(c, `
      select po.number, ${eta}::text eta,
             (l.quantity - ${cancelled} - coalesce((select sum(g.quantity) from goods_receipt_line g where g.purchase_order_line_id = l.id),0))::text "left"
        from purchase_order po join purchase_order_line l on l.purchase_order_id = po.id
       where po.entity_id = $1 and po.status = 'open' and l.product_id = $2
       order by ${eta} nulls last, po.ordered_on`, [entityId, productId]);
    const open = r.filter((x) => Number(x.left) > 0);
    if (open.length) next = { number: open[0].number, expectedOn: open[0].eta, qty: Number(open[0].left) };
  }
  // Supplier-held stock is promised as a drop ship, not as ours on hand.
  const availableNow = locs.filter((x) => x.kind !== "dropship").reduce((a, x) => a + Math.max(0, Number(x.available)), 0);
  const dropship = locs.filter((x) => x.kind === "dropship").reduce((a, x) => a + Math.max(0, Number(x.available)), 0);
  const transit = await inTransitFor(c, entityId, productId);
  const arrivingOn = transit.map((x) => x.arrivingOn).filter(Boolean).sort()[0] ?? null;
  return {
    product: { id: p.id, sku: p.sku, name: p.name, serialized: p.serialized },
    locations: locs.map((x) => ({ locationId: x.location_id, name: x.name, kind: x.kind, onHand: Number(x.on_hand), reserved: Number(x.reserved),
      held: Number(x.held), available: Number(x.available), onOrder: Number(x.on_order) })),
    availableNow, asIs: Number(asIs[0].n), nextPurchaseOrder: next, dropship,
    inTransit: transit, inTransitQty: transit.reduce((a, x) => a + x.qty, 0), arrivingOn,
    promise: availableNow > 0 ? "now" : arrivingOn ? `arriving on ${arrivingOn}` : dropship > 0 ? "ships from the supplier"
      : next?.expectedOn ? next.expectedOn : next ? "on order, no date yet" : "not available",
  };
}

/**
 * A cost that reaches goods after they were received (freight or duty billed
 * later): the part for units still on hand raises their value (Dr 1300, into
 * the cost pool, and onto their labels' cost); the part for units already
 * sold or gone goes to cost of goods (Dr 5000). The other side is 2050,
 * received not invoiced, which the forwarder's bill clears. A negative
 * amount reverses the same way.
 */
export async function revalue(c: Client, scope: Scope, e: { productId: string; locationId: string | null; onHandMinor: bigint; goneMinor: bigint;
  unitIds?: string[]; sourceId: string; description: string }): Promise<string | null> {
  const total = e.onHandMinor + e.goneMinor;
  if (total === 0n) return null;
  if (e.onHandMinor !== 0n) {
    const p = await poolOf(c, scope.entityId, e.productId);
    need(p.value + e.onHandMinor >= 0n, "that would take the stock's value below zero");
    await c.query(`update inv_cost set value_minor = value_minor + $3, updated_at = now() where entity_id = $1 and product_id = $2`,
      [scope.entityId, e.productId, e.onHandMinor.toString()]);
    if (e.unitIds?.length) {
      const per = BigInt(Math.round(Number(e.onHandMinor) / e.unitIds.length));
      await c.query(`update inv_piece set cost_minor = greatest(cost_minor + $3, 0), updated_at = now() where entity_id = $1 and unit_id = any($2)`,
        [scope.entityId, e.unitIds, per.toString()]);
    }
  }
  const po = await profitObjectFor(c, scope.entityId, e.locationId);
  const side = (code: string, v: bigint, memo?: string) => (v > 0n ? { code, debit: v, profitObjectId: po, memo } : { code, credit: -v, profitObjectId: po, memo });
  const lines = [side("1300", e.onHandMinor), side("5000", e.goneMinor, "landed cost on goods already sold"), side("2050", -total, "received not invoiced")]
    .filter((l) => (l.debit ?? l.credit ?? 0n) !== 0n);
  return post(c, scope, { date: today(), sourceType: "inventory", sourceId: e.sourceId, description: e.description.slice(0, 300), lines });
}

/** Goods on the road for a product: shipped on a PO (an 856 or a container that left) or on a transfer, and where each is going. */
export async function inTransitFor(c: Client, entityId: string, productId: string) {
  const r = await q<{ source: string; ref_id: string; ref_no: string; to_location_id: string; to_name: string; qty: string; arriving_on: string | null }>(c, `
    select t.source, t.ref_id, t.ref_no, t.to_location_id, l.name to_name, t.qty::text, t.arriving_on::text
      from inv_in_transit t join location l on l.id = t.to_location_id
     where t.entity_id = $1 and t.product_id = $2 order by t.arriving_on nulls last, t.ref_no`, [entityId, productId]);
  return r.map((x) => ({ source: x.source as "po" | "transfer", refId: x.ref_id, ref: x.ref_no, toLocationId: x.to_location_id, to: x.to_name,
    qty: Number(x.qty), arrivingOn: x.arriving_on, text: x.arriving_on ? `arriving on ${x.arriving_on}` : "on the way, no date yet" }));
}

/**
 * What stock is worth at cost, by location and category. The total is the
 * cost pool itself (what 1300 should hold); the rows spread each product's
 * value over its locations by quantity.
 */
export async function valuation(c: Client, entityId: string) {
  const rows = await q<{ location_id: string; location: string; category: string; units: string; value_minor: string; held_units: string; held_minor: string }>(c, `
    with avg as (
      select p.id product_id, coalesce(case when ic.qty > 0 then ic.value_minor::numeric / ic.qty end, p.cost_minor) unit
        from product p left join inv_cost ic on ic.product_id = p.id and ic.entity_id = p.entity_id where p.entity_id = $1)
    select l.id location_id, l.name location, coalesce(p.category,'Uncategorised') category,
           sum(s.on_hand)::text units, sum(round(s.on_hand * a.unit))::bigint::text value_minor,
           sum(s.held)::text held_units, sum(round(s.held * a.unit))::bigint::text held_minor
      from stock_level s join product p on p.id = s.product_id join location l on l.id = s.location_id join avg a on a.product_id = s.product_id
     where s.entity_id = $1 and s.on_hand <> 0
     group by l.id, l.name, p.category order by l.name, category`, [entityId]);
  const tot = await one<{ v: string }>(c, `
    select (coalesce((select sum(value_minor) from inv_cost where entity_id = $1), 0)
          + coalesce((select sum(round(s.on_hand * p.cost_minor)) from stock_level s join product p on p.id = s.product_id
                       where s.entity_id = $1 and not exists (select 1 from inv_cost ic where ic.entity_id = s.entity_id and ic.product_id = s.product_id)), 0))::bigint::text v`,
    [entityId]);
  const transit = await q<{ v: string }>(c, `select coalesce(sum(tl.value_minor),0)::bigint::text v from inv_transfer_line tl
     join inv_transfer t on t.id = tl.transfer_id where tl.entity_id = $1 and t.status = 'in_transit'`, [entityId]);
  return { rows, totalMinor: BigInt(tot.v), inTransitMinor: BigInt(transit[0].v) };
}

/**
 * The inventory tie-out: stock at cost (plus in transit) against what the
 * ledger holds in 1300 (plus 1310). A difference means something moved
 * stock without posting, or posted without moving stock.
 */
export async function tieOut(c: Client, entityId: string) {
  const v = await valuation(c, entityId);
  const gl = await q<{ code: string; bal: string }>(c, `
    select g.code, coalesce(sum(jl.debit_minor - jl.credit_minor),0)::text bal
      from journal_line jl join journal_entry je on je.id = jl.journal_entry_id join gl_account g on g.id = jl.gl_account_id
     where je.entity_id = $1 and g.code in ('1300','1310') group by g.code`, [entityId]);
  const bal = (code: string) => BigInt(gl.find((x) => x.code === code)?.bal ?? "0");
  const off = await q<{ sku: string; pool: string; stock: string }>(c, `
    select p.sku, ic.qty::text pool, coalesce((select sum(s.on_hand) from stock_level s where s.entity_id = ic.entity_id and s.product_id = ic.product_id), 0)::text stock
      from inv_cost ic join product p on p.id = ic.product_id
     where ic.entity_id = $1 and ic.qty <> coalesce((select sum(s.on_hand) from stock_level s where s.entity_id = ic.entity_id and s.product_id = ic.product_id), 0)`, [entityId]);
  const books = bal("1300") + bal("1310"), stock = v.totalMinor + v.inTransitMinor;
  return { stockMinor: v.totalMinor, inTransitMinor: v.inTransitMinor, gl1300Minor: bal("1300"), gl1310Minor: bal("1310"),
    differenceMinor: books - stock, ties: books === stock, quantityOutOfStep: off };
}

// ---------------------------------------------------------------------------
// Purchasing appends its on-order helper below this line.

/**
 * Goods placed on (qty > 0) or taken off (qty < 0) a purchase order for a
 * location. Purchasing calls this when a PO is placed, cancelled or cut back
 * by the vendor; receiving lowers it through its own code.
 */
export async function addOnOrder(c: Client, entityId: string, productId: string, locationId: string, qty: number): Promise<void> {
  if (!Number.isFinite(qty) || qty === 0) throw new InventoryError("on-order changes by a non-zero quantity");
  await bump(c, entityId, productId, locationId, { onOrder: qty });
}
