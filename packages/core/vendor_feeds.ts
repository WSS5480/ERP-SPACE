// Vendor connections: a vendor's catalog, availability and freight, pulled
// from their API on a schedule or on demand. The idea of CATALOG-APP's feed
// runner (paginated JSON pulls, Ashley's ATP SOAP inquiry 40 models at a
// time, freight per store), reimplemented here.
//
// The network is behind FeedEnv: production passes globalThis.fetch and the
// environment's secrets; the checks pass a fixture-backed fake. Secrets are
// never in the database: a connection carries credential_ref, and the secret
// is read from ERP_SECRET_<REF> when the run starts.
//
// A pulled catalog goes through the same mapper, preview and build as a CSV
// upload (catalog.ts), so a feed and a file can never disagree about what a
// column means.

import { q, one, audit, type Client, type Scope } from "./db.ts";
import { automap, missingRequired, previewImport, applyImport, csvCell, parseMoney, CatalogError } from "./catalog.ts";

export class FeedError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new FeedError(msg); };

// ------------------------------------------------------------ the edge --

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export type Mail = { to: string; subject: string; text: string; attachments: { filename: string; content: string }[] };

export type FeedEnv = {
  fetch: FetchLike;
  secret: (ref: string) => string;
  sleep: (ms: number) => Promise<void>;
  mailer?: { send(m: Mail): Promise<{ id?: string }> };
};

/** credential_ref "secret://vendor/ashley" -> ERP_SECRET_VENDOR_ASHLEY (same rule as the server's). */
export function secretEnvName(ref: string): string {
  return "ERP_SECRET_" + ref.replace(/^secret:\/\//i, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export const liveEnv = (): FeedEnv => ({
  fetch: globalThis.fetch as unknown as FetchLike,
  secret: (ref) => process.env[secretEnvName(ref)] ?? "",
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/**
 * The secret behind a connection: a JSON object of named credentials
 * ({"token":..} or {"clientId":..,"clientSecret":..} plus the ATP four), or a
 * bare string taken as a bearer token.
 */
export function credentialsOf(env: FeedEnv, ref: string | null): Record<string, string> {
  if (!ref) return {};
  const raw = env.secret(ref).trim();
  need(raw, `the secret ${secretEnvName(ref)} is not set on the server; add it to the service's environment`);
  if (raw.startsWith("{")) {
    try { return JSON.parse(raw) as Record<string, string>; }
    catch { throw new FeedError(`the secret ${secretEnvName(ref)} is not valid JSON`); }
  }
  return { token: raw };
}

// ------------------------------------------------------ JSON records --

/** Find the list of records wherever an API nested it. */
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

/** One record to one flat row: scalars kept, objects unpacked two levels as a.b.c, the first of a list of objects unpacked. */
export function flatten(rec: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const scalar = (v: unknown) => v == null || ["string", "number", "boolean"].includes(typeof v);
  const put = (k: string, v: unknown, depth: number) => {
    if (scalar(v)) { out[k] = v == null ? "" : String(v); return; }
    if (Array.isArray(v)) {
      if (v.length && v[0] && typeof v[0] === "object" && depth < 2) put(k, v[0], depth + 1);
      else out[k] = JSON.stringify(v).slice(0, 300);
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

type Cfg = Record<string, unknown>;
const cfgStr = (c: Cfg, k: string, d = "") => (typeof c[k] === "string" ? (c[k] as string).trim() : c[k] == null ? d : String(c[k]));
const cfgNum = (c: Cfg, k: string, d: number, lo: number, hi: number) => {
  const n = Number(c[k]);
  return Number.isFinite(n) && c[k] !== "" && c[k] != null ? Math.max(lo, Math.min(hi, n)) : d;
};

async function retrying(env: FeedEnv, what: string, fn: () => ReturnType<FetchLike>, tries = 3) {
  let last = "";
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fn();
      if (r.status === 429 || r.status >= 500) { last = `answered ${r.status}`; await env.sleep(500 * (a + 1)); continue; }
      return r;
    } catch (e) { last = (e as Error).message?.slice(0, 120) || "no answer"; await env.sleep(500 * (a + 1)); }
  }
  throw new FeedError(`${what} kept failing: ${last}`);
}

/** Headers for an API call: a bearer token, an API key header, or an OAuth client-credentials token traded first. */
export async function authHeaders(env: FeedEnv, cfg: Cfg, creds: Record<string, string>): Promise<Record<string, string>> {
  const h: Record<string, string> = { accept: "application/json" };
  const authUrl = cfgStr(cfg, "authUrl");
  if (authUrl && creds.clientId) {
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: creds.clientId, client_secret: creds.clientSecret ?? "" }).toString();
    const r = await retrying(env, "the token service", () => env.fetch(authUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }));
    need(r.status < 400, `the token service answered ${r.status}; check the client id and secret`);
    let tok = "";
    try { tok = String((JSON.parse(await r.text()) as { access_token?: string }).access_token ?? ""); } catch { /* below */ }
    need(tok, "the token service answered, but sent no access token");
    h.authorization = `Bearer ${tok}`;
  } else if (creds.token) h.authorization = `Bearer ${creds.token}`;
  if (creds.apiKey) h[cfgStr(cfg, "apiKeyHeader", "x-api-key").toLowerCase()] = creds.apiKey;
  if (creds.user && creds.password && !h.authorization) h.authorization = `Basic ${Buffer.from(`${creds.user}:${creds.password}`).toString("base64")}`;
  return h;
}

