// Finance company settlements: part of A/R's third-party finance (ar.ts
// recordFinancedSale / settleFinanceBatch). A lender (Synchrony, Wells Fargo,
// Acima, Progressive...) owes us each financed sale less its discount
// (merchant fee) and any holdback, and later takes back chargebacks. Their
// remittance file is imported with a column mapping per lender, each row is
// matched to our financed sale by approval (auth) code, or by the account's
// last four with the amount and date, and posted:
//
//   funding            Dr cash (the lender's bank account, else 1050)  net
//                      Dr 6910 card and finance fees                   the fee they kept
//                      Dr 1115 finance holdbacks receivable            the holdback
//                                                                Cr 1110 the sale
//   holdback released  Dr cash                                  Cr 1115
//   chargeback, reopen Dr 1110 the sale (owed again)            Cr cash taken back, Cr 1115 the open holdback,
//                                                               Cr/Dr 6910 the fee given back (the rest)
//   chargeback, expense Dr 6915 finance chargebacks             Cr cash (and Cr 1115 any open holdback)
//
// A row that matches nothing (or matches but does not add up) is an exception
// for a person, never a guess. The fee taken is checked against the plan's
// rate (promotional plans differ) and flagged past the lender's tolerance.
// When everything in a file is posted and the lender's bank account is known,
// the deposit is linked to its bank statement line through reconciliation.

import { createHash } from "node:crypto";
import { q, one, audit, type Client, type Scope } from "./db.ts";
import { post, type PostLine } from "./posting.ts";
import { mulBps, format } from "./money.ts";
import { splitRow, parseDate } from "./statements.ts";
import { matchManually } from "./reconcile.ts";

export class SettlementError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new SettlementError(msg); };
const B = (v: string | number | bigint | null | undefined) => BigInt(v ?? 0);
const $ = (m: bigint) => format(m);
const today = () => new Date().toISOString().slice(0, 10);

export type RemitMapping = {
  date: string; auth?: string; account?: string; gross?: string; fee?: string; holdback?: string; net?: string;
  kind?: string; reason?: string; plan?: string;
  dateFormat?: "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD"; delimiter?: string; skipRows?: number;
  /** values in the kind column that mean a chargeback or a holdback release (case does not matter; a value containing one counts) */
  chargeback?: string[]; release?: string[];
};
const DEFAULT_CB = ["chargeback", "charge back", "reversal", "reverse", "cb"];
const DEFAULT_REL = ["holdback release", "reserve release", "release"];

export function checkMapping(m: unknown): RemitMapping {
  need(m && typeof m === "object", "set the lender's column mapping first");
  const x = m as RemitMapping;
  const col = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= 60;
  need(col(x.date), "the mapping needs the date column");
  need(col(x.auth) || col(x.account), "the mapping needs the approval (auth) code column, the account number column, or both");
  need(col(x.net) || col(x.gross), "the mapping needs the net (funded) amount column or the sale (gross) amount column");
  for (const k of ["gross", "fee", "holdback", "net", "kind", "reason", "plan", "auth", "account"] as const) need(x[k] === undefined || x[k] === "" || col(x[k]), `the ${k} column name is not usable`);
  need(!x.dateFormat || ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"].includes(x.dateFormat), "dates are MM/DD/YYYY, DD/MM/YYYY or YYYY-MM-DD");
  need(!x.delimiter || [",", ";", "\t", "|"].includes(x.delimiter), "columns are split by a comma, semicolon, tab or bar");
  need(x.skipRows === undefined || (Number.isInteger(x.skipRows) && x.skipRows >= 0 && x.skipRows <= 20), "skip 0 to 20 rows above the header");
  const words = (v: unknown) => Array.isArray(v) ? v.map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 20) : undefined;
  return { ...x, chargeback: words(x.chargeback), release: words(x.release) };
}

/** Set a lender's file layout, where their deposits land, fee tolerance and what a chargeback does. */
export async function setLender(c: Client, scope: Scope, companyId: string, e: { mapping?: unknown; bankAccountId?: string | null; feeToleranceMinor?: bigint; chargebackMode?: string }) {
  const co = await q<{ id: string; name: string }>(c, `select id, name from finance_company where id = $1 and entity_id = $2`, [companyId, scope.entityId]);
  need(co.length, "no such finance company");
  if (e.mapping !== undefined) await c.query(`update finance_company set remit_mapping = $3 where id = $1 and entity_id = $2`, [companyId, scope.entityId, JSON.stringify(checkMapping(e.mapping))]);
  if (e.bankAccountId !== undefined) {
    if (e.bankAccountId) need((await q(c, `select 1 from bank_account where id = $1 and entity_id = $2 and status = 'active'`, [e.bankAccountId, scope.entityId])).length, "no such bank account");
    await c.query(`update finance_company set bank_account_id = $3 where id = $1 and entity_id = $2`, [companyId, scope.entityId, e.bankAccountId || null]);
  }
  if (e.feeToleranceMinor !== undefined) {
    need(e.feeToleranceMinor >= 0n, "the fee tolerance cannot be negative");
    await c.query(`update finance_company set fee_tolerance_minor = $3 where id = $1 and entity_id = $2`, [companyId, scope.entityId, e.feeToleranceMinor.toString()]);
  }
  if (e.chargebackMode !== undefined) {
    need(["reopen", "expense"].includes(e.chargebackMode), "a chargeback either reopens the sale (the lender owes it again) or is written off to expense");
    await c.query(`update finance_company set chargeback_mode = $3 where id = $1 and entity_id = $2`, [companyId, scope.entityId, e.chargebackMode]);
  }
  await audit(c, scope, { table: "finance_company", rowId: companyId, action: "update", after: { mapping: e.mapping !== undefined, bank: e.bankAccountId, tolerance: e.feeToleranceMinor?.toString(), chargeback: e.chargebackMode } });
  return { companyId };
}

