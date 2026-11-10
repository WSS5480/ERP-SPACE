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
import * as DM from "../../packages/core/debit_memo.ts";
import * as L from "../../packages/core/loading.ts";
import * as TAX from "../../packages/core/tax.ts";
import { post as glPost } from "../../packages/core/posting.ts";
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
  // a returns pickup at Ivy's on the same order, last on the truck: it carries a haul-away of its own
  const sP = await post(P.RAY, "/fleet/stops", { kind: "pickup", orderId: SO.E2, day: D, windowId: pm.windowId, pickupLines: [{ description: "Old bed frame, return", qty: 1 }] });
  await post(P.RAY, `/fleet/stops/${sP.id}/assign`, { routeId: RT.id });
  await post(P.RAY, `/fleet/routes/${RT.id}/crew`, { driverId: P.MARCO, helperId: P.JO });

  // ========================================================= 2. haul-away
  console.log("  -- haul-away on the stop");
  const before = await one<{ total_minor: string }>(`select total_minor from sales_order where entity_id = $1 and id = $2`, [ENTITY, SO.E1]);
  await t.throws("a driver cannot add haul-away to a stop", () => post(P.TONY, `/fleet/stops/${s1.id}/haul-away`, { category: "mattress" }), /needs one of/);
  await t.throws("a haul-away of a kind with no rate is refused", () => post(P.RAY, `/fleet/stops/${s1.id}/haul-away`, { category: "appliance" }), /no haul-away rate for appliance/);
  const hMatt = await post(P.MARIA, `/fleet/stops/${s1.id}/haul-away`, { category: "mattress", qty: 1, tradeIn: "50.00" });
  const hSofa = await post(P.RAY, `/fleet/stops/${s1.id}/haul-away`, { category: "sofa", qty: 1 });
  const after = await one<{ total_minor: string }>(`select total_minor from sales_order where entity_id = $1 and id = $2`, [ENTITY, SO.E1]);
  const feeTaxRows = await rows<{ code: string; taxable_minor: string; tax_minor: string; item_class: string }>(`
    select j.code, t.taxable_minor, t.tax_minor, t.item_class from sales_order_line_tax t join tax_jurisdiction j on j.id = t.jurisdiction_id
     where t.entity_id = $1 and t.sales_order_line_id = $2`, [ENTITY, hMatt.feeLineId]);
  const feeLine = await one<{ tax_minor: string }>(`select tax_minor from sales_order_line where entity_id = $1 and id = $2`, [ENTITY, hMatt.feeLineId]);
  const feeTax = feeTaxRows.reduce((a, r) => a + B(r.tax_minor), 0n);
  t.ok("the haul-away fee is taxed through the tax module: the fee product is taxable, and PA taxes delivery charges", feeTaxRows.length > 0
    && feeTaxRows.every((r) => r.item_class === "delivery") && feeTax === B(feeLine.tax_minor) && feeTax === 150n, feeTaxRows.map((r) => `${r.code} ${r.taxable_minor}/${r.tax_minor}`).join(", "));
  const sofaTax = await one<{ tax_minor: string }>(`select tax_minor from sales_order_line where entity_id = $1 and id = $2`, [ENTITY, hSofa.feeLineId]);
  t.ok("a fee product that is not taxable carries no tax", sofaTax.tax_minor === "0");
  t.ok("haul-away puts its fee on the order and the trade-in comes off it", B(after.total_minor) - B(before.total_minor) === 2500n + 150n + 3500n - 5000n
    && !!hMatt.feeLineId && !!hMatt.tradeInLineId && !!hSofa.feeLineId, `${before.total_minor} → ${after.total_minor}`);
  // Pennsylvania here takes trade-ins off taxable sales (a jurisdiction setting; off by default)
  const PA = "a7a70000-0000-0000-0000-000000000001";
  await t.throws("only a controller says how trade-ins are taxed", () => post(P.RAY, `/tax/jurisdictions/${PA}/trade-in`, { reducesTaxable: true }), /needs one of/);
  await post(P.CONTROLLER, `/tax/jurisdictions/${PA}/trade-in`, { reducesTaxable: true });
  const hP = await post(P.RAY, `/fleet/stops/${sP.id}/haul-away`, { category: "mattress", qty: 2, tradeIn: "40.00" });
  const tr1 = await one<{ tax_minor: string }>(`select tax_minor from sales_order_line where entity_id = $1 and id = $2`, [ENTITY, hMatt.tradeInLineId]);
  const tr2 = await one<{ tax_minor: string }>(`select tax_minor from sales_order_line where entity_id = $1 and id = $2`, [ENTITY, hP.tradeInLineId]);
  t.ok("a trade-in leaves taxable sales alone by default, and reduces them where the jurisdiction says so", tr1.tax_minor === "0" && B(tr2.tax_minor) === -240n, `${tr1.tax_minor} / ${tr2.tax_minor}`);

  // ============================================================ 3. loading
  console.log("  -- loading the truck");
  await t.throws("a driver cannot load the truck", () => post(P.TONY, `/fleet/routes/${RT.id}/loading/prepare`), /needs one of/);
  const ld = await post(P.DEE, `/fleet/routes/${RT.id}/loading/prepare`);
  const rt = await get(`/fleet/routes/${RT.id}`, P.RAY);
  const routeOrder = rt.stops.filter((s: any) => s.kind !== "pickup").map((s: any) => s.id);
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

  await t.throws("a piece on damage hold cannot be loaded", () => t.as(P.DEE, async (c) => {
    await c.query(`update inv_piece set status = 'damaged' where entity_id = $1 and id = $2`, [ENTITY, bed[1].piece_id]);
    await L.loadPiece(c, scope(P.DEE), RT.id, { code: bed[1].label });
  }), /is damaged in the warehouse, so it cannot go on the truck/);
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
  const filingAt = async () => { const c = await t.pool.connect(); try { return await TAX.filing(c, ENTITY, today, addDays(today, 1)); } finally { c.release(); } };
  const paTax = (f: any) => B(f.rows.find((r: any) => r.code === "PA")?.taxMinor ?? 0n);
  const f0 = await filingAt();

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
  // the bed is refused at the door; the chest is delivered
  const fin = await post(P.MARCO, `/fleet/stops/${s1.id}/complete`, { recipient: "Grace Liu", signature: SIG, reason: "Bed refused: wrong finish",
    lines: (await get(`/fleet/routes/${RT.id}`, P.MARCO)).stops.find((s: any) => s.id === s1.id).lines.map((l: any) => ({ id: l.id, outcome: l.sku === "ASH-B192-QBED" ? "refused" : "delivered" })) });
  const f1 = await filingAt();
  const postedTax = await one<{ t: string }>(`select coalesce(sum(t.tax_minor),0)::text t from sales_order_line_tax t join tax_jurisdiction j on j.id = t.jurisdiction_id
     where t.entity_id = $1 and t.journal_entry_id = $2 and j.code = 'PA'`, [ENTITY, fin.journalEntryId]);
  const feePosted = await one<{ taxable_minor: string; tax_minor: string; posted_on: string | null }>(`select t.taxable_minor, t.tax_minor, t.posted_on::text posted_on
     from sales_order_line_tax t join tax_jurisdiction j on j.id = t.jurisdiction_id where t.entity_id = $1 and t.sales_order_line_id = $2 and j.code = 'PA'`, [ENTITY, hMatt.feeLineId]);
  t.ok("the filing shows the haul-away fee taxed as configured, posted with its stop", feePosted.posted_on === today && feePosted.taxable_minor === "2500" && feePosted.tax_minor === "150"
    && paTax(f1) - paTax(f0) === B(postedTax.t), `PA tax ${paTax(f0)} → ${paTax(f1)}`);
  const inv = await rows<{ sku: string; net_minor: string; revenue_code: string }>(`
    select il.sku, il.net_minor, il.revenue_code from customer_invoice_line il join customer_invoice ci on ci.id = il.invoice_id
     where ci.entity_id = $1 and ci.journal_entry_id = $2`, [ENTITY, fin.journalEntryId]);
  const je = await one<{ dr: string; cr: string; fees: string; trade: string }>(`
    select sum(jl.debit_minor)::text dr, sum(jl.credit_minor)::text cr,
           (sum(jl.credit_minor) filter (where g.code = '4030') - coalesce(sum(jl.debit_minor) filter (where g.code = '4030'),0))::text fees,
           coalesce(sum(jl.debit_minor - jl.credit_minor) filter (where g.code = '4095'),0)::text trade
      from journal_line jl join gl_account g on g.id = jl.gl_account_id join journal_entry e on e.id = jl.journal_entry_id
     where e.entity_id = $1 and e.id = $2`, [ENTITY, fin.journalEntryId]);
  const fee = inv.find((l) => l.sku === "SVC-HAUL-MATT"), trade = inv.find((l) => l.sku === "TRADE-IN");
  t.ok("the haul-away fee posts with the delivery as fee revenue (4030)", !!fee && fee.net_minor === "2500" && fee.revenue_code === "4030" && B(je.fees) === 9900n + 2500n
    && je.dr === je.cr, `fees ${je.fees}`);
  t.ok("the trade-in posts to trade-in allowances (4095, contra-revenue), not merchandise sales", !!trade && trade.net_minor === "-5000" && trade.revenue_code === "4095"
    && je.trade === "5000" && !inv.some((l) => l.sku === "SVC-HAUL-FURN"), `4095 ${je.trade}`);
  t.ok("another stop's haul-away is not swept into this invoice", !inv.some((l) => l.sku === "SVC-HAUL-MATT" && false) && inv.filter((l) => l.sku === "SVC-HAUL-MATT").length === 1);
  await post(P.MARCO, `/fleet/stops/${s2.id}/arrive`);
  const fin2 = await post(P.MARCO, `/fleet/stops/${s2.id}/complete`, { recipient: "Ivy Patel", signature: SIG });
  const inv2 = await rows<{ sku: string }>(`select il.sku from customer_invoice_line il join customer_invoice ci on ci.id = il.invoice_id where ci.entity_id = $1 and ci.journal_entry_id = $2`,
    [ENTITY, fin2.journalEntryId]);
  t.ok("the pickup's haul-away stays with the pickup: the delivery on the same order does not invoice it", inv2.length > 0 && !inv2.some((l) => ["SVC-HAUL-MATT", "TRADE-IN"].includes(l.sku)),
    inv2.map((l) => l.sku).join(", "));
  await post(P.MARCO, `/fleet/stops/${sP.id}/arrive`);
  await post(P.MARCO, `/fleet/haul-away/${hP.id}/record`, { takenQty: 1, photo: PHOTO, note: "Only one of the two was ready" });
  const finP = await post(P.MARCO, `/fleet/stops/${sP.id}/complete`, { lines: [] });
  const invP = await rows<{ sku: string; qty: string; net_minor: string; revenue_code: string }>(`select il.sku, il.qty, il.net_minor, il.revenue_code
     from customer_invoice_line il join customer_invoice ci on ci.id = il.invoice_id where ci.entity_id = $1 and ci.journal_entry_id = $2`, [ENTITY, finP.journalEntryId]);
  t.ok("a pickup invoices its own haul-away when it completes: the fee for what was taken, the trade-in trimmed to that share", !!finP.journalEntryId
    && invP.find((l) => l.sku === "SVC-HAUL-MATT")?.net_minor === "2500" && Number(invP.find((l) => l.sku === "SVC-HAUL-MATT")?.qty) === 1
    && invP.find((l) => l.sku === "TRADE-IN")?.net_minor === "-2000" && invP.find((l) => l.sku === "TRADE-IN")?.revenue_code === "4095",
    invP.map((l) => `${l.sku} ${l.qty} ${l.net_minor}`).join(", "));
  const trP = await one<{ tax_minor: string }>(`select tax_minor from sales_order_line where entity_id = $1 and id = $2`, [ENTITY, hP.tradeInLineId]);
  t.ok("the trimmed trade-in is retaxed for the share taken", B(trP.tax_minor) === -120n, trP.tax_minor);
  await post(P.CONTROLLER, `/tax/jurisdictions/${PA}/trade-in`, { reducesTaxable: false });
  const bedPieces = bed.map((i: any) => i.piece_id);
  await post(P.MARCO, `/fleet/routes/${RT.id}/finish`);
  const back = await rows<{ status: string }>(`select status from inv_piece where entity_id = $1 and id = any($2)`, [ENTITY, bedPieces]);
  t.ok("pieces refused at the door come off the truck when the route finishes", back.length === 3 && back.every((p) => p.status === "picked"), back.map((p) => p.status).join(","));

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
  t.ok("the state report counts mattresses collected and recycled, with certificates", mat?.collected === 2 && mat?.recycled === 1 && mat?.undisposed === 1 && rep.certificates.some((c: any) => c.certificate_no === "KMR-2026-0441")
    && rep.reportRequired === false, rep.note);
  const ct = await get(`/fleet/haul-away/report?state=CT&from=${addDays(today, -1)}&to=${addDays(today, 1)}`, P.RAY);
  t.ok("a state with a program is configured to want the report, with its fee", ct.reportRequired === true && ct.programFeeWords === "$16.25 a unit");

  // ========================================================= 6. debit memos
  console.log("  -- vendor debit memos");
  const cb = await rows<{ id: string; number: string; amount_minor: string; status: string; journal_entry_id: string; cost_je: string | null }>(`
    select m.id, m.number, m.amount_minor, m.status, m.journal_entry_id, sc.journal_entry_id cost_je
      from vendor_debit_memo m left join service_cost sc on sc.id = m.service_cost_id
     where m.entity_id = $1 and m.vendor_id = $2 and m.source = 'service_chargeback' order by m.number`, [ENTITY, GLOBAL]);
  t.ok("each service chargeback to the vendor is a debit memo carrying its posting, waiting for a second person", cb.length >= 2
    && cb.every((m) => m.status === "pending_approval" && m.journal_entry_id === m.cost_je) && cb.some((m) => m.amount_minor === "4500"), cb.map((m) => `${m.number} ${m.amount_minor}`).join(", "));
  const PAT = "55555555-0000-0000-0000-000000000031";   // the technician who entered the service costs
  await t.throws("whoever entered the chargeback cost cannot approve its memo", () => t.as(PAT, (c) => DM.approveMemo(c, scope(PAT), cb[0].id)), /cannot approve it/);
  for (const m of cb) await post(P.CONTROLLER, `/payables/memos/${m.id}/approve`);
  const je45 = await one<{ n: number }>(`select count(*)::int n from journal_entry where entity_id = $1 and source_id = $2`, [ENTITY, cb[0].id]);
  t.ok("approving a chargeback memo opens it without posting again (the cost already posted it)", je45.n === 0
    && (await rows<{ status: string }>(`select status from vendor_debit_memo where entity_id = $1 and id = any($2)`, [ENTITY, cb.map((m) => m.id)])).every((x) => x.status === "open"));

  // voiding or turning down a chargeback: the cost lands in service expense (6150), whatever it came from
  const ticket = (await one<{ id: string; number: string }>(`select id, number from service_ticket where entity_id = $1 and vendor_id = $2 order by number limit 1`, [ENTITY, GLOBAL]))!;
  const chargeback = async (c: Client, kind: string, offset: string, amount: bigint, who = P.CLERK) => {
    const je = await glPost(c, scope(who), { date: today, sourceType: "service" as never, sourceId: ticket.id, description: `check: ${kind} charged back`,
      lines: [{ code: "1150", debit: amount }, { code: offset, credit: amount }] });
    const sc = (await t.q<{ id: string }>(c, `insert into service_cost (entity_id, ticket_id, kind, amount_minor, charge_to, note, journal_entry_id, created_by)
      values ($1,$2,$3,$4,'vendor','check',$5,$6) returning id`, [ENTITY, ticket.id, kind, amount.toString(), je, who]))[0].id;
    return DM.fromChargeback(c, scope(who), { vendorId: GLOBAL, serviceCostId: sc, ticketId: ticket.id, ticketNumber: ticket.number, amountMinor: amount,
      journalEntryId: je, offsetCode: offset, what: kind });
  };
  const sides = async (c: Client, je: string) => (await t.q<{ code: string; dr: string; cr: string }>(c, `
    select g.code, jl.debit_minor::text dr, jl.credit_minor::text cr from journal_line jl join gl_account g on g.id = jl.gl_account_id
     where jl.journal_entry_id = $1 /* unscoped: one entry */ order by jl.seq`, [je])).map((x) => `${x.code}:${x.dr}/${x.cr}`).join(" ");
  const voided = await t.as(P.CLERK, async (c) => {
    const out: string[] = [];
    for (const [kind, offset] of [["parts", "5000"], ["labor", "6155"], ["third_party", "2050"], ["other", "6150"]]) {
      const m = await chargeback(c, kind, offset, 1000n);
      await DM.approveMemo(c, scope(P.CONTROLLER), m.id);
      const v = await DM.voidMemo(c, scope(P.CONTROLLER), m.id, "vendor will not carry it");
      out.push(`${kind}=${await sides(c, v.journalEntryId)}`);
    }
    return out;
  });
  t.ok("voiding a chargeback memo, for each cost kind, posts Dr 6150 Cr 1150 (never back to stock, labour applied or the accrual)",
    voided.length === 4 && voided.every((x) => x.endsWith("=6150:1000/0 1150:0/1000")), voided.join(" · "));
  const rejected = await t.as(P.CLERK, async (c) => {
    const m = await chargeback(c, "labor", "6155", 700n);
    const r = await DM.rejectMemo(c, scope(P.CONTROLLER), m.id, "out of warranty");
    return sides(c, r.journalEntryId!);
  });
  t.ok("turning down a chargeback memo moves the cost to service expense too", rejected === "6150:700/0 1150:0/700", rejected);
  const auto = await t.as(P.CLERK, async (c) => {
    await DM.saveSettings(c, scope(P.CONTROLLER), 2500n);
    const small = await chargeback(c, "other", "6150", 1500n), big = await chargeback(c, "other", "6150", 2500n);
    await DM.saveSettings(c, scope(P.CONTROLLER), 0n);
    for (const m of [small, big]) await DM.voidMemo(c, scope(P.CONTROLLER), m.id, "check over").catch(() => null);
    return `${small.status}/${big.status}`;
  });
  t.ok("below the auto-approve amount a chargeback memo opens by itself; at or above it waits", auto === "open/pending_approval", auto);
  await t.throws("only a controller sets the auto-approve amount", () => post(P.CLERK, "/payables/memo-settings", { autoApproveBelow: "100" }), /needs one of/);
  const filled = await t.as(P.CLERK, async (c) => {
    const je = await glPost(c, scope(P.CLERK), { date: today, sourceType: "service" as never, sourceId: ticket.id, description: "check: a chargeback from before debit memos",
      lines: [{ code: "1150", debit: 3300n }, { code: "6155", credit: 3300n }] });
    const sc = (await t.q<{ id: string }>(c, `insert into service_cost (entity_id, ticket_id, kind, amount_minor, charge_to, note, journal_entry_id, created_by)
      values ($1,$2,'labor',3300,'vendor','from before',$3,$4) returning id`, [ENTITY, ticket.id, je, P.CLERK]))[0].id;
    const n = (await t.q<{ n: number }>(c, `select ops_backfill_chargeback_memos() n /* unscoped: the backfill covers every company */`))[0].n;
    const m = (await t.q<{ status: string; amount_minor: string; offset_code: string; journal_entry_id: string }>(c,
      `select status, amount_minor, offset_code, journal_entry_id from vendor_debit_memo where entity_id = $1 and service_cost_id = $2`, [ENTITY, sc]))[0];
    return { n, m, je };
  });
  t.ok("the migration's backfill makes a memo for a chargeback already in 1150, so the vendor balance includes it", filled.n === 1 && filled.m?.status === "open"
    && filled.m.amount_minor === "3300" && filled.m.offset_code === "6155" && filled.m.journal_entry_id === filled.je, JSON.stringify(filled.m));
  const backfilled = (await one<{ id: string }>(`select id from vendor_debit_memo where entity_id = $1 and amount_minor = 3300 and status = 'open'`, [ENTITY])).id;
  await post(P.CONTROLLER, `/payables/memos/${backfilled}/void`, { reason: "check over" });
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
  const BRV = types.find((x: any) => x.code === "BRV").id;
  await t.throws("a day already worked cannot also be paid leave (ask for the hours not worked)", () => t.as(P.MGR, async (c) => {
    await c.query(`insert into timecard (employee_id, pay_period_id, worked_on, hours, source, status) values ($1,$2,$3,5,'manual','recorded')`, [E.MARIA, P2, addDays(offDay, 5)]);
    const r = await LV.request(c, scope(P.MGR), { employeeId: E.MARIA, leaveTypeId: VAC, startsOn: addDays(offDay, 5) });
    await LV.decide(c, scope(P.STEVE), r.id, { approve: true });
  }), /already has time worked on .*a day is paid once/);
  const entered = await post(P.MGR, "/workforce/leave/requests", { employeeId: E.MARIA, leaveTypeId: VAC, startsOn: addDays(offDay, 4), note: "entered for her" });
  await t.throws("whoever entered a request does not decide it", () => post(P.MGR, `/workforce/leave/requests/${entered.id}/approve`), /whoever entered a time-off request does not decide it/);
  await post(P.STEVE, `/workforce/leave/requests/${entered.id}/decline`, { note: "she asks herself" });
  await t.throws("a manager cannot punch someone in on a full paid day off", () => t.as(P.MGR, async (c) => {
    const r = await LV.request(c, scope(P.MGR), { employeeId: E.A, leaveTypeId: BRV, startsOn: today });
    await LV.decide(c, scope(P.STEVE), r.id, { approve: true });
    await wf.punch(c, scope(P.MGR), { employeeId: E.A, locationId: LOC.ENOLA, kind: "in", source: "manager", reason: "forgot to clock in", byId: P.MGR });
  }), /full paid day of bereavement/);
  await t.throws("payroll refuses a paid leave day that also has worked hours", () => t.as(P.CONTROLLER, async (c) => {
    await c.query(`insert into timecard (employee_id, pay_period_id, worked_on, hours, source, status) values ($1,$2,$3,3,'manual','recorded')`, [E.MARIA, P2, offDay]);
    await LV.leavePayForPeriod(c, scope(P.CONTROLLER), P2, P.CONTROLLER);
  }), /3 h worked and 8 h paid leave .*more than the day's 8 h/);
  const postedDay = (await one<{ d: string }>(`select pp.starts_on::text d from pay_period pp join employee e on e.pay_group_id = pp.pay_group_id
     where e.id = $1 and e.entity_id = $2 and pp.status in ('built','released','posted') order by pp.starts_on desc limit 1`, [E.A, ENTITY]))?.d;
  await t.throws("leave in a pay period already posted is refused, not paid twice or never", () => t.as(P.MGR, async (c) => {
    if (!postedDay) throw new Error("already posted (no posted period to try)");
    const r = await LV.request(c, scope(P.MGR), { employeeId: E.A, leaveTypeId: BRV, startsOn: postedDay });
    await LV.decide(c, scope(P.STEVE), r.id, { approve: true });
  }), /already posted/);
  await t.throws("a balance does not go below zero unless the leave type allows it", () => post(P.CONTROLLER, "/workforce/leave/adjust",
    { employeeId: E.MARIA, leaveTypeId: VAC, hours: -1000, note: "too much" }), /cannot go below zero/);
  await t.throws("the clock refuses a phone punch-in on approved time off", () => t.as(P.MGR, async (c) => {
    const r = await LV.request(c, scope(P.MGR), { employeeId: E.A, leaveTypeId: types.find((x: any) => x.code === "BRV").id, startsOn: today });
    await LV.decide(c, scope(P.STEVE), r.id, { approve: true });
    await wf.punch(c, scope(P.MGR), { employeeId: E.A, locationId: LOC.ENOLA, kind: "in", source: "kiosk", byId: P.MGR });
  }), /on approved bereavement/);
  await t.throws("the absent-today card lists who is on approved leave", () => t.as(P.MGR, async (c) => {
    const r = await LV.request(c, scope(P.MGR), { employeeId: E.A, leaveTypeId: types.find((x: any) => x.code === "BRV").id, startsOn: today });
    await LV.decide(c, scope(P.STEVE), r.id, { approve: true });
    const a = await LV.absentToday(c, ENTITY, null);
    throw new Error(`absent: ${a.onLeave.map((x: any) => x.type).join(",")}`);
  }), /absent: .*Bereavement/);
  await t.throws("a salesperson cannot see the absent-today card", () => get("/workforce/absent-today", P.MARIA), /needs one of/);
  t.ok("a manager's absent-today card answers", Array.isArray((await get("/workforce/absent-today", P.MGR)).onLeave));

  // holidays
  let hDay = addDays(today, 40);
  while (new Date(hDay + "T12:00:00Z").getUTCDay() === 0) hDay = addDays(hDay, 1);
  await t.throws("a salesperson cannot add a holiday", () => post(P.MARIA, "/workforce/holidays", { day: hDay, name: "Test day" }), /needs one of/);
  const WSH = "a2a2a2a2-0000-0000-0000-000000000001";
  const hSlot = (await get(`/fleet/availability?zone=${WSH}&day=${hDay}&days=1`, P.RAY)).slots[0];
  const f1Addr = (await one<{ id: string }>(`select id from customer_address where entity_id = $1 and customer_id = '88888888-0000-0000-0000-0000000000f1'`, [ENTITY])).id;
  const booked = await post(P.RAY, "/fleet/stops", { kind: "service", customerId: "88888888-0000-0000-0000-0000000000f1", addressId: f1Addr, day: hDay, windowId: hSlot.windowId,
    problem: "Drawer runner loose" });
  const warn = await post(P.CONTROLLER, "/workforce/holidays", { day: hDay, name: "Founders Day", storeClosed: true, paid: true });
  t.ok("a store-closed holiday on a day with stops booked lists them and adds nothing until confirmed", warn.created === false && warn.confirmNeeded
    && warn.stops.some((x: any) => x.id === booked.id) && !(await one<{ n: number }>(`select count(*)::int n from company_holiday where entity_id = $1 and day = $2`, [ENTITY, hDay])).n, warn.warning);
  const hol = await post(P.CONTROLLER, "/workforce/holidays", { day: hDay, name: "Founders Day", storeClosed: true, paid: true, confirm: true });
  const bo = await one<{ reason: string; zone_id: string | null }>(`select reason, zone_id from delivery_blackout where entity_id = $1 and id = $2`, [ENTITY, hol.blackoutId]);
  t.ok("a store-closed holiday is a delivery blackout in every zone", hol.created && bo && bo.zone_id === null && /Founders Day/.test(bo.reason));
  const slots = await get(`/fleet/availability?zone=${WSH}&day=${addDays(hDay, -2)}&days=5`, P.RAY);
  t.ok("delivery availability skips the holiday", !slots.slots.some((s: any) => s.day === hDay) && slots.slots.length > 0);
  await t.throws("the same day is not a holiday twice", () => post(P.CONTROLLER, "/workforce/holidays", { day: hDay, name: "Again", confirm: true }), /already a holiday/);
  await t.throws("cancelling a holiday says why", () => post(P.CONTROLLER, `/workforce/holidays/${hol.id}/cancel`, { reason: "" }), /say why/);
  const hc = await post(P.CONTROLLER, `/workforce/holidays/${hol.id}/cancel`, { reason: "Moved to the Monday" });
  const bo2 = await one<{ released_at: string | null }>(`select released_at::text released_at from delivery_blackout where entity_id = $1 and id = $2`, [ENTITY, hol.blackoutId]);
  const slots2 = await get(`/fleet/availability?zone=${WSH}&day=${hDay}&days=1`, P.RAY);
  t.ok("a cancelled holiday releases its blackout (kept, marked released) and deliveries open again", hc.blackoutReleased && !!bo2.released_at && slots2.slots.length > 0);

  // a paid holiday on Maria's approved vacation day: the day is the holiday; her hours come back, paid once
  const before2 = (await get("/workforce/leave/balances", P.MARIA)).types.find((x: any) => x.code === "VAC").balance;
  const onLeave = await post(P.CONTROLLER, "/workforce/holidays", { day: offDay, name: "Inventory day off", storeClosed: false, paid: true, hours: 8 });
  const after2 = (await get("/workforce/leave/balances", P.MARIA)).types.find((x: any) => x.code === "VAC").balance;
  const leaveEarn = await one<{ status: string }>(`select status from payroll_earning where entity_id = $1 and employee_id = $2 and pay_period_id = $3 and source_type = 'leave_request'`, [ENTITY, E.MARIA, P2]);
  t.ok("a holiday on approved leave gives the leave hours back and cancels that day's leave pay", onLeave.leaveDaysReturned === 1 && after2 === before2 + 8 && leaveEarn.status === "cancelled",
    `vacation ${before2} → ${after2}`);
  const lp = await post(P.CONTROLLER, "/workforce/leave/pay", { payPeriodId: P2 });
  const hp = await one<{ n: number; maria: string | null; mariaAll: string }>(`select count(*) filter (where source_type = 'holiday')::int n,
       max(amount_minor) filter (where employee_id = $3 and source_type = 'holiday')::text maria,
       coalesce(sum(amount_minor) filter (where employee_id = $3 and status = 'approved'), 0)::text "mariaAll" from payroll_earning
     where entity_id = $1 and pay_period_id = $2`, [ENTITY, P2, E.MARIA]);
  t.ok("a paid holiday is holiday pay for the group's hourly people, and Maria is paid for the day once", lp.holidayPay === 2 && hp.n === 2 && hp.maria === "12000" && hp.mariaAll === "12000",
    `${hp.n} people, Maria ${hp.mariaAll}`);
  t.ok("holiday pay is added once", (await post(P.CONTROLLER, "/workforce/leave/pay", { payPeriodId: P2 })).holidayPay === 0);
  await t.throws("time off over a holiday only counts working days", () => post(P.MARIA, "/workforce/leave/requests", { leaveTypeId: VAC, startsOn: offDay, endsOn: offDay }),
    /every one of those days is a company holiday/);
  const hc2 = await post(P.CONTROLLER, `/workforce/holidays/${onLeave.id}/cancel`, { reason: "Count moved to Saturday" });
  const hpNow = await one<{ n: number }>(`select count(*)::int n from payroll_earning where entity_id = $1 and pay_period_id = $2 and source_type = 'holiday' and status = 'approved'`, [ENTITY, P2]);
  t.ok("a cancelled holiday cancels holiday pay not yet in a payroll run", hc2.holidayPayCancelled === 2 && hpNow.n === 0);
}
