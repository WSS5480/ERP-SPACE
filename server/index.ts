// The ERP's front door: an HTTP service over the core, with nothing clever in it.
//
// It runs migrations when it starts, so a fresh database becomes a working one
// without anyone touching it. It serves the app -- every company the operator
// keeps books for, each with its home, approvals, payables, payroll, books,
// cash, reconciliation and feeds -- and the API behind it. And it gives every
// push channel a real door: hand upload, signed webhooks, and inbound email.
//
// Security posture, stated plainly because this holds financial data:
//
//   It refuses to start without an API token of real length. There is no
//   "open by default" mode to forget to turn off.
//
//   Every /api route needs either that token (scripts) or a signed-in
//   browser session (people). /health is the only other public data route
//   and it returns no business data. The page and its script are public, but
//   they are only a shell: every number comes from /api after sign-in.
//
//   Signing in takes the same token plus the person's name. The session is a
//   cookie the browser cannot read from script, sent only to this site, and
//   signed with a key derived from the token -- rotate the token in Render and
//   every session ends. Anything that changes data from a browser must also
//   carry a header a cross-site form cannot send.
//
//   Every change names the person it is done as, and that person has to be
//   one of the company's own. The engine then applies that person's roles:
//   the maker is never the checker, whoever builds a run cannot release it.
//
//   Webhooks are not bearer-authenticated -- the sender cannot hold our token
//   -- so each one must carry an HMAC signature made with that connection's
//   own secret. A webhook connection with no secret configured refuses
//   everything, rather than accepting everything.
//
//   Inbound email has its own token, and then each message still has to come
//   from an allow-listed sender for the mailbox it was addressed to.
//
//   Secrets live in environment variables named from the connection's
//   credential_ref, never in the database.
//
// People sign in two ways (server/platform.ts holds the accounts):
//
//   Customer users -- a business that bought the ERP -- sign in with an email
//   and a password (scrypt, salted per user) and see only their own tenant's
//   companies, as themselves, with their own roles. A tenant owner may
//   preview another of their people's view, read-only.
//
//   Platform operators (the developer team) sign in with a name and a password
//   from ERP_LOGINS. They run the Operator console and see a customer's
//   companies only in support mode, which is recorded and shows a banner;
//   "act as" exists only there.
//
// Every route that names a company resolves it from the URL and refuses it
// (as "no such company") when it is outside what the session may open.

import { today as bizToday } from "../packages/core/clock.ts";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pool, tx, q, markSupport, type Scope, type Client } from "../packages/core/db.ts";
import {
  ingest, loadConnection, openQuarantine, releaseQuarantine, handlerFor,
  ChannelRefused, type Offered, type Connection,
} from "../packages/core/connections.ts";
import { ApprovalError } from "../packages/core/approvals.ts";
import { TransitionError } from "../packages/core/invoice.ts";
import { PayrollError } from "../packages/core/payroll.ts";
import { BankingError } from "../packages/core/banking.ts";
import { ReconcileError } from "../packages/core/reconcile.ts";
import "../packages/core/statements.ts"; // registers the bank_statement handler
import { receiveMail as receiveVendorMail, type InboundMail } from "../packages/core/vendor_files.ts"; // and the vendor_files one
import { migrate } from "../scripts/migrate.ts";
import * as views from "./views.ts";
import * as act from "./actions.ts";
import { ActionError, rolesOf, type Actor } from "./actions.ts";
import * as P from "./platform.ts";
import { PlatformError } from "./platform.ts";
import { resetDemo, DemoResetError } from "../packages/core/platform_demo.ts";
import { clientIp, describeClientIp } from "./client_ip.ts";
import { recordError, installProcessHandlers, onFatal, listErrors, errorByRef } from "./errors.ts";
import { startScheduler, queueJob, jobById, jobsView, runsView, runDetail } from "./scheduler.ts";
import { PeriodError } from "../packages/core/periods.ts";
import { loadSampleActivity } from "./sample.ts";
import { MODULES } from "./modules/index.ts";
import { ModuleError, PublicPage, PublicAsset, Download, markLookOnly } from "./modules/kit.ts";
import { InventoryError } from "../packages/core/inventory.ts";
import { ArError } from "../packages/core/ar.ts";
import { PostingError } from "../packages/core/posting.ts";
import { PricingError } from "../packages/core/pricing.ts";
import { SetupError } from "../packages/core/setup.ts";
import { PosError } from "../packages/core/pos.ts";
import { TaxError } from "../packages/core/tax.ts";
import { WorkforceError } from "../packages/core/workforce.ts";

const PORT = Number(process.env.PORT ?? 10000);
// Read when used, not when loaded, so a check can set them before it starts a server.
const TOKEN = () => process.env.ERP_API_TOKEN ?? "";
const EMAIL_TOKEN = () => process.env.ERP_EMAIL_INBOUND_TOKEN ?? "";
// There is no install-wide company any more: each person opens on their own
// last (or first) company. ERP_ENTITY_ID stays only as the default for the
// system token and for an operator, when it is a company they may open.
const DEV_ENTITY = () => (process.env.ERP_ENTITY_ID ?? "").trim();
const TRIAL = process.env.ERP_SEED === "placeholder";
const TRIAL_ENDS = process.env.ERP_TRIAL_ENDS ?? "";
const VERSION = (process.env.RENDER_GIT_COMMIT ?? "").slice(0, 7) || "dev";
const MAX_BODY = 20 * 1024 * 1024;
const STARTED = new Date().toISOString();

const SESSION_COOKIE = "erp_session";
const SESSION_HOURS = 12;

