// Point of sale. Registers and drawer sessions, the order a salesperson
// builds on a tablet, quotes, layaway, tenders, take-with, pickup, returns
// and exchanges. POS writes the shared sales_order (channel 'pos') and every
// dollar as a customer_receipt in a drawer session. It never writes stock or
// receivables directly: inventory.ts reserves and fulfils, ar.ts posts.
//
// Accounting this file adds (accounts by code):
//   drawer short at close     Dr 6800 other operating   Cr 1050 undeposited funds
//   drawer over at close      Dr 1050                   Cr 6800
//   goods returned            Dr 4900 returns, Dr 2100 tax refunded   Cr 2300 customer deposits
//                             Dr 1300 inventory (at cost)             Cr 5000 cost of goods
//   the refund itself         ar.postReceipt on a negative receipt: Dr 2300 Cr 1050 (or the tender's account)
// Receipts and sales go through ar.postReceipt and ar.invoiceFulfilment.

import { today as bizToday } from "./clock.ts";
import { q, one, audit, type Client, type Scope } from "./db.ts";
import { post, profitObjectFor } from "./posting.ts";
import { priceConfigured, type Choice } from "./pricing.ts";
import { reserveOrder, reserveLines, fulfilLines, releaseLines, restock, returnToDamage, unitCost, allocate } from "./inventory.ts";
import * as tax from "./tax.ts";
import * as fleet from "./fleet.ts";
import * as wms from "./wms.ts";
import { postReceipt, invoiceFulfilment, chargeRoom } from "./ar.ts";
import { providerNamed } from "./shop.ts";
import { accrueCommissions } from "./workforce.ts";
import * as sectionals from "./configurator.ts";

export class PosError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new PosError(msg); };
const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const bps = (m: bigint, rate: number): bigint => { const neg = m < 0n; const a = neg ? -m : m; const r = (a * BigInt(rate) + 5000n) / 10000n; return neg ? -r : r; };
const usd = (m: bigint) => { const neg = m < 0n; const a = neg ? -m : m; return `${neg ? "-" : ""}$${(a / 100n).toLocaleString("en-US")}.${String(a % 100n).padStart(2, "0")}`; };
const pct = (b: number) => `${(b / 100).toFixed(b % 100 ? 1 : 0)}%`;

export const FULFIL = ["carry", "pickup", "delivery", "ship"] as const;
export type Fulfil = typeof FULFIL[number];
export const TENDERS = ["cash", "card", "check", "financing", "gift_card", "store_credit"] as const;
export const RETURN_REASONS = ["defective", "damaged_in_delivery", "wrong_item", "changed_mind", "not_as_described", "late_delivery", "other"];
const STOCKED = ["stock", "configurable", "special_order"];
const MANAGERS = ["store_manager", "owner"];

export type Settings = { discountLimitBps: number; quoteValidDays: number; layawayMinDepositBps: number; layawayMaxDays: number;
  layawayInstallments: number; deliveryProductId: string | null; protectionProductId: string | null;
  /** the least a sale with goods on order must have paid at checkout: this share of the on-order goods, and the other of stocked goods */
  specialOrderDepositBps: number; stockedDepositBps: number; quoteHoldsAllowed: boolean; quoteHoldMaxDays: number;
  /** the tenders this company's registers take */
  tenders: string[] };

/**
 * The company's selling rules: its pos_setting row; with no row yet, the values its setup pack
 * set (pos.discount_limit_bps, pos.quote_days, pos.layaway_days, pos.deposit_min_bps, pos.tenders), then the defaults.
 */
export async function settings(c: Client, entityId: string): Promise<Settings> {
  const r = await q<Record<string, unknown>>(c, `select * from pos_setting where entity_id = $1`, [entityId]);
  const pk = new Map((await q<{ key: string; value: unknown }>(c,
    `select key, value from entity_setting where entity_id = $1 and key in ('pos.discount_limit_bps','pos.quote_days','pos.layaway_days','pos.deposit_min_bps','pos.tenders')`,
    [entityId])).map((x) => [x.key, x.value]));
  const pack = (k: string, d: number) => { const v = Number(pk.get(k)); return Number.isFinite(v) && pk.has(k) ? v : d; };
  const x = r[0] ?? { discount_limit_bps: pack("pos.discount_limit_bps", 1000), quote_valid_days: pack("pos.quote_days", 30),
    layaway_max_days: pack("pos.layaway_days", 90), special_order_deposit_bps: pack("pos.deposit_min_bps", 5000) };
  const packTenders = Array.isArray(pk.get("pos.tenders")) ? (pk.get("pos.tenders") as string[]).filter((t) => (TENDERS as readonly string[]).includes(t)) : null;
  const tenders = Array.isArray(x.tenders) && (x.tenders as string[]).length ? x.tenders as string[] : r[0] ? [...TENDERS] : packTenders?.length ? packTenders : [...TENDERS];
  return { discountLimitBps: Number(x.discount_limit_bps ?? 1000), quoteValidDays: Number(x.quote_valid_days ?? 30),
    layawayMinDepositBps: Number(x.layaway_min_deposit_bps ?? 2000), layawayMaxDays: Number(x.layaway_max_days ?? 90),
    layawayInstallments: Number(x.layaway_installments ?? 4), deliveryProductId: (x.delivery_product_id as string) ?? null,
    protectionProductId: (x.protection_product_id as string) ?? null,
    specialOrderDepositBps: Number(x.special_order_deposit_bps ?? 5000), stockedDepositBps: Number(x.stocked_deposit_bps ?? 0),
    quoteHoldsAllowed: x.quote_holds_allowed === true, quoteHoldMaxDays: Number(x.quote_hold_max_days ?? 3), tenders };
}

export type SettingsIn = { specialOrderDepositBps?: number; stockedDepositBps?: number; quoteHoldsAllowed?: boolean; quoteHoldMaxDays?: number;
  discountLimitBps?: number; quoteValidDays?: number; layawayMinDepositBps?: number; layawayMaxDays?: number; layawayInstallments?: number; tenders?: string[] };
const RULE_KEYS = ["specialOrderDepositBps", "stockedDepositBps", "quoteHoldsAllowed", "quoteHoldMaxDays", "discountLimitBps", "quoteValidDays",
  "layawayMinDepositBps", "layawayMaxDays", "layawayInstallments", "tenders"] as const;

/** A manager (or the controller) sets the selling rules: deposits, quote holds, the discount limit, quote life, layaway terms, tenders. */
export async function saveSettings(c: Client, scope: Scope, e: SettingsIn) {
  const cur = await settings(c, scope.entityId);
  const n = { ...cur, ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) } as Settings;
  for (const [k, label] of [["specialOrderDepositBps", "the special-order deposit"], ["stockedDepositBps", "the stocked-goods deposit"],
    ["discountLimitBps", "the discount a salesperson may give without a manager"], ["layawayMinDepositBps", "the layaway deposit"]] as const)
    need(Number.isInteger(n[k]) && n[k] >= 0 && n[k] <= 10000, `${label} is between 0% and 100%`);
  need(Number.isInteger(n.quoteHoldMaxDays) && n.quoteHoldMaxDays >= 1 && n.quoteHoldMaxDays <= 30, "a quote holds stock for 1 to 30 days");
  need(Number.isInteger(n.quoteValidDays) && n.quoteValidDays >= 1 && n.quoteValidDays <= 365, "a quote is good for 1 to 365 days");
  need(Number.isInteger(n.layawayMaxDays) && n.layawayMaxDays >= 7 && n.layawayMaxDays <= 365, "a layaway runs 7 to 365 days");
  need(Number.isInteger(n.layawayInstallments) && n.layawayInstallments >= 1 && n.layawayInstallments <= 24, "a layaway is paid in 1 to 24 payments");
  need(n.quoteHoldMaxDays <= n.quoteValidDays, "a quote cannot hold stock longer than the quote is good for");
  const tenders = [...new Set(n.tenders)];
  need(tenders.length >= 1, "the registers need at least one way to pay");
  need(tenders.every((t) => (TENDERS as readonly string[]).includes(t)), `a tender is one of: ${TENDERS.join(", ").replace(/_/g, " ")}`);
  await c.query(`insert into pos_setting (entity_id, special_order_deposit_bps, stocked_deposit_bps, quote_holds_allowed, quote_hold_max_days,
                   discount_limit_bps, quote_valid_days, layaway_min_deposit_bps, layaway_max_days, layaway_installments, tenders)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict (entity_id) do update set special_order_deposit_bps = $2, stocked_deposit_bps = $3, quote_holds_allowed = $4, quote_hold_max_days = $5,
      discount_limit_bps = $6, quote_valid_days = $7, layaway_min_deposit_bps = $8, layaway_max_days = $9, layaway_installments = $10, tenders = $11`,
    [scope.entityId, n.specialOrderDepositBps, n.stockedDepositBps, n.quoteHoldsAllowed === true, n.quoteHoldMaxDays,
     n.discountLimitBps, n.quoteValidDays, n.layawayMinDepositBps, n.layawayMaxDays, n.layawayInstallments, tenders]);
  const pick = (s: Settings) => Object.fromEntries(RULE_KEYS.map((k) => [k, s[k]]));
  await audit(c, scope, { table: "pos_setting", rowId: scope.entityId, action: "update", before: pick(cur), after: pick({ ...n, tenders }) });
  return settings(c, scope.entityId);
}

const nextNo = async (c: Client, entityId: string, kind: string, prefix: string) =>
  (await q<{ n: string }>(c, `select next_doc_no($1, $2, $3) n /* unscoped: numbering keyed by entity argument */`, [entityId, kind, prefix]))[0].n;

const hasRelation = async (c: Client, name: string) =>
  !!(await q<{ r: string | null }>(c, `select to_regclass($1)::text r /* unscoped: schema lookup */`, [name]))[0]?.r;

// ================================================================ the drawer

export async function openSession(c: Client, scope: Scope, e: { registerId: string; floatMinor: bigint }) {
  const r = await q<{ id: string; location_id: string; name: string; active: boolean }>(c,
    `select id, location_id, name, active from pos_register where id = $1 and entity_id = $2 for update`, [e.registerId, scope.entityId]);
  need(r.length, "no such register");
  need(r[0].active, `${r[0].name} is not in use`);
  need(e.floatMinor >= 0n, "the opening float cannot be negative");
  const open = await q<{ number: string }>(c, `select number from pos_session where entity_id = $1 and register_id = $2 and status = 'open'`, [scope.entityId, e.registerId]);
  need(!open.length, `${r[0].name} already has session ${open[0]?.number} open; close it first`);
  const number = await nextNo(c, scope.entityId, "pos_session", "Z-");
  const s = await one<{ id: string }>(c, `insert into pos_session (entity_id, register_id, location_id, number, float_minor, opened_by)
    values ($1,$2,$3,$4,$5,$6) returning id`, [scope.entityId, e.registerId, r[0].location_id, number, e.floatMinor.toString(), scope.actor.id]);
  return { id: s.id, number };
}

async function sessionOf(c: Client, entityId: string, id: string | null | undefined, lock = false) {
  need(id, "open a register session first");
  const r = await q<{ id: string; number: string; status: string; location_id: string; register_id: string; float_minor: string; opened_by: string; opened_at: string }>(c,
    `select id, number, status, location_id, register_id, float_minor, opened_by, opened_at from pos_session where id = $1 and entity_id = $2${lock ? " for update" : ""}`,
    [id, entityId]);
  need(r.length, "no such register session");
  return r[0];
}

export async function cashMovement(c: Client, scope: Scope, sessionId: string, e: { kind: string; amountMinor: bigint; note?: string }) {
  const s = await sessionOf(c, scope.entityId, sessionId, true);
  need(s.status === "open", `session ${s.number} is closed`);
  need(["drop", "paid_in", "paid_out"].includes(e.kind), "a drawer movement is a drop, a paid in or a paid out");
  need(e.amountMinor > 0n, "the amount must be more than zero");
  if (e.kind !== "drop") need(String(e.note ?? "").trim(), "say what the cash was for");
  if (e.kind !== "paid_in") {
    const cash = await expectedCash(c, scope.entityId, sessionId);
    need(e.amountMinor <= cash, `the drawer should only hold ${usd(cash)}`);
  }
  await c.query(`insert into pos_cash_movement (entity_id, session_id, kind, amount_minor, note, by_user) values ($1,$2,$3,$4,$5,$6)`,
    [scope.entityId, sessionId, e.kind, e.amountMinor.toString(), e.note ?? null, scope.actor.id]);
  return { ok: true };
}

export async function expectedCash(c: Client, entityId: string, sessionId: string): Promise<bigint> {
  const r = await one<{ f: string; cash: string; drops: string; ins: string; outs: string }>(c, `
    select s.float_minor::text f,
      (select coalesce(sum(amount_minor),0) from customer_receipt r where r.entity_id = s.entity_id and r.register_session_id = s.id and r.method = 'cash' and r.voided_at is null)::text cash,
      (select coalesce(sum(amount_minor),0) from pos_cash_movement m where m.entity_id = s.entity_id and m.session_id = s.id and m.kind = 'drop')::text drops,
      (select coalesce(sum(amount_minor),0) from pos_cash_movement m where m.entity_id = s.entity_id and m.session_id = s.id and m.kind = 'paid_in')::text ins,
      (select coalesce(sum(amount_minor),0) from pos_cash_movement m where m.entity_id = s.entity_id and m.session_id = s.id and m.kind = 'paid_out')::text outs
     from pos_session s where s.id = $2 and s.entity_id = $1`, [entityId, sessionId]);
  return BigInt(r.f) + BigInt(r.cash) - BigInt(r.drops) + BigInt(r.ins) - BigInt(r.outs);
}

/** Denominations a drawer is counted in, in cents. */
export const DENOMS = [10000, 5000, 2000, 1000, 500, 200, 100, 50, 25, 10, 5, 1];

