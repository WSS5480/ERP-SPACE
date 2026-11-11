// Configurator checks: sectional layouts (refused and priced), grades and
// covers, the POS sale made of a line per piece that reserves per piece, the
// special-order PO with one line per piece and its choices, delivery cube and
// weight summed from the pieces, the partial-delivery warning, a return by
// piece, the option rules (requires, excludes, only on these pieces),
// condition grades and their price with a manager override, the web
// customizer and the endless aisle, vendor catalog extras, and who may do what.
import type { T } from "./harness.ts";
import { ENTITY, RIO_ENTITY, LOC, PEOPLE, TENANT } from "./harness.ts";
import { tx, q, type Client } from "../../packages/core/db.ts";
import * as cfg from "../../packages/core/configurator.ts";
import * as shop from "../../packages/core/shop.ts";
import * as x12 from "../../packages/core/x12.ts";
import * as inv from "../../packages/core/inventory.ts";
import { scopeOf } from "../../server/actions.ts";
import { module as cfgModule } from "../../server/modules/configurator.ts";
import { module as posModule } from "../../server/modules/pos.ts";
import { module as purModule } from "../../server/modules/purchasing.ts";
import { module as fleetModule } from "../../server/modules/fleet.ts";
import { module as shopModule } from "../../server/modules/shop.ts";
import { module as ediModule } from "../../server/modules/edi.ts";
import { routesOf, asPerson } from "./inventory.ts";
import { routes as catRoutes, V } from "./catalog.ts";

const R = routesOf(cfgModule as never), RP = routesOf(posModule as never), RPU = routesOf(purModule as never), RF = routesOf(fleetModule as never),
  RS = routesOf(shopModule as never);
const FAM = "c0c00000-0000-0000-0000-000000000001";
const PIECE = { LS: "c0c00000-0000-0000-0000-000000000101", RS: "c0c00000-0000-0000-0000-000000000102", LL: "c0c00000-0000-0000-0000-000000000103",
  RL: "c0c00000-0000-0000-0000-000000000104", WG: "c0c00000-0000-0000-0000-000000000109", CR: "c0c00000-0000-0000-0000-000000000110" };
const MATTRESS = "c0c00000-0000-0000-0000-000000000401", TABLE = "c0c00000-0000-0000-0000-000000000402", LIFT = "c0c00000-0000-0000-0000-000000000405";
const MARIA = "55555555-0000-0000-0000-000000000011", LUIS = "55555555-0000-0000-0000-000000000012", DEE = "55555555-0000-0000-0000-000000000013";
const TONY = "55555555-0000-0000-0000-000000000015", ANA = "55555555-0000-0000-0000-000000000016", MGR = "55555555-0000-0000-0000-000000000018";
const ALICIA = "88888888-0000-0000-0000-000000000001";
const DC = "33333333-0000-0000-0000-0000000000dc";
const sys = { kind: "system" as const, label: "configurator checks" };
const plus = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const js = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const dollars = (m: bigint | string | number) => (Number(m) / 100).toFixed(2);
const layout3 = { layout: "3pc-sofa-wedge-loveseat" };
type Priced = ReturnType<typeof cfg.pricedView> & { svg: string };

