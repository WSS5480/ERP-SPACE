// fleet module -- vehicles, inspections, crews, delivery zones and windows,
// booking, route building, the driver's phone, proof of delivery, COD, and
// customer messages. See docs/MODULES.md for the contract.
//
// Who does what (owner passes every check):
//   dispatcher, store_manager   zones, booking, routes, vehicles, crews
//   sales                       books deliveries and sends self-schedule links
//   warehouse                   manifests, load lists, will-call release
//   driver                      their own routes only; inspections, fuel, stops
//   store_manager               clears a failed inspection (a manager, never the driver who filed it)

import { tx, type Scope } from "../../packages/core/db.ts";
import * as F from "../../packages/core/fleet.ts";
import { InventoryError } from "../../packages/core/inventory.ts";
import { ArError } from "../../packages/core/ar.ts";
import { PostingError } from "../../packages/core/posting.ts";
import { rolesOf } from "../actions.ts";
import { ModuleError, need, requireRole, minor, str, uuid, int, type ErpModule, type Client, type Company, type Actor } from "./kit.ts";

const ID = "([0-9a-fA-F-]{36})";
const TOKEN = "([A-Za-z0-9_-]{20,100})";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const DISPATCH = ["dispatcher", "store_manager"];
const BOOK = ["dispatcher", "store_manager", "sales"];
const LOAD = ["warehouse", "dispatcher", "store_manager"];
const CREW = ["driver", "dispatcher", "store_manager"];
const STAFF = ["owner", "dispatcher", "store_manager", "warehouse"];

const scopeOf = (co: Company, a: Actor): Scope => ({ tenantId: co.tenantId, entityId: co.id, actor: { kind: "user", id: a.personId, label: a.label } });

/** The engine's own refusals reach the person as sentences. */
async function plain<R>(fn: () => Promise<R>): Promise<R> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof F.FleetError || e instanceof InventoryError || e instanceof ArError || e instanceof PostingError) throw new ModuleError(e.message);
    throw e;
  }
}

/** Reads: with no acting person named this is the operator's own token, which sees what the owner sees. */
async function viewer(c: Client, co: Company, personId: string | null) {
  if (!personId) return { personId: null as string | null, staff: true, held: new Set(["owner"]) };
  const held = await rolesOf(c, co, personId);
  return { personId, staff: STAFF.some((r) => held.has(r)), held };
}
function canRead(v: { held: Set<string> }, roles: string[], doing: string) {
  need(v.held.has("owner") || roles.some((r) => v.held.has(r)), `${doing} needs one of: ${roles.map((r) => r.replace(/_/g, " ")).join(", ")}`);
}

/** A driver sees and works only the routes they are on. */
async function onRoute(c: Client, co: Company, personId: string | null, routeId: string, staff: boolean) {
  if (staff) return;
  const r = await c.query(`select 1 from delivery_route where entity_id = $1 and id = $2 and (driver_id = $3 or helper_id = $3)`, [co.id, routeId, personId]);
  need(r.rowCount, "that route belongs to another driver");
}
async function routeOfStop(c: Client, co: Company, stopId: string): Promise<string | null> {
  const r = await c.query<{ route_id: string | null }>(`select route_id from delivery_stop where entity_id = $1 and id = $2`, [co.id, stopId]);
  need(r.rowCount, "no such stop");
  return r.rows[0].route_id;
}

const dayParam = (url: URL) => {
  const d = url.searchParams.get("day") ?? "";
  return DAY.test(d) ? d : null;
};
async function today(c: Client, co: Company) {
  return (await F.localNow(c, (await F.settings(c, co.id)).tz)).day;
}
const publicBase = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");