/** The Z report: what went through the drawer, by tender, with the cash it should hold. */
export async function zReport(c: Client, entityId: string, sessionId: string) {
  const s = await sessionOf(c, entityId, sessionId);
  const head = await one<Record<string, unknown>>(c, `select s.number, s.status, s.opened_at, s.closed_at, s.float_minor::text, s.counted_minor::text, s.counted_detail,
      s.expected_cash_minor::text, s.over_short_minor::text, s.close_note, r.name register, l.name location, ou.name opened_by, cu.name closed_by
    from pos_session s join pos_register r on r.id = s.register_id join location l on l.id = s.location_id
    left join app_user ou on ou.id = s.opened_by left join app_user cu on cu.id = s.closed_by where s.id = $2 and s.entity_id = $1`, [entityId, sessionId]);
  const tenders = await q<{ method: string; n: number; taken: string; refunded: string }>(c, `
    select method, count(*)::int n, coalesce(sum(amount_minor) filter (where amount_minor > 0),0)::text taken,
           coalesce(-sum(amount_minor) filter (where amount_minor < 0),0)::text refunded
      from customer_receipt where entity_id = $1 and register_session_id = $2 and voided_at is null group by method order by method`, [entityId, sessionId]);
  const moves = await q<{ kind: string; s: string; n: number }>(c, `select kind, sum(amount_minor)::text s, count(*)::int n from pos_cash_movement
     where entity_id = $1 and session_id = $2 group by kind`, [entityId, sessionId]);
  const sales = await one<{ n: number; total: string; tax: string; disc: string }>(c, `
    select count(*)::int n, coalesce(sum(so.total_minor),0)::text total, coalesce(sum(so.tax_minor),0)::text tax, coalesce(sum(so.discount_minor),0)::text disc
      from pos_order po join sales_order so on so.id = po.sales_order_id
     where po.entity_id = $1 and po.register_session_id = $2 and po.kind in ('sale','layaway') and so.status <> 'draft' and so.status <> 'cancelled'`, [entityId, sessionId]);
  const returns = await one<{ n: number; total: string }>(c, `
    select count(*)::int n, coalesce(-sum(so.total_minor),0)::text total from pos_order po join sales_order so on so.id = po.sales_order_id
     where po.entity_id = $1 and po.register_session_id = $2 and po.kind = 'return'`, [entityId, sessionId]);
  const people = await q<{ name: string; n: number; credit: string }>(c, `
    select u.name, count(distinct so.id)::int n, sum(so.total_minor * sp.split_bps / 10000)::bigint::text credit
      from pos_order po join sales_order so on so.id = po.sales_order_id
      join sales_order_salesperson sp on sp.sales_order_id = so.id and sp.entity_id = po.entity_id join app_user u on u.id = sp.app_user_id
     where po.entity_id = $1 and po.register_session_id = $2 and po.kind in ('sale','layaway') and so.status not in ('draft','cancelled')
     group by u.name order by credit desc`, [entityId, sessionId]);
  const mv = (k: string) => BigInt(moves.find((m) => m.kind === k)?.s ?? "0");
  const cashTaken = tenders.filter((t) => t.method === "cash").reduce((a, t) => a + BigInt(t.taken) - BigInt(t.refunded), 0n);
  const expected = s.status === "closed" ? BigInt(String(head.expected_cash_minor)) : await expectedCash(c, entityId, sessionId);
  return { session: head, tenders, sales, returns, salespeople: people,
    cash: { floatMinor: BigInt(s.float_minor), cashNetMinor: cashTaken, dropsMinor: mv("drop"), paidInMinor: mv("paid_in"), paidOutMinor: mv("paid_out"),
      expectedMinor: expected, countedMinor: head.counted_minor != null ? BigInt(String(head.counted_minor)) : null,
      overShortMinor: head.over_short_minor != null ? BigInt(String(head.over_short_minor)) : null } };
}

/** Close a drawer: count the cash by denomination, post any over or short, keep the Z report. */
export async function closeSession(c: Client, scope: Scope, sessionId: string, e: { counts: Record<string, number>; note?: string }) {
  const s = await sessionOf(c, scope.entityId, sessionId, true);
  need(s.status === "open", `session ${s.number} is already closed`);
  let counted = 0n;
  const detail: Record<string, number> = {};
  for (const [k, v] of Object.entries(e.counts ?? {})) {
    const d = Number(k), n = Number(v);
    need(DENOMS.includes(d), `${k} is not a denomination the drawer is counted in`);
    need(Number.isInteger(n) && n >= 0, "counts are whole numbers");
    if (n) { detail[String(d)] = n; counted += BigInt(d) * BigInt(n); }
  }
  const expected = await expectedCash(c, scope.entityId, sessionId);
  const diff = counted - expected;
  if (diff !== 0n) need(String(e.note ?? "").trim(), `the drawer is ${diff < 0n ? "short" : "over"} ${usd(diff < 0n ? -diff : diff)}; say what happened`);
  let je: string | null = null;
  if (diff !== 0n) {
    const po = await profitObjectFor(c, scope.entityId, s.location_id);
    const abs = diff < 0n ? -diff : diff;
    je = await post(c, scope, { date: (await bizToday(c, scope, s.location_id)), sourceType: "receipt", sourceId: sessionId, description: `Drawer ${s.number} ${diff < 0n ? "short" : "over"}`,
      lines: diff < 0n ? [{ code: "6800", debit: abs, profitObjectId: po, memo: "cash short" }, { code: "1050", credit: abs, profitObjectId: po }]
                       : [{ code: "1050", debit: abs, profitObjectId: po }, { code: "6800", credit: abs, profitObjectId: po, memo: "cash over" }] });
  }
  // Store the Z report as it stood at close.
  await c.query(`update pos_session set expected_cash_minor = $3 where id = $1 and entity_id = $2`, [sessionId, scope.entityId, expected.toString()]);
  const z = await zReport(c, scope.entityId, sessionId);
  z.cash.countedMinor = counted; z.cash.overShortMinor = diff;
  await c.query(`update pos_session set status = 'closed', closed_by = $3, closed_at = now(), counted_minor = $4, counted_detail = $5,
      over_short_minor = $6, close_note = $7, journal_entry_id = $8, z_report = $9 where id = $1 and entity_id = $2`,
    [sessionId, scope.entityId, scope.actor.id, counted.toString(), JSON.stringify(detail), diff.toString(), e.note ?? null, je,
     JSON.stringify(z, (_k, v) => (typeof v === "bigint" ? v.toString() : v))]);
  return { number: s.number, expectedMinor: expected, countedMinor: counted, overShortMinor: diff, journalEntryId: je };
}

// ============================================================ building a sale

export type LineIn = { productId: string; qty: number; choices?: Choice[]; fulfillment?: Fulfil; discountMinor?: bigint; discountBps?: number;
  fulfilFromId?: string | null; promisedOn?: string | null; shipAddressId?: string | null;
  /** a sectional family: the layout or pieces and the cover; it sells as one configured line made of a line per piece */
  sectional?: sectionals.Build | null;
  /** an as-is (graded) piece, by its label: it rings at its graded tag price and that very piece goes out */
  asIsLabel?: string | null };

export type OrderIn = { kind: "sale" | "quote" | "layaway"; locationId: string; customerId?: string | null; sessionId?: string | null;
  lines: LineIn[]; salespeople?: { id: string; splitBps: number }[]; taxExemptRef?: string | null; notes?: string;
  shipAddressId?: string | null; promisedOn?: string | null; overrideReason?: string;
  /** the delivery day and window the salesperson picked; booked when the sale is placed */
  delivery?: { day: string; windowId: string } | null };

type OrderRow = { id: string; number: string; status: string; location_id: string; customer_id: string | null; total_minor: string; paid_minor: string;
  kind: string; quote_expires_on: string | null; tax_exempt_ref: string | null; paid_off_at: string | null; layaway_schedule: unknown;
  ship_address_id: string | null; promised_on: string | null };

/**
 * POS can act on any order of the company, not just its own: a web pickup
 * handed over at the counter, a web order returned at the register. The
 * first time it does, the order gets its POS side rows (kind 'sale'; each
 * line keeps the order's own fulfilment, marked adopted).
 */
async function adopt(c: Client, entityId: string, id: string) {
  const so = await q<{ id: string }>(c, `select id from sales_order where id = $1 and entity_id = $2`, [id, entityId]);
  if (!so.length) return;
  await c.query(`insert into pos_order (sales_order_id, entity_id, kind) values ($1,$2,'sale') on conflict (sales_order_id) do nothing`, [id, entityId]);
  await c.query(`insert into pos_line (sales_order_line_id, entity_id, sales_order_id, fulfillment, promised_on, ship_address_id, unit_cost_minor, list_price_minor, origin)
    select l.id, l.entity_id, l.sales_order_id, so.fulfillment, so.promised_on, so.ship_address_id, coalesce(p.cost_minor, 0), l.unit_price_minor, 'adopted'
      from sales_order_line l join sales_order so on so.id = l.sales_order_id left join product p on p.id = l.product_id
     where l.entity_id = $2 and l.sales_order_id = $1
       and not exists (select 1 from pos_line pl where pl.sales_order_line_id = l.id and pl.entity_id = l.entity_id)`, [id, entityId]);
}

async function orderOf(c: Client, entityId: string, id: string, lock = true): Promise<OrderRow> {
  if (lock) await adopt(c, entityId, id);
  const r = await q<OrderRow>(c, `select so.id, so.number, so.status, so.location_id, so.customer_id, so.total_minor, so.paid_minor,
      po.kind, po.quote_expires_on::text, po.tax_exempt_ref, po.paid_off_at, po.layaway_schedule, so.ship_address_id, so.promised_on::text
    from sales_order so join pos_order po on po.sales_order_id = so.id
   where so.id = $1 and so.entity_id = $2${lock ? " for update of so" : ""}`, [id, entityId]);
  need(r.length, "no such order");
  return r[0];
}

async function locationOf(c: Client, entityId: string, id: string) {
  const r = await q<{ id: string; name: string; kind: string; tax_rate_bps: number; state: string | null }>(c,
    `select id, name, kind, tax_rate_bps, coalesce(state, address->>'state') state from location where id = $1 and entity_id = $2 and status = 'active'`, [id, entityId]);
  need(r.length, "no such store");
  return r[0];
}

/** Where a line ships from: the store for take-with and pickup; for delivery, the store if it has it, else the warehouse that does. */
async function sourceFor(c: Client, entityId: string, productId: string, storeId: string, qty: number, f: Fulfil): Promise<string> {
  if (f === "carry" || f === "pickup") return storeId;
  const r = await q<{ location_id: string; kind: string; available: string }>(c, `
    select l.id location_id, l.kind, coalesce(s.on_hand - s.reserved - s.held, 0)::text available
      from location l left join stock_level s on s.location_id = l.id and s.entity_id = l.entity_id and s.product_id = $2
     where l.entity_id = $1 and l.status = 'active' and l.kind in ('store','warehouse','outlet')`, [entityId, productId]);
  const store = r.find((x) => x.location_id === storeId);
  if (store && Number(store.available) >= qty) return storeId;
  const wh = r.filter((x) => x.kind === "warehouse").sort((a, b) => Number(b.available) - Number(a.available));
  if (wh.length) return wh[0].location_id;
  return storeId;
}

type Ctx = { entityId: string; orderId: string; customerId: string | null; storeId: string; cert: tax.Cert | null; sourcing: tax.Sourced; settings: Settings;
  defaultAddress: string | null; defaultPromised: string | null; actorId: string; managerReason: string | null; kind: string;
  /** the customer's price list (an active trade account's), which prices every line */
  priceList: string | null };

/** The price list a customer buys on: their trade account's, while the account is active. */
export async function priceListOf(c: Client, entityId: string, customerId: string | null): Promise<string | null> {
  if (!customerId || !(await hasRelation(c, "trade_account"))) return null;
  return (await q<{ code: string }>(c, `select pl.code from trade_account t join price_list pl on pl.id = t.price_list_id and pl.entity_id = t.entity_id and pl.active
    where t.entity_id = $1 and t.customer_id = $2 and t.status = 'active' order by t.created_at limit 1`, [entityId, customerId]))[0]?.code ?? null;
}

/**
 * How a line goes when the salesperson did not say: a fee rides on the
 * delivery; a protection plan or service goes the way the goods on the order
 * go; goods go by their shipping class -- take-with only for carry items,
 * delivery for furniture, ship for parcel, otherwise pickup. Made-to-order
 * goods are never take-with.
 */
async function defaultFulfil(c: Client, ctx: Ctx, kind: string, shipClass: string, siblings: LineIn[]): Promise<Fulfil> {
  if (kind === "fee") return "delivery";
  if (!STOCKED.includes(kind) && kind !== "kit") {
    const already = await q<{ fulfillment: Fulfil }>(c, `select pl.fulfillment from pos_line pl join sales_order_line l on l.id = pl.sales_order_line_id
      join product p on p.id = l.product_id where pl.entity_id = $1 and pl.sales_order_id = $2 and l.line_status <> 'cancelled'
       and p.kind in ('stock','configurable','special_order','kit')`, [ctx.entityId, ctx.orderId]);
    const goods = [...already.map((x) => x.fulfillment), ...(siblings.map((x) => x.fulfillment).filter(Boolean) as Fulfil[])];
    return goods.includes("delivery") ? "delivery" : goods.includes("ship") ? "ship" : goods.includes("pickup") ? "pickup" : goods[0] ?? "carry";
  }
  if (shipClass === "carry" && kind === "stock") return "carry";
  if (shipClass === "delivery") return "delivery";
  if (shipClass === "parcel") return "ship";
  return "pickup";
}

