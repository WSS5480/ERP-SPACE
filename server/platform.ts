// The platform: the ERP sold to many businesses.
//
// Customer users (platform_login) belong to one tenant and sign in with an
// email and a password (scrypt, each with its own salt). Invites, password
// resets and emailed sign-in codes are single-use tokens; only their sha256 is
// kept, and the email that carries one is queued with the token redacted in
// the outbound log. Operators (the developer team, ERP_LOGINS) run the
// Operator console: create customers, suspend them, enter one in support mode
// (recorded), hand out time-limited demo logins and reset the demo.
//
// Every refusal here is a sentence (PlatformError, a 409 at the door).

import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { q, one, type Client } from "../packages/core/db.ts";
import { PACKS, packById } from "../packages/core/setup.ts";
import { connectionFor, queueEmail, type Row } from "../packages/core/messaging.ts";
import { createCompany } from "./actions.ts";
import { DEMO_TENANTS } from "../packages/core/platform_demo.ts";

export class PlatformError extends Error {}
function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new PlatformError(message);
}

export const EMAIL = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown, max = 200) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
export const cleanEmail = (v: unknown) => text(v, 200).toLowerCase();
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- passwords

const N = 16384, R = 8, P = 1, KEYLEN = 64;
export const MIN_PASSWORD = 10;

