// Reports checks: every dataset runs on the demo; the starters install and
// run; sales tie to the revenue posted; the P&L dataset ties to Books;
// filters, groups, aggregates, formulas and subtotals add up; drilling finds
// the rows behind a total; injection attempts and the wrong roles are refused;
// another company sees nothing; saved reports version, share, pin and delete
// by their owner only; a schedule keeps a snapshot and prepares its email;
// CSV escaping and the Excel file.
import { type T, ENTITY, RIO_ENTITY, PEOPLE } from "./harness.ts";
import { q, tx, type Client } from "../../packages/core/db.ts";
import { module as reportsModule } from "../../server/modules/reports.ts";
import * as rep from "../../packages/core/reports.ts";
import * as views from "../../server/views.ts";
import { routes, companyOf, asPerson } from "./catalog.ts";

const MARIA = "55555555-0000-0000-0000-000000000011";     // sales
const RAY = "55555555-0000-0000-0000-000000000014";       // dispatcher
const RIO_OWNER = "eeee0000-0000-0000-0000-000000000201";

const read = async <R>(t: T, fn: (c: Client) => Promise<R>): Promise<R> => {
  const c = await t.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};
/** Run a definition in a transaction as a person (as the run route does). */
const runAs = <R = rep.RunResult>(t: T, person: string, fn: (c: Client, roles: Set<string>) => Promise<R>, entityId = ENTITY) =>
  tx({ kind: "user", id: person, label: "check" }, async (c) => fn(c, await rep.rolesFor(c, entityId, person)));
const N = (v: unknown) => Number(v ?? 0);
const B = (v: unknown) => BigInt(String(v ?? "0"));

