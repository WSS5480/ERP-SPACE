// Customers, leads, tasks and marketing. Owned by the crm module.
//
// The customer is the shared customer row; this file adds the profile around
// it (tags, preferences, household, consent, notes), the lead pipeline that
// turns a walk-in or a web enquiry into a quote, the salesperson's day, and
// campaigns with coupons the register and the web store redeem.
//
// Rules it keeps:
//   - consent is checked at the moment a message is made, every time: email
//     needs a standing yes (an opt-in, or the customer's marketing flag) and no
//     opt-out; a text needs an explicit opt-in. Texts wait out quiet hours.
//   - a coupon is redeemed once per order; a retry returns the first redemption.
//   - a customer merge moves every row that names the duplicate, or nothing:
//     if any table refuses, the whole merge is refused and says which.
//   - writes to other modules' tables go through their functions (POS quotes
//     through pos.createOrder); the merge is the one deliberate exception and
//     only repoints customer references, inside one transaction, with a record.

import { tzForState as stateZone, timeZoneFor, DEFAULT_TZ } from "./clock.ts";
import { today as bizToday } from "./clock.ts";
import * as messaging from "./messaging.ts";
import { randomBytes } from "node:crypto";
import { q, one, audit, type Client, type Scope } from "./db.ts";
import { createOrder, PosError } from "./pos.ts";
import { storeCreditBalance, ArError } from "./ar.ts";
import { PricingError } from "./pricing.ts";
import { projectsFor } from "./projects.ts";

export class CrmError extends Error {}
export const CRM_REFUSALS = [CrmError, PosError, ArError, PricingError];
const need = (cond: unknown, msg: string): void => { if (!cond) throw new CrmError(msg); };

const U = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s<>"]{1,64}@[^@\s<>"]{1,180}\.[^@\s<>".]{2,24}$/;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const digits = (v: unknown) => String(v ?? "").replace(/[^0-9]/g, "");
export const STAGES = ["new", "contacted", "appointment", "quoted", "won", "lost"] as const;
export const SOURCES = ["walk_in", "phone", "web_form", "quote_request", "abandoned_cart", "referral", "campaign", "other"] as const;
export const LOST_REASONS = ["price", "bought elsewhere", "no response", "timing", "out of stock / lead time", "financing declined", "other"];
export const maskPhone = (d: string) => `***-***-${digits(d).slice(-4)}`;
export const maskEmail = (e: string) => { const [u, h] = e.split("@"); return `${u.slice(0, 1)}***@${h}`; };

async function people(c: Client, entityId: string, ids: string[]): Promise<boolean> {
  if (!ids.length) return true;
  const r = await q<{ id: string }>(c, `
    select distinct u.id from app_user u join role_grant g on g.app_user_id = u.id
     where u.id = any($2::uuid[]) and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = (select tenant_id from entity where id = $1)))
       /* entity_id = $1 via the role grant */`, [entityId, ids]);
  return r.length === new Set(ids).size;
}

// =============================================================== consent --

export type Channel = "email" | "sms" | "call";
export async function recordConsent(c: Client, entityId: string, customerId: string, channel: Channel, status: "opt_in" | "opt_out",
  source: string, by: string | null = null, evidence: string | null = null) {
  need(["email", "sms", "call"].includes(channel), "Consent is for email, text or calls.");
  need(["opt_in", "opt_out"].includes(status), "Consent is a yes or a no.");
  need(clean(source, 60), "Say where the consent came from.");
  const cu = await q(c, `select 1 from customer where id = $1 and entity_id = $2`, [customerId, entityId]);
  need(cu.length, "No such customer.");
  await c.query(`insert into crm_consent (entity_id, customer_id, channel, status, source, captured_by, evidence) values ($1,$2,$3,$4,$5,$6,$7)`,
    [entityId, customerId, channel, status, clean(source, 60), by, evidence ? clean(evidence, 300) : null]);
}

export async function consentOf(c: Client, entityId: string, customerId: string) {
  const rows = await q<{ channel: Channel; status: string; source: string; captured_at: string }>(c, `
    select distinct on (channel) channel, status, source, captured_at from crm_consent
     where entity_id = $1 and customer_id = $2 order by channel, captured_at desc, id desc`, [entityId, customerId]);
  const cu = await q<{ marketing_ok: boolean }>(c, `select marketing_ok from customer where id = $1 and entity_id = $2`, [customerId, entityId]);
  const by = new Map(rows.map((r) => [r.channel, r]));
  return (["email", "sms", "call"] as Channel[]).map((ch) => {
    const r = by.get(ch);
    const implied = !r && ch === "email" && !!cu[0]?.marketing_ok;
    return { channel: ch, status: r ? r.status : implied ? "opt_in" : "unknown", source: r ? r.source : implied ? "marketing flag on the customer" : null,
      capturedAt: r?.captured_at ?? null };
  });
}

/** May this customer be sent marketing on this channel right now? */
export async function canMarket(c: Client, entityId: string, customerId: string, channel: Channel): Promise<{ ok: boolean; reason: string | null }> {
  const cs = (await consentOf(c, entityId, customerId)).find((x) => x.channel === channel)!;
  if (cs.status === "opt_out") return { ok: false, reason: `opted out of ${channel === "sms" ? "texts" : channel}` };
  if (channel === "sms" || channel === "call") return cs.status === "opt_in" ? { ok: true, reason: null } : { ok: false, reason: `no written consent to ${channel === "sms" ? "text" : "call"}` };
  return cs.status === "opt_in" ? { ok: true, reason: null } : { ok: false, reason: "never agreed to marketing email" };
}

// Quiet hours: no marketing texts before 8am or after 9pm where the customer lives.
// The zone comes from the customer's state (all 50 states and DC, clock.ts); a customer with no state on file is in the company's zone.
export const tzForState = (st: string | null | undefined, fallback = DEFAULT_TZ) => stateZone(st) ?? fallback;
function localHour(d: Date, tz: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(d));
}
/** The first moment at or after `at` outside quiet hours [start, end) in this time zone. */
export function outsideQuietHours(at: Date, tz: string, start = 21, end = 8): Date {
  const d = new Date(at.getTime());
  for (let i = 0; i < 24 * 4 + 1; i++) {
    const h = localHour(d, tz);
    const quiet = start > end ? h >= start || h < end : h >= start && h < end;
    if (!quiet) return d;
    d.setTime(d.getTime() + 15 * 60_000);
    d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 15) * 15, 0, 0);
  }
  return d;
}

// ========================================================== the profile --

async function ensureProfile(c: Client, entityId: string, customerId: string) {
  await c.query(`insert into crm_profile (customer_id, entity_id) values ($1,$2) on conflict do nothing`, [customerId, entityId]);
}

const list = (v: unknown, max = 12) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [])
  .map((x) => clean(x, 40).toLowerCase()).filter(Boolean).slice(0, max);

export async function saveProfile(c: Client, entityId: string, customerId: string, p: Record<string, unknown>) {
  need(U.test(customerId), "No such customer.");
  const cu = await q<{ id: string }>(c, `select id from customer where id = $1 and entity_id = $2`, [customerId, entityId]);
  need(cu.length, "No such customer.");
  await ensureProfile(c, entityId, customerId);
  const birthday = clean(p.birthday, 10);
  need(!birthday || /^\d{4}-\d{2}-\d{2}$/.test(birthday), "A birthday is a date (YYYY-MM-DD).");
  const pref = clean(p.preferredChannel, 10);
  need(!pref || ["email", "sms", "call"].includes(pref), "Preferred contact is email, text or call.");
  const budget = p.budgetMinor == null || p.budgetMinor === "" ? null : BigInt(String(p.budgetMinor));
  need(budget == null || budget >= 0n, "A budget cannot be negative.");
  await c.query(`update crm_profile set tags = $3, styles = $4, rooms = $5, budget_minor = $6, birthday = $7, preferred_channel = $8, updated_at = now()
                  where customer_id = $1 and entity_id = $2`,
    [customerId, entityId, list(p.tags, 20), list(p.styles), list(p.rooms), budget?.toString() ?? null, birthday || null, pref || null]);
}

export async function setHousehold(c: Client, entityId: string, customerIds: string[], name: string) {
  need(customerIds.length >= 2 && customerIds.every((x) => U.test(x)), "A household is two or more customers.");
  const n = clean(name, 80);
  need(n, "Name the household.");
  const ok = await q(c, `select id from customer where entity_id = $1 and id = any($2::uuid[])`, [entityId, customerIds]);
  need(ok.length === new Set(customerIds).size, "Every member must be one of this company's customers.");
  const h = await one<{ id: string }>(c, `insert into crm_household (entity_id, name) values ($1,$2) returning id`, [entityId, n]);
  for (const id of customerIds) {
    await ensureProfile(c, entityId, id);
    await c.query(`update crm_profile set household_id = $3, updated_at = now() where customer_id = $1 and entity_id = $2`, [id, entityId, h.id]);
  }
  return h.id;
}

export async function relate(c: Client, entityId: string, customerId: string, relatedId: string, relation: string) {
  need(U.test(customerId) && U.test(relatedId) && customerId !== relatedId, "Pick two different customers.");
  const ok = await q(c, `select id from customer where entity_id = $1 and id = any($2::uuid[])`, [entityId, [customerId, relatedId]]);
  need(ok.length === 2, "Both must be this company's customers.");
  const r = clean(relation, 40);
  need(r, "Say how they are related (spouse, designer, landlord).");
  await c.query(`insert into crm_relation (entity_id, customer_id, related_id, relation) values ($1,$2,$3,$4)
                 on conflict (customer_id, related_id) do update set relation = excluded.relation`, [entityId, customerId, relatedId, r]);
}

export async function addNote(c: Client, entityId: string, by: string | null, t: { customerId?: string | null; leadId?: string | null; body: unknown }) {
  const body = clean(t.body, 2000);
  need(body, "Write the note first.");
  need(t.customerId || t.leadId, "A note belongs to a customer or a lead.");
  if (t.customerId) need((await q(c, `select 1 from customer where id = $1 and entity_id = $2`, [t.customerId, entityId])).length, "No such customer.");
  if (t.leadId) {
    need((await q(c, `select 1 from crm_lead where id = $1 and entity_id = $2`, [t.leadId, entityId])).length, "No such lead.");
    await firstResponse(c, entityId, t.leadId);
  }
  await c.query(`insert into crm_note (entity_id, customer_id, lead_id, body, created_by) values ($1,$2,$3,$4,$5)`,
    [entityId, t.customerId ?? null, t.leadId ?? null, body, by]);
}

/** Is there a service table yet? The service module may not exist; read it if it does. */
async function serviceSource(c: Client): Promise<{ table: string; at: string; label: string | null; status: string | null } | null> {
  const cols = await q<{ table_name: string; column_name: string }>(c, `
    select table_name, column_name from information_schema.columns
     where table_schema = current_schema() and table_name like 'service%' and table_name !~ '[^a-z_]'
     /* unscoped: schema metadata, no business rows */`);
  const t = new Map<string, Set<string>>();
  for (const r of cols) { if (!t.has(r.table_name)) t.set(r.table_name, new Set()); t.get(r.table_name)!.add(r.column_name); }
  for (const [name, s] of [...t].sort((a, b) => a[0].length - b[0].length)) {
    if (!s.has("entity_id") || !s.has("customer_id")) continue;
    const at = ["opened_at", "created_at", "reported_at"].find((x) => s.has(x));
    if (!at) continue;
    return { table: name, at, label: ["number", "title", "summary", "problem"].find((x) => s.has(x)) ?? null, status: s.has("status") ? "status" : null };
  }
  return null;
}

