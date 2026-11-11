// Fleet and delivery: vehicles, inspections, drivers, zones and windows,
// booking stops against capacity, building routes, the driver's day, proof
// of delivery, cash on delivery, and the customer messages that go with it.
//
// This module never writes stock_level or the ledger itself. Handing goods
// over goes through inventory.fulfilLines and ar.invoiceFulfilment; cash
// taken at the door goes through a customer_receipt and ar.postReceipt.
// Routing maths is in routing.ts and has no database in it.

import { timeZoneFor } from "./clock.ts";
import { partialSetWarning } from "./configurator.ts";
import { createHash, randomBytes } from "node:crypto";
import * as messaging from "./messaging.ts";
import { q, one, audit, type Client, type Scope } from "./db.ts";
import * as inventory from "./inventory.ts";
import * as wms from "./wms.ts";
import { postReceipt, invoiceFulfilment } from "./ar.ts";
import { accrueCommissions } from "./workforce.ts";
import * as R from "./routing.ts";
import { geocodeAddress, setManualGeo, GeocodeError } from "./geocode.ts";
import { loadGate, pendingPieces, unloadLeftovers } from "./loading.ts";
import * as haul from "./haulaway.ts";

export class FleetError extends Error {}
function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new FleetError(message);
}

const UUIDRX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUIDRX.test(v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const n = (v: unknown) => Number(v ?? 0);
const STOCKED = ["stock", "configurable", "special_order"];

// ------------------------------------------------------------- settings --

export type Settings = {
  tz: string; avgMph: number; roadFactor: number; startMin: number; endMin: number;
  baseMin: number; perPieceMin: number; perStairPieceMin: number;
  laborHourMinor: bigint; fuelPriceMinor: bigint; leadDays: number; linkDays: number;
};

export async function settings(c: Client, entityId: string): Promise<Settings> {
  const r = await q<Record<string, string | number>>(c, `
    select time_zone, avg_mph, road_factor,
           (extract(hour from route_start)*60 + extract(minute from route_start))::int start_min,
           (extract(hour from route_end)*60 + extract(minute from route_end))::int end_min,
           base_service_min, per_piece_min, per_stair_piece_min, labor_cost_hour_minor, fuel_price_minor,
           booking_lead_days, link_valid_days
      from fleet_setting where entity_id = $1`, [entityId]);
  const x = r[0];
  // no delivery settings yet: the company's business zone (clock.ts) and its pack's minutes per stop (fleet.service_minutes)
  if (!x) {
    const sm = (await q<{ value: { base?: number; per_piece?: number; per_stair_flight?: number } }>(c,
      `select value from entity_setting where entity_id = $1 and key = 'fleet.service_minutes' and jsonb_typeof(value) = 'object'`, [entityId]))[0]?.value ?? {};
    const mins = (v: unknown, d: number) => { const k = Number(v); return Number.isFinite(k) && k >= 0 ? Math.trunc(k) : d; };
    return { tz: await timeZoneFor(c, entityId), avgMph: 30, roadFactor: 1.3, startMin: 450, endMin: 1110, baseMin: mins(sm.base, 10),
    perPieceMin: mins(sm.per_piece, 4), perStairPieceMin: mins(sm.per_stair_flight, 3), laborHourMinor: 2200n, fuelPriceMinor: 389n, leadDays: 1, linkDays: 14 };
  }
  return { tz: String(x.time_zone), avgMph: n(x.avg_mph), roadFactor: n(x.road_factor), startMin: n(x.start_min),
    endMin: n(x.end_min), baseMin: n(x.base_service_min), perPieceMin: n(x.per_piece_min),
    perStairPieceMin: n(x.per_stair_piece_min), laborHourMinor: BigInt(x.labor_cost_hour_minor),
    fuelPriceMinor: BigInt(x.fuel_price_minor), leadDays: n(x.booking_lead_days), linkDays: n(x.link_valid_days) };
}

export const cfgOf = (s: Settings): R.Cfg => ({ avgMph: s.avgMph, roadFactor: s.roadFactor, baseMin: s.baseMin,
  perPieceMin: s.perPieceMin, perStairPieceMin: s.perStairPieceMin, startMin: s.startMin, endMin: s.endMin });

/** Today's date and the minute of the day, in the company's time zone. */
export async function localNow(c: Client, tz: string): Promise<{ day: string; min: number }> {
  const r = await one<{ d: string; m: number }>(c, `
    select (now() at time zone $1)::date::text d,
           (extract(hour from now() at time zone $1)*60 + extract(minute from now() at time zone $1))::int m
    /* unscoped: the clock */`, [tz]);
  return { day: r.d, min: r.m };
}

const addDays = (day: string, k: number) => {
  const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10);
};
const dow = (day: string) => new Date(day + "T12:00:00Z").getUTCDay();
const dayWords = (day: string) => new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

async function nextNo(c: Client, entityId: string, kind: string, prefix: string): Promise<string> {
  return (await one<{ n: string }>(c, `select next_doc_no($1, $2, $3) n /* unscoped: numbering function takes the entity */`,
    [entityId, kind, prefix])).n;
}

async function companyName(c: Client, entityId: string): Promise<string> {
  const r = await q<{ name: string }>(c, `select name from entity where id = $1 /* unscoped: the company's own name */`, [entityId]);
  return r[0]?.name ?? "";
}

// ------------------------------------------------------------- vehicles --

/** Is this truck or person already on another live route that day? Returns that route's number. */
async function busyElsewhere(c: Client, entityId: string, day: string, exceptRouteId: string | null,
  who: { vehicleId?: string | null; personId?: string | null }): Promise<string | null> {
  if (!who.vehicleId && !who.personId) return null;
  const r = await q<{ number: string }>(c, `
    select number from delivery_route
     where entity_id = $1 and route_on = $2 and status <> 'cancelled' and ($3::uuid is null or id <> $3)
       and (($4::uuid is not null and vehicle_id = $4) or ($5::uuid is not null and (driver_id = $5 or helper_id = $5)))
     order by number limit 1`, [entityId, day, exceptRouteId, who.vehicleId ?? null, who.personId ?? null]);
  return r[0]?.number ?? null;
}

/** "Alicia Gomez at 12 Oak Ln, Springfield" -- how a stop without a map point is named to a person. */
const whereWords = (x: { customer?: string | null; line1?: string | null; city?: string | null }) =>
  `${x.customer ?? "the customer"} at ${x.line1 ?? "an address"}${x.city ? ", " + x.city : ""}`;

export const VEHICLE_KINDS = ["box_truck", "van", "pickup", "straight_truck", "tractor", "trailer"];

export async function vehicles(c: Client, entityId: string) {
  const rows = await q(c, `
    select v.id, v.unit_no, v.vin_last6, v.plate, v.plate_state, v.kind, v.make_model, v.model_year,
           v.home_location_id, l.name home_name, v.cube_ft::float cube_ft, v.max_weight_lb::float max_weight_lb,
           v.max_stops, v.crew_size, v.mpg::float mpg, v.requires_cdl, v.status, v.oos_reason, v.odometer_mi,
           v.geotab_device_id,
           (select d.status from dvir d where d.entity_id = v.entity_id and d.vehicle_id = v.id
             order by d.submitted_at desc limit 1) last_dvir,
           (select d.submitted_at from dvir d where d.entity_id = v.entity_id and d.vehicle_id = v.id
             order by d.submitted_at desc limit 1) last_dvir_at
      from vehicle v join location l on l.id = v.home_location_id
     where v.entity_id = $1
     order by v.status = 'retired', v.unit_no`, [entityId]);
  const due = await maintenanceDue(c, entityId);
  return rows.map((v) => ({ ...v, maintenance: due.filter((d) => d.vehicle_id === v.id) }));
}

export async function vehicle(c: Client, entityId: string, id: string) {
  need(isId(id), "no such vehicle");
  const all = await vehicles(c, entityId);
  const v = all.find((x) => x.id === id);
  need(v, "no such vehicle");
  const [schedules, services, fuel, dvirs, odo] = await Promise.all([
    q(c, `select id, task, every_miles, every_days, last_done_mi, last_done_on::text last_done_on, active
            from maintenance_schedule where entity_id = $1 and vehicle_id = $2 order by task`, [entityId, id]),
    q(c, `select id, performed_on::text performed_on, odometer_mi, vendor_name, description, cost_minor
            from service_record where entity_id = $1 and vehicle_id = $2 order by performed_on desc, created_at desc limit 50`, [entityId, id]),
    q(c, `select f.id, f.filled_on::text filled_on, f.gallons::float gallons, f.cost_minor, f.odometer_mi, f.station, u.name driver
            from fuel_log f left join app_user u on u.id = f.driver_id
           where f.entity_id = $1 and f.vehicle_id = $2 order by f.filled_on desc, f.created_at desc limit 50`, [entityId, id]),
    q(c, `select d.id, d.kind, d.status, d.defects, d.safety_failed, d.items, d.odometer_mi, d.submitted_at,
                 u.name driver, cu.name cleared_by, d.cleared_at, d.clear_note
            from dvir d join app_user u on u.id = d.driver_id left join app_user cu on cu.id = d.cleared_by
           where d.entity_id = $1 and d.vehicle_id = $2 order by d.submitted_at desc limit 30`, [entityId, id]),
    q(c, `select reading_mi, read_at, source from vehicle_odometer where entity_id = $1 and vehicle_id = $2
           order by read_at desc limit 20`, [entityId, id]),
  ]);
  const cost = await q<{ s: string }>(c, `
    select (coalesce((select sum(cost_minor) from service_record where entity_id = $1 and vehicle_id = $2 and performed_on > business_today($1) - 365),0)
          + coalesce((select sum(cost_minor) from fuel_log where entity_id = $1 and vehicle_id = $2 and filled_on > business_today($1) - 365),0))::text s`,
    [entityId, id]);
  return { ...v, schedules, services, fuel, dvirs, odometer: odo, costYearMinor: cost[0].s };
}

export async function addVehicle(c: Client, scope: Scope, b: Record<string, unknown>) {
  const unit = String(b.unitNo ?? "").trim();
  need(unit, "give the truck a unit number");
  const vin = String(b.vinLast6 ?? "").trim().toUpperCase();
  need(/^[A-HJ-NPR-Z0-9]{6}$/.test(vin), "the VIN is kept as its last six characters only (letters and digits, no I, O or Q)");
  const kind = String(b.kind ?? "box_truck");
  need(VEHICLE_KINDS.includes(kind), `a vehicle is one of: ${VEHICLE_KINDS.join(", ").replace(/_/g, " ")}`);
  need(isId(b.homeLocationId), "pick the vehicle's home location");
  const home = await q(c, `select id from location where entity_id = $1 and id = $2`, [scope.entityId, b.homeLocationId]);
  need(home.length, "that location is not one of this company's");
  const dupUnit = await q(c, `select 1 from vehicle where entity_id = $1 and lower(unit_no) = lower($2)`, [scope.entityId, unit]);
  need(!dupUnit.length, `there is already a vehicle numbered ${unit}`);
  const gt = String(b.geotabDeviceId ?? "").trim();
  if (gt) {
    const dupG = await q<{ unit_no: string }>(c, `select unit_no from vehicle where entity_id = $1 and geotab_device_id = $2`, [scope.entityId, gt]);
    need(!dupG.length, `Geotab device ${gt} is already on unit ${dupG[0]?.unit_no}`);
  }
  const cube = n(b.cubeFt), wt = n(b.maxWeightLb);
  need(cube > 0, "give the cargo space in cubic feet");
  need(wt > 0, "give the most weight it can carry, in pounds");
  const r = await one<{ id: string }>(c, `
    insert into vehicle (entity_id, unit_no, vin_last6, plate, plate_state, kind, make_model, model_year, home_location_id,
                         cube_ft, max_weight_lb, max_stops, crew_size, mpg, requires_cdl, odometer_mi, geotab_device_id)
    values ($1,$2,$3,nullif($4,''),nullif($5,''),$6,nullif($7,''),$8,$9,$10,$11,$12,$13,$14,$15,$16,nullif($17,'')) returning id`,
    [scope.entityId, unit, vin, String(b.plate ?? "").trim(), String(b.plateState ?? "").trim().toUpperCase().slice(0, 2),
     kind, String(b.makeModel ?? "").trim(), b.modelYear ? n(b.modelYear) : null, b.homeLocationId, cube, wt,
     Math.max(1, n(b.maxStops) || 14), Math.min(4, Math.max(1, n(b.crewSize) || 2)), n(b.mpg) || 9, b.requiresCdl === true,
     Math.max(0, n(b.odometerMi)), String(b.geotabDeviceId ?? "").trim()]);
  return r;
}

/** Change a vehicle's status. Back into service only once any failed inspection is cleared (the database holds this). */
export async function setVehicleStatus(c: Client, scope: Scope, id: string, status: string, reason: string) {
  need(["active", "out_of_service", "retired"].includes(status), "a vehicle is active, out of service or retired");
  need(status === "active" || reason.trim(), "say why it is coming off the road");
  const r = await q(c, `update vehicle set status = $3, oos_reason = case when $3 = 'active' then null else $4 end
                         where entity_id = $1 and id = $2 returning id`, [scope.entityId, id, status, reason.trim()]);
  need(r.length, "no such vehicle");
  return { status };
}

export async function recordOdometer(c: Client, scope: Scope, vehicleId: string, reading: number, source = "manual") {
  need(Number.isFinite(reading) && reading >= 0, "an odometer reading is a whole number of miles");
  const v = await q(c, `select id from vehicle where entity_id = $1 and id = $2`, [scope.entityId, vehicleId]);
  need(v.length, "no such vehicle");
  await c.query(`insert into vehicle_odometer (entity_id, vehicle_id, reading_mi, source, recorded_by) values ($1,$2,$3,$4,$5)`,
    [scope.entityId, vehicleId, Math.round(reading), source, scope.actor.id || null]);
}

export async function addSchedule(c: Client, scope: Scope, vehicleId: string, b: Record<string, unknown>) {
  const task = String(b.task ?? "").trim();
  need(task, "name the maintenance task");
  const mi = b.everyMiles ? n(b.everyMiles) : null, days = b.everyDays ? n(b.everyDays) : null;
  need((mi && mi > 0) || (days && days > 0), "a schedule repeats every so many miles, days, or both");
  const v = await q<{ odometer_mi: number }>(c, `select odometer_mi from vehicle where entity_id = $1 and id = $2`, [scope.entityId, vehicleId]);
  need(v.length, "no such vehicle");
  return one(c, `insert into maintenance_schedule (entity_id, vehicle_id, task, every_miles, every_days, last_done_mi, last_done_on)
                 values ($1,$2,$3,$4,$5,$6,coalesce($7::date, business_today($1))) returning id`,
    [scope.entityId, vehicleId, task, mi, days, b.lastDoneMi != null ? n(b.lastDoneMi) : v[0].odometer_mi,
     DAY.test(String(b.lastDoneOn ?? "")) ? b.lastDoneOn : null]);
}

export async function recordService(c: Client, scope: Scope, vehicleId: string, b: Record<string, unknown>, costMinor: bigint) {
  const desc = String(b.description ?? "").trim();
  need(desc, "say what was done");
  need(costMinor >= 0n, "a service cost is not negative");
  const on = DAY.test(String(b.performedOn ?? "")) ? String(b.performedOn) : null;
  const v = await q<{ odometer_mi: number }>(c, `select odometer_mi from vehicle where entity_id = $1 and id = $2`, [scope.entityId, vehicleId]);
  need(v.length, "no such vehicle");
  let sched: string | null = null;
  if (b.scheduleId) {
    need(isId(b.scheduleId), "no such maintenance schedule");
    const s = await q(c, `select id from maintenance_schedule where entity_id = $1 and id = $2 and vehicle_id = $3`, [scope.entityId, b.scheduleId, vehicleId]);
    need(s.length, "that schedule is for another vehicle");
    sched = String(b.scheduleId);
  }
  const odo = b.odometerMi != null && b.odometerMi !== "" ? n(b.odometerMi) : null;
  if (odo != null && odo > v[0].odometer_mi) await recordOdometer(c, scope, vehicleId, odo, "service");
  const r = await one<{ id: string; performed_on: string }>(c, `
    insert into service_record (entity_id, vehicle_id, schedule_id, performed_on, odometer_mi, vendor_name, description, cost_minor, recorded_by)
    values ($1,$2,$3,coalesce($4::date, business_today($1)),$5,nullif($6,''),$7,$8,$9) returning id, performed_on::text`,
    [scope.entityId, vehicleId, sched, on, odo ?? v[0].odometer_mi, String(b.vendorName ?? "").trim(), desc, costMinor.toString(), scope.actor.id || null]);
  if (sched) await c.query(`update maintenance_schedule set last_done_mi = $3, last_done_on = $4 where entity_id = $1 and id = $2`,
    [scope.entityId, sched, odo ?? v[0].odometer_mi, r.performed_on]);
  return r;
}