/** scrypt with a salt of the user's own: scrypt$N$r$p$<salt>$<hash>. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${h.toString("base64url")}`;
}

// A stand-in so an unknown email costs the same time as a wrong password.
const DUMMY = hashPassword(randomBytes(12).toString("hex"));

export function verifyPassword(pw: string, stored: string | null | undefined): boolean {
  const parts = String(stored || DUMMY).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, "base64url");
  let got: Buffer;
  try {
    got = scryptSync(String(pw).normalize("NFKC"), Buffer.from(salt, "base64url"), want.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  } catch { return false; }
  return timingSafeEqual(got, want) && !!stored;
}

export function checkPassword(pw: unknown, email = ""): string {
  const s = typeof pw === "string" ? pw : "";
  need(s.length >= MIN_PASSWORD, `use at least ${MIN_PASSWORD} characters for the password`);
  need(s.length <= 200, "that password is longer than 200 characters");
  need(new Set(s).size >= 4, "that password repeats too few characters; pick something harder to guess");
  need(!email || s.toLowerCase() !== email.toLowerCase(), "the password cannot be your email address");
  return s;
}

// ------------------------------------------------------------------- logins

export type Login = {
  id: string; tenant_id: string; app_user_id: string; email: string; kind: "customer" | "prospect";
  status: "invited" | "active" | "disabled"; pw_hash: string | null; session_version: number;
  expires_at: string | null; last_entity_id: string | null; name: string; user_status: string;
  tenant_name: string; tenant_kind: string; tenant_status: string;
};

const LOGIN_SQL = `
  select l.id, l.tenant_id, l.app_user_id, l.email, l.kind, l.status, l.pw_hash, l.session_version,
         l.expires_at::text as expires_at, l.last_entity_id, u.name, u.status as user_status,
         t.name as tenant_name, t.kind as tenant_kind, t.status as tenant_status
    from platform_login l join app_user u on u.id = l.app_user_id join tenant t on t.id = l.tenant_id`;

export async function loginByEmail(c: Client, email: string): Promise<Login | null> {
  return (await q<Login>(c, `${LOGIN_SQL} where l.email = $1 /* unscoped: signing in, before a tenant is known */`, [email]))[0] ?? null;
}
export async function loginById(c: Client, id: string): Promise<Login | null> {
  if (!UUID.test(id)) return null;
  return (await q<Login>(c, `${LOGIN_SQL} where l.id = $1 /* unscoped: the session's own login */`, [id]))[0] ?? null;
}

/** Why this login may not be used right now, as a sentence; null when it may. */
export function blocked(l: Login): string | null {
  if (l.tenant_status !== "active") return "This account is suspended. Your data is kept; contact your ERP provider to reopen it.";
  if (l.status === "disabled" || l.user_status !== "active") return "This sign-in has been turned off. Ask your account owner.";
  if (l.kind === "prospect" && l.expires_at && Date.parse(l.expires_at) <= Date.now()) return "This demo login has expired. Ask for a new one.";
  return null;
}

/** Owner of every company in the tenant (a client-wide owner grant). */
export async function isTenantOwner(c: Client, userId: string, tenantId: string): Promise<boolean> {
  const r = await q(c, `select 1 from role_grant g join app_user u on u.id = g.app_user_id
     where g.app_user_id = $1 and u.tenant_id = $2 and g.role = 'owner' and g.entity_id is null /* unscoped: client-wide grant */`, [userId, tenantId]);
  return r.length > 0;
}

// --------------------------------------------------------------- audit trail

export type AuditActor = { actor: string; kind: "operator" | "customer" | "token" | "system"; supportId?: string | null };
export async function audit(c: Client, who: AuditActor, action: string, tenantId: string | null, detail: Record<string, unknown> = {}, entityId: string | null = null) {
  await c.query(`insert into platform_audit (actor, actor_kind, tenant_id, entity_id, support_id, action, detail) values ($1,$2,$3,$4,$5,$6,$7)`,
    [who.actor.slice(0, 120), who.kind, tenantId, entityId, who.supportId ?? null, action, JSON.stringify(detail)]);
}

// ------------------------------------------------------------ login tokens

const LIFE: Record<"invite" | "reset" | "code", number> = { invite: 7 * 24 * 3600_000, reset: 3600_000, code: 10 * 60_000 };
const codeHash = (loginId: string, code: string) => sha256(`code:${loginId}:${code}`);

/** A new single-use token (or six-digit code). Earlier unused ones of the same purpose stop working. */
export async function issueToken(c: Client, login: { id: string; tenant_id: string }, purpose: "invite" | "reset" | "code", by: string) {
  await c.query(`update platform_login_token set retired_at = now() where login_id = $1 and purpose = $2 and used_at is null and retired_at is null`, [login.id, purpose]);
  const token = purpose === "code" ? String(randomInt(0, 1_000_000)).padStart(6, "0") : randomBytes(32).toString("base64url");
  const hash = purpose === "code" ? codeHash(login.id, token) : sha256(`${purpose}:${token}`);
  const expiresAt = new Date(Date.now() + LIFE[purpose]);
  await c.query(`insert into platform_login_token (tenant_id, login_id, purpose, token_hash, expires_at, created_by) values ($1,$2,$3,$4,$5,$6)`,
    [login.tenant_id, login.id, purpose, hash, expiresAt, by.slice(0, 120)]);
  return { token, expiresAt: expiresAt.toISOString() };
}

/** The login a link token belongs to, locked; null when it is unknown, used, replaced or out of date. */
async function tokenLogin(c: Client, token: string, purpose: "invite" | "reset", lock: boolean) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const r = await q<{ id: string; login_id: string; expires_at: Date; used_at: Date | null; retired_at: Date | null; shown_to_operator: boolean }>(c, `
    select id, login_id, expires_at, used_at, retired_at, shown_to_operator from platform_login_token
     where token_hash = $1 and purpose = $2 ${lock ? "for update" : ""} /* unscoped: a token names its own login */`, [sha256(`${purpose}:${token}`), purpose]);
  const t = r[0];
  if (!t || t.used_at || t.retired_at || t.expires_at.getTime() <= Date.now()) return null;
  return t;
}

export async function tokenInfo(c: Client, token: string) {
  for (const purpose of ["invite", "reset"] as const) {
    const t = await tokenLogin(c, token, purpose, false);
    if (!t) continue;
    const l = await loginById(c, t.login_id);
    if (!l) return null;
    return { purpose, email: l.email, name: l.name, tenant: l.tenant_name };
  }
  return null;
}

/** Set a password from an invite or reset link. One use; every older session ends. */
export async function usePasswordToken(c: Client, token: string, password: unknown, name?: unknown): Promise<Login> {
  let t = await tokenLogin(c, token, "invite", true);
  let purpose: "invite" | "reset" = "invite";
  if (!t) { t = await tokenLogin(c, token, "reset", true); purpose = "reset"; }
  need(t, "that link has expired or was already used; ask for a new one");
  const l = await loginById(c, t.login_id);
  need(l, "that link has expired or was already used; ask for a new one");
  const why = blocked(l);
  need(!why, why ?? "");
  const pw = checkPassword(password, l.email);
  await c.query(`update platform_login_token set used_at = now() where id = $1`, [t.id]);
  await c.query(`update platform_login set pw_hash = $2, password_set_at = now(), status = 'active', session_version = session_version + 1
                  where id = $1 and tenant_id = $3`, [l.id, hashPassword(pw), l.tenant_id]);
  const nm = text(name, 80);
  if (purpose === "invite" && nm.length >= 2) await c.query(`update app_user set name = $2 where id = $1 and tenant_id = $3`, [l.app_user_id, nm, l.tenant_id]);
  await audit(c, { actor: l.email, kind: "customer" }, purpose === "invite" ? "login.invite_accepted" : "login.password_reset", l.tenant_id, { login: l.id });
  // a link the ERP team handled (shown to an operator because email was not connected): the platform log and the owner's digest say so
  if (t.shown_to_operator) await audit(c, { actor: l.email, kind: "customer" }, "login.set_from_handled_link", l.tenant_id, { login: l.id, email: l.email });
  return (await loginById(c, l.id))!;
}

/** Check an emailed sign-in code: five wrong tries end it. */
export async function useCode(c: Client, login: Login, code: string): Promise<boolean> {
  const r = await q<{ id: string; token_hash: string; tries: number }>(c, `
    select id, token_hash, tries from platform_login_token
     where login_id = $1 and purpose = 'code' and used_at is null and retired_at is null and expires_at > now()
     order by created_at desc limit 1 for update /* unscoped: the login's own code */`, [login.id]);
  const t = r[0];
  if (!t) return false;
  const ok = /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(codeHash(login.id, code)), Buffer.from(t.token_hash));
  if (ok) await c.query(`update platform_login_token set used_at = now() where id = $1`, [t.id]);
  else await c.query(`update platform_login_token set tries = tries + 1, retired_at = case when tries + 1 >= 5 then now() end where id = $1`, [t.id]);
  return ok;
}

// ----------------------------------------------------------------- email

/** Platform mail goes through ERP_PLATFORM_MAIL_COMPANY's email connection when set, else the customer's own. */
async function mailVia(c: Client, entityId: string): Promise<Row | null> {
  const platform = (process.env.ERP_PLATFORM_MAIL_COMPANY ?? "").trim();
  if (UUID.test(platform)) { const r = await connectionFor(c, platform, "email"); if (r) return r; }
  return connectionFor(c, entityId, "email");
}

async function firstCompany(c: Client, tenantId: string): Promise<string | null> {
  return (await q<{ id: string }>(c, `select id from entity where tenant_id = $1 order by created_at, name limit 1 /* unscoped: the client's first company, for the message log */`, [tenantId]))[0]?.id ?? null;
}

export async function sendAccountEmail(c: Client, l: { id: string; tenant_id: string; email: string; name?: string; tenant_name?: string; last_entity_id?: string | null },
  kind: "invite" | "reset" | "code", secret: string, link: string | null, by: string) {
  const entityId = l.last_entity_id ?? await firstCompany(c, l.tenant_id);
  if (!entityId) return { status: "logged" as const, sent: false };
  const who = l.tenant_name ?? "your company";
  const m = kind === "invite"
    ? { subject: `Your sign-in for ${who}`, text: `Hello${l.name ? " " + l.name : ""},\n\n${by} set up a sign-in for you at ${who}. Choose your password here (the link works once, for 7 days):\n\n${link}\n\nIf you were not expecting this, you can ignore it.` }
    : kind === "reset"
      ? { subject: `Reset your password for ${who}`, text: `Someone asked to reset the password for ${l.email}. Choose a new one here (the link works once, for an hour):\n\n${link}\n\nIf it was not you, ignore this email; your password stays as it is.` }
      : { subject: `Your sign-in code: ${secret}`, text: `Your sign-in code is ${secret}. It works once, for 10 minutes.\n\nIf you did not ask for it, ignore this email.` };
  const via = await mailVia(c, entityId);
  const r = await queueEmail(c, entityId, { to: [l.email], subject: kind === "code" ? "Your sign-in code" : m.subject, text: m.text },
    { purpose: `platform_${kind}`, redact: [secret], resendable: false, createdBy: null }, via);
  return { status: r.status, sent: r.status === "queued" || r.status === "sent" };
}

// ---------------------------------------------------------------- customers

export const PLANS = ["trial", "standard", "multi-company", "enterprise"];
const STATE = /^[A-Z]{2}$/;

function codeFor(name: string) {
  const c = name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 4);
  return c.length >= 2 ? c : "MAIN";
}

/** A new login (invited) for a person of a tenant. */
async function newLogin(c: Client, tenantId: string, userId: string, email: string, kind: "customer" | "prospect", by: string, expiresAt: Date | null = null) {
  const taken = await q(c, `select 1 from platform_login where email = $1 /* unscoped: one email, one sign-in, across the install */`, [email]);
  need(!taken.length, `${email} already has a sign-in here; use another address`);
  return one<{ id: string; tenant_id: string; email: string }>(c, `
    insert into platform_login (tenant_id, app_user_id, email, kind, status, expires_at, created_by)
    values ($1,$2,$3,$4,'invited',$5,$6) returning id, tenant_id, email`, [tenantId, userId, email, kind, expiresAt, by.slice(0, 120)]);
}

/**
 * A new customer: the tenant, its first company with the chosen setup pack
 * (no sample data), the owner person and their sign-in, and an invite.
 */
export async function createCustomer(c: Client, who: AuditActor, input: Record<string, unknown>, base: string) {
  const tenantName = text(input.tenantName, 60), legalName = text(input.legalName, 120);
  const companyName = text(input.companyName, 60) || legalName.slice(0, 60);
  const state = text(input.state, 2).toUpperCase();
  const packId = text(input.pack, 30);
  const ownerEmail = cleanEmail(input.ownerEmail), ownerName = text(input.ownerName, 80) || ownerEmail.split("@")[0];
  const plan = text(input.plan, 30) || "standard";
  need(tenantName.length >= 2, "name the customer: the business that is buying the ERP");
  need(legalName.length >= 2, "enter the first company's legal name, as on its tax filings");
  need(STATE.test(state), "pick the company's state");
  need(PACKS.some((p) => p.id === packId), "pick a setup pack");
  need(EMAIL.test(ownerEmail), "enter the owner's email address; the invite goes there");
  need(PLANS.includes(plan), "pick a plan");
  const pack = packById(packId);
  const vertical = pack.vertical;
  const taken = await q(c, `select 1 from platform_login where email = $1 /* unscoped: one email, one sign-in */`, [ownerEmail]);
  need(!taken.length, `${ownerEmail} already has a sign-in here; use another address for this customer's owner`);

  const made = await createCompany(c, who.actor, {
    clientName: tenantName, vertical, name: companyName, legalName,
    stores: [{ code: codeFor(companyName), name: "Main store", state }],
    // The engine needs the operating account; the console asks for it, and without it the
    // row says plainly it is not set up yet (only last fours are ever kept).
    banks: [{ purpose: "operating", name: "Operating", bankName: text(input.bankName, 80) || "Not set up yet",
      routingLast4: /^\d{4}$/.test(text(input.routingLast4, 4)) ? text(input.routingLast4, 4) : "0000",
      accountLast4: /^\d{4}$/.test(text(input.accountLast4, 4)) ? text(input.accountLast4, 4) : "0000" }],
    people: [{ name: ownerName, email: ownerEmail, roles: ["owner"] }],
    // the pack is applied by createCompany itself (accounts, switches, pick lists; never sample data)
    setup: `pack:${packId}`,
  }) as { id: string; tenantId: string };
  await c.query(`update tenant set kind = 'customer', plan = $2, created_by = $3, last_activity_at = null where id = $1`, [made.tenantId, plan, who.actor]);
  const owner = await one<{ id: string }>(c, `select id from app_user where tenant_id = $1 and lower(email) = $2 /* unscoped: the new client's owner */`, [made.tenantId, ownerEmail]);
  await c.query(`insert into role_grant (app_user_id, entity_id, role) values ($1, null, 'owner') on conflict do nothing`, [owner.id]);

  const login = await newLogin(c, made.tenantId, owner.id, ownerEmail, "customer", who.actor);
  const { token } = await issueToken(c, login, "invite", who.actor);
  const link = `${base}/#invite=${token}`;
  const mail = await sendAccountEmail(c, { ...login, name: ownerName, tenant_name: tenantName }, "invite", token, link, who.actor);
  await audit(c, who, "customer.create", made.tenantId, { tenantName, companyName, pack: packId, plan, owner: ownerEmail, emailed: mail.sent }, made.id);
  return { tenantId: made.tenantId, entityId: made.id, ownerId: owner.id, loginId: login.id, pack: pack.id,
    ...(await linkForOperator(c, who, made.tenantId, { inviteLink: link, emailed: mail.sent }, ownerEmail)) };
}

