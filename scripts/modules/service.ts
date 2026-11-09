// Service and repair checks: tickets from every door, coverage by the rules,
// the workflow the database holds, parts through purchasing and inventory, a
// technician's visit on a fleet route, billing to A/R, costs to the right
// accounts, vendor claims, the public form's limits, roles, and isolation.

import { type T, ENTITY, RIO_ENTITY, PEOPLE } from "./harness.ts";
import { tx, type Client, type Scope } from "../../packages/core/db.ts";
import * as S from "../../packages/core/service.ts";
import * as F from "../../packages/core/fleet.ts";
import * as inventory from "../../packages/core/inventory.ts";
import { invoiceFulfilment } from "../../packages/core/ar.ts";
import * as pos from "../../packages/core/pos.ts";
import { module as serviceModule } from "../../server/modules/service.ts";
import { module as fleetModule } from "../../server/modules/fleet.ts";
import type { Actor } from "../../server/modules/kit.ts";
import { PublicPage } from "../../server/modules/kit.ts";

const DC = "33333333-0000-0000-0000-0000000000dc";
const ENOLA = "33333333-0000-0000-0000-000000000001";
const P = { ...PEOPLE, MARIA: "55555555-0000-0000-0000-000000000011", LUIS: "55555555-0000-0000-0000-000000000012",
  DEE: "55555555-0000-0000-0000-000000000013", RAY: "55555555-0000-0000-0000-000000000014", TONY: "55555555-0000-0000-0000-000000000015",
  ANA: "55555555-0000-0000-0000-000000000016", MGR: "55555555-0000-0000-0000-000000000018", PAT: "55555555-0000-0000-0000-000000000031",
  RIO_OWNER: "eeee0000-0000-0000-0000-000000000201" };
const PROD = { SOFA: "77777777-0000-0000-0000-000000000001", RECLINER: "77777777-0000-0000-0000-000000000007", PLAN: "77777777-0000-0000-0000-000000000012",
  MOTOR: "77777777-0000-0000-0000-000000000053", CALL: "77777777-0000-0000-0000-000000000051" };
const CUST = { ALICIA: "88888888-0000-0000-0000-000000000001", BRIAN: "88888888-0000-0000-0000-000000000002", CHEN: "88888888-0000-0000-0000-000000000003" };
const SIG = "data:image/png;base64," + "iVBORw0KGgo".repeat(20);

type Handler = { method: string; re: RegExp; fn: (...a: unknown[]) => Promise<unknown>; pub: boolean };

