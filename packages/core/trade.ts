// Trade and designer accounts, and the trade portal. Owned by the trade module.
//
// A trade account is one business customer (interior designer, contractor,
// stager, hospitality buyer). It is built from what the other modules
// already keep, never a copy of it:
//   - the customer row (kind 'business'), with A/R terms and a credit limit
//     on its house account (ar.setAccount; net 30 by default)
//   - its resale certificate: a tax exemption certificate on that customer
//   - its prices: a price list (catalog), priced per category by rule
//     (cost + X%, retail - Y%), passed to priceConfigured
//   - a referral rate, earned through trade_commission.ts, paid to its vendor
// Applying is public; staff approve or decline. The portal (/trade/<slug>/)
// is signed in by an emailed six-digit code: only its hash is kept, it
// expires in ten minutes, dies after five wrong tries, and no more than
// three are sent to an account in fifteen minutes. A session is a random
// token whose hash is kept, for twelve hours.
//
// Every portal read and write names the account; another account's order,
// project or invoice reads exactly like one that does not exist.

import { ConfigError } from "./configurator.ts";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { q, one, audit, type Client, type Scope } from "./db.ts";
import { priceConfigured, PricingError, type Choice } from "./pricing.ts";
import * as shop from "./shop.ts";
import * as ar from "./ar.ts";
import * as tax from "./tax.ts";
import * as projects from "./projects.ts";
import { accrueReferrals } from "./trade_commission.ts";

export class TradeError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new TradeError(msg); };
const U = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s<>"]{1,64}@[^@\s<>"]{1,180}\.[^@\s<>".]{2,24}$/;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);
export const KINDS = ["designer", "contractor", "stager", "hospitality", "other"] as const;

/** Refusals a person reads as they are. */
export const TRADE_REFUSALS: (new (...a: never[]) => Error)[] = [TradeError, projects.ProjectError, shop.ShopError, PricingError, ar.ArError, tax.TaxError, ConfigError];

export const CODE_TTL_MIN = 10;
export const CODE_MAX_TRIES = 5;
export const CODES_PER_WINDOW = 3;
export const CODE_WINDOW_MIN = 15;
export const SESSION_HOURS = 12;
/** A session not used for this long ends (last_seen_at), even inside its 12 hours. */
export const SESSION_IDLE_MIN = 120;

// ============================================================== the seam

/** How a sign-in code reaches the person. 'record' files that a code went out (never the code) and sends nothing. */
export interface CodeMailer { name: string; send(c: Client, m: { entityId: string; siteId: string | null; customerId: string; to: string; subject: string; body: string }): Promise<void> }
export const RecordOnlyMailer: CodeMailer = {
  name: "record",
  async send(c, m) {
    await c.query(`insert into shop_message (entity_id, site_id, customer_id, channel, to_ref, template, body, provider, status)
                   values ($1,$2,$3,'email',$4,'trade_code','A trade portal sign-in code was sent. The code is not kept.','record','recorded')`,
      [m.entityId, m.siteId, m.customerId, shop.maskEmail(m.to)]);
  },
};

// ========================================================= applications

export type ApplicationIn = {
  companyName: unknown; kind: unknown; contactName: unknown; email: unknown; phone?: unknown; website?: unknown;
  resaleNumber?: unknown; resaleState?: unknown; resaleExpires?: unknown; address?: Record<string, unknown> | null; notes?: unknown;
};

export async function submitApplication(c: Client, site: shop.Site, a: ApplicationIn, ipHash: string | null) {
  shop.refuseCardNumbers({ notes: a.notes, name: a.companyName });
  const company = clean(a.companyName, 120), contact = clean(a.contactName, 80), email = clean(a.email, 120).toLowerCase();
  const kind = clean(a.kind, 20) || "designer";
  need(company.length >= 2, "Enter the business name.");
  need((KINDS as readonly string[]).includes(kind), "Say what kind of business it is: designer, contractor, stager, hospitality or other.");
  need(contact.length >= 2, "Enter your name.");
  need(EMAIL.test(email), "Enter a valid email address.");
  const phone = clean(a.phone, 30).replace(/[^0-9]/g, "");
  need(!phone || (phone.length >= 10 && phone.length <= 15), "Enter a phone number with area code, or leave it blank.");
  const resale = clean(a.resaleNumber, 60), st = clean(a.resaleState, 2).toUpperCase(), exp = clean(a.resaleExpires, 10);
  if (resale) {
    need(resale.length >= 3, "Enter the resale certificate number as printed.");
    need(/^[A-Z]{2}$/.test(st), "Enter the two-letter state on the resale certificate.");
    need(!exp || /^\d{4}-\d{2}-\d{2}$/.test(exp), "The certificate's expiry is a date.");
    need(!exp || exp >= today(), "That resale certificate has expired; apply with a current one, or leave it off and add it later.");
  }
  const ad = (a.address ?? {}) as Record<string, unknown>;
  const address = { line1: clean(ad.line1, 100), line2: clean(ad.line2, 100), city: clean(ad.city, 60), state: clean(ad.state, 2).toUpperCase(), postal: clean(ad.postal, 10) };
  if (address.line1 || address.postal) {
    need(address.line1.length >= 3 && address.city.length >= 2, "Enter the business street address and city.");
    need(/^[A-Z]{2}$/.test(address.state) && /^\d{5}(-\d{4})?$/.test(address.postal), "Enter the business address's two-letter state and five-digit ZIP.");
  }
  // One open application per email; an account already open answers the same, so this tells a stranger nothing new.
  const open = await q(c, `select 1 from trade_application where entity_id = $1 and lower(email) = $2 and status = 'pending'`, [site.entity_id, email]);
  const acct = await q(c, `select 1 from trade_account where entity_id = $1 and lower(email) = $2`, [site.entity_id, email]);
  // The same answer whether or not the email already applied or trades here, and never the number: staff see that.
  const thanks = { received: true, message: "Thanks. We'll be in touch." };
  if (open.length || acct.length) return thanks;
  const recent = await one<{ n: string }>(c, `select count(*) n from trade_application where entity_id = $1 and ip_hash = $2 and created_at > now() - interval '1 hour'`,
    [site.entity_id, ipHash ?? "-"]);
  need(Number(recent.n) < 5, "Too many applications from here. Try again in an hour.");
  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'trade_application', 'TA-') n /* unscoped: numbering function takes the entity */`, [site.entity_id])).n;
  await c.query(`insert into trade_application (entity_id, number, company_name, kind, contact_name, email, phone, website, resale_number, resale_state, resale_expires,
      address, notes, ip_hash) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [site.entity_id, number, company, kind, contact, email, phone || null, clean(a.website, 200) || null, resale || null, resale ? st : null, resale && exp ? exp : null,
     JSON.stringify(address.line1 ? address : {}), clean(a.notes, 1000) || null, ipHash]);
  return thanks;
}

