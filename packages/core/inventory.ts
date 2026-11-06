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
//   transfer shipped          Dr 1310 inventory in transit   Cr 1300 inventory
//   transfer received         Dr 1300                         Cr 1310
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
      await bump(c, entityId, l.product_id!, l.fulfil_from_id, {
        onHand: -qty, reserved: l.line_status === "reserved" || l.line_status === "ready" ? -qty : 0 });
      cost += BigInt(Math.round(qty * Number(l.cost_minor ?? 0)));
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
  opts: { lineIds?: string[]; binId?: string | null; by?: string | null } = {}): Promise<void> {
  if (qty <= 0) throw new InventoryError("restock a positive quantity");
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
  lineIds?: string[]; description: string; photoUrls?: string[] }): Promise<{ damageId: string; number: string }> {
  need(e.qty > 0, "return a positive quantity");
  need(e.description?.trim(), "say what is wrong with it");
  const by = scope.actor.id || null;
  await bump(c, scope.entityId, e.productId, e.locationId, { onHand: e.qty, held: e.qty });
  const units = await returnUnits(c, scope.entityId, e.productId, e.locationId, e.qty, "damaged", { lineIds: e.lineIds, by });
  const p = await productOf(c, scope.entityId, e.productId);
  let first: { damageId: string; number: string } | null = null;
  if (units.length) {
    for (const u of units) {
      const d = await insertDamage(c, scope.entityId, { productId: e.productId, locationId: e.locationId, unitId: u, qty: 1,
        source: "customer_return", description: e.description, photoUrls: e.photoUrls ?? [], cost: BigInt(p.cost_minor), by });
      first ??= d;
    }
  } else {
    first = await insertDamage(c, scope.entityId, { productId: e.productId, locationId: e.locationId, unitId: null, qty: e.qty,
      source: "customer_return", description: e.description, photoUrls: e.photoUrls ?? [], cost: BigInt(p.cost_minor), by });
  }
  return first!;
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
  return q<{ po_id: string; number: string; vendor: string; ordered_on: string; line_id: string; seq: number; description: string;
    product_id: string | null; sku: string | null; serialized: boolean | null; ordered: string; received: string; expected_on: string | null; unit_price_minor: string;
    ship_to_id: string | null }>(c, `
    select po.id po_id, po.number, v.legal_name vendor, po.ordered_on::text, l.id line_id, l.seq, l.description,
           ${prod} product_id, p.sku, p.serialized, (l.quantity - ${cancelled})::text ordered, ${shipTo} ship_to_id,
           coalesce((select sum(gl.quantity) from goods_receipt_line gl where gl.purchase_order_line_id = l.id), 0)::text received,
           ${eta}::text expected_on, l.unit_price_minor::text
      from purchase_order po join purchase_order_line l on l.purchase_order_id = po.id
      join vendor v on v.id = po.vendor_id
      left join product p on p.id = ${prod} and p.entity_id = po.entity_id
     where po.entity_id = $1 and po.status = 'open'
     order by po.ordered_on, po.number, l.seq`, [entityId]);
}

export type ReceiveLine = { poLineId: string; qty: number; damagedQty?: number; damageNote?: string };

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
  const loc = await q<{ id: string }>(c, `select id from location where id = $1 and entity_id = $2 and status = 'active'`, [e.locationId, entityId]);
  need(loc.length, "no such location");
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
  const out: { poLineId: string; sku: string; qty: number; labels: string[] }[] = [];
  const seen = new Set<string>();
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
    const unitCost = BigInt(l!.unit_price_minor);
    const grl = await one<{ id: string }>(c, `insert into goods_receipt_line (goods_receipt_id, purchase_order_line_id, quantity) values ($1,$2,$3) returning id`,
      [gr.id, l!.line_id, qty]);
    const labels: string[] = [];
    if (p.serialized) {
      if (qty - dmg > 0) labels.push(...(await createUnits(c, entityId, p, { locationId: e.locationId, binId, qty: qty - dmg, status: "in_stock", costMinor: unitCost,
        kind: "receive", refType: "receipt", refId: gr.id, by, grLineId: grl.id })).labels);
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
    await bump(c, entityId, p.id, e.locationId, { onHand: qty, onOrder: -qty, held: dmg });
    out.push({ poLineId: l!.line_id, sku: p.sku, qty, labels });
  }
  // Closed when every line is in.
  const after = await openPurchaseOrders(c, entityId);
  const left = after.filter((x) => x.po_id === po[0].id && Number(x.received) < Number(x.ordered));
  if (!left.length) await c.query(`update purchase_order set status = 'received' where id = $1 and entity_id = $2`, [po[0].id, entityId]);
  if (e.appointmentId) await c.query(`update inv_receiving_appt set status = 'received' where id = $1 and entity_id = $2`, [e.appointmentId, entityId]);
  return { receiptId: gr.id, poNumber: po[0].number, lines: out, poStatus: left.length ? "open" : "received" };
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