/** Everything about one customer, from every door. */
export async function customer360(c: Client, entityId: string, customerId: string) {
  if (!U.test(customerId)) return null;
  const cu = (await q<{ id: string; number: string; name: string; email: string | null; phone: string | null; kind: string; status: string;
    home: string | null; created_at: string; marketing_ok: boolean }>(c, `
    select cu.id, cu.number, cu.name, cu.email, cu.phone, cu.kind, cu.status, l.name home, cu.created_at, cu.marketing_ok
      from customer cu left join location l on l.id = cu.home_location_id where cu.id = $1 and cu.entity_id = $2`, [customerId, entityId]))[0];
  if (!cu) return null;
  const pf = (await q(c, `select pf.tags, pf.styles, pf.rooms, pf.budget_minor, pf.birthday::text, pf.preferred_channel, pf.merged_into, h.id household_id, h.name household
      from crm_profile pf left join crm_household h on h.id = pf.household_id where pf.customer_id = $1 and pf.entity_id = $2`, [customerId, entityId]))[0] ?? null;
  const household = pf?.household_id ? await q(c, `select cu.id, cu.name, cu.number from crm_profile pf join customer cu on cu.id = pf.customer_id
      where pf.entity_id = $1 and pf.household_id = $2 and cu.id <> $3`, [entityId, pf.household_id, customerId]) : [];
  const relations = await q(c, `select r.relation, cu.id, cu.name, cu.number from crm_relation r join customer cu on cu.id = r.related_id
      where r.entity_id = $1 and r.customer_id = $2 union all
      select r.relation || ' of', cu.id, cu.name, cu.number from crm_relation r join customer cu on cu.id = r.customer_id
      where r.entity_id = $1 and r.related_id = $2`, [entityId, customerId]);
  const addresses = await q(c, `select id, label, line1, line2, city, state, postal, is_default, stairs, notes from customer_address
      where entity_id = $1 and customer_id = $2 order by is_default desc, label`, [entityId, customerId]);
  const money = (await q<{ ltv: string; last: string | null; orders: string }>(c, `
    select (select coalesce(sum(total_minor),0) from sales_order where entity_id = $1 and customer_id = $2 and status not in ('draft','cancelled'))::text ltv,
           (select max(ordered_at) from sales_order where entity_id = $1 and customer_id = $2 and status not in ('draft','cancelled'))::text last,
           (select count(*) from sales_order where entity_id = $1 and customer_id = $2 and status not in ('draft','cancelled'))::text orders`,
    [entityId, customerId]))[0];
  const quotes = await q(c, `select so.id, so.number, so.total_minor, po.quote_expires_on::text expires, so.ordered_at
      from sales_order so join pos_order po on po.sales_order_id = so.id
     where so.entity_id = $1 and so.customer_id = $2 and po.kind = 'quote' and so.status = 'draft' order by so.ordered_at desc`, [entityId, customerId]);
  let storeCredit = 0n;
  try { await c.query("savepoint crm_sc"); storeCredit = await storeCreditBalance(c, entityId, customerId); await c.query("release savepoint crm_sc"); }
  catch { await c.query("rollback to savepoint crm_sc"); }
  const timeline = await timelineOf(c, entityId, customerId);
  const leads = await q(c, `select id, number, stage, source, created_at, estimate_minor from crm_lead where entity_id = $1 and customer_id = $2 order by created_at desc`, [entityId, customerId]);
  const tasks = await q(c, `select t.id, t.kind, t.title, t.due_at, u.name assigned from crm_task t join app_user u on u.id = t.assigned_to
      where t.entity_id = $1 and t.customer_id = $2 and t.done_at is null and t.cancelled_at is null order by t.due_at`, [entityId, customerId]);
  return {
    customer: cu, profile: pf, household, relations, addresses, consent: await consentOf(c, entityId, customerId),
    lifetimeValueMinor: money.ltv, lastPurchaseAt: money.last, orderCount: Number(money.orders), openQuotes: quotes,
    storeCreditMinor: storeCredit.toString(), leads, openTasks: tasks, timeline,
    // Room projects (trade module): the customer's and their household's.
    projects: await projectsFor(c, entityId, { customerId }),
    trade: (await q(c, `select id, number, company_name, status from trade_account where entity_id = $1 and customer_id = $2`, [entityId, customerId]))[0] ?? null,
  };
}

export async function timelineOf(c: Client, entityId: string, customerId: string) {
  const rows = await q<{ at: string; kind: string; title: string; detail: string | null; amount: string | null; ref: string | null }>(c, `
    select so.ordered_at at, 'order' kind, so.number || ' · ' || so.channel title,
           (select string_agg(x.description, '; ' order by x.seq) from sales_order_line x where x.sales_order_id = so.id and x.entity_id = so.entity_id) detail,
           so.total_minor::text amount, so.status ref
      from sales_order so where so.entity_id = $1 and so.customer_id = $2
    union all
    select r.received_at, 'payment', r.number || ' · ' || r.method, r.channel || coalesce(' · ' || so.number, ''), r.amount_minor::text,
           case when r.voided_at is null then 'ok' else 'voided' end
      from customer_receipt r left join sales_order so on so.id = r.sales_order_id where r.entity_id = $1 and r.customer_id = $2
    union all
    select coalesce(d.completed_at, d.scheduled_on::timestamptz, d.created_at), 'delivery', d.number || ' · ' || d.kind, d.status, null, d.exception
      from delivery_stop d where d.entity_id = $1 and d.customer_id = $2
    union all
    select n.created_at, 'note', 'Note', n.body, null, u.name from crm_note n left join app_user u on u.id = n.created_by
     where n.entity_id = $1 and n.customer_id = $2
    union all
    select m.created_at, 'message', initcap(m.channel) || ' · ' || coalesce(cp.name, 'message'), m.status || coalesce(' (' || m.reason || ')', ''), null, m.to_ref
      from crm_message m left join crm_campaign cp on cp.id = m.campaign_id where m.entity_id = $1 and m.customer_id = $2
    union all
    select l.created_at, 'lead', l.number || ' · ' || replace(l.source, '_', ' '), l.stage || coalesce(' · ' || l.interest, ''), l.estimate_minor::text, null
      from crm_lead l where l.entity_id = $1 and l.customer_id = $2
    union all
    select t.due_at, 'task', initcap(t.kind) || ' · ' || t.title, case when t.done_at is not null then 'done' when t.cancelled_at is not null then 'cancelled' else 'open' end, null, null
      from crm_task t where t.entity_id = $1 and t.customer_id = $2
    order by 1 desc limit 300`, [entityId, customerId]);
  const svc = await serviceSource(c);
  if (svc) {
    try {
      await c.query("savepoint crm_svc");
      const s = await q<{ at: string; label: string | null; status: string | null }>(c, `
        select "${svc.at}" at, ${svc.label ? `"${svc.label}"::text` : "null"} label, ${svc.status ? `"${svc.status}"::text` : "null"} status
          from "${svc.table}" where entity_id = $1 and customer_id = $2 order by 1 desc limit 100`, [entityId, customerId]);
      await c.query("release savepoint crm_svc");
      for (const x of s) rows.push({ at: x.at, kind: "service", title: `Service${x.label ? " · " + x.label : ""}`, detail: x.status, amount: null, ref: null });
      rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    } catch { await c.query("rollback to savepoint crm_svc"); }
  }
  return rows;
}

// ============================================================ duplicates --

export async function findDuplicates(c: Client, entityId: string, p: { email?: string | null; phone?: string | null; name?: string | null; exceptId?: string | null }) {
  const email = clean(p.email, 120).toLowerCase(), phone = digits(p.phone).slice(-10), name = clean(p.name, 80).toLowerCase();
  if (!email && phone.length < 10 && !name) return [];
  return q<{ id: string; number: string; name: string; email: string | null; phone: string | null; why: string }>(c, `
    select cu.id, cu.number, cu.name, cu.email, cu.phone,
           case when $2 <> '' and lower(cu.email) = $2 then 'same email'
                when length($3) = 10 and right(regexp_replace(coalesce(cu.phone,''), '[^0-9]', '', 'g'), 10) = $3 then 'same phone'
                else 'same name' end why
      from customer cu left join crm_profile pf on pf.customer_id = cu.id
     where cu.entity_id = $1 and cu.status <> 'inactive' and pf.merged_into is null and ($5::uuid is null or cu.id <> $5)
       and (($2 <> '' and lower(cu.email) = $2)
         or (length($3) = 10 and right(regexp_replace(coalesce(cu.phone,''), '[^0-9]', '', 'g'), 10) = $3)
         or ($4 <> '' and lower(cu.name) = $4))
     order by 6, cu.name limit 10`, [entityId, email, phone, name, p.exceptId ?? null]);
}

// ================================================================= merge --

const MERGE_SKIP = new Set(["crm_profile.customer_id", "crm_profile.merged_into", "crm_merge.survivor_id", "crm_merge.merged_id",
  "crm_consent.customer_id", "crm_relation.customer_id", "crm_relation.related_id"]);

/**
 * Fold a duplicate customer into the one that stays. Every row in every
 * module that names the duplicate is repointed; consent carries over (an
 * opt-out always wins); the duplicate is kept, inactive, pointing at the
 * survivor. If any table will not take the move, nothing moves.
 */
