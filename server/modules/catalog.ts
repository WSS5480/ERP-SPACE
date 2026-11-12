// catalog module -- see docs/MODULES.md for the contract.
// Product master, options and special-order templates, packages, cartons,
// images, price lists, promotions, margins, price tags with barcodes, vendor
// ordering facts and freight, and the vendor feed import.
import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { ModuleError, PublicPage, Download, need, requireRole, str, uuid, int, minor, seesCost, scrubCost, lookOnly } from "./kit.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { xlsxRows, isXlsx, FileError } from "../../packages/core/filekit.ts";
import { loadPin } from "../../packages/core/connections.ts";
import { TransportError } from "../../packages/core/transports.ts";
import * as vfiles from "../../packages/core/vendor_files.ts";
import { decisionFor, wentLive } from "../../packages/core/approvals.ts";
import { supportMarker } from "../../packages/core/db.ts";
import { productSheet } from "./tearsheet.ts";
import { q } from "../../packages/core/db.ts";
import { scopeOf } from "../actions.ts";
import * as cat from "../../packages/core/catalog.ts";
import { priceConfigured, PricingError, type Choice } from "../../packages/core/pricing.ts";
import * as feeds from "../../packages/core/vendor_feeds.ts";
import { gradesForProducts, CONDITION_WORDS } from "../../packages/core/configurator.ts";

/** The network the vendor connections use: the real one, unless checks hand in a fake. */
let feedEnv: () => feeds.FeedEnv = feeds.liveEnv;
export const useFeedEnv = (fn: () => feeds.FeedEnv) => { feedEnv = fn; };
export const currentFeedEnv = () => feedEnv();
/** How photos are fetched for the image proxy: the real network, unless checks hand in a fake. */
let imageFetch: cat.ImageFetch | undefined;
export const useImageFetch = (f: cat.ImageFetch | undefined) => { imageFetch = f; };
export const currentImageFetch = () => imageFetch;

const ID = "([0-9a-fA-F-]{36})";
const EDIT = ["buyer"];

// The catalog import template: the .xlsx (Catalog sheet: required headings dark, optional light, a grey example row 2,
// status as a drop-down; an Instructions sheet) is a file kept beside the server; the checks hold its headings to IMPORT_FIELDS.
const TEMPLATE_XLSX = join(dirname(fileURLToPath(import.meta.url)), "..", "static", "vendor-catalog-template.xlsx");
export const templateCsv = () => cat.IMPORT_FIELDS.map((f) => f.name).join(",") + "\r\n";
export const templateXlsx = () => readFileSync(TEMPLATE_XLSX);

/** An uploaded workbook (base64) as CSV text: its Catalog sheet, else the first. */
export function xlsxToCsv(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  if (!isXlsx(buf)) throw new cat.CatalogError("that file is not an Excel workbook (.xlsx); save it as .xlsx or CSV");
  const q_ = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return xlsxRows(buf).filter((r) => r.some((v) => String(v ?? "").trim())).map((r) => r.map((v) => q_(String(v ?? ""))).join(",")).join("\r\n");
}
const uploadCsv = (b: Record<string, unknown>) => (typeof b.xlsx === "string" && b.xlsx ? xlsxToCsv(b.xlsx) : typeof b.csv === "string" ? b.csv : "");
const FLOOR = ["buyer", "store_manager"];

/** Core refusals are sentences already; hand them on as module refusals (422). */
async function refuse<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof cat.CatalogError || e instanceof PricingError || e instanceof feeds.FeedError || e instanceof FileError || e instanceof TransportError || e instanceof vfiles.VendorFilesError) throw new ModuleError(e.message);
    throw e;
  }
}

const has = (b: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const optStr = (b: Record<string, unknown>, k: string, max = 200) => (has(b, k) ? (str(b[k], max) || null) : undefined);
const optMoney = (b: Record<string, unknown>, k: string) => (has(b, k) ? (b[k] === null || b[k] === "" ? null : minor(b[k])) : undefined);
const optNum = (b: Record<string, unknown>, k: string) => {
  if (!has(b, k)) return undefined;
  if (b[k] === null || b[k] === "") return null;
  const n = Number(b[k]);
  need(Number.isFinite(n) && n >= 0, `${k.replace(/([A-Z])/g, " $1").toLowerCase()} must be a positive number`);
  return n;
};
const optBool = (b: Record<string, unknown>, k: string) => (has(b, k) ? b[k] === true || b[k] === "true" : undefined);

function productIn(b: Record<string, unknown>): cat.ProductInput {
  const p: cat.ProductInput = {};
  if (has(b, "sku")) p.sku = str(b.sku, 40).toUpperCase();
  if (has(b, "name")) p.name = str(b.name, 200);
  if (has(b, "kind")) p.kind = str(b.kind, 20);
  if (has(b, "vendorId")) p.vendorId = b.vendorId ? uuid(b.vendorId) : null;
  if (has(b, "vendorId") && b.vendorId && !p.vendorId) throw new ModuleError("that vendor is not set up for this company");
  p.vendorSku = optStr(b, "vendorSku", 60)?.toUpperCase() ?? (has(b, "vendorSku") ? null : undefined);
  for (const k of ["brand", "category", "subcategory", "collection", "color"] as const) p[k] = optStr(b, k, 80);
  p.description = optStr(b, "description", 4000);
  p.barcode = optStr(b, "barcode", 40);
  const price = optMoney(b, "price"); if (price !== undefined) { need(price !== null, "a product needs a price, even if it is 0"); p.priceMinor = price; }
  const cost = optMoney(b, "cost"); if (cost !== undefined) { need(cost !== null, "a product needs a cost, even if it is 0"); p.costMinor = cost; }
  p.mapMinor = optMoney(b, "map");
  p.msrpMinor = optMoney(b, "msrp");
  p.taxable = optBool(b, "taxable"); p.serialized = optBool(b, "serialized"); p.webVisible = optBool(b, "webVisible");
  if (has(b, "shipClass")) p.shipClass = str(b.shipClass, 20);
  p.cubicFt = optNum(b, "cubicFt"); p.weightLb = optNum(b, "weightLb");
  for (const k of Object.keys(p) as (keyof cat.ProductInput)[]) if (p[k] === undefined) delete p[k];
  return p;
}

function groupIn(g: Record<string, unknown>): cat.GroupIn {
  const opts = Array.isArray(g.options) ? g.options as Record<string, unknown>[] : [];
  return {
    code: str(g.code, 40).toLowerCase(), label: str(g.label, 80), required: g.required !== false, multi: g.multi === true, seq: int(g.seq, 0),
    options: opts.map((o) => ({
      code: str(o.code, 40).toLowerCase(), label: str(o.label, 120),
      priceDeltaMinor: o.priceDelta == null || o.priceDelta === "" ? 0n : minor(o.priceDelta),
      costDeltaMinor: o.costDelta == null || o.costDelta === "" ? 0n : minor(o.costDelta),
      leadDays: o.leadDays == null || o.leadDays === "" ? 0 : int(o.leadDays, -1), swatch: str(o.swatch, 200) || null, vendorCode: str(o.vendorCode, 40) || null,
    })),
  };
}

/** One client runs one query at a time; run these in turn. */
async function inOrder(fns: (() => Promise<Record<string, unknown>[]>)[]): Promise<Record<string, unknown>[][]> {
  const out: Record<string, unknown>[][] = [];
  for (const f of fns) out.push(await f());
  return out;
}

const choicesParam = (url: URL): Choice[] => {
  const raw = url.searchParams.get("choices");
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v as Choice[];
    return Object.entries(v as Record<string, string | string[]>).map(([group, option]) => ({ group, option }));
  } catch { throw new ModuleError("choices must be JSON, like {\"fabric\":\"velvet-navy\"}"); }
};

