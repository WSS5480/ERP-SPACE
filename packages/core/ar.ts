// Receivables: the money side of every sale. Owned by the A/R module.
// postReceipt and invoiceFulfilment are the contract POS, the web store and
// delivery call; their signatures and their accounting are kept.
//
// Accounting (accounts by code; Setup can map them per tenant):
//   money in before delivery   Dr 1050 undeposited funds (1110 for a finance company)   Cr 2300 customer deposits
//   goods handed over          Dr 2300 deposits applied, Dr 1100 A/R for the rest       Cr 4000 / 4030 / 4040, Cr 2100 tax
//                              Dr 5000 cost of goods                                     Cr 1300 inventory
//   payment on account         Dr 1050 (by method)                                       Cr 1100, Cr 2320 for an overpayment kept as store credit
//   contract payment           Dr 1050                                                   Cr 1100 principal, Cr 4020 interest
//   late fee                   Dr 1100                                                   Cr 4020
//   write-off                  Dr 1190 allowance (or 6900 direct)                        Cr 1100
//   recovery                   Dr 1100 / Cr 1190 (or 6900), then Dr 1050 / Cr 1100
//   finance company funds      Dr 1050 funded, Dr 6910 the lender's fee                  Cr 1110 the sales
// Revenue is recognised when the customer has the goods, not when they pay.
// Contract interest is recognised when it is paid (cash basis).
//
// Every movement in 1100 is also one ar_ledger row, in the same transaction
// and on the same date, so balances, statements and the aging are sums of
// that table and tie to the general ledger by construction.

import { q, one, audit, type Client, type Scope } from "./db.ts";
import { post, profitObjectFor, type PostLine } from "./posting.ts";
import { format, mulBps } from "./money.ts";

export class ArError extends Error {}

const today = () => new Date().toISOString().slice(0, 10);
const need = (cond: unknown, msg: string): asserts cond => { if (!cond) throw new ArError(msg); };
const B = (v: string | number | bigint | null | undefined) => BigInt(v ?? 0);
const $ = (m: bigint) => format(m);

const DAY = 86_400_000;
const toUtc = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
export const addDays = (s: string, n: number) => new Date(toUtc(s) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / DAY);
/** Same day of the month, n months on; the 31st becomes the month's last day. */
export function addMonths(s: string, n: number): string {
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)) - 1 + n, d = Number(s.slice(8, 10));
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
}
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Where money taken by a method lands. The same map postReceipt uses. */
export function cashCodeFor(method: string): string {
  return method === "financing" ? "1110" : method === "store_credit" ? "2320" : method === "gift_card" ? "2310" : "1050";
}

// ============================================================ the contract

/** Post a customer receipt (or refund, if negative) to the ledger. */
export async function postReceipt(c: Client, scope: Scope, receiptId: string): Promise<string> {
  const r = await one<{ amount_minor: string; method: string; number: string; location_id: string; received_at: string; voided_at: string | null }>(c,
    `select amount_minor, method, number, location_id, received_at::date::text received_at, voided_at
       from customer_receipt where id = $1 and entity_id = $2`, [receiptId, scope.entityId]);
  if (r.voided_at) throw new ArError("a voided receipt does not post");
  const amt = BigInt(r.amount_minor);
  const cashSide = cashCodeFor(r.method);
  const po = await profitObjectFor(c, scope.entityId, r.location_id);
  const abs = amt < 0n ? -amt : amt;
  const lines = amt > 0n
    ? [{ code: cashSide, debit: abs, profitObjectId: po }, { code: "2300", credit: abs, profitObjectId: po }]
    : [{ code: "2300", debit: abs, profitObjectId: po }, { code: cashSide, credit: abs, profitObjectId: po }];
  return post(c, scope, { date: r.received_at, sourceType: amt > 0n ? "receipt" : "refund", sourceId: receiptId,
    description: `${amt > 0n ? "Receipt" : "Refund"} ${r.number}`, lines });
}

/**
 * Recognise the sale for lines just handed over. Revenue by line kind, tax,
 * deposits applied up to what has been paid, the rest to A/R; and cost of
 * goods against inventory (costMinor comes from inventory.fulfilLines).
 *
 * A/R additions (same accounting): a customer invoice is written for the
 * lines, a line already invoiced is never invoiced twice, and a charge to a
 * house account past its credit limit (or on an account on hold) is refused
 * unless an owner or controller approved an override for it.
 */
export async function invoiceFulfilment(c: Client, scope: Scope, orderId: string, lineIds: string[] | "all", costMinor: bigint):
  Promise<{ journalEntryId: string; revenueMinor: bigint; taxMinor: bigint; toArMinor: bigint; invoiceId: string; invoiceNumber: string }> {
  const so = await one<{ number: string; location_id: string; paid_minor: string; fees_minor: string; customer_id: string | null }>(c,
    `select number, location_id, paid_minor, fees_minor, customer_id from sales_order where id = $1 and entity_id = $2 for update`,
    [orderId, scope.entityId]);
  const lines = await q<{ id: string; kind: string | null; qty: string; unit_price_minor: string; discount_minor: string; tax_minor: string;
                          sku: string; description: string; seq: number }>(c, `
    select l.id, p.kind, l.qty, l.unit_price_minor, l.discount_minor, l.tax_minor, l.sku, l.description, l.seq
      from sales_order_line l left join product p on p.id = l.product_id
     where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status = 'fulfilled'
       and ($3::uuid[] is null or l.id = any($3))
       and not exists (select 1 from customer_invoice_line il where il.sales_order_line_id = l.id)
     order by l.seq`, [scope.entityId, orderId, lineIds === "all" ? null : lineIds]);
  need(lines.length, `nothing to invoice on order ${so.number}: those lines are not handed over yet, or are already invoiced`);
  const rev = new Map<string, bigint>();
  let tax = 0n;
  const netOf = (l: typeof lines[number]) => BigInt(Math.round(Number(l.qty) * Number(l.unit_price_minor))) - BigInt(l.discount_minor);
  const codeOf = (l: typeof lines[number]) => l.kind === "fee" || l.kind === "service" ? "4030" : l.kind === "warranty" ? "4040" : "4000";
  for (const l of lines) {
    const code = codeOf(l);
    rev.set(code, (rev.get(code) ?? 0n) + netOf(l));
    tax += BigInt(l.tax_minor);
  }
  const revenue = [...rev.values()].reduce((a, b) => a + b, 0n);
  const gross = revenue + tax;
  // Deposits already recognised against this order.
  const applied = await one<{ s: string }>(c, `
    select coalesce(sum(jl.debit_minor),0)::text s from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id and je.entity_id = $1
      join gl_account g on g.id = jl.gl_account_id and g.code = '2300'
     where je.source_type = 'sale' and je.source_id = $2`, [scope.entityId, orderId]);
  const depositsLeft = BigInt(so.paid_minor) - BigInt(applied.s);
  const fromDeposits = depositsLeft > 0n ? (depositsLeft < gross ? depositsLeft : gross) : 0n;
  const toAr = gross - fromDeposits;

  // Charging to a house account: the limit holds unless someone with the authority said otherwise.
  let overrideId: string | null = null;
  let terms = 0;
  if (so.customer_id) {
    const cu = await one<{ name: string; status: string; credit_limit_minor: string; terms_days: number; house: boolean | null }>(c, `
      select cu.name, cu.status, cu.credit_limit_minor, cu.terms_days, a.house_account house
        from customer cu left join ar_account a on a.customer_id = cu.id and a.entity_id = $1
       where cu.id = $2 and cu.entity_id = $1 for update of cu`, [scope.entityId, so.customer_id]);
    if (cu.house) terms = cu.terms_days;
    if (toAr > 0n && (cu.house || cu.status === "hold")) {
      const check = await creditCheck(c, scope.entityId, so.customer_id, toAr, orderId);
      if (!check.ok) {
        need(check.overrideId, check.reason);
        overrideId = check.overrideId;
      }
    }
  }

  const po = await profitObjectFor(c, scope.entityId, so.location_id);
  const out = [
    { code: "2300", debit: fromDeposits, profitObjectId: po },
    { code: "1100", debit: toAr > 0n ? toAr : 0n, profitObjectId: po },
    { code: "1100", credit: toAr < 0n ? -toAr : 0n, profitObjectId: po },
    ...[...rev.entries()].map(([code, v]) => v >= 0n ? { code, credit: v, profitObjectId: po } : { code, debit: -v, profitObjectId: po }),
    { code: "2100", credit: tax, profitObjectId: po },
    { code: "5000", debit: costMinor, profitObjectId: po },
    { code: "1300", credit: costMinor, profitObjectId: po },
  ];
  const date = today();
  const je = await post(c, scope, { date, sourceType: "sale", sourceId: orderId,
    description: `Sale ${so.number}, ${lines.length} line${lines.length === 1 ? "" : "s"} handed over`, lines: out });

  // The customer-facing invoice.
  const kind = gross < 0n ? "credit_memo" : "sale";
  const number = await nextNo(c, scope.entityId, kind === "credit_memo" ? "credit_memo" : "invoice", kind === "credit_memo" ? "CM-" : "INV-");
  const inv = await one<{ id: string }>(c, `
    insert into customer_invoice (entity_id, number, kind, customer_id, sales_order_id, location_id, journal_entry_id,
                                  invoice_date, due_date, subtotal_minor, tax_minor, total_minor, deposit_applied_minor,
                                  charged_minor, cost_minor, status, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
    [scope.entityId, number, kind, so.customer_id, orderId, so.location_id, je, date, addDays(date, terms),
     revenue.toString(), tax.toString(), gross.toString(), fromDeposits.toString(), toAr.toString(), costMinor.toString(),
     toAr === 0n ? "paid" : "open", scope.actor.id || null]);
  let seq = 1;
  for (const l of lines) {
    await c.query(`insert into customer_invoice_line (entity_id, invoice_id, sales_order_line_id, seq, sku, description, qty,
                     unit_price_minor, discount_minor, net_minor, tax_minor, revenue_code)
                   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [scope.entityId, inv.id, l.id, seq++, l.sku, l.description, l.qty, l.unit_price_minor, l.discount_minor,
       netOf(l).toString(), l.tax_minor, codeOf(l)]);
  }
  if (toAr !== 0n) {
    await ledger(c, scope, { customerId: so.customer_id, invoiceId: inv.id, locationId: so.location_id, date,
      kind: toAr > 0n ? "invoice" : "credit_memo", amount: toAr, memo: `${number} for order ${so.number}`, journalEntryId: je });
  }
  if (overrideId) {
    await c.query(`update ar_credit_override set used_at = now(), used_on_invoice_id = $2 where id = $1 and entity_id = $3`,
      [overrideId, inv.id, scope.entityId]);
  }
  return { journalEntryId: je, revenueMinor: revenue, taxMinor: tax, toArMinor: toAr, invoiceId: inv.id, invoiceNumber: number };
}

// ================================================================ helpers

async function nextNo(c: Client, entityId: string, kind: string, prefix: string): Promise<string> {
  const r = await one<{ n: string }>(c, `select next_doc_no($1, $2, $3) n /* unscoped: the function takes the entity */`, [entityId, kind, prefix]);
  return r.n;
}

type LedgerKind = "invoice" | "late_fee" | "credit_memo" | "payment" | "unapplied" | "apply" | "to_store_credit" | "writeoff" | "recovery" | "contract";