/**
 * Review of 0066: an invite link handed to an operator lets whoever holds it set that person's password, an
 * identity that is not support mode. So an operator sees the link only when it could not be emailed (no email
 * connected yet, the onboarding case), and the platform log says it was shown. Once email works, invites go to
 * the person's own inbox only.
 */
async function linkForOperator<R extends { inviteLink: string | null; emailed: boolean }>(c: Client, who: AuditActor, tenantId: string, r: R, email: string): Promise<R> {
  if (!r.inviteLink) return r;
  if (r.emailed) return { ...r, inviteLink: null, note: `The invite went to ${email} by email; it works once, for 7 days.` };
  // the install-wide token is a key, not a person on the ERP team: it never receives an invite link (final review of 0066)
  if (who.kind === "system") return { ...r, inviteLink: null, note: `Email is not connected, so the invite to ${email} was not sent; an operator signed in can hand the link over.` };
  // the token behind the link is marked, so a password set from it is told to the owner (login.set_from_handled_link)
  const tok = /#invite=([A-Za-z0-9_-]+)$/.exec(r.inviteLink)?.[1];
  if (tok) await c.query(`update platform_login_token set shown_to_operator = true where token_hash = $1 and purpose = 'invite' and tenant_id = $2`, [sha256(`invite:${tok}`), tenantId]);
  await audit(c, who, "invite.link_shown", tenantId, { email, why: "no email connected, so the operator hands the link over" });
  return r;
}