export async function run(t: T) {
  const r = routes(t, reportsModule);
  const today = await read(t, async (c) => (await q<{ d: string }>(c, `select current_date::text d /* unscoped: the clock */`))[0].d);
  const yearStart = today.slice(0, 4) + "-01-01";

  // ------------------------------------------------------------ every dataset runs
  for (const ds of rep.DATASETS) {
    const fields = ds.fields.filter((f) => f.id !== ds.entryField);
    try {
      const res = await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles,
        { dataset: ds.id, columns: fields.map((f, i) => ({ id: `c${i}`, field: f.id })) }, { size: 5 }));
      const grouped = await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles,
        { dataset: ds.id, groupBy: [{ field: fields.find((f) => f.type === "text")!.id }],
          columns: fields.filter((f) => f.agg).slice(0, 3).map((f, i) => ({ id: `m${i}`, field: f.id })) }, { size: 5 }));
      t.ok(`dataset ${ds.id}: every field runs, detail and grouped`, res.columns.length === fields.length && grouped.mode === "grouped",
        `${res.count} rows, ${grouped.count} groups`);
    } catch (e) { t.ok(`dataset ${ds.id}: every field runs, detail and grouped`, false, (e as Error).message.slice(0, 200)); }
  }
  const nonEmpty = ["gl_lines", "pnl_lines", "sales_lines", "sales_posted", "orders", "receipts", "ar_open", "customers", "products_stock",
    "inventory_value", "po_lines", "vendor_spend", "payroll", "commissions", "deliveries", "routes", "web_carts", "trial_balance"];
  const counts: string[] = [];
  // Every dataset's rows come from the module checks that run before this one, except vendor bills: the demo's seeds
  // carry none, and the only ones were the finance smoke's (scripts/smoke.ts), left behind in the database. So
  // vendor_spend had rows only when the smoke had run on this database since its last reset -- never after
  // `apply.sh --reset --seed && smoke:modules`, nor on a second modules run (platform's demo reset clears them).
  // The check now brings its own bill, through the payables tables, and rolls it back: the same answer every time,
  // whatever ran before, whatever the clock says (the dataset has no date window).
  const ROLLBACK = new Error("rollback: the check's own bill is not kept");
  const withOwnBill = async <R>(fn: (c: Client, roles: Set<string>) => Promise<R>): Promise<R> => {
    let out: R | undefined;
    await tx({ kind: "user", id: PEOPLE.STEVE, label: "check" }, async (c) => {
      const v = await q<{ vendor_id: string }>(c, `select vendor_id from vendor_entity where entity_id = $1 and status = 'active' order by vendor_id limit 1`, [ENTITY]);
      const g = await q<{ id: string }>(c, `select g.id from gl_account g join entity e on e.tenant_id = g.tenant_id and e.id = $1
                                              where g.is_postable and g.account_type = 'expense' order by g.code limit 1 /* unscoped: the company's chart */`, [ENTITY]);
      const b = await q<{ id: string }>(c, `insert into invoice (tenant_id, entity_id, vendor_id, kind, reference, invoice_date, due_date, total_minor, confidence_bps, created_by)
          select e.tenant_id, e.id, $2, 'operating', 'REPORTS-CHECK-1', business_today(e.id), business_today(e.id) + 30, 12345, 10000, $3
            from entity e where e.id = $1 returning id /* unscoped: the company row itself */`, [ENTITY, v[0].vendor_id, PEOPLE.CLERK]);
      await c.query(`insert into invoice_line (invoice_id, seq, gl_account_id, amount_minor) values ($1, 1, $2, 12345)`, [b[0].id, g[0].id]);
      out = await fn(c, await rep.rolesFor(c, ENTITY, PEOPLE.STEVE));
      throw ROLLBACK;
    }).catch((e) => { if (e !== ROLLBACK) throw e; });
    return out!;
  };
  for (const id of nonEmpty) {
    const ds = rep.DATASET.get(id)!;
    const def = { dataset: id, columns: [{ id: "a", field: ds.fields[0].id }] };
    const res = id === "vendor_spend"
      ? await withOwnBill((c, roles) => rep.run(c, ENTITY, roles, def, { size: 1 }))
      : await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles, def, { size: 1 }));
    if (!res.count) counts.push(id);
  }
  const leftBehind = await read(t, (c) => q(c, `select 1 from invoice where entity_id = $1 and reference = 'REPORTS-CHECK-1'`, [ENTITY]));
  t.ok("vendor spend: the check's own bill is rolled back, never left in the demo", !leftBehind.length);
  t.ok("the demo has rows in every dataset", !counts.length, counts.join(", "));

  // ------------------------------------------------------------ starters
  const gets = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  reportsModule.register({ coGet: (tail: string, fn: never) => gets.set(tail, fn), coPost: () => {}, publicRoute: () => {} } as never);
  const getAs = <R>(tail: string, person: string | null, ids: string[] = [], entityId = ENTITY) => read(t, async (c) => {
    const co = await companyOf(t, entityId);
    return gets.get(tail)!(c, co, new URL("http://x/"), ["", co.id, ...ids], person) as Promise<R>;
  });
  await t.throws("the report list needs someone to act as", () => getAs("/reports", null), /pick who you are acting as/);
  const listed = await getAs<{ reports: (rep.SavedRow & { canEdit: boolean })[] }>("/reports", PEOPLE.STEVE);
  const starters = listed.reports.filter((x) => x.starter);
  t.ok("twelve starter reports are there for the demo company", starters.length === 12, starters.map((x) => x.starter).join(", "));
  for (const s of starters) {
    try {
      const res = await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles, s.definition));
      t.ok(`starter "${s.name}" runs`, Array.isArray(res.rows), `${res.count} rows`);
    } catch (e) { t.ok(`starter "${s.name}" runs`, false, (e as Error).message); }
  }
  const starterOf = (key: string) => starters.find((x) => x.starter === key)!;

  // a column on a grouped field is shown as the group; sorting by it sorts by the group
  const byStore = await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles, { dataset: "sales_posted", groupBy: [{ field: "store" }],
    columns: [{ id: "s", field: "store" }, { id: "n", field: "net" }], sort: { by: "s", dir: "desc" } }));
  t.ok("a sort on a grouped field's column sorts by that group", byStore.mode === "grouped" && byStore.rows.length > 0);

  // ------------------------------------------------------------ ties
  const salesYear = await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles, starterOf("sales_store_month").definition,
    { params: { 0: { op: "between", value: yearStart, value2: today } }, size: 200 }));
  const glRevenue = await read(t, async (c) => (await q<{ store: string | null; s: string }>(c, `
    select po.name store, sum(jl.credit_minor - jl.debit_minor)::text s
      from journal_line jl join journal_entry je on je.id = jl.journal_entry_id
      join gl_account ga on ga.id = jl.gl_account_id and ga.account_type = 'revenue'
      left join profit_object po on po.id = jl.profit_object_id
     where je.entity_id = $1 and je.source_type in ('sale', 'refund') and je.posting_date between $2::date and $3::date
     group by po.name`, [ENTITY, yearStart, today])));
  const glTotal = glRevenue.reduce((a, x) => a + B(x.s), 0n);
  t.ok("Sales by store: the total equals the revenue posted by sales and returns this year",
    salesYear.total !== null && B(salesYear.total.net) === glTotal && glTotal !== 0n, `${salesYear.total?.net} vs ${glTotal}`);
  const subtotals = salesYear.rows.filter((x) => x._depth === 1);
  const storeMismatch = glRevenue.filter((g) => {
    const row = subtotals.find((x) => x.g0 === g.store);
    return !row || B(row.net) !== B(g.s);
  });
  t.ok("Sales by store: each store's subtotal equals its posted revenue", subtotals.length === glRevenue.length && !storeMismatch.length,
    JSON.stringify(storeMismatch));
  const leaves = salesYear.rows.filter((x) => x._depth === 2);
  t.ok("Sales by store: months add up to their store", subtotals.every((s) => leaves.filter((l) => l.g0 === s.g0).reduce((a, l) => a + B(l.net), 0n) === B(s.net)));

  const monthStart = today.slice(0, 8) + "01";
  const books = await read(t, async (c) => views.pnl(c, await companyOf(t), monthStart, today));
  const pnlRun = await runAs(t, PEOPLE.CONTROLLER, (c, roles) => rep.run(c, ENTITY, roles, {
    dataset: "pnl_lines", groupBy: [{ field: "account_code" }], columns: [{ id: "amt", field: "amount" }],
    filters: [{ field: "posted_on", op: "between", value: monthStart, value2: today }] }, { size: 200 }));
  const pnlBad = books.accounts.filter((a) => B(pnlRun.rows.find((x) => x.g0 === a.code)?.amt) !== B(a.total));
  t.ok("P&L dataset: every account ties to Books for the month", books.accounts.length > 0 && pnlRun.rows.length === books.accounts.length && !pnlBad.length,
    JSON.stringify(pnlBad.slice(0, 2)));
  const pnlStore = await runAs(t, PEOPLE.CONTROLLER, (c, roles) => rep.run(c, ENTITY, roles, {
    dataset: "pnl_lines", groupBy: [{ field: "store" }], columns: [{ id: "ni", field: "net_income" }],
    filters: [{ field: "posted_on", op: "relative", value: "this_month" }] }, { size: 200 }));
  const booksNet = books.accounts.reduce((a, x) => a + (x.type === "revenue" ? B(x.total) : -B(x.total)), 0n);
  const monthEnd = rep.relativeRange("this_month", today)[1];
  const booksMonth = await read(t, async (c) => views.pnl(c, await companyOf(t), monthStart, monthEnd));
  const booksMonthNet = booksMonth.accounts.reduce((a, x) => a + (x.type === "revenue" ? B(x.total) : -B(x.total)), 0n);
  t.ok("P&L dataset: net income for the month ties to Books", B(pnlStore.total?.ni) === booksMonthNet, `${pnlStore.total?.ni} vs ${booksMonthNet} (to today ${booksNet})`);

  // ------------------------------------------------------------ filters
  const direct = (sql: string, p: unknown[] = []) => read(t, async (c) => Number((await q<{ n: string }>(c, sql, [ENTITY, ...p]))[0].n));
  const countOf = async (def: Record<string, unknown>) => (await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles, def, { size: 1 }))).count;
  const SL = (filters: unknown[]) => ({ dataset: "sales_lines", columns: [{ id: "o", field: "order_number" }], filters });
  t.ok("filter: channel is web", await countOf(SL([{ field: "channel", op: "eq", value: "WEB" }])) ===
    await direct(`select count(*) n from sales_order_line l join sales_order so on so.id = l.sales_order_id left join pos_line pl on pl.sales_order_line_id = l.id
                   where l.entity_id = $1 and so.channel = 'web' and coalesce(pl.role, 'item') = 'item'`));
  t.ok("filter: line status is one of", await countOf(SL([{ field: "line_status", op: "in", value: ["fulfilled", "reserved"] }])) ===
    await direct(`select count(*) n from sales_order_line l left join pos_line pl on pl.sales_order_line_id = l.id
                   where l.entity_id = $1 and l.line_status in ('fulfilled', 'reserved') and coalesce(pl.role, 'item') = 'item'`));
  t.ok("filter: net between two amounts (dollars in, cents compared)", await countOf(SL([{ field: "net", op: "between", value: "100", value2: "999.99" }])) ===
    await direct(`select count(*) n from sales_order_line l left join pos_line pl on pl.sales_order_line_id = l.id
                   where l.entity_id = $1 and round(l.qty * l.unit_price_minor) - l.discount_minor between 10000 and 99999 and coalesce(pl.role, 'item') = 'item'`));
  t.ok("filter: customer is blank", await countOf(SL([{ field: "customer", op: "blank" }])) ===
    await direct(`select count(*) n from sales_order_line l join sales_order so on so.id = l.sales_order_id left join pos_line pl on pl.sales_order_line_id = l.id
                   where l.entity_id = $1 and so.customer_id is null and coalesce(pl.role, 'item') = 'item'`));
  const sofa = await countOf(SL([{ field: "product", op: "contains", value: "sofa" }]));
  t.ok("filter: contains is case-blind", sofa > 0 && sofa === await direct(`select count(*) n from sales_order_line l left join pos_line pl on pl.sales_order_line_id = l.id
                   where l.entity_id = $1 and l.description ilike '%sofa%' and coalesce(pl.role, 'item') = 'item'`), String(sofa));
  t.ok("filter: a % typed in contains is a percent sign, not a wildcard", await countOf(SL([{ field: "product", op: "contains", value: "%" }])) === 0);
  const rTo = rep.relativeRange("last_30", today);
  t.ok("filter: relative dates (last 30 days, this month, YTD)", rTo[1] === today && rep.relativeRange("this_month", "2026-02-10").join() === "2026-02-01,2026-02-28"
    && rep.relativeRange("last_month", "2026-01-15").join() === "2025-12-01,2025-12-31" && rep.relativeRange("ytd", today)[0] === yearStart
    && rep.relativeRange("last_quarter", "2026-05-02").join() === "2026-01-01,2026-03-31" && rep.relativeRange("this_week", "2026-11-11").join() === "2026-11-09,2026-11-15");
  t.ok("filter: ordered in the last 30 days", await countOf(SL([{ field: "ordered_on", op: "relative", value: "last_30" }])) ===
    await direct(`select count(*) n from sales_order_line l join sales_order so on so.id = l.sales_order_id left join pos_line pl on pl.sales_order_line_id = l.id
                   where l.entity_id = $1 and so.ordered_at::date between $2::date and $3::date and coalesce(pl.role, 'item') = 'item'`, rTo));
  t.ok("filter: yes/no field", await countOf({ dataset: "receipts", columns: [{ id: "n", field: "number" }], filters: [{ field: "voided", op: "is_false" }] }) ===
    await direct(`select count(*) n from customer_receipt where entity_id = $1 and voided_at is null`));
  await t.throws("filter: a prompt left empty stops a real run", () => runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles,
    { ...SL([{ field: "ordered_on", op: "relative", ask: true }]) })), /fill this in/);
  t.ok("filter: a preview runs without an unanswered prompt", (await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles,
    SL([{ field: "ordered_on", op: "relative", ask: true }]), { preview: true }))).count > 0);

  // ------------------------------------------------------------ group, aggregate, formulas, totals
  const tenders = await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles, {
    dataset: "receipts", groupBy: [{ field: "tender" }],
    columns: [{ id: "amt", field: "amount" }, { id: "n", field: "number", agg: "count" }, { id: "avg", field: "amount", agg: "avg" },
      { id: "cust", field: "customer", agg: "count_distinct" }, { id: "big", field: "amount", agg: "max" },
      { id: "share", calc: { kind: "pct_total", of: "amt" } }, { id: "per", calc: { kind: "expr", expr: "amt / n" }, format: "money" }],
    sort: { by: "amt", dir: "desc" } }));
  const sqlTenders = await read(t, async (c) => q<{ method: string; s: string; n: string; a: string; d: string; m: string }>(c, `
    select method, sum(amount_minor)::text s, count(*)::text n, round(avg(amount_minor))::text a, count(distinct cu.name)::text d, max(amount_minor)::text m
      from customer_receipt r left join customer cu on cu.id = r.customer_id where r.entity_id = $1 group by method`, [ENTITY]));
  const tBad = sqlTenders.filter((x) => { const row = tenders.rows.find((y) => y.g0 === x.method);
    return !row || row.amt !== x.s || N(row.n) !== N(x.n) || row.avg !== x.a || N(row.cust) !== N(x.d) || row.big !== x.m; });
  t.ok("group and aggregate: sum, count, average, count distinct and max by tender match SQL", tenders.rows.length === sqlTenders.length && !tBad.length, JSON.stringify(tBad[0]));
  t.ok("sort: largest tender first", tenders.rows.every((x, i) => i === 0 || B(tenders.rows[i - 1].amt) >= B(x.amt)));
  t.ok("grand total equals the sum of the groups", B(tenders.total?.amt) === tenders.rows.reduce((a, x) => a + B(x.amt), 0n));
  t.ok("% of total: shares add to 100%", Math.abs(tenders.rows.reduce((a, x) => a + N(x.share), 0) - 1) < 0.0001 && N(tenders.total?.share) === 1);
  t.ok("formula: amount ÷ count is the average", tenders.rows.every((x) => Math.abs(N(x.per) - N(x.avg)) <= 1));
  const margin = await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles, {
    dataset: "sales_posted", groupBy: [{ field: "store" }],
    columns: [{ id: "net", field: "net" }, { id: "cost", field: "cost" }, { id: "mp", calc: { kind: "margin", revenue: "net", cost: "cost" } },
      { id: "zero", calc: { kind: "expr", expr: "net / (cost - cost)" } }, { id: "neg", calc: { kind: "expr", expr: "-(net - cost) * 2 + 1" } }] }));
  t.ok("margin % = (sales − cost) ÷ sales, per row and on the total", margin.rows.every((x) => B(x.net) === 0n || Math.abs(N(x.mp) - (N(x.net) - N(x.cost)) / N(x.net)) < 1e-5)
    && Math.abs(N(margin.total?.mp) - (N(margin.total?.net) - N(margin.total?.cost)) / N(margin.total?.net)) < 1e-5);
  t.ok("formula: dividing by zero is blank, not an error", margin.rows.every((x) => x.zero === null));
  t.ok("formula: unary minus and precedence", margin.rows.every((x) => N(x.neg) === -(N(x.net) - N(x.cost)) * 2 + 1));
  const sub = await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles, starterOf("receipts_tender_day").definition, { params: { 0: { value: "last_365" } } }));
  const days = sub.rows.filter((x) => x._depth === 1), leafs = sub.rows.filter((x) => x._depth === 2);
  t.ok("subtotals: one per day, each after its tenders, adding up", days.length > 0 && days.every((d) => {
    const i = sub.rows.indexOf(d);
    const kids = leafs.filter((l) => l.g0 === d.g0);
    return kids.every((k) => sub.rows.indexOf(k) < i) && kids.reduce((a, k) => a + B(k.amount), 0n) === B(d.amount);
  }));
  const months = await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles, {
    dataset: "gl_lines", groupBy: [{ field: "posted_on", bucket: "month" }, { field: "account_type" }], columns: [{ id: "d", field: "debit" }, { id: "cr", field: "credit" }] }));
  t.ok("date buckets: months start on the 1st, and debits equal credits overall", months.rows.every((x) => /^\d{4}-\d{2}-01$/.test(String(x.g0))) && months.total?.d === months.total?.cr);
  const weeks = await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles, {
    dataset: "gl_lines", groupBy: [{ field: "posted_on", bucket: "week" }], columns: [{ id: "n", field: "net" }] }));
  t.ok("date buckets: weeks start on Monday", weeks.rows.every((x) => new Date(String(x.g0) + "T00:00:00Z").getUTCDay() === 1));
  const top = await runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles, { ...starterOf("top_products").definition, limit: 3 }, { params: { 0: { value: "last_365" } } }));
  t.ok("limit: top 3 products, total still covers everything", top.rows.length <= 3 && top.count <= 3 && B(top.total?.net) >= top.rows.reduce((a, x) => a + B(x.net), 0n));
  const paged = await runAs(t, PEOPLE.STEVE, async (c, roles) => {
    const def = { dataset: "gl_lines", columns: [{ id: "a", field: "account" }, { id: "n", field: "net" }], sort: { by: "a", dir: "asc" } };
    const p1 = await rep.run(c, ENTITY, roles, def, { size: 10, offset: 0 });
    const p2 = await rep.run(c, ENTITY, roles, def, { size: 10, offset: 10 });
    const big = await rep.run(c, ENTITY, roles, def, { size: 100000 });
    return { p1, p2, big };
  });
  t.ok("paging: pages of 10 with the full count, and a page never passes the cap", paged.p1.rows.length === 10 && paged.p2.rows.length === 10
    && paged.p1.count === paged.p2.count && paged.big.rows.length <= rep.LIMITS.pageMax);
  t.ok("chart: one bar per first-level group", (salesYear.chart?.points.length ?? 0) === subtotals.length && salesYear.chart?.type === "bar");

  // ------------------------------------------------------------ drill
  const card = tenders.rows.find((x) => x.g0 === "card")!;
  const drilled = await runAs(t, PEOPLE.STEVE, (c, roles) => rep.drill(c, ENTITY, roles, {
    dataset: "receipts", groupBy: [{ field: "tender" }], columns: [{ id: "amt", field: "amount" }] }, ["card"], { size: 200 }));
  t.ok("drill: the rows behind the card total are all card and add up to it", drilled.count === N(card.n)
    && drilled.rows.every((x) => x.d0 === "card") && B(drilled.total?.[drilled.columns.find((c0) => c0.field === "amount")!.key]) === B(card.amt));
  const glDrill = await runAs(t, PEOPLE.CONTROLLER, (c, roles) => rep.drill(c, ENTITY, roles, months.columns.length ? {
    dataset: "gl_lines", groupBy: [{ field: "posted_on", bucket: "month" }], columns: [{ id: "n", field: "net" }] } : {}, [months.rows[0].g0], { size: 5 }));
  const entryId = String(glDrill.rows[0]?._entry ?? "");
  const entry = await read(t, async (c) => views.entry(c, await companyOf(t), entryId));
  t.ok("drill: a GL row carries its journal entry, which Books opens", glDrill.entryField && !!entry, entryId);

  // ------------------------------------------------------------ injection refused
  const inj = (name: string, def: unknown, match: RegExp) => t.throws(`refused: ${name}`, () => runAs(t, PEOPLE.STEVE, (c, roles) => rep.run(c, ENTITY, roles, def)), match);
  await inj("a dataset that is not in the catalog", { dataset: "gl_lines; drop table report", columns: [{ field: "net" }] }, /pick a dataset/);
  await inj("a field that is not in the dataset", { dataset: "gl_lines", columns: [{ field: 'net" from journal_line; --' }] }, /no field/);
  await inj("a field from another dataset", { dataset: "customers", columns: [{ field: "debit" }] }, /no field/);
  await inj("SQL in a formula", { dataset: "gl_lines", columns: [{ field: "net", id: "n" }, { calc: { kind: "expr", expr: "n; select pg_sleep(5)" } }] }, /cannot read/);
  await inj("a function in a formula", { dataset: "gl_lines", columns: [{ field: "net", id: "n" }, { calc: { kind: "expr", expr: "pg_sleep(5)" } }] }, /not a number column|something extra/);
  await inj("a text field in a formula", { dataset: "gl_lines", columns: [{ field: "net", id: "n" }, { calc: { kind: "expr", expr: "n + description" } }] }, /not a number/);
  await inj("an operator not on the list", { dataset: "gl_lines", columns: [{ field: "net" }], filters: [{ field: "net", op: "; delete", value: 1 }] }, /cannot be filtered/);
  await inj("a date bucket not on the list", { dataset: "gl_lines", columns: [{ field: "net" }], groupBy: [{ field: "posted_on", bucket: "month') --" }] }, /day, week, month/);
  await inj("an aggregate not on the list", { dataset: "gl_lines", columns: [{ field: "net", agg: "string_agg" }], groupBy: [{ field: "account" }] }, /cannot be totalled|no field/);
  await inj("a sort that is not a column", { dataset: "gl_lines", columns: [{ field: "net", id: "n" }], sort: { by: "1; drop table x", dir: "asc" } }, /sort by one of/);
  await inj("a date that is not a date", { dataset: "gl_lines", columns: [{ field: "net" }], filters: [{ field: "posted_on", op: "after", value: "2026-01-01' or '1'='1" }] }, /not a date/);
  await inj("an amount that is not an amount", { dataset: "gl_lines", columns: [{ field: "net" }], filters: [{ field: "net", op: "gt", value: "1 or 1=1" }] }, /not an amount/);
  t.ok("a quote in a text value is just a value: nothing matches", await countOf({ dataset: "gl_lines", columns: [{ id: "n", field: "net" }],
    filters: [{ field: "account_name", op: "eq", value: "x' or '1'='1" }] }) === 0);
  t.ok("the report tables are still there after all that", await direct(`select count(*) n from report where entity_id = $1`) > 0);

  // ------------------------------------------------------------ roles
  await t.throws("roles: an A/P clerk cannot run payroll", () => runAs(t, PEOPLE.CLERK, (c, roles) => rep.run(c, ENTITY, roles,
    { dataset: "payroll", columns: [{ field: "gross" }] })), /needs one of: controller, hr/);
  await t.throws("roles: sales cannot run the general ledger", () => runAs(t, MARIA, (c, roles) => rep.run(c, ENTITY, roles,
    { dataset: "gl_lines", columns: [{ field: "net" }] })), /needs one of/);
  t.ok("roles: sales can run sales lines", (await runAs(t, MARIA, (c, roles) => rep.run(c, ENTITY, roles, SL([])))).count > 0);
  t.ok("roles: the controller can run the general ledger", (await runAs(t, PEOPLE.CONTROLLER, (c, roles) => rep.run(c, ENTITY, roles,
    { dataset: "gl_lines", columns: [{ id: "n", field: "net" }] }))).count > 0);
  await t.throws("roles: sales cannot save a payroll report", () => r.post("/reports", MARIA, { name: "Pay", definition: { dataset: "payroll", columns: [{ field: "gross" }] } }), /needs one of/);
  await t.throws("roles: running a saved payroll report as sales is refused", () => r.post("/reports/run", MARIA, { reportId: starterOf("payroll_store").id }), /needs one of/);
  const mariaList = await read(t, async (c) => rep.listReports(c, ENTITY, MARIA, await rep.rolesFor(c, ENTITY, MARIA)));
  t.ok("roles: sales does not see payroll, GL or A/R reports in the list", !mariaList.some((x) => ["payroll", "ar_open", "vendor_spend"].includes(x.dataset))
    && mariaList.some((x) => x.dataset === "sales_posted"), mariaList.map((x) => x.dataset).join(","));
  const mariaCat = rep.catalogFor(await read(t, (c) => rep.rolesFor(c, ENTITY, MARIA)), ["pos", "shop", "ar", "catalog", "inventory", "purchasing", "fleet", "workforce"]);
  t.ok("roles: the catalog offers sales no payroll, GL or bills", !mariaCat.some((d) => ["payroll", "gl_lines", "vendor_spend", "pnl_lines"].includes(d.id)));
  t.ok("roles: the dispatcher sees deliveries but not sales lines", (await runAs(t, RAY, (c, roles) => rep.run(c, ENTITY, roles,
    { dataset: "deliveries", columns: [{ id: "n", field: "number" }] }))).count > 0);
  await t.throws("roles: the dispatcher cannot run sales lines", () => runAs(t, RAY, (c, roles) => rep.run(c, ENTITY, roles, SL([]))), /needs one of/);

  // ------------------------------------------------------------ isolation
  const demoNames = await read(t, async (c) => (await q<{ name: string }>(c, `select name from location where entity_id = $1
    union select name from customer where entity_id = $1 union select number from sales_order where entity_id = $1
    union select description from journal_entry where entity_id = $1`, [ENTITY])).map((x) => x.name));
  let leak = "";
  for (const ds of rep.DATASETS) {
    const res = await runAs(t, RIO_OWNER, (c, roles) => rep.run(c, RIO_ENTITY, roles,
      { dataset: ds.id, columns: ds.fields.filter((f) => f.id !== ds.entryField).map((f, i) => ({ id: `c${i}`, field: f.id })) }, { size: 200 }), RIO_ENTITY);
    for (const row of res.rows) for (const v of Object.values(row)) if (typeof v === "string" && demoNames.includes(v)) leak += `${ds.id}:${v} `;
  }
  t.ok("isolation: no demo-company name in any dataset run for Rio Freight", !leak, leak.slice(0, 200));
  const rioGl = await runAs(t, RIO_OWNER, (c, roles) => rep.run(c, RIO_ENTITY, roles, { dataset: "gl_lines", columns: [{ id: "n", field: "net" }] }, { size: 1 }), RIO_ENTITY);
  t.ok("isolation: Rio's GL dataset counts only Rio's lines", rioGl.count === await read(t, async (c) => Number((await q<{ n: string }>(c,
    `select count(*) n from journal_line jl join journal_entry je on je.id = jl.journal_entry_id where je.entity_id = $1`, [RIO_ENTITY]))[0].n)), String(rioGl.count));
  await t.throws("isolation: a demo report cannot be opened from Rio Freight", () => tx({ kind: "user", id: RIO_OWNER, label: "check" }, async (c) =>
    rep.getReport(c, RIO_ENTITY, starterOf("sales_store_month").id, RIO_OWNER, await rep.rolesFor(c, RIO_ENTITY, RIO_OWNER))), /no such report/);
  await t.throws("isolation: running a demo report by id from Rio Freight", () => asPerson(t, RIO_OWNER, async (c, co, a) => {
    const posts = new Map<string, (...x: unknown[]) => Promise<unknown>>();
    reportsModule.register({ coGet: () => {}, coPost: (tail: string, fn: never) => posts.set(tail, fn), publicRoute: () => {} } as never);
    return posts.get("/reports/run")!(c, co, a, { reportId: starterOf("sales_store_month").id }, ["", co.id]);
  }, RIO_ENTITY), /no such report/);
  t.ok("isolation: Rio's own report list has none of the demo's", await read(t, async (c) =>
    (await rep.listReports(c, RIO_ENTITY, RIO_OWNER, await rep.rolesFor(c, RIO_ENTITY, RIO_OWNER))).every((x) => !starters.some((s) => s.id === x.id))));

  // ------------------------------------------------------------ saved reports
  const def = { dataset: "sales_lines", columns: [{ id: "net", field: "net" }], groupBy: [{ field: "store" }] };
  const made = await r.post<{ id: string; version: number }>("/reports", MARIA, { name: "My store sales", folder: "Mine", definition: def });
  t.ok("save: a new report is version 1, private to its maker", made.version === 1);
  const ctl = async () => read(t, async (c) => rep.listReports(c, ENTITY, PEOPLE.CONTROLLER, await rep.rolesFor(c, ENTITY, PEOPLE.CONTROLLER)));
  t.ok("share: the controller cannot see Maria's private report", !(await ctl()).some((x) => x.id === made.id));
  await r.post(`/reports/:id`, MARIA, { shared: "company", version: 1 }, made.id);
  const seen = (await ctl()).find((x) => x.id === made.id);
  t.ok("share: shared with the company, the controller sees it but cannot edit or delete it", !!seen && !seen.canEdit && !seen.canDelete);
  await t.throws("edit: only the maker changes it", () => r.post(`/reports/:id`, PEOPLE.CONTROLLER, { name: "Mine now" }, made.id), /only the person who made/);
  await t.throws("delete: only the maker deletes it", () => r.post(`/reports/:id/delete`, PEOPLE.CONTROLLER, {}, made.id), /can delete this report/);
  const v3 = await r.post<{ version: number }>(`/reports/:id`, MARIA, { definition: { ...def, columns: [...def.columns, { id: "q", field: "qty" }] }, version: 2 }, made.id);
  t.ok("versions: each save is a new version", v3.version === 3);
  await t.throws("versions: saving over someone else's newer save is refused", () => r.post(`/reports/:id`, MARIA, { name: "Old", version: 2 }, made.id), /reopen it/);
  const vs = await read(t, async (c) => rep.versions(c, ENTITY, made.id, MARIA, await rep.rolesFor(c, ENTITY, MARIA)));
  t.ok("versions: all three kept, newest first", vs.length === 3 && vs[0].version === 3);
  await t.throws("versions: a saved version cannot be rewritten", () => tx({ kind: "user", id: MARIA, label: "check" }, (c) =>
    c.query(`update report_version set name = 'x' where report_id = $1`, [made.id])), /never changed/);
  await r.post(`/reports/:id`, MARIA, { shared: "roles", shareRoles: ["store_manager"] }, made.id);
  t.ok("share: shared with store managers only, the controller no longer sees it", !(await ctl()).some((x) => x.id === made.id));
  await t.throws("share: sharing with roles needs a role", () => r.post(`/reports/:id`, MARIA, { shared: "roles", shareRoles: [] }, made.id), /pick at least one role/);
  await r.post(`/reports/:id`, MARIA, { shared: "company" }, made.id);
  const dup = await r.post<{ id: string }>(`/reports/:id/duplicate`, PEOPLE.CONTROLLER, {}, made.id);
  const dupRow = (await ctl()).find((x) => x.id === dup.id);
  t.ok("duplicate: the controller's copy is theirs, private, editable", !!dupRow && dupRow.canEdit && dupRow.shared === "private" && dupRow.name === "Copy of My store sales");
  await r.post(`/reports/:id/pin`, PEOPLE.CONTROLLER, { on: true }, made.id);
  t.ok("pin: pinned to the controller's Home", (await read(t, async (c) => rep.pinned(c, ENTITY, PEOPLE.CONTROLLER, await rep.rolesFor(c, ENTITY, PEOPLE.CONTROLLER)))).some((x) => x.id === made.id));
  t.ok("pin: not on Maria's", !(await read(t, async (c) => rep.pinned(c, ENTITY, MARIA, await rep.rolesFor(c, ENTITY, MARIA)))).some((x) => x.id === made.id));
  await t.throws("starter: a controller cannot remove a starter", () => r.post(`/reports/:id/delete`, PEOPLE.CONTROLLER, {}, starterOf("top_products").id), /owner can remove/);
  t.ok("starter: the controller may edit a starter", (await ctl()).find((x) => x.id === starterOf("top_products").id)?.canEdit === true);

  // ------------------------------------------------------------ schedule and snapshot
  const sch = await r.post<{ nextRunOn: string }>(`/reports/:id/schedule`, MARIA, { every: "weekly", weekday: 1, to: [PEOPLE.CONTROLLER, MARIA] }, made.id);
  t.ok("schedule: weekly on Mondays, next run after today", new Date(sch.nextRunOn + "T00:00:00Z").getUTCDay() === 1 && sch.nextRunOn > today, sch.nextRunOn);
  await t.throws("schedule: only to people in this company", () => r.post(`/reports/:id/schedule`, MARIA, { every: "daily", to: [RIO_OWNER] }, made.id), /only to people in this company/);
  const due = await rep.runDueReports(t.pool as never, tx, sch.nextRunOn, ENTITY);
  const mine = due.runs.find((x) => x.name === "My store sales");
  t.ok("schedule: the report runs when its day comes", !!mine && mine.ok, JSON.stringify(due.runs));
  const snap = await read(t, async (c) => (await q<{ row_count: number; trigger: string; status: string; recipients: string[]; next: string }>(c, `
    select s.row_count, s.trigger, d.status, d.recipients, r.next_run_on::text next from report_snapshot s
      join report_delivery d on d.snapshot_id = s.id join report r on r.id = s.report_id
     where s.entity_id = $1 and s.report_id = $2 order by s.run_at desc limit 1`, [ENTITY, made.id]))[0]);
  t.ok("schedule: the snapshot is kept and the email is prepared for both people", !!snap && snap.trigger === "schedule" && snap.row_count > 0
    && snap.status === "prepared" && snap.recipients.length === 2, JSON.stringify(snap));
  t.ok("schedule: the next run moves a week on", snap?.next === rep.nextRun({ every: "weekly", weekday: 1, to: [] }, sch.nextRunOn));
  const again = await rep.runDueReports(t.pool as never, tx, sch.nextRunOn, ENTITY);
  t.ok("schedule: it does not run twice for the same day", !again.runs.some((x) => x.name === "My store sales"));
  const manual = await r.post<{ snapshotId: string; rows: number }>(`/reports/:id/snapshot`, PEOPLE.CONTROLLER, {}, made.id);
  t.ok("snapshot: run by hand and kept", manual.rows > 0);
  await r.post(`/reports/:id/schedule`, MARIA, { every: "daily", to: [] }, made.id);
  await read(t, (c) => c.query(`delete from role_grant where app_user_id = $1 and entity_id = $2 and role = 'sales'`, [MARIA, ENTITY]));
  const lost = await rep.runDueReports(t.pool as never, tx, "2099-01-01", ENTITY);
  await read(t, (c) => c.query(`insert into role_grant (app_user_id, entity_id, role) values ($1, $2, 'sales')`, [MARIA, ENTITY]));
  t.ok("schedule: whoever scheduled it losing the role stops the data, and the snapshot says why", lost.runs.some((x) => x.name === "My store sales" && !x.ok && /needs one of/.test(x.note)),
    JSON.stringify(lost.runs.filter((x) => x.name === "My store sales")));
  await r.post(`/reports/:id/schedule`, MARIA, { every: null }, made.id);

  const timeout = await tx({ kind: "user", id: PEOPLE.STEVE, label: "check" }, async (c) => {
    await rep.run(c, ENTITY, await rep.rolesFor(c, ENTITY, PEOPLE.STEVE), SL([]), { size: 1 });
    return (await c.query("show statement_timeout")).rows[0].statement_timeout;
  });
  t.ok("every run carries a 10 second statement timeout", timeout === "10s", timeout);

  // ------------------------------------------------------------ delete and audit
  await r.post(`/reports/:id/delete`, MARIA, {}, made.id);
  await t.throws("delete: a deleted report is gone from view", () => read(t, async (c) => rep.getReport(c, ENTITY, made.id, MARIA, await rep.rolesFor(c, ENTITY, MARIA))), /no such report/);
  const kept = await direct(`select count(*) n from report where entity_id = $1 and id = $2 and status = 'deleted'`, [made.id]);
  const auditRows = await read(t, async (c) => (await q<{ action: string }>(c, `select action from audit_event where entity_id = $1 and table_name = 'report' and row_id = $2`, [ENTITY, made.id])).map((x) => x.action));
  t.ok("delete: the row is kept, marked deleted", kept === 1);
  t.ok("audit: create, edits and delete are recorded", auditRows.includes("insert") && auditRows.filter((x) => x === "update").length >= 4 && auditRows.includes("delete"), auditRows.join(","));

  // ------------------------------------------------------------ export
  const fake: rep.RunResult = { dataset: "x", mode: "detail", offset: 0, size: 3, count: 3, capped: false, chart: null, entryField: false, asOf: today, filters: [],
    columns: [{ key: "a", label: "Name, full", type: "text", align: "left", role: "detail" }, { key: "m", label: "Amount", type: "money", align: "right", role: "detail" },
      { key: "p", label: "Share", type: "percent", align: "right", role: "detail" }],
    rows: [{ a: 'Smith, "JJ"', m: "-1234", p: "0.25" }, { a: "=HYPERLINK(\"http://x\")", m: "5", p: null }, { a: "two\nlines", m: "100000", p: "1" }],
    total: { a: null, m: "98771", p: "1" } };
  const csv = rep.toCsv(fake);
  t.ok("CSV: commas, quotes and line breaks quoted; header too", csv.startsWith('"Name, full",Amount,Share %\r\n"Smith, ""JJ""",-12.34,25.00\r\n'), JSON.stringify(csv.slice(0, 80)));
  t.ok("CSV: a formula in text is defused with an apostrophe", csv.includes(`"'=HYPERLINK(""http://x"")",0.05,`));
  t.ok("CSV: a line break stays inside its quotes, money is exact", csv.includes('"two\nlines",1000.00,100.00') && csv.endsWith("Total,987.71,100.00\r\n"));
  t.ok("CSV: amounts are exact cents", rep.dollars("5") === "0.05" && rep.dollars("-100") === "-1.00" && rep.dollars("123456789012345") === "1234567890123.45");
  const exp = await r.post<{ filename: string; csv: string; rows: number }>("/reports/export", PEOPLE.STEVE, { reportId: starterOf("receipts_tender_day").id, params: { 0: { value: "last_365" } } });
  t.ok("export: a saved report comes out as CSV with its subtotals and total", exp.filename.endsWith(".csv") && exp.csv.split("\r\n")[0].startsWith("Received on (day),Tender")
    && exp.csv.includes("Subtotal") && /\r\nTotal,/.test(exp.csv), exp.csv.slice(0, 120));
  const xl = await r.post<{ filename: string; base64: string }>("/reports/export", PEOPLE.STEVE, { reportId: starterOf("receipts_tender_day").id, params: { 0: { value: "last_365" } }, format: "xlsx" });
  const buf = Buffer.from(xl.base64, "base64");
  t.ok("export: an Excel file is a zip with the sheet in it", xl.filename.endsWith(".xlsx") && buf.subarray(0, 4).toString("hex") === "504b0304"
    && buf.includes(Buffer.from("xl/worksheets/sheet1.xml")) && buf.readUInt32LE(buf.length - 22) === 0x06054b50);
  await t.throws("export: refused for a role that cannot run it", () => r.post("/reports/export", PEOPLE.CLERK, { reportId: starterOf("payroll_store").id }), /needs one of/);
}
