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
import { buildRun, requestRelease, release, postRun, IllustrativeTaxProvider, type Frequency, isFrequency,
         nextPeriod, periodStartingOn, periodStartProblem, PERIODS_PER_YEAR } from "../packages/core/payroll.ts";
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
export async function decideRequest(c: Client, co: Company, a: Actor,
                                    input: { requestId: unknown; decision: unknown; note: unknown; callback?: unknown }) {
  need(typeof input.requestId === "string" && UUID.test(input.requestId), "no such request");
  const decision = input.decision === "approved" ? "approved" : input.decision === "rejected" ? "rejected" : null;
  need(decision, "decide approved or rejected");
  const note = text(input.note);
  need(decision === "approved" || note, "say why it is rejected, so the maker knows what to fix");

  const req = await q<{ subject_type: string; subject_id: string }>(c, `
    select subject_type, subject_id from approval_request where id = $1 and entity_id = $2`, [input.requestId, co.id]);
  need(req.length, "no such request");
  const s = scopeOf(co, a);
  const status = await decide(c, s, { requestId: input.requestId as string, actorId: a.personId, decision: decision!,
                                      note: note || undefined, callbackLogged: input.callback === true });
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
    if (type === "employee") {
      await q(c, `update employee set status = 'active' where id = $1 and entity_id = $2 and status = 'applicant'`, [id, co.id]);
      await audit(c, s, { table: "employee", rowId: id, action: "transition", before: { status: "applicant" }, after: { status: "active" }, reason: "hire approved" });
    }
    if (type === "employee_change") await applyEmployeeChange(c, co, a, id);
    if (type === "vendor_bank_account") await makeBankCurrent(c, co, a, id, note);
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
    if (type === "employee") {
      // Never hired: kept on record, closed on the day they would have started.
      await q(c, `update employee set status = 'terminated', terminated_on = hired_on
                   where id = $1 and entity_id = $2 and status = 'applicant'`, [id, co.id]);
      await audit(c, s, { table: "employee", rowId: id, action: "transition", before: { status: "applicant" }, after: { status: "terminated" }, reason: `hire rejected: ${note}` });
    }
    if (type === "employee_change") {
      await q(c, `update employee_change set status = 'rejected', decided_at = now()
                   where id = $1 and entity_id = $2 and status = 'pending'`, [id, co.id]);
    }
    if (type === "vendor_bank_account") {
      await q(c, `update vendor_bank_account set status = 'rejected', callback_note = $3
                   where id = $1 and status = 'pending'
                     and vendor_id in (select vendor_id from vendor_entity where entity_id = $2)`, [id, co.id, `rejected: ${note}`]);
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

const STATE = /^[A-Z]{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+().\-\s]{7,25}$/;
const TAX_CLASSES = ["individual", "sole_prop", "partnership", "c_corp", "s_corp", "llc", "other"];

/** What the screen calls each vendor field, and its column. */
const VENDOR_KEYS: [string, string][] = [
  ["addressLine1", "address_line1"], ["addressLine2", "address_line2"], ["city", "city"], ["state", "state"],
  ["postalCode", "postal_code"], ["remitTo", "remit_to"], ["contactName", "contact_name"], ["contactPhone", "contact_phone"],
  ["contactEmail", "contact_email"], ["taxClassification", "tax_classification"], ["tinLast4", "tin_last4"],
  ["w9OnFile", "w9_on_file"], ["is1099", "is_1099"],
];

/** The parts of a vendor record a person types, checked the same way on add and on edit. */
function vendorFields(input: Record<string, unknown>) {
  const state = text(input.state, 20).toUpperCase() || null;
  need(!state || STATE.test(state), "the state is two letters, like TX");
  const postal = text(input.postalCode, 10) || null;
  need(!postal || /^\d{5}(-\d{4})?$/.test(postal), "the ZIP code is five digits, or ZIP+4");
  const phone = text(input.contactPhone, 25) || null;
  need(!phone || PHONE.test(phone), "the phone number has only digits, spaces and ( ) - +");
  const email = text(input.contactEmail, 120) || null;
  need(!email || EMAIL.test(email), "that email address does not look right");
  const taxClass = text(input.taxClassification, 20) || null;
  need(!taxClass || TAX_CLASSES.includes(taxClass), "pick a tax classification from the list");
  const tinLast4 = text(input.tinLast4, 40) || null;
  need(!tinLast4 || /^\d{4}$/.test(tinLast4), "only the last four digits of the tax ID are kept");
  return {
    address_line1: text(input.addressLine1, 120) || null, address_line2: text(input.addressLine2, 120) || null,
    city: text(input.city, 60) || null, state, postal_code: postal, remit_to: text(input.remitTo, 300) || null,
    contact_name: text(input.contactName, 80) || null, contact_phone: phone, contact_email: email,
    tax_classification: taxClass, tin_last4: tinLast4, w9_on_file: input.w9OnFile === true, is_1099: input.is1099 === true,
  };
}

export async function addVendor(c: Client, co: Company, a: Actor, input: Record<string, unknown>) {
  const name = text(input.name, 120);
  need(name.length >= 2, "enter the vendor's legal name");
  const dba = text(input.dba, 120) || null;
  const terms = Number(input.termsDays ?? 30);
  need(Number.isInteger(terms) && terms >= 0 && terms <= 120, "terms are a number of days, 0 to 120");
  const gl = typeof input.glAccountId === "string" && UUID.test(input.glAccountId) ? input.glAccountId : null;
  const store = typeof input.storeId === "string" && UUID.test(input.storeId) ? input.storeId : null;
  const f = vendorFields(input);
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
    insert into vendor (tenant_id, legal_name, dba, is_1099, status, created_by, tax_classification, tin_last4, w9_on_file,
                        address_line1, address_line2, city, state, postal_code, remit_to, contact_name, contact_phone, contact_email)
    values ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) returning id
    /* unscoped: vendors are shared across the client's companies */`,
    [co.tenantId, name, dba, f.is_1099, a.personId, f.tax_classification, f.tin_last4, f.w9_on_file,
     f.address_line1, f.address_line2, f.city, f.state, f.postal_code, f.remit_to, f.contact_name, f.contact_phone, f.contact_email]);
  await q(c, `
    insert into vendor_entity (vendor_id, entity_id, terms_days, default_gl_account_id, default_profit_object_id, status)
    select $1, $2, $3, $4, $5, 'hold' where exists (select 1 from entity where id = $2 and tenant_id = $6)
    /* unscoped: inserting this company's own row */`, [v.id, co.id, terms, gl, store, co.tenantId]);
  const s = scopeOf(co, a);
  await audit(c, s, { table: "vendor", rowId: v.id, action: "insert", after: { name, terms, ...f }, reason: "added from the screen" });
  const approval = await openRequest(c, s, { subjectType: "vendor", subjectId: v.id, amountMinor: null, makerId: a.personId });
  if (!approval.required) {
    await q(c, `update vendor set status = 'active' where id = $1 and tenant_id = $2 /* unscoped: vendor row */`, [v.id, co.tenantId]);
    await q(c, `update vendor_entity set status = 'active' where vendor_id = $1 and entity_id = $2`, [v.id, co.id]);
    return { id: v.id, status: "active" };
  }
  return { id: v.id, status: "pending" };
}

async function vendorOf(c: Client, co: Company, id: unknown) {
  need(typeof id === "string" && UUID.test(id), "no such vendor");
  const rows = await q<{ id: string; legal_name: string; contact_phone: string | null }>(c, `
    select v.id, v.legal_name, v.contact_phone from vendor v
      join vendor_entity ve on ve.vendor_id = v.id and ve.entity_id = $2
     where v.id = $1`, [id, co.id]);
  need(rows.length, "no such vendor");
  return rows[0];
}

/**
 * Edit a vendor's address, contact, tax papers, terms and usual coding. The
 * controller's or the owner's to do, because the phone on file is the number a
 * bank change is checked against.
 */
export async function updateVendor(c: Client, co: Company, a: Actor, input: Record<string, unknown>) {
  const v = await vendorOf(c, co, input.id);
  const held = await rolesOf(c, co, a.personId);
  need(SIGN_OFF.some((r) => held.has(r)), "changing a vendor's details is for the controller or the owner");
  const before = await one<Record<string, unknown>>(c, `
    select v.address_line1, v.address_line2, v.city, v.state, v.postal_code, v.remit_to, v.contact_name, v.contact_phone,
           v.contact_email, v.tax_classification, v.tin_last4, v.w9_on_file, v.is_1099, ve.terms_days, ve.default_profit_object_id
      from vendor v join vendor_entity ve on ve.vendor_id = v.id and ve.entity_id = $2 where v.id = $1`, [v.id, co.id]);
  // A field the request leaves out keeps what is on file; one sent empty is cleared.
  const merged: Record<string, unknown> = {};
  for (const [k, col] of VENDOR_KEYS) merged[k] = input[k] === undefined ? before[col] : input[k];
  const f = vendorFields(merged);
  const terms = Number(input.termsDays ?? before.terms_days);
  need(Number.isInteger(terms) && terms >= 0 && terms <= 120, "terms are a number of days, 0 to 120");
  const gl = typeof input.glAccountId === "string" && UUID.test(input.glAccountId) ? input.glAccountId : null;
  const store = input.storeId === undefined ? (before.default_profit_object_id as string | null)
    : typeof input.storeId === "string" && UUID.test(input.storeId) ? input.storeId : null;
  if (store) {
    const ok = await q(c, `select 1 from profit_object where id = $1 and entity_id = $2`, [store, co.id]);
    need(ok.length, "that store is not part of this company");
  }
  await q(c, `
    update vendor set address_line1 = $2, address_line2 = $3, city = $4, state = $5, postal_code = $6, remit_to = $7,
                      contact_name = $8, contact_phone = $9, contact_email = $10, tax_classification = $11,
                      tin_last4 = $12, w9_on_file = $13, is_1099 = $14
     where id = $1 and tenant_id = $15 /* unscoped: vendors are shared across the client's companies */`,
    [v.id, f.address_line1, f.address_line2, f.city, f.state, f.postal_code, f.remit_to, f.contact_name, f.contact_phone,
     f.contact_email, f.tax_classification, f.tin_last4, f.w9_on_file, f.is_1099, co.tenantId]);
  await q(c, `update vendor_entity set terms_days = $3, default_gl_account_id = coalesce($4, default_gl_account_id),
                     default_profit_object_id = $5
               where vendor_id = $1 and entity_id = $2`, [v.id, co.id, terms, gl, store]);
  await audit(c, scopeOf(co, a), { table: "vendor", rowId: v.id, action: "update", before, after: { ...f, terms_days: terms },
    reason: f.contact_phone !== before.contact_phone ? "details changed, including the phone on file" : "details changed" });
  return { id: v.id };
}

/**
 * New bank details for a vendor. Only the last four digits of the routing and
 * account numbers are kept here; the full numbers live where payments are
 * actually sent from. Nothing changes until the controller and the owner
 * approve, each after calling back a phone number already on file, and the
 * first payment waits three days after that.
 */
export async function requestVendorBank(c: Client, co: Company, a: Actor, input: Record<string, unknown>) {
  const v = await vendorOf(c, co, input.vendorId);
  need(v.contact_phone, "put a phone number on file for the vendor first; a bank change is called back on it");
  const bankName = text(input.bankName, 80);
  need(bankName.length >= 2, "enter the bank's name");
  const routing = text(input.routingLast4, 40), account = text(input.accountLast4, 40);
  need(/^\d{4}$/.test(routing) && /^\d{4}$/.test(account),
    "enter only the last four digits of the routing and the account numbers; the full numbers stay with the bank");
  const heldAt = text(input.heldAt, 120);
  need(heldAt.length >= 2, "say where the full numbers are kept, like the bank's payee record");
  const reason = text(input.reason);
  need(reason, "say how the new details arrived, like a letter on the vendor's letterhead");
  const open = await q(c, `select 1 from vendor_bank_account where vendor_id = $1 and status = 'pending'
                             and vendor_id in (select vendor_id from vendor_entity where entity_id = $2)`, [v.id, co.id]);
  need(!open.length, "a bank change for this vendor is already waiting on approval");
  const policy = await q(c, `select 1 from approval_policy where entity_id = $1 and subject_type = 'vendor_bank_account' and active`, [co.id]);
  need(policy.length, "this company has no approval rule for vendor bank changes yet, so none can be made");
  const ver = await one<{ n: number }>(c, `
    select coalesce(max(version), 0)::int + 1 as n from vendor_bank_account
     where vendor_id = $1 and vendor_id in (select vendor_id from vendor_entity where entity_id = $2)`, [v.id, co.id]);
  const row = await one<{ id: string }>(c, `
    insert into vendor_bank_account (vendor_id, version, account_ref, routing_last4, account_last4, bank_name, created_by)
    select $1, $2, $3, $4, $5, $6, $7 where exists (select 1 from vendor_entity where vendor_id = $1 and entity_id = $8)
    returning id /* unscoped: inserting against a vendor this company uses */`,
    [v.id, ver.n, `held at: ${heldAt}`, routing, account, bankName, a.personId, co.id]);
  const s = scopeOf(co, a);
  await audit(c, s, { table: "vendor_bank_account", rowId: row.id, action: "insert",
    after: { vendor: v.legal_name, bankName, routingLast4: routing, accountLast4: account, heldAt }, reason });
  const r = await openRequest(c, s, { subjectType: "vendor_bank_account", subjectId: row.id, amountMinor: null, makerId: a.personId });
  await q(c, `update vendor_bank_account set approval_request_id = $2 where id = $1
                and vendor_id in (select vendor_id from vendor_entity where entity_id = $3)`,
    [row.id, r.required ? r.requestId : null, co.id]);
  return { id: row.id, approval: r.required };
}

async function makeBankCurrent(c: Client, co: Company, a: Actor, id: string, note: string) {
  const row = await one<{ vendor_id: string }>(c, `
    select vendor_id from vendor_bank_account
     where id = $1 and vendor_id in (select vendor_id from vendor_entity where entity_id = $2)`, [id, co.id]);
  await q(c, `update vendor_bank_account set status = 'superseded'
               where vendor_id = $1 and status = 'current'
                 and vendor_id in (select vendor_id from vendor_entity where entity_id = $2)`, [row.vendor_id, co.id]);
  await q(c, `update vendor_bank_account
                 set status = 'current', effective_from = now(), hold_until = now() + interval '3 days', callback_note = $3
               where id = $1 and status = 'pending'
                 and vendor_id in (select vendor_id from vendor_entity where entity_id = $2)`, [id, co.id, note || null]);
  await audit(c, scopeOf(co, a), { table: "vendor_bank_account", rowId: id, action: "transition",
    before: { status: "pending" }, after: { status: "current" }, reason: "approved after call-backs; first payment waits three days" });
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

/** The next period for one pay group, on that group's own schedule. */
export async function openNextPeriod(c: Client, co: Company, a: Actor, input: { payGroupId?: unknown } = {}) {
  const groups = await q<{ id: string; name: string; frequency: Frequency; pay_lag_days: number }>(c, `
    select id, name, frequency, pay_lag_days from pay_group
     where entity_id = $1 and status = 'active' and ($2::uuid is null or id = $2::uuid)
     order by name`,
    [co.id, typeof input.payGroupId === "string" && UUID.test(input.payGroupId) ? input.payGroupId : null]);
  need(groups.length, "this company has no pay group yet");
  need(groups.length === 1, "say which pay group");
  const g = groups[0];
  const open = await q(c, `
    select 1 from pay_period pp join pay_group pg on pg.id = pp.pay_group_id
     where pp.pay_group_id = $1 and pg.entity_id = $2 and pp.status not in ('posted','cancelled')`, [g.id, co.id]);
  need(!open.length, `${g.name} already has a pay period open; finish it first`);
  const last = await q<{ ends_on: string }>(c, `
    select pp.ends_on::text from pay_period pp join pay_group pg on pg.id = pp.pay_group_id
     where pp.pay_group_id = $1 and pg.entity_id = $2 order by pp.starts_on desc limit 1`, [g.id, co.id]);
  need(last.length, `${g.name} has no periods yet`);
  const n = nextPeriod(g.frequency, last[0].ends_on, g.pay_lag_days);
  const p = await one<{ id: string; starts_on: string; ends_on: string; pay_date: string }>(c, `
    insert into pay_period (pay_group_id, starts_on, ends_on, pay_date)
    select $1, $2::date, $3::date, $4::date
     where exists (select 1 from pay_group pg where pg.id = $1 and pg.entity_id = $5)
    returning id, starts_on::text, ends_on::text, pay_date::text`,
    [g.id, n.startsOn, n.endsOn, n.payDate, co.id]);
  await audit(c, scopeOf(co, a), { table: "pay_period", rowId: p.id, action: "insert", after: { group: g.name, ...p }, reason: "next period opened" });
  return { ...p, group: g.name };
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

// ------------------------------------------------------ pay groups and people
//
// Who is on payroll, on which schedule, at what pay. Adding a person or
// changing their pay waits on the owner before any run can pay it -- the
// control that keeps a made-up employee off the register. No Social Security
// number is kept here: tax setup belongs to the payroll tax service.

const PAY_TYPES = ["hourly", "salary"];

/** Dollars typed as a rate: an hourly rate or an annual salary. */
function rateOf(v: unknown, payType: string): bigint {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  need(/^\d+(\.\d{1,2})?$/.test(s), payType === "salary" ? "enter the annual salary, like 52000" : "enter the hourly rate, like 18.50");
  const m = fromDecimal(s);
  if (payType === "hourly") need(m >= 200n && m <= 50_000n, "an hourly rate between $2 and $500");
  else need(m >= 100_000n && m <= 100_000_000n, "an annual salary between $1,000 and $1,000,000");
  return m;
}

async function groupOf(c: Client, co: Company, id: unknown) {
  need(typeof id === "string" && UUID.test(id), "pick the pay group");
  const rows = await q<{ id: string; name: string; frequency: Frequency }>(c, `
    select id, name, frequency from pay_group where id = $1 and entity_id = $2 and status = 'active'`, [id, co.id]);
  need(rows.length, "that pay group is not part of this company");
  return rows[0];
}

async function storeOf(c: Client, co: Company, id: unknown): Promise<string | null> {
  if (!(typeof id === "string" && UUID.test(id))) return null;
  const ok = await q(c, `select 1 from profit_object where id = $1 and entity_id = $2`, [id, co.id]);
  need(ok.length, "that store is not part of this company");
  return id;
}

/** A new pay schedule for a company, with its first period open. The controller's or the owner's to set up. */
export async function addPayGroup(c: Client, co: Company, a: Actor, input: Record<string, unknown>) {
  const held = await rolesOf(c, co, a.personId);
  need(SIGN_OFF.some((r) => held.has(r)), "setting up a pay group is for the controller or the owner");
  const name = text(input.name, 60);
  need(name.length >= 2, "name the pay group, like Managers, semimonthly");
  need(isFrequency(input.frequency), "pick how often it pays");
  const freq = input.frequency as Frequency;
  need(isDay(input.firstStartsOn), "pick the day the first pay period starts");
  const startProblem = periodStartProblem(freq, input.firstStartsOn as string);
  need(!startProblem, startProblem ?? "");
  const lag = Number(input.payLagDays ?? 0);
  need(Number.isInteger(lag) && lag >= 0 && lag <= 31, "pay 0 to 31 days after a period ends");
  const dow = Number(input.workweekStartDow ?? 0);
  need(Number.isInteger(dow) && dow >= 0 && dow <= 6, "pick the day the workweek starts");
  const otAfter = Number(input.overtimeAfterHours ?? 40);
  need(otAfter > 0 && otAfter <= 60, "overtime after 1 to 60 hours a week");
  need(typeof input.bankAccountId === "string" && UUID.test(input.bankAccountId), "pick the account payroll is paid from");
  const bank = await q<{ purpose: string }>(c, `
    select purpose from bank_account where id = $1 and entity_id = $2 and status = 'active'`, [input.bankAccountId, co.id]);
  need(bank.length, "that account is not one of this company's");
  need(["payroll", "operating"].includes(bank[0].purpose), "payroll is paid from the payroll account or the operating account");
  const dupe = await q(c, `select 1 from pay_group where entity_id = $1 and lower(name) = lower($2)`, [co.id, name]);
  need(!dupe.length, `there is already a pay group called ${name}`);

  const g = await one<{ id: string }>(c, `
    insert into pay_group (tenant_id, entity_id, name, frequency, bank_account_id, pay_lag_days, workweek_start_dow, overtime_after_hours)
    values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [co.tenantId, co.id, name, freq, input.bankAccountId, lag, dow, otAfter]);
  const first = periodStartingOn(freq, input.firstStartsOn as string, lag);
  await q(c, `insert into pay_period (pay_group_id, starts_on, ends_on, pay_date)
              select $1, $2::date, $3::date, $4::date where exists (select 1 from pay_group where id = $1 and entity_id = $5)`,
    [g.id, first.startsOn, first.endsOn, first.payDate, co.id]);
  await audit(c, scopeOf(co, a), { table: "pay_group", rowId: g.id, action: "insert",
    after: { name, frequency: freq, payLagDays: lag, workweekStartDow: dow, firstPeriod: first }, reason: "set up from the screen" });
  return { id: g.id, firstPeriod: first };
}

