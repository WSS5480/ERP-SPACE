// The scheduler: the jobs that used to wait for a cron service now run inside
// the web server, on an interval.
//
// One runner at a time across every instance: each tick takes a Postgres
// advisory lock (pg_try_advisory_lock) on its own connection, so a second
// instance (or scripts/run-due.ts at the same moment) finds it held and skips
// the tick instead of running the jobs twice. A job is due when its last run
// started at least its interval ago. Every run is a job_run row with its
// outcome (ok, partial, failed), what it did per company (job_run_item) and
// its error; a job that throws is also a server_error with a reference.
// Suspended customers are skipped: each job's query leaves them out.
//
//   ERP_SCHEDULER=off            the server does not run jobs (a cron service may)
//   ERP_SCHEDULER_TICK_SEC=60    how often the server looks for due jobs

import { hostname } from "node:os";
import { pool, tx, type Client } from "../packages/core/db.ts";
import { keepAhead } from "../packages/core/periods.ts";
import { drainQueued } from "../packages/core/messaging.ts";
import { runDueReports } from "../packages/core/reports.ts";
import { runDueConnections, runDueVendorFeeds, runDueCrm, runDueEdi, runDueHolds } from "../scripts/run-due.ts";
import { recordError, redact } from "./errors.ts";

export type JobItem = { tenantId?: string | null; entityId?: string | null; ok: boolean; note: string };
export type JobOutcome = { items: JobItem[]; summary: string };
export type JobDef = { id: string; label: string; everyMin: number; what: string; run: (now: Date) => Promise<JobOutcome> };

const plural = (n: number, w: string) => `${n} ${n === 1 ? w : w.endsWith("y") ? `${w.slice(0, -1)}ies` : `${w}s`}`;

/** The daily period job: every company of a customer that is not suspended keeps three months ahead open. */
export async function rollPeriods(_now: Date): Promise<JobOutcome> {
  const cos = (await pool.query<{ id: string; tenant_id: string; name: string }>(`
    select e.id, e.tenant_id, e.name from entity e join tenant t on t.id = e.tenant_id
     where e.status = 'active' and t.status = 'active' order by e.tenant_id, e.name /* unscoped: the scheduler walks every company */`)).rows;
  const items: JobItem[] = [];
  let opened = 0;
  for (const co of cos) {
    try {
      const months = await tx({ kind: "system", label: "scheduler" }, (c) => keepAhead(c, co.id, 3, "period job"));
      opened += months.length;
      items.push({ tenantId: co.tenant_id, entityId: co.id, ok: true, note: months.length ? `opened ${months.join(", ")}` : "three months ahead already open" });
    } catch (e) {
      items.push({ tenantId: co.tenant_id, entityId: co.id, ok: false, note: (e as Error).message });
    }
  }
  return { items, summary: `${plural(opened, "month")} opened across ${plural(cos.length, "company")}` };
}

