// The ERP's front door: an HTTP service over the core, with nothing clever in it.
//
// It does four jobs. It runs migrations when it starts, so a fresh database
// becomes a working one without anyone touching it. It serves the first
// screen -- feed health, what is quarantined, which days have no statement,
// and an upload button -- at the root address. It exposes read endpoints for
// the same views, for scripts. And it gives every push channel a real door:
// hand upload, signed webhooks, and inbound email.
//
// Security posture, stated plainly because this holds financial data:
//
//   It refuses to start without an API token of real length. There is no
//   "open by default" mode to forget to turn off.
//
//   Every /api route needs either that token (scripts) or a signed-in
//   browser session (people). /health is the only other public data route
//   and it returns no business data. The page itself is public, but it is
//   only a shell: every number on it comes from /api after sign-in.
//
//   Signing in takes the same token plus the person's name. The session is a
//   cookie the browser cannot read from script, sent only to this site, and
//   signed with a key derived from the token -- rotate the token in Render and
//   every session ends. Anything that changes data from a browser must also
//   carry a header a cross-site form cannot send.
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
// The token is an operator key, not per-person sign-in. The name typed at
// sign-in goes on every upload and dismissal in the audit trail, but nothing
// checks it. Real users, roles and sessions are still the next piece of work;
// until then, treat the token like the keys to the office.

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
import "../packages/core/statements.ts"; // registers the bank_statement handler
import { migrate } from "../scripts/migrate.ts";

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
// Which network clients this build actually has. The pipeline is wired for
// both; the clients themselves are the next thing to write. The screen reads
// this to say honestly what each feed is still waiting on.
const TRANSPORTS = { sftp: false, http: false };

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
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
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
  const raw = await readBody(req, 64 * 1024);
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

/** What the audit trail records as the actor. */
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

function loadPage(): string | null {
  try {
    return readFileSync(join(here, "app.html"), "utf8");
  } catch {
    return null;
  }
}
const APP = loadPage();

const MISSING_PAGE = `<!doctype html><meta charset="utf-8"><title>Pentex ERP</title>
<style nonce="__NONCE__">body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem}</style>
<h1>Pentex ERP</h1><p>The service is running, but the screen file <code>server/app.html</code> is not in this deploy.
Add it to the repository's <code>server</code> folder and deploy again.</p>`;

// ------------------------------------------------------------------ overview

const scopeFor = (conn: Connection, label: string, kind: "user" | "agent" | "system" = "user"): Scope => ({
  tenantId: conn.tenant_id,
  entityId: conn.entity_id ?? ENTITY,
  actor: { kind, label },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

type Step = { kind: "setup" | "build"; text: string };

type ConnRow = {
  id: string; name: string; source_code: string; source_name: string; direction: string;
  channel: string; mode: string; status: string; verdict: string; days_since_success: number | null;
  consecutive_failures: number; last_error: string | null; last_success_at: string | null;
  last_attempt_at: string | null; credential_ref: string | null; format: string | null;
  mailbox: string | null; host: string | null; account_name: string | null; bank_name: string | null;
  account_last4: string | null; files: number; last_file_at: string | null;
};

/**
 * What stands between a connection and its first file, split into what a
 * person has to arrange (setup) and what still has to be written (build).
 * An empty list means it is ready now.
 */
function stepsFor(r: ConnRow): Step[] {
  const steps: Step[] = [];
  // "POS takings" stays POS; "Supplier invoice" becomes "supplier invoice".
  const noun = r.source_name.split(" ").map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase())).join(" ");
  const a = /^[aeiou]/i.test(noun) ? "An" : "A";
  if (!handlerFor(r.source_code)) {
    steps.push({ kind: "build", text: `${a} ${noun} ${r.direction === "outbound" ? "writer" : "reader"}` });
  }
  const from = r.bank_name ? ` from ${r.bank_name}` : r.host ? ` for ${r.host}` : "";
  const credentialSet = !!(r.credential_ref && secretFor(r.credential_ref));
  switch (r.channel) {
    case "sftp":
      if (!credentialSet) steps.push({ kind: "setup", text: `SFTP login${from}` });
      if (!TRANSPORTS.sftp) steps.push({ kind: "build", text: "The SFTP connector" });
      break;
    case "api":
      if (!credentialSet) steps.push({ kind: "setup", text: `API key${from}` });
      if (!TRANSPORTS.http) steps.push({ kind: "build", text: "The bank API connector" });
      break;
    case "email":
      if (!EMAIL_TOKEN) steps.push({ kind: "setup", text: "The inbound-email token" });
      if (!r.files) steps.push({ kind: "setup", text: `Mail to ${r.mailbox ?? "its mailbox"} forwarded here` });
      break;
    case "webhook":
      if (!credentialSet) steps.push({ kind: "setup", text: "Its signing secret" });
      break;
  }
  return steps;
}

