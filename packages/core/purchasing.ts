// Purchasing: the owner's buying program. Budgets and open-to-buy, the
// order form that becomes one PO per vendor per ship-to, the special-order
// queue that turns customers' on-order lines into vendor POs, vendor
// acknowledgments whose dates flow back to the customer's order, landed
// cost, reorder points, and the CSV files a vendor sends and receives.
//
// on_order moves only through inventory.ts addOnOrder. Receiving (on hand,
// on_order down) is the inventory module's.

import { q, one, audit, type Client, type Scope } from "./db.ts";
import { addOnOrder } from "./inventory.ts";
import { priceConfigured, PricingError, type Choice } from "./pricing.ts";
import { profitObjectFor } from "./posting.ts";
import { parseCsv, csvCell } from "./catalog.ts";
import { orderFeedRequest, call, render, FeedError, type FeedEnv } from "./vendor_feeds.ts";

export class PurchasingError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new PurchasingError(msg); };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const money = (m: bigint) => {
  const neg = m < 0n, a = neg ? -m : m;
  return `${neg ? "-" : ""}$${(a / 100n).toLocaleString("en-US")}.${String(a % 100n).padStart(2, "0")}`;
};
const addDays = (iso: string, n: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monthOf = (iso: string) => iso.slice(0, 8) + "01";
const today = () => new Date().toISOString().slice(0, 10);

type Vendor = { id: string; name: string; gl: string | null; lead_days: number; freight_min_minor: string; freight_min_qty: number; order_email: string | null; account_no: string | null };

async function vendorFor(c: Client, s: Scope, vendorId: string): Promise<Vendor> {
  const v = (await q<Vendor>(c, `
    select v.id, coalesce(v.dba, v.legal_name) as name, ve.default_gl_account_id gl,
           coalesce(vp.lead_days, 30) lead_days, coalesce(vp.freight_min_minor, 0) freight_min_minor,
           coalesce(vp.freight_min_qty, 0) freight_min_qty, vp.order_email, vp.account_no
      from vendor_entity ve join vendor v on v.id = ve.vendor_id
      left join vendor_profile vp on vp.vendor_id = v.id and vp.entity_id = ve.entity_id
     where ve.entity_id = $1 and ve.vendor_id = $2 and ve.status = 'active' and v.status = 'active'
       and exists (select 1 from vendor_merchandise vm where vm.entity_id = ve.entity_id and vm.vendor_id = ve.vendor_id and vm.is_merchandise)`, [s.entityId, vendorId]))[0];
  need(v, "that vendor is not active for this company, or is not a merchandise vendor");
  if (!v.gl) {
    // Receiving puts merchandise in inventory (Dr 1300 / Cr 2050); the vendor's
    // bill then clears 2050, so a PO line codes to 2050 unless the vendor says otherwise.
    const g = (await q<{ id: string }>(c, `select id from gl_account where tenant_id = $1 and code = '2050' /* unscoped: chart is tenant-wide */`, [s.tenantId]))[0];
    need(g, "the chart of accounts has no 2050 received-not-invoiced account; apply a setup pack in Business setup");
    v.gl = g.id;
  }
  return v;
}

async function locationFor(c: Client, entityId: string, id: string) {
  const l = (await q<{ id: string; code: string; name: string; status: string; address: Record<string, string> }>(c,
    `select id, code, name, status, address from location where id = $1 and entity_id = $2`, [id, entityId]))[0];
  need(l, "no such store or warehouse");
  need(l.status === "active", `${l.name} is closed`);
  return l;
}

// ----------------------------------------------------------- budgets --

export async function setBudget(c: Client, s: Scope, b: { month: string; category: string; locationId: string; budgetMinor: bigint }) {
  need(DAY.test(b.month ?? "") || /^\d{4}-\d{2}$/.test(b.month ?? ""), "say which month, like 2026-12");
  const month = monthOf(b.month.length === 7 ? b.month + "-01" : b.month);
  need(b.category && b.category.trim(), "a budget is for a category");
  need(b.budgetMinor >= 0n, "a budget cannot be negative");
  await locationFor(c, s.entityId, b.locationId);
  const r = await one<{ id: string }>(c, `
    insert into buying_budget (entity_id, month, category, location_id, budget_minor, set_by) values ($1,$2,$3,$4,$5,$6)
    on conflict (entity_id, month, category, location_id) do update set budget_minor = excluded.budget_minor, set_by = excluded.set_by, set_at = now()
    returning id /* unscoped: an insert of a row carrying entity_id */`, [s.entityId, month, b.category.trim(), b.locationId, b.budgetMinor.toString(), s.actor.id || null]);
  await audit(c, s, { table: "buying_budget", rowId: r.id, action: "update", after: { month, category: b.category, locationId: b.locationId, budgetMinor: b.budgetMinor.toString() } });
  return r.id;
}

export async function openToBuy(c: Client, entityId: string, month: string) {
  return q<{ month: string; category: string; location_id: string; location: string; budget_minor: string; committed_minor: string; open_minor: string }>(c, `
    select o.month::text, o.category, o.location_id, l.name location, o.budget_minor, o.committed_minor, o.open_minor
      from open_to_buy o join location l on l.id = o.location_id
     where o.entity_id = $1 and o.month = $2 order by l.name, o.category`, [entityId, monthOf(month)]);
}

// ------------------------------------------------------------- the PO --

export type LineIn = {
  productId: string; qty: number; config?: Record<string, unknown>; choices?: Choice[];
  salesLineId?: string | null; agreementRef?: string | null; note?: string | null;
};
export type PoIn = { vendorId: string; shipToId: string; kind?: "stock" | "special"; expectedOn?: string | null; lines: LineIn[]; overBudgetReason?: string | null };
export type Placed = { poId: string; number: string; vendor: string; shipTo: string; totalMinor: bigint; expectedOn: string; warnings: string[] };

/**
 * One PO to one vendor for one ship-to. Stock POs spend open-to-buy and are
 * refused over budget unless whoever may override (the owner) gives a reason.
 */
export async function createPO(c: Client, s: Scope, po: PoIn, mayOverride: boolean): Promise<Placed> {
  const kind = po.kind ?? "stock";
  const v = await vendorFor(c, s, po.vendorId);
  const loc = await locationFor(c, s.entityId, po.shipToId);
  need(Array.isArray(po.lines) && po.lines.length, "a purchase order needs at least one line");
  need(po.lines.length <= 500, "500 lines at most on one purchase order");
  const ordered = today();
  if (po.expectedOn) need(DAY.test(po.expectedOn) && po.expectedOn >= ordered, "the expected date is a day from today on");

  type Built = { productId: string; sku: string; vendorSku: string | null; category: string | null; desc: string; qty: number;
    unit: bigint; config: Record<string, unknown>; expected: string; salesLineId: string | null; agreementRef: string | null };
  const built: Built[] = [];
  for (const l of po.lines) {
    need(Number.isFinite(l.qty) && l.qty > 0 && l.qty <= 10000 && Math.round(l.qty * 1000) === l.qty * 1000, "order a positive quantity");
    const p = (await q<{ id: string; sku: string; name: string; kind: string; status: string; vendor_id: string | null; vendor_sku: string | null; category: string | null; cost_minor: string }>(c,
      `select id, sku, name, kind, status, vendor_id, vendor_sku, category, cost_minor from product where id = $1 and entity_id = $2`, [l.productId, s.entityId]))[0];
    need(p, "a line names a product this company does not carry");
    need(p.vendor_id === po.vendorId, `${p.name} is not bought from ${v.name}`);
    need(!["service", "fee", "warranty", "gift_card", "kit"].includes(p.kind), `${p.name} is not something a vendor ships; order a package's pieces instead`);
    need(p.status !== "discontinued", `${p.name} is discontinued`);
    need(p.status !== "drop", `${v.name} has dropped ${p.name}; it cannot be reordered`);
    need(p.status !== "floor_sample" || kind === "special", `${p.name} is a floor sample; it is not reordered as stock`);
    need(kind === "special" || !["configurable", "special_order"].includes(p.kind) || l.choices?.length,
      `${p.name} is made to order; buy it through a special order or give its options`);
    let unit = BigInt(p.cost_minor), lead = 0, desc = p.name;
    let config: Record<string, unknown> = l.config ?? {};
    if (l.choices?.length) {
      try {
        const pc = await priceConfigured(c, s.entityId, p.id, l.choices);
        unit = pc.unitCostMinor; lead = pc.leadDays; desc = pc.description; config = pc.config;
      } catch (e) {
        if (e instanceof PricingError) throw new PurchasingError(e.message);
        throw e;
      }
    }
    const codes = Object.values(config).flat().map((o) => (o as { vendorCode?: string | null }).vendorCode).filter(Boolean);
    if (codes.length) desc += ` [${codes.join(" / ")}]`;
    if (l.note) desc += ` — ${String(l.note).slice(0, 120)}`;
    // What the vendor says it can ship (ATP): enough on hand ships on the usual lead time; short, it ships on theirs.
    const atp = (await q<{ qty_available: string | null; lead_days: number | null }>(c,
      `select qty_available, lead_days from vendor_availability where entity_id = $1 and vendor_id = $2 and upper(vendor_sku) = upper($3)`,
      [s.entityId, po.vendorId, p.vendor_sku ?? ""]))[0];
    if (atp && !(atp.qty_available != null && Number(atp.qty_available) >= l.qty) && atp.lead_days != null) lead = Math.max(lead, atp.lead_days);
    const expected = po.expectedOn || addDays(ordered, Math.max(v.lead_days, lead));
    built.push({ productId: p.id, sku: p.sku, vendorSku: p.vendor_sku, category: p.category, desc: desc.slice(0, 500), qty: l.qty, unit, config,
      expected, salesLineId: l.salesLineId ?? null, agreementRef: l.agreementRef ?? null });
  }
  const total = built.reduce((a, b) => a + BigInt(Math.round(b.qty * Number(b.unit))), 0n);
  const units = built.reduce((a, b) => a + b.qty, 0);
  const expectedOn = po.expectedOn || built.map((b) => b.expected).sort().at(-1)!;
  const warnings: string[] = [];

  // Open-to-buy, per category for the month the goods are due.
  if (kind === "stock") {
    const need_: Map<string, bigint> = new Map();
    for (const b of built) {
      const key = `${monthOf(b.expected)}|${b.category ?? ""}`;
      need_.set(key, (need_.get(key) ?? 0n) + BigInt(Math.round(b.qty * Number(b.unit))));
    }
    const over: string[] = [];
    for (const [key, amt] of need_) {
      const [month, category] = key.split("|");
      if (!category) { warnings.push("some lines have no category, so no budget covers them"); continue; }
      const otb = (await q<{ budget_minor: string; open_minor: string }>(c, `
        select budget_minor, open_minor from open_to_buy where entity_id = $1 and month = $2 and category = $3 and location_id = $4`,
        [s.entityId, month, category, loc.id]))[0];
      if (!otb) { warnings.push(`no ${category} budget is set for ${loc.name} in ${month.slice(0, 7)}`); continue; }
      const open = BigInt(otb.open_minor);
      if (amt > open) over.push(`${category} at ${loc.name} for ${month.slice(0, 7)} has ${money(open)} left to buy and this needs ${money(amt)}`);
    }
    if (over.length) {
      need(mayOverride, `over budget: ${over.join("; ")}. The owner can place it with a reason`);
      need(po.overBudgetReason && po.overBudgetReason.trim(), `over budget: ${over.join("; ")}. Say why it should go anyway`);
      warnings.push(`placed over budget: ${over.join("; ")}`);
    }
  }
  if (BigInt(v.freight_min_minor) > 0n && total < BigInt(v.freight_min_minor)) {
    warnings.push(`${v.name}'s freight minimum is ${money(BigInt(v.freight_min_minor))}; this order is ${money(total)}, so freight may be charged`);
  }
  if (v.freight_min_qty > 0 && units < v.freight_min_qty) warnings.push(`${v.name}'s freight minimum is ${v.freight_min_qty} pieces; this order is ${units}`);

  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'po', 'PO-') n /* unscoped: the numbering function is keyed by the entity it is given */`, [s.entityId])).n;
  const header = await one<{ id: string }>(c, `
    insert into purchase_order (tenant_id, entity_id, vendor_id, number, ordered_on, profit_object_id, status, created_by,
                                ship_to_location_id, expected_on, kind, over_budget_reason)
    values ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11) returning id`,
    [s.tenantId, s.entityId, v.id, number, ordered, await profitObjectFor(c, s.entityId, loc.id), s.actor.id || null,
     loc.id, expectedOn, kind, po.overBudgetReason?.trim() || null]);
  for (const [i, b] of built.entries()) {
    const line = await one<{ id: string }>(c, `
      insert into purchase_order_line (purchase_order_id, seq, description, quantity, unit_price_minor, gl_account_id, agreement_ref,
                                       entity_id, product_id, vendor_sku, category, config, expected_on)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [header.id, i + 1, b.desc, b.qty, b.unit.toString(), v.gl, b.agreementRef, s.entityId, b.productId, b.vendorSku, b.category,
       JSON.stringify(b.config), b.expected]);
    await addOnOrder(c, s.entityId, b.productId, loc.id, b.qty);
    if (b.salesLineId) {
      await c.query(`insert into po_line_sales_line (entity_id, purchase_order_line_id, sales_order_line_id, expected_on) values ($1,$2,$3,$4)`,
        [s.entityId, line.id, b.salesLineId, b.expected]);
    }
  }
  await audit(c, s, { table: "purchase_order", rowId: header.id, action: "insert",
    after: { number, vendor: v.name, shipTo: loc.name, kind, total: total.toString(), lines: built.length, warnings } });
  return { poId: header.id, number, vendor: v.name, shipTo: loc.name, totalMinor: total, expectedOn, warnings };
}

