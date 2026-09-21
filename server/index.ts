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
// The token is an operator key, not per-person sign-in, and choosing who to
// act as is the operator's to make. That is right for the trial and wrong for
// real books: per-person sign-in, with each person only ever acting as
// themselves, comes before any real data does.

import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pool, tx, q, type Scope, type Client } from "../packages/core/db.ts";
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
import { migrate } from "../scripts/migrate.ts";
import * as views from "./views.ts";
import * as act from "./actions.ts";
import { ActionError, type Actor } from "./actions.ts";
import { loadSampleActivity } from "./sample.ts";

const PORT = Number(process.env.PORT ?? 10000);
const TOKEN = process.env.ERP_API_TOKEN ?? "";
const EMAIL_TOKEN = process.env.ERP_EMAIL_INBOUND_TOKEN ?? "";
const ENTITY = process.env.ERP_ENTITY_ID ?? "22222222-2222-2222-2222-222222222222";
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
  text: string;
  type: string;
  constructor(text: string, type: string) {
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

/** credential_ref "secret://sftp/first-valley/pentex" -> env ERP_SECRET_SFTP_FIRST_VALLEY_PENTEX */
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

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, 256 * 1024);
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
const sessionKey = () => createHmac("sha256", TOKEN).update("pentex-erp/session/v1").digest();

function cleanName(v: unknown): string {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

function sessionCookie(name: string, expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ n: name, e: expSeconds })).toString("base64url");
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

export function sessionFrom(req: http.IncomingMessage): { name: string; exp: number } | null {
  const raw = cookieValue(req, SESSION_COOKIE);
  const dot = raw.indexOf(".");
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const expected = createHmac("sha256", sessionKey()).update(payload).digest("base64url");
  if (!safeEqual(raw.slice(dot + 1), expected)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof d.e !== "number" || d.e * 1000 <= Date.now()) return null;
    return { name: cleanName(d.n) || "Operator", exp: d.e };
  } catch {
    return null;
  }
}

type Who = { via: "token" } | { via: "session"; name: string; exp: number };

function authenticate(req: http.IncomingMessage): Who | null {
  const presented = bearer(req);
  // A script that sends a wrong token is refused outright, not quietly
  // judged by whatever cookie happens to ride along.
  if (presented) return safeEqual(presented, TOKEN) ? { via: "token" } : null;
  const s = sessionFrom(req);
  return s ? { via: "session", ...s } : null;
}

/** What the audit trail records as the actor, when nobody has been chosen. */
const labelFor = (who: Who | null, apiLabel: string): string =>
  who?.via === "session" ? `${who.name} (web)` : apiLabel;

// A crude brake on guessing. The token is long enough that guessing is
// hopeless anyway; this keeps the log from filling with it.
let failWindow = 0;
let failCount = 0;
function noteSignInFailure(): void {
  const now = Date.now();
  if (now - failWindow > 10 * 60_000) { failWindow = now; failCount = 0; }
  failCount++;
}
const signInThrottled = () => Date.now() - failWindow <= 10 * 60_000 && failCount >= 30;

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

const MISSING_PAGE = `<!doctype html><meta charset="utf-8"><title>Pentex ERP</title>
<style nonce="__NONCE__">body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem}</style>
<h1>Pentex ERP</h1><p>The service is running, but the app files (<code>server/app.html</code>, <code>app.js</code> and
<code>app.css</code>) are not all in this deploy. Add them to the repository's <code>server</code> folder and deploy again.</p>`;

// ------------------------------------------------------------------ helpers

const scopeFor = (conn: Connection, label: string, kind: "user" | "agent" | "system" = "user"): Scope => ({
  tenantId: conn.tenant_id,
  entityId: conn.entity_id ?? ENTITY,
  actor: { kind, label },
});

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

const actingId = (req: http.IncomingMessage): string | null => {
  const v = String(req.headers["x-pentex-as"] ?? "").trim();
  return UUID.test(v) ? v : null;
};

