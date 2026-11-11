// Vendor EDI: trading partners, the inbox and outbox, the transports, and
// the rules that turn each X12 document into what purchasing, payables and
// the catalog already do. Nothing here re-implements those: an 855 is
// purchasing's acknowledgePO, an 856 is purchasing's recordShipment, an 810
// is payables' enterVendorBill (the three-way match runs as for any bill),
// an 832 goes through the vendor feeds' price history and product import,
// an 846 through the feeds' availability.
//
// Every document in or out is a row in edi_document with its raw text. An
// inbound transaction set is applied inside its own savepoint: if any part
// of it is refused, none of it lands and the document is quarantined with
// the refusal as its reason. A set whose sender and control numbers were
// seen before is logged as ignored. Every inbound group is answered with a
// 997 when the partner exchanges them; a 997 that answers our 850 marks it
// acknowledged (or rejected, with the partner's reasons).
//
// Transports: manual (upload in, download out), a drop folder on the
// server (ERP_EDI_DROP_DIR), and a VAN or EDI service over HTTPS (SPS
// Commerce and the like) through the same SSRF-checked caller the vendor
// feeds use. SFTP and AS2 keep their settings and secrets but refuse to run,
// in words: this build has no SSH or AS2 library (package.json carries only
// pg), and adding one is a decision for the owner, not a side effect.

import { today as bizToday } from "./clock.ts";
import { applyVendorExtras, pieceTypeFrom, type VendorExtra } from "./configurator.ts";
import { readdir, readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { join, resolve, sep as pathSep } from "node:path";
import { q, one, audit, type Client, type Scope } from "./db.ts";
import * as x12 from "./x12.ts";
import * as pur from "./purchasing.ts";
import * as wms from "./wms.ts";
import * as inventory from "./inventory.ts";
import { enterVendorBill, BillError, TransitionError } from "./invoice.ts";
import { sha256 } from "./connections.ts";
import {
  call, sealSecret, unsealSecret, liveEnv, recordVendorPrices, recordAvailability, applyCatalogRows, runFeed,
  FeedError, type FeedEnv,
} from "./vendor_feeds.ts";
import { CatalogError } from "./catalog.ts";
import { PostingError } from "./posting.ts";

export class EdiError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new EdiError(msg); };

export type EdiEnv = FeedEnv & { dropDir?: string | null };
export const liveEdiEnv = (): EdiEnv => ({ ...liveEnv(), dropDir: process.env.ERP_EDI_DROP_DIR?.trim() || null });

/** Refusals from the modules an EDI document drives, as the plain reason a quarantine records. */
const REFUSED = [EdiError, x12.X12Error, pur.PurchasingError, wms.WmsError, BillError, TransitionError, FeedError, CatalogError, PostingError];
const refusal = (e: unknown): string | null => (REFUSED.some((K) => e instanceof K) ? (e as Error).message : null);

// ------------------------------------------------------------ partners --

export const DOC_CHANNELS: Record<string, string[]> = {
  "850": ["edi", "api", "email", "file", "off"],     // purchase orders out: X12, the vendor's orders feed, email or the CSV file
  "855": ["edi", "api", "file", "off"],              // acknowledgments in: X12, the acknowledgments feed, or the 855-style CSV import
  "856": ["edi", "api", "off"],                      // ship notices: X12, or "shipped" rows on the acknowledgments feed
  "810": ["edi", "email", "file", "off"],            // invoices: X12, or the payables inbox and entry as today
  "832": ["edi", "api", "file", "off"],              // catalog and prices: X12, the products/pricing feeds, or a price file import
  "846": ["edi", "api", "off"],                      // quantities: X12, or the quantities (ATP) feed
  "freight": ["api", "off"],                         // freight by store: the freight feed only (it keeps feeding landed cost)
  "997": ["edi", "off"],
};
export const DEFAULT_DOCS: Record<string, string> = { "850": "edi", "855": "edi", "856": "edi", "810": "edi", "832": "off", "846": "off", "freight": "off", "997": "edi" };
/** Which vendor feed purposes stand behind each document's API channel. */
export const FEED_FOR_DOC: Record<string, string[]> = { "850": ["orders"], "855": ["acknowledgments"], "856": ["acknowledgments"], "832": ["products", "pricing"], "846": ["quantities"], "freight": ["freight"] };

/** A new partner's channels: the API wherever the vendor already has an active feed for that purpose (Ashley: catalog, prices, ATP, freight), EDI otherwise. */
export async function defaultDocuments(c: Client, entityId: string, vendorId: string): Promise<Record<string, string>> {
  const have = new Set((await q<{ purpose: string }>(c, `select distinct purpose from vendor_feed where entity_id = $1 and vendor_id = $2 and active`, [entityId, vendorId])).map((x) => x.purpose));
  const out = { ...DEFAULT_DOCS };
  for (const [doc, purposes] of Object.entries(FEED_FOR_DOC)) if (purposes.some((p) => have.has(p))) out[doc] = "api";
  return out;
}

export const TRANSPORTS = ["manual", "dropfolder", "van", "sftp", "as2"] as const;
export const PARTNER_SECRETS = ["sftpPassword", "sftpKey", "vanApiKey", "vanToken", "vanPassword", "as2Password"] as const;
const SECRET_SET = new Set<string>(PARTNER_SECRETS);
const SECRETY = /(password|passwd|secret|private_?key|api_?key|token|credential|passphrase)/i;

export type Partner = {
  id: string; entity_id: string; vendor_id: string; vendor: string; edi_enabled: boolean;
  our_isa_qual: string; our_isa_id: string; their_isa_qual: string; their_isa_id: string; our_gs_id: string; their_gs_id: string;
  version: x12.Version; usage: "T" | "P"; element_sep: string; segment_term: string; subelement_sep: string; repetition_sep: string;
  documents: Record<string, string>; transport: (typeof TRANSPORTS)[number]; transport_config: Record<string, unknown>; send_on_approval: boolean;
  options: Options850;
  last_poll_at: string | null; last_poll_ok: boolean | null; last_poll_note: string | null; updated_by: string | null;
};
export type PartnerDraft = Partial<Omit<Partner, "id" | "entity_id" | "vendor" | "options">> & { vendor_id: string; secrets?: Record<string, string | null>; options?: unknown };

/** How this partner wants its 850 laid out. */
export type Options850 = {
  billTo?: x12.Address | null; vendorN1?: boolean; td5?: { scac?: string; method?: string; routing?: string } | null; fob?: string | null;
  shipByDays?: number | null; cancelAfterDays?: number | null; itemIds?: string[]; refs?: string[]; contact?: { name?: string; phone?: string; email?: string } | null;
};
export const FOB_CODES = ["PP", "CC", "PB", "DF", "PC"];

function cleanOptions(o: unknown): Options850 {
  const x = (o && typeof o === "object" && !Array.isArray(o) ? o : {}) as Record<string, unknown>;
  const str = (v: unknown, n = 60) => (v == null ? "" : String(v).trim().slice(0, n));
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
  const out: Options850 = {};
  const bt = obj(x.billTo);
  if (bt && str(bt.name)) out.billTo = { name: str(bt.name), code: str(bt.code, 20) || undefined, address1: str(bt.address1) || undefined, city: str(bt.city, 40) || undefined,
    state: str(bt.state, 2).toUpperCase() || undefined, postal: str(bt.postal, 10) || undefined };
  out.vendorN1 = x.vendorN1 === true || x.vendorN1 === "true";
  const td5 = obj(x.td5);
  if (td5 && (str(td5.scac) || str(td5.routing))) {
    need(!str(td5.scac) || /^[A-Z]{2,4}$/.test(str(td5.scac).toUpperCase()), "a carrier SCAC is two to four letters");
    out.td5 = { scac: str(td5.scac, 4).toUpperCase() || undefined, method: str(td5.method, 2).toUpperCase() || undefined, routing: str(td5.routing, 35) || undefined };
  }
  if (str(x.fob)) { need(FOB_CODES.includes(str(x.fob).toUpperCase()), `FOB is one of ${FOB_CODES.join(", ")}`); out.fob = str(x.fob).toUpperCase(); }
  for (const k of ["shipByDays", "cancelAfterDays"] as const) {
    if (x[k] == null || x[k] === "") continue;
    const n = Number(x[k]);
    need(Number.isInteger(n) && n >= 0 && n <= 365, "ship-by and cancel-after are whole days from the order, 0 to 365");
    out[k] = n;
  }
  if (out.shipByDays != null && out.cancelAfterDays != null) need(out.cancelAfterDays >= out.shipByDays, "cancel-after comes on or after ship-by");
  if (x.itemIds != null) {
    const ids = (Array.isArray(x.itemIds) ? x.itemIds : String(x.itemIds).split(/[,\s]+/)).map((v) => String(v).trim().toUpperCase()).filter(Boolean);
    for (const q_ of ids) need((x12.ITEM_QUALIFIERS as readonly string[]).includes(q_), `${q_} is not an item id this system sends (${x12.ITEM_QUALIFIERS.join(", ")})`);
    need(ids.length, "send at least one item id on each 850 line");
    out.itemIds = [...new Set(ids)];
  }
  if (x.refs != null) {
    const refs = (Array.isArray(x.refs) ? x.refs : String(x.refs).split(/[,\s]+/)).map((v) => String(v).trim().toUpperCase()).filter(Boolean);
    for (const r of refs) need((x12.REF_CHOICES as readonly string[]).includes(r), `${r} is not a reference this system sends (${x12.REF_CHOICES.join(", ")})`);
    out.refs = [...new Set(refs)];
  }
  const ct = obj(x.contact);
  if (ct && (str(ct.name) || str(ct.phone) || str(ct.email))) {
    if (str(ct.email)) need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str(ct.email, 80)), "the contact email is not an email address");
    out.contact = { name: str(ct.name) || undefined, phone: str(ct.phone, 20) || undefined, email: str(ct.email, 80) || undefined };
  }
  return out;
}