export const JOBS: JobDef[] = [
  { id: "periods", label: "Accounting periods", everyMin: 24 * 60, what: "Keeps the next three months open for posting in every company.", run: rollPeriods },
  { id: "connections", label: "Bank and statement pulls", everyMin: 15, what: "Pulls statements from connections that fetch on a schedule.",
    run: async (now) => { const r = await runDueConnections(now); return { items: r.runs.map((x) => ({ tenantId: x.tenantId, entityId: x.entityId, ok: x.ok, note: `${x.name}: ${x.note}` })), summary: `${r.due} of ${r.of} connections were due` }; } },
  { id: "vendor_feeds", label: "Vendor feeds", everyMin: 15, what: "Runs vendor product, price, stock and freight feeds on their own schedules.",
    run: async (now) => { const r = await runDueVendorFeeds(now); return { items: r.runs.map((x) => ({ tenantId: x.tenantId, entityId: x.entityId, ok: x.ok, note: `${x.name}: ${x.note}` })), summary: `${r.due} of ${r.of} feeds were due` }; } },
  { id: "marketing", label: "Marketing and follow-ups", everyMin: 15, what: "Queues campaign messages whose time has come, turns left carts into leads, and adds follow-up tasks.",
    run: async (now) => { const r = await runDueCrm(now); return { items: r.filter((x) => x.note || x.sent || x.stopped || x.carts).map((x) => ({ tenantId: x.tenantId, entityId: x.entityId, ok: !x.note, note: `${x.sent} sent, ${x.stopped} held back, ${x.carts} carts to leads${x.note ? ` — ${x.note}` : ""}` })), summary: `${plural(r.length, "company")} checked` }; } },
  { id: "edi", label: "EDI", everyMin: 15, what: "Collects and sends files for trading partners on a drop folder or EDI service.",
    run: async (now) => { const r = await runDueEdi(now); return { items: r.map((x) => ({ tenantId: x.tenantId, entityId: x.entityId, ok: x.ok, note: `${x.vendor}: ${x.note}` })), summary: `${plural(r.length, "trading partner")}` }; } },
  { id: "quote_holds", label: "Quote stock holds", everyMin: 60, what: "Gives stock held for a quote back to the floor when the hold runs out.",
    run: async (now) => { const r = await runDueHolds(now); return { items: r.map((x) => ({ tenantId: x.tenantId, entityId: x.entityId, ok: !x.note, note: `${x.holds} holds ran out, ${x.released} lines back${x.note ? ` — ${x.note}` : ""}` })), summary: `${plural(r.length, "company")} with holds ending` }; } },
  { id: "reports", label: "Scheduled reports", everyMin: 60, what: "Runs reports people scheduled and prepares their emails.",
    run: async () => { const r = await runDueReports(pool, tx); return { items: r.runs.map((x) => ({ tenantId: x.tenantId, entityId: x.entityId, ok: x.ok, note: `${x.name}: ${x.note}` })), summary: `${r.due} reports were due` }; } },
  { id: "outbox", label: "Outbox sweep", everyMin: 15, what: "Sends email and texts a restart left queued (the server also drains it every minute).",
    run: async () => { const r = await drainQueued({ limit: 1000, olderThanSec: 60 }); return { items: [], summary: `${r.sent} sent, ${r.failed} failed` }; } },
];
export const jobById = (id: string) => JOBS.find((j) => j.id === id) ?? null;

const LOCK = 7_406_312;   // "erp scheduler" (migrations use 7_406_311)
const RUNNER = `${hostname()}:${process.pid}`;

export type RunReport = { id: string; job: string; status: string; summary: string | null; error: string | null };

