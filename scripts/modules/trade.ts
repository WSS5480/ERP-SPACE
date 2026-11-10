// trade module checks: trade accounts, the portal and its sign-in, trade
// pricing, orders on account and for resale, room projects, follow-ups, and
// the designer split and referral payable.
import type { AddressInfo } from "node:net";
import { tx, q, type Client, type Scope } from "../../packages/core/db.ts";
import { priceConfigured } from "../../packages/core/pricing.ts";
import * as shop from "../../packages/core/shop.ts";
import * as trade from "../../packages/core/trade.ts";
import * as projects from "../../packages/core/projects.ts";
import * as tc from "../../packages/core/trade_commission.ts";
import * as cat from "../../packages/core/catalog.ts";
import * as crm from "../../packages/core/crm.ts";
import * as pos from "../../packages/core/pos.ts";
import { requireRole } from "../../server/modules/kit.ts";
import { ROLES } from "../../server/modules/trade.ts";
import { createLink } from "../../server/modules/tearsheet.ts";
import { loadCompany } from "../../server/views.ts";
import type { Company, Actor } from "../../server/modules/kit.ts";
import { ENTITY, LOC, PEOPLE, TENANT, type T } from "./harness.ts";

const sys = { kind: "system" as const, label: "trade checks" };
const scope: Scope = { tenantId: TENANT, entityId: ENTITY, actor: sys };
const inTx = <R>(fn: (c: Client) => Promise<R>) => tx(sys, fn);
const MARIA = "55555555-0000-0000-0000-000000000011";      // sales
const RAY = "55555555-0000-0000-0000-000000000014";        // dispatcher
const ANA = "55555555-0000-0000-0000-000000000016";        // buyer
const MGR = "55555555-0000-0000-0000-000000000018";        // Enola store manager
const DESIGNER = "55555555-0000-0000-0000-0000000000d1";   // made here: an internal designer
const P = { LAMP: "77777777-0000-0000-0000-000000000009", RECLINER: "77777777-0000-0000-0000-000000000007", HUDSON: "77777777-0000-0000-0000-000000000010",
  MATTRESS: "77777777-0000-0000-0000-000000000008", DRESSER: "77777777-0000-0000-0000-000000000004" };
const ALICIA = "88888888-0000-0000-0000-000000000001", BRIAN = "88888888-0000-0000-0000-000000000002";
const cfg = (size: string, fabric: string, legs: string) => [{ group: "size", option: size }, { group: "fabric", option: fabric }, { group: "legs", option: legs }];
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const bps = (m: bigint, r: number) => (m * BigInt(r) + 5000n) / 10000n;
const uniq = Math.random().toString(36).slice(2, 8);

async function as<R>(personId: string, fn: (c: Client, co: Company, a: Actor) => Promise<R>): Promise<R> {
  const co = (await tx(sys, (c) => loadCompany(c, ENTITY)))!;
  return tx({ kind: "user", id: personId, label: "trade checks" }, (c) => fn(c, co as Company, { personId, personName: "check", label: "trade checks" }));
}
const userScope = (id: string): Scope => ({ tenantId: TENANT, entityId: ENTITY, actor: { kind: "user", id, label: "trade checks" } });

/** A mailer that hands the code to the checks instead of an inbox. */
function catcher() {
  const sent: string[] = [];
  const m: trade.CodeMailer = { name: "catch", async send(_c, x) { sent.push(x.body); } };
  return { m, last: () => /(\d{6})/.exec(sent[sent.length - 1] ?? "")?.[1] ?? "" , count: () => sent.length };
}

