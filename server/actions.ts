// What a person can do from the screens, each through the same engine the
// tests exercise. Nothing here relaxes a rule: the maker is still never the
// checker, nothing posts before it is approved, a payment run is built by one
// person and released by another, and every change leaves an audit row with
// the name of whoever did it.
//
// Payment runs live here because the engine had none yet. They follow the
// same pattern as payroll: build, send for approval, release by someone else,
// post on release.

import { type Client, type Scope, q, one, audit } from "../packages/core/db.ts";
import { decide, openRequest } from "../packages/core/approvals.ts";
import { runGates, postToLedger, transition } from "../packages/core/invoice.ts";
import { buildRun, requestRelease, release, postRun, IllustrativeTaxProvider } from "../packages/core/payroll.ts";
import { planSweeps, confirmTransfer, resolveDisbursementAccount } from "../packages/core/banking.ts";
import { autoMatch, matchManually } from "../packages/core/reconcile.ts";
import { fromDecimal } from "../packages/core/money.ts";
import { type Company, explainReason } from "./views.ts";

/** A refusal a person can act on. The server turns it into a 409 with the message. */
export class ActionError extends Error {}

export type Actor = { personId: string; personName: string; label: string };

export const scopeOf = (co: Company, a: Actor, kind: "user" | "agent" | "system" = "user"): Scope => ({
  tenantId: co.tenantId,
  entityId: co.id,
  actor: { kind, id: a.personId, label: a.label },
});

const today = () => new Date().toISOString().slice(0, 10);
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const need = (cond: unknown, msg: string): void => { if (!cond) throw new ActionError(msg); };
const text = (v: unknown, max = 500) => String(v ?? "").trim().slice(0, max);

function money(v: unknown): bigint {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  need(/^\d+(\.\d{1,2})?$/.test(s), "enter the amount in dollars and cents, like 1284.55");
  const m = fromDecimal(s);
  need(m > 0n, "the amount has to be more than zero");
  need(m < 100_000_000_00n, "that amount is too large to be a bill");
  return m;
}

// ---------------------------------------------------------------- approvals

/**
 * Decide the next step, then carry the subject forward: an approved bill is
 * approved and posted, a rejected one is rejected; a rejected payroll or
 * payment run is cancelled so it can be rebuilt.
 */
export async function decideRequest(c: Client, co: Company, a: Actor, input: { requestId: unknown; decision: unknown; note: unknown }) {
  need(typeof input.requestId === "string" && UUID.test(input.requestId), "no such request");
  const decision = input.decision === "approved" ? "approved" : input.decision === "rejected" ? "rejected" : null;
  need(decision, "decide approved or rejected");
  const note = text(input.note);
  need(decision === "approved" || note, "say why it is rejected, so the maker knows what to fix");

  const req = await q<{ subject_type: string; subject_id: string }>(c, `
    select subject_type, subject_id from approval_request where id = $1 and entity_id = $2`, [input.requestId, co.id]);
  need(req.length, "no such request");
  const s = scopeOf(co, a);
  const status = await decide(c, s, { requestId: input.requestId as string, actorId: a.personId, decision: decision!, note: note || undefined });
  const { subject_type: type, subject_id: id } = req[0];

  if (status === "approved") {
    if (type === "invoice") {
      await transition(c, s, id, "approved", "approval complete");
      await postToLedger(c, s, id);
    }
    if (type === "vendor") {
      await q(c, `update vendor set status = 'active' where id = $1 and tenant_id = $2 /* unscoped: vendors are shared across the client's companies */`, [id, co.tenantId]);
      await q(c, `update vendor_entity set status = 'active' where vendor_id = $1 and entity_id = $2`, [id, co.id]);
    }
  }
  if (status === "rejected") {
    if (type === "invoice") await transition(c, s, id, "rejected", note || "rejected at approval");
    if (type === "payroll_run") {
      await q(c, `update payroll_run set status = 'cancelled' where id = $1 and entity_id = $2`, [id, co.id]);
      await q(c, `update pay_period set status = 'timecards_approved'
                   where id = (select pay_period_id from payroll_run where id = $1 and entity_id = $2)`, [id, co.id]);
    }
    if (type === "payment_run") {
      await q(c, `update payment_run set status = 'cancelled' where id = $1 and entity_id = $2`, [id, co.id]);
      await q(c, `update payment set status = 'voided'
                   where payment_run_id = (select id from payment_run where id = $1 and entity_id = $2)`, [id, co.id]);
    }
    if (type === "vendor") {
      await q(c, `update vendor_entity set status = 'inactive' where vendor_id = $1 and entity_id = $2`, [id, co.id]);
    }
  }
  return { status, subjectType: type, subjectId: id };
}