/** The owner's order form: quantities by product and store, one PO per vendor per ship-to, all or nothing. */
export async function placeOrderForm(c: Client, s: Scope, f: { lines: { productId: string; locationId: string; qty: number }[]; expectedOn?: string | null; overBudgetReason?: string | null }, mayOverride: boolean) {
  const lines = (f.lines ?? []).filter((l) => Number(l.qty) > 0);
  need(lines.length, "put a quantity on at least one line");
  const vendors = new Map((await q<{ id: string; vendor_id: string | null; name: string }>(c,
    `select id, vendor_id, name from product where entity_id = $1 and id = any($2)`, [s.entityId, lines.map((l) => l.productId)]))
    .map((p) => [p.id, p]));
  const groups = new Map<string, LineIn[]>();
  for (const l of lines) {
    const p = vendors.get(l.productId);
    need(p, "a line names a product this company does not carry");
    need(p!.vendor_id, `${p!.name} has no vendor to order from`);
    const key = `${p!.vendor_id}|${l.locationId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ productId: l.productId, qty: Number(l.qty) });
  }
  const placed: Placed[] = [];
  for (const [key, ls] of groups) {
    const [vendorId, shipToId] = key.split("|");
    placed.push(await createPO(c, s, { vendorId, shipToId, kind: "stock", expectedOn: f.expectedOn, lines: ls, overBudgetReason: f.overBudgetReason }, mayOverride));
  }
  return placed;
}

// -------------------------------------------------- special-order queue --

export type QueueLine = {
  sales_line_id: string; sales_order_id: string; order_number: string; customer: string | null; ordered_at: string; seq: number;
  product_id: string; sku: string; description: string; qty: string; config: Record<string, unknown>; vendor_id: string | null; vendor: string | null;
  ship_to_id: string; ship_to: string; kind: string; vendor_qty: string | null; vendor_lead_days: number | null;
};

/** Customer lines waiting for a vendor PO: on order, and on no live PO line. */
export async function specialOrderQueue(c: Client, entityId: string): Promise<QueueLine[]> {
  return q<QueueLine>(c, `
    select l.id sales_line_id, so.id sales_order_id, so.number order_number, cu.name customer, so.ordered_at, l.seq,
           p.id product_id, p.sku, l.description, l.qty, l.config, p.vendor_id, coalesce(v.dba, v.legal_name) vendor,
           coalesce(l.fulfil_from_id, so.location_id) ship_to_id, loc.name ship_to, p.kind,
           va.qty_available vendor_qty, va.lead_days vendor_lead_days
      from sales_order_line l
      join sales_order so on so.id = l.sales_order_id and so.entity_id = l.entity_id
      join product p on p.id = l.product_id and p.entity_id = l.entity_id
      left join vendor v on v.id = p.vendor_id
      left join customer cu on cu.id = so.customer_id
      join location loc on loc.id = coalesce(l.fulfil_from_id, so.location_id)
      left join vendor_availability va on va.entity_id = l.entity_id and va.vendor_id = p.vendor_id and upper(va.vendor_sku) = upper(p.vendor_sku)
     where l.entity_id = $1 and l.line_status = 'on_order' and l.qty > 0 and so.status not in ('draft','cancelled')
       and not exists (select 1 from po_line_sales_line k where k.entity_id = $1 and k.sales_order_line_id = l.id and k.active)
     order by so.ordered_at, so.number, l.seq`, [entityId]);
}

/** The choices a POS line stored in config, back into the shape pricing takes. */
export function choicesFromConfig(config: Record<string, unknown>): Choice[] {
  const out: Choice[] = [];
  for (const [group, v] of Object.entries(config ?? {})) {
    if (Array.isArray(v)) {
      const codes = v.map((x) => (typeof x === "string" ? x : (x as { code?: string })?.code)).filter(Boolean) as string[];
      if (codes.length) out.push({ group, option: codes.length === 1 ? codes[0] : codes });
    } else if (typeof v === "string") out.push({ group, option: v });
  }
  return out;
}

/** Turn queued customer lines into vendor POs, one per vendor per ship-to, each line tied to its customer line. */
export async function placeSpecialOrders(c: Client, s: Scope, lineIds: string[]) {
  need(Array.isArray(lineIds) && lineIds.length, "pick the customer lines to order");
  const queue = await specialOrderQueue(c, s.entityId);
  const pick = queue.filter((x) => lineIds.includes(x.sales_line_id));
  need(pick.length === new Set(lineIds).size, "some of those lines are not waiting for a PO (already ordered, or not on order)");
  // lock them, so two buyers cannot order the same customer's sofa twice
  await q(c, `select id from sales_order_line where entity_id = $1 and id = any($2) for update`, [s.entityId, lineIds]);
  const groups = new Map<string, QueueLine[]>();
  for (const x of pick) {
    need(x.vendor_id, `${x.sku} has no vendor to order from`);
    const key = `${x.vendor_id}|${x.ship_to_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(x);
  }
  const placed: Placed[] = [];
  for (const [key, ls] of groups) {
    const [vendorId, shipToId] = key.split("|");
    placed.push(await createPO(c, s, {
      vendorId, shipToId, kind: "special",
      lines: ls.map((x) => {
        const choices = choicesFromConfig(x.config);
        return { productId: x.product_id, qty: Number(x.qty), choices: choices.length ? choices : undefined, config: x.config,
          salesLineId: x.sales_line_id, agreementRef: x.order_number, note: `for ${x.customer ?? "a customer"}, order ${x.order_number}` };
      }),
    }, false));
  }
  return placed;
}

/** When each line of a customer's order is due from the vendor. */
export async function etaForOrder(c: Client, entityId: string, orderId: string) {
  return q<{ sales_order_line_id: string; po_number: string; ack_status: string; expected_on: string | null }>(c, `
    select sales_order_line_id, po_number, ack_status, expected_on::text from sales_line_eta
     where entity_id = $1 and sales_order_id = $2`, [entityId, orderId]);
}

// ------------------------------------------------------- PO lifecycle --

type PoRow = { id: string; number: string; status: string; vendor_id: string; ship_to_location_id: string | null; kind: string };
async function poFor(c: Client, entityId: string, id: string, lock = true): Promise<PoRow> {
  const r = (await q<PoRow>(c, `select id, number, status, vendor_id, ship_to_location_id, kind from purchase_order
                                 where id = $1 and entity_id = $2 ${lock ? "for update" : ""}`, [id, entityId]))[0];
  need(r, "no such purchase order");
  need(r.ship_to_location_id, `${r.number} was entered in payables, not by purchasing; change it there`);
  return r;
}

type LineRow = { id: string; seq: number; product_id: string | null; quantity: string; cancelled_qty: string; received: string; vendor_sku: string | null };
async function linesOf(c: Client, entityId: string, poId: string): Promise<LineRow[]> {
  return q<LineRow>(c, `
    select pol.id, pol.seq, pol.product_id, pol.quantity, pol.cancelled_qty, pol.vendor_sku,
           coalesce((select sum(g.quantity) from goods_receipt_line g where g.purchase_order_line_id = pol.id), 0) received
      from purchase_order_line pol where pol.entity_id = $1 and pol.purchase_order_id = $2 order by pol.seq for update`, [entityId, poId]);
}
const openQty = (l: LineRow) => Number(l.quantity) - Number(l.cancelled_qty) - Number(l.received);

/** Cut a line's open quantity back by n: on order comes off, and a customer line returns to the queue if nothing is left. */
async function cutLine(c: Client, s: Scope, po: PoRow, l: LineRow, n: number) {
  if (n <= 0) return;
  await c.query(`update purchase_order_line set cancelled_qty = cancelled_qty + $3 where id = $1 and entity_id = $2`, [l.id, s.entityId, n]);
  if (l.product_id) await addOnOrder(c, s.entityId, l.product_id, po.ship_to_location_id!, -n);
  if (openQty(l) - n <= 0) await c.query(`update po_line_sales_line set active = false where entity_id = $1 and purchase_order_line_id = $2 and active`, [s.entityId, l.id]);
  // What containers carry of the line comes down with it, so nothing reads as on the road that will never come.
  const wms = await import("./wms.ts");
  await wms.trimForPoLine(c, s, l.id);
}

export async function cancelPO(c: Client, s: Scope, poId: string, reason: string) {
  need(reason && reason.trim(), "say why the purchase order is cancelled");
  const po = await poFor(c, s.entityId, poId);
  need(po.status === "open", `${po.number} is ${po.status}`);
  const lines = await linesOf(c, s.entityId, poId);
  need(!lines.some((l) => Number(l.received) > 0), `${po.number} has goods received against it; cut its open lines back through an acknowledgment instead`);
  for (const l of lines) await cutLine(c, s, po, l, openQty(l));
  await c.query(`update purchase_order set status = 'cancelled', cancel_reason = $3 where id = $1 and entity_id = $2`, [poId, s.entityId, reason.trim()]);
  await audit(c, s, { table: "purchase_order", rowId: poId, action: "transition", before: { status: "open" }, after: { status: "cancelled" }, reason });
  return { number: po.number, lines: lines.length };
}

export type AckLine = { lineId?: string; seq?: number; vendorSku?: string; status: string; qty?: number | null; expectedOn?: string | null };
const ACK_WORDS: Record<string, string> = {
  ia: "accepted", accept: "accepted", accepted: "accepted", ac: "accepted", ok: "accepted",
  ib: "backordered", backorder: "backordered", backordered: "backordered", bo: "backordered",
  ic: "changed", change: "changed", changed: "changed", ip: "changed",
  ir: "rejected", reject: "rejected", rejected: "rejected", r: "rejected", cancel: "rejected", cancelled: "rejected",
};

/**
 * The vendor's answer to a PO (EDI 855 in spirit): per line accepted,
 * backordered, changed (fewer) or rejected, each with a date. The dates go
 * onto the linked customer lines; a rejected line goes back to the queue.
 */
export async function acknowledgePO(c: Client, s: Scope, poId: string, a: { vendorRef?: string | null; expectedOn?: string | null; lines?: AckLine[] }) {
  const po = await poFor(c, s.entityId, poId);
  need(po.status === "open", `${po.number} is ${po.status}`);
  const lines = await linesOf(c, s.entityId, poId);
  if (a.expectedOn) need(DAY.test(a.expectedOn), "the ship date is a date, like 2026-12-01");
  const acks = a.lines?.length ? a.lines : lines.map((l) => ({ lineId: l.id, status: "accepted" } as AckLine));
  const touched = new Set<string>();
  for (const ak of acks) {
    const l = lines.find((x) => (ak.lineId && x.id === ak.lineId) || (ak.seq != null && x.seq === Number(ak.seq))
      || (!ak.lineId && ak.seq == null && ak.vendorSku && x.vendor_sku?.toUpperCase() === ak.vendorSku.toUpperCase()));
    need(l, `${po.number} has no line ${ak.seq ?? ak.vendorSku ?? ""}`.trim());
    need(!touched.has(l!.id), `line ${l!.seq} is answered twice`);
    touched.add(l!.id);
    const status = ACK_WORDS[String(ak.status ?? "").toLowerCase().trim()];
    need(status, `${ak.status || "a blank"} is not an acknowledgment status (accept, backorder, change or reject)`);
    const exp = ak.expectedOn || a.expectedOn || null;
    if (exp) need(DAY.test(exp), "the ship date is a date, like 2026-12-01");
    if (status === "backordered") need(exp, `say when backordered line ${l!.seq} will ship`);
    const open = openQty(l!);
    if (status === "rejected") await cutLine(c, s, po, l!, open);
    if (status === "changed") {
      need(ak.qty != null && Number.isFinite(Number(ak.qty)) && Number(ak.qty) >= 0, `say what quantity line ${l!.seq} changes to`);
      const keep = Number(ak.qty) - Number(l!.received);
      need(keep <= open, `line ${l!.seq} can only go down from ${open}; order more on a new PO`);
      await cutLine(c, s, po, l!, open - Math.max(keep, 0));
    }
    await c.query(`update purchase_order_line set ack_status = $3, expected_on = coalesce($4::date, expected_on) where id = $1 and entity_id = $2`,
      [l!.id, s.entityId, status, status === "rejected" ? null : exp]);
    if (status !== "rejected") {
      await c.query(`update po_line_sales_line k set expected_on = pol.expected_on from purchase_order_line pol
                      where k.entity_id = $1 and k.purchase_order_line_id = $2 and k.active and pol.id = k.purchase_order_line_id`, [s.entityId, l!.id]);
    }
  }
  const after = await q<{ open: string; latest: string | null }>(c, `
    select sum(quantity - cancelled_qty) open, max(expected_on) filter (where ack_status <> 'rejected')::text latest
      from purchase_order_line where entity_id = $1 and purchase_order_id = $2`, [s.entityId, poId]);
  const allGone = Number(after[0].open) <= 0;
  await c.query(`update purchase_order set acknowledged_on = current_date, vendor_ref = coalesce($3, vendor_ref),
                        expected_on = coalesce($4::date, expected_on),
                        status = case when $5 then 'cancelled' else status end,
                        cancel_reason = case when $5 then 'the vendor rejected every line' else cancel_reason end
                  where id = $1 and entity_id = $2`, [poId, s.entityId, a.vendorRef?.trim() || null, after[0].latest, allGone]);
  await audit(c, s, { table: "purchase_order", rowId: poId, action: "update", after: { acknowledged: acks.length, vendorRef: a.vendorRef ?? null } });
  return { number: po.number, lines: acks.length, cancelled: allGone, expectedOn: after[0].latest };
}

/** An 855-style CSV: po_number, line (or vendor_sku), status, qty, ship_date, vendor_ref. Bad rows are listed, good ones applied. */
export async function importAcks(c: Client, s: Scope, a: { csv: string; filename?: string | null; vendorId?: string | null }) {
  const rows = parseCsv(a.csv ?? "");
  need(rows.length >= 2, "the file has no rows under its heading line");
  need(rows.length <= 5001, "5,000 rows at most per file");
  const h = rows[0].map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const col = (...names: string[]) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };
  const iPo = col("ponumber", "po", "purchaseorder", "pono"), iLine = col("line", "lineno", "linenumber", "seq");
  const iSku = col("vendorsku", "model", "sku", "item"), iSt = col("status", "ackstatus", "linestatus", "code");
  const iQty = col("qty", "quantity", "ackqty"), iDate = col("shipdate", "expecteddate", "eta", "date", "expected");
  const iRef = col("vendorref", "acknumber", "ackno", "reference", "vendororder");
  need(iPo >= 0 && iSt >= 0 && (iLine >= 0 || iSku >= 0), "the file needs po_number, status and line (or vendor_sku) columns");
  const byPo = new Map<string, { row: number; ack: AckLine; ref: string }[]>();
  const problems: { row: number; message: string }[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cell = (i: number) => (i >= 0 ? String(rows[r][i] ?? "").trim() : "");
    const num = cell(iPo).toUpperCase();
    if (!num) { problems.push({ row: r + 1, message: "no PO number" }); continue; }
    let date = cell(iDate);
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
    if (us) date = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    const ack: AckLine = { seq: cell(iLine) ? Number(cell(iLine)) : undefined, vendorSku: cell(iSku) || undefined, status: cell(iSt),
      qty: cell(iQty) ? Number(cell(iQty)) : null, expectedOn: date || null };
    if (!byPo.has(num)) byPo.set(num, []);
    byPo.get(num)!.push({ row: r + 1, ack, ref: cell(iRef) });
  }
  let applied = 0;
  for (const [num, acks] of byPo) {
    // From a vendor's own feed, only that vendor's orders: one vendor's file can never answer another's PO.
    const po = (await q<{ id: string }>(c, `select id from purchase_order where entity_id = $1 and number = $2 and ($3::uuid is null or vendor_id = $3)`,
      [s.entityId, num, a.vendorId ?? null]))[0];
    if (!po) { for (const x of acks) problems.push({ row: x.row, message: `no purchase order ${num}` }); continue; }
    await c.query("savepoint ack");
    try {
      await acknowledgePO(c, s, po.id, { vendorRef: acks.find((x) => x.ref)?.ref || null, lines: acks.map((x) => x.ack) });
      await c.query("release savepoint ack");
      applied += acks.length;
    } catch (e) {
      await c.query("rollback to savepoint ack");
      if (!(e instanceof PurchasingError)) throw e;
      for (const x of acks) problems.push({ row: x.row, message: `${num}: ${e.message}` });
    }
  }
  const run = await one<{ id: string }>(c, `insert into po_ack_run (entity_id, filename, rows, applied, problems, created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
    [s.entityId, a.filename?.slice(0, 200) || null, rows.length - 1, applied, JSON.stringify(problems), s.actor.id || null]);
  return { runId: run.id, rows: rows.length - 1, applied, problems };
}

// --------------------------------------------------------- landed cost --

export const LANDED_KINDS = ["freight", "duty", "fuel", "other", "drayage", "tariff", "port_fees"];
export const LANDED_BASES = ["value", "qty", "cube", "weight"];

/** Freight, duty or other cost on a PO, spread over its open lines by value, quantity, cube or weight. */
export async function addLandedCost(c: Client, s: Scope, poId: string, x: { kind: string; amountMinor: bigint; basis?: string; note?: string | null }) {
  const po = await poFor(c, s.entityId, poId);
  need(po.status !== "cancelled", `${po.number} is cancelled`);
  need(LANDED_KINDS.includes(x.kind), "landed cost is freight, drayage, duty, tariff, port fees, fuel or other");
  need(x.amountMinor > 0n, "say the amount");
  const basis = x.basis ?? "value";
  need(LANDED_BASES.includes(basis), "spread it by value, quantity, cube or weight");
  await c.query(`insert into po_landed_cost (entity_id, purchase_order_id, kind, amount_minor, basis, note, created_by) values ($1,$2,$3,$4,$5,$6,$7)`,
    [s.entityId, poId, x.kind, x.amountMinor.toString(), basis, x.note?.trim() || null, s.actor.id || null]);
  await reallocate(c, s.entityId, poId);
  await audit(c, s, { table: "po_landed_cost", rowId: poId, action: "insert", after: { ...x, amountMinor: x.amountMinor.toString() } });
}

/**
 * One line's share of a cost spread somewhere else (a container's freight
 * or duty, worked out over everything the container carries): it lands on
 * that PO line alone. Returns the PO, which has been re-spread.
 */
export async function addLineLandedCost(c: Client, s: Scope, poLineId: string, x: { kind: string; amountMinor: bigint; containerCostId?: string | null; note?: string | null }) {
  const l = (await q<{ purchase_order_id: string }>(c, `select purchase_order_id from purchase_order_line where id = $1 and entity_id = $2`, [poLineId, s.entityId]))[0];
  need(l, "no such purchase order line");
  const po = await poFor(c, s.entityId, l.purchase_order_id);
  need(po.status !== "cancelled", `${po.number} is cancelled`);
  need(LANDED_KINDS.includes(x.kind), "landed cost is freight, drayage, duty, tariff, port fees, fuel or other");
  if (x.amountMinor <= 0n) return po.id;
  await c.query(`insert into po_landed_cost (entity_id, purchase_order_id, kind, amount_minor, basis, note, created_by, purchase_order_line_id, container_cost_id)
                 values ($1,$2,$3,$4,'line',$5,$6,$7,$8)`,
    [s.entityId, po.id, x.kind, x.amountMinor.toString(), x.note?.trim() || null, s.actor.id || null, poLineId, x.containerCostId ?? null]);
  await reallocate(c, s.entityId, po.id);
  return po.id;
}

/** Retire the line shares a set of container costs put on POs (before spreading them again). Returns the POs touched, already re-spread. */
export async function retireContainerShares(c: Client, entityId: string, containerCostIds: string[]): Promise<string[]> {
  if (!containerCostIds.length) return [];
  const r = await q<{ purchase_order_id: string }>(c, `update po_landed_cost set active = false
     where entity_id = $1 and container_cost_id = any($2) and active returning purchase_order_id`, [entityId, containerCostIds]);
  const pos = [...new Set(r.map((x) => x.purchase_order_id))];
  for (const id of pos) await reallocate(c, entityId, id);
  return pos;
}

/**
 * Spread every landed cost on a PO over its lines again; the last line takes
 * the rounding. A cost named for one line goes to that line. A container's
 * shares are not spread here: they ride on that container's own units (wms).
 */
export async function reallocate(c: Client, entityId: string, poId: string) {
  const lines = await q<{ id: string; qty: string; unit: string; cube: string | null; weight: string | null }>(c, `
    select pol.id, pol.quantity - pol.cancelled_qty qty, pol.unit_price_minor unit, p.cubic_ft cube, p.weight_lb weight
      from purchase_order_line pol left join product p on p.id = pol.product_id
     where pol.entity_id = $1 and pol.purchase_order_id = $2 order by pol.seq`, [entityId, poId]);
  const costs = await q<{ amount_minor: string; basis: string; purchase_order_line_id: string | null }>(c,
    `select amount_minor, basis, purchase_order_line_id from po_landed_cost where entity_id = $1 and purchase_order_id = $2 and active
        and container_cost_id is null`, [entityId, poId]);
  const alloc = new Map(lines.map((l) => [l.id, 0n]));
  const live = lines.filter((l) => Number(l.qty) > 0);
  for (const k of costs) {
    if (k.purchase_order_line_id) {
      if (alloc.has(k.purchase_order_line_id)) alloc.set(k.purchase_order_line_id, alloc.get(k.purchase_order_line_id)! + BigInt(k.amount_minor));
      continue;
    }
    if (!live.length) break;
    const w = live.map((l) => {
      const q_ = Number(l.qty);
      const v = k.basis === "qty" ? q_ : k.basis === "cube" && l.cube != null ? q_ * Number(l.cube)
        : k.basis === "weight" && l.weight != null ? q_ * Number(l.weight) : q_ * Number(l.unit);
      return BigInt(Math.round(v * 100));
    });
    const tw = w.reduce((a, b) => a + b, 0n);
    let left = BigInt(k.amount_minor);
    live.forEach((l, i) => {
      const share = i === live.length - 1 ? left : tw > 0n ? (BigInt(k.amount_minor) * w[i]) / tw : 0n;
      left -= share;
      alloc.set(l.id, alloc.get(l.id)! + share);
    });
  }
  for (const [id, v] of alloc) await c.query(`update purchase_order_line set landed_minor = $3 where id = $1 and entity_id = $2`, [id, entityId, v.toString()]);
}

/** Cost per unit with its share of freight and duty: what receiving should value the goods at. */
export async function landedUnitCost(c: Client, entityId: string, poLineId: string): Promise<bigint> {
  const l = (await q<{ unit: string; landed: string; qty: string }>(c, `
    select unit_price_minor unit, landed_minor landed, quantity - cancelled_qty qty from purchase_order_line where id = $1 and entity_id = $2`, [poLineId, entityId]))[0];
  need(l, "no such purchase order line");
  const qty = Number(l.qty);
  return BigInt(l.unit) + (qty > 0 ? BigInt(Math.round(Number(l.landed) / qty)) : 0n);
}

// -------------------------------------------------------- reorder points --

export async function setReorderRule(c: Client, s: Scope, r: { productId: string; locationId: string; min: number; max: number; active?: boolean }) {
  const p = (await q<{ name: string; kind: string }>(c, `select name, kind from product where id = $1 and entity_id = $2`, [r.productId, s.entityId]))[0];
  need(p, "no such product");
  need(p.kind === "stock", `${p.name} is not a stock item; only stock items have reorder points`);
  await locationFor(c, s.entityId, r.locationId);
  need(Number.isFinite(r.min) && Number.isFinite(r.max) && r.min >= 0, "minimum and maximum are numbers");
  need(r.max >= r.min && r.max > 0, "the maximum is at least the minimum, and above zero");
  await c.query(`insert into reorder_rule (entity_id, product_id, location_id, min_qty, max_qty, active) values ($1,$2,$3,$4,$5,$6)
                 on conflict (entity_id, product_id, location_id) do update set min_qty = excluded.min_qty, max_qty = excluded.max_qty, active = excluded.active`,
    [s.entityId, r.productId, r.locationId, r.min, r.max, r.active ?? true]);
  await audit(c, s, { table: "reorder_rule", rowId: r.productId, action: "update", after: r });
}

export type Suggestion = { product_id: string; sku: string; name: string; vendor_id: string | null; vendor: string | null; location_id: string; location: string;
  status: string; cost_minor: string; available: string; on_order: string; backordered: string; projected: number; min_qty: string; max_qty: string; suggest: number };

/**
 * What to buy: available plus on order, less customer lines waiting on
 * stock there, against each min/max. At or below the minimum, order up to
 * the maximum. Dropped and discontinued products are never suggested.
 */
export async function replenishment(c: Client, entityId: string, f: { vendorId?: string | null; locationId?: string | null } = {}): Promise<Suggestion[]> {
  const rows = await q<Omit<Suggestion, "projected" | "suggest">>(c, `
    select r.product_id, p.sku, p.name, p.vendor_id, coalesce(v.dba, v.legal_name) vendor, r.location_id, l.name location, p.status, p.cost_minor,
           coalesce(a.available, 0) available, coalesce(a.on_order, 0) on_order,
           coalesce((select sum(sl.qty) from sales_order_line sl
                      where sl.entity_id = r.entity_id and sl.product_id = r.product_id and sl.fulfil_from_id = r.location_id
                        and sl.line_status = 'on_order'), 0) backordered,
           r.min_qty, r.max_qty
      from reorder_rule r
      join product p on p.id = r.product_id and p.entity_id = r.entity_id
      join location l on l.id = r.location_id
      left join vendor v on v.id = p.vendor_id
      left join product_availability a on a.entity_id = r.entity_id and a.product_id = r.product_id and a.location_id = r.location_id
     where r.entity_id = $1 and r.active and p.status in ('active')
       and ($2::uuid is null or p.vendor_id = $2) and ($3::uuid is null or r.location_id = $3)
     order by vendor, l.name, p.sku`, [entityId, f.vendorId ?? null, f.locationId ?? null]);
  const out: Suggestion[] = [];
  for (const r of rows) {
    const projected = Number(r.available) + Number(r.on_order) - Number(r.backordered);
    if (projected > Number(r.min_qty)) continue;
    out.push({ ...r, projected, suggest: Math.ceil(Number(r.max_qty) - projected) });
  }
  return out;
}

// ------------------------------------------------------------ export --

export const EXPORT_COLUMNS = ["po_number", "po_date", "purpose", "po_type", "vendor", "vendor_account", "ship_to_code", "ship_to_name",
  "ship_to_address", "ship_to_city", "ship_to_state", "ship_to_postal", "requested_date", "line", "vendor_sku", "our_sku", "upc",
  "description", "option_codes", "qty", "uom", "unit_cost", "extended_cost", "customer_order"];

/** Open POs for a vendor as an 850-style CSV, one row per line. Marks them exported. */
export async function exportForVendor(c: Client, s: Scope, vendorId: string, opts: { onlyNew?: boolean; poId?: string | null } = {}) {
  const v = await vendorFor(c, s, vendorId);
  const rows = await q<Record<string, string | null>>(c, `
    select po.id po_id, po.number, po.ordered_on::text po_date, po.kind, po.exported_at, l.code, l.name loc_name,
           l.address->>'line1' a1, l.address->>'city' city, l.address->>'state' st, l.address->>'postal' zip,
           coalesce(pol.expected_on, po.expected_on)::text req, pol.seq::text seq, pol.vendor_sku, p.sku, p.barcode, pol.description,
           pol.config::text config, (pol.quantity - pol.cancelled_qty)::text qty, pol.unit_price_minor::text unit, pol.agreement_ref
      from purchase_order po
      join purchase_order_line pol on pol.purchase_order_id = po.id
      join location l on l.id = po.ship_to_location_id
      left join product p on p.id = pol.product_id
     where po.entity_id = $1 and po.vendor_id = $2 and po.status = 'open' and pol.quantity > pol.cancelled_qty
       and ($3::uuid is null or po.id = $3) and (not $4 or po.exported_at is null)
     order by po.number, pol.seq`, [s.entityId, vendorId, opts.poId ?? null, !!opts.onlyNew]);
  const dollars = (m: string) => { const b = BigInt(m); return `${b / 100n}.${String(b % 100n).padStart(2, "0")}`; };
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const r of rows) {
    const cfg = JSON.parse(r.config || "{}") as Record<string, { vendorCode?: string | null }[]>;
    const codes = Object.values(cfg).flat().map((o) => o?.vendorCode).filter(Boolean).join("|");
    const ext = BigInt(Math.round(Number(r.qty) * Number(r.unit)));
    lines.push([r.number, r.po_date, r.exported_at ? "05" : "00", r.kind === "special" ? "SP" : "SA", v.name, v.account_no, r.code, r.loc_name,
      r.a1, r.city, r.st, r.zip, r.req, r.seq, r.vendor_sku, r.sku, r.barcode, r.description, codes, String(Number(r.qty)), "EA",
      dollars(r.unit!), dollars(ext.toString()), r.agreement_ref].map(csvCell).join(","));
  }
  const ids = [...new Set(rows.map((r) => r.po_id))];
  if (ids.length) await c.query(`update purchase_order set exported_at = now() where entity_id = $1 and id = any($2)`, [s.entityId, ids]);
  const slug = v.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { filename: `po-${slug}-${today()}.csv`, csv: lines.join("\r\n") + "\r\n", orders: ids.length, lines: rows.length, orderEmail: v.order_email };
}

// ---------------------------------------------------------- transmission --

export type SendMethod = "email" | "file" | "api";

/**
 * Send a PO to its vendor and log the attempt. Email goes to the vendor's
 * order address with the 850-style file attached (prepared for a person to
 * send when no mail service is set up); file hands back the CSV; api posts
 * the order to the vendor's order service (Ashley first). A failure is
 * logged with the reason and returned, never thrown, so the log keeps it.
 */
export async function sendPO(c: Client, s: Scope, poId: string, method: SendMethod, env: FeedEnv) {
  const po = await poFor(c, s.entityId, poId);
  need(po.status === "open", `${po.number} is ${po.status}; only an open order is sent`);
  need(["email", "file", "api"].includes(method), "send by email, file or the vendor's API");
  const log = async (status: "sent" | "prepared" | "failed", destination: string | null, detail: string, vendorRef: string | null = null) => {
    await c.query(`insert into po_transmission (entity_id, purchase_order_id, method, status, destination, detail, vendor_ref, sent_by)
                   values ($1,$2,$3,$4,$5,$6,$7,$8)`, [s.entityId, poId, method, status, destination, detail.slice(0, 500), vendorRef, s.actor.id || null]);
    if (status !== "failed") await c.query(`update purchase_order set exported_at = now(), vendor_ref = coalesce($3, vendor_ref) where id = $1 and entity_id = $2`, [poId, s.entityId, vendorRef]);
    return { status, destination, detail, vendorRef };
  };
  if (method === "file" || method === "email") {
    await c.query("savepoint send");
    const file = await exportForVendor(c, s, po.vendor_id, { poId });
    if (method === "email" && !file.orderEmail) {
      await c.query("rollback to savepoint send");     // not sent, so not marked sent
      return log("failed", null, "the vendor has no order email on file; add it under Catalog, Vendors");
    }
    if (method === "file") return { ...(await log("prepared", file.filename, `${file.lines} lines in ${file.filename}`)), file };
    const mail = { to: file.orderEmail, subject: `Purchase order ${po.number}`,
      text: `Please confirm purchase order ${po.number}: ${file.lines} ${file.lines === 1 ? "line" : "lines"}, attached.`,
      attachments: [{ filename: file.filename, content: file.csv }] };
    if (!env.mailer) return { ...(await log("prepared", file.orderEmail, "no mail service is set up here, so download the file and email it to the vendor")), file };
    try {
      const r = await env.mailer.send(mail);
      return { ...(await log("sent", file.orderEmail, `emailed${r.id ? ` (message ${r.id})` : ""}`)), file };
    } catch (e) {
      await c.query("rollback to savepoint send");
      return log("failed", file.orderEmail, `the mail service refused it: ${((e as Error).message || "").slice(0, 160)}`);
    }
  }
  // api: the vendor's order service, through the vendor's order feed (Vendors → API setup)
  let req;
  try { req = await orderFeedRequest(c, s.entityId, env, po.vendor_id); }
  catch (e) { if (e instanceof FeedError) return log("failed", null, e.message); throw e; }
  if (!req) return log("failed", null, "this vendor has no order feed; add one under Catalog, Vendors, API setup, or send by email or file");
  const url = req.url;
  const lines = await q<{ seq: number; vendor_sku: string | null; qty: string; unit: string; config: Record<string, { vendorCode?: string }[]>; agreement_ref: string | null; expected_on: string | null }>(c, `
    select pol.seq, pol.vendor_sku, (pol.quantity - pol.cancelled_qty)::text qty, pol.unit_price_minor::text unit, pol.config, pol.agreement_ref, pol.expected_on::text
      from purchase_order_line pol where pol.entity_id = $1 and pol.purchase_order_id = $2 and pol.quantity > pol.cancelled_qty order by pol.seq`, [s.entityId, poId]);
  const opts = req.feed.options ?? {};
  const hdr = (await q<{ ordered_on: string; expected_on: string | null; code: string; ship_to: string | null }>(c, `
    select po.ordered_on::text, po.expected_on::text, l.code, $3::jsonb ->> l.id::text ship_to
      from purchase_order po join location l on l.id = po.ship_to_location_id where po.id = $1 and po.entity_id = $2`,
    [poId, s.entityId, JSON.stringify(opts.shipTos ?? {})]))[0];
  const body = {
    purchaseOrderNumber: po.number, orderDate: hdr.ordered_on, requestedDate: hdr.expected_on, customer: opts.customer ?? null,
    shipTo: hdr.ship_to ?? hdr.code, orderType: po.kind === "special" ? "SpecialOrder" : "Stock",
    lines: lines.map((l) => ({ lineNumber: l.seq, sku: l.vendor_sku, quantity: Number(l.qty), unitCost: Number(l.unit) / 100,
      options: Object.values(l.config ?? {}).flat().map((o) => o?.vendorCode).filter(Boolean), customerOrder: l.agreement_ref })),
  };
  // The vendor's own body shape, when the order feed has a template: {{purchaseOrderNumber}}, {{#lines}}{"sku":"{{item.sku}}"},{{/lines}}.
  let text = JSON.stringify(body);
  if (req.feed.body_template) {
    text = render(req.feed.body_template, { ...body, opt: opts }, "json").replace(/,(\s*[\]}])/g, "$1");
    try { JSON.parse(text); }
    catch { return log("failed", null, "the order feed's body template does not make valid JSON; fix it under Catalog, Vendors, API setup"); }
  }
  const shown = req.mask(url);
  const mapping = req.feed.mapping ?? {};
  const at = (j: unknown, path: string | undefined) => path ? path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), j) : undefined;
  try {
    const r = await call(env, url, { method: "POST", headers: { ...req.headers, "content-type": "application/json" }, body: text },
      req.feed.timeout_ms, "the vendor's order service", 1);
    if (r.status !== 200 && r.status !== 201 && r.status !== 202) return { ...(await log("failed", shown, `the vendor's order service answered ${r.status}${r.text ? `: ${req.mask(r.text.slice(0, 160))}` : ""}`)), request: req.mask(text), response: req.mask(r.text.slice(0, 4000)) };
    let ref: string | null = null, ackWord: string | null = null, ackDate: string | null = null;
    try {
      const j = JSON.parse(r.text) as Record<string, unknown>;
      ref = String(at(j, mapping.vendor_ref) ?? j.orderNumber ?? j.confirmationNumber ?? j.id ?? "") || null;
      ackWord = mapping.ack_status ? String(at(j, mapping.ack_status) ?? "") || null : null;
      ackDate = mapping.expected_on ? String(at(j, mapping.expected_on) ?? "").slice(0, 10) || null : null;
    } catch { /* no body */ }
    const sent = await log("sent", shown, `accepted by the vendor${ref ? ` as ${ref}` : ""}`, ref);
    // An order service that answers with its acknowledgment (status and ship date) acknowledges the whole PO now.
    let acknowledged: string | null = null;
    if (ackWord && ACK_WORDS[ackWord.toLowerCase().trim()]) {
      await c.query("savepoint api_ack");
      try {
        const all = await linesOf(c, s.entityId, poId);
        await acknowledgePO(c, s, poId, { vendorRef: ref, expectedOn: ackDate && DAY.test(ackDate) ? ackDate : null,
          lines: all.filter((l) => openQty(l) > 0).map((l) => ({ lineId: l.id, status: ackWord!, expectedOn: ackDate && DAY.test(ackDate) ? ackDate : null })) });
        await c.query("release savepoint api_ack");
        acknowledged = ACK_WORDS[ackWord.toLowerCase().trim()];
      } catch (e) {
        await c.query("rollback to savepoint api_ack");
        if (!(e instanceof PurchasingError)) throw e;
        acknowledged = `not applied: ${e.message}`;
      }
    }
    return { ...sent, acknowledged, request: req.mask(text), response: req.mask(r.text.slice(0, 4000)) };
  } catch (e) {
    if (!(e instanceof FeedError)) throw e;
    return { ...(await log("failed", shown, req.mask(e.message))), request: req.mask(text) };
  }
}