export async function createTransfer(c: Client, scope: Scope, e: { fromId: string; toId: string; lines: { productId: string; qty: number; labels?: string[] }[]; note?: string }) {
  need(e.fromId !== e.toId, "a transfer goes between two different locations");
  const locs = await q<{ id: string }>(c, `select id from location where entity_id = $1 and id = any($2) and status = 'active'`, [scope.entityId, [e.fromId, e.toId]]);
  need(locs.length === 2, "pick two of this company's locations");
  need(e.lines?.length, "a transfer needs at least one line");
  const number = await nextNo(c, scope.entityId, "transfer", "TR-");
  const t = await one<{ id: string }>(c, `insert into inv_transfer (entity_id, number, from_location_id, to_location_id, note, created_by)
    values ($1,$2,$3,$4,$5,$6) returning id`, [scope.entityId, number, e.fromId, e.toId, e.note ?? null, scope.actor.id || null]);
  for (const l of e.lines) {
    const p = await productOf(c, scope.entityId, l.productId);
    need(Number(l.qty) > 0, "transfer a positive quantity");
    need(!p.serialized || Number.isInteger(Number(l.qty)), `${p.name} moves in whole units`);
    let units: string[] = [];
    if (l.labels?.length) {
      need(p.serialized, `${p.name} is not tracked by label`);
      const r = await q<{ unit_id: string }>(c, `select distinct unit_id from inv_piece where entity_id = $1 and product_id = $2 and label = any($3)`,
        [scope.entityId, p.id, l.labels]);
      units = r.map((x) => x.unit_id);
      need(units.length === Number(l.qty), `the labels name ${units.length} unit${units.length === 1 ? "" : "s"} of ${p.name}, not ${l.qty}`);
    }
    await c.query(`insert into inv_transfer_line (entity_id, transfer_id, product_id, qty, unit_ids, cost_minor) values ($1,$2,$3,$4,$5,$6)`,
      [scope.entityId, t.id, p.id, l.qty, units, p.cost_minor]);
  }
  return { id: t.id, number };
}

/** Ship: stock leaves the origin and is in transit, at cost (Dr 1310 Cr 1300). */
export async function shipTransfer(c: Client, scope: Scope, id: string) {
  const t = await transferOf(c, scope.entityId, id);
  need(t.status === "draft", `transfer ${t.number} is ${t.status.replace("_", " ")}, so it cannot ship`);
  const lines = await q<{ id: string; product_id: string; qty: string; unit_ids: string[]; cost_minor: string }>(c,
    `select id, product_id, qty, unit_ids, cost_minor from inv_transfer_line where entity_id = $1 and transfer_id = $2`, [scope.entityId, id]);
  let value = 0n;
  for (const l of lines) {
    const p = await productOf(c, scope.entityId, l.product_id);
    const qty = Number(l.qty);
    const lv = await level(c, scope.entityId, p.id, t.from_location_id);
    need(lv.available >= qty, `${p.name}: ${lv.available} available at the origin, ${qty} on the transfer`);
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
      for (const u of units) await transitionUnit(c, scope.entityId, scope.actor.id || null, u, "in_transit",
        { kind: "transfer_out", refType: "transfer", refId: id, transferId: id });
    } else {
      await bump(c, scope.entityId, p.id, t.from_location_id, { onHand: -qty });
      await binStockTake(c, scope.entityId, p.id, t.from_location_id, qty);
      await logMove(c, scope.entityId, { kind: "transfer_out", productId: p.id, qty, fromLoc: t.from_location_id, toStatus: "in_transit",
        refType: "transfer", refId: id, by: scope.actor.id });
    }
    value += BigInt(Math.round(qty * Number(l.cost_minor)));
  }
  await c.query(`update inv_transfer set status = 'in_transit', shipped_by = $3, shipped_at = now() where id = $1 and entity_id = $2`, [id, scope.entityId, scope.actor.id || null]);
  if (value > 0n) {
    const po = await profitObjectFor(c, scope.entityId, t.from_location_id);
    await post(c, scope, { date: today(), sourceType: "inventory", sourceId: id, description: `Transfer ${t.number} shipped`,
      lines: [{ code: "1310", debit: value, profitObjectId: po }, { code: "1300", credit: value, profitObjectId: po }] });
  }
  return { number: t.number, valueMinor: value };
}