/** The next free employee number, E-1001 style, for this company. */
async function nextEmployeeNo(c: Client, co: Company): Promise<string> {
  const r = await one<{ n: number | null }>(c, `
    select max(substring(employee_no from '([0-9]+)$')::int) as n from employee where entity_id = $1`, [co.id]);
  return `E-${(r.n ?? 1000) + 1}`;
}

/** Enter a new hire. They are paid by no run until the owner approves them. */
export async function hireEmployee(c: Client, co: Company, a: Actor, input: Record<string, unknown>) {
  const first = text(input.firstName, 60), last = text(input.lastName, 60);
  need(first && last, "enter the person's first and last name");
  const position = text(input.position, 60);
  need(position, "enter the position, like Sales associate");
  const g = await groupOf(c, co, input.payGroupId);
  const payType = String(input.payType ?? "");
  need(PAY_TYPES.includes(payType), "pick hourly or salary");
  const rate = rateOf(input.rate, payType);
  const store = await storeOf(c, co, input.storeId);
  const workState = text(input.workState, 20).toUpperCase();
  need(STATE.test(workState), "the state they work in, as two letters, like TX");
  const comp = text(input.compClassCode, 10) || null;
  need(!comp || /^\d{4}$/.test(comp), "a workers' comp class code is four digits");
  need(isDay(input.hiredOn), "pick the hire date");
  let no = text(input.employeeNo, 20);
  if (!no) no = await nextEmployeeNo(c, co);
  const dupe = await q(c, `select 1 from employee where entity_id = $1 and employee_no = $2`, [co.id, no]);
  need(!dupe.length, `employee number ${no} is already taken`);

  const e = await one<{ id: string }>(c, `
    insert into employee (tenant_id, entity_id, pay_group_id, employee_no, first_name, last_name, position, hired_on,
                          status, pay_type, base_rate_minor, work_state, comp_class_code, profit_object_id)
    values ($1, $2, $3, $4, $5, $6, $7, $8::date, 'applicant', $9, $10, $11, $12, $13) returning id`,
    [co.tenantId, co.id, g.id, no, first, last, position, input.hiredOn, payType, rate.toString(), workState, comp, store]);
  const s = scopeOf(co, a);
  await audit(c, s, { table: "employee", rowId: e.id, action: "insert",
    after: { name: `${first} ${last}`, employeeNo: no, position, group: g.name, payType, rate: rate.toString(), hiredOn: input.hiredOn },
    reason: "hired from the screen" });
  const r = await openRequest(c, s, { subjectType: "employee", subjectId: e.id,
    amountMinor: payType === "salary" ? rate : rate * 2080n, makerId: a.personId });
  if (!r.required) {
    await q(c, `update employee set status = 'active' where id = $1 and entity_id = $2`, [e.id, co.id]);
    return { id: e.id, employeeNo: no, status: "active" };
  }
  return { id: e.id, employeeNo: no, status: "applicant" };
}

