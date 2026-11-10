// Warehouse management checks: containers through their stages with ETAs
// reaching PO lines and customers' special orders, freight / drayage / duty /
// fees spread by cube, value, weight and quantity into unit cost, a partial
// unload, an 856 that names its container (and one that opens a new one),
// goods in transit appearing and clearing (ATP and POS), two-step transfers
// with and without 1310 and one-step ones, the prep queue from receipt to a
// problem on damage hold, delivery and pick lists refused while prep is not
// done, labor minutes, role refusals and isolation. Runs last.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { T } from "./harness.ts";
import { ENTITY, RIO_ENTITY, LOC, PEOPLE } from "./harness.ts";
import { tx, q, type Client, type Scope } from "../../packages/core/db.ts";
import * as wms from "../../packages/core/wms.ts";
import * as inv from "../../packages/core/inventory.ts";
import * as pur from "../../packages/core/purchasing.ts";
import * as F from "../../packages/core/fleet.ts";
import * as x12 from "../../packages/core/x12.ts";
import * as edi from "../../packages/core/edi.ts";
import * as shop from "../../packages/core/shop.ts";
import { module as wmsModule } from "../../server/modules/wms.ts";
import { module as invModule } from "../../server/modules/inventory.ts";
import { module as posModule } from "../../server/modules/pos.ts";
import { scopeOf } from "../../server/actions.ts";
import { asPerson, routesOf } from "./inventory.ts";

const DC = "33333333-0000-0000-0000-0000000000dc";
const DEE = "55555555-0000-0000-0000-000000000013";       // warehouse
const MARIA = "55555555-0000-0000-0000-000000000011";     // sales
const RAY = "55555555-0000-0000-0000-000000000014";       // dispatcher
const BUYER = "55555555-0000-0000-0000-000000000016";
const MGR = "55555555-0000-0000-0000-000000000018";       // store manager
const COASTER = "66666666-0000-0000-0000-0000000000a2";
const GLOBAL = "66666666-0000-0000-0000-0000000000a3";
const P = { TABLE: "77777777-0000-0000-0000-000000000005", CHAIRS: "77777777-0000-0000-0000-000000000006", LIFT: "77777777-0000-0000-0000-000000000025" };
const CUSTOMER = "88888888-0000-0000-0000-000000000001";
const OURS = { qual: "ZZ", id: "BUDDYSHF" }, COASTER_ID = { qual: "01", id: "COASTERUSA" };
const day = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const B = (v: unknown) => BigInt(String(v ?? 0));

const W = routesOf(wmsModule as never), I = routesOf(invModule as never), POS = routesOf(posModule as never);
const as = <R>(who: string, fn: (c: Client, s: Scope) => Promise<R>, entity = ENTITY) => asPerson(who, (c, co, a) => fn(c, scopeOf(co, a)), entity);