async function insertLines(c: Client, scope: Scope, ctx: Ctx, lines: LineIn[]): Promise<{ lineIds: string[]; pendingOverrides: string[] }> {
  const seq0 = await one<{ s: number }>(c, `select coalesce(max(seq),0)::int s from sales_order_line where entity_id = $1 and sales_order_id = $2`, [ctx.entityId, ctx.orderId]);
  let seq = seq0.s;
  const ids: string[] = [], pending: string[] = [];
  const kitTable = await hasRelation(c, "product_kit_component");
  for (const ln of lines) {
    const qty = Number(ln.qty);
    need(Number.isFinite(qty) && qty > 0, "each line needs a quantity above zero");
    const base = await q<{ id: string; kind: string; taxable: boolean; name: string; status: string; ship_class: string }>(c,
      `select id, kind, taxable, name, status, ship_class from product where id = $1 and entity_id = $2`, [ln.productId, ctx.entityId]);
    need(base.length, "no such product");
    // A sectional sells as its pieces: one configured line, a real line per piece.
    const family = await sectionals.isFamily(c, ctx.entityId, ln.productId);
    let sectional: sectionals.Priced | null = null;
    if (family) {
      need(ln.sectional && (ln.sectional.layout || ln.sectional.pieces?.length), `${base[0].name} is built from pieces: choose a layout or the pieces, and the cover`);
      need(qty === 1, "a sectional is sold one at a time; add it again for a second one");
      try { sectional = await sectionals.priceBuild(c, ctx.entityId, ln.productId, ln.sectional!, { priceList: ctx.priceList }); }
      catch (e) { if (e instanceof sectionals.ConfigError) throw new PosError(e.message); throw e; }
    }
    const cfgd = family ? null : await priceConfigured(c, ctx.entityId, ln.productId, ln.choices ?? [], { priceList: ctx.priceList });
    // A package sells as its components, the package price spread over them by their own prices.
    type Part = { productId: string; sku: string; description: string; kind: string; taxable: boolean; qty: number; gross: bigint; unitCost: bigint;
      listPrice: bigint; config: unknown; packageSku: string | null; shipClass: string; special?: boolean };
    let parts: Part[];
    if (sectional) {
      parts = sectional.parts.map((x) => ({ productId: x.productId, sku: x.sku, description: x.description, kind: x.kind, taxable: x.taxable, qty: 1,
        gross: x.netMinor, unitCost: x.costMinor, listPrice: x.grossMinor, config: x.config, packageSku: sectional!.familySku, shipClass: x.shipClass, special: x.special }));
    } else if (base[0].kind === "kit" && kitTable) {
      const cfg = cfgd!;
      const comps = await q<{ id: string; sku: string; name: string; kind: string; taxable: boolean; price_minor: string; cost_minor: string; qty: string; ship_class: string }>(c, `
        select p.id, p.sku, p.name, p.kind, p.taxable, p.price_minor, p.cost_minor, k.qty, p.ship_class from product_kit_component k join product p on p.id = k.component_id
         where k.entity_id = $1 and k.kit_id = $2 order by k.seq, p.sku`, [ctx.entityId, ln.productId]);
      need(comps.length, `${base[0].name} has no components set up`);
      const packageGross = BigInt(Math.round(qty * Number(cfg.unitPriceMinor)));
      const listTotal = comps.reduce((a, x) => a + BigInt(x.price_minor) * BigInt(Math.round(Number(x.qty) * 100)), 0n);
      let left = packageGross;
      parts = comps.map((x, i) => {
        const weight = BigInt(x.price_minor) * BigInt(Math.round(Number(x.qty) * 100));
        const share = i === comps.length - 1 ? left : listTotal > 0n ? (packageGross * weight) / listTotal : 0n;
        left -= share;
        return { productId: x.id, sku: x.sku, description: `${x.name} (in ${cfg.name})`, kind: x.kind, taxable: x.taxable, qty: qty * Number(x.qty),
          gross: share, unitCost: BigInt(x.cost_minor), listPrice: BigInt(x.price_minor), config: { package: cfg.sku }, packageSku: cfg.sku, shipClass: x.ship_class };
      });
    } else {
      const cfg = cfgd!;
      parts = [{ productId: cfg.productId, sku: cfg.sku, description: cfg.description, kind: base[0].kind, taxable: base[0].taxable, qty,
        gross: BigInt(Math.round(qty * Number(cfg.unitPriceMinor))), unitCost: cfg.unitCostMinor, listPrice: cfg.unitPriceMinor, config: cfg.config, packageSku: null, shipClass: base[0].ship_class }];
    }
    // An as-is piece rings at its graded tag price, from where it stands; checkout puts that piece on the line.
    let asIs: { label: string; location_id: string } | null = null;
    if (ln.asIsLabel) {
      need(!family && base[0].kind === "stock" && parts.length === 1, "only a single stocked product is sold as an as-is piece");
      need(qty === 1, "an as-is piece is sold one at a time");
      const u = (await q<{ label: string; status: string; line: string | null; location_id: string; price: string | null; grade: string | null }>(c, `
        select x.label, x.status, x.sales_order_line_id line, x.location_id, coalesce(ic.price_minor, x.as_is_price_minor)::text price, ic.grade
          from inv_piece x left join inv_condition ic on ic.entity_id = x.entity_id and ic.unit_id = x.unit_id and ic.superseded_at is null
         where x.entity_id = $1 and x.product_id = $2 and upper(x.label) = upper($3) order by x.carton_seq limit 1`, [ctx.entityId, ln.productId, String(ln.asIsLabel).trim()]))[0];
      need(u, `${ln.asIsLabel} is not a piece of ${base[0].name}`);
      need(["as_is", "in_stock"].includes(u.status) && !u.line, `${u.label} is ${u.status.replace(/_/g, " ")}${u.line ? " and on another order" : ""}; it cannot be sold as is`);
      need(u.price != null, `${u.label} has no as-is price yet; grade it first`);
      const words = u.grade ? sectionals.CONDITION_WORDS[u.grade] : "as is";
      parts[0] = { ...parts[0], gross: BigInt(u.price!), listPrice: BigInt(u.price!), description: `${parts[0].description} — as is, ${words.toLowerCase()} (${u.label})`,
        config: { ...(parts[0].config as Record<string, unknown>), asIs: { label: u.label, grade: u.grade } } };
      asIs = { label: u.label, location_id: u.location_id };
    }
    const firstId = ids.length;
    const lineGross = parts.reduce((a, p) => a + p.gross, 0n);
    let discount = ln.discountMinor ?? 0n;
    if (ln.discountBps) discount = bps(lineGross, ln.discountBps);
    need(discount >= 0n && discount <= lineGross, "a discount cannot be negative or more than the line");
    // Overrides: past the discount limit, or below cost.
    const why: string[] = [];
    const discBps = lineGross > 0n ? Number((discount * 10000n) / lineGross) : 0;
    if (discBps > ctx.settings.discountLimitBps) why.push(`${pct(discBps)} off is past the ${pct(ctx.settings.discountLimitBps)} limit`);
    const costTotal = parts.reduce((a, p) => a + (STOCKED.includes(p.kind) ? BigInt(Math.round(p.qty * Number(p.unitCost))) : 0n), 0n);
    // An as-is piece's price was set by its grade (or by a manager, with a reason): it is not a below-cost sale.
    if (costTotal > 0n && lineGross - discount < costTotal && !(asIs && discount === 0n)) why.push(`${usd(lineGross - discount)} is below cost (${usd(costTotal)})`);
    let left = discount;
    const isPackage = parts.length > 1 || parts[0].packageSku;
    for (const [i, p] of parts.entries()) {
      const share = i === parts.length - 1 ? left : lineGross > 0n ? (discount * p.gross) / lineGross : 0n;
      left -= share;
      const stocked = STOCKED.includes(p.kind);
      let f: Fulfil = ln.fulfillment ?? await defaultFulfil(c, ctx, p.kind, p.shipClass, lines);
      need(FULFIL.includes(f), "fulfilment is take-with, pickup, delivery or direct ship");
      if (ctx.kind === "layaway" && f === "carry") f = "pickup";       // layaway goods leave when paid in full
      if (f === "carry" && stocked) need(p.kind === "stock", `${p.description} is made or ordered for the customer; it cannot be taken today`);
      const shipAddr = f === "delivery" || f === "ship" ? (ln.shipAddressId ?? ctx.defaultAddress) : null;
      const promised = f === "delivery" || f === "pickup" ? (ln.promisedOn ?? ctx.defaultPromised) : null;
      if (f === "delivery") {
        need(ctx.customerId, "a delivery needs a customer");
        need(shipAddr, "a delivery needs an address");
        need(promised, "a delivery needs a promised date");
        need(promised! >= (await bizToday(c, scope)), "the promised date has passed");
      }
      if (f === "ship") need(shipAddr, "direct ship needs an address");
      if (shipAddr) {
        const a = await q(c, `select id from customer_address where id = $1 and entity_id = $2 and customer_id = $3`, [shipAddr, ctx.entityId, ctx.customerId]);
        need(a.length, "that address is not one of this customer's");
      }
      const from = stocked ? (asIs ? asIs.location_id : ln.fulfilFromId ?? await sourceFor(c, ctx.entityId, p.productId, ctx.storeId, p.qty, f)) : null;
      if (from) {
        const okLoc = await q(c, `select id from location where id = $1 and entity_id = $2 and status = 'active'`, [from, ctx.entityId]);
        need(okLoc.length, "no such location to fulfil from");
        if (f === "carry") need(from === ctx.storeId, "take-with goods come from this store");
      }
      const unit = p.qty ? BigInt(Math.round(Number(p.gross) / p.qty)) : 0n;
      // Keep the line's own extension exact: unit x qty, any rounding goes into the discount.
      const ext = BigInt(Math.round(p.qty * Number(unit)));
      const disc = share + (ext - p.gross);
      const net = ext - (disc < 0n ? 0n : disc);
      // Taxed where it is handed over: the store, or the ship-to address when the company sources by destination.
      const cls = tax.classOf(p.kind);
      const place = await tax.stackForLine(c, ctx.entityId, { storeId: ctx.storeId, fulfillment: f, shipAddressId: shipAddr, sourcing: ctx.sourcing });
      const lt = tax.computeLine(place.stack, { netMinor: net, itemClass: cls, taxable: p.taxable, cert: ctx.cert });
      seq++;
      const row = await one<{ id: string }>(c, `insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor,
          discount_minor, tax_minor, config, fulfil_from_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [ctx.entityId, ctx.orderId, seq, p.productId, p.sku, p.description.slice(0, 300), p.qty, unit.toString(), (disc < 0n ? 0n : disc).toString(),
         lt.taxMinor.toString(), JSON.stringify(p.config ?? {}), from]);
      await tax.writeLineTax(c, ctx.entityId, ctx.orderId, row.id, lt.rows, place, cls);
      const needs = why.length && (i === 0 || !isPackage) ? why.join("; ") : null;
      let overrideId: string | null = null;
      if (needs && ctx.managerReason) {
        overrideId = (await one<{ id: string }>(c, `insert into pos_override (entity_id, sales_order_id, sales_order_line_id, kind, detail, requested_by, approved_by, reason)
          values ($1,$2,$3,$4,$5,$6,$6,$7) returning id`, [ctx.entityId, ctx.orderId, row.id, why[0].includes("cost") ? "below_cost" : "discount", needs,
          ctx.actorId, ctx.managerReason])).id;
      }
      await c.query(`insert into pos_line (sales_order_line_id, entity_id, sales_order_id, fulfillment, promised_on, ship_address_id, unit_cost_minor,
          list_price_minor, package_sku, needs_override, override_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [row.id, ctx.entityId, ctx.orderId, f, promised, shipAddr, p.unitCost.toString(), p.listPrice.toString(), p.packageSku,
         overrideId ? null : needs, overrideId]);
      if (needs && !overrideId) pending.push(`line ${seq} (${p.sku}): ${needs}`);
      // A piece in a cover or with options that is not stocked is made for the customer: on order from the start.
      if (p.special) await c.query(`update sales_order_line set line_status = 'on_order' where id = $1 and entity_id = $2`, [row.id, ctx.entityId]);
      ids.push(row.id);
    }
    if (sectional) await sectionals.recordSet(c, ctx.entityId, { orderId: ctx.orderId, priced: sectional, lineIds: ids.slice(firstId), channel: "pos", by: ctx.actorId });
  }
  return { lineIds: ids, pendingOverrides: pending };
}

/** What delivery costs to an address: the fleet zone for its postal code, else the company's flat delivery fee setting, else the fee product's price. */
export async function deliveryFeeFor(c: Client, entityId: string, addressId: string | null): Promise<{ feeMinor: bigint; zone: string | null }> {
  const postal = addressId ? (await q<{ postal: string }>(c, `select postal from customer_address where id = $1 and entity_id = $2`, [addressId, entityId]))[0]?.postal : null;
  if (postal && await hasRelation(c, "delivery_zone")) {
    const z = await q<{ code: string; fee_minor: string }>(c, `select code, fee_minor from delivery_zone where entity_id = $1 and active and $2 = any(postal_codes) limit 1`,
      [entityId, postal.trim().slice(0, 5)]);
    if (z.length) return { feeMinor: BigInt(z[0].fee_minor), zone: z[0].code };
  }
  if (await hasRelation(c, "entity_setting")) {
    const st = await q<{ v: string }>(c, `select value::text v from entity_setting where entity_id = $1 and key = 'fleet.delivery_fee_minor'`, [entityId]);
    if (st.length && /^\d+$/.test(st[0].v)) return { feeMinor: BigInt(st[0].v), zone: null };
  }
  const set = await settings(c, entityId);
  if (!set.deliveryProductId) return { feeMinor: 0n, zone: null };
  const pr = await q<{ price_minor: string }>(c, `select price_minor from product where id = $1 and entity_id = $2`, [set.deliveryProductId, entityId]);
  return { feeMinor: BigInt(pr[0]?.price_minor ?? 0), zone: null };
}

/**
 * A delivery sale carries a delivery fee. When goods on the order go by
 * delivery and no delivery fee is on it, one is added at the customer's zone
 * rate. Taking it off later needs a reason, and a manager when goods are
 * still being delivered (voidLine). A fee taken off is not put back.
 */
async function ensureDeliveryFee(c: Client, ctx: Ctx) {
  const feeProduct = ctx.settings.deliveryProductId;
  if (!feeProduct) return null;
  const goods = await q<{ ship_address_id: string | null; promised_on: string | null }>(c, `
    select pl.ship_address_id, pl.promised_on::text from pos_line pl join sales_order_line l on l.id = pl.sales_order_line_id join product p on p.id = l.product_id
     where pl.entity_id = $1 and pl.sales_order_id = $2 and pl.fulfillment = 'delivery' and l.line_status <> 'cancelled' and p.kind in ('stock','configurable','special_order','kit')
     order by l.seq limit 1`, [ctx.entityId, ctx.orderId]);
  if (!goods.length) return null;
  const has = await q(c, `select l.id from sales_order_line l where l.entity_id = $1 and l.sales_order_id = $2 and l.product_id = $3`, [ctx.entityId, ctx.orderId, feeProduct]);
  if (has.length) return null;
  const fee = await deliveryFeeFor(c, ctx.entityId, goods[0].ship_address_id);
  if (fee.feeMinor <= 0n) return null;
  const p = (await q<{ sku: string; name: string; taxable: boolean; kind: string }>(c, `select sku, name, taxable, kind from product where id = $1 and entity_id = $2`, [feeProduct, ctx.entityId]))[0];
  if (!p) return null;
  const cls = tax.classOf(p.kind);
  const place = await tax.stackForLine(c, ctx.entityId, { storeId: ctx.storeId, fulfillment: "delivery", shipAddressId: goods[0].ship_address_id, sourcing: ctx.sourcing });
  const lt = tax.computeLine(place.stack, { netMinor: fee.feeMinor, itemClass: cls, taxable: p.taxable, cert: ctx.cert });
  const seq = (await one<{ s: number }>(c, `select coalesce(max(seq),0)::int + 1 s from sales_order_line where entity_id = $1 and sales_order_id = $2`, [ctx.entityId, ctx.orderId])).s;
  const row = await one<{ id: string }>(c, `insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, tax_minor, config)
    values ($1,$2,$3,$4,$5,$6,1,$7,$8,$9) returning id`, [ctx.entityId, ctx.orderId, seq, feeProduct, p.sku, fee.zone ? `${p.name} (zone ${fee.zone})` : p.name,
    fee.feeMinor.toString(), lt.taxMinor.toString(), JSON.stringify({ auto: "delivery_fee", zone: fee.zone })]);
  await tax.writeLineTax(c, ctx.entityId, ctx.orderId, row.id, lt.rows, place, cls);
  await c.query(`insert into pos_line (sales_order_line_id, entity_id, sales_order_id, fulfillment, promised_on, ship_address_id, list_price_minor)
    values ($1,$2,$3,'delivery',$4,$5,$6)`, [row.id, ctx.entityId, ctx.orderId, goods[0].promised_on, goods[0].ship_address_id, fee.feeMinor.toString()]);
  return { lineId: row.id, feeMinor: fee.feeMinor, zone: fee.zone };
}

/** An as-is piece sold by its label: once its line is reserved, that very piece is put on it (not the oldest free one). */
async function allocateAsIs(c: Client, scope: Scope, orderId: string) {
  const ls = await q<{ id: string; label: string; sku: string }>(c, `select l.id, l.config->'asIs'->>'label' label, l.sku from sales_order_line l
    where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status = 'reserved' and l.config ? 'asIs'
      and not exists (select 1 from inv_piece x where x.entity_id = l.entity_id and x.sales_order_line_id = l.id)`, [scope.entityId, orderId]);
  for (const l of ls) await allocate(c, scope, l.label, l.id);
}

/** The order header follows its lines: delivery if any line is delivered, the earliest promise, the totals. */
async function refreshHeader(c: Client, entityId: string, orderId: string) {
  await c.query(`
    update sales_order so set
      fulfillment = coalesce((select pl.fulfillment from pos_line pl join sales_order_line l on l.id = pl.sales_order_line_id
                                where pl.entity_id = $2 and pl.sales_order_id = so.id and l.line_status <> 'cancelled'
                                order by case pl.fulfillment when 'delivery' then 0 when 'ship' then 1 when 'pickup' then 2 else 3 end limit 1), 'carry'),
      ship_address_id = coalesce((select pl.ship_address_id from pos_line pl join sales_order_line l on l.id = pl.sales_order_line_id
                                where pl.entity_id = $2 and pl.sales_order_id = so.id and l.line_status <> 'cancelled' and pl.ship_address_id is not null
                                order by case pl.fulfillment when 'delivery' then 0 else 1 end limit 1), so.ship_address_id),
      promised_on = (select min(pl.promised_on) from pos_line pl join sales_order_line l on l.id = pl.sales_order_line_id
                      where pl.entity_id = $2 and pl.sales_order_id = so.id and l.line_status not in ('cancelled','fulfilled'))
    where so.id = $1 and so.entity_id = $2`, [orderId, entityId]);
  await c.query(`select sales_order_retotal($1) /* unscoped: order id already checked against the entity */`, [orderId]);
}

async function validatePeople(c: Client, scope: Scope, sp: { id: string; splitBps: number }[]) {
  need(sp.length, "name the salesperson");
  need(sp.length <= 4, "split a sale four ways at most");
  const total = sp.reduce((a, x) => a + Number(x.splitBps), 0);
  need(total === 10000, `the salesperson splits add up to ${pct(total)}, not 100%`);
  need(new Set(sp.map((x) => x.id)).size === sp.length, "each salesperson once");
  const ok = await q<{ id: string }>(c, `select u.id from app_user u where u.id = any($1) and u.status = 'active'
      and exists (select 1 from role_grant g where g.app_user_id = u.id and (g.entity_id = $2 or (g.entity_id is null and u.tenant_id = $3)))`,
    [sp.map((x) => x.id), scope.entityId, scope.tenantId]);
  need(ok.length === sp.length, "a salesperson named is not one of this company's people");
}

export async function createOrder(c: Client, scope: Scope, roles: Set<string>, e: OrderIn) {
  need(["sale", "quote", "layaway"].includes(e.kind), "a POS order is a sale, a quote or a layaway");
  if (e.delivery && !(e.lines ?? []).some((l) => l.fulfillment === "delivery")) e = { ...e, delivery: null };   // nothing goes on a truck
  if (e.delivery?.day && /^\d{4}-\d{2}-\d{2}$/.test(e.delivery.day)) e = { ...e, promisedOn: e.delivery.day };   // the picked day is the promise
  const loc = await locationOf(c, scope.entityId, e.locationId);
  need(["store", "outlet"].includes(loc.kind), `${loc.name} is not a store`);
  need(e.lines?.length, "add something to sell");
  const set = await settings(c, scope.entityId);
  let customer: { id: string; status: string; tax_exempt_ref: string | null; name: string } | null = null;
  if (e.customerId) {
    const r = await q<{ id: string; status: string; tax_exempt_ref: string | null; name: string }>(c,
      `select id, status, tax_exempt_ref, name from customer where id = $1 and entity_id = $2`, [e.customerId, scope.entityId]);
    need(r.length, "no such customer");
    need(r[0].status !== "inactive", `${r[0].name} is inactive`);
    customer = r[0];
  }
  if (e.kind !== "sale") need(customer, `a ${e.kind} needs a customer`);
  const exemptRef = (e.taxExemptRef ?? "").trim() || null;
  if (exemptRef) need(customer, "a tax-exempt sale needs the customer it is exempt for");
  // The certificate must be the customer's, not void and not expired.
  const cert = exemptRef ? await tax.certificateFor(c, scope.entityId, customer!.id, exemptRef, (await bizToday(c, scope)), loc.state) : null;
  const addr = e.shipAddressId ?? (customer ? (await q<{ id: string }>(c,
    `select id from customer_address where entity_id = $1 and customer_id = $2 order by is_default desc limit 1`, [scope.entityId, customer.id]))[0]?.id ?? null : null);
  const number = await nextNo(c, scope.entityId, "order", "SO-");
  const so = await one<{ id: string }>(c, `insert into sales_order (entity_id, number, channel, location_id, customer_id, status, notes, created_by)
    values ($1,$2,'pos',$3,$4,'draft',$5,$6) returning id`, [scope.entityId, number, loc.id, customer?.id ?? null, e.notes ?? null, scope.actor.id]);
  const dl = e.delivery && /^\d{4}-\d{2}-\d{2}$/.test(e.delivery.day) && /^[0-9a-f-]{36}$/i.test(e.delivery.windowId) ? e.delivery : null;
  if (dl) {
    const w = await q(c, `select 1 from delivery_window where entity_id = $1 and id = $2 and active`, [scope.entityId, dl.windowId]);
    need(w.length, "that delivery window is not offered any more; pick the day again");
  }
  await c.query(`insert into pos_order (sales_order_id, entity_id, kind, quote_expires_on, tax_exempt_ref, register_session_id, created_by, delivery_day, delivery_window_id,
      exemption_certificate_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [so.id, scope.entityId, e.kind, e.kind === "quote" ? addDays((await bizToday(c, scope)), set.quoteValidDays) : null, exemptRef,
    e.sessionId ?? null, scope.actor.id, dl?.day ?? null, dl?.windowId ?? null, cert?.id || null]);
  if (dl) await c.query(`update sales_order set promised_on = $3 where id = $1 and entity_id = $2`, [so.id, scope.entityId, dl.day]);
  const sp = e.salespeople?.length ? e.salespeople : [{ id: scope.actor.id!, splitBps: 10000 }];
  await validatePeople(c, scope, sp);
  for (const p of sp) await c.query(`insert into sales_order_salesperson (entity_id, sales_order_id, app_user_id, split_bps) values ($1,$2,$3,$4)`,
    [scope.entityId, so.id, p.id, p.splitBps]);
  const primary = [...sp].sort((a, b) => b.splitBps - a.splitBps)[0].id;
  await c.query(`update sales_order set salesperson_id = $3 where id = $1 and entity_id = $2`, [so.id, scope.entityId, primary]);
  const isManager = MANAGERS.some((r) => roles.has(r));
  const ctx: Ctx = { entityId: scope.entityId, orderId: so.id, customerId: customer?.id ?? null, storeId: loc.id, cert, sourcing: await tax.sourcing(c, scope.entityId), settings: set,
    defaultAddress: addr, defaultPromised: e.promisedOn ?? null, actorId: scope.actor.id!, kind: e.kind, priceList: await priceListOf(c, scope.entityId, customer?.id ?? null),
    managerReason: isManager && String(e.overrideReason ?? "").trim() ? String(e.overrideReason).trim() : null };
  const r = await insertLines(c, scope, ctx, e.lines);
  const fee = await ensureDeliveryFee(c, ctx);
  await refreshHeader(c, scope.entityId, so.id);
  await audit(c, scope, { table: "sales_order", rowId: so.id, action: "insert", after: { number, kind: e.kind, lines: r.lineIds.length, exemptRef }, sourceRef: "pos" });
  // A delivery to a ZIP no local jurisdiction covers is taxed as best it can be, and the salesperson is told.
  const taxNotes = (await q<{ note: string }>(c, `select distinct note from sales_order_line_tax where entity_id = $1 and sales_order_id = $2 and note is not null`,
    [scope.entityId, so.id])).map((x) => x.note);
  return { id: so.id, number, pendingOverrides: r.pendingOverrides, deliveryFeeMinor: fee?.feeMinor ?? 0n, taxNotes };
}

async function ctxFor(c: Client, scope: Scope, roles: Set<string>, o: OrderRow, reason?: string): Promise<Ctx> {
  const loc = await locationOf(c, scope.entityId, o.location_id);
  const isManager = MANAGERS.some((r) => roles.has(r));
  const cert = o.tax_exempt_ref && o.customer_id ? await tax.certificateFor(c, scope.entityId, o.customer_id, o.tax_exempt_ref, (await bizToday(c, scope)), loc.state) : null;
  return { entityId: scope.entityId, orderId: o.id, customerId: o.customer_id, storeId: o.location_id, cert, sourcing: await tax.sourcing(c, scope.entityId),
    settings: await settings(c, scope.entityId), defaultAddress: o.ship_address_id, defaultPromised: o.promised_on, actorId: scope.actor.id!, kind: o.kind,
    priceList: await priceListOf(c, scope.entityId, o.customer_id),
    managerReason: isManager && String(reason ?? "").trim() ? String(reason).trim() : null };
}

export async function addLines(c: Client, scope: Scope, roles: Set<string>, orderId: string, lines: LineIn[], overrideReason?: string) {
  const o = await orderOf(c, scope.entityId, orderId);
  need(o.status === "draft", `${o.number} has been placed; lines change on a draft or a quote only`);
  const ctx = await ctxFor(c, scope, roles, o, overrideReason);
  const r = await insertLines(c, scope, ctx, lines);
  await ensureDeliveryFee(c, ctx);
  await refreshHeader(c, scope.entityId, orderId);
  await audit(c, scope, { table: "sales_order", rowId: orderId, action: "update", after: { added: r.lineIds.length }, sourceRef: "pos" });
  return r;
}

export async function voidLine(c: Client, scope: Scope, orderId: string, lineId: string, reason: string, roles: Set<string> = new Set()) {
  const o = await orderOf(c, scope.entityId, orderId);
  need(o.status === "draft", `${o.number} has been placed; cancel the order or return the goods instead`);
  need(String(reason ?? "").trim(), "say why the line comes off");
  const set = await settings(c, scope.entityId);
  const fee = await q<{ id: string }>(c, `select l.id from sales_order_line l where l.id = $1 and l.entity_id = $2 and l.sales_order_id = $3 and l.product_id = $4`,
    [lineId, scope.entityId, orderId, set.deliveryProductId]);
  if (fee.length) {
    const still = await q(c, `select 1 from pos_line pl join sales_order_line l on l.id = pl.sales_order_line_id join product p on p.id = l.product_id
      where pl.entity_id = $1 and pl.sales_order_id = $2 and pl.fulfillment = 'delivery' and l.line_status <> 'cancelled' and p.kind <> 'fee' limit 1`, [scope.entityId, orderId]);
    if (still.length) {
      need(MANAGERS.some((r) => roles.has(r)), "waiving the delivery fee on a delivery needs a store manager");
      await c.query(`insert into pos_override (entity_id, sales_order_id, sales_order_line_id, kind, detail, approved_by, reason) values ($1,$2,$3,'discount','delivery fee waived',$4,$5)`,
        [scope.entityId, orderId, lineId, scope.actor.id, reason.trim()]);
    }
  }
  // A sectional is sold as a set: one of its pieces comes off with all of them.
  const sold = await sectionals.setOfLine(c, scope.entityId, lineId);
  const lineIds = sold ? sold.lineIds : [lineId];
  await releaseLines(c, scope.entityId, orderId, lineIds);   // a line a quote was holding gives its stock back
  const r = await q<{ sku: string }>(c, `update sales_order_line set line_status = 'cancelled' where id = any($1::uuid[]) and entity_id = $2 and sales_order_id = $3
      and line_status <> 'cancelled' returning sku`, [lineIds, scope.entityId, orderId]);
  need(r.length, "no such line on this order");
  await c.query(`update pos_line set needs_override = null where sales_order_line_id = any($1::uuid[]) and entity_id = $2`, [lineIds, scope.entityId]);
  await refreshHeader(c, scope.entityId, orderId);
  await audit(c, scope, { table: "sales_order", rowId: orderId, action: "update", after: { voided: r.map((x) => x.sku).join(", "), set: sold?.number }, reason });
  return { ok: true, voided: r.length, set: sold?.number ?? null };
}

/** A manager allows a discount past the limit, or a price below cost. Who and why are kept. */
export async function approveOverride(c: Client, scope: Scope, orderId: string, lineId: string, reason: string) {
  const o = await orderOf(c, scope.entityId, orderId);
  need(o.status === "draft", `${o.number} has been placed`);
  need(String(reason ?? "").trim(), "say why the override is allowed");
  const r = await q<{ needs_override: string | null; created_by: string | null }>(c, `select pl.needs_override, po.created_by from pos_line pl
      join pos_order po on po.sales_order_id = pl.sales_order_id where pl.sales_order_line_id = $1 and pl.entity_id = $2 and pl.sales_order_id = $3`,
    [lineId, scope.entityId, orderId]);
  need(r.length, "no such line on this order");
  need(r[0].needs_override, "that line does not need an override");
  const ov = await one<{ id: string }>(c, `insert into pos_override (entity_id, sales_order_id, sales_order_line_id, kind, detail, requested_by, approved_by, reason)
    values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [scope.entityId, orderId, lineId, r[0].needs_override.includes("cost") ? "below_cost" : "discount",
    r[0].needs_override, r[0].created_by, scope.actor.id, reason.trim()]);
  await c.query(`update pos_line set needs_override = null, override_id = $3 where sales_order_line_id = $1 and entity_id = $2`, [lineId, scope.entityId, ov.id]);
  await audit(c, scope, { table: "sales_order", rowId: orderId, action: "transition", after: { override: r[0].needs_override }, reason });
  return { ok: true };
}

export async function convertQuote(c: Client, scope: Scope, orderId: string) {
  const o = await orderOf(c, scope.entityId, orderId);
  need(o.kind === "quote", `${o.number} is not a quote`);
  need(o.status === "draft", `${o.number} is ${o.status}`);
  need(!o.quote_expires_on || o.quote_expires_on >= (await bizToday(c, scope)), `quote ${o.number} expired on ${o.quote_expires_on}; make a new one at today's prices`);
  if (o.tax_exempt_ref && o.customer_id) await tax.certificateFor(c, scope.entityId, o.customer_id, o.tax_exempt_ref, (await bizToday(c, scope)));
  // The hold ends here: the sale reserves for itself when it is placed.
  const hold = await endHold(c, scope, orderId, "converted", "the quote became a sale");
  await c.query(`update pos_order set kind = 'sale' where sales_order_id = $1 and entity_id = $2`, [orderId, scope.entityId]);
  // A link the customer already has keeps working and now shows the order; it no longer ends with the quote.
  await c.query(`update tear_sheet_link set expires_at = greatest(expires_at, now() + interval '30 days') where entity_id = $1 and sales_order_id = $2 and revoked_at is null`,
    [scope.entityId, orderId]);
  await audit(c, scope, { table: "sales_order", rowId: orderId, action: "transition", after: { kind: "sale", from: "quote", holdReleased: hold?.released ?? 0 } });
  return { id: orderId, number: o.number };
}

/**
 * Clear or swap the exemption certificate on a draft (one voided or expired
 * since it was written). The lines are taxed again at the same places; only
 * the certificate changes.
 */
export async function setExemption(c: Client, scope: Scope, orderId: string, ref: string | null) {
  const o = await orderOf(c, scope.entityId, orderId);
  need(o.status === "draft", `${o.number} has been placed; its tax is settled`);
  const number = String(ref ?? "").trim() || null;
  if (number) need(o.customer_id, "a tax-exempt sale needs the customer it is exempt for");
  const loc = await locationOf(c, scope.entityId, o.location_id);
  const cert = number ? await tax.certificateFor(c, scope.entityId, o.customer_id!, number, (await bizToday(c, scope)), loc.state) : null;
  await c.query(`update pos_order set tax_exempt_ref = $3, exemption_certificate_id = $4 where sales_order_id = $1 and entity_id = $2`,
    [orderId, scope.entityId, number, cert?.id || null]);
  const lines = await q<{ id: string; net: string; kind: string | null; taxable: boolean | null }>(c, `
    select l.id, (round(l.qty * l.unit_price_minor) - l.discount_minor)::bigint::text net, p.kind, p.taxable
      from sales_order_line l left join product p on p.id = l.product_id
     where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status <> 'cancelled'`, [scope.entityId, orderId]);
  for (const l of lines) {
    const ids = (await q<{ jurisdiction_id: string }>(c, `select jurisdiction_id from sales_order_line_tax where entity_id = $1 and sales_order_line_id = $2 order by created_at, id`,
      [scope.entityId, l.id])).map((x) => x.jurisdiction_id);
    if (!ids.length) continue;
    const stack = (await tax.stackJurisdictions(c, scope.entityId, ids));
    const lt = tax.computeLine(stack, { netMinor: BigInt(l.net), itemClass: tax.classOf(l.kind), taxable: l.taxable !== false && !!l.kind, cert });
    for (const r of lt.rows) await c.query(`update sales_order_line_tax set taxable_minor = $4, exempt_minor = $5, exempt_reason = $6, tax_minor = $7, owed_minor = $7
        where entity_id = $1 and sales_order_line_id = $2 and jurisdiction_id = $3`, [scope.entityId, l.id, r.jurisdictionId, r.taxableMinor.toString(), r.exemptMinor.toString(),
      r.exemptReason, r.taxMinor.toString()]);
    await c.query(`update sales_order_line set tax_minor = $3 where id = $1 and entity_id = $2`, [l.id, scope.entityId, lt.taxMinor.toString()]);
  }
  await refreshHeader(c, scope.entityId, orderId);
  await audit(c, scope, { table: "sales_order", rowId: orderId, action: "update", before: { exemptRef: o.tax_exempt_ref }, after: { exemptRef: number } });
  return { exemptRef: number };
}

// ===================================================== deposits and holds

/**
 * The least a sale must have paid when it is placed: the special-order share
 * of the goods that will be on order (made to order, or more than the
 * fulfilling location has free), plus the stocked share of the rest. Before
 * checkout it is worked out from stock as it stands; after, from the lines
 * that did go on order.
 */
export async function depositRequirement(c: Client, entityId: string, orderId: string) {
  const set = await settings(c, entityId);
  const st = await one<{ status: string; paid_minor: string }>(c, `select status, paid_minor from sales_order where id = $1 and entity_id = $2`, [orderId, entityId]);
  const lines = await q<{ id: string; seq: number; sku: string; kind: string; line_status: string; qty: string; gross: string; avail: string | null }>(c, `
    select l.id, l.seq, l.sku, p.kind, l.line_status, l.qty::text, (round(l.qty * l.unit_price_minor) - l.discount_minor + l.tax_minor)::bigint::text gross,
           (select (s.on_hand - s.reserved - s.held)::text from stock_level s where s.entity_id = l.entity_id and s.product_id = l.product_id and s.location_id = l.fulfil_from_id) avail
      from sales_order_line l join product p on p.id = l.product_id
      left join pos_line pl on pl.sales_order_line_id = l.id
     where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status not in ('cancelled','returned') and coalesce(pl.role, 'item') = 'item'
       and p.kind = any($3) order by l.seq`, [entityId, orderId, STOCKED]);
  let onOrder = 0n, stocked = 0n;
  const out = [];
  for (const l of lines) {
    const willOrder = st.status === "draft"
      ? (l.line_status === "on_order" || (l.line_status !== "reserved" && (l.kind !== "stock" || Number(l.avail ?? 0) < Number(l.qty))))
      : l.line_status === "on_order";
    if (willOrder) onOrder += BigInt(l.gross); else stocked += BigInt(l.gross);
    out.push({ seq: l.seq, sku: l.sku, onOrder: willOrder });
  }
  const required = bps(onOrder, set.specialOrderDepositBps) + bps(stocked, set.stockedDepositBps);
  return { requiredMinor: required, onOrderMinor: onOrder, stockedMinor: stocked, specialOrderBps: set.specialOrderDepositBps, stockedBps: set.stockedDepositBps,
    paidMinor: BigInt(st.paid_minor), shortMinor: required > BigInt(st.paid_minor) ? required - BigInt(st.paid_minor) : 0n, lines: out };
}

type HoldRow = { id: string; held_until: string; status: string; lines_held: number };
async function activeHold(c: Client, entityId: string, orderId: string): Promise<HoldRow | null> {
  return (await q<HoldRow>(c, `select id, held_until::text, status, lines_held from pos_quote_hold where entity_id = $1 and sales_order_id = $2 and status = 'active' for update`,
    [entityId, orderId]))[0] ?? null;
}

/**
 * Hold the quote's stock for the customer: what is free where each line
 * fills from is reserved, until the hold's day (the setting's most, and never
 * past the quote's own expiry). Lines that cannot be covered are not held.
 */
export async function holdQuote(c: Client, scope: Scope, orderId: string, e: { days?: number } = {}) {
  const o = await orderOf(c, scope.entityId, orderId);
  need(o.kind === "quote" && o.status === "draft", `${o.number} is not an open quote; only a quote holds stock`);
  const set = await settings(c, scope.entityId);
  need(set.quoteHoldsAllowed, "this company does not let quotes hold stock; a manager can turn it on in the selling rules");
  need(!(await activeHold(c, scope.entityId, orderId)), `${o.number} already holds its stock; a manager can extend the hold`);
  const days = Math.trunc(Number(e.days ?? set.quoteHoldMaxDays));
  need(days >= 1 && days <= set.quoteHoldMaxDays, `a quote holds stock for 1 to ${set.quoteHoldMaxDays} days; a manager can extend it after`);
  need(!o.quote_expires_on || o.quote_expires_on >= (await bizToday(c, scope)), `quote ${o.number} has expired`);
  let until = addDays((await bizToday(c, scope)), days);
  if (o.quote_expires_on && until > o.quote_expires_on) until = o.quote_expires_on;
  const open = await q<{ id: string }>(c, `select l.id from sales_order_line l join product p on p.id = l.product_id
     where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status = 'open' and p.kind = 'stock' and l.qty > 0 and l.fulfil_from_id is not null`, [scope.entityId, orderId]);
  const held = await reserveLines(c, scope.entityId, orderId, open.map((x) => x.id));
  need(held.length, `nothing on ${o.number} is in stock to hold; made-to-order goods are ordered when the sale is placed`);
  const h = await one<{ id: string }>(c, `insert into pos_quote_hold (entity_id, sales_order_id, held_until, lines_held, requested_by) values ($1,$2,$3,$4,$5) returning id`,
    [scope.entityId, orderId, until, held.length, scope.actor.id]);
  await audit(c, scope, { table: "sales_order", rowId: orderId, action: "transition", after: { hold: until, lines: held.length }, sourceRef: "pos quote hold" });
  return { id: h.id, heldUntil: until, linesHeld: held.length, notHeld: open.length - held.length };
}

/** A manager keeps a hold longer, up to the quote's expiry, and says why. */
export async function extendHold(c: Client, scope: Scope, orderId: string, until: string, reason: string) {
  const o = await orderOf(c, scope.entityId, orderId);
  const h = await activeHold(c, scope.entityId, orderId);
  need(h, `${o.number} is not holding any stock`);
  need(String(reason ?? "").trim(), "say why the hold is kept longer");
  need(/^\d{4}-\d{2}-\d{2}$/.test(String(until)), "pick the day the hold ends");
  need(until > h!.held_until, `the hold already runs to ${h!.held_until}`);
  need(!o.quote_expires_on || until <= o.quote_expires_on, `the quote itself expires on ${o.quote_expires_on}; a hold cannot outlast it`);
  await c.query(`update pos_quote_hold set held_until = $3, extended_by = $4, extend_reason = $5 where id = $1 and entity_id = $2`,
    [h!.id, scope.entityId, until, scope.actor.id, String(reason).trim()]);
  await c.query(`insert into pos_override (entity_id, sales_order_id, kind, detail, requested_by, approved_by, reason) values ($1,$2,'hold_extend',$3,
    (select requested_by from pos_quote_hold where id = $4 and entity_id = $1),$5,$6)`, [scope.entityId, orderId, `stock hold extended from ${h!.held_until} to ${until}`,
    h!.id, scope.actor.id, String(reason).trim()]);
  await audit(c, scope, { table: "sales_order", rowId: orderId, action: "transition", before: { hold: h!.held_until }, after: { hold: until }, reason });
  return { heldUntil: until };
}

/** End a hold: stock goes back to free, the lines back to open. */
async function endHold(c: Client, scope: Scope, orderId: string, status: "released" | "expired" | "converted" | "cancelled", why: string) {
  const h = await activeHold(c, scope.entityId, orderId);
  if (!h) return null;
  const lines = await q<{ id: string }>(c, `select id from sales_order_line where entity_id = $1 and sales_order_id = $2 and line_status = 'reserved'`, [scope.entityId, orderId]);
  const n = await releaseLines(c, scope.entityId, orderId, lines.map((x) => x.id));
  if (lines.length) await c.query(`update sales_order_line set line_status = 'open' where entity_id = $1 and sales_order_id = $2 and id = any($3)`,
    [scope.entityId, orderId, lines.map((x) => x.id)]);
  await c.query(`update pos_quote_hold set status = $3, ended_at = now(), end_reason = $4 where id = $1 and entity_id = $2`, [h.id, scope.entityId, status, why.slice(0, 300)]);
  await audit(c, scope, { table: "sales_order", rowId: orderId, action: "transition", after: { holdEnded: status, released: n }, reason: why, sourceRef: "pos quote hold" });
  return { released: n };
}

export async function releaseHold(c: Client, scope: Scope, orderId: string, reason: string) {
  const o = await orderOf(c, scope.entityId, orderId);
  const r = await endHold(c, scope, orderId, "released", String(reason ?? "").trim() || "released at the register");
  need(r, `${o.number} is not holding any stock`);
  return r;
}

/** Holds past their day give the stock back (the scheduler runs this). */
export async function expireHolds(c: Client, scope: Scope, on?: string) {
  on ??= await bizToday(c, scope);
  const due = await q<{ sales_order_id: string }>(c, `select sales_order_id from pos_quote_hold where entity_id = $1 and status = 'active' and held_until < $2::date`,
    [scope.entityId, on]);
  let released = 0;
  for (const d of due) {
    await adopt(c, scope.entityId, d.sales_order_id);
    released += (await endHold(c, scope, d.sales_order_id, "expired", `the hold ran out before ${on}`))?.released ?? 0;
  }
  return { holds: due.length, released };
}

// ================================================================== tenders

export type Tender = { method: string; amountMinor: bigint; reference?: string | null };

export async function storeCredit(c: Client, entityId: string, customerId: string): Promise<bigint> {
  const r = await q<{ s: string }>(c, `select coalesce(-sum(amount_minor),0)::text s from customer_receipt
    where entity_id = $1 and customer_id = $2 and method = 'store_credit' and voided_at is null`, [entityId, customerId]);
  return BigInt(r[0].s);
}

/**
 * Take tenders against an order's balance. Cash may be more than is owed
 * (the change goes back); nothing else may. Each receipt posts through A/R.
 */
async function takeTenders(c: Client, scope: Scope, o: OrderRow, sessionId: string | null | undefined, tenders: Tender[], refund = false) {
  if (!tenders.length) return { receipts: [] as { id: string; number: string; method: string; amountMinor: bigint }[], changeMinor: 0n };
  const s = await sessionOf(c, scope.entityId, sessionId);
  need(s.status === "open", `session ${s.number} is closed; open a register session`);
  need(s.location_id === o.location_id, "that register is at a different store from this order");
  const fresh = await orderOf(c, scope.entityId, o.id);
  let due = BigInt(fresh.total_minor) - BigInt(fresh.paid_minor);
  if (refund) due = -due;
  const out: { id: string; number: string; method: string; amountMinor: bigint }[] = [];
  let change = 0n;
  const sum = tenders.reduce((a, t) => a + t.amountMinor, 0n);
  need(sum > 0n, "the tender amount must be more than zero");
  if (refund) need(sum === due, `the refund is ${usd(due)}; the tenders add up to ${usd(sum)}`);
  const takes = (await settings(c, scope.entityId)).tenders;
  for (const t of tenders) {
    need((TENDERS as readonly string[]).includes(t.method), `${t.method} is not a tender this register takes`);
    need(refund || takes.includes(t.method), `${t.method.replace(/_/g, " ")} is not taken here; the selling rules list ${takes.map((x) => x.replace(/_/g, " ")).join(", ")}`);
    need(t.amountMinor > 0n, "each tender must be more than zero");
    const ref = String(t.reference ?? "").trim() || null;
    if (t.method === "card") need(!ref || /^\d{4}$/.test(ref), "for a card keep only the last four digits");
    if (["check", "financing", "gift_card"].includes(t.method)) need(ref, `a ${t.method.replace("_", " ")} tender needs its ${t.method === "check" ? "check number" : t.method === "financing" ? "lender approval number" : "card number"}`);
    if (t.method === "gift_card") need(ref && ref.length <= 11, "keep only the gift card's short number, never the full card");
    if (t.method === "store_credit") {
      need(fresh.customer_id, "store credit needs the customer it belongs to");
      if (!refund) {
        const bal = await storeCredit(c, scope.entityId, fresh.customer_id!);
        need(bal >= t.amountMinor, `the customer has ${usd(bal)} of store credit, not ${usd(t.amountMinor)}`);
      }
    }
    let amount = t.amountMinor;
    if (!refund) {
      need(due > 0n, `${fresh.number} has nothing left to pay`);
      if (amount > due) {
        need(t.method === "cash", `${t.method.replace("_", " ")} cannot be more than the ${usd(due)} owed`);
        change += amount - due;
        amount = due;
      }
      due -= amount;
    }
    const number = await nextNo(c, scope.entityId, "receipt", "R-");
    const r = await one<{ id: string }>(c, `insert into customer_receipt (entity_id, number, customer_id, sales_order_id, location_id, channel, method, amount_minor,
        reference, register_session_id, received_by) values ($1,$2,$3,$4,$5,'pos',$6,$7,$8,$9,$10) returning id`,
      [scope.entityId, number, fresh.customer_id, fresh.id, fresh.location_id, t.method, (refund ? -amount : amount).toString(), ref, s.id, scope.actor.id]);
    await postReceipt(c, scope, r.id);
    out.push({ id: r.id, number, method: t.method, amountMinor: refund ? -amount : amount });
  }
  return { receipts: out, changeMinor: change };
}

/** Lines' gross (net + tax), for the take-with and pickup paid-for check. */
async function grossOf(c: Client, entityId: string, orderId: string, where: string, params: unknown[] = []): Promise<bigint> {
  const r = await q<{ g: string }>(c, `select coalesce(sum(round(l.qty * l.unit_price_minor) - l.discount_minor + l.tax_minor),0)::bigint::text g
    from sales_order_line l join pos_line pl on pl.sales_order_line_id = l.id where l.entity_id = $1 and l.sales_order_id = $2 and ${where}`,
    [entityId, orderId, ...params]);
  return BigInt(r[0].g);
}

// What may go on the customer's account at the counter: A/R's house-account room (limit less balance, or an override for this order).
async function creditRoom(c: Client, entityId: string, customerId: string | null, orderId: string | null = null): Promise<bigint> {
  return chargeRoom(c, entityId, customerId, orderId);
}

async function hand(c: Client, scope: Scope, o: OrderRow, lineIds: string[]) {
  if (!lineIds.length) return { lines: 0, costMinor: 0n, journalEntryId: null as string | null };
  const f = await fulfilLines(c, scope.entityId, o.id, lineIds);
  const inv = await invoiceFulfilment(c, scope, o.id, lineIds, f.costMinor);
  await accrueCommissions(c, scope, { orderId: o.id });   // commission is earned on hand-over
  return { lines: f.lines, costMinor: f.costMinor, journalEntryId: inv.journalEntryId };
}

async function settleStatus(c: Client, scope: Scope, orderId: string) {
  await c.query(`update sales_order so set status = case
      when not exists (select 1 from sales_order_line l where l.sales_order_id = so.id and l.entity_id = $2 and l.line_status not in ('fulfilled','cancelled','returned'))
        then 'fulfilled'
      when exists (select 1 from sales_order_line l where l.sales_order_id = so.id and l.entity_id = $2 and l.line_status = 'fulfilled') then 'fulfilling'
      else 'open' end
    where so.id = $1 and so.entity_id = $2 and so.status in ('open','fulfilling')`, [orderId, scope.entityId]);
  const off = await c.query(`update pos_order po set paid_off_at = now() from sales_order so
     where so.id = po.sales_order_id and po.sales_order_id = $1 and po.entity_id = $2 and po.kind = 'layaway' and po.paid_off_at is null
       and so.paid_minor >= so.total_minor`, [orderId, scope.entityId]);
  // a layaway paid off now goes on the truck on the day it asked for, if that day still has room
  if (off.rowCount) {
    const live = await q(c, `select 1 from delivery_stop where entity_id = $1 and sales_order_id = $2 and status = 'scheduled'`, [scope.entityId, orderId]);
    if (!live.length) await bookAtSale(c, scope, orderId, false);
  }
}

/**
 * Place a sale or a layaway: reserve stock (what cannot be covered goes on
 * order for purchasing), take the tenders, and hand over take-with goods.
 */
export async function checkout(c: Client, scope: Scope, orderId: string, e: { sessionId: string | null; tenders: Tender[]; signatureDataUrl?: string; signedName?: string;
  deliveryManager?: boolean; manager?: boolean; depositOverrideReason?: string }) {
  const o = await orderOf(c, scope.entityId, orderId);
  need(o.status === "draft", `${o.number} is already ${o.status}`);
  need(o.kind !== "quote", `${o.number} is a quote; convert it to a sale first`);
  need(o.kind === "sale" || o.kind === "layaway", `${o.number} cannot be checked out`);
  const pending = await q<{ seq: number; sku: string; needs_override: string }>(c, `select l.seq, l.sku, pl.needs_override from pos_line pl
     join sales_order_line l on l.id = pl.sales_order_line_id where pl.entity_id = $1 and pl.sales_order_id = $2 and pl.needs_override is not null
       and l.line_status <> 'cancelled' order by l.seq`, [scope.entityId, orderId]);
  need(!pending.length, `line ${pending[0]?.seq} (${pending[0]?.sku}) needs a manager's override: ${pending[0]?.needs_override}`);
  const live = await q<{ n: string }>(c, `select count(*) n from sales_order_line where entity_id = $1 and sales_order_id = $2 and line_status <> 'cancelled'`, [scope.entityId, orderId]);
  need(Number(live[0].n) > 0, "the order has nothing on it");
  // A certificate that has expired since the order was written no longer exempts it.
  if (o.tax_exempt_ref && o.customer_id) await tax.certificateFor(c, scope.entityId, o.customer_id, o.tax_exempt_ref, (await bizToday(c, scope)));
  await c.query(`update sales_order set status = 'open', ordered_at = now() where id = $1 and entity_id = $2`, [orderId, scope.entityId]);
  await c.query(`update pos_order set register_session_id = coalesce($3, register_session_id) where sales_order_id = $1 and entity_id = $2`, [orderId, scope.entityId, e.sessionId]);
  const res = await reserveOrder(c, scope.entityId, orderId);
  await allocateAsIs(c, scope, orderId);
  const carry = await q<{ id: string; seq: number; sku: string; line_status: string; kind: string | null }>(c, `
    select l.id, l.seq, l.sku, l.line_status, p.kind from sales_order_line l join pos_line pl on pl.sales_order_line_id = l.id
      left join product p on p.id = l.product_id
     where l.entity_id = $1 and l.sales_order_id = $2 and pl.fulfillment = 'carry' and l.line_status not in ('cancelled','fulfilled')`, [scope.entityId, orderId]);
  for (const l of carry) if (STOCKED.includes(l.kind ?? "")) need(l.line_status === "reserved", `${l.sku} is not in stock here to take with; make it pickup or delivery`);
  const delivery = await bookAtSale(c, scope, orderId, e.deliveryManager === true);
  const tendered = await takeTenders(c, scope, o, e.sessionId, e.tenders ?? []);
  const after = await orderOf(c, scope.entityId, orderId);
  const paid = BigInt(after.paid_minor), total = BigInt(after.total_minor);
  let handed = { lines: 0, costMinor: 0n, journalEntryId: null as string | null };
  if (o.kind === "layaway") {
    const set = await settings(c, scope.entityId);
    // A layaway holding goods ordered for the customer needs the higher of its own minimum and the special-order deposit.
    const lay = bps(total, set.layawayMinDepositBps);
    const dep = await depositRequirement(c, scope.entityId, orderId);
    const min = dep.requiredMinor > lay ? dep.requiredMinor : lay;
    need(paid >= min, min === lay ? `a layaway needs a deposit of at least ${usd(min)} (${pct(set.layawayMinDepositBps)})`
      : `this layaway has ${usd(dep.onOrderMinor)} of goods on order, so it needs a deposit of at least ${usd(min)} (the ${pct(dep.specialOrderBps)} special-order deposit, more than the ${pct(set.layawayMinDepositBps)} layaway minimum)`);
    const left = total - paid, n = set.layawayInstallments;
    const step = Math.max(1, Math.floor(set.layawayMaxDays / n));
    const sched = [];
    let rest = left;
    for (let i = 1; i <= n && left > 0n; i++) {
      const amt = i === n ? rest : left / BigInt(n);
      rest -= amt;
      sched.push({ due: addDays((await bizToday(c, scope)), step * i), amount: amt.toString() });
    }
    await c.query(`update pos_order set layaway_schedule = $3 where sales_order_id = $1 and entity_id = $2`, [orderId, scope.entityId, JSON.stringify(sched)]);
  } else {
    // Goods ordered for the customer need the deposit minimum, unless a store manager allows less and says why.
    const dep = await depositRequirement(c, scope.entityId, orderId);
    if (paid < dep.requiredMinor) {
      const why = String(e.depositOverrideReason ?? "").trim();
      need(e.manager && why, `this sale has ${usd(dep.onOrderMinor)} of goods on order and needs a deposit of at least ${usd(dep.requiredMinor)}`
        + ` (${pct(dep.specialOrderBps)} of goods on order${dep.stockedBps ? `, ${pct(dep.stockedBps)} of stocked goods` : ""}); ${usd(paid)} is paid. A store manager can allow less, with a reason.`);
      const detail = `deposit ${usd(paid)} below the ${usd(dep.requiredMinor)} minimum`;
      await c.query(`insert into pos_override (entity_id, sales_order_id, kind, detail, requested_by, approved_by, reason) values ($1,$2,'deposit',$3,
        (select created_by from pos_order where sales_order_id = $2 and entity_id = $1),$4,$5)`, [scope.entityId, orderId, detail, scope.actor.id, why]);
      await audit(c, scope, { table: "sales_order", rowId: orderId, action: "transition", after: { override: detail, requiredMinor: dep.requiredMinor.toString(),
        paidMinor: paid.toString() }, reason: why, sourceRef: "pos deposit override" });
    }
  }
  if (o.kind !== "layaway" && carry.length) {
    const carryGross = await grossOf(c, scope.entityId, orderId, `pl.fulfillment = 'carry' and l.line_status not in ('cancelled','fulfilled')`);
    const room = await creditRoom(c, scope.entityId, o.customer_id, o.id);
    need(paid + room >= carryGross, `take-with goods leave paid for: ${usd(carryGross - paid - room)} more is needed`);
    handed = await hand(c, scope, after, carry.map((l) => l.id));
  }
  if (e.signatureDataUrl) await saveSignature(c, scope, orderId, e.signatureDataUrl, e.signedName ?? "");
  await settleStatus(c, scope, orderId);
  const fin = await orderOf(c, scope.entityId, orderId, false);
  await audit(c, scope, { table: "sales_order", rowId: orderId, action: "transition", after: { status: fin.status, paid: fin.paid_minor, handed: handed.lines,
    onOrder: res.shortLines }, sourceRef: "pos checkout" });
  return { number: o.number, status: fin.status, totalMinor: BigInt(fin.total_minor), paidMinor: BigInt(fin.paid_minor),
    balanceMinor: BigInt(fin.total_minor) - BigInt(fin.paid_minor), changeMinor: tendered.changeMinor, receipts: tendered.receipts,
    reserved: res.reserved, onOrder: res.shortLines, handedOver: handed.lines, delivery };
}

/**
 * The day the salesperson picked becomes a booked stop when the sale is placed, waiting for the
 * delivery manager to confirm. Goods still on order are not booked: the order keeps the requested
 * day, and dispatch books it (or texts the customer the link) once they arrive.
 */
async function bookAtSale(c: Client, scope: Scope, orderId: string, manager: boolean, soft = true) {
  const r = await q<{ day: string | null; window_id: string | null; kind: string; paid_off: boolean }>(c, `select delivery_day::text as day, delivery_window_id as window_id,
    kind, paid_off_at is not null paid_off from pos_order where sales_order_id = $1 and entity_id = $2`, [orderId, scope.entityId]);
  if (!r[0]?.day || !r[0].window_id) return null;
  if (r[0].kind === "layaway" && !r[0].paid_off) return { booked: false, day: r[0].day, waiting: 0, note: "A layaway is delivered once it is paid in full; the day is kept and booked then." };
  const lines = await q<{ id: string; line_status: string }>(c, `
    select l.id, l.line_status from sales_order_line l join pos_line pl on pl.sales_order_line_id = l.id join product p on p.id = l.product_id
     where l.entity_id = $1 and l.sales_order_id = $2 and pl.fulfillment = 'delivery' and p.kind = any($3) and l.line_status not in ('cancelled','fulfilled')`,
    [scope.entityId, orderId, STOCKED]);
  if (!lines.length) return null;
  const ready = lines.filter((l) => l.line_status === "reserved" || l.line_status === "ready").map((l) => l.id);
  const waiting = lines.length - ready.length;
  if (!ready.length) return { booked: false, day: r[0].day, waiting, note: "The goods are on order; the day is kept on the sale and booked when they arrive." };
  // A day that filled up or was locked since it was picked does not stop the sale: it is placed,
  // the delivery waits in dispatch's list, and the salesperson is told to pick another day.
  await c.query("savepoint book_at_sale");
  try {
    const st = await fleet.bookStop(c, scope, { kind: "delivery", orderId, lineIds: ready, day: r[0].day, windowId: r[0].window_id,
      manager, allowToday: manager, from: "sale" });
    await c.query("release savepoint book_at_sale");
    return { booked: true, number: st.number, day: r[0].day, waiting, confirmed: manager, setWarning: st.setWarning, cubeFt: st.cubeFt, weightLb: st.weightLb };
  } catch (err) {
    await c.query("rollback to savepoint book_at_sale");
    const capacity = (err as { code?: string }).code === "P0001" && /window on .* (is full|has room|has .* left)/.test((err as Error).message);
    if (!soft || !(err instanceof fleet.FleetError || capacity)) throw err;   // only a refusal at placing is softened
    return { booked: false, day: r[0].day, waiting, note: `The sale is placed, but the delivery is not booked because ${(err as Error).message}. Open the order to pick another day.` };
  }
}

/** Pick or change the delivery day on a sale. A draft keeps it until it is placed; a placed sale books it now. */
export async function setDeliveryDay(c: Client, scope: Scope, orderId: string, d: { day: string; windowId: string } | null, manager: boolean) {
  const o = await orderOf(c, scope.entityId, orderId);
  need(["draft", "open", "fulfilling"].includes(o.status), `${o.number} is ${o.status}`);
  need(o.kind !== "return", "a return is not delivered");
  if (d) {
    need(/^\d{4}-\d{2}-\d{2}$/.test(d.day) && /^[0-9a-f-]{36}$/i.test(d.windowId), "pick a day and a window");
    const w = await q(c, `select 1 from delivery_window where entity_id = $1 and id = $2 and active`, [scope.entityId, d.windowId]);
    need(w.length, "that delivery window is not offered any more; pick again");
  }
  await c.query(`update pos_order set delivery_day = $3, delivery_window_id = $4 where sales_order_id = $1 and entity_id = $2`,
    [orderId, scope.entityId, d?.day ?? null, d?.windowId ?? null]);
  if (d) {
    await c.query(`update sales_order set promised_on = $3 where id = $1 and entity_id = $2`, [orderId, scope.entityId, d.day]);
    await c.query(`update pos_line set promised_on = $3 where entity_id = $1 and sales_order_id = $2 and fulfillment = 'delivery'`, [scope.entityId, orderId, d.day]);
  }
  if (!d) need(o.status === "draft" || !(await q(c, `select 1 from delivery_stop where entity_id = $1 and sales_order_id = $2 and status = 'scheduled'`, [scope.entityId, orderId])).length,
    "the delivery is booked; move it to another day, or cancel the stop in Delivery");
  if (o.status === "draft" || !d) return { kept: true, booked: false };
  // placed: move the live stop if there is one, else book it
  const live = await q<{ id: string }>(c, `select id from delivery_stop where entity_id = $1 and sales_order_id = $2 and kind = 'delivery' and status = 'scheduled'
    order by created_at desc limit 1`, [scope.entityId, orderId]);
  if (live.length) {
    await fleet.reschedule(c, scope, live[0].id, d.day, d.windowId, manager, "", manager);
    return { kept: true, booked: true, moved: true };
  }
  const res = await bookAtSale(c, scope, orderId, manager, false);
  return { kept: true, ...(res ?? { booked: false, note: "Nothing on this sale goes on a truck." }) };
}

/** A further payment: a deposit, a layaway instalment, the balance at pickup. */
export async function pay(c: Client, scope: Scope, orderId: string, e: { sessionId: string | null; tenders: Tender[] }) {
  const o = await orderOf(c, scope.entityId, orderId);
  need(["open", "fulfilling", "fulfilled"].includes(o.status), `${o.number} is ${o.status}; payments go on a placed order`);
  need(o.kind !== "return", "a return is refunded, not paid");
  const t = await takeTenders(c, scope, o, e.sessionId, e.tenders);
  await settleStatus(c, scope, orderId);
  const fin = await orderOf(c, scope.entityId, orderId, false);
  await audit(c, scope, { table: "sales_order", rowId: orderId, action: "update", after: { paid: fin.paid_minor }, sourceRef: "pos payment" });
  return { number: o.number, paidMinor: BigInt(fin.paid_minor), balanceMinor: BigInt(fin.total_minor) - BigInt(fin.paid_minor),
    changeMinor: t.changeMinor, receipts: t.receipts, paidOff: !!fin.paid_off_at };
}

/** Hand pickup (or late take-with) lines over at the counter. Layaway goods wait until paid in full. */
export async function fulfilAtCounter(c: Client, scope: Scope, orderId: string, lineIds: string[], e: { sessionId?: string | null } = {}) {
  const o = await orderOf(c, scope.entityId, orderId);
  // The counter is the register's store when one is named, else the store the order belongs to.
  const here = e.sessionId ? (await sessionOf(c, scope.entityId, e.sessionId)).location_id : o.location_id;
  const hereName = (await locationOf(c, scope.entityId, here)).name;
  need(["open", "fulfilling"].includes(o.status), `${o.number} is ${o.status}`);
  need(lineIds.length, "pick the lines being handed over");
  // goods whose deluxing, touch-up or assembly is not done do not go out the door either
  const gate = await wms.gateOrQueue(c, scope, lineIds, "handing it over at the counter");
  if (gate.refuse) throw new PosError(gate.message ?? "the goods are not prepped yet");
  if (o.kind === "layaway") need(BigInt(o.paid_minor) >= BigInt(o.total_minor), `layaway ${o.number} is not paid in full; ${usd(BigInt(o.total_minor) - BigInt(o.paid_minor))} is still owed`);
  const ls = await q<{ id: string; sku: string; fulfillment: string; line_status: string; kind: string | null; fulfil_from_id: string | null; at: string | null; moving: boolean }>(c, `
    select l.id, l.sku, pl.fulfillment, l.line_status, p.kind, l.fulfil_from_id, fl.name at,
           exists (select 1 from inv_piece x where x.entity_id = l.entity_id and x.sales_order_line_id = l.id and x.status = 'in_transit') moving
      from sales_order_line l join pos_line pl on pl.sales_order_line_id = l.id
      left join product p on p.id = l.product_id left join location fl on fl.id = l.fulfil_from_id
     where l.entity_id = $1 and l.sales_order_id = $2 and l.id = any($3)`, [scope.entityId, orderId, lineIds]);
  need(ls.length === lineIds.length, "a line named is not on this order");
  for (const l of ls) {
    need(["pickup", "carry"].includes(l.fulfillment), `${l.sku} goes by ${l.fulfillment}; the fleet hands it over`);
    if (STOCKED.includes(l.kind ?? "")) {
      need(!l.moving, `${l.sku} is on a transfer to the store; receive the transfer before handing it over`);
      need(["reserved", "ready"].includes(l.line_status), `${l.sku} is ${l.line_status.replace("_", " ")}, not ready to hand over`);
      need(!l.fulfil_from_id || l.fulfil_from_id === here,
        `${l.sku} is reserved at ${l.at}, not here at ${hereName}; send it over first (Warehouse → Transfers → customer orders to send to their store) and hand it over once the transfer is received`);
    }
    else need(["open", "reserved", "ready"].includes(l.line_status), `${l.sku} is ${l.line_status}`);
  }
  const owedAfter = (await grossOf(c, scope.entityId, orderId, `(l.line_status = 'fulfilled' or l.id = any($3))`, [lineIds])) - BigInt(o.paid_minor);
  const room = await creditRoom(c, scope.entityId, o.customer_id, o.id);
  need(owedAfter <= room, `goods leave paid for: take ${usd(owedAfter - room)} more first`);
  const setWarning = await sectionals.partialSetWarning(c, scope.entityId, lineIds);
  const h = await hand(c, scope, o, lineIds);
  await settleStatus(c, scope, orderId);
  await audit(c, scope, { table: "sales_order", rowId: orderId, action: "transition", after: { handedOver: h.lines, setWarning }, sourceRef: "pos pickup" });
  return { number: o.number, handedOver: h.lines, journalEntryId: h.journalEntryId, setWarning };
}

/** Cancel an order nothing has left on. Reservations are released and any money taken is refunded. */
export async function cancelOrder(c: Client, scope: Scope, orderId: string, e: { reason: string; sessionId?: string | null; refundMethod?: string; reference?: string }) {
  const o = await orderOf(c, scope.entityId, orderId);
  need(["draft", "open"].includes(o.status), `${o.number} is ${o.status}; goods that have left come back as a return`);
  need(String(e.reason ?? "").trim(), "say why the order is cancelled");
  const gone = await q(c, `select id from sales_order_line where entity_id = $1 and sales_order_id = $2 and line_status = 'fulfilled'`, [scope.entityId, orderId]);
  need(!gone.length, "some of this order has been handed over; return it instead");
  const paid = BigInt(o.paid_minor);
  if (paid > 0n) need(e.refundMethod, `${usd(paid)} was paid; say how it is refunded`);
  await endHold(c, scope, orderId, "cancelled", String(e.reason).trim());
  await releaseLines(c, scope.entityId, orderId, "all");
  // a booked delivery goes with the order
  const stops = await q<{ id: string; number: string; route_status: string | null }>(c, `select s.id, s.number, r.status route_status from delivery_stop s
     left join delivery_route r on r.id = s.route_id where s.entity_id = $1 and s.sales_order_id = $2 and s.status = 'scheduled'`, [scope.entityId, orderId]);
  for (const st of stops) await fleet.cancelStop(c, scope, st.id, `order cancelled: ${String(e.reason).trim()}`.slice(0, 300), true);
  await c.query(`update sales_order_line set line_status = 'cancelled' where entity_id = $1 and sales_order_id = $2 and line_status <> 'cancelled'`, [scope.entityId, orderId]);
  if (paid > 0n) {
    // Refund what was paid; the order's total drops to zero first so the refund is what is owed back.
    await c.query(`select sales_order_retotal($1) /* unscoped: order checked above */`, [orderId]);
    await takeTenders(c, scope, await orderOf(c, scope.entityId, orderId), e.sessionId, [{ method: e.refundMethod!, amountMinor: paid, reference: e.reference }], true);
  }
  await c.query(`update sales_order set status = 'cancelled' where id = $1 and entity_id = $2`, [orderId, scope.entityId]);
  await c.query(`update tear_sheet_link set revoked_at = now() where entity_id = $1 and sales_order_id = $2 and revoked_at is null`, [scope.entityId, orderId]);
  await c.query(`select sales_order_retotal($1) /* unscoped: order checked above */`, [orderId]);
  await audit(c, scope, { table: "sales_order", rowId: orderId, action: "transition", after: { status: "cancelled", refunded: paid.toString() }, reason: e.reason });
  return { number: o.number, refundedMinor: paid };
}

export async function saveSignature(c: Client, scope: Scope, orderId: string, dataUrl: string, name: string) {
  need(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl), "the signature must be an image");
  need(dataUrl.length < 200000, "the signature image is too large");
  await orderOf(c, scope.entityId, orderId);
  await c.query(`update pos_order set signature_data_url = $3, signed_name = $4, signed_at = now() where sales_order_id = $1 and entity_id = $2`,
    [orderId, scope.entityId, dataUrl, String(name ?? "").trim().slice(0, 120) || null]);
  await audit(c, scope, { table: "sales_order", rowId: orderId, action: "update", after: { signed: true, name } });
  return { ok: true };
}

