// Server errors a person can quote: every failure the server cannot turn into a
// sentence gets a six-character reference ("ref K7Q2MX") shown to the person
// and kept in server_error, where an operator finds it in the Operator console.
//
// Also the process-level handlers (an unhandled rejection or an uncaught
// exception is recorded the same way) and an optional alert: ERP_ALERT_WEBHOOK
// gets one redacted line per error, at most one a minute and twenty an hour
// (the rest are counted and said in the next alert).
//
// Redaction: bearer and API tokens, cookies, email addresses, long digit runs
// (card and account numbers), and anything after password=/token=/key= are
// replaced before a message or stack is stored or sent.

import { randomBytes } from "node:crypto";
import { pool } from "../packages/core/db.ts";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I
export function newRef(): string {
  const b = randomBytes(6);
  return [...b].map((x) => ALPHABET[x % ALPHABET.length]).join("");
}

/** Take out what must never be stored or sent: tokens, secrets, emails, card and account numbers. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export function redact(s: string): string {
  // ids are not secrets and help find the row: they are set aside so the number rules below leave them whole
  const ids: string[] = [];
  const masked = String(s ?? "").replace(UUID_RE, (m) => `\u0000${ids.push(m) - 1}\u0000`);
  return scrubbed(masked).replace(/\u0000(\d+)\u0000/g, (_m, i) => ids[Number(i)] ?? "");
}
function scrubbed(s: string): string {
  return s
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\berpt_[A-Za-z0-9_-]+/g, "erpt_[redacted]")
    .replace(/\b([a-z]+:\/\/[^:\s\/@]+:)[^@\s]+@/gi, "$1[redacted]@")   // a password in a connection URL
    .replace(/\b([A-Za-z]*_?(?:password|passwd|pwd|token|secret|key|code|authorization|cookie|session))(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, "$1$2[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b\d[\d -]{11,}\d\b/g, (m) => (m.replace(/\D/g, "").length >= 12 ? "[number]" : m))
    // phone numbers: +1 555 555 0101, (555) 555-0101, 555.555.0101, 5555550101, +44 20 7946 0958
    .replace(/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone]")
    .replace(/\+\d[\d\s.-]{8,16}\d\b/g, "[phone]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[token]");
}

const ENTITY_IN_PATH = /\/api\/c\/([0-9a-fA-F-]{36})\//;

export type ErrorContext = {
  kind: "request" | "unhandled_rejection" | "uncaught_exception" | "job";
  method?: string; path?: string; status?: number; who?: string | null; entityId?: string | null;
};

/** Record an error; returns its reference. Never throws: if the database is the problem, the service log has it. */
export async function recordError(e: unknown, ctx: ErrorContext): Promise<string> {
  const ref = newRef();
  const err = e instanceof Error ? e : new Error(String(e));
  const message = redact(`${err.name && err.name !== "Error" ? `${err.name}: ` : ""}${err.message}`).slice(0, 2000) || "(no message)";
  const stack = err.stack ? redact(err.stack).slice(0, 8000) : null;
  const path = ctx.path ? redact(ctx.path).slice(0, 300) : null;
  const entity = ctx.entityId ?? (ctx.path ? ENTITY_IN_PATH.exec(ctx.path)?.[1] ?? null : null);
  console.error(`error ref ${ref} (${ctx.kind}${ctx.method ? ` ${ctx.method}` : ""}${path ? ` ${path}` : ""}): ${message}`);
  try {
    await pool.query(
      `insert into server_error (ref, kind, method, path, status, message, stack, entity_ref, tenant_ref, who)
       values ($1,$2,$3,$4,$5,$6,$7,$8::uuid,(select tenant_id from entity where id = $8::uuid),$9) /* unscoped: the install's error log */`,
      [ref, ctx.kind, ctx.method ?? null, path, ctx.status ?? null, message, stack, entity, ctx.who ? redact(ctx.who).slice(0, 120) : null]);
  } catch (x) {
    console.error(`error ref ${ref} could not be stored: ${(x as Error).message}`);
  }
  void alert(ref, ctx, message, path);
  return ref;
}