const here = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ helpers

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A page rather than JSON. */
class Html {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** A static file, served as-is. */
class Asset {
  text: string | Buffer;
  type: string;
  constructor(text: string | Buffer, type: string) {
    this.text = text;
    this.type = type;
  }
}

/** Whatever went wrong, as words -- including the errors that arrive with none. */
export function describeError(e: unknown): string {
  if (e instanceof AggregateError && e.errors?.length) {
    return [...new Set(e.errors.map(describeError).filter(Boolean))].join("; ");
  }
  const err = e as { message?: string; code?: string } | null;
  const msg = (err?.message ?? "").trim();
  if (msg) return msg;
  if (err?.code) return `error code ${err.code}`;
  return String(e);
}

// Hashing both sides first means a wrong guess learns nothing about length.
const safeEqual = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** credential_ref "secret://sftp/first-valley/demo" -> env ERP_SECRET_SFTP_FIRST_VALLEY_DEMO */
export function secretEnvName(ref: string): string {
  return "ERP_SECRET_" + ref.replace(/^secret:\/\//i, "").toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
const secretFor = (ref: string): string => process.env[secretEnvName(ref)] ?? "";

type Headers = Record<string, string | string[]>;

const BASE_HEADERS: Headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

function json(res: http.ServerResponse, status: number, body: unknown, extra: Headers = {}): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  res.writeHead(status, { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", ...extra });
  res.end(text);
}

function page(res: http.ServerResponse, status: number, text: string, nonce: string, extra: Headers = {}): void {
  res.writeHead(status, {
    ...BASE_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'self'",
      `style-src 'self' 'nonce-${nonce}'`,
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "x-frame-options": "DENY",
    "strict-transport-security": "max-age=31536000",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    ...extra,
  });
  res.end(text);
}

async function readBody(req: http.IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      throw new HttpError(413, limit === MAX_BODY ? "file too large; the limit is 20 MB" : "request too large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** JSON bodies are 256 KB unless a route asks for more (room photos: 3 MB), never more than MAX_BODY. */
export const JSON_LIMIT = 256 * 1024;
async function readJson(req: http.IncomingMessage, limit = JSON_LIMIT): Promise<Record<string, unknown>> {
  const raw = await readBody(req, Math.min(limit, MAX_BODY - 1));
  if (!raw.length) return {};
  try {
    const v = JSON.parse(raw.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    throw new HttpError(400, "that is not JSON");
  }
}

function bearer(req: http.IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

// ------------------------------------------------------------------ sessions

// A separate key for signing sessions, derived from the token, so the token
// itself never signs anything a browser holds.
const sessionKey = () => createHmac("sha256", TOKEN()).update("erp/session/v1").digest();

function cleanName(v: unknown): string {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** What a session cookie carries: n name, e expiry; k 'o' operator (s: support session) or 'c' customer (l login, v version). */
type CookieData = { n: string; e: number; k?: "o" | "c"; s?: string; l?: string; v?: number; t?: 1 };

function sessionCookie(d: CookieData): string {
  const payload = Buffer.from(JSON.stringify(d)).toString("base64url");
  const sig = createHmac("sha256", sessionKey()).update(payload).digest("base64url");
  return `${SESSION_COOKIE}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`;
}

const CLEAR_COOKIE = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

function cookieValue(req: http.IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

export function sessionFrom(req: http.IncomingMessage): (CookieData & { name: string; exp: number }) | null {
  const raw = cookieValue(req, SESSION_COOKIE);
  const dot = raw.indexOf(".");
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const expected = createHmac("sha256", sessionKey()).update(payload).digest("base64url");
  if (!safeEqual(raw.slice(dot + 1), expected)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof d.e !== "number" || d.e * 1000 <= Date.now()) return null;
    return { ...d, name: cleanName(d.n) || "Operator", exp: d.e };
  } catch {
    return null;
  }
}

type Support = { id: string; tenantId: string; tenantName: string; since: string; reason: string };
type Who =
  | { via: "token"; kind: "system"; name: string }
  | { via: "apitoken"; kind: "tenant"; name: string; tenantId: string; tokenId: string }
  | { via: "session"; kind: "operator"; name: string; exp: number; support: Support | null; tk?: 1 }
  | { via: "session"; kind: "customer"; name: string; exp: number; loginId: string; userId: string; tenantId: string;
      tenantName: string; tenantKind: string; email: string; prospect: boolean; expiresAt: string | null };

async function authenticate(req: http.IncomingMessage): Promise<Who | null> {
  const presented = bearer(req);
  // A script that sends a wrong token is refused outright, not quietly
  // judged by whatever cookie happens to ride along.
  if (presented) {
    if (presented.startsWith(P.API_TOKEN_PREFIX)) {
      const c = await pool.connect();
      try {
        const t = await P.tokenWho(c, presented);
        return t ? { via: "apitoken", kind: "tenant", name: `API token ${t.name}`, tenantId: t.tenantId, tokenId: t.tokenId } : null;
      } finally { c.release(); }
    }
    return safeEqual(presented, TOKEN()) ? { via: "token", kind: "system", name: "API token" } : null;
  }
  const s = sessionFrom(req);
  if (!s) return null;
  if (s.k === "c") {
    const c = await pool.connect();
    try {
      const l = s.l ? await P.loginById(c, s.l) : null;
      if (!l || l.session_version !== s.v || l.status !== "active" || P.blocked(l)) return null;
      return { via: "session", kind: "customer", name: l.name, exp: s.exp, loginId: l.id, userId: l.app_user_id, tenantId: l.tenant_id,
        tenantName: l.tenant_name, tenantKind: l.tenant_kind, email: l.email, prospect: l.kind === "prospect", expiresAt: l.expires_at };
    } finally { c.release(); }
  }
  // An operator. Cookies from before customers existed carry no kind and are operators too.
  // An operator taken out of ERP_LOGINS (or still on a short key) is signed out at once, not
  // 12 hours later; a sign-in made with the install token (t) lasts until that token rotates.
  if (s.t !== 1) {
    const stored = operatorLogins().get(s.name.toLowerCase());
    if (!stored || (!stored.startsWith("scrypt$") && stored.length < P.MIN_PASSWORD && !devShortKeys())) return null;
  }
  let support: Support | null = null;
  if (s.s) {
    const c = await pool.connect();
    try {
      const r = await P.supportSession(c, s.s, s.name);
      if (r) support = { id: r.id, tenantId: r.tenant_id, tenantName: r.tenant_name, since: r.started_at, reason: r.reason };
    } finally { c.release(); }
  }
  return { via: "session", kind: "operator", name: s.name, exp: s.exp, support, ...(s.t === 1 ? { tk: 1 as const } : {}) };
}

/** What the audit trail records as the actor, when nobody has been chosen. */
const labelFor = (who: Who | null, apiLabel: string): string =>
  who?.via === "session" ? `${who.name} (${who.kind === "operator" && who.support ? "support" : "web"})` : who?.kind === "tenant" ? who.name : apiLabel;

const auditActor = (who: Who | null): P.AuditActor =>
  !who || who.kind === "system" ? { actor: "api", kind: "system" }
    : who.kind === "tenant" ? { actor: who.name, kind: "token" }
      : who.kind === "operator" ? { actor: who.name, kind: "operator", supportId: who.support?.id ?? null }
        : { actor: who.email, kind: "customer" };

// ------------------------------------------------------------ sign-in brakes
//
// Wrong passwords are counted per name (or email) AND address, and per
// address. A name locks for 15 minutes after 5 wrong tries from one address;
// an address that keeps failing waits longer each time (up to 8 seconds) and
// is refused for 15 minutes after 40. Nothing counted against one address
// ever stops a correct password from another, and there is no install-wide
// lock: made-up names cannot lock out the real ones. The counts live in
// platform_signin_attempt (hashed keys), so a restart does not reset them.
const FAIL_MIN = 15;
const keyHash = (key: string) => createHash("sha256").update(`erp/brake/${key}`).digest("hex");
async function failsOf(key: string, windowMin = FAIL_MIN): Promise<number> {
  const r = await pool.query<{ n: number }>(`select n from platform_signin_attempt where key_hash = $1 and since > now() - make_interval(mins => $2)
     /* unscoped: sign-in brakes are install-wide */`, [keyHash(key), windowMin]);
  return r.rows[0]?.n ?? 0;
}
async function noteFail(key: string, windowMin = FAIL_MIN): Promise<void> {
  await pool.query(`insert into platform_signin_attempt (key_hash, n, since) values ($1, 1, now())
     on conflict (key_hash) do update set
       n = case when platform_signin_attempt.since > now() - make_interval(mins => $2) then platform_signin_attempt.n + 1 else 1 end,
       since = case when platform_signin_attempt.since > now() - make_interval(mins => $2) then platform_signin_attempt.since else now() end`,
    [keyHash(key), windowMin]);
  // old rows go now and then
  if (Math.random() < 0.02) await pool.query(`delete from platform_signin_attempt where since < now() - interval '2 days' /* unscoped: housekeeping */`);
}
const userKey = (name: string, ip: string) => `u:${name.toLowerCase()}|${ip}`;
const ipKey = (ip: string) => `ip:${ip}`;
const USER_LIMIT = 5, IP_LIMIT = 40;
async function signInGate(name: string, ip: string): Promise<void> {
  if (await failsOf(ipKey(ip)) >= IP_LIMIT) throw new HttpError(429, "too many wrong sign-ins from this address; wait 15 minutes and try again");
  if (await failsOf(userKey(name, ip)) >= USER_LIMIT) throw new HttpError(429, "too many wrong tries for that sign-in; wait 15 minutes and try again");
}
async function signInFailed(name: string, ip: string, what: string): Promise<never> {
  await noteFail(userKey(name, ip));
  await noteFail(ipKey(ip));
  const n = await failsOf(ipKey(ip));
  await sleep(Math.min(8000, 700 * 2 ** Math.max(0, Math.floor(n / 5) - 1)));
  console.log(`sign-in refused (${what})`);
  throw new HttpError(401, what === "customer" ? "that email and password did not match" : "that access key did not match");
}
const signInOk = (name: string, ip: string) => pool.query(`delete from platform_signin_attempt where key_hash = $1 /* unscoped: sign-in brakes */`, [keyHash(userKey(name, ip))]);
/** A plain rate limit (codes, reset emails): true when over. windowMin defaults to 15 minutes. */
async function overRate(key: string, max: number, windowMin = FAIL_MIN): Promise<boolean> {
  if (await failsOf(`r:${key}`, windowMin) >= max) return true;
  await noteFail(`r:${key}`, windowMin);
  return false;
}

// Operator logins: ERP_LOGINS="steve:<password or scrypt hash>,hunter:..." in
// Render's environment, never in the repository. A password is at least 10
// characters; a value starting scrypt$ is a hash from scripts/hash-password.ts.
// The old 4-digit keys are refused, with a sentence saying what to set.
function operatorLogins(): Map<string, string> {
  return new Map<string, string>(
    (process.env.ERP_LOGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
      const i = x.indexOf(":");
      return [x.slice(0, i).trim().toLowerCase(), x.slice(i + 1).trim()] as [string, string];
    }).filter(([n, k]) => n && k));
}
// Development only: while ERP_SEED=placeholder (the trial environment, with its yellow banner)
// operator logins may keep short access keys. Removing ERP_SEED for go-live turns this off.
const devShortKeys = () => process.env.ERP_SEED === "placeholder";
function operatorKeyMatches(key: string, stored: string): "ok" | "short" | "no" {
  if (stored.startsWith("scrypt$")) return P.verifyPassword(key, stored) ? "ok" : "no";
  if (!key || !safeEqual(key, stored)) return "no";
  return stored.length >= P.MIN_PASSWORD ? "ok" : "short";
}

/** Where links in emails point: ERP_PUBLIC_URL, else Render's own address. Never the request's Host header. */
const publicBase = () => (process.env.ERP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

// --------------------------------------------------------------------- page

const readHere = (name: string): string | null => {
  try {
    return readFileSync(join(here, name), "utf8");
  } catch {
    return null;
  }
};
const APP = readHere("app.html");
const APP_JS = readHere("app.js");
const APP_CSS = readHere("app.css");
const ASSET_VERSION = `${VERSION}-${Date.parse(STARTED).toString(36)}`;

const MISSING_PAGE = `<!doctype html><meta charset="utf-8"><title>ERP</title>
<style nonce="__NONCE__">body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem}</style>
<h1>ERP</h1><p>The service is running, but the app files (<code>server/app.html</code>, <code>app.js</code> and
<code>app.css</code>) are not all in this deploy. Add them to the repository's <code>server</code> folder and deploy again.</p>`;

// ------------------------------------------------------------------ helpers

/** A feed connection files into its own company. One with no company is refused, never filed into some other company. */
function scopeFor(conn: Connection, label: string, kind: "user" | "agent" | "system" = "user"): Scope {
  if (!conn.entity_id) {
    throw new HttpError(409, `${conn.name} is not attached to a company, so nothing it brings in can be filed; attach it to one first`);
  }
  return { tenantId: conn.tenant_id, entityId: conn.entity_id, actor: { kind, label } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function connectionOr404(id: string): Promise<Connection> {
  if (!UUID.test(id)) throw new HttpError(404, "no such connection");
  const c = await pool.connect();
  try {
    return await loadConnection(c, id);
  } catch {
    throw new HttpError(404, "no such connection");
  } finally {
    c.release();
  }
}

async function companyOr404(c: Client, id: string): Promise<views.Company> {
  if (!UUID.test(id)) throw new HttpError(404, "no such company");
  const co = await views.loadCompany(c, id);
  if (!co) throw new HttpError(404, "no such company");
  return co;
}

/** The companies a customer user holds a role in (all of the tenant's with a client-wide grant). */
async function grantedCompanies(c: Client, userId: string, tenantId: string): Promise<Set<string> | "all"> {
  const r = await q<{ entity_id: string | null }>(c, `
    select g.entity_id from role_grant g join app_user u on u.id = g.app_user_id
     where g.app_user_id = $1 and u.tenant_id = $2 /* unscoped: the person's own grants */`, [userId, tenantId]);
  if (r.some((x) => x.entity_id === null)) return "all";
  return new Set(r.map((x) => x.entity_id!));
}

/**
 * May this session open this company? The system token opens any; a tenant
 * token and a customer user only their own tenant's (a customer only where
 * they hold a role); an operator only the tenant they are supporting.
 */
async function mayOpen(c: Client, who: Who | null, co: { id: string; tenantId: string }): Promise<boolean> {
  if (!who) return false;
  if (who.kind === "system") return true;
  if (who.kind === "tenant") return co.tenantId === who.tenantId;
  if (who.kind === "operator") return !!who.support && who.support.tenantId === co.tenantId;
  if (co.tenantId !== who.tenantId) return false;
  const g = await grantedCompanies(c, who.userId, who.tenantId);
  return g === "all" || g.has(co.id);
}

/** The company named in the URL, if this session may open it; "no such company" otherwise, whether or not it exists. */
async function companyFor(c: Client, who: Who | null, id: string): Promise<views.Company> {
  const co = await companyOr404(c, id);
  if (!(await mayOpen(c, who, co))) throw new HttpError(404, "no such company");
  return co;
}

/** Every company this session may open, in the shape /api/me has always sent. */
async function companiesFor(c: Client, who: Who | null) {
  const all = await views.companies(c);
  if (!who) return [];
  if (who.kind === "system") return all;
  if (who.kind === "tenant") return all.filter((x) => x.tenant_id === who.tenantId);
  if (who.kind === "operator") return who.support ? all.filter((x) => x.tenant_id === who.support!.tenantId) : [];
  const g = await grantedCompanies(c, who.userId, who.tenantId);
  return all.filter((x) => x.tenant_id === who.tenantId && (g === "all" || g.has(x.id)));
}

/** Where this session opens: a customer's last company, else their first; ERP_ENTITY_ID only for the system token or an operator who may open it. */
async function defaultCompanyFor(c: Client, who: Who | null, list: { id: string }[]): Promise<string | null> {
  if (!list.length) return null;
  if (who?.kind === "customer") {
    const l = await P.loginById(c, who.loginId);
    if (l?.last_entity_id && list.some((x) => x.id === l.last_entity_id)) return l.last_entity_id;
    return list[0].id;
  }
  const dev = DEV_ENTITY();
  if (dev && list.some((x) => x.id === dev)) return dev;
  return list[0].id;
}

/** The company a legacy install-wide route (?co=, else the session's default) is about. */
async function legacyCompany(c: Client, who: Who | null, url: URL): Promise<views.Company> {
  const asked = url.searchParams.get("co") ?? "";
  if (asked) return companyFor(c, who, asked);
  const id = await defaultCompanyFor(c, who, await companiesFor(c, who));
  if (!id) throw new HttpError(404, "there is no company for you to open here yet");
  return companyFor(c, who, id);
}

const actingId = (req: http.IncomingMessage): string | null => {
  const v = String(req.headers["x-erp-as"] ?? "").trim();
  return UUID.test(v) ? v : null;
};
const namedSomeone = (req: http.IncomingMessage) => String(req.headers["x-erp-as"] ?? "").trim() !== "";

/** A person of this company who also belongs to this tenant (not a guest granted in from elsewhere). */
async function personOfTenant(c: Client, co: views.Company, id: string, tenantId: string) {
  const p = await views.person(c, co, id);
  if (!p) return null;
  const t = await q<{ tenant_id: string }>(c, `select tenant_id from app_user where id = $1 /* unscoped: the person's own row */`, [id]);
  return t[0]?.tenant_id === tenantId ? p : null;
}

type Acting = { personId: string; personName: string; label: string; preview: boolean } | null;

const PROSPECT_READ_ONLY = "a demo sign-in can look at everything but not change it; ask the ERP team for a walk-through of making changes";
/** A write outside coPost: refused while a tenant owner previews someone else's view, and for a demo prospect. */
function refusePreview(req: http.IncomingMessage, who: Who | null): void {
  if (who?.kind === "customer" && who.prospect) throw new HttpError(403, PROSPECT_READ_ONLY);
  if (who?.kind === "customer" && namedSomeone(req) && actingId(req) !== who.userId) {
    throw new HttpError(403, "previewing someone's view is read-only; switch back to yourself to make changes");
  }
}
/** A write outside coPost, recorded on the customer's platform log when an operator is in support mode. */
async function supportWrite(c: Client, who: Who | null, tenantId: string, path: string, entityId: string | null): Promise<void> {
  if (who?.kind === "operator" && who.support) await P.audit(c, auditActor(who), "support.write", tenantId, { path }, entityId);
}

/**
 * Who a request is done as. A customer user is always themselves; a tenant
 * owner may name another of their people to preview that view, read-only.
 * An operator may name anyone, but only inside the tenant they are supporting
 * (they can open nothing else). The system token names anyone, as before.
 */
async function acting(c: Client, co: views.Company, req: http.IncomingMessage, who: Who, write: boolean): Promise<Acting> {
  const id = actingId(req);
  if (who.kind === "customer") {
    if (namedSomeone(req) && !id) throw new HttpError(403, "you can only act as yourself");
    // A sales prospect's demo sign-in looks around but changes nothing, so prospects never see each other's work.
    if (who.prospect && write) throw new HttpError(403, PROSPECT_READ_ONLY);
    if (!id || id === who.userId) {
      const me = await views.person(c, co, who.userId, who.userId);
      if (!me) throw new HttpError(403, "you hold no role in this company");
      return { personId: me.id, personName: me.name, label: `${who.name} (web)`, preview: false };
    }
    if (who.prospect) throw new HttpError(403, "you can only act as yourself");
    const mine = await rolesOf(c, co, who.userId);
    if (!mine.has("owner")) throw new HttpError(403, "you can only act as yourself");
    const p = await personOfTenant(c, co, id, who.tenantId);
    if (!p) throw new HttpError(403, "that person is not one of this company's own");
    if (write) throw new HttpError(403, `previewing ${p.name}'s view is read-only; switch back to yourself to make changes`);
    return { personId: p.id, personName: p.name, label: `${who.name} (web) previewing ${p.name}`, preview: true };
  }
  if (!id) {
    if (write) throw new HttpError(400, "pick who you are acting as");
    return null;
  }
  const p = who.kind === "tenant" ? await personOfTenant(c, co, id, who.tenantId) : await views.person(c, co, id);
  if (!p) {
    if (write || who.kind !== "system") throw new HttpError(403, "that person cannot act for this company");
    return null;
  }
  const label = who.kind === "operator"
    ? (who.name.toLowerCase() === p.name.toLowerCase() ? `${who.name} (support)` : `${who.name} (support) as ${p.name}`)
    : who.kind === "tenant" ? `${who.name} as ${p.name}` : `api as ${p.name}`;
  return { personId: p.id, personName: p.name, label, preview: false };
}

/** Customer activity, at most one write every five minutes per tenant. */
const lastSeen = new Map<string, number>();
async function touchTenant(c: Client, tenantId: string) {
  const at = lastSeen.get(tenantId) ?? 0;
  if (Date.now() - at < 5 * 60_000) return;
  lastSeen.set(tenantId, Date.now());
  await c.query(`update tenant set last_activity_at = now() where id = $1`, [tenantId]);
}

/**
 * A pull that fails inside a transaction has its failure rolled back with
 * everything else. Record it in its own, so the health view sees it.
 */
async function recordPullFailure(conn: Connection, message: string): Promise<void> {
  const msg = message.slice(0, 1000);
  await tx({ kind: "system", label: "api run" }, async (c) => {
    await q(c, `insert into ingest_run (connection_id, trigger, actor_kind, finished_at, outcome, error)
                values ($1, 'manual', 'system', now(), 'failed', $2)
                /* unscoped: keyed by connection, which carries the entity */`, [conn.id, msg]);
    await q(c, `update connection
                   set last_attempt_at = now(), last_error = $2,
                       consecutive_failures = consecutive_failures + 1,
                       status = case when consecutive_failures + 1 >= 5 then 'failed' else status end
                 where id = $1 /* unscoped: connection id is unique */`, [conn.id, msg]);
  });
}

// ------------------------------------------------------------------- routes

type Reply = [number, unknown] | [number, unknown, Headers];
type Handler = (req: http.IncomingMessage, url: URL, m: RegExpMatchArray, who: Who | null) => Promise<Reply>;
const routes: { method: string; path: RegExp; auth: "none" | "token" | "own"; fn: Handler }[] = [];
const route = (method: string, path: RegExp, auth: "none" | "token" | "own", fn: Handler) =>
  routes.push({ method, path, auth, fn });

/** Every route, for checks that walk them all (tenant isolation). */
export const routeList = () => routes.map((r) => ({ method: r.method, path: r.path, auth: r.auth }));

/** A browser request that changes something must carry the page's header. */
function requirePageHeader(req: http.IncomingMessage): void {
  if (req.headers["x-erp-page"] !== "1") {
    throw new HttpError(403, "this request did not come from the ERP's own page");
  }
}

const CO = "/api/c/([0-9a-fA-F-]{36})";

/** A read about one company the session may open. The acting person, if named, must be allowed (see acting()). */
function coGet(tail: string, fn: (c: Client, co: views.Company, url: URL, m: RegExpMatchArray, personId: string | null) => Promise<unknown>) {
  route("GET", new RegExp(`^${CO}${tail}$`), "token", async (req, url, m, who) => {
    const c = await pool.connect();
    try {
      const co = await companyFor(c, who, m[1]);
      const a = await acting(c, co, req, who!, false);
      markLookOnly(c, !!a?.preview || (who?.kind === "customer" && who.prospect));
      // the install-wide token speaks for the operator, as a support session does: it never self-approves for the owner either
      markSupport(c, who?.kind === "operator" && who.support ? who.support.id : who?.kind === "system" ? "install-token" : false);
      const out = await fn(c, co, url, m, a?.personId ?? null);
      if (out === null) throw new HttpError(404, "not found");
      // A printable page (a tear sheet) goes out with every header and the CSP, like any page.
      if (out instanceof PublicPage) return [200, new Html(out.text)];
      // A file to save (an import template): its own type, named for the download.
      if (out instanceof Download) return [200, new Asset(out.bytes, out.type), { "content-disposition": `attachment; filename="${out.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"` }];
      return [200, out];
    } finally {
      markLookOnly(c, false);
      markSupport(c, false);
      c.release();
    }
  });
}

/** A change to one company the session may open, done as a named person, in one transaction. */
function coPost(tail: string, fn: (c: Client, co: views.Company, a: Actor, body: Record<string, unknown>, m: RegExpMatchArray) => Promise<unknown>, opts: { maxBody?: number } = {}) {
  route("POST", new RegExp(`^${CO}${tail}$`), "token", async (req, url, m, who) => {
    const c0 = await pool.connect();
    let co: views.Company;
    let actor: Actor;
    try {
      // The company is checked before the body is even read.
      co = await companyFor(c0, who, m[1]);
      const a = (await acting(c0, co, req, who!, true))!;
      actor = { personId: a.personId, personName: a.personName, label: a.label, via: who!.kind };
    } finally {
      c0.release();
    }
    const body = await readJson(req, opts.maxBody);
    // An operator's support session, or the install-wide token (the operator's own key): neither self-approves for the owner.
    const support = who?.kind === "operator" && who.support ? who.support.id : who?.kind === "system" ? "install-token" : null;
    // the install-wide token says why it is acting (x-erp-reason); a setup approval made with it needs that reason
    const supportReason = who?.kind === "system" ? String(req.headers["x-erp-reason"] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500) || null : null;
    const out = await tx({ kind: "user", id: actor.personId, label: actor.label, support, supportReason }, async (c) => {
      const r = await fn(c, co, actor, body, m);
      if (who?.kind === "operator" && who.support) {
        await P.audit(c, auditActor(who), "support.write", co.tenantId, { path: url.pathname, as: actor.personName }, co.id);
      }
      if (who?.kind === "customer" || who?.kind === "tenant") await touchTenant(c, co.tenantId);
      return r;
    });
    return [200, out];
  });
}

const param = (url: URL, k: string) => url.searchParams.get(k) ?? "";

// --------------------------------------------------------- retail modules
// Each module registers through the same coGet/coPost doors, so every rule
// above applies to it. Public routes (the web store) get their own door that
// carries no token and no session, and can only reach what the module exposes.
const publicRoute = (method: "GET" | "POST", path: RegExp,
  fn: (req: http.IncomingMessage, url: URL, m: RegExpMatchArray, body: Record<string, unknown>) => Promise<[number, unknown]>, opts: { maxBody?: number } = {}) =>
  route(method, path, "none", async (req, url, m) => {
    let body: Record<string, unknown> = {};
    if (method === "POST") {
      if (req.headers["x-erp-shop"] !== "1") throw new HttpError(403, "this request did not come from the store's own page");
      body = await readJson(req, opts.maxBody);
    }
    const [s, out] = await fn(req, url, m, body);
    // A page or asset goes out through the app's own responses, with every header and the CSP.
    if (out instanceof PublicPage) return [s, new Html(out.text)];
    if (out instanceof PublicAsset) return [s, new Asset(out.text, out.type)];
    return [s, out];
  });
for (const mod of MODULES) mod.register({ coGet, coPost, publicRoute });

// Module screens: server/ui/<id>.js, read once at start like app.js.
const UI_JS = new Map<string, string>();
// platform.js: the Operator console and the account screen (sign-ins, API tokens, password).
const UI_IDS = [...MODULES.map((x) => x.id), "platform"];
for (const id of UI_IDS) { const t = readHere(join("ui", `${id}.js`)); if (t) UI_JS.set(id, t); }
route("GET", /^\/ui\/([a-z]+)\.js$/, "none", async (_req, _url, m) => {
  const t = UI_JS.get(m[1]);
  if (!t) throw new HttpError(404, "not found");
  return [200, new Asset(t, "text/javascript; charset=utf-8")];
});

// Liveness. No business data, ever.
route("GET", /^\/health$/, "none", async () => {
  let db = false;
  let migrations = 0;
  try {
    const r = await pool.query<{ n: string }>(
      "select count(*) as n from schema_migration where filename not like 'seed/%' and filename not like 'sample/%'");
    migrations = Number(r.rows[0].n);
    db = true;
  } catch { /* reported as db:false */ }
  return [db ? 200 : 503, { ok: db, db, migrations, started: STARTED }];
});

// The app. A shell with no data in it; everything it shows comes from /api
// once someone has signed in.
route("GET", /^\/$/, "none", async () => [200, new Html(
  APP && APP_JS && APP_CSS ? APP.replaceAll("__VERSION__", ASSET_VERSION).replace("<!--MODULE_SCRIPTS-->",
    UI_IDS.filter((id) => UI_JS.has(id)).map((id) => `<script src="/ui/${id}.js?v=${ASSET_VERSION}" defer></script>`).join("\n")) : MISSING_PAGE)]);
route("GET", /^\/app\.js$/, "none", async () => {
  if (!APP_JS) throw new HttpError(404, "not found");
  return [200, new Asset(APP_JS, "text/javascript; charset=utf-8")];
});
route("GET", /^\/app\.css$/, "none", async () => {
  if (!APP_CSS) throw new HttpError(404, "not found");
  return [200, new Asset(APP_CSS, "text/css; charset=utf-8")];
});
route("GET", /^\/favicon\.ico$/, "none", async () => [204, null]);

// ------------------------------------------------------------------ sign in

const customerCookie = (l: { id: string; name: string; session_version: number }) =>
  sessionCookie({ n: l.name, e: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600, k: "c", l: l.id, v: l.session_version });

async function signedIn(c: Client, l: P.Login): Promise<Reply> {
  await c.query(`update platform_login set last_sign_in_at = now() where id = $1 and tenant_id = $2`, [l.id, l.tenant_id]);
  await c.query(`update tenant set last_activity_at = now() where id = $1`, [l.tenant_id]);
  console.log(`signed in: customer ${l.id}`);
  return [200, { name: l.name, kind: "customer", until: new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString() }, { "set-cookie": customerCookie(l) }];
}

// One page signs in both kinds: a customer's email and password (or an emailed
// code), or an operator's name and password.
route("POST", /^\/session$/, "none", async (req) => {
  requirePageHeader(req);
  const ip = clientIp(req);
  const body = await readJson(req);
  if (typeof body.email === "string" && body.email.trim()) {
    const email = P.cleanEmail(body.email);
    await signInGate(email, ip);
    const password = typeof body.password === "string" ? body.password : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!password && !code) throw new HttpError(400, "put your password in");
    // A login takes at most CODE_WRONG_PER_DAY wrong codes a day, from anywhere (counted in the database).
    if (code && await failsOf(`code-wrong:${email}`, DAY_MIN) >= CODE_WRONG_PER_DAY) {
      throw new HttpError(429, "too many wrong codes for this sign-in today; use your password, or try again tomorrow");
    }
    return tx({ kind: "system", label: "sign-in" }, async (c) => {
      const l = await P.loginByEmail(c, email);
      const ok = code ? !!l && l.status === "active" && await P.useCode(c, l, code)
                      : P.verifyPassword(password, l?.status === "active" ? l.pw_hash : null) && !!l;
      if (!ok || !l) {
        // the wrong code's try is counted in the database; keep it when we refuse
        await c.query("commit"); await c.query("begin");
        if (code) await noteFail(`code-wrong:${email}`, DAY_MIN);
        return signInFailed(email, ip, "customer");
      }
      const why = P.blocked(l);
      if (why) throw new HttpError(403, why);
      await signInOk(email, ip);
      return signedIn(c, l);
    });
  }
  const key = String(body.key ?? "");
  const name = cleanName(body.name);
  if (!name) throw new HttpError(400, "put your name in, so what you do here is recorded against it");
  const login = name.toLowerCase();
  await signInGate(login, ip);
  const logins = operatorLogins();
  const viaToken = !logins.has(login);
  if (logins.has(login)) {
    const m = operatorKeyMatches(key, logins.get(login)!);
    if (m === "no") return signInFailed(login, ip, "operator");
    if (m === "short" && !devShortKeys()) throw new HttpError(403, `the operator login ${login} still uses a short key; set a password of at least ${P.MIN_PASSWORD} characters (or a hash from scripts/hash-password.ts) for it in ERP_LOGINS`);
  } else if (!key || !safeEqual(key, TOKEN())) {
    return signInFailed(login, ip, "operator");
  }
  await signInOk(login, ip);
  const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  console.log(`signed in: operator ${name}`);
  return [200, { name, kind: "operator", until: new Date(exp * 1000).toISOString() }, { "set-cookie": sessionCookie({ n: name, e: exp, k: "o", ...(viaToken ? { t: 1 as const } : {}) }) }];
});

route("POST", /^\/session\/end$/, "none", async (req) => {
  requirePageHeader(req);
  // A customer's cookie stops working when they sign out, not when it expires (every session of theirs ends).
  const s = sessionFrom(req);
  if (s?.k === "c" && s.l && UUID.test(s.l)) {
    await pool.query("update platform_login set session_version = session_version + 1 where id = $1 and session_version = $2", [s.l, s.v ?? -1]);
  }
  return [200, { ok: true }, { "set-cookie": CLEAR_COOKIE }];
});

// An emailed six-digit code instead of the password: at most CODES_PER_DAY codes and
// CODE_WRONG_PER_DAY wrong codes per sign-in per day, on top of 5 tries per code.
const DAY_MIN = 24 * 60, CODES_PER_DAY = 5, CODE_WRONG_PER_DAY = 10;
// An emailed six-digit code instead of the password. The answer is the same whether or not the email has an account.
route("POST", /^\/session\/code$/, "none", async (req) => {
  requirePageHeader(req);
  const body = await readJson(req);
  const email = P.cleanEmail(body.email);
  if (!P.EMAIL.test(email)) throw new HttpError(400, "enter your email address");
  const ip = clientIp(req);
  if (await overRate(`code-ip:${ip}`, 10) || await overRate(`code:${email}`, 3)) throw new HttpError(429, "too many codes asked for; wait 15 minutes and try again");
  if (await overRate(`code-day:${email}`, CODES_PER_DAY, DAY_MIN)) throw new HttpError(429, "that is as many sign-in codes as one sign-in gets in a day; use your password");
  await tx({ kind: "system", label: "sign-in code" }, async (c) => {
    const l = await P.loginByEmail(c, email);
    if (!l || l.status !== "active" || P.blocked(l)) return;
    const { token } = await P.issueToken(c, l, "code", "sign-in page");
    await P.sendAccountEmail(c, l, "code", token, null, "sign-in page");
  });
  return [200, { ok: true, note: "If that email signs in here, a code is on its way. It works for 10 minutes." }];
});

// Forgotten password: a link by email, same answer either way.
route("POST", /^\/account\/forgot$/, "none", async (req) => {
  requirePageHeader(req);
  const body = await readJson(req);
  const email = P.cleanEmail(body.email);
  if (!P.EMAIL.test(email)) throw new HttpError(400, "enter your email address");
  const ip = clientIp(req);
  if (await overRate(`forgot-ip:${ip}`, 10) || await overRate(`forgot:${email}`, 3)) throw new HttpError(429, "too many reset emails asked for; wait 15 minutes and try again");
  await tx({ kind: "system", label: "password reset" }, async (c) => {
    const l = await P.loginByEmail(c, email);
    if (!l || l.status === "disabled" || P.blocked(l) || l.kind === "prospect") return;
    const { token } = await P.issueToken(c, l, "reset", "sign-in page");
    await P.sendAccountEmail(c, l, "reset", token, `${publicBase()}/#reset=${token}`, "sign-in page");
    await P.audit(c, { actor: email, kind: "customer" }, "login.reset_requested", l.tenant_id, {});
  });
  return [200, { ok: true, note: "If that email signs in here, a reset link is on its way. It works for an hour." }];
});

route("GET", /^\/account\/token$/, "none", async (_req, url) => {
  const c = await pool.connect();
  try {
    const info = await P.tokenInfo(c, url.searchParams.get("t") ?? "");
    if (!info) throw new HttpError(404, "that link has expired or was already used; ask for a new one");
    return [200, info];
  } finally { c.release(); }
});

// An invite or reset link: set the password, and be signed in.
route("POST", /^\/account\/(?:accept|reset)$/, "none", async (req) => {
  requirePageHeader(req);
  const ip = clientIp(req);
  if (await overRate(`token-ip:${ip}`, 30)) throw new HttpError(429, "too many tries from this address; wait 15 minutes");
  const body = await readJson(req);
  return tx({ kind: "system", label: "account link" }, async (c) => {
    const l = await P.usePasswordToken(c, String(body.token ?? ""), body.password, body.name);
    await signInOk(l.email, ip);
    return signedIn(c, l);
  });
});

// ------------------------------------------------------ the app's own API

// Who is signed in, and every company they may open.
route("GET", /^\/api\/me$/, "token", async (_req, _url, _m, who) => {
  const c = await pool.connect();
  try {
    const companies = await companiesFor(c, who);
    const w = who!;
    const viewer: Record<string, unknown> = w.via === "session"
      ? { name: w.name, via: "session", kind: w.kind, until: new Date(w.exp * 1000).toISOString() }
      : { name: w.name, via: "token", kind: w.kind };
    if (w.kind === "operator") viewer.support = w.support ? { tenantId: w.support.tenantId, tenantName: w.support.tenantName, since: w.support.since, reason: w.support.reason,
      setup: await P.setupStatus(c, w.support.tenantId) } : null;
    if (w.kind === "customer") {
      Object.assign(viewer, { personId: w.userId, email: w.email, tenantId: w.tenantId, tenantName: w.tenantName, demo: w.tenantKind === "demo",
        prospect: w.prospect, expiresAt: w.expiresAt, owner: !w.prospect && await P.isTenantOwner(c, w.userId, w.tenantId) });
    }
    if (w.kind === "tenant") viewer.tenantId = w.tenantId;
    return [200, {
      viewer,
      trial: TRIAL,
      trialEnds: TRIAL_ENDS || null,
      version: VERSION,
      defaultCompany: await defaultCompanyFor(c, who, companies),
      companies,
    }];
  } finally { c.release(); }
});

// The company a customer opened last is where they open next time.
route("POST", /^\/api\/me\/company$/, "token", async (req, _url, _m, who) => {
  const body = await readJson(req);
  if (who?.kind !== "customer") return [200, { ok: true }];
  const c = await pool.connect();
  try {
    const co = await companyFor(c, who, String(body.id ?? ""));
    await c.query(`update platform_login set last_entity_id = $2 where id = $1 and tenant_id = $3`, [who.loginId, co.id, who.tenantId]);
    return [200, { ok: true }];
  } finally { c.release(); }
});

// A customer changes their own password.
route("POST", /^\/api\/account\/password$/, "token", async (req, _url, _m, who) => {
  if (who?.kind !== "customer") throw new HttpError(403, "only a customer sign-in has a password here");
  if (who.prospect) throw new HttpError(403, PROSPECT_READ_ONLY);
  const body = await readJson(req);
  const ip = clientIp(req);
  await signInGate(who.email, ip);
  return tx({ kind: "user", id: who.userId, label: `${who.name} (web)` }, async (c) => {
    const l = await P.loginById(c, who.loginId);
    if (!l || !P.verifyPassword(String(body.current ?? ""), l.pw_hash)) {
      await noteFail(userKey(who.email, ip));
      throw new HttpError(401, "your current password did not match");
    }
    const pw = P.checkPassword(body.next, l.email);
    await c.query(`update platform_login set pw_hash = $2, password_set_at = now(), session_version = session_version + 1 where id = $1 and tenant_id = $3`,
      [l.id, P.hashPassword(pw), l.tenant_id]);
    await P.audit(c, auditActor(who), "login.password_changed", l.tenant_id);
    const fresh = (await P.loginById(c, l.id))!;
    return [200, { ok: true }, { "set-cookie": customerCookie(fresh) }];
  });
});

// The clients this session may see, and a new company for one of them.
route("GET", /^\/api\/clients$/, "token", async (_req, _url, _m, who) => {
  const c = await pool.connect();
  try {
    const all = await views.clients(c) as { id: string }[];
    const w = who!;
    const mine = w.kind === "system" ? all
      : w.kind === "operator" ? all.filter((t) => w.support && t.id === w.support.tenantId)
        : all.filter((t) => t.id === w.tenantId);
    return [200, mine];
  } finally { c.release(); }
});
route("POST", /^\/api\/companies$/, "token", async (req, _url, _m, who) => {
  const body = await readJson(req);
  const w = who!;
  const label = labelFor(who, "api");
  if (w.kind === "operator") {
    if (!w.support) throw new HttpError(403, "create customers from the Operator console, or enter a customer in support mode to add a company to it");
    body.clientId = w.support.tenantId;
    // review of 0066: support mode never makes someone an owner who is not one already (an owner the ERP team could sign in as is not support mode)
    const ownersIn = (Array.isArray(body.people) ? body.people : []).filter((p: { roles?: unknown }) => Array.isArray(p?.roles) && p.roles.map(String).includes("owner"))
      .map((p: { email?: unknown }) => String(p.email ?? "").trim().toLowerCase());
    if (ownersIn.length) {
      const known = await read((c) => q<{ email: string }>(c, `select lower(u.email) email from app_user u join role_grant g on g.app_user_id = u.id and g.role = 'owner'
         where u.tenant_id = $1 /* unscoped: the client's owners */`, [w.support!.tenantId]));
      if (ownersIn.some((e: string) => !known.some((k) => k.email === e)))
        throw new HttpError(403, "support mode never makes someone an owner; name one of the account's owners, or the owner adds the company signed in as themselves");
    }
  } else if (w.kind === "customer") {
    const c0 = await pool.connect();
    try {
      if (w.prospect || !(await P.isTenantOwner(c0, w.userId, w.tenantId))) throw new HttpError(403, "adding a company is for the account owner");
    } finally { c0.release(); }
    body.clientId = w.tenantId;
  } else if (w.kind === "tenant") {
    throw new HttpError(403, "an API token cannot add companies");
  }
  const made = await tx({ kind: "user", label }, async (c) => {
    const r = await act.createCompany(c, label, body);
    if (w.kind === "operator" || w.kind === "customer") {
      await P.audit(c, auditActor(who), "company.create", (r as { tenantId: string }).tenantId, { name: body.name }, (r as { id: string }).id);
    }
    return r;
  });
  return [200, made];
});

// --------------------------------------------------- the Operator console

function operator(who: Who | null): P.AuditActor {
  if (who?.kind === "system") return { actor: "api", kind: "system" };
  if (who?.kind !== "operator") throw new HttpError(403, "the Operator console is for the ERP's own team");
  return auditActor(who);
}
const tenantParam = (m: RegExpMatchArray) => {
  if (!UUID.test(m[1])) throw new HttpError(404, "no such customer");
  return m[1];
};
const read = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
  const c = await pool.connect();
  try { return await fn(c); } finally { c.release(); }
};
const TID = "([0-9a-fA-F-]{36})";

route("GET", /^\/api\/platform\/customers$/, "token", async (_r, _u, _m, who) => { operator(who); return [200, await read((c) => P.customers(c))]; });
route("GET", new RegExp(`^/api/platform/customers/${TID}$`), "token", async (_r, _u, m, who) => {
  operator(who); return [200, await read((c) => P.customerDetail(c, tenantParam(m)))];
});
route("GET", /^\/api\/platform\/packs$/, "token", async (_r, _u, _m, who) => { operator(who); return [200, { packs: P.packs(), plans: P.PLANS }]; });
route("POST", /^\/api\/platform\/customers$/, "token", async (req, _u, _m, who) => {
  const by = operator(who);
  const body = await readJson(req);
  return [200, await tx({ kind: "user", label: `${by.actor} (operator)` }, (c) => P.createCustomer(c, by, body, publicBase()))];
});
route("POST", new RegExp(`^/api/platform/customers/${TID}/(suspend|reactivate)$`), "token", async (req, _u, m, who) => {
  const by = operator(who);
  const body = await readJson(req);
  return [200, await tx({ kind: "user", label: `${by.actor} (operator)` }, (c) =>
    P.setTenantStatus(c, by, tenantParam(m), m[2] === "suspend" ? "suspended" : "active", body.reason))];
});
route("POST", new RegExp(`^/api/platform/customers/${TID}/users$`), "token", async (req, _u, m, who) => {
  const by = operator(who);
  const body = await readJson(req);
  return [200, await tx({ kind: "user", label: `${by.actor} (operator)` }, (c) => P.inviteUser(c, by, tenantParam(m), body, publicBase(), { reveal: true }))];
});
route("POST", new RegExp(`^/api/platform/customers/${TID}/logins/${TID}/invite$`), "token", async (_req, _u, m, who) => {
  const by = operator(who);
  return [200, await tx({ kind: "user", label: `${by.actor} (operator)` }, (c) => P.reinvite(c, by, tenantParam(m), m[2], publicBase(), { reveal: true }))];
});
// Support mode: the cookie now names a support session, recorded on the customer's log.
route("POST", new RegExp(`^/api/platform/customers/${TID}/support$`), "token", async (req, _u, m, who) => {
  if (who?.kind !== "operator") throw new HttpError(403, "support mode is for the ERP's own team, signed in");
  const body = await readJson(req);
  const s = await tx({ kind: "user", label: `${who.name} (operator)` }, (c) => P.startSupport(c, who.name, tenantParam(m), body.reason));
  return [200, s, { "set-cookie": sessionCookie({ n: who.name, e: who.exp, k: "o", s: s.id, t: who.tk }) }];
});
route("POST", /^\/api\/platform\/support\/end$/, "token", async (_req, _u, _m, who) => {
  if (who?.kind !== "operator") throw new HttpError(403, "support mode is for the ERP's own team, signed in");
  if (who.support) await tx({ kind: "user", label: `${who.name} (operator)` }, (c) => P.endSupport(c, who.name, who.support!.id));
  return [200, { ok: true }, { "set-cookie": sessionCookie({ n: who.name, e: who.exp, k: "o", t: who.tk }) }];
});
// Server errors by reference, and the scheduler's jobs and runs (all companies).
route("GET", /^\/api\/platform\/errors$/, "token", async (_req, url, _m, who) => {
  operator(who);
  const ref = (url.searchParams.get("ref") ?? "").trim();
  if (ref) { const e = await errorByRef(ref); return [200, e ? [e] : []]; }
  return [200, await listErrors(Number(url.searchParams.get("limit") ?? 100))];
});
route("GET", /^\/api\/platform\/errors\/([A-Za-z0-9]{6})$/, "token", async (_req, _u, m, who) => {
  operator(who);
  const e = await errorByRef(m[1]);
  if (!e) throw new HttpError(404, `no error with reference ${m[1].toUpperCase()}`);
  return [200, e];
});
route("GET", /^\/api\/platform\/jobs$/, "token", async (_req, url, _m, who) => {
  operator(who);
  const job = url.searchParams.get("job");
  return [200, await read(async (c) => ({ jobs: await jobsView(c, null), runs: await runsView(c, null, job && jobById(job) ? job : null, 50) }))];
});
route("GET", /^\/api\/platform\/jobs\/runs\/([0-9a-fA-F-]{36})$/, "token", async (_req, _u, m, who) => {
  operator(who);
  const r = await read((c) => runDetail(c, m[1], null));
  if (!r) throw new HttpError(404, "no such run");
  return [200, r];
});
route("POST", /^\/api\/platform\/jobs\/([a-z_]{2,40})\/run$/, "token", async (req, _u, m, who) => {
  const by = operator(who);
  const job = jobById(m[1]);
  if (!job) throw new HttpError(404, "no such job");
  await readJson(req);
  // queued, not awaited: it runs through the scheduler's lock in the background, and the console polls the job log for it
  return [202, queueJob(job, `operator ${by.actor}`)];
});
route("GET", /^\/api\/platform\/audit$/, "token", async (_req, url, _m, who) => {
  operator(who);
  const t = url.searchParams.get("tenant");
  return [200, await read((c) => q(c, `select at, actor, actor_kind, tenant_id, action, detail from platform_audit
      where ($1::uuid is null or tenant_id = $1) order by at desc limit 200 /* unscoped: the platform log */`, [t && UUID.test(t) ? t : null]))];
});
route("GET", /^\/api\/platform\/prospects$/, "token", async (_r, _u, _m, who) => { operator(who); return [200, await read((c) => P.prospects(c))]; });
route("POST", /^\/api\/platform\/prospects$/, "token", async (req, _u, _m, who) => {
  const by = operator(who);
  const body = await readJson(req);
  return [200, await tx({ kind: "user", label: `${by.actor} (operator)` }, (c) => P.createProspect(c, by, body))];
});
route("POST", new RegExp(`^/api/platform/prospects/${TID}/end$`), "token", async (_req, _u, m, who) => {
  const by = operator(who);
  return [200, await tx({ kind: "user", label: `${by.actor} (operator)` }, (c) => P.endProspect(c, by, tenantParam(m)))];
});
// Wipe and reload the demo tenants, and nothing else (packages/core/platform_demo.ts).
route("POST", /^\/api\/platform\/demo\/reset$/, "token", async (req, _u, _m, who) => {
  const by = operator(who);
  const body = await readJson(req);
  if (String(body.confirm ?? "") !== "RESET DEMO") throw new HttpError(400, "type RESET DEMO to confirm; the demo's data is wiped and reloaded");
  const r = await resetDemo(by.actor, { log: (s) => console.log(s) });
  if (r.reloadSample) {
    await loadSampleActivity((s) => console.log(s)).catch((e) => console.error(`sample activity could not load after the reset: ${describeError(e)}`));
  }
  return [200, r];
});

// ------------------------------------------- a tenant's own users and tokens

/** The tenant an account-owner route acts on: a customer's own (owner only), or the one an operator is supporting. */
async function ownerTenant(who: Who | null): Promise<{ tenantId: string; by: P.AuditActor; selfUserId: string | null; reveal: boolean }> {
  if (who?.kind === "operator" && who.support) return { tenantId: who.support.tenantId, by: auditActor(who), selfUserId: null, reveal: true };
  if (who?.kind === "customer") {
    const owner = !who.prospect && await read((c) => P.isTenantOwner(c, who.userId, who.tenantId));
    if (!owner) throw new HttpError(403, "managing sign-ins and API tokens is for the account owner");
    return { tenantId: who.tenantId, by: auditActor(who), selfUserId: who.userId, reveal: false };
  }
  throw new HttpError(403, "managing sign-ins and API tokens is for the account owner");
}
const ownerTx = <T>(o: { by: P.AuditActor }, fn: (c: Client) => Promise<T>) => tx({ kind: "user", label: o.by.actor }, fn);
/**
 * Review of 0066: nothing from support mode (or the install-wide token) may mint an identity that is not support
 * mode -- an API token whose secret comes back, or an invite link the operator could use to set a password. Such an
 * identity could then act as the owner (self-approve, press Go live). The account owner does these, signed in.
 */
function notFromSupport(who: Who | null, what: string) {
  if ((who?.kind === "operator" && who.support) || who?.kind === "system")
    throw new HttpError(403, `${what} is the account owner's own step, signed in as themselves; support mode cannot do it, so no identity is made that is not support mode`);
}

route("GET", /^\/api\/tenant\/users$/, "token", async (_r, _u, _m, who) => {
  const o = await ownerTenant(who);
  return [200, await read((c) => P.users(c, o.tenantId))];
});
route("POST", /^\/api\/tenant\/users$/, "token", async (req, _u, _m, who) => {
  notFromSupport(who, "inviting someone to sign in");
  const o = await ownerTenant(who);
  const body = await readJson(req);
  return [200, await ownerTx(o, (c) => P.inviteUser(c, o.by, o.tenantId, body, publicBase(), { reveal: o.reveal }))];
});
route("POST", new RegExp(`^/api/tenant/users/${TID}/(invite|disable|enable)$`), "token", async (_req, _u, m, who) => {
  if (m[2] === "invite") notFromSupport(who, "sending a new invite link");
  const o = await ownerTenant(who);
  return [200, await ownerTx(o, (c) => m[2] === "invite" ? P.reinvite(c, o.by, o.tenantId, m[1], publicBase(), { reveal: o.reveal })
    : P.setLoginStatus(c, o.by, o.tenantId, m[1], m[2] === "enable", o.selfUserId))];
});
route("GET", /^\/api\/tenant\/tokens$/, "token", async (_r, _u, _m, who) => {
  const o = await ownerTenant(who);
  return [200, await read((c) => P.apiTokens(c, o.tenantId))];
});
route("POST", /^\/api\/tenant\/tokens$/, "token", async (req, _u, _m, who) => {
  notFromSupport(who, "making an API token");
  const o = await ownerTenant(who);
  const body = await readJson(req);
  return [200, await ownerTx(o, (c) => P.createApiToken(c, o.by, o.tenantId, body.name))];
});
route("POST", new RegExp(`^/api/tenant/tokens/${TID}/(rotate|revoke)$`), "token", async (_req, _u, m, who) => {
  if (m[2] === "rotate") notFromSupport(who, "rotating an API token (it shows the new secret)");
  const o = await ownerTenant(who);
  return [200, await ownerTx(o, (c) => m[2] === "rotate" ? P.rotateApiToken(c, o.by, o.tenantId, m[1]) : P.revokeApiToken(c, o.by, o.tenantId, m[1]))];
});

coGet("/people", (c, co, _u, _m, p) => views.people(c, co, p));
coGet("/home", (c, co, _u, _m, p) => views.home(c, co, p));
coGet("/options", (c, co) => views.formOptions(c, co));

coGet("/approvals", (c, co, _u, _m, p) => views.approvals(c, co, p));
coPost("/approvals/([0-9a-fA-F-]{36})", (c, co, a, b, m) =>
  act.decideRequest(c, co, a, { requestId: m[2], decision: b.decision, note: b.note, callback: b.callback, confirm: b.confirm }));

coGet("/bills", (c, co, url) => views.bills(c, co, param(url, "tab") || "attention"));
coGet("/bills/([0-9a-fA-F-]{36})", (c, co, _u, m, p) => views.bill(c, co, m[2], p));
coPost("/bills", (c, co, a, b) => act.newBill(c, co, a, b));
coPost("/bills/([0-9a-fA-F-]{36})/accept", (c, co, a, b, m) => act.acceptBill(c, co, a, { id: m[2], reason: b.reason }));
coPost("/bills/([0-9a-fA-F-]{36})/reject", (c, co, a, b, m) => act.rejectBill(c, co, a, { id: m[2], reason: b.reason }));

coGet("/vendors", (c, co) => views.vendors(c, co));
coPost("/vendors", (c, co, a, b) => act.addVendor(c, co, a, b));
coGet("/vendors/([0-9a-fA-F-]{36})", (c, co, _u, m) => views.vendor(c, co, m[2]));
coPost("/vendors/([0-9a-fA-F-]{36})", (c, co, a, b, m) => act.updateVendor(c, co, a, { ...b, id: m[2] }));
coPost("/vendors/([0-9a-fA-F-]{36})/bank", (c, co, a, b, m) => act.requestVendorBank(c, co, a, { ...b, vendorId: m[2] }));

coGet("/payment-runs", (c, co, _u, _m, p) => views.paymentRuns(c, co, p));
coGet("/payment-runs/([0-9a-fA-F-]{36})", (c, co, _u, m, p) => views.paymentRun(c, co, m[2], p));
coPost("/payment-runs", (c, co, a, b) => act.createPaymentRun(c, co, a, b));
coPost("/payment-runs/([0-9a-fA-F-]{36})/submit", (c, co, a, _b, m) => act.submitPaymentRun(c, co, a, { id: m[2] }));
coPost("/payment-runs/([0-9a-fA-F-]{36})/release", (c, co, a, b, m) => act.releasePaymentRun(c, co, a, { id: m[2], confirm: b.confirm }));
coPost("/payment-runs/([0-9a-fA-F-]{36})/cancel", (c, co, a, _b, m) => act.cancelPaymentRun(c, co, a, { id: m[2] }));

coGet("/payroll", (c, co, _u, _m, p) => views.payroll(c, co, p));
coGet("/payroll/runs/([0-9a-fA-F-]{36})", (c, co, _u, m, p) => views.payrollRun(c, co, m[2], p));
coGet("/payroll/periods/([0-9a-fA-F-]{36})/timecards", (c, co, _u, m) => views.timecards(c, co, m[2]));
coPost("/payroll/periods/([0-9a-fA-F-]{36})/approve-timecards", (c, co, a, _b, m) => act.approveTimecards(c, co, a, { periodId: m[2] }));
coPost("/payroll/periods/([0-9a-fA-F-]{36})/build", (c, co, a, _b, m) => act.buildPayroll(c, co, a, { periodId: m[2] }));
coPost("/payroll/runs/([0-9a-fA-F-]{36})/request", (c, co, a, _b, m) => act.requestPayroll(c, co, a, { runId: m[2] }));
coPost("/payroll/runs/([0-9a-fA-F-]{36})/release", (c, co, a, b, m) => act.releasePayroll(c, co, a, { runId: m[2], confirm: b.confirm }));
coPost("/payroll/runs/([0-9a-fA-F-]{36})/post", (c, co, a, _b, m) => act.postPayroll(c, co, a, { runId: m[2] }));
coPost("/payroll/next-period", (c, co, a, b) => act.openNextPeriod(c, co, a, { payGroupId: b.payGroupId }));
coPost("/payroll/groups", (c, co, a, b) => act.addPayGroup(c, co, a, b));
coPost("/payroll/people", (c, co, a, b) => act.hireEmployee(c, co, a, b));
coGet("/payroll/people/([0-9a-fA-F-]{36})", (c, co, _u, m) => views.employee(c, co, m[2]));
coPost("/payroll/people/([0-9a-fA-F-]{36})", (c, co, a, b, m) => act.changeEmployee(c, co, a, { ...b, id: m[2] }));
coPost("/payroll/people/([0-9a-fA-F-]{36})/end", (c, co, a, b, m) => act.terminateEmployee(c, co, a, { ...b, id: m[2] }));

coGet("/setup", (c, co) => views.setup(c, co));
coPost("/setup/stores", (c, co, a, b) => act.addStore(c, co, a, b));
coPost("/setup/banks", (c, co, a, b) => act.addBankAccount(c, co, a, b));
coPost("/setup/people", (c, co, a, b) => act.addPerson(c, co, a, b));
coPost("/setup/people/([0-9a-fA-F-]{36})/roles", (c, co, a, b, m) => act.setRoles(c, co, a, { ...b, personId: m[2] }));

coGet("/books/pnl", async (c, co, url) => {
  const to = DAY.test(param(url, "to")) ? param(url, "to") : await bizToday(c, co.id);
  const from = DAY.test(param(url, "from")) ? param(url, "from") : (await bizToday(c, co.id)).slice(0, 8) + "01";
  return views.pnl(c, co, from, to);
});
coGet("/books/account/([0-9A-Za-z.-]{1,20})", async (c, co, url, m) => {
  const to = DAY.test(param(url, "to")) ? param(url, "to") : await bizToday(c, co.id);
  const from = DAY.test(param(url, "from")) ? param(url, "from") : (await bizToday(c, co.id)).slice(0, 8) + "01";
  const store = param(url, "store");
  return views.accountLines(c, co, m[2], from, to, store === "none" || UUID.test(store) ? store : null);
});
coGet("/books/entry/([0-9a-fA-F-]{36})", (c, co, _u, m) => views.entry(c, co, m[2]));
coGet("/books/trial-balance", async (c, co, url) =>
  views.trialBalance(c, co, DAY.test(param(url, "asOf")) ? param(url, "asOf") : await bizToday(c, co.id)));

coGet("/cash", (c, co) => views.cash(c, co));
coPost("/cash/plan", (c, co, a) => act.planTodaysSweeps(c, co, a));
coPost("/cash/transfers/([0-9a-fA-F-]{36})/confirm", (c, co, a, _b, m) => act.confirmSweep(c, co, a, { transferId: m[2] }));

coGet("/recon", (c, co) => views.recon(c, co));
coGet("/recon/lines/([0-9a-fA-F-]{36})/candidates", (c, co, _u, m) => views.matchCandidates(c, co, m[2]));
coPost("/recon/run", (c, co, a, b) => act.runMatching(c, co, a, { bankAccountId: b.bankAccountId }));
coPost("/recon/lines/([0-9a-fA-F-]{36})/match", (c, co, a, b, m) =>
  act.matchLine(c, co, a, { lineId: m[2], kind: b.kind, targetId: b.targetId, note: b.note }));
coPost("/recon/lines/([0-9a-fA-F-]{36})/book", (c, co, a, b, m) =>
  act.bookLine(c, co, a, { lineId: m[2], glAccountId: b.glAccountId, note: b.note }));

coGet("/feeds", (c, co) => views.feeds(c, co));
coPost("/feeds/files/([0-9a-fA-F-]{36})/dismiss", async (c, co, a, b, m) => {
  const reason = String(b.reason ?? "").trim().slice(0, 500);
  if (!reason) throw new ActionError("say why, so the next person knows");
  const hit = await q<{ status: string }>(c, `
    select f.status from inbound_file f join connection cn on cn.id = f.connection_id
     where f.id = $1 and cn.entity_id = $2`, [m[2], co.id]);
  if (!hit.length) throw new HttpError(404, "no such file");
  if (hit[0].status !== "quarantined") throw new ActionError("that file is not in quarantine any more");
  await releaseQuarantine(c, act.scopeOf(co, a), m[2], "ignored", reason);
  return { ok: true };
});

// ------------------------------------------- the first screen's API, kept

// Everything the original feeds screen showed, for the default company.
route("GET", /^\/api\/overview$/, "token", async (_req, url, _m, who) => {
  const c = await pool.connect();
  try {
    const co = await legacyCompany(c, who, url);
    return [200, {
      entity: { name: co.name },
      viewer: who?.via === "session" ? { name: who.name, via: "session", until: new Date(who.exp * 1000).toISOString() }
                                     : { name: who?.name ?? "API token", via: "token" },
      trial: TRIAL, trialEnds: TRIAL_ENDS || null, version: VERSION, now: new Date().toISOString(),
      ...(await views.feeds(c, co)),
    }];
  } finally { c.release(); }
});

// What the system knows how to move, and which kinds still lack a parser.
route("GET", /^\/api\/sources$/, "token", async () => {
  const c = await pool.connect();
  try {
    const rows = await q(c, `
      select s.code, s.name, s.direction,
             array_agg(sc.channel order by sc.channel) as channels
        from ingest_source s join source_channel sc on sc.source_code = s.code
       group by s.code, s.name, s.direction order by s.direction, s.code
       /* unscoped: the catalogue is not per-entity */`);
    // "ready" means code exists that consumes (inbound) or produces (outbound)
    // this kind of data. Everything else is declared and wired, but waiting.
    return [200, rows.map((r: Record<string, unknown>) => ({
      ...r, handler: handlerFor(r.code as string) ? "ready" : "not yet",
    }))];
  } finally { c.release(); }
});

route("GET", /^\/api\/connections$/, "token", async (_req, url, _m, who) => {
  const c = await pool.connect();
  try {
    const co = await legacyCompany(c, who, url);
    return [200, await views.connections(c, co)];
  } finally { c.release(); }
});

route("GET", /^\/api\/quarantine$/, "token", async (_req, url, _m, who) => {
  const c = await pool.connect();
  try { return [200, await openQuarantine(c, (await legacyCompany(c, who, url)).id)]; } finally { c.release(); }
});

route("GET", /^\/api\/intake$/, "token", async (_req, url, _m, who) => {
  const c = await pool.connect();
  try {
    const co = await legacyCompany(c, who, url);
    return [200, await q(c, `select * from statement_intake where entity_id = $1 order by account_name`, [co.id])];
  } finally { c.release(); }
});

route("GET", /^\/api\/gaps$/, "token", async (_req, url, _m, who) => {
  const c = await pool.connect();
  try {
    const co = await legacyCompany(c, who, url);
    return [200, (await views.gaps(c, co)).slice(0, 200).map(({ bank_account_id: _id, ...g }) => g)];
  } finally { c.release(); }
});

route("GET", /^\/api\/runs$/, "token", async (_req, url, _m, who) => {
  const c = await pool.connect();
  try {
    const co = await legacyCompany(c, who, url);
    return [200, await q(c, `
      select c.name, r.trigger, r.started_at, r.files_seen, r.files_new, r.files_failed, r.outcome, r.error
        from ingest_run r join connection c on c.id = r.connection_id
       where c.entity_id = $1 order by r.started_at desc limit 50`, [co.id])];
  } finally { c.release(); }
});

/** A connection is reached through its company: the session must be able to open it. One with no company is refused. */
async function mayUseConnection(conn: Connection, who: Who | null): Promise<void> {
  const c = await pool.connect();
  try {
    if (!conn.entity_id) {
      if (who?.kind !== "system") throw new HttpError(404, "no such connection");
      scopeFor(conn, "check");
      return;
    }
    const co = await views.loadCompany(c, conn.entity_id);
    if (!co || !(await mayOpen(c, who, co))) throw new HttpError(404, "no such connection");
  } finally { c.release(); }
}

// Hand upload. The body is the file.
route("POST", /^\/api\/connections\/([^/]+)\/upload$/, "token", async (req, url, m, who) => {
  const conn = await connectionOr404(m[1]);
  await mayUseConnection(conn, who);
  refusePreview(req, who);
  if (conn.channel !== "manual_upload") {
    throw new HttpError(409, `${conn.name} is a ${conn.channel} connection, not an upload one`);
  }
  const bytes = await readBody(req);
  if (!bytes.length) throw new HttpError(400, "the request body is empty; send the file as the body");
  const filename = (url.searchParams.get("filename") ?? "upload").slice(0, 200);
  let label = labelFor(who, "api upload");
  if (conn.entity_id) {
    const c0 = await pool.connect();
    try {
      const co = await companyFor(c0, who, conn.entity_id);
      const a = await acting(c0, co, req, who!, false);
      if (a) label = a.label;
    } finally { c0.release(); }
  }
  const result = await tx({ kind: "user", label }, async (c) => {
    await supportWrite(c, who, conn.tenant_id, url.pathname, conn.entity_id);
    const r = await ingest(c, scopeFor(conn, label), conn.id, {
      trigger: "manual",
      offered: [{ origin: filename, bytes, contentType: req.headers["content-type"] }],
    });
    // What became of each file, so whoever uploaded it can see it land.
    const files = await q(c, `
      select f.origin, f.status, f.format, f.rows_parsed, f.quarantine_reason as reason,
             (select count(*) from bank_statement s where s.inbound_file_id = f.id)::int as days,
             (select min(s.statement_date)::text from bank_statement s where s.inbound_file_id = f.id) as first_day,
             (select max(s.statement_date)::text from bank_statement s where s.inbound_file_id = f.id) as last_day
        from inbound_file f
       where f.run_id = $1 /* unscoped: a run belongs to one connection, checked above */`, [r.runId]);
    return { ...r, files };
  });
  return [200, result];
});

// A person decides a quarantined file was not worth reading. It stays on
// record; it leaves the list, with their name and reason in the audit trail.
route("POST", /^\/api\/quarantine\/([^/]+)\/dismiss$/, "token", async (req, url, m, who) => {
  if (!UUID.test(m[1])) throw new HttpError(404, "no such file");
  refusePreview(req, who);
  const body = await readJson(req);
  const reason = String(body.reason ?? "").trim().slice(0, 500);
  if (!reason) throw new HttpError(400, "say why, so the next person knows");
  const c0 = await pool.connect();
  let conn: Connection;
  try {
    const co = await legacyCompany(c0, who, url);
    const hit = await q<{ connection_id: string; status: string }>(c0, `
      select f.connection_id, f.status from inbound_file f join connection c on c.id = f.connection_id
       where f.id = $1 and c.entity_id = $2`, [m[1], co.id]);
    if (!hit.length) throw new HttpError(404, "no such file");
    if (hit[0].status !== "quarantined") throw new HttpError(409, "that file is not in quarantine any more");
    conn = await loadConnection(c0, hit[0].connection_id);
  } finally { c0.release(); }
  const label = labelFor(who, "api dismiss");
  await tx({ kind: "user", label }, async (c) => {
    await supportWrite(c, who, conn.tenant_id, url.pathname, conn.entity_id);
    await releaseQuarantine(c, scopeFor(conn, label), m[1], "ignored", reason);
  });
  return [200, { ok: true }];
});

// Pull on demand. Free hosting has no cron, so this is how a scheduled
// connection gets run until there is one.
route("POST", /^\/api\/connections\/([^/]+)\/run$/, "token", async (req, url, m, who) => {
  const conn = await connectionOr404(m[1]);
  await mayUseConnection(conn, who);
  refusePreview(req, who);
  if (conn.channel !== "sftp" && conn.channel !== "api") {
    throw new HttpError(409, `${conn.name} is a push channel; it is run by whatever sends to it`);
  }
  try {
    const result = await tx({ kind: "system", label: "api run" }, async (c) => {
      await supportWrite(c, who, conn.tenant_id, url.pathname, conn.entity_id);
      return ingest(c, scopeFor(conn, "api run", "system"), conn.id, { trigger: "manual" });
    });
    return [200, result];
  } catch (e) {
    const msg = describeError(e);
    await recordPullFailure(conn, msg).catch((err) =>
      console.error(`could not record the failed run for ${conn.name}: ${describeError(err)}`));
    throw new HttpError(502, msg);
  }
});

// Webhooks: authenticated by signature, not by our token.
route("POST", /^\/hooks\/([^/]+)$/, "own", async (req, _url, m) => {
  const conn = await connectionOr404(m[1]);
  if (conn.channel !== "webhook") throw new HttpError(404, "no such webhook");
  const secret = conn.credential_ref ? secretFor(conn.credential_ref) : "";
  if (!secret) throw new HttpError(401, "this webhook has no signing secret configured, so it accepts nothing");
  const bytes = await readBody(req);
  const offered: Offered = {
    origin: String(req.headers["x-delivery-id"] ?? "webhook"),
    deliveryId: String(req.headers["x-delivery-id"] ?? ""),
    signature: String(req.headers["x-signature"] ?? req.headers["x-hub-signature-256"] ?? ""),
    bytes,
  };
  const result = await tx({ kind: "system", label: "webhook" }, (c) =>
    ingest(c, scopeFor(conn, "webhook", "system"), conn.id, {
      trigger: "webhook", offered: [offered], secrets: secretFor,
    }));
  return [200, { accepted: result.fresh, duplicate: result.seen - result.fresh }];
});

// Inbound email, in the JSON shape inbound-mail services post (Postmark's
// field names). The mailbox it was addressed to picks the connection; the
// sender still has to be on that connection's allow list.
route("POST", /^\/inbound\/email$/, "own", async (req, url) => {
  // The token rides in a header only, never the address (addresses end up in logs): "Authorization: Bearer <token>",
  // or HTTP Basic with the token as the password -- what Postmark sends for https://erp:<token>@host/inbound/email.
  const auth = String(req.headers.authorization ?? "");
  const basic = /^basic\s+(.+)$/i.exec(auth);
  let presented = bearer(req);
  if (!presented && basic) { const pair = Buffer.from(basic[1], "base64").toString("utf8"); presented = pair.slice(pair.indexOf(":") + 1); }
  if (url.searchParams.has("token")) throw new HttpError(401, "send the inbound email token in the Authorization header (Bearer, or Basic with the token as the password), not in the address");
  if (!EMAIL_TOKEN() || !safeEqual(presented, EMAIL_TOKEN())) {
    throw new HttpError(401, "inbound email needs its own token");
  }
  const raw = await readBody(req);
  let msg: {
    From?: string; To?: string; OriginalRecipient?: string; Subject?: string; MessageID?: string;
    Attachments?: { Name: string; Content: string; ContentType?: string }[];
  };
  try { msg = JSON.parse(raw.toString("utf8")); } catch { throw new HttpError(400, "that is not an inbound-email payload"); }

  // Vendor mail to a company's (or one vendor's) own address: routed by mailbox and sender, unknown senders held.
  const vendorMail = await receiveVendorMail(msg as InboundMail);
  if (vendorMail) return [200, vendorMail];

  const to = String(msg.OriginalRecipient ?? msg.To ?? "").toLowerCase();
  const addr = to.includes("<") ? to.slice(to.lastIndexOf("<") + 1, to.lastIndexOf(">")) : to.split(",")[0].trim();
  const atts = msg.Attachments ?? [];
  if (!atts.length) return [200, { accepted: 0, note: "no attachments; nothing to ingest" }];

  const c0 = await pool.connect();
  let conn: Connection;
  try {
    const hit = await q<{ id: string }>(c0,
      `select id from connection
        where channel = 'email' and status = 'active' and lower(config->>'mailbox') = $1
        /* unscoped: routing by mailbox happens before an entity is known */`, [addr]);
    if (!hit.length) throw new HttpError(404, `no active email connection receives mail for ${addr || "that address"}`);
    conn = await loadConnection(c0, hit[0].id);
  } finally { c0.release(); }

  const offered: Offered[] = atts.map((a) => ({
    origin: a.Name,
    originDetail: { subject: msg.Subject, messageId: msg.MessageID },
    sender: msg.From,
    contentType: a.ContentType,
    bytes: Buffer.from(a.Content ?? "", "base64"),
  }));

  const result = await tx({ kind: "system", label: "inbound email" }, (c) =>
    ingest(c, scopeFor(conn, "inbound email", "system"), conn.id, { trigger: "webhook", offered }));
  return [200, { accepted: result.fresh, duplicate: result.seen - result.fresh, quarantined: result.quarantined }];
});

// ------------------------------------------------------------------- server

// The engine's refusals are written for people; pass them on as they are.
const REFUSALS = [PeriodError, PlatformError, DemoResetError, ModuleError, TaxError, InventoryError, ArError, PostingError, PricingError, SetupError, PosError, WorkforceError, ActionError, ApprovalError, TransitionError, PayrollError, BankingError, ReconcileError];

function refusal(e: unknown): string | null {
  if (REFUSALS.some((K) => e instanceof K)) return (e as Error).message;
  const pg = e as { code?: string; message?: string };
  // The database's own rules (check violations and raised exceptions) are
  // also written as sentences. Strip the ids they carry.
  if (pg?.code && ["23514", "23505", "P0001"].includes(pg.code) && pg.message) {
    if (pg.code === "23505") return "that already exists";
    return pg.message.replace(/\s*\((?:user|period|request)?\s*[0-9a-f-]{36}\)/gi, "")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "").replace(/\s+/g, " ").trim();
  }
  return null;
}

/**
 * The path as the request log shows it. A path segment that is a secret -- a
 * tear sheet, unsubscribe or self-schedule link, any long random token -- is
 * shown as [token]; ids (uuids) and ordinary words stay.
 */
const SECRET_AFTER = /^(\/sheet|\/crm\/u|\/delivery\/schedule)\/[^/]+/;
export function logPath(path: string): string {
  // the link routes whose next segment is always a secret, whatever it looks like
  const p = path.replace(SECRET_AFTER, "$1/[token]");
  // anything else that looks random: 16+ token characters, not an id, not a lower-case slug (approve-timecards)
  return p.split("/").map((seg) => (/^[A-Za-z0-9_-]{16,}$/.test(seg) && !UUID.test(seg) && !/^[a-z]+(-[a-z]+)*$/.test(seg) ? "[token]" : seg)).join("/");
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url ?? "/", "http://local");
    let status = 500;
    try {
      // HEAD is answered as GET; Node leaves the body off by itself.
      const method = req.method === "HEAD" ? "GET" : req.method;
      const r = routes.find((x) => x.method === method && x.path.test(url.pathname));
      if (!r) {
        const pathKnown = routes.some((x) => x.path.test(url.pathname));
        throw new HttpError(pathKnown ? 405 : 404, pathKnown ? "method not allowed" : "not found");
      }
      let who: Who | null = null;
      if (r.auth === "token") {
        who = await authenticate(req);
        if (!who) throw new HttpError(401, "sign in, or send a valid API token");
        if (who.via === "session" && method !== "GET") requirePageHeader(req);
      }
      const [s, body, headers] = await r.fn(req, url, url.pathname.match(r.path)!, who);
      status = s;
      if (body instanceof Html) {
        const nonce = randomBytes(16).toString("base64");
        page(res, s, body.text.replaceAll("__NONCE__", nonce), nonce, headers);
      } else if (body instanceof Asset) {
        res.writeHead(s, { ...BASE_HEADERS, "cache-control": "no-cache", "content-type": body.type, ...headers });
        res.end(body.text);
      } else if (s === 204) {
        res.writeHead(204, { ...BASE_HEADERS, ...headers });
        res.end();
      } else {
        json(res, s, body, headers);
      }
    } catch (e) {
      const why = refusal(e);
      if (e instanceof ChannelRefused) { status = 403; json(res, 403, { error: e.message }); }
      else if (e instanceof HttpError) { status = e.status; json(res, e.status, { error: e.message }); }
      else if (why) { status = 409; json(res, 409, { error: why }); }
      else {
        status = 500;
        // A short reference the person can read out; the ERP team finds the detail in the Operator console.
        const ref = await recordError(e, { kind: "request", method: req.method, path: logPath(url.pathname), status: 500 });
        if (!res.headersSent) json(res, 500, { error: `Something went wrong on our side (ref ${ref}). Nothing was changed; tell the ERP team the reference if it happens again.`, ref });
      }
    } finally {
      // method, path, status, time. Never bodies, never tokens.
      console.log(`${req.method} ${logPath(url.pathname)} ${status} ${Date.now() - t0}ms`);
    }
  });
}

export async function start(): Promise<http.Server> {
  if (TOKEN().length < 32) {
    throw new Error("ERP_API_TOKEN must be set to at least 32 characters. Refusing to start open.");
  }
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    throw new Error(
      "DATABASE_URL is not set, so there is no database to connect to. On Render: " +
      "ERP-api -> Environment -> add DATABASE_URL with the database's Internal Database URL.");
  }
  if (!APP || !APP_JS || !APP_CSS) console.warn("the app files are not all in server/; the root address will say so");
  installProcessHandlers();
  console.log(describeClientIp());
  const applied = await migrate({ seed: TRIAL });
  console.log(applied.length ? `migrations: applied ${applied.length}` : "migrations: up to date");
  if (TRIAL) {
    // Placeholder activity for the trial's placeholder company. Never allowed
    // to stop the service starting.
    await loadSampleActivity((s) => console.log(s)).catch((e) =>
      console.error(`sample activity could not load, and nothing of it was kept: ${describeError(e)}`));
  }
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(PORT, "0.0.0.0", resolve));
  console.log(`erp-api ${VERSION} listening on ${PORT}`);
  if (devShortKeys()) console.log("development: ERP_SEED=placeholder, so operator logins may use short access keys; remove ERP_SEED before go-live");
  // The outbox: email and texts a restart left queued go out within a minute. A message only just
  // queued is left to the request that queued it (a sign-in code lives only in that request's memory).
  const outbox = setInterval(() => {
    import("../packages/core/messaging.ts").then((m) => m.drainQueued({ olderThanSec: 60, limit: 50 }))
      .catch((e) => console.error(`outbox: ${describeError(e)}`));
  }, 60_000);
  outbox.unref();
  // Due jobs run here, one runner across instances (server/scheduler.ts); render.yaml's cron service stays off.
  const stopScheduler = startScheduler((s) => console.log(s));
  // after an uncaught exception: stop taking requests, let the ones in flight finish, then go (errors.ts exits within 10s)
  onFatal(() => new Promise<void>((resolve) => { clearInterval(outbox); stopScheduler(); server.close(() => resolve()); }));
  const stop = () => { clearInterval(outbox); stopScheduler(); server.close(() => pool.end().then(() => process.exit(0))); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => {
    console.error(`erp-api could not start: ${describeError(e)}`);
    process.exit(1);
  });
}
