// wms module -- containers and freight, goods in transit, and the prep
// (deluxing, touch-up, assembly) queue. Routes under /api/c/<company>/wms/...
// The rules live in packages/core/wms.ts; this file checks who may do what
// and reads the request.
import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { need, requireRole, str, uuid, int, minor, ModuleError } from "./kit.ts";
import { q } from "../../packages/core/db.ts";
import { scopeOf } from "../actions.ts";
import * as wms from "../../packages/core/wms.ts";
import { InventoryError } from "../../packages/core/inventory.ts";
import { PurchasingError } from "../../packages/core/purchasing.ts";
import { PostingError } from "../../packages/core/posting.ts";

const ID = "([0-9a-fA-F-]{36})";

const safe = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
  try { return await fn(...a); } catch (e) {
    if (e instanceof wms.WmsError || e instanceof InventoryError || e instanceof PurchasingError || e instanceof PostingError) throw new ModuleError(e.message);
    throw e;
  }
};

const TRACK = ["buyer", "warehouse", "store_manager"];     // booking containers, their lines and stages
const COSTS = ["buyer", "controller"];                      // freight, duty and fees: landed cost
const WAREHOUSE = ["warehouse", "store_manager"];           // unloading, the prep queue
const MANAGER = ["store_manager"];                          // prep rules, cancelling a job
const SETTINGS = ["store_manager", "controller"];

const day = (v: unknown): string | null | undefined => {
  if (v === undefined) return undefined;
  const s = str(v, 10);
  if (!s) return null;
  need(/^\d{4}-\d{2}-\d{2}$/.test(s), "dates are written like 2026-12-01");
  return s;
};
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const sc = (co: Company, a: Actor) => scopeOf(co, a);

async function options(c: Client, co: Company) {
  const [locations, vendors, products, categories] = await Promise.all([
    q(c, `select id, code, name, kind from location where entity_id = $1 and status = 'active' and kind in ('warehouse','store','outlet')
           order by kind <> 'warehouse', name`, [co.id]),
    q(c, `select v.id, coalesce(v.dba, v.legal_name) name from vendor_entity ve join vendor v on v.id = ve.vendor_id
           where ve.entity_id = $1 and ve.status = 'active'
             and exists (select 1 from vendor_merchandise vm where vm.entity_id = ve.entity_id and vm.vendor_id = ve.vendor_id and vm.is_merchandise)
           order by 2`, [co.id]),
    q(c, `select id, sku, name, category from product where entity_id = $1 and kind in ('stock','configurable','special_order') and status <> 'discontinued'
           order by name limit 500`, [co.id]),
    q(c, `select distinct category from product where entity_id = $1 and category is not null order by 1`, [co.id]),
  ]);
  return { locations, vendors, products, categories: categories.map((x) => (x as { category: string }).category),
    stages: wms.STAGES.map((s) => ({ id: s, label: wms.STAGE_LABEL[s] })), costKinds: wms.COST_KINDS, costBases: wms.COST_BASES, prepTypes: wms.PREP_TYPES };
}

async function overview(c: Client, co: Company) {
  const [cts, transit, prep, settings] = await Promise.all([
    wms.containers(c, co.id),
    q<{ source: string; n: string; units: string }>(c, `select source, count(*)::text n, coalesce(sum(qty),0)::text units from inv_in_transit where entity_id = $1 group by source`, [co.id]),
    q<{ status: string; n: string }>(c, `select status, count(*)::text n from wms_prep_job where entity_id = $1 and status in ('queued','in_progress','problem') group by status`, [co.id]),
    wms.settings(c, co.id),
  ]);
  return { containers: cts, inTransit: transit, prep: Object.fromEntries(prep.map((p) => [p.status, Number(p.n)])), settings };
}