export async function run(t: T) {
  const c0 = await t.pool.connect();
  const read = <X extends Record<string, unknown>>(sql: string, p: unknown[] = []) => t.q<X>(c0, sql, p);
  try {
    // ------------------------------------------------------------------ setup
    const so = await as(PEOPLE.STEVE, async (c) => {
      const o = (await q<{ id: string; number: string }>(c, `insert into sales_order (entity_id, number, channel, location_id, customer_id, status, fulfillment)
        values ($1, 'WMS-SO-1', 'phone', $2, $3, 'open', 'pickup') returning id, number`, [ENTITY, LOC.ENOLA, CUSTOMER]))[0];
      const l = (await q<{ id: string }>(c, `insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, fulfil_from_id, line_status)
        values ($1,$2,1,$3,'COA-121221','Andrea Dining Table',1,49900,$4,'on_order') returning id`, [ENTITY, o.id, P.TABLE, DC]))[0];
      return { ...o, lineId: l.id };
    });
    const poA = await as(BUYER, (c, s) => pur.createPO(c, s, { vendorId: COASTER, shipToId: DC, lines: [{ productId: P.TABLE, qty: 4 }, { productId: P.CHAIRS, qty: 10 }],
      overBudgetReason: "container program" }, true));
    const poB = await as(BUYER, (c, s) => pur.createPO(c, s, { vendorId: COASTER, shipToId: DC, kind: "special",
      lines: [{ productId: P.TABLE, qty: 1, salesLineId: so.lineId, agreementRef: so.number }, { productId: P.CHAIRS, qty: 5 }] }, true));
    const lines = async (poId: string) => read<{ id: string; seq: number; product_id: string; unit_price_minor: string; expected_on: string | null; landed_minor: string }>(
      `select id, seq, product_id, unit_price_minor, expected_on::text, landed_minor from purchase_order_line where entity_id = $1 and purchase_order_id = $2 order by seq`, [ENTITY, poId]);
    const [aTable, aChairs] = await lines(poA.poId);
    const [bTable, bChairs] = await lines(poB.poId);

    // ------------------------------------------------------------- containers
    await t.throws("roles: sales cannot book a container", () => W.post(t, MARIA, "/wms/containers", { containerNo: "MSCU1234567", destLocationId: DC }), /booking a container needs one of: buyer, warehouse, store manager/);
    const ct1 = await W.post(t, BUYER, "/wms/containers", { containerNo: "mscu 1234567", destLocationId: DC, vendorId: COASTER, carrier: "MSC", vessel: "MSC Aurora",
      bol: "MEDU9988776", portLoading: "Ningbo", portDischarge: "Houston" }) as { id: string; number: string };
    const ct2 = await W.post(t, BUYER, "/wms/containers", { containerNo: "TGHU7654321", destLocationId: DC, vendorId: COASTER }) as { id: string; number: string };
    await t.throws("containers: the same container number twice is refused", () => W.post(t, BUYER, "/wms/containers", { containerNo: "MSCU1234567", destLocationId: DC }), /already booked as CT-/);
    const head1 = await read<{ container_no: string; bol: string }>(`select container_no, bol from wms_container where entity_id = $1 and id = $2`, [ENTITY, ct1.id]);
    t.ok("containers: booked with its number (cleaned), carrier, vessel, bill of lading and ports", head1[0]?.container_no === "MSCU1234567" && head1[0]?.bol === "MEDU9988776");
    await W.post(t, BUYER, `/wms/containers/${ct1.id}/lines`, { lines: [{ poLineId: aTable.id, qty: 4 }, { poLineId: aChairs.id, qty: 6 }, { poLineId: bTable.id, qty: 1 }] });
    await W.post(t, BUYER, `/wms/containers/${ct2.id}/lines`, { lines: [{ poLineId: aChairs.id, qty: 4 }, { poLineId: bChairs.id, qty: 5 }] });
    await t.throws("containers: a container carries no more of a PO line than is left once other containers are counted",
      () => W.post(t, BUYER, `/wms/containers/${ct2.id}/lines`, { lines: [{ poLineId: aChairs.id, qty: 5 }] }), /has 4 left to put on a container, not 5/);
    const spans = await read<{ n: string }>(`select count(distinct container_id)::text n from wms_container_line where entity_id = $1 and purchase_order_line_id = $2`, [ENTITY, aChairs.id]);
    const holds = await read<{ n: string }>(`select count(distinct pol.purchase_order_id)::text n from wms_container_line cl join purchase_order_line pol on pol.id = cl.purchase_order_line_id
      where cl.entity_id = $1 and cl.container_id = $2`, [ENTITY, ct1.id]);
    t.ok("containers: one PO spans two containers, and one container holds lines of two POs", spans[0].n === "2" && holds[0].n === "2");

    // ------------------------------------------------- stages → PO and customer ETAs
    await W.post(t, BUYER, `/wms/containers/${ct1.id}/stage`, { stage: "departed", actualOn: day(0) });
    const st1 = await W.post(t, BUYER, `/wms/containers/${ct1.id}/stage`, { stage: "delivered_dc", expectedOn: day(20) }) as { arrivalOn: string; etaMoved: number; stage: string };
    const eta1 = (await read<{ expected_on: string }>(`select expected_on::text from purchase_order_line where entity_id = $1 and id = $2`, [ENTITY, aTable.id]))[0].expected_on;
    const cust1 = (await as(PEOPLE.STEVE, (c) => pur.etaForOrder(c, ENTITY, so.id))).find((x) => x.sales_order_line_id === so.lineId);
    t.ok("stages: the DC arrival day becomes the PO lines' expected date and the customer's special-order ETA",
      st1.stage === "departed" && st1.arrivalOn === day(20) && eta1 === day(20) && cust1?.expected_on === day(20), JSON.stringify({ st1, eta1, cust1 }));
    await W.post(t, BUYER, `/wms/containers/${ct1.id}/stage`, { stage: "at_port", actualOn: day(0) });
    await W.post(t, BUYER, `/wms/containers/${ct1.id}/stage`, { stage: "delivered_dc", expectedOn: day(25) });
    const cust2 = (await as(PEOPLE.STEVE, (c) => pur.etaForOrder(c, ENTITY, so.id))).find((x) => x.sales_order_line_id === so.lineId);
    const headB = (await read<{ expected_on: string }>(`select expected_on::text from purchase_order where entity_id = $1 and id = $2`, [ENTITY, poB.poId]))[0];
    t.ok("stages: a later ETA (customs hold) moves the customer's order and the PO's own date again", cust2?.expected_on === day(25) && headB.expected_on >= day(25), JSON.stringify({ cust2, headB }));
    await W.post(t, BUYER, `/wms/containers/${ct2.id}/stage`, { stage: "delivered_dc", expectedOn: day(30) });
    const chairsEta = (await read<{ expected_on: string }>(`select expected_on::text from purchase_order_line where entity_id = $1 and id = $2`, [ENTITY, aChairs.id]))[0].expected_on;
    t.ok("stages: a PO line split over two containers is due when the later one lands", chairsEta === day(30), chairsEta);
    await t.throws("stages: an actual day in the future is refused", () => W.post(t, BUYER, `/wms/containers/${ct1.id}/stage`, { stage: "customs_cleared", actualOn: day(3) }), /that is in the future/);
    await t.throws("stages: an actual day before an earlier stage's is refused", () => W.post(t, BUYER, `/wms/containers/${ct1.id}/stage`, { stage: "customs_cleared", actualOn: day(-5) }), /cannot be earlier/);
    await t.throws("stages: an unknown stage is refused in words", () => W.post(t, BUYER, `/wms/containers/${ct1.id}/stage`, { stage: "sunk", actualOn: day(0) }), /a container stage is one of/);

    // ------------------------------------------------------------- in transit
    const transit1 = await read<{ qty: string; arriving_on: string }>(`select qty::text, arriving_on::text from inv_in_transit where entity_id = $1 and source = 'po' and ref_id = $2 and product_id = $3`,
      [ENTITY, poA.poId, P.TABLE]);
    const notYet = await read<{ n: string }>(`select count(*)::text n from inv_in_transit where entity_id = $1 and source = 'po' and ref_id = $2 and product_id = $3`, [ENTITY, poB.poId, P.CHAIRS]);
    t.ok("in transit: a departed container's PO quantities are on the road, arriving on its DC day; one still at origin is not",
      Number(transit1[0]?.qty) === 4 && transit1[0]?.arriving_on === day(25) && notYet[0].n === "0", JSON.stringify({ transit1, notYet }));
    const atpT = await inv.availableToPromise(c0, ENTITY, P.TABLE);
    t.ok("in transit: ATP lists what is arriving and when", atpT.inTransit.some((x) => x.source === "po" && x.ref === poA.number && x.qty === 4 && x.text === `arriving on ${day(25)}`), JSON.stringify(atpT.inTransit));
    // A product with nothing here: its promise is the arrival day.
    const liftOn = Number((await read<{ n: string }>(`select coalesce(sum(on_hand - reserved - held), 0)::text n from stock_level where entity_id = $1 and product_id = $2`, [ENTITY, P.LIFT]))[0].n);
    const poL = await as(BUYER, (c, s) => pur.createPO(c, s, { vendorId: GLOBAL, shipToId: DC, lines: [{ productId: P.LIFT, qty: 2 }], overBudgetReason: "test" }, true));
    const ctL = await as(BUYER, (c, s) => wms.createContainer(c, s, { containerNo: "TRLU5550001", destLocationId: DC, vendorId: GLOBAL, etaDc: day(12) }));
    const [liftLine] = await lines(poL.poId);
    await as(BUYER, (c, s) => wms.setContainerLines(c, s, ctL.id, [{ poLineId: liftLine.id, qty: 2 }]));
    await as(BUYER, (c, s) => wms.setStage(c, s, ctL.id, "departed", { actualOn: day(0) }));
    const atpL = await inv.availableToPromise(c0, ENTITY, P.LIFT);
    t.ok("in transit: with none free anywhere, the promise is 'arriving on <date>'", liftOn > 0 || (atpL.availableNow === 0 && atpL.promise === `arriving on ${day(12)}` && atpL.arrivingOn === day(12)),
      JSON.stringify({ liftOn, now: atpL.availableNow, promise: atpL.promise }));
    const posRows = await POS.get(t, `/pos/products?locationId=${DC}&q=COA-121221`) as { id: string; arriving: string; arriving_here: string; arriving_on: string }[];
    const posTable = posRows.find((r) => r.id === P.TABLE);
    t.ok("in transit: POS product search shows what is arriving at the store and when", Number(posTable?.arriving_here) >= 5 && Number(posTable?.arriving) >= 5
      && !!posTable?.arriving_on && posTable.arriving_on <= day(25), JSON.stringify(posTable));
    const aisle = await as(PEOPLE.STEVE, async (c) => (await shop.aisleCatalog(c, ENTITY, LOC.ENOLA, "Andrea Dining Table", "")) as { id: string; arriving: string; arriving_on: string }[]);
    const aisleTable = aisle.find((r) => r.id === P.TABLE);
    t.ok("in transit: the endless aisle shows it arriving too", Number(aisleTable?.arriving) === Number(posTable?.arriving) && aisleTable?.arriving_on === posTable?.arriving_on, JSON.stringify(aisleTable));

    // ------------------------------------------- freight, drayage, duty, fees by basis
    await t.throws("roles: the warehouse cannot add freight or duty", () => W.post(t, DEE, `/wms/containers/${ct1.id}/costs`, { kind: "freight", amount: "1000", basis: "cube" }),
      /needs one of: buyer, controller/);
    await t.throws("costs: a basis outside cube, value, weight or quantity is refused", () => W.post(t, BUYER, `/wms/containers/${ct1.id}/costs`, { kind: "freight", amount: "10", basis: "mood" }),
      /spread it by cube, value, weight or quantity/);
    const prods = new Map((await read<{ id: string; cubic_ft: string; weight_lb: string }>(`select id, cubic_ft::text, weight_lb::text from product where entity_id = $1 and id = any($2)`,
      [ENTITY, [P.TABLE, P.CHAIRS]])).map((x) => [x.id, x]));
    const ctLines = [{ pol: aTable, qty: 4 }, { pol: aChairs, qty: 6 }, { pol: bTable, qty: 1 }];
    const expectShares = (amount: bigint, weight: (l: typeof ctLines[number]) => number) => {
      const w = ctLines.map((l) => BigInt(Math.round(weight(l) * 1000)));
      const tw = w.reduce((a, b) => a + b, 0n);
      let left = amount;
      return ctLines.map((_, i) => { const s = i === ctLines.length - 1 ? left : (amount * w[i]) / tw; left -= s; return s; });
    };
    const cube = (l: typeof ctLines[number]) => l.qty * Number(prods.get(l.pol.product_id)!.cubic_ft);
    const weight = (l: typeof ctLines[number]) => l.qty * Number(prods.get(l.pol.product_id)!.weight_lb);
    const value = (l: typeof ctLines[number]) => l.qty * Number(l.pol.unit_price_minor);
    const plan: [string, string, bigint, (l: typeof ctLines[number]) => number][] = [
      ["freight", "cube", 100000n, cube], ["duty", "value", 50000n, value], ["drayage", "weight", 30000n, weight], ["port_fees", "qty", 11000n, (l) => l.qty]];
    const shareOf = async (polId: string, kind: string) => B((await read<{ s: string }>(`select coalesce(sum(k.amount_minor),0)::text s from po_landed_cost k
      join wms_container_cost cc on cc.id = k.container_cost_id where k.entity_id = $1 and k.purchase_order_line_id = $2 and k.active and cc.container_id = $3 and k.kind = $4`,
      [ENTITY, polId, ct1.id, kind]))[0].s);
    const expectTotal = new Map<string, bigint>(ctLines.map((l) => [l.pol.id, 0n]));
    for (const [kind, basis, amount, fn] of plan) {
      await W.post(t, BUYER, `/wms/containers/${ct1.id}/costs`, { kind, amount: { minor: amount.toString() }, basis });
      const want = expectShares(amount, fn);
      const got = [await shareOf(aTable.id, kind), await shareOf(aChairs.id, kind), await shareOf(bTable.id, kind)];
      ctLines.forEach((l, i) => expectTotal.set(l.pol.id, expectTotal.get(l.pol.id)! + want[i]));
      t.ok(`landed cost: ${kind.replace("_", " ")} by ${basis} is prorated over the container's lines, last line taking the rounding`,
        got.every((g, i) => g === want[i]) && got.reduce((a, b) => a + b, 0n) === amount, `${got.join("/")} vs ${want.join("/")}`);
    }
    const landedA = B((await read<{ landed_minor: string }>(`select landed_minor::text from purchase_order_line where entity_id = $1 and id = $2`, [ENTITY, aTable.id]))[0].landed_minor);
    const unitA = await as(PEOPLE.STEVE, (c) => pur.landedUnitCost(c, ENTITY, aTable.id));
    t.ok("landed cost: the shares go into purchasing's landed cost, so the unit cost carries them",
      landedA === expectTotal.get(aTable.id) && unitA === B(aTable.unit_price_minor) + BigInt(Math.round(Number(landedA) / 4)), `${landedA} ${unitA}`);
    // Adding a line re-spreads: the old shares are retired, never deleted, and the total still adds up.
    const before = Number((await read<{ n: string }>(`select count(*)::text n from po_landed_cost where entity_id = $1 and container_cost_id is not null`, [ENTITY]))[0].n);
    await W.post(t, BUYER, `/wms/containers/${ct1.id}/lines`, { lines: [{ poLineId: aChairs.id, qty: 6 }] });
    const live = await read<{ n: string; s: string }>(`select count(*)::text n, coalesce(sum(k.amount_minor),0)::text s from po_landed_cost k join wms_container_cost cc on cc.id = k.container_cost_id
      where k.entity_id = $1 and cc.container_id = $2 and k.active`, [ENTITY, ct1.id]);
    const all = Number((await read<{ n: string }>(`select count(*)::text n from po_landed_cost where entity_id = $1 and container_cost_id is not null`, [ENTITY]))[0].n);
    t.ok("landed cost: a re-spread retires the old shares and writes new ones that still add up", live[0].n === "12" && B(live[0].s) === 191000n && all === before + 12, JSON.stringify({ live, before, all }));

    // ------------------------------------------------------------- prep rules
    await t.throws("roles: sales cannot set which goods need prep", () => W.post(t, MARIA, "/wms/prep/rules", { category: "Dining", prepTypes: ["inspect"] }), /needs one of: store manager/);
    await t.throws("prep rules: an unknown kind of prep is refused", () => W.post(t, MGR, "/wms/prep/rules", { category: "Dining", prepTypes: ["polish"] }), /not a kind of prep/);
    await W.post(t, MGR, "/wms/prep/rules", { category: "dining", prepTypes: ["inspect"], stdMinutes: 5 });
    await W.post(t, MGR, "/wms/prep/rules", { productId: P.TABLE, prepTypes: ["touch_up", "unbox"], stdMinutes: 20 });
    const ruleT = await wms.prepFor(c0, ENTITY, P.TABLE), ruleC = await wms.prepFor(c0, ENTITY, P.CHAIRS);
    t.ok("prep rules: a product's own rule wins over its category's, in working order", ruleT.types.join(",") === "unbox,touch_up" && ruleT.stdMinutes === 20 && ruleC.types.join(",") === "inspect");

    // ------------------------------------------------------- partial unload
    const detail = await W.get(t, `/wms/containers/${ct1.id}`) as { lines: { id: string; po_line_id: string }[] };
    const clOf = (polId: string) => detail.lines.find((l) => l.po_line_id === polId)!.id;
    await t.throws("roles: a buyer cannot unload a container", () => W.post(t, BUYER, `/wms/containers/${ct1.id}/receive`, { lines: [{ containerLineId: clOf(aTable.id), qty: 1 }] }),
      /unloading a container needs one of: warehouse, store manager/);
    const pool0 = (await read<{ qty: string; value_minor: string }>(`select qty::text, value_minor::text from inv_cost where entity_id = $1 and product_id = $2`, [ENTITY, P.TABLE]))[0];
    const r1 = await W.post(t, DEE, `/wms/containers/${ct1.id}/receive`, { lines: [{ containerLineId: clOf(aTable.id), qty: 3 }, { containerLineId: clOf(aChairs.id), qty: 6 },
      { containerLineId: clOf(bTable.id), qty: 1 }] }) as { receipts: { poNumber: string; receiptId: string; prepQueued: number }[]; unloaded: boolean; linesLeft: number };
    const ct1Row = (await read<{ stage: string }>(`select stage from wms_container where entity_id = $1 and id = $2`, [ENTITY, ct1.id]))[0];
    t.ok("partial receipt: two POs received from one container; one line stays on it and the container is at the DC, not unloaded",
      r1.receipts.length === 2 && !r1.unloaded && r1.linesLeft === 1 && ct1Row.stage === "delivered_dc", JSON.stringify({ r1, ct1Row }));
    const pool1 = (await read<{ qty: string; value_minor: string }>(`select qty::text, value_minor::text from inv_cost where entity_id = $1 and product_id = $2`, [ENTITY, P.TABLE]))[0];
    const unitB = await as(PEOPLE.STEVE, (c) => pur.landedUnitCost(c, ENTITY, bTable.id));
    t.ok("partial receipt: the tables go into stock at PO cost plus their freight, drayage, duty and fees",
      B(pool1.value_minor) - B(pool0.value_minor) === 3n * unitA + unitB && Number(pool1.qty) - Number(pool0.qty) === 4, `${B(pool1.value_minor) - B(pool0.value_minor)} vs ${3n * unitA + unitB}`);
    const left = await read<{ qty: string }>(`select qty::text from inv_in_transit where entity_id = $1 and source = 'po' and ref_id = $2 and product_id = $3`, [ENTITY, poA.poId, P.TABLE]);
    t.ok("in transit: the receipt clears what came in; the one still on the container stays on the road", Number(left[0]?.qty) === 1, JSON.stringify(left));
    const custLine = (await read<{ line_status: string; fulfil_from_id: string }>(`select line_status, fulfil_from_id from sales_order_line where entity_id = $1 and id = $2`, [ENTITY, so.lineId]))[0];
    t.ok("partial receipt: the customer's special-order table arrives reserved for them", custLine.line_status === "reserved" && custLine.fulfil_from_id === DC);
    await t.throws("partial receipt: more than is left on the container is refused", () => W.post(t, DEE, `/wms/containers/${ct1.id}/receive`, { lines: [{ containerLineId: clOf(aTable.id), qty: 2 }] }),
      /1 left to unload, not 2/);

    // ------------------------------------------------- prep queued on receipt
    const jobs = await read<{ prep_type: string; n: string; units: string }>(`select prep_type, count(*)::text n, sum(qty)::text units from wms_prep_job where entity_id = $1
      and goods_receipt_id = any($2) group by prep_type order by prep_type`, [ENTITY, r1.receipts.map((x) => x.receiptId)]);
    const byType = Object.fromEntries(jobs.map((j) => [j.prep_type, j]));
    t.ok("prep: receiving queues a job per labelled table for each kind its rule names, and one for the chairs' quantity",
      r1.receipts.reduce((a, x) => a + x.prepQueued, 0) === 9 && byType.unbox?.n === "4" && byType.touch_up?.n === "4" && byType.inspect?.n === "1" && Number(byType.inspect?.units) === 6,
      JSON.stringify(jobs));
    const r2 = await W.post(t, DEE, `/wms/containers/${ct1.id}/receive`, { lines: [{ containerLineId: clOf(aTable.id), qty: 1 }] }) as { unloaded: boolean };
    const gone = await read<{ n: string }>(`select count(*)::text n from inv_in_transit where entity_id = $1 and source = 'po' and ref_id = $2 and product_id = $3`, [ENTITY, poA.poId, P.TABLE]);
    const ct1After = (await read<{ stage: string }>(`select stage from wms_container where entity_id = $1 and id = $2`, [ENTITY, ct1.id]))[0];
    t.ok("partial receipt: the last of it unloads the container and nothing of it is in transit any more", r2.unloaded && ct1After.stage === "unloaded" && gone[0].n === "0");
    await t.throws("containers: an unloaded container takes no more lines", () => W.post(t, BUYER, `/wms/containers/${ct1.id}/lines`, { lines: [{ poLineId: aChairs.id, qty: 6 }] }), /is unloaded/);

    // ------------------------------------------------- prep: start, done, problem
    const queue = await W.get(t, `/wms/prep?locationId=${DC}`) as { id: string; number: string; prep_type: string; status: string; order_number: string | null; labels: string | null }[];
    const custJobs = queue.filter((j) => j.order_number === so.number);
    const free = queue.filter((j) => j.order_number !== so.number && j.prep_type === "touch_up" && j.labels);
    t.ok("prep queue: the customer's table shows its order; every labelled job shows its labels", custJobs.length === 2 && free.length >= 3, JSON.stringify(custJobs.map((j) => j.prep_type)));
    await t.throws("roles: a buyer cannot start a prep job", () => W.post(t, BUYER, `/wms/prep/${free[0].id}/start`), /starting a prep job needs one of: warehouse, store manager/);
    await t.throws("prep: done with no start and no minutes is refused", () => W.post(t, DEE, `/wms/prep/${free[1].id}/done`), /say how many minutes/);
    await W.post(t, DEE, `/wms/prep/${free[1].id}/start`);
    const done1 = await W.post(t, DEE, `/wms/prep/${free[1].id}/done`, { laborMinutes: 17 }) as { laborMinutes: number };
    const lab = await read<{ labor_minutes: number; status: string; finished_by: string }>(`select labor_minutes, status, finished_by from wms_prep_job where entity_id = $1 and id = $2`, [ENTITY, free[1].id]);
    t.ok("prep: a job is started and done with its labor minutes recorded against who did it", done1.laborMinutes === 17 && lab[0].labor_minutes === 17 && lab[0].status === "done" && lab[0].finished_by === DEE);
    await t.throws("prep: a finished job cannot be finished again", () => W.post(t, DEE, `/wms/prep/${free[1].id}/done`, { laborMinutes: 3 }), /is done; it cannot be marked done/);
    // A problem: the piece goes on damage hold, with the photo kept the way service tickets keep them.
    const photo = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
    await W.post(t, DEE, `/wms/prep/${free[0].id}/start`);
    const held0 = (await read<{ held: string }>(`select held::text from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`, [ENTITY, P.TABLE, DC]))[0];
    await t.throws("prep: a problem needs to say what is wrong", () => W.post(t, DEE, `/wms/prep/${free[0].id}/problem`, { problem: " " }), /say what is wrong/);
    await t.throws("prep: a photo that is neither a link nor a picture is refused", () => W.post(t, DEE, `/wms/prep/${free[0].id}/problem`, { problem: "scratch", photos: ["javascript:alert(1)"] }),
      /https link or a picture taken here/);
    const prob = await W.post(t, DEE, `/wms/prep/${free[0].id}/problem`, { problem: "Deep gouge on the tabletop", photos: [photo] }) as { damage: string; damageId: string };
    const held1 = (await read<{ held: string }>(`select held::text from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`, [ENTITY, P.TABLE, DC]))[0];
    const dmg = (await read<{ status: string; source: string; photo_urls: string[]; unit_id: string }>(`select status, source, photo_urls, unit_id from inv_damage where entity_id = $1 and id = $2`, [ENTITY, prob.damageId]))[0];
    const pcs = await read<{ status: string }>(`select status from inv_piece where entity_id = $1 and unit_id = $2`, [ENTITY, dmg.unit_id]);
    const jobP = (await read<{ status: string; photos: string[]; damage_id: string }>(`select status, photos, damage_id from wms_prep_job where entity_id = $1 and id = $2`, [ENTITY, free[0].id]))[0];
    t.ok("prep: a problem puts the piece on damage hold (held up one) with the photo, and the job records it",
      Number(held1.held) === Number(held0.held) + 1 && dmg.status === "open" && dmg.photo_urls[0] === photo && pcs.every((x) => x.status === "damaged")
      && jobP.status === "problem" && jobP.damage_id === prob.damageId && jobP.photos.length === 1, JSON.stringify({ held0, held1, dmg: dmg.status, pcs }));
    await t.throws("prep: a job whose piece is on damage hold does not start again until it is back in stock", () => W.post(t, DEE, `/wms/prep/${free[0].id}/start`), /starts once it is back in stock/);

    // ------------------------------------- delivery and pick list gated on prep
    await t.throws("roles: a warehouse worker cannot change the prep gate", () => W.post(t, DEE, "/wms/settings", { prepGate: "refuse" }), /needs one of: store manager, controller/);
    await W.post(t, MGR, "/wms/settings", { prepGate: "refuse" });
    const willCall = (c: Client, s: Scope) => F.bookStop(c, s, { orderId: so.id, kind: "will_call" });
    await t.throws("prep gate: booking the customer's pickup is refused while its table's prep is not done", () => as(RAY, willCall), /prep is not done, so booking the will-call is refused: P\S+ needs unbox; P\S+ needs touch up/);
    await t.throws("prep gate: staging a pick list with it is refused too", () => I.post(t, DEE, "/inventory/pick-list", { orderIds: [so.id] }), /staging this pick list is refused/);
    await W.post(t, MGR, "/wms/settings", { prepGate: "warn" });
    const warned = await I.post(t, DEE, "/inventory/pick-list", { orderIds: [so.id] }) as { prepWarning: string | null; prepPending: number };
    t.ok("prep gate: set to warn, the pick list goes ahead and says what is not done", warned.prepPending === 2 && /prep is not done yet/.test(warned.prepWarning ?? ""), warned.prepWarning ?? "");
    await W.post(t, MGR, "/wms/settings", { prepGate: "refuse" });
    for (const j of custJobs) { await W.post(t, DEE, `/wms/prep/${j.id}/start`); await W.post(t, DEE, `/wms/prep/${j.id}/done`, { laborMinutes: 10 }); }
    const booked = await as(RAY, willCall) as { number: string; prepWarning: string | null };
    t.ok("prep gate: once its prep is done the pickup books, with nothing to warn about", !!booked.number && booked.prepWarning === null, JSON.stringify(booked));
    const labor = await W.get(t, "/wms/prep/labor") as { prep_type: string; jobs: number; minutes: number }[];
    t.ok("prep: labor minutes add up by kind of prep", (labor.find((x) => x.prep_type === "touch_up")?.minutes ?? 0) >= 27, JSON.stringify(labor));
    await W.post(t, MGR, "/wms/settings", { prepGate: "warn" });

    // --------------------------------------------------- an 856 names its container
    const drop = await mkdtemp(join(tmpdir(), "erp-wms-"));
    const env: edi.EdiEnv = { ...edi.liveEdiEnv(), dropDir: drop };
    const fromCoaster = (ctl: number, a: x12.Asn856) => x12.writeInterchange({ sender: COASTER_ID, receiver: OURS, gsSender: COASTER_ID.id, gsReceiver: OURS.id, version: "004010", usage: "P",
      isaControl: ctl, gsControl: ctl }, [{ type: "856", control: 1, segments: x12.build856(a) }], x12.DEFAULT_SEPARATORS, { newline: true });
    const back = x12.parse856(x12.build856({ shipmentId: "X", date: day(0), equipment: "TGHU 7654321", orders: [{ poNumber: "PO-1", lines: [{ line: 1, qty: 1 }] }] }));
    t.ok("X12 856: the container travels in TD3 and reads back", back.equipment === "TGHU7654321" && !back.errors.length, JSON.stringify(back));
    const got = await as(BUYER, (c, s) => edi.receiveFile(c, s, env, { filename: "856-ct2.edi", text: fromCoaster(9101, { shipmentId: "COA-CT2-1", date: day(0), shippedOn: day(0), deliveryOn: day(28),
      carrierName: "Matson", equipment: "TGHU7654321", orders: [{ poNumber: poA.number, lines: [{ line: aChairs.seq, qty: 4 }] }, { poNumber: poB.number, lines: [{ line: bChairs.seq, qty: 5 }] }] }) }));
    const linked = await read<{ n: string }>(`select count(*)::text n from po_shipment where entity_id = $1 and container_id = $2 and asn_number = 'COA-CT2-1'`, [ENTITY, ct2.id]);
    const ct2Stage = await read<{ stage: string; actual_on: string | null; expected_on: string | null }>(`select stage, actual_on::text, expected_on::text from wms_container_stage
      where entity_id = $1 and container_id = $2 and stage in ('departed','delivered_dc') order by stage`, [ENTITY, ct2.id]);
    const ct2Lines = await read<{ n: string }>(`select count(*)::text n from wms_container_line where entity_id = $1 and container_id = $2`, [ENTITY, ct2.id]);
    t.ok("856: a notice naming a booked container attaches to it, marks it departed and gives it the delivery day",
      got.documents[0]?.status === "applied" && linked[0].n === "2" && ct2Lines[0].n === "2"
      && ct2Stage.find((x) => x.stage === "departed")?.actual_on === day(0) && ct2Stage.find((x) => x.stage === "delivered_dc")?.expected_on === day(28),
      JSON.stringify({ d: got.documents, linked, ct2Stage }));
    const bChairsTransit = await read<{ qty: string; arriving_on: string }>(`select qty::text, arriving_on::text from inv_in_transit where entity_id = $1 and source = 'po' and ref_id = $2 and product_id = $3`,
      [ENTITY, poB.poId, P.CHAIRS]);
    t.ok("856: what it ships is in transit, due the day the container lands", Number(bChairsTransit[0]?.qty) === 5 && bChairsTransit[0]?.arriving_on === day(28), JSON.stringify(bChairsTransit));
    const poC = await as(BUYER, (c, s) => pur.createPO(c, s, { vendorId: COASTER, shipToId: DC, lines: [{ productId: P.CHAIRS, qty: 3 }], overBudgetReason: "test" }, true));
    const gotNew = await as(BUYER, (c, s) => edi.receiveFile(c, s, env, { filename: "856-new.edi", text: fromCoaster(9102, { shipmentId: "COA-NEW-1", date: day(0), shippedOn: day(-1), deliveryOn: day(9),
      carrier: "XPOL", bol: "XPO-BOL-55", equipment: "XPOU8889990", orders: [{ poNumber: poC.number, lines: [{ line: 1, qty: 3 }] }] }) }));
    const opened = await read<{ id: string; number: string; vendor_id: string; bol: string; stage: string; dest_location_id: string }>(`select id, number, vendor_id, bol, stage, dest_location_id from wms_container
      where entity_id = $1 and container_no = 'XPOU8889990'`, [ENTITY]);
    const openedLines = opened.length ? await read<{ qty: string }>(`select qty::text from wms_container_line where entity_id = $1 and container_id = $2`, [ENTITY, opened[0].id]) : [];
    t.ok("856: a notice naming a container we had not booked opens it from the notice, departed, carrying what it ships",
      gotNew.documents[0]?.status === "applied" && opened[0]?.vendor_id === COASTER && opened[0]?.bol === "XPO-BOL-55" && opened[0]?.stage === "departed" && opened[0]?.dest_location_id === DC
      && Number(openedLines[0]?.qty) === 3, JSON.stringify({ d: gotNew.documents, opened, openedLines }));

    // ------------------------------------------------------ two-step transfers
    const lastJe = async (sourceId: string) => read<{ code: string; debit_minor: string; credit_minor: string; po: string | null }>(`select g.code, jl.debit_minor, jl.credit_minor, jl.profit_object_id po
      from journal_line jl join journal_entry je on je.id = jl.journal_entry_id join gl_account g on g.id = jl.gl_account_id where je.entity_id = $1 and je.source_id = $2`, [ENTITY, sourceId]);
    const side = (rows: { code: string; debit_minor: string; credit_minor: string }[], code: string) => rows.filter((r) => r.code === code).reduce((a, r) => a + B(r.debit_minor) - B(r.credit_minor), 0n);
    const tie = async () => inv.tieOut(c0, ENTITY);
    const s0 = await wms.settings(c0, ENTITY);
    t.ok("settings: the demo company ships transfers in two steps through 1310", s0.twoStepTransfers && s0.inTransitGl === "1310", JSON.stringify(s0));
    // A table still waiting on prep moves fine; prep is the destination's business.
    const tr1 = await I.post(t, DEE, "/inventory/transfers", { fromId: DC, toId: LOC.PALESTINE, lines: [{ productId: P.TABLE, qty: 1 }] }) as { id: string; number: string };
    const sh1 = await I.post(t, DEE, `/inventory/transfers/${tr1.id}/ship`, { expectedOn: day(2) }) as { valueMinor: bigint; transitGl: string; expectedOn: string };
    const je1 = await lastJe(tr1.id);
    const road = (await read<{ location_id: string; kind: string; status: string }>(`select p.location_id, l.kind, p.status from inv_piece p join location l on l.id = p.location_id
      where p.entity_id = $1 and p.transfer_id = $2`, [ENTITY, tr1.id]));
    const tr1Transit = await read<{ qty: string; arriving_on: string; to_location_id: string }>(`select qty::text, arriving_on::text, to_location_id from inv_in_transit where entity_id = $1 and ref_id = $2`,
      [ENTITY, tr1.id]);
    t.ok("two-step with 1310: shipping posts Dr 1310 Cr 1300 at cost", sh1.transitGl === "1310" && side(je1, "1310") === B(sh1.valueMinor) && side(je1, "1300") === -B(sh1.valueMinor) && B(sh1.valueMinor) > 0n);
    t.ok("in transit: the shipped transfer is on the road to the store, arriving on the day given, its pieces at the in-transit location",
      Number(tr1Transit[0]?.qty) === 1 && tr1Transit[0]?.arriving_on === day(2) && tr1Transit[0]?.to_location_id === LOC.PALESTINE && road.length > 0 && road.every((x) => x.kind === "in_transit" && x.status === "in_transit"),
      JSON.stringify({ tr1Transit, road }));
    const atpTr = await inv.availableToPromise(c0, ENTITY, P.TABLE);
    t.ok("in transit: ATP shows the transfer arriving at the store", atpTr.inTransit.some((x) => x.source === "transfer" && x.toLocationId === LOC.PALESTINE && x.arrivingOn === day(2)));
    const midTie = await tie();
    t.ok("tie-out: while on the road, stock at cost plus in transit equals 1300 plus 1310", midTie.ties, JSON.stringify({ d: String(midTie.differenceMinor) }));
    await I.post(t, DEE, `/inventory/transfers/${tr1.id}/receive`);
    const je1b = await lastJe(tr1.id);
    const tr1Gone = await read<{ n: string }>(`select count(*)::text n from inv_in_transit where entity_id = $1 and ref_id = $2`, [ENTITY, tr1.id]);
    t.ok("two-step with 1310: receiving reverses it and the transfer leaves in-transit", side(je1b, "1310") === 0n && side(je1b, "1300") === 0n && tr1Gone[0].n === "0");

    await t.throws("roles: a store manager cannot choose the in-transit account", () => W.post(t, MGR, "/wms/settings", { inTransitGl: "1300" }), /needs one of: controller/);
    await W.post(t, PEOPLE.CONTROLLER, "/wms/settings", { inTransitGl: "1300" });
    const tr2 = await I.post(t, DEE, "/inventory/transfers", { fromId: DC, toId: LOC.PALESTINE, lines: [{ productId: P.CHAIRS, qty: 2 }] }) as { id: string };
    const sh2 = await I.post(t, DEE, `/inventory/transfers/${tr2.id}/ship`) as { valueMinor: bigint; transitGl: string; expectedOn: string };
    const je2 = await lastJe(tr2.id);
    const tie2 = await tie();
    t.ok("two-step without 1310: shipping posts nothing; the value stays in 1300 and the tie-out holds", sh2.transitGl === "1300" && je2.length === 0 && tie2.ties && sh2.expectedOn === day(1),
      JSON.stringify({ je2, d: String(tie2.differenceMinor), gl: sh2.transitGl, on: sh2.expectedOn }));
    await I.post(t, DEE, `/inventory/transfers/${tr2.id}/receive`);
    const je2b = await lastJe(tr2.id);
    const palPo = (await read<{ id: string }>(`select id from profit_object where entity_id = $1 and location_id = $2`, [ENTITY, LOC.PALESTINE]))[0]?.id;
    t.ok("two-step without 1310: receiving moves the value from the DC to the store's column in 1300, and 1310 is never touched",
      side(je2b, "1310") === 0n && side(je2b, "1300") === 0n && je2b.some((r) => r.code === "1300" && r.po === palPo && B(r.debit_minor) === B(sh2.valueMinor)) && !je2b.some((r) => r.code === "1310"),
      JSON.stringify(je2b));

    await W.post(t, MGR, "/wms/settings", { twoStepTransfers: false });
    const pal0 = Number((await read<{ on_hand: string }>(`select on_hand::text from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`, [ENTITY, P.CHAIRS, LOC.PALESTINE]))[0]?.on_hand ?? 0);
    const tr3 = await I.post(t, DEE, "/inventory/transfers", { fromId: DC, toId: LOC.PALESTINE, lines: [{ productId: P.CHAIRS, qty: 1 }] }) as { id: string };
    const sh3 = await I.post(t, DEE, `/inventory/transfers/${tr3.id}/ship`) as { received: boolean };
    const st3 = (await read<{ status: string }>(`select status from inv_transfer where entity_id = $1 and id = $2`, [ENTITY, tr3.id]))[0];
    const pal1 = Number((await read<{ on_hand: string }>(`select on_hand::text from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`, [ENTITY, P.CHAIRS, LOC.PALESTINE]))[0]?.on_hand ?? 0);
    t.ok("one-step transfers (setting off): shipping lands the goods at once", sh3.received && st3.status === "received" && pal1 === pal0 + 1, JSON.stringify({ received: sh3.received, st3, pal0, pal1 }));
    await W.post(t, PEOPLE.CONTROLLER, "/wms/settings", { twoStepTransfers: true, inTransitGl: "1310" });
    const endTie = await tie();
    t.ok("tie-out: after containers, landed cost, damage and transfers, stock at cost still equals the ledger", endTie.ties && endTie.quantityOutOfStep.length === 0,
      JSON.stringify({ d: String(endTie.differenceMinor), off: endTie.quantityOutOfStep }));

    // -------------------------------------------------------------- isolation
    await t.throws("isolation: another client's company cannot see the container", () => tx({ kind: "user", id: PEOPLE.STEVE, label: "check" }, (c) => wms.container(c, RIO_ENTITY, ct1.id)),
      /no such container/);
    const rioTransit = await read<{ n: string }>(`select count(*)::text n from inv_in_transit where entity_id = $1`, [RIO_ENTITY]);
    t.ok("isolation: nothing of ours is in another company's in-transit", rioTransit[0].n === "0");
  } finally { c0.release(); }
}
