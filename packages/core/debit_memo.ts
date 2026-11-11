// Vendor debit memos: documents on a vendor's account that reduce what we
// owe them.
//
// A memo carries its value in 1150 (vendor chargebacks receivable) from the
// day it opens: a service chargeback already posted Dr 1150 in the service
// module, and that journal entry is the memo's; a manual memo (damaged on
// receipt, a price difference, short shipped) posts Dr 1150 Cr its offset
// account when a second person approves it.
//
// Applying a memo to an approved bill posts Dr 2010 Cr 1150 and lowers what
// the payment run pays on that bill. A memo not yet used stays an open
// credit on the vendor's statement until it is. The bill itself -- its
// lines, its PO and receipt, the three-way match -- is never changed.

import { today as bizToday } from "./clock.ts";
import { q, one, audit, type Client, type Scope } from "./db.ts";
import { post } from "./posting.ts";
import { transition } from "./invoice.ts";

export class MemoError extends Error {}
function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new MemoError(message);
}
const UUIDRX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUIDRX.test(v);
const usd = (m: bigint) => `$${(Number(m) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const SOURCES = ["service_chargeback", "damaged_on_receipt", "price_difference", "short_shipped", "other"];
const MANUAL = SOURCES.filter((s) => s !== "service_chargeback");
/** Where the 1150 debit is offset, by reason, when the person does not say. */
const DEFAULT_OFFSET: Record<string, string> = { damaged_on_receipt: "5000", price_difference: "5000", short_shipped: "5000" };
const NOT_OFFSETS = ["1150", "2010", "1000", "1010", "1100"];

async function nextNo(c: Client, entityId: string) {
  return (await one<{ n: string }>(c, `select next_doc_no($1, 'debit_memo', 'DM-') n /* unscoped: numbering takes the entity */`, [entityId])).n;
}

async function vendorOf(c: Client, entityId: string, vendorId: string) {
  need(isId(vendorId), "pick the vendor");
  const r = await q<{ id: string; name: string }>(c, `
    select v.id, coalesce(v.dba, v.legal_name) name from vendor v
     where v.id = $2 and (exists (select 1 from vendor_entity ve where ve.vendor_id = v.id and ve.entity_id = $1)
                          or exists (select 1 from vendor_debit_memo m where m.vendor_id = v.id and m.entity_id = $1))`, [entityId, vendorId]);
  need(r.length, "that vendor does not work with this company");
  return r[0];
}

type MemoRow = { id: string; number: string; vendor_id: string; status: string; amount_minor: string; created_by: string | null; source: string;
  offset_code: string; journal_entry_id: string | null; memo_date: string; reason: string };

async function memoOf(c: Client, entityId: string, id: string): Promise<MemoRow> {
  need(isId(id), "no such debit memo");
  const r = await q<MemoRow>(c, `select id, number, vendor_id, status, amount_minor, created_by, source, offset_code, journal_entry_id, memo_date::text memo_date, reason
                                   from vendor_debit_memo where entity_id = $1 and id = $2 for update`, [entityId, id]);
  need(r.length, "no such debit memo");
  return r[0];
}

/** A memo's value still to use. */
export async function memoLeft(c: Client, entityId: string, memoId: string): Promise<bigint> {
  const r = await one<{ left: string }>(c, `
    select (m.amount_minor - coalesce((select sum(a.amount_minor) from vendor_memo_application a where a.memo_id = m.id and a.entity_id = $1),0))::text "left"
      from vendor_debit_memo m where m.entity_id = $1 and m.id = $2`, [entityId, memoId]);
  return BigInt(r.left);
}

/** What a bill still needs paid once memos are applied (payments made are the payment run's business). */
export async function billNet(c: Client, entityId: string, invoiceId: string): Promise<bigint> {
  const r = await one<{ net: string }>(c, `
    select (i.total_minor - coalesce((select sum(a.amount_minor) from vendor_memo_application a where a.invoice_id = i.id and a.entity_id = $1),0))::text net
      from invoice i where i.entity_id = $1 and i.id = $2`, [entityId, invoiceId]);
  return BigInt(r.net);
}

/** Below this a chargeback memo opens by itself (default $0: every one waits for a second person). */
export async function settings(c: Client, entityId: string) {
  const r = await q<{ v: string }>(c, `select memo_auto_approve_below_minor::text v from payables_setting where entity_id = $1`, [entityId]);
  return { autoApproveBelowMinor: BigInt(r[0]?.v ?? "0") };
}
export async function saveSettings(c: Client, scope: Scope, autoApproveBelowMinor: bigint) {
  need(autoApproveBelowMinor >= 0n, "the amount is not negative");
  await c.query(`insert into payables_setting (entity_id, memo_auto_approve_below_minor, set_by) values ($1,$2,$3)
                 on conflict (entity_id) do update set memo_auto_approve_below_minor = $2, set_by = $3, set_at = now()`,
    [scope.entityId, autoApproveBelowMinor.toString(), scope.actor.id || null]);
  return settings(c, scope.entityId);
}

/** Where a service chargeback goes when the vendor will not carry it: the company's own service expense. */
const SERVICE_EXPENSE = "6150";

/**
 * The service module charged a cost back to the vendor (already posted Dr 1150).
 * That posting becomes a debit memo on the vendor's account, one per cost. The
 * person who entered the cost is its maker: another person approves it, unless
 * it is under the company's auto-approve amount (default $0, so never).
 */
export async function fromChargeback(c: Client, scope: Scope, x: { vendorId: string; serviceCostId: string; ticketId: string; ticketNumber: string;
  amountMinor: bigint; journalEntryId: string; offsetCode: string; what: string }) {
  const v = await q(c, `select 1 from vendor where id = $1 and tenant_id = $2 /* unscoped: vendors are the client's, shared by its companies */`, [x.vendorId, scope.tenantId]);
  need(v.length, "the ticket's vendor is not one of this client's");
  const number = await nextNo(c, scope.entityId);
  const auto = x.amountMinor < (await settings(c, scope.entityId)).autoApproveBelowMinor;
  const r = await one<{ id: string }>(c, `
    insert into vendor_debit_memo (tenant_id, entity_id, vendor_id, number, source, reason, amount_minor, offset_code, memo_date, status,
                                   service_cost_id, service_ticket_id, journal_entry_id, created_by, auto_approved)
    values ($1,$2,$3,$4,'service_chargeback',$5,$6,$7,$8,$13,$9,$10,$11,$12,$14) returning id`,
    [scope.tenantId, scope.entityId, x.vendorId, number, `Service ${x.ticketNumber}: ${x.what}`.slice(0, 300), x.amountMinor.toString(), x.offsetCode,
     (await bizToday(c, scope)), x.serviceCostId, x.ticketId, x.journalEntryId, scope.actor.id || null, auto ? "open" : "pending_approval", auto]);
  await audit(c, scope, { table: "vendor_debit_memo", rowId: r.id, action: "insert",
    after: { number, source: "service_chargeback", amount: x.amountMinor.toString(), status: auto ? "open (under the auto-approve amount)" : "pending_approval" } });
  return { id: r.id, number, status: auto ? "open" : "pending_approval" };
}

/** A memo written by hand. It waits for a second person's approval before it counts. */
export async function createMemo(c: Client, scope: Scope, b: { vendorId: string; source: string; reason: string; amountMinor: bigint; offsetCode?: string;
  invoiceId?: string | null; purchaseOrderId?: string | null; vendorRef?: string; memoDate?: string }) {
  const v = await vendorOf(c, scope.entityId, b.vendorId);
  need(MANUAL.includes(b.source), "a debit memo written by hand is for damage on receipt, a price difference, a short shipment, or other");
  need(String(b.reason ?? "").trim().length >= 3, "say what the memo is for");
  need(b.amountMinor > 0n, "a debit memo is for more than zero");
  const offset = String(b.offsetCode ?? "").trim() || DEFAULT_OFFSET[b.source] || "";
  need(offset, "pick the account the credit comes off (for 'other' there is no default)");
  need(!NOT_OFFSETS.includes(offset), `${offset} cannot be the offset of a debit memo`);
  const acct = await q(c, `select 1 from gl_account where tenant_id = $1 and code = $2 /* unscoped: chart is tenant-wide */`, [scope.tenantId, offset]);
  need(acct.length, `the chart of accounts has no account ${offset}`);
  if (b.invoiceId) {
    need(isId(b.invoiceId), "no such bill");
    const i = await q<{ vendor_id: string }>(c, `select vendor_id from invoice where entity_id = $1 and id = $2`, [scope.entityId, b.invoiceId]);
    need(i.length, "no such bill");
    need(i[0].vendor_id === b.vendorId, "that bill is from another vendor");
  }
  if (b.purchaseOrderId) {
    need(isId(b.purchaseOrderId), "no such purchase order");
    const p = await q<{ vendor_id: string }>(c, `select vendor_id from purchase_order where entity_id = $1 and id = $2`, [scope.entityId, b.purchaseOrderId]);
    need(p.length && p[0].vendor_id === b.vendorId, "that purchase order is not this vendor's");
  }
  const date = b.memoDate && /^\d{4}-\d{2}-\d{2}$/.test(b.memoDate) ? b.memoDate : (await bizToday(c, scope));
  const number = await nextNo(c, scope.entityId);
  const r = await one<{ id: string }>(c, `
    insert into vendor_debit_memo (tenant_id, entity_id, vendor_id, number, source, reason, amount_minor, offset_code, memo_date, invoice_id,
                                   purchase_order_id, vendor_ref, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,nullif($12,''),$13) returning id`,
    [scope.tenantId, scope.entityId, b.vendorId, number, b.source, String(b.reason).trim().slice(0, 300), b.amountMinor.toString(), offset, date,
     b.invoiceId || null, b.purchaseOrderId || null, String(b.vendorRef ?? "").trim().slice(0, 60), scope.actor.id || null]);
  await audit(c, scope, { table: "vendor_debit_memo", rowId: r.id, action: "insert", after: { number, source: b.source, amount: b.amountMinor.toString(), vendor: v.name } });
  return { id: r.id, number, status: "pending_approval" };
}

/**
 * A second person approves a memo. A manual memo posts Dr 1150 Cr its offset;
 * a chargeback memo is already posted (the service cost), so it just opens.
 */
export async function approveMemo(c: Client, scope: Scope, id: string, note = "") {
  const m = await memoOf(c, scope.entityId, id);
  need(m.status === "pending_approval", `debit memo ${m.number} is ${m.status.replace("_", " ")}`);
  need(m.created_by !== scope.actor.id, "whoever wrote a debit memo cannot approve it; another person does");
  if (m.source === "service_chargeback" && m.journal_entry_id) {
    await c.query(`update vendor_debit_memo set status = 'open', decided_by = $3, decided_at = now(), decision_note = nullif($4,'')
                    where entity_id = $1 and id = $2`, [scope.entityId, id, scope.actor.id || null, note.trim().slice(0, 300)]);
    await audit(c, scope, { table: "vendor_debit_memo", rowId: id, action: "transition", before: { status: m.status }, after: { status: "open" } });
    return { status: "open", journalEntryId: m.journal_entry_id };
  }
  const v = await vendorOf(c, scope.entityId, m.vendor_id);
  const amt = BigInt(m.amount_minor);
  const je = await post(c, scope, { date: m.memo_date, sourceType: "invoice", sourceId: m.id,
    description: `Debit memo ${m.number} to ${v.name}: ${m.reason}`.slice(0, 300),
    lines: [{ code: "1150", debit: amt, memo: m.number }, { code: m.offset_code, credit: amt, memo: m.number }] });
  await c.query(`update vendor_debit_memo set status = 'open', journal_entry_id = $3, decided_by = $4, decided_at = now(), decision_note = nullif($5,'')
                  where entity_id = $1 and id = $2`, [scope.entityId, id, je, scope.actor.id || null, note.trim().slice(0, 300)]);
  await audit(c, scope, { table: "vendor_debit_memo", rowId: id, action: "transition", before: { status: m.status }, after: { status: "open", journalEntryId: je } });
  return { status: "open", journalEntryId: je };
}

export async function rejectMemo(c: Client, scope: Scope, id: string, note: string) {
  const m = await memoOf(c, scope.entityId, id);
  need(m.status === "pending_approval", `debit memo ${m.number} is ${m.status.replace("_", " ")}`);
  need(m.created_by !== scope.actor.id, "whoever wrote a debit memo cannot decide it");
  need(String(note ?? "").trim().length >= 3, "say why it is turned down");
  // a chargeback was already moved to 1150 by the service cost: turned down, the company carries it (Dr 6150 Cr 1150)
  let rev: string | null = null;
  if (m.source === "service_chargeback" && m.journal_entry_id) {
    rev = await post(c, scope, { date: (await bizToday(c, scope)), sourceType: "invoice", sourceId: m.id, description: `Debit memo ${m.number} turned down: ${note.trim()}`.slice(0, 300),
      lines: [{ code: SERVICE_EXPENSE, debit: BigInt(m.amount_minor), memo: m.number }, { code: "1150", credit: BigInt(m.amount_minor), memo: m.number }] });
  }
  await c.query(`update vendor_debit_memo set status = 'rejected', decided_by = $3, decided_at = now(), decision_note = $4, reversal_entry_id = $5 where entity_id = $1 and id = $2`,
    [scope.entityId, id, scope.actor.id || null, note.trim().slice(0, 300), rev]);
  return { status: "rejected", journalEntryId: rev };
}

/**
 * Void an open memo nothing has been applied from: the 1150 debit is reversed.
 * A manual memo reverses to its offset. A service chargeback does not go back to
 * where the cost came from (stock, labour applied, the accrual): the cost is
 * real and the vendor will not carry it, so it lands in service expense (6150).
 */
export async function voidMemo(c: Client, scope: Scope, id: string, reason: string) {
  const m = await memoOf(c, scope.entityId, id);
  need(m.status === "open", `debit memo ${m.number} is ${m.status.replace("_", " ")}; only an open memo is voided`);
  need(String(reason ?? "").trim().length >= 3, "say why it is voided");
  const left = await memoLeft(c, scope.entityId, id);
  need(left === BigInt(m.amount_minor), `debit memo ${m.number} has already been applied to a bill; it cannot be voided`);
  const back = m.source === "service_chargeback" ? SERVICE_EXPENSE : m.offset_code;
  const je = await post(c, scope, { date: (await bizToday(c, scope)), sourceType: "invoice", sourceId: m.id, description: `Void debit memo ${m.number}: ${reason.trim()}`.slice(0, 300),
    lines: [{ code: back, debit: left, memo: m.number }, { code: "1150", credit: left, memo: m.number }] });
  await c.query(`update vendor_debit_memo set status = 'void', void_reason = $3, reversal_entry_id = $4 where entity_id = $1 and id = $2`, [scope.entityId, id, reason.trim().slice(0, 300), je]);
  await audit(c, scope, { table: "vendor_debit_memo", rowId: id, action: "transition", before: { status: "open" }, after: { status: "void", journalEntryId: je }, reason });
  return { status: "void", journalEntryId: je };
}

/**
 * Use an open memo against one of the vendor's approved bills: Dr 2010 Cr 1150.
 * The bill's lines and match are untouched; what the payment run pays on it
 * goes down. A bill brought to zero is settled (paid) by the memo.
 */
export async function applyMemo(c: Client, scope: Scope, id: string, invoiceId: string, amountMinor?: bigint | null) {
  const m = await memoOf(c, scope.entityId, id);
  need(m.status === "open", `debit memo ${m.number} is ${m.status.replace("_", " ")}; only an open memo is applied`);
  need(isId(invoiceId), "pick the bill");
  const inv = await q<{ id: string; vendor_id: string; status: string; reference: string | null; ic_document_id: string | null }>(c, `
    select id, vendor_id, status, reference, ic_document_id from invoice where entity_id = $1 and id = $2 for update`, [scope.entityId, invoiceId]);
  need(inv.length, "no such bill");
  const i = inv[0];
  need(i.vendor_id === m.vendor_id, `debit memo ${m.number} is for another vendor`);
  need(!i.ic_document_id, "a bill from one of the client's own companies is settled in Group");
  need(i.status === "approved", i.status === "paid" ? "that bill is already paid" : `that bill is ${i.status}; a memo is applied to an approved bill (it is on the books)`);
  const run = await q<{ status: string }>(c, `select pr.status from payment p join payment_run pr on pr.id = p.payment_run_id
     where p.invoice_id = $1 and pr.entity_id = $2 and pr.status in ('building','pending_release')`, [invoiceId, scope.entityId]);
  need(!run.length, "that bill is in a payment run being built; cancel or release the run first");
  const left = await memoLeft(c, scope.entityId, id);
  const open = await billNet(c, scope.entityId, invoiceId);
  const amt = amountMinor && amountMinor > 0n ? amountMinor : (left < open ? left : open);
  need(amt > 0n, open <= 0n ? "that bill has nothing left to pay" : `debit memo ${m.number} has nothing left to apply`);
  need(amt <= left, `debit memo ${m.number} has ${usd(left)} left, not ${usd(amt)}`);
  need(amt <= open, `that bill has ${usd(open)} left to pay, not ${usd(amt)}`);
  const je = await post(c, scope, { date: (await bizToday(c, scope)), sourceType: "invoice", sourceId: invoiceId,
    description: `Debit memo ${m.number} applied to bill ${i.reference ?? invoiceId.slice(0, 8)}`.slice(0, 300),
    lines: [{ code: "2010", debit: amt, memo: m.number }, { code: "1150", credit: amt, memo: m.number }] });
  await c.query(`insert into vendor_memo_application (entity_id, memo_id, invoice_id, amount_minor, journal_entry_id, applied_by) values ($1,$2,$3,$4,$5,$6)`,
    [scope.entityId, id, invoiceId, amt.toString(), je, scope.actor.id || null]);
  if (amt === left) await c.query(`update vendor_debit_memo set status = 'applied' where entity_id = $1 and id = $2`, [scope.entityId, id]);
  let settled = false;
  if (amt === open) {
    await transition(c, scope, invoiceId, "scheduled", `settled by debit memo ${m.number}`);
    await transition(c, scope, invoiceId, "paid", `paid in full by debit memo ${m.number}`);
    settled = true;
  }
  await audit(c, scope, { table: "vendor_debit_memo", rowId: id, action: "update", after: { applied: amt.toString(), invoiceId, journalEntryId: je } });
  return { appliedMinor: amt, memoLeftMinor: left - amt, billLeftMinor: open - amt, billSettled: settled, journalEntryId: je };
}

// ---------------------------------------------------------------- views --

export async function memos(c: Client, entityId: string, f: { vendorId?: string | null; status?: string | null } = {}) {
  return q(c, `
    select m.id, m.number, m.vendor_id, coalesce(v.dba, v.legal_name) vendor, m.source, m.reason, m.amount_minor::text amount_minor,
           (m.amount_minor - coalesce(a.used,0))::text left_minor, m.status, m.memo_date::text memo_date, m.vendor_ref, m.offset_code,
           st.number ticket_number, i.reference bill_reference, cu.name created_by_name, du.name decided_by_name, m.decision_note, m.created_by
      from vendor_debit_memo m join vendor v on v.id = m.vendor_id
      left join (select memo_id, sum(amount_minor) used from vendor_memo_application where entity_id = $1 group by memo_id) a on a.memo_id = m.id
      left join service_ticket st on st.id = m.service_ticket_id left join invoice i on i.id = m.invoice_id
      left join app_user cu on cu.id = m.created_by left join app_user du on du.id = m.decided_by
     where m.entity_id = $1 and ($2::uuid is null or m.vendor_id = $2) and ($3::text is null or m.status = $3)
     order by m.memo_date desc, m.number desc limit 300`, [entityId, f.vendorId ?? null, f.status ?? null]);
}

export async function memo(c: Client, entityId: string, id: string) {
  need(isId(id), "no such debit memo");
  const m = (await memos(c, entityId)).find((x) => x.id === id);
  need(m, "no such debit memo");
  const apps = await q(c, `select a.id, a.amount_minor::text amount_minor, a.applied_at::text applied_at, i.reference bill_reference, i.id invoice_id, u.name applied_by
                             from vendor_memo_application a join invoice i on i.id = a.invoice_id left join app_user u on u.id = a.applied_by
                            where a.entity_id = $1 and a.memo_id = $2 order by a.applied_at`, [entityId, id]);
  return { ...m, applications: apps };
}

/** Bills the vendor's open memos could go against: approved, on the books, not in a run being built. */
export async function openBills(c: Client, entityId: string, vendorId: string) {
  return q(c, `
    select i.id, i.reference, i.invoice_date::text invoice_date, i.due_date::text due_date, i.total_minor::text total_minor,
           (i.total_minor - coalesce((select sum(a.amount_minor) from vendor_memo_application a where a.invoice_id = i.id and a.entity_id = $1),0))::text open_minor
      from invoice i
     where i.entity_id = $1 and i.vendor_id = $2 and i.status = 'approved' and i.ic_document_id is null
       and not exists (select 1 from payment p join payment_run pr on pr.id = p.payment_run_id
                        where p.invoice_id = i.id and pr.status in ('building','pending_release','released','settled'))
     order by i.due_date nulls last, i.invoice_date`, [entityId, vendorId]);
}

/** The vendor's account: bills, payments, memos and what is applied, with what we owe net of open credits. */
export async function statement(c: Client, entityId: string, vendorId: string) {
  const v = await vendorOf(c, entityId, vendorId);
  const bills = await q<{ id: string; reference: string | null; invoice_date: string; status: string; total_minor: string; credited_minor: string; paid_minor: string }>(c, `
    select i.id, i.reference, i.invoice_date::text invoice_date, i.status, i.total_minor::text total_minor,
           coalesce((select sum(a.amount_minor) from vendor_memo_application a where a.invoice_id = i.id and a.entity_id = $1),0)::text credited_minor,
           coalesce((select sum(p.amount_minor) from payment p join payment_run pr on pr.id = p.payment_run_id
                      where p.invoice_id = i.id and pr.entity_id = $1 and pr.status in ('released','settled') and p.status in ('sent','cleared')),0)::text paid_minor
      from invoice i
     where i.entity_id = $1 and i.vendor_id = $2 and i.status in ('approved','scheduled','paid')
     order by i.invoice_date, i.reference`, [entityId, vendorId]);
  const ms = await memos(c, entityId, { vendorId });
  const owed = bills.reduce((a, b) => a + (BigInt(b.total_minor) - BigInt(b.credited_minor) - BigInt(b.paid_minor)), 0n);
  const credits = ms.filter((m) => m.status === "open").reduce((a, m) => a + BigInt(String(m.left_minor)), 0n);
  const lines = [
    ...bills.map((b) => ({ date: b.invoice_date, kind: "bill", ref: b.reference, amountMinor: b.total_minor, status: b.status, id: b.id })),
    ...ms.filter((m) => ["open", "applied", "void"].includes(String(m.status))).map((m) => ({ date: m.memo_date, kind: "debit_memo", ref: m.number,
      amountMinor: (-BigInt(String(m.amount_minor))).toString(), status: m.status, id: m.id })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { vendor: v, bills, memos: ms, lines,
    totals: { owedOnBillsMinor: owed.toString(), openCreditsMinor: credits.toString(), netOwedMinor: (owed - credits).toString() } };
}
