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
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => { console.error(e.message); await pool.end(); process.exit(1); });
}
