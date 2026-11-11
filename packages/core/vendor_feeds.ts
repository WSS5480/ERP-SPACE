// Vendor API setup. A vendor has any number of feeds, each one endpoint with
// one purpose: products, pricing, quantities, freight, images, order
// submission or acknowledgments. Ashley, for one, runs separate APIs (and
// issues separate keys) for products, prices and quantities.
//
// A feed says everything about its endpoint as data: address and method;
// request as query parameters, a JSON body or an XML/SOAP envelope, with
// {{placeholders}}; response as JSON, XML or CSV and where the records sit;
// paging (page + size until a short page, offset, cursor, next link); SKU
// batching for APIs that take a list of models (Ashley ATP style); its own
// authentication and secrets; ETL steps (computed columns, as CATALOG-APP's
// builder has them); a field mapping from vendor field to ours; a schedule.
//
// Secrets: typed into the screen, they are kept AES-256-GCM encrypted in
// vendor_feed_secret under ERP_SECRET_KEY, write-only, never returned. A
// feed may instead (or also) name credential_ref, read from the environment
// as ERP_SECRET_<REF>. Settings that look like secrets are refused by code
// and by the database.
//
// Network safety (the photo fetcher's rules): https only unless the dev flag
// ERP_FEEDS_ALLOW_HTTP=1; every hop's host and every address it resolves to
// must be public; redirects followed by hand (3 at most); 10 MB per answer;
// a timeout per call; 429 and 5xx retried with back-off.
//
// Precedence: while a vendor has an active pricing feed, that feed owns
// cost, MAP and MSRP; a products feed sets them only on products it creates.
// Products and pricing meet on the vendor's model number (vendor SKU).
//
// A failed feed changes nothing (its work is inside a savepoint) and never
// blocks the vendor's other feeds.

import { applyVendorExtras, extrasFromRows } from "./configurator.ts";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { q, one, audit, type Client, type Scope } from "./db.ts";
import {
  automap, missingRequired, previewImport, applyImport, csvCell, parseMoney, parseCsv, isPrivateIp, productImage,
  CatalogError, IMPORT_FIELDS, type ImageFetch,
} from "./catalog.ts";

export class FeedError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new FeedError(msg); };

// ------------------------------------------------------------ the edge --

export type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: "manual" };
export type FetchLike = (url: string, init?: FetchInit) =>
  Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export type Mail = { to: string; subject: string; text: string; attachments: { filename: string; content: string }[] };

export type FeedEnv = {
  fetch: FetchLike;
  secret: (ref: string) => string;              // ERP_SECRET_<REF>
  sleep: (ms: number) => Promise<void>;
  mailer?: { send(m: Mail): Promise<{ id?: string }> };
  resolve?: (host: string) => Promise<string[]>;   // DNS; when present every hop's addresses are checked
  secretKey?: Buffer | null;                    // ERP_SECRET_KEY, 32 bytes
  allowHttp?: boolean;                          // ERP_FEEDS_ALLOW_HTTP=1, development only
  allowHosts?: string[];                        // ERP_FEEDS_ALLOW_HOSTS: hosts that may sit on a private network (still https)
  imageFetch?: ImageFetch;
  now?: () => Date;
};

/** credential_ref "secret://vendor/ashley" -> ERP_SECRET_VENDOR_ASHLEY (same rule as the server's). */
export function secretEnvName(ref: string): string {
  return "ERP_SECRET_" + ref.replace(/^secret:\/\//i, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function secretKeyFromEnv(): Buffer | null {
  const raw = process.env.ERP_SECRET_KEY?.trim();
  if (!raw) return null;
  const k = Buffer.from(raw, "base64");
  return k.length === 32 ? k : null;
}

export const liveEnv = (): FeedEnv => ({
  fetch: globalThis.fetch as unknown as FetchLike,
  secret: (ref) => process.env[secretEnvName(ref)] ?? "",
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  resolve: async (host) => {
    const { lookup } = await import("node:dns/promises");
    return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  },
  secretKey: secretKeyFromEnv(),
  allowHttp: process.env.ERP_FEEDS_ALLOW_HTTP === "1",
  allowHosts: (process.env.ERP_FEEDS_ALLOW_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
});

// ---------------------------------------------------------- the network --

export const MAX_ANSWER = 10 * 1024 * 1024;

async function checkHop(env: FeedEnv, raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new FeedError(`${raw.slice(0, 60)} is not a web address`); }
  need(u.protocol === "https:" || (u.protocol === "http:" && env.allowHttp), "feeds call https addresses only");
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (env.allowHosts?.includes(h)) return u;      // an operator's own allow-list (a VPN'd vendor, a test server)
  const named = h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || isPrivateIp(h);
  need(!named, "addresses on private networks are not called");
  if (env.resolve && !/^[\d.]+$|:/.test(h)) {
    let addrs: string[];
    try { addrs = await env.resolve(h); } catch { throw new FeedError(`${h} could not be found`); }
    need(addrs.length && addrs.every((a) => !isPrivateIp(a)), "addresses on private networks are not called");
  }
  return u;
}

export type Answer = { status: number; headers: { get(name: string): string | null }; text: string; url: string };

/** One call: checked hops, hand-followed redirects, a timeout, a size cap, 429/5xx retried. */
export async function call(env: FeedEnv, url: string, init: FetchInit, timeoutMs: number, what: string, tries = 3): Promise<Answer> {
  let last = "";
  for (let a = 0; a < tries; a++) {
    let at = await checkHop(env, url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      for (let hop = 0; ; hop++) {
        let r;
        try { r = await env.fetch(at.toString(), { ...init, signal: ctl.signal, redirect: "manual" }); }
        catch (e) {
          if (e instanceof FeedError) throw e;
          if (ctl.signal.aborted) throw new FeedError(`${what} took longer than ${Math.round(timeoutMs / 1000) || 1} s to answer`);
          throw new FeedError(`${what} could not be reached`);
        }
        if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
          need(hop < 3, `${what} redirects too many times`);
          at = await checkHop(env, new URL(r.headers.get("location")!, at).toString());
          continue;
        }
        if (r.status === 429 || r.status >= 500) { last = `answered ${r.status}`; break; }
        const len = Number(r.headers.get("content-length") ?? "0");
        need(!(len > MAX_ANSWER), `${what} sent more than 10 MB; ask for smaller pages`);
        const text = await r.text();
        need(text.length <= MAX_ANSWER, `${what} sent more than 10 MB; ask for smaller pages`);
        return { status: r.status, headers: r.headers, text, url: at.toString() };
      }
    } finally { clearTimeout(timer); }
    await env.sleep(500 * 2 ** a);
  }
  throw new FeedError(`${what} kept failing: ${last}`);
}

// ------------------------------------------------------------- secrets --

export const SECRET_NAMES = ["apiKey", "token", "password", "clientSecret", "atpKeyCode", "atpPassword", "sftpPassword", "sftpKey", "sftpPassphrase"] as const;
const SECRET_SET = new Set<string>(SECRET_NAMES);

/** AES-256-GCM under ERP_SECRET_KEY, bound to its owner and name (the AAD), so a sealed value cannot be moved to another row. */
export function sealSecret(key: Buffer, ownerId: string, name: string, value: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(`${ownerId}:${name}`));
  const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}
export function unsealSecret(key: Buffer, ownerId: string, name: string, iv: Buffer, ct: Buffer, tag: Buffer): string {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(`${ownerId}:${name}`));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
const seal = sealSecret, unseal = unsealSecret;

/** Typed secrets: write-only. A value sets or replaces; null clears. Audited by name, never by value. */
export async function setFeedSecrets(c: Client, s: Scope, env: FeedEnv, feedId: string, values: Record<string, string | null>) {
  const f = (await q<{ id: string }>(c, `select id from vendor_feed where id = $1 and entity_id = $2`, [feedId, s.entityId]))[0];
  need(f, "no such feed");
  const changed: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    need(SECRET_SET.has(name), `${name} is not a secret a feed keeps`);
    if (value === null) {
      const r = await q(c, `delete from vendor_feed_secret where entity_id = $1 and feed_id = $2 and name = $3 returning name`, [s.entityId, feedId, name]);
      if (r.length) changed.push(`${name} cleared`);
      continue;
    }
    const v = String(value);
    if (!v || v === "•kept•") continue;
    need(v.length <= 4000, `${name} is too long`);
    need(env.secretKey && env.secretKey.length === 32, "add ERP_SECRET_KEY to the service's environment to store passwords here");
    const box = seal(env.secretKey!, feedId, name, v);
    await c.query(`
      insert into vendor_feed_secret (entity_id, feed_id, name, iv, ciphertext, tag, last2, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict (feed_id, name) do update set iv = excluded.iv, ciphertext = excluded.ciphertext, tag = excluded.tag,
        last2 = excluded.last2, updated_by = excluded.updated_by, updated_at = now()`,
      [s.entityId, feedId, name, box.iv, box.ct, box.tag, v.slice(-2), s.actor.id || null]);
    changed.push(`${name} set`);
  }
  if (changed.length) await audit(c, s, { table: "vendor_feed_secret", rowId: feedId, action: "update", after: { secrets: changed } });
  return changed;
}

/** What the screen may know about a feed's secrets: which are set, masked to their last two characters. */
export async function secretStatus(c: Client, entityId: string, feedId: string) {
  return q<{ name: string; masked: string; updated_at: string }>(c,
    `select name, '••••' || last2 masked, updated_at from vendor_feed_secret where entity_id = $1 and feed_id = $2 order by name`, [entityId, feedId]);
}

export type FeedRow = {
  id: string | null; vendor_id: string; purpose: string; name: string; template: string; kind: string; method: string; url: string;
  request_format: string; query_params: Record<string, string>; headers: Record<string, string>; body_template: string | null;
  response_format: string; records_path: string | null; paging: Record<string, unknown>; batching: Record<string, unknown>;
  auth: Record<string, unknown>; credential_ref: string | null; secrets_from_feed_id: string | null; mapping: Record<string, string>;
  options: Record<string, unknown>; etl: EtlStep[]; schedule_cron: string | null; every_hours: number | null; active: boolean;
  rate_limit_ms: number; timeout_ms: number;
};

/**
 * Everything a feed authenticates with: the environment secret named by
 * credential_ref (a JSON object or a bare key), then the stored secrets of
 * the feed it borrows from, then its own, then the plain identifiers on the
 * Authentication section (client id, user, ATP external id and user).
 */
export async function credentialsFor(c: Client, entityId: string, env: FeedEnv, f: Pick<FeedRow, "id" | "credential_ref" | "secrets_from_feed_id" | "auth">): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (f.credential_ref) {
    const raw = env.secret(f.credential_ref).trim();
    if (raw.startsWith("{")) {
      try { Object.assign(out, JSON.parse(raw) as Record<string, string>); }
      catch { throw new FeedError(`the secret ${secretEnvName(f.credential_ref)} is not valid JSON`); }
    } else if (raw) Object.assign(out, { token: raw, apiKey: raw });
  }
  const ids = [f.secrets_from_feed_id, f.id].filter(Boolean) as string[];
  if (ids.length) {
    const rows = await q<{ feed_id: string; name: string; iv: Buffer; ciphertext: Buffer; tag: Buffer }>(c,
      `select feed_id, name, iv, ciphertext, tag from vendor_feed_secret where entity_id = $1 and feed_id = any($2)`, [entityId, ids]);
    if (rows.length) need(env.secretKey && env.secretKey.length === 32, "ERP_SECRET_KEY is not set on the server, so the stored passwords cannot be read");
    for (const id of ids) for (const r of rows.filter((x) => x.feed_id === id)) {
      try { out[r.name] = unseal(env.secretKey!, r.feed_id, r.name, r.iv, r.ciphertext, r.tag); }
      catch { throw new FeedError(`the stored ${r.name} cannot be read with this ERP_SECRET_KEY; type it again`); }
    }
  }
  for (const k of ["clientId", "user", "atpExternalId", "atpUser"]) {
    const v = f.auth?.[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  if (f.credential_ref && !Object.keys(out).length) throw new FeedError(`the secret ${secretEnvName(f.credential_ref)} is not set on the server; add it to the service's environment, or type the keys into the feed`);
  return out;
}

/** Back-compat for callers that hold an environment reference only. */
export function credentialsOf(env: FeedEnv, ref: string | null): Record<string, string> {
  if (!ref) return {};
  const raw = env.secret(ref).trim();
  need(raw, `the secret ${secretEnvName(ref)} is not set on the server; add it to the service's environment`);
  if (raw.startsWith("{")) {
    try { return JSON.parse(raw) as Record<string, string>; } catch { throw new FeedError(`the secret ${secretEnvName(ref)} is not valid JSON`); }
  }
  return { token: raw, apiKey: raw };
}

/** Every secret value this feed holds, so nothing echoed back can carry one. */
const masker = (creds: Record<string, string>, extra: string[] = []) => {
  const vals = [...Object.entries(creds).filter(([k]) => SECRET_SET.has(k) || k === "clientSecret").map(([, v]) => v), ...extra]
    .filter((v) => v && v.length >= 4).sort((a, b) => b.length - a.length);
  return (s: string) => {
    let o = s;
    for (const v of vals) {
      o = o.split(v).join("••••");
      const enc = encodeURIComponent(v);
      if (enc !== v) o = o.split(enc).join("••••");
      const x = xmlEsc(v);
      if (x !== v) o = o.split(x).join("••••");
    }
    return o;
  };
};

// --------------------------------------------------------- authentication --

type Auth = { headers: Record<string, string>; query: Record<string, string>; secrets: string[] };

/** The feed's authentication, made into headers and query parameters. An OAuth token is traded once per run. */
export async function authFor(env: FeedEnv, f: Pick<FeedRow, "auth" | "timeout_ms">, creds: Record<string, string>, cache: Map<string, string> = new Map()): Promise<Auth> {
  const a = f.auth ?? {};
  const mode = String(a.mode ?? "none");
  const out: Auth = { headers: {}, query: {}, secrets: [] };
  const keyHeader = String(a.headerName ?? "").trim();
  if (mode === "header" || (keyHeader && creds.apiKey)) {
    need(creds.apiKey, `the ${keyHeader || "key"} header needs its key; type it under Authentication`);
    out.headers[keyHeader || "x-api-key"] = creds.apiKey;
  }
  if (mode === "query") {
    need(creds.apiKey, "the key parameter needs its key; type it under Authentication");
    out.query[String(a.paramName ?? "api_key")] = creds.apiKey;
  }
  if (mode === "bearer") { need(creds.token, "bearer authentication needs a token"); out.headers.authorization = `Bearer ${creds.token}`; }
  if (mode === "basic") {
    need(creds.user && creds.password, "basic authentication needs a user and a password");
    out.headers.authorization = `Basic ${Buffer.from(`${creds.user}:${creds.password}`).toString("base64")}`;
  }
  if (mode === "oauth2") {
    const authUrl = String(a.authUrl ?? "");
    need(authUrl, "OAuth needs the token address from the vendor's API documents");
    need(creds.clientId && creds.clientSecret, "OAuth needs the client id and client secret");
    let tok = cache.get(authUrl + creds.clientId);
    if (!tok) {
      const form: Record<string, string> = { grant_type: "client_credentials", client_id: creds.clientId, client_secret: creds.clientSecret };
      if (a.scope) form.scope = String(a.scope);
      const r = await call(env, authUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form).toString() }, f.timeout_ms ?? 30000, "the token service");
      need(r.status < 400, `the token service answered ${r.status}; check the client id and secret`);
      try { tok = String((JSON.parse(r.text) as { access_token?: string }).access_token ?? ""); } catch { tok = ""; }
      need(tok, "the token service answered, but sent no access token");
      cache.set(authUrl + creds.clientId, tok!);
    }
    out.headers.authorization = `Bearer ${tok}`;
    out.secrets.push(tok!);
  }
  if (mode === "auto") {          // what migrated connections did: whatever the secret holds
    if (creds.token) out.headers.authorization = `Bearer ${creds.token}`;
    else if (creds.user && creds.password) out.headers.authorization = `Basic ${Buffer.from(`${creds.user}:${creds.password}`).toString("base64")}`;
    if (creds.apiKey && creds.apiKey !== creds.token) out.headers[keyHeader || "x-api-key"] = creds.apiKey;
  }
  return out;
}