export async function applications(c: Client, entityId: string, status = "pending") {
  return q(c, `select a.id, a.number, a.company_name, a.kind, a.contact_name, a.email, a.phone, a.website, a.resale_number, a.resale_state, a.resale_expires::text,
      a.address, a.notes, a.status, a.created_at, a.decided_at, a.decision_note, u.name decided_by, t.number account_number
     from trade_application a left join app_user u on u.id = a.decided_by left join trade_account t on t.id = a.trade_account_id
    where a.entity_id = $1 and ($2 = '' or a.status = $2) order by a.created_at desc limit 200`, [entityId, status]);
}

export type DecisionIn = {
  decision: "approved" | "declined"; note?: unknown; priceListId?: string | null; creditLimitMinor?: bigint; termsDays?: number;
  referralBps?: number; repId?: string | null; vendorId?: string | null;
};

/** Ensure the company has a TRADE price list; the account starts on it unless told otherwise. */
async function defaultTradeList(c: Client, scope: Scope): Promise<string> {
  const r = await q<{ id: string }>(c, `select id from price_list where entity_id = $1 and code = 'TRADE'`, [scope.entityId]);
  if (r[0]) return r[0].id;
  return (await one<{ id: string }>(c, `insert into price_list (entity_id, code, name) values ($1,'TRADE','Trade pricing') returning id`, [scope.entityId])).id;
}

/**
 * Approve or decline an application. Approval makes (or reuses, by email) the
 * business customer, opens its house account with terms and limit, files its
 * resale certificate, and opens the trade account on its price list.
 * `canSetCredit` is whether the person deciding may set a credit limit.
 */
export async function decideApplication(c: Client, scope: Scope, id: string, d: DecisionIn, canSetCredit: boolean) {
  need(U.test(id), "No such application.");
  const a = (await q<{ id: string; number: string; status: string; company_name: string; kind: string; contact_name: string; email: string; phone: string | null;
    resale_number: string | null; resale_state: string | null; resale_expires: string | null; address: Record<string, string> }>(c, `
    select id, number, status, company_name, kind, contact_name, email, phone, resale_number, resale_state, resale_expires::text, address
      from trade_application where id = $1 and entity_id = $2 for update`, [id, scope.entityId]))[0];
  need(a, "No such application.");
  need(a!.status === "pending", `Application ${a!.number} was already ${a!.status}.`);
  const note = clean(d.note, 500);
  if (d.decision === "declined") {
    need(note.length >= 3, "Say why the application is declined; the note is kept with it.");
    await c.query(`update trade_application set status = 'declined', decided_by = $3, decided_at = now(), decision_note = $4 where id = $1 and entity_id = $2`,
      [id, scope.entityId, scope.actor.id || null, note]);
    await audit(c, scope, { table: "trade_application", rowId: id, action: "transition", after: { status: "declined" }, reason: note });
    return { status: "declined" as const, tradeAccountId: null, warnings: [] as string[] };
  }
  need(d.decision === "approved", "Approve or decline the application.");
  const limit = d.creditLimitMinor ?? 0n;
  need(limit >= 0n, "A credit limit cannot be negative.");
  need(limit === 0n || canSetCredit, "Setting a credit limit needs the controller; approve with no limit (card only) and the controller sets it.");
  const terms = d.termsDays ?? 30;
  need(Number.isInteger(terms) && terms >= 0 && terms <= 120, "Terms are 0 to 120 days.");
  const referral = d.referralBps ?? 0;
  need(Number.isInteger(referral) && referral >= 0 && referral <= 5000, "A referral commission is between 0% and 50%.");
  const listId = d.priceListId ?? await defaultTradeList(c, scope);
  need((await q(c, `select 1 from price_list where id = $1 and entity_id = $2 and active`, [listId, scope.entityId])).length, "Pick an active price list.");
  if (d.repId) need((await q(c, `select 1 from app_user u join role_grant g on g.app_user_id = u.id where u.id = $1 and (g.entity_id = $2 or (g.entity_id is null and u.tenant_id = $3))`,
    [d.repId, scope.entityId, scope.tenantId])).length, "That rep does not work for this company.");
  if (d.vendorId) await vendorOk(c, scope, d.vendorId);

  // The customer: one already on file with this email (not yet a trade account), else a new business customer.
  let customerId = (await q<{ id: string }>(c, `select id from customer where entity_id = $1 and lower(email) = $2 and status <> 'inactive'
      and not exists (select 1 from trade_account t where t.customer_id = customer.id) order by created_at limit 1`, [scope.entityId, a!.email]))[0]?.id ?? null;
  if (customerId) {
    await c.query(`update customer set kind = 'business' where id = $1 and entity_id = $2`, [customerId, scope.entityId]);
  } else {
    const num = (await one<{ n: string }>(c, `select next_doc_no($1, 'customer', 'C-') n /* unscoped: numbering function takes the entity */`, [scope.entityId])).n;
    customerId = (await one<{ id: string }>(c, `insert into customer (entity_id, number, kind, name, email, phone) values ($1,$2,'business',$3,$4,$5) returning id`,
      [scope.entityId, `T${num}`, a!.company_name, a!.email, a!.phone])).id;
  }
  if (a!.address?.line1) {
    const has = await q(c, `select 1 from customer_address where entity_id = $1 and customer_id = $2 and is_default`, [scope.entityId, customerId]);
    await c.query(`insert into customer_address (entity_id, customer_id, label, line1, line2, city, state, postal, is_default) values ($1,$2,'Business',$3,$4,$5,$6,$7,$8)`,
      [scope.entityId, customerId, a!.address.line1, a!.address.line2 || null, a!.address.city, a!.address.state, a!.address.postal, !has.length]);
  }
  await ar.setAccount(c, scope, customerId, { houseAccount: true, creditLimitMinor: limit, termsDays: terms });
  const warnings: string[] = [];
  if (a!.resale_number) {
    if (a!.resale_expires && a!.resale_expires < today()) warnings.push(`The resale certificate ${a!.resale_number} has expired since the application; ask for a current one.`);
    else {
      const dup = await q(c, `select 1 from tax_exemption_certificate where entity_id = $1 and customer_id = $2 and number = $3`, [scope.entityId, customerId, a!.resale_number]);
      if (!dup.length) await tax.saveCertificate(c, scope, { customerId, number: a!.resale_number, state: a!.resale_state!, reason: "resale", expiresOn: a!.resale_expires });
    }
  }
  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'trade_account', 'TR-') n /* unscoped: numbering function takes the entity */`, [scope.entityId])).n;
  const t = await one<{ id: string }>(c, `insert into trade_account (entity_id, number, customer_id, company_name, kind, contact_name, email, phone, price_list_id,
      referral_bps, vendor_id, rep_id, application_id, approved_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [scope.entityId, number, customerId, a!.company_name, a!.kind, a!.contact_name, a!.email, a!.phone, listId, referral, d.vendorId ?? null, d.repId ?? null, id, scope.actor.id || null]);
  await c.query(`update trade_application set status = 'approved', decided_by = $3, decided_at = now(), decision_note = $4, trade_account_id = $5 where id = $1 and entity_id = $2`,
    [id, scope.entityId, scope.actor.id || null, note || null, t.id]);
  await c.query(`insert into crm_profile (customer_id, entity_id, tags) values ($1,$2,'{trade}')
                 on conflict (customer_id) do update set tags = (select array(select distinct unnest(crm_profile.tags || '{trade}'::text[])))`, [customerId, scope.entityId]);
  await audit(c, scope, { table: "trade_account", rowId: t.id, action: "insert", after: { number, application: a!.number, limit: limit.toString(), terms, referral } });
  return { status: "approved" as const, tradeAccountId: t.id, customerId, number, warnings };
}