// ---------------------------------------------------------------- payables

export async function newBill(c: Client, co: Company, a: Actor, input: Record<string, unknown>) {
  need(typeof input.vendorId === "string" && UUID.test(input.vendorId), "pick the vendor");
  need(typeof input.glAccountId === "string" && UUID.test(input.glAccountId), "pick the account it is coded to");
  const reference = text(input.reference, 60);
  need(reference, "enter the bill number");
  need(isDay(input.invoiceDate), "enter the bill date");
  const total = money(input.amount);
  const store = typeof input.storeId === "string" && UUID.test(input.storeId) ? input.storeId : null;
  const description = text(input.description, 200) || null;

  const ve = await q<{ terms_days: number }>(c, `
    select terms_days from vendor_entity where vendor_id = $1 and entity_id = $2 and status = 'active'`, [input.vendorId, co.id]);
  need(ve.length, "that vendor is not set up for this company yet");
  const acct = await q(c, `
    select id from gl_account where id = $1 and tenant_id = $2 and is_postable
    /* unscoped: the chart is shared across the client's companies */`, [input.glAccountId, co.tenantId]);
  need(acct.length, "that account is not in this company's chart");
  if (store) {
    const po = await q(c, `select id from profit_object where id = $1 and entity_id = $2`, [store, co.id]);
    need(po.length, "that store is not part of this company");
  }
  const due = isDay(input.dueDate) ? input.dueDate as string : null;

  const dupe = await q(c, `select 1 from invoice where entity_id = $1 and vendor_id = $2 and reference = $3`,
    [co.id, input.vendorId, reference]);
  need(!dupe.length, `this vendor already has a bill numbered ${reference}`);

  const inv = await one<{ id: string }>(c, `
    insert into invoice (tenant_id, entity_id, vendor_id, kind, reference, invoice_date, due_date,
                         total_minor, confidence_bps, created_by)
    values ($1, $2, $3, 'operating', $4, $5::date, coalesce($6::date, $5::date + $7::int), $8, 10000, $9)
    returning id, entity_id`,
    [co.tenantId, co.id, input.vendorId, reference, input.invoiceDate, due, ve[0].terms_days, total.toString(), a.personId]);
  await q(c, `
    insert into invoice_line (invoice_id, seq, gl_account_id, profit_object_id, description, amount_minor)
    select $1, 1, $2, $3, $4, $5 where exists (select 1 from invoice where id = $1 and entity_id = $6)`,
    [inv.id, input.glAccountId, store, description, total.toString(), co.id]);

  const s = scopeOf(co, a);
  const out = await runGates(c, s, inv.id, a.personId);
  if (out.status === "approved") await postToLedger(c, s, inv.id);
  return { id: inv.id, status: out.status, reason: await explainReason(c, co, out.reason) };
}

/** The roles a person holds in this company: their own grants for it, or client-wide ones. */
async function rolesOf(c: Client, co: Company, personId: string): Promise<Set<string>> {
  const r = await q<{ role: string }>(c, `
    select distinct g.role from role_grant g join app_user u on u.id = g.app_user_id
     where g.app_user_id = $2 and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = $3))`,
    [co.id, personId, co.tenantId]);
  return new Set(r.map((x) => x.role));
}
const SIGN_OFF = ["controller", "owner"];

async function billOf(c: Client, co: Company, id: unknown) {
  need(typeof id === "string" && UUID.test(id), "no such bill");
  const rows = await q<{ id: string; status: string; total_minor: string; created_by: string | null }>(c, `
    select id, status, total_minor, created_by from invoice where id = $1 and entity_id = $2`, [id, co.id]);
  need(rows.length, "no such bill");
  return rows[0];
}

