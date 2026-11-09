// crm module checks: consent, leads and round-robin, conversion, tasks,
// campaigns, coupons, customer merges, isolation and roles.
import type { AddressInfo } from "node:net";
import { tx, q, type Client } from "../../packages/core/db.ts";
import * as crm from "../../packages/core/crm.ts";
import * as shop from "../../packages/core/shop.ts";
import { setAccount } from "../../packages/core/ar.ts";
import { requireRole } from "../../server/modules/kit.ts";
import { ENTITY, RIO_ENTITY, LOC, PEOPLE, TENANT, type T } from "./harness.ts";

const MARIA = "55555555-0000-0000-0000-000000000011";      // sales
const ENOLA_MGR = "55555555-0000-0000-0000-000000000018";  // store manager + sales
const SAM = "55555555-0000-0000-0000-000000000020";        // marketing
const ALICIA = "88888888-0000-0000-0000-000000000001";     // email + sms opt-in, birthday this month
const BRIAN = "88888888-0000-0000-0000-000000000002";
const CHEN = "88888888-0000-0000-0000-000000000003";       // email opt-in only
const DANA = "88888888-0000-0000-0000-000000000004";       // email opt-out
const SOFA = "77777777-0000-0000-0000-000000000001";
const LAMP = "77777777-0000-0000-0000-000000000009";
const FALL_CAMPAIGN = "9f9f0000-0000-0000-0000-000000000001";
const EVERYONE = "9e9e0000-0000-0000-0000-000000000001";
const sys = { kind: "system" as const, label: "crm checks" };
const inTx = <R>(fn: (c: Client) => Promise<R>) => tx(sys, fn);
const scopeAs = (id: string) => ({ tenantId: TENANT, entityId: ENTITY, actor: { kind: "user" as const, id, label: "crm checks" } });
const n = async (sql: string, args: unknown[]) => Number((await inTx((c) => q<{ n: string }>(c, sql, args)))[0].n);
const fails = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return ""; } catch (e) { return (e as Error).message; } };
const rolledBack = async <R>(fn: (c: Client) => Promise<R>): Promise<R> => {
  let out: R | undefined;
  try { await inTx(async (c) => { out = await fn(c); throw new Error("__rollback__"); }); } catch (e) { if ((e as Error).message !== "__rollback__") throw e; }
  return out as R;
};