async function vendorOk(c: Client, scope: Scope, vendorId: string) {
  need(U.test(vendorId), "No such vendor.");
  const v = await q(c, `select 1 from vendor v join vendor_entity ve on ve.vendor_id = v.id and ve.entity_id = $2 where v.id = $1 and ve.status <> 'inactive'`, [vendorId, scope.entityId]);
  need(v.length, "That vendor is not set up for this company. Add the designer as a vendor first (Payables), then link it.");
}

// ============================================================== accounts

export async function accounts(c: Client, entityId: string, f: { q?: string; status?: string } = {}) {
  const s = `%${clean(f.q, 60).replace(/[%_\\]/g, "")}%`;
  return q(c, `
    select t.id, t.number, t.company_name, t.kind, t.contact_name, t.email, t.status, t.referral_bps, pl.code price_list, cu.credit_limit_minor, cu.terms_days,
           (select coalesce(sum(l.amount_minor),0) from ar_ledger l where l.entity_id = t.entity_id and l.customer_id = t.customer_id)::text balance_minor,
           (select count(*) from room_project p where p.entity_id = t.entity_id and p.trade_account_id = t.id and p.status = 'open')::int open_projects
      from trade_account t join customer cu on cu.id = t.customer_id left join price_list pl on pl.id = t.price_list_id
     where t.entity_id = $1 and ($2 = '%%' or t.company_name ilike $2 or t.number ilike $2 or t.email ilike $2 or t.contact_name ilike $2)
       and ($3 = '' or t.status = $3)
     order by t.status = 'active' desc, t.company_name limit 300`, [entityId, s, f.status ?? ""]);
}

type AccountRow = { id: string; number: string; customer_id: string; company_name: string; kind: string; contact_name: string; email: string; phone: string | null;
  status: string; price_list_id: string | null; price_list: string | null; referral_bps: number; referral_basis: string; vendor_id: string | null; rep_id: string | null };

async function accountRow(c: Client, entityId: string, id: string): Promise<AccountRow | null> {
  if (!U.test(id)) return null;
  return (await q<AccountRow>(c, `select t.id, t.number, t.customer_id, t.company_name, t.kind, t.contact_name, t.email, t.phone, t.status, t.price_list_id, pl.code price_list,
      t.referral_bps, t.referral_basis, t.vendor_id, t.rep_id from trade_account t left join price_list pl on pl.id = t.price_list_id
     where t.id = $1 and t.entity_id = $2`, [id, entityId]))[0] ?? null;
}

/** What the account can spend on terms right now. */
async function credit(c: Client, entityId: string, customerId: string) {
  const cu = await one<{ credit_limit_minor: string; terms_days: number; status: string }>(c, `select credit_limit_minor, terms_days, status from customer where id = $1 and entity_id = $2`, [customerId, entityId]);
  const bal = await ar.customerBalance(c, entityId, customerId);
  const pending = await one<{ s: string }>(c, `
    select coalesce(sum(greatest(so.total_minor - so.paid_minor - coalesce((select sum(i.charged_minor) from customer_invoice i
             where i.entity_id = so.entity_id and i.sales_order_id = so.id), 0), 0)), 0)::text s
      from sales_order so where so.entity_id = $1 and so.customer_id = $2 and so.status in ('open','fulfilling') and so.channel = 'b2b'`, [entityId, customerId]);
  const limit = BigInt(cu.credit_limit_minor);
  const avail = limit - bal - BigInt(pending.s);
  return { limitMinor: limit.toString(), balanceMinor: bal.toString(), onOrderMinor: pending.s, availableMinor: (avail > 0n ? avail : 0n).toString(),
    termsDays: cu.terms_days, onHold: cu.status === "hold" };
}

