// Vendor files: what a vendor leaves on its SFTP server, answers from one
// HTTPS address, or emails -- catalogs, prices, inventory and EDI documents.
//
// A connection (source vendor_files) belongs to one company and one of its
// vendors, and says what it carries: one or more kinds, each picked out by a
// file-name pattern (an X12 file is known by its content and goes to EDI when
// the connection carries EDI). A zip is opened and each file in it routed the
// same way. Each kind goes through the path that kind already has:
//
//   catalog   -> the vendor feeds' product import (cost via the price history)
//   prices    -> the vendor's price history (recordVendorPrices)
//   inventory -> vendor availability (recordAvailability)
//   edi       -> Vendor EDI's receiveFile (its own inbox, 997s and quarantine)
//
// A file is applied whole or not at all (a savepoint); a file that cannot be
// read or applied is quarantined with the reason, by the pipeline.
//
// Email: each company has its own address, <local>+<key>@<domain> of
// ERP_INBOUND_EMAIL_ADDRESS. Mail to it is matched to a vendor connection by
// the sender (an address or @domain on the connection's list). Mail from
// anyone else, mail matching two vendors, and mail whose sender's domain did
// not vouch for it (SPF fail, DMARC fail) is held: nothing from it is read
// until a person assigns it to a vendor or sets it aside.

import { randomBytes } from "node:crypto";
import { q, one, audit, tx, type Client, type Scope } from "./db.ts";
import {
  registerHandler, ingest, loadConnection, senderAllowed, sha256, releaseQuarantine, setConnectionSecrets, connectionSecretNames,
  loadPin, testSftp, trustOfferedKey, connectionCredentials, netEnv, maxBytesOf, SEALED,
  type Connection, type Offered, type Parsed, type SftpTestResult, type RunResult,
} from "./connections.ts";
import { httpGet, sftpPort, TransportError, DEFAULT_MAX_MB, MAX_MB, type HttpAuth } from "./transports.ts";
import { unzip, isZip, isXlsx, xlsxRows, FileError } from "./filekit.ts";
import {
  mapFields, missingFor, unwrapRecords, flatten, applyCatalogRows, recordVendorPrices, recordAvailability, FeedError,
} from "./vendor_feeds.ts";
import { parseCsv, CatalogError } from "./catalog.ts";
import * as x12 from "./x12.ts";

export class VendorFilesError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new VendorFilesError(msg); };