export async function logFuel(c: Client, scope: Scope, vehicleId: string, b: Record<string, unknown>, costMinor: bigint) {
  const gal = n(b.gallons);
  need(gal > 0 && gal < 500, "give the gallons pumped");
  need(costMinor > 0n, "give what the fill-up cost");
  const v = await q<{ odometer_mi: number }>(c, `select odometer_mi from vehicle where entity_id = $1 and id = $2`, [scope.entityId, vehicleId]);
  need(v.length, "no such vehicle");
  const odo = b.odometerMi != null && b.odometerMi !== "" ? n(b.odometerMi) : null;
  if (odo != null) await recordOdometer(c, scope, vehicleId, odo, "fuel");
  return one(c, `insert into fuel_log (entity_id, vehicle_id, driver_id, filled_on, gallons, cost_minor, odometer_mi, station)
                 values ($1,$2,$3,coalesce($4::date,business_today($1)),$5,$6,$7,nullif($8,'')) returning id`,
    [scope.entityId, vehicleId, scope.actor.id || null, DAY.test(String(b.filledOn ?? "")) ? b.filledOn : null, gal,
     costMinor.toString(), odo, String(b.station ?? "").trim()]);
}

/** Every active schedule with how far it is from due. due = within 500 miles or 14 days; overdue = past it. */
export async function maintenanceDue(c: Client, entityId: string) {
  const rows = await q<{ id: string; vehicle_id: string; unit_no: string; task: string; every_miles: number | null; every_days: number | null;
    miles_left: number | null; days_left: number | null; due_on: string | null }>(c, `
    select m.id, m.vehicle_id, v.unit_no, m.task, m.every_miles, m.every_days,
           case when m.every_miles is not null then m.last_done_mi + m.every_miles - v.odometer_mi end miles_left,
           case when m.every_days is not null then (m.last_done_on + m.every_days) - business_today($1) end days_left,
           case when m.every_days is not null then (m.last_done_on + m.every_days)::text end due_on
      from maintenance_schedule m join vehicle v on v.id = m.vehicle_id
     where m.entity_id = $1 and m.active and v.status <> 'retired'
     order by v.unit_no, m.task`, [entityId]);
  return rows.map((r) => {
    const overdue = (r.miles_left != null && r.miles_left <= 0) || (r.days_left != null && r.days_left <= 0);
    const soon = !overdue && ((r.miles_left != null && r.miles_left <= 500) || (r.days_left != null && r.days_left <= 14));
    return { ...r, state: overdue ? "overdue" : soon ? "due" : "ok" };
  });
}

// ------------------------------------------------------ inspections (DVIR) --

export const DVIR_ITEMS: { code: string; label: string; safety: boolean }[] = [
  { code: "brakes", label: "Service and parking brakes", safety: true },
  { code: "tires", label: "Tires and wheels: tread, inflation, lug nuts", safety: true },
  { code: "lights", label: "Headlights, brake lights, turn signals, flashers", safety: true },
  { code: "steering", label: "Steering", safety: true },
  { code: "horn", label: "Horn", safety: true },
  { code: "wipers", label: "Wipers and washer fluid", safety: true },
  { code: "mirrors", label: "Mirrors and windshield", safety: true },
  { code: "leaks", label: "No fuel, oil or coolant leaks", safety: true },
  { code: "liftgate", label: "Liftgate or ramp works and locks", safety: true },
  { code: "emergency", label: "Fire extinguisher, triangles, first-aid kit", safety: true },
  { code: "straps", label: "Load straps, pads and dollies", safety: false },
  { code: "body", label: "Body, doors and cargo area", safety: false },
  { code: "cab", label: "Cab clean, paperwork and registration on board", safety: false },
];

export async function submitDvir(c: Client, scope: Scope, b: Record<string, unknown>) {
  need(isId(b.vehicleId), "pick the truck you inspected");
  const v = await q<{ unit_no: string; status: string }>(c, `select unit_no, status from vehicle where entity_id = $1 and id = $2`, [scope.entityId, b.vehicleId]);
  need(v.length, "no such vehicle");
  need(v[0].status !== "retired", "that vehicle is retired");
  const driverId = scope.actor.id;
  need(driverId, "an inspection is filed by a person");
  const kind = b.kind === "post_trip" ? "post_trip" : "pre_trip";
  const given = new Map<string, { ok: boolean; note: string }>();
  for (const x of Array.isArray(b.items) ? b.items as Record<string, unknown>[] : []) {
    given.set(String(x.code), { ok: x.ok === true, note: String(x.note ?? "").trim().slice(0, 300) });
  }
  const missing = DVIR_ITEMS.filter((i) => !given.has(i.code));
  need(!missing.length, `answer every item; still open: ${missing.map((i) => i.label.toLowerCase()).join("; ")}`);
  const items = DVIR_ITEMS.map((i) => ({ ...i, ...given.get(i.code)! }));
  const bad = items.filter((i) => !i.ok);
  const noNote = bad.filter((i) => !i.note);
  need(!noNote.length, `describe what is wrong with: ${noNote.map((i) => i.label.toLowerCase()).join("; ")}`);
  const safety = bad.some((i) => i.safety);
  const status = safety ? "failed" : bad.length ? "defects_noted" : "passed";
  const odo = b.odometerMi != null && b.odometerMi !== "" ? n(b.odometerMi) : null;
  if (odo != null) await recordOdometer(c, scope, String(b.vehicleId), odo, "dvir");
  const r = await one<{ id: string }>(c, `
    insert into dvir (entity_id, vehicle_id, driver_id, kind, odometer_mi, items, defects, safety_failed, status)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [scope.entityId, b.vehicleId, driverId, kind, odo, JSON.stringify(items), bad.length, safety, status]);
  return { id: r.id, status, defects: bad.length, outOfService: safety,
    message: safety ? `Unit ${v[0].unit_no} is out of service until a manager clears: ${bad.filter((i) => i.safety).map((i) => i.label).join("; ")}.` : null };
}

export async function clearDvir(c: Client, scope: Scope, dvirId: string, note: string) {
  need(isId(dvirId), "no such inspection");
  need(note.trim(), "say what was fixed, so the next driver knows");
  const d = await q<{ vehicle_id: string; driver_id: string; status: string }>(c,
    `select vehicle_id, driver_id, status from dvir where entity_id = $1 and id = $2 for update`, [scope.entityId, dvirId]);
  need(d.length, "no such inspection");
  need(d[0].status === "failed", "only a failed inspection needs clearing");
  need(d[0].driver_id !== scope.actor.id, "the driver who reported a defect cannot also clear it; a manager does");
  await c.query(`update dvir set status = 'cleared', cleared_by = $3, cleared_at = now(), clear_note = $4 where entity_id = $1 and id = $2`,
    [scope.entityId, dvirId, scope.actor.id, note.trim()]);
  const left = await q(c, `select 1 from dvir where entity_id = $1 and vehicle_id = $2 and status = 'failed'`, [scope.entityId, d[0].vehicle_id]);
  if (!left.length) {
    await c.query(`update vehicle set status = 'active' where entity_id = $1 and id = $2 and status = 'out_of_service'`, [scope.entityId, d[0].vehicle_id]);
  }
  return { backInService: !left.length };
}

// ------------------------------------------------------------- drivers --

export async function drivers(c: Client, entityId: string, tenantId: string, onDay?: string) {
  return q(c, `
    select u.id, u.name, u.email, p.kind, p.license_class, p.license_state, p.license_last4,
           p.license_expires::text license_expires, p.medical_expires::text medical_expires, p.phone,
           p.default_helper_id, hu.name default_helper, p.hourly_cost_minor, coalesce(p.active, false) active,
           p.app_user_id is not null set_up,
           (p.kind = 'driver' and p.license_expires < coalesce($3::date, business_today($1))) license_expired,
           (p.kind = 'driver' and p.license_expires between coalesce($3::date, business_today($1)) and coalesce($3::date, business_today($1)) + 30) license_expiring
      from app_user u
      join role_grant g on g.app_user_id = u.id and g.role in ('driver','technician')
                       and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = $2))
      left join driver_profile p on p.entity_id = $1 and p.app_user_id = u.id
      left join app_user hu on hu.id = p.default_helper_id
     where u.status = 'active'
     group by u.id, u.name, u.email, p.entity_id, p.app_user_id, hu.name
     order by u.name`, [entityId, tenantId, onDay ?? null]);
}

export async function saveDriver(c: Client, scope: Scope, b: Record<string, unknown>) {
  need(isId(b.personId), "pick the person");
  const held = await q(c, `
    select 1 from role_grant g join app_user u on u.id = g.app_user_id
     where g.app_user_id = $2 and g.role in ('driver','technician') and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = $3))`,
    [scope.entityId, b.personId, scope.tenantId]);
  need(held.length, "give that person the driver role in Setup first");
  const kind = b.kind === "helper" ? "helper" : "driver";
  const cls = b.licenseClass ? String(b.licenseClass).toUpperCase() : null;
  const exp = DAY.test(String(b.licenseExpires ?? "")) ? String(b.licenseExpires) : null;
  if (kind === "driver") {
    need(cls && ["A", "B", "C", "D"].includes(cls), "a driver needs a licence class (A, B, C or D)");
    need(exp, "a driver needs the licence expiry date");
  }
  const last4 = String(b.licenseLast4 ?? "").trim().toUpperCase();
  need(!last4 || /^[A-Z0-9]{4}$/.test(last4), "keep only the last four characters of the licence number");
  const helper = b.defaultHelperId ? String(b.defaultHelperId) : null;
  need(!helper || isId(helper), "no such helper");
  need(helper !== b.personId, "a driver is not their own helper");
  await c.query(`
    insert into driver_profile (entity_id, app_user_id, kind, license_class, license_state, license_last4, license_expires,
                                medical_expires, phone, default_helper_id, hourly_cost_minor, active)
    values ($1,$2,$3,$4,nullif($5,''),nullif($6,''),$7,$8,nullif($9,''),$10,$11,$12)
    on conflict (entity_id, app_user_id) do update set kind = excluded.kind, license_class = excluded.license_class,
      license_state = excluded.license_state, license_last4 = excluded.license_last4, license_expires = excluded.license_expires,
      medical_expires = excluded.medical_expires, phone = excluded.phone, default_helper_id = excluded.default_helper_id,
      hourly_cost_minor = excluded.hourly_cost_minor, active = excluded.active`,
    [scope.entityId, b.personId, kind, cls, String(b.licenseState ?? "").toUpperCase().slice(0, 2), last4, exp,
     DAY.test(String(b.medicalExpires ?? "")) ? b.medicalExpires : null, String(b.phone ?? "").trim(), helper,
     b.hourlyCostMinor != null ? String(b.hourlyCostMinor) : null, b.active !== false]);
  return { ok: true };
}

// ------------------------------------------------------- zones/windows --

export async function zones(c: Client, entityId: string) {
  const z = await q(c, `
    select z.id, z.code, z.name, z.dc_location_id, l.name dc_name, z.postal_codes, z.days, z.fee_minor, z.active
      from delivery_zone z join location l on l.id = z.dc_location_id
     where z.entity_id = $1 order by z.active desc, z.code`, [entityId]);
  const w = await q(c, `
    select id, zone_id, label, to_char(starts,'HH24:MI') starts, to_char(ends,'HH24:MI') ends, stops_cap, pieces_cap,
           cube_cap::float cube_cap, weight_cap_lb::float weight_cap_lb, labor_min_cap, active
      from delivery_window where entity_id = $1 order by starts`, [entityId]);
  const blackouts = await q(c, `select b.id, b.zone_id, b.day::text as day, b.reason from delivery_blackout b
                                 where b.entity_id = $1 and b.day >= business_today($1) and b.released_at is null order by b.day`, [entityId]);
  return { zones: z.map((x) => ({ ...x, windows: w.filter((y) => y.zone_id === x.id) })), blackouts };
}

export async function saveZone(c: Client, scope: Scope, b: Record<string, unknown>) {
  const code = String(b.code ?? "").trim().toUpperCase(), name = String(b.name ?? "").trim();
  need(code && name, "a zone needs a short code and a name");
  need(isId(b.dcLocationId), "pick the warehouse that serves the zone");
  const dc = await q(c, `select id from location where entity_id = $1 and id = $2`, [scope.entityId, b.dcLocationId]);
  need(dc.length, "that location is not one of this company's");
  const postals = [...new Set((Array.isArray(b.postalCodes) ? b.postalCodes : String(b.postalCodes ?? "").split(/[\s,;]+/))
    .map((p) => String(p).trim().slice(0, 5)).filter(Boolean))];
  need(postals.length && postals.every((p) => /^\d{5}$/.test(p)), "list the zone's five-digit postal codes");
  const days = (Array.isArray(b.days) ? b.days : [1, 2, 3, 4, 5, 6]).map(Number).filter((d) => d >= 0 && d <= 6);
  need(days.length, "pick at least one delivery day");
  const fee = BigInt(String(b.feeMinor ?? 0));
  need(fee >= 0n, "a delivery fee is not negative");
  const dupZ = await q(c, `select 1 from delivery_zone where entity_id = $1 and code = $2 and ($3::uuid is null or id <> $3)`,
    [scope.entityId, code, b.id && isId(b.id) ? b.id : null]);
  need(!dupZ.length, `there is already a zone with the code ${code}`);
  if (b.id) {
    need(isId(b.id), "no such zone");
    const r = await q(c, `update delivery_zone set code=$3, name=$4, dc_location_id=$5, postal_codes=$6, days=$7, fee_minor=$8, active=$9
                           where entity_id = $1 and id = $2 returning id`,
      [scope.entityId, b.id, code, name, b.dcLocationId, postals, days, fee.toString(), b.active !== false]);
    need(r.length, "no such zone");
    return r[0];
  }
  return one(c, `insert into delivery_zone (entity_id, code, name, dc_location_id, postal_codes, days, fee_minor)
                 values ($1,$2,$3,$4,$5,$6,$7) returning id`, [scope.entityId, code, name, b.dcLocationId, postals, days, fee.toString()]);
}

export async function saveWindow(c: Client, scope: Scope, zoneId: string, b: Record<string, unknown>) {
  need(isId(zoneId), "no such zone");
  const z = await q(c, `select id from delivery_zone where entity_id = $1 and id = $2`, [scope.entityId, zoneId]);
  need(z.length, "no such zone");
  const hm = /^([01]?\d|2[0-3]):([0-5]\d)$/;
  need(hm.test(String(b.starts)) && hm.test(String(b.ends)), "give the window's start and end as HH:MM");
  need(String(b.ends).padStart(5, "0") > String(b.starts).padStart(5, "0"), "a window ends after it starts");
  const cap = (v: unknown) => (v === null || v === undefined || v === "" ? null : Math.max(0, n(v)));
  const label = String(b.label ?? "").trim() || `${b.starts}–${b.ends}`;
  const dupW = await q<{ label: string }>(c, `select label from delivery_window where entity_id = $1 and zone_id = $2 and starts = $3::time and ($4::uuid is null or id <> $4)`,
    [scope.entityId, zoneId, b.starts, b.id && isId(b.id) ? b.id : null]);
  need(!dupW.length, `this zone already has a window starting at ${b.starts} (${dupW[0]?.label}); change that one instead`);
  if (b.id) {
    need(isId(b.id), "no such window");
    const r = await q(c, `update delivery_window set label=$4, starts=$5, ends=$6, stops_cap=$7, pieces_cap=$8, cube_cap=$9, labor_min_cap=$10, active=$11,
                                  weight_cap_lb=$12
                           where entity_id = $1 and id = $2 and zone_id = $3 returning id`,
      [scope.entityId, b.id, zoneId, label, b.starts, b.ends, cap(b.stopsCap), cap(b.piecesCap), cap(b.cubeCap), cap(b.laborMinCap), b.active !== false, cap(b.weightCapLb)]);
    need(r.length, "no such window");
    return r[0];
  }
  return one(c, `insert into delivery_window (entity_id, zone_id, label, starts, ends, stops_cap, pieces_cap, cube_cap, labor_min_cap, weight_cap_lb)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [scope.entityId, zoneId, label, b.starts, b.ends, cap(b.stopsCap), cap(b.piecesCap), cap(b.cubeCap), cap(b.laborMinCap), cap(b.weightCapLb)]);
}

export async function addBlackout(c: Client, scope: Scope, b: Record<string, unknown>) {
  need(DAY.test(String(b.day ?? "")), "pick the day");
  need(String(b.reason ?? "").trim(), "say why (holiday, inventory count)");
  if (b.zoneId) {
    need(isId(b.zoneId), "no such zone");
    need((await q(c, `select 1 from delivery_zone where entity_id = $1 and id = $2`, [scope.entityId, b.zoneId])).length, "no such zone");
  }
  return one(c, `insert into delivery_blackout (entity_id, zone_id, day, reason) values ($1,$2,$3,$4) returning id`,
    [scope.entityId, b.zoneId || null, b.day, String(b.reason).trim()]);
}