// ================================================================== returns

export type ReturnIn = { lines: { lineId: string; qty: number; reason: string; disposition: "restock" | "damage"; note?: string }[];
  tenders: Tender[]; sessionId: string | null; note?: string };

/**
 * Take goods back against the original order: a return order with negative
 * lines (and its tax refunded on a line of its own), stock back to the shelf
 * or to damage, the sale reversed at cost, and the refund as negative
 * receipts. An exchange is a return refunded to store credit, then a new sale
 * that takes the store credit as a tender.
 */
export async function returnGoods(c: Client, scope: Scope, originalId: string, e: ReturnIn) {
  const o = await orderOf(c, scope.entityId, originalId);
  need(o.kind !== "return", "a return cannot itself be returned");
  need(e.lines?.length, "pick what is coming back");
  const s = await sessionOf(c, scope.entityId, e.sessionId);
  need(s.status === "open", `session ${s.number} is closed`);
  const loc = s.location_id;
  const number = await nextNo(c, scope.entityId, "order", "SO-");
  const ro = await one<{ id: string }>(c, `insert into sales_order (entity_id, number, channel, location_id, customer_id, status, notes, created_by, salesperson_id)
    values ($1,$2,'pos',$3,$4,'open',$5,$6,(select salesperson_id from sales_order where id = $7 and entity_id = $1)) returning id`,
    [scope.entityId, number, loc, o.customer_id, `Return against ${o.number}`, scope.actor.id, originalId]);
  await c.query(`insert into pos_order (sales_order_id, entity_id, kind, original_order_id, register_session_id, return_note, created_by)
    values ($1,$2,'return',$3,$4,$5,$6)`, [ro.id, scope.entityId, originalId, s.id, e.note ?? null, scope.actor.id]);
  await c.query(`insert into sales_order_salesperson (entity_id, sales_order_id, app_user_id, split_bps)
    select entity_id, $2, app_user_id, split_bps from sales_order_salesperson where entity_id = $1 and sales_order_id = $3`, [scope.entityId, ro.id, originalId]);
  let seq = 0, net = 0n, taxBack = 0n, cost = 0n;
  const revByCode = new Map<string, bigint>();
  for (const r of e.lines) {
    need(RETURN_REASONS.includes(r.reason), "pick a return reason");
    need(["restock", "damage"].includes(r.disposition), "say whether it goes back on the shelf or to damage");
    if (r.reason === "other") need(String(r.note ?? "").trim(), "say why it came back");
    const l = (await q<{ id: string; product_id: string | null; sku: string; description: string; qty: string; unit_price_minor: string; discount_minor: string;
      tax_minor: string; line_status: string; kind: string | null; cost_minor: string | null; serialized: boolean | null }>(c, `
      select l.id, l.product_id, l.sku, l.description, l.qty, l.unit_price_minor, l.discount_minor, l.tax_minor, l.line_status, p.kind, p.cost_minor, p.serialized
        from sales_order_line l left join product p on p.id = l.product_id where l.id = $1 and l.entity_id = $2 and l.sales_order_id = $3`,
      [r.lineId, scope.entityId, originalId]))[0];
    need(l, "that line is not on the original order");
    need(l.line_status === "fulfilled", `${l.sku} was never handed over, so there is nothing to return; cancel it instead`);
    const back = await q<{ s: string }>(c, `select coalesce(-sum(x.qty),0)::text s from pos_line pl join sales_order_line x on x.id = pl.sales_order_line_id
      where pl.entity_id = $1 and pl.original_line_id = $2 and pl.role = 'item'`, [scope.entityId, l.id]);
    const left = Number(l.qty) - Number(back[0].s);
    const qty = Number(r.qty);
    need(qty > 0 && qty <= left, `${l.sku}: ${left} can still come back, not ${qty}`);
    if (l.serialized) need(Number.isInteger(qty), `${l.sku} comes back in whole units`);
    const origNet = BigInt(Math.round(Number(l.qty) * Number(l.unit_price_minor))) - BigInt(l.discount_minor);
    const unitNet = BigInt(Math.round(Number(origNet) / Number(l.qty)));
    const lineNet = BigInt(Math.round(qty * Number(unitNet)));
    seq++;
    const nl = await one<{ id: string }>(c, `insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, fulfil_from_id, line_status)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'returned') returning id`, [scope.entityId, ro.id, seq, l.product_id, l.sku, `Return: ${l.description}`.slice(0, 300), -qty,
      unitNet.toString(), STOCKED.includes(l.kind ?? "") ? loc : null]);
    await c.query(`insert into pos_line (sales_order_line_id, entity_id, sales_order_id, fulfillment, original_line_id, return_reason, return_disposition)
      values ($1,$2,$3,'carry',$4,$5,$6)`, [nl.id, scope.entityId, ro.id, l.id, r.reason, STOCKED.includes(l.kind ?? "") ? r.disposition : "none"]);
    // The tax comes back from the same jurisdictions that collected it, in proportion to what comes back.
    const lineTax = await tax.reverseLine(c, scope.entityId, { originalLineId: l.id, returnOrderId: ro.id, returnLineId: nl.id, qty, originalQty: Number(l.qty), netMinor: lineNet, qtyLeft: left });
    net += lineNet; taxBack += lineTax;
    const code = l.kind === "fee" || l.kind === "service" ? "4030" : l.kind === "warranty" ? "4040" : "4900";
    revByCode.set(code, (revByCode.get(code) ?? 0n) + lineNet);
    if (STOCKED.includes(l.kind ?? "") && l.product_id) {
      // Back at today's average cost: what 1300 gets is exactly what the stock's cost pool gets.
      const unit = await unitCost(c, scope.entityId, l.product_id);
      cost += BigInt(Math.round(qty * Number(unit)));
      if (r.disposition === "restock") await restock(c, scope.entityId, l.product_id, loc, qty, { lineIds: [l.id], by: scope.actor.id, unitCostMinor: unit });
      else await returnToDamage(c, scope, { productId: l.product_id, locationId: loc, qty, lineIds: [l.id], unitCostMinor: unit,
        description: `Customer return on ${o.number}: ${r.reason.replace(/_/g, " ")}${r.note ? ` — ${r.note}` : ""}` });
    }
  }
  if (taxBack > 0n) {
    seq++;
    const tl = await one<{ id: string }>(c, `insert into sales_order_line (entity_id, sales_order_id, seq, sku, description, qty, unit_price_minor, line_status)
      values ($1,$2,$3,'TAX-REFUND','Sales tax refunded',-1,$4,'returned') returning id`, [scope.entityId, ro.id, seq, taxBack.toString()]);
    await c.query(`insert into pos_line (sales_order_line_id, entity_id, sales_order_id, role, fulfillment, original_line_id, return_reason, return_disposition)
      values ($1,$2,$3,'tax_refund','carry',$4,$5,'none')`, [tl.id, scope.entityId, ro.id, e.lines[0].lineId, e.lines[0].reason]);
  }
  await c.query(`select sales_order_retotal($1) /* unscoped: order just written for this entity */`, [ro.id]);
  // The sale comes off the books: returns and tax against the deposit the refund will clear; the goods back at cost.
  const po = await profitObjectFor(c, scope.entityId, loc);
  const refund = net + taxBack;
  const retDay = await bizToday(c, scope, loc);
  const je = await post(c, scope, { date: retDay, sourceType: "refund", sourceId: ro.id, description: `Return ${number} against ${o.number}`, lines: [
    ...[...revByCode.entries()].map(([code, v]) => ({ code, debit: v, profitObjectId: po })),
    { code: "2100", debit: taxBack, profitObjectId: po },
    { code: "2300", credit: refund, profitObjectId: po },
    { code: "1300", debit: cost, profitObjectId: po },
    { code: "5000", credit: cost, profitObjectId: po },
  ] });
  await tax.postReturn(c, scope.entityId, ro.id, je, retDay);
  const ret = await orderOf(c, scope.entityId, ro.id);
  // No tenders named: refund the way the customer paid (the web order's card, most recent first).
  const tenders = e.tenders?.length ? e.tenders : await refundToOriginal(c, scope.entityId, originalId, refund);
  // Card money a web order took goes back through the web's card processor, off the register's batch.
  const { web, rest } = await splitWebCard(c, scope.entityId, originalId, tenders);
  const webDone: { receiptId: string; refundId: string; paymentId: string; amount: bigint }[] = [];
  for (const w of web) webDone.push(await recordWebRefund(c, scope, ret, w.payment, w.amount));
  const fresh = await orderOf(c, scope.entityId, ro.id);
  const t = rest.length ? await takeTenders(c, scope, fresh, s.id, rest, true) : { receipts: [], changeMinor: 0n };
  const still = BigInt(fresh.paid_minor) - BigInt(fresh.total_minor) - t.receipts.reduce((a, r) => a - r.amountMinor, 0n);
  need(still === 0n, `the refund is ${usd(refund)}; the tenders add up to ${usd(refund - still)}`);
  // Only now, with everything else written, ask the processor; a refusal rolls the whole return back.
  for (const w of webDone) await callProcessorRefund(c, scope.entityId, w);
  await c.query(`update sales_order set status = 'closed' where id = $1 and entity_id = $2`, [ro.id, scope.entityId]);
  await accrueCommissions(c, scope, { orderId: ro.id });  // the return charges back its commission
  await audit(c, scope, { table: "sales_order", rowId: originalId, action: "transition", after: { returnedOn: number, refund: refund.toString() }, sourceRef: "pos return" });
  await audit(c, scope, { table: "sales_order", rowId: ro.id, action: "insert", after: { kind: "return", against: o.number, refund: refund.toString() }, sourceRef: "pos return" });
  return { id: ro.id, number, refundMinor: refund, taxMinor: taxBack, costMinor: cost, journalEntryId: je, receipts: t.receipts,
    webRefunds: webDone.map((w) => ({ receiptId: w.receiptId, amountMinor: w.amount })) };
}

