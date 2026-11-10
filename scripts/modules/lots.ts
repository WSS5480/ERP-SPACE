// Serials and lots, labels, and finance company settlements: serial and dye
// lot captured at receiving (typed, and from the vendor's 856), one lot per
// cover on an order with a warning when lots mix and a refusal in strict
// mode, recall search, ZPL with the right fields and a good Code 128 check,
// the network-print allowlist, the settlement import (match, fee, clearing
// 1110), holdback and release, chargeback reopening the sale, exceptions,
// the fee variance flag, the bank link and role refusals. Runs last.
import type { T } from "./harness.ts";
import { ENTITY, RIO_ENTITY, LOC, PEOPLE } from "./harness.ts";
import { q, type Client, type Scope } from "../../packages/core/db.ts";
import * as inv from "../../packages/core/inventory.ts";
import * as pur from "../../packages/core/purchasing.ts";
import * as x12 from "../../packages/core/x12.ts";
import * as ar from "../../packages/core/ar.ts";
import * as L from "../../packages/core/labels.ts";
import * as cat from "../../packages/core/catalog.ts";
import { PublicPage } from "../../server/modules/kit.ts";
import { module as lotsModule } from "../../server/modules/lots.ts";
import { module as invModule } from "../../server/modules/inventory.ts";
import { scopeOf } from "../../server/actions.ts";
import { asPerson, routesOf } from "./inventory.ts";

const DC = "33333333-0000-0000-0000-0000000000dc";
const DEE = "55555555-0000-0000-0000-000000000013";       // warehouse
const MARIA = "55555555-0000-0000-0000-000000000011";     // sales
const BUYER = "55555555-0000-0000-0000-000000000016";
const JEN = "55555555-0000-0000-0000-000000000017";       // A/R clerk
const MGR = "55555555-0000-0000-0000-000000000018";       // store manager
const TONY = "55555555-0000-0000-0000-000000000015";      // driver
const COASTER = "66666666-0000-0000-0000-0000000000a2";
const CUSTOMER = "88888888-0000-0000-0000-000000000001";
const PRIME = "abab0000-0000-0000-0000-000000000001";
const OPERATING = "88888888-0000-0000-0000-000000000001";
const B = (v: unknown) => BigInt(String(v ?? 0));
const J = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

const R = routesOf(lotsModule as never), I = routesOf(invModule as never);
const as = <X>(who: string, fn: (c: Client, s: Scope) => Promise<X>, entity = ENTITY) => asPerson(who, (c, co, a) => fn(c, scopeOf(co, a)), entity);