export async function mergeCustomers(c: Client, scope: Scope, survivorId: string, mergedId: string, reason: string, by: string | null) {
  const entityId = scope.entityId;
  need(U.test(survivorId) && U.test(mergedId), "Pick the two customers to merge.");
  need(survivorId !== mergedId, "A customer cannot be merged into itself.");
  need(clean(reason, 300), "Say why these are the same person.");
  const two = await q<{ id: string; name: string; email: string | null; phone: string | null; status: string; merged_into: string | null }>(c, `
    select cu.id, cu.name, cu.email, cu.phone, cu.status, pf.merged_into from customer cu left join crm_profile pf on pf.customer_id = cu.id
     where cu.entity_id = $1 and cu.id = any($2::uuid[]) order by cu.id for update of cu`, [entityId, [survivorId, mergedId]]);
  need(two.length === 2, "Both customers must belong to this company.");
  const keep = two.find((x) => x.id === survivorId)!, gone = two.find((x) => x.id === mergedId)!;
  need(!keep.merged_into && keep.status !== "inactive", `${keep.name} is inactive or already merged; merge into the active record.`);
  need(!gone.merged_into, `${gone.name} was already merged.`);

  // Every foreign key that points at customer(id), in every module, found from the catalog so a new module is covered too.
  const refs = await q<{ tbl: string; col: string; has_entity: boolean }>(c, `
    select c.conrelid::regclass::text tbl, a.attname col,
           exists (select 1 from pg_attribute e where e.attrelid = c.conrelid and e.attname = 'entity_id' and not e.attisdropped) has_entity
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
     where c.contype = 'f' and c.confrelid = 'customer'::regclass and cardinality(c.conkey) = 1
     order by 1, 2 /* unscoped: schema catalog */`);
  const moved: Record<string, number> = {};
  // One default address per customer: the survivor's stays the default.
  await c.query(`update customer_address set is_default = false where entity_id = $2 and customer_id = $1 and is_default
      and exists (select 1 from customer_address x where x.entity_id = $2 and x.customer_id = $3 and x.is_default)`, [mergedId, entityId, survivorId]);
  for (const r of refs) {
    const key = `${r.tbl}.${r.col}`;
    if (MERGE_SKIP.has(key) || r.tbl === "customer") continue;
    if (!/^[a-z_][a-z0-9_]*$/.test(r.tbl) || !/^[a-z_][a-z0-9_]*$/.test(r.col)) throw new CrmError(`${r.tbl} cannot be checked safely; nothing was merged.`);
    await c.query("savepoint crm_merge_t");
    try {
      const where = r.has_entity ? `"${r.col}" = $1 and entity_id = $3` : `"${r.col}" = $1 /* unscoped: ${r.tbl} has no entity_id; the customer id is this entity's */`;
      const res = await c.query(`update "${r.tbl}" set "${r.col}" = $2 where ${where}`, r.has_entity ? [mergedId, survivorId, entityId] : [mergedId, survivorId]);
      await c.query("release savepoint crm_merge_t");
      if (res.rowCount) moved[key] = res.rowCount;
    } catch (e) {
      await c.query("rollback to savepoint crm_merge_t");
      const why = (e as { code?: string }).code === "23505" ? "both customers have a record there that can only exist once"
        : "that table refuses the change";
      throw new CrmError(`Can't merge: ${r.tbl.replace(/_/g, " ")} (${why}). Nothing was merged; settle that record first.`);
    }
  }
  // Relations: repoint, dropping the ones that would point at the survivor itself or repeat one it has.
  const rel = await c.query(`update crm_relation set customer_id = $2 where entity_id = $3 and customer_id = $1 and related_id <> $2
      and not exists (select 1 from crm_relation x where x.customer_id = $2 and x.related_id = crm_relation.related_id)`, [mergedId, survivorId, entityId]);
  const rel2 = await c.query(`update crm_relation set related_id = $2 where entity_id = $3 and related_id = $1 and customer_id <> $2
      and not exists (select 1 from crm_relation x where x.related_id = $2 and x.customer_id = crm_relation.customer_id)`, [mergedId, survivorId, entityId]);
  if (rel.rowCount || rel2.rowCount) moved["crm_relation"] = (rel.rowCount ?? 0) + (rel2.rowCount ?? 0);
  // Consent: an opt-out on either record stands; an opt-in carries over where the survivor has said nothing.
  const keepC = new Map((await consentOf(c, entityId, survivorId)).map((x) => [x.channel, x.status]));
  for (const g of await consentOf(c, entityId, mergedId)) {
    const k = keepC.get(g.channel);
    const carry = g.status === "opt_out" ? k !== "opt_out" : g.status === "opt_in" && g.source !== "marketing flag on the customer" ? k === "unknown" : false;
    if (!carry) continue;
    await recordConsent(c, entityId, survivorId, g.channel, g.status as "opt_in" | "opt_out", "customer merge", by, `carried from the merged record (${g.source ?? ""})`);
    moved[`consent.${g.channel}`] = 1;
  }
  // Profile: tags and preferences are combined; the duplicate's profile is kept and points at the survivor.
  await ensureProfile(c, entityId, survivorId);
  await ensureProfile(c, entityId, mergedId);
  await c.query(`update crm_profile k set tags = (select array(select distinct unnest(k.tags || g.tags))),
      styles = (select array(select distinct unnest(k.styles || g.styles))), rooms = (select array(select distinct unnest(k.rooms || g.rooms))),
      budget_minor = coalesce(k.budget_minor, g.budget_minor), birthday = coalesce(k.birthday, g.birthday),
      household_id = coalesce(k.household_id, g.household_id), updated_at = now()
      from crm_profile g where k.customer_id = $1 and g.customer_id = $2 and k.entity_id = $3 and g.entity_id = $3`, [survivorId, mergedId, entityId]);
  await c.query(`update crm_profile set merged_into = $2, updated_at = now() where customer_id = $1 and entity_id = $3`, [mergedId, survivorId, entityId]);
  // The duplicate's email and phone fill the survivor's gaps; the duplicate goes inactive.
  await c.query(`update customer set status = 'inactive', email = null where id = $1 and entity_id = $2`, [mergedId, entityId]);
  await c.query(`update customer set email = coalesce(email, $3), phone = coalesce(phone, $4) where id = $1 and entity_id = $2`,
    [survivorId, entityId, gone.email, gone.phone]);
  const m = await one<{ id: string }>(c, `insert into crm_merge (entity_id, survivor_id, merged_id, moved, reason, merged_by) values ($1,$2,$3,$4,$5,$6) returning id`,
    [entityId, survivorId, mergedId, JSON.stringify(moved), clean(reason, 300), by]);
  await audit(c, scope, { table: "customer", rowId: mergedId, action: "transition", before: { name: gone.name, email: gone.email }, after: { mergedInto: survivorId, moved }, reason: clean(reason, 300) });
  return { id: m.id, moved };
}

// ============================================================ assignment --

export async function saveRule(c: Client, entityId: string, r: { id?: string | null; name: unknown; locationId?: string | null; source?: string | null; members: string[]; active?: boolean }) {
  const name = clean(r.name, 80);
  need(name, "Name the rule.");
  need(r.members.length >= 1 && r.members.every((x) => U.test(x)), "Pick at least one salesperson.");
  need(await people(c, entityId, r.members), "Everyone in the rotation must work for this company.");
  if (r.locationId) need((await q(c, `select 1 from location where id = $1 and entity_id = $2`, [r.locationId, entityId])).length, "No such store.");
  need(!r.source || (SOURCES as readonly string[]).includes(r.source), "Unknown lead source.");
  if (r.id) {
    const u = await q(c, `update crm_assignment_rule set name = $3, location_id = $4, source = $5, members = $6, active = $7, next_index = 0
      where id = $1 and entity_id = $2 returning id`, [r.id, entityId, name, r.locationId ?? null, r.source ?? null, r.members, r.active !== false]);
    need(u.length, "No such rule.");
    return r.id;
  }
  return (await one<{ id: string }>(c, `insert into crm_assignment_rule (entity_id, name, location_id, source, members) values ($1,$2,$3,$4,$5) returning id`,
    [entityId, name, r.locationId ?? null, r.source ?? null, r.members])).id;
}

/** Round-robin: the most specific active rule (store and source, then store, then source, then any) hands out the next person in turn. */
export async function nextAssignee(c: Client, entityId: string, locationId: string | null, source: string): Promise<string | null> {
  const r = (await q<{ id: string; members: string[]; next_index: number }>(c, `
    select id, members, next_index from crm_assignment_rule
     where entity_id = $1 and active and (location_id is null or location_id = $2) and (source is null or source = $3)
     order by (location_id is not null)::int + (source is not null)::int desc, created_at limit 1 for update`, [entityId, locationId, source]))[0];
  if (!r) return null;
  const who = r.members[r.next_index % r.members.length];
  await c.query(`update crm_assignment_rule set next_index = $3 where id = $1 and entity_id = $2`, [r.id, entityId, (r.next_index + 1) % r.members.length]);
  return who;
}

// ================================================================= leads --

const FOLLOW_UP_HOURS: Record<string, number> = { new: 1, contacted: 48, appointment: 24, quoted: 72 };

async function leadEvent(c: Client, entityId: string, leadId: string, kind: string, detail: string | null, by: string | null) {
  await c.query(`insert into crm_lead_event (entity_id, lead_id, kind, detail, by_user) values ($1,$2,$3,$4,$5)`, [entityId, leadId, kind, detail, by]);
}
async function firstResponse(c: Client, entityId: string, leadId: string) {
  await c.query(`update crm_lead set first_response_at = coalesce(first_response_at, now()) where id = $1 and entity_id = $2`, [leadId, entityId]);
}

/** The follow-up a lead's stage calls for: one open auto task at a time, due by the stage's clock. */
async function autoFollowUp(c: Client, entityId: string, leadId: string) {
  const l = (await q<{ stage: string; assigned_to: string | null; name: string; customer_id: string | null; phone: string | null }>(c,
    `select stage, assigned_to, name, customer_id, phone from crm_lead where id = $1 and entity_id = $2`, [leadId, entityId]))[0];
  await c.query(`update crm_task set cancelled_at = now(), outcome = 'replaced by the next follow-up' where entity_id = $1 and lead_id = $2 and auto and done_at is null and cancelled_at is null`, [entityId, leadId]);
  const hours = FOLLOW_UP_HOURS[l.stage];
  if (!l.assigned_to || hours == null) { await c.query(`update crm_lead set next_follow_up_at = null where id = $1 and entity_id = $2`, [leadId, entityId]); return; }
  const due = new Date(Date.now() + hours * 3600_000);
  const kind = l.stage === "new" ? (l.phone ? "call" : "email") : l.stage === "quoted" ? "call" : "text";
  const title = l.stage === "new" ? `First contact: ${l.name}` : l.stage === "quoted" ? `Follow up on the quote: ${l.name}` : `Check in: ${l.name}`;
  await c.query(`insert into crm_task (entity_id, assigned_to, kind, title, due_at, customer_id, lead_id, auto) values ($1,$2,$3,$4,$5,$6,$7,true)`,
    [entityId, l.assigned_to, kind, title, due, l.customer_id, leadId]);
  await c.query(`update crm_lead set next_follow_up_at = $3 where id = $1 and entity_id = $2`, [leadId, entityId, due]);
}

export type LeadIn = {
  source: string; name: unknown; email?: unknown; phone?: unknown; interest?: unknown; locationId?: string | null; assignedTo?: string | null;
  utmSource?: unknown; utmMedium?: unknown; utmCampaign?: unknown; campaignId?: string | null; referredBy?: string | null;
  items?: { productId: string; choices?: unknown; qty?: number }[]; estimateMinor?: bigint; externalRef?: string | null; customerId?: string | null;
  consent?: { email?: boolean; sms?: boolean; source?: string };
};

