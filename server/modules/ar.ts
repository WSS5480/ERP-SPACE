// ar module -- complete receivables. See docs/MODULES.md for the contract.
//
// Every handler is exported (H) so the checks in scripts/modules/ar.ts call
// exactly what a route calls, role checks included. The rules live in
// packages/core/ar.ts; this file decides who may do what, reads requests,
// and turns the engine's refusals into sentences.

import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { ModuleError, need, requireRole, str, uuid, int, minor } from "./kit.ts";
import { scopeOf } from "../actions.ts";
import { q, one } from "../../packages/core/db.ts";
import { PostingError } from "../../packages/core/posting.ts";
import * as ar from "../../packages/core/ar.ts";

const today = () => new Date().toISOString().slice(0, 10);
const day = (v: unknown, dflt: string) => { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : dflt; };
const B = (v: unknown) => BigInt(String(v ?? 0));

/** The engine's refusals are written for people: pass them on as ModuleError (a 422). */
function wrap<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  return async (...a: A) => {
    try { return await fn(...a); }
    catch (e) {
      if (e instanceof ar.ArError || e instanceof PostingError) throw new ModuleError(e.message);
      throw e;
    }
  };
}

const ROLES = {
  take: ["ar_clerk", "cashier", "controller", "store_manager"],
  collect: ["ar_clerk", "controller", "store_manager"],
  note: ["ar_clerk", "controller", "store_manager", "sales", "cashier"],
  clerk: ["ar_clerk", "controller"],
  control: ["controller"],
  finance: ["ar_clerk", "controller", "cashier", "sales", "store_manager"],
};

export async function agingLabel(c: Client, co: Company): Promise<string> {
  const r = await q<{ aging_label: string }>(c, `select t.aging_label from tenant t where t.id = $1 /* unscoped: tenant label */`, [co.tenantId]);
  return r[0]?.aging_label || "Receivables";
}

async function customerOr(c: Client, co: Company, id: unknown) {
  const cid = uuid(id);
  need(cid, "no such customer");
  const r = await q<{ id: string }>(c, `select id from customer where id = $1 and entity_id = $2`, [cid, co.id]);
  need(r.length, "no such customer");
  return cid;
}

async function locationFor(c: Client, co: Company, v: unknown, customerId: string | null): Promise<string> {
  const id = uuid(v);
  if (id) {
    const r = await q(c, `select 1 from location where id = $1 and entity_id = $2`, [id, co.id]);
    need(r.length, "pick the store that took the money");
    return id;
  }
  if (customerId) {
    const h = await q<{ home_location_id: string | null }>(c, `select home_location_id from customer where id = $1 and entity_id = $2`, [customerId, co.id]);
    if (h[0]?.home_location_id) return h[0].home_location_id;
  }
  const any = await q<{ id: string }>(c, `select id from location where entity_id = $1 and kind = 'store' order by code limit 1`, [co.id]);
  need(any.length, "set up a store first");
  return any[0].id;
}

function applyFrom(b: Record<string, unknown>): ar.Apply {
  if (!Array.isArray(b.apply)) return "oldest";
  return (b.apply as Record<string, unknown>[]).map((x) => {
    const id = uuid(x.invoiceId);
    need(id, "one of the invoices named is not valid");
    return { invoiceId: id, amountMinor: minor(x.amount) };
  });
}

// =================================================================== reads