// ----------------------------------------------------------------- reads

async function listProducts(c: Client, co: Company, url: URL) {
  const p = url.searchParams;
  const term = str(p.get("q"), 80);
  const vendor = uuid(p.get("vendor"));
  const category = str(p.get("category"), 80) || null;
  const status = str(p.get("status"), 20) || null;
  const kind = str(p.get("kind"), 20) || null;
  const limit = Math.min(Math.max(int(p.get("limit") || 50, 50), 1), 200);
  const offset = Math.max(int(p.get("offset"), 0), 0);
  const where = `p.entity_id = $1
    and ($2 = '' or p.name ilike '%' || $2 || '%' or p.sku ilike '%' || $2 || '%' or p.vendor_sku ilike '%' || $2 || '%'
         or p.barcode = $2 or coalesce(p.collection,'') ilike '%' || $2 || '%')
    and ($3::uuid is null or p.vendor_id = $3) and ($4::text is null or p.category = $4)
    and ($5::text is null or p.status = $5) and ($6::text is null or p.kind = $6)`;
  const args = [co.id, term, vendor, category, status, kind];
  const items = await q(c, `
    select p.id, p.sku, p.name, p.kind, p.status, p.status_note, p.vendor_id, coalesce(v.dba, v.legal_name) vendor, p.vendor_sku,
           p.category, p.subcategory, p.collection, p.color, p.price_minor, p.cost_minor, p.map_minor, p.web_visible,
           case when p.price_minor > 0 then ((p.price_minor - p.cost_minor) * 10000 / p.price_minor)::int end margin_bps,
           (p.map_minor is not null and p.price_minor < p.map_minor) below_map,
           (select url from product_image i where i.entity_id = p.entity_id and i.product_id = p.id order by seq limit 1) image,
           (select coalesce(sum(a.on_hand), 0) from product_availability a where a.entity_id = p.entity_id and a.product_id = p.id) on_hand,
           (select coalesce(sum(a.available), 0) from product_availability a where a.entity_id = p.entity_id and a.product_id = p.id) available,
           (select count(*) from product_piece x where x.entity_id = p.entity_id and x.product_id = p.id) pieces
      from product p left join vendor v on v.id = p.vendor_id
     where ${where} order by p.name, p.sku limit ${limit} offset ${offset}`, args);
  const total = (await q<{ n: string }>(c, `select count(*) n from product p where ${where}`, args))[0].n;
  const statuses = await q(c, `select status, count(*) n from product where entity_id = $1 group by status order by status`, [co.id]);
  return { items, total: Number(total), limit, offset, statuses };
}

async function formOptions(c: Client, co: Company) {
  const [vendors, categories, locations, templates, priceLists] = await inOrder([
    () => q(c, `select v.id, coalesce(v.dba, v.legal_name) as name, vp.sku_prefix from vendor_entity ve join vendor v on v.id = ve.vendor_id
            left join vendor_profile vp on vp.entity_id = ve.entity_id and vp.vendor_id = v.id
           where ve.entity_id = $1 and ve.status = 'active' and exists (select 1 from vendor_merchandise vm where vm.entity_id = ve.entity_id and vm.vendor_id = ve.vendor_id and vm.is_merchandise) order by 2`, [co.id]),
    () => q(c, `select category, array_agg(distinct subcategory) filter (where subcategory is not null) subs, count(*) n
            from product where entity_id = $1 and category is not null group by category order by category`, [co.id]),
    () => q(c, `select id, code, name, kind from location where entity_id = $1 and status = 'active' and kind not in ('in_transit','dropship') order by kind <> 'warehouse', name`, [co.id]),
    () => q(c, `select t.id, t.name, t.vendor_id, t.category from option_template t where t.entity_id = $1 and t.active order by t.name`, [co.id]),
    () => q(c, `select id, code, name from price_list where entity_id = $1 and active order by code`, [co.id]),
  ]);
  return { vendors, categories, locations, templates, priceLists, kinds: cat.KINDS, statuses: cat.STATUSES, shipClasses: cat.SHIP_CLASSES };
}