const sepsOf = (p: Partner): x12.Separators => ({ element: p.element_sep, segment: p.segment_term, sub: p.subelement_sep, repetition: p.repetition_sep });
const ISA_ID = /^[A-Za-z0-9 .\-_/&@#]{1,15}$/;

export async function loadPartner(c: Client, entityId: string, id: string): Promise<Partner> {
  const p = (await q<Partner>(c, `select p.*, coalesce(v.dba, v.legal_name) vendor from edi_partner p join vendor v on v.id = p.vendor_id
                                   where p.id = $1 and p.entity_id = $2`, [id, entityId]))[0];
  need(p, "no such trading partner");
  return p;
}
export async function partnerForVendor(c: Client, entityId: string, vendorId: string): Promise<Partner | null> {
  return (await q<Partner>(c, `select p.*, coalesce(v.dba, v.legal_name) vendor from edi_partner p join vendor v on v.id = p.vendor_id
                                where p.entity_id = $1 and p.vendor_id = $2`, [entityId, vendorId]))[0] ?? null;
}

/** Set up or change a vendor's trading partner. Secrets are written to the sealed store, never to settings. */
export async function savePartner(c: Client, s: Scope, env: EdiEnv, d: PartnerDraft): Promise<string> {
  const v = (await q<{ name: string; merch: boolean }>(c, `
    select coalesce(v.dba, v.legal_name) as name,
           exists (select 1 from vendor_merchandise vm where vm.entity_id = ve.entity_id and vm.vendor_id = ve.vendor_id and vm.is_merchandise) merch
      from vendor_entity ve join vendor v on v.id = ve.vendor_id where ve.entity_id = $1 and ve.vendor_id = $2 and ve.status = 'active'`, [s.entityId, d.vendor_id]))[0];
  need(v, "that vendor is not set up for this company");
  need(v.merch, `${v.name} is not a merchandise vendor; EDI is for vendors we buy goods from`);
  const cur = await partnerForVendor(c, s.entityId, d.vendor_id);
  const pick = <K extends keyof Partner>(k: K, dflt: Partner[K]): Partner[K] => (d[k as keyof PartnerDraft] !== undefined ? d[k as keyof PartnerDraft] as Partner[K] : cur ? cur[k] : dflt);
  const up = (x: unknown) => String(x ?? "").trim().toUpperCase();
  const p = {
    edi_enabled: !!pick("edi_enabled", false),
    our_isa_qual: up(pick("our_isa_qual", "ZZ")), our_isa_id: up(pick("our_isa_id", "")), their_isa_qual: up(pick("their_isa_qual", "ZZ")), their_isa_id: up(pick("their_isa_id", "")),
    our_gs_id: up(pick("our_gs_id", "")), their_gs_id: up(pick("their_gs_id", "")),
    version: pick("version", "004010"), usage: pick("usage", "T"),
    element_sep: String(pick("element_sep", "*")), segment_term: String(pick("segment_term", "~")), subelement_sep: String(pick("subelement_sep", ">")), repetition_sep: String(pick("repetition_sep", "^")),
    documents: { ...(cur ? DEFAULT_DOCS : await defaultDocuments(c, s.entityId, d.vendor_id)), ...(cur?.documents ?? {}), ...((d.documents ?? {}) as Record<string, string>) },
    transport: pick("transport", "manual"), transport_config: (d.transport_config !== undefined ? d.transport_config : cur?.transport_config ?? {}) as Record<string, unknown>,
    send_on_approval: pick("send_on_approval", true) !== false,
    options: d.options !== undefined ? cleanOptions(d.options) : cur?.options ?? {},
  };
  for (const [k, q_] of [["our", p.our_isa_qual], ["their", p.their_isa_qual]]) need(/^[0-9A-Z]{2}$/.test(q_), `the ${k} ISA qualifier is two letters or digits, like ZZ, 01 or 12`);
  for (const [label, id] of [["our ISA id", p.our_isa_id], ["their ISA id", p.their_isa_id], ["our GS id", p.our_gs_id], ["their GS id", p.their_gs_id]]) {
    if (id) need(ISA_ID.test(id), `${label} is 1 to 15 letters, digits or spaces`);
  }
  if (p.edi_enabled) need(p.our_isa_id && p.their_isa_id, "to switch EDI on, give our ISA id and theirs (from the vendor's EDI setup sheet)");
  need(["004010", "005010"].includes(p.version), "the X12 version is 004010 or 005010");
  need(p.usage === "T" || p.usage === "P", "a partner is in test (T) or production (P)");
  try { x12.writeInterchange({ sender: { qual: "ZZ", id: "A" }, receiver: { qual: "ZZ", id: "B" }, gsSender: "A", gsReceiver: "B", version: "004010", usage: "T", isaControl: 1, gsControl: 1 },
    [{ type: "997", control: 1, segments: [["AK1", "PO", "1"], ["AK9", "A", "1", "1", "1"]] }],
    { element: p.element_sep, segment: p.segment_term, sub: p.subelement_sep, repetition: p.repetition_sep }); }
  catch (e) { throw new EdiError(e instanceof x12.X12Error ? e.message : "those separators cannot be used"); }
  for (const [k, ch] of Object.entries(p.documents)) {
    need(DOC_CHANNELS[k], `${k} is not a document this system exchanges`);
    need(DOC_CHANNELS[k].includes(ch), `${x12.DOC_NAMES[k] ?? k} (${k}) goes by ${DOC_CHANNELS[k].join(", ")}, not ${ch}`);
  }
  need((TRANSPORTS as readonly string[]).includes(p.transport), "files travel by manual upload, a drop folder, a VAN or EDI service, SFTP or AS2");
  const tc = p.transport_config;
  need(tc && typeof tc === "object" && !Array.isArray(tc), "transport settings are a set of names and values");
  for (const k of Object.keys(tc)) need(!SECRETY.test(k), `transport settings may not hold ${k}; type it into the secret boxes instead`);
  if (p.transport === "dropfolder") need(/^[A-Za-z0-9_-]{1,60}$/.test(String(tc.folder ?? "")), "name the partner's drop folder: letters, digits, - or _ (it sits under the server's EDI drop directory)");
  if (p.transport === "sftp") {
    need(String(tc.host ?? "").trim() && String(tc.user ?? "").trim(), "SFTP needs the host and the user");
    if (tc.port != null && tc.port !== "") need(Number.isInteger(Number(tc.port)) && Number(tc.port) > 0 && Number(tc.port) < 65536, "the SFTP port is a number, usually 22");
  }
  if (p.transport === "van") {
    for (const k of ["sendUrl", "listUrl", "ackUrl"]) if (tc[k]) need(/^https:\/\/[^\s/]+/i.test(String(tc[k])), `the ${k} is an https:// address`);
    need(tc.sendUrl, "a VAN or EDI service needs the address documents are sent to");
    need(["none", "bearer", "header", "basic"].includes(String(tc.auth ?? "bearer")), "the service's authentication is none, bearer token, key header or basic");
  }
  if (p.transport === "as2") need(String(tc.url ?? "").trim() && String(tc.as2To ?? "").trim(), "AS2 needs the partner's AS2 address and AS2 id");
  const vals = [p.edi_enabled, p.our_isa_qual, p.our_isa_id, p.their_isa_qual, p.their_isa_id, p.our_gs_id || p.our_isa_id, p.their_gs_id || p.their_isa_id, p.version, p.usage,
    p.element_sep, p.segment_term, p.subelement_sep, p.repetition_sep, JSON.stringify(p.documents), p.transport, JSON.stringify(tc), p.send_on_approval, s.actor.id || null,
    JSON.stringify(p.options)];
  // ISA ids, said plainly before the database says them: their id once per company, and our id with theirs once across the client's companies.
  if (p.their_isa_id) {
    const clash = (await q<{ vendor: string }>(c, `select coalesce(v.dba, v.legal_name) vendor from edi_partner x join vendor v on v.id = x.vendor_id
      where x.entity_id = $1 and x.their_isa_qual = $2 and upper(x.their_isa_id) = upper($3) and x.id is distinct from $4`, [s.entityId, p.their_isa_qual, p.their_isa_id, cur?.id ?? null]))[0];
    need(!clash, `${clash?.vendor} already uses ISA id ${p.their_isa_qual}/${p.their_isa_id}; each trading partner has its own`);
    if (p.our_isa_id) {
      const sib = (await q<{ name: string }>(c, `select e.name from edi_partner x join entity e on e.id = x.entity_id
        where e.tenant_id = $1 and x.entity_id <> $2 and x.our_isa_qual = $3 and upper(x.our_isa_id) = upper($4) and x.their_isa_qual = $5 and upper(x.their_isa_id) = upper($6)
        /* unscoped: the pair must be unique across the client's companies */`, [s.tenantId, s.entityId, p.our_isa_qual, p.our_isa_id, p.their_isa_qual, p.their_isa_id]))[0];
      need(!sib, `${sib?.name} already trades with ISA id ${p.their_isa_qual}/${p.their_isa_id} as ${p.our_isa_qual}/${p.our_isa_id}; give this company its own ISA id with this vendor, so neither takes the other's files`);
    }
  }
  let id = cur?.id;
  if (id) {
    await c.query(`update edi_partner set edi_enabled=$3, our_isa_qual=$4, our_isa_id=$5, their_isa_qual=$6, their_isa_id=$7, our_gs_id=$8, their_gs_id=$9, version=$10, usage=$11,
        element_sep=$12, segment_term=$13, subelement_sep=$14, repetition_sep=$15, documents=$16, transport=$17, transport_config=$18, send_on_approval=$19,
        updated_by=$20, options=$21, updated_at=now() where id = $1 and entity_id = $2`, [id, s.entityId, ...vals]);
  } else {
    id = (await one<{ id: string }>(c, `insert into edi_partner (entity_id, vendor_id, edi_enabled, our_isa_qual, our_isa_id, their_isa_qual, their_isa_id, our_gs_id, their_gs_id,
        version, usage, element_sep, segment_term, subelement_sep, repetition_sep, documents, transport, transport_config, send_on_approval, updated_by, options)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning id`, [s.entityId, d.vendor_id, ...vals])).id;
  }
  if (d.secrets && Object.keys(d.secrets).length) await setPartnerSecrets(c, s, env, id!, d.secrets);
  await audit(c, s, { table: "edi_partner", rowId: id!, action: cur ? "update" : "insert",
    after: { vendor: v.name, edi: p.edi_enabled, usage: p.usage, version: p.version, transport: p.transport, documents: p.documents } });
  return id!;
}

/** Typed secrets: write-only. A value sets or replaces; null clears. Audited by name, never by value. */
export async function setPartnerSecrets(c: Client, s: Scope, env: EdiEnv, partnerId: string, values: Record<string, string | null>) {
  await loadPartner(c, s.entityId, partnerId);
  const changed: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    need(SECRET_SET.has(name), `${name} is not a secret a trading partner keeps`);
    if (value === null) {
      const r = await q(c, `delete from edi_partner_secret where entity_id = $1 and partner_id = $2 and name = $3 returning name`, [s.entityId, partnerId, name]);
      if (r.length) changed.push(`${name} cleared`);
      continue;
    }
    const v = String(value);
    if (!v || v === "•kept•") continue;
    need(v.length <= 8000, `${name} is too long`);
    need(env.secretKey && env.secretKey.length === 32, "add ERP_SECRET_KEY to the service's environment to store passwords here");
    const box = sealSecret(env.secretKey!, `edi:${partnerId}`, name, v);
    await c.query(`
      insert into edi_partner_secret (entity_id, partner_id, name, iv, ciphertext, tag, last2, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict (partner_id, name) do update set iv = excluded.iv, ciphertext = excluded.ciphertext, tag = excluded.tag, last2 = excluded.last2,
        updated_by = excluded.updated_by, updated_at = now()`, [s.entityId, partnerId, name, box.iv, box.ct, box.tag, v.slice(-2), s.actor.id || null]);
    changed.push(`${name} set`);
  }
  if (changed.length) await audit(c, s, { table: "edi_partner_secret", rowId: partnerId, action: "update", after: { secrets: changed } });
  return changed;
}

/** What a screen may know about a partner's secrets: which are set. Not a character of any of them. */
export async function partnerSecretStatus(c: Client, entityId: string, partnerId: string) {
  return q<{ name: string; masked: string; updated_at: string }>(c,
    `select name, 'set' masked, updated_at from edi_partner_secret where entity_id = $1 and partner_id = $2 order by name`, [entityId, partnerId]);
}

async function partnerSecrets(c: Client, entityId: string, env: EdiEnv, partnerId: string): Promise<Record<string, string>> {
  const rows = await q<{ name: string; iv: Buffer; ciphertext: Buffer; tag: Buffer }>(c,
    `select name, iv, ciphertext, tag from edi_partner_secret where entity_id = $1 and partner_id = $2`, [entityId, partnerId]);
  if (!rows.length) return {};
  need(env.secretKey && env.secretKey.length === 32, "ERP_SECRET_KEY is not set on the server, so the stored passwords cannot be read");
  const out: Record<string, string> = {};
  for (const r of rows) {
    try { out[r.name] = unsealSecret(env.secretKey!, `edi:${partnerId}`, r.name, r.iv, r.ciphertext, r.tag); }
    catch { throw new EdiError(`the stored ${r.name} cannot be read with this ERP_SECRET_KEY; type it again`); }
  }
  return out;
}

