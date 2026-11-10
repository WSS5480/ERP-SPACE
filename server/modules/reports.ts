// reports module -- see docs/MODULES.md for the contract.
// The report creator and editor: the dataset catalog, running a definition
// (saved or not yet saved) with paging, drill-down and export, and saved
// reports with versions, sharing, pins to Home, schedules and snapshots.
// Every run checks the acting person's roles against the dataset, here and in
// packages/core/reports.ts, and runs with a statement timeout and a row cap.
import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { ModuleError, need, str, uuid, int } from "./kit.ts";
import { scopeOf } from "../actions.ts";
import { pool, tx } from "../../packages/core/db.ts";
import * as rep from "../../packages/core/reports.ts";
import { enabledModules } from "../../packages/core/setup.ts";
import * as tax from "../../packages/core/tax.ts";

const ID = "([0-9a-fA-F-]{36})";

async function refuse<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof rep.ReportError) throw new ModuleError(e.message);
    const pg = e as { code?: string };
    if (pg?.code === "57014") throw new ModuleError(`the report took longer than ${rep.LIMITS.timeoutMs / 1000} seconds; narrow it with a filter or a shorter period`);
    throw e;
  }
}

const who = (personId: string | null): string => {
  need(personId, "pick who you are acting as; reports show what that person may see");
  return personId;
};

/** The definition to run: a saved report's (if it can be seen), or one sent from the editor. */
async function definitionOf(c: Client, co: Company, personId: string, roles: Set<string>, b: Record<string, unknown>) {
  const id = uuid(b.reportId);
  if (id) {
    const r = await rep.getReport(c, co.id, id, personId, roles);
    return { def: b.definition ?? r.definition, name: r.name };
  }
  need(b.definition, "send a report definition or a saved report");
  return { def: b.definition, name: str(b.name, 120) || "Report" };
}

const fileName = (name: string, ext: string) =>
  `${name.replace(/[^A-Za-z0-9 ._-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "report"}-${new Date().toISOString().slice(0, 10)}.${ext}`;

async function ensureStarters(c: Client, co: Company) {
  const have = await c.query(`select count(*)::int n from report where entity_id = $1 and starter is not null`, [co.id]);
  if (Number(have.rows[0].n) >= rep.STARTERS.length) return;
  const modules = await enabledModules(c, co.id);
  // Adding starters is idempotent (one per company per starter), so a racing first visit adds nothing twice.
  await tx({ kind: "system", label: "reports starters" }, (t) => rep.installStarters(t, co.id, modules));
}

