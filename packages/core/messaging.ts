// Connections to the outside, in one place: outbound email (SMTP, or SendGrid,
// Postmark, Mailgun, Resend by API key), texts (Twilio or any HTTPS provider),
// the card processor, maps, bank feeds, webhooks, and the marketplaces and ad
// platforms that are coming later.
//
// A connection is set for one company, or once for the whole client
// (entity_id null) with a company's own row winning. Its settings are plain
// (a trigger refuses anything that looks like a secret); its secrets are
// AES-256-GCM sealed under ERP_SECRET_KEY, bound to the connection and name,
// write-only: a read only ever says a secret is "set".
//
// Everything sent is kept in outbound_message with its status, the provider's
// message id and the error in plain words. A message carrying a sign-in code
// is kept with the code redacted and can never be resent. With no email
// connected, the callers keep their old behaviour (logged, not sent), and the
// log says so.
//
// Network safety: HTTP goes through vendor_feeds.call (https only, every hop's
// addresses public, redirects checked by hand, a timeout). The SMTP client
// below connects only to a public address it has checked (the name is resolved
// once and the checked address is the one dialled), on a mail port, with a
// timeout on every step. ERP_SMTP_ALLOW_PRIVATE=1 lets a private relay in;
// ERP_SMTP_ALLOW_PLAIN=1 allows a relay without TLS.

import net from "node:net";
import tls from "node:tls";
import { createHmac, randomBytes } from "node:crypto";
import { q, one, audit, tx, afterCommit, pool, type Client, type Scope } from "./db.ts";
import { call, sealSecret, unsealSecret, liveEnv, FeedError, type FeedEnv } from "./vendor_feeds.ts";
import { isPrivateIp } from "./catalog.ts";
import { setGeocoderFor, censusGeocoder, GeocodeError, type Geocoder } from "./geocode.ts";

export class ConnectionError extends Error {}
const need = (c: unknown, m: string): void => { if (!c) throw new ConnectionError(m); };

// ================================================================== the edge

