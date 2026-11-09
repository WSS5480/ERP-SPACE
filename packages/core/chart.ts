// The chart of accounts, kept by a person: add, rename, regroup, switch
// on or off per company, deactivate (never delete), and load or save it
// as CSV. The chart is the client's (tenant-wide); each company chooses
// which accounts it uses.
//
// The finance core's guarantees hold: an account with postings keeps its
// code and type (the database refuses the change too), inactive and header
// accounts take no postings, and every change is audited.

import { q, one, audit, type Client, type Scope } from "./db.ts";
import { parseCsv, csvCell } from "./catalog.ts";
import { PACKS } from "./setup.ts";

export class ChartError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new ChartError(msg); };

export const TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type AccountType = (typeof TYPES)[number];
export const normalFor = (t: string): "D" | "C" => (t === "asset" || t === "expense" ? "D" : "C");
const CODE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/;
const T = "/* unscoped: the chart is the client's, shared by its companies */";

type Acct = { id: string; code: string; name: string; account_type: string; normal_balance: string; is_postable: boolean; active: boolean;
  parent_id: string | null; description: string | null };

async function acct(c: Client, tenantId: string, id: string): Promise<Acct> {
  const a = (await q<Acct>(c, `select id, code, name, account_type, normal_balance, is_postable, active, parent_id, description
                                 from gl_account where id = $1 and tenant_id = $2 ${T}`, [id, tenantId]))[0];
  need(a, "no such account in this chart");
  return a;
}
const byCode = async (c: Client, tenantId: string, code: string) =>
  (await q<Acct>(c, `select id, code, name, account_type, normal_balance, is_postable, active, parent_id, description
                       from gl_account where tenant_id = $1 and code = $2 ${T}`, [tenantId, code]))[0] ?? null;

const hasPostings = async (c: Client, id: string) =>
  (await q(c, `select 1 from journal_line where gl_account_id = $1 limit 1 /* unscoped: any company's postings keep the code */`, [id])).length > 0;

/** Codes the ERP posts to by code (setup packs): renaming the code or switching it off would break those postings. */
export function packUses(code: string): string[] {
  return PACKS.filter((p) => p.accounts.some((a) => a[0] === code)).map((p) => p.name);
}

