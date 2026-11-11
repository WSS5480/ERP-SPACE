// Reports: the creator and editor's rules. A report is a definition -- a
// dataset from the catalog, columns, filters, groups, totals, a chart -- that
// this file checks field by field against the catalog and turns into one
// SELECT over that dataset's fixed, company-scoped query. Nothing a person
// types ever becomes SQL: dataset and field ids must be in the catalog,
// operators and aggregates come from fixed lists, formula tokens are column
// ids, field ids and numbers only, and every value is a bound parameter.
//
// Every run sets a statement timeout and caps its rows. Saved reports are
// versioned, shared by role or with the whole company, pinned to Home, and
// scheduled; a scheduled run keeps a snapshot and prepares an email (there is
// no mail service yet, so the delivery stays "prepared").

import * as messaging from "./messaging.ts";
import { deflateRawSync, crc32 } from "node:zlib";
import { q, one, audit, type Client, type Scope } from "./db.ts";
import { DATASETS, DATASET, GROUP, type Dataset, type Field, type FieldType } from "./reports_datasets.ts";

export { DATASETS, DATASET };
export type { Dataset, Field, FieldType };

export class ReportError extends Error {}
function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new ReportError(message);
}

export const LIMITS = {
  pageMax: 200, pageDefault: 100, preview: 25, exportMax: 10000, snapshotMax: 2000, limitMax: 10000,
  timeoutMs: 10000, columnsMax: 30, filtersMax: 20, inMax: 100, groupsMax: 3, chartMax: 60, exprMax: 200,
};

// ------------------------------------------------------------ vocabulary

export const AGGS = {
  sum: "Sum", avg: "Average", min: "Lowest", max: "Highest", count: "Count", count_distinct: "Count distinct", count_true: "Count of yes",
} as const;
export type Agg = keyof typeof AGGS;
const AGGS_FOR: Record<FieldType, Agg[]> = {
  money: ["sum", "avg", "min", "max", "count", "count_distinct"],
  number: ["sum", "avg", "min", "max", "count", "count_distinct"],
  date: ["min", "max", "count", "count_distinct"],
  text: ["count", "count_distinct", "min", "max"],
  bool: ["count", "count_true"],
};

export const OPS = {
  eq: "is", ne: "is not", in: "is one of", not_in: "is not one of", contains: "contains", not_contains: "does not contain",
  starts: "starts with", gt: "more than", gte: "at least", lt: "less than", lte: "at most", between: "between",
  before: "before", after: "after", on_or_before: "on or before", on_or_after: "on or after", relative: "in",
  within_days: "in the last N days", older_than_days: "more than N days ago", is_true: "is yes", is_false: "is no",
  blank: "is blank", not_blank: "is not blank",
} as const;
export type Op = keyof typeof OPS;
const OPS_FOR: Record<FieldType, Op[]> = {
  text: ["eq", "ne", "in", "not_in", "contains", "not_contains", "starts", "blank", "not_blank"],
  money: ["eq", "ne", "gt", "gte", "lt", "lte", "between", "blank", "not_blank"],
  number: ["eq", "ne", "gt", "gte", "lt", "lte", "between", "blank", "not_blank"],
  date: ["relative", "eq", "before", "after", "on_or_before", "on_or_after", "between", "within_days", "older_than_days", "blank", "not_blank"],
  bool: ["is_true", "is_false", "blank", "not_blank"],
};

export const RELATIVE = {
  today: "Today", yesterday: "Yesterday", this_week: "This week", last_week: "Last week", this_month: "This month",
  last_month: "Last month", this_quarter: "This quarter", last_quarter: "Last quarter", ytd: "Year to date",
  this_year: "This year", last_year: "Last year", last_7: "Last 7 days", last_30: "Last 30 days", last_90: "Last 90 days",
  last_365: "Last 365 days",
} as const;
export type Relative = keyof typeof RELATIVE;

export const BUCKETS = { day: "Day", week: "Week", month: "Month", quarter: "Quarter", year: "Year" } as const;
export type Bucket = keyof typeof BUCKETS;

export type Calc =
  | { kind: "expr"; expr: string }
  | { kind: "pct_total"; of: string }
  | { kind: "margin"; revenue: string; cost: string };
export type Format = "money" | "number" | "percent";
export type Column = { id: string; field?: string; calc?: Calc; label?: string; agg?: Agg; format?: Format };
export type Filter = { field: string; op: Op; value?: unknown; value2?: unknown; ask?: boolean; label?: string };
export type Group = { field: string; bucket?: Bucket };
export type Sort = { by: string; dir: "asc" | "desc" };
export type Chart = { type: "bar" | "line"; col: string };
export type Definition = {
  dataset: string; columns: Column[]; filters: Filter[]; groupBy: Group[];
  subtotals: boolean; grandTotal: boolean; sort: Sort | null; limit: number | null; chart: Chart | null;
};

const ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------ roles

/** The roles a person holds in this company (their own grants, or client-wide ones). */
export async function rolesFor(c: Client, entityId: string, personId: string | null): Promise<Set<string>> {
  if (!personId) return new Set();
  const r = await q<{ role: string }>(c, `
    select distinct g.role from role_grant g join app_user u on u.id = g.app_user_id
      join entity e on e.id = $1
     where g.app_user_id = $2 and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = e.tenant_id))`, [entityId, personId]);
  const roles = new Set(r.map((x) => x.role));
  // Datasets across the client's companies: a controller (or owner) in every open one of them.
  if (roles.has("controller") || roles.has("owner")) {
    const short = await q(c, `
      select 1 from entity x join entity me on me.id = $1
       where x.tenant_id = me.tenant_id and x.status <> 'closed'
         and not exists (select 1 from role_grant g join app_user u on u.id = g.app_user_id
                          where g.app_user_id = $2 and g.role in ('controller','owner') and (g.entity_id = x.id or (g.entity_id is null and u.tenant_id = x.tenant_id)))
       limit 1 /* unscoped: every company of this company's client */`, [entityId, personId]);
    if (!short.length) roles.add(GROUP);
  }
  return roles;
}

const roleWords = (roles: string[]) => roles.map((r) => (r === GROUP ? "a controller in every company" : r.replace(/_/g, " "))).join(", ");

export function mayUse(ds: Dataset, roles: Set<string>): boolean {
  return roles.has("owner") || ds.roles.some((r) => roles.has(r));
}
export function requireDataset(ds: Dataset, roles: Set<string>) {
  need(mayUse(ds, roles), `the ${ds.label.toLowerCase()} report needs one of: ${roleWords(ds.roles)}`);
}

/** Datasets this person may use in this company, given the modules it has on. */
export function catalogFor(roles: Set<string>, modules: string[]) {
  return DATASETS.filter((d) => (!d.modules.length || d.modules.some((m) => modules.includes(m))) && mayUse(d, roles))
    .map((d) => ({ id: d.id, label: d.label, folder: d.folder, description: d.description, dateField: d.dateField,
      drillsToEntry: !!d.entryField,
      fields: d.fields.filter((f) => f.id !== d.entryField).map((f) => ({ id: f.id, label: f.label, type: f.type, agg: !!f.agg, hint: f.hint ?? null,
        aggs: AGGS_FOR[f.type], ops: OPS_FOR[f.type] })) }));
}

// ------------------------------------------------------------ the definition

const fieldOf = (ds: Dataset, id: unknown, what: string): Field => {
  const f = typeof id === "string" ? ds.fields.find((x) => x.id === id && x.id !== ds.entryField) : undefined;
  need(f, `${what}: there is no field "${String(id).slice(0, 40)}" in ${ds.label.toLowerCase()}`);
  return f;
};
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Check a definition against the catalog and return a clean copy. Anything
 * not on the lists is refused with a sentence; nothing unknown is carried.
 */