/**
 * A tenant owner (or an operator) adds someone: a person with roles in one company, and an invite.
 *
 * An email can sign in to one tenant only. A tenant owner is never told that an
 * address belongs to another customer: the answer is the same either way, no
 * link is shown (it goes by email, or the ERP team hands it over), and the
 * person and their roles are kept here; the clash is on the platform log for
 * the ERP team. An operator (reveal) gets the link and is told plainly.
 */
export async function inviteUser(c: Client, who: AuditActor, tenantId: string, input: Record<string, unknown>, base: string, opts: { reveal?: boolean } = {}) {
  const email = cleanEmail(input.email), name = text(input.name, 80);
  need(EMAIL.test(email), "enter their email address; the invite goes there");
  need(name.length >= 2, "enter their name");
  const entityId = typeof input.entityId === "string" && UUID.test(input.entityId) ? input.entityId : null;
  need(entityId, "pick the company they work in");
  const co = await q<{ id: string }>(c, `select id from entity where id = $1 and tenant_id = $2 /* unscoped: a company of this client */`, [entityId, tenantId]);
  need(co.length, "that company is not one of yours");
  const allowed = ["owner", "controller", "approver", "ap_clerk", "viewer", "store_manager", "sales", "cashier", "buyer", "warehouse", "dispatcher", "driver", "ar_clerk", "hr", "web_admin", "marketing", "technician", "designer"];
  const roles = [...new Set((Array.isArray(input.roles) ? input.roles : []).map(String).filter((r) => allowed.includes(r)))];
  need(roles.length, "give them at least one role");
  if (opts.reveal) {
    // an operator never makes an owner (beyond the first, made with the customer): an owner the ERP team could sign in as is not support mode
    need(!roles.includes("owner"), "the ERP team does not add owners; the account owner adds another owner from Account, signed in as themselves");
    const elsewhere = await q(c, `select 1 from platform_login where email = $1 and tenant_id <> $2 /* unscoped: one email, one sign-in */`, [email, tenantId]);
    need(!elsewhere.length, `${email} already signs in to another customer's account; use another address`);
  }
  const found = await q<{ id: string }>(c, `select id from app_user where tenant_id = $1 and lower(email) = $2 /* unscoped: people belong to the client */`, [tenantId, email]);
  const userId = found[0]?.id ?? (await one<{ id: string }>(c, `insert into app_user (tenant_id, email, name) values ($1,$2,$3) returning id`, [tenantId, email, name])).id;
  for (const r of roles) await c.query(`insert into role_grant (app_user_id, entity_id, role) values ($1,$2,$3) on conflict do nothing`, [userId, entityId, r]);
  const existing = await q<{ status: string }>(c, `select status from platform_login where app_user_id = $1 /* unscoped: the person's sign-in */`, [userId]);
  need(!existing[0] || existing[0].status !== "active", `${email} already signs in here; their new roles are in place`);
  const sent = await inviteFor(c, who, tenantId, userId, base, "user.invite", { roles, entityId }, entityId);
  return opts.reveal ? { userId, ...(await linkForOperator(c, who, tenantId, sent, email)) } : { userId, ...neutral(sent) };
}