export async function createLead(c: Client, entityId: string, by: string | null, l: LeadIn) {
  need((SOURCES as readonly string[]).includes(l.source), "Unknown lead source.");
  const name = clean(l.name, 80);
  need(name.length >= 1, "Give the lead a name.");
  const email = clean(l.email, 120).toLowerCase() || null;
  need(!email || EMAIL.test(email), "That email address doesn't look right.");
  const ph = digits(l.phone);
  need(!ph || (ph.length >= 10 && ph.length <= 15), "A phone number needs its area code.");
  need(email || ph || ["walk_in", "referral"].includes(l.source), "A lead needs an email or a phone number to follow up on.");
  if (l.locationId) need((await q(c, `select 1 from location where id = $1 and entity_id = $2`, [l.locationId, entityId])).length, "No such store.");
  if (l.assignedTo) need(await people(c, entityId, [l.assignedTo]), "That salesperson does not work for this company.");
  if (l.customerId) need((await q(c, `select 1 from customer where id = $1 and entity_id = $2`, [l.customerId, entityId])).length, "No such customer.");
  if (l.campaignId) need((await q(c, `select 1 from crm_campaign where id = $1 and entity_id = $2`, [l.campaignId, entityId])).length, "No such campaign.");
  if (l.referredBy) need((await q(c, `select 1 from customer where id = $1 and entity_id = $2`, [l.referredBy, entityId])).length, "No such referring customer.");
  const items = (l.items ?? []).slice(0, 20).filter((x) => x && U.test(String(x.productId)))
    .map((x) => ({ productId: x.productId, choices: Array.isArray(x.choices) ? x.choices : [], qty: Math.max(1, Math.min(20, Math.trunc(Number(x.qty ?? 1)) || 1)) }));
  if (items.length) {
    const ok = await q(c, `select id from product where entity_id = $1 and id = any($2::uuid[])`, [entityId, items.map((x) => x.productId)]);
    need(ok.length === new Set(items.map((x) => x.productId)).size, "An item on the lead is not one of this company's products.");
  }
  if (l.externalRef) {
    const prior = await q<{ id: string; number: string }>(c, `select id, number from crm_lead where entity_id = $1 and external_ref = $2`, [entityId, l.externalRef]);
    if (prior[0]) return { id: prior[0].id, number: prior[0].number, duplicate: true, matches: [] };
  }
  // Duplicate detection: a sure match (email or phone) links the customer; a name-only match is flagged for a person to confirm.
  const matches = l.customerId ? [] : await findDuplicates(c, entityId, { email, phone: ph, name });
  const sure = l.customerId ?? matches.find((m) => m.why !== "same name")?.id ?? null;
  const maybe = sure ? null : matches[0]?.id ?? null;
  const assignee = l.assignedTo ?? await nextAssignee(c, entityId, l.locationId ?? null, l.source);
  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'lead', 'L-') n /* unscoped: numbering function takes the entity */`, [entityId])).n;
  const lead = await one<{ id: string }>(c, `
    insert into crm_lead (entity_id, number, source, utm_source, utm_medium, utm_campaign, campaign_id, referred_by, name, email, phone, interest, items,
                          estimate_minor, customer_id, duplicate_of, location_id, assigned_to, external_ref, created_by, consent)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning id`,
    [entityId, number, l.source, clean(l.utmSource, 60) || null, clean(l.utmMedium, 60) || null, clean(l.utmCampaign, 80) || null, l.campaignId ?? null,
     l.referredBy ?? null, name, email, ph || null, clean(l.interest, 500) || null, JSON.stringify(items), (l.estimateMinor ?? 0n).toString(),
     sure, maybe, l.locationId ?? null, assignee, l.externalRef ?? null, by,
     JSON.stringify({ ...(l.consent?.email && email ? { email: "opt_in" } : {}), ...(l.consent?.sms && ph ? { sms: "opt_in" } : {}), ...(l.consent?.source ? { source: l.consent.source } : {}) })]);
  // Consent given on the form goes on the customer straight away when the customer is known.
  if (sure) await applyLeadConsent(c, entityId, lead.id, sure);
  await leadEvent(c, entityId, lead.id, "created", `${l.source.replace(/_/g, " ")}${assignee ? "" : ", nobody assigned yet"}`, by);
  if (assignee) await leadEvent(c, entityId, lead.id, "assigned", assignee, by);
  await autoFollowUp(c, entityId, lead.id);
  return { id: lead.id, number, duplicate: false, matches };
}

async function applyLeadConsent(c: Client, entityId: string, leadId: string, customerId: string) {
  const l = (await q<{ consent: { email?: string; sms?: string; source?: string }; created_at: string; number: string }>(c,
    `select consent, created_at::text, number from crm_lead where id = $1 and entity_id = $2`, [leadId, entityId]))[0];
  for (const ch of ["email", "sms"] as Channel[]) {
    if (l.consent[ch] !== "opt_in") continue;
    const cur = (await consentOf(c, entityId, customerId)).find((x) => x.channel === ch)!;
    if (cur.status === "opt_out" && cur.capturedAt && cur.capturedAt > l.created_at) continue;   // a later no stands
    if (cur.status === "opt_in" && cur.source !== "marketing flag on the customer") continue;
    await recordConsent(c, entityId, customerId, ch, "opt_in", l.consent.source ?? "lead form", null, `lead ${l.number}, ${l.created_at.slice(0, 16)}`);
  }
}

async function leadOf(c: Client, entityId: string, id: string) {
  need(U.test(id), "No such lead.");
  const l = (await q<{ id: string; number: string; stage: string; name: string; email: string | null; phone: string | null; customer_id: string | null;
    location_id: string | null; assigned_to: string | null; items: { productId: string; choices: unknown[]; qty: number }[]; sales_order_id: string | null;
    duplicate_of: string | null; campaign_id: string | null }>(c,
    `select id, number, stage, name, email, phone, customer_id, location_id, assigned_to, items, sales_order_id, duplicate_of, campaign_id
       from crm_lead where id = $1 and entity_id = $2 for update`, [id, entityId]))[0];
  need(l, "No such lead.");
  return l!;
}

export async function moveLead(c: Client, entityId: string, by: string | null, id: string, stage: string, opts: { lostReason?: unknown; followUpAt?: string | null } = {}) {
  need((STAGES as readonly string[]).includes(stage), "Unknown stage.");
  const l = await leadOf(c, entityId, id);
  need(!["won", "lost"].includes(l.stage) || stage === l.stage, `${l.number} is closed as ${l.stage}; reopen it as a new lead.`);
  const lost = clean(opts.lostReason, 120);
  if (stage === "lost") need(lost, "Say why the lead was lost.");
  if (stage === "won") need(l.sales_order_id || l.customer_id, "A lead is won by a sale: convert it, or link the order.");
  await c.query(`update crm_lead set stage = $3, lost_reason = $4, won_at = case when $3 = 'won' then now() else won_at end,
      lost_at = case when $3 = 'lost' then now() else lost_at end, updated_at = now() where id = $1 and entity_id = $2`,
    [id, entityId, stage, stage === "lost" ? lost : null]);
  if (stage !== "new") await firstResponse(c, entityId, id);
  await leadEvent(c, entityId, id, "stage", stage + (stage === "lost" ? ` (${lost})` : ""), by);
  await autoFollowUp(c, entityId, id);
  if (opts.followUpAt) {
    const d = new Date(opts.followUpAt);
    need(!isNaN(d.getTime()), "The follow-up date is not a date.");
    await c.query(`update crm_task set due_at = $3 where entity_id = $1 and lead_id = $2 and auto and done_at is null and cancelled_at is null`, [entityId, id, d]);
    await c.query(`update crm_lead set next_follow_up_at = $3 where id = $1 and entity_id = $2`, [id, entityId, d]);
  }
}

export async function assignLead(c: Client, entityId: string, by: string | null, id: string, to: string) {
  const l = await leadOf(c, entityId, id);
  need(U.test(to) && await people(c, entityId, [to]), "That salesperson does not work for this company.");
  await c.query(`update crm_lead set assigned_to = $3, updated_at = now() where id = $1 and entity_id = $2`, [id, entityId, to]);
  await c.query(`update crm_task set assigned_to = $3 where entity_id = $1 and lead_id = $2 and done_at is null and cancelled_at is null`, [entityId, id, to]);
  await leadEvent(c, entityId, l.id, "assigned", to, by);
}

async function newCustomerNumber(c: Client, entityId: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const n = (await one<{ n: string }>(c, `select next_doc_no($1, 'customer', 'C-') n /* unscoped: numbering function takes the entity */`, [entityId])).n;
    if (!(await q(c, `select 1 from customer where entity_id = $1 and number = $2`, [entityId, n])).length) return n;
  }
  throw new CrmError("Could not find a free customer number.");
}

/**
 * One tap: the lead becomes a customer (the matched one, or a new record),
 * and, if it names what they want, a POS quote at its store priced by the
 * register's own rules. Consent given on the lead travels with it.
 */
export async function convertLead(c: Client, scope: Scope, roles: Set<string>, id: string, opts: { locationId?: string | null; useCustomerId?: string | null } = {}) {
  const entityId = scope.entityId;
  const l = await leadOf(c, entityId, id);
  need(!["won", "lost"].includes(l.stage), `${l.number} is already ${l.stage}.`);
  need(!l.sales_order_id, `${l.number} already has a quote.`);
  let customerId = opts.useCustomerId ?? l.customer_id;
  if (customerId) need((await q(c, `select 1 from customer where id = $1 and entity_id = $2 and status <> 'inactive'`, [customerId, entityId])).length, "No such active customer.");
  let created = false;
  if (!customerId) {
    const sure = (await findDuplicates(c, entityId, { email: l.email, phone: l.phone })).find((m) => m.why !== "same name");
    if (sure) customerId = sure.id;
    else {
      const num = await newCustomerNumber(c, entityId);
      customerId = (await one<{ id: string }>(c, `insert into customer (entity_id, number, name, email, phone, home_location_id) values ($1,$2,$3,$4,$5,$6) returning id`,
        [entityId, num, l.name, l.email, l.phone, opts.locationId ?? l.location_id])).id;
      created = true;
    }
  }
  await c.query(`update crm_lead set customer_id = $3, duplicate_of = null, updated_at = now() where id = $1 and entity_id = $2`, [id, entityId, customerId]);
  await applyLeadConsent(c, entityId, id, customerId!);
  let quote: { id: string; number: string } | null = null;
  const store = opts.locationId ?? l.location_id;
  if (l.items.length) {
    need(store, "Pick the store the quote is from.");
    // No address on file yet: quote it for pickup at the store; the salesperson switches it to delivery once they have one.
    const hasAddr = (await q(c, `select 1 from customer_address where entity_id = $1 and customer_id = $2 limit 1`, [entityId, customerId])).length > 0;
    const r = await createOrder(c, scope, roles, { kind: "quote", locationId: store!, customerId: customerId!,
      lines: l.items.map((x) => ({ productId: x.productId, qty: x.qty, choices: x.choices as never, ...(hasAddr ? {} : { fulfillment: "pickup" as const }) })),
      notes: `From lead ${l.number}` });
    quote = { id: r.id, number: r.number };
    await c.query(`update crm_lead set sales_order_id = $3, stage = 'quoted', updated_at = now(),
        estimate_minor = (select total_minor from sales_order where id = $3 and entity_id = $2) where id = $1 and entity_id = $2`, [id, entityId, r.id]);
  } else {
    await c.query(`update crm_lead set stage = case when stage = 'new' then 'contacted' else stage end, updated_at = now() where id = $1 and entity_id = $2`, [id, entityId]);
  }
  await firstResponse(c, entityId, id);
  await leadEvent(c, entityId, id, "converted", `${created ? "new customer" : "existing customer"}${quote ? `, quote ${quote.number}` : ""}`, scope.actor.id ?? null);
  await autoFollowUp(c, entityId, id);
  return { customerId: customerId!, createdCustomer: created, quote };
}

export async function linkOrder(c: Client, entityId: string, by: string | null, id: string, orderNumber: string) {
  const l = await leadOf(c, entityId, id);
  const so = (await q<{ id: string; customer_id: string | null }>(c, `select id, customer_id from sales_order where entity_id = $1 and upper(number) = upper($2)`,
    [entityId, clean(orderNumber, 30)]))[0];
  need(so, "No order with that number.");
  await c.query(`update crm_lead set sales_order_id = $3, customer_id = coalesce(customer_id, $4), updated_at = now() where id = $1 and entity_id = $2`, [id, entityId, so.id, so.customer_id]);
  await leadEvent(c, entityId, l.id, "linked", orderNumber, by);
  await syncLeadOutcomes(c, entityId);
}

/** A lead is won when its order is paid in full or handed over; lost when its quote is cancelled. */
export async function syncLeadOutcomes(c: Client, entityId: string) {
  const won = await q<{ id: string }>(c, `
    update crm_lead l set stage = 'won', won_at = now(), next_follow_up_at = null, updated_at = now()
      from sales_order so
     where l.entity_id = $1 and so.entity_id = $1 and so.id = l.sales_order_id and l.stage not in ('won','lost')
       and so.status <> 'cancelled' and so.total_minor > 0
       and (so.status in ('fulfilled','closed') or so.paid_minor >= so.total_minor)
     returning l.id`, [entityId]);
  for (const w of won) {
    await leadEvent(c, entityId, w.id, "stage", "won (order paid or delivered)", null);
    await c.query(`update crm_task set cancelled_at = now(), outcome = 'lead won' where entity_id = $1 and lead_id = $2 and auto and done_at is null and cancelled_at is null`, [entityId, w.id]);
  }
  const lost = await q<{ id: string }>(c, `
    update crm_lead l set stage = 'lost', lost_reason = 'order cancelled', lost_at = now(), next_follow_up_at = null, updated_at = now()
      from sales_order so where l.entity_id = $1 and so.entity_id = $1 and so.id = l.sales_order_id and l.stage not in ('won','lost') and so.status = 'cancelled'
     returning l.id`, [entityId]);
  for (const w of lost) await leadEvent(c, entityId, w.id, "stage", "lost (order cancelled)", null);
  return { won: won.length, lost: lost.length };
}

/** Carts left on the web store with an email become leads, once each. */
export async function captureAbandonedCarts(c: Client, entityId: string, olderThanMinutes = 120) {
  const has = (await q<{ t: string | null }>(c, `select to_regclass('shop_cart')::text t /* unscoped: is the web store installed */`))[0]?.t;
  if (!has) return 0;
  const carts = await q<{ site_id: string; id: string; email: string; lines: { productId: string; qty: number; choices?: unknown[]; name?: string }[]; subtotal_minor: string }>(c, `
    select k.site_id, k.id, k.email, k.lines, k.subtotal_minor from shop_cart k
     where k.entity_id = $1 and k.sales_order_id is null and k.item_count > 0 and k.email is not null
       and k.updated_at < now() - make_interval(mins => $2)
       and not exists (select 1 from crm_lead l where l.entity_id = $1 and l.external_ref = 'cart:' || k.site_id || ':' || k.id)
     order by k.updated_at limit 100`, [entityId, olderThanMinutes]);
  let n = 0;
  for (const k of carts) {
    await createLead(c, entityId, null, { source: "abandoned_cart", name: k.email.split("@")[0], email: k.email,
      interest: k.lines.map((x) => `${x.qty} × ${x.name ?? "item"}`).join(", ").slice(0, 500),
      items: k.lines.map((x) => ({ productId: x.productId, qty: x.qty, choices: x.choices ?? [] })), estimateMinor: BigInt(k.subtotal_minor),
      externalRef: `cart:${k.site_id}:${k.id}`, utmSource: "web store", utmMedium: "abandoned cart" });
    n++;
  }
  return n;
}

export async function leads(c: Client, entityId: string, f: { stage?: string; assignedTo?: string | null; locationId?: string | null; q?: string; mine?: string | null }) {
  const s = `%${(f.q ?? "").replace(/[%_\\]/g, "")}%`;
  return q(c, `
    select l.id, l.number, l.stage, l.source, l.name, l.email, l.phone, l.interest, l.estimate_minor, l.next_follow_up_at, l.created_at, l.first_response_at,
           l.lost_reason, l.utm_source, l.utm_medium, l.utm_campaign, l.customer_id, l.duplicate_of, l.sales_order_id, so.number order_number,
           u.name assigned, l.assigned_to, loc.name store, cp.name campaign, dup.name duplicate_name
      from crm_lead l left join app_user u on u.id = l.assigned_to left join location loc on loc.id = l.location_id
      left join crm_campaign cp on cp.id = l.campaign_id left join sales_order so on so.id = l.sales_order_id
      left join customer dup on dup.id = l.duplicate_of
     where l.entity_id = $1 and ($2 = '' or l.stage = $2) and ($3::uuid is null or l.assigned_to = $3) and ($4::uuid is null or l.location_id = $4)
       and ($5 = '%%' or l.name ilike $5 or l.email ilike $5 or l.phone ilike $5 or l.number ilike $5 or l.interest ilike $5)
     order by case l.stage when 'new' then 0 when 'contacted' then 1 when 'appointment' then 2 when 'quoted' then 3 else 4 end,
              l.next_follow_up_at nulls last, l.created_at desc limit 300`,
    [entityId, f.stage ?? "", f.assignedTo ?? f.mine ?? null, f.locationId ?? null, s]);
}

export async function leadDetail(c: Client, entityId: string, id: string) {
  if (!U.test(id)) return null;
  const l = (await leads(c, entityId, {})).find((x) => x.id === id) ?? (await q(c, `select * from crm_lead where id = $1 and entity_id = $2`, [id, entityId]))[0];
  if (!l) return null;
  const events = await q(c, `select e.kind, e.detail, e.at, u.name by_name, au.name assignee from crm_lead_event e left join app_user u on u.id = e.by_user
      left join app_user au on e.kind = 'assigned' and au.id::text = e.detail where e.entity_id = $1 and e.lead_id = $2 order by e.at`, [entityId, id]);
  const notes = await q(c, `select n.body, n.created_at, u.name by_name from crm_note n left join app_user u on u.id = n.created_by where n.entity_id = $1 and n.lead_id = $2 order by n.created_at desc`, [entityId, id]);
  const tasks = await q(c, `select id, kind, title, due_at, done_at, cancelled_at, auto from crm_task where entity_id = $1 and lead_id = $2 order by due_at desc`, [entityId, id]);
  const items = (await q<{ items: { productId: string; qty: number }[] }>(c, `select items from crm_lead where id = $1 and entity_id = $2`, [id, entityId]))[0].items;
  const names = items.length ? await q<{ id: string; name: string; price_minor: string }>(c, `select id, name, price_minor from product where entity_id = $1 and id = any($2::uuid[])`, [entityId, items.map((x) => x.productId)]) : [];
  return { lead: l, events, notes, tasks, items: items.map((x) => ({ ...x, name: names.find((n) => n.id === x.productId)?.name ?? "product" })),
    matches: await findDuplicates(c, entityId, { email: l.email as string, phone: l.phone as string, name: l.name as string, exceptId: l.customer_id as string | null }) };
}

// ================================================================= tasks --

export type TaskIn = { assignedTo: string; kind: string; title: unknown; dueAt: string; endsAt?: string | null; locationId?: string | null;
  customerId?: string | null; leadId?: string | null; notes?: unknown };

export async function createTask(c: Client, entityId: string, by: string | null, t: TaskIn) {
  need(["call", "text", "email", "appointment", "todo"].includes(t.kind), "A task is a call, text, email, appointment or to-do.");
  const title = clean(t.title, 140);
  need(title, "Say what the task is.");
  need(U.test(t.assignedTo) && await people(c, entityId, [t.assignedTo]), "Assign it to someone who works here.");
  const due = new Date(t.dueAt);
  need(!isNaN(due.getTime()), "When is it due?");
  if (t.customerId) need((await q(c, `select 1 from customer where id = $1 and entity_id = $2`, [t.customerId, entityId])).length, "No such customer.");
  if (t.leadId) need((await q(c, `select 1 from crm_lead where id = $1 and entity_id = $2`, [t.leadId, entityId])).length, "No such lead.");
  let ends: Date | null = null;
  if (t.kind === "appointment") {
    ends = t.endsAt ? new Date(t.endsAt) : new Date(due.getTime() + 60 * 60_000);
    need(!isNaN(ends.getTime()) && ends > due, "An appointment ends after it starts.");
    need(t.locationId && (await q(c, `select 1 from location where id = $1 and entity_id = $2 and kind in ('store','outlet')`, [t.locationId, entityId])).length,
      "Pick the showroom for the consultation.");
    need(due.getTime() > Date.now() - 5 * 60_000, "That time has passed.");
    const clash = await q<{ title: string }>(c, `select title from crm_task where entity_id = $1 and assigned_to = $2 and kind = 'appointment'
        and done_at is null and cancelled_at is null and tstzrange(due_at, ends_at) && tstzrange($3, $4)`, [entityId, t.assignedTo, due, ends]);
    need(!clash.length, `That time overlaps another appointment (${clash[0]?.title}).`);
  }
  const r = await one<{ id: string }>(c, `insert into crm_task (entity_id, assigned_to, kind, title, notes, due_at, ends_at, location_id, customer_id, lead_id, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [entityId, t.assignedTo, t.kind, title, clean(t.notes, 1000) || null, due, ends, t.kind === "appointment" ? t.locationId : null, t.customerId ?? null, t.leadId ?? null, by]);
  if (t.leadId && t.kind === "appointment") {
    await c.query(`update crm_lead set stage = case when stage in ('new','contacted') then 'appointment' else stage end, updated_at = now() where id = $1 and entity_id = $2`, [t.leadId, entityId]);
    await firstResponse(c, entityId, t.leadId);
    await leadEvent(c, entityId, t.leadId, "stage", `appointment booked`, by);
  }
  return r.id;
}

