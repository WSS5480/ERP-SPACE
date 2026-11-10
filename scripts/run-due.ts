// The scheduler: run every active pull connection whose own schedule has
// come round since it last tried.
//
// Render's cron fires this every fifteen minutes. Each connection keeps its
// own cron expression -- First Valley at 06:00 on weekdays, Pineywoods hourly
// -- and this decides which of them are due. One failing connection does not
// stop the others; each failure is recorded against its own connection, where
// the health view will show it.
//
// Paid plans only on Render. On the free trial, POST /api/connections/{id}/run
// does the same thing for one connection on demand.

import { pool, tx } from "../packages/core/db.ts";
import { ingest, loadConnection } from "../packages/core/connections.ts";
import "../packages/core/statements.ts";
import { runFeed, feedDue, liveEnv, type FeedEnv } from "../packages/core/vendor_feeds.ts";
import { processQueue, captureAbandonedCarts } from "../packages/core/crm.ts";
import { runDueReports } from "../packages/core/reports.ts";
import { pollPartner, liveEdiEnv, type EdiEnv } from "../packages/core/edi.ts";

/** Does a five-field cron expression match this minute (UTC)? */
export function cronMatches(expr: string, d: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const vals = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
  const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return parts.every((field, i) => field.split(",").some((part) => {
    const [base, stepS] = part.split("/");
    const step = stepS ? Number(stepS) : 1;
    let [lo, hi] = ranges[i];
    if (base !== "*") {
      const [a, b] = base.split("-").map(Number);
      lo = a; hi = b ?? (stepS ? ranges[i][1] : a);
    }
    const v = vals[i];
    return v >= lo && v <= hi && (v - lo) % step === 0;
  }));
}

/** Has a scheduled minute occurred after `since` and at or before `now`? */
export function isDue(expr: string, since: Date | null, now: Date): boolean {
  const start = since ? new Date(since.getTime() + 60_000) : new Date(now.getTime() - 24 * 3600_000);
  const t = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(),
                              start.getUTCHours(), start.getUTCMinutes()));
  // Look back at most a week; a feed that has been down longer is the health
  // view's problem, not a reason to loop.
  const floor = now.getTime() - 7 * 24 * 3600_000;
  if (t.getTime() < floor) t.setTime(floor);
  for (; t <= now; t.setTime(t.getTime() + 60_000)) {
    if (cronMatches(expr, t)) return true;
  }
  return false;
}

/**
 * Vendor feeds (products, prices, quantities, freight, photos,
 * acknowledgments) keep their own schedules: a cron, or every N hours. Each
 * due feed runs in its own transaction as the scheduler; a failure is
 * recorded on that feed and its run log, never thrown, and never stops the
 * vendor's other feeds.
 */
export async function runDueVendorFeeds(now: Date, env: FeedEnv = liveEnv(), only?: { entityId: string }) {
  const rows = await pool.query<{ id: string; name: string; entity_id: string; tenant_id: string; schedule_cron: string | null; every_hours: number | null; last_run_at: Date | null }>(
    `select f.id, f.name, f.entity_id, e.tenant_id, f.schedule_cron, f.every_hours, f.last_run_at
       from vendor_feed f join entity e on e.id = f.entity_id
      where f.active and f.kind = 'api' and f.purpose <> 'orders' and (f.schedule_cron is not null or f.every_hours is not null)
        and ($1::uuid is null or f.entity_id = $1)
      order by f.entity_id, f.vendor_id, array_position(array['products','pricing','images','quantities','freight','acknowledgments'], f.purpose)
      /* unscoped: the scheduler walks every company's feeds */`, [only?.entityId ?? null]);
  const out: { name: string; ok: boolean; note: string }[] = [];
  for (const row of rows.rows) {
    if (!feedDue(row, now, isDue)) continue;
    try {
      const r = await tx({ kind: "system", label: "scheduler" }, (cl) =>
        runFeed(cl, { tenantId: row.tenant_id, entityId: row.entity_id, actor: { kind: "system", label: "scheduler" } }, row.id, env, "schedule"));
      out.push({ name: row.name, ok: r.ok, note: r.note });
    } catch (e) {
      out.push({ name: row.name, ok: false, note: (e as Error).message });
    }
  }
  return { due: out.length, of: rows.rows.length, runs: out };
}
/**
 * Marketing, every 15 minutes: send queued and scheduled campaign messages
 * whose time has come (consent re-checked at send), and turn web carts left
 * for two hours into leads. Only companies with the CRM module on.
 */