/** An exception or a held duplicate a person has looked at and wants to let through. */
export async function acceptBill(c: Client, co: Company, a: Actor, input: { id: unknown; reason: unknown }) {
  const inv = await billOf(c, co, input.id);
  const reason = text(input.reason);
  need(reason, "say why it is fine, so the next person can see it");
  need(inv.status === "exception" || inv.status === "held", `this bill is ${inv.status}, not waiting on a check`);
  // The gates are there to stop the unusual: overriding one is a sign-off,
  // and never by the person who entered the bill.
  const held = await rolesOf(c, co, a.personId);
  need(SIGN_OFF.some((r) => held.has(r)), "letting a stopped bill through is for the controller or the owner");
  need(inv.created_by !== a.personId, "whoever entered a bill cannot also let it through the gates");
  const s = scopeOf(co, a);
  await transition(c, s, inv.id, "validated", `accepted by ${a.personName}: ${reason}`);
  const approval = await openRequest(c, s, {
    subjectType: "invoice", subjectId: inv.id, amountMinor: BigInt(inv.total_minor),
    makerId: inv.created_by ?? a.personId,
  });
  if (!approval.required) {
    await transition(c, s, inv.id, "approved", "under the approval threshold");
    await postToLedger(c, s, inv.id);
    return { status: "approved" };
  }
  await transition(c, s, inv.id, "pending", "over the approval threshold");
  return { status: "pending" };
}

export async function rejectBill(c: Client, co: Company, a: Actor, input: { id: unknown; reason: unknown }) {
  const inv = await billOf(c, co, input.id);
  const reason = text(input.reason);
  need(reason, "say why it is rejected");
  need(inv.status === "exception" || inv.status === "held",
    inv.status === "pending" ? "a bill waiting on approval is rejected from Approvals" : `this bill is ${inv.status} and cannot be rejected here`);
  await transition(c, scopeOf(co, a), inv.id, "rejected", `${a.personName}: ${reason}`);
  return { status: "rejected" };
}

export async function addVendor(c: Client, co: Company, a: Actor, input: Record<string, unknown>) {
  const name = text(input.name, 120);
  need(name.length >= 2, "enter the vendor's legal name");
  const dba = text(input.dba, 120) || null;
  const terms = Number(input.termsDays ?? 30);
  need(Number.isInteger(terms) && terms >= 0 && terms <= 120, "terms are a number of days, 0 to 120");
  const gl = typeof input.glAccountId === "string" && UUID.test(input.glAccountId) ? input.glAccountId : null;
  const store = typeof input.storeId === "string" && UUID.test(input.storeId) ? input.storeId : null;
  if (gl) {
    const ok = await q(c, `select 1 from gl_account where id = $1 and tenant_id = $2
                           /* unscoped: the chart is shared across the client's companies */`, [gl, co.tenantId]);
    need(ok.length, "that account is not in this company's chart");
  }
  if (store) {
    const ok = await q(c, `select 1 from profit_object where id = $1 and entity_id = $2`, [store, co.id]);
    need(ok.length, "that store is not part of this company");
  }
  const exists = await q(c, `select id from vendor where tenant_id = $1 and lower(legal_name) = lower($2)
                             /* unscoped: vendors are shared across the client's companies */`, [co.tenantId, name]);
  need(!exists.length, `${name} is already a vendor`);

  const v = await one<{ id: string }>(c, `
    insert into vendor (tenant_id, legal_name, dba, is_1099, status, created_by)
    values ($1, $2, $3, $4, 'pending', $5) returning id
    /* unscoped: vendors are shared across the client's companies */`,
    [co.tenantId, name, dba, input.is1099 === true, a.personId]);
  await q(c, `
    insert into vendor_entity (vendor_id, entity_id, terms_days, default_gl_account_id, default_profit_object_id, status)
    select $1, $2, $3, $4, $5, 'hold' where exists (select 1 from entity where id = $2 and tenant_id = $6)
    /* unscoped: inserting this company's own row */`, [v.id, co.id, terms, gl, store, co.tenantId]);
  const s = scopeOf(co, a);
  await audit(c, s, { table: "vendor", rowId: v.id, action: "insert", after: { name, terms }, reason: "added from the screen" });
  const approval = await openRequest(c, s, { subjectType: "vendor", subjectId: v.id, amountMinor: null, makerId: a.personId });
  if (!approval.required) {
    await q(c, `update vendor set status = 'active' where id = $1 and tenant_id = $2 /* unscoped: vendor row */`, [v.id, co.tenantId]);
    await q(c, `update vendor_entity set status = 'active' where vendor_id = $1 and entity_id = $2`, [v.id, co.id]);
    return { id: v.id, status: "active" };
  }
  return { id: v.id, status: "pending" };
}

// ------------------------------------------------------------ payment runs

async function runOf(c: Client, co: Company, id: unknown) {
  need(typeof id === "string" && UUID.test(id), "no such payment run");
  const rows = await q<{ id: string; status: string; built_by: string; pay_date: string; method: string;
                          bank_account_id: string }>(c, `
    select id, status, built_by, pay_date::text, method, bank_account_id
      from payment_run where id = $1 and entity_id = $2`, [id, co.id]);
  need(rows.length, "no such payment run");
  return rows[0];
}