export async function completeTask(c: Client, entityId: string, by: string | null, id: string, outcome: unknown, cancel = false) {
  need(U.test(id), "No such task.");
  const t = (await q<{ lead_id: string | null; done_at: string | null; cancelled_at: string | null }>(c,
    `select lead_id, done_at, cancelled_at from crm_task where id = $1 and entity_id = $2 for update`, [id, entityId]))[0];
  need(t, "No such task.");
  need(!t.done_at && !t.cancelled_at, "That task is already closed.");
  await c.query(cancel ? `update crm_task set cancelled_at = now(), outcome = $3 where id = $1 and entity_id = $2`
    : `update crm_task set done_at = now(), done_by = $4, outcome = $3 where id = $1 and entity_id = $2`, cancel ? [id, entityId, clean(outcome, 300) || null] : [id, entityId, clean(outcome, 300) || null, by]);
  if (t.lead_id && !cancel) {
    await firstResponse(c, entityId, t.lead_id);
    await c.query(`update crm_lead set stage = 'contacted', updated_at = now() where id = $1 and entity_id = $2 and stage = 'new'`, [t.lead_id, entityId]);
    // A done auto follow-up makes the next one, so a lead never sits without a next step.
    const open = await q(c, `select 1 from crm_task where entity_id = $1 and lead_id = $2 and done_at is null and cancelled_at is null`, [entityId, t.lead_id]);
    if (!open.length) await autoFollowUp(c, entityId, t.lead_id);
  }
}