type WebPayment = { id: string; provider: string; auth_ref: string; brand: string | null; last4: string | null; amount_minor: string; left: string };

/** Card tenders that match a web payment on the original order (by last four, or any card when none is given) are refunded through the web processor. */
async function splitWebCard(c: Client, entityId: string, originalId: string, tenders: Tender[]) {
  const web: { payment: WebPayment; amount: bigint }[] = [];
  if (!(await hasRelation(c, "shop_payment")) || !tenders.some((x) => x.method === "card")) return { web, rest: tenders };
  const pays = await q<WebPayment>(c, `
    select sp.id, sp.provider, sp.auth_ref, sp.brand, sp.last4, sp.amount_minor::text,
           (sp.amount_minor - coalesce((select sum(r.amount_minor) from pos_card_refund r where r.entity_id = sp.entity_id and r.shop_payment_id = sp.id), 0))::text "left"
      from shop_payment sp where sp.entity_id = $1 and sp.sales_order_id = $2 and sp.status in ('captured','refunded') order by sp.created_at for update`, [entityId, originalId]);
  if (!pays.length) return { web, rest: tenders };
  const left = new Map(pays.map((p) => [p.id, BigInt(p.left)]));
  const rest: Tender[] = [];
  for (const t of tenders) {
    if (t.method !== "card") { rest.push(t); continue; }
    let amt = t.amountMinor;
    for (const p of pays) {
      if (amt <= 0n) break;
      if (t.reference && p.last4 && String(t.reference).trim() !== p.last4) continue;
      const room = left.get(p.id) ?? 0n;
      if (room <= 0n) continue;
      const take = room < amt ? room : amt;
      web.push({ payment: p, amount: take });
      left.set(p.id, room - take);
      amt -= take;
    }
    if (amt > 0n) rest.push({ ...t, amountMinor: amt });
  }
  return { web, rest };
}