/** The person a change is done as: named by the request, and one of the company's own. */
async function actorFor(c: Client, co: views.Company, req: http.IncomingMessage, who: Who): Promise<Actor> {
  const id = actingId(req);
  if (!id) throw new HttpError(400, "pick who you are acting as");
  const p = await views.person(c, co, id);
  if (!p) throw new HttpError(403, "that person cannot act for this company");
  const label = who.via === "session"
    ? (who.name.toLowerCase() === p.name.toLowerCase() ? `${who.name} (web)` : `${who.name} (web) as ${p.name}`)
    : `api as ${p.name}`;
  return { personId: p.id, personName: p.name, label };
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

/** A browser request that changes something must carry the page's header. */
function requirePageHeader(req: http.IncomingMessage): void {
  if (req.headers["x-pentex-erp"] !== "1") {
    throw new HttpError(403, "this request did not come from the ERP's own page");
  }
}

const CO = "/api/c/([0-9a-fA-F-]{36})";

/** A read about one company. The acting person, if named, must be one of its own. */
function coGet(tail: string, fn: (c: Client, co: views.Company, url: URL, m: RegExpMatchArray, personId: string | null) => Promise<unknown>) {
  route("GET", new RegExp(`^${CO}${tail}$`), "token", async (req, url, m) => {
    const c = await pool.connect();
    try {
      const co = await companyOr404(c, m[1]);
      let personId = actingId(req);
      if (personId && !(await views.person(c, co, personId))) personId = null;
      const out = await fn(c, co, url, m, personId);
      if (out === null) throw new HttpError(404, "not found");
      return [200, out];
    } finally {
      c.release();
    }
  });
}

/** A change to one company, done as a named person, in one transaction. */
function coPost(tail: string, fn: (c: Client, co: views.Company, a: Actor, body: Record<string, unknown>, m: RegExpMatchArray) => Promise<unknown>) {
  route("POST", new RegExp(`^${CO}${tail}$`), "token", async (req, _url, m, who) => {
    const body = await readJson(req);
    const c0 = await pool.connect();
    let co: views.Company;
    let actor: Actor;
    try {
      co = await companyOr404(c0, m[1]);
      actor = await actorFor(c0, co, req, who!);
    } finally {
      c0.release();
    }
    const out = await tx({ kind: "user", id: actor.personId, label: actor.label }, (c) => fn(c, co, actor, body, m));
    return [200, out];
  });
}

const param = (url: URL, k: string) => url.searchParams.get(k) ?? "";
const monthStart = () => new Date().toISOString().slice(0, 8) + "01";
const todayStr = () => new Date().toISOString().slice(0, 10);

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
  APP && APP_JS && APP_CSS ? APP.replaceAll("__VERSION__", ASSET_VERSION) : MISSING_PAGE)]);
route("GET", /^\/app\.js$/, "none", async () => {
  if (!APP_JS) throw new HttpError(404, "not found");
  return [200, new Asset(APP_JS, "text/javascript; charset=utf-8")];
});
route("GET", /^\/app\.css$/, "none", async () => {
  if (!APP_CSS) throw new HttpError(404, "not found");
  return [200, new Asset(APP_CSS, "text/css; charset=utf-8")];
});
route("GET", /^\/favicon\.ico$/, "none", async () => [204, null]);