async function connectionsFor(c: Client, tenantId: string) {
  const rows = await q<ConnRow>(c, `
    select c.id, c.name, c.source_code, s.name as source_name, s.direction,
           c.channel, sc.mode, c.status, h.verdict, h.days_since_success,
           c.consecutive_failures, c.last_error, c.last_success_at, c.last_attempt_at,
           c.credential_ref, c.config->>'format' as format, c.config->>'mailbox' as mailbox, c.config->>'host' as host,
           b.name as account_name, b.bank_name, b.account_last4,
           (select count(*) from inbound_file f where f.connection_id = c.id)::int as files,
           (select max(f.received_at) from inbound_file f where f.connection_id = c.id) as last_file_at
      from connection c
      join connection_health h on h.connection_id = c.id
      join ingest_source s on s.code = c.source_code
      join source_channel sc on sc.source_code = c.source_code and sc.channel = c.channel
      left join bank_account b on b.id = c.bank_account_id
     where c.entity_id = $1 or (c.entity_id is null and c.tenant_id = $2)
     order by s.direction, c.name`, [ENTITY, tenantId]);
  // The reference names where the secret lives; the screen only needs to
  // know whether it is there.
  return rows.map(({ credential_ref, ...r }) => ({ ...r, steps: stepsFor({ ...r, credential_ref }) }));
}

/**
 * Every weekday in the last 30 days (or since the account opened) with no
 * statement on file -- holes included. The statement_gaps view in 0013 only
 * counts days after an account's latest statement, so a missing Wednesday
 * between two good days went unseen; this is the rule the screen uses until
 * a migration corrects the view.
 */
async function gapsFor(c: Client) {
  return await q<{ bank_account_id: string; account_name: string; bank_name: string; missing_on: string; days_ago: number }>(c, `
    with acct as (
      select b.id, b.name, b.bank_name,
             greatest(current_date - 30, coalesce(b.opened_on, current_date - 30)) as since
        from bank_account b
       where b.entity_id = $1 and b.status = 'active'
    ), days as (
      select a.id, a.name, a.bank_name, d::date as d
        from acct a, generate_series(a.since::timestamp, (current_date - 1)::timestamp, interval '1 day') d
       where extract(isodow from d) between 1 and 5
    )
    select id as bank_account_id, name as account_name, bank_name,
           d::text as missing_on, (current_date - d)::int as days_ago
      from days
     where not exists (select 1 from bank_statement s where s.bank_account_id = days.id and s.statement_date = days.d)
     order by d desc, name`, [ENTITY]);
}