/** Run one job now and record it (the caller holds the lock, or it is a hand-run from the console). */
export async function runJob(job: JobDef, now = new Date(), trigger: "interval" | "manual" | "cron" = "manual", runner = RUNNER): Promise<RunReport> {
  const id = (await pool.query<{ id: string }>(`insert into job_run (job, trigger, runner, started_at) values ($1,$2,$3,$4) returning id /* unscoped: the install's job log */`,
    [job.id, trigger, runner, now])).rows[0].id;
  let status = "ok", summary: string | null = null, error: string | null = null, items: JobItem[] = [];
  try {
    const r = await job.run(now);
    items = r.items; summary = r.summary.slice(0, 500);
    const bad = items.filter((x) => !x.ok).length;
    status = bad === 0 ? "ok" : bad === items.length ? "failed" : "partial";
    if (bad) error = redact(items.filter((x) => !x.ok).slice(0, 3).map((x) => x.note).join("; ")).slice(0, 1000);
  } catch (e) {
    status = "failed";
    const ref = await recordError(e, { kind: "job", path: `job ${job.id}` });
    error = `${redact((e as Error).message ?? String(e)).slice(0, 900)} (ref ${ref})`;
  }
  const c = await pool.connect();
  try {
    await c.query("begin");
    for (const it of items.slice(0, 2000)) {
      await c.query(`insert into job_run_item (run_id, tenant_id, entity_id, ok, note) values ($1,$2,$3,$4,$5)`,
        [id, it.tenantId ?? null, it.entityId ?? null, it.ok, redact(it.note).slice(0, 500)]);
    }
    await c.query(`update job_run set status = $2, finished_at = now(), summary = $3, error = $4, detail = $5 where id = $1 /* unscoped: the install's job log */`,
      [id, status, summary, error, JSON.stringify({ items: items.length, failed: items.filter((x) => !x.ok).length })]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    await pool.query(`update job_run set status = 'failed', finished_at = now(), error = $2 where id = $1 /* unscoped: the install's job log */`,
      [id, `the run's record could not be written: ${redact((e as Error).message).slice(0, 300)}`]).catch(() => {});
  } finally { c.release(); }
  return { id, job: job.id, status, summary, error };
}

/** Is the job due: has its interval passed since its last run started? */
async function dueJobs(c: Client, now: Date, only?: string[]): Promise<JobDef[]> {
  const last = new Map((await c.query<{ job: string; at: Date }>(`select job, max(started_at) at from job_run group by job /* unscoped: the install's job log */`)).rows.map((r) => [r.job, r.at]));
  return JOBS.filter((j) => (!only || only.includes(j.id)) && (!last.has(j.id) || now.getTime() - new Date(last.get(j.id)!).getTime() >= j.everyMin * 60_000 - 5_000));
}

/**
 * One tick: take the scheduler lock (or skip the tick: another runner has it),
 * then run every due job in turn. force runs them all whatever their last run.
 */
export async function runDue(opts: { now?: Date; trigger?: "interval" | "manual" | "cron"; only?: string[]; force?: boolean; runner?: string } = {}):
  Promise<{ skipped: "locked" | null; runs: RunReport[] }> {
  const now = opts.now ?? new Date();
  const c = await pool.connect();
  let locked = false;
  try {
    locked = (await c.query<{ ok: boolean }>(`select pg_try_advisory_lock($1) ok /* unscoped: the scheduler's lock */`, [LOCK])).rows[0].ok;
    if (!locked) return { skipped: "locked", runs: [] };
    // a run left 'running' by a process that died is closed off, so its job is not stuck
    await c.query(`update job_run set status = 'failed', finished_at = now(), error = 'the server stopped before this run finished'
                    where status = 'running' and started_at < now() - interval '2 hours' /* unscoped: the install's job log */`);
    // the job log keeps 90 days (a run every 15 minutes per job adds up)
    await c.query(`with old as (select id from job_run where started_at < now() - interval '90 days' and status <> 'running' limit 5000),
                        i as (delete from job_run_item where run_id in (select id from old))
                   delete from job_run where id in (select id from old) /* unscoped: the install's job log */`).catch(() => {});
    const jobs = opts.force ? JOBS.filter((j) => !opts.only || opts.only.includes(j.id)) : await dueJobs(c, now, opts.only);
    const runs: RunReport[] = [];
    for (const j of jobs) runs.push(await runJob(j, now, opts.trigger ?? "interval", opts.runner ?? RUNNER));
    return { skipped: null, runs };
  } finally {
    if (locked) await c.query(`select pg_advisory_unlock($1) /* unscoped: the scheduler's lock */`, [LOCK]).catch(() => {});
    c.release();
  }
}

const waiting = new Set<string>();
/**
 * Run a job now, without making the caller wait: it runs through the scheduler's lock in the background
 * (waiting for a tick in progress, up to five minutes), and the run shows in the job log like any other.
 * Returns when it was asked, so the caller can look for a manual run started after it.
 */
export function queueJob(job: JobDef, runner: string): { queued: true; already: boolean; since: string } {
  const since = new Date(Date.now() - 2000).toISOString();
  if (waiting.has(job.id)) return { queued: true, already: true, since };
  waiting.add(job.id);
  void (async () => {
    try {
      for (let i = 0; i < 20; i++) {
        const r = await runDue({ trigger: "manual", only: [job.id], force: true, runner });
        if (!r.skipped) return;
        await new Promise((res) => setTimeout(res, 15_000));
      }
    } catch (e) { await recordError(e, { kind: "job", path: `run now ${job.id}` }); }
    finally { waiting.delete(job.id); }
  })();
  return { queued: true, already: false, since };
}

/** Start the in-server ticker. Returns a stop function. */
export function startScheduler(log: (s: string) => void = console.log): () => void {
  if ((process.env.ERP_SCHEDULER ?? "").toLowerCase() === "off") { log("scheduler: off (ERP_SCHEDULER=off)"); return () => {}; }
  const sec = Math.max(15, Number(process.env.ERP_SCHEDULER_TICK_SEC ?? 60) || 60);
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    runDue({ trigger: "interval" })
      .then((r) => { for (const x of r.runs) if (x.status !== "ok") log(`scheduler: ${x.job} ${x.status}${x.error ? ` — ${x.error}` : ""}`); })
      .catch((e) => { void recordError(e, { kind: "job", path: "scheduler tick" }); })
      .finally(() => { busy = false; });
  };
  const first = setTimeout(tick, 10_000);   // let the server finish starting
  const every = setInterval(tick, sec * 1000);
  first.unref(); every.unref();
  log(`scheduler: every ${sec}s, one runner at a time (advisory lock ${LOCK})`);
  return () => { clearTimeout(first); clearInterval(every); };
}

// ------------------------------------------------------------------ reads --

