// POS checks: drawer sessions and the Z report, cash-and-carry, delivery with
// add-ons and split salespeople, manager overrides, tax exemption, quotes,
// configurable items, layaway, returns and exchanges, cancellation with a
// refund, signatures, the GL behind all of it, and entity isolation.
import type { T } from "./harness.ts";
import { ENTITY, RIO_ENTITY, LOC, PEOPLE } from "./harness.ts";
import { tx, type Scope } from "../../packages/core/db.ts";
import * as pos from "../../packages/core/pos.ts";
import * as inv from "../../packages/core/inventory.ts";
import { module } from "../../server/modules/pos.ts";
import { module as invModule } from "../../server/modules/inventory.ts";
import { module as purModule } from "../../server/modules/purchasing.ts";
import { module as fleetModule } from "../../server/modules/fleet.ts";
import { routesOf, companyOf } from "./inventory.ts";

const R = routesOf(module as never);
const RI = routesOf(invModule as never);
const RP = routesOf(purModule as never);
const RF = routesOf(fleetModule as never);
const RAY = "55555555-0000-0000-0000-000000000014";     // dispatcher
const DC = "33333333-0000-0000-0000-0000000000dc";
const LUIS = "55555555-0000-0000-0000-000000000012";     // cashier
const MARIA = "55555555-0000-0000-0000-000000000011";    // sales
const MGR = "55555555-0000-0000-0000-000000000018";      // store manager + sales
const DEE = "55555555-0000-0000-0000-000000000013";      // warehouse
const REG = "9a9a0000-0000-0000-0000-000000000001";      // Enola front counter
const CUST = { ALICIA: "88888888-0000-0000-0000-000000000001", BRIAN: "88888888-0000-0000-0000-000000000002", RIVERSIDE: "88888888-0000-0000-0000-000000000005" };
const P = { SOFA: "77777777-0000-0000-0000-000000000001", DRESSER: "77777777-0000-0000-0000-000000000004", RECLINER: "77777777-0000-0000-0000-000000000007",
  LAMP: "77777777-0000-0000-0000-000000000009", HUDSON: "77777777-0000-0000-0000-000000000010", DELIVERY: "77777777-0000-0000-0000-000000000011",
  PROTECT: "77777777-0000-0000-0000-000000000012" };
const plus = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
type Order = Awaited<ReturnType<typeof pos.orderView>> & Record<string, unknown>;

