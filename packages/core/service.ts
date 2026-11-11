// Service and repair: tickets from any door, who pays (coverage), parts,
// visits, vendor claims, billing, costs, and how the department is doing.
//
// This module owns its own tables (service_*) and the two orders a ticket
// may carry. Everything else goes through the owning module's functions:
//   stock          inventory.reserveOrder / fulfilLines, openVendorClaim / updateClaim
//   parts on order purchasing.placeSpecialOrders (the special-order link)
//   visits         fleet.bookStop / completeStop (service and pickup stops)
//   refunds        pos.returnGoods
//   the sale       ar.invoiceFulfilment; the ledger through posting.post
//
// Accounting (codes from the tenant's chart; setup's retail pack adds them):
//   covered parts / replacements leave stock as a $0 sale (Dr 5000 Cr 1300),
//     then move to who carries them:      Dr 6150 (or 1150 vendor)  Cr 5000
//   in-house labour                       Dr 6150 (or 1150)         Cr 6155 service labour applied
//   a third party's work, until billed    Dr 6150 (or 1150)         Cr 2050 accrued (their vendor's bills code to 2050)
//   other costs, paid elsewhere           record only; a chargeback  Dr 1150 Cr 6150
//   billable service charges              the sale posts 4030; moved  Dr 4030  Cr 4050 service revenue

import { createHash } from "node:crypto";
import * as tax from "./tax.ts";
import { q, one, audit, type Client, type Scope } from "./db.ts";
import { post } from "./posting.ts";
import { profitObjectFor } from "./posting.ts";
import * as inventory from "./inventory.ts";
import { invoiceFulfilment } from "./ar.ts";
import * as purchasing from "./purchasing.ts";
import * as fleet from "./fleet.ts";
import * as pos from "./pos.ts";
import { setting } from "./setup.ts";
import { fromChargeback } from "./debit_memo.ts";

export class ServiceError extends Error {}
function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new ServiceError(message);
}

export const ISSUE_TYPES = ["damage_delivery", "defect", "warranty", "protection_plan", "assembly", "comfort", "other"] as const;
export const ISSUE_LABEL: Record<string, string> = { damage_delivery: "Damaged in delivery", defect: "Defect", warranty: "Warranty repair",
  protection_plan: "Protection plan claim", assembly: "Assembly", comfort: "Comfort", other: "Other" };
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const COVERAGES = ["manufacturer", "protection_plan", "goodwill", "billable"] as const;
export const RESOLUTIONS = ["in_home_repair", "replace_part", "replace_item", "credit_refund", "pickup_repair", "no_fault_found"] as const;
export const OUTCOMES = ["fixed", "needs_parts", "needs_return", "no_fault", "not_home", "other"] as const;
export const OPEN = ["new", "triage", "awaiting_parts", "scheduled", "in_progress"];

const UUIDRX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUIDRX.test(v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const words = (s: string) => s.replace(/_/g, " ");
const usd = (m: bigint) => `$${(Number(m) / 100).toFixed(2)}`;
const bps = (m: bigint, rate: number) => (m * BigInt(rate) + 5000n) / 10000n;
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------- settings --

export type Settings = { slaHours: Record<string, number>; laborRateMinor: bigint;
  planTerms: Record<string, { years: number; covers: string[]; name?: string }> };

export async function settings(c: Client, entityId: string): Promise<Settings> {
  const sla = await setting<Record<string, number>>(c, entityId, "service.sla_hours", { urgent: 24, high: 48, normal: 120, low: 240 });
  const rate = await setting<number | string>(c, entityId, "service.labor_rate_minor", 3000);
  const plans = await setting<Settings["planTerms"]>(c, entityId, "service.plan_terms", {});
  return { slaHours: { urgent: 24, high: 48, normal: 120, low: 240, ...sla }, laborRateMinor: BigInt(String(rate)), planTerms: plans };
}

// -------------------------------------------------------------- photos --

export function cleanPhotos(v: unknown, max = 12): string[] {
  const list = Array.isArray(v) ? v.map(String).map((x) => x.trim()).filter(Boolean) : [];
  need(list.length <= max, `${max} photos at most`);
  for (const u of list) {
    need(/^https:\/\/[^\s]{4,}$/.test(u) || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(u), "a photo is a https link or an image taken here");
    need(u.length <= 1_500_000, "a photo is too large; send a link to it, or a smaller picture");
  }
  return list;
}

// ------------------------------------------------------------- tickets --

type TicketRow = { id: string; number: string; status: string; source: string; customer_id: string | null; address_id: string | null;
  sales_order_id: string | null; sales_order_line_id: string | null; product_id: string | null; vendor_id: string | null; issue_type: string;
  description: string; coverage: string | null; coverage_note: string | null; plan_line_id: string | null; technician_id: string | null;
  provider_id: string | null; resolution_type: string | null; service_order_id: string | null; billing_order_id: string | null;
  damage_id: string | null; priority: string; piece_label: string | null };

async function ticketOf(c: Client, entityId: string, id: string, lock = true): Promise<TicketRow> {
  need(isId(id), "no such service ticket");
  const r = await q<TicketRow>(c, `select id, number, status, source, customer_id, address_id, sales_order_id, sales_order_line_id, product_id, vendor_id,
      issue_type, description, coverage, coverage_note, plan_line_id, technician_id, provider_id, resolution_type, service_order_id, billing_order_id,
      damage_id, priority, piece_label
      from service_ticket where entity_id = $1 and id = $2 ${lock ? "for update" : ""}`, [entityId, id]);
  need(r.length, "no such service ticket");
  return r[0];
}

async function event(c: Client, scope: Scope, ticketId: string, kind: string, note: string) {
  await c.query(`insert into service_event (entity_id, ticket_id, by_user, by_label, kind, note) values ($1,$2,$3,$4,$5,$6)`,
    [scope.entityId, ticketId, scope.actor.id || null, scope.actor.label, kind, note.slice(0, 1000)]);
}

async function moveTo(c: Client, scope: Scope, t: TicketRow, to: string) {
  if (t.status === to) return;
  await c.query(`update service_ticket set status = $3 where entity_id = $1 and id = $2`, [scope.entityId, t.id, to]);
  t.status = to;
}

export type OpenIn = {
  source: string; customerId?: string | null; addressId?: string | null;
  contactName?: string; contactPhone?: string; contactEmail?: string;
  orderId?: string | null; lineId?: string | null; pieceLabel?: string | null; productId?: string | null;
  issueType: string; description: string; photos?: unknown; priority?: string; originStopLineId?: string | null;
};

/** Open a ticket from any door. What it is about is worked out from the piece, the line, the order or the product given. */
export async function openTicket(c: Client, scope: Scope, e: OpenIn) {
  need(["pos", "web", "phone", "delivery", "email", "other"].includes(e.source), "say where the request came from");
  need((ISSUE_TYPES as readonly string[]).includes(e.issueType), "pick what kind of problem it is");
  const desc = String(e.description ?? "").trim();
  need(desc.length >= 5, "describe the problem in a few words");
  need(desc.length <= 4000, "keep the description under 4,000 characters");
  const priority = e.priority && (PRIORITIES as readonly string[]).includes(e.priority) ? e.priority : "normal";
  const photos = cleanPhotos(e.photos);
  let customerId = e.customerId ?? null, addressId = e.addressId ?? null, orderId = e.orderId ?? null, lineId = e.lineId ?? null;
  let productId = e.productId ?? null;
  let label: string | null = null;
  if (e.pieceLabel) {
    label = String(e.pieceLabel).trim().toUpperCase();
    const pc = await q<{ product_id: string; sales_order_line_id: string | null }>(c,
      `select product_id, sales_order_line_id from inv_piece where entity_id = $1 and upper(label) = $2`, [scope.entityId, label]);
    need(pc.length, `no piece is labelled ${label}`);
    productId = pc[0].product_id;
    lineId = lineId ?? pc[0].sales_order_line_id;
  }
  if (lineId) {
    need(isId(lineId), "no such order line");
    const l = await q<{ sales_order_id: string; product_id: string | null }>(c,
      `select sales_order_id, product_id from sales_order_line where entity_id = $1 and id = $2`, [scope.entityId, lineId]);
    need(l.length, "that order line is not this company's");
    need(!orderId || orderId === l[0].sales_order_id, "that line is on another order");
    orderId = l[0].sales_order_id;
    productId = productId ?? l[0].product_id;
  }
  if (orderId) {
    need(isId(orderId), "no such order");
    const so = await q<{ customer_id: string | null; ship_address_id: string | null }>(c,
      `select customer_id, ship_address_id from sales_order where entity_id = $1 and id = $2`, [scope.entityId, orderId]);
    need(so.length, "no such order");
    need(!customerId || !so[0].customer_id || customerId === so[0].customer_id, "that order is another customer's");
    customerId = customerId ?? so[0].customer_id;
    addressId = addressId ?? so[0].ship_address_id;
  }
  if (customerId) {
    need(isId(customerId), "no such customer");
    const cu = await q(c, `select 1 from customer where entity_id = $1 and id = $2`, [scope.entityId, customerId]);
    need(cu.length, "no such customer");
    if (addressId) {
      const a = await q(c, `select 1 from customer_address where entity_id = $1 and id = $2 and customer_id = $3`, [scope.entityId, addressId, customerId]);
      need(a.length, "that address is not this customer's");
    } else {
      addressId = (await q<{ id: string }>(c, `select id from customer_address where entity_id = $1 and customer_id = $2 order by is_default desc limit 1`,
        [scope.entityId, customerId]))[0]?.id ?? null;
    }
  } else {
    need(String(e.contactName ?? "").trim(), "name the customer, or pick them");
    need(String(e.contactPhone ?? "").trim() || String(e.contactEmail ?? "").trim(), "give a phone number or an email to reach them");
  }
  let vendorId: string | null = null;
  if (productId) {
    need(isId(productId), "no such product");
    const p = await q<{ vendor_id: string | null }>(c, `select vendor_id from product where entity_id = $1 and id = $2`, [scope.entityId, productId]);
    need(p.length, "no such product");
    vendorId = p[0].vendor_id;
  }
  const s = await settings(c, scope.entityId);
  const hours = Number(s.slaHours[priority] ?? 120);
  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'service', 'SV-') n /* unscoped: numbering function takes the entity */`, [scope.entityId])).n;
  const t = await one<{ id: string; sla_due_at: string }>(c, `
    insert into service_ticket (entity_id, number, source, customer_id, address_id, contact_name, contact_phone, contact_email, sales_order_id,
      sales_order_line_id, piece_label, product_id, vendor_id, issue_type, description, photos, priority, sla_due_at, origin_stop_line_id, created_by)
    values ($1,$2,$3,$4,$5,nullif($6,''),nullif($7,''),nullif($8,''),$9,$10,$11,$12,$13,$14,$15,$16,$17, now() + make_interval(hours => $18), $19, $20)
    returning id, sla_due_at`,
    [scope.entityId, number, e.source, customerId, addressId, String(e.contactName ?? "").trim().slice(0, 120), String(e.contactPhone ?? "").trim().slice(0, 40),
     String(e.contactEmail ?? "").trim().slice(0, 160), orderId, lineId, label, productId, vendorId, e.issueType, desc, photos, priority, hours,
     e.originStopLineId ?? null, scope.actor.id || null]);
  if (customerId) await fleet.messageCustomer(c, scope, { customerId, orderId,
    body: `we have your service request ${number}. We will be in touch to set up the next step.` });
  return { id: t.id, number, slaDueAt: t.sla_due_at };
}

/** A damaged or refused line on a delivery becomes a ticket, once. */
export async function fromDeliveryException(c: Client, scope: Scope, stopLineId: string) {
  need(isId(stopLineId), "no such delivery line");
  const r = await q<{ outcome: string; note: string | null; description: string; sales_order_line_id: string | null; customer_id: string | null;
    address_id: string | null; sales_order_id: string | null; number: string; exception_reason: string | null }>(c, `
    select sl.outcome, sl.note, sl.description, sl.sales_order_line_id, s.customer_id, s.address_id, s.sales_order_id, s.number, s.exception_reason
      from delivery_stop_line sl join delivery_stop s on s.id = sl.stop_id where sl.entity_id = $1 and sl.id = $2`, [scope.entityId, stopLineId]);
  need(r.length, "no such delivery line");
  const x = r[0];
  need(["damaged", "refused"].includes(x.outcome), "only a damaged or refused line opens a service ticket from a delivery");
  const already = await q<{ number: string }>(c, `select number from service_ticket where entity_id = $1 and origin_stop_line_id = $2 and status <> 'cancelled'`,
    [scope.entityId, stopLineId]);
  need(!already.length, `ticket ${already[0]?.number} is already open for that line`);
  return openTicket(c, scope, {
    source: "delivery", customerId: x.customer_id, addressId: x.address_id, orderId: x.sales_order_id, lineId: x.sales_order_line_id,
    issueType: x.outcome === "damaged" ? "damage_delivery" : "other", priority: "high", originStopLineId: stopLineId,
    description: `${x.outcome === "damaged" ? "Damaged" : "Refused"} on delivery ${x.number}: ${x.description}. ${[x.note, x.exception_reason].filter(Boolean).join(" — ")}`.trim(),
  });
}

// ------------------------------------------------------------- coverage --

export type Coverage = { suggested: string; reason: string; deliveredOn: string | null; warrantyEnds: string | null;
  planEnds: string | null; planLineId: string | null; planName: string | null };

const addMonths = (d: string, m: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };

/** Who should pay, from the dates and the rules: our delivery damage, the maker's warranty, the protection plan, or the customer. */
export async function coverageFor(c: Client, entityId: string, ticketId: string, asOf = today()): Promise<Coverage> {
  const t = await ticketOf(c, entityId, ticketId, false);
  const out: Coverage = { suggested: "billable", reason: "", deliveredOn: null, warrantyEnds: null, planEnds: null, planLineId: null, planName: null };
  if (t.issue_type === "damage_delivery") {
    return { ...out, suggested: "goodwill", reason: "it was damaged in our own delivery, so the store carries it" };
  }
  if (t.sales_order_line_id) {
    const d = await q<{ d: string | null }>(c, `
      select coalesce((select min(i.invoice_date)::text from customer_invoice_line il join customer_invoice i on i.id = il.invoice_id
                        where il.entity_id = $1 and il.sales_order_line_id = l.id),
                      (select so.ordered_at::date::text from sales_order so where so.id = l.sales_order_id)) d
        from sales_order_line l where l.entity_id = $1 and l.id = $2`, [entityId, t.sales_order_line_id]);
    out.deliveredOn = d[0]?.d ?? null;
  } else if (t.sales_order_id) {
    out.deliveredOn = (await q<{ d: string }>(c, `select ordered_at::date::text d from sales_order where entity_id = $1 and id = $2`, [entityId, t.sales_order_id]))[0]?.d ?? null;
  }
  if (!out.deliveredOn) return { ...out, reason: "no sale is linked, so nothing shows it is covered" };
  // manufacturer warranty: the most specific rule
  if (t.product_id) {
    const rule = await q<{ months: number; covers: string[] }>(c, `
      select r.months, r.covers from service_warranty_rule r join product p on p.id = $2 and p.entity_id = $1
       where r.entity_id = $1 and (r.vendor_id is null or r.vendor_id = p.vendor_id) and (r.category is null or r.category = p.category)
       order by (r.vendor_id is not null)::int + (r.category is not null)::int desc, (r.vendor_id is not null) desc limit 1`, [entityId, t.product_id]);
    if (rule.length) {
      out.warrantyEnds = addMonths(out.deliveredOn, rule[0].months);
      if (asOf <= out.warrantyEnds && rule[0].covers.includes(t.issue_type)) {
        return { ...out, suggested: "manufacturer", reason: `inside the maker's ${rule[0].months}-month warranty (to ${out.warrantyEnds})` };
      }
    }
  }
  // a protection plan sold on the same order
  if (t.sales_order_id) {
    const s = await settings(c, entityId);
    const plans = await q<{ id: string; sku: string; description: string }>(c, `
      select l.id, l.sku, l.description from sales_order_line l join product p on p.id = l.product_id
       where l.entity_id = $1 and l.sales_order_id = $2 and p.kind = 'warranty' and l.line_status = 'fulfilled' and l.qty > 0
       order by l.seq`, [entityId, t.sales_order_id]);
    for (const p of plans) {
      const terms = s.planTerms[p.sku] ?? { years: Number(/(\d+)\s*-?\s*Y/i.exec(p.sku)?.[1] ?? 1), covers: ["protection_plan", "defect", "warranty"] };
      const ends = addMonths(out.deliveredOn, Math.round(terms.years * 12));
      out.planEnds = ends; out.planLineId = p.id; out.planName = terms.name ?? p.description;
      if (asOf <= ends && terms.covers.includes(t.issue_type)) {
        return { ...out, suggested: "protection_plan", reason: `covered by the ${out.planName} (to ${ends})` };
      }
    }
  }
  const why = [out.warrantyEnds ? `the maker's warranty ended ${out.warrantyEnds}` : null,
    out.planEnds ? `the plan ${asOf > out.planEnds ? `ended ${out.planEnds}` : `does not cover ${words(t.issue_type)}`}` : "no protection plan was bought"].filter(Boolean).join("; ");
  return { ...out, suggested: "billable", reason: `the customer pays: ${why}` };
}

