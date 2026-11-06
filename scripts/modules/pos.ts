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
import { routesOf, companyOf } from "./inventory.ts";

const R = routesOf(module as never);
const DC = "33333333-0000-0000-0000-0000000000dc";
const LUIS = "55555555-0000-0000-0000-000000000012";     // cashier
const MARIA = "55555555-0000-0000-0000-000000000011";    // sales
const MGR = "55555555-0000-0000-0000-000000000018";      // store manager + sales
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
    const lw = await R.post(t, MARIA, "/pos/orders", { kind: "layaway", locationId: LOC.ENOLA, customerId: CUST.BRIAN, lines: [{ productId: P.DRESSER, qty: 1 }] }) as { id: string };
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

    // ------------------------------------------------------- close and Z report
    await R.post(t, LUIS, `/pos/sessions/${ses.id}/cash`, { kind: "drop", amount: "100.00" });
    await t.throws("drawer: a paid out needs a note", () => R.post(t, LUIS, `/pos/sessions/${ses.id}/cash`, { kind: "paid_out", amount: "5" }), /say what the cash was for/);
    const z0 = await R.get(t, `/pos/sessions/${ses.id}/z`) as Awaited<ReturnType<typeof pos.zReport>>;
    const expected = z0.cash.expectedMinor;
    t.ok("Z: expected cash is float + cash taken − refunds − drops", expected === 20000n + 12718n + 12000n - 6359n - 10000n, String(expected));
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