async function employeeOf(c: Client, co: Company, id: unknown) {
  need(typeof id === "string" && UUID.test(id), "no such person");
  const rows = await q<{ id: string; first_name: string; last_name: string; status: string; pay_group_id: string | null;
                         pay_type: string; base_rate_minor: string; position: string | null; profit_object_id: string | null;
                         work_state: string; comp_class_code: string | null; hired_on: string }>(c, `
    select id, first_name, last_name, status, pay_group_id, pay_type, base_rate_minor, position, profit_object_id,
           work_state, comp_class_code, hired_on::text from employee where id = $1 and entity_id = $2`, [id, co.id]);
  need(rows.length, "no such person");
  return rows[0];
}

/**
 * Change someone's details. Position, store, work state and comp class change
 * now, on the record. Pay, pay type or pay group wait on the owner's approval.
 */
export async function changeEmployee(c: Client, co: Company, a: Actor, input: Record<string, unknown>) {
  const e = await employeeOf(c, co, input.id);
  need(e.status === "active" || e.status === "leave", `${e.first_name} ${e.last_name} is ${e.status === "applicant" ? "waiting on approval" : "no longer employed"}`);
  const reason = text(input.reason);
  need(reason, "say why, so the approver and the record both know");
  const s = scopeOf(co, a);

  // Details that do not move money.
  const position = input.position === undefined ? e.position : text(input.position, 60) || null;
  const store = input.storeId === undefined ? e.profit_object_id : await storeOf(c, co, input.storeId);
  const workState = input.workState === undefined ? e.work_state : text(input.workState, 20).toUpperCase();
  need(STATE.test(workState), "the state they work in, as two letters, like TX");
  const comp = input.compClassCode === undefined ? e.comp_class_code : text(input.compClassCode, 10) || null;
  need(!comp || /^\d{4}$/.test(comp), "a workers' comp class code is four digits");
  const details = position !== e.position || store !== e.profit_object_id || workState !== e.work_state || comp !== e.comp_class_code;
  if (details) {
    await q(c, `update employee set position = $3, profit_object_id = $4, work_state = $5, comp_class_code = $6
                 where id = $1 and entity_id = $2`, [e.id, co.id, position, store, workState, comp]);
    await audit(c, s, { table: "employee", rowId: e.id, action: "update",
      before: { position: e.position, store: e.profit_object_id, workState: e.work_state, compClass: e.comp_class_code },
      after: { position, store, workState, compClass: comp }, reason });
  }

  // Pay: proposed, then approved.
  const payType = input.payType === undefined ? e.pay_type : String(input.payType);
  need(PAY_TYPES.includes(payType), "pick hourly or salary");
  const group = input.payGroupId === undefined ? e.pay_group_id : (await groupOf(c, co, input.payGroupId)).id;
  const rate = input.rate === undefined || input.rate === "" ? BigInt(e.base_rate_minor) : rateOf(input.rate, payType);
  need(payType === e.pay_type || (input.rate !== undefined && input.rate !== ""), "a change between hourly and salary needs the new rate too");
  const pay = payType !== e.pay_type || group !== e.pay_group_id || rate !== BigInt(e.base_rate_minor);
  if (!pay) return { details, pay: false };

  const pending = await q(c, `select 1 from employee_change where employee_id = $1 and entity_id = $2 and status = 'pending'`, [e.id, co.id]);
  need(!pending.length, "a pay change for this person is already waiting on approval");
  const ch = await one<{ id: string }>(c, `
    insert into employee_change (tenant_id, entity_id, employee_id, before, after, effective_on, reason, requested_by)
    values ($1, $2, $3, $4, $5, current_date, $6, $7) returning id`,
    [co.tenantId, co.id, e.id,
     JSON.stringify({ pay_group_id: e.pay_group_id, pay_type: e.pay_type, base_rate_minor: e.base_rate_minor }),
     JSON.stringify({ pay_group_id: group, pay_type: payType, base_rate_minor: rate.toString() }),
     reason, a.personId]);
  await audit(c, s, { table: "employee_change", rowId: ch.id, action: "insert",
    before: { payType: e.pay_type, rate: e.base_rate_minor, group: e.pay_group_id }, after: { payType, rate: rate.toString(), group }, reason });
  const r = await openRequest(c, s, { subjectType: "employee_change", subjectId: ch.id,
    amountMinor: payType === "salary" ? rate : rate * 2080n, makerId: a.personId });
  if (!r.required) await applyEmployeeChange(c, co, a, ch.id);
  return { details, pay: true, changeId: ch.id, approval: r.required };
}