/** Old single-connection header builder, kept for callers outside feeds. */
export async function authHeaders(env: FeedEnv, cfg: Record<string, unknown>, creds: Record<string, string>): Promise<Record<string, string>> {
  const a = await authFor(env, { auth: cfg.authUrl ? { mode: "oauth2", authUrl: cfg.authUrl } : { mode: "auto" }, timeout_ms: 30000 }, creds);
  return { accept: "application/json", ...a.headers };
}

// ------------------------------------------------------------ templates --

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const xmlUnesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, "&");
const pad = (n: number) => String(n).padStart(2, "0");

export type Ctx = Record<string, unknown> & { skus?: string[]; cred?: Record<string, string> };

/**
 * {{name}}, {{cred.name}}, {{opt.name}}: values, escaped for the format the
 * template is in. {{#skus}}…{{sku}}…{{index}}…{{/skus}}: repeated per model.
 * {{#xml}}…{{/xml}}: the inside rendered as XML, then escaped as text (a SOAP
 * envelope carrying an XML document, as Ashley's ATP does).
 */
export function render(t: string, ctx: Ctx, format: "xml" | "json" | "query" | "url" | "raw"): string {
  const esc = (v: string) => format === "xml" ? xmlEsc(v) : format === "json" ? JSON.stringify(v).slice(1, -1) : format === "url" ? encodeURIComponent(v) : v;
  let out = t.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, name: string, inner: string) => {
    if (name === "xml") return xmlEsc(render(inner, ctx, "xml"));
    const list = name === "skus" ? (ctx.skus ?? []) : Array.isArray(ctx[name]) ? (ctx[name] as unknown[]) : [];
    return list.map((v, i) => render(inner, { ...ctx, sku: String(v), item: v, index: i + 1 }, format)).join("");
  });
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), ctx);
    return v == null ? "" : esc(String(v));
  });
  return out;
}

// ------------------------------------------------------------- records --

/** Find the list of records wherever an API nested it: known wrapper keys, then the largest list of objects. */
export function unwrapRecords(payload: unknown): Record<string, unknown>[] | null {
  const isRecs = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) && v.length > 0 && v.slice(0, 20).every((x) => x && typeof x === "object" && !Array.isArray(x));
  if (isRecs(payload)) return payload;
  if (Array.isArray(payload)) return payload.length ? null : [];
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    for (const k of ["data", "items", "rows", "results", "products", "entities"]) {
      if (isRecs(o[k])) return o[k] as Record<string, unknown>[];
      if (Array.isArray(o[k]) && !(o[k] as unknown[]).length) return [];
    }
    const hunt = (n: unknown, depth: number): Record<string, unknown>[] | null => {
      if (isRecs(n)) return n;
      if (!n || typeof n !== "object" || Array.isArray(n) || depth > 4) return null;
      let best: Record<string, unknown>[] | null = null;
      for (const v of Object.values(n as Record<string, unknown>)) {
        const got = hunt(v, depth + 1);
        if (got && (!best || got.length > best.length)) best = got;
      }
      return best;
    };
    return hunt(o, 0);
  }
  return null;
}

/**
 * One record to one flat row, CATALOG-APP's rule: scalars kept; objects
 * unpacked as a.b and a.b.c; a list of objects has its first one unpacked
 * into columns (price lists, image lists) and the whole list kept compact;
 * anything deeper becomes compact JSON.
 */
export function flatten(rec: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const scalar = (v: unknown) => v == null || ["string", "number", "boolean"].includes(typeof v);
  const put = (k: string, v: unknown, depth: number) => {
    if (scalar(v)) { out[k] = v == null ? "" : String(v); return; }
    if (Array.isArray(v)) {
      if (v.length && v[0] && typeof v[0] === "object" && !Array.isArray(v[0]) && depth < 2) {
        put(k, v[0], depth + 1);
        if (v.length > 1) out[k] = JSON.stringify(v).slice(0, 300);
      } else out[k] = JSON.stringify(v).slice(0, 300);
      return;
    }
    if (depth >= 2) { out[k] = JSON.stringify(v).slice(0, 300); return; }
    for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) put(`${k}.${k2}`, v2, depth + 1);
  };
  for (const [k, v] of Object.entries(rec)) put(k, v, 0);
  return out;
}

export function recordsToCsv(rows: Record<string, string>[]): string {
  const heads: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); heads.push(k); }
  return [heads.map(csvCell).join(","), ...rows.map((r) => heads.map((h) => csvCell(r[h] ?? "")).join(","))].join("\n") + "\n";
}

const getPath = (o: unknown, path: string): unknown =>
  path.split(".").filter(Boolean).reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);

type XmlOpts = { pick?: { element: string; attr: string; equals: string }; pairs?: { name: string; value: string }[] };