/** The jobs with their last run and next run. With an entity: the status is what the last run did for that company. */
export async function jobsView(c: Client, entityId: string | null) {
  const last = (await c.query<{ job: string; id: string; started_at: string; finished_at: string | null; status: string; summary: string | null; error: string | null }>(`
    select distinct on (job) job, id, started_at, finished_at, status, summary, error from job_run
     order by job, started_at desc /* unscoped: the install's job log */`)).rows;
  const byJob = new Map(last.map((r) => [r.job, r]));
  const mine = entityId ? new Map((await c.query<{ run_id: string; ok: boolean; note: string }>(`
    select run_id, bool_and(ok) ok, string_agg(note, '; ' order by at) note from job_run_item
     where entity_id = $1 and run_id = any($2::uuid[]) group by run_id`, [entityId, last.map((r) => r.id)])).rows.map((r) => [r.run_id, r])) : null;
  return JOBS.map((j) => {
    const r = byJob.get(j.id);
    const nextAt = r ? new Date(new Date(r.started_at).getTime() + j.everyMin * 60_000).toISOString() : null;
    let status = r?.status ?? "never", error = r?.error ?? null, note: string | null = r?.summary ?? null;
    if (r && mine) {
      const m = mine.get(r.id);
      // a company sees what the run did for it, never another company's notes
      status = r.status === "running" ? "running" : m ? (m.ok ? "ok" : "failed") : r.status === "failed" && !r.summary ? "failed" : "ok";
      error = m && !m.ok ? m.note : status === "failed" ? "the run did not finish; the ERP team has been told" : null;
      note = m ? m.note : "nothing to do for this company";
    }
    return { id: j.id, label: j.label, what: j.what, everyMin: j.everyMin, lastRunId: r?.id ?? null, lastRunAt: r?.started_at ?? null,
      finishedAt: r?.finished_at ?? null, nextRunAt: nextAt, status, error, note };
  });
}

/** Recent runs of one job (or all). */
export async function runsView(c: Client, entityId: string | null, job: string | null, limit = 30) {
  const rows = (await c.query<{ id: string; job: string; trigger: string; started_at: string; finished_at: string | null; status: string; summary: string | null; error: string | null; runner: string }>(`
    select id, job, trigger, started_at, finished_at, status, summary, error, runner from job_run
     where ($1::text is null or job = $1) order by started_at desc limit $2 /* unscoped: the install's job log */`, [job, Math.min(200, limit)])).rows;
  if (!entityId) return rows;
  const items = new Map((await c.query<{ run_id: string; ok: boolean; note: string }>(`
    select run_id, bool_and(ok) ok, string_agg(note, '; ' order by at) note from job_run_item where entity_id = $1 and run_id = any($2::uuid[]) group by run_id`,
    [entityId, rows.map((r) => r.id)])).rows.map((r) => [r.run_id, r]));
  return rows.map((r) => {
    const m = items.get(r.id);
    return { id: r.id, job: r.job, trigger: r.trigger, started_at: r.started_at, finished_at: r.finished_at,
      status: r.status === "running" ? "running" : m ? (m.ok ? "ok" : "failed") : r.status === "failed" && !r.summary ? "failed" : "ok",
      summary: m ? m.note : "nothing to do for this company", error: m && !m.ok ? m.note : null };
  });
}

/** One run in detail: for a company, only its own items; for an operator, everything. */
export async function runDetail(c: Client, runId: string, entityId: string | null) {
  const r = (await c.query(`select id, job, trigger, runner, started_at, finished_at, status, summary, error, detail from job_run where id = $1 /* unscoped: the install's job log */`, [runId])).rows[0];
  if (!r) return null;
  const items = (await c.query(`
    select i.ok, i.note, i.at, e.name company, t.name tenant from job_run_item i
      left join entity e on e.id = i.entity_id left join tenant t on t.id = i.tenant_id
     where i.run_id = $1 and ($2::uuid is null or i.entity_id = $2) order by i.ok, i.at /* unscoped: one run's items, filtered to the company when one is named */`, [runId, entityId])).rows;
  const def = jobById(r.job);
  if (entityId) {
    const failed = items.some((x: { ok: boolean }) => !x.ok);
    return { id: r.id, job: r.job, label: def?.label ?? r.job, what: def?.what ?? "", started_at: r.started_at, finished_at: r.finished_at,
      status: r.status === "running" ? "running" : failed ? "failed" : items.length ? "ok" : r.status === "failed" && !r.summary ? "failed" : "ok",
      summary: items.length ? null : "nothing to do for this company", error: failed ? null : r.status === "failed" && !r.summary ? "the run did not finish; the ERP team has been told" : null,
      items: items.map((x: Record<string, unknown>) => ({ ok: x.ok, note: x.note, at: x.at })) };
  }
  return { ...r, label: def?.label ?? r.job, what: def?.what ?? "", items };
}