export async function zoneForPostal(c: Client, entityId: string, postal: string) {
  const r = await q<{ id: string; code: string; name: string; dc_location_id: string; days: number[]; fee_minor: string }>(c, `
    select id, code, name, dc_location_id, days, fee_minor from delivery_zone
     where entity_id = $1 and active and $2 = any(postal_codes)`, [entityId, String(postal).trim().slice(0, 5)]);
  return r[0] ?? null;
}

export type Slot = { day: string; windowId: string; label: string; startMin: number; endMin: number;
  used: { stops: number; pieces: number; cube: number; labor: number; weight: number };
  caps: { stops: number | null; pieces: number | null; cube: number | null; labor: number | null; weight: number | null };
  fits: boolean; full: boolean };

/** Each open window for a zone over the next days, with what is left and whether a stop of this size fits. */
export async function availability(c: Client, entityId: string, zoneId: string, from: string, days: number,
  size: { pieces: number; cube: number; labor: number; weight?: number } = { pieces: 0, cube: 0, labor: 0 }): Promise<Slot[]> {
  need(DAY.test(from), "pick a start day");
  const z = await q<{ days: number[] }>(c, `select days from delivery_zone where entity_id = $1 and id = $2 and active`, [entityId, zoneId]);
  need(z.length, "that zone is not active");
  const rows = await q<Record<string, string | number | null>>(c, `
    with d as (select g::date as day from generate_series($3::date, $3::date + ($4::int - 1), interval '1 day') g)
    select d.day::text as day, w.id window_id, w.label,
           (extract(hour from w.starts)*60 + extract(minute from w.starts))::int start_min,
           (extract(hour from w.ends)*60 + extract(minute from w.ends))::int end_min,
           w.stops_cap, w.pieces_cap, w.cube_cap::float cube_cap, w.labor_min_cap, w.weight_cap_lb::float weight_cap,
           coalesce(u.n,0)::int n, coalesce(u.pcs,0)::int pcs, coalesce(u.cube,0)::float cube, coalesce(u.lab,0)::int lab,
           coalesce(u.wt,0)::float wt,
           exists (select 1 from delivery_blackout b where b.entity_id = $1 and b.day = d.day and (b.zone_id is null or b.zone_id = $2) and b.released_at is null) blackout,
           exists (select 1 from delivery_day_lock k where k.entity_id = $1 and k.day = d.day and k.unlocked_at is null) locked
      from d cross join delivery_window w
      left join lateral (select count(*) n, sum(s.pieces) pcs, sum(s.cube_ft) cube, sum(s.service_min) lab, sum(s.weight_lb) wt
                           from delivery_stop s
                          where s.entity_id = $1 and s.window_id = w.id and s.scheduled_on = d.day
                            and s.status <> 'cancelled' and not s.over_capacity_ok) u on true
     where w.entity_id = $1 and w.zone_id = $2 and w.active
     order by d.day, w.starts`, [entityId, zoneId, from, Math.min(Math.max(days, 1), 60)]);
  const zd = z[0].days.map(Number);
  const now = await localNow(c, (await settings(c, entityId)).tz);
  return rows.filter((r) => !r.blackout && zd.includes(dow(String(r.day))) && !(String(r.day) === now.day && n(r.end_min) <= now.min)).map((r) => {
    const caps = { stops: r.stops_cap as number | null, pieces: r.pieces_cap as number | null, cube: r.cube_cap as number | null, labor: r.labor_min_cap as number | null,
      weight: r.weight_cap as number | null };
    const used = { stops: n(r.n), pieces: n(r.pcs), cube: n(r.cube), labor: n(r.lab), weight: n(r.wt) };
    const fits = (caps.stops == null || used.stops + 1 <= caps.stops) && (caps.pieces == null || used.pieces + size.pieces <= caps.pieces)
      && (caps.cube == null || used.cube + size.cube <= caps.cube + 1e-9) && (caps.labor == null || used.labor + size.labor <= caps.labor)
      && (caps.weight == null || used.weight + Math.round(size.weight ?? 0) <= caps.weight + 1e-9);
    const full = caps.stops != null && used.stops >= caps.stops;
    return { day: String(r.day), windowId: String(r.window_id), label: String(r.label), startMin: n(r.start_min), endMin: n(r.end_min), used, caps, fits, full, locked: !!r.locked };
  });
}

/** Open windows for a cart at the register: the zone comes from the address, the size from what is going on the truck. */
export async function availabilityForCart(c: Client, entityId: string, addressId: string, items: { productId: string; qty: number }[], days = 21) {
  need(isId(addressId), "pick the delivery address first");
  const a = await q<{ postal: string; stairs: number }>(c, `select postal, stairs from customer_address where entity_id = $1 and id = $2`, [entityId, addressId]);
  need(a.length, "pick the delivery address first");
  const zone = await zoneForPostal(c, entityId, a[0].postal);
  need(zone, `postal code ${a[0].postal} is outside every delivery zone; add it to a zone in Delivery, or make it a pickup`);
  const ids = items.map((x) => x.productId).filter(isId);
  const prods = ids.length ? await q<{ id: string; pieces: number; cube: number; weight: number }>(c, `
    select id, coalesce((attributes->>'pieces')::int, 1) pieces, coalesce(cubic_ft, 0)::float cube, coalesce(weight_lb, 0)::float weight from product
     where entity_id = $1 and id = any($2) and kind = any($3) and ship_class <> 'none'`, [entityId, ids, STOCKED]) : [];
  let pieces = 0, cube = 0, weight = 0;
  for (const it of items) { const p = prods.find((x) => x.id === it.productId); if (p) { const k = Math.max(1, n(it.qty)); pieces += p.pieces * k; cube += p.cube * k; weight += p.weight * k; } }
  const s = await settings(c, entityId);
  const labor = Math.round(R.serviceMinutes({ id: "", at: { lng: 0, lat: 0 }, pieces, stairs: a[0].stairs }, cfgOf(s)));
  const now = await localNow(c, s.tz);
  const size = { pieces, cube, labor, weight };
  const zrow = await q<{ name: string }>(c, `select name from delivery_zone where entity_id = $1 and id = $2`, [entityId, zone.id]);
  return { zone: { id: zone.id, name: zrow[0]?.name ?? "" }, size, slots: await availability(c, entityId, zone.id, addDays(now.day, s.leadDays), days, size) };
}

// --------------------------------------------------------------- queue --

/** Delivery orders with goods ready to go that are not booked on a live stop yet. */
export async function deliveryQueue(c: Client, entityId: string) {
  return q(c, `
    select so.id, so.number, so.status, so.promised_on::text promised_on, so.total_minor, so.paid_minor,
           (so.total_minor - so.paid_minor)::text balance_minor,
           cu.id customer_id, cu.name customer, cu.phone, a.id address_id, a.line1, a.city, a.state, a.postal, a.stairs,
           (a.geo is not null) has_geo, a.geo_source, a.geo_error,
           z.id zone_id, z.name zone_name,
           count(*) filter (where l.line_status in ('reserved','ready'))::int ready_lines,
           count(*) filter (where l.line_status in ('open','on_order'))::int waiting_lines,
           coalesce(sum(l.qty * coalesce((p.attributes->>'pieces')::int, 1)) filter (where l.line_status in ('reserved','ready')),0)::int pieces,
           coalesce(sum(l.qty * coalesce(p.cubic_ft, 0)) filter (where l.line_status in ('reserved','ready')),0)::float cube_ft
      from sales_order so
      join customer cu on cu.id = so.customer_id
      join customer_address a on a.id = so.ship_address_id
      join sales_order_line l on l.sales_order_id = so.id and l.entity_id = so.entity_id
      join product p on p.id = l.product_id and p.kind = any($2) and p.ship_class <> 'none'
      left join delivery_zone z on z.entity_id = so.entity_id and z.active and left(a.postal, 5) = any(z.postal_codes)
     where so.entity_id = $1 and so.fulfillment = 'delivery' and so.status in ('open','fulfilling')
       and l.line_status in ('open','reserved','ready','on_order') and l.qty > 0
       and not exists (select 1 from delivery_stop_line sl where sl.entity_id = $1 and sl.sales_order_line_id = l.id and sl.outcome = 'pending')
     group by so.id, cu.id, a.id, z.id
    having count(*) filter (where l.line_status in ('reserved','ready')) > 0
     order by so.promised_on nulls last, so.ordered_at`, [entityId, STOCKED]);
}

type LineRow = { id: string; description: string; qty: string; pieces: number; cube: number; weight: number; line_status: string };

async function bookableLines(c: Client, entityId: string, orderId: string, lineIds: string[] | null, statuses: string[]): Promise<LineRow[]> {
  return q<LineRow>(c, `
    select l.id, l.description, l.qty, l.line_status,
           (l.qty * coalesce((p.attributes->>'pieces')::int, 1))::int pieces,
           (l.qty * coalesce(p.cubic_ft, 0))::float cube, (l.qty * coalesce(p.weight_lb, 0))::float weight
      from sales_order_line l join product p on p.id = l.product_id
     where l.entity_id = $1 and l.sales_order_id = $2 and l.qty > 0 and p.kind = any($5) and p.ship_class <> 'none'
       and l.line_status = any($4)
       and ($3::uuid[] is null or l.id = any($3))
       and not exists (select 1 from delivery_stop_line sl where sl.entity_id = $1 and sl.sales_order_line_id = l.id and sl.outcome = 'pending')
     order by l.seq`, [entityId, orderId, lineIds, statuses, STOCKED]);
}

// --------------------------------------------------------------- booking --

export type BookInput = {
  kind?: string; orderId?: string; lineIds?: string[]; customerId?: string; addressId?: string;
  day?: string; windowId?: string; notes?: string; problem?: string; dcLocationId?: string;
  override?: string; pickupLines?: { description: string; qty?: number; orderLineId?: string }[];
  /** a dispatcher may book today; the customer link honours the lead time */
  allowToday?: boolean;
  /** a dispatcher, store manager or owner: books on locked days, and the stop is confirmed at once */
  manager?: boolean;
  /** where the booking came from (the register, the customer's link, or dispatch) */
  from?: "dispatch" | "sale" | "customer_link";
};

// ------------------------------------------------------ confirm and lock --

/** Whether the delivery manager has locked a day. */
export async function dayLock(c: Client, entityId: string, day: string) {
  const r = await q<{ id: string; locked_at: string; by: string | null }>(c, `
    select k.id, k.locked_at::text as locked_at, u.name as "by" from delivery_day_lock k left join app_user u on u.id = k.locked_by
     where k.entity_id = $1 and k.day = $2 and k.unlocked_at is null`, [entityId, day]);
  return r[0] ?? null;
}
async function needUnlocked(c: Client, entityId: string, day: string | null, manager: boolean) {
  if (manager || !day) return;
  const k = await dayLock(c, entityId, day);
  need(!k, `deliveries for ${dayWords(day)} are locked by the delivery manager${k?.by ? ` (${k.by})` : ""}; pick another day or ask them`);
}

/** The delivery manager confirms a stop booked at the sale or by the customer. */
export async function confirmStop(c: Client, scope: Scope, stopId: string) {
  const st = await stopRow(c, scope.entityId, stopId);
  need(st.status === "scheduled", `stop ${st.number} is ${st.status}`);
  await c.query(`update delivery_stop set confirmed_at = coalesce(confirmed_at, now()), confirmed_by = coalesce(confirmed_by, $3)
                  where entity_id = $1 and id = $2`, [scope.entityId, stopId, scope.actor.id || null]);
  await audit(c, scope, { table: "delivery_stop", rowId: stopId, action: "update", before: { confirmed: !!st.confirmed_at }, after: { confirmed: true } });
  return { ok: true, number: st.number };
}

/** Lock a day: every stop still waiting that day is confirmed, and sales and the customer link can no longer book, move or cancel on it. */
export async function lockDay(c: Client, scope: Scope, day: string) {
  need(DAY.test(day), "pick a day");
  const cur = await dayLock(c, scope.entityId, day);
  need(!cur, `${dayWords(day)} is already locked`);
  const r = await c.query(`update delivery_stop set confirmed_at = now(), confirmed_by = $3
                            where entity_id = $1 and scheduled_on = $2 and status = 'scheduled' and confirmed_at is null`,
    [scope.entityId, day, scope.actor.id || null]);
  let lockId: string;
  await c.query("savepoint day_lock");
  try {
    lockId = (await one<{ id: string }>(c, `insert into delivery_day_lock (entity_id, day, locked_by) values ($1,$2,$3) returning id`, [scope.entityId, day, scope.actor.id || null])).id;
    await c.query("release savepoint day_lock");
  } catch (e) {
    await c.query("rollback to savepoint day_lock");
    if ((e as { code?: string }).code === "23505") throw new FleetError(`${dayWords(day)} was just locked by someone else`);
    throw e;
  }
  await audit(c, scope, { table: "delivery_day_lock", rowId: lockId, action: "insert", after: { day, confirmed: r.rowCount } });
  return { day, confirmed: r.rowCount ?? 0 };
}

export async function unlockDay(c: Client, scope: Scope, day: string, reason: string) {
  need(DAY.test(day), "pick a day");
  need(reason.trim(), "say why the day is being opened again");
  const cur = await dayLock(c, scope.entityId, day);
  need(cur, `${dayWords(day)} is not locked`);
  await c.query(`update delivery_day_lock set unlocked_at = now(), unlocked_by = $3, unlock_reason = $4 where entity_id = $1 and id = $2`,
    [scope.entityId, cur!.id, scope.actor.id || null, reason.trim().slice(0, 300)]);
  await audit(c, scope, { table: "delivery_day_lock", rowId: cur!.id, action: "update", after: { day, unlocked: true }, reason: reason.trim().slice(0, 300) });
  return { day, unlocked: true };
}

/** Stops still waiting on the delivery manager, from today on. */
export async function toConfirm(c: Client, entityId: string) {
  const now = await localNow(c, (await settings(c, entityId)).tz);
  return q(c, `
    select s.id, s.number, s.scheduled_on::text scheduled_on, w.label window_label, z.name zone_name, s.booked_from, s.pieces,
           cu.name customer, a.city, so.number order_number, u.name booked_by
      from delivery_stop s
      left join delivery_window w on w.id = s.window_id left join delivery_zone z on z.id = s.zone_id
      left join customer cu on cu.id = s.customer_id left join customer_address a on a.id = s.address_id
      left join sales_order so on so.id = s.sales_order_id left join app_user u on u.id = s.created_by
     where s.entity_id = $1 and s.status = 'scheduled' and s.confirmed_at is null and s.scheduled_on >= $2::date
     order by s.scheduled_on, w.starts, s.number limit 200`, [entityId, now.day]);
}

async function checkSlot(c: Client, entityId: string, s: Settings, zone: { id: string; days: number[] }, day: string, windowId: string, allowToday: boolean) {
  need(DAY.test(day), "pick a delivery day");
  need(isId(windowId), "pick a delivery window");
  const w = await q<{ id: string; label: string; end_min: number }>(c, `
    select id, label, (extract(hour from ends)*60 + extract(minute from ends))::int end_min
      from delivery_window where entity_id = $1 and id = $2 and zone_id = $3 and active`, [entityId, windowId, zone.id]);
  need(w.length, "that window is not one this address's zone offers");
  const now = await localNow(c, s.tz);
  const first = addDays(now.day, allowToday ? 0 : s.leadDays);
  need(day >= first, allowToday ? "that day has passed" : `the first day that can be booked is ${dayWords(first)}`);
  need(day !== now.day || w[0].end_min > now.min, `today's ${w[0].label} window has already ended; pick a later one`);
  need(zone.days.map(Number).includes(dow(day)), `this zone does not get deliveries on ${new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}s`);
  const bo = await q<{ reason: string }>(c, `select reason from delivery_blackout where entity_id = $1 and day = $2 and (zone_id is null or zone_id = $3) and released_at is null`,
    [entityId, day, zone.id]);
  need(!bo.length, `no deliveries on ${dayWords(day)}: ${bo[0]?.reason}`);
}