// -------------------------------------------------------------- parsing --

export type RemitRow = { rowNo: number; kind: "funding" | "holdback_release" | "chargeback"; txnOn: string | null; auth: string | null; last4: string | null; plan: string | null;
  grossMinor: bigint; feeMinor: bigint; holdbackMinor: bigint; netMinor: bigint; reason: string | null; problem: string | null };

function money(v: string | undefined): bigint | null {
  const s = String(v ?? "").replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!s) return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new SettlementError(`${String(v).slice(0, 20)} is not an amount`);
  const cents = BigInt(m[2]) * 100n + BigInt((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -cents : cents;
}

export function parseRemit(text: string, mp: RemitMapping): RemitRow[] {
  const delim = mp.delimiter ?? ",";
  const rows = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/).filter((r) => r.trim().length);
  const start = mp.skipRows ?? 0;
  need(rows.length > start + 1, "the file has no rows under its header");
  need(rows.length <= 20001, "the file has more than 20,000 rows; split it");
  const header = splitRow(rows[start], delim).map((h) => h.toLowerCase());
  const at = (name?: string) => (name ? header.indexOf(name.trim().toLowerCase()) : -1);
  const idx = { date: at(mp.date), auth: at(mp.auth), account: at(mp.account), gross: at(mp.gross), fee: at(mp.fee), holdback: at(mp.holdback), net: at(mp.net),
    kind: at(mp.kind), reason: at(mp.reason), plan: at(mp.plan) };
  need(idx.date >= 0, `the file has no "${mp.date}" column`);
  for (const k of ["auth", "account", "gross", "fee", "holdback", "net", "kind", "reason", "plan"] as const) {
    if (mp[k] && idx[k] < 0) throw new SettlementError(`the file has no "${mp[k]}" column`);
  }
  const cb = mp.chargeback?.length ? mp.chargeback : DEFAULT_CB, rel = mp.release?.length ? mp.release : DEFAULT_REL;
  const out: RemitRow[] = [];
  for (let r = start + 1; r < rows.length; r++) {
    const cells = splitRow(rows[r], delim);
    const cell = (i: number) => (i >= 0 ? cells[i] ?? "" : "");
    const row: RemitRow = { rowNo: r - start, kind: "funding", txnOn: null, auth: null, last4: null, plan: null, grossMinor: 0n, feeMinor: 0n, holdbackMinor: 0n, netMinor: 0n,
      reason: cell(idx.reason).slice(0, 200) || null, problem: null };
    try {
      row.txnOn = parseDate(cell(idx.date), mp.dateFormat ?? "YYYY-MM-DD");
      const auth = cell(idx.auth).trim().toUpperCase();
      row.auth = auth && /^[\x21-\x7e]{1,40}$/.test(auth) ? auth : null;
      const digits = cell(idx.account).replace(/\D/g, "");
      row.last4 = digits.length >= 4 ? digits.slice(-4) : null;       // never the whole account number
      row.plan = cell(idx.plan).trim().toUpperCase().slice(0, 30) || null;
      const gross = money(cell(idx.gross)), fee = money(cell(idx.fee)) ?? 0n, hold = money(cell(idx.holdback)) ?? 0n, net = money(cell(idx.net));
      const kindText = cell(idx.kind).trim().toLowerCase();
      if (kindText && rel.some((w) => kindText.includes(w))) row.kind = "holdback_release";
      else if (kindText && cb.some((w) => kindText === w || kindText.includes(w))) row.kind = "chargeback";
      else if (!kindText && (net ?? gross ?? 0n) < 0n) row.kind = "chargeback";
      if (row.kind === "funding") {
        row.grossMinor = gross ?? (net ?? 0n) + fee + hold;
        row.feeMinor = fee; row.holdbackMinor = hold;
        row.netMinor = net ?? row.grossMinor - fee - hold;
        if (row.grossMinor - fee - hold !== row.netMinor) row.problem = `the sale ${$(row.grossMinor)} less fee ${$(fee)} and holdback ${$(hold)} is not the ${$(row.netMinor)} funded`;
        else if (row.grossMinor <= 0n) row.problem = "a funding row has no sale amount";
      } else if (row.kind === "holdback_release") {
        const amt = net ?? gross ?? 0n;
        row.netMinor = amt < 0n ? -amt : amt;
        if (row.netMinor === 0n) row.problem = "a holdback release of nothing";
      } else {
        const amt = net ?? gross ?? 0n;
        row.netMinor = amt > 0n ? -amt : amt;                       // money taken back
        row.grossMinor = gross != null ? (gross < 0n ? -gross : gross) : 0n;
        if (row.netMinor === 0n) row.problem = "a chargeback of nothing";
      }
    } catch (e) {
      if (!(e instanceof SettlementError) && !(e instanceof Error)) throw e;
      row.problem = (e as Error).message;
    }
    if (!row.auth && !row.last4 && !row.problem) row.problem = "the row carries neither an approval code nor an account number";
    out.push(row);
  }
  return out;
}