/** XML elements named `name` (any namespace), as their source text. */
export function xmlElements(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*?(?:/>|>[\\s\\S]*?</(?:[\\w.-]+:)?${name}>)`, "g");
  return xml.match(re) ?? [];
}

/**
 * One XML record to one flat row: each attribute as element@attr, each leaf
 * element's text as its name (the first one wins). `pick` keeps only the
 * child element whose attribute matches (Ashley's current availability);
 * `pairs` turns description/value siblings into named columns
 * (LoadLeadTime, EXCEPTION).
 */
export function flattenXml(xml: string, o: XmlOpts = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const tokens = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, t: string) => xmlEsc(t)).replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, "")
    .match(/<\/?[^>]+>|[^<]+/g) ?? [];
  const stack: { name: string; text: string; skip: boolean }[] = [];
  let pendingPair: string | null = null;
  for (const tk of tokens) {
    if (tk.startsWith("</")) {
      const el = stack.pop();
      if (!el) continue;
      const txt = xmlUnesc(el.text.trim());
      if (el.skip) continue;
      if (o.pairs?.some((p) => p.name === el.name)) { pendingPair = txt; continue; }
      if (o.pairs?.some((p) => p.value === el.name) && pendingPair != null) { if (!(pendingPair in out)) out[pendingPair] = txt; pendingPair = null; continue; }
      if (txt && !(el.name in out)) out[el.name] = txt;
      continue;
    }
    if (tk.startsWith("<")) {
      const m = /^<([\w.:-]+)([\s\S]*?)(\/?)>$/.exec(tk);
      if (!m) continue;
      const name = m[1].split(":").pop()!;
      const parentSkip = stack.length ? stack[stack.length - 1].skip : false;
      const attrs = [...m[2].matchAll(/([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)].map((a) => [a[1].split(":").pop()!, xmlUnesc(a[3] ?? a[4] ?? "")]);
      let skip = parentSkip;
      if (!skip && o.pick && name === o.pick.element) skip = attrs.find(([k]) => k === o.pick!.attr)?.[1] !== o.pick.equals;
      if (!skip) for (const [k, v] of attrs) if (!k.startsWith("xmlns") && !(`${name}@${k}` in out)) out[`${name}@${k}`] = v;
      if (!m[3]) stack.push({ name, text: "", skip });
      continue;
    }
    if (stack.length) stack[stack.length - 1].text += tk;
  }
  return out;
}

/** The records in one answer, flattened to rows, plus what paging needs from it. */
export function parseAnswer(f: Pick<FeedRow, "response_format" | "records_path" | "options">, text: string): { rows: Record<string, string>[]; json: unknown } {
  const fmt = f.response_format;
  if (fmt === "csv") {
    const g = parseCsv(text);
    if (!g.length) return { rows: [], json: null };
    const heads = g[0].map((h) => h.trim());
    return { rows: g.slice(1).map((r) => Object.fromEntries(heads.map((h, i) => [h, (r[i] ?? "").trim()]))), json: null };
  }
  if (fmt === "xml") {
    let xml = text;
    const unwrap = String(f.options?.unwrap ?? "");
    if (unwrap) {
      const m = new RegExp(`<(?:[\\w.-]+:)?${unwrap}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${unwrap}>`).exec(xml);
      need(m, `the answer has no ${unwrap} element`);
      const inner = m![1].trim();
      const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(inner);
      xml = cdata ? cdata[1] : xmlUnesc(inner);
    }
    const el = String(f.records_path ?? "").trim();
    need(el, "say which XML element is one record (Response & paging)");
    const xo: XmlOpts = { pick: f.options?.pick as XmlOpts["pick"], pairs: f.options?.pairs as XmlOpts["pairs"] };
    return { rows: xmlElements(xml, el).map((x) => flattenXml(x, xo)), json: null };
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new FeedError("the answer is not JSON"); }
  const path = String(f.records_path ?? "").trim();
  let recs: unknown = path ? getPath(body, path) : unwrapRecords(body);
  if (path && recs && !Array.isArray(recs) && typeof recs === "object") recs = [recs];
  need(Array.isArray(recs), path ? `the answer has no list of records at ${path}` : "the answer is JSON, but no list of records was found in it");
  return { rows: (recs as unknown[]).filter((r) => r && typeof r === "object").map((r) => flatten(r as Record<string, unknown>)), json: body };
}

// ------------------------------------------------------------------ ETL --

export type EtlStep = { out: string; a: string; op: "subtract" | "percent_off" | "add" | "multiply" | "fill_blank"; b: string };

/**
 * Computed columns before mapping (CATALOG-APP's ETL steps): out = a (op) b,
 * where b is a column when one matches, otherwise a number. A discount that
 * is blank or zero means no promo, so the cell stays blank; results at or
 * under zero are blank too. fill_blank keeps a, filling its empties from b.
 */
export function applyEtl(rows: Record<string, string>[], steps: EtlStep[] = []): Record<string, string>[] {
  const num = (v: string | undefined) => { const n = Number(String(v ?? "").replace(/[^0-9.-]/g, "")); return String(v ?? "").trim() === "" || !Number.isFinite(n) ? null : n; };
  for (const st of steps.slice(0, 12)) {
    const out = String(st?.out ?? "").trim(), a = String(st?.a ?? "").trim(), b = String(st?.b ?? "").trim();
    if (!out || !a) continue;
    for (const r of rows) {
      if (st.op === "fill_blank") {
        const av = String(r[a] ?? "").trim();
        r[out] = av && !["nan", "none", "null"].includes(av.toLowerCase()) ? av : (b in r ? String(r[b] ?? "").trim() : b);
        continue;
      }
      const A = num(r[a]);
      const B = b in r ? num(r[b]) : num(b);
      if (A == null || B == null) { r[out] = ""; continue; }
      let R = st.op === "subtract" ? A - B : st.op === "percent_off" ? A * (1 - B / 100) : st.op === "add" ? A + B : st.op === "multiply" ? A * B : NaN;
      if ((st.op === "subtract" || st.op === "percent_off") && !(B > 0)) R = NaN;
      r[out] = Number.isFinite(R) && R > 0 ? (Math.round(R * 100) / 100).toFixed(2) : "";
    }
  }
  return rows;
}

// -------------------------------------------------------- purposes, fields --

export type Field = { name: string; required: boolean; help: string; aliases: string[] };
const F = (name: string, required: boolean, help: string, aliases: string[]): Field => ({ name, required, help, aliases });

export const PURPOSES = ["products", "pricing", "quantities", "freight", "images", "orders", "acknowledgments"] as const;
export const PULL_PURPOSES = ["products", "pricing", "quantities", "freight", "images", "acknowledgments"];

export const PURPOSE_FIELDS: Record<string, Field[]> = {
  products: IMPORT_FIELDS.map((f) => F(f.name, f.required, f.help, [])),
  pricing: [
    F("vendor_sku", true, "The vendor's model number", ["sku", "price.sku", "itemnumber", "item_number", "model", "modelnum"]),
    F("cost", true, "Our regular cost, each", ["price.netPriceBeforeFreight", "netPriceBeforeFreight", "cost", "regular_cost", "regularcost", "net_price", "dealer_cost", "price.cost"]),
    F("map", false, "Minimum advertised price", ["map", "price.map", "map_price", "umrp", "imap"]),
    F("msrp", false, "Suggested retail", ["msrp", "price.msrp", "suggested_retail", "list_price"]),
    F("promo_cost", false, "A lower cost while a promotion runs", ["promo_cost", "promocost", "promo", "sale_cost", "price.promoCost", "Promo Cost"]),
    F("effective_from", false, "From when (blank = now)", ["effective_from", "effectivedate", "effective_date", "start_date", "price.effectiveDate", "valid_from"]),
    F("effective_to", false, "Until when (blank = open)", ["effective_to", "end_date", "expiration_date", "price.expirationDate", "valid_to"]),
  ],
  quantities: [
    F("vendor_sku", true, "The vendor's model number", ["itemIdentifier@itemNumber", "sku", "itemnumber", "item_number", "model"]),
    F("qty", true, "Quantity they can ship now", ["availQty@value", "qty", "qty_available", "quantity", "available", "onhand", "atp"]),
    F("lead_days", false, "Days until it ships", ["LoadLeadTime", "lead_days", "leadtime", "lead_time", "lead_time_days"]),
    F("eta", false, "Date it will ship, when short", ["eta", "next_available", "available_date", "nextAvailableDate", "ship_date"]),
    F("exception", false, "Anything the vendor notes", ["EXCEPTION", "exception", "note", "message", "status_message"]),
  ],
  freight: [
    F("vendor_sku", true, "The vendor's model number", ["price.sku", "sku", "itemnumber", "item_number"]),
    F("freight", true, "Freight per unit to this store", ["price.freight", "freight", "freight_cost", "shipping"]),
    F("net_cost", false, "Net cost before freight", ["price.netPriceBeforeFreight", "netPriceBeforeFreight", "net_price", "cost"]),
  ],
  images: [
    F("vendor_sku", true, "The vendor's model number", ["sku", "itemnumber", "item_number", "model"]),
    F("image_url", true, "Main photo address", ["image_url", "images.url", "image", "imageUrl", "primaryImage.url", "photo", "url"]),
    F("image_url_2", false, "Second photo", ["image_url_2", "image2", "images.1.url"]),
    F("image_url_3", false, "Third photo", ["image_url_3", "image3"]),
  ],
  orders: [F("vendor_ref", false, "Where their answer carries their order number", ["orderNumber", "confirmationNumber", "order_number", "id"])],
  acknowledgments: [
    F("po_number", true, "Our PO number", ["po_number", "ponumber", "purchaseOrderNumber", "po", "customer_po"]),
    F("status", true, "Accept, backorder, change, reject, shipped", ["status", "ack_status", "line_status", "code", "event"]),
    F("line", false, "Our PO line", ["line", "line_no", "lineNumber", "seq"]),
    F("vendor_sku", false, "Model, when there is no line number", ["vendor_sku", "sku", "itemnumber", "model"]),
    F("qty", false, "Quantity they will ship", ["qty", "quantity", "ack_qty", "shipped_qty"]),
    F("ship_date", false, "When it ships or shipped", ["ship_date", "eta", "expected_date", "shipDate", "estimatedShipDate"]),
    F("vendor_ref", false, "Their order or notice number", ["vendor_ref", "ack_number", "orderNumber", "asn_number", "bol"]),
    F("carrier", false, "Who is carrying it, when shipped", ["carrier", "scac", "carrier_name", "carrierName", "shipVia"]),
    F("tracking", false, "Tracking or PRO number, when shipped", ["tracking", "tracking_number", "trackingNumber", "pro", "pro_number"]),
    F("delivery_date", false, "When a shipment should arrive", ["delivery_date", "deliveryDate", "estimatedDeliveryDate", "arrival_date"]),
  ],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9@]/g, "");

/** Which vendor field feeds each of ours: the saved mapping where its column is still there, then recognised names. */
export function mapFields(purpose: string, heads: string[], saved: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(saved)) if (!k.startsWith("_") && heads.includes(v)) out[k] = v;
  if (purpose === "products") {
    for (const [k, v] of Object.entries(automap(heads))) if (!out[k] && !Object.values(out).includes(v)) out[k] = v;
    return out;
  }
  const byNorm = new Map<string, string>();
  for (const h of heads) if (!byNorm.has(norm(h))) byNorm.set(norm(h), h);
  for (const f of PURPOSE_FIELDS[purpose] ?? []) {
    if (out[f.name]) continue;
    for (const a of [f.name, ...f.aliases]) {
      const hit = byNorm.get(norm(a));
      if (hit && !Object.values(out).includes(hit)) { out[f.name] = hit; break; }
    }
  }
  return out;
}

export const missingFor = (purpose: string, mapping: Record<string, string>, opts: { costOptional?: boolean } = {}) =>
  purpose === "products" ? missingRequired(mapping).filter((x) => !(opts.costOptional && x === "cost"))
    : (PURPOSE_FIELDS[purpose] ?? []).filter((f) => f.required && !mapping[f.name]).map((f) => f.name);

// ------------------------------------------------------------ templates --

export const ATP_URL = "https://aws.ashleyfurniture.com/atpinquiryservice_aws/atpinquiry.asmx";
export const ATP_NS = "http://api.AshleyFurniture.com/AtpInquiryService_AWS/AtpInquiry";
export const ATP_DUNS = "052738531";

/** Ashley's ATP inquiry: a SOAP envelope carrying the FIDX inventory-inquiry document, one itemInquiry per model. */
export const ASHLEY_ATP_TEMPLATE =
  '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
  `<ATPRequest xmlns="${ATP_NS}"><ExternalID>{{cred.atpExternalId}}</ExternalID><KeyCode>{{cred.atpKeyCode}}</KeyCode>` +
  "<sUser>{{cred.atpUser}}</sUser><sPassword>{{cred.atpPassword}}</sPassword><sXml>{{#xml}}" +
  '<?xml version="1.0" encoding="UTF-8"?><fniia:inventoryInqAdv xmlns:fniia="http://xml.FIDX.org/xml/schemas/fidxInvInqAdv_v1.3" xmlns:fnParty="http://support.furnishnet.com/xml/schemas/fnParty_v1.4">' +
  '<inquiry><document id="req_{{stamp}}" type="InventoryStatus" purpose="inquiry"><creationDate>{{date}}</creationDate><creationTime>{{time}}</creationTime></document>' +
  '<potentialBuyer><fnParty:partyIdentifier partyIdentifierCode="{{customer}}" partyIdentifierQualifierCode="SenderAssigned"/></potentialBuyer>' +
  '<potentialShipTo><fnParty:partyIdentifier partyIdentifierCode="{{shipTo}}" partyIdentifierQualifierCode="SenderAssigned"/></potentialShipTo>' +
  '<potentialSeller><fnParty:partyIdentifier partyIdentifierCode="{{duns}}" partyIdentifierQualifierCode="DUNS"/></potentialSeller>' +
  '</inquiry><items>{{#skus}}<itemInquiry lineItemNumber="{{index}}" responseType="CurrentQuantity"><itemId><itemIdentifier itemNumber="{{sku}}" itemNumberQualifier="SellerAssigned"/></itemId><itemQty unitOfMeasure="Each" value="1"/></itemInquiry>{{/skus}}</items></fniia:inventoryInqAdv>' +
  "{{/xml}}</sXml></ATPRequest></soap:Body></soap:Envelope>";

const ASHLEY_ATP_OPTIONS = {
  duns: ATP_DUNS, unwrap: "ATPRequestResult",
  pick: { element: "itemAvailability", attr: "availability", equals: "current" },
  pairs: [{ name: "systemReferenceDescription", value: "systemReferenceValue" }],
};

export type FeedDraft = Partial<FeedRow> & { purpose: string; name: string };

/** Starting values only; every one of them is editable. Addresses marked "from Ashley's developer portal" must be confirmed there. */
export function feedTemplates(template: string, vendorName = "Vendor"): FeedDraft[] {
  const ashleyAuth = { mode: "header", headerName: "Ocp-Apim-Subscription-Key" };
  const ref = (p: string) => `secret://vendor/${vendorName.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, "") || "vendor"}/${p}`;
  if (template === "ashley") {
    return [
      { purpose: "products", name: "Ashley products", template, method: "GET", url: "https://api.ashleyfurniture.com/products/v1/items",
        query_params: { Customer: "{{customer}}" }, response_format: "json", records_path: "", paging: { mode: "page", size: 250, pageParam: "Page", sizeParam: "Limit" },
        auth: ashleyAuth, credential_ref: ref("products"), options: { customer: "" }, every_hours: 24 },
      { purpose: "pricing", name: "Ashley prices", template, method: "GET", url: "https://api.ashleyfurniture.com/pricing/v1/ProductsAndPrices",
        query_params: { Customer: "{{customer}}", ShipTo: "{{shipTo}}", IncludeTentative: "False" }, response_format: "json", records_path: "entities",
        paging: { mode: "page", size: 250, pageParam: "Page", sizeParam: "Limit" }, auth: ashleyAuth, credential_ref: ref("pricing"),
        mapping: { vendor_sku: "price.sku", cost: "price.netPriceBeforeFreight" }, options: { customer: "", shipTo: "" }, every_hours: 24 },
      { purpose: "quantities", name: "Ashley quantities (ATP)", template, method: "POST", url: ATP_URL, request_format: "xml",
        headers: { SOAPAction: `"${ATP_NS}/ATPRequest"` }, body_template: ASHLEY_ATP_TEMPLATE, response_format: "xml", records_path: "itemAdvice",
        batching: { size: 40, delayMs: 1000 }, auth: { mode: "none" }, credential_ref: ref("atp"),
        mapping: { vendor_sku: "itemIdentifier@itemNumber", qty: "availQty@value", lead_days: "LoadLeadTime", exception: "EXCEPTION" },
        options: { ...ASHLEY_ATP_OPTIONS, customer: "", shipTo: "" }, timeout_ms: 90000, every_hours: 12 },
      { purpose: "freight", name: "Ashley freight by store", template, method: "GET", url: "https://api.ashleyfurniture.com/pricing/v1/ProductsAndPrices",
        query_params: { Customer: "{{customer}}", ShipTo: "{{shipTo}}", IncludeTentative: "False" }, response_format: "json", records_path: "entities",
        paging: { mode: "page", size: 250, pageParam: "Page", sizeParam: "Limit", totalPath: "metadata.totalRecords" }, auth: ashleyAuth, credential_ref: ref("pricing"),
        mapping: { vendor_sku: "price.sku", freight: "price.freight", net_cost: "price.netPriceBeforeFreight" }, options: { customer: "", shipTos: {}, parallel: 4 }, every_hours: 168 },
      { purpose: "orders", name: "Ashley orders", template, method: "POST", url: "https://api.ashleyfurniture.com/orders/v1/purchaseorders",
        request_format: "json", response_format: "json", auth: ashleyAuth, credential_ref: ref("orders"), options: { customer: "", shipTos: {} } },
    ];
  }
  if (template === "generic_json") {
    return [{ purpose: "products", name: `${vendorName} products`, template, method: "GET", url: "https://", response_format: "json",
      paging: { mode: "page", size: 100, pageParam: "page", sizeParam: "limit" }, auth: { mode: "bearer" }, every_hours: 24 }];
  }
  if (template === "csv_https") {
    return [{ purpose: "products", name: `${vendorName} price file`, template, method: "GET", url: "https://", response_format: "csv",
      paging: { mode: "none" }, auth: { mode: "none" }, every_hours: 24 }];
  }
  return [{ purpose: "products", name: `${vendorName} feed`, template: "blank", method: "GET", url: "", response_format: "json", paging: { mode: "none" }, auth: { mode: "none" } }];
}

// ------------------------------------------------------------ saving --

const SECRETY = /(password|passwd|secret|private_?key|api_?key|token|credential|signature)/i;

function cleanDraft(d: FeedDraft): FeedRow {
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const strMap = (v: unknown) => Object.fromEntries(Object.entries(obj(v)).filter(([k]) => k.trim()).map(([k, x]) => [k.trim(), String(x ?? "")]));
  return {
    id: d.id ?? null, vendor_id: String(d.vendor_id ?? ""), purpose: d.purpose, name: String(d.name ?? "").trim(), template: d.template ?? "blank",
    kind: d.kind ?? "api", method: (d.method ?? "GET").toUpperCase(), url: String(d.url ?? "").trim(), request_format: d.request_format ?? "query",
    query_params: strMap(d.query_params), headers: strMap(d.headers), body_template: d.body_template?.trim() ? d.body_template : null,
    response_format: d.response_format ?? "json", records_path: d.records_path?.trim() || null, paging: obj(d.paging), batching: obj(d.batching),
    auth: obj(d.auth), credential_ref: d.credential_ref?.trim() || null, secrets_from_feed_id: d.secrets_from_feed_id || null,
    mapping: strMap(d.mapping), options: obj(d.options), etl: Array.isArray(d.etl) ? d.etl.slice(0, 12) : [],
    schedule_cron: d.schedule_cron?.trim() || null, every_hours: d.every_hours == null || (d.every_hours as unknown) === "" ? null : Number(d.every_hours),
    active: d.active !== false, rate_limit_ms: Number(d.rate_limit_ms ?? 0) || 0, timeout_ms: Number(d.timeout_ms ?? 30000) || 30000,
  };
}