/** The negative receipt (channel 'web', no register session) and the refund row; the processor is called last. */
async function recordWebRefund(c: Client, scope: Scope, ret: OrderRow, p: WebPayment, amount: bigint) {
  const number = await nextNo(c, scope.entityId, "receipt", "R-");
  const r = await one<{ id: string }>(c, `insert into customer_receipt (entity_id, number, customer_id, sales_order_id, location_id, channel, method, amount_minor, reference, received_by)
    values ($1,$2,$3,$4,$5,'web','card',$6,$7,$8) returning id`, [scope.entityId, number, ret.customer_id, ret.id, ret.location_id, (-amount).toString(),
    `${p.brand ?? "Card"} ending ${p.last4 ?? "----"}, ${p.provider} refund`, scope.actor.id]);
  await postReceipt(c, scope, r.id);
  const f = await one<{ id: string }>(c, `insert into pos_card_refund (entity_id, shop_payment_id, return_order_id, receipt_id, provider, refund_ref, amount_minor, refunded_by)
    values ($1,$2,$3,$4,$5,'pending',$6,$7) returning id`, [scope.entityId, p.id, ret.id, r.id, p.provider, amount.toString(), scope.actor.id]);
  return { receiptId: r.id, refundId: f.id, paymentId: p.id, amount };
}