export const H = {
  summary: wrap(async (c: Client, co: Company) => {
    const label = await agingLabel(c, co);
    const ag = await ar.aging(c, co.id);
    const dep = await ar.depositLiability(c, co.id);
    const calls = await ar.callList(c, co.id);
    const pending = await q<{ n: number; s: string }>(c, `select count(*)::int n, coalesce(sum(amount_minor),0)::text s from ar_writeoff where entity_id = $1 and status = 'pending'`, [co.id]);
    const fin = await q<{ n: number; s: string }>(c, `select count(*)::int n, coalesce(sum(amount_minor),0)::text s from financed_sale where entity_id = $1 and status = 'awaiting_funding'`, [co.id]);
    const contracts = await q<{ n: number }>(c, `select count(*)::int n from ar_contract where entity_id = $1 and status in ('active','defaulted')`, [co.id]);
    return { label, aging: ag.totals, glMinor: ag.glMinor, differenceMinor: ag.differenceMinor, byLocation: ag.locations,
      deposits: { totalMinor: dep.totalMinor, glMinor: dep.glMinor, differenceMinor: dep.differenceMinor },
      callList: calls.length, pendingWriteoffs: pending[0], awaitingFunding: { n: fin[0].n, totalMinor: fin[0].s, gl1110Minor: await ar.glBalance(c, co.id, "1110") },
      activeContracts: contracts[0].n };
  }),

  customers: wrap(async (c: Client, co: Company, search: string) => {
    const s = search.trim().toLowerCase();
    return q(c, `
      select cu.id, cu.number, cu.name, cu.phone, cu.email, cu.status, cu.credit_limit_minor, cu.terms_days,
             coalesce(a.house_account, false) house_account,
             coalesce((select sum(l.amount_minor) from ar_ledger l where l.entity_id = $1 and l.customer_id = cu.id), 0)::text balance_minor
        from customer cu left join ar_account a on a.customer_id = cu.id
       where cu.entity_id = $1
         and ($2 = '' or lower(cu.name) like '%' || $2 || '%' or cu.number ilike '%' || $2 || '%' or coalesce(cu.phone,'') like '%' || $2 || '%')
       order by (coalesce((select sum(l.amount_minor) from ar_ledger l where l.entity_id = $1 and l.customer_id = cu.id), 0) = 0), cu.name
       limit 200`, [co.id, s]);
  }),

  account: wrap(async (c: Client, co: Company, id: string) => {
    const cid = await customerOr(c, co, id);
    const cu = await one(c, `select cu.id, cu.number, cu.name, cu.kind, cu.email, cu.phone, cu.status, cu.credit_limit_minor, cu.terms_days,
                                    cu.home_location_id, lo.name home_location, coalesce(a.house_account,false) house_account,
                                    coalesce(a.late_fees,true) late_fees, coalesce(a.statement_via,'email') statement_via,
                                    a.collector_id, u.name collector
                               from customer cu left join ar_account a on a.customer_id = cu.id
                               left join location lo on lo.id = cu.home_location_id left join app_user u on u.id = a.collector_id
                              where cu.id = $1 and cu.entity_id = $2`, [cid, co.id]);
    // One client runs one query at a time.
    const balance = await ar.customerBalance(c, co.id, cid);
    const unapplied = await ar.unappliedCash(c, co.id, cid);
    const storeCredit = await ar.storeCreditBalance(c, co.id, cid);
    const invoices = await ar.openInvoices(c, co.id, cid);
    const deposits = await ar.depositsOnHand(c, co.id, cid);
    const ag = await ar.aging(c, co.id, today(), cid);
    const orders = await q(c, `select so.id, so.number, so.status, so.channel, so.ordered_at::date::text ordered_on, so.total_minor, so.paid_minor,
                                      lo.name location from sales_order so join location lo on lo.id = so.location_id
                                where so.entity_id = $1 and so.customer_id = $2 order by so.ordered_at desc limit 50`, [co.id, cid]);
    const receipts = await q(c, `select r.id, r.number, r.method, r.amount_minor, r.received_at::text, r.voided_at, so.number order_number,
                                        (p.receipt_id is not null) on_account
                                   from customer_receipt r left join sales_order so on so.id = r.sales_order_id
                                   left join ar_payment p on p.receipt_id = r.id
                                  where r.entity_id = $1 and r.customer_id = $2 order by r.received_at desc limit 50`, [co.id, cid]);
    const allInvoices = await q(c, `select i.id, i.number, i.kind, i.invoice_date::text, i.due_date::text, i.total_minor, i.charged_minor, i.status
                                      from customer_invoice i where i.entity_id = $1 and i.customer_id = $2 order by i.invoice_date desc, i.number desc limit 50`, [co.id, cid]);
    const contracts = await q(c, `select k.id, k.number, k.status, k.principal_minor, k.apr_bps, k.term_months, k.payment_minor,
                                         coalesce((select sum(l.amount_minor) from ar_ledger l where l.entity_id = $1 and l.contract_id = k.id), 0)::text balance_minor
                                    from ar_contract k where k.entity_id = $1 and k.customer_id = $2 order by k.opened_at desc`, [co.id, cid]);
    const notes = await q(c, `select n.id, n.body, n.created_at::text, u.name author from ar_note n left join app_user u on u.id = n.author_id
                               where n.entity_id = $1 and n.customer_id = $2 order by n.created_at desc limit 50`, [co.id, cid]);
    const actions = await q(c, `select x.id, x.kind, x.outcome, x.notes, x.callback_at::text, x.at::text, u.name by
                                  from ar_collection_action x left join app_user u on u.id = x.by_id
                                 where x.entity_id = $1 and x.customer_id = $2 order by x.at desc limit 30`, [co.id, cid]);
    const promises = await q(c, `select id, promised_on::text, amount_minor, status, created_at::text from ar_promise
                                  where entity_id = $1 and customer_id = $2 order by created_at desc limit 20`, [co.id, cid]);
    const label = await agingLabel(c, co);
    return { label, customer: cu, balanceMinor: balance, unappliedMinor: unapplied, storeCreditMinor: storeCredit,
      availableCreditMinor: cu.house_account ? B(cu.credit_limit_minor) - balance : 0n,
      aging: ag.totals, openInvoices: invoices, invoices: allInvoices, deposits, orders, receipts, contracts, notes, actions, promises };
  }),

  invoice: wrap(async (c: Client, co: Company, id: string) => {
    const iid = uuid(id); need(iid, "no such invoice");
    const inv = await q(c, `select i.*, i.invoice_date::text invoice_date, i.due_date::text due_date, cu.name customer, cu.number customer_number,
                                   lo.name location, so.number order_number, e.name company, e.legal_name
                              from customer_invoice i left join customer cu on cu.id = i.customer_id
                              left join location lo on lo.id = i.location_id left join sales_order so on so.id = i.sales_order_id
                              join entity e on e.id = i.entity_id
                             where i.id = $1 and i.entity_id = $2`, [iid, co.id]);
    need(inv.length, "no such invoice");
    const lines = await q(c, `select seq, sku, description, qty, unit_price_minor, discount_minor, net_minor, tax_minor from customer_invoice_line
                               where entity_id = $1 and invoice_id = $2 order by seq`, [co.id, iid]);
    const activity = await q(c, `select l.occurred_on::text, l.kind, l.amount_minor, l.memo, r.number receipt from ar_ledger l
                                  left join customer_receipt r on r.id = l.receipt_id
                                  where l.entity_id = $1 and l.invoice_id = $2 order by l.created_at`, [co.id, iid]);
    const open = activity.reduce((a, x) => a + B(x.amount_minor), 0n);
    return { invoice: inv[0], lines, activity, openMinor: open };
  }),

  statement: wrap(async (c: Client, co: Company, id: string, from: string, to: string) => {
    const cid = await customerOr(c, co, id);
    const st = await ar.statement(c, co.id, cid, from, to);
    const e = await one<{ name: string; legal_name: string }>(c, `select name, legal_name from entity where id = $1 /* unscoped: the company itself */`, [co.id]);
    return { ...st, company: e, label: await agingLabel(c, co) };
  }),

  creditCheck: wrap(async (c: Client, co: Company, id: string, amount: string, orderId: string | null) => {
    const cid = await customerOr(c, co, id);
    return ar.creditCheck(c, co.id, cid, minor(amount || "0"), uuid(orderId));
  }),

  aging: wrap(async (c: Client, co: Company, asOf: string) => ({ label: await agingLabel(c, co), ...(await ar.aging(c, co.id, asOf)) })),

  callList: wrap(async (c: Client, co: Company, asOf: string) => {
    const list = await ar.callList(c, co.id, asOf);
    const templates = await q(c, `select code, channel, name from ar_template where entity_id = $1 and active order by channel, name`, [co.id]);
    return { label: await agingLabel(c, co), asOf, list, templates };
  }),

  templates: wrap(async (c: Client, co: Company) =>
    q(c, `select id, code, channel, name, subject, body, active from ar_template where entity_id = $1 order by channel, name`, [co.id])),

  writeoffs: wrap(async (c: Client, co: Company) => q(c, `
    select w.id, w.status, w.amount_minor, w.method, w.reason, w.requested_at::text, w.decided_at::text, w.decision_note, w.recovered_minor,
           w.requested_by, ru.name requested_by_name, du.name decided_by_name, cu.name customer, w.customer_id,
           coalesce(i.number, k.number) target
      from ar_writeoff w join customer cu on cu.id = w.customer_id
      left join customer_invoice i on i.id = w.invoice_id left join ar_contract k on k.id = w.contract_id
      left join app_user ru on ru.id = w.requested_by left join app_user du on du.id = w.decided_by
     where w.entity_id = $1 order by (w.status = 'pending') desc, w.requested_at desc limit 100`, [co.id])),

  contracts: wrap(async (c: Client, co: Company) => q(c, `
    select k.id, k.number, k.status, k.principal_minor, k.apr_bps, k.term_months, k.payment_minor, k.first_due_on::text, cu.name customer, k.customer_id,
           coalesce((select sum(l.amount_minor) from ar_ledger l where l.entity_id = $1 and l.contract_id = k.id), 0)::text balance_minor,
           (select min(i.due_on)::text from ar_contract_installment i where i.entity_id = $1 and i.contract_id = k.id and i.status = 'due') next_due,
           (select count(*)::int from ar_contract_installment i where i.entity_id = $1 and i.contract_id = k.id and i.status = 'due' and i.due_on < current_date) late_installments
      from ar_contract k join customer cu on cu.id = k.customer_id
     where k.entity_id = $1 order by (k.status in ('active','defaulted')) desc, k.opened_at desc limit 200`, [co.id])),

  contract: wrap(async (c: Client, co: Company, id: string) => {
    const kid = uuid(id); need(kid, "no such contract");
    const k = await q(c, `select k.*, k.first_due_on::text first_due_on, cu.name customer, i.number invoice_number
                            from ar_contract k join customer cu on cu.id = k.customer_id left join customer_invoice i on i.id = k.invoice_id
                           where k.id = $1 and k.entity_id = $2`, [kid, co.id]);
    need(k.length, "no such contract");
    const schedule = await q(c, `select id, version, seq, due_on::text, payment_minor, principal_minor, interest_minor, paid_principal_minor, paid_interest_minor, status
                                   from ar_contract_installment where entity_id = $1 and contract_id = $2 and (status <> 'superseded' or paid_principal_minor + paid_interest_minor > 0)
                                  order by version, seq`, [co.id, kid]);
    const events = await q(c, `select e.kind, e.detail, e.reason, e.at::text, u.name by from ar_contract_event e left join app_user u on u.id = e.by_id
                                where e.entity_id = $1 and e.contract_id = $2 order by e.at`, [co.id, kid]);
    const repos = await q(c, `select id, status, items, scheduled_on::text, recovered_on::text, condition, notes, updated_at::text
                               from ar_repossession where entity_id = $1 and contract_id = $2 order by created_at`, [co.id, kid]);
    const payoff = await ar.payoffQuote(c, co.id, kid);
    return { contract: k[0], schedule, events, repossessions: repos, payoff };
  }),

  payoff: wrap(async (c: Client, co: Company, id: string, asOf: string) => {
    const kid = uuid(id); need(kid, "no such contract");
    return ar.payoffQuote(c, co.id, kid, asOf);
  }),

  amortize: wrap(async (_c: Client, _co: Company, principal: string, apr: string, term: string, first: string) => {
    const s = ar.amortize(minor(principal || "0"), Math.round(Number(apr || 0) * 100), int(term), first);
    const interest = s.rows.reduce((a, r) => a + r.interestMinor, 0n);
    return { ...s, totalInterestMinor: interest };
  }),

  finance: wrap(async (c: Client, co: Company) => {
    const companies = await q(c, `select id, name, cascade_rank, default_fee_bps, apply_url, status from finance_company where entity_id = $1 order by cascade_rank, name`, [co.id]);
    const plans = await q(c, `select id, company_id, code, name, promo_months, customer_apr_bps, fee_bps, min_amount_minor, max_amount_minor, active
                                from finance_plan where entity_id = $1 order by company_id, promo_months desc`, [co.id]);
    const awaiting = await q(c, `select f.id, f.company_id, f.amount_minor, f.expected_fee_minor, f.fee_bps, f.created_at::date::text on_date,
                                        r.number receipt, cu.name customer, so.number order_number, p.name plan
                                   from financed_sale f join customer_receipt r on r.id = f.receipt_id
                                   left join customer cu on cu.id = f.customer_id left join sales_order so on so.id = f.sales_order_id
                                   left join finance_plan p on p.id = f.plan_id
                                  where f.entity_id = $1 and f.status = 'awaiting_funding' order by f.created_at`, [co.id]);
    const settlements = await q(c, `select s.id, s.company_id, fc.name company, s.reference, s.funded_on::text, s.gross_minor, s.funded_minor,
                                           s.fee_minor, s.expected_fee_minor, (s.fee_minor - s.expected_fee_minor)::text variance_minor
                                      from finance_settlement s join finance_company fc on fc.id = s.company_id
                                     where s.entity_id = $1 order by s.funded_on desc, s.created_at desc limit 50`, [co.id]);
    const unrecorded = await q(c, `select r.id, r.number, r.amount_minor, r.received_at::date::text on_date, cu.name customer
                                     from customer_receipt r left join customer cu on cu.id = r.customer_id
                                    where r.entity_id = $1 and r.method = 'financing' and r.voided_at is null and r.amount_minor > 0
                                      and not exists (select 1 from financed_sale f where f.receipt_id = r.id) order by r.received_at`, [co.id]);
    const owed = awaiting.reduce((a, x) => a + B(x.amount_minor), 0n);
    const gl = await ar.glBalance(c, co.id, "1110");
    return { companies, plans, awaiting, settlements, unrecorded, owedMinor: owed, gl1110Minor: gl,
      differenceMinor: owed + unrecorded.reduce((a, x) => a + B(x.amount_minor), 0n) - gl };
  }),

  cascade: wrap(async (c: Client, co: Company, amount: string, orderId: string | null) => ar.lenderCascade(c, co.id, minor(amount || "0"), uuid(orderId))),

  deposits: wrap(async (c: Client, co: Company) => ar.depositLiability(c, co.id)),

  settings: wrap(async (c: Client, co: Company) => ({ label: await agingLabel(c, co), ...(await ar.settings(c, co.id)) })),

  // ================================================================ writes

  setAccount: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.control, "changing an account's limit, terms or status");
    const cid = await customerOr(c, co, id);
    await ar.setAccount(c, scopeOf(co, a), cid, {
      houseAccount: typeof b.houseAccount === "boolean" ? b.houseAccount : undefined,
      creditLimitMinor: b.creditLimit !== undefined && b.creditLimit !== "" ? minor(b.creditLimit) : undefined,
      termsDays: b.termsDays !== undefined && b.termsDays !== "" ? int(b.termsDays, -1) : undefined,
      lateFees: typeof b.lateFees === "boolean" ? b.lateFees : undefined,
      status: b.status ? str(b.status, 20) : undefined,
      statementVia: b.statementVia ? str(b.statementVia, 10) : undefined,
      collectorId: b.collectorId === null ? null : uuid(b.collectorId) ?? undefined,
    });
    return { ok: true };
  }),

  addNote: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.note, "adding an account note");
    const cid = await customerOr(c, co, id);
    return { noteId: await ar.addNote(c, scopeOf(co, a), cid, str(b.body, 2000)) };
  }),

  pay: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.take, "taking a payment");
    const cid = await customerOr(c, co, id);
    const loc = await locationFor(c, co, b.locationId, cid);
    return ar.receivePayment(c, scopeOf(co, a), {
      customerId: cid, amountMinor: minor(b.amount), method: str(b.method, 20) || "cash", locationId: loc, reference: str(b.reference, 40) || null,
      channel: ["pos", "phone", "mail", "ach", "lockbox", "web"].includes(str(b.channel, 10)) ? str(b.channel, 10) : "pos",
      apply: applyFrom(b), overpayment: b.overpayment === "store_credit" ? "store_credit" : "unapplied",
      salesOrderId: uuid(b.salesOrderId),
    });
  }),

  applyCredits: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.take, "applying credits");
    const cid = await customerOr(c, co, id);
    return ar.applyCredits(c, scopeOf(co, a), cid, applyFrom(b));
  }),

  toStoreCredit: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.clerk, "turning a credit balance into store credit");
    const cid = await customerOr(c, co, id);
    return { journalEntryId: await ar.creditToStoreCredit(c, scopeOf(co, a), cid, minor(b.amount), str(b.reason)) };
  }),

  override: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.control, "approving a charge past the credit limit");
    const cid = await customerOr(c, co, id);
    return { overrideId: await ar.grantOverride(c, scopeOf(co, a), { customerId: cid, orderId: uuid(b.salesOrderId), upToMinor: minor(b.upTo),
      reason: str(b.reason), approvedBy: a.personId }) };
  }),

  lateFees: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.clerk, "charging late fees");
    const fees = await ar.assessLateFees(c, scopeOf(co, a), day(b.asOf, today()));
    return { charged: fees.length, totalMinor: fees.reduce((x, f) => x + f.feeMinor, 0n), fees };
  }),

  refreshPromises: wrap(async (c: Client, co: Company, a: Actor) => {
    await requireRole(c, co, a, ROLES.collect, "updating promises to pay");
    return ar.refreshPromises(c, scopeOf(co, a));
  }),

  logAction: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.collect, "logging a collections contact");
    const cid = await customerOr(c, co, id);
    const s = scopeOf(co, a);
    await ar.refreshPromises(c, s);
    const p = b.promise as Record<string, unknown> | undefined;
    return ar.logAction(c, s, { customerId: cid, kind: str(b.kind, 10) || "call", outcome: str(b.outcome, 20) || null, notes: str(b.notes, 2000),
      callbackAt: str(b.callbackAt, 40) || null, promise: p ? { on: str(p.on, 10), amountMinor: minor(p.amount) } : null });
  }),

  send: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.collect, "sending a collections message");
    const cid = await customerOr(c, co, id);
    return ar.sendTemplate(c, scopeOf(co, a), new ar.RecordOnlyProvider(), cid, str(b.template, 40));
  }),

  requestWriteoff: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ["ar_clerk", "controller"], "asking for a write-off");
    const method = b.method === "direct" ? "direct" : b.method === "allowance" ? "allowance" : undefined;
    return { writeoffId: await ar.requestWriteoff(c, scopeOf(co, a), { invoiceId: uuid(b.invoiceId), contractId: uuid(b.contractId),
      amountMinor: minor(b.amount), reason: str(b.reason), method, requestedBy: a.personId }) };
  }),

  decideWriteoff: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.control, "approving a write-off");
    const wid = uuid(id); need(wid, "no such write-off");
    need(b.decision === "approved" || b.decision === "rejected", "approve it or reject it");
    return ar.decideWriteoff(c, scopeOf(co, a), wid, { decision: b.decision, by: a.personId, note: str(b.note) });
  }),

  recover: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.clerk, "recording a recovery");
    const wid = uuid(id); need(wid, "no such write-off");
    const loc = await locationFor(c, co, b.locationId, null);
    return ar.recordRecovery(c, scopeOf(co, a), wid, { amountMinor: minor(b.amount), method: str(b.method, 20) || "cash", locationId: loc,
      reference: str(b.reference, 40) || null });
  }),

  openContract: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.clerk, "opening an installment contract");
    const iid = uuid(b.invoiceId); need(iid, "pick the invoice to finance");
    return ar.openContract(c, scopeOf(co, a), { invoiceId: iid, principalMinor: b.principal ? minor(b.principal) : undefined,
      aprBps: Math.round(Number(b.apr ?? 0) * 100), termMonths: int(b.termMonths), firstDueOn: str(b.firstDueOn, 10) || undefined });
  }),

  payContract: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.take, "taking a contract payment");
    const kid = uuid(id); need(kid, "no such contract");
    const k = await one<{ customer_id: string }>(c, `select customer_id from ar_contract where id = $1 and entity_id = $2`, [kid, co.id]).catch(() => null);
    need(k, "no such contract");
    const loc = await locationFor(c, co, b.locationId, k.customer_id);
    return ar.payContract(c, scopeOf(co, a), kid, { amountMinor: minor(b.amount), method: str(b.method, 20) || "cash", locationId: loc,
      reference: str(b.reference, 40) || null });
  }),

  restructure: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    const kind = str(b.kind, 10) as "defer" | "extend" | "refinance";
    need(["defer", "extend", "refinance"].includes(kind), "defer, extend or refinance");
    await requireRole(c, co, a, kind === "defer" ? ROLES.clerk : ROLES.control, kind === "defer" ? "deferring payments" : `a contract ${kind}`);
    const kid = uuid(id); need(kid, "no such contract");
    return ar.restructure(c, scopeOf(co, a), kid, { kind, months: int(b.months), termMonths: int(b.termMonths),
      aprBps: b.apr !== undefined ? Math.round(Number(b.apr) * 100) : undefined, reason: str(b.reason) });
  }),

  setDefault: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.clerk, "putting a contract in default");
    const kid = uuid(id); need(kid, "no such contract");
    await ar.setContractDefault(c, scopeOf(co, a), kid, b.defaulted !== false, str(b.reason));
    return { ok: true };
  }),

  repossession: wrap(async (c: Client, co: Company, a: Actor, id: string, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.clerk, "recording a repossession");
    const kid = uuid(id); need(kid, "no such contract");
    return { id: await ar.recordRepossession(c, scopeOf(co, a), { contractId: kid, id: uuid(b.id) ?? undefined, status: str(b.status, 20) || undefined,
      items: str(b.items, 1000) || undefined, scheduledOn: str(b.scheduledOn, 10) || null, recoveredOn: str(b.recoveredOn, 10) || null,
      condition: str(b.condition, 200) || null, notes: str(b.notes, 2000) || null }) };
  }),

  application: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.finance, "recording a finance application");
    const cid = await customerOr(c, co, b.customerId);
    const fid = uuid(b.companyId); need(fid, "pick the finance company");
    const d = str(b.decision, 10) as "approved" | "declined" | "pending";
    return { applicationId: await ar.recordApplication(c, scopeOf(co, a), { orderId: uuid(b.salesOrderId), customerId: cid, companyId: fid,
      planId: uuid(b.planId), requestedMinor: minor(b.requested), approvedMinor: b.approved ? minor(b.approved) : null, decision: d,
      reference: str(b.reference, 60) || null }), cascade: await ar.lenderCascade(c, co.id, minor(b.requested), uuid(b.salesOrderId)) };
  }),

  financedSale: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.finance, "recording a financed sale");
    const rid = uuid(b.receiptId); need(rid, "pick the financing receipt");
    const pid = uuid(b.planId); need(pid, "pick the plan");
    return ar.recordFinancedSale(c, scopeOf(co, a), rid, pid);
  }),

  settle: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.clerk, "recording a finance company's funding");
    const fid = uuid(b.companyId); need(fid, "pick the finance company");
    const ids = Array.isArray(b.saleIds) ? (b.saleIds as unknown[]).map(uuid).filter((x): x is string => !!x) : [];
    return ar.settleFinanceBatch(c, scopeOf(co, a), { companyId: fid, saleIds: ids, fundedMinor: minor(b.funded), reference: str(b.reference, 60),
      fundedOn: str(b.fundedOn, 10) || undefined });
  }),

  saveSettings: wrap(async (c: Client, co: Company, a: Actor, b: Record<string, unknown>) => {
    await requireRole(c, co, a, ROLES.control, "changing the A/R settings");
    const bpsOf = (v: unknown) => Math.round(Number(v) * 100);
    const s = await ar.settings(c, co.id);
    const next = {
      enabled: typeof b.lateFeeEnabled === "boolean" ? b.lateFeeEnabled : s.late_fee_enabled,
      rate: b.lateFeeRate !== undefined ? bpsOf(b.lateFeeRate) : s.late_fee_bps,
      grace: b.graceDays !== undefined ? int(b.graceDays, -1) : s.late_fee_grace_days,
      min: b.minFee !== undefined ? minor(b.minFee) : B(s.late_fee_min_minor),
      max: b.maxFee === "" || b.maxFee === null ? null : b.maxFee !== undefined ? minor(b.maxFee) : (s.late_fee_max_minor === null ? null : B(s.late_fee_max_minor)),
      terms: b.defaultTerms !== undefined ? int(b.defaultTerms, -1) : s.default_terms_days,
      method: b.writeoffMethod === "direct" ? "direct" : b.writeoffMethod === "allowance" ? "allowance" : s.writeoff_method,
      callAfter: b.callAfterDays !== undefined ? int(b.callAfterDays, -1) : s.call_after_days,
    };
    need(next.rate >= 0 && next.rate <= 2500, "a late-fee rate is 0% to 25% a month");
    need(next.grace >= 0 && next.grace <= 90, "grace is 0 to 90 days");
    need(next.terms >= 0 && next.terms <= 180, "terms are 0 to 180 days");
    need(next.callAfter >= 0, "call-after days cannot be negative");
    await c.query(`insert into ar_settings (entity_id, late_fee_enabled, late_fee_bps, late_fee_grace_days, late_fee_min_minor, late_fee_max_minor,
                     default_terms_days, writeoff_method, call_after_days)
                   values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                   on conflict (entity_id) do update set late_fee_enabled = $2, late_fee_bps = $3, late_fee_grace_days = $4, late_fee_min_minor = $5,
                     late_fee_max_minor = $6, default_terms_days = $7, writeoff_method = $8, call_after_days = $9, updated_at = now()`,
      [co.id, next.enabled, next.rate, next.grace, next.min.toString(), next.max?.toString() ?? null, next.terms, next.method, next.callAfter]);
    return { ok: true };
  }),
};