export async function account(c: Client, entityId: string, id: string) {
  const t = await accountRow(c, entityId, id);
  if (!t) return null;
  const rules = t.price_list_id ? await q(c, `select id, category, basis, bps from price_list_rule where entity_id = $1 and price_list_id = $2 and active order by category nulls last`,
    [entityId, t.price_list_id]) : [];
  const vendor = t.vendor_id ? (await q(c, `select v.id, v.legal_name from vendor v join vendor_entity ve on ve.vendor_id = v.id and ve.entity_id = $2 where v.id = $1`, [t.vendor_id, entityId]))[0] ?? null : null;
  const rep = t.rep_id ? (await q(c, `select id, name from app_user where id = $1 /* unscoped: a person's name */`, [t.rep_id]))[0] ?? null : null;
  const owed = (await q<{ owed: string; billed: string }>(c, `select coalesce(sum(amount_minor) filter (where bill_id is null), 0)::text owed,
      coalesce(sum(amount_minor) filter (where bill_id is not null), 0)::text billed from trade_referral_event where entity_id = $1 and trade_account_id = $2`, [entityId, id]))[0];
  const orders = await q(c, `select so.id, so.number, so.status, so.total_minor, so.paid_minor, so.ordered_at, so.promised_on::text from sales_order so
     where so.entity_id = $1 and so.customer_id = $2 and so.status <> 'draft' order by so.ordered_at desc limit 50`, [entityId, t.customer_id]);
  return { account: t, credit: await credit(c, entityId, t.customer_id), certificates: await tax.certificates(c, entityId, t.customer_id), rules, vendor, rep,
    referrals: { owedMinor: owed.owed, billedMinor: owed.billed }, orders,
    projects: await projects.projectsFor(c, entityId, { tradeAccountId: id }) };
}

export type AccountIn = { status?: string; statusReason?: unknown; priceListId?: string | null; referralBps?: number; referralBasis?: string; vendorId?: string | null;
  repId?: string | null; contactName?: unknown; phone?: unknown; creditLimitMinor?: bigint; termsDays?: number };

export async function saveAccount(c: Client, scope: Scope, id: string, e: AccountIn, canSetCredit: boolean) {
  const t = await accountRow(c, scope.entityId, id);
  need(t, "No such trade account.");
  if (e.status !== undefined) {
    need(["active", "suspended", "closed"].includes(e.status), "A trade account is active, suspended or closed.");
    if (e.status !== "active") need(clean(e.statusReason, 300).length >= 3, "Say why the account is suspended or closed.");
  }
  if (e.priceListId) need((await q(c, `select 1 from price_list where id = $1 and entity_id = $2`, [e.priceListId, scope.entityId])).length, "No such price list.");
  if (e.referralBps !== undefined) need(Number.isInteger(e.referralBps) && e.referralBps >= 0 && e.referralBps <= 5000, "A referral commission is between 0% and 50%.");
  if (e.referralBasis !== undefined) need(["sale", "margin"].includes(e.referralBasis), "A referral is paid on the sale or on the gross margin.");
  if (e.vendorId) await vendorOk(c, scope, e.vendorId);
  if (e.repId) need((await q(c, `select 1 from app_user u join role_grant g on g.app_user_id = u.id where u.id = $1 and (g.entity_id = $2 or (g.entity_id is null and u.tenant_id = $3))`,
    [e.repId, scope.entityId, scope.tenantId])).length, "That rep does not work for this company.");
  await c.query(`update trade_account set status = coalesce($3, status), status_reason = case when $3 is null then status_reason when $3 = 'active' then null else $4 end,
      price_list_id = coalesce($5, price_list_id), referral_bps = coalesce($6, referral_bps), referral_basis = coalesce($7, referral_basis),
      vendor_id = case when $8 then $9 else vendor_id end, rep_id = case when $10 then $11 else rep_id end,
      contact_name = coalesce(nullif($12, ''), contact_name), phone = coalesce(nullif($13, ''), phone)
     where id = $1 and entity_id = $2`,
    [id, scope.entityId, e.status ?? null, clean(e.statusReason, 300) || null, e.priceListId ?? null, e.referralBps ?? null, e.referralBasis ?? null,
     e.vendorId !== undefined, e.vendorId ?? null, e.repId !== undefined, e.repId ?? null, clean(e.contactName, 80), clean(e.phone, 30).replace(/[^0-9]/g, "")]);
  if (e.creditLimitMinor !== undefined || e.termsDays !== undefined) {
    need(canSetCredit, "Changing a trade account's credit limit or terms needs the controller.");
    await ar.setAccount(c, scope, t!.customer_id, { houseAccount: true, creditLimitMinor: e.creditLimitMinor, termsDays: e.termsDays });
  }
  // A suspended or closed account cannot sign in: its sessions end now.
  if (e.status && e.status !== "active") await c.query(`update trade_session set revoked_at = now() where entity_id = $1 and trade_account_id = $2 and revoked_at is null`, [scope.entityId, id]);
  await audit(c, scope, { table: "trade_account", rowId: id, action: "update", before: { status: t!.status }, after: { ...e, creditLimitMinor: e.creditLimitMinor?.toString() } });
  return account(c, scope.entityId, id);
}

// ============================================================== sign-in

async function accountByEmail(c: Client, entityId: string, email: string) {
  return (await q<{ id: string; customer_id: string; status: string; email: string }>(c,
    `select id, customer_id, status, email from trade_account where entity_id = $1 and lower(email) = $2`, [entityId, email]))[0] ?? null;
}
const codeHash = (accountId: string, code: string) => sha(`trade-code|${accountId}|${code}`);