async function productDetail(c: Client, co: Company, id: string) {
  const p = (await q<Record<string, unknown>>(c, `
    select p.*, coalesce(v.dba, v.legal_name) vendor from product p left join vendor v on v.id = p.vendor_id
     where p.id = $1 and p.entity_id = $2`, [id, co.id]))[0];
  if (!p) return null;
  const [images, pieces, kit, groups, options, lists, promos, stock, applied, templates, freight, usedIn] = await inOrder([
    () => q(c, `select seq, url, alt from product_image where entity_id = $1 and product_id = $2 order by seq`, [co.id, id]),
    () => q(c, `select seq, label, cubic_ft, weight_lb from product_piece where entity_id = $1 and product_id = $2 order by seq`, [co.id, id]),
    () => q(c, `select k.component_id id, x.sku, x.name, k.qty, x.price_minor, x.cost_minor from product_kit_component k
            join product x on x.id = k.component_id and x.entity_id = k.entity_id where k.entity_id = $1 and k.kit_id = $2 order by k.seq`, [co.id, id]),
    () => q(c, `select id, code, label, required, multi, seq from product_option_group where entity_id = $1 and product_id = $2 order by seq, code`, [co.id, id]),
    () => q(c, `select o.group_id, o.code, o.label, o.price_delta_minor, o.cost_delta_minor, o.lead_days, o.swatch, o.vendor_code, o.active, o.seq
            from product_option o where o.entity_id = $1
             and o.group_id in (select id from product_option_group where entity_id = $1 and product_id = $2) order by o.seq`, [co.id, id]),
    () => q(c, `select l.id, l.code, l.name, i.price_minor from price_list_item i join price_list l on l.id = i.price_list_id
           where i.entity_id = $1 and i.product_id = $2 order by l.code`, [co.id, id]),
    () => q(c, `select id, name, kind, pct_bps, amount_minor, starts_on::text, ends_on::text, respect_map,
                 case when product_id is not null then 'this product' when vendor_id is not null and category is not null then 'vendor and category'
                      when vendor_id is not null then 'vendor' else 'category' end reach
            from promotion where entity_id = $1 and active and ends_on >= business_today($1)
             and (product_id = $2 or (product_id is null and (vendor_id is null or vendor_id = $3) and (category is null or category = $4)))
           order by starts_on`, [co.id, id, p.vendor_id, p.category]),
    () => q(c, `select a.location_id, l.name location, a.location_kind, a.on_hand, a.reserved, a.available, a.on_order
            from product_availability a join location l on l.id = a.location_id where a.entity_id = $1 and a.product_id = $2 order by l.name`, [co.id, id]),
    () => q(c, `select t.id, t.name, a.applied_at from product_template_applied a join option_template t on t.id = a.template_id
           where a.entity_id = $1 and a.product_id = $2`, [co.id, id]),
    () => q(c, `select id, name from option_template where entity_id = $1 and active
             and (vendor_id is null or vendor_id = $2) and (category is null or category = $3) order by name`, [co.id, p.vendor_id, p.category]),
    () => q(c, `select f.location_id, l.name location, f.freight_bps, f.per_unit_minor from vendor_freight f join location l on l.id = f.location_id
           where f.entity_id = $1 and f.vendor_id = $2 order by l.name`, [co.id, p.vendor_id]),
    () => q(c, `select k.kit_id id, x.sku, x.name, k.qty from product_kit_component k join product x on x.id = k.kit_id
           where k.entity_id = $1 and k.component_id = $2`, [co.id, id]),
  ]);
  let price: unknown = null, priceProblem: string | null = null;
  try { price = await priceConfigured(c, co.id, id, []); }
  catch (e) { if (e instanceof PricingError) priceProblem = e.message; else throw e; }
  const cost = BigInt(String(p.cost_minor));
  return {
    product: p, images, pieces, kit, usedIn, lists, promos, stock, applied, templates,
    groups: groups.map((g) => ({ ...g, options: options.filter((o) => o.group_id === g.id) })),
    freight: freight.map((f) => ({ ...f, landed_minor: (cost + cat.freightOn(cost, f as { freight_bps: number; per_unit_minor: string })).toString() })),
    marginBps: cat.marginBps(BigInt(String(p.price_minor)), cost), price, priceProblem,
  };
}

async function margins(c: Client, co: Company, url: URL) {
  const vendor = uuid(url.searchParams.get("vendor"));
  const category = str(url.searchParams.get("category"), 80) || null;
  let loc = uuid(url.searchParams.get("location"));
  if (!loc) loc = (await q<{ id: string }>(c, `select id from location where entity_id = $1 and status = 'active' and kind not in ('in_transit','dropship') order by kind <> 'warehouse', name limit 1`, [co.id]))[0]?.id ?? null;
  const rows = await q<{ id: string; sku: string; name: string; status: string; vendor: string | null; category: string | null; price_minor: string; cost_minor: string;
    map_minor: string | null; freight_bps: number | null; per_unit_minor: string | null }>(c, `
    select p.id, p.sku, p.name, p.status, coalesce(v.dba, v.legal_name) vendor, p.category, p.price_minor, p.cost_minor, p.map_minor,
           f.freight_bps, f.per_unit_minor
      from product p left join vendor v on v.id = p.vendor_id
      left join vendor_freight f on f.entity_id = p.entity_id and f.vendor_id = p.vendor_id and f.location_id = $4
     where p.entity_id = $1 and p.kind in ('stock','configurable','special_order','kit') and p.status <> 'discontinued'
       and ($2::uuid is null or p.vendor_id = $2) and ($3::text is null or p.category = $3)
     order by p.category nulls last, p.name limit 500`, [co.id, vendor, category, loc]);
  const out = [];
  let sumPrice = 0n, sumLanded = 0n;
  for (const r of rows) {
    let promo: { unitPriceMinor: bigint; promotion?: { name: string } | null } | null = null;
    try {
      const pc = await priceConfigured(c, co.id, r.id, []);
      if (pc.promotion) promo = pc;
    } catch (e) { if (!(e instanceof PricingError)) throw e; }
    const price = BigInt(r.price_minor), cost = BigInt(r.cost_minor);
    const freight = cat.freightOn(cost, r.freight_bps == null ? null : { freight_bps: r.freight_bps, per_unit_minor: r.per_unit_minor ?? "0" });
    const landed = cost + freight;
    if (price > 0n) { sumPrice += price; sumLanded += landed; }
    out.push({
      id: r.id, sku: r.sku, name: r.name, status: r.status, vendor: r.vendor, category: r.category,
      price_minor: r.price_minor, cost_minor: r.cost_minor, freight_minor: freight.toString(), landed_minor: landed.toString(),
      map_minor: r.map_minor, margin_bps: cat.marginBps(price, landed),
      promo_minor: promo?.unitPriceMinor.toString() ?? null, promo_name: promo?.promotion?.name ?? null,
      promo_margin_bps: promo ? cat.marginBps(promo.unitPriceMinor, landed) : null,
      below_map: r.map_minor != null && price < BigInt(r.map_minor),
    });
  }
  return { locationId: loc, items: out, blendedBps: cat.marginBps(sumPrice, sumLanded) };
}