const MANAGERS = ["store_manager", "owner"];

/**
 * Triage: decide who pays. Taking the suggestion is anyone's call; choosing
 * a free coverage the rules do not support, or goodwill, is a manager's, with
 * a reason. Coverage is fixed once parts or costs are on the ticket.
 */
export async function triage(c: Client, scope: Scope, roles: Set<string>, ticketId: string,
  b: { coverage?: string; note?: string; priority?: string; technicianId?: string | null; providerId?: string | null }) {
  const t = await ticketOf(c, scope.entityId, ticketId);
  need(OPEN.includes(t.status), `ticket ${t.number} is ${words(t.status)}`);
  const cov = await coverageFor(c, scope.entityId, ticketId);
  const want = b.coverage || cov.suggested;
  need((COVERAGES as readonly string[]).includes(want), "coverage is manufacturer warranty, protection plan, goodwill or billable");
  const note = String(b.note ?? "").trim();
  const manager = MANAGERS.some((r) => roles.has(r));
  if (want !== cov.suggested) {
    need(want === "billable" || manager, `the rules say ${words(cov.suggested)} (${cov.reason}); making it ${words(want)} is a store manager's decision`);
    need(note, "say why it is not what the rules suggest");
  }
  if (want === "goodwill") need(note || cov.suggested === "goodwill", "goodwill needs a reason");
  if (t.coverage && t.coverage !== want) {
    const used = await q(c, `select 1 from service_part where entity_id = $1 and ticket_id = $2 and cancelled_at is null
                             union all select 1 from service_cost where entity_id = $1 and ticket_id = $2 limit 1`, [scope.entityId, t.id]);
    need(!used.length, `ticket ${t.number} already has parts or costs as ${words(t.coverage)}; cancel those before changing who pays`);
  }
  if (b.priority) need((PRIORITIES as readonly string[]).includes(b.priority), "priority is low, normal, high or urgent");
  if (t.status === "new") await moveTo(c, scope, t, "triage");
  await c.query(`update service_ticket set coverage = $3, coverage_note = $4, coverage_by = $5, plan_line_id = $6, priority = coalesce($7, priority)
                  where entity_id = $1 and id = $2`,
    [scope.entityId, t.id, want, note || (want === cov.suggested ? cov.reason : null), scope.actor.id || null,
     want === "protection_plan" ? cov.planLineId : null, b.priority || null]);
  await event(c, scope, t.id, "coverage", `${words(want)}${note ? `: ${note}` : cov.reason && want === cov.suggested ? `: ${cov.reason}` : ""}`);
  if (b.technicianId !== undefined || b.providerId !== undefined) await assign(c, scope, t.id, { technicianId: b.technicianId ?? null, providerId: b.providerId ?? null });
  return { coverage: want, suggested: cov.suggested, reason: cov.reason };
}

export async function assign(c: Client, scope: Scope, ticketId: string, b: { technicianId?: string | null; providerId?: string | null }) {
  const t = await ticketOf(c, scope.entityId, ticketId);
  need(OPEN.includes(t.status), `ticket ${t.number} is ${words(t.status)}`);
  let label = "nobody";
  if (b.technicianId) {
    need(isId(b.technicianId), "no such technician");
    const r = await q<{ name: string }>(c, `select u.name from app_user u join role_grant g on g.app_user_id = u.id
       where u.id = $2 and g.role = 'technician' and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = $3)) limit 1`,
      [scope.entityId, b.technicianId, scope.tenantId]);
    need(r.length, "that person is not one of this company's technicians");
    label = r[0].name;
  }
  if (b.providerId) {
    need(isId(b.providerId), "no such service company");
    const r = await q<{ name: string }>(c, `select name from service_provider where entity_id = $1 and id = $2 and active`, [scope.entityId, b.providerId]);
    need(r.length, "no such service company");
    label = b.technicianId ? `${label} and ${r[0].name}` : r[0].name;
  }
  await c.query(`update service_ticket set technician_id = $3, provider_id = $4 where entity_id = $1 and id = $2`,
    [scope.entityId, t.id, b.technicianId || null, b.providerId || null]);
  await event(c, scope, t.id, "assign", `assigned to ${label}`);
  return { ok: true };
}