export function normalize(raw: unknown): Definition {
  need(raw && typeof raw === "object", "a report needs a definition");
  const r = raw as Record<string, unknown>;
  const ds = typeof r.dataset === "string" ? DATASET.get(r.dataset) : undefined;
  need(ds, "pick a dataset from the list");
  const grouped = Array.isArray(r.groupBy) && r.groupBy.length > 0;

  // group by
  const groupBy: Group[] = [];
  for (const g of Array.isArray(r.groupBy) ? r.groupBy : []) {
    need(groupBy.length < LIMITS.groupsMax, `group by at most ${LIMITS.groupsMax} levels`);
    const gg = g as Record<string, unknown>;
    const f = fieldOf(ds, gg.field, "group by");
    const out: Group = { field: f.id };
    if (gg.bucket != null && gg.bucket !== "") {
      need(f.type === "date", `${f.label} is not a date, so it has no day, week or month`);
      need(typeof gg.bucket === "string" && gg.bucket in BUCKETS, "group a date by day, week, month, quarter or year");
      out.bucket = gg.bucket as Bucket;
    }
    need(!groupBy.some((x) => x.field === out.field && x.bucket === out.bucket), `${f.label} is grouped twice`);
    groupBy.push(out);
  }

  // columns
  const cols = Array.isArray(r.columns) ? r.columns : [];
  need(cols.length || groupBy.length, "pick at least one column");
  need(cols.length <= LIMITS.columnsMax, `a report shows at most ${LIMITS.columnsMax} columns`);
  const columns: Column[] = [];
  const ids = new Set<string>();
  const alias = new Map<string, string>(); // a column dropped because its field is a group → that group
  for (const x of cols) {
    const cx = x as Record<string, unknown>;
    const id = typeof cx.id === "string" && ID_RE.test(cx.id) ? cx.id : `c${columns.length + 1}`;
    need(!ids.has(id) && !alias.has(id), `two columns share the id ${id}`);
    ids.add(id);
    const label = text(cx.label, 80) || undefined;
    if (cx.calc) {
      const k = cx.calc as Record<string, unknown>;
      const format: Format | undefined = typeof cx.format === "string" && ["money", "number", "percent"].includes(cx.format) ? cx.format as Format : undefined;
      if (k.kind === "expr") {
        const expr = text(k.expr, LIMITS.exprMax + 1);
        need(expr && expr.length <= LIMITS.exprMax, `a formula is at most ${LIMITS.exprMax} characters`);
        columns.push({ id, calc: { kind: "expr", expr }, label: label ?? "Formula", format: format ?? "number" });
      } else if (k.kind === "pct_total") {
        need(typeof k.of === "string" && ID_RE.test(k.of), "percent of total needs a column or field");
        columns.push({ id, calc: { kind: "pct_total", of: k.of }, label: label ?? "% of total", format: "percent" });
      } else if (k.kind === "margin") {
        need(typeof k.revenue === "string" && ID_RE.test(k.revenue) && typeof k.cost === "string" && ID_RE.test(k.cost), "margin % needs a sales and a cost column");
        columns.push({ id, calc: { kind: "margin", revenue: k.revenue, cost: k.cost }, label: label ?? "Margin %", format: "percent" });
      } else need(false, "a calculated column is a formula, a percent of total or a margin %");
      continue;
    }
    const f = fieldOf(ds, cx.field, "columns");
    { const gi = groupBy.findIndex((g) => g.field === f.id && !g.bucket);
      if (gi >= 0) { ids.delete(id); alias.set(id, `g${gi}`); continue; } } // a grouped field shows as its group already
    const col: Column = { id, field: f.id, label };
    if (grouped) {
      need(cx.agg == null || cx.agg === "" || (typeof cx.agg === "string" && Object.hasOwn(AGGS, cx.agg)), `${f.label} cannot be totalled that way`);
      const agg = (typeof cx.agg === "string" && Object.hasOwn(AGGS, cx.agg) ? cx.agg : f.agg ? "sum" : f.type === "bool" ? "count_true" : "count_distinct") as Agg;
      need(AGGS_FOR[f.type].includes(agg), `${f.label} cannot be totalled as "${AGGS[agg].toLowerCase()}"`);
      col.agg = agg;
    }
    columns.push(col);
  }
  // Calculated columns may refer only to plain columns (no formula of a formula) or numeric fields.
  const plain = new Map(columns.filter((c) => c.field).map((c) => [c.id, c]));
  const numericRef = (ref: string, what: string) => {
    const pc = plain.get(ref);
    if (pc) {
      const t = valueType(ds, pc);
      need(t === "money" || t === "number", `${what}: the ${labelOf(ds, pc)} column is not a number`);
      return;
    }
    const f = ds.fields.find((x) => x.id === ref);
    need(f && f.agg, `${what}: "${ref}" is not a number column or field in this report`);
  };
  for (const c of columns) {
    if (!c.calc) continue;
    if (c.calc.kind === "pct_total") {
      numericRef(c.calc.of, "percent of total");
      const pc = plain.get(c.calc.of);
      need(!pc || !pc.agg || ["sum", "count", "count_true", "count_distinct"].includes(pc.agg), "percent of total works on a summed or counted column");
    } else if (c.calc.kind === "margin") { numericRef(c.calc.revenue, "margin %"); numericRef(c.calc.cost, "margin %"); }
    else for (const ref of parseExpr(c.calc.expr).refs) numericRef(ref, "formula");
  }

  // filters
  const filters: Filter[] = [];
  for (const x of Array.isArray(r.filters) ? r.filters : []) {
    need(filters.length < LIMITS.filtersMax, `a report has at most ${LIMITS.filtersMax} filters`);
    filters.push(checkFilter(ds, x as Record<string, unknown>));
  }

  // sort, limit, totals, chart
  let sort: Sort | null = null;
  if (r.sort && typeof r.sort === "object") {
    const s = r.sort as Record<string, unknown>;
    let by = String(s.by ?? "");
    if (alias.has(by)) by = alias.get(by)!;
    need(ids.has(by) || /^g[0-2]$/.test(by) && Number(by[1]) < groupBy.length, "sort by one of the report's columns or groups");
    sort = { by, dir: s.dir === "desc" ? "desc" : "asc" };
  }
  let limit: number | null = null;
  if (r.limit != null && r.limit !== "") {
    const n = Number(r.limit);
    need(Number.isInteger(n) && n >= 1 && n <= LIMITS.limitMax, `a row limit is a whole number from 1 to ${LIMITS.limitMax}`);
    limit = n;
  }
  let chart: Chart | null = null;
  if (r.chart && typeof r.chart === "object") {
    const ch = r.chart as Record<string, unknown>;
    need(groupBy.length, "a chart needs the report grouped: its bars are the first group");
    need(ch.type === "bar" || ch.type === "line", "a chart is bars or a line");
    const col = columns.find((c) => c.id === ch.col);
    need(col && (col.calc || ["money", "number"].includes(valueType(ds, col))), "chart a number column");
    chart = { type: ch.type, col: col.id };
  }
  return { dataset: ds.id, columns, filters, groupBy, subtotals: !!r.subtotals && groupBy.length > 1,
    grandTotal: r.grandTotal !== false, sort, limit, chart };
}

function checkFilter(ds: Dataset, x: Record<string, unknown>): Filter {
  const f = fieldOf(ds, x.field, "filter");
  need(typeof x.op === "string" && OPS_FOR[f.type].includes(x.op as Op), `${f.label} cannot be filtered with "${String(x.op).slice(0, 20)}"`);
  const op = x.op as Op;
  const out: Filter = { field: f.id, op };
  if (x.ask) { out.ask = true; out.label = text(x.label, 60) || f.label; }
  const v = checkValue(f, op, x.value, x.value2, !!x.ask);
  if (v.value !== undefined) out.value = v.value;
  if (v.value2 !== undefined) out.value2 = v.value2;
  return out;
}