/** Everything that points at an account, in words: why it cannot be switched off yet. */
export async function pointersTo(c: Client, s: Scope, id: string): Promise<string[]> {
  const a = await acct(c, s.tenantId, id);
  const out: string[] = [];
  const bal = await q<{ name: string; bal: string }>(c, `
    select e.name, sum(jl.debit_minor - jl.credit_minor)::text bal from journal_line jl join journal_entry je on je.id = jl.journal_entry_id
      join entity e on e.id = je.entity_id where jl.gl_account_id = $1 and e.tenant_id = $2 group by e.name having sum(jl.debit_minor - jl.credit_minor) <> 0
      /* unscoped: balances in every company of this client */`, [id, s.tenantId]);
  for (const b of bal) out.push(`it still has a balance of $${(Number(b.bal) / 100).toFixed(2)} in ${b.name}`);
  const vend = await q<{ name: string }>(c, `select coalesce(v.dba, v.legal_name) as name from vendor_entity ve join vendor v on v.id = ve.vendor_id
     where ve.default_gl_account_id = $1 and v.tenant_id = $2 ${T}`, [id, s.tenantId]);
  if (vend.length) out.push(`vendor${vend.length > 1 ? "s" : ""} ${vend.slice(0, 4).map((v) => v.name).join(", ")}${vend.length > 4 ? ` and ${vend.length - 4} more` : ""} code${vend.length > 1 ? "" : "s"} bills to it`);
  const tpl = await q<{ name: string }>(c, `select coalesce(v.dba, v.legal_name) as name from vendor_template t join vendor_entity ve on ve.id = t.vendor_entity_id
     join vendor v on v.id = ve.vendor_id where t.gl_account_id = $1 and t.status <> 'paused' and v.tenant_id = $2 ${T}`, [id, s.tenantId]);
  if (tpl.length) out.push(`the bill rule${tpl.length > 1 ? "s" : ""} for ${tpl.map((t) => t.name).join(", ")} code${tpl.length > 1 ? "" : "s"} to it`);
  const banks = await q<{ name: string }>(c, `select b.name from bank_account b join entity e on e.id = b.entity_id
     where (b.gl_account_id = $1 or b.fee_gl_account_id = $1) and e.tenant_id = $2 and b.status <> 'closed' ${T}`, [id, s.tenantId]);
  if (banks.length) out.push(`bank account${banks.length > 1 ? "s" : ""} ${banks.map((b) => b.name).join(", ")} book${banks.length > 1 ? "" : "s"} to it`);
  const ded = await q<{ name: string }>(c, `select name from deduction_type where gl_account_id = $1 and tenant_id = $2 ${T}`, [id, s.tenantId]);
  if (ded.length) out.push(`payroll deduction${ded.length > 1 ? "s" : ""} ${ded.map((d) => d.name).join(", ")} post${ded.length > 1 ? "" : "s"} to it`);
  const cats = await q<{ label: string }>(c, `select label from vendor_category where default_gl_account_id = $1 and tenant_id = $2 and active ${T}`, [id, s.tenantId]);
  if (cats.length) out.push(`the ${cats.map((x) => x.label).join(", ")} vendor categor${cats.length > 1 ? "ies use" : "y uses"} it as the usual account`);
  const kids = await q<{ code: string }>(c, `select code from gl_account where parent_id = $1 and tenant_id = $2 and active ${T}`, [id, s.tenantId]);
  if (kids.length) out.push(`active account${kids.length > 1 ? "s" : ""} ${kids.map((k) => k.code).join(", ")} roll${kids.length > 1 ? "" : "s"} up into it`);
  const packs = packUses(a.code);
  if (packs.length) {
    // The retail modules post to these codes directly; a company using the account relies on them.
    const using = await q(c, `select 1 from entity_gl_account x join entity e on e.id = x.entity_id where x.gl_account_id = $1 and x.active and e.tenant_id = $2 limit 1 ${T}`,
      [id, s.tenantId]);
    if (using.length) out.push(`the ERP posts to ${a.code} by its code (${packs.join(", ")} setup)`);
  }
  return out;
}

// ------------------------------------------------------------ reading --

export async function listChart(c: Client, s: Scope) {
  const rows = await q(c, `
    select g.id, g.code, g.name, g.account_type, g.normal_balance, g.is_postable, g.active, g.parent_id, p.code parent_code, g.description,
           coalesce(ega.active, false) used_here,
           (select count(*) from entity_gl_account x join entity e on e.id = x.entity_id where x.gl_account_id = g.id and x.active and e.tenant_id = g.tenant_id) companies,
           exists (select 1 from journal_line jl where jl.gl_account_id = g.id) posted,
           coalesce((select sum(jl.debit_minor - jl.credit_minor) from journal_line jl join journal_entry je on je.id = jl.journal_entry_id
                      where jl.gl_account_id = g.id and je.entity_id = $2), 0)::text balance_minor
      from gl_account g left join gl_account p on p.id = g.parent_id
      left join entity_gl_account ega on ega.gl_account_id = g.id and ega.entity_id = $2
     where g.tenant_id = $1 order by g.code ${T}`, [s.tenantId, s.entityId]);
  const companies = await q(c, `select id, name from entity where tenant_id = $1 order by name ${T}`, [s.tenantId]);
  return { accounts: rows.map((r) => ({ ...r, packs: packUses(String(r.code)) })), companies, types: TYPES };
}