/**
 * Email a sign-in code. Says the same thing whether or not the email has an
 * account, so it cannot be used to find out who trades here.
 */
export async function requestCode(c: Client, site: shop.Site, emailIn: unknown, ipHash: string | null, mailer: CodeMailer = RecordOnlyMailer, at: Date = new Date()) {
  const email = clean(emailIn, 120).toLowerCase();
  need(EMAIL.test(email), "Enter the email your trade account uses.");
  const sent = { sent: true, message: "If that email has a trade account, a six-digit code is on its way. It works for 10 minutes." };
  const a = await accountByEmail(c, site.entity_id, email);
  if (!a || a.status !== "active") return sent;
  await c.query(`select id from trade_account where id = $1 and entity_id = $2 for update`, [a.id, site.entity_id]);
  const recent = await one<{ n: string }>(c, `select count(*) n from trade_login_code where entity_id = $1 and trade_account_id = $2
      and created_at > $3::timestamptz - make_interval(mins => $4)`, [site.entity_id, a.id, at, CODE_WINDOW_MIN]);
  // Over the limit: no code, and the same answer as ever (the route also limits by email, whoever asks).
  if (Number(recent.n) >= CODES_PER_WINDOW) return sent;
  // Only the newest code works.
  await c.query(`update trade_login_code set expires_at = least(expires_at, $3::timestamptz) where entity_id = $1 and trade_account_id = $2 and used_at is null`, [site.entity_id, a.id, at]);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await c.query(`insert into trade_login_code (entity_id, trade_account_id, code_sha256, expires_at, ip_hash, created_at) values ($1,$2,$3,$4,$5,$6)`,
    [site.entity_id, a.id, codeHash(a.id, code), new Date(at.getTime() + CODE_TTL_MIN * 60_000), ipHash, at]);
  await mailer.send(c, { entityId: site.entity_id, siteId: site.id, customerId: a.customer_id, to: a.email,
    subject: `Your ${site.display_name} trade sign-in code`, body: `Your sign-in code is ${code}. It works for ${CODE_TTL_MIN} minutes. If you did not ask for it, ignore this email.` });
  return sent;
}

export const CODE_REFUSED = "That code didn't work. Check it, or ask for a new one: a code works once, for 10 minutes.";
export type VerifyResult = { ok: true; token: string; expiresAt: string; account: { company: string; contact: string } } | { ok: false; error: string };

/**
 * Check a code. A wrong code counts against it and the count is kept even
 * though the answer is a refusal, so the caller commits the transaction and
 * shows `error` rather than throwing.
 */
export async function verifyCode(c: Client, site: shop.Site, emailIn: unknown, codeIn: unknown, at: Date = new Date()): Promise<VerifyResult> {
  const email = clean(emailIn, 120).toLowerCase();
  const code = clean(codeIn, 12).replace(/\s/g, "");
  if (!EMAIL.test(email) || !/^\d{6}$/.test(code)) return { ok: false, error: "Enter your email and the six-digit code from it." };
  const a = await accountByEmail(c, site.entity_id, email);
  // One answer for every failure: no account, no code, expired, used, wrong, or too many tries.
  const none: VerifyResult = { ok: false, error: CODE_REFUSED };
  if (!a || a.status !== "active") return none;
  const k = (await q<{ id: string; code_sha256: string; expires_at: string; attempts: number; live: boolean }>(c, `
    select id, code_sha256, expires_at, attempts, expires_at > $3::timestamptz live from trade_login_code
     where entity_id = $1 and trade_account_id = $2 and used_at is null order by created_at desc limit 1 for update`, [site.entity_id, a.id, at]))[0];
  if (!k || !k.live) return none;
  if (k.attempts >= CODE_MAX_TRIES) return none;
  const want = Buffer.from(k.code_sha256, "hex"), got = Buffer.from(codeHash(a.id, code), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    await c.query(`update trade_login_code set attempts = attempts + 1 where id = $1 and entity_id = $2`, [k.id, site.entity_id]);
    return none;
  }
  await c.query(`update trade_login_code set used_at = $3 where id = $1 and entity_id = $2`, [k.id, site.entity_id, at]);
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(at.getTime() + SESSION_HOURS * 3600_000);
  await c.query(`insert into trade_session (entity_id, trade_account_id, token_sha256, expires_at, created_at, last_seen_at) values ($1,$2,$3,$4,$5,$5)`,
    [site.entity_id, a.id, sha(token), expires, at]);
  const t = await one<{ company_name: string; contact_name: string }>(c, `select company_name, contact_name from trade_account where id = $1 and entity_id = $2`, [a.id, site.entity_id]);
  return { ok: true, token, expiresAt: expires.toISOString(), account: { company: t.company_name, contact: t.contact_name } };
}

export type Session = { accountId: string; customerId: string; entityId: string; priceList: string | null; company: string; email: string; contact: string; repId: string | null };

/** The signed-in account behind a session token, or null. Another company's token does not open this store. */
export async function sessionFor(c: Client, site: shop.Site, token: unknown): Promise<Session | null> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const r = (await q<{ id: string; account_id: string; customer_id: string; price_list: string | null; company_name: string; email: string; contact_name: string; rep_id: string | null }>(c, `
    select s.id, t.id account_id, t.customer_id, pl.code price_list, t.company_name, t.email, t.contact_name, t.rep_id
      from trade_session s join trade_account t on t.id = s.trade_account_id and t.entity_id = s.entity_id
      left join price_list pl on pl.id = t.price_list_id and pl.active
     where s.token_sha256 = $1 and s.entity_id = $2 and s.revoked_at is null and s.expires_at > now() and t.status = 'active'
       and s.last_seen_at > now() - make_interval(mins => $3)`, [sha(token), site.entity_id, SESSION_IDLE_MIN]))[0];
  if (!r) return null;
  return { accountId: r.account_id, customerId: r.customer_id, entityId: site.entity_id, priceList: r.price_list, company: r.company_name, email: r.email, contact: r.contact_name, repId: r.rep_id };
}