const ID = "([0-9a-fA-F-]{36})";

export const module: ErpModule = {
  id: "ar",
  register(kit) {
    const g = (u: URL, k: string) => u.searchParams.get(k) ?? "";
    kit.coGet("/ar/summary", (c, co) => H.summary(c, co));
    kit.coGet("/ar/customers", (c, co, u) => H.customers(c, co, g(u, "q")));
    kit.coGet(`/ar/customers/${ID}`, (c, co, _u, m) => H.account(c, co, m[2]));
    kit.coGet(`/ar/customers/${ID}/statement`, (c, co, u, m) => {
      const t = day(g(u, "to"), today());
      return H.statement(c, co, m[2], day(g(u, "from"), t.slice(0, 8) + "01"), t);
    });
    kit.coGet(`/ar/customers/${ID}/credit-check`, (c, co, u, m) => H.creditCheck(c, co, m[2], g(u, "amount"), g(u, "order") || null));
    kit.coGet(`/ar/invoices/${ID}`, (c, co, _u, m) => H.invoice(c, co, m[2]));
    kit.coGet("/ar/aging", (c, co, u) => H.aging(c, co, day(g(u, "asOf"), today())));
    kit.coGet("/ar/collections", (c, co, u) => H.callList(c, co, day(g(u, "asOf"), today())));
    kit.coGet("/ar/templates", (c, co) => H.templates(c, co));
    kit.coGet("/ar/writeoffs", (c, co) => H.writeoffs(c, co));
    kit.coGet("/ar/contracts", (c, co) => H.contracts(c, co));
    kit.coGet(`/ar/contracts/${ID}`, (c, co, _u, m) => H.contract(c, co, m[2]));
    kit.coGet(`/ar/contracts/${ID}/payoff`, (c, co, u, m) => H.payoff(c, co, m[2], day(g(u, "asOf"), today())));
    kit.coGet("/ar/amortize", (c, co, u) => H.amortize(c, co, g(u, "principal"), g(u, "apr"), g(u, "term"), day(g(u, "first"), today())));
    kit.coGet("/ar/finance", (c, co) => H.finance(c, co));
    kit.coGet("/ar/finance/cascade", (c, co, u) => H.cascade(c, co, g(u, "amount"), g(u, "order") || null));
    kit.coGet("/ar/deposits", (c, co) => H.deposits(c, co));
    kit.coGet("/ar/settings", (c, co) => H.settings(c, co));

    kit.coPost(`/ar/customers/${ID}/account`, (c, co, a, b, m) => H.setAccount(c, co, a, m[2], b));
    kit.coPost(`/ar/customers/${ID}/notes`, (c, co, a, b, m) => H.addNote(c, co, a, m[2], b));
    kit.coPost(`/ar/customers/${ID}/payments`, (c, co, a, b, m) => H.pay(c, co, a, m[2], b));
    kit.coPost(`/ar/customers/${ID}/apply`, (c, co, a, b, m) => H.applyCredits(c, co, a, m[2], b));
    kit.coPost(`/ar/customers/${ID}/store-credit`, (c, co, a, b, m) => H.toStoreCredit(c, co, a, m[2], b));
    kit.coPost(`/ar/customers/${ID}/overrides`, (c, co, a, b, m) => H.override(c, co, a, m[2], b));
    kit.coPost(`/ar/collections/${ID}/actions`, (c, co, a, b, m) => H.logAction(c, co, a, m[2], b));
    kit.coPost(`/ar/collections/${ID}/send`, (c, co, a, b, m) => H.send(c, co, a, m[2], b));
    kit.coPost("/ar/collections/refresh", (c, co, a) => H.refreshPromises(c, co, a));
    kit.coPost("/ar/late-fees", (c, co, a, b) => H.lateFees(c, co, a, b));
    kit.coPost("/ar/writeoffs", (c, co, a, b) => H.requestWriteoff(c, co, a, b));
    kit.coPost(`/ar/writeoffs/${ID}/decide`, (c, co, a, b, m) => H.decideWriteoff(c, co, a, m[2], b));
    kit.coPost(`/ar/writeoffs/${ID}/recover`, (c, co, a, b, m) => H.recover(c, co, a, m[2], b));
    kit.coPost("/ar/contracts", (c, co, a, b) => H.openContract(c, co, a, b));
    kit.coPost(`/ar/contracts/${ID}/pay`, (c, co, a, b, m) => H.payContract(c, co, a, m[2], b));
    kit.coPost(`/ar/contracts/${ID}/restructure`, (c, co, a, b, m) => H.restructure(c, co, a, m[2], b));
    kit.coPost(`/ar/contracts/${ID}/default`, (c, co, a, b, m) => H.setDefault(c, co, a, m[2], b));
    kit.coPost(`/ar/contracts/${ID}/repossession`, (c, co, a, b, m) => H.repossession(c, co, a, m[2], b));
    kit.coPost("/ar/finance/applications", (c, co, a, b) => H.application(c, co, a, b));
    kit.coPost("/ar/finance/sales", (c, co, a, b) => H.financedSale(c, co, a, b));
    kit.coPost("/ar/finance/settlements", (c, co, a, b) => H.settle(c, co, a, b));
    kit.coPost("/ar/settings", (c, co, a, b) => H.saveSettings(c, co, a, b));
  },
};
