// Inventory: the only writer of stock_level. Owned by the inventory module,
// which extends this file (bins, pieces, transfers, counts, damage). The
// exported functions below are the contract other modules call -- POS and
// the web store to reserve, delivery and pickup to fulfil, returns to
// restock. Keep their signatures.

import { q, type Client } from "./db.ts";

export class InventoryError extends Error {}

async function bump(c: Client, entityId: string, productId: string, locationId: string,
  d: { onHand?: number; reserved?: number; onOrder?: number }) {
  await c.query(
    `insert into stock_level (entity_id, product_id, location_id, on_hand, reserved, on_order)
     values ($1,$2,$3,$4,greatest($5,0),greatest($6,0))
     on conflict (entity_id, product_id, location_id) do update set
       on_hand = stock_level.on_hand + $4,
       reserved = greatest(stock_level.reserved + $5, 0),
       on_order = greatest(stock_level.on_order + $6, 0),
       updated_at = now()`,
    [entityId, productId, locationId, d.onHand ?? 0, d.reserved ?? 0, d.onOrder ?? 0]);
}

/**
 * Reserve stock for an order's open stock lines at their fulfil-from
 * location. A line that cannot be covered is marked on_order (a special or
 * back order for purchasing to pick up) rather than over-reserved.
 */
export async function reserveOrder(c: Client, entityId: string, orderId: string): Promise<{ reserved: number; shortLines: number }> {
  const lines = await q<{ id: string; product_id: string; qty: string; fulfil_from_id: string | null; kind: string; available: string | null }>(c, `
    select l.id, l.product_id, l.qty, l.fulfil_from_id, p.kind,
           (select s.on_hand - s.reserved from stock_level s
             where s.entity_id = l.entity_id and s.product_id = l.product_id and s.location_id = l.fulfil_from_id) available
      from sales_order_line l join product p on p.id = l.product_id
     where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status = 'open' and l.qty > 0
     order by l.seq for update of l`, [entityId, orderId]);
  let reserved = 0, short = 0;
  for (const l of lines) {
    if (!["stock", "configurable", "special_order"].includes(l.kind)) continue;
    const qty = Number(l.qty);
    if (l.kind === "stock" && l.fulfil_from_id && Number(l.available ?? 0) >= qty) {
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
 */
export async function fulfilLines(c: Client, entityId: string, orderId: string, lineIds: string[] | "all"):
  Promise<{ lines: number; costMinor: bigint }> {
  const lines = await q<{ id: string; product_id: string | null; qty: string; fulfil_from_id: string | null; line_status: string; kind: string | null; cost_minor: string | null }>(c, `
    select l.id, l.product_id, l.qty, l.fulfil_from_id, l.line_status, p.kind, p.cost_minor
      from sales_order_line l left join product p on p.id = l.product_id
     where l.entity_id = $1 and l.sales_order_id = $2
       and l.line_status in ('open','reserved','ready','on_order') and l.qty > 0
       and ($3::uuid[] is null or l.id = any($3))
     for update of l`, [entityId, orderId, lineIds === "all" ? null : lineIds]);
  let cost = 0n;
  for (const l of lines) {
    const stocked = l.product_id && ["stock", "configurable", "special_order"].includes(l.kind ?? "");
    if (stocked) {
      if (!l.fulfil_from_id) throw new InventoryError("a line has no location to fulfil from");
      const qty = Number(l.qty);
      await bump(c, entityId, l.product_id!, l.fulfil_from_id, {
        onHand: -qty, reserved: l.line_status === "reserved" || l.line_status === "ready" ? -qty : 0 });
      cost += BigInt(Math.round(qty * Number(l.cost_minor ?? 0)));
    }
    await c.query(`update sales_order_line set line_status = 'fulfilled' where id = $1 and entity_id = $2`, [l.id, entityId]);
  }
  return { lines: lines.length, costMinor: cost };
}

/** Release reservations on cancelled lines. */
export async function releaseLines(c: Client, entityId: string, orderId: string, lineIds: string[] | "all"): Promise<number> {
  const lines = await q<{ id: string; product_id: string; qty: string; fulfil_from_id: string }>(c, `
    select id, product_id, qty, fulfil_from_id from sales_order_line
     where entity_id = $1 and sales_order_id = $2 and line_status in ('reserved','ready')
       and ($3::uuid[] is null or id = any($3)) for update`, [entityId, orderId, lineIds === "all" ? null : lineIds]);
  for (const l of lines) await bump(c, entityId, l.product_id, l.fulfil_from_id, { reserved: -Number(l.qty) });
  return lines.length;
}

/** Goods coming back: add to on hand at a location (restockable) or not (damaged goes to the damage flow). */
export async function restock(c: Client, entityId: string, productId: string, locationId: string, qty: number): Promise<void> {
  if (qty <= 0) throw new InventoryError("restock a positive quantity");
  await bump(c, entityId, productId, locationId, { onHand: qty });
}

/** Low-level adjust, for the inventory module's own receiving/transfer/count code. */
export const _bump = bump;

/**
 * Goods placed on (qty > 0) or taken off (qty < 0) a purchase order for a
 * location. Purchasing calls this when a PO is placed, cancelled or cut back
 * by the vendor; receiving lowers it through its own code.
 */
export async function addOnOrder(c: Client, entityId: string, productId: string, locationId: string, qty: number): Promise<void> {
  if (!Number.isFinite(qty) || qty === 0) throw new InventoryError("on-order changes by a non-zero quantity");
  await bump(c, entityId, productId, locationId, { onOrder: qty });
}
