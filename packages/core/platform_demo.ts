// The demo tenants: wipe and reload, and nothing else.
//
// "Nothing is deleted" is the rule for a customer's business data. The demo is
// the one documented exception: sample data a sales prospect can play with,
// put back the way db/seed made it. This file is the only code that deletes
// business rows, and it can only ever delete rows that belong to the demo:
//
//   1. It refuses unless every tenant it would touch is in DEMO_TENANTS and is
//      marked kind = 'demo' in the database.
//   2. It works out which rows are the demo's from the catalog (any table with
//      tenant_id or entity_id naming a demo tenant or company, and any row whose
//      foreign key leads to one of those), in one transaction.
//   3. Before deleting anything, it checks every foreign key into those rows:
//      a row outside the demo that points at one refuses the whole reset,
//      naming the table. A cascade can therefore never reach another tenant.
//   4. It deletes child rows before parents (the append-only guards are lifted
//      for the length of this transaction only), puts the guards back, then
//      runs every db/seed file again inside the same transaction.
//
// audit_event and platform_audit are never touched: what happened in the demo
// stays on record. Prospect logins (platform_login rows in the demo) are kept
// across a reset and put back with their roles.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, type Client } from "./db.ts";

export const DEMO_TENANTS = ["11111111-1111-1111-1111-111111111111", "dddd0000-0000-0000-0000-00000000000d"] as const;
/** Never deleted from by a reset: the audit trails and the migration ledger. */
const KEEP = new Set(["audit_event", "platform_audit", "schema_migration"]);
const LOCK = 7_406_377;

export class DemoResetError extends Error {}

const here = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(here, "..", "..", "db", "seed");

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

type Fk = { child: string; parent: string; cols: string[]; refs: string[]; nullable: boolean };

/** Seed files carry their own begin/commit; inside this transaction they must not. */
export function seedBody(text: string): string {
  return text.replace(/^\s*(begin|commit|start transaction|end)\s*;\s*$/gim, "");
}