async function ledger(c: Client, scope: Scope, e: {
  customerId: string | null; invoiceId?: string | null; contractId?: string | null; receiptId?: string | null;
  locationId?: string | null; date: string; kind: LedgerKind; amount: bigint; memo?: string; journalEntryId?: string | null;
}) {
  if (e.amount === 0n) return;
  await c.query(`insert into ar_ledger (entity_id, customer_id, invoice_id, contract_id, receipt_id, location_id, occurred_on,
                   kind, amount_minor, memo, journal_entry_id, created_by)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [scope.entityId, e.customerId, e.invoiceId ?? null, e.contractId ?? null, e.receiptId ?? null, e.locationId ?? null,
     e.date, e.kind, e.amount.toString(), e.memo ?? null, e.journalEntryId ?? null, scope.actor.id || null]);
  if (e.invoiceId) await refreshInvoice(c, scope.entityId, e.invoiceId);
}

async function refreshInvoice(c: Client, entityId: string, invoiceId: string) {
  const r = await one<{ open: string; wo: string; status: string }>(c, `
    select coalesce((select sum(amount_minor) from ar_ledger l where l.invoice_id = i.id and l.entity_id = $1), 0) open,
           coalesce((select sum(amount_minor) from ar_writeoff w where w.invoice_id = i.id and w.entity_id = $1 and w.status = 'posted'), 0) wo,
           i.status
      from customer_invoice i where i.id = $2 and i.entity_id = $1`, [entityId, invoiceId]);
  const open = B(r.open);
  const status = open !== 0n ? "open" : B(r.wo) > 0n ? "written_off" : "paid";
  if (status !== r.status && r.status !== "void") {
    await c.query(`update customer_invoice set status = $3 where id = $2 and entity_id = $1`, [entityId, invoiceId, status]);
  }
}

async function takeReceipt(c: Client, scope: Scope, r: {
  customerId: string | null; locationId: string; method: string; amountMinor: bigint; reference?: string | null;
  channel?: string; receivedBy?: string | null; salesOrderId?: string | null;
}): Promise<{ id: string; number: string }> {
  need(r.amountMinor > 0n, "the amount has to be more than zero");
  const number = await nextNo(c, scope.entityId, "receipt", "RC-");
  const x = await one<{ id: string }>(c, `
    insert into customer_receipt (entity_id, number, customer_id, sales_order_id, location_id, channel, method, amount_minor, reference, received_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [scope.entityId, number, r.customerId, r.salesOrderId ?? null, r.locationId, r.channel ?? "pos", r.method,
     r.amountMinor.toString(), r.reference || null, r.receivedBy ?? scope.actor.id ?? null]);
  return { id: x.id, number };
}

export async function glBalance(c: Client, entityId: string, code: string, asOf = today()): Promise<bigint> {
  const r = await one<{ b: string }>(c, `
    select coalesce(sum(jl.debit_minor - jl.credit_minor), 0) b
      from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id
      join gl_account g on g.id = jl.gl_account_id
     where je.entity_id = $1 and g.code = $2 and je.posting_date <= $3::date`, [entityId, code, asOf]);
  return B(r.b);
}

export async function settings(c: Client, entityId: string) {
  const r = await q<{ late_fee_enabled: boolean; late_fee_bps: number; late_fee_grace_days: number; late_fee_min_minor: string;
    late_fee_max_minor: string | null; default_terms_days: number; writeoff_method: "allowance" | "direct"; call_after_days: number }>(c,
    `select late_fee_enabled, late_fee_bps, late_fee_grace_days, late_fee_min_minor, late_fee_max_minor, default_terms_days,
            writeoff_method, call_after_days from ar_settings where entity_id = $1`, [entityId]);
  return r[0] ?? { late_fee_enabled: false, late_fee_bps: 0, late_fee_grace_days: 10, late_fee_min_minor: "0", late_fee_max_minor: null,
    default_terms_days: 30, writeoff_method: "allowance" as const, call_after_days: 1 };
}

async function customerOf(c: Client, entityId: string, customerId: string, lock = false) {
  const r = await q<{ id: string; name: string; number: string; status: string; credit_limit_minor: string; terms_days: number;
    home_location_id: string | null; email: string | null; phone: string | null }>(c,
    `select id, name, number, status, credit_limit_minor, terms_days, home_location_id, email, phone
       from customer where id = $1 and entity_id = $2 ${lock ? "for update" : ""}`, [customerId, entityId]);
  need(r.length, "no such customer");
  return r[0];
}

// ================================================================ balances

/** What the customer owes on account (negative = a credit balance). */
export async function customerBalance(c: Client, entityId: string, customerId: string, asOf = today()): Promise<bigint> {
  const r = await one<{ b: string }>(c, `select coalesce(sum(amount_minor),0) b from ar_ledger
                                          where entity_id = $1 and customer_id = $2 and occurred_on <= $3::date`, [entityId, customerId, asOf]);
  return B(r.b);
}

export async function openInvoices(c: Client, entityId: string, customerId: string) {
  return q<{ id: string; number: string; kind: string; invoice_date: string; due_date: string; total_minor: string; charged_minor: string;
             open_minor: string; location_id: string | null; sales_order_id: string | null }>(c, `
    select i.id, i.number, i.kind, i.invoice_date::text, i.due_date::text, i.total_minor, i.charged_minor,
           sum(l.amount_minor)::text open_minor, i.location_id, i.sales_order_id
      from customer_invoice i join ar_ledger l on l.invoice_id = i.id and l.entity_id = $1
     where i.entity_id = $1 and i.customer_id = $2
     group by i.id having sum(l.amount_minor) <> 0
     order by i.due_date, i.invoice_date, i.number`, [entityId, customerId]);
}

/** Cash received on account but not yet applied to an invoice (a positive number). */
export async function unappliedCash(c: Client, entityId: string, customerId: string): Promise<bigint> {
  const r = await one<{ b: string }>(c, `select coalesce(sum(amount_minor),0) b from ar_ledger
     where entity_id = $1 and customer_id = $2 and invoice_id is null and contract_id is null`, [entityId, customerId]);
  return -B(r.b);
}

export async function storeCreditBalance(c: Client, entityId: string, customerId: string): Promise<bigint> {
  const r = await one<{ issued: string; used: string }>(c, `
    select coalesce((select sum(amount_minor) from store_credit_ledger where entity_id = $1 and customer_id = $2), 0) issued,
           coalesce((select sum(amount_minor) from customer_receipt where entity_id = $1 and customer_id = $2
                        and method = 'store_credit' and voided_at is null), 0) used`, [entityId, customerId]);
  return B(r.issued) - B(r.used);
}

/** Deposits taken on this customer's orders and not yet applied to a sale. */
export async function depositsOnHand(c: Client, entityId: string, customerId: string) {
  return q<{ sales_order_id: string; number: string; status: string; total_minor: string; paid_minor: string; applied_minor: string; held_minor: string }>(c, `
    select so.id sales_order_id, so.number, so.status, so.total_minor, so.paid_minor,
           coalesce(sum(i.deposit_applied_minor), 0)::text applied_minor,
           (so.paid_minor - coalesce(sum(i.deposit_applied_minor), 0))::text held_minor
      from sales_order so left join customer_invoice i on i.sales_order_id = so.id and i.entity_id = $1
     where so.entity_id = $1 and so.customer_id = $2
     group by so.id having so.paid_minor - coalesce(sum(i.deposit_applied_minor), 0) <> 0
     order by so.ordered_at`, [entityId, customerId]);
}

// ===================================================== credit and accounts

/**
 * Would charging this much to the account fit? A house account may carry up
 * to its credit limit; an account on hold may carry nothing new. An unused
 * override for this order (or for the customer, with no order named) that
 * covers the amount lets it through.
 */
export async function creditCheck(c: Client, entityId: string, customerId: string, chargeMinor: bigint, orderId: string | null):
  Promise<{ ok: boolean; reason: string; overrideId: string | null; balanceMinor: bigint; limitMinor: bigint; availableMinor: bigint }> {
  const cu = await customerOf(c, entityId, customerId);
  const acct = await q<{ house_account: boolean }>(c, `select house_account from ar_account where customer_id = $1 and entity_id = $2`, [customerId, entityId]);
  const bal = await customerBalance(c, entityId, customerId);
  const limit = B(cu.credit_limit_minor);
  const available = limit - bal;
  let reason = "";
  if (cu.status === "hold") reason = `${cu.name}'s account is on hold, so nothing new can be charged to it`;
  else if (!acct[0]?.house_account) reason = `${cu.name} has no house account, so a purchase cannot be charged to it`;
  else if (bal + chargeMinor > limit) reason = `charging ${$(chargeMinor)} would put ${cu.name}'s account at ${$(bal + chargeMinor)}, over its ${$(limit)} limit`;
  if (!reason) return { ok: true, reason: "", overrideId: null, balanceMinor: bal, limitMinor: limit, availableMinor: available };
  const ov = await q<{ id: string }>(c, `
    select id from ar_credit_override
     where entity_id = $1 and customer_id = $2 and used_at is null and up_to_minor >= $3
       and (sales_order_id = $4 or sales_order_id is null)
     order by (sales_order_id is null), created_at limit 1`, [entityId, customerId, chargeMinor.toString(), orderId]);
  return { ok: false, reason: `${reason}; an owner or controller can approve it with a reason`, overrideId: ov[0]?.id ?? null,
    balanceMinor: bal, limitMinor: limit, availableMinor: available };
}

export async function grantOverride(c: Client, scope: Scope, o: { customerId: string; orderId: string | null; upToMinor: bigint; reason: string; approvedBy: string }) {
  await customerOf(c, scope.entityId, o.customerId);
  need(o.upToMinor > 0n, "say how much the override covers");
  need(o.reason.trim().length >= 5, "an override needs a reason a person can read later");
  if (o.orderId) {
    const so = await q(c, `select 1 from sales_order where id = $1 and entity_id = $2 and customer_id = $3`, [o.orderId, scope.entityId, o.customerId]);
    need(so.length, "that order is not this customer's");
  }
  const r = await one<{ id: string }>(c, `insert into ar_credit_override (entity_id, customer_id, sales_order_id, up_to_minor, reason, approved_by)
                                           values ($1,$2,$3,$4,$5,$6) returning id`,
    [scope.entityId, o.customerId, o.orderId, o.upToMinor.toString(), o.reason.trim(), o.approvedBy]);
  await audit(c, scope, { table: "ar_credit_override", rowId: r.id, action: "insert", after: { upTo: o.upToMinor.toString(), orderId: o.orderId }, reason: o.reason });
  return r.id;
}

/** Open or change a house account: limit and terms (on the customer), and the A/R settings. */
export async function setAccount(c: Client, scope: Scope, customerId: string, a: {
  houseAccount?: boolean; creditLimitMinor?: bigint; termsDays?: number; lateFees?: boolean; status?: string;
  statementVia?: string; collectorId?: string | null;
}) {
  const before = await customerOf(c, scope.entityId, customerId, true);
  if (a.creditLimitMinor !== undefined) need(a.creditLimitMinor >= 0n, "a credit limit cannot be negative");
  if (a.termsDays !== undefined) need(a.termsDays >= 0 && a.termsDays <= 180, "terms are 0 to 180 days");
  if (a.status !== undefined) need(["active", "hold", "inactive"].includes(a.status), "status is active, hold or inactive");
  if (a.statementVia !== undefined) need(["email", "mail", "none"].includes(a.statementVia), "statements go by email, mail or not at all");
  await c.query(`update customer set credit_limit_minor = coalesce($3, credit_limit_minor), terms_days = coalesce($4, terms_days),
                        status = coalesce($5, status) where id = $1 and entity_id = $2`,
    [customerId, scope.entityId, a.creditLimitMinor?.toString() ?? null, a.termsDays ?? null, a.status ?? null]);
  await c.query(`insert into ar_account (entity_id, customer_id, house_account, late_fees, statement_via, collector_id, opened_by)
                 values ($1,$2,coalesce($3,false),coalesce($4,true),coalesce($5,'email'),$6,$7)
                 on conflict (customer_id) do update set
                   house_account = coalesce($3, ar_account.house_account), late_fees = coalesce($4, ar_account.late_fees),
                   statement_via = coalesce($5, ar_account.statement_via),
                   collector_id = case when $8 then $6 else ar_account.collector_id end, updated_at = now()`,
    [scope.entityId, customerId, a.houseAccount ?? null, a.lateFees ?? null, a.statementVia ?? null, a.collectorId ?? null,
     scope.actor.id || null, a.collectorId !== undefined]);
  await audit(c, scope, { table: "ar_account", rowId: customerId, action: "update",
    before: { limit: before.credit_limit_minor, terms: before.terms_days, status: before.status },
    after: { ...a, creditLimitMinor: a.creditLimitMinor?.toString() }, reason: "account terms changed" });
}

export async function addNote(c: Client, scope: Scope, customerId: string, body: string) {
  await customerOf(c, scope.entityId, customerId);
  need(body.trim(), "write the note first");
  const r = await one<{ id: string }>(c, `insert into ar_note (entity_id, customer_id, body, author_id) values ($1,$2,$3,$4) returning id`,
    [scope.entityId, customerId, body.trim(), scope.actor.id || null]);
  return r.id;
}

// ================================================================ payments

export type Apply = "oldest" | { invoiceId: string; amountMinor: bigint }[];

/**
 * Money from a customer against their account. It goes to the invoices named
 * (or oldest first), what is left stays on the account as unapplied cash, or
 * becomes store credit if asked. With an order named it is a deposit instead,
 * and goes through postReceipt.
 */
export async function receivePayment(c: Client, scope: Scope, p: {
  customerId: string; amountMinor: bigint; method: string; locationId: string; reference?: string | null; channel?: string;
  apply?: Apply; overpayment?: "unapplied" | "store_credit"; salesOrderId?: string | null; date?: string;
}): Promise<{ receiptId: string; number: string; appliedMinor: bigint; unappliedMinor: bigint; storeCreditMinor: bigint; journalEntryId: string;
              applications: { invoiceId: string; number: string; amountMinor: bigint }[] }> {
  const cu = await customerOf(c, scope.entityId, p.customerId, true);
  need(p.amountMinor > 0n, "the amount has to be more than zero");
  need(["cash", "card", "check", "ach", "gift_card", "store_credit", "other", "financing"].includes(p.method), "that is not a way of paying");
  const loc = await q(c, `select 1 from location where id = $1 and entity_id = $2`, [p.locationId, scope.entityId]);
  need(loc.length, "pick the store that took the money");
  if (p.method === "store_credit") {
    const sc = await storeCreditBalance(c, scope.entityId, p.customerId);
    need(sc >= p.amountMinor, `${cu.name} has ${$(sc)} of store credit, less than ${$(p.amountMinor)}`);
  }

  if (p.salesOrderId) {
    // A deposit on an order: the contract's posting.
    const so = await q<{ status: string }>(c, `select status from sales_order where id = $1 and entity_id = $2 and customer_id = $3`,
      [p.salesOrderId, scope.entityId, p.customerId]);
    need(so.length, "that order is not this customer's");
    need(!["cancelled", "draft"].includes(so[0].status), `that order is ${so[0].status}`);
    const r = await takeReceipt(c, scope, { ...p, salesOrderId: p.salesOrderId, channel: p.channel ?? "pos" });
    const je = await postReceipt(c, scope, r.id);
    return { receiptId: r.id, number: r.number, appliedMinor: 0n, unappliedMinor: 0n, storeCreditMinor: 0n, journalEntryId: je, applications: [] };
  }
  need(p.method !== "financing", "a finance company pays for a sale, not an account; take it on the order");

  const date = p.date ?? today();
  const r = await takeReceipt(c, scope, { ...p, channel: p.channel ?? "pos" });
  const plan = await planApplications(c, scope.entityId, p.customerId, p.amountMinor, p.apply ?? "oldest");
  const applied = plan.reduce((a, x) => a + x.amountMinor, 0n);
  const rest = p.amountMinor - applied;
  const toCredit = p.overpayment === "store_credit" ? rest : 0n;
  const toAccount = p.amountMinor - toCredit;

  const po = await profitObjectFor(c, scope.entityId, p.locationId);
  const lines: PostLine[] = [
    { code: cashCodeFor(p.method), debit: p.amountMinor, profitObjectId: po },
    { code: "1100", credit: toAccount, profitObjectId: po },
    { code: "2320", credit: toCredit, profitObjectId: po },
  ];
  const je = await post(c, scope, { date, sourceType: "ar", sourceId: r.id, description: `Payment on account ${r.number}, ${cu.name}`, lines });
  await c.query(`insert into ar_payment (receipt_id, entity_id, customer_id, to_account_minor, to_credit_minor, journal_entry_id)
                 values ($1,$2,$3,$4,$5,$6)`, [r.id, scope.entityId, p.customerId, toAccount.toString(), toCredit.toString(), je]);
  for (const a of plan) {
    await ledger(c, scope, { customerId: p.customerId, invoiceId: a.invoiceId, receiptId: r.id, locationId: p.locationId, date,
      kind: "payment", amount: -a.amountMinor, memo: `${r.number} to ${a.number}`, journalEntryId: je });
  }
  const unapplied = toAccount - applied;
  if (unapplied > 0n) {
    await ledger(c, scope, { customerId: p.customerId, receiptId: r.id, locationId: p.locationId, date, kind: "unapplied",
      amount: -unapplied, memo: `${r.number} left on account`, journalEntryId: je });
  }
  if (toCredit > 0n) {
    await c.query(`insert into store_credit_ledger (entity_id, customer_id, amount_minor, source, receipt_id, journal_entry_id, created_by)
                   values ($1,$2,$3,'overpayment',$4,$5,$6)`, [scope.entityId, p.customerId, toCredit.toString(), r.id, je, scope.actor.id || null]);
  }
  return { receiptId: r.id, number: r.number, appliedMinor: applied, unappliedMinor: unapplied, storeCreditMinor: toCredit, journalEntryId: je,
    applications: plan };
}

/** Which invoices a sum goes to: those named (each no more than it owes), or the oldest first. */
async function planApplications(c: Client, entityId: string, customerId: string, amount: bigint, apply: Apply) {
  const open = (await openInvoices(c, entityId, customerId)).filter((i) => B(i.open_minor) > 0n);
  const out: { invoiceId: string; number: string; amountMinor: bigint }[] = [];
  let left = amount;
  if (apply === "oldest") {
    for (const i of open) {
      if (left <= 0n) break;
      const take = B(i.open_minor) < left ? B(i.open_minor) : left;
      out.push({ invoiceId: i.id, number: i.number, amountMinor: take });
      left -= take;
    }
    return out;
  }
  const seen = new Set<string>();
  for (const a of apply) {
    need(!seen.has(a.invoiceId), "the same invoice is named twice");
    seen.add(a.invoiceId);
    const i = open.find((x) => x.id === a.invoiceId);
    need(i, "one of those invoices is not open on this account");
    need(a.amountMinor > 0n, "each amount applied has to be more than zero");
    need(a.amountMinor <= B(i.open_minor), `${i.number} owes ${$(B(i.open_minor))}; ${$(a.amountMinor)} is more than that`);
    left -= a.amountMinor;
    need(left >= 0n, "the amounts applied add up to more than the payment");
    out.push({ invoiceId: i.id, number: i.number, amountMinor: a.amountMinor });
  }
  return out;
}

/** Put unapplied cash and open credit memos against open invoices. Moves inside 1100; nothing posts. */
export async function applyCredits(c: Client, scope: Scope, customerId: string, apply: Apply = "oldest") {
  await customerOf(c, scope.entityId, customerId, true);
  const unapplied = await unappliedCash(c, scope.entityId, customerId);
  const memos = (await openInvoices(c, scope.entityId, customerId)).filter((i) => B(i.open_minor) < 0n);
  const available = unapplied + memos.reduce((a, m) => a - B(m.open_minor), 0n);
  need(available > 0n, "there is no unapplied cash or credit on this account");
  const plan = await planApplications(c, scope.entityId, customerId, available, apply);
  need(plan.length, "there is no open invoice to apply it to");
  const date = today();
  let fromCash = unapplied;
  const memoLeft = memos.map((m) => ({ id: m.id, number: m.number, left: -B(m.open_minor) }));
  let total = 0n;
  for (const a of plan) {
    let need_ = a.amountMinor;
    // unapplied cash first, then credit memos oldest first
    const takeCash = fromCash < need_ ? fromCash : need_;
    if (takeCash > 0n) {
      await ledger(c, scope, { customerId, date, kind: "apply", amount: takeCash, memo: `unapplied cash to ${a.number}` });
      await ledger(c, scope, { customerId, invoiceId: a.invoiceId, date, kind: "apply", amount: -takeCash, memo: "from unapplied cash" });
      fromCash -= takeCash; need_ -= takeCash;
    }
    for (const m of memoLeft) {
      if (need_ <= 0n) break;
      const t = m.left < need_ ? m.left : need_;
      if (t <= 0n) continue;
      await ledger(c, scope, { customerId, invoiceId: m.id, date, kind: "apply", amount: t, memo: `${m.number} to ${a.number}` });
      await ledger(c, scope, { customerId, invoiceId: a.invoiceId, date, kind: "apply", amount: -t, memo: `from ${m.number}` });
      m.left -= t; need_ -= t;
    }
    total += a.amountMinor - need_;
  }
  return { appliedMinor: total };
}

/** A credit balance on the account becomes store credit: Dr 1100, Cr 2320. */
export async function creditToStoreCredit(c: Client, scope: Scope, customerId: string, amountMinor: bigint, reason: string) {
  const cu = await customerOf(c, scope.entityId, customerId, true);
  const unapplied = await unappliedCash(c, scope.entityId, customerId);
  need(amountMinor > 0n, "the amount has to be more than zero");
  need(amountMinor <= unapplied, `${cu.name} has ${$(unapplied)} unapplied on account`);
  need(reason.trim(), "say why");
  const po = await profitObjectFor(c, scope.entityId, cu.home_location_id);
  const je = await post(c, scope, { date: today(), sourceType: "ar", sourceId: customerId, description: `Credit balance to store credit, ${cu.name}`,
    lines: [{ code: "1100", debit: amountMinor, profitObjectId: po }, { code: "2320", credit: amountMinor, profitObjectId: po }] });
  await ledger(c, scope, { customerId, date: today(), kind: "to_store_credit", amount: amountMinor, memo: reason.trim(), journalEntryId: je });
  await c.query(`insert into store_credit_ledger (entity_id, customer_id, amount_minor, source, journal_entry_id, reason, created_by)
                 values ($1,$2,$3,'credit_balance',$4,$5,$6)`, [scope.entityId, customerId, amountMinor.toString(), je, reason.trim(), scope.actor.id || null]);
  return je;
}

// ============================================================== statements

const KIND_WORDS: Record<string, string> = {
  invoice: "Invoice", late_fee: "Late fee", credit_memo: "Credit memo", payment: "Payment", unapplied: "Payment, on account",
  to_store_credit: "Moved to store credit", writeoff: "Written off", recovery: "Reinstated (recovery)",
};

/** Opening balance, every movement in the window, closing balance. */
export async function statement(c: Client, entityId: string, customerId: string, from: string, to: string) {
  need(isDay(from) && isDay(to) && from <= to, "pick a start and end date, start first");
  const cu = await customerOf(c, entityId, customerId);
  const opening = await customerBalance(c, entityId, customerId, addDays(from, -1));
  const rows = await q<{ occurred_on: string; kind: string; amount_minor: string; memo: string | null; invoice: string | null; receipt: string | null; contract: string | null }>(c, `
    select l.occurred_on::text, l.kind, l.amount_minor, l.memo, i.number invoice, r.number receipt, k.number contract
      from ar_ledger l
      left join customer_invoice i on i.id = l.invoice_id
      left join customer_receipt r on r.id = l.receipt_id
      left join ar_contract k on k.id = l.contract_id
     where l.entity_id = $1 and l.customer_id = $2 and l.occurred_on between $3::date and $4::date
       and l.kind not in ('apply','contract')          -- moves inside the account net to zero the same day
     order by l.occurred_on, l.created_at, l.id`, [entityId, customerId, from, to]);
  // Contract payments are one line per receipt.
  const merged: { on: string; what: string; ref: string; charges: bigint; credits: bigint }[] = [];
  for (const r of rows) {
    const amt = B(r.amount_minor);
    const ref = r.invoice ?? r.contract ?? r.receipt ?? "";
    const what = r.contract && r.kind === "payment" ? `Contract payment ${r.receipt ?? ""}`.trim()
      : r.kind === "payment" ? `Payment ${r.receipt ?? ""}`.trim() : KIND_WORDS[r.kind] ?? r.kind;
    merged.push({ on: r.occurred_on, what, ref, charges: amt > 0n ? amt : 0n, credits: amt < 0n ? -amt : 0n });
  }
  let run = opening;
  const lines = merged.map((m) => { run += m.charges - m.credits; return { ...m, balance: run }; });
  const closing = await customerBalance(c, entityId, customerId, to);
  const ag = await aging(c, entityId, to, customerId);
  return {
    customer: { id: cu.id, name: cu.name, number: cu.number, email: cu.email, phone: cu.phone },
    from, to, opening, closing, lines,
    charges: lines.reduce((a, l) => a + l.charges, 0n), credits: lines.reduce((a, l) => a + l.credits, 0n),
    aging: ag.totals,
    ties: run === closing,
  };
}

// ================================================================== aging

export const BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
type Bucket = typeof BUCKETS[number];
export function bucketOf(daysPastDue: number): Bucket {
  return daysPastDue <= 0 ? "current" : daysPastDue <= 30 ? "d1_30" : daysPastDue <= 60 ? "d31_60" : daysPastDue <= 90 ? "d61_90" : "d90_plus";
}
type AgingRow = { key: string; name: string; current: bigint; d1_30: bigint; d31_60: bigint; d61_90: bigint; d90_plus: bigint;
                  unapplied: bigint; total: bigint; maxDays: number };
const blank = (key: string, name: string): AgingRow =>
  ({ key, name, current: 0n, d1_30: 0n, d31_60: 0n, d61_90: 0n, d90_plus: 0n, unapplied: 0n, total: 0n, maxDays: 0 });

/**
 * Open receivables by how late they are, by customer and by store, as of a
 * day. Invoices age from their due date; contract principal ages by the
 * installment it belongs to; unapplied cash is its own column. The total
 * is compared with GL 1100 on the same day.
 */
export async function aging(c: Client, entityId: string, asOf = today(), onlyCustomer: string | null = null) {
  const inv = await q<{ customer_id: string | null; cname: string | null; location_id: string | null; lname: string | null; due_date: string; open: string }>(c, `
    select i.customer_id, cu.name cname, i.location_id, lo.name lname, i.due_date::text, sum(l.amount_minor)::text open
      from ar_ledger l join customer_invoice i on i.id = l.invoice_id
      left join customer cu on cu.id = i.customer_id left join location lo on lo.id = i.location_id
     where l.entity_id = $1 and l.occurred_on <= $2::date and ($3::uuid is null or i.customer_id = $3)
     group by i.id, cu.name, lo.name having sum(l.amount_minor) <> 0`, [entityId, asOf, onlyCustomer]);
  const unap = await q<{ customer_id: string | null; cname: string | null; location_id: string | null; lname: string | null; amt: string }>(c, `
    select l.customer_id, cu.name cname, l.location_id, lo.name lname, sum(l.amount_minor)::text amt
      from ar_ledger l left join customer cu on cu.id = l.customer_id left join location lo on lo.id = l.location_id
     where l.entity_id = $1 and l.occurred_on <= $2::date and l.invoice_id is null and l.contract_id is null
       and ($3::uuid is null or l.customer_id = $3)
     group by l.customer_id, cu.name, l.location_id, lo.name having sum(l.amount_minor) <> 0`, [entityId, asOf, onlyCustomer]);
  const con = await q<{ id: string; customer_id: string; cname: string; location_id: string | null; lname: string | null; bal: string }>(c, `
    select k.id, k.customer_id, cu.name cname, k.location_id, lo.name lname, sum(l.amount_minor)::text bal
      from ar_ledger l join ar_contract k on k.id = l.contract_id join customer cu on cu.id = k.customer_id
      left join location lo on lo.id = k.location_id
     where l.entity_id = $1 and l.occurred_on <= $2::date and ($3::uuid is null or k.customer_id = $3)
     group by k.id, cu.name, lo.name having sum(l.amount_minor) <> 0`, [entityId, asOf, onlyCustomer]);
  const late = con.length ? await q<{ contract_id: string; due_on: string; owed: string }>(c, `
    select contract_id, due_on::text, (principal_minor - paid_principal_minor)::text owed
      from ar_contract_installment
     where entity_id = $1 and contract_id = any($2) and status = 'due' and due_on < $3::date and principal_minor > paid_principal_minor`,
    [entityId, con.map((x) => x.id), asOf]) : [];

  const byCustomer = new Map<string, AgingRow>(), byLocation = new Map<string, AgingRow>();
  const totals = blank("all", "All");
  const add = (cust: string | null, cname: string | null, loc: string | null, lname: string | null, col: Bucket | "unapplied", amt: bigint, days: number) => {
    const ck = cust ?? "none", lk = loc ?? "none";
    if (!byCustomer.has(ck)) byCustomer.set(ck, blank(ck, cname ?? "Cash sales (no customer)"));
    if (!byLocation.has(lk)) byLocation.set(lk, blank(lk, lname ?? "No store"));
    for (const r of [byCustomer.get(ck)!, byLocation.get(lk)!, totals]) {
      r[col] += amt; r.total += amt;
      if (amt > 0n && days > r.maxDays) r.maxDays = days;
    }
  };
  for (const i of inv) {
    const days = daysBetween(i.due_date, asOf);
    add(i.customer_id, i.cname, i.location_id, i.lname, bucketOf(days), B(i.open), days);
  }
  for (const u of unap) add(u.customer_id, u.cname, u.location_id, u.lname, "unapplied", B(u.amt), 0);
  for (const k of con) {
    let rest = B(k.bal);
    for (const l of late.filter((x) => x.contract_id === k.id)) {
      const owed = B(l.owed) < rest ? B(l.owed) : rest;
      if (owed <= 0n) continue;
      const days = daysBetween(l.due_on, asOf);
      add(k.customer_id, k.cname, k.location_id, k.lname, bucketOf(days), owed, days);
      rest -= owed;
    }
    if (rest !== 0n) add(k.customer_id, k.cname, k.location_id, k.lname, "current", rest, 0);
  }
  const gl = onlyCustomer ? null : await glBalance(c, entityId, "1100", asOf);
  const sort = (m: Map<string, AgingRow>) => [...m.values()].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : a.name.localeCompare(b.name)));
  return { asOf, customers: sort(byCustomer), locations: sort(byLocation), totals, glMinor: gl,
    differenceMinor: gl === null ? null : totals.total - gl };
}

