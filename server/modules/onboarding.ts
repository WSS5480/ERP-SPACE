// First-run setup: the setup checklist (on Home and under Setup), the help
// behind each step, skipping a step with a reason, the company's own details,
// opening stock from a CSV and a bank account's opening balance.
//
// Who: the owner and controllers see and work the checklist. Company details
// and Go live are the owner's (Go live never from support mode). Opening stock and bank balances post to opening equity, so
// they are the owner's or a controller's.

import type { ErpModule, Client, Company } from "./kit.ts";
import { ModuleError, need, requireRole, str, uuid, minor } from "./kit.ts";
import { rolesOf, scopeOf } from "../actions.ts";
import * as ob from "../../packages/core/onboarding.ts";
import { effectiveServices } from "../../packages/core/services.ts";

const WHO = ["owner", "controller"];

/** Opening stock belongs to the Warehouse service: with it off there is no stock to bring in. */
async function needWarehouse(c: Client, co: Company) {
  need((await effectiveServices(c, co.id)).on.includes("inventory"), "the Warehouse service is off for this company, so there is no stock to bring in; turn it on under Services first");
}

async function plain<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { if (e instanceof ob.OnboardingError) throw new ModuleError(e.message); throw e; }
}

async function canSee(c: Client, co: Company, p: string | null) {
  need(p, "pick who you are acting as; the setup checklist is for the owner or a controller");
  const held = await rolesOf(c, co, p!);
  need(WHO.some((r) => held.has(r)), "the setup checklist is for the owner or a controller");
}

export const module: ErpModule = {
  id: "onboarding",
  register({ coGet, coPost }) {
    coGet("/onboarding/checklist", async (c, co, _u, _m, p) => {
      await canSee(c, co, p);
      return ob.checklist(c, co.tenantId, co.id);
    });

    // Home asks this for its card: nothing (not an error) for anyone the checklist is not for, or once it is finished or dismissed.
    coGet("/onboarding/home", async (c, co, _u, _m, p) => {
      if (!p) return { show: false };
      const held = await rolesOf(c, co, p);
      if (!WHO.some((r) => held.has(r))) return { show: false };
      // the card's count and next steps skip the tie-outs (they run on the checklist and the go-live step);
      // a list that looks finished without them is checked in full, so the card never hides while a tie-out fails
      let d = await ob.checklist(c, co.tenantId, co.id, { tieOuts: false });
      if (d.dismissed) return { show: false, complete: false };
      if (d.complete || d.steps.every((s) => s.status !== "todo" || s.id === "golive")) d = await ob.checklist(c, co.tenantId, co.id);
      if (d.complete) return { show: false, complete: true };
      return { show: true, finished: d.finished, total: d.total,
        next: d.steps.filter((s) => s.status === "todo").slice(0, 3).map((s) => ({ id: s.id, title: s.title, why: s.why, screen: s.screen, sub: s.sub ?? null, label: s.label })) };
    });

    coPost("/onboarding/skip", async (c, co, a, b) => {
      await requireRole(c, co, a, WHO, "skipping a setup step");
      return plain(() => ob.skipStep(c, scopeOf(co, a), str(b.step, 40), str(b.reason, 500)));
    });
    coPost("/onboarding/unskip", async (c, co, a, b) => {
      await requireRole(c, co, a, WHO, "taking back a skipped setup step");
      return plain(() => ob.unskipStep(c, scopeOf(co, a), str(b.step, 40)));
    });
    coPost("/onboarding/dismiss", async (c, co, a, b) => {
      await requireRole(c, co, a, WHO, "hiding the setup checklist from Home");
      return plain(() => ob.dismiss(c, scopeOf(co, a), b.dismissed !== false));
    });

    // ---- go live (0066): the owner's own step, once the go-live check passes; ends ERP setup's approvals for good
    coPost("/onboarding/go-live", async (c, co, a, b) => {
      await requireRole(c, co, a, ["owner"], "taking the company live");
      return plain(() => ob.goLive(c, scopeOf(co, a), { reviewed: b.reviewed === true }));
    });

    // ---- company details
    coGet("/onboarding/company", async (c, co, _u, _m, p) => {
      await canSee(c, co, p);
      const r = await c.query(`select name, legal_name, ein_last4, address, state, fiscal_year_end_month, time_zone, business_tz(id) zone_in_use from entity where id = $1 and tenant_id = $2 /* unscoped: the company itself */`, [co.id, co.tenantId]);
      const e = r.rows[0];
      return { name: e.name, legalName: e.legal_name, einLast4: e.ein_last4, address: e.address, state: e.state, fiscalYearStartMonth: (e.fiscal_year_end_month % 12) + 1, timeZone: e.time_zone, zoneInUse: e.zone_in_use,
        canChangeYear: !(await c.query(`select 1 from journal_entry where entity_id = $1 limit 1`, [co.id])).rows.length };
    });
    coPost("/onboarding/company", async (c, co, a, b) => {
      await requireRole(c, co, a, ["owner"], "changing the company's details");
      const addr = (b.address && typeof b.address === "object" ? b.address : {}) as Record<string, unknown>;
      return plain(() => ob.saveCompanyDetails(c, scopeOf(co, a), { legalName: str(b.legalName, 120), einLast4: str(b.einLast4, 10) || null,
        address: { line1: str(addr.line1, 120), city: str(addr.city, 60), postal: str(addr.postal, 10) }, state: str(b.state, 20) || null,
        fiscalYearStartMonth: b.fiscalYearStartMonth == null || b.fiscalYearStartMonth === "" ? null : Number(b.fiscalYearStartMonth),
        timeZone: b.timeZone === undefined ? undefined : str(b.timeZone, 60) }));
    });

    // ---- opening balances
    coGet("/onboarding/opening", async (c, co, _u, _m, p) => {
      await canSee(c, co, p);
      return { runs: await ob.openingStockRuns(c, co.id), banks: await ob.openingBanks(c, co.id) };
    });
    coPost("/onboarding/opening-stock/preview", async (c, co, a, b) => {
      await requireRole(c, co, a, WHO, "bringing in opening stock");
      await needWarehouse(c, co);
      const csv = typeof b.csv === "string" ? b.csv : "";
      need(csv.length > 0, "choose a CSV file");
      need(csv.length <= 1_000_000, "that file is over the 1 MB limit for one import; split it");
      return plain(() => ob.previewOpeningStock(c, scopeOf(co, a), csv, str(b.filename, 120) || "upload.csv", str(b.asOf, 10)));
    }, { maxBody: 1_200_000 });
    coPost("/onboarding/opening-stock/apply", async (c, co, a, b) => {
      await requireRole(c, co, a, WHO, "bringing in opening stock");
      await needWarehouse(c, co);
      const id = uuid(b.runId);
      need(id, "no such opening stock import");
      return plain(() => ob.applyOpeningStock(c, scopeOf(co, a), id!, { confirm: b.confirm === true }));
    });
    coPost("/onboarding/opening-bank", async (c, co, a, b) => {
      await requireRole(c, co, a, WHO, "entering a bank opening balance");
      const id = uuid(b.bankAccountId);
      need(id, "pick the bank account");
      let amt: bigint;
      try { amt = minor(b.amount); } catch { throw new ModuleError("the balance is not an amount"); }
      return plain(() => ob.openingBankBalance(c, scopeOf(co, a), { bankAccountId: id!, asOf: str(b.asOf, 10), amountMinor: amt }));
    });
  },
};