export async function bookStop(c: Client, scope: Scope, b: BookInput) {
  const kind = b.kind ?? "delivery";
  need(["delivery", "pickup", "service", "will_call"].includes(kind), "a stop is a delivery, a pickup, a service call or a will-call");
  const s = await settings(c, scope.entityId);
  let customerId = b.customerId ?? null, addressId = b.addressId ?? null, orderId: string | null = null;
  let lines: LineRow[] = [];
  if (b.orderId) {
    need(isId(b.orderId), "no such order");
    const so = await q<{ id: string; customer_id: string | null; ship_address_id: string | null; fulfillment: string; status: string; number: string }>(c, `
      select id, customer_id, ship_address_id, fulfillment, status, number from sales_order where entity_id = $1 and id = $2 for update`,
      [scope.entityId, b.orderId]);
    need(so.length, "no such order");
    orderId = so[0].id;
    customerId = so[0].customer_id;
    addressId = addressId ?? so[0].ship_address_id;
    if (kind === "delivery" || kind === "will_call") {
      need(["open", "fulfilling"].includes(so[0].status), `order ${so[0].number} is ${so[0].status}; only an open order is delivered`);
      need(kind === "will_call" || so[0].fulfillment === "delivery", `order ${so[0].number} is not a delivery order`);
      const ids = b.lineIds?.length ? b.lineIds.filter(isId) : null;
      lines = await bookableLines(c, scope.entityId, orderId, ids, ["reserved", "ready"]);
      if (!lines.length) {
        const live = await q<{ number: string }>(c, `
          select distinct s.number from delivery_stop s join delivery_stop_line sl on sl.stop_id = s.id and sl.outcome = 'pending'
           where s.entity_id = $1 and s.sales_order_id = $2`, [scope.entityId, orderId]);
        need(false, live.length ? `order ${so[0].number} is already booked on ${live.map((x) => x.number).join(", ")}; reschedule that instead`
          : `order ${so[0].number} has nothing reserved to deliver yet; the warehouse reserves the goods first`);
      }
    }
  }
  need(kind !== "delivery" || orderId, "a delivery is booked from an order");
  need(kind !== "will_call" || orderId, "a will-call is booked from an order");
  need(customerId && isId(customerId), "a stop needs a customer");
  const cust = await q(c, `select id from customer where entity_id = $1 and id = $2`, [scope.entityId, customerId]);
  need(cust.length, "no such customer");

  let zone: { id: string; days: number[]; dc_location_id: string } | null = null;
  let stairs = 0;
  if (kind !== "will_call") {
    need(addressId && isId(addressId), "a stop needs the customer's address");
    const a = await q<{ postal: string; stairs: number }>(c, `select postal, stairs from customer_address where entity_id = $1 and id = $2 and customer_id = $3`,
      [scope.entityId, addressId, customerId]);
    need(a.length, "that address is not this customer's");
    stairs = a[0].stairs;
    await geocodeAddress(c, scope.entityId, addressId);   // caches the point; a miss is remembered and shown to the dispatcher
    zone = await zoneForPostal(c, scope.entityId, a[0].postal);
    need(zone, `postal code ${a[0].postal} is outside every delivery zone; add it to a zone, or book a will-call`);
    need(b.day && b.windowId, "pick a day and a window");
    await checkSlot(c, scope.entityId, s, zone, b.day, b.windowId, b.allowToday === true);
    await needUnlocked(c, scope.entityId, b.day, b.manager === true);
  } else if (b.day) {
    need(DAY.test(b.day), "pick the pickup day");
  }

  let dc = zone?.dc_location_id ?? null;
  if (kind === "will_call") {
    const want = b.dcLocationId && isId(b.dcLocationId) ? b.dcLocationId : null;
    const r = await q<{ id: string }>(c, want
      ? `select id from location where entity_id = $1 and id = $2`
      : `select l.fulfil_from_id id from sales_order_line l where l.entity_id = $1 and l.sales_order_id = $2 and l.fulfil_from_id is not null limit 1`,
      [scope.entityId, want ?? orderId]);
    need(r.length, "pick where the customer collects it");
    dc = r[0].id;
  }

  // Goods whose deluxing, touch-up or assembly is not done: queued now if they never were, and warned about or refused, per the company.
  let prepWarning: string | null = null;
  if (lines.length) {
    const gate = await wms.gateOrQueue(c, scope, lines.map((l) => l.id), kind === "will_call" ? "booking the will-call" : "booking the delivery");
    need(!gate.refuse, gate.message ?? "");
    prepWarning = gate.message;
  }

  if (kind === "service") need((b.problem ?? "").trim(), "describe what needs fixing");
  let pick: { description: string; qty: number; orderLineId: string | null }[] = [];
  if (kind === "pickup") {
    pick = (b.pickupLines ?? []).map((x) => ({ description: String(x.description ?? "").trim().slice(0, 200), qty: Math.max(1, n(x.qty) || 1),
      orderLineId: x.orderLineId && isId(x.orderLineId) ? x.orderLineId : null })).filter((x) => x.description);
    need(pick.length, "list what is being picked up");
    for (const p of pick) if (p.orderLineId) {
      const ok = await q(c, `select 1 from sales_order_line where entity_id = $1 and id = $2 and ($3::uuid is null or sales_order_id = $3)`,
        [scope.entityId, p.orderLineId, orderId]);
      need(ok.length, "a returned line is not on that order");
    }
  }
  const pieces = kind === "pickup" ? pick.reduce((a, x) => a + x.qty, 0) : lines.reduce((a, l) => a + n(l.pieces), 0);
  const cube = lines.reduce((a, l) => a + n(l.cube), 0), weight = lines.reduce((a, l) => a + n(l.weight), 0);
  const svc = kind === "will_call" ? 0 : Math.round(R.serviceMinutes({ id: "", at: { lng: 0, lat: 0 }, pieces, stairs }, cfgOf(s)));
  const override = (b.override ?? "").trim();
  const number = await nextNo(c, scope.entityId, "delivery", "D-");
  const st = await one<{ id: string }>(c, `
    insert into delivery_stop (entity_id, number, kind, sales_order_id, customer_id, address_id, dc_location_id, zone_id, window_id,
                               scheduled_on, pieces, cube_ft, weight_lb, service_min, over_capacity_ok, override_reason, notes, problem, created_by,
                               booked_from, confirmed_at, confirmed_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,nullif($16,''),nullif($17,''),nullif($18,''),$19,
            $20, case when $21 then now() end, case when $21 then $19::uuid end) returning id`,
    [scope.entityId, number, kind, orderId, customerId, kind === "will_call" ? null : addressId, dc, zone?.id ?? null,
     kind === "will_call" ? null : b.windowId, b.day ?? null, pieces, Math.round(cube * 10) / 10, Math.round(weight), svc,
     !!override, override, (b.notes ?? "").trim().slice(0, 500), (b.problem ?? "").trim().slice(0, 500), scope.actor.id || null,
     b.from ?? "dispatch", b.manager === true]);
  for (const l of lines) {
    await c.query(`insert into delivery_stop_line (entity_id, stop_id, sales_order_line_id, description, qty, pieces) values ($1,$2,$3,$4,$5,$6)`,
      [scope.entityId, st.id, l.id, l.description, l.qty, l.pieces]);
  }
  for (const p of pick) {
    await c.query(`insert into delivery_stop_line (entity_id, stop_id, sales_order_line_id, description, qty, pieces) values ($1,$2,$3,$4,$5,$6)`,
      [scope.entityId, st.id, p.orderLineId, p.description, p.qty, p.qty]);
  }
  if (kind !== "will_call" || b.day) await notify(c, scope, st.id, "confirmation");
  // A sectional goes as a set: booking some of its pieces without the rest is allowed, and said.
  const setWarning = lines.length ? await partialSetWarning(c, scope.entityId, lines.map((l) => l.id)) : null;
  return { id: st.id, number, pieces, cubeFt: cube, weightLb: weight, serviceMin: svc, prepWarning, setWarning };
}

async function stopRow(c: Client, entityId: string, stopId: string) {
  need(isId(stopId), "no such stop");
  const r = await q<{ id: string; number: string; kind: string; status: string; route_id: string | null; route_status: string | null;
    zone_id: string | null; sales_order_id: string | null; scheduled_on: string | null; window_id: string | null; customer_id: string | null;
    dc_location_id: string; driver_id: string | null; helper_id: string | null; confirmed_at: string | null }>(c, `
    select s.id, s.number, s.kind, s.status, s.route_id, r.status route_status, s.confirmed_at::text confirmed_at, s.zone_id, s.sales_order_id, s.scheduled_on::text scheduled_on,
           s.window_id, s.customer_id, s.dc_location_id, r.driver_id, r.helper_id
      from delivery_stop s left join delivery_route r on r.id = s.route_id
     where s.entity_id = $1 and s.id = $2 for update of s`, [entityId, stopId]);
  need(r.length, "no such stop");
  return r[0];
}

export async function reschedule(c: Client, scope: Scope, stopId: string, day: string, windowId: string, allowToday: boolean, override = "", manager = allowToday) {
  const st = await stopRow(c, scope.entityId, stopId);
  need(st.status === "scheduled", `stop ${st.number} is ${st.status}; only a scheduled stop moves`);
  if (!manager) {
    need(!st.confirmed_at, `stop ${st.number} is confirmed by the delivery manager; ask them to move it`);
    await needUnlocked(c, scope.entityId, st.scheduled_on, false);
    await needUnlocked(c, scope.entityId, day, false);
  }
  need(st.kind !== "will_call", "a will-call has no window; change its day instead");
  need(!st.route_status || st.route_status === "draft" || st.route_status === "cancelled", `stop ${st.number} is on a loaded truck; unlock the route first`);
  const s = await settings(c, scope.entityId);
  const z = await q<{ id: string; days: number[] }>(c, `select id, days from delivery_zone where entity_id = $1 and id = $2`, [scope.entityId, st.zone_id]);
  need(z.length, "that stop has no zone");
  await checkSlot(c, scope.entityId, s, z[0], day, windowId, allowToday);
  await c.query(`update delivery_stop set scheduled_on = $3, window_id = $4, route_id = null, seq = null, eta_min = null,
                        over_capacity_ok = $5, override_reason = nullif($6,''),
                        confirmed_at = case when $7 then coalesce(confirmed_at, now()) end,
                        confirmed_by = case when $7 then coalesce(confirmed_by, $8::uuid) end
                  where entity_id = $1 and id = $2`, [scope.entityId, stopId, day, windowId, !!override.trim(), override.trim(), manager, scope.actor.id || null]);
  await notify(c, scope, stopId, "rescheduled");
  return { ok: true };
}

export async function cancelStop(c: Client, scope: Scope, stopId: string, reason: string, manager = true) {
  const st = await stopRow(c, scope.entityId, stopId);
  need(reason.trim(), "say why the stop is cancelled");
  if (!manager) {
    need(!st.confirmed_at, `stop ${st.number} is confirmed by the delivery manager; ask them to cancel it`);
    await needUnlocked(c, scope.entityId, st.scheduled_on, false);
  }
  need(st.status === "scheduled", `stop ${st.number} is ${st.status}; it cannot be cancelled now`);
  need(!st.route_status || ["draft", "cancelled"].includes(st.route_status), `stop ${st.number} is on a loaded truck; unlock the route first`);
  await c.query(`update delivery_stop set status = 'cancelled', cancel_reason = $3, route_id = null, seq = null where entity_id = $1 and id = $2`,
    [scope.entityId, stopId, reason.trim()]);
  await c.query(`update delivery_stop_line set outcome = 'cancelled' where entity_id = $1 and stop_id = $2 and outcome = 'pending'`, [scope.entityId, stopId]);
  await haul.cancelForStop(c, scope, stopId, reason.trim());
  await notify(c, scope, stopId, "cancelled");
  return { ok: true };
}

export async function stops(c: Client, entityId: string, day: string, dcId?: string | null) {
  need(DAY.test(day), "pick a day");
  return q(c, `
    select s.id, s.number, s.kind, s.status, s.scheduled_on::text scheduled_on, w.label window_label, z.name zone_name,
           s.pieces, s.cube_ft::float cube_ft, s.service_min, s.route_id, r.number route_number, s.seq, s.eta_min,
           cu.name customer, a.id address_id, a.line1, a.city, a.postal, so.number order_number, s.over_capacity_ok,
           s.confirmed_at is not null confirmed, s.booked_from, (a.geo is not null) has_geo, a.geo_source, a.geo_error, a.geo[1] lat, a.geo[0] lng
      from delivery_stop s
      left join delivery_window w on w.id = s.window_id
      left join delivery_zone z on z.id = s.zone_id
      left join delivery_route r on r.id = s.route_id
      left join customer cu on cu.id = s.customer_id
      left join customer_address a on a.id = s.address_id
      left join sales_order so on so.id = s.sales_order_id
     where s.entity_id = $1 and s.scheduled_on = $2 and s.status <> 'cancelled' and ($3::uuid is null or s.dc_location_id = $3)
     order by r.number nulls first, s.seq, w.starts, s.number`, [entityId, day, dcId ?? null]);
}

// --------------------------------------------------- self-scheduling link --

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createLink(c: Client, scope: Scope, orderId: string, baseUrl = "") {
  need(isId(orderId), "no such order");
  const so = await q<{ number: string; fulfillment: string; status: string }>(c,
    `select number, fulfillment, status from sales_order where entity_id = $1 and id = $2`, [scope.entityId, orderId]);
  need(so.length, "no such order");
  need(so[0].fulfillment === "delivery", `order ${so[0].number} is not a delivery order`);
  need(["open", "fulfilling"].includes(so[0].status), `order ${so[0].number} is ${so[0].status}`);
  const s = await settings(c, scope.entityId);
  await c.query(`update delivery_link set revoked_at = now() where entity_id = $1 and sales_order_id = $2 and revoked_at is null`, [scope.entityId, orderId]);
  const token = randomBytes(24).toString("base64url");
  await c.query(`insert into delivery_link (entity_id, sales_order_id, token_sha256, expires_at, created_by)
                 values ($1,$2,$3, now() + make_interval(days => $4), $5)`, [scope.entityId, orderId, sha(token), s.linkDays, scope.actor.id || null]);
  const path = `/delivery/schedule/${token}`;
  await notify(c, scope, null, "schedule_link", { orderId, url: baseUrl + path });
  return { token, path, url: baseUrl + path, expiresInDays: s.linkDays };
}

async function linkScope(c: Client, token: string) {
  need(/^[A-Za-z0-9_-]{20,100}$/.test(token), "that link is not valid");
  const r = await q<{ entity_id: string; tenant_id: string; sales_order_id: string; expired: boolean; revoked: boolean }>(c, `
    select k.entity_id, e.tenant_id, k.sales_order_id, k.expires_at < now() expired, k.revoked_at is not null revoked
      from delivery_link k join entity e on e.id = k.entity_id
     where k.token_sha256 = $1 /* unscoped: the token names its company */`, [sha(token)]);
  need(r.length, "that link is not valid");
  need(!r[0].revoked, "that link has been replaced by a newer one; use the latest message we sent");
  need(!r[0].expired, "that link has expired; call the store for a new one");
  return r[0];
}

/** What the customer sees: the order in brief, the current booking, and the windows they can pick. Nothing else. */
export async function publicView(c: Client, token: string) {
  const k = await linkScope(c, token);
  const so = await one<{ number: string; first: string; line1: string; city: string; postal: string; customer_id: string; address_id: string }>(c, `
    select so.number, split_part(cu.name, ' ', 1) first, a.line1, a.city, a.postal, cu.id customer_id, a.id address_id
      from sales_order so join customer cu on cu.id = so.customer_id join customer_address a on a.id = so.ship_address_id
     where so.entity_id = $1 and so.id = $2`, [k.entity_id, k.sales_order_id]);
  const items = await q(c, `select l.description, l.qty::float qty from sales_order_line l join product p on p.id = l.product_id
                             where l.entity_id = $1 and l.sales_order_id = $2 and p.ship_class <> 'none' and l.line_status <> 'cancelled' order by l.seq`,
    [k.entity_id, k.sales_order_id]);
  const cur = await q<{ id: string; number: string; day: string; label: string; status: string; locked: boolean }>(c, `
    select s.id, s.number, s.scheduled_on::text as day, w.label, s.status,
           (coalesce(r.status in ('locked','in_progress','completed'), false) or s.confirmed_at is not null
            or exists (select 1 from delivery_day_lock k where k.entity_id = s.entity_id and k.day = s.scheduled_on and k.unlocked_at is null)) locked
      from delivery_stop s left join delivery_window w on w.id = s.window_id left join delivery_route r on r.id = s.route_id
     where s.entity_id = $1 and s.sales_order_id = $2 and s.kind = 'delivery' and s.status in ('scheduled','arrived')
     order by s.created_at desc limit 1`, [k.entity_id, k.sales_order_id]);
  const zone = await zoneForPostal(c, k.entity_id, so.postal);
  const s = await settings(c, k.entity_id);
  const now = await localNow(c, s.tz);
  const ready = await bookableLines(c, k.entity_id, k.sales_order_id, null, ["reserved", "ready"]);
  const size = { pieces: ready.reduce((a, l) => a + n(l.pieces), 0), cube: ready.reduce((a, l) => a + n(l.cube), 0), labor: 0,
    weight: ready.reduce((a, l) => a + n(l.weight), 0) };
  const slots = zone ? (await availability(c, k.entity_id, zone.id, addDays(now.day, s.leadDays), 14, size)).filter((x) => x.fits && !x.locked)
    .map((x) => ({ day: x.day, windowId: x.windowId, label: x.label })) : [];
  const booked = cur[0] ?? null;
  return {
    company: await companyName(c, k.entity_id), order: so.number, name: so.first, address: `${so.line1}, ${so.city}`,
    items, booking: booked ? { number: booked.number, day: booked.day, window: booked.label, status: booked.status, canChange: booked.status === "scheduled" && !booked.locked } : null,
    canBook: !!zone && (booked ? booked.status === "scheduled" && !booked.locked : ready.length > 0),
    note: !zone ? "This address is outside our delivery area; please call the store." : (!booked && !ready.length ? "Your items are not ready to schedule yet. We will text you when they are." : null),
    slots,
  };
}