export const module: ErpModule = {
  id: "reports",
  register(kit) {
    const { coGet, coPost } = kit;
    const roles = (c: Client, co: Company, personId: string | null) => rep.rolesFor(c, co.id, personId);

    // ---------------------------------------------------------------- reads
    coGet("/reports/catalog", async (c, co, _u, _m, p) => refuse(async () => {
      const r = await roles(c, co, who(p));
      const modules = await enabledModules(c, co.id);
      return { datasets: rep.catalogFor(r, modules), ops: rep.OPS, aggs: rep.AGGS, relative: rep.RELATIVE, buckets: rep.BUCKETS,
        limits: rep.LIMITS, shareRoles: rep.SHARE_ROLES, roles: [...r] };
    }));
    coGet("/reports", async (c, co, _u, _m, p) => refuse(async () => {
      const person = who(p);
      await ensureStarters(c, co);
      const r = await roles(c, co, person);
      return { reports: await rep.listReports(c, co.id, person, r), roles: [...r] };
    }));
    coGet("/reports/pinned", async (c, co, _u, _m, p) => refuse(async () => {
      if (!p) return { reports: [] };
      return { reports: await rep.pinned(c, co.id, p, await roles(c, co, p)) };
    }));
    coGet(`/reports/${ID}`, async (c, co, _u, m, p) => refuse(async () => {
      const person = who(p);
      const r = await roles(c, co, person);
      const x = await rep.getReport(c, co.id, m[2], person, r);
      return { report: { ...x, canEdit: rep.canEdit(x, person, r), canDelete: rep.canDelete(x, person, r) },
        pinned: (await rep.pinned(c, co.id, person, r)).some((y) => y.id === x.id),
        snapshots: await rep.snapshots(c, co.id, x.id, person, r) };
    }));
    coGet(`/reports/${ID}/versions`, async (c, co, _u, m, p) => refuse(async () => {
      const person = who(p);
      return { versions: await rep.versions(c, co.id, m[2], person, await roles(c, co, person)) };
    }));
    coGet(`/reports/${ID}/snapshots/${ID}`, async (c, co, _u, m, p) => refuse(async () => {
      const person = who(p);
      return rep.snapshotResult(c, co.id, m[2], m[3], person, await roles(c, co, person));
    }));

    // ------------------------------------------------------------ running
    // These change nothing; they are POSTs because a definition is a body. Each
    // runs read-only, with the statement timeout set inside.
    const readOnly = (c: Client) => c.query("set transaction read only");
    // ---- the sales tax filing: per jurisdiction for a period, tied to GL 2100, and its CSV
    const filingFor = async (c: Client, co: Company, personId: string | null, from: string, to: string) => {
      const held = await roles(c, co, who(personId));
      need(["owner", "controller", "viewer"].some((r) => held.has(r)), "the sales tax filing needs one of: owner, controller, viewer");
      try { return await tax.filing(c, co.id, from, to); } catch (e) { if (e instanceof tax.TaxError) throw new ModuleError(e.message); throw e; }
    };
    coGet("/reports/tax-filing", async (c, co, url, _m, p) => {
      const f = await filingFor(c, co, p, str(url.searchParams.get("from"), 10), str(url.searchParams.get("to"), 10));
      return { ...f, reasons: tax.EXEMPT_LABEL };
    });
    coPost("/reports/tax-filing/export", async (c, co, a, b) => {
      const f = await filingFor(c, co, a.personId, str(b.from, 10), str(b.to, 10));
      return { filename: `sales-tax-${f.from}-to-${f.to}.csv`, csv: tax.filingCsv(f), rows: f.rows.length, note: f.tie.ties ? null : f.tie.note };
    });

    coPost("/reports/run", async (c, co, a, b) => refuse(async () => {
      await readOnly(c);
      const r = await roles(c, co, a.personId);
      const { def } = await definitionOf(c, co, a.personId, r, b);
      const preview = b.preview === true;
      return rep.run(c, co.id, r, def, { params: b.params, offset: int(b.offset, 0), preview,
        size: preview ? rep.LIMITS.preview : Math.min(int(b.size, rep.LIMITS.pageDefault), rep.LIMITS.pageMax) });
    }));
    coPost("/reports/drill", async (c, co, a, b) => refuse(async () => {
      await readOnly(c);
      const r = await roles(c, co, a.personId);
      const { def } = await definitionOf(c, co, a.personId, r, b);
      return rep.drill(c, co.id, r, def, b.keys, { params: b.params, offset: int(b.offset, 0), size: Math.min(int(b.size, 50), rep.LIMITS.pageMax) });
    }));
    coPost("/reports/values", async (c, co, a, b) => refuse(async () => {
      await readOnly(c);
      return { values: await rep.values(c, co.id, await roles(c, co, a.personId), b.dataset, b.field) };
    }));
    coPost("/reports/export", async (c, co, a, b) => refuse(async () => {
      await readOnly(c);
      const r = await roles(c, co, a.personId);
      const { def, name } = await definitionOf(c, co, a.personId, r, b);
      const res = await rep.run(c, co.id, r, def, { params: b.params, size: rep.LIMITS.exportMax, cap: rep.LIMITS.exportMax, withChart: false });
      const note = res.count > res.rows.length ? `The export holds the first ${res.rows.length} of ${res.count} rows.` : null;
      if (b.format === "xlsx") return { filename: fileName(name, "xlsx"), base64: rep.toXlsx(res, name).toString("base64"), rows: res.rows.length, note };
      return { filename: fileName(name, "csv"), csv: rep.toCsv(res), rows: res.rows.length, note };
    }));

    // ------------------------------------------------------------ saving
    const sc = (co: Company, a: Actor) => scopeOf(co, a);
    coPost("/reports", async (c, co, a, b) => refuse(async () =>
      rep.createReport(c, sc(co, a), a.personId, await roles(c, co, a.personId), b)));
    coPost(`/reports/${ID}`, async (c, co, a, b, m) => refuse(async () =>
      rep.updateReport(c, sc(co, a), m[2], a.personId, await roles(c, co, a.personId), b)));
    coPost(`/reports/${ID}/duplicate`, async (c, co, a, b, m) => refuse(async () =>
      rep.duplicateReport(c, sc(co, a), m[2], a.personId, await roles(c, co, a.personId), b.name)));
    coPost(`/reports/${ID}/delete`, async (c, co, a, _b, m) => refuse(async () =>
      rep.deleteReport(c, sc(co, a), m[2], a.personId, await roles(c, co, a.personId))));
    coPost(`/reports/${ID}/pin`, async (c, co, a, b, m) => refuse(async () =>
      rep.pinReport(c, co.id, m[2], a.personId, await roles(c, co, a.personId), b.on !== false)));
    coPost(`/reports/${ID}/schedule`, async (c, co, a, b, m) => refuse(async () =>
      rep.setSchedule(c, sc(co, a), m[2], a.personId, await roles(c, co, a.personId), b)));
    coPost(`/reports/${ID}/snapshot`, async (c, co, a, _b, m) => refuse(async () => {
      await rep.getReport(c, co.id, m[2], a.personId, await roles(c, co, a.personId));
      return rep.snapshot(c, sc(co, a), m[2], a.personId, "manual");
    }));
    // The scheduler runs from scripts/run-due.ts; on a plan with no cron, the books' people can run this company's due reports now.
    coPost("/reports/run-due", async (c, co, a) => refuse(async () => {
      const r = await roles(c, co, a.personId);
      need(r.has("owner") || r.has("controller"), "running scheduled reports by hand needs one of: owner, controller");
      return rep.runDueReports(pool, tx, undefined, co.id);
    }));
  },
};