export const module: ErpModule = {
  id: "fleet",
  register({ coGet, coPost, publicRoute }) {
    // ------------------------------------------------------------ dashboard
    coGet("/fleet/home", async (c, co, url, _m, p) => {
      const v = await viewer(c, co, p);
      canRead(v, [...STAFF, "sales"], "the delivery dashboard");
      return plain(async () => F.dashboard(c, co.id, dayParam(url) ?? await today(c, co)));
    });
    coGet("/fleet/options", async (c, co, _u, _m, p) => {
      await viewer(c, co, p);
      return plain(async () => {
        const [locs, vs, ds, zs, s] = await Promise.all([
          c.query(`select id, code, name, kind, geo is not null mapped from location where entity_id = $1 and status = 'active' and kind <> 'web' order by kind <> 'warehouse', name`, [co.id]),
          c.query(`select id, unit_no, kind, status, home_location_id, crew_size from vehicle where entity_id = $1 and status <> 'retired' order by unit_no`, [co.id]),
          F.drivers(c, co.id, co.tenantId),
          c.query(`select id, code, name from delivery_zone where entity_id = $1 and active order by code`, [co.id]),
          F.settings(c, co.id),
        ]);
        return { locations: locs.rows, vehicles: vs.rows, drivers: ds, zones: zs.rows, dvirItems: F.DVIR_ITEMS, vehicleKinds: F.VEHICLE_KINDS,
          today: (await F.localNow(c, s.tz)).day, settings: { ...s, laborHourMinor: s.laborHourMinor.toString(), fuelPriceMinor: s.fuelPriceMinor.toString() } };
      });
    });

    // ------------------------------------------------------------- vehicles
    coGet("/fleet/vehicles", async (c, co, _u, _m, p) => {
      canRead(await viewer(c, co, p), [...STAFF, "driver"], "the vehicle list");
      return plain(() => F.vehicles(c, co.id));
    });
    coGet(`/fleet/vehicles/${ID}`, async (c, co, _u, m, p) => {
      canRead(await viewer(c, co, p), [...STAFF, "driver"], "a vehicle's record");
      return plain(() => F.vehicle(c, co.id, m[2]));
    });
    coPost("/fleet/vehicles", async (c, co, a, b) => {
      await requireRole(c, co, a, DISPATCH, "adding a vehicle");
      return plain(() => F.addVehicle(c, scopeOf(co, a), b));
    });
    coPost(`/fleet/vehicles/${ID}/status`, async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, DISPATCH, "changing a vehicle's status");
      need(b.status !== "active" || held.has("owner") || held.has("store_manager"), "putting a truck back in service is for a manager");
      return plain(() => F.setVehicleStatus(c, scopeOf(co, a), m[2], str(b.status, 30), str(b.reason)));
    });
    coPost(`/fleet/vehicles/${ID}/odometer`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, CREW, "recording an odometer reading");
      await plain(() => F.recordOdometer(c, scopeOf(co, a), m[2], int(b.readingMi, -1), "manual"));
      return { ok: true };
    });
    coPost(`/fleet/vehicles/${ID}/schedules`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, DISPATCH, "setting a maintenance schedule");
      return plain(() => F.addSchedule(c, scopeOf(co, a), m[2], b));
    });
    coPost(`/fleet/vehicles/${ID}/service`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, DISPATCH, "recording a service");
      return plain(() => F.recordService(c, scopeOf(co, a), m[2], b, minor(b.cost ?? 0)));
    });
    coPost(`/fleet/vehicles/${ID}/fuel`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, CREW, "logging fuel");
      return plain(() => F.logFuel(c, scopeOf(co, a), m[2], b, minor(b.cost ?? 0)));
    });
    coGet("/fleet/maintenance", async (c, co, _u, _m, p) => {
      canRead(await viewer(c, co, p), STAFF, "the maintenance list");
      return plain(() => F.maintenanceDue(c, co.id));
    });

    // ---------------------------------------------------------- inspections
    coGet("/fleet/dvir/items", async () => F.DVIR_ITEMS);
    coPost("/fleet/dvir", async (c, co, a, b) => {
      await requireRole(c, co, a, CREW, "filing an inspection");
      return plain(() => F.submitDvir(c, scopeOf(co, a), b));
    });
    coPost(`/fleet/dvir/${ID}/clear`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, ["store_manager"], "clearing a failed inspection");
      return plain(() => F.clearDvir(c, scopeOf(co, a), m[2], str(b.note)));
    });

    // -------------------------------------------------------------- drivers
    coGet("/fleet/drivers", async (c, co, url, _m, p) => {
      canRead(await viewer(c, co, p), STAFF, "the crew list");
      return plain(() => F.drivers(c, co.id, co.tenantId, dayParam(url) ?? undefined));
    });
    coPost("/fleet/drivers", async (c, co, a, b) => {
      await requireRole(c, co, a, DISPATCH, "setting up a driver");
      return plain(() => F.saveDriver(c, scopeOf(co, a), { ...b, hourlyCostMinor: b.hourlyCost != null && b.hourlyCost !== "" ? minor(b.hourlyCost) : null }));
    });

    // ---------------------------------------------------------------- zones
    coGet("/fleet/zones", async (c, co, _u, _m, p) => {
      canRead(await viewer(c, co, p), [...STAFF, "sales"], "delivery zones");
      return plain(() => F.zones(c, co.id));
    });
    coPost("/fleet/zones", async (c, co, a, b) => {
      await requireRole(c, co, a, DISPATCH, "setting up a delivery zone");
      return plain(() => F.saveZone(c, scopeOf(co, a), { ...b, feeMinor: minor(b.fee ?? 0) }));
    });
    coPost(`/fleet/zones/${ID}/windows`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, DISPATCH, "setting a delivery window");
      return plain(() => F.saveWindow(c, scopeOf(co, a), m[2], b));
    });
    coPost("/fleet/blackouts", async (c, co, a, b) => {
      await requireRole(c, co, a, DISPATCH, "closing a delivery day");
      return plain(() => F.addBlackout(c, scopeOf(co, a), b));
    });

    // ------------------------------------------------------------- booking
    coGet("/fleet/queue", async (c, co, _u, _m, p) => {
      canRead(await viewer(c, co, p), [...STAFF, "sales"], "the delivery queue");
      return plain(() => F.deliveryQueue(c, co.id));
    });
    coGet("/fleet/availability", async (c, co, url, _m, p) => {
      canRead(await viewer(c, co, p), [...STAFF, "sales"], "delivery availability");
      return plain(async () => {
        const order = uuid(url.searchParams.get("order"));
        const from = dayParam(url) ?? await today(c, co);
        const days = Math.min(Math.max(int(url.searchParams.get("days"), 14), 1), 60);
        if (order) {
          const ob = await F.orderBooking(c, co.id, order);
          need(ob.zone, `postal code ${ob.order.postal ?? "(none)"} is outside every delivery zone`);
          return { order: ob.order, zone: ob.zone, size: ob.size, lines: ob.lines, slots: await F.availability(c, co.id, ob.zone.id, from, days, ob.size) };
        }
        const zone = uuid(url.searchParams.get("zone"));
        need(zone, "pick a zone or an order");
        return { slots: await F.availability(c, co.id, zone, from, days) };
      });
    });
    // customers and their addresses, for booking a service call or a pickup
    coGet("/fleet/customers", async (c, co, url, _m, p) => {
      canRead(await viewer(c, co, p), [...STAFF, "sales"], "looking up a customer");
      const term = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
      need(term.length >= 2, "type at least two letters of the name or phone");
      const r = await c.query(`
        select cu.id, cu.number, cu.name, cu.phone,
               coalesce(json_agg(json_build_object('id', a.id, 'label', a.label, 'line1', a.line1, 'city', a.city, 'postal', a.postal)
                 order by a.is_default desc) filter (where a.id is not null), '[]') addresses
          from customer cu left join customer_address a on a.customer_id = cu.id and a.entity_id = cu.entity_id
         where cu.entity_id = $1 and (lower(cu.name) like '%' || lower($2) || '%' or cu.phone like '%' || $2 || '%' or cu.number = upper($2))
         group by cu.id order by cu.name limit 20`, [co.id, term]);
      const orders = await c.query(`
        select so.id, so.number, so.customer_id from sales_order so
         where so.entity_id = $1 and so.customer_id = any($2) and so.status not in ('draft','cancelled')
         order by so.ordered_at desc`, [co.id, r.rows.map((x) => x.id)]);
      return r.rows.map((x) => ({ ...x, orders: orders.rows.filter((o) => o.customer_id === x.id).slice(0, 10) }));
    });
    coGet("/fleet/stops", async (c, co, url, _m, p) => {
      canRead(await viewer(c, co, p), [...STAFF, "sales"], "the day's stops");
      return plain(async () => F.stops(c, co.id, dayParam(url) ?? await today(c, co), uuid(url.searchParams.get("dc"))));
    });
    coPost("/fleet/stops", async (c, co, a, b) => {
      const held = await requireRole(c, co, a, BOOK, "booking a stop");
      const override = str(b.override);
      need(!override || held.has("owner") || DISPATCH.some((r) => held.has(r)), "booking past a window's capacity is for a dispatcher or a manager");
      return plain(() => F.bookStop(c, scopeOf(co, a), {
        kind: str(b.kind, 20) || "delivery", orderId: uuid(b.orderId) ?? undefined,
        lineIds: Array.isArray(b.lineIds) ? b.lineIds.map(String) : undefined,
        customerId: uuid(b.customerId) ?? undefined, addressId: uuid(b.addressId) ?? undefined,
        day: str(b.day, 10) || undefined, windowId: uuid(b.windowId) ?? undefined, notes: str(b.notes), problem: str(b.problem),
        dcLocationId: uuid(b.dcLocationId) ?? undefined, override,
        pickupLines: Array.isArray(b.pickupLines) ? b.pickupLines as { description: string }[] : undefined,
        allowToday: !!(held.has("owner") || DISPATCH.some((r) => held.has(r))),
      }));
    });
    coPost(`/fleet/stops/${ID}/reschedule`, async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, BOOK, "rescheduling a stop");
      const override = str(b.override);
      const disp = held.has("owner") || DISPATCH.some((r) => held.has(r));
      need(!override || disp, "booking past a window's capacity is for a dispatcher or a manager");
      return plain(() => F.reschedule(c, scopeOf(co, a), m[2], str(b.day, 10), str(b.windowId, 40), disp, override));
    });
    coPost(`/fleet/stops/${ID}/cancel`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, BOOK, "cancelling a stop");
      return plain(() => F.cancelStop(c, scopeOf(co, a), m[2], str(b.reason)));
    });
    coPost(`/fleet/orders/${ID}/link`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, BOOK, "sending a self-scheduling link");
      return plain(() => F.createLink(c, scopeOf(co, a), m[2], publicBase()));
    });

    // --------------------------------------------------------------- routes
    coGet("/fleet/routes", async (c, co, url, _m, p) => {
      const v = await viewer(c, co, p);
      canRead(v, [...STAFF, "driver"], "routes");
      return plain(async () => F.routes(c, co.id, dayParam(url) ?? await today(c, co),
        { dcId: uuid(url.searchParams.get("dc")), personId: v.staff ? null : v.personId }));
    });
    coPost("/fleet/routes/build", async (c, co, a, b) => {
      await requireRole(c, co, a, DISPATCH, "building routes");
      return plain(() => F.buildRoutes(c, scopeOf(co, a), str(b.day, 10), str(b.dcId, 40)));
    });
    coPost("/fleet/routes", async (c, co, a, b) => {
      await requireRole(c, co, a, DISPATCH, "adding a route");
      return plain(() => F.addRoute(c, scopeOf(co, a), str(b.day, 10), str(b.dcId, 40), str(b.vehicleId, 40)));
    });
    coGet(`/fleet/routes/${ID}`, async (c, co, _u, m, p) => {
      const v = await viewer(c, co, p);
      canRead(v, [...STAFF, "driver"], "a route");
      await onRoute(c, co, v.personId, m[2], v.staff);
      return plain(() => F.route(c, co.id, m[2]));
    });
    coGet(`/fleet/routes/${ID}/manifest`, async (c, co, _u, m, p) => {
      const v = await viewer(c, co, p);
      canRead(v, [...STAFF, "driver"], "a manifest");
      await onRoute(c, co, v.personId, m[2], v.staff);
      return plain(() => F.manifest(c, co.id, m[2]));
    });
    coGet(`/fleet/routes/${ID}/load`, async (c, co, _u, m, p) => {
      const v = await viewer(c, co, p);
      canRead(v, [...STAFF, "driver"], "a load list");
      await onRoute(c, co, v.personId, m[2], v.staff);
      return plain(() => F.loadList(c, co.id, m[2]));
    });
    coPost(`/fleet/routes/${ID}/crew`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, DISPATCH, "changing a route's crew");
      return plain(() => F.setCrew(c, scopeOf(co, a), m[2], {
        vehicleId: b.vehicleId === undefined ? undefined : uuid(b.vehicleId), driverId: b.driverId === undefined ? undefined : uuid(b.driverId),
        helperId: b.helperId === undefined ? undefined : uuid(b.helperId), startMin: b.startMin != null ? int(b.startMin) : undefined }));
    });
    coPost(`/fleet/routes/${ID}/reoptimise`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, DISPATCH, "re-optimising a route");
      return plain(() => F.reoptimise(c, scopeOf(co, a), m[2]));
    });
    coPost(`/fleet/routes/${ID}/lock`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, LOAD, "locking a loaded route");
      return plain(() => F.lockRoute(c, scopeOf(co, a), m[2]));
    });
    coPost(`/fleet/routes/${ID}/unlock`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, DISPATCH, "unlocking a route");
      return plain(() => F.unlockRoute(c, scopeOf(co, a), m[2]));
    });
    coPost(`/fleet/routes/${ID}/start`, async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, CREW, "starting a route");
      await onRoute(c, co, a.personId, m[2], STAFF.some((r) => held.has(r)));
      return plain(() => F.startRoute(c, scopeOf(co, a), m[2], b.odometerMi != null && b.odometerMi !== "" ? int(b.odometerMi) : null));
    });
    coPost(`/fleet/routes/${ID}/finish`, async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, CREW, "finishing a route");
      await onRoute(c, co, a.personId, m[2], STAFF.some((r) => held.has(r)));
      return plain(() => F.finishRoute(c, scopeOf(co, a), m[2], b.odometerMi != null && b.odometerMi !== "" ? int(b.odometerMi) : null));
    });
    coPost(`/fleet/stops/${ID}/move`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, DISPATCH, "reordering stops");
      return plain(() => F.moveStop(c, scopeOf(co, a), m[2], b.dir === "up" ? "up" : "down"));
    });
    coPost(`/fleet/stops/${ID}/assign`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, DISPATCH, "moving a stop between routes");
      return plain(() => F.assignStop(c, scopeOf(co, a), m[2], uuid(b.routeId)));
    });

    // ------------------------------------------------------- driver's phone
    coGet("/fleet/my", async (c, co, url, _m, p) => {
      need(p, "pick who you are acting as");
      const v = await viewer(c, co, p);
      canRead(v, CREW, "the driver screen");
      return plain(async () => {
        const day = dayParam(url) ?? await today(c, co);
        const mine = await F.routes(c, co.id, day, { personId: p });
        const full = [];
        for (const r of mine as { id: string; vehicle_id: string | null }[]) {
          const d = await c.query<{ status: string }>(`
            select status from dvir where entity_id = $1 and vehicle_id = $2 and kind = 'pre_trip'
               and (submitted_at at time zone $3)::date = $4::date order by submitted_at desc limit 1`,
            [co.id, r.vehicle_id, (await F.settings(c, co.id)).tz, day]);
          full.push({ ...(await F.route(c, co.id, r.id)), preTrip: d.rows[0]?.status ?? null });
        }
        return { day, routes: full, dvirItems: F.DVIR_ITEMS };
      });
    });
    coPost(`/fleet/stops/${ID}/arrive`, async (c, co, a, _b, m) => {
      const held = await requireRole(c, co, a, CREW, "arriving at a stop");
      const rid = await routeOfStop(c, co, m[2]);
      if (rid) await onRoute(c, co, a.personId, rid, STAFF.some((r) => held.has(r)));
      return plain(() => F.arriveStop(c, scopeOf(co, a), m[2]));
    });
    coPost(`/fleet/stops/${ID}/complete`, async (c, co, a, b, m) => {
      const rid = await routeOfStop(c, co, m[2]);
      const held = await requireRole(c, co, a, rid ? CREW : LOAD, rid ? "completing a stop" : "releasing a will-call");
      if (rid) await onRoute(c, co, a.personId, rid, STAFF.some((r) => held.has(r)));
      const cod = b.cod && typeof b.cod === "object" ? b.cod as Record<string, unknown> : null;
      return plain(() => F.completeStop(c, scopeOf(co, a), m[2], {
        lines: Array.isArray(b.lines) ? (b.lines as Record<string, unknown>[]).map((x) => ({ id: str(x.id, 40), outcome: str(x.outcome, 20), note: str(x.note, 300) })) : undefined,
        recipient: str(b.recipient, 120), signature: typeof b.signature === "string" ? b.signature : undefined,
        photos: Array.isArray(b.photos) ? b.photos.map(String) : undefined, exception: str(b.exception, 20) || undefined, reason: str(b.reason),
        cod: cod && cod.amount != null && cod.amount !== "" ? { method: str(cod.method, 20), amountMinor: minor(cod.amount), reference: str(cod.reference, 40) } : null,
      }));
    });

    // ------------------------------------------------------------ messages
    coGet("/fleet/messages", async (c, co, url, _m, p) => {
      canRead(await viewer(c, co, p), [...STAFF, "sales"], "customer messages");
      return plain(() => F.messages(c, co.id, { stopId: uuid(url.searchParams.get("stop")) ?? undefined, day: dayParam(url) ?? undefined }));
    });
    coPost("/fleet/messages/day-before", async (c, co, a, b) => {
      await requireRole(c, co, a, DISPATCH, "sending day-before reminders");
      return plain(() => F.sendDayBefore(c, scopeOf(co, a), str(b.day, 10)));
    });

    // ------------------------------------- customer self-scheduling (public)
    // No token, no session: the link's own random token is the only key, and
    // it opens one order's delivery booking and nothing else.
    publicRoute("GET", new RegExp(`^/delivery/schedule/${TOKEN}$`), async (_req, _url, m) => {
      const out = await tx({ kind: "system", label: "customer (self-schedule link)" }, (c) => plain(() => F.publicView(c, m[1])));
      return [200, out];
    });
    publicRoute("POST", new RegExp(`^/delivery/schedule/${TOKEN}$`), async (_req, _url, m, body) => {
      const out = await tx({ kind: "system", label: "customer (self-schedule link)" },
        (c) => plain(() => F.publicPick(c, m[1], str(body.day, 10), str(body.windowId, 40))));
      return [200, out];
    });
  },
};