export async function run(t: T) {
  const site = (await inTx((c) => shop.siteBySlug(c, "buddys")))!;

  // A vendor to pay referral commission to, and an internal designer.
  const vendorId = await inTx(async (c) => {
    const v = (await q<{ id: string }>(c, `insert into vendor (tenant_id, legal_name, status, created_by) values ($1,$2,'active',$3) returning id /* unscoped: test vendor */`,
      [TENANT, `Hartley Design Studio ${uniq}`, PEOPLE.STEVE]))[0].id;
    await c.query(`insert into vendor_entity (vendor_id, entity_id, terms_days, status) values ($1,$2,15,'active')`, [v, ENTITY]);
    await c.query(`insert into app_user (id, tenant_id, name, email, status) values ($1,$2,'Dana (designer)','dana.designer@example.com','active') on conflict do nothing /* unscoped: test person */`, [DESIGNER, TENANT]);
    await c.query(`insert into role_grant (app_user_id, entity_id, role) select $1,$2,'designer' where not exists (select 1 from role_grant where app_user_id = $1 and role = 'designer')`, [DESIGNER, ENTITY]);
    const plan = (await q<{ id: string }>(c, `select id from commission_plan where entity_id = $1 and basis = 'margin' limit 1`, [ENTITY]))[0].id;
    await c.query(`insert into commission_assignment (entity_id, app_user_id, plan_id, effective_from) select $1,$2,$3,current_date - 400
                    where not exists (select 1 from commission_assignment where app_user_id = $2)`, [ENTITY, DESIGNER, plan]);
    return v;
  });

  // ---------------------------------------------------------- applying
  const email1 = `studio-${uniq}@example.com`, email2 = `other-${uniq}@example.com`;
  const nextYear = `${new Date().getUTCFullYear() + 1}-12-31`;
  await t.throws("apply: a bad email is refused in plain words", () => inTx((c) => trade.submitApplication(c, site, { companyName: "X Co", kind: "designer", contactName: "Xi", email: "nope" }, "ip")), /valid email/);
  await t.throws("apply: an expired resale certificate is refused", () => inTx((c) => trade.submitApplication(c, site, { companyName: "Old Cert", kind: "designer", contactName: "Ola",
    email: `old-${uniq}@example.com`, resaleNumber: "PA-OLD-1", resaleState: "PA", resaleExpires: "2020-01-01" }, "ip")), /has expired/);
  const app1 = await inTx((c) => trade.submitApplication(c, site, { companyName: "Hartley Design Studio", kind: "designer", contactName: "Jo Hartley", email: email1, phone: "717-555-0199",
    resaleNumber: `PA-RS-${uniq}`, resaleState: "PA", resaleExpires: nextYear, address: { line1: "200 Market St", city: "Harrisburg", state: "PA", postal: "17101" } }, "ip-a"));
  const again = await inTx((c) => trade.submitApplication(c, site, { companyName: "Hartley Design Studio", kind: "designer", contactName: "Jo Hartley", email: email1 }, "ip-a"));
  t.ok("apply: an application is received and numbered; a second one for the same email makes nothing new", !!app1.number && again.received && again.number === null);
  const app2 = await inTx((c) => trade.submitApplication(c, site, { companyName: "Riverside Staging", kind: "stager", contactName: "Sam Rivers", email: email2 }, "ip-b"));
  const pending = await inTx((c) => trade.applications(c, ENTITY, "pending"));
  const a1 = pending.find((x) => x.number === app1.number)!, a2 = pending.find((x) => x.number === app2.number)!;
  t.ok("review: staff see pending applications", !!a1 && !!a2);

  // ----------------------------------------------------------- roles
  await t.throws("roles: a salesperson cannot decide an application", () => as(MARIA, (c, co, a) => requireRole(c, co, a, ROLES.review, "deciding a trade application")), /needs one of: store manager, controller/);
  await t.throws("roles: a store manager cannot set a credit limit when approving", () => as(MGR, (c) =>
    trade.decideApplication(c, userScope(MGR), a1.id, { decision: "approved", creditLimitMinor: 500000n }, false)), /needs the controller/);
  await t.throws("roles: a salesperson cannot change trade price rules", () => as(MARIA, (c, co, a) => requireRole(c, co, a, ROLES.prices, "changing trade price rules")), /needs one of: buyer/);
  await t.throws("roles: a dispatcher cannot split a line's commission", () => as(RAY, (c, co, a) => requireRole(c, co, a, ROLES.lines, "splitting a line's commission")), /needs one of/);
  await t.throws("roles: a salesperson cannot bill referral commission", () => as(MARIA, (c, co, a) => requireRole(c, co, a, ROLES.referrals, "billing referral commission")), /needs one of: controller, ap clerk/);
  await t.throws("roles: a dispatcher cannot start a room project", () => as(RAY, (c, co, a) => requireRole(c, co, a, ROLES.projects, "starting a room project")), /needs one of/);
  await t.throws("declining needs a reason", () => inTx((c) => trade.decideApplication(c, scope, a2.id, { decision: "declined" }, true)), /Say why/);

  // ---------------------------------------------------------- approval
  const ok1 = await as(PEOPLE.CONTROLLER, (c) => trade.decideApplication(c, userScope(PEOPLE.CONTROLLER), a1.id,
    { decision: "approved", creditLimitMinor: 500000n, termsDays: 30, referralBps: 1000, vendorId, repId: MARIA }, true));
  const ok2 = await as(MGR, (c) => trade.decideApplication(c, userScope(MGR), a2.id, { decision: "approved" }, false));
  const acct1 = await inTx((c) => trade.account(c, ENTITY, ok1.tradeAccountId!));
  t.ok("approval: a business customer with a house account on net 30 and its credit limit", !!acct1 && acct1.credit.limitMinor === "500000" && acct1.credit.termsDays === 30
    && (await inTx((c) => q<{ kind: string; house_account: boolean }>(c, `select cu.kind, a.house_account from customer cu join ar_account a on a.customer_id = cu.id where cu.id = $1 and cu.entity_id = $2`,
      [acct1!.account.customer_id, ENTITY])))[0]?.house_account === true);
  t.ok("approval: the resale certificate is filed as a tax exemption certificate", acct1!.certificates.some((x) => x.number === `PA-RS-${uniq}` && x.reason === "resale" && x.current));
  t.ok("approval: the account is on the TRADE price list with its referral rate and vendor", acct1!.account.price_list === "TRADE" && acct1!.account.referral_bps === 1000 && acct1!.vendor?.id === vendorId);
  await t.throws("a decided application cannot be decided again", () => inTx((c) => trade.decideApplication(c, scope, a1.id, { decision: "declined", note: "changed mind" }, true)), /already approved/);

  // ---------------------------------------------------- trade pricing
  const listId = (await inTx((c) => q<{ id: string }>(c, `select id from price_list where entity_id = $1 and code = 'TRADE'`, [ENTITY])))[0].id;
  await as(ANA, async (c) => {
    await cat.savePriceRule(c, userScope(ANA), listId, { category: "Living room", basis: "cost_plus", bps: 3500 });
    await cat.savePriceRule(c, userScope(ANA), listId, { category: null, basis: "retail_less", bps: 2000 });
  });
  await t.throws("price rules: a discount over 90% is refused", () => inTx((c) => cat.savePriceRule(c, scope, listId, { category: "Accents", basis: "retail_less", bps: 9500 })), /between 0% and 90%/);
  const prices = await inTx(async (c) => ({
    recliner: await priceConfigured(c, ENTITY, P.RECLINER, [], { priceList: "TRADE" }),     // Living room: cost 290.00 + 35%
    lamp: await priceConfigured(c, ENTITY, P.LAMP, [], { priceList: "TRADE" }),             // Accents: catch-all, retail 59.99 - 20%
    hudson: await priceConfigured(c, ENTITY, P.HUDSON, cfg("96", "velvet-navy", "brass"), { priceList: "TRADE" }),
    retail: await priceConfigured(c, ENTITY, P.LAMP, []),
  }));
  t.ok("trade pricing: Living room is cost plus 35%", prices.recliner.unitPriceMinor === 29000n + bps(29000n, 3500) && prices.recliner.priceList === "TRADE", String(prices.recliner.unitPriceMinor));
  t.ok("trade pricing: other categories take the catch-all, retail less 20%", prices.lamp.unitPriceMinor === 5999n - bps(5999n, 2000), String(prices.lamp.unitPriceMinor));
  t.ok("trade pricing: a configured piece marks up its configured cost", prices.hudson.unitPriceMinor < prices.hudson.ticketMinor! && prices.hudson.priceList === "TRADE");
  t.ok("trade pricing: without the list the ticket price is unchanged", prices.retail.unitPriceMinor === 5999n);
  await inTx(async (c) => { await cat.setListPrices(c, scope, listId, [{ productId: P.LAMP, priceMinor: 3999n }]); });
  t.ok("trade pricing: a product's own price on the list beats the category rule", (await inTx((c) => priceConfigured(c, ENTITY, P.LAMP, [], { priceList: "TRADE" }))).unitPriceMinor === 3999n);
  await inTx(async (c) => { await cat.setListPrices(c, scope, listId, [{ productId: P.LAMP, priceMinor: null }]); });

  // -------------------------------------------------------- sign-in
  const mail = catcher();
  const past = new Date(Date.now() - 20 * 60_000);
  await inTx((c) => trade.requestCode(c, site, email1, "ip-a", mail.m, past));
  const oldCode = mail.last();
  const expired = await inTx((c) => trade.verifyCode(c, site, email1, oldCode));
  t.ok("sign-in: an expired code is refused", !expired.ok && /expired/.test((expired as { error: string }).error));
  const stranger = await inTx((c) => trade.requestCode(c, site, `nobody-${uniq}@example.com`, "ip-z", mail.m));
  t.ok("sign-in: an email with no account gets the same answer and no code", stranger.sent && mail.count() === 1);
  await inTx((c) => trade.requestCode(c, site, email1, "ip-a", mail.m));
  const code = mail.last();
  const wrong = await inTx((c) => trade.verifyCode(c, site, email1, code === "000000" ? "111111" : "000000"));
  t.ok("sign-in: a wrong code is refused and counted", !wrong.ok && /not right\. 4 tries left/.test((wrong as { error: string }).error), (wrong as { error: string }).error);
  const tries = (await inTx((c) => q<{ attempts: number }>(c, `select attempts from trade_login_code where entity_id = $1 and trade_account_id = $2 order by created_at desc limit 1`, [ENTITY, ok1.tradeAccountId])))[0];
  t.ok("sign-in: the wrong try is kept even though the answer was a refusal", tries.attempts === 1);
  const good = await inTx((c) => trade.verifyCode(c, site, email1, code));
  t.ok("sign-in: the right code opens a session", good.ok && !!(good as { token: string }).token);
  const token1 = (good as { token: string }).token;
  const reuse = await inTx((c) => trade.verifyCode(c, site, email1, code));
  t.ok("sign-in: a used code does not work twice", !reuse.ok);
  const stored = (await inTx((c) => q<{ n: string }>(c, `select count(*) n from trade_login_code where entity_id = $1 and code_sha256 = $2`, [ENTITY, code])))[0];
  t.ok("sign-in: the code is not stored as itself, only its hash", stored.n === "0");
  await inTx((c) => trade.requestCode(c, site, email1, "ip-a", mail.m));
  await inTx((c) => trade.requestCode(c, site, email1, "ip-a", mail.m));
  await t.throws("sign-in: no more than three codes in fifteen minutes", () => inTx((c) => trade.requestCode(c, site, email1, "ip-a", mail.m)), /Too many codes/);
  const later = new Date(Date.now() + 20 * 60_000);
  await inTx((c) => trade.requestCode(c, site, email1, "ip-a", mail.m, later));
  const c5 = mail.last();
  for (let i = 0; i < 5; i++) await inTx((c) => trade.verifyCode(c, site, email1, c5 === "999999" ? "888888" : "999999", later));
  const locked = await inTx((c) => trade.verifyCode(c, site, email1, c5, later));
  t.ok("sign-in: five wrong tries kill the code", !locked.ok && /Too many wrong tries/.test((locked as { error: string }).error));
  const s1 = (await inTx((c) => trade.sessionFor(c, site, token1)))!;
  t.ok("sign-in: the session names the account", !!s1 && s1.accountId === ok1.tradeAccountId && s1.priceList === "TRADE");
  t.ok("sign-in: a made-up token opens nothing", (await inTx((c) => trade.sessionFor(c, site, "x".repeat(43)))) === null);
  await inTx((c) => trade.requestCode(c, site, email2, "ip-b", mail.m));
  const s2tok = (await inTx((c) => trade.verifyCode(c, site, email2, mail.last())) as { token: string }).token;
  const s2 = (await inTx((c) => trade.sessionFor(c, site, s2tok)))!;

  // ------------------------------------------------------- portal: catalog
  const catl = await inTx((c) => trade.catalog(c, site, s1, {}));
  const lampCard = catl.products.find((p) => p.id === P.LAMP)!;
  t.ok("portal: the catalog shows trade prices beside retail", lampCard.tradeMinor === String(5999n - bps(5999n, 2000)) && lampCard.retailMinor === "5999");
  const tp = await inTx((c) => trade.tradePrice(c, site, s1, P.HUDSON, cfg("96", "velvet-navy", "brass")));
  t.ok("portal: the configurator prices at trade", tp.unitPriceMinor === prices.hudson.unitPriceMinor.toString() && tp.retailMinor === "172900");
  const pubLeak = JSON.stringify(await inTx((c) => trade.product(c, site, s1, P.RECLINER)));
  t.ok("portal: a product page carries no cost or vendor", !/cost|vendor|margin/i.test(pubLeak));

  // ----------------------------------------------------- projects
  const proj = await inTx((c) => trade.createProject(c, site, s1, { name: "Living room 2027", clientName: "The Parkers", clientAddress: { line1: "14 Elm St", city: "Palestine", state: "TX", postal: "75801" },
    lengthIn: 240, widthIn: 180, heightIn: 108, openings: [{ kind: "door", wall: "north", widthIn: 36, heightIn: 80 }, { kind: "window", wall: "east", widthIn: 60, heightIn: 48 }],
    styleNotes: "Warm modern, walnut and navy", budgetMinor: 1500000n }));
  await t.throws("projects: a door needs a sensible size", () => inTx((c) => trade.updateProject(c, site, s1, proj.id, { openings: [{ kind: "door", widthIn: -3 }] })), /size is in inches/);
  await inTx(async (c) => {
    await trade.addProjectItem(c, site, s1, proj.id, { productId: P.RECLINER, qty: 2 });
    await trade.addProjectItem(c, site, s1, proj.id, { productId: P.HUDSON, choices: cfg("96", "velvet-navy", "brass"), qty: 1 });
  });
  await t.throws("projects: the configurator refuses an option the product does not have", () => inTx((c) =>
    trade.addProjectItem(c, site, s1, proj.id, { productId: P.HUDSON, choices: cfg("96", "plaid", "brass") })), /not a fabric/);
  const photoId = await inTx((c) => trade.addProjectPhoto(c, site, s1, proj.id, PNG, "Before"));
  await t.throws("projects: a photo must be a picture", () => inTx((c) => trade.addProjectPhoto(c, site, s1, proj.id, "data:text/html;base64,PGI+", "x")), /PNG, JPEG or WebP/);
  await inTx((c) => trade.updateProject(c, site, s1, proj.id, { styleNotes: "Warm modern; walnut, navy, brass" }));
  const pv = (await inTx((c) => trade.myProject(c, site, s1, proj.id)))!;
  t.ok("projects: room size, doors and windows, notes, photos and items are kept", Number(pv.length_in) === 240 && (pv.openings as unknown[]).length === 2
    && pv.style_notes === "Warm modern; walnut, navy, brass" && pv.photos.length === 1 && pv.items.length === 2);
  t.ok("projects: items are priced at the account's trade prices", pv.items.find((i) => i.productId === P.RECLINER)!.unitPriceMinor === String(29000n + bps(29000n, 3500)));
  await inTx((c) => trade.removeProjectPhoto(c, site, s1, proj.id, photoId));
  t.ok("projects: a removed photo is kept but not shown", (await inTx((c) => trade.myProject(c, site, s1, proj.id)))!.photos.length === 0
    && (await inTx((c) => q(c, `select 1 from room_project_photo where id = $1 and entity_id = $2 and removed_at is not null`, [photoId, ENTITY]))).length === 1);
  const staffList = await inTx((c) => projects.projectsFor(c, ENTITY, { customerId: s1.customerId }));
  const c360 = await inTx((c) => crm.customer360(c, ENTITY, s1.customerId));
  t.ok("projects: visible to staff and in the CRM customer view", staffList.some((x) => x.id === proj.id) && !!c360 && (c360.projects as { id: string }[]).some((x) => x.id === proj.id)
    && (c360.trade as { number: string } | null)?.number === ok1.number);
  t.ok("projects: one account cannot see another's", (await inTx((c) => trade.myProject(c, site, s2, proj.id))) === null
    && !(await inTx((c) => trade.myProjects(c, site, s2))).some((x) => x.id === proj.id));
  await t.throws("projects: one account cannot change another's", () => inTx((c) => trade.updateProject(c, site, s2, proj.id, { name: "mine now" })), /No such project/);
  // A retail household: a project on one member is seen from the other.
  const hh = await inTx(async (c) => {
    const h = await crm.setHousehold(c, ENTITY, [ALICIA, BRIAN], `Check household ${uniq}`);
    const p = await projects.createProject(c, userScope(MARIA), { customerId: ALICIA, name: "Bedroom refresh", budgetMinor: 300000n });
    return { h, p };
  });
  t.ok("projects: a household member sees the household's project (POS and CRM read the same list)",
    (await inTx((c) => projects.projectsFor(c, ENTITY, { customerId: BRIAN }))).some((x) => x.id === hh.p.id));

  // -------------------------------------------------- quote and destination tax
  const cart = () => `trade-${uniq}-${Math.random().toString(36).slice(2, 10)}`;
  const toClient = await inTx((c) => trade.quoteOrder(c, site, s1, { projectId: proj.id, fulfillment: "delivery", shipTo: "client", payBy: "account", cartId: cart() }));
  const recLine = toClient.lines.find((l) => l.productId === P.RECLINER)!;
  t.ok("tax: shipped to the client in Palestine, TX, with no resale, it is taxed at the destination (8.25%)",
    recLine.taxMinor === bps(BigInt(recLine.lineMinor), 825).toString(), `${recLine.taxMinor} on ${recLine.lineMinor}`);
  const resaleAway = await inTx((c) => trade.quoteOrder(c, site, s1, { projectId: proj.id, fulfillment: "delivery", shipTo: "client", resale: true, payBy: "account", cartId: cart() }));
  t.ok("tax: a Pennsylvania resale certificate does not exempt a Texas delivery", resaleAway.lines.find((l) => l.productId === P.RECLINER)!.taxMinor === recLine.taxMinor);
  t.ok("projects: quoting the project marks it quoted", !!(await inTx((c) => trade.myProject(c, site, s1, proj.id)))!.quoted_at);

  // ----------------------------------------------- orders on account and for resale
  const PA = { line1: "9 River Rd", city: "Camp Hill", state: "PA", postal: "17011" };
  const resale = await inTx((c) => trade.placeOrder(c, site, s1, { lines: [{ productId: P.LAMP, qty: 4 }], fulfillment: "delivery", shipTo: "address", address: PA,
    resale: true, payBy: "account", cartId: cart() }));
  const resaleTax = await inTx((c) => q<{ exempt_reason: string | null; tax_minor: string }>(c, `select t.exempt_reason, t.tax_minor from sales_order_line_tax t
     join sales_order_line l on l.id = t.sales_order_line_id where t.entity_id = $1 and t.sales_order_id = $2 and l.product_id = $3`, [ENTITY, resale.orderId, P.LAMP]));
  t.ok("resale: a valid certificate exempts the order (by jurisdiction, as resale)", resale.order.taxMinor === "0" && resaleTax.length > 0 && resaleTax.every((r) => r.exempt_reason === "resale" && r.tax_minor === "0"));
  const so1 = (await inTx((c) => q<{ channel: string; paid_minor: string; total_minor: string; customer_id: string }>(c, `select channel, paid_minor, total_minor, customer_id from sales_order where id = $1 and entity_id = $2`,
    [resale.orderId, ENTITY])))[0];
  const rcpt = await inTx((c) => q(c, `select 1 from customer_receipt where entity_id = $1 and sales_order_id = $2`, [ENTITY, resale.orderId]));
  t.ok("on account: a b2b order for the account's customer, nothing charged to a card", so1.channel === "b2b" && so1.paid_minor === "0" && so1.customer_id === s1.customerId && rcpt.length === 0);
  const dup = await inTx(async (c) => trade.placeOrder(c, site, s1, { lines: [{ productId: P.LAMP, qty: 4 }], fulfillment: "delivery", shipTo: "address", address: PA, resale: true, payBy: "account",
    cartId: (await q<{ external_ref: string }>(c, `select external_ref from sales_order where id = $1 and entity_id = $2`, [resale.orderId, ENTITY]))[0].external_ref }));
  t.ok("on account: a double submit returns the first order", dup.duplicate && dup.orderId === resale.orderId);
  const me1 = await inTx((c) => trade.me(c, site, s1));
  t.ok("on account: what is on order counts against the limit", me1.credit.onOrderMinor === so1.total_minor && BigInt(me1.credit.availableMinor) === 500000n - BigInt(so1.total_minor));
  await t.throws("on account: an order over the credit limit is refused", () => inTx((c) => trade.placeOrder(c, site, s1, { lines: [{ productId: P.MATTRESS, qty: 7 }],
    fulfillment: "delivery", shipTo: "address", address: PA, payBy: "account", cartId: cart() })), /can't go on account: charging .* over its \$5,000\.00 limit/);
  const byCard = await inTx((c) => trade.placeOrder(c, site, s1, { lines: [{ productId: P.LAMP, qty: 1 }], fulfillment: "delivery", shipTo: "address", address: PA, payBy: "card",
    paymentToken: "tok_test_visa_4242", cartId: cart() }));
  t.ok("by card: the web payment path takes the card at the trade price", byCard.order.card === "Visa ending 4242" && byCard.order.paidMinor === byCard.order.totalMinor
    && byCard.order.lines[0].unitPriceMinor === String(5999n - bps(5999n, 2000)));
  await t.throws("card only: an account with no credit limit cannot order on account", () => inTx((c) => trade.placeOrder(c, site, s2, { lines: [{ productId: P.LAMP, qty: 1 }],
    fulfillment: "delivery", shipTo: "address", address: PA, payBy: "account", cartId: cart() })), /can't go on account/);
  // An expired certificate no longer exempts.
  await inTx((c) => c.query(`update tax_exemption_certificate set expires_on = current_date - 1 where entity_id = $1 and customer_id = $2`, [ENTITY, s1.customerId]));
  await t.throws("resale: an expired certificate is refused", () => inTx((c) => trade.quoteOrder(c, site, s1, { lines: [{ productId: P.LAMP, qty: 1 }], fulfillment: "delivery",
    shipTo: "address", address: PA, resale: true, payBy: "account", cartId: cart() })), /expired on/);
  await inTx((c) => c.query(`update tax_exemption_certificate set expires_on = $3 where entity_id = $1 and customer_id = $2`, [ENTITY, s1.customerId, nextYear]));
  // The project ordered, shipped to the client: the items are marked bought and the order linked.
  const projOrder = await inTx((c) => trade.placeOrder(c, site, s1, { projectId: proj.id, fulfillment: "delivery", shipTo: "client", payBy: "card", paymentToken: "tok_test_visa_4242", cartId: cart() }));
  const pv2 = (await inTx((c) => trade.myProject(c, site, s1, proj.id)))!;
  t.ok("projects: ordering the project links the order and marks its items bought", pv2.orders.some((o) => o.id === projOrder.orderId) && pv2.items.every((i) => i.stage === "bought"));

  // ---------------------------------------------------- the account's own data
  const mine = await inTx((c) => trade.orders(c, site, s1));
  t.ok("portal: the account sees its orders with status and dates", mine.some((o) => o.id === resale.orderId) && mine.some((o) => o.id === projOrder.orderId));
  await t.throws("portal: another account's order id reads as not found", () => inTx((c) => trade.order(c, site, s2, resale.orderId)), /No such order/);
  await t.throws("portal: another account's order gives no tear sheet", () => inTx((c) => trade.sheetLink(c, site, s2, { orderId: resale.orderId }, createLink)), /No such order/);
  t.ok("portal: the other account's list does not include it", !(await inTx((c) => trade.orders(c, site, s2))).some((o) => o.id === resale.orderId));
  const sheet = await inTx((c) => trade.sheetLink(c, site, s1, { orderId: resale.orderId }, createLink));
  t.ok("portal: a tear sheet link for the account's own order", /^\/sheet\/[A-Za-z0-9_-]{20,}$/.test(sheet.path));

  // ------------------------------------------------------- invoices and paying them
  const inv = await inTx(async (c) => {
    // Stand-in for the delivery: hand the lamps over and invoice them through A/R's own path.
    const lines = await q<{ id: string }>(c, `select id from sales_order_line where entity_id = $1 and sales_order_id = $2`, [ENTITY, resale.orderId]);
    await c.query(`update sales_order_line set line_status = 'fulfilled' where entity_id = $1 and sales_order_id = $2`, [ENTITY, resale.orderId]);
    const { invoiceFulfilment } = await import("../../packages/core/ar.ts");
    return invoiceFulfilment(c, scope, resale.orderId, lines.map((l) => l.id), 0n);
  });
  const invs = await inTx((c) => trade.invoices(c, site, s1));
  const mineInv = invs.invoices.find((x) => x.id === inv.invoiceId)!;
  const due = (await inTx((c) => q<{ d: string }>(c, `select (invoice_date + 30)::text d from customer_invoice where id = $1 and entity_id = $2`, [inv.invoiceId, ENTITY])))[0].d;
  t.ok("invoices: on account, the invoice is due on net 30", !!mineInv && mineInv.due_date === due && mineInv.openMinor === so1.total_minor);
  await t.throws("invoices: another account cannot pay (or see) it", () => inTx((c) => trade.payInvoice(c, site, s2, inv.invoiceId, { paymentToken: "tok_test_visa_4242" })), /No such invoice/);
  const paid = await inTx((c) => trade.payInvoice(c, site, s1, inv.invoiceId, { paymentToken: "tok_test_visa_4242" }));
  const after = (await inTx((c) => q<{ status: string }>(c, `select status from customer_invoice where id = $1 and entity_id = $2`, [inv.invoiceId, ENTITY])))[0];
  t.ok("invoices: paid by card in the portal, through A/R", paid.paidMinor === so1.total_minor && after.status === "paid");
  await t.throws("invoices: a paid invoice is not paid twice", () => inTx((c) => trade.payInvoice(c, site, s1, inv.invoiceId, { paymentToken: "tok_test_visa_4242" })), /already paid/);

  // ------------------------------------------------------------ follow-ups
  const qt = await as(MARIA, async (c) => {
    const o = await pos.createOrder(c, userScope(MARIA), new Set(["sales"]), { kind: "quote", locationId: LOC.ENOLA, customerId: BRIAN, lines: [{ productId: P.DRESSER, qty: 1, fulfillment: "pickup" }] });
    await c.query(`update sales_order set ordered_at = now() - interval '4 days' where id = $1 and entity_id = $2`, [o.id, ENTITY]);
    return o;
  });
  const fu = await inTx((c) => projects.runFollowUps(c, scope));
  const task = await inTx((c) => q<{ assigned_to: string; title: string; auto: boolean }>(c, `select t.assigned_to, t.title, t.auto from clienteling_followup f join crm_task t on t.id = f.task_id
     where f.entity_id = $1 and f.rule = 'quote_no_sale' and f.sales_order_id = $2`, [ENTITY, qt.id]));
  t.ok("follow-up: 3 days after a quote with no sale, a call task for the salesperson", fu.quoteNoSale >= 1 && task.length === 1 && task[0].assigned_to === MARIA && /Follow up on quote/.test(task[0].title));
  await inTx((c) => projects.runFollowUps(c, scope));
  t.ok("follow-up: running again makes no second task", (await inTx((c) => q(c, `select 1 from clienteling_followup where entity_id = $1 and sales_order_id = $2`, [ENTITY, qt.id]))).length === 1);
  await as(MGR, (c) => projects.saveFollowUpSettings(c, userScope(MGR), { quoteNoSaleDays: 5 }));
  const qt2 = await as(MARIA, async (c) => {
    const o = await pos.createOrder(c, userScope(MARIA), new Set(["sales"]), { kind: "quote", locationId: LOC.ENOLA, customerId: ALICIA, lines: [{ productId: P.DRESSER, qty: 1, fulfillment: "pickup" }] });
    await c.query(`update sales_order set ordered_at = now() - interval '4 days' where id = $1 and entity_id = $2`, [o.id, ENTITY]);
    return o;
  });
  await inTx((c) => projects.runFollowUps(c, scope));
  t.ok("follow-up: the days are configurable (5 days: a 4-day-old quote waits)", (await inTx((c) => q(c, `select 1 from clienteling_followup where entity_id = $1 and sales_order_id = $2`, [ENTITY, qt2.id]))).length === 0);
  await t.throws("follow-up: settings out of range are refused", () => inTx((c) => projects.saveFollowUpSettings(c, scope, { careDays: 0 })), /between 1 and 365 days/);
  await inTx((c) => projects.saveFollowUpSettings(c, scope, { quoteNoSaleDays: 3 }));
  // A project quoted with nothing bought: a task for the account's rep.
  const p2 = await inTx((c) => trade.createProject(c, site, s1, { name: "Primary suite" }));
  await inTx(async (c) => { await trade.addProjectItem(c, site, s1, p2.id, { productId: P.DRESSER });
    await c.query(`update room_project set quoted_at = now() - interval '4 days' where id = $1 and entity_id = $2`, [p2.id, ENTITY]); });
  await inTx((c) => projects.runFollowUps(c, scope));
  const pt = await inTx((c) => q<{ assigned_to: string }>(c, `select t.assigned_to from clienteling_followup f join crm_task t on t.id = f.task_id where f.entity_id = $1 and f.project_id = $2`, [ENTITY, p2.id]));
  t.ok("follow-up: a project quoted 3 days ago with no order gets a task for the account's rep", pt.length === 1 && pt[0].assigned_to === MARIA);

  // ----------------------------------------- designer split and referral payable
  const sale = await as(MARIA, async (c) => {
    const o = await pos.createOrder(c, userScope(MARIA), new Set(["sales"]), { kind: "sale", locationId: LOC.ENOLA, customerId: ALICIA,
      lines: [{ productId: P.LAMP, qty: 2, fulfillment: "carry" }] });
    const line = (await q<{ id: string }>(c, `select id from sales_order_line where entity_id = $1 and sales_order_id = $2 and product_id = $3`, [ENTITY, o.id, P.LAMP]))[0].id;
    return { id: o.id, line };
  });
  await t.throws("split: the designer's share must leave the rep something", () => as(MARIA, (c) => tc.setLineCommission(c, userScope(MARIA), sale.line,
    { primaryId: MARIA, designerId: DESIGNER, designerSplitBps: 10000 })), /between 0\.01% and 99\.99%/);
  await t.throws("referral: a trade account with no referral rate cannot be named", () => as(MARIA, (c) => tc.setLineCommission(c, userScope(MARIA), sale.line,
    { referralTradeAccountId: ok2.tradeAccountId })), /no referral commission set/);
  const lc = await as(MARIA, (c) => tc.setLineCommission(c, userScope(MARIA), sale.line, { primaryId: MARIA, designerId: DESIGNER, designerSplitBps: 4000, referralTradeAccountId: ok1.tradeAccountId }));
  t.ok("split: the line carries the primary rep, the designer's 40% and the referral", lc.split.length === 2 && lc.split.some((x) => x.app_user_id === DESIGNER && x.split_bps === 4000)
    && (lc.referral as { rate_bps: number } | null)?.rate_bps === 1000);
  const cost = await inTx(async (c) => {
    // enough lamps on the Enola floor to take two home
    await c.query(`update stock_level set on_hand = greatest(on_hand, reserved + held + 10) where entity_id = $1 and product_id = $2 and location_id = $3`, [ENTITY, P.LAMP, LOC.ENOLA]);
    return BigInt((await q<{ cost_minor: string }>(c, `select cost_minor from product where id = $1 and entity_id = $2`, [P.LAMP, ENTITY]))[0].cost_minor);
  });
  const sessionId = await as(MARIA, async (c) => {
    const open = (await q<{ id: string }>(c, `select id from pos_session where entity_id = $1 and location_id = $2 and status = 'open' limit 1`, [ENTITY, LOC.ENOLA]))[0];
    if (open) return open.id;
    const reg = (await q<{ id: string }>(c, `select r.id from pos_register r where r.entity_id = $1 and r.location_id = $2 and r.active
        and not exists (select 1 from pos_session s where s.register_id = r.id and s.status = 'open') limit 1`, [ENTITY, LOC.ENOLA]))[0];
    return (await pos.openSession(c, userScope(MARIA), { registerId: reg.id, floatMinor: 10000n })).id;
  });
  await as(MARIA, async (c) => {
    const total = (await q<{ total_minor: string }>(c, `select total_minor from sales_order where id = $1 and entity_id = $2`, [sale.id, ENTITY]))[0].total_minor;
    await pos.checkout(c, userScope(MARIA), sale.id, { sessionId, tenders: [{ method: "card", amountMinor: BigInt(total), reference: "4242" }] });
  });
  await t.throws("split: once handed over, the line's commission is settled", () => as(MARIA, (c) => tc.setLineCommission(c, userScope(MARIA), sale.line, { designerId: null })), /already earned/);
  const ev = await inTx((c) => q<{ app_user_id: string; split_bps: number; sale_minor: string; basis_minor: string; amount_minor: string; kind: string }>(c,
    `select app_user_id, split_bps, sale_minor, basis_minor, amount_minor, kind from commission_event where entity_id = $1 and sales_order_line_id = $2 order by split_bps`, [ENTITY, sale.line]));
  const net = 2n * 5999n, margin = net - 2n * cost;
  const dEv = ev.find((x) => x.app_user_id === DESIGNER), mEv = ev.find((x) => x.app_user_id === MARIA);
  t.ok("split: the designer earns 40% of the line, on gross margin (their plan's basis)", !!dEv && dEv.split_bps === 4000 && dEv.sale_minor === String(bps(net, 4000))
    && BigInt(dEv.basis_minor) === bps(net, 4000) - bps(2n * cost, 4000), JSON.stringify(dEv));
  t.ok("split: the primary rep earns the other 60%", !!mEv && mEv.split_bps === 6000 && mEv.sale_minor === String(bps(net, 6000)));
  const ref = await inTx((c) => q<{ kind: string; amount_minor: string; vendor_id: string; journal_entry_id: string | null }>(c,
    `select kind, amount_minor, vendor_id, journal_entry_id from trade_referral_event where entity_id = $1 and sales_order_line_id = $2`, [ENTITY, sale.line]));
  t.ok("referral: on hand-over the trade account earns 10% of the margin, owed to its vendor", ref.length === 1 && ref[0].kind === "earned"
    && ref[0].amount_minor === bps(margin, 1000).toString() && ref[0].vendor_id === vendorId, JSON.stringify(ref[0]));
  const refJe = await inTx((c) => q<{ code: string; d: string; k: string }>(c, `select g.code, jl.debit_minor::text d, jl.credit_minor::text k from journal_line jl
     join gl_account g on g.id = jl.gl_account_id join journal_entry je on je.id = jl.journal_entry_id where je.entity_id = $2 and jl.journal_entry_id = $1 order by g.code`,
     [ref[0].journal_entry_id, ENTITY]));
  t.ok("referral: posted Dr 6130 Cr 2160 through post()", refJe.some((l) => l.code === "6130" && l.d === ref[0].amount_minor) && refJe.some((l) => l.code === "2160" && l.k === ref[0].amount_minor));
  await as(MARIA, (c) => pos.returnGoods(c, userScope(MARIA), sale.id, { sessionId, lines: [{ lineId: sale.line, qty: 1, reason: "changed_mind", disposition: "restock" }],
    tenders: [{ method: "card", amountMinor: 5999n + bps(5999n, 600), reference: "4242" }] }));
  const back = await inTx((c) => q<{ amount_minor: string }>(c, `select ev.amount_minor from trade_referral_event ev join pos_line pl on pl.sales_order_line_id = ev.sales_order_line_id
     where ev.entity_id = $1 and pl.original_line_id = $2 and ev.kind = 'clawback'`, [ENTITY, sale.line]));
  t.ok("referral: a return claws back the returned piece's share", back.length === 1 && back[0].amount_minor === (-bps(5999n - cost, 1000)).toString(), JSON.stringify(back));
  const dBack = await inTx((c) => q<{ amount_minor: string }>(c, `select ev.amount_minor from commission_event ev join pos_line pl on pl.sales_order_line_id = ev.sales_order_line_id
     where ev.entity_id = $1 and pl.original_line_id = $2 and ev.app_user_id = $3 and ev.kind = 'chargeback'`, [ENTITY, sale.line, DESIGNER]));
  t.ok("split: the return charges back the designer's commission too", dBack.length === 1 && BigInt(dBack[0].amount_minor) < 0n);
  const owed = (await inTx((c) => tc.referralsOwed(c, ENTITY, ok1.tradeAccountId)))[0];
  t.ok("referral: what is owed nets the clawback", owed && BigInt(owed.owed_minor) === bps(margin, 1000) - bps(5999n - cost, 1000));
  const bill = await as(PEOPLE.CONTROLLER, (c) => tc.billReferrals(c, userScope(PEOPLE.CONTROLLER), ok1.tradeAccountId!, PEOPLE.CONTROLLER));
  const billRow = (await inTx((c) => q<{ vendor_id: string; total_minor: string }>(c, `select vendor_id, total_minor from invoice where id = $1 and entity_id = $2`, [bill.invoiceId, ENTITY])))[0];
  t.ok("referral: billed as a payable to the trade account's vendor, coded to 2160", billRow.vendor_id === vendorId && billRow.total_minor === owed.owed_minor);
  await t.throws("referral: nothing is billed twice", () => as(PEOPLE.CONTROLLER, (c) => tc.billReferrals(c, userScope(PEOPLE.CONTROLLER), ok1.tradeAccountId!, PEOPLE.CONTROLLER)), /nothing|no referral commission waiting/);

  // ------------------------------------------------------- suspending
  await t.throws("suspending needs a reason", () => as(MGR, (c) => trade.saveAccount(c, userScope(MGR), ok2.tradeAccountId!, { status: "suspended" }, false)), /Say why/);
  await t.throws("terms need the controller", () => as(MGR, (c) => trade.saveAccount(c, userScope(MGR), ok2.tradeAccountId!, { creditLimitMinor: 100000n }, false)), /needs the controller/);
  await as(MGR, (c) => trade.saveAccount(c, userScope(MGR), ok2.tradeAccountId!, { status: "suspended", statusReason: "unpaid invoices" }, false));
  t.ok("a suspended account's session stops working", (await inTx((c) => trade.sessionFor(c, site, s2tok))) === null);

  // --------------------------------------------------------- over HTTP
  const { createServer } = await import("../../server/index.ts");
  const { _resetLimits } = await import("../../server/modules/trade.ts");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    _resetLimits();
    const page = await fetch(`${base}/trade/buddys/`);
    const html = await page.text();
    const csp = page.headers.get("content-security-policy") ?? "";
    t.ok("portal page: served with the CSP, its script from /trade/assets and no inline script", page.status === 200 && /script-src 'self'/.test(csp)
      && /<script src="\/trade\/assets\/trade\.js/.test(html) && !/<script>|<script(?![^>]*\bsrc=)[^>]*>/.test(html) && !/\son[a-z]+=/i.test(html));
    const js = await fetch(`${base}/trade/assets/trade.js`);
    t.ok("portal script is served as JavaScript", js.status === 200 && /javascript/.test(js.headers.get("content-type") ?? ""));
    const H = { "content-type": "application/json", "x-erp-shop": "1" };
    const noHeader = await fetch(`${base}/trade/buddys/api/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email1 }) });
    t.ok("portal: a POST without the page header is refused", noHeader.status === 403);
    const anon = await fetch(`${base}/trade/buddys/api/orders`);
    const forged = await fetch(`${base}/trade/buddys/api/orders/${resale.orderId}`, { headers: { "x-trade-session": s2tok } });
    t.ok("portal: no session, or a suspended account's, gets nothing", anon.status === 401 && forged.status === 401);
    const own = await fetch(`${base}/trade/buddys/api/orders/${resale.orderId}`, { headers: { "x-trade-session": token1 } });
    t.ok("portal: the account's own order over HTTP", own.status === 200 && (await own.json()).number === resale.order.number);
    const other = await fetch(`${base}/trade/buddys/api/orders/${qt.id}`, { headers: { "x-trade-session": token1 } });
    t.ok("portal: someone else's order id over HTTP is refused", other.status === 422 && /No such order/.test((await other.json()).error));
    const badCode = await fetch(`${base}/trade/buddys/api/verify`, { method: "POST", headers: H, body: JSON.stringify({ email: email1, code: "123456" }) });
    t.ok("portal: a wrong or stale code over HTTP is a plain refusal", badCode.status === 422 && /code/.test((await badCode.json()).error));
    let limitedHit = false;
    for (let i = 0; i < 8 && !limitedHit; i++) {
      const r = await fetch(`${base}/trade/buddys/api/code`, { method: "POST", headers: H, body: JSON.stringify({ email: `flood-${i}@example.com` }) });
      if (r.status === 429) limitedHit = true;
    }
    t.ok("portal: asking for codes is rate limited per address", limitedHit);
    const staff = await fetch(`${base}/api/c/${ENTITY}/trade/accounts`);
    t.ok("staff routes need sign-in", staff.status === 401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