async function applyEmployeeChange(c: Client, co: Company, a: Actor, changeId: string) {
  const ch = await one<{ employee_id: string; after: { pay_group_id: string | null; pay_type: string; base_rate_minor: string } }>(c, `
    select employee_id, after from employee_change where id = $1 and entity_id = $2 and status = 'pending'`, [changeId, co.id]);
  await q(c, `update employee set pay_group_id = $3, pay_type = $4, base_rate_minor = $5 where id = $1 and entity_id = $2`,
    [ch.employee_id, co.id, ch.after.pay_group_id, ch.after.pay_type, ch.after.base_rate_minor]);
  await q(c, `update employee_change set status = 'applied', decided_at = now() where id = $1 and entity_id = $2`, [changeId, co.id]);
  await audit(c, scopeOf(co, a), { table: "employee", rowId: ch.employee_id, action: "update", after: ch.after, reason: "pay change approved" });
}

/** Someone leaves. Their last period still pays them up to this day. The controller's or the owner's to record. */
export async function terminateEmployee(c: Client, co: Company, a: Actor, input: Record<string, unknown>) {
  const e = await employeeOf(c, co, input.id);
  const held = await rolesOf(c, co, a.personId);
  need(SIGN_OFF.some((r) => held.has(r)), "ending someone's employment is recorded by the controller or the owner");
  need(e.status === "active" || e.status === "leave", `${e.first_name} ${e.last_name} is not currently employed`);
  need(isDay(input.terminatedOn), "pick the last day worked");
  need((input.terminatedOn as string) >= e.hired_on, "the last day cannot be before the hire date");
  const reason = text(input.reason);
  need(reason, "say why, for the record");
  await q(c, `update employee set status = 'terminated', terminated_on = $3::date where id = $1 and entity_id = $2`,
    [e.id, co.id, input.terminatedOn]);
  await q(c, `update employee_change set status = 'cancelled', decided_at = now()
               where employee_id = $1 and entity_id = $2 and status = 'pending'`, [e.id, co.id]);
  await q(c, `update approval_request set status = 'cancelled', decided_at = now()
               where entity_id = $1 and subject_type = 'employee_change' and status = 'open'
                 and subject_id in (select id from employee_change where employee_id = $2 and entity_id = $1)`, [co.id, e.id]);
  await audit(c, scopeOf(co, a), { table: "employee", rowId: e.id, action: "transition",
    before: { status: e.status }, after: { status: "terminated", terminatedOn: input.terminatedOn }, reason });
  return { status: "terminated" };
}