export async function touchSession(c: Client, site: shop.Site, token: string) {
  await c.query(`update trade_session set last_seen_at = now() where token_sha256 = $1 and entity_id = $2 and last_seen_at < now() - interval '1 minute'`, [sha(token), site.entity_id]);
}

export async function signOut(c: Client, site: shop.Site, token: string) {
  await c.query(`update trade_session set revoked_at = now() where token_sha256 = $1 and entity_id = $2 and revoked_at is null`, [sha(token), site.entity_id]);
}

// ================================================================ portal

const scopeFor = (site: shop.Site, s: Session): Scope => ({ tenantId: site.tenant_id, entityId: site.entity_id, actor: { kind: "system", label: `trade portal ${s.company}` } });

export async function me(c: Client, site: shop.Site, s: Session) {
  const certs = (await tax.certificates(c, site.entity_id, s.customerId)).map((x) => ({ number: x.number, state: x.state, reason: x.reason, expiresOn: x.expires_on,
    current: x.current, status: x.status }));
  const addrs = await q(c, `select id, label, line1, line2, city, state, postal, is_default from customer_address where entity_id = $1 and customer_id = $2 order by is_default desc, label`,
    [site.entity_id, s.customerId]);
  const pub = await shop.pubSite(c, site);
  return { company: s.company, contact: s.contact, email: shop.maskEmail(s.email), priceList: s.priceList, credit: await credit(c, site.entity_id, s.customerId),
    certificates: certs, addresses: addrs, store: { name: site.display_name, pickupStores: pub.pickupStores, categories: pub.categories, paymentMode: pub.paymentMode } };
}

/** The trade price of a product as configured: the account's list, through priceConfigured, beside the retail ticket. */
export async function tradePrice(c: Client, site: shop.Site, s: Session, productId: string, choices: Choice[]) {
  const pub = await shop.pubPrice(c, site, productId, choices);          // refuses what the web store does not sell
  const p = await priceConfigured(c, site.entity_id, productId, choices, { priceList: s.priceList });
  return { ...pub, unitPriceMinor: p.unitPriceMinor.toString(), retailMinor: (p.ticketMinor ?? p.unitPriceMinor).toString(), priceList: p.priceList ?? null };
}

/** The catalog at trade prices: the web store's listing, each card priced at its default configuration by the account's list. */
export async function catalog(c: Client, site: shop.Site, s: Session, f: shop.ListQuery) {
  const list = await shop.pubProducts(c, site, f);
  const out = [];
  for (const p of list.products) {
    const defaults = await q<{ code: string; option: string | null }>(c, `select g.code, (select o.code from product_option o where o.group_id = g.id and o.entity_id = g.entity_id and o.active
        order by o.seq, o.label limit 1) option from product_option_group g where g.entity_id = $1 and g.product_id = $2 and g.required order by g.seq`, [site.entity_id, p.id]);
    let trade: string | null = null;
    try {
      await c.query("savepoint trade_card");
      const pr = await priceConfigured(c, site.entity_id, p.id, defaults.filter((d) => d.option).map((d) => ({ group: d.code, option: d.option! })), { priceList: s.priceList });
      await c.query("release savepoint trade_card");
      trade = pr.unitPriceMinor.toString();
    } catch { await c.query("rollback to savepoint trade_card"); }
    out.push({ ...p, retailMinor: (p as { priceMinor: string }).priceMinor, tradeMinor: trade });
  }
  return { products: out, facets: list.facets };
}

export async function product(c: Client, site: shop.Site, s: Session, productId: string) {
  const p = await shop.pubProduct(c, site, productId);
  if (!p) return null;
  const price = await tradePrice(c, site, s, productId, p.defaults);
  return { ...p, tradeMinor: price.unitPriceMinor, retailMinor: price.retailMinor };
}

// ----------------------------------------------------------- projects --

const viewer = (s: Session): projects.Viewer => ({ tradeAccountId: s.accountId });
export const myProjects = (c: Client, site: shop.Site, s: Session) => projects.projectsFor(c, site.entity_id, { tradeAccountId: s.accountId });
export const myProject = (c: Client, site: shop.Site, s: Session, id: string) => projects.project(c, site.entity_id, id, viewer(s), s.priceList);
export async function createProject(c: Client, site: shop.Site, s: Session, b: projects.ProjectIn) {
  return projects.createProject(c, scopeFor(site, s), { ...b, salespersonId: s.repId, customerId: s.customerId, tradeAccountId: s.accountId });
}
export const updateProject = (c: Client, site: shop.Site, s: Session, id: string, b: projects.ProjectIn) => projects.updateProject(c, scopeFor(site, s), id, b, viewer(s));
export const addProjectItem = (c: Client, site: shop.Site, s: Session, id: string, b: { productId: string; choices?: Choice[]; qty?: number; note?: unknown; sectional?: shop.LineIn["sectional"] }) =>
  projects.addItem(c, scopeFor(site, s), id, { ...b, stage: "considered" }, viewer(s));
export const setProjectItem = (c: Client, site: shop.Site, s: Session, id: string, itemId: string, b: { qty?: number; remove?: boolean }) =>
  projects.setItem(c, scopeFor(site, s), id, itemId, { qty: b.qty, remove: b.remove }, viewer(s));
export const addProjectPhoto = (c: Client, site: shop.Site, s: Session, id: string, dataUrl: unknown, caption: unknown) =>
  projects.addPhoto(c, scopeFor(site, s), id, dataUrl, caption, viewer(s));
export const removeProjectPhoto = (c: Client, site: shop.Site, s: Session, id: string, photoId: string) => projects.removePhoto(c, scopeFor(site, s), id, photoId, viewer(s));

// -------------------------------------------------------------- ordering --