/** Who may send an email-in feed its file: addresses and @domains ("vendor.com" counts as @vendor.com). */
export function feedSenders(o: Record<string, unknown>): string[] {
  return String(o.fromContains ?? "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)
    .map((x) => (x.includes("@") ? x : `@${x}`));
}

export function validateFeed(f: FeedRow, opts: { forTest?: boolean } = {}) {
  need((PURPOSES as readonly string[]).includes(f.purpose), `a feed's purpose is one of ${PURPOSES.join(", ")}`);
  need(f.name || opts.forTest, "give the feed a name");
  need(["api", "sftp", "email", "manual"].includes(f.kind), "a feed arrives by API, SFTP, email or manual upload");
  need(["GET", "POST"].includes(f.method), "the method is GET or POST");
  need(["query", "json", "xml"].includes(f.request_format), "the request is query parameters, a JSON body or an XML body");
  need(["json", "xml", "csv"].includes(f.response_format), "the answer is JSON, XML or CSV");
  if (f.kind === "api") need(/^https?:\/\/[^\s/]+/i.test(f.url), "the feed needs its address, starting with https://");
  if (f.kind === "sftp" || f.kind === "email") need(PULL_PURPOSES.includes(f.purpose) && !["freight", "acknowledgments"].includes(f.purpose),
    `an ${f.kind === "sftp" ? "SFTP" : "email-in"} feed carries products, prices, quantities or photos; freight and order status come by API`);
  if (f.kind === "sftp") {
    const o = f.options;
    need(String(o.host ?? "").trim() && /^[a-z0-9.:_-]{1,200}$/i.test(String(o.host).trim()), "an SFTP feed needs the vendor's host, like sftp.vendor.com");
    need(String(o.user ?? "").trim(), "an SFTP feed needs the user name");
    const port = o.port == null || o.port === "" ? 22 : Number(o.port);
    need(Number.isInteger(port) && (port === 22 || (port >= 1024 && port < 65536)), "the SFTP port is 22 or the vendor's own port (1024 or above)");
    if (o.pattern) need(/^[A-Za-z0-9 ._*?()\[\]+-]{1,80}$/.test(String(o.pattern)), "the file pattern uses letters, digits, * and ? (like price*.csv)");
    if (o.maxMb != null && o.maxMb !== "") need(Number(o.maxMb) >= 1 && Number(o.maxMb) <= 50, "the largest file is 1 to 50 MB");
  }
  if (f.kind === "email") {
    const list = feedSenders(f.options);
    need(list.length, "an email-in feed lists who sends the file: an address, or @vendor.com for anyone there");
    for (const x of list) need(/^(@[a-z0-9.-]+\.[a-z]{2,}|[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,})$/i.test(x), `${x} is not an email address or an @domain`);
    need(!f.schedule_cron && !f.every_hours, "an email-in feed runs when the vendor's mail arrives; it has no schedule");
    if (f.options.pattern) need(/^[A-Za-z0-9 ._*?()\[\]+-]{1,80}$/.test(String(f.options.pattern)), "the attachment pattern uses letters, digits, * and ? (like price*.csv)");
  }
  need(["none", "page", "offset", "cursor", "link"].includes(String(f.paging.mode ?? "none")), "paging is none, page, offset, cursor or next link");
  need(["none", "header", "query", "bearer", "basic", "oauth2", "auto"].includes(String(f.auth.mode ?? "none")), "authentication is none, key header, key parameter, bearer, basic or OAuth");
  if (f.request_format !== "query" && f.method === "GET") need(!f.body_template, "a GET request carries no body; choose POST or query parameters");
  if (f.credential_ref) need(/^secret:\/\/[a-z0-9/_-]+$/.test(f.credential_ref), "an environment reference looks like secret://vendor/ashley/pricing");
  for (const [part, v] of Object.entries({ "query parameters": f.query_params, headers: f.headers, options: f.options, paging: f.paging, batching: f.batching, authentication: f.auth })) {
    for (const k of Object.keys(v)) need(!SECRETY.test(k), `${part} may not hold ${k}; type it into the secret boxes instead`);
  }
  for (const k of Object.keys(f.headers)) need(!/(authorization|cookie|key|token|secret|password)/i.test(k),
    `the ${k} header carries a secret; choose "key header" under Authentication and type the key into its box instead`);
  for (const [k, v] of Object.entries(f.query_params)) need(!(/key|sig/i.test(k) && v && !v.includes("{{")), `the ${k} parameter looks like a key; choose "key parameter" under Authentication instead`);
  if (f.body_template) need(!/<(s?password|keycode)>[^<{]+</i.test(f.body_template), "the request template holds a literal secret; use {{cred.<name>}} placeholders instead");
  if (f.schedule_cron) need(/^(\S+\s+){4}\S+$/.test(f.schedule_cron), "a schedule is five cron fields, like 15 5 * * *");
  if (f.every_hours != null) need(Number.isInteger(f.every_hours) && f.every_hours >= 1 && f.every_hours <= 720, "every N hours is 1 to 720");
  need(!(f.purpose === "orders" && (f.schedule_cron || f.every_hours)), "an order feed sends POs when you send them; it has no schedule");
  need(f.rate_limit_ms >= 0 && f.rate_limit_ms <= 60000, "the pause between calls is 0 to 60 seconds");
  need(f.timeout_ms >= 100 && f.timeout_ms <= 120000, "the timeout is 0.1 to 120 seconds");
  const size = Number(f.batching.size ?? 0);
  need(!size || (Number.isInteger(size) && size >= 1 && size <= 500), "models per call is 1 to 500");
  const ops = ["subtract", "percent_off", "add", "multiply", "fill_blank"];
  for (const st of f.etl) need(st && ops.includes(st.op) && String(st.out ?? "").trim() && String(st.a ?? "").trim(), "each ETL step needs a new column, a column, an operation and a value");
}

export async function saveFeed(c: Client, s: Scope, d: FeedDraft & { secrets?: Record<string, string | null> }, env: FeedEnv): Promise<string> {
  const f = cleanDraft(d);
  const v = (await q<{ name: string; merch: boolean; category: string | null }>(c, `select coalesce(v.dba, v.legal_name) as name,
       exists (select 1 from vendor_merchandise vm where vm.entity_id = ve.entity_id and vm.vendor_id = ve.vendor_id and vm.is_merchandise) merch, (select label from vendor_category where id = coalesce(ve.category_id, v.category_id)) category
       from vendor_entity ve join vendor v on v.id = ve.vendor_id
      where ve.entity_id = $1 and ve.vendor_id = $2 and ve.status = 'active'`, [s.entityId, f.vendor_id]))[0];
  need(v, "that vendor is not set up for this company");
  need(v.merch, `${v.name} is a ${(v.category ?? "non-merchandise").toLowerCase()} vendor; vendor APIs are for merchandise vendors (change its category under Payables → Vendors if it sells goods)`);
  validateFeed(f);
  if (f.secrets_from_feed_id) {
    const src = (await q<{ id: string }>(c, `select id from vendor_feed where id = $1 and entity_id = $2 and vendor_id = $3`, [f.secrets_from_feed_id, s.entityId, f.vendor_id]))[0];
    need(src && src.id !== f.id, "borrow keys only from another feed of the same vendor");
  }
  const cols = [f.purpose, f.name, f.template, f.kind, f.method, f.url, f.request_format, JSON.stringify(f.query_params), JSON.stringify(f.headers), f.body_template,
    f.response_format, f.records_path, JSON.stringify(f.paging), JSON.stringify(f.batching), JSON.stringify(f.auth), f.credential_ref, f.secrets_from_feed_id,
    JSON.stringify(f.mapping), JSON.stringify(f.options), JSON.stringify(f.etl), f.schedule_cron, f.every_hours, f.active, f.rate_limit_ms, f.timeout_ms];
  let id = f.id;
  if (id) {
    const r = await q(c, `update vendor_feed set purpose=$4, name=$5, template=$6, kind=$7, method=$8, url=$9, request_format=$10, query_params=$11, headers=$12,
        body_template=$13, response_format=$14, records_path=$15, paging=$16, batching=$17, auth=$18, credential_ref=$19, secrets_from_feed_id=$20,
        mapping=$21, options=$22, etl=$23, schedule_cron=$24, every_hours=$25, active=$26, rate_limit_ms=$27, timeout_ms=$28
      where id = $1 and entity_id = $2 and vendor_id = $3 returning id`, [id, s.entityId, f.vendor_id, ...cols]);
    need(r.length, "no such feed for this vendor");
  } else {
    const dup = await q(c, `select 1 from vendor_feed where entity_id = $1 and vendor_id = $2 and name = $3`, [s.entityId, f.vendor_id, f.name]);
    need(!dup.length, `${v.name} already has a feed called ${f.name}`);
    id = (await one<{ id: string }>(c, `insert into vendor_feed (entity_id, vendor_id, purpose, name, template, kind, method, url, request_format, query_params, headers,
        body_template, response_format, records_path, paging, batching, auth, credential_ref, secrets_from_feed_id, mapping, options, etl, schedule_cron,
        every_hours, active, rate_limit_ms, timeout_ms)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) returning id`,
      [s.entityId, f.vendor_id, ...cols])).id;
  }
  if (d.secrets && Object.keys(d.secrets).length) await setFeedSecrets(c, s, env, id!, d.secrets);
  await audit(c, s, { table: "vendor_feed", rowId: id!, action: f.id ? "update" : "insert",
    after: { vendor: v.name, purpose: f.purpose, name: f.name, url: f.url, auth: f.auth.mode, credentialRef: f.credential_ref } });
  return id!;
}

export async function loadFeed(c: Client, entityId: string, id: string): Promise<FeedRow & { vendor: string }> {
  const f = (await q<FeedRow & { vendor: string }>(c, `select f.*, coalesce(v.dba, v.legal_name) vendor from vendor_feed f join vendor v on v.id = f.vendor_id
                                                        where f.id = $1 and f.entity_id = $2`, [id, entityId]))[0];
  need(f, "no such feed");
  if (!f.body_template && f.template === "ashley_atp") f.body_template = ASHLEY_ATP_TEMPLATE;   // migrated ATP feeds use the built-in envelope
  return f;
}

// ------------------------------------------------------------- pulling --

type Call = { ctx: Ctx; label: string };
type PullOut = { rows: Record<string, string>[]; calls: number; first: Answer | null; firstUrl: string | null; firstRows: number; skipped: string[] };

/** The calls a run makes before paging: one, one per batch of models, or one per ship-to store. */
async function plan(c: Client, entityId: string, f: FeedRow, base: Ctx, test: boolean): Promise<Call[]> {
  const size = Number(f.batching.size ?? 0);
  if (size > 0) {
    const skus = Array.isArray(f.options.testSkus) && test && (f.options.testSkus as string[]).length ? (f.options.testSkus as string[]) :
      (await q<{ vendor_sku: string }>(c, `select distinct vendor_sku from product where entity_id = $1 and vendor_id = $2 and vendor_sku is not null
         and status <> 'discontinued' and kind <> 'kit' order by 1`, [entityId, f.vendor_id])).map((x) => x.vendor_sku);
    need(skus.length, "there are no models of this vendor in the catalog to ask about yet; run the products feed first");
    const per = test ? Math.min(size, 5) : size;
    const out: Call[] = [];
    for (let i = 0; i < skus.length; i += per) {
      out.push({ ctx: { ...base, skus: skus.slice(i, i + per), skuList: skus.slice(i, i + per).join(",") }, label: `batch ${out.length + 1} of ${Math.ceil(skus.length / per)}` });
      if (test) break;
    }
    return out;
  }
  if (f.purpose === "freight") {
    const map = (f.options.shipTos ?? {}) as Record<string, string>;
    const ids = Object.keys(map).filter((k) => String(map[k] ?? "").trim());
    need(ids.length, "list each store's ship-to number with this vendor (Freight by store)");
    const locs = await q<{ id: string; name: string }>(c, `select id, name from location where entity_id = $1 and id = any($2) order by name`, [entityId, ids]);
    need(locs.length, "the ship-to numbers name stores this company does not have");
    const calls = locs.map((l) => ({ ctx: { ...base, shipTo: String(map[l.id]).trim(), locationId: l.id, locationName: l.name }, label: `ship-to ${String(map[l.id]).trim()}` }));
    return test ? calls.slice(0, 1) : calls;
  }
  return [{ ctx: base, label: "" }];
}

/** Every page of one planned call. */
async function pages(env: FeedEnv, f: FeedRow, auth: Auth, ctx0: Ctx, label: string, test: boolean, stop: () => Promise<boolean>,
  onPage: (rows: Record<string, string>[], a: Answer, url: string) => void) {
  const pg = f.paging ?? {};
  const mode = String(pg.mode ?? "none");
  const size = Number(pg.size ?? 0) || 0;
  let page = Number(pg.start ?? 1) || 1, offset = 0, cursor = "", nextUrl = "", total = 0;
  const what = `the ${f.name || f.purpose} feed${label ? ` (${label})` : ""}`;
  for (let n = 0; n < 500; n++) {
    if (n && await stop()) throw new FeedError("stopped by a person before it finished; nothing from this run was kept");
    const ctx: Ctx = { ...ctx0, page, pageSize: size, offset, cursor };
    let url: string;
    if (nextUrl) url = nextUrl;
    else {
      const u = new URL(render(f.url, ctx, "url"));
      for (const [k, v] of Object.entries(f.query_params)) { const val = render(v, ctx, "query"); if (val !== "") u.searchParams.set(k, val); }
      if (mode === "page" && size) { u.searchParams.set(String(pg.pageParam ?? "page"), String(page)); u.searchParams.set(String(pg.sizeParam ?? "limit"), String(size)); }
      if (mode === "offset" && size) { u.searchParams.set(String(pg.offsetParam ?? "offset"), String(offset)); u.searchParams.set(String(pg.sizeParam ?? "limit"), String(size)); }
      if (mode === "cursor" && cursor) u.searchParams.set(String(pg.cursorParam ?? "cursor"), cursor);
      for (const [k, v] of Object.entries(auth.query)) u.searchParams.set(k, v);
      url = u.toString();
    }
    const headers: Record<string, string> = {
      accept: f.response_format === "json" ? "application/json" : f.response_format === "xml" ? "text/xml, application/xml" : "text/csv, */*",
      ...Object.fromEntries(Object.entries(f.headers).map(([k, v]) => [k, render(v, ctx, "raw")])), ...auth.headers };
    let body: string | undefined;
    if (f.method === "POST") {
      if (f.request_format === "json") { headers["content-type"] = "application/json"; body = f.body_template ? render(f.body_template, ctx, "json") : "{}"; }
      else if (f.request_format === "xml") { headers["content-type"] = "text/xml; charset=utf-8"; body = render(f.body_template ?? "", ctx, "xml"); }
    }
    const a = await call(env, url, { method: f.method, headers, body }, f.timeout_ms, what);
    need(a.status !== 401 && a.status !== 403, `${what} refused the credentials (${a.status}); check this feed's keys`);
    need(a.status >= 200 && a.status < 300, `${what} answered ${a.status}${n ? ` on page ${n + 1}` : ""}`);
    const { rows, json } = parseAnswer(f, a.text);
    onPage(rows, a, url);
    if (test || mode === "none") return;
    if (f.rate_limit_ms) await env.sleep(f.rate_limit_ms);
    if (mode === "page" || mode === "offset") {
      if (pg.totalPath && json) total = Number(getPath(json, String(pg.totalPath)) ?? 0) || total;
      if (!size || rows.length < size) return;
      if (total && (mode === "page" ? page * size : offset + size) >= total) return;
      page++; offset += size;
    } else if (mode === "cursor") {
      const next = json ? String(getPath(json, String(pg.cursorPath ?? "next_cursor")) ?? "") : "";
      if (!next || next === cursor || !rows.length) return;
      cursor = next;
    } else if (mode === "link") {
      let next = json && pg.nextPath ? String(getPath(json, String(pg.nextPath)) ?? "") : "";
      if (!next) {
        const link = a.headers.get("link") ?? "";
        next = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(link)?.[1] ?? "";
      }
      if (!next || !rows.length) return;
      nextUrl = new URL(next, a.url).toString();
    }
  }
  throw new FeedError(`${what} kept sending pages past 500; ask for bigger pages`);
}

const baseCtx = (f: FeedRow, creds: Record<string, string>, now: Date): Ctx => ({
  ...Object.fromEntries(Object.entries(f.options).filter(([, v]) => typeof v === "string" || typeof v === "number")),
  opt: f.options, cred: creds,
  customer: String(f.options.customer ?? ""), shipTo: String(f.options.shipTo ?? ""), duns: String(f.options.duns ?? ATP_DUNS),
  date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  stamp: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`, now: now.toISOString(),
});

async function pull(c: Client, entityId: string, env: FeedEnv, f: FeedRow, creds: Record<string, string>, test: boolean, stop: () => Promise<boolean>): Promise<PullOut> {
  const now = env.now ? env.now() : new Date();
  const auth = await authFor(env, f, creds);
  const calls = await plan(c, entityId, f, baseCtx(f, creds, now), test);
  const out: PullOut = { rows: [], calls: 0, first: null, firstUrl: null, firstRows: 0, skipped: [] };
  const batchDelay = Number(f.batching.delayMs ?? 0) || 0;
  const parallel = f.purpose === "freight" && !test ? Math.max(1, Math.min(8, Number(f.options.parallel ?? 4) || 4)) : 1;
  const one_ = async (cl: Call) => {
    const got: Record<string, string>[] = [];
    await pages(env, f, auth, cl.ctx, cl.label, test, stop, (rows, a, url) => {
      out.calls++;
      if (!out.first) { out.first = a; out.firstUrl = url; out.firstRows = rows.length; }
      for (const r of rows) {
        if (cl.ctx.locationId) r.__location = String(cl.ctx.locationId);
        got.push(r);
      }
    });
    return got;
  };
  if (parallel > 1) {
    // Freight: several stores at once; a store the vendor will not quote is skipped and named, never fatal.
    for (let i = 0; i < calls.length; i += parallel) {
      const chunk = calls.slice(i, i + parallel);
      const res = await Promise.allSettled(chunk.map(one_));
      res.forEach((r, k) => {
        if (r.status === "fulfilled") out.rows.push(...r.value);
        else if (r.reason instanceof FeedError) out.skipped.push(String(chunk[k].ctx.shipTo));
        else throw r.reason;
      });
    }
    need(out.rows.length || !out.skipped.length, `every store was refused (${out.skipped.join(", ")}); check the ship-to numbers and this feed's keys`);
    return out;
  }
  for (const [i, cl] of calls.entries()) {
    if (f.purpose === "freight") {
      try { out.rows.push(...await one_(cl)); }
      catch (e) { if (!(e instanceof FeedError) || test) throw e; out.skipped.push(String(cl.ctx.shipTo)); }
    } else out.rows.push(...await one_(cl));
    if (batchDelay && i < calls.length - 1) await env.sleep(batchDelay);
  }
  return out;
}

// ------------------------------------------------------------- testing --

export type TestResult = {
  /** SFTP: the server's key (recorded on the first good Test), files matching; email: the vendor's address */
  sftp?: { fingerprint: string | null; keyType: string | null; firstTime: boolean; changed: boolean; recorded: string | null; files: number | null; words: string; sample: { name: string; size: number; modifiedAt: string }[] };
  address?: string | null;
  ok: boolean; status: number | null; url: string | null; requestHeaders: Record<string, string>; sample: string; recordsFound: number;
  columns: string[]; mapping: Record<string, string>; missing: string[]; rows: Record<string, string>[]; problem: string | null; calls: number;
};

/**
 * Test a feed, saved or not: ONE call (the first page, the first batch of
 * five models, the first store), the answer's status and a truncated sample
 * with every secret masked, the records found, and the first five rows
 * mapped to our fields. Nothing in the catalog changes.
 */
export async function testFeed(c: Client, s: Scope, env: FeedEnv, d: FeedDraft): Promise<TestResult> {
  let f: FeedRow;
  if (d.id && !d.vendor_id) f = await loadFeed(c, s.entityId, d.id);
  else {
    f = cleanDraft(d);
    if (!f.body_template && f.template === "ashley_atp") f.body_template = ASHLEY_ATP_TEMPLATE;
    const own = (await q<{ vendor_id: string }>(c, `select vendor_id from vendor_entity where entity_id = $1 and vendor_id = $2 and status = 'active'`, [s.entityId, f.vendor_id]))[0];
    need(own, "that vendor is not set up for this company");
    if (f.id) need((await q(c, `select 1 from vendor_feed where id = $1 and entity_id = $2`, [f.id, s.entityId])).length, "no such feed");
  }
  validateFeed(f, { forTest: true });
  need(f.kind !== "manual", "a manual feed has nothing to call; upload its file on the Import tab");
  if (f.kind === "sftp" || f.kind === "email") return testFileFeed(c, s, env, f, d);
  need(f.purpose !== "orders", "an order feed is tested by sending a PO; it pulls nothing");
  const res: TestResult = { ok: false, status: null, url: null, requestHeaders: {}, sample: "", recordsFound: 0, columns: [], mapping: {}, missing: [], rows: [], problem: null, calls: 0 };
  let creds: Record<string, string> = {};
  let mask = (x: string) => x;
  await c.query("savepoint feed_test");
  try {
    // Keys typed but not yet saved are used for this one call only, never stored.
    const typed = Object.fromEntries(Object.entries((d as { secrets?: Record<string, string | null> }).secrets ?? {})
      .filter(([k, v]) => SECRET_SET.has(k) && typeof v === "string" && v && v !== "•kept•")) as Record<string, string>;
    creds = { ...(await credentialsFor(c, s.entityId, env, f.credential_ref || f.id || f.secrets_from_feed_id ? f : { ...f, credential_ref: null })), ...typed };
    mask = masker(creds);
    const p = await pull(c, s.entityId, env, f, creds, true, async () => false);
    const authNow = await authFor(env, f, creds);
    mask = masker(creds, authNow.secrets);
    res.calls = p.calls;
    res.status = p.first?.status ?? null;
    res.url = p.firstUrl ? mask(p.firstUrl) : null;
    res.requestHeaders = Object.fromEntries(Object.entries({ ...f.headers, ...authNow.headers }).map(([k, v]) =>
      [k, /authorization|key|token|secret|cookie/i.test(k) ? "••••" : mask(v)]));
    res.sample = mask((p.first?.text ?? "").slice(0, 2000));
    const rows = applyEtl(p.rows.map((r) => ({ ...r })), f.etl);
    res.recordsFound = rows.length;
    res.columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !k.startsWith("__"));
    const pricingFeed = f.purpose === "products" && await hasPricingFeed(c, s.entityId, f.vendor_id, f.id);
    res.mapping = mapFields(f.purpose, res.columns, f.mapping);
    res.missing = missingFor(f.purpose, res.mapping, { costOptional: pricingFeed });
    res.rows = rows.slice(0, 5).map((r) => Object.fromEntries(Object.entries(res.mapping).map(([ours, theirs]) => [ours, mask(String(r[theirs] ?? ""))])));
    res.ok = !res.missing.length && rows.length > 0;
    if (!rows.length) res.problem = "the call worked, but the answer held no records; check where the records are (Response & paging)";
    else if (res.missing.length) res.problem = `no column found for ${res.missing.join(", ")}; pick them under Field mapping`;
  } catch (e) {
    if (!(e instanceof FeedError) && !(e instanceof CatalogError)) throw e;
    res.problem = mask(e.message);
  } finally {
    await c.query("rollback to savepoint feed_test");
  }
  return res;
}

async function hasPricingFeed(c: Client, entityId: string, vendorId: string, exceptId: string | null) {
  return (await q(c, `select 1 from vendor_feed where entity_id = $1 and vendor_id = $2 and purpose = 'pricing' and active and kind in ('api','sftp','email')
                        and id is distinct from $3 limit 1`, [entityId, vendorId, exceptId])).length > 0;
}

// ------------------------------------------------------------- running --

export type RunResult = { runId: string; ok: boolean; note: string; rows: number; added: number; changed: number };

const day = (v: string | undefined): string | null => {
  const t = String(v ?? "").trim();
  if (!t) return null;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  need(iso, `${t.slice(0, 20)} is not a date`);
  return iso![1];
};

/** Apply the vendor's price history in effect today to its products: cost (lesser of regular and promo), MAP, MSRP, and retail when the price rule says so. */
export async function applyPriceHistory(c: Client, s: Scope, vendorId: string, rule: Record<string, unknown> = {}): Promise<number> {
  await c.query(`update vendor_price_history h set product_id = p.id from product p
                  where h.entity_id = $1 and h.vendor_id = $2 and h.product_id is null and p.entity_id = $1 and p.vendor_id = $2
                    and upper(p.vendor_sku) = upper(h.vendor_sku)`, [s.entityId, vendorId]);
  const cur = await q<{ product_id: string; cost: string; promo: string | null; map: string | null; msrp: string | null;
    p_cost: string; p_map: string | null; p_msrp: string | null; p_price: string; status: string }>(c, `
    select distinct on (h.product_id) h.product_id, h.cost_minor cost, h.promo_cost_minor promo, h.map_minor map, h.msrp_minor msrp,
           p.cost_minor p_cost, p.map_minor p_map, p.msrp_minor p_msrp, p.price_minor p_price, p.status
      from vendor_price_history h join product p on p.id = h.product_id and p.entity_id = h.entity_id
     where h.entity_id = $1 and h.vendor_id = $2 and h.product_id is not null
       and (h.effective_from is null or h.effective_from <= business_today($1)) and (h.effective_to is null or h.effective_to >= business_today($1))
     order by h.product_id, h.effective_from desc nulls last, h.recorded_at desc`, [s.entityId, vendorId]);
  const markup = rule.mode === "markup" ? Number(rule.markupBps ?? 0) : 0;
  let changed = 0;
  for (const r of cur) {
    let cost = BigInt(r.cost);
    if (r.promo != null && BigInt(r.promo) > 0n && BigInt(r.promo) < cost) cost = BigInt(r.promo);
    const map = r.map ?? r.p_map, msrp = r.msrp ?? r.p_msrp;
    let price = BigInt(r.p_price);
    if (markup > 0 && r.status !== "discontinued") {
      price = (cost * BigInt(markup) + 5000n) / 10000n;
      if (rule.ending99) price = price <= 100n ? price : (price / 100n) * 100n - 1n;
      if (map != null && price < BigInt(map)) price = BigInt(map);
    }
    if (String(cost) === r.p_cost && String(map ?? "") === String(r.p_map ?? "") && String(msrp ?? "") === String(r.p_msrp ?? "") && String(price) === r.p_price) continue;
    await c.query(`update product set cost_minor = $3, map_minor = $4, msrp_minor = $5, price_minor = $6, updated_at = now() where id = $1 and entity_id = $2`,
      [r.product_id, s.entityId, cost.toString(), map, msrp, price.toString()]);
    changed++;
  }
  return changed;
}

type Mapped = Record<string, string>;
const SHIPPED = /^(shipped|ship|in[ _-]?transit|asn|dispatched|sh)$/i;

/**
 * The pricing path every source shares (a pricing feed, an EDI 832): each
 * row goes into the vendor's price history unless it repeats the last one,
 * then the history in effect today prices the products.
 */
export async function recordVendorPrices(c: Client, s: Scope, vendorId: string, feedId: string | null, m: Mapped[], rule: Record<string, unknown> = {}) {
  let recorded = 0, unknown = 0, bad = 0;
  const known = new Set((await q<{ s: string }>(c, `select upper(vendor_sku) s from product where entity_id = $1 and vendor_id = $2 and vendor_sku is not null`,
    [s.entityId, vendorId])).map((x) => x.s));
  for (const r of m) {
    try {
      const sku = r.vendor_sku?.toUpperCase();
      need(sku, "no model");
      const cost = money(r.cost, "cost");
      need(cost != null, "no cost");
      const from = day(r.effective_from), to = day(r.effective_to);
      const vals = [cost!.toString(), money(r.map ?? "", "MAP")?.toString() ?? null, money(r.msrp ?? "", "MSRP")?.toString() ?? null,
        money(r.promo_cost ?? "", "promo cost")?.toString() ?? null, from, to];
      if (!known.has(sku!)) unknown++;
      const same = await q(c, `select 1 from (select cost_minor, map_minor, msrp_minor, promo_cost_minor, effective_from, effective_to from vendor_price_history
          where entity_id = $1 and vendor_id = $2 and vendor_sku = $3 order by recorded_at desc limit 1) h
         where h.cost_minor = $4 and h.map_minor is not distinct from $5::bigint and h.msrp_minor is not distinct from $6::bigint
           and h.promo_cost_minor is not distinct from $7::bigint and h.effective_from is not distinct from $8::date and h.effective_to is not distinct from $9::date`,
        [s.entityId, vendorId, sku, ...vals]);
      if (same.length) continue;
      // clock_timestamp, not now(): two price files in one transaction (an SFTP run) must keep their order, the later one winning.
      await c.query(`insert into vendor_price_history (entity_id, vendor_id, vendor_sku, cost_minor, map_minor, msrp_minor, promo_cost_minor, effective_from, effective_to, feed_id, recorded_at)
                     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, clock_timestamp())`, [s.entityId, vendorId, sku, ...vals, feedId]);
      recorded++;
    } catch (e) { if (e instanceof FeedError || e instanceof CatalogError) bad++; else throw e; }
  }
  const changed = await applyPriceHistory(c, s, vendorId, rule);
  return { recorded, changed, unknown, bad };
}

/** The quantities path every source shares (a quantities feed, an EDI 846): what the vendor can ship now, and when if short. */
export async function recordAvailability(c: Client, s: Scope, vendorId: string, m: Mapped[]): Promise<number> {
  let n = 0;
  const today = new Date();
  for (const r of m) {
    if (!r.vendor_sku) continue;
    const qty = r.qty === "" || r.qty == null ? null : Number(r.qty);
    let lead = r.lead_days ? Math.max(0, Math.round(Number(r.lead_days))) : null;
    if (lead == null && r.eta) { const d = day(r.eta); if (d) lead = Math.max(0, Math.ceil((Date.parse(d) - today.getTime()) / 86400000)); }
    await c.query(`
      insert into vendor_availability (entity_id, vendor_id, vendor_sku, product_id, qty_available, lead_days, exception, as_of)
      values ($1,$2,$3,(select id from product where entity_id = $1 and vendor_id = $2 and upper(vendor_sku) = upper($3) limit 1),$4,$5,$6,now())
      on conflict (entity_id, vendor_id, vendor_sku) do update set product_id = excluded.product_id, qty_available = excluded.qty_available,
        lead_days = excluded.lead_days, exception = excluded.exception, as_of = now()`,
      [s.entityId, vendorId, r.vendor_sku.toUpperCase(), qty != null && Number.isFinite(qty) ? qty : null, lead != null && Number.isFinite(lead) ? lead : null, r.exception?.slice(0, 200) || null]);
    n++;
  }
  return n;
}

/**
 * The products path every source shares, for descriptions, cartons, cube and
 * weight (an EDI 832). Cost, MAP and MSRP are kept out of it: they go through
 * the price history, so a future-dated price waits for its day.
 */
export async function applyCatalogRows(c: Client, s: Scope, vendorId: string, label: string, rows: Record<string, string>[], mapping: Record<string, string>) {
  const pv = await previewImport(c, s, { vendorId, csv: recordsToCsv(rows), filename: label.slice(0, 200), mapping, keep: ["cost_minor", "map_minor", "msrp_minor"], costOptional: true });
  const ap = await applyImport(c, s, pv.runId);
  return { runId: pv.runId, added: ap.add, changed: ap.change, same: ap.same, skipped: ap.skip };
}
const mapRows = (rows: Record<string, string>[], mapping: Record<string, string>): Mapped[] =>
  rows.map((r) => {
    const o: Mapped = Object.fromEntries(Object.entries(mapping).map(([ours, theirs]) => [ours, String(r[theirs] ?? "").trim()]));
    if (r.__location) o.__location = r.__location;
    return o;
  });

const money = (v: string, what: string): bigint | null => {
  const m = parseMoney(v);
  need(m == null || m >= 0n, `${what} ${v} is negative`);
  return m;
};

async function applyPurpose(c: Client, s: Scope, f: FeedRow & { vendor: string }, rows: Record<string, string>[], mapping: Record<string, string>,
  skipped: string[]): Promise<{ added: number; changed: number; note: string; importRun: string | null }> {
  const m = mapRows(rows, mapping);
  if (f.purpose === "products") {
    const pricing = await hasPricingFeed(c, s.entityId, f.vendor_id, f.id);
    // Covers (a cover code with a grade) are not products; sectional pieces are products and also pieces. Best effort, see the configurator.
    const { productRows, extras } = extrasFromRows(rows);
    rows = productRows;
    const pv = await previewImport(c, s, { vendorId: f.vendor_id, csv: recordsToCsv(rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("__"))))),
      filename: `${f.name} (API)`, mapping, keep: pricing ? ["cost_minor", "map_minor", "msrp_minor"] : [], costOptional: pricing });
    const ap = await applyImport(c, s, pv.runId);
    let priced = 0;
    if (pricing) priced = await applyPriceHistory(c, s, f.vendor_id, (await priceRule(c, s.entityId, f.vendor_id)));
    const cx = extras.length ? await applyVendorExtras(c, s, f.vendor_id, extras) : null;
    return { added: ap.add, changed: ap.change, importRun: pv.runId,
      note: `${rows.length} products: ${ap.add} added, ${ap.change} changed, ${ap.same} unchanged${ap.skip ? `, ${ap.skip} skipped` : ""}${pricing ? ` · cost, MAP and MSRP left to the pricing feed${priced ? ` (${priced} priced from it)` : ""}` : ""}`
        + (cx ? ` · ${cx.pieces} sectional pieces, ${cx.covers} covers${cx.skipped ? ` (${cx.skipped} not set up: ${cx.notes.slice(0, 2).join("; ")})` : ""}` : "") };
  }
  if (f.purpose === "pricing") {
    const r = await recordVendorPrices(c, s, f.vendor_id, f.id, m, (f.options.priceRule ?? {}) as Record<string, unknown>);
    return { added: r.recorded, changed: r.changed, importRun: null,
      note: `${m.length} prices: ${r.recorded} new in the history, ${r.changed} products repriced${r.unknown ? `, ${r.unknown} for models not in the catalog yet (kept for when they arrive)` : ""}${r.bad ? `, ${r.bad} unreadable rows skipped` : ""}` };
  }
  if (f.purpose === "quantities") {
    const n = await recordAvailability(c, s, f.vendor_id, m);
    return { added: n, changed: 0, importRun: null, note: `availability for ${n} models` };
  }
  if (f.purpose === "freight") {
    let n = 0;
    for (const r of m) {
      if (!r.vendor_sku || !r.__location) continue;
      const fr = money(r.freight, "freight") ?? 0n, net = money(r.net_cost ?? "", "net cost");
      await c.query(`
        insert into vendor_sku_freight (entity_id, vendor_id, vendor_sku, location_id, freight_minor, net_minor, as_of) values ($1,$2,$3,$4,$5,$6,now())
        on conflict (entity_id, vendor_id, vendor_sku, location_id) do update set freight_minor = excluded.freight_minor, net_minor = excluded.net_minor, as_of = now()`,
        [s.entityId, f.vendor_id, r.vendor_sku.toUpperCase(), r.__location, fr.toString(), net?.toString() ?? null]);
      n++;
    }
    const stores = new Set(m.map((r) => r.__location)).size;
    return { added: n, changed: 0, importRun: null,
      note: `freight: ${n} rows for ${stores} ${stores === 1 ? "store" : "stores"}${skipped.length ? ` (${skipped.length} skipped: ${skipped.join(", ")})` : ""}` };
  }
  if (f.purpose === "images") {
    let changed = 0, missingProducts = 0;
    for (const r of m) {
      if (!r.vendor_sku) continue;
      const p = (await q<{ id: string }>(c, `select id from product where entity_id = $1 and vendor_id = $2 and upper(vendor_sku) = upper($3)`, [s.entityId, f.vendor_id, r.vendor_sku]))[0];
      if (!p) { missingProducts++; continue; }
      const urls = [r.image_url, r.image_url_2, r.image_url_3].filter((u) => u && /^https:\/\/\S+$/i.test(u));
      if (!urls.length) continue;
      const cur = (await q<{ url: string }>(c, `select url from product_image where entity_id = $1 and product_id = $2 order by seq`, [s.entityId, p.id])).map((x) => x.url);
      if (cur.join("|") === urls.join("|")) continue;
      await c.query(`delete from product_image where entity_id = $1 and product_id = $2`, [s.entityId, p.id]);
      for (const [i, u] of urls.entries()) await c.query(`insert into product_image (entity_id, product_id, seq, url) values ($1,$2,$3,$4)`, [s.entityId, p.id, i + 1, u.slice(0, 1000)]);
      changed++;
    }
    return { added: 0, changed, importRun: null, note: `photos: ${changed} products updated${missingProducts ? `, ${missingProducts} models not in the catalog` : ""}` };
  }
  if (f.purpose === "acknowledgments") {
    // Order status: "shipped" (or in transit) rows are ship notices, the same as an EDI 856; the rest are acknowledgments (855).
    const { importAcks, recordShipmentsFromRows } = await import("./purchasing.ts");
    const shipped = m.filter((r) => SHIPPED.test(r.status ?? ""));
    const acks = m.filter((r) => !SHIPPED.test(r.status ?? ""));
    let applied = 0, rowsN = 0;
    const problems: string[] = [];
    if (acks.length) {
      const csv = recordsToCsv(acks.map((r) => ({ po_number: r.po_number ?? "", line: r.line ?? "", vendor_sku: r.vendor_sku ?? "", status: r.status ?? "",
        qty: r.qty ?? "", ship_date: r.ship_date ?? "", vendor_ref: r.vendor_ref ?? "" })));
      const r = await importAcks(c, s, { csv, filename: `${f.name} (API)`, vendorId: f.vendor_id });
      applied += r.applied; rowsN += r.rows;
      problems.push(...r.problems.map((p) => p.message));
    }
    let shipNote = "";
    if (shipped.length) {
      const r = await recordShipmentsFromRows(c, s, f.vendor_id, shipped, "api");
      shipNote = `, ${r.shipments} ship ${r.shipments === 1 ? "notice" : "notices"} for ${r.lines} lines`;
      problems.push(...r.problems);
    }
    return { added: applied, changed: 0, importRun: null,
      note: `${rowsN} acknowledgment rows: ${applied} applied${problems.length ? `, ${problems.length} not (${problems.slice(0, 3).join("; ")})` : ""}${shipNote}` };
  }
  throw new FeedError("an order feed sends POs when you send them; there is nothing to run");
}

