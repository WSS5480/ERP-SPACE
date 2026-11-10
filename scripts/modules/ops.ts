// Operations checks: the truck's weight at booking, the piece-by-piece load
// manifest (last stop first, out-of-order warning, no lock until every piece
// is loaded or short), staging lanes, haul-away fees and trade-ins through the
// sale, the disposal log and the state report, vendor debit memos (from a
// service chargeback, and by hand with a second person's approval) reducing
// what we owe and the payment run, and time off: accrual, request, approval,
// balances, the clock and the schedule, holidays as delivery blackouts and
// holiday pay -- with the refusals that matter.

import { type T, ENTITY, RIO_ENTITY, PEOPLE, LOC } from "./harness.ts";
import { tx, type Client, type Scope } from "../../packages/core/db.ts";
import * as F from "../../packages/core/fleet.ts";
import * as LV from "../../packages/core/leave.ts";
import * as wf from "../../packages/core/workforce.ts";
import { reserveOrder } from "../../packages/core/inventory.ts";
import { postToLedger } from "../../packages/core/invoice.ts";
import { createPaymentRun, cancelPaymentRun } from "../../server/actions.ts";
import { module as fleetModule } from "../../server/modules/fleet.ts";
import { module as opsModule } from "../../server/modules/ops.ts";
import type { Company, Actor } from "../../server/modules/kit.ts";
import { loadCompany } from "../../server/views.ts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const DC = "33333333-0000-0000-0000-0000000000dc";
const P = {
  ...PEOPLE, MARIA: "55555555-0000-0000-0000-000000000011", DEE: "55555555-0000-0000-0000-000000000013", RAY: "55555555-0000-0000-0000-000000000014",
  TONY: "55555555-0000-0000-0000-000000000015", ANA: "55555555-0000-0000-0000-000000000016", MGR: "55555555-0000-0000-0000-000000000018",
  MARCO: "55555555-0000-0000-0000-000000000021", JO: "55555555-0000-0000-0000-000000000024", APPROVER: "55555555-0000-0000-0000-000000000004",
  RIO_OWNER: "eeee0000-0000-0000-0000-000000000201",
};
const SO = { E1: "99999999-0000-0000-0000-0000000000e1", E2: "99999999-0000-0000-0000-0000000000e2" };
const GLOBAL = "66666666-0000-0000-0000-0000000000a3";        // Global Furniture USA (the service checks charge it back)
const ASHLEY = "66666666-0000-0000-0000-0000000000a1";
const E = { MARIA: "aaaa0000-0000-0000-0000-000000000011", MGR: "aaaa0000-0000-0000-0000-000000000012", A: "aaaa0000-0000-0000-0000-000000000001" };
const SALES_FLOOR = "99999999-0000-0000-0000-000000000003";
const PERIOD = "cccc0000-0000-0000-0000-000000000003";
const SIG = "data:image/png;base64," + "iVBORw0KGgo".repeat(20);
const PHOTO = "https://example.com/haul/old-mattress.jpg";
const B = (v: unknown) => BigInt(String(v ?? 0));
const addDays = (day: string, k: number) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };

type Handler = { method: string; re: RegExp; fn: (...a: unknown[]) => Promise<unknown>; pub: boolean };