export async function run(t: T) {
  const c0 = await t.pool.connect();
  const read = <X extends Record<string, unknown>>(sql: string, p: unknown[] = []) => t.q<X>(c0, sql, p);
  const gl = async (code: string) => as(PEOPLE.STEVE, (c) => ar.glBalance(c, ENTITY, code));
  try {
    // ------------------------------------------------------------- products
    const mk = async (sku: string, name: string, lotClass: string | null, group: string | null) => (await as(PEOPLE.STEVE, (c) => q<{ id: string }>(c, `
      insert into product (entity_id, sku, name, kind, vendor_id, vendor_sku, price_minor, cost_minor, serialized, lot_class, lot_group, collection, color, status)
      values ($1,$2,$3,'stock',$4,$2,99900,40000,true,$5,$6,'Lotte','Saddle','active') returning id`, [ENTITY, sku, name, COASTER, lotClass, group])))[0].id;
    const SOFA = await mk("LOT-SOFA", "Lotte leather sofa", null, null);
    const LOVE = await mk("LOT-LOVE", "Lotte leather loveseat", "dye_lot", null);
    const DRESSER = await mk("LOT-DRESSER", "Lotte dresser", "finish_batch", "LOTTE OAK");
    await t.throws("roles: sales cannot set how a product's lots are matched", () => R.post(t, MARIA, `/lots/products/${SOFA}`, { lotClass: "dye_lot" }), /needs one of: buyer, store manager/);
    await R.post(t, BUYER, `/lots/products/${SOFA}`, { lotClass: "dye_lot" });
    const keys = await read<{ sku: string; k: string }>(`select sku, ${inv.LOT_KEY_SQL} k from product p where entity_id = $1 and sku in ('LOT-SOFA','LOT-LOVE','LOT-DRESSER') order by sku`, [ENTITY]);
    t.ok("lots: the sofa and loveseat share a cover group (collection and color); the dresser's finish batch uses its own group",
      keys.find((k) => k.sku === "LOT-SOFA")?.k === "LOTTE SADDLE" && keys.find((k) => k.sku === "LOT-LOVE")?.k === "LOTTE SADDLE" && keys.find((k) => k.sku === "LOT-DRESSER")?.k === "LOTTE OAK", J(keys));

    // ------------------------------------------------------------ receiving
    const po = await as(BUYER, (c, s) => pur.createPO(c, s, { vendorId: COASTER, shipToId: DC, lines: [{ productId: SOFA, qty: 7 }, { productId: LOVE, qty: 3 }, { productId: DRESSER, qty: 1 }],
      overBudgetReason: "lot checks" }, true));
    const pol = await read<{ id: string; product_id: string }>(`select id, product_id from purchase_order_line where entity_id = $1 and purchase_order_id = $2 order by seq`, [ENTITY, po.poId]);
    const lineOf = (pid: string) => pol.find((x) => x.product_id === pid)!.id;
    await t.throws("receiving: a serial given twice on one line is refused", () => I.post(t, DEE, "/inventory/receiving", { purchaseOrderId: po.poId, locationId: DC,
      lines: [{ poLineId: lineOf(SOFA), qty: 2, units: [{ serial: "SN-A1" }, { serial: "sn-a1" }] }] }), /serial number was given twice/);
    const rc1 = await I.post(t, DEE, "/inventory/receiving", { purchaseOrderId: po.poId, locationId: DC, lines: [
      { poLineId: lineOf(SOFA), qty: 4, units: [{ serial: "SN-A1", lot: "DL-100" }, { serial: "SN-A2", lot: "DL-100" }, { serial: "SN-A3", lot: "DL-200" }, { serial: "SN-A4", lot: "DL-200" }] },
      { poLineId: lineOf(LOVE), qty: 3, units: [{ serial: "LV-1", lot: "DL-100" }, { serial: "LV-2", lot: "DL-200" }, { serial: "LV-3", lot: "DL-200" }] },
      { poLineId: lineOf(DRESSER), qty: 1, lot: "FB-7", units: [{ serial: "DR-1" }] }] }) as { receiptId: string; lines: { labels: string[]; serials: string[]; lots: string[] }[] };
    const piece = async (serial: string) => (await read<{ label: string; serial_no: string; lot_code: string | null; unit_id: string }>(
      `select label, serial_no, lot_code, unit_id from inv_piece where entity_id = $1 and serial_no = $2 order by carton_seq limit 1`, [ENTITY, serial]))[0];
    const a1 = await piece("SN-A1"), dr = await piece("DR-1");
    t.ok("receiving: the serial and dye lot typed at the dock are on the piece, and a line's lot fills in a unit that names none",
      a1?.lot_code === "DL-100" && dr?.lot_code === "FB-7" && rc1.lines[0].serials.length === 4 && rc1.lines[0].lots.join() === "DL-100,DL-200", J({ a1, dr }));
    await t.throws("receiving: a serial already in stock for that product is refused", () => I.post(t, DEE, "/inventory/receiving", { purchaseOrderId: po.poId, locationId: DC,
      lines: [{ poLineId: lineOf(SOFA), qty: 1, units: [{ serial: "SN-A2" }] }] }), /serial SN-A2 is already on piece/);

    // The vendor's 856: serials in MAN, the lot in LIN; parsed, kept against the PO line, used at receiving.
    const asn = x12.parse856(x12.build856({ shipmentId: "SH-LOT-1", date: "2026-11-01", orders: [{ poNumber: po.number,
      lines: [{ line: 1, vendorSku: "LOT-SOFA", qty: 3, serials: ["SN-B1", "SN-B2"], lot: "DL-300" }] }] }));
    const segs = x12.parse856([["BSN", "00", "SH2", "20261101"], ["HL", "1", "", "S"], ["HL", "2", "1", "O"], ["PRF", po.number], ["HL", "3", "2", "I"],
      ["LIN", "1", "VN", "LOT-SOFA", "SN", "SN-B3", "LT", "DL-400"], ["SN1", "", "1", "EA"], ["REF", "SE", "SN-B9"]]);
    t.ok("856: serials (MAN SN, LIN SN, REF SE) and the lot (LIN LT) are read off the ship notice",
      asn.orders[0].lines[0].serials?.join() === "SN-B1,SN-B2" && asn.orders[0].lines[0].lot === "DL-300" && segs.orders[0].lines[0].serials?.join() === "SN-B3,SN-B9" && segs.orders[0].lines[0].lot === "DL-400",
      J([asn.orders[0].lines[0], segs.orders[0].lines[0]]));
    await as(BUYER, async (c, s) => {
      await inv.expectSerials(c, s, { poLineId: lineOf(SOFA), serials: asn.orders[0].lines[0].serials, lot: asn.orders[0].lines[0].lot, reference: "SH-LOT-1" });
      await inv.expectSerials(c, s, { poLineId: lineOf(SOFA), serials: ["SN-B3"], lot: "DL-400", reference: "SH2" });
    });
    await I.post(t, DEE, "/inventory/receiving", { purchaseOrderId: po.poId, locationId: DC, lines: [{ poLineId: lineOf(SOFA), qty: 3 }] });
    const b1 = await piece("SN-B1"), b3 = await piece("SN-B3");
    const used = await read<{ n: string }>(`select count(*)::text n from inv_expected_serial where entity_id = $1 and purchase_order_line_id = $2 and used_at is not null and piece_label is not null`, [ENTITY, lineOf(SOFA)]);
    t.ok("receiving: with nothing scanned, the serials and lots from the vendor's 856 go on the pieces and are marked used",
      b1?.lot_code === "DL-300" && b3?.lot_code === "DL-400" && used[0].n === "3", J({ b1, b3, used }));

    // Fill in a lot later by scanning a label.
    await t.throws("roles: a driver cannot change a piece's serial", () => R.post(t, TONY, `/lots/pieces/${dr.label}`, { serial: "X" }), /needs one of: warehouse, store manager/);
    await t.throws("scan: a serial already on another unit of the product is refused", () => R.post(t, DEE, `/lots/pieces/${dr.label}`, { serial: "DR-1" }).then(() =>
      R.post(t, DEE, `/lots/pieces/${b1.label}`, { serial: "SN-A1" })), /serial SN-A1 is already on piece/);
    await R.post(t, DEE, `/lots/pieces/${dr.label}`, { lot: "fb-8" });
    t.ok("scan: a lot is corrected on every carton of the unit", (await piece("DR-1")).lot_code === "FB-8");

    // --------------------------------------------------------- one lot per cover
    const order = async (no: string, lines: [string, number][]) => as(PEOPLE.STEVE, async (c) => {
      const o = (await q<{ id: string }>(c, `insert into sales_order (entity_id, number, channel, location_id, customer_id, status, fulfillment)
        values ($1,$2,'phone',$3,$4,'open','pickup') returning id`, [ENTITY, no, LOC.ENOLA, CUSTOMER]))[0];
      let seq = 1;
      for (const [pid, qty] of lines) await c.query(`insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, fulfil_from_id, line_status)
        select $1, $2, $3, id, sku, name, $5, 99900, $6, 'open' from product where id = $4`, [ENTITY, o.id, seq++, pid, qty, DC]);
      await inv.reserveOrder(c, ENTITY, o.id);
      return o.id;
    });
    const lotsOf = async (orderId: string) => (await read<{ lot_code: string }>(`select distinct pc.lot_code from inv_piece pc join sales_order_line l on l.id = pc.sales_order_line_id
      where pc.entity_id = $1 and l.sales_order_id = $2 order by 1`, [ENTITY, orderId])).map((x) => x.lot_code);
    // free now: sofa DL-100 x2, DL-200 x2, DL-300 x2, DL-400 x1; loveseat DL-100 x1, DL-200 x2
    const oA = await order("LOT-SO-A", [[SOFA, 2], [LOVE, 2]]);
    await t.throws("roles: a driver cannot reserve pieces", () => R.post(t, TONY, `/lots/orders/${oA}/reserve`), /needs one of: warehouse, store manager, sales/);
    const rA = await R.post(t, MARIA, `/lots/orders/${oA}/reserve`) as { allocated: number; warnings: string[] };
    t.ok("reserve: a sofa and loveseat of one cover come from the one dye lot that covers both (DL-200, though DL-100 is older)",
      rA.allocated === 4 && !rA.warnings.length && (await lotsOf(oA)).join() === "DL-200", J({ rA, lots: await lotsOf(oA) }));
    // free: sofa DL-100 x2, DL-300 x2, DL-400 x1; loveseat DL-100 x1
    const oB = await order("LOT-SO-B", [[SOFA, 1], [LOVE, 1]]);
    await R.post(t, MGR, "/lots/settings", { strict: true });
    await t.throws("roles: sales cannot change strict lots", () => R.post(t, MARIA, "/lots/settings", { strict: false }), /needs one of: store manager, controller/);
    const oC = await order("LOT-SO-C", [[SOFA, 1], [LOVE, 1]]);
    // take the last DL-100 loveseat so order C cannot match its sofa's lot
    await R.post(t, MARIA, `/lots/orders/${oB}/reserve`);
    t.ok("reserve: order B's pair matches on DL-100", (await lotsOf(oB)).join() === "DL-100", (await lotsOf(oB)).join());
    // C: sofas left in DL-100, DL-300, DL-400; no loveseat at all -- a shortage, not a mix
    const shortC = await R.post(t, MARIA, `/lots/orders/${oC}/reserve`) as { allocated: number; warnings: string[] };
    t.ok("reserve: a line still on order is left alone (not refused, even in strict mode) while the sofa gets its piece", shortC.allocated === 1 && !shortC.warnings.length, J(shortC));
    // more loveseats, in DL-500 only: C's sofa is in another lot
    const po2 = await as(BUYER, (c, s) => pur.createPO(c, s, { vendorId: COASTER, shipToId: DC, lines: [{ productId: LOVE, qty: 1 }], overBudgetReason: "lot checks" }, true));
    const po2l = (await read<{ id: string }>(`select id from purchase_order_line where entity_id = $1 and purchase_order_id = $2`, [ENTITY, po2.poId]))[0].id;
    await I.post(t, DEE, "/inventory/receiving", { purchaseOrderId: po2.poId, locationId: DC, lines: [{ poLineId: po2l, qty: 1, lot: "DL-500", units: [{ serial: "LV-9" }] }] });
    await t.throws("strict lots: reserving a loveseat in another dye lot than the order's sofa is refused",
      () => R.post(t, MARIA, `/lots/orders/${oC}/reserve`), /cannot come from one dye lot with the rest of the order's matching pieces, and the company keeps lots strict/);
    const lv9 = await piece("LV-9");
    const cLove = (await read<{ id: string }>(`select id from sales_order_line where entity_id = $1 and sales_order_id = $2 and product_id = $3`, [ENTITY, oC, LOVE]))[0].id;
    await t.throws("strict lots: putting that piece on the order by hand is refused too", () => I.post(t, DEE, "/inventory/allocate", { label: lv9.label, lineId: cLove }),
      /is dye lot DL-500, but this order's other pieces of that cover or finish are dye lot .*keeps lots strict/);
    const pickStrict = await as(DEE, (c) => inv.pickListFor(c, ENTITY, [oC]));
    t.ok("strict lots: the pick list leaves the loveseat short and says why, rather than mixing", pickStrict.short === 1 && pickStrict.lotWarnings.some((w) => /rather than mixing lots/.test(w)),
      J(pickStrict.lotWarnings));
    await R.post(t, MGR, "/lots/settings", { strict: false });
    const rC = await R.post(t, MARIA, `/lots/orders/${oC}/reserve`) as { warnings: string[] };
    t.ok("lots: without strict mode the mix goes ahead with a warning naming the lots", rC.warnings.length === 1 && /mixed dye lots .*DL-500/.test(rC.warnings[0]), J(rC));
    const pick = await as(DEE, (c) => inv.pickListFor(c, ENTITY, [oA, oC]));
    const pcs = pick.lines.flatMap((l) => l.pieces);
    t.ok("pick list: each piece shows its serial and lot, and the mixed order is warned about", pcs.length === 6 && pcs.every((p) => p.serial && p.lot) && pick.lotWarnings.length === 1,
      J({ n: pcs.length, w: pick.lotWarnings }));
    const ord = await R.get(t, `/lots/orders/${oC}`) as { lines: { pieces: { serial: string | null; lot: string | null }[] }[]; mixed: unknown[] };
    t.ok("delivery record: an order's lines list the serial and lot of each piece", ord.lines.every((l) => l.pieces.length === 1 && l.pieces[0].serial) && ord.mixed.length === 1);

    // ----------------------------------------------------------------- recall
    const byLot = await R.get(t, "/lots/search?q=dl-200") as { serial_no: string; order_number: string | null; customer: string | null; matched_on: string; po_number: string }[];
    t.ok("recall: a dye lot finds every unit of it, with the order and customer it went to and the PO it came on",
      byLot.length === 4 && byLot.every((x) => x.order_number === "LOT-SO-A" && x.customer && x.matched_on === "lot" && x.po_number === po.number), J(byLot.map((x) => [x.serial_no, x.order_number])));
    const bySerial = await R.get(t, "/lots/search?q=SN-B") as unknown[];
    const one1 = await R.get(t, "/lots/search?q=lv-9") as { status: string; order_number: string }[];
    t.ok("recall: a serial's first four characters find its siblings, and an exact serial finds the one unit", bySerial.length === 3 && one1.length === 1 && one1[0].order_number === "LOT-SO-C");
    const rioSees = await asPerson(PEOPLE.STEVE, (c) => inv.searchSerials(c, RIO_ENTITY, "DL-200"), RIO_ENTITY);
    t.ok("recall: another client's company finds none of these", rioSees.length === 0);

    // ------------------------------------------------------------------ labels
    const zr = await R.post(t, DEE, "/labels/zpl", { source: "receipt", id: rc1.receiptId }) as { zpl: string; labels: number; filename: string };
    const blocks = zr.zpl.split("^XZ").filter((x) => x.includes("^XA"));
    const a1Block = blocks.find((b) => b.includes(`^FD${a1.label}^FS`)) ?? "";
    const check = (s: string) => { let sum = 104; [...s].forEach((ch, i) => { sum += (ch.charCodeAt(0) - 32) * (i + 1); }); return sum % 103; };
    t.ok("ZPL: one label per carton received, each with SKU, PO, piece x of y, serial, lot and a Code 128 of the piece label",
      blocks.length === zr.labels && zr.labels === 8 && /\.zpl$/.test(zr.filename) && a1Block.includes("^FDLOT-SOFA^FS") && a1Block.includes(`^FDPO ${po.number}^FS`)
      && a1Block.includes("^FDPiece 1 of 1^FS") && a1Block.includes("^FDSerial SN-A1^FS") && a1Block.includes("^FDLot DL-100^FS") && /\^BCN,\d+,Y,N,N\^FH_\^FDP/.test(a1Block),
      a1Block.slice(0, 600));
    const fx = /\^FX Code128-B (\S+) check (\d+)\^FS/.exec(a1Block);
    t.ok("ZPL: the Code 128 check digit written with the label is right, and the bars decode back to the label",
      !!fx && fx[1] === a1.label && Number(fx[2]) === check(a1.label) && L.code128Check(a1.label) === check(a1.label) && cat.decode128(cat.code128(a1.label)) === a1.label, fx?.[0]);
    const aPiece = (await read<{ label: string }>(`select pc.label from inv_piece pc join sales_order_line l on l.id = pc.sales_order_line_id where pc.entity_id = $1 and l.sales_order_id = $2 limit 1`, [ENTITY, oA]))[0].label;
    const reservedSet = await as(DEE, (c) => L.forPieces(c, ENTITY, [aPiece]));
    const cust = (await read<{ name: string }>(`select name from customer where id = $1 /* unscoped: test lookup */`, [CUSTOMER]))[0].name;
    t.ok("labels: a reserved piece's label names the customer and order", (reservedSet.labels[0] as L.CartonLabel).customer === cust && (reservedSet.labels[0] as L.CartonLabel).order === "LOT-SO-A");
    t.ok("ZPL: ^ and ~ in text cannot start a command", L.zplText("A^B~C_D") === "A_5EB_7EC_5FD");
    await t.throws("templates: a field that is not on that kind of label is refused", () => R.post(t, MGR, "/labels/templates", { kind: "carton", name: "Bad", widthIn: 4, heightIn: 6, fields: ["sku", "retail"] }),
      /retail is not a field on a carton label/);
    await t.throws("roles: a warehouse worker cannot change label templates", () => R.post(t, DEE, "/labels/templates", { kind: "carton", name: "Small", widthIn: 4, heightIn: 2, fields: ["sku"] }),
      /needs one of: store manager/);
    await R.post(t, MGR, "/labels/templates", { kind: "carton", name: "Small carton", widthIn: 3, heightIn: 2, dpi: 300, fields: ["sku", "piece", "barcode"], isDefault: true });
    const small = await R.post(t, DEE, "/labels/zpl", { source: "pieces", labels: [a1.label] }) as { zpl: string; template: string };
    t.ok("templates: the company's default carton template sets the size and fields (no serial on the small one)",
      small.template === "Small carton" && small.zpl.includes("^PW900") && small.zpl.includes("^LL600") && !small.zpl.includes("Serial") && small.zpl.includes("^FDLOT-SOFA^FS"), small.zpl.slice(0, 300));
    await t.throws("roles: sales cannot print carton labels", () => R.post(t, MARIA, "/labels/zpl", { source: "pieces", labels: [a1.label] }), /printing labels needs one of/);
    // price tags, with a condition grade when the catalog keeps one (rolled back afterwards)
    const tags = await as(MARIA, (c) => L.forPriceTags(c, ENTITY, { productIds: [SOFA] }));
    const tag0 = tags.labels[0] as L.PriceTag;
    t.ok("price tags: retail price and barcode, and no condition line when there is no condition grade column", tag0?.retail === "$999.00" && tag0.condition === null && tag0.barcode === "LOT-SOFA"
      && !L.zplFor({ id: null, kind: "price_tag", name: "t", width_in: 4, height_in: 3, dpi: 203, fields: L.FIELDS.price_tag }, tags).includes("Condition"), J(tag0));
    const cg = await t.pool.connect();
    try {
      await cg.query("begin");
      await cg.query("alter table product add column condition_grade text");
      await cg.query("update product set condition_grade = 'B' where id = $1 and entity_id = $2", [SOFA, ENTITY]);
      const g = await L.forPriceTags(cg, ENTITY, { productIds: [SOFA] });
      const z = L.zplFor({ id: null, kind: "price_tag", name: "t", width_in: 4, height_in: 3, dpi: 203, fields: L.FIELDS.price_tag }, g);
      t.ok("price tags: a condition grade column, when another module adds it, prints on the tag", (g.labels[0] as L.PriceTag).condition === "B" && z.includes("^FDCondition B^FS"));
    } finally { await cg.query("rollback"); cg.release(); }
    const bins = await read<{ id: string }>(`select id from inv_bin where entity_id = $1 and active limit 2`, [ENTITY]);
    if (bins.length) {
      const bz = await R.post(t, DEE, "/labels/zpl", { source: "bins", binIds: bins.map((b) => b.id) }) as { labels: number; zpl: string };
      t.ok("bin labels: one per bin with its code as the barcode", bz.labels === bins.length && bz.zpl.includes("^BCN"));
    }
    const page = await R.get(t, `/labels/print?source=receipt&id=${rc1.receiptId}`);
    const html = (page as PublicPage).text ?? "";
    t.ok("print page: a no-script page sized for the company's label template, with SVG barcodes (the Dymo and desktop fallback)",
      page instanceof PublicPage && html.includes("@page{size:3in 2in") && html.includes("<svg") && !/<script/i.test(html) && html.includes(`Barcode ${a1.label}`) && html.includes('nonce="__NONCE__"'));

    // network printers: owner only, private addresses only, named by id
    await t.throws("printers: only the owner sets up a printer", () => R.post(t, MGR, "/labels/printers", { name: "Dock Zebra", host: "192.168.1.50" }), /only the owner sets up label printers/);
    await t.throws("printers: a public address is refused", () => R.post(t, PEOPLE.STEVE, "/labels/printers", { name: "Dock Zebra", host: "8.8.8.8" }), /is not on a private network/);
    await t.throws("printers: a host name is refused (DNS could move it)", () => R.post(t, PEOPLE.STEVE, "/labels/printers", { name: "Dock Zebra", host: "zebra.internal" }), /is not an IP address/);
    await t.throws("printers: loopback is refused", () => R.post(t, PEOPLE.STEVE, "/labels/printers", { name: "Dock Zebra", host: "127.0.0.1" }), /is not on a private network/);
    await t.throws("printers: a port other than 9100-9109 is refused", () => R.post(t, PEOPLE.STEVE, "/labels/printers", { name: "Dock Zebra", host: "192.168.1.50", port: 22 }), /port 9100/);
    await t.throws("printers: the database refuses a public address however it is written", () => as(PEOPLE.STEVE, (c) => c.query(
      `insert into label_printer (entity_id, name, host) values ($1, 'raw', '93.184.216.34')`, [ENTITY])), /label_printer_host_check|violates check constraint/);
    const pr = await R.post(t, PEOPLE.STEVE, "/labels/printers", { name: "Dock Zebra", host: "192.168.1.50", locationId: DC }) as { id: string };
    const sent: { host: string; port: number; data: string }[] = [];
    L.useTransport(async (host, port, data) => { sent.push({ host, port, data }); });
    try {
      await t.throws("network print: a request that names an address is refused", () => R.post(t, DEE, "/labels/send", { source: "pieces", labels: [a1.label], printerId: pr.id, host: "10.0.0.9" }),
        /names one of the printers set up in Labels, not an address/);
      await t.throws("network print: a printer that is not configured is refused", () => R.post(t, DEE, "/labels/send", { source: "pieces", labels: [a1.label], printerId: "00000000-0000-4000-8000-000000000001" }),
        /not one of this company's printers/);
      const rioPrinter = await as(PEOPLE.STEVE, (c) => q<{ id: string }>(c, `insert into label_printer (entity_id, name, host) values ($1, 'Rio printer', '10.9.9.9') returning id`, [RIO_ENTITY]));
      await t.throws("network print: another company's printer is refused", () => R.post(t, DEE, "/labels/send", { source: "pieces", labels: [a1.label], printerId: rioPrinter[0].id }),
        /not one of this company's printers/);
      const ok = await R.post(t, DEE, "/labels/send", { source: "pieces", labels: [a1.label, b1.label], printerId: pr.id }) as { labels: number };
      t.ok("network print: raw ZPL goes to the configured printer's address and port 9100 only", ok.labels === 2 && sent.length === 1 && sent[0].host === "192.168.1.50" && sent[0].port === 9100
        && sent[0].data.startsWith("^XA"), J(sent.map((s) => [s.host, s.port])));
      L.useTransport(async () => { throw new Error("connection refused"); });
      await t.throws("network print: a printer that does not answer is a plain refusal", () => R.post(t, DEE, "/labels/send", { source: "pieces", labels: [a1.label], printerId: pr.id }),
        /Dock Zebra \(192\.168\.1\.50\) did not take the labels: connection refused/);
    } finally { L.useTransport(null); }

    // ------------------------------------------------------------- settlements
    const sale = async (no: string, amount: bigint, planCode: string, auth: string | null, account: string | null) => as(JEN, async (c, s) => {
      const r = (await q<{ id: string }>(c, `insert into customer_receipt (entity_id, number, customer_id, location_id, channel, method, amount_minor, reference)
        values ($1,$2,$3,$4,'pos','financing',$5,$6) returning id`, [ENTITY, no, CUSTOMER, LOC.ENOLA, amount.toString(), auth]))[0];
      await ar.postReceipt(c, s, r.id);
      const plan = (await q<{ id: string }>(c, `select id from finance_plan where entity_id = $1 and company_id = $2 and code = $3`, [ENTITY, PRIME, planCode]))[0].id;
      return (await ar.recordFinancedSale(c, s, r.id, plan, { accountLast4: account })).financedSaleId;
    });
    const S1 = await sale("FIN-LOT-1", 100000n, "P12", "AUTH-1", null);
    const S2 = await sale("FIN-LOT-2", 200000n, "P24", "AUTH-2", null);
    const S3 = await sale("FIN-LOT-3", 50000n, "P12", null, "6011000000003333");
    const S4 = await sale("FIN-LOT-4", 80000n, "P12", "AUTH-4", null);
    const s3row = (await read<{ account_last4: string; auth_code: string | null }>(`select account_last4, auth_code from financed_sale where id = $1 /* unscoped: test lookup */`, [S3]))[0];
    t.ok("financed sale: only the last four of the lender account are kept", s3row.account_last4 === "3333");
    const mapping = { date: "Funding Date", auth: "Auth Code", account: "Account", gross: "Sale Amount", fee: "Discount", holdback: "Holdback", net: "Net", kind: "Type", reason: "Reason", plan: "Plan",
      dateFormat: "MM/DD/YYYY" };
    await t.throws("roles: an A/R clerk cannot set up a lender's file layout", () => R.post(t, JEN, `/settlements/lenders/${PRIME}`, { mapping }), /needs one of: controller/);
    await t.throws("lender setup: a mapping with no amount column is refused", () => R.post(t, PEOPLE.CONTROLLER, `/settlements/lenders/${PRIME}`, { mapping: { date: "d", auth: "a" } }),
      /needs the net \(funded\) amount column or the sale \(gross\) amount column/);
    await R.post(t, PEOPLE.CONTROLLER, `/settlements/lenders/${PRIME}`, { mapping, bankAccountId: OPERATING, feeTolerance: "1.00", chargebackMode: "reopen" });
    const bankCode = (await read<{ code: string }>(`select g.code from bank_account ba join gl_account g on g.id = ba.gl_account_id where ba.id = $1 /* unscoped: test lookup */`, [OPERATING]))[0].code;
    const us = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
    const today = us(new Date());
    const file1 = [
      "Funding Date,Type,Auth Code,Account,Plan,Sale Amount,Discount,Holdback,Net,Reason",
      `${today},Funding,AUTH-1,,P12,"1,000.00",60.00,0.00,940.00,`,
      `${today},Funding,AUTH-2,,P24,2000.00,250.00,100.00,1650.00,`,
      `${today},Funding,,XXXXXXXXXXXX3333,P12,500.00,30.00,0,470.00,`,
      `${today},Funding,AUTH-4,,P12,800.00,48.00,0,752.00,`,
      `${today},Funding,AUTH-X,,P12,600.00,36.00,0,564.00,`,
    ].join("\n");
    const before = { f1110: await gl("1110"), f6910: await gl("6910"), f1115: await gl("1115"), bank: await gl(bankCode) };
    await t.throws("roles: sales cannot import a lender's settlement", () => R.post(t, MARIA, "/settlements/import", { companyId: PRIME, text: file1 }), /needs one of: ar clerk, controller/);
    const im1 = await R.post(t, JEN, "/settlements/import", { companyId: PRIME, filename: "prime-1.csv", text: file1 }) as
      { importId: string; matched: number; exceptions: number; postedMinor: bigint; feeFlags: number; bankLinked: boolean };
    const after = { f1110: await gl("1110"), f6910: await gl("6910"), f1115: await gl("1115"), bank: await gl(bankCode) };
    t.ok("settlement: four rows match (by auth code, and by account last four with amount and date), the fee posts to 6910 and 1110 is cleared by the sales",
      im1.matched === 4 && im1.exceptions === 1 && before.f1110 - after.f1110 === 430000n && after.f6910 - before.f6910 === 38800n && after.bank - before.bank === 381200n,
      J({ im1, d1110: (before.f1110 - after.f1110).toString(), d6910: (after.f6910 - before.f6910).toString(), dBank: (after.bank - before.bank).toString() }));
    const st = await read<{ id: string; status: string; funded_minor: string; holdback_open_minor: string }>(`select id, status, funded_minor, holdback_open_minor from financed_sale where id = any($1) /* unscoped: test lookup */`, [[S1, S2, S3, S4]]);
    t.ok("settlement: the sales are funded, and the holdback sits in 1115 until it is released",
      st.every((x) => x.status === "funded") && st.find((x) => x.id === S2)?.holdback_open_minor === "10000" && after.f1115 - before.f1115 === 10000n);
    const lines1 = await R.get(t, `/settlements/imports/${im1.importId}`) as { auth_code: string | null; fee_flag: boolean; fee_variance_minor: string | null; status: string; exception: string | null }[];
    const flagged = lines1.filter((l) => l.fee_flag);
    t.ok("fee check: a fee off the plan's rate by more than the tolerance is flagged ($250 taken, 9.5% is $190)",
      im1.feeFlags === 1 && flagged.length === 1 && flagged[0].auth_code === "AUTH-2" && flagged[0].fee_variance_minor === "6000", J(flagged));
    const exc = lines1.find((l) => l.status === "exception");
    t.ok("exceptions: a row that matches no financed sale goes to the exception list with the reason, and nothing is guessed",
      exc?.auth_code === "AUTH-X" && /no financed sale awaiting funding matches approval AUTH-X/.test(exc?.exception ?? ""), exc?.exception ?? "");
    t.ok("bank: with an exception open, the deposit is not linked yet", im1.bankLinked === false);
    await t.throws("settlement: the same file twice is refused", () => R.post(t, JEN, "/settlements/import", { companyId: PRIME, text: file1 }), /this file was already imported as FR-/);
    // The bank's statement shows the whole deposit; resolving the exception by hand lets the link happen.
    const S5 = await sale("FIN-LOT-5", 60000n, "P12", "AUTH-5", null);
    const stmt = await as(PEOPLE.CONTROLLER, async (c) => {
      const bs = (await q<{ id: string }>(c, `insert into bank_statement (bank_account_id, statement_date, opening_balance_minor, closing_balance_minor, source)
        values ($1, current_date + 400, 0, 437600, 'manual') returning id`, [OPERATING]))[0];
      return (await q<{ id: string }>(c, `insert into bank_statement_line (bank_statement_id, posted_on, description, amount_minor) values ($1, current_date, 'PRIME CARD FIN DEP', 437600) returning id`, [bs.id]))[0].id;
    });
    const excRow = (await read<{ id: string }>(`select id from finance_remit_line where import_id = $1 and status = 'exception' /* unscoped: test lookup */`, [im1.importId]))[0].id;
    await t.throws("roles: sales cannot settle an exception", () => R.post(t, MARIA, `/settlements/lines/${excRow}/resolve`, { financedSaleId: S5 }), /needs one of: ar clerk, controller/);
    await t.throws("exceptions: picking a sale that is already funded is refused", () => R.post(t, JEN, `/settlements/lines/${excRow}/resolve`, { financedSaleId: S1 }), /is funded; this row needs one that is awaiting funding/);
    const res = await R.post(t, JEN, `/settlements/lines/${excRow}/resolve`, { financedSaleId: S5 }) as { status: string; bank: { linked: boolean } };
    const bl = (await read<{ match_status: string; n: string }>(`select bsl.match_status, (select count(*) from reconciliation_match m where m.bank_statement_line_id = bsl.id)::text n
      from bank_statement_line bsl where bsl.id = $1 /* unscoped: test lookup */`, [stmt]))[0];
    t.ok("bank: once every row is posted, the settlement's deposits are linked to the one bank line of that amount", res.status === "posted" && res.bank.linked && bl.match_status !== "unmatched" && bl.n === "2",
      J({ res, bl }));

    // holdback release and a chargeback
    const file2 = ["Funding Date,Type,Auth Code,Account,Plan,Sale Amount,Discount,Holdback,Net,Reason",
      `${today},Holdback Release,AUTH-2,,,,,,100.00,`,
      `${today},Chargeback,AUTH-4,,,800.00,,,-752.00,customer disputed delivery`,
      `${today},Funding,AUTH-9,,P12,900.00,54.00,0,846.00,`].join("\n");
    const b2 = { f1110: await gl("1110"), f1115: await gl("1115"), f6910: await gl("6910"), bank: await gl(bankCode) };
    const im2 = await R.post(t, JEN, "/settlements/import", { companyId: PRIME, filename: "prime-2.csv", text: file2 }) as { importId: string; matched: number; exceptions: number };
    const a2 = { f1110: await gl("1110"), f1115: await gl("1115"), f6910: await gl("6910"), bank: await gl(bankCode) };
    const s2 = (await read<{ holdback_open_minor: string }>(`select holdback_open_minor from financed_sale where id = $1 /* unscoped: test lookup */`, [S2]))[0];
    t.ok("holdback: the lender's release moves it from 1115 to the bank", im2.matched === 2 && s2.holdback_open_minor === "0" && b2.f1115 - a2.f1115 === 10000n,
      J({ im2, s2, d1115: (b2.f1115 - a2.f1115).toString() }));
    const s4 = (await read<{ status: string; chargeback_reason: string | null }>(`select status, chargeback_reason from financed_sale where id = $1 /* unscoped: test lookup */`, [S4]))[0];
    t.ok("chargeback: the sale's receivable is reopened in 1110 with the lender's reason, and its fee given back",
      s4.status === "awaiting_funding" && s4.chargeback_reason === "customer disputed delivery" && a2.f1110 - b2.f1110 === 80000n && b2.f6910 - a2.f6910 === 4800n
      && a2.bank - b2.bank === 10000n - 75200n, J({ s4, d1110: (a2.f1110 - b2.f1110).toString(), d6910: (b2.f6910 - a2.f6910).toString() }));
    const aging = await R.get(t, "/settlements/aging") as { lenders: { companyId: string; current: string; reopened: number; exceptions: number; holdbackMinor: string }[] };
    const prime = aging.lenders.find((l) => l.companyId === PRIME)!;
    t.ok("aging: what the lender owes includes the reopened sale, counts the open exception, and no holdback is left",
      B(prime.current) >= 80000n && prime.reopened === 1 && prime.exceptions === 1 && prime.holdbackMinor === "0", J(prime));
    await t.throws("roles: an A/R clerk cannot write off a chargeback", () => R.post(t, JEN, `/settlements/sales/${S4}/charge-off`, { reason: "customer gone" }), /needs one of: controller/);
    const g3 = { f6915: await gl("6915"), f1110: await gl("1110") };
    await R.post(t, PEOPLE.CONTROLLER, `/settlements/sales/${S4}/charge-off`, { reason: "customer moved away, cannot be refinanced" });
    const a3 = { f6915: await gl("6915"), f1110: await gl("1110") };
    t.ok("chargeback: written off to 6915 with a reason, it leaves 1110", a3.f6915 - g3.f6915 === 80000n && g3.f1110 - a3.f1110 === 80000n);
    const exc2 = (await read<{ id: string }>(`select id from finance_remit_line where import_id = $1 and status = 'exception' /* unscoped: test lookup */`, [im2.importId]))[0].id;
    await t.throws("exceptions: setting a row aside needs a reason", () => R.post(t, JEN, `/settlements/lines/${exc2}/resolve`, { dismissReason: "" }), /pick the financed sale this row pays, or set it aside|say why/);
    const dis = await R.post(t, JEN, `/settlements/lines/${exc2}/resolve`, { dismissReason: "belongs to the Palestine store's merchant number" }) as { status: string };
    t.ok("exceptions: a row set aside with a reason leaves the list", dis.status === "dismissed" && !(await read(`select 1 from finance_remit_line where id = $1 and status = 'exception' /* unscoped: test lookup */`, [exc2])).length);
    // expense mode: the lender takes a funded sale back and we do not expect it again
    await R.post(t, PEOPLE.CONTROLLER, `/settlements/lenders/${PRIME}`, { chargebackMode: "expense" });
    const b4 = { f6915: await gl("6915"), f1110: await gl("1110") };
    await R.post(t, JEN, "/settlements/import", { companyId: PRIME, text: ["Funding Date,Type,Auth Code,Account,Plan,Sale Amount,Discount,Holdback,Net,Reason",
      `${today},Reversal,AUTH-1,,,,,,-940.00,fraud claim`].join("\n") });
    const a4 = { f6915: await gl("6915"), f1110: await gl("1110") };
    const s1 = (await read<{ status: string }>(`select status from financed_sale where id = $1 /* unscoped: test lookup */`, [S1]))[0];
    t.ok("chargeback, expense mode: posts to 6915 and the sale is charged off, 1110 untouched", s1.status === "charged_off" && a4.f6915 - b4.f6915 === 94000n && a4.f1110 === b4.f1110);
    await R.post(t, PEOPLE.CONTROLLER, `/settlements/lenders/${PRIME}`, { chargebackMode: "reopen" });
    const unbalanced = await read(`select je.id from journal_entry je join journal_line jl on jl.journal_entry_id = je.id where je.entity_id = $1 and je.source_type = 'finance'
      group by je.id having sum(jl.debit_minor) <> sum(jl.credit_minor)`, [ENTITY]);
    t.ok("ledger: every settlement entry balances", unbalanced.length === 0);
    void S3;
  } finally {
    await c0.query(`insert into entity_setting (entity_id, key, value) values ($1, 'inventory.lot_strict', 'false') on conflict (entity_id, key) do update set value = 'false'`, [ENTITY]);
    c0.release();
  }
}