export async function createPaymentRun(c: Client, co: Company, a: Actor, input: Record<string, unknown>,
                                       opts: { allowPast?: boolean } = {}) {
  need(isDay(input.payDate), "pick the pay date");
  // Only the trial's sample history is ever dated in the past.
  need(opts.allowPast || (input.payDate as string) >= today(), "the pay date cannot be in the past");
  const method = ["ach", "check"].includes(String(input.method)) ? String(input.method) as "ach" | "check" : null;
  need(method, "pay by ACH or check");
  const ids = Array.isArray(input.invoiceIds) ? input.invoiceIds.filter((x) => typeof x === "string" && UUID.test(x)) : [];
  need(ids.length, "pick at least one bill to pay");
  need(ids.length <= 200, "that is more bills than one run should carry");

  const s = scopeOf(co, a);
  const bank = await resolveDisbursementAccount(c, s, { method });
  const invs = await q<{ id: string; total_minor: string }>(c, `
    select i.id, i.total_minor from invoice i
     where i.entity_id = $1 and i.id = any($2::uuid[]) and i.status = 'approved'
       and not exists (select 1 from payment p join payment_run pr on pr.id = p.payment_run_id
                        where p.invoice_id = i.id and pr.status in ('building','pending_release','released','settled'))`,
    [co.id, ids]);
  need(invs.length === ids.length, "some of those bills are not approved, or are already in a run; refresh and pick again");

  const run = await one<{ id: string }>(c, `
    insert into payment_run (tenant_id, entity_id, method, pay_date, built_by, bank_account_id)
    values ($1, $2, $3, $4::date, $5, $6) returning id, entity_id`,
    [co.tenantId, co.id, method, input.payDate, a.personId, bank.id]);
  for (const i of invs) {
    await q(c, `insert into payment (payment_run_id, invoice_id, amount_minor)
                select $1, $2, $3 where exists (select 1 from payment_run where id = $1 and entity_id = $4)`,
      [run.id, i.id, i.total_minor, co.id]);
  }
  const total = invs.reduce((t, i) => t + BigInt(i.total_minor), 0n);
  await audit(c, s, { table: "payment_run", rowId: run.id, action: "insert",
    after: { bills: invs.length, total: total.toString(), method, payDate: input.payDate }, reason: "built from the screen" });
  return { id: run.id, bills: invs.length, total: total.toString() };
}

export async function submitPaymentRun(c: Client, co: Company, a: Actor, input: { id: unknown }) {
  const run = await runOf(c, co, input.id);
  need(run.status === "building", `this run is ${run.status.replace("_", " ")}`);
  const total = await one<{ t: string }>(c, `
    select coalesce(sum(p.amount_minor), 0) as t from payment p
      join payment_run pr on pr.id = p.payment_run_id and pr.entity_id = $2
     where p.payment_run_id = $1`, [run.id, co.id]);
  const s = scopeOf(co, a);
  const res = await openRequest(c, s, { subjectType: "payment_run", subjectId: run.id, amountMinor: BigInt(total.t), makerId: run.built_by });
  await q(c, `update payment_run set status = 'pending_release' where id = $1 and entity_id = $2`, [run.id, co.id]);
  await audit(c, s, { table: "payment_run", rowId: run.id, action: "transition",
    before: { status: "building" }, after: { status: "pending_release" }, reason: res.required ? "sent for approval" : "no approval needed at this amount" });
  return { status: "pending_release", approval: res.required };
}

/**
 * Release pays the bills: a second person, after any approval, and the money
 * leaves the operating account in the books on the pay date. The bank file
 * itself is the payment-file writer's job, which is still to build.
 */