export async function accountDetail(c: Client, s: Scope, id: string) {
  const a = await acct(c, s.tenantId, id);
  const companies = await q(c, `select e.id, e.name, coalesce(x.active, false) uses,
      coalesce((select sum(jl.debit_minor - jl.credit_minor) from journal_line jl join journal_entry je on je.id = jl.journal_entry_id
                 where jl.gl_account_id = $1 and je.entity_id = e.id), 0)::text balance_minor
      from entity e left join entity_gl_account x on x.entity_id = e.id and x.gl_account_id = $1 where e.tenant_id = $2 order by e.name ${T}`, [id, s.tenantId]);
  const history = await q(c, `select at, actor_label, action, before, after, reason from audit_event
                               where entity_id = $1 and table_name = 'gl_account' and row_id = $2 order by at desc limit 20`, [s.entityId, id]);
  return { account: a, posted: await hasPostings(c, id), packs: packUses(a.code), companies, pointers: a.active ? await pointersTo(c, s, id) : [], history };
}

// ----------------------------------------------------------- changing --

export type AccountIn = { code?: string; name?: string; type?: string; normalBalance?: string | null; parent?: string | null;
  postable?: boolean; description?: string | null; active?: boolean; companies?: string[] | null };

async function parentId(c: Client, tenantId: string, parent: string | null | undefined): Promise<string | null | undefined> {
  if (parent === undefined) return undefined;
  if (parent === null || parent === "") return null;
  const p = /^[0-9a-f-]{36}$/i.test(parent) ? (await acct(c, tenantId, parent).catch(() => null)) : await byCode(c, tenantId, parent);
  need(p, `there is no account ${parent} to roll up into`);
  need(!p!.is_postable, `${p!.code} ${p!.name} takes postings, so it cannot be a rollup parent; make it a header first (or pick a header)`);
  return p!.id;
}

async function companyIds(c: Client, tenantId: string, list: string[]): Promise<string[]> {
  const all = await q<{ id: string; name: string }>(c, `select id, name from entity where tenant_id = $1 ${T}`, [tenantId]);
  return list.map((x) => {
    const e = all.find((y) => y.id === x || y.name.toLowerCase() === x.trim().toLowerCase());
    need(e, `there is no company called ${x}`);
    return e!.id;
  });
}