// ============================================================== late fees

/**
 * Charge late fees by policy: once a month per overdue invoice, after the
 * grace days, the larger of the minimum and the rate on what is overdue
 * (capped at the maximum, if set). Fees do not earn fees. Dr 1100, Cr 4020.
 */
export async function assessLateFees(c: Client, scope: Scope, asOf = today()) {
  need(isDay(asOf) && asOf <= today(), "late fees are charged as of today or an earlier day");
  const s = await settings(c, scope.entityId);
  need(s.late_fee_enabled, "late fees are turned off in the A/R settings");
  const month = asOf.slice(0, 7);
  const due = await q<{ id: string; number: string; customer_id: string; name: string; location_id: string | null; due_date: string; open: string }>(c, `
    select i.id, i.number, i.customer_id, cu.name, i.location_id, i.due_date::text, sum(l.amount_minor)::text open
      from customer_invoice i
      join ar_ledger l on l.invoice_id = i.id and l.entity_id = $1 and l.occurred_on <= $2::date
      join customer cu on cu.id = i.customer_id
      left join ar_account a on a.customer_id = i.customer_id
     where i.entity_id = $1 and i.kind = 'sale' and i.due_date + $3::int < $2::date and coalesce(a.late_fees, true)
       and not exists (select 1 from ar_late_fee f where f.invoice_id = i.id and f.assessed_for = $4)
     group by i.id, cu.name having sum(l.amount_minor) > 0
     order by i.due_date`, [scope.entityId, asOf, s.late_fee_grace_days, month]);
  const out: { invoice: string; feeInvoice: string; feeMinor: bigint; customer: string }[] = [];
  for (const d of due) {
    let fee = mulBps(B(d.open), s.late_fee_bps);
    if (fee < B(s.late_fee_min_minor)) fee = B(s.late_fee_min_minor);
    if (s.late_fee_max_minor !== null && fee > B(s.late_fee_max_minor)) fee = B(s.late_fee_max_minor);
    if (fee <= 0n) continue;
    const number = await nextNo(c, scope.entityId, "invoice", "INV-");
    const po = await profitObjectFor(c, scope.entityId, d.location_id);
    const inv = await one<{ id: string }>(c, `
      insert into customer_invoice (entity_id, number, kind, customer_id, location_id, invoice_date, due_date, subtotal_minor, tax_minor,
                                    total_minor, deposit_applied_minor, charged_minor, status, memo, created_by)
      values ($1,$2,'late_fee',$3,$4,$5,$5,$6,0,$6,0,$6,'open',$7,$8) returning id`,
      [scope.entityId, number, d.customer_id, d.location_id, asOf, fee.toString(), `Late fee on ${d.number} for ${month}`, scope.actor.id || null]);
    const je = await post(c, scope, { date: asOf, sourceType: "ar", sourceId: inv.id, description: `Late fee ${number} on ${d.number}, ${d.name}`,
      lines: [{ code: "1100", debit: fee, profitObjectId: po }, { code: "4020", credit: fee, profitObjectId: po }] });
    await c.query(`update customer_invoice set journal_entry_id = $2 where id = $1 and entity_id = $3`, [inv.id, je, scope.entityId]);
    await c.query(`insert into customer_invoice_line (entity_id, invoice_id, seq, description, qty, unit_price_minor, net_minor, revenue_code)
                   values ($1,$2,1,$3,1,$4,$4,'4020')`, [scope.entityId, inv.id, `Late fee: ${d.number} past due since ${d.due_date}`, fee.toString()]);
    await c.query(`insert into ar_late_fee (entity_id, invoice_id, fee_invoice_id, assessed_for, overdue_minor, fee_minor)
                   values ($1,$2,$3,$4,$5,$6)`, [scope.entityId, d.id, inv.id, month, d.open, fee.toString()]);
    await ledger(c, scope, { customerId: d.customer_id, invoiceId: inv.id, locationId: d.location_id, date: asOf, kind: "late_fee",
      amount: fee, memo: `on ${d.number}`, journalEntryId: je });
    out.push({ invoice: d.number, feeInvoice: number, feeMinor: fee, customer: d.name });
  }
  return out;
}