export async function run(t: T) {
  // ---------------------------------------------------------------- consent
  const cs = await inTx(async (c) => ({
    aliciaEmail: await crm.canMarket(c, ENTITY, ALICIA, "email"), aliciaSms: await crm.canMarket(c, ENTITY, ALICIA, "sms"),
    chenSms: await crm.canMarket(c, ENTITY, CHEN, "sms"), danaEmail: await crm.canMarket(c, ENTITY, DANA, "email"),
    brianEmail: await crm.canMarket(c, ENTITY, BRIAN, "email"),
  }));
  t.ok("consent: an opt-in allows email and texts", cs.aliciaEmail.ok && cs.aliciaSms.ok);
  t.ok("consent: texting needs an explicit opt-in (email consent is not enough)", !cs.chenSms.ok && /written consent/.test(cs.chenSms.reason ?? ""));
  t.ok("consent: an opt-out stops email", !cs.danaEmail.ok && /opted out/.test(cs.danaEmail.reason ?? ""));
  t.ok("consent: no answer on file means no marketing email", !cs.brianEmail.ok);
  await t.throws("consent history cannot be edited", () => inTx((c) => c.query(`update crm_consent set status = 'opt_in' where customer_id = $1`, [DANA])), /never changed/);

  // quiet hours
  const late = new Date("2026-11-10T04:30:00Z");            // 11:30pm in Pennsylvania, 10:30pm in Texas
  const pa = crm.outsideQuietHours(late, crm.tzForState("PA")), tx_ = crm.outsideQuietHours(late, crm.tzForState("TX"));
  t.ok("quiet hours: a late-night text waits until 8am where the customer lives", pa.toISOString() === "2026-11-10T13:00:00.000Z" && tx_.toISOString() === "2026-11-10T14:00:00.000Z",
    `${pa.toISOString()} ${tx_.toISOString()}`);
  const noon = new Date("2026-11-10T17:00:00Z");
  t.ok("quiet hours: a daytime text goes now", crm.outsideQuietHours(noon, "America/New_York").getTime() === noon.getTime());

  // ---------------------------------------------------- campaigns and consent
  const launch = await inTx((c) => crm.launchCampaign(c, ENTITY, FALL_CAMPAIGN, "https://erp.example"));
  const msgs = await inTx((c) => q<{ customer_id: string; status: string; reason: string | null; body: string; subject: string | null; unsub_token: string }>(c,
    `select customer_id, status, reason, body, subject, unsub_token from crm_message where entity_id = $1 and campaign_id = $2`, [ENTITY, FALL_CAMPAIGN]));
  const msgOf = (id: string) => msgs.find((m) => m.customer_id === id);
  t.ok("campaign: only customers who said yes are queued", msgOf(ALICIA)?.status === "queued" && msgOf(CHEN)?.status === "queued", JSON.stringify(launch));
  t.ok("campaign: everyone else is suppressed with the reason, not dropped", msgOf(DANA)?.status === "suppressed" && /opted out/.test(msgOf(DANA)!.reason!)
    && msgOf(BRIAN)?.status === "suppressed" && launch.members === msgs.length);
  t.ok("campaign: merge fields filled, unsubscribe link added, coupon code inserted", /^Hi Alicia,/.test(msgOf(ALICIA)!.body) && msgOf(ALICIA)!.body.includes("FALL10")
    && msgOf(ALICIA)!.body.includes(`https://erp.example/crm/u/${msgOf(ALICIA)!.unsub_token}`) && msgOf(ALICIA)!.subject === "Fall living room event, Alicia" && !/\{\{/.test(msgOf(ALICIA)!.body));
  await t.throws("campaign: the same campaign cannot go out twice", () => inTx((c) => crm.launchCampaign(c, ENTITY, FALL_CAMPAIGN, "")), /already gone out/);
  // An opt-out between building and sending still stops the message.
  await inTx((c) => crm.recordConsent(c, ENTITY, CHEN, "email", "opt_out", "phone call", ENOLA_MGR));
  const sent = await inTx((c) => crm.processQueue(c, ENTITY));
  const after = await inTx((c) => q<{ customer_id: string; status: string; reason: string | null }>(c,
    `select customer_id, status, reason from crm_message where entity_id = $1 and campaign_id = $2 and customer_id = any($3::uuid[])`, [ENTITY, FALL_CAMPAIGN, [ALICIA, CHEN]]));
  t.ok("campaign: consent is checked again at send time", after.find((m) => m.customer_id === ALICIA)?.status === "sent"
    && after.find((m) => m.customer_id === CHEN)?.status === "suppressed" && sent.sent === 1 && sent.stopped === 1, JSON.stringify(sent));

  // SMS: consent and quiet hours
  const sms = await inTx(async (c) => {
    const id = await crm.saveCampaign(c, ENTITY, SAM, { name: "Text: delivery week", channel: "sms", segmentId: EVERYONE, body: "Hi {{first_name}}, {{store}} has delivery slots this week." });
    const r = await crm.launchCampaign(c, ENTITY, id, "", new Date("2026-11-10T04:30:00Z"));
    const rows = await q<{ customer_id: string; status: string; send_after: string; body: string }>(c,
      `select customer_id, status, send_after, body from crm_message where entity_id = $1 and campaign_id = $2`, [ENTITY, id]);
    return { r, rows };
  });
  const aSms = sms.rows.find((x) => x.customer_id === ALICIA)!;
  t.ok("text campaign: only the explicit text opt-in is queued", sms.rows.filter((x) => x.status === "queued").length === 1 && aSms.status === "queued");
  t.ok("text campaign: queued at night, it waits for morning and carries STOP wording", new Date(aSms.send_after).toISOString() === "2026-11-10T13:00:00.000Z" && /Reply STOP/.test(aSms.body));
  await t.throws("an email campaign needs a subject", () => inTx((c) => crm.saveCampaign(c, ENTITY, SAM, { name: "x", channel: "email", segmentId: EVERYONE, body: "hi" })), /subject/);

  // Unsubscribe link
  const token = msgOf(ALICIA)!.unsub_token;
  const u1 = await inTx((c) => crm.unsubscribe(c, token));
  const u2 = await inTx((c) => crm.unsubscribe(c, token));
  const aliceEmail = await inTx((c) => crm.canMarket(c, ENTITY, ALICIA, "email"));
  t.ok("unsubscribe link: opts the customer out of that channel, once, and says so twice", u1.channel === "email" && u2.channel === "email" && !aliceEmail.ok
    && (await n(`select count(*) n from crm_consent where entity_id = $1 and customer_id = $2 and source = 'unsubscribe link'`, [ENTITY, ALICIA])) === 1);
  t.ok("unsubscribe link: texts stay as they were", (await inTx((c) => crm.canMarket(c, ENTITY, ALICIA, "sms"))).ok);
  await t.throws("unsubscribe: a made-up token is refused", () => inTx((c) => crm.unsubscribe(c, "x".repeat(24))), /not valid/);

  // ------------------------------------------------------- leads, round-robin
  const rr = await inTx(async (c) => {
    const out = [];
    for (const name of ["RR One", "RR Two", "RR Three", "RR Four"]) out.push(await crm.createLead(c, ENTITY, MARIA, { source: "walk_in", name, locationId: LOC.ENOLA, phone: `717555${String(out.length).padStart(4, "7")}` }));
    return q<{ number: string; assigned_to: string; next_follow_up_at: string | null }>(c, `select number, assigned_to, next_follow_up_at from crm_lead where entity_id = $1 and id = any($2::uuid[]) order by number`, [ENTITY, out.map((x) => x.id)]);
  });
  t.ok("round-robin: Enola walk-ins alternate between the two salespeople", rr.map((x) => x.assigned_to).join(",") === [MARIA, ENOLA_MGR, MARIA, ENOLA_MGR].join(","),
    rr.map((x) => x.assigned_to.slice(-2)).join(","));
  t.ok("every assigned lead gets a first-contact follow-up", rr.every((x) => !!x.next_follow_up_at)
    && (await n(`select count(*) n from crm_task where entity_id = $1 and auto and lead_id in (select id from crm_lead where entity_id = $1 and name like 'RR %') and done_at is null`, [ENTITY])) === 4);
  const soc = await inTx((c) => crm.createLead(c, ENTITY, null, { source: "phone", name: "No Rule", phone: "9155550100", locationId: LOC.SOCORRO }));
  t.ok("round-robin: no rule for the store leaves the lead unassigned (and no task)",
    (await n(`select count(*) n from crm_lead where id = $1 and entity_id = $2 and assigned_to is null`, [soc.id, ENTITY])) === 1
    && (await n(`select count(*) n from crm_task where lead_id = $1 and entity_id = $2`, [soc.id, ENTITY])) === 0);
  await t.throws("a lead needs a way to follow up", () => inTx((c) => crm.createLead(c, ENTITY, null, { source: "web_form", name: "Nobody" })), /email or a phone/);

  // duplicates
  const d1 = await inTx((c) => crm.createLead(c, ENTITY, null, { source: "phone", name: "A. Gomez", email: "ALICIA@example.com" }));
  const d2 = await inTx((c) => crm.createLead(c, ENTITY, null, { source: "phone", name: "Ed Martinez", phone: "2125550199" }));
  const dd = await inTx((c) => q<{ id: string; customer_id: string | null; duplicate_of: string | null }>(c, `select id, customer_id, duplicate_of from crm_lead where entity_id = $1 and id = any($2::uuid[])`, [ENTITY, [d1.id, d2.id]]));
  t.ok("duplicate detection: a matching email links the existing customer", dd.find((x) => x.id === d1.id)?.customer_id === ALICIA);
  t.ok("duplicate detection: a name-only match is flagged, not linked", dd.find((x) => x.id === d2.id)?.customer_id === null && dd.find((x) => x.id === d2.id)?.duplicate_of === "88888888-0000-0000-0000-000000000006");

  // ----------------------------------------------------- tasks and my day
  const first = rr[0];
  const fl = (await inTx((c) => q<{ id: string; lead_id: string }>(c, `select t.id, t.lead_id from crm_task t join crm_lead l on l.id = t.lead_id where t.entity_id = $1 and l.number = $2 and t.done_at is null`, [ENTITY, first.number])))[0];
  await inTx((c) => crm.completeTask(c, ENTITY, MARIA, fl.id, "Left a voicemail"));
  const fx = (await inTx((c) => q<{ stage: string; first_response_at: string | null; open: string }>(c, `select stage, first_response_at,
      (select count(*) from crm_task t where t.lead_id = l.id and t.entity_id = l.entity_id and t.done_at is null and t.cancelled_at is null)::text open from crm_lead l where l.id = $1 and l.entity_id = $2`, [fl.lead_id, ENTITY])))[0];
  t.ok("doing the first call marks the lead contacted, stamps response time, and sets the next follow-up", fx.stage === "contacted" && !!fx.first_response_at && fx.open === "1");
  const day = await inTx((c) => crm.myDay(c, ENTITY, MARIA));
  t.ok("my day: overdue work is counted and listed first", day.overdue >= 1 && (day.tasks[0] as { overdue: boolean }).overdue === true);
  const at = new Date(Date.now() + 3 * 86400_000); at.setUTCHours(18, 0, 0, 0);
  const appt = await inTx((c) => crm.createTask(c, ENTITY, MARIA, { assignedTo: MARIA, kind: "appointment", title: "Design consult: RR One", dueAt: at.toISOString(),
    locationId: LOC.ENOLA, leadId: fl.lead_id }));
  t.ok("booking a design consultation moves the lead to appointment", !!appt && (await n(`select count(*) n from crm_lead where id = $1 and entity_id = $2 and stage = 'appointment'`, [fl.lead_id, ENTITY])) === 1);
  await t.throws("appointments for one salesperson cannot overlap", () => inTx((c) => crm.createTask(c, ENTITY, MARIA, { assignedTo: MARIA, kind: "appointment",
    title: "Double booked", dueAt: new Date(at.getTime() + 30 * 60_000).toISOString(), locationId: LOC.ENOLA })), /overlaps/);
  await t.throws("an appointment is at a showroom", () => inTx((c) => crm.createTask(c, ENTITY, MARIA, { assignedTo: MARIA, kind: "appointment", title: "Where?", dueAt: at.toISOString() })), /showroom/);
  await t.throws("losing a lead needs a reason", () => inTx((c) => crm.moveLead(c, ENTITY, MARIA, soc.id, "lost")), /why/);

  // ------------------------------------------------------- conversion to a quote
  const conv = await inTx(async (c) => {
    const l = await crm.createLead(c, ENTITY, MARIA, { source: "walk_in", name: "Quinn Quote", email: "quinn@example.com", phone: "7175550177", locationId: LOC.ENOLA,
      items: [{ productId: SOFA, qty: 1 }], consent: { email: true, sms: true, source: "in store" } });
    const r = await crm.convertLead(c, scopeAs(MARIA), new Set(["sales"]), l.id, {});
    const so = (await q<{ channel: string; status: string; customer_id: string; kind: string; total_minor: string; subtotal_minor: string }>(c, `
      select so.channel, so.status, so.customer_id, po.kind, so.total_minor, so.subtotal_minor from sales_order so join pos_order po on po.sales_order_id = so.id
       where so.id = $1 and so.entity_id = $2`, [r.quote!.id, ENTITY]))[0];
    const lead = (await q<{ stage: string; customer_id: string; sales_order_id: string }>(c, `select stage, customer_id, sales_order_id from crm_lead where id = $1 and entity_id = $2`, [l.id, ENTITY]))[0];
    return { l, r, so, lead, sms: await crm.canMarket(c, ENTITY, r.customerId, "sms") };
  });
  t.ok("convert: one tap makes the customer and a POS quote for what they wanted", conv.r.createdCustomer && conv.so.kind === "quote" && conv.so.channel === "pos"
    && conv.so.status === "draft" && conv.so.customer_id === conv.r.customerId && conv.so.subtotal_minor === "79999");
  t.ok("convert: the lead is quoted and points at the customer and the quote", conv.lead.stage === "quoted" && conv.lead.customer_id === conv.r.customerId && conv.lead.sales_order_id === conv.r.quote!.id);
  t.ok("convert: consent given on the lead lands on the customer with its source", conv.sms.ok);
  await t.throws("convert: a lead converts once", () => inTx((c) => crm.convertLead(c, scopeAs(MARIA), new Set(["sales"]), conv.l.id, {})), /already has a quote/);
  const conv2 = await inTx((c) => crm.convertLead(c, scopeAs(MARIA), new Set(["sales"]), d1.id, {}));
  t.ok("convert: a lead that matched a customer uses that customer, no duplicate made", conv2.customerId === ALICIA && !conv2.createdCustomer && !conv2.quote);

  // --------------------------------------------- coupons through the web store
  const site = await inTx(async (c) => (await shop.siteBySlug(c, "buddys"))!);
  const webIn = (over: Record<string, unknown>) => shop.parseCheckout({ cartId: `crm-${Math.random().toString(36).slice(2, 12)}`, email: "coupon.buyer@example.com",
    name: "Coupon Buyer", fulfillment: "delivery", address: { line1: "1 Elm St", city: "Camp Hill", state: "PA", postal: "17011" }, paymentToken: "tok_test_visa_4242",
    lines: [{ productId: SOFA, qty: 1 }], couponCode: "FALL10", ...over });
  const webScope = { tenantId: TENANT, entityId: ENTITY, actor: sys };
  const w1in = webIn({ cartId: "crm-coupon-0001" });
  const w1 = await inTx((c) => shop.placeWebOrder(c, site, w1in, webScope));
  const o1 = (await inTx((c) => q<{ id: string; discount_minor: string; tax_minor: string; subtotal_minor: string; total_minor: string }>(c,
    `select id, discount_minor, tax_minor, subtotal_minor, total_minor from sales_order where entity_id = $1 and number = $2`, [ENTITY, w1.order.number])))[0];
  const disc = (79999n * 1000n + 5000n) / 10000n;
  t.ok("coupon on the web: 10% comes off the merchandise and tax is on the discounted price", o1.discount_minor === disc.toString()
    && BigInt(o1.total_minor) === BigInt(o1.subtotal_minor) - disc + BigInt(o1.tax_minor), JSON.stringify(o1));
  const w1again = await inTx((c) => shop.placeWebOrder(c, site, w1in, webScope));
  const r2 = await inTx((c) => crm.redeemCoupon(c, ENTITY, null, { code: "fall10", orderId: o1.id, channel: "web", discountMinor: disc }));
  t.ok("coupon redemption is idempotent: a double submit and a repeat call count once", w1again.duplicate && r2.already
    && (await n(`select count(*) n from crm_coupon_redemption where entity_id = $1 and sales_order_id = $2`, [ENTITY, o1.id])) === 1);
  await t.throws("coupon: once per customer", () => inTx((c) => shop.placeWebOrder(c, site, webIn({}), webScope)), /already been used by this customer/);
  await t.throws("coupon: a minimum spend applies", () => inTx((c) => shop.placeWebOrder(c, site, webIn({ email: "small@example.com", lines: [{ productId: LAMP, qty: 1 }] }), webScope)), /at least/);
  await t.throws("coupon: an unknown code is refused", () => inTx((c) => shop.quote(c, site, webIn({ couponCode: "NOPE99" }))), /not a valid coupon/);
  const q2 = await inTx((c) => shop.quote(c, site, webIn({ email: "w25@example.com", couponCode: "WELCOME25" })));
  t.ok("coupon: the checkout preview shows the code and what it takes off", q2.coupon?.discountMinor === "2500");
  // POS: the discount goes on the sale through POS's rules first; the redemption only credits it.
  await t.throws("coupon at the register: refused until the discount is on the sale", () => inTx((c) => crm.redeemCoupon(c, ENTITY, MARIA,
    { code: "WELCOME25", orderId: conv.r.quote!.id, channel: "pos" })), /to the sale first/);
  const campaignRow = (await inTx((c) => crm.campaignResults(c, ENTITY))).find((k) => k.id === FALL_CAMPAIGN)!;
  t.ok("campaign results: redemptions and revenue are credited to the campaign", campaignRow.redeemed === 1 && campaignRow.revenue_minor === o1.total_minor && campaignRow.sent === 1,
    JSON.stringify({ r: campaignRow.redeemed, rev: campaignRow.revenue_minor, sent: campaignRow.sent }));

  // won when the linked order is paid
  const wonLead = await inTx(async (c) => {
    const l = await crm.createLead(c, ENTITY, MARIA, { source: "campaign", name: "Coupon Buyer", email: "coupon.buyer@example.com", campaignId: FALL_CAMPAIGN, locationId: LOC.ENOLA });
    await crm.linkOrder(c, ENTITY, MARIA, l.id, w1.order.number);
    return (await q<{ stage: string; won_at: string | null }>(c, `select stage, won_at from crm_lead where id = $1 and entity_id = $2`, [l.id, ENTITY]))[0];
  });
  t.ok("a lead is won when its linked order is paid", wonLead.stage === "won" && !!wonLead.won_at);

  // ------------------------------------------------------------- segments
  const segs = await inTx(async (c) => ({
    bday: await crm.segmentMembers(c, ENTITY, crm.parseFilter({ birthdayMonth: 0 })),
    sofa: await crm.segmentMembers(c, ENTITY, crm.parseFilter({ boughtSubcategory: "Sofas", monthsAgoMax: 1 })),
    tag: await crm.segmentMembers(c, ENTITY, crm.parseFilter({ tag: "VIP" })),
    rio: await crm.segmentMembers(c, RIO_ENTITY, crm.parseFilter({})),
  }));
  t.ok("segments: birthday this month, bought a sofa recently, tag", segs.bday.some((x) => x.id === ALICIA) && segs.sofa.some((x) => x.email === "coupon.buyer@example.com")
    && segs.tag.length === 1 && segs.tag[0].id === ALICIA);
  await t.throws("segments: a bad filter is refused in words", async () => crm.parseFilter({ monthsAgoMin: 18, monthsAgoMax: 6 }), /ends before it starts/);

  // ---------------------------------------------------- abandoned carts
  const cap1 = await inTx((c) => crm.captureAbandonedCarts(c, ENTITY, 60));
  const cap2 = await inTx((c) => crm.captureAbandonedCarts(c, ENTITY, 60));
  t.ok("abandoned carts with an email become leads, once", cap1 >= 1 && cap2 === 0
    && (await n(`select count(*) n from crm_lead where entity_id = $1 and source = 'abandoned_cart' and email = 'brian@example.com'`, [ENTITY])) === 1);

  // ---------------------------------------------------------------- merge
  const dupOrder = await inTx((c) => shop.placeWebOrder(c, site, webIn({ cartId: "crm-merge-0001", email: "ali.gomez@example.com", name: "Ali Gomez", couponCode: null,
    lines: [{ productId: LAMP, qty: 1 }], phone: "7175550101" }), webScope));
  const dupId = (await inTx((c) => q<{ customer_id: string }>(c, `select customer_id from sales_order where entity_id = $1 and number = $2`, [ENTITY, dupOrder.order.number])))[0].customer_id;
  await inTx((c) => crm.recordConsent(c, ENTITY, dupId, "sms", "opt_out", "STOP reply", null));
  const dups = await inTx((c) => crm.findDuplicates(c, ENTITY, { phone: "717-555-0101", exceptId: dupId }));
  t.ok("duplicate customers are found by phone", dups.some((x) => x.id === ALICIA && x.why === "same phone"));
  const before = { orders: await n(`select count(*) n from sales_order where entity_id = $1 and customer_id = $2`, [ENTITY, ALICIA]) };
  const merged = await inTx((c) => crm.mergeCustomers(c, scopeAs(ENOLA_MGR), ALICIA, dupId, "Same phone; she used a second email online", ENOLA_MGR));
  const m = await inTx(async (c) => ({
    orders: await q(c, `select 1 from sales_order where entity_id = $1 and customer_id = $2`, [ENTITY, dupId]),
    receipts: await q(c, `select 1 from customer_receipt where entity_id = $1 and customer_id = $2`, [ENTITY, dupId]),
    addrDefaults: await q(c, `select 1 from customer_address where entity_id = $1 and customer_id = $2 and is_default`, [ENTITY, ALICIA]),
    gone: (await q<{ status: string; email: string | null; merged_into: string }>(c, `select cu.status, cu.email, pf.merged_into from customer cu join crm_profile pf on pf.customer_id = cu.id where cu.id = $1 and cu.entity_id = $2`, [dupId, ENTITY]))[0],
    sms: await crm.canMarket(c, ENTITY, ALICIA, "sms"),
    rec: await q(c, `select moved from crm_merge where entity_id = $1 and merged_id = $2`, [ENTITY, dupId]),
    audit: await q(c, `select 1 from audit_event where entity_id = $1 and table_name = 'customer' and row_id = $2 and action = 'transition'`, [ENTITY, dupId]),
  }));
  t.ok("merge: orders, receipts and addresses move to the survivor", m.orders.length === 0 && m.receipts.length === 0 && merged.moved["sales_order.customer_id"] === 1
    && (await n(`select count(*) n from sales_order where entity_id = $1 and customer_id = $2`, [ENTITY, ALICIA])) === before.orders + 1, JSON.stringify(merged.moved));
  t.ok("merge: the survivor keeps exactly one default address", m.addrDefaults.length === 1);
  t.ok("merge: the duplicate stays, inactive, pointing at the survivor, its email freed", m.gone.status === "inactive" && m.gone.email === null && m.gone.merged_into === ALICIA);
  t.ok("merge: an opt-out on the duplicate carries over (a STOP is never lost)", !m.sms.ok);
  t.ok("merge: recorded with what moved, and audited", m.rec.length === 1 && m.audit.length === 1);
  await t.throws("merge: a customer cannot be merged twice", () => inTx((c) => crm.mergeCustomers(c, scopeAs(ENOLA_MGR), BRIAN, dupId, "again", ENOLA_MGR)), /already merged/);
  await t.throws("merge: not into itself", () => inTx((c) => crm.mergeCustomers(c, scopeAs(ENOLA_MGR), BRIAN, BRIAN, "x", ENOLA_MGR)), /into itself/);
  const refusal = await rolledBack(async (c) => {
    await setAccount(c, scopeAs(ENOLA_MGR), BRIAN, { houseAccount: true, creditLimitMinor: 100000n });
    await setAccount(c, scopeAs(ENOLA_MGR), CHEN, { houseAccount: true, creditLimitMinor: 100000n });
    const ordersBefore = Number((await q<{ n: string }>(c, `select count(*) n from sales_order where entity_id = $1 and customer_id = $2`, [ENTITY, CHEN]))[0].n);
    await c.query("savepoint t");
    const why = await fails(() => crm.mergeCustomers(c, scopeAs(ENOLA_MGR), BRIAN, CHEN, "test", ENOLA_MGR));
    await c.query("rollback to savepoint t");
    const ordersAfter = Number((await q<{ n: string }>(c, `select count(*) n from sales_order where entity_id = $1 and customer_id = $2`, [ENTITY, CHEN]))[0].n);
    return { why, same: ordersBefore === ordersAfter };
  });
  t.ok("merge: refused, naming the table, when both have a record that can exist once — and nothing moves", /ar account/.test(refusal.why) && refusal.same, refusal.why);

  // -------------------------------------------------------------- isolation
  const iso = await inTx(async (c) => ({
    c360: await crm.customer360(c, RIO_ENTITY, ALICIA),
    leads: await crm.leads(c, RIO_ENTITY, {}),
    createLead: await fails(() => crm.createLead(c, RIO_ENTITY, null, { source: "phone", name: "X", phone: "9565550100", locationId: LOC.ENOLA })),
    coupon: await fails(() => crm.checkCoupon(c, RIO_ENTITY, "FALL10", { channel: "web", subtotalMinor: 100000n })),
    redeem: await fails(() => crm.redeemCoupon(c, RIO_ENTITY, null, { code: "FALL10", orderId: o1.id, channel: "web" })),
    merge: await fails(() => crm.mergeCustomers(c, { ...scopeAs(ENOLA_MGR), entityId: RIO_ENTITY }, ALICIA, BRIAN, "x", null)),
    consent: await fails(() => crm.recordConsent(c, RIO_ENTITY, ALICIA, "email", "opt_in", "x")),
    dash: await crm.dashboard(c, RIO_ENTITY),
  }));
  t.ok("isolation: another company sees none of this company's customers or leads", iso.c360 === null && iso.leads.length === 0 && iso.dash.leads === 0 && segs.rio.every((x) => x.id !== ALICIA));
  t.ok("isolation: another company cannot use this company's stores, coupons, orders or customers",
    /No such store/.test(iso.createLead) && /not a valid coupon/.test(iso.coupon) && /No such order/.test(iso.redeem) && /belong to this company/.test(iso.merge) && /No such customer/.test(iso.consent));

  // -------------------------------------------------------------------- roles
  const role = async (who: string, roles: string[], doing: string) => fails(() => t.as(who, (c, co, a) => requireRole(c, co, a, roles, doing)));
  t.ok("roles: a clerk cannot work leads", /needs one of/.test(await role(PEOPLE.CLERK, ["sales", "store_manager", "marketing"], "adding a lead")));
  t.ok("roles: sales cannot send a campaign; marketing can", /needs one of/.test(await role(MARIA, ["marketing", "web_admin"], "sending a campaign")) && (await role(SAM, ["marketing", "web_admin"], "sending a campaign")) === "");
  t.ok("roles: sales cannot merge customers; a store manager can", /needs one of/.test(await role(MARIA, ["store_manager"], "merging")) && (await role(ENOLA_MGR, ["store_manager"], "merging")) === "");
  t.ok("roles: the owner passes", (await role(PEOPLE.STEVE, ["marketing"], "anything")) === "");
  t.ok("roles: marketing is a role the database accepts", (await n(`select count(*) n from role_grant where role = 'marketing' and entity_id = $1`, [ENTITY])) === 1);

  // ---------------------------------------------------------------- dashboard
  const dash = await inTx((c) => crm.dashboard(c, ENTITY));
  t.ok("dashboard: pipeline by stage, salesperson and store; conversion and response time", dash.pipeline.length >= 4 && dash.bySales.length >= 2 && dash.byStore.length >= 1
    && dash.conversionBps != null && dash.responseMinutes != null && dash.segments.length >= 3, JSON.stringify({ c: dash.conversionBps, r: dash.responseMinutes }));
  const c360 = await inTx((c) => crm.customer360(c, ENTITY, ALICIA));
  t.ok("customer 360: profile, household, consent, lifetime value, timeline across channels", !!c360 && c360.household.length === 1 && c360.consent.length === 3
    && BigInt(c360.lifetimeValueMinor) > 0n && c360.timeline.some((x) => x.kind === "order") && c360.timeline.some((x) => x.kind === "note") && c360.relations.length >= 1);

  // ------------------------------------------------------------- over HTTP
  const { createServer } = await import("../../server/index.ts");
  const { _resetLimits, LIMITS } = await import("../../server/modules/crm.ts");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const H = { "content-type": "application/json", "x-erp-shop": "1" };
  try {
    _resetLimits();
    const no = await fetch(`${base}/shop/buddys/api/lead`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    t.ok("public lead form: refused without the store header", no.status === 403);
    const ok = await fetch(`${base}/shop/buddys/api/lead`, { method: "POST", headers: H, body: JSON.stringify({ kind: "quote", name: "Web Quote", email: "webquote@example.com",
      phone: "717 555 0188", message: "Price for the sofa in navy?", productId: SOFA, consentEmail: true, utmCampaign: "fall-living-room-event" }) });
    const okj = await ok.json();
    const wl = (await inTx((c) => q<{ source: string; items: unknown[]; consent: Record<string, string>; assigned_to: string | null; utm_campaign: string }>(c,
      `select source, items, consent, assigned_to, utm_campaign from crm_lead where entity_id = $1 and number = $2`, [ENTITY, okj.reference])))[0];
    t.ok("public lead form: a quote request becomes a lead with the product, consent and attribution", ok.status === 200 && wl?.source === "quote_request"
      && wl.items.length === 1 && wl.consent.email === "opt_in" && wl.utm_campaign === "fall-living-room-event", JSON.stringify(okj));
    const bad = await fetch(`${base}/shop/buddys/api/lead`, { method: "POST", headers: H, body: JSON.stringify({ name: "No contact" }) });
    t.ok("public lead form: a refusal is a plain sentence", bad.status === 422 && typeof (await bad.json()).error === "string");
    let status = 0;
    for (let i = 0; i <= LIMITS.lead.max; i++) status = (await fetch(`${base}/shop/buddys/api/lead`, { method: "POST", headers: H, body: JSON.stringify({ name: "Spam", email: `s${i}@example.com` }) })).status;
    t.ok("public lead form: rate limited per address", status === 429);
    const tok = (await inTx((c) => q<{ unsub_token: string }>(c, `select unsub_token from crm_message where entity_id = $1 and customer_id = $2 and channel = 'sms' limit 1`, [ENTITY, ALICIA])))[0].unsub_token;
    const page = await fetch(`${base}/crm/u/${tok}`);
    const html = await page.text();
    t.ok("unsubscribe page: served under the app's CSP, no inline script", page.status === 200 && /script-src 'self'/.test(page.headers.get("content-security-policy") ?? "")
      && !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) && html.includes("Unsubscribe"));
    const post = await fetch(`${base}/crm/u/${tok}`, { method: "POST", headers: H, body: "{}" });
    t.ok("unsubscribe link: one click opts out of texts", post.status === 200 && !(await inTx((c) => crm.canMarket(c, ENTITY, ALICIA, "sms"))).ok);
    t.ok("unsubscribe link: a bad token is a 404 page", (await fetch(`${base}/crm/u/${"z".repeat(30)}`)).status === 404);
  } finally {
    _resetLimits();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
