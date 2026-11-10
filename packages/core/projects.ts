// Room projects (clienteling), owned by the trade module. A project belongs to
// a customer (and through their profile, a household; or to a trade account
// for a designer's client): a name like "Living room 2027", the room's size
// with its doors and windows, style notes, photos, a budget, and the products
// considered, quoted and bought. POS, CRM and the trade portal all read the
// same rows through this file.
//
// Automatic follow-ups go on the CRM task list (crm_task), once each:
//   quote_no_sale       N days (3) after a quote that has not become a sale -> the salesperson
//   care_checkin        N days (30) after delivery -> a care check-in
//   protection_checkin  N days (365) after delivery -> a protection plan check-in
// The days and whether each rule runs are in entity_setting 'clienteling.followups'.

import { q, one, audit, type Client, type Scope } from "./db.ts";
import { priceConfigured, type Choice } from "./pricing.ts";

export class ProjectError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new ProjectError(msg); };
const U = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const STAGES = ["considered", "quoted", "bought"] as const;

export type Opening = { kind: "door" | "window" | "opening"; wall: string | null; widthIn: number | null; heightIn: number | null; note: string | null };
export type ProjectIn = {
  name?: unknown; clientName?: unknown; clientAddress?: Record<string, unknown> | null; lengthIn?: unknown; widthIn?: unknown; heightIn?: unknown;
  openings?: unknown; styleNotes?: unknown; budgetMinor?: bigint | null; status?: string; salespersonId?: string | null;
};

const dim = (v: unknown, what: string): number | null => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  need(Number.isFinite(n) && n > 0 && n < 100000, `the room's ${what} is a size in inches`);
  return Math.round(n * 10) / 10;
};

export function parseOpenings(v: unknown): Opening[] {
  if (v == null || v === "") return [];
  need(Array.isArray(v), "doors and windows are a list");
  const arr = v as unknown[];
  need(arr.length <= 30, "a room has at most 30 doors and windows on file");
  return arr.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const kind = clean(o.kind, 10) || "window";
    need(["door", "window", "opening"].includes(kind), "an opening is a door, a window or an open archway");
    const n = (k: string) => { const r = o[k]; if (r === "" || r == null) return null; const m = Number(r); need(Number.isFinite(m) && m > 0 && m < 10000, `a ${kind}'s size is in inches`); return m; };
    return { kind: kind as Opening["kind"], wall: clean(o.wall, 20) || null, widthIn: n("widthIn"), heightIn: n("heightIn"), note: clean(o.note, 120) || null };
  });
}

function address(a: Record<string, unknown> | null | undefined) {
  if (!a) return {};
  const out = { line1: clean(a.line1, 100), line2: clean(a.line2, 100), city: clean(a.city, 60), state: clean(a.state, 2).toUpperCase(), postal: clean(a.postal, 10) };
  if (!out.line1 && !out.city && !out.postal) return {};
  need(out.line1.length >= 3 && out.city.length >= 2, "a client address needs the street and the city");
  need(/^[A-Z]{2}$/.test(out.state), "a client address needs the two-letter state");
  need(/^\d{5}(-\d{4})?$/.test(out.postal), "a client address needs a five-digit ZIP code");
  return out;
}

/** Who may see a project: staff of the company see all; a trade account sees only its own. */
export type Viewer = { tradeAccountId?: string | null };

async function projectRow(c: Client, entityId: string, id: string, v: Viewer = {}, lock = false) {
  need(U.test(id), "No such project.");
  const r = (await q<{ id: string; number: string; customer_id: string; trade_account_id: string | null; status: string; name: string }>(c, `
    select id, number, customer_id, trade_account_id, status, name from room_project where id = $1 and entity_id = $2 ${lock ? "for update" : ""}`, [id, entityId]))[0];
  // Another account's project reads exactly like one that does not exist.
  need(r && (!v.tradeAccountId || r.trade_account_id === v.tradeAccountId), "No such project.");
  return r!;
}