// ============================================================ collections

export interface MessageProvider {
  readonly name: string;
  send(m: { channel: "letter" | "sms" | "email"; to: string | null; subject: string | null; body: string }): Promise<{ ref: string | null }>;
}
/** Records the message as sent and sends nothing. The real SMS, email and mail-house providers plug in here. */
export class RecordOnlyProvider implements MessageProvider {
  readonly name = "record only (nothing was sent)";
  async send() { return { ref: null }; }
}

/** Promises whose day has passed are kept if that much came in since, broken if not. */
export async function refreshPromises(c: Client, scope: Scope, asOf = today()) {
  const r = await q<{ id: string; status: string }>(c, `
    update ar_promise p set status = case when coalesce((
             select sum(r.amount_minor) from customer_receipt r
              where r.entity_id = $1 and r.customer_id = p.customer_id and r.voided_at is null and r.received_at >= p.created_at), 0)
             >= p.amount_minor then 'kept' else 'broken' end,
           resolved_at = now()
     where p.entity_id = $1 and p.status = 'open'
       and (p.promised_on < $2::date or coalesce((
             select sum(r.amount_minor) from customer_receipt r
              where r.entity_id = $1 and r.customer_id = p.customer_id and r.voided_at is null and r.received_at >= p.created_at), 0) >= p.amount_minor)
    returning p.id, p.status`, [scope.entityId, asOf]);
  return { kept: r.filter((x) => x.status === "kept").length, broken: r.filter((x) => x.status === "broken").length };
}