export async function releasePaymentRun(c: Client, co: Company, a: Actor, input: { id: unknown }) {
  const run = await runOf(c, co, input.id);
  need(run.status === "pending_release", run.status === "building" ? "send it for approval first" : `this run is already ${run.status}`);
  need(run.built_by !== a.personId, "whoever built the run cannot release it");
  const req = await q<{ status: string }>(c, `
    select status from approval_request where entity_id = $1 and subject_type = 'payment_run' and subject_id = $2
     order by created_at desc limit 1`, [co.id, run.id]);
  need(!req.length || req[0].status === "approved", req[0]?.status === "open" ? "the approval is still open" : "the approval was not given");

  const s = scopeOf(co, a);
  await q(c, `update payment_run set status = 'released', released_by = $2, released_at = now()
               where id = $1 and entity_id = $3`, [run.id, a.personId, co.id]);
  await q(c, `update payment set status = 'sent'
               where payment_run_id = (select id from payment_run where id = $1 and entity_id = $2)`, [run.id, co.id]);

  const pays = await q<{ invoice_id: string; amount_minor: string; label: string }>(c, `
    select p.invoice_id, p.amount_minor, coalesce(v.dba, v.legal_name) || ' ' || coalesce(i.reference, '') as label
      from payment p
      join payment_run pr on pr.id = p.payment_run_id and pr.entity_id = $2
      join invoice i on i.id = p.invoice_id join vendor v on v.id = i.vendor_id
     where p.payment_run_id = $1 order by label`, [run.id, co.id]);
  const period = await one<{ id: string }>(c, `
    select id from fiscal_period where entity_id = $1 and $2::date between starts_on and ends_on`, [co.id, run.pay_date]);
  const ap = await one<{ id: string }>(c, `
    select id from gl_account where tenant_id = $1 and code = '2010' /* unscoped: chart is tenant-wide */`, [co.tenantId]);
  const bank = await one<{ gl_account_id: string; name: string }>(c, `
    select gl_account_id, name from bank_account where id = $1 and entity_id = $2`, [run.bank_account_id, co.id]);
  const total = pays.reduce((t, p) => t + BigInt(p.amount_minor), 0n);
  const je = await one<{ id: string }>(c, `
    insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, source_id,
                               description, posted_by, actor_kind)
    values ($1, $2, $3, $4, 'payment', $5, $6, $7, $8) returning id`,
    [co.tenantId, co.id, period.id, run.pay_date, run.id,
     `Payment run ${run.pay_date}, ${pays.length} bill${pays.length === 1 ? "" : "s"} by ${run.method.toUpperCase()}`,
     a.personId, "user"]);
  let seq = 1;
  for (const p of pays) {
    await q(c, `insert into journal_line (journal_entry_id, seq, gl_account_id, debit_minor, memo)
                select $1, $2, $3, $4, $5 where exists (select 1 from journal_entry where id = $1 and entity_id = $6)`,
      [je.id, seq++, ap.id, p.amount_minor, p.label.slice(0, 200), co.id]);
  }
  await q(c, `insert into journal_line (journal_entry_id, seq, gl_account_id, bank_account_id, credit_minor, memo)
              select $1, $2, $3, $4, $5, $6 where exists (select 1 from journal_entry where id = $1 and entity_id = $7)`,
    [je.id, seq, bank.gl_account_id, run.bank_account_id, total.toString(), `paid from ${bank.name}`, co.id]);
  for (const p of pays) {
    await transition(c, s, p.invoice_id, "scheduled", `in the payment run for ${run.pay_date}`);
    await transition(c, s, p.invoice_id, "paid", `paid by ${run.method.toUpperCase()} on ${run.pay_date}`);
  }
  await audit(c, s, { table: "payment_run", rowId: run.id, action: "transition",
    before: { status: "pending_release" }, after: { status: "released", journalEntryId: je.id, total: total.toString() },
    reason: "released and posted" });
  return { status: "released", journalEntryId: je.id, total: total.toString(), bills: pays.length };
}

export async function cancelPaymentRun(c: Client, co: Company, a: Actor, input: { id: unknown }) {
  const run = await runOf(c, co, input.id);
  need(run.status === "building" || run.status === "pending_release", `a ${run.status} run cannot be cancelled`);
  await q(c, `update payment_run set status = 'cancelled' where id = $1 and entity_id = $2`, [run.id, co.id]);
  await q(c, `update payment set status = 'voided'
               where payment_run_id = (select id from payment_run where id = $1 and entity_id = $2)`, [run.id, co.id]);
  await q(c, `update approval_request set status = 'cancelled', decided_at = now()
               where entity_id = $1 and subject_type = 'payment_run' and subject_id = $2 and status = 'open'`, [co.id, run.id]);
  await audit(c, scopeOf(co, a), { table: "payment_run", rowId: run.id, action: "transition",
    before: { status: run.status }, after: { status: "cancelled" }, reason: `cancelled by ${a.personName}` });
  return { status: "cancelled" };
}

// ------------------------------------------------------------------ payroll

async function periodOf(c: Client, co: Company, id: unknown) {
  need(typeof id === "string" && UUID.test(id), "no such pay period");
  const rows = await q<{ id: string; status: string; pay_group_id: string; starts_on: string; ends_on: string; pay_date: string }>(c, `
    select pp.id, pp.status, pp.pay_group_id, pp.starts_on::text, pp.ends_on::text, pp.pay_date::text
      from pay_period pp join pay_group pg on pg.id = pp.pay_group_id
     where pp.id = $1 and pg.entity_id = $2`, [id, co.id]);
  need(rows.length, "no such pay period");
  return rows[0];
}

