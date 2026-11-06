// Purchasing checks: the order form and open-to-buy, PO rules, the
// special-order queue and ETAs, acknowledgments (typed and imported),
// landed cost, reorder suggestions, the vendor export, roles, isolation.
import { type T, ENTITY, RIO_ENTITY, LOC, PEOPLE } from "./harness.ts";
import { q, type Client } from "../../packages/core/db.ts";
import { module as purchasingModule } from "../../server/modules/purchasing.ts";
import * as pur from "../../packages/core/purchasing.ts";
import { routes, rio, asPerson, P, V, BUYER, STORE_MGR, DC } from "./catalog.ts";
import { runFeeds } from "./vendor_feeds.ts";

const ORDER = "7b7b7b7b-0000-0000-0000-000000000001";
const SOFA_LINE = "7b7b7b7b-0000-0000-0000-0000000000a1";
const NS_LINE = "7b7b7b7b-0000-0000-0000-0000000000a2";
const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

type Placed = { placed: { poId: string; number: string; shipTo: string; vendor: string; totalMinor: string; expectedOn: string; warnings: string[] }[] };

const read = async <R>(t: T, fn: (c: Client) => Promise<R>): Promise<R> => {
  const c = await t.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};
const stock = (t: T, productId: string, locationId: string) => read(t, async (c) =>
  Number((await q<{ on_order: string }>(c, `select on_order from product_availability where entity_id = $1 and product_id = $2 and location_id = $3`,
    [ENTITY, productId, locationId]))[0]?.on_order ?? 0));
const otb = (t: T, month: string, category: string, loc: string) => read(t, async (c) =>
  (await pur.openToBuy(c, ENTITY, month)).find((x) => x.category === category && x.location_id === loc));