const priceRule = async (c: Client, entityId: string, vendorId: string) =>
  ((await q<{ options: Record<string, unknown> }>(c, `select options from vendor_feed where entity_id = $1 and vendor_id = $2 and purpose = 'pricing' and active limit 1`,
    [entityId, vendorId]))[0]?.options?.priceRule ?? {}) as Record<string, unknown>;

/** A person asked the feed's runs to stop; checked between calls, from outside the run's own transaction. */
export async function requestStop(c: Client, s: Scope, feedId: string) {
  const f = (await q<{ id: string }>(c, `select id from vendor_feed where id = $1 and entity_id = $2`, [feedId, s.entityId]))[0];
  need(f, "no such feed");
  await c.query(`insert into vendor_feed_stop (entity_id, feed_id, requested_by) values ($1,$2,$3)
                 on conflict (feed_id) do update set requested_at = now(), requested_by = excluded.requested_by`, [s.entityId, feedId, s.actor.id || null]);
  // A run whose process died never finishes; close it so the card is honest.
  const closed = await q(c, `update vendor_feed_run set finished_at = now(), outcome = 'failed', note = 'stopped by a person'
                              where entity_id = $1 and feed_id = $2 and finished_at is null and started_at < now() - interval '2 minutes' returning id`, [s.entityId, feedId]);
  await audit(c, s, { table: "vendor_feed", rowId: feedId, action: "transition", after: { stop: true, closed: closed.length } });
  return { closed: closed.length };
}