async function payrollRunOf(c: Client, co: Company, id: unknown) {
  need(typeof id === "string" && UUID.test(id), "no such payroll run");
  const rows = await q<{ id: string }>(c, `select id from payroll_run where id = $1 and entity_id = $2`, [id, co.id]);
  need(rows.length, "no such payroll run");
  return rows[0].id;
}

export async function approveTimecards(c: Client, co: Company, a: Actor, input: { periodId: unknown }) {
  const p = await periodOf(c, co, input.periodId);
  need(p.status === "open" || p.status === "timecards_approved", `this pay period is ${p.status.replace("_", " ")}`);
  const done = await q(c, `
    update timecard t set status = 'approved'
      from employee e
     where e.id = t.employee_id and e.entity_id = $2 and t.pay_period_id = $1 and t.status = 'recorded'
    returning t.id`, [p.id, co.id]);
  const left = await q<{ n: number }>(c, `
    select count(*)::int as n from timecard t join employee e on e.id = t.employee_id and e.entity_id = $2
     where t.pay_period_id = $1 and t.status <> 'approved'`, [p.id, co.id]);
  if (left[0].n === 0) {
    await q(c, `update pay_period set status = 'timecards_approved'
                 where id = $1 and status = 'open'
                   and exists (select 1 from pay_group pg where pg.id = pay_period.pay_group_id and pg.entity_id = $2)`, [p.id, co.id]);
  }
  await audit(c, scopeOf(co, a), { table: "pay_period", rowId: p.id, action: "transition",
    after: { approved: done.length, stillOpen: left[0].n }, reason: "timecards approved" });
  return { approved: done.length, stillOpen: left[0].n };
}

export async function buildPayroll(c: Client, co: Company, a: Actor, input: { periodId: unknown }) {
  const p = await periodOf(c, co, input.periodId);
  const out = await buildRun(c, scopeOf(co, a), { payPeriodId: p.id, builtBy: a.personId, taxProvider: new IllustrativeTaxProvider() });
  return { runId: out.runId, gross: out.grossMinor.toString(), net: out.netMinor.toString(), employees: out.employees };
}

export async function requestPayroll(c: Client, co: Company, a: Actor, input: { runId: unknown }) {
  const id = await payrollRunOf(c, co, input.runId);
  const built = await one<{ built_by: string }>(c, `select built_by from payroll_run where id = $1 and entity_id = $2`, [id, co.id]);
  return await requestRelease(c, scopeOf(co, a), id, built.built_by);
}

export async function releasePayroll(c: Client, co: Company, a: Actor, input: { runId: unknown }) {
  const id = await payrollRunOf(c, co, input.runId);
  const st = await one<{ status: string }>(c, `select status from payroll_run where id = $1 and entity_id = $2`, [id, co.id]);
  need(st.status === "pending_release", st.status === "building" ? "send it for approval first" : `this run is ${st.status}`);
  const req = await q<{ status: string }>(c, `
    select status from approval_request where entity_id = $1 and subject_type = 'payroll_run' and subject_id = $2
     order by created_at desc limit 1`, [co.id, id]);
  need(!req.length || req[0].status === "approved", req[0]?.status === "open" ? "the approval is still open" : "the approval was not given");
  await release(c, scopeOf(co, a), id, a.personId);
  await q(c, `update pay_period set status = 'released'
               where id = (select pay_period_id from payroll_run where id = $1 and entity_id = $2)`, [id, co.id]);
  return { status: "released" };
}

export async function postPayroll(c: Client, co: Company, a: Actor, input: { runId: unknown }) {
  const id = await payrollRunOf(c, co, input.runId);
  const je = await postRun(c, scopeOf(co, a), id);
  return { status: "posted", journalEntryId: je };
}