/**
 * Today's call list. Anyone past due, most urgent first: a broken promise,
 * then a callback that has come due, then days past due times the amount.
 * Someone with a promise not yet due waits; someone already reached today
 * waits unless a callback is due.
 */
export async function callList(c: Client, entityId: string, asOf = today()) {
  const s = await settings(c, entityId);
  const ag = await aging(c, entityId, asOf);
  const rows = ag.customers.filter((r) => r.key !== "none" && r.total - r.current - r.unapplied > 0n && r.maxDays >= s.call_after_days);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.key);
  const meta = await q<{ customer_id: string; phone: string | null; email: string | null; number: string;
    last_at: string | null; last_kind: string | null; last_outcome: string | null; callback_at: string | null; contacted_today: boolean;
    promise_on: string | null; promise_minor: string | null; promise_paid: string | null; broken_on: string | null }>(c, `
    select cu.id customer_id, cu.phone, cu.email, cu.number,
           la.at::text last_at, la.kind last_kind, la.outcome last_outcome, cb.callback_at::text callback_at,
           exists (select 1 from ar_collection_action x where x.entity_id = $1 and x.customer_id = cu.id
                     and x.at::date = $3::date and x.kind in ('call','visit')) contacted_today,
           op.promised_on::text promise_on, op.amount_minor promise_minor,
           (select coalesce(sum(r.amount_minor),0) from customer_receipt r where r.entity_id = $1 and r.customer_id = cu.id
              and r.voided_at is null and r.received_at >= op.created_at)::text promise_paid,
           (select max(p.promised_on)::text from ar_promise p where p.entity_id = $1 and p.customer_id = cu.id and p.status = 'broken'
              and not exists (select 1 from ar_promise p2 where p2.entity_id = $1 and p2.customer_id = cu.id and p2.created_at > p.created_at)) broken_on
      from customer cu
      left join lateral (select at, kind, outcome from ar_collection_action x where x.entity_id = $1 and x.customer_id = cu.id
                          order by at desc limit 1) la on true
      left join lateral (select callback_at from ar_collection_action x where x.entity_id = $1 and x.customer_id = cu.id
                          and x.callback_at is not null order by at desc limit 1) cb on true
      left join lateral (select promised_on, amount_minor, created_at from ar_promise p where p.entity_id = $1 and p.customer_id = cu.id
                          and p.status = 'open' order by created_at desc limit 1) op on true
     where cu.entity_id = $1 and cu.id = any($2)`, [entityId, ids, asOf]);
  const byId = new Map(meta.map((m) => [m.customer_id, m]));
  const out = [];
  for (const r of rows) {
    const m = byId.get(r.key)!;
    const pastDue = r.total - r.current - r.unapplied;
    // A promise whose day has passed without the money is broken, whether or not anyone has marked it yet.
    const promiseLapsed = m.promise_on !== null && m.promise_on < asOf && B(m.promise_paid) < B(m.promise_minor);
    const broken = promiseLapsed || m.broken_on !== null;
    const waitingOnPromise = m.promise_on !== null && !promiseLapsed;
    const callbackDue = m.callback_at !== null && m.callback_at.slice(0, 10) <= asOf
      && (m.last_at === null || m.callback_at > m.last_at || m.last_outcome === "callback");
    if (waitingOnPromise && !callbackDue) continue;
    if (m.contacted_today && !callbackDue && !broken) continue;
    const tier = broken ? 3 : callbackDue ? 2 : 1;
    const score = r.maxDays * Number(pastDue / 100n);
    out.push({ customerId: r.key, name: r.name, number: m.number, phone: m.phone, email: m.email,
      pastDueMinor: pastDue, balanceMinor: r.total, maxDaysPastDue: r.maxDays,
      buckets: { d1_30: r.d1_30, d31_60: r.d31_60, d61_90: r.d61_90, d90_plus: r.d90_plus },
      reason: broken ? `Promise broken${m.broken_on ? ` (due ${m.broken_on})` : m.promise_on ? ` (due ${m.promise_on})` : ""}`
        : callbackDue ? `Callback due ${m.callback_at!.slice(0, 16).replace("T", " ")}` : `${r.maxDays} days past due`,
      tier, score, lastContact: m.last_at ? { at: m.last_at, kind: m.last_kind, outcome: m.last_outcome } : null });
  }
  out.sort((a, b) => b.tier - a.tier || b.score - a.score || (b.pastDueMinor > a.pastDueMinor ? 1 : -1));
  return out;
}

export async function logAction(c: Client, scope: Scope, a: {
  customerId: string; kind: string; outcome?: string | null; notes?: string | null; callbackAt?: string | null;
  promise?: { on: string; amountMinor: bigint } | null;
}) {
  await customerOf(c, scope.entityId, a.customerId);
  need(["call", "visit", "letter", "sms", "email", "note"].includes(a.kind), "say what kind of contact it was");
  if (a.outcome) need(["no_answer", "left_message", "promised", "refused", "disputed", "wrong_number", "paid", "callback", "sent", "other"].includes(a.outcome),
    "that is not an outcome the list knows");
  if (a.outcome === "promised") need(a.promise, "a promise to pay needs a date and an amount");
  if (a.outcome === "callback") need(a.callbackAt, "a callback needs a time");
  if (a.callbackAt) need(!Number.isNaN(Date.parse(a.callbackAt)), "that callback time is not a date and time");
  const act = await one<{ id: string }>(c, `
    insert into ar_collection_action (entity_id, customer_id, kind, outcome, notes, callback_at, by_id)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [scope.entityId, a.customerId, a.kind, a.outcome ?? null, a.notes?.trim() || null, a.callbackAt || null, scope.actor.id || null]);
  let promiseId: string | null = null;
  if (a.promise) {
    need(isDay(a.promise.on) && a.promise.on >= today(), "a promise is for today or a day to come");
    need(a.promise.amountMinor > 0n, "a promise needs an amount");
    await c.query(`update ar_promise set status = 'cancelled', resolved_at = now()
                    where entity_id = $1 and customer_id = $2 and status = 'open'`, [scope.entityId, a.customerId]);
    const bal = await customerBalance(c, scope.entityId, a.customerId);
    const p = await one<{ id: string }>(c, `
      insert into ar_promise (entity_id, customer_id, promised_on, amount_minor, action_id, balance_at_promise_minor, created_by)
      values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [scope.entityId, a.customerId, a.promise.on, a.promise.amountMinor.toString(), act.id, bal.toString(), scope.actor.id || null]);
    promiseId = p.id;
  }
  return { actionId: act.id, promiseId };
}

/** Fill a template for one customer. */
export async function renderTemplate(c: Client, entityId: string, customerId: string, code: string) {
  const t = await q<{ id: string; channel: "letter" | "sms" | "email"; subject: string | null; body: string; name: string }>(c,
    `select id, channel, subject, body, name from ar_template where entity_id = $1 and code = $2 and active`, [entityId, code]);
  need(t.length, "no such template");
  const cu = await customerOf(c, entityId, customerId);
  const ag = await aging(c, entityId, today(), customerId);
  const co = await one<{ name: string }>(c, `select name from entity where id = $1 /* unscoped: the company's own name */`, [entityId]);
  const vars: Record<string, string> = {
    name: cu.name, number: cu.number, company: co.name, balance: $(ag.totals.total),
    past_due: $(ag.totals.total - ag.totals.current - ag.totals.unapplied), days: String(ag.totals.maxDays),
  };
  const fill = (s: string) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? "");
  return { templateId: t[0].id, channel: t[0].channel, subject: t[0].subject ? fill(t[0].subject) : null, body: fill(t[0].body),
    to: t[0].channel === "sms" ? cu.phone : t[0].channel === "email" ? cu.email : cu.name };
}

