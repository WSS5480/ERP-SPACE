// Chart of accounts and vendor categories: add, edit and the refusals that
// keep the books honest (code and type fixed once posted, never deleted,
// switched off only when nothing points at it, inactive accounts take no
// postings), which companies use an account, CSV preview → apply, export,
// roles, isolation; and vendor categories: the seeded pick list, merchandise
// vendors only in Catalog and Buying, new vendors coded from the category.
import { type T, ENTITY, RIO_ENTITY, PEOPLE } from "./harness.ts";
import { tx, q, type Client } from "../../packages/core/db.ts";
import { module as chartModule } from "../../server/modules/chart.ts";
import { module as catalogModule } from "../../server/modules/catalog.ts";
import { module as purchasingModule } from "../../server/modules/purchasing.ts";
import { addVendor } from "../../server/actions.ts";
import { formOptions, vendors as payablesVendors } from "../../server/views.ts";
import { post as postJournal } from "../../packages/core/posting.ts";
import { routes, asPerson, companyOf, V } from "./catalog.ts";

const VALLEY = "66666666-0000-0000-0000-000000000001";     // utilities
const FUEL = "66666666-0000-0000-0000-000000000002";       // fleet
const BRIDGEWAY = "66666666-0000-0000-0000-000000000003";  // services
const MERIDIAN = "66666666-0000-0000-0000-000000000004";   // merchandise (rental goods)
const today = () => new Date().toISOString().slice(0, 10);

type Acct = { id: string; code: string; name: string; account_type: string; normal_balance: string; is_postable: boolean; active: boolean;
  used_here: boolean; posted: boolean; parent_code: string | null; balance_minor: string; packs: string[] };

const read = async <R>(t: T, fn: (c: Client) => Promise<R>): Promise<R> => {
  const c = await t.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};