/** The next period after the latest one, so the weekly cycle carries on. */
export async function openNextPeriod(c: Client, co: Company, a: Actor) {
  const last = await q<{ pay_group_id: string; starts_on: string; ends_on: string; pay_date: string; frequency: string }>(c, `
    select pp.pay_group_id, pp.starts_on::text, pp.ends_on::text, pp.pay_date::text, pg.frequency
      from pay_period pp join pay_group pg on pg.id = pp.pay_group_id
     where pg.entity_id = $1 and pg.status = 'active'
     order by pp.starts_on desc limit 1`, [co.id]);
  need(last.length, "this company has no pay group yet");
  const L = last[0];
  const open = await q(c, `
    select 1 from pay_period pp join pay_group pg on pg.id = pp.pay_group_id
     where pg.entity_id = $1 and pp.status in ('open','timecards_approved')`, [co.id]);
  need(!open.length, "there is already a pay period open; finish it first");
  const step = L.frequency === "biweekly" ? 14 : 7;
  const p = await one<{ id: string; starts_on: string; ends_on: string; pay_date: string }>(c, `
    insert into pay_period (pay_group_id, starts_on, ends_on, pay_date)
    select $1, $2::date + $4::int, $3::date + $4::int, $5::date + $4::int
     where exists (select 1 from pay_group pg where pg.id = $1 and pg.entity_id = $6)
    returning id, starts_on::text, ends_on::text, pay_date::text`,
    [L.pay_group_id, L.starts_on, L.ends_on, step, L.pay_date, co.id]);
  await audit(c, scopeOf(co, a), { table: "pay_period", rowId: p.id, action: "insert", after: p, reason: "next period opened" });
  return p;
}

// ------------------------------------------------------------------ banking

export async function planTodaysSweeps(c: Client, co: Company, a: Actor) {
  // The planner sweeps each branch's book balance, and a sweep that has not
  // been confirmed is still in that balance. Planning again before confirming
  // would move the same money twice, so the order is enforced here.
  const outstanding = await q<{ n: number }>(c, `
    select count(*)::int as n from bank_transfer where entity_id = $1 and status in ('expected', 'planned')`, [co.id]);
  need(outstanding[0].n === 0,
    `confirm the ${outstanding[0].n === 1 ? "sweep" : `${outstanding[0].n} sweeps`} still outstanding first; planning now would count that money twice`);
  const planned = await planSweeps(c, scopeOf(co, a), { asOf: today(), createdBy: a.personId });
  return { planned: planned.map((p) => ({ ...p, amountMinor: p.amountMinor.toString() })) };
}

export async function confirmSweep(c: Client, co: Company, a: Actor, input: { transferId: unknown }) {
  need(typeof input.transferId === "string" && UUID.test(input.transferId), "no such transfer");
  const je = await confirmTransfer(c, scopeOf(co, a), { transferId: input.transferId as string, confirmedBy: a.personId, onDate: today() });
  return { journalEntryId: je };
}

// ----------------------------------------------------------- reconciliation

/** Run the matchers over every statement that still has open lines. */
export async function runMatching(c: Client, co: Company, a: Actor, input: { bankAccountId?: unknown }) {
  const only = typeof input.bankAccountId === "string" && UUID.test(input.bankAccountId) ? input.bankAccountId : null;
  const statements = await q<{ id: string; bank_account_id: string }>(c, `
    select distinct s.id, s.bank_account_id, s.statement_date
      from bank_statement s
      join bank_account ba on ba.id = s.bank_account_id and ba.entity_id = $1
      join bank_statement_line l on l.bank_statement_id = s.id and l.match_status = 'unmatched'
     where ($2::uuid is null or s.bank_account_id = $2)
     order by s.statement_date`, [co.id, only]);
  const s = { ...scopeOf(co, a, "user") };
  let lines = 0, matched = 0, variance = 0n;
  const byMethod: Record<string, number> = {};
  for (const st of statements) {
    const r = await autoMatch(c, s, { bankAccountId: st.bank_account_id, statementId: st.id, ranBy: a.personId });
    lines += r.linesTotal; matched += r.linesMatched; variance += r.varianceMinor;
    for (const [k, v] of Object.entries(r.byMethod)) byMethod[k] = (byMethod[k] ?? 0) + v;
  }
  return { statements: statements.length, lines, matched, fees: variance.toString(), byMethod };
}

async function openLine(c: Client, co: Company, id: unknown) {
  need(typeof id === "string" && UUID.test(id), "no such bank line");
  const rows = await q<{ id: string; bank_account_id: string; amount_minor: string; posted_on: string; description: string;
                          gl_account_id: string; account_name: string }>(c, `
    select l.id, s.bank_account_id, l.amount_minor, l.posted_on::text, l.description, ba.gl_account_id, ba.name as account_name
      from bank_statement_line l
      join bank_statement s on s.id = l.bank_statement_id
      join bank_account ba on ba.id = s.bank_account_id
     where l.id = $1 and ba.entity_id = $2 and l.match_status = 'unmatched'`, [id, co.id]);
  need(rows.length, "that line is already matched, or not this company's");
  return rows[0];
}

