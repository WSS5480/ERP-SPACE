// shop module checks: the web store, the customizer, checkout, and the back office.
import type { AddressInfo } from "node:net";
import { tx, q, type Client } from "../../packages/core/db.ts";
import { priceConfigured } from "../../packages/core/pricing.ts";
import * as shop from "../../packages/core/shop.ts";
import { ENTITY, RIO_ENTITY, LOC, PEOPLE, TENANT, type T } from "./harness.ts";
import { loadCompany } from "../../server/views.ts";
import type { Company, Actor } from "../../server/modules/kit.ts";

/** As as(), but loading the company through views.loadCompany (harness.company() trips the scope guard). */
async function as<R>(personId: string, fn: (c: Client, co: Company, a: Actor) => Promise<R>): Promise<R> {
  const co = (await tx({ kind: "system", label: "shop checks" }, (c) => loadCompany(c, ENTITY)))!;
  return tx({ kind: "user", id: personId, label: "shop checks" }, (c) => fn(c, co as Company, { personId, personName: "check", label: "shop checks" }));
}

const HUDSON = "77777777-0000-0000-0000-000000000010";
const LAMP = "77777777-0000-0000-0000-000000000009";
const SOFA = "77777777-0000-0000-0000-000000000001";
const PILLOW = "77777777-0000-0000-0000-000000000040";
const NIGHTSTAND = "77777777-0000-0000-0000-000000000041";   // seeded unpublished
const FEE = "77777777-0000-0000-0000-000000000011";
const PLAN = "77777777-0000-0000-0000-000000000012";   // 5-year protection plan (warranty)
const DC = "33333333-0000-0000-0000-0000000000dc";
const WEBADMIN = "55555555-0000-0000-0000-000000000019";
const SALES = "55555555-0000-0000-0000-000000000011";
const sys = { kind: "system" as const, label: "shop checks" };
const scope = { tenantId: TENANT, entityId: ENTITY, actor: sys };
const ADDR = { line1: "12 Oak Ln", city: "Maple Grove", state: "PA", postal: "00111" };
const cfg = (size: string, fabric: string, legs: string) =>
  [{ group: "size", option: size }, { group: "fabric", option: fabric }, { group: "legs", option: legs }];

/** Keys and values a shopper must never see. */
const FORBIDDEN_KEY = /cost|vendor|margin/i;
function leaks(v: unknown, path = "$"): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => leaks(x, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) =>
    [...(FORBIDDEN_KEY.test(k) ? [`${path}.${k}`] : []), ...leaks(x, `${path}.${k}`)]);
  if (typeof v === "string" && /\b(VV-NAV|LG-BRS|PL-OAT|HUD-S|Custom Upholstery Works Inc|62000|38500)\b/.test(v)) return [`${path}=${v}`];
  return [];
}
const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