async function labels(c: Client, co: Company, url: URL) {
  const ids = (url.searchParams.get("ids") ?? "").split(",").map((x) => uuid(x.trim())).filter(Boolean) as string[];
  const vendor = uuid(url.searchParams.get("vendor"));
  const category = str(url.searchParams.get("category"), 80) || null;
  const list = str(url.searchParams.get("list"), 24) || null;
  const rows = await q<{ id: string; sku: string; name: string; brand: string | null; collection: string | null; color: string | null;
    barcode: string | null; msrp_minor: string | null; status: string; kind: string; pieces: string; dims: string | null }>(c, `
    select p.id, p.sku, p.name, p.brand, p.collection, p.color, p.barcode, p.msrp_minor, p.status, p.kind,
           (select count(*) from product_piece x where x.entity_id = p.entity_id and x.product_id = p.id) pieces, p.attributes->>'dimensions' dims
      from product p
     where p.entity_id = $1 and p.status in ('active','floor_sample','drop')
       and p.kind not in ('service','fee','warranty','gift_card')
       and (cardinality($2::uuid[]) = 0 or p.id = any($2)) and ($3::uuid is null or p.vendor_id = $3) and ($4::text is null or p.category = $4)
     order by p.category, p.name limit 200`, [co.id, ids, vendor, category]);
  const out = [];
  // A floor sample or as-is piece carries its condition grade on the tag (configurator).
  const graded = await gradesForProducts(c, co.id, rows.filter((r) => r.status === "floor_sample").map((r) => r.id));
  for (const r of rows) {
    let pc;
    try { pc = await priceConfigured(c, co.id, r.id, [], { priceList: list }); }
    catch (e) { if (e instanceof PricingError) continue; throw e; }
    const code = r.barcode && /^[\x20-\x7e]+$/.test(r.barcode) ? r.barcode : r.sku;
    out.push({
      id: r.id, sku: r.sku, name: r.name, brand: r.brand, collection: r.collection, color: r.color, status: r.status, pieces: Number(r.pieces),
      ticket_minor: pc.ticketMinor?.toString(), price_minor: pc.unitPriceMinor.toString(), msrp_minor: r.msrp_minor,
      promotion: pc.promotion ? { name: pc.promotion.name, savings_minor: pc.promotion.savingsMinor.toString() } : null,
      price_list: pc.priceList, from_options: r.kind === "configurable" || r.kind === "special_order",
      kit: pc.kit ? { component_total_minor: pc.kit.componentTotalMinor.toString(), pieces: pc.kit.components.map((k) => `${k.qty} × ${k.name}`) } : null,
      barcode: { text: code, bars: cat.code128(code) },
      condition: (() => { const g = graded.find((x) => x.product_id === r.id && x.grade); return g ? { grade: g.grade, words: CONDITION_WORDS[g.grade], price_minor: g.price_minor } : null; })(),
    });
  }
  return { items: out };
}

async function vendors(c: Client, co: Company, personId: string | null = null) {
  const rows = await q(c, `
    select v.id, coalesce(v.dba, v.legal_name) as name, vp.order_email, vp.account_no, vp.sku_prefix, coalesce(vp.lead_days, 30) lead_days,
           coalesce(vp.freight_min_minor, 0) freight_min_minor, ve.status, coalesce(vp.freight_min_qty, 0) freight_min_qty, vp.notes,
           (select count(*) from product p where p.entity_id = ve.entity_id and p.vendor_id = v.id) products,
           (select max(created_at) from catalog_import_run r where r.entity_id = ve.entity_id and r.vendor_id = v.id) last_import,
           (select count(*) from vendor_feed f where f.entity_id = ve.entity_id and f.vendor_id = v.id) feeds,
           (select count(*) from vendor_feed f where f.entity_id = ve.entity_id and f.vendor_id = v.id and f.active and f.last_ok = false) feeds_failing,
           (select max(last_run_at) from vendor_feed f where f.entity_id = ve.entity_id and f.vendor_id = v.id) feeds_last_run,
           (select mailbox_key from inbound_mailbox mb where mb.entity_id = ve.entity_id and mb.vendor_id = v.id) mailbox_key,
           (select count(*) from connection cn where cn.entity_id = ve.entity_id and cn.vendor_id = v.id and cn.source_code = 'vendor_files' and cn.status <> 'retired') vendor_files,
           (select count(*) from inbound_file x join connection cn on cn.id = x.connection_id where cn.entity_id = ve.entity_id and cn.vendor_id = v.id and x.status = 'quarantined') files_quarantined
      from vendor_entity ve join vendor v on v.id = ve.vendor_id
      left join vendor_profile vp on vp.entity_id = ve.entity_id and vp.vendor_id = v.id
     where ve.entity_id = $1 and ve.status in ('active', 'hold') and exists (select 1 from vendor_merchandise vm where vm.entity_id = ve.entity_id and vm.vendor_id = ve.vendor_id and vm.is_merchandise) order by 2`, [co.id]);
  // A vendor waiting on approval shows with its request, and whether the person looking can approve it now.
  const pending = await q<{ subject_id: string; id: string }>(c, `select subject_id, id from approval_request where entity_id = $1 and subject_type = 'vendor' and status = 'open'`, [co.id]);
  const waiting = new Map(pending.map((r) => [r.subject_id, r.id]));
  const freight = await q(c, `select f.vendor_id, f.location_id, l.name location, f.freight_bps, f.per_unit_minor
                                from vendor_freight f join location l on l.id = f.location_id where f.entity_id = $1 order by l.name`, [co.id]);
  const out = [];
  // ERP setup (support mode) before go-live approves a new vendor for the owner ("Approve (setup)"); after go-live it says why not
  const support = !!(await supportMarker(c));
  const live = support ? await wentLive(c, co.id) : false;
  for (const { mailbox_key, ...v } of rows) {
    const requestId = v.status === "hold" ? waiting.get(String(v.id)) ?? null : null;
    const dec = requestId ? await decisionFor(c, co.id, requestId, personId) : { can: false, setup: false, setupWhy: null };
    out.push({ ...v, pending: v.status === "hold", approval_request_id: requestId, can_approve: dec.can, setup_approve: dec.setup,
      setup_note: requestId && support && !dec.setup ? (live ? "This company has gone live, so ERP setup no longer approves vendors for it; the owner approves this one signed in as themselves."
        : dec.setupWhy ? `ERP setup cannot approve this one: ${dec.setupWhy.replace(/^support mode never self-approves for the owner: /, "")}.` : null) : null,
      inbound_address: mailbox_key ? vfiles.inboundAddress(String(mailbox_key)) : null, freight: freight.filter((f) => f.vendor_id === v.id) });
  }
  return { vendors: out };
}