// ---------------------------------------------------------- new companies
//
// A client company set up from the screen: the client, the company, its chart
// (copied from a client already here), a year of periods, its stores, its bank
// accounts, its people and the approval rules that suit them. Full bank
// account numbers never come here -- only the last four digits and where the
// full numbers are kept.

type Vertical = "rto" | "retail" | "trucking" | "services";
const VERTICALS: Record<Vertical, { location: string; profitObject: string; aging: string; kind: string }> = {
  rto:      { location: "Store",    profitObject: "Store", aging: "Back balances", kind: "store" },
  retail:   { location: "Store",    profitObject: "Store", aging: "Receivables",   kind: "store" },
  trucking: { location: "Terminal", profitObject: "Truck", aging: "Settlements",   kind: "truck" },
  services: { location: "Office",   profitObject: "Job",   aging: "Receivables",   kind: "job" },
};

/** Accounts the engine posts to by number. Every chart gets them, whatever it starts from. */
const REQUIRED_ACCOUNTS: [string, string, string, "D" | "C"][] = [
  ["1010", "Cash, operating", "asset", "D"], ["1020", "Cash, payroll", "asset", "D"],
  ["2010", "Accounts payable", "liability", "C"], ["2150", "Payroll liabilities", "liability", "C"],
  ["2200", "Employee deductions payable", "liability", "C"], ["3900", "Retained earnings", "equity", "C"],
  ["6100", "Wages", "expense", "D"], ["6110", "Payroll taxes", "expense", "D"],
  ["6120", "Employee benefits", "expense", "D"], ["6350", "Card processing fees", "expense", "D"],
];

const ROLES = ["owner", "controller", "approver", "ap_clerk", "viewer"];
const PURPOSES = ["operating", "deposit", "payroll", "tax"];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";

type StoreIn = { code: string; name: string; state: string | null };
type BankIn = { purpose: string; name: string; bankName: string; routingLast4: string; accountLast4: string; storeCode: string | null; ach: boolean };
type PersonIn = { name: string; email: string; roles: string[] };

