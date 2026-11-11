// EDI checks: the X12 engine on its own (every document both ways,
// separator detection, envelope counts), then trading partners against the
// demo company: an 850 from a real PO through a drop folder, the vendor's
// 997, 855 dates reaching a customer's special order, an 856 marking goods
// in transit, an 810 bill that three-way matches after receiving, an 832
// repricing a product, an 846 refused while its channel is the API and
// applied once it is EDI, quarantines with reasons, duplicates ignored,
// test/production mismatch, a VAN with a token, the SFTP stub, API ordering
// and order-status polling through the vendor's orders and acknowledgments
// feeds (mock network), store orders from cart to PO, roles, and no secret
// in any GET. Runs last, so the products it reprices move no other check.
import { mkdtemp, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { type T, ENTITY, PEOPLE } from "./harness.ts";
import { q, tx, type Client } from "../../packages/core/db.ts";
import * as x12 from "../../packages/core/x12.ts";
import * as edi from "../../packages/core/edi.ts";
import * as pur from "../../packages/core/purchasing.ts";
import * as feeds from "../../packages/core/vendor_feeds.ts";
import * as so from "../../packages/core/store_orders.ts";
import { receivePurchaseOrder, openPurchaseOrders } from "../../packages/core/inventory.ts";
import { module as ediModule, useEdiEnv } from "../../server/modules/edi.ts";
import { routes, asPerson, V, BUYER, STORE_MGR, DC } from "./catalog.ts";
import { scopeOf } from "../../server/actions.ts";
import { runDueEdi } from "../run-due.ts";

const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const KEY = randomBytes(32);
const APPROVER = PEOPLE.MANAGER;            // Mesa Verde manager: approver
const SALES = "55555555-0000-0000-0000-000000000011";
const ENOLA = "33333333-0000-0000-0000-000000000001";
const P = { TABLE: "77777777-0000-0000-0000-000000000005", CHAIRS: "77777777-0000-0000-0000-000000000006", LAMP: "77777777-0000-0000-0000-000000000009", GLB: "77777777-0000-0000-0000-000000000007" };
const OURS = { qual: "ZZ", id: "BUDDYSHF" };
const COASTER_ID = { qual: "01", id: "COASTERUSA" };
const GLOBAL_ID = { qual: "ZZ", id: "GLOBALFURN" };

const read = async <R>(t: T, fn: (c: Client) => Promise<R>): Promise<R> => {
  const c = await t.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};

// --------------------------------------------------------- the fake network
type Req = { url: string; method: string; headers: Record<string, string>; body: string };
function fakeNet() {
  const log: Req[] = [];
  const state = { vanInbox: [] as { id: string; content: string }[], acked: [] as string[], statusRows: [] as Record<string, unknown>[] };
  const res = (status: number, body: string, type = "application/json") => ({ status, headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? type : null) }, text: async () => body });
  const fetch: feeds.FetchLike = async (url, init = {}) => {
    const r: Req = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? "" };
    log.push(r);
    const u = new URL(url);
    if (u.host === "api.global.example" && u.pathname === "/v2/orders") {
      if (r.headers["x-api-key"] !== "G-ORDERS-7777") return res(401, "");
      const b = JSON.parse(r.body) as { po: string; items: { model: string; qty: number }[] };
      return res(201, JSON.stringify({ result: { orderNo: `GL-${b.po}`, status: "accepted", shipDate: day(30) } }));
    }
    if (u.host === "api.global.example" && u.pathname === "/v2/status") {
      if (r.headers["x-api-key"] !== "G-ORDERS-7777") return res(401, "");
      return res(200, JSON.stringify({ orders: state.statusRows }));
    }
    if (u.host === "van.example") {
      if (r.headers.authorization !== "Bearer VAN-TOKEN-9999") return res(401, "");
      if (u.pathname === "/send") return res(202, '{"ok":true}');
      if (u.pathname === "/inbox") return res(200, JSON.stringify({ documents: state.vanInbox }));
      if (u.pathname === "/ack") { state.acked.push((JSON.parse(r.body) as { id: string }).id); return res(200, "{}"); }
    }
    return res(404, "");
  };
  return { log, state, env: (dropDir: string | null): edi.EdiEnv => ({ fetch, secret: () => "", sleep: async () => {}, resolve: async () => ["93.184.216.34"], secretKey: KEY, dropDir }) };
}

/** A file as the vendor would send it to us. */
function fromVendor(them: { qual: string; id: string }, usage: "T" | "P", ctl: number, sets: x12.TxSet[], sep = x12.DEFAULT_SEPARATORS) {
  return x12.writeInterchange({ sender: them, receiver: OURS, gsSender: them.id, gsReceiver: OURS.id, version: "004010", usage, isaControl: ctl, gsControl: ctl }, sets, sep, { newline: true });
}