export async function sendTemplate(c: Client, scope: Scope, provider: MessageProvider, customerId: string, code: string) {
  const m = await renderTemplate(c, scope.entityId, customerId, code);
  if (m.channel !== "letter") need(m.to, `there is no ${m.channel === "sms" ? "phone number" : "email address"} on file for this customer`);
  const sent = await provider.send({ channel: m.channel, to: m.to, subject: m.subject, body: m.body });
  const r = await one<{ id: string }>(c, `
    insert into ar_message (entity_id, customer_id, template_id, channel, to_address, subject, body, provider, provider_ref, sent_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [scope.entityId, customerId, m.templateId, m.channel, m.to, m.subject, m.body, provider.name, sent.ref, scope.actor.id || null]);
  await logAction(c, scope, { customerId, kind: m.channel, outcome: "sent", notes: `${code}: ${m.subject ?? m.body.slice(0, 80)}` });
  return { messageId: r.id, ...m, provider: provider.name };
}

// ============================================================== write-offs

async function openOf(c: Client, entityId: string, target: { invoiceId?: string | null; contractId?: string | null }) {
  const r = await one<{ b: string }>(c, `select coalesce(sum(amount_minor),0) b from ar_ledger where entity_id = $1 and
      (($2::uuid is not null and invoice_id = $2) or ($3::uuid is not null and contract_id = $3))`,
    [entityId, target.invoiceId ?? null, target.contractId ?? null]);
  return B(r.b);
}

export async function requestWriteoff(c: Client, scope: Scope, w: {
  invoiceId?: string | null; contractId?: string | null; amountMinor: bigint; reason: string; method?: "allowance" | "direct"; requestedBy: string;
}) {
  need(!!w.invoiceId !== !!w.contractId, "write off an invoice or a contract");
  need(w.reason.trim().length >= 5, "a write-off needs a reason a person can read later");
  need(w.amountMinor > 0n, "the amount has to be more than zero");
  const t = w.invoiceId
    ? await q<{ customer_id: string | null; number: string }>(c, `select customer_id, number from customer_invoice where id = $1 and entity_id = $2`, [w.invoiceId, scope.entityId])
    : await q<{ customer_id: string; number: string }>(c, `select customer_id, number from ar_contract where id = $1 and entity_id = $2`, [w.contractId, scope.entityId]);
  need(t.length, "no such invoice or contract");
  need(t[0].customer_id, "a cash sale with no customer cannot be written off here");
  const open = await openOf(c, scope.entityId, w);
  const pending = await one<{ s: string }>(c, `select coalesce(sum(amount_minor),0) s from ar_writeoff where entity_id = $1 and status = 'pending'
      and (invoice_id = $2 or contract_id = $3)`, [scope.entityId, w.invoiceId ?? null, w.contractId ?? null]);
  need(w.amountMinor + B(pending.s) <= open, `${t[0].number} has ${$(open - B(pending.s))} open to write off`);
  const method = w.method ?? (await settings(c, scope.entityId)).writeoff_method;
  const r = await one<{ id: string }>(c, `
    insert into ar_writeoff (entity_id, customer_id, invoice_id, contract_id, amount_minor, method, reason, requested_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [scope.entityId, t[0].customer_id, w.invoiceId ?? null, w.contractId ?? null, w.amountMinor.toString(), method, w.reason.trim(), w.requestedBy]);
  await audit(c, scope, { table: "ar_writeoff", rowId: r.id, action: "insert", after: { amount: w.amountMinor.toString(), method }, reason: w.reason });
  return r.id;
}

/** A second person approves (and it posts) or rejects. The maker is never the checker. */
export async function decideWriteoff(c: Client, scope: Scope, id: string, d: { decision: "approved" | "rejected"; by: string; note?: string }) {
  const w = await q<{ id: string; status: string; requested_by: string; customer_id: string; invoice_id: string | null; contract_id: string | null;
    amount_minor: string; method: string; reason: string }>(c,
    `select id, status, requested_by, customer_id, invoice_id, contract_id, amount_minor, method, reason
       from ar_writeoff where id = $1 and entity_id = $2 for update`, [id, scope.entityId]);
  need(w.length, "no such write-off");
  const x = w[0];
  need(x.status === "pending", `this write-off is already ${x.status}`);
  need(x.requested_by !== d.by, "whoever asked for a write-off cannot approve it; a second person has to");
  if (d.decision === "rejected") {
    need(d.note?.trim(), "say why it is rejected");
    await c.query(`update ar_writeoff set status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1 and entity_id = $4`,
      [id, d.by, d.note!.trim(), scope.entityId]);
    return { status: "rejected" as const, journalEntryId: null };
  }
  const amt = B(x.amount_minor);
  const open = await openOf(c, scope.entityId, { invoiceId: x.invoice_id, contractId: x.contract_id });
  need(amt <= open, `only ${$(open)} is still open; the write-off is for ${$(amt)}`);
  const loc = x.invoice_id
    ? await one<{ location_id: string | null; number: string }>(c, `select location_id, number from customer_invoice where id = $1 and entity_id = $2`, [x.invoice_id, scope.entityId])
    : await one<{ location_id: string | null; number: string }>(c, `select location_id, number from ar_contract where id = $1 and entity_id = $2`, [x.contract_id, scope.entityId]);
  const po = await profitObjectFor(c, scope.entityId, loc.location_id);
  const code = x.method === "direct" ? "6900" : "1190";
  const date = today();
  const je = await post(c, scope, { date, sourceType: "ar", sourceId: id, description: `Write-off ${loc.number}: ${x.reason}`.slice(0, 300),
    lines: [{ code, debit: amt, profitObjectId: po }, { code: "1100", credit: amt, profitObjectId: po }] });
  await c.query(`update ar_writeoff set status = 'posted', decided_by = $2, decided_at = now(), decision_note = $3, journal_entry_id = $4
                  where id = $1 and entity_id = $5`, [id, d.by, d.note?.trim() || null, je, scope.entityId]);
  await ledger(c, scope, { customerId: x.customer_id, invoiceId: x.invoice_id, contractId: x.contract_id, locationId: loc.location_id, date,
    kind: "writeoff", amount: -amt, memo: x.reason, journalEntryId: je });
  if (x.contract_id && (await openOf(c, scope.entityId, { contractId: x.contract_id })) === 0n) {
    await c.query(`update ar_contract set status = 'charged_off', closed_at = now() where id = $1 and entity_id = $2`, [x.contract_id, scope.entityId]);
    await contractEvent(c, scope, x.contract_id, "charged_off", { amount: amt.toString() }, x.reason);
  }
  await audit(c, scope, { table: "ar_writeoff", rowId: id, action: "transition", after: { status: "posted" }, reason: d.note || "approved" });
  return { status: "posted" as const, journalEntryId: je };
}

/** Money collected on something written off: reinstate that much, then take it as a payment. */
export async function recordRecovery(c: Client, scope: Scope, writeoffId: string, r: {
  amountMinor: bigint; method: string; locationId: string; reference?: string | null;
}) {
  const w = await q<{ status: string; customer_id: string; invoice_id: string | null; contract_id: string | null; amount_minor: string;
    recovered_minor: string; method: string }>(c,
    `select status, customer_id, invoice_id, contract_id, amount_minor, recovered_minor, method
       from ar_writeoff where id = $1 and entity_id = $2 for update`, [writeoffId, scope.entityId]);
  need(w.length, "no such write-off");
  const x = w[0];
  need(x.status === "posted", "only a posted write-off can be recovered");
  const left = B(x.amount_minor) - B(x.recovered_minor);
  need(r.amountMinor > 0n && r.amountMinor <= left, `up to ${$(left)} of this write-off can still be recovered`);
  need(["cash", "card", "check", "ach", "other"].includes(r.method), "a recovery is taken in cash, card, check, ACH or other");
  const rc = await takeReceipt(c, scope, { customerId: x.customer_id, locationId: r.locationId, method: r.method, amountMinor: r.amountMinor,
    reference: r.reference, channel: "pos" });
  const po = await profitObjectFor(c, scope.entityId, r.locationId);
  const code = x.method === "direct" ? "6900" : "1190";
  const date = today();
  const je = await post(c, scope, { date, sourceType: "ar", sourceId: rc.id, description: `Recovery on a written-off balance, ${rc.number}`,
    lines: [{ code: "1100", debit: r.amountMinor, profitObjectId: po, memo: "reinstated" }, { code, credit: r.amountMinor, profitObjectId: po },
            { code: cashCodeFor(r.method), debit: r.amountMinor, profitObjectId: po }, { code: "1100", credit: r.amountMinor, profitObjectId: po, memo: "collected" }] });
  await c.query(`insert into ar_payment (receipt_id, entity_id, customer_id, to_account_minor, journal_entry_id) values ($1,$2,$3,$4,$5)`,
    [rc.id, scope.entityId, x.customer_id, r.amountMinor.toString(), je]);
  const tgt = { customerId: x.customer_id, invoiceId: x.invoice_id, contractId: x.contract_id, receiptId: rc.id, locationId: r.locationId, date, journalEntryId: je };
  await ledger(c, scope, { ...tgt, kind: "recovery", amount: r.amountMinor, memo: "reinstated on recovery" });
  await ledger(c, scope, { ...tgt, kind: "payment", amount: -r.amountMinor, memo: `${rc.number}, recovery` });
  await c.query(`update ar_writeoff set recovered_minor = recovered_minor + $2 where id = $1 and entity_id = $3`, [writeoffId, r.amountMinor.toString(), scope.entityId]);
  const rec = await one<{ id: string }>(c, `insert into ar_recovery (entity_id, writeoff_id, receipt_id, amount_minor, journal_entry_id, by_id)
                                             values ($1,$2,$3,$4,$5,$6) returning id`,
    [scope.entityId, writeoffId, rc.id, r.amountMinor.toString(), je, scope.actor.id || null]);
  return { recoveryId: rec.id, receiptId: rc.id, number: rc.number, journalEntryId: je };
}

// =================================================== installment contracts

export type Installment = { seq: number; dueOn: string; paymentMinor: bigint; principalMinor: bigint; interestMinor: bigint };

/**
 * A level-payment schedule. Monthly interest is the balance times APR / 12,
 * rounded to the cent; the payment is rounded up to the cent; the last
 * installment takes whatever principal is left, so the principal always sums
 * to exactly what was financed.
 */
export function amortize(principalMinor: bigint, aprBps: number, termMonths: number, firstDueOn: string): { paymentMinor: bigint; rows: Installment[] } {
  if (principalMinor <= 0n) throw new ArError("the amount financed has to be more than zero");
  if (!(termMonths >= 1 && termMonths <= 120)) throw new ArError("a term is 1 to 120 months");
  if (!(aprBps >= 0 && aprBps <= 9999)) throw new ArError("an APR is 0% to 99.99%");
  const n = BigInt(termMonths);
  let pay: bigint;
  if (aprBps === 0) pay = (principalMinor + n - 1n) / n;
  else {
    const r = aprBps / 120000;
    pay = BigInt(Math.ceil(Number(principalMinor) * r / (1 - Math.pow(1 + r, -termMonths))));
  }
  const rows: Installment[] = [];
  let bal = principalMinor;
  for (let i = 1; i <= termMonths && bal > 0n; i++) {
    const interest = (bal * BigInt(aprBps) + 60000n) / 120000n;
    let princ = pay - interest;
    if (princ < 0n) princ = 0n;
    if (i === termMonths || princ > bal) princ = bal;
    rows.push({ seq: i, dueOn: addMonths(firstDueOn, i - 1), paymentMinor: princ + interest, principalMinor: princ, interestMinor: interest });
    bal -= princ;
  }
  return { paymentMinor: pay, rows };
}

async function contractEvent(c: Client, scope: Scope, contractId: string, kind: string, detail: unknown, reason?: string | null) {
  await c.query(`insert into ar_contract_event (entity_id, contract_id, kind, detail, reason, by_id) values ($1,$2,$3,$4,$5,$6)`,
    [scope.entityId, contractId, kind, JSON.stringify(detail ?? {}), reason ?? null, scope.actor.id || null]);
}

async function writeSchedule(c: Client, scope: Scope, contractId: string, version: number, rows: Installment[]) {
  for (const r of rows) {
    await c.query(`insert into ar_contract_installment (entity_id, contract_id, version, seq, due_on, payment_minor, principal_minor, interest_minor)
                   values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [scope.entityId, contractId, version, r.seq, r.dueOn, r.paymentMinor.toString(), r.principalMinor.toString(), r.interestMinor.toString()]);
  }
}

/**
 * Finance an invoice's open balance in house. The balance moves from the
 * invoice to the contract inside 1100, so nothing posts; interest is income
 * as it is paid.
 */
export async function openContract(c: Client, scope: Scope, k: {
  invoiceId: string; principalMinor?: bigint; aprBps: number; termMonths: number; firstDueOn?: string;
}) {
  const inv = await q<{ id: string; number: string; customer_id: string | null; location_id: string | null; kind: string }>(c,
    `select id, number, customer_id, location_id, kind from customer_invoice where id = $1 and entity_id = $2 for update`, [k.invoiceId, scope.entityId]);
  need(inv.length, "no such invoice");
  need(inv[0].customer_id, "a contract needs a customer");
  need(inv[0].kind === "sale", "only a sale can be put on a contract");
  const open = await openOf(c, scope.entityId, { invoiceId: k.invoiceId });
  const principal = k.principalMinor ?? open;
  need(principal > 0n, `${inv[0].number} has nothing open to finance`);
  need(principal <= open, `${inv[0].number} has ${$(open)} open; a contract cannot finance more than that`);
  const first = k.firstDueOn ?? addMonths(today(), 1);
  need(isDay(first) && first > today(), "the first payment is due after today");
  const sch = amortize(principal, k.aprBps, k.termMonths, first);
  const number = await nextNo(c, scope.entityId, "contract", "IC-");
  const r = await one<{ id: string }>(c, `
    insert into ar_contract (entity_id, number, customer_id, invoice_id, location_id, principal_minor, apr_bps, term_months, payment_minor, first_due_on, opened_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [scope.entityId, number, inv[0].customer_id, k.invoiceId, inv[0].location_id, principal.toString(), k.aprBps, k.termMonths,
     sch.paymentMinor.toString(), first, scope.actor.id || null]);
  await writeSchedule(c, scope, r.id, 1, sch.rows);
  const date = today();
  await ledger(c, scope, { customerId: inv[0].customer_id, invoiceId: k.invoiceId, locationId: inv[0].location_id, date, kind: "contract",
    amount: -principal, memo: `financed on ${number}` });
  await ledger(c, scope, { customerId: inv[0].customer_id, contractId: r.id, locationId: inv[0].location_id, date, kind: "contract",
    amount: principal, memo: `from ${inv[0].number}` });
  await contractEvent(c, scope, r.id, "opened", { principal: principal.toString(), apr: k.aprBps, term: k.termMonths, payment: sch.paymentMinor.toString() });
  return { contractId: r.id, number, paymentMinor: sch.paymentMinor, schedule: sch.rows };
}

async function contractOf(c: Client, entityId: string, id: string, lock = false) {
  const r = await q<{ id: string; number: string; customer_id: string; location_id: string | null; status: string; version: number;
    apr_bps: number; term_months: number; principal_minor: string; payment_minor: string; first_due_on: string }>(c,
    `select id, number, customer_id, location_id, status, version, apr_bps, term_months, principal_minor, payment_minor, first_due_on::text
       from ar_contract where id = $1 and entity_id = $2 ${lock ? "for update" : ""}`, [id, entityId]);
  need(r.length, "no such contract");
  return r[0];
}

async function dueRows(c: Client, entityId: string, contractId: string, version: number) {
  return q<{ id: string; seq: number; due_on: string; principal_minor: string; interest_minor: string; paid_principal_minor: string; paid_interest_minor: string }>(c,
    `select id, seq, due_on::text, principal_minor, interest_minor, paid_principal_minor, paid_interest_minor
       from ar_contract_installment where entity_id = $1 and contract_id = $2 and version = $3 and status = 'due' order by seq`,
    [entityId, contractId, version]);
}

/** What it takes to close the contract today: principal left, interest due, and interest since the last due day. */
export async function payoffQuote(c: Client, entityId: string, contractId: string, asOf = today()) {
  const k = await contractOf(c, entityId, contractId);
  const principal = await openOf(c, entityId, { contractId });
  const rows = await dueRows(c, entityId, contractId, k.version);
  let interestDue = 0n;
  for (const r of rows) if (r.due_on <= asOf) interestDue += B(r.interest_minor) - B(r.paid_interest_minor);
  // Interest runs from the last due day passed (or the opening), on the principal still owed.
  const f = await one<{ d: string }>(c, `
    select greatest(k.opened_at::date, coalesce((select max(i.due_on) from ar_contract_installment i
             where i.entity_id = $1 and i.contract_id = k.id and i.status <> 'superseded' and i.due_on <= $3::date), k.opened_at::date))::text d
      from ar_contract k where k.id = $2 and k.entity_id = $1`, [entityId, contractId, asOf]);
  const from = f.d;
  const days = Math.max(0, daysBetween(from, asOf));
  const accrued = principal > 0n ? (principal * BigInt(k.apr_bps) * BigInt(days) + 1_825_000n) / 3_650_000n : 0n;
  return { contractId, number: k.number, asOf, principalMinor: principal, interestDueMinor: interestDue, accruedMinor: accrued,
    payoffMinor: principal + interestDue + accrued, daysAccrued: days };
}

/**
 * A payment on a contract. Installments that have come due take interest
 * then principal, oldest first; anything more prepays principal on the next
 * ones. A payment that covers the payoff closes the contract.
 */
export async function payContract(c: Client, scope: Scope, contractId: string, p: {
  amountMinor: bigint; method: string; locationId: string; reference?: string | null;
}) {
  const k = await contractOf(c, scope.entityId, contractId, true);
  need(["active", "defaulted"].includes(k.status), `this contract is ${k.status.replace("_", " ")}`);
  need(["cash", "card", "check", "ach", "other", "store_credit"].includes(p.method), "that is not a way of paying a contract");
  const quote = await payoffQuote(c, scope.entityId, contractId);
  need(p.amountMinor > 0n, "the amount has to be more than zero");
  need(p.amountMinor <= quote.payoffMinor, `that is more than the payoff of ${$(quote.payoffMinor)}`);
  const date = today();
  const rows = await dueRows(c, scope.entityId, contractId, k.version);
  let left = p.amountMinor, interest = 0n, principal = 0n;
  const payoff = p.amountMinor === quote.payoffMinor;
  if (payoff) {
    interest = quote.interestDueMinor + quote.accruedMinor;
    principal = quote.principalMinor;
    for (const r of rows) {
      await c.query(`update ar_contract_installment set status = case when due_on <= $3::date then 'paid' else 'superseded' end,
                       paid_principal_minor = case when due_on <= $3::date then principal_minor else paid_principal_minor end,
                       paid_interest_minor = case when due_on <= $3::date then interest_minor else paid_interest_minor end
                     where id = $1 and entity_id = $2`, [r.id, scope.entityId, date]);
    }
    left = 0n;
  } else {
    for (const r of rows) {
      if (left <= 0n) break;
      let pi = B(r.paid_interest_minor), pp = B(r.paid_principal_minor);
      if (r.due_on <= date) {
        const ti = B(r.interest_minor) - pi; const t1 = ti < left ? ti : left; pi += t1; interest += t1; left -= t1;
      }
      const tp = B(r.principal_minor) - pp; const t2 = tp < left ? tp : left; pp += t2; principal += t2; left -= t2;
      const done = pp === B(r.principal_minor) && pi === B(r.interest_minor);
      await c.query(`update ar_contract_installment set paid_interest_minor = $3, paid_principal_minor = $4, status = $5 where id = $1 and entity_id = $2`,
        [r.id, scope.entityId, pi.toString(), pp.toString(), done ? "paid" : "due"]);
    }
    need(left === 0n, "that payment is more than the contract can take; quote the payoff instead");
  }
  const rc = await takeReceipt(c, scope, { customerId: k.customer_id, locationId: p.locationId, method: p.method, amountMinor: p.amountMinor,
    reference: p.reference, channel: "pos" });
  const po = await profitObjectFor(c, scope.entityId, k.location_id ?? p.locationId);
  const je = await post(c, scope, { date, sourceType: "ar", sourceId: rc.id, description: `Contract ${k.number} payment ${rc.number}`,
    lines: [{ code: cashCodeFor(p.method), debit: p.amountMinor, profitObjectId: po },
            { code: "1100", credit: principal, profitObjectId: po, memo: "principal" },
            { code: "4020", credit: interest, profitObjectId: po, memo: "contract interest" }] });
  await c.query(`insert into ar_payment (receipt_id, entity_id, customer_id, to_account_minor, contract_id, interest_minor, journal_entry_id)
                 values ($1,$2,$3,$4,$5,$6,$7)`, [rc.id, scope.entityId, k.customer_id, principal.toString(), contractId, interest.toString(), je]);
  await ledger(c, scope, { customerId: k.customer_id, contractId, receiptId: rc.id, locationId: k.location_id, date, kind: "payment",
    amount: -principal, memo: `${rc.number}: ${$(principal)} principal, ${$(interest)} interest`, journalEntryId: je });
  const leftPrincipal = await openOf(c, scope.entityId, { contractId });
  if (leftPrincipal === 0n) {
    await c.query(`update ar_contract set status = 'paid_off', closed_at = now() where id = $1 and entity_id = $2`, [contractId, scope.entityId]);
  }
  await contractEvent(c, scope, contractId, payoff ? "payoff" : "payment", { receipt: rc.number, principal: principal.toString(), interest: interest.toString() });
  return { receiptId: rc.id, number: rc.number, principalMinor: principal, interestMinor: interest, journalEntryId: je, paidOff: leftPrincipal === 0n };
}

/**
 * Change the terms. Defer pushes every unpaid installment out by some months.
 * Extend re-spreads what is left over a new number of months at the same
 * rate; refinance does the same at a new rate. Interest already due and
 * unpaid is carried into the first new installment, never dropped.
 */
export async function restructure(c: Client, scope: Scope, contractId: string, r: {
  kind: "defer" | "extend" | "refinance"; months?: number; termMonths?: number; aprBps?: number; reason: string;
}) {
  const k = await contractOf(c, scope.entityId, contractId, true);
  need(["active", "defaulted"].includes(k.status), `this contract is ${k.status.replace("_", " ")}`);
  need(r.reason.trim().length >= 5, "changing a contract's terms needs a reason");
  const rows = await dueRows(c, scope.entityId, contractId, k.version);
  need(rows.length, "nothing is left to change on this contract");
  if (r.kind === "defer") {
    const m = r.months ?? 0;
    need(m >= 1 && m <= 12, "a deferral is 1 to 12 months");
    for (const x of rows) {
      await c.query(`update ar_contract_installment set due_on = $3 where id = $1 and entity_id = $2`, [x.id, scope.entityId, addMonths(x.due_on, m)]);
    }
    await contractEvent(c, scope, contractId, "deferred", { months: m }, r.reason);
    return { version: k.version, paymentMinor: B(k.payment_minor), schedule: null };
  }
  const principal = await openOf(c, scope.entityId, { contractId });
  need(principal > 0n, "no principal is left");
  const t = today();
  const carried = rows.filter((x) => x.due_on <= t).reduce((a, x) => a + B(x.interest_minor) - B(x.paid_interest_minor), 0n);
  const apr = r.kind === "refinance" ? (r.aprBps ?? -1) : k.apr_bps;
  need(r.kind !== "refinance" || (apr >= 0 && apr <= 9999), "a refinance needs the new APR");
  const term = r.termMonths ?? 0;
  need(term >= 1 && term <= 120, "say how many months are left after the change (1 to 120)");
  const nextDue = rows.find((x) => x.due_on > t)?.due_on ?? addMonths(t, 1);
  const sch = amortize(principal, apr, term, nextDue);
  if (carried > 0n) { sch.rows[0].interestMinor += carried; sch.rows[0].paymentMinor += carried; }
  const v = k.version + 1;
  await c.query(`update ar_contract_installment set status = 'superseded' where entity_id = $1 and contract_id = $2 and version = $3 and status = 'due'`,
    [scope.entityId, contractId, k.version]);
  await writeSchedule(c, scope, contractId, v, sch.rows);
  await c.query(`update ar_contract set version = $3, apr_bps = $4, term_months = $5, payment_minor = $6 where id = $1 and entity_id = $2`,
    [contractId, scope.entityId, v, apr, term, sch.paymentMinor.toString()]);
  await contractEvent(c, scope, contractId, r.kind === "extend" ? "extended" : "refinanced",
    { version: v, principal: principal.toString(), apr, term, payment: sch.paymentMinor.toString(), carriedInterest: carried.toString() }, r.reason);
  return { version: v, paymentMinor: sch.paymentMinor, schedule: sch.rows };
}

export async function setContractDefault(c: Client, scope: Scope, contractId: string, defaulted: boolean, reason: string) {
  const k = await contractOf(c, scope.entityId, contractId, true);
  need(reason.trim().length >= 5, "say why");
  need(defaulted ? k.status === "active" : k.status === "defaulted", defaulted ? `this contract is ${k.status.replace("_", " ")}` : "this contract is not in default");
  await c.query(`update ar_contract set status = $3 where id = $1 and entity_id = $2`, [contractId, scope.entityId, defaulted ? "defaulted" : "active"]);
  await contractEvent(c, scope, contractId, defaulted ? "defaulted" : "reinstated", {}, reason);
}

/** Goods taken back on a defaulted contract: a record only, no accounting. */
export async function recordRepossession(c: Client, scope: Scope, r: {
  contractId?: string; id?: string; status?: string; items?: string; scheduledOn?: string | null; recoveredOn?: string | null; condition?: string | null; notes?: string | null;
}) {
  const statuses = ["requested", "scheduled", "recovered", "not_recovered", "closed"];
  if (r.status) need(statuses.includes(r.status), "that is not a repossession status");
  if (r.id) {
    const x = await q(c, `select 1 from ar_repossession where id = $1 and entity_id = $2`, [r.id, scope.entityId]);
    need(x.length, "no such repossession record");
    await c.query(`update ar_repossession set status = coalesce($3, status), scheduled_on = coalesce($4, scheduled_on),
                     recovered_on = coalesce($5, recovered_on), condition = coalesce($6, condition), notes = coalesce($7, notes), updated_at = now()
                   where id = $1 and entity_id = $2`,
      [r.id, scope.entityId, r.status ?? null, r.scheduledOn ?? null, r.recoveredOn ?? null, r.condition ?? null, r.notes ?? null]);
    return r.id;
  }
  const k = await contractOf(c, scope.entityId, r.contractId ?? "", false);
  need(k.status === "defaulted" || k.status === "charged_off", "goods are only taken back on a contract in default");
  need(r.items?.trim(), "list what is being taken back");
  const x = await one<{ id: string }>(c, `
    insert into ar_repossession (entity_id, contract_id, status, items, scheduled_on, notes, recorded_by)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [scope.entityId, k.id, r.status ?? "requested", r.items!.trim(), r.scheduledOn ?? null, r.notes ?? null, scope.actor.id || null]);
  return x.id;
}

// ================================================== third-party finance

/** Lenders in the order they are asked, skipping any that already declined this order or whose plans do not fit the amount. */
export async function lenderCascade(c: Client, entityId: string, amountMinor: bigint, orderId: string | null) {
  const cos = await q<{ id: string; name: string; cascade_rank: number; apply_url: string | null }>(c,
    `select id, name, cascade_rank, apply_url from finance_company where entity_id = $1 and status = 'active' order by cascade_rank, name`, [entityId]);
  const plans = await q<{ id: string; company_id: string; code: string; name: string; promo_months: number; fee_bps: number; customer_apr_bps: number | null;
    min_amount_minor: string; max_amount_minor: string | null }>(c,
    `select id, company_id, code, name, promo_months, fee_bps, customer_apr_bps, min_amount_minor, max_amount_minor
       from finance_plan where entity_id = $1 and active order by promo_months desc, fee_bps`, [entityId]);
  const apps = orderId ? await q<{ company_id: string; decision: string }>(c,
    `select company_id, decision from finance_application where entity_id = $1 and sales_order_id = $2`, [entityId, orderId]) : [];
  const out = cos.map((co) => {
    const fit = plans.filter((p) => p.company_id === co.id && B(p.min_amount_minor) <= amountMinor
      && (p.max_amount_minor === null || B(p.max_amount_minor) >= amountMinor));
    const declined = apps.some((a) => a.company_id === co.id && a.decision === "declined");
    const approved = apps.some((a) => a.company_id === co.id && a.decision === "approved");
    return { ...co, plans: fit, declined, approved };
  });
  const next = out.find((x) => !x.declined && x.plans.length) ?? null;
  return { lenders: out, next };
}

export async function recordApplication(c: Client, scope: Scope, a: {
  orderId: string | null; customerId: string; companyId: string; planId?: string | null; requestedMinor: bigint; approvedMinor?: bigint | null;
  decision: "approved" | "declined" | "pending"; reference?: string | null;
}) {
  await customerOf(c, scope.entityId, a.customerId);
  const co = await q(c, `select 1 from finance_company where id = $1 and entity_id = $2`, [a.companyId, scope.entityId]);
  need(co.length, "no such finance company");
  need(["approved", "declined", "pending"].includes(a.decision), "the lender approved, declined, or has not answered yet");
  need(a.requestedMinor > 0n, "say how much was asked for");
  const r = await one<{ id: string }>(c, `
    insert into finance_application (entity_id, sales_order_id, customer_id, company_id, plan_id, requested_minor, approved_minor, decision, reference, by_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [scope.entityId, a.orderId, a.customerId, a.companyId, a.planId ?? null, a.requestedMinor.toString(), a.approvedMinor?.toString() ?? null,
     a.decision, a.reference ?? null, scope.actor.id || null]);
  return r.id;
}

/** A sale paid by a finance company: the 'financing' receipt (Dr 1110) now names who owes it and on what plan. */
export async function recordFinancedSale(c: Client, scope: Scope, receiptId: string, planId: string) {
  const r = await q<{ method: string; amount_minor: string; voided_at: string | null; customer_id: string | null; sales_order_id: string | null }>(c,
    `select method, amount_minor, voided_at, customer_id, sales_order_id from customer_receipt where id = $1 and entity_id = $2`, [receiptId, scope.entityId]);
  need(r.length, "no such receipt");
  need(r[0].method === "financing", "only a receipt taken as financing is owed by a finance company");
  need(!r[0].voided_at, "that receipt is voided");
  const amt = B(r[0].amount_minor);
  need(amt > 0n, "a financing refund is settled with the lender, not recorded as a sale");
  const p = await q<{ company_id: string; fee_bps: number; min_amount_minor: string; max_amount_minor: string | null; active: boolean; name: string }>(c,
    `select company_id, fee_bps, min_amount_minor, max_amount_minor, active, name from finance_plan where id = $1 and entity_id = $2`, [planId, scope.entityId]);
  need(p.length && p[0].active, "no such finance plan");
  need(amt >= B(p[0].min_amount_minor) && (p[0].max_amount_minor === null || amt <= B(p[0].max_amount_minor)),
    `${$(amt)} is outside what the ${p[0].name} plan takes`);
  const fee = mulBps(amt, p[0].fee_bps);
  const x = await one<{ id: string }>(c, `
    insert into financed_sale (entity_id, receipt_id, company_id, plan_id, customer_id, sales_order_id, amount_minor, fee_bps, expected_fee_minor)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [scope.entityId, receiptId, p[0].company_id, planId, r[0].customer_id, r[0].sales_order_id, amt.toString(), p[0].fee_bps, fee.toString()]);
  return { financedSaleId: x.id, expectedFeeMinor: fee };
}

/**
 * The lender's deposit for a batch of sales. What they sent against what the
 * sales add up to: the difference is their fee, posted to 6910, and compared
 * with the fee the plans say they should take.
 */
export async function settleFinanceBatch(c: Client, scope: Scope, s: {
  companyId: string; saleIds: string[]; fundedMinor: bigint; reference: string; fundedOn?: string;
}) {
  need(s.saleIds.length, "pick the sales this deposit pays for");
  need(s.reference.trim(), "put the lender's batch or deposit reference in");
  const on = s.fundedOn ?? today();
  need(isDay(on) && on <= today(), "the funding date is today or earlier");
  const sales = await q<{ id: string; amount_minor: string; expected_fee_minor: string; status: string; company_id: string }>(c,
    `select id, amount_minor, expected_fee_minor, status, company_id from financed_sale where entity_id = $1 and id = any($2) for update`,
    [scope.entityId, s.saleIds]);
  need(sales.length === new Set(s.saleIds).size, "one of those sales is not on file");
  need(sales.every((x) => x.company_id === s.companyId), "every sale in a batch is owed by the same finance company");
  need(sales.every((x) => x.status === "awaiting_funding"), "one of those sales is already funded");
  const gross = sales.reduce((a, x) => a + B(x.amount_minor), 0n);
  const expected = sales.reduce((a, x) => a + B(x.expected_fee_minor), 0n);
  need(s.fundedMinor > 0n, "say how much the lender sent");
  need(s.fundedMinor <= gross, `the lender sent ${$(s.fundedMinor)}, more than the ${$(gross)} of sales picked; check the batch`);
  const fee = gross - s.fundedMinor;
  const co = await one<{ name: string }>(c, `select name from finance_company where id = $1 and entity_id = $2`, [s.companyId, scope.entityId]);
  const st = await one<{ id: string }>(c, `
    insert into finance_settlement (entity_id, company_id, reference, funded_on, gross_minor, expected_fee_minor, funded_minor, fee_minor, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [scope.entityId, s.companyId, s.reference.trim(), on, gross.toString(), expected.toString(), s.fundedMinor.toString(), fee.toString(), scope.actor.id || null]);
  const je = await post(c, scope, { date: on, sourceType: "finance", sourceId: st.id, description: `${co.name} funding ${s.reference.trim()}`,
    lines: [{ code: "1050", debit: s.fundedMinor }, { code: "6910", debit: fee, memo: "lender's fee" }, { code: "1110", credit: gross }] });
  await c.query(`update finance_settlement set journal_entry_id = $2 where id = $1 and entity_id = $3`, [st.id, je, scope.entityId]);
  await c.query(`update financed_sale set status = 'funded', settlement_id = $2 where entity_id = $3 and id = any($1)`, [s.saleIds, st.id, scope.entityId]);
  return { settlementId: st.id, journalEntryId: je, grossMinor: gross, fundedMinor: s.fundedMinor, feeMinor: fee, expectedFeeMinor: expected,
    varianceMinor: fee - expected };
}

// ================================================= deposits liability

/**
 * Every deposit held, by order (and money taken with no order that is not a
 * payment on account), against GL 2300. A difference is a receipt that was
 * taken and never posted, or a posting that did not come from a receipt.
 */
export async function depositLiability(c: Client, entityId: string) {
  const orders = await q<{ sales_order_id: string; number: string; customer: string | null; location: string; status: string; paid_minor: string; applied_minor: string }>(c, `
    select so.id sales_order_id, so.number, cu.name customer, lo.name location, so.status, so.paid_minor,
           coalesce((select sum(i.deposit_applied_minor) from customer_invoice i where i.entity_id = $1 and i.sales_order_id = so.id), 0)::text applied_minor
      from sales_order so join location lo on lo.id = so.location_id left join customer cu on cu.id = so.customer_id
     where so.entity_id = $1
       and so.paid_minor <> coalesce((select sum(i.deposit_applied_minor) from customer_invoice i where i.entity_id = $1 and i.sales_order_id = so.id), 0)
     order by so.ordered_at`, [entityId]);
  const loose = await q<{ id: string; number: string; customer: string | null; amount_minor: string; received_at: string }>(c, `
    select r.id, r.number, cu.name customer, r.amount_minor, r.received_at::date::text received_at
      from customer_receipt r left join customer cu on cu.id = r.customer_id
     where r.entity_id = $1 and r.sales_order_id is null and r.voided_at is null
       and not exists (select 1 from ar_payment p where p.receipt_id = r.id)`, [entityId]);
  const unposted = await q<{ id: string; number: string; amount_minor: string; received_at: string }>(c, `
    select r.id, r.number, r.amount_minor, r.received_at::date::text received_at
      from customer_receipt r
     where r.entity_id = $1 and r.voided_at is null
       and not exists (select 1 from ar_payment p where p.receipt_id = r.id)
       and not exists (select 1 from journal_entry je where je.entity_id = $1 and je.source_id = r.id and je.source_type in ('receipt','refund'))`, [entityId]);
  const rows = orders.map((o) => ({ ...o, held_minor: (B(o.paid_minor) - B(o.applied_minor)).toString() }));
  const total = rows.reduce((a, o) => a + B(o.held_minor), 0n) + loose.reduce((a, r) => a + B(r.amount_minor), 0n);
  const gl = -(await glBalance(c, entityId, "2300"));
  return { orders: rows, unassigned: loose, unposted, totalMinor: total, glMinor: gl, differenceMinor: total - gl };
}