export async function createProject(c: Client, scope: Scope, e: ProjectIn & { customerId: string; tradeAccountId?: string | null }) {
  need(U.test(e.customerId), "Pick the customer the project is for.");
  const cu = (await q<{ id: string; name: string }>(c, `select id, name from customer where id = $1 and entity_id = $2 and status <> 'inactive'`, [e.customerId, scope.entityId]))[0];
  need(cu, "No such customer.");
  if (e.tradeAccountId) need((await q(c, `select 1 from trade_account where id = $1 and entity_id = $2 and customer_id = $3`, [e.tradeAccountId, scope.entityId, e.customerId])).length,
    "That trade account is not this customer's.");
  const name = clean(e.name, 80);
  need(name, "Name the project, like \"Living room 2027\".");
  const hh = (await q<{ household_id: string | null }>(c, `select household_id from crm_profile where customer_id = $1 and entity_id = $2`, [e.customerId, scope.entityId]))[0]?.household_id ?? null;
  if (e.salespersonId) need(await isStaff(c, scope, e.salespersonId), "That salesperson does not work for this company.");
  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'room_project', 'RP-') n /* unscoped: numbering function takes the entity */`, [scope.entityId])).n;
  const r = await one<{ id: string }>(c, `insert into room_project (entity_id, number, customer_id, household_id, trade_account_id, name, client_name, client_address,
      length_in, width_in, height_in, openings, style_notes, budget_minor, salesperson_id, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [scope.entityId, number, e.customerId, hh, e.tradeAccountId ?? null, name, clean(e.clientName, 80) || null, JSON.stringify(address(e.clientAddress)),
     dim(e.lengthIn, "length"), dim(e.widthIn, "width"), dim(e.heightIn, "height"), JSON.stringify(parseOpenings(e.openings)), clean(e.styleNotes, 2000) || null,
     budget(e.budgetMinor), e.salespersonId ?? (scope.actor.kind === "user" && scope.actor.id ? scope.actor.id : null), scope.actor.label]);
  await audit(c, scope, { table: "room_project", rowId: r.id, action: "insert", after: { number, name, customer: cu!.name } });
  return { id: r.id, number };
}

const budget = (b: bigint | null | undefined) => { if (b == null) return null; need(b >= 0n, "A budget cannot be negative."); return b.toString(); };

async function isStaff(c: Client, scope: Scope, id: string) {
  if (!U.test(id)) return false;
  return (await q(c, `select 1 from app_user u join role_grant g on g.app_user_id = u.id where u.id = $1 and u.status = 'active'
      and (g.entity_id = $2 or (g.entity_id is null and u.tenant_id = $3)) limit 1`, [id, scope.entityId, scope.tenantId])).length > 0;
}

export async function updateProject(c: Client, scope: Scope, id: string, e: ProjectIn, v: Viewer = {}) {
  const p = await projectRow(c, scope.entityId, id, v, true);
  const sets: string[] = [], args: unknown[] = [id, scope.entityId];
  const set = (col: string, val: unknown) => { args.push(val); sets.push(`${col} = $${args.length}`); };
  if (e.name !== undefined) { const n = clean(e.name, 80); need(n, "A project needs a name."); set("name", n); }
  if (e.clientName !== undefined) set("client_name", clean(e.clientName, 80) || null);
  if (e.clientAddress !== undefined) set("client_address", JSON.stringify(address(e.clientAddress)));
  if (e.lengthIn !== undefined) set("length_in", dim(e.lengthIn, "length"));
  if (e.widthIn !== undefined) set("width_in", dim(e.widthIn, "width"));
  if (e.heightIn !== undefined) set("height_in", dim(e.heightIn, "height"));
  if (e.openings !== undefined) set("openings", JSON.stringify(parseOpenings(e.openings)));
  if (e.styleNotes !== undefined) set("style_notes", clean(e.styleNotes, 2000) || null);
  if (e.budgetMinor !== undefined) set("budget_minor", budget(e.budgetMinor));
  if (e.status !== undefined) { need(["open", "won", "closed"].includes(e.status), "A project is open, won or closed."); set("status", e.status); }
  if (e.salespersonId !== undefined && !v.tradeAccountId) { if (e.salespersonId) need(await isStaff(c, scope, e.salespersonId), "That salesperson does not work for this company."); set("salesperson_id", e.salespersonId || null); }
  if (!sets.length) return { id };
  await c.query(`update room_project set ${sets.join(", ")}, updated_at = now() where id = $1 and entity_id = $2`, args);
  await audit(c, scope, { table: "room_project", rowId: id, action: "update", before: { name: p.name, status: p.status }, after: { fields: sets.map((s) => s.split(" = ")[0]) } });
  return { id };
}