export async function resetDemo(by: string, opts: { log?: (s: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const c = await pool.connect();
  const t0 = Date.now();
  try {
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock($1)", [LOCK]);
    await c.query("select set_config('erp.actor_kind', 'system', true), set_config('erp.actor_label', $1, true)", [`demo reset (${by})`]);

    // 1. Only the demo.
    const tenants = (await c.query<{ id: string; kind: string; name: string }>(
      `select id, kind, name from tenant where id = any($1::uuid[]) /* unscoped: the demo tenants */`, [DEMO_TENANTS])).rows;
    for (const t of tenants) {
      if (t.kind !== "demo") throw new DemoResetError(`${t.name} is not marked as the demo, so it cannot be reset`);
    }
    const tenantIds = tenants.map((t) => t.id);
    const entityIds = (await c.query<{ id: string }>(
      `select id from entity where tenant_id = any($1::uuid[]) /* unscoped: the demo companies */`, [tenantIds])).rows.map((r) => r.id);

    // Prospect and other demo logins survive: kept here, put back after the seeds.
    const keep = await snapshotLogins(c, tenantIds);

    // 2. Which rows are the demo's.
    const tables = (await c.query<{ name: string; cols: string[] }>(`
      select c.relname as name, array_agg(a.attname::text order by a.attnum) as cols
        from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where c.relkind in ('r','p') and c.relnamespace = current_schema()::regnamespace
       group by c.relname /* unscoped: the catalog */`)).rows;
    const colsOf = new Map(tables.map((t) => [t.name, new Set(t.cols)]));
    const fks = (await c.query<{ child: string; parent: string; cols: string[]; refs: string[]; nullable: boolean }>(`
      select k.conrelid::regclass::text as child, k.confrelid::regclass::text as parent,
             array(select a.attname::text from unnest(k.conkey) with ordinality u(n, i) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n order by u.i) as cols,
             array(select a.attname::text from unnest(k.confkey) with ordinality u(n, i) join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n order by u.i) as refs,
             not exists (select 1 from unnest(k.conkey) u(n) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n where a.attnotnull) as nullable
        from pg_constraint k
       where k.contype = 'f' and k.connamespace = current_schema()::regnamespace /* unscoped: the catalog */`)).rows
      .map((f) => ({ ...f, child: f.child.replace(/^.*\./, "").replace(/"/g, ""), parent: f.parent.replace(/^.*\./, "").replace(/"/g, "") })) as Fk[];

    const scoped = (t: string) => {
      const cs = colsOf.get(t)!;
      const parts: string[] = [];
      if (t === "tenant") parts.push(`${qi(t)}.id = any($1::uuid[])`);
      if (t === "entity") parts.push(`${qi(t)}.id = any($2::uuid[])`);
      if (cs.has("tenant_id")) parts.push(`${qi(t)}.tenant_id = any($1::uuid[])`);
      if (cs.has("entity_id")) parts.push(`${qi(t)}.entity_id = any($2::uuid[])`);
      const nulls = [cs.has("tenant_id") ? `${qi(t)}.tenant_id is null` : null, cs.has("entity_id") ? `${qi(t)}.entity_id is null` : null].filter(Boolean);
      return { match: parts.length ? `(${parts.join(" or ")})` : null, unscopedRow: t === "tenant" ? "false" : nulls.length ? `(${nulls.join(" and ")})` : "true" };
    };

    // Owned tables: scoped ones, then anything with a key into an owned table (fixpoint).
    const owned = new Set<string>();
    for (const t of colsOf.keys()) if (!KEEP.has(t) && scoped(t).match) owned.add(t);
    for (let changed = true; changed;) {
      changed = false;
      for (const f of fks) if (!KEEP.has(f.child) && owned.has(f.parent) && !owned.has(f.child)) { owned.add(f.child); changed = true; }
    }

    await c.query(`create temp table _demo_rows (t text not null, r tid not null) on commit drop`);
    await c.query(`create index on _demo_rows (t, r)`);
    const inSet = (t: string) => `${qi(t)}.ctid in (select r from _demo_rows where t = '${t.replace(/'/g, "''")}')`;
    const fkMatch = (f: Fk) => `(${f.cols.map((x) => `${qi(f.child)}.${qi(x)}`).join(", ")}) in (select ${f.refs.map((x) => `p.${qi(x)}`).join(", ")} from ${qi(f.parent)} p where p.ctid in (select r from _demo_rows where t = '${f.parent.replace(/'/g, "''")}'))`;
    const predOf = (t: string) => {
      const s = scoped(t);
      const via = fks.filter((f) => f.child === t && f.parent !== t && owned.has(f.parent)).map(fkMatch);
      const viaPart = via.length ? `(${s.unscopedRow} and (${via.join(" or ")}))` : null;
      return [s.match, viaPart].filter(Boolean).join(" or ") || "false";
    };
    const params = [tenantIds, entityIds];
    const materialise = async () => {
      await c.query(`truncate _demo_rows`);
      for (let pass = 0, added = 1; added && pass < 12; pass++) {
        added = 0;
        for (const t of owned) {
          const r = await c.query(`insert into _demo_rows (t, r) select '${t.replace(/'/g, "''")}', ${qi(t)}.ctid from ${qi(t)}
                                    where (${predOf(t)}) and not (${inSet(t)}) and cardinality($1::uuid[]) >= 0 and cardinality($2::uuid[]) >= 0 /* unscoped: demo rows by tenant or company */`, params);
          added += r.rowCount ?? 0;
        }
      }
    };
    await materialise();

    // Triggers that keep posted rows unchangeable are lifted for this transaction only.
    const withRows = (await c.query<{ t: string }>(`select distinct t from _demo_rows`)).rows.map((r) => r.t);
    const triggered = (await c.query<{ t: string }>(`
      select distinct c.relname as t from pg_trigger g join pg_class c on c.oid = g.tgrelid
       where not g.tgisinternal and c.relnamespace = current_schema()::regnamespace and c.relname = any($1) /* unscoped: the catalog */`, [withRows])).rows.map((r) => r.t);
    for (const t of triggered) await c.query(`alter table ${qi(t)} disable trigger user`);

    // 3. Nothing outside the demo may point at a demo row.
    for (const f of fks) {
      if (!withRows.includes(f.parent)) continue;
      const outside = KEEP.has(f.child) ? "true" : `not (${inSet(f.child)})`;
      const r = await c.query<{ n: string }>(`select count(*)::text n from ${qi(f.child)} where ${outside} and ${fkMatch(f)} /* unscoped: checking nothing outside the demo leans on it */`);
      if (Number(r.rows[0].n)) {
        throw new DemoResetError(`the reset stopped and changed nothing: ${r.rows[0].n} row(s) in ${f.child} outside the demo point at demo rows in ${f.parent}`);
      }
    }

    // Keys that point both ways inside the demo (an inter-company document and its invoices, a trade
    // account and its application) are cleared first, so the rows can go child first.
    const cyc = cycles(withRows, fks);
    for (const f of fks) {
      if (f.child === f.parent || !cyc.get(f.child) || cyc.get(f.child) !== cyc.get(f.parent)) continue;
      if (!f.nullable) throw new DemoResetError(`the reset cannot order ${f.child} and ${f.parent}`);
      await c.query(`update ${qi(f.child)} set ${f.cols.map((x) => `${qi(x)} = null`).join(", ")} where ${inSet(f.child)}`);
    }
    if (cyc.size) await materialise();

    // 4. Child rows first.
    const order = deleteOrder(withRows, fks, cyc);
    const deleted: Record<string, number> = {};
    for (const t of order) {
      const r = await c.query(`delete from ${qi(t)} where ${inSet(t)} /* unscoped: demo rows only, collected above */`);
      if (r.rowCount) deleted[t] = r.rowCount;
    }
    for (const t of triggered) await c.query(`alter table ${qi(t)} enable trigger user`);
    log(`demo reset: removed ${Object.values(deleted).reduce((a, b) => a + b, 0)} rows from ${Object.keys(deleted).length} tables`);

    // Reload.
    const files = readdirSync(SEED_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      try { await c.query(seedBody(readFileSync(join(SEED_DIR, f), "utf8"))); }
      catch (e) { throw new DemoResetError(`the reset stopped and changed nothing: seed ${f} did not load (${(e as Error).message})`); }
      // A seed's "on commit drop" temp tables would outlive it here, where nothing commits between seeds.
      const temps = (await c.query<{ n: string }>(`select relname as n from pg_class where relpersistence = 't' and relkind = 'r'
          and relnamespace = pg_my_temp_schema() and relname <> '_demo_rows' /* unscoped: the catalog */`)).rows;
      for (const t of temps) await c.query(`drop table pg_temp.${qi(t.n)}`);
    }
    // 5. The seeds may only have written demo rows. Every row this transaction wrote carries its xid;
    // one of them outside the demo stops the whole reset (no savepoints above, so there is one xid).
    const backIds = (await c.query<{ id: string }>(`select id from tenant where id = any($1::uuid[]) /* unscoped: the demo tenants */`, [DEMO_TENANTS])).rows.map((r) => r.id);
    const backEntities = (await c.query<{ id: string }>(`select id from entity where tenant_id = any($1::uuid[]) /* unscoped: the demo companies */`, [backIds])).rows.map((r) => r.id);
    for (const t of colsOf.keys()) {
      if (KEEP.has(t) || t === "platform_login" || t === "platform_api_token") continue;
      const s = scoped(t);
      if (!s.match) continue;
      const r = await c.query<{ n: string }>(`select count(*)::text n from ${qi(t)} where xmin::text = (txid_current() % 4294967296)::text
          and not ${s.match} and not ${s.unscopedRow} and cardinality($1::uuid[]) >= 0 and cardinality($2::uuid[]) >= 0 /* unscoped: rows this reset wrote outside the demo */`, [backIds, backEntities]);
      if (Number(r.rows[0].n)) throw new DemoResetError(`the reset stopped and changed nothing: the seed files wrote ${r.rows[0].n} row(s) in ${t} outside the demo`);
    }
    const back = (await c.query<{ id: string }>(`select id from tenant where id = any($1::uuid[]) /* unscoped: the demo tenants */`, [DEMO_TENANTS])).rows.map((r) => r.id);
    await c.query(`update tenant set kind = 'demo', plan = 'demo', status = 'active' where id = any($1::uuid[])`, [back]);
    const others = (await c.query(`select 1 from entity e join tenant t on t.id = e.tenant_id where t.kind <> 'demo' and e.tenant_id = any($1::uuid[]) /* unscoped: sanity */`, [back])).rowCount;
    if (others) throw new DemoResetError("the seed files made a company outside the demo; the reset changed nothing");
    const restored = await restoreLogins(c, keep);

    // A sample-activity run marked as done before is run again for the fresh demo.
    const sample = (await c.query(`delete from schema_migration where filename = 'sample/activity-v1' /* unscoped: install bookkeeping */`)).rowCount ?? 0;

    await c.query(`insert into platform_audit (actor, actor_kind, action, detail) values ($1, 'operator', 'demo.reset', $2)`,
      [by, JSON.stringify({ tenants: back, deleted, seeds: files.length, loginsKept: restored, ms: Date.now() - t0 })]);
    await c.query("commit");
    return { tenants: back, tablesCleared: Object.keys(deleted).length, rowsRemoved: Object.values(deleted).reduce((a, b) => a + b, 0),
      seeds: files.length, loginsKept: restored, reloadSample: sample > 0, ms: Date.now() - t0 };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Strongly connected tables (more than one) among those with rows to delete: table -> component number. */
function cycles(tables: string[], fks: Fk[]): Map<string, number> {
  const set = new Set(tables);
  const g = new Map<string, string[]>();
  for (const f of fks) if (f.child !== f.parent && set.has(f.child) && set.has(f.parent)) (g.get(f.child) ?? g.set(f.child, []).get(f.child)!).push(f.parent);
  let idx = 0, comp = 0;
  const I = new Map<string, number>(), L = new Map<string, number>(), on = new Set<string>(), st: string[] = [], out = new Map<string, number>();
  const visit = (v: string) => {
    I.set(v, idx); L.set(v, idx); idx++; st.push(v); on.add(v);
    for (const w of g.get(v) ?? []) {
      if (!I.has(w)) { visit(w); L.set(v, Math.min(L.get(v)!, L.get(w)!)); }
      else if (on.has(w)) L.set(v, Math.min(L.get(v)!, I.get(w)!));
    }
    if (L.get(v) === I.get(v)) {
      const members: string[] = [];
      let w: string;
      do { w = st.pop()!; on.delete(w); members.push(w); } while (w !== v);
      if (members.length > 1) { comp++; for (const m of members) out.set(m, comp); }
    }
  };
  for (const v of tables) if (!I.has(v)) visit(v);
  return out;
}

/** Children before parents; keys inside a cycle were cleared, so they do not count. */
function deleteOrder(tables: string[], fks: Fk[], cyc: Map<string, number>): string[] {
  const set = new Set(tables);
  const parentsOf = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]));
  for (const f of fks) {
    if (f.child === f.parent || !set.has(f.child) || !set.has(f.parent)) continue;
    if (cyc.get(f.child) && cyc.get(f.child) === cyc.get(f.parent)) continue;
    parentsOf.get(f.child)!.add(f.parent);
  }
  // A table can go once nothing left still points at it.
  const childrenLeft = new Map<string, number>(tables.map((t) => [t, 0]));
  for (const [, ps] of parentsOf) for (const p of ps) childrenLeft.set(p, childrenLeft.get(p)! + 1);
  const ready = tables.filter((t) => childrenLeft.get(t) === 0);
  const out: string[] = [];
  while (ready.length) {
    const t = ready.shift()!;
    out.push(t);
    for (const p of parentsOf.get(t)!) {
      childrenLeft.set(p, childrenLeft.get(p)! - 1);
      if (childrenLeft.get(p) === 0) ready.push(p);
    }
  }
  if (out.length !== tables.length) throw new DemoResetError("the reset could not put the demo's tables in order; nothing was changed");
  return out;
}

type Kept = { users: Record<string, unknown>[]; logins: Record<string, unknown>[]; grants: Record<string, unknown>[] };

async function snapshotLogins(c: Client, tenantIds: string[]): Promise<Kept> {
  const users = (await c.query(`select u.* from app_user u join platform_login l on l.app_user_id = u.id where l.tenant_id = any($1::uuid[]) /* unscoped: demo logins */`, [tenantIds])).rows;
  const logins = (await c.query(`select * from platform_login where tenant_id = any($1::uuid[]) /* unscoped: demo logins */`, [tenantIds])).rows;
  const grants = (await c.query(`select g.* from role_grant g join platform_login l on l.app_user_id = g.app_user_id where l.tenant_id = any($1::uuid[]) /* unscoped: demo logins */`, [tenantIds])).rows;
  return { users, logins, grants };
}

async function insertRow(c: Client, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await c.query(`insert into ${qi(table)} (${cols.map(qi).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) on conflict do nothing`,
    cols.map((k) => row[k]));
}

async function restoreLogins(c: Client, k: Kept): Promise<number> {
  let n = 0;
  for (const u of k.users) {
    const taken = await c.query(`select 1 from app_user where id = $1 or (tenant_id = $2 and lower(email) = lower($3)) /* unscoped: putting a login back */`, [u.id, u.tenant_id, u.email]);
    if (taken.rowCount) continue;
    await insertRow(c, "app_user", u);
  }
  for (const l of k.logins) {
    const user = await c.query(`select 1 from app_user where id = $1 and tenant_id = $2 /* unscoped: putting a login back */`, [l.app_user_id, l.tenant_id]);
    if (!user.rowCount) continue;
    const ent = l.last_entity_id ? (await c.query(`select 1 from entity where id = $1 /* unscoped: lookup */`, [l.last_entity_id])).rowCount : 0;
    await insertRow(c, "platform_login", { ...l, last_entity_id: ent ? l.last_entity_id : null, session_version: Number(l.session_version) + 1 });
    n++;
  }
  for (const g of k.grants) {
    const ok = await c.query(`select 1 from app_user where id = $1 /* unscoped: lookup */`, [g.app_user_id]);
    const ent = g.entity_id ? (await c.query(`select 1 from entity where id = $1 /* unscoped: lookup */`, [g.entity_id])).rowCount : 1;
    if (!ok.rowCount || !ent) continue;
    await insertRow(c, "role_grant", { ...g, granted_by: null });
  }
  return n;
}