export async function run(t: T) {
  const c0 = await t.pool.connect();
  const read = <X extends Record<string, unknown>>(sql: string, p: unknown[] = []) => t.q<X>(c0, sql, p);
  const level = async (pid: string, loc: string) => {
    const x = (await read<{ on_hand: string; reserved: string; held: string }>(`select on_hand, reserved, held from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`,
      [ENTITY, pid, loc]))[0] ?? { on_hand: "0", reserved: "0", held: "0" };
    return { onHand: Number(x.on_hand), reserved: Number(x.reserved), held: Number(x.held) };
  };
  const je = async (sourceId: string, type?: string) => read<{ code: string; debit_minor: string; credit_minor: string }>(`
    select g.code, jl.debit_minor, jl.credit_minor from journal_entry je join journal_line jl on jl.journal_entry_id = je.id join gl_account g on g.id = jl.gl_account_id
     where je.entity_id = $1 and je.source_id = $2 and ($3::text is null or je.source_type = $3)`, [ENTITY, sourceId, type ?? null]);
  const net = (rows: { code: string; debit_minor: string; credit_minor: string }[], code: string) =>
    rows.filter((r) => r.code === code).reduce((a, r) => a + BigInt(r.debit_minor) - BigInt(r.credit_minor), 0n);
  const view = async (id: string) => (await R.get(t, `/pos/orders/${id}`)) as Order;

  try {
    // ------------------------------------------------------------- the drawer
    await t.throws("drawer: sales cannot open a register", () => R.post(t, MARIA, "/pos/sessions", { registerId: REG, float: "200.00" }), /opening a register needs one of: cashier, store manager/);
    const ses = await R.post(t, LUIS, "/pos/sessions", { registerId: REG, float: "200.00" }) as { id: string; number: string };
    t.ok("drawer: the cashier opens a session with a float", !!ses.id);
    await t.throws("drawer: one open session per register", () => R.post(t, LUIS, "/pos/sessions", { registerId: REG, float: "0" }), /already has session .* open/);

    // -------------------------------------------------------- cash and carry
    const lamp0 = await level(P.LAMP, LOC.ENOLA);
    const cc = await R.post(t, LUIS, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, sessionId: ses.id,
      lines: [{ productId: P.LAMP, qty: 2, fulfillment: "carry" }], salespeople: [{ id: MARIA, splitPct: 100 }] }) as { id: string; number: string };
    const cco = await R.post(t, LUIS, `/pos/orders/${cc.id}/checkout`, { sessionId: ses.id, tenders: [{ method: "cash", amount: "150.00" }] }) as Awaited<ReturnType<typeof pos.checkout>>;
    t.ok("carry: total is two lamps plus 6% Enola tax", cco.totalMinor === 12718n, String(cco.totalMinor));
    t.ok("carry: cash over the total gives change", cco.changeMinor === 2282n && cco.paidMinor === 12718n);
    t.ok("carry: handed over on the spot, order fulfilled", cco.handedOver === 1 && cco.status === "fulfilled");
    const lamp1 = await level(P.LAMP, LOC.ENOLA);
    t.ok("carry: store stock down two, nothing left reserved", lamp1.onHand === lamp0.onHand - 2 && lamp1.reserved === lamp0.reserved);
    const sale = await je(cc.id, "sale");
    t.ok("carry: the sale posts revenue, tax and cost of goods", net(sale, "4000") === -11998n && net(sale, "2100") === -720n && net(sale, "5000") === 3800n && net(sale, "2300") === 12718n);
    const rcpt = await read<{ id: string }>(`select id from customer_receipt where entity_id = $1 and sales_order_id = $2`, [ENTITY, cc.id]);
    const rj = await je(rcpt[0].id);
    t.ok("carry: every receipt posts through A/R (Dr 1050 Cr 2300)", net(rj, "1050") === 12718n && net(rj, "2300") === -12718n);
    await t.throws("carry: a made-to-order item cannot be taken today", () => R.post(t, LUIS, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA,
      lines: [{ productId: P.HUDSON, qty: 1, fulfillment: "carry", choices: { size: "84", fabric: "linen-oat", legs: "walnut" } }] }), /cannot be taken today/);
    const noStock = await R.post(t, LUIS, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, lines: [{ productId: P.SOFA, qty: 3, fulfillment: "carry" }] }) as { id: string };
    await t.throws("carry: take-with needs the stock here", () => R.post(t, LUIS, `/pos/orders/${noStock.id}/checkout`, { sessionId: ses.id,
      tenders: [{ method: "cash", amount: "3000" }] }), /not in stock here to take with/);

    // ------------------------------------------ delivery, add-ons and split
    await t.throws("delivery: needs a promised date", () => R.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.ALICIA,
      lines: [{ productId: P.SOFA, qty: 2, fulfillment: "delivery" }] }), /needs a promised date/);
    await t.throws("split: the shares must add to 100%", () => R.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.ALICIA,
      promisedOn: plus(7), lines: [{ productId: P.SOFA, qty: 2, fulfillment: "delivery" }], salespeople: [{ id: MARIA, splitPct: 60 }, { id: MGR, splitPct: 30 }] }), /add up to 90%, not 100%/);
    const sofaDc0 = await level(P.SOFA, DC);
    const dv = await R.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.ALICIA, promisedOn: plus(7),
      lines: [{ productId: P.SOFA, qty: 2, fulfillment: "delivery" }, { productId: P.DELIVERY, qty: 1 }, { productId: P.PROTECT, qty: 1, fulfillment: "delivery" }],
      salespeople: [{ id: MARIA, splitPct: 60 }, { id: MGR, splitPct: 40 }] }) as { id: string; number: string };
    const dvo = await R.post(t, MARIA, `/pos/orders/${dv.id}/checkout`, { sessionId: ses.id, tenders: [{ method: "card", amount: "500.00", reference: "4242" }] }) as Awaited<ReturnType<typeof pos.checkout>>;
    const dvv = await view(dv.id);
    t.ok("delivery: two sofas the store lacks are reserved at the DC", (await level(P.SOFA, DC)).reserved === sofaDc0.reserved + 2 && dvo.reserved === 1);
    t.ok("delivery: the order carries the address and promised date", dvv.fulfillment === "delivery" && !!dvv.ship_line1 && dvv.promised_on === plus(7));
    t.ok("delivery: fee and protection plan ride along as lines", (dvv.lines as { sku: string }[]).some((l) => l.sku === "SVC-DELIVERY") && (dvv.lines as { sku: string }[]).some((l) => l.sku === "SVC-PROTECT-5Y"));
    t.ok("split: both salespeople and their shares are kept", (dvv.salespeople as { split_bps: number }[]).length === 2 && (dvv.salespeople as { split_bps: number }[]).reduce((a, x) => a + x.split_bps, 0) === 10000);
    t.ok("delivery: a deposit is a liability, not a sale", (await je(dv.id, "sale")).length === 0 && dvo.balanceMinor > 0n);
    await t.throws("card: never more than the last four digits", () => R.post(t, MARIA, `/pos/orders/${dv.id}/pay`, { sessionId: ses.id,
      tenders: [{ method: "card", amount: "10", reference: "4111111111111111" }] }), /last four digits/);
    await t.throws("card: cannot be more than is owed", () => R.post(t, MARIA, `/pos/orders/${dv.id}/pay`, { sessionId: ses.id,
      tenders: [{ method: "card", amount: "99999" }] }), /cannot be more than the/);

    // ------------------------------------------- delivery booked at the sale
    const addr = (await read<{ id: string }>(`select id from customer_address where entity_id = $1 and customer_id = $2 order by id limit 1`, [ENTITY, CUST.ALICIA]))[0].id;
    const av = await RF.get(t, `/fleet/availability?address=${addr}&items=${P.SOFA}:1&days=21`) as { zone: { name: string }; slots: { day: string; windowId: string; label: string; fits: boolean; locked: boolean }[] };
    const open = av.slots.filter((x) => x.fits && !x.locked);
    t.ok("at the sale: the salesperson sees open windows for the customer's zone, sized from the cart", !!av.zone.name && open.length > 1, `${open.length} open`);
    const slotA = open[0], slotB = open.find((x) => x.day !== slotA.day)!;
    const bs = await R.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.ALICIA, shipAddressId: addr,
      delivery: { day: slotA.day, windowId: slotA.windowId }, lines: [{ productId: P.SOFA, qty: 1, fulfillment: "delivery" }] }) as { id: string };
    const bso = await R.post(t, MARIA, `/pos/orders/${bs.id}/checkout`, { sessionId: ses.id, tenders: [{ method: "card", amount: "300.00", reference: "4242" }] }) as Awaited<ReturnType<typeof pos.checkout>>;
    const stopA = (await read<{ id: string; scheduled_on: string; confirmed_at: string | null; booked_from: string }>(`select id, scheduled_on::text scheduled_on, confirmed_at, booked_from from delivery_stop
      where entity_id = $1 and sales_order_id = $2 and status = 'scheduled'`, [ENTITY, bs.id]))[0];
    t.ok("at the sale: placing it books the stop on the picked day, waiting for the delivery manager", !!bso.delivery?.booked && stopA?.scheduled_on === slotA.day
      && !stopA.confirmed_at && stopA.booked_from === "sale" && (await view(bs.id)).promised_on === slotA.day, JSON.stringify(bso.delivery));
    await RF.post(t, MARIA, `/fleet/stops/${stopA.id}/reschedule`, { day: slotB.day, windowId: slotB.windowId });
    t.ok("before it is confirmed, the salesperson can still move it", (await read<{ d: string }>(`select scheduled_on::text d from delivery_stop where id = $1 and entity_id = $2`, [stopA.id, ENTITY]))[0].d === slotB.day);
    await t.throws("only the delivery manager confirms", () => RF.post(t, MARIA, `/fleet/stops/${stopA.id}/confirm`), /dispatcher|store manager/);
    await RF.post(t, RAY, `/fleet/stops/${stopA.id}/confirm`);
    await t.throws("once confirmed, the salesperson cannot move it", () => RF.post(t, MARIA, `/fleet/stops/${stopA.id}/reschedule`, { day: slotA.day, windowId: slotA.windowId }), /confirmed by the delivery manager/);
    await t.throws("once confirmed, the salesperson cannot cancel it", () => RF.post(t, MARIA, `/fleet/stops/${stopA.id}/cancel`, { reason: "customer asked" }), /confirmed by the delivery manager/);
    const lk = await RF.post(t, RAY, "/fleet/days/lock", { day: slotA.day }) as { confirmed: number };
    t.ok("locking a day confirms what is still waiting on it", typeof lk.confirmed === "number");
    const av2 = await RF.get(t, `/fleet/availability?address=${addr}&items=${P.SOFA}:1&days=21`) as typeof av;
    t.ok("a locked day shows as locked at the register", av2.slots.filter((x) => x.day === slotA.day).every((x) => x.locked));
    const bl = await R.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.ALICIA, shipAddressId: addr,
      delivery: { day: slotA.day, windowId: slotA.windowId }, lines: [{ productId: P.SOFA, qty: 1, fulfillment: "delivery" }] }) as { id: string };
    const blo0 = await R.post(t, MARIA, `/pos/orders/${bl.id}/checkout`, { sessionId: ses.id, tenders: [{ method: "card", amount: "300.00", reference: "4242" }] }) as Awaited<ReturnType<typeof pos.checkout>>;
    t.ok("a locked day does not stop the sale: it is placed, unbooked, and the salesperson is told why", blo0.status !== "draft" && blo0.delivery?.booked === false
      && /locked by the delivery manager/.test(String(blo0.delivery?.note)), JSON.stringify(blo0.delivery));
    await t.throws("the salesperson cannot pick the locked day again from the order", () => R.post(t, MARIA, `/pos/orders/${bl.id}/delivery-day`, { day: slotA.day, windowId: slotA.windowId }),
      /locked by the delivery manager/);
    await t.throws("opening a locked day needs a reason", () => RF.post(t, RAY, "/fleet/days/unlock", { day: slotA.day }), /say why/);
    await RF.post(t, RAY, "/fleet/days/unlock", { day: slotA.day, reason: "extra truck" });
    const blo = await R.post(t, MARIA, `/pos/orders/${bl.id}/delivery-day`, { day: slotA.day, windowId: slotA.windowId }) as { booked: boolean };
    t.ok("once opened again, picking the day from the order books it", !!blo.booked && (await view(bl.id)).delivery_stop != null);
    const lwd = await R.post(t, MARIA, "/pos/orders", { kind: "layaway", locationId: LOC.ENOLA, customerId: CUST.ALICIA, shipAddressId: addr,
      delivery: { day: slotB.day, windowId: slotB.windowId }, lines: [{ productId: P.SOFA, qty: 1, fulfillment: "delivery" }] }) as { id: string };
    const lwdo = await R.post(t, MARIA, `/pos/orders/${lwd.id}/checkout`, { sessionId: ses.id, tenders: [{ method: "card", amount: "300.00", reference: "4242" }] }) as Awaited<ReturnType<typeof pos.checkout>>;
    t.ok("a layaway is not put on a truck until it is paid in full", lwdo.delivery?.booked === false && /paid in full/.test(String(lwdo.delivery?.note)));
    const lwdv = await view(lwd.id);
    await R.post(t, MARIA, `/pos/orders/${lwd.id}/pay`, { sessionId: ses.id, tenders: [{ method: "card", amount: String(Number(lwdv.balance_minor) / 100), reference: "4242" }] });
    t.ok("paying the layaway off books the day it asked for", (await view(lwd.id)).delivery_stop != null);
    for (const o of [bs.id, bl.id, lwd.id]) await R.post(t, MGR, `/pos/orders/${o}/cancel`, { reason: "check cleanup", sessionId: ses.id, refundMethod: "card", reference: "4242" });
    const liveStops = await read<{ n: string }>(`select count(*) n from delivery_stop where entity_id = $1 and sales_order_id = any($2) and status <> 'cancelled'`, [ENTITY, [bs.id, bl.id, lwd.id]]);
    t.ok("cancelling the sale cancels its booked delivery", liveStops[0].n === "0");

    // ------------------------------------------------------- manager override
    const ov = await R.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.BRIAN,
      lines: [{ productId: P.RECLINER, qty: 1, fulfillment: "carry", discountPct: 25 }] }) as { id: string; pendingOverrides: string[] };
    t.ok("override: 25% off is flagged past the 10% limit", ov.pendingOverrides.length === 1 && /25% off is past the 10% limit/.test(ov.pendingOverrides[0]));
    await t.throws("override: cannot check out until a manager allows it", () => R.post(t, MARIA, `/pos/orders/${ov.id}/checkout`, { sessionId: ses.id,
      tenders: [{ method: "card", amount: "600" }] }), /needs a manager's override/);
    const ovLine = ((await view(ov.id)).lines as { id: string }[])[0].id;
    await t.throws("override: sales cannot allow it", () => R.post(t, MARIA, `/pos/orders/${ov.id}/override`, { lineId: ovLine, reason: "loyal customer" }), /a price override needs one of: store manager/);
    await t.throws("override: needs a reason", () => R.post(t, MGR, `/pos/orders/${ov.id}/override`, { lineId: ovLine, reason: "" }), /say why/);
    await R.post(t, MGR, `/pos/orders/${ov.id}/override`, { lineId: ovLine, reason: "Matching competitor ad" });
    const ovv = await view(ov.id);
    const ovRow = (ovv.overrides as { approved_by: string; reason: string; requested_by: string }[])[0];
    t.ok("override: who allowed it and why is recorded", ovRow.approved_by === "Enola manager" && ovRow.reason === "Matching competitor ad" && ovRow.requested_by === "Maria (sales)");
    const ovo = await R.post(t, MARIA, `/pos/orders/${ov.id}/checkout`, { sessionId: ses.id, tenders: [{ method: "card", amount: String(Number((ovv.total_minor as string)) / 100), reference: "1881" }] }) as { status: string };
    t.ok("override: once allowed the sale goes through", ovo.status === "fulfilled");
    const bc = await R.post(t, MGR, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.BRIAN, overrideReason: "Damaged box, manager call",
      lines: [{ productId: P.LAMP, qty: 1, fulfillment: "carry", discount: "50.00" }] }) as { id: string; pendingOverrides: string[] };
    const bcv = await view(bc.id);
    t.ok("override: a manager ringing below cost records their own override with the reason", bc.pendingOverrides.length === 0
      && /below cost/.test((bcv.overrides as { detail: string }[])[0]?.detail ?? ""));

    // ------------------------------------------------------------- packages
    // A package (catalog's kind 'kit') sells as its components. Without the
    // catalog module's tables this is checked in a transaction that is rolled back.
    const ROLLBACK = new Error("rollback");
    let kitLines: { sku: string; unit_price_minor: string; qty: string; package_sku: string | null }[] = [];
    try {
      await tx({ kind: "user", id: MGR, label: "test" }, async (c) => {
        await c.query(`alter table product drop constraint if exists product_kind_check`);
        await c.query(`create table if not exists product_kit_component (entity_id uuid not null, kit_id uuid not null, component_id uuid not null,
          qty numeric(8,2) not null, seq smallint not null default 1, primary key (kit_id, component_id))`);
        const kit = (await t.q<{ id: string }>(c, `insert into product (entity_id, sku, name, kind, price_minor, cost_minor) values ($1,'PKG-DINE-5','Andrea 5-piece dining','kit',79999,0)
          returning id`, [ENTITY]))[0].id;
        await c.query(`insert into product_kit_component (entity_id, kit_id, component_id, qty, seq) values ($1,$2,'77777777-0000-0000-0000-000000000005',1,1),
          ($1,$2,'77777777-0000-0000-0000-000000000006',2,2)`, [ENTITY, kit]);
        const co = await companyOf();
        const o = await pos.createOrder(c, { tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "user", id: MGR, label: "test" } }, new Set(["store_manager"]),
          { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.ALICIA, promisedOn: plus(5), lines: [{ productId: kit, qty: 1, fulfillment: "delivery" }] });
        kitLines = await t.q(c, `select l.sku, l.unit_price_minor, l.qty, pl.package_sku from sales_order_line l join pos_line pl on pl.sales_order_line_id = l.id
          where l.entity_id = $1 and l.sales_order_id = $2 order by l.seq`, [ENTITY, o.id]);
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    const feeLines = kitLines.filter((l) => !l.package_sku);
    kitLines = kitLines.filter((l) => l.package_sku);
    t.ok("delivery fee: a package going by delivery picks up the zone's fee on its own", feeLines.length === 1 && feeLines[0].unit_price_minor === "9900");
    const pkgTotal = kitLines.reduce((a, l) => a + Math.round(Number(l.qty) * Number(l.unit_price_minor)), 0);
    t.ok("package: sells as its components, each stocked on its own", kitLines.length === 2 && kitLines.every((l) => l.package_sku === "PKG-DINE-5"));
    t.ok("package: the components carry the package price between them", Math.abs(pkgTotal - 79999) <= 2, String(pkgTotal));

    // ------------------------------------------------------------ tax exempt
    const ex = await R.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.RIVERSIDE, taxExemptRef: "PA-REV-1220-0042871",
      lines: [{ productId: P.LAMP, qty: 3, fulfillment: "pickup" }] }) as { id: string };
    t.ok("tax exempt: no tax with a certificate on file", (await view(ex.id)).tax_minor === "0");
    await t.throws("tax exempt: needs a customer", () => R.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, taxExemptRef: "X-1",
      lines: [{ productId: P.LAMP, qty: 1 }] }), /needs the customer/);

    // -------------------------------------------- quotes and configurable items
    await t.throws("configurable: a required option must be chosen", () => R.post(t, MARIA, "/pos/orders", { kind: "quote", locationId: LOC.ENOLA, customerId: CUST.ALICIA,
      promisedOn: plus(30), lines: [{ productId: P.HUDSON, qty: 1, fulfillment: "delivery", choices: { size: "96" } }] }), /choose a fabric/);
    const qt = await R.post(t, MARIA, "/pos/orders", { kind: "quote", locationId: LOC.ENOLA, customerId: CUST.ALICIA, promisedOn: plus(30),
      lines: [{ productId: P.HUDSON, qty: 1, fulfillment: "delivery", choices: { size: "96", fabric: "velvet-navy", legs: "brass" } }] }) as { id: string };
    const qv = await view(qt.id);
    t.ok("quote: the configured price is base plus options", (qv.lines as { unit_price_minor: string }[])[0].unit_price_minor === "172900");
    t.ok("quote: carries an expiry", !!qv.quote_expires_on && qv.kind === "quote");
    await t.throws("quote: cannot be checked out as is", () => R.post(t, MARIA, `/pos/orders/${qt.id}/checkout`, { sessionId: ses.id, tenders: [] }), /is a quote; convert it/);
    await R.post(t, MARIA, `/pos/orders/${qt.id}/convert`);
    const qo = await R.post(t, MARIA, `/pos/orders/${qt.id}/checkout`, { sessionId: ses.id, tenders: [{ method: "financing", amount: "500", reference: "SYN-88812" }] }) as { onOrder: number };
    t.ok("quote: converted and placed, the made-to-order sofa goes on order for purchasing", qo.onOrder === 1
      && ((await view(qt.id)).lines as { line_status: string }[])[0].line_status === "on_order");
    const old = await R.post(t, MARIA, "/pos/orders", { kind: "quote", locationId: LOC.ENOLA, customerId: CUST.ALICIA, lines: [{ productId: P.LAMP, qty: 1, fulfillment: "pickup" }] }) as { id: string; number: string };
    await tx({ kind: "system", label: "test" }, (c) => c.query(`update pos_order set quote_expires_on = current_date - 1 where sales_order_id = $1 and entity_id = $2`, [old.id, ENTITY]));
    await t.throws("quote: an expired quote will not convert", () => R.post(t, MARIA, `/pos/orders/${old.id}/convert`), /expired on/);

    // ----------------------------------------------------------------- layaway
    const dr0 = await level(P.DRESSER, LOC.ENOLA);
    const lw = await R.post(t, MARIA, "/pos/orders", { kind: "layaway", locationId: LOC.ENOLA, customerId: CUST.BRIAN, lines: [{ productId: P.DRESSER, qty: 1, fulfillment: "pickup" }] }) as { id: string };
    await t.throws("layaway: needs the minimum deposit", () => R.post(t, LUIS, `/pos/orders/${lw.id}/checkout`, { sessionId: ses.id,
      tenders: [{ method: "cash", amount: "10" }] }), /needs a deposit of at least \$116\.60/);
    await R.post(t, LUIS, `/pos/orders/${lw.id}/checkout`, { sessionId: ses.id, tenders: [{ method: "cash", amount: "120" }] });
    const lwv = await view(lw.id);
    t.ok("layaway: goods held for the customer, a payment schedule set", (await level(P.DRESSER, LOC.ENOLA)).reserved === dr0.reserved + 1
      && (lwv.layaway_schedule as unknown[]).length === 4 && (lwv.lines as { fulfillment: string }[])[0].fulfillment === "pickup");
    const lwLine = (lwv.lines as { id: string }[])[0].id;
    await t.throws("layaway: nothing leaves until paid in full", () => R.post(t, LUIS, `/pos/orders/${lw.id}/fulfil`, { lineIds: [lwLine] }), /is not paid in full/);
    const lwp = await R.post(t, LUIS, `/pos/orders/${lw.id}/pay`, { sessionId: ses.id, tenders: [{ method: "card", amount: String(Number(lwv.balance_minor) / 100), reference: "0007" }] }) as { paidOff: boolean };
    t.ok("layaway: the last payment pays it off", lwp.paidOff);
    await R.post(t, LUIS, `/pos/orders/${lw.id}/fulfil`, { lineIds: [lwLine] });
    t.ok("layaway: picked up once paid, revenue recognised then", (await view(lw.id)).status === "fulfilled" && (await je(lw.id, "sale")).length > 0
      && (await level(P.DRESSER, LOC.ENOLA)).onHand === dr0.onHand - 1);

    // ---------------------------------------------------------- returns
    const ccv = await view(cc.id);
    const lampLine = (ccv.lines as { id: string }[])[0].id;
    await t.throws("return: needs a reason code", () => R.post(t, LUIS, `/pos/orders/${cc.id}/return`, { sessionId: ses.id,
      lines: [{ lineId: lampLine, qty: 1, reason: "meh", disposition: "restock" }], tenders: [] }), /pick a return reason/);
    await t.throws("return: no more than was sold", () => R.post(t, LUIS, `/pos/orders/${cc.id}/return`, { sessionId: ses.id,
      lines: [{ lineId: lampLine, qty: 3, reason: "defective", disposition: "damage" }], tenders: [{ method: "cash", amount: "190.77" }] }), /2 can still come back, not 3/);
    await t.throws("return: the refund must match", () => R.post(t, LUIS, `/pos/orders/${cc.id}/return`, { sessionId: ses.id,
      lines: [{ lineId: lampLine, qty: 1, reason: "defective", disposition: "damage" }], tenders: [{ method: "cash", amount: "10" }] }), /the refund is \$63\.59/);
    const held0 = await level(P.LAMP, LOC.ENOLA);
    const ret = await R.post(t, LUIS, `/pos/orders/${cc.id}/return`, { sessionId: ses.id,
      lines: [{ lineId: lampLine, qty: 1, reason: "defective", disposition: "damage", note: "Cracked base" }], tenders: [{ method: "cash", amount: "63.59" }] }) as Awaited<ReturnType<typeof pos.returnGoods>>;
    t.ok("return: refund is the line plus its tax", ret.refundMinor === 6359n && ret.taxMinor === 360n);
    const rj2 = await je(ret.id, "refund");
    t.ok("return: posts Dr 4900, Dr 2100, Cr 2300 and puts the cost back", net(rj2, "4900") === 5999n && net(rj2, "2100") === 360n && net(rj2, "1300") === 1900n && net(rj2, "5000") === -1900n);
    const all2300 = await read<{ s: string }>(`select coalesce(sum(jl.debit_minor - jl.credit_minor),0)::text s from journal_line jl join journal_entry je on je.id = jl.journal_entry_id
      join gl_account g on g.id = jl.gl_account_id where je.entity_id = $1 and g.code = '2300' and je.source_id in (select id from customer_receipt where entity_id = $1 and sales_order_id = $2)`, [ENTITY, ret.id]);
    t.ok("return: the negative receipt clears the deposit (Dr 2300 Cr 1050)", BigInt(all2300[0].s) === 6359n);
    const held1 = await level(P.LAMP, LOC.ENOLA);
    t.ok("return: routed to damage, the lamp is back on hand but held", held1.onHand === held0.onHand + 1 && held1.held === held0.held + 1);
    const dmg = await read<{ n: string }>(`select count(*) n from inv_damage where entity_id = $1 and source = 'customer_return' and status = 'open'`, [ENTITY]);
    t.ok("return: a damage record opens for repair, claim or write-off", dmg[0].n === "1");
    const rv = await view(ret.id);
    t.ok("return: the return order balances to zero", rv.balance_minor === "0" && rv.total_minor === "-6359");
    // A serialized return restocks the very piece that was sold.
    const ovLabel = (await read<{ label: string }>(`select pc.label from inv_piece pc where pc.entity_id = $1 and pc.sales_order_line_id = $2`, [ENTITY, ovLine]))[0]?.label;
    const rr = await R.post(t, LUIS, `/pos/orders/${ov.id}/return`, { sessionId: ses.id, lines: [{ lineId: ovLine, qty: 1, reason: "changed_mind", disposition: "restock" }],
      tenders: [{ method: "card", amount: String(Number(ovv.total_minor) / 100), reference: "1881" }] }) as { refundMinor: bigint };
    t.ok("return: a restocked recliner is the same labelled piece, back in stock", !!ovLabel && (await inv.scan(c0, ENTITY, ovLabel)).piece.status === "in_stock" && rr.refundMinor > 0n);

    // ---------------------------------------------------------------- exchange
    await t.throws("store credit: a walk-in sale has no customer to hold credit", () => R.post(t, LUIS, `/pos/orders/${cc.id}/return`, { sessionId: ses.id,
      lines: [{ lineId: lampLine, qty: 1, reason: "wrong_item", disposition: "restock" }], tenders: [{ method: "store_credit", amount: "63.59" }] }), /needs the customer it belongs to/);
    // An exchange for a known customer: return Brian's dresser to store credit, then buy a lamp with it.
    const lwLineRet = await R.post(t, LUIS, `/pos/orders/${lw.id}/return`, { sessionId: ses.id, lines: [{ lineId: lwLine, qty: 1, reason: "changed_mind", disposition: "restock" }],
      tenders: [{ method: "store_credit", amount: String(Number((await view(lw.id)).total_minor) / 100) }] }) as { refundMinor: bigint };
    const brianCredit = await pos.storeCredit(c0, ENTITY, CUST.BRIAN);
    t.ok("exchange: Brian holds the dresser's value as store credit", brianCredit === lwLineRet.refundMinor);
    const swap = await R.post(t, LUIS, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.BRIAN, lines: [{ productId: P.LAMP, qty: 1, fulfillment: "carry" }] }) as { id: string };
    await R.post(t, LUIS, `/pos/orders/${swap.id}/checkout`, { sessionId: ses.id, tenders: [{ method: "store_credit", amount: "63.59" }] });
    t.ok("exchange: the new sale is paid with store credit", (await pos.storeCredit(c0, ENTITY, CUST.BRIAN)) === brianCredit - 6359n);
    const swap2 = await R.post(t, LUIS, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.ALICIA, lines: [{ productId: P.LAMP, qty: 1, fulfillment: "carry" }] }) as { id: string };
    await t.throws("store credit: cannot spend more than is held", () => R.post(t, LUIS, `/pos/orders/${swap2.id}/checkout`, { sessionId: ses.id,
      tenders: [{ method: "store_credit", amount: "63.59" }] }), /of store credit, not/);

    // ------------------------------------------------------------- cancel
    await t.throws("cancel: sales cannot cancel a placed order", () => R.post(t, MARIA, `/pos/orders/${dv.id}/cancel`, { reason: "Changed mind" }), /cancelling a placed order needs one of: store manager/);
    await t.throws("cancel: money taken must be refunded", () => R.post(t, MGR, `/pos/orders/${dv.id}/cancel`, { reason: "Changed mind" }), /\$500\.00 was paid; say how it is refunded/);
    const sofaDc1 = await level(P.SOFA, DC);
    await R.post(t, MGR, `/pos/orders/${dv.id}/cancel`, { reason: "Changed mind", sessionId: ses.id, refundMethod: "card", reference: "4242" });
    t.ok("cancel: the reservation is released", (await level(P.SOFA, DC)).reserved === sofaDc1.reserved - 2);
    const dvc = await view(dv.id);
    t.ok("cancel: the deposit is refunded and the order reads cancelled", dvc.status === "cancelled" && dvc.paid_minor === "0");
    const dep = await read<{ s: string }>(`select coalesce(sum(jl.debit_minor - jl.credit_minor),0)::text s from journal_line jl join journal_entry je on je.id = jl.journal_entry_id
      join gl_account g on g.id = jl.gl_account_id where je.entity_id = $1 and g.code = '2300' and je.source_id in (select id from customer_receipt where entity_id = $1 and sales_order_id = $2)`, [ENTITY, dv.id]);
    t.ok("cancel: customer deposits for the order net to zero", dep[0].s === "0");

    // ------------------------------------------------------------- signature
    await t.throws("signature: must be an image", () => R.post(t, MARIA, `/pos/orders/${qt.id}/signature`, { signature: "javascript:alert(1)" }), /must be an image/);
    await R.post(t, MARIA, `/pos/orders/${qt.id}/signature`, { signature: "data:image/png;base64,iVBORw0KGgo=", signedName: "Alicia Gomez" });
    const sv = await view(qt.id);
    t.ok("signature: kept on the order with the signer", sv.signed_name === "Alicia Gomez" && String(sv.signature_data_url).startsWith("data:image/png"));
    t.ok("audit: the order's history lists who did what", (sv.history as unknown[]).length >= 3);

    // ------------------------------------------- tie-out after selling and returns
    const tie1 = await inv.tieOut(c0, ENTITY);
    t.ok("tie-out: after sales and returns, stock at cost still equals GL 1300 + 1310", tie1.ties && tie1.quantityOutOfStep.length === 0,
      `diff ${tie1.differenceMinor}`);

    // ----------------------- special order: POS → purchasing PO → receive → transfer → pickup
    const so = await R.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.ALICIA, promisedOn: plus(30),
      lines: [{ productId: P.HUDSON, qty: 1, fulfillment: "pickup", choices: { size: "84", fabric: "linen-oat", legs: "walnut" } }] }) as { id: string; number: string };
    await R.post(t, MARIA, `/pos/orders/${so.id}/checkout`, { sessionId: ses.id, tenders: [{ method: "card", amount: "400.00", reference: "5151" }] });
    const soLine = ((await view(so.id)).lines as { id: string; line_status: string }[])[0];
    t.ok("special order: the made-to-order sofa goes on order", soLine.line_status === "on_order");
    const placed = await RP.post(t, MGR, "/purchasing/special-orders", { lineIds: [soLine.id] }) as { placed?: { poId: string }[] } | { poId: string }[];
    const poId = (Array.isArray(placed) ? placed : (placed.placed ?? (placed as unknown as { pos: { poId: string }[] }).pos ?? []))[0]?.poId
      ?? (await read<{ id: string }>(`select pol.purchase_order_id id from po_line_sales_line k join purchase_order_line pol on pol.id = k.purchase_order_line_id
           where k.entity_id = $1 and k.sales_order_line_id = $2 and k.active`, [ENTITY, soLine.id]))[0]?.id;
    t.ok("special order: purchasing places a PO tied to the customer's line", !!poId);
    const pol = (await read<{ id: string; unit: string; landed: string; qty: string }>(`select pol.id, pol.unit_price_minor::text unit, pol.landed_minor::text landed, pol.quantity::text qty
      from purchase_order_line pol join po_line_sales_line k on k.purchase_order_line_id = pol.id where k.entity_id = $1 and k.sales_order_line_id = $2`, [ENTITY, soLine.id]))[0];
    const huds0 = await level(P.HUDSON, DC);
    const rcv = await RI.post(t, DEE, "/inventory/receiving", { purchaseOrderId: poId, locationId: DC, lines: [{ poLineId: pol.id, qty: 1 }] }) as
      { lines: { reservedFor: string[]; labels: string[] }[]; valueMinor: bigint; receiptId: string };
    const afterRcv = (await view(so.id)).lines as { line_status: string; fulfil_from: string }[];
    const huds1 = await level(P.HUDSON, DC);
    const allocated = await read<{ n: string }>(`select count(*) n from inv_piece where entity_id = $1 and sales_order_line_id = $2 and status = 'reserved'`, [ENTITY, soLine.id]);
    t.ok("special order: receiving reserves it for the customer at the DC", afterRcv[0].line_status === "reserved" && afterRcv[0].fulfil_from === "Distribution center"
      && huds1.reserved === huds0.reserved + 1 && huds1.onHand === huds0.onHand + 1 && rcv.lines[0].reservedFor.includes(so.number));
    t.ok("special order: its received cartons are allocated to the customer, not free stock", Number(allocated[0].n) === rcv.lines[0].labels.length && Number(allocated[0].n) >= 1);
    const recvJe = await je(rcv.receiptId);
    t.ok("special order: the receipt posts Dr 1300 Cr 2050 at the PO's cost", net(recvJe, "1300") === BigInt(rcv.valueMinor) && net(recvJe, "2050") === -BigInt(rcv.valueMinor)
      && BigInt(rcv.valueMinor) === BigInt(pol.unit) + BigInt(Math.round(Number(pol.landed ?? 0) / Number(pol.qty))));
    const soHand0 = await R.post(t, LUIS, `/pos/orders/${so.id}/fulfil`, { lineIds: [soLine.id] }).then(() => null, (e: Error) => e.message);
    t.ok("special order: not handed over at Enola while it sits at the DC; the refusal says where it is", /reserved at Distribution center, not here at Enola/.test(soHand0 ?? ""), soHand0 ?? "handed over");
    const moveList = await RI.get(t, "/inventory/orders-to-move") as { line_id: string }[];
    t.ok("special order: it shows on the warehouse's list of customer orders to send to their store", moveList.some((x) => x.line_id === soLine.id));
    // Moved by scanning its labels: the pieces are the customer's, so the transfer carries the customer's line.
    const tr = await RI.post(t, DEE, "/inventory/transfers", { fromId: DC, toId: LOC.ENOLA, lines: [{ productId: P.HUDSON, qty: 1, labels: rcv.lines[0].labels }] }) as { id: string };
    const trl = await read<{ sales_order_line_id: string | null }>(`select sales_order_line_id from inv_transfer_line where entity_id = $1 and transfer_id = $2`, [ENTITY, tr.id]);
    t.ok("transfer by label: the customer's reserved pieces travel as their order line", trl.length === 1 && trl[0].sales_order_line_id === soLine.id);
    await RI.post(t, DEE, `/inventory/transfers/${tr.id}/ship`);
    const inTransit = (await view(so.id)).lines as { line_status: string }[];
    t.ok("special order: on its way to the store the line waits on the transfer", inTransit[0].line_status === "on_order");
    const midTie = await inv.tieOut(c0, ENTITY);
    t.ok("tie-out: with the sofa in transit, 1310 holds its value", midTie.ties && midTie.inTransitMinor === BigInt(rcv.valueMinor));
    await RI.post(t, DEE, `/inventory/transfers/${tr.id}/receive`);
    const atStore = (await view(so.id)).lines as { line_status: string; fulfil_from: string }[];
    const enolaH = await level(P.HUDSON, LOC.ENOLA);
    t.ok("special order: it lands at Enola still reserved for the customer", atStore[0].line_status === "reserved" && atStore[0].fulfil_from === "Enola" && enolaH.reserved === 1);
    const owed = (await view(so.id)).balance_minor as string;
    await R.post(t, LUIS, `/pos/orders/${so.id}/pay`, { sessionId: ses.id, tenders: [{ method: "card", amount: String(Number(owed) / 100), reference: "5151" }] });
    await R.post(t, LUIS, `/pos/orders/${so.id}/fulfil`, { lineIds: [soLine.id] });
    const done = await view(so.id);
    const saleJe = await je(so.id, "sale");
    t.ok("special order: picked up, the sale posts and every dollar of deposit is released from 2300", done.status === "fulfilled"
      && net(saleJe, "2300") === BigInt(done.total_minor as string) && net(saleJe, "1100") === 0n);
    t.ok("special order: cost of goods is exactly what the receipt put on the books", net(saleJe, "5000") === BigInt(rcv.valueMinor) && net(saleJe, "1300") === -BigInt(rcv.valueMinor));
    const tie2 = await inv.tieOut(c0, ENTITY);
    t.ok("tie-out: after the special order's whole life, the books still tie", tie2.ties && tie2.quantityOutOfStep.length === 0, `diff ${tie2.differenceMinor}`);

    // ------------- pickup sold at Enola but sourced from the DC: the review's repro (flow2t)
    const dp = await R.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.BRIAN, promisedOn: plus(40),
      lines: [{ productId: P.HUDSON, qty: 1, fulfillment: "pickup", fulfilFromId: DC, choices: { size: "96", fabric: "velvet-navy", legs: "brass" } }] }) as { id: string; number: string };
    await R.post(t, MARIA, `/pos/orders/${dp.id}/checkout`, { sessionId: ses.id, tenders: [{ method: "cash", amount: "500.00" }] });
    const dpLine = ((await view(dp.id)).lines as { id: string }[])[0].id;
    const dpPlaced = await RP.post(t, MGR, "/purchasing/special-orders", { lineIds: [dpLine] }) as { placed: { poId: string }[] };
    const dpPol = (await read<{ id: string; ship_to: string }>(`select pol.id, po.ship_to_location_id ship_to from purchase_order_line pol join purchase_order po on po.id = pol.purchase_order_id
      where pol.entity_id = $1 and pol.purchase_order_id = $2`, [ENTITY, dpPlaced.placed[0].poId]))[0];
    t.ok("DC pickup: the special order's PO ships to the DC it is sourced from", dpPol.ship_to === DC);
    await RI.post(t, DEE, "/inventory/receiving", { purchaseOrderId: dpPlaced.placed[0].poId, lines: [{ poLineId: dpPol.id, qty: 1 }] });
    t.ok("DC pickup: received at the DC and reserved there for the customer", ((await view(dp.id)).lines as { line_status: string; fulfil_from: string }[])[0].fulfil_from === "Distribution center");
    t.ok("DC pickup: it shows on the list of customer orders to send to their store", ((await RI.get(t, "/inventory/orders-to-move")) as { line_id: string }[]).some((x) => x.line_id === dpLine));
    const owedDp = BigInt((await view(dp.id)).balance_minor as string);
    await R.post(t, LUIS, `/pos/orders/${dp.id}/pay`, { sessionId: ses.id, tenders: [{ method: "card", amount: String(Number(owedDp) / 100), reference: "1111" }] });
    const early = await R.post(t, LUIS, `/pos/orders/${dp.id}/fulfil`, { lineIds: [dpLine], sessionId: ses.id }).then(() => "handed over", (e: Error) => e.message);
    t.ok("DC pickup: paid in full but still at the DC, the Enola counter refuses and says to transfer it", /reserved at Distribution center, not here at Enola; send it over first/.test(early), early);
    const delivered = await read<{ n: string }>(`select count(*) n from inv_piece where entity_id = $1 and sales_order_line_id = $2 and status = 'delivered'`, [ENTITY, dpLine]);
    t.ok("DC pickup: no piece is marked delivered while it sits at the DC", delivered[0].n === "0");
    // The warehouse moves it the plain way: product and quantity, DC → Enola.
    const dpTr = await RI.post(t, DEE, "/inventory/transfers", { fromId: DC, toId: LOC.ENOLA, lines: [{ productId: P.HUDSON, qty: 1 }] }) as { id: string };
    const shipped = await RI.post(t, DEE, `/inventory/transfers/${dpTr.id}/ship`).then(() => "shipped", (e: Error) => e.message);
    t.ok("DC pickup: a transfer of the reserved sofa ships, carrying the customer's line", shipped === "shipped", shipped);
    const transitTry = await R.post(t, LUIS, `/pos/orders/${dp.id}/fulfil`, { lineIds: [dpLine], sessionId: ses.id }).then(() => "handed over", (e: Error) => e.message);
    t.ok("DC pickup: not handed over while on the truck", /on a transfer to the store|not ready to hand over/.test(transitTry), transitTry);
    await RI.post(t, DEE, `/inventory/transfers/${dpTr.id}/receive`);
    const hEn = await level(P.HUDSON, LOC.ENOLA);
    t.ok("DC pickup: it lands at Enola reserved for the customer", ((await view(dp.id)).lines as { line_status: string; fulfil_from: string }[])[0].fulfil_from === "Enola" && hEn.reserved >= 1);
    await R.post(t, LUIS, `/pos/orders/${dp.id}/fulfil`, { lineIds: [dpLine], sessionId: ses.id });
    t.ok("DC pickup: handed over at Enola once it is there", (await view(dp.id)).status === "fulfilled");
    const tie3 = await inv.tieOut(c0, ENTITY);
    t.ok("tie-out: after the DC-sourced pickup, the books still tie", tie3.ties && tie3.quantityOutOfStep.length === 0, `diff ${tie3.differenceMinor}`);

    // ------------------------------------------------- a web order at the counter
    const web = await tx({ kind: "system", label: "test" }, async (c) => {
      const o = (await t.q<{ id: string }>(c, `insert into sales_order (entity_id, number, channel, location_id, customer_id, status, fulfillment)
        values ($1,'WEB-TEST-1','web',$2,$3,'open','pickup') returning id`, [ENTITY, LOC.ENOLA, CUST.BRIAN]))[0];
      const l = (await t.q<{ id: string }>(c, `insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, tax_minor, fulfil_from_id)
        values ($1,$2,1,$3,'ACC-LAMP-01','Ceramic table lamp',2,5999,720,$4) returning id`, [ENTITY, o.id, P.LAMP, LOC.ENOLA]))[0];
      await c.query(`select sales_order_retotal($1) /* unscoped: test order */`, [o.id]);
      await inv.reserveOrder(c, ENTITY, o.id);
      const r = (await t.q<{ id: string }>(c, `insert into customer_receipt (entity_id, number, customer_id, sales_order_id, location_id, channel, method, amount_minor, reference)
        values ($1,'R-WEB-1',$2,$3,$4,'web','card',12718,'Visa ending 9911, test test_auth_webtest1') returning id`, [ENTITY, CUST.BRIAN, o.id, LOC.ENOLA]))[0];
      // What the web store's checkout writes beside the receipt: the processor's capture.
      await c.query(`insert into shop_payment (entity_id, site_id, sales_order_id, receipt_id, provider, token_ref, brand, last4, auth_ref, amount_minor, status)
        select $1, s.id, $2, $3, 'test', 'tok_test_visa_9911', 'Visa', '9911', 'test_auth_webtest1', 12718, 'captured' from shop_site s where s.entity_id = $1 limit 1`, [ENTITY, o.id, r.id]);
      const co = await companyOf();
      const { postReceipt } = await import("../../packages/core/ar.ts");
      await postReceipt(c, { tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "system", label: "web" } }, r.id);
      return { id: o.id, line: l.id };
    });
    const webList = await R.get(t, "/pos/orders?q=WEB-TEST") as { channel: string }[];
    t.ok("web order: POS can find it", webList.length === 1 && webList[0].channel === "web");
    await R.post(t, LUIS, `/pos/orders/${web.id}/fulfil`, { lineIds: [web.line] });
    t.ok("web order: a web pickup is handed over at the counter", (await view(web.id)).status === "fulfilled" && (await je(web.id, "sale")).length > 0);
    const zCard = async () => ((await pos.zReport(c0, ENTITY, ses.id)).tenders.find((x) => x.method === "card")?.refunded ?? "0");
    const zCard0 = await zCard();
    const wret = await R.post(t, LUIS, `/pos/orders/${web.id}/return`, { sessionId: ses.id, lines: [{ lineId: web.line, qty: 1, reason: "changed_mind", disposition: "restock" }] }) as
      { refundMinor: bigint; webRefunds: { amountMinor: bigint }[] };
    const wret2 = await R.post(t, LUIS, `/pos/orders/${web.id}/return`, { sessionId: ses.id, lines: [{ lineId: web.line, qty: 1, reason: "changed_mind", disposition: "restock" }],
      tenders: [{ method: "card", amount: "63.59", reference: "9911" }] }) as { refundMinor: bigint; webRefunds: { amountMinor: bigint }[] };
    const wr = await read<{ method: string; amount_minor: string; channel: string; register_session_id: string | null; reference: string }>(`
      select r.method, r.amount_minor::text, r.channel, r.register_session_id, r.reference from customer_receipt r
        join pos_order po on po.sales_order_id = r.sales_order_id where r.entity_id = $1 and po.original_order_id = $2`, [ENTITY, web.id]);
    t.ok("web return: refunded to the card it was paid with, with or without the tender named", wret.refundMinor === 6359n && wret2.refundMinor === 6359n
      && wret.webRefunds.length === 1 && wret2.webRefunds.length === 1 && wr.length === 2 && wr.every((x) => x.method === "card" && x.amount_minor === "-6359" && /ending 9911/.test(x.reference)));
    t.ok("web return: the refund is a web receipt, kept out of the register's card batch", wr.every((x) => x.channel === "web" && x.register_session_id === null)
      && (await zCard()) === zCard0);
    const refs = await read<{ refund_ref: string; amount_minor: string }>(`select cr.refund_ref, cr.amount_minor::text from pos_card_refund cr join shop_payment sp on sp.id = cr.shop_payment_id
      where cr.entity_id = $1 and sp.sales_order_id = $2`, [ENTITY, web.id]);
    const sp = (await read<{ status: string }>(`select status from shop_payment where entity_id = $1 and sales_order_id = $2`, [ENTITY, web.id]))[0];
    t.ok("web return: the card processor refunded each, recorded against the web payment", refs.length === 2 && refs.every((x) => /^test_refund_/.test(x.refund_ref))
      && sp.status === "refunded");
    const wbad = await R.post(t, LUIS, `/pos/orders/${web.id}/return`, { sessionId: ses.id, lines: [{ lineId: web.line, qty: 1, reason: "changed_mind", disposition: "restock" }] })
      .then(() => "accepted", (e: Error) => e.message);
    t.ok("web return: nothing more comes back than was sold", /0 can still come back/.test(wbad), wbad);

    // ----------------------------------------------------- delivery fee, defaults
    const df = await R.post(t, MARIA, "/pos/orders", { kind: "sale", locationId: LOC.ENOLA, customerId: CUST.ALICIA, promisedOn: plus(6),
      lines: [{ productId: P.SOFA, qty: 1 }, { productId: P.PROTECT, qty: 1 }] }) as { id: string; deliveryFeeMinor: bigint };
    const dfv = await view(df.id);
    const dfl = dfv.lines as { id: string; sku: string; fulfillment: string; unit_price_minor: string; description: string }[];
    t.ok("defaults: a sofa with no fulfilment named goes by delivery, and its protection plan with it",
      dfl.find((l) => l.sku === "ASH-2930338")?.fulfillment === "delivery" && dfl.find((l) => l.sku === "SVC-PROTECT-5Y")?.fulfillment === "delivery");
    const feeLine = dfl.find((l) => l.sku === "SVC-DELIVERY");
    t.ok("delivery fee: added at the customer's zone rate (West Shore $99)", !!feeLine && feeLine.unit_price_minor === "9900" && /WSH/.test(feeLine.description));
    await t.throws("delivery fee: sales cannot waive it on a delivery", () => R.post(t, MARIA, `/pos/orders/${df.id}/lines/${feeLine!.id}/void`, { reason: "customer asked" }),
      /waiving the delivery fee on a delivery needs a store manager/);
    await R.post(t, MGR, `/pos/orders/${df.id}/lines/${feeLine!.id}/void`, { reason: "First-time customer promotion" });
    const dfv2 = await view(df.id);
    t.ok("delivery fee: a manager waives it, and the waiver is on record", (dfv2.overrides as { detail: string; reason: string }[]).some((o) => o.detail === "delivery fee waived")
      && !(dfv2.lines as { sku: string; line_status: string }[]).some((l) => l.sku === "SVC-DELIVERY" && l.line_status !== "cancelled"));
    const dvFees = ((await view(dv.id)).lines as { sku: string }[]).filter((l) => l.sku === "SVC-DELIVERY");
    t.ok("delivery fee: an order that already has one gets no second", dvFees.length === 1);
    const mto = await R.post(t, MARIA, "/pos/orders", { kind: "quote", locationId: LOC.ENOLA, customerId: CUST.ALICIA,
      lines: [{ productId: P.HUDSON, qty: 1, choices: { size: "84", fabric: "linen-oat", legs: "walnut" } }], promisedOn: plus(40) }) as { id: string };
    t.ok("defaults: a made-to-order sofa defaults to delivery, never take-with",
      ((await view(mto.id)).lines as { sku: string; fulfillment: string }[]).find((l) => l.sku === "CUW-SOFA-CUSTOM")?.fulfillment === "delivery");

    // ------------------------------------------------------- close and Z report
    await R.post(t, LUIS, `/pos/sessions/${ses.id}/cash`, { kind: "drop", amount: "100.00" });
    await t.throws("drawer: a paid out needs a note", () => R.post(t, LUIS, `/pos/sessions/${ses.id}/cash`, { kind: "paid_out", amount: "5" }), /say what the cash was for/);
    const z0 = await R.get(t, `/pos/sessions/${ses.id}/z`) as Awaited<ReturnType<typeof pos.zReport>>;
    const expected = z0.cash.expectedMinor;
    t.ok("Z: expected cash is float + cash taken (incl. the DC pickup deposit) − refunds − drops", expected === 20000n + 12718n + 12000n - 6359n - 10000n + 50000n, String(expected));
    t.ok("Z: tenders are broken out by method", z0.tenders.some((x) => x.method === "card") && z0.tenders.some((x) => x.method === "store_credit"));
    // Count $5 short.
    let left = expected - 500n;
    const counts: Record<string, number> = {};
    for (const d of pos.DENOMS) { const n = left / BigInt(d); if (n > 0n) { counts[String(d)] = Number(n); left -= n * BigInt(d); } }
    await t.throws("close: a short drawer needs an explanation", () => R.post(t, LUIS, `/pos/sessions/${ses.id}/close`, { counts }), /short \$5\.00; say what happened/);
    const cl = await R.post(t, LUIS, `/pos/sessions/${ses.id}/close`, { counts, note: "Gave wrong change on a cash sale" }) as Awaited<ReturnType<typeof pos.closeSession>>;
    const os = await je(ses.id);
    t.ok("close: the shortage posts Dr 6800 Cr 1050", cl.overShortMinor === -500n && net(os, "6800") === 500n && net(os, "1050") === -500n);
    await t.throws("close: a closed session takes no more money", () => R.post(t, LUIS, `/pos/orders/${swap2.id}/checkout`, { sessionId: ses.id,
      tenders: [{ method: "cash", amount: "70" }] }), /is closed/);
    await t.throws("close: a closed session cannot be changed", () => tx({ kind: "system", label: "test" }, (c) =>
      c.query(`update pos_session set float_minor = 0 where id = $1 and entity_id = $2`, [ses.id, ENTITY])), /closed register session cannot change/);
    const zFinal = await read<{ z: { cash: { overShortMinor: string } } }>(`select z_report z from pos_session where entity_id = $1 and id = $2`, [ENTITY, ses.id]);
    t.ok("Z: the report is kept with the closed session", zFinal[0].z.cash.overShortMinor === "-500");

    // ------------------------------------------------------------------ GL
    const unbalanced = await read<{ n: string }>(`select count(*) n from (select je.id from journal_entry je join journal_line jl on jl.journal_entry_id = je.id
      where je.entity_id = $1 and je.source_type in ('sale','receipt','refund') group by je.id having sum(jl.debit_minor) <> sum(jl.credit_minor)) x`, [ENTITY]);
    t.ok("GL: every sale, receipt and refund entry balances", unbalanced[0].n === "0");
    const pieceCheck = await read<{ n: string }>(`
      select count(*) n from stock_level s join product p on p.id = s.product_id
       where s.entity_id = $1 and p.serialized and s.on_hand <> (select count(distinct unit_id) from inv_piece x where x.entity_id = s.entity_id
         and x.product_id = s.product_id and x.location_id = s.location_id and x.status = any($2))`, [ENTITY, inv.ON_HAND]);
    t.ok("stock: pieces still match on hand after the POS run", pieceCheck[0].n === "0");

    // ------------------------------------------------------------- isolation
    const rio = await companyOf(RIO_ENTITY);
    const rioScope: Scope = { tenantId: rio.tenantId, entityId: RIO_ENTITY, actor: { kind: "user", id: PEOPLE.STEVE, label: "test" } };
    t.ok("isolation: another company cannot open this company's order", (await pos.orderView(c0, RIO_ENTITY, cc.id)) === null);
    t.ok("isolation: another company lists none of these orders", (await pos.listOrders(c0, RIO_ENTITY, {})).length === 0);
    await t.throws("isolation: another company cannot sell from this company's store", () => tx(rioScope.actor, (c) =>
      pos.createOrder(c, rioScope, new Set(["owner"]), { kind: "sale", locationId: LOC.ENOLA, lines: [{ productId: P.LAMP, qty: 1 }] })), /no such store/);
    await t.throws("isolation: another company cannot open this company's register", () => tx(rioScope.actor, (c) =>
      pos.openSession(c, rioScope, { registerId: REG, floatMinor: 0n })), /no such register/);
  } finally {
    c0.release();
  }
}