/** Receive: stock lands at the destination (Dr 1300 Cr 1310). */
export async function receiveTransfer(c: Client, scope: Scope, id: string, e: { binId?: string | null } = {}) {
  const t = await transferOf(c, scope.entityId, id);
  need(t.status === "in_transit", `transfer ${t.number} is ${t.status.replace("_", " ")}, not in transit`);
  const bin = await binAt(c, scope.entityId, e.binId, t.to_location_id);
  const lines = await q<{ product_id: string; qty: string; unit_ids: string[]; cost_minor: string }>(c,
    `select product_id, qty, unit_ids, cost_minor from inv_transfer_line where entity_id = $1 and transfer_id = $2`, [scope.entityId, id]);
  let value = 0n;
  for (const l of lines) {
    const qty = Number(l.qty);
    if (l.unit_ids.length) {
      for (const u of l.unit_ids) await transitionUnit(c, scope.entityId, scope.actor.id || null, u, "in_stock",
        { kind: "transfer_in", toLocation: t.to_location_id, toBin: bin, refType: "transfer", refId: id, transferId: null });
    } else {
      await bump(c, scope.entityId, l.product_id, t.to_location_id, { onHand: qty });
      if (bin) await binStockAdd(c, scope.entityId, bin, l.product_id, qty);
      await logMove(c, scope.entityId, { kind: "transfer_in", productId: l.product_id, qty, toLoc: t.to_location_id, toBin: bin, fromStatus: "in_transit",
        toStatus: "in_stock", refType: "transfer", refId: id, by: scope.actor.id });
    }
    value += BigInt(Math.round(qty * Number(l.cost_minor)));
  }
  await c.query(`update inv_transfer set status = 'received', received_by = $3, received_at = now() where id = $1 and entity_id = $2`, [id, scope.entityId, scope.actor.id || null]);
  if (value > 0n) {
    const po = await profitObjectFor(c, scope.entityId, t.to_location_id);
    await post(c, scope, { date: today(), sourceType: "inventory", sourceId: id, description: `Transfer ${t.number} received`,
      lines: [{ code: "1300", debit: value, profitObjectId: po }, { code: "1310", credit: value, profitObjectId: po }] });
  }
  return { number: t.number, valueMinor: value };
}

export async function cancelTransfer(c: Client, scope: Scope, id: string) {
  const t = await transferOf(c, scope.entityId, id);
  need(t.status === "draft", "only a transfer that has not shipped can be cancelled");
  await c.query(`update inv_transfer set status = 'cancelled' where id = $1 and entity_id = $2`, [id, scope.entityId]);
}

async function transferOf(c: Client, entityId: string, id: string) {
  const r = await q<{ id: string; number: string; status: string; from_location_id: string; to_location_id: string }>(c,
    `select id, number, status, from_location_id, to_location_id from inv_transfer where id = $1 and entity_id = $2 for update`, [id, entityId]);
  need(r.length, "no such transfer");
  return r[0];
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
  bins: { bin: string; qty: number }[]; short: number; cubicFt: number; weightLb: number };

/**
 * The pick list for one or more orders: every open stock line, the exact
 * pieces to pull (allocating the oldest free units to lines that have none
 * yet) and where they sit. Fleet calls this to load a truck; a line that
 * cannot be covered shows its shortfall rather than failing the list.
 */