/** A filter's value(s), typed. A filter that asks at run time may be saved without one. */
function checkValue(f: Field, op: Op, value: unknown, value2: unknown, optional: boolean): { value?: unknown; value2?: unknown } {
  if (["blank", "not_blank", "is_true", "is_false"].includes(op)) return {};
  const missing = value == null || value === "" || (Array.isArray(value) && !value.length);
  if (missing) { need(optional, `${f.label}: give a value to filter on`); return {}; }
  const one = (v: unknown): unknown => {
    if (f.type === "date") {
      need(typeof v === "string" && DAY_RE.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")), `${f.label}: "${String(v).slice(0, 20)}" is not a date`);
      return v;
    }
    if (f.type === "money") {
      const s = String(v).replace(/[$,\s]/g, "");
      need(/^-?\d{1,13}(\.\d{1,2})?$/.test(s), `${f.label}: "${String(v).slice(0, 20)}" is not an amount`);
      return s;
    }
    if (f.type === "number") {
      const n = Number(v);
      need(typeof v !== "boolean" && Number.isFinite(n) && Math.abs(n) < 1e12, `${f.label}: "${String(v).slice(0, 20)}" is not a number`);
      return n;
    }
    need(typeof v === "string" || typeof v === "number", `${f.label}: give text to filter on`);
    const s = String(v).trim().slice(0, 200);
    need(s, `${f.label}: give a value to filter on`);
    return s;
  };
  if (op === "relative") {
    need(typeof value === "string" && value in RELATIVE, `${f.label}: pick a period like this month or last month`);
    return { value };
  }
  if (op === "within_days" || op === "older_than_days") {
    const n = Number(value);
    need(Number.isInteger(n) && n >= 0 && n <= 3650, `${f.label}: give a number of days from 0 to 3650`);
    return { value: n };
  }
  if (op === "in" || op === "not_in") {
    const list = Array.isArray(value) ? value : String(value).split(",");
    const vals = [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
    need(vals.length, `${f.label}: give at least one value`);
    need(vals.length <= LIMITS.inMax, `${f.label}: at most ${LIMITS.inMax} values`);
    return { value: vals.map(one) };
  }
  if (op === "between") {
    need(value2 != null && value2 !== "", `${f.label}: "between" needs two values`);
    return { value: one(value), value2: one(value2) };
  }
  return { value: one(value) };
}

/** What a column holds once the report has run. */
export function valueType(ds: Dataset, c: Column): FieldType | "percent" {
  if (c.calc) return c.format === "percent" ? "percent" : c.format === "money" ? "money" : "number";
  const f = ds.fields.find((x) => x.id === c.field)!;
  if (c.agg && ["count", "count_distinct", "count_true"].includes(c.agg)) return "number";
  return f.type;
}
function labelOf(ds: Dataset, c: Column): string {
  if (c.label) return c.label;
  const f = ds.fields.find((x) => x.id === c.field);
  if (!f) return c.id;
  if (!c.agg || c.agg === "sum") return f.label;
  if (c.agg === "count_true") return `${f.label} (count)`;
  return `${f.label} (${AGGS[c.agg].toLowerCase()})`;
}
const groupLabel = (ds: Dataset, g: Group) => {
  const f = ds.fields.find((x) => x.id === g.field)!;
  return g.bucket ? `${f.label} (${BUCKETS[g.bucket].toLowerCase()})` : f.label;
};

// ------------------------------------------------------------ formulas

type Tok = { t: "num" | "id" | "op"; v: string };
type Node = { k: "num"; v: string } | { k: "ref"; v: string } | { k: "neg"; a: Node } | { k: "bin"; op: string; a: Node; b: Node };

/** A formula: column ids, numeric field ids, numbers, + - * / and brackets. Nothing else parses. */
export function parseExpr(src: string): { node: Node; refs: Set<string> } {
  need(src.length <= LIMITS.exprMax, `a formula is at most ${LIMITS.exprMax} characters`);
  const toks: Tok[] = [];
  const re = /\s*(?:(\d{1,12}(?:\.\d{1,6})?)|([a-z][a-z0-9_]{0,23})|([-+*/()]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s+$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    need(m, `the formula cannot read "${src.slice(i, i + 12)}": use column names, numbers and + - * / ( )`);
    toks.push(m[1] ? { t: "num", v: m[1] } : m[2] ? { t: "id", v: m[2] } : { t: "op", v: m[3] });
    i = re.lastIndex;
  }
  need(toks.length && toks.length <= 60, "a formula needs something in it, and at most 60 pieces");
  let p = 0, depth = 0;
  const refs = new Set<string>();
  const peek = () => toks[p];
  const expr = (): Node => {
    let a = term();
    while (peek()?.t === "op" && (peek().v === "+" || peek().v === "-")) { const op = toks[p++].v; a = { k: "bin", op, a, b: term() }; }
    return a;
  };
  const term = (): Node => {
    let a = factor();
    while (peek()?.t === "op" && (peek().v === "*" || peek().v === "/")) { const op = toks[p++].v; a = { k: "bin", op, a, b: factor() }; }
    return a;
  };
  const factor = (): Node => {
    const tk = toks[p++];
    need(tk, "the formula ends too soon");
    if (tk.t === "num") return { k: "num", v: tk.v };
    if (tk.t === "id") { refs.add(tk.v); return { k: "ref", v: tk.v }; }
    if (tk.v === "-") return { k: "neg", a: factor() };
    if (tk.v === "(") {
      need(++depth <= 10, "the formula has too many brackets inside brackets");
      const n = expr();
      need(toks[p++]?.v === ")", "a bracket in the formula is not closed");
      depth--;
      return n;
    }
    need(false, `the formula has "${tk.v}" where a number or column belongs`);
    throw new Error("unreachable");
  };
  const node = expr();
  need(p === toks.length, `the formula has something extra at "${toks[p]?.v}"`);
  return { node, refs };
}

function exprSql(n: Node, ref: (id: string) => string): string {
  switch (n.k) {
    case "num": return `${n.v}::numeric`;          // matched by /\d+(\.\d+)?/ only
    case "ref": return `(${ref(n.v)})::numeric`;
    case "neg": return `(-${exprSql(n.a, ref)})`;
    case "bin": return n.op === "/"
      ? `(${exprSql(n.a, ref)} / nullif(${exprSql(n.b, ref)}, 0))`
      : `(${exprSql(n.a, ref)} ${n.op} ${exprSql(n.b, ref)})`;
  }
}

// ------------------------------------------------------------ dates

const addDays = (d: string, n: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/** A named period as [first day, last day], from today. Weeks start on Monday. */
export function relativeRange(key: Relative, today: string): [string, string] {
  const t = new Date(today + "T00:00:00Z");
  const y = t.getUTCFullYear(), m = t.getUTCMonth(), dow = (t.getUTCDay() + 6) % 7;
  const q0 = Math.floor(m / 3) * 3;
  switch (key) {
    case "today": return [today, today];
    case "yesterday": return [addDays(today, -1), addDays(today, -1)];
    case "this_week": return [addDays(today, -dow), addDays(today, 6 - dow)];
    case "last_week": return [addDays(today, -dow - 7), addDays(today, -dow - 1)];
    case "this_month": return [ymd(y, m, 1), ymd(y, m + 1, 0)];
    case "last_month": return [ymd(y, m - 1, 1), ymd(y, m, 0)];
    case "this_quarter": return [ymd(y, q0, 1), ymd(y, q0 + 3, 0)];
    case "last_quarter": return [ymd(y, q0 - 3, 1), ymd(y, q0, 0)];
    case "ytd": return [ymd(y, 0, 1), today];
    case "this_year": return [ymd(y, 0, 1), ymd(y, 11, 31)];
    case "last_year": return [ymd(y - 1, 0, 1), ymd(y - 1, 11, 31)];
    case "last_7": return [addDays(today, -6), today];
    case "last_30": return [addDays(today, -29), today];
    case "last_90": return [addDays(today, -89), today];
    case "last_365": return [addDays(today, -364), today];
  }
}
/** The last day of the date bucket that starts on `start`. */
export function bucketEnd(bucket: Bucket, start: string): string {
  const t = new Date(start + "T00:00:00Z");
  const y = t.getUTCFullYear(), m = t.getUTCMonth();
  if (bucket === "day") return start;
  if (bucket === "week") return addDays(start, 6);
  if (bucket === "month") return ymd(y, m + 1, 0);
  if (bucket === "quarter") return ymd(y, m + 3, 0);
  return ymd(y, 11, 31);
}

// ------------------------------------------------------------ SQL

const col = (id: string, alias = "d") => `${alias}."${id}"`;     // ids are checked against the catalog first

function filterSql(ds: Dataset, f: Filter, p: unknown[], today: string): string {
  const field = ds.fields.find((x) => x.id === f.field)!;
  const c = col(f.field);
  const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
  const like = (s: string) => s.replace(/[\\%_]/g, (m) => "\\" + m);
  const cast = field.type === "date" ? "::date" : field.type === "text" ? "" : "::numeric";
  const val = (v: unknown) => field.type === "money" ? add(String(Math.round(Number(v) * 100))) : add(v);
  switch (f.op) {
    case "blank": return field.type === "text" ? `(${c} is null or ${c} = '')` : `${c} is null`;
    case "not_blank": return field.type === "text" ? `(${c} is not null and ${c} <> '')` : `${c} is not null`;
    case "is_true": return `${c} is true`;
    case "is_false": return `${c} is false`;
    case "eq": return field.type === "text" ? `lower(${c}) = lower(${add(f.value)})` : `${c} = ${val(f.value)}${cast}`;
    case "ne": return field.type === "text" ? `(${c} is null or lower(${c}) <> lower(${add(f.value)}))` : `(${c} is null or ${c} <> ${val(f.value)}${cast})`;
    case "in": return `lower(${c}) = any(${add((f.value as string[]).map((s) => s.toLowerCase()))}::text[])`;
    case "not_in": return `(${c} is null or not (lower(${c}) = any(${add((f.value as string[]).map((s) => s.toLowerCase()))}::text[])))`;
    case "contains": return `${c} ilike ${add("%" + like(String(f.value)) + "%")}`;
    case "not_contains": return `(${c} is null or ${c} not ilike ${add("%" + like(String(f.value)) + "%")})`;
    case "starts": return `${c} ilike ${add(like(String(f.value)) + "%")}`;
    case "gt": case "after": return `${c} > ${val(f.value)}${cast}`;
    case "gte": case "on_or_after": return `${c} >= ${val(f.value)}${cast}`;
    case "lt": case "before": return `${c} < ${val(f.value)}${cast}`;
    case "lte": case "on_or_before": return `${c} <= ${val(f.value)}${cast}`;
    case "between": return `${c} between ${val(f.value)}${cast} and ${val(f.value2)}${cast}`;
    case "relative": { const [a, b] = relativeRange(f.value as Relative, today); return `${c} between ${add(a)}::date and ${add(b)}::date`; }
    case "within_days": return `${c} between ${add(addDays(today, -Number(f.value)))}::date and ${add(today)}::date`;
    case "older_than_days": return `${c} < ${add(addDays(today, -Number(f.value)))}::date`;
  }
}

function aggSql(c: Column, alias = "d"): string {
  const x = col(c.field!, alias);
  switch (c.agg) {
    case "sum": return `sum(${x})`;
    case "avg": return `avg(${x})`;
    case "min": return `min(${x})`;
    case "max": return `max(${x})`;
    case "count": return `count(${x})`;
    case "count_distinct": return `count(distinct ${x})`;
    case "count_true": return `count(*) filter (where ${x})`;
    default: return x;
  }
}

/** Value SQL for every column, in detail or grouped form. */
function columnSqls(ds: Dataset, def: Definition, grouped: boolean): { id: string; sql: string; raw: string; type: FieldType | "percent" }[] {
  const plain = new Map(def.columns.filter((c) => c.field).map((c) => [c.id, c]));
  const asAgg = (c: Column): Column => grouped ? c : { ...c, agg: undefined };
  // A field named in a formula (not a column) is summed when the report is grouped.
  const ref = (id: string, alias = "d"): string => {
    const pc = plain.get(id);
    if (pc) return grouped ? aggSql(pc, alias) : col(pc.field!, alias);
    return grouped ? `sum(${col(id, alias)})` : col(id, alias);
  };
  const total = (id: string): string => {
    const pc = plain.get(id);
    return `(select ${pc ? aggSql({ ...pc, agg: pc.agg ?? "sum" }, "t") : `sum(${col(id, "t")})`} from f t)`;
  };
  const out: { id: string; sql: string; raw: string; type: FieldType | "percent" }[] = [];
  for (const c of def.columns) {
    const type = valueType(ds, c);
    let sql: string;
    if (!c.calc) sql = grouped ? aggSql(asAgg(c)) : col(c.field!);
    else if (c.calc.kind === "pct_total") sql = `(${ref(c.calc.of)})::numeric / nullif(${total(c.calc.of)}::numeric, 0)`;
    else if (c.calc.kind === "margin") sql = `((${ref(c.calc.revenue)})::numeric - (${ref(c.calc.cost)})::numeric) / nullif((${ref(c.calc.revenue)})::numeric, 0)`;
    else sql = exprSql(parseExpr(c.calc.expr).node, (id) => ref(id));
    out.push({ id: c.id, sql: present(sql, type), raw: sql, type });
  }
  return out;
}
const present = (sql: string, type: FieldType | "percent") =>
  type === "money" ? `round((${sql})::numeric)::text` : type === "percent" ? `round((${sql})::numeric, 6)::text`
    : type === "number" ? `round((${sql})::numeric, 4)::text` : type === "date" ? `(${sql})::text` : sql;

const groupExpr = (g: Group) => g.bucket ? `date_trunc('${g.bucket}', ${col(g.field)})::date` : col(g.field);

export type ResultColumn = { key: string; label: string; type: FieldType | "percent"; align: "left" | "right"; role: "group" | "measure" | "detail"; bucket?: Bucket; field?: string };
export type RunResult = {
  dataset: string; mode: "detail" | "grouped"; columns: ResultColumn[]; rows: Record<string, unknown>[];
  total: Record<string, unknown> | null; offset: number; size: number; count: number; capped: boolean;
  chart: { type: "bar" | "line"; label: string; valueType: string; bucket: Bucket | null; points: { key: string | null; value: string | null }[] } | null;
  entryField: boolean; asOf: string; filters: { label: string; text: string }[];
};

type RunOpts = { offset?: number; size?: number; params?: unknown; extraFilters?: Filter[]; cap?: number; withChart?: boolean; preview?: boolean };

/** The company's business date: a report's "as of" and a schedule's next day are the company's, not UTC's. */
async function today(c: Client, entityId: string): Promise<string> {
  return (await q<{ d: string }>(c, `select business_today($1)::text d /* unscoped: keyed by the entity argument */`, [entityId]))[0].d;
}

/** Filters with any asked-at-run values put in: params is { [filterIndex]: { value, value2, op } }. */
export function applyParams(def: Definition, params: unknown): Filter[] {
  const ds = DATASET.get(def.dataset)!;
  const p = params && typeof params === "object" ? params as Record<string, Record<string, unknown>> : {};
  return def.filters.map((f, i) => {
    const given = p[String(i)];
    if (!f.ask || !given || typeof given !== "object") return f;
    const op = typeof given.op === "string" && given.op ? given.op : f.op;
    return { ...checkFilter(ds, { field: f.field, op, value: given.value ?? f.value, value2: given.value2 ?? f.value2, ask: false }), ask: true, label: f.label };
  });
}

/**
 * Run a checked definition for a person holding `roles`. The caller runs it
 * inside a transaction; this sets the statement timeout for it.
 */
export async function run(c: Client, entityId: string, roles: Set<string>, raw: unknown, o: RunOpts = {}): Promise<RunResult> {
  const def = normalize(raw);
  const ds = DATASET.get(def.dataset)!;
  requireDataset(ds, roles);
  await c.query(`select set_config('statement_timeout', $1, true)`, [String(LIMITS.timeoutMs)]);
  const asOf = await today(c, entityId);
  const filters = [...applyParams(def, o.params), ...(o.extraFilters ?? [])];
  const unfilled = (f: Filter) => f.value === undefined && !["blank", "not_blank", "is_true", "is_false"].includes(f.op);
  // A preview leaves out a prompt nobody has answered yet; a real run asks for it.
  if (!o.preview) for (const f of filters) need(!unfilled(f), `${f.label ?? f.field}: fill this in before running the report`);
  const p: unknown[] = [entityId];
  const where = filters.filter((f) => !unfilled(f)).map((f) => filterSql(ds, f, p, asOf));
  const withF = `with f as (select * from (${ds.sql}) d${where.length ? ` where ${where.join(" and ")}` : ""})`;

  const cap = Math.min(o.cap ?? LIMITS.pageMax, LIMITS.exportMax);
  const size = Math.max(1, Math.min(o.size ?? LIMITS.pageDefault, cap));
  const offset = Math.max(0, Math.min(Number.isInteger(o.offset) ? o.offset! : 0, LIMITS.limitMax));
  const reportCap = def.limit ?? LIMITS.limitMax;
  const take = Math.max(0, Math.min(size, reportCap - offset));
  const grouped = def.groupBy.length > 0;
  const measures = columnSqls(ds, def, grouped);
  const columns: ResultColumn[] = [];
  let sql: string;
  let totalSql: string | null = null;

  const sortDir = (d: "asc" | "desc") => d === "desc" ? "desc nulls last" : "asc nulls last";
  if (!grouped) {
    for (const m of measures) {
      const c0 = def.columns.find((x) => x.id === m.id)!;
      columns.push({ key: m.id, label: labelOf(ds, c0), type: m.type, align: alignOf(m.type), role: "detail", field: c0.field });
    }
    const rawOf = (id: string) => measures.find((m) => m.id === id)!.raw;      // sort on the value, not its text
    const order = def.sort ? `${rawOf(def.sort.by)} ${sortDir(def.sort.dir)}` : ds.dateField && def.columns.some((x) => x.field === ds.dateField)
      ? `${rawOf(def.columns.find((x) => x.field === ds.dateField)!.id)} desc nulls last` : "1";
    sql = `${withF} select ${measures.map((m) => `${m.sql} as "${m.id}"`).join(", ")}${ds.entryField ? `, ${col(ds.entryField)} as "_entry"` : ""},
             count(*) over () as "_n" from f d order by ${order} limit ${take} offset ${offset}`;
    if (def.grandTotal) {
      const tdef = { ...def, groupBy: [], columns: def.columns.map((x) => x.field ? { ...x, agg: (["money", "number"].includes(valueType(ds, x)) ? "sum" : undefined) as Agg | undefined } : x) };
      const tm = columnSqls(ds, tdef, true).map((m) => {
        const c0 = def.columns.find((x) => x.id === m.id)!;
        return c0.field && !c0.agg && !["money", "number"].includes(valueType(ds, c0)) ? `null as "${m.id}"` : `${m.sql} as "${m.id}"`;
      });
      totalSql = `${withF} select ${tm.join(", ")} from f d`;
    }
  } else {
    const gx = def.groupBy.map(groupExpr);
    def.groupBy.forEach((g, i) => {
      const f = ds.fields.find((x) => x.id === g.field)!;
      columns.push({ key: `g${i}`, label: groupLabel(ds, g), type: f.type, align: alignOf(g.bucket ? "text" : f.type), role: "group", bucket: g.bucket, field: f.id });
    });
    for (const m of measures) {
      const c0 = def.columns.find((x) => x.id === m.id)!;
      columns.push({ key: m.id, label: labelOf(ds, c0), type: m.type, align: alignOf(m.type), role: "measure", field: c0.field });
    }
    const n = gx.length;
    const sets = def.subtotals ? Array.from({ length: n }, (_, k) => `(${gx.slice(0, n - k).join(", ")})`).join(", ") : null;
    const groupBy = sets ? `group by grouping sets (${sets})` : `group by ${gx.join(", ")}`;
    const measureSort = def.sort && !/^g\d$/.test(def.sort.by) ? `${measures.find((m) => m.id === def.sort!.by)!.raw} ${sortDir(def.sort.dir)}` : null;
    const keyDir = (i: number) => def.sort && def.sort.by === `g${i}` ? sortDir(def.sort.dir) : "asc nulls last";
    const order: string[] = [];
    if (def.subtotals) {
      gx.forEach((e, i) => {
        if (i > 0) order.push(`grouping(${e})`);
        if (i === n - 1 && measureSort) order.push(measureSort);
        order.push(`${e} ${keyDir(i)}`);
      });
    } else {
      if (measureSort) order.push(measureSort);
      gx.forEach((e, i) => order.push(`${e} ${keyDir(i)}`));
    }
    sql = `${withF} select ${gx.map((e, i) => `${presentKey(e, ds.fields.find((x) => x.id === def.groupBy[i].field)!.type, !!def.groupBy[i].bucket)} as "g${i}"`).join(", ")},
             ${measures.length ? measures.map((m) => `${m.sql} as "${m.id}"`).join(", ") + "," : ""}
             grouping(${gx.join(", ")}) as "_mask", count(*) over () as "_n"
             from f d ${groupBy} order by ${order.join(", ")} limit ${take} offset ${offset}`;
    if (def.grandTotal) totalSql = measures.length ? `${withF} select ${measures.map((m) => `${m.sql} as "${m.id}"`).join(", ")} from f d` : null;
  }

  const res = await q<Record<string, unknown>>(c, sql, p);
  const count = res.length ? Math.min(Number(res[0]._n), reportCap) : Math.min(offset, reportCap);
  const rows = res.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(r)) if (k !== "_n" && k !== "_mask") out[k] = r[k];
    if (grouped) out._depth = def.groupBy.length - popcount(Number(r._mask));   // how many group keys this row has
    return out;
  });
  const total = totalSql ? (await q<Record<string, unknown>>(c, totalSql, p))[0] ?? null : null;

  let chart: RunResult["chart"] = null;
  if (def.chart && o.withChart !== false) {
    const m = measures.find((x) => x.id === def.chart!.col);
    if (m) {
      const g0 = gx0(def);
      const csort = def.sort && def.sort.by === def.chart.col ? `${m.raw} ${sortDir(def.sort.dir)}` : `${g0} asc nulls last`;
      const pts = await q<{ k: string | null; v: string | null }>(c,
        `${withF} select ${presentKey(g0, ds.fields.find((x) => x.id === def.groupBy[0].field)!.type, !!def.groupBy[0].bucket)} as k, ${m.sql} as v
           from f d group by ${g0} order by ${csort} limit ${LIMITS.chartMax}`, p);
      const c0 = def.columns.find((x) => x.id === m.id)!;
      chart = { type: def.chart.type, label: labelOf(ds, c0), valueType: m.type, bucket: def.groupBy[0].bucket ?? null,
        points: pts.map((x) => ({ key: x.k, value: x.v })) };
    }
  }
  return { dataset: ds.id, mode: grouped ? "grouped" : "detail", columns, rows, total, offset, size: take, count,
    capped: count >= reportCap && reportCap === LIMITS.limitMax, chart, entryField: !!ds.entryField && !grouped, asOf,
    filters: filters.map((f) => ({ label: f.label ?? ds.fields.find((x) => x.id === f.field)!.label, text: filterText(f, asOf) })) };
}
const gx0 = (def: Definition) => groupExpr(def.groupBy[0]);
const presentKey = (e: string, type: FieldType, bucketed: boolean) => bucketed || type === "date" ? `(${e})::text` : type === "money" ? `(${e})::text` : e;
const alignOf = (t: string): "left" | "right" => (t === "money" || t === "number" || t === "percent" ? "right" : "left");
const popcount = (n: number) => { let k = 0; while (n) { k += n & 1; n >>= 1; } return k; };

export function filterText(f: Filter, asOf: string): string {
  const v = Array.isArray(f.value) ? f.value.join(", ") : f.value;
  if (v === undefined && !["blank", "not_blank", "is_true", "is_false"].includes(f.op)) return "(not filled in)";
  if (f.op === "relative") { const [a, b] = relativeRange(f.value as Relative, asOf); return `${RELATIVE[f.value as Relative]} (${a} to ${b})`; }
  if (f.op === "between") return `between ${f.value} and ${f.value2}`;
  if (f.op === "within_days") return `in the last ${f.value} days`;
  if (f.op === "older_than_days") return `more than ${f.value} days ago`;
  if (v === undefined) return OPS[f.op];
  return `${OPS[f.op]} ${v}`;
}

/** The detail rows behind one grouped row: the report's filters plus that row's group keys. */
export async function drill(c: Client, entityId: string, roles: Set<string>, raw: unknown, keys: unknown, o: RunOpts = {}) {
  const def = normalize(raw);
  const ds = DATASET.get(def.dataset)!;
  need(def.groupBy.length, "only a grouped report drills down");
  need(Array.isArray(keys) && keys.length >= 1 && keys.length <= def.groupBy.length, "pick a row to drill into");
  const extra: Filter[] = [];
  keys.forEach((k, i) => {
    const g = def.groupBy[i];
    const f = ds.fields.find((x) => x.id === g.field)!;
    if (k == null || k === "") { extra.push({ field: g.field, op: "blank" }); return; }
    if (g.bucket) {
      need(typeof k === "string" && DAY_RE.test(k), "that row's date is not readable");
      extra.push({ field: g.field, op: "between", value: k, value2: bucketEnd(g.bucket, k) });
    } else extra.push(checkFilter(ds, { field: g.field, op: f.type === "bool" ? (k === true || k === "true" ? "is_true" : "is_false") : "eq", value: k }));
  });
  const fields = [...new Set([...def.groupBy.map((g) => g.field), ...ds.detail])];
  const detail = { dataset: ds.id, columns: fields.map((f, i) => ({ id: `d${i}`, field: f })), filters: def.filters, groupBy: [],
    grandTotal: true, sort: null, limit: null, chart: null };
  return run(c, entityId, roles, detail, { ...o, extraFilters: extra, withChart: false });
}

/** Distinct values of a text field, for the "is one of" picker. */
export async function values(c: Client, entityId: string, roles: Set<string>, dataset: unknown, field: unknown): Promise<string[]> {
  const ds = typeof dataset === "string" ? DATASET.get(dataset) : undefined;
  need(ds, "pick a dataset from the list");
  requireDataset(ds, roles);
  const f = fieldOf(ds, field, "values");
  need(f.type === "text", `${f.label} is not text`);
  await c.query(`select set_config('statement_timeout', $1, true)`, [String(LIMITS.timeoutMs)]);
  const r = await q<{ v: string }>(c, `select distinct ${col(f.id)} as v from (${ds.sql}) d where ${col(f.id)} is not null and ${col(f.id)} <> '' order by 1 limit 200`, [entityId]);
  return r.map((x) => x.v);
}

// ------------------------------------------------------------ export

const BUCKET_TEXT = (b: Bucket | undefined, v: string) => {
  if (!b || !DAY_RE.test(v)) return v;
  if (b === "month") return v.slice(0, 7);
  if (b === "year") return v.slice(0, 4);
  if (b === "quarter") return `${v.slice(0, 4)} Q${Math.floor(Number(v.slice(5, 7)) / 3 - 0.01) + 1}`;
  if (b === "week") return `week of ${v}`;
  return v;
};
/** Minor units as a dollar amount, exactly: "-1234.5" never appears, "-1234.50" does. */
export function dollars(minor: string): string {
  const neg = minor.startsWith("-");
  const s = (neg ? minor.slice(1) : minor).replace(/^0+(?=\d)/, "").padStart(3, "0");
  return `${neg ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}
function cellText(cdef: ResultColumn, v: unknown): string {
  if (v == null) return "";
  if (cdef.type === "money") return dollars(String(v));
  if (cdef.type === "percent") return (Number(v) * 100).toFixed(2);
  if (cdef.type === "bool") return v === true || v === "true" ? "Yes" : "No";
  if (cdef.role === "group") return BUCKET_TEXT(cdef.bucket, String(v));
  if (cdef.type === "number") return String(Number(v));
  return String(v);
}
/** The rows of a result as a grid of text: header, rows (subtotals marked), total. */
export function grid(r: RunResult): { header: string[]; rows: { cells: string[]; kinds: (ResultColumn["type"])[]; total: boolean }[] } {
  const header = r.columns.map((c) => c.type === "percent" && !/%/.test(c.label) ? `${c.label} %` : c.label);
  const kinds = r.columns.map((c) => c.role === "group" ? "text" as const : c.type);
  const rows = r.rows.map((row) => {
    const depth = Number(row._depth ?? r.columns.filter((c) => c.role === "group").length);
    const groups = r.columns.filter((c) => c.role === "group").length;
    const cells = r.columns.map((c, i) => {
      if (c.role === "group" && i >= depth) return i === depth ? "Subtotal" : "";
      return cellText(c, row[c.key]);
    });
    return { cells, kinds, total: depth < groups };
  });
  if (r.total) {
    const cells = r.columns.map((c, i) => (c.role === "group" ? (i === 0 ? "Total" : "") : c.role === "detail" && r.total![c.key] == null ? (i === 0 ? "Total" : "") : cellText(c, r.total![c.key])));
    rows.push({ cells, kinds, total: true });
  }
  return { header, rows };
}

/** RFC 4180 CSV. Text that a spreadsheet would run as a formula gets a leading apostrophe. */
export function toCsv(r: RunResult): string {
  const g = grid(r);
  const esc = (s: string, kind: string) => {
    let v = s;
    if (kind === "text" || kind === "date" || kind === "bool") { if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; }
    return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return [g.header.map((h) => esc(h, "text")).join(","), ...g.rows.map((row) => row.cells.map((s, i) => esc(s, row.kinds[i])).join(","))].join("\r\n") + "\r\n";
}

const xml = (s: string) => s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/** A one-sheet .xlsx: numbers stay numbers, money as currency, percent as percent. No dependency: a zip written here. */
export function toXlsx(r: RunResult, title = "Report"): Buffer {
  const g = grid(r);
  const colRef = (i: number) => { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const cell = (ref: string, v: string, kind: string, bold: boolean) => {
    const num = v !== "" && (kind === "money" || kind === "number" || kind === "percent") && /^-?\d+(\.\d+)?$/.test(v);
    if (num) {
      const style = kind === "money" ? (bold ? 4 : 1) : kind === "percent" ? (bold ? 5 : 2) : (bold ? 6 : 0);
      const val = kind === "percent" ? String(Number(v) / 100) : v;
      return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${val}</v></c>`;
    }
    return v === "" ? "" : `<c r="${ref}" t="inlineStr"${bold ? ' s="3"' : ""}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  };
  const rowsXml = [
    `<row r="1">${g.header.map((h, i) => cell(`${colRef(i)}1`, h, "text", true)).join("")}</row>`,
    ...g.rows.map((row, ri) => `<row r="${ri + 2}">${row.cells.map((v, i) => cell(`${colRef(i)}${ri + 2}`, v, row.kinds[i], row.total)).join("")}</row>`),
  ].join("");
  const files: [string, string][] = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Report")}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00;[Red]\\-&quot;$&quot;#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/><xf numFmtId="10" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`],
    ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`],
  ];
  return zip(files.map(([n, s]) => [n, Buffer.from(s, "utf8")]));
}

function zip(files: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameB = Buffer.from(name, "utf8");
    const comp = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameB, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameB.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32); cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, end]);
}

// ------------------------------------------------------------ saved reports

export type SavedRow = {
  id: string; name: string; description: string | null; folder: string; dataset: string; definition: Definition;
  owner_id: string | null; owner_name: string | null; shared: "private" | "roles" | "company"; share_roles: string[];
  starter: string | null; version: number; schedule: Schedule | null; next_run_on: string | null; schedule_by: string | null;
  created_at: string; updated_at: string; updated_by_name: string | null; pinned?: boolean;
};
export type Schedule = { every: "daily" | "weekly" | "monthly"; weekday?: number; monthday?: number; to: string[] };

const SHARE = ["private", "roles", "company"] as const;
export const SHARE_ROLES = ["controller", "viewer", "approver", "ap_clerk", "store_manager", "sales", "cashier", "buyer", "warehouse",
  "dispatcher", "driver", "ar_clerk", "hr", "web_admin"];

const SELECT_REPORT = `
  select r.id, r.name, r.description, r.folder, r.dataset, r.definition, r.owner_id, ou.name owner_name, r.shared, r.share_roles,
         r.starter, r.version, r.schedule, r.next_run_on::text, r.schedule_by, r.created_at, r.updated_at, uu.name updated_by_name
    from report r left join app_user ou on ou.id = r.owner_id left join app_user uu on uu.id = r.updated_by`;

/** Can this person see this report? Shared with them, or theirs; and they may use its dataset. */
export function canSee(r: SavedRow, personId: string, roles: Set<string>): boolean {
  const ds = DATASET.get(r.dataset);
  if (!ds || !mayUse(ds, roles)) return false;
  if (r.owner_id === personId) return true;
  if (r.shared === "company") return true;
  return r.shared === "roles" && (roles.has("owner") || r.share_roles.some((x) => roles.has(x)));
}
/** A person's own report, or a starter for whoever runs the books (owner or controller). */
export const canEdit = (r: SavedRow, personId: string, roles: Set<string>) =>
  r.owner_id === personId || (r.owner_id === null && (roles.has("owner") || roles.has("controller")));
/** Only the person who owns a report removes it; a starter, only the company's owner. */
export const canDelete = (r: SavedRow, personId: string, roles: Set<string>) =>
  r.owner_id === personId || (r.owner_id === null && roles.has("owner"));

export async function listReports(c: Client, entityId: string, personId: string, roles: Set<string>) {
  const rows = await q<SavedRow & { pinned: boolean; last_run_at: string | null }>(c, `
    select r.id, r.name, r.description, r.folder, r.dataset, r.definition, r.owner_id, ou.name owner_name, r.shared, r.share_roles,
           r.starter, r.version, r.schedule, r.next_run_on::text, r.schedule_by, r.created_at, r.updated_at, uu.name updated_by_name,
           exists (select 1 from report_pin p where p.entity_id = $1 and p.report_id = r.id and p.app_user_id = $2) pinned,
           (select max(s.run_at) from report_snapshot s where s.entity_id = $1 and s.report_id = r.id) last_run_at
      from report r left join app_user ou on ou.id = r.owner_id left join app_user uu on uu.id = r.updated_by
     where r.entity_id = $1 and r.status = 'active'
     order by r.folder, r.name`, [entityId, personId]);
  return rows.filter((r) => canSee(r, personId, roles)).map((r) => ({ ...r, canEdit: canEdit(r, personId, roles), canDelete: canDelete(r, personId, roles),
    datasetLabel: DATASET.get(r.dataset)!.label }));
}

export async function getReport(c: Client, entityId: string, id: string, personId: string, roles: Set<string>) {
  need(/^[0-9a-f-]{36}$/i.test(id), "there is no such report");
  const rows = await q<SavedRow>(c, `${SELECT_REPORT} where r.id = $1 and r.entity_id = $2 and r.status = 'active'`, [id, entityId]);
  need(rows.length, "there is no such report");
  const r = rows[0];
  const ds = DATASET.get(r.dataset);
  if (ds && !mayUse(ds, roles)) requireDataset(ds, roles);
  need(canSee(r, personId, roles), "that report is private to the person who made it");
  return r;
}

type SaveIn = { name?: unknown; description?: unknown; folder?: unknown; definition?: unknown; shared?: unknown; shareRoles?: unknown };

function cleanMeta(b: SaveIn) {
  const name = text(b.name, 120);
  need(name, "give the report a name");
  const shared = (typeof b.shared === "string" && (SHARE as readonly string[]).includes(b.shared) ? b.shared : "private") as SavedRow["shared"];
  const shareRoles = Array.isArray(b.shareRoles) ? [...new Set(b.shareRoles.filter((x): x is string => typeof x === "string" && SHARE_ROLES.includes(x)))] : [];
  need(shared !== "roles" || shareRoles.length, "pick at least one role to share it with");
  return { name, description: text(b.description, 500) || null, folder: text(b.folder, 60) || "My reports", shared, shareRoles: shared === "roles" ? shareRoles : [] };
}

export async function createReport(c: Client, scope: Scope, personId: string, roles: Set<string>, b: SaveIn) {
  const meta = cleanMeta(b);
  const def = normalize(b.definition);
  requireDataset(DATASET.get(def.dataset)!, roles);
  const r = await one<{ id: string }>(c, `
    insert into report (entity_id, name, description, folder, dataset, definition, owner_id, shared, share_roles, created_by, updated_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,$7) returning id`,
    [scope.entityId, meta.name, meta.description, meta.folder, def.dataset, JSON.stringify(def), personId, meta.shared, meta.shareRoles]);
  await c.query(`insert into report_version (entity_id, report_id, version, name, description, definition, changed_by)
                 values ($1,$2,1,$3,$4,$5,$6)`, [scope.entityId, r.id, meta.name, meta.description, JSON.stringify(def), personId]);
  await audit(c, scope, { table: "report", rowId: r.id, action: "insert", after: { name: meta.name, dataset: def.dataset, shared: meta.shared } });
  return { id: r.id, version: 1 };
}

export async function updateReport(c: Client, scope: Scope, id: string, personId: string, roles: Set<string>, b: SaveIn & { version?: unknown }) {
  const r = await getReport(c, scope.entityId, id, personId, roles);
  need(canEdit(r, personId, roles), "only the person who made this report can change it; duplicate it to make your own");
  need(b.version == null || Number(b.version) === r.version, `someone saved version ${r.version} of this report since you opened it; reopen it to see their change`);
  const meta = cleanMeta({ name: b.name ?? r.name, description: b.description ?? r.description, folder: b.folder ?? r.folder,
    shared: b.shared ?? r.shared, shareRoles: b.shareRoles ?? r.share_roles });
  const def = b.definition === undefined ? r.definition : normalize(b.definition);
  requireDataset(DATASET.get(def.dataset)!, roles);
  const version = r.version + 1;
  await c.query(`update report set name = $3, description = $4, folder = $5, dataset = $6, definition = $7, shared = $8, share_roles = $9,
                        version = $10, updated_by = $11, updated_at = now()
                  where id = $1 and entity_id = $2`,
    [id, scope.entityId, meta.name, meta.description, meta.folder, def.dataset, JSON.stringify(def), meta.shared, meta.shareRoles, version, personId]);
  await c.query(`insert into report_version (entity_id, report_id, version, name, description, definition, changed_by)
                 values ($1,$2,$3,$4,$5,$6,$7)`, [scope.entityId, id, version, meta.name, meta.description, JSON.stringify(def), personId]);
  await audit(c, scope, { table: "report", rowId: id, action: "update",
    before: { version: r.version, name: r.name, shared: r.shared, definition: r.definition },
    after: { version, name: meta.name, shared: meta.shared, definition: def } });
  return { id, version };
}

export async function duplicateReport(c: Client, scope: Scope, id: string, personId: string, roles: Set<string>, name?: unknown) {
  const r = await getReport(c, scope.entityId, id, personId, roles);
  return createReport(c, scope, personId, roles, { name: text(name, 120) || `Copy of ${r.name}`.slice(0, 120), description: r.description,
    folder: r.folder, definition: r.definition, shared: "private" });
}

export async function deleteReport(c: Client, scope: Scope, id: string, personId: string, roles: Set<string>) {
  const r = await getReport(c, scope.entityId, id, personId, roles);
  need(canDelete(r, personId, roles), r.owner_id ? `only ${r.owner_name ?? "the person who made it"} can delete this report` : "only the company's owner can remove a starter report");
  await c.query(`update report set status = 'deleted', deleted_at = now(), deleted_by = $3, schedule = null, next_run_on = null
                  where id = $1 and entity_id = $2`, [id, scope.entityId, personId]);
  await c.query(`delete from report_pin where entity_id = $1 and report_id = $2`, [scope.entityId, id]);
  await audit(c, scope, { table: "report", rowId: id, action: "delete", before: { name: r.name, version: r.version } });
  return { id, deleted: true };
}

export async function pinReport(c: Client, entityId: string, id: string, personId: string, roles: Set<string>, on: boolean) {
  await getReport(c, entityId, id, personId, roles);
  if (on) await c.query(`insert into report_pin (entity_id, report_id, app_user_id) values ($1,$2,$3) on conflict do nothing`, [entityId, id, personId]);
  else await c.query(`delete from report_pin where entity_id = $1 and report_id = $2 and app_user_id = $3`, [entityId, id, personId]);
  return { id, pinned: on };
}

export async function pinned(c: Client, entityId: string, personId: string, roles: Set<string>) {
  return (await listReports(c, entityId, personId, roles)).filter((r) => r.pinned)
    .map((r) => ({ id: r.id, name: r.name, folder: r.folder, datasetLabel: r.datasetLabel, last_run_at: r.last_run_at }));
}

export async function versions(c: Client, entityId: string, id: string, personId: string, roles: Set<string>) {
  await getReport(c, entityId, id, personId, roles);
  return q(c, `select v.version, v.name, v.changed_at, u.name changed_by_name, v.definition
                 from report_version v left join app_user u on u.id = v.changed_by
                where v.entity_id = $1 and v.report_id = $2 order by v.version desc limit 50`, [entityId, id]);
}

// ------------------------------------------------------------ schedules and snapshots

/** The next day a schedule falls on, after `from`. */
export function nextRun(s: Schedule, from: string): string {
  let d = addDays(from, 1);
  for (let i = 0; i < 400; i++, d = addDays(d, 1)) {
    const t = new Date(d + "T00:00:00Z");
    if (s.every === "daily") return d;
    if (s.every === "weekly" && t.getUTCDay() === (s.weekday ?? 1)) return d;
    if (s.every === "monthly" && t.getUTCDate() === (s.monthday ?? 1)) return d;
  }
  return d;
}

export async function setSchedule(c: Client, scope: Scope, id: string, personId: string, roles: Set<string>, b: Record<string, unknown>) {
  const r = await getReport(c, scope.entityId, id, personId, roles);
  need(canEdit(r, personId, roles), "only the person who made this report can schedule it");
  let sched: Schedule | null = null;
  if (b.every) {
    need(["daily", "weekly", "monthly"].includes(String(b.every)), "a schedule is daily, weekly or monthly");
    const to = Array.isArray(b.to) ? [...new Set(b.to.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)))] : [];
    need(to.length <= 25, "send it to at most 25 people");
    if (to.length) {
      const ok = await q<{ id: string }>(c, `
        select u.id from app_user u join entity e on e.id = $1
         where u.id = any($2::uuid[]) and u.tenant_id = e.tenant_id
           and exists (select 1 from role_grant g where g.app_user_id = u.id and (g.entity_id = $1 or g.entity_id is null))`, [scope.entityId, to]);
      need(ok.length === to.length, "send it only to people in this company");
    }
    sched = { every: b.every as Schedule["every"], to };
    if (sched.every === "weekly") { const w = Number(b.weekday ?? 1); need(Number.isInteger(w) && w >= 0 && w <= 6, "pick a day of the week"); sched.weekday = w; }
    if (sched.every === "monthly") { const m = Number(b.monthday ?? 1); need(Number.isInteger(m) && m >= 1 && m <= 28, "pick a day of the month from 1 to 28"); sched.monthday = m; }
  }
  const next = sched ? nextRun(sched, await today(c, scope.entityId)) : null;
  await c.query(`update report set schedule = $3, next_run_on = $4, schedule_by = $5 where id = $1 and entity_id = $2`,
    [id, scope.entityId, sched ? JSON.stringify(sched) : null, next, sched ? personId : null]);
  await audit(c, scope, { table: "report", rowId: id, action: "update", before: { schedule: r.schedule }, after: { schedule: sched, nextRunOn: next } });
  return { id, schedule: sched, nextRunOn: next };
}

/**
 * Run a saved report and keep what it showed. A scheduled run runs as the
 * person who set the schedule, with the roles they hold now; if they no longer
 * may see the data, the snapshot records that instead of the rows.
 */
export async function snapshot(c: Client, scope: Scope, id: string, runAs: string, trigger: "schedule" | "manual") {
  const rows = await q<SavedRow>(c, `${SELECT_REPORT} where r.id = $1 and r.entity_id = $2 and r.status = 'active'`, [id, scope.entityId]);
  need(rows.length, "there is no such report");
  const r = rows[0];
  const roles = await rolesFor(c, scope.entityId, runAs);
  let result: RunResult | null = null, problem: string | null = null;
  await c.query("savepoint report_run");
  try {
    result = await run(c, scope.entityId, roles, r.definition, { size: LIMITS.snapshotMax, cap: LIMITS.snapshotMax });
    await c.query("release savepoint report_run");
  } catch (e) {
    await c.query("rollback to savepoint report_run");
    if (!(e instanceof ReportError)) throw e;
    problem = e.message;
  }
  const snap = await one<{ id: string; run_at: string }>(c, `
    insert into report_snapshot (entity_id, report_id, version, trigger, run_by, result, row_count, problem)
    values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, run_at`,
    [scope.entityId, id, r.version, trigger, runAs, result ? JSON.stringify(result) : null, result ? result.count : 0, problem]);
  let delivery: { id: string; status: string; to: string[] } | null = null;
  const to = r.schedule?.to ?? [];
  if (trigger === "schedule" && to.length) {
    const people = await q<{ email: string | null; name: string }>(c, `
      select u.email, u.name from app_user u join entity e on e.id = $1 where u.id = any($2::uuid[]) and u.tenant_id = e.tenant_id
       /* unscoped: people of this company's client, by id */`, [scope.entityId, to]);
    const addrs = people.map((p) => p.email).filter((x): x is string => !!x);
    const d = await one<{ id: string; status: string }>(c, `
      insert into report_delivery (entity_id, report_id, snapshot_id, channel, recipients, subject, status)
      values ($1,$2,$3,'email',$4,$5,'prepared') returning id, status`,
      [scope.entityId, id, snap.id, addrs, `${r.name}: ${problem ? "could not run" : `${result!.count} rows`}`]);
    delivery = { id: d.id, status: d.status, to: addrs };
    // Emailed when the company has email connected (Admin, Connections); otherwise it stays prepared.
    if (addrs.length && await messaging.isConnected(c, scope.entityId)) {
      const cols = result?.columns ?? [];
      const cell = (v: unknown) => { const t = v === null || v === undefined ? "" : String(v); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const csv = result ? [cols.map((x) => cell(x.label)).join(","), ...result.rows.map((row) => cols.map((x) => cell(row[x.key])).join(","))].join("\r\n") + "\r\n" : "";
      const sent = await messaging.sendEmail(c, scope.entityId, { to: addrs, subject: `${r.name}: ${problem ? "could not run" : `${result!.count} rows`}`,
        text: problem ? `The scheduled report ${r.name} could not run: ${problem}` : `The scheduled report ${r.name} ran with ${result!.count} rows. The rows are attached.`,
        attachments: result ? [{ filename: `${r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report"}.csv`, content: csv }] : [] },
        { purpose: "report", sourceTable: "report_delivery", sourceId: d.id });
      const ok = sent.status === "sent";
      await c.query(`update report_delivery set status = $3, sent_at = case when $3 = 'sent' then now() end, provider_ref = $4, problem = $5 where id = $1 and entity_id = $2`,
        [d.id, scope.entityId, ok ? "sent" : "failed", sent.providerRef, ok ? null : sent.error]);
      delivery = { id: d.id, status: ok ? "sent" : "failed", to: addrs };
    }
  }
  return { snapshotId: snap.id, runAt: snap.run_at, rows: result?.count ?? 0, problem, delivery };
}

