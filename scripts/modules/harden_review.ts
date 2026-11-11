// Checks for the review of the hardening work (migrations 0056, 0058, 0059;
// built from the reviewer's repro scripts race.sh and holes.ts):
//   the P&L survives a year-end close (Books P&L, Home, the pnl_lines report);
//   a posting and a month-end close cannot pass each other (two connections);
//   a direct insert into a closed month -- by its date, through another
//   company's period, by adding lines -- is refused, and so is a plain UPDATE
//   that reopens it; two year closes at once; a failing pull connection backs
//   off and stops; the job log keeps 90 days; Run now queues; the demo never
//   calls outside on a schedule; the last UTC dates (defaults, views);
//   phone numbers and URL passwords redacted; the fatal-error shutdown.

import type { T } from "./harness.ts";
import { readFileSync } from "node:fs";
import { ENTITY, RIO_ENTITY, TENANT, PEOPLE } from "./harness.ts";
import { pool, tx, q, type Scope } from "../../packages/core/db.ts";
import { today as bizToday, addDays } from "../../packages/core/clock.ts";
import * as P from "../../packages/core/periods.ts";
import { post } from "../../packages/core/posting.ts";
import * as views from "../../server/views.ts";
import { companyOf } from "./inventory.ts";
import { runDue, queueJob, jobById } from "../../server/scheduler.ts";
import { runDueConnections, runDueVendorFeeds, runDueEdi } from "../../scripts/run-due.ts";
import { redact, installProcessHandlers, onFatal, resetProcessHandlersForTests } from "../../server/errors.ts";
import { DATASETS } from "../../packages/core/reports_datasets.ts";

const RIO_TENANT = "dddd0000-0000-0000-0000-00000000000d";
const RIO_OWNER = "eeee0000-0000-0000-0000-000000000201";
const SYS = { kind: "system" as const, label: "checks" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const monthsOn = (day: string, n: number) => { const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)) - 1 + n; return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); };

