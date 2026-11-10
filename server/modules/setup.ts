// Business setup: industry packs, which modules a company runs, its stores
// and warehouses, its shared pick lists and settings, and the imports that
// bring an old system's customers and open balances across.

import type { ErpModule } from "./kit.ts";
import { need, requireRole, str, uuid, int } from "./kit.ts";
import { q } from "../../packages/core/db.ts";
import { scopeOf, rolesOf } from "../actions.ts";
import { ModuleError } from "./kit.ts";
import * as tax from "../../packages/core/tax.ts";
import {
  PACKS, MODULE_IDS, applyPack, enabledModules, setModule, putSetting, importCustomers, importOpenAr, saveLocation,
} from "../../packages/core/setup.ts";

export const module: ErpModule = {
  id: "setup",
  register({ coGet, coPost }) {
    // Every screen asks this to decide what to show; no role needed.
    coGet("/setup/modules", async (c, co) => ({ modules: await enabledModules(c, co.id) }));

    coGet("/setup/business", async (c, co) => {
      // One client runs one query at a time, so these go in sequence.
      const [applied, settings, locations, reasons, imports] = await (async (qs) => { const out = []; for (const f of qs) out.push(await f()); return out; })([
        () => q(c, `select pack, applied_at, applied_by, summary from pack_application where entity_id = $1 order by applied_at desc limit 10`, [co.id]),
        () => q(c, `select key, value, set_by, set_at, from_pack from entity_setting where entity_id = $1 order by key`, [co.id]),
        () => q(c, `select id, code, name, kind, state, tax_rate_bps, address, geo[0] lng, geo[1] lat, status
                from location where entity_id = $1 order by kind, code`, [co.id]),
        () => q(c, `select kind, code, label, restock, active from reason_code where entity_id = $1 order by kind, label`, [co.id]),
        () => q(c, `select kind, filename, rows_seen, rows_added, rows_updated, rows_refused, problems, run_by, run_at
                from import_run where entity_id = $1 order by run_at desc limit 10`, [co.id]),
      ]);
      return {
        packs: PACKS.map((p) => ({ id: p.id, name: p.name, blurb: p.blurb, modules: p.modules, vertical: p.vertical })),
        modules: await enabledModules(c, co.id),
        allModules: MODULE_IDS,
        applied, settings, locations, reasons, imports,
      };
    });

    coPost("/setup/pack", async (c, co, a, body) => {
      await requireRole(c, co, a, ["owner"], "applying a setup pack");
      const pack = str(body.pack, 40);
      need(PACKS.some((p) => p.id === pack), "pick one of the setup packs");
      return applyPack(c, scopeOf(co, a), pack, a.personName);
    });

    coPost("/setup/module", async (c, co, a, body) => {
      await requireRole(c, co, a, ["owner"], "turning a module on or off");
      const m = str(body.module, 30);
      need((MODULE_IDS as readonly string[]).includes(m), "no such module");
      await setModule(c, co.id, m, body.enabled === true, a.personName);
      return { modules: await enabledModules(c, co.id) };
    });

    coPost("/setup/setting", async (c, co, a, body) => {
      await requireRole(c, co, a, ["owner", "controller"], "changing a company setting");
      const key = str(body.key, 80);
      need(key, "name the setting");
      need(body.value !== undefined, "give the setting a value");
      need(JSON.stringify(body.value).length <= 20000, "that setting is too large");
      await putSetting(c, co.id, key, body.value, a.personName);
      return { key };
    });

    coPost("/setup/location", async (c, co, a, body) => {
      await requireRole(c, co, a, ["owner"], "adding or changing a store or warehouse");
      const addr = (body.address && typeof body.address === "object" ? body.address : {}) as Record<string, unknown>;
      const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
      const lng = num(body.lng), lat = num(body.lat);
      need((lng === null) === (lat === null), "a map point needs both longitude and latitude");
      need(lng === null || (Number.isFinite(lng) && Number.isFinite(lat)), "the map point is not a number");
      const id = await saveLocation(c, scopeOf(co, a), {
        id: uuid(body.id), code: str(body.code, 10), name: str(body.name, 80), kind: str(body.kind, 20),
        taxRateBps: int(body.taxRateBps), state: str(addr.state, 2) || null,
        address: { line1: str(addr.line1, 120), city: str(addr.city, 60), state: str(addr.state, 2).toUpperCase(), postal: str(addr.postal, 10) },
        lng, lat,
      });
      return { id };
    });

    // ---- sales tax: jurisdictions, their rates over time, where they apply, and origin or destination sourcing
    const taxed = async <T>(fn: () => Promise<T>) => { try { return await fn(); } catch (e) { if (e instanceof tax.TaxError) throw new ModuleError(e.message); throw e; } };
    const TAX = ["owner", "controller"];
    coGet("/setup/tax", async (c, co, _u, _m, p) => {
      need(p, "pick who you are acting as; tax setup is for the owner, a controller or a store manager");
      const held = await rolesOf(c, co, p);
      need(["owner", "controller", "store_manager"].some((r) => held.has(r)), "seeing the sales tax setup needs one of: owner, controller, store manager");
      return tax.taxSetup(c, co.id);
    });
    coPost("/setup/tax/sourcing", async (c, co, a, body) => {
      await requireRole(c, co, a, TAX, "choosing how sales tax is sourced");
      return taxed(() => tax.setSourcing(c, scopeOf(co, a), str(body.sourcing, 20)));
    });
    coPost("/setup/tax/jurisdictions", async (c, co, a, body) => {
      await requireRole(c, co, a, TAX, "setting up a tax jurisdiction");
      const rate = body.ratePct === undefined || body.ratePct === "" ? undefined : Math.round(Number(body.ratePct) * 100);
      return taxed(() => tax.saveJurisdiction(c, scopeOf(co, a), { id: uuid(body.id), code: str(body.code, 40), name: str(body.name, 120), level: str(body.level, 20),
        state: str(body.state, 2), taxesDelivery: body.taxesDelivery === true, taxesLabor: body.taxesLabor === true, taxesWarranty: body.taxesWarranty === true,
        filingRef: str(body.filingRef, 60) || null, note: str(body.note, 300) || null, active: body.active !== false, rateBps: rate,
        effectiveFrom: str(body.effectiveFrom, 10) || undefined }));
    });
    coPost("/setup/tax/jurisdictions/([0-9a-fA-F-]{36})/rates", async (c, co, a, body, m) => {
      await requireRole(c, co, a, TAX, "changing a tax rate");
      need(body.ratePct !== undefined && body.ratePct !== "", "give the new rate");
      return taxed(() => tax.addRate(c, scopeOf(co, a), m[2], { rateBps: Math.round(Number(body.ratePct) * 100), effectiveFrom: str(body.effectiveFrom, 10), note: str(body.note, 300) || null }));
    });
    coPost("/setup/tax/areas", async (c, co, a, body) => {
      await requireRole(c, co, a, TAX, "changing where a tax applies");
      return taxed(() => tax.saveArea(c, scopeOf(co, a), { id: uuid(body.id), remove: body.remove === true, jurisdictionId: uuid(body.jurisdictionId) ?? "",
        locationId: uuid(body.locationId), state: str(body.state, 2) || null, postal: str(body.postal, 10) || null }));
    });

    coPost("/setup/reason", async (c, co, a, body) => {
      await requireRole(c, co, a, ["owner", "controller"], "editing a pick list");
      const kind = str(body.kind, 30), label = str(body.label, 80);
      const code = str(body.code, 40).toLowerCase().replace(/[^a-z0-9]+/g, "_") || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40);
      need(["return", "adjustment", "damage", "discount", "write_off", "delivery_exception", "void"].includes(kind), "pick which list this belongs to");
      need(label.length >= 2, "give the reason a label people will recognise");
      await c.query(
        `insert into reason_code (entity_id, kind, code, label, restock, active) values ($1,$2,$3,$4,$5,$6)
         on conflict (entity_id, kind, code) do update set label = excluded.label, restock = excluded.restock, active = excluded.active`,
        [co.id, kind, code, label, typeof body.restock === "boolean" ? body.restock : null, body.active !== false]);
      return { kind, code };
    });

    coPost("/setup/import/customers", async (c, co, a, body) => {
      await requireRole(c, co, a, ["owner", "controller", "ar_clerk"], "importing customers");
      const csv = typeof body.csv === "string" ? body.csv : "";
      need(csv.length > 0, "choose a CSV file");
      need(csv.length <= 200_000, "that file is over the 200 KB limit for one import; split it");
      return importCustomers(c, scopeOf(co, a), csv, str(body.filename, 120) || "upload.csv", a.personName);
    });

    coPost("/setup/import/open-ar", async (c, co, a, body) => {
      await requireRole(c, co, a, ["owner", "controller"], "importing opening receivables");
      const csv = typeof body.csv === "string" ? body.csv : "";
      need(csv.length > 0, "choose a CSV file");
      need(csv.length <= 200_000, "that file is over the 200 KB limit for one import; split it");
      const out = await importOpenAr(c, scopeOf(co, a), csv, str(body.filename, 120) || "upload.csv", a.personName);
      return { ...out, totalMinor: out.totalMinor.toString() };
    });
  },
};
