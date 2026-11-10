// Connection, transactions, and the entity-scoping guard.
//
// The guard is the point. A screen that forgets to filter should return
// nothing, not another company's payables -- so every query either names
// entity_id or says out loud that it is deliberately unscoped.

import pg from "pg";

// bigint columns come back as strings by default; keep them exact.
pg.types.setTypeParser(20, (v) => v); // int8 -> string, caller converts to BigInt
pg.types.setTypeParser(1700, (v) => v); // numeric -> string

export type Actor = {
  kind: "user" | "agent" | "system";
  id?: string;
  label: string;
};

export type Scope = {
  tenantId: string;
  entityId: string;
  actor: Actor;
};

// Inside a host's private network the database needs no TLS; reached from
// outside it does. PGSSLMODE=require (or DATABASE_SSL=require) turns it on.
const ssl =
  process.env.PGSSLMODE === "require" || process.env.DATABASE_SSL === "require"
    ? { rejectUnauthorized: false }
    : undefined;

// ERP_DB_SCHEMA lets the ERP live in its own schema inside a database it
// shares with another app (Nov 2026: APPS-db, beside ServeTrack). Every
// connection then sees only that schema first, and nothing here names a
// schema, so the two apps' tables never meet.
export const SCHEMA = (process.env.ERP_DB_SCHEMA ?? "").trim();
if (SCHEMA && !/^[a-z_][a-z0-9_]{0,40}$/.test(SCHEMA)) throw new Error("ERP_DB_SCHEMA must be a plain lower-case name");
const schemaOpt = SCHEMA ? { options: `-c search_path=${SCHEMA},public` } : {};

export const pool = new pg.Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl, max: Number(process.env.PG_POOL_MAX ?? 5), ...schemaOpt }
    : { ssl, ...schemaOpt } // falls back to PGHOST / PGUSER / PGDATABASE
);

export type Client = pg.PoolClient;

/**
 * Run inside a transaction with the actor recorded for the duration, so
 * triggers and audit rows know who did this. An agent sets actor.kind to
 * 'agent' and gets no extra powers -- it goes through the same calls.
 */
export async function tx<T>(actor: Actor, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let committed = false;
  try {
    await c.query("begin");
    await c.query("select set_config('erp.actor_kind', $1, true)", [actor.kind]);
    await c.query("select set_config('erp.actor_label', $1, true)", [actor.label]);
    await c.query("select set_config('erp.actor_id', $1, true)", [actor.id ?? ""]);
    const out = await fn(c);
    await c.query("commit");
    committed = true;
    return out;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    const jobs = AFTER.get(c) ?? [];
    AFTER.delete(c);
    c.release();
    // Work that must wait for the commit (sending a queued email): started, never awaited, so the
    // caller's answer does not wait on the network. A rollback drops it with the rows it would send.
    if (committed) for (const j of jobs) setImmediate(() => { j().catch(() => { /* the job keeps its own log */ }); });
  }
}

const AFTER = new WeakMap<Client, (() => Promise<void>)[]>();
/** Run fn once the transaction on this client commits (in the background). Outside tx() it never runs; callers keep a sweeper (run-due). */
export function afterCommit(c: Client, fn: () => Promise<void>): void {
  const list = AFTER.get(c) ?? [];
  list.push(fn);
  AFTER.set(c, list);
}

const UNSCOPED = /\/\*\s*unscoped:[^*]*\*\//i;
const SCOPED = /entity_id\s*(=|in)\s*(\$\d|\()/i;

/**
 * Refuses a query that neither filters on entity_id nor declares why it
 * does not need to. Cheap, and it catches the mistake that matters.
 */
export function guard(sql: string): string {
  const s = sql.toLowerCase();
  const reads = /\bselect\b|\bupdate\b|\bdelete\b/.test(s);
  if (!reads) return sql;
  if (UNSCOPED.test(sql) || SCOPED.test(sql)) return sql;
  throw new Error(
    "query is not entity-scoped. Add `entity_id = $n`, or mark it " +
      "`/* unscoped: reason */` if it genuinely spans entities."
  );
}

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  c: Client,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await c.query<T>(guard(sql), params as never[]);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  c: Client,
  sql: string,
  params: unknown[] = []
): Promise<T> {
  const rows = await q<T>(c, sql, params);
  if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
  return rows[0];
}

/** Append-only audit. Triggers write some of these; code writes the rest. */
export async function audit(
  c: Client,
  scope: Scope,
  e: {
    table: string;
    rowId: string;
    action: "insert" | "update" | "delete" | "transition";
    before?: unknown;
    after?: unknown;
    reason?: string;
    sourceRef?: string;
  }
): Promise<void> {
  await c.query(
    `insert into audit_event
       (tenant_id, entity_id, actor_kind, actor_id, actor_label,
        table_name, row_id, action, before, after, reason, source_ref)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      scope.tenantId,
      scope.entityId,
      scope.actor.kind,
      scope.actor.id ?? null,
      scope.actor.label,
      e.table,
      e.rowId,
      e.action,
      e.before ? JSON.stringify(e.before) : null,
      e.after ? JSON.stringify(e.after) : null,
      e.reason ?? null,
      e.sourceRef ?? null,
    ]
  );
}