// ------------------------------------------------------------- matching --

type Sale = { id: string; amount_minor: string; fee_bps: number; status: string; holdback_open_minor: string; funded_minor: string; fee_taken_minor: string;
  plan_id: string | null; on_day: string; auth_code: string | null; receipt: string };

async function findSale(c: Client, entityId: string, companyId: string, row: RemitRow): Promise<{ sale?: Sale; why?: string }> {
  const status = row.kind === "funding" ? ["awaiting_funding"] : ["funded"];
  const cols = `f.id, f.amount_minor, f.fee_bps, f.status, f.holdback_open_minor, f.funded_minor, f.fee_taken_minor, f.plan_id, f.created_at::date::text on_day, f.auth_code, r.number receipt`;
  if (row.auth) {
    const r = await q<Sale>(c, `select ${cols} from financed_sale f join customer_receipt r on r.id = f.receipt_id
      where f.entity_id = $1 and f.company_id = $2 and upper(f.auth_code) = $3 and f.status = any($4) for update of f`, [entityId, companyId, row.auth, status]);
    if (r.length === 1) return { sale: r[0] };
    if (r.length > 1) return { why: `${r.length} financed sales carry approval ${row.auth}` };
  }
  if (row.last4) {
    const amt = row.kind === "funding" ? row.grossMinor : row.kind === "holdback_release" ? row.netMinor : -row.netMinor;
    const amtRule = row.kind === "funding" ? "f.amount_minor = $5" : row.kind === "holdback_release" ? "f.holdback_open_minor >= $5" : "f.amount_minor >= $5";
    const r = await q<Sale>(c, `select ${cols} from financed_sale f join customer_receipt r on r.id = f.receipt_id
      where f.entity_id = $1 and f.company_id = $2 and f.account_last4 = $3 and f.status = any($4) and ${amtRule}
        and ($6::date is null or abs(f.created_at::date - $6::date) <= case when $7 = 'funding' then 10 else 180 end)
      order by f.created_at for update of f`, [entityId, companyId, row.last4, status, amt.toString(), row.txnOn, row.kind]);
    if (r.length === 1) return { sale: r[0] };
    if (r.length > 1) return { why: `${r.length} financed sales on account ending ${row.last4} fit ${$(amt)}; pick the right one` };
  }
  const what = row.kind === "funding" ? "awaiting funding" : row.kind === "holdback_release" ? "with a holdback open" : "funded";
  return { why: `no financed sale ${what} matches ${row.auth ? `approval ${row.auth}` : ""}${row.auth && row.last4 ? " or " : ""}${row.last4 ? `account ending ${row.last4}` : ""}` };
}

type Lender = { id: string; name: string; fee_tolerance_minor: string; chargeback_mode: "reopen" | "expense"; bank_account_id: string | null; remit_mapping: unknown };

async function lenderOf(c: Client, entityId: string, companyId: string): Promise<Lender> {
  const r = await q<Lender>(c, `select id, name, fee_tolerance_minor, chargeback_mode, bank_account_id, remit_mapping from finance_company where id = $1 and entity_id = $2`, [companyId, entityId]);
  need(r.length, "no such finance company");
  return r[0];
}

async function cashCode(c: Client, entityId: string, bankAccountId: string | null): Promise<{ code: string; bankAccountId: string | null }> {
  if (!bankAccountId) return { code: "1050", bankAccountId: null };
  const r = await q<{ code: string }>(c, `select g.code from bank_account ba join gl_account g on g.id = ba.gl_account_id where ba.id = $1 and ba.entity_id = $2`, [bankAccountId, entityId]);
  return r.length ? { code: r[0].code, bankAccountId } : { code: "1050", bankAccountId: null };
}