function storesIn(v: unknown): StoreIn[] {
  const list = Array.isArray(v) ? v : [];
  need(list.length <= 200, "that is more stores than one setup should carry");
  const out = list.map((x: Record<string, unknown>) => {
    const code = text(x?.code, 12).toUpperCase(), name = text(x?.name, 60);
    const state = text(x?.state, 20).toUpperCase() || null;
    need(/^[A-Z0-9-]{2,12}$/.test(code), "each store needs a short code, like ENL");
    need(name.length >= 2, "each store needs a name");
    need(!state || STATE.test(state), "a store's state is two letters, like TX");
    return { code, name, state };
  });
  need(new Set(out.map((s) => s.code)).size === out.length, "two stores have the same code");
  return out;
}

function bankIn(x: Record<string, unknown>, stores: { code: string }[]): BankIn {
  const purpose = text(x?.purpose, 20);
  need(PURPOSES.includes(purpose), "a bank account is operating, deposit, payroll or tax");
  const name = text(x?.name, 60), bankName = text(x?.bankName, 80);
  need(name.length >= 2 && bankName.length >= 2, "a bank account needs a name and the bank's name");
  const routingLast4 = text(x?.routingLast4, 40), accountLast4 = text(x?.accountLast4, 40);
  need(/^\d{4}$/.test(routingLast4) && /^\d{4}$/.test(accountLast4),
    "only the last four digits of the routing and account numbers; the full numbers stay with the bank");
  const storeCode = text(x?.storeCode, 12).toUpperCase() || null;
  need(!storeCode || stores.some((s) => s.code === storeCode), "a deposit account names a store that is not in the list");
  need(purpose !== "deposit" || storeCode, "a deposit account belongs to a store");
  return { purpose, name, bankName, routingLast4, accountLast4, storeCode, ach: x?.ach === true };
}

function banksIn(v: unknown, stores: StoreIn[]): BankIn[] {
  const out = (Array.isArray(v) ? v : []).map((x: Record<string, unknown>) => bankIn(x, stores));
  need(out.filter((b) => b.purpose === "operating").length === 1, "a company has exactly one operating account");
  need(new Set(out.map((b) => b.name.toLowerCase())).size === out.length, "two bank accounts have the same name");
  return out;
}

function personIn(x: Record<string, unknown>): PersonIn {
  const name = text(x?.name, 80), email = text(x?.email, 120).toLowerCase();
  need(name.length >= 2, "each person needs a name");
  need(EMAIL.test(email), `${name || "someone"} needs a working email address`);
  const roles = (Array.isArray(x?.roles) ? x.roles : []).map(String).filter((r: string) => ROLES.includes(r));
  need(roles.length, `${name} needs at least one role`);
  return { name, email, roles: [...new Set(roles)] };
}

function peopleIn(v: unknown): PersonIn[] {
  const out = (Array.isArray(v) ? v : []).map((x: Record<string, unknown>) => personIn(x));
  need(out.some((p) => p.roles.includes("owner")), "someone has to be the owner");
  need(new Set(out.map((p) => p.email)).size === out.length, "two people have the same email address");
  return out;
}

/**
 * Approval rules that fit the people a company actually has: a role nobody
 * holds is never asked for, and nothing is ever left with no one to decide it.
 */
function defaultPolicies(roles: Set<string>) {
  const first = (...rs: string[]) => rs.find((r) => roles.has(r)) ?? "owner";
  const two = (a: string) => (a === "owner" ? [{ seq: 1, role: "owner" }] : [{ seq: 1, role: a }, { seq: 2, role: "owner" }]);
  const one = (r: string) => [{ seq: 1, role: r }];
  const billRole = first("approver", "controller", "owner");
  const books = first("controller", "owner");
  return [
    { subject: "invoice", min: 100_000n, steps: one(billRole), callback: false },
    { subject: "invoice", min: 1_000_000n, steps: billRole === "owner" ? one("owner") : [{ seq: 1, role: billRole }, { seq: 2, role: books === billRole ? "owner" : books }], callback: false },
    { subject: "payment_run", min: 0n, steps: one(books), callback: false },
    { subject: "payroll_run", min: 0n, steps: one("owner"), callback: false },
    { subject: "vendor", min: 0n, steps: one(books), callback: false },
    { subject: "vendor_bank_account", min: 0n, steps: two(books), callback: true },
    { subject: "employee", min: 0n, steps: one("owner"), callback: false },
    { subject: "employee_change", min: 0n, steps: one("owner"), callback: false },
    { subject: "journal_entry", min: 500_000n, steps: one(books), callback: false },
    { subject: "fiscal_period", min: 0n, steps: one(books), callback: false },
  ];
}

/** A year of monthly periods from the start of the fiscal year we are in, plus the three months after it. */
function fiscalMonths(fyEndMonth: number): { startsOn: string; endsOn: string }[] {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  const startMonth = (fyEndMonth % 12) + 1;
  let sy = startMonth <= m ? y : y - 1;
  let sm = startMonth;
  const out = [];
  for (let i = 0; i < 15; i++) {
    const start = new Date(Date.UTC(sy, sm - 1, 1)), end = new Date(Date.UTC(sy, sm, 0));
    out.push({ startsOn: start.toISOString().slice(0, 10), endsOn: end.toISOString().slice(0, 10) });
    sm++; if (sm > 12) { sm = 1; sy++; }
  }
  return out;
}

/**
 * Create a client company from the screen, in one transaction. Done by the
 * operator, who is named on every row it writes; the people entered here are
 * who acts for the company from then on.
 */