export async function run(t: T) {
  const r = routes(t, chartModule);
  const co = await companyOf(t);
  const chart = () => r.get<{ accounts: Acct[]; companies: { id: string; name: string }[] }>("/chart");
  const byCode = async (code: string) => (await chart()).accounts.find((a) => a.code === code)!;

  // ---------------------------------------------------------------- list
  const c0 = await chart();
  t.ok("chart: lists the client's accounts with type, normal balance and this company's use", c0.accounts.length >= 50
    && c0.accounts.some((a) => a.code === "1010" && a.account_type === "asset" && a.normal_balance === "D" && a.used_here));
  t.ok("chart: shows which accounts the ERP posts to by code", (c0.accounts.find((a) => a.code === "4000")?.packs.length ?? 0) > 0);
  t.ok("chart: shows the company's balance on posted accounts", c0.accounts.some((a) => a.posted && Number(a.balance_minor) !== 0));

  // ---------------------------------------------------------------- add
  await t.throws("roles: an AP clerk cannot add accounts", () => r.post("/chart/accounts", PEOPLE.CLERK, { code: "6415", name: "Telephone", type: "expense" }), /controller/i);
  const hdr = (await r.post<{ id: string }>("/chart/accounts", PEOPLE.CONTROLLER, { code: "6405", name: "Occupancy costs", type: "expense", postable: false })).id;
  const tel = (await r.post<{ id: string }>("/chart/accounts", PEOPLE.CONTROLLER, { code: "6415", name: "Telephone and internet", type: "expense", parent: "6405" })).id;
  const a1 = await byCode("6415");
  t.ok("add: a new expense account defaults to a debit balance, rolls up under its header and is on for this company",
    a1.id === tel && a1.normal_balance === "D" && a1.parent_code === "6405" && a1.is_postable && a1.used_here);
  const liab = (await r.post<{ id: string }>("/chart/accounts", PEOPLE.STEVE, { code: "2400", name: "Accrued rent", type: "liability" })).id;
  t.ok("add: a liability defaults to a credit balance (the owner may add too)", (await byCode("2400")).normal_balance === "C" && !!liab);
  await t.throws("add: a code already in the chart is refused", () => r.post("/chart/accounts", PEOPLE.CONTROLLER, { code: "6410", name: "Utilities 2", type: "expense" }), /already exists/);
  await t.throws("add: a code with spaces or symbols is refused", () => r.post("/chart/accounts", PEOPLE.CONTROLLER, { code: "64 15!", name: "X", type: "expense" }), /letters, digits/);
  await t.throws("add: a parent of another type is refused", () => r.post("/chart/accounts", PEOPLE.CONTROLLER, { code: "2410", name: "X", type: "liability", parent: "6405" }), /type|header/i);
  await t.throws("add: a postable account cannot be a rollup group", () => r.post("/chart/accounts", PEOPLE.CONTROLLER, { code: "6416", name: "X", type: "expense", parent: "6410" }), /header/i);
  await t.throws("add: an unknown type is refused", () => r.post("/chart/accounts", PEOPLE.CONTROLLER, { code: "6417", name: "X", type: "costs" }), /type/i);

  // ---------------------------------------------------------------- edit
  const ch = await r.post<{ changed: string[] }>("/chart/accounts/:id", PEOPLE.CONTROLLER, { name: "Phone and internet", description: "Lines and broadband", code: "6420" }, tel);
  t.ok("edit: name, description and (with no postings) code change", ch.changed.includes("name") && ch.changed.includes("code") && (await byCode("6420"))?.name === "Phone and internet");
  const audited = await read(t, (c) => q<{ n: string }>(c, `select count(*) n from audit_event where entity_id = $1 and table_name = 'gl_account' and row_id = $2`, [ENTITY, tel]));
  t.ok("edit: every change is in the audit trail", Number(audited[0].n) >= 2, audited[0].n);
  await t.throws("edit: the code of an account the ERP posts to by code is refused", () => r.post("/chart/accounts/:id", PEOPLE.CONTROLLER, { code: "4001" }, c0.accounts.find((a) => a.code === "4000")!.id), /posts to 4000 by its code|has postings/);

  // post to it: code and type then stay
  await asPerson(t, PEOPLE.CONTROLLER, (c, _co, a) => postJournal(c, { tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "user", id: a.personId, label: "check" } },
    { date: today(), sourceType: "manual", sourceId: null, description: "phone bill (check)", lines: [{ code: "6420", debit: 12_500n }, { code: "1010", credit: 12_500n }] }));
  await t.throws("edit: once posted, a code change is refused and says what to do instead", () => r.post("/chart/accounts/:id", PEOPLE.CONTROLLER, { code: "6421" }, tel),
    /has postings.*make a new account and move future postings/);
  await t.throws("edit: once posted, a type change is refused", () => r.post("/chart/accounts/:id", PEOPLE.CONTROLLER, { type: "asset" }, tel), /has postings, so its type stays/);
  await t.throws("database: the code of a posted account cannot be changed even behind the app",
    () => tx({ kind: "system", label: "check" }, (c) => c.query(`update gl_account set code = '6499' where id = $1`, [tel])), /has postings/);
  await t.throws("database: accounts are never deleted", () => tx({ kind: "system", label: "check" }, (c) => c.query(`delete from gl_account where id = $1`, [liab])), /never deleted/);
  await t.throws("edit: once posted, it cannot become a header", () => r.post("/chart/accounts/:id", PEOPLE.CONTROLLER, { postable: false }, tel), /stays postable/);
  const moved = await r.post<{ changed: string[] }>("/chart/accounts/:id", PEOPLE.CONTROLLER, { parent: null }, tel);
  t.ok("edit: a posted account can still move between rollup groups", moved.changed.includes("parent_id"));

  // ---------------------------------------------------------------- deactivate
  await t.throws("switch off: refused while the company carries a balance, saying so", () => r.post("/chart/accounts/:id", PEOPLE.CONTROLLER, { active: false, reason: "check" }, tel),
    /cannot be switched off yet: .*balance/);
  await asPerson(t, PEOPLE.CONTROLLER, (c, _co, a) => postJournal(c, { tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "user", id: a.personId, label: "check" } },
    { date: today(), sourceType: "manual", sourceId: null, description: "phone bill reversed (check)", lines: [{ code: "1010", debit: 12_500n }, { code: "6420", credit: 12_500n }] }));
  const u6410 = c0.accounts.find((a) => a.code === "6410")!;
  await t.throws("switch off: refused while a vendor codes to it, naming the vendor", () => r.post("/chart/accounts/:id", PEOPLE.CONTROLLER, { active: false }, u6410.id), /Valley Power and Light/);
  await t.throws("switch off: refused while the ERP posts to it by code, naming the setup", () => r.post("/chart/accounts/:id", PEOPLE.CONTROLLER, { active: false }, c0.accounts.find((a) => a.code === "1300")!.id),
    /posts to 1300 by its code/);
  const off = await r.post<{ changed: string[] }>("/chart/accounts/:id", PEOPLE.CONTROLLER, { active: false, reason: "moved to 6430" }, tel);
  t.ok("switch off: allowed once the balance is zero and nothing points at it", off.changed.includes("active") && !(await byCode("6420")).active);
  await t.throws("database: an inactive account takes no postings", () => asPerson(t, PEOPLE.CONTROLLER, (c, _co, a) => postJournal(c,
    { tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "user", id: a.personId, label: "check" } },
    { date: today(), sourceType: "manual", sourceId: null, description: "late phone bill (check)", lines: [{ code: "6420", debit: 100n }, { code: "1010", credit: 100n }] })), /inactive/);
  await t.throws("database: a header takes no postings", () => asPerson(t, PEOPLE.CONTROLLER, (c, _co, a) => postJournal(c,
    { tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "user", id: a.personId, label: "check" } },
    { date: today(), sourceType: "manual", sourceId: null, description: "to a header (check)", lines: [{ code: "6405", debit: 100n }, { code: "1010", credit: 100n }] })), /header|postable|takes no postings/i);
  const opts = await read(t, (c) => formOptions(c, co));
  t.ok("pickers: an inactive account drops out of the account pickers", !(opts.accounts as { code: string }[]).some((a) => a.code === "6420"));
  t.ok("switch off: a posted account keeps its history", (await byCode("6420")).posted);
  const on = await r.post<{ changed: string[] }>("/chart/accounts/:id", PEOPLE.CONTROLLER, { active: true }, tel);
  t.ok("switch back on: allowed", on.changed.includes("active"));

  // ---------------------------------------------------------------- companies
  const none = await r.post<{ on: number; off: number }>("/chart/accounts/:id/companies", PEOPLE.CONTROLLER, { companies: [] }, liab);
  t.ok("companies: a company with no balance can stop using an account", none.off === 1 && !(await byCode("2400")).used_here);
  const back = await r.post<{ on: number; off: number }>("/chart/accounts/:id/companies", PEOPLE.CONTROLLER, { companies: [ENTITY] }, liab);
  t.ok("companies: and start again", back.on === 1 && (await byCode("2400")).used_here);
  const bal = c0.accounts.find((a) => a.code === "1300")!;
  await t.throws("companies: a company carrying a balance keeps the account", () => r.post("/chart/accounts/:id/companies", PEOPLE.CONTROLLER, { companies: [] }, bal.id), /still carries a balance/);
  await t.throws("companies: another client's company cannot be switched on", () => r.post("/chart/accounts/:id/companies", PEOPLE.CONTROLLER, { companies: [RIO_ENTITY] }, liab), /not one of this client/);

  // ---------------------------------------------------------------- CSV
  const exp = await r.get<{ filename: string; csv: string }>("/chart/export");
  const lines = exp.csv.trim().split(/\r?\n/);
  t.ok("export: a heading line and one row per account", lines[0] === "code,name,type,normal_balance,parent,postable,active,description,companies" && lines.length === (await chart()).accounts.length + 1);
  const same = await r.post<{ runId: string; add: number; update: number; same: number; refuse: number }>("/chart/import/preview", PEOPLE.CONTROLLER, { csv: exp.csv, filename: "chart.csv" });
  t.ok("import: the exported file read back changes nothing", same.add === 0 && same.update === 0 && same.refuse === 0 && same.same === lines.length - 1, JSON.stringify({ ...same, sample: undefined }));
  const csv = [
    "code,name,type,normal_balance,parent,postable,active,companies",
    "6430,Telephone,expense,,6440,yes,yes,Demo Furniture Co, LLC",   // parent defined further down; company with a comma is quoted below
    "6440,Communications,expense,,,no,yes,",
    "6410,Utilities and water,expense,D,,yes,yes,",                     // rename
    "6420,Phone and internet,asset,,,yes,yes,",                         // type change on a posted account
    "1300,Merchandise inventory,asset,,,yes,yes,",                      // unchanged
    "64 50,Bad code,expense,,,yes,yes,",
    "6460,Rent of trucks,expens,,,yes,yes,",                            // bad type
    "6470,Misc,expense,,6410,yes,yes,",                                 // parent is postable
    "6430,Telephone again,expense,,,yes,yes,",                          // duplicate in the file
  ].map((l, i) => (i === 1 ? l.replace("Demo Furniture Co, LLC", "\"Demo Furniture Co, LLC\"") : l)).join("\n");
  const pv = await r.post<{ runId: string; add: number; update: number; same: number; refuse: number }>("/chart/import/preview", PEOPLE.CONTROLLER, { csv, filename: "new.csv" });
  const rows = (await r.get<{ rows: { row_no: number; code: string; action: string; message: string | null }[] }>("/chart/import/:id", "", pv.runId)).rows;
  const row = (n: number) => rows.find((x) => x.row_no === n)!;
  t.ok("import preview: adds, updates, unchanged and refused counted", pv.add === 2 && pv.update === 1 && pv.same === 1 && pv.refuse === 5, JSON.stringify({ ...pv, sample: undefined }));
  t.ok("import preview: a parent defined further down the file counts", row(2).action === "add" && row(3).action === "add");
  t.ok("import preview: each refusal says why in plain words", /has postings/.test(row(5).message ?? "") && /letters, digits/.test(row(7).message ?? "")
    && /type/.test(row(8).message ?? "") && /rollup parent|header/.test(row(9).message ?? "") && /earlier row/.test(row(10).message ?? ""), JSON.stringify(rows.filter((x) => x.action === "refuse").map((x) => x.message)));
  t.ok("import preview: nothing changes before apply", !(await chart()).accounts.some((a) => a.code === "6430") && (await byCode("6410")).name === "Utilities");
  await t.throws("roles: an AP clerk cannot apply an import", () => r.post("/chart/import/:id/apply", PEOPLE.CLERK, {}, pv.runId), /controller/i);
  const ap = await r.post<{ added: number; updated: number; unchanged: number; refused: number }>("/chart/import/:id/apply", PEOPLE.CONTROLLER, {}, pv.runId);
  const after = await chart();
  const tphone = after.accounts.find((a) => a.code === "6430");
  t.ok("import apply: added and updated as previewed, header first", ap.added === 2 && ap.updated === 1 && ap.refused === 5 && tphone?.parent_code === "6440"
    && !after.accounts.find((a) => a.code === "6440")!.is_postable && after.accounts.find((a) => a.code === "6410")!.name === "Utilities and water", JSON.stringify(ap));
  t.ok("import apply: company named in the file uses the account", !!tphone?.used_here);
  await t.throws("import apply: a run applies once", () => r.post("/chart/import/:id/apply", PEOPLE.CONTROLLER, {}, pv.runId), /already applied/);
  const again = await r.post<{ add: number; update: number; same: number }>("/chart/import/preview", PEOPLE.CONTROLLER, { csv, filename: "new.csv" });
  t.ok("import: the same file again adds and updates nothing", again.add === 0 && again.update === 0 && again.same === 4, JSON.stringify({ ...again, sample: undefined }));
  // a child header above its parent header: preview and apply agree
  const order = "code,name,type,postable,parent\n6492,Store upkeep detail,expense,no,6491\n6491,Store upkeep,expense,no,\n";
  const opv = await r.post<{ runId: string; add: number; refuse: number }>("/chart/import/preview", PEOPLE.CONTROLLER, { csv: order });
  const oap = await r.post<{ added: number; refused: number }>("/chart/import/:id/apply", PEOPLE.CONTROLLER, {}, opv.runId);
  t.ok("import: a parent further down the file is added first, so apply matches the preview", opv.add === 2 && oap.added === 2 && oap.refused === 0, JSON.stringify(oap));
  const loop = await r.post<{ update: number; refuse: number }>("/chart/import/preview", PEOPLE.CONTROLLER, { csv: "code,parent\n6491,6492\n" });
  t.ok("import: a rollup loop is refused in the preview", loop.refuse === 1 && loop.update === 0, JSON.stringify({ ...loop, sample: undefined }));
  const qb = await r.post<{ refuse: number; same: number }>("/chart/import/preview", PEOPLE.CONTROLLER, { csv: "Account,Name,Type,Balance\n6491,Store upkeep,Expense,1234.00\n" });
  t.ok("import: a Balance column (QuickBooks, Xero) is not read as normal balance", qb.refuse === 0, JSON.stringify({ ...qb, sample: undefined }));
  await t.throws("import: a file with no code column is refused", () => r.post("/chart/import/preview", PEOPLE.CONTROLLER, { csv: "name,type\nX,expense" }), /code column/);

  // ---------------------------------------------------------------- isolation
  const rioChart = await r.get<{ accounts: Acct[] }>("/chart", "", undefined, RIO_ENTITY);
  t.ok("isolation: another client's chart does not show these accounts", !rioChart.accounts.some((a) => a.code === "6430" || a.code === "6405"));
  t.ok("isolation: another client cannot open this client's account", await r.get("/chart/accounts/:id", "", tel, RIO_ENTITY).then(() => false, (e) => /no such account|not in this/.test((e as Error).message)));
  t.ok("isolation: another company cannot read this company's import", (await r.get("/chart/import/:id", "", pv.runId, RIO_ENTITY)) === null);

  // ================================================================ vendor categories
  const cats = await r.get<{ categories: { code: string; label: string; is_merchandise: boolean; gl_code: string | null; vendors: string }[] }>("/vendor-categories");
  const codes = cats.categories.map((c) => c.code);
  t.ok("categories: the client starts with the twelve kinds", ["merchandise", "utilities", "rent_lease", "services", "freight", "insurance", "taxes", "payroll_benefits",
    "technology", "marketing", "fleet", "other"].every((k) => codes.includes(k)), codes.join(","));
  t.ok("categories: only merchandise sells goods; it codes to 2050, utilities to 6410",
    cats.categories.filter((c) => c.is_merchandise).map((c) => c.code).join() === "merchandise"
    && cats.categories.find((c) => c.code === "merchandise")!.gl_code === "2050" && cats.categories.find((c) => c.code === "utilities")!.gl_code === "6410");
  const pv2 = await read(t, (c) => payablesVendors(c, co)) as { id: string; category: string }[];
  const catOf = (id: string) => pv2.find((v) => v.id === id)?.category;
  t.ok("seeded vendors: utilities, fleet and services vendors are not merchandise",
    catOf(VALLEY) === "utilities" && catOf(FUEL) === "fleet" && catOf(BRIDGEWAY) === "services", JSON.stringify(pv2.map((v) => v.category)));
  t.ok("seeded vendors: Ashley, Coaster, Global, Custom Upholstery and Meridian are merchandise",
    [V.ASHLEY, V.COASTER, V.GLOBAL, V.CUW, MERIDIAN].every((id) => catOf(id) === "merchandise"));

  const cr = routes(t, catalogModule), pr = routes(t, purchasingModule);
  const catVendors = (await cr.get<{ vendors: { id: string }[] }>("/catalog/vendors")).vendors.map((v) => v.id);
  t.ok("Catalog → Vendors: merchandise vendors only, never the utility", catVendors.includes(V.ASHLEY) && !catVendors.includes(VALLEY) && !catVendors.includes(FUEL) && !catVendors.includes(BRIDGEWAY));
  const form = (await cr.get<{ vendors: { id: string }[] }>("/catalog/form")).vendors.map((v) => v.id);
  t.ok("product form: the vendor picker has no utilities", form.includes(V.ASHLEY) && !form.includes(VALLEY));
  const of = (await pr.get<{ vendors: { id: string }[] }>("/purchasing/order-form")).vendors.map((v) => v.id);
  t.ok("Buying order form: merchandise vendors only", of.length > 0 && !of.includes(VALLEY) && !of.includes(FUEL));
  t.ok("vendor API setup: no feeds page for a utility", (await cr.get("/catalog/vendors/:id/feeds", "", VALLEY)) === null);
  await t.throws("vendor facts: refused for a utility vendor", () => cr.post("/catalog/vendors/:id", PEOPLE.STEVE, { leadDays: 10 }, VALLEY), /merchandise vendors/);

  // new vendors: category asked, and its account is the default
  await t.throws("new vendor: the category is required", () => asPerson(t, PEOPLE.CONTROLLER, (c, co2, a) => addVendor(c, co2, a, { name: "Lakeside Water Co" })), /category/);
  const lw = await asPerson(t, PEOPLE.CONTROLLER, (c, co2, a) => addVendor(c, co2, a, { name: "Lakeside Water Co", category: "utilities" })) as { id: string };
  const lwRow = await read(t, (c) => q<{ code: string; cat: string }>(c, `select g.code, vc.code cat from vendor_entity ve join vendor v on v.id = ve.vendor_id
     left join gl_account g on g.id = ve.default_gl_account_id left join vendor_category vc on vc.id = v.category_id where ve.entity_id = $1 and ve.vendor_id = $2`, [ENTITY, lw.id]));
  t.ok("new vendor: a utility codes to the utilities account by default", lwRow[0]?.code === "6410" && lwRow[0]?.cat === "utilities", JSON.stringify(lwRow));
  t.ok("new vendor: a utility never shows in Catalog", !(await cr.get<{ vendors: { id: string }[] }>("/catalog/vendors")).vendors.some((v) => v.id === lw.id));
  await t.throws("new vendor: an unknown category is refused", () => asPerson(t, PEOPLE.CONTROLLER, (c, co2, a) => addVendor(c, co2, a, { name: "Somebody", category: "widgets" })), /categor/);

  // a vendor's category: every company, or this one only
  await t.throws("roles: a store manager cannot set a vendor's category", () => r.post("/vendors/:id/category", PEOPLE.MANAGER, { category: "merchandise" }, BRIDGEWAY), /controller|clerk|buyer/i);
  await r.post("/vendors/:id/category", PEOPLE.CLERK, { category: "merchandise", thisCompanyOnly: true }, BRIDGEWAY);
  const bw = (await read(t, (c) => payablesVendors(c, co)) as { id: string; category: string; category_here: boolean }[]).find((v) => v.id === BRIDGEWAY)!;
  t.ok("vendor category: a per-company override wins here", bw.category === "merchandise" && bw.category_here);
  t.ok("vendor category: and puts it in Catalog for this company", (await cr.get<{ vendors: { id: string }[] }>("/catalog/vendors")).vendors.some((v) => v.id === BRIDGEWAY));
  await r.post("/vendors/:id/category", PEOPLE.CLERK, { category: null, thisCompanyOnly: true }, BRIDGEWAY);
  t.ok("vendor category: clearing the override falls back to the client's category", !(await cr.get<{ vendors: { id: string }[] }>("/catalog/vendors")).vendors.some((v) => v.id === BRIDGEWAY));
  await t.throws("isolation: a vendor not set up for the company is refused",
    () => r.post("/vendors/:id/category", PEOPLE.STEVE, { category: "other" }, "66666666-0000-0000-0000-0000000000ff"), /not set up for this company/);

  // the pick list itself
  await t.throws("roles: an AP clerk cannot change the categories", () => r.post("/vendor-categories", PEOPLE.CLERK, { label: "Cleaning" }), /controller/i);
  const cl = (await r.post<{ id: string }>("/vendor-categories", PEOPLE.CONTROLLER, { label: "Cleaning and janitorial", defaultGl: "6200" })).id;
  const cats2 = (await r.get<{ categories: { id: string; code: string; gl_code: string | null }[] }>("/vendor-categories")).categories;
  t.ok("categories: a new one gets a code from its name and its default account", cats2.some((c) => c.id === cl && c.code === "cleaning_and_janitorial" && c.gl_code === "6200"), JSON.stringify(cats2.find((c) => c.id === cl)));
  await t.throws("categories: one with vendors cannot be retired", () => r.post("/vendor-categories", PEOPLE.CONTROLLER, { id: (cats2.find((c) => c.code === "utilities")!).id, label: "Utilities", active: false }), /vendor/);
  await t.throws("categories: a default account that is a header is refused", () => r.post("/vendor-categories", PEOPLE.CONTROLLER, { id: cl, label: "Cleaning and janitorial", defaultGl: "6440" }), /header|postable/i);
  await t.throws("categories: merchandise stays merchandise", () => r.post("/vendor-categories", PEOPLE.CONTROLLER, { id: (cats2.find((c) => c.code === "merchandise")!).id, label: "Merchandise", isMerchandise: false }), /merchandise/);
  const rioCats = await r.get<{ categories: { id: string }[] }>("/vendor-categories", "", undefined, RIO_ENTITY);
  t.ok("isolation: the other client has its own categories", rioCats.categories.length >= 12 && !rioCats.categories.some((c) => c.id === cl));
}