export async function createAccount(c: Client, s: Scope, x: AccountIn): Promise<string> {
  const code = String(x.code ?? "").trim();
  need(CODE.test(code), "an account code is letters, digits, dots or dashes, up to 20, like 6415");
  need(!(await byCode(c, s.tenantId, code)), `account ${code} already exists`);
  const name = String(x.name ?? "").trim();
  need(name && name.length <= 120, "an account needs a name");
  need((TYPES as readonly string[]).includes(String(x.type)), `the type is one of ${TYPES.join(", ")}`);
  const nb = x.normalBalance ? String(x.normalBalance).toUpperCase() : normalFor(String(x.type));
  need(nb === "D" || nb === "C", "the normal balance is debit (D) or credit (C)");
  const pid = (await parentId(c, s.tenantId, x.parent)) ?? null;
  if (pid) need((await acct(c, s.tenantId, pid)).account_type === x.type, "a parent account has the same type as the accounts under it");
  const r = await one<{ id: string }>(c, `insert into gl_account (tenant_id, code, name, account_type, normal_balance, is_postable, parent_id, description, active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [s.tenantId, code, name, x.type, nb, x.postable ?? true, pid, x.description?.trim() || null, x.active ?? true]);
  const cos = x.companies && x.companies.length ? await companyIds(c, s.tenantId, x.companies) : [s.entityId];
  for (const e of cos) await c.query(`insert into entity_gl_account (entity_id, gl_account_id, active) values ($1,$2,true)
                                      on conflict (entity_id, gl_account_id) do update set active = true`, [e, r.id]);
  await audit(c, s, { table: "gl_account", rowId: r.id, action: "insert", after: { code, name, type: x.type, normalBalance: nb, parent: x.parent ?? null,
    postable: x.postable ?? true, active: x.active ?? true, companies: cos.length } });
  return r.id;
}

/** Name, description, parent, header or postable, active; code, type and normal balance only while it has no postings. */
export async function updateAccount(c: Client, s: Scope, id: string, x: AccountIn, reason?: string | null): Promise<string[]> {
  const a = await acct(c, s.tenantId, id);
  const posted = await hasPostings(c, id);
  const set: Record<string, unknown> = {};
  if (x.code !== undefined && x.code.trim() !== a.code) {
    const code = x.code.trim();
    need(CODE.test(code), "an account code is letters, digits, dots or dashes, up to 20, like 6415");
    need(!posted, `account ${a.code} has postings, so its code stays; make a new account and move future postings to it`);
    const packs = packUses(a.code);
    need(!packs.length, `the ERP posts to ${a.code} by its code (${packs.join(", ")} setup); add a new account instead`);
    need(!(await byCode(c, s.tenantId, code)), `account ${code} already exists`);
    set.code = code;
  }
  if (x.type !== undefined && x.type !== a.account_type) {
    need((TYPES as readonly string[]).includes(x.type), `the type is one of ${TYPES.join(", ")}`);
    need(!posted, `account ${a.code} has postings, so its type stays ${a.account_type}; make a new account and move future postings to it`);
    const kids = await q(c, `select 1 from gl_account where parent_id = $1 and tenant_id = $2 ${T}`, [id, s.tenantId]);
    need(!kids.length, `accounts roll up into ${a.code}; change their type first, or make a new header`);
    set.account_type = x.type;
    if (!x.normalBalance) set.normal_balance = normalFor(x.type);
  }
  if (x.normalBalance && x.normalBalance.toUpperCase() !== a.normal_balance) {
    need(["D", "C"].includes(x.normalBalance.toUpperCase()), "the normal balance is debit (D) or credit (C)");
    need(!posted, `account ${a.code} has postings, so its normal balance stays as it is`);
    set.normal_balance = x.normalBalance.toUpperCase();
  }
  if (x.name !== undefined && x.name.trim() !== a.name) { need(x.name.trim() && x.name.length <= 120, "an account needs a name"); set.name = x.name.trim(); }
  if (x.description !== undefined && (x.description?.trim() || null) !== a.description) set.description = x.description?.trim() || null;
  const pid = await parentId(c, s.tenantId, x.parent);
  if (pid !== undefined && pid !== a.parent_id) set.parent_id = pid;
  if (x.postable !== undefined && x.postable !== a.is_postable) {
    if (!x.postable) need(!posted, `account ${a.code} has postings, so it stays postable; add a header above it instead`);
    else need(!(await q(c, `select 1 from gl_account where parent_id = $1 and tenant_id = $2 ${T}`, [id, s.tenantId])).length,
      `accounts roll up into ${a.code}, so it stays a header`);
    set.is_postable = x.postable;
  }
  if (x.active !== undefined && x.active !== a.active) {
    if (!x.active) {
      const why = await pointersTo(c, s, id);
      need(!why.length, `${a.code} ${a.name} cannot be switched off yet: ${why.join("; ")}`);
    }
    set.active = x.active;
  }
  const keys = Object.keys(set);
  if (keys.length) {
    await c.query(`update gl_account set ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")} where id = $1 and tenant_id = $2`,
      [id, s.tenantId, ...keys.map((k) => set[k])]);
    const before: Record<string, unknown> = {};
    for (const k of keys) before[k] = (a as Record<string, unknown>)[k === "account_type" ? "account_type" : k];
    await audit(c, s, { table: "gl_account", rowId: id, action: keys.includes("active") ? "transition" : "update", before, after: set, reason: reason ?? undefined });
  }
  if (x.companies) await setCompanies(c, s, id, await companyIds(c, s.tenantId, x.companies));
  return keys;
}