export type OrderIn = {
  projectId?: string | null; lines?: unknown; fulfillment: string; pickupLocationId?: string | null; shipTo?: "client" | "business" | "address";
  address?: Record<string, unknown> | null; resale?: boolean; certificate?: string | null; payBy: "account" | "card"; paymentToken?: string | null;
  notes?: unknown; reference?: unknown; cartId: string;
};

/** A checkout for the account: lines from the project (or sent), the ship-to, resale or taxed, on account or card. */
async function checkoutFor(c: Client, site: shop.Site, s: Session, b: OrderIn, quoteOnly: boolean): Promise<{ inp: shop.CheckoutIn; project: Awaited<ReturnType<typeof projects.project>> | null }> {
  let lines = b.lines;
  let project: Awaited<ReturnType<typeof projects.project>> | null = null;
  let address = b.address ?? null;
  let label: string | null = null;
  if (b.projectId) {
    project = await projects.project(c, site.entity_id, String(b.projectId), viewer(s), s.priceList);
    need(project, "No such project.");
    lines = project!.items.filter((i) => i.stage !== "bought").map((i) => ({ productId: i.productId, qty: i.qty, choices: i.choices, ...(i.sectional ? { sectional: i.sectional } : {}) }));
    need((lines as unknown[]).length, "The project has nothing left to order.");
    if (b.shipTo === "client") {
      const ca = (project as unknown as { client_address: Record<string, string>; client_name: string | null });
      need(ca.client_address?.line1, "The project has no client address; add it to the project, or ship to another address.");
      address = ca.client_address; label = `Client: ${ca.client_name ?? project!.name}`.slice(0, 60);
    }
  }
  if (b.shipTo === "business") {
    const a = (await q<Record<string, string>>(c, `select line1, line2, city, state, postal from customer_address where entity_id = $1 and customer_id = $2 order by is_default desc limit 1`,
      [site.entity_id, s.customerId]))[0];
    need(a, "There is no business address on the account; enter the address to ship to.");
    address = a; label = "Business";
  }
  const cert = b.resale ? (clean(b.certificate, 60) || (await q<{ number: string }>(c, `select number from tax_exemption_certificate where entity_id = $1 and customer_id = $2
      and status = 'active' and reason = 'resale' order by expires_on desc nulls first limit 1`, [site.entity_id, s.customerId]))[0]?.number || "") : "";
  if (b.resale) need(cert, "A resale order needs the account's resale certificate on file. Send it to the store, or order with tax.");
  const onAccount = b.payBy === "account";
  need(onAccount || b.payBy === "card", "Choose to pay on account or by card.");
  const inp = shop.parseCheckout({
    cartId: b.cartId, email: s.email, name: s.company, fulfillment: b.fulfillment, pickupLocationId: b.pickupLocationId, address, lines,
    paymentToken: onAccount ? "on_account" : b.paymentToken, notes: b.notes,
  }, quoteOnly);
  inp.trade = { customerId: s.customerId, priceList: s.priceList, resaleCert: cert || null, onAccount, shipLabel: label ?? (address ? "Ship-to" : null),
    reference: clean(b.reference, 60) || (project ? `${project.number} ${project.name}` : null) };
  return { inp, project };
}

export async function quoteOrder(c: Client, site: shop.Site, s: Session, b: OrderIn) {
  const { inp, project } = await checkoutFor(c, site, s, b, true);
  const qt = await shop.quote(c, site, inp);
  if (project) await projects.markQuoted(c, scopeFor(site, s), project.id as string, viewer(s));
  // Resale only where the certificate actually exempted something (its state is the destination's).
  return { ...qt, resale: qt.resaleExempt, onAccount: inp.trade?.onAccount ?? false, credit: await credit(c, site.entity_id, s.customerId) };
}

export async function placeOrder(c: Client, site: shop.Site, s: Session, b: OrderIn, provider: shop.PaymentProvider = shop.providerFor(site), mailer?: shop.MessageProvider) {
  const { inp, project } = await checkoutFor(c, site, s, b, false);
  const placed = await shop.placeWebOrder(c, site, inp, scopeFor(site, s), provider, mailer);
  const id = (await one<{ id: string }>(c, `select id from sales_order where entity_id = $1 and number = $2 and customer_id = $3`, [site.entity_id, placed.order.number, s.customerId])).id;
  if (project && !placed.duplicate) {
    const sc = scopeFor(site, s);
    await projects.linkOrder(c, sc, project.id as string, id, viewer(s));
    for (const it of project.items.filter((i) => i.stage !== "bought")) await projects.setItem(c, sc, project.id as string, it.id, { stage: "bought", salesOrderId: id }, viewer(s));
  }
  return { ...placed, orderId: id };
}

// ------------------------------------------------ orders and invoices --

async function myOrder(c: Client, site: shop.Site, s: Session, id: string) {
  need(U.test(id), "No such order.");
  const r = await q<{ id: string }>(c, `select id from sales_order where id = $1 and entity_id = $2 and customer_id = $3 and status <> 'draft'`, [id, site.entity_id, s.customerId]);
  need(r.length, "No such order.");
  return r[0].id;
}

export async function orders(c: Client, site: shop.Site, s: Session) {
  return q(c, `select so.id, so.number, so.status, so.fulfillment, so.promised_on::text, so.ordered_at, so.total_minor, so.paid_minor, so.notes,
      (select min(d.scheduled_on)::text from delivery_stop d where d.entity_id = so.entity_id and d.sales_order_id = so.id and d.status not in ('cancelled','failed')) delivery_on,
      (select p.name from room_project_order ro join room_project p on p.id = ro.project_id where ro.sales_order_id = so.id and ro.entity_id = so.entity_id limit 1) project
     from sales_order so where so.entity_id = $1 and so.customer_id = $2 and so.status <> 'draft' order by so.ordered_at desc limit 200`, [site.entity_id, s.customerId]);
}