/** What a tenant owner is told about an invite: the same whatever became of it. */
function neutral(r: { emailed: boolean; connected: boolean }) {
  return { ok: true, note: r.connected ? "The invite is on its way by email. It works once, for 7 days."
    : "Email is not connected yet, so the invite was not sent. Connect email under Connections, or ask the ERP team for the link." };
}

/** An invite for a person of this tenant: their sign-in (made if they have none) and a fresh link. */
async function inviteFor(c: Client, who: AuditActor, tenantId: string, userId: string, base: string, action: string, detail: Record<string, unknown>, entityId: string | null) {
  const u = await one<{ email: string; name: string; tenant_name: string }>(c, `select u.email, u.name, t.name as tenant_name from app_user u join tenant t on t.id = u.tenant_id
     where u.id = $1 and u.tenant_id = $2 /* unscoped: the client's person */`, [userId, tenantId]);
  const email = cleanEmail(u.email);
  const co = entityId ?? await firstCompany(c, tenantId);
  const connected = !!(co && await mailVia(c, co));
  const existing = await q<{ id: string; tenant_id: string; email: string; status: string }>(c, `select id, tenant_id, email, status from platform_login where app_user_id = $1 /* unscoped: the person's sign-in */`, [userId]);
  if (!existing[0]) {
    const elsewhere = await q(c, `select 1 from platform_login where email = $1 /* unscoped: one email, one sign-in */`, [email]);
    if (elsewhere.length) {
      await audit(c, who, "user.invite_conflict", tenantId, { email, ...detail }, entityId);
      return { loginId: null, inviteLink: null, emailed: false, connected };
    }
  }
  const login = existing[0] ?? await newLogin(c, tenantId, userId, email, "customer", who.actor);
  need(login.status !== "active", "they have already set a password; they can reset it from the sign-in page");
  const { token } = await issueToken(c, login, "invite", who.actor);
  const link = `${base}/#invite=${token}`;
  const mail = await sendAccountEmail(c, { ...login, name: u.name, tenant_name: u.tenant_name, last_entity_id: entityId }, "invite", token, link, who.actor);
  await audit(c, who, action, tenantId, { email, emailed: mail.sent, ...detail }, entityId);
  return { loginId: login.id, inviteLink: link, emailed: mail.sent, connected };
}

/** A fresh invite for someone who has not set a password yet (id: their sign-in, or the person when they have none). */
export async function reinvite(c: Client, who: AuditActor, tenantId: string, id: string, base: string, opts: { reveal?: boolean } = {}) {
  need(UUID.test(id), "no such person");
  const r = await q<{ user_id: string }>(c, `select u.id as user_id from app_user u left join platform_login l on l.app_user_id = u.id
     where u.tenant_id = $1 and (l.id = $2 or u.id = $2) /* unscoped: the client's person or sign-in */`, [tenantId, id]);
  need(r.length, "no such person");
  const sent = await inviteFor(c, who, tenantId, r[0].user_id, base, "user.reinvite", {}, null);
  if (opts.reveal) {
    need(sent.inviteLink, "that email already signs in to another customer's account; change their email first");
    const em = (await one<{ email: string }>(c, `select email from app_user where id = $1 and tenant_id = $2 /* unscoped: the client's person */`, [r[0].user_id, tenantId])).email;
    return linkForOperator(c, who, tenantId, sent, em);
  }
  return neutral(sent);
}

