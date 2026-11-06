// Fleet and delivery checks. Pure routing first (no database), then the
// whole day against the seed: book, build, load, inspect, drive, deliver,
// collect, and the refusals that matter -- capacity, expired licences,
// failed inspections, another driver's route, another company's data.

import { type T, ENTITY, RIO_ENTITY, PEOPLE } from "./harness.ts";
import { tx, type Client } from "../../packages/core/db.ts";
import * as R from "../../packages/core/routing.ts";
import * as F from "../../packages/core/fleet.ts";
import { reserveOrder, releaseLines } from "../../packages/core/inventory.ts";
import { module as fleetModule } from "../../server/modules/fleet.ts";
import type { Company, Actor } from "../../server/modules/kit.ts";
import { loadCompany } from "../../server/views.ts";
import { censusGeocoder, setGeocoder, geocoder, CENSUS_URL, type FetchLike } from "../../packages/core/geocode.ts";

// A real US Census Geocoder answer (onelineaddress, Public_AR_Current, format=json), for the
// Census Bureau's own address. The workspace has no internet, so tests feed it through a fake fetch.
const CENSUS_HIT = {"result":{"input":{"address":{"address":"4600 Silver Hill Rd, Washington, DC 20233"},"benchmark":{"isDefault":true,"benchmarkDescription":"Public Address Ranges - Current Benchmark","id":"4","benchmarkName":"Public_AR_Current"}},
  "addressMatches":[{"tigerLine":{"side":"L","tigerLineId":"76355984"},"coordinates":{"x":-76.92748724230096,"y":38.84601622386617},
    "addressComponents":{"zip":"20233","streetName":"SILVER HILL","preType":"","city":"WASHINGTON","preDirection":"","suffixDirection":"","fromAddress":"4600","state":"DC","suffixType":"RD","toAddress":"4700","suffixQualifier":"","preQualifier":""},
    "matchedAddress":"4600 SILVER HILL RD, WASHINGTON, DC, 20233"}]}};
const CENSUS_MISS = {"result":{"input":{"address":{"address":"77 Unknown Rd, Lemoyne, PA 17043"},"benchmark":{"isDefault":true,"benchmarkDescription":"Public Address Ranges - Current Benchmark","id":"4","benchmarkName":"Public_AR_Current"}},"addressMatches":[]}};
const reply = (status: number, body: unknown) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

const DC = "33333333-0000-0000-0000-0000000000dc";
const P = {
  ...PEOPLE, DEE: "55555555-0000-0000-0000-000000000013", RAY: "55555555-0000-0000-0000-000000000014",
  TONY: "55555555-0000-0000-0000-000000000015", MARIA: "55555555-0000-0000-0000-000000000011",
  MGR: "55555555-0000-0000-0000-000000000018", MARCO: "55555555-0000-0000-0000-000000000021",
  SAM: "55555555-0000-0000-0000-000000000022", KIM: "55555555-0000-0000-0000-000000000023", JO: "55555555-0000-0000-0000-000000000024",
  RIO_OWNER: "eeee0000-0000-0000-0000-000000000201",
};
const V = { T101: "a1a1a1a1-0000-0000-0000-000000000101", T102: "a1a1a1a1-0000-0000-0000-000000000102", V201: "a1a1a1a1-0000-0000-0000-000000000201" };
const SO = (k: number) => `99999999-0000-0000-0000-0000000000d${k}`;
const SIG = "data:image/png;base64," + "iVBORw0KGgo".repeat(20);