/** What one matched row posts and does to its sale. Returns the ledger lines (cash apart) and an update to run. */
async function plan(c: Client, entityId: string, lender: Lender, row: RemitRow, sale: Sale): Promise<{ lines: PostLine[]; cash: bigint; problem?: string;
  apply: (je: string) => Promise<void>; feeInfo?: { expected: bigint; variance: bigint; flag: boolean }; mode?: "reopen" | "expense" }> {
  const amount = B(sale.amount_minor);
  if (row.kind === "funding") {
    if (row.grossMinor !== amount) return { lines: [], cash: 0n, apply: async () => {}, problem: `sale ${sale.receipt} was ${$(amount)}; the lender funded it as ${$(row.grossMinor)}` };
    let bps = sale.fee_bps;
    if (row.plan) {
      const p = await q<{ fee_bps: number }>(c, `select fee_bps from finance_plan where entity_id = $1 and company_id = $2 and upper(code) = $3`, [entityId, lender.id, row.plan]);
      if (p.length) bps = p[0].fee_bps;
    }
    const expected = mulBps(amount, bps);
    const variance = row.feeMinor - expected;
    const flag = (variance < 0n ? -variance : variance) > B(lender.fee_tolerance_minor);
    const lines: PostLine[] = [{ code: "1110", credit: amount, memo: `financed sale ${sale.receipt}` }];
    if (row.feeMinor > 0n) lines.push({ code: "6910", debit: row.feeMinor, memo: `${lender.name} discount on ${sale.receipt}` });
    if (row.feeMinor < 0n) lines.push({ code: "6910", credit: -row.feeMinor, memo: `${lender.name} paid over the sale on ${sale.receipt}` });
    if (row.holdbackMinor > 0n) lines.push({ code: "1115", debit: row.holdbackMinor, memo: `${lender.name} holdback on ${sale.receipt}` });
    need(row.holdbackMinor >= 0n, "a holdback cannot be negative");
    return { lines, cash: row.netMinor, feeInfo: { expected, variance, flag }, apply: async () => {
      await c.query(`update financed_sale set status = 'funded', funded_minor = $3, fee_taken_minor = $4, holdback_minor = $5, holdback_open_minor = $5, funded_on = $6
        where id = $1 and entity_id = $2`, [sale.id, entityId, row.netMinor.toString(), row.feeMinor.toString(), row.holdbackMinor.toString(), row.txnOn ?? today()]);
    } };
  }
  if (row.kind === "holdback_release") {
    const open = B(sale.holdback_open_minor);
    if (row.netMinor > open) return { lines: [], cash: 0n, apply: async () => {}, problem: `${sale.receipt} has ${$(open)} held back, not ${$(row.netMinor)}` };
    return { lines: [{ code: "1115", credit: row.netMinor, memo: `${lender.name} released the holdback on ${sale.receipt}` }], cash: row.netMinor, apply: async () => {
      await c.query(`update financed_sale set holdback_open_minor = holdback_open_minor - $3 where id = $1 and entity_id = $2`, [sale.id, entityId, row.netMinor.toString()]);
    } };
  }
  // chargeback: what they took back
  const taken = -row.netMinor;
  const open = B(sale.holdback_open_minor);
  const reason = row.reason || `chargeback by ${lender.name} (no reason given in the file)`;
  if (taken > amount) return { lines: [], cash: 0n, apply: async () => {}, problem: `${lender.name} took back ${$(taken)}, more than the ${$(amount)} sale ${sale.receipt}` };
  const mode = lender.chargeback_mode;
  if (mode === "reopen") {
    const rest = amount - taken - open;            // the fee they kept, now given back (or more taken than they sent: more fee)
    const lines: PostLine[] = [{ code: "1110", debit: amount, memo: `${sale.receipt} reopened: ${reason}`.slice(0, 200) }];
    if (open > 0n) lines.push({ code: "1115", credit: open, memo: `holdback on ${sale.receipt} will not be released` });
    if (rest > 0n) lines.push({ code: "6910", credit: rest, memo: `${lender.name} fee on ${sale.receipt} reversed` });
    if (rest < 0n) lines.push({ code: "6910", debit: -rest, memo: `${lender.name} took back more than it funded on ${sale.receipt}` });
    return { lines, cash: -taken, mode, apply: async () => {
      await c.query(`update financed_sale set status = 'awaiting_funding', funded_minor = 0, fee_taken_minor = 0, holdback_minor = 0, holdback_open_minor = 0, funded_on = null,
          chargeback_reason = $3, chargeback_at = now() where id = $1 and entity_id = $2`, [sale.id, entityId, reason.slice(0, 300)]);
    } };
  }
  const lines: PostLine[] = [{ code: "6915", debit: taken + open, memo: `${sale.receipt}: ${reason}`.slice(0, 200) }];
  if (open > 0n) lines.push({ code: "1115", credit: open, memo: `holdback on ${sale.receipt} will not be released` });
  return { lines, cash: -taken, mode, apply: async () => {
    await c.query(`update financed_sale set status = 'charged_off', holdback_open_minor = 0, chargeback_reason = $3, chargeback_at = now() where id = $1 and entity_id = $2`,
      [sale.id, entityId, reason.slice(0, 300)]);
  } };
}

/** Post a batch of planned rows as one entry with one cash line (the deposit), and mark the rows posted. */
async function postRows(c: Client, scope: Scope, lender: Lender, importId: string, importNo: string, on: string,
  done: { lineId: string; saleId: string; p: Awaited<ReturnType<typeof plan>> }[]): Promise<bigint> {
  if (!done.length) return 0n;
  const cash = done.reduce((a, d) => a + d.p.cash, 0n);
  const acct = await cashCode(c, scope.entityId, lender.bank_account_id);
  const lines: PostLine[] = [];
  if (cash > 0n) lines.push({ code: acct.code, debit: cash, bankAccountId: acct.bankAccountId, memo: `${lender.name} deposit ${importNo}` });
  if (cash < 0n) lines.push({ code: acct.code, credit: -cash, bankAccountId: acct.bankAccountId, memo: `${lender.name} debit ${importNo}` });
  for (const d of done) lines.push(...d.p.lines);
  const je = await post(c, scope, { date: on, sourceType: "finance", sourceId: importId, description: `${lender.name} settlement ${importNo}`, lines });
  const cl = cash !== 0n ? (await q<{ id: string }>(c, `select id from journal_line where journal_entry_id = $1 order by seq limit 1 /* unscoped: entry just posted for this company */`, [je]))[0]?.id ?? null : null;
  for (const d of done) {
    await d.p.apply(je);
    await c.query(`update finance_remit_line set status = 'posted', exception = null, financed_sale_id = $3, journal_entry_id = $4, cash_line_id = $5,
        expected_fee_minor = $6, fee_variance_minor = $7, fee_flag = $8, chargeback_mode = $9, resolved_by = $10, resolved_at = now()
      where id = $1 and entity_id = $2`, [d.lineId, scope.entityId, d.saleId, je, cl, d.p.feeInfo?.expected.toString() ?? null, d.p.feeInfo?.variance.toString() ?? null,
        d.p.feeInfo?.flag ?? false, d.p.mode ?? null, scope.actor.id || null]);
  }
  return cash;
}

