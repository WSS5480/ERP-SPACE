// chart module -- see docs/MODULES.md for the contract.
// Books → Chart of accounts (add, edit, regroup, per-company use,
// deactivate, CSV import and export) and vendor categories (the pick list,
// and setting a vendor's category for every company or one).
import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { ModuleError, need, requireRole, requireRoleEverywhere, str, uuid } from "./kit.ts";
import { scopeOf } from "../actions.ts";
import { q } from "../../packages/core/db.ts";
import * as chart from "../../packages/core/chart.ts";
import * as cats from "../../packages/core/vendor_categories.ts";

const ID = "([0-9a-fA-F-]{36})";
const BOOKS = ["controller"];                    // owner passes every check
const PAYABLES = ["controller", "ap_clerk", "buyer"];

async function refuse<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof chart.ChartError || e instanceof cats.VendorCategoryError) throw new ModuleError(e.message);
    throw e;
  }
}

const has = (b: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(b, k);
function accountIn(b: Record<string, unknown>): chart.AccountIn {
  const x: chart.AccountIn = {};
  if (has(b, "code")) x.code = str(b.code, 20);
  if (has(b, "name")) x.name = str(b.name, 120);
  if (has(b, "type")) x.type = str(b.type, 20);
  if (has(b, "normalBalance")) x.normalBalance = str(b.normalBalance, 1) || null;
  if (has(b, "parent")) x.parent = str(b.parent, 40) || null;
  if (has(b, "postable")) x.postable = b.postable === true || b.postable === "true";
  if (has(b, "description")) x.description = str(b.description, 500) || null;
  if (has(b, "active")) x.active = b.active === true || b.active === "true";
  if (Array.isArray(b.companies)) x.companies = (b.companies as unknown[]).map((v) => str(v, 120)).filter(Boolean);
  return x;
}

export const module: ErpModule = {
  id: "chart",
  register(kit) {
    const { coGet, coPost } = kit;
    const sc = (co: Company, a: Actor) => scopeOf(co, a);
    const readScope = (co: Company) => ({ tenantId: co.tenantId, entityId: co.id, actor: { kind: "user" as const, label: "read" } });

    // ---- chart of accounts
    coGet("/chart", (c: Client, co) => chart.listChart(c, readScope(co)));
    coGet(`/chart/accounts/${ID}`, (c, co, _u, m) => refuse(() => chart.accountDetail(c, readScope(co), m[2])));
    coGet("/chart/export", (c, co) => chart.exportCsv(c, readScope(co)));
    coGet(`/chart/import/${ID}`, async (c, co, url, m) => {
      const run = (await q(c, `select * from chart_import_run where id = $1 and entity_id = $2`, [m[2], co.id]))[0];
      if (!run) return null;
      const action = str(url.searchParams.get("action"), 10) || null;
      const rows = (await q(c, `select row_no, code, action, fields, changes, message from chart_import_row
                                    where run_id = $1 and entity_id = $2 and ($3::text is null or action = $3) order by row_no limit 500`, [m[2], co.id, action]));
      return { run, rows };
    });
    coPost("/chart/accounts", async (c, co, a, b) => {
      await requireRoleEverywhere(c, co, a, BOOKS, "adding to the chart of accounts");
      return { id: await refuse(() => chart.createAccount(c, sc(co, a), accountIn(b))) };
    });
    coPost(`/chart/accounts/${ID}`, async (c, co, a, b, m) => {
      await requireRoleEverywhere(c, co, a, BOOKS, "changing the chart of accounts");
      return { changed: await refuse(() => chart.updateAccount(c, sc(co, a), m[2], accountIn(b), str(b.reason, 300) || null)) };
    });
    coPost(`/chart/accounts/${ID}/companies`, async (c, co, a, b, m) => {
      await requireRoleEverywhere(c, co, a, BOOKS, "choosing which companies use an account");
      const ids = (Array.isArray(b.companies) ? b.companies : []).map(uuid).filter(Boolean) as string[];
      return refuse(() => chart.setCompanies(c, sc(co, a), m[2], ids));
    });
    coPost("/chart/import/preview", async (c, co, a, b) => {
      await requireRoleEverywhere(c, co, a, BOOKS, "importing a chart of accounts");
      need(typeof b.csv === "string" && b.csv.trim(), "choose the chart's CSV file first");
      need((b.csv as string).length <= 2_000_000, "the file is larger than 2 MB");
      return refuse(() => chart.previewCsv(c, sc(co, a), { csv: b.csv as string, filename: str(b.filename, 200) || null }));
    });
    coPost(`/chart/import/${ID}/apply`, async (c, co, a, _b, m) => {
      await requireRoleEverywhere(c, co, a, BOOKS, "importing a chart of accounts");
      return refuse(() => chart.applyCsv(c, sc(co, a), m[2]));
    });

    // ---- vendor categories
    coGet("/vendor-categories", (c, co) => cats.listCategories(c, readScope(co)).then((categories) => ({ categories })));
    coPost("/vendor-categories", async (c, co, a, b) => {
      await requireRoleEverywhere(c, co, a, BOOKS, "changing the vendor categories");
      return { id: await refuse(() => cats.saveCategory(c, sc(co, a), { id: uuid(b.id), code: str(b.code, 40) || undefined, label: str(b.label, 60),
        isMerchandise: b.isMerchandise === undefined ? undefined : b.isMerchandise === true, defaultGl: b.defaultGl === undefined ? undefined : (str(b.defaultGl, 40) || null),
        active: b.active === undefined ? undefined : b.active !== false, seq: b.seq === undefined ? undefined : Number(b.seq) })) };
    });
    coPost(`/vendors/${ID}/category`, async (c, co, a, b, m) => {
      if (b.thisCompanyOnly === true) await requireRole(c, co, a, PAYABLES, "setting a vendor's category");
      else await requireRoleEverywhere(c, co, a, PAYABLES, "setting a vendor's category for every company");
      return refuse(() => cats.setVendorCategory(c, sc(co, a), m[2], str(b.category, 60) || null, { thisCompanyOnly: b.thisCompanyOnly === true }));
    });
  },
};