/** Every partner, with what the screen may show (no secret values), and the vendor's API feeds beside it. */
export async function listPartners(c: Client, entityId: string) {
  const rows = await q<Partner & { secrets: { name: string; masked: string }[] | null; feeds: { id: string; name: string; purpose: string; active: boolean; last_ok: boolean | null }[] | null;
    queued: string; quarantined: string }>(c, `
    select p.*, coalesce(v.dba, v.legal_name) vendor,
           (select json_agg(json_build_object('name', x.name, 'masked', 'set') order by x.name) from edi_partner_secret x where x.entity_id = p.entity_id and x.partner_id = p.id) secrets,
           (select json_agg(json_build_object('id', f.id, 'name', f.name, 'purpose', f.purpose, 'active', f.active, 'last_ok', f.last_ok) order by f.purpose)
              from vendor_feed f where f.entity_id = p.entity_id and f.vendor_id = p.vendor_id) feeds,
           (select count(*) from edi_document d where d.entity_id = p.entity_id and d.partner_id = p.id and d.status in ('queued','failed')) queued,
           (select count(*) from edi_document d where d.entity_id = p.entity_id and d.partner_id = p.id and d.status = 'quarantined') quarantined
      from edi_partner p join vendor v on v.id = p.vendor_id where p.entity_id = $1 order by 2`, [entityId]);
  return rows.map((r) => ({ ...r, secrets: r.secrets ?? [], feeds: r.feeds ?? [], transport_note: transportNote(r) }));
}

export function transportNote(p: Pick<Partner, "transport">): string | null {
  if (p.transport === "sftp") return "SFTP is not built into this version (the server has no SSH library). The settings and password are kept; use the drop folder, a VAN, or download and upload by hand until it is.";
  if (p.transport === "as2") return "AS2 is not built into this version. The settings are kept; use a VAN or EDI service, or download and upload by hand until it is.";
  if (p.transport === "manual") return "Files come in by Upload EDI file and go out by download from the outbox.";
  return null;
}

// ------------------------------------------------------------- item ids --

export async function saveItemMap(c: Client, s: Scope, partnerId: string, rows: { vendorItem: string; productId?: string | null; sku?: string | null; upc?: string | null; active?: boolean }[]) {
  const p = await loadPartner(c, s.entityId, partnerId);
  need(Array.isArray(rows) && rows.length, "give at least one vendor item and our product");
  need(rows.length <= 2000, "2,000 mappings at most at once");
  let n = 0;
  for (const r of rows) {
    const vi = String(r.vendorItem ?? "").trim().toUpperCase();
    need(vi && vi.length <= 60, "each mapping needs the vendor's item number");
    const prod = (await q<{ id: string; vendor_id: string | null; name: string }>(c,
      `select id, vendor_id, name from product where entity_id = $1 and (id = $2::uuid or ($2::uuid is null and upper(sku) = upper($3)))`,
      [s.entityId, r.productId || null, r.sku ?? ""]))[0];
    need(prod, `${vi}: no product ${r.sku || ""} in this company's catalog`.replace(/ +/g, " "));
    need(prod.vendor_id === p.vendor_id, `${vi}: ${prod.name} is not bought from ${p.vendor}`);
    await c.query(`insert into edi_item_map (entity_id, partner_id, vendor_item, product_id, upc, active) values ($1,$2,$3,$4,$5,$6)
                   on conflict (partner_id, vendor_item) do update set product_id = excluded.product_id, upc = excluded.upc, active = excluded.active`,
      [s.entityId, partnerId, vi, prod.id, r.upc?.trim() || null, r.active !== false]);
    n++;
  }
  await audit(c, s, { table: "edi_item_map", rowId: partnerId, action: "update", after: { rows: n } });
  return n;
}

export async function itemMap(c: Client, entityId: string, partnerId: string) {
  return q<{ vendor_item: string; product_id: string; sku: string; name: string; upc: string | null; active: boolean }>(c, `
    select m.vendor_item, m.product_id, p.sku, p.name, m.upc, m.active from edi_item_map m join product p on p.id = m.product_id
     where m.entity_id = $1 and m.partner_id = $2 order by m.vendor_item`, [entityId, partnerId]);
}

/** Our product for a vendor's item id: the partner's mapping first (by item or UPC), then the product's own vendor model or barcode. */
async function productFor(c: Client, p: Partner, it: { vendorSku?: string; upc?: string }): Promise<string | null> {
  const r = (await q<{ id: string }>(c, `
    select product_id id from edi_item_map where entity_id = $1 and partner_id = $2 and active
       and (vendor_item = upper($3) or ($4 <> '' and upc = $4)) limit 1`, [p.entity_id, p.id, it.vendorSku ?? "", it.upc ?? ""]))[0];
  if (r) return r.id;
  const pr = (await q<{ id: string }>(c, `
    select id from product where entity_id = $1 and vendor_id = $2 and (upper(vendor_sku) = upper($3) or ($4 <> '' and barcode = $4)) limit 1`,
    [p.entity_id, p.vendor_id, it.vendorSku ?? "", it.upc ?? ""]))[0];
  return pr?.id ?? null;
}

/**
 * The PO line an inbound line means. Our line number and the vendor's item
 * must agree when both are given: a line number that points at another
 * product is refused, so a ship notice or a bill never lands on the wrong
 * line. With only one of them, that one decides.
 */
async function poLineFor(c: Client, p: Partner, poId: string, it: { line?: number; vendorSku?: string; upc?: string }): Promise<{ id: string; seq: number }> {
  const lines = await q<{ id: string; seq: number; product_id: string | null; vendor_sku: string | null; po: string }>(c,
    `select pol.id, pol.seq, pol.product_id, pol.vendor_sku, po.number po from purchase_order_line pol join purchase_order po on po.id = pol.purchase_order_id
      where pol.entity_id = $1 and pol.purchase_order_id = $2 order by pol.seq`, [p.entity_id, poId]);
  const number = lines[0]?.po ?? "the order";
  const hasItem = !!(it.vendorSku || it.upc);
  const prod = hasItem ? await productFor(c, p, it) : null;
  const byItem = hasItem ? lines.filter((x) => (prod && x.product_id === prod) || (it.vendorSku && x.vendor_sku?.toUpperCase() === it.vendorSku.toUpperCase())) : [];
  const label = it.vendorSku ?? it.upc ?? "";
  if (it.line != null) {
    const l = lines.find((x) => x.seq === it.line);
    need(l || byItem.length, `${number} has no line ${it.line}${label ? ` and no line for item ${label}` : ""}`);
    if (l && hasItem) {
      need(byItem.some((x) => x.id === l.id), `line ${it.line} of ${number} is ${l.vendor_sku ?? "another product"}, but the vendor says item ${label}; the line number and the item disagree, so nothing was applied`);
    }
    if (l) return l;
    return byItem[0];
  }
  need(byItem.length, `${number} has no line for item ${label || "(none given)"}`);
  need(byItem.length === 1, `${number} has ${byItem.length} lines for item ${label}; the vendor must say which line (its PO1 or LIN line number)`);
  return byItem[0];
}

/** Our vendor item for a product on an outbound 850: the mapping, else the product's vendor model. */
async function vendorItemFor(c: Client, p: Partner, productId: string | null, fallback: string | null): Promise<string | null> {
  if (!productId) return fallback;
  const r = (await q<{ vendor_item: string }>(c, `select vendor_item from edi_item_map where entity_id = $1 and partner_id = $2 and product_id = $3 and active order by created_at limit 1`,
    [p.entity_id, p.id, productId]))[0];
  return r?.vendor_item ?? fallback;
}

// ---------------------------------------------------- control numbers --

async function nextControls(c: Client, p: Partner) {
  const r = await one<{ isa: string; gs: string; st: string }>(c, `
    update edi_partner set next_isa_control = case when next_isa_control >= 999999999 then 1 else next_isa_control + 1 end,
                           next_gs_control  = case when next_gs_control  >= 999999999 then 1 else next_gs_control + 1 end,
                           next_st_control  = case when next_st_control  >= 999999999 then 1 else next_st_control + 1 end
     where id = $1 and entity_id = $2
    returning next_isa_control - 1 isa, next_gs_control - 1 gs, next_st_control - 1 st`, [p.id, p.entity_id]);
  const fix = (n: string) => (Number(n) < 1 ? 999999999 : Number(n));
  return { isa: fix(r.isa), gs: fix(r.gs), st: fix(r.st) };
}

function envelopeFor(p: Partner, ctl: { isa: number; gs: number }, usage?: "T" | "P"): x12.Envelope {
  return { sender: { qual: p.our_isa_qual, id: p.our_isa_id }, receiver: { qual: p.their_isa_qual, id: p.their_isa_id },
    gsSender: p.our_gs_id || p.our_isa_id, gsReceiver: p.their_gs_id || p.their_isa_id, version: p.version, usage: usage ?? p.usage,
    isaControl: ctl.isa, gsControl: ctl.gs, ackRequested: false };
}

// ------------------------------------------------------------ the log --

type DocIn = {
  partner: Partner | null; direction: "in" | "out"; type: string; channel?: "edi" | "api"; status: string; reason?: string | null; raw: string | null; interchangeId?: string | null;
  summary?: unknown; filename?: string | null; isa?: string | null; gs?: string | null; st?: string | null; usage?: string | null;
  poId?: string | null; invoiceId?: string | null; relatedId?: string | null; vendorId?: string | null;
};
async function logDoc(c: Client, s: Scope, d: DocIn): Promise<string> {
  const r = await one<{ id: string }>(c, `
    insert into edi_document (entity_id, partner_id, vendor_id, direction, doc_type, channel, isa_control, gs_control, st_control, usage, status, reason, raw,
                              summary, filename, purchase_order_id, invoice_id, related_id, created_by, applied_at, interchange_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, case when $11 = 'applied' then now() end, $20) returning id`,
    [s.entityId, d.partner?.id ?? null, d.vendorId ?? d.partner?.vendor_id ?? null, d.direction, d.type, d.channel ?? "edi", d.isa ?? null, d.gs ?? null, d.st ?? null,
     d.usage ?? null, d.status, d.reason ? d.reason.slice(0, 1000) : null, d.interchangeId ? null : d.raw, JSON.stringify(x12.summaryOf(d.summary ?? {})), d.filename?.slice(0, 200) ?? null,
     d.poId ?? null, d.invoiceId ?? null, d.relatedId ?? null, s.actor.id || null, d.interchangeId ?? null]);
  return r.id;
}
/** An inbound interchange's raw text, stored once; each of its sets points here. */
async function storeInterchange(c: Client, s: Scope, partner: Partner | null, text: string, filename: string | null, isa: string | null): Promise<string> {
  return (await one<{ id: string }>(c, `insert into edi_interchange (entity_id, partner_id, direction, isa_control, sha256, bytes, filename, raw)
    values ($1,$2,'in',$3,$4,$5,$6,$7) returning id`, [s.entityId, partner?.id ?? null, isa, sha256(Buffer.from(text)), text.length, filename?.slice(0, 200) ?? null, text])).id;
}

async function setDoc(c: Client, s: Scope, id: string, f: { status: string; reason?: string | null; summary?: unknown; poId?: string | null; invoiceId?: string | null; attempt?: boolean }) {
  await c.query(`update edi_document set status = $3, reason = $4, summary = coalesce($5::jsonb, summary), purchase_order_id = coalesce($6, purchase_order_id),
                        invoice_id = coalesce($7, invoice_id), applied_at = case when $3 = 'applied' then now() else applied_at end,
                        attempts = attempts + case when $8 then 1 else 0 end, last_attempt_at = case when $8 then now() else last_attempt_at end
                  where id = $1 and entity_id = $2`,
    [id, s.entityId, f.status, f.reason ? f.reason.slice(0, 1000) : null, f.summary === undefined ? null : JSON.stringify(x12.summaryOf(f.summary)),
     f.poId ?? null, f.invoiceId ?? null, !!f.attempt]);
}

// ------------------------------------------------------------ transports --

export type Arrival = { name: string; text: string; ref: string };
export interface EdiTransport {
  kind: string;
  send(name: string, text: string): Promise<string>;          // where it went, in words
  poll(): Promise<Arrival[]>;
  done?(a: Arrival): Promise<void>;                             // archive or acknowledge one we have stored
}

