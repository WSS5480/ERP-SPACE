// Checks for the hardening work: accounting periods that open on their own
// (and the ones that do not), the daily period job, month-end close with its
// checklist, reopening (owner, reason, audit), the year-end close to retained
// earnings and its reversal; store-local business dates (a Central-time sale
// at 7:30 pm on the 31st is the 31st's, with the clock pinned to 01:30 UTC on
// the 1st); the scheduler (one runner, every run recorded, suspended customers
// skipped); server error references and alerts; selling rules and pack
// settings; campaign sends through the outbox; quiet-hours zones by state.

import type { T } from "./harness.ts";
import { ENTITY, RIO_ENTITY, LOC, PEOPLE, TENANT } from "./harness.ts";
import { pool, tx, q, type Client, type Scope } from "../../packages/core/db.ts";
import { pinClock, localDay, today as bizToday, STATE_TZ, tzForState, addDays } from "../../packages/core/clock.ts";
import * as P from "../../packages/core/periods.ts";
import { post, PostingError } from "../../packages/core/posting.ts";
import * as pos from "../../packages/core/pos.ts";
import * as crm from "../../packages/core/crm.ts";
import * as ar from "../../packages/core/ar.ts";
import { settings as fleetSettings } from "../../packages/core/fleet.ts";
import { idle } from "../../packages/core/messaging.ts";
import { module as periodsModule } from "../../server/modules/periods.ts";
import { module as jobsModule } from "../../server/modules/jobs.ts";
import { companyOf } from "./inventory.ts";
import { runDue, rollPeriods, jobsView } from "../../server/scheduler.ts";
import { recordError, redact, alert, alertTestHooks, newRef } from "../../server/errors.ts";
import type { Company, Actor } from "../../server/modules/kit.ts";

const RIO_TENANT = "dddd0000-0000-0000-0000-00000000000d";
const RIO_OWNER = "eeee0000-0000-0000-0000-000000000201";
const LUIS = "55555555-0000-0000-0000-000000000012";     // cashier
const REG_PAL = "9a9a0000-0000-0000-0000-000000000003";  // the Mesa Verde (TX) register
const LAMP = "77777777-0000-0000-0000-000000000009";
const SYS = { kind: "system" as const, label: "checks" };

type Get = (c: Client, co: Company, url: URL, m: RegExpMatchArray, p: string | null) => Promise<unknown>;
type Post = (c: Client, co: Company, a: Actor, b: Record<string, unknown>, m: RegExpMatchArray) => Promise<unknown>;
/** A module's routes, called as a person (reads too: the periods and jobs screens check who is asking). */
function routes(mod: { register: (k: never) => void }) {
  const gets: [RegExp, Get][] = [], posts: [RegExp, Post][] = [];
  mod.register({ coGet: (tail: string, fn: Get) => gets.push([new RegExp(`^(co)${tail}$`), fn]),
    coPost: (tail: string, fn: Post) => posts.push([new RegExp(`^(co)${tail}$`), fn]), publicRoute: () => {} } as never);
  const find = <F>(list: [RegExp, F][], path: string): [F, RegExpMatchArray] => {
    for (const [re, fn] of list) { const m = ("co" + path.split("?")[0]).match(re); if (m) return [fn, m]; }
    throw new Error(`no route ${path}`);
  };
  const nameOf = async (id: string) => { const c = await pool.connect(); try { return (await q<{ name: string }>(c, `select name from app_user where id = $1 /* unscoped: lookup */`, [id]))[0]?.name ?? "?"; } finally { c.release(); } };
  return {
    // deno-lint-ignore no-explicit-any
    get: async <X = any>(person: string, path: string, entity = ENTITY): Promise<X> => {
      const co = await companyOf(entity);
      return tx({ kind: "user", id: person, label: await nameOf(person) }, (c) => { const [fn, m] = find(gets, path); return fn(c, co, new URL("http://x" + path), m, person) as Promise<X>; });
    },
    // deno-lint-ignore no-explicit-any
    post: async <X = any>(person: string, path: string, body: Record<string, unknown> = {}, entity = ENTITY): Promise<X> => {
      const co = await companyOf(entity);
      const name = await nameOf(person);
      return tx({ kind: "user", id: person, label: name }, (c) => { const [fn, m] = find(posts, path); return fn(c, co, { personId: person, personName: name, label: name }, body, m) as Promise<X>; });
    },
  };
}
const RP = routes(periodsModule as never);
const RJ = routes(jobsModule as never);