/**
 * Run one feed. The run row, the feed's status line and any alert are
 * written whatever happens; the work itself sits in a savepoint, so a feed
 * that fails changes nothing.
 */
export async function runFeed(c: Client, s: Scope, feedId: string, env: FeedEnv, trigger: "manual" | "schedule" | "email" = "manual",
  stopCheck?: () => Promise<boolean>, given?: GivenFile[]): Promise<RunResult> {
  const f = await loadFeed(c, s.entityId, feedId);
  need(f.kind !== "manual", "a manual feed has nothing to pull; upload its file on the Import tab");
  need(f.kind !== "email" || given?.length, "an email-in feed runs when the vendor's mail arrives; there is nothing to pull");
  need(f.purpose !== "orders", "an order feed sends POs when you send them; there is nothing to run");
  const startedAt = new Date();
  const run = await one<{ id: string }>(c, `insert into vendor_feed_run (entity_id, feed_id, purpose, trigger, run_by) values ($1,$2,$3,$4,$5) returning id`,
    [s.entityId, f.id, f.purpose, trigger, s.actor.id || null]);
  const res: RunResult = { runId: run.id, ok: false, note: "", rows: 0, added: 0, changed: 0 };
  let importRun: string | null = null;
  const stop = stopCheck ?? (async () => (await q(c, `select 1 from vendor_feed_stop where entity_id = $1 and feed_id = $2 and requested_at > $3`,
    [s.entityId, feedId, startedAt])).length > 0);
  await c.query("savepoint feed_run");
  try {
    const creds = await credentialsFor(c, s.entityId, env, f);
    let taken: TakenFile[] = [];
    let p: { rows: Record<string, string>[]; skipped: string[] };
    if (f.kind === "api") p = await pull(c, s.entityId, env, f, creds, false, stop);
    else {
      const got = f.kind === "sftp" ? await sftpFiles(c, s, f, creds, false) : await givenFiles(c, s, f, given ?? []);
      taken = got.files;
      p = { rows: got.rows, skipped: [] };
      if (!taken.length) {
        res.note = got.note ?? "no new files";
        await c.query("release savepoint feed_run");
        res.ok = true;
        await c.query(`update vendor_feed_run set finished_at = now(), outcome = 'ok', rows = 0, note = $3 where id = $1 and entity_id = $2`, [run.id, s.entityId, res.note]);
        await c.query(`update vendor_feed set last_run_at = now(), last_ok = true, last_note = $3, consecutive_failures = 0 where id = $1 and entity_id = $2`, [f.id, s.entityId, res.note]);
        return res;
      }
    }
    const rows = applyEtl(p.rows, f.etl);
    res.rows = rows.length;
    need(rows.length, "the feed answered, but with no records");
    const heads = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !k.startsWith("__"));
    const pricing = f.purpose === "products" && await hasPricingFeed(c, s.entityId, f.vendor_id, f.id);
    const mapping = mapFields(f.purpose, heads, f.mapping);
    const miss = missingFor(f.purpose, mapping, { costOptional: pricing });
    need(!miss.length, `pulled ${rows.length} records, but no column covers ${miss.join(", ")}; open Field mapping and pick them. Nothing was changed`);
    const a = await applyPurpose(c, s, f, rows, mapping, p.skipped);
    res.added = a.added; res.changed = a.changed; importRun = a.importRun;
    res.note = taken.length ? `${taken.map((x) => x.name).slice(0, 3).join(", ")}${taken.length > 3 ? ` and ${taken.length - 3} more` : ""}: ${a.note}` : a.note;
    for (const t of taken) {
      await c.query(`insert into vendor_feed_file (entity_id, feed_id, run_id, via, name, byte_size, modified_at, sha256, sender, rows) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        on conflict (feed_id, sha256) do nothing`, [s.entityId, f.id, run.id, f.kind, t.name.slice(0, 300), t.size, t.modifiedAt ?? null, t.sha256, t.sender ?? null, t.rows]);
    }
    await c.query(`update vendor_feed set mapping = $3 where id = $1 and entity_id = $2`, [f.id, s.entityId, JSON.stringify(mapping)]);
    await c.query("release savepoint feed_run");
    res.ok = true;
  } catch (e) {
    await c.query("rollback to savepoint feed_run");
    res.note = e instanceof FeedError || e instanceof CatalogError || ["TransportError", "HostKeyError", "VendorFilesError", "FileError"].includes((e as Error)?.constructor?.name)
      ? (e as Error).message : `the pull failed: ${((e as Error).message || String(e)).slice(0, 200)}`;
    res.added = res.changed = 0; importRun = null;
  }
  await c.query(`update vendor_feed_run set finished_at = now(), outcome = $3, rows = $4, import_run_id = $5, added = $6, changed = $7, note = $8
                  where id = $1 and entity_id = $2`, [run.id, s.entityId, res.ok ? "ok" : "failed", res.rows, importRun, res.added, res.changed, res.note]);
  await c.query(`update vendor_feed set last_run_at = now(), last_ok = $3, last_note = $4,
                        consecutive_failures = case when $3 then 0 else consecutive_failures + 1 end where id = $1 and entity_id = $2`,
    [f.id, s.entityId, res.ok, res.note]);
  // Tell a person once when a feed starts failing, not on every retry.
  // The checks' own mailer, else the company's email connection (Admin, Connections); with neither, the run log has it.
  const mailer = !res.ok && f.last_ok !== false && typeof f.options.alertEmail === "string" && /@/.test(f.options.alertEmail)
    ? env.mailer ?? await (await import("./messaging.ts")).mailerFor(c, s.entityId, "feed_alert") : null;
  if (mailer) {
    try {
      await mailer.send({ to: f.options.alertEmail, subject: `Vendor feed failed: ${f.vendor} · ${f.name}`,
        text: `The ${f.name} feed for ${f.vendor} failed: ${res.note}\n\nNothing from this run was kept. Open Catalog → Vendors → API setup to look.`, attachments: [] });
    } catch { /* the run log already has it */ }
  }
  return res;
}