// deterministic pseudo-random numbers for the routing checks
function lcg(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
function instance(seed: number, count: number, windows: boolean): { depot: R.Pt; stops: R.RStop[] } {
  const rnd = lcg(seed);
  const depot = { lng: -76.9, lat: 40.28 };
  const stops = [...Array(count).keys()].map((i) => {
    const am = rnd() < 0.5;
    return { id: `s${String(i).padStart(2, "0")}`, at: { lng: depot.lng + (rnd() - 0.5) * 0.5, lat: depot.lat + (rnd() - 0.5) * 0.4 },
      cube: Math.round(10 + rnd() * 60), weight: Math.round(50 + rnd() * 250), pieces: 1 + Math.floor(rnd() * 3), stairs: rnd() < 0.2 ? 1 : 0,
      ...(windows ? { windowStart: am ? 480 : 720, windowEnd: am ? 720 : 960 } : {}) };
  });
  return { depot, stops };
}

type Handler = { method: string; re: RegExp; fn: (...a: unknown[]) => Promise<unknown>; pub: boolean };

export async function run(t0: T) {
  // The shared harness's company() lookup is refused by db.guard (it does not
  // mark its query unscoped), and t.as() uses it; these two stand in for it.
  const company = async (entityId = ENTITY): Promise<Company> => {
    const c = await t0.pool.connect();
    try { return (await loadCompany(c, entityId))!; } finally { c.release(); }
  };
  const as: T["as"] = async (personId, fn) => {
    const c0 = await t0.pool.connect();
    let name = "?";
    try { name = (await t0.q<{ name: string }>(c0, "select name from app_user where id = $1 /* unscoped: lookup */", [personId]))[0]?.name ?? "?"; }
    finally { c0.release(); }
    const co = await company();
    return tx({ kind: "user", id: personId, label: name }, (c) => fn(c, co, { personId, personName: name, label: name }));
  };
  const t: T = { ...t0, company, as };
  // ===================================================== pure routing
  const enola = { lng: -76.9336, lat: 40.2601 }, hbg = { lng: -76.8867, lat: 40.2589 };
  const d1 = R.haversineMiles(enola, hbg);
  t.ok("haversine: Enola to Harrisburg is about 2.5 miles as the crow flies", d1 > 2.3 && d1 < 2.7, d1.toFixed(2));
  const nyla = R.haversineMiles({ lng: -74.006, lat: 40.7128 }, { lng: -118.2437, lat: 34.0522 });
  t.ok("haversine: New York to Los Angeles is about 2,445 miles", Math.abs(nyla - 2445) < 15, nyla.toFixed(0));
  t.ok("service time is base + per piece + stairs per piece", R.serviceMinutes({ id: "x", at: enola, pieces: 3, stairs: 2 }) === 10 + 12 + 18);

  let never = true, worst = 0;
  for (let k = 1; k <= 60; k++) {
    const { depot, stops } = instance(k, 6 + (k % 15), k % 2 === 0);
    const a = R.construct(depot, stops), b = R.twoOpt(depot, a);
    const la = R.loopMiles(depot, a), lb = R.loopMiles(depot, b);
    if (lb > la + 1e-9) never = false;
    worst = Math.max(worst, (la - lb) / la);
    if (R.simulate(depot, b).lateMin > R.simulate(depot, a).lateMin) never = false;
    if (b.length !== a.length || new Set(b.map((s) => s.id)).size !== a.length) never = false;
  }
  t.ok("2-opt never lengthens a route, never makes it later, and keeps every stop (60 instances)", never, `best gain ${(worst * 100).toFixed(1)}%`);

  const w = instance(7, 12, true);
  const cons = R.construct(w.depot, w.stops);
  const firstPm = cons.findIndex((s) => s.windowStart === 720);
  t.ok("the first draft runs the 8–12 stops before the 12–4 ones", firstPm > 0 && cons.slice(firstPm).every((s) => s.windowStart === 720));

  const big = instance(11, 40, true);
  const trucks: R.RVehicle[] = [{ id: "T1", cube: 400, weight: 2500, maxStops: 9 }, { id: "T2", cube: 400, weight: 2500, maxStops: 9 }, { id: "T3", cube: 300, weight: 2000, maxStops: 7 }];
  const plan = R.assign(big.depot, big.stops, trucks);
  const capOk = plan.routes.every((r) => {
    const v = trucks.find((x) => x.id === r.vehicleId)!;
    const cube = r.stops.reduce((a, s) => a + (s.cube ?? 0), 0), wt = r.stops.reduce((a, s) => a + (s.weight ?? 0), 0);
    return cube <= v.cube && wt <= v.weight && r.stops.length <= v.maxStops;
  });
  t.ok("assignment respects every truck's cube, weight and stop count", capOk, `${plan.routes.length} routes, ${plan.unassigned.length} left over`);
  const winOk = plan.routes.every((r) => r.plan.stops.every((p) => {
    const s = big.stops.find((x) => x.id === p.id)!;
    return p.lateMin === 0 && p.startMin >= (s.windowStart ?? 0) && p.startMin <= (s.windowEnd ?? 1440);
  }) && r.plan.endMin <= 1110);
  t.ok("every assigned stop is served inside its window, and trucks are back by day's end", winOk);
  const placed = plan.routes.reduce((a, r) => a + r.stops.length, 0);
  t.ok("every stop is either on a truck or left over with a reason", placed + plan.unassigned.length === 40 && plan.unassigned.every((u) => u.reason.length > 10));
  t.ok("the same stops and trucks give the same routes", JSON.stringify(R.assign(big.depot, big.stops, trucks)) === JSON.stringify(plan));
  const huge = R.assign(w.depot, [{ id: "armoire", at: hbg, cube: 9999, weight: 10 }], trucks);
  t.ok("a stop bigger than any truck is left over, saying so", huge.unassigned[0]?.reason.includes("room"));
  // an injected distance matrix is what routing uses
  const line = [0, 1, 2, 3].map((i) => ({ id: `m${i}`, at: { lng: 0, lat: 0 } }));
  const order = ["m2", "m0", "m3", "m1"];
  const matrix = (a: R.Node, b: R.Node) => {
    const pos = (x: R.Node) => (x.id === R.DEPOT ? -1 : order.indexOf(x.id));
    return Math.abs(pos(a) - pos(b)) * 5;
  };
  const om = R.optimise({ lng: 0, lat: 0 }, line, { distance: matrix });
  t.ok("an injected distance matrix drives the order", om.map((s) => s.id).join() === order.join(), om.map((s) => s.id).join());

  // ===================================================== geocoder (fake fetch, real Census JSON)
  let seenUrl = "";
  const g1 = censusGeocoder(((url: string) => { seenUrl = url; return reply(200, CENSUS_HIT); }) as FetchLike);
  const hit = await g1.locate("4600 Silver Hill Rd, Washington, DC 20233");
  t.ok("the Census answer is read into a point (x is longitude, y latitude)", !!hit && Math.abs(hit.lng + 76.9275) < 0.001 && Math.abs(hit.lat - 38.846) < 0.001
    && hit.matched.startsWith("4600 SILVER HILL"), hit ? `${hit.lat}, ${hit.lng}` : "none");
  t.ok("the lookup asks the Census one-line endpoint, current benchmark, JSON, address encoded",
    seenUrl.startsWith(CENSUS_URL + "?address=4600%20Silver%20Hill%20Rd%2C%20Washington%2C%20DC%2020233") && seenUrl.includes("benchmark=Public_AR_Current") && seenUrl.includes("format=json"));
  t.ok("no match is an answer, not a point", (await censusGeocoder((() => reply(200, CENSUS_MISS)) as FetchLike).locate("77 Unknown Rd")) === null);
  await t.throws("a server error from the map service is reported, not guessed", () => censusGeocoder((() => reply(503, {})) as FetchLike).locate("x"), /answered 503/);
  await t.throws("no network is reported in words", () => censusGeocoder((() => Promise.reject(new TypeError("fetch failed"))) as FetchLike).locate("x"), /could not be reached \(fetch failed\)/);
  await t.throws("a map service that hangs is given up on", () => censusGeocoder((() => new Promise(() => {})) as unknown as FetchLike, 60).locate("x"), /did not answer within/);

  // ===================================================== against the database
  const H: Handler[] = [];
  fleetModule.register({
    coGet: (tail, fn) => H.push({ method: "GET", re: new RegExp(`^${tail}$`), fn: fn as Handler["fn"], pub: false }),
    coPost: (tail, fn) => H.push({ method: "POST", re: new RegExp(`^${tail}$`), fn: fn as Handler["fn"], pub: false }),
    publicRoute: (method, path, fn) => H.push({ method, re: path, fn: fn as Handler["fn"], pub: true }),
  });
  const find = (method: string, path: string, pub = false) => {
    const h = H.find((x) => x.method === method && x.pub === pub && x.re.test(path));
    if (!h) throw new Error(`no ${method} ${path}`);
    return { h, mm: path.match(h.re)! };
  };
  const get = async (path: string, personId: string | null, entity = ENTITY) => {
    const u = new URL("http://x" + path);
    const { h, mm } = find("GET", u.pathname);
    const co = await t.company(entity);
    const c = await t.pool.connect();
    try { return await h.fn(c, co, u, [u.pathname, co.id, ...mm.slice(1)], personId) as any; } finally { c.release(); }
  };
  const postIn = async (entity: string, personId: string, path: string, body: Record<string, unknown> = {}) => {
    const { h, mm } = find("POST", path);
    const co = await t.company(entity);
    const c0 = await t.pool.connect();
    let name = "?";
    try { name = (await t.q<{ name: string }>(c0, "select name from app_user where id = $1 /* unscoped: lookup */", [personId]))[0]?.name ?? "?"; }
    finally { c0.release(); }
    const a: Actor = { personId, personName: name, label: name };
    return tx({ kind: "user", id: personId, label: name }, (c) => h.fn(c, co, a, body, [path, co.id, ...mm.slice(1)])) as Promise<any>;
  };
  const post = (personId: string, path: string, body: Record<string, unknown> = {}) => postIn(ENTITY, personId, path, body);
  const pub = async (method: "GET" | "POST", path: string, body: Record<string, unknown> = {}) => {
    const { h, mm } = find(method, path, true);
    return h.fn({ headers: { "x-erp-shop": "1" } }, new URL("http://x" + path), mm, body) as Promise<[number, any]>;
  };
  const one = async <X = any>(sql: string, params: unknown[] = []) => {
    const c = await t.pool.connect();
    try { return (await t.q(c, sql, params))[0] as X; } finally { c.release(); }
  };

  // reserve the seeded delivery orders, as POS would
  await t.as(P.STEVE, async (c) => { for (let k = 1; k <= 9; k++) await reserveOrder(c, ENTITY, SO(k)); });
  const queue = await get("/fleet/queue", P.RAY);
  { // other modules' demo data may add delivery orders of their own; these nine are fleet's
    const mine = new Set(Array.from({ length: 9 }, (_, k) => SO(k + 1)));
    const ours = queue.filter((o: any) => mine.has(o.id ?? o.sales_order_id));
    t.ok("the delivery queue lists the reserved delivery orders, each in a zone", ours.length === 9 && ours.every((o: any) => o.zone_id), `${ours.length} of ${queue.length} orders`); }

  // the first Wednesday or Saturday after today: every seeded zone delivers then
  const today = (await one<{ d: string }>(`select (now() at time zone 'America/New_York')::date::text d /* unscoped: clock */`)).d;
  let D = today;
  do { const d = new Date(D + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); D = d.toISOString().slice(0, 10); }
  while (![3, 6].includes(new Date(D + "T12:00:00Z").getUTCDay()));
  const av1 = await get(`/fleet/availability?order=${SO(1)}&day=${D}&days=7`, P.MARIA);
  const am = av1.slots.find((s: any) => s.day === D && s.label === "8–12"), pm = av1.slots.find((s: any) => s.day === D && s.label === "12–4");
  t.ok("availability offers the zone's morning and afternoon windows with room left", am && pm && am.fits && am.caps.stops === 6);
  const winFor = async (k: number, label: string) => (await get(`/fleet/availability?order=${SO(k)}&day=${D}&days=1`, P.RAY)).slots.find((s: any) => s.label === label).windowId;

  await t.throws("sales cannot book a delivery for today (the customer lead time applies)",
    () => post(P.MARIA, "/fleet/stops", { orderId: SO(1), day: today, windowId: am.windowId }), /first day that can be booked/);
  await t.throws("sales cannot book past a window's capacity", () => post(P.MARIA, "/fleet/stops", { orderId: SO(1), day: D, windowId: am.windowId, override: "VIP" }),
    /dispatcher or a manager/);
  // capacity: shrink the window inside a transaction that is rolled back
  await t.throws("a window that is full refuses the next stop", () => t.as(P.RAY, async (c, co, a) => {
    await c.query(`update delivery_window set stops_cap = 1 where entity_id = $1 and id = $2`, [ENTITY, am.windowId]);
    const s = { tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "user" as const, id: a.personId, label: a.label } };
    await F.bookStop(c, s, { orderId: SO(1), day: D, windowId: am.windowId });
    await F.bookStop(c, s, { orderId: SO(5), day: D, windowId: am.windowId });
  }), /window on .* is full; it takes 1 stops/);
  await t.throws("a window with too few pieces left refuses a big order", () => t.as(P.RAY, async (c, co, a) => {
    await c.query(`update delivery_window set pieces_cap = 0 where entity_id = $1 and id = $2`, [ENTITY, pm.windowId]);
    await F.bookStop(c, { tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "user", id: a.personId, label: a.label } }, { orderId: SO(1), day: D, windowId: pm.windowId });
    throw new Error("booked (rolled back)");
  }), /room for 0 more pieces, not 1/);
  await t.throws("a dispatcher's override books past capacity, with the reason kept", () => t.as(P.RAY, async (c, co, a) => {
    await c.query(`update delivery_window set stops_cap = 0 where entity_id = $1 and id = $2`, [ENTITY, am.windowId]);
    const r = await F.bookStop(c, { tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "user", id: a.personId, label: a.label } },
      { orderId: SO(1), day: D, windowId: am.windowId, override: "customer moving out that afternoon" });
    throw new Error(r.id ? "override booked (rolled back)" : "no");
  }), /override booked/);

  // a window that has already ended today cannot be booked, even by a dispatcher (rolled back)
  let endedHidden = false;
  await t.throws("today's window that has already ended is refused", () => t.as(P.RAY, async (c, co, a) => {
    await c.query(`update delivery_zone set days = '{0,1,2,3,4,5,6}' where entity_id = $1 and code = 'WSH'`, [ENTITY]);
    const w = await t.q<{ id: string }>(c, `insert into delivery_window (entity_id, zone_id, label, starts, ends)
      select entity_id, id, 'Midnight', '00:00', '00:01' from delivery_zone where entity_id = $1 and code = 'WSH' returning id`, [ENTITY]);
    const zid = (await t.q<{ id: string }>(c, `select id from delivery_zone where entity_id = $1 and code = 'WSH'`, [ENTITY]))[0].id;
    endedHidden = !(await F.availability(c, ENTITY, zid, today, 1)).some((x) => x.windowId === w[0].id);
    await F.bookStop(c, { tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "user", id: a.personId, label: a.label } },
      { orderId: SO(5), day: today, windowId: w[0].id, allowToday: true });
    throw new Error("booked (rolled back)");
  }), /today's Midnight window has already ended/);
  t.ok("availability does not offer a window that has already ended today", endedHidden);

  // the day's bookings
  const booked: Record<number, string> = {};
  for (const [k, label] of [[1, "8–12"], [2, "12–4"], [3, "8–12"], [4, "12–4"], [5, "8–12"], [6, "12–4"], [7, "8–12"]] as [number, string][]) {
    booked[k] = (await post(P.RAY, "/fleet/stops", { orderId: SO(k), day: D, windowId: await winFor(k, label) })).id;
  }
  t.ok("seven deliveries booked for the day", Object.keys(booked).length === 7);
  await t.throws("booking an order that is already on a stop is refused, naming the stop",
    () => post(P.RAY, "/fleet/stops", { orderId: SO(1), day: D, windowId: am.windowId }), /already booked on D-/);
  const conf = await one<{ n: number }>(`select count(*)::int n from customer_message where entity_id = $1 and kind = 'confirmation'`, [ENTITY]);
  t.ok("each booking logged a confirmation message", conf.n === 7);
  // a service call and a returns pickup ride the same trucks
  const chenAddr = (await one<{ id: string }>(`select id from customer_address where entity_id = $1 and customer_id = '88888888-0000-0000-0000-000000000003'`, [ENTITY])).id;
  const chenPm = await winFor(3, "12–4");
  await t.throws("a service call needs the problem described", () => post(P.RAY, "/fleet/stops",
    { kind: "service", customerId: "88888888-0000-0000-0000-000000000003", addressId: chenAddr, day: D, windowId: chenPm }), /what needs fixing/);
  const svc = await post(P.RAY, "/fleet/stops", { kind: "service", customerId: "88888888-0000-0000-0000-000000000003", addressId: chenAddr,
    day: D, windowId: await winFor(3, "12–4"), problem: "Recliner mechanism sticks" });
  const harrisAddr = (await one<{ id: string }>(`select id from customer_address where entity_id = $1 and customer_id = '88888888-0000-0000-0000-000000000005'`, [ENTITY])).id;
  const pick = await post(P.RAY, "/fleet/stops", { kind: "pickup", customerId: "88888888-0000-0000-0000-000000000005", addressId: harrisAddr,
    day: D, windowId: await winFor(4, "8–12"), pickupLines: [{ description: "Old recliner, haul away", qty: 1 }] });
  t.ok("a service call and a pickup book as stops", !!svc.id && !!pick.id);
  const wc = await post(P.MARIA, "/fleet/stops", { kind: "will_call", orderId: SO(9), day: D });
  t.ok("a will-call books at the DC with no window", !!wc.id);

  // customer self-scheduling for order 8
  const link = await post(P.MARIA, `/fleet/orders/${SO(8)}/link`);
  const [, view] = await pub("GET", link.path);
  t.ok("the customer's link shows their order and open windows, and nothing more", view.order && view.canBook && view.slots.length > 0
    && !("phone" in view) && !("email" in view) && view.name === "Jamal", `${view.slots.length} slots`);
  const slot = view.slots.find((s: any) => s.day === D && s.label === "12–4") ?? view.slots[0];
  await t.throws("a self-schedule POST without a valid token is refused", () => pub("POST", "/delivery/schedule/" + "x".repeat(32), { day: slot.day, windowId: slot.windowId }), /not valid/);
  const [, picked] = await pub("POST", link.path, { day: slot.day, windowId: slot.windowId });
  t.ok("the customer picks a window and the delivery is booked", picked.booked && /^D-/.test(picked.number));
  const [, view2] = await pub("GET", link.path);
  t.ok("the link then shows the booking", view2.booking?.number === picked.number);
  const link2 = await post(P.MARIA, `/fleet/orders/${SO(8)}/link`);
  await t.throws("an older link stops working once a newer one is sent", () => pub("GET", link.path), /replaced by a newer one/);
  if (slot.day !== D) await post(P.RAY, `/fleet/stops/${(await one<{ id: string }>(`select id from delivery_stop where entity_id = $1 and number = $2`, [ENTITY, picked.number])).id}/reschedule`,
    { day: D, windowId: (await get(`/fleet/availability?order=${SO(4)}&day=${D}&days=1`, P.RAY)).slots.find((s: any) => s.label === "12–4").windowId });
  void link2;

  // day-before reminders run once
  const firstRun = await post(P.RAY, "/fleet/messages/day-before", { day: D });
  const again = await post(P.RAY, "/fleet/messages/day-before", { day: D });
  t.ok("day-before reminders go to every booked stop, and not twice", firstRun.sent === 11 && again.sent === 0, `first run ${firstRun.sent}, second ${again.sent}`);

  // drivers and licences
  const drivers = await get(`/fleet/drivers?day=${D}`, P.RAY);
  t.ok("Kim's licence shows as expired", drivers.find((d: any) => d.id === P.KIM)?.license_expired === true);

  // routing capacity inside the database: small trucks force several routes (rolled back)
  await t.throws("built routes respect each truck's stop count (trucks limited to 4 stops)", () => t.as(P.RAY, async (c, co, a) => {
    await c.query(`update vehicle set max_stops = 4 where entity_id = $1 and id = any($2)`, [ENTITY, [V.T101, V.T102, V.V201]]);
    const r = await F.buildRoutes(c, { tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "user", id: a.personId, label: a.label } }, D, DC);
    const sizes = (await t.q<{ n: number }>(c, `select count(*)::int n from delivery_stop where entity_id = $1 and route_id = any($2) group by route_id`,
      [ENTITY, r.routes.map((x) => x.routeId)])).map((x) => x.n);
    throw new Error(`routes=${r.routes.length} max=${Math.max(...sizes)} left=${r.unassigned.length}`);
  }), /routes=3 max=4 left=[0-9]/);

  const build = await post(P.RAY, "/fleet/routes/build", { day: D, dcId: DC });
  const onRoutes = build.routes.reduce((a: number, r: any) => a + r.stops, 0);
  t.ok("the builder puts every stop on a truck", onRoutes === 10 && build.unassigned.length === 0, `${build.routes.length} route(s), ${onRoutes} stops`);
  let rts = await get(`/fleet/routes?day=${D}`, P.RAY);
  const RA = rts[0];
  t.ok("the built route has a licensed driver and a helper; Kim (expired) is not used", RA.driver_id === P.MARCO && RA.helper_id === P.JO
    && !rts.some((r: any) => r.driver_id === P.KIM), `${RA.driver} + ${RA.helper}`);
  const loadOk = rts.every((r: any) => r.cube <= r.cube_cap && r.weight <= r.weight_cap && r.stops <= r.max_stops);
  t.ok("each route fits its truck (cube, weight, stops)", loadOk);
  const detail = await get(`/fleet/routes/${RA.id}`, P.RAY);
  t.ok("every routed stop's ETA lands before its window closes", detail.stops.every((s: any) => s.eta_min <= s.window_end), detail.stops.map((s: any) => s.eta).join(" "));
  const rebuild = await post(P.RAY, "/fleet/routes/build", { day: D, dcId: DC });
  t.ok("rebuilding gives the same plan", JSON.stringify(rebuild.routes.map((r: any) => [r.number, r.stops, r.miles])) === JSON.stringify(build.routes.map((r: any) => [r.number, r.stops, r.miles])));

  // a second truck by hand: three stops move over, Tony drives it
  const RB = await post(P.RAY, "/fleet/routes", { day: D, dcId: DC, vehicleId: V.T102 });
  const movers = detail.stops.filter((s: any) => [SO(4), SO(6), SO(8)].includes(s.order_id)).map((s: any) => s.id);
  for (const id of movers) await post(P.RAY, `/fleet/stops/${id}/assign`, { routeId: RB.id });
  await t.throws("an expired licence cannot be put on a route", () => post(P.RAY, `/fleet/routes/${RB.id}/crew`, { driverId: P.KIM }), /licence expired/);
  await t.throws("a helper is not put behind the wheel", () => post(P.RAY, `/fleet/routes/${RB.id}/crew`, { driverId: P.SAM }), /helper, not a licensed driver/);
  await post(P.RAY, `/fleet/routes/${RB.id}/crew`, { driverId: P.TONY, helperId: P.SAM });
  await t.throws("a truck already on another route is refused, naming the route", () => post(P.RAY, `/fleet/routes/${RB.id}/crew`, { vehicleId: V.T101 }),
    new RegExp(`unit T-101 is already on route ${RA.number} that day`));
  await t.throws("a second route for a busy truck is refused the same way", () => post(P.RAY, "/fleet/routes", { day: D, dcId: DC, vehicleId: V.T101 }),
    new RegExp(`unit T-101 is already on route ${RA.number}`));
  await t.throws("a driver already on another route is refused, naming the route", () => post(P.RAY, `/fleet/routes/${RB.id}/crew`, { driverId: P.MARCO }),
    new RegExp(`Marco \\(driver\\) is already on route ${RA.number}`));
  await t.throws("a helper already riding elsewhere is refused too", () => post(P.RAY, `/fleet/routes/${RB.id}/crew`, { helperId: P.JO }),
    new RegExp(`Jo \\(helper\\) is already on route ${RA.number}`));
  await t.throws("a second vehicle with the same unit number is refused in words", () => post(P.RAY, "/fleet/vehicles",
    { unitNo: "t-101", vinLast6: "ABC123", kind: "van", homeLocationId: DC, cubeFt: 300, maxWeightLb: 3000 }), /already a vehicle numbered t-101/);
  await t.throws("a second zone with the same code is refused in words", () => post(P.RAY, "/fleet/zones",
    { code: "wsh", name: "Dup", dcLocationId: DC, postalCodes: "17999", fee: "0" }), /already a zone with the code WSH/);
  await t.throws("a second window at the same start is refused in words", () => post(P.RAY, `/fleet/zones/a2a2a2a2-0000-0000-0000-000000000001/windows`,
    { starts: "08:00", ends: "11:00" }), /already has a window starting at 08:00 \(8–12\)/);
  const rb = await get(`/fleet/routes/${RB.id}`, P.RAY);
  t.ok("the stops moved to the second truck with ETAs", rb.stops.length === 3 && rb.stops.every((s: any) => s.eta_min != null));

  // reorder and re-optimise
  const ra0 = await get(`/fleet/routes/${RA.id}`, P.RAY);
  const firstId = ra0.stops[0].id;
  await post(P.RAY, `/fleet/stops/${firstId}/move`, { dir: "down" });
  const ra1 = await get(`/fleet/routes/${RA.id}`, P.RAY);
  t.ok("moving a stop down swaps it with the next one", ra1.stops[1].id === firstId);
  const reo = await post(P.RAY, `/fleet/routes/${RA.id}/reoptimise`);
  t.ok("re-optimising never makes the route longer", reo.miles <= reo.beforeMiles + 0.05, `${reo.beforeMiles} → ${reo.miles} mi`);

  // driver isolation
  const tonyList = await get(`/fleet/routes?day=${D}`, P.TONY);
  t.ok("a driver's route list shows only their own route", tonyList.length === 1 && tonyList[0].id === RB.id);
  await t.throws("a driver cannot open another driver's route", () => get(`/fleet/routes/${RA.id}`, P.TONY), /another driver/);
  await t.throws("a driver cannot open another driver's manifest", () => get(`/fleet/routes/${RA.id}/manifest`, P.TONY), /another driver/);
  const mine = await get(`/fleet/my?day=${D}`, P.TONY);
  t.ok("the driver's phone shows their route with navigation links", mine.routes.length === 1 && mine.routes[0].stops.every((s: any) => s.mapsUrl.startsWith("https://www.google.com/maps/dir/")));

  // manifest and load list
  const man = await get(`/fleet/routes/${RA.id}/manifest`, P.DEE);
  const codExpected = man.stops.filter((s: any) => s.kind === "delivery").length;
  t.ok("the manifest lists stops in order with address, window, phone, items and COD due", man.stops.length === ra1.stops.length
    && man.stops.every((s: any, i: number) => s.seq === i + 1 && s.address && (s.kind !== "delivery" || (s.window && s.items.length && BigInt(s.codMinor) > 0n)))
    && BigInt(man.totals.codMinor) > 0n && codExpected > 0, `COD ${man.totals.codMinor}`);
  t.ok("the load order is the reverse of the stop order", man.loadOrder.join() === [...man.stops].reverse().map((s: any) => s.number).join());
  const load = await get(`/fleet/routes/${RA.id}/load`, P.DEE);
  t.ok("the load list falls back to the orders' lines when inventory has no pick list", ["order lines", "inventory"].includes(load.source)
    && load.load[0].deliverSeq === man.stops.length);

  // lock: the order is fixed
  await t.throws("a driver cannot lock a route", () => post(P.TONY, `/fleet/routes/${RB.id}/lock`), /needs one of/);
  await post(P.DEE, `/fleet/routes/${RA.id}/lock`);
  await post(P.DEE, `/fleet/routes/${RB.id}/lock`);
  await t.throws("a locked route's stops cannot be reordered", () => post(P.RAY, `/fleet/stops/${firstId}/move`, { dir: "up" }), /locked/);
  await t.throws("the database also refuses moving a stop on a locked route", () => t.as(P.RAY, async (c) => {
    await c.query(`update delivery_stop set seq = 99 where entity_id = $1 and id = $2`, [ENTITY, firstId]);
  }), /route is locked/);

  // inspections
  const allOk = (bad: string[] = [], note = "") => F.DVIR_ITEMS.map((i) => ({ code: i.code, ok: !bad.includes(i.code), note: bad.includes(i.code) ? note : "" }));
  await t.throws("starting a route needs today's pre-trip inspection", () => post(P.TONY, `/fleet/routes/${RB.id}/start`), /pre-trip inspection/);
  await t.throws("an inspection with a failed item needs a description", () => post(P.TONY, "/fleet/dvir", { vehicleId: V.V201, items: allOk(["brakes"]) }), /describe what is wrong/);
  const failed = await post(P.TONY, "/fleet/dvir", { vehicleId: V.V201, items: allOk(["brakes"], "pedal goes to the floor") });
  const v201 = await one<{ status: string }>(`select status from vehicle where entity_id = $1 and id = $2`, [ENTITY, V.V201]);
  t.ok("a failed safety item takes the truck out of service", failed.outOfService && v201.status === "out_of_service");
  await t.throws("an out-of-service truck cannot go on a route", () => post(P.RAY, "/fleet/routes", { day: D, dcId: DC, vehicleId: V.V201 }), /out of service/);
  await t.throws("an out-of-service truck cannot be swapped onto a route either", () => t.as(P.RAY, async (c) => {
    await c.query(`update delivery_route set vehicle_id = $3 where entity_id = $1 and id = $2`, [ENTITY, RB.id, V.V201]);
  }), /out of service/);
  await t.throws("putting it back in service without clearing the inspection is refused", () => post(P.STEVE, `/fleet/vehicles/${V.V201}/status`, { status: "active" }),
    /failed inspection/);
  await t.throws("the driver who reported it cannot clear it", () => post(P.TONY, `/fleet/dvir/${failed.id}/clear`, { note: "fine now" }), /needs one of: store manager/);
  const cleared = await post(P.MGR, `/fleet/dvir/${failed.id}/clear`, { note: "Brake line replaced at West Shore Truck" });
  t.ok("a manager clears it and the truck is back in service", cleared.backInService
    && (await one<{ status: string }>(`select status from vehicle where entity_id = $1 and id = $2`, [ENTITY, V.V201])).status === "active");
  await post(P.TONY, "/fleet/dvir", { vehicleId: V.T102, items: allOk(), odometerMi: 61800 });
  await post(P.MARCO, "/fleet/dvir", { vehicleId: V.T101, items: allOk(["straps"], "one strap frayed"), odometerMi: 49150 });
  await t.throws("an odometer never goes backwards", () => post(P.TONY, `/fleet/vehicles/${V.T102}/odometer`, { readingMi: 100 }), /odometers do not go backwards/);

  // the day
  await t.throws("a driver cannot start another driver's route", () => post(P.TONY, `/fleet/routes/${RA.id}/start`), /another driver/);
  await post(P.TONY, `/fleet/routes/${RB.id}/start`, { odometerMi: 61805 });
  await post(P.MARCO, `/fleet/routes/${RA.id}/start`, { odometerMi: 49155 });
  const enr = await one<{ n: number }>(`select count(*)::int n from customer_message where entity_id = $1 and kind = 'en_route'`, [ENTITY]);
  t.ok("starting a route tells each first customer the crew is on the way, with an ETA", enr.n === 2);

  const ra = await get(`/fleet/routes/${RA.id}`, P.MARCO);
  const stopOf = (r: any, k: number) => r.stops.find((s: any) => s.order_id === SO(k));
  const s1 = stopOf(ra, 1);
  await t.throws("a driver cannot complete a stop on someone else's route", () => post(P.TONY, `/fleet/stops/${s1.id}/complete`, { recipient: "x", signature: SIG }), /another driver/);
  await post(P.MARCO, `/fleet/stops/${s1.id}/arrive`);
  await t.throws("a delivery needs the customer's signature", () => post(P.MARCO, `/fleet/stops/${s1.id}/complete`, { recipient: "Alicia" }), /signature/);
  const bal1 = BigInt(s1.cod_minor);
  await t.throws("collecting more than the balance due is refused", () => post(P.MARCO, `/fleet/stops/${s1.id}/complete`,
    { recipient: "Alicia Gomez", signature: SIG, cod: { method: "cash", amount: { minor: (bal1 + 100n).toString() } } }), /only has .* due/);
  const before = await one<{ on_hand: string; reserved: string }>(`select on_hand, reserved from stock_level where entity_id = $1 and product_id = '77777777-0000-0000-0000-000000000001' and location_id = $2`, [ENTITY, DC]);
  const done1 = await post(P.MARCO, `/fleet/stops/${s1.id}/complete`, { recipient: "Alicia Gomez", signature: SIG, photos: ["https://example.com/pod/1.jpg"],
    cod: { method: "check", amount: { minor: bal1.toString() }, reference: "chk 1042" } });
  const after = await one<{ on_hand: string; reserved: string }>(`select on_hand, reserved from stock_level where entity_id = $1 and product_id = '77777777-0000-0000-0000-000000000001' and location_id = $2`, [ENTITY, DC]);
  t.ok("delivery relieves stock at the DC (on hand and reserved down by one)", Number(before.on_hand) - Number(after.on_hand) === 1 && Number(before.reserved) - Number(after.reserved) === 1,
    `${before.on_hand}/${before.reserved} → ${after.on_hand}/${after.reserved}`);
  const je = await one<{ dr: string; cr: string; rev: string; cogs: string; ar: string }>(`
    select sum(jl.debit_minor)::text dr, sum(jl.credit_minor)::text cr,
           sum(jl.credit_minor) filter (where g.code in ('4000','4030'))::text rev, sum(jl.debit_minor) filter (where g.code = '5000')::text cogs,
           coalesce(sum(jl.debit_minor) filter (where g.code = '1100'),0)::text ar
      from journal_entry e join journal_line jl on jl.journal_entry_id = e.id join gl_account g on g.id = jl.gl_account_id
     where e.entity_id = $1 and e.id = $2`, [ENTITY, done1.journalEntryId]);
  t.ok("the delivery posts a balanced sale: revenue, cost of goods, nothing left on A/R after COD", je.dr === je.cr && je.rev === String(79999 + 9900)
    && je.cogs === "38500" && je.ar === "0", `dr ${je.dr} cr ${je.cr} rev ${je.rev} cogs ${je.cogs}`);
  const rc = await one<{ n: number; dr: string; cr: string }>(`
    select count(distinct e.id)::int n, sum(jl.debit_minor)::text dr, sum(jl.credit_minor)::text cr
      from journal_entry e join journal_line jl on jl.journal_entry_id = e.id
     where e.entity_id = $1 and e.source_type = 'receipt' and e.source_id = $2`, [ENTITY, done1.receiptId]);
  const rcpt = await one<{ channel: string; method: string; location_id: string; amount_minor: string }>(`select channel, method, location_id, amount_minor from customer_receipt where entity_id = $1 and id = $2`, [ENTITY, done1.receiptId]);
  t.ok("the COD check is a POS-channel receipt at the DC, posted and balanced", rc.n === 1 && rc.dr === rc.cr && rc.dr === bal1.toString()
    && rcpt.channel === "pos" && rcpt.method === "check" && rcpt.location_id === DC);
  const o1 = await one<{ status: string; paid_minor: string; total_minor: string }>(`select status, paid_minor, total_minor from sales_order where entity_id = $1 and id = $2`, [ENTITY, SO(1)]);
  t.ok("the order is fulfilled and paid in full", o1.status === "fulfilled" && o1.paid_minor === o1.total_minor);
  const deliv = await one<{ n: number }>(`select count(*)::int n from customer_message where entity_id = $1 and stop_id = $2 and kind = 'delivered'`, [ENTITY, s1.id]);
  t.ok("the customer is told it was delivered", deliv.n === 1);

  // partial: chairs damaged, table delivered
  const s3 = stopOf(ra, 3);
  const chairs = s3.lines.find((l: any) => l.description.includes("Chair")), table = s3.lines.find((l: any) => l.description.includes("Table"));
  await t.throws("a damaged line needs a reason", () => post(P.MARCO, `/fleet/stops/${s3.id}/complete`, { recipient: "Chen", signature: SIG,
    lines: [{ id: table.id, outcome: "delivered" }, { id: chairs.id, outcome: "damaged" }] }), /say what happened/);
  const done3 = await post(P.MARCO, `/fleet/stops/${s3.id}/complete`, { recipient: "Mrs Chen", signature: SIG, reason: "Chair leg cracked in the box",
    lines: [{ id: table.id, outcome: "delivered" }, { id: chairs.id, outcome: "damaged", note: "rear left leg cracked" }] });
  const ch = await one<{ line_status: string }>(`select line_status from sales_order_line where entity_id = $1 and id = $2`, [ENTITY, chairs.sales_order_line_id]);
  const fl = await one<{ flagged_for_warehouse: boolean }>(`select flagged_for_warehouse from delivery_stop_line where entity_id = $1 and id = $2`, [ENTITY, chairs.id]);
  const o3 = await one<{ status: string }>(`select status from sales_order where entity_id = $1 and id = $2`, [ENTITY, SO(3)]);
  t.ok("a damaged line stays unfulfilled and is flagged for the warehouse; the stop is partial", done3.status === "partial" && ch.line_status === "reserved"
    && fl.flagged_for_warehouse && o3.status === "fulfilling");
  const ar3 = await one<{ ar: string }>(`select coalesce(sum(jl.debit_minor) filter (where g.code = '1100'),0)::text ar from journal_line jl join journal_entry e on e.id = jl.journal_entry_id
     join gl_account g on g.id = jl.gl_account_id where e.entity_id = $1 and e.id = $2`, [ENTITY, done3.journalEntryId]);
  t.ok("with no COD, the delivered part goes to A/R", BigInt(ar3.ar) > 0n);
  const queueAgain = await get("/fleet/queue", P.RAY);
  t.ok("the damaged chairs come back into the queue to rebook", queueAgain.some((o: any) => o.id === SO(3)));

  // not home: fails, needs a reason
  const s5 = stopOf(ra, 5);
  await t.throws("a not-home stop needs a reason", () => post(P.MARCO, `/fleet/stops/${s5.id}/complete`, { exception: "not_home" }), /say what happened/);
  const done5 = await post(P.MARCO, `/fleet/stops/${s5.id}/complete`, { exception: "not_home", reason: "No answer, called twice, left door tag" });
  t.ok("not home: the stop fails, nothing leaves stock, the customer is told", done5.status === "failed" && done5.delivered === 0 && !done5.journalEntryId);

  // service and pickup on route A (wherever they landed)
  const all = [...(await get(`/fleet/routes/${RA.id}`, P.MARCO)).stops, ...(await get(`/fleet/routes/${RB.id}`, P.TONY)).stops];
  const sv = all.find((s: any) => s.id === svc.id), pk = all.find((s: any) => s.id === pick.id);
  const asDriver = (s: any) => (s.id && ra.stops.some((x: any) => x.id === s.id) ? P.MARCO : P.TONY);
  const svDone = await post(asDriver(sv), `/fleet/stops/${sv.id}/complete`, { recipient: "Mr Chen", signature: SIG });
  const pkDone = await post(asDriver(pk), `/fleet/stops/${pk.id}/complete`, {});
  t.ok("a service call completes; a pickup flags what came back for the warehouse", svDone.status === "delivered" && pkDone.status === "delivered" && pkDone.flagged === 1);

  // finish: open stops block it
  await t.throws("a route with open stops cannot be finished", () => post(P.MARCO, `/fleet/routes/${RA.id}/finish`, { odometerMi: 49200 }), /still open/);
  for (const s of (await get(`/fleet/routes/${RA.id}`, P.MARCO)).stops.filter((x: any) => ["scheduled", "arrived"].includes(x.status))) {
    await post(P.MARCO, `/fleet/stops/${s.id}/complete`, s.kind === "pickup" ? {} : { recipient: "Customer", signature: SIG });
  }
  const fin = await post(P.MARCO, `/fleet/routes/${RA.id}/finish`, { odometerMi: 49210 });
  t.ok("finishing the route records the miles driven", fin.status === "completed" && fin.miles === 55);
  for (const s of (await get(`/fleet/routes/${RB.id}`, P.TONY)).stops.filter((x: any) => ["scheduled", "arrived"].includes(x.status))) {
    await post(P.TONY, `/fleet/stops/${s.id}/complete`, s.kind === "pickup" ? {} : { recipient: "Customer", signature: SIG,
      cod: { method: "card", amount: { minor: s.cod_minor }, reference: "visa 4242" } });
  }
  await post(P.TONY, `/fleet/routes/${RB.id}/finish`, { odometerMi: 61840 });

  // will-call at the DC
  await t.throws("a driver cannot release a will-call", () => post(P.TONY, `/fleet/stops/${wc.id}/complete`, { recipient: "Karen", signature: SIG }), /needs one of: warehouse/);
  const wcDone = await post(P.DEE, `/fleet/stops/${wc.id}/complete`, { recipient: "Karen Short", signature: SIG });
  t.ok("the warehouse releases a will-call, posting the sale", wcDone.status === "delivered" && !!wcDone.journalEntryId);


  // dashboard
  const dash = await get(`/fleet/home?day=${D}`, P.STEVE);
  t.ok("the dashboard counts the day: stops, failures, miles, cost per stop", dash.stops.total >= 10 && dash.stops.failed === 1 && dash.stops.partial === 1
    && dash.miles > 0 && BigInt(dash.costPerStopMinor) > 0n && dash.routes.length === 2, `${dash.stops.done}/${dash.stops.total} done, ${dash.miles} mi, $${Number(dash.costPerStopMinor) / 100}/stop`);
  t.ok("maintenance due shows T-101's oil change and V-201's overdue inspection", dash.maintenanceDue.some((m: any) => m.unit_no === "T-101" && m.task.startsWith("Oil"))
    && dash.maintenanceDue.some((m: any) => m.unit_no === "V-201" && m.state === "overdue"));
  t.ok("the warehouse sees the damaged and returned items flagged", dash.flagged.length >= 2);

  // the damaged chairs: the customer rebooks them from a fresh link
  const relink = await post(P.RAY, `/fleet/orders/${SO(3)}/link`);
  const [, rv] = await pub("GET", relink.path);
  t.ok("after a partial delivery the customer's link offers a new window for what is left", rv.canBook && !rv.booking && rv.slots.length > 0);
  const [, rp] = await pub("POST", relink.path, { day: rv.slots[0].day, windowId: rv.slots[0].windowId });
  const rebooked = await one<{ n: number; d: string }>(`select count(*)::int n, min(sl.description) d from delivery_stop s join delivery_stop_line sl on sl.stop_id = s.id
     where s.entity_id = $1 and s.number = $2`, [ENTITY, rp.number]);
  t.ok("the new stop carries only the chairs that were not delivered", rebooked.n === 1 && rebooked.d.includes("Chair"), rp.number);

  // ===================================================== new customers, no seeded map point
  const prevGeocoder = geocoder();
  let failNext = false;
  setGeocoder(censusGeocoder(((url: string) => {
    if (failNext) return Promise.reject(new TypeError("fetch failed"));
    if (decodeURIComponent(url).includes("Unknown Rd")) return reply(200, CENSUS_MISS);
    // a Census answer for the newcomer's street in Camp Hill
    const h = structuredClone(CENSUS_HIT);
    h.result.addressMatches[0].coordinates = { x: -76.9195, y: 40.2422 };
    h.result.addressMatches[0].matchedAddress = "5 MARKET ST, CAMP HILL, PA, 17011";
    return reply(200, h);
  }) as FetchLike));
  try {
    let D2 = D;
    do { const d = new Date(D2 + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); D2 = d.toISOString().slice(0, 10); }
    while (![3, 6].includes(new Date(D2 + "T12:00:00Z").getUTCDay()));
    const newbies = await t.as(P.STEVE, async (c) => {
      const out: Record<string, { order: string; address: string }> = {};
      for (const [key, name, line1, city, postal] of [["nina", "Nina Newcomer", "5 Market St", "Camp Hill", "17011"], ["oscar", "Oscar Nowhere", "77 Unknown Rd", "Lemoyne", "17043"]]) {
        const cu = (await t.q<{ id: string }>(c, `insert into customer (entity_id, number, name, phone) values ($1, $2, $3, '717-555-0190') returning id`,
          [ENTITY, "C-G" + key.toUpperCase(), name]))[0].id;
        const ad = (await t.q<{ id: string }>(c, `insert into customer_address (entity_id, customer_id, line1, city, state, postal, is_default)
          values ($1,$2,$3,$4,'PA',$5,true) returning id`, [ENTITY, cu, line1, city, postal]))[0].id;
        const so = (await t.q<{ id: string }>(c, `insert into sales_order (entity_id, number, channel, location_id, customer_id, status, fulfillment, ship_address_id)
          values ($1, next_doc_no($1,'order','SO-'), 'pos', '33333333-0000-0000-0000-000000000001', $2, 'open', 'delivery', $3) returning id`, [ENTITY, cu, ad]))[0].id;
        await c.query(`insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, fulfil_from_id)
          select $1, $2, 1, id, sku, name, 1, price_minor, $3 from product where entity_id = $1 and sku = 'ACC-LAMP-01'`, [ENTITY, so, DC]);
        await c.query(`select sales_order_retotal($1) /* unscoped: function on one order */`, [so]);
        await reserveOrder(c, ENTITY, so);
        out[key] = { order: so, address: ad };
      }
      return out;
    });
    const wsh = (await get(`/fleet/availability?order=${newbies.nina.order}&day=${D2}&days=1`, P.RAY)).slots.find((x: any) => x.label === "8–12").windowId;
    await post(P.RAY, "/fleet/stops", { orderId: newbies.nina.order, day: D2, windowId: wsh });
    const ng = await one<{ lat: number; lng: number; geo_source: string }>(`select geo[1] lat, geo[0] lng, geo_source from customer_address where entity_id = $1 and id = $2`, [ENTITY, newbies.nina.address]);
    t.ok("booking a new customer's delivery finds the address on the map and keeps it", ng.geo_source === "census" && Math.abs(ng.lat - 40.2422) < 1e-6 && Math.abs(ng.lng + 76.9195) < 1e-6);
    const os = await post(P.RAY, "/fleet/stops", { orderId: newbies.oscar.order, day: D2, windowId: wsh });
    const og = await one<{ geo: string | null; geo_error: string | null }>(`select geo::text geo, geo_error from customer_address where entity_id = $1 and id = $2`, [ENTITY, newbies.oscar.address]);
    t.ok("an address the map service cannot find is still booked, with the reason kept and no made-up point", !!os.id && og.geo === null && /found no such address/.test(og.geo_error ?? ""));
    const sched = await get(`/fleet/stops?day=${D2}`, P.RAY);
    t.ok("the schedule shows which stop is not on the map", sched.find((x: any) => x.id === os.id)?.has_geo === false && sched.find((x: any) => x.number && x.customer === "Nina Newcomer")?.has_geo === true);
    const b2 = await post(P.RAY, "/fleet/routes/build", { day: D2, dcId: DC });
    const left = b2.unassigned.find((u: any) => u.id === os.id);
    t.ok("the builder routes the new customer and leaves the unplaced one over, naming customer and address",
      b2.routes.length === 1 && b2.routes[0].stops === 1 && b2.routes[0].miles < 40 && left?.noMapPoint && left.addressId === newbies.oscar.address
      && /Oscar Nowhere at 77 Unknown Rd, Lemoyne has no map point/.test(left.reason), `${b2.routes[0]?.miles} mi · ${left?.reason}`);
    await t.throws("a stop with no map point cannot be put on a route by hand either", () => post(P.RAY, `/fleet/stops/${os.id}/assign`, { routeId: b2.routes[0].routeId }),
      /stop D-\d+ for Oscar Nowhere at 77 Unknown Rd, Lemoyne has no map point/);
    await t.throws("the database refuses 0,0 as a point", () => t.as(P.RAY, async (c) => {
      await c.query(`update customer_address set geo = point(0,0) where entity_id = $1 and id = $2`, [ENTITY, newbies.oscar.address]);
    }), /customer_address_geo_range/);
    failNext = true;
    await t.throws("Find on map with the service down says so and offers the manual way", () => post(P.RAY, `/fleet/addresses/${newbies.oscar.address}/locate`),
      /could not place Oscar Nowhere at 77 Unknown Rd, Lemoyne on the map: the map service could not be reached .*Enter its latitude and longitude/);
    failNext = false;
    await t.throws("a manual point must be a real place", () => post(P.RAY, `/fleet/addresses/${newbies.oscar.address}/place`, { lat: "0", lng: "0" }), /real latitude and longitude/);
    await t.throws("a manual point must be two numbers", () => post(P.RAY, `/fleet/addresses/${newbies.oscar.address}/place`, { lat: "abc", lng: "" }), /real latitude and longitude/);
    await t.throws("a driver cannot move an address on the map", () => post(P.TONY, `/fleet/addresses/${newbies.oscar.address}/place`, { lat: 40.2412, lng: -76.8975 }), /needs one of/);
    await post(P.RAY, `/fleet/addresses/${newbies.oscar.address}/place`, { lat: 40.2412, lng: -76.8975 });
    const placed = await one<{ geo_source: string }>(`select geo_source from customer_address where entity_id = $1 and id = $2`, [ENTITY, newbies.oscar.address]);
    const b3 = await post(P.RAY, "/fleet/routes/build", { day: D2, dcId: DC });
    t.ok("placed by hand, the stop is routed on the next build, and the route stays local", placed.geo_source === "manual" && b3.unassigned.length === 0
      && b3.routes[0].stops === 2 && b3.routes[0].miles < 40, `${b3.routes[0].miles} mi`);
    // leave the shared demo stock as it was: these two test orders are cancelled and their lamps released
    await t.as(P.RAY, async (c, co, a) => {
      const sc = { tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "user" as const, id: a.personId, label: a.label } };
      await c.query(`update delivery_route set status = 'cancelled' where entity_id = $1 and route_on = $2 and status = 'draft'`, [ENTITY, D2]);
      for (const k of Object.values(newbies)) {
        const st = await t.q<{ id: string }>(c, `select id from delivery_stop where entity_id = $1 and sales_order_id = $2 and status = 'scheduled'`, [ENTITY, k.order]);
        for (const x of st) await F.cancelStop(c, sc, x.id, "test order, cleared");
        await releaseLines(c, ENTITY, k.order, "all");
        await c.query(`update sales_order_line set line_status = 'cancelled' where entity_id = $1 and sales_order_id = $2`, [ENTITY, k.order]);
        await c.query(`update sales_order set status = 'cancelled' where entity_id = $1 and id = $2`, [ENTITY, k.order]);
      }
    });
  } finally { setGeocoder(prevGeocoder); }

  // trial balance still balances
  const tb = await one<{ d: string; c: string }>(`select sum(jl.debit_minor)::text d, sum(jl.credit_minor)::text c from journal_line jl
    join journal_entry e on e.id = jl.journal_entry_id where e.entity_id = $1`, [ENTITY]);
  t.ok("the company's ledger still balances", tb.d === tb.c);

  // ===================================================== isolation
  const rioVehicles = await get("/fleet/vehicles", P.RIO_OWNER, RIO_ENTITY);
  t.ok("the other company sees only its own truck", rioVehicles.length === 1 && rioVehicles[0].unit_no === "R-01");
  await t.throws("the other company cannot open this company's route", () => get(`/fleet/routes/${RA.id}`, P.RIO_OWNER, RIO_ENTITY), /no such route/);
  await t.throws("the other company cannot book this company's order", () => postIn(RIO_ENTITY, P.RIO_OWNER, "/fleet/stops", { orderId: SO(2), day: D, windowId: am.windowId }), /no such order/);
  await t.throws("the other company cannot inspect this company's truck", () => postIn(RIO_ENTITY, P.RIO_OWNER, "/fleet/dvir", { vehicleId: V.T101, items: allOk() }), /no such vehicle/);
  const rioQueue = await get("/fleet/queue", P.RIO_OWNER, RIO_ENTITY);
  const rioRoutes = await get(`/fleet/routes?day=${D}`, P.RIO_OWNER, RIO_ENTITY);
  t.ok("the other company's queue and routes are empty", rioQueue.length === 0 && rioRoutes.length === 0);
  await t.throws("this company cannot put the other company's truck on its route", () => post(P.RAY, "/fleet/routes", { day: D, dcId: DC, vehicleId: "a1a1a1a1-0000-0000-0000-0000000000e1" }),
    /another company/);
  void ({} as Client);
  void ({} as Company);
}