export async function run(t: T) {
  const r = routes(t, purchasingModule);

  // --------------------------------------------------------- the order form
  const form = await r.get<{ vendor: { name: string }; products: { id: string }[]; suggestions: { productId: string; locationId: string; qty: number }[]; otb: unknown[] }>(
    "/purchasing/order-form", `?vendor=${V.ASHLEY}`);
  t.ok("order form: a vendor's active stock items, without the dropped one", form.products.some((p) => p.id === P.NIGHTSTAND) && !form.products.some((p) => p.id === P.OTTOMAN));
  const nsSugg = form.suggestions.find((s) => s.productId === P.NIGHTSTAND && s.locationId === DC);
  t.ok("reorder: nothing on hand, two customers waiting, min 2 max 6 suggests 8", nsSugg?.qty === 8, JSON.stringify(nsSugg));
  // The dresser at the DC: its own min/max (8/12) set here, measured against whatever stock other modules' seeds left.
  await r.post("/purchasing/reorder-rules", BUYER, { productId: "77777777-0000-0000-0000-000000000004", locationId: DC, min: 8, max: 12 });
  const dr = await read(t, async (c) => (await q<{ available: string; on_order: string }>(c,
    `select available, on_order from product_availability where entity_id = $1 and product_id = $2 and location_id = $3`, [ENTITY, "77777777-0000-0000-0000-000000000004", DC]))[0]);
  const drWait = await read(t, async (c) => Number((await q<{ n: string }>(c, `select coalesce(sum(qty),0) n from sales_order_line where entity_id = $1 and product_id = $2
    and fulfil_from_id = $3 and line_status = 'on_order'`, [ENTITY, "77777777-0000-0000-0000-000000000004", DC]))[0].n));
  const drProj = Number(dr?.available ?? 0) + Number(dr?.on_order ?? 0) - drWait;
  const drSugg = (await read(t, (c) => pur.replenishment(c, ENTITY, { vendorId: V.ASHLEY }))).find((s) => s.sku === "ASH-B192-31");
  t.ok("reorder: at the minimum it orders up to the maximum (dresser 8/12)", drProj <= 8 ? drSugg?.suggest === 12 - drProj && drSugg?.projected === drProj : drSugg === undefined,
    `projected ${drProj}, suggested ${drSugg?.suggest}`);
  const darcyRule = (await read(t, (c) => pur.replenishment(c, ENTITY, { vendorId: V.ASHLEY }))).find((s) => s.sku === "ASH-2930338");
  t.ok("reorder: above the minimum nothing is suggested (Darcy 4/10)", darcyRule === undefined || darcyRule.projected <= 4);
  t.ok("reorder: a dropped product is never suggested", !(await read(t, (c) => pur.replenishment(c, ENTITY))).some((s) => s.product_id === P.OTTOMAN));

  const month = day(21).slice(0, 8) + "01";        // Ashley's lead time is 21 days
  const bedBefore = await otb(t, month, "Bedroom", DC);
  const nsBefore = await stock(t, P.NIGHTSTAND, DC);
  const darcyBefore = await stock(t, P.DARCY, DC), loveBefore = await stock(t, P.LOVESEAT, LOC.ENOLA);
  await t.throws("order form: an AP clerk cannot place POs", () => r.post("/purchasing/order-form", PEOPLE.CLERK, { lines: [{ productId: P.NIGHTSTAND, locationId: DC, qty: 1 }] }), /needs one of: buyer/);
  await t.throws("order form: a dropped product cannot be reordered", () => r.post("/purchasing/order-form", BUYER, { lines: [{ productId: P.OTTOMAN, locationId: DC, qty: 1 }] }), /dropped/);
  await t.throws("order form: a floor sample is not reordered as stock", () => r.post("/purchasing/order-form", BUYER, { lines: [{ productId: P.FLOOR, locationId: DC, qty: 1 }] }), /floor sample/);
  await t.throws("order form: a made-to-order sofa goes through a special order", () => r.post("/purchasing/order-form", BUYER, { lines: [{ productId: P.HUDSON, locationId: DC, qty: 1 }] }), /made to order/);
  await t.throws("order form: no quantities, nothing placed", () => r.post("/purchasing/order-form", BUYER, { lines: [{ productId: P.DARCY, locationId: DC, qty: 0 }] }), /at least one line/);
  await t.throws("order form: one bad line stops the whole form", () => r.post("/purchasing/order-form", BUYER, { lines: [{ productId: P.DARCY, locationId: DC, qty: 2 }, { productId: P.OTTOMAN, locationId: DC, qty: 1 }] }), /dropped/);
  t.ok("order form: a refused form placed nothing", (await stock(t, P.DARCY, DC)) === darcyBefore);
  const pf = await r.post<Placed>("/purchasing/order-form", BUYER, { lines: [
    { productId: P.DARCY, locationId: DC, qty: 2 }, { productId: P.NIGHTSTAND, locationId: DC, qty: 8 }, { productId: P.LOVESEAT, locationId: LOC.ENOLA, qty: 1 },
    { productId: P.TABLE, locationId: DC, qty: 1 }] });
  const dcAsh = pf.placed.find((p) => p.vendor.startsWith("Ashley") && p.shipTo === "Distribution center")!;
  const enAsh = pf.placed.find((p) => p.vendor.startsWith("Ashley") && p.shipTo !== "Distribution center")!;
  const dcCoa = pf.placed.find((p) => p.vendor.startsWith("Coaster"))!;
  t.ok("order form: one PO per vendor per ship-to", pf.placed.length === 3 && !!dcAsh && !!enAsh && !!dcCoa);
  t.ok("POs: numbered in sequence, total at cost, due after the vendor's lead time", /^PO-\d{6}$/.test(dcAsh.number) && dcAsh.totalMinor === String(2 * 38500 + 8 * 9500) && dcAsh.expectedOn === day(21));
  t.ok("POs: the vendor's freight minimum is a warning, not a refusal", enAsh.warnings.some((w) => /freight minimum is \$2,500.00/.test(w)));
  t.ok("POs: placing one puts the goods on order at the ship-to", (await stock(t, P.NIGHTSTAND, DC)) === nsBefore + 8 && (await stock(t, P.LOVESEAT, LOC.ENOLA)) === loveBefore + 1);
  const bedAfter = await otb(t, month, "Bedroom", DC);
  t.ok("open-to-buy: drops by what the PO commits", BigInt(bedBefore!.open_minor) - BigInt(bedAfter!.open_minor) === 76000n, `${bedBefore?.open_minor} -> ${bedAfter?.open_minor}`);
  t.ok("reorder: once ordered, the suggestion goes away", !(await read(t, (c) => pur.replenishment(c, ENTITY))).some((s) => s.product_id === P.NIGHTSTAND));
  const det = await r.get<{ po: Record<string, unknown>; lines: { vendor_sku: string; category: string; ack_status: string }[] }>("/purchasing/pos/:id", "", dcAsh.poId);
  t.ok("POs: lines carry the vendor's model, category and wait for an acknowledgment", det.lines.length === 2 && det.lines[0].vendor_sku === "2930338"
    && det.lines.every((l) => l.ack_status === "pending") && det.po.ship_to_location_id === DC);
  const glOk = await read(t, async (c) => (await q<{ code: string }>(c, `select g.code from purchase_order_line pol join gl_account g on g.id = pol.gl_account_id
                                                                         where pol.entity_id = $1 and pol.purchase_order_id = $2 limit 1`, [ENTITY, dcAsh.poId]))[0]?.code);
  t.ok("POs: merchandise lines code to the vendor's default account (inventory)", glOk === "1300");

  // --------------------------------------------------------- over budget
  const coaMonth = day(14).slice(0, 8) + "01";
  await t.throws("budgets: only the owner sets them", () => r.post("/purchasing/budgets", BUYER, { month: coaMonth.slice(0, 7), category: "Dining", locationId: LOC.ENOLA, budget: "100" }), /needs one of: owner/);
  await r.post("/purchasing/budgets", PEOPLE.STEVE, { month: coaMonth.slice(0, 7), category: "Dining", locationId: LOC.ENOLA, budget: "100" });
  const tableLine = [{ productId: P.TABLE, locationId: LOC.ENOLA, qty: 1 }];
  const tableBefore = await stock(t, P.TABLE, LOC.ENOLA);
  await t.throws("open-to-buy: a buyer cannot place a PO over budget", () => r.post("/purchasing/order-form", BUYER, { lines: tableLine }), /over budget: Dining at Enola.*\$100\.00 left.*\$190\.00/);
  await t.throws("open-to-buy: the owner goes over only with a reason", () => r.post("/purchasing/order-form", PEOPLE.STEVE, { lines: tableLine }), /Say why/);
  const over = await r.post<Placed>("/purchasing/order-form", PEOPLE.STEVE, { lines: tableLine, overBudgetReason: "Floor model sold, need a replacement now" });
  t.ok("open-to-buy: the owner's over-budget PO is placed and says so", over.placed[0].warnings.some((w) => /placed over budget/.test(w)));
  const dining = await otb(t, coaMonth, "Dining", LOC.ENOLA);
  t.ok("open-to-buy: shows the overspend as a negative open amount", dining?.open_minor === String(10000 - 19000));

  // ------------------------------------------------------------- cancel
  await t.throws("cancel: needs a reason", () => r.post("/purchasing/pos/:id/cancel", BUYER, { reason: " " }, over.placed[0].poId), /say why/);
  await r.post("/purchasing/pos/:id/cancel", BUYER, { reason: "Owner changed mind" }, over.placed[0].poId);
  t.ok("cancel: the budget comes back and the goods come off order",
    (await otb(t, coaMonth, "Dining", LOC.ENOLA))?.open_minor === "10000" && (await stock(t, P.TABLE, LOC.ENOLA)) === tableBefore);
  await t.throws("cancel: a cancelled PO cannot be cancelled again", () => r.post("/purchasing/pos/:id/cancel", BUYER, { reason: "again" }, over.placed[0].poId), /is cancelled/);
  const finPo = await read(t, async (c) => (await q<{ id: string }>(c, `select id from purchase_order where entity_id = $1 and ship_to_location_id is null limit 1`, [ENTITY]))[0]?.id);
  if (finPo) await t.throws("cancel: a PO entered in payables is not purchasing's to change", () => r.post("/purchasing/pos/:id/cancel", BUYER, { reason: "x" }, finPo), /entered in payables/);

  // --------------------------------------------------------- special orders
  const queue = await r.get<{ lines: { sales_line_id: string; vendor: string }[] }>("/purchasing/special-orders");
  t.ok("special orders: the customer's made-to-order sofa and backordered nightstand are waiting",
    queue.lines.some((l) => l.sales_line_id === SOFA_LINE) && queue.lines.some((l) => l.sales_line_id === NS_LINE));
  const lrBefore = await otb(t, day(42).slice(0, 8) + "01", "Living room", DC);
  await t.throws("special orders: an AP clerk cannot order them", () => r.post("/purchasing/special-orders", PEOPLE.CLERK, { lineIds: [SOFA_LINE] }), /needs one of: buyer, store manager/);
  const sp = await r.post<Placed>("/purchasing/special-orders", STORE_MGR, { lineIds: [SOFA_LINE, NS_LINE] });
  const sofaPo = sp.placed.find((p) => p.vendor.startsWith("Custom"))!, nsPo = sp.placed.find((p) => p.vendor.startsWith("Ashley"))!;
  t.ok("special orders: one PO per vendor, ship-to from the customer's line", sp.placed.length === 2 && sofaPo.shipTo === "Distribution center");
  t.ok("special orders: the sofa is bought at its configured cost, due after the vendor's lead time", sofaPo.totalMinor === "78000" && sofaPo.expectedOn === day(42));
  const sofaDet = await r.get<{ lines: { description: string; config: Record<string, { vendorCode: string }[]>; agreement_ref: string; customers: { order: string }[] }[] }>("/purchasing/pos/:id", "", sofaPo.poId);
  const sl = sofaDet.lines[0];
  t.ok("special orders: the PO line carries the factory's option codes and the customer's order",
    /\[S96 \/ VV-NAV \/ LG-WAL\]/.test(sl.description) && sl.config.fabric[0].vendorCode === "VV-NAV" && sl.agreement_ref === "SO-DEMO-0001" && sl.customers?.[0]?.order === "SO-DEMO-0001");
  t.ok("special orders: they do not spend open-to-buy", (await otb(t, day(42).slice(0, 8) + "01", "Living room", DC))?.open_minor === lrBefore?.open_minor);
  t.ok("special orders: ordered lines leave the queue", !(await r.get<{ lines: { sales_line_id: string }[] }>("/purchasing/special-orders")).lines.some((l) => l.sales_line_id === SOFA_LINE));
  await t.throws("special orders: the same customer line cannot be ordered twice", () => r.post("/purchasing/special-orders", BUYER, { lineIds: [SOFA_LINE] }), /not waiting for a PO/);
  const eta = await r.get<{ lines: { sales_order_line_id: string; expected_on: string; po_number: string }[] }>("/purchasing/eta/:id", "", ORDER);
  t.ok("special orders: the customer's order shows each line's PO and date", eta.lines.length === 2 && eta.lines.find((x) => x.sales_order_line_id === SOFA_LINE)?.expected_on === day(42));

  // ------------------------------------------------------- acknowledgments
  const sofaLineId = (await r.get<{ lines: { id: string }[] }>("/purchasing/pos/:id", "", sofaPo.poId)).lines[0].id;
  await t.throws("ack: a backorder needs a ship date", () => r.post("/purchasing/pos/:id/ack", BUYER, { lines: [{ lineId: sofaLineId, status: "backorder" }] }, sofaPo.poId), /say when/);
  await t.throws("ack: an unknown status is refused", () => r.post("/purchasing/pos/:id/ack", BUYER, { lines: [{ lineId: sofaLineId, status: "maybe" }] }, sofaPo.poId), /not an acknowledgment status/);
  await r.post("/purchasing/pos/:id/ack", STORE_MGR, { vendorRef: "CUW-77812", lines: [{ lineId: sofaLineId, status: "backorder", expectedOn: "2027-01-15" }] }, sofaPo.poId);
  const eta2 = await r.get<{ lines: { sales_order_line_id: string; expected_on: string; ack_status: string }[] }>("/purchasing/eta/:id", "", ORDER);
  t.ok("ack: the vendor's new date flows to the customer's order line", eta2.lines.find((x) => x.sales_order_line_id === SOFA_LINE)?.expected_on === "2027-01-15"
    && eta2.lines.find((x) => x.sales_order_line_id === SOFA_LINE)?.ack_status === "backordered");
  const sofaHdr = await r.get<{ po: Record<string, string> }>("/purchasing/pos/:id", "", sofaPo.poId);
  t.ok("ack: the PO records the vendor's reference, the day and the new date", sofaHdr.po.vendor_ref === "CUW-77812" && sofaHdr.po.acknowledged_on === day(0) && sofaHdr.po.expected_on === "2027-01-15");

  const nsOnOrder = await stock(t, P.NIGHTSTAND, DC);
  const ackCsv = [
    "PO Number,Line,Vendor SKU,Status,Qty,Ship Date,Ack Number",
    `${nsPo.number},1,B192-92,IR,0,,ASH-A1`,                         // vendor rejects the special-order nightstand
    `${dcAsh.number},1,2930338,IC,1,12/01/2026,ASH-A2`,              // cuts the sofas from 2 to 1
    `${dcAsh.number},2,B192-92,IA,8,12/01/2026,ASH-A2`,
    "PO-999999,1,X,IA,1,,",                                           // no such PO
  ].join("\n");
  await t.throws("ack import: an AP clerk cannot import acknowledgments", () => r.post("/purchasing/acks/import", PEOPLE.CLERK, { csv: ackCsv }), /needs one of/);
  const imp = await r.post<{ rows: number; applied: number; problems: { row: number; message: string }[] }>("/purchasing/acks/import", BUYER, { csv: ackCsv, filename: "ashley-855.csv" });
  t.ok("ack import: good rows apply, the unknown PO is listed by row", imp.rows === 4 && imp.applied === 3 && imp.problems.length === 1 && imp.problems[0].row === 5 && /no purchase order/.test(imp.problems[0].message), JSON.stringify(imp));
  t.ok("ack import: a rejected line comes off order and goes back to the special-order queue",
    (await stock(t, P.NIGHTSTAND, DC)) === nsOnOrder - 2 && (await r.get<{ lines: { sales_line_id: string }[] }>("/purchasing/special-orders")).lines.some((l) => l.sales_line_id === NS_LINE));
  const nsHdr = await r.get<{ po: Record<string, string> }>("/purchasing/pos/:id", "", nsPo.poId);
  t.ok("ack import: a PO whose every line was rejected is cancelled with that reason", nsHdr.po.status === "cancelled" && /rejected every line/.test(nsHdr.po.cancel_reason));
  t.ok("ack import: a changed quantity takes the difference off order", (await stock(t, P.DARCY, DC)) === darcyBefore + 1);
  const dcDet = await r.get<{ lines: { ack_status: string; expected_on: string; cancelled_qty: string }[] }>("/purchasing/pos/:id", "", dcAsh.poId);
  t.ok("ack import: US dates read, line statuses recorded", dcDet.lines[0].ack_status === "changed" && Number(dcDet.lines[0].cancelled_qty) === 1 && dcDet.lines[1].expected_on === "2026-12-01");
  await t.throws("ack: a line cannot go up through an acknowledgment", () => r.post("/purchasing/pos/:id/ack", BUYER, { lines: [{ lineId: (dcDet.lines[0] as unknown as { id: string }).id, status: "change", qty: 5 }] }, dcAsh.poId), /can only go down/);

  // ---------------------------------------------------------- landed cost
  await t.throws("landed cost: needs an amount", () => r.post("/purchasing/pos/:id/landed", BUYER, { kind: "freight", amount: "0" }, dcAsh.poId), /say the amount/);
  await r.post("/purchasing/pos/:id/landed", BUYER, { kind: "freight", amount: "300.00", basis: "value", note: "Ashley truck" }, dcAsh.poId);
  await r.post("/purchasing/pos/:id/landed", BUYER, { kind: "fuel", amount: "25.01", basis: "qty" }, dcAsh.poId);
  const lc = await r.get<{ lines: { id: string; landed_minor: string }[] }>("/purchasing/pos/:id", "", dcAsh.poId);
  const totalLanded = lc.lines.reduce((a, l) => a + BigInt(l.landed_minor), 0n);
  // value: sofa 1 x 38500 against nightstands 8 x 9500; $300 splits 10087 / 19913. qty: 1 of 9 -> 277, 8 of 9 -> 2224.
  t.ok("landed cost: spread over open lines to the cent", totalLanded === 32501n && lc.lines[0].landed_minor === String(10087 + 277), lc.lines.map((l) => l.landed_minor).join(","));
  const unit = await read(t, (c) => pur.landedUnitCost(c, ENTITY, lc.lines[1].id));
  t.ok("landed cost: a unit's cost includes its share", unit === 9500n + BigInt(Math.round((19913 + 2224) / 8)), String(unit));

  // ---------------------------------------------------------------- export
  const ex = await r.post<{ csv: string; orders: number; lines: number; filename: string; orderEmail: string }>("/purchasing/export", BUYER, { vendorId: V.ASHLEY });
  const exRows = ex.csv.trim().split("\r\n");
  t.ok("export: an 850-style file with one row per open line", exRows[0] === pur.EXPORT_COLUMNS.join(",") && ex.lines === exRows.length - 1 && ex.orders >= 2 && ex.orderEmail === "orders@ashley.example");
  t.ok("export: rows carry ship-to, vendor model, quantity after cuts and cost", exRows.some((x) => x.startsWith(dcAsh.number) && x.includes(",DC1,") && x.includes(",2930338,ASH-2930338,") && x.includes(",1,EA,385.00,385.00,")));
  const again = await r.post<{ lines: number }>("/purchasing/export", BUYER, { vendorId: V.ASHLEY, onlyNew: true });
  t.ok("export: once sent, a PO is not in the next 'new only' file", again.lines === 0);
  const resend = await r.post<{ csv: string }>("/purchasing/export", BUYER, { vendorId: V.ASHLEY });
  t.ok("export: a resend is marked as a change (purpose 05)", resend.csv.split("\r\n")[1].split(",")[2] === "05");

  // ------------------------------------------------------- reorder rules
  await t.throws("reorder rules: the maximum is at least the minimum", () => r.post("/purchasing/reorder-rules", STORE_MGR, { productId: P.RECLINER, locationId: LOC.ENOLA, min: 4, max: 2 }), /at least the minimum/);
  await t.throws("reorder rules: a package has none", () => r.post("/purchasing/reorder-rules", STORE_MGR, { productId: P.SET, locationId: LOC.ENOLA, min: 1, max: 2 }), /only stock items/);
  await r.post("/purchasing/reorder-rules", STORE_MGR, { productId: P.RECLINER, locationId: LOC.ENOLA, min: 2, max: 4 });
  const rs = await r.get<{ suggestions: { product_id: string; suggest: number }[] }>("/purchasing/replenishment", `?location=${LOC.ENOLA}`);
  t.ok("reorder rules: a new min/max shows up as a suggestion (1 on hand, 2/4 orders 3)", rs.suggestions.find((s) => s.product_id === P.RECLINER)?.suggest === 3);

  // ------------------------------------------------------------- lead time
  await r.post("/purchasing/vendors/:id", BUYER, { leadDays: 10 }, V.COASTER);
  const lead = await r.post<Placed>("/purchasing/order-form", BUYER, { lines: [{ productId: P.CHAIRS, locationId: DC, qty: 2 }] });
  t.ok("lead time: a vendor's new lead time sets the next PO's date", lead.placed[0].expectedOn === day(10));
  const home = await r.get<{ pos: { open_n: string }; queue: number }>("/purchasing/home");
  t.ok("home: counts open POs and the queue", Number(home.pos.open_n) >= 4 && home.queue === 1);

  // ------------------------------------------------------------ isolation
  await rio(t, (c, s) => t.throws("isolation: another company cannot buy from this company's vendor", () => pur.createPO(c, s, { vendorId: V.ASHLEY, shipToId: DC, lines: [{ productId: P.DARCY, qty: 1 }] }, true), /not active for this company/));
  await rio(t, (c, s) => t.throws("isolation: another company cannot cancel this company's PO", () => pur.cancelPO(c, s, dcAsh.poId, "x"), /no such purchase order/));
  await rio(t, (c, s) => t.throws("isolation: another company cannot order this company's customer lines", () => pur.placeSpecialOrders(c, s, [NS_LINE]), /not waiting for a PO/));
  await rio(t, (c, s) => t.throws("isolation: another company cannot set a budget for this company's store", () => pur.setBudget(c, s, { month: "2026-12", category: "Dining", locationId: LOC.ENOLA, budgetMinor: 1n }), /no such store/));
  const rioPos = await r.get<{ pos: unknown[] }>("/purchasing/pos", "?status=all", undefined, RIO_ENTITY);
  const rioQ = await r.get<{ lines: unknown[] }>("/purchasing/special-orders", "", undefined, RIO_ENTITY);
  const rioB = await r.get<{ rows: unknown[] }>("/purchasing/budgets", "", undefined, RIO_ENTITY);
  t.ok("isolation: another company sees none of these POs, queue lines or budgets", rioPos.pos.length === 0 && rioQ.lines.length === 0 && rioB.rows.length === 0);
  const rioPo = await r.get("/purchasing/pos/:id", "", dcAsh.poId, RIO_ENTITY);
  t.ok("isolation: another company asking for this company's PO gets not found", rioPo === null);
  void asPerson;

  // Vendor connections (Ashley API, ATP, freight, PO sending) run last, against a fake network.
  await runFeeds(t);
}