export async function run(t: T) {
  const c0 = await t.pool.connect();
  const read = <X extends Record<string, unknown>>(sql: string, p: unknown[] = []) => t.q<X>(c0, `${sql} /* unscoped: the checks read what they need */`, p);
  const rio: Scope = { tenantId: RIO_TENANT, entityId: RIO_ENTITY, actor: { kind: "user", id: RIO_OWNER, label: "Rio owner" } };
  const demo: Scope = { tenantId: TENANT, entityId: ENTITY, actor: { kind: "user", id: PEOPLE.STEVE, label: "Steve" } };
  const periodOf = async (entity: string, day: string) => (await read<{ id: string; status: string }>(`select id, status from fiscal_period where entity_id = $1 and $2::date between starts_on and ends_on`, [entity, day]))[0];
  const acct = async (tenant: string, code: string) => (await read<{ id: string }>(`select id from gl_account where tenant_id = $1 and code = $2`, [tenant, code]))[0].id;
  const realToday = await tx(SYS, (c) => bizToday(c, ENTITY));
  const restore: (() => Promise<unknown>)[] = [];

  try {
    // ============================================== the P&L after a year close
    console.log("  -- the P&L survives a year-end close");
    const y = Number(realToday.slice(0, 4)) - 4;
    const fyStart = `${y}-01-01`, fyEnd = `${y}-12-31`, mid = `${y}-05-10`;
    await tx(rio.actor, async (c) => {
      await P.openMonth(c, rio, mid.slice(0, 7), "an old year for the P&L check");
      await post(c, rio, { date: mid, sourceType: "manual", sourceId: null, description: "old revenue", lines: [{ code: "1010", debit: 50000n }, { code: "4010", credit: 50000n }] });
      await post(c, rio, { date: mid, sourceType: "manual", sourceId: null, description: "old fuel", lines: [{ code: "6310", debit: 20000n }, { code: "1010", credit: 20000n }] });
    });
    const rioCo = await companyOf(RIO_ENTITY);
    const pnlBefore = await tx(SYS, (c) => views.pnl(c, rioCo, fyStart, fyEnd));
    await tx(rio.actor, (c) => P.closeYear(c, rio, fyEnd, { override: true, reason: "P&L check" }));
    const pnlAfter = await tx(SYS, (c) => views.pnl(c, rioCo, fyStart, fyEnd));
    const tot = (x: typeof pnlAfter, code: string) => x.accounts.find((a) => a.code === code)?.total ?? "0";
    t.ok("P&L: after the year closes, Books shows the year's revenue and costs as before", tot(pnlAfter, "4010") === tot(pnlBefore, "4010") && tot(pnlAfter, "4010") !== "0"
      && tot(pnlAfter, "6310") === tot(pnlBefore, "6310"), `${tot(pnlBefore, "4010")} -> ${tot(pnlAfter, "4010")}`);
    // the report catalog's own query for pnl_lines, summed over the year
    const pl = DATASETS.find((d) => d.id === "pnl_lines")!;
    const ds = (await read<{ n: string }>(`select coalesce(sum(x.net_income), 0)::text n from (${pl.sql}) x where x.posted_on between $2::date and $3::date`, [RIO_ENTITY, fyStart, fyEnd]))[0].n;
    t.ok("P&L: the pnl_lines report keeps the year's net income (the closing entry is left out)", ds === "30000", ds);
    const home = await tx(SYS, (c) => c.query(`select count(*)::int n from journal_entry je where je.entity_id = $1 and je.source_type = 'closing'`, [RIO_ENTITY]));
    t.ok("P&L: (the close did post its closing entry)", home.rows[0].n >= 1);

    // ===================================== the close/post race (two connections)
    console.log("  -- a posting and a close cannot pass each other");
    const lastMonth = monthsOn(realToday, -1);
    const pm = await periodOf(ENTITY, lastMonth);
    const B = await pool.connect(), A = await pool.connect();
    let raceErr = "";
    try {
      await B.query("begin");
      await B.query(`select id from fiscal_period where id = $1 and entity_id = $2 for update`, [pm.id, ENTITY]);   // the close holds the month
      await A.query("begin");
      let settled = false;
      const posting = A.query(`insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, description)
          values ($1,$2,$3,$4,'manual','race: posted into a month being closed') returning id`, [TENANT, ENTITY, pm.id, addDays(lastMonth, 19)])
        .then(() => { settled = true; return null; }, (e: Error) => { settled = true; return e; });
      await sleep(600);
      t.ok("race: a posting into a month being closed waits for the close", !settled);
      await B.query(`insert into period_event (entity_id, period_id, kind, starts_on, ends_on, reason, by_label) values ($1,$2,'closed',$3,$4,'race check','checks')`,
        [ENTITY, pm.id, lastMonth, addDays(monthsOn(lastMonth, 1), -1)]);
      await B.query(`update fiscal_period set status = 'closed', locked_at = now() where id = $1 and entity_id = $2`, [pm.id, ENTITY]);
      await B.query("commit");
      const err = await posting;
      raceErr = err ? err.message : "";
      await A.query("rollback");
    } finally { A.release(); B.release(); }
    t.ok("race: once the close commits, the waiting posting is refused in a sentence", /are closed, so nothing can be posted/.test(raceErr), raceErr);
    t.ok("race: nothing landed in the closed month", (await read(`select 1 from journal_entry where entity_id = $1 and description like 'race:%'`, [ENTITY])).length === 0);

    // ============================================ the holes into a closed month
    console.log("  -- a closed month cannot be reached around the rules");
    const nowPeriod = await periodOf(ENTITY, realToday);
    const day = addDays(lastMonth, 19);
    await t.throws("hole: an entry dated in the closed month, filed under this month's open period, is refused", () => tx(SYS, (c) => c.query(
      `insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, description) values ($1,$2,$3,$4,'manual','hole')`,
      [TENANT, ENTITY, nowPeriod.id, day])), /cannot be filed in the period/);
    const rioNow = await periodOf(RIO_ENTITY, realToday);
    await t.throws("hole: an entry filed under another company's period is refused", () => tx(SYS, (c) => c.query(
      `insert into journal_entry (tenant_id, entity_id, period_id, posting_date, source_type, description) values ($1,$2,$3,$4,'manual','hole')`,
      [TENANT, ENTITY, rioNow.id, realToday])), /not this company's/);
    const old = (await read<{ id: string; m: number }>(`select je.id, (select max(seq) from journal_line where journal_entry_id = je.id) m from journal_entry je where je.entity_id = $1 and je.period_id = $2 limit 1`, [ENTITY, pm.id]))[0];
    if (old) {
      const [a1, a2] = [await acct(TENANT, "1010"), await acct(TENANT, "6800")];
      await t.throws("hole: lines added to an entry in a closed month are refused", () => tx(SYS, (c) => c.query(
        `insert into journal_line (journal_entry_id, seq, gl_account_id, debit_minor, credit_minor) values ($1,$2,$3,999,0),($1,$4,$5,0,999)`, [old.id, old.m + 1, a1, old.m + 2, a2])),
        /in a closed month; post a new entry in an open month/);
    } else t.ok("hole: (no entry in that month to add lines to)", true);
    await t.throws("hole: a plain UPDATE cannot reopen a closed month", () => tx(SYS, (c) => c.query(`update fiscal_period set status = 'open' where id = $1 and entity_id = $2`, [pm.id, ENTITY])),
      /reopens from Books, Periods, by the owner with a reason/);
    await tx(demo.actor, (c) => P.reopenMonth(c, demo, pm.id, "reopened after the race check"));
    t.ok("hole: the owner's reopen (with its logged reason) still works", (await periodOf(ENTITY, lastMonth)).status === "open");

    // ========================================== two year closes at the same time
    console.log("  -- two year closes at once");
    const y2 = y - 1, end2 = `${y2}-12-31`;
    await tx(rio.actor, async (c) => {
      await P.openMonth(c, rio, `${y2}-03`, "another old year");
      await post(c, rio, { date: `${y2}-03-03`, sourceType: "manual", sourceId: null, description: "older revenue", lines: [{ code: "1010", debit: 700n }, { code: "4010", credit: 700n }] });
    });
    const both = await Promise.allSettled([
      tx(rio.actor, (c) => P.closeYear(c, rio, end2, { override: true, reason: "first" })),
      tx(rio.actor, (c) => P.closeYear(c, rio, end2, { override: true, reason: "second" })),
    ]);
    const vals = both.map((x) => (x.status === "fulfilled" ? x.value : x.reason));
    const closedOnce = (await read<{ n: number }>(`select count(*)::int n from fiscal_year_close where entity_id = $1 and fy_end = $2 and status = 'closed'`, [RIO_ENTITY, end2]))[0].n;
    const okish = vals.every((v) => (v instanceof Error ? v instanceof P.PeriodError : true));
    t.ok("year close twice at once: one close, and the other gets the close or a sentence (never a server error)", closedOnce === 1 && okish
      && vals.filter((v) => !(v instanceof Error) && (v as { already: boolean }).already === false).length === 1,
      JSON.stringify(vals.map((v) => (v instanceof Error ? v.message : { already: (v as { already: boolean }).already }))));

    // ====================================================== connection backoff
    console.log("  -- a failing pull connection backs off");
    const conn = (await read<{ id: string; tenant_id: string; status: string }>(`select c.id, c.tenant_id, c.status from connection c join source_channel sc on sc.source_code = c.source_code and sc.channel = c.channel
      where sc.mode = 'pull' and c.schedule_cron is not null order by c.name limit 1`))[0];
    if (conn) {
      // the demo's pulls are skipped by the scheduler, so for this check the tenant is briefly an ordinary customer
      await tx(SYS, (c) => c.query(`update tenant set kind = 'customer' where id = $1`, [conn.tenant_id]));
      restore.push(() => tx(SYS, async (c) => { await c.query(`update tenant set kind = 'demo' where id = $1`, [conn.tenant_id]);
        await c.query(`update connection set status = $2, consecutive_failures = 0, last_error = null where id = $1`, [conn.id, conn.status]); }));
      await tx(SYS, (c) => c.query(`update connection set status = 'active', consecutive_failures = 0, last_attempt_at = null where id = $1`, [conn.id]));
      let fails: number[] = [];
      for (let i = 1; i <= 6; i++) {
        await runDueConnections(new Date(Date.now() + i * 86_400_000));
        fails.push((await read<{ n: number }>(`select consecutive_failures n from connection where id = $1`, [conn.id]))[0].n);
      }
      const st = (await read<{ status: string; last_attempt_at: string | null; last_error: string | null }>(`select status, last_attempt_at, last_error from connection where id = $1`, [conn.id]))[0];
      t.ok("backoff: each failure is kept although the pull's own transaction rolled back", fails.slice(0, 5).join() === "1,2,3,4,5" && !!st.last_attempt_at && !!st.last_error, fails.join());
      t.ok("backoff: after five failures the connection stops being tried", st.status === "failed" && fails[5] === 5);
      const notDue = await runDueConnections(new Date(Date.now() + 9 * 86_400_000));
      t.ok("backoff: a failed connection is no longer due", !notDue.runs.some((r) => r.name && fails.length && (r as { note: string }).note.includes("transport")));
      await restore.pop()!();
    } else t.ok("backoff: (no pull connection in the demo to check with)", true);

    // ====================================================== the demo stays home
    console.log("  -- the demo never calls outside on a schedule");
    // the module checks before this one schedule demo feeds and turn EDI on for their own runs: seed 0036, as a demo reset runs it, puts it back
    await tx(SYS, async (c) => { await c.query(readFileSync(new URL("../../db/seed/0036_demo_offline.sql", import.meta.url), "utf8")); });
    const sched = await read<{ n: number }>(`select count(*)::int n from vendor_feed f join entity e on e.id = f.entity_id join tenant t on t.id = e.tenant_id
      where t.kind = 'demo' and (f.every_hours is not null or f.schedule_cron is not null)`);
    const edi = await read<{ n: number }>(`select count(*)::int n from edi_partner p join entity e on e.id = p.entity_id join tenant t on t.id = e.tenant_id where t.kind = 'demo' and (p.edi_enabled or p.transport <> 'manual')`);
    const pulls = await read<{ n: number }>(`select count(*)::int n from connection c join tenant t on t.id = c.tenant_id join source_channel sc on sc.source_code = c.source_code and sc.channel = c.channel
      where t.kind = 'demo' and sc.mode = 'pull' and c.status = 'active'`);
    t.ok("demo: its vendor feeds run on demand only, its EDI is off and its pulls are paused (seed 0036 / migration 0059)", sched[0].n === 0 && edi[0].n === 0 && pulls[0].n === 0,
      `${sched[0].n} scheduled feeds, ${edi[0].n} EDI on, ${pulls[0].n} active pulls`);
    // even if someone puts a schedule back, the scheduler skips the demo -- and never calls out
    const feed = (await read<{ id: string; every_hours: number | null }>(`select f.id, f.every_hours from vendor_feed f where f.entity_id = $1 and f.kind = 'api' and f.purpose <> 'orders' and f.active limit 1`, [ENTITY]))[0];
    if (feed) {
      await tx(SYS, (c) => c.query(`update vendor_feed set every_hours = 1, last_run_at = null where id = $1 and entity_id = $2`, [feed.id, ENTITY]));
      restore.push(() => tx(SYS, (c) => c.query(`update vendor_feed set every_hours = null where id = $1 and entity_id = $2`, [feed.id, ENTITY])));
      let called = 0;
      const env = { fetch: async () => { called++; throw new Error("no outside calls in checks"); }, secret: () => "", sleep: async () => {} } as never;
      const r = await runDueVendorFeeds(new Date(), env);
      t.ok("demo: the scheduler skips a demo feed even with a schedule, saying so", called === 0 && r.runs.some((x) => x.entityId === ENTITY && x.note === "demo: skipped"), JSON.stringify(r.runs.slice(0, 3)));
      await restore.pop()!();
    } else t.ok("demo: (no demo API feed to check with)", true);
    const part = (await read<{ id: string }>(`select p.id from edi_partner p where p.entity_id = $1 and p.our_isa_id <> '' and p.their_isa_id <> '' limit 1`, [ENTITY]))[0];
    if (part) {
      await tx(SYS, (c) => c.query(`update edi_partner set edi_enabled = true, transport = 'dropfolder' where id = $1 and entity_id = $2`, [part.id, ENTITY]));
      restore.push(() => tx(SYS, (c) => c.query(`update edi_partner set edi_enabled = false, transport = 'manual' where id = $1 and entity_id = $2`, [part.id, ENTITY])));
      const r = await runDueEdi(new Date());
      t.ok("demo: the scheduler skips the demo's EDI partners, saying so", r.some((x) => x.entityId === ENTITY && x.note === "demo: skipped") && !r.some((x) => x.entityId === ENTITY && x.note !== "demo: skipped"));
      await restore.pop()!();
    } else t.ok("demo: (no demo EDI partner to check with)", true);
    if (conn) {
      await tx(SYS, (c) => c.query(`update connection set status = 'active', last_attempt_at = null where id = $1`, [conn.id]));
      restore.push(() => tx(SYS, (c) => c.query(`update connection set status = 'paused' where id = $1`, [conn.id])));
      const r = await runDueConnections(new Date());
      const after = (await read<{ n: number }>(`select consecutive_failures n from connection where id = $1`, [conn.id]))[0].n;
      t.ok("demo: the scheduler skips the demo's pull connections, saying so", r.runs.some((x) => x.note === "demo: skipped") && after === 0);
      await restore.pop()!();
    }

    // ============================================================ the job log
    console.log("  -- the job log keeps 90 days; Run now queues");
    const oldRun = (await read<{ id: string }>(`insert into job_run (job, trigger, started_at, finished_at, status, summary) values ('periods','manual', now() - interval '100 days', now() - interval '100 days', 'ok', 'old') returning id`))[0].id;
    await read(`insert into job_run_item (run_id, entity_id, ok, note) values ($1, $2, true, 'old')`, [oldRun, ENTITY]);
    const recent = (await read<{ id: string }>(`insert into job_run (job, trigger, started_at, finished_at, status, summary) values ('periods','manual', now() - interval '80 days', now() - interval '80 days', 'ok', 'recent') returning id`))[0].id;
    await runDue({ trigger: "manual", only: ["outbox"] });
    const left = await read<{ id: string }>(`select id from job_run where id = any($1::uuid[])`, [[oldRun, recent]]);
    t.ok("retention: a run over 90 days old goes, with its items; one inside 90 days stays", left.length === 1 && left[0].id === recent
      && (await read(`select 1 from job_run_item where run_id = $1`, [oldRun])).length === 0);
    const t0 = Date.now();
    const qd = queueJob(jobById("periods")!, "checks");
    t.ok("run now: it is queued and answers at once", qd.queued && Date.now() - t0 < 200);
    let got: { status: string } | undefined;
    for (let i = 0; i < 40 && !got; i++) {
      await sleep(250);
      got = (await read<{ status: string }>(`select status from job_run where job = 'periods' and trigger = 'manual' and runner = 'checks' and started_at >= $1::timestamptz and status <> 'running' limit 1`, [qd.since]))[0];
    }
    t.ok("run now: the run shows up in the job log for the console to pick up", got?.status === "ok", JSON.stringify(got));

    // ============================================================ last UTC dates
    console.log("  -- the last UTC dates");
    const veh = (await read<{ id: string }>(`select id from vehicle where entity_id = $1 limit 1`, [ENTITY]))[0];
    if (veh) {
      const f = await tx(SYS, async (c) => (await q<{ d: string; t: string }>(c, `insert into fuel_log (entity_id, vehicle_id, gallons, cost_minor) values ($1,$2,1,100)
        returning filled_on::text d, business_today(entity_id)::text t`, [ENTITY, veh.id]))[0]);
      t.ok("defaults: a fuel log with no day takes the company's business date", f.d === f.t, `${f.d} vs ${f.t}`);
    }
    const defs = await read<{ name: string; d: string }>(`select v name, pg_get_viewdef(v::regclass, true) d from unnest(array['ap_aging','sweep_status','connection_health','statement_gaps']) v`);
    t.ok("views: ap_aging, sweep_status, connection_health and statement_gaps count from the business date", defs.length === 4 && defs.every((x) => !/CURRENT_DATE/.test(x.d) && /business_today/.test(x.d)),
      defs.filter((x) => /CURRENT_DATE/.test(x.d)).map((x) => x.name).join(","));
    const leftDefaults = await read<{ n: number }>(`select count(*)::int n from information_schema.columns where table_schema = current_schema() and column_default ilike '%current_date%'`);
    t.ok("defaults: no column defaults to the database's UTC day any more", leftDefaults[0].n === 0, String(leftDefaults[0].n));

    // ================================================================ errors
    console.log("  -- error log redaction and the fatal-error shutdown");
    const red = redact("called (555) 555-0101 and +1 555 555 0199 and 5555550123; smtp://mailer:s3cretPw@mail.example:587 api_key=abc123 for 22222222-2222-2222-2222-222222222222 on 2026-11-11");
    t.ok("redaction: phone numbers, URL passwords and api_key values are taken out; ids and dates stay", !/555-0101|0199|5555550123|s3cretPw|abc123/.test(red)
      && red.includes("22222222-2222-2222-2222-222222222222") && red.includes("2026-11-11") && /\[phone\]/.test(red), red);
    resetProcessHandlersForTests();
    const before = process.listeners("uncaughtException").slice(), beforeRej = process.listeners("unhandledRejection").slice();
    const order: string[] = [];
    let exited = 0;
    onFatal(async () => { order.push("server closed"); });
    installProcessHandlers(() => { order.push("exit"); exited++; }, 300);
    (process.emit as (e: string, err: Error) => boolean)("uncaughtException", new Error("checks: a fatal error"));
    await sleep(400);
    t.ok("fatal error: the server is closed first, then the process exits (once)", order.join() === "server closed,exit" && exited === 1, order.join());
    for (const l of process.listeners("uncaughtException")) if (!before.includes(l)) process.removeListener("uncaughtException", l);
    resetProcessHandlersForTests();
    const order2: string[] = [];
    onFatal(() => new Promise(() => { order2.push("closing, never finishes"); }));
    installProcessHandlers(() => { order2.push("exit"); }, 200);
    (process.emit as (e: string, err: Error) => boolean)("uncaughtException", new Error("checks: a fatal error, stuck close"));
    await sleep(350);
    t.ok("fatal error: a close that hangs still exits when the grace runs out", order2.join() === "closing, never finishes,exit", order2.join());
    for (const l of process.listeners("uncaughtException")) if (!before.includes(l)) process.removeListener("uncaughtException", l);
    for (const l of process.listeners("unhandledRejection")) if (!beforeRej.includes(l)) process.removeListener("unhandledRejection", l);
    resetProcessHandlersForTests();
    onFatal(async () => {});
  } finally {
    for (const f of restore.reverse()) await f().catch(() => {});
    c0.release();
  }
}