export type MsgEnv = FeedEnv & {
  smtpAllowPrivate?: boolean;     // ERP_SMTP_ALLOW_PRIVATE=1: a relay on a private network
  smtpAllowPlain?: boolean;       // ERP_SMTP_ALLOW_PLAIN=1: a relay with no TLS at all
  smtpTimeoutMs?: number;          // each reply
  smtpDeadlineMs?: number;         // the whole send
  smtpAllowHosts?: string[];       // ERP_SMTP_ALLOW_HOSTS: only these servers (they may be private)
  smtpAllowPorts?: number[];       // checks only: the fake server's port
  smtpTls?: tls.ConnectionOptions; // checks only: trust a test certificate
};
export const liveMsgEnv = (): MsgEnv => ({
  ...liveEnv(),
  smtpAllowPrivate: process.env.ERP_SMTP_ALLOW_PRIVATE === "1",
  smtpAllowPlain: process.env.ERP_SMTP_ALLOW_PLAIN === "1",
  smtpAllowHosts: (process.env.ERP_SMTP_ALLOW_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
});
let envFn: () => MsgEnv = liveMsgEnv;
/** Checks hand in a fake network; the server uses the real one. */
export const useMsgEnv = (fn: () => MsgEnv) => { envFn = fn; };
export const msgEnv = () => envFn();

// ============================================================= the catalog

export type Field = { name: string; label: string; secret?: boolean; required?: boolean; type?: "text" | "number" | "email" | "url" | "select" | "tel";
  options?: [string, string][]; hint?: string };
export type Provider = { id: string; name: string; fields: Field[] };
export type KindState = "built" | "summary" | "stored" | "later";
export type Kind = {
  id: string; name: string; group: string; state: KindState; note: string;
  providers: Provider[];
  /** web_admin may manage it (the web store and marketing); everything else is the owner's and controller's */
  web?: boolean;
  test?: "email" | "sms" | "geocode" | "webhook";
  /** the screen that holds its real setup */
  link?: { screen: string; label: string };
};

const FROM: Field[] = [
  { name: "fromName", label: "From name", required: true, hint: "What the customer sees, like your store name" },
  { name: "fromAddress", label: "From address", type: "email", required: true },
];
const later = (id: string, name: string, note: string, fields: Field[]): Kind => ({
  id, name, group: "Marketplaces and marketing", state: "later", web: true,
  note: `${note} Coming later: keys can be saved now (sealed), but nothing is sent yet.`,
  providers: [{ id, name, fields }],
});

export const KINDS: Kind[] = [
  { id: "email", name: "Email (outbound)", group: "Messages", state: "built", test: "email",
    note: "Trade portal sign-in codes, purchase orders to vendors, delivery and tear-sheet emails, and scheduled reports go out through this. With none set up they are logged here and not sent.",
    providers: [
      { id: "smtp", name: "SMTP server", fields: [
        { name: "host", label: "Server", required: true, hint: "Like smtp.office365.com" },
        { name: "port", label: "Port", type: "number", required: true, hint: "587 for STARTTLS, 465 for TLS" },
        { name: "security", label: "Security", type: "select", options: [["starttls", "STARTTLS"], ["tls", "TLS from the start"], ["none", "None (a private relay only)"]] },
        { name: "user", label: "User name" },
        { name: "password", label: "Password", secret: true },
        ...FROM] },
      { id: "sendgrid", name: "SendGrid", fields: [{ name: "apiKey", label: "API key", secret: true, required: true }, ...FROM] },
      { id: "postmark", name: "Postmark", fields: [{ name: "serverToken", label: "Server token", secret: true, required: true }, ...FROM] },
      { id: "mailgun", name: "Mailgun", fields: [{ name: "domain", label: "Sending domain", required: true },
        { name: "region", label: "Region", type: "select", options: [["us", "US"], ["eu", "EU"]] },
        { name: "apiKey", label: "API key", secret: true, required: true }, ...FROM] },
      { id: "resend", name: "Resend", fields: [{ name: "apiKey", label: "API key", secret: true, required: true }, ...FROM] },
    ] },
  { id: "sms", name: "Text messages", group: "Messages", state: "built", test: "sms",
    note: "Delivery confirmations, day-before reminders, on-the-way texts and tear sheets to customers with a phone. With none set up they are logged and not sent.",
    providers: [
      { id: "twilio", name: "Twilio", fields: [{ name: "accountSid", label: "Account SID", required: true },
        { name: "authToken", label: "Auth token", secret: true, required: true }, { name: "fromNumber", label: "From number", type: "tel", required: true, hint: "+1 and ten digits" }] },
      { id: "https", name: "Another provider (HTTPS)", fields: [{ name: "url", label: "Send address", type: "url", required: true, hint: "We POST {to, from, body} as JSON" },
        { name: "fromNumber", label: "From number", type: "tel" }, { name: "headerName", label: "Key header", hint: "Authorization by default (Bearer)" },
        { name: "authToken", label: "Key", secret: true, required: true }, { name: "idField", label: "Message id field in the answer", hint: "id by default" }] },
    ] },
  { id: "card", name: "Card payments", group: "Payments", state: "stored",
    note: "The web store, POS refunds of web orders and the trade portal charge cards through the store's processor. Only the test processor is built: it approves tok_test_ cards and charges nothing. A real processor's keys can be saved now, sealed.",
    providers: [
      { id: "test", name: "Test processor (nothing is charged)", fields: [] },
      { id: "stripe", name: "Stripe (not built yet)", fields: [{ name: "publishableKey", label: "Publishable key" }, { name: "secretKey", label: "Secret key", secret: true }] },
      { id: "authorize_net", name: "Authorize.net (not built yet)", fields: [{ name: "loginId", label: "API login id" }, { name: "transactionKey", label: "Transaction key", secret: true }] },
      { id: "square", name: "Square (not built yet)", fields: [{ name: "locationId", label: "Location id" }, { name: "accessToken", label: "Access token", secret: true }] },
    ] },
  { id: "card_present", name: "Card terminals", group: "Payments", state: "later",
    note: "Card-present terminals at the register are not built yet. POS records card tenders typed in by the cashier.", providers: [{ id: "none", name: "Not built yet", fields: [] }] },
  { id: "maps", name: "Maps and geocoding", group: "Operations", state: "built", test: "geocode",
    note: "Turns customer addresses into map points for delivery routes. The US Census geocoder is free and needs no key.",
    providers: [
      { id: "census", name: "US Census (free, no key)", fields: [] },
      { id: "google", name: "Google Maps", fields: [{ name: "apiKey", label: "API key", secret: true, required: true }] },
      { id: "mapbox", name: "Mapbox", fields: [{ name: "accessToken", label: "Access token", secret: true, required: true }] },
    ] },
  { id: "vendor_api", name: "Vendor APIs", group: "Operations", state: "summary", link: { screen: "catalog", label: "Open Catalog, Vendors" },
    note: "Each vendor's product, price, stock and order APIs are set up on the vendor, under Catalog, Vendors, API setup.", providers: [] },
  { id: "edi", name: "EDI trading partners", group: "Operations", state: "summary", link: { screen: "edi", label: "Open Vendor EDI" },
    note: "X12 partners are set up in Vendor EDI. Files move by hand or through a drop folder; SFTP and AS2 transport are not built yet.", providers: [] },
  { id: "printers", name: "Label printers", group: "Operations", state: "summary", link: { screen: "labels", label: "Open Labels" },
    note: "Network label printers on your own network are set up in Labels.", providers: [] },
  { id: "bank", name: "Bank feeds", group: "Money", state: "stored", link: { screen: "feeds", label: "Open Feeds" },
    note: "Bank statements come in through Feeds (uploads and statement connections). Plaid is not built yet; its keys can be saved now, sealed.",
    providers: [{ id: "plaid", name: "Plaid (not built yet)", fields: [{ name: "clientId", label: "Client id" },
      { name: "environment", label: "Environment", type: "select", options: [["sandbox", "Sandbox"], ["production", "Production"]] },
      { name: "secret", label: "Secret", secret: true }] }] },
  { id: "accounting", name: "Accounting export", group: "Money", state: "later",
    note: "Sending journals to another accounting system is not built yet; keys can be saved now, sealed.",
    providers: [{ id: "quickbooks", name: "QuickBooks Online", fields: [{ name: "realmId", label: "Company id" }, { name: "refreshToken", label: "Refresh token", secret: true }] },
      { id: "xero", name: "Xero", fields: [{ name: "tenantRef", label: "Organisation id" }, { name: "refreshToken", label: "Refresh token", secret: true }] }] },
  { id: "payroll_provider", name: "Payroll provider", group: "Money", state: "later",
    note: "Payroll runs here; sending it to an outside payroll company is not built yet. Keys can be saved now, sealed.",
    providers: [{ id: "adp", name: "ADP", fields: [{ name: "clientId", label: "Client id" }, { name: "clientSecret", label: "Client secret", secret: true }] },
      { id: "gusto", name: "Gusto", fields: [{ name: "companyRef", label: "Company id" }, { name: "apiToken", label: "API token", secret: true }] }] },
  { id: "webhooks", name: "Webhooks out", group: "Data", state: "built", test: "webhook",
    note: "A signed test can be sent now (X-ERP-Signature: t=time,v1=HMAC-SHA256 of time.body). Order created, delivered and paid events are not sent yet.",
    providers: [{ id: "https", name: "HTTPS endpoint", fields: [{ name: "url", label: "Address", type: "url", required: true },
      { name: "events", label: "Events", hint: "order_created, delivered, paid" }, { name: "signingSecret", label: "Signing secret", secret: true, required: true }] }] },
  later("amazon", "Amazon", "List products and take orders on Amazon.", [{ name: "sellerId", label: "Seller id" }, { name: "clientId", label: "Client id" }, { name: "clientSecret", label: "Client secret", secret: true }, { name: "refreshToken", label: "Refresh token", secret: true }]),
  later("walmart", "Walmart Marketplace", "List products and take orders on Walmart.", [{ name: "clientId", label: "Client id" }, { name: "clientSecret", label: "Client secret", secret: true }]),
  later("ebay", "eBay", "List products and take orders on eBay.", [{ name: "appId", label: "App id" }, { name: "certId", label: "Cert id", secret: true }, { name: "refreshToken", label: "Refresh token", secret: true }]),
  later("gigacloud", "Giga Cloud dropship", "Sell Giga Cloud's catalog, shipped by them.", [{ name: "clientId", label: "Client id" }, { name: "clientSecret", label: "Client secret", secret: true }]),
  later("wondersign", "Wondersign kiosks", "In-store kiosks with the endless aisle.", [{ name: "accountId", label: "Account id" }, { name: "apiKey", label: "API key", secret: true }]),
  later("meta_capi", "Meta Conversions API", "Send purchases to Meta for ad measurement.", [{ name: "pixelId", label: "Pixel id" }, { name: "accessToken", label: "Access token", secret: true }]),
  later("google_ads", "Google Ads and GA4", "Send purchases to Google Ads and Analytics.", [{ name: "customerId", label: "Ads customer id" }, { name: "measurementId", label: "GA4 measurement id" }, { name: "developerToken", label: "Developer token", secret: true }, { name: "apiSecret", label: "GA4 API secret", secret: true }]),
  later("tiktok", "TikTok", "Send purchases to TikTok for ad measurement.", [{ name: "pixelId", label: "Pixel id" }, { name: "accessToken", label: "Access token", secret: true }]),
  later("pinterest", "Pinterest", "Send purchases to Pinterest for ad measurement.", [{ name: "adAccountId", label: "Ad account id" }, { name: "accessToken", label: "Access token", secret: true }]),
  later("klaviyo", "Klaviyo", "Sync customers and orders to Klaviyo for email marketing.", [{ name: "siteId", label: "Public site id" }, { name: "privateApiKey", label: "Private API key", secret: true }]),
];
export const kindById = (id: string) => KINDS.find((k) => k.id === id);

/** Who may set a connection up: the owner and controllers everything; the web admin the web store's and marketing's. */
export function mayManage(roles: Set<string>, kind: Kind) {
  return roles.has("owner") || roles.has("controller") || (!!kind.web && roles.has("web_admin"));
}

// ========================================================= rows and secrets

type Row = { id: string; tenant_id: string; entity_id: string | null; kind: string; provider: string; settings: Record<string, unknown>;
  status: string; last_error: string | null; last_tested_at: string | null; last_ok_at: string | null; updated_by_name: string | null; updated_at: string };
const COLS = `id, tenant_id, entity_id, kind, provider, settings, status, last_error, last_tested_at, last_ok_at, updated_by_name, updated_at`;

/** The live row for exactly this place (a company, or the client when entityId is null). */
async function rowAt(c: Client, tenantId: string, entityId: string | null, kind: string): Promise<Row | null> {
  const r = await q<Row>(c, `select ${COLS} from admin_connection where tenant_id = $1 and entity_id is not distinct from $2 and kind = $3 and active
     /* unscoped: one client's row for one company, or the client's own (entity_id null) */`, [tenantId, entityId, kind]);
  return r[0] ?? null;
}

/** The connection a company uses: its own, else the client's. */
export async function connectionFor(c: Client, entityId: string, kind: string): Promise<Row | null> {
  const r = await q<Row>(c, `select ${COLS.split(", ").map((x) => "a." + x).join(", ")} from admin_connection a join entity e on e.tenant_id = a.tenant_id
     where e.id = $1 and a.kind = $2 and a.active and (a.entity_id = $1 or a.entity_id is null)
     order by a.entity_id nulls last limit 1 /* unscoped: the company's own row, else its client's */`, [entityId, kind]);
  return r[0] ?? null;
}

async function secretsOf(c: Client, row: Row, env: MsgEnv): Promise<Record<string, string>> {
  const rows = await q<{ name: string; iv: Buffer; ciphertext: Buffer; tag: Buffer }>(c,
    `select name, iv, ciphertext, tag from admin_connection_secret where connection_id = $1 and tenant_id = $2 and cleared_at is null /* unscoped: a connection's own secrets */`, [row.id, row.tenant_id]);
  if (!rows.length) return {};
  need(env.secretKey && env.secretKey.length === 32, "ERP_SECRET_KEY is not set on the server, so the saved keys cannot be read");
  const out: Record<string, string> = {};
  for (const r of rows) {
    try { out[r.name] = unsealSecret(env.secretKey!, row.id, r.name, r.iv, r.ciphertext, r.tag); }
    catch { throw new ConnectionError(`the saved ${r.name} cannot be read with this ERP_SECRET_KEY; type it again`); }
  }
  return out;
}

async function secretNames(c: Client, row: Row): Promise<Record<string, boolean>> {
  const rows = await q<{ name: string }>(c, `select name from admin_connection_secret where connection_id = $1 and tenant_id = $2 and cleared_at is null /* unscoped: a connection's own secrets */`, [row.id, row.tenant_id]);
  return Object.fromEntries(rows.map((r) => [r.name, true]));
}

const EMAIL = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;
const PHONE = /^\+?[0-9]{7,15}$/;
const clean = (v: unknown, max = 300) => (typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : typeof v === "number" ? String(v) : "");

/** Check a provider's plain settings; unknown names are dropped, secret ones are refused here (and by the database). */
function checkSettings(kind: Kind, p: Provider, raw: Record<string, unknown>) {
  const out: Record<string, string | number> = {};
  for (const [k] of Object.entries(raw)) {
    const f = p.fields.find((x) => x.name === k);
    need(!f?.secret, `${f?.label ?? k} is a secret; type it into its secret box`);
  }
  for (const f of p.fields.filter((x) => !x.secret)) {
    const v = clean(raw[f.name]);
    if (!v) { need(!f.required, `${kind.name}: fill in ${f.label.toLowerCase()}`); continue; }
    if (f.type === "number") { const n = Number(v); need(Number.isInteger(n) && n > 0 && n < 65536, `${f.label} is a port number, like 587`); out[f.name] = n; continue; }
    if (f.type === "email") need(EMAIL.test(v), `${v} is not an email address`);
    if (f.type === "url") need(/^https:\/\/[^\s]+$/i.test(v), `${f.label} must be an https address`);
    if (f.type === "tel") need(PHONE.test(v.replace(/[\s().-]/g, "")), `${v} is not a phone number; use +1 and ten digits`);
    if (f.type === "select") need(f.options!.some(([o]) => o === v), `pick ${f.label.toLowerCase()} from the list`);
    out[f.name] = f.type === "tel" ? v.replace(/[\s().-]/g, "") : v;
  }
  if (kind.id === "email" && p.id === "smtp") {
    need(/^[a-z0-9.-]{1,253}$/i.test(String(out.host ?? "")), "the server is a host name, like smtp.example.com");
    if (!out.security) out.security = Number(out.port) === 465 ? "tls" : "starttls";
  }
  return out;
}

export type Place = { tenantId: string; entityId: string | null };
export type Actor = { personId: string | null; personName: string; fromEntityId?: string | null };

/**
 * Save a connection's settings and secrets for a company or the whole client.
 * A secret given replaces the saved one; null clears it; left out keeps it.
 * Changing the provider turns the old row off and starts a new one.
 */
export async function saveConnection(c: Client, place: Place, kindId: string, providerId: string, settings: Record<string, unknown>,
  secrets: Record<string, unknown>, who: Actor, env: MsgEnv = msgEnv()) {
  const kind = kindById(kindId);
  need(kind && kind.state !== "summary", "that connection is set up on its own screen");
  const p = kind!.providers.find((x) => x.id === providerId);
  need(p, `pick one of the ${kind!.name.toLowerCase()} providers`);
  const plain = checkSettings(kind!, p!, settings ?? {});
  let row = await rowAt(c, place.tenantId, place.entityId, kindId);
  const before = row ? { provider: row.provider, settings: row.settings } : null;
  if (row && row.provider !== providerId) {
    await c.query(`update admin_connection set active = false, status = 'off', updated_at = now(), updated_by = $3, updated_by_name = $4 where id = $1 and tenant_id = $2`,
      [row.id, place.tenantId, who.personId, who.personName]);
    row = null;
  }
  if (row) {
    await c.query(`update admin_connection set settings = $3, status = 'saved', last_error = null, updated_at = now(), updated_by = $4, updated_by_name = $5
                    where id = $1 and tenant_id = $2`, [row.id, place.tenantId, JSON.stringify(plain), who.personId, who.personName]);
  } else {
    row = await one<Row>(c, `insert into admin_connection (tenant_id, entity_id, kind, provider, settings, updated_by, updated_by_name)
       values ($1,$2,$3,$4,$5,$6,$7) returning ${COLS}`, [place.tenantId, place.entityId, kindId, providerId, JSON.stringify(plain), who.personId, who.personName]);
  }
  const typed = Object.entries(secrets ?? {}).filter(([, v]) => v !== undefined && v !== "");
  for (const [name, v] of typed) {
    const f = p!.fields.find((x) => x.name === name && x.secret);
    need(f, `${name} is not one of this provider's secrets`);
    if (v === null) {
      await c.query(`update admin_connection_secret set cleared_at = now(), set_by = $3 where connection_id = $1 and tenant_id = $2 and name = $4`, [row!.id, place.tenantId, who.personId, name]);
      continue;
    }
    need(typeof v === "string" && v.length <= 4000, `${f!.label} is too long`);
    need(env.secretKey && env.secretKey.length === 32, "add ERP_SECRET_KEY to the service's environment (32 random bytes, base64) so keys and passwords can be stored encrypted; nothing was saved");
    const box = sealSecret(env.secretKey!, row!.id, name, String(v).trim());
    await c.query(`insert into admin_connection_secret (connection_id, tenant_id, name, iv, ciphertext, tag, set_by) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (connection_id, name) do update set iv = excluded.iv, ciphertext = excluded.ciphertext, tag = excluded.tag, set_by = excluded.set_by, set_at = now(), cleared_at = null`,
      [row!.id, place.tenantId, name, box.iv, box.ct, box.tag, who.personId]);
  }
  const have = await secretNames(c, row!);
  const missing = p!.fields.filter((f) => f.secret && f.required && !have[f.name]).map((f) => f.label.toLowerCase());
  // Audited by name only: which settings and which secrets changed, never a value. A client-wide row is audited in the company it was set from.
  const at = place.entityId ?? who.fromEntityId ?? null;
  if (at) await audit(c, { tenantId: place.tenantId, entityId: at, actor: { kind: "user", id: who.personId ?? undefined, label: who.personName } } as Scope,
    { table: "admin_connection", rowId: row!.id, action: before ? "update" : "insert",
      before: before ? { provider: before.provider, settings: Object.keys(before.settings ?? {}) } : null,
      after: { scope: place.entityId ? "company" : "client", provider: providerId, settings: Object.keys(plain), secretsChanged: typed.map(([n]) => n) } });
  return { id: row!.id, kind: kindId, provider: providerId, missing };
}

/** Turn a connection off (kept, never deleted). The company falls back to the client's, or to none. */
export async function turnOff(c: Client, place: Place, kindId: string, who: Actor) {
  const row = await rowAt(c, place.tenantId, place.entityId, kindId);
  need(row, "there is no connection of that kind here to turn off");
  await c.query(`update admin_connection set active = false, status = 'off', updated_at = now(), updated_by = $3, updated_by_name = $4 where id = $1 and tenant_id = $2`,
    [row!.id, place.tenantId, who.personId, who.personName]);
  const at = place.entityId ?? who.fromEntityId ?? null;
  if (at) await audit(c, { tenantId: place.tenantId, entityId: at, actor: { kind: "user", id: who.personId ?? undefined, label: who.personName } } as Scope,
    { table: "admin_connection", rowId: row!.id, action: "transition", before: { status: row!.status }, after: { status: "off", scope: place.entityId ? "company" : "client", kind: kindId } });
  return { id: row!.id, off: true };
}

const shape = (row: Row | null, names: Record<string, boolean>) => row ? {
  id: row.id, provider: row.provider, settings: row.settings, secrets: Object.fromEntries(Object.keys(names).map((n) => [n, "set"])),
  status: row.status, lastError: row.last_error, lastTestedAt: row.last_tested_at, lastOkAt: row.last_ok_at,
  updatedBy: row.updated_by_name, updatedAt: row.updated_at, scope: row.entity_id ? "company" : "client",
} : null;

function plainStatus(row: Row | null, kind: Kind): { code: "not_set_up" | "saved" | "connected" | "failing" | "summary" | "later"; words: string } {
  if (kind.state === "summary") return { code: "summary", words: "Set up on its own screen" };
  if (!row) return { code: kind.state === "later" ? "later" : "not_set_up", words: kind.state === "later" ? "Coming later" : "Not set up" };
  if (row.status === "failing") return { code: "failing", words: `Failing: ${row.last_error ?? "the last try did not work"}` };
  if (row.status === "connected") return { code: "connected", words: "Connected" };
  if (kind.state === "later" || kind.state === "stored") return { code: "saved", words: "Keys saved; nothing is sent yet" };
  return { code: "saved", words: "Saved, not tested yet" };
}

/** The Connections screen. Secrets show only as "set". A person who may not manage a kind sees its name and status only. */
export async function connectionsView(c: Client, tenantId: string, entityId: string, roles: Set<string>) {
  const out = [];
  for (const kind of KINDS) {
    const manage = mayManage(roles, kind);
    const own = await rowAt(c, tenantId, entityId, kind.id);
    const client = await rowAt(c, tenantId, null, kind.id);
    const using = own ?? client;
    const st = plainStatus(using, kind);
    out.push({
      id: kind.id, name: kind.name, group: kind.group, state: kind.state, note: kind.note, web: !!kind.web, test: kind.test ?? null, link: kind.link ?? null,
      manage, status: st.code, statusWords: st.words, using: using ? (own ? "company" : "client") : null,
      providers: manage ? kind.providers : kind.providers.map((p) => ({ id: p.id, name: p.name, fields: [] })),
      company: manage ? shape(own, own ? await secretNames(c, own) : {}) : null,
      client: manage ? shape(client, client ? await secretNames(c, client) : {}) : null,
      summary: await summaryFor(c, entityId, kind.id),
    });
  }
  return out;
}

/** What the other screens hold, for the summary cards. */
async function summaryFor(c: Client, entityId: string, kind: string): Promise<Record<string, unknown> | null> {
  if (kind === "vendor_api") return one(c, `select count(*)::int feeds, count(*) filter (where active)::int active,
      count(*) filter (where active and last_ok = false)::int failing, count(distinct vendor_id)::int vendors from vendor_feed where entity_id = $1`, [entityId]);
  if (kind === "edi") return one(c, `select count(*)::int partners, count(*) filter (where edi_enabled)::int enabled,
      count(*) filter (where transport in ('sftp','as2'))::int waiting_on_transport from edi_partner where entity_id = $1`, [entityId]);
  if (kind === "printers") return one(c, `select count(*)::int printers from label_printer where entity_id = $1`, [entityId]);
  if (kind === "bank") return one(c, `select (select count(*)::int from connection where entity_id = $1 and source_code = 'bank_statement') connections,
      (select count(*)::int from bank_statement bs join bank_account b on b.id = bs.bank_account_id where b.entity_id = $1) statements`, [entityId]);
  if (kind === "card") return one(c, `select count(*)::int sites, coalesce(string_agg(distinct payment_provider, ', '), 'none') processors from shop_site where entity_id = $1`, [entityId]);
  if (kind === "maps") return { inUse: (await connectionFor(c, entityId, "maps"))?.provider ?? "census" };
  return null;
}

// ================================================================== SMTP

export class SmtpError extends Error {}
export type SmtpConfig = { host: string; port: number; security: "starttls" | "tls" | "none"; user?: string; password?: string; heloName?: string };
export type Envelope = { from: string; to: string[]; data: string };

/** Lines starting with a dot get a second one, and every line ends CRLF (RFC 5321 4.5.2). */
export function dotStuff(data: string): string {
  return data.replace(/\r\n|\r|\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
}

const MAIL_PORTS = new Set([25, 465, 587, 2525]);

async function smtpTarget(cfg: SmtpConfig, env: MsgEnv): Promise<string> {
  const h = cfg.host.toLowerCase();
  // The port is checked always, even for a private relay.
  if (!MAIL_PORTS.has(cfg.port) && !(env.smtpAllowPorts ?? []).includes(cfg.port)) throw new SmtpError("mail servers are reached on ports 25, 465, 587 or 2525");
  const allow = env.smtpAllowHosts ?? [];
  if (allow.length && !allow.includes(h)) throw new SmtpError(`${h} is not one of the mail servers this service may use (ERP_SMTP_ALLOW_HOSTS)`);
  const trusted = env.smtpAllowPrivate || allow.includes(h);
  const named = h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || isPrivateIp(h);
  if (named && !trusted) throw new SmtpError("mail servers on private networks are not called");
  if (net.isIP(h)) return h;
  if (trusted && named) return h;
  let addrs: string[];
  try { addrs = env.resolve ? await env.resolve(h) : []; } catch { throw new SmtpError(`${h} could not be found`); }
  if (!addrs.length) throw new SmtpError(`${h} could not be found`);
  if (!trusted && addrs.some((a) => isPrivateIp(a))) throw new SmtpError("mail servers on private networks are not called");
  return addrs[0];
}

/** A small SMTP client: EHLO, STARTTLS, AUTH PLAIN or LOGIN, MAIL FROM, RCPT TO, DATA with dot-stuffing, QUIT; a timeout on every reply. */
export async function smtpSend(cfg: SmtpConfig, envl: Envelope, env: MsgEnv = msgEnv()): Promise<{ id: string | null; reply: string }> {
  const live: { sock: net.Socket | null } = { sock: null };
  const deadline = env.smtpDeadlineMs ?? 45000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const over = new Promise<never>((_, fail) => {
    timer = setTimeout(() => { live.sock?.destroy(); fail(new SmtpError(`the mail server took longer than ${Math.round(deadline / 1000)} s in all; the message was not sent`)); }, deadline);
  });
  try { return await Promise.race([smtpConversation(cfg, envl, env, live), over]); }
  finally { clearTimeout(timer); live.sock?.destroy(); }
}

async function smtpConversation(cfg: SmtpConfig, envl: Envelope, env: MsgEnv, live: { sock: net.Socket | null }): Promise<{ id: string | null; reply: string }> {
  if (cfg.security === "none" && !env.smtpAllowPlain) throw new SmtpError("this server would be used with no encryption; pick STARTTLS or TLS (a plain relay needs ERP_SMTP_ALLOW_PLAIN=1)");
  const addr = await smtpTarget(cfg, env);
  const timeout = env.smtpTimeoutMs ?? 15000;
  let sock: net.Socket = await new Promise((ok, fail) => {
    const opts = { host: addr, port: cfg.port };
    const s = cfg.security === "tls"
      ? tls.connect({ ...opts, servername: net.isIP(cfg.host) ? undefined : cfg.host, ...(env.smtpTls ?? {}) }, () => ok(s))
      : net.connect(opts, () => ok(s));
    live.sock = s;
    s.setTimeout(timeout, () => { s.destroy(); fail(new SmtpError(`the mail server did not answer within ${Math.round(timeout / 1000)} s`)); });
    s.once("error", (e) => fail(new SmtpError(`the mail server could not be reached (${(e as Error).message})`)));
  });
  let buf = "";
  let waiting: { ok: (r: { code: number; text: string; lines: string[] }) => void; fail: (e: Error) => void } | null = null;
  let broken: Error | null = null;
  const onData = (d: Buffer) => { buf += d.toString("utf8"); pump(); };
  const onErr = (e: Error) => { broken = new SmtpError(`the connection to the mail server broke (${e.message})`); waiting?.fail(broken); waiting = null; };
  const onClose = () => { if (!broken) broken = new SmtpError("the mail server closed the connection"); waiting?.fail(broken); waiting = null; };
  function pump() {
    if (!waiting) return;
    const lines = buf.split("\r\n");
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3}(?: |$)/.test(lines[i])) {
        const got = lines.slice(0, i + 1);
        buf = lines.slice(i + 1).join("\r\n");
        const w = waiting; waiting = null;
        w.ok({ code: Number(got[i].slice(0, 3)), text: got.map((l) => l.slice(4)).join(" "), lines: got.map((l) => l.slice(4)) });
        return;
      }
    }
  }
  const attach = (s: net.Socket) => {
    s.on("data", onData); s.on("error", onErr); s.on("close", onClose);
    s.setTimeout(timeout, () => { broken = new SmtpError(`the mail server stopped answering (over ${Math.round(timeout / 1000)} s)`); waiting?.fail(broken); waiting = null; s.destroy(); });
  };
  const detach = (s: net.Socket) => { s.off("data", onData); s.off("error", onErr); s.off("close", onClose); s.setTimeout(0); };
  attach(sock);
  const reply = () => new Promise<{ code: number; text: string; lines: string[] }>((ok, fail) => {
    if (broken) return fail(broken);
    waiting = { ok, fail }; pump();
  });
  const send = (line: string) => { sock.write(line + "\r\n"); };
  const expect = async (what: string, codes: number[]) => {
    const r = await reply();
    if (!codes.includes(r.code)) throw new SmtpError(`the mail server refused ${what}: ${r.code} ${r.text}`.slice(0, 300));
    return r;
  };
  const cmd = async (line: string, what: string, codes: number[]) => { send(line); return expect(what, codes); };
  try {
    await expect("the connection", [220]);
    const helo = cfg.heloName ?? "erp.local";
    let ext = (await cmd(`EHLO ${helo}`, "EHLO", [250])).lines.map((l) => l.toUpperCase());
    if (cfg.security === "starttls") {
      if (!ext.some((l) => l.startsWith("STARTTLS"))) throw new SmtpError("the mail server does not offer STARTTLS; pick TLS, or check the port");
      await cmd("STARTTLS", "STARTTLS", [220]);
      detach(sock);
      // The upgrade has its own clock: with the reply timer off, a server that stops here would otherwise hold us for ever.
      sock = await new Promise((ok, fail) => {
        const t = tls.connect({ socket: sock, servername: net.isIP(cfg.host) ? undefined : cfg.host, ...(env.smtpTls ?? {}) }, () => { clearTimeout(hs); ok(t); });
        live.sock = t;
        const hs = setTimeout(() => { t.destroy(); fail(new SmtpError(`the mail server did not finish STARTTLS within ${Math.round(timeout / 1000)} s`)); }, timeout);
        t.once("error", (e) => { clearTimeout(hs); fail(new SmtpError(`the mail server's certificate was not accepted (${e.message})`)); });
      });
      buf = "";
      attach(sock);
      ext = (await cmd(`EHLO ${helo}`, "EHLO", [250])).lines.map((l) => l.toUpperCase());
    }
    if (cfg.user) {
      const auth = ext.find((l) => l.startsWith("AUTH")) ?? "";
      const bad = (r: { code: number; text: string }) => new SmtpError(`the mail server did not accept the user name and password (${r.code} ${r.text})`.slice(0, 300));
      if (/\bPLAIN\b/.test(auth)) {
        send(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.password ?? ""}`).toString("base64")}`);
        const r = await reply(); if (r.code !== 235) throw bad(r);
      } else if (/\bLOGIN\b/.test(auth)) {
        await cmd("AUTH LOGIN", "AUTH LOGIN", [334]);
        await cmd(Buffer.from(cfg.user).toString("base64"), "the user name", [334]);
        send(Buffer.from(cfg.password ?? "").toString("base64"));
        const r = await reply(); if (r.code !== 235) throw bad(r);
      } else throw new SmtpError("the mail server offers no sign-in we can use (PLAIN or LOGIN)");
    }
    await cmd(`MAIL FROM:<${envl.from}>`, "the sender", [250]);
    for (const to of envl.to) await cmd(`RCPT TO:<${to}>`, `the recipient ${to}`, [250, 251]);
    await cmd("DATA", "the message", [354]);
    const body = dotStuff(envl.data);
    sock.write(body.endsWith("\r\n") ? body : body + "\r\n");
    const done = await cmd(".", "the message", [250]);
    try { await cmd("QUIT", "QUIT", [221]); } catch { /* sent already */ }
    const id = /(?:queued as|id=|<)\s*([^\s>]+)/i.exec(done.text)?.[1] ?? null;
    return { id, reply: done.text.slice(0, 200) };
  } finally { detach(sock); sock.destroy(); }
}