export async function run(t0: T) {
  const company = async (entityId = ENTITY): Promise<Company> => {
    const c = await t0.pool.connect();
    try { return (await loadCompany(c, entityId))!; } finally { c.release(); }
  };
  const nameOf = async (id: string) => {
    const c = await t0.pool.connect();
    try { return (await t0.q<{ name: string }>(c, "select name from app_user where id = $1 /* unscoped: lookup */", [id]))[0]?.name ?? "?"; } finally { c.release(); }
  };
  const as: T["as"] = async (personId, fn) => {
    const name = await nameOf(personId);
    const co = await company();
    return tx({ kind: "user", id: personId, label: name }, (c) => fn(c, co, { personId, personName: name, label: name }));
  };
  const t: T = { ...t0, company, as };
  const scope = (person: string, entityId = ENTITY): Scope => ({ tenantId: TENANT, entityId, actor: { kind: "user", id: person, label: "check" } });

  const H: Handler[] = [];
  for (const mod of [fleetModule, opsModule]) mod.register({
    coGet: (tail, fn) => H.push({ method: "GET", re: new RegExp(`^${tail}$`), fn: fn as Handler["fn"], pub: false }),
    coPost: (tail, fn) => H.push({ method: "POST", re: new RegExp(`^${tail}$`), fn: fn as Handler["fn"], pub: false }),
    publicRoute: (method, path, fn) => H.push({ method, re: path, fn: fn as Handler["fn"], pub: true }),
  });
  const find = (method: string, path: string) => {
    const h = H.find((x) => x.method === method && !x.pub && x.re.test(path));
    if (!h) throw new Error(`no ${method} ${path}`);
    return { h, mm: path.match(h.re)! };
  };
  const get = async (path: string, personId: string | null, entity = ENTITY) => {
    const u = new URL("http://x" + path);
    const { h, mm } = find("GET", u.pathname);
    const co = await company(entity);
    const c = await t.pool.connect();
    try { return await h.fn(c, co, u, [u.pathname, co.id, ...mm.slice(1)], personId) as any; } finally { c.release(); }
  };
  const post = async (personId: string, path: string, body: Record<string, unknown> = {}, entity = ENTITY) => {
    const { h, mm } = find("POST", path);
    const co = await company(entity);
    const name = await nameOf(personId);
    const a: Actor = { personId, personName: name, label: name };
    return tx({ kind: "user", id: personId, label: name }, (c) => h.fn(c, co, a, body, [path, co.id, ...mm.slice(1)])) as Promise<any>;
  };
  const one = async <X = any>(sql: string, params: unknown[] = []) => {
    const c = await t.pool.connect();
    try { return (await t.q(c, sql, params))[0] as X; } finally { c.release(); }
  };
  const rows = async <X = any>(sql: string, params: unknown[] = []) => {
    const c = await t.pool.connect();
    try { return (await t.q(c, sql, params)) as X[]; } finally { c.release(); }
  };

  const today = (await one<{ d: string }>(`select (now() at time zone 'America/New_York')::date::text d /* unscoped: clock */`)).d;
  // the second Monday, Tuesday, Thursday or Friday from today: the fleet and service checks use the days before it
  let D = today, seen = 0;
  while (seen < 2) { D = addDays(D, 1); if ([1, 2, 4, 5].includes(new Date(D + "T12:00:00Z").getUTCDay())) seen++; }

  // ============================================================ 1. weight
  console.log("  -- the truck's weight at booking");
  await t.as(P.STEVE, async (c) => { await reserveOrder(c, ENTITY, SO.E1); await reserveOrder(c, ENTITY, SO.E2); });
  const av = await get(`/fleet/availability?order=${SO.E2}&day=${D}&days=1`, P.RAY);
  const am = av.slots.find((s: any) => s.label === "8–12"), pm = av.slots.find((s: any) => s.label === "12–4");
  t.ok("availability counts weight: each slot reports the weight booked and its cap", am && pm && "weight" in am.used && "weight" in am.caps);
  await t.throws("a window with a weight cap refuses a stop heavier than what is left", () => t.as(P.RAY, async (c) => {
    await c.query(`update delivery_window set weight_cap_lb = 50 where entity_id = $1 and id = $2`, [ENTITY, am.windowId]);
    const slots = await F.availability(c, ENTITY, "a2a2a2a2-0000-0000-0000-000000000001", D, 1, { pieces: 1, cube: 18, labor: 10, weight: 80 });
    if (slots.find((s) => s.windowId === am.windowId)?.fits) throw new Error("availability says the 80 lb mattress fits a 50 lb window");
    await F.bookStop(c, scope(P.RAY), { orderId: SO.E2, day: D, windowId: am.windowId, manager: true });
  }), /can carry 50 lb more, not 80 lb/);

  const s1 = await post(P.RAY, "/fleet/stops", { orderId: SO.E1, day: D, windowId: am.windowId });
  const s2 = await post(P.RAY, "/fleet/stops", { orderId: SO.E2, day: D, windowId: pm.windowId });
  const w1 = await one<{ weight_lb: string }>(`select weight_lb from delivery_stop where entity_id = $1 and id = $2`, [ENTITY, s1.id]);
  t.ok("a booked stop carries its weight (product weight × quantity)", Number(w1.weight_lb) === 160 + 2 * 48, `${w1.weight_lb} lb`);

  // the route, by hand: E1 first, E2 second, on a truck free that day
  const busy = (await rows<{ vehicle_id: string }>(`select vehicle_id from delivery_route where entity_id = $1 and route_on = $2 and status <> 'cancelled'`, [ENTITY, D])).map((x) => x.vehicle_id);
  const truck = (await rows<{ id: string }>(`select id from vehicle where entity_id = $1 and home_location_id = $2 and status = 'active' order by max_weight_lb desc`, [ENTITY, DC]))
    .find((v) => !busy.includes(v.id))!;
  const RT = await post(P.RAY, "/fleet/routes", { day: D, dcId: DC, vehicleId: truck.id });
  await t.throws("putting a stop on a truck that cannot carry its weight is refused", () => t.as(P.RAY, async (c) => {
    await c.query(`update vehicle set max_weight_lb = 100 where entity_id = $1 and id = $2`, [ENTITY, truck.id]);
    await F.assignStop(c, scope(P.RAY), s1.id, RT.id);
  }), /carries 100 lb; with that stop the route weighs 256 lb/);
  await post(P.RAY, `/fleet/stops/${s1.id}/assign`, { routeId: RT.id });
  await post(P.RAY, `/fleet/stops/${s2.id}/assign`, { routeId: RT.id });
  await post(P.RAY, `/fleet/routes/${RT.id}/crew`, { driverId: P.MARCO, helperId: P.JO });

  // ========================================================= 2. haul-away
  console.log("  -- haul-away on the stop");
  const before = await one<{ total_minor: string }>(`select total_minor from sales_order where entity_id = $1 and id = $2`, [ENTITY, SO.E1]);
  await t.throws("a driver cannot add haul-away to a stop", () => post(P.TONY, `/fleet/stops/${s1.id}/haul-away`, { category: "mattress" }), /needs one of/);
  await t.throws("a haul-away of a kind with no rate is refused", () => post(P.RAY, `/fleet/stops/${s1.id}/haul-away`, { category: "appliance" }), /no haul-away rate for appliance/);
  const hMatt = await post(P.MARIA, `/fleet/stops/${s1.id}/haul-away`, { category: "mattress", qty: 1, tradeIn: "50.00" });
  const hSofa = await post(P.RAY, `/fleet/stops/${s1.id}/haul-away`, { category: "sofa", qty: 1 });
  const after = await one<{ total_minor: string }>(`select total_minor from sales_order where entity_id = $1 and id = $2`, [ENTITY, SO.E1]);
  t.ok("haul-away puts its fee on the order and the trade-in comes off it", B(after.total_minor) - B(before.total_minor) === 2500n + 3500n - 5000n
    && !!hMatt.feeLineId && !!hMatt.tradeInLineId && !!hSofa.feeLineId, `${before.total_minor} → ${after.total_minor}`);

  // ============================================================ 3. loading
  console.log("  -- loading the truck");
  await t.throws("a driver cannot load the truck", () => post(P.TONY, `/fleet/routes/${RT.id}/loading/prepare`), /needs one of/);
  const ld = await post(P.DEE, `/fleet/routes/${RT.id}/loading/prepare`);
  const rt = await get(`/fleet/routes/${RT.id}`, P.RAY);
  const routeOrder = rt.stops.map((s: any) => s.id);
  const loadOrder = [...new Set(ld.items.map((i: any) => i.stop_id))];
  t.ok("the manifest lists every piece in reverse stop order (last stop loads first)", routeOrder.length === 2 && JSON.stringify(loadOrder) === JSON.stringify([...routeOrder].reverse())
    && ld.items.every((x: any, i: number, a: any[]) => i === 0 || a[i - 1].load_group <= x.load_group), loadOrder.length + " stops");
  const labelled = ld.items.filter((i: any) => i.piece_id);
  const bed = ld.items.filter((i: any) => i.stop_id === s1.id && i.piece_id);
  t.ok("serialized goods show each carton's barcode from inventory (the bed is three cartons)", bed.length === 3 && labelled.every((i: any) => /^P/.test(i.label) && i.carton),
    labelled.map((i: any) => `${i.label} ${i.carton}`).join(", "));
  t.ok("unlabelled stock is one row per piece, scanned by its SKU", ld.items.filter((i: any) => i.label === "COA-121222").length === 2);
  t.ok("the route gets a staging lane at its warehouse", !!ld.route.lane_code, ld.route.lane_code);
  t.ok("the manifest shows the payload against the truck's weight limit", ld.route.weight === 256 + 80 && ld.route.payloadPct != null, `${ld.route.weight}/${ld.route.weight_cap} lb`);
  const lanes = await get(`/fleet/lanes?dc=${DC}&day=${D}`, P.DEE);
  const other = lanes.find((l: any) => !l.route_id);
  const mine = lanes.find((l: any) => l.route_id === RT.id);
  const R2 = await post(P.RAY, "/fleet/routes", { day: D, dcId: DC, vehicleId: (await rows<{ id: string }>(`select id from vehicle where entity_id = $1 and home_location_id = $2 and status = 'active' and id <> all($3) order by unit_no`, [ENTITY, DC, [...busy, truck.id]]))[0].id });
  await t.throws("a lane holds one route a day", () => post(P.DEE, `/fleet/routes/${R2.id}/lane`, { laneId: mine.id }), new RegExp(`already holds route ${RT.number}`));
  await post(P.DEE, `/fleet/routes/${R2.id}/lane`, { laneId: other.id });
  t.ok("another route takes another lane", (await get(`/fleet/lanes?dc=${DC}&day=${D}`, P.DEE)).find((l: any) => l.id === other.id).route_id === R2.id);

  // out of order: a piece for the first stop while the last stop's mattress is still on the dock
  const first = bed[0];
  const oo = await post(P.DEE, `/fleet/routes/${RT.id}/loading/scan`, { code: first.label.toLowerCase() });
  t.ok("loading a piece before a later stop's pieces warns that it is out of order", !!oo.warning && /Out of order/.test(oo.warning), oo.warning ?? "no warning");
  await t.throws("the same label twice is refused", () => post(P.DEE, `/fleet/routes/${RT.id}/loading/scan`, { code: first.label }), /already loaded/);
  await t.throws("a label that is not on this truck is refused", () => post(P.DEE, `/fleet/routes/${RT.id}/loading/scan`, { code: "P-NOPE-1" }), /not on this route's manifest/);
  await t.throws("the route cannot be locked while pieces are still on the dock", () => post(P.DEE, `/fleet/routes/${RT.id}/lock`), /not loaded yet .*mark them short/);
  const mattress = ld.items.find((i: any) => i.stop_id === s2.id && i.piece_id);
  const inOrder = await post(P.DEE, `/fleet/routes/${RT.id}/loading/scan`, { code: mattress.label });
  t.ok("the last stop's piece loads without a warning", !inOrder.warning);
  for (const i of bed.slice(1)) await post(P.DEE, `/fleet/routes/${RT.id}/loading/scan`, { code: i.label });
  const chest = await post(P.DEE, `/fleet/routes/${RT.id}/loading/scan`, { code: "COA-121222" });
  t.ok("scanning a SKU loads the next piece of it", chest.left === 1);
  const lastPiece = (await get(`/fleet/routes/${RT.id}/loading`, P.DEE)).items.find((x: any) => x.status === "pending");
  await t.throws("a piece marked short needs a reason", () => post(P.DEE, `/fleet/routes/${RT.id}/loading/short`, { itemId: lastPiece.id, reason: "" }), /say why the piece is short/);
  await post(P.DEE, `/fleet/routes/${RT.id}/loading/short`, { itemId: lastPiece.id, reason: "Second chest not found in bin B-04" });
  const done = await get(`/fleet/routes/${RT.id}/loading`, P.DEE);
  t.ok("every piece is loaded or short; the out-of-order load is remembered", done.canLock && done.totals.pending === 0 && done.totals.short === 1 && done.totals.outOfOrder === 1,
    JSON.stringify(done.totals));
  const pcs = await rows<{ status: string }>(`select status from inv_piece where entity_id = $1 and id = any($2)`, [ENTITY, labelled.map((i: any) => i.piece_id)]);
  t.ok("inventory shows the scanned pieces as loaded", pcs.length === labelled.length && pcs.every((p) => p.status === "loaded"));
  await post(P.DEE, `/fleet/routes/${RT.id}/lock`);
  await t.throws("a locked route's load is fixed", () => post(P.DEE, `/fleet/routes/${RT.id}/loading/undo`, { itemId: lastPiece.id }), /locked/);
  const printed = await get(`/fleet/routes/${RT.id}/manifest`, P.DEE);
  t.ok("the printable manifest carries each stop's haul-away", printed.stops.find((s: any) => s.number === s1.number)?.haulAway.length === 2);

  // ========================================================== 4. the door
  console.log("  -- haul-away at the door, through the sale");
  await post(P.MARCO, "/fleet/dvir", { vehicleId: truck.id, items: F.DVIR_ITEMS.map((i) => ({ code: i.code, ok: true })) });
  await post(P.MARCO, `/fleet/routes/${RT.id}/start`);
  await post(P.MARCO, `/fleet/stops/${s1.id}/arrive`);
  await t.throws("a stop with haul-away cannot be completed before it is recorded", () => post(P.MARCO, `/fleet/stops/${s1.id}/complete`, { recipient: "Grace Liu", signature: SIG }),
    /record what was hauled away/);
  await t.throws("another driver cannot record this route's haul-away", () => post(P.TONY, `/fleet/haul-away/${hMatt.id}/record`, { takenQty: 1, photo: PHOTO }), /another driver/);
  await t.throws("taking a piece away needs a photo", () => post(P.MARCO, `/fleet/haul-away/${hMatt.id}/record`, { takenQty: 1 }), /take a photo/);
  await post(P.MARCO, `/fleet/haul-away/${hMatt.id}/record`, { takenQty: 1, photo: PHOTO, weightLb: 62 });
  await t.throws("nothing taken says why", () => post(P.MARCO, `/fleet/haul-away/${hSofa.id}/record`, { takenQty: 0 }), /say why nothing was taken/);
  await post(P.MARCO, `/fleet/haul-away/${hSofa.id}/record`, { takenQty: 0, note: "Customer kept the old sofa" });
  const sofaLine = await one<{ line_status: string }>(`select line_status from sales_order_line where entity_id = $1 and id = $2`, [ENTITY, hSofa.feeLineId]);
  t.ok("what was not taken comes off the order", sofaLine.line_status === "cancelled");
  const fin = await post(P.MARCO, `/fleet/stops/${s1.id}/complete`, { recipient: "Grace Liu", signature: SIG,
    lines: (await get(`/fleet/routes/${RT.id}`, P.MARCO)).stops.find((s: any) => s.id === s1.id).lines.map((l: any) => ({ id: l.id, outcome: "delivered" })) });
  const inv = await rows<{ sku: string; net_minor: string; revenue_code: string }>(`
    select il.sku, il.net_minor, il.revenue_code from customer_invoice_line il join customer_invoice ci on ci.id = il.invoice_id
     where ci.entity_id = $1 and ci.journal_entry_id = $2`, [ENTITY, fin.journalEntryId]);
  const je = await one<{ dr: string; cr: string; fees: string }>(`
    select sum(jl.debit_minor)::text dr, sum(jl.credit_minor)::text cr,
           (sum(jl.credit_minor) filter (where g.code = '4030') - coalesce(sum(jl.debit_minor) filter (where g.code = '4030'),0))::text fees
      from journal_line jl join gl_account g on g.id = jl.gl_account_id join journal_entry e on e.id = jl.journal_entry_id
     where e.entity_id = $1 and e.id = $2`, [ENTITY, fin.journalEntryId]);
  const fee = inv.find((l) => l.sku === "SVC-HAUL-MATT"), trade = inv.find((l) => l.sku === "TRADE-IN");
  t.ok("the haul-away fee posts with the delivery as fee revenue (4030)", !!fee && fee.net_minor === "2500" && fee.revenue_code === "4030" && B(je.fees) === 9900n + 2500n
    && je.dr === je.cr, `fees ${je.fees}`);
  t.ok("the trade-in is credited against the sale", !!trade && trade.net_minor === "-5000" && !inv.some((l) => l.sku === "SVC-HAUL-FURN"));
  await post(P.MARCO, `/fleet/stops/${s2.id}/arrive`);
  await post(P.MARCO, `/fleet/stops/${s2.id}/complete`, { recipient: "Ivy Patel", signature: SIG });

  // ======================================================== 5. disposal
  console.log("  -- disposal log and the state report");
  const waiting = await get(`/fleet/haul-away/collected?dc=${DC}`, P.DEE);
  t.ok("the old mattress waits at the warehouse for disposal", waiting.some((x: any) => x.id === hMatt.id));
  await t.throws("a driver cannot log a disposal", () => post(P.TONY, "/fleet/haul-away/disposals", { dcLocationId: DC, disposedOn: today, method: "recycler", facility: "x", haulIds: [hMatt.id] }), /needs one of/);
  await t.throws("a recycler's drop needs its certificate number", () => post(P.DEE, "/fleet/haul-away/disposals",
    { dcLocationId: DC, disposedOn: today, method: "recycler", facility: "Keystone Mattress Recycling", haulIds: [hMatt.id] }), /certificate number/);
  await t.throws("only what was taken is disposed of", () => post(P.DEE, "/fleet/haul-away/disposals",
    { dcLocationId: DC, disposedOn: today, method: "landfill", facility: "Cumberland landfill", haulIds: [hSofa.id] }), /only what was taken/);
  const disp = await post(P.DEE, "/fleet/haul-away/disposals", { dcLocationId: DC, disposedOn: today, method: "recycler", facility: "Keystone Mattress Recycling",
    certificateNo: "KMR-2026-0441", haulIds: [hMatt.id] });
  t.ok("the disposal is logged with its number, weight and certificate", /^HD-/.test(disp.number) && disp.weightLb === 62, `${disp.number} ${disp.weightLb} lb`);
  await t.throws("a piece is disposed of once", () => post(P.DEE, "/fleet/haul-away/disposals", { dcLocationId: DC, disposedOn: today, method: "landfill", facility: "x", haulIds: [hMatt.id] }),
    /already on a disposal/);
  const rep = await get(`/fleet/haul-away/report?state=PA&from=${addDays(today, -1)}&to=${addDays(today, 1)}`, P.RAY);
  const mat = rep.categories.find((x: any) => x.category === "mattress");
  t.ok("the state report counts mattresses collected and recycled, with certificates", mat?.collected === 1 && mat?.recycled === 1 && rep.certificates.some((c: any) => c.certificate_no === "KMR-2026-0441")
    && rep.reportRequired === false, rep.note);
  const ct = await get(`/fleet/haul-away/report?state=CT&from=${addDays(today, -1)}&to=${addDays(today, 1)}`, P.RAY);
  t.ok("a state with a program is configured to want the report, with its fee", ct.reportRequired === true && ct.programFeeWords === "$16.25 a unit");

  // ========================================================= 6. debit memos
  console.log("  -- vendor debit memos");
  const cb = await rows<{ id: string; number: string; amount_minor: string; status: string; journal_entry_id: string; cost_je: string | null }>(`
    select m.id, m.number, m.amount_minor, m.status, m.journal_entry_id, sc.journal_entry_id cost_je
      from vendor_debit_memo m left join service_cost sc on sc.id = m.service_cost_id
     where m.entity_id = $1 and m.vendor_id = $2 and m.source = 'service_chargeback' order by m.number`, [ENTITY, GLOBAL]);
  t.ok("each service chargeback to the vendor is an open debit memo carrying its posting", cb.length >= 2 && cb.every((m) => m.status === "open" && m.journal_entry_id === m.cost_je)
    && cb.some((m) => m.amount_minor === "4500"), cb.map((m) => `${m.number} ${m.amount_minor}`).join(", "));
  // an approved bill from the vendor, on the books
  const bill = await t.as(P.CLERK, async (c) => {
    const gl = (await t.q<{ id: string }>(c, `select id from gl_account where tenant_id = $1 and code = '6150' /* unscoped: chart */`, [TENANT]))[0].id;
    const i = (await t.q<{ id: string }>(c, `insert into invoice (tenant_id, entity_id, vendor_id, kind, reference, invoice_date, due_date, total_minor, status, created_by)
      values ($1,$2,$3,'operating','GL-OPS-7781',$4,$4::date + 30,20000,'approved',$5) returning id`, [TENANT, ENTITY, GLOBAL, today, P.CLERK]))[0].id;
    await c.query(`insert into invoice_line (invoice_id, seq, gl_account_id, description, amount_minor) values ($1,1,$2,'Parts and service',20000)`, [i, gl]);
    await postToLedger(c, scope(P.CLERK), i);
    return i;
  });
  const st0 = await get(`/payables/vendors/${GLOBAL}/statement`, P.CLERK);
  const memo45 = cb.find((m) => m.amount_minor === "4500")!;
  await t.throws("a driver cannot apply a debit memo", () => post(P.TONY, `/payables/memos/${memo45.id}/apply`, { invoiceId: bill }), /needs one of/);
  await t.throws("a memo cannot go against another vendor's bill", () => t.as(P.CLERK, async (c) => {
    const x = (await t.q<{ id: string }>(c, `select id from invoice where entity_id = $1 and vendor_id <> $2 and status = 'approved' and ic_document_id is null limit 1`, [ENTITY, GLOBAL]))[0];
    if (!x) throw new Error("debit memo is for another vendor (no other approved bill to try)");
    const { applyMemo } = await import("../../packages/core/debit_memo.ts");
    await applyMemo(c, scope(P.CLERK), memo45.id, x.id);
  }), /for another vendor/);
  const ap0 = await one<{ ap: string; vc: string }>(`
    select coalesce(sum(jl.credit_minor - jl.debit_minor) filter (where g.code = '2010'),0)::text ap,
           coalesce(sum(jl.debit_minor - jl.credit_minor) filter (where g.code = '1150'),0)::text vc
      from journal_line jl join gl_account g on g.id = jl.gl_account_id join journal_entry e on e.id = jl.journal_entry_id where e.entity_id = $1`, [ENTITY]);
  const ap = await post(P.CLERK, `/payables/memos/${memo45.id}/apply`, { invoiceId: bill });
  const ap1 = await one<{ ap: string; vc: string }>(`
    select coalesce(sum(jl.credit_minor - jl.debit_minor) filter (where g.code = '2010'),0)::text ap,
           coalesce(sum(jl.debit_minor - jl.credit_minor) filter (where g.code = '1150'),0)::text vc
      from journal_line jl join gl_account g on g.id = jl.gl_account_id join journal_entry e on e.id = jl.journal_entry_id where e.entity_id = $1`, [ENTITY]);
  const st1 = await get(`/payables/vendors/${GLOBAL}/statement`, P.CLERK);
  t.ok("applying the chargeback memo to the bill reduces what we owe the vendor (Dr 2010 Cr 1150)", ap.appliedMinor === "4500" && ap.billLeftMinor === "15500"
    && B(ap0.ap) - B(ap1.ap) === 4500n && B(ap0.vc) - B(ap1.vc) === 4500n
    && B(st0.totals.owedOnBillsMinor) - B(st1.totals.owedOnBillsMinor) === 4500n && B(st0.totals.netOwedMinor) === B(st1.totals.netOwedMinor),
    `owed ${st0.totals.owedOnBillsMinor} → ${st1.totals.owedOnBillsMinor}`);
  t.ok("the memo is used up and the vendor's statement shows it against the bill", (await get(`/payables/memos/${memo45.id}`, P.CLERK)).status === "applied"
    && st1.lines.some((l: any) => l.kind === "debit_memo" && l.ref === memo45.number) && st1.bills.find((b: any) => b.id === bill).credited_minor === "4500");
  await t.throws("an applied memo cannot be applied again", () => post(P.CLERK, `/payables/memos/${memo45.id}/apply`, { invoiceId: bill }), /is applied/);

  // a manual memo: written by one person, approved by another
  await t.throws("a driver cannot write a debit memo", () => post(P.TONY, "/payables/memos", { vendorId: GLOBAL, source: "damaged_on_receipt", reason: "x", amount: "1" }), /needs one of/);
  await t.throws("a debit memo says what it is for", () => post(P.CLERK, "/payables/memos", { vendorId: GLOBAL, source: "damaged_on_receipt", reason: "", amount: "120.00" }), /say what the memo is for/);
  const dm = await post(P.CLERK, "/payables/memos", { vendorId: GLOBAL, source: "damaged_on_receipt", reason: "Recliner arm cracked on receipt, PO 4471", amount: "120.00", vendorRef: "RA-99812" });
  t.ok("a manual memo waits for approval and does not count until then", dm.status === "pending_approval");
  await t.throws("a pending memo cannot be applied", () => post(P.CLERK, `/payables/memos/${dm.id}/apply`, { invoiceId: bill }), /pending approval/);
  await t.throws("an A/P clerk cannot approve a debit memo", () => post(P.CLERK, `/payables/memos/${dm.id}/approve`), /needs one of/);
  const own = await post(P.CONTROLLER, "/payables/memos", { vendorId: GLOBAL, source: "price_difference", reason: "Billed above the quoted price", amount: "30.00" });
  await t.throws("whoever wrote a memo cannot approve it", () => post(P.CONTROLLER, `/payables/memos/${own.id}/approve`), /cannot approve it/);
  const okd = await post(P.CONTROLLER, `/payables/memos/${dm.id}/approve`, { note: "photos on file" });
  const dmje = await one<{ d1150: string; c5000: string }>(`
    select coalesce(sum(jl.debit_minor) filter (where g.code = '1150'),0)::text d1150, coalesce(sum(jl.credit_minor) filter (where g.code = '5000'),0)::text c5000
      from journal_line jl join gl_account g on g.id = jl.gl_account_id where jl.journal_entry_id = $1 /* unscoped: one entry by id */`, [okd.journalEntryId]);
  t.ok("approval posts the memo (Dr 1150 Cr 5000) and opens the credit", okd.status === "open" && dmje.d1150 === "12000" && dmje.c5000 === "12000");
  await post(P.APPROVER, `/payables/memos/${own.id}/reject`, { note: "the quote allowed the freight" });
  const st2 = await get(`/payables/vendors/${GLOBAL}/statement`, P.CLERK);
  t.ok("an unused memo is an open credit on the vendor's account", B(st2.totals.openCreditsMinor) >= 12000n + 2250n
    && B(st2.totals.netOwedMinor) === B(st2.totals.owedOnBillsMinor) - B(st2.totals.openCreditsMinor));
  await t.throws("a memo cannot be applied for more than the bill has left", () => post(P.CLERK, `/payables/memos/${dm.id}/apply`, { invoiceId: bill, amount: "200.00" }), /has \$120.00 left/);
  await post(P.CLERK, `/payables/memos/${dm.id}/apply`, { invoiceId: bill, amount: "120.00" });
  const run = await t.as(P.CLERK, async (c, co, a) => createPaymentRun(c, co, a, { payDate: new Date().toISOString().slice(0, 10), method: "ach", invoiceIds: [bill] }));
  const pay = await one<{ amount_minor: string }>(`select p.amount_minor from payment p join payment_run pr on pr.id = p.payment_run_id where pr.entity_id = $1 and pr.id = $2`, [ENTITY, run.id]);
  t.ok("the payment run pays the bill net of the memos applied to it", pay.amount_minor === String(20000 - 4500 - 12000) && run.total === pay.amount_minor, pay.amount_minor);
  await t.throws("a bill in a payment run being built takes no more memos", () => post(P.CLERK, `/payables/memos/${cb.find((m) => m.amount_minor === "2250")!.id}/apply`, { invoiceId: bill }), /payment run/);
  await t.as(P.CLERK, async (c, co, a) => cancelPaymentRun(c, co, a, { id: run.id }));
  const settle = await post(P.CLERK, `/payables/memos/${cb.find((m) => m.amount_minor === "2250")!.id}/apply`, { invoiceId: bill, amount: "22.50" });
  t.ok("the bill's three-way match is left alone: its lines and total do not change", (await one<{ t: string }>(`select sum(amount_minor)::text t from invoice_line where invoice_id = $1 /* unscoped: one bill by id */`, [bill])).t === "20000"
    && settle.billLeftMinor === String(20000 - 4500 - 12000 - 2250));
  const rio = await get("/payables/memos", P.RIO_OWNER, RIO_ENTITY);
  t.ok("another company sees none of these memos", rio.memos.length === 0);

  // ============================================================ 7. time off
  console.log("  -- time off and holidays");
  // the sales floor's next pay period, open
  const last = await one<{ ends_on: string }>(`select max(ends_on)::text ends_on from pay_period where pay_group_id = $1 /* unscoped: test setup, one pay group */`, [SALES_FLOOR]);
  const P2s = addDays(last.ends_on, 1);
  const P2 = (await one<{ id: string }>(`insert into pay_period (pay_group_id, starts_on, ends_on, pay_date, status) values ($1,$2,$3,$4,'open') returning id /* unscoped: test setup */`,
    [SALES_FLOOR, P2s, addDays(P2s, 6), addDays(P2s, 9)])).id;
  const types = (await get("/workforce/leave/options", P.MARIA)).types;
  const VAC = types.find((x: any) => x.code === "VAC").id, SICK = types.find((x: any) => x.code === "SICK").id;
  await t.throws("a salesperson cannot accrue leave", () => post(P.MARIA, "/workforce/leave/accrue", { payPeriodId: PERIOD }), /needs one of/);
  const acc = await post(P.CONTROLLER, "/workforce/leave/accrue", { payPeriodId: PERIOD });
  const accM = acc.accrued.filter((x: any) => x.employeeId === E.MARIA);
  t.ok("accrual: vacation per hour worked (23 h at 1 per 30) and sick per pay period", accM.find((x: any) => x.type === "Vacation")?.hours === 0.767 && accM.find((x: any) => x.type === "Sick")?.hours === 2,
    accM.map((x: any) => `${x.type} ${x.hours}`).join(", "));
  const again = await post(P.CONTROLLER, "/workforce/leave/accrue", { payPeriodId: PERIOD });
  t.ok("a pay period accrues once", again.accrued.filter((x: any) => x.employeeId === E.MARIA).length === 0);
  await t.throws("a salesperson cannot change a balance", () => post(P.MARIA, "/workforce/leave/adjust", { employeeId: E.MARIA, leaveTypeId: VAC, hours: 40, note: "opening" }), /needs one of/);
  await post(P.CONTROLLER, "/workforce/leave/adjust", { employeeId: E.MARIA, leaveTypeId: VAC, hours: 40, note: "Opening balance carried in" });
  await post(P.CONTROLLER, "/workforce/leave/adjust", { employeeId: E.MARIA, leaveTypeId: SICK, hours: 37.5, note: "Opening balance carried in" });
  const capped = await post(P.CONTROLLER, "/workforce/leave/accrue", { payPeriodId: P2 });
  const sickNow = (await get(`/workforce/leave/balances?employee=${E.MARIA}`, P.CONTROLLER)).types.find((x: any) => x.code === "SICK");
  t.ok("accrual stops at the cap", capped.accrued.find((x: any) => x.employeeId === E.MARIA && x.type === "Sick")?.capped === true && sickNow.balance === 40, `sick ${sickNow.balance}`);

  const offDay = addDays(P2s, 1);
  await t.throws("asking for more vacation than the balance is refused", () => post(P.MARIA, "/workforce/leave/requests", { leaveTypeId: VAC, startsOn: offDay, endsOn: addDays(offDay, 5), hoursPerDay: 8 }),
    /has 40.767 hours of vacation available, not 48/);
  await t.throws("someone with no employee record has no time off to ask for", () => post(P.TONY, "/workforce/leave/requests", { leaveTypeId: VAC, startsOn: offDay }), /not set up as an employee/);
  const req = await post(P.MARIA, "/workforce/leave/requests", { leaveTypeId: VAC, startsOn: offDay, hoursPerDay: 8, note: "Family visit" });
  t.ok("an employee asks for time off from the phone", req.totalHours === 8 && req.days === 1);
  await t.throws("an employee sees only their own requests", () => get(`/workforce/leave/requests?employee=${E.MGR}`, P.MARIA), /their own time off/);
  const shift = await t.as(P.MGR, async (c) => wf.addShift(c, scope(P.MGR), { locationId: LOC.ENOLA, employeeId: E.MARIA, startsAt: `${offDay}T10:00`, endsAt: `${offDay}T18:00`, role: "Floor" }));
  await t.throws("a salesperson cannot approve time off", () => post(P.MARIA, `/workforce/leave/requests/${req.id}/approve`), /needs one of/);
  const mgrReq = await post(P.MGR, "/workforce/leave/requests", { leaveTypeId: types.find((x: any) => x.code === "UNPAID").id, startsOn: addDays(offDay, 2), note: "Moving day" });
  await t.throws("a manager cannot approve their own time off", () => post(P.MGR, `/workforce/leave/requests/${mgrReq.id}/approve`), /nobody approves or declines their own/);
  await t.throws("declining says why", () => post(P.MGR, `/workforce/leave/requests/${req.id}/decline`, { note: "" }), /say why/);
  const appr = await post(P.MGR, `/workforce/leave/requests/${req.id}/approve`);
  const bal = (await get("/workforce/leave/balances", P.MARIA)).types.find((x: any) => x.code === "VAC");
  t.ok("approval takes the hours: 40 + 0.767 accrued - 8", appr.status === "approved" && bal.balance === 32.767, `vacation ${bal.balance}`);
  const shiftNow = await one<{ status: string }>(`select status from work_shift where entity_id = $1 and id = $2`, [ENTITY, shift]);
  t.ok("the shift on the day off is cancelled on approval, and said so", appr.shiftsCancelled === 1 && shiftNow.status === "cancelled");
  await t.throws("the schedule refuses a shift on approved time off", () => t.as(P.MGR, (c) => wf.addShift(c, scope(P.MGR),
    { locationId: LOC.ENOLA, employeeId: E.MARIA, startsAt: `${offDay}T12:00`, endsAt: `${offDay}T16:00` })), /approved vacation/);
  const earn = await one<{ amount_minor: string; debit_code: string }>(`select amount_minor, debit_code from payroll_earning where entity_id = $1 and employee_id = $2 and pay_period_id = $3 and source_type = 'leave_request'`,
    [ENTITY, E.MARIA, P2]);
  t.ok("paid vacation for an hourly person becomes a payroll earning in the period (8 h at $15)", earn?.amount_minor === "12000" && earn.debit_code === "6100");
  await t.throws("approved time off is taken back by a manager, not the employee", () => post(P.MARIA, `/workforce/leave/requests/${req.id}/cancel`, { reason: "changed plans" }), /taken back by a manager/);
  await t.throws("the clock refuses a phone punch-in on approved time off", () => t.as(P.MGR, async (c) => {
    const r = await LV.request(c, scope(P.MGR), { employeeId: E.A, leaveTypeId: types.find((x: any) => x.code === "BRV").id, startsOn: today });
    await LV.decide(c, scope(P.MGR), r.id, { approve: true });
    await wf.punch(c, scope(P.MGR), { employeeId: E.A, locationId: LOC.ENOLA, kind: "in", source: "kiosk", byId: P.MGR });
  }), /on approved bereavement/);
  await t.throws("the absent-today card lists who is on approved leave", () => t.as(P.MGR, async (c) => {
    const r = await LV.request(c, scope(P.MGR), { employeeId: E.A, leaveTypeId: types.find((x: any) => x.code === "BRV").id, startsOn: today });
    await LV.decide(c, scope(P.MGR), r.id, { approve: true });
    const a = await LV.absentToday(c, ENTITY, null);
    throw new Error(`absent: ${a.onLeave.map((x: any) => x.type).join(",")}`);
  }), /absent: .*Bereavement/);
  await t.throws("a salesperson cannot see the absent-today card", () => get("/workforce/absent-today", P.MARIA), /needs one of/);
  t.ok("a manager's absent-today card answers", Array.isArray((await get("/workforce/absent-today", P.MGR)).onLeave));

  // holidays
  const hDay = addDays(today, 45);
  await t.throws("a salesperson cannot add a holiday", () => post(P.MARIA, "/workforce/holidays", { day: hDay, name: "Test day" }), /needs one of/);
  const hol = await post(P.CONTROLLER, "/workforce/holidays", { day: hDay, name: "Founders Day", storeClosed: true, paid: true });
  const bo = await one<{ reason: string; zone_id: string | null }>(`select reason, zone_id from delivery_blackout where entity_id = $1 and id = $2`, [ENTITY, hol.blackoutId]);
  t.ok("a store-closed holiday is a delivery blackout in every zone", bo && bo.zone_id === null && /Founders Day/.test(bo.reason));
  const slots = await get(`/fleet/availability?zone=a2a2a2a2-0000-0000-0000-000000000001&day=${addDays(hDay, -2)}&days=5`, P.RAY);
  t.ok("delivery availability skips the holiday", !slots.slots.some((s: any) => s.day === hDay) && slots.slots.length > 0);
  await t.throws("the same day is not a holiday twice", () => post(P.CONTROLLER, "/workforce/holidays", { day: hDay, name: "Again" }), /already a holiday/);
  const paidHol = addDays(P2s, 3);
  await post(P.CONTROLLER, "/workforce/holidays", { day: paidHol, name: "Inventory day off", storeClosed: false, paid: true, hours: 8 });
  const lp = await post(P.CONTROLLER, "/workforce/leave/pay", { payPeriodId: P2 });
  const hp = await one<{ n: number; maria: string | null }>(`select count(*)::int n, max(amount_minor) filter (where employee_id = $3)::text maria from payroll_earning
     where entity_id = $1 and pay_period_id = $2 and source_type = 'holiday'`, [ENTITY, P2, E.MARIA]);
  t.ok("a paid holiday is holiday pay for the group's hourly people", lp.holidayPay === 2 && hp.n === 2 && hp.maria === "12000", `${hp.n} people`);
  t.ok("holiday pay is added once", (await post(P.CONTROLLER, "/workforce/leave/pay", { payPeriodId: P2 })).holidayPay === 0);
  await t.throws("time off over a holiday only counts working days", () => post(P.MARIA, "/workforce/leave/requests", { leaveTypeId: VAC, startsOn: paidHol, endsOn: paidHol }),
    /every one of those days is a company holiday/);
}