export class ManualHold extends Error {}
const MAX_FILE = 20 * 1024 * 1024;

/** The transport a partner's files travel by. SFTP and AS2 are adapters that refuse, in words, until a library is chosen. */
export async function transportFor(c: Client, p: Partner, env: EdiEnv): Promise<EdiTransport> {
  const tc = p.transport_config ?? {};
  if (p.transport === "manual") {
    return { kind: "manual", send: async () => { throw new ManualHold("waiting in the outbox to be downloaded and sent to the vendor"); }, poll: async () => [] };
  }
  if (p.transport === "dropfolder") {
    need(env.dropDir, "the drop folder needs ERP_EDI_DROP_DIR set on the server (the directory the partner folders sit under)");
    const base = resolve(env.dropDir!);
    const folder = String(tc.folder ?? "");
    need(/^[A-Za-z0-9_-]{1,60}$/.test(folder), "the partner's drop folder name is letters, digits, - or _");
    // Each company has its own branch of the drop directory: <dir>/<company id>/<folder>/in and out.
    const root = resolve(base, p.entity_id, folder);
    need(root.startsWith(base + pathSep + p.entity_id + pathSep), "the drop folder must sit under the server's EDI drop directory");
    const inbox = join(root, "in"), outbox = join(root, "out"), done = join(root, "in", "done");
    return {
      kind: "dropfolder",
      async send(name, text) {
        await mkdir(outbox, { recursive: true });
        const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
        await writeFile(join(outbox, safe), text, { flag: "wx" });
        return `${folder}/out/${safe}`;   // within this company's branch
      },
      async poll() {
        await mkdir(inbox, { recursive: true });
        const out: Arrival[] = [];
        for (const n of (await readdir(inbox, { withFileTypes: true })).filter((x) => x.isFile() && !x.name.startsWith(".")).map((x) => x.name).sort().slice(0, 200)) {
          const st = await stat(join(inbox, n));
          if (st.size > MAX_FILE) continue;
          out.push({ name: n, text: await readFile(join(inbox, n), "utf8"), ref: n });
        }
        return out;
      },
      async done(a) {
        await mkdir(done, { recursive: true });
        await rename(join(inbox, a.ref), join(done, `${Date.now()}-${a.ref}`));
      },
    };
  }
  if (p.transport === "van") {
    const sec = await partnerSecrets(c, p.entity_id, env, p.id);
    const auth = String(tc.auth ?? "bearer");
    const headers: Record<string, string> = {};
    if (auth === "bearer") { need(sec.vanToken || sec.vanApiKey, "the EDI service needs its token; type it under the partner's secrets"); headers.authorization = `Bearer ${sec.vanToken || sec.vanApiKey}`; }
    if (auth === "header") { need(sec.vanApiKey, "the EDI service needs its key; type it under the partner's secrets"); headers[String(tc.headerName || "x-api-key")] = sec.vanApiKey; }
    if (auth === "basic") {
      need(tc.user && sec.vanPassword, "basic authentication needs the user and the password");
      headers.authorization = `Basic ${Buffer.from(`${tc.user}:${sec.vanPassword}`).toString("base64")}`;
    }
    const mask = (t: string) => Object.values(sec).filter((v) => v.length >= 4).reduce((o, v) => o.split(v).join("••••"), t);
    const what = `${p.vendor}'s EDI service`;
    return {
      kind: "van",
      async send(name, text) {
        const r = await call(env, String(tc.sendUrl), { method: "POST", headers: { ...headers, "content-type": "application/edi-x12", "x-filename": name }, body: text }, 30000, what, 2);
        need(r.status >= 200 && r.status < 300, `${what} answered ${r.status}${r.text ? `: ${mask(r.text.slice(0, 160))}` : ""}`);
        return `${new URL(String(tc.sendUrl)).host} (${r.status})`;
      },
      async poll() {
        if (!tc.listUrl) return [];
        const r = await call(env, String(tc.listUrl), { method: "GET", headers: { ...headers, accept: "application/json, application/edi-x12, text/plain" } }, 30000, what, 2);
        need(r.status !== 401 && r.status !== 403, `${what} refused the credentials (${r.status})`);
        need(r.status >= 200 && r.status < 300, `${what} answered ${r.status}`);
        const t = r.text.trim();
        if (!t) return [];
        if (t.startsWith("ISA")) return [{ name: "service-download.edi", text: t, ref: "" }];
        let j: unknown;
        try { j = JSON.parse(t); } catch { throw new EdiError(`${what} answered with something that is neither X12 nor JSON`); }
        const list = Array.isArray(j) ? j : ((j as Record<string, unknown>).documents ?? (j as Record<string, unknown>).items ?? (j as Record<string, unknown>).data ?? []) as unknown[];
        need(Array.isArray(list), `${what} answered JSON with no list of documents`);
        return (list as Record<string, unknown>[]).slice(0, 200).map((d, i) => ({ name: String(d.name ?? d.filename ?? `document-${d.id ?? i}`), ref: String(d.id ?? ""),
          text: String(d.content ?? d.edi ?? d.data ?? "") })).filter((a) => a.text.length && a.text.length <= MAX_FILE);
      },
      async done(a) {
        if (!tc.ackUrl || !a.ref) return;
        await call(env, String(tc.ackUrl), { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ id: a.ref }) }, 30000, what, 2);
      },
    };
  }
  const note = transportNote(p)!;
  const refuse = async (): Promise<never> => { throw new EdiError(note); };
  return { kind: p.transport, send: refuse, poll: refuse };
}

const fileName = (p: Partner, type: string, ctl: string) => `${type}-${p.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${ctl}.edi`;

/** Send one queued (or failed) outbound document through the partner's transport. Never throws for a transport failure: the document records it. */
export async function dispatch(c: Client, s: Scope, env: EdiEnv, docId: string) {
  const d = (await q<{ id: string; partner_id: string | null; status: string; raw: string; doc_type: string; isa_control: string | null; purchase_order_id: string | null;
    filename: string | null; summary: Record<string, unknown> }>(c,
    `select id, partner_id, status, raw, doc_type, isa_control, purchase_order_id, filename, summary from edi_document where id = $1 and entity_id = $2 and direction = 'out' for update`, [docId, s.entityId]))[0];
  need(d, "no such outbound document");
  need(["queued", "failed"].includes(d.status), `that document is ${d.status}; only a queued or failed one is sent`);
  need(d.partner_id, "that document has no trading partner to send it to");
  const p = await loadPartner(c, s.entityId, d.partner_id!);
  try {
    const t = await transportFor(c, p, env);
    const where = await t.send(d.filename || fileName(p, d.doc_type, d.isa_control ?? d.id.slice(0, 8)), d.raw);
    await setDoc(c, s, d.id, { status: "sent", reason: null, attempt: true });
    if (d.doc_type === "850" && d.purchase_order_id && !d.summary?.test) await pur.markSent(c, s, d.purchase_order_id, where, `EDI 850, interchange ${d.isa_control}`);
    return { id: d.id, status: "sent", detail: `sent to ${where}` };
  } catch (e) {
    if (e instanceof ManualHold) { await setDoc(c, s, d.id, { status: "queued", reason: null }); return { id: d.id, status: "queued", detail: e.message }; }
    const why = refusal(e);
    if (!why) throw e;
    await setDoc(c, s, d.id, { status: "failed", reason: why, attempt: true });
    return { id: d.id, status: "failed", detail: why };
  }
}

/** A manual partner's outbound file, handed to a person: they send it, so it counts as sent. */
export async function takeDownload(c: Client, s: Scope, docId: string) {
  const d = (await q<{ id: string; status: string; raw: string; filename: string | null; doc_type: string; isa_control: string | null; purchase_order_id: string | null; summary: Record<string, unknown> }>(c,
    `select id, status, raw, filename, doc_type, isa_control, purchase_order_id, summary from edi_document where id = $1 and entity_id = $2 and direction = 'out' for update`, [docId, s.entityId]))[0];
  need(d, "no such outbound document");
  if (d.status === "queued" || d.status === "failed") {
    await setDoc(c, s, d.id, { status: "sent", reason: null, attempt: true });
    if (d.doc_type === "850" && d.purchase_order_id && !d.summary?.test) await pur.markSent(c, s, d.purchase_order_id, d.filename ?? "download", `EDI 850 downloaded to send by hand, interchange ${d.isa_control}`);
  }
  await audit(c, s, { table: "edi_document", rowId: d.id, action: "update", after: { downloaded: true } });
  return { filename: d.filename ?? `${d.doc_type}-${d.isa_control}.edi`, text: d.raw };
}

// ------------------------------------------------------------ outbound --