async function callProcessorRefund(c: Client, entityId: string, w: { receiptId: string; refundId: string; paymentId: string; amount: bigint }) {
  const p = (await q<{ provider: string; auth_ref: string; amount_minor: string }>(c, `select provider, auth_ref, amount_minor::text from shop_payment where id = $1 and entity_id = $2`,
    [w.paymentId, entityId]))[0];
  const { refundRef } = await providerNamed(p.provider).refund(p.auth_ref, w.amount);
  await c.query(`update pos_card_refund set refund_ref = $3 where id = $1 and entity_id = $2`, [w.refundId, entityId, refundRef]);
  await c.query(`update shop_payment sp set status = 'refunded' where sp.id = $1 and sp.entity_id = $2
      and (select coalesce(sum(r.amount_minor),0) from pos_card_refund r where r.entity_id = sp.entity_id and r.shop_payment_id = sp.id) >= sp.amount_minor`, [w.paymentId, entityId]);
}

/** Split a refund back over the original order's receipts, newest first, net of what earlier returns already refunded to each. */
async function refundToOriginal(c: Client, entityId: string, originalId: string, refund: bigint): Promise<Tender[]> {
  const paid = await q<{ method: string; reference: string | null; amount_minor: string }>(c, `
    select method, reference, amount_minor::text from customer_receipt where entity_id = $1 and sales_order_id = $2 and voided_at is null and amount_minor > 0
     order by received_at desc`, [entityId, originalId]);
  need(paid.length, "nothing was paid on the original order; name how the refund goes");
  const back = await q<{ method: string; reference: string | null; s: string }>(c, `
    select r.method, r.reference, (-sum(r.amount_minor))::text s from customer_receipt r join pos_order po on po.sales_order_id = r.sales_order_id
     where r.entity_id = $1 and po.original_order_id = $2 and r.voided_at is null and r.amount_minor < 0 group by r.method, r.reference`, [entityId, originalId]);
  // A card is known by its last four, however the receipt wrote it ("Visa ending 4242, test …" on the web, "4242" at the counter).
  const norm = (method: string, ref: string | null) => method !== "card" || !ref ? ref : (/ending (\d{4})/.exec(ref)?.[1] ?? (ref.replace(/\D/g, "").slice(-4) || null));
  const used = new Map<string, bigint>();
  for (const b of back) { const k = `${b.method}|${norm(b.method, b.reference) ?? ""}`; used.set(k, (used.get(k) ?? 0n) + BigInt(b.s)); }
  let left = refund;
  const out: Tender[] = [];
  for (const p of paid) {
    if (left <= 0n) break;
    const key = `${p.method}|${norm(p.method, p.reference) ?? ""}`;
    let room = BigInt(p.amount_minor);
    const u = used.get(key) ?? 0n;
    const take0 = u >= room ? room : u;
    used.set(key, u - take0);
    room -= take0;
    if (room <= 0n) continue;
    const take = room < left ? room : left;
    need((TENDERS as readonly string[]).includes(p.method), `the original was paid by ${p.method}; name how the refund goes`);
    out.push({ method: p.method, amountMinor: take, reference: norm(p.method, p.reference) });
    left -= take;
  }
  need(left <= 0n, `only ${usd(refund - left)} of the ${usd(refund)} refund can go back the way it was paid; name the rest`);
  return out;
}