// --------------------------------------------------------------- import --

/** Import a lender's settlement file: match, post what matches, list the rest as exceptions, link the deposit to the bank. */
export async function importRemittance(c: Client, scope: Scope, e: { companyId: string; filename?: string | null; text: string; depositOn?: string | null }) {
  const lender = await lenderOf(c, scope.entityId, e.companyId);
  const mapping = checkMapping(lender.remit_mapping);
  need(typeof e.text === "string" && e.text.trim().length, "the file is empty");
  need(e.text.length <= 5_000_000, "the file is over 5 MB; split it");
  const sha = createHash("sha256").update(e.text).digest("hex");
  const dup = await q<{ number: string }>(c, `select number from finance_remit_import where entity_id = $1 and company_id = $2 and sha256 = $3`, [scope.entityId, e.companyId, sha]);
  need(!dup.length, `this file was already imported as ${dup[0]?.number}`);
  const rows = parseRemit(e.text, mapping);
  const number = (await q<{ n: string }>(c, `select next_doc_no($1, 'finance_remit', 'FR-') n /* unscoped: numbering keyed by entity argument */`, [scope.entityId]))[0].n;
  const net = rows.reduce((a, r) => a + r.netMinor, 0n);
  const depositOn = e.depositOn && /^\d{4}-\d{2}-\d{2}$/.test(e.depositOn) ? e.depositOn
    : rows.map((r) => r.txnOn).filter(Boolean).sort().pop() ?? today();
  need(depositOn <= today(), "the deposit date is today or earlier");
  const imp = await one<{ id: string }>(c, `insert into finance_remit_import (entity_id, company_id, number, filename, sha256, rows, net_minor, deposit_on, imported_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [scope.entityId, e.companyId, number, e.filename?.slice(0, 200) ?? null, sha, rows.length, net.toString(), depositOn, scope.actor.id || null]);
  const done: { lineId: string; saleId: string; p: Awaited<ReturnType<typeof plan>> }[] = [];
  const usedSales = new Set<string>();
  let exceptions = 0;
  for (const r of rows) {
    let problem = r.problem;
    let sale: Sale | undefined;
    if (!problem) { const f = await findSale(c, scope.entityId, e.companyId, r); sale = f.sale; problem = f.why ?? null; }
    if (sale && usedSales.has(sale.id)) { problem = `sale ${sale.receipt} is on this file twice`; sale = undefined; }
    let p: Awaited<ReturnType<typeof plan>> | undefined;
    if (sale && !problem) { p = await plan(c, scope.entityId, lender, r, sale); problem = p.problem ?? null; }
    const ln = await one<{ id: string }>(c, `insert into finance_remit_line (entity_id, import_id, row_no, kind, txn_on, auth_code, account_last4, plan_code, gross_minor, fee_minor,
        holdback_minor, net_minor, reason, status, exception, financed_sale_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
      [scope.entityId, imp.id, r.rowNo, r.kind, r.txnOn, r.auth, r.last4, r.plan, r.grossMinor.toString(), r.feeMinor.toString(), r.holdbackMinor.toString(), r.netMinor.toString(),
       r.reason, problem ? "exception" : "dismissed", problem ?? null, problem ? null : sale!.id]);
    if (problem) { exceptions++; continue; }
    usedSales.add(sale!.id);
    done.push({ lineId: ln.id, saleId: sale!.id, p: p! });
  }
  const posted = await postRows(c, scope, lender, imp.id, number, depositOn, done);
  await c.query(`update finance_remit_import set matched = $3, exceptions = $4, posted_minor = $5 where id = $1 and entity_id = $2`,
    [imp.id, scope.entityId, done.length, exceptions, posted.toString()]);
  await audit(c, scope, { table: "finance_remit_import", rowId: imp.id, action: "insert", after: { number, rows: rows.length, matched: done.length, exceptions } });
  const bank = await linkDeposit(c, scope, imp.id);
  const flagged = done.filter((d) => d.p.feeInfo?.flag).length;
  return { importId: imp.id, number, rows: rows.length, matched: done.length, exceptions, netMinor: net, postedMinor: posted, feeFlags: flagged, bankLinked: bank.linked, bankNote: bank.note };
}

/**
 * Link a settlement's deposit to its bank statement line: once every row is
 * posted or dismissed, the posted cash equals the file, and the lender's bank
 * account has exactly one unmatched line of that amount near the deposit day.
 * A statement line can be named instead (a person picked it).
 */