/** Which companies use the account. Switching one off is refused while that company carries a balance on it. */
export async function setCompanies(c: Client, s: Scope, id: string, entityIds: string[]): Promise<{ on: number; off: number }> {
  const a = await acct(c, s.tenantId, id);
  const all = await q<{ id: string; name: string; uses: boolean; bal: string }>(c, `
    select e.id, e.name, coalesce(x.active, false) uses,
           coalesce((select sum(jl.debit_minor - jl.credit_minor) from journal_line jl join journal_entry je on je.id = jl.journal_entry_id
                      where jl.gl_account_id = $1 and je.entity_id = e.id), 0)::text bal
      from entity e left join entity_gl_account x on x.entity_id = e.id and x.gl_account_id = $1 where e.tenant_id = $2 ${T}`, [id, s.tenantId]);
  for (const x of entityIds) need(all.some((e) => e.id === x), "that company is not one of this client's");
  let on = 0, off = 0;
  for (const e of all) {
    const want = entityIds.includes(e.id);
    if (want === e.uses) continue;
    if (!want) need(Number(e.bal) === 0, `${e.name} still carries a balance on ${a.code}; it stays on there until that is zero`);
    await c.query(`insert into entity_gl_account (entity_id, gl_account_id, active) values ($1,$2,$3)
                   on conflict (entity_id, gl_account_id) do update set active = excluded.active`, [e.id, id, want]);
    if (want) on++; else off++;
  }
  if (on || off) await audit(c, s, { table: "gl_account", rowId: id, action: "update", after: { companies: { on, off, now: entityIds.length } } });
  return { on, off };
}

// ------------------------------------------------------------- CSV --

export const CSV_COLUMNS = ["code", "name", "type", "normal_balance", "parent", "postable", "active", "description", "companies"];

export async function exportCsv(c: Client, s: Scope): Promise<{ filename: string; csv: string }> {
  const rows = await q<{ code: string; name: string; account_type: string; normal_balance: string; parent: string | null; is_postable: boolean;
    active: boolean; description: string | null; companies: string | null }>(c, `
    select g.code, g.name, g.account_type, g.normal_balance, p.code parent, g.is_postable, g.active, g.description,
           (select string_agg(e.name, '; ' order by e.name) from entity_gl_account x join entity e on e.id = x.entity_id
             where x.gl_account_id = g.id and x.active and e.tenant_id = g.tenant_id) companies
      from gl_account g left join gl_account p on p.id = g.parent_id where g.tenant_id = $1 order by g.code ${T}`, [s.tenantId]);
  const yn = (b: boolean) => (b ? "yes" : "no");
  const csv = [CSV_COLUMNS.join(","), ...rows.map((r) => [r.code, r.name, r.account_type, r.normal_balance, r.parent ?? "", yn(r.is_postable), yn(r.active),
    r.description ?? "", r.companies ?? ""].map(csvCell).join(","))].join("\r\n") + "\r\n";
  return { filename: `chart-of-accounts-${new Date().toISOString().slice(0, 10)}.csv`, csv };
}

const truthy = (v: string, dflt: boolean): boolean => {
  const t = v.trim().toLowerCase();
  if (!t) return dflt;
  if (["yes", "y", "true", "1", "x", "postable", "active"].includes(t)) return true;
  if (["no", "n", "false", "0", "header", "inactive"].includes(t)) return false;
  throw new ChartError(`${v} is not yes or no`);
};
const typeOf = (v: string): string => {
  const t = v.trim().toLowerCase();
  const map: Record<string, string> = { asset: "asset", assets: "asset", liability: "liability", liabilities: "liability", equity: "equity", capital: "equity",
    revenue: "revenue", income: "revenue", sales: "revenue", expense: "expense", expenses: "expense", cost: "expense", cogs: "expense" };
  need(map[t], `${v || "(blank)"} is not a type (asset, liability, equity, revenue, expense)`);
  return map[t];
};

type Planned = { row: number; code: string; action: "add" | "update" | "same" | "refuse"; fields: Record<string, unknown>; changes: Record<string, [unknown, unknown]>; message: string | null };