// ==================================================================== views

export async function orderView(c: Client, entityId: string, id: string) {
  const h = await q<Record<string, unknown>>(c, `
    select so.id, so.number, so.status, so.channel, so.fulfillment, so.promised_on::text, so.subtotal_minor::text, so.discount_minor::text, so.tax_minor::text,
           so.total_minor::text, so.paid_minor::text, (so.total_minor - so.paid_minor)::text balance_minor, so.ordered_at, so.notes,
           coalesce(po.kind, 'sale') kind, po.quote_expires_on::text, coalesce(po.layaway_schedule, '[]'::jsonb) layaway_schedule, po.paid_off_at, po.tax_exempt_ref, po.signature_data_url, po.signed_name, po.signed_at,
           po.original_order_id, oo.number original_number, po.register_session_id, po.return_note,
           so.customer_id, cu.name customer, cu.phone customer_phone, cu.email customer_email, cu.number customer_number,
           so.location_id, l.name location, l.address location_address, l.tax_rate_bps,
           a.line1 ship_line1, a.city ship_city, a.state ship_state, a.postal ship_postal, so.ship_address_id,
           po.delivery_day::text delivery_day, dw.label delivery_window,
           (select json_build_object('number', ds.number, 'day', ds.scheduled_on::text, 'window', sw.label, 'confirmed', ds.confirmed_at is not null)
              from delivery_stop ds left join delivery_window sw on sw.id = ds.window_id
             where ds.entity_id = so.entity_id and ds.sales_order_id = so.id and ds.kind = 'delivery' and ds.status = 'scheduled'
             order by ds.created_at desc limit 1) delivery_stop,
           e.name company, mk.name created_by
      from sales_order so left join pos_order po on po.sales_order_id = so.id
      join location l on l.id = so.location_id join entity e on e.id = so.entity_id
      left join customer cu on cu.id = so.customer_id left join customer_address a on a.id = so.ship_address_id
      left join sales_order oo on oo.id = po.original_order_id left join app_user mk on mk.id = po.created_by
      left join delivery_window dw on dw.id = po.delivery_window_id
     where so.id = $1 and so.entity_id = $2`, [id, entityId]);
  if (!h.length) return null;
  const lines = await q(c, `
    select l.id, l.seq, l.sku, l.description, l.qty::text, l.unit_price_minor::text, l.discount_minor::text, l.tax_minor::text,
           (round(l.qty * l.unit_price_minor) - l.discount_minor)::bigint::text net_minor, l.line_status, l.config, fl.name fulfil_from,
           coalesce(pl.fulfillment, so.fulfillment) fulfillment, coalesce(pl.promised_on, so.promised_on)::text promised_on, pl.needs_override, pl.package_sku,
           pl.return_reason, pl.return_disposition, coalesce(pl.role, 'item') role, p.kind, l.product_id,
           ov.reason override_reason, ou.name override_by,
           (select coalesce(-sum(x.qty),0) from pos_line rp join sales_order_line x on x.id = rp.sales_order_line_id
             where rp.entity_id = l.entity_id and rp.original_line_id = l.id and rp.role = 'item')::text returned_qty
      from sales_order_line l join sales_order so on so.id = l.sales_order_id left join pos_line pl on pl.sales_order_line_id = l.id
      left join product p on p.id = l.product_id left join location fl on fl.id = l.fulfil_from_id left join pos_override ov on ov.id = pl.override_id left join app_user ou on ou.id = ov.approved_by
     where l.entity_id = $1 and l.sales_order_id = $2 order by l.seq`, [entityId, id]);
  const receipts = await q(c, `select r.id, r.number, r.method, r.amount_minor::text, r.reference, r.received_at, u.name received_by, r.voided_at
      from customer_receipt r left join app_user u on u.id = r.received_by where r.entity_id = $1 and r.sales_order_id = $2 order by r.received_at`, [entityId, id]);
  const people = await q(c, `select sp.app_user_id id, u.name, sp.split_bps from sales_order_salesperson sp join app_user u on u.id = sp.app_user_id
      where sp.entity_id = $1 and sp.sales_order_id = $2 order by sp.split_bps desc`, [entityId, id]);
  const overrides = await q(c, `select o.kind, o.detail, o.reason, o.at, a.name approved_by, r.name requested_by from pos_override o
      join app_user a on a.id = o.approved_by left join app_user r on r.id = o.requested_by where o.entity_id = $1 and o.sales_order_id = $2 order by o.at`, [entityId, id]);
  const returns = await q(c, `select so.id, so.number, so.total_minor::text, so.ordered_at from pos_order po join sales_order so on so.id = po.sales_order_id
      where po.entity_id = $1 and po.original_order_id = $2 order by so.ordered_at`, [entityId, id]);
  const history = await q(c, `select at, actor_label, action, after, reason from audit_event where entity_id = $1 and table_name = 'sales_order' and row_id = $2
      order by at, id`, [entityId, id]);
  const head = h[0];
  const credit = head.customer_id ? await storeCredit(c, entityId, String(head.customer_id)) : 0n;
  const taxes = await tax.orderTax(c, entityId, id);
  const hold = (await q(c, `select h.held_until::text, h.status, h.lines_held, h.extend_reason, u.name requested_by, x.name extended_by, h.end_reason, h.ended_at
      from pos_quote_hold h left join app_user u on u.id = h.requested_by left join app_user x on x.id = h.extended_by
     where h.entity_id = $1 and h.sales_order_id = $2 order by h.created_at desc limit 1`, [entityId, id]))[0] ?? null;
  const deposit = head.kind === "sale" || head.kind === "quote" ? await depositRequirement(c, entityId, id) : null;
  const sheetLinks = await q(c, `select k.id, k.expires_at, k.opened_count, k.created_at from tear_sheet_link k
     where k.entity_id = $1 and k.sales_order_id = $2 and k.revoked_at is null and k.expires_at > now() order by k.created_at desc`, [entityId, id]);
  const sectionalSets = await sectionals.setsForOrder(c, entityId, id);
  return { ...head, lines, receipts, salespeople: people, overrides, returns, history, storeCreditMinor: credit, taxes, hold, deposit, sheetLinks, sectionals: sectionalSets };
}

export async function listOrders(c: Client, entityId: string, f: { kind?: string; status?: string; q?: string; locationId?: string | null }) {
  return q(c, `
    select so.id, so.number, so.status, coalesce(po.kind, 'sale') kind, so.channel, so.total_minor::text, so.paid_minor::text, (so.total_minor - so.paid_minor)::text balance_minor,
           so.ordered_at, so.promised_on::text, so.fulfillment, cu.name customer, l.name location, po.quote_expires_on::text,
           (select count(*) from pos_line pl where pl.sales_order_id = so.id and pl.entity_id = so.entity_id and pl.needs_override is not null)::int overrides_waiting
      from sales_order so left join pos_order po on po.sales_order_id = so.id join location l on l.id = so.location_id
      left join customer cu on cu.id = so.customer_id
     where so.entity_id = $1 and ($2 = '' or coalesce(po.kind, 'sale') = $2)
       and ($3 = '' or ($3 = 'active' and so.status in ('draft','open','fulfilling')) or so.status = $3)
       and ($4 = '' or so.number ilike '%' || $4 || '%' or cu.name ilike '%' || $4 || '%' or cu.phone ilike '%' || $4 || '%')
       and ($5::uuid is null or so.location_id = $5)
     order by so.ordered_at desc limit 100`, [entityId, f.kind ?? "", f.status ?? "", f.q ?? "", f.locationId ?? null]);
}