export async function snapshots(c: Client, entityId: string, id: string, personId: string, roles: Set<string>) {
  await getReport(c, entityId, id, personId, roles);
  return q(c, `select s.id, s.version, s.trigger, s.run_at, s.row_count, s.problem, u.name run_by_name,
                      (select d.status from report_delivery d where d.entity_id = $1 and d.snapshot_id = s.id limit 1) delivery
                 from report_snapshot s left join app_user u on u.id = s.run_by
                where s.entity_id = $1 and s.report_id = $2 order by s.run_at desc limit 30`, [entityId, id]);
}

export async function snapshotResult(c: Client, entityId: string, id: string, snapId: string, personId: string, roles: Set<string>) {
  await getReport(c, entityId, id, personId, roles);
  const rows = await q<{ result: RunResult | null; problem: string | null; run_at: string }>(c,
    `select result, problem, run_at from report_snapshot where entity_id = $1 and report_id = $2 and id = $3`, [entityId, id, snapId]);
  need(rows.length, "there is no such snapshot");
  return rows[0];
}

/** Every company's reports whose schedule has come round. Each runs in its own transaction; a failure stays with its report. */
export async function runDueReports(pool: { connect: () => Promise<Client> }, tx: <R>(a: Scope["actor"], fn: (c: Client) => Promise<R>) => Promise<R>, asOf?: string, only?: string) {
  const c0 = await pool.connect();
  let due: { id: string; entity_id: string; tenant_id: string; schedule: Schedule; schedule_by: string; next_run_on: string; name: string }[];
  try {
    due = await q(c0, `select r.id, r.entity_id, e.tenant_id, r.schedule, r.schedule_by, r.next_run_on::text, r.name
                         from report r join entity e on e.id = r.entity_id
                        where r.status = 'active' and r.schedule is not null and r.schedule_by is not null
                          and exists (select 1 from tenant t where t.id = e.tenant_id and t.status = 'active')
                          and r.next_run_on <= coalesce($1::date, business_today(r.entity_id)) and ($2::uuid is null or r.entity_id = $2)
                        order by r.next_run_on /* unscoped: the scheduler walks every company's reports */`, [asOf ?? null, only ?? null]);
  } finally { c0.release(); }
  const out: { name: string; ok: boolean; note: string; entityId: string; tenantId: string }[] = [];
  for (const r of due) {
    const actor = { kind: "system" as const, label: "report scheduler" };
    try {
      const s = await tx(actor, async (c) => {
        const scope = { tenantId: r.tenant_id, entityId: r.entity_id, actor };
        const res = await snapshot(c, scope, r.id, r.schedule_by, "schedule");
        await c.query(`update report set next_run_on = $3 where id = $1 and entity_id = $2`, [r.id, r.entity_id, nextRun(r.schedule, asOf ?? r.next_run_on)]);
        return res;
      });
      out.push({ name: r.name, ok: !s.problem, note: s.problem ?? `${s.rows} rows${s.delivery ? `, email prepared for ${s.delivery.to.length}` : ""}`, entityId: r.entity_id, tenantId: r.tenant_id });
    } catch (e) {
      out.push({ name: r.name, ok: false, note: (e as Error).message, entityId: r.entity_id, tenantId: r.tenant_id });
    }
  }
  return { due: due.length, runs: out };
}