/** Copy the vendor's photos into our own cache (the photo route's store), up to `limit` per press. */
export async function hostPhotos(c: Client, s: Scope, vendorId: string, env: FeedEnv, limit = 200) {
  const imgs = await q<{ product_id: string; seq: number; url: string; cached: boolean }>(c, `
    select i.product_id, i.seq, i.url, exists (select 1 from catalog_image_cache k where k.entity_id = i.entity_id and k.url = i.url) cached
      from product_image i join product p on p.id = i.product_id and p.entity_id = i.entity_id
     where i.entity_id = $1 and p.vendor_id = $2 order by cached, i.product_id, i.seq`, [s.entityId, vendorId]);
  let hosted = imgs.filter((x) => x.cached).length, tried = 0, failed = 0;
  for (const im of imgs.filter((x) => !x.cached).slice(0, limit)) {
    tried++;
    try { const r = await productImage(c, s.entityId, im.product_id, im.seq, env.imageFetch); if (r) hosted++; }
    catch (e) { if (e instanceof CatalogError) failed++; else throw e; }
  }
  return { total: imgs.length, hosted, tried, failed };
}

/** What the vendor's photos look like now: N of M hosted. */
export async function photoTally(c: Client, entityId: string, vendorId: string) {
  return (await q<{ total: string; hosted: string }>(c, `
    select count(*) total, count(*) filter (where exists (select 1 from catalog_image_cache k where k.entity_id = i.entity_id and k.url = i.url)) hosted
      from product_image i join product p on p.id = i.product_id and p.entity_id = i.entity_id where i.entity_id = $1 and p.vendor_id = $2`, [entityId, vendorId]))[0];
}

/** An order feed's request pieces, for purchasing's send: address, headers with authentication, the customer and ship-to numbers. */
export async function orderFeedRequest(c: Client, entityId: string, env: FeedEnv, vendorId: string) {
  const f = (await q<{ id: string }>(c, `select id from vendor_feed where entity_id = $1 and vendor_id = $2 and purpose = 'orders' and active order by created_at limit 1`,
    [entityId, vendorId]))[0];
  if (!f) return null;
  const feed = await loadFeed(c, entityId, f.id);
  const creds = await credentialsFor(c, entityId, env, feed);
  const auth = await authFor(env, feed, creds);
  const u = new URL(feed.url);
  for (const [k, v] of Object.entries(auth.query)) u.searchParams.set(k, v);
  return { feed, url: u.toString(), headers: { accept: "application/json", ...feed.headers, ...auth.headers }, mask: masker(creds, auth.secrets) };
}

/** Feeds due now: a cron that came round, or every N hours since the last run. */
export function feedDue(f: { schedule_cron: string | null; every_hours: number | null; last_run_at: Date | null }, now: Date,
  cronDue: (expr: string, since: Date | null, now: Date) => boolean): boolean {
  if (f.schedule_cron) return cronDue(f.schedule_cron, f.last_run_at, now);
  if (f.every_hours) return !f.last_run_at || now.getTime() - f.last_run_at.getTime() >= f.every_hours * 3600_000 - 60_000;
  return false;
}

// --------------------------------------------- kept for older callers --