export const KINDS = ["catalog", "prices", "inventory", "edi"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_WORDS: Record<Kind, string> = { catalog: "Catalog", prices: "Prices", inventory: "Inventory", edi: "EDI documents" };
const PURPOSE: Record<Exclude<Kind, "edi">, string> = { catalog: "products", prices: "pricing", inventory: "quantities" };
export const CHANNELS = ["sftp", "api", "email"] as const;
export const AFTER = ["leave", "move", "delete"] as const;
export type Carry = { kind: Kind; glob: string };

/** Files worth reading in an email; anything else (logos, signatures, PDFs) is left out and named. */
const DATA_EXT = /\.(csv|tsv|txt|xlsx|json|x12|edi|dat|zip|850|810|855|856|832|846|997)$/i;
const DATA_TYPE = /^(text\/csv|text\/plain|application\/(json|zip|x-zip-compressed|edi-x12|edifact|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet))/i;
export const isDataAttachment = (name: string, type?: string) => DATA_EXT.test(name) || DATA_TYPE.test(type ?? "");

const REFUSED = [VendorFilesError, FeedError, CatalogError, FileError, x12.X12Error, TransportError];
const plainError = (e: unknown) => (REFUSED.some((K) => e instanceof K) || (e as Error)?.constructor?.name?.endsWith("Error")) ? (e as Error).message : String(e);

// ------------------------------------------------------------- reading --

export const carriesOf = (conn: Pick<Connection, "config">): Carry[] =>
  (Array.isArray(conn.config.carries) ? conn.config.carries as Carry[] : []).filter((x) => KINDS.includes(x?.kind));

const globRx = (g: string) => new RegExp("^" + g.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
const looksX12 = (b: Buffer) => /^﻿?\s*ISA/.test(b.subarray(0, 120).toString("latin1"));

/** Which kind a file is: X12 content to EDI (when carried), else the first carried kind whose pattern matches. */
export function kindFor(name: string, bytes: Buffer, carries: Carry[], fallback: Kind | null = null): Kind | null {
  if (looksX12(bytes) && carries.some((x) => x.kind === "edi")) return "edi";
  for (const x of carries) {
    if (x.kind === "edi") continue;
    if (!x.glob?.trim() || globRx(x.glob).test(name)) return x.kind;
  }
  if (carries.some((x) => x.kind === "edi") && /\.(x12|edi|8\d\d|997)$/i.test(name)) return "edi";
  return fallback;
}

/** Rows of a CSV, an .xlsx or a JSON answer, keyed by the heading line. */
export function tableOf(name: string, bytes: Buffer): Record<string, string>[] {
  if (isXlsx(bytes)) {
    const rows = xlsxRows(bytes, name).filter((r) => r.some((v) => String(v ?? "").trim()));
    need(rows.length >= 2, `${name} has no rows under its heading line`);
    const heads = rows[0].map((h) => String(h ?? "").trim());
    return rows.slice(1).map((r) => Object.fromEntries(heads.map((h, i) => [h, String(r[i] ?? "").trim()]).filter(([h]) => h)));
  }
  need(!isZip(bytes), `${name} is a zip inside a zip; send the files themselves`);
  const text = bytes.toString("utf8").replace(/^﻿/, "");
  need(!/\u0000/.test(text.slice(0, 4000)), `${name} is not a text file, a workbook or a zip`);
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    let j: unknown;
    try { j = JSON.parse(t); } catch { throw new VendorFilesError(`${name} looks like JSON but does not read as JSON`); }
    const recs = unwrapRecords(j);
    need(recs && recs.length, `${name} holds no list of records`);
    return recs!.map(flatten);
  }
  const delim = /\.tsv$/i.test(name) || (t.split("\n")[0].includes("\t") && !t.split("\n")[0].includes(",")) ? "\t" : ",";
  const grid = delim === "\t" ? t.split(/\r?\n/).map((l) => l.split("\t")) : parseCsv(t);
  const rows = grid.filter((r) => r.some((v) => String(v ?? "").trim()));
  need(rows.length >= 2, `${name} has no rows under its heading line`);
  need(rows.length <= 50001, `${name} has more than 50,000 rows; ask the vendor to split it`);
  const heads = rows[0].map((h) => String(h ?? "").trim());
  return rows.slice(1).map((r) => Object.fromEntries(heads.map((h, i) => [h, String(r[i] ?? "").trim()]).filter(([h]) => h)));
}

type Part =
  | { kind: "edi"; name: string; text: string; types: string[] }
  | { kind: Exclude<Kind, "edi">; name: string; rows: Record<string, string>[]; mapping: Record<string, string>; heads: string[] };

/** One file (or each file in a zip) routed and read; refuses in words, so the pipeline quarantines it with the reason. */
export function readFile(conn: Connection, name: string, bytes: Buffer): { parts: Part[]; skipped: string[] } {
  const carries = carriesOf(conn);
  need(carries.length, `${conn.name} does not say what it carries; edit it and pick catalog, prices, inventory or EDI documents`);
  need(bytes.length, `${name} is empty`);
  const single = conn.channel === "api" ? carries[0].kind : null;
  const outer = kindFor(name, bytes, carries, single);
  const files = isZip(bytes) && !isXlsx(bytes) ? unzip(bytes, name) : [{ name, bytes }];
  need(files.length, `${name} is an empty zip`);
  const parts: Part[] = [], skipped: string[] = [];
  for (const f of files) {
    const kind = files.length === 1 && f.name === name ? (outer ?? single) : (kindFor(f.name, f.bytes, carries, outer ?? single));
    if (!kind) { skipped.push(f.name); continue; }
    if (kind === "edi") {
      const text = f.bytes.toString("latin1");
      need(looksX12(f.bytes), `${f.name} was taken as EDI but is not an X12 interchange (it does not start with ISA)`);
      try { x12.parseInterchange(text); } catch (e) { throw new VendorFilesError(`${f.name}: ${(e as Error).message}`); }
      const types = [...new Set(x12.parseInterchange(text).groups.flatMap((g) => g.sets.map((s) => s.type)))];
      parts.push({ kind, name: f.name, text, types });
      continue;
    }
    need(!looksX12(f.bytes), `${f.name} is an X12 file, but ${conn.name} does not carry EDI documents; add EDI documents to what it carries`);
    const rows = tableOf(f.name, f.bytes);
    const heads = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const saved = ((conn.config.mapping ?? {}) as Record<string, Record<string, string>>)[kind] ?? {};
    const mapping = mapFields(PURPOSE[kind], heads, saved);
    const missing = missingFor(PURPOSE[kind], mapping, { costOptional: kind === "catalog" });
    need(!missing.length, `${f.name} (${KIND_WORDS[kind].toLowerCase()}): no column found for ${missing.join(", ").replace(/_/g, " ")}; its columns are ${heads.slice(0, 12).join(", ")}${heads.length > 12 ? "…" : ""}`);
    parts.push({ kind, name: f.name, rows, mapping, heads });
  }
  need(parts.length, `${name} matches none of what ${conn.name} carries (${carries.map((x) => `${KIND_WORDS[x.kind].toLowerCase()}${x.glob ? ` ${x.glob}` : ""}`).join(", ")})`);
  return { parts, skipped };
}

const mapRows = (rows: Record<string, string>[], mapping: Record<string, string>) =>
  rows.map((r) => Object.fromEntries(Object.entries(mapping).map(([ours, theirs]) => [ours, String(r[theirs] ?? "").trim()])));

async function applyParts(c: Client, s: Scope, conn: Connection, parts: Part[], skipped: string[]): Promise<{ applied: number; note: string }> {
  const vendorId = (conn as Connection & { vendor_id?: string }).vendor_id ?? (await one<{ vendor_id: string }>(c,
    `select vendor_id from connection where id = $1 and entity_id = $2`, [conn.id, s.entityId])).vendor_id;
  let applied = 0;
  const notes: string[] = [];
  for (const p of parts) {
    if (p.kind === "catalog") {
      const r = await applyCatalogRows(c, s, vendorId, `${p.name} (${conn.name})`, p.rows, p.mapping);
      let priced = "";
      const pm = mapFields("pricing", p.heads);
      if (p.mapping.cost && pm.vendor_sku && pm.cost) {
        const pr = await recordVendorPrices(c, s, vendorId, null, mapRows(p.rows, pm));
        priced = `; ${pr.recorded} new prices, ${pr.changed} products repriced`;
      }
      applied += r.added + r.changed;
      notes.push(`${p.name}: ${p.rows.length} products, ${r.added} added, ${r.changed} changed, ${r.same} unchanged${r.skipped ? `, ${r.skipped} skipped` : ""}${priced}`);
    } else if (p.kind === "prices") {
      const r = await recordVendorPrices(c, s, vendorId, null, mapRows(p.rows, p.mapping));
      applied += r.recorded;
      notes.push(`${p.name}: ${p.rows.length} prices, ${r.recorded} new in the history, ${r.changed} products repriced${r.unknown ? `, ${r.unknown} for models not in the catalog yet` : ""}${r.bad ? `, ${r.bad} unreadable rows skipped` : ""}`);
    } else if (p.kind === "inventory") {
      const n = await recordAvailability(c, s, vendorId, mapRows(p.rows, p.mapping));
      applied += n;
      notes.push(`${p.name}: availability for ${n} models`);
    } else {
      const { partnerForVendor, receiveFile, liveEdiEnv } = await import("./edi.ts");
      const partner = await partnerForVendor(c, s.entityId, vendorId);
      need(partner, `${p.name} is EDI, but this vendor is not set up as a trading partner; set it up under Setup, Vendor EDI, then release this file`);
      const r = await receiveFile(c, s, liveEdiEnv(), { text: p.text, filename: p.name, partnerId: partner!.id });
      const ok = r.documents.filter((d) => d.status === "applied").length;
      const held = r.documents.filter((d) => d.status === "quarantined").length;
      const same = r.documents.filter((d) => d.status === "ignored").length;
      applied += ok;
      notes.push(`${p.name}: ${r.documents.length} EDI ${r.documents.length === 1 ? "document" : "documents"} (${p.types.join(", ")}): ${ok} applied${held ? `, ${held} held in Vendor EDI's inbox` : ""}${same ? `, ${same} seen before` : ""}`);
    }
  }
  if (skipped.length) notes.push(`left out (no pattern matched): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}`);
  return { applied, note: notes.join(" · ").slice(0, 2000) };
}

registerHandler({
  source: "vendor_files",
  parse(bytes, conn, arrival): Parsed {
    const r = readFile(conn, arrival.origin.split(" @ ")[0].split("/").pop() || "file", bytes);
    return { rows: r.parts as unknown[], format: [...new Set(r.parts.map((p) => p.kind))].join("+"), note: JSON.stringify(r.skipped) };
  },
  async apply(c, s, parsed, fileId, conn) {
    await c.query("savepoint vendor_file");
    try {
      const r = await applyParts(c, s, conn, parsed.rows as Part[], JSON.parse(parsed.note ?? "[]") as string[]);
      await c.query("release savepoint vendor_file");
      await q(c, `update inbound_file set note = $2 where id = $1 /* unscoped: file id is unique */`, [fileId, r.note]);
      return r.applied;
    } catch (e) {
      await c.query("rollback to savepoint vendor_file");
      throw new VendorFilesError(plainError(e));
    }
  },
});

// --------------------------------------------------------- connections --

export type Draft = {
  id?: string | null; vendor_id: string; name: string; channel: string; carries: Carry[];
  schedule?: string | null;
  host?: string; port?: string | number; user?: string; path?: string; after?: string; moveTo?: string; maxMb?: number | string;
  endpoint?: string; auth?: string; headerName?: string; query?: Record<string, string>;
  senders?: string[] | string;
  mapping?: Record<string, Record<string, string>>;
};
const CRON = /^(\S+\s+){4}\S+$/;
const GLOB = /^[A-Za-z0-9 ._*?()\[\]+-]{1,80}$/;
const SENDER = /^(@[a-z0-9.-]+\.[a-z]{2,}|[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,})$/i;

export function cleanDraft(d: Draft) {
  const channel = String(d.channel ?? "");
  need((CHANNELS as readonly string[]).includes(channel), "files come by SFTP, an HTTPS address, or email");
  const name = String(d.name ?? "").trim().slice(0, 120);
  need(name, "give the connection a name, like Coaster SFTP");
  const seen = new Set<string>();
  const carries: Carry[] = [];
  for (const x of Array.isArray(d.carries) ? d.carries : []) {
    const kind = String(x?.kind ?? "") as Kind;
    need(KINDS.includes(kind), "a connection carries catalog, prices, inventory or EDI documents");
    need(!seen.has(kind), `${KIND_WORDS[kind]} is listed twice`);
    seen.add(kind);
    const glob = String(x?.glob ?? "").trim();
    need(!glob || GLOB.test(glob), `the pattern for ${KIND_WORDS[kind].toLowerCase()} uses letters, digits, * and ? (like price*.csv)`);
    carries.push({ kind, glob });
  }
  need(carries.length, "pick what this connection carries: catalog, prices, inventory or EDI documents");
  if (channel === "api") need(carries.length === 1, "an HTTPS address answers with one kind of file; add another connection for the next");
  const nonEdi = carries.filter((x) => x.kind !== "edi");
  if (nonEdi.length > 1) need(nonEdi.every((x) => x.glob && x.glob !== "*"), "with more than one kind of file, give each its own file pattern (like *catalog*.csv and *price*.csv), so each file goes to the right place");
  const config: Record<string, unknown> = { carries };
  let schedule: string | null = null, senders: string[] | null = null;
  if (channel === "sftp" || channel === "api") {
    schedule = String(d.schedule ?? "").trim() || null;
    need(schedule && CRON.test(schedule), "pick how often to look (a schedule of five cron fields, like 0 6 * * *)");
  }
  if (channel === "sftp") {
    const host = String(d.host ?? "").trim().toLowerCase();
    need(host && /^[a-z0-9.:_-]{1,200}$/.test(host), "the SFTP host is a name like sftp.vendor.com");
    const port = sftpPort(d.port);
    const user = String(d.user ?? "").trim();
    need(user && user.length <= 100, "SFTP needs the user name");
    const path = String(d.path ?? "").trim() || ".";
    need(path.length <= 300 && !/[\u0000-\u001f]/.test(path), "the folder is a path like /outbound");
    const after = String(d.after ?? "leave");
    need((AFTER as readonly string[]).includes(after), "after taking a file: leave it, move it, or delete it");
    const moveTo = String(d.moveTo ?? "").trim();
    if (after === "move") need(moveTo && moveTo !== path && moveTo.length <= 300, "say which folder to move taken files to (not the folder read from)");
    const mb = d.maxMb == null || d.maxMb === "" ? DEFAULT_MAX_MB : Number(d.maxMb);
    need(Number.isFinite(mb) && mb >= 1 && mb <= MAX_MB, `the largest file is 1 to ${MAX_MB} MB`);
    Object.assign(config, { host, port, user, path, globs: carries.map((x) => x.glob).filter(Boolean).length === carries.length ? carries.map((x) => x.glob) : [], after, moveTo: after === "move" ? moveTo : "", maxMb: mb });
  }
  if (channel === "api") {
    const endpoint = String(d.endpoint ?? "").trim();
    need(/^https:\/\/[^\s/]+/i.test(endpoint) && endpoint.length <= 500, "the address starts with https://");
    const u = new URL(endpoint);
    for (const k of u.searchParams.keys()) need(!/key|token|secret|pass|sig/i.test(k), `the address carries ${k}, which looks like a secret; choose a key header or bearer token and type it into the secret box`);
    const auth = String(d.auth ?? "none");
    need(["none", "basic", "bearer", "header"].includes(auth), "authentication is none, basic (user and password), a bearer token, or a key header");
    const user = String(d.user ?? "").trim();
    if (auth === "basic") need(user, "basic authentication needs the user name");
    const headerName = String(d.headerName ?? "").trim();
    if (auth === "header") need(/^[A-Za-z0-9-]{1,60}$/.test(headerName || "x-api-key"), "the key header's name is letters, digits and dashes");
    Object.assign(config, { endpoint, auth, user: auth === "basic" ? user : "", headerName: auth === "header" ? headerName || "x-api-key" : "", format: "auto" });
  }
  if (channel === "email") {
    const raw = Array.isArray(d.senders) ? d.senders : String(d.senders ?? "").split(/[\s,;]+/);
    senders = [...new Set(raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
    need(senders.length, "list who sends these files: an address, or @vendor.com for anyone there");
    for (const x of senders) need(SENDER.test(x), `${x} is not an email address or an @domain`);
    need(senders.length <= 30, "list at most 30 senders");
    config.inbox = "company";
  }
  if (d.mapping && typeof d.mapping === "object") {
    const m: Record<string, Record<string, string>> = {};
    for (const [k, v] of Object.entries(d.mapping)) {
      if (!KINDS.includes(k as Kind) || k === "edi" || !v || typeof v !== "object") continue;
      m[k] = Object.fromEntries(Object.entries(v).filter(([a, b]) => /^[a-z_]{1,30}$/.test(a) && typeof b === "string" && b.trim()).map(([a, b]) => [a, String(b).trim().slice(0, 120)]));
    }
    config.mapping = m;
  }
  return { channel, name, config, schedule, senders };
}

/** Save a vendor-file connection (new or changed) and any typed secrets. The channel of a saved one stays; add another for another channel. */
export async function saveConnection(c: Client, s: Scope, d: Draft, secrets: Record<string, string | null>, key: Buffer | null): Promise<string> {
  const vendorId = String(d.vendor_id ?? "");
  const v = (await q<{ name: string }>(c, `select coalesce(v.dba, v.legal_name) as name from vendor_entity ve join vendor v on v.id = ve.vendor_id
     where ve.entity_id = $1 and ve.vendor_id = $2 and ve.status = 'active'`, [s.entityId, vendorId]))[0];
  need(v, "that vendor is not set up for this company");
  const x = cleanDraft(d);
  let id = d.id ?? null;
  if (id) {
    const cur = (await q<{ channel: string; source_code: string }>(c, `select channel, source_code from connection where id = $1 and entity_id = $2`, [id, s.entityId]))[0];
    need(cur && cur.source_code === "vendor_files", "no such vendor connection");
    need(cur!.channel === x.channel, "a connection keeps its channel; add a new one for SFTP, HTTPS or email");
    const dup = await q(c, `select 1 from connection where entity_id = $1 and source_code = 'vendor_files' and channel = $2 and name = $3 and id <> $4`, [s.entityId, x.channel, x.name, id]);
    need(!dup.length, `there is already a connection called ${x.name}`);
    const before = await one<{ config: unknown; allowed_senders: unknown }>(c, `select config, allowed_senders from connection where id = $1 and entity_id = $2`, [id, s.entityId]);
    await c.query(`update connection set name = $3, vendor_id = $4, config = $5, schedule_cron = $6, allowed_senders = $7 where id = $1 and entity_id = $2`,
      [id, s.entityId, x.name, vendorId, JSON.stringify(x.config), x.schedule, x.senders]);
    await audit(c, s, { table: "connection", rowId: id, action: "update", before, after: { vendor: v!.name, name: x.name, config: x.config, schedule: x.schedule, senders: x.senders } });
  } else {
    const dup = await q(c, `select 1 from connection where entity_id = $1 and source_code = 'vendor_files' and channel = $2 and name = $3`, [s.entityId, x.channel, x.name]);
    need(!dup.length, `there is already a connection called ${x.name}`);
    id = (await one<{ id: string }>(c, `
      insert into connection (tenant_id, entity_id, source_code, channel, name, vendor_id, config, credential_ref, schedule_cron, allowed_senders, status, created_by)
      values ($1,$2,'vendor_files',$3,$4,$5,$6,$7,$8,$9,'active',$10) returning id`,
      [s.tenantId, s.entityId, x.channel, x.name, vendorId, JSON.stringify(x.config), x.channel === "email" ? null : SEALED, x.schedule, x.senders, s.actor.id || null])).id;
    await audit(c, s, { table: "connection", rowId: id, action: "insert", after: { vendor: v!.name, name: x.name, channel: x.channel, config: x.config, schedule: x.schedule, senders: x.senders } });
  }
  const typed = Object.fromEntries(Object.entries(secrets ?? {}).filter(([, val]) => val === null || (typeof val === "string" && val)));
  if (Object.keys(typed).length) {
    need(x.channel !== "email", "an email connection has no password; the sender list is its lock");
    await setConnectionSecrets(c, s, id!, typed, key);
  }
  return id!;
}

/** On (active), paused, or retired. Nothing is deleted; a retired connection keeps its files and runs. */
export async function setStatus(c: Client, s: Scope, id: string, status: string) {
  need(["active", "paused", "retired"].includes(status), "a connection is on, paused, or retired");
  const r = await q<{ status: string }>(c, `select status from connection where id = $1 and entity_id = $2 and source_code = 'vendor_files'`, [id, s.entityId]);
  need(r.length, "no such vendor connection");
  await c.query(`update connection set status = $3, consecutive_failures = case when $3 = 'active' then 0 else consecutive_failures end where id = $1 and entity_id = $2`, [id, s.entityId, status]);
  await audit(c, s, { table: "connection", rowId: id, action: "transition", before: { status: r[0].status }, after: { status } });
  return { status };
}

async function vendorConn(c: Client, entityId: string, id: string): Promise<Connection & { vendor_id: string }> {
  const r = (await q<{ id: string }>(c, `select id from connection where id = $1 and entity_id = $2 and source_code = 'vendor_files'`, [id, entityId]))[0];
  need(r, "no such vendor connection");
  return await loadConnection(c, id) as Connection & { vendor_id: string };
}

export type TestResult = (SftpTestResult & { channel: "sftp" }) | { channel: "api"; ok: boolean; words: string; status: number | null; bytes: number; contentType: string | null; kind: string | null; rows: number | null }
  | { channel: "email"; ok: boolean; words: string; address: string | null };

/** Test: SFTP connects, lists and shows (and on the first good test records) the server's key; HTTPS makes one call and reads it; email says where to send. */
export async function testConnection(c: Client, s: Scope, id: string, who: string): Promise<TestResult> {
  const conn = await vendorConn(c, s.entityId, id);
  const cfg = conn.config as Record<string, unknown>;
  const env = await netEnv();
  if (conn.channel === "sftp") {
    const creds = await connectionCredentials(c, conn, env);
    const r = await testSftp(c, s, { kind: "connection", id: conn.id, tenantId: conn.tenant_id, entityId: s.entityId },
      { host: String(cfg.host), port: Number(cfg.port ?? 22), user: String(cfg.user ?? ""), password: creds.password, privateKey: creds.privateKey, passphrase: creds.passphrase },
      String(cfg.path ?? "."), (cfg.globs as string[] | undefined) ?? [], who);
    return { channel: "sftp", ...r };
  }
  if (conn.channel === "api") {
    try {
      const creds = await connectionCredentials(c, conn, env);
      const auth: HttpAuth = { mode: String(cfg.auth ?? "none") as HttpAuth["mode"], user: String(cfg.user ?? ""), headerName: String(cfg.headerName ?? "") };
      const r = await httpGet(env, String(cfg.endpoint), cfg.query as Record<string, string> | undefined, auth, creds);
      if (r.status >= 400) return { channel: "api", ok: false, words: `the address answered ${r.status}`, status: r.status, bytes: r.body.length, contentType: r.contentType ?? null, kind: null, rows: null };
      let rows: number | null = null, kind: string | null = null, words = "";
      try {
        const read = readFile(conn, "answer", r.body);
        kind = read.parts.map((p) => KIND_WORDS[p.kind]).join(", ");
        rows = read.parts.reduce((n, p) => n + (p.kind === "edi" ? 1 : p.rows.length), 0);
        words = `Answered ${r.status}: ${r.body.length} bytes, read as ${kind.toLowerCase()} (${rows} ${rows === 1 ? "row" : "rows"}). Nothing was changed.`;
      } catch (e) { words = `Answered ${r.status}, but it does not read yet: ${plainError(e)}`; }
      return { channel: "api", ok: !!kind, words, status: r.status, bytes: r.body.length, contentType: r.contentType ?? null, kind, rows };
    } catch (e) {
      if (e instanceof TransportError || e instanceof VendorFilesError || e instanceof FeedError) return { channel: "api", ok: false, words: e.message, status: null, bytes: 0, contentType: null, kind: null, rows: null };
      throw e;
    }
  }
  const box = await mailboxOf(c, s.entityId, s.tenantId);
  const address = inboundAddress(box);
  return { channel: "email", ok: !!address, address, words: address
    ? `Ask the vendor to send files to ${address}, or forward them there from your own mailbox. Mail from ${(conn.allowed_senders ?? []).join(", ")} goes to this connection; anyone else's is held.`
    : "Inbound email is not set up on this server yet (ERP_INBOUND_EMAIL_ADDRESS). The connection is saved; files will flow once it is." };
}

/** Run one pull now: the same ingest the scheduler runs. A failure is recorded on the connection and returned in words. */
export async function runNow(c: Client, s: Scope, id: string): Promise<{ ok: boolean; words: string; result: RunResult | null }> {
  const conn = await vendorConn(c, s.entityId, id);
  need(conn.channel === "sftp" || conn.channel === "api", "an email connection runs when mail arrives; there is nothing to pull");
  need(conn.status === "active", `${conn.name} is ${conn.status}; turn it on first`);
  await c.query("savepoint vendor_run");
  try {
    const r = await ingest(c, s, conn.id, { trigger: "manual" });
    await c.query("release savepoint vendor_run");
    return { ok: r.outcome !== "failed", result: r,
      words: `${r.fresh} new ${r.fresh === 1 ? "file" : "files"} of ${r.seen} looked at${r.failed ? `, ${r.failed} quarantined` : ""}.` };
  } catch (e) {
    await c.query("rollback to savepoint vendor_run");
    const msg = plainError(e).slice(0, 1000);
    await q(c, `insert into ingest_run (connection_id, trigger, actor_kind, ran_by, finished_at, outcome, error) values ($1,'manual',$2,$3,now(),'failed',$4)
                /* unscoped: keyed by connection, checked above */`, [conn.id, s.actor.kind, s.actor.id ?? null, msg]);
    await q(c, `update connection set last_attempt_at = now(), last_error = $2, consecutive_failures = consecutive_failures + 1,
                  status = case when consecutive_failures + 1 >= 5 then 'failed' else status end where id = $1 /* unscoped: checked above */`, [conn.id, msg]);
    return { ok: false, words: msg, result: null };
  }
}

export async function trustKey(c: Client, s: Scope, id: string, fingerprint: string, who: string) {
  await vendorConn(c, s.entityId, id);
  return trustOfferedKey(c, s, { kind: "connection", id, entityId: s.entityId }, fingerprint, who);
}

/** A person decides a quarantined file was not worth reading. It stays on record. */
export async function dismissFile(c: Client, s: Scope, fileId: string, reason: string) {
  need(reason.trim(), "say why, so the next person knows");
  const f = (await q<{ status: string }>(c, `select f.status from inbound_file f join connection cn on cn.id = f.connection_id
    where f.id = $1 and cn.entity_id = $2 and cn.source_code = 'vendor_files'`, [fileId, s.entityId]))[0];
  need(f, "no such file");
  need(f.status === "quarantined", "that file is not in quarantine any more");
  await releaseQuarantine(c, s, fileId, "ignored", reason.trim().slice(0, 500));
  return { ok: true };
}

// --------------------------------------------------------------- views --

export async function overview(c: Client, co: { id: string; tenantId: string }, create = true) {
  const connections = await q(c, `
    select c.id, c.name, c.channel, c.status, c.vendor_id, coalesce(v.dba, v.legal_name) vendor, c.config, c.schedule_cron, c.allowed_senders,
           c.last_attempt_at, c.last_success_at, c.last_error, c.consecutive_failures, h.verdict,
           (select count(*)::int from inbound_file f where f.connection_id = c.id) files,
           (select count(*)::int from inbound_file f where f.connection_id = c.id and f.status = 'quarantined') quarantined,
           (select max(f.received_at) from inbound_file f where f.connection_id = c.id) last_file_at,
           (select row_to_json(r) from (select r.started_at, r.finished_at, r.files_seen, r.files_new, r.files_failed, r.outcome, r.error, r.trigger
              from ingest_run r where r.connection_id = c.id order by r.started_at desc limit 1) r) last_run,
           (select json_agg(s.name order by s.name) from connection_secret s where s.connection_id = c.id) secrets,
           (select row_to_json(p) from (select p.fingerprint, p.key_type, p.host, p.port, p.pinned_at, p.pinned_by_name, p.offered_fingerprint, p.offered_at
              from sftp_host_pin p where p.owner_kind = 'connection' and p.owner_id = c.id and p.entity_id = c.entity_id) p) pin
      from connection c join connection_health h on h.connection_id = c.id join vendor v on v.id = c.vendor_id
     where c.entity_id = $1 and c.source_code = 'vendor_files'
     order by c.status = 'retired', 6, c.name`, [co.id]);
  const held = await heldMail(c, co.id);
  const vendors = await q(c, `select v.id, coalesce(v.dba, v.legal_name) name from vendor_entity ve join vendor v on v.id = ve.vendor_id
     where ve.entity_id = $1 and ve.status = 'active' order by 2`, [co.id]);
  const emailFeeds = await q(c, `select f.id, f.name, f.vendor_id, coalesce(v.dba, v.legal_name) vendor, f.options->>'fromContains' senders
     from vendor_feed f join vendor v on v.id = f.vendor_id where f.entity_id = $1 and f.kind = 'email' and f.active order by 4, 2`, [co.id]);
  const box = create ? await mailboxOf(c, co.id, co.tenantId)
    : (await q<{ mailbox_key: string }>(c, `select mailbox_key from inbound_mailbox where entity_id = $1 and vendor_id is null`, [co.id]))[0]?.mailbox_key ?? null;
  return { address: box ? inboundAddress(box) : null, emailFeeds, emailReady: !!(process.env.ERP_INBOUND_EMAIL_ADDRESS && process.env.ERP_EMAIL_INBOUND_TOKEN), connections, held, vendors,
    kinds: KINDS.map((k) => ({ id: k, name: KIND_WORDS[k] })) };
}

export async function detail(c: Client, entityId: string, id: string, status: string | null) {
  const conn = await vendorConn(c, entityId, id);
  const runs = await q(c, `select r.id, r.started_at, r.finished_at, r.trigger, r.files_seen, r.files_new, r.files_failed, r.outcome, r.error
     from ingest_run r join connection cn on cn.id = r.connection_id where r.connection_id = $1 and cn.entity_id = $2 order by r.started_at desc limit 30`, [id, entityId]);
  const files = await q(c, `select f.id, f.origin, f.received_at, f.byte_size, f.status, f.format, f.rows_parsed, f.note, f.quarantine_reason, f.run_id
     from inbound_file f join connection cn on cn.id = f.connection_id
    where f.connection_id = $1 and cn.entity_id = $2 and ($3::text is null or f.status = $3) order by f.received_at desc limit 200`, [id, entityId, status]);
  return { connection: { id: conn.id, name: conn.name, channel: conn.channel, status: conn.status, schedule_cron: conn.schedule_cron, config: conn.config, allowed_senders: conn.allowed_senders },
    secrets: await connectionSecretNames(c, entityId, id), pin: await loadPin(c, { kind: "connection", id, entityId }), runs, files };
}

// ---------------------------------------------------------------- email --

/** The mailbox key of the company's general vendor address, or of one vendor's own address; made on first use. */
export async function mailboxOf(c: Client, entityId: string, tenantId: string, vendorId: string | null = null): Promise<string> {
  const get = async () => (await q<{ mailbox_key: string }>(c, `select mailbox_key from inbound_mailbox where entity_id = $1 and vendor_id is not distinct from $2`, [entityId, vendorId]))[0];
  const r = await get();
  if (r) return r.mailbox_key;
  const key = randomBytes(16).toString("hex").slice(0, 20);
  await c.query(`insert into inbound_mailbox (entity_id, tenant_id, vendor_id, mailbox_key) values ($1,$2,$3,$4) on conflict do nothing`, [entityId, tenantId, vendorId, key]);
  return (await get())!.mailbox_key;
}

/** local+key@domain of ERP_INBOUND_EMAIL_ADDRESS; null while the server has none. */
export function inboundAddress(key: string, base = process.env.ERP_INBOUND_EMAIL_ADDRESS ?? ""): string | null {
  const m = /^\s*([^@\s+]+)(?:\+[^@\s]*)?@([^@\s]+)\s*$/.exec(base);
  return m ? `${m[1].toLowerCase()}+${key}@${m[2].toLowerCase()}` : null;
}

export type InboundMail = {
  From?: string; FromFull?: { Email?: string }; To?: string; OriginalRecipient?: string; MailboxHash?: string;
  ToFull?: { Email?: string; MailboxHash?: string }[]; CcFull?: { Email?: string; MailboxHash?: string }[];
  Subject?: string; MessageID?: string; Headers?: { Name: string; Value: string }[];
  Attachments?: { Name: string; Content: string; ContentType?: string; ContentLength?: number }[];
};

/** The mailbox key a message was sent to: Postmark's MailboxHash, else the +tag of any recipient. */
export function mailboxKeysOf(m: InboundMail): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { const k = String(v ?? "").trim().toLowerCase(); if (/^[a-z0-9]{12,32}$/.test(k) && !out.includes(k)) out.push(k); };
  add(m.MailboxHash);
  for (const r of [...(m.ToFull ?? []), ...(m.CcFull ?? [])]) { add(r.MailboxHash); add(/\+([^@]+)@/.exec(String(r.Email ?? ""))?.[1]); }
  for (const a of [m.OriginalRecipient, m.To].join(",").split(",")) add(/\+([^@>\s]+)@/.exec(a)?.[1]);
  return out;
}

const senderOf = (m: InboundMail) => {
  const s = String(m.FromFull?.Email ?? m.From ?? "").trim().toLowerCase();
  return s.includes("<") ? s.slice(s.lastIndexOf("<") + 1, s.lastIndexOf(">")) : s;
};

/** SPF or DMARC said this sender's domain did not send it. */
export function failedAuthentication(m: InboundMail): string | null {
  for (const h of m.Headers ?? []) {
    const n = String(h.Name ?? "").toLowerCase(), v = String(h.Value ?? "").toLowerCase();
    if (n === "received-spf" && /^\s*(fail|softfail)\b/.test(v)) return "the sender's domain says it did not send this message (SPF failed)";
    if (n === "authentication-results" && /\bdmarc=fail\b/.test(v)) return "the sender's domain says it did not send this message (DMARC failed)";
  }
  return null;
}

type Target = { kind: "connection"; id: string; name: string; vendorId: string } | { kind: "feed"; id: string; name: string; vendorId: string };
const globOk = (pattern: unknown, name: string) => !String(pattern ?? "").trim() || globRx(String(pattern)).test(name);

/** Where one attachment from this sender goes: the vendor connections and email-in feeds that list the sender (exact address first). */
async function targetsFor(c: Client, entityId: string, vendorId: string | null, sender: string, subject: string, name: string): Promise<Target[]> {
  const conns = await q<{ id: string; name: string; vendor_id: string; allowed_senders: string[] }>(c, `
    select id, name, vendor_id, allowed_senders from connection where entity_id = $1 and source_code = 'vendor_files' and channel = 'email' and status = 'active'
       and ($2::uuid is null or vendor_id = $2)`, [entityId, vendorId]);
  const feeds = await q<{ id: string; name: string; vendor_id: string; options: Record<string, unknown> }>(c, `
    select id, name, vendor_id, options from vendor_feed where entity_id = $1 and kind = 'email' and active and ($2::uuid is null or vendor_id = $2)`, [entityId, vendorId]);
  const { feedSenders } = await import("./vendor_feeds.ts");
  const all: (Target & { senders: string[] })[] = [
    ...conns.map((x) => ({ kind: "connection" as const, id: x.id, name: x.name, vendorId: x.vendor_id, senders: x.allowed_senders ?? [] })),
    ...feeds.filter((x) => globOk(x.options.pattern, name) && (!String(x.options.subjectContains ?? "").trim() || subject.toLowerCase().includes(String(x.options.subjectContains).trim().toLowerCase())))
      .map((x) => ({ kind: "feed" as const, id: x.id, name: x.name, vendorId: x.vendor_id, senders: feedSenders(x.options) })),
  ];
  const exact = all.filter((x) => x.senders.some((a) => a.toLowerCase() === sender));
  return (exact.length ? exact : all.filter((x) => senderAllowed(sender, x.senders))).map(({ senders: _s, ...t }) => t);
}

/**
 * Vendor mail to a company's address or a vendor's own address. Returns null
 * when the message is addressed to neither (the caller's older routes then
 * decide). Each attachment goes through the vendor connection or email-in
 * feed that lists its sender, or is held with the reason.
 */
export async function receiveMail(m: InboundMail) {
  const keys = mailboxKeysOf(m);
  if (!keys.length) return null;
  const box = await tx({ kind: "system", label: "inbound email" }, async (c) =>
    (await q<{ entity_id: string; tenant_id: string; vendor_id: string | null }>(c, `
      select b.entity_id, b.tenant_id, b.vendor_id from inbound_mailbox b join tenant t on t.id = b.tenant_id join entity e on e.id = b.entity_id
       where b.mailbox_key = any($1) and t.status = 'active' and e.status = 'active'
       /* unscoped: routing by mailbox key happens before a company is known */`, [keys]))[0] ?? null);
  if (!box) return null;
  const s: Scope = { tenantId: box.tenant_id, entityId: box.entity_id, actor: { kind: "system", label: "inbound email" } };
  const sender = senderOf(m);
  const subject = String(m.Subject ?? "");
  const atts = (m.Attachments ?? []).map((a) => ({ name: String(a.Name ?? "attachment").slice(0, 200), type: a.ContentType, bytes: Buffer.from(a.Content ?? "", "base64") }));
  const data = atts.filter((a) => isDataAttachment(a.name, a.type));
  const out = { company: box.entity_id, accepted: 0, duplicate: 0, quarantined: [] as { origin: string; reason: string }[], held: [] as string[],
    ignored: atts.filter((a) => !isDataAttachment(a.name, a.type)).map((a) => a.name), routed: [] as { file: string; to: string }[] };
  if (!data.length) return { ...out, note: "no data files attached; nothing to read" };
  const auth = failedAuthentication(m);
  // Each attachment in its own transaction: one that fails to apply is held, and never undoes another.
  for (const a of data) {
    await tx({ kind: "system", label: "inbound email" }, async (c) => {
      const hold = async (reason: string, feed?: { id: string; runId: string | null }) => {
        if (a.bytes.length > MAX_MB * 1048576) { out.ignored.push(`${a.name} (over ${MAX_MB} MB)`); return; }
        const r = await q(c, `insert into inbound_mail_held (tenant_id, entity_id, vendor_id, sender, subject, message_id, filename, content_type, byte_size, sha256, content, reason, feed_id, feed_run_id)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict do nothing returning id`,
          [s.tenantId, s.entityId, box.vendor_id, sender || "(no sender)", subject.slice(0, 300) || null, String(m.MessageID ?? "").slice(0, 300) || null,
           a.name, a.type ?? null, a.bytes.length, sha256(a.bytes), a.bytes, reason.slice(0, 1000), feed?.id ?? null, feed?.runId ?? null]);
        if (r.length) out.held.push(a.name); else out.duplicate++;
      };
      if (auth) return hold(auth);
      const targets = await targetsFor(c, s.entityId, box.vendor_id, sender, subject, a.name);
      if (!targets.length) return hold(`${sender || "the sender"} is not on the sender list of any ${box.vendor_id ? "of this vendor's feeds or connections" : "vendor feed or connection"} here`);
      if (targets.length > 1) return hold(`${sender} matches more than one place (${targets.map((x) => x.name).join(", ")}); say which this file is for, or give the feeds file patterns`);
      const t = targets[0];
      if (t.kind === "connection") {
        const r = await ingest(c, s, t.id, { trigger: "webhook", offered: [{ origin: a.name, originDetail: { subject, messageId: m.MessageID }, sender, contentType: a.type, bytes: a.bytes }] });
        out.accepted += r.fresh; out.duplicate += r.seen - r.fresh; out.quarantined.push(...r.quarantined);
      } else {
        const { runFeed, liveEnv } = await import("./vendor_feeds.ts");
        const r = await runFeed(c, s, t.id, liveEnv(), "email", async () => false, [{ name: a.name, bytes: a.bytes, sender }]);
        if (!r.ok) return hold(`the ${t.name} feed could not use it: ${r.note}`, { id: t.id, runId: r.runId });
        if (/applied before/.test(r.note)) out.duplicate++; else out.accepted++;
      }
      out.routed.push({ file: a.name, to: t.name });
    });
  }
  return out;
}

export async function heldMail(c: Client, entityId: string, vendorId: string | null = null) {
  return q(c, `select h.id, h.received_at, h.sender, h.subject, h.filename, h.content_type, h.byte_size, h.reason, h.status, h.vendor_id, coalesce(v.dba, v.legal_name) vendor
     from inbound_mail_held h left join vendor v on v.id = h.vendor_id
     where h.entity_id = $1 and h.status = 'held' and ($2::uuid is null or h.vendor_id = $2) order by h.received_at desc limit 200`, [entityId, vendorId]);
}

/** One vendor's own address, its email-in feeds' senders, and what is held for it: for the vendor card and the feed dialog. */
export async function vendorMail(c: Client, co: { id: string; tenantId: string }, vendorId: string, create = true) {
  const v = (await q(c, `select 1 from vendor_entity where entity_id = $1 and vendor_id = $2`, [co.id, vendorId]))[0];
  need(v, "that vendor is not set up for this company");
  const key = create ? await mailboxOf(c, co.id, co.tenantId, vendorId)
    : (await q<{ mailbox_key: string }>(c, `select mailbox_key from inbound_mailbox where entity_id = $1 and vendor_id = $2`, [co.id, vendorId]))[0]?.mailbox_key ?? null;
  return { address: key ? inboundAddress(key) : null, held: await heldMail(c, co.id, vendorId) };
}

/** A person says where held mail goes: a vendor connection or an email-in feed. The file goes through it; the sender may be added to its list. */
export async function assignHeld(c: Client, s: Scope, heldId: string, to: { connectionId?: string | null; feedId?: string | null }, addSender: boolean, who: string) {
  const h = (await q<{ id: string; sender: string; subject: string | null; message_id: string | null; filename: string; content_type: string | null; content: Buffer | null; status: string }>(c,
    `select id, sender, subject, message_id, filename, content_type, content, status from inbound_mail_held where id = $1 and entity_id = $2 for update`, [heldId, s.entityId]))[0];
  need(h, "no such held message");
  need(h.status === "held", "that file has already been dealt with");
  need(h.content, "that file's content was not kept; ask the vendor to send it again");
  const okSender = /^[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(h.sender);
  if (to.feedId) {
    const { runFeed, liveEnv, feedSenders } = await import("./vendor_feeds.ts");
    const f = (await q<{ id: string; name: string; kind: string; options: Record<string, unknown> }>(c, `select id, name, kind, options from vendor_feed where id = $1 and entity_id = $2`, [to.feedId, s.entityId]))[0];
    need(f, "no such feed");
    need(f.kind === "email", `${f.name} is not an email-in feed`);
    if (addSender && okSender && !senderAllowed(h.sender, feedSenders(f.options))) {
      const list = [...feedSenders(f.options), h.sender.toLowerCase()].join(", ");
      await c.query(`update vendor_feed set options = jsonb_set(options, '{fromContains}', to_jsonb($3::text)) where id = $1 and entity_id = $2`, [f.id, s.entityId, list]);
      await audit(c, s, { table: "vendor_feed", rowId: f.id, action: "update", after: { senderAdded: h.sender }, reason: `held mail assigned by ${who}` });
    }
    const r = await runFeed(c, s, f.id, liveEnv(), "email", async () => false, [{ name: h.filename, bytes: h.content!, sender: h.sender }]);
    need(r.ok, `the ${f.name} feed could not use it: ${r.note}`);
    await c.query(`update inbound_mail_held set status = 'assigned', decided_at = now(), decided_by = $3, decided_by_name = $4, feed_id = $5, feed_run_id = $6 where id = $1 and entity_id = $2`,
      [h.id, s.entityId, s.actor.id || null, who, f.id, r.runId]);
    await audit(c, s, { table: "inbound_mail_held", rowId: h.id, action: "transition", after: { status: "assigned", feed: f.name, note: r.note } });
    return { to: f.name, status: "applied", reason: null, note: r.note };
  }
  const conn = await vendorConn(c, s.entityId, String(to.connectionId ?? ""));
  need(conn.channel === "email", "held mail goes to one of the vendor's email connections or email-in feeds");
  need(conn.status === "active", `${conn.name} is ${conn.status}; turn it on first`);
  if (addSender && okSender && !senderAllowed(h.sender, conn.allowed_senders)) {
    await c.query(`update connection set allowed_senders = array_append(allowed_senders, $3) where id = $1 and entity_id = $2`, [conn.id, s.entityId, h.sender.toLowerCase()]);
    await audit(c, s, { table: "connection", rowId: conn.id, action: "update", after: { senderAdded: h.sender }, reason: `held mail assigned by ${who}` });
  }
  const r = await ingest(c, s, conn.id, { trigger: "manual", vouched: true,
    offered: [{ origin: h.filename, sender: h.sender, contentType: h.content_type ?? undefined, bytes: h.content!, originDetail: { subject: h.subject, messageId: h.message_id, held: h.id } }] });
  const file = (await q<{ id: string; status: string; quarantine_reason: string | null }>(c, `select id, status, quarantine_reason from inbound_file where run_id = $1 /* unscoped: the run just made */`, [r.runId]))[0];
  await c.query(`update inbound_mail_held set status = 'assigned', decided_at = now(), decided_by = $3, decided_by_name = $4, connection_id = $5, inbound_file_id = $6
    where id = $1 and entity_id = $2`, [h.id, s.entityId, s.actor.id || null, who, conn.id, file?.id ?? null]);
  await audit(c, s, { table: "inbound_mail_held", rowId: h.id, action: "transition", after: { status: "assigned", connection: conn.name, file: file?.status ?? "seen before" } });
  return { to: conn.name, status: file?.status ?? "duplicate", reason: file?.quarantine_reason ?? null, note: null };
}

export async function setAsideHeld(c: Client, s: Scope, heldId: string, reason: string, who: string) {
  need(reason.trim(), "say why, so the next person knows");
  const r = await q(c, `update inbound_mail_held set status = 'set_aside', decided_at = now(), decided_by = $3, decided_by_name = $4, decision_note = $5
    where id = $1 and entity_id = $2 and status = 'held' returning id`, [heldId, s.entityId, s.actor.id || null, who, reason.trim().slice(0, 500)]);
  need(r.length, "no such held message, or it has already been dealt with");
  await audit(c, s, { table: "inbound_mail_held", rowId: heldId, action: "transition", after: { status: "set_aside" }, reason: reason.trim().slice(0, 500) });
  return { ok: true };
}

export { maxBytesOf };