// ------------------------------------------------------------ ship notices --

export type ShipLine = { lineId?: string; seq?: number; vendorSku?: string; qty: number };
export type ShipNotice = { asn: string; shippedOn?: string | null; expectedOn?: string | null; carrier?: string | null; tracking?: string | null;
  lines: ShipLine[]; source?: "edi" | "api" | "manual"; documentId?: string | null; equipment?: string | null };

/**
 * The vendor's ship notice (EDI 856, or a "shipped" status from its API):
 * the lines and quantities on the truck, when it left, who carries it and
 * the tracking number. The goods are in transit until receiving counts
 * them in; the line's expected date (what receiving plans by) and the
 * customer's ETA become the delivery date the notice gives.
 */
export async function recordShipment(c: Client, s: Scope, poId: string, n: ShipNotice) {
  const po = await poFor(c, s.entityId, poId);
  need(po.status === "open", `${po.number} is ${po.status}; a ship notice is for an open order`);
  need(n.asn && String(n.asn).trim(), "a ship notice needs its shipment number");
  for (const d of [n.shippedOn, n.expectedOn]) if (d) need(DAY.test(d), "the ship and delivery dates are dates, like 2026-12-01");
  need(n.lines?.length, "a ship notice lists the lines on the truck");
  const dup = await q(c, `select 1 from po_shipment where entity_id = $1 and purchase_order_id = $2 and asn_number = $3`, [s.entityId, poId, n.asn.trim()]);
  need(!dup.length, `ship notice ${n.asn.trim()} is already recorded on ${po.number}`);
  const lines = await linesOf(c, s.entityId, poId);
  const shippedBefore = new Map((await q<{ id: string; shipped: string }>(c, `select purchase_order_line_id id, shipped_qty shipped from po_line_shipping where entity_id = $1 and purchase_order_id = $2`,
    [s.entityId, poId])).map((x) => [x.id, Number(x.shipped)]));
  const picked: { l: LineRow; qty: number }[] = [];
  for (const sl of n.lines) {
    const l = lines.find((x) => (sl.lineId && x.id === sl.lineId) || (sl.seq != null && x.seq === Number(sl.seq))
      || (!sl.lineId && sl.seq == null && sl.vendorSku && x.vendor_sku?.toUpperCase() === sl.vendorSku.toUpperCase()));
    need(l, `${po.number} has no line ${sl.seq ?? sl.vendorSku ?? ""}`.trim());
    need(Number.isFinite(sl.qty) && sl.qty > 0, `line ${l!.seq} ships no quantity`);
    const already = (shippedBefore.get(l!.id) ?? 0) + picked.filter((p) => p.l.id === l!.id).reduce((a, p) => a + p.qty, 0);
    const left = Number(l!.quantity) - Number(l!.cancelled_qty) - already;
    need(sl.qty <= left, `line ${l!.seq} ships ${sl.qty}, but only ${Math.max(left, 0)} are left on order to ship`);
    picked.push({ l: l!, qty: sl.qty });
  }
  const arrive = n.expectedOn || null;
  const sh = await one<{ id: string }>(c, `
    insert into po_shipment (entity_id, purchase_order_id, asn_number, shipped_on, expected_on, carrier, tracking, source, document_id, created_by, equipment_no)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [s.entityId, poId, n.asn.trim().slice(0, 60), n.shippedOn || null, arrive, n.carrier?.trim().slice(0, 80) || null, n.tracking?.trim().slice(0, 80) || null,
     n.source ?? "edi", n.documentId ?? null, s.actor.id || null, n.equipment?.trim().toUpperCase().replace(/\s+/g, "").slice(0, 20) || null]);
  for (const p of picked) {
    await c.query(`insert into po_shipment_line (entity_id, shipment_id, purchase_order_line_id, quantity) values ($1,$2,$3,$4)`, [s.entityId, sh.id, p.l.id, p.qty]);
    // A shipped line is a confirmed one; its date is now when the truck should arrive.
    await c.query(`update purchase_order_line set ack_status = case when ack_status = 'pending' then 'accepted' else ack_status end,
                          expected_on = coalesce($3::date, expected_on) where id = $1 and entity_id = $2`, [p.l.id, s.entityId, arrive]);
    await c.query(`update po_line_sales_line k set expected_on = pol.expected_on from purchase_order_line pol
                    where k.entity_id = $1 and k.purchase_order_line_id = $2 and k.active and pol.id = k.purchase_order_line_id`, [s.entityId, p.l.id]);
  }
  await c.query(`update purchase_order set acknowledged_on = coalesce(acknowledged_on, current_date),
                        expected_on = coalesce((select max(expected_on) from purchase_order_line where entity_id = $2 and purchase_order_id = $1 and ack_status <> 'rejected'), expected_on)
                  where id = $1 and entity_id = $2`, [poId, s.entityId]);
  await audit(c, s, { table: "po_shipment", rowId: sh.id, action: "insert", after: { po: po.number, asn: n.asn, lines: picked.length, carrier: n.carrier ?? null, tracking: n.tracking ?? null, arrive } });
  return { shipmentId: sh.id, poId, number: po.number, lines: picked.length, units: picked.reduce((a, p) => a + p.qty, 0), expectedOn: arrive,
    shipped: picked.map((p) => ({ poLineId: p.l.id, qty: p.qty })) };
}

/** "Shipped" rows from an order-status API, one ship notice per PO and notice number. Bad groups are listed, good ones applied. */
export async function recordShipmentsFromRows(c: Client, s: Scope, vendorId: string, rows: Record<string, string>[], source: "api" | "edi" = "api") {
  const groups = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const key = `${(r.po_number ?? "").trim().toUpperCase()}|${(r.vendor_ref ?? r.tracking ?? "").trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const usDay = (v: string | undefined) => {
    const t = String(v ?? "").trim();
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
    return us ? `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}` : /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
  };
  let shipments = 0, lineCount = 0;
  const problems: string[] = [];
  for (const [key, rs] of groups) {
    const [num] = key.split("|");
    const po = (await q<{ id: string }>(c, `select id from purchase_order where entity_id = $1 and vendor_id = $2 and number = $3`, [s.entityId, vendorId, num]))[0];
    if (!po) { problems.push(`no purchase order ${num || "(blank)"} from this vendor`); continue; }
    const first = rs[0];
    const asn = (first.vendor_ref || first.tracking || `${num}-${usDay(first.ship_date) ?? today()}`).trim();
    if ((await q(c, `select 1 from po_shipment where entity_id = $1 and purchase_order_id = $2 and asn_number = $3`, [s.entityId, po.id, asn])).length) continue;   // already have it
    await c.query("savepoint ship_rows");
    try {
      await recordShipment(c, s, po.id, { asn, shippedOn: usDay(first.ship_date), expectedOn: usDay(first.delivery_date), carrier: first.carrier || null,
        tracking: first.tracking || null, source, lines: rs.map((r) => ({ seq: r.line ? Number(r.line) : undefined, vendorSku: r.vendor_sku || undefined, qty: Number(r.qty) })) });
      await c.query("release savepoint ship_rows");
      shipments++; lineCount += rs.length;
    } catch (e) {
      await c.query("rollback to savepoint ship_rows");
      if (!(e instanceof PurchasingError)) throw e;
      problems.push(`${num}: ${e.message}`);
    }
  }
  return { shipments, lines: lineCount, problems };
}

/**
 * A new arrival date for PO lines (a container's ETA moved): the lines' expected
 * dates, the customers' special orders tied to them, and the PO's own date
 * follow, the same way an acknowledgment or a ship notice moves them.
 */
export async function setLineEta(c: Client, s: Scope, poLineIds: string[], expectedOn: string, why: string) {
  need(DAY.test(expectedOn), "the arrival date is a date, like 2026-12-01");
  const lines = await q<{ id: string; purchase_order_id: string }>(c, `
    select pol.id, pol.purchase_order_id from purchase_order_line pol join purchase_order po on po.id = pol.purchase_order_id
     where pol.entity_id = $1 and pol.id = any($2) and po.status = 'open' and pol.ack_status <> 'rejected' for update of pol`, [s.entityId, poLineIds]);
  for (const l of lines) {
    await c.query(`update purchase_order_line set ack_status = case when ack_status = 'pending' then 'accepted' else ack_status end, expected_on = $3
                    where id = $1 and entity_id = $2`, [l.id, s.entityId, expectedOn]);
    await c.query(`update po_line_sales_line k set expected_on = $3 where k.entity_id = $1 and k.purchase_order_line_id = $2 and k.active`, [s.entityId, l.id, expectedOn]);
  }
  for (const poId of new Set(lines.map((l) => l.purchase_order_id))) {
    await c.query(`update purchase_order set expected_on = coalesce((select max(expected_on) from purchase_order_line where entity_id = $2 and purchase_order_id = $1 and ack_status <> 'rejected'), expected_on)
                    where id = $1 and entity_id = $2`, [poId, s.entityId]);
    await audit(c, s, { table: "purchase_order", rowId: poId, action: "update", after: { expectedOn, lines: lines.filter((l) => l.purchase_order_id === poId).length }, reason: why });
  }
  return lines.length;
}

/** A ship notice belongs to a container (its 856 named the container or trailer). */
export async function linkShipmentContainer(c: Client, entityId: string, shipmentIds: string[], containerId: string) {
  if (!shipmentIds.length) return;
  await c.query(`update po_shipment set container_id = $3 where entity_id = $1 and id = any($2)`, [entityId, shipmentIds, containerId]);
}

export async function shipmentsOf(c: Client, entityId: string, poId: string) {
  return q<{ id: string; asn_number: string; shipped_on: string | null; expected_on: string | null; carrier: string | null; tracking: string | null; status: string; source: string;
    lines: { seq: number; qty: string }[] }>(c, `
    select sh.id, sh.asn_number, sh.shipped_on::text, sh.expected_on::text, sh.carrier, sh.tracking, sh.status, sh.source,
           (select json_agg(json_build_object('seq', pol.seq, 'qty', sl.quantity) order by pol.seq) from po_shipment_line sl
              join purchase_order_line pol on pol.id = sl.purchase_order_line_id where sl.shipment_id = sh.id and sl.entity_id = sh.entity_id) lines
      from po_shipment sh where sh.entity_id = $1 and sh.purchase_order_id = $2 order by sh.created_at`, [entityId, poId]);
}

/** Everything an outbound order document needs (an X12 850 or a vendor's API): header, ship-to and live lines with every item id. */
export async function orderDocument(c: Client, s: Scope, poId: string) {
  const po = await poFor(c, s.entityId, poId, false);
  need(po.status === "open", `${po.number} is ${po.status}; only an open order is sent`);
  const v = await vendorFor(c, s, po.vendor_id);
  const h = (await q<{ ordered_on: string; expected_on: string | null; exported_at: string | null; code: string; name: string; address: Record<string, string> }>(c, `
    select po.ordered_on::text, po.expected_on::text, po.exported_at::text, l.code, l.name, l.address
      from purchase_order po join location l on l.id = po.ship_to_location_id where po.id = $1 and po.entity_id = $2`, [poId, s.entityId]))[0];
  const lines = await q<{ id: string; seq: number; vendor_sku: string | null; sku: string | null; barcode: string | null; description: string; qty: string; unit: string;
    config: Record<string, { vendorCode?: string }[]>; agreement_ref: string | null; expected_on: string | null; product_id: string | null }>(c, `
    select pol.id, pol.seq, pol.vendor_sku, p.sku, p.barcode, pol.description, (pol.quantity - pol.cancelled_qty)::text qty, pol.unit_price_minor::text unit,
           pol.config, pol.agreement_ref, pol.expected_on::text, pol.product_id
      from purchase_order_line pol left join product p on p.id = pol.product_id
     where pol.entity_id = $1 and pol.purchase_order_id = $2 and pol.quantity > pol.cancelled_qty order by pol.seq`, [s.entityId, poId]);
  need(lines.length, `${po.number} has no open lines to send`);
  return { po: { ...po, ...h }, vendor: v, lines };
}

/** Mark an order as sent by a channel purchasing does not run itself (EDI): logged like every other send. */
export async function markSent(c: Client, s: Scope, poId: string, destination: string, detail: string) {
  await c.query(`insert into po_transmission (entity_id, purchase_order_id, method, status, destination, detail, sent_by) values ($1,$2,'edi','sent',$3,$4,$5)`,
    [s.entityId, poId, destination.slice(0, 200), detail.slice(0, 500), s.actor.id || null]);
  await c.query(`update purchase_order set exported_at = now() where id = $1 and entity_id = $2`, [poId, s.entityId]);
}

/**
 * The vendor changed a line's price (an 855 IP, say): the PO line takes the
 * new price, keeps the one it had, and is flagged for the buyer to review.
 * Landed cost is spread again. The bill is then matched to the new price.
 */
export async function vendorPriceChange(c: Client, s: Scope, poLineId: string, unitMinor: bigint, note: string) {
  const l = (await q<{ id: string; po: string; number: string; status: string; unit: string; seq: number }>(c, `
    select pol.id, po.id po, po.number, po.status, pol.unit_price_minor::text unit, pol.seq from purchase_order_line pol join purchase_order po on po.id = pol.purchase_order_id
     where pol.id = $1 and pol.entity_id = $2 for update of pol`, [poLineId, s.entityId]))[0];
  need(l, "no such purchase order line");
  need(l.status === "open", `${l.number} is ${l.status}; its prices are settled`);
  need(unitMinor >= 0n, "a price cannot be negative");
  await c.query(`update purchase_order_line set price_changed_from = coalesce(price_changed_from, unit_price_minor), unit_price_minor = $3,
                        price_review_note = $4 where id = $1 and entity_id = $2`, [poLineId, s.entityId, unitMinor.toString(), note.slice(0, 300)]);
  await reallocate(c, s.entityId, l.po);
  await audit(c, s, { table: "purchase_order_line", rowId: poLineId, action: "update", before: { unit: l.unit }, after: { unit: unitMinor.toString(), review: note } });
}

/** The buyer has looked at a vendor's price change. */
export async function clearPriceReview(c: Client, s: Scope, poLineId: string) {
  const r = await q(c, `update purchase_order_line set price_review_note = null where id = $1 and entity_id = $2 and price_review_note is not null returning id`, [poLineId, s.entityId]);
  need(r.length, "that line has no price change waiting for review");
  await audit(c, s, { table: "purchase_order_line", rowId: poLineId, action: "update", after: { priceReviewed: true } });
}