async function overview(who: Who | null) {
  const c = await pool.connect();
  try {
    const ent = await q<{ name: string; tenant_id: string }>(c,
      `select e.name, e.tenant_id from entity e where e.id = $1 /* unscoped: the entity row itself */`, [ENTITY]);
    if (!ent.length) throw new HttpError(404, "the configured company does not exist in this database");

    const connections = await connectionsFor(c, ent[0].tenant_id);

    const accounts = await q(c, `
      select i.bank_account_id, i.account_name, i.bank_name, b.account_last4, b.purpose,
             l.name as location, i.connection_id, c.name as connection_name, i.channel,
             i.connection_status, i.through::text as through, i.quarantined::int as quarantined
        from statement_intake i
        join bank_account b on b.id = i.bank_account_id
        left join location l on l.id = b.location_id
        left join connection c on c.id = i.connection_id
       where i.entity_id = $1
       order by case b.purpose when 'operating' then 0 when 'deposit' then 1
                               when 'payroll' then 2 else 3 end, i.account_name`, [ENTITY]);

    const gaps = await gapsFor(c);
    for (const a of accounts as Record<string, unknown>[]) {
      const mine = gaps.filter((g) => g.bank_account_id === a.bank_account_id).map((g) => g.missing_on);
      a.missing_days = mine.length;
      a.missing_dates = mine;
    }

    const quarantine = await q(c, `
      select file_id, connection_name, source_code, channel, origin, received_at,
             quarantine_reason as reason, days_open
        from quarantined_files where entity_id = $1 order by received_at`, [ENTITY]);

    const runs = await q(c, `
      select r.id, c.name as connection_name, c.channel, r.trigger, r.actor_kind,
             r.started_at, r.finished_at, r.files_seen, r.files_new, r.files_failed, r.outcome, r.error
        from ingest_run r join connection c on c.id = r.connection_id
       where c.entity_id = $1 order by r.started_at desc limit 12`, [ENTITY]);

    return {
      entity: { name: ent[0].name },
      viewer: who?.via === "session" ? { name: who.name, via: "session", until: new Date(who.exp * 1000).toISOString() }
                                     : { name: "API token", via: "token" },
      trial: TRIAL,
      trialEnds: TRIAL_ENDS || null,
      version: VERSION,
      now: new Date().toISOString(),
      connections, accounts, quarantine, runs,
    };
  } finally {
    c.release();
  }
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

// Liveness. No business data, ever.
route("GET", /^\/health$/, "none", async () => {
  let db = false;
  let migrations = 0;
  try {
    const r = await pool.query<{ n: string }>(
      "select count(*) as n from schema_migration where filename not like 'seed/%'");
    migrations = Number(r.rows[0].n);
    db = true;
  } catch { /* reported as db:false */ }
  return [db ? 200 : 503, { ok: db, db, migrations, started: STARTED }];
});

// The screen. A shell with no data in it; everything it shows comes from
// /api/overview once someone has signed in.
route("GET", /^\/$/, "none", async () => [200, new Html(APP ?? MISSING_PAGE)]);

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

// Everything the first screen shows, in one call.
route("GET", /^\/api\/overview$/, "token", async (_req, _url, _m, who) => [200, await overview(who)]);

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
    const ent = await q<{ tenant_id: string }>(c,
      `select e.tenant_id from entity e where e.id = $1 /* unscoped: the entity row itself */`, [ENTITY]);
    if (!ent.length) throw new HttpError(404, "the configured company does not exist in this database");
    return [200, await connectionsFor(c, ent[0].tenant_id)];
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
    return [200, (await gapsFor(c)).slice(0, 200).map(({ bank_account_id: _id, ...g }) => g)];
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
  const label = labelFor(who, "api upload");
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
      } else if (s === 204) {
        res.writeHead(204, { ...BASE_HEADERS, ...headers });
        res.end();
      } else {
        json(res, s, body, headers);
      }
    } catch (e) {
      if (e instanceof ChannelRefused) { status = 403; json(res, 403, { error: e.message }); }
      else if (e instanceof HttpError) { status = e.status; json(res, e.status, { error: e.message }); }
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
  if (!APP) console.warn("server/app.html is missing; the root address will say so instead of showing the screen");
  const applied = await migrate({ seed: TRIAL });
  console.log(applied.length ? `migrations: applied ${applied.length}` : "migrations: up to date");
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
