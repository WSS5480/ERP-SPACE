// Accounting periods: they open on their own, close at month end with a
// checklist, reopen only with the owner and a reason, and close the year into
// retained earnings.
//
// Opening. A posting dated in a month with no period opens that month when the
// date is no more than two months ahead of the company's business date, or
// falls in the company's current fiscal year (a late bill dated in January
// still lands while it is November). Anything else is refused with a sentence
// saying what to do. The daily period job keeps three months ahead open for
// every company of a customer that is not suspended. Every period opened,
// either way, is a period_event row.
//
// Closing. A month closes from Books, Periods (owner or controller) after a
// checklist: bills not yet in the books, open drawer sessions, unmatched bank
// lines, and the 1300 / 2100 / 1110 / inter-company tie-outs. An item that is
// not clear needs `override` and a reason. A closed month refuses postings
// (here, and by trigger in the database). Reopening needs the owner and a
// reason; it is audited.
//
// The year. closeYear posts one closing journal on the year's last day: every
// revenue and expense account's balance for the year moves to retained
// earnings (3900 unless the company names another equity account in the
// setting books.retained_earnings_code). It is idempotent (a second close of
// the same year returns the first), and reopening any month of a closed year
// reverses the closing journal.

import { q, one, audit, type Client, type Scope } from "./db.ts";
import { today as businessToday, addDays } from "./clock.ts";

export class PeriodError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new PeriodError(msg); };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A date column read by pg arrives as a Date at local midnight: back to its calendar day. */
const dayText = (d: string | Date): string => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : String(d).slice(0, 10);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
const firstOf = (day: string) => day.slice(0, 8) + "01";
const lastOf = (day: string) => { const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const addMonths = (day: string, n: number) => { const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)) - 1 + n; return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); };
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

/** The fiscal year holding a day, for a year that ends with this month. */
export function fiscalYearOf(day: string, fyEndMonth: number): { start: string; end: string } {
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
  const endYear = m > fyEndMonth ? y + 1 : y;
  const end = lastOf(`${endYear}-${String(fyEndMonth).padStart(2, "0")}-01`);
  return { start: addMonths(firstOf(end), -11), end };
}

type Who = { label: string; userId?: string | null };
const whoOf = (s: Scope): Who => ({ label: s.actor.label, userId: s.actor.kind === "user" && s.actor.id ? s.actor.id : null });