export async function pickListFor(c: Client, entityId: string, orderIds: string[]):
  Promise<{ lines: PickLine[]; pieces: number; cubicFt: number; weightLb: number; short: number }> {
  if (!orderIds.length) return { lines: [], pieces: 0, cubicFt: 0, weightLb: 0, short: 0 };
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
      qty, locationId: r.fulfil_from_id, location: r.location, serialized: r.serialized, pieces: [], bins: [], short: 0, cubicFt: 0, weightLb: 0 };
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
  return { lines: out, pieces, cubicFt: Math.round(cube * 100) / 100, weightLb: Math.round(weight * 100) / 100, short };
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
  for (const u of out) need(/^https:\/\/\S+$/i.test(u) && u.length <= 1000, "photo links must be https addresses");
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
    je = await postValue(c, scope, d.location_id, -BigInt(Math.round(qty * Number(d.cost_minor))), d.id,
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
          await transitionUnit(c, scope.entityId, me, u.unit_id, "written_off", { kind: "count", refType: "count", refId: id, reason: `not found in count ${ct.number}`, salesOrderLineId: null });
          value -= BigInt(l.unit_cost_minor);
        }
        const found = await q<{ unit_id: string; location_id: string; status: string }>(c, `select unit_id, min(location_id::text)::uuid location_id, min(status) status from inv_piece
          where entity_id = $1 and upper(label) = any($2) and not (upper(label) = any($3)) group by unit_id`,
          [scope.entityId, [...scanned], l.expected_labels.map((x) => x.toUpperCase())]);
        for (const u of found) {
          const sameHere = u.location_id === ct.location_id && COUNTABLE.includes(u.status);
          await transitionUnit(c, scope.entityId, me, u.unit_id, sameHere ? u.status : "in_stock", { kind: "count", toLocation: ct.location_id, toBin: ct.bin_id,
            refType: "count", refId: id, reason: `found in count ${ct.number}` });
          if (!sameHere) value += BigInt(l.unit_cost_minor);
        }
      } else if (delta < 0) {
        const units = await q<{ unit_id: string }>(c, `select unit_id from inv_piece where entity_id = $1 and label = any($2)
          group by unit_id order by bool_or(sales_order_line_id is not null), max(created_at) desc limit $3`, [scope.entityId, l.expected_labels, -delta]);
        for (const u of units) {
          await transitionUnit(c, scope.entityId, me, u.unit_id, "written_off", { kind: "count", refType: "count", refId: id, reason: `short in count ${ct.number}`, salesOrderLineId: null });
          value -= BigInt(l.unit_cost_minor);
        }
      } else if (delta > 0) {
        const p = await productOf(c, scope.entityId, l.product_id);
        await createUnits(c, scope.entityId, p, { locationId: ct.location_id, binId: ct.bin_id, qty: delta, status: "in_stock", costMinor: BigInt(l.unit_cost_minor),
          kind: "count", refType: "count", refId: id, reason: `over in count ${ct.number}`, by: me });
        await bump(c, scope.entityId, l.product_id, ct.location_id, { onHand: delta });
        value += BigInt(delta) * BigInt(l.unit_cost_minor);
      }
    } else if (delta !== 0) {
      await bump(c, scope.entityId, l.product_id, ct.location_id, { onHand: delta });
      if (ct.bin_id) await c.query(`insert into inv_bin_stock (entity_id, bin_id, product_id, qty) values ($1,$2,$3,$4)
        on conflict (bin_id, product_id) do update set qty = $4`, [scope.entityId, ct.bin_id, l.product_id, l.counted_qty]);
      await logMove(c, scope.entityId, { kind: "count", productId: l.product_id, qty: delta, fromLoc: ct.location_id, toLoc: ct.location_id, toBin: ct.bin_id,
        refType: "count", refId: id, reason: `count ${ct.number}`, by: me });
      value += BigInt(Math.round(delta * Number(l.unit_cost_minor)));
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
      const made = await createUnits(c, scope.entityId, p, { locationId: e.locationId, binId: bin, qty, status: "in_stock", costMinor: BigInt(p.cost_minor),
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
  const value = BigInt(Math.round(qty * Number(p.cost_minor)));
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
     where l.entity_id = $1 and l.status = 'active' and l.kind <> 'web'
     order by case l.kind when 'warehouse' then 0 else 1 end, l.name`, [entityId, productId]);
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
  const availableNow = locs.reduce((a, x) => a + Math.max(0, Number(x.available)), 0);
  return {
    product: { id: p.id, sku: p.sku, name: p.name, serialized: p.serialized },
    locations: locs.map((x) => ({ locationId: x.location_id, name: x.name, kind: x.kind, onHand: Number(x.on_hand), reserved: Number(x.reserved),
      held: Number(x.held), available: Number(x.available), onOrder: Number(x.on_order) })),
    availableNow, asIs: Number(asIs[0].n), nextPurchaseOrder: next,
    promise: availableNow > 0 ? "now" : next?.expectedOn ? next.expectedOn : next ? "on order, no date yet" : "not available",
  };
}

/** What stock is worth at cost, by location and category. */
export async function valuation(c: Client, entityId: string) {
  const rows = await q<{ location_id: string; location: string; category: string; units: string; value_minor: string; held_units: string; held_minor: string }>(c, `
    select l.id location_id, l.name location, coalesce(p.category,'Uncategorised') category,
           sum(s.on_hand)::text units, sum(round(s.on_hand * p.cost_minor))::bigint::text value_minor,
           sum(s.held)::text held_units, sum(round(s.held * p.cost_minor))::bigint::text held_minor
      from stock_level s join product p on p.id = s.product_id join location l on l.id = s.location_id
     where s.entity_id = $1 and s.on_hand <> 0
     group by l.id, l.name, p.category order by l.name, category`, [entityId]);
  const transit = await q<{ v: string }>(c, `select coalesce(sum(round(tl.qty * tl.cost_minor)),0)::bigint::text v from inv_transfer_line tl
     join inv_transfer t on t.id = tl.transfer_id where tl.entity_id = $1 and t.status = 'in_transit'`, [entityId]);
  const total = rows.reduce((a, r) => a + BigInt(r.value_minor), 0n);
  return { rows, totalMinor: total, inTransitMinor: BigInt(transit[0].v) };
}

// ---------------------------------------------------------------------------
// Purchasing appends its on-order helper below this line.