/** Read a chart CSV and say, row by row, what applying it would do. Nothing changes until it is applied. */
export async function previewCsv(c: Client, s: Scope, a: { csv: string; filename?: string | null }) {
  const g = parseCsv(a.csv ?? "");
  need(g.length >= 2, "the file has no rows under its heading line");
  need(g.length <= 5001, "5,000 accounts at most per file");
  const heads = g[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, "_").replace(/_+$/, ""));
  const col = (n: string, ...alts: string[]) => [n, ...alts].map((x) => heads.indexOf(x)).find((i) => i >= 0) ?? -1;
  const ix = { code: col("code", "account", "account_number", "number"), name: col("name", "account_name", "description_name"), type: col("type", "account_type"),
    nb: col("normal_balance", "normal"), parent: col("parent", "rollup", "parent_code", "group"), postable: col("postable", "is_postable"),
    active: col("active"), description: col("description", "notes"), companies: col("companies", "company", "entities") };
  need(ix.code >= 0, "the file needs a code column");
  const existing = new Map((await q<Acct & { parent_code: string | null; companies: string[] }>(c, `
    select g.id, g.code, g.name, g.account_type, g.normal_balance, g.is_postable, g.active, g.parent_id, g.description, p.code parent_code,
           coalesce((select array_agg(x.entity_id::text order by x.entity_id) from entity_gl_account x join entity e on e.id = x.entity_id
                      where x.gl_account_id = g.id and x.active and e.tenant_id = g.tenant_id), '{}') companies
      from gl_account g left join gl_account p on p.id = g.parent_id where g.tenant_id = $1 ${T}`, [s.tenantId])).map((x) => [x.code, x]));
  const posted = new Set((await q<{ id: string }>(c, `select distinct g.id from gl_account g join journal_line jl on jl.gl_account_id = g.id where g.tenant_id = $1 ${T}`,
    [s.tenantId])).map((x) => x.id));
  const companies = await q<{ id: string; name: string }>(c, `select id, name from entity where tenant_id = $1 ${T}`, [s.tenantId]);
  const inFile = new Map<string, { type: string; postable: boolean }>();
  const planned: Planned[] = [];
  // first pass: what each code in the file will be, so a parent defined further down still counts
  for (let r = 1; r < g.length; r++) {
    const code = (g[r][ix.code] ?? "").trim();
    if (!code) continue;
    const cur = existing.get(code);
    try {
      inFile.set(code, { type: ix.type >= 0 && g[r][ix.type]?.trim() ? typeOf(g[r][ix.type]) : cur?.account_type ?? "",
        postable: ix.postable >= 0 ? truthy(g[r][ix.postable] ?? "", cur?.is_postable ?? true) : cur?.is_postable ?? true });
    } catch { /* reported below */ }
  }
  // where each code will roll up once the file is in: the file's parent column wins over the books
  const parentAfter = new Map<string, string | null>([...existing].map(([k, v]) => [k, v.parent_code]));
  if (ix.parent >= 0) { const once = new Set<string>(); for (let r = 1; r < g.length; r++) {
    const code = (g[r][ix.code] ?? "").trim();
    if (code && !once.has(code)) { once.add(code); parentAfter.set(code, (g[r][ix.parent] ?? "").trim() || null); }
  } }
  const seen = new Set<string>();
  for (let r = 1; r < g.length; r++) {
    const cell = (i: number) => (i >= 0 ? String(g[r][i] ?? "").trim() : "");
    const code = cell(ix.code);
    const p: Planned = { row: r + 1, code, action: "refuse", fields: {}, changes: {}, message: null };
    try {
      need(code, "no code");
      need(CODE.test(code), `${code} is not an account code (letters, digits, dots or dashes)`);
      need(!seen.has(code), `${code} is already on an earlier row of this file`);
      seen.add(code);
      const cur = existing.get(code);
      const f: Record<string, unknown> = { code };
      if (cell(ix.name)) f.name = cell(ix.name).slice(0, 120);
      if (cell(ix.type)) f.type = typeOf(cell(ix.type));
      if (cell(ix.nb)) { const nb = cell(ix.nb).toUpperCase().slice(0, 1); need(nb === "D" || nb === "C", `normal balance ${cell(ix.nb)} is not D or C`); f.normalBalance = nb; }
      if (ix.parent >= 0) f.parent = cell(ix.parent) || null;
      if (cell(ix.postable)) f.postable = truthy(cell(ix.postable), true);
      if (cell(ix.active)) f.active = truthy(cell(ix.active), true);
      if (ix.description >= 0 && cell(ix.description)) f.description = cell(ix.description).slice(0, 500);
      if (cell(ix.companies)) {
        f.companies = cell(ix.companies).split(/[;|]/).map((x) => x.trim()).filter(Boolean).map((x) => {
          const e = companies.find((y) => y.id === x || y.name.toLowerCase() === x.toLowerCase());
          need(e, `there is no company called ${x}`);
          return e!.id;
        }).sort();
      }
      const type = (f.type as string) ?? cur?.account_type;
      if (f.parent) {
        const par = existing.get(f.parent as string), parF = inFile.get(f.parent as string);
        need(par || parF, `there is no account ${f.parent} to roll up into, here or in the file`);
        need(f.parent !== code, "an account cannot roll up into itself");
        { let up: string | null | undefined = f.parent as string; const walked = new Set<string>();
          while (up && !walked.has(up)) { need(up !== code, `${code} would end up rolling up into itself through ${f.parent}`); walked.add(up); up = parentAfter.get(up); } }
        const parPostable = parF ? parF.postable : par!.is_postable;
        need(!parPostable, `${f.parent} takes postings, so it cannot be a rollup parent; mark it postable = no`);
        need((parF?.type || par?.account_type) === type, `${f.parent} is ${parF?.type || par?.account_type}, not ${type}`);
      }
      if (!cur) {
        need(f.name, "a new account needs a name");
        need(f.type, "a new account needs a type");
        p.action = "add";
      } else {
        const ch: Record<string, [unknown, unknown]> = {};
        const cmp = (k: string, before: unknown, after: unknown) => { if (after !== undefined && String(before ?? "") !== String(after ?? "")) ch[k] = [before ?? null, after ?? null]; };
        cmp("name", cur.name, f.name); cmp("type", cur.account_type, f.type); cmp("normal_balance", cur.normal_balance, f.normalBalance);
        cmp("parent", cur.parent_code, f.parent); cmp("postable", cur.is_postable, f.postable); cmp("active", cur.active, f.active);
        cmp("description", cur.description, f.description);
        if (f.companies) cmp("companies", [...cur.companies].sort().join(","), (f.companies as string[]).join(","));
        const isPosted = posted.has(cur.id);
        if (ch.type) need(!isPosted, `${code} has postings, so its type stays ${cur.account_type}; make a new account and move future postings to it`);
        if (ch.normal_balance) need(!isPosted, `${code} has postings, so its normal balance stays ${cur.normal_balance}`);
        if (ch.postable && f.postable === false) need(!isPosted, `${code} has postings, so it stays postable`);
        if (ch.active && f.active === false) {
          const why = await pointersTo(c, s, cur.id);
          need(!why.length, `${code} cannot be switched off yet: ${why.join("; ")}`);
        }
        p.changes = ch;
        p.action = Object.keys(ch).length ? "update" : "same";
      }
      p.fields = f;
    } catch (e) {
      if (!(e instanceof ChartError)) throw e;
      p.action = "refuse"; p.message = e.message;
    }
    planned.push(p);
  }
  const counts = { add: 0, update: 0, same: 0, refuse: 0 };
  for (const p of planned) counts[p.action]++;
  const run = await one<{ id: string }>(c, `insert into chart_import_run (tenant_id, entity_id, filename, rows, added, updated, unchanged, refused, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [s.tenantId, s.entityId, a.filename?.slice(0, 200) || null, planned.length, counts.add, counts.update, counts.same, counts.refuse, s.actor.id || null]);
  for (const p of planned) {
    await c.query(`insert into chart_import_row (run_id, entity_id, row_no, code, action, fields, changes, message) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [run.id, s.entityId, p.row, p.code || null, p.action, JSON.stringify(p.fields), JSON.stringify(p.changes), p.message]);
  }
  return { runId: run.id, rows: planned.length, ...counts, sample: planned.filter((p) => p.action !== "same").slice(0, 200) };
}

