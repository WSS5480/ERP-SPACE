// Catalog: the product master and everything around it -- lifecycle status,
// options and special-order templates, packages, cartons, images, price
// lists, promotions, vendor ordering facts, freight, price tags and the
// vendor feed import (the idea of CATALOG-APP's builder: upload, map the
// columns, preview, build; reimplemented here, not copied).
//
// Everything that changes a row takes a Scope and writes an audit event.
// Errors are CatalogError with a sentence a person can act on.

import { q, one, audit, type Client, type Scope } from "./db.ts";

export class CatalogError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new CatalogError(msg); };

export const STATUSES = ["draft", "active", "floor_sample", "drop", "discontinued"] as const;
export const KINDS = ["stock", "configurable", "special_order", "kit", "service", "fee", "warranty", "gift_card"] as const;
export const SHIP_CLASSES = ["carry", "parcel", "delivery", "none"] as const;
const SELLS_WITH_NO_PRICE = new Set(["service", "fee"]);

// ------------------------------------------------------------- parsing --

/** Money from a person or a file: "$1,234.50", "1234.5", 1234.5 -> 123450n. null when blank. */
export function parseMoney(v: unknown): bigint | null {
  if (v == null) return null;
  if (typeof v === "bigint") return v;
  const s = String(v).replace(/[$,\s]/g, "");
  if (!s) return null;
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) throw new CatalogError(`${String(v).slice(0, 30)} is not a money amount`);
  const frac = (m[3] ?? "").padEnd(2, "0");
  let cents = BigInt(m[2] || "0") * 100n + BigInt(frac.slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1n;
  return m[1] ? -cents : cents;
}