export async function setLoginStatus(c: Client, who: AuditActor, tenantId: string, loginId: string, on: boolean, selfUserId: string | null) {
  const l = await loginById(c, loginId);
  need(l && l.tenant_id === tenantId, "no such sign-in");
  need(!on || l.pw_hash, "they have not set a password yet; send them a new invite instead");
  need(on || l.app_user_id !== selfUserId, "you cannot turn off your own sign-in");
  await c.query(`update platform_login set status = $3, session_version = session_version + 1 where id = $1 and tenant_id = $2`, [loginId, tenantId, on ? "active" : "disabled"]);
  await audit(c, who, on ? "user.enable" : "user.disable", tenantId, { email: l.email });
  return { ok: true };
}

/** Everyone in the tenant with their sign-in; someone with none yet reads as invited (id is then the person's). */
export async function users(c: Client, tenantId: string) {
  return q(c, `
    select coalesce(l.id, u.id) as id, coalesce(l.email, lower(u.email)) as email, coalesce(l.kind, 'customer') as kind,
           coalesce(l.status, 'invited') as status, l.last_sign_in_at, l.expires_at, u.id as person_id, u.name,
           coalesce((select json_agg(json_build_object('company', coalesce(e.name, 'Every company'), 'role', g.role) order by e.name, g.role)
                       from role_grant g left join entity e on e.id = g.entity_id where g.app_user_id = u.id), '[]') as roles
      from app_user u left join platform_login l on l.app_user_id = u.id
     where u.tenant_id = $1 and u.status = 'active' and coalesce(l.kind, 'customer') <> 'prospect'
     order by u.name /* unscoped: the client's people and sign-ins */`, [tenantId]);
}

export async function setTenantStatus(c: Client, who: AuditActor, tenantId: string, status: "active" | "suspended", reason: unknown) {
  const why = text(reason, 300);
  const t = await q<{ name: string; kind: string; status: string }>(c, `select name, kind, status from tenant where id = $1 for update /* unscoped: the client */`, [tenantId]);
  need(t.length, "no such customer");
  need(t[0].kind !== "demo" || status === "active", "the demo cannot be suspended; reset it instead");
  need(t[0].status !== status, status === "suspended" ? `${t[0].name} is already suspended` : `${t[0].name} is already active`);
  need(status === "active" || why.length >= 3, "say why the customer is being suspended");
  await c.query(`update tenant set status = $2, status_reason = $3, status_changed_at = now(), status_changed_by = $4 where id = $1`, [tenantId, status, why || null, who.actor]);
  // Every session of theirs ends now; their tokens stop working while suspended (checked at the door).
  await c.query(`update platform_login set session_version = session_version + 1 where tenant_id = $1`, [tenantId]);
  await audit(c, who, status === "suspended" ? "customer.suspend" : "customer.reactivate", tenantId, { reason: why });
  return { status };
}

/**
 * Setup mode per company of a customer (0066): live (gone live or begun trading), when its 60 days end (they
 * start at the first setup approval; null: none yet) and the whole days left. For the Operator console's
 * countdown chip and the support banner.
 */
export async function setupStatus(c: Client, tenantId: string) {
  return q<{ entityId: string; company: string; live: boolean; endsAt: string | null; daysLeft: number | null }>(c, `
    select e.id "entityId", e.name company, company_went_live(e.id) live, setup_window_end(e.id)::text "endsAt",
           case when setup_window_end(e.id) is null then null
                else greatest(0, ceil(extract(epoch from setup_window_end(e.id) - now()) / 86400))::int end "daysLeft"
      from entity e where e.tenant_id = $1 and e.status <> 'closed' order by e.name /* unscoped: the client's companies */`, [tenantId]);
}

export async function customers(c: Client) {
  return q(c, `
    select t.id, t.name, t.kind, t.status, t.plan, t.vertical, t.created_at, t.status_reason,
           greatest(t.last_activity_at, (select max(l.last_sign_in_at) from platform_login l where l.tenant_id = t.id)) as last_activity,
           (select count(*) from entity e where e.tenant_id = t.id and e.status <> 'closed')::int as companies,
           (select count(*) from location lo join entity e on e.id = lo.entity_id where e.tenant_id = t.id and lo.status = 'active')::int as stores,
           (select count(*) from platform_login l where l.tenant_id = t.id and l.status <> 'disabled')::int as users,
           (select count(*) from app_user u where u.tenant_id = t.id and u.status = 'active')::int as people,
           (select coalesce(array_agg(distinct m.module order by m.module), '{}') from entity_module m join entity e on e.id = m.entity_id
             where e.tenant_id = t.id and m.enabled) as services,
           (select coalesce(jsonb_agg(jsonb_build_object('company', e.name, 'live', company_went_live(e.id),
                     'daysLeft', case when setup_window_end(e.id) is null then null
                                      else greatest(0, ceil(extract(epoch from setup_window_end(e.id) - now()) / 86400))::int end) order by e.name), '[]'::jsonb)
              from entity e where e.tenant_id = t.id and e.status <> 'closed') as setup
      from tenant t
     order by (t.kind = 'demo'), t.name /* unscoped: the operator's list of every customer */`);
}