export async function addNote(c: Client, scope: Scope, ticketId: string, note: string, photos?: unknown) {
  const t = await ticketOf(c, scope.entityId, ticketId);
  const p = cleanPhotos(photos, 12);
  need(note.trim() || p.length, "write the note, or add a photo");
  if (p.length) {
    await c.query(`update service_ticket set photos = (photos || $3::text[])[1:12] where entity_id = $1 and id = $2`, [scope.entityId, t.id, p]);
  }
  await event(c, scope, t.id, p.length ? "photo" : "note", note.trim() || `${p.length} photo(s) added`);
  return { ok: true };
}

/** Step the workflow by hand (the trigger refuses a skipped step). Cancelling needs a reason. */
export async function setStatus(c: Client, scope: Scope, ticketId: string, to: string, note = "") {
  const t = await ticketOf(c, scope.entityId, ticketId);
  need(["triage", "awaiting_parts", "scheduled", "in_progress", "cancelled"].includes(to), "use resolve or close for those steps");
  if (to === "cancelled") need(note.trim(), "say why the ticket is cancelled");
  if (["awaiting_parts", "scheduled", "in_progress"].includes(to)) need(t.coverage, "triage it first: decide who pays");
  await moveTo(c, scope, t, to);
  if (note.trim()) await event(c, scope, t.id, "note", note.trim());
  return { status: to };
}

// --------------------------------------------------------------- orders --

async function serviceLocation(c: Client, entityId: string, t: TicketRow): Promise<string> {
  const r = await q<{ id: string }>(c, `
    select coalesce((select so.location_id from sales_order so where so.entity_id = $1 and so.id = $2),
                    (select cu.home_location_id from customer cu where cu.entity_id = $1 and cu.id = $3),
                    (select l.id from location l where l.entity_id = $1 and l.kind in ('store','outlet') and l.status = 'active' order by l.code limit 1)) id`,
    [entityId, t.sales_order_id, t.customer_id]);
  need(r[0]?.id, "the company has no store to book the service against");
  return r[0].id;
}

/** The ticket's own order: covered parts and replacements at $0, or what the customer is billed. */
async function ensureOrder(c: Client, scope: Scope, t: TicketRow, which: "service" | "billing"): Promise<string> {
  const have = which === "service" ? t.service_order_id : t.billing_order_id;
  if (have) return have;
  need(t.customer_id, "a ticket needs a known customer before parts or charges go on it; link the customer first");
  const loc = await serviceLocation(c, scope.entityId, t);
  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'order', 'SO-') n /* unscoped: numbering function takes the entity */`, [scope.entityId])).n;
  const so = await one<{ id: string }>(c, `
    insert into sales_order (entity_id, number, channel, location_id, customer_id, status, fulfillment, ship_address_id, notes, created_by, external_ref)
    values ($1,$2,'phone',$3,$4,'open',$5,$6,$7,$8,$9) returning id`,
    [scope.entityId, number, loc, t.customer_id, "pickup", t.address_id,
     `${which === "service" ? "Covered service work" : "Service charges"} for ticket ${t.number}`, scope.actor.id || null, `${t.number}:${which}`]);
  await c.query(`update service_ticket set ${which === "service" ? "service_order_id" : "billing_order_id"} = $3 where entity_id = $1 and id = $2`,
    [scope.entityId, t.id, so.id]);
  if (which === "service") t.service_order_id = so.id; else t.billing_order_id = so.id;
  await event(c, scope, t.id, "billing", `${which === "service" ? "service" : "billing"} order ${number} opened`);
  return so.id;
}

async function addLine(c: Client, scope: Scope, orderId: string, productId: string, qty: number, priceMinor: bigint, fulfilFrom: string | null) {
  const p = await one<{ sku: string; name: string; taxable: boolean; kind: string }>(c,
    `select sku, name, taxable, kind from product where entity_id = $1 and id = $2`, [scope.entityId, productId]);
  const so = await one<{ location_id: string; fulfillment: string; ship_address_id: string | null }>(c,
    `select location_id, fulfillment, ship_address_id from sales_order where entity_id = $1 and id = $2`, [scope.entityId, orderId]);
  const net = BigInt(Math.round(qty * Number(priceMinor)));
  // Taxed the way the register does: the stack where the order is handed over, labor and plans as each jurisdiction says.
  const place = await tax.stackForLine(c, scope.entityId, { storeId: so.location_id, fulfillment: so.fulfillment, shipAddressId: so.ship_address_id });
  const cls = tax.classOf(p.kind);
  const lt = tax.computeLine(place.stack, { netMinor: net > 0n ? net : 0n, itemClass: cls, taxable: p.taxable, cert: null });
  const taxMinor = lt.taxMinor;
  const seq = (await one<{ n: number }>(c, `select coalesce(max(seq),0)::int + 1 n from sales_order_line where entity_id = $1 and sales_order_id = $2`, [scope.entityId, orderId])).n;
  const l = await one<{ id: string }>(c, `
    insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, tax_minor, fulfil_from_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [scope.entityId, orderId, seq, productId, p.sku, p.name, qty, priceMinor.toString(), taxMinor.toString(), fulfilFrom]);
  if (net > 0n) await tax.writeLineTax(c, scope.entityId, orderId, l.id, lt.rows, place, cls);
  await c.query(`select sales_order_retotal($1) /* unscoped: an order of this entity, just written */`, [orderId]);
  return { lineId: l.id, sku: p.sku, name: p.name };
}

async function partsLocation(c: Client, entityId: string, fallback: string): Promise<string> {
  const r = await q<{ id: string }>(c, `select id from location where entity_id = $1 and kind = 'warehouse' and status = 'active' order by code limit 1`, [entityId]);
  return r[0]?.id ?? fallback;
}

/**
 * A part (or a replacement piece) for the ticket. Covered work goes on the
 * service order at $0; billable on the billing order at its price. Stock is
 * reserved if it is on hand; otherwise the line waits on order for purchasing.
 * A $0 replacement needs a store manager and a reason.
 */