export async function run(t: T) {
  // ================================================================ X12 engine
  const env0: x12.Envelope = { sender: OURS, receiver: COASTER_ID, gsSender: OURS.id, gsReceiver: COASTER_ID.id, version: "004010", usage: "T", isaControl: 42, gsControl: 7,
    at: new Date("2026-11-10T15:04:00Z") };
  const po850: x12.Po850 = { poNumber: "PO-000123", date: "2026-11-10", purpose: "00", orderType: "SA", vendorAccount: "A-77", requestedOn: "2026-12-01",
    shipTo: { code: "DC1", name: "Distribution center", address1: "1 Dock Rd", city: "Riverside", state: "PA", postal: "00125" },
    lines: [{ line: 1, qty: 2, uom: "EA", unitMinor: 19000n, vendorSku: "121221", ourSku: "COA-121221", upc: "0123", description: "Dining table *oak~", options: ["FIN-OAK"], customerOrder: "SO-1" },
      { line: 2, qty: 4, unitMinor: 8250n, vendorSku: "121222", description: "Side chair" }] };
  const text850 = x12.writeInterchange(env0, [{ type: "850", control: 1, segments: x12.build850(po850) }]);
  const ix850 = x12.parseInterchange(text850);
  const back850 = x12.parse850(ix850.groups[0].sets[0].segments);
  t.ok("X12: the ISA is the fixed 106 characters and the envelope carries the control numbers", text850.indexOf("~") === 105 && ix850.control === "000000042" && ix850.groups[0].control === "7"
    && ix850.errors.length === 0 && ix850.groups[0].errors.length === 0 && ix850.groups[0].sets[0].errors.length === 0, JSON.stringify(ix850.errors));
  t.ok("X12 850: round trip (number, ship-to, lines, ids, price, options, customer order) and separators inside values are cleaned",
    back850.poNumber === "PO-000123" && back850.shipTo.code === "DC1" && back850.shipTo.postal === "00125" && back850.lines.length === 2 && back850.lines[0].vendorSku === "121221"
    && back850.lines[0].ourSku === "COA-121221" && back850.lines[0].unitMinor === 19000n && back850.lines[1].unitMinor === 8250n && back850.lines[0].options?.[0] === "FIN-OAK"
    && back850.lines[0].customerOrder === "SO-1" && back850.lines[0].description === "Dining table oak" && back850.requestedOn === "2026-12-01" && !back850.errors.length, JSON.stringify(x12.summaryOf(back850.lines[0])));
  const rt = <V>(type: string, segs: x12.Segment[], parse: (s: x12.Segment[]) => V) => {
    const ix = x12.parseInterchange(x12.writeInterchange(env0, [{ type, control: 5, segments: segs }]));
    return { v: parse(ix.groups[0].sets[0].segments), ix };
  };
  const a855 = rt("855", x12.build855({ poNumber: "PO-1", ackType: "AC", date: "2026-11-11", vendorRef: "SO-998", shipDate: "2026-12-02",
    lines: [{ line: 1, status: "IA", qty: 2, date: "2026-12-02" }, { line: 2, status: "IB", qty: 4, date: "2027-01-15" }, { vendorSku: "X9", status: "IR" }] }), x12.parse855);
  t.ok("X12 855: round trip, line codes read as accept / backorder / reject with their dates", a855.v.poNumber === "PO-1" && a855.v.vendorRef === "SO-998" && a855.v.lines[1].status === "backorder"
    && a855.v.lines[1].date === "2027-01-15" && a855.v.lines[2].status === "reject" && a855.v.lines[2].vendorSku === "X9" && a855.ix.groups[0].functionalId === "PR" && !a855.v.errors.length, JSON.stringify(a855.v));
  const a856 = rt("856", x12.build856({ shipmentId: "ASN-1", date: "2026-11-12", shippedOn: "2026-11-12", deliveryOn: "2026-11-20", carrier: "ODFL", carrierName: "Old Dominion", tracking: "PRO-55", bol: "BOL-1",
    orders: [{ poNumber: "PO-1", lines: [{ line: 1, qty: 2 }, { vendorSku: "121222", qty: 3 }] }, { poNumber: "PO-2", lines: [{ line: 1, qty: 1 }] }] }), x12.parse856);
  t.ok("X12 856: round trip with hierarchy (shipment, two orders, items), carrier, tracking and dates", a856.v.orders.length === 2 && a856.v.orders[0].lines[1].vendorSku === "121222"
    && a856.v.orders[0].lines[1].qty === 3 && a856.v.carrier === "ODFL" && a856.v.carrierName === "Old Dominion" && a856.v.tracking === "PRO-55" && a856.v.deliveryOn === "2026-11-20" && !a856.v.errors.length);
  const a810 = rt("810", x12.build810({ invoiceNumber: "INV-9", invoiceDate: "2026-11-15", poNumber: "PO-1", lines: [{ line: 1, qty: 2, unitMinor: 19000n, vendorSku: "121221" }],
    charges: [{ code: "D240", description: "Freight", amountMinor: 2500n }], totalMinor: 40500n, termsDays: 30 }), x12.parse810);
  t.ok("X12 810: round trip with a freight charge, terms and a total that adds up", a810.v.invoiceNumber === "INV-9" && a810.v.totalMinor === 40500n && a810.v.charges[0].amountMinor === 2500n
    && a810.v.termsDays === 30 && !a810.v.errors.length);
  const bad810 = x12.parse810(x12.build810({ invoiceNumber: "INV-9", invoiceDate: "2026-11-15", poNumber: "PO-1", lines: [{ line: 1, qty: 2, unitMinor: 19000n }], charges: [], totalMinor: 99n }));
  t.ok("X12 810: a total that is not the sum of the lines is a problem, in words", bad810.errors.some((e) => /not the sum of its lines/.test(e)));
  const a832 = rt("832", x12.build832({ catalogId: "CAT-1", date: "2026-11-01", items: [{ vendorSku: "121221", upc: "0123", description: "Oak table", costMinor: 19900n, msrpMinor: 49900n,
    effectiveOn: "2026-11-01", heightIn: 30, widthIn: 60, depthIn: 36, weightLb: 80 }] }), x12.parse832);
  t.ok("X12 832: round trip of cost, MSRP, description, dimensions (cube worked out from them) and weight", a832.v.items[0].costMinor === 19900n && a832.v.items[0].msrpMinor === 49900n
    && a832.v.items[0].description === "Oak table" && a832.v.items[0].cubicFt === 37.5 && a832.v.items[0].weightLb === 80 && !a832.v.errors.length, JSON.stringify(x12.summaryOf(a832.v.items[0])));
  const a846 = rt("846", x12.build846({ reference: "INV-ADV-1", date: "2026-11-10", items: [{ vendorSku: "121221", qty: 14 }, { vendorSku: "121222", qty: 0, availableOn: "2026-12-20" }] }), x12.parse846);
  t.ok("X12 846: round trip of quantities and an availability date", a846.v.items[0].qty === 14 && a846.v.items[1].availableOn === "2026-12-20" && !a846.v.errors.length);
  const a997 = rt("997", x12.build997({ functionalId: "PO", groupControl: "7", sets: [{ type: "850", control: "0001", accepted: true }, { type: "850", control: "0002", accepted: false, notes: ["bad item"] }],
    status: "P", included: 2, received: 2, accepted: 1 }), x12.parse997);
  t.ok("X12 997: round trip, per-set accept and reject with a valid AK5 code (no AK3/AK4 with blank required elements)", a997.v.groupControl === "7" && a997.v.sets[0].accepted && !a997.v.sets[1].accepted
    && a997.v.sets[1].code === "5" && a997.v.sets[1].notes?.[0] === "one or more segments in error" && !a997.ix.groups[0].sets[0].segments.some((x) => x[0] === "AK3" || x[0] === "AK4")
    && a997.v.status === "P" && a997.v.accepted === 1 && a997.ix.groups[0].functionalId === "FA");
  const odd: x12.Separators = { element: "|", segment: "\n", sub: ":", repetition: "^" };
  const odd5010 = x12.writeInterchange({ ...env0, version: "005010" }, [{ type: "846", control: 9, segments: x12.build846({ reference: "R", date: null, items: [{ vendorSku: "A1", qty: 1 }] }) }], odd);
  const dsep = x12.detectSeparators(odd5010);
  t.ok("X12: separators are read from the ISA (element |, segment newline, sub-element :, 5010 repetition ^)", dsep.element === "|" && dsep.segment === "\n" && dsep.sub === ":" && dsep.repetition === "^"
    && x12.parse846(x12.parseInterchange(odd5010).groups[0].sets[0].segments).items[0].vendorSku === "A1");
  const broken = text850.replace(/SE\*(\d+)\*0001/, "SE*99*0001").replace(/IEA\*1\*/, "IEA*2*");
  const bix = x12.parseInterchange(broken);
  t.ok("X12: wrong counts are found at each level (SE01, IEA01)", bix.groups[0].sets[0].errors.some((e) => /SE01 says 99/.test(e)) && bix.errors.some((e) => /IEA01 says 2/.test(e)));
  await t.throws("X12: a file that is not X12 is refused in words", async () => x12.parseInterchange("hello, this is a CSV"), /not an X12 file/);
  t.ok("X12: money reads exactly (half-up past the cent) and writes with two decimals", x12.toMinor("289.505") === 28951n && x12.toMinor("12") === 1200n && x12.toMinor("x") === null && x12.fromMinor(5n) === "0.05");

  // ================================================================ partners
  const net = fakeNet();
  const drop = await mkdtemp(join(tmpdir(), "erp-edi-"));
  const env = net.env(drop);
  useEdiEnv(() => env);
  const r = routes(t, ediModule);
  type Doc = { id: string; type: string; status: string; reason: string | null };

  // Ashley already has API feeds for catalog, prices, quantities, freight, orders and status: a new partner defaults to the API for those.
  const ashley = await r.post<{ id: string }>("/edi/partners", BUYER, { partner: { vendor_id: V.ASHLEY, our_isa_id: OURS.id, their_isa_qual: "12", their_isa_id: "6162242000",
    transport: "sftp", transport_config: { host: "sftp.ashleyfurniture.example", user: "riverside", port: "22", inFolder: "/out", outFolder: "/in" } }, secrets: { sftpPassword: "Sftp-Secret-4411" } });
  const ashP = await read(t, (c) => edi.loadPartner(c, ENTITY, ashley.id));
  t.ok("partners: channels default to the vendor's API where a feed exists (orders, status, catalog/price, ATP, freight) and EDI for the invoice",
    ashP.documents["850"] === "api" && ashP.documents["855"] === "api" && ashP.documents["856"] === "api" && ashP.documents["832"] === "api" && ashP.documents["846"] === "api"
    && ashP.documents.freight === "api" && ashP.documents["810"] === "edi", JSON.stringify(ashP.documents));
  await r.post("/edi/partners", BUYER, { partner: { vendor_id: V.ASHLEY, edi_enabled: true, their_isa_id: "6162242000", documents: { "850": "edi", "855": "edi", "856": "edi" } } });
  const ashP2 = await read(t, (c) => edi.loadPartner(c, ENTITY, ashley.id));
  t.ok("partners: one vendor mixes channels: EDI for 850/855/856/810, the API for catalog, price, quantities and freight",
    ashP2.edi_enabled && ashP2.documents["850"] === "edi" && ashP2.documents["810"] === "edi" && ashP2.documents["832"] === "api" && ashP2.documents.freight === "api");
  const buyerScope = await asPerson(t, BUYER, async (_c, co, a) => scopeOf(co, a));
  const runAs = (fn: (c: Client) => Promise<unknown>) => tx(buyerScope.actor, fn);
  const sftp = await edi.pollPartner(runAs as edi.TxRun, buyerScope, env, ashley.id);
  t.ok("SFTP: settings and password are kept, and polling says plainly it is not built", !sftp.ok && /SFTP is not built into this version/.test(sftp.note), sftp.note);
  await t.throws("partners: a secret in the transport settings is refused", () => r.post("/edi/partners", BUYER, { partner: { vendor_id: V.ASHLEY, transport_config: { host: "h", user: "u", password: "x" } } }), /may not hold password/);
  await t.throws("partners: a channel a document cannot use is refused", () => r.post("/edi/partners", BUYER, { partner: { vendor_id: V.ASHLEY, documents: { "810": "api" } } }), /goes by edi, email, file, off/);
  await t.throws("partners: EDI cannot be switched on without both ISA ids", () => r.post("/edi/partners", BUYER, { partner: { vendor_id: V.COASTER, edi_enabled: true } }), /give our ISA id and theirs/);
  await t.throws("roles: an A/P clerk cannot set up a trading partner", () => r.post("/edi/partners", PEOPLE.CLERK, { partner: { vendor_id: V.COASTER } }), /needs one of: buyer/);

  // Coaster: everything by EDI through a drop folder, in production.
  const coaster = await r.post<{ id: string }>("/edi/partners", BUYER, { partner: { vendor_id: V.COASTER, edi_enabled: true, our_isa_id: OURS.id, their_isa_qual: COASTER_ID.qual,
    their_isa_id: COASTER_ID.id, usage: "P", transport: "dropfolder", transport_config: { folder: "coaster" }, documents: { "832": "edi", "855": "edi", "856": "edi", "810": "edi", "850": "edi" } } });
  const coP = await read(t, (c) => edi.loadPartner(c, ENTITY, coaster.id));
  t.ok("partners: Coaster's stock-file feed makes its 846 default to the API; the rest are EDI as asked", coP.documents["846"] === "api" && coP.documents["850"] === "edi" && coP.usage === "P");
  await asPerson(t, BUYER, (c, co, a) => edi.saveItemMap(c, scopeOf(co, a), coaster.id, [{ vendorItem: "CO-LAMP-X", sku: "ACC-LAMP-01" }]));
  await t.throws("item map: a product from another vendor is refused", () => r.post("/edi/partners/:id/items", BUYER, { items: [{ vendorItem: "Z", sku: "ASH-2930338" }] }, coaster.id), /not bought from Coaster/);

  // ================================================================ 850 out
  const stockPo = await asPerson(t, BUYER, (c, co, a) => pur.createPO(c, scopeOf(co, a), { vendorId: V.COASTER, shipToId: DC, lines: [{ productId: P.TABLE, qty: 2 }, { productId: P.CHAIRS, qty: 4 }] }, false));
  const sent = await r.post<{ channel: string; status: string; documentId: string; detail: string }>("/edi/pos/:id/send", BUYER, {}, stockPo.poId);
  const outFiles = await readdir(join(drop, ENTITY, "coaster", "out"));
  const outText = outFiles.length ? await readFile(join(drop, ENTITY, "coaster", "out", outFiles[0]), "utf8") : "";
  const outIx = outText ? x12.parseInterchange(outText) : null;
  const out850 = outIx ? x12.parse850(outIx.groups[0].sets[0].segments) : null;
  t.ok("850: a real PO goes by the partner's channel (EDI) into the drop folder", sent.channel === "edi" && sent.status === "sent" && outFiles.length === 1, JSON.stringify(sent));
  t.ok("850: generated from the PO: number, our ISA ids, ship-to, vendor models, our SKUs, quantities and cost", !!out850 && out850.poNumber === stockPo.number && outIx!.sender.id === OURS.id
    && outIx!.receiver.id === COASTER_ID.id && outIx!.usage === "P" && out850.shipTo.code === "DC1" && out850.lines[0].vendorSku === "121221" && out850.lines[0].ourSku === "COA-121221"
    && out850.lines[1].qty === 4 && out850.lines[0].unitMinor === 19000n && !outIx!.errors.length, JSON.stringify(out850?.lines?.[0] ? x12.summaryOf(out850.lines[0]) : null));
  const poSent = await read(t, async (c) => (await q<{ exported_at: string | null; m: string }>(c, `select po.exported_at, (select method from po_transmission t where t.entity_id = po.entity_id and t.purchase_order_id = po.id order by sent_at desc limit 1) m
    from purchase_order po where po.id = $1 and po.entity_id = $2`, [stockPo.poId, ENTITY]))[0]);
  t.ok("850: the PO shows sent, logged as an EDI send", !!poSent.exported_at && poSent.m === "edi");
  await t.throws("roles: a salesperson cannot send a PO", () => r.post("/edi/pos/:id/send", SALES, {}, stockPo.poId), /needs one of: buyer/);

  // ================================================================ 997 in for our 850
  const our = await read(t, async (c) => (await q<{ gs_control: string; st_control: string }>(c, `select gs_control, st_control from edi_document where id = $1 and entity_id = $2`, [sent.documentId, ENTITY]))[0]);
  const ack997 = fromVendor(COASTER_ID, "P", 501, [{ type: "997", control: 1, segments: x12.build997({ functionalId: "PO", groupControl: our.gs_control,
    sets: [{ type: "850", control: our.st_control, accepted: true }], status: "A", included: 1, received: 1, accepted: 1 }) }]);
  const got997 = await r.post<edi.Received>("/edi/upload", BUYER, { text: ack997, filename: "997.edi" });
  const st850 = await read(t, async (c) => (await q<{ status: string }>(c, `select status from edi_document where id = $1 and entity_id = $2`, [sent.documentId, ENTITY]))[0].status);
  t.ok("997 in: the vendor's functional ack marks our 850 acknowledged, and no 997 answers a 997", got997.documents[0]?.status === "applied" && st850 === "acknowledged" && got997.acks.length === 0,
    JSON.stringify(got997.documents));

  // ================================================================ 855 → the customer's special order
  // A customer's line waiting on Coaster (the sample activity leaves lamps on order).
  const LAMP_LINE = (await read(t, (c) => pur.specialOrderQueue(c, ENTITY))).find((x) => x.vendor_id === V.COASTER && x.product_id === P.LAMP)?.sales_line_id ?? "";
  t.ok("setup: a customer's lamp is waiting on a Coaster PO", !!LAMP_LINE);
  const special = await asPerson(t, STORE_MGR, (c, co, a) => pur.placeSpecialOrders(c, scopeOf(co, a), [LAMP_LINE]));
  const spPo = special[0];
  const salesOrder = await read(t, async (c) => (await q<{ id: string }>(c, `select sales_order_id id from sales_order_line where id = $1 and entity_id = $2`, [LAMP_LINE, ENTITY]))[0].id);
  const ack855 = fromVendor(COASTER_ID, "P", 502, [{ type: "855", control: 1, segments: x12.build855({ poNumber: spPo.number, ackType: "AC", date: day(0), vendorRef: "COA-SO-1",
    lines: [{ vendorSku: "CO-LAMP-X", status: "IB", qty: 1, date: day(40) }] }) }]);
  await t.throws("roles: an A/P clerk takes bills, not acknowledgments", () => r.post("/edi/upload", PEOPLE.CLERK, { text: ack855, filename: "855.edi" }), /taking in a 855 .* needs one of: buyer/);
  await t.throws("roles: a store manager cannot take in acknowledgments either (a reject cancels the PO)", () => r.post("/edi/upload", STORE_MGR, { text: ack855, filename: "855.edi" }), /needs one of: buyer/);
  const got855 = await r.post<edi.Received>("/edi/upload", BUYER, { text: ack855, filename: "855.edi" });
  const eta = await read(t, (c) => pur.etaForOrder(c, ENTITY, salesOrder));
  const lampEta = eta.find((x) => x.sales_order_line_id === LAMP_LINE);
  t.ok("855 in: applied through acknowledgePO; the vendor's mapped item finds the line; the backorder date reaches the customer's order",
    got855.documents[0]?.status === "applied" && lampEta?.ack_status === "backordered" && lampEta?.expected_on === day(40), JSON.stringify({ d: got855.documents, lampEta }));
  const ack997Out = await read(t, async (c) => (await q<{ status: string; raw: string; related_id: string }>(c,
    `select status, raw, related_id from edi_document where entity_id = $1 and direction = 'out' and doc_type = '997' and related_id = $2`, [ENTITY, got855.documents[0].id]))[0]);
  const ack997Parsed = ack997Out ? x12.parse997(x12.parseInterchange(ack997Out.raw).groups[0].sets[0].segments) : null;
  t.ok("997 out: every inbound group is answered, accepted, and dropped in the partner's out folder; no AK3/AK4 with blank required elements",
    got855.acks.length === 1 && ack997Out?.status === "sent" && ack997Parsed?.functionalId === "PR" && ack997Parsed?.status === "A" && ack997Parsed?.sets[0]?.accepted === true
    && !/AK3|AK4/.test(ack997Out?.raw ?? "") && /AK5\*A~/.test(ack997Out?.raw ?? ""));
  const dup = await r.post<edi.Received>("/edi/upload", BUYER, { text: ack855, filename: "855-again.edi" });
  t.ok("duplicates: the same control numbers again are logged as ignored and not applied twice", dup.documents[0]?.status === "ignored" && /repeat/.test(dup.documents[0]?.reason ?? ""), JSON.stringify(dup.documents));

  // ================================================================ 856 → in transit
  const asn = fromVendor(COASTER_ID, "P", 503, [{ type: "856", control: 1, segments: x12.build856({ shipmentId: "COA-ASN-77", date: day(0), shippedOn: day(0), deliveryOn: day(9),
    carrier: "RLCA", carrierName: "R+L Carriers", tracking: "RL-445566", orders: [{ poNumber: stockPo.number, lines: [{ line: 1, qty: 2 }, { vendorSku: "121222", qty: 4 }] }] }) }]);
  const got856 = await r.post<edi.Received>("/edi/upload", BUYER, { text: asn, filename: "856.edi" });
  const ship = await read(t, async (c) => q<{ in_transit_qty: string; carrier: string; tracking: string }>(c,
    `select in_transit_qty, carrier, tracking from po_line_shipping where entity_id = $1 and purchase_order_id = $2`, [ENTITY, stockPo.poId]));
  const expected = (await read(t, (c) => openPurchaseOrders(c, ENTITY))).filter((x) => x.po_id === stockPo.poId);
  t.ok("856 in: lines marked shipped and in transit with carrier and tracking", got856.documents[0]?.status === "applied" && ship.length === 2
    && ship.every((x) => Number(x.in_transit_qty) > 0 && x.carrier === "R+L Carriers" && x.tracking === "RL-445566"), JSON.stringify({ d: got856.documents, ship }));
  t.ok("856 in: expected receipts move to the delivery date the notice gives", expected.length === 2 && expected.every((x) => x.expected_on === day(9)), JSON.stringify(expected.map((x) => x.expected_on)));
  const overship = fromVendor(COASTER_ID, "P", 504, [{ type: "856", control: 1, segments: x12.build856({ shipmentId: "COA-ASN-78", date: day(0), orders: [{ poNumber: stockPo.number, lines: [{ line: 1, qty: 1 }] }] }) }]);
  const gotOver = await r.post<edi.Received>("/edi/upload", BUYER, { text: overship, filename: "856b.edi" });
  t.ok("856 in: shipping more than is left on order is quarantined with the reason", gotOver.documents[0]?.status === "quarantined" && /only 0 are left on order/.test(gotOver.documents[0]?.reason ?? ""), gotOver.documents[0]?.reason ?? "");

  // ================================================================ receive, then 810 → bill, three-way match
  const lines = await read(t, async (c) => q<{ id: string; seq: number }>(c, `select id, seq from purchase_order_line where entity_id = $1 and purchase_order_id = $2 order by seq`, [ENTITY, stockPo.poId]));
  await asPerson(t, PEOPLE.STEVE, (c, co, a) => receivePurchaseOrder(c, scopeOf(co, a), { purchaseOrderId: stockPo.poId, locationId: DC, lines: [{ poLineId: lines[0].id, qty: 2 }, { poLineId: lines[1].id, qty: 4 }] }));
  await asPerson(t, BUYER, (c, co, a) => pur.addLandedCost(c, scopeOf(co, a), stockPo.poId, { kind: "freight", amountMinor: 2500n, basis: "value", note: "R+L quote" }));
  const inv = fromVendor(COASTER_ID, "P", 505, [{ type: "810", control: 1, segments: x12.build810({ invoiceNumber: `COA-INV-${stockPo.number}`, invoiceDate: day(0), poNumber: stockPo.number,
    lines: [{ line: 1, qty: 2, unitMinor: 19000n, vendorSku: "121221" }, { line: 2, qty: 4, unitMinor: 8200n, vendorSku: "121222" }], charges: [{ code: "D240", description: "Freight", amountMinor: 2500n }],
    totalMinor: 73300n, termsDays: 30 }) }]);
  const got810 = await r.post<edi.Received>("/edi/upload", PEOPLE.CLERK, { text: inv, filename: "810.edi" });
  const bill = await read(t, async (c) => (await q<{ id: string; status: string; total_minor: string; kind: string; purchase_order_id: string; lines: string; match: string | null }>(c, `
    select i.id, i.status, i.total_minor, i.kind, i.purchase_order_id, (select count(*) from invoice_line l where l.invoice_id = i.id) lines,
           (select reason from audit_event e where e.entity_id = i.entity_id and e.table_name = 'invoice' and e.row_id = i.id::text and e.after->>'status' = 'matched' limit 1) match
      from invoice i join edi_document d on d.invoice_id = i.id where d.id = $1 and d.entity_id = $2`, [got810.documents[0]?.id, ENTITY]))[0]);
  t.ok("810 in: a merchandise bill against the PO in payables, lines plus freight, total as sent", got810.documents[0]?.status === "applied" && bill?.kind === "merchandise"
    && bill?.purchase_order_id === stockPo.poId && bill?.total_minor === "73300" && Number(bill?.lines) === 3, JSON.stringify({ d: got810.documents, bill }));
  t.ok("810 in: the three-way match runs and is clean (ordered, received, billed)", bill?.match === "three-way match clean" && ["approved", "pending"].includes(bill?.status ?? ""), JSON.stringify(bill));
  const inv2 = inv.replace(/000000505/g, "000000506").replace(/\*505\*/g, "*506*").replace(/GS\*IN\*COASTERUSA\*BUDDYSHF\*(\d+)\*(\d+)\*505/, "GS*IN*COASTERUSA*BUDDYSHF*$1*$2*506").replace(/GE\*1\*505/, "GE*1*506");
  const gotAgain = await r.post<edi.Received>("/edi/upload", PEOPLE.CLERK, { text: inv2, filename: "810-resent.edi" });
  t.ok("810 in: the same bill number again under new control numbers is quarantined, not billed twice", gotAgain.documents[0]?.status === "quarantined" && /already has a bill numbered/.test(gotAgain.documents[0]?.reason ?? ""),
    JSON.stringify(gotAgain.documents));

  // ================================================================ the match, for every merchandise bill
  const billOf = (docId: string) => read(t, async (c) => (await q<{ status: string; total_minor: string; created_by: string; maker: string; reason: string | null }>(c, `
    select i.status, i.total_minor, i.created_by, u.email maker,
           (select e.reason from audit_event e where e.entity_id = i.entity_id and e.table_name = 'invoice' and e.row_id = i.id::text and e.after->>'status' = 'exception' limit 1) reason
      from invoice i join edi_document d on d.invoice_id = i.id left join app_user u on u.id = i.created_by where d.id = $1 and d.entity_id = $2`, [docId, ENTITY]))[0]);
  const again810 = fromVendor(COASTER_ID, "P", 520, [{ type: "810", control: 1, segments: x12.build810({ invoiceNumber: `COA-INV-${stockPo.number}-B`, invoiceDate: day(0), poNumber: stockPo.number,
    lines: [{ line: 1, qty: 2, unitMinor: 19000n, vendorSku: "121221" }], charges: [], totalMinor: 38000n }) }]);
  const gotTwice = await r.post<edi.Received>("/edi/upload", PEOPLE.CLERK, { text: again810, filename: "810-twice.edi" });
  const twice = await billOf(gotTwice.documents[0].id);
  t.ok("match: billing a line again past what was received less what was billed is an exception", twice?.status === "exception" && /invoiced but not received: .*billed before 2/.test(twice?.reason ?? ""), JSON.stringify(twice));
  const one = await asPerson(t, BUYER, (c, co, a) => pur.createPO(c, scopeOf(co, a), { vendorId: V.COASTER, shipToId: DC, lines: [{ productId: P.TABLE, qty: 1 }, { productId: P.CHAIRS, qty: 1 }] }, false));
  const oneLines = await read(t, async (c) => q<{ id: string; seq: number; unit: string }>(c, `select id, seq, unit_price_minor::text unit from purchase_order_line where entity_id = $1 and purchase_order_id = $2 order by seq`, [ENTITY, one.poId]));
  await asPerson(t, PEOPLE.STEVE, (c, co, a) => receivePurchaseOrder(c, scopeOf(co, a), { purchaseOrderId: one.poId, locationId: DC, lines: oneLines.map((l) => ({ poLineId: l.id, qty: 1 })) }));
  const sysScope = { tenantId: buyerScope.tenantId, entityId: ENTITY, actor: { kind: "system" as const, label: "scheduler" } };
  const over = fromVendor(COASTER_ID, "P", 521, [{ type: "810", control: 1, segments: x12.build810({ invoiceNumber: "COA-OVER-1", invoiceDate: day(0), poNumber: one.number,
    lines: [{ line: 1, qty: 1, unitMinor: 45000n, vendorSku: "121221" }], charges: [{ code: "D240", description: "Freight", amountMinor: 30000n }], totalMinor: 75000n }) }]);
  const gotOverBill = await tx(sysScope.actor, (c) => edi.receiveFile(c, sysScope, env, { text: over, filename: "over.edi" }));
  const overBill = await billOf(gotOverBill.documents[0].id);
  t.ok("match: an 810 at more than the PO price, with freight the PO does not expect, is an exception with both reasons, never approved or posted",
    overBill?.status === "exception" && /billed at \$450\.00 each against \$\d+\.\d\d on the purchase order/.test(overBill?.reason ?? "") && /charges of \$300\.00 are more than the purchase order expects/.test(overBill?.reason ?? ""),
    JSON.stringify(overBill));
  t.ok("maker: a bill the scheduler brought in is entered by the client's EDI intake user, so any real approver may approve it", overBill?.maker === "edi-intake@system.invalid");
  const alw = fromVendor(COASTER_ID, "P", 522, [{ type: "810", control: 1, segments: x12.build810({ invoiceNumber: "COA-ALW-1", invoiceDate: day(0), poNumber: one.number,
    lines: [{ line: 2, qty: 1, unitMinor: BigInt(oneLines[1].unit), vendorSku: "121222" }], charges: [{ code: "C310", description: "Discount", amountMinor: -400n }], totalMinor: BigInt(oneLines[1].unit) - 400n }) }]);
  const gotAlw = await r.post<edi.Received>("/edi/upload", PEOPLE.CLERK, { text: alw, filename: "alw.edi" });
  const alwBill = await billOf(gotAlw.documents[0].id);
  t.ok("810 in: an allowance (SAC*A) takes the total down and the bill still matches", gotAlw.documents[0]?.status === "applied" && alwBill?.total_minor === String(BigInt(oneLines[1].unit) - 400n)
    && ["approved", "pending"].includes(alwBill?.status ?? ""), JSON.stringify({ d: gotAlw.documents, alwBill }));

  // ================================================================ lines must agree; split and repriced 855 lines
  const two = await asPerson(t, BUYER, (c, co, a) => pur.createPO(c, scopeOf(co, a), { vendorId: V.COASTER, shipToId: DC, lines: [{ productId: P.CHAIRS, qty: 4 }, { productId: P.TABLE, qty: 1 }] }, false));
  const wrongLine = fromVendor(COASTER_ID, "P", 523, [{ type: "856", control: 1, segments: x12.build856({ shipmentId: "COA-ASN-X", date: day(0), orders: [{ poNumber: two.number, lines: [{ line: 1, vendorSku: "121221", qty: 1 }] }] }) }]);
  const gotWrong = await r.post<edi.Received>("/edi/upload", BUYER, { text: wrongLine, filename: "wrong.edi" });
  t.ok("lines: an 856 whose line number points at another product than its item is quarantined, not shipped on the wrong line",
    gotWrong.documents[0]?.status === "quarantined" && /line number and the item disagree/.test(gotWrong.documents[0]?.reason ?? ""), gotWrong.documents[0]?.reason ?? "");
  const split = fromVendor(COASTER_ID, "P", 524, [{ type: "855", control: 1, segments: [["BAK", "00", "AC", two.number, day(0).replace(/-/g, "")],
    ["PO1", "1", "4", "EA", "82.00", "PE", "VN", "121222"], ["ACK", "IA", "2", "EA", "068", day(10).replace(/-/g, "")], ["ACK", "IB", "2", "EA", "068", day(30).replace(/-/g, "")],
    ["PO1", "2", "1", "EA", "205.00", "PE", "VN", "121221"], ["ACK", "IP", "1", "EA"], ["CTT", "2"]] }]);
  const gotSplit = await r.post<edi.Received>("/edi/upload", BUYER, { text: split, filename: "split.edi" });
  const twoLines = await read(t, async (c) => q<{ seq: number; ack_status: string; expected_on: string; unit_price_minor: string; price_review_note: string | null; price_changed_from: string | null }>(c,
    `select seq, ack_status, expected_on::text, unit_price_minor::text, price_review_note, price_changed_from::text from purchase_order_line where entity_id = $1 and purchase_order_id = $2 order by seq`, [ENTITY, two.poId]));
  t.ok("855 in: one PO1 split into 2 accepted + 2 backordered is one backordered line due when its last part is", gotSplit.documents[0]?.status === "applied"
    && twoLines[0].ack_status === "backordered" && twoLines[0].expected_on === day(30), JSON.stringify({ d: gotSplit.documents, l: twoLines[0] }));
  t.ok("855 in: an IP price change changes the PO line's price, keeps the old one and flags it for the buyer", twoLines[1].unit_price_minor === "20500" && !!twoLines[1].price_review_note
    && twoLines[1].price_changed_from !== null && twoLines[1].price_changed_from !== "20500", JSON.stringify(twoLines[1]));
  const lineId2 = await read(t, async (c) => (await q<{ id: string }>(c, `select id from purchase_order_line where entity_id = $1 and purchase_order_id = $2 and seq = 2`, [ENTITY, two.poId]))[0].id);
  await r.post("/edi/po-lines/:id/price-reviewed", BUYER, {}, lineId2);
  t.ok("855 in: the buyer marks the price change reviewed", (await read(t, async (c) => (await q<{ n: string | null }>(c, `select price_review_note n from purchase_order_line where id = $1 and entity_id = $2`, [lineId2, ENTITY]))[0].n)) === null);
  const scoped = await asPerson(t, BUYER, (c, co, a) => pur.importAcks(c, scopeOf(co, a), { csv: `po_number,line,status\n${two.number},1,reject\n`, vendorId: V.GLOBAL }));
  t.ok("acks: an import from one vendor's feed cannot answer another vendor's PO", scoped.applied === 0 && /no purchase order/.test(scoped.problems[0]?.message ?? ""));

  // ================================================================ 832 → cost through the price history
  const cat = fromVendor(COASTER_ID, "P", 507, [{ type: "832", control: 1, segments: x12.build832({ catalogId: "COA-2026-11", date: day(0), items: [
    { vendorSku: "121221", description: "Counter-height dining table, oak", costMinor: 19900n, msrpMinor: 59900n, effectiveOn: day(0), heightIn: 36, widthIn: 60, depthIn: 36, weightLb: 95 }] }) }]);
  const before = await read(t, async (c) => (await q<{ name: string }>(c, `select name from product where id = $1 and entity_id = $2`, [P.TABLE, ENTITY]))[0].name);
  const got832 = await r.post<edi.Received>("/edi/upload", BUYER, { text: cat, filename: "832.edi" });
  const tbl = await read(t, async (c) => (await q<{ cost_minor: string; msrp_minor: string | null; description: string | null; name: string; cubic_ft: string | null }>(c,
    `select cost_minor, msrp_minor, description, name, cubic_ft from product where id = $1 and entity_id = $2`, [P.TABLE, ENTITY]))[0]);
  t.ok("832 in: cost and MSRP land through the vendor price history, description and cube through the product import; our name stays",
    got832.documents[0]?.status === "applied" && tbl.cost_minor === "19900" && tbl.msrp_minor === "59900" && tbl.description === "Counter-height dining table, oak" && tbl.name === before
    && Number(tbl.cubic_ft) === 45, JSON.stringify({ d: got832.documents, tbl }));

  // ================================================================ channel respected; re-apply
  const adv = fromVendor(COASTER_ID, "P", 508, [{ type: "846", control: 1, segments: x12.build846({ reference: "ADV-1", date: day(0), items: [{ vendorSku: "121222", qty: 31 }] }) }]);
  const got846 = await r.post<edi.Received>("/edi/upload", BUYER, { text: adv, filename: "846.edi" });
  t.ok("channels: an 846 by EDI while quantities are set to come by the API is quarantined, saying so", got846.documents[0]?.status === "quarantined" && /by its API feed/.test(got846.documents[0]?.reason ?? ""));
  await r.post("/edi/partners", BUYER, { partner: { vendor_id: V.COASTER, documents: { "846": "edi" } } });
  const again846 = await r.post<{ status: string }>("/edi/documents/:id/retry", BUYER, {}, got846.documents[0].id);
  const atp = await read(t, async (c) => (await q<{ qty_available: string }>(c, `select qty_available from vendor_availability where entity_id = $1 and vendor_id = $2 and vendor_sku = '121222'`, [ENTITY, V.COASTER]))[0]);
  t.ok("re-apply: once the channel is EDI the quarantined 846 applies, into vendor availability like the feeds", again846.status === "applied" && Number(atp?.qty_available) === 31, JSON.stringify({ again846, atp }));

  // ================================================================ bad documents
  const nopo = fromVendor(COASTER_ID, "P", 509, [{ type: "855", control: 1, segments: x12.build855({ poNumber: "PO-NOPE", ackType: "AC", date: day(0), lines: [{ line: 1, status: "IA" }] }) }]);
  const gotNo = await r.post<edi.Received>("/edi/upload", BUYER, { text: nopo, filename: "x.edi" });
  t.ok("quarantine: an 855 for a PO we never sent is held with the reason; its 997 still accepts it (a 997 answers syntax, the hold is ours)",
    gotNo.documents[0]?.status === "quarantined" && /no purchase order PO-NOPE/.test(gotNo.documents[0]?.reason ?? "")
    && await read(t, async (c) => x12.parse997(x12.parseInterchange((await q<{ raw: string }>(c, `select raw from edi_document where id = $1 and entity_id = $2`, [gotNo.acks[0], ENTITY]))[0].raw).groups[0].sets[0].segments).status === "A"));
  const badCount = fromVendor(COASTER_ID, "P", 510, [{ type: "855", control: 1, segments: x12.build855({ poNumber: spPo.number, ackType: "AC", date: day(0), lines: [{ line: 1, status: "IA" }] }) }]).replace(/SE\*\d+\*0001/, "SE*2*0001");
  const gotBad = await r.post<edi.Received>("/edi/upload", BUYER, { text: badCount, filename: "bad.edi" });
  const lampAfter = (await read(t, (c) => pur.etaForOrder(c, ENTITY, salesOrder))).find((x) => x.sales_order_line_id === LAMP_LINE);
  const bad997 = await read(t, async (c) => x12.parse997(x12.parseInterchange((await q<{ raw: string }>(c, `select raw from edi_document where id = $1 and entity_id = $2`, [gotBad.acks[0], ENTITY]))[0].raw).groups[0].sets[0].segments));
  t.ok("quarantine: a set whose SE count is wrong is held and nothing from it is applied; its 997 rejects it with AK5 code 4, valid on its own",
    gotBad.documents[0]?.status === "quarantined" && /SE01 says 2/.test(gotBad.documents[0]?.reason ?? "") && lampAfter?.ack_status === "backordered"
    && bad997.status === "R" && bad997.sets[0]?.code === "4" && !bad997.errors.length, gotBad.documents[0]?.reason ?? "");
  const junk = await r.post<edi.Received>("/edi/upload", BUYER, { text: "PO,LINE,QTY\nPO-1,1,2\n", filename: "notx12.csv" });
  t.ok("quarantine: a file that is not X12 is kept with the reason", junk.documents[0]?.status === "quarantined" && /not an X12 file/.test(junk.documents[0]?.reason ?? ""));
  const testFile = fromVendor(COASTER_ID, "T", 511, [{ type: "846", control: 1, segments: x12.build846({ reference: "ADV-T", date: day(0), items: [{ vendorSku: "121222", qty: 999 }] }) }]);
  const gotT = await r.post<edi.Received>("/edi/upload", BUYER, { text: testFile, filename: "t.edi" });
  t.ok("quarantine: a test file to a production partner is held, not applied", gotT.documents[0]?.status === "quarantined" && /test file arrived/.test(gotT.documents[0]?.reason ?? ""));
  const stranger = fromVendor({ qual: "ZZ", id: "NOBODY" }, "P", 1, [{ type: "846", control: 1, segments: x12.build846({ reference: "R", date: null, items: [{ vendorSku: "X", qty: 1 }] }) }]);
  t.ok("quarantine: a sender that is no partner here is held", (await r.post<edi.Received>("/edi/upload", BUYER, { text: stranger })).documents[0]?.status === "quarantined");
  await t.throws("roles: a salesperson cannot upload EDI files", () => r.post("/edi/upload", SALES, { text: adv }), /needs one of: buyer, ap clerk/);

  // ================================================================ the drop folder, polled
  await mkdir(join(drop, ENTITY, "coaster", "in"), { recursive: true });
  // A file in the same folder addressed to another company's ISA id is left alone.
  await writeFile(join(drop, ENTITY, "coaster", "in", "for-someone-else.edi"), x12.writeInterchange({ sender: COASTER_ID, receiver: { qual: "ZZ", id: "SISTERCO" }, gsSender: COASTER_ID.id, gsReceiver: "SISTERCO",
    version: "004010", usage: "P", isaControl: 777, gsControl: 777 }, [{ type: "846", control: 1, segments: x12.build846({ reference: "X", date: null, items: [{ vendorSku: "121221", qty: 1 }] }) }]));
  await writeFile(join(drop, ENTITY, "coaster", "in", "adv-2.edi"), fromVendor(COASTER_ID, "P", 512, [{ type: "846", control: 1, segments: x12.build846({ reference: "ADV-2", date: day(0), items: [{ vendorSku: "121221", qty: 6 }] }) }]));
  const due = await runDueEdi(new Date(), env, { entityId: ENTITY });
  const moved = await readdir(join(drop, ENTITY, "coaster", "in", "done"));
  const stillIn = (await readdir(join(drop, ENTITY, "coaster", "in"))).filter((n) => n.endsWith(".edi"));
  const atp2 = await read(t, async (c) => (await q<{ qty_available: string }>(c, `select qty_available from vendor_availability where entity_id = $1 and vendor_id = $2 and vendor_sku = '121221'`, [ENTITY, V.COASTER]))[0]);
  t.ok("scheduler: the drop folder is polled, the file applied and archived; SFTP records its refusal on its own partner",
    due.find((x) => x.vendor.startsWith("Coaster"))?.ok === true && moved.length === 1 && Number(atp2?.qty_available) === 6
    && stillIn.join() === "for-someone-else.edi" && /1 left for another company/.test(due.find((x) => x.vendor.startsWith("Coaster"))?.note ?? "")
    && due.some((x) => x.vendor.startsWith("Ashley") && !x.ok && /SFTP/.test(x.note)), JSON.stringify(due));

  // ================================================================ VAN + API ordering + order status (Global)
  await asPerson(t, BUYER, async (c, co, a) => {
    const s = scopeOf(co, a);
    await feeds.saveFeed(c, s, { vendor_id: V.GLOBAL, purpose: "orders", name: "Global orders (check)", method: "POST", url: "https://api.global.example/v2/orders", request_format: "json",
      response_format: "json", auth: { mode: "header", headerName: "x-api-key" },
      body_template: '{"po":"{{purchaseOrderNumber}}","shipTo":"{{shipTo}}","items":[{{#lines}}{"model":"{{item.sku}}","qty":{{item.quantity}}},{{/lines}}]}',
      mapping: { vendor_ref: "result.orderNo", ack_status: "result.status", expected_on: "result.shipDate" }, secrets: { apiKey: "G-ORDERS-7777" } }, env);
    const ord = (await q<{ id: string }>(c, `select id from vendor_feed where entity_id = $1 and vendor_id = $2 and name = 'Global orders (check)'`, [ENTITY, V.GLOBAL]))[0];
    await feeds.saveFeed(c, s, { vendor_id: V.GLOBAL, purpose: "acknowledgments", name: "Global order status (check)", method: "GET", url: "https://api.global.example/v2/status",
      response_format: "json", records_path: "orders", auth: { mode: "header", headerName: "x-api-key" }, secrets_from_feed_id: ord.id,
      mapping: { po_number: "po", line: "line", status: "status", qty: "qty", ship_date: "shipDate", vendor_ref: "asn", carrier: "carrier", tracking: "tracking", delivery_date: "eta" } }, env);
  });
  const global = await r.post<{ id: string }>("/edi/partners", BUYER, { partner: { vendor_id: V.GLOBAL, edi_enabled: true, our_isa_id: OURS.id, their_isa_qual: GLOBAL_ID.qual, their_isa_id: GLOBAL_ID.id,
    usage: "T", transport: "van", transport_config: { sendUrl: "https://van.example/send", listUrl: "https://van.example/inbox", ackUrl: "https://van.example/ack", auth: "bearer" } },
    secrets: { vanToken: "VAN-TOKEN-9999" } });
  const glP = await read(t, (c) => edi.loadPartner(c, ENTITY, global.id));
  t.ok("partners: with orders and status feeds, Global's 850, 855 and 856 default to the API while files go by its VAN", glP.documents["850"] === "api" && glP.documents["855"] === "api" && glP.documents["856"] === "api");
  const gPo = await asPerson(t, BUYER, (c, co, a) => pur.createPO(c, scopeOf(co, a), { vendorId: V.GLOBAL, shipToId: DC, lines: [{ productId: P.GLB, qty: 2 }] }, false));
  const apiSend = await r.post<{ channel: string; status: string; documentId: string; detail: string }>("/edi/pos/:id/send", BUYER, {}, gPo.poId);
  const posted = net.log.filter((x) => x.url.endsWith("/v2/orders")).at(-1);
  const gAfter = await read(t, async (c) => (await q<{ vendor_ref: string; acknowledged_on: string | null; expected_on: string }>(c,
    `select vendor_ref, acknowledged_on, expected_on::text from purchase_order where id = $1 and entity_id = $2`, [gPo.poId, ENTITY]))[0]);
  t.ok("API ordering: the PO goes to the vendor's orders feed with its own key, in the vendor's body shape from the template",
    apiSend.channel === "api" && apiSend.status === "sent" && posted?.headers["x-api-key"] === "G-ORDERS-7777" && (JSON.parse(posted!.body) as { items: { model: string; qty: number }[] }).items[0].model === "U8303",
    JSON.stringify({ apiSend, body: posted?.body }));
  t.ok("API ordering: the answer's order number and acknowledgment (status, ship date) map onto the PO", gAfter.vendor_ref === `GL-${gPo.number}` && !!gAfter.acknowledged_on && gAfter.expected_on === day(30), JSON.stringify(gAfter));
  const apiDoc = await read(t, async (c) => (await q<{ channel: string; status: string; raw: string }>(c, `select channel, status, raw from edi_document where id = $1 and entity_id = $2`, [apiSend.documentId, ENTITY]))[0]);
  t.ok("API ordering: logged in the outbox as an API document with the body sent, and no key in it", apiDoc.channel === "api" && apiDoc.status === "sent" && apiDoc.raw.includes(gPo.number) && !apiDoc.raw.includes("G-ORDERS-7777"));
  net.state.statusRows = [{ po: gPo.number, line: 1, status: "shipped", qty: 2, shipDate: day(0), asn: "GASN-1", carrier: "Estes", tracking: "EST-9911", eta: day(6) }];
  const status = await r.post<{ runs: { ok: boolean; note: string }[] }>("/edi/partners/:id/poll-status", BUYER, {}, global.id);
  const gShip = await read(t, async (c) => (await q<{ carrier: string; tracking: string; expected_on: string }>(c, `select carrier, tracking, expected_on::text from po_shipment where entity_id = $1 and purchase_order_id = $2`, [ENTITY, gPo.poId]))[0]);
  t.ok("order status: a 'shipped' row from the vendor's status API becomes a ship notice, as an 856 would", status.runs[0]?.ok && gShip?.carrier === "Estes" && gShip?.tracking === "EST-9911" && gShip?.expected_on === day(6),
    JSON.stringify({ status, gShip }));
  const test850 = await r.post<{ status: string; documentId: string; text: string }>("/edi/partners/:id/test-850", BUYER, {}, global.id);
  const vanSent = net.log.filter((x) => x.url === "https://van.example/send").at(-1);
  const tix = x12.parseInterchange(test850.text);
  t.ok("Send test 850: in test mode (ISA15 T) through the VAN with the partner's token; no PO is marked sent by it", test850.status === "sent" && tix.usage === "T" && !!vanSent && vanSent.body === test850.text);
  net.state.vanInbox = [{ id: "m-1", content: x12.writeInterchange({ sender: GLOBAL_ID, receiver: OURS, gsSender: GLOBAL_ID.id, gsReceiver: OURS.id, version: "004010", usage: "T", isaControl: 900, gsControl: 900 },
    [{ type: "997", control: 1, segments: x12.build997({ functionalId: "PO", groupControl: tix.groups[0].control, sets: [{ type: "850", control: tix.groups[0].sets[0].control, accepted: false, notes: ["unknown ship-to"] }],
      status: "R", included: 1, received: 1, accepted: 0 }) }]) }];
  const polled = await r.post<{ ok: boolean; note: string }>("/edi/partners/:id/poll", BUYER, {}, global.id);
  const tStatus = await read(t, async (c) => (await q<{ status: string; reason: string }>(c, `select status, reason from edi_document where id = $1 and entity_id = $2`, [test850.documentId, ENTITY]))[0]);
  t.ok("VAN: polled for new files; the vendor's 997 rejecting our test 850 marks it rejected with their reason, and the file is acknowledged to the VAN",
    polled.ok && tStatus.status === "rejected" && /rejected it in their 997: one or more segments in error/.test(tStatus.reason) && net.state.acked.includes("m-1"), JSON.stringify({ polled, tStatus }));

  // ================================================================ the 850, laid out per partner
  await r.post("/edi/partners", BUYER, { partner: { vendor_id: V.COASTER, options: { billTo: { name: "Demo Furniture AP", code: "BT-1", address1: "9 Main St", city: "Riverside", state: "PA", postal: "00125" },
    vendorN1: true, td5: { scac: "rlca", method: "M", routing: "R+L Carriers" }, fob: "PP", shipByDays: 14, cancelAfterDays: 45, itemIds: ["VN", "IN"], refs: [], contact: { name: "Ana", phone: "7175550100", email: "ana@example.com" } } } });
  await t.throws("850 layout: an item id the system does not send is refused", () => r.post("/edi/partners", BUYER, { partner: { vendor_id: V.COASTER, options: { itemIds: ["ZZ"] } } }), /not an item id/);
  const three = await asPerson(t, BUYER, (c, co, a) => pur.createPO(c, scopeOf(co, a), { vendorId: V.COASTER, shipToId: DC, lines: [{ productId: P.CHAIRS, qty: 2 }] }, false));
  const s3 = await r.post<{ documentId: string }>("/edi/pos/:id/send", BUYER, {}, three.poId);
  const raw3 = await read(t, async (c) => (await q<{ raw: string }>(c, `select raw from edi_document where id = $1 and entity_id = $2`, [s3.documentId, ENTITY]))[0].raw);
  const p3 = x12.parse850(x12.parseInterchange(raw3).groups[0].sets[0].segments);
  t.ok("850 layout: bill-to, vendor party, TD5 routing, FOB, ship-by and cancel-after, buyer contact and the partner's item ids, without the references it turned off",
    p3.billTo?.name === "Demo Furniture AP" && p3.billTo?.postal === "00125" && !!p3.vendor && p3.td5?.scac === "RLCA" && p3.fob === "PP" && p3.shipBy === day(14) && p3.cancelAfter === day(45)
    && p3.contact?.email === "ana@example.com" && /PO1\*1\*2\*EA\*[\d.]+\*PE\*VN\*121222\*IN\*COA-121222/.test(raw3) && !/\*BP\*/.test(raw3) && !/REF\*IA/.test(raw3), raw3.slice(0, 600));

  // ================================================================ VAN with no acknowledge address
  await r.post("/edi/partners", BUYER, { partner: { vendor_id: V.GLOBAL, transport_config: { sendUrl: "https://van.example/send", listUrl: "https://van.example/inbox", auth: "bearer" } } });
  const docsBefore = await read(t, async (c) => Number((await q<{ n: string }>(c, `select count(*) n from edi_document where entity_id = $1 and partner_id = $2`, [ENTITY, global.id]))[0].n));
  const repoll = await r.post<{ ok: boolean; note: string }>("/edi/partners/:id/poll", BUYER, {}, global.id);
  const docsAfter = await read(t, async (c) => Number((await q<{ n: string }>(c, `select count(*) n from edi_document where entity_id = $1 and partner_id = $2`, [ENTITY, global.id]))[0].n));
  t.ok("VAN: without an acknowledge address the same file is offered again, and is skipped by its checksum without adding a row", repoll.ok && /1 already taken in/.test(repoll.note) && docsAfter === docsBefore, repoll.note);
  const ixRows = await read(t, async (c) => (await q<{ sets: string; raws: string }>(c, `select count(*) sets, count(d.raw) raws from edi_document d where d.entity_id = $1 and d.direction = 'in' and d.interchange_id is not null`, [ENTITY]))[0]);
  t.ok("storage: an inbound interchange's raw text is kept once, its sets point at it", Number(ixRows.sets) > 5 && Number(ixRows.raws) === 0, JSON.stringify(ixRows));

  // ================================================================ ISA ids across companies
  await t.throws("partners: giving one partner another's ISA id is a plain refusal", () => r.post("/edi/partners", BUYER, { partner: { vendor_id: V.GLOBAL, their_isa_qual: COASTER_ID.qual, their_isa_id: COASTER_ID.id } }),
    /Coaster Company of America already uses ISA id 01\/COASTERUSA/);
  const sib = await t.pool.connect();
  try {
    await sib.query("begin");
    const ent = (await q<{ id: string }>(sib, `insert into entity (tenant_id, name, legal_name) values ($1, 'Check sister co', 'Check sister co LLC') returning id /* unscoped: a sister company for the check */`, [buyerScope.tenantId]))[0];
    let msg = "";
    try {
      await sib.query("savepoint s1");
      await q(sib, `insert into edi_partner (entity_id, vendor_id, our_isa_qual, our_isa_id, their_isa_qual, their_isa_id) values ($1,$2,'ZZ',$3,$4,$5)`, [ent.id, V.COASTER, OURS.id, COASTER_ID.qual, COASTER_ID.id]);
    } catch (e) { msg = (e as Error).message; await sib.query("rollback to savepoint s1"); }
    t.ok("partners: a sister company cannot pair the same ISA ids, so neither takes the other's files from a shared mailbox", /each company needs its own ISA id/.test(msg), msg);
  } finally { await sib.query("rollback"); sib.release(); }

  // ================================================================ secrets never come back
  const list = JSON.stringify(await r.get("/edi/partners"));
  const one_ = JSON.stringify(await r.get("/edi/partners/:id", "", global.id)) + JSON.stringify(await r.get("/edi/partners/:id", "", ashley.id));
  const docsAll = JSON.stringify(await r.get("/edi/documents", "?limit=300"));
  const detail = JSON.stringify(await r.get("/edi/documents/:id", "", apiSend.documentId));
  t.ok("secrets: no GET returns a partner's or a feed's secret, only which are set (masked)", ![list, one_, docsAll, detail].some((x) => x.includes("VAN-TOKEN-9999") || x.includes("Sftp-Secret-4411") || x.includes("G-ORDERS-7777"))
    && list.includes('"masked":"set"') && !list.includes("••••") && one_.includes("sftpPassword"));
  const stored = await read(t, async (c) => (await q<{ n: string }>(c, `select count(*) n from edi_partner where entity_id = $1 and transport_config::text like '%Secret%'`, [ENTITY]))[0].n);
  t.ok("secrets: passwords live sealed, never in the settings", stored === "0");

  // ================================================================ the PO trail
  const trail = await r.get<{ documents: { doc_type: string; direction: string; status: string }[]; shipments: unknown[] }>("/edi/pos/:id/trail", "", stockPo.poId);
  const types = trail.documents.map((d) => `${d.direction}:${d.doc_type}`);
  t.ok("PO trail: 850 out, the vendor's 997, 856 and 810 in, and the shipment", ["out:850", "in:997", "in:856", "in:810"].every((x) => types.includes(x)) && trail.shipments.length === 1, types.join(","));

  // ================================================================ store orders (catalog app flow)
  // The catalog app's rules: one category rule pooling several, matched loosely; the general minimum counts only the other items.
  t.ok("freight: loose category match (case, plurals, either inside the other)", so.looseMatch("Dining", ["dining room"]) && so.looseMatch("Accents", ["accent"]) && so.looseMatch("BEDROOM", ["Bedrooms"])
    && !so.looseMatch("Living room", ["Bedroom"]) && so.ruleNames("Dining, Bedroom / Youth and Accents").length === 4);
  await r.post("/edi/freight-mins", BUYER, { vendorId: V.ASHLEY, scope: "category", scopeValue: "Bedrooms", measure: "qty", minimum: 3 });
  const ashCheck = await read(t, (c) => so.freightCheck(c, ENTITY, V.ASHLEY, [{ productId: "77777777-0000-0000-0000-000000000004", qty: 1 }, { productId: "77777777-0000-0000-0000-000000000001", qty: 1 }]));
  t.ok("freight: a category rule counts its items; the vendor's general minimum counts only the other items", ashCheck.length === 2 && /Bedrooms \(category\) needs 3 pieces/.test(ashCheck[0].message)
    && ashCheck[1].rule === "other items" && ashCheck[1].have === "38500" && !ashCheck[1].ok, JSON.stringify(ashCheck));
  await r.post("/edi/freight-mins", BUYER, { vendorId: V.COASTER, scope: "category", scopeValue: "dining room, accent", measure: "qty", minimum: 4 });
  await t.throws("roles: a store manager cannot set freight minimums", () => r.post("/edi/freight-mins", STORE_MGR, { vendorId: V.COASTER, scope: "all", measure: "cost", minimum: "100" }), /needs one of: buyer/);
  const cart = await r.post<{ id: string; number: string }>("/edi/store-orders", STORE_MGR, { locationId: ENOLA, vendorId: V.COASTER, lines: [{ productId: P.CHAIRS, qty: 2 }] });
  await t.throws("store orders: submit is refused while a freight minimum is short, saying which", () => r.post("/edi/store-orders/:id/submit", STORE_MGR, {}, cart.id), /dining room, accent \(category\) needs 4 pieces .* has 2/);
  await t.throws("store orders: a cart holds one vendor", () => r.post("/edi/store-orders/:id/lines", STORE_MGR, { lines: [{ productId: P.GLB, qty: 1 }] }, cart.id), /another vendor/);
  await r.post("/edi/store-orders/:id/lines", STORE_MGR, { lines: [{ productId: P.CHAIRS, qty: 4 }, { productId: P.TABLE, qty: 6 }, { productId: P.LAMP, qty: 2 }] }, cart.id);
  await r.post("/edi/store-orders/:id/submit", STORE_MGR, {}, cart.id);
  await t.throws("store orders: a store manager cannot approve", () => r.post("/edi/store-orders/:id/approve", STORE_MGR, {}, cart.id), /needs one of: approver, buyer/);
  await t.throws("store orders: a sales associate cannot start one", () => r.post("/edi/store-orders", SALES, { locationId: ENOLA, vendorId: V.COASTER }), /needs one of: store manager, buyer/);
  await t.throws("store orders: approving spends open-to-buy; over budget only the owner may place it", () => r.post("/edi/store-orders/:id/approve", APPROVER, { note: "district ok" }, cart.id), /over budget: Dining at Riverside/);
  const approved = await r.post<{ po: { poId: string; number: string }; sent: { channel: string; status: string } | null }>("/edi/store-orders/:id/approve", PEOPLE.STEVE,
    { note: "holiday dining push", overBudgetReason: "holiday dining push" }, cart.id);
  const soRow = await r.get<{ order: { status: string; po_number: string }; lines: unknown[] }>("/edi/store-orders/:id", "", cart.id);
  t.ok("store orders: approved (by the owner, over budget, with a reason), the PO is placed for the store, and it goes to the vendor by EDI", soRow.order.status === "approved" && soRow.order.po_number === approved.po.number
    && approved.sent?.channel === "edi" && approved.sent?.status === "sent", JSON.stringify(approved.sent));
  const own = await r.post<{ id: string }>("/edi/store-orders", BUYER, { locationId: ENOLA, vendorId: V.COASTER, lines: [{ productId: P.TABLE, qty: 8 }] });
  await r.post("/edi/store-orders/:id/submit", BUYER, {}, own.id);
  await t.throws("store orders: whoever submitted cannot approve their own", () => r.post("/edi/store-orders/:id/approve", BUYER, {}, own.id), /cannot also approve/);
  const built = await r.post<{ id: string }>("/edi/store-orders", BUYER, { locationId: ENOLA, vendorId: V.COASTER, lines: [{ productId: P.TABLE, qty: 8 }] });
  await r.post("/edi/store-orders/:id/submit", STORE_MGR, {}, built.id);
  await t.throws("store orders: whoever built the cart cannot approve it either", () => r.post("/edi/store-orders/:id/approve", BUYER, {}, built.id), /built a store order's cart cannot also approve/);
  const pal = await r.post<{ id: string }>("/edi/store-orders", BUYER, { locationId: "33333333-0000-0000-0000-000000000002", vendorId: V.COASTER, lines: [{ productId: P.TABLE, qty: 8 }] });
  await r.post("/edi/store-orders/:id/submit", BUYER, {}, pal.id);
  await t.throws("store orders: another store's manager cannot send an order back to draft", () => r.post("/edi/store-orders/:id/back", STORE_MGR, { reason: "too many" }, pal.id), /another store's order/);
  await r.post("/edi/store-orders/:id/back", APPROVER, { reason: "fewer tables" }, pal.id);
  t.ok("store orders: an approver sends it back with the reason", (await r.get<{ order: { status: string; decision_note: string } }>("/edi/store-orders/:id", "", pal.id)).order.status === "draft");
  await t.throws("store orders: turning one down needs a reason", () => r.post("/edi/store-orders/:id/reject", APPROVER, { reason: "" }, own.id), /say why/);
  await r.post("/edi/store-orders/:id/reject", APPROVER, { reason: "the DC has tables" }, own.id);
  t.ok("store orders: a turned-down order keeps its reason", ((await r.get<{ order: { status: string; decision_note: string } }>("/edi/store-orders/:id", "", own.id)).order).decision_note === "the DC has tables");
  void so;
  useEdiEnv(() => edi.liveEdiEnv());
}