// Sign in with the operator key and a name for the audit trail.
route("POST", /^\/session$/, "none", async (req) => {
  requirePageHeader(req);
  if (signInThrottled()) throw new HttpError(429, "too many wrong keys; wait ten minutes and try again");
  const body = await readJson(req);
  const key = String(body.key ?? "");
  const name = cleanName(body.name);
  if (!name) throw new HttpError(400, "put your name in, so what you do here is recorded against it");
  if (!key || !safeEqual(key, TOKEN)) {
    noteSignInFailure();
    await sleep(700);
    console.log("sign-in refused");
    throw new HttpError(401, "that access key did not match");
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  console.log(`signed in: ${name}`);
  return [200, { name, until: new Date(exp * 1000).toISOString() }, { "set-cookie": sessionCookie(name, exp) }];
});

route("POST", /^\/session\/end$/, "none", async (req) => {
  requirePageHeader(req);
  return [200, { ok: true }, { "set-cookie": CLEAR_COOKIE }];
});

// ------------------------------------------------------ the app's own API

// Who is signed in, and every company the operator keeps books for.
route("GET", /^\/api\/me$/, "token", async (_req, _url, _m, who) => {
  const c = await pool.connect();
  try {
    return [200, {
      viewer: who?.via === "session" ? { name: who.name, via: "session", until: new Date(who.exp * 1000).toISOString() }
                                     : { name: "API token", via: "token" },
      trial: TRIAL,
      trialEnds: TRIAL_ENDS || null,
      version: VERSION,
      defaultCompany: ENTITY,
      companies: await views.companies(c),
    }];
  } finally { c.release(); }
});

coGet("/people", (c, co) => views.people(c, co));
coGet("/home", (c, co, _u, _m, p) => views.home(c, co, p));
coGet("/options", (c, co) => views.formOptions(c, co));

coGet("/approvals", (c, co, _u, _m, p) => views.approvals(c, co, p));
coPost("/approvals/([0-9a-fA-F-]{36})", (c, co, a, b, m) =>
  act.decideRequest(c, co, a, { requestId: m[2], decision: b.decision, note: b.note }));

coGet("/bills", (c, co, url) => views.bills(c, co, param(url, "tab") || "attention"));
coGet("/bills/([0-9a-fA-F-]{36})", (c, co, _u, m) => views.bill(c, co, m[2]));
coPost("/bills", (c, co, a, b) => act.newBill(c, co, a, b));
coPost("/bills/([0-9a-fA-F-]{36})/accept", (c, co, a, b, m) => act.acceptBill(c, co, a, { id: m[2], reason: b.reason }));
coPost("/bills/([0-9a-fA-F-]{36})/reject", (c, co, a, b, m) => act.rejectBill(c, co, a, { id: m[2], reason: b.reason }));

coGet("/vendors", (c, co) => views.vendors(c, co));
coPost("/vendors", (c, co, a, b) => act.addVendor(c, co, a, b));

coGet("/payment-runs", (c, co) => views.paymentRuns(c, co));
coGet("/payment-runs/([0-9a-fA-F-]{36})", (c, co, _u, m) => views.paymentRun(c, co, m[2]));
coPost("/payment-runs", (c, co, a, b) => act.createPaymentRun(c, co, a, b));
coPost("/payment-runs/([0-9a-fA-F-]{36})/submit", (c, co, a, _b, m) => act.submitPaymentRun(c, co, a, { id: m[2] }));
coPost("/payment-runs/([0-9a-fA-F-]{36})/release", (c, co, a, _b, m) => act.releasePaymentRun(c, co, a, { id: m[2] }));
coPost("/payment-runs/([0-9a-fA-F-]{36})/cancel", (c, co, a, _b, m) => act.cancelPaymentRun(c, co, a, { id: m[2] }));

coGet("/payroll", (c, co) => views.payroll(c, co));
coGet("/payroll/runs/([0-9a-fA-F-]{36})", (c, co, _u, m) => views.payrollRun(c, co, m[2]));
coGet("/payroll/periods/([0-9a-fA-F-]{36})/timecards", (c, co, _u, m) => views.timecards(c, co, m[2]));
coPost("/payroll/periods/([0-9a-fA-F-]{36})/approve-timecards", (c, co, a, _b, m) => act.approveTimecards(c, co, a, { periodId: m[2] }));
coPost("/payroll/periods/([0-9a-fA-F-]{36})/build", (c, co, a, _b, m) => act.buildPayroll(c, co, a, { periodId: m[2] }));
coPost("/payroll/runs/([0-9a-fA-F-]{36})/request", (c, co, a, _b, m) => act.requestPayroll(c, co, a, { runId: m[2] }));
coPost("/payroll/runs/([0-9a-fA-F-]{36})/release", (c, co, a, _b, m) => act.releasePayroll(c, co, a, { runId: m[2] }));
coPost("/payroll/runs/([0-9a-fA-F-]{36})/post", (c, co, a, _b, m) => act.postPayroll(c, co, a, { runId: m[2] }));
coPost("/payroll/next-period", (c, co, a) => act.openNextPeriod(c, co, a));

coGet("/books/pnl", (c, co, url) => {
  const from = DAY.test(param(url, "from")) ? param(url, "from") : monthStart();
  const to = DAY.test(param(url, "to")) ? param(url, "to") : todayStr();
  return views.pnl(c, co, from, to);
});
coGet("/books/account/([0-9A-Za-z.-]{1,20})", (c, co, url, m) => {
  const from = DAY.test(param(url, "from")) ? param(url, "from") : monthStart();
  const to = DAY.test(param(url, "to")) ? param(url, "to") : todayStr();
  const store = param(url, "store");
  return views.accountLines(c, co, m[2], from, to, store === "none" || UUID.test(store) ? store : null);
});
coGet("/books/entry/([0-9a-fA-F-]{36})", (c, co, _u, m) => views.entry(c, co, m[2]));
coGet("/books/trial-balance", (c, co, url) =>
  views.trialBalance(c, co, DAY.test(param(url, "asOf")) ? param(url, "asOf") : todayStr()));

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
route("GET", /^\/api\/overview$/, "token", async (_req, _url, _m, who) => {
  const c = await pool.connect();
  try {
    const co = await views.loadCompany(c, ENTITY);
    if (!co) throw new HttpError(404, "the configured company does not exist in this database");
    return [200, {
      entity: { name: co.name },
      viewer: who?.via === "session" ? { name: who.name, via: "session", until: new Date(who.exp * 1000).toISOString() }
                                     : { name: "API token", via: "token" },
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

route("GET", /^\/api\/connections$/, "token", async () => {
  const c = await pool.connect();
  try {
    const co = await views.loadCompany(c, ENTITY);
    if (!co) throw new HttpError(404, "the configured company does not exist in this database");
    return [200, await views.connections(c, co)];
  } finally { c.release(); }
});

route("GET", /^\/api\/quarantine$/, "token", async () => {
  const c = await pool.connect();
  try { return [200, await openQuarantine(c, ENTITY)]; } finally { c.release(); }
});

route("GET", /^\/api\/intake$/, "token", async () => {
  const c = await pool.connect();
  try {
    return [200, await q(c, `select * from statement_intake where entity_id = $1 order by account_name`, [ENTITY])];
  } finally { c.release(); }
});

route("GET", /^\/api\/gaps$/, "token", async () => {
  const c = await pool.connect();
  try {
    const co = await views.loadCompany(c, ENTITY);
    if (!co) throw new HttpError(404, "the configured company does not exist in this database");
    return [200, (await views.gaps(c, co)).slice(0, 200).map(({ bank_account_id: _id, ...g }) => g)];
  } finally { c.release(); }
});

route("GET", /^\/api\/runs$/, "token", async () => {
  const c = await pool.connect();
  try {
    return [200, await q(c, `
      select c.name, r.trigger, r.started_at, r.files_seen, r.files_new, r.files_failed, r.outcome, r.error
        from ingest_run r join connection c on c.id = r.connection_id
       where c.entity_id = $1 order by r.started_at desc limit 50`, [ENTITY])];
  } finally { c.release(); }
});

// Hand upload. The body is the file.
route("POST", /^\/api\/connections\/([^/]+)\/upload$/, "token", async (req, url, m, who) => {
  const conn = await connectionOr404(m[1]);
  if (conn.channel !== "manual_upload") {
    throw new HttpError(409, `${conn.name} is a ${conn.channel} connection, not an upload one`);
  }
  const bytes = await readBody(req);
  if (!bytes.length) throw new HttpError(400, "the request body is empty; send the file as the body");
  const filename = (url.searchParams.get("filename") ?? "upload").slice(0, 200);
  let label = labelFor(who, "api upload");
  const as = actingId(req);
  if (as && conn.entity_id) {
    const c0 = await pool.connect();
    try {
      const co = await views.loadCompany(c0, conn.entity_id);
      const p = co ? await views.person(c0, co, as) : null;
      if (p && who?.via === "session" && p.name.toLowerCase() !== who.name.toLowerCase()) label = `${who.name} (web) as ${p.name}`;
    } finally { c0.release(); }
  }
  const result = await tx({ kind: "user", label }, async (c) => {
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
route("POST", /^\/api\/quarantine\/([^/]+)\/dismiss$/, "token", async (req, _url, m, who) => {
  if (!UUID.test(m[1])) throw new HttpError(404, "no such file");
  const body = await readJson(req);
  const reason = String(body.reason ?? "").trim().slice(0, 500);
  if (!reason) throw new HttpError(400, "say why, so the next person knows");
  const c0 = await pool.connect();
  let conn: Connection;
  try {
    const hit = await q<{ connection_id: string; status: string }>(c0, `
      select f.connection_id, f.status from inbound_file f join connection c on c.id = f.connection_id
       where f.id = $1 and c.entity_id = $2`, [m[1], ENTITY]);
    if (!hit.length) throw new HttpError(404, "no such file");
    if (hit[0].status !== "quarantined") throw new HttpError(409, "that file is not in quarantine any more");
    conn = await loadConnection(c0, hit[0].connection_id);
  } finally { c0.release(); }
  const label = labelFor(who, "api dismiss");
  await tx({ kind: "user", label }, (c) => releaseQuarantine(c, scopeFor(conn, label), m[1], "ignored", reason));
  return [200, { ok: true }];
});

// Pull on demand. Free hosting has no cron, so this is how a scheduled
// connection gets run until there is one.
route("POST", /^\/api\/connections\/([^/]+)\/run$/, "token", async (_req, _url, m) => {
  const conn = await connectionOr404(m[1]);
  if (conn.channel !== "sftp" && conn.channel !== "api") {
    throw new HttpError(409, `${conn.name} is a push channel; it is run by whatever sends to it`);
  }
  try {
    const result = await tx({ kind: "system", label: "api run" }, (c) =>
      ingest(c, scopeFor(conn, "api run", "system"), conn.id, { trigger: "manual" }));
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
  const presented = bearer(req) || url.searchParams.get("token") || "";
  if (!EMAIL_TOKEN || !safeEqual(presented, EMAIL_TOKEN)) {
    throw new HttpError(401, "inbound email needs its own token");
  }
  const raw = await readBody(req);
  let msg: {
    From?: string; To?: string; OriginalRecipient?: string; Subject?: string; MessageID?: string;
    Attachments?: { Name: string; Content: string; ContentType?: string }[];
  };
  try { msg = JSON.parse(raw.toString("utf8")); } catch { throw new HttpError(400, "that is not an inbound-email payload"); }

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
const REFUSALS = [ActionError, ApprovalError, TransitionError, PayrollError, BankingError, ReconcileError];

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
        who = authenticate(req);
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
        console.error(`error on ${req.method} ${url.pathname}: ${describeError(e)}`);
        json(res, 500, { error: "internal error; the detail is in the service log" });
      }
    } finally {
      // method, path, status, time. Never bodies, never tokens.
      console.log(`${req.method} ${url.pathname} ${status} ${Date.now() - t0}ms`);
    }
  });
}

export async function start(): Promise<http.Server> {
  if (TOKEN.length < 32) {
    throw new Error("ERP_API_TOKEN must be set to at least 32 characters. Refusing to start open.");
  }
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    throw new Error(
      "DATABASE_URL is not set, so there is no database to connect to. On Render: " +
      "pentex-erp-api -> Environment -> add DATABASE_URL with the database's Internal Database URL.");
  }
  if (!APP || !APP_JS || !APP_CSS) console.warn("the app files are not all in server/; the root address will say so");
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
  console.log(`pentex-erp ${VERSION} listening on ${PORT}`);
  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => {
    console.error(`pentex-erp could not start: ${describeError(e)}`);
    process.exit(1);
  });
}