export async function publicPick(c: Client, token: string, day: string, windowId: string) {
  const k = await linkScope(c, token);
  const scope: Scope = { tenantId: k.tenant_id, entityId: k.entity_id, actor: { kind: "system", label: "customer (self-schedule link)" } };
  const cur = await q<{ id: string }>(c, `select id from delivery_stop where entity_id = $1 and sales_order_id = $2 and kind = 'delivery' and status = 'scheduled'
                                          order by created_at desc limit 1`, [k.entity_id, k.sales_order_id]);
  const out = cur.length ? (await reschedule(c, scope, cur[0].id, day, windowId, false, "", false), { id: cur[0].id })
    : await bookStop(c, scope, { kind: "delivery", orderId: k.sales_order_id, day, windowId, from: "customer_link" });
  await c.query(`update delivery_link set used_at = now() where entity_id = $1 and token_sha256 = $2`, [k.entity_id, sha(token)]);
  const v = await q<{ number: string; label: string }>(c, `select s.number, w.label from delivery_stop s join delivery_window w on w.id = s.window_id
                                                        where s.entity_id = $1 and s.id = $2`, [k.entity_id, out.id]);
  return { booked: true, number: v[0].number, day, window: v[0].label, when: `${dayWords(day)}, ${v[0].label}` };
}

// ------------------------------------------------------------- messages --

export type OutboundMessage = { channel: "sms" | "email"; to: string; body: string; kind: string };
/** The seam for a real SMS/email service. The default writes to the log table only and sends nothing. */
export interface MessageProvider { name: string; send(m: OutboundMessage): Promise<{ ok: boolean; ref?: string; error?: string }> }
let provider: MessageProvider = { name: "log", async send() { return { ok: true, ref: "log-" + randomBytes(5).toString("hex") }; } };
let providerSet = false;
export function setMessageProvider(p: MessageProvider) { provider = p; providerSet = true; }

type Route = { channel: "sms" | "email"; to: string; name: string;
  send(c: Client, entityId: string, m: OutboundMessage, messageId: string): Promise<{ ok: boolean; queued?: boolean; ref?: string; error?: string }> };
/**
 * How a customer message goes. A text provider or email connected in Admin,
 * Connections sends it (and logs it there); with neither, the message is kept
 * in this log as before (logged, not sent).
 */
async function messageRouteFor(c: Client, entityId: string, phone: string | null, email: string | null): Promise<Route> {
  const via = providerSet ? null : await messaging.customerRoute(c, entityId, phone, email);
  if (via) {
    // Queued now, sent after the commit (this can run from a customer's self-schedule link); the row is updated when it goes.
    return { channel: via.channel, to: via.to, name: via.row.provider, async send(c2, e, m, messageId) {
      const o = { purpose: m.kind === "tear_sheet" ? "tear_sheet" : "customer_" + m.kind, sourceTable: "customer_message", sourceId: messageId };
      const r = await messaging.queueTo(c2, e, via, m.body.split(":")[0].slice(0, 80) || "A message from us", m.body, o);
      return { ok: r.status !== "failed", queued: r.status === "queued", ref: r.providerRef ?? undefined, error: r.error ?? undefined };
    } };
  }
  const channel: "sms" | "email" = phone ? "sms" : "email";
  return { channel, to: phone || email || "", name: provider.name, send: (_c, _e, m) => provider.send(m) };
}

async function notify(c: Client, scope: Scope, stopId: string | null, kind: string, extra: { orderId?: string; url?: string; etaMin?: number } = {}) {
  const info = await q<{ number: string; customer_id: string; name: string; phone: string | null; email: string | null; marketing: boolean;
    day: string | null; label: string | null; order_id: string | null; order_no: string | null; exception: string | null; kind: string; status: string }>(c, stopId ? `
    select s.number, cu.id customer_id, cu.name, cu.phone, cu.email, cu.marketing_ok marketing, s.scheduled_on::text as day, w.label,
           s.sales_order_id order_id, so.number order_no, s.exception, s.kind, s.status
      from delivery_stop s join customer cu on cu.id = s.customer_id left join delivery_window w on w.id = s.window_id
      left join sales_order so on so.id = s.sales_order_id
     where s.entity_id = $1 and s.id = $2` : `
    select null number, cu.id customer_id, cu.name, cu.phone, cu.email, cu.marketing_ok marketing, null as day, null label,
           so.id order_id, so.number order_no, null exception, 'delivery' kind, 'scheduled' status
      from sales_order so join customer cu on cu.id = so.customer_id where so.entity_id = $1 and so.id = $2`,
    [scope.entityId, stopId ?? extra.orderId]);
  if (!info.length) return;
  const x = info[0];
  const co = await companyName(c, scope.entityId);
  const what = x.kind === "pickup" ? "pickup" : x.kind === "service" ? "service visit" : x.kind === "will_call" ? "pickup at our warehouse" : "delivery";
  const when = x.day ? `${dayWords(x.day)}${x.label ? ", " + x.label : ""}` : "";
  const body = {
    confirmation: `${co}: your ${what} ${x.number} is booked for ${when}. We will text the day before.`,
    rescheduled: `${co}: your ${what} ${x.number} is now ${when}.`,
    cancelled: `${co}: your ${what} ${x.number} has been cancelled. Call the store to rebook.`,
    day_before: `${co}: reminder, your ${what} ${x.number} is tomorrow, ${when}. Please have a clear path and someone 18+ home.`,
    en_route: `${co}: your ${what} crew is on the way to you now. Estimated arrival about ${extra.etaMin != null ? R.clock(extra.etaMin) : "shortly"}.`,
    delivered: `${co}: your ${what} ${x.number} is complete. Thank you!`,
    exception: `${co}: we could not complete your ${what} ${x.number} today. We will call to rebook.`,
    schedule_link: `${co}: your order ${x.order_no} is ready to schedule. Pick your delivery day here: ${extra.url ?? ""}`,
  }[kind] ?? `${co}: an update on ${x.number ?? x.order_no}.`;
  const route = await messageRouteFor(c, scope.entityId, x.phone, x.email);
  const { channel, to } = route;
  const row = await one<{ id: string }>(c, `
    insert into customer_message (entity_id, stop_id, sales_order_id, customer_id, kind, channel, to_addr, body, provider, status)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [scope.entityId, stopId, x.order_id, x.customer_id, kind, channel, to || "-", body, route.name, to ? "queued" : "skipped"]);
  if (!to) return;
  try {
    const r = await route.send(c, scope.entityId, { channel, to, body, kind }, row.id);
    if (!r.queued) await c.query(`update customer_message set status = $3, provider_ref = $4, error = $5, sent_at = case when $3 = 'sent' then now() end
                    where entity_id = $1 and id = $2`, [scope.entityId, row.id, r.ok ? "sent" : "failed", r.ref ?? null, r.error ?? null]);
  } catch (e) {
    await c.query(`update customer_message set status = 'failed', error = $3 where entity_id = $1 and id = $2`,
      [scope.entityId, row.id, String((e as Error).message).slice(0, 300)]);
  }
}

/** A message to a customer about something other than a stop (a service ticket), through the same log and provider. */
export async function messageCustomer(c: Client, scope: Scope, m: { customerId: string; body: string; orderId?: string | null; kind?: "service_update" | "tear_sheet" }) {
  const kind = m.kind ?? "service_update";
  const cu = await q<{ phone: string | null; email: string | null }>(c, `select phone, email from customer where entity_id = $1 and id = $2`, [scope.entityId, m.customerId]);
  if (!cu.length) return null;
  const route = await messageRouteFor(c, scope.entityId, cu[0].phone, cu[0].email);
  const { channel, to } = route;
  const body = `${await companyName(c, scope.entityId)}: ${m.body}`.slice(0, 1000);
  const row = await one<{ id: string }>(c, `
    insert into customer_message (entity_id, sales_order_id, customer_id, kind, channel, to_addr, body, provider, status)
    values ($1,$2,$3,$9,$4,$5,$6,$7,$8) returning id`,
    [scope.entityId, m.orderId ?? null, m.customerId, channel, to || "-", body, route.name, to ? "queued" : "skipped", kind]);
  if (!to) return row.id;
  try {
    const r = await route.send(c, scope.entityId, { channel, to, body, kind }, row.id);
    if (!r.queued) await c.query(`update customer_message set status = $3, provider_ref = $4, error = $5, sent_at = case when $3 = 'sent' then now() end
                    where entity_id = $1 and id = $2`, [scope.entityId, row.id, r.ok ? "sent" : "failed", r.ref ?? null, r.error ?? null]);
  } catch (e) {
    await c.query(`update customer_message set status = 'failed', error = $3 where entity_id = $1 and id = $2`,
      [scope.entityId, row.id, String((e as Error).message).slice(0, 300)]);
  }
  return row.id;
}

export async function messages(c: Client, entityId: string, filter: { stopId?: string; day?: string }) {
  return q(c, `
    select m.id, m.kind, m.channel, m.to_addr, m.body, m.status, m.provider, m.created_at, s.number stop_number, cu.name customer
      from customer_message m left join delivery_stop s on s.id = m.stop_id left join customer cu on cu.id = m.customer_id
     where m.entity_id = $1 and ($2::uuid is null or m.stop_id = $2) and ($3::date is null or (m.created_at at time zone business_tz($1))::date = $3::date)
     order by m.created_at desc limit 200`, [entityId, filter.stopId ?? null, filter.day ?? null]);
}

/** Day-before reminders for every stop booked on a day. Running it twice sends nothing twice. */
export async function sendDayBefore(c: Client, scope: Scope, day: string) {
  need(DAY.test(day), "pick the delivery day");
  const due = await q<{ id: string }>(c, `
    select s.id from delivery_stop s where s.entity_id = $1 and s.scheduled_on = $2 and s.status = 'scheduled'
       and not exists (select 1 from customer_message m where m.entity_id = $1 and m.stop_id = s.id and m.kind = 'day_before' and m.status <> 'failed')`,
    [scope.entityId, day]);
  for (const s of due) await notify(c, scope, s.id, "day_before");
  return { sent: due.length };
}

// --------------------------------------------------------------- routes --

type GeoStop = R.RStop & { number: string };

async function routeStops(c: Client, entityId: string, routeId: string): Promise<GeoStop[]> {
  const rows = await q<{ id: string; number: string; lng: number | null; lat: number | null; pieces: number; cube: number; weight: number;
    stairs: number; ws: number | null; we: number | null; service_min: number; customer: string | null; line1: string | null; city: string | null }>(c, `
    select s.id, s.number, a.geo[0] lng, a.geo[1] lat, s.pieces, s.cube_ft::float cube, s.weight_lb::float weight, coalesce(a.stairs,0) stairs,
           (select cu.name from customer cu where cu.id = s.customer_id) customer, a.line1, a.city,
           (extract(hour from w.starts)*60 + extract(minute from w.starts))::int ws, (extract(hour from w.ends)*60 + extract(minute from w.ends))::int we,
           s.service_min
      from delivery_stop s left join customer_address a on a.id = s.address_id left join delivery_window w on w.id = s.window_id
     where s.entity_id = $1 and s.route_id = $2 and s.status <> 'cancelled'
     order by s.seq nulls last, s.number`, [entityId, routeId]);
  const lost = rows.find((r) => r.lng == null || r.lat == null);
  need(!lost, lost ? `stop ${lost.number} for ${whereWords(lost)} has no map point; use Find on map or enter its position before routing it` : "");
  return rows.map((r) => ({ id: r.id, number: r.number, at: { lng: Number(r.lng), lat: Number(r.lat) }, pieces: r.pieces, cube: r.cube, weight: r.weight,
    stairs: r.stairs, windowStart: r.ws ?? undefined, windowEnd: r.we ?? undefined, serviceMin: r.service_min }));
}

async function dcPoint(c: Client, entityId: string, dcId: string): Promise<R.Pt> {
  const r = await q<{ lng: number | null; lat: number | null }>(c, `select geo[0] lng, geo[1] lat from location where entity_id = $1 and id = $2`, [entityId, dcId]);
  need(r.length, "no such warehouse");
  need(r[0].lng != null, "that warehouse has no map point; set its location in Setup");
  return { lng: n(r[0].lng), lat: n(r[0].lat) };
}

/** Write the order and ETAs of a route as it now stands, and its planned miles and minutes. */
async function replan(c: Client, entityId: string, routeId: string) {
  const r = await one<{ dc_location_id: string; start_min: number }>(c, `select dc_location_id, start_min from delivery_route where entity_id = $1 and id = $2`, [entityId, routeId]);
  const s = await settings(c, entityId);
  const seq = await routeStops(c, entityId, routeId);
  const plan = R.simulate(await dcPoint(c, entityId, r.dc_location_id), seq, cfgOf(s), r.start_min);
  for (const p of plan.stops) {
    await c.query(`update delivery_stop set seq = $3, eta_min = $4 where entity_id = $1 and id = $2 and (seq is distinct from $3 or eta_min is distinct from $4)`,
      [entityId, p.id, p.seq, p.startMin]);
  }
  await c.query(`update delivery_route set planned_miles = $3, planned_minutes = $4 where entity_id = $1 and id = $2`, [entityId, routeId, plan.miles, plan.minutes]);
  return plan;
}

export async function routes(c: Client, entityId: string, day: string, opts: { dcId?: string | null; personId?: string | null } = {}) {
  need(DAY.test(day), "pick a day");
  return q(c, `
    select r.id, r.number, r.route_on::text route_on, r.status, r.dc_location_id, l.name dc_name, r.vehicle_id, v.unit_no, v.kind vehicle_kind,
           v.status vehicle_status, v.cube_ft::float cube_cap, v.max_weight_lb::float weight_cap, v.max_stops,
           r.driver_id, d.name driver, r.helper_id, h.name helper, r.planned_miles::float planned_miles, r.planned_minutes,
           r.start_min, r.started_at, r.finished_at,
           count(s.id) filter (where s.status <> 'cancelled')::int stops,
           count(s.id) filter (where s.status in ('delivered','partial','failed'))::int done,
           count(s.id) filter (where s.status = 'failed')::int failed,
           coalesce(sum(s.pieces) filter (where s.status <> 'cancelled'),0)::int pieces,
           coalesce(sum(s.cube_ft) filter (where s.status <> 'cancelled'),0)::float cube,
           coalesce(sum(s.weight_lb) filter (where s.status <> 'cancelled'),0)::float weight
      from delivery_route r join location l on l.id = r.dc_location_id
      left join vehicle v on v.id = r.vehicle_id left join app_user d on d.id = r.driver_id left join app_user h on h.id = r.helper_id
      left join delivery_stop s on s.route_id = r.id and s.entity_id = r.entity_id
     where r.entity_id = $1 and r.route_on = $2 and r.status <> 'cancelled'
       and ($3::uuid is null or r.dc_location_id = $3)
       and ($4::uuid is null or r.driver_id = $4 or r.helper_id = $4)
     group by r.id, l.name, v.id, d.name, h.name
     order by r.number`, [entityId, day, opts.dcId ?? null, opts.personId ?? null]);
}

/**
 * Build (or rebuild) the day's routes out of one warehouse. Draft routes are
 * re-planned from scratch; locked ones are left alone, and so are their trucks.
 */
export async function buildRoutes(c: Client, scope: Scope, day: string, dcId: string) {
  need(DAY.test(day), "pick the delivery day");
  need(isId(dcId), "pick the warehouse");
  const s = await settings(c, scope.entityId);
  const depot = await dcPoint(c, scope.entityId, dcId);
  // lock the day's routes for this DC so two dispatchers cannot build at once
  const existing = await q<{ id: string; vehicle_id: string | null; driver_id: string | null; helper_id: string | null; status: string }>(c, `
    select id, vehicle_id, driver_id, helper_id, status from delivery_route
     where entity_id = $1 and route_on = $2 and dc_location_id = $3 and status <> 'cancelled' order by number for update`, [scope.entityId, day, dcId]);
  const drafts = existing.filter((r) => r.status === "draft");
  if (drafts.length) {
    await c.query(`update delivery_stop set route_id = null, seq = null, eta_min = null where entity_id = $1 and route_id = any($2)`,
      [scope.entityId, drafts.map((r) => r.id)]);
    // free the crews first, so two drafts can swap a driver without tripping the one-route-a-day rule
    await c.query(`update delivery_route set driver_id = null, helper_id = null where entity_id = $1 and id = any($2)`,
      [scope.entityId, drafts.map((r) => r.id)]);
  }
  // find any missing map points before planning (bounded, so one build cannot wait on dozens of lookups)
  const missing = await q<{ address_id: string }>(c, `
    select distinct s.address_id from delivery_stop s join customer_address a on a.id = s.address_id
     where s.entity_id = $1 and s.scheduled_on = $2 and s.dc_location_id = $3 and s.status = 'scheduled' and s.route_id is null and a.geo is null
     limit 25`, [scope.entityId, day, dcId]);
  for (const m of missing) await geocodeAddress(c, scope.entityId, m.address_id);
  const todo = await q<{ id: string; number: string; lng: number | null; lat: number | null; pieces: number; cube: number; weight: number;
    stairs: number; ws: number; we: number; service_min: number; customer: string; line1: string; city: string; geo_error: string | null; address_id: string }>(c, `
    select s.id, s.number, a.geo[0] lng, a.geo[1] lat, s.pieces, s.cube_ft::float cube, s.weight_lb::float weight, a.stairs,
           (select cu.name from customer cu where cu.id = s.customer_id) customer, a.line1, a.city, a.geo_error, s.address_id,
           (extract(hour from w.starts)*60 + extract(minute from w.starts))::int ws, (extract(hour from w.ends)*60 + extract(minute from w.ends))::int we,
           s.service_min
      from delivery_stop s join customer_address a on a.id = s.address_id join delivery_window w on w.id = s.window_id
     where s.entity_id = $1 and s.scheduled_on = $2 and s.dc_location_id = $3 and s.status = 'scheduled' and s.route_id is null
       and s.kind in ('delivery','pickup','service')
     order by s.number`, [scope.entityId, day, dcId]);
  // trucks already on a live route that day -- here or out of another warehouse -- are not planned again
  const busyVehicles = (await q<{ vehicle_id: string }>(c, `
    select vehicle_id from delivery_route where entity_id = $1 and route_on = $2 and status <> 'cancelled' and vehicle_id is not null
       and not (id = any($3::uuid[]))`, [scope.entityId, day, drafts.map((d) => d.id)])).map((r) => r.vehicle_id);
  const fleet = await q<{ id: string; unit_no: string; cube: number; weight: number; max_stops: number; crew_size: number; requires_cdl: boolean }>(c, `
    select id, unit_no, cube_ft::float cube, max_weight_lb::float weight, max_stops, crew_size, requires_cdl from vehicle
     where entity_id = $1 and home_location_id = $2 and status = 'active' and not (id = any($3::uuid[]))
     order by cube_ft desc, unit_no`, [scope.entityId, dcId, busyVehicles.filter(Boolean)]);
  const noGeo = todo.filter((t) => t.lng == null);
  const rstops: R.RStop[] = todo.filter((t) => t.lng != null).map((t) => ({ id: t.id, at: { lng: Number(t.lng), lat: Number(t.lat) }, cube: t.cube,
    weight: t.weight, pieces: t.pieces, stairs: t.stairs, windowStart: t.ws, windowEnd: t.we, serviceMin: t.service_min }));
  const plan = R.assign(depot, rstops, fleet.map((v) => ({ id: v.id, cube: v.cube, weight: v.weight, maxStops: v.max_stops, startMin: s.startMin, endMin: s.endMin })), cfgOf(s));

  // crew: keep who was on a draft truck; otherwise the next eligible driver by name
  const crew = await q<{ id: string; name: string; kind: string; license_class: string | null; default_helper_id: string | null }>(c, `
    select p.app_user_id id, u.name, p.kind, p.license_class, p.default_helper_id
      from driver_profile p join app_user u on u.id = p.app_user_id
     where p.entity_id = $1 and p.active and u.status = 'active' and (p.kind = 'helper' or p.license_expires >= $2::date)
       and not exists (select 1 from delivery_route r where r.entity_id = $1 and r.route_on = $2 and r.status <> 'cancelled'
                        and not (r.id = any($3::uuid[])) and (r.driver_id = p.app_user_id or r.helper_id = p.app_user_id))
     order by u.name`, [scope.entityId, day, drafts.map((d) => d.id)]);
  const used = new Set<string>();
  const out: { routeId: string; number: string; vehicle: string; stops: number; miles: number }[] = [];
  const keep = new Set<string>();
  for (const pr of plan.routes) {
    const v = fleet.find((x) => x.id === pr.vehicleId)!;
    let route = drafts.find((d) => d.vehicle_id === v.id && !keep.has(d.id));
    const prev = route ? { driver: route.driver_id, helper: route.helper_id } : { driver: null, helper: null };
    const ok = (id: string | null, asDriver: boolean) => {
      if (!id || used.has(id)) return false;
      const p = crew.find((x) => x.id === id);
      return !!p && (!asDriver || (p.kind === "driver" && (!v.requires_cdl || ["A", "B"].includes(p.license_class ?? ""))));
    };
    const driver = ok(prev.driver, true) ? prev.driver! : crew.find((p) => ok(p.id, true))?.id ?? null;
    if (driver) used.add(driver);
    let helper: string | null = null;
    if (v.crew_size > 1) {
      const dflt = crew.find((p) => p.id === driver)?.default_helper_id ?? null;
      helper = ok(prev.helper, false) ? prev.helper : ok(dflt, false) ? dflt : crew.find((p) => p.kind === "helper" && ok(p.id, false))?.id ?? null;
      if (helper) used.add(helper);
    }
    if (route) {
      await c.query(`update delivery_route set vehicle_id = $3, driver_id = $4, helper_id = $5, start_min = $6 where entity_id = $1 and id = $2`,
        [scope.entityId, route.id, v.id, driver, helper, s.startMin]);
    } else {
      const number = await nextNo(c, scope.entityId, "route", "RT-");
      const r = await one<{ id: string }>(c, `insert into delivery_route (entity_id, number, route_on, dc_location_id, vehicle_id, driver_id, helper_id, start_min)
                                             values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [scope.entityId, number, day, dcId, v.id, driver, helper, s.startMin]);
      route = { id: r.id, vehicle_id: v.id, driver_id: driver, helper_id: helper, status: "draft" };
    }
    keep.add(route.id);
    for (const [i, st] of pr.stops.entries()) {
      await c.query(`update delivery_stop set route_id = $3, seq = $4 where entity_id = $1 and id = $2`, [scope.entityId, st.id, route.id, i + 1]);
    }
    const p = await replan(c, scope.entityId, route.id);
    const num = await one<{ number: string }>(c, `select number from delivery_route where entity_id = $1 and id = $2`, [scope.entityId, route.id]);
    out.push({ routeId: route.id, number: num.number, vehicle: v.unit_no, stops: pr.stops.length, miles: p.miles });
  }
  for (const d of drafts) if (!keep.has(d.id)) {
    await c.query(`update delivery_route set status = 'cancelled' where entity_id = $1 and id = $2`, [scope.entityId, d.id]);
  }
  const numbers = new Map(todo.map((t) => [t.id, t.number]));
  return {
    routes: out,
    unassigned: [...noGeo.map((t) => ({ id: t.id, number: t.number, addressId: t.address_id, noMapPoint: true,
      reason: `${whereWords(t)} has no map point${t.geo_error ? ` (${t.geo_error})` : ""}; use Find on map or enter its position` })),
      ...plan.unassigned.map((u) => ({ ...u, number: numbers.get(u.id) }))],
    trucks: fleet.length,
  };
}