export function buildFidx(customer: string, shipTo: string, duns: string, skus: string[], now = new Date()): string {
  const inner = /\{\{#xml\}\}([\s\S]*?)\{\{\/xml\}\}/.exec(ASHLEY_ATP_TEMPLATE)![1];
  return render(inner, { ...baseCtx({ options: { customer, shipTo, duns } } as unknown as FeedRow, {}, now), skus }, "xml");
}
export const soapEnvelope = (creds: Record<string, string>, fidx: string) =>
  ASHLEY_ATP_TEMPLATE.replace(/\{\{#xml\}\}[\s\S]*?\{\{\/xml\}\}/, xmlEsc(fidx)).replace(/\{\{cred\.(\w+)\}\}/g, (_m, k: string) => xmlEsc(creds[k] ?? ""));

// ------------------------------------------- from CATALOG-APP (one time) --
// CATALOG-APP kept one feed per source: a main URL plus extra endpoints whose
// columns it joined on by item number, header lines, basic or OAuth, query
// parameters, ATP and freight switches, ETL steps, photo hosting and the
// source's mapping. This turns that into per-purpose feeds. Re-sending the
// same source updates the same feeds. Secrets go into the encrypted store
// only; nothing echoes them back.

export type CatalogAppSource = {
  name?: string; vendor_label?: string; mapping?: Record<string, string>;
  feed?: {
    type?: string; url?: string; urls?: string[]; header?: string; auth_user?: string; auth_pass?: string;
    token_url?: string; client_id?: string; client_secret?: string; qparams?: [string, string][]; every_hours?: number | string;
    atp_on?: boolean; atp_url?: string; atp_external_id?: string; atp_keycode?: string; atp_user?: string; atp_password?: string;
    atp_customer?: string; atp_shipto?: string; atp_batch?: number; atp_sleep?: number; frt_on?: boolean; frt_stores?: string;
    etl?: EtlStep[]; photos_on?: boolean; photos_col?: string;
  };
};

/** CATALOG-APP schema names to ours: which feed and field each one lands on. */
const CA_FIELDS: Record<string, { products?: string; pricing?: string; images?: string; note?: string }> = {
  modelnum: { products: "vendor_sku", pricing: "vendor_sku" }, itemnumber: { products: "vendor_sku", pricing: "vendor_sku" },
  itemname: { products: "name" }, brand: { products: "brand" }, category: { products: "category" }, subcategory: { products: "subcategory" },
  collection: { products: "collection" }, color: { products: "color" }, itemimage2: { products: "image_url" },
  regularcost: { products: "cost", pricing: "cost" }, price: { pricing: "promo_cost", note: "promo cost goes to the pricing feed" },
  vendor: { note: "the vendor is the one you sent it for" },
  displayorder: { note: "display order has no place in the ERP catalog" },
  qtyavailable: { note: "quantities come from the quantities feed" },
};

const purposeOfUrl = (u: string): string => {
  let seg = "";
  try { seg = new URL(u).pathname.toLowerCase(); } catch { /* checked later */ }
  if (/price|pricing|cost/.test(seg)) return "pricing";
  if (/freight|shipping/.test(seg)) return "freight";
  if (/quantit|inventory|atp|stock|availab/.test(seg)) return "quantities";
  if (/image|photo|media/.test(seg)) return "images";
  return "products";
};

export async function importCatalogAppSource(c: Client, s: Scope, env: FeedEnv, x: { vendorId?: string | null; vendorName?: string | null; source: CatalogAppSource }) {
  const src = x.source ?? {};
  const fd = src.feed ?? {};
  const label = String(x.vendorName ?? src.vendor_label ?? src.name ?? "").trim();
  let v = (await q<{ id: string; name: string }>(c, `
    select v.id, coalesce(v.dba, v.legal_name) as name from vendor_entity ve join vendor v on v.id = ve.vendor_id
     where ve.entity_id = $1 and ve.status = 'active' and exists (select 1 from vendor_merchandise vm where vm.entity_id = ve.entity_id and vm.vendor_id = ve.vendor_id and vm.is_merchandise) and (v.id = $2::uuid or ($2::uuid is null and (lower(v.legal_name) = lower($3) or lower(coalesce(v.dba,'')) = lower($3))))
     limit 1`, [s.entityId, x.vendorId ?? null, label]))[0];
  if (!v && !x.vendorId && label) {
    // The catalog app names a source loosely ("ASHLEY", "Ashley catalog", "DEMO - ASHLEY CATALOG"):
    // take the one active vendor whose name's first word appears in the label, if exactly one does.
    const words = new Set(label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
    const all = await q<{ id: string; name: string; legal_name: string; dba: string | null }>(c, `
      select v.id, coalesce(v.dba, v.legal_name) as name, v.legal_name, v.dba from vendor_entity ve join vendor v on v.id = ve.vendor_id
       where ve.entity_id = $1 and ve.status = 'active' and exists (select 1 from vendor_merchandise vm where vm.entity_id = ve.entity_id and vm.vendor_id = ve.vendor_id and vm.is_merchandise)`, [s.entityId]);
    const first = (n: string | null) => (n ?? "").toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length >= 3) ?? "";
    const hits = all.filter((r) => words.has(first(r.legal_name)) || (r.dba && words.has(first(r.dba))));
    if (hits.length === 1) v = hits[0];
  }
  need(v, x.vendorId ? "that vendor is not set up for this company" : `no vendor called ${label || "(blank)"} is set up for this company; add it, or send its id`);
  need(fd.url || fd.atp_on, "the source has no API address and no quantities to pull; nothing to set up");

  // Secrets first: none is stored unless it can be stored encrypted.
  const headerLines = String(fd.header ?? "").split(/[;\n]/).map((l) => l.trim()).filter(Boolean);
  const headers: Record<string, string> = {};
  let keyHeader = "", apiKey = "";
  const unplaced: string[] = [];
  for (const line of headerLines) {
    const i = line.indexOf(":");
    if (i < 1) { unplaced.push(`header line "${line.slice(0, 30)}" has no name: value`); continue; }
    const name = line.slice(0, i).trim(), value = line.slice(i + 1).trim();
    if (/(authorization|cookie|key|token|secret|password)/i.test(name)) {
      if (!keyHeader) { keyHeader = name; apiKey = value; }
      else unplaced.push(`a second secret header (${name}) — only one key header per feed; add it by hand`);
    } else headers[name] = value;
  }
  const hasSecrets = !!(apiKey || fd.auth_pass || fd.client_secret || (fd.atp_on && (fd.atp_keycode || fd.atp_password)));
  need(!hasSecrets || (env.secretKey && env.secretKey.length === 32),
    "add ERP_SECRET_KEY to the service's environment (32 random bytes, base64) so the keys and passwords can be stored encrypted; nothing was saved");

  const query: Record<string, string> = {};
  for (const [k, val] of (fd.qparams ?? [])) {
    const key = String(k ?? "").trim();
    if (!key) continue;
    if (/(key|token|secret|password|sig)/i.test(key)) { unplaced.push(`query parameter ${key} looks like a key; type it under Authentication`); continue; }
    query[key] = String(val ?? "");
  }
  const qLower = Object.fromEntries(Object.entries(query).map(([k, val]) => [k.toLowerCase(), val]));
  const every = Number(fd.every_hours) >= 1 ? Math.min(720, Math.round(Number(fd.every_hours))) : null;
  const auth: Record<string, unknown> = fd.token_url && fd.client_id ? { mode: "oauth2", authUrl: fd.token_url, clientId: fd.client_id }
    : fd.auth_user ? { mode: "basic", user: fd.auth_user } : keyHeader ? { mode: "header" } : { mode: "none" };
  if (keyHeader) auth.headerName = keyHeader;
  const secrets: Record<string, string> = {};
  if (apiKey) secrets.apiKey = apiKey;
  if (fd.auth_pass) secrets.password = fd.auth_pass;
  if (fd.client_secret) secrets.clientSecret = fd.client_secret;

  // Field mapping by purpose.
  const maps: Record<string, Record<string, string>> = { products: {}, pricing: {}, images: {} };
  for (const [ours, theirs] of Object.entries(src.mapping ?? {})) {
    if (!theirs) continue;
    const t = CA_FIELDS[ours.toLowerCase()];
    if (!t) { unplaced.push(`mapped field ${ours} (${theirs}) has no place in the ERP`); continue; }
    for (const p of ["products", "pricing", "images"] as const) if (t[p]) maps[p][t[p]!] = String(theirs);
    if (t.note && !t.products && !t.pricing) unplaced.push(`${ours} (${theirs}): ${t.note}`);
  }
  if (fd.photos_col) maps.products.image_url = fd.photos_col;

  // The endpoints: main URL is the products feed; the extras by what their path says.
  const endpoints = [fd.url, ...(fd.urls ?? [])].map((u) => String(u ?? "").trim()).filter(Boolean);
  const etl = Array.isArray(fd.etl) ? fd.etl.filter((st) => st && st.out && st.a && st.op).slice(0, 12) : [];
  const base = (purpose: string, name: string, url: string): FeedDraft => ({
    vendor_id: v.id, purpose, name, template: "catalog_app", kind: "api", method: "GET", url, request_format: "query", query_params: query, headers,
    response_format: /\.csv(\?|$)/i.test(url) ? "csv" : "json", paging: { mode: "page", size: Number(qLower.limit) || 250, pageParam: "page", sizeParam: "limit" },
    auth, etl, every_hours: every, options: { customer: qLower.customer ?? "", shipTo: qLower.shipto ?? "" }, mapping: {},
  });
  const drafts: { d: FeedDraft; secrets: Record<string, string>; borrow: boolean }[] = [];
  const counts: Record<string, number> = {};
  endpoints.forEach((u, i) => {
    const purpose = i === 0 ? "products" : purposeOfUrl(u);
    counts[purpose] = (counts[purpose] ?? 0) + 1;
    const d = base(purpose, `${v.name} · ${purpose}${counts[purpose] > 1 ? ` ${counts[purpose]}` : ""} (from catalog app)`, u);
    if ("limit" in qLower) delete (d.query_params as Record<string, string>)[Object.keys(query).find((k) => k.toLowerCase() === "limit")!];
    d.mapping = purpose === "products" ? maps.products : purpose === "pricing" ? maps.pricing : purpose === "images" ? maps.images : {};
    if (purpose === "freight") { d.records_path = "entities"; d.mapping = { vendor_sku: "price.sku", freight: "price.freight", net_cost: "price.netPriceBeforeFreight" }; }
    if (purpose === "products" && fd.photos_on) d.options = { ...d.options, hostPhotos: true };
    drafts.push({ d, secrets, borrow: i > 0 });
  });

  // Freight by store: CATALOG-APP asked the main (prices) API once per ship-to.
  const unmatchedShipTos: string[] = [];
  if (fd.frt_on && endpoints[0]) {
    const numbers = String(fd.frt_stores ?? "").split(/[;,\s]+/).map((n) => n.trim()).filter(Boolean);
    const locs = await q<{ id: string; code: string; name: string }>(c, `select id, code, name from location where entity_id = $1 and status = 'active'`, [s.entityId]);
    const shipTos: Record<string, string> = {};
    for (const n of numbers) {
      const l = locs.find((x) => x.code.toLowerCase() === n.toLowerCase() || x.name.toLowerCase().startsWith(`${n.toLowerCase()} `) || x.name.toLowerCase() === n.toLowerCase());
      if (l && !shipTos[l.id]) shipTos[l.id] = n; else unmatchedShipTos.push(n);
    }
    if (!numbers.length) unplaced.push("freight by store was on with no ship-to numbers listed; list them on the freight feed");
    const d = base("freight", `${v.name} · freight by store (from catalog app)`, endpoints[0]);
    d.query_params = { ...(d.query_params ?? {}), ShipTo: "{{shipTo}}", IncludeTentative: "False" };
    d.records_path = "entities";
    d.paging = { mode: "page", size: 250, pageParam: "Page", sizeParam: "Limit", totalPath: "metadata.totalRecords" };
    d.mapping = { vendor_sku: "price.sku", freight: "price.freight", net_cost: "price.netPriceBeforeFreight" };
    d.options = { ...d.options, shipTos, parallel: 4, unmatchedShipTos };
    d.etl = [];
    drafts.push({ d, secrets, borrow: true });
  }

  // Ashley ATP quantities.
  if (fd.atp_on) {
    const t = feedTemplates("ashley", v.name).find((x) => x.purpose === "quantities")!;
    const d: FeedDraft = { ...t, vendor_id: v.id, name: `${v.name} · quantities ATP (from catalog app)`, template: "ashley", url: fd.atp_url || t.url,
      auth: { mode: "none", atpExternalId: fd.atp_external_id ?? "", atpUser: fd.atp_user ?? "" },
      batching: { size: Number(fd.atp_batch) || 40, delayMs: Math.round((Number(fd.atp_sleep) || 1) * 1000) },
      options: { ...t.options, customer: fd.atp_customer || qLower.customer || "", shipTo: fd.atp_shipto || qLower.shipto || "" }, every_hours: every,
      credential_ref: null };
    const atpSecrets: Record<string, string> = {};
    if (fd.atp_keycode) atpSecrets.atpKeyCode = fd.atp_keycode;
    if (fd.atp_password) atpSecrets.atpPassword = fd.atp_password;
    if (!fd.atp_external_id || !fd.atp_keycode || !fd.atp_user || !fd.atp_password) unplaced.push("quantities were on, but the ATP External ID, KeyCode, user or password was blank; fill them on the quantities feed");
    if (!d.options!.customer || !d.options!.shipTo) unplaced.push("quantities need Ashley's customer and ship-to numbers; fill them on the quantities feed");
    drafts.push({ d, secrets: atpSecrets, borrow: false });
  }

  // Save, matching earlier sends by name; the first feed keeps the shared keys, the others borrow them.
  const out: { id: string; name: string; purpose: string; action: "created" | "updated"; secrets: Record<string, string> }[] = [];
  let keeper: string | null = null;
  for (const { d, secrets: sec, borrow } of drafts) {
    const prior = (await q<{ id: string }>(c, `select id from vendor_feed where entity_id = $1 and vendor_id = $2 and name = $3`, [s.entityId, v.id, d.name]))[0];
    const useKeeper = borrow && keeper && Object.keys(sec).length && sec === secrets;
    const id = await saveFeed(c, s, { ...d, id: prior?.id ?? null, secrets_from_feed_id: useKeeper ? keeper : null,
      secrets: useKeeper ? {} : sec }, env);
    if (!keeper && sec === secrets && Object.keys(sec).length) keeper = id;
    const st = await secretStatus(c, s.entityId, useKeeper ? keeper! : id);
    out.push({ id, name: d.name, purpose: d.purpose, action: prior ? "updated" : "created", secrets: Object.fromEntries(st.map((x) => [x.name, x.masked])) });
  }
  await audit(c, s, { table: "vendor_feed", rowId: v.id, action: "insert",
    after: { from: "catalog app", source: src.name ?? null, feeds: out.map((o) => `${o.action} ${o.name}`), secrets: out.flatMap((o) => Object.keys(o.secrets)) } });
  return { vendor: v.name, vendorId: v.id, feeds: out, unplaced, unmatchedShipTos };
}

// ------------------------------------------------ SFTP and email-in feeds --
//
// An SFTP feed reads the vendor's folder on its schedule; an email-in feed is
// handed the attachments of a vendor's mail (vendor_files.receiveMail routes
// them here by sender, subject and file pattern). Either way each file (a CSV,
// an .xlsx, or a zip of them) becomes rows that run through this feed's ETL
// and field mapping exactly as an API answer does. A file is remembered by
// its checksum (vendor_feed_file) once applied, so it is never applied twice.

export type GivenFile = { name: string; bytes: Buffer; sender?: string };
type TakenFile = { name: string; size: number; modifiedAt?: string; sha256: string; sender?: string; rows: number };

const sha = async (b: Buffer) => (await import("node:crypto")).createHash("sha256").update(b).digest("hex");

/** Rows from one file: a zip is opened and each file in it read (CSV, TSV, .xlsx or JSON). */
async function rowsOfFile(name: string, bytes: Buffer, pattern: string | null): Promise<Record<string, string>[]> {
  const { tableOf } = await import("./vendor_files.ts");
  const { unzip, isZip, isXlsx, globTest } = await import("./filekit.ts");
  need(!/^﻿?\s*ISA/.test(bytes.subarray(0, 80).toString("latin1")), `${name} is an X12 (EDI) file; EDI goes to Vendor EDI, not to a feed`);
  if (isZip(bytes) && !isXlsx(bytes)) {
    const rx = pattern ? { test: (n: string) => globTest(n, pattern) } : null;
    const out: Record<string, string>[] = [];
    for (const e of unzip(bytes, name)) if (!rx || rx.test(e.name) || /\.(csv|tsv|txt|xlsx|json)$/i.test(e.name)) out.push(...await tableOf(e.name, e.bytes));
    need(out.length, `${name} holds no readable file`);
    return out;
  }
  return tableOf(name, bytes);
}

async function feedSftp(c: Client, s: Scope, f: FeedRow, creds: Record<string, string>) {
  const C = await import("./connections.ts");
  const o = f.options as Record<string, unknown>;
  const host = String(o.host ?? "").trim().toLowerCase();
  const port = o.port == null || o.port === "" ? 22 : Number(o.port);
  const target = { host, port, user: String(o.user ?? "").trim(), password: creds.sftpPassword, privateKey: creds.sftpKey, passphrase: creds.sftpPassphrase };
  const pin = C.pinFor(await C.loadPin(c, { kind: "vendor_feed", id: f.id!, entityId: s.entityId }), host, port);
  const maxBytes = Math.round(Math.min(50, Math.max(1, Number(o.maxMb ?? 20) || 20)) * 1048576);
  return { C, target, pin, path: String(o.path ?? "").trim() || ".", globs: o.pattern ? [String(o.pattern)] : [], maxBytes };
}

/** New files in the vendor's folder (not taken before by name, size and time, nor by checksum), read into rows. */
async function sftpFiles(c: Client, s: Scope, f: FeedRow, creds: Record<string, string>, test: boolean) {
  const { openSftp } = await import("./transports.ts");
  const x = await feedSftp(c, s, f, creds);
  const session = await openSftp(await x.C.netEnv(), { ...x.target, pinned: x.pin }, "require");
  try {
    const listed = await session.list(x.path, x.globs);
    const had = await q<{ k: string; sha256: string }>(c, `select name || '|' || byte_size || '|' || coalesce(modified_at, '') k, sha256 from vendor_feed_file where entity_id = $1 and feed_id = $2`, [s.entityId, f.id]);
    const known = new Set(had.map((h) => h.k)), shas = new Set(had.map((h) => h.sha256));
    const rows: Record<string, string>[] = [];
    const files: TakenFile[] = [];
    const big: string[] = [];
    const order = test ? [...listed].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)) : listed;
    for (const r of order) {
      if (!test && known.has(`${r.name}|${r.size}|${r.modifiedAt}`)) continue;
      if (r.size > x.maxBytes) { big.push(r.name); continue; }
      const bytes = await session.get(x.path, r.name, x.maxBytes);
      const sum = await sha(bytes);
      if (!test && shas.has(sum)) continue;
      const got = await rowsOfFile(r.name, bytes, x.globs[0] ?? null);
      rows.push(...got);
      files.push({ name: r.name, size: r.size, modifiedAt: r.modifiedAt, sha256: sum, rows: got.length });
      if (test) break;
    }
    need(!big.length || files.length, `${big.join(", ")} ${big.length === 1 ? "is" : "are"} over this feed's size limit and ${big.length === 1 ? "was" : "were"} left on the server`);
    return { rows, files, listed: listed.length, note: listed.length ? `no new files (${listed.length} on the server, all taken before)` : "no files on the server match" };
  } finally { session.close(); }
}

/** Attachments handed to an email-in feed: those not applied before, read into rows. */
async function givenFiles(c: Client, s: Scope, f: FeedRow, given: GivenFile[]) {
  const rows: Record<string, string>[] = [];
  const files: TakenFile[] = [];
  for (const g of given) {
    const sum = await sha(g.bytes);
    if ((await q(c, `select 1 from vendor_feed_file where entity_id = $1 and feed_id = $2 and sha256 = $3`, [s.entityId, f.id, sum])).length) continue;
    const got = await rowsOfFile(g.name, g.bytes, f.options.pattern ? String(f.options.pattern) : null);
    rows.push(...got);
    files.push({ name: g.name, size: g.bytes.length, sha256: sum, sender: g.sender, rows: got.length });
  }
  return { rows, files, note: "the attached file was applied before; nothing new" };
}

/**
 * Test an SFTP feed: connect, list, show the server's key (recorded on the
 * first good Test), then read the newest matching file through the mapping.
 * An email-in feed shows the vendor's own address. Nothing changes but the key.
 */
async function testFileFeed(c: Client, s: Scope, env: FeedEnv, f: FeedRow, d: FeedDraft): Promise<TestResult> {
  const res: TestResult = { ok: false, status: null, url: null, requestHeaders: {}, sample: "", recordsFound: 0, columns: [], mapping: {}, missing: [], rows: [], problem: null, calls: 0 };
  need(f.id, "save the feed first, then Test");
  const { mailboxOf, inboundAddress } = await import("./vendor_files.ts");
  if (f.kind === "email") {
    res.address = inboundAddress(await mailboxOf(c, s.entityId, s.tenantId, f.vendor_id));
    res.ok = !!res.address;
    res.problem = res.address ? null : "inbound email is not set up on this server yet (ERP_INBOUND_EMAIL_ADDRESS)";
    return res;
  }
  const typed = Object.fromEntries(Object.entries((d as { secrets?: Record<string, string | null> }).secrets ?? {})
    .filter(([k, v]) => SECRET_SET.has(k) && typeof v === "string" && v && v !== "•kept•")) as Record<string, string>;
  const creds = { ...(await credentialsFor(c, s.entityId, env, f)), ...typed };
  const x = await feedSftp(c, s, f, creds);
  const who = s.actor.label;
  const t = await x.C.testSftp(c, s, { kind: "vendor_feed", id: f.id!, tenantId: s.tenantId, entityId: s.entityId }, x.target, x.path, x.globs, who);
  res.sftp = { fingerprint: t.fingerprint, keyType: t.keyType, firstTime: t.firstTime, changed: t.changed, recorded: t.recorded, files: t.files, words: t.words, sample: t.sample };
  res.calls = 1;
  if (!t.ok) { res.problem = t.words; return res; }
  if (!t.files) { res.problem = "connected, but no file in the folder matches the pattern"; return res; }
  await c.query("savepoint feed_test");
  try {
    const got = await sftpFiles(c, s, f, creds, true);
    const rows = applyEtl(got.rows.map((r) => ({ ...r })), f.etl);
    res.url = `sftp://${x.target.host}${x.target.port === 22 ? "" : `:${x.target.port}`}/${x.path.replace(/^\//, "")}/${got.files[0]?.name ?? ""}`;
    res.recordsFound = rows.length;
    res.columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const pricingFeed = f.purpose === "products" && await hasPricingFeed(c, s.entityId, f.vendor_id, f.id);
    res.mapping = mapFields(f.purpose, res.columns, f.mapping);
    res.missing = missingFor(f.purpose, res.mapping, { costOptional: pricingFeed });
    res.rows = rows.slice(0, 5).map((r) => Object.fromEntries(Object.entries(res.mapping).map(([ours, theirs]) => [ours, String(r[theirs] ?? "")])));
    res.ok = !res.missing.length && rows.length > 0;
    if (!rows.length) res.problem = "the newest file holds no rows";
    else if (res.missing.length) res.problem = `no column found for ${res.missing.join(", ")}; pick them under Field mapping`;
  } catch (e) {
    res.problem = (e as Error).message;
  } finally { await c.query("rollback to savepoint feed_test"); }
  return res;
}

/** The owner trusts the new SFTP server key a Test was shown. */
export async function trustFeedKey(c: Client, s: Scope, feedId: string, fingerprint: string, who: string) {
  const f = (await q<{ id: string }>(c, `select id from vendor_feed where id = $1 and entity_id = $2`, [feedId, s.entityId]))[0];
  need(f, "no such feed");
  const C = await import("./connections.ts");
  return C.trustOfferedKey(c, s, { kind: "vendor_feed", id: feedId, entityId: s.entityId }, fingerprint, who);
}

/** The files an SFTP or email-in feed took, newest first. */
export async function feedFiles(c: Client, entityId: string, feedId: string) {
  return q(c, `select name, via, byte_size, rows, sender, taken_at, run_id from vendor_feed_file where entity_id = $1 and feed_id = $2 order by taken_at desc limit 50`, [entityId, feedId]);
}