export async function addPhoto(c: Client, scope: Scope, id: string, dataUrl: unknown, caption: unknown, v: Viewer = {}) {
  await projectRow(c, scope.entityId, id, v);
  const d = typeof dataUrl === "string" ? dataUrl.trim() : "";
  need(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(d), "A photo is a PNG, JPEG or WebP picture.");
  need(d.length <= 1_500_000, "That photo is too large; keep it under about 1 MB.");
  const n = Number((await one<{ n: string }>(c, `select count(*) n from room_project_photo where entity_id = $1 and project_id = $2 and removed_at is null`, [scope.entityId, id])).n);
  need(n < 24, "A project holds 24 photos; remove one first.");
  return (await one<{ id: string }>(c, `insert into room_project_photo (entity_id, project_id, data_url, caption) values ($1,$2,$3,$4) returning id`,
    [scope.entityId, id, d, clean(caption, 120) || null])).id;
}

export async function removePhoto(c: Client, scope: Scope, id: string, photoId: string, v: Viewer = {}) {
  await projectRow(c, scope.entityId, id, v);
  const r = await q(c, `update room_project_photo set removed_at = now() where id = $1 and entity_id = $2 and project_id = $3 and removed_at is null returning id`,
    [U.test(photoId) ? photoId : null, scope.entityId, id]);
  need(r.length, "No such photo on this project.");
}