export async function order(c: Client, site: shop.Site, s: Session, id: string) {
  const oid = await myOrder(c, site, s, id);
  const v = await shop.orderView(c, site.entity_id, oid);
  const stops = await q(c, `select number, kind, status, scheduled_on::text from delivery_stop where entity_id = $1 and sales_order_id = $2 and status <> 'cancelled' order by scheduled_on`,
    [site.entity_id, oid]);
  const invs = await q(c, `select id, number, kind, invoice_date::text, due_date::text, total_minor, status from customer_invoice where entity_id = $1 and sales_order_id = $2 order by invoice_date`,
    [site.entity_id, oid]);
  return { id: oid, ...v, deliveries: stops, invoices: invs };
}

export async function invoices(c: Client, site: shop.Site, s: Session) {
  const open = new Map((await ar.openInvoices(c, site.entity_id, s.customerId)).map((x) => [x.id, x.open_minor]));
  const rows = await q<{ id: string; number: string; kind: string; invoice_date: string; due_date: string; total_minor: string; status: string; order_number: string | null }>(c, `
    select i.id, i.number, i.kind, i.invoice_date::text, i.due_date::text, i.total_minor, i.status, so.number order_number
      from customer_invoice i left join sales_order so on so.id = i.sales_order_id
     where i.entity_id = $1 and i.customer_id = $2 order by i.invoice_date desc, i.number desc limit 200`, [site.entity_id, s.customerId]);
  return { invoices: rows.map((r) => ({ ...r, openMinor: open.get(r.id) ?? "0", pastDue: (open.get(r.id) ?? "0") !== "0" && r.due_date < today() })),
    credit: await credit(c, site.entity_id, s.customerId) };
}

/**
 * Pay an open invoice by card, through the store's card processor, onto the
 * account (A/R applies it to that invoice). The customer and the invoice are
 * locked and the open balance checked before the card is touched, and the
 * page's key makes a second press of the same payment a refusal, not a
 * second charge.
 */
export async function payInvoice(c: Client, site: shop.Site, s: Session, invoiceId: string, b: { amountMinor?: bigint | null; paymentToken: unknown; key?: unknown },
  provider: shop.PaymentProvider = shop.providerFor(site)) {
  need(U.test(invoiceId), "No such invoice.");
  const key = String(b.key ?? "");
  need(/^[A-Za-z0-9_-]{8,64}$/.test(key), "Refresh the page and try the payment again.");
  const token = String(b.paymentToken ?? "");
  need(/^[A-Za-z0-9_]{6,80}$/.test(token), "Choose a card to pay with.");
  await c.query(`select id from customer where id = $1 and entity_id = $2 for update`, [s.customerId, site.entity_id]);
  const fresh = await q(c, `insert into trade_invoice_payment (entity_id, trade_account_id, idem_key, invoice_id) values ($1,$2,$3,$4)
      on conflict (trade_account_id, idem_key) do nothing returning id`, [site.entity_id, s.accountId, key, invoiceId]);
  need(fresh.length, "That payment was already sent. Refresh to see the invoice; you were not charged twice.");
  const mine = await q<{ number: string; sales_order_id: string | null }>(c, `select number, sales_order_id from customer_invoice where id = $1 and entity_id = $2 and customer_id = $3 for update`,
    [invoiceId, site.entity_id, s.customerId]);
  need(mine.length, "No such invoice.");
  const inv = (await ar.openInvoices(c, site.entity_id, s.customerId)).find((x) => x.id === invoiceId);
  need(inv && BigInt(inv.open_minor) > 0n, `Invoice ${mine[0].number} is already paid.`);
  const open = BigInt(inv!.open_minor);
  const amount = b.amountMinor ?? open;
  need(amount > 0n, "Enter an amount to pay.");
  need(amount <= open, `Invoice ${mine[0].number} has ${(Number(open) / 100).toFixed(2)} open; pay that or less.`);
  const auth = await provider.authorize({ amountMinor: amount, token, reference: mine[0].number });
  if (!auth.approved) throw new TradeError(auth.reason);
  try {
    await provider.capture(auth.authRef, amount);
    const r = await ar.receivePayment(c, scopeFor(site, s), { customerId: s.customerId, amountMinor: amount, method: "card", locationId: site.web_location_id,
      reference: `${auth.brand} ending ${auth.last4}, ${provider.name} ${auth.authRef}`, channel: "web", apply: [{ invoiceId, amountMinor: amount }] });
    await c.query(`update trade_invoice_payment set receipt_id = $3, amount_minor = $4 where entity_id = $1 and id = $2`, [site.entity_id, (fresh[0] as { id: string }).id, r.receiptId, amount.toString()]);
    await accrueReferrals(c, scopeFor(site, s), { orderId: mine[0].sales_order_id });
    return { receipt: r.number, paidMinor: amount.toString(), card: `${auth.brand} ending ${auth.last4}` };
  } catch (e) {
    await provider.void(auth.authRef).catch(() => undefined);
    throw e;
  }
}

/** A sectional built in the portal, priced at the account's trade prices per piece. */
export async function sectionalPrice(c: Client, site: shop.Site, s: Session, productId: string, build: Parameters<typeof shop.pubSectionalPrice>[3]) {
  return shop.pubSectionalPrice(c, site, productId, build, s.priceList);
}

/** A tear sheet link for one of the account's orders, or a product the trade can buy. Opens /sheet/<token>. */
export async function sheetLink(c: Client, site: shop.Site, s: Session, e: { orderId?: string | null; productId?: string | null },
  createLink: (c: Client, scope: Scope, e: { orderId?: string | null; productId?: string | null; customerId?: string | null; days?: number }) => Promise<{ path: string; expiresAt: string }>) {
  need(!!e.orderId !== !!e.productId, "Pick the order or the product.");
  if (e.orderId) await myOrder(c, site, s, e.orderId);
  if (e.productId) need(await shop.pubProduct(c, site, e.productId), "That product is not offered to the trade.");
  const l = await createLink(c, scopeFor(site, s), { orderId: e.orderId ?? null, productId: e.productId ?? null, customerId: s.customerId, days: 7 });
  return { path: l.path, expiresAt: l.expiresAt };
}
