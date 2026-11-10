// ops module -- operations that span the other modules:
//   loading     the piece-by-piece load manifest, staging lanes (fleet)
//   haul-away   what the crew takes away, disposal log, state recycling report (fleet)
//   payables    vendor debit memos from service chargebacks or by hand
//   time off    leave types, accrual, requests, holidays, who is absent today (workforce)
// See docs/MODULES.md for the contract.
//
// Who does what (owner passes every check):
//   warehouse, dispatcher, store_manager   load trucks, mark pieces short, lanes, disposal log
//   dispatcher, store_manager, sales       haul-away on a stop
//   driver (own route)                     records what was hauled away, with a photo
//   ap_clerk, controller, buyer            write debit memos; ap_clerk and controller apply them
//   controller, approver                   approve manual debit memos (never their own)
//   anyone with an employee record         asks for their own time off
//   hr, store_manager                      approve or decline time off (never their own); the absent-today card
//   hr, controller                         leave types, balances, accrual, holidays

import * as L from "../../packages/core/loading.ts";
import * as HA from "../../packages/core/haulaway.ts";
import * as DM from "../../packages/core/debit_memo.ts";
import * as LV from "../../packages/core/leave.ts";
import { FleetError } from "../../packages/core/fleet.ts";
import { InventoryError } from "../../packages/core/inventory.ts";
import { PostingError } from "../../packages/core/posting.ts";
import { TransitionError } from "../../packages/core/invoice.ts";
import { WorkforceError } from "../../packages/core/workforce.ts";
import type { Scope } from "../../packages/core/db.ts";
import { rolesOf } from "../actions.ts";
import { ModuleError, need, requireRole, minor, str, uuid, int, type ErpModule, type Client, type Company, type Actor } from "./kit.ts";

const ID = "([0-9a-fA-F-]{36})";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const LOAD = ["warehouse", "dispatcher", "store_manager"];
const DISPATCH = ["dispatcher", "store_manager"];
const BOOK = ["dispatcher", "store_manager", "sales"];
const CREW = ["driver", "technician", "dispatcher", "store_manager"];
const FLEET_STAFF = ["dispatcher", "store_manager", "warehouse"];
const MEMO_WRITE = ["ap_clerk", "controller", "buyer"];
const MEMO_APPLY = ["ap_clerk", "controller"];
const MEMO_DECIDE = ["controller", "approver"];
const MEMO_READ = ["ap_clerk", "controller", "approver", "buyer", "viewer"];
const LEAVE_MANAGE = ["hr", "store_manager"];
const LEAVE_SETUP = ["hr", "controller"];

const scopeOf = (co: Company, a: Actor): Scope => ({ tenantId: co.tenantId, entityId: co.id, actor: { kind: "user", id: a.personId, label: a.label } });
const today = () => new Date().toISOString().slice(0, 10);
const dayOr = (v: unknown, d: string) => { const s = str(v, 10); return DAY.test(s) ? s : d; };
const isoYear = (y: number) => ({ from: `${y}-01-01`, to: `${y}-12-31` });

async function plain<R>(fn: () => Promise<R>): Promise<R> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof FleetError || e instanceof InventoryError || e instanceof PostingError || e instanceof DM.MemoError
      || e instanceof TransitionError || e instanceof WorkforceError) throw new ModuleError(e.message);
    throw e;
  }
}