const withQuery = (url: string, params: Record<string, string>) => {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

/**
 * Pull every record from a paginated JSON API. With a page size set, keep
 * asking for the next page while pages come back full; a short page means
 * done (the way Ashley's API pages).
 */
export async function pullRecords(env: FeedEnv, cfg: Cfg, headers: Record<string, string>): Promise<Record<string, string>[]> {
  const url = cfgStr(cfg, "url");
  need(/^https?:\/\//i.test(url), "the connection's address must start with http:// or https://");
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries((cfg.params ?? {}) as Record<string, unknown>)) if (k.trim()) params[k] = String(v ?? "");
  const limit = cfgNum(cfg, "pageSize", 0, 0, 5000);
  const limitParam = cfgStr(cfg, "limitParam", "limit"), pageParam = cfgStr(cfg, "pageParam", "page");
  const seg = new URL(url).pathname.split("/").filter(Boolean).at(-1) || "feed";
  const out: Record<string, string>[] = [];
  for (let page = 1; page <= 200; page++) {
    const qp = { ...params };
    if (limit) { qp[limitParam] = String(limit); qp[pageParam] = String(page); }
    const r = await retrying(env, `the ${seg} feed`, () => env.fetch(withQuery(url, qp), { headers }));
    need(r.status === 200, r.status === 401 || r.status === 403
      ? `the vendor refused the credentials (${r.status}); check the secret behind the connection`
      : `the ${seg} feed answered ${r.status}${page > 1 ? ` on page ${page}` : ""}`);
    let body: unknown;
    try { body = JSON.parse(await r.text()); } catch { throw new FeedError(`the ${seg} feed did not answer with JSON`); }
    const recs = unwrapRecords(body);
    need(recs, `the ${seg} feed answered JSON, but no list of records was found in it`);
    out.push(...recs!.map(flatten));
    if (!limit || recs!.length < limit || out.length >= 150000) break;
  }
  return out;
}

// ------------------------------------------------------ Ashley ATP --

export const ATP_URL = "https://aws.ashleyfurniture.com/atpinquiryservice_aws/atpinquiry.asmx";
export const ATP_NS = "http://api.AshleyFurniture.com/AtpInquiryService_AWS/AtpInquiry";
export const ATP_DUNS = "052738531";

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const xmlUnesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
const pad = (n: number) => String(n).padStart(2, "0");

/** The FIDX inventory-inquiry document one ATP call carries. */
export function buildFidx(customer: string, shipTo: string, duns: string, skus: string[], now = new Date()): string {
  const d = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, t = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const items = skus.map((s, i) => `<itemInquiry lineItemNumber="${i + 1}" responseType="CurrentQuantity"><itemId><itemIdentifier itemNumber="${xmlEsc(s)}" itemNumberQualifier="SellerAssigned"/></itemId><itemQty unitOfMeasure="Each" value="1"/></itemInquiry>`).join("");
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<fniia:inventoryInqAdv xmlns:fniia="http://xml.FIDX.org/xml/schemas/fidxInvInqAdv_v1.3" xmlns:fnParty="http://support.furnishnet.com/xml/schemas/fnParty_v1.4">' +
    `<inquiry><document id="req_${d.replace(/-/g, "")}${t.replace(/:/g, "")}" type="InventoryStatus" purpose="inquiry"><creationDate>${d}</creationDate><creationTime>${t}</creationTime></document>` +
    `<potentialBuyer><fnParty:partyIdentifier partyIdentifierCode="${xmlEsc(customer)}" partyIdentifierQualifierCode="SenderAssigned"/></potentialBuyer>` +
    `<potentialShipTo><fnParty:partyIdentifier partyIdentifierCode="${xmlEsc(shipTo)}" partyIdentifierQualifierCode="SenderAssigned"/></potentialShipTo>` +
    `<potentialSeller><fnParty:partyIdentifier partyIdentifierCode="${xmlEsc(duns)}" partyIdentifierQualifierCode="DUNS"/></potentialSeller>` +
    `</inquiry><items>${items}</items></fniia:inventoryInqAdv>`;
}

export function soapEnvelope(creds: Record<string, string>, fidx: string): string {
  return '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soap:Body><ATPRequest xmlns="${ATP_NS}"><ExternalID>${xmlEsc(creds.atpExternalId ?? "")}</ExternalID><KeyCode>${xmlEsc(creds.atpKeyCode ?? "")}</KeyCode>` +
    `<sUser>${xmlEsc(creds.atpUser ?? "")}</sUser><sPassword>${xmlEsc(creds.atpPassword ?? "")}</sPassword><sXml>${xmlEsc(fidx)}</sXml></ATPRequest></soap:Body></soap:Envelope>`;
}

export type Advice = { sku: string; qty: number | null; leadDays: number | null; exception: string | null };

/** The advice document back: one row per model, with current quantity, load lead time and any exception. */
export function parseAdvice(xml: string): Advice[] {
  const T = (name: string) => `<(?:[\\w.-]+:)?${name}\\b`;
  const blocks = xml.match(new RegExp(`${T("itemAdvice")}[\\s\\S]*?</(?:[\\w.-]+:)?itemAdvice>`, "g")) ?? [];
  const out: Advice[] = [];
  for (const b of blocks) {
    const sku = new RegExp(`${T("itemIdentifier")}[^>]*\\bitemNumber="([^"]*)"`).exec(b)?.[1];
    if (!sku) continue;
    let qty: number | null = null, lead: number | null = null, exc: string | null = null;
    const avs = b.match(new RegExp(`${T("itemAvailability")}[^>]*>[\\s\\S]*?</(?:[\\w.-]+:)?itemAvailability>`, "g")) ?? [];
    for (const av of avs) {
      if (!/\bavailability="current"/.test(av.slice(0, av.indexOf(">") + 1))) continue;
      const qv = new RegExp(`${T("availQty")}[^>]*\\bvalue="([^"]*)"`).exec(av)?.[1];
      if (qv != null && qv !== "" && Number.isFinite(Number(qv))) qty = Number(qv);
      const ds = [...av.matchAll(new RegExp(`${T("systemReferenceDescription")}[^>]*>([^<]*)<`, "g"))].map((m) => m[1].trim());
      const vs = [...av.matchAll(new RegExp(`${T("systemReferenceValue")}[^>]*>([^<]*)<`, "g"))].map((m) => m[1].trim());
      ds.forEach((d, i) => {
        if (d === "LoadLeadTime" && vs[i] !== undefined && Number.isFinite(Number(vs[i]))) lead = Math.max(0, Math.round(Number(vs[i])));
        if (d === "EXCEPTION" && vs[i]) exc = xmlUnesc(vs[i]).slice(0, 200);
      });
      if (qty != null) break;
    }
    out.push({ sku: xmlUnesc(sku), qty, leadDays: lead, exception: exc });
  }
  return out;
}

/** The SOAP answer carries the advice as escaped text (or CDATA) inside ATPRequestResult. */
export function adviceFromSoap(soap: string): string | null {
  const m = /<(?:[\w.-]+:)?ATPRequestResult\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?ATPRequestResult>/.exec(soap);
  if (!m) return null;
  const inner = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(inner);
  return cdata ? cdata[1] : xmlUnesc(inner);
}

/** Ask the ATP service about every model, batch by batch, pausing between calls. */
export async function atpInquiry(env: FeedEnv, cfg: Cfg, creds: Record<string, string>, skus: string[]): Promise<{ rows: Advice[]; batches: number }> {
  need(creds.atpExternalId && creds.atpKeyCode && creds.atpUser && creds.atpPassword,
    "availability is switched on, but the secret has no atpExternalId, atpKeyCode, atpUser and atpPassword");
  const customer = cfgStr(cfg, "atpCustomer") || cfgStr(cfg, "customer");
  const shipTo = cfgStr(cfg, "atpShipTo");
  need(customer && shipTo, "availability needs the Ashley customer number and ship-to on the connection");
  const url = cfgStr(cfg, "atpUrl") || ATP_URL, duns = cfgStr(cfg, "atpDuns") || ATP_DUNS;
  const size = cfgNum(cfg, "atpBatch", 40, 1, 200), pause = cfgNum(cfg, "atpSleepMs", 1000, 0, 10000);
  const rows: Advice[] = [];
  const total = Math.ceil(skus.length / size);
  for (let i = 0, bi = 1; i < skus.length; i += size, bi++) {
    const env_ = soapEnvelope(creds, buildFidx(customer, shipTo, duns, skus.slice(i, i + size)));
    const r = await retrying(env, `the availability service (batch ${bi} of ${total})`, () =>
      env.fetch(url, { method: "POST", headers: { "content-type": "text/xml; charset=utf-8", soapaction: `"${ATP_NS}/ATPRequest"` }, body: env_ }), 4);
    need(r.status === 200, `the availability service answered ${r.status} on batch ${bi} of ${total}`);
    const adv = adviceFromSoap(await r.text());
    if (adv && adv.trim().startsWith("<")) rows.push(...parseAdvice(adv));
    if (pause && i + size < skus.length) await env.sleep(pause);
  }
  need(rows.length || !skus.length, "the availability service answered, but sent no availability back; check the ATP credentials");
  return { rows, batches: total };
}

// ----------------------------------------------------- freight by store --

/** Freight per model to each ship-to: the vendor's price API asked once per store; a store it refuses is skipped and named. */
export async function freightPull(env: FeedEnv, cfg: Cfg, headers: Record<string, string>, shipTos: { locationId: string; number: string }[]) {
  const url = cfgStr(cfg, "freightUrl");
  need(/^https?:\/\//i.test(url), "freight by store needs the price API address on the connection");
  const limit = cfgNum(cfg, "freightPageSize", 250, 1, 5000);
  const rows: { sku: string; locationId: string; freightMinor: bigint; netMinor: bigint | null }[] = [];
  const skipped: string[] = [];
  for (const st of shipTos) {
    try {
      for (let page = 1; page <= 200; page++) {
        const r = await retrying(env, `freight for store ${st.number}`, () => env.fetch(withQuery(url, {
          Customer: cfgStr(cfg, "customer"), ShipTo: st.number, Limit: String(limit), Page: String(page), IncludeTentative: "False" }), { headers }));
        need(r.status === 200, `answered ${r.status}`);
        const d = JSON.parse(await r.text()) as { entities?: { price?: Record<string, unknown> }[]; metadata?: { totalRecords?: number } };
        const ents = d.entities ?? [];
        for (const e of ents) {
          const p = e?.price ?? {};
          if (!p.sku) continue;
          const fr = parseMoney(p.freight == null ? "" : String(p.freight));
          const net = parseMoney(p.netPriceBeforeFreight == null ? "" : String(p.netPriceBeforeFreight));
          rows.push({ sku: String(p.sku).toUpperCase(), locationId: st.locationId, freightMinor: fr ?? 0n, netMinor: net });
        }
        const total = Number(d.metadata?.totalRecords ?? 0);
        if (ents.length < limit || (total && page * limit >= total)) break;
      }
    } catch (e) {
      if (!(e instanceof FeedError) && !(e instanceof CatalogError) && !(e instanceof SyntaxError)) throw e;
      skipped.push(st.number);
    }
  }
  return { rows, skipped };
}

// ----------------------------------------------------------- connections --

export type ConnectionIn = { vendorId: string; kind: string; adapter?: string; name?: string; config?: Cfg; credentialRef?: string | null;
  scheduleCron?: string | null; mapping?: Record<string, string>; active?: boolean };

export async function saveConnection(c: Client, s: Scope, x: ConnectionIn): Promise<string> {
  const v = (await q<{ name: string }>(c, `select coalesce(v.dba, v.legal_name) as name from vendor_entity ve join vendor v on v.id = ve.vendor_id
                                           where ve.entity_id = $1 and ve.vendor_id = $2 and ve.status = 'active'`, [s.entityId, x.vendorId]))[0];
  need(v, "that vendor is not set up for this company");
  need(["manual", "api", "sftp", "email"].includes(x.kind), "a connection is manual, api, sftp or email");
  const adapter = x.adapter ?? "generic";
  need(["generic", "ashley"].includes(adapter), "the adapter is generic or ashley");
  const ref = x.credentialRef?.trim() || null;
  if (ref) need(/^secret:\/\/[a-z0-9/_-]+$/.test(ref), "a credential reference looks like secret://vendor/ashley; the secret itself goes in the server's environment");
  if (x.kind === "sftp") need(ref, "an SFTP connection needs a credential reference");
  const cron = x.scheduleCron?.trim() || null;
  if (cron) need(["api", "sftp"].includes(x.kind), "only api and sftp connections run on a schedule");
  if (cron) need(/^(\S+\s+){4}\S+$/.test(cron), "a schedule is five cron fields, like 0 5 * * *");
  const cfg = x.config ?? {};
  for (const k of Object.keys(cfg)) need(!/(password|passwd|secret|private_?key|api_?key|token|credential)/i.test(k), `config may not hold ${k}; put it in the secret and reference it`);
  if (x.kind === "api") need(/^https?:\/\//i.test(cfgStr(cfg, "url")) || cfg.atpOn || cfg.freightOn, "an api connection needs the catalog address, or availability or freight switched on");
  const r = await one<{ id: string }>(c, `
    insert into vendor_connection (entity_id, vendor_id, kind, adapter, name, config, credential_ref, schedule_cron, mapping, active)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    on conflict (entity_id, vendor_id, kind) do update set adapter = excluded.adapter, name = excluded.name, config = excluded.config,
      credential_ref = excluded.credential_ref, schedule_cron = excluded.schedule_cron, mapping = excluded.mapping, active = excluded.active
    returning id /* unscoped: an insert of a row carrying entity_id */`,
    [s.entityId, x.vendorId, x.kind, adapter, x.name?.trim() || `${v.name} ${x.kind}`, JSON.stringify(cfg), ref, cron, JSON.stringify(x.mapping ?? {}), x.active ?? true]);
  await audit(c, s, { table: "vendor_connection", rowId: r.id, action: "update", after: { ...x, credentialRef: ref } });
  return r.id;
}

type ConnRow = { id: string; vendor_id: string; kind: string; adapter: string; name: string; config: Cfg; credential_ref: string | null;
  mapping: Record<string, string>; active: boolean; last_ok: boolean | null };

export type RunResult = { runId: string; ok: boolean; note: string; rows: number; added: number; changed: number; atpRows: number; freightRows: number };

/**
 * Run one connection: pull the catalog and build it through the import,
 * ask for availability, pull freight per store. Whatever happens, the run
 * and the connection record it in plain words; a failed run changes nothing
 * in the catalog.
 */
export async function runConnection(c: Client, s: Scope, connectionId: string, env: FeedEnv, trigger: "manual" | "schedule" = "manual"): Promise<RunResult> {
  const conn = (await q<ConnRow>(c, `select id, vendor_id, kind, adapter, name, config, credential_ref, mapping, active, last_ok
                                       from vendor_connection where id = $1 and entity_id = $2 for update`, [connectionId, s.entityId]))[0];
  need(conn, "no such vendor connection");
  need(conn.kind === "api", conn.kind === "manual" ? "a manual connection has nothing to pull; upload the file on the Import tab"
    : `pulling over ${conn.kind} is not built yet; use the Import tab for now`);
  const run = await one<{ id: string }>(c, `insert into vendor_feed_run (entity_id, connection_id, trigger, run_by) values ($1,$2,$3,$4) returning id`,
    [s.entityId, conn.id, trigger, s.actor.id || null]);
  const cfg = conn.config ?? {};
  const res: RunResult = { runId: run.id, ok: false, note: "", rows: 0, added: 0, changed: 0, atpRows: 0, freightRows: 0 };
  const notes: string[] = [];
  let importRun: string | null = null;
  await c.query("savepoint feed");
  try {
    const creds = credentialsOf(env, conn.credential_ref);
    const headers = await authHeaders(env, cfg, creds);
    if (cfgStr(cfg, "url")) {
      const recs = await pullRecords(env, cfg, headers);
      res.rows = recs.length;
      need(recs.length, "the catalog feed answered, but with no products");
      const csv = recordsToCsv(recs);
      const heads = Object.keys(recs.reduce((a, r) => Object.assign(a, r), {} as Record<string, string>));
      const mapping: Record<string, string> = {};
      for (const [k, v] of Object.entries(conn.mapping ?? {})) if (heads.includes(v)) mapping[k] = v;   // drop vanished columns
      for (const [k, v] of Object.entries(automap(heads))) if (!mapping[k] && !Object.values(mapping).includes(v)) mapping[k] = v;   // recognise new ones
      const miss = missingRequired(mapping);
      need(!miss.length, `pulled ${recs.length} products, but no column covers ${miss.join(", ")} any more; open the connection and pick them. The catalog was not changed`);
      const pv = await previewImport(c, s, { vendorId: conn.vendor_id, csv, filename: `${conn.name} feed`, mapping });
      const ap = await applyImport(c, s, pv.runId);
      importRun = pv.runId; res.added = ap.add; res.changed = ap.change;
      notes.push(`${recs.length} products: ${ap.add} added, ${ap.change} changed, ${ap.same} unchanged${ap.skip ? `, ${ap.skip} skipped` : ""}`);
      await c.query(`update vendor_connection set mapping = $3 where id = $1 and entity_id = $2`, [conn.id, s.entityId, JSON.stringify(mapping)]);
    }
    if (cfg.atpOn) {
      const skus = (await q<{ vendor_sku: string }>(c, `select distinct vendor_sku from product where entity_id = $1 and vendor_id = $2
                                                          and vendor_sku is not null and status <> 'discontinued' and kind <> 'kit' order by 1`, [s.entityId, conn.vendor_id]))
        .map((x) => x.vendor_sku);
      const atp = await atpInquiry(env, cfg, creds, skus);
      for (const a of atp.rows) {
        await c.query(`
          insert into vendor_availability (entity_id, vendor_id, vendor_sku, product_id, qty_available, lead_days, exception, as_of)
          values ($1,$2,$3,(select id from product where entity_id = $1 and vendor_id = $2 and upper(vendor_sku) = upper($3) limit 1),$4,$5,$6,now())
          on conflict (entity_id, vendor_id, vendor_sku) do update set product_id = excluded.product_id, qty_available = excluded.qty_available,
            lead_days = excluded.lead_days, exception = excluded.exception, as_of = now()`,
          [s.entityId, conn.vendor_id, a.sku.toUpperCase(), a.qty, a.leadDays, a.exception]);
      }
      res.atpRows = atp.rows.length;
      notes.push(`availability for ${atp.rows.length} of ${skus.length} models in ${atp.batches} ${atp.batches === 1 ? "call" : "calls"}`);
    }
    if (cfg.freightOn) {
      const map = (cfg.shipTos ?? {}) as Record<string, string>;
      const locs = await q<{ id: string; name: string }>(c, `select id, name from location where entity_id = $1 and id = any($2)`, [s.entityId, Object.keys(map)]);
      need(locs.length, "freight by store is on, but no store has the vendor's ship-to number yet");
      const fr = await freightPull(env, cfg, headers, locs.map((l) => ({ locationId: l.id, number: String(map[l.id]) })));
      for (const f of fr.rows) {
        await c.query(`
          insert into vendor_sku_freight (entity_id, vendor_id, vendor_sku, location_id, freight_minor, net_minor, as_of) values ($1,$2,$3,$4,$5,$6,now())
          on conflict (entity_id, vendor_id, vendor_sku, location_id) do update set freight_minor = excluded.freight_minor, net_minor = excluded.net_minor, as_of = now()`,
          [s.entityId, conn.vendor_id, f.sku, f.locationId, f.freightMinor.toString(), f.netMinor?.toString() ?? null]);
      }
      res.freightRows = fr.rows.length;
      notes.push(`freight: ${fr.rows.length} rows for ${locs.length - fr.skipped.length} ${locs.length - fr.skipped.length === 1 ? "store" : "stores"}${fr.skipped.length ? ` (${fr.skipped.length} skipped: ${fr.skipped.join(", ")})` : ""}`);
    }
    need(notes.length, "nothing to pull: set the catalog address, or switch on availability or freight");
    await c.query("release savepoint feed");
    res.ok = true;
    res.note = notes.join(" · ");
  } catch (e) {
    await c.query("rollback to savepoint feed");
    if (!(e instanceof FeedError) && !(e instanceof CatalogError)) {
      // a fault in the network layer or a bad answer: say so in words, keep the detail short
      res.note = `the pull failed: ${((e as Error).message || String(e)).slice(0, 200)}`;
    } else res.note = e.message;
    importRun = null;
    res.added = res.changed = res.atpRows = res.freightRows = 0;
  }
  await c.query(`update vendor_feed_run set finished_at = now(), outcome = $3, rows = $4, import_run_id = $5, atp_rows = $6, freight_rows = $7, note = $8
                  where id = $1 and entity_id = $2`, [run.id, s.entityId, res.ok ? "ok" : "failed", res.rows, importRun, res.atpRows, res.freightRows, res.note]);
  await c.query(`update vendor_connection set last_run_at = now(), last_ok = $3, last_note = $4,
                        consecutive_failures = case when $3 then 0 else consecutive_failures + 1 end where id = $1 and entity_id = $2`,
    [conn.id, s.entityId, res.ok, res.note]);
  return res;
}