/** Build an 850 for a PO in this partner's envelope. */
export async function build850(c: Client, s: Scope, p: Partner, poId: string, opts: { usage?: "T" | "P"; test?: boolean } = {}) {
  const od = await pur.orderDocument(c, s, poId);
  const lines: x12.PoLine850[] = [];
  for (const l of od.lines) {
    const options = pur.vendorCodesOf(l.config);
    lines.push({ line: l.seq, qty: Number(l.qty), uom: "EA", unitMinor: BigInt(l.unit), vendorSku: (await vendorItemFor(c, p, l.product_id, l.vendor_sku)) ?? undefined,
      ourSku: l.sku ?? undefined, upc: l.barcode ?? undefined, description: l.description, options, customerOrder: l.agreement_ref });
  }
  const o = p.options ?? {};
  const plus = (iso: string, n: number | null | undefined) => { if (n == null) return null; const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const po850: x12.Po850 = { poNumber: od.po.number, date: od.po.ordered_on, purpose: od.po.exported_at ? "05" : "00", orderType: od.po.kind === "special" ? "SP" : "SA",
    vendorAccount: od.vendor.account_no, requestedOn: od.po.expected_on,
    shipTo: { code: od.po.code, name: od.po.name, address1: od.po.address?.line1, city: od.po.address?.city, state: od.po.address?.state, postal: od.po.address?.postal },
    billTo: o.billTo ?? null, vendor: o.vendorN1 ? { name: od.vendor.name, code: od.vendor.account_no ?? undefined } : null,
    td5: o.td5 ?? null, fob: o.fob ?? null, contact: o.contact ?? null,
    shipBy: plus(od.po.ordered_on, o.shipByDays), cancelAfter: plus(od.po.ordered_on, o.cancelAfterDays), lines };
  const ctl = await nextControls(c, p);
  const text = x12.writeInterchange(envelopeFor(p, ctl, opts.usage), [{ type: "850", control: ctl.st, segments: x12.build850(po850, { itemIds: o.itemIds, refs: o.refs }) }], sepsOf(p), { newline: true });
  return { text, ctl, po850 };
}

/** Queue the PO's 850 for its partner and try to send it now. */
export async function queue850(c: Client, s: Scope, env: EdiEnv, poId: string) {
  const po = (await q<{ vendor_id: string; number: string; status: string }>(c, `select vendor_id, number, status from purchase_order where id = $1 and entity_id = $2`, [poId, s.entityId]))[0];
  need(po, "no such purchase order");
  const p = await partnerForVendor(c, s.entityId, po.vendor_id);
  need(p, `${po.number}'s vendor is not set up as an EDI trading partner; set it up under Setup, Vendor EDI`);
  need(p!.edi_enabled, `EDI is switched off for ${p!.vendor}`);
  need(p!.documents["850"] === "edi", `${p!.vendor} takes purchase orders by ${p!.documents["850"]}, not EDI; change it on the trading partner`);
  const b = await build850(c, s, p!, poId);
  const id = await logDoc(c, s, { partner: p, direction: "out", type: "850", status: "queued", raw: b.text, isa: String(b.ctl.isa).padStart(9, "0"), gs: String(b.ctl.gs),
    st: String(b.ctl.st).padStart(4, "0"), usage: p!.usage, poId, filename: fileName(p!, "850", String(b.ctl.isa).padStart(9, "0")),
    summary: { poNumber: b.po850.poNumber, lines: b.po850.lines.length, purpose: b.po850.purpose, shipTo: b.po850.shipTo.code } });
  await audit(c, s, { table: "edi_document", rowId: id, action: "insert", after: { type: "850", po: po.number } });
  return { documentId: id, ...(await dispatch(c, s, env, id)) };
}

/**
 * Send a PO by the channel its vendor's partner names for 850s: EDI, the
 * vendor's order API, email or a file. With no partner, purchasing's own
 * send (email when there is an order address, otherwise the file).
 */
export async function sendOrder(c: Client, s: Scope, env: EdiEnv, poId: string) {
  const po = (await q<{ vendor_id: string; number: string }>(c, `select vendor_id, number from purchase_order where id = $1 and entity_id = $2`, [poId, s.entityId]))[0];
  need(po, "no such purchase order");
  const p = await partnerForVendor(c, s.entityId, po.vendor_id);
  const ch = p ? p.documents["850"] ?? "edi" : null;
  if (p && ch === "edi" && p.edi_enabled) return { channel: "edi", ...(await queue850(c, s, env, poId)) };
  if (p && ch === "off") return { channel: "off", status: "held", detail: `${p.vendor}'s purchase orders are set to go by no channel; send it from the PO` };
  if (ch === "api") {
    const r = await pur.sendPO(c, s, poId, "api", env) as Awaited<ReturnType<typeof pur.sendPO>> & { request?: string; response?: string };
    const docId = await logDoc(c, s, { partner: p, vendorId: po.vendor_id, direction: "out", type: "850", channel: "api", status: r.status === "sent" ? "sent" : "failed",
      reason: r.status === "sent" ? null : r.detail, raw: r.request ?? "{}", poId, summary: { poNumber: po.number, destination: r.destination, vendorRef: r.vendorRef ?? null, response: r.response ?? null,
        acknowledged: (r as { acknowledged?: string | null }).acknowledged ?? null } });
    return { channel: "api", documentId: docId, status: r.status, detail: r.detail };
  }
  const vp = (await q<{ order_email: string | null }>(c, `select order_email from vendor_profile where entity_id = $1 and vendor_id = $2`, [s.entityId, po.vendor_id]))[0];
  const method = ch === "email" || ch === "file" ? ch : vp?.order_email ? "email" : "file";
  const r = await pur.sendPO(c, s, poId, method as pur.SendMethod, env);
  return { channel: method, status: r.status, detail: r.detail };
}

/** A test 850 to the partner, in test mode (ISA15 = T): the vendor's newest open PO if there is one, otherwise a made-up one. No PO is marked sent. */
export async function sendTest850(c: Client, s: Scope, env: EdiEnv, partnerId: string) {
  const p = await loadPartner(c, s.entityId, partnerId);
  need(p.our_isa_id && p.their_isa_id, "give our ISA id and theirs before sending a test");
  const po = (await q<{ id: string }>(c, `select id from purchase_order where entity_id = $1 and vendor_id = $2 and status = 'open' and ship_to_location_id is not null
                                           order by ordered_on desc, number desc limit 1`, [s.entityId, p.vendor_id]))[0];
  let text: string, ctl: { isa: number; gs: number; st: number }, summary: Record<string, unknown>;
  if (po) {
    const b = await build850(c, s, p, po.id, { usage: "T" });
    text = b.text; ctl = b.ctl; summary = { test: true, poNumber: b.po850.poNumber, lines: b.po850.lines.length, note: "a copy of an open PO, marked test" };
  } else {
    ctl = await nextControls(c, p);
    const today = await bizToday(c, s);
    const po850: x12.Po850 = { poNumber: `TEST-${String(ctl.isa).padStart(6, "0")}`, date: today, shipTo: { code: "TEST", name: "Test ship-to" },
      lines: [{ line: 1, qty: 1, unitMinor: 100n, vendorSku: "TEST-ITEM", description: "Test line, do not ship" }] };
    text = x12.writeInterchange(envelopeFor(p, ctl, "T"), [{ type: "850", control: ctl.st, segments: x12.build850(po850) }], sepsOf(p), { newline: true });
    summary = { test: true, poNumber: po850.poNumber, lines: 1, note: "a made-up order, marked test" };
  }
  const isa = String(ctl.isa).padStart(9, "0");
  const id = await logDoc(c, s, { partner: p, direction: "out", type: "850", status: "queued", raw: text, isa, gs: String(ctl.gs), st: String(ctl.st).padStart(4, "0"),
    usage: "T", filename: `test-${fileName(p, "850", isa)}`, summary });
  await audit(c, s, { table: "edi_document", rowId: id, action: "insert", after: { type: "850", test: true } });
  return { documentId: id, ...(await dispatch(c, s, env, id)), text };
}

// ------------------------------------------------------------- inbound --

export type Received = { documents: { id: string; type: string; status: string; reason: string | null; control: string | null }[]; acks: string[]; partner: string | null };

/** Mask the ISA authorization and security fields (ISA02, ISA04) before a raw file is shown. */
export function maskIsa(raw: string): string {
  try {
    const sp = x12.detectSeparators(raw);
    const at = raw.indexOf("ISA");
    const end = raw.indexOf(sp.segment, at);
    const f = raw.slice(at, end).split(sp.element);
    if (f.length < 17) return raw;
    if (f[2].trim()) f[2] = "•".repeat(f[2].length);
    if (f[4].trim()) f[4] = "•".repeat(f[4].length);
    return raw.slice(0, at) + f.join(sp.element) + raw.slice(end);
  } catch { return raw; }
}

/**
 * Take in one file, from any door (an upload, a drop folder, a VAN). The
 * interchange is checked whole; each transaction set is then applied on its
 * own, or quarantined with the reason, or ignored as a repeat. Each group is
 * answered with a 997 when the partner exchanges them.
 */
/** Who may take in which documents by hand: an A/P clerk takes bills (810) only. */
export const UPLOAD_ROLES: Record<string, string[]> = {
  "810": ["ap_clerk", "buyer"], "855": ["buyer"], "856": ["buyer", "store_manager"], "846": ["buyer", "store_manager"],
  "832": ["buyer"], "997": ["buyer", "store_manager", "ap_clerk"],
};
/** A person taking in a file must hold the roles for every document type in it (the owner holds all). The scheduler takes in what its partners send. */
async function mayTakeIn(c: Client, s: Scope, types: string[]) {
  if (s.actor.kind !== "user" || !types.length) return;
  const held = new Set((await q<{ role: string }>(c, `
    select distinct g.role from role_grant g join app_user u on u.id = g.app_user_id
     where g.app_user_id = $2 and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = $3))`, [s.entityId, s.actor.id ?? null, s.tenantId])).map((x) => x.role));
  if (held.has("owner")) return;
  for (const ty of types) {
    const roles = UPLOAD_ROLES[ty] ?? ["buyer"];
    need(roles.some((r) => held.has(r)), `taking in ${x12.DOC_NAMES[ty] ? `a ${ty} (${x12.DOC_NAMES[ty].toLowerCase()})` : `a ${ty || "blank"} document`} needs one of: ${roles.map((r) => r.replace(/_/g, " ")).join(", ")}`);
  }
}

/** The document types an X12 file carries, for checking who may upload it before anything is stored. Unreadable files carry none. */
export function typesIn(text: string): string[] {
  try { return [...new Set(x12.parseInterchange(text).groups.flatMap((g) => g.sets.map((x) => x.type)))]; } catch { return []; }
}

/**
 * Take in one file, from any door (an upload, a drop folder, a VAN). The
 * interchange is checked whole and stored once; each transaction set is then
 * applied on its own, or quarantined with the reason, or ignored as a
 * repeat. Each group is answered with a 997 when the partner exchanges them.
 */
export async function receiveFile(c: Client, s: Scope, env: EdiEnv, f: { text: string; filename?: string | null; partnerId?: string | null }): Promise<Received> {
  const text = String(f.text ?? "");
  need(text.trim(), "the file is empty");
  need(text.length <= MAX_FILE, "the file is over 20 MB");
  await mayTakeIn(c, s, typesIn(text));
  const out: Received = { documents: [], acks: [], partner: null };
  let ixId: string | null = null;
  const whole = async (partner: Partner | null, reason: string, type = "unknown", ix?: x12.Interchange) => {
    ixId = ixId ?? await storeInterchange(c, s, partner, text, f.filename ?? null, ix?.control ?? null);
    const id = await logDoc(c, s, { partner, direction: "in", type, status: "quarantined", reason, raw: null, interchangeId: ixId, filename: f.filename,
      isa: ix?.control ?? null, usage: ix?.usage ?? null, summary: { sha256: sha256(Buffer.from(text)), bytes: text.length } });
    out.documents.push({ id, type, status: "quarantined", reason, control: ix?.control ?? null });
    return out;
  };
  const given = f.partnerId ? await loadPartner(c, s.entityId, f.partnerId) : null;
  let ix: x12.Interchange;
  try { ix = x12.parseInterchange(text); }
  catch (e) { if (e instanceof x12.X12Error) return whole(given, e.message); throw e; }
  const firstType = ix.groups[0]?.sets[0]?.type && x12.FUNCTIONAL_ID[ix.groups[0].sets[0].type] ? ix.groups[0].sets[0].type : "unknown";
  const p = await partnerForInterchange(c, s.entityId, ix);
  if (!p) return whole(given, `no trading partner here has ISA id ${ix.sender.qual}/${ix.sender.id}; set the vendor up under Setup, Vendor EDI, or check the file`, firstType, ix);
  out.partner = p.vendor;
  if (given && given.id !== p.id) return whole(given, `this file is from ${p.vendor} (ISA ${ix.sender.id}), not ${given.vendor}`, firstType, ix);
  if (!addressedTo(ix, p)) {
    return whole(p, `this file is addressed to ${ix.receiver.qual}/${ix.receiver.id}, not to our ISA id ${p.our_isa_qual}/${p.our_isa_id}`, firstType, ix);
  }
  if (!p.edi_enabled) return whole(p, `EDI is switched off for ${p.vendor}; switch it on to take this file`, firstType, ix);
  if (ix.usage !== p.usage) {
    return whole(p, ix.usage === "T" ? `a test file arrived, but ${p.vendor} is in production; nothing from it was applied`
      : `a production file arrived, but ${p.vendor} is still set to test; move the partner to production when the vendor says so`, firstType, ix);
  }
  if (!ix.groups.length) return whole(p, [...ix.errors].join("; ") || "the interchange holds no documents", "unknown", ix);
  ixId = await storeInterchange(c, s, p, text, f.filename ?? null, ix.control);
  const envProblems = [...ix.errors, ...ix.groups.flatMap((g) => g.errors)];
  for (const g of ix.groups) {
    const verdicts = new Map<string, string | null>();
    for (const set of g.sets) {
      const r = await processSet(c, s, env, p, ix, g, set, ixId, f.filename ?? null, envProblems, null);
      out.documents.push({ id: r.id, type: set.type, status: r.status, reason: r.reason, control: set.control });
      verdicts.set(set.control, r.syntax);
    }
    if (g.functionalId !== "FA" && p.documents["997"] === "edi" && g.sets.length) {
      const ackId = await queue997(c, s, env, p, g, verdicts, out.documents[out.documents.length - 1]?.id ?? null);
      out.acks.push(ackId);
    }
  }
  return out;
}

/** The partner a file is from: its ISA sender, in this company. */
async function partnerForInterchange(c: Client, entityId: string, ix: x12.Interchange): Promise<Partner | null> {
  return (await q<Partner>(c, `select p.*, coalesce(v.dba, v.legal_name) vendor from edi_partner p join vendor v on v.id = p.vendor_id
                                where p.entity_id = $1 and p.their_isa_qual = $2 and upper(p.their_isa_id) = upper($3)`, [entityId, ix.sender.qual, ix.sender.id]))[0] ?? null;
}
const addressedTo = (ix: x12.Interchange, p: Pick<Partner, "our_isa_qual" | "our_isa_id">) =>
  ix.receiver.qual === p.our_isa_qual && ix.receiver.id.toUpperCase() === p.our_isa_id.toUpperCase();

async function queue997(c: Client, s: Scope, env: EdiEnv, p: Partner, g: x12.ParsedGroup, verdicts: Map<string, string | null>, relatedId: string | null, send = true) {
  const ack = x12.ackFor(g, verdicts);
  const ctl = await nextControls(c, p);
  const text = x12.writeInterchange(envelopeFor(p, ctl), [{ type: "997", control: ctl.st, segments: x12.build997(ack) }], sepsOf(p), { newline: true });
  const isa = String(ctl.isa).padStart(9, "0");
  const id = await logDoc(c, s, { partner: p, direction: "out", type: "997", status: "queued", raw: text, isa, gs: String(ctl.gs), st: String(ctl.st).padStart(4, "0"),
    usage: p.usage, relatedId, filename: fileName(p, "997", isa), summary: { answers: `${g.functionalId} group ${g.control}`, status: ack.status, accepted: ack.accepted, of: ack.included } });
  // The scheduler sends queued documents each in their own transaction; a person's upload sends now.
  if (send && !(s.actor.kind === "system")) await dispatch(c, s, env, id);
  return id;
}

/**
 * Apply one transaction set (new, or a quarantined one again), inside a
 * savepoint. Returns, besides the outcome, the set's syntax verdict for the
 * 997: an AK5 code when the set itself is malformed, null when it is sound
 * (a business refusal, such as an unknown PO, is ours to hold, not a syntax error).
 */
async function processSet(c: Client, s: Scope, env: EdiEnv, p: Partner, ix: x12.Interchange, g: x12.ParsedGroup, set: x12.ParsedSet, interchangeId: string,
  filename: string | null, envProblems: string[], existingId: string | null): Promise<{ id: string; status: string; reason: string | null; syntax: string | null }> {
  const type = x12.FUNCTIONAL_ID[set.type] ? set.type : "unknown";
  const base = { partner: p, direction: "in" as const, type, raw: null, interchangeId, filename, isa: ix.control, gs: g.control, st: set.control, usage: ix.usage };
  let syntax: string | null = null;
  const finish = async (status: string, reason: string | null, extra: { summary?: unknown; poId?: string | null; invoiceId?: string | null; relatedId?: string | null } = {}) => {
    if (existingId) { await setDoc(c, s, existingId, { status, reason, ...extra, attempt: true }); return { id: existingId, status, reason, syntax }; }
    return { id: await logDoc(c, s, { ...base, status, reason, ...extra }), status, reason, syntax };
  };
  // A repeat of a set already taken (same sender and control numbers) is logged and left alone.
  const dup = (await q<{ id: string; status: string }>(c, `
    select id, status from edi_document where entity_id = $1 and partner_id = $2 and direction = 'in' and doc_type = $3 and isa_control = $4 and gs_control = $5 and st_control = $6
       and status not in ('quarantined','ignored') and id is distinct from $7 limit 1`, [s.entityId, p.id, type, ix.control, g.control, set.control, existingId]))[0];
  if (dup) return finish("ignored", `a repeat of a ${x12.DOC_NAMES[type] ?? type} already received with the same control numbers (${ix.control}/${g.control}/${set.control}); not applied again`, { relatedId: dup.id });
  const parsed = type === "unknown" ? { errors: [] as string[] } : x12.readSet(set) as { errors: string[] } & Record<string, unknown>;
  syntax = x12.syntaxCode(set, parsed.errors) ?? (envProblems.length ? "5" : null);
  if (type === "unknown") return finish("quarantined", `transaction set ${set.type || "(blank)"} is not one this system reads`);
  if (x12.FUNCTIONAL_ID[type] !== g.functionalId) { syntax = "6"; return finish("quarantined", `a ${type} sits in a ${g.functionalId} group; the sender's envelope is wrong`); }
  if (type === "850") { syntax = "1"; return finish("quarantined", "an 850 is a purchase order we send; vendors do not send us one"); }
  if (type !== "997" && p.documents[type] !== "edi") {
    const by = { api: "by its API feed", file: "as a file to import", email: "by email", off: "by no channel" }[p.documents[type] ?? "off"] ?? "another way";
    return finish("quarantined", `${p.vendor}'s ${x12.DOC_NAMES[type].toLowerCase()}s (${type}) are set to come ${by}, not EDI; change it on the trading partner to take this one`);
  }
  if (envProblems.length) return finish("quarantined", `the envelope is not sound: ${envProblems.slice(0, 3).join("; ")}`);
  const problems = [...set.errors, ...parsed.errors];
  const summary = summarize(type, parsed);
  if (problems.length) return finish("quarantined", problems.slice(0, 4).join("; "), { summary });
  await c.query("savepoint edi_set");
  try {
    const r = await applySet(c, s, env, p, type, parsed, existingId);
    await c.query("release savepoint edi_set");
    return finish("applied", null, { summary: { ...summary, ...r.summary }, poId: r.poId ?? null, invoiceId: r.invoiceId ?? null, relatedId: r.relatedId ?? null });
  } catch (e) {
    await c.query("rollback to savepoint edi_set");
    const why = refusal(e);
    if (!why) throw e;
    return finish("quarantined", why, { summary });
  }
}

function summarize(type: string, v: Record<string, unknown>): Record<string, unknown> {
  const o = { ...v };
  delete o.errors;
  if (type === "832" && Array.isArray(o.items)) { o.itemCount = (o.items as unknown[]).length; o.items = (o.items as unknown[]).slice(0, 25); }
  if (type === "846" && Array.isArray(o.items)) { o.itemCount = (o.items as unknown[]).length; o.items = (o.items as unknown[]).slice(0, 25); }
  return x12.summaryOf(o) as Record<string, unknown>;
}

async function poByNumber(c: Client, p: Partner, number: string) {
  const po = (await q<{ id: string; number: string }>(c, `select id, number from purchase_order where entity_id = $1 and vendor_id = $2 and upper(number) = upper($3)`,
    [p.entity_id, p.vendor_id, number.trim()]))[0];
  need(po, `${p.vendor} has no purchase order ${number || "(blank)"} here`);
  return po;
}

/**
 * Who entered a bill: the person who uploaded it, or, for one the scheduler
 * brought in, the client's own "EDI intake" user. That user holds no roles
 * and cannot sign in, so any real approver may approve the bill.
 */
async function makerOf(c: Client, s: Scope): Promise<string> {
  if (s.actor.kind === "user" && s.actor.id) return s.actor.id;
  const email = "edi-intake@system.invalid";
  const u = (await q<{ id: string }>(c, `select id from app_user where tenant_id = $1 and email = $2 /* unscoped: the client's own system user */`, [s.tenantId, email]))[0];
  if (u) return u.id;
  return (await one<{ id: string }>(c, `insert into app_user (tenant_id, email, name, status) values ($1,$2,'EDI intake (automatic)','disabled') returning id
    /* unscoped: a user belongs to the client, not one company */`, [s.tenantId, email])).id;
}

async function applySet(c: Client, s: Scope, _env: EdiEnv, p: Partner, type: string, v: Record<string, unknown>, selfId: string | null):
  Promise<{ summary?: Record<string, unknown>; poId?: string; invoiceId?: string; relatedId?: string }> {
  if (type === "855") {
    const a = v as unknown as x12.Ack855;
    const po = await poByNumber(c, p, a.poNumber);
    // Several ACKs under one PO1 split the line (2 accepted + 2 backordered): one answer per PO line.
    const byLine = new Map<string, { seq: number; acks: x12.AckLine855[] }>();
    for (const l of a.lines) {
      const pl = await poLineFor(c, p, po.id, { line: l.line, vendorSku: l.vendorSku });
      if (!byLine.has(pl.id)) byLine.set(pl.id, { seq: pl.seq, acks: [] });
      byLine.get(pl.id)!.acks.push(l);
    }
    let lines: pur.AckLine[] = [];
    const splits: string[] = [], prices: string[] = [];
    for (const [lineId, g] of byLine) {
      const open = await q<{ open: string; unit: string }>(c, `select (quantity - cancelled_qty)::text open, unit_price_minor::text unit from purchase_order_line where id = $1 and entity_id = $2`, [lineId, p.entity_id]);
      const openQty = Number(open[0].open);
      const kinds = new Set(g.acks.map((x) => x.status));
      const dates = g.acks.map((x) => x.date).filter(Boolean).sort() as string[];
      const rejectedQty = g.acks.filter((x) => x.status === "reject").reduce((t, x) => t + (x.qty ?? 0), 0);
      const keptQty = g.acks.filter((x) => x.status !== "reject").reduce((t, x) => t + (x.qty ?? 0), 0);
      let ack: pur.AckLine;
      if (g.acks.length === 1) {
        const x = g.acks[0];
        ack = { lineId, status: x.status, qty: x.qty ?? null, expectedOn: x.date ?? null };
        if (x.status === "change" && x.qty == null) ack.qty = openQty;
      } else {
        // The line ships what is not rejected; it is due when its last part is.
        need(!g.acks.some((x) => x.qty == null), `line ${g.seq} is split across ${g.acks.length} answers, but not every answer gives its quantity`);
        need(keptQty + rejectedQty <= openQty + 0.0005, `line ${g.seq} is split into ${keptQty + rejectedQty}, more than the ${openQty} on order`);
        const status = !keptQty ? "reject" : kinds.has("backorder") ? "backorder" : keptQty < openQty ? "change" : "accept";
        ack = { lineId, status, qty: status === "reject" ? null : keptQty, expectedOn: dates.at(-1) ?? null };
        if (status === "backorder" && keptQty < openQty) {
          // backordered and fewer: cut the rest first, then mark the remainder backordered
          lines.push({ lineId, status: "change", qty: keptQty, expectedOn: dates.at(-1) ?? null });
          ack = { lineId, status: "backorder", expectedOn: dates.at(-1) ?? null };
        }
        splits.push(`line ${g.seq}: ${g.acks.map((x) => `${x.qty} ${x.status}${x.date ? ` ${x.date}` : ""}`).join(" + ")}`);
      }
      // A price change (IP, or a changed line carrying a new price) changes the PO line and flags it for the buyer.
      const priced = g.acks.find((x) => x.unitMinor != null && x.unitMinor !== BigInt(open[0].unit) && (x.code === "IP" || x.code === "IC" || x.code === "IS"));
      if (priced) {
        await pur.vendorPriceChange(c, s, lineId, priced.unitMinor!, `${p.vendor} changed the price in its 855 (${priced.code})`);
        prices.push(`line ${g.seq} ${x12.fromMinor(BigInt(open[0].unit))} to ${x12.fromMinor(priced.unitMinor!)}`);
      }
      lines.push(ack);
    }
    if (!lines.length && (a.ackType === "RJ" || a.ackType === "AK" || a.ackType === "AT")) {
      const all = await q<{ id: string }>(c, `select id from purchase_order_line where entity_id = $1 and purchase_order_id = $2 and quantity > cancelled_qty`, [p.entity_id, po.id]);
      lines = all.map((x) => ({ lineId: x.id, status: a.ackType === "RJ" ? "reject" : "accept", expectedOn: a.shipDate ?? null }));
    }
    need(lines.length, "the 855 acknowledges no lines");
    // A line answered twice (a cut, then a backorder) goes through as two acknowledgments, in order.
    const first = lines.filter((l, i) => lines.findIndex((x) => x.lineId === l.lineId) === i);
    const second = lines.filter((l, i) => lines.findIndex((x) => x.lineId === l.lineId) !== i);
    const r = await pur.acknowledgePO(c, s, po.id, { vendorRef: a.vendorRef ?? null, expectedOn: a.shipDate ?? null, lines: first });
    if (second.length) await pur.acknowledgePO(c, s, po.id, { vendorRef: a.vendorRef ?? null, expectedOn: a.shipDate ?? null, lines: second });
    return { poId: po.id, summary: { applied: `${r.lines} lines on ${r.number}`, expectedOn: r.expectedOn, cancelled: r.cancelled,
      ...(splits.length ? { split: splits.join("; ") } : {}), ...(prices.length ? { priceChanges: `${prices.join("; ")} (flagged for the buyer to review)` } : {}) } };
  }
  if (type === "856") {
    const a = v as unknown as x12.Asn856;
    let firstPo: string | undefined;
    const done: string[] = [];
    const shipped: { shipmentId: string; poLineId: string; qty: number }[] = [];
    const serialNotes: string[] = [];
    for (const o of a.orders) {
      const po = await poByNumber(c, p, o.poNumber);
      firstPo = firstPo ?? po.id;
      const lines: pur.ShipLine[] = [];
      const ids: { lineId: string; serials: string[]; lot?: string }[] = [];
      for (const l of o.lines) {
        const pl = await poLineFor(c, p, po.id, l);
        lines.push({ lineId: pl.id, qty: l.qty });
        if (l.serials?.length || l.lot) ids.push({ lineId: pl.id, serials: l.serials ?? [], lot: l.lot });
      }
      // Serials and lots the vendor sent: receiving uses them when the dock does not scan its own.
      for (const x of ids) {
        await c.query("savepoint asn_serials");
        try {
          await inventory.expectSerials(c, s, { poLineId: x.lineId, serials: x.serials, lot: x.lot ?? null, reference: a.shipmentId, source: "asn" });
          await c.query("release savepoint asn_serials");
        } catch (e) {
          await c.query("rollback to savepoint asn_serials");
          if (!(e instanceof inventory.InventoryError)) throw e;
          serialNotes.push(`serials not kept for ${o.poNumber}: ${e.message}`);
        }
      }
      const r = await pur.recordShipment(c, s, po.id, { asn: a.shipmentId, shippedOn: a.shippedOn ?? a.date ?? null, expectedOn: a.deliveryOn ?? null,
        carrier: a.carrierName || a.carrier || null, tracking: a.tracking || a.bol || null, lines, source: "edi", documentId: selfId, equipment: a.equipment ?? null });
      done.push(`${r.units} units on ${r.number}`);
      for (const x of r.shipped) shipped.push({ shipmentId: r.shipmentId, ...x });
    }
    // A notice that names its container or trailer attaches to it (and opens one if we had not booked it yet).
    let container: string | null = null;
    // The shipment stands whatever happens to the link: a link that cannot be made is a note, not a quarantine.
    const notes: string[] = [...serialNotes];
    if (a.equipment) {
      await c.query("savepoint asn_container");
      try {
        const ct = await wms.attachShipment(c, s, { equipment: a.equipment, vendorId: p.vendor_id, carrier: a.carrierName || a.carrier || null, bol: a.bol ?? null,
          shippedOn: a.shippedOn ?? a.date ?? null, deliveryOn: a.deliveryOn ?? null, shipped });
        await c.query("release savepoint asn_container");
        notes.push(...ct.notes);
        if (ct.number && !ct.notes.some((n) => /already unloaded/.test(n))) { container = ct.number; done.push(`on container ${ct.containerNo} (${ct.number})`); }
      } catch (e) {
        await c.query("rollback to savepoint asn_container");
        if (!(e instanceof wms.WmsError)) throw e;
        notes.push(`not linked to container ${a.equipment}: ${e.message}`);
      }
    }
    return { poId: firstPo, summary: { applied: done.join(", "), container, notes: notes.length ? notes : undefined } };
  }
  if (type === "810") {
    const inv = v as unknown as x12.Invoice810;
    const po = await poByNumber(c, p, inv.poNumber);
    const lines: { poLineId: string; qty: number; unitMinor: bigint; description?: string | null }[] = [];
    for (const l of inv.lines) {
      const pl = await poLineFor(c, p, po.id, l);
      lines.push({ poLineId: pl.id, qty: l.qty, unitMinor: l.unitMinor, description: l.description ?? null });
    }
    const maker = await makerOf(c, s);
    const b = await enterVendorBill(c, s, { vendorId: p.vendor_id, poId: po.id, reference: inv.invoiceNumber, invoiceDate: inv.invoiceDate!, termsDays: inv.termsDays ?? null,
      lines, charges: inv.charges.map((ch) => ({ description: ch.description, amountMinor: ch.amountMinor })), totalMinor: inv.totalMinor }, maker);
    return { poId: po.id, invoiceId: b.invoiceId, summary: { bill: inv.invoiceNumber, billStatus: b.status, billReason: b.reason, posted: !!b.journalId } };
  }
  if (type === "832") {
    const cat = v as unknown as x12.Catalog832;
    const known = new Map((await q<{ sku: string; name: string }>(c, `select upper(vendor_sku) sku, name from product where entity_id = $1 and vendor_id = $2 and vendor_sku is not null`,
      [p.entity_id, p.vendor_id])).map((x) => [x.sku, x.name]));
    // Our names stay ours: a known model keeps its name; a new one is named by the vendor's description.
    const rows = cat.items.filter((it) => !it.swatch && (it.description || it.cubicFt != null || it.weightLb != null || it.upc)).map((it) => ({
      vendor_sku: it.vendorSku, name: known.get(it.vendorSku) ?? it.description ?? it.vendorSku, description: it.description ?? "", barcode: it.upc ?? "",
      cubic_ft: it.cubicFt != null ? String(it.cubicFt) : "", weight_lb: it.weightLb != null ? String(it.weightLb) : "",
    }));
    let cat_ = { added: 0, changed: 0 };
    if (rows.length) cat_ = await applyCatalogRows(c, s, p.vendor_id, `${p.vendor} 832 ${cat.catalogId}`, rows,
      { vendor_sku: "vendor_sku", name: "name", description: "description", barcode: "barcode", cubic_ft: "cubic_ft", weight_lb: "weight_lb" });
    // Sectional pieces and covers, where the vendor sends them (best effort; never stops the catalog).
    const extras: VendorExtra[] = [];
    for (const it of cat.items) {
      if (it.swatch) extras.push({ kind: "swatch", code: it.vendorSku, name: it.description ?? it.vendorSku, grade: it.swatch.grade, color: it.swatch.color ?? null,
        colorFamily: it.swatch.colorFamily ?? null, content: it.swatch.content ?? null, cleaningCode: it.swatch.cleaning ?? null, discontinuedOn: it.swatch.discontinuedOn ?? null });
      else if (it.sectional?.family && it.sectional.piece) {
        const t = pieceTypeFrom(it.sectional.piece);
        if (t) extras.push({ kind: "piece", vendorSku: it.vendorSku, family: it.sectional.family, familyName: it.sectional.familyName ?? null, pieceType: t,
          motion: /power/i.test(it.sectional.motion ?? "") ? "power" : /manual|recl/i.test(it.sectional.motion ?? "") ? "manual" : "none",
          widthIn: it.widthIn ?? null, depthIn: it.depthIn ?? null, heightIn: it.heightIn ?? null, seats: it.sectional.seats ?? null, gradeAdders: it.sectional.gradeAdders });
      }
    }
    const cx = extras.length ? await applyVendorExtras(c, s, p.vendor_id, extras) : null;
    const prices = cat.items.filter((it) => it.costMinor != null && !it.swatch).map((it) => ({ vendor_sku: it.vendorSku, cost: x12.fromMinor(it.costMinor!),
      map: it.mapMinor != null ? x12.fromMinor(it.mapMinor) : "", msrp: it.msrpMinor != null ? x12.fromMinor(it.msrpMinor) : "", promo_cost: "", effective_from: it.effectiveOn ?? "", effective_to: "" }));
    const rule = ((await q<{ options: Record<string, unknown> }>(c, `select options from vendor_feed where entity_id = $1 and vendor_id = $2 and purpose = 'pricing' and active limit 1`,
      [p.entity_id, p.vendor_id]))[0]?.options?.priceRule ?? {}) as Record<string, unknown>;
    const pr = prices.length ? await recordVendorPrices(c, s, p.vendor_id, null, prices, rule) : { recorded: 0, changed: 0, unknown: 0, bad: 0 };
    need(!pr.bad, `${pr.bad} prices in the catalog could not be read`);
    return { summary: { applied: `${cat.items.length} items: ${cat_.added} products added, ${cat_.changed} changed; ${pr.recorded} prices recorded, ${pr.changed} products repriced`
      + (cx ? `; ${cx.pieces} sectional pieces, ${cx.covers} covers${cx.skipped ? `, ${cx.skipped} not set up` : ""}` : ""), notes: cx?.notes.length ? cx.notes : undefined } };
  }
  if (type === "846") {
    const inv = v as unknown as x12.Inventory846;
    const n = await recordAvailability(c, s, p.vendor_id, inv.items.map((it) => ({ vendor_sku: it.vendorSku, qty: String(it.qty), eta: it.availableOn ?? "" })));
    return { summary: { applied: `availability for ${n} models` } };
  }
  if (type === "997") {
    const a = v as unknown as x12.Ack997;
    const ours = await q<{ id: string; st_control: string; doc_type: string; purchase_order_id: string | null }>(c, `
      select id, st_control, doc_type, purchase_order_id from edi_document where entity_id = $1 and partner_id = $2 and direction = 'out' and gs_control = $3`,
      [p.entity_id, p.id, String(Number(a.groupControl))]);
    need(ours.length, `this 997 answers group ${a.groupControl}, which we did not send to ${p.vendor}`);
    let matched = 0, rejected = 0, first: string | undefined;
    for (const st of a.sets.length ? a.sets : ours.map((o) => ({ type: o.doc_type, control: o.st_control, accepted: a.status === "A" || a.status === "E", notes: [] as string[] }))) {
      const d = ours.find((o) => Number(o.st_control) === Number(st.control));
      if (!d) continue;
      first = first ?? d.id;
      matched++;
      if (st.accepted) await c.query(`update edi_document set status = 'acknowledged', acknowledged_at = now(), reason = null where id = $1 and entity_id = $2 and status in ('sent','queued')`, [d.id, s.entityId]);
      else {
        rejected++;
        await c.query(`update edi_document set status = 'rejected', acknowledged_at = now(), reason = $3 where id = $1 and entity_id = $2`,
          [d.id, s.entityId, `${p.vendor} rejected it in their 997${st.notes?.length ? `: ${st.notes.join("; ")}` : ""}`]);
      }
    }
    need(matched, `this 997 answers transaction sets we did not send in group ${a.groupControl}`);
    return { relatedId: first, poId: ours.find((o) => o.id === first)?.purchase_order_id ?? undefined,
      summary: { applied: `${matched - rejected} acknowledged${rejected ? `, ${rejected} rejected` : ""}` } };
  }
  throw new EdiError(`${type} is not applied by this system`);
}

/** Try a quarantined inbound document again (after fixing the PO, the item map or the partner), or an outbound one that failed. */
export async function retryDocument(c: Client, s: Scope, env: EdiEnv, id: string) {
  const d = (await q<{ id: string; direction: string; status: string; partner_id: string | null; raw: string; st_control: string | null; gs_control: string | null;
    filename: string | null; interchange_id: string | null }>(c,
    `select d.id, d.direction, d.status, d.partner_id, coalesce(d.raw, x.raw) raw, d.st_control, d.gs_control, d.filename, d.interchange_id
       from edi_document d left join edi_interchange x on x.id = d.interchange_id and x.entity_id = d.entity_id
      where d.id = $1 and d.entity_id = $2 for update of d`, [id, s.entityId]))[0];
  need(d, "no such document");
  if (d.direction === "out") return dispatch(c, s, env, id);
  need(d.status === "quarantined", `that document is ${d.status}; only a quarantined one is applied again`);
  await mayTakeIn(c, s, d.st_control ? [(await q<{ t: string }>(c, `select doc_type t from edi_document where id = $1 and entity_id = $2`, [id, s.entityId]))[0].t] : []);
  if (!d.partner_id || !d.st_control) {
    // A whole file that was refused: take it in again from the top, as new documents; this one is superseded.
    const r = await receiveFile(c, s, env, { text: d.raw, filename: d.filename });
    await setDoc(c, s, id, { status: "ignored", reason: "taken in again; the documents that followed carry the outcome", attempt: true });
    await audit(c, s, { table: "edi_document", rowId: id, action: "update", after: { retried: true, documents: r.documents.length } });
    return { id, status: r.documents[0]?.status ?? "quarantined", detail: r.documents[0]?.reason ?? "taken in again", documents: r.documents };
  }
  const p = await loadPartner(c, s.entityId, d.partner_id);
  const ix = x12.parseInterchange(d.raw);
  const g = ix.groups.find((x) => x.control === d.gs_control) ?? ix.groups[0];
  const set = g?.sets.find((x) => x.control === d.st_control);
  need(set, "the stored file no longer holds that transaction set");
  if (!p.edi_enabled) throw new EdiError(`EDI is switched off for ${p.vendor}`);
  const ixId = d.interchange_id ?? await storeInterchange(c, s, p, d.raw, d.filename, ix.control);
  const r = await processSet(c, s, env, p, ix, g, set!, ixId, d.filename, [...ix.errors, ...ix.groups.flatMap((x) => x.errors)], id);
  await audit(c, s, { table: "edi_document", rowId: id, action: "update", after: { retried: true, status: r.status } });
  return { id, status: r.status, detail: r.reason ?? "applied" };
}

// ----------------------------------------------------- polling, sending --

/** Runs one unit of work in its own transaction (db.ts tx in the server and the scheduler). */
export type TxRun = <R>(fn: (c: Client) => Promise<R>) => Promise<R>;

/**
 * Poll one partner's transport and send its queued documents, each step in
 * its own transaction, so a later failure never undoes an earlier one:
 *   - each inbound file is taken in and committed (with its checksum
 *     remembered) before it is moved to done or acknowledged to the VAN; a
 *     file whose checksum was taken before is not taken again, only moved
 *     or acknowledged again, so a move that failed is harmless next run
 *   - a file addressed to another company's ISA id (a mailbox siblings
 *     share) or from another sender is left where it is, untouched
 *   - each queued outbound document is sent and marked sent in its own
 *     transaction, so a later failure cannot send it twice
 * The partner's status line says what happened.
 */
export async function pollPartner(run: TxRun, s: Scope, env: EdiEnv, partnerId: string) {
  let note: string, ok = true, files = 0, seen = 0, left = 0, sent = 0, failedSends = 0;
  const docs: Received["documents"] = [];
  const problems: string[] = [];
  let p: Partner | null = null;
  try {
    const got0 = await run(async (c) => { const pp = await loadPartner(c, s.entityId, partnerId); need(pp.edi_enabled, `EDI is switched off for ${pp.vendor}`);
      return { pp, t: await transportFor(c, pp, env) }; });
    p = got0.pp;
    const t = got0.t;
    const got = await t.poll();
    for (const a of got) {
      let ix: x12.Interchange | null = null;
      try { ix = x12.parseInterchange(a.text); } catch { ix = null; }
      if (ix && (ix.sender.qual !== p.their_isa_qual || ix.sender.id.toUpperCase() !== p.their_isa_id.toUpperCase() || !addressedTo(ix, p))) { left++; continue; }
      const sum = sha256(Buffer.from(a.text));
      const r = await run(async (c) => {
        const before = await q(c, `select 1 from edi_pulled where entity_id = $1 and partner_id = $2 and sha256 = $3`, [s.entityId, p!.id, sum]);
        if (before.length) return null;
        const rr = await receiveFile(c, s, env, { text: a.text, filename: a.name, partnerId: p!.id });
        await c.query(`insert into edi_pulled (entity_id, partner_id, sha256, ref) values ($1,$2,$3,$4) on conflict do nothing`, [s.entityId, p!.id, sum, (a.ref || a.name).slice(0, 200)]);
        return rr;
      });
      if (r) { docs.push(...r.documents); files++; } else seen++;
      // Only now, with the file safely in, is it moved or acknowledged.
      if (t.done) {
        try { await t.done(a); }
        catch (e) { const why = refusal(e) ?? (e as NodeJS.ErrnoException).code ?? "it failed"; problems.push(`${a.name} is in, but could not be moved or acknowledged (${why}); it will not be taken in twice`); }
      }
    }
    if (p.transport !== "manual") {
      const queued = await run((c) => q<{ id: string }>(c, `select id from edi_document where entity_id = $1 and partner_id = $2 and direction = 'out' and status = 'queued' order by created_at limit 100`,
        [s.entityId, p!.id]));
      for (const d of queued) {
        const r = await run((c) => dispatch(c, s, env, d.id));
        if (r.status === "sent") sent++; else if (r.status === "failed") failedSends++;
      }
    }
    note = `${files} ${files === 1 ? "file" : "files"} in (${docs.filter((d) => d.status === "applied").length} applied, ${docs.filter((d) => d.status === "quarantined").length} quarantined)`
      + `${seen ? `, ${seen} already taken in` : ""}${left ? `, ${left} left for another company or sender` : ""}, ${sent} sent${failedSends ? `, ${failedSends} not sent` : ""}`
      + (problems.length ? `; ${problems.join("; ")}` : "");
  } catch (e) {
    const why = refusal(e) ?? (e instanceof Error && (e as NodeJS.ErrnoException).code ? `the drop folder could not be read (${(e as NodeJS.ErrnoException).code})` : null);
    if (!why) throw e;
    ok = false; note = why;
  }
  await run((c) => c.query(`update edi_partner set last_poll_at = now(), last_poll_ok = $3, last_poll_note = $4 where id = $1 and entity_id = $2`, [partnerId, s.entityId, ok, note.slice(0, 500)]));
  return { ok, note, files, documents: docs };
}

/** Run the vendor's order-status (acknowledgments) API feeds now: acknowledgments go to acknowledgePO, "shipped" rows become ship notices. */
export async function pollOrderStatus(c: Client, s: Scope, env: EdiEnv, partnerId: string) {
  const p = await loadPartner(c, s.entityId, partnerId);
  const feeds = await q<{ id: string; name: string }>(c, `select id, name from vendor_feed where entity_id = $1 and vendor_id = $2 and purpose = 'acknowledgments' and active and kind = 'api'`,
    [s.entityId, p.vendor_id]);
  need(feeds.length, `${p.vendor} has no order-status API feed; add an acknowledgments feed under Catalog, Vendors, API setup`);
  const out = [];
  for (const f of feeds) out.push({ name: f.name, ...(await runFeed(c, s, f.id, env, "manual")) });
  return out;
}

// --------------------------------------------------------------- reading --

export async function documents(c: Client, entityId: string, f: { direction?: string | null; status?: string | null; partnerId?: string | null; type?: string | null; limit?: number }) {
  return q(c, `
    select d.id, d.direction, d.doc_type, d.channel, d.status, d.reason, d.isa_control, d.gs_control, d.st_control, d.usage, d.filename, d.summary,
           d.purchase_order_id, po.number po_number, d.invoice_id, i.reference bill_reference, i.status bill_status, d.related_id, d.attempts,
           d.created_at, d.applied_at, d.acknowledged_at, coalesce(v.dba, v.legal_name) vendor, d.partner_id, coalesce(length(d.raw), (select x.bytes from edi_interchange x where x.id = d.interchange_id and x.entity_id = d.entity_id)) bytes
      from edi_document d left join vendor v on v.id = d.vendor_id
      left join purchase_order po on po.id = d.purchase_order_id left join invoice i on i.id = d.invoice_id
     where d.entity_id = $1 and ($2::text is null or d.direction = $2) and ($3::text is null or d.status = $3)
       and ($4::uuid is null or d.partner_id = $4) and ($5::text is null or d.doc_type = $5)
     order by d.created_at desc limit $6`, [entityId, f.direction || null, f.status || null, f.partnerId || null, f.type || null, Math.min(Math.max(f.limit ?? 100, 1), 300)]);
}

export async function documentDetail(c: Client, entityId: string, id: string) {
  const d = (await q<Record<string, unknown> & { raw: string }>(c, `
    select d.*, coalesce(d.raw, x.raw) raw, coalesce(v.dba, v.legal_name) vendor, po.number po_number, i.reference bill_reference, i.status bill_status
      from edi_document d left join vendor v on v.id = d.vendor_id left join purchase_order po on po.id = d.purchase_order_id left join invoice i on i.id = d.invoice_id
      left join edi_interchange x on x.id = d.interchange_id and x.entity_id = d.entity_id
     where d.id = $1 and d.entity_id = $2`, [id, entityId]))[0];
  if (!d) return null;
  const related = await q(c, `select id, direction, doc_type, status, reason, created_at from edi_document where entity_id = $1 and (related_id = $2 or id = $3) and id <> $2 order by created_at`,
    [entityId, id, (d.related_id as string | null) ?? null]);
  return { ...d, raw: d.channel === "edi" ? maskIsa(d.raw) : d.raw, related };
}

/** The PO's trail: 850 out (EDI or API), the vendor's 997, 855, 856 and 810, and the ship notices. */
export async function poTrail(c: Client, entityId: string, poId: string) {
  const docs = await q(c, `
    select d.id, d.direction, d.doc_type, d.channel, d.status, d.reason, d.isa_control, d.created_at, d.summary, d.invoice_id, i.reference bill_reference, i.status bill_status
      from edi_document d left join invoice i on i.id = d.invoice_id
     where d.entity_id = $1 and (d.purchase_order_id = $2
        or d.related_id in (select x.id from edi_document x where x.entity_id = $1 and x.purchase_order_id = $2)
        or d.id in (select x.related_id from edi_document x where x.entity_id = $1 and x.purchase_order_id = $2 and x.doc_type = '850'))
     order by d.created_at`, [entityId, poId]);
  const acked = await q(c, `select a.id, 'in' direction, '997' doc_type, 'edi' channel, a.status, a.reason, a.isa_control, a.created_at, a.summary
      from edi_document a where a.entity_id = $1 and a.direction = 'in' and a.doc_type = '997'
       and a.related_id in (select x.id from edi_document x where x.entity_id = $1 and x.purchase_order_id = $2 and x.direction = 'out')`, [entityId, poId]);
  const seen = new Set(docs.map((d) => (d as { id: string }).id));
  const sent = await q(c, `select method, status, destination, detail, vendor_ref, sent_at from po_transmission where entity_id = $1 and purchase_order_id = $2 order by sent_at`, [entityId, poId]);
  return { documents: [...docs, ...acked.filter((a) => !seen.has((a as { id: string }).id))], shipments: await pur.shipmentsOf(c, entityId, poId), sent };
}

export async function ediHome(c: Client, entityId: string) {
  return (await q<{ partners: string; on: string; quarantined: string; queued: string; failed: string; today_in: string }>(c, `
    select (select count(*) from edi_partner where entity_id = $1) partners,
           (select count(*) from edi_partner where entity_id = $1 and edi_enabled) "on",
           count(*) filter (where status = 'quarantined') quarantined,
           count(*) filter (where status = 'queued') queued,
           count(*) filter (where status in ('failed','rejected')) failed,
           count(*) filter (where direction = 'in' and created_at > now() - interval '1 day') today_in
      from edi_document where entity_id = $1`, [entityId]))[0];
}