/** One salesperson's day: overdue first, then today, then appointments ahead. */
export async function myDay(c: Client, entityId: string, personId: string) {
  const tasks = await q(c, `
    select t.id, t.kind, t.title, t.notes, t.due_at, t.ends_at, t.auto, loc.name store, cu.id customer_id, cu.name customer, cu.phone customer_phone,
           l.id lead_id, l.number lead_number, l.name lead_name, l.phone lead_phone, l.email lead_email,
           (t.due_at < now()) overdue
      from crm_task t left join customer cu on cu.id = t.customer_id left join crm_lead l on l.id = t.lead_id left join location loc on loc.id = t.location_id
     where t.entity_id = $1 and t.assigned_to = $2 and t.done_at is null and t.cancelled_at is null and t.due_at < date_trunc('day', now()) + interval '8 days'
     order by t.due_at limit 200`, [entityId, personId]);
  const counts = (await q<{ overdue: string; today: string; leads: string }>(c, `
    select count(*) filter (where t.due_at < now())::text overdue,
           count(*) filter (where t.due_at >= now() and t.due_at < date_trunc('day', now()) + interval '1 day')::text today,
           (select count(*) from crm_lead l where l.entity_id = $1 and l.assigned_to = $2 and l.stage not in ('won','lost'))::text leads
      from crm_task t where t.entity_id = $1 and t.assigned_to = $2 and t.done_at is null and t.cancelled_at is null`, [entityId, personId]))[0];
  return { tasks, overdue: Number(counts.overdue), today: Number(counts.today), openLeads: Number(counts.leads) };
}

/** Everyone's overdue work, for a manager. */
export async function overdue(c: Client, entityId: string) {
  return q(c, `select u.name, t.assigned_to, count(*)::int n, min(t.due_at) oldest from crm_task t join app_user u on u.id = t.assigned_to
     where t.entity_id = $1 and t.done_at is null and t.cancelled_at is null and t.due_at < now() group by u.name, t.assigned_to order by n desc`, [entityId]);
}

// ============================================================== segments --

export type SegmentFilter = {
  boughtCategory?: string; boughtSubcategory?: string; monthsAgoMin?: number; monthsAgoMax?: number; hasProtectionPlan?: boolean;
  locationId?: string; minSpendMinor?: string; lapsedMonths?: number; birthdayMonth?: number; abandonedCart?: boolean; tag?: string;
};

export function parseFilter(v: unknown): SegmentFilter {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const n = (x: unknown, lo: number, hi: number) => { if (x === "" || x == null) return undefined; const k = Math.trunc(Number(x)); need(Number.isFinite(k) && k >= lo && k <= hi, `A number in the filter is out of range (${lo}–${hi}).`); return k; };
  const f: SegmentFilter = {};
  if (clean(o.boughtCategory, 80)) f.boughtCategory = clean(o.boughtCategory, 80);
  if (clean(o.boughtSubcategory, 80)) f.boughtSubcategory = clean(o.boughtSubcategory, 80);
  f.monthsAgoMin = n(o.monthsAgoMin, 0, 240); f.monthsAgoMax = n(o.monthsAgoMax, 0, 240);
  if (f.monthsAgoMin != null && f.monthsAgoMax != null) need(f.monthsAgoMax >= f.monthsAgoMin, "The purchase window ends before it starts.");
  if (o.hasProtectionPlan === true) f.hasProtectionPlan = true;
  if (typeof o.locationId === "string" && U.test(o.locationId)) f.locationId = o.locationId;
  if (o.minSpendMinor != null && o.minSpendMinor !== "") { need(/^\d{1,12}$/.test(String(o.minSpendMinor)), "Minimum spend is an amount."); f.minSpendMinor = String(o.minSpendMinor); }
  f.lapsedMonths = n(o.lapsedMonths, 1, 240); f.birthdayMonth = n(o.birthdayMonth, 0, 12);
  if (o.abandonedCart === true) f.abandonedCart = true;
  if (clean(o.tag, 40)) f.tag = clean(o.tag, 40).toLowerCase();
  for (const k of Object.keys(f) as (keyof SegmentFilter)[]) if (f[k] === undefined) delete f[k];
  return f;
}

/** The SQL behind a saved filter: customers of this company, active, not merged away. */
async function segmentSql(c: Client, entityId: string, f: SegmentFilter): Promise<{ sql: string; args: unknown[] }> {
  const args: unknown[] = [entityId];
  const p = (v: unknown) => { args.push(v); return `$${args.length}`; };
  const w = [`cu.entity_id = $1`, `cu.status <> 'inactive'`, `pf.merged_into is null`];
  const bought: string[] = [];
  if (f.boughtCategory) bought.push(`p.category = ${p(f.boughtCategory)}`);
  if (f.boughtSubcategory) bought.push(`p.subcategory = ${p(f.boughtSubcategory)}`);
  if (f.monthsAgoMin != null) bought.push(`so.ordered_at <= now() - make_interval(months => ${p(f.monthsAgoMin)})`);
  if (f.monthsAgoMax != null) bought.push(`so.ordered_at >= now() - make_interval(months => ${p(f.monthsAgoMax)})`);
  if (bought.length) w.push(`exists (select 1 from sales_order so join sales_order_line sl on sl.sales_order_id = so.id and sl.entity_id = so.entity_id
      join product p on p.id = sl.product_id where so.entity_id = $1 and so.customer_id = cu.id and so.status not in ('draft','cancelled') and sl.qty > 0 and ${bought.join(" and ")})`);
  if (f.hasProtectionPlan) w.push(`exists (select 1 from sales_order so join sales_order_line sl on sl.sales_order_id = so.id and sl.entity_id = so.entity_id
      join product p on p.id = sl.product_id where so.entity_id = $1 and so.customer_id = cu.id and so.status not in ('draft','cancelled') and p.kind = 'warranty' and sl.qty > 0)`);
  if (f.locationId) { const x = p(f.locationId); w.push(`(cu.home_location_id = ${x} or exists (select 1 from sales_order so where so.entity_id = $1 and so.customer_id = cu.id and so.location_id = ${x}))`); }
  if (f.minSpendMinor) w.push(`(select coalesce(sum(so.total_minor),0) from sales_order so where so.entity_id = $1 and so.customer_id = cu.id and so.status not in ('draft','cancelled')) >= ${p(f.minSpendMinor)}::bigint`);
  if (f.lapsedMonths) w.push(`exists (select 1 from sales_order so where so.entity_id = $1 and so.customer_id = cu.id and so.status not in ('draft','cancelled'))
      and not exists (select 1 from sales_order so where so.entity_id = $1 and so.customer_id = cu.id and so.status not in ('draft','cancelled')
                        and so.ordered_at >= now() - make_interval(months => ${p(f.lapsedMonths)}))`);
  if (f.birthdayMonth != null) w.push(`extract(month from pf.birthday) = ${f.birthdayMonth === 0 ? "extract(month from now())" : p(f.birthdayMonth)}`);
  if (f.tag) w.push(`${p(f.tag)} = any(pf.tags)`);
  if (f.abandonedCart) {
    const has = (await q<{ t: string | null }>(c, `select to_regclass('shop_cart')::text t /* unscoped: is the web store installed */`))[0]?.t;
    w.push(has ? `exists (select 1 from shop_cart k where k.entity_id = $1 and k.sales_order_id is null and k.item_count > 0 and lower(k.email) = lower(cu.email))` : "false");
  }
  return { sql: `select cu.id from customer cu left join crm_profile pf on pf.customer_id = cu.id where ${w.join(" and ")}`, args };
}

export async function segmentMembers(c: Client, entityId: string, f: SegmentFilter, limit = 5000) {
  const { sql, args } = await segmentSql(c, entityId, f);
  return q<{ id: string; number: string; name: string; email: string | null; phone: string | null }>(c,
    `select cu.id, cu.number, cu.name, cu.email, cu.phone from customer cu where cu.entity_id = $1 and cu.id in (${sql}) order by cu.name limit ${Math.min(limit, 20000)}`, args);
}

export async function saveSegment(c: Client, entityId: string, by: string | null, s: { id?: string | null; name: unknown; filter: unknown }) {
  const name = clean(s.name, 80);
  need(name, "Name the segment.");
  const f = parseFilter(s.filter);
  if (s.id) {
    const r = await q(c, `update crm_segment set name = $3, filter = $4 where id = $1 and entity_id = $2 returning id`, [s.id, entityId, name, JSON.stringify(f)]);
    need(r.length, "No such segment.");
    return s.id;
  }
  const dup = await q(c, `select 1 from crm_segment where entity_id = $1 and name = $2`, [entityId, name]);
  need(!dup.length, "A segment already has that name.");
  return (await one<{ id: string }>(c, `insert into crm_segment (entity_id, name, filter, created_by) values ($1,$2,$3,$4) returning id`, [entityId, name, JSON.stringify(f), by])).id;
}

export async function segments(c: Client, entityId: string) {
  const rows = await q<{ id: string; name: string; filter: SegmentFilter }>(c, `select id, name, filter from crm_segment where entity_id = $1 order by name`, [entityId]);
  const out = [];
  for (const s of rows) out.push({ ...s, count: (await segmentMembers(c, entityId, parseFilter(s.filter))).length });
  return out;
}

// ============================================================= campaigns --

export type CampaignIn = { id?: string | null; name: unknown; channel: string; segmentId: string; subject?: unknown; body: unknown; costMinor?: bigint; scheduledAt?: string | null };