async function logEvent(c: Client, entityId: string, p: { id: string | null; starts_on: string; ends_on: string }, kind: string, who: Who, reason: string | null, detail: unknown = {}) {
  await c.query(`insert into period_event (entity_id, period_id, kind, starts_on, ends_on, reason, detail, by_label, by_user)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [entityId, p.id, kind, p.starts_on, p.ends_on, reason, JSON.stringify(detail), who.label.slice(0, 120), who.userId ?? null]);
}

/** Insert one calendar month as an open period, unless one already covers any of its days. Returns it, or null. */
async function insertMonth(c: Client, entityId: string, month: string): Promise<{ id: string; starts_on: string; ends_on: string } | null> {
  const s = firstOf(month), e = lastOf(month);
  const r = await q<{ id: string; starts_on: string; ends_on: string }>(c, `
    insert into fiscal_period (entity_id, starts_on, ends_on, status)
    select $1, $2::date, $3::date, 'open'
     where not exists (select 1 from fiscal_period p where p.entity_id = $1 and p.starts_on <= $3::date and p.ends_on >= $2::date)
    on conflict (entity_id, starts_on) do nothing
    returning id, starts_on::text, ends_on::text`, [entityId, s, e]);
  return r[0] ?? null;
}

/**
 * The period a posting dated `date` lands in: an existing one that is not
 * closed, or a month opened now by the rule above. Refusals are sentences.
 */
export async function periodFor(c: Client, scope: Scope | { entityId: string; actor?: Scope["actor"] }, dateIn: string | Date): Promise<string> {
  const date = dayText(dateIn);
  need(DAY.test(date), `${date} is not a date (YYYY-MM-DD)`);
  const entityId = scope.entityId;
  const find = () => q<{ id: string; status: string; starts_on: string }>(c,
    `select id, status, starts_on::text from fiscal_period where entity_id = $1 and $2::date between starts_on and ends_on`, [entityId, date]);
  let p = await find();
  if (!p.length) {
    const e = await one<{ fy: number }>(c, `select fiscal_year_end_month fy from entity where id = $1 /* unscoped: the company itself */`, [entityId]);
    const t = await businessToday(c, entityId);
    const ahead = monthsBetween(t, date);
    const fy = fiscalYearOf(t, Number(e.fy));
    const inYear = date >= fy.start && date <= fy.end;
    if (!(inYear || (ahead >= 0 && ahead <= 2))) {
      throw new PeriodError(date > t
        ? `There is no open period for ${date} (${monthLabel(date)}): months open on their own only up to two months ahead or within this fiscal year. Post it when the day comes, or ask an owner or controller to open ${monthLabel(date)} in Books, Periods.`
        : `There is no period for ${date} (${monthLabel(date)}): it is before this fiscal year, so it does not open on its own. Post it on a day in an open month, or ask an owner or controller to open ${monthLabel(date)} in Books, Periods.`);
    }
    const made = await insertMonth(c, entityId, date);
    if (made) {
      const actor = "actor" in scope && scope.actor ? scope.actor : { kind: "system" as const, label: "system" };
      await logEvent(c, entityId, made, "auto_opened", { label: actor.label, userId: actor.kind === "user" ? actor.id ?? null : null },
        `a posting dated ${date} needed it`, { postingDate: date, businessDate: t });
    }
    p = await find();
    need(p.length, `${monthLabel(date)} overlaps a period of a different length, so it cannot open on its own; ask an owner or controller to look in Books, Periods.`);
  }
  if (p[0].status === "closed") {
    throw new PeriodError(`The books for ${monthLabel(p[0].starts_on)} are closed, so nothing can be posted on ${date}. An owner can reopen the month in Books, Periods (with a reason), or post it on a day in an open month.`);
  }
  return p[0].id;
}

/** Open a month by hand (owner or controller; the route checks): a past month, or one further ahead. */
export async function openMonth(c: Client, scope: Scope, month: string, reason: string) {
  need(DAY.test(month) || /^\d{4}-\d{2}$/.test(month), "pick the month to open");
  const day = month.length === 7 ? `${month}-01` : month;
  need(reason.trim().length >= 3, "say why this month is being opened");
  const made = await insertMonth(c, scope.entityId, day);
  need(made, `${monthLabel(day)} already has a period (or overlaps one)`);
  await logEvent(c, scope.entityId, made!, "opened", whoOf(scope), reason.trim().slice(0, 500));
  await audit(c, scope, { table: "fiscal_period", rowId: made!.id, action: "insert", after: { startsOn: made!.starts_on, endsOn: made!.ends_on }, reason: reason.trim() });
  return made!;
}

/** Keep months open from this month to `ahead` months on (the daily period job). Returns the months it opened. */
export async function keepAhead(c: Client, entityId: string, ahead = 3, by = "period job"): Promise<string[]> {
  const t = await businessToday(c, entityId);
  const out: string[] = [];
  for (let i = 0; i <= ahead; i++) {
    const m = addMonths(firstOf(t), i);
    const made = await insertMonth(c, entityId, m);
    if (made) { out.push(made.starts_on); await logEvent(c, entityId, made, "auto_opened", { label: by }, `keeping ${ahead} months ahead open`, { businessDate: t }); }
  }
  return out;
}

// ------------------------------------------------------------- the list --

export async function list(c: Client, entityId: string) {
  const rows = await q<{ id: string; starts_on: string; ends_on: string; status: string; locked_at: string | null; closed_reason: string | null; entries: number }>(c, `
    select p.id, p.starts_on::text, p.ends_on::text, p.status, p.locked_at::text, p.closed_reason,
           (select count(*) from journal_entry je where je.entity_id = $1 and je.period_id = p.id)::int entries
      from fiscal_period p where p.entity_id = $1 order by p.starts_on desc`, [entityId]);
  const e = await one<{ fy: number }>(c, `select fiscal_year_end_month fy from entity where id = $1 /* unscoped: the company itself */`, [entityId]);
  const t = await businessToday(c, entityId);
  const years = await q<{ id: string; fy_start: string; fy_end: string; status: string; net_income_minor: string; closed_by: string; closed_at: string; journal_entry_id: string | null }>(c, `
    select id, fy_start::text, fy_end::text, status, net_income_minor::text, closed_by, closed_at::text, journal_entry_id
      from fiscal_year_close where entity_id = $1 order by fy_end desc, closed_at desc`, [entityId]);
  const events = await q(c, `select kind, starts_on::text, ends_on::text, reason, by_label, at::text from period_event where entity_id = $1 order by at desc limit 50`, [entityId]);
  return { today: t, fiscalYear: fiscalYearOf(t, Number(e.fy)), fyEndMonth: Number(e.fy),
    counts: { open: rows.filter((r) => r.status !== "closed").length, closed: rows.filter((r) => r.status === "closed").length },
    periods: rows.map((r) => ({ ...r, label: monthLabel(r.starts_on), current: t >= r.starts_on && t <= r.ends_on })), years, events };
}

// -------------------------------------------------------- the checklist --

export type CheckItem = { id: string; label: string; ok: boolean; count: number; detail: string; screen: string; rows?: unknown[] };

async function periodRow(c: Client, entityId: string, periodId: string) {
  const p = await q<{ id: string; starts_on: string; ends_on: string; status: string }>(c,
    `select id, starts_on::text, ends_on::text, status from fiscal_period where id = $1 and entity_id = $2`, [periodId, entityId]);
  need(p.length, "no such period");
  return p[0];
}

/** What stands between a month and its close, each item with what is behind it (rows) and the screen that fixes it. */
export async function checklist(c: Client, tenantId: string, entityId: string, periodId: string): Promise<{ period: { id: string; starts_on: string; ends_on: string; status: string; label: string }; items: CheckItem[]; clear: boolean }> {
  const p = await periodRow(c, entityId, periodId);
  const items: CheckItem[] = [];
  const add = (x: CheckItem) => items.push(x);
  const safely = async (id: string, label: string, screen: string, fn: () => Promise<Omit<CheckItem, "id" | "label" | "screen">>) => {
    try { add({ id, label, screen, ...(await fn()) }); }
    catch (e) { add({ id, label, screen, ok: false, count: 0, detail: `could not be checked: ${(e as Error).message}` }); }
  };

  await safely("drafts", "Bills and payroll not yet in the books", "payables", async () => {
    const bills = await q<{ id: string; number: string; vendor: string; invoice_date: string; total_minor: string; status: string }>(c, `
      select i.id, coalesce(i.reference, '') number, coalesce(v.dba, v.legal_name, '') vendor, i.invoice_date::text, i.total_minor::text, i.status
        from invoice i left join vendor v on v.id = i.vendor_id
       where i.entity_id = $1 and i.invoice_date between $2 and $3
         and i.status in ('captured','extracted','matched','validated','pending','exception','held')
       order by i.invoice_date limit 200`, [entityId, p.starts_on, p.ends_on]);
    const runs = await q<{ id: string; pay_date: string; status: string; net_minor: string }>(c, `
      select r.id, pp.pay_date::text, r.status, r.net_minor::text from payroll_run r join pay_period pp on pp.id = r.pay_period_id
       where r.entity_id = $1 and pp.pay_date between $2 and $3 and r.status in ('building','pending_release','released') order by pp.pay_date`,
      [entityId, p.starts_on, p.ends_on]);
    const n = bills.length + runs.length;
    return { ok: n === 0, count: n, rows: [...bills.map((b) => ({ kind: "bill", ...b })), ...runs.map((r) => ({ kind: "payroll", ...r }))],
      detail: n === 0 ? "Every bill and payroll run dated in the month is in the books."
        : [bills.length ? `${bills.length} bill${bills.length === 1 ? "" : "s"} dated in the month still waiting (approve, reject or re-date them)` : null,
           runs.length ? `${runs.length} payroll run${runs.length === 1 ? "" : "s"} paying in the month not posted` : null].filter(Boolean).join("; ") + "." };
  });

  await safely("drawers", "Drawer sessions still open", "pos", async () => {
    const rows = await q<{ id: string; number: string; opened_at: string; store: string }>(c, `
      select s.id, s.number, s.opened_at::text, l.name store from pos_session s join location l on l.id = s.location_id
       where s.entity_id = $1 and s.status = 'open' and (s.opened_at at time zone business_tz($1, s.location_id))::date <= $2::date order by s.opened_at`,
      [entityId, p.ends_on]);
    return { ok: !rows.length, count: rows.length, rows,
      detail: rows.length ? `${rows.length} drawer${rows.length === 1 ? "" : "s"} opened on or before ${p.ends_on} ${rows.length === 1 ? "is" : "are"} still open; count and close ${rows.length === 1 ? "it" : "them"} at POS.` : "Every drawer opened in the month is counted and closed." };
  });

  await safely("bank", "Bank lines not reconciled", "recon", async () => {
    const rows = await q<{ id: string; account: string; posted_on: string; description: string; amount_minor: string }>(c, `
      select bsl.id, ba.name account, bsl.posted_on::text, bsl.description, bsl.amount_minor::text
        from bank_statement_line bsl join bank_statement bs on bs.id = bsl.bank_statement_id join bank_account ba on ba.id = bs.bank_account_id
       where ba.entity_id = $1 and bsl.match_status = 'unmatched' and bsl.posted_on <= $2::date order by bsl.posted_on limit 200`, [entityId, p.ends_on]);
    return { ok: !rows.length, count: rows.length, rows,
      detail: rows.length ? `${rows.length} bank line${rows.length === 1 ? "" : "s"} up to ${p.ends_on} not matched to the books.` : "Every bank line to the month's end is matched." };
  });

  const multi = Number((await one<{ n: string }>(c, `select count(*) n from entity where tenant_id = $1 and status <> 'closed' /* unscoped: the client's companies */`, [tenantId])).n) > 1;
  const { tieOuts } = await import("./onboarding.ts");
  const screens: Record<string, string> = { stock: "inventory", tax: "salestax", financing: "settlements", intercompany: "group" };
  const codes: Record<string, string> = { stock: "1300", tax: "2100", financing: "1110", intercompany: "1195/2190" };
  for (const t of await tieOuts(c, tenantId, entityId, multi)) {
    add({ id: `tie_${t.id}`, label: t.label, ok: t.ok, count: t.ok ? 0 : 1, detail: t.detail, screen: screens[t.id] ?? "books", rows: [{ account: codes[t.id] ?? "", detail: t.detail }] });
  }
  return { period: { ...p, label: monthLabel(p.starts_on) }, items, clear: items.every((x) => x.ok) };
}

// ------------------------------------------------------- close / reopen --

export async function closeMonth(c: Client, scope: Scope, periodId: string, opts: { override?: boolean; reason?: string } = {}) {
  const p = await periodRow(c, scope.entityId, periodId);
  if (p.status === "closed") return { closed: true, already: true, period: { ...p, label: monthLabel(p.starts_on) } };
  const t = await businessToday(c, scope);
  need(p.ends_on < t, `${monthLabel(p.starts_on)} has not ended yet; close it from ${addDays(p.ends_on, 1)} on.`);
  await c.query(`select id from fiscal_period where id = $1 and entity_id = $2 for update`, [periodId, scope.entityId]);
  const ck = await checklist(c, scope.tenantId, scope.entityId, periodId);
  const open = ck.items.filter((x) => !x.ok);
  const reason = (opts.reason ?? "").trim();
  if (open.length) {
    need(opts.override === true && reason.length >= 3,
      `${monthLabel(p.starts_on)} still has ${open.length} item${open.length === 1 ? "" : "s"} on the checklist (${open.map((x) => x.label.toLowerCase()).join("; ")}). Clear ${open.length === 1 ? "it" : "them"}, or close anyway with a reason.`);
  }
  await c.query(`update fiscal_period set status = 'closed', locked_at = now(), locked_by = $3, closed_reason = $4 where id = $1 and entity_id = $2`,
    [periodId, scope.entityId, scope.actor.kind === "user" ? scope.actor.id ?? null : null, reason || null]);
  await logEvent(c, scope.entityId, p, "closed", whoOf(scope), reason || null, { openItems: open.map((x) => ({ id: x.id, detail: x.detail })) });
  await audit(c, scope, { table: "fiscal_period", rowId: periodId, action: "transition", before: { status: p.status }, after: { status: "closed", openItems: open.map((x) => x.id) }, reason: reason || undefined });
  return { closed: true, already: false, period: { ...p, status: "closed", label: monthLabel(p.starts_on) }, overridden: open.map((x) => x.label) };
}

/** Reopen a closed month: the owner, with a reason (the route checks the role). A month in a closed year reverses the year's closing journal. */
export async function reopenMonth(c: Client, scope: Scope, periodId: string, reason: string) {
  const why = (reason ?? "").trim();
  need(why.length >= 3, "say why the month is being reopened; it is kept with the books");
  const p = await periodRow(c, scope.entityId, periodId);
  need(p.status === "closed", `${monthLabel(p.starts_on)} is not closed`);
  const yr = await q<{ id: string; fy_start: string; fy_end: string }>(c, `
    select id, fy_start::text, fy_end::text from fiscal_year_close where entity_id = $1 and status = 'closed' and $2::date between fy_start and fy_end for update`,
    [scope.entityId, p.starts_on]);
  await c.query(`update fiscal_period set status = 'open', locked_at = null, locked_by = null, closed_reason = null where id = $1 and entity_id = $2`, [periodId, scope.entityId]);
  await logEvent(c, scope.entityId, p, "reopened", whoOf(scope), why);
  await audit(c, scope, { table: "fiscal_period", rowId: periodId, action: "transition", before: { status: "closed" }, after: { status: "open" }, reason: why });
  let yearReopened = false;
  if (yr.length) { await reopenYearRow(c, scope, yr[0], why); yearReopened = true; }
  return { reopened: true, period: { ...p, status: "open", label: monthLabel(p.starts_on) }, yearReopened };
}

async function reopenYearRow(c: Client, scope: Scope, yr: { id: string; fy_start: string; fy_end: string }, why: string) {
  const row = await one<{ journal_entry_id: string | null }>(c, `select journal_entry_id from fiscal_year_close where id = $1 and entity_id = $2`, [yr.id, scope.entityId]);
  let reversal: string | null = null;
  if (row.journal_entry_id) {
    // the reversal is dated the year's last day, so that month opens again for it
    const last = await one<{ id: string; status: string; starts_on: string; ends_on: string }>(c,
      `select id, status, starts_on::text, ends_on::text from fiscal_period where entity_id = $1 and $2::date between starts_on and ends_on`, [scope.entityId, yr.fy_end]);
    if (last.status === "closed") {
      await c.query(`update fiscal_period set status = 'open', locked_at = null, locked_by = null, closed_reason = null where id = $1 and entity_id = $2`, [last.id, scope.entityId]);
      await logEvent(c, scope.entityId, last, "reopened", whoOf(scope), `the year is reopened: ${why}`);
    }
    const lines = await q<{ code: string; debit_minor: string; credit_minor: string; profit_object_id: string | null }>(c, `
      select ga.code, jl.debit_minor::text, jl.credit_minor::text, jl.profit_object_id from journal_line jl
        join journal_entry je on je.id = jl.journal_entry_id join gl_account ga on ga.id = jl.gl_account_id
       where je.id = $1 and je.entity_id = $2 order by jl.seq`, [row.journal_entry_id, scope.entityId]);
    const { post } = await import("./posting.ts");
    reversal = await post(c, scope, { date: yr.fy_end, sourceType: "closing", sourceId: yr.id, description: `Reverse year-end close ${yr.fy_start} to ${yr.fy_end}: ${why}`.slice(0, 300),
      lines: lines.map((l) => ({ code: l.code, debit: BigInt(l.credit_minor), credit: BigInt(l.debit_minor), profitObjectId: l.profit_object_id })) });
  }
  await c.query(`update fiscal_year_close set status = 'reopened', reversal_entry_id = $3, reopened_by = $4, reopened_at = now(), reopen_reason = $5 where id = $1 and entity_id = $2`,
    [yr.id, scope.entityId, reversal, scope.actor.label, why]);
  await logEvent(c, scope.entityId, { id: null, starts_on: yr.fy_start, ends_on: yr.fy_end }, "year_reopened", whoOf(scope), why, { reversal });
  await audit(c, scope, { table: "fiscal_year_close", rowId: yr.id, action: "transition", before: { status: "closed" }, after: { status: "reopened", reversal }, reason: why });
}

// ------------------------------------------------------------- the year --

/** The equity account the year closes to. */
export async function retainedCode(c: Client, scope: Scope): Promise<string> {
  const set = await q<{ v: string }>(c, `select value #>> '{}' v from entity_setting where entity_id = $1 and key = 'books.retained_earnings_code'`, [scope.entityId]);
  const code = set[0]?.v || "3900";
  const a = await q<{ account_type: string; name: string }>(c, `select account_type, name from gl_account where tenant_id = $1 and code = $2 /* unscoped: the chart is client-wide */`, [scope.tenantId, code]);
  need(a.length, `the chart of accounts has no ${code} Retained earnings, which the year-end close posts to; add it in Chart of accounts (an equity account)`);
  need(a[0].account_type === "equity", `${code} ${a[0].name} is not an equity account, so the year cannot close to it; name the retained earnings account in the setting books.retained_earnings_code`);
  return code;
}

/**
 * Close a fiscal year (the one ending on or before fyEnd): one closing journal on
 * its last day moves every revenue and expense balance to retained earnings,
 * then every month of the year is closed. Doing it again returns the close
 * already made.
 */
export async function closeYear(c: Client, scope: Scope, fyEnd: string, opts: { override?: boolean; reason?: string } = {}) {
  need(DAY.test(fyEnd), "pick the year to close");
  const e = await one<{ fy: number }>(c, `select fiscal_year_end_month fy from entity where id = $1 /* unscoped: the company itself */`, [scope.entityId]);
  const yr = fiscalYearOf(fyEnd, Number(e.fy));
  const t = await businessToday(c, scope);
  need(yr.end < t, `the fiscal year ${yr.start} to ${yr.end} has not ended yet`);
  const done = await q<{ id: string; journal_entry_id: string | null; net_income_minor: string }>(c, `
    select id, journal_entry_id, net_income_minor::text from fiscal_year_close where entity_id = $1 and fy_end = $2 and status = 'closed'`, [scope.entityId, yr.end]);
  if (done.length) return { already: true, id: done[0].id, journalEntryId: done[0].journal_entry_id, netIncomeMinor: done[0].net_income_minor, ...yr };
  const code = await retainedCode(c, scope);

  // the year's months: missing ones are opened (to close them), and the checklist of each still-open month must be clear or overridden
  for (let m = yr.start; m <= yr.end; m = addMonths(m, 1)) {
    const has = await q(c, `select 1 from fiscal_period where entity_id = $1 and $2::date between starts_on and ends_on`, [scope.entityId, m]);
    if (!has.length) { const made = await insertMonth(c, scope.entityId, m); if (made) await logEvent(c, scope.entityId, made, "opened", whoOf(scope), "opened to close the year"); }
  }
  const months = await q<{ id: string; starts_on: string; ends_on: string; status: string }>(c, `
    select id, starts_on::text, ends_on::text, status from fiscal_period where entity_id = $1 and starts_on <= $3 and ends_on >= $2 order by starts_on for update`,
    [scope.entityId, yr.start, yr.end]);
  const last = months.find((m) => yr.end >= m.starts_on && yr.end <= m.ends_on);
  need(last, `there is no period holding ${yr.end}`);
  const reason = (opts.reason ?? "").trim();
  const blocking: string[] = [];
  for (const m of months.filter((x) => x.status !== "closed")) {
    const ck = await checklist(c, scope.tenantId, scope.entityId, m.id);
    for (const x of ck.items.filter((i) => !i.ok)) blocking.push(`${monthLabel(m.starts_on)}: ${x.label.toLowerCase()}`);
  }
  const uniq = [...new Set(blocking)];
  if (uniq.length) need(opts.override === true && reason.length >= 3,
    `the year still has ${uniq.length} checklist item${uniq.length === 1 ? "" : "s"} open (${uniq.slice(0, 4).join("; ")}${uniq.length > 4 ? "; …" : ""}). Clear them, or close anyway with a reason.`);

  // The last month must take the closing journal: it is opened for it if a month-end close got there first.
  if (last!.status === "closed") {
    await c.query(`update fiscal_period set status = 'open' where id = $1 and entity_id = $2`, [last!.id, scope.entityId]);
  }
  const bal = await q<{ code: string; account_type: string; profit_object_id: string | null; net: string }>(c, `
    select ga.code, ga.account_type, jl.profit_object_id, sum(jl.debit_minor - jl.credit_minor)::text net
      from journal_line jl join journal_entry je on je.id = jl.journal_entry_id join gl_account ga on ga.id = jl.gl_account_id
     where je.entity_id = $1 and je.posting_date between $2 and $3 and ga.account_type in ('revenue','expense')
     group by ga.code, ga.account_type, jl.profit_object_id having sum(jl.debit_minor - jl.credit_minor) <> 0
     order by ga.code`, [scope.entityId, yr.start, yr.end]);
  let net = 0n;   // debits less credits over the income statement: negative is a profit
  const lines: { code: string; debit?: bigint; credit?: bigint; profitObjectId?: string | null; memo?: string }[] = [];
  for (const b of bal) {
    const n = BigInt(b.net);
    net += n;
    lines.push(n > 0n ? { code: b.code, credit: n, profitObjectId: b.profit_object_id, memo: "close to retained earnings" }
      : { code: b.code, debit: -n, profitObjectId: b.profit_object_id, memo: "close to retained earnings" });
  }
  if (net !== 0n) lines.push(net < 0n ? { code, credit: -net, memo: "net income for the year" } : { code, debit: net, memo: "net loss for the year" });
  const id = (await one<{ id: string }>(c, `
    insert into fiscal_year_close (entity_id, fy_start, fy_end, retained_code, net_income_minor, closed_by) values ($1,$2,$3,$4,$5,$6) returning id`,
    [scope.entityId, yr.start, yr.end, code, (-net).toString(), scope.actor.label])).id;
  let je: string | null = null;
  if (lines.length) {
    const { post } = await import("./posting.ts");
    je = await post(c, scope, { date: yr.end, sourceType: "closing", sourceId: id, description: `Year-end close ${yr.start} to ${yr.end}: income and expenses to ${code}`, lines });
    await c.query(`update fiscal_year_close set journal_entry_id = $3 where id = $1 and entity_id = $2`, [id, scope.entityId, je]);
  }
  for (const m of months.filter((x) => x.status !== "closed" || x.id === last!.id)) {
    await c.query(`update fiscal_period set status = 'closed', locked_at = now(), locked_by = $3, closed_reason = $4 where id = $1 and entity_id = $2`,
      [m.id, scope.entityId, scope.actor.kind === "user" ? scope.actor.id ?? null : null, reason || "year-end close"]);
    if (m.status !== "closed") await logEvent(c, scope.entityId, m, "closed", whoOf(scope), reason || "year-end close");
  }
  await logEvent(c, scope.entityId, { id: null, starts_on: yr.start, ends_on: yr.end }, "year_closed", whoOf(scope), reason || null,
    { journalEntryId: je, netIncomeMinor: (-net).toString(), retainedCode: code, overridden: uniq });
  await audit(c, scope, { table: "fiscal_year_close", rowId: id, action: "insert", after: { ...yr, journalEntryId: je, netIncomeMinor: (-net).toString() }, reason: reason || undefined });
  return { already: false, id, journalEntryId: je, netIncomeMinor: (-net).toString(), ...yr };
}

/** Reopen a closed year (the owner, with a reason): its closing journal is reversed; its months stay as they are except the last. */
export async function reopenYear(c: Client, scope: Scope, fyEnd: string, reason: string) {
  const why = (reason ?? "").trim();
  need(why.length >= 3, "say why the year is being reopened; it is kept with the books");
  const yr = await q<{ id: string; fy_start: string; fy_end: string }>(c, `
    select id, fy_start::text, fy_end::text from fiscal_year_close where entity_id = $1 and fy_end = $2 and status = 'closed' for update`, [scope.entityId, fyEnd]);
  need(yr.length, "that year is not closed");
  await reopenYearRow(c, scope, yr[0], why);
  return { reopened: true, fyStart: yr[0].fy_start, fyEnd: yr[0].fy_end };
}