export async function linkDeposit(c: Client, scope: Scope, importId: string, statementLineId: string | null = null): Promise<{ linked: boolean; note: string | null }> {
  const r = await q<{ id: string; number: string; company_id: string; net_minor: string; posted_minor: string; deposit_on: string; bank_statement_line_id: string | null;
    open: string; bank_account_id: string | null }>(c, `
    select i.id, i.number, i.company_id, i.net_minor, i.posted_minor, i.deposit_on::text deposit_on, i.bank_statement_line_id, fc.bank_account_id,
           (select count(*) from finance_remit_line l where l.import_id = i.id and l.entity_id = i.entity_id and l.status = 'exception')::text open
      from finance_remit_import i join finance_company fc on fc.id = i.company_id where i.id = $1 and i.entity_id = $2 for update of i`, [importId, scope.entityId]);
  need(r.length, "no such settlement import");
  const x = r[0];
  if (x.bank_statement_line_id) return { linked: true, note: null };
  if (Number(x.open)) return { linked: false, note: `${x.open} exception(s) still open, so the deposit is not linked to the bank yet` };
  if (!x.bank_account_id) return { linked: false, note: "the lender has no bank account set, so the deposit was posted to undeposited funds (1050)" };
  const posted = B(x.posted_minor);
  if (posted === 0n) return { linked: false, note: "nothing reached the bank from this file" };
  let lineId = statementLineId;
  if (!lineId) {
    const cand = await q<{ id: string }>(c, `select bsl.id from bank_statement_line bsl join bank_statement bs on bs.id = bsl.bank_statement_id
       join bank_account ba on ba.id = bs.bank_account_id
      where ba.entity_id = $1 and ba.id = $2 and bsl.match_status = 'unmatched' and bsl.amount_minor = $3
        and bsl.posted_on between $4::date - 3 and $4::date + 5 order by bsl.posted_on`, [scope.entityId, x.bank_account_id, posted.toString(), x.deposit_on]);
    if (cand.length !== 1) return { linked: false, note: cand.length ? `${cand.length} bank lines of ${$(posted)} fit; pick one` : `no bank line of ${$(posted)} near ${x.deposit_on} yet` };
    lineId = cand[0].id;
  } else {
    const bl = await q<{ amount_minor: string; match_status: string }>(c, `select bsl.amount_minor, bsl.match_status from bank_statement_line bsl
      join bank_statement bs on bs.id = bsl.bank_statement_id join bank_account ba on ba.id = bs.bank_account_id where bsl.id = $1 and ba.entity_id = $2`, [lineId, scope.entityId]);
    need(bl.length, "no such bank statement line");
    need(bl[0].match_status === "unmatched", "that bank line is already matched");
    need(B(bl[0].amount_minor) === posted, `that bank line is ${$(B(bl[0].amount_minor))}; the settlement put ${$(posted)} in the bank`);
  }
  const cashLines = await q<{ cash_line_id: string; amount: string }>(c, `select l.cash_line_id, jl.debit_minor - jl.credit_minor amount from finance_remit_line l
     join journal_line jl on jl.id = l.cash_line_id where l.entity_id = $1 and l.import_id = $2 and l.cash_line_id is not null group by l.cash_line_id, jl.debit_minor, jl.credit_minor`,
    [scope.entityId, importId]);
  for (const cl of cashLines) {
    const taken = await q(c, `select 1 from reconciliation_match where matched_kind = 'journal_line' and matched_id = $1 /* unscoped: journal line of this company's entry */`, [cl.cash_line_id]);
    if (taken.length) continue;
    await matchManually(c, scope, { statementLineId: lineId!, kind: "journal_line", id: cl.cash_line_id, amountMinor: B(cl.amount), matchedBy: (scope.actor.id || null) as unknown as string,
      note: `finance settlement ${x.number}` });
  }
  await c.query(`update finance_remit_import set bank_statement_line_id = $3 where id = $1 and entity_id = $2`, [importId, scope.entityId, lineId]);
  return { linked: true, note: null };
}

// ----------------------------------------------------------- exceptions --

/** Settle an exception: match it to a financed sale a person picked (posted on its own), or dismiss it with a reason. */
export async function resolveException(c: Client, scope: Scope, lineId: string, e: { financedSaleId?: string | null; dismissReason?: string | null }) {
  const r = await q<{ id: string; import_id: string; company_id: string; number: string; status: string; kind: RemitRow["kind"]; txn_on: string | null; auth_code: string | null;
    account_last4: string | null; plan_code: string | null; gross_minor: string; fee_minor: string; holdback_minor: string; net_minor: string; reason: string | null; deposit_on: string }>(c, `
    select l.id, l.import_id, i.company_id, i.number, l.status, l.kind, l.txn_on::text, l.auth_code, l.account_last4, l.plan_code, l.gross_minor, l.fee_minor, l.holdback_minor,
           l.net_minor, l.reason, i.deposit_on::text deposit_on
      from finance_remit_line l join finance_remit_import i on i.id = l.import_id where l.id = $1 and l.entity_id = $2 for update of l`, [lineId, scope.entityId]);
  need(r.length, "no such settlement row");
  const x = r[0];
  need(x.status === "exception", "that row is not an open exception");
  if (e.dismissReason !== undefined && e.dismissReason !== null) {
    const why = String(e.dismissReason).trim();
    need(why.length >= 3, "say why the row is being set aside");
    await c.query(`update finance_remit_line set status = 'dismissed', reason = coalesce(reason || ' · ', '') || $3, resolved_by = $4, resolved_at = now() where id = $1 and entity_id = $2`,
      [lineId, scope.entityId, `set aside: ${why}`.slice(0, 300), scope.actor.id || null]);
    await c.query(`update finance_remit_import set exceptions = exceptions - 1 where id = $1 and entity_id = $2`, [x.import_id, scope.entityId]);
    await audit(c, scope, { table: "finance_remit_line", rowId: lineId, action: "transition", after: { status: "dismissed" }, reason: why });
    return { status: "dismissed", bank: await linkDeposit(c, scope, x.import_id) };
  }
  need(e.financedSaleId, "pick the financed sale this row pays, or set it aside with a reason");
  const lender = await lenderOf(c, scope.entityId, x.company_id);
  const row: RemitRow = { rowNo: 0, kind: x.kind, txnOn: x.txn_on, auth: x.auth_code, last4: x.account_last4, plan: x.plan_code, grossMinor: B(x.gross_minor), feeMinor: B(x.fee_minor),
    holdbackMinor: B(x.holdback_minor), netMinor: B(x.net_minor), reason: x.reason, problem: null };
  const s = await q<Sale>(c, `select f.id, f.amount_minor, f.fee_bps, f.status, f.holdback_open_minor, f.funded_minor, f.fee_taken_minor, f.plan_id, f.created_at::date::text on_day,
      f.auth_code, r.number receipt from financed_sale f join customer_receipt r on r.id = f.receipt_id where f.id = $1 and f.entity_id = $2 and f.company_id = $3 for update of f`,
    [e.financedSaleId, scope.entityId, x.company_id]);
  need(s.length, `that is not a sale financed by ${lender.name}`);
  const want = x.kind === "funding" ? "awaiting_funding" : "funded";
  need(s[0].status === want, `sale ${s[0].receipt} is ${s[0].status.replace(/_/g, " ")}; this row needs one that is ${want.replace(/_/g, " ")}`);
  const p = await plan(c, scope.entityId, lender, row, s[0]);
  need(!p.problem, p.problem ?? "");
  const cash = await postRows(c, scope, lender, x.import_id, x.number, x.deposit_on, [{ lineId, saleId: s[0].id, p }]);
  await c.query(`update finance_remit_import set exceptions = exceptions - 1, matched = matched + 1, posted_minor = posted_minor + $3 where id = $1 and entity_id = $2`,
    [x.import_id, scope.entityId, cash.toString()]);
  return { status: "posted", bank: await linkDeposit(c, scope, x.import_id) };
}