// ================================================================ messages

export type Attachment = { filename: string; content: string; type?: string };
export type Email = { to: string[]; subject: string; text: string; attachments?: Attachment[] };

/** A From name: no angle brackets or quotes, quoted when plain, encoded when not ASCII. */
export function displayName(name: string) {
  const n = name.replace(/[\r\n<>"\\]+/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return '""';
  return /^[\x20-\x7e]*$/.test(n) ? `"${n}"` : `=?UTF-8?B?${Buffer.from(n).toString("base64")}?=`;
}
const headerWord = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`;
const wrap76 = (b64: string) => b64.replace(/.{76}/g, "$&\r\n");

/** An RFC 5322 message. Header values lose CR and LF, so nothing can be injected. */
export function buildMime(from: { name: string; address: string }, m: Email, now = new Date()): string {
  const h = (s: string) => s.replace(/[\r\n]+/g, " ");
  const domain = from.address.split("@")[1] ?? "erp.local";
  const head = [
    `From: ${displayName(from.name)} <${h(from.address).replace(/[<>\s]/g, "")}>`,
    `To: ${m.to.map(h).join(", ")}`,
    `Subject: ${headerWord(h(m.subject))}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
  ];
  const ascii = /^[\x00-\x7f]*$/.test(m.text) && m.text.split(/\r?\n/).every((l) => l.length <= 998);
  const textPart = ascii
    ? ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 7bit", "", m.text]
    : ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(m.text).toString("base64"))];
  if (!m.attachments?.length) return [...head, ...textPart].join("\r\n");
  const b = `erp-${randomBytes(8).toString("hex")}`;
  const parts = [`--${b}`, ...textPart];
  for (const a of m.attachments) {
    const name = a.filename.replace(/["\r\n\\]/g, "");
    parts.push(`--${b}`, `Content-Type: ${a.type ?? "text/csv"}; name="${name}"`, "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${name}"`, "", wrap76(Buffer.from(a.content).toString("base64")));
  }
  parts.push(`--${b}--`);
  return [...head, `Content-Type: multipart/mixed; boundary="${b}"`, "", ...parts].join("\r\n");
}

/** Send through one connection row. Throws a ConnectionError in plain words; returns the provider's message id. */
async function sendEmailVia(row: Row, sec: Record<string, string>, m: Email, env: MsgEnv): Promise<string | null> {
  const s = row.settings as Record<string, string>;
  const from = { name: s.fromName ?? "", address: s.fromAddress ?? "" };
  need(EMAIL.test(from.address), "the connection has no from address; add one and save");
  for (const t of m.to) need(EMAIL.test(t), `${t} is not an email address`);
  const http = async (url: string, init: { method: string; headers: Record<string, string>; body: string }, what: string) => {
    let r;
    try { r = await call(env, url, init, 15000, what, 1); }
    catch (e) { if (e instanceof FeedError) throw new ConnectionError(e.message); throw e; }
    if (r.status < 200 || r.status >= 300) {
      const why = r.status === 401 || r.status === 403 ? "did not accept the key" : `answered ${r.status}`;
      throw new ConnectionError(`${what} ${why}${r.text ? `: ${r.text.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
    }
    return r;
  };
  const json = (t: string) => { try { return JSON.parse(t) as Record<string, unknown>; } catch { return {}; } };
  const atts = (m.attachments ?? []).map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString("base64"), type: a.type ?? "text/csv" }));
  switch (row.provider) {
    case "smtp": {
      try {
        const r = await smtpSend({ host: s.host, port: Number(s.port), security: (s.security as SmtpConfig["security"]) ?? "starttls", user: s.user || undefined, password: sec.password },
          { from: from.address, to: m.to, data: buildMime(from, m) }, env);
        return r.id;
      } catch (e) { if (e instanceof SmtpError) throw new ConnectionError(e.message); throw e; }
    }
    case "sendgrid": {
      need(sec.apiKey, "the SendGrid API key is not saved");
      const r = await http("https://api.sendgrid.com/v3/mail/send", { method: "POST", headers: { authorization: `Bearer ${sec.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ personalizations: [{ to: m.to.map((email) => ({ email })) }], from: { email: from.address, name: from.name }, subject: m.subject,
          content: [{ type: "text/plain", value: m.text }], ...(atts.length ? { attachments: atts.map((a) => ({ content: a.content, filename: a.filename, type: a.type })) } : {}) }) }, "SendGrid");
      return r.headers.get("x-message-id");
    }
    case "postmark": {
      need(sec.serverToken, "the Postmark server token is not saved");
      const r = await http("https://api.postmarkapp.com/email", { method: "POST", headers: { "x-postmark-server-token": sec.serverToken, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ From: `${displayName(from.name)} <${from.address}>`, To: m.to.join(","), Subject: m.subject, TextBody: m.text,
          ...(atts.length ? { Attachments: atts.map((a) => ({ Name: a.filename, Content: a.content, ContentType: a.type })) } : {}) }) }, "Postmark");
      return String(json(r.text).MessageID ?? "") || null;
    }
    case "mailgun": {
      need(sec.apiKey, "the Mailgun API key is not saved");
      const base = s.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
      need(/^[a-z0-9.-]+$/i.test(s.domain ?? ""), "the Mailgun sending domain is not a domain");
      const form = new URLSearchParams({ from: `${displayName(from.name)} <${from.address}>`, to: m.to.join(","), subject: m.subject, text: m.text });
      const r = await http(`${base}/v3/${s.domain}/messages`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`api:${sec.apiKey}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body: form.toString() }, "Mailgun");
      return String(json(r.text).id ?? "") || null;
    }
    case "resend": {
      need(sec.apiKey, "the Resend API key is not saved");
      const r = await http("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${sec.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: `${displayName(from.name)} <${from.address}>`, to: m.to, subject: m.subject, text: m.text,
          ...(atts.length ? { attachments: atts.map((a) => ({ filename: a.filename, content: a.content })) } : {}) }) }, "Resend");
      return String(json(r.text).id ?? "") || null;
    }
  }
  throw new ConnectionError(`${row.provider} is not an email provider`);
}

async function sendSmsVia(row: Row, sec: Record<string, string>, to: string, body: string, env: MsgEnv): Promise<string | null> {
  const s = row.settings as Record<string, string>;
  const num = to.replace(/[\s().-]/g, "");
  need(PHONE.test(num), `${to} is not a phone number`);
  const e164 = num.startsWith("+") ? num : num.length === 10 ? `+1${num}` : `+${num}`;
  const go = async (url: string, init: { method: string; headers: Record<string, string>; body: string }, what: string) => {
    let r;
    try { r = await call(env, url, init, 15000, what, 1); }
    catch (e) { if (e instanceof FeedError) throw new ConnectionError(e.message); throw e; }
    if (r.status < 200 || r.status >= 300) throw new ConnectionError(`${what} ${r.status === 401 || r.status === 403 ? "did not accept the key" : `answered ${r.status}`}${r.text ? `: ${r.text.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
    try { return JSON.parse(r.text) as Record<string, unknown>; } catch { return {}; }
  };
  if (row.provider === "twilio") {
    need(/^AC[0-9a-f]{32}$/i.test(s.accountSid ?? ""), "the Twilio account SID starts AC and has 32 letters and digits after it");
    need(sec.authToken, "the Twilio auth token is not saved");
    const j = await go(`https://api.twilio.com/2010-04-01/Accounts/${s.accountSid}/Messages.json`, { method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${s.accountSid}:${sec.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: e164, From: s.fromNumber, Body: body }).toString() }, "Twilio");
    return String(j.sid ?? "") || null;
  }
  if (row.provider === "https") {
    need(sec.authToken, "the provider's key is not saved");
    const header = (s.headerName || "authorization").toLowerCase();
    need(/^[a-z0-9-]{1,60}$/.test(header), "the key header is a header name, like Authorization or X-Api-Key");
    const j = await go(s.url, { method: "POST", headers: { [header]: header === "authorization" ? `Bearer ${sec.authToken}` : sec.authToken, "content-type": "application/json" },
      body: JSON.stringify({ to: e164, from: s.fromNumber || null, body }) }, "The text provider");
    return String(j[s.idField || "id"] ?? "") || null;
  }
  throw new ConnectionError(`${row.provider} is not a text provider`);
}

async function mark(c: Client, row: Row, ok: boolean, error: string | null) {
  await c.query(`update admin_connection set status = $3, last_error = $4, last_tested_at = now(), last_ok_at = case when $3 = 'connected' then now() else last_ok_at end
                  where id = $1 and tenant_id = $2 and active`, [row.id, row.tenant_id, ok ? "connected" : "failing", error]);
}

export type Outbound = { purpose: string; redact?: string[]; resendable?: boolean; sourceTable?: string; sourceId?: string | null; createdBy?: string | null; resendOf?: string | null };
export type SendResult = { id: string; status: "sent" | "failed" | "logged" | "queued"; providerRef: string | null; error: string | null; provider: string };

function redactBody(text: string, redact: string[] = []) {
  let out = text;
  for (const r of redact.filter(Boolean)) out = out.split(r).join("******");
  return out;
}

async function logRow(c: Client, entityId: string, channel: "email" | "sms" | "webhook", to: string, subject: string | null, body: string, o: Outbound,
  row: Row | null, status: SendResult["status"], ref: string | null, error: string | null): Promise<SendResult> {
  const redacted = !!o.redact?.length;
  const provider = row?.provider ?? "none";
  const r = await one<{ id: string }>(c, `insert into outbound_message (entity_id, channel, purpose, to_addr, subject, body, redacted, resendable, connection_id,
       provider, status, provider_ref, error, source_table, source_id, resend_of, created_by, sent_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, case when $11 = 'sent' then now() end) returning id`,
    [entityId, channel, o.purpose, to.slice(0, 300), subject?.slice(0, 300) ?? null, redactBody(body, o.redact).slice(0, 4000), redacted, !redacted && o.resendable !== false,
     row?.id ?? null, provider, status, ref, error?.slice(0, 500) ?? null, o.sourceTable ?? null, o.sourceId ?? null, o.resendOf ?? null, o.createdBy ?? null]);
  return { id: r.id, status, providerRef: ref, error, provider };
}

/** Is a channel connected for this company (its own row or the client's)? */
export async function isConnected(c: Client, entityId: string, kind: "email" | "sms" = "email") {
  return !!(await connectionFor(c, entityId, kind));
}

/**
 * Send an email through the company's connection and log it. With no email
 * connected it is logged, not sent (status 'logged'). A failure is logged and
 * returned, never thrown, so the log keeps it.
 */
export async function sendEmail(c: Client, entityId: string, m: Email, o: Outbound, env: MsgEnv = msgEnv(), via?: Row | null): Promise<SendResult> {
  const row = via !== undefined ? via : await connectionFor(c, entityId, "email");
  const to = m.to.join(", ");
  if (!row) return logRow(c, entityId, "email", to, m.subject, m.text, o, null, "logged", null, "no email is connected, so this was logged and not sent");
  try {
    const ref = await sendEmailVia(row, await secretsOf(c, row, env), m, env);
    await mark(c, row, true, null);
    return logRow(c, entityId, "email", to, m.subject, m.text, { ...o, resendable: o.resendable !== false && !m.attachments?.length }, row, "sent", ref, null);
  } catch (e) {
    if (!(e instanceof ConnectionError)) throw e;
    await mark(c, row, false, e.message);
    return logRow(c, entityId, "email", to, m.subject, m.text, o, row, "failed", null, e.message);
  }
}

export async function sendSms(c: Client, entityId: string, to: string, body: string, o: Outbound, env: MsgEnv = msgEnv(), via?: Row | null): Promise<SendResult> {
  const row = via !== undefined ? via : await connectionFor(c, entityId, "sms");
  if (!row) return logRow(c, entityId, "sms", to, null, body, o, null, "logged", null, "no text provider is connected, so this was logged and not sent");
  try {
    const ref = await sendSmsVia(row, await secretsOf(c, row, env), to, body, env);
    await mark(c, row, true, null);
    return logRow(c, entityId, "sms", to, null, body, o, row, "sent", ref, null);
  } catch (e) {
    if (!(e instanceof ConnectionError)) throw e;
    await mark(c, row, false, e.message);
    return logRow(c, entityId, "sms", to, null, body, o, row, "failed", null, e.message);
  }
}

/**
 * How a customer message goes: by text when the customer has a phone and a
 * text provider is connected, by email when they have an email and email is
 * connected; null when neither (the caller keeps its own log).
 */
export async function customerRoute(c: Client, entityId: string, phone: string | null, email: string | null): Promise<{ channel: "sms" | "email"; to: string; row: Row } | null> {
  if (phone) { const r = await connectionFor(c, entityId, "sms"); if (r) return { channel: "sms", to: phone, row: r }; }
  if (email) { const r = await connectionFor(c, entityId, "email"); if (r) return { channel: "email", to: email, row: r }; }
  return null;
}

/** A PO-style mailer (vendor_feeds Mail) through the company's email connection; null when none is connected. Throws on failure. */
export async function mailerFor(c: Client, entityId: string, purpose: string, env: MsgEnv = msgEnv()) {
  const row = await connectionFor(c, entityId, "email");
  if (!row) return null;
  return {
    async send(m: { to: string; subject: string; text: string; attachments: { filename: string; content: string }[] }) {
      const r = await sendEmail(c, entityId, { to: [m.to], subject: m.subject, text: m.text, attachments: m.attachments }, { purpose }, env, row);
      if (r.status !== "sent") {
        // A caller that rolls back to a savepoint would lose the log row and the Failing status; relog() writes them again.
        const err = new Error(r.error ?? "not sent") as Error & { relog?: (c2: Client) => Promise<void> };
        err.relog = async (c2) => {
          await mark(c2, row, false, r.error);
          await logRow(c2, entityId, "email", m.to, m.subject, m.text, { purpose }, row, "failed", null, r.error);
        };
        throw err;
      }
      return { id: r.providerRef ?? r.id };
    },
  };
}

// ================================================================== outbox
//
// A message a public page causes (a trade sign-in code, a web order's
// confirmation, a delivery text from a self-schedule link) is never sent
// inside the request's transaction: the row is queued there, and sent after
// the commit, in the background, so the answer never waits on (or times) the
// network. scripts/run-due.ts drains whatever a restart left behind. A code
// is kept only in this process's memory until it goes; the row has it as ******.

const PENDING = new Map<string, string>();
let inflight = 0;
const idlers: (() => void)[] = [];

/** Queue an email to go after this transaction commits. With none connected it is logged, not sent, at once. */
export async function queueEmail(c: Client, entityId: string, m: Email, o: Outbound): Promise<SendResult> {
  const row = await connectionFor(c, entityId, "email");
  if (!row) return logRow(c, entityId, "email", m.to.join(", "), m.subject, m.text, o, null, "logged", null, "no email is connected, so this was logged and not sent");
  const r = await logRow(c, entityId, "email", m.to.join(", "), m.subject, m.text, o, row, "queued", null, null);
  if (o.redact?.length) PENDING.set(r.id, m.text);
  afterCommit(c, () => drainQueued({ ids: [r.id] }));
  return r;
}

export async function queueSms(c: Client, entityId: string, to: string, body: string, o: Outbound, via?: Row | null): Promise<SendResult> {
  const row = via !== undefined ? via : await connectionFor(c, entityId, "sms");
  if (!row) return logRow(c, entityId, "sms", to, null, body, o, null, "logged", null, "no text provider is connected, so this was logged and not sent");
  const r = await logRow(c, entityId, "sms", to, null, body, o, row, "queued", null, null);
  if (o.redact?.length) PENDING.set(r.id, body);
  afterCommit(c, () => drainQueued({ ids: [r.id] }));
  return r;
}

/** Queue by the customer route (text, else email); the source row (customer_message) is updated when it goes. */
export async function queueTo(c: Client, entityId: string, route: { channel: "sms" | "email"; to: string; row: Row }, subject: string, body: string, o: Outbound) {
  if (route.channel === "sms") return queueSms(c, entityId, route.to, body, o, route.row);
  const r = await logRow(c, entityId, "email", route.to, subject, body, o, route.row, "queued", null, null);
  afterCommit(c, () => drainQueued({ ids: [r.id] }));
  return r;
}

type Claimed = { id: string; entity_id: string; channel: "email" | "sms" | "webhook"; to_addr: string; subject: string | null; body: string; redacted: boolean;
  connection_id: string | null; source_table: string | null; source_id: string | null };

/** Send what is queued: the given ids, or everything due (a restart's leftovers, from run-due). Network calls happen outside any transaction. */
export async function drainQueued(opts: { ids?: string[]; entityId?: string; limit?: number } = {}, env: MsgEnv = msgEnv()) {
  inflight++;
  let sent = 0, failed = 0;
  try {
    const claimed = await tx({ kind: "system", label: "outbox" }, (c) => q<Claimed>(c, `
      update outbound_message set status = 'sending', claimed_at = now(), attempts = attempts + 1
       where id in (select id from outbound_message
                     where (status = 'queued' or (status = 'sending' and claimed_at < now() - interval '10 minutes'))
                       and ($1::uuid[] is null or id = any($1)) and ($2::uuid is null or entity_id = $2)
                     order by created_at limit $3 for update skip locked)
      returning id, entity_id, channel, to_addr, subject, body, redacted, connection_id, source_table, source_id /* unscoped: the outbox, by id or all due */`,
      [opts.ids ?? null, opts.entityId ?? null, opts.limit ?? 200]));
    for (const m of claimed) (await sendClaimed(m, env)) ? sent++ : failed++;
  } finally {
    inflight--;
    if (!inflight) for (const f of idlers.splice(0)) f();
  }
  return { sent, failed };
}

async function sendClaimed(m: Claimed, env: MsgEnv): Promise<boolean> {
  let ref: string | null = null, error: string | null = null, row: Row | null = null;
  const body = m.redacted ? PENDING.get(m.id) : m.body;
  PENDING.delete(m.id);
  const c0 = await pool.connect();
  let sec: Record<string, string> = {};
  try {
    row = (await q<Row>(c0, `select ${COLS} from admin_connection where id = $1 and active /* unscoped: the connection the message was queued on */`, [m.connection_id]))[0] ?? null;
    if (row) sec = await secretsOf(c0, row, env);
  } catch (e) { error = (e as Error).message; }
  finally { c0.release(); }
  if (!error) {
    if (body === undefined) error = "the service restarted before this went out; it carried a sign-in code, so ask for a new one";
    else if (!row) error = "the connection was turned off before this went out";
    else {
      try {
        ref = m.channel === "sms" ? await sendSmsVia(row, sec, m.to_addr, body, env)
          : await sendEmailVia(row, sec, { to: m.to_addr.split(/,\s*/), subject: m.subject ?? "", text: body }, env);
      } catch (e) { if (!(e instanceof ConnectionError)) error = `could not send (${(e as Error).message})`; else error = e.message; }
    }
  }
  const ok = !error;
  await tx({ kind: "system", label: "outbox" }, async (c) => {
    await c.query(`update outbound_message set status = $3, provider_ref = $4, error = $5, sent_at = case when $3 = 'sent' then now() end where id = $1 and entity_id = $2`,
      [m.id, m.entity_id, ok ? "sent" : "failed", ref, error?.slice(0, 500) ?? null]);
    if (row) await mark(c, row, ok, error);
    if (m.source_table === "customer_message" && m.source_id) {
      await c.query(`update customer_message set status = $3, provider_ref = $4, error = $5, sent_at = case when $3 = 'sent' then now() end where id = $1 and entity_id = $2`,
        [m.source_id, m.entity_id, ok ? "sent" : "failed", ref, error?.slice(0, 300) ?? null]);
    }
  });
  return ok;
}

/** Resolves once every send started after a commit has finished (checks wait on it). */
export async function idle() {
  await new Promise((r) => setImmediate(r));
  while (inflight) await new Promise<void>((r) => idlers.push(r));
}

// =================================================================== tests

/** Test the connection saved at this place: an email or a text to who you type, a lookup, or a signed webhook. */
export async function testConnection(c: Client, place: Place, entityId: string, kindId: string, to: string, who: Actor, env: MsgEnv = msgEnv()) {
  const kind = kindById(kindId);
  need(kind && kind.test, "that connection has no test yet");
  const row = await rowAt(c, place.tenantId, place.entityId, kindId);
  need(row, `save the ${kind!.name.toLowerCase()} settings first`);
  const o: Outbound = { purpose: "test", createdBy: who.personId };
  if (kind!.test === "email") {
    const addr = clean(to, 200).toLowerCase();
    need(EMAIL.test(addr), "type the email address to send the test to");
    const r = await sendEmail(c, entityId, { to: [addr], subject: "Test from your ERP", text: `This is a test email sent by ${who.personName}.\r\nIf you can read it, email is connected.` }, o, env, row);
    return { ok: r.status === "sent", words: r.status === "sent" ? `Sent to ${addr}${r.providerRef ? ` (message ${r.providerRef})` : ""}.` : `Not sent: ${r.error}`, message: r };
  }
  if (kind!.test === "sms") {
    const r = await sendSms(c, entityId, clean(to, 30), `Test text from your ERP, sent by ${who.personName}.`, o, env, row);
    return { ok: r.status === "sent", words: r.status === "sent" ? `Text sent${r.providerRef ? ` (message ${r.providerRef})` : ""}.` : `Not sent: ${r.error}`, message: r };
  }
  if (kind!.test === "geocode") {
    try {
      const g = await geocoderFrom(c, row!, env);
      const hit = await g.locate(clean(to, 200) || "1600 Pennsylvania Ave NW, Washington, DC 20500");
      await mark(c, row!, true, null);
      return { ok: true, words: hit ? `Found ${hit.matched} at ${hit.lat.toFixed(5)}, ${hit.lng.toFixed(5)}.` : "The map service answered but found no such address." };
    } catch (e) {
      if (!(e instanceof GeocodeError || e instanceof ConnectionError)) throw e;
      await mark(c, row!, false, e.message);
      return { ok: false, words: `Not working: ${e.message}` };
    }
  }
  const r = await sendWebhook(c, entityId, row!, "test", { test: true, sentBy: who.personName }, env, o);
  return { ok: r.status === "sent", words: r.status === "sent" ? "The endpoint accepted the signed test." : `Not accepted: ${r.error}`, message: r };
}

// ================================================================ webhooks

/** X-ERP-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body"> */
export function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

async function sendWebhook(c: Client, entityId: string, row: Row, event: string, payload: unknown, env: MsgEnv, o: Outbound): Promise<SendResult> {
  const s = row.settings as Record<string, string>;
  const body = JSON.stringify({ event, at: new Date().toISOString(), data: payload });
  try {
    const sec = await secretsOf(c, row, env);
    need(sec.signingSecret, "the signing secret is not saved");
    let r;
    try { r = await call(env, s.url, { method: "POST", headers: { "content-type": "application/json", "x-erp-event": event, "x-erp-signature": signWebhook(sec.signingSecret, body) }, body }, 10000, "The endpoint", 1); }
    catch (e) { if (e instanceof FeedError) throw new ConnectionError(e.message); throw e; }
    need(r.status >= 200 && r.status < 300, `the endpoint answered ${r.status}`);
    await mark(c, row, true, null);
    return logRow(c, entityId, "webhook", s.url, event, body, { ...o, resendable: false }, row, "sent", null, null);
  } catch (e) {
    if (!(e instanceof ConnectionError)) throw e;
    await mark(c, row, false, e.message);
    return logRow(c, entityId, "webhook", s.url, event, body, { ...o, resendable: false }, row, "failed", null, e.message);
  }
}

// ================================================================== maps

async function geocoderFrom(c: Client, row: Row, env: MsgEnv): Promise<Geocoder> {
  const sec = await secretsOf(c, row, env);
  const get = async (url: string, what: string) => {
    let r;
    try { r = await call(env, url, { method: "GET", headers: { accept: "application/json" } }, 8000, what, 1); }
    catch (e) { if (e instanceof FeedError) throw new GeocodeError(e.message.replace(/^The /, "the ")); throw e; }
    if (r.status < 200 || r.status >= 300) throw new GeocodeError(`${what} answered ${r.status}`);
    try { return JSON.parse(r.text); } catch { throw new GeocodeError(`${what} sent something that is not JSON`); }
  };
  if (row.provider === "google") {
    need(sec.apiKey, "the Google Maps key is not saved");
    return { name: "other", async locate(line) {
      const j = await get(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(line)}&key=${encodeURIComponent(sec.apiKey)}`, "the Google map service");
      if (j.status === "REQUEST_DENIED") throw new GeocodeError("Google did not accept the key");
      const g = j.results?.[0]; if (!g) return null;
      return { lat: Number(g.geometry.location.lat), lng: Number(g.geometry.location.lng), matched: String(g.formatted_address ?? line) };
    } };
  }
  if (row.provider === "mapbox") {
    need(sec.accessToken, "the Mapbox token is not saved");
    return { name: "other", async locate(line) {
      const j = await get(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(line)}.json?limit=1&country=us&access_token=${encodeURIComponent(sec.accessToken)}`, "the Mapbox map service");
      const f = j.features?.[0]; if (!f) return null;
      return { lng: Number(f.center[0]), lat: Number(f.center[1]), matched: String(f.place_name ?? line) };
    } };
  }
  return censusGeocoder();
}