export async function runDueCrm(now: Date) {
  const cos = await pool.query<{ id: string; tenant_id: string }>(
    `select e.id, e.tenant_id from entity e
      where e.status = 'active'
        and not exists (select 1 from entity_module m where m.entity_id = e.id and m.module = 'crm' and not m.enabled)
        and (exists (select 1 from entity_module m where m.entity_id = e.id and m.module = 'crm' and m.enabled)
             or not exists (select 1 from entity_module m where m.entity_id = e.id))
      /* unscoped: the scheduler walks every company */`);
  const out: { entityId: string; sent: number; stopped: number; carts: number; note?: string }[] = [];
  for (const co of cos.rows) {
    try {
      const r = await tx({ kind: "system", label: "scheduler" }, async (cl) => {
        const q = await processQueue(cl, co.id, undefined, now);
        const carts = await captureAbandonedCarts(cl, co.id);
        return { ...q, carts: typeof carts === "number" ? carts : Number((carts as { added?: number })?.added ?? 0) };
      });
      out.push({ entityId: co.id, ...r });
    } catch (e) {
      out.push({ entityId: co.id, sent: 0, stopped: 0, carts: 0, note: (e as Error).message });
    }
  }
  return out;
}

/**
 * EDI, every run: each trading partner with EDI on whose files travel by a
 * drop folder, a VAN or EDI service (or SFTP / AS2, which say plainly that
 * they are not built yet) is polled for new files, and its queued documents
 * (850s, 997s) are sent. Each partner runs in its own transaction; a failure
 * is recorded on that partner's status line. Order-status APIs (the
 * acknowledgments feeds, whose "shipped" rows become ship notices) keep
 * their own schedules in runDueVendorFeeds.
 */
export async function runDueEdi(_now: Date, env: EdiEnv = liveEdiEnv(), only?: { entityId: string }) {
  const rows = await pool.query<{ id: string; entity_id: string; tenant_id: string; vendor: string }>(
    `select p.id, p.entity_id, e.tenant_id, coalesce(v.dba, v.legal_name) vendor
       from edi_partner p join entity e on e.id = p.entity_id join vendor v on v.id = p.vendor_id
      where p.edi_enabled and p.transport <> 'manual' and e.status = 'active' and ($1::uuid is null or p.entity_id = $1)
        and not exists (select 1 from entity_module m where m.entity_id = p.entity_id and m.module = 'edi' and not m.enabled)
      order by p.entity_id, 4 /* unscoped: the scheduler walks every company's trading partners */`, [only?.entityId ?? null]);
  const out: { vendor: string; ok: boolean; note: string }[] = [];
  for (const r of rows.rows) {
    try {
      const res = await tx({ kind: "system", label: "scheduler" }, (cl) =>
        pollPartner(cl, { tenantId: r.tenant_id, entityId: r.entity_id, actor: { kind: "system", label: "scheduler" } }, env, r.id));
      out.push({ vendor: r.vendor, ok: res.ok, note: res.note });
    } catch (e) {
      out.push({ vendor: r.vendor, ok: false, note: (e as Error).message });
    }
  }
  return out;
}

/** The name the earlier scheduler used. */
export const runDueVendorConnections = runDueVendorFeeds;

async function main() {
  const now = new Date();
  const due = await pool.query<{ id: string; name: string; schedule_cron: string; last_attempt_at: Date | null }>(
    `select c.id, c.name, c.schedule_cron, c.last_attempt_at
       from connection c
       join source_channel sc on sc.source_code = c.source_code and sc.channel = c.channel
      where c.status = 'active' and sc.mode = 'pull' and c.schedule_cron is not null`
  );

  let ran = 0;
  for (const row of due.rows) {
    if (!isDue(row.schedule_cron, row.last_attempt_at, now)) continue;
    ran++;
    try {
      const c = await pool.connect();
      let conn;
      try { conn = await loadConnection(c, row.id); } finally { c.release(); }
      const r = await tx({ kind: "system", label: "scheduler" }, (cl) =>
        ingest(cl, { tenantId: conn.tenant_id, entityId: conn.entity_id!, actor: { kind: "system", label: "scheduler" } },
               conn.id, { trigger: "schedule" }));
      console.log(`${row.name}: ${r.fresh} new of ${r.seen}, ${r.failed} quarantined`);
    } catch (e) {
      console.log(`${row.name}: failed — ${(e as Error).message}`);
    }
  }
  console.log(`${ran} of ${due.rows.length} scheduled connections were due`);
  const vendors = await runDueVendorFeeds(now);
  for (const r of vendors.runs) console.log(`${r.name}: ${r.ok ? "ok" : "failed"} — ${r.note}`);
  console.log(`${vendors.due} of ${vendors.of} scheduled vendor feeds were due`);
  for (const r of await runDueCrm(now)) {
    if (r.note || r.sent || r.stopped || r.carts) console.log(`marketing ${r.entityId}: ${r.sent} sent, ${r.stopped} held back, ${r.carts} carts to leads${r.note ? ` — ${r.note}` : ""}`);
  }
  for (const r of await runDueEdi(now)) console.log(`EDI ${r.vendor}: ${r.ok ? "ok" : "failed"} — ${r.note}`);
  // Scheduled reports: each keeps a snapshot and prepares its email.
  const reports = await runDueReports(pool, tx);
  for (const r of reports.runs) console.log(`report ${r.name}: ${r.ok ? "ok" : "failed"} — ${r.note}`);
  console.log(`${reports.due} scheduled reports were due`);
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => { console.error(e.message); await pool.end(); process.exit(1); });
}