/** A sale a lender charged back and that will not be funded again: written off to 6915, with the reason. */
export async function chargeOff(c: Client, scope: Scope, financedSaleId: string, reason: string) {
  const why = String(reason ?? "").trim();
  need(why.length >= 3, "say why the chargeback is being written off");
  const s = await q<{ id: string; amount_minor: string; status: string; receipt: string; name: string; chargeback_at: string | null }>(c, `
    select f.id, f.amount_minor, f.status, r.number receipt, fc.name, f.chargeback_at from financed_sale f join customer_receipt r on r.id = f.receipt_id
      join finance_company fc on fc.id = f.company_id where f.id = $1 and f.entity_id = $2 for update of f`, [financedSaleId, scope.entityId]);
  need(s.length, "no such financed sale");
  need(s[0].status === "awaiting_funding" && s[0].chargeback_at, "only a sale the lender charged back, and that is waiting to be funded again, is written off here");
  const amt = B(s[0].amount_minor);
  const je = await post(c, scope, { date: today(), sourceType: "finance", sourceId: s[0].id, description: `${s[0].name} chargeback written off: ${s[0].receipt}`,
    lines: [{ code: "6915", debit: amt, memo: why.slice(0, 200) }, { code: "1110", credit: amt, memo: `financed sale ${s[0].receipt}` }] });
  await c.query(`update financed_sale set status = 'charged_off', chargeback_reason = coalesce(chargeback_reason || ' · ', '') || $3 where id = $1 and entity_id = $2`,
    [s[0].id, scope.entityId, `written off: ${why}`.slice(0, 300)]);
  await audit(c, scope, { table: "financed_sale", rowId: s[0].id, action: "transition", after: { status: "charged_off" }, reason: why });
  return { journalEntryId: je, amountMinor: amt };
}

// ---------------------------------------------------------------- views --

export async function imports(c: Client, entityId: string) {
  return q(c, `select i.id, i.number, fc.name company, i.company_id, i.filename, i.rows, i.matched, i.exceptions, i.net_minor::text, i.posted_minor::text,
      i.deposit_on::text, i.bank_statement_line_id is not null bank_linked, i.created_at, u.name imported_by
    from finance_remit_import i join finance_company fc on fc.id = i.company_id left join app_user u on u.id = i.imported_by
   where i.entity_id = $1 order by i.created_at desc limit 50`, [entityId]);
}

export async function importLines(c: Client, entityId: string, importId: string) {
  const i = await q(c, `select id from finance_remit_import where id = $1 and entity_id = $2`, [importId, entityId]);
  need(i.length, "no such settlement import");
  return q(c, `select l.id, l.row_no, l.kind, l.txn_on::text, l.auth_code, l.account_last4, l.plan_code, l.gross_minor::text, l.fee_minor::text, l.holdback_minor::text,
      l.net_minor::text, l.reason, l.status, l.exception, l.expected_fee_minor::text, l.fee_variance_minor::text, l.fee_flag, l.chargeback_mode, r.number receipt
    from finance_remit_line l left join financed_sale f on f.id = l.financed_sale_id left join customer_receipt r on r.id = f.receipt_id
   where l.entity_id = $1 and l.import_id = $2 order by l.row_no`, [entityId, importId]);
}

export async function exceptions(c: Client, entityId: string) {
  return q(c, `select l.id, i.number, fc.name company, i.company_id, l.row_no, l.kind, l.txn_on::text, l.auth_code, l.account_last4, l.gross_minor::text, l.net_minor::text,
      l.exception, l.created_at
    from finance_remit_line l join finance_remit_import i on i.id = l.import_id join finance_company fc on fc.id = i.company_id
   where l.entity_id = $1 and l.status = 'exception' order by l.created_at, l.row_no limit 300`, [entityId]);
}