export async function customerDetail(c: Client, tenantId: string) {
  const t = (await customers(c)).find((x) => x.id === tenantId);
  need(t, "no such customer");
  const companies = await q(c, `select e.id, e.name, e.legal_name, e.status,
      (select string_agg(distinct p.pack, ', ') from pack_application p where p.entity_id = e.id) as packs
      from entity e where e.tenant_id = $1 order by e.name /* unscoped: the client's companies */`, [tenantId]);
  const recent = await q(c, `select at, actor, actor_kind, action, detail from platform_audit where tenant_id = $1 order by at desc limit 30 /* unscoped: the client's platform log */`, [tenantId]);
  const stores = await q(c, `select lo.id, lo.code, lo.name, lo.state, lo.kind, e.name as company from location lo join entity e on e.id = lo.entity_id
      where e.tenant_id = $1 and lo.status = 'active' order by e.name, lo.name /* unscoped: the client's stores */`, [tenantId]);
  const tokens = await q(c, `select count(*)::int as n from platform_api_token where tenant_id = $1 and status = 'active' /* unscoped: the client's tokens */`, [tenantId]);
  // review of 0066: tokens made (or rotated) by an operator in support mode, flagged so the ERP team revokes them with the owner
  const madeInSupport = await q(c, `select a.at, a.actor, a.detail->>'name' as name, a.detail->>'id' as id,
      exists (select 1 from platform_api_token k where k.id::text = a.detail->>'id' and k.status = 'active') as active
      from platform_audit a where a.tenant_id = $1 and a.action = 'token.create' and a.support_id is not null order by a.at desc /* unscoped: the client's platform log */`, [tenantId]);
  return { ...t, companiesList: companies, storesList: stores, users: await users(c, tenantId), activeTokens: tokens[0].n, tokensMadeInSupport: madeInSupport, recent };
}

// ------------------------------------------------------------- support mode

export async function startSupport(c: Client, operator: string, tenantId: string, reason: unknown) {
  const why = text(reason, 500);
  need(why.length >= 3, "say why you are entering this customer's account; it goes on their record");
  const t = await q<{ name: string }>(c, `select name from tenant where id = $1 /* unscoped: the client */`, [tenantId]);
  need(t.length, "no such customer");
  await c.query(`update platform_support_session set ended_at = now(), ended_by = $1 where operator = $1 and ended_at is null`, [operator]);
  const s = await one<{ id: string }>(c, `insert into platform_support_session (tenant_id, operator, reason) values ($1,$2,$3) returning id`, [tenantId, operator, why]);
  await audit(c, { actor: operator, kind: "operator", supportId: s.id }, "support.start", tenantId, { reason: why });
  return { id: s.id, tenantId, tenantName: t[0].name };
}

export async function endSupport(c: Client, operator: string, supportId: string) {
  const r = await q<{ tenant_id: string }>(c, `update platform_support_session set ended_at = now(), ended_by = $2 where id = $1 and ended_at is null returning tenant_id /* unscoped: the operator's own support session */`, [supportId, operator]);
  if (r.length) await audit(c, { actor: operator, kind: "operator", supportId }, "support.end", r[0].tenant_id);
  return { ok: true };
}

export async function supportSession(c: Client, id: string, operator: string) {
  if (!UUID.test(id)) return null;
  return (await q<{ id: string; tenant_id: string; tenant_name: string; started_at: string; reason: string }>(c, `
    select s.id, s.tenant_id, t.name as tenant_name, s.started_at::text, s.reason from platform_support_session s join tenant t on t.id = s.tenant_id
     where s.id = $1 and s.operator = $2 and s.ended_at is null and s.started_at > now() - interval '12 hours' /* unscoped: the operator's own support session */`, [id, operator]))[0] ?? null;
}

// ---------------------------------------------------------------- API tokens

export const API_TOKEN_PREFIX = "erpt_";

export async function apiTokens(c: Client, tenantId: string) {
  // made_in_support: made (or rotated) by an operator in a support session, before that was refused (review of 0066)
  return q(c, `select k.id, k.name, k.prefix, k.status, k.created_at, k.created_by, k.revoked_at, k.revoked_by, k.last_used_at,
                      exists (select 1 from platform_audit a where a.tenant_id = k.tenant_id and a.action = 'token.create' and a.support_id is not null
                               and a.detail->>'id' = k.id::text) as made_in_support
                 from platform_api_token k
                where k.tenant_id = $1 order by k.status, k.created_at desc /* unscoped: the client's tokens */`, [tenantId]);
}

export async function createApiToken(c: Client, who: AuditActor, tenantId: string, name: unknown) {
  const nm = text(name, 60);
  need(nm.length >= 2, "name the token after what uses it, like Catalog app");
  const dupe = await q(c, `select 1 from platform_api_token where tenant_id = $1 and lower(name) = lower($2) and status = 'active' /* unscoped: the client's tokens */`, [tenantId, nm]);
  need(!dupe.length, `there is already an active token called ${nm}; rotate it instead`);
  const token = API_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const r = await one<{ id: string }>(c, `insert into platform_api_token (tenant_id, name, token_hash, prefix, created_by) values ($1,$2,$3,$4,$5) returning id`,
    [tenantId, nm, sha256(token), token.slice(0, API_TOKEN_PREFIX.length + 6), who.actor]);
  await audit(c, who, "token.create", tenantId, { name: nm, id: r.id });
  return { id: r.id, name: nm, token };
}