/** Reads: with no acting person this is the operator's own token, which sees what the owner sees. */
async function held(c: Client, co: Company, personId: string | null) {
  return personId ? await rolesOf(c, co, personId) : new Set(["owner"]);
}
async function canRead(c: Client, co: Company, personId: string | null, roles: string[], doing: string) {
  const h = await held(c, co, personId);
  need(h.has("owner") || roles.some((r) => h.has(r)), `${doing} needs one of: ${roles.map((r) => r.replace(/_/g, " ")).join(", ")}`);
  return h;
}
/** A driver works only the routes they are on. */
async function onRoute(c: Client, co: Company, personId: string | null, routeId: string | null, h: Set<string>) {
  if (!routeId || h.has("owner") || FLEET_STAFF.some((r) => h.has(r))) return;
  const r = await c.query(`select 1 from delivery_route where entity_id = $1 and id = $2 and (driver_id = $3 or helper_id = $3)`, [co.id, routeId, personId]);
  need(r.rowCount, "that route belongs to another driver");
}
async function routeOfHaul(c: Client, co: Company, haulId: string) {
  const r = await c.query<{ route_id: string | null }>(`select s.route_id from stop_haul_away h join delivery_stop s on s.id = h.stop_id where h.entity_id = $1 and h.id = $2`, [co.id, haulId]);
  need(r.rowCount, "no such haul-away");
  return r.rows[0].route_id;
}
async function myEmployee(c: Client, co: Company, personId: string | null) {
  if (!personId) return null;
  const r = await c.query<{ id: string }>(`select id from employee where entity_id = $1 and app_user_id = $2 and status = 'active' limit 1`, [co.id, personId]);
  return r.rows[0]?.id ?? null;
}