export async function createCompany(c: Client, operator: string, input: Record<string, unknown>) {
  const existing = typeof input.clientId === "string" && UUID.test(input.clientId) ? input.clientId : null;
  const companyName = text(input.name, 60), legalName = text(input.legalName, 120);
  need(companyName.length >= 2, "enter the company's name");
  need(legalName.length >= 2, "enter the company's legal name, as on its tax filings");
  const einLast4 = text(input.einLast4, 40) || null;
  need(!einLast4 || /^\d{4}$/.test(einLast4), "only the last four digits of the EIN are kept");
  const fyEnd = Number(input.fiscalYearEndMonth ?? 12);
  need(Number.isInteger(fyEnd) && fyEnd >= 1 && fyEnd <= 12, "pick the month the fiscal year ends");
  const stores = storesIn(input.stores);
  const banks = banksIn(input.banks, stores);
  const people = peopleIn(input.people);

  let tenantId: string;
  let vertical: Vertical;
  if (existing) {
    const t = await q<{ id: string; vertical: Vertical }>(c, `select id, vertical from tenant where id = $1 /* unscoped: the client itself */`, [existing]);
    need(t.length, "no such client");
    tenantId = t[0].id; vertical = t[0].vertical;
  } else {
    const clientName = text(input.clientName, 60);
    need(clientName.length >= 2, "name the client, the business this company belongs to");
    need(["rto", "retail", "trucking", "services"].includes(String(input.vertical)), "pick the kind of business");
    vertical = input.vertical as Vertical;
    const dupe = await q(c, `select 1 from tenant where lower(name) = lower($1) /* unscoped: client names are checked across the install */`, [clientName]);
    need(!dupe.length, `there is already a client called ${clientName}; add the company to it instead`);
    const v = VERTICALS[vertical];
    tenantId = (await one<{ id: string }>(c, `
      insert into tenant (name, vertical, location_label, profit_object_label, aging_label) values ($1, $2, $3, $4, $5) returning id`,
      [clientName, vertical, v.location, v.profitObject, v.aging])).id;
  }
  const dupeCo = await q(c, `select 1 from entity where tenant_id = $1 and lower(name) = lower($2) /* unscoped: names within the client */`, [tenantId, companyName]);
  need(!dupeCo.length, `this client already has a company called ${companyName}`);

  const entityId = (await one<{ id: string }>(c, `
    insert into entity (tenant_id, name, legal_name, ein_last4, fiscal_year_end_month) values ($1, $2, $3, $4, $5) returning id`,
    [tenantId, companyName, legalName, einLast4, fyEnd])).id;
  const scope: Scope = { tenantId, entityId, actor: { kind: "user", label: operator } };

  // The chart: a new client copies one already here; the engine's accounts are always there.
  if (!existing) {
    const from = typeof input.chartFrom === "string" && UUID.test(input.chartFrom) ? input.chartFrom : null;
    if (from) {
      await q(c, `
        insert into gl_account (tenant_id, code, name, account_type, normal_balance, is_postable)
        select $1, code, name, account_type, normal_balance, is_postable from gl_account where tenant_id = $2
        /* unscoped: copying a chart from one client to a new one */`, [tenantId, from]);
    }
    for (const [code, name, type, nb] of REQUIRED_ACCOUNTS) {
      await q(c, `insert into gl_account (tenant_id, code, name, account_type, normal_balance) values ($1, $2, $3, $4, $5)
                  on conflict (tenant_id, code) do nothing`, [tenantId, code, name, type, nb]);
    }
  } else {
    for (const [code, name, type, nb] of REQUIRED_ACCOUNTS) {
      await q(c, `insert into gl_account (tenant_id, code, name, account_type, normal_balance) values ($1, $2, $3, $4, $5)
                  on conflict (tenant_id, code) do nothing`, [tenantId, code, name, type, nb]);
    }
  }
  await q(c, `insert into entity_gl_account (entity_id, gl_account_id)
              select $1, id from gl_account where tenant_id = $2 /* unscoped: the new company takes the client's chart */`,
    [entityId, tenantId]);
  const acct = async (code: string) => (await one<{ id: string }>(c, `
    select id from gl_account where tenant_id = $1 and code = $2 /* unscoped: the chart is client-wide */`, [tenantId, code])).id;

  for (const p of fiscalMonths(fyEnd)) {
    await q(c, `insert into fiscal_period (entity_id, starts_on, ends_on) values ($1, $2, $3)`, [entityId, p.startsOn, p.endsOn]);
  }

  // Stores: a location and a profit object each (a truck or a job has no location).
  const kind = VERTICALS[vertical].kind;
  const locationOf = new Map<string, string>();
  for (const st of stores) {
    let locationId: string | null = null;
    if (kind === "store") {
      locationId = (await one<{ id: string }>(c, `
        insert into location (entity_id, code, name, state) values ($1, $2, $3, $4) returning id`,
        [entityId, st.code, st.name, st.state])).id;
      locationOf.set(st.code, locationId);
    }
    await q(c, `insert into profit_object (entity_id, kind, code, name, location_id) values ($1, $2, $3, $4, $5)`,
      [entityId, kind, st.code, st.name, locationId]);
  }

  // Bank accounts: the numbers stay at the bank; this keeps where, and the last four digits.
  const cashOperating = await acct("1010"), cashPayroll = await acct("1020"), fees = await acct("6350");
  const tslug = slug(existing ? companyName : text(input.clientName, 60));
  const defaults = new Set<string>();
  for (const b of banks) {
    const key = `${b.storeCode ?? ""}|${b.purpose}`;
    const isDefault = !defaults.has(key);
    defaults.add(key);
    await q(c, `
      insert into bank_account (tenant_id, entity_id, name, purpose, bank_name, routing_last4, account_last4, account_ref,
                                gl_account_id, ach_origination_enabled, location_id, is_default, fee_gl_account_id)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [tenantId, entityId, b.name, b.purpose, b.bankName, b.routingLast4, b.accountLast4,
       `vault://${tslug}/${slug(companyName)}/${slug(b.name)}`,
       b.purpose === "payroll" ? cashPayroll : cashOperating, b.ach && b.purpose !== "deposit",
       b.storeCode ? locationOf.get(b.storeCode) ?? null : null, isDefault, b.purpose === "deposit" ? fees : null]);
  }

  // People and their roles for this company.
  const held = new Set<string>();
  for (const p of people) {
    const found = await q<{ id: string }>(c, `
      select id from app_user where tenant_id = $1 and lower(email) = $2 /* unscoped: people belong to the client */`, [tenantId, p.email]);
    const userId = found.length ? found[0].id : (await one<{ id: string }>(c, `
      insert into app_user (tenant_id, email, name) values ($1, $2, $3) returning id`, [tenantId, p.email, p.name])).id;
    for (const r of p.roles) {
      await q(c, `insert into role_grant (app_user_id, entity_id, role) values ($1, $2, $3) on conflict do nothing`, [userId, entityId, r]);
      held.add(r);
    }
  }

  for (const pol of defaultPolicies(held)) {
    await q(c, `insert into approval_policy (entity_id, subject_type, min_amount_minor, steps, requires_callback)
                values ($1, $2, $3, $4, $5) on conflict do nothing`,
      [entityId, pol.subject, pol.min.toString(), JSON.stringify(pol.steps), pol.callback]);
  }

  await audit(c, scope, { table: "entity", rowId: entityId, action: "insert",
    after: { name: companyName, legalName, stores: stores.length, banks: banks.length, people: people.length, newClient: !existing },
    reason: "company set up from the screen" });
  const warn = people.length < 2 ? "With one person, nothing they enter can be approved: add a second person before real work starts." : null;
  return { id: entityId, tenantId, warning: warn };
}