// ------------------------------------------------------------ starters

type Starter = { key: string; name: string; folder: string; description: string; needs: string[]; def: Record<string, unknown> };
const ASK = (field: string, label: string, value: Relative) => ({ field, op: "relative", value, ask: true, label });

/** Reports every company starts with, each shown only when its modules are on. */
export const STARTERS: Starter[] = [
  { key: "sales_store_month", name: "Sales by store by month", folder: "Sales", needs: ["pos", "shop"],
    description: "Posted sales (invoiced less returns) by store and month, with margin. Ties to the revenue in Books.",
    def: { dataset: "sales_posted", groupBy: [{ field: "store" }, { field: "posted_on", bucket: "month" }], subtotals: true,
      columns: [{ id: "net", field: "net" }, { id: "cost", field: "cost" }, { id: "margin", field: "margin" },
        { id: "mpct", calc: { kind: "margin", revenue: "net", cost: "cost" }, label: "Margin %" }],
      filters: [ASK("posted_on", "Period", "this_year")], chart: { type: "bar", col: "net" } } },
  { key: "sales_by_salesperson", name: "Sales by salesperson with margin", folder: "Sales", needs: ["pos", "shop"],
    description: "Who sold what this month: posted net sales, estimated cost, margin and margin %.",
    def: { dataset: "sales_posted", groupBy: [{ field: "salesperson" }],
      columns: [{ id: "net", field: "net" }, { id: "cost", field: "cost" }, { id: "margin", field: "margin" },
        { id: "mpct", calc: { kind: "margin", revenue: "net", cost: "cost" }, label: "Margin %" },
        { id: "share", calc: { kind: "pct_total", of: "net" }, label: "Share of sales" }],
      filters: [ASK("posted_on", "Period", "this_month")], sort: { by: "net", dir: "desc" }, chart: { type: "bar", col: "net" } } },
  { key: "top_products", name: "Top 25 products", folder: "Sales", needs: ["pos", "shop"],
    description: "The 25 products with the most posted net sales in the period.",
    def: { dataset: "sales_posted", groupBy: [{ field: "product" }],
      columns: [{ id: "qty", field: "qty" }, { id: "net", field: "net" }, { id: "margin", field: "margin" },
        { id: "mpct", calc: { kind: "margin", revenue: "net", cost: "cost" }, label: "Margin %" }],
      filters: [ASK("posted_on", "Period", "last_90")], sort: { by: "net", dir: "desc" }, limit: 25 } },
  { key: "slow_movers", name: "Slow movers", folder: "Inventory", needs: ["inventory"],
    description: "Stock on hand that has not sold in 90 days (or, if it never sold, was added more than 90 days ago).",
    def: { dataset: "products_stock",
      columns: [{ id: "sku", field: "sku" }, { id: "product", field: "product" }, { id: "location", field: "location" },
        { id: "on_hand", field: "on_hand" }, { id: "value", field: "stock_value" }, { id: "last", field: "last_sold_on" }, { id: "idle", field: "idle_days" }],
      filters: [{ field: "on_hand", op: "gt", value: 0 }, { field: "idle_days", op: "gte", value: 90, ask: true, label: "At least this many days without a sale" }],
      sort: { by: "value", dir: "desc" } } },
  { key: "special_orders_vendor", name: "Open special orders by vendor", folder: "Purchasing", needs: ["purchasing"],
    description: "Customer lines waiting on a vendor, by vendor: how many, how much, and the oldest.",
    def: { dataset: "sales_lines", groupBy: [{ field: "vendor" }],
      columns: [{ id: "lines", field: "order_number", agg: "count", label: "Lines" }, { id: "qty", field: "qty" }, { id: "net", field: "net" },
        { id: "oldest", field: "ordered_on", agg: "min", label: "Oldest order" }],
      filters: [{ field: "line_status", op: "eq", value: "on_order" }, { field: "order_status", op: "not_in", value: ["cancelled", "draft"] }],
      sort: { by: "net", dir: "desc" } } },
  { key: "receipts_tender_day", name: "Receipts by tender by day", folder: "Sales", needs: ["pos", "shop"],
    description: "What came in each day by tender (cash, card, check, financing...), voids left out.",
    def: { dataset: "receipts", groupBy: [{ field: "received_on", bucket: "day" }, { field: "tender" }], subtotals: true,
      columns: [{ id: "n", field: "number", agg: "count", label: "Receipts" }, { id: "amount", field: "amount" }],
      filters: [ASK("received_on", "Period", "this_month"), { field: "voided", op: "is_false" }] } },
  { key: "ar_aging_store", name: "A/R aging by store", folder: "Finance", needs: ["ar"],
    description: "What customers owe today by store and aging bucket.",
    def: { dataset: "ar_open", groupBy: [{ field: "store" }, { field: "bucket" }], subtotals: true,
      columns: [{ id: "n", field: "customer", agg: "count_distinct", label: "Customers" }, { id: "open", field: "open" },
        { id: "share", calc: { kind: "pct_total", of: "open" }, label: "Share" }] } },
  { key: "inventory_value_category", name: "Inventory value by category", folder: "Inventory", needs: ["inventory"],
    description: "What the stock is worth at cost, and at price, by category.",
    def: { dataset: "inventory_value", groupBy: [{ field: "category" }],
      columns: [{ id: "qty", field: "qty" }, { id: "value", field: "value" }, { id: "retail", field: "retail_value" },
        { id: "share", calc: { kind: "pct_total", of: "value" }, label: "Share of value" }],
      sort: { by: "value", dir: "desc" }, chart: { type: "bar", col: "value" } } },
  { key: "vendor_spend_category", name: "Vendor spend by category", folder: "Purchasing", needs: [],
    description: "Bills entered this year by spend category and vendor.",
    def: { dataset: "vendor_spend", groupBy: [{ field: "spend_category" }, { field: "vendor" }], subtotals: true,
      columns: [{ id: "bills", field: "reference", agg: "count_distinct", label: "Bills" }, { id: "amount", field: "amount" }],
      filters: [ASK("bill_date", "Period", "this_year")] } },
  { key: "payroll_store", name: "Payroll by store", folder: "People", needs: [],
    description: "Hours, gross pay, employer taxes and total cost by store and month.",
    def: { dataset: "payroll", groupBy: [{ field: "store" }, { field: "pay_date", bucket: "month" }], subtotals: true,
      columns: [{ id: "hours", calc: { kind: "expr", expr: "regular_hours + overtime_hours" }, label: "Hours", format: "number" },
        { id: "gross", field: "gross" }, { id: "er_tax", field: "employer_tax" }, { id: "cost", field: "total_cost" }],
      filters: [ASK("pay_date", "Period", "this_year")] } },
  { key: "delivery_on_time_driver", name: "Delivery on-time by driver", folder: "Operations", needs: ["fleet"],
    description: "Stops each driver completed, how many arrived inside their window, and the on-time rate.",
    def: { dataset: "deliveries", groupBy: [{ field: "driver" }],
      columns: [{ id: "stops", field: "number", agg: "count", label: "Stops" }, { id: "timed", field: "timed", agg: "count_true", label: "Done with a window" },
        { id: "on_time", field: "on_time", agg: "count_true", label: "On time" },
        { id: "rate", calc: { kind: "expr", expr: "on_time / timed" }, label: "On-time rate", format: "percent" },
        { id: "late", field: "late_minutes", agg: "avg", label: "Average minutes late" }],
      filters: [ASK("scheduled_on", "Period", "this_month"), { field: "status", op: "not_in", value: ["cancelled"] }],
      sort: { by: "stops", dir: "desc" } } },
  { key: "web_vs_store", name: "Web vs store sales", folder: "Sales", needs: ["shop"],
    description: "Posted sales from the web store against the stores, month by month.",
    def: { dataset: "sales_posted", groupBy: [{ field: "channel_group" }, { field: "posted_on", bucket: "month" }], subtotals: true,
      columns: [{ id: "orders", field: "order_number", agg: "count_distinct", label: "Orders" }, { id: "net", field: "net" },
        { id: "share", calc: { kind: "pct_total", of: "net" }, label: "Share of sales" }],
      filters: [ASK("posted_on", "Period", "this_year")], chart: { type: "bar", col: "net" } } },
];

/** Add the starters a company's modules call for. Only ever adds; one a person removed stays removed. */
export async function installStarters(c: Client, entityId: string, modules: string[]): Promise<number> {
  let added = 0;
  for (const s of STARTERS) {
    if (s.needs.length && !s.needs.some((m) => modules.includes(m))) continue;
    const def = normalize(s.def);
    const r = await c.query(`
      insert into report (entity_id, name, description, folder, dataset, definition, owner_id, shared, starter)
      values ($1,$2,$3,$4,$5,$6,null,'company',$7) on conflict (entity_id, starter) do nothing returning id`,
      [entityId, s.name, s.description, s.folder, def.dataset, JSON.stringify(def), s.key]);
    if (r.rowCount) {
      added++;
      await c.query(`insert into report_version (entity_id, report_id, version, name, description, definition) values ($1,$2,1,$3,$4,$5)`,
        [entityId, r.rows[0].id, s.name, s.description, JSON.stringify(def)]);
    }
  }
  return added;
}