export async function run(t: T) {
  const site = await tx(sys, async (c) => (await shop.siteBySlug(c, "riverside-home"))!);
  t.ok("seeded storefront is live at /shop/riverside-home/", !!site && site.entity_id === ENTITY && site.status === "live");
  const inTx = <R>(fn: (c: Client) => Promise<R>) => tx(sys, fn);
  const checkout = (over: Record<string, unknown>) => shop.parseCheckout({
    cartId: `chk-${Math.random().toString(36).slice(2, 12)}`, email: "checks@example.com", name: "Check Buyer", phone: "555-555-0142",
    fulfillment: "delivery", address: ADDR, paymentToken: "tok_test_visa_4242",
    lines: [{ productId: LAMP, qty: 1 }], ...over });

  // ------------------------------------------------------------ customizer
  for (const [size, fabric, legs] of [["84", "linen-oat", "walnut"], ["96", "velvet-navy", "brass"], ["sect", "leather-cognac", "black"]]) {
    const [pub, core] = await inTx(async (c) => [await shop.pubPrice(c, site, HUDSON, cfg(size, fabric, legs)), await priceConfigured(c, ENTITY, HUDSON, cfg(size, fabric, legs))] as const);
    t.ok(`customizer price for ${size}/${fabric}/${legs} equals priceConfigured`, pub.unitPriceMinor === core.unitPriceMinor.toString(), `${pub.unitPriceMinor} vs ${core.unitPriceMinor}`);
    t.ok(`customizer lead time follows the options (${size}/${fabric})`, pub.leadDays === core.leadDays && pub.availability.state === "made_to_order"
      && pub.availability.leadWeeks === Math.ceil((site.mto_base_days + core.leadDays) / 7));
  }
  await t.throws("customizer refuses an option the product does not have", () => inTx((c) => shop.pubPrice(c, site, HUDSON, cfg("84", "plaid", "walnut"))), /not a fabric/);
  await t.throws("customizer refuses a missing required choice", () => inTx((c) => shop.pubPrice(c, site, HUDSON, [{ group: "size", option: "84" }])), /choose a fabric/);

  // ------------------------------------------------------- what shoppers see
  const views = await inTx(async (c) => {
    const list = await shop.pubProducts(c, site, {});
    const details = [];
    for (const p of list.products) details.push(await shop.pubProduct(c, site, p.id));
    return { site: await shop.pubSite(c, site), list, details, price: await shop.pubPrice(c, site, HUDSON, cfg("96", "velvet-navy", "brass")) };
  });
  const allLeaks = leaks(json(views));
  t.ok("public site, listing, product pages and prices carry no cost, vendor or margin", allLeaks.length === 0, allLeaks.slice(0, 3).join(", "));
  t.ok("public listing hides unpublished products and fee SKUs", !views.list.products.some((p) => p.id === NIGHTSTAND || p.id === FEE));
  t.ok("listing filters and sorts by price", await inTx(async (c) => {
    const r = await shop.pubProducts(c, site, { category: "Living room", sort: "price_asc", maxMinor: 80000n });
    const prices = r.products.map((p) => Number(p.priceMinor));
    return r.products.length > 0 && r.products.every((p) => p.category === "Living room") && prices.every((x, i) => !i || x >= prices[i - 1]) && Math.max(...prices) <= 80000;
  }));
  t.ok("listing filters by brand and color", await inTx(async (c) => {
    const r = await shop.pubProducts(c, site, { brand: "Ashley", color: "Cobblestone" });
    return r.products.length === 2 && r.products.every((p) => p.brand === "Ashley" && p.color === "Cobblestone");
  }));
  const lampView = views.details.find((d) => d && d.id === LAMP)!;
  t.ok("availability says in stock for pickup at a store and ships from the DC", lampView.availability.lines.some((l) => l.kind === "pickup" && /Riverside/.test(l.text))
    && lampView.availability.lines.some((l) => l.kind === "parcel" || l.kind === "delivery"));
  t.ok("product page carries the site's financing link", lampView.financingUrl === site.financing_url && !!site.financing_url);
  t.ok("unpublished product has no public page", (await inTx((c) => shop.pubProduct(c, site, NIGHTSTAND))) === null);

  // ------------------------------------------------------- cart and prices
  const tampered = await inTx((c) => shop.saveCart(c, site, "tamper-cart-01",
    [{ productId: HUDSON, qty: 1, unitPriceMinor: "1", price: 1, choices: cfg("96", "velvet-navy", "brass") }], "tamper@example.com"));
  t.ok("a price sent by the browser is ignored; the cart is priced by the server", tampered.lines[0]?.unitPriceMinor === "172900", tampered.lines[0]?.unitPriceMinor);
  const badCart = await inTx((c) => shop.saveCart(c, site, "bad-cart-0001", [{ productId: NIGHTSTAND, qty: 1 }]));
  t.ok("a cart line for an unpublished product comes back as a problem, not a price", badCart.lines.length === 0 && badCart.problems.length === 1);

  // -------------------------------------------------------------- checkout
  const stockBefore = await inTx(async (c) => (await q<{ reserved: string; on_hand: string }>(c,
    `select reserved, on_hand from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`, [ENTITY, LAMP, DC]))[0]);
  const inp = checkout({ cartId: "checks-cart-001", lines: [
    { productId: HUDSON, qty: 1, unitPriceMinor: "100", choices: cfg("96", "velvet-navy", "brass") },
    { productId: LAMP, qty: 3, unitPriceMinor: "1" }] });
  const first = await inTx((c) => shop.placeWebOrder(c, site, inp, scope));
  const expectSub = 172900n + 3n * 5999n + 9900n;           // sofa, lamps, delivery
  const expectTax = (172900n * 600n + 5000n) / 10000n + (3n * 5999n * 600n + 5000n) / 10000n + (9900n * 600n + 5000n) / 10000n;
  t.ok("checkout totals from server prices, the delivery fee and the tax location's rate", first.order.totalMinor === (expectSub + expectTax).toString(),
    `${first.order.totalMinor} vs ${expectSub + expectTax}`);
  t.ok("the order is fully paid by the card", first.order.paidMinor === first.order.totalMinor && first.order.card === "Visa ending 4242");
  const second = await inTx((c) => shop.placeWebOrder(c, site, inp, scope));
  t.ok("a double submit returns the first order, not a second one", second.duplicate && second.order.number === first.order.number);
  const raced = await Promise.all([1, 2].map(() => inTx((c) => shop.placeWebOrder(c, site, { ...inp, cartId: "checks-race-001" }, scope))));
  const db = await inTx(async (c) => ({
    orders: await q<{ id: string; number: string; channel: string; status: string; location_id: string; customer_id: string; total_minor: string }>(c,
      `select id, number, channel, status, location_id, customer_id, total_minor from sales_order where entity_id = $1 and external_ref in ('checks-cart-001','checks-race-001') order by number`, [ENTITY]),
  }));
  t.ok("two checkouts racing with one cart id make one order", db.orders.length === 2 && raced.filter((r) => !r.duplicate).length === 1);
  const o = db.orders[0];
  t.ok("the web order is a normal sales order: channel web, open, credited to the web location", o.channel === "web" && o.status === "open" && o.location_id === site.web_location_id);
  const detail = await inTx(async (c) => ({
    lines: await q<{ sku: string; unit_price_minor: string; config: Record<string, unknown>; line_status: string; fulfil_from_id: string }>(c,
      `select sku, unit_price_minor, config, line_status, fulfil_from_id from sales_order_line where entity_id = $1 and sales_order_id = $2 order by seq`, [ENTITY, o.id]),
    stock: (await q<{ reserved: string; on_hand: string }>(c, `select reserved, on_hand from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`, [ENTITY, LAMP, DC]))[0],
    receipts: await q<{ id: string; channel: string; method: string; amount_minor: string; reference: string }>(c,
      `select id, channel, method, amount_minor, reference from customer_receipt where entity_id = $1 and sales_order_id = $2`, [ENTITY, o.id]),
    je: await q<{ dr: string; cr: string; codes: string[] }>(c, `
      select sum(jl.debit_minor)::text dr, sum(jl.credit_minor)::text cr, array_agg(g.code order by g.code) codes
        from journal_entry je join journal_line jl on jl.journal_entry_id = je.id join gl_account g on g.id = jl.gl_account_id
       where je.entity_id = $1 and je.source_type = 'receipt' and je.source_id in (select id from customer_receipt where entity_id = $1 and sales_order_id = $2)`, [ENTITY, o.id]),
    customer: (await q<{ email: string; number: string }>(c, `select email, number from customer where id = $1 and entity_id = $2`, [o.customer_id, ENTITY]))[0],
    payment: await q<{ token_ref: string; last4: string }>(c, `select token_ref, last4 from shop_payment where entity_id = $1 and sales_order_id = $2`, [ENTITY, o.id]),
    cart: (await q<{ sales_order_id: string }>(c, `select sales_order_id from shop_cart where entity_id = $1 and id = 'checks-cart-001'`, [ENTITY]))[0],
    msgs: await q<{ channel: string; to_ref: string }>(c, `select channel, to_ref from shop_message where entity_id = $1 and sales_order_id = $2`, [ENTITY, o.id]),
    reviews: await q(c, `select 1 from shop_review where entity_id = $1 and sales_order_id = $2`, [ENTITY, o.id]),
  }));
  const sofaLine = detail.lines.find((l) => l.sku === "CUW-SOFA-CUSTOM")!;
  t.ok("order lines are priced by priceConfigured and keep the chosen options", sofaLine.unit_price_minor === "172900"
    && (sofaLine.config as Record<string, { code: string }[]>).fabric?.[0]?.code === "velvet-navy");
  t.ok("the made-to-order sofa goes on order for purchasing; the lamps are reserved", sofaLine.line_status === "on_order"
    && detail.lines.find((l) => l.sku === "ACC-LAMP-01")!.line_status === "reserved");
  t.ok("reserved stock moves at the DC (3 lamps per order, two orders)", Number(detail.stock.reserved) - Number(stockBefore.reserved) === 6
    && detail.stock.on_hand === stockBefore.on_hand, `${stockBefore.reserved} -> ${detail.stock.reserved}`);
  t.ok("one web card receipt for the order total", detail.receipts.length === 1 && detail.receipts[0].channel === "web" && detail.receipts[0].method === "card"
    && detail.receipts[0].amount_minor === o.total_minor && !/\d{12,}/.test(detail.receipts[0].reference));
  t.ok("the receipt posts balanced: undeposited funds against customer deposits", detail.je.length === 1 && detail.je[0].dr === detail.je[0].cr
    && detail.je[0].dr === o.total_minor && detail.je[0].codes.join(",") === "1050,2300");
  t.ok("a new web customer is created by email within the company", detail.customer.email === "checks@example.com" && /^W-/.test(detail.customer.number));
  t.ok("only the processor token and last four are kept", detail.payment.length === 1 && detail.payment[0].last4 === "4242" && /^tok_test_/.test(detail.payment[0].token_ref));
  t.ok("the cart is marked converted", detail.cart?.sales_order_id === o.id);
  t.ok("order texts and emails are recorded with masked addresses, and reviews requested", detail.msgs.length === 2
    && detail.msgs.every((m) => m.to_ref.includes("***")) && detail.reviews.length === 2);
  const again = await inTx((c) => shop.placeWebOrder(c, site, checkout({ cartId: "checks-cart-002", email: "CHECKS@example.com" }), scope));
  const cust2 = await inTx(async (c) => (await q<{ customer_id: string }>(c, `select customer_id from sales_order where entity_id = $1 and number = $2`, [ENTITY, again.order.number]))[0]);
  t.ok("a returning shopper's email matches the same customer", cust2.customer_id === o.customer_id);
  t.ok("the confirmation shows no cost, vendor or margin", leaks(json(first)).length === 0, leaks(json(first)).slice(0, 2).join(", "));

  // ----------------------------------------------------- refusals at checkout
  const countOrders = () => inTx(async (c) => Number((await q<{ n: string }>(c, `select count(*) n from sales_order where entity_id = $1 and channel = 'web'`, [ENTITY]))[0].n));
  const before = await countOrders();
  await t.throws("a declined card makes no order", () => inTx((c) => shop.placeWebOrder(c, site, checkout({ paymentToken: "tok_test_decline" }), scope)), /declined/);
  await t.throws("an unpublished product cannot be bought online", () => inTx((c) => shop.placeWebOrder(c, site, checkout({ lines: [{ productId: NIGHTSTAND, qty: 1 }] }), scope)), /no longer sold online/);
  await t.throws("a fee SKU cannot be bought as a product", () => inTx((c) => shop.placeWebOrder(c, site, checkout({ lines: [{ productId: FEE, qty: 1 }] }), scope)), /no longer sold online/);
  await t.throws("an inactive product cannot be bought online", () => inTx(async (c) => {
    await c.query(`update product set status = 'draft' where id = $1 and entity_id = $2`, [SOFA, ENTITY]);
    return shop.placeWebOrder(c, site, checkout({ lines: [{ productId: SOFA, qty: 1 }] }), scope);
  }), /no longer sold online/);
  await t.throws("a card number pasted into checkout notes is refused", async () => shop.parseCheckout({ ...checkout({}), cartId: "x-card-0001", lines: [{ productId: LAMP, qty: 1 }], notes: "my card 4111 1111 1111 1111" } as never), /Card numbers are never sent/);
  for (const [label, body] of [
    ["a card number in the street address", { address: { line1: "4242-4242-4242-4242", city: "Maple Grove" } }],
    ["a card number in the name", { name: "Pat 5555555555554444" }],
    ["an Amex number in the notes", { notes: "use 3782 822463 10005" }],
  ] as const) {
    t.ok(`${label} is refused`, (() => { try { shop.refuseCardNumbers(body as Record<string, unknown>); return false; } catch (e) { return /Card numbers/.test((e as Error).message); } })());
  }
  for (const [label, body] of [
    ["a 13-digit timestamp in an email", { email: "buyer1730918400123@example.com", notes: "ref 1730918400123" }],
    ["a Luhn-valid card-shaped run inside an email", { email: "x4111111111111111@example.com" }],
    ["phone numbers and ids", { phone: "+1 717 555 0142 0000", productId: HUDSON, cartId: "4111111111111111" }],
    ["a digit run that fails Luhn", { notes: "4111 1111 1111 1112" }],
    ["a long number with no card prefix", { notes: "PO 7992739871300000" }],
  ] as const) {
    t.ok(`${label} is not mistaken for a card number`, (() => { try { shop.refuseCardNumbers(body as Record<string, unknown>); return true; } catch { return false; } })());
  }
  const tsBuyer = await inTx((c) => shop.placeWebOrder(c, site, checkout({ cartId: "checks-ts-0001", email: "buyer.4111111111111111@example.com" }), scope));
  t.ok("a checkout whose email holds a long number goes through", !tsBuyer.duplicate && !!tsBuyer.order.number);

  // protection plans ride along with furniture only
  await t.throws("a protection plan cannot be bought on its own", () => inTx((c) => shop.placeWebOrder(c, site, checkout({ lines: [{ productId: PLAN, qty: 1 }] }), scope)), /sold with the furniture/);
  await t.throws("a protection plan does not cover a lamp", () => inTx((c) => shop.placeWebOrder(c, site, checkout({ lines: [{ productId: LAMP, qty: 1 }, { productId: PLAN, qty: 1 }] }), scope)), /sold with the furniture/);
  await t.throws("no more plans than pieces they cover", () => inTx((c) => shop.placeWebOrder(c, site, checkout({ lines: [{ productId: SOFA, qty: 1 }, { productId: PLAN, qty: 2 }] }), scope)), /sold with the furniture/);
  const withPlan = await inTx((c) => shop.placeWebOrder(c, site, checkout({ cartId: "checks-plan-001", lines: [{ productId: SOFA, qty: 2 }, { productId: PLAN, qty: 2 }] }), scope));
  t.ok("a plan bought with the furniture it covers goes through", withPlan.order.lines.some((l) => /protection/i.test(l.description)));
  const planCart = await inTx((c) => shop.saveCart(c, site, "plan-cart-0001", [{ productId: PLAN, qty: 1 }]));
  t.ok("a cart with a plan and no furniture shows the plan as a problem", planCart.lines.length === 0 && planCart.problems[0]?.error === shop.WARRANTY_ALONE);
  await t.throws("a sofa cannot ship by parcel", () => inTx((c) => shop.placeWebOrder(c, site, checkout({ fulfillment: "ship", lines: [{ productId: SOFA, qty: 1 }] }), scope)), /too large to ship/);
  await t.throws("pickup must be at one of the site's stores", () => inTx((c) => shop.placeWebOrder(c, site, checkout({ fulfillment: "pickup", pickupLocationId: DC }), scope)), /pickup locations/);
  t.ok("refused checkouts leave no order behind", (await countOrders()) === before + 2);   // + the long-number email and the plan-with-sofa orders

  // ------------------------------------------------- pickup, parcel, free delivery
  const pickup = await inTx((c) => shop.placeWebOrder(c, site, checkout({ fulfillment: "pickup", pickupLocationId: LOC.PALESTINE, lines: [{ productId: LAMP, qty: 1 }] }), scope));
  const pk = await inTx(async (c) => (await q<{ location_id: string; tax_minor: string; fulfil: string }>(c, `
    select so.location_id, so.tax_minor, (select fulfil_from_id from sales_order_line l where l.sales_order_id = so.id and l.entity_id = so.entity_id and l.seq = 1) fulfil
      from sales_order so where so.entity_id = $1 and so.number = $2`, [ENTITY, pickup.order.number]))[0]);
  t.ok("pickup is credited to the pickup store, taxed at its rate, and filled from its floor", pk.location_id === LOC.PALESTINE
    && pk.tax_minor === ((5999n * 825n + 5000n) / 10000n).toString() && pk.fulfil === LOC.PALESTINE);
  const parcel = await inTx((c) => shop.quote(c, site, checkout({ fulfillment: "ship", lines: [{ productId: PILLOW, qty: 2 }] })));
  t.ok("a parcel item ships with the parcel fee", parcel.fee?.minor === site.ship_fee_minor && parcel.merchandiseMinor === "9998");
  const big = await inTx((c) => shop.quote(c, site, checkout({ lines: [{ productId: HUDSON, qty: 2, choices: cfg("sect", "leather-cognac", "brass") }] })));
  t.ok("delivery is free over the site's threshold", big.fee?.minor === "0");

  // ---------------------------------------------------------- order status
  const found = await inTx((c) => shop.lookupOrder(c, site, first.order.number.toLowerCase(), "Checks@Example.com"));
  t.ok("order status by number and email", found?.number === first.order.number && leaks(json(found)).length === 0);
  await t.throws("order status with the wrong email says nothing about the order", () => inTx((c) => shop.lookupOrder(c, site, first.order.number, "someone@example.com")), /couldn't find/);

  // ---------------------------------------------------------- packages
  let pkgOut: { set: unknown; piece: unknown } | null = null;
  try {
    await inTx(async (c) => {
      await c.query(`create table product_package_item (entity_id uuid not null, package_product_id uuid not null, component_product_id uuid not null, qty numeric not null default 1)`);
      const set = (await q<{ id: string }>(c, `insert into product (entity_id, sku, name, kind, category, price_minor, cost_minor, web_visible)
        values ($1,'SET-DARCY','Darcy sofa and loveseat set','stock','Living room',139999,71500,true) returning id`, [ENTITY]))[0].id;
      await c.query(`insert into product_package_item values ($1,$2,$3,1),($1,$2,$4,1)`, [ENTITY, set, SOFA, "77777777-0000-0000-0000-000000000002"]);
      await shop.packageShape(c, true);
      pkgOut = { set: (await shop.pubProduct(c, site, set))?.package, piece: (await shop.pubProduct(c, site, SOFA))?.package };
      throw new Error("rollback");   // the experiment never stays
    });
  } catch { /* rolled back on purpose */ }
  await inTx((c) => shop.packageShape(c, true));
  const ps = (pkgOut as { set: { kind: string; saveMinor: string; includes: unknown[] } | null; piece: { kind: string; partOf: unknown[] } | null } | null);
  t.ok("package tables, when the catalog has them, show what a set includes and saves", ps?.set?.kind === "package" && ps.set.saveMinor === "9999" && ps.set.includes.length === 2,
    JSON.stringify(ps?.set ?? null).slice(0, 80));
  t.ok("a piece shows the set it belongs to", ps?.piece?.kind === "piece" && ps.piece.partOf.length === 1);
  t.ok("without package tables the product page degrades to no package info", (await inTx((c) => shop.pubProduct(c, site, SOFA)))?.package === null);

  // --------------------------------------------------- entity isolation
  const iso = await inTx(async (c) => {
    const rio = (await q<{ id: string }>(c, `insert into product (entity_id, sku, name, kind, price_minor, web_visible) values ($1,'RIO-1','Rio trailer part','stock',1000,true) returning id`, [RIO_ENTITY]))[0].id;
    const page = await shop.pubProduct(c, site, rio);
    let refusedBuy = false;
    try { await c.query("savepoint s"); await shop.placeWebOrder(c, site, checkout({ lines: [{ productId: rio, qty: 1 }] }), scope); }
    catch (e) { refusedBuy = /no longer sold online/.test((e as Error).message); await c.query("rollback to savepoint s"); }
    const list = await shop.pubProducts(c, site, { q: "Rio trailer" });
    const hist = await shop.customerHistory(c, RIO_ENTITY, o.customer_id);
    const rioOrders = await shop.webOrders(c, RIO_ENTITY, "");
    const rioCarts = await shop.abandonedCarts(c, RIO_ENTITY, 0);
    let wrongScope = false;
    try { await c.query("savepoint w"); await shop.placeWebOrder(c, site, checkout({}), { ...scope, entityId: RIO_ENTITY }); }
    catch (e) { wrongScope = /another company/.test((e as Error).message); await c.query("rollback to savepoint w"); }
    throw Object.assign(new Error("rollback"), { result: { page, refusedBuy, list: list.products.length, hist, rioOrders: rioOrders.length, rioCarts: rioCarts.length, wrongScope } });
  }).catch((e) => (e as { result: Record<string, unknown> }).result);
  t.ok("another company's product has no page on this store", iso.page === null);
  t.ok("another company's product cannot be bought on this store", iso.refusedBuy === true);
  t.ok("another company's product never appears in this store's listing", iso.list === 0);
  t.ok("another company cannot read this company's customer history, web orders or carts", iso.hist === null && iso.rioOrders === 0 && iso.rioCarts === 0);
  t.ok("a checkout posted under another company's scope is refused", iso.wrongScope === true);
  await t.throws("a pickup store from another company is refused by the database", () => inTx((c) =>
    c.query(`update shop_site set pickup_location_ids = array['eeee0000-0000-0000-0000-000000000101']::uuid[] where id = $1`, [site.id])), /same company/);

  // ------------------------------------------------------------ back office
  await t.throws("publishing needs the web admin role", () => as(PEOPLE.CLERK, async (c, co, a) => {
    const { requireRole } = await import("../../server/modules/kit.ts");
    await requireRole(c, co, a, ["web_admin"], "publishing products to the web store");
  }), /needs one of: web admin/);
  await as(WEBADMIN, (c) => shop.setWebVisible(c, ENTITY, NIGHTSTAND, true));
  t.ok("a web admin publishes a product and it appears online", !!(await inTx((c) => shop.pubProduct(c, site, NIGHTSTAND))));
  await as(WEBADMIN, (c) => shop.setWebVisible(c, ENTITY, NIGHTSTAND, false));
  await t.throws("a fee SKU cannot be published", () => as(WEBADMIN, (c) => shop.setWebVisible(c, ENTITY, FEE, true)), /not sold as a product online/);
  const carts = await inTx((c) => shop.abandonedCarts(c, ENTITY, 60));
  t.ok("carts left over an hour are listed; converted carts are not", carts.some((k) => k.cart_id === "seedcart-0001") && !carts.some((k) => k.cart_id === "checks-cart-001"));
  const orders = await inTx((c) => shop.webOrders(c, ENTITY, ""));
  t.ok("online orders list shows the web orders", orders.some((x) => x.number === first.order.number));
  await t.throws("a site cannot take a reserved web address", () => as(WEBADMIN, (c) => shop.saveSite(c, ENTITY, { slug: "assets", displayName: "X", webLocationId: site.web_location_id })), /reserved/);
  await t.throws("a financing link must be https", () => as(WEBADMIN, (c) => shop.saveSite(c, ENTITY, { slug: "test-store", displayName: "X", webLocationId: site.web_location_id, financingUrl: "javascript:alert(1)" })), /https/);
  await t.throws("a logo from another site is refused", () => as(WEBADMIN, (c) => shop.saveSite(c, ENTITY, { slug: "test-store", displayName: "X", webLocationId: site.web_location_id, logoUrl: "https://evil.example/x.png" })), /logo/);

  // endless aisle and history
  const hand = await as(SALES, (c) => shop.aisleHandoff(c, ENTITY, SALES, { locationId: LOC.ENOLA, customerId: o.customer_id, note: null,
    lines: [{ productId: SOFA, qty: 1 }, { productId: HUDSON, qty: 1, unitPriceMinor: "5", choices: cfg("84", "linen-oat", "walnut") }] }));
  const draft = await inTx(async (c) => ({
    so: (await q<{ channel: string; status: string; location_id: string; salesperson_id: string; total_minor: string }>(c,
      `select channel, status, location_id, salesperson_id, total_minor from sales_order where id = $1 and entity_id = $2`, [hand.id, ENTITY]))[0],
    lines: await q<{ unit_price_minor: string; fulfil_from_id: string; sku: string }>(c, `select unit_price_minor, fulfil_from_id, sku from sales_order_line where entity_id = $1 and sales_order_id = $2 order by seq`, [ENTITY, hand.id]),
  }));
  t.ok("endless aisle hands the register a draft POS order at the chosen store", draft.so.channel === "pos" && draft.so.status === "draft"
    && draft.so.location_id === LOC.ENOLA && draft.so.salesperson_id === SALES);
  t.ok("endless aisle prices through priceConfigured and fills from the floor when it can", draft.lines[1].unit_price_minor === "129900"
    && draft.lines[0].fulfil_from_id === LOC.ENOLA && draft.lines[1].fulfil_from_id === DC && draft.so.total_minor === (79999n + 129900n).toString());
  const hist = await inTx((c) => shop.customerHistory(c, ENTITY, o.customer_id));
  t.ok("customer history joins web and store orders", !!hist && hist.totals.channels.includes("web") && hist.totals.channels.includes("pos") && BigInt(hist.totals.spentMinor) > 0n);

  // --------------------------------------------------------- over HTTP
  const { createServer } = await import("../../server/index.ts");
  const { _resetLimits, LIMITS } = await import("../../server/modules/shop.ts");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    _resetLimits();
    const page = await fetch(`${base}/shop/riverside-home/`);
    const html = await page.text();
    const csp = page.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    t.ok("the storefront page is served with the app's CSP and a style nonce", page.status === 200 && /script-src 'self'/.test(csp)
      && !!nonce && html.includes(`nonce="${nonce}"`) && !html.includes("__NONCE__") && page.headers.get("x-frame-options") === "DENY");
    t.ok("the page has no inline script and no inline style attributes", !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) && !/\sstyle=/i.test(html));
    const js = await fetch(`${base}/shop/assets/store.js`);
    t.ok("the store script is served as JavaScript", js.status === 200 && /javascript/.test(js.headers.get("content-type") ?? ""));
    t.ok("an unknown store is a 404", (await fetch(`${base}/shop/nobody-here/`)).status === 404 && (await fetch(`${base}/shop/nobody-here/api/site`)).status === 404);
    const api = await (await fetch(`${base}/shop/riverside-home/api/products/${HUDSON}`)).json();
    t.ok("public API responses carry no cost or vendor fields", leaks(api).length === 0 && api.priceMinor === "129900");
    const noHeader = await fetch(`${base}/shop/riverside-home/api/price`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: HUDSON }) });
    t.ok("a public POST without the store header is refused", noHeader.status === 403);
    const H = { "content-type": "application/json", "x-erp-shop": "1" };
    const viaHttp = await fetch(`${base}/shop/riverside-home/api/checkout`, { method: "POST", headers: H, body: JSON.stringify({ cartId: "http-cart-0001", email: "http@example.com", name: "Http Buyer",
      fulfillment: "pickup", pickupLocationId: LOC.ENOLA, paymentToken: "tok_test_visa_4242", lines: [{ productId: LAMP, qty: 1, unitPriceMinor: "1" }] }) });
    const vj = await viaHttp.json();
    t.ok("a full checkout works over HTTP and ignores the posted price", viaHttp.status === 200 && vj.order?.lines?.[0]?.unitPriceMinor === "5999" && leaks(vj).length === 0, JSON.stringify(vj).slice(0, 80));
    const bad = await fetch(`${base}/shop/riverside-home/api/checkout`, { method: "POST", headers: H, body: JSON.stringify({ cartId: "http-cart-0002", lines: [] }) });
    t.ok("a refused checkout is a plain sentence", bad.status === 422 && typeof (await bad.json()).error === "string");
    let status = 0;
    for (let i = 0; i <= LIMITS.lookup.max; i++) {
      status = (await fetch(`${base}/shop/riverside-home/api/order-status`, { method: "POST", headers: H, body: JSON.stringify({ number: "SO-999999", email: "x@example.com" }) })).status;
    }
    t.ok("order lookup is rate limited per address", status === 429);
    await inTx((c) => shop.setSiteStatus(c, ENTITY, site.id, "draft"));
    t.ok("a draft storefront is not public", (await fetch(`${base}/shop/riverside-home/api/site`)).status === 404);
    await inTx((c) => shop.setSiteStatus(c, ENTITY, site.id, "live"));
  } finally {
    _resetLimits();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