export const module: ErpModule = {
  id: "wms",
  register({ coGet, coPost }) {
    coGet("/wms/options", safe((c, co) => options(c, co)));
    coGet("/wms/overview", safe((c, co) => overview(c, co)));
    coGet("/wms/containers", safe((c, co, url) => wms.containers(c, co.id, { open: url.searchParams.get("all") !== "1" })));
    coGet(`/wms/containers/${ID}`, safe((c, co, _u, m) => wms.container(c, co.id, m[2])));
    coGet("/wms/container-lines", safe((c, co, url) => wms.linesForContainer(c, co.id, uuid(url.searchParams.get("vendorId")))));
    coGet("/wms/in-transit", safe((c, co, url) => wms.inTransit(c, co.id, { locationId: uuid(url.searchParams.get("locationId")) })));
    coGet("/wms/prep", safe((c, co, url) => wms.prepQueue(c, co.id, { locationId: uuid(url.searchParams.get("locationId")),
      status: ["queued", "in_progress", "done", "problem", "cancelled"].includes(String(url.searchParams.get("status"))) ? String(url.searchParams.get("status")) : null })));
    coGet("/wms/prep/rules", safe((c, co) => wms.prepRules(c, co.id)));
    coGet("/wms/prep/labor", safe((c, co, url) => wms.prepLabor(c, co.id, Math.min(365, Math.max(1, int(url.searchParams.get("days"), 30))))));
    coGet("/wms/settings", safe((c, co) => wms.settings(c, co.id)));

    // ---- containers
    coPost("/wms/containers", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, TRACK, "booking a container");
      return wms.createContainer(c, sc(co, a), { containerNo: str(b.containerNo, 30) || null, carrier: str(b.carrier, 80) || null, vessel: str(b.vessel, 80) || null,
        voyage: str(b.voyage, 40) || null, bol: str(b.bol, 60) || null, portLoading: str(b.portLoading, 80) || null, portDischarge: str(b.portDischarge, 80) || null,
        destLocationId: uuid(b.destLocationId) ?? "", vendorId: uuid(b.vendorId), note: str(b.note) || null, etaDc: day(b.etaDc) ?? null });
    }));
    coPost(`/wms/containers/${ID}`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, TRACK, "changing a container");
      const opt = (k: string, max: number) => (b[k] === undefined ? undefined : str(b[k], max) || null);
      return wms.editContainer(c, sc(co, a), m[2], { containerNo: opt("containerNo", 30), carrier: opt("carrier", 80), vessel: opt("vessel", 80), voyage: opt("voyage", 40),
        bol: opt("bol", 60), portLoading: opt("portLoading", 80), portDischarge: opt("portDischarge", 80), note: opt("note", 500) });
    }));
    coPost(`/wms/containers/${ID}/lines`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, TRACK, "putting purchase order lines on a container");
      const lines = (Array.isArray(b.lines) ? b.lines : []).map((l: Record<string, unknown>) => ({ poLineId: uuid(l.poLineId) ?? "", qty: num(l.qty) }));
      return wms.setContainerLines(c, sc(co, a), m[2], lines);
    }));
    coPost(`/wms/containers/${ID}/stage`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, TRACK, "updating a container's stage");
      return wms.setStage(c, sc(co, a), m[2], str(b.stage, 30), { expectedOn: day(b.expectedOn), actualOn: day(b.actualOn) });
    }));
    coPost(`/wms/containers/${ID}/costs`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, COSTS, "adding freight, duty or fees to a container");
      return wms.addContainerCost(c, sc(co, a), m[2], { kind: str(b.kind, 20), amountMinor: minor(b.amount ?? 0), basis: str(b.basis, 10), note: str(b.note, 300) || null });
    }));
    coPost(`/wms/containers/${ID}/receive`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, WAREHOUSE, "unloading a container");
      const lines = (Array.isArray(b.lines) ? b.lines : []).map((l: Record<string, unknown>) => ({ containerLineId: uuid(l.containerLineId) ?? "", qty: num(l.qty),
        damagedQty: num(l.damagedQty ?? 0) || 0, damageNote: str(l.damageNote) || undefined }));
      return wms.receiveContainer(c, sc(co, a), m[2], { binId: uuid(b.binId), note: str(b.note, 200) || null, lines });
    }));

    // ---- prep queue
    coPost("/wms/prep/rules", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, MANAGER, "setting which goods need prep");
      return wms.setPrepRule(c, sc(co, a), { productId: uuid(b.productId), category: str(b.category, 80) || null,
        prepTypes: Array.isArray(b.prepTypes) ? b.prepTypes.map(String) : [], stdMinutes: b.stdMinutes === "" || b.stdMinutes == null ? null : int(b.stdMinutes),
        active: b.active !== false });
    }));
    coPost("/wms/prep/queue", safe(async (c, co, a, b) => {
      await requireRole(c, co, a, WAREHOUSE, "queueing prep");
      return wms.queueByLabel(c, sc(co, a), str(b.label, 40), str(b.prepType, 20), str(b.note, 300) || null);
    }));
    coPost(`/wms/prep/${ID}/start`, safe(async (c, co, a, _b, m) => {
      await requireRole(c, co, a, WAREHOUSE, "starting a prep job");
      return wms.startJob(c, sc(co, a), m[2]);
    }));
    coPost(`/wms/prep/${ID}/done`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, WAREHOUSE, "finishing a prep job");
      return wms.finishJob(c, sc(co, a), m[2], { laborMinutes: b.laborMinutes === "" || b.laborMinutes == null ? null : int(b.laborMinutes, -1), note: str(b.note, 500) || null });
    }));
    coPost(`/wms/prep/${ID}/problem`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, WAREHOUSE, "flagging a problem on a prep job");
      return wms.flagProblem(c, sc(co, a), m[2], { problem: str(b.problem, 500), photos: b.photos });
    }));
    coPost(`/wms/prep/${ID}/cancel`, safe(async (c, co, a, b, m) => {
      await requireRole(c, co, a, MANAGER, "cancelling a prep job");
      return wms.cancelJob(c, sc(co, a), m[2], str(b.reason, 500));
    }));

    // ---- settings
    coPost("/wms/settings", safe(async (c, co, a, b) => {
      const held = await requireRole(c, co, a, SETTINGS, "changing warehouse settings");
      if (b.inTransitGl !== undefined) need(held.has("owner") || held.has("controller"), "choosing the in-transit account needs one of: controller");
      return wms.saveSettings(c, sc(co, a), {
        twoStepTransfers: b.twoStepTransfers === undefined ? undefined : b.twoStepTransfers === true,
        inTransitGl: b.inTransitGl === undefined ? undefined : (str(b.inTransitGl, 4) as "1300" | "1310"),
        transferDays: b.transferDays === undefined ? undefined : int(b.transferDays, -1),
        prepGate: b.prepGate === undefined ? undefined : (str(b.prepGate, 10) as "off" | "warn" | "refuse"),
      });
    }));
  },
};