export async function addPart(c: Client, scope: Scope, roles: Set<string>, ticketId: string,
  b: { productId: string; qty?: number; kind?: string; reason?: string }) {
  const t = await ticketOf(c, scope.entityId, ticketId);
  need(OPEN.includes(t.status), `ticket ${t.number} is ${words(t.status)}`);
  need(t.coverage, "triage it first: decide who pays");
  need(isId(b.productId), "pick the part");
  const p = await q<{ kind: string; name: string; price_minor: string; status: string }>(c,
    `select kind, name, price_minor, status from product where entity_id = $1 and id = $2`, [scope.entityId, b.productId]);
  need(p.length, "no such product");
  need(["stock", "configurable", "special_order"].includes(p[0].kind), `${p[0].name} is not a part that comes from stock or a vendor`);
  const qty = Number(b.qty ?? 1);
  need(Number.isFinite(qty) && qty > 0 && qty <= 100, "order a positive quantity");
  const kind = b.kind === "replacement" ? "replacement" : "part";
  const billable = t.coverage === "billable";
  const reason = String(b.reason ?? "").trim();
  if (kind === "replacement" && !billable) {
    need(MANAGERS.some((r) => roles.has(r)), "a replacement at no charge needs a store manager");
    need(reason, "say why it is replaced at no charge");
  }
  const orderId = await ensureOrder(c, scope, t, billable ? "billing" : "service");
  const from = await partsLocation(c, scope.entityId, await serviceLocation(c, scope.entityId, t));
  const line = await addLine(c, scope, orderId, b.productId, qty, billable ? BigInt(p[0].price_minor) : 0n, from);
  // a replacement piece goes out on a truck: the order joins the delivery queue
  if (kind === "replacement" && t.address_id) {
    await c.query(`update sales_order set fulfillment = 'delivery', ship_address_id = coalesce(ship_address_id, $3) where entity_id = $1 and id = $2`,
      [scope.entityId, orderId, t.address_id]);
  }
  await inventory.reserveOrder(c, scope.entityId, orderId);
  const st = await one<{ line_status: string }>(c, `select line_status from sales_order_line where entity_id = $1 and id = $2`, [scope.entityId, line.lineId]);
  await c.query(`insert into service_part (entity_id, ticket_id, sales_order_line_id, product_id, qty, kind, billable, approved_by, approval_reason, created_by)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [scope.entityId, t.id, line.lineId, b.productId, qty, kind, billable, kind === "replacement" && !billable ? scope.actor.id : null,
     kind === "replacement" && !billable ? reason : null, scope.actor.id || null]);
  await event(c, scope, t.id, "part", `${kind === "replacement" ? "replacement" : "part"} ${qty}× ${line.name}${billable ? ` at ${usd(BigInt(p[0].price_minor))}` : " (covered)"}: ${st.line_status === "reserved" ? "in stock, reserved" : "on order"}${reason ? ` — ${reason}` : ""}`);
  if (st.line_status === "on_order" && ["triage", "scheduled", "in_progress"].includes(t.status)) await moveTo(c, scope, t, "awaiting_parts");
  return { lineId: line.lineId, status: st.line_status };
}

/** Order every part still waiting, through purchasing's special-order link (one PO per vendor). */
export async function orderParts(c: Client, scope: Scope, ticketId: string) {
  const t = await ticketOf(c, scope.entityId, ticketId);
  const waiting = await q<{ id: string }>(c, `
    select sp.sales_order_line_id id from service_part sp join sales_order_line l on l.id = sp.sales_order_line_id
     where sp.entity_id = $1 and sp.ticket_id = $2 and sp.cancelled_at is null and l.line_status = 'on_order'
       and not exists (select 1 from po_line_sales_line k where k.entity_id = $1 and k.sales_order_line_id = l.id and k.active)`, [scope.entityId, t.id]);
  need(waiting.length, "no part on this ticket is waiting for a purchase order");
  let placed;
  try { placed = await purchasing.placeSpecialOrders(c, scope, waiting.map((w) => w.id)); }
  catch (e) { if (e instanceof purchasing.PurchasingError) throw new ServiceError(e.message); throw e; }
  await event(c, scope, t.id, "part", `parts ordered on ${placed.map((p) => `${p.number} (${p.vendor}, due ${p.expectedOn})`).join(", ")}`);
  return placed.map((p) => ({ number: p.number, vendor: p.vendor, expectedOn: p.expectedOn }));
}

/** A billable charge: a service call, labour, haul-away. */
export async function addCharge(c: Client, scope: Scope, ticketId: string, b: { productId: string; qty?: number; priceMinor?: bigint | null }) {
  const t = await ticketOf(c, scope.entityId, ticketId);
  need(OPEN.includes(t.status) || t.status === "resolved", `ticket ${t.number} is ${words(t.status)}`);
  need(t.coverage === "billable", `ticket ${t.number} is covered (${words(t.coverage ?? "not triaged")}); nothing is charged to the customer`);
  need(isId(b.productId), "pick the charge");
  const p = await q<{ kind: string; name: string; price_minor: string }>(c, `select kind, name, price_minor from product where entity_id = $1 and id = $2`, [scope.entityId, b.productId]);
  need(p.length, "no such product");
  need(["service", "fee"].includes(p[0].kind), `${p[0].name} is not a service charge`);
  const qty = Number(b.qty ?? 1);
  need(Number.isFinite(qty) && qty > 0 && qty <= 100, "charge a positive quantity");
  const price = b.priceMinor ?? BigInt(p[0].price_minor);
  need(price >= 0n, "a charge is not negative");
  const orderId = await ensureOrder(c, scope, t, "billing");
  const l = await addLine(c, scope, orderId, b.productId, qty, price, null);
  await event(c, scope, t.id, "billing", `charge ${qty}× ${l.name} at ${usd(price)}`);
  return { lineId: l.lineId };
}

/** Cancel a part or charge that has not been used or invoiced. Inventory releases any reservation. */
export async function cancelLine(c: Client, scope: Scope, ticketId: string, lineId: string, reason: string) {
  const t = await ticketOf(c, scope.entityId, ticketId);
  need(reason.trim(), "say why it comes off");
  need(isId(lineId), "no such line");
  const l = await q<{ sales_order_id: string; line_status: string; description: string }>(c, `
    select sales_order_id, line_status, description from sales_order_line where entity_id = $1 and id = $2 and sales_order_id = any($3) for update`,
    [scope.entityId, lineId, [t.service_order_id, t.billing_order_id].filter(Boolean)]);
  need(l.length, "that line is not on this ticket");
  need(!["fulfilled", "cancelled", "returned"].includes(l[0].line_status), `${l[0].description} is ${l[0].line_status}; it cannot come off`);
  const po = await q(c, `select 1 from po_line_sales_line where entity_id = $1 and sales_order_line_id = $2 and active`, [scope.entityId, lineId]);
  need(!po.length, `${l[0].description} is on a purchase order; cancel it with purchasing first`);
  await inventory.releaseLines(c, scope.entityId, l[0].sales_order_id, [lineId]);
  await c.query(`update sales_order_line set line_status = 'cancelled' where entity_id = $1 and id = $2`, [scope.entityId, lineId]);
  await c.query(`select sales_order_retotal($1) /* unscoped: an order of this entity */`, [l[0].sales_order_id]);
  await c.query(`update service_part set cancelled_at = now() where entity_id = $1 and sales_order_line_id = $2`, [scope.entityId, lineId]);
  await event(c, scope, t.id, "part", `${l[0].description} taken off: ${reason.trim()}`);
  return { ok: true };
}

// ---------------------------------------------------------------- costs --

async function chargeCode(t: TicketRow, chargeTo: string) {
  if (chargeTo === "vendor") need(t.vendor_id, `ticket ${t.number} names no vendor to charge back`);
  return chargeTo === "vendor" ? "1150" : "6150";
}

async function postCost(c: Client, scope: Scope, t: TicketRow, e: { kind: string; amountMinor: bigint; chargeTo: string; credit: string; note: string; visitId?: string | null }) {
  need(e.amountMinor > 0n, "a cost is more than zero");
  need(["service_expense", "vendor"].includes(e.chargeTo), "a cost is charged to service expense or back to the vendor");
  const debit = await chargeCode(t, e.chargeTo);
  const loc = await serviceLocation(c, scope.entityId, t);
  const po = await profitObjectFor(c, scope.entityId, loc);
  const id = (await one<{ id: string }>(c, `select gen_random_uuid()::text id /* unscoped: no table */`)).id;
  // "other" costs are paid elsewhere (a card, a bill coded to 6150), which already books the expense:
  // the ticket keeps the record, and only a chargeback to the vendor moves money in the books.
  const je = debit === e.credit ? null : await post(c, scope, { date: today(), sourceType: "service" as never, sourceId: id,
    description: `${t.number}: ${e.kind.replace("_", " ")}${e.note ? ` — ${e.note}` : ""}`.slice(0, 300),
    lines: [{ code: debit, debit: e.amountMinor, profitObjectId: po }, { code: e.credit, credit: e.amountMinor, profitObjectId: po }] });
  await c.query(`insert into service_cost (id, entity_id, ticket_id, visit_id, kind, amount_minor, charge_to, note, journal_entry_id, created_by)
                 values ($1,$2,$3,$4,$5,$6,$7,nullif($8,''),$9,$10)`,
    [id, scope.entityId, t.id, e.visitId ?? null, e.kind, e.amountMinor.toString(), e.chargeTo, e.note, je, scope.actor.id || null]);
  await event(c, scope, t.id, "cost", `${e.kind.replace("_", " ")} ${usd(e.amountMinor)} charged to ${e.chargeTo === "vendor" ? "the vendor" : "service expense"}`);
  // A chargeback is a debit memo on the vendor's account in payables: it reduces what we owe them.
  let memo: { id: string; number: string } | null = null;
  if (e.chargeTo === "vendor" && je && t.vendor_id) {
    memo = await fromChargeback(c, scope, { vendorId: t.vendor_id, serviceCostId: id, ticketId: t.id, ticketNumber: t.number, amountMinor: e.amountMinor,
      journalEntryId: je, offsetCode: e.credit, what: `${e.kind.replace("_", " ")}${e.note ? ` — ${e.note}` : ""}` });
  }
  return { id, journalEntryId: je, debitMemo: memo };
}

const defaultChargeTo = (t: TicketRow) => (t.coverage === "manufacturer" && t.vendor_id ? "vendor" : "service_expense");

/** A cost entered by hand: a third party's repair, a part bought outside, anything else. */
export async function addCost(c: Client, scope: Scope, ticketId: string, b: { kind: string; amountMinor: bigint; chargeTo?: string; note?: string }) {
  const t = await ticketOf(c, scope.entityId, ticketId);
  need(t.status !== "closed" && t.status !== "cancelled", `ticket ${t.number} is ${t.status}`);
  need(["third_party", "other", "labor"].includes(b.kind), "a cost entered here is labour, a third party's work, or other");
  need(String(b.note ?? "").trim() || b.kind === "labor", "say what the cost is for");
  if (b.kind === "third_party") await needBillingVendor(c, scope, t.provider_id);
  const credit = b.kind === "labor" ? "6155" : b.kind === "third_party" ? "2050" : "6150";
  return postCost(c, scope, t, { kind: b.kind, amountMinor: b.amountMinor, chargeTo: b.chargeTo || defaultChargeTo(t), credit, note: String(b.note ?? "").trim() });
}

/**
 * Covered goods that left stock as a $0 sale sit in cost of goods sold. Move
 * whatever has not been moved yet to service expense (or the vendor's chargeback).
 */
/** An outside company's cost is accrued to 2050; that only clears if they bill us through payables as a linked vendor. */
async function needBillingVendor(c: Client, scope: Scope, providerId: string | null) {
  need(providerId, "assign the outside service company first, so its bill can clear this cost");
  const r = await q<{ name: string; vendor_id: string | null }>(c, `select name, vendor_id from service_provider where entity_id = $1 and id = $2`, [scope.entityId, providerId]);
  need(r[0]?.vendor_id, `link ${r[0]?.name ?? "the service company"} to its vendor in Service › Setup first, so its bill clears this cost instead of counting it twice`);
}

async function settleCovered(c: Client, scope: Scope, t: TicketRow) {
  if (!t.service_order_id) return 0n;
  const sold = BigInt((await one<{ s: string }>(c, `
    select coalesce(sum(jl.debit_minor),0)::text s from journal_entry e join journal_line jl on jl.journal_entry_id = e.id
      join gl_account g on g.id = jl.gl_account_id and g.code = '5000'
     where e.entity_id = $1 and e.source_type = 'sale' and e.source_id = $2`, [scope.entityId, t.service_order_id])).s);
  const moved = BigInt((await one<{ s: string }>(c, `
    select coalesce(sum(amount_minor),0)::text s from service_cost where entity_id = $1 and ticket_id = $2 and kind in ('parts','replacement')`,
    [scope.entityId, t.id])).s);
  const left = sold - moved;
  if (left <= 0n) return 0n;
  const repl = await q(c, `select 1 from service_part sp join sales_order_line l on l.id = sp.sales_order_line_id
     where sp.entity_id = $1 and sp.ticket_id = $2 and sp.kind = 'replacement' and l.line_status = 'fulfilled' limit 1`, [scope.entityId, t.id]);
  await postCost(c, scope, t, { kind: repl.length ? "replacement" : "parts", amountMinor: left, chargeTo: defaultChargeTo(t), credit: "5000",
    note: "covered goods at cost" });
  return left;
}

/** Hand over billable lines (charges, parts used) and invoice them to A/R; service charges move to service revenue. */
async function invoiceBillable(c: Client, scope: Scope, t: TicketRow, lineIds: string[]) {
  if (!t.billing_order_id || !lineIds.length) return null;
  const f = await inventory.fulfilLines(c, scope.entityId, t.billing_order_id, lineIds);
  if (!f.lines) return null;
  const inv = await invoiceFulfilment(c, scope, t.billing_order_id, lineIds, f.costMinor);
  const svc = BigInt((await one<{ s: string }>(c, `
    select coalesce(sum(round(l.qty * l.unit_price_minor)::bigint - l.discount_minor),0)::text s
      from sales_order_line l join product p on p.id = l.product_id
     where l.entity_id = $1 and l.id = any($2) and p.kind in ('service','fee')`, [scope.entityId, lineIds])).s);
  if (svc > 0n) {
    const loc = await serviceLocation(c, scope.entityId, t);
    const po = await profitObjectFor(c, scope.entityId, loc);
    await post(c, scope, { date: today(), sourceType: "service" as never, sourceId: t.id, description: `${t.number}: service charges to service revenue`,
      lines: [{ code: "4030", debit: svc, profitObjectId: po }, { code: "4050", credit: svc, profitObjectId: po }] });
  }
  await settleOrderStatus(c, scope.entityId, t.billing_order_id);
  await event(c, scope, t.id, "billing", `invoiced ${f.lines} line(s) to the customer`);
  return inv;
}

async function settleOrderStatus(c: Client, entityId: string, orderId: string) {
  await c.query(`update sales_order so set status = case
      when not exists (select 1 from sales_order_line l where l.entity_id = $1 and l.sales_order_id = so.id and l.line_status not in ('fulfilled','cancelled','returned')) then 'fulfilled'
      else 'fulfilling' end
    where so.entity_id = $1 and so.id = $2 and so.status in ('open','fulfilling')`, [entityId, orderId]);
}

/** Invoice whatever billable charges are still open (a counter visit, a third party's job). */
export async function invoiceCharges(c: Client, scope: Scope, ticketId: string) {
  const t = await ticketOf(c, scope.entityId, ticketId);
  need(t.billing_order_id, "nothing is billed on this ticket");
  const open = await q<{ id: string }>(c, `
    select l.id from sales_order_line l join product p on p.id = l.product_id
     where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status in ('open','reserved','ready') and l.qty > 0`, [scope.entityId, t.billing_order_id]);
  need(open.length, "every charge is already invoiced");
  const short = await q<{ sku: string }>(c, `select l.sku from sales_order_line l where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status = 'on_order'`,
    [scope.entityId, t.billing_order_id]);
  const inv = await invoiceBillable(c, scope, t, open.map((x) => x.id));
  return { invoice: inv?.invoiceNumber ?? null, totalMinor: inv ? inv.revenueMinor + inv.taxMinor : 0n, stillOnOrder: short.map((s) => s.sku) };
}

// --------------------------------------------------------------- visits --

/** Book an in-house visit on the delivery calendar (a fleet service or pickup stop), or a third party's appointment. */
export async function scheduleVisit(c: Client, scope: Scope, ticketId: string,
  b: { kind?: string; day?: string; windowId?: string; providerId?: string | null; notes?: string; allowToday?: boolean; override?: string }) {
  const t = await ticketOf(c, scope.entityId, ticketId);
  need(t.status !== "new" && t.coverage, "triage it first: decide who pays");
  need(["triage", "awaiting_parts", "scheduled", "in_progress"].includes(t.status), `ticket ${t.number} is ${words(t.status)}`);
  const kind = b.kind === "pickup" ? "pickup" : "repair";
  const open = await q<{ n: number }>(c, `select count(*)::int n from service_visit where entity_id = $1 and ticket_id = $2 and completed_at is null
      and (stop_id is null or exists (select 1 from delivery_stop s where s.id = service_visit.stop_id and s.status in ('scheduled','arrived')))`, [scope.entityId, t.id]);
  need(!open[0].n, `ticket ${t.number} already has a visit booked; finish or move that one`);
  let visitId: string;
  if (b.providerId) {
    need(isId(b.providerId), "no such service company");
    const p = await q<{ name: string }>(c, `select name from service_provider where entity_id = $1 and id = $2 and active`, [scope.entityId, b.providerId]);
    need(p.length, "no such service company");
    need(b.day && DAY.test(b.day), "give the day the service company will go");
    visitId = (await one<{ id: string }>(c, `insert into service_visit (entity_id, ticket_id, provider_id, kind, scheduled_on, created_by)
      values ($1,$2,$3,$4,$5,$6) returning id`, [scope.entityId, t.id, b.providerId, kind, b.day, scope.actor.id || null])).id;
    await event(c, scope, t.id, "visit", `${p[0].name} booked for ${b.day}`);
  } else {
    need(t.customer_id && t.address_id, "an in-home visit needs the customer and their address on the ticket");
    let stop;
    try {
      stop = await fleet.bookStop(c, scope, {
        kind: kind === "pickup" ? "pickup" : "service", customerId: t.customer_id, addressId: t.address_id, day: b.day, windowId: b.windowId,
        problem: `${t.number}: ${t.description}`.slice(0, 480), notes: b.notes, allowToday: b.allowToday, override: b.override,
        pickupLines: kind === "pickup" ? [{ description: `For repair (${t.number})`, qty: 1, orderLineId: t.sales_order_line_id ?? undefined }] : undefined,
      });
    } catch (e) { if (e instanceof fleet.FleetError) throw new ServiceError(e.message); throw e; }
    visitId = (await one<{ id: string }>(c, `insert into service_visit (entity_id, ticket_id, stop_id, kind, scheduled_on, technician_id, created_by)
      values ($1,$2,$3,$4,$5,$6,$7) returning id`, [scope.entityId, t.id, stop.id, kind, b.day, t.technician_id, scope.actor.id || null])).id;
    await event(c, scope, t.id, "visit", `${kind === "pickup" ? "pickup for repair" : "in-home visit"} ${stop.number} booked for ${b.day}`);
  }
  if (t.status !== "scheduled") await moveTo(c, scope, t, "scheduled");
  return { visitId };
}

export type VisitDone = {
  outcome: string; workNotes?: string; minutes?: number; partsUsed?: string[];
  recipient?: string; signature?: string; photos?: string[]; thirdPartyCostMinor?: bigint | null;
};

/**
 * The technician is done at the door. The fleet stop is completed (signature,
 * photos), parts used leave stock, billable lines are invoiced, labour is
 * costed, and the ticket moves on by the outcome.
 */
export async function completeVisit(c: Client, scope: Scope, visitId: string, b: VisitDone) {
  need(isId(visitId), "no such visit");
  const v = await q<{ id: string; ticket_id: string; stop_id: string | null; provider_id: string | null; kind: string; completed_at: string | null }>(c,
    `select id, ticket_id, stop_id, provider_id, kind, completed_at from service_visit where entity_id = $1 and id = $2 for update`, [scope.entityId, visitId]);
  need(v.length, "no such visit");
  need(!v[0].completed_at, "that visit is already done");
  const t = await ticketOf(c, scope.entityId, v[0].ticket_id);
  need((OUTCOMES as readonly string[]).includes(b.outcome), "say how the visit went");
  const notes = String(b.workNotes ?? "").trim();
  need(notes || b.outcome === "fixed", "write what was found and done");
  const minutes = b.minutes == null ? 0 : Math.round(Number(b.minutes));
  need(Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440, "time spent is minutes, up to a day");
  const photos = cleanPhotos(b.photos, 10);
  const isPickup = v[0].kind === "pickup";
  if (v[0].stop_id && b.outcome !== "not_home" && !isPickup) need(b.signature, "get the customer's signature");

  if (v[0].stop_id) {
    try {
      await fleet.completeStop(c, scope, v[0].stop_id, b.outcome === "not_home"
        ? { exception: "not_home", reason: notes || "nobody home" }
        : { recipient: b.recipient || "Customer", signature: b.signature, photos, reason: notes });
    } catch (e) { if (e instanceof fleet.FleetError || e instanceof inventory.InventoryError) throw new ServiceError(e.message); throw e; }
  }
  // parts used: they leave stock now
  const used = (b.partsUsed ?? []).filter(isId);
  const parts = used.length ? await q<{ id: string; sales_order_line_id: string; billable: boolean; line_status: string; sales_order_id: string; description: string }>(c, `
    select sp.id, sp.sales_order_line_id, sp.billable, l.line_status, l.sales_order_id, l.description
      from service_part sp join sales_order_line l on l.id = sp.sales_order_line_id
     where sp.entity_id = $1 and sp.ticket_id = $2 and sp.id = any($3) and sp.used_at is null and sp.cancelled_at is null`, [scope.entityId, t.id, used]) : [];
  need(parts.length === new Set(used).size, "a part named is not on this ticket, or was already used");
  for (const p of parts) need(["reserved", "ready"].includes(p.line_status), `${p.description} is ${words(p.line_status)}, not in hand to use`);
  const covered = parts.filter((p) => !p.billable);
  if (covered.length) {
    const ids = covered.map((p) => p.sales_order_line_id);
    const f = await inventory.fulfilLines(c, scope.entityId, t.service_order_id!, ids);
    await invoiceFulfilment(c, scope, t.service_order_id!, ids, f.costMinor);
    await settleOrderStatus(c, scope.entityId, t.service_order_id!);
  }
  if (parts.length) await c.query(`update service_part set used_at = now() where entity_id = $1 and id = any($2)`, [scope.entityId, parts.map((p) => p.id)]);
  await settleCovered(c, scope, t);
  // billable: the parts used and every open charge go to the customer's account
  if (t.billing_order_id && b.outcome !== "not_home") {
    const charges = await q<{ id: string }>(c, `select l.id from sales_order_line l join product p on p.id = l.product_id
       where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status = 'open' and p.kind in ('service','fee')`, [scope.entityId, t.billing_order_id]);
    await invoiceBillable(c, scope, t, [...charges.map((x) => x.id), ...parts.filter((p) => p.billable).map((p) => p.sales_order_line_id)]);
  }
  // labour
  if (minutes > 0) {
    if (v[0].provider_id) {
      if (b.thirdPartyCostMinor && b.thirdPartyCostMinor > 0n) await needBillingVendor(c, scope, v[0].provider_id);
      if (b.thirdPartyCostMinor && b.thirdPartyCostMinor > 0n) await postCost(c, scope, t, { kind: "third_party", amountMinor: b.thirdPartyCostMinor,
        chargeTo: defaultChargeTo(t), credit: "2050", note: "outside service company", visitId });
    } else {
      const rate = await q<{ r: string | null }>(c, `select hourly_cost_minor::text r from driver_profile where entity_id = $1 and app_user_id = $2`,
        [scope.entityId, scope.actor.id ?? null]);
      const hourly = rate[0]?.r ? BigInt(rate[0].r) : (await settings(c, scope.entityId)).laborRateMinor;
      const amt = (hourly * BigInt(minutes) + 30n) / 60n;
      if (amt > 0n) await postCost(c, scope, t, { kind: "labor", amountMinor: amt, chargeTo: defaultChargeTo(t), credit: "6155",
        note: `${minutes} min at ${usd(hourly)}/h`, visitId });
    }
  } else if (v[0].provider_id && b.thirdPartyCostMinor && b.thirdPartyCostMinor > 0n) {
    await needBillingVendor(c, scope, v[0].provider_id);
    await postCost(c, scope, t, { kind: "third_party", amountMinor: b.thirdPartyCostMinor, chargeTo: defaultChargeTo(t), credit: "2050", note: "outside service company", visitId });
  }
  await c.query(`update service_visit set outcome = $3, work_notes = nullif($4,''), minutes = $5, technician_id = coalesce(technician_id, $6), completed_at = now()
                  where entity_id = $1 and id = $2`, [scope.entityId, visitId, b.outcome, notes, minutes, v[0].provider_id ? null : scope.actor.id || null]);
  await event(c, scope, t.id, "visit", `${isPickup ? "pickup" : "visit"}: ${words(b.outcome)}${notes ? ` — ${notes}` : ""}${minutes ? ` (${minutes} min)` : ""}`);

  // where the ticket goes next
  if (b.outcome === "not_home" || b.outcome === "other") {
    if (["scheduled", "awaiting_parts"].includes(t.status)) await moveTo(c, scope, t, "triage");
  } else {
    if (t.status !== "in_progress") await moveTo(c, scope, t, "in_progress");
    if (isPickup) { /* it is in our shop now; resolved when it goes back */ }
    else if (b.outcome === "needs_parts") await moveTo(c, scope, t, "awaiting_parts");
    else if (b.outcome === "needs_return") await moveTo(c, scope, t, "scheduled");
    else if (b.outcome === "fixed" || b.outcome === "no_fault") {
      const type = b.outcome === "no_fault" ? "no_fault_found" : parts.length ? "replace_part" : "in_home_repair";
      await resolveInternal(c, scope, t, type, notes || "fixed on the visit");
    }
  }
  return { status: t.status, partsUsed: parts.length };
}

async function resolveInternal(c: Client, scope: Scope, t: TicketRow, type: string, note: string) {
  await c.query(`update service_ticket set resolution_type = $3, resolution_note = $4 where entity_id = $1 and id = $2`, [scope.entityId, t.id, type, note]);
  if (t.status !== "in_progress" && !["triage", "awaiting_parts", "scheduled"].includes(t.status)) need(false, `ticket ${t.number} is ${words(t.status)}`);
  await moveTo(c, scope, t, "resolved");
  await event(c, scope, t.id, "resolution", `${words(type)}: ${note}`);
  if (t.customer_id) await fleet.messageCustomer(c, scope, { customerId: t.customer_id, body: `your service request ${t.number} is resolved (${words(type)}). Thank you for your patience.` });
}

/**
 * Resolve by hand. Credit/refund goes through POS's return (the money and the
 * goods back to damage, where a vendor claim can start); replace item needs
 * the replacement on the ticket; pickup repair needs the pickup done.
 */
export async function resolve(c: Client, scope: Scope, roles: Set<string>, ticketId: string,
  b: { type: string; note?: string; sessionId?: string | null; qty?: number; tenders?: pos.Tender[] }) {
  const t = await ticketOf(c, scope.entityId, ticketId);
  need((RESOLUTIONS as readonly string[]).includes(b.type), "say how it was resolved");
  need(["triage", "awaiting_parts", "scheduled", "in_progress"].includes(t.status), `ticket ${t.number} is ${words(t.status)}`);
  need(t.coverage, "triage it first: decide who pays");
  const note = String(b.note ?? "").trim();
  need(note, "say what was done");
  if (b.type === "credit_refund") {
    need(MANAGERS.some((r) => roles.has(r)), "a credit or refund needs a store manager");
    need(t.sales_order_line_id, "a refund is against the line that was sold; link the order line to the ticket");
    need(b.sessionId && isId(b.sessionId), "pick the open register the refund goes through");
    const reason = t.issue_type === "damage_delivery" ? "damaged_in_delivery" : t.issue_type === "defect" || t.issue_type === "warranty" ? "defective" : "other";
    let r;
    try {
      r = await pos.returnGoods(c, scope, t.sales_order_id!, { sessionId: b.sessionId, tenders: b.tenders ?? [], note: `service ${t.number}`,
        lines: [{ lineId: t.sales_order_line_id, qty: Number(b.qty ?? 1), reason, disposition: "damage", note: `${t.number}: ${note}` }] });
    } catch (e) { if (e instanceof pos.PosError || e instanceof inventory.InventoryError) throw new ServiceError(e.message); throw e; }
    const dmg = await q<{ id: string }>(c, `select d.id from inv_damage d where d.entity_id = $1 and d.source = 'customer_return' and d.product_id = $2
        and d.description like $3 order by d.opened_at desc limit 1`, [scope.entityId, t.product_id, `%${t.number}:%`]);
    await c.query(`update service_ticket set damage_id = $3 where entity_id = $1 and id = $2`, [scope.entityId, t.id, dmg[0]?.id ?? null]);
    await event(c, scope, t.id, "billing", `returned on ${r.number}, ${usd(r.refundMinor)} back to the customer`);
  }
  if (b.type === "replace_item") {
    const rep = await q(c, `select 1 from service_part where entity_id = $1 and ticket_id = $2 and kind = 'replacement' and cancelled_at is null`, [scope.entityId, t.id]);
    need(rep.length, "put the replacement on the ticket first");
  }
  if (b.type === "pickup_repair") {
    const pk = await q(c, `select 1 from service_visit where entity_id = $1 and ticket_id = $2 and kind = 'pickup' and completed_at is not null and outcome <> 'not_home'`, [scope.entityId, t.id]);
    need(pk.length, "the piece has not been picked up yet");
  }
  if (t.status !== "in_progress" && b.type !== "credit_refund" && b.type !== "no_fault_found") await moveTo(c, scope, t, "in_progress");
  await settleCovered(c, scope, t);
  await resolveInternal(c, scope, t, b.type, note);
  return { status: "resolved" };
}

/** Close a resolved ticket. Billable charges must be invoiced (or taken off), and covered goods are settled to who carries them. */
export async function closeTicket(c: Client, scope: Scope, ticketId: string, note = "") {
  const t = await ticketOf(c, scope.entityId, ticketId);
  need(t.status === "resolved", `ticket ${t.number} is ${words(t.status)}; resolve it first`);
  if (t.billing_order_id) {
    const open = await q<{ sku: string }>(c, `select sku from sales_order_line where entity_id = $1 and sales_order_id = $2 and line_status in ('open','reserved','ready','on_order')`,
      [scope.entityId, t.billing_order_id]);
    need(!open.length, `charges ${open.map((x) => x.sku).join(", ")} are not invoiced; invoice or take them off first`);
  }
  await settleCovered(c, scope, t);
  await moveTo(c, scope, t, "closed");
  if (note.trim()) await event(c, scope, t.id, "note", note.trim());
  return { status: "closed" };
}

// --------------------------------------------------------- vendor claims --

/** File a vendor claim on what came back (inventory's damage record from the return). */
export async function fileClaim(c: Client, scope: Scope, ticketId: string, b: { amountMinor: bigint; vendorRef?: string; photos?: unknown }) {
  const t = await ticketOf(c, scope.entityId, ticketId);
  need(t.damage_id, `nothing of ours is held for ${t.number}; a claim is filed on goods that came back (credit/refund or a pickup). In-home work is charged back on the ticket's costs`);
  let r;
  try { r = await inventory.openVendorClaim(c, scope, t.damage_id, { amountClaimedMinor: b.amountMinor, vendorRef: b.vendorRef, photoUrls: cleanPhotos(b.photos ?? []) }); }
  catch (e) { if (e instanceof inventory.InventoryError) throw new ServiceError(e.message); throw e; }
  await c.query(`insert into service_claim (entity_id, ticket_id, claim_id) values ($1,$2,$3)`, [scope.entityId, t.id, r.id]);
  await event(c, scope, t.id, "claim", `vendor claim ${r.number} for ${usd(b.amountMinor)}`);
  return r;
}

export async function updateClaim(c: Client, scope: Scope, ticketId: string, claimId: string, b: { status: string; creditMinor?: bigint | null; resolution?: string; vendorRef?: string }) {
  const t = await ticketOf(c, scope.entityId, ticketId);
  const k = await q(c, `select 1 from service_claim where entity_id = $1 and ticket_id = $2 and claim_id = $3`, [scope.entityId, t.id, claimId]);
  need(k.length, "that claim is not on this ticket");
  let r;
  try { r = await inventory.updateClaim(c, scope, claimId, b); }
  catch (e) { if (e instanceof inventory.InventoryError) throw new ServiceError(e.message); throw e; }
  await event(c, scope, t.id, "claim", `claim ${r.number} ${r.status}${b.creditMinor != null ? ` — credit ${usd(b.creditMinor)}` : ""}`);
  return r;
}

// ---------------------------------------------------------------- views --

export async function tickets(c: Client, entityId: string, f: { status?: string; q?: string; technicianId?: string | null; limit?: number }) {
  const status = f.status === "open" || !f.status ? OPEN : f.status === "all" ? null : [f.status];
  return q(c, `
    select t.id, t.number, t.status, t.source, t.issue_type, t.priority, t.coverage, t.description, t.created_at, t.sla_due_at,
           (t.sla_due_at < now() and t.status = any($5)) sla_breached, extract(day from now() - t.created_at)::int age_days,
           coalesce(cu.name, t.contact_name) customer, p.name product, v.legal_name vendor, u.name technician, sp.name provider,
           so.number order_number,
           (select s.scheduled_on::text from service_visit sv join delivery_stop s on s.id = sv.stop_id
             where sv.ticket_id = t.id and sv.completed_at is null and s.status in ('scheduled','arrived') order by s.scheduled_on limit 1) next_visit
      from service_ticket t left join customer cu on cu.id = t.customer_id left join product p on p.id = t.product_id
      left join vendor v on v.id = t.vendor_id left join app_user u on u.id = t.technician_id left join service_provider sp on sp.id = t.provider_id
      left join sales_order so on so.id = t.sales_order_id
     where t.entity_id = $1 and ($2::text[] is null or t.status = any($2))
       and ($3::text = '' or t.number ilike '%' || $3 || '%' or coalesce(cu.name, t.contact_name) ilike '%' || $3 || '%' or t.description ilike '%' || $3 || '%'
            or so.number ilike '%' || $3 || '%')
       and ($4::uuid is null or t.technician_id = $4
            or exists (select 1 from service_visit sv join delivery_stop s on s.id = sv.stop_id join delivery_route r on r.id = s.route_id
                        where sv.ticket_id = t.id and (r.driver_id = $4 or r.helper_id = $4)))
     order by (t.sla_due_at < now() and t.status = any($5)) desc, case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.created_at
     limit $6`, [entityId, status, String(f.q ?? "").trim().slice(0, 60), f.technicianId ?? null, OPEN, Math.min(f.limit ?? 200, 500)]);
}

export async function ticket(c: Client, entityId: string, id: string) {
  const t = await ticketOf(c, entityId, id, false);
  const head = await one<Record<string, unknown>>(c, `
    select t.*, coalesce(cu.name, t.contact_name) customer_name, cu.phone customer_phone, cu.email customer_email,
           a.line1, a.city, a.state, a.postal, a.geo is not null has_geo, p.name product, p.sku, p.category, v.legal_name vendor,
           so.number order_number, ol.description line_description, u.name technician, sp.name provider, cb.name coverage_by_name,
           (t.sla_due_at < now() and t.status = any($3)) sla_breached,
           (select z.id from delivery_zone z where z.entity_id = t.entity_id and z.active and left(a.postal,5) = any(z.postal_codes) limit 1) zone_id,
           sv.number service_order_number, bo.number billing_order_number, bo.total_minor::text billing_total_minor,
           (bo.total_minor - bo.paid_minor)::text billing_balance_minor
      from service_ticket t left join customer cu on cu.id = t.customer_id left join customer_address a on a.id = t.address_id
      left join product p on p.id = t.product_id left join vendor v on v.id = t.vendor_id left join sales_order so on so.id = t.sales_order_id
      left join sales_order_line ol on ol.id = t.sales_order_line_id left join app_user u on u.id = t.technician_id
      left join service_provider sp on sp.id = t.provider_id left join app_user cb on cb.id = t.coverage_by
      left join sales_order sv on sv.id = t.service_order_id left join sales_order bo on bo.id = t.billing_order_id
     where t.entity_id = $1 and t.id = $2`, [entityId, id, OPEN]);
  const seq = async <R>(fns: (() => Promise<R>)[]) => { const out: R[] = []; for (const f of fns) out.push(await f()); return out; };
  const [events, parts, charges, visits, costs, claims] = await seq<Record<string, unknown>[]>([
    () => q(c, `select at, by_label, kind, from_status, to_status, note from service_event where entity_id = $1 and ticket_id = $2 order by at, id`, [entityId, id]),
    () => q(c, `select sp.id, sp.kind, sp.billable, sp.qty::float qty, sp.used_at, sp.cancelled_at, sp.approval_reason, l.id line_id, l.line_status, l.unit_price_minor::text price_minor,
                 p.name, p.sku, (select po.number from po_line_sales_line k join purchase_order_line pl on pl.id = k.purchase_order_line_id
                   join purchase_order po on po.id = pl.purchase_order_id where k.entity_id = $1 and k.sales_order_line_id = l.id and k.active limit 1) po_number,
                 (select k.expected_on::text from po_line_sales_line k where k.entity_id = $1 and k.sales_order_line_id = l.id and k.active limit 1) expected_on
            from service_part sp join sales_order_line l on l.id = sp.sales_order_line_id join product p on p.id = sp.product_id
           where sp.entity_id = $1 and sp.ticket_id = $2 order by sp.created_at`, [entityId, id]),
    () => t.billing_order_id ? q(c, `select l.id, l.sku, l.description, l.qty::float qty, l.unit_price_minor::text price_minor, l.tax_minor::text tax_minor, l.line_status
            from sales_order_line l join product p on p.id = l.product_id where l.entity_id = $1 and l.sales_order_id = $2 and p.kind in ('service','fee') order by l.seq`,
      [entityId, t.billing_order_id]) : Promise.resolve([]),
    () => q(c, `select v.id, v.kind, v.scheduled_on::text scheduled_on, v.outcome, v.work_notes, v.minutes, v.completed_at, s.number stop_number, s.status stop_status,
                 w.label window_label, r.number route_number, d.name driver, pr.name provider, tu.name technician
            from service_visit v left join delivery_stop s on s.id = v.stop_id left join delivery_window w on w.id = s.window_id
            left join delivery_route r on r.id = s.route_id left join app_user d on d.id = r.driver_id
            left join service_provider pr on pr.id = v.provider_id left join app_user tu on tu.id = v.technician_id
           where v.entity_id = $1 and v.ticket_id = $2 order by v.created_at`, [entityId, id]),
    () => q(c, `select kind, amount_minor::text amount_minor, charge_to, note, created_at from service_cost where entity_id = $1 and ticket_id = $2 order by created_at`, [entityId, id]),
    () => q(c, `select k.id, k.number, k.status, k.amount_claimed_minor::text amount_claimed_minor, k.credit_minor::text credit_minor, k.vendor_ref
            from service_claim sc join inv_vendor_claim k on k.id = sc.claim_id where sc.entity_id = $1 and sc.ticket_id = $2`, [entityId, id]),
  ]);
  const cov = OPEN.includes(t.status) ? await coverageFor(c, entityId, id) : null;
  return { ...head, events, parts, charges, visits, costs, claims, coverageSuggestion: cov,
    costTotalMinor: costs.reduce((a, x) => a + BigInt(String(x.amount_minor)), 0n).toString() };
}

/** Lookups for the screens: a customer's orders and their lines, to link a ticket to what was sold. */
export async function customerLookup(c: Client, entityId: string, term: string) {
  const s = term.trim().slice(0, 60);
  need(s.length >= 2, "type at least two letters of the name, phone or order number");
  const cu = await q<{ id: string; name: string; phone: string | null; number: string }>(c, `
    select distinct cu.id, cu.name, cu.phone, cu.number from customer cu left join sales_order so on so.customer_id = cu.id and so.entity_id = cu.entity_id
     where cu.entity_id = $1 and (cu.name ilike '%' || $2 || '%' or cu.phone like '%' || $2 || '%' or so.number ilike $2 || '%' or cu.number ilike $2)
     order by cu.name limit 15`, [entityId, s]);
  if (!cu.length) return [];
  const lines = await q<{ customer_id: string; order_id: string; number: string; ordered_at: string; line_id: string; description: string; kind: string | null; line_status: string }>(c, `
    select so.customer_id, so.id order_id, so.number, so.ordered_at::date::text ordered_at, l.id line_id, l.description, p.kind, l.line_status
      from sales_order so join sales_order_line l on l.sales_order_id = so.id and l.entity_id = so.entity_id left join product p on p.id = l.product_id
     where so.entity_id = $1 and so.customer_id = any($2) and so.status not in ('draft','cancelled') and l.qty > 0
       and coalesce(p.kind,'') in ('stock','configurable','special_order') and coalesce(so.external_ref,'') not like 'SV-%'
     order by so.ordered_at desc, l.seq limit 200`, [entityId, cu.map((x) => x.id)]);
  return cu.map((x) => ({ ...x, lines: lines.filter((l) => l.customer_id === x.id) }));
}

// ------------------------------------------------------------ dashboard --

export async function dashboard(c: Client, entityId: string) {
  const byStatus = await q<{ status: string; n: number }>(c, `select status, count(*)::int n from service_ticket where entity_id = $1 group by status`, [entityId]);
  const age = await q<{ bucket: string; n: number }>(c, `
    select case when now() - created_at < interval '3 days' then '0–2 days' when now() - created_at < interval '8 days' then '3–7 days'
                when now() - created_at < interval '15 days' then '8–14 days' else '15+ days' end bucket, count(*)::int n
      from service_ticket where entity_id = $1 and status = any($2) group by 1`, [entityId, OPEN]);
  const breached = await q(c, `
    select t.id, t.number, t.priority, t.status, t.sla_due_at, coalesce(cu.name, t.contact_name) customer
      from service_ticket t left join customer cu on cu.id = t.customer_id
     where t.entity_id = $1 and t.status = any($2) and t.sla_due_at < now() order by t.sla_due_at limit 50`, [entityId, OPEN]);
  const dueSoon = await one<{ n: number }>(c, `select count(*)::int n from service_ticket where entity_id = $1 and status = any($2)
     and sla_due_at between now() and now() + interval '24 hours'`, [entityId, OPEN]);
  // defect rate: defect and warranty tickets against units of that vendor's goods handed over in the last year
  const vendors = await q(c, `
    with sold as (
      select p.vendor_id, sum(l.qty)::float units from sales_order_line l join product p on p.id = l.product_id
        join sales_order so on so.id = l.sales_order_id
       where l.entity_id = $1 and l.line_status = 'fulfilled' and l.qty > 0 and p.kind in ('stock','configurable','special_order')
         and so.ordered_at > now() - interval '365 days' and coalesce(so.external_ref,'') not like 'SV-%' and p.vendor_id is not null
       group by p.vendor_id),
    tk as (
      select vendor_id, count(*)::int tickets, count(*) filter (where issue_type in ('defect','warranty'))::int defects
        from service_ticket where entity_id = $1 and vendor_id is not null and status <> 'cancelled' and created_at > now() - interval '365 days'
       group by vendor_id),
    cost as (
      select t.vendor_id, sum(sc.amount_minor)::bigint total, sum(sc.amount_minor) filter (where sc.charge_to = 'vendor')::bigint charged_back
        from service_cost sc join service_ticket t on t.id = sc.ticket_id where sc.entity_id = $1 group by t.vendor_id),
    cred as (
      select t.vendor_id, sum(coalesce(k.credit_minor,0))::bigint credited from service_claim scl join service_ticket t on t.id = scl.ticket_id
        join inv_vendor_claim k on k.id = scl.claim_id where scl.entity_id = $1 group by t.vendor_id)
    select v.id vendor_id, coalesce(v.dba, v.legal_name) vendor, coalesce(tk.tickets,0) tickets, coalesce(tk.defects,0) defects, coalesce(sold.units,0) units,
           case when coalesce(sold.units,0) > 0 then round((100.0 * coalesce(tk.defects,0) / sold.units)::numeric, 1)::float end defect_rate_pct,
           coalesce(cost.total,0)::text cost_minor, coalesce(cost.charged_back,0)::text charged_back_minor, coalesce(cred.credited,0)::text credited_minor
      from vendor v left join sold on sold.vendor_id = v.id left join tk on tk.vendor_id = v.id left join cost on cost.vendor_id = v.id
      left join cred on cred.vendor_id = v.id
     where (tk.tickets is not null or cost.total is not null) and exists (select 1 from vendor_entity ve where ve.vendor_id = v.id and ve.entity_id = $1)
     order by coalesce(tk.defects,0) desc, coalesce(cost.total,0) desc`, [entityId]);
  const products = await q(c, `
    select p.id, p.name, p.sku, count(*)::int tickets,
           (select coalesce(sum(l.qty),0)::float from sales_order_line l join sales_order so on so.id = l.sales_order_id
             where l.entity_id = $1 and l.product_id = p.id and l.line_status = 'fulfilled' and l.qty > 0 and coalesce(so.external_ref,'') not like 'SV-%') units
      from service_ticket t join product p on p.id = t.product_id
     where t.entity_id = $1 and t.status <> 'cancelled' group by p.id order by count(*) desc limit 10`, [entityId]);
  const ftf = await one<{ done: number; first: number }>(c, `
    with v as (
      select t.id, count(sv.id) filter (where sv.outcome <> 'not_home')::int visits,
             (array_agg(sv.outcome order by sv.completed_at) filter (where sv.outcome <> 'not_home'))[1] first_outcome
        from service_ticket t join service_visit sv on sv.ticket_id = t.id and sv.completed_at is not null and sv.kind = 'repair'
       where t.entity_id = $1 and t.status in ('resolved','closed') group by t.id)
    select count(*)::int done, count(*) filter (where visits = 1 and first_outcome in ('fixed','no_fault'))::int first from v`, [entityId]);
  const totals = await one<{ cost: string; days: number | null }>(c, `
    select coalesce((select sum(amount_minor) from service_cost where entity_id = $1 and created_at > now() - interval '30 days'),0)::text cost,
           (select round(avg(extract(epoch from resolved_at - created_at) / 86400)::numeric, 1)::float from service_ticket
             where entity_id = $1 and resolved_at is not null and resolved_at > now() - interval '90 days') days`, [entityId]);
  const open = byStatus.filter((s) => OPEN.includes(s.status)).reduce((a, s) => a + s.n, 0);
  return {
    open, byStatus, age, breached, dueSoon: dueSoon.n, vendors, products,
    firstTimeFix: { resolvedWithVisits: ftf.done, fixedFirstTime: ftf.first, pct: ftf.done ? Math.round((100 * ftf.first) / ftf.done) : null },
    cost30dMinor: totals.cost, avgDaysToResolve: totals.days,
  };
}

// ---------------------------------------------------------- warranty rules --

export async function rules(c: Client, entityId: string) {
  const [w, p] = [
    await q(c, `select r.id, r.vendor_id, coalesce(v.dba, v.legal_name) vendor, r.category, r.months, r.covers, r.note from service_warranty_rule r
            left join vendor v on v.id = r.vendor_id where r.entity_id = $1 order by r.vendor_id nulls first, r.category nulls first`, [entityId]),
    await q(c, `select id, name, phone, email, vendor_id, hourly_rate_minor::text hourly_rate_minor, categories, active from service_provider where entity_id = $1 order by name`, [entityId]),
  ];
  return { warranty: w, providers: p, plans: (await settings(c, entityId)).planTerms };
}

export async function saveRule(c: Client, scope: Scope, b: { vendorId?: string | null; category?: string | null; months: number; covers?: string[]; note?: string }) {
  const months = Math.round(Number(b.months));
  need(Number.isFinite(months) && months >= 0 && months <= 240, "a warranty is 0 to 240 months");
  const covers = (b.covers?.length ? b.covers : ["defect", "warranty"]).filter((x) => (ISSUE_TYPES as readonly string[]).includes(x));
  need(covers.length, "say what the warranty covers");
  if (b.vendorId) {
    need(isId(b.vendorId), "no such vendor");
    need((await q(c, `select 1 from vendor_entity where entity_id = $1 and vendor_id = $2`, [scope.entityId, b.vendorId])).length, "that vendor is not this company's");
  }
  const cat = String(b.category ?? "").trim() || null;
  await c.query(`
    insert into service_warranty_rule (entity_id, vendor_id, category, months, covers, note) values ($1,$2,$3,$4,$5,nullif($6,''))
    on conflict (entity_id, coalesce(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(category, ''))
    do update set months = excluded.months, covers = excluded.covers, note = excluded.note`,
    [scope.entityId, b.vendorId || null, cat, months, covers, String(b.note ?? "").trim()]);
  return { ok: true };
}

export async function saveProvider(c: Client, scope: Scope, b: { id?: string; name: string; phone?: string; email?: string; hourlyRateMinor?: bigint | null; active?: boolean; vendorId?: string | null }) {
  const name = String(b.name ?? "").trim();
  need(name, "name the service company");
  const vendorId = b.vendorId && isId(b.vendorId) ? b.vendorId : null;
  const prev = b.id && isId(b.id) ? (await q<{ vendor_id: string | null }>(c, `select vendor_id from service_provider where entity_id = $1 and id = $2`, [scope.entityId, b.id]))[0]?.vendor_id ?? null : null;
  let note: string | null = null;
  if (vendorId && vendorId !== prev) {
    // What a visit by them costs is accrued to 2050 until their bill comes, so their bills should code to 2050 and clear it.
    // Only a vendor with no usual account (or its category's usual one) is switched; one payables set by hand is left alone.
    const ve = (await q<{ gl: string | null; code: string | null; cat_gl: string | null; name: string }>(c, `
      select ve.default_gl_account_id gl, g.code, vc.default_gl_account_id cat_gl, coalesce(v.dba, v.legal_name) name
        from vendor_entity ve join vendor v on v.id = ve.vendor_id
        left join gl_account g on g.id = ve.default_gl_account_id
        left join vendor_category vc on vc.id = coalesce(ve.category_id, v.category_id)
       where ve.entity_id = $1 and ve.vendor_id = $2`, [scope.entityId, vendorId]))[0];
    need(ve, "that vendor is not set up in this company's payables");
    if (!ve.gl || ve.gl === ve.cat_gl) {
      await c.query(`update vendor_entity set default_gl_account_id = (select g.id from gl_account g join entity e on e.tenant_id = g.tenant_id
                       where e.id = $1 and g.code = '2050') where entity_id = $1 and vendor_id = $2`, [scope.entityId, vendorId]);
      await audit(c, scope, { table: "vendor_entity", rowId: vendorId, action: "update", before: { default_gl: ve.code }, after: { default_gl: "2050" },
        reason: `linked to service company ${name}: their bills clear the service costs accrued` });
    } else if (ve.code !== "2050") {
      note = `${ve.name}'s bills still code to ${ve.code}. Code the bills for service visits to 2050 so they clear what each visit accrued.`;
    }
  }
  const dup = await q(c, `select 1 from service_provider where entity_id = $1 and lower(name) = lower($2) and ($3::uuid is null or id <> $3)`,
    [scope.entityId, name, b.id && isId(b.id) ? b.id : null]);
  need(!dup.length, `there is already a service company called ${name}`);
  if (b.id) {
    need(isId(b.id), "no such service company");
    const r = await q(c, `update service_provider set name = $3, phone = nullif($4,''), email = nullif($5,''), hourly_rate_minor = $6, active = $7,
                                  vendor_id = coalesce($8, vendor_id)
                           where entity_id = $1 and id = $2 returning id`,
      [scope.entityId, b.id, name, String(b.phone ?? ""), String(b.email ?? ""), b.hourlyRateMinor?.toString() ?? null, b.active !== false, vendorId]);
    need(r.length, "no such service company");
    return { id: b.id, note };
  }
  const r = await one<{ id: string }>(c, `insert into service_provider (entity_id, name, phone, email, hourly_rate_minor, vendor_id) values ($1,$2,nullif($3,''),nullif($4,''),$5,$6) returning id`,
    [scope.entityId, name, String(b.phone ?? ""), String(b.email ?? ""), b.hourlyRateMinor?.toString() ?? null, vendorId]);
  return { id: r.id, note };
}

// ------------------------------------------------------- the public form --

export const WEB_LIMITS = { perIpHour: 5, perCompanyDay: 300 };
export const ipHash = (ip: string, entityId: string) => createHash("sha256").update(`${entityId}|${ip}`).digest("hex");

/**
 * A request from the public web form. Refuses floods (per sender per hour,
 * per company per day), honeypot hits look accepted but open nothing, and
 * a customer is linked only when the order number matches their phone,
 * email or postal code -- nothing about the match is said back.
 */
export async function webRequest(c: Client, scope: Scope, ip: string, b: Record<string, unknown>) {
  const hash = ipHash(ip, scope.entityId);
  const hits = await one<{ ip: number; day: number }>(c, `
    select (select count(*) from service_web_hit where entity_id = $1 and ip_hash = $2 and at > now() - interval '1 hour')::int ip,
           (select count(*) from service_web_hit where entity_id = $1 and at > now() - interval '1 day')::int "day"`, [scope.entityId, hash]);
  need(hits.ip < WEB_LIMITS.perIpHour, "too many requests from here; please call the store, or try again in an hour");
  need(hits.day < WEB_LIMITS.perCompanyDay, "we are getting a lot of requests right now; please call the store");
  const bot = String(b.website ?? "").trim() !== "" || (Number(b.elapsedMs ?? 99999) < 2500);
  await c.query(`insert into service_web_hit (entity_id, ip_hash, accepted) values ($1,$2,$3)`, [scope.entityId, hash, !bot]);
  if (bot) return { received: true, number: null };
  const s = (k: string, n: number) => String(b[k] ?? "").trim().slice(0, n);
  const name = s("name", 120), phone = s("phone", 40), email = s("email", 160), postal = s("postal", 10), orderNo = s("orderNumber", 30).toUpperCase();
  const desc = s("description", 2000);
  need(name.length >= 2, "please give your name");
  need(phone.replace(/\D/g, "").length >= 10 || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), "please give a phone number or an email address we can reach you on");
  need(desc.length >= 10, "please tell us what is wrong in a sentence or two");
  need((desc.match(/https?:\/\//gi) ?? []).length <= 2, "please leave links out of the description; add photos instead");
  const issue = (ISSUE_TYPES as readonly string[]).includes(String(b.issueType)) ? String(b.issueType) : "other";
  const photos = cleanPhotos(b.photos ?? [], 5);
  // link the customer only on a real match
  let customerId: string | null = null, orderId: string | null = null, addressId: string | null = null;
  if (/^[A-Z0-9-]{3,30}$/.test(orderNo)) {
    const digits = phone.replace(/\D/g, "").slice(-7);
    const m = await q<{ id: string; customer_id: string; ship_address_id: string | null }>(c, `
      select so.id, so.customer_id, so.ship_address_id from sales_order so join customer cu on cu.id = so.customer_id
       where so.entity_id = $1 and upper(so.number) = $2 and so.status not in ('draft','cancelled')
         and ((length($3) = 7 and right(regexp_replace(coalesce(cu.phone,''), '\\D', '', 'g'), 7) = $3)
              or ($4 <> '' and lower(cu.email) = lower($4))
              or ($5 <> '' and exists (select 1 from customer_address a where a.customer_id = cu.id and a.entity_id = $1 and left(a.postal,5) = left($5,5))))`,
      [scope.entityId, orderNo, digits, email, postal]);
    if (m.length) { customerId = m[0].customer_id; orderId = m[0].id; addressId = m[0].ship_address_id; }
  }
  const r = await openTicket(c, scope, { source: "web", customerId, addressId, orderId, contactName: name, contactPhone: phone, contactEmail: email,
    issueType: issue, description: desc + (orderNo && !orderId ? `\n(Order number given: ${orderNo})` : ""), photos, priority: "normal" });
  return { received: true, number: r.number };
}