export async function saveCampaign(c: Client, entityId: string, by: string | null, k: CampaignIn) {
  const name = clean(k.name, 80);
  need(name, "Name the campaign.");
  need(["email", "sms"].includes(k.channel), "A campaign goes by email or text.");
  need(U.test(k.segmentId) && (await q(c, `select 1 from crm_segment where id = $1 and entity_id = $2`, [k.segmentId, entityId])).length, "Pick who it goes to (a segment).");
  const body = typeof k.body === "string" ? k.body.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, 4000) : "";
  need(body, "Write the message.");
  const subject = clean(k.subject, 150);
  if (k.channel === "email") need(subject, "An email needs a subject.");
  if (k.channel === "sms") need(body.length <= 480, "Keep a text under 480 characters (three messages).");
  const sched = k.scheduledAt ? new Date(k.scheduledAt) : null;
  need(!sched || !isNaN(sched.getTime()), "The send time is not a date.");
  const args = [entityId, name, k.channel, k.segmentId, subject || null, body, (k.costMinor ?? 0n).toString(), sched];
  if (k.id) {
    const r = await q(c, `update crm_campaign set name = $3, channel = $4, segment_id = $5, subject = $6, body = $7, cost_minor = $8, scheduled_at = $9
        where id = $1 and entity_id = $2 and status = 'draft' returning id`, [k.id, ...args]);
    need(r.length, "Only a draft campaign can be changed.");
    return k.id;
  }
  need(!(await q(c, `select 1 from crm_campaign where entity_id = $1 and name = $2`, [entityId, name])).length, "A campaign already has that name.");
  return (await one<{ id: string }>(c, `insert into crm_campaign (entity_id, name, channel, segment_id, subject, body, cost_minor, scheduled_at, utm_campaign, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [...args, name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), by])).id;
}

/** Merge fields: {{first_name}}, {{name}}, {{store}}, {{coupon}}, {{store_credit}}. Unknown fields are left out, never shown raw. */
export function renderTemplate(tpl: string, v: Record<string, string>) {
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, k: string) => v[k] ?? "").replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * Make one message per segment member, checking consent for each: anyone
 * without it is recorded as suppressed with the reason, not silently dropped.
 * Texts in quiet hours wait until morning where the customer lives.
 */
export async function launchCampaign(c: Client, entityId: string, campaignId: string, publicBase: string, at: Date = new Date()) {
  need(U.test(campaignId), "No such campaign.");
  const k = (await q<{ id: string; name: string; channel: Channel; segment_id: string; subject: string | null; body: string; status: string; scheduled_at: string | null }>(c,
    `select id, name, channel, segment_id, subject, body, status, scheduled_at from crm_campaign where id = $1 and entity_id = $2 for update`, [campaignId, entityId]))[0];
  need(k, "No such campaign.");
  need(k.status === "draft", `${k.name} has already gone out.`);
  const seg = (await q<{ filter: SegmentFilter }>(c, `select filter from crm_segment where id = $1 and entity_id = $2`, [k.segment_id, entityId]))[0];
  need(seg, "The campaign's segment is gone.");
  const coupon = (await q<{ code: string }>(c, `select code from crm_coupon where entity_id = $1 and campaign_id = $2 and active order by created_at limit 1`, [entityId, campaignId]))[0]?.code ?? "";
  const qh = (await q<{ value: { start?: number; end?: number } }>(c, `select value from entity_setting where entity_id = $1 and key = 'crm.quiet_hours'`, [entityId]))[0]?.value ?? {};
  const members = await segmentMembers(c, entityId, parseFilter(seg.filter));
  const sendAt = k.scheduled_at && new Date(k.scheduled_at) > at ? new Date(k.scheduled_at) : at;
  let queued = 0, suppressed = 0;
  for (const m of members) {
    const info = (await q<{ store: string | null; state: string | null }>(c, `select l.name store, coalesce(a.state, l.state) state from customer cu
        left join location l on l.id = cu.home_location_id left join customer_address a on a.customer_id = cu.id and a.is_default and a.entity_id = cu.entity_id
       where cu.id = $1 and cu.entity_id = $2`, [m.id, entityId]))[0];
    const token = randomBytes(18).toString("base64url");
    const addr = k.channel === "email" ? m.email : m.phone;
    const gate = await canMarket(c, entityId, m.id, k.channel);
    const reason = !addr ? `no ${k.channel === "email" ? "email address" : "mobile number"} on file` : gate.ok ? null : gate.reason;
    const unsub = `${publicBase}/crm/u/${token}`;
    const vars = { first_name: m.name.split(" ")[0], name: m.name, store: info?.store ?? "", coupon, unsubscribe: unsub };
    let body = renderTemplate(k.body, vars);
    body += k.channel === "email" ? `\n\nDon't want these emails? Unsubscribe: ${unsub}` : `\nReply STOP to opt out.`;
    const after = k.channel === "sms" ? outsideQuietHours(sendAt, tzForState(info?.state, await timeZoneFor(c, entityId)), qh.start ?? 21, qh.end ?? 8) : sendAt;
    await c.query(`insert into crm_message (entity_id, campaign_id, customer_id, channel, to_ref, subject, body, status, reason, send_after, unsub_token)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,
      [entityId, campaignId, m.id, k.channel, addr ? (k.channel === "email" ? maskEmail(addr) : maskPhone(addr)) : "(none)",
       k.subject ? renderTemplate(k.subject, vars) : null, body, reason ? "suppressed" : "queued", reason, after, token]);
    if (reason) suppressed++; else queued++;
  }
  await c.query(`update crm_campaign set status = $3, sent_at = case when $3 = 'sent' then now() else sent_at end where id = $1 and entity_id = $2`,
    [campaignId, entityId, sendAt > at ? "scheduled" : "sent"]);
  return { queued, suppressed, members: members.length };
}

/** The sending seam. 'record' marks a message sent and goes no further. */
export interface CampaignProvider { name: string; send(m: { channel: Channel; toRef: string; subject: string | null; body: string }): Promise<{ ok: boolean; error?: string }> }
export const RecordProvider: CampaignProvider = { name: "record", async send() { return { ok: true }; } };

/** Send whatever is due. Consent is checked again here: an opt-out after the campaign was built still stops the message. */
/**
 * Campaigns through Admin, Connections: the real address is read from the
 * customer (the message row keeps it masked). A channel that is not connected
 * is recorded only, as before. Consent was checked by the caller just before.
 */
async function connectedSend(c: Client, entityId: string, m: { id: string; customer_id: string | null; channel: Channel; subject: string | null; body: string }) {
  if (!m.customer_id || !(await messaging.isConnected(c, entityId, m.channel))) return { ok: true, name: RecordProvider.name, error: undefined as string | undefined };
  const cu = (await q<{ email: string | null; phone: string | null }>(c, `select email, phone from customer where id = $1 and entity_id = $2`, [m.customer_id, entityId]))[0];
  const to = m.channel === "email" ? cu?.email : cu?.phone;
  if (!to) return { ok: false, name: "none", error: `no ${m.channel === "email" ? "email address" : "mobile number"} on file` };
  // Through the outbox: the message and its outbox row commit together and the outbox sends it once, after
  // the commit (messaging.drainQueued). A crash between the two can no longer send it again on the next run.
  const o = { purpose: "campaign", sourceTable: "crm_message", sourceId: m.id };
  const r = m.channel === "email" ? await messaging.queueEmail(c, entityId, { to: [to], subject: m.subject ?? "", text: m.body }, o) : await messaging.queueSms(c, entityId, to, m.body, o);
  return { ok: r.status === "queued" || r.status === "sent", name: r.provider, error: r.error ?? undefined };
}

export async function processQueue(c: Client, entityId: string, provider?: CampaignProvider, at: Date = new Date()) {
  const due = await q<{ id: string; customer_id: string | null; channel: Channel; to_ref: string; subject: string | null; body: string; campaign_id: string | null }>(c,
    `select id, customer_id, channel, to_ref, subject, body, campaign_id from crm_message where entity_id = $1 and status = 'queued' and send_after <= $2
      order by send_after limit 1000 for update skip locked`, [entityId, at]);
  let sent = 0, stopped = 0;
  for (const m of due) {
    if (m.customer_id) {
      const gate = await canMarket(c, entityId, m.customer_id, m.channel);
      if (!gate.ok) { await c.query(`update crm_message set status = 'suppressed', reason = $3 where id = $1 and entity_id = $2`, [m.id, entityId, gate.reason]); stopped++; continue; }
    }
    const r = provider ? { ...(await provider.send({ channel: m.channel, toRef: m.to_ref, subject: m.subject, body: m.body })), name: provider.name } : await connectedSend(c, entityId, m);
    await c.query(`update crm_message set status = $3, sent_at = now(), reason = $4, provider = $5 where id = $1 and entity_id = $2`,
      [m.id, entityId, r.ok ? "sent" : "failed", r.ok ? null : clean(r.error, 200) || "the provider refused it", r.name]);
    if (r.ok) sent++;
  }
  await c.query(`update crm_campaign k set status = 'sent', sent_at = coalesce(sent_at, now()) where k.entity_id = $1 and k.status = 'scheduled'
      and not exists (select 1 from crm_message m where m.campaign_id = k.id and m.entity_id = $1 and m.status = 'queued')`, [entityId]);
  return { sent, stopped };
}

/** What a provider reports back (delivered, opened), by message. */
export async function providerEvent(c: Client, entityId: string, messageId: string, event: "delivered" | "opened") {
  await c.query(`update crm_message set status = case when status in ('sent','delivered') then $3 else status end,
      delivered_at = coalesce(delivered_at, now()), opened_at = case when $3 = 'opened' then coalesce(opened_at, now()) else opened_at end
     where id = $1 and entity_id = $2 and status in ('sent','delivered','opened')`, [messageId, entityId, event]);
}

/** Unsubscribe from the link in a message: no sign-in, the token is the proof. Saying it twice is fine. */
export async function unsubscribe(c: Client, token: string) {
  need(/^[A-Za-z0-9_-]{20,64}$/.test(token), "That unsubscribe link is not valid.");
  const m = (await q<{ entity_id: string; customer_id: string | null; channel: Channel; entity_name: string }>(c, `
    select m.entity_id, m.customer_id, m.channel, e.name entity_name from crm_message m join entity e on e.id = m.entity_id
     where m.unsub_token = $1 /* unscoped: the token identifies the message and its company */`, [token]))[0];
  need(m && m.customer_id, "That unsubscribe link is not valid.");
  const cur = (await consentOf(c, m!.entity_id, m!.customer_id!)).find((x) => x.channel === m!.channel)!;
  if (cur.status !== "opt_out") await recordConsent(c, m!.entity_id, m!.customer_id!, m!.channel, "opt_out", "unsubscribe link", null, `token ${token.slice(0, 6)}…`);
  await c.query(`update crm_message set status = 'suppressed', reason = 'unsubscribed' where entity_id = $1 and customer_id = $2 and channel = $3 and status = 'queued'`,
    [m!.entity_id, m!.customer_id, m!.channel]);
  return { channel: m!.channel, company: m!.entity_name };
}

export async function unsubscribeInfo(c: Client, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return (await q<{ channel: string; company: string }>(c, `select m.channel, e.name company from crm_message m join entity e on e.id = m.entity_id
     where m.unsub_token = $1 /* unscoped: the token identifies the message */`, [token]))[0] ?? null;
}

// ================================================================ coupons --

export type CouponIn = { code: unknown; campaignId?: string | null; kind: string; pctBps?: number | null; amountMinor?: bigint | null; minSpendMinor?: bigint;
  startsOn: string; endsOn: string; maxUses?: number | null; oncePerCustomer?: boolean; channels?: string[] };

export async function saveCoupon(c: Client, entityId: string, by: string | null, k: CouponIn) {
  const code = clean(k.code, 24).toUpperCase();
  need(/^[A-Z0-9-]{3,24}$/.test(code), "A code is 3 to 24 letters, numbers or dashes.");
  need(["percent", "amount"].includes(k.kind), "A coupon is a percent off or an amount off.");
  if (k.kind === "percent") need(k.pctBps && k.pctBps >= 1 && k.pctBps <= 5000, "Percent off runs from 0.01% to 50%.");
  else need(k.amountMinor && k.amountMinor > 0n, "Say how much off.");
  need(/^\d{4}-\d{2}-\d{2}$/.test(k.startsOn) && /^\d{4}-\d{2}-\d{2}$/.test(k.endsOn) && k.endsOn >= k.startsOn, "Give start and end dates, end on or after start.");
  const ch = (k.channels?.length ? k.channels : ["pos", "web"]).filter((x) => ["pos", "web"].includes(x));
  need(ch.length, "Say where it can be used: the register, the web store, or both.");
  if (k.campaignId) need((await q(c, `select 1 from crm_campaign where id = $1 and entity_id = $2`, [k.campaignId, entityId])).length, "No such campaign.");
  need(!(await q(c, `select 1 from crm_coupon where entity_id = $1 and code = $2`, [entityId, code])).length, `${code} is already a coupon code.`);
  return (await one<{ id: string }>(c, `insert into crm_coupon (entity_id, code, campaign_id, kind, pct_bps, amount_minor, min_spend_minor, starts_on, ends_on, max_uses,
      once_per_customer, channels, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [entityId, code, k.campaignId ?? null, k.kind, k.kind === "percent" ? k.pctBps : null, k.kind === "amount" ? k.amountMinor!.toString() : null,
     (k.minSpendMinor ?? 0n).toString(), k.startsOn, k.endsOn, k.maxUses ?? null, k.oncePerCustomer !== false, ch, by])).id;
}

export async function endCoupon(c: Client, entityId: string, id: string) {
  const r = await q(c, `update crm_coupon set active = false where id = $1 and entity_id = $2 and active returning id`, [id, entityId]);
  need(r.length, "No such active coupon.");
}

type CouponRow = { id: string; code: string; kind: string; pct_bps: number | null; amount_minor: string | null; min_spend_minor: string; starts_on: string;
  ends_on: string; max_uses: number | null; once_per_customer: boolean; channels: string[]; active: boolean; campaign_id: string | null };

/**
 * What a code takes off a basket of this size, or why not. POS and the web
 * store call this before they apply a discount, and redeemCoupon after.
 */
export async function checkCoupon(c: Client, entityId: string, code: unknown, ctx: { channel: "pos" | "web"; subtotalMinor: bigint; customerId?: string | null;
  email?: string | null; orderId?: string | null; lock?: boolean }): Promise<{ couponId: string; code: string; discountMinor: bigint; label: string }> {
  const cd = clean(code, 24).toUpperCase();
  need(cd, "Enter a coupon code.");
  const k = (await q<CouponRow>(c, `select id, code, kind, pct_bps, amount_minor, min_spend_minor, starts_on::text, ends_on::text, max_uses, once_per_customer, channels, active, campaign_id
      from crm_coupon where entity_id = $1 and code = $2 ${ctx.lock ? "for update" : ""}`, [entityId, cd]))[0];
  need(k && k.active, `${cd} is not a valid coupon code.`);
  const d = (await bizToday(c, entityId));
  need(d >= k!.starts_on, `${cd} starts on ${k!.starts_on}.`);
  need(d <= k!.ends_on, `${cd} expired on ${k!.ends_on}.`);
  need(k!.channels.includes(ctx.channel), `${cd} can't be used ${ctx.channel === "web" ? "online" : "in the store"}.`);
  need(ctx.subtotalMinor >= BigInt(k!.min_spend_minor), `${cd} needs a purchase of at least $${(Number(k!.min_spend_minor) / 100).toFixed(2)}.`);
  if (k!.max_uses) {
    const used = Number((await q<{ n: string }>(c, `select count(*) n from crm_coupon_redemption where entity_id = $1 and coupon_id = $2 and ($3::uuid is null or sales_order_id <> $3)`,
      [entityId, k!.id, ctx.orderId ?? null]))[0].n);
    need(used < k!.max_uses, `${cd} has been used up.`);
  }
  if (k!.once_per_customer && (ctx.customerId || ctx.email)) {
    const used = await q(c, `select 1 from crm_coupon_redemption r left join customer cu on cu.id = r.customer_id
       where r.entity_id = $1 and r.coupon_id = $2 and ($5::uuid is null or r.sales_order_id <> $5)
         and (($3::uuid is not null and r.customer_id = $3) or ($4::text is not null and lower(cu.email) = lower($4))) limit 1`,
      [entityId, k!.id, ctx.customerId ?? null, ctx.email ?? null, ctx.orderId ?? null]);
    need(!used.length, `${cd} has already been used by this customer.`);
  }
  const off = k!.kind === "percent" ? (ctx.subtotalMinor * BigInt(k!.pct_bps!) + 5000n) / 10000n
    : BigInt(k!.amount_minor!) < ctx.subtotalMinor ? BigInt(k!.amount_minor!) : ctx.subtotalMinor;
  return { couponId: k!.id, code: cd, discountMinor: off,
    label: k!.kind === "percent" ? `${cd}: ${(k!.pct_bps! / 100).toString()}% off` : `${cd}: $${(Number(k!.amount_minor) / 100).toFixed(2)} off` };
}

/**
 * Record a coupon against an order. Idempotent: the same coupon on the same
 * order again returns the first redemption. On the register, the discount
 * must already be on the sale (POS applies it through its own rules); this
 * credits the campaign and counts the use.
 */
export async function redeemCoupon(c: Client, entityId: string, by: string | null, r: { code: unknown; orderId: string; channel: "pos" | "web"; discountMinor?: bigint; subtotalMinor?: bigint }) {
  need(U.test(r.orderId), "No such order.");
  const so = (await q<{ id: string; customer_id: string | null; status: string; channel: string; subtotal_minor: string; discount_minor: string; email: string | null }>(c, `
    select so.id, so.customer_id, so.status, so.channel, so.subtotal_minor, so.discount_minor, cu.email from sales_order so left join customer cu on cu.id = so.customer_id
     where so.id = $1 and so.entity_id = $2`, [r.orderId, entityId]))[0];
  need(so, "No such order.");
  need(so!.status !== "cancelled", "That order was cancelled.");
  const cd = clean(r.code, 24).toUpperCase();
  const prior = (await q<{ id: string; discount_minor: string }>(c, `select r.id, r.discount_minor from crm_coupon_redemption r join crm_coupon k on k.id = r.coupon_id
      where r.entity_id = $1 and k.code = $2 and r.sales_order_id = $3`, [entityId, cd, so!.id]))[0];
  if (prior) return { id: prior.id, discountMinor: BigInt(prior.discount_minor), already: true };
  const chk = await checkCoupon(c, entityId, cd, { channel: r.channel, subtotalMinor: r.subtotalMinor ?? BigInt(so!.subtotal_minor), customerId: so!.customer_id, email: so!.email, orderId: so!.id, lock: true });
  const discount = r.discountMinor ?? chk.discountMinor;
  if (r.channel === "pos") need(BigInt(so!.discount_minor) >= discount, `Apply ${chk.label} to the sale first; the order shows $${(Number(so!.discount_minor) / 100).toFixed(2)} off.`);
  const ins = await q<{ id: string }>(c, `insert into crm_coupon_redemption (entity_id, coupon_id, sales_order_id, customer_id, channel, discount_minor, redeemed_by)
      values ($1,$2,$3,$4,$5,$6,$7) on conflict (coupon_id, sales_order_id) do nothing returning id`,
    [entityId, chk.couponId, so!.id, so!.customer_id, r.channel, discount.toString(), by]);
  if (!ins.length) {
    const again = (await q<{ id: string; discount_minor: string }>(c, `select id, discount_minor from crm_coupon_redemption where coupon_id = $1 and sales_order_id = $2 and entity_id = $3`, [chk.couponId, so!.id, entityId]))[0];
    return { id: again.id, discountMinor: BigInt(again.discount_minor), already: true };
  }
  return { id: ins[0].id, discountMinor: discount, already: false };
}

export async function coupons(c: Client, entityId: string) {
  return q(c, `select k.id, k.code, k.kind, k.pct_bps, k.amount_minor, k.min_spend_minor, k.starts_on::text, k.ends_on::text, k.max_uses, k.once_per_customer, k.channels, k.active,
      cp.name campaign, (select count(*) from crm_coupon_redemption r where r.coupon_id = k.id and r.entity_id = k.entity_id)::int uses,
      (select coalesce(sum(r.discount_minor),0) from crm_coupon_redemption r where r.coupon_id = k.id and r.entity_id = k.entity_id)::text discount_minor
     from crm_coupon k left join crm_campaign cp on cp.id = k.campaign_id where k.entity_id = $1 order by k.active desc, k.created_at desc`, [entityId]);
}

// ============================================================== reporting --

export async function campaignResults(c: Client, entityId: string) {
  return q(c, `
    select k.id, k.name, k.channel, k.status, k.sent_at, k.scheduled_at, k.cost_minor, s.name segment,
      count(m.id) filter (where m.status in ('sent','delivered','opened'))::int sent,
      count(m.id) filter (where m.status in ('delivered','opened'))::int delivered,
      count(m.id) filter (where m.status = 'opened')::int opened,
      count(m.id) filter (where m.status = 'suppressed')::int suppressed,
      count(m.id) filter (where m.status = 'queued')::int queued,
      (select count(*) from crm_coupon_redemption r join crm_coupon cc on cc.id = r.coupon_id where cc.campaign_id = k.id and r.entity_id = $1)::int redeemed,
      (select coalesce(sum(so.total_minor),0) from sales_order so where so.entity_id = $1 and so.status <> 'cancelled' and so.id in (
          select r.sales_order_id from crm_coupon_redemption r join crm_coupon cc on cc.id = r.coupon_id where cc.campaign_id = k.id and r.entity_id = $1
          union select l.sales_order_id from crm_lead l where l.entity_id = $1 and l.campaign_id = k.id and l.sales_order_id is not null))::text revenue_minor
      from crm_campaign k left join crm_segment s on s.id = k.segment_id left join crm_message m on m.campaign_id = k.id and m.entity_id = k.entity_id
     where k.entity_id = $1 group by k.id, s.name order by k.created_at desc`, [entityId]);
}

export async function dashboard(c: Client, entityId: string, days = 90) {
  const pipeline = await q(c, `select stage, count(*)::int n, coalesce(sum(estimate_minor),0)::text value from crm_lead where entity_id = $1 group by stage`, [entityId]);
  const bySales = await q(c, `select coalesce(u.name, 'Unassigned') who, count(*) filter (where l.stage not in ('won','lost'))::int open,
      count(*) filter (where l.stage = 'won' and l.won_at >= now() - make_interval(days => $2))::int won,
      count(*) filter (where l.stage = 'lost' and l.lost_at >= now() - make_interval(days => $2))::int lost,
      round(extract(epoch from avg(l.first_response_at - l.created_at)) / 60)::int response_min
      from crm_lead l left join app_user u on u.id = l.assigned_to where l.entity_id = $1 group by u.name order by open desc`, [entityId, days]);
  const byStore = await q(c, `select coalesce(loc.name, 'No store') store, count(*) filter (where l.stage not in ('won','lost'))::int open,
      count(*) filter (where l.stage = 'won')::int won, count(*) filter (where l.stage = 'lost')::int lost
      from crm_lead l left join location loc on loc.id = l.location_id where l.entity_id = $1 group by loc.name order by open desc`, [entityId]);
  const conv = (await q<{ total: string; won: string; lost: string; resp: string | null; bysource: unknown }>(c, `
    select count(*)::text total, count(*) filter (where stage = 'won')::text won, count(*) filter (where stage = 'lost')::text lost,
           round(extract(epoch from avg(first_response_at - created_at)) / 60)::text resp
      from crm_lead where entity_id = $1 and created_at >= now() - make_interval(days => $2)`, [entityId, days]))[0];
  const bySource = await q(c, `select source, count(*)::int n, count(*) filter (where stage = 'won')::int won from crm_lead
      where entity_id = $1 and created_at >= now() - make_interval(days => $2) group by source order by n desc`, [entityId, days]);
  const closed = Number(conv.won) + Number(conv.lost);
  return {
    days, pipeline, bySales, byStore, bySource,
    leads: Number(conv.total), won: Number(conv.won), lost: Number(conv.lost),
    conversionBps: closed ? Math.round((Number(conv.won) * 10000) / closed) : null,
    responseMinutes: conv.resp == null ? null : Number(conv.resp),
    campaigns: await campaignResults(c, entityId),
    segments: await segments(c, entityId),
    overdue: await overdue(c, entityId),
  };
}

export async function salespeople(c: Client, entityId: string) {
  return q<{ id: string; name: string; roles: string[] }>(c, `
    select u.id, u.name, array_agg(distinct g.role) roles from app_user u join role_grant g on g.app_user_id = u.id
     where (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = (select tenant_id from entity where id = $1)))
       and g.role in ('sales','store_manager','owner','marketing') group by u.id, u.name order by u.name /* entity_id = $1 via grants */`, [entityId]);
}