export async function addItem(c: Client, scope: Scope, id: string, e: { productId: string; choices?: Choice[]; qty?: number; stage?: string; note?: unknown }, v: Viewer = {}) {
  await projectRow(c, scope.entityId, id, v);
  need(U.test(e.productId), "Pick a product.");
  const p = (await q<{ name: string; status: string }>(c, `select name, status from product where id = $1 and entity_id = $2`, [e.productId, scope.entityId]))[0];
  need(p, "No such product.");
  if (v.tradeAccountId) need((await q(c, `select 1 from product where id = $1 and entity_id = $2 and web_visible and status = 'active'`, [e.productId, scope.entityId])).length,
    "That product is not offered to the trade.");
  const qty = Math.trunc(Number(e.qty ?? 1));
  need(qty >= 1 && qty <= 50, "Quantities run from 1 to 50.");
  const stage = e.stage ?? "considered";
  need((STAGES as readonly string[]).includes(stage), "An item is considered, quoted or bought.");
  // The choices must be ones the product has (the configurator's rules).
  if (e.choices?.length || stage !== "considered") await priceConfigured(c, scope.entityId, e.productId, e.choices ?? []);
  return (await one<{ id: string }>(c, `insert into room_project_item (entity_id, project_id, product_id, choices, qty, stage, note) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [scope.entityId, id, e.productId, JSON.stringify(e.choices ?? []), qty, stage, clean(e.note, 300) || null])).id;
}

export async function setItem(c: Client, scope: Scope, id: string, itemId: string, e: { stage?: string; qty?: number; remove?: boolean; salesOrderId?: string | null }, v: Viewer = {}) {
  await projectRow(c, scope.entityId, id, v);
  need(U.test(itemId), "No such item on this project.");
  const it = (await q(c, `select id from room_project_item where id = $1 and entity_id = $2 and project_id = $3 and removed_at is null for update`, [itemId, scope.entityId, id]))[0];
  need(it, "No such item on this project.");
  if (e.remove) { await c.query(`update room_project_item set removed_at = now() where id = $1 and entity_id = $2`, [itemId, scope.entityId]); return; }
  if (e.stage) need((STAGES as readonly string[]).includes(e.stage), "An item is considered, quoted or bought.");
  if (e.qty != null) need(Number.isInteger(e.qty) && e.qty >= 1 && e.qty <= 50, "Quantities run from 1 to 50.");
  await c.query(`update room_project_item set stage = coalesce($3, stage), qty = coalesce($4, qty), sales_order_id = coalesce($5, sales_order_id) where id = $1 and entity_id = $2`,
    [itemId, scope.entityId, e.stage ?? null, e.qty ?? null, e.salesOrderId ?? null]);
}

/** Tie an order or a quote to the project (the order must be the project customer's). */
export async function linkOrder(c: Client, scope: Scope, id: string, orderId: string, v: Viewer = {}) {
  const p = await projectRow(c, scope.entityId, id, v);
  need(U.test(orderId), "No such order.");
  const so = (await q<{ customer_id: string | null; number: string }>(c, `select customer_id, number from sales_order where id = $1 and entity_id = $2`, [orderId, scope.entityId]))[0];
  need(so && so.customer_id === p.customer_id, "That order is not this project's customer's.");
  await c.query(`insert into room_project_order (entity_id, project_id, sales_order_id) values ($1,$2,$3) on conflict do nothing`, [scope.entityId, id, orderId]);
  return { number: so!.number };
}

export async function markQuoted(c: Client, scope: Scope, id: string, v: Viewer = {}) {
  await projectRow(c, scope.entityId, id, v);
  await c.query(`update room_project set quoted_at = now(), updated_at = now() where id = $1 and entity_id = $2`, [id, scope.entityId]);
  await c.query(`update room_project_item set stage = 'quoted' where project_id = $1 and entity_id = $2 and stage = 'considered' and removed_at is null`, [id, scope.entityId]);
}

/** Projects for a customer (and their household), or a trade account's projects. */
export async function projectsFor(c: Client, entityId: string, f: { customerId?: string | null; tradeAccountId?: string | null; q?: string; status?: string }) {
  const s = `%${clean(f.q, 60).replace(/[%_\\]/g, "")}%`;
  return q(c, `
    select p.id, p.number, p.name, p.status, p.client_name, p.budget_minor, p.updated_at, p.quoted_at, cu.name customer, cu.id customer_id, t.company_name trade_account,
           u.name salesperson,
           (select count(*) from room_project_item i where i.project_id = p.id and i.entity_id = p.entity_id and i.removed_at is null)::int items,
           (select count(*) from room_project_photo ph where ph.project_id = p.id and ph.entity_id = p.entity_id and ph.removed_at is null)::int photos
      from room_project p join customer cu on cu.id = p.customer_id left join trade_account t on t.id = p.trade_account_id left join app_user u on u.id = p.salesperson_id
     where p.entity_id = $1
       and ($2::uuid is null or p.customer_id = $2 or (p.household_id is not null and p.household_id = (select household_id from crm_profile where customer_id = $2 and entity_id = $1)))
       and ($3::uuid is null or p.trade_account_id = $3)
       and ($4 = '%%' or p.name ilike $4 or p.number ilike $4 or cu.name ilike $4 or coalesce(p.client_name, '') ilike $4)
       and ($5 = '' or p.status = $5)
     order by p.status = 'open' desc, p.updated_at desc limit 200`,
    [entityId, f.customerId ?? null, f.tradeAccountId ?? null, s, f.status ?? ""]);
}

/** One project in full. Prices are the account's own list when a trade account looks. */
export async function project(c: Client, entityId: string, id: string, v: Viewer = {}, priceList: string | null = null) {
  if (!U.test(id)) return null;
  const p = (await q(c, `
    select p.id, p.number, p.name, p.status, p.client_name, p.client_address, p.length_in, p.width_in, p.height_in, p.openings, p.style_notes, p.budget_minor,
           p.quoted_at, p.created_at, p.updated_at, p.customer_id, cu.name customer, p.trade_account_id, t.company_name trade_account, p.salesperson_id, u.name salesperson,
           h.name household
      from room_project p join customer cu on cu.id = p.customer_id left join trade_account t on t.id = p.trade_account_id
      left join app_user u on u.id = p.salesperson_id left join crm_household h on h.id = p.household_id
     where p.id = $1 and p.entity_id = $2`, [id, entityId]))[0];
  if (!p || (v.tradeAccountId && p.trade_account_id !== v.tradeAccountId)) return null;
  const items = await q<{ id: string; product_id: string; name: string; sku: string; choices: Choice[]; qty: number; stage: string; note: string | null; order_number: string | null }>(c, `
    select i.id, i.product_id, pr.name, pr.sku, i.choices, i.qty, i.stage, i.note, so.number order_number
      from room_project_item i join product pr on pr.id = i.product_id left join sales_order so on so.id = i.sales_order_id
     where i.entity_id = $1 and i.project_id = $2 and i.removed_at is null order by i.created_at`, [entityId, id]);
  const priced = [];
  let total = 0n;
  for (const it of items) {
    let unit: bigint | null = null, description = it.name, problem: string | null = null;
    try {
      await c.query("savepoint proj_price");
      const pr = await priceConfigured(c, entityId, it.product_id, it.choices, { priceList });
      await c.query("release savepoint proj_price");
      unit = pr.unitPriceMinor; description = pr.description;
    } catch (e) { await c.query("rollback to savepoint proj_price"); problem = (e as Error).message; }
    if (unit != null) total += unit * BigInt(it.qty);
    priced.push({ id: it.id, productId: it.product_id, name: it.name, sku: v.tradeAccountId ? undefined : it.sku, description, choices: it.choices, qty: it.qty,
      stage: it.stage, note: it.note, orderNumber: it.order_number, unitPriceMinor: unit?.toString() ?? null, lineMinor: unit == null ? null : (unit * BigInt(it.qty)).toString(), problem });
  }
  const photos = await q(c, `select id, data_url, caption, created_at from room_project_photo where entity_id = $1 and project_id = $2 and removed_at is null order by created_at`, [entityId, id]);
  const orders = await q(c, `select so.id, so.number, so.status, so.total_minor, so.paid_minor, so.ordered_at, coalesce(po.kind, 'sale') kind
      from room_project_order ro join sales_order so on so.id = ro.sales_order_id left join pos_order po on po.sales_order_id = so.id
     where ro.entity_id = $1 and ro.project_id = $2 order by so.ordered_at desc`, [entityId, id]);
  return { ...p, items: priced, itemsTotalMinor: total.toString(), photos, orders };
}

// ============================================================ follow-ups

export type FollowUpSettings = { quoteNoSaleDays: number; careDays: number; protectionDays: number; quoteNoSale: boolean; care: boolean; protection: boolean };
export const FOLLOWUP_DEFAULTS: FollowUpSettings = { quoteNoSaleDays: 3, careDays: 30, protectionDays: 365, quoteNoSale: true, care: true, protection: true };

export async function followUpSettings(c: Client, entityId: string): Promise<FollowUpSettings> {
  const r = (await q<{ value: Partial<FollowUpSettings> }>(c, `select value from entity_setting where entity_id = $1 and key = 'clienteling.followups'`, [entityId]))[0]?.value ?? {};
  return { ...FOLLOWUP_DEFAULTS, ...r };
}

export async function saveFollowUpSettings(c: Client, scope: Scope, s: Partial<FollowUpSettings>) {
  const cur = await followUpSettings(c, scope.entityId);
  const out = { ...cur };
  for (const [k, lo, hi] of [["quoteNoSaleDays", 1, 60], ["careDays", 1, 365], ["protectionDays", 30, 1825]] as const) {
    if (s[k] === undefined) continue;
    const n = Math.trunc(Number(s[k]));
    need(Number.isFinite(n) && n >= lo && n <= hi, `${k === "quoteNoSaleDays" ? "The quote follow-up" : k === "careDays" ? "The care check-in" : "The protection plan check-in"} is between ${lo} and ${hi} days.`);
    out[k] = n;
  }
  for (const k of ["quoteNoSale", "care", "protection"] as const) if (s[k] !== undefined) out[k] = s[k] === true;
  await c.query(`insert into entity_setting (entity_id, key, value, set_by) values ($1,'clienteling.followups',$2,$3)
                 on conflict (entity_id, key) do update set value = excluded.value, set_by = excluded.set_by, set_at = now()`, [scope.entityId, JSON.stringify(out), scope.actor.label]);
  await audit(c, scope, { table: "entity_setting", rowId: scope.entityId, action: "update", before: cur, after: out, reason: "clienteling follow-ups" });
  return out;
}

/**
 * Make the follow-up tasks that have come due. Safe to run any number of
 * times: each rule makes one task per order (or project), ever. A task goes
 * to the order's salesperson, else the project's, else the trade account's rep.
 */
export async function runFollowUps(c: Client, scope: Scope, at: Date = new Date()) {
  const s = await followUpSettings(c, scope.entityId);
  const made = { quoteNoSale: 0, projectQuotes: 0, care: 0, protection: 0 };
  const task = async (rule: string, who: string | null, customerId: string, title: string, kind: string, ref: { orderId?: string; projectId?: string }, notes: string) => {
    if (!who) return false;
    const ins = await q<{ id: string }>(c, `insert into clienteling_followup (entity_id, rule, sales_order_id, project_id) values ($1,$2,$3,$4) on conflict do nothing returning id`,
      [scope.entityId, rule, ref.orderId ?? null, ref.projectId ?? null]);
    if (!ins.length) return false;
    const t = await one<{ id: string }>(c, `insert into crm_task (entity_id, assigned_to, kind, title, notes, due_at, customer_id, auto, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,true,null) returning id`, [scope.entityId, who, kind, title.slice(0, 140), notes.slice(0, 1000), at, customerId]);
    await c.query(`update clienteling_followup set task_id = $2 where id = $1 and entity_id = $3`, [ins[0].id, t.id, scope.entityId]);
    return true;
  };
  if (s.quoteNoSale) {
    // POS quotes still drafts N days on, with no sale made for the customer since.
    const quotes = await q<{ id: string; number: string; customer_id: string; name: string; who: string | null; total_minor: string }>(c, `
      select so.id, so.number, so.customer_id, cu.name, coalesce(so.salesperson_id, so.created_by,
             (select p.salesperson_id from room_project_order ro join room_project p on p.id = ro.project_id where ro.sales_order_id = so.id and ro.entity_id = so.entity_id limit 1)) who,
             so.total_minor::text
        from sales_order so join pos_order po on po.sales_order_id = so.id join customer cu on cu.id = so.customer_id
       where so.entity_id = $1 and po.kind = 'quote' and so.status = 'draft' and so.customer_id is not null
         and so.ordered_at <= $2::timestamptz - make_interval(days => $3)
         and (po.quote_expires_on is null or po.quote_expires_on >= ($2::timestamptz)::date - 30)
         and not exists (select 1 from clienteling_followup f where f.rule = 'quote_no_sale' and f.sales_order_id = so.id)
       order by so.ordered_at limit 500`, [scope.entityId, at, s.quoteNoSaleDays]);
    for (const x of quotes) if (await task("quote_no_sale", x.who, x.customer_id, `Follow up on quote ${x.number}: ${x.name}`, "call", { orderId: x.id },
      `Quoted ${s.quoteNoSaleDays}+ days ago and not bought yet. Ask what is holding it up.`)) made.quoteNoSale++;
    // Project quotes (priced in the portal or by staff) with nothing bought since.
    const pq = await q<{ id: string; number: string; name: string; customer_id: string; who: string | null; client: string | null }>(c, `
      select p.id, p.number, p.name, p.customer_id, coalesce(p.salesperson_id, t.rep_id) who, coalesce(p.client_name, cu.name) client
        from room_project p join customer cu on cu.id = p.customer_id left join trade_account t on t.id = p.trade_account_id
       where p.entity_id = $1 and p.status = 'open' and p.quoted_at is not null and p.quoted_at <= $2::timestamptz - make_interval(days => $3)
         and not exists (select 1 from room_project_order ro join sales_order so on so.id = ro.sales_order_id where ro.project_id = p.id and ro.entity_id = $1
                           and so.status not in ('draft','cancelled') and so.ordered_at > p.quoted_at)
         and not exists (select 1 from clienteling_followup f where f.rule = 'quote_no_sale' and f.project_id = p.id)
       limit 500`, [scope.entityId, at, s.quoteNoSaleDays]);
    for (const x of pq) if (await task("quote_no_sale", x.who, x.customer_id, `Follow up on project ${x.number} (${x.name}) for ${x.client}`, "call", { projectId: x.id },
      `The project was quoted ${s.quoteNoSaleDays}+ days ago with no order yet.`)) made.projectQuotes++;
  }
  // Delivered: the order's first sale invoice.
  const delivered = async (rule: "care_checkin" | "protection_checkin", days: number) => q<{ id: string; number: string; customer_id: string; name: string; who: string | null; plan: boolean }>(c, `
    select so.id, so.number, so.customer_id, cu.name, so.salesperson_id who,
           exists (select 1 from sales_order_line l join product p on p.id = l.product_id where l.sales_order_id = so.id and l.entity_id = so.entity_id and p.kind = 'warranty' and l.qty > 0) plan
      from sales_order so join customer cu on cu.id = so.customer_id
     where so.entity_id = $1 and so.status in ('fulfilling','fulfilled','closed')
       and (select min(i.invoice_date) from customer_invoice i where i.entity_id = $1 and i.sales_order_id = so.id and i.kind = 'sale') <= ($2::timestamptz - make_interval(days => $3))::date
       and (select min(i.invoice_date) from customer_invoice i where i.entity_id = $1 and i.sales_order_id = so.id and i.kind = 'sale') > ($2::timestamptz - make_interval(days => $3 + 60))::date
       and exists (select 1 from sales_order_line l join product p on p.id = l.product_id where l.sales_order_id = so.id and l.entity_id = so.entity_id
                     and p.kind in ('stock','configurable','special_order','kit') and l.qty > 0)
       and not exists (select 1 from clienteling_followup f where f.rule = $4 and f.sales_order_id = so.id)
     limit 500`, [scope.entityId, at, days, rule]);
  if (s.care) for (const x of await delivered("care_checkin", s.careDays))
    if (await task("care_checkin", x.who, x.customer_id, `Care check-in: ${x.name} (${x.number})`, "call", { orderId: x.id },
      `Delivered about ${s.careDays} days ago. Ask how the pieces are settling in and share care tips.`)) made.care++;
  if (s.protection) for (const x of await delivered("protection_checkin", s.protectionDays))
    if (await task("protection_checkin", x.who, x.customer_id, `Protection plan check-in: ${x.name} (${x.number})`, "call", { orderId: x.id },
      x.plan ? "A year since delivery. Remind them how to use their protection plan." : "A year since delivery and no protection plan. Offer one while it can still be added.")) made.protection++;
  return made;
}