export const module: ErpModule = {
  id: "ops",
  register({ coGet, coPost }) {
    // ================================================================ loading
    coGet("/fleet/loading", async (c, co, url, _m, p) => {
      await canRead(c, co, p, [...LOAD], "the loading dock");
      const day = dayOr(url.searchParams.get("day"), today());
      const dc = uuid(url.searchParams.get("dc"));
      return plain(async () => {
        const routes = await c.query(`
          select r.id, r.number, r.status, v.unit_no, d.name driver, ln.code lane,
                 count(i.id) filter (where i.status <> 'removed')::int pieces,
                 count(i.id) filter (where i.status = 'loaded')::int loaded,
                 count(i.id) filter (where i.status = 'short')::int short,
                 count(i.id) filter (where i.status = 'pending')::int pending,
                 (select count(*) from delivery_stop s where s.entity_id = r.entity_id and s.route_id = r.id and s.status <> 'cancelled')::int stops
            from delivery_route r left join vehicle v on v.id = r.vehicle_id left join app_user d on d.id = r.driver_id
            left join route_lane rl on rl.route_id = r.id and rl.entity_id = r.entity_id and rl.released_at is null
            left join dock_lane ln on ln.id = rl.lane_id
            left join route_load_item i on i.route_id = r.id and i.entity_id = r.entity_id
           where r.entity_id = $1 and r.route_on = $2 and r.status <> 'cancelled' and ($3::uuid is null or r.dc_location_id = $3)
           group by r.id, v.unit_no, d.name, ln.code order by r.number`, [co.id, day, dc]);
        return { day, routes: routes.rows, lanes: await L.lanes(c, co.id, dc, day) };
      });
    });
    coGet(`/fleet/routes/${ID}/loading`, async (c, co, _u, m, p) => {
      const h = await canRead(c, co, p, [...LOAD, "driver"], "a load manifest");
      await onRoute(c, co, p, m[2], h);
      return plain(() => L.loading(c, co.id, m[2]));
    });
    coPost(`/fleet/routes/${ID}/loading/prepare`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, LOAD, "building a load manifest");
      return plain(async () => ({ ...(await L.syncLoad(c, scopeOf(co, a), m[2])), ...(await L.loading(c, co.id, m[2])) }));
    });
    coPost(`/fleet/routes/${ID}/loading/scan`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, LOAD, "loading a truck");
      return plain(() => L.loadPiece(c, scopeOf(co, a), m[2], { itemId: uuid(b.itemId), code: str(b.code, 80) || null }));
    });
    coPost(`/fleet/routes/${ID}/loading/short`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, LOAD, "marking a piece short");
      return plain(() => L.markShort(c, scopeOf(co, a), m[2], str(b.itemId, 40), str(b.reason, 300)));
    });
    coPost(`/fleet/routes/${ID}/loading/undo`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, LOAD, "taking a piece off a truck");
      return plain(() => L.unloadPiece(c, scopeOf(co, a), m[2], str(b.itemId, 40)));
    });
    coPost(`/fleet/routes/${ID}/lane`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, LOAD, "staging a route in a lane");
      return plain(() => L.assignLane(c, scopeOf(co, a), m[2], uuid(b.laneId)));
    });
    coGet("/fleet/lanes", async (c, co, url, _m, p) => {
      await canRead(c, co, p, [...LOAD], "the dock lanes");
      return plain(() => L.lanes(c, co.id, uuid(url.searchParams.get("dc")), dayOr(url.searchParams.get("day"), today())));
    });
    coPost("/fleet/lanes", async (c, co, a, b) => {
      await requireRole(c, co, a, DISPATCH, "setting up dock lanes");
      return plain(() => L.saveLane(c, scopeOf(co, a), { id: uuid(b.id), dcLocationId: str(b.dcLocationId, 40), code: str(b.code, 12), name: str(b.name, 80), active: b.active !== false }));
    });

    // ============================================================= haul-away
    coGet(`/fleet/stops/${ID}/haul-away`, async (c, co, _u, m, p) => {
      const h = await canRead(c, co, p, [...BOOK, ...CREW, "warehouse"], "a stop's haul-away");
      const r = await c.query<{ route_id: string | null }>(`select route_id from delivery_stop where entity_id = $1 and id = $2`, [co.id, m[2]]);
      need(r.rowCount, "no such stop");
      await onRoute(c, co, p, r.rows[0].route_id, h);
      return plain(() => HA.forStop(c, co.id, m[2]));
    });
    coPost(`/fleet/stops/${ID}/haul-away`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, BOOK, "adding a haul-away");
      return plain(() => HA.addHaulAway(c, scopeOf(co, a), m[2], { category: str(b.category, 20), qty: Number(b.qty ?? 1), description: str(b.description, 200),
        tradeInMinor: b.tradeIn != null && b.tradeIn !== "" ? minor(b.tradeIn) : 0n, waiveFee: b.waiveFee === true }));
    });
    coPost(`/fleet/haul-away/${ID}/record`, async (c, co, a, b, m) => {
      const h = await requireRole(c, co, a, CREW, "recording a haul-away");
      await onRoute(c, co, a.personId, await routeOfHaul(c, co, m[2]), h);
      return plain(() => HA.recordHaulAway(c, scopeOf(co, a), m[2], { takenQty: Number(b.takenQty ?? 0), photo: typeof b.photo === "string" ? b.photo : null,
        note: str(b.note, 300), weightLb: b.weightLb != null && b.weightLb !== "" ? Number(b.weightLb) : null }));
    });
    coPost(`/fleet/haul-away/${ID}/cancel`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, BOOK, "taking a haul-away off a stop");
      return plain(() => HA.cancelHaulAway(c, scopeOf(co, a), m[2], str(b.reason, 300)));
    });
    coGet("/fleet/haul-away/setup", async (c, co, _u, _m, p) => {
      await canRead(c, co, p, [...BOOK, "warehouse", "controller"], "haul-away rates");
      return plain(async () => ({ rates: await HA.rates(c, co.id), programs: await HA.programs(c, co.id), categories: HA.CATEGORIES, methods: HA.METHODS,
        feeProducts: (await c.query(`select id, sku, name, price_minor::text price_minor from product where entity_id = $1 and kind in ('fee','service') and status = 'active' order by sku`, [co.id])).rows }));
    });
    coPost("/fleet/haul-away/rates", async (c, co, a, b) => {
      await requireRole(c, co, a, DISPATCH, "setting haul-away fees");
      return plain(() => HA.saveRate(c, scopeOf(co, a), { category: str(b.category, 20), label: str(b.label, 80), feeProductId: uuid(b.feeProductId),
        feeMinor: minor(b.fee ?? 0), estWeightLb: Number(b.estWeightLb ?? 0), active: b.active !== false }));
    });
    coPost("/fleet/haul-away/programs", async (c, co, a, b) => {
      await requireRole(c, co, a, [...DISPATCH, "controller"], "setting a state recycling program");
      return plain(() => HA.saveProgram(c, scopeOf(co, a), { state: str(b.state, 2), name: str(b.name, 120),
        categories: Array.isArray(b.categories) ? b.categories.map(String) : undefined, programFeeMinor: minor(b.programFee ?? 0),
        reportRequired: b.reportRequired === true, active: b.active !== false }));
    });
    coGet("/fleet/haul-away/collected", async (c, co, url, _m, p) => {
      await canRead(c, co, p, [...LOAD, "controller"], "haul-away waiting at the warehouse");
      return plain(() => HA.collected(c, co.id, uuid(url.searchParams.get("dc"))));
    });
    coPost("/fleet/haul-away/disposals", async (c, co, a, b) => {
      await requireRole(c, co, a, LOAD, "logging a disposal");
      return plain(() => HA.recordDisposal(c, scopeOf(co, a), { dcLocationId: str(b.dcLocationId, 40), disposedOn: str(b.disposedOn, 10), method: str(b.method, 20),
        facility: str(b.facility, 120), weightLb: b.weightLb != null && b.weightLb !== "" ? Number(b.weightLb) : null, certificateNo: str(b.certificateNo, 60),
        state: str(b.state, 2), note: str(b.note, 300), haulIds: Array.isArray(b.haulIds) ? b.haulIds.map(String) : [] }));
    });
    coGet("/fleet/haul-away/disposals", async (c, co, url, _m, p) => {
      await canRead(c, co, p, [...LOAD, "controller"], "the disposal log");
      const y = new Date().getUTCFullYear();
      return plain(() => HA.disposals(c, co.id, dayOr(url.searchParams.get("from"), `${y}-01-01`), dayOr(url.searchParams.get("to"), `${y}-12-31`)));
    });
    coGet("/fleet/haul-away/report", async (c, co, url, _m, p) => {
      await canRead(c, co, p, [...DISPATCH, "controller"], "the recycling program report");
      const y = new Date().getUTCFullYear();
      return plain(() => HA.programReport(c, co.id, str(url.searchParams.get("state"), 2), dayOr(url.searchParams.get("from"), `${y}-01-01`), dayOr(url.searchParams.get("to"), today())));
    });

    // ========================================================== debit memos
    coGet("/payables/memos", async (c, co, url, _m, p) => {
      await canRead(c, co, p, MEMO_READ, "vendor debit memos");
      return plain(async () => ({
        memos: await DM.memos(c, co.id, { vendorId: uuid(url.searchParams.get("vendor")), status: str(url.searchParams.get("status"), 20) || null }),
        vendors: (await c.query(`select v.id, coalesce(v.dba, v.legal_name) name from vendor v join vendor_entity ve on ve.vendor_id = v.id and ve.entity_id = $1
                                   where v.status <> 'inactive' order by 2`, [co.id])).rows,
        sources: DM.SOURCES,
      }));
    });
    coGet(`/payables/memos/${ID}`, async (c, co, _u, m, p) => {
      await canRead(c, co, p, MEMO_READ, "a vendor debit memo");
      return plain(() => DM.memo(c, co.id, m[2]));
    });
    coPost("/payables/memos", async (c, co, a, b) => {
      await requireRole(c, co, a, MEMO_WRITE, "writing a vendor debit memo");
      return plain(() => DM.createMemo(c, scopeOf(co, a), { vendorId: str(b.vendorId, 40), source: str(b.source, 30), reason: str(b.reason, 300),
        amountMinor: minor(b.amount), offsetCode: str(b.offsetCode, 12), invoiceId: uuid(b.invoiceId), purchaseOrderId: uuid(b.purchaseOrderId),
        vendorRef: str(b.vendorRef, 60), memoDate: str(b.memoDate, 10) }));
    });
    coPost(`/payables/memos/${ID}/approve`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, MEMO_DECIDE, "approving a vendor debit memo");
      return plain(() => DM.approveMemo(c, scopeOf(co, a), m[2], str(b.note, 300)));
    });
    coPost(`/payables/memos/${ID}/reject`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, MEMO_DECIDE, "turning down a vendor debit memo");
      return plain(() => DM.rejectMemo(c, scopeOf(co, a), m[2], str(b.note, 300)));
    });
    coPost(`/payables/memos/${ID}/void`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, ["controller"], "voiding a vendor debit memo");
      return plain(() => DM.voidMemo(c, scopeOf(co, a), m[2], str(b.reason, 300)));
    });
    coPost(`/payables/memos/${ID}/apply`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, MEMO_APPLY, "applying a debit memo to a bill");
      return plain(async () => {
        const r = await DM.applyMemo(c, scopeOf(co, a), m[2], str(b.invoiceId, 40), b.amount != null && b.amount !== "" ? minor(b.amount) : null);
        return { ...r, appliedMinor: r.appliedMinor.toString(), memoLeftMinor: r.memoLeftMinor.toString(), billLeftMinor: r.billLeftMinor.toString() };
      });
    });
    coGet(`/payables/vendors/${ID}/statement`, async (c, co, _u, m, p) => {
      await canRead(c, co, p, MEMO_READ, "a vendor statement");
      return plain(() => DM.statement(c, co.id, m[2]));
    });
    coGet(`/payables/vendors/${ID}/open-bills`, async (c, co, _u, m, p) => {
      await canRead(c, co, p, MEMO_READ, "a vendor's open bills");
      return plain(() => DM.openBills(c, co.id, m[2]));
    });

    // ============================================================== time off
    coGet("/workforce/leave/options", async (c, co, _u, _m, p) => {
      const h = await held(c, co, p);
      return plain(async () => ({
        types: await LV.leaveTypes(c, co.id),
        me: { employeeId: await myEmployee(c, co, p), roles: [...h] },
        manager: h.has("owner") || LEAVE_MANAGE.some((r) => h.has(r)),
        setup: h.has("owner") || LEAVE_SETUP.some((r) => h.has(r)),
        employees: h.has("owner") || [...LEAVE_MANAGE, ...LEAVE_SETUP].some((r) => h.has(r))
          ? (await c.query(`select id, first_name || ' ' || last_name name, pay_type, app_user_id from employee where entity_id = $1 and status = 'active' order by last_name, first_name`, [co.id])).rows : [],
        periods: (await c.query(`select pp.id, pg.name pay_group, pp.starts_on::text, pp.ends_on::text, pp.status from pay_period pp join pay_group pg on pg.id = pp.pay_group_id and pg.entity_id = $1
                                  where pp.status <> 'cancelled' order by pp.ends_on desc, pg.name limit 20`, [co.id])).rows,
      }));
    });
    coGet("/workforce/leave/requests", async (c, co, url, _m, p) => {
      const h = await held(c, co, p);
      const mgr = h.has("owner") || [...LEAVE_MANAGE, ...LEAVE_SETUP].some((r) => h.has(r));
      const mine = await myEmployee(c, co, p);
      const want = uuid(url.searchParams.get("employee"));
      need(mgr || (mine && (!want || want === mine)), "a person sees their own time off; managers see everyone's");
      return plain(() => LV.requests(c, co.id, { employeeId: mgr ? want : mine, status: str(url.searchParams.get("status"), 20) || null,
        from: DAY.test(str(url.searchParams.get("from"), 10)) ? str(url.searchParams.get("from"), 10) : null }));
    });
    coPost("/workforce/leave/requests", async (c, co, a, b) => {
      const mine = await myEmployee(c, co, a.personId);
      const who = uuid(b.employeeId) ?? mine;
      need(who, "you are not set up as an employee here, so there is no time off to ask for");
      if (who !== mine) await requireRole(c, co, a, LEAVE_MANAGE, "asking for time off for someone else");
      return plain(() => LV.request(c, scopeOf(co, a), { employeeId: who!, leaveTypeId: str(b.leaveTypeId, 40), startsOn: str(b.startsOn, 10),
        endsOn: str(b.endsOn, 10) || undefined, hoursPerDay: b.hoursPerDay != null && b.hoursPerDay !== "" ? Number(b.hoursPerDay) : undefined, note: str(b.note, 300) }));
    });
    coPost(`/workforce/leave/requests/${ID}/approve`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, LEAVE_MANAGE, "approving time off");
      return plain(() => LV.decide(c, scopeOf(co, a), m[2], { approve: true, note: str(b.note, 300) }));
    });
    coPost(`/workforce/leave/requests/${ID}/decline`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, LEAVE_MANAGE, "declining time off");
      return plain(() => LV.decide(c, scopeOf(co, a), m[2], { approve: false, note: str(b.note, 300) }));
    });
    coPost(`/workforce/leave/requests/${ID}/cancel`, async (c, co, a, b, m) => {
      const h = await rolesOf(c, co, a.personId);
      return plain(() => LV.cancel(c, scopeOf(co, a), m[2], str(b.reason, 300), h.has("owner") || LEAVE_MANAGE.some((r) => h.has(r))));
    });
    coGet("/workforce/leave/balances", async (c, co, url, _m, p) => {
      const h = await held(c, co, p);
      const mine = await myEmployee(c, co, p);
      const want = uuid(url.searchParams.get("employee")) ?? mine;
      need(want, "pick the employee");
      need(want === mine || h.has("owner") || [...LEAVE_MANAGE, ...LEAVE_SETUP].some((r) => h.has(r)), "a person sees their own balances; managers see everyone's");
      return plain(() => LV.balances(c, co.id, want!));
    });
    coPost("/workforce/leave/adjust", async (c, co, a, b) => {
      await requireRole(c, co, a, LEAVE_SETUP, "changing a leave balance");
      return plain(() => LV.adjust(c, scopeOf(co, a), { employeeId: str(b.employeeId, 40), leaveTypeId: str(b.leaveTypeId, 40), hours: Number(b.hours), note: str(b.note, 300) }));
    });
    coPost("/workforce/leave/accrue", async (c, co, a, b) => {
      await requireRole(c, co, a, LEAVE_SETUP, "accruing leave");
      return plain(() => LV.accrue(c, scopeOf(co, a), str(b.payPeriodId, 40)));
    });
    coPost("/workforce/leave/pay", async (c, co, a, b) => {
      await requireRole(c, co, a, [...LEAVE_SETUP], "adding leave and holiday pay to a pay period");
      return plain(() => LV.leavePayForPeriod(c, scopeOf(co, a), str(b.payPeriodId, 40), a.personId));
    });
    coPost("/workforce/leave/types", async (c, co, a, b) => {
      await requireRole(c, co, a, LEAVE_SETUP, "setting up a leave type");
      return plain(() => LV.saveLeaveType(c, scopeOf(co, a), { id: uuid(b.id), code: str(b.code, 12), name: str(b.name, 60), kind: str(b.kind, 12),
        paid: b.paid !== false, accrual: str(b.accrual, 12) || "none", accrueHours: Number(b.accrueHours ?? 0),
        perHours: b.perHours != null && b.perHours !== "" ? Number(b.perHours) : null, capHours: b.capHours != null && b.capHours !== "" ? Number(b.capHours) : null,
        allowNegative: b.allowNegative === true, active: b.active !== false }));
    });
    coGet("/workforce/holidays", async (c, co, url, _m, p) => {
      await held(c, co, p);
      const y = int(url.searchParams.get("year"), new Date().getUTCFullYear());
      const r = isoYear(Math.min(2100, Math.max(2000, y)));
      return plain(() => LV.holidays(c, co.id, r.from, r.to));
    });
    coPost("/workforce/holidays", async (c, co, a, b) => {
      await requireRole(c, co, a, LEAVE_SETUP, "adding a company holiday");
      return plain(() => LV.addHoliday(c, scopeOf(co, a), { day: str(b.day, 10), name: str(b.name, 80), storeClosed: b.storeClosed !== false,
        paid: b.paid !== false, hours: b.hours != null && b.hours !== "" ? Number(b.hours) : undefined }));
    });
    coGet("/workforce/absent-today", async (c, co, url, _m, p) => {
      await canRead(c, co, p, LEAVE_MANAGE, "who is absent today");
      return plain(() => LV.absentToday(c, co.id, uuid(url.searchParams.get("location"))));
    });
  },
};
