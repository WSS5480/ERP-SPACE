// The ERP's front door: an HTTP service over the core, with nothing clever in it.
//
// It does three jobs. It runs migrations when it starts, so a fresh database
// becomes a working one without anyone touching it. It exposes read endpoints
// for the views that matter at a glance -- which feeds are healthy, what is
// quarantined, which days have no statement. And it gives every push channel
// a real door: hand upload, signed webhooks, and inbound email.
//
// Security posture, stated plainly because this holds financial data:
//
//   It refuses to start without an API token of real length. There is no
//   "open by default" mode to forget to turn off.
//
//   Every /api route needs that token. /health is the only unauthenticated
//   route and it returns no business data.
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
// This token is an operator key, not per-person sign-in. Real users, roles
// and sessions are the next piece of work; until then, treat the token like
// the keys to the office.

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pool, tx, q, type Scope } from "../packages/core/db.ts";
import {
  ingest, loadConnection, health, openQuarantine, handlerFor,
  ChannelRefused, type Offered, type Connection,
} from "../packages/core/connections.ts";
import "../packages/core/statements.ts"; // registers the bank_statement handler
import { migrate } from "../scripts/migrate.ts";

const PORT = Number(process.env.PORT ?? 10000);
const TOKEN = process.env.ERP_API_TOKEN ?? "";
const EMAIL_TOKEN = process.env.ERP_EMAIL_INBOUND_TOKEN ?? "";
const ENTITY = process.env.ERP_ENTITY_ID ?? "22222222-2222-2222-2222-222222222222";
const MAX_BODY = 20 * 1024 * 1024;
const STARTED = new Date().toISOString();

// ------------------------------------------------------------------ helpers

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** credential_ref "secret://sftp/first-valley/pentex" -> env ERP_SECRET_SFTP_FIRST_VALLEY_PENTEX */
export function secretEnvName(ref: string): string {
  return "ERP_SECRET_" + ref.replace(/^secret:\/\//i, "").toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
const secretFor = (ref: string): string => process.env[secretEnvName(ref)] ?? "";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "file too large; the limit is 20 MB");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function bearer(req: http.IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

function requireToken(req: http.IncomingMessage): void {
  if (!safeEqual(bearer(req), TOKEN)) throw new HttpError(401, "a valid API token is required");
}

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

// ------------------------------------------------------------------- routes

type Handler = (req: http.IncomingMessage, url: URL, m: RegExpMatchArray) => Promise<[number, unknown]>;
const routes: { method: string; path: RegExp; auth: "none" | "token" | "own"; fn: Handler }[] = [];
const route = (method: string, path: RegExp, auth: "none" | "token" | "own", fn: Handler) =>
  routes.push({ method, path, auth, fn });

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

route("GET", /^\/$/, "none", async () => [200, {
  service: "pentex-erp",
  note: "Authenticated API. Every /api route needs a bearer token; /health is public and carries no data.",
}]);

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
  try { return [200, await health(c, ENTITY)]; } finally { c.release(); }
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
    return [200, await q(c,
      `select account_name, bank_name, missing_on, days_ago from statement_gaps
        where entity_id = $1 order by missing_on desc limit 200`, [ENTITY])];
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
route("POST", /^\/api\/connections\/([^/]+)\/upload$/, "token", async (req, url, m) => {
  const conn = await connectionOr404(m[1]);
  if (conn.channel !== "manual_upload") {
    throw new HttpError(409, `${conn.name} is a ${conn.channel} connection, not an upload one`);
  }
  const bytes = await readBody(req);
  if (!bytes.length) throw new HttpError(400, "the request body is empty; send the file as the body");
  const filename = (url.searchParams.get("filename") ?? "upload").slice(0, 200);
  const result = await tx({ kind: "user", label: "api upload" }, (c) =>
    ingest(c, scopeFor(conn, "api upload"), conn.id, {
      trigger: "manual",
      offered: [{ origin: filename, bytes, contentType: req.headers["content-type"] }],
    }));
  return [200, result];
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
    // The failure is already recorded against the connection; say what it was.
    throw new HttpError(502, (e as Error).message);
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
      const r = routes.find((x) => x.method === req.method && x.path.test(url.pathname));
      if (!r) {
        const pathKnown = routes.some((x) => x.path.test(url.pathname));
        throw new HttpError(pathKnown ? 405 : 404, pathKnown ? "method not allowed" : "not found");
      }
      if (r.auth === "token") requireToken(req);
      const [s, body] = await r.fn(req, url, url.pathname.match(r.path)!);
      status = s;
      json(res, s, body);
    } catch (e) {
      if (e instanceof ChannelRefused) { status = 403; json(res, 403, { error: e.message }); }
      else if (e instanceof HttpError) { status = e.status; json(res, e.status, { error: e.message }); }
      else {
        status = 500;
        console.error(`error on ${req.method} ${url.pathname}:`, (e as Error).message);
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
  const applied = await migrate({ seed: process.env.ERP_SEED === "placeholder" });
  console.log(applied.length ? `migrations: applied ${applied.length}` : "migrations: up to date");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(PORT, "0.0.0.0", resolve));
  console.log(`pentex-erp listening on ${PORT}`);
  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