// The routing geocoder uses a company's Google or Mapbox connection when it has one; Census otherwise.
setGeocoderFor(async (c, entityId) => {
  const row = await connectionFor(c, entityId, "maps");
  if (!row || row.provider === "census") return null;
  return geocoderFrom(c, row, msgEnv());
});

// ============================================================ message log

/** What the web store and marketing send: all the web admin sees in the log. */
export const WEB_PURPOSES = ["trade_code", "web_order", "campaign"];
export async function messageLog(c: Client, entityId: string, limit = 100, purposes: string[] | null = null) {
  return q(c, `select id, channel, purpose, to_addr, subject, body, redacted, resendable, provider, status, provider_ref, error, created_at, sent_at, resend_of
                 from outbound_message where entity_id = $1 and ($3::text[] is null or purpose = any($3)) order by created_at desc limit $2`,
    [entityId, Math.min(500, Math.max(1, limit)), purposes]);
}

/** Send a logged message again (never one that carried a code, an attachment or a webhook). */
export async function resend(c: Client, entityId: string, id: string, who: Actor, env: MsgEnv = msgEnv()) {
  const m = (await q<{ channel: string; purpose: string; to_addr: string; subject: string | null; body: string; resendable: boolean; status: string }>(c,
    `select channel, purpose, to_addr, subject, body, resendable, status from outbound_message where entity_id = $1 and id = $2`, [entityId, id]))[0];
  need(m, "there is no such message");
  need(m.resendable, "this message cannot be sent again from here: it carried a sign-in code or an attachment; send it again from where it started");
  const o: Outbound = { purpose: m.purpose, createdBy: who.personId, resendOf: id };
  if (m.channel === "email") return sendEmail(c, entityId, { to: m.to_addr.split(/,\s*/), subject: m.subject ?? "", text: m.body }, o, env);
  if (m.channel === "sms") return sendSms(c, entityId, m.to_addr, m.body, o, env);
  throw new ConnectionError("only emails and texts are sent again");
}