export async function route(c: Client, entityId: string, routeId: string) {
  need(isId(routeId), "no such route");
  const r = await q(c, `
    select r.id, r.number, r.route_on::text route_on, r.status, r.dc_location_id, l.name dc_name, l.geo[0] dc_lng, l.geo[1] dc_lat,
           r.vehicle_id, v.unit_no, v.kind vehicle_kind, v.status vehicle_status, v.oos_reason, v.cube_ft::float cube_cap,
           v.max_weight_lb::float weight_cap, v.max_stops, v.crew_size, v.mpg::float mpg,
           r.driver_id, d.name driver, r.helper_id, h.name helper, r.planned_miles::float planned_miles, r.planned_minutes, r.start_min,
           r.actual_miles::float actual_miles, r.started_at, r.finished_at, r.locked_at, lu.name locked_by
      from delivery_route r join location l on l.id = r.dc_location_id
      left join vehicle v on v.id = r.vehicle_id left join app_user d on d.id = r.driver_id left join app_user h on h.id = r.helper_id
      left join app_user lu on lu.id = r.locked_by
     where r.entity_id = $1 and r.id = $2`, [entityId, routeId]);
  need(r.length, "no such route");
  const st = await q(c, `
    select s.id, s.number, s.kind, s.status, s.seq, s.eta_min, s.pieces, s.cube_ft::float cube_ft, s.weight_lb::float weight_lb,
           s.service_min, s.notes, s.problem, s.exception, s.exception_reason, s.arrived_at, s.completed_at, s.pod_recipient,
           s.pod_signature is not null signed, cardinality(s.pod_photos) photos,
           w.label window_label, (extract(hour from w.starts)*60 + extract(minute from w.starts))::int window_start,
           (extract(hour from w.ends)*60 + extract(minute from w.ends))::int window_end,
           cu.name customer, cu.phone, a.line1, a.line2, a.city, a.state, a.postal, a.stairs, a.notes address_notes,
           a.geo[0] lng, a.geo[1] lat, so.id order_id, so.number order_number,
           greatest(coalesce(b.balance_minor, 0), 0)::text cod_minor,
           sv.id service_visit_id, sv.kind service_visit_kind, st.id service_ticket_id, st.number service_ticket, st.coverage service_coverage
      from delivery_stop s left join delivery_window w on w.id = s.window_id
      left join service_visit sv on sv.stop_id = s.id and sv.entity_id = s.entity_id
      left join service_ticket st on st.id = sv.ticket_id
      left join customer cu on cu.id = s.customer_id left join customer_address a on a.id = s.address_id
      left join sales_order so on so.id = s.sales_order_id
      left join sales_order_balance b on b.sales_order_id = s.sales_order_id and b.entity_id = s.entity_id
     where s.entity_id = $1 and s.route_id = $2 and s.status <> 'cancelled'
     order by s.seq, s.number`, [entityId, routeId]);
  const lines = await q(c, `
    select sl.id, sl.stop_id, sl.sales_order_line_id, sl.description, sl.qty::float qty, sl.pieces, sl.outcome, sl.flagged_for_warehouse, sl.note, ol.sku
      from delivery_stop_line sl join delivery_stop s on s.id = sl.stop_id left join sales_order_line ol on ol.id = sl.sales_order_line_id
     where sl.entity_id = $1 and s.route_id = $2 and sl.outcome <> 'cancelled' order by ol.seq nulls last, sl.description`, [entityId, routeId]);
  // the delivery record: the serial and lot of each piece on a line
  const lotsBy = await inventory.lotsForLines(c, entityId, lines.map((l) => l.sales_order_line_id).filter(isId) as string[]);
  for (const l of lines) (l as Record<string, unknown>).units = lotsBy.get(String(l.sales_order_line_id)) ?? [];
  // a service visit shows the parts in hand for its ticket, so the technician can mark what was used
  const tickets = st.map((x) => x.service_ticket_id).filter(Boolean);
  const parts = tickets.length ? await q(c, `
    select sp.id, sp.ticket_id, p.name, sp.qty::float qty, l.line_status, sp.billable
      from service_part sp join sales_order_line l on l.id = sp.sales_order_line_id join product p on p.id = sp.product_id
     where sp.entity_id = $1 and sp.ticket_id = any($2) and sp.used_at is null and sp.cancelled_at is null`, [entityId, tickets]) : [];
  // haul-away the crew takes from each door (the haul-away module's lines)
  const haulRows = st.length ? await q(c, `
    select h.id, h.stop_id, h.category, h.description, h.qty::float qty, h.fee_minor::text fee_minor, h.trade_in_minor::text trade_in_minor,
           h.status, h.taken_qty::float taken_qty
      from stop_haul_away h where h.entity_id = $1 and h.stop_id = any($2) and h.status <> 'cancelled' order by h.created_at`, [entityId, st.map((x) => x.id)]) : [];
  return { ...r[0], stops: st.map((x) => ({ ...x, eta: x.eta_min != null ? R.clock(x.eta_min) : null, lines: lines.filter((l) => l.stop_id === x.id),
    mapsUrl: mapsUrl(x), serviceParts: x.service_ticket_id ? parts.filter((p) => p.ticket_id === x.service_ticket_id) : [],
    haulAway: haulRows.filter((h) => h.stop_id === x.id) })) };
}