export async function run(t: T) {
  // ---------------------------------------------------- the routes, as the server runs them
  const H: Handler[] = [];
  for (const m of [serviceModule, fleetModule]) m.register({
    coGet: (tail, fn) => H.push({ method: "GET", re: new RegExp(`^${tail}$`), fn: fn as Handler["fn"], pub: false }),
    coPost: (tail, fn) => H.push({ method: "POST", re: new RegExp(`^${tail}$`), fn: fn as Handler["fn"], pub: false }),
    publicRoute: (method, path, fn) => H.push({ method, re: path, fn: fn as Handler["fn"], pub: true }),
  });
  const find = (method: string, path: string, pub = false) => {
    const h = H.find((x) => x.method === method && x.pub === pub && x.re.test(path));
    if (!h) throw new Error(`no ${method} ${path}`);
    return { h, mm: path.match(h.re)! };
  };
  const get = async (path: string, personId: string | null, entity = ENTITY) => {
    const u = new URL("http://x" + path);
    const { h, mm } = find("GET", u.pathname);
    const co = await t.company(entity);
    const c = await t.pool.connect();
    try { return await h.fn(c, co, u, [u.pathname, co.id, ...mm.slice(1)], personId) as any; } finally { c.release(); }
  };
  const nameOf = async (id: string) => {
    const c = await t.pool.connect();
    try { return (await t.q<{ name: string }>(c, "select name from app_user where id = $1 /* unscoped: lookup */", [id]))[0]?.name ?? "?"; } finally { c.release(); }
  };
  const postIn = async (entity: string, personId: string, path: string, body: Record<string, unknown> = {}) => {
    const { h, mm } = find("POST", path);
    const co = await t.company(entity);
    const name = await nameOf(personId);
    const a: Actor = { personId, personName: name, label: name };
    return tx({ kind: "user", id: personId, label: name }, (c) => h.fn(c, co, a, body, [path, co.id, ...mm.slice(1)])) as Promise<any>;
  };
  const post = (personId: string, path: string, body: Record<string, unknown> = {}) => postIn(ENTITY, personId, path, body);
  const pub = async (method: "GET" | "POST", path: string, body: Record<string, unknown> = {}, ip = "203.0.113.7") => {
    const { h, mm } = find(method, path, true);
    return h.fn({ headers: { "x-erp-shop": "1", "x-forwarded-for": ip }, socket: {} }, new URL("http://x" + path), mm, body) as Promise<[number, any]>;
  };
  const one = async <X = any>(sql: string, params: unknown[] = []) => {
    const c = await t.pool.connect();
    try { return (await t.q(c, sql, params))[0] as X; } finally { c.release(); }
  };
  const scopeFor = (co: { tenantId: string }, a: Actor): Scope => ({ tenantId: co.tenantId, entityId: ENTITY, actor: { kind: "user", id: a.personId, label: a.label } });

  // ---------------------------------------------------- fixtures: things we sold
  // enough recliners at the DC whatever the other modules' checks used
  await t.as(P.STEVE, async (c, co, a) => {
    const lv = await t.q<{ a: string }>(c, `select coalesce(sum(on_hand - reserved),0)::text a from stock_level where entity_id = $1 and product_id = $2 and location_id = $3`,
      [ENTITY, PROD.RECLINER, DC]);
    if (Number(lv[0].a) < 4) {
      const labels = Number(lv[0].a) < 4 ? undefined : undefined;
      await inventory.adjust(c, scopeFor(co, a), { locationId: DC, productId: PROD.RECLINER, qty: 4, reasonCode: "found", note: "service checks", labels });
    }
  });
  /** A sale handed over (reserved, fulfilled and invoiced as delivery would), dated `ago` days back. */
  const sold = async (customer: string, items: { product: string; qty: number }[], agoDays: number) => t.as(P.STEVE, async (c, co, a) => {
    const s = scopeFor(co, a);
    const addr = (await t.q<{ id: string }>(c, `select id from customer_address where entity_id = $1 and customer_id = $2 and is_default`, [ENTITY, customer]))[0].id;
    const so = (await t.q<{ id: string; number: string }>(c, `insert into sales_order (entity_id, number, channel, location_id, customer_id, status, fulfillment, ship_address_id)
      values ($1, next_doc_no($1,'order','SO-'), 'pos', $2, $3, 'open', 'delivery', $4) returning id, number`, [ENTITY, ENOLA, customer, addr]))[0];
    let seq = 0;
    const lines: string[] = [];
    for (const it of items) {
      const l = (await t.q<{ id: string }>(c, `insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, fulfil_from_id)
        select $1, $2, $3, id, sku, name, $4, price_minor, case when kind = 'stock' then $5::uuid end from product where entity_id = $1 and id = $6 returning id`,
        [ENTITY, so.id, ++seq, it.qty, DC, it.product]))[0];
      lines.push(l.id);
    }
    await c.query(`select sales_order_retotal($1) /* unscoped: test order */`, [so.id]);
    await inventory.reserveOrder(c, ENTITY, so.id);
    const f = await inventory.fulfilLines(c, ENTITY, so.id, "all");
    const inv = await invoiceFulfilment(c, s, so.id, "all", f.costMinor);
    if (agoDays) {
      await c.query(`update customer_invoice set invoice_date = current_date - $3::int where entity_id = $1 and id = $2`, [ENTITY, inv.invoiceId, agoDays]);
      await c.query(`update sales_order set ordered_at = now() - make_interval(days => $3) where entity_id = $1 and id = $2`, [ENTITY, so.id, agoDays]);
    }
    return { orderId: so.id, number: so.number, lines };
  });
  const fresh = await sold(CUST.ALICIA, [{ product: PROD.RECLINER, qty: 1 }], 0);            // Global recliner, delivered today
  const oldPlan = await sold(CUST.BRIAN, [{ product: PROD.RECLINER, qty: 1 }, { product: PROD.PLAN, qty: 1 }], 1100);  // 3 years ago, 5-year plan
  const oldSofa = await sold(CUST.CHEN, [{ product: PROD.SOFA, qty: 1 }], 800);              // Ashley sofa, 2+ years, no plan

  // ---------------------------------------------------- opening tickets
  await t.throws("a driver cannot open a service ticket", () => post(P.TONY, "/service/tickets",
    { source: "phone", orderId: fresh.orderId, issueType: "defect", description: "Recliner will not recline" }), /needs one of/);
  await t.throws("a ticket needs a description", () => post(P.MARIA, "/service/tickets", { source: "pos", lineId: fresh.lines[0], issueType: "defect", description: "bad" }),
    /describe the problem/);
  await t.throws("a ticket without a customer needs someone to call", () => post(P.MARIA, "/service/tickets",
    { source: "phone", issueType: "other", description: "Caller wants a quote", contactName: "Walk-in" }), /phone number or an email/);
  const T1 = await post(P.MARIA, "/service/tickets", { source: "pos", lineId: fresh.lines[0], issueType: "defect", description: "Power recline motor stopped working" });
  const t1 = await get(`/service/tickets/${T1.id}`, P.RAY);
  t.ok("a ticket opened from the counter knows the customer, order, product and vendor from the line", /^SV-\d{6}$/.test(T1.number)
    && t1.customer_id === CUST.ALICIA && t1.sales_order_id === fresh.orderId && t1.product_id === PROD.RECLINER && t1.vendor === "Global Furniture USA"
    && t1.status === "new" && t1.source === "pos", T1.number);
  const slaHrs = (new Date(t1.sla_due_at).getTime() - new Date(t1.created_at).getTime()) / 3600000;
  t.ok("the SLA due date comes from the priority (normal: 120 hours)", Math.abs(slaHrs - 120) < 0.1, `${slaHrs.toFixed(1)} h`);
  const piece = await one<{ label: string } | undefined>(`select label from inv_piece where entity_id = $1 and product_id = $2 limit 1`, [ENTITY, PROD.RECLINER]);
  if (piece) {
    const byLabel = await post(P.MARIA, "/service/tickets", { source: "phone", pieceLabel: piece.label.toLowerCase(), customerId: CUST.ALICIA,
      issueType: "other", description: "Checking a carton label" });
    t.ok("a ticket opened from a piece label finds the product", (await get(`/service/tickets/${byLabel.id}`, P.RAY)).product_id === PROD.RECLINER);
    await post(P.RAY, `/service/tickets/${byLabel.id}/status`, { status: "cancelled", note: "test ticket" }).catch(() => null);
  }
  const msg = await one<{ n: number }>(`select count(*)::int n from customer_message where entity_id = $1 and kind = 'service_update' and customer_id = $2`, [ENTITY, CUST.ALICIA]);
  t.ok("the customer is told their request is in (message log)", msg.n >= 1);
  const T2 = await post(P.MARIA, "/service/tickets", { source: "phone", lineId: oldPlan.lines[0], issueType: "defect", description: "Footrest mechanism grinding" });
  const T3 = await post(P.LUIS, "/service/tickets", { source: "pos", lineId: oldSofa.lines[0], issueType: "defect", description: "Seat frame cracked under the cushion" });
  const T4 = await post(P.MARIA, "/service/tickets", { source: "phone", lineId: fresh.lines[0], issueType: "damage_delivery", description: "Arm gouged when it was carried in" });

  // ---------------------------------------------------- coverage by the rules
  const cov = async (id: string) => (await get(`/service/tickets/${id}`, P.RAY)).coverageSuggestion;
  const c1 = await cov(T1.id), c2 = await cov(T2.id), c3 = await cov(T3.id), c4 = await cov(T4.id);
  t.ok("a new Global recliner with a defect is the maker's warranty (24 months)", c1.suggested === "manufacturer" && /24-month/.test(c1.reason), c1.reason);
  t.ok("a three-year-old recliner with a 5-year plan is the protection plan", c2.suggested === "protection_plan" && c2.planLineId === oldPlan.lines[1], c2.reason);
  t.ok("a two-year-old sofa with no plan is billable", c3.suggested === "billable" && /no protection plan/.test(c3.reason), c3.reason);
  t.ok("damage in our own delivery is goodwill", c4.suggested === "goodwill");
  await t.throws("work cannot be scheduled before triage", () => post(P.RAY, `/service/tickets/${T1.id}/visits`, { day: "2030-01-01" }), /triage it first/);
  await t.throws("a dispatcher cannot make a billable ticket free", () => post(P.RAY, `/service/tickets/${T3.id}/triage`, { coverage: "goodwill", note: "good customer" }),
    /store manager's decision/);
  await t.throws("a manager overriding the rules says why", () => post(P.MGR, `/service/tickets/${T3.id}/triage`, { coverage: "goodwill" }), /say why/);
  await t.throws("a salesperson cannot triage", () => post(P.MARIA, `/service/tickets/${T1.id}/triage`, {}), /needs one of: store manager, dispatcher/);
  await post(P.RAY, `/service/tickets/${T1.id}/triage`, { technicianId: P.PAT });
  await post(P.RAY, `/service/tickets/${T2.id}/triage`, {});
  await post(P.RAY, `/service/tickets/${T3.id}/triage`, {});
  await post(P.RAY, `/service/tickets/${T4.id}/triage`, {});
  const tt = await one<{ c1: string; c3: string; c4: string; note4: string; s1: string }>(`select
      (select coverage from service_ticket where id = $1) c1, (select coverage from service_ticket where id = $2) c3,
      (select coverage from service_ticket where id = $3) c4, (select coverage_note from service_ticket where id = $3) note4,
      (select status from service_ticket where id = $1) s1 /* unscoped: ids from this test */`, [T1.id, T3.id, T4.id]);
  t.ok("triage records who pays, and goodwill keeps its reason", tt.c1 === "manufacturer" && tt.c3 === "billable" && tt.c4 === "goodwill" && /our own delivery/.test(tt.note4) && tt.s1 === "triage");

  // ---------------------------------------------------- the workflow the database holds
  await t.throws("the database refuses a skipped step (new → closed)", () => t.as(P.STEVE, async (c) => {
    await c.query(`update service_ticket set status = 'closed', resolution_type = 'no_fault_found' where entity_id = $1 and number = 'SV-000001'`, [ENTITY]);
  }), /a ticket that is new cannot go to closed/);
  await t.throws("a resolved ticket must say how", () => t.as(P.STEVE, async (c) => {
    await c.query(`update service_ticket set status = 'resolved' where entity_id = $1 and id = $2`, [ENTITY, T1.id]);
  }), /service_ticket_check/);
  await t.throws("the timeline is a record: no edits", () => t.as(P.STEVE, async (c) => {
    await c.query(`update service_event set note = 'x' where entity_id = $1 and ticket_id = $2`, [ENTITY, T1.id]);
  }), /never edited or deleted/);
  const ev = await one<{ n: number; who: string }>(`select count(*)::int n, string_agg(distinct by_label, ',') who from service_event where entity_id = $1 and ticket_id = $2 and kind = 'status'`, [ENTITY, T1.id]);
  t.ok("every step is timestamped with who did it", ev.n === 2 && /Maria/.test(ev.who) && /Ray/.test(ev.who), ev.who);

  // ---------------------------------------------------- parts through purchasing and inventory
  await t.throws("a technician not on the ticket cannot add parts to it", () => post(P.TONY, `/service/tickets/${T1.id}/parts`, { productId: PROD.MOTOR }), /needs one of/);
  const part = await post(P.PAT, `/service/tickets/${T1.id}/parts`, { productId: PROD.MOTOR, qty: 1 });
  const t1b = await get(`/service/tickets/${T1.id}`, P.RAY);
  t.ok("a part not in stock waits on order, $0 on the covered work order, and the ticket waits for parts", part.status === "on_order"
    && t1b.status === "awaiting_parts" && t1b.parts[0].price_minor === "0" && !!t1b.service_order_number);
  await t.throws("a technician cannot place the purchase order", () => post(P.PAT, `/service/tickets/${T1.id}/parts/order`), /needs one of/);
  const po = await post(P.ANA, `/service/tickets/${T1.id}/parts/order`);
  const link = await one<{ n: number; po: string }>(`select count(*)::int n, min(po.number) po from po_line_sales_line k join purchase_order_line pl on pl.id = k.purchase_order_line_id
     join purchase_order po on po.id = pl.purchase_order_id where k.entity_id = $1 and k.sales_order_line_id = $2 and k.active`, [ENTITY, part.lineId]);
  t.ok("the buyer orders it from the vendor; the PO line is tied to the ticket's line", po.length === 1 && po[0].vendor === "Global Furniture USA" && link.n === 1 && link.po === po[0].number, po[0].number);
  await t.throws("the same part is not ordered twice", () => post(P.ANA, `/service/tickets/${T1.id}/parts/order`), /waiting for a purchase order/);
  await t.as(P.DEE, async (c, co, a) => {
    const pol = await t.q<{ id: string; purchase_order_id: string }>(c, `select pl.id, pl.purchase_order_id from po_line_sales_line k join purchase_order_line pl on pl.id = k.purchase_order_line_id
       where k.entity_id = $1 and k.sales_order_line_id = $2`, [ENTITY, part.lineId]);
    await inventory.receivePurchaseOrder(c, scopeFor(co, a), { purchaseOrderId: pol[0].purchase_order_id, locationId: DC, lines: [{ poLineId: pol[0].id, qty: 1 }] } as never);
  });
  const t1c = await get(`/service/tickets/${T1.id}`, P.RAY);
  t.ok("receiving the PO reserves the part to the ticket", t1c.parts[0].line_status === "reserved", t1c.parts[0].line_status);
  await t.throws("coverage cannot change once parts are on the ticket", () => post(P.MGR, `/service/tickets/${T1.id}/triage`, { coverage: "goodwill", note: "x" }),
    /already has parts or costs/);

  // ---------------------------------------------------- a technician's visit on a fleet route
  const today = (await one<{ d: string }>(`select (now() at time zone 'America/New_York')::date::text d /* unscoped: clock */`)).d;
  let D = today;
  do { const d = new Date(D + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); D = d.toISOString().slice(0, 10); }
  while (![1, 2, 4, 5].includes(new Date(D + "T12:00:00Z").getUTCDay()));
  const wsh = "a2a2a2a2-0000-0000-0000-000000000001";
  const slot = (await get(`/fleet/availability?zone=${wsh}&day=${D}&days=1`, P.RAY)).slots.find((x: any) => x.label === "8–12");
  await t.throws("only the desk books visits", () => post(P.PAT, `/service/tickets/${T1.id}/visits`, { day: D, windowId: slot.windowId }), /needs one of/);
  const v1 = await post(P.RAY, `/service/tickets/${T1.id}/visits`, { day: D, windowId: slot.windowId });
  const stop = await one<{ kind: string; number: string; id: string; problem: string }>(`select s.kind, s.number, s.id, s.problem from service_visit v join delivery_stop s on s.id = v.stop_id where v.entity_id = $1 and v.id = $2`, [ENTITY, v1.visitId]);
  t.ok("the visit is a service stop on the delivery calendar, carrying the ticket", stop.kind === "service" && stop.problem.startsWith(T1.number)
    && (await get(`/service/tickets/${T1.id}`, P.RAY)).status === "scheduled", stop.number);
  await t.throws("a second open visit for the same ticket is refused", () => post(P.RAY, `/service/tickets/${T1.id}/visits`, { day: D, windowId: slot.windowId }), /already has a visit booked/);
  const built = await post(P.RAY, "/fleet/routes/build", { day: D, dcId: DC });
  const routeId = built.routes.find((r: any) => r.stops >= 1).routeId;
  await post(P.RAY, `/fleet/routes/${routeId}/crew`, { driverId: P.PAT, helperId: null });
  await post(P.DEE, `/fleet/routes/${routeId}/lock`);
  const veh = (await get(`/fleet/routes/${routeId}`, P.RAY)).vehicle_id;
  await post(P.PAT, "/fleet/dvir", { vehicleId: veh, items: F.DVIR_ITEMS.map((i) => ({ code: i.code, ok: true })) });
  await post(P.PAT, `/fleet/routes/${routeId}/start`);
  const myRoute = await get(`/fleet/my?day=${D}`, P.PAT);
  const svStop = myRoute.routes[0].stops.find((s: any) => s.id === stop.id);
  t.ok("the technician's phone shows the visit with the ticket and the part in hand", svStop?.service_ticket === T1.number && svStop.service_visit_id === v1.visitId
    && svStop.serviceParts.length === 1 && svStop.serviceParts[0].line_status === "reserved");
  const patList = await get("/service/tickets", P.PAT);
  t.ok("a technician sees only their own tickets", patList.length >= 1 && patList.every((x: any) => x.technician === "Pat (technician)" || x.next_visit), `${patList.length}`);
  await t.throws("a technician cannot open someone else's ticket", () => get(`/service/tickets/${T3.id}`, P.PAT), /not one of yours/);
  await t.throws("a driver not on that route cannot finish the visit", () => post(P.TONY, `/service/visits/${v1.visitId}/complete`, { outcome: "fixed", signature: SIG }),
    /another technician's route/);
  await t.throws("finishing a visit needs the customer's signature", () => post(P.PAT, `/service/visits/${v1.visitId}/complete`, { outcome: "fixed", minutes: 45 }), /signature/);
  const motorBefore = await one<{ on_hand: string }>(`select coalesce(sum(on_hand),0)::text on_hand from stock_level where entity_id = $1 and product_id = $2`, [ENTITY, PROD.MOTOR]);
  const done1 = await post(P.PAT, `/service/visits/${v1.visitId}/complete`, { outcome: "fixed", minutes: 45, workNotes: "Replaced the recline motor; tested both directions",
    partsUsed: [t1c.parts[0].id], signature: SIG, recipient: "Alicia Gomez" });
  const motorAfter = await one<{ on_hand: string }>(`select coalesce(sum(on_hand),0)::text on_hand from stock_level where entity_id = $1 and product_id = $2`, [ENTITY, PROD.MOTOR]);
  const t1d = await get(`/service/tickets/${T1.id}`, P.RAY);
  t.ok("fixed on the first visit: the ticket is resolved as a part replacement and the part left stock", done1.status === "resolved"
    && t1d.resolution_type === "replace_part" && Number(motorBefore.on_hand) - Number(motorAfter.on_hand) === 1);
  const stopDone = await one<{ status: string; pod: boolean }>(`select status, pod_signature is not null pod from delivery_stop where entity_id = $1 and id = $2`, [ENTITY, stop.id]);
  t.ok("the fleet stop is completed with the signature", stopDone.status === "delivered" && stopDone.pod);
  const bk = await one<{ c5000: string; c1150: string; c6155: string }>(`
    select coalesce(sum(jl.debit_minor - jl.credit_minor) filter (where g.code = '5000' and e.source_type = 'sale' and e.source_id = $2), 0)
         + coalesce(sum(jl.debit_minor - jl.credit_minor) filter (where g.code = '5000' and e.source_type = 'service'), 0) c5000,
           coalesce(sum(jl.debit_minor - jl.credit_minor) filter (where g.code = '1150'), 0)::text c1150,
           coalesce(sum(jl.credit_minor - jl.debit_minor) filter (where g.code = '6155'), 0)::text c6155
      from journal_entry e join journal_line jl on jl.journal_entry_id = e.id join gl_account g on g.id = jl.gl_account_id
     where e.entity_id = $1 and (e.source_type = 'service' or (e.source_type = 'sale' and e.source_id = $2))`, [ENTITY, t1d.service_order_id]);
  const costs1 = t1d.costs.map((x: any) => `${x.kind}:${x.amount_minor}:${x.charge_to}`).join(" ");
  t.ok("the covered part's cost moves out of cost of sales to the vendor chargeback; 45 min labour at $30/h is charged back too",
    Number(bk.c5000) === 0 && bk.c1150 === String(4500 + 2250) && bk.c6155 === "2250" && /parts:4500:vendor/.test(costs1) && /labor:2250:vendor/.test(costs1), `${costs1} · 1150 ${bk.c1150}`);
  await post(P.RAY, `/service/tickets/${T1.id}/close`, { note: "customer happy" });
  await t.throws("a closed ticket's coverage cannot change", () => t.as(P.STEVE, async (c) => {
    await c.query(`update service_ticket set coverage = 'billable' where entity_id = $1 and id = $2`, [ENTITY, T1.id]);
  }), /is closed/);

  // ---------------------------------------------------- billable work by an outside company
  await t.throws("a charge on a covered ticket is refused", () => post(P.RAY, `/service/tickets/${T2.id}/charges`, { productId: PROD.CALL }), /is covered/);
  await post(P.RAY, `/service/tickets/${T3.id}/charges`, { productId: PROD.CALL });
  const keystone = (await get("/service/options", P.RAY)).providers.find((p: any) => p.name === "Keystone Furniture Repair");
  const v3 = await post(P.RAY, `/service/tickets/${T3.id}/visits`, { providerId: keystone.id, day: D });
  await t.throws("a technician cannot finish an outside company's visit", () => post(P.PAT, `/service/visits/${v3.visitId}/complete`, { outcome: "fixed" }), /another technician's route/);
  const done3 = await post(P.RAY, `/service/visits/${v3.visitId}/complete`, { outcome: "fixed", minutes: 60, workNotes: "Keystone re-glued and braced the seat frame", thirdPartyCost: "60.00" });
  const t3 = await get(`/service/tickets/${T3.id}`, P.RAY);
  const inv3 = await one<{ total: string; charged: string; status: string }>(`select i.total_minor::text total, i.charged_minor::text charged, i.status from customer_invoice i
     where i.entity_id = $1 and i.sales_order_id = $2`, [ENTITY, t3.billing_order_id]);
  const rev = await one<{ r4050: string; r4030: string }>(`
    select coalesce(sum(jl.credit_minor - jl.debit_minor) filter (where g.code = '4050'), 0)::text r4050,
           coalesce(sum(jl.credit_minor - jl.debit_minor) filter (where g.code = '4030'), 0)::text r4030
      from journal_entry e join journal_line jl on jl.journal_entry_id = e.id join gl_account g on g.id = jl.gl_account_id
     where e.entity_id = $1 and ((e.source_type = 'sale' and e.source_id = $2) or (e.source_type = 'service' and e.source_id = $3))`, [ENTITY, t3.billing_order_id, T3.id]);
  t.ok("the service call is invoiced to the customer's account (A/R) and lands in service revenue", done3.status === "resolved" && inv3?.total === "8900"
    && inv3.charged === "8900" && rev.r4050 === "8900" && rev.r4030 === "0", `invoice ${inv3?.total}, 4050 ${rev.r4050}`);
  t.ok("the outside company's work is a service expense accrued until their bill comes", t3.costs.some((x: any) => x.kind === "third_party" && x.amount_minor === "6000" && x.charge_to === "service_expense"));
  await post(P.RAY, `/service/tickets/${T3.id}/close`);

  // ---------------------------------------------------- a $0 replacement needs a manager
  await t.throws("a dispatcher cannot give a replacement away", () => post(P.RAY, `/service/tickets/${T4.id}/parts`, { productId: PROD.RECLINER, kind: "replacement", reason: "gouged" }),
    /needs a store manager/);
  await t.throws("a manager's free replacement says why", () => post(P.MGR, `/service/tickets/${T4.id}/parts`, { productId: PROD.RECLINER, kind: "replacement" }), /say why/);
  const rep = await post(P.MGR, `/service/tickets/${T4.id}/parts`, { productId: PROD.RECLINER, kind: "replacement", reason: "arm gouged by our crew; replace it" });
  const t4 = await get(`/service/tickets/${T4.id}`, P.RAY);
  const q4 = await get("/fleet/queue", P.RAY);
  t.ok("the replacement is reserved at $0 and its order joins the delivery queue", rep.status === "reserved" && t4.parts[0].price_minor === "0"
    && t4.parts[0].approval_reason && q4.some((o: any) => o.id === t4.service_order_id));
  // delivered (as the fleet would: fulfil and invoice), then resolved and closed
  const deliveredCost = await t.as(P.STEVE, async (c, co, a) => {
    const f = await inventory.fulfilLines(c, ENTITY, t4.service_order_id, [rep.lineId]);
    await invoiceFulfilment(c, scopeFor(co, a), t4.service_order_id, [rep.lineId], f.costMinor);
    return f.costMinor;
  });
  await t.throws("resolving needs a note", () => post(P.RAY, `/service/tickets/${T4.id}/resolve`, { type: "replace_item" }), /say what was done/);
  await post(P.RAY, `/service/tickets/${T4.id}/resolve`, { type: "replace_item", note: "replacement delivered" });
  await post(P.RAY, `/service/tickets/${T4.id}/close`);
  const c4c = await one<{ amt: string; to: string }>(`select amount_minor::text amt, charge_to "to" from service_cost where entity_id = $1 and ticket_id = $2 and kind = 'replacement'`, [ENTITY, T4.id]);
  t.ok("the goodwill replacement's cost is moved to service expense when the ticket closes", c4c?.amt === deliveredCost.toString() && c4c.to === "service_expense", `${c4c?.amt}`);

  // ---------------------------------------------------- credit/refund through POS, then a vendor claim
  const session = await t.as(P.STEVE, async (c, co, a) => {
    const open = await t.q<{ id: string }>(c, `select id from pos_session where entity_id = $1 and location_id = $2 and status = 'open' limit 1`, [ENTITY, ENOLA]);
    if (open.length) return open[0].id;
    const free = await t.q<{ id: string }>(c, `select r.id from pos_register r where r.entity_id = $1 and r.location_id = $2 and r.active
       and not exists (select 1 from pos_session s where s.register_id = r.id and s.status = 'open') limit 1`, [ENTITY, ENOLA]);
    return (await pos.openSession(c, scopeFor(co, a), { registerId: free[0].id, floatMinor: 20000n })).id as string;
  });
  await t.throws("a dispatcher cannot refund", () => post(P.RAY, `/service/tickets/${T2.id}/resolve`, { type: "credit_refund", note: "refund", sessionId: session }), /store manager/);
  const refundAmt = (await one<{ p: string }>(`select unit_price_minor::text p from sales_order_line where entity_id = $1 and id = $2`, [ENTITY, oldPlan.lines[0]])).p;
  await post(P.MGR, `/service/tickets/${T2.id}/resolve`, { type: "credit_refund", note: "mechanism cannot be repaired; store credit", sessionId: session,
    tenders: [{ method: "store_credit", amount: { minor: refundAmt } }] });
  const t2 = await get(`/service/tickets/${T2.id}`, P.RAY);
  const ret = await one<{ n: number }>(`select count(*)::int n from pos_order where entity_id = $1 and original_order_id = $2 and kind = 'return'`, [ENTITY, oldPlan.orderId]);
  t.ok("credit/refund goes through POS's return: a return order, the goods to damage, the ticket resolved", t2.status === "resolved" && t2.resolution_type === "credit_refund"
    && ret.n === 1 && !!t2.damage_id);
  await t.throws("a claim needs goods of ours to claim on", () => post(P.MGR, `/service/tickets/${T3.id}/claims`, { amount: "50.00" }), /nothing of ours is held/);
  const claim = await post(P.MGR, `/service/tickets/${T2.id}/claims`, { amount: "290.00", vendorRef: "GL-RMA-5521" });
  t.ok("a vendor claim is filed through inventory's claims, tied to the ticket", /^VC-/.test(claim.number) && (await get(`/service/tickets/${T2.id}`, P.RAY)).claims.length === 1, claim.number);
  await t.throws("crediting a claim says how it settled", () => post(P.MGR, `/service/tickets/${T2.id}/claims/${claim.id}`, { status: "credited", credit: "290.00" }), /say how the vendor settled/);
  await post(P.MGR, `/service/tickets/${T2.id}/claims/${claim.id}`, { status: "credited", credit: "290.00", resolution: "credit memo CM-881" });
  await post(P.RAY, `/service/tickets/${T2.id}/close`);

  // ---------------------------------------------------- a damaged delivery line opens a ticket
  const dl = await t.as(P.STEVE, async (c) => {
    const st = await t.q<{ id: string }>(c, `insert into delivery_stop (entity_id, number, kind, sales_order_id, customer_id, address_id, dc_location_id, status, completed_at)
      select $1, next_doc_no($1,'delivery','D-'), 'delivery', so.id, so.customer_id, so.ship_address_id, $3, 'partial', now() from sales_order so where so.entity_id = $1 and so.id = $2
      returning id`, [ENTITY, fresh.orderId, DC]);
    return (await t.q<{ id: string }>(c, `insert into delivery_stop_line (entity_id, stop_id, sales_order_line_id, description, qty, outcome, flagged_for_warehouse, note)
      values ($1,$2,$3,'Recliner, power',1,'damaged',true,'scuffed base') returning id`, [ENTITY, st[0].id, fresh.lines[0]]))[0].id;
  });
  const fromStop = await post(P.DEE, `/service/tickets/from-stop/${dl}`);
  const fs = await get(`/service/tickets/${fromStop.id}`, P.RAY);
  t.ok("a damaged delivery line opens a high-priority delivery-damage ticket", fs.source === "delivery" && fs.issue_type === "damage_delivery" && fs.priority === "high"
    && fs.customer_id === CUST.ALICIA);
  await t.throws("the same delivery line does not open a second ticket", () => post(P.DEE, `/service/tickets/from-stop/${dl}`), /already open for that line/);

  // ---------------------------------------------------- the public request form
  const [pst, page] = await pub("GET", "/service-request/buddys");
  t.ok("the public form is a page with our own script", pst === 200 && page instanceof PublicPage && page.text.includes('src="/service-request/assets/form.js"')
    && page.text.includes('name="website"'));
  t.ok("an unknown store has no form", (await pub("GET", "/service-request/nosuchstore"))[0] === 404);
  const before = await one<{ n: number }>(`select count(*)::int n from service_ticket where entity_id = $1 and source = 'web'`, [ENTITY]);
  const [, hp] = await pub("POST", "/service-request/buddys/api/request", { name: "Bot", phone: "7175550000", description: "Buy cheap stuff now at our site", website: "http://spam.example", elapsedMs: 9000 });
  const afterHp = await one<{ n: number }>(`select count(*)::int n from service_ticket where entity_id = $1 and source = 'web'`, [ENTITY]);
  t.ok("a honeypot hit looks accepted but opens nothing", hp.received === true && hp.number === null && afterHp.n === before.n);
  const [, w1] = await pub("POST", "/service-request/buddys/api/request", { name: "Alicia Gomez", phone: "(717) 555-0101", orderNumber: fresh.number,
    issueType: "defect", description: "The recliner makes a clicking noise when it reclines.", elapsedMs: 30000 });
  const wt1 = await one<{ customer_id: string | null; sales_order_id: string | null }>(`select customer_id, sales_order_id from service_ticket where entity_id = $1 and number = $2`, [ENTITY, w1.number]);
  t.ok("a web request whose order number matches the phone is linked to the customer and order", wt1.customer_id === CUST.ALICIA && wt1.sales_order_id === fresh.orderId, w1.number);
  const [, w2] = await pub("POST", "/service-request/buddys/api/request", { name: "Mallory", phone: "212-555-9999", orderNumber: fresh.number,
    issueType: "defect", description: "Trying someone else's order number to see what comes back.", elapsedMs: 30000 });
  const wt2 = await one<{ customer_id: string | null; description: string }>(`select customer_id, description from service_ticket where entity_id = $1 and number = $2`, [ENTITY, w2.number]);
  t.ok("a mismatched order number links nothing and says nothing about the order", wt2.customer_id === null && /Order number given/.test(wt2.description)
    && Object.keys(w2).sort().join() === "number,received");
  await t.throws("a description that is too short is refused", () => pub("POST", "/service-request/buddys/api/request", { name: "Ann", phone: "7175551234", description: "broken", elapsedMs: 30000 }),
    /tell us what is wrong/);
  await t.throws("the form's sender limit holds (5 an hour)", async () => {
    for (let i = 0; i < 3; i++) await pub("POST", "/service-request/buddys/api/request", { name: "Repeat Caller", phone: "7175551234", description: "Still broken, writing again about it.", elapsedMs: 30000 });
  }, /too many requests from here/);
  await t.throws("another sender is not blocked, but links are kept out", () => pub("POST", "/service-request/buddys/api/request",
    { name: "Link Spammer", phone: "7175554321", description: "see http://a.example http://b.example http://c.example for details", elapsedMs: 30000 }, "198.51.100.9"), /leave links out/);
  await t.throws("photos are links or pictures, five at most", () => pub("POST", "/service-request/buddys/api/request",
    { name: "Photo Person", phone: "7175554322", description: "Pictures of the damage are attached here.", photos: ["javascript:alert(1)"], elapsedMs: 30000 }, "198.51.100.10"), /https link or an image/);

  // ---------------------------------------------------- isolation
  const rioList = await get("/service/tickets?status=all", P.RIO_OWNER, RIO_ENTITY);
  t.ok("the other company sees none of these tickets", rioList.length === 0);
  await t.throws("the other company cannot open this company's ticket", () => get(`/service/tickets/${T2.id}`, P.RIO_OWNER, RIO_ENTITY), /no such service ticket/);
  await t.throws("the other company cannot triage this company's ticket", () => postIn(RIO_ENTITY, P.RIO_OWNER, `/service/tickets/${fromStop.id}/triage`, {}), /no such service ticket/);
  await t.throws("the other company cannot open a ticket on this company's order", () => postIn(RIO_ENTITY, P.RIO_OWNER, "/service/tickets",
    { source: "phone", orderId: fresh.orderId, issueType: "defect", description: "Not my order at all" }), /no such order/);

  // ---------------------------------------------------- dashboard and books
  await t.as(P.STEVE, (c) => c.query(`update service_ticket set sla_due_at = now() - interval '1 hour' where entity_id = $1 and number = 'SV-000001'`, [ENTITY]));
  const dash = await get("/service/home", P.MGR);
  const glob = dash.vendors.find((v: any) => v.vendor === "Global Furniture USA");
  t.ok("the dashboard shows open tickets, SLA breaches and ages", dash.open >= 3 && dash.breached.some((b: any) => b.number === "SV-000001") && dash.age.length >= 1, `${dash.open} open`);
  t.ok("defects and service cost by vendor, with what was charged back and credited", glob && glob.defects >= 2 && glob.units >= 2 && glob.defect_rate_pct > 0
    && Number(glob.cost_minor) >= 6750 && Number(glob.charged_back_minor) >= 6750 && glob.credited_minor === "29000", JSON.stringify(glob));
  t.ok("first-time fix rate counts tickets fixed on their first visit", dash.firstTimeFix.resolvedWithVisits === 2 && dash.firstTimeFix.pct === 100);
  await t.throws("the dashboard is not for technicians", () => get("/service/home", P.PAT), /store staff/);
  const tb = await one<{ d: string; c: string }>(`select sum(jl.debit_minor)::text d, sum(jl.credit_minor)::text c from journal_line jl
     join journal_entry e on e.id = jl.journal_entry_id where e.entity_id = $1`, [ENTITY]);
  t.ok("the ledger balances", tb.d === tb.c);
  const tie = await t.as(P.STEVE, (c) => inventory.tieOut(c, ENTITY));
  t.ok("inventory still ties to the books after parts, replacements and returns", tie.ties, `difference ${tie.differenceMinor}`);
  void (null as unknown as Client);
}
