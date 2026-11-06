// Shared check helpers for module smoke files (scripts/modules/<id>.ts).
// Each module file exports `run(t: T)`; scripts/smoke-modules.ts runs them all
// against a database prepared with ./db/apply.sh --reset --seed.

import { pool, tx, q, type Client } from "../../packages/core/db.ts";
import type { Company, Actor } from "../../server/modules/kit.ts";

export const TENANT = "11111111-1111-1111-1111-111111111111";
export const ENTITY = "22222222-2222-2222-2222-222222222222";
export const RIO_ENTITY = "eeee0000-0000-0000-0000-00000000000e";   // the other client: isolation tests
export const LOC = {
  ENOLA: "33333333-0000-0000-0000-000000000001",
  PALESTINE: "33333333-0000-0000-0000-000000000002",
  SOCORRO: "33333333-0000-0000-0000-000000000003",
};
export const PEOPLE = {
  STEVE: "55555555-0000-0000-0000-000000000001",       // owner
  CONTROLLER: "55555555-0000-0000-0000-000000000002",
  CLERK: "55555555-0000-0000-0000-000000000003",
  MANAGER: "55555555-0000-0000-0000-000000000004",
};

export type T = {
  ok: (name: string, cond: boolean, detail?: string) => void;
  throws: (name: string, fn: () => Promise<unknown>, match: RegExp) => Promise<void>;
  /** run fn in a transaction as this person, the way a coPost route does */
  as: <R>(personId: string, fn: (c: Client, co: Company, a: Actor) => Promise<R>) => Promise<R>;
  company: (entityId?: string) => Promise<Company>;
  q: typeof q;
  pool: typeof pool;
};

export function harness(): { t: T; counts: () => { passed: number; failed: number } } {
  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean, detail = "") => {
    if (cond) passed++; else failed++;
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const company = async (entityId = ENTITY): Promise<Company> => {
    const c = await pool.connect();
    try {
      const r = await q<Record<string, string>>(c, `
        select e.id, e.tenant_id, e.name, e.legal_name, t.name tenant_name, t.vertical,
               t.location_label, t.profit_object_label, t.aging_label
          from entity e join tenant t on t.id = e.tenant_id where e.id = $1`, [entityId]);
      const x = r[0];
      return { id: x.id, tenantId: x.tenant_id, name: x.name, legalName: x.legal_name, tenantName: x.tenant_name,
        vertical: x.vertical, locationLabel: x.location_label, profitObjectLabel: x.profit_object_label,
        agingLabel: x.aging_label } as unknown as Company;
    } finally { c.release(); }
  };
  const as: T["as"] = async (personId, fn) => {
    const c0 = await pool.connect();
    let name = "?";
    try { name = (await q<{ name: string }>(c0, "select name from app_user where id = $1 /* unscoped: lookup */", [personId]))[0]?.name ?? "?"; }
    finally { c0.release(); }
    const co = await company();
    const a: Actor = { personId, personName: name, label: name };
    return tx({ kind: "user", id: personId, label: name }, (c) => fn(c, co, a));
  };
  const throws: T["throws"] = async (name, fn, match) => {
    try { await fn(); ok(name, false, "expected an error, got none"); }
    catch (e) { const m = (e as Error).message; ok(name, match.test(m), m.slice(0, 90)); }
  };
  return { t: { ok, throws, as, company, q, pool }, counts: () => ({ passed, failed }) };
}