export async function matchLine(c: Client, co: Company, a: Actor, input: { lineId: unknown; kind: unknown; targetId: unknown; note: unknown }) {
  const line = await openLine(c, co, input.lineId);
  const kind = ["pos_deposit", "bank_transfer", "payment"].includes(String(input.kind)) ? String(input.kind) as "pos_deposit" | "bank_transfer" | "payment" : null;
  need(kind, "pick what it matches");
  need(typeof input.targetId === "string" && UUID.test(input.targetId), "pick what it matches");
  const note = text(input.note);
  need(note, "say why these belong together");
  const owned = kind === "pos_deposit"
    ? await q(c, `select 1 from pos_deposit where id = $1 and entity_id = $2 and status = 'open'`, [input.targetId, co.id])
    : kind === "bank_transfer"
    ? await q(c, `select 1 from bank_transfer where id = $1 and entity_id = $2`, [input.targetId, co.id])
    : await q(c, `select 1 from payment p join payment_run pr on pr.id = p.payment_run_id where p.id = $1 and pr.entity_id = $2`, [input.targetId, co.id]);
  need(owned.length, "that item is not open for this company");
  await matchManually(c, scopeOf(co, a), {
    statementLineId: line.id, kind, id: input.targetId as string, amountMinor: BigInt(line.amount_minor),
    matchedBy: a.personId, note: `${a.personName}: ${note}`,
  });
  return { matched: true };
}

/**
 * A line with nothing to match -- bank interest, a returned item, a fee -- is
 * booked to an account and matched to that entry, so the books and the bank
 * agree and the reason is on record.
 */
export async function bookLine(c: Client, co: Company, a: Actor, input: { lineId: unknown; glAccountId: unknown; note: unknown }) {
  const line = await openLine(c, co, input.lineId);
  // Booking a line writes a journal entry, which is the controller's or the owner's to do.
  const held = await rolesOf(c, co, a.personId);
  need(SIGN_OFF.some((r) => held.has(r)), "booking a bank line to an account is for the controller or the owner");
  need(typeof input.glAccountId === "string" && UUID.test(input.glAccountId), "pick the account to book it to");
  const note = text(input.note);
  need(note, "say what it is");
  const acct = await q<{ id: string; code: string }>(c, `
    select id, code from gl_account where id = $1 and tenant_id = $2 and is_postable
    /* unscoped: the chart is shared across the client's companies */`, [input.glAccountId, co.tenantId]);
  need(acct.length, "that account is not in this company's chart");
  need(acct[0].id !== line.gl_account_id, "book it to the other side, not the bank's own account");
  const amount = BigInt(line.amount_minor);
  const period = await one<{ id: string }>(c, `
    select id from fiscal_period where entity_id = $1 and $2::date between starts_on and ends_on`, [co.id, line.posted_on]);
  const je = await one<{ id: string }>(c, `
    insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, description, posted_by, actor_kind)
    values ($1, $2, $3, $4, 'manual', $5, $6, 'user') returning id`,
    [co.tenantId, co.id, period.id, line.posted_on, `${line.description} (${line.account_name}): ${note}`.slice(0, 300), a.personId]);
  const abs = (amount < 0n ? -amount : amount).toString();
  const cashLine = await one<{ id: string }>(c, `
    insert into journal_line (journal_entry_id, seq, gl_account_id, bank_account_id, debit_minor, credit_minor, memo)
    select $1, 1, $2, $3, $4, $5, 'as the bank shows it' where exists (select 1 from journal_entry where id = $1 and entity_id = $6)
    returning id`,
    [je.id, line.gl_account_id, line.bank_account_id, amount > 0n ? abs : "0", amount < 0n ? abs : "0", co.id]);
  await q(c, `
    insert into journal_line (journal_entry_id, seq, gl_account_id, debit_minor, credit_minor, memo)
    select $1, 2, $2, $3, $4, $5 where exists (select 1 from journal_entry where id = $1 and entity_id = $6)`,
    [je.id, acct[0].id, amount < 0n ? abs : "0", amount > 0n ? abs : "0", note.slice(0, 200), co.id]);
  await matchManually(c, scopeOf(co, a), {
    statementLineId: line.id, kind: "journal_line", id: cashLine.id, amountMinor: amount,
    matchedBy: a.personId, note: `${a.personName}: booked to ${acct[0].code} — ${note}`,
  });
  return { journalEntryId: je.id };
}