export async function revokeApiToken(c: Client, who: AuditActor, tenantId: string, id: string, replacedBy: string | null = null) {
  const r = await q<{ name: string }>(c, `update platform_api_token set status = 'revoked', revoked_at = now(), revoked_by = $3, replaced_by = $4
     where id = $1 and tenant_id = $2 and status = 'active' returning name /* unscoped: one of the client's tokens */`, [id, tenantId, who.actor, replacedBy]);
  need(r.length, "no such active token");
  await audit(c, who, replacedBy ? "token.rotate" : "token.revoke", tenantId, { name: r[0].name, id });
  return { ok: true };
}

export async function rotateApiToken(c: Client, who: AuditActor, tenantId: string, id: string) {
  const old = await q<{ name: string }>(c, `select name from platform_api_token where id = $1 and tenant_id = $2 and status = 'active' for update /* unscoped: one of the client's tokens */`, [id, tenantId]);
  need(old.length, "no such active token");
  await c.query(`update platform_api_token set name = name || ' (old ' || to_char(now(), 'YYYY-MM-DD HH24:MI') || ')' where id = $1 and tenant_id = $2`, [id, tenantId]);
  const made = await createApiToken(c, who, tenantId, old[0].name);
  await revokeApiToken(c, who, tenantId, id, made.id);
  return made;
}

/** The tenant a presented token belongs to, if it is live and its tenant active. */
export async function tokenWho(c: Client, presented: string) {
  if (!presented.startsWith(API_TOKEN_PREFIX) || presented.length > 120) return null;
  const r = await q<{ id: string; tenant_id: string; name: string; tenant_status: string }>(c, `
    select k.id, k.tenant_id, k.name, t.status as tenant_status from platform_api_token k join tenant t on t.id = k.tenant_id
     where k.token_hash = $1 and k.status = 'active' /* unscoped: a token names its own tenant */`, [sha256(presented)]);
  const k = r[0];
  if (!k || k.tenant_status !== "active") return null;
  await c.query(`update platform_api_token set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '5 minutes')`, [k.id]);
  return { tokenId: k.id, tenantId: k.tenant_id, name: k.name };
}

// ---------------------------------------------------------------- prospects

/** A demo login for a sales prospect: owner of the demo, for a few days. The password is shown once. */
export async function createProspect(c: Client, who: AuditActor, input: Record<string, unknown>) {
  const email = cleanEmail(input.email), name = text(input.name, 80);
  const days = Number(input.days ?? 7);
  need(name.length >= 2, "enter the prospect's name");
  need(EMAIL.test(email), "enter the prospect's email address");
  need(Number.isInteger(days) && days >= 1 && days <= 30, "a demo login lasts 1 to 30 days");
  const tenantId = DEMO_TENANTS[0];
  const t = await q<{ kind: string }>(c, `select kind from tenant where id = $1 /* unscoped: the demo */`, [tenantId]);
  need(t.length && t[0].kind === "demo", "there is no demo loaded; reset the demo first");
  const dupe = await q(c, `select 1 from app_user where tenant_id = $1 and lower(email) = $2 /* unscoped: the demo's people */`, [tenantId, email]);
  need(!dupe.length, `${email} is already a person in the demo; use another address`);
  const u = await one<{ id: string }>(c, `insert into app_user (tenant_id, email, name) values ($1,$2,$3) returning id`, [tenantId, email, `${name} (demo)`]);
  await c.query(`insert into role_grant (app_user_id, entity_id, role) values ($1, null, 'owner')`, [u.id]);
  const expires = new Date(Date.now() + days * 86400_000);
  const login = await newLogin(c, tenantId, u.id, email, "prospect", who.actor, expires);
  const password = randomBytes(9).toString("base64url");
  await c.query(`update platform_login set pw_hash = $2, password_set_at = now(), status = 'active' where id = $1 and tenant_id = $3`, [login.id, hashPassword(password), tenantId]);
  await audit(c, who, "prospect.create", tenantId, { email, days });
  return { loginId: login.id, email, password, expiresAt: expires.toISOString() };
}

export async function prospects(c: Client) {
  return q(c, `select l.id, l.email, u.name, l.status, l.expires_at, l.last_sign_in_at, (l.expires_at <= now()) as expired
                 from platform_login l join app_user u on u.id = l.app_user_id where l.kind = 'prospect' order by l.expires_at desc /* unscoped: every demo login */`);
}

export async function endProspect(c: Client, who: AuditActor, loginId: string) {
  const r = await q<{ email: string; tenant_id: string }>(c, `update platform_login set expires_at = least(expires_at, now()), session_version = session_version + 1
     where id = $1 and kind = 'prospect' returning email, tenant_id /* unscoped: a demo login */`, [loginId]);
  need(r.length, "no such demo login");
  await audit(c, who, "prospect.end", r[0].tenant_id, { email: r[0].email });
  return { ok: true };
}

export const packs = () => PACKS.map((p) => ({ id: p.id, name: p.name, blurb: p.blurb, vertical: p.vertical }));