export async function run(t: T) {
  const c0 = await t.pool.connect();
  const read = <X extends Record<string, unknown>>(sql: string, p: unknown[] = []) => t.q<X>(c0, sql, p);
  const level = async (pid: string, loc: string) => {
    const x = (await read<{ on_hand: string; reserved: string; on_order: string }>(`select on_hand, reserved, on_order from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`,
      [ENTITY, pid, loc]))[0] ?? { on_hand: "0", reserved: "0", on_order: "0" };
    return { onHand: Number(x.on_hand), reserved: Number(x.reserved), onOrder: Number(x.on_order) };
  };
  const price = (who: string, sectional: Record<string, unknown>) => R.post(t, who, "/cfg/price", { productId: FAM, sectional }) as Promise<Priced>;
  const setOf = async (orderId: string) => (await R.get(t, `/cfg/orders/${orderId}/sets`)) as Awaited<ReturnType<typeof cfg.setsForOrder>>;
  const orderLines = (id: string) => read<{ id: string; sku: string; line_status: string; product_id: string; config: Record<string, unknown>; fulfil_from_id: string | null;
    unit_price_minor: string; discount_minor: string; tax_minor: string; qty: string }>(
    `select id, sku, line_status, product_id, config, fulfil_from_id, unit_price_minor, discount_minor, tax_minor, qty from sales_order_line where entity_id = $1 and sales_order_id = $2 order by seq`, [ENTITY, id]);

  try {
    // ------------------------------------------------------------ who may do what
    await t.throws("roles: sales cannot set up a sectional", () => R.post(t, MARIA, "/cfg/families", { sku: "X-SECT", name: "X" }), /setting up a sectional needs one of: buyer/);
    await t.throws("roles: sales cannot change the swatch library", () => R.post(t, MARIA, "/cfg/swatches", { code: "x", name: "X" }), /swatch library needs one of: buyer/);
    await t.throws("roles: the warehouse does not price sectionals for customers", () => price(DEE, layout3), /pricing a sectional needs one of/);
    await t.throws("roles: sales cannot change the as-is price per grade", () => R.post(t, MARIA, "/cfg/condition/rules", { fair: 40 }), /needs one of: controller/);
    await t.throws("roles: a driver cannot grade an as-is piece", () => R.post(t, TONY, "/cfg/condition/P000001/grade", { grade: "good" }), /grading an as-is piece needs one of/);
    await t.throws("roles: sales cannot set an option rule", () => R.post(t, MARIA, "/cfg/rules", { productId: TABLE, group: "leaves", kind: "excludes" }), /option rule needs one of: buyer/);
    await t.throws("isolation: another client's company has no such sectional", () => tx(sys, (c) => cfg.priceBuild(c, RIO_ENTITY, FAM, layout3)), /not a sectional this company sells/);

    // ------------------------------------------------------------ layouts refused
    const bad: [string, Record<string, unknown>, RegExp][] = [
      ["a layout that starts with a RAF piece", { pieces: ["raf-sofa", "laf-loveseat"] }, /left end is the RAF sofa, which has an open side facing out/],
      ["a layout whose right end is open", { pieces: ["laf-sofa", "wedge"] }, /right end is the wedge.*finish it with a RAF piece/],
      ["an arm facing into the next piece", { pieces: ["laf-sofa", "laf-loveseat", "raf-sofa"] }, /LAF loveseat's arm would face into the LAF sofa; pieces join only on their armless sides/],
      ["fewer pieces than the family's least", { pieces: ["laf-sofa"] }, /is 2 to 7 pieces; this one has 1/],
      ["more pieces than the family's most", { pieces: ["laf-loveseat", "armless-chair", "armless-chair", "armless-chair", "armless-chair", "armless-chair", "armless-chair", "raf-loveseat"] }, /is 2 to 7 pieces; this one has 8/],
      ["three corners", { pieces: ["laf-loveseat", "corner", "armless-chair", "corner", "armless-chair", "corner", "raf-loveseat"] }, /turns at most two corners/],
      ["two corners side by side", { pieces: ["laf-loveseat", "corner", "wedge", "raf-loveseat"] }, /cannot sit side by side/],
      ["an ottoman alone", { pieces: ["ottoman", "ottoman"] }, /ottoman alone is not a sectional/],
      ["a piece the family does not make", { pieces: ["laf-sofa", "raf-banana"] }, /has no piece called raf-banana/],
      ["a discontinued cover", { ...layout3, cover: "tweed-retired" }, /was discontinued on 2026-01-01; pick another cover/],
      ["a cover not on the sectional", { ...layout3, cover: "plaid" }, /plaid is not a cover offered/],
    ];
    for (const [what, b, re] of bad) await t.throws(`layout: ${what} is refused`, () => price(MARIA, b), re);
    await t.throws("layout: a popular layout that cannot be sold cannot be saved", () => R.post(t, ANA, `/cfg/families/${FAM}/layouts`, { code: "bad-one", name: "Bad", pieces: "raf-sofa,laf-sofa" }), /left end is the RAF sofa/);

    // ------------------------------------------------------------ the popular layout, priced
    const nv = await price(MARIA, { ...layout3, cover: "navy-velvet" });
    t.ok("price: 3-pc LAF sofa / wedge / RAF loveseat in navy velvet (grade B) is each piece plus its grade adder",
      nv.listMinor === "270700" && nv.pieces.map((x) => x.gradeAdderMinor).join(",") === "15000,9000,12000" && nv.pieces.map((x) => x.priceMinor).join(",") === "114900,63900,91900",
      `${nv.listMinor} ${nv.pieces.map((x) => x.priceMinor)}`);
    t.ok("price: the 5% bundle discount comes off the sum, spread over the pieces", nv.bundleDiscountMinor === "13535" && nv.totalMinor === "257165"
      && nv.pieces.reduce((a, x) => a + BigInt(x.netMinor), 0n) === 257165n, `${nv.bundleDiscountMinor} ${nv.totalMinor}`);
    t.ok("price: the layout's name, cover and grade come back", nv.layoutName === "3-pc LAF sofa / wedge / RAF loveseat" && nv.cover?.grade === "B" && nv.cover?.code === "navy-velvet");
    t.ok("geometry: overall width, depth and seating from the pieces (90 + 50 wide, 50 + 64 deep, 3 + 1 + 2 seats)", nv.widthIn === 140 && nv.depthIn === 114 && nv.seats === 6,
      `${nv.widthIn} × ${nv.depthIn}, ${nv.seats}`);
    t.ok("geometry: the plan is SVG with no script or style, from three rectangles", /^<svg [^>]*viewBox=/.test(nv.svg) && !/<script|style=|on[a-z]+=/i.test(nv.svg) && nv.geometry.pieces.length === 3);
    const sb = await price(MARIA, { ...layout3, cover: "stone-boucle" });
    t.ok("price: a grade with no adders lifts each piece by its percent (grade C, 20%)", sb.pieces.map((x) => x.gradeAdderMinor).join(",") === "19980,10980,15980", sb.pieces.map((x) => x.gradeAdderMinor).join(","));
    const oat = await price(MARIA, layout3);
    t.ok("price: no cover named is the stocked cover, grade A, no adder, ships from stock", oat.cover?.code === "oat-linen" && oat.cover.stock && !oat.madeToOrder && oat.listMinor === "234700");
    const u = await price(MARIA, { layout: "5pc-u" });
    t.ok("geometry: a U runs up the left, along the back and down the right (wider than deep)", u.widthIn === 134 && u.depthIn === 102 && u.seats === 8, `${u.widthIn} × ${u.depthIn}`);
    const two = await price(MARIA, { layout: "2pc-sofa-chaise" });
    t.ok("price: no bundle discount below the family's three pieces", two.bundleDiscountMinor === "0" && two.totalMinor === "179800");
    const custom = await price(MARIA, { pieces: ["laf-sofa", "wedge", "raf-loveseat", "ottoman"] });
    t.ok("geometry: an ottoman stands free in front and is not in the overall size", custom.widthIn === 140 && custom.depthIn === 114 && custom.geometry.pieces.some((p) => p.free)
      && /custom/.test(custom.layoutName));

    // ------------------------------------------------------------ option rules
    const theater = (opts: unknown[][]) => price(MARIA, { layout: "5pc-theater", pieceOptions: opts });
    await t.throws("rules: requires: a power headrest without power recline is refused", () => theater([[{ group: "headrest", option: "power-headrest" }]]), /Hudson LAF chair: A power headrest needs power recline/);
    await t.throws("rules: only on: recline on the console is refused", () => theater([[], [], [{ group: "recline", option: "power" }]]), /Recline is offered on sofas, loveseats and chairs only/);
    await t.throws("rules: a piece that reclines by itself takes no recline option", () => theater([[], [{ group: "recline", option: "manual" }]]), /already has power recline/);
    const ok1 = await theater([[{ group: "recline", option: "power" }, { group: "headrest", option: "power-headrest" }], [{ group: "headrest", option: "power-headrest" }], [{ group: "usb", option: "usb-c" }], [], []]);
    t.ok("rules: power recline plus headrest on a chair, a headrest on a power recliner, USB on the console: all allowed and priced",
      ok1.pieces[0].optionsMinor === "50000" && ok1.pieces[1].optionsMinor === "15000" && ok1.pieces[2].optionsMinor === "4000" && ok1.madeToOrder, ok1.pieces.map((x) => x.optionsMinor).join(","));
    await t.throws("rules: only on: USB on a sofa is refused", () => price(MARIA, { ...layout3, pieceOptions: [[{ group: "usb", option: "usb-c" }]] }), /USB charging is built into the console and the chairs only/);
    const mat = (ch: Record<string, string>) => RP.post(t, MARIA, "/pos/price", { productId: MATTRESS, choices: ch }) as Promise<{ unitPriceMinor: bigint }>;
    await t.throws("rules: excludes: a pillow top in firm is refused (mattress)", () => mat({ size: "queen", firmness: "firm", topper: "pillow-top" }), /pillow top is not made in firm/);
    await t.throws("rules: requires: an adjustable base on a twin is refused (mattress size)", () => mat({ size: "twin", firmness: "plush", base: "adjustable" }), /queen and king only/);
    const mq = await mat({ size: "queen", firmness: "plush", topper: "pillow-top", base: "adjustable" });
    t.ok("rules: a queen with a pillow top and an adjustable base prices with every adder", mq.unitPriceMinor === 69900n + 40000n + 15000n + 79900n, String(mq.unitPriceMinor));
    await t.throws("rules: requires: two leaves need the 72 inch table", () => RP.post(t, MARIA, "/pos/price", { productId: TABLE, choices: { size: "60", leaves: "two" } }), /72 inch table only/);
    await t.throws("rules: requires: the 500 lb lift needs the dual motor", () => RP.post(t, MARIA, "/pos/price", { productId: LIFT, choices: { lift: "lift-500", motor: "single" } }), /needs the dual motor/);
    const rule = await R.post(t, ANA, "/cfg/rules", { productId: TABLE, group: "leaves", option: "one", kind: "excludes", targetGroup: "size", targetOptions: "60", message: "The 60 inch table takes no leaf." }) as { id: string };
    await t.throws("rules: a rule the buyer adds applies at once", () => RP.post(t, MARIA, "/pos/price", { productId: TABLE, choices: { size: "60", leaves: "one" } }), /takes no leaf/);
    await t.throws("rules: retiring a rule needs a reason", () => R.post(t, ANA, `/cfg/rules/${rule.id}/retire`, {}), /Say why/);
    await R.post(t, ANA, `/cfg/rules/${rule.id}/retire`, { reason: "vendor now makes it" });
    t.ok("rules: once retired the choice sells again", !!(await RP.post(t, MARIA, "/pos/price", { productId: TABLE, choices: { size: "60", leaves: "one" } })));
    await t.throws("rules: a rule about an option the product does not have is refused", () => R.post(t, ANA, "/cfg/rules", { productId: TABLE, group: "leaves", option: "nine", kind: "requires", targetGroup: "size" }), /nine is not a leaves option/);

    // ------------------------------------------------------------ a register session
    let ses = (await read<{ id: string }>(`select s.id from pos_session s where s.entity_id = $1 and s.location_id = $2 and s.status = 'open' order by s.opened_at limit 1`, [ENTITY, LOC.ENOLA]))[0];
    if (!ses) {
      const reg = (await read<{ id: string }>(`select r.id from pos_register r where r.entity_id = $1 and r.location_id = $2 and r.active
        and not exists (select 1 from pos_session s where s.register_id = r.id and s.status = 'open') limit 1`, [ENTITY, LOC.ENOLA]))[0];
      ses = await RP.post(t, LUIS, "/pos/sessions", { registerId: reg.id, float: "500.00" }) as { id: string };
    }
    const addr = (await read<{ id: string }>(`select id from customer_address where entity_id = $1 and customer_id = $2 order by id limit 1`, [ENTITY, ALICIA]))[0].id;
    const view = async (id: string) => (await RP.get(t, `/pos/orders/${id}`)) as Record<string, unknown> & { total_minor: string; paid_minor: string; lines: { id: string; sku: string; net_minor: string; tax_minor: string; line_status: string }[] };
    const payAll = async (id: string, method = "card") => {
      const v = await view(id);
      return RP.post(t, LUIS, `/pos/orders/${id}/checkout`, { sessionId: ses.id, tenders: [{ method, amount: dollars(BigInt(v.total_minor) - BigInt(v.paid_minor)), reference: method === "card" ? "4242" : undefined }] }) as
        Promise<{ status: string; reserved: number; onOrder: number; delivery: { booked: boolean; setWarning?: string | null; cubeFt?: number; weightLb?: number; note?: string } | null }>;
    };
    const slots = async (items: string) => ((await RF.get(t, `/fleet/availability?address=${addr}&items=${items}&days=28`)) as { slots: { day: string; windowId: string; fits: boolean; locked: boolean }[] })
      .slots.filter((x) => x.fits && !x.locked);

    // ------------------------------------------------------------ POS: one configured line, a line per piece, reserved per piece
    const before = { ls: await level(PIECE.LS, DC), wg: await level(PIECE.WG, DC), rl: await level(PIECE.RL, DC) };
    const open = await slots(`${PIECE.LS}:1,${PIECE.WG}:1,${PIECE.RL}:1`);
    const sa = await RP.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: ALICIA, shipAddressId: addr, sessionId: ses.id,
      delivery: open[0] ? { day: open[0].day, windowId: open[0].windowId } : null, promisedOn: open[0]?.day ?? plus(10),
      lines: [{ productId: FAM, qty: 1, fulfillment: "delivery", sectional: { ...layout3, cover: "oat-linen" } }] }) as { id: string };
    const saLines = (await orderLines(sa.id)).filter((l) => Object.values(PIECE).includes(l.product_id));
    const saSet = (await setOf(sa.id))[0];
    t.ok("POS: the sectional is one configured set made of three component lines, each its own SKU", saLines.length === 3 && saSet?.lines.length === 3
      && saLines.map((l) => l.sku).join(",") === "CUW-HUD-LS,CUW-HUD-WG,CUW-HUD-RL" && saSet.layout_name === "3-pc LAF sofa / wedge / RAF loveseat", saLines.map((l) => l.sku).join(","));
    t.ok("POS: the component lines add up to the sectional's price", saLines.reduce((a, l) => a + BigInt(l.unit_price_minor) * BigInt(Math.round(Number(l.qty))) - BigInt(l.discount_minor), 0n) === BigInt(oat.totalMinor)
      && saSet.total_minor === oat.totalMinor);
    const sac = await payAll(sa.id);
    const after = { ls: await level(PIECE.LS, DC), wg: await level(PIECE.WG, DC), rl: await level(PIECE.RL, DC) };
    t.ok("POS: checkout reserves each piece at the DC, one apiece", after.ls.reserved === before.ls.reserved + 1 && after.wg.reserved === before.wg.reserved + 1
      && after.rl.reserved === before.rl.reserved + 1 && (await orderLines(sa.id)).filter((l) => Object.values(PIECE).includes(l.product_id)).every((l) => l.line_status === "reserved"), js(sac));
    t.ok("delivery: the stop's cube and weight are the pieces' own, summed (55 + 38 + 40 cu ft, 140 + 85 + 105 lb)", sac.delivery?.booked === true && sac.delivery.cubeFt === 133 && sac.delivery.weightLb === 330
      && saSet.cubicFt === 133 && saSet.weightLb === 330, js(sac.delivery));
    t.ok("delivery: the whole set on the truck raises no warning", sac.delivery?.booked === true && !sac.delivery.setWarning);

    // ------------------------------------------------------------ a partial delivery warns
    const sb2 = await RP.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: ALICIA, shipAddressId: addr, sessionId: ses.id,
      delivery: open[1] ? { day: open[1].day, windowId: open[1].windowId } : (open[0] ? { day: open[0].day, windowId: open[0].windowId } : null), promisedOn: (open[1] ?? open[0])?.day ?? plus(10),
      lines: [{ productId: FAM, qty: 1, fulfillment: "delivery", sectional: { pieces: ["laf-sofa", "corner", "raf-loveseat"] } }] }) as { id: string };
    const sbc = await payAll(sb2.id);
    const sbl = await orderLines(sb2.id);
    t.ok("partial: the corner no store holds goes on order; the other two pieces are reserved", sbl.find((l) => l.product_id === PIECE.CR)?.line_status === "on_order"
      && sbl.filter((l) => l.product_id === PIECE.LS || l.product_id === PIECE.RL).every((l) => l.line_status === "reserved"));
    t.ok("partial: booking the two that are ready warns that the sectional goes as a set, naming the piece left behind", sbc.delivery?.booked === true
      && /sold and delivered as a set, but 1 of its pieces is not on this one: CUW-HUD-CR \(still on order\)/.test(sbc.delivery.setWarning ?? ""), js(sbc.delivery));

    // ------------------------------------------------------------ special order: one PO line per piece, with the choices
    const sc = await RP.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: ALICIA, shipAddressId: addr, promisedOn: plus(45),
      lines: [{ productId: FAM, qty: 1, fulfillment: "delivery", sectional: { ...layout3, cover: "navy-velvet", pieceOptions: [[{ group: "recline", option: "power" }]] } }] }) as { id: string };
    await payAll(sc.id);
    const scl = (await orderLines(sc.id)).filter((l) => Object.values(PIECE).includes(l.product_id));
    t.ok("special order: a cover that is not stocked puts every piece on order, none reserved", scl.length === 3 && scl.every((l) => l.line_status === "on_order"));
    const queue = (await RPU.get(t, "/purchasing/special-orders")) as { lines: { sales_line_id: string }[] };
    t.ok("special order: each piece waits in the buyer's queue on its own", scl.every((l) => queue.lines.some((x) => x.sales_line_id === l.id)));
    const placed = await RPU.post(t, ANA, "/purchasing/special-orders", { lineIds: scl.map((l) => l.id) }) as { poId?: string; placed?: { poId: string }[] } & Record<string, unknown>;
    const poLines = await read<{ product_id: string; description: string; unit_price_minor: string; config: Record<string, { code?: string; grade?: string; vendorCode?: string; options?: { code: string }[] }>; po: string }>(`
      select pl.product_id, pl.description, pl.unit_price_minor::text, pl.config, pl.purchase_order_id po from purchase_order_line pl
       join po_line_sales_line k on k.purchase_order_line_id = pl.id and k.active where pl.entity_id = $1 and k.sales_order_line_id = any($2) order by pl.seq`, [ENTITY, scl.map((l) => l.id)]);
    t.ok("special order: one PO line per piece, to the vendor, on one PO", poLines.length === 3 && new Set(poLines.map((x) => x.po)).size === 1
      && poLines.map((x) => x.product_id).join(",") === [PIECE.LS, PIECE.WG, PIECE.RL].join(","), js(placed).slice(0, 200));
    t.ok("special order: each PO line carries the cover, its grade and the factory code", poLines.every((x) => x.config.cover?.code === "navy-velvet" && x.config.cover?.grade === "B" && /VV-NAV/.test(x.description)));
    t.ok("special order: the piece's option rides on its own PO line with its code, and the cost is the graded cost", poLines[0].config.cfg?.options?.[0]?.code === "power" && /RCL-P/.test(poLines[0].description)
      && poLines[0].unit_price_minor === String(45000 + 7000 + 16000) && poLines[1].unit_price_minor === String(25000 + 4000), poLines.map((x) => `${x.unit_price_minor} ${x.description}`).join(" | "));

    // ------------------------------------------------------------ sold as a set: a piece comes off a draft with the rest
    const dr = await RP.post(t, MARIA, "/pos/orders", { kind: "quote", locationId: LOC.ENOLA, customerId: ALICIA, shipAddressId: addr, promisedOn: plus(20),
      lines: [{ productId: FAM, qty: 1, fulfillment: "delivery", sectional: layout3 }] }) as { id: string };
    const drl = (await orderLines(dr.id)).filter((l) => Object.values(PIECE).includes(l.product_id));
    const vd = await RP.post(t, MARIA, `/pos/orders/${dr.id}/lines/${drl[1].id}/void`, { reason: "customer wants to think" }) as { voided: number };
    t.ok("set: voiding one piece of a sectional takes the whole set off", vd.voided === 3 && (await orderLines(dr.id)).filter((l) => Object.values(PIECE).includes(l.product_id)).every((l) => l.line_status === "cancelled"));
    await t.throws("set: a sectional is sold one at a time", () => RP.post(t, MARIA, "/pos/orders", { kind: "quote", locationId: LOC.ENOLA, customerId: ALICIA,
      lines: [{ productId: FAM, qty: 2, fulfillment: "delivery", sectional: layout3 }] }), /sold one at a time/);
    await t.throws("set: the family cannot be rung up without its pieces", () => RP.post(t, MARIA, "/pos/orders", { kind: "quote", locationId: LOC.ENOLA, customerId: ALICIA,
      lines: [{ productId: FAM, qty: 1, fulfillment: "delivery" }] }), /built from pieces: choose a layout or the pieces/);

    // ------------------------------------------------------------ pickup, partial hand-over, and a return by piece
    for (const pid of [PIECE.LS, PIECE.WG, PIECE.RL]) await asPerson(DEE, (c, co, a) => inv.adjust(c, scopeOf(co, a), { locationId: LOC.ENOLA, productId: pid, qty: 1, reasonCode: "found", note: "check stock" }));
    const pk = await RP.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: ALICIA, sessionId: ses.id, promisedOn: plus(1),
      lines: [{ productId: FAM, qty: 1, fulfillment: "pickup", sectional: layout3 }] }) as { id: string };
    await payAll(pk.id, "cash");
    const pkl = (await orderLines(pk.id)).filter((l) => Object.values(PIECE).includes(l.product_id));
    t.ok("pickup: each piece is reserved at the store", pkl.every((l) => l.line_status === "reserved" && l.fulfil_from_id === LOC.ENOLA));
    const part = await RP.post(t, LUIS, `/pos/orders/${pk.id}/fulfil`, { lineIds: [pkl[0].id, pkl[2].id], sessionId: ses.id }) as { setWarning: string | null };
    t.ok("partial: handing over two pieces of three warns, naming the wedge", /1 of its pieces is not on this one: CUW-HUD-WG/.test(part.setWarning ?? ""), String(part.setWarning));
    const rest = await RP.post(t, LUIS, `/pos/orders/${pk.id}/fulfil`, { lineIds: [pkl[1].id], sessionId: ses.id }) as { setWarning: string | null };
    t.ok("partial: the last piece completes the set, no warning", !rest.setWarning);
    const wg0 = await level(PIECE.WG, LOC.ENOLA), ls0 = await level(PIECE.LS, LOC.ENOLA);
    const pv = await view(pk.id);
    const wgLine = pv.lines.find((l) => l.id === pkl[1].id)!;
    const ret = await RP.post(t, LUIS, `/pos/orders/${pk.id}/return`, { sessionId: ses.id, lines: [{ lineId: wgLine.id, qty: 1, reason: "changed_mind", disposition: "restock" }],
      tenders: [{ method: "cash", amount: dollars(BigInt(wgLine.net_minor) + BigInt(wgLine.tax_minor)) }] }) as { id: string; refundMinor: bigint };
    const retLines = await orderLines(ret.id);
    t.ok("return by piece: the wedge alone comes back, its own line refunded at its share of the set price", retLines.filter((l) => Number(l.qty) < 0 && Object.values(PIECE).includes(l.product_id)).length === 1
      && retLines.some((l) => l.product_id === PIECE.WG && Number(l.qty) === -1) && ret.refundMinor === BigInt(wgLine.net_minor) + BigInt(wgLine.tax_minor), js({ retLines, ret }).slice(0, 400));
    t.ok("return by piece: the wedge is back on the shelf; the sofa stays sold", (await level(PIECE.WG, LOC.ENOLA)).onHand === wg0.onHand + 1 && (await level(PIECE.LS, LOC.ENOLA)).onHand === ls0.onHand);
    const pkSet = (await setOf(pk.id))[0];
    t.ok("return by piece: the set still shows all three pieces, each with its own story", pkSet.lines.length === 3 && pkSet.lines.filter((l) => l.line_status === "fulfilled").length >= 2);

    // ------------------------------------------------------------ the web customizer
    const site = await tx(sys, async (c) => (await shop.siteBySlug(c, "riverside-home"))!);
    const pub = await tx(sys, (c) => shop.pubProduct(c, site, FAM));
    t.ok("web: the sectional page carries the builder: pieces, popular layouts, covers and rules, and no cost or vendor codes", !!pub?.sectional && pub.sectional.layouts.length >= 3
      && pub.sectional.covers.length >= 4 && !js(pub.sectional).includes("costMinor") && !js(pub.sectional).includes("vendorCode")
      && !pub.sectional.covers.some((x) => x.code === "tweed-retired") && pub.options.length === 0);
    const wp = await tx(sys, (c) => shop.pubSectionalPrice(c, site, FAM, shop.parseBuild({ ...layout3, cover: "navy-velvet" })));
    t.ok("web: the customizer's price is the register's, with the plan", wp.totalMinor === nv.totalMinor && wp.widthIn === 140 && !("costMinor" in wp) && wp.availability.state === "made_to_order", `${wp.totalMinor}`);
    await t.throws("web: the customizer refuses a layout that cannot be built", () => tx(sys, (c) => shop.pubSectionalPrice(c, site, FAM, shop.parseBuild({ pieces: ["raf-sofa", "laf-sofa"] }))), /left end is the RAF sofa/);
    await t.throws("web: a sectional in the cart needs its pieces", () => tx(sys, (c) => shop.saveCart(c, site, "cfg-cart-nopieces", [{ productId: FAM, qty: 1 }]).then((r) => { if (r.problems.length) throw new Error(r.problems[0].error); return r; })), /Choose the pieces/);
    const cart = await tx(sys, (c) => shop.saveCart(c, site, "cfg-cart-0001", [{ productId: FAM, qty: 1, sectional: { ...layout3, cover: "navy-velvet" } }]));
    t.ok("web: the cart holds the sectional as one line, with its plan", cart.lines.length === 1 && cart.lines[0].unitPriceMinor === nv.totalMinor && (cart.lines[0] as { plan?: { seats: number } }).plan?.seats === 6);
    const placedWeb = await tx(sys, (c) => shop.placeWebOrder(c, site, shop.parseCheckout({ cartId: "cfg-web-0001", email: "cfg@example.com", name: "Sectional Buyer", phone: "555-555-0199",
      fulfillment: "delivery", address: { line1: "9 Elm St", city: "Maple Grove", state: "PA", postal: "00111" }, paymentToken: "tok_test_visa_4242",
      lines: [{ productId: FAM, qty: 1, sectional: { ...layout3, cover: "navy-velvet" } }] }), { tenantId: TENANT, entityId: ENTITY, actor: sys }));
    const webId = (await read<{ id: string }>(`select id from sales_order where entity_id = $1 and channel = 'web' and external_ref = 'cfg-web-0001'`, [ENTITY]))[0]?.id;
    t.ok("web: the sectional order is placed and paid", !!webId && !placedWeb.duplicate);
    const wl = (await orderLines(webId)).filter((l) => Object.values(PIECE).includes(l.product_id));
    const wset = (await setOf(webId))[0];
    t.ok("web: checkout writes a line per piece and records the set from the web", wl.length === 3 && wset?.channel === "web" && wset.lines.length === 3 && wset.total_minor === nv.totalMinor);
    t.ok("web: pieces in a made-to-order cover go on order for purchasing", wl.every((l) => l.line_status === "on_order"));

    // ------------------------------------------------------------ the endless aisle
    const ah = await RS.post(t, MARIA, "/shop/aisle/handoff", { locationId: LOC.ENOLA, customerId: ALICIA, lines: [{ productId: FAM, qty: 1, sectional: { layout: "2pc-sofa-chaise" } }] }) as { id: string; totalMinor: string };
    const aset = (await setOf(ah.id))[0];
    t.ok("aisle: the tablet hands the register a draft with a line per piece and the set", aset?.channel === "aisle" && aset.lines.length === 2 && ah.totalMinor === two.totalMinor, `${ah.totalMinor}`);

    // ------------------------------------------------------------ condition grades
    const free = await read<{ label: string; price_minor: string; product_id: string }>(`select distinct on (x.unit_id) x.label, p.price_minor, x.product_id from inv_piece x join product p on p.id = x.product_id
      where x.entity_id = $1 and x.status = 'in_stock' and x.sales_order_line_id is null and x.carton_seq = 1 and p.price_minor > 0 and p.status = 'active' order by x.unit_id, x.label limit 2`, [ENTITY]);
    t.ok("condition: there are free pieces to grade", free.length === 2);
    const [p1, p2] = free;
    const g1 = await R.post(t, DEE, `/cfg/condition/${p1.label}/grade`, { grade: "good", source: "floor_sample", notes: "light wear on the arms" }) as Awaited<ReturnType<typeof cfg.conditionOf>>;
    t.ok("condition: a floor sample graded good is priced at 70% of retail", g1.current?.grade === "good" && g1.current.price_minor === String((BigInt(p1.price_minor) * 7000n + 5000n) / 10000n)
      && g1.status === "in_stock", js(g1.current).slice(0, 160));
    await t.throws("condition: a piece in regular stock must say what it is", () => R.post(t, DEE, `/cfg/condition/${p2.label}/grade`, { grade: "fair" }), /as-is piece, a floor sample or a return/);
    const g2 = await R.post(t, DEE, `/cfg/condition/${p2.label}/grade`, { grade: "fair", source: "as_is", notes: "tear under the cushion" }) as Awaited<ReturnType<typeof cfg.conditionOf>>;
    const fairAuto = (BigInt(p2.price_minor) * 5000n + 5000n) / 10000n;
    const tag0 = (await read<{ status: string; as_is_price_minor: string | null }>(`select status, as_is_price_minor from inv_piece where entity_id = $1 and label = $2`, [ENTITY, p2.label]))[0];
    t.ok("condition: graded as-is, the piece is marked as-is at 50% of retail on its tag", g2.status === "as_is" && tag0.status === "as_is" && tag0.as_is_price_minor === String(fairAuto));
    await t.throws("condition: the warehouse cannot set a price by hand", () => R.post(t, DEE, `/cfg/condition/${p2.label}/grade`, { grade: "fair", price: "123.00", reason: "x" }), /needs a store manager/);
    await t.throws("condition: a price by hand needs a reason", () => R.post(t, MGR, `/cfg/condition/${p2.label}/grade`, { grade: "fair", price: "123.00" }), /Say why the price differs/);
    const g3 = await R.post(t, MGR, `/cfg/condition/${p2.label}/grade`, { grade: "fair", price: "123.00", reason: "matching the outlet" }) as Awaited<ReturnType<typeof cfg.conditionOf>>;
    const tag1 = (await read<{ as_is_price_minor: string }>(`select as_is_price_minor from inv_piece where entity_id = $1 and label = $2`, [ENTITY, p2.label]))[0];
    t.ok("condition: the manager's price and reason win, the tag follows, and the earlier grading is kept", g3.current?.price_minor === "12300" && g3.current.override_reason === "matching the outlet"
      && g3.current.auto_price_minor === String(fairAuto) && tag1.as_is_price_minor === "12300" && g3.history.length === 2 && g3.history.filter((h) => !h.superseded_at).length === 1);
    await t.throws("condition: a grading is never edited in place", () => tx(sys, (c) => c.query(`update inv_condition set grade = 'new' where entity_id = $1 and label = $2`, [ENTITY, p2.label])), /not changed; grade the piece again/);
    const posView = await RP.get(t, `/pos/products/${p2.product_id}`) as { asIs: { label: string; grade: string; gradeWords: string; price_minor: string }[] };
    t.ok("condition: POS shows the piece's grade and tag price", posView.asIs.some((x) => x.label === p2.label && x.gradeWords === "Fair" && x.price_minor === "12300"));
    const tags = await R.get(t, `/cfg/asis/tags?labels=${p2.label}`) as { gradeWords: string; priceMinor: string; barcode: { bars: number[] } }[];
    t.ok("condition: the as-is tag shows the grade, the price and the barcode", tags[0]?.gradeWords === "Fair" && tags[0].priceMinor === "12300" && tags[0].barcode.bars.length > 10);
    const rep = await R.get(t, "/cfg/asis/report") as { grades: { grade: string; pieces: number; priceMinor: string; byAge: { bucket: string; pieces: number }[] }[]; items: { label: string; grade: string | null; age_days: number }[] };
    const fairRow = rep.grades.find((g) => g.grade === "fair")!;
    t.ok("report: as-is stock by grade and age lists the piece under fair, in the newest age bucket", fairRow.pieces >= 1 && rep.items.some((x) => x.label === p2.label && x.grade === "fair" && x.age_days === 0)
      && fairRow.byAge[0].pieces >= 1 && rep.grades.find((g) => g.grade === "good")!.pieces >= 1);
    await t.throws("grade rules: a worse grade cannot sell for more than a better one", () => R.post(t, PEOPLE.CONTROLLER, "/cfg/condition/rules", { good: 90 }), /Good cannot sell for more of retail than Like new/);
    const nr = await R.post(t, PEOPLE.CONTROLLER, "/cfg/condition/rules", { fair: 45 }) as Record<string, number>;
    const g4 = await R.post(t, DEE, `/cfg/condition/${p1.label}/grade`, { grade: "fair", source: "floor_sample" }) as Awaited<ReturnType<typeof cfg.conditionOf>>;
    t.ok("grade rules: the controller sets the company's percent, and the next grading uses it", nr.fair === 4500 && g4.current?.price_minor === String((BigInt(p1.price_minor) * 4500n + 5000n) / 10000n));

    // ------------------------------------------------------------ set-up through the routes
    const nf = await R.post(t, ANA, "/cfg/families", { sku: "CUW-TEST-SECT", name: "Test sectional", vendorId: V.CUSTOM ?? "66666666-0000-0000-0000-0000000000a4", price: "999.00", bundlePct: 0 }) as { id: string };
    await R.post(t, ANA, `/cfg/families/${nf.id}/pieces`, { code: "laf-love", pieceType: "laf_loveseat", widthIn: 60, depthIn: 36, seats: 2, sku: "CUW-TEST-LL", name: "Test LAF loveseat", price: "500.00", cost: "200.00", cubicFt: 30, weightLb: 80 });
    await R.post(t, ANA, `/cfg/families/${nf.id}/pieces`, { code: "raf-love", pieceType: "raf_loveseat", widthIn: 60, depthIn: 36, seats: 2, sku: "CUW-TEST-RL", name: "Test RAF loveseat", price: "500.00", cost: "200.00" });
    await t.throws("set-up: a piece of an unknown kind is refused", () => R.post(t, ANA, `/cfg/families/${nf.id}/pieces`, { code: "x", pieceType: "beanbag", widthIn: 1, depthIn: 1 }), /Pick the kind of piece/);
    await R.post(t, ANA, `/cfg/families/${nf.id}/layouts`, { code: "2pc", name: "2-pc loveseats", pieces: "laf-love,raf-love" });
    const np = await R.post(t, MARIA, "/cfg/price", { productId: nf.id, sectional: { layout: "2pc" } }) as Priced;
    t.ok("set-up: a family made through the routes, with its pieces as new SKUs, prices its layout", np.totalMinor === "100000" && np.widthIn === 120 && np.seats === 4 && np.cover === null);

    // ============================================================ review fixes
    // ---- MAP: the bundle discount never takes a piece below its MAP (plus grade and options)
    await read(`update product set map_minor = 54000 where id = $1 and entity_id = $2`, [PIECE.WG, ENTITY]);
    const mp = await price(MGR, layout3);
    await read(`update product set map_minor = null where id = $1 and entity_id = $2`, [PIECE.WG, ENTITY]);
    const wgPiece = mp.pieces.find((x) => x.code === "wedge")!;
    t.ok("MAP: the wedge's share of the bundle discount stops at its MAP; the other pieces keep theirs", wgPiece.netMinor === "54000"
      && BigInt(mp.bundleDiscountMinor) === BigInt(mp.listMinor) - BigInt(mp.totalMinor) && BigInt(mp.bundleDiscountMinor) < 11735n, `${wgPiece.netMinor} ${mp.bundleDiscountMinor}`);
    t.ok("costs: a store manager sees piece costs; sales does not", "costMinor" in mp && "costMinor" in mp.pieces[0] && !("costMinor" in nv) && !("costMinor" in nv.pieces[0]));
    const famRead = await R.get(t, `/cfg/families/${FAM}`) as { pieces: Record<string, unknown>[] };
    t.ok("costs: the family read hides piece costs from a reader who is not a buyer, manager or controller", famRead.pieces.length > 0 && famRead.pieces.every((x) => !("costMinor" in x)));

    // ---- trade pricing: the list prices each piece, the grade % goes on the list price, the bundle after
    const tradeList = (await read<{ id: string }>(`select id from price_list where entity_id = $1 and code = 'TRADE'`, [ENTITY]))[0].id;
    const tcust = (await read<{ id: string }>(`insert into customer (entity_id, number, name, email, kind) values ($1, 'C-CFG-TRADE', 'Cfg Design Studio', 'cfg-trade@example.com', 'business') returning id /* unscoped: test set-up insert */`, [ENTITY]))[0].id;
    await read(`insert into customer_address (entity_id, customer_id, label, line1, city, state, postal, is_default) values ($1,$2,'Studio','5 Market St','Maple Grove','PA','00111',true) /* unscoped: test set-up insert */`, [ENTITY, tcust]);
    const tacct = (await read<{ id: string }>(`insert into trade_account (entity_id, number, customer_id, company_name, kind, contact_name, email, price_list_id)
      values ($1, 'TA-CFG-1', $2, 'Cfg Design Studio', 'designer', 'Dana Cfg', 'cfg-trade@example.com', $3) returning id /* unscoped: test set-up insert */`, [ENTITY, tcust, tradeList]))[0].id;
    await read(`insert into price_list_item (entity_id, price_list_id, product_id, price_minor) values ($1,$2,$3,70000)
      on conflict (price_list_id, product_id) do update set price_minor = 70000 /* unscoped: test set-up insert */`, [ENTITY, tradeList, PIECE.LS]);
    const tp = await tx(sys, (c) => cfg.priceBuild(c, ENTITY, FAM, { ...layout3, cover: "stone-boucle" }, { priceList: "TRADE" }));
    const [tLS, tWG, tRL] = tp.parts;
    t.ok("trade: a piece with a list price takes the percent grade on the list price (70.00 + 20%), not on retail", tLS.grossMinor === 84000n && tLS.priceList === "TRADE", String(tLS.grossMinor));
    t.ok("trade: a piece priced by the list's rule (living room: cost + 35%) prices the graded piece", tWG.grossMinor === (30000n * 13500n + 5000n) / 10000n && tRL.grossMinor === (43200n * 13500n + 5000n) / 10000n,
      `${tWG.grossMinor} ${tRL.grossMinor}`);
    t.ok("trade: the bundle discount comes after the trade prices", tp.listMinor === tLS.grossMinor + tWG.grossMinor + tRL.grossMinor && tp.bundleDiscountMinor === (tp.listMinor * 500n + 5000n) / 10000n);
    const tAddr = (await read<{ id: string }>(`select id from customer_address where entity_id = $1 and customer_id = $2`, [ENTITY, tcust]))[0].id;
    const ts = await RP.post(t, MARIA, "/pos/orders", { kind: "quote", locationId: LOC.ENOLA, customerId: tcust, shipAddressId: tAddr, promisedOn: plus(30),
      lines: [{ productId: FAM, qty: 1, fulfillment: "delivery", sectional: { ...layout3, cover: "stone-boucle" } }, { productId: "77777777-0000-0000-0000-000000000009", qty: 1, fulfillment: "carry" }] }) as { id: string };
    const tsl = await orderLines(ts.id);
    const lamp = (await tx(sys, (c) => import("../../packages/core/pricing.ts").then((m) => m.priceConfigured(c, ENTITY, "77777777-0000-0000-0000-000000000009", [], { priceList: "TRADE" })))).unitPriceMinor;
    t.ok("trade at the register: a trade customer's sectional rings at the trade price, piece by piece", tsl.filter((l) => Object.values(PIECE).includes(l.product_id))
      .reduce((a, l) => a + BigInt(l.unit_price_minor), 0n) === tp.totalMinor, tsl.map((l) => l.unit_price_minor).join(","));
    t.ok("trade at the register: any other product rings at the customer's list price too", BigInt(tsl.find((l) => l.product_id === "77777777-0000-0000-0000-000000000009")!.unit_price_minor) === lamp && lamp < 5999n);
    const tq = await price(MARIA, { ...layout3, cover: "stone-boucle" });
    const tqc = await R.post(t, MARIA, "/cfg/price", { productId: FAM, customerId: tcust, sectional: { ...layout3, cover: "stone-boucle" } }) as Priced & { priceList: string | null };
    t.ok("trade at the register: the builder prices by the customer's list when the customer has one", tqc.totalMinor === tp.totalMinor.toString() && tqc.priceList === "TRADE" && tq.totalMinor !== tqc.totalMinor);

    // ---- a room project with a sectional can be ordered
    const projects = await import("../../packages/core/projects.ts");
    const trade = await import("../../packages/core/trade.ts");
    const tscope = { tenantId: TENANT, entityId: ENTITY, actor: sys };
    const proj = await tx(sys, (c) => projects.createProject(c, tscope, { name: "Den", customerId: tcust, tradeAccountId: tacct }));
    const projId = typeof proj === "string" ? proj : (proj as { id: string }).id;
    await t.throws("project: a sectional goes on a project with its build", () => tx(sys, (c) => projects.addItem(c, tscope, projId, { productId: FAM })), /Choose the pieces and cover/);
    await tx(sys, (c) => projects.addItem(c, tscope, projId, { productId: FAM, sectional: { ...layout3, cover: "stone-boucle" } }));
    const pv2 = await tx(sys, (c) => projects.project(c, ENTITY, projId, {}, "TRADE"));
    t.ok("project: the sectional item keeps its build and is priced at the trade price", pv2!.items[0].sectional?.cover === "stone-boucle" && pv2!.items[0].unitPriceMinor === tp.totalMinor.toString());
    const session = { accountId: tacct, customerId: tcust, entityId: ENTITY, priceList: "TRADE", company: "Cfg Design Studio", email: "cfg-trade@example.com", contact: "Dana Cfg", repId: null };
    const site2 = await tx(sys, async (c) => (await shop.siteBySlug(c, "riverside-home"))!);
    const pq2 = await tx(sys, (c) => trade.quoteOrder(c, site2, session, { projectId: projId, fulfillment: "delivery", shipTo: "address", payBy: "card", cartId: "cfg-proj-0001",
      address: { line1: "5 Market St", city: "Maple Grove", state: "PA", postal: "00111" } }));
    const pieceLines = (pq2.lines as { productId: string; unitPriceMinor: string }[]).filter((l) => Object.values(PIECE).includes(l.productId));
    t.ok("project: checking out the project orders the sectional as its pieces, at the trade price", pieceLines.length === 3
      && pieceLines.reduce((a, l) => a + BigInt(l.unitPriceMinor), 0n) === tp.totalMinor, js(pq2.lines).slice(0, 200));

    // ---- vendor exports carry the piece's option codes
    const pur = await import("../../packages/core/purchasing.ts");
    t.ok("exports: a piece's option codes and cover code are read from its config", pur.vendorCodesOf({ cover: { vendorCode: "VV-NAV" }, cfg: { options: [{ vendorCode: "RCL-P" }] } }).join(",") === "VV-NAV,RCL-P");
    const csv = await asPerson(ANA, (c, co, a) => pur.exportForVendor(c, scopeOf(co, a), "66666666-0000-0000-0000-0000000000a4", { poId: poLines[0].po }));
    t.ok("exports: the CSV for the vendor sends the piece's option code with the cover's", /VV-NAV\|RCL-P/.test(csv.csv), csv.csv.split("\r\n")[1]?.slice(0, 200));

    // ---- dye lots: a set's pieces match as one group; two sets in different covers do not
    const keyOf = (lineId: string) => tx(sys, (c) => inv.lineLotKey(c, ENTITY, lineId));
    const kA = await Promise.all(saLines.map((l) => keyOf(l.id)));
    const kC = await keyOf(scl[0].id);
    t.ok("lots: a set's three pieces share one matching group, the set and its cover", !!kA[0] && kA.every((k) => k === kA[0]) && /^SET CS-\d+ \| COVER=OAT-LINEN$/.test(kA[0]!), kA.join(" / "));
    t.ok("lots: another set in another cover is another group", !!kC && kC !== kA[0] && /COVER=NAVY-VELVET/.test(kC), String(kC));
    t.ok("lots: the pieces are matched by dye lot, like their family", (await read<{ n: string }>(`select count(*) n from product where entity_id = $1 and id = any($2) and lot_class = 'dye_lot'`, [ENTITY, Object.values(PIECE)]))[0].n === "6");
    const npc = (await read<{ lot_class: string | null }>(`select lot_class from product where entity_id = $1 and sku = 'CUW-TEST-LL'`, [ENTITY]))[0];
    t.ok("lots: a piece set up through the configurator takes its family's lot class", npc?.lot_class === "dye_lot");

    // ---- the web shows a stocked sectional as stocked
    const ws = await tx(sys, (c) => shop.pubSectionalPrice(c, site2, FAM, shop.parseBuild(layout3)));
    t.ok("web: a sectional whose pieces are all in stock is not shown as on order", !["made_to_order", "backorder"].includes(ws.availability.state), ws.availability.state);
    const wsc = await tx(sys, (c) => shop.pubSectionalPrice(c, site2, FAM, shop.parseBuild({ pieces: ["laf-sofa", "corner", "raf-loveseat"] })));
    t.ok("web: one piece on order makes the set wait for it (the latest piece)", wsc.availability.state === "backorder", wsc.availability.state);

    // ---- the truck is sized by the pieces
    const fleet = await import("../../packages/core/fleet.ts");
    const sized = await tx(sys, (c) => fleet.availabilityForCart(c, ENTITY, addr, [PIECE.LS, PIECE.WG, PIECE.RL].map((productId) => ({ productId, qty: 1 }))));
    t.ok("delivery days: the finder sized by the pieces counts their cube and weight", sized.size.cube === 133 && sized.size.weight === 330, js(sized.size));

    // ---- an as-is piece rings at its graded price, and that piece goes out
    const asl = await RP.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: ALICIA, shipAddressId: addr, promisedOn: plus(5),
      lines: [{ productId: p2.product_id, qty: 1, fulfillment: "delivery", asIsLabel: p2.label }] }) as { id: string; pendingOverrides: string[] };
    const asLine = (await orderLines(asl.id)).find((l) => l.product_id === p2.product_id)!;
    t.ok("as-is at the register: the graded piece rings at its tag price, with no below-cost override", asLine.unit_price_minor === "12300" && !asl.pendingOverrides.length);
    await payAll(asl.id);
    const onLine = (await read<{ mine: boolean }>(`select x.unit_id = (select unit_id from inv_piece where entity_id = $1 and label = $3) mine
      from inv_piece x where x.entity_id = $1 and x.sales_order_line_id = $2`, [ENTITY, asLine.id, p2.label])).map((x) => x.mine);
    t.ok("as-is at the register: checkout puts that very piece (all its cartons) on the line", onLine.length >= 1 && onLine.every(Boolean), String(onLine));
    await t.throws("as-is at the register: a sold piece cannot be rung again", () => RP.post(t, MARIA, "/pos/orders", { kind: "quote", locationId: LOC.ENOLA, customerId: ALICIA,
      lines: [{ productId: p2.product_id, qty: 1, fulfillment: "delivery", asIsLabel: p2.label }] }), /cannot be sold as is/);
    const labelsMod = await import("../../packages/core/labels.ts");
    const ptags = await tx(sys, (c) => labelsMod.forPriceTags(c, ENTITY, { productIds: [p1.product_id] }));
    const gtag = ptags.labels.find((l) => (l as { barcode: string }).barcode === p1.label) as { sale: string | null; condition: string | null } | undefined;
    t.ok("price tags: a graded piece gets its own tag with the graded price and the grade", !!gtag && gtag.sale === `$${(Number(g4.current!.price_minor) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
      && gtag.condition === "As is: Fair", js(gtag));

    // ------------------------------------------------------------ vendor catalog extras (832 and feeds)
    const sorted = cfg.extrasFromRows([{ vendor_sku: "Z-LCH", name: "Z chaise", sectional_family: "ZED", piece_type: "LAF Chaise", width: "36" },
      { swatch_code: "zed-red", grade: "c", cover_name: "Zed red" }, { vendor_sku: "Z-LAMP", name: "Lamp" }]);
    t.ok("feeds: a cover row is not a product; a piece row is a product and a piece", sorted.productRows.length === 2 && sorted.extras.length === 2
      && sorted.extras.some((e) => e.kind === "piece" && e.pieceType === "laf_chaise" && e.widthIn === 36) && sorted.extras.some((e) => e.kind === "swatch" && e.grade === "c"));
    t.ok("feeds: vendor piece words map to ours", cfg.pieceTypeFrom("RAF LOVESEAT") === "raf_loveseat" && cfg.pieceTypeFrom("Armless Chair") === "armless_chair"
      && cfg.pieceTypeFrom("WEDGE") === "wedge" && cfg.pieceTypeFrom("left arm facing sofa") === "laf_sofa" && cfg.pieceTypeFrom("chaise") === null);
    const segs = x12.build832({ catalogId: "COA-SECT-1", date: plus(0), items: [
      { vendorSku: "MAXX-LS", description: "Maxx LAF sofa", costMinor: 40000n, widthIn: 92, depthIn: 40, heightIn: 36, weightLb: 150,
        sectional: { family: "MAXX", familyName: "Maxx", piece: "LAF SOFA", seats: 3, gradeAdders: [{ grade: "B", priceMinor: 12000n }] } },
      { vendorSku: "MAXX-RL", description: "Maxx RAF loveseat", costMinor: 33000n, widthIn: 66, depthIn: 40, heightIn: 36, weightLb: 110, sectional: { family: "MAXX", piece: "RAF LOVESEAT" } },
      { vendorSku: "TWEED-BLU", description: "Tweed, blue", swatch: { grade: "B", color: "Blue", colorFamily: "blue", content: "Wool blend", cleaning: "S" } }] });
    const parsed = x12.parse832(segs);
    t.ok("832: the sectional piece, its grade adder and the cover survive the round trip", !parsed.errors.length && parsed.items[0].sectional?.family === "MAXX" && parsed.items[0].sectional.piece === "LAF SOFA"
      && parsed.items[0].sectional.gradeAdders?.[0]?.priceMinor === 12000n && parsed.items[2].swatch?.grade === "B" && parsed.items[2].swatch.color === "Blue", js(parsed.errors));
    const partner = (await read<{ id: string }>(`select id from edi_partner where entity_id = $1 and vendor_id = $2 limit 1`, [ENTITY, V.COASTER]))[0];
    if (partner) {
      const text = x12.writeInterchange({ sender: { qual: "01", id: "COASTERUSA" }, receiver: { qual: "ZZ", id: "BUDDYSHF" }, gsSender: "COASTERUSA", gsReceiver: "BUDDYSHF", version: "004010",
        usage: "P", isaControl: 9431, gsControl: 9431 }, [{ type: "832", control: 1, segments: segs }], x12.DEFAULT_SEPARATORS, { newline: true });
      const er = catRoutes(t, ediModule as never);
      const got = await er.post<{ documents: { status: string; reason?: string | null; summary?: Record<string, unknown> }[] }>("/edi/upload", ANA, { text, filename: "832-sect.edi" });
      const pcs = await read<{ code: string; piece_type: string; width_in: string; sku: string; family: string }>(`select sp.code, sp.piece_type, sp.width_in::text, p.sku, f.name family
        from sectional_piece sp join product p on p.id = sp.product_id join product f on f.id = sp.family_id where sp.entity_id = $1 and p.vendor_id = $2 order by sp.code`, [ENTITY, V.COASTER]);
      const sw = await read<{ grade_code: string; color_family: string; cleaning_code: string }>(`select s.grade_code, s.color_family, s.cleaning_code from swatch s join fabric_grade_table g on g.id = s.grade_table_id
        where s.entity_id = $1 and g.vendor_id = $2 and s.code = 'tweed-blu'`, [ENTITY, V.COASTER]);
      const adder = await read<{ price_adder_minor: string }>(`select a.price_adder_minor from fabric_grade_adder a join fabric_grade g on g.id = a.grade_id join fabric_grade_table tb on tb.id = g.table_id
        where a.entity_id = $1 and tb.vendor_id = $2 and g.code = 'B' and a.piece_type = 'laf_sofa'`, [ENTITY, V.COASTER]);
      t.ok("832 in: the pieces are set up under one family made from the vendor's model, with their sizes", got.documents[0]?.status === "applied" && pcs.length === 2
        && pcs.some((p) => p.piece_type === "laf_sofa" && Number(p.width_in) === 92) && pcs.some((p) => p.piece_type === "raf_loveseat") && new Set(pcs.map((p) => p.family)).size === 1,
        js({ d: got.documents[0], pcs }).slice(0, 300));
      t.ok("832 in: the cover lands in the vendor's grade table, and the piece's grade adder too", sw.length === 1 && sw[0].grade_code === "B" && sw[0].color_family === "blue" && sw[0].cleaning_code === "S"
        && adder[0]?.price_adder_minor === "12000");
      const notProduct = await read(`select 1 from product where entity_id = $1 and vendor_id = $2 and upper(vendor_sku) = 'TWEED-BLU'`, [ENTITY, V.COASTER]);
      t.ok("832 in: a cover is not made a product", notProduct.length === 0);
    } else t.ok("832 in: the Coaster EDI partner from the edi checks is there", false);
  } finally { c0.release(); }
}