// ------------------------------------------------------------------ alerts --

const MIN_GAP_MS = 60_000, PER_HOUR = 20;
let lastAlert = 0, hourStart = 0, inHour = 0, held = 0;
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
let fetcher: Fetch = (url, init) => fetch(url, init);
/** Checks only: send alerts somewhere else and reset the limits. */
export function alertTestHooks(f: Fetch | null) { fetcher = f ?? ((url, init) => fetch(url, init)); lastAlert = 0; hourStart = 0; inHour = 0; held = 0; }

/** One line to the webhook, rate limited. Returns whether it went. */
export async function alert(ref: string, ctx: ErrorContext, message: string, path: string | null, now = Date.now()): Promise<boolean> {
  const url = (process.env.ERP_ALERT_WEBHOOK ?? "").trim();
  if (!url) return false;
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url)) return false;
  if (now - hourStart >= 3_600_000) { hourStart = now; inHour = 0; }
  if (now - lastAlert < MIN_GAP_MS || inHour >= PER_HOUR) { held++; return false; }
  lastAlert = now; inHour++;
  const more = held ? ` (+${held} more since the last alert)` : "";
  held = 0;
  const line = redact(`ERP ${process.env.RENDER_SERVICE_NAME ?? "erp-api"}: ${ctx.kind} error ref ${ref}${ctx.method ? ` on ${ctx.method}` : ""}${path ? ` ${path}` : ""}: ${message.split("\n")[0]}`).slice(0, 300) + more;
  try {
    const r = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: line, content: line }), signal: AbortSignal.timeout(5000) });
    if (r.ok) await pool.query(`update server_error set alerted = true where ref = $1 /* unscoped: the install's error log */`, [ref]).catch(() => {});
    return r.ok;
  } catch {
    return false;
  }
}

// ------------------------------------------------------ process handlers --

let installed = false;
let shutdown: () => Promise<void> = async () => {};
/** What to stop before the process exits after an uncaught exception (the server sets it: close the listener, then the pool). */
export function onFatal(fn: () => Promise<void>) { shutdown = fn; }
/**
 * Unhandled rejections are recorded and the service carries on. An uncaught
 * exception is recorded, the server stops taking requests and lets the ones in
 * flight finish (server.close()), and the process exits -- after at most 10
 * seconds whatever happens -- for Render to restart it.
 */
export function installProcessHandlers(exit: (code: number) => void = (n) => process.exit(n), graceMs = 10_000) {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => { void recordError(reason, { kind: "unhandled_rejection" }); });
  let dying = false;
  process.on("uncaughtException", (err) => {
    if (dying) return;
    dying = true;
    let gone = false;
    const done = () => { if (!gone) { gone = true; exit(1); } };
    setTimeout(done, graceMs).unref();
    const close = shutdown().catch(() => {});
    recordError(err, { kind: "uncaught_exception" }).catch(() => "").then(() => close).then(done, done);
  });
}
/** Checks only: let the handlers be installed again with another exit. */
export function resetProcessHandlersForTests() { installed = false; }

// ------------------------------------------------------- operator reads --

export async function listErrors(limit = 100) {
  return (await pool.query(`select ref, at, kind, method, path, status, message, tenant_ref, entity_ref,
      (select name from tenant t where t.id = e.tenant_ref) tenant, (select name from entity x where x.id = e.entity_ref) company, alerted
      from server_error e order by at desc limit $1 /* unscoped: the install's error log */`, [Math.min(500, Math.max(1, limit))])).rows;
}
export async function errorByRef(ref: string) {
  const r = (await pool.query(`select ref, at, kind, method, path, status, message, stack, who, tenant_ref, entity_ref,
      (select name from tenant t where t.id = e.tenant_ref) tenant, (select name from entity x where x.id = e.entity_ref) company, alerted
      from server_error e where ref = upper($1) /* unscoped: the install's error log */`, [ref.trim()])).rows;
  return r[0] ?? null;
}