export async function feeVariances(c: Client, entityId: string) {
  return q(c, `select l.id, i.number, fc.name company, r.number receipt, p.name plan, l.gross_minor::text, l.fee_minor::text, l.expected_fee_minor::text, l.fee_variance_minor::text,
      l.txn_on::text
    from finance_remit_line l join finance_remit_import i on i.id = l.import_id join finance_company fc on fc.id = i.company_id
    join financed_sale f on f.id = l.financed_sale_id join customer_receipt r on r.id = f.receipt_id left join finance_plan p on p.id = f.plan_id
   where l.entity_id = $1 and l.fee_flag and l.status = 'posted' order by l.created_at desc limit 200`, [entityId]);
}

/** What each lender owes: sales waiting to be funded by age, holdbacks not released, and exceptions waiting on a person. */
export async function lenderAging(c: Client, entityId: string, asOf = today()) {
  const rows = await q<{ id: string; name: string; b0: string; b30: string; b60: string; b90: string; holdback: string; reopened: string; exceptions: string; flags: string }>(c, `
    select fc.id, fc.name,
           coalesce(sum(f.amount_minor) filter (where f.status = 'awaiting_funding' and $2::date - f.created_at::date <= 30), 0)::text b0,
           coalesce(sum(f.amount_minor) filter (where f.status = 'awaiting_funding' and $2::date - f.created_at::date between 31 and 60), 0)::text b30,
           coalesce(sum(f.amount_minor) filter (where f.status = 'awaiting_funding' and $2::date - f.created_at::date between 61 and 90), 0)::text b60,
           coalesce(sum(f.amount_minor) filter (where f.status = 'awaiting_funding' and $2::date - f.created_at::date > 90), 0)::text b90,
           coalesce(sum(f.holdback_open_minor) filter (where f.status = 'funded'), 0)::text holdback,
           count(f.id) filter (where f.status = 'awaiting_funding' and f.chargeback_at is not null)::text reopened,
           (select count(*) from finance_remit_line l join finance_remit_import i on i.id = l.import_id
             where l.entity_id = $1 and i.company_id = fc.id and l.status = 'exception')::text exceptions,
           (select count(*) from finance_remit_line l join finance_remit_import i on i.id = l.import_id
             where l.entity_id = $1 and i.company_id = fc.id and l.fee_flag and l.created_at > now() - interval '90 days')::text flags
      from finance_company fc left join financed_sale f on f.company_id = fc.id and f.entity_id = fc.entity_id
     where fc.entity_id = $1 group by fc.id, fc.name order by fc.name`, [entityId, asOf]);
  const out = rows.map((r) => {
    const owed = B(r.b0) + B(r.b30) + B(r.b60) + B(r.b90);
    return { companyId: r.id, name: r.name, current: r.b0, d31_60: r.b30, d61_90: r.b60, over90: r.b90, holdbackMinor: r.holdback, owedMinor: (owed + B(r.holdback)).toString(),
      reopened: Number(r.reopened), exceptions: Number(r.exceptions), feeFlags: Number(r.flags) };
  });
  const gl = async (code: string) => B((await q<{ b: string }>(c, `select coalesce(sum(jl.debit_minor - jl.credit_minor), 0)::text b from journal_line jl
      join journal_entry je on je.id = jl.journal_entry_id join gl_account g on g.id = jl.gl_account_id where je.entity_id = $1 and g.code = $2 and je.posting_date <= $3`,
    [entityId, code, asOf]))[0].b);
  return { asOf, lenders: out, gl1110Minor: (await gl("1110")).toString(), gl1115Minor: (await gl("1115")).toString() };
}

export async function lenders(c: Client, entityId: string) {
  const cos = await q(c, `select fc.id, fc.name, fc.remit_mapping, fc.bank_account_id, ba.name bank_account, fc.fee_tolerance_minor::text, fc.chargeback_mode
    from finance_company fc left join bank_account ba on ba.id = fc.bank_account_id where fc.entity_id = $1 order by fc.cascade_rank, fc.name`, [entityId]);
  const plans = await q(c, `select company_id, code, name, promo_months, fee_bps from finance_plan where entity_id = $1 and active order by company_id, promo_months`, [entityId]);
  const banks = await q(c, `select id, name from bank_account where entity_id = $1 and status = 'active' order by name`, [entityId]);
  const reopened = await q(c, `select f.id, fc.name company, r.number receipt, f.amount_minor::text, f.chargeback_reason, f.chargeback_at::date::text on_day
    from financed_sale f join finance_company fc on fc.id = f.company_id join customer_receipt r on r.id = f.receipt_id
   where f.entity_id = $1 and f.status = 'awaiting_funding' and f.chargeback_at is not null order by f.chargeback_at desc limit 100`, [entityId]);
  const awaiting = await q(c, `select f.id, f.company_id, f.status, r.number receipt, cu.name customer, f.amount_minor::text, f.auth_code, f.account_last4, f.created_at::date::text on_day
    from financed_sale f join customer_receipt r on r.id = f.receipt_id left join customer cu on cu.id = f.customer_id
   where f.entity_id = $1 and f.status in ('awaiting_funding','funded') order by f.created_at desc limit 300`, [entityId]);
  return { lenders: cos, plans, banks, reopened, sales: awaiting };
}