/** What can change on a company after setup is the owner's to do. */
async function mustOwn(c: Client, co: Company, a: Actor, what: string) {
  const held = await rolesOf(c, co, a.personId);
  need(held.has("owner"), `${what} is for the owner`);
}

export async function addStore(c: Client, co: Company, a: Actor, input: Record<string, unknown>) {
  await mustOwn(c, co, a, "adding a store");
  const [st] = storesIn([input]);
  const dupe = await q(c, `select 1 from profit_object where entity_id = $1 and code = $2`, [co.id, st.code]);
  need(!dupe.length, `there is already a ${co.profitObjectLabel.toLowerCase()} with the code ${st.code}`);
  const t = await one<{ vertical: Vertical }>(c, `select vertical from tenant where id = $1 /* unscoped: the client itself */`, [co.tenantId]);
  const kind = VERTICALS[t.vertical].kind;
  let locationId: string | null = null;
  if (kind === "store") {
    locationId = (await one<{ id: string }>(c, `insert into location (entity_id, code, name, state) values ($1, $2, $3, $4) returning id`,
      [co.id, st.code, st.name, st.state])).id;
  }
  const po = await one<{ id: string }>(c, `insert into profit_object (entity_id, kind, code, name, location_id) values ($1, $2, $3, $4, $5) returning id`,
    [co.id, kind, st.code, st.name, locationId]);
  await audit(c, scopeOf(co, a), { table: "profit_object", rowId: po.id, action: "insert", after: st, reason: "added from the screen" });
  return { id: po.id };
}

export async function addBankAccount(c: Client, co: Company, a: Actor, input: Record<string, unknown>) {
  await mustOwn(c, co, a, "adding a bank account");
  const stores = await q<{ code: string; name: string; location_id: string | null }>(c, `
    select code, name, location_id from profit_object where entity_id = $1 and status = 'active'`, [co.id]);
  const b = bankIn(input, stores);
  if (b.purpose === "operating") {
    const op = await q(c, `select 1 from bank_account where entity_id = $1 and purpose = 'operating' and status = 'active'`, [co.id]);
    need(!op.length, "this company already has its operating account");
  }
  const dupe = await q(c, `select 1 from bank_account where entity_id = $1 and lower(name) = lower($2)`, [co.id, b.name]);
  need(!dupe.length, `there is already an account called ${b.name}`);
  const code = b.purpose === "payroll" ? "1020" : "1010";
  const gl = await one<{ id: string }>(c, `select id from gl_account where tenant_id = $1 and code = $2 /* unscoped: the chart is client-wide */`, [co.tenantId, code]);
  const fee = await q<{ id: string }>(c, `select id from gl_account where tenant_id = $1 and code = '6350' /* unscoped: the chart is client-wide */`, [co.tenantId]);
  const store = b.storeCode ? stores.find((s) => s.code === b.storeCode) : null;
  const t = await one<{ name: string }>(c, `select name from tenant where id = $1 /* unscoped: the client itself */`, [co.tenantId]);
  const row = await one<{ id: string }>(c, `
    insert into bank_account (tenant_id, entity_id, name, purpose, bank_name, routing_last4, account_last4, account_ref,
                              gl_account_id, ach_origination_enabled, location_id, fee_gl_account_id)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
    [co.tenantId, co.id, b.name, b.purpose, b.bankName, b.routingLast4, b.accountLast4,
     `vault://${slug(t.name)}/${slug(co.name)}/${slug(b.name)}`, gl.id, b.ach && b.purpose !== "deposit",
     store?.location_id ?? null, b.purpose === "deposit" && fee.length ? fee[0].id : null]);
  await audit(c, scopeOf(co, a), { table: "bank_account", rowId: row.id, action: "insert",
    after: { name: b.name, purpose: b.purpose, bank: b.bankName, last4: b.accountLast4 }, reason: "added from the screen" });
  return { id: row.id };
}

export async function addPerson(c: Client, co: Company, a: Actor, input: Record<string, unknown>) {
  await mustOwn(c, co, a, "adding a person");
  const p = personIn(input);
  const found = await q<{ id: string }>(c, `
    select id from app_user where tenant_id = $1 and lower(email) = $2 /* unscoped: people belong to the client */`, [co.tenantId, p.email]);
  const userId = found.length ? found[0].id : (await one<{ id: string }>(c, `
    insert into app_user (tenant_id, email, name) values ($1, $2, $3) returning id`, [co.tenantId, p.email, p.name])).id;
  for (const r of p.roles) {
    await q(c, `insert into role_grant (app_user_id, entity_id, role, granted_by) values ($1, $2, $3, $4) on conflict do nothing`,
      [userId, co.id, r, a.personId]);
  }
  await audit(c, scopeOf(co, a), { table: "app_user", rowId: userId, action: "insert", after: { name: p.name, email: p.email, roles: p.roles }, reason: "added from the screen" });
  return { id: userId };
}

/** Replace what someone may do in this company. The last owner cannot be removed. */
export async function setRoles(c: Client, co: Company, a: Actor, input: Record<string, unknown>) {
  await mustOwn(c, co, a, "changing who can do what");
  need(typeof input.personId === "string" && UUID.test(input.personId), "no such person");
  const roles = (Array.isArray(input.roles) ? input.roles : []).map(String).filter((r) => ROLES.includes(r));
  const person = await q<{ id: string; name: string }>(c, `
    select u.id, u.name from app_user u where u.id = $1 and u.tenant_id = $2
    /* unscoped: people belong to the client */`, [input.personId, co.tenantId]);
  need(person.length, "that person is not part of this client");
  if (!roles.includes("owner")) {
    // Who is still an owner afterwards: anyone else, or this person through a
    // client-wide grant, which this screen does not touch.
    const owners = await q<{ app_user_id: string; client_wide: boolean }>(c, `
      select g.app_user_id, (g.entity_id is null) as client_wide from role_grant g join app_user u on u.id = g.app_user_id
       where g.role = 'owner' and u.status = 'active' and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = $2))`, [co.id, co.tenantId]);
    need(owners.some((o) => o.app_user_id !== input.personId || o.client_wide), "the company would have no owner left");
  }
  const before = await q<{ role: string }>(c, `select role from role_grant where app_user_id = $1 and entity_id = $2`, [input.personId, co.id]);
  await q(c, `delete from role_grant where app_user_id = $1 and entity_id = $2`, [input.personId, co.id]);
  for (const r of roles) {
    await q(c, `insert into role_grant (app_user_id, entity_id, role, granted_by) values ($1, $2, $3, $4)`, [input.personId, co.id, r, a.personId]);
  }
  await audit(c, scopeOf(co, a), { table: "role_grant", rowId: input.personId as string, action: "update",
    before: { roles: before.map((r) => r.role) }, after: { roles }, reason: `roles set for ${person[0].name}` });
  return { roles };
}
