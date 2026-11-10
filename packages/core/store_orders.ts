// Store orders: the catalog app's buying flow inside the ERP. A store builds
// a cart for one vendor; the vendor's freight minimums (overall, by
// category or by brand, counted in pieces or in cost) must be met before it
// can be submitted; a district manager or the purchasing director approves
// it (never the person who submitted it); approving places the purchase
// order through purchasing's createPO, so budgets, ATP lead times and
// special-order rules all apply; the PO then goes to the vendor by the
// trading partner's channel (EDI 850, the vendor's API, email or a file).

import { q, one, audit, type Client, type Scope } from "./db.ts";
import * as pur from "./purchasing.ts";

export class StoreOrderError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new StoreOrderError(msg); };
const money = (m: bigint) => `$${(m / 100n).toLocaleString("en-US")}.${String(m % 100n).padStart(2, "0")}`;

// ------------------------------------------------------ freight minimums --

export type FreightMin = { id?: string | null; vendorId: string; scope: "all" | "category" | "brand"; scopeValue?: string | null; measure: "qty" | "cost"; minimum: bigint; active?: boolean };

export async function saveFreightMin(c: Client, s: Scope, f: FreightMin) {
  need(["all", "category", "brand"].includes(f.scope), "a freight minimum covers the whole order, a category or a brand");
  need(["qty", "cost"].includes(f.measure), "a freight minimum counts pieces or cost");
  need(f.minimum > 0n, "say the minimum");
  const val = f.scope === "all" ? null : String(f.scopeValue ?? "").trim();
  need(f.scope === "all" || val, `say which ${f.scope}`);
  const v = (await q(c, `select 1 from vendor_entity where entity_id = $1 and vendor_id = $2 and status = 'active'`, [s.entityId, f.vendorId]))[0];
  need(v, "that vendor is not set up for this company");
  let id = f.id ?? null;
  if (id) {
    const r = await q(c, `update vendor_freight_min set scope = $4, scope_value = $5, measure = $6, minimum = $7, active = $8 where id = $1 and entity_id = $2 and vendor_id = $3 returning id`,
      [id, s.entityId, f.vendorId, f.scope, val, f.measure, f.minimum.toString(), f.active !== false]);
    need(r.length, "no such freight minimum for this vendor");
  } else {
    id = (await one<{ id: string }>(c, `insert into vendor_freight_min (entity_id, vendor_id, scope, scope_value, measure, minimum, active) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [s.entityId, f.vendorId, f.scope, val, f.measure, f.minimum.toString(), f.active !== false])).id;
  }
  await audit(c, s, { table: "vendor_freight_min", rowId: id!, action: f.id ? "update" : "insert", after: { ...f, minimum: f.minimum.toString() } });
  return id!;
}

export async function freightMins(c: Client, entityId: string, vendorId: string) {
  return q<{ id: string; scope: string; scope_value: string | null; measure: string; minimum: string; active: boolean }>(c,
    `select id, scope, scope_value, measure, minimum, active from vendor_freight_min where entity_id = $1 and vendor_id = $2 order by scope, scope_value`, [entityId, vendorId]);
}

export type FreightCheck = { rule: string; measure: string; have: string; minimum: string; ok: boolean; message: string };

const norm = (v: string | null | undefined) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
/** The names one rule pools: "Dining, Bedroom / Youth and Accents" is four. */
export function ruleNames(value: string | null | undefined): string[] {
  return String(value ?? "").split(/[,;/]|\band\b|\bor\b/i).map((x) => x.trim()).filter((x) => x && !/^total\b/i.test(x));
}
/**
 * The catalog app's loose match: case and punctuation ignored, a trailing S
 * ignored (Chair matches Chairs), and either name inside the other
 * (Dining matches Dining Room).
 */
export function looseMatch(itemValue: string | null | undefined, names: string[]): boolean {
  const ic = norm(itemValue);
  if (!ic) return false;
  for (const n of names) {
    const r = norm(n);
    if (!r) continue;
    const rs = r.replace(/S$/, ""), is = ic.replace(/S$/, "");
    if (ic === r || is === rs || ic.includes(rs) || rs.includes(is)) return true;
  }
  return false;
}

/**
 * The vendor's freight minimums against a cart, as the catalog app counts
 * them: a category or brand rule (which may pool several, "Dining, Bedroom")
 * counts the cart's items that match it, loosely; the vendor's general
 * minimum counts the other items, those no category or brand rule took.
 * Pieces or cost, per rule.
 */
export async function freightCheck(c: Client, entityId: string, vendorId: string, lines: { productId: string; qty: number }[]): Promise<FreightCheck[]> {
  const rules = (await freightMins(c, entityId, vendorId)).filter((r) => r.active);
  const vp = (await q<{ freight_min_minor: string; freight_min_qty: number }>(c, `select freight_min_minor, freight_min_qty from vendor_profile where entity_id = $1 and vendor_id = $2`, [entityId, vendorId]))[0];
  if (vp && BigInt(vp.freight_min_minor) > 0n && !rules.some((r) => r.scope === "all" && r.measure === "cost")) rules.push({ id: "profile-cost", scope: "all", scope_value: null, measure: "cost", minimum: vp.freight_min_minor, active: true });
  if (vp && vp.freight_min_qty > 0 && !rules.some((r) => r.scope === "all" && r.measure === "qty")) rules.push({ id: "profile-qty", scope: "all", scope_value: null, measure: "qty", minimum: String(vp.freight_min_qty), active: true });
  if (!rules.length || !lines.length) return [];
  const prods = new Map((await q<{ id: string; category: string | null; brand: string | null; cost_minor: string }>(c,
    `select id, category, brand, cost_minor from product where entity_id = $1 and id = any($2)`, [entityId, lines.map((l) => l.productId)])).map((p) => [p.id, p]));
  const scoped = rules.filter((r) => r.scope !== "all");
  const general = rules.filter((r) => r.scope === "all");
  const taken = new Set<number>();
  const out: FreightCheck[] = [];
  const check = (label: string, r: { measure: string; minimum: string }, mine: { productId: string; qty: number }[]) => {
    if (r.measure === "qty") {
      const have = mine.reduce((a, l) => a + l.qty, 0), min = Number(r.minimum);
      out.push({ rule: label, measure: "qty", have: String(have), minimum: String(min), ok: have >= min,
        message: have >= min ? `${label}: ${have} pieces, minimum ${min}` : `${label} needs ${min} pieces for the freight minimum; the cart has ${have} (${min - have} more to go)` });
    } else {
      const have = mine.reduce((a, l) => a + BigInt(Math.round(l.qty * Number(prods.get(l.productId)?.cost_minor ?? 0))), 0n), min = BigInt(r.minimum);
      out.push({ rule: label, measure: "cost", have: have.toString(), minimum: min.toString(), ok: have >= min,
        message: have >= min ? `${label}: ${money(have)}, minimum ${money(min)}` : `${label} needs ${money(min)} at cost for the freight minimum; the cart has ${money(have)} (${money(min - have)} more to go)` });
    }
  };
  for (const r of scoped) {
    const names = ruleNames(r.scope_value);
    const mine: { productId: string; qty: number }[] = [];
    lines.forEach((l, i) => {
      const p = prods.get(l.productId);
      if (!p) return;
      if (looseMatch(r.scope === "category" ? p.category : p.brand, names)) { mine.push(l); taken.add(i); }
    });
    if (mine.length) check(`${names.join(", ")} (${r.scope})`, r, mine);
  }
  const others = lines.filter((_l, i) => !taken.has(i));
  if (others.length) for (const r of general) check(taken.size ? "other items" : "the order", r, others);
  return out;
}

// ------------------------------------------------------------ the order --

type Row = { id: string; number: string; status: string; location_id: string; vendor_id: string; created_by: string | null; submitted_by: string | null; purchase_order_id: string | null };
async function orderFor(c: Client, entityId: string, id: string, lock = true): Promise<Row> {
  const r = (await q<Row>(c, `select id, number, status, location_id, vendor_id, created_by, submitted_by, purchase_order_id from store_order
                               where id = $1 and entity_id = $2 ${lock ? "for update" : ""}`, [id, entityId]))[0];
  need(r, "no such store order");
  return r;
}
async function linesOf(c: Client, entityId: string, id: string) {
  return q<{ id: string; product_id: string; qty: string; note: string | null }>(c,
    `select id, product_id, qty, note from store_order_line where entity_id = $1 and store_order_id = $2 and active order by created_at`, [entityId, id]);
}

async function checkLines(c: Client, entityId: string, vendorId: string, lines: { productId: string; qty: number }[]) {
  need(lines.length <= 300, "300 lines at most on one store order");
  const ids = lines.map((l) => l.productId);
  const prods = new Map((await q<{ id: string; name: string; vendor_id: string | null; status: string; kind: string }>(c,
    `select id, name, vendor_id, status, kind from product where entity_id = $1 and id = any($2)`, [entityId, ids])).map((p) => [p.id, p]));
  for (const l of lines) {
    const p = prods.get(l.productId);
    need(p, "a line names a product this company does not carry");
    need(p!.vendor_id === vendorId, `${p!.name} is bought from another vendor; a cart holds one vendor`);
    need(p!.status === "active", `${p!.name} is ${p!.status}, not orderable`);
    need(p!.kind === "stock", `${p!.name} is not a stock item; order it through a special order`);
    need(Number.isFinite(l.qty) && l.qty > 0 && l.qty <= 10000, `order a positive quantity of ${p!.name}`);
  }
}

/** A new cart for one store and one vendor (a draft). */
export async function createStoreOrder(c: Client, s: Scope, o: { locationId: string; vendorId: string; note?: string | null; lines?: { productId: string; qty: number; note?: string | null }[] }) {
  const loc = (await q<{ name: string; status: string }>(c, `select name, status from location where id = $1 and entity_id = $2`, [o.locationId, s.entityId]))[0];
  need(loc, "no such store or warehouse");
  need(loc.status === "active", `${loc.name} is closed`);
  const v = (await q(c, `select 1 from vendor_entity ve where ve.entity_id = $1 and ve.vendor_id = $2 and ve.status = 'active'
                          and exists (select 1 from vendor_merchandise vm where vm.entity_id = ve.entity_id and vm.vendor_id = ve.vendor_id and vm.is_merchandise)`, [s.entityId, o.vendorId]))[0];
  need(v, "that vendor is not an active merchandise vendor for this company");
  const lines = (o.lines ?? []).filter((l) => Number(l.qty) > 0).map((l) => ({ ...l, qty: Number(l.qty) }));
  await checkLines(c, s.entityId, o.vendorId, lines);
  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'store_order', 'RQ-') n /* unscoped: the numbering function is keyed by the entity it is given */`, [s.entityId])).n;
  const so = await one<{ id: string }>(c, `insert into store_order (entity_id, number, location_id, vendor_id, note, created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
    [s.entityId, number, o.locationId, o.vendorId, o.note?.trim().slice(0, 500) || null, s.actor.id || null]);
  for (const l of lines) await c.query(`insert into store_order_line (entity_id, store_order_id, product_id, qty, note) values ($1,$2,$3,$4,$5)`,
    [s.entityId, so.id, l.productId, l.qty, l.note?.trim().slice(0, 200) || null]);
  await audit(c, s, { table: "store_order", rowId: so.id, action: "insert", after: { number, location: loc.name, lines: lines.length } });
  return { id: so.id, number };
}

/** Change a draft's lines: the cart as it should be now. Old lines are switched off, not deleted. */
export async function setStoreOrderLines(c: Client, s: Scope, id: string, lines: { productId: string; qty: number; note?: string | null }[]) {
  const o = await orderFor(c, s.entityId, id);
  need(o.status === "draft", `${o.number} is ${o.status}; only a draft's cart changes (send it back to draft first)`);
  const ls = (lines ?? []).filter((l) => Number(l.qty) > 0).map((l) => ({ ...l, qty: Number(l.qty) }));
  await checkLines(c, s.entityId, o.vendor_id, ls);
  await c.query(`update store_order_line set active = false where entity_id = $1 and store_order_id = $2 and active`, [s.entityId, id]);
  for (const l of ls) await c.query(`insert into store_order_line (entity_id, store_order_id, product_id, qty, note) values ($1,$2,$3,$4,$5)`,
    [s.entityId, id, l.productId, l.qty, l.note?.trim().slice(0, 200) || null]);
  await audit(c, s, { table: "store_order", rowId: id, action: "update", after: { lines: ls.length } });
  return { lines: ls.length, freight: await freightCheck(c, s.entityId, o.vendor_id, ls) };
}

/** Submit for approval: refused while a freight minimum is not met, as the catalog app does. */
export async function submitStoreOrder(c: Client, s: Scope, id: string) {
  const o = await orderFor(c, s.entityId, id);
  need(o.status === "draft", `${o.number} is ${o.status}; only a draft is submitted`);
  const lines = await linesOf(c, s.entityId, id);
  need(lines.length, "put at least one item in the cart");
  const ls = lines.map((l) => ({ productId: l.product_id, qty: Number(l.qty) }));
  await checkLines(c, s.entityId, o.vendor_id, ls);
  const fr = await freightCheck(c, s.entityId, o.vendor_id, ls);
  const short = fr.filter((x) => !x.ok);
  need(!short.length, `cannot submit: freight minimum not met. ${short.map((x) => x.message).join("; ")}`);
  await c.query(`update store_order set status = 'submitted', submitted_by = $3, submitted_at = now() where id = $1 and entity_id = $2`, [id, s.entityId, s.actor.id || null]);
  await audit(c, s, { table: "store_order", rowId: id, action: "transition", before: { status: "draft" }, after: { status: "submitted" } });
  return { number: o.number, freight: fr };
}

/** Send a submitted order back to draft so the store can change it (the catalog app's "Revert to edit"). */
export async function returnToDraft(c: Client, s: Scope, id: string, reason: string, decider = false) {
  const o = await orderFor(c, s.entityId, id);
  need(o.status === "submitted", `${o.number} is ${o.status}; only a submitted order goes back to draft`);
  need(reason && reason.trim(), "say why it goes back, so the store knows what to change");
  // An approver may send any order back; a store's own people only their store's (who started or submitted it, or who works there).
  if (!decider) {
    const mine = o.created_by === s.actor.id || o.submitted_by === s.actor.id || (await q(c, `
      select 1 from employee e join profit_object po on po.id = e.profit_object_id and po.entity_id = e.entity_id
       where e.entity_id = $1 and e.app_user_id = $2 and po.location_id = $3 and e.status = 'active'`, [s.entityId, s.actor.id ?? null, o.location_id])).length > 0;
    need(mine, `${o.number} is another store's order; only its own store or an approver can send it back`);
  }
  await c.query(`update store_order set status = 'draft', submitted_by = null, submitted_at = null, decision_note = $3 where id = $1 and entity_id = $2`, [id, s.entityId, reason.trim().slice(0, 300)]);
  await audit(c, s, { table: "store_order", rowId: id, action: "transition", before: { status: "submitted" }, after: { status: "draft" }, reason });
  return { number: o.number };
}

/**
 * Approve: place the PO (one vendor, the store as ship-to) through
 * purchasing, then send it by the partner's channel when the partner says
 * so. A send that fails leaves the PO placed and says why; it can be sent
 * again from the PO.
 */
export async function approveStoreOrder(c: Client, s: Scope, id: string, a: { note?: string | null; overBudgetReason?: string | null; expectedOn?: string | null },
  mayOverride: boolean, send: (poId: string) => Promise<{ channel: string; status: string; detail: string } | null>, refused: (e: unknown) => boolean = () => false) {
  const o = await orderFor(c, s.entityId, id);
  need(o.status === "submitted", `${o.number} is ${o.status}; only a submitted order is approved`);
  need(!s.actor.id || o.submitted_by !== s.actor.id, "whoever submitted a store order cannot also approve it");
  need(!s.actor.id || o.created_by !== s.actor.id, "whoever built a store order's cart cannot also approve it");
  const lines = await linesOf(c, s.entityId, id);
  need(lines.length, "the order has no lines");
  let placed: pur.Placed;
  try {
    placed = await pur.createPO(c, s, { vendorId: o.vendor_id, shipToId: o.location_id, kind: "stock", expectedOn: a.expectedOn || null, overBudgetReason: a.overBudgetReason ?? null,
      lines: lines.map((l) => ({ productId: l.product_id, qty: Number(l.qty), note: l.note, agreementRef: o.number })) }, mayOverride);
  } catch (e) {
    if (e instanceof pur.PurchasingError) throw new StoreOrderError(e.message);
    throw e;
  }
  await c.query(`update store_order set status = 'approved', decided_by = $3, decided_at = now(), decision_note = $4, purchase_order_id = $5 where id = $1 and entity_id = $2`,
    [id, s.entityId, s.actor.id || null, a.note?.trim().slice(0, 300) || null, placed.poId]);
  await audit(c, s, { table: "store_order", rowId: id, action: "transition", before: { status: "submitted" }, after: { status: "approved", po: placed.number } });
  let sent: { channel: string; status: string; detail: string } | null = null;
  await c.query("savepoint store_send");
  try { sent = await send(placed.poId); await c.query("release savepoint store_send"); }
  catch (e) {
    await c.query("rollback to savepoint store_send");
    if (!refused(e)) throw e;
    sent = { channel: "none", status: "not sent", detail: `approved and placed, but not sent: ${(e as Error).message}` };
  }
  return { number: o.number, po: { ...placed, totalMinor: placed.totalMinor.toString() }, sent };
}

export async function rejectStoreOrder(c: Client, s: Scope, id: string, reason: string) {
  const o = await orderFor(c, s.entityId, id);
  need(o.status === "submitted", `${o.number} is ${o.status}; only a submitted order is turned down`);
  need(reason && reason.trim(), "say why it is turned down");
  need(!s.actor.id || (o.submitted_by !== s.actor.id && o.created_by !== s.actor.id), "whoever built or submitted a store order cannot also decide it");
  await c.query(`update store_order set status = 'rejected', decided_by = $3, decided_at = now(), decision_note = $4 where id = $1 and entity_id = $2`, [id, s.entityId, s.actor.id || null, reason.trim().slice(0, 300)]);
  await audit(c, s, { table: "store_order", rowId: id, action: "transition", before: { status: "submitted" }, after: { status: "rejected" }, reason });
  return { number: o.number };
}

export async function cancelStoreOrder(c: Client, s: Scope, id: string, reason: string) {
  const o = await orderFor(c, s.entityId, id);
  need(o.status === "draft" || o.status === "submitted", `${o.number} is ${o.status}; it cannot be cancelled here`);
  need(reason && reason.trim(), "say why it is cancelled");
  await c.query(`update store_order set status = 'cancelled', decision_note = $3 where id = $1 and entity_id = $2`, [id, s.entityId, reason.trim().slice(0, 300)]);
  await audit(c, s, { table: "store_order", rowId: id, action: "transition", before: { status: o.status }, after: { status: "cancelled" }, reason });
  return { number: o.number };
}

export async function listStoreOrders(c: Client, entityId: string, f: { status?: string | null; locationId?: string | null } = {}) {
  return q(c, `
    select so.id, so.number, so.status, so.created_at, so.submitted_at, so.decided_at, so.decision_note, so.note,
           l.name location, so.location_id, coalesce(v.dba, v.legal_name) vendor, so.vendor_id, po.number po_number, so.purchase_order_id,
           cu.name created_by_name, su.name submitted_by_name, du.name decided_by_name,
           t.lines, t.units, t.cost_minor
      from store_order so join location l on l.id = so.location_id join vendor v on v.id = so.vendor_id
      left join purchase_order po on po.id = so.purchase_order_id
      left join app_user cu on cu.id = so.created_by left join app_user su on su.id = so.submitted_by left join app_user du on du.id = so.decided_by
      left join lateral (select count(*) lines, coalesce(sum(x.qty), 0) units, coalesce(sum(round(x.qty * p.cost_minor)), 0)::bigint cost_minor
                           from store_order_line x join product p on p.id = x.product_id where x.store_order_id = so.id and x.entity_id = so.entity_id and x.active) t on true
     where so.entity_id = $1 and ($2::text is null or so.status = $2) and ($3::uuid is null or so.location_id = $3)
     order by so.created_at desc limit 200`, [entityId, f.status || null, f.locationId || null]);
}

export async function storeOrderDetail(c: Client, entityId: string, id: string) {
  const o = (await listStoreOrders(c, entityId)).find((x) => (x as { id: string }).id === id)
    ?? (await q(c, `select so.*, l.name location, coalesce(v.dba, v.legal_name) vendor from store_order so join location l on l.id = so.location_id join vendor v on v.id = so.vendor_id
                     where so.id = $1 and so.entity_id = $2`, [id, entityId]))[0];
  if (!o) return null;
  const row = o as { vendor_id: string };
  const lines = await q<{ id: string; product_id: string; sku: string; name: string; category: string | null; brand: string | null; qty: string; cost_minor: string; note: string | null }>(c, `
    select x.id, x.product_id, p.sku, p.name, p.category, p.brand, x.qty, p.cost_minor, x.note
      from store_order_line x join product p on p.id = x.product_id where x.entity_id = $1 and x.store_order_id = $2 and x.active order by x.created_at`, [entityId, id]);
  return { order: o, lines, freight: await freightCheck(c, entityId, row.vendor_id, lines.map((l) => ({ productId: l.product_id, qty: Number(l.qty) }))) };
}