/** Apply a previewed chart file: headers first, so parents exist before the accounts under them. */
export async function applyCsv(c: Client, s: Scope, runId: string) {
  const run = (await q<{ id: string; status: string }>(c, `select id, status from chart_import_run where id = $1 and entity_id = $2 for update`, [runId, s.entityId]))[0];
  need(run, "no such chart import");
  need(run.status === "previewed", `that import is already ${run.status}`);
  const rows = await q<{ row_no: number; code: string; action: string; fields: Record<string, unknown> }>(c,
    `select row_no, code, action, fields from chart_import_row where run_id = $1 and entity_id = $2 order by row_no`, [runId, s.entityId]);
  const counts = { added: 0, updated: 0, unchanged: 0, refused: 0 };
  const todo = rows.filter((r) => r.action === "add" || r.action === "update");
  counts.unchanged = rows.filter((r) => r.action === "same").length;
  counts.refused = rows.filter((r) => r.action === "refuse").length;
  // headers (postable = no) first, then the rest; adds before updates so parents named in the file exist
  todo.sort((a, b) => Number(a.fields.postable !== false) - Number(b.fields.postable !== false) || Number(a.action === "update") - Number(b.action === "update"));
  // then make sure a parent named in the file goes in before anything under it, whatever the file order
  const ordered: typeof todo = [];
  { const byCodeInFile = new Map(todo.map((r) => [r.code, r]));
    const placed = new Set<string>(), visiting = new Set<string>();
    const place = (r: (typeof todo)[number]) => {
      if (placed.has(r.code) || visiting.has(r.code)) return;
      visiting.add(r.code);
      const par = typeof r.fields.parent === "string" ? byCodeInFile.get(r.fields.parent) : undefined;
      if (par) place(par);
      visiting.delete(r.code); placed.add(r.code); ordered.push(r);
    };
    todo.forEach(place); }
  for (const r of ordered) {
    const f = r.fields as AccountIn & { code: string; normalBalance?: string };
    await c.query("savepoint chart_row");
    try {
      const cur = await byCode(c, s.tenantId, f.code);
      if (!cur) await createAccount(c, s, { ...f, parent: f.parent ?? null, companies: f.companies ?? null });
      else await updateAccount(c, s, cur.id, { ...f, code: undefined }, `chart import ${runId.slice(0, 8)}`);
      await c.query("release savepoint chart_row");
      if (cur) counts.updated++; else counts.added++;
    } catch (e) {
      await c.query("rollback to savepoint chart_row");
      if (!(e instanceof ChartError) && !((e as { code?: string }).code === "P0001" || (e as { code?: string }).code === "23514")) throw e;
      counts.refused++;
      await c.query(`update chart_import_row set action = 'refuse', message = $3 where run_id = $1 and entity_id = $2 and row_no = $4`,
        [runId, s.entityId, (e as Error).message.slice(0, 300), r.row_no]);
    }
  }
  await c.query(`update chart_import_run set status = 'applied', applied_at = now(), applied_by = $3, added = $4, updated = $5, unchanged = $6, refused = $7
                  where id = $1 and entity_id = $2`, [runId, s.entityId, s.actor.id || null, counts.added, counts.updated, counts.unchanged, counts.refused]);
  await audit(c, s, { table: "chart_import_run", rowId: runId, action: "transition", after: { status: "applied", ...counts } });
  return { runId, ...counts };
}