const monthsOn = (day: string, n: number) => { const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)) - 1 + n; return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); };
const lastDay = (day: string) => { const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

export async function run(t: T) {
  const c0 = await t.pool.connect();
  const read = <X extends Record<string, unknown>>(sql: string, p: unknown[] = []) => t.q<X>(c0, `${sql} /* unscoped: the checks read what they need */`, p);
  const rioScope = (label = "Rio owner"): Scope => ({ tenantId: RIO_TENANT, entityId: RIO_ENTITY, actor: { kind: "user", id: RIO_OWNER, label } });
  const demoScope = (id: string = PEOPLE.STEVE, label = "Steve"): Scope => ({ tenantId: TENANT, entityId: ENTITY, actor: { kind: "user", id, label } });
  const smallPost = (sc: Scope, date: string, what = "period check") => tx(sc.actor, (c) => post(c, sc, { date, sourceType: "manual", sourceId: null, description: what,
    lines: [{ code: "1010", debit: 100n }, { code: "4010", credit: 100n }] }));
  /** The register's open session if an earlier check left one, else a new one (and whether we opened it). */
  const sessionAt = async (c: Client, sc: Scope, reg: string) => {
    const open = await q<{ id: string }>(c, `select id from pos_session where entity_id = $1 and register_id = $2 and status = 'open'`, [ENTITY, reg]);
    if (open.length) return { id: open[0].id, mine: false };
    return { id: (await pos.openSession(c, sc, { registerId: reg, floatMinor: 0n }) as { id: string }).id, mine: true };
  };
  const periodOf = async (entity: string, day: string) => (await read<{ id: string; status: string }>(`select id, status from fiscal_period where entity_id = $1 and $2::date between starts_on and ends_on`, [entity, day]))[0];

  try {
    // =============================================================== the clock
    console.log("  -- business dates");
    t.ok("time zones: all 50 states and DC have a zone", Object.keys(STATE_TZ).length === 51 && ["AK", "HI", "DC", "AZ", "WY", "ME"].every((s) => STATE_TZ[s]));
    t.ok("time zones: quiet hours use the customer's state, else the company's zone", crm.tzForState("WA") === "America/Los_Angeles" && crm.tzForState("hi") === "Pacific/Honolulu"
      && crm.tzForState(null, "America/Chicago") === "America/Chicago" && tzForState("ZZ") === null);
    const sqlZones = await read<{ n: number }>(`select count(*)::int n from unnest($1::text[]) s where state_time_zone(s) is not null`, [Object.keys(STATE_TZ)]);
    t.ok("time zones: the database knows the same 51", sqlZones[0].n === 51);
    t.ok("localDay: 01:30 UTC on the 1st is still the 31st in Chicago", localDay("America/Chicago", new Date("2026-01-01T01:30:00Z")) === "2025-12-31"
      && localDay("America/New_York", new Date("2026-07-01T03:59:00Z")) === "2026-06-30" && localDay("America/New_York", new Date("2026-07-01T04:00:00Z")) === "2026-07-01");

    // A sale rung at the Mesa Verde store, in Central time, at 01:30 UTC on the 1st of next month: it is the last day of this month there.
    const realToday = await tx(SYS, (c) => bizToday(c, ENTITY, LOC.PALESTINE));
    const nextFirst = monthsOn(realToday, 1);
    const pinnedAt = `${nextFirst}T01:30:00Z`;
    await tx(SYS, (c) => c.query(`update location set time_zone = 'America/Chicago' where id = $1 and entity_id = $2`, [LOC.PALESTINE, ENTITY]));
    pinClock(pinnedAt);
    let saleDay = "", invDay = "", storeDay = "", sqlDay = "";
    try {
      const sc = demoScope(LUIS, "Luis");
      const r = await tx({ kind: "user", id: LUIS, label: "Luis" }, async (c) => {
        storeDay = await bizToday(c, sc, LOC.PALESTINE);
        sqlDay = (await q<{ d: string }>(c, `select business_today($1, $2)::text d /* unscoped: keyed by entity */`, [ENTITY, LOC.PALESTINE]))[0].d;
        const ses = await sessionAt(c, sc, REG_PAL);
        const o = await pos.createOrder(c, sc, new Set(["cashier", "sales"]), { kind: "sale", locationId: LOC.PALESTINE, sessionId: ses.id,
          lines: [{ productId: LAMP, qty: 1, fulfillment: "carry" }] }) as { id: string };
        const due = await q<{ total_minor: string }>(c, `select total_minor from sales_order where id = $1 and entity_id = $2`, [o.id, ENTITY]);
        await pos.checkout(c, sc, o.id, { sessionId: ses.id, tenders: [{ method: "cash", amountMinor: BigInt(due[0].total_minor) }] });
        const je = await q<{ d: string }>(c, `select posting_date::text d from journal_entry where entity_id = $1 and source_id = $2 and source_type = 'sale'`, [ENTITY, o.id]);
        const inv = await q<{ d: string }>(c, `select invoice_date::text d from customer_invoice where entity_id = $1 and sales_order_id = $2`, [ENTITY, o.id]);
        if (ses.mine) await pos.closeSession(c, sc, ses.id, { counts: { "1": Number(await pos.expectedCash(c, ENTITY, ses.id)) } });
        return { je: je[0]?.d ?? "", inv: inv[0]?.d ?? "" };
      });
      saleDay = r.je; invDay = r.inv;
    } finally { pinClock(null); }
    const expect = addDays(nextFirst, -1);
    t.ok("store-local date: the store's day is the last day of the month while UTC is on the 1st", storeDay === expect && sqlDay === expect, `${storeDay} / ${sqlDay} at ${pinnedAt}`);
    t.ok("store-local date: the sale posts on the last day of the previous month, not UTC's 1st", saleDay === expect, `${saleDay} (UTC says ${nextFirst})`);
    t.ok("store-local date: its invoice is dated the same day", invDay === expect, invDay);
    await tx(SYS, (c) => c.query(`update location set time_zone = null where id = $1 and entity_id = $2`, [LOC.PALESTINE, ENTITY]));

    // =========================================================== auto-opening
    console.log("  -- periods open on their own");
    // the clock pinned three months on: the months two ahead of then are not open yet
    const base = monthsOn(realToday, 3);
    pinClock(`${base}T17:00:00Z`);
    try {
      const fyEnd = Number((await read<{ fy: number }>(`select fiscal_year_end_month fy from entity where id = $1 /* unscoped: the company */`, [RIO_ENTITY]))[0].fy);
      const fy = P.fiscalYearOf(base, fyEnd);
      const twoOn = addDays(monthsOn(base, 2), 9);
      const before = await periodOf(RIO_ENTITY, twoOn);
      await smallPost(rioScope(), twoOn, "two months ahead");
      const after = await periodOf(RIO_ENTITY, twoOn);
      const ev = await read<{ kind: string; reason: string }>(`select kind, reason from period_event where entity_id = $1 and starts_on = $2::date order by at desc limit 1`, [RIO_ENTITY, monthsOn(twoOn, 0)]);
      t.ok("auto-open: a posting two months ahead opens its month, logged", !before && after?.status === "open" && ev[0]?.kind === "auto_opened" && /needed it/.test(ev[0].reason), JSON.stringify(ev[0]));
      // a date later in the fiscal year (if the year runs past two months on)
      const late = fy.end > lastDay(monthsOn(base, 2)) ? addDays(fy.end, -3) : null;
      if (late) {
        await smallPost(rioScope(), late, "later in the fiscal year");
        t.ok("auto-open: a date in the current fiscal year opens its month", (await periodOf(RIO_ENTITY, late))?.status === "open");
      } else t.ok("auto-open: (the fiscal year ends within two months; nothing further to open)", true);
      const far = addDays(monthsOn(fy.end, 4), 4);
      await t.throws("auto-open: further ahead is refused, saying what to do", () => smallPost(rioScope(), far),
        /no open period for .*up to two months ahead or within this fiscal year.*open .* in Books, Periods/);
      await t.throws("auto-open: before the fiscal year is refused, saying what to do", () => smallPost(rioScope(), "2019-03-15"),
        /no period for 2019-03-15 .*before this fiscal year.*Books, Periods/);
      t.ok("auto-open: nothing was opened for the refused dates", !(await periodOf(RIO_ENTITY, far)) && !(await periodOf(RIO_ENTITY, "2019-03-15")));

      // the daily job: three months ahead for every company of a customer that is not suspended
      await tx(SYS, (c) => c.query(`update tenant set status = 'suspended' where id = $1`, [RIO_TENANT]));
      const job = await rollPeriods(new Date());
      await tx(SYS, (c) => c.query(`update tenant set status = 'active' where id = $1`, [RIO_TENANT]));
      const demoItem = job.items.find((x) => x.entityId === ENTITY);
      t.ok("period job: a suspended customer's companies are skipped", !job.items.some((x) => x.entityId === RIO_ENTITY));
      t.ok("period job: the others get three months ahead", !!demoItem?.ok && !!(await periodOf(ENTITY, addDays(monthsOn(base, 3), 1))), demoItem?.note);
      const again = await rollPeriods(new Date());
      t.ok("period job: running it again opens nothing more", again.items.find((x) => x.entityId === ENTITY)?.note === "three months ahead already open");
    } finally { pinClock(null); }

    // ============================================================ month-end
    console.log("  -- month-end close");
    const lastMonth = monthsOn(realToday, -1);
    const pm = await periodOf(ENTITY, lastMonth);
    const list = await RP.get<{ periods: { id: string; status: string; label: string }[]; counts: { open: number; closed: number } }>(PEOPLE.CONTROLLER, "/books/periods");
    t.ok("periods: the controller sees every month with its status", list.periods.length >= 12 && list.periods.some((p) => p.id === pm.id));
    await t.throws("periods: a clerk does not see them", () => RP.get(PEOPLE.CLERK, "/books/periods"), /owner or a controller/);
    const ck = await RP.get<{ items: { id: string; ok: boolean; screen: string; rows?: unknown[]; detail: string }[]; clear: boolean }>(PEOPLE.CONTROLLER, `/books/periods/${pm.id}/checklist`);
    const ids = ck.items.map((x) => x.id);
    t.ok("checklist: drafts, drawers, bank and the 1300 / 2100 / 1110 / inter-company tie-outs", ["drafts", "drawers", "bank", "tie_stock", "tie_tax", "tie_financing", "tie_intercompany"].every((x) => ids.includes(x)), ids.join(","));
    t.ok("checklist: every item says where to fix it and carries what is behind it", ck.items.every((x) => !!x.screen && Array.isArray(x.rows) && x.detail.length > 5));
    await t.throws("close: this month has not ended", async () => {
      const cur = await periodOf(ENTITY, realToday);
      return RP.post(PEOPLE.CONTROLLER, `/books/periods/${cur.id}/close`, {});
    }, /has not ended yet/);
    // make sure something is on the list, so a plain close is refused
    const bill = await tx(SYS, async (c) => (await q<{ id: string }>(c, `
      insert into invoice (tenant_id, entity_id, vendor_id, kind, reference, invoice_date, total_minor, status)
      select $1, $2, ve.vendor_id, 'operating', 'PERIOD-CHECK', $3::date, 1234, 'captured' from vendor_entity ve where ve.entity_id = $2 limit 1 returning id`,
      [TENANT, ENTITY, addDays(lastMonth, 2)]))[0]?.id);
    const ck2 = await RP.get<{ items: { id: string; ok: boolean; rows: { kind?: string }[] }[] }>(PEOPLE.CONTROLLER, `/books/periods/${pm.id}/checklist`);
    t.ok("checklist: a bill dated in the month and not in the books is listed under drafts", !!bill && ck2.items.find((x) => x.id === "drafts")!.rows.some((r) => r.kind === "bill"));
    await t.throws("close: with items open it is refused, naming them", () => RP.post(PEOPLE.CONTROLLER, `/books/periods/${pm.id}/close`, {}), /still has \d+ items? on the checklist .*bills and payroll not yet in the books/);
    await t.throws("close: a clerk cannot close a month", () => RP.post(PEOPLE.CLERK, `/books/periods/${pm.id}/close`, { override: true, reason: "x" }), /closing a month needs one of: owner, controller/);
    const closed = await RP.post<{ closed: boolean; overridden: string[] }>(PEOPLE.CONTROLLER, `/books/periods/${pm.id}/close`, { override: true, reason: "the bill is for next month; moving it" });
    t.ok("close: the controller closes it anyway with a reason, recorded", closed.closed && closed.overridden.length >= 1
      && (await read(`select 1 from period_event where entity_id = $1 and period_id = $2 and kind = 'closed' and reason like 'the bill is for next month%'`, [ENTITY, pm.id])).length === 1);
    const again2 = await RP.post<{ already: boolean }>(PEOPLE.CONTROLLER, `/books/periods/${pm.id}/close`, {});
    t.ok("close: closing it twice is harmless", again2.already === true);
    await t.throws("closed: a posting dated in it is refused in a plain sentence", () => smallPost(demoScope(), addDays(lastMonth, 4)),
      /The books for \w+ \d{4} are closed, so nothing can be posted on .*reopen the month in Books, Periods/);
    await t.throws("closed: the database refuses too", () => tx(SYS, (c) => c.query(`insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, description) values ($1,$2,$3,$4,'manual','direct')`,
      [TENANT, ENTITY, pm.id, addDays(lastMonth, 4)])), /are closed, so nothing can be posted/);
    await t.throws("reopen: a controller cannot reopen", () => RP.post(PEOPLE.CONTROLLER, `/books/periods/${pm.id}/reopen`, { reason: "late bill" }), /reopening a closed month needs one of: owner/);
    await t.throws("reopen: the owner must say why", () => RP.post(PEOPLE.STEVE, `/books/periods/${pm.id}/reopen`, { reason: " " }), /say why the month is being reopened/);
    await RP.post(PEOPLE.STEVE, `/books/periods/${pm.id}/reopen`, { reason: "a late utility bill" });
    const aud = await read<{ reason: string }>(`select reason from audit_event where entity_id = $1 and table_name = 'fiscal_period' and row_id = $2 and action = 'transition' order by id desc limit 1`, [ENTITY, pm.id]);
    t.ok("reopen: the owner reopens with a reason; the audit trail and the period log keep it", (await periodOf(ENTITY, lastMonth)).status === "open" && aud[0]?.reason === "a late utility bill"
      && (await read(`select 1 from period_event where entity_id = $1 and period_id = $2 and kind = 'reopened'`, [ENTITY, pm.id])).length === 1);
    await smallPost(demoScope(), addDays(lastMonth, 4), "the late bill");
    t.ok("reopen: postings land again", true);
    await tx(SYS, (c) => c.query(`update invoice set status = 'rejected' where id = $1 and entity_id = $2`, [bill, ENTITY]));
    await t.throws("period log: it is kept as written", () => tx(SYS, (c) => c.query(`update period_event set reason = 'x' where entity_id = $1`, [ENTITY])), /kept as written/);
    await t.throws("open by hand: a month already there is refused", () => RP.post(PEOPLE.CONTROLLER, "/books/periods/open", { month: lastMonth.slice(0, 7), reason: "again" }), /already has a period/);

    // ============================================================= year-end
    console.log("  -- year-end close");
    const fyEndRio = (() => { const y = Number(realToday.slice(0, 4)) - 2; return `${y}-12-31`; })();   // a year long gone: Rio had no periods there
    const midYear = `${fyEndRio.slice(0, 4)}-06-15`;
    await RP.post(RIO_OWNER, "/books/periods/open", { month: midYear.slice(0, 7), reason: "bringing in an old year" }, RIO_ENTITY);
    await tx(rioScope().actor, async (c) => {
      await post(c, rioScope(), { date: midYear, sourceType: "manual", sourceId: null, description: "old revenue", lines: [{ code: "1010", debit: 100000n }, { code: "4010", credit: 100000n }] });
      await post(c, rioScope(), { date: midYear, sourceType: "manual", sourceId: null, description: "old fuel", lines: [{ code: "6310", debit: 30000n }, { code: "1010", credit: 30000n }] });
    });
    const y1 = await RP.post<{ already: boolean; id: string; journalEntryId: string; netIncomeMinor: string }>(RIO_OWNER, "/books/years/close", { fyEnd: fyEndRio, override: true, reason: "old year, nothing left to do" }, RIO_ENTITY);
    const lines = await read<{ code: string; d: string; cr: string }>(`select g.code, jl.debit_minor::text d, jl.credit_minor::text cr from journal_line jl join gl_account g on g.id = jl.gl_account_id
      join journal_entry je on je.id = jl.journal_entry_id where je.id = $1 and je.entity_id = $2 order by g.code`, [y1.journalEntryId, RIO_ENTITY]);
    const by = (code: string) => lines.find((l) => l.code === code);
    t.ok("year-end: revenue and expenses close to 3900 Retained earnings in one entry on the year's last day", y1.netIncomeMinor === "70000" && by("4010")?.d === "100000" && by("6310")?.cr === "30000" && by("3900")?.cr === "70000"
      && (await read(`select 1 from journal_entry where id = $1 and entity_id = $2 and posting_date = $3::date and source_type = 'closing'`, [y1.journalEntryId, RIO_ENTITY, fyEndRio])).length === 1, JSON.stringify(lines));
    const ytd = await read<{ n: string }>(`select coalesce(sum(jl.debit_minor - jl.credit_minor), 0)::text n from journal_line jl join journal_entry je on je.id = jl.journal_entry_id join gl_account g on g.id = jl.gl_account_id
      where je.entity_id = $1 and je.posting_date between $2::date and $3::date and g.account_type in ('revenue','expense')`, [RIO_ENTITY, `${fyEndRio.slice(0, 4)}-01-01`, fyEndRio]);
    t.ok("year-end: the year's income statement nets to zero after the close", ytd[0].n === "0");
    const y2 = await RP.post<{ already: boolean; id: string }>(RIO_OWNER, "/books/years/close", { fyEnd: fyEndRio, override: true, reason: "again" }, RIO_ENTITY);
    t.ok("year-end: closing it again returns the same close (idempotent)", y2.already && y2.id === y1.id
      && (await read(`select 1 from journal_entry where entity_id = $1 and source_type = 'closing'`, [RIO_ENTITY])).length === 1);
    const months = await read<{ n: number }>(`select count(*)::int n from fiscal_period where entity_id = $1 and starts_on between $2::date and $3::date and status = 'closed'`, [RIO_ENTITY, `${fyEndRio.slice(0, 4)}-01-01`, fyEndRio]);
    t.ok("year-end: every month of the year is closed", months[0].n === 12, String(months[0].n));
    await t.throws("year-end: a posting into the closed year is refused", () => smallPost(rioScope(), midYear), /are closed, so nothing can be posted/);
    const juneId = (await periodOf(RIO_ENTITY, midYear)).id;
    const re = await RP.post<{ yearReopened: boolean }>(RIO_OWNER, `/books/periods/${juneId}/reopen`, { reason: "a missed invoice" }, RIO_ENTITY);
    const yr = (await read<{ status: string; reversal_entry_id: string | null }>(`select status, reversal_entry_id from fiscal_year_close where id = $1 and entity_id = $2`, [y1.id, RIO_ENTITY]))[0];
    const re3900 = await read<{ n: string }>(`select coalesce(sum(jl.credit_minor - jl.debit_minor), 0)::text n from journal_line jl join journal_entry je on je.id = jl.journal_entry_id join gl_account g on g.id = jl.gl_account_id
      where je.entity_id = $1 and g.code = '3900'`, [RIO_ENTITY]);
    t.ok("year-end: reopening a month of a closed year reverses the closing entry", re.yearReopened && yr.status === "reopened" && !!yr.reversal_entry_id && re3900[0].n === "0", JSON.stringify(yr));
    await smallPost(rioScope(), midYear, "the missed invoice");
    const y3 = await RP.post<{ already: boolean; netIncomeMinor: string }>(RIO_OWNER, "/books/years/close", { fyEnd: fyEndRio, override: true, reason: "closed again" }, RIO_ENTITY);
    t.ok("year-end: closing it again after the reopen makes a new close with the late entry in it", !y3.already && y3.netIncomeMinor === "70100", y3.netIncomeMinor);
    await t.throws("year-end: a controller cannot reopen a year", () => RP.post(PEOPLE.CONTROLLER, "/books/years/reopen", { fyEnd: fyEndRio, reason: "x" }), /reopening a closed year needs one of: owner/);

    // ============================================================ scheduler
    console.log("  -- scheduler");
    // a second runner holding the lock: this tick skips
    const holder = await pool.connect();
    try {
      await holder.query(`select pg_advisory_lock(7406312) /* unscoped: the scheduler's lock */`);
      const skipped = await runDue({ trigger: "manual", only: ["periods"], force: true });
      t.ok("scheduler: with another runner holding the lock, a tick runs nothing", skipped.skipped === "locked" && skipped.runs.length === 0);
    } finally { await holder.query(`select pg_advisory_unlock(7406312) /* unscoped: the scheduler's lock */`); holder.release(); }
    const ran = await runDue({ trigger: "manual", only: ["periods", "quote_holds"], force: true });
    t.ok("scheduler: each job run is recorded with its outcome", ran.runs.length === 2 && ran.runs.every((r) => r.status === "ok"), JSON.stringify(ran.runs));
    const rec = await read<{ status: string; finished_at: string | null; items: number }>(`select r.status, r.finished_at::text, (select count(*)::int from job_run_item i where i.run_id = r.id) items from job_run r where r.id = $1 /* unscoped: the job log */`, [ran.runs[0].id]);
    t.ok("scheduler: the run row has its finish and its per-company items", rec[0]?.status === "ok" && !!rec[0].finished_at && rec[0].items >= 2);
    const notDue = await runDue({ trigger: "manual", only: ["periods"] });
    t.ok("scheduler: a job that just ran is not due again", notDue.runs.length === 0 && notDue.skipped === null);
    const view = await RJ.get<{ jobs: { id: string; status: string; lastRunId: string | null; nextRunAt: string | null; note: string | null }[]; runs: { id: string }[] }>(PEOPLE.STEVE, "/admin/jobs");
    const pj = view.jobs.find((j) => j.id === "periods")!;
    t.ok("jobs view: the owner sees last run, next run and how it went for this company", pj.status === "ok" && !!pj.lastRunId && !!pj.nextRunAt && view.jobs.length >= 8);
    const det = await RJ.get<{ items: { note: string }[]; status: string }>(PEOPLE.STEVE, `/admin/jobs/runs/${pj.lastRunId}`);
    t.ok("jobs view: a run opens to what it did for this company only", det.items.length === 1 && det.status === "ok");
    await t.throws("jobs view: a controller does not see it", () => RJ.get(PEOPLE.CONTROLLER, "/admin/jobs"), /owner's to see/);
    const all = await tx(SYS, (c) => jobsView(c, null));
    t.ok("jobs view: the operator's view covers the install", all.find((j) => j.id === "periods")?.status === "ok");

    // =========================================================== errors
    console.log("  -- server errors");
    t.ok("errors: references are six characters a person can read out", /^[A-Z2-9]{6}$/.test(newRef()) && !/[01OI]/.test(newRef()));
    const red = redact("Bearer abc.def password=hunter2secret token: erpt_live_abcdef card 4111 1111 1111 1111 mail bob@example.com " + "x".repeat(40));
    t.ok("errors: messages are stored redacted", !/hunter2|4111 1111|bob@example|erpt_live_abcdef|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/.test(red) && /\[redacted\]/.test(red), red);
    const sent: string[] = [];
    alertTestHooks(async (_u, init) => { sent.push(init.body); return { ok: true, status: 200 }; });
    process.env.ERP_ALERT_WEBHOOK = "https://hooks.example/erp";
    try {
      const ref = await recordError(new Error("boom with secret=abc123 for ann@example.com"), { kind: "request", method: "GET", path: `/api/c/${ENTITY}/periods-check` });
      await new Promise((r) => setTimeout(r, 50));
      const row = (await read<{ message: string; entity_ref: string; tenant_ref: string; alerted: boolean }>(`select message, entity_ref, tenant_ref, alerted from server_error where ref = $1 /* unscoped: the error log */`, [ref]))[0];
      const pathKept = (await read<{ path: string }>(`select path from server_error where ref = $1`, [ref]))[0]?.path;
      t.ok("errors: an error is kept under its reference, redacted, with its company (ids kept whole)", !!row && !/abc123|ann@example/.test(row.message) && row.entity_ref === ENTITY && row.tenant_ref === TENANT
        && pathKept === `/api/c/${ENTITY}/periods-check`, pathKept);
      t.ok("alerts: one redacted line goes to the webhook", sent.length === 1 && sent[0].includes(ref) && !/abc123|ann@example/.test(sent[0]), sent[0]);
      const second = await alert("ZZZZZZ", { kind: "request" }, "again", null);
      t.ok("alerts: a second within the minute is held back (rate limited)", second === false && sent.length === 1);
      const later = await alert("YYYYYY", { kind: "request" }, "later", null, Date.now() + 61_000);
      t.ok("alerts: after the minute the next goes, saying how many were held", later === true && sent.length === 2 && /\+1 more/.test(sent[1]), sent[1]);
    } finally { delete process.env.ERP_ALERT_WEBHOOK; alertTestHooks(null); }

    // ====================================================== selling rules
    console.log("  -- selling rules and pack settings");
    const SR = await import("../../server/modules/pos.ts");
    const RPOS = routes(SR.module as never);
    const was = await tx(SYS, (c) => pos.settings(c, ENTITY));
    const saved = await RPOS.post<pos.Settings>(PEOPLE.STEVE, "/pos/settings", { discountLimitPct: "12.5", quoteValidDays: "21", layawayDepositPct: "25", layawayDays: "120", layawayPayments: "6", tenders: ["cash", "card"] });
    t.ok("selling rules: discount limit, quote life, layaway terms and tenders are saved per company", saved.discountLimitBps === 1250 && saved.quoteValidDays === 21 && saved.layawayMinDepositBps === 2500
      && saved.layawayMaxDays === 120 && saved.layawayInstallments === 6 && saved.tenders.join() === "cash,card");
    await t.throws("selling rules: a quote cannot hold stock longer than it is good for", () => RPOS.post(PEOPLE.STEVE, "/pos/settings", { quoteValidDays: "1", quoteHoldMaxDays: "3" }), /longer than the quote is good for/);
    await t.throws("selling rules: at least one tender", () => RPOS.post(PEOPLE.STEVE, "/pos/settings", { tenders: [] }), /at least one way to pay/);
    const q1 = await tx({ kind: "user", id: PEOPLE.STEVE, label: "Steve" }, async (c) => {
      const o = await pos.createOrder(c, demoScope(), new Set(["owner"]), { kind: "quote", locationId: LOC.ENOLA, customerId: "88888888-0000-0000-0000-000000000001", lines: [{ productId: LAMP, qty: 1, fulfillment: "carry" }] }) as { id: string };
      const r = await q<{ d: string }>(c, `select quote_expires_on::text d from pos_order where sales_order_id = $1 and entity_id = $2`, [o.id, ENTITY]);
      return { d: r[0].d, t: await bizToday(c, ENTITY, LOC.ENOLA) };
    });
    t.ok("selling rules: a new quote is good for the company's 21 days", q1.d === addDays(q1.t, 21), `${q1.d} from ${q1.t}`);
    await t.throws("selling rules: a tender the company does not take is refused at checkout", () => tx({ kind: "user", id: LUIS, label: "Luis" }, async (c) => {
      const sc = demoScope(LUIS, "Luis");
      const ses = await sessionAt(c, sc, REG_PAL);
      const o = await pos.createOrder(c, sc, new Set(["cashier"]), { kind: "sale", locationId: LOC.PALESTINE, sessionId: ses.id, lines: [{ productId: LAMP, qty: 1, fulfillment: "carry" }] }) as { id: string };
      return pos.checkout(c, sc, o.id, { sessionId: ses.id, tenders: [{ method: "check", amountMinor: 100000n, reference: "1001" }] });
    }), /check is not taken here; the selling rules list cash, card/);
    // put the demo back the way it was
    await RPOS.post(PEOPLE.STEVE, "/pos/settings", { discountLimitPct: String(was.discountLimitBps / 100), quoteValidDays: String(was.quoteValidDays),
      layawayDepositPct: String(was.layawayMinDepositBps / 100), layawayDays: String(was.layawayMaxDays), layawayPayments: String(was.layawayInstallments), tenders: was.tenders });

    // pack settings a company without its own rows takes: a scratch company with the furniture pack's values
    // (in a transaction that is rolled back: the scratch company is never kept)
    let pk = null as unknown as { s: pos.Settings; a: Awaited<ReturnType<typeof ar.settings>>; f: Awaited<ReturnType<typeof fleetSettings>> };
    await tx(SYS, async (c) => {
      const e = (await q<{ id: string }>(c, `insert into entity (tenant_id, name, legal_name) values ($1, 'Pack Check Co', 'Pack Check Co LLC') returning id /* unscoped: a scratch company */`, [RIO_TENANT]))[0].id;
      for (const [k, v] of [["pos.discount_limit_bps", 1000], ["pos.quote_days", 14], ["pos.layaway_days", 60], ["pos.deposit_min_bps", 4000], ["pos.tenders", ["cash", "card"]],
        ["ar.late_fee", { rate_bps: 500, min_minor: 1000, grace_days: 10 }], ["fleet.service_minutes", { base: 15, per_piece: 5, per_stair_flight: 10 }]] as [string, unknown][])
        await c.query(`insert into entity_setting (entity_id, key, value, set_by, from_pack) values ($1,$2,$3,'checks',true)`, [e, k, JSON.stringify(v)]);
      const s = await pos.settings(c, e);
      const a = await ar.settings(c, e);
      const f = await fleetSettings(c, e);
      pk = { s, a, f };
      throw new Error("roll back the scratch company");
    }).catch((e) => { if (!/roll back the scratch company/.test((e as Error).message)) throw e; });
    t.ok("pack settings: POS reads the pack's discount limit, quote days, layaway days, deposit and tenders", pk.s.discountLimitBps === 1000 && pk.s.quoteValidDays === 14 && pk.s.layawayMaxDays === 60
      && pk.s.specialOrderDepositBps === 4000 && pk.s.tenders.join() === "cash,card", JSON.stringify(pk.s));
    t.ok("pack settings: A/R reads the pack's late fee", pk.a.late_fee_enabled && pk.a.late_fee_bps === 500 && pk.a.late_fee_grace_days === 10 && pk.a.late_fee_min_minor === "1000");
    t.ok("pack settings: delivery reads the pack's minutes per stop", pk.f.baseMin === 15 && pk.f.perPieceMin === 5 && pk.f.perStairPieceMin === 10);

    // ===================================================== campaign outbox
    console.log("  -- campaign sends through the outbox");
    const out = await tx(SYS, async (c) => {
      // an email connection that goes nowhere real: the outbox row is what we look at
      const conn = (await q<{ id: string }>(c, `select id from admin_connection where (entity_id = $1 or (entity_id is null and tenant_id = $2)) and kind = 'email' and active limit 1`, [ENTITY, TENANT]))[0];
      return conn?.id ?? null;
    });
    if (out) {
      const cust = (await read<{ id: string; email: string }>(`select id, email from customer where entity_id = $1 and email is not null limit 1`, [ENTITY]))[0];
      const msgId = await tx(SYS, async (c) => {
        await crm.recordConsent(c, ENTITY, cust.id, "email", "opt_in", "checks", PEOPLE.STEVE).catch(() => {});
        const r = await q<{ id: string }>(c, `insert into crm_message (entity_id, customer_id, channel, to_ref, subject, body, status, unsub_token)
          values ($1,$2,'email','c***','Outbox check','Hello',  'queued', $3) returning id`, [ENTITY, cust.id, "outboxcheck" + Date.now().toString(36).padEnd(16, "x")]);
        return r[0].id;
      });
      await tx(SYS, (c) => crm.processQueue(c, ENTITY));
      await idle();
      const ob = await read<{ n: number }>(`select count(*)::int n from outbound_message where entity_id = $1 and source_table = 'crm_message' and source_id = $2`, [ENTITY, msgId]);
      t.ok("campaign: a send is one outbox row, written with the message, sent after commit", ob[0].n === 1);
      await tx(SYS, (c) => crm.processQueue(c, ENTITY));
      const ob2 = await read<{ n: number }>(`select count(*)::int n from outbound_message where entity_id = $1 and source_table = 'crm_message' and source_id = $2`, [ENTITY, msgId]);
      t.ok("campaign: running the queue again sends nothing twice", ob2[0].n === 1);
    } else {
      const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../../packages/core/crm.ts", import.meta.url), "utf8"));
      t.ok("campaign: sends go through the outbox (queueEmail / queueSms, not a direct send)", /messaging\.queueEmail\(c, entityId/.test(src) && /messaging\.queueSms\(c, entityId/.test(src) && !/messaging\.sendEmail\(c, entityId, \{ to: \[to\]/.test(src));
    }
  } finally {
    pinClock(null);
    c0.release();
  }
}