// --------------------------------------------------------------- module

export const module: ErpModule = {
  id: "catalog",
  register(kit) {
    const { coGet, coPost } = kit;
    const sc = (co: Company, a: Actor) => scopeOf(co, a);

    // Costs and margins only for the buyer, store managers, the controller and the owner.
    // (A read with no acting person named is the signed-in session's own, as before.)
    const guard = async <R>(c: Client, co: Company, p: string | null, v: R) => (!p || await seesCost(c, co, p) ? v : scrubCost(v));
    coGet("/catalog/products", async (c, co, url, _m, p) => guard(c, co, p, await listProducts(c, co, url)));
    coGet("/catalog/form", (c, co) => formOptions(c, co));
    coGet(`/catalog/products/${ID}`, async (c, co, _u, m, p) => guard(c, co, p, await productDetail(c, co, m[2])));
    coGet(`/catalog/price/${ID}`, (c, co, url, m) => refuse(async () => {
      const r = await priceConfigured(c, co.id, m[2], choicesParam(url), { priceList: url.searchParams.get("list"), on: url.searchParams.get("on") });
      return r;
    }));
    // Photos come through our own origin: the page's policy allows no outside images.
    // A photo that cannot be fetched is not an error for the screen: it gets no photo and the reason.
    coGet(`/catalog/image/${ID}/([0-9]{1,2})`, async (c, co, _u, m) => {
      try { return await cat.productImage(c, co.id, m[2], Number(m[3]), imageFetch); }
      catch (e) { if (e instanceof cat.CatalogError) return { dataUrl: null, problem: e.message }; throw e; }
    });
    // A printable sheet for one product: photos, options, dimensions, price, the store to ask at.
    coGet(`/catalog/products/${ID}/tear-sheet`, async (c, co, url, m) => {
      const html = await productSheet(c, co.id, m[2], { imageFetch }, uuid(url.searchParams.get("locationId")));
      return html ? new PublicPage(html) : null;
    });
    coGet("/catalog/margins", async (c, co, url, _m, p) => guard(c, co, p, await margins(c, co, url)));
    coGet("/catalog/labels", (c, co, url) => refuse(() => labels(c, co, url)));
    coGet("/catalog/vendors", (c, co, _u, _m, p) => vendors(c, co, p));
    coGet("/catalog/templates", async (c, co) => {
      const ts = await q(c, `select t.id, t.name, t.vendor_id, coalesce(v.dba, v.legal_name) vendor, t.category, t.active,
                                    (select count(*) from product_template_applied a where a.entity_id = t.entity_id and a.template_id = t.id) used
                               from option_template t left join vendor v on v.id = t.vendor_id where t.entity_id = $1 order by t.name`, [co.id]);
      const gs = await q(c, `select id, template_id, code, label, required, multi, seq from option_template_group where entity_id = $1 order by seq`, [co.id]);
      const os = await q(c, `select group_id, code, label, price_delta_minor, cost_delta_minor, lead_days, swatch, vendor_code, active, seq
                               from option_template_option where entity_id = $1 order by seq`, [co.id]);
      return { templates: ts.map((t) => ({ ...t, groups: gs.filter((g) => g.template_id === t.id).map((g) => ({ ...g, options: os.filter((o) => o.group_id === g.id) })) })) };
    });
    coGet("/catalog/price-lists", async (c, co) => {
      const ls = await q(c, `select id, code, name, starts_on::text, ends_on::text, active from price_list where entity_id = $1 order by code`, [co.id]);
      const items = await q(c, `select i.price_list_id, i.product_id, p.sku, p.name, p.price_minor ticket_minor, i.price_minor
                                  from price_list_item i join product p on p.id = i.product_id where i.entity_id = $1 order by p.name`, [co.id]);
      return { lists: ls.map((l) => ({ ...l, items: items.filter((i) => i.price_list_id === l.id) })) };
    });
    coGet("/catalog/promotions", async (c, co) => ({
      promotions: await q(c, `
        select pr.id, pr.name, pr.kind, pr.pct_bps, pr.amount_minor, pr.starts_on::text, pr.ends_on::text, pr.respect_map, pr.active,
               pr.category, p.sku, p.name product, coalesce(v.dba, v.legal_name) vendor,
               case when not pr.active then 'ended' when pr.ends_on < business_today($1) then 'over' when pr.starts_on > business_today($1) then 'scheduled' else 'live' end state
          from promotion pr left join product p on p.id = pr.product_id left join vendor v on v.id = pr.vendor_id
         where pr.entity_id = $1 order by pr.active desc, pr.ends_on >= business_today($1) desc, pr.starts_on`, [co.id]),
    }));
    coGet("/catalog/import/fields", async () => ({ fields: cat.IMPORT_FIELDS }));
    coGet("/catalog/import/template\\.csv", async () => new Download(Buffer.from(templateCsv(), "utf8"), "text/csv; charset=utf-8", "vendor-catalog-template.csv"));
    coGet("/catalog/import/template\\.xlsx", async () => new Download(templateXlsx(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "vendor-catalog-template.xlsx"));
    coGet("/catalog/import/runs", async (c, co) => ({
      runs: await q(c, `select r.id, r.filename, r.status, r.rows, r.added, r.changed, r.unchanged, r.skipped, r.created_at, r.applied_at,
                               coalesce(v.dba, v.legal_name) vendor, u.name created_by
                          from catalog_import_run r join vendor v on v.id = r.vendor_id left join app_user u on u.id = r.created_by
                         where r.entity_id = $1 order by r.created_at desc limit 50`, [co.id]),
    }));
    coGet(`/catalog/import/runs/${ID}`, async (c, co, url, m) => {
      const run = (await q(c, `select r.*, coalesce(v.dba, v.legal_name) vendor from catalog_import_run r join vendor v on v.id = r.vendor_id
                                where r.id = $1 and r.entity_id = $2`, [m[2], co.id]))[0];
      if (!run) return null;
      const action = str(url.searchParams.get("action"), 10) || null;
      const rows = await q(c, `select row_no, vendor_sku, action, product_id, fields, changes, message from catalog_import_row
                                where run_id = $1 and entity_id = $2 and ($3::text is null or action = $3) order by row_no limit 300`, [m[2], co.id, action]);
      return { run, rows };
    });

    // ---- writes
    coPost("/catalog/products", async (c, co, a, b) => {
      await requireRole(c, co, a, EDIT, "adding a product");
      return { id: await refuse(() => cat.createProduct(c, sc(co, a), productIn(b), { status: str(b.status, 20) || null, note: str(b.statusNote, 300) || null })) };
    });
    coPost(`/catalog/products/${ID}`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, EDIT, "changing a product");
      await refuse(() => cat.updateProduct(c, sc(co, a), m[2], productIn(b)));
      return { ok: true };
    });
    coPost(`/catalog/products/${ID}/status`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, FLOOR, "changing a product's status");
      await refuse(() => cat.setStatus(c, sc(co, a), m[2], str(b.status, 20), str(b.note, 300) || null));
      return { ok: true };
    });
    coPost(`/catalog/products/${ID}/pieces`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, EDIT, "changing a product's cartons");
      const ps = Array.isArray(b.pieces) ? b.pieces as Record<string, unknown>[] : [];
      await refuse(() => cat.setPieces(c, sc(co, a), m[2], ps.map((x) => ({ label: str(x.label, 80), cubicFt: optNum(x, "cubicFt") ?? null, weightLb: optNum(x, "weightLb") ?? null }))));
      return { ok: true };
    });
    coPost(`/catalog/products/${ID}/images`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, EDIT, "changing a product's images");
      const im = Array.isArray(b.images) ? b.images as Record<string, unknown>[] : [];
      await refuse(() => cat.setImages(c, sc(co, a), m[2], im.map((x) => ({ url: str(x.url, 1000), alt: str(x.alt, 200) || null }))));
      return { ok: true };
    });
    coPost(`/catalog/products/${ID}/kit`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, EDIT, "changing a package");
      const cs = Array.isArray(b.components) ? b.components as Record<string, unknown>[] : [];
      await refuse(() => cat.setKit(c, sc(co, a), m[2], cs.map((x) => {
        const id = uuid(x.productId); need(id, "a component is not a product of this company");
        return { productId: id!, qty: Number(x.qty ?? 1) };
      })));
      return { ok: true };
    });
    coPost(`/catalog/products/${ID}/options`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, EDIT, "changing a product's options");
      return { groupId: await refuse(() => cat.saveOptionGroup(c, sc(co, a), m[2], groupIn(b))) };
    });
    coPost(`/catalog/products/${ID}/apply-template`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, EDIT, "applying a template");
      const t = uuid(b.templateId); need(t, "pick a template");
      return refuse(() => cat.applyTemplate(c, sc(co, a), t!, m[2]));
    });
    coPost("/catalog/templates", async (c, co, a, b) => {
      await requireRole(c, co, a, EDIT, "changing special-order templates");
      const gs = Array.isArray(b.groups) ? (b.groups as Record<string, unknown>[]).map(groupIn) : [];
      return { id: await refuse(() => cat.saveTemplate(c, sc(co, a), { id: uuid(b.id), name: str(b.name, 120), vendorId: uuid(b.vendorId), category: str(b.category, 80) || null, groups: gs })) };
    });
    coPost("/catalog/price-lists", async (c, co, a, b) => {
      await requireRole(c, co, a, EDIT, "changing price lists");
      return { id: await refuse(() => cat.savePriceList(c, sc(co, a), { code: str(b.code, 24), name: str(b.name, 120),
        startsOn: str(b.startsOn, 10) || null, endsOn: str(b.endsOn, 10) || null, active: b.active !== false })) };
    });
    coPost(`/catalog/price-lists/${ID}/items`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, EDIT, "changing price lists");
      const its = Array.isArray(b.items) ? b.items as Record<string, unknown>[] : [];
      await refuse(() => cat.setListPrices(c, sc(co, a), m[2], its.map((x) => {
        const id = uuid(x.productId); need(id, "a line is not a product of this company");
        return { productId: id!, priceMinor: x.price === null || x.price === "" ? null : minor(x.price) };
      })));
      return { ok: true };
    });
    coPost("/catalog/promotions", async (c, co, a, b) => {
      await requireRole(c, co, a, EDIT, "setting up a promotion");
      const kind = str(b.kind, 20);
      const pct = b.pct == null || b.pct === "" ? null : Math.round(Number(b.pct) * 100);
      return { id: await refuse(() => cat.createPromotion(c, sc(co, a), {
        name: str(b.name, 120), kind, pctBps: kind === "percent" ? pct : null,
        amountMinor: kind === "percent" || b.amount == null || b.amount === "" ? null : minor(b.amount),
        productId: uuid(b.productId), vendorId: uuid(b.vendorId), category: str(b.category, 80) || null,
        startsOn: str(b.startsOn, 10), endsOn: str(b.endsOn, 10), respectMap: b.respectMap !== false })) };
    });
    coPost(`/catalog/promotions/${ID}/end`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, EDIT, "ending a promotion");
      await refuse(() => cat.endPromotion(c, sc(co, a), m[2], str(b.reason, 300)));
      return { ok: true };
    });
    coPost(`/catalog/vendors/${ID}`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, EDIT, "changing a vendor's ordering details");
      await refuse(() => cat.saveVendorProfile(c, sc(co, a), m[2], {
        orderEmail: optStr(b, "orderEmail", 200), accountNo: optStr(b, "accountNo", 60), skuPrefix: optStr(b, "skuPrefix", 8)?.toUpperCase() ?? optStr(b, "skuPrefix", 8),
        leadDays: has(b, "leadDays") ? int(b.leadDays, -1) : undefined, freightMinMinor: has(b, "freightMin") ? minor(b.freightMin || "0") : undefined,
        freightMinQty: has(b, "freightMinQty") ? int(b.freightMinQty, -1) : undefined, notes: optStr(b, "notes", 500) }));
      return { ok: true };
    });
    coPost(`/catalog/vendors/${ID}/freight`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, EDIT, "changing freight");
      const loc = uuid(b.locationId); need(loc, "pick a store or warehouse");
      await refuse(() => cat.setFreight(c, sc(co, a), m[2], loc!, Math.round(Number(b.pct ?? 0) * 100), minor(b.perUnit || "0")));
      return { ok: true };
    });

    // ---- vendor API setup: per-purpose feeds
    const feedOut = async (c: Client, co: Company, f: Record<string, unknown>) => ({
      ...f,
      body_template: f.body_template ?? (f.template === "ashley_atp" ? feeds.ASHLEY_ATP_TEMPLATE : null),
      secrets: await feeds.secretStatus(c, co.id, String(f.id)),
      credential_env: f.credential_ref ? feeds.secretEnvName(String(f.credential_ref)) : null,
      credential_set: !!(f.credential_ref && feedEnv().secret(String(f.credential_ref))),
      running: !!f.running,
      transport_note: null,
      pin: f.kind === "sftp" ? await loadPin(c, { kind: "vendor_feed", id: String(f.id), entityId: co.id }) : null,
      files: f.kind === "sftp" || f.kind === "email" ? await feeds.feedFiles(c, co.id, String(f.id)) : [],
    });
    /** The vendor's own inbound address (made on first look, never on a look-only read) and what is held for it. */
    const vendorMail = async (c: Client, co: Company, vendorId: string) => {
      const have = (await q<{ mailbox_key: string }>(c, `select mailbox_key from inbound_mailbox where entity_id = $1 and vendor_id = $2`, [co.id, vendorId]))[0];
      const key = have?.mailbox_key ?? (lookOnly(c) ? null : await vfiles.mailboxOf(c, co.id, co.tenantId, vendorId));
      return { address: key ? vfiles.inboundAddress(key) : null, emailReady: !!process.env.ERP_INBOUND_EMAIL_ADDRESS, held: await vfiles.heldMail(c, co.id, vendorId) };
    };
    coGet(`/catalog/vendors/${ID}/feeds`, async (c, co, _u, m) => {
      const v = (await q<{ id: string; name: string }>(c, `select v.id, coalesce(v.dba, v.legal_name) as name from vendor_entity ve join vendor v on v.id = ve.vendor_id
                                                           where ve.entity_id = $1 and ve.vendor_id = $2 and exists (select 1 from vendor_merchandise vm where vm.entity_id = ve.entity_id and vm.vendor_id = ve.vendor_id and vm.is_merchandise)`, [co.id, m[2]]))[0];
      if (!v) return null;
      const rows = await q(c, `select f.*, exists (select 1 from vendor_feed_run r where r.entity_id = f.entity_id and r.feed_id = f.id and r.finished_at is null) running
                                 from vendor_feed f where f.entity_id = $1 and f.vendor_id = $2 order by array_position(array['products','pricing','quantities','freight','images','orders','acknowledgments'], f.purpose), f.name`, [co.id, m[2]]);
      const out = [];
      for (const r of rows) out.push(await feedOut(c, co, r));
      const locations = await q(c, `select id, code, name, kind from location where entity_id = $1 and status = 'active' and kind not in ('in_transit','dropship') order by kind <> 'warehouse', name`, [co.id]);
      return { vendor: v, feeds: out, locations, photos: await feeds.photoTally(c, co.id, m[2]), secretKeySet: !!feedEnv().secretKey, mail: await vendorMail(c, co, m[2]),
        purposes: feeds.PURPOSES, fields: feeds.PURPOSE_FIELDS, templates: [["ashley", "Ashley (products, prices, ATP quantities, freight, orders)"],
          ["generic_json", "Generic REST / JSON"], ["csv_https", "CSV over HTTPS"], ["blank", "Blank"]] };
    });
    coGet(`/catalog/vendors/${ID}/feed-templates`, async (c, co, url, m) => {
      const v = (await q<{ name: string }>(c, `select coalesce(v.dba, v.legal_name) as name from vendor_entity ve join vendor v on v.id = ve.vendor_id
                                               where ve.entity_id = $1 and ve.vendor_id = $2`, [co.id, m[2]]))[0];
      if (!v) return null;
      return { drafts: feeds.feedTemplates(str(url.searchParams.get("template"), 20) || "blank", v.name).map((d) => ({ ...d, vendor_id: m[2] })) };
    });
    coGet(`/catalog/feeds/${ID}/runs`, async (c, co, _u, m) => ({
      runs: await q(c, `select r.id, r.trigger, r.started_at, r.finished_at, r.outcome, r.rows, r.added, r.changed, r.note, r.import_run_id, u.name run_by
                          from vendor_feed_run r left join app_user u on u.id = r.run_by
                         where r.entity_id = $1 and r.feed_id = $2 order by r.started_at desc limit 30`, [co.id, m[2]]),
    }));
    const draftIn = (b: Record<string, unknown>): feeds.FeedDraft & { secrets?: Record<string, string | null> } => {
      const d = (b.feed && typeof b.feed === "object" ? b.feed : b) as Record<string, unknown>;
      const out: Record<string, unknown> = { ...d };
      out.id = uuid(d.id); out.vendor_id = uuid(d.vendor_id ?? d.vendorId) ?? "";
      out.secrets_from_feed_id = uuid(d.secrets_from_feed_id);
      if (b.secrets && typeof b.secrets === "object") {
        const sec: Record<string, string | null> = {};
        for (const [k, val] of Object.entries(b.secrets as Record<string, unknown>)) sec[k] = val === null ? null : String(val ?? "");
        out.secrets = sec;
      }
      return out as feeds.FeedDraft & { secrets?: Record<string, string | null> };
    };
    coPost("/catalog/feeds", async (c, co, a, b) => {
      await requireRole(c, co, a, EDIT, "setting up a vendor API");
      return { id: await refuse(() => feeds.saveFeed(c, sc(co, a), draftIn(b), feedEnv())) };
    });
    coPost("/catalog/feeds/test", async (c, co, a, b) => {
      await requireRole(c, co, a, EDIT, "testing a vendor API");
      return refuse(() => feeds.testFeed(c, sc(co, a), feedEnv(), draftIn(b)));
    });
    coPost(`/catalog/feeds/${ID}/run`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, EDIT, "running a vendor feed");
      return refuse(() => feeds.runFeed(c, sc(co, a), m[2], feedEnv(), "manual"));
    });
    coPost(`/catalog/feeds/${ID}/trust-key`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, ["owner"], "trusting a changed SFTP server key");
      return refuse(() => feeds.trustFeedKey(c, sc(co, a), m[2], str(b.fingerprint, 80), a.personName));
    });
    coPost(`/catalog/feeds/${ID}/stop`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, EDIT, "stopping a vendor feed");
      return refuse(() => feeds.requestStop(c, sc(co, a), m[2]));
    });
    coPost(`/catalog/feeds/${ID}/secrets`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, EDIT, "changing a feed's keys");
      const sec: Record<string, string | null> = {};
      for (const [k, val] of Object.entries(b)) sec[k] = val === null ? null : String(val ?? "");
      await refuse(() => feeds.setFeedSecrets(c, sc(co, a), feedEnv(), m[2], sec));
      return { secrets: await feeds.secretStatus(c, co.id, m[2]) };
    });
    // One-time hand-over from CATALOG-APP: its saved source (feed settings, keys, mapping) becomes this vendor's feeds.
    coPost("/vendor-api/import/catalog-app", async (c, co, a, b) => {
      await requireRole(c, co, a, EDIT, "bringing vendor API settings over from the catalog app");
      const source = (b.source && typeof b.source === "object" ? b.source : null) as feeds.CatalogAppSource | null;
      need(source, "send the catalog app's source as { source: { name, vendor_label, mapping, feed } }");
      return refuse(() => feeds.importCatalogAppSource(c, sc(co, a), feedEnv(), { vendorId: uuid(b.vendorId), vendorName: str(b.vendorName, 200) || null, source: source! }));
    });
    coPost(`/catalog/vendors/${ID}/host-photos`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, EDIT, "hosting a vendor's photos");
      return refuse(() => feeds.hostPhotos(c, sc(co, a), m[2], { ...feedEnv(), imageFetch }));
    });

    // ---- vendor feed import: columns -> preview -> apply
    coPost("/catalog/import/columns", async (c, co, a, b) => {
      await requireRole(c, co, a, EDIT, "importing a vendor catalog");
      const csv = await refuse(async () => uploadCsv(b));
      need(csv.trim(), "choose a CSV or Excel (.xlsx) file first");
      const rows = await refuse(async () => cat.parseCsv(csv.slice(0, 200000)));
      need(rows.length >= 1, "the file is empty");
      const headers = rows[0].map((h) => h.trim()).filter(Boolean);
      const mapping = cat.automap(headers);
      return { headers, mapping, missing: cat.missingRequired(mapping), sample: rows.slice(1, 4), fields: cat.IMPORT_FIELDS };
    }, { maxBody: 12_000_000 });
    coPost("/catalog/import/preview", async (c, co, a, b) => {
      await requireRole(c, co, a, EDIT, "importing a vendor catalog");
      const v = uuid(b.vendorId); need(v, "pick the vendor this file is from");
      const mapping: Record<string, string> = {};
      for (const [k, val] of Object.entries((b.mapping ?? {}) as Record<string, unknown>)) if (typeof val === "string" && val) mapping[k] = val;
      const csv = await refuse(async () => uploadCsv(b));
      need(csv && csv.length <= 8_000_000, "the file is larger than 8 MB; split it");
      return refuse(() => cat.previewImport(c, sc(co, a), { vendorId: v!, csv, filename: str(b.filename, 200), mapping }));
    }, { maxBody: 12_000_000 });
    coPost(`/catalog/import/runs/${ID}/apply`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, EDIT, "importing a vendor catalog");
      return refuse(() => cat.applyImport(c, sc(co, a), m[2]));
    });
    coPost(`/catalog/import/runs/${ID}/abandon`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, EDIT, "importing a vendor catalog");
      const r = await q(c, `update catalog_import_run set status = 'abandoned' where id = $1 and entity_id = $2 and status = 'previewed' returning id`, [m[2], co.id]);
      need(r.length, "only a previewed import can be set aside");
      return { ok: true };
    });
  },
};