export function mapsUrl(x: Record<string, unknown>): string {
  const addr = [x.line1, x.city, x.state, x.postal].filter(Boolean).join(", ");
  const dest = x.lat != null && x.lng != null ? `${x.lat},${x.lng}` : addr;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(String(dest))}&travelmode=driving`;
}

async function routeFor(c: Client, entityId: string, routeId: string, forUpdate = true) {
  need(isId(routeId), "no such route");
  const r = await q<{ id: string; number: string; status: string; vehicle_id: string | null; driver_id: string | null; helper_id: string | null;
    route_on: string; dc_location_id: string }>(c,
    `select id, number, status, vehicle_id, driver_id, helper_id, route_on::text route_on, dc_location_id from delivery_route
      where entity_id = $1 and id = $2 ${forUpdate ? "for update" : ""}`, [entityId, routeId]);
  need(r.length, "no such route");
  return r[0];
}

export async function moveStop(c: Client, scope: Scope, stopId: string, dir: "up" | "down") {
  const st = await stopRow(c, scope.entityId, stopId);
  need(st.route_id, `stop ${st.number} is not on a route`);
  const rt = await routeFor(c, scope.entityId, st.route_id);
  need(rt.status === "draft", `route ${rt.number} is locked (the truck is loaded); unlock it before moving stops`);
  const seq = await routeStops(c, scope.entityId, rt.id);
  const i = seq.findIndex((x) => x.id === stopId), j = dir === "up" ? i - 1 : i + 1;
  need(j >= 0 && j < seq.length, dir === "up" ? "that stop is already first" : "that stop is already last");
  [seq[i], seq[j]] = [seq[j], seq[i]];
  for (const [k, x] of seq.entries()) await c.query(`update delivery_stop set seq = $3 where entity_id = $1 and id = $2`, [scope.entityId, x.id, k + 1]);
  const p = await replan(c, scope.entityId, rt.id);
  return { miles: p.miles, minutes: p.minutes, lateMin: p.lateMin };
}

export async function reoptimise(c: Client, scope: Scope, routeId: string) {
  const rt = await routeFor(c, scope.entityId, routeId);
  need(rt.status === "draft", `route ${rt.number} is locked; unlock it to re-optimise`);
  const s = await settings(c, scope.entityId);
  const depot = await dcPoint(c, scope.entityId, rt.dc_location_id);
  const before = R.simulate(depot, await routeStops(c, scope.entityId, rt.id), cfgOf(s));
  const seq = R.optimise(depot, await routeStops(c, scope.entityId, rt.id), cfgOf(s));
  // keep the dispatcher's order if optimising would not shorten it
  if (R.loopMiles(depot, seq, cfgOf(s)) < before.miles - 0.05 || before.lateMin > 0) {
    for (const [k, x] of seq.entries()) await c.query(`update delivery_stop set seq = $3 where entity_id = $1 and id = $2`, [scope.entityId, x.id, k + 1]);
  }
  const p = await replan(c, scope.entityId, rt.id);
  return { beforeMiles: before.miles, miles: p.miles, minutes: p.minutes, lateMin: p.lateMin };
}

/** Put a stop on a draft route (at the end), or take it off any route. */
export async function assignStop(c: Client, scope: Scope, stopId: string, routeId: string | null) {
  const st = await stopRow(c, scope.entityId, stopId);
  need(st.status === "scheduled", `stop ${st.number} is ${st.status}`);
  need(st.kind !== "will_call", "a will-call is collected at the warehouse, not routed");
  const from = st.route_id;
  if (routeId) {
    const rt = await routeFor(c, scope.entityId, routeId);
    need(rt.status === "draft", `route ${rt.number} is locked; unlock it first`);
    need(rt.route_on === st.scheduled_on, `stop ${st.number} is booked for another day`);
    need(rt.dc_location_id === st.dc_location_id, `stop ${st.number} ships from another warehouse`);
    const g = await q<{ ok: boolean; customer: string | null; line1: string | null; city: string | null }>(c, `
      select a.geo is not null ok, cu.name customer, a.line1, a.city from delivery_stop s join customer_address a on a.id = s.address_id
        left join customer cu on cu.id = s.customer_id where s.entity_id = $1 and s.id = $2`, [scope.entityId, stopId]);
    need(g[0]?.ok, `stop ${st.number} for ${whereWords(g[0] ?? {})} has no map point; use Find on map or enter its position before routing it`);
    const last = await one<{ m: number }>(c, `select coalesce(max(seq),0)::int m from delivery_stop where entity_id = $1 and route_id = $2`, [scope.entityId, routeId]);
    await c.query(`update delivery_stop set route_id = $3, seq = $4 where entity_id = $1 and id = $2`, [scope.entityId, stopId, routeId, last.m + 1]);
    await truckFits(c, scope.entityId, routeId);
    await replan(c, scope.entityId, routeId);
  } else {
    await c.query(`update delivery_stop set route_id = null, seq = null, eta_min = null where entity_id = $1 and id = $2`, [scope.entityId, stopId]);
  }
  if (from && from !== routeId) await replan(c, scope.entityId, from);
  return { ok: true };
}

/** The route's truck carries what is on it: cubic feet and payload weight, the way the builder counts them. */
export async function truckFits(c: Client, entityId: string, routeId: string) {
  const cap = await q<{ unit_no: string; cube: number; weight: number; used_cube: number; used_weight: number }>(c, `
    select v.unit_no, v.cube_ft::float cube, v.max_weight_lb::float weight,
           coalesce(sum(s.cube_ft),0)::float used_cube, coalesce(sum(s.weight_lb),0)::float used_weight
      from delivery_route r join vehicle v on v.id = r.vehicle_id
      left join delivery_stop s on s.route_id = r.id and s.entity_id = r.entity_id and s.status <> 'cancelled'
     where r.entity_id = $1 and r.id = $2 group by v.id`, [entityId, routeId]);
  if (!cap.length) return;
  const x = cap[0];
  need(x.used_weight <= x.weight + 1e-6, `unit ${x.unit_no} carries ${x.weight} lb; with that stop the route weighs ${x.used_weight} lb`);
  need(x.used_cube <= x.cube + 1e-6, `unit ${x.unit_no} holds ${x.cube} cubic feet; with that stop the route carries ${x.used_cube}`);
}

/** Make an empty draft route for a truck on a day (the builder normally does this). */
export async function addRoute(c: Client, scope: Scope, day: string, dcId: string, vehicleId: string) {
  need(DAY.test(day), "pick the day");
  need(isId(dcId) && isId(vehicleId), "pick the warehouse and the truck");
  const s = await settings(c, scope.entityId);
  const v = await q<{ unit_no: string }>(c, `select unit_no from vehicle where entity_id = $1 and id = $2`, [scope.entityId, vehicleId]);
  need(v.length, "that vehicle belongs to another company");
  const on = await busyElsewhere(c, scope.entityId, day, null, { vehicleId });
  need(!on, `unit ${v[0].unit_no} is already on route ${on} that day`);
  const number = await nextNo(c, scope.entityId, "route", "RT-");
  return one(c, `insert into delivery_route (entity_id, number, route_on, dc_location_id, vehicle_id, start_min) values ($1,$2,$3,$4,$5,$6) returning id, number`,
    [scope.entityId, number, day, dcId, vehicleId, s.startMin]);
}

export async function setCrew(c: Client, scope: Scope, routeId: string, b: { vehicleId?: string | null; driverId?: string | null; helperId?: string | null; startMin?: number }) {
  const rt = await routeFor(c, scope.entityId, routeId);
  need(rt.status === "draft", `route ${rt.number} is locked; unlock it to change the crew or truck`);
  for (const v of [b.vehicleId, b.driverId, b.helperId]) need(v == null || v === "" || isId(v), "no such person or truck");
  const v = b.vehicleId === undefined ? rt.vehicle_id : b.vehicleId || null;
  const d = b.driverId === undefined ? rt.driver_id : b.driverId || null;
  const h = b.helperId === undefined ? rt.helper_id : b.helperId || null;
  need(!d || d !== h, "the driver and the helper are two people");
  if (v && v !== rt.vehicle_id) {
    const on = await busyElsewhere(c, scope.entityId, rt.route_on, rt.id, { vehicleId: v });
    const u = await q<{ unit_no: string }>(c, `select unit_no from vehicle where entity_id = $1 and id = $2`, [scope.entityId, v]);
    need(u.length, "that vehicle belongs to another company");
    need(!on, `unit ${u[0].unit_no} is already on route ${on} that day; take it off there first`);
  }
  for (const [pid, role] of [[d, "driver"], [h, "helper"]] as [string | null, string][]) {
    if (!pid || pid === (role === "driver" ? rt.driver_id : rt.helper_id)) continue;
    const on = await busyElsewhere(c, scope.entityId, rt.route_on, rt.id, { personId: pid });
    const nm = await q<{ name: string }>(c, `select u.name from app_user u join driver_profile p on p.app_user_id = u.id and p.entity_id = $1 where u.id = $2`, [scope.entityId, pid]);
    need(!on, `${nm[0]?.name ?? "that person"} is already on route ${on} that day`);
  }
  const start = b.startMin != null ? Math.max(0, Math.min(1439, Math.round(b.startMin))) : null;
  await c.query(`update delivery_route set vehicle_id = $3, driver_id = $4, helper_id = $5, start_min = coalesce($6, start_min)
                  where entity_id = $1 and id = $2`, [scope.entityId, routeId, v, d, h, start]);
  if (v) {
    const cap = await one<{ cube: number; weight: number; max_stops: number; used_cube: number; used_weight: number; used_stops: number }>(c, `
      select v.cube_ft::float cube, v.max_weight_lb::float weight, v.max_stops,
             coalesce(sum(s.cube_ft),0)::float used_cube, coalesce(sum(s.weight_lb),0)::float used_weight, count(s.id)::int used_stops
        from vehicle v left join delivery_stop s on s.route_id = $3 and s.entity_id = $1 and s.status <> 'cancelled'
       where v.entity_id = $1 and v.id = $2 group by v.id`, [scope.entityId, v, routeId]);
    need(cap.used_cube <= cap.cube + 1e-6, `that truck holds ${cap.cube} cubic feet; this route carries ${cap.used_cube}`);
    need(cap.used_weight <= cap.weight + 1e-6, `that truck carries ${cap.weight} lb; this route weighs ${cap.used_weight}`);
    need(cap.used_stops <= cap.max_stops, `that truck is set for ${cap.max_stops} stops; this route has ${cap.used_stops}`);
  }
  await replan(c, scope.entityId, routeId);
  return { ok: true };
}

/** The truck is loaded: the order is fixed from here. */
export async function lockRoute(c: Client, scope: Scope, routeId: string) {
  const rt = await routeFor(c, scope.entityId, routeId);
  need(rt.status === "draft", `route ${rt.number} is already ${rt.status.replace("_", " ")}`);
  need(rt.vehicle_id, "put a truck on the route first");
  need(rt.driver_id, "put a driver on the route first");
  const cnt = await one<{ n: number }>(c, `select count(*)::int n from delivery_stop where entity_id = $1 and route_id = $2 and status <> 'cancelled'`, [scope.entityId, routeId]);
  need(cnt.n > 0, "the route has no stops");
  await truckFits(c, scope.entityId, routeId);
  await loadGate(c, scope, routeId);   // every piece loaded, or short with a reason
  await replan(c, scope.entityId, routeId);
  await c.query(`update delivery_route set status = 'locked', locked_at = now(), locked_by = $3 where entity_id = $1 and id = $2`,
    [scope.entityId, routeId, scope.actor.id || null]);
  return { status: "locked" };
}

export async function unlockRoute(c: Client, scope: Scope, routeId: string) {
  const rt = await routeFor(c, scope.entityId, routeId);
  need(rt.status === "locked", rt.status === "draft" ? "the route is not locked" : `route ${rt.number} is ${rt.status.replace("_", " ")}; it can no longer be unlocked`);
  await c.query(`update delivery_route set status = 'draft', locked_at = null, locked_by = null where entity_id = $1 and id = $2`, [scope.entityId, routeId]);
  return { status: "draft" };
}

/** The driver leaves the DC. Needs a passing pre-trip inspection of that truck today. */
export async function startRoute(c: Client, scope: Scope, routeId: string, odometer?: number | null) {
  const rt = await routeFor(c, scope.entityId, routeId);
  need(rt.status === "locked", rt.status === "draft" ? `route ${rt.number} is not loaded yet; the dispatcher locks it once the truck is loaded` : `route ${rt.number} is ${rt.status.replace("_", " ")}`);
  const s = await settings(c, scope.entityId);
  const now = await localNow(c, s.tz);
  const d = await q<{ status: string }>(c, `
    select status from dvir where entity_id = $1 and vehicle_id = $2 and kind = 'pre_trip'
       and (submitted_at at time zone $3)::date = $4::date order by submitted_at desc limit 1`, [scope.entityId, rt.vehicle_id, s.tz, now.day]);
  need(d.length, "do the pre-trip inspection of the truck before starting the route");
  need(d[0].status !== "failed", "the truck failed its pre-trip inspection; a manager has to clear it");
  const left = await pendingPieces(c, scope.entityId, routeId);
  need(!left, `${left} piece(s) on route ${rt.number} are not loaded or marked short; the warehouse finishes the load first`);
  // A piece swapped in or flagged after booking still stops the truck until its prep is done.
  const onTruck = await q<{ id: string }>(c, `select distinct sl.sales_order_line_id id from delivery_stop_line sl join delivery_stop s on s.id = sl.stop_id
     where sl.entity_id = $1 and s.route_id = $2 and s.status in ('scheduled','arrived') and s.kind <> 'pickup' and sl.outcome = 'pending' and sl.sales_order_line_id is not null`,
    [scope.entityId, routeId]);
  const gate = await wms.gateOrQueue(c, scope, onTruck.map((x) => x.id), `starting route ${rt.number}`);
  need(!gate.refuse, gate.message ?? "");
  if (odometer != null) await recordOdometer(c, scope, rt.vehicle_id!, odometer, "route");
  await c.query(`update delivery_route set status = 'in_progress', started_at = now(), start_odometer = $3 where entity_id = $1 and id = $2`,
    [scope.entityId, routeId, odometer ?? null]);
  await etaAhead(c, scope, routeId, now.min, true);
  return { status: "in_progress" };
}

/** Recompute ETAs for the stops still ahead from now, and tell the next customer the crew is coming. */
async function etaAhead(c: Client, scope: Scope, routeId: string, nowMin: number, tellNext: boolean) {
  const rt = await routeFor(c, scope.entityId, routeId, false);
  const s = await settings(c, scope.entityId);
  const all = await routeStops(c, scope.entityId, routeId);
  const st = await q<{ id: string; status: string }>(c, `select id, status from delivery_stop where entity_id = $1 and route_id = $2`, [scope.entityId, routeId]);
  const open = new Set(st.filter((x) => ["scheduled", "arrived"].includes(x.status)).map((x) => x.id));
  const doneSeq = all.filter((x) => !open.has(x.id));
  const ahead = all.filter((x) => open.has(x.id));
  if (!ahead.length) return;
  const from = doneSeq.length ? doneSeq[doneSeq.length - 1].at : await dcPoint(c, scope.entityId, rt.dc_location_id);
  const p = R.simulate(from, ahead, cfgOf(s), nowMin);
  for (const x of p.stops) await c.query(`update delivery_stop set eta_min = $3 where entity_id = $1 and id = $2`, [scope.entityId, x.id, x.startMin]);
  if (tellNext) {
    const next = p.stops[0];
    const sent = await q(c, `select 1 from customer_message where entity_id = $1 and stop_id = $2 and kind = 'en_route'`, [scope.entityId, next.id]);
    if (!sent.length) await notify(c, scope, next.id, "en_route", { etaMin: next.startMin });
  }
}

export async function arriveStop(c: Client, scope: Scope, stopId: string) {
  const st = await stopRow(c, scope.entityId, stopId);
  need(st.route_id, "a will-call is not arrived at; complete it when the customer collects");
  need(st.route_status === "in_progress", "start the route before arriving at stops");
  need(st.status === "scheduled", `stop ${st.number} is already ${st.status}`);
  await c.query(`update delivery_stop set status = 'arrived', arrived_at = now() where entity_id = $1 and id = $2`, [scope.entityId, stopId]);
  return { status: "arrived" };
}

export type CompleteInput = {
  lines?: { id: string; outcome: string; note?: string }[];
  recipient?: string; signature?: string; photos?: string[];
  exception?: string; reason?: string;
  cod?: { method: string; amountMinor: bigint; reference?: string } | null;
};

/**
 * Finish a stop. Delivered lines leave stock and become a sale (fulfilLines,
 * then invoiceFulfilment with the cost it returns). Refused and damaged lines
 * stay unfulfilled and are flagged for the warehouse. Cash taken at the door
 * becomes a customer receipt, posted before the sale so it applies as a deposit.
 */
export async function completeStop(c: Client, scope: Scope, stopId: string, b: CompleteInput) {
  const st = await stopRow(c, scope.entityId, stopId);
  need(["scheduled", "arrived"].includes(st.status), `stop ${st.number} is already ${st.status}`);
  if (st.route_id) need(st.route_status === "in_progress", "start the route before completing stops");
  const unrecorded = await q<{ n: number }>(c, `select count(*)::int n from stop_haul_away where entity_id = $1 and stop_id = $2 and status = 'planned'`, [scope.entityId, stopId]);
  need(!unrecorded[0].n, `record what was hauled away from stop ${st.number} first (taken, with a photo, or not taken)`);
  const lines = await q<{ id: string; sales_order_line_id: string | null; description: string; line_status: string | null }>(c, `
    select sl.id, sl.sales_order_line_id, sl.description, ol.line_status
      from delivery_stop_line sl left join sales_order_line ol on ol.id = sl.sales_order_line_id
     where sl.entity_id = $1 and sl.stop_id = $2 and sl.outcome = 'pending' for update of sl`, [scope.entityId, stopId]);
  const exc = b.exception ? String(b.exception) : null;
  need(!exc || ["refused", "damaged", "not_home", "partial", "other"].includes(exc), "an exception is refused, damaged, not home, partial or other");
  const isPickup = st.kind === "pickup", isService = st.kind === "service";
  const okWord = isPickup ? "picked_up" : "delivered";
  const given = new Map((b.lines ?? []).map((x) => [x.id, x]));
  const outcome = new Map<string, { outcome: string; note: string }>();
  for (const l of lines) {
    const g = given.get(l.id);
    let o = g ? String(g.outcome) : exc === "not_home" || exc === "refused" ? (exc === "refused" ? "refused" : "not_delivered") : okWord;
    if (o === "delivered" && isPickup) o = "picked_up";
    need([okWord, "refused", "damaged", "not_delivered"].includes(o), `a line is ${okWord.replace("_", " ")}, refused, damaged or not delivered`);
    outcome.set(l.id, { outcome: o, note: String(g?.note ?? "").trim().slice(0, 300) });
  }
  const good = lines.filter((l) => outcome.get(l.id)!.outcome === okWord);
  const bad = lines.filter((l) => outcome.get(l.id)!.outcome !== okWord);
  const allBad = lines.length > 0 && !good.length;
  if (!isPickup && good.length) {
    const gate = await wms.gateOrQueue(c, scope, good.map((l) => l.sales_order_line_id).filter(isId) as string[], "delivering it");
    need(!gate.refuse, gate.message ?? "");
  }
  const reason = String(b.reason ?? "").trim();
  if (bad.length || (exc && exc !== "partial")) need(reason, "say what happened, for the customer's file");
  if (isService) need(!exc || reason, "say why the service call was not done");
  const handedOver = good.length > 0 || (isService && !exc);
  const sig = b.signature ? String(b.signature) : "";
  if (handedOver && st.kind !== "pickup") {
    need(sig.startsWith("data:image/") && sig.length > 100, "get the customer's signature");
    need(String(b.recipient ?? "").trim(), "write who signed for it");
  }
  need(sig.length <= 400000, "the signature image is too large");
  const photos = (b.photos ?? []).map(String).filter((u) => /^(https:\/\/|data:image\/)/.test(u)).slice(0, 10);
  need(photos.every((u) => u.length <= 2_000_000), "a photo is too large; send a link to it");
  for (const l of bad) if (outcome.get(l.id)!.outcome === "damaged") need(photos.length || outcome.get(l.id)!.note || reason, "describe or photograph the damage");

  // cash, check or card at the door
  let receiptId: string | null = null;
  if (b.cod && b.cod.amountMinor !== 0n) {
    need(st.sales_order_id, "cash on delivery is taken against an order");
    need(["cash", "check", "card"].includes(b.cod.method), "cash on delivery is cash, check or card");
    need(b.cod.amountMinor > 0n, "the amount collected is more than zero");
    const bal = await one<{ due: string; customer_id: string | null }>(c, `
      select (total_minor - paid_minor)::text due, customer_id from sales_order where entity_id = $1 and id = $2 for update`, [scope.entityId, st.sales_order_id]);
    need(b.cod.amountMinor <= BigInt(bal.due), `the order only has ${(Number(bal.due) / 100).toFixed(2)} due; do not collect more`);
    const ref = String(b.cod.reference ?? "").trim().slice(0, 40);
    need(!/[0-9]{12,}/.test(ref.replace(/\s/g, "")), "never write a full card number; the last four is enough");
    const number = await nextNo(c, scope.entityId, "receipt", "RC-");
    const r = await one<{ id: string }>(c, `
      insert into customer_receipt (entity_id, number, customer_id, sales_order_id, location_id, channel, method, amount_minor, reference, received_by)
      values ($1,$2,$3,$4,$5,'pos',$6,$7,nullif($8,''),$9) returning id`,
      [scope.entityId, number, bal.customer_id, st.sales_order_id, st.dc_location_id, b.cod.method, b.cod.amountMinor.toString(), ref, scope.actor.id || null]);
    await postReceipt(c, scope, r.id);
    receiptId = r.id;
  }

  // goods handed over: stock out, sale recognised
  let costMinor = 0n, journalEntryId: string | null = null;
  // this stop's own haul-away (what the crew recorded taking): invoiced with this stop, whatever else happens
  const haulLines = st.sales_order_id ? await haul.linesToInvoice(c, scope.entityId, stopId) : [];
  if (!isPickup && st.sales_order_id && good.length) {
    const ids = good.map((l) => l.sales_order_line_id).filter(isId);
    // fees, services and protection plans on the order go with its first delivery (haul-away lines go with their own stop)
    const extras = await q<{ id: string }>(c, `
      select l.id from sales_order_line l left join product p on p.id = l.product_id
       where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status = 'open' and l.qty > 0
         and (p.id is null or p.kind in ('fee','service','warranty'))
         and not exists (select 1 from stop_haul_away h where h.entity_id = $1 and (h.fee_line_id = l.id or h.trade_in_line_id = l.id))`, [scope.entityId, st.sales_order_id]);
    const all = [...ids, ...extras.map((x) => x.id), ...haulLines];
    const f = await inventory.fulfilLines(c, scope.entityId, st.sales_order_id, all);
    costMinor = f.costMinor;
    const inv = await invoiceFulfilment(c, scope, st.sales_order_id, all, f.costMinor);
    journalEntryId = inv.journalEntryId;
    await accrueCommissions(c, scope, { orderId: st.sales_order_id });   // commission is earned on delivery
    const left = await one<{ n: number }>(c, `select count(*)::int n from sales_order_line where entity_id = $1 and sales_order_id = $2
                                               and line_status in ('open','reserved','ready','on_order') and qty > 0`, [scope.entityId, st.sales_order_id]);
    await c.query(`update sales_order set status = $3 where entity_id = $1 and id = $2 and status in ('open','fulfilling')`,
      [scope.entityId, st.sales_order_id, left.n ? "fulfilling" : "fulfilled"]);
  } else if (haulLines.length) {
    // a pickup, or a delivery where nothing was handed over: the haul-away is still charged (and the trade-in credited)
    const f = await inventory.fulfilLines(c, scope.entityId, st.sales_order_id!, haulLines);
    const inv = await invoiceFulfilment(c, scope, st.sales_order_id!, haulLines, f.costMinor);
    journalEntryId = inv.journalEntryId;
  }
  if (haulLines.length) await haul.markInvoiced(c, scope.entityId, stopId);
  for (const l of lines) {
    const o = outcome.get(l.id)!;
    await c.query(`update delivery_stop_line set outcome = $3, note = nullif($4,''), flagged_for_warehouse = $5 where entity_id = $1 and id = $2`,
      [scope.entityId, l.id, o.outcome, o.note, o.outcome === "refused" || o.outcome === "damaged" || (isPickup && o.outcome === "picked_up")]);
  }
  const status = isService ? (exc ? "failed" : "delivered") : !lines.length ? (exc ? "failed" : "delivered") : allBad ? "failed" : bad.length ? "partial" : "delivered";
  const exception = status === "delivered" ? null : exc ?? (status === "partial" ? "partial" : "other");
  await c.query(`update delivery_stop set status = $3, completed_at = now(), completed_by = $4, exception = $5, exception_reason = nullif($6,''),
                        pod_recipient = nullif($7,''), pod_signature = nullif($8,''), pod_photos = $9, arrived_at = coalesce(arrived_at, now())
                  where entity_id = $1 and id = $2`,
    [scope.entityId, stopId, status, scope.actor.id || null, exception, reason, String(b.recipient ?? "").trim().slice(0, 120), sig, photos]);
  await notify(c, scope, stopId, status === "failed" ? "exception" : "delivered");
  if (st.route_id) {
    const s = await settings(c, scope.entityId);
    await etaAhead(c, scope, st.route_id, (await localNow(c, s.tz)).min, true);
  }
  return { status, delivered: good.length, flagged: bad.filter((l) => ["refused", "damaged"].includes(outcome.get(l.id)!.outcome)).length + (isPickup ? good.length : 0),
    costMinor, journalEntryId, receiptId };
}

export async function finishRoute(c: Client, scope: Scope, routeId: string, odometer?: number | null) {
  const rt = await routeFor(c, scope.entityId, routeId);
  need(rt.status === "in_progress", `route ${rt.number} is not under way`);
  const open = await q<{ number: string }>(c, `select number from delivery_stop where entity_id = $1 and route_id = $2 and status in ('scheduled','arrived')`, [scope.entityId, routeId]);
  need(!open.length, `finish every stop first: ${open.map((x) => x.number).join(", ")} still open`);
  let miles: number | null = null;
  if (odometer != null) {
    const r = await one<{ start_odometer: number | null }>(c, `select start_odometer from delivery_route where entity_id = $1 and id = $2`, [scope.entityId, routeId]);
    await recordOdometer(c, scope, rt.vehicle_id!, odometer, "route");
    if (r.start_odometer != null) miles = odometer - r.start_odometer;
  }
  await c.query(`update delivery_route set status = 'completed', finished_at = now(), end_odometer = $3, actual_miles = $4 where entity_id = $1 and id = $2`,
    [scope.entityId, routeId, odometer ?? null, miles]);
  // pieces refused or not delivered come back off the truck
  await unloadLeftovers(c, scope, routeId);
  return { status: "completed", miles };
}

// ------------------------------------------------------ manifest & load --

export async function manifest(c: Client, entityId: string, routeId: string) {
  const r = await route(c, entityId, routeId);
  const stopsOut = (r.stops as Record<string, unknown>[]).map((s) => ({
    seq: s.seq, number: s.number, kind: s.kind, customer: s.customer, phone: s.phone,
    address: [s.line1, s.line2, `${s.city ?? ""}, ${s.state ?? ""} ${s.postal ?? ""}`].filter(Boolean).join(", "),
    window: s.window_label, eta: s.eta, stairs: s.stairs, notes: [s.address_notes, s.notes, s.problem ? `Problem: ${s.problem}` : null].filter(Boolean).join(" · "),
    order: s.order_number, pieces: s.pieces, codMinor: s.kind === "delivery" ? String(s.cod_minor) : "0",
    items: (s.lines as Record<string, unknown>[]).map((l) => ({ sku: l.sku, description: l.description, qty: l.qty, pieces: l.pieces,
      serials: ((l as { units?: { label: string; serial: string | null; lot: string | null }[] }).units ?? []).map((x) => ({ label: x.label, serial: x.serial, lot: x.lot })) })),
    haulAway: ((s.haulAway as Record<string, unknown>[]) ?? []).map((h) => ({ description: h.description, qty: h.qty, category: h.category })),
  }));
  const cod = stopsOut.reduce((a, s) => a + BigInt(s.codMinor), 0n);
  return { route: { number: r.number, day: r.route_on, dc: r.dc_name, truck: r.unit_no, driver: r.driver, helper: r.helper, status: r.status,
    miles: r.planned_miles, minutes: r.planned_minutes },
    stops: stopsOut, totals: { stops: stopsOut.length, pieces: stopsOut.reduce((a, s) => a + n(s.pieces), 0), codMinor: cod.toString() },
    loadOrder: [...stopsOut].reverse().map((s) => s.number) };
}

/**
 * What to pull and in what order to load it: last stop on first. Uses the
 * inventory module's pickListFor when it is there (bins, pieces); otherwise
 * lists the orders' lines.
 */
export async function loadList(c: Client, entityId: string, routeId: string) {
  const r = await route(c, entityId, routeId);
  const reversed = [...(r.stops as Record<string, unknown>[])].reverse();
  const orderIds = [...new Set(reversed.map((s) => s.order_id).filter(isId))] as string[];
  const fn = (inventory as Record<string, unknown>).pickListFor;
  let pick: unknown = null, source = "order lines";
  if (typeof fn === "function" && orderIds.length) {
    pick = await (fn as (c: Client, e: string, ids: string[]) => Promise<unknown>)(c, entityId, orderIds);
    source = "inventory";
  }
  const lines = orderIds.length ? await q(c, `
    select l.sales_order_id, l.sku, l.description, l.qty::float qty, fl.name from_location, l.line_status
      from sales_order_line l left join location fl on fl.id = l.fulfil_from_id
     where l.entity_id = $1 and l.sales_order_id = any($2)
       and exists (select 1 from delivery_stop_line sl join delivery_stop s on s.id = sl.stop_id
                    where sl.entity_id = $1 and sl.sales_order_line_id = l.id and s.route_id = $3 and sl.outcome <> 'cancelled')
     order by l.seq`, [entityId, orderIds, routeId]) : [];
  return {
    route: r.number, truck: r.unit_no, source, pickList: pick,
    load: reversed.map((s, i) => ({ loadSeq: i + 1, stop: s.number, deliverSeq: s.seq, customer: s.customer, kind: s.kind,
      items: s.order_id ? lines.filter((l) => l.sales_order_id === s.order_id) : (s.lines as unknown[]) })),
  };
}

// ------------------------------------------------------------ dashboard --

export async function dashboard(c: Client, entityId: string, day: string) {
  need(DAY.test(day), "pick a day");
  const s = await settings(c, entityId);
  const rts = await routes(c, entityId, day);
  const st = await q<{ status: string; on_time: boolean | null; kind: string }>(c, `
    select s.status, s.kind,
           case when s.completed_at is null or w.ends is null then null
                else (s.arrived_at at time zone $3)::time <= w.ends end on_time
      from delivery_stop s left join delivery_window w on w.id = s.window_id
     where s.entity_id = $1 and s.scheduled_on = $2 and s.status <> 'cancelled' and s.kind <> 'will_call'`, [entityId, day, s.tz]);
  const done = st.filter((x) => ["delivered", "partial", "failed"].includes(x.status));
  const timed = done.filter((x) => x.on_time != null);
  const hrs = await one<{ h: number }>(c, `
    select coalesce(sum(extract(epoch from coalesce(finished_at, now()) - started_at)) / 3600, 0)::float h
      from delivery_route where entity_id = $1 and route_on = $2 and started_at is not null and status <> 'cancelled'`, [entityId, day]);
  const fuel = await q<{ ppg: number | null }>(c, `
    select (sum(cost_minor)::float / nullif(sum(gallons),0))::float ppg from fuel_log where entity_id = $1 and filled_on > business_today($1) - 60`, [entityId]);
  const ppg = fuel[0]?.ppg ?? Number(s.fuelPriceMinor);
  const mpg = await q<{ id: string; mpg: number; crew: number }>(c, `
    select r.id, coalesce(v.mpg, 9)::float mpg, (1 + (r.helper_id is not null)::int) crew
      from delivery_route r left join vehicle v on v.id = r.vehicle_id where r.entity_id = $1 and r.route_on = $2 and r.status <> 'cancelled'`, [entityId, day]);
  let fuelCost = 0, laborCost = 0, miles = 0;
  for (const r of rts as Record<string, unknown>[]) {
    const m = mpg.find((x) => x.id === r.id);
    const mi = n(r.planned_miles);
    miles += mi;
    fuelCost += (mi / (m?.mpg ?? 9)) * ppg;
    laborCost += (n(r.planned_minutes) / 60) * (m?.crew ?? 1) * Number(s.laborHourMinor);
  }
  const stopCount = st.length;
  const failed = await q(c, `
    select s.id, s.number, s.kind, cu.name customer, s.exception, s.exception_reason, r.number route_number
      from delivery_stop s left join customer cu on cu.id = s.customer_id left join delivery_route r on r.id = s.route_id
     where s.entity_id = $1 and s.scheduled_on = $2 and (s.status in ('failed','partial'))
     order by s.number`, [entityId, day]);
  const flagged = await q(c, `
    select sl.id, sl.description, sl.qty::float qty, sl.outcome, sl.note, s.number stop_number, s.kind, s.completed_at,
           (select t.number from service_ticket t where t.entity_id = sl.entity_id and t.origin_stop_line_id = sl.id and t.status <> 'cancelled' limit 1) service_ticket
      from delivery_stop_line sl join delivery_stop s on s.id = sl.stop_id
     where sl.entity_id = $1 and sl.flagged_for_warehouse and s.completed_at > now() - interval '14 days'
     order by s.completed_at desc limit 50`, [entityId]);
  const oos = await q(c, `select id, unit_no, oos_reason from vehicle where entity_id = $1 and status = 'out_of_service' order by unit_no`, [entityId]);
  const queue = await deliveryQueue(c, entityId);
  const due = (await maintenanceDue(c, entityId)).filter((m) => m.state !== "ok");
  const willCalls = await q(c, `
    select s.id, s.number, cu.name customer, so.number order_number, s.status from delivery_stop s
      join customer cu on cu.id = s.customer_id left join sales_order so on so.id = s.sales_order_id
     where s.entity_id = $1 and s.kind = 'will_call' and s.status = 'scheduled' and (s.scheduled_on is null or s.scheduled_on <= $2)
     order by s.scheduled_on nulls last, s.number`, [entityId, day]);
  return {
    day, routes: rts,
    stops: { total: stopCount, done: done.length, failed: st.filter((x) => x.status === "failed").length, partial: st.filter((x) => x.status === "partial").length },
    onTimePct: timed.length ? Math.round((100 * timed.filter((x) => x.on_time).length) / timed.length) : null,
    stopsPerHour: hrs.h > 0.05 ? Math.round((done.length / hrs.h) * 10) / 10 : null,
    miles: Math.round(miles * 10) / 10,
    costPerStopMinor: stopCount ? BigInt(Math.round((fuelCost + laborCost) / stopCount)).toString() : null,
    fuelCostMinor: BigInt(Math.round(fuelCost)).toString(), laborCostMinor: BigInt(Math.round(laborCost)).toString(),
    failed, flagged, outOfService: oos, maintenanceDue: due, queue: queue.length, willCalls,
  };
}

/** What booking an order involves: its zone, the lines ready to go, and their size. */
export async function orderBooking(c: Client, entityId: string, orderId: string) {
  need(isId(orderId), "no such order");
  const so = await q<{ id: string; number: string; postal: string | null; stairs: number | null; customer: string | null; balance_minor: string }>(c, `
    select so.id, so.number, a.postal, a.stairs, cu.name customer, (so.total_minor - so.paid_minor)::text balance_minor
      from sales_order so left join customer_address a on a.id = so.ship_address_id left join customer cu on cu.id = so.customer_id
     where so.entity_id = $1 and so.id = $2`, [entityId, orderId]);
  need(so.length, "no such order");
  const s = await settings(c, entityId);
  const lines = await bookableLines(c, entityId, orderId, null, ["reserved", "ready"]);
  const pieces = lines.reduce((a, l) => a + n(l.pieces), 0);
  const size = { pieces, cube: lines.reduce((a, l) => a + n(l.cube), 0), weight: lines.reduce((a, l) => a + n(l.weight), 0),
    labor: Math.round(R.serviceMinutes({ id: "", at: { lng: 0, lat: 0 }, pieces, stairs: so[0].stairs ?? 0 }, cfgOf(s))) };
  const zone = so[0].postal ? await zoneForPostal(c, entityId, so[0].postal) : null;
  return { order: so[0], zone, lines, size };
}


/** "Find on map": look the address up again now, whatever happened before. */
export async function locateAddress(c: Client, scope: Scope, addressId: string) {
  need(isId(addressId), "no such address");
  const a = await q<{ customer: string | null; line1: string; city: string }>(c, `
    select cu.name customer, a.line1, a.city from customer_address a left join customer cu on cu.id = a.customer_id
     where a.entity_id = $1 and a.id = $2`, [scope.entityId, addressId]);
  need(a.length, "no such address");
  const r = await geocodeAddress(c, scope.entityId, addressId, true);
  need(r.ok, `could not place ${whereWords(a[0])} on the map: ${r.ok ? "" : r.reason}. Enter its latitude and longitude instead`);
  await replanRoutesAt(c, scope.entityId, addressId);
  return r;
}

/** A dispatcher puts the address on the map by hand. */
export async function placeAddress(c: Client, scope: Scope, addressId: string, lat: number, lng: number) {
  need(isId(addressId), "no such address");
  try { await setManualGeo(c, scope.entityId, addressId, lat, lng); }
  catch (e) { if (e instanceof GeocodeError) throw new FleetError(e.message); throw e; }
  await replanRoutesAt(c, scope.entityId, addressId);
  return { ok: true, lat, lng, source: "manual" };
}

/** A point moved: refresh the ETAs of any draft route that visits it. */
async function replanRoutesAt(c: Client, entityId: string, addressId: string) {
  const rs = await q<{ route_id: string }>(c, `
    select distinct s.route_id from delivery_stop s join delivery_route r on r.id = s.route_id
     where s.entity_id = $1 and s.address_id = $2 and r.status = 'draft' and s.status = 'scheduled'`, [entityId, addressId]);
  for (const r of rs) await replan(c, entityId, r.route_id);
}