function parseNum(v: unknown, what: string): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  need(Number.isFinite(n) && n >= 0, `${what} must be a number, not ${String(v).slice(0, 20)}`);
  return Math.round(n * 100) / 100;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, a BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], f = "", i = 0, quoted = false;
  const s = text.replace(/^﻿/, "");
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { f += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      f += ch; i++; continue;
    }
    if (ch === '"' && f === "") { quoted = true; i++; continue; }
    if (ch === ",") { row.push(f); f = ""; i++; continue; }
    if (ch === "\r" || ch === "\n") {
      row.push(f); f = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      i += ch === "\r" && s[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    f += ch; i++;
  }
  row.push(f);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

/** A CSV cell, quoted when it has to be. */
export const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ------------------------------------------------------- feed mapping --

export type ImportField = { name: string; required: boolean; help: string };
export const IMPORT_FIELDS: ImportField[] = [
  { name: "vendor_sku", required: true, help: "The vendor's model number; how a re-import finds the same product" },
  { name: "name", required: true, help: "Product name on the tag and the web" },
  { name: "cost", required: true, help: "What we pay the vendor, each" },
  { name: "price", required: false, help: "Our retail. Rows without one arrive as drafts" },
  { name: "map", required: false, help: "Minimum advertised price" },
  { name: "msrp", required: false, help: "Vendor's suggested retail" },
  { name: "brand", required: false, help: "" },
  { name: "category", required: false, help: "" },
  { name: "subcategory", required: false, help: "" },
  { name: "collection", required: false, help: "" },
  { name: "color", required: false, help: "" },
  { name: "description", required: false, help: "" },
  { name: "image_url", required: false, help: "Main photo, an http(s) address" },
  { name: "barcode", required: false, help: "UPC or EAN" },
  { name: "cubic_ft", required: false, help: "Total cube, all cartons" },
  { name: "weight_lb", required: false, help: "Total weight, all cartons" },
  { name: "pieces", required: false, help: "How many cartons it ships in" },
  { name: "status", required: false, help: "Active, discontinued or dropped" },
];
const ALIASES: Record<string, string[]> = {
  vendor_sku: ["vendor_sku", "model", "model_num", "modelnum", "model_number", "model #", "model no", "item_number", "sku", "item no", "style", "itemnumber", "price.sku"],
  name: ["name", "item_name", "itemname", "product_name", "title", "item", "description", "item_description"],
  cost: ["cost", "regular_cost", "regularcost", "net_cost", "unit_cost", "dealer_cost", "wholesale", "price.netPriceBeforeFreight", "netPriceBeforeFreight", "net_price", "price.net", "price"],
  price: ["retail", "retail_price", "our_price", "sell_price", "selling_price"],
  map: ["map", "map_price", "price.map", "min_advertised_price", "minimum_advertised_price", "umrp", "imap"],
  msrp: ["msrp", "suggested_retail", "list_price", "srp", "price.msrp", "price.suggestedRetail"],
  brand: ["brand", "manufacturer", "mfr"],
  category: ["category", "dept", "department", "class"],
  subcategory: ["subcategory", "sub_category", "sub category", "subclass", "type"],
  collection: ["collection", "series", "group"],
  color: ["color", "colour", "finish"],
  description: ["long_description", "details", "features", "description"],
  image_url: ["image_url", "image", "item_image", "item_image_2", "itemimage2", "photo", "picture", "image_link", "images.url", "image.url", "primaryImage.url"],
  barcode: ["upc", "barcode", "ean", "gtin", "upc_code"],
  cubic_ft: ["cubic_ft", "cube", "cubes", "cu_ft", "cuft", "cubic_feet"],
  weight_lb: ["weight_lb", "weight", "wt", "lbs", "gross_weight"],
  pieces: ["pieces", "cartons", "boxes", "carton_count", "pcs", "num_cartons"],
  status: ["status", "item_status", "availability", "discontinued"],
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which column supplies each field: recognised, never invented. A column feeds at most one field. */
export function automap(headers: string[]): Record<string, string> {
  const byNorm = new Map<string, string>();
  for (const h of headers) if (!byNorm.has(norm(h))) byNorm.set(norm(h), h);
  const used = new Set<string>();
  const out: Record<string, string> = {};
  // in field order, so the name field claims "Description" before the long description does
  for (const f of IMPORT_FIELDS) {
    for (const a of [f.name, ...(ALIASES[f.name] ?? [])]) {
      const hit = byNorm.get(norm(a));
      if (hit && !used.has(hit)) { out[f.name] = hit; used.add(hit); break; }
    }
  }
  return out;
}

export const missingRequired = (mapping: Record<string, string>): string[] =>
  IMPORT_FIELDS.filter((f) => f.required && !mapping[f.name]).map((f) => f.name);

type Fields = {
  vendor_sku: string; name?: string; cost_minor?: string; price_minor?: string; map_minor?: string; msrp_minor?: string;
  brand?: string; category?: string; subcategory?: string; collection?: string; color?: string; description?: string;
  image_url?: string; barcode?: string; cubic_ft?: number; weight_lb?: number; pieces?: number; status?: string;
};

function feedStatus(v: string): string | null {
  const s = norm(v);
  if (!s) return null;
  if (["active", "a", "current", "available", "instock", "yes", "n", "no", "false", "0"].includes(s)) return "active";
  // A vendor discontinuing a model is a drop for us: sell what is here, never reorder.
  if (["discontinued", "disc", "d", "drop", "dropped", "obsolete", "inactive", "y", "true", "1"].includes(s)) return "drop";
  return null;
}

/** One file row to the values it carries. Blank cells are left out, so they never erase what is on file. */
export function normaliseRow(cells: string[], idx: Map<string, number>, mapping: Record<string, string>): Fields {
  const cell = (f: string): string => {
    const h = mapping[f];
    if (!h) return "";
    const i = idx.get(h);
    return i == null ? "" : String(cells[i] ?? "").trim();
  };
  const out: Fields = { vendor_sku: cell("vendor_sku").toUpperCase().slice(0, 60) };
  const text = (f: keyof Fields, max = 200) => { const v = cell(f as string); if (v) (out as Record<string, unknown>)[f] = v.slice(0, max); };
  text("name"); text("brand", 80); text("category", 80); text("subcategory", 80); text("collection", 80); text("color", 80);
  text("description", 4000); text("barcode", 40);
  for (const [f, col] of [["cost", "cost_minor"], ["price", "price_minor"], ["map", "map_minor"], ["msrp", "msrp_minor"]] as const) {
    const v = cell(f);
    if (!v) continue;
    const m = parseMoney(v);
    need(m != null && m >= 0n, `${f} ${v} is not a money amount`);
    (out as Record<string, unknown>)[col] = String(m);
  }
  const img = cell("image_url");
  if (img) { need(/^https?:\/\//i.test(img), `image ${img.slice(0, 40)} is not a web address`); out.image_url = img.slice(0, 1000); }
  const cube = parseNum(cell("cubic_ft"), "cube"); if (cube != null) out.cubic_ft = cube;
  const wt = parseNum(cell("weight_lb"), "weight"); if (wt != null) out.weight_lb = wt;
  const pcs = parseNum(cell("pieces"), "pieces");
  if (pcs != null) { need(Number.isInteger(pcs) && pcs >= 1 && pcs <= 20, "pieces must be a whole number from 1 to 20"); out.pieces = pcs; }
  const st = cell("status");
  if (st) { const s = feedStatus(st); need(s, `status ${st} is not one this import knows (active or discontinued)`); out.status = s!; }
  return out;
}

type Existing = {
  id: string; sku: string; name: string; cost_minor: string; price_minor: string; map_minor: string | null; msrp_minor: string | null;
  brand: string | null; category: string | null; subcategory: string | null; collection: string | null; color: string | null;
  description: string | null; barcode: string | null; cubic_ft: string | null; weight_lb: string | null; status: string;
  image_url: string | null; pieces: string;
};

const DIFF_KEYS = ["name", "cost_minor", "price_minor", "map_minor", "msrp_minor", "brand", "category", "subcategory", "collection",
  "color", "description", "barcode", "cubic_ft", "weight_lb", "image_url", "pieces", "status"] as const;

function diff(cur: Existing, f: Fields): Record<string, [unknown, unknown]> {
  const ch: Record<string, [unknown, unknown]> = {};
  for (const k of DIFF_KEYS) {
    const nv = (f as Record<string, unknown>)[k];
    if (nv == null) continue;
    let ov: unknown = (cur as Record<string, unknown>)[k];
    if (k === "cubic_ft" || k === "weight_lb" || k === "pieces") ov = ov == null ? null : Number(ov);
    // Our own lifecycle (floor sample, drafts) is not the vendor's to undo; a feed only moves active <-> drop.
    if (k === "status" && !["active", "drop"].includes(String(ov))) continue;
    if (k === "pieces" && Number(ov) === 0 && nv === 1) continue;
    if (String(ov ?? "") !== String(nv)) ch[k] = [ov ?? null, nv];
  }
  return ch;
}

const EXISTING_SQL = `
  select p.id, p.sku, p.name, p.cost_minor, p.price_minor, p.map_minor, p.msrp_minor, p.brand, p.category, p.subcategory,
         p.collection, p.color, p.description, p.barcode, p.cubic_ft, p.weight_lb, p.status, p.vendor_sku,
         (select url from product_image i where i.product_id = p.id and i.entity_id = p.entity_id order by seq limit 1) image_url,
         (select count(*) from product_piece x where x.product_id = p.id and x.entity_id = p.entity_id) pieces
    from product p where p.entity_id = $1 and p.vendor_id = $2`;

async function vendorOf(c: Client, entityId: string, vendorId: string) {
  const v = (await q<{ id: string; name: string; sku_prefix: string | null }>(c, `
    select v.id, coalesce(v.dba, v.legal_name) as name, vp.sku_prefix
      from vendor_entity ve join vendor v on v.id = ve.vendor_id
      left join vendor_profile vp on vp.vendor_id = v.id and vp.entity_id = ve.entity_id
     where ve.entity_id = $1 and ve.vendor_id = $2 and ve.status = 'active'`, [entityId, vendorId]))[0];
  need(v, "that vendor is not set up for this company");
  return v;
}

const skuPrefix = (v: { name: string; sku_prefix: string | null }) =>
  v.sku_prefix || v.name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "VND";

/**
 * Read a vendor file against a mapping and record what building it would do,
 * row by row. Nothing in the catalog changes until the run is applied.
 */
export async function previewImport(c: Client, s: Scope, a: { vendorId: string; csv: string; filename?: string; mapping: Record<string, string> }) {
  const vendor = await vendorOf(c, s.entityId, a.vendorId);
  const rows = parseCsv(a.csv);
  need(rows.length >= 2, "the file has no rows under its heading line");
  need(rows.length <= 10001, "the file has more than 10,000 rows; split it");
  const headers = rows[0].map((h) => h.trim());
  const idx = new Map(headers.map((h, i) => [h, i] as [string, number]));
  const mapping: Record<string, string> = {};
  for (const f of IMPORT_FIELDS) {
    const h = a.mapping[f.name];
    if (!h) continue;
    need(idx.has(h), `the file has no column called ${h}`);
    mapping[f.name] = h;
  }
  const miss = missingRequired(mapping);
  need(!miss.length, `pick a column for ${miss.join(", ")} before previewing`);

  const existing = new Map((await q<Existing & { vendor_sku: string }>(c, EXISTING_SQL, [s.entityId, a.vendorId]))
    .map((e) => [String(e.vendor_sku).toUpperCase(), e]));
  const run = await one<{ id: string }>(c, `
    insert into catalog_import_run (entity_id, vendor_id, filename, mapping, created_by)
    values ($1,$2,$3,$4,$5) returning id`,
    [s.entityId, a.vendorId, (a.filename ?? "").slice(0, 200) || null, JSON.stringify(mapping), s.actor.id || null]);

  const seen = new Map<string, number>();
  const counts = { add: 0, change: 0, same: 0, skip: 0 };
  for (let r = 1; r < rows.length; r++) {
    let action: "add" | "change" | "same" | "skip" = "skip", message: string | null = null;
    let fields: Fields | null = null, productId: string | null = null, changes: Record<string, [unknown, unknown]> = {};
    try {
      fields = normaliseRow(rows[r], idx, mapping);
      need(fields.vendor_sku, "no model number");
      need(!seen.has(fields.vendor_sku), `model ${fields.vendor_sku} is already on row ${seen.get(fields.vendor_sku)} of this file`);
      seen.set(fields.vendor_sku, r + 1);
      const cur = existing.get(fields.vendor_sku);
      if (cur) {
        productId = cur.id;
        changes = diff(cur, fields);
        action = Object.keys(changes).length ? "change" : "same";
      } else {
        need(fields.name, "a new product needs a name");
        need(fields.cost_minor != null, "a new product needs a cost");
        action = "add";
        if (fields.price_minor == null || fields.price_minor === "0") message = "arrives as a draft: no retail price in the file";
      }
    } catch (e) {
      if (!(e instanceof CatalogError)) throw e;
      message = e.message; action = "skip";
    }
    counts[action]++;
    await c.query(`
      insert into catalog_import_row (entity_id, run_id, row_no, vendor_sku, action, product_id, fields, changes, message)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [s.entityId, run.id, r + 1, fields?.vendor_sku || null, action, productId, JSON.stringify(fields ?? {}), JSON.stringify(changes), message]);
  }
  await c.query(`update catalog_import_run set rows = $3, added = $4, changed = $5, unchanged = $6, skipped = $7
                  where id = $1 and entity_id = $2`, [run.id, s.entityId, rows.length - 1, counts.add, counts.change, counts.same, counts.skip]);
  await audit(c, s, { table: "catalog_import_run", rowId: run.id, action: "insert",
    after: { vendor: vendor.name, rows: rows.length - 1, ...counts } });
  return { runId: run.id, vendor: vendor.name, rows: rows.length - 1, ...counts };
}

/** Build a previewed run: upsert by vendor and model number, against the catalog as it is now. */
export async function applyImport(c: Client, s: Scope, runId: string) {
  const run = (await q<{ id: string; vendor_id: string; status: string }>(c,
    `select id, vendor_id, status from catalog_import_run where id = $1 and entity_id = $2 for update`, [runId, s.entityId]))[0];
  need(run, "no such import");
  need(run.status === "previewed", `that import is already ${run.status}`);
  const vendor = await vendorOf(c, s.entityId, run.vendor_id);
  const prefix = skuPrefix(vendor);
  const rows = await q<{ row_no: number; action: string; fields: Fields }>(c,
    `select row_no, action, fields from catalog_import_row where run_id = $1 and entity_id = $2 order by row_no`, [runId, s.entityId]);
  const existing = new Map((await q<Existing & { vendor_sku: string }>(c, EXISTING_SQL, [s.entityId, run.vendor_id]))
    .map((e) => [String(e.vendor_sku).toUpperCase(), e]));
  const counts = { add: 0, change: 0, same: 0, skip: 0 };
  for (const r of rows) {
    if (r.action === "skip") { counts.skip++; continue; }
    const f = r.fields;
    const cur = existing.get(f.vendor_sku);
    let action: "add" | "change" | "same" | "skip";
    let productId: string | null = cur?.id ?? null, message: string | null = null;
    let changes: Record<string, [unknown, unknown]> = {};
    if (cur) {
      changes = diff(cur, f);
      action = Object.keys(changes).length ? "change" : "same";
      if (action === "change") await applyChanges(c, s.entityId, cur.id, changes);
    } else {
      const sku = `${prefix}-${f.vendor_sku.replace(/[^A-Z0-9.-]/g, "")}`.slice(0, 40);
      const clash = await q(c, `select 1 from product where entity_id = $1 and sku = $2`, [s.entityId, sku]);
      if (clash.length) { action = "skip"; message = `SKU ${sku} is already used by another product`; }
      else {
        const priced = f.price_minor != null && f.price_minor !== "0";
        const p = await one<{ id: string }>(c, `
          insert into product (entity_id, sku, name, kind, vendor_id, vendor_sku, brand, category, subcategory, collection, color,
                               description, price_minor, cost_minor, map_minor, msrp_minor, barcode, cubic_ft, weight_lb, status, status_note)
          values ($1,$2,$3,'stock',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning id`,
          [s.entityId, sku, f.name, run.vendor_id, f.vendor_sku, f.brand ?? null, f.category ?? null, f.subcategory ?? null,
           f.collection ?? null, f.color ?? null, f.description ?? null, f.price_minor ?? "0", f.cost_minor ?? "0",
           f.map_minor ?? null, f.msrp_minor ?? null, f.barcode ?? null, f.cubic_ft ?? null, f.weight_lb ?? null,
           f.status === "drop" ? "drop" : priced ? "active" : "draft", f.status === "drop" ? "vendor feed: discontinued" : null]);
        productId = p.id; action = "add";
        if (f.image_url) await c.query(`insert into product_image (entity_id, product_id, seq, url) values ($1,$2,1,$3)`, [s.entityId, p.id, f.image_url]);
        if (f.pieces && f.pieces > 1) await rebuildPieces(c, s.entityId, p.id, f.pieces, f.cubic_ft ?? null, f.weight_lb ?? null);
        existing.set(f.vendor_sku, { id: p.id } as Existing);   // a second row for it was refused at preview
      }
    }
    counts[action]++;
    await c.query(`update catalog_import_row set action = $3, product_id = $4, changes = $5, message = coalesce($6, message)
                    where run_id = $1 and entity_id = $2 and row_no = $7`,
      [runId, s.entityId, action, productId, JSON.stringify(changes), message, r.row_no]);
  }
  await c.query(`update catalog_import_run set status = 'applied', applied_at = now(), applied_by = $3,
                        added = $4, changed = $5, unchanged = $6, skipped = $7 where id = $1 and entity_id = $2`,
    [runId, s.entityId, s.actor.id || null, counts.add, counts.change, counts.same, counts.skip]);
  await audit(c, s, { table: "catalog_import_run", rowId: runId, action: "transition", after: { status: "applied", ...counts } });
  return { runId, ...counts };
}

async function applyChanges(c: Client, entityId: string, productId: string, ch: Record<string, [unknown, unknown]>) {
  const cols = ["name", "cost_minor", "price_minor", "map_minor", "msrp_minor", "brand", "category", "subcategory", "collection",
    "color", "description", "barcode", "cubic_ft", "weight_lb", "status"];
  const sets: string[] = [], vals: unknown[] = [productId, entityId];
  for (const k of cols) if (ch[k]) { vals.push(ch[k][1]); sets.push(`${k} = $${vals.length}`); }
  if (ch.status) sets.push(`status_note = ${ch.status[1] === "drop" ? "'vendor feed: discontinued'" : "null"}`);
  if (sets.length) await c.query(`update product set ${sets.join(", ")}, updated_at = now() where id = $1 and entity_id = $2`, vals);
  if (ch.image_url) {
    await c.query(`insert into product_image (entity_id, product_id, seq, url) values ($1,$2,1,$3)
                   on conflict (product_id, seq) do update set url = excluded.url`, [entityId, productId, ch.image_url[1]]);
  }
  if (ch.pieces) {
    const p = await one<{ cubic_ft: string | null; weight_lb: string | null }>(c,
      `select cubic_ft, weight_lb from product where id = $1 and entity_id = $2`, [productId, entityId]);
    await rebuildPieces(c, entityId, productId, Number(ch.pieces[1]), p.cubic_ft == null ? null : Number(p.cubic_ft), p.weight_lb == null ? null : Number(p.weight_lb));
  }
}

async function rebuildPieces(c: Client, entityId: string, productId: string, n: number, cube: number | null, wt: number | null) {
  await c.query(`delete from product_piece where product_id = $1 and entity_id = $2`, [productId, entityId]);
  for (let i = 1; i <= n; i++) {
    await c.query(`insert into product_piece (entity_id, product_id, seq, label, cubic_ft, weight_lb) values ($1,$2,$3,$4,$5,$6)`,
      [entityId, productId, i, `Box ${i} of ${n}`, cube == null ? null : Math.round((cube / n) * 100) / 100, wt == null ? null : Math.round((wt / n) * 100) / 100]);
  }
}

// ------------------------------------------------------- product master --

export type ProductInput = {
  sku?: string; name?: string; kind?: string; vendorId?: string | null; vendorSku?: string | null; brand?: string | null;
  category?: string | null; subcategory?: string | null; collection?: string | null; color?: string | null; description?: string | null;
  priceMinor?: bigint; costMinor?: bigint; mapMinor?: bigint | null; msrpMinor?: bigint | null; barcode?: string | null;
  taxable?: boolean; serialized?: boolean; shipClass?: string; cubicFt?: number | null; weightLb?: number | null; webVisible?: boolean;
};

const COLS: [keyof ProductInput, string][] = [
  ["sku", "sku"], ["name", "name"], ["kind", "kind"], ["vendorId", "vendor_id"], ["vendorSku", "vendor_sku"], ["brand", "brand"],
  ["category", "category"], ["subcategory", "subcategory"], ["collection", "collection"], ["color", "color"], ["description", "description"],
  ["priceMinor", "price_minor"], ["costMinor", "cost_minor"], ["mapMinor", "map_minor"], ["msrpMinor", "msrp_minor"], ["barcode", "barcode"],
  ["taxable", "taxable"], ["serialized", "serialized"], ["shipClass", "ship_class"], ["cubicFt", "cubic_ft"], ["weightLb", "weight_lb"],
  ["webVisible", "web_visible"],
];

async function checkProductInput(c: Client, entityId: string, p: ProductInput, id: string | null) {
  if (p.sku !== undefined) {
    need(/^[A-Z0-9][A-Z0-9._-]{1,39}$/.test(p.sku), "a SKU is 2 to 40 capital letters, digits, dots or dashes");
    const clash = await q(c, `select 1 from product where entity_id = $1 and sku = $2 and id is distinct from $3`, [entityId, p.sku, id]);
    need(!clash.length, `SKU ${p.sku} is already used`);
  }
  if (p.name !== undefined) need(p.name && p.name.length <= 200, "a product needs a name");
  if (p.kind !== undefined) need((KINDS as readonly string[]).includes(p.kind), `kind must be one of ${KINDS.join(", ")}`);
  if (p.shipClass !== undefined) need((SHIP_CLASSES as readonly string[]).includes(p.shipClass), `ship class must be one of ${SHIP_CLASSES.join(", ")}`);
  for (const k of ["priceMinor", "costMinor", "mapMinor", "msrpMinor"] as const) {
    const v = p[k];
    if (v != null) need(v >= 0n, "prices and costs cannot be negative");
  }
  if (p.vendorId) await vendorOf(c, entityId, p.vendorId);
  if (p.barcode) {
    need(/^[0-9A-Za-z-]{4,40}$/.test(p.barcode), "a barcode is 4 to 40 letters or digits");
    const clash = await q(c, `select sku from product where entity_id = $1 and barcode = $2 and id is distinct from $3`, [entityId, p.barcode, id]);
    need(!clash.length, `barcode ${p.barcode} is already on ${clash[0]?.sku}`);
  }
  if (p.vendorId && p.vendorSku) {
    const clash = await q<{ sku: string }>(c, `select sku from product where entity_id = $1 and vendor_id = $2 and vendor_sku = $3 and id is distinct from $4`,
      [entityId, p.vendorId, p.vendorSku, id]);
    need(!clash.length, `that vendor model is already ${clash[0]?.sku}`);
  }
}

/** A value audit can store: bigints as strings. */
const plain = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

const val = (v: unknown) => (typeof v === "bigint" ? v.toString() : v === undefined ? null : v);

/** A new product, as a draft unless a status is asked for; the status rules are the same as setStatus's. */
export async function createProduct(c: Client, s: Scope, p: ProductInput, status: { status?: string | null; note?: string | null } = {}): Promise<string> {
  need(p.sku && p.name, "a new product needs a SKU and a name");
  await checkProductInput(c, s.entityId, p, null);
  const st = status.status || "draft";
  need((STATUSES as readonly string[]).includes(st), `status must be one of ${STATUSES.join(", ").replace(/_/g, " ")}`);
  const note = status.note?.trim() || null;
  if (st === "active") need((p.priceMinor ?? 0n) > 0n || SELLS_WITH_NO_PRICE.has(p.kind ?? "stock"), `${p.name} needs a price before it can be active`);
  if (["floor_sample", "drop", "discontinued"].includes(st)) need(note, `say why ${p.name} is ${st.replace("_", " ")}`);
  const cols = COLS.filter(([k]) => p[k] !== undefined);
  const r = await one<{ id: string }>(c, `
    insert into product (entity_id, status, status_note, ${cols.map(([, col]) => col).join(", ")})
    values ($1, $2, $3, ${cols.map((_, i) => `$${i + 4}`).join(", ")}) returning id`,
    [s.entityId, st, note, ...cols.map(([k]) => val(p[k]))]);
  await audit(c, s, { table: "product", rowId: r.id, action: "insert", after: { sku: p.sku, name: p.name, status: st } });
  return r.id;
}

export async function updateProduct(c: Client, s: Scope, id: string, p: ProductInput): Promise<void> {
  const before = (await q<Record<string, unknown>>(c, `select * from product where id = $1 and entity_id = $2 for update`, [id, s.entityId]))[0];
  need(before, "no such product");
  await checkProductInput(c, s.entityId, { ...p, vendorId: p.vendorId === undefined ? (before.vendor_id as string | null) : p.vendorId,
    vendorSku: p.vendorSku === undefined ? (before.vendor_sku as string | null) : p.vendorSku }, id);
  if (p.kind !== undefined && p.kind !== before.kind) {
    const kids = await q(c, `select 1 from product_kit_component where entity_id = $1 and kit_id = $2 limit 1`, [s.entityId, id]);
    need(!kids.length || p.kind === "kit", "this product has package components; clear them before changing its kind");
  }
  if (p.priceMinor === 0n && before.status === "active" && !SELLS_WITH_NO_PRICE.has(String(p.kind ?? before.kind))) {
    throw new CatalogError("an active product needs a price; set it to draft first if it should not sell");
  }
  const cols = COLS.filter(([k]) => p[k] !== undefined);
  if (!cols.length) return;
  await c.query(`update product set ${cols.map(([, col], i) => `${col} = $${i + 3}`).join(", ")}, updated_at = now()
                  where id = $1 and entity_id = $2`, [id, s.entityId, ...cols.map(([k]) => val(p[k]))]);
  const after: Record<string, unknown> = {}, prior: Record<string, unknown> = {};
  for (const [k, col] of cols) { after[col] = val(p[k]); prior[col] = before[col]; }
  await audit(c, s, { table: "product", rowId: id, action: "update", before: prior, after });
}

/** Lifecycle. Floor sample, drop and discontinued say why; active needs a price. */
export async function setStatus(c: Client, s: Scope, id: string, status: string, note: string | null): Promise<void> {
  need((STATUSES as readonly string[]).includes(status), `status must be one of ${STATUSES.join(", ").replace(/_/g, " ")}`);
  const p = (await q<{ status: string; price_minor: string; kind: string; name: string }>(c,
    `select status, price_minor, kind, name from product where id = $1 and entity_id = $2 for update`, [id, s.entityId]))[0];
  need(p, "no such product");
  if (status === p.status) return;
  if (["floor_sample", "drop", "discontinued"].includes(status)) need(note && note.trim(), `say why ${p.name} is ${status.replace("_", " ")}`);
  if (status === "active") need(BigInt(p.price_minor) > 0n || SELLS_WITH_NO_PRICE.has(p.kind), `${p.name} needs a price before it can be active`);
  await c.query(`update product set status = $3, status_note = $4, updated_at = now() where id = $1 and entity_id = $2`,
    [id, s.entityId, status, note?.trim() || null]);
  await audit(c, s, { table: "product", rowId: id, action: "transition", before: { status: p.status }, after: { status }, reason: note ?? undefined });
}

async function productOf(c: Client, entityId: string, id: string) {
  const p = (await q<{ id: string; name: string; kind: string; status: string }>(c,
    `select id, name, kind, status from product where id = $1 and entity_id = $2`, [id, entityId]))[0];
  need(p, "no such product");
  return p;
}

/** The cartons a product ships in. The product's cube and weight become their totals. */
export async function setPieces(c: Client, s: Scope, productId: string, pieces: { label: string; cubicFt?: number | null; weightLb?: number | null }[]) {
  await productOf(c, s.entityId, productId);
  need(pieces.length <= 20, "twenty cartons at most");
  for (const x of pieces) {
    need(x.label && x.label.trim(), "each carton needs a label, like Headboard or Box 1");
    for (const v of [x.cubicFt, x.weightLb]) if (v != null) need(Number.isFinite(v) && v >= 0, "cube and weight are positive numbers");
  }
  const before = await q(c, `select seq, label, cubic_ft, weight_lb from product_piece where product_id = $1 and entity_id = $2 order by seq`, [productId, s.entityId]);
  await c.query(`delete from product_piece where product_id = $1 and entity_id = $2`, [productId, s.entityId]);
  let cube = 0, wt = 0, hasCube = false, hasWt = false;
  for (const [i, x] of pieces.entries()) {
    await c.query(`insert into product_piece (entity_id, product_id, seq, label, cubic_ft, weight_lb) values ($1,$2,$3,$4,$5,$6)`,
      [s.entityId, productId, i + 1, x.label.trim().slice(0, 80), x.cubicFt ?? null, x.weightLb ?? null]);
    if (x.cubicFt != null) { cube += x.cubicFt; hasCube = true; }
    if (x.weightLb != null) { wt += x.weightLb; hasWt = true; }
  }
  if (pieces.length) {
    await c.query(`update product set cubic_ft = coalesce($3, cubic_ft), weight_lb = coalesce($4, weight_lb), updated_at = now()
                    where id = $1 and entity_id = $2`, [productId, s.entityId, hasCube ? Math.round(cube * 100) / 100 : null, hasWt ? Math.round(wt * 100) / 100 : null]);
  }
  await audit(c, s, { table: "product_piece", rowId: productId, action: "update", before, after: pieces });
}

export async function setImages(c: Client, s: Scope, productId: string, images: { url: string; alt?: string | null }[]) {
  await productOf(c, s.entityId, productId);
  need(images.length <= 12, "twelve images at most");
  for (const im of images) need(/^https?:\/\/\S+$/i.test(im.url ?? ""), `${String(im.url ?? "").slice(0, 40) || "a blank"} is not a web address`);
  const before = await q(c, `select seq, url from product_image where product_id = $1 and entity_id = $2 order by seq`, [productId, s.entityId]);
  await c.query(`delete from product_image where product_id = $1 and entity_id = $2`, [productId, s.entityId]);
  for (const [i, im] of images.entries()) {
    await c.query(`insert into product_image (entity_id, product_id, seq, url, alt) values ($1,$2,$3,$4,$5)`,
      [s.entityId, productId, i + 1, im.url.slice(0, 1000), im.alt?.slice(0, 200) || null]);
  }
  await audit(c, s, { table: "product_image", rowId: productId, action: "update", before, after: images });
}

/** What a package holds. The package's cost becomes its components' cost. */
export async function setKit(c: Client, s: Scope, kitId: string, comps: { productId: string; qty: number }[]) {
  const kit = await productOf(c, s.entityId, kitId);
  need(kit.kind === "kit", `${kit.name} is not a package; set its kind to kit first`);
  need(comps.length >= 2 || comps.length === 0, "a package has at least two pieces");
  const ids = new Set<string>();
  let cost = 0n;
  for (const x of comps) {
    need(x.productId !== kitId, "a package cannot contain itself");
    need(!ids.has(x.productId), "each component appears once; raise its quantity instead");
    ids.add(x.productId);
    need(Number.isFinite(x.qty) && x.qty > 0 && x.qty <= 99, "component quantities are from 1 to 99");
    const p = (await q<{ kind: string; name: string; cost_minor: string }>(c,
      `select kind, name, cost_minor from product where id = $1 and entity_id = $2`, [x.productId, s.entityId]))[0];
    need(p, "a component is not a product of this company");
    need(!["kit", "service", "fee", "warranty", "gift_card"].includes(p.kind), `${p.name} cannot go in a package`);
    cost += BigInt(Math.round(x.qty * Number(p.cost_minor)));
  }
  await c.query(`delete from product_kit_component where kit_id = $1 and entity_id = $2`, [kitId, s.entityId]);
  for (const [i, x] of comps.entries()) {
    await c.query(`insert into product_kit_component (entity_id, kit_id, component_id, qty, seq) values ($1,$2,$3,$4,$5)`,
      [s.entityId, kitId, x.productId, x.qty, i + 1]);
  }
  if (comps.length) await c.query(`update product set cost_minor = $3, updated_at = now() where id = $1 and entity_id = $2`, [kitId, s.entityId, cost.toString()]);
  await audit(c, s, { table: "product_kit_component", rowId: kitId, action: "update", after: comps });
}

/**
 * A package sold as its pieces: one line per component, the package price
 * spread over them in proportion to their own prices, last line taking the
 * rounding. POS and the web store write these as order lines.
 */
export async function explodeKit(c: Client, entityId: string, kitId: string, packagePriceMinor: bigint) {
  const comps = await q<{ component_id: string; sku: string; name: string; qty: string; price_minor: string }>(c, `
    select k.component_id, p.sku, p.name, k.qty, p.price_minor from product_kit_component k
      join product p on p.id = k.component_id and p.entity_id = $1
     where k.entity_id = $1 and k.kit_id = $2 order by k.seq`, [entityId, kitId]);
  need(comps.length, "that package has no components");
  const ext = comps.map((x) => BigInt(Math.round(Number(x.qty) * Number(x.price_minor))));
  const total = ext.reduce((a, b) => a + b, 0n);
  let left = packagePriceMinor;
  return comps.map((x, i) => {
    const share = i === comps.length - 1 ? left : total > 0n ? (packagePriceMinor * ext[i]) / total : 0n;
    left -= share;
    return { productId: x.component_id, sku: x.sku, name: x.name, qty: Number(x.qty), extendedMinor: share };
  });
}

// --------------------------------------------- options and templates --

export type OptionIn = { code: string; label: string; priceDeltaMinor?: bigint; costDeltaMinor?: bigint; leadDays?: number;
  swatch?: string | null; vendorCode?: string | null };
export type GroupIn = { code: string; label: string; required?: boolean; multi?: boolean; seq?: number; options: OptionIn[] };

const CODE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
function checkGroup(g: GroupIn) {
  need(CODE.test(g.code ?? ""), "an option group code is lower-case letters, digits and dashes, like fabric");
  need(g.label && g.label.trim(), "an option group needs a label");
  need(Array.isArray(g.options) && g.options.length, `${g.label} needs at least one option`);
  const codes = new Set<string>();
  for (const o of g.options) {
    need(CODE.test(o.code ?? ""), `option codes are lower-case letters, digits and dashes (${o.code || "blank"})`);
    need(!codes.has(o.code), `${o.code} appears twice in ${g.label}`);
    codes.add(o.code);
    need(o.label && o.label.trim(), "each option needs a label");
    need(o.leadDays == null || (Number.isInteger(o.leadDays) && o.leadDays >= 0 && o.leadDays <= 365), "lead days are 0 to 365");
  }
}

/** Add or change one option group on a product. Options left out are retired, never deleted, so old orders still read. */
export async function saveOptionGroup(c: Client, s: Scope, productId: string, g: GroupIn): Promise<string> {
  const p = await productOf(c, s.entityId, productId);
  need(["configurable", "special_order"].includes(p.kind), `${p.name} is a ${p.kind.replace("_", " ")} product; options go on configurable or special-order products`);
  checkGroup(g);
  const grp = await one<{ id: string }>(c, `
    insert into product_option_group (entity_id, product_id, code, label, required, multi, seq) values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (product_id, code) do update set label = excluded.label, required = excluded.required, multi = excluded.multi, seq = excluded.seq
    returning id /* unscoped: an insert of a row carrying entity_id */`, [s.entityId, productId, g.code, g.label.trim(), g.required ?? true, g.multi ?? false, g.seq ?? 0]);
  for (const [i, o] of g.options.entries()) {
    await c.query(`
      insert into product_option (entity_id, group_id, code, label, price_delta_minor, cost_delta_minor, lead_days, swatch, vendor_code, seq, active)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
      on conflict (group_id, code) do update set label = excluded.label, price_delta_minor = excluded.price_delta_minor,
        cost_delta_minor = excluded.cost_delta_minor, lead_days = excluded.lead_days, swatch = excluded.swatch,
        vendor_code = excluded.vendor_code, seq = excluded.seq, active = true`,
      [s.entityId, grp.id, o.code, o.label.trim(), String(o.priceDeltaMinor ?? 0n), String(o.costDeltaMinor ?? 0n), o.leadDays ?? 0,
       o.swatch ?? null, o.vendorCode ?? null, i + 1]);
  }
  await c.query(`update product_option set active = false where entity_id = $1 and group_id = $2 and not (code = any($3))`,
    [s.entityId, grp.id, g.options.map((o) => o.code)]);
  await audit(c, s, { table: "product_option_group", rowId: grp.id, action: "update", after: plain({ product: productId, ...g }) });
  return grp.id;
}

/** A template's groups and options, created or replaced whole. */
export async function saveTemplate(c: Client, s: Scope, t: { id?: string | null; name: string; vendorId?: string | null; category?: string | null; groups: GroupIn[] }): Promise<string> {
  need(t.name && t.name.trim(), "a template needs a name");
  need(t.vendorId || t.category, "a template belongs to a vendor, a category, or both");
  if (t.vendorId) await vendorOf(c, s.entityId, t.vendorId);
  need(Array.isArray(t.groups) && t.groups.length, "a template needs at least one option group");
  const gc = new Set<string>();
  for (const g of t.groups) { checkGroup(g); need(!gc.has(g.code), `${g.code} appears twice`); gc.add(g.code); }
  let id = t.id ?? null;
  if (id) {
    const cur = await q(c, `select 1 from option_template where id = $1 and entity_id = $2`, [id, s.entityId]);
    need(cur.length, "no such template");
    await c.query(`update option_template set name = $3, vendor_id = $4, category = $5 where id = $1 and entity_id = $2`,
      [id, s.entityId, t.name.trim(), t.vendorId ?? null, t.category?.trim() || null]);
  } else {
    id = (await one<{ id: string }>(c, `insert into option_template (entity_id, name, vendor_id, category) values ($1,$2,$3,$4) returning id`,
      [s.entityId, t.name.trim(), t.vendorId ?? null, t.category?.trim() || null])).id;
  }
  for (const [gi, g] of t.groups.entries()) {
    const grp = await one<{ id: string }>(c, `
      insert into option_template_group (entity_id, template_id, code, label, required, multi, seq) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (template_id, code) do update set label = excluded.label, required = excluded.required, multi = excluded.multi, seq = excluded.seq
      returning id /* unscoped: an insert of a row carrying entity_id */`, [s.entityId, id, g.code, g.label.trim(), g.required ?? true, g.multi ?? false, g.seq ?? gi + 1]);
    for (const [i, o] of g.options.entries()) {
      await c.query(`
        insert into option_template_option (entity_id, group_id, code, label, price_delta_minor, cost_delta_minor, lead_days, swatch, vendor_code, seq, active)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
        on conflict (group_id, code) do update set label = excluded.label, price_delta_minor = excluded.price_delta_minor,
          cost_delta_minor = excluded.cost_delta_minor, lead_days = excluded.lead_days, swatch = excluded.swatch,
          vendor_code = excluded.vendor_code, seq = excluded.seq, active = true`,
        [s.entityId, grp.id, o.code, o.label.trim(), String(o.priceDeltaMinor ?? 0n), String(o.costDeltaMinor ?? 0n), o.leadDays ?? 0,
         o.swatch ?? null, o.vendorCode ?? null, i + 1]);
    }
    await c.query(`update option_template_option set active = false where entity_id = $1 and group_id = $2 and not (code = any($3))`,
      [s.entityId, grp.id, g.options.map((o) => o.code)]);
  }
  await audit(c, s, { table: "option_template", rowId: id!, action: t.id ? "update" : "insert", after: plain(t) });
  return id!;
}

/** Copy a template's groups onto a product. Re-applying refreshes them; the product's own extra groups stay. */
export async function applyTemplate(c: Client, s: Scope, templateId: string, productId: string) {
  const t = (await q<{ id: string; name: string; vendor_id: string | null; category: string | null; active: boolean }>(c,
    `select id, name, vendor_id, category, active from option_template where id = $1 and entity_id = $2`, [templateId, s.entityId]))[0];
  need(t, "no such template");
  need(t.active, `${t.name} is retired`);
  const p = (await q<{ name: string; kind: string; vendor_id: string | null; category: string | null }>(c,
    `select name, kind, vendor_id, category from product where id = $1 and entity_id = $2`, [productId, s.entityId]))[0];
  need(p, "no such product");
  need(!t.vendor_id || t.vendor_id === p.vendor_id, `${t.name} is for another vendor's products`);
  need(!t.category || t.category === p.category, `${t.name} is for ${t.category}, and ${p.name} is ${p.category ?? "uncategorised"}`);
  const groups = await q<{ id: string; code: string; label: string; required: boolean; multi: boolean; seq: number }>(c,
    `select id, code, label, required, multi, seq from option_template_group where template_id = $1 and entity_id = $2 order by seq`, [templateId, s.entityId]);
  const opts = await q<{ group_id: string; code: string; label: string; price_delta_minor: string; cost_delta_minor: string; lead_days: number; swatch: string | null; vendor_code: string | null }>(c, `
    select o.group_id, o.code, o.label, o.price_delta_minor, o.cost_delta_minor, o.lead_days, o.swatch, o.vendor_code
      from option_template_option o where o.entity_id = $1 and o.active
       and o.group_id in (select id from option_template_group where entity_id = $1 and template_id = $2) order by o.seq`, [s.entityId, templateId]);
  if (p.kind === "stock") await c.query(`update product set kind = 'special_order', updated_at = now() where id = $1 and entity_id = $2`, [productId, s.entityId]);
  for (const g of groups) {
    await saveOptionGroup(c, s, productId, {
      code: g.code, label: g.label, required: g.required, multi: g.multi, seq: g.seq,
      options: opts.filter((o) => o.group_id === g.id).map((o) => ({ code: o.code, label: o.label, priceDeltaMinor: BigInt(o.price_delta_minor),
        costDeltaMinor: BigInt(o.cost_delta_minor), leadDays: o.lead_days, swatch: o.swatch, vendorCode: o.vendor_code })),
    });
  }
  await c.query(`insert into product_template_applied (entity_id, product_id, template_id, applied_by) values ($1,$2,$3,$4)
                 on conflict (product_id, template_id) do update set applied_at = now(), applied_by = excluded.applied_by`,
    [s.entityId, productId, templateId, s.actor.id || null]);
  return { groups: groups.length };
}

// ------------------------------------------------ price lists, promotions --

export async function savePriceList(c: Client, s: Scope, l: { code: string; name: string; startsOn?: string | null; endsOn?: string | null; active?: boolean }) {
  const code = String(l.code ?? "").toUpperCase().trim();
  need(/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(code), "a price list code is capital letters, digits and dashes, like CONTRACT");
  need(l.name && l.name.trim(), "a price list needs a name");
  need(!l.startsOn || !l.endsOn || l.endsOn >= l.startsOn, "a price list cannot end before it starts");
  const r = await one<{ id: string }>(c, `
    insert into price_list (entity_id, code, name, starts_on, ends_on, active) values ($1,$2,$3,$4,$5,$6)
    on conflict (entity_id, code) do update set name = excluded.name, starts_on = excluded.starts_on, ends_on = excluded.ends_on, active = excluded.active
    returning id /* unscoped: an insert of a row carrying entity_id */`, [s.entityId, code, l.name.trim(), l.startsOn || null, l.endsOn || null, l.active ?? true]);
  await audit(c, s, { table: "price_list", rowId: r.id, action: "update", after: { ...l, code } });
  return r.id;
}

/** Set prices on a list; a price of null takes the product off it. */
export async function setListPrices(c: Client, s: Scope, listId: string, items: { productId: string; priceMinor: bigint | null }[]) {
  const l = await q(c, `select 1 from price_list where id = $1 and entity_id = $2`, [listId, s.entityId]);
  need(l.length, "no such price list");
  for (const it of items) {
    await productOf(c, s.entityId, it.productId);
    if (it.priceMinor == null) {
      await c.query(`delete from price_list_item where price_list_id = $1 and product_id = $2 and entity_id = $3`, [listId, it.productId, s.entityId]);
    } else {
      need(it.priceMinor >= 0n, "a price cannot be negative");
      await c.query(`insert into price_list_item (entity_id, price_list_id, product_id, price_minor) values ($1,$2,$3,$4)
                     on conflict (price_list_id, product_id) do update set price_minor = excluded.price_minor`,
        [s.entityId, listId, it.productId, it.priceMinor.toString()]);
    }
  }
  await audit(c, s, { table: "price_list_item", rowId: listId, action: "update", after: items.map((i) => ({ ...i, priceMinor: i.priceMinor?.toString() ?? null })) });
}

export type PromoIn = { name: string; kind: string; pctBps?: number | null; amountMinor?: bigint | null; productId?: string | null;
  vendorId?: string | null; category?: string | null; startsOn: string; endsOn: string; respectMap?: boolean };

export async function createPromotion(c: Client, s: Scope, p: PromoIn): Promise<string> {
  need(p.name && p.name.trim(), "a promotion needs a name");
  need(["percent", "amount_off", "fixed_price"].includes(p.kind), "a promotion is a percent off, an amount off, or a fixed price");
  const day = /^\d{4}-\d{2}-\d{2}$/;
  need(day.test(p.startsOn ?? "") && day.test(p.endsOn ?? ""), "a promotion needs start and end dates");
  need(p.endsOn >= p.startsOn, "a promotion cannot end before it starts");
  if (p.kind === "percent") need(Number.isInteger(p.pctBps) && p.pctBps! >= 1 && p.pctBps! <= 9000, "percent off is between 0.01% and 90%");
  else need(p.amountMinor != null && p.amountMinor > 0n, p.kind === "fixed_price" ? "say the promoted price" : "say how much off");
  need(p.productId || p.vendorId || p.category, "a promotion reaches a product, a vendor or a category; a store-wide sale names a category per line");
  if (p.productId) await productOf(c, s.entityId, p.productId);
  if (p.vendorId) await vendorOf(c, s.entityId, p.vendorId);
  need(p.kind !== "fixed_price" || p.productId, "a fixed promoted price is for one product");
  const r = await one<{ id: string }>(c, `
    insert into promotion (entity_id, name, kind, pct_bps, amount_minor, product_id, vendor_id, category, starts_on, ends_on, respect_map, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [s.entityId, p.name.trim(), p.kind, p.kind === "percent" ? p.pctBps : null, p.kind === "percent" ? null : p.amountMinor!.toString(),
     p.productId ?? null, p.vendorId ?? null, p.category?.trim() || null, p.startsOn, p.endsOn, p.respectMap ?? true, s.actor.id || null]);
  await audit(c, s, { table: "promotion", rowId: r.id, action: "insert", after: { ...p, amountMinor: p.amountMinor?.toString() ?? null } });
  return r.id;
}

export async function endPromotion(c: Client, s: Scope, id: string, reason: string) {
  need(reason && reason.trim(), "say why the promotion is ending early");
  const r = await q(c, `update promotion set active = false where id = $1 and entity_id = $2 and active returning id`, [id, s.entityId]);
  need(r.length, "no such live promotion");
  await audit(c, s, { table: "promotion", rowId: id, action: "transition", after: { active: false }, reason });
}

// ---------------------------------------------- vendor facts and freight --

export type VendorProfileIn = { orderEmail?: string | null; accountNo?: string | null; skuPrefix?: string | null; leadDays?: number;
  freightMinMinor?: bigint; freightMinQty?: number; notes?: string | null };

export async function saveVendorProfile(c: Client, s: Scope, vendorId: string, v: VendorProfileIn) {
  await vendorOf(c, s.entityId, vendorId);
  if (v.orderEmail) need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.orderEmail), `${v.orderEmail} is not an email address`);
  if (v.skuPrefix) need(/^[A-Z0-9]{1,8}$/.test(v.skuPrefix), "a SKU prefix is 1 to 8 capital letters or digits");
  if (v.leadDays != null) need(Number.isInteger(v.leadDays) && v.leadDays >= 0 && v.leadDays <= 365, "lead time is 0 to 365 days");
  if (v.freightMinMinor != null) need(v.freightMinMinor >= 0n, "a freight minimum cannot be negative");
  if (v.freightMinQty != null) need(Number.isInteger(v.freightMinQty) && v.freightMinQty >= 0, "a piece minimum is a whole number");
  const cur = (await q<Record<string, unknown>>(c, `select * from vendor_profile where entity_id = $1 and vendor_id = $2`, [s.entityId, vendorId]))[0] ?? {};
  const pick = <T>(nv: T | undefined, col: string, dflt: unknown) => (nv !== undefined ? nv : cur[col] !== undefined ? cur[col] : dflt);
  await c.query(`
    insert into vendor_profile (entity_id, vendor_id, order_email, account_no, sku_prefix, lead_days, freight_min_minor, freight_min_qty, notes)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict (entity_id, vendor_id) do update set order_email = excluded.order_email, account_no = excluded.account_no,
      sku_prefix = excluded.sku_prefix, lead_days = excluded.lead_days, freight_min_minor = excluded.freight_min_minor,
      freight_min_qty = excluded.freight_min_qty, notes = excluded.notes`,
    [s.entityId, vendorId, pick(v.orderEmail === undefined ? undefined : v.orderEmail || null, "order_email", null), pick(v.accountNo, "account_no", null),
     pick(v.skuPrefix === undefined ? undefined : v.skuPrefix || null, "sku_prefix", null), pick(v.leadDays, "lead_days", 30),
     String(pick(v.freightMinMinor, "freight_min_minor", 0)), pick(v.freightMinQty, "freight_min_qty", 0), pick(v.notes, "notes", null)]);
  await audit(c, s, { table: "vendor_profile", rowId: vendorId, action: "update", before: cur,
    after: { ...v, freightMinMinor: v.freightMinMinor?.toString() } });
}

export async function setFreight(c: Client, s: Scope, vendorId: string, locationId: string, freightBps: number, perUnitMinor: bigint) {
  await vendorOf(c, s.entityId, vendorId);
  const l = await q(c, `select 1 from location where id = $1 and entity_id = $2`, [locationId, s.entityId]);
  need(l.length, "no such store or warehouse");
  need(Number.isInteger(freightBps) && freightBps >= 0 && freightBps <= 10000, "freight percent is 0 to 100");
  need(perUnitMinor >= 0n, "freight per unit cannot be negative");
  await c.query(`insert into vendor_freight (entity_id, vendor_id, location_id, freight_bps, per_unit_minor) values ($1,$2,$3,$4,$5)
                 on conflict (entity_id, vendor_id, location_id) do update set freight_bps = excluded.freight_bps, per_unit_minor = excluded.per_unit_minor`,
    [s.entityId, vendorId, locationId, freightBps, perUnitMinor.toString()]);
  await audit(c, s, { table: "vendor_freight", rowId: vendorId, action: "update", after: { locationId, freightBps, perUnitMinor: perUnitMinor.toString() } });
}

/** Freight on one unit of cost from this vendor to this place. */
export function freightOn(costMinor: bigint, f: { freight_bps: number; per_unit_minor: string } | null | undefined): bigint {
  if (!f) return 0n;
  return (costMinor * BigInt(f.freight_bps) + 5000n) / 10000n + BigInt(f.per_unit_minor);
}

/** Gross margin in basis points of price; null when there is no price. */
export const marginBps = (price: bigint, cost: bigint): number | null =>
  price > 0n ? Number(((price - cost) * 10000n) / price) : null;

// ------------------------------------------------------------ barcodes --
// Code 128, code set B (printable ASCII). Bar/space module widths, starting
// with a bar; the stop pattern is the 13-module one with its final bar.

const C128 = ("212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 " +
  "123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 " +
  "111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 " +
  "231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 " +
  "141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 " +
  "124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 " +
  "311141 411131 211412 211214 211232 2331112").split(" ");

export const CODE128_PATTERNS = C128;

/** Module widths for a Code 128-B symbol (quiet zones are the caller's). */
export function code128(text: string): number[] {
  need(text.length > 0 && text.length <= 40, "a barcode holds 1 to 40 characters");
  const vals: number[] = [104];
  for (const ch of text) {
    const v = ch.charCodeAt(0) - 32;
    need(v >= 0 && v <= 95, `${ch} cannot be printed in a barcode`);
    vals.push(v);
  }
  let sum = 104;
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103, 106);
  return vals.flatMap((v) => C128[v].split("").map(Number));
}

/** Read widths back to text: the check the printer cannot do. */
export function decode128(widths: number[]): string {
  const syms: number[] = [];
  let i = 0;
  while (i < widths.length) {
    const len = widths.length - i === 7 ? 7 : 6;
    const pat = widths.slice(i, i + len).join("");
    const v = C128.indexOf(pat);
    need(v >= 0, "unreadable barcode");
    syms.push(v); i += len;
  }
  need(syms[0] === 104 && syms[syms.length - 1] === 106, "not a code set B symbol");
  const data = syms.slice(1, -2);
  let sum = 104;
  data.forEach((v, k) => { sum += v * (k + 1); });
  need(sum % 103 === syms[syms.length - 2], "barcode check digit is wrong");
  return String.fromCharCode(...data.map((v) => v + 32));
}

// -------------------------------------------------------- photo proxy --
// A product's photo, fetched from the address stored on that product only,
// over https, image types only, at most 5 MB, with a short timeout, and kept
// in catalog_image_cache so the vendor is asked once a week at most. Served
// back as a data: URL, which the page's image policy already allows.

export type ImageFetch = (url: string, init: { signal: AbortSignal; redirect: "follow"; headers: Record<string, string> }) =>
  Promise<{ status: number; url?: string; headers: { get(k: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;

const IMAGE_TYPES = /^image\/(jpeg|png|gif|webp|avif)$/;
export const IMAGE_MAX = 5 * 1024 * 1024;

function publicHttps(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new CatalogError("that photo address is not a web address"); }
  need(u.protocol === "https:", "only https photo addresses are fetched");
  const h = u.hostname.toLowerCase();
  const privateHost = h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^\[/.test(h)
    || /^(127|10|0)\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  need(!privateHost, "photo addresses on private networks are not fetched");
  return u;
}

export async function productImage(c: Client, entityId: string, productId: string, seq: number,
  fetchImpl: ImageFetch = globalThis.fetch as unknown as ImageFetch, maxAgeDays = 7): Promise<{ contentType: string; dataUrl: string; bytes: number; cached: boolean } | null> {
  const im = (await q<{ url: string }>(c, `select url from product_image where entity_id = $1 and product_id = $2 and seq = $3`, [entityId, productId, seq]))[0];
  if (!im) return null;
  const hit = (await q<{ content_type: string; bytes: Buffer; fresh: boolean }>(c, `
    select content_type, bytes, fetched_at > now() - make_interval(days => $3) fresh from catalog_image_cache where entity_id = $1 and url = $2`,
    [entityId, im.url, maxAgeDays]))[0];
  const out = (type: string, b: Buffer, cached: boolean) => ({ contentType: type, dataUrl: `data:${type};base64,${b.toString("base64")}`, bytes: b.length, cached });
  if (hit?.fresh) return out(hit.content_type, hit.bytes, true);
  const u = publicHttps(im.url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  let type = "", body: Buffer;
  try {
    let r;
    try { r = await fetchImpl(u.toString(), { signal: ctl.signal, redirect: "follow", headers: { accept: "image/*" } }); }
    catch (e) {
      if (hit) return out(hit.content_type, hit.bytes, true);      // an old copy beats nothing
      throw new CatalogError(ctl.signal.aborted ? "the photo's host took too long to answer" : "the photo's host could not be reached");
    }
    if (r.url) publicHttps(r.url);                                   // a redirect may not leave https or go private
    need(r.status === 200, `the photo's host answered ${r.status}`);
    type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    need(IMAGE_TYPES.test(type), `that address is not a photo (${type || "no type"}); JPEG, PNG, GIF, WebP or AVIF only`);
    const len = Number(r.headers.get("content-length") ?? "0");
    need(!(len > IMAGE_MAX), "that photo is larger than 5 MB");
    body = Buffer.from(await r.arrayBuffer());
    need(body.length <= IMAGE_MAX, "that photo is larger than 5 MB");
    need(body.length > 0, "the photo's host sent an empty file");
  } finally { clearTimeout(timer); }
  await c.query(`insert into catalog_image_cache (entity_id, url, content_type, bytes, fetched_at) values ($1,$2,$3,$4,now())
                 on conflict (entity_id, url) do update set content_type = excluded.content_type, bytes = excluded.bytes, fetched_at = now()`,
    [entityId, im.url, type, body]);
  return out(type, body, false);
}
