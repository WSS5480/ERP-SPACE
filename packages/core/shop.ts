// The web store: storefront settings, what a shopper may see, the price of a
// configured product, where it can come from and when, and checkout.
//
// A web order is the same sales_order every channel writes (channel 'web').
// The store never trusts a price from the browser: every line is priced again
// here through the catalog's priceConfigured, so the sofa in navy velvet
// costs online exactly what it costs at the register. Stock is reserved
// through inventory.reserveOrder and the money posts through ar.postReceipt;
// this file writes no other module's tables except the order it creates.
//
// What a shopper sees is built field by field (pub* functions below). Cost,
// vendor, vendor codes and margin never leave this file on a public path.

import { q, one, type Client, type Scope } from "./db.ts";
import { priceConfigured, PricingError, type Choice } from "./pricing.ts";
import { reserveOrder, InventoryError } from "./inventory.ts";
import { postReceipt, ArError } from "./ar.ts";
import { PostingError } from "./posting.ts";
import * as tax from "./tax.ts";
import * as sectionals from "./configurator.ts";

export class ShopError extends Error {}

/** Errors a shopper or clerk can read as they are. */
export const SHOP_REFUSALS = [ShopError, PricingError, InventoryError, ArError, PostingError, sectionals.ConfigError];

const need = (cond: unknown, msg: string): void => { if (!cond) throw new ShopError(msg); };

// ------------------------------------------------------------------ sites --

export type Site = {
  id: string; entity_id: string; tenant_id: string; slug: string; display_name: string; tagline: string | null;
  brand_primary: string; brand_accent: string; logo_url: string | null;
  web_location_id: string; tax_location_id: string | null; pickup_location_ids: string[];
  delivery_fee_minor: string; free_delivery_over_minor: string | null; delivery_days: number;
  ship_fee_minor: string; ship_days: number; mto_base_days: number; backorder_days: number;
  fee_product_id: string | null; financing_url: string | null; policies: string | null;
  payment_provider: string; sms_provider: string; review_provider: string; status: string;
};

const SITE_COLS = `s.id, s.entity_id, e.tenant_id, s.slug, s.display_name, s.tagline, s.brand_primary, s.brand_accent, s.logo_url,
  s.web_location_id, s.tax_location_id, s.pickup_location_ids, s.delivery_fee_minor, s.free_delivery_over_minor,
  s.delivery_days, s.ship_fee_minor, s.ship_days, s.mto_base_days, s.backorder_days, s.fee_product_id,
  s.financing_url, s.policies, s.payment_provider, s.sms_provider, s.review_provider, s.status`;

export const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** A storefront by its public address. Only live ones unless asked. */
export async function siteBySlug(c: Client, slug: string, opts: { liveOnly?: boolean } = { liveOnly: true }): Promise<Site | null> {
  if (!SLUG.test(slug)) return null;
  const r = await q<Site>(c, `select ${SITE_COLS} from shop_site s join entity e on e.id = s.entity_id
     where s.slug = $1 and e.status = 'active'
     /* unscoped: a storefront is found by its public slug before its company is known */`, [slug]);
  const s = r[0];
  if (!s || (opts.liveOnly !== false && s.status !== "live")) return null;
  return s;
}

export async function sitesOf(c: Client, entityId: string): Promise<Site[]> {
  return q<Site>(c, `select ${SITE_COLS} from shop_site s join entity e on e.id = s.entity_id
     where s.entity_id = $1 order by s.display_name`, [entityId]);
}

type Loc = { id: string; name: string; kind: string; tax_rate_bps: number; address: Record<string, string> };
async function locationsOf(c: Client, entityId: string): Promise<Map<string, Loc>> {
  const r = await q<Loc>(c, `select id, name, kind, tax_rate_bps, address from location where entity_id = $1 and status = 'active'`, [entityId]);
  return new Map(r.map((l) => [l.id, l]));
}

const addrLine = (a: Record<string, string> | null) =>
  a && a.line1 ? `${a.line1}, ${a.city ?? ""}${a.state ? ", " + a.state : ""} ${a.postal ?? ""}`.trim() : "";

/** What the storefront page needs about the site. No ids of back-office things beyond pickup stores. */
export async function pubSite(c: Client, site: Site) {
  const locs = await locationsOf(c, site.entity_id);
  const cats = await q<{ category: string; n: string; from_minor: string }>(c, `
    select category, count(*) n, min(price_minor) from_minor from product
     where entity_id = $1 and web_visible and status = 'active' and kind not in ('fee','gift_card') and category is not null
     group by category order by count(*) desc, category`, [site.entity_id]);
  return {
    slug: site.slug, name: site.display_name, tagline: site.tagline, brandPrimary: site.brand_primary,
    brandAccent: site.brand_accent, logoUrl: site.logo_url, financingUrl: site.financing_url, policies: site.policies,
    deliveryFeeMinor: site.delivery_fee_minor, freeDeliveryOverMinor: site.free_delivery_over_minor,
    shipFeeMinor: site.ship_fee_minor, paymentMode: site.payment_provider,
    pickupStores: site.pickup_location_ids.map((id) => locs.get(id)).filter(Boolean)
      .map((l) => ({ id: l!.id, name: l!.name, address: addrLine(l!.address) })),
    categories: cats.map((x) => ({ name: x.category, count: Number(x.n), fromMinor: x.from_minor })),
  };
}

// ----------------------------------------------------------------- dates --

const DAYMS = 86_400_000;
const utcToday = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };
export function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(from.getTime());
  let left = n;
  while (left > 0) { d.setTime(d.getTime() + DAYMS); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left--; }
  return d;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const FMT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const nice = (d: Date) => FMT.format(d);

// ----------------------------------------------------------- availability --

export type Availability = {
  state: "in_stock" | "ships" | "made_to_order" | "backorder" | "service";
  lines: { kind: "pickup" | "delivery" | "parcel" | "made_to_order" | "backorder" | "service"; text: string; date?: string }[];
  pickupStoreIds: string[];
  deliverBy: string | null;     // ISO date, earliest delivery/shipping estimate
  leadWeeks: number | null;
};

type ProdLite = { id: string; kind: string; ship_class: string };

async function stockRows(c: Client, entityId: string, productId: string) {
  return q<{ location_id: string; location_kind: string; available: string }>(c,
    `select location_id, location_kind, available from product_availability where entity_id = $1 and product_id = $2`,
    [entityId, productId]);
}

/** Where a product can come from, and when -- for a shopper. leadDays is the configured options' longest lead time. */
export async function availabilityFor(c: Client, site: Site, p: ProdLite, leadDays = 0, locs?: Map<string, Loc>): Promise<Availability> {
  locs = locs ?? await locationsOf(c, site.entity_id);
  const today = utcToday();
  if (["service", "warranty", "fee", "gift_card"].includes(p.kind)) {
    return { state: "service", lines: [{ kind: "service", text: "Added to your order. Nothing to deliver." }], pickupStoreIds: [], deliverBy: null, leadWeeks: null };
  }
  if (p.kind === "configurable" || p.kind === "special_order") {
    const days = site.mto_base_days + leadDays;
    const weeks = Math.max(1, Math.ceil(days / 7));
    const by = addBusinessDays(new Date(today.getTime() + days * DAYMS), site.delivery_days);
    return { state: "made_to_order", leadWeeks: weeks, pickupStoreIds: [], deliverBy: iso(by),
      lines: [{ kind: "made_to_order", text: `Made to order — about ${weeks} weeks. Delivers by about ${nice(by)}.`, date: iso(by) }] };
  }
  const rows = await stockRows(c, site.entity_id, p.id);
  const pickup = rows.filter((r) => site.pickup_location_ids.includes(r.location_id) && Number(r.available) >= 1)
    .map((r) => r.location_id);
  const dc = rows.filter((r) => r.location_kind === "warehouse").reduce((a, r) => a + Math.max(0, Number(r.available)), 0);
  const lines: Availability["lines"] = [];
  let deliverBy: Date | null = null;
  if (pickup.length) {
    const names = pickup.map((id) => locs!.get(id)?.name ?? "a store");
    lines.push({ kind: "pickup", text: `In stock at ${names.join(", ")} for pickup.` });
  }
  if (dc > 0) {
    if (p.ship_class === "parcel" || p.ship_class === "carry") {
      deliverBy = addBusinessDays(today, site.ship_days);
      lines.push({ kind: "parcel", text: `Ships by parcel — arrives by ${nice(deliverBy)}.`, date: iso(deliverBy) });
    }
    if (p.ship_class !== "parcel") {
      const d = addBusinessDays(today, site.delivery_days);
      deliverBy = deliverBy && deliverBy < d ? deliverBy : d;
      lines.push({ kind: "delivery", text: `Ships from our distribution center — delivers by ${nice(d)}.`, date: iso(d) });
    }
  }
  if (!pickup.length && dc <= 0) {
    const by = addBusinessDays(new Date(today.getTime() + site.backorder_days * DAYMS), site.delivery_days);
    const weeks = Math.max(1, Math.ceil(site.backorder_days / 7));
    return { state: "backorder", leadWeeks: weeks, pickupStoreIds: [], deliverBy: iso(by),
      lines: [{ kind: "backorder", text: `On order — about ${weeks} weeks. Delivers by about ${nice(by)}.`, date: iso(by) }] };
  }
  return { state: pickup.length ? "in_stock" : "ships", lines, pickupStoreIds: pickup, deliverBy: deliverBy ? iso(deliverBy) : null, leadWeeks: null };
}

// ---------------------------------------------------------- the catalog --

type ProdRow = {
  id: string; sku: string; name: string; kind: string; brand: string | null; category: string | null; subcategory: string | null;
  collection: string | null; color: string | null; description: string | null; price_minor: string; ship_class: string;
  web_visible: boolean; status: string; created_at: string; dc_avail?: string; pickup_avail?: string;
};

const PUB_COLS = `p.id, p.sku, p.name, p.kind, p.brand, p.category, p.subcategory, p.collection, p.color, p.description,
  p.price_minor, p.ship_class, p.web_visible, p.status, p.created_at`;

/** A product row as a shopper may see it. Built field by field: nothing else leaks. */
function pubCard(p: ProdRow) {
  const dc = Number(p.dc_avail ?? 0), pk = Number(p.pickup_avail ?? 0);
  const stock = p.kind === "configurable" || p.kind === "special_order" ? "made_to_order"
    : ["service", "warranty"].includes(p.kind) ? "service" : pk > 0 ? "in_stock" : dc > 0 ? "ships" : "backorder";
  return {
    id: p.id, sku: p.sku, name: p.name, kind: p.kind, brand: p.brand, category: p.category, subcategory: p.subcategory,
    collection: p.collection, color: p.color, priceMinor: p.price_minor, shipClass: p.ship_class,
    configurable: p.kind === "configurable", stock,
  };
}

export type ListQuery = { category?: string; brand?: string; color?: string; minMinor?: bigint | null; maxMinor?: bigint | null; sort?: string; q?: string };

export async function pubProducts(c: Client, site: Site, f: ListQuery) {
  const where = [`p.entity_id = $1`, `p.web_visible`, `p.status = 'active'`, `p.kind not in ('fee','gift_card')`];
  const args: unknown[] = [site.entity_id, site.pickup_location_ids];
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replaceAll("?", `$${args.length}`)); };
  if (f.category) add(`p.category = ?`, f.category);
  if (f.brand) add(`p.brand = ?`, f.brand);
  if (f.color) add(`p.color = ?`, f.color);
  if (f.minMinor != null) add(`p.price_minor >= ?`, f.minMinor.toString());
  if (f.maxMinor != null) add(`p.price_minor <= ?`, f.maxMinor.toString());
  if (f.q) add(`(p.name ilike ? or p.brand ilike ? or p.collection ilike ? or p.category ilike ?)`, `%${f.q.replace(/[%_\\]/g, "")}%`);
  const order = f.sort === "price_asc" ? "p.price_minor asc, p.name" : f.sort === "price_desc" ? "p.price_minor desc, p.name"
    : f.sort === "newest" ? "p.created_at desc, p.name" : f.sort === "name" ? "p.name" : "pickup_avail desc, dc_avail desc, p.name";
  const rows = await q<ProdRow>(c, `
    select ${PUB_COLS},
      (select coalesce(sum(greatest(a.available,0)),0) from product_availability a
        where a.entity_id = p.entity_id and a.product_id = p.id and a.location_kind = 'warehouse') dc_avail,
      (select coalesce(sum(greatest(a.available,0)),0) from product_availability a
        where a.entity_id = p.entity_id and a.product_id = p.id and a.location_id = any($2::uuid[])) pickup_avail
      from product p where ${where.join(" and ")} order by ${order} limit 200`, args);
  // Facets come from the category (not the other filters), so a shopper can widen as well as narrow.
  const facetArgs: unknown[] = [site.entity_id];
  let facetWhere = `entity_id = $1 and web_visible and status = 'active' and kind not in ('fee','gift_card')`;
  if (f.category) { facetArgs.push(f.category); facetWhere += ` and category = $2`; }
  const fx = await one<{ brands: string[] | null; colors: string[] | null; lo: string | null; hi: string | null }>(c, `
    select array_agg(distinct brand) filter (where brand is not null) brands,
           array_agg(distinct color) filter (where color is not null) colors,
           min(price_minor)::text lo, max(price_minor)::text hi
      from product where ${facetWhere}`, facetArgs);
  return {
    products: rows.map(pubCard),
    facets: { brands: (fx.brands ?? []).sort(), colors: (fx.colors ?? []).sort(), minMinor: fx.lo ?? "0", maxMinor: fx.hi ?? "0" },
  };
}

/** The product as a web shopper may buy it, or null if it is not for sale online. */
async function webProduct(c: Client, entityId: string, productId: string): Promise<ProdRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(productId)) return null;
  const r = await q<ProdRow>(c, `select ${PUB_COLS} from product p where p.id = $1 and p.entity_id = $2`, [productId, entityId]);
  const p = r[0];
  if (!p || !p.web_visible || p.status !== "active" || ["fee", "gift_card"].includes(p.kind)) return null;
  return p;
}

export async function pubProduct(c: Client, site: Site, productId: string) {
  const p = await webProduct(c, site.entity_id, productId);
  if (!p) return null;
  const family = await sectionals.familyView(c, site.entity_id, p.id, true);
  const groups = family ? [] : await q<{ id: string; code: string; label: string; required: boolean; multi: boolean }>(c,
    `select id, code, label, required, multi from product_option_group where entity_id = $1 and product_id = $2 order by seq, label`,
    [site.entity_id, p.id]);
  const opts = await q<{ group_id: string; code: string; label: string; price_delta_minor: string; lead_days: number; swatch: string | null }>(c,
    `select o.group_id, o.code, o.label, o.price_delta_minor, o.lead_days, o.swatch from product_option o
      where o.entity_id = $1 and o.active and o.group_id = any($2::uuid[]) order by o.seq, o.label`,
    [site.entity_id, groups.map((g) => g.id)]);
  const locs = await locationsOf(c, site.entity_id);
  // The default configuration: the first option of every required group.
  const defaults: Choice[] = groups.filter((g) => g.required).map((g) => ({ group: g.code, option: opts.find((o) => o.group_id === g.id)?.code ?? "" }));
  const lead = Math.max(0, ...groups.filter((g) => g.required).map((g) => opts.find((o) => o.group_id === g.id)?.lead_days ?? 0));
  const avail = await availabilityFor(c, site, p, lead, locs);
  return {
    ...pubCard({ ...p, dc_avail: "0", pickup_avail: "0" }),
    stock: avail.state,
    description: p.description,
    options: groups.map((g) => ({
      code: g.code, label: g.label, required: g.required, multi: g.multi,
      options: opts.filter((o) => o.group_id === g.id).map((o) => ({
        code: o.code, label: o.label, priceDeltaMinor: o.price_delta_minor, leadDays: o.lead_days,
        swatch: o.swatch && /^#[0-9a-fA-F]{6}$/.test(o.swatch) ? o.swatch : null,
      })),
    })),
    defaults,
    availability: avail,
    package: await packageInfo(c, site.entity_id, p.id),
    financingUrl: site.financing_url,
    sectional: family,
  };
}

/** A sectional build parsed from a request: codes only; priceBuild checks they exist. */
export function parseBuild(v: unknown): sectionals.Build | null {
  if (v == null) return null;
  need(typeof v === "object" && !Array.isArray(v), "The sectional sent is not in a form the store understands.");
  const b = v as Record<string, unknown>;
  const code = (x: unknown) => { need(x == null || x === "" || (typeof x === "string" && CODE.test(x)), "A sectional piece or cover is not valid."); return typeof x === "string" && x ? x : null; };
  need(b.pieces == null || (Array.isArray(b.pieces) && b.pieces.length <= 12), "A sectional has twelve pieces at most.");
  need(b.pieceOptions == null || (Array.isArray(b.pieceOptions) && b.pieceOptions.length <= 12), "The sectional's options are not in a form the store understands.");
  return { layout: code(b.layout), cover: code(b.cover), pieces: ((b.pieces as unknown[]) ?? []).map((x) => code(x)).filter((x): x is string => !!x),
    pieceOptions: ((b.pieceOptions as unknown[]) ?? []).map((o) => parseChoices(o ?? [])) };
}

/** A sectional's price for a shopper: the pieces, the cover, the plan. No cost, no vendor codes. */
export async function pubSectionalPrice(c: Client, site: Site, productId: string, build: sectionals.Build | null, priceList: string | null = null) {
  const p = await webProduct(c, site.entity_id, productId);
  need(p, "That product is not available online.");
  need(build, "Choose a layout or the pieces.");
  const priced = await sectionals.priceBuild(c, site.entity_id, p!.id, build!, { priceList });
  const avail = await availabilityFor(c, site, { ...p!, kind: priced.special ? "configurable" : "stock" } as ProdRow, priced.leadDays);
  return { ...sectionals.pricedView(priced, true), availability: avail };
}

// --------------------------------------------------------------- choices --

const CODE = /^[A-Za-z0-9._-]{1,60}$/;
/** Choices from a request, checked for shape. priceConfigured checks they exist. */
export function parseChoices(v: unknown): Choice[] {
  if (v == null) return [];
  need(Array.isArray(v) && v.length <= 12, "the options sent are not in a form the store understands");
  return (v as unknown[]).map((x) => {
    const o = x as { group?: unknown; option?: unknown };
    need(o && typeof o.group === "string" && CODE.test(o.group), "an option group is not valid");
    const opt = Array.isArray(o.option) ? o.option : [o.option];
    need(opt.length >= 1 && opt.length <= 12 && opt.every((s) => typeof s === "string" && CODE.test(s)), "an option is not valid");
    return { group: o.group as string, option: Array.isArray(o.option) ? (opt as string[]) : (opt[0] as string) };
  });
}

/** The configured price and lead time, for a shopper: no cost, no vendor codes. */
export async function pubPrice(c: Client, site: Site, productId: string, choices: Choice[]) {
  const p = await webProduct(c, site.entity_id, productId);
  need(p, "That product is not available online.");
  const priced = await priceConfigured(c, site.entity_id, p!.id, choices);
  const avail = await availabilityFor(c, site, p!, priced.leadDays);
  return {
    productId: priced.productId, unitPriceMinor: priced.unitPriceMinor.toString(), description: priced.description,
    leadDays: priced.leadDays, availability: avail,
    config: Object.fromEntries(Object.entries(priced.config).map(([g, list]) =>
      [g, list.map((o) => ({ code: o.code, label: o.label, deltaMinor: o.deltaMinor }))])),
  };
}

// --------------------------------------------------------------- packages --
// Package (kit) pricing belongs to the catalog module. If its tables exist,
// the store shows "includes" and "part of a set"; if not, nothing breaks.

type PkgShape = { comp: string; parentCol: string; childCol: string; qtyCol: string | null; header?: { table: string; productCol: string } };
let pkgCache: { at: number; shape: PkgShape | null } | null = null;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export async function packageShape(c: Client, fresh = false): Promise<PkgShape | null> {
  if (!fresh && pkgCache && Date.now() - pkgCache.at < 60_000) return pkgCache.shape;
  let shape: PkgShape | null = null;
  try {
    const cols = await q<{ table_name: string; column_name: string }>(c, `
      select table_name, column_name from information_schema.columns
       where table_schema = current_schema() and (table_name like '%package%' or table_name like '%kit%')
       /* unscoped: schema metadata, no business rows */`);
    const t = new Map<string, Set<string>>();
    for (const r of cols) { if (!t.has(r.table_name)) t.set(r.table_name, new Set()); t.get(r.table_name)!.add(r.column_name); }
    const pick = (s: Set<string>, names: string[]) => names.find((n) => s.has(n)) ?? null;
    for (const [name, s] of t) {
      if (!IDENT.test(name) || !s.has("entity_id")) continue;
      const child = pick(s, ["component_product_id", "component_id", "item_product_id"]) ?? (s.has("product_id") && pick(s, ["package_id", "kit_id"]) ? "product_id" : null);
      const qty = pick(s, ["qty", "quantity"]);
      const direct = pick(s, ["package_product_id", "parent_product_id", "kit_product_id"]);
      if (child && direct) { shape = { comp: name, parentCol: direct, childCol: child, qtyCol: qty }; break; }
      const via = pick(s, ["package_id", "kit_id"]);
      if (child && via) {
        for (const [hname, hs] of t) {
          if (hname === name || !IDENT.test(hname) || !hs.has("id") || !hs.has("entity_id")) continue;
          const pc = pick(hs, ["product_id", "package_product_id", "kit_product_id"]);
          if (pc && (via.startsWith("package") ? hname.includes("package") : hname.includes("kit"))) {
            shape = { comp: name, parentCol: via, childCol: child, qtyCol: qty, header: { table: hname, productCol: pc } };
            break;
          }
        }
        if (shape) break;
      }
    }
  } catch { shape = null; }
  pkgCache = { at: Date.now(), shape };
  return shape;
}

/** "Includes" (for a package) or "part of" (for a piece), with what the set saves. Null when there is nothing to say. */
export async function packageInfo(c: Client, entityId: string, productId: string) {
  const s = await packageShape(c);
  if (!s) return null;
  try {
    await c.query("savepoint shop_pkg");
    const qty = s.qtyCol ? `coalesce(k."${s.qtyCol}",1)` : "1";
    // parent product id expressed for each component row
    const parentExpr = s.header ? `h."${s.header.productCol}"` : `k."${s.parentCol}"`;
    const join = s.header ? `join "${s.header.table}" h on h.id = k."${s.parentCol}" and h.entity_id = k.entity_id` : "";
    const rows = await q<{ parent_id: string; child_id: string; qty: string }>(c, `
      select ${parentExpr} parent_id, k."${s.childCol}" child_id, ${qty}::numeric qty
        from "${s.comp}" k ${join}
       where k.entity_id = $1 and (${parentExpr} = $2 or k."${s.childCol}" = $2)`, [entityId, productId]);
    await c.query("release savepoint shop_pkg");
    if (!rows.length) return null;
    const ids = [...new Set(rows.flatMap((r) => [r.parent_id, r.child_id]))];
    const prods = new Map((await q<{ id: string; name: string; price_minor: string; web_visible: boolean; status: string }>(c,
      `select id, name, price_minor, web_visible, status from product where entity_id = $1 and id = any($2::uuid[])`, [entityId, ids]))
      .map((p) => [p.id, p]));
    const setOf = async (parentId: string) => {
      const parts = (await q<{ child_id: string; qty: string }>(c, `
        select k."${s.childCol}" child_id, ${qty}::numeric qty from "${s.comp}" k ${join}
         where k.entity_id = $1 and ${parentExpr} = $2`, [entityId, parentId]));
      const pp = new Map((await q<{ id: string; name: string; price_minor: string }>(c,
        `select id, name, price_minor from product where entity_id = $1 and id = any($2::uuid[])`, [entityId, parts.map((x) => x.child_id)])).map((p) => [p.id, p]));
      const separate = parts.reduce((a, x) => a + BigInt(Math.round(Number(x.qty) * Number(pp.get(x.child_id)?.price_minor ?? 0))), 0n);
      return { parts: parts.map((x) => ({ productId: x.child_id, name: pp.get(x.child_id)?.name ?? "", qty: Number(x.qty) })), separate };
    };
    if (rows.some((r) => r.parent_id === productId)) {
      const me = prods.get(productId)!;
      const { parts, separate } = await setOf(productId);
      const price = BigInt(me.price_minor);
      return { kind: "package" as const, includes: parts, separateMinor: separate.toString(),
        packageMinor: price.toString(), saveMinor: (separate > price ? separate - price : 0n).toString() };
    }
    const parents = [...new Set(rows.filter((r) => r.child_id === productId).map((r) => r.parent_id))]
      .map((id) => prods.get(id)).filter((p) => p && p.web_visible && p.status === "active");
    if (!parents.length) return null;
    const partOf = [];
    for (const p of parents.slice(0, 4)) {
      const { separate } = await setOf(p!.id);
      const price = BigInt(p!.price_minor);
      partOf.push({ productId: p!.id, name: p!.name, packageMinor: price.toString(), saveMinor: (separate > price ? separate - price : 0n).toString() });
    }
    return { kind: "piece" as const, partOf };
  } catch {
    await c.query("rollback to savepoint shop_pkg").catch(() => undefined);
    return null;
  }
}

// ------------------------------------------------------------ cart lines --

export type LineIn = { productId: string; choices: Choice[]; qty: number; sectional?: sectionals.Build | null };

export function parseLines(v: unknown, max = 30): LineIn[] {
  need(Array.isArray(v), "The cart is not in a form the store understands.");
  const arr = v as unknown[];
  need(arr.length <= max, `A cart holds at most ${max} lines.`);
  return arr.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    need(typeof o.productId === "string" && /^[0-9a-f-]{36}$/i.test(o.productId), "A cart line names no product.");
    const qty = Number(o.qty ?? 1);
    need(Number.isInteger(qty) && qty >= 1 && qty <= 20, "Quantities run from 1 to 20.");
    const sectional = parseBuild(o.sectional);
    need(!sectional || qty === 1, "A sectional is bought one at a time.");
    return { productId: o.productId as string, choices: parseChoices(o.choices), qty, sectional };
  });
}

type Priced = {
  productId: string; sku: string; name: string; description: string; kind: string; shipClass: string; taxable: boolean;
  qty: number; unitPriceMinor: bigint; leadDays: number; config: Record<string, unknown>; choices: Choice[];
  availability: Availability;
  /** a sectional: the build as sent, how it priced, and one priced line per piece */
  sectional?: sectionals.Build | null; built?: sectionals.Priced; parts?: Priced[]; setIndex?: number; special?: boolean;
};

/** Price every line again on the server. A line that cannot be sold online is refused, with its reason. A trade order prices by its account's list. */
async function priceLines(c: Client, site: Site, lines: LineIn[], locs: Map<string, Loc>, priceList: string | null = null): Promise<Priced[]> {
  const out: Priced[] = [];
  for (const l of lines) {
    const p = await webProduct(c, site.entity_id, l.productId);
    need(p, "Something in the cart is no longer sold online. Remove it and try again.");
    if (await sectionals.isFamily(c, site.entity_id, p!.id)) {
      need(l.sectional, `Choose the pieces of the ${p!.name}.`);
      const built = await sectionals.priceBuild(c, site.entity_id, p!.id, l.sectional!, { priceList });
      const availability = await availabilityFor(c, site, { ...p!, kind: built.special ? "configurable" : "stock" } as ProdRow, built.leadDays, locs);
      const setIndex = out.length;
      out.push({
        productId: p!.id, sku: p!.sku, name: p!.name, description: built.description, kind: p!.kind, shipClass: p!.ship_class, taxable: true, qty: 1,
        unitPriceMinor: built.totalMinor, leadDays: built.leadDays, config: { sectional: { layout: built.layoutName, cover: built.cover?.name ?? null, pieces: built.parts.length } },
        choices: [], availability, sectional: l.sectional, built, setIndex,
        parts: built.parts.map((x) => ({ productId: x.productId, sku: x.sku, name: x.name, description: x.description, kind: x.special ? "special_order" : "stock",
          shipClass: x.shipClass, taxable: x.taxable, qty: 1, unitPriceMinor: x.netMinor, leadDays: x.leadDays, config: x.config, choices: [], availability,
          setIndex, special: x.special })),
      });
      continue;
    }
    const pr = await priceConfigured(c, site.entity_id, p!.id, l.choices, { priceList });
    const tx = await one<{ taxable: boolean }>(c, `select taxable from product where id = $1 and entity_id = $2`, [p!.id, site.entity_id]);
    out.push({
      productId: p!.id, sku: pr.sku, name: p!.name, description: pr.description, kind: p!.kind, shipClass: p!.ship_class,
      taxable: tx.taxable, qty: l.qty, unitPriceMinor: pr.unitPriceMinor, leadDays: pr.leadDays, config: pr.config, choices: l.choices,
      availability: await availabilityFor(c, site, p!, pr.leadDays, locs),
    });
  }
  return out;
}

/** Furniture a protection plan can cover: stocked or made-to-order pieces that are delivered. */
const coverable = (p: { kind: string; shipClass: string }) => ["stock", "configurable", "special_order"].includes(p.kind) && p.shipClass === "delivery";
export const WARRANTY_ALONE = "A protection plan is sold with the furniture it covers. Add the furniture, or remove the plan (one plan per piece).";
/** Protection plans only ride along with furniture in the same cart, no more plans than pieces. */
function warrantyCovered(lines: { kind: string; shipClass: string; qty: number }[]): void {
  const plans = lines.filter((l) => l.kind === "warranty").reduce((a, l) => a + l.qty, 0);
  const pieces = lines.filter(coverable).reduce((a, l) => a + l.qty, 0);
  need(plans <= pieces, WARRANTY_ALONE);
}

const pubLine = (p: Priced) => ({
  productId: p.productId, sku: p.sku, name: p.name, description: p.description, kind: p.kind, shipClass: p.shipClass,
  qty: p.qty, unitPriceMinor: p.unitPriceMinor.toString(), lineMinor: (p.unitPriceMinor * BigInt(p.qty)).toString(),
  choices: p.choices, availability: p.availability,
  ...(p.built ? { sectional: p.sectional, plan: { layout: p.built.layoutName, cover: p.built.cover?.name ?? null, widthIn: p.built.geometry.widthIn,
    depthIn: p.built.geometry.depthIn, seats: p.built.geometry.seats, pieces: p.built.parts.map((x) => ({ name: x.name, netMinor: x.netMinor.toString() })) } } : {}),
});

const CART_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EMAIL = /^[^@\s<>"]{1,64}@[^@\s<>"]{1,180}\.[^@\s<>".]{2,24}$/;

/** Save the shopper's cart (for abandoned-cart follow-up) and hand it back priced by the server. */
export async function saveCart(c: Client, site: Site, cartId: string, rawLines: unknown, email?: unknown) {
  need(CART_ID.test(cartId), "That cart id is not valid.");
  const lines = parseLines(rawLines);
  const locs = await locationsOf(c, site.entity_id);
  const out: ReturnType<typeof pubLine>[] = [];
  const problems: { productId: string; error: string }[] = [];
  for (const l of lines) {
    try {
      await c.query("savepoint cart_line");
      const [p] = await priceLines(c, site, [l], locs);
      await c.query("release savepoint cart_line");
      out.push(pubLine(p));
    } catch (e) {
      await c.query("rollback to savepoint cart_line");
      if (!SHOP_REFUSALS.some((K) => e instanceof K)) throw e;
      problems.push({ productId: l.productId, error: (e as Error).message });
    }
  }
  // Plans beyond the furniture they cover come back as a problem, so checkout cannot be reached with them.
  let room = out.filter(coverable).reduce((a, l) => a + l.qty, 0);
  for (let i = 0; i < out.length; i++) {
    if (out[i].kind !== "warranty") continue;
    if (out[i].qty <= room) { room -= out[i].qty; continue; }
    problems.push({ productId: out[i].productId, error: WARRANTY_ALONE });
    out.splice(i--, 1);
  }
  const sub = out.reduce((a, l) => a + BigInt(l.lineMinor), 0n);
  const em = typeof email === "string" && EMAIL.test(email.trim()) ? email.trim().toLowerCase() : null;
  const existing = await q<{ sales_order_id: string | null }>(c,
    `select sales_order_id from shop_cart where site_id = $1 and id = $2 and entity_id = $3`, [site.id, cartId, site.entity_id]);
  if (!existing[0]?.sales_order_id) {
    await c.query(`
      insert into shop_cart (site_id, id, entity_id, email, lines, item_count, subtotal_minor)
      values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (site_id, id) do update set
        email = coalesce(excluded.email, shop_cart.email), lines = excluded.lines, item_count = excluded.item_count,
        subtotal_minor = excluded.subtotal_minor, updated_at = now()
      where shop_cart.sales_order_id is null`,
      [site.id, cartId, site.entity_id, em, JSON.stringify(out.map((l) => ({ productId: l.productId, sku: l.sku, name: l.name,
        qty: l.qty, unitPriceMinor: l.unitPriceMinor, choices: l.choices, ...("sectional" in l ? { sectional: l.sectional } : {}) }))), out.reduce((a, l) => a + l.qty, 0), sub.toString()]);
  }
  return { cartId, lines: out, problems, subtotalMinor: sub.toString(), converted: !!existing[0]?.sales_order_id };
}

// --------------------------------------------------------------- checkout --

export type Address = { line1: string; line2: string | null; city: string; state: string; postal: string };
export type CheckoutIn = {
  cartId: string; email: string; name: string; phone: string | null; marketingOk: boolean;
  fulfillment: "pickup" | "delivery" | "ship"; pickupLocationId: string | null; address: Address | null;
  lines: LineIn[]; paymentToken: string; notes: string | null;
  couponCode?: string | null;   // checked and redeemed through crm.checkCoupon / crm.redeemCoupon
  /** A trade portal order (trade module): the account's customer, its price list, a resale certificate, and on account or by card. */
  trade?: TradeCheckout | null;
};
export type TradeCheckout = {
  customerId: string; priceList: string | null; resaleCert: string | null; onAccount: boolean;
  shipLabel: string | null; reference: string | null;
};

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

function luhn(d: string): boolean {
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * A card number pasted into a free-text field: 13 to 19 digits (spaces or
 * dashes allowed between them), starting 3, 4, 5 or 6, and Luhn-valid. Only
 * free text is looked at -- never emails, phones, ids or option codes, where
 * a long digit run is something else (a timestamp in an email, a SKU).
 */
export function looksLikeCard(text: string): boolean {
  for (const m of text.match(/(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])/g) ?? []) {
    const d = m.replace(/[^0-9]/g, "");
    if (d.length >= 13 && d.length <= 19 && /^[3-6]/.test(d) && luhn(d)) return true;
  }
  return false;
}
/** The free-text fields of a checkout where a card number could be pasted. */
export function refuseCardNumbers(b: Record<string, unknown>): void {
  const a = (b.address ?? {}) as Record<string, unknown>;
  for (const v of [b.notes, b.name, a.line1, a.line2, a.city]) {
    need(!(typeof v === "string" && looksLikeCard(v)), "Card numbers are never sent to the store. Use the card form to pay.");
  }
}

export function parseCheckout(b: Record<string, unknown>, quoteOnly = false): CheckoutIn {
  refuseCardNumbers(b);
  const cartId = String(b.cartId ?? "");
  need(CART_ID.test(cartId), "That cart id is not valid.");
  const fulfillment = String(b.fulfillment ?? "");
  need(["pickup", "delivery", "ship"].includes(fulfillment), "Choose pickup, delivery or shipping.");
  const email = clean(b.email, 120).toLowerCase();
  const name = clean(b.name, 80);
  const phoneDigits = clean(b.phone, 30).replace(/[^0-9]/g, "");
  if (!quoteOnly) {
    need(EMAIL.test(email), "Enter a valid email address.");
    need(name.length >= 2, "Enter your name.");
    need(!phoneDigits || (phoneDigits.length >= 10 && phoneDigits.length <= 15), "Enter a phone number with area code, or leave it blank.");
  }
  let address: Address | null = null;
  if (fulfillment !== "pickup") {
    const a = (b.address ?? {}) as Record<string, unknown>;
    address = { line1: clean(a.line1, 100), line2: clean(a.line2, 100) || null, city: clean(a.city, 60),
      state: clean(a.state, 2).toUpperCase(), postal: clean(a.postal, 10) };
    if (!quoteOnly || address.line1 || address.postal) {
      need(address.line1.length >= 3, "Enter the street address.");
      need(address.city.length >= 2, "Enter the city.");
      need(/^[A-Z]{2}$/.test(address.state), "Enter the two-letter state.");
      need(/^\d{5}(-\d{4})?$/.test(address.postal), "Enter a five-digit ZIP code.");
    }
  }
  const pickupLocationId = fulfillment === "pickup" ? String(b.pickupLocationId ?? "") : null;
  if (pickupLocationId !== null) need(/^[0-9a-f-]{36}$/i.test(pickupLocationId), "Choose a store to pick up from.");
  const token = String(b.paymentToken ?? "");
  if (!quoteOnly) need(/^[A-Za-z0-9_]{6,80}$/.test(token), "Choose a card to pay with.");
  return {
    cartId, email, name, phone: phoneDigits || null, marketingOk: b.marketingOk === true,
    fulfillment: fulfillment as CheckoutIn["fulfillment"], pickupLocationId, address,
    lines: parseLines(b.lines), paymentToken: token, notes: clean(b.notes, 300) || null,
    couponCode: clean(b.couponCode, 24).toUpperCase() || null,
  };
}

type Built = {
  lines: (Priced & { fulfilFromId: string; taxMinor: bigint; discountMinor: bigint; taxRows: tax.TaxRow[] })[];
  coupon: { code: string; label: string; discountMinor: bigint; merchandiseMinor: bigint } | null;
  fee: { minor: bigint; taxMinor: bigint; label: string; taxRows: tax.TaxRow[]; cls: tax.ItemClass } | null;
  place: tax.Place;
  orderLocationId: string; promisedOn: string | null;
  subtotalMinor: bigint; taxMinor: bigint; totalMinor: bigint; rateBps: number;
  sets: { setIndex: number; priced: sectionals.Priced }[];
};

/** The order a cart would make: lines priced, sources picked, tax and fees. Writes nothing. */
async function buildOrder(c: Client, site: Site, inp: CheckoutIn, write = false): Promise<Built> {
  need(inp.lines.length > 0, "The cart is empty.");
  const locs = await locationsOf(c, site.entity_id);
  if (inp.fulfillment === "pickup") need(inp.pickupLocationId && site.pickup_location_ids.includes(inp.pickupLocationId) && locs.has(inp.pickupLocationId),
    "Choose one of the store's pickup locations.");
  const priced = await priceLines(c, site, inp.lines, locs, inp.trade?.priceList ?? null);
  warrantyCovered(priced);
  // A resale order is exempt only under a current certificate of the account's own (tax.certificateFor refuses a void or expired one).
  let cert: tax.Cert | null = null;
  if (inp.trade?.resaleCert) {
    try { cert = await tax.certificateFor(c, site.entity_id, inp.trade.customerId, inp.trade.resaleCert); }
    catch (e) { if (e instanceof tax.TaxError) throw new ShopError(`${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}.`); throw e; }
    need(cert.reason === "resale", `Certificate ${cert.number} is not a resale certificate; a resale order needs one.`);
  }
  if (inp.fulfillment === "ship") {
    const bulky = priced.find((p) => !["parcel", "carry", "none"].includes(p.shipClass));
    need(!bulky, `${bulky?.name ?? "An item"} is too large to ship by parcel. Choose delivery or pickup.`);
  }

  const today = utcToday();
  const lines: Built["lines"] = [];
  let promised: Date | null = null;
  const later = (d: Date) => { if (!promised || d > promised) promised = d; };
  for (const p of priced.flatMap((x) => x.parts ?? [x])) {
    const rows = ["stock"].includes(p.kind) ? await stockRows(c, site.entity_id, p.productId) : [];
    const availAt = (id: string) => Number(rows.find((r) => r.location_id === id)?.available ?? 0);
    const warehouses = [...locs.values()].filter((l) => l.kind === "warehouse")
      .sort((a, b) => availAt(b.id) - availAt(a.id));
    const dc = warehouses[0]?.id ?? site.tax_location_id ?? site.web_location_id;
    let from: string;
    if (inp.fulfillment === "pickup") {
      const store = inp.pickupLocationId!;
      if (p.kind === "stock" && availAt(store) >= p.qty) { from = store; later(addBusinessDays(today, 1)); }
      else if (p.kind === "stock" && availAt(dc) >= p.qty) { from = dc; later(addBusinessDays(today, 3)); }
      else { from = p.kind === "stock" ? store : dc; if (p.availability.deliverBy) later(new Date(p.availability.deliverBy)); }
    } else {
      from = dc;
      if (p.kind === "stock" && availAt(dc) >= p.qty) later(addBusinessDays(today, inp.fulfillment === "ship" ? site.ship_days : site.delivery_days));
      else if (p.availability.deliverBy) later(new Date(p.availability.deliverBy));
    }
    lines.push({ ...p, fulfilFromId: from, taxMinor: 0n, discountMinor: 0n, taxRows: [] });
  }
  const orderLocationId = inp.fulfillment === "pickup" ? inp.pickupLocationId! : site.web_location_id;
  // Tax the way the register does: by the stack where the goods are handed over -- the pickup
  // store, or the delivery address (destination sourcing), else the site's tax location.
  const origin = inp.fulfillment === "pickup" ? inp.pickupLocationId! : (site.tax_location_id ?? lines[0]?.fulfilFromId ?? site.web_location_id);
  const place = await tax.stackForLine(c, site.entity_id, { storeId: origin, fulfillment: inp.fulfillment,
    shipTo: inp.address ? { state: inp.address.state, postal: inp.address.postal } : null, write });
  const rateBps = tax.goodsRate(place.stack);
  // A coupon (the CRM module's) comes off the merchandise, spread over the lines by value, before tax.
  let coupon: Built["coupon"] = null;
  const merch = lines.reduce((a, l) => a + l.unitPriceMinor * BigInt(l.qty), 0n);
  if (inp.couponCode) {
    const crm = await import("./crm.ts");
    try {
      const chk = await crm.checkCoupon(c, site.entity_id, inp.couponCode, { channel: "web", subtotalMinor: merch, email: inp.email || null });
      coupon = { code: chk.code, label: chk.label, discountMinor: chk.discountMinor, merchandiseMinor: merch };
    } catch (e) { if (e instanceof crm.CrmError) throw new ShopError(e.message); throw e; }
    let left = coupon.discountMinor;
    lines.forEach((l, i) => {
      const net = l.unitPriceMinor * BigInt(l.qty);
      const share = i === lines.length - 1 ? left : merch > 0n ? (coupon!.discountMinor * net) / merch : 0n;
      l.discountMinor = share > net ? net : share;
      left -= l.discountMinor;
    });
  }
  let sub = 0n, taxTotal = 0n;
  for (const l of lines) {
    const net = l.unitPriceMinor * BigInt(l.qty);
    const lt = tax.computeLine(place.stack, { netMinor: net - l.discountMinor, itemClass: tax.classOf(l.kind), taxable: l.taxable, cert });
    l.taxMinor = lt.taxMinor; l.taxRows = lt.rows;
    sub += net; taxTotal += l.taxMinor;
  }
  let fee: Built["fee"] = null;
  if (inp.fulfillment === "delivery") {
    const free = site.free_delivery_over_minor != null && sub >= BigInt(site.free_delivery_over_minor);
    const m = free ? 0n : BigInt(site.delivery_fee_minor);
    fee = { minor: m, taxMinor: 0n, label: free ? "Delivery and setup (free on this order)" : "Delivery and setup", taxRows: [], cls: "delivery" };
  } else if (inp.fulfillment === "ship") {
    fee = { minor: BigInt(site.ship_fee_minor), taxMinor: 0n, label: "Parcel shipping", taxRows: [], cls: "delivery" };
  }
  if (fee && fee.minor > 0n) {
    const fp = site.fee_product_id ? await q<{ taxable: boolean; kind: string }>(c, `select taxable, kind from product where id = $1 and entity_id = $2`, [site.fee_product_id, site.entity_id]) : [];
    fee.cls = tax.classOf(fp[0]?.kind ?? "fee");
    const ft = tax.computeLine(place.stack, { netMinor: fee.minor, itemClass: fee.cls, taxable: !!fp[0]?.taxable, cert });
    fee.taxMinor = ft.taxMinor; fee.taxRows = ft.rows;
  }
  taxTotal += fee?.taxMinor ?? 0n;
  sub += fee?.minor ?? 0n;
  const disc = coupon?.discountMinor ?? 0n;
  const sets = priced.filter((x) => x.built).map((x) => ({ setIndex: x.setIndex!, priced: x.built! }));
  return { lines, coupon, fee, place, orderLocationId, promisedOn: promised ? iso(promised) : null, subtotalMinor: sub, taxMinor: taxTotal, totalMinor: sub - disc + taxTotal, rateBps, sets };
}

/** Checkout preview: what the order will cost with this fulfillment, from the server's own prices. */
export async function quote(c: Client, site: Site, inp: CheckoutIn) {
  const b = await buildOrder(c, site, inp);
  return {
    lines: b.lines.map((l) => ({ ...pubLine(l), taxMinor: l.taxMinor.toString() })),
    fee: b.fee ? { label: b.fee.label, minor: b.fee.minor.toString() } : null,
    merchandiseMinor: b.lines.reduce((a, l) => a + l.unitPriceMinor * BigInt(l.qty), 0n).toString(),
    taxMinor: b.taxMinor.toString(), taxRateBps: b.rateBps, totalMinor: b.totalMinor.toString(), promisedOn: b.promisedOn,
    coupon: b.coupon ? { code: b.coupon.code, label: b.coupon.label, discountMinor: b.coupon.discountMinor.toString() } : null,
    /** a resale certificate exempted at least one jurisdiction here (it only does in its own state) */
    resaleExempt: b.lines.some((l) => l.taxRows.some((r) => r.exemptReason === "resale")),
  };
}

// ------------------------------------------------------------- payments --

export type AuthResult = { approved: true; authRef: string; brand: string; last4: string } | { approved: false; reason: string };
/** The card processor seam. A real provider tokenises in the browser; the server only ever sees its token. */
export interface PaymentProvider {
  name: string;
  authorize(a: { amountMinor: bigint; token: string; reference: string }): Promise<AuthResult>;
  capture(authRef: string, amountMinor: bigint): Promise<void>;
  void(authRef: string): Promise<void>;
  /** Give money back on a captured charge (a return); the processor's refund reference comes back. */
  refund(authRef: string, amountMinor: bigint): Promise<{ refundRef: string }>;
}

/** Approves test tokens like tok_test_visa_4242; tok_test_decline is declined. Nothing real is charged. */
export const TestProvider: PaymentProvider = {
  name: "test",
  async authorize({ token, amountMinor }) {
    if (amountMinor <= 0n) return { approved: false, reason: "There is nothing to charge." };
    if (token === "tok_test_decline") return { approved: false, reason: "The card was declined. Try another card." };
    const m = /^tok_test_(visa|mastercard|amex|discover)_(\d{4})$/.exec(token);
    if (!m) return { approved: false, reason: "That payment could not be read. Choose the card again." };
    return { approved: true, authRef: `test_auth_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      brand: m[1][0].toUpperCase() + m[1].slice(1), last4: m[2] };
  },
  async capture() { /* the test processor captures instantly */ },
  async void() { /* nothing was charged */ },
  async refund(_authRef, amountMinor) {
    if (amountMinor <= 0n) throw new ShopError("There is nothing to refund.");
    return { refundRef: `test_refund_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` };
  },
};

/** The processor a past payment went through, by the name recorded on it (POS refunds web orders this way). */
export const providerNamed = (name: string): PaymentProvider => {
  if (name === "test") return TestProvider;
  throw new ShopError(`The ${name} card processor is not set up here.`);
};

export const providerFor = (site: Site): PaymentProvider => {
  if (site.payment_provider === "test") return TestProvider;
  throw new ShopError("This store's card processor is not set up.");
};

// ------------------------------------------------- messages and reviews --

export type OutMessage = { entityId: string; siteId: string | null; orderId: string | null; customerId: string | null;
  channel: "sms" | "email"; toRef: string; template: string; body: string };
/** The texting/email seam. 'record' keeps the message on file and sends nothing. */
export interface MessageProvider { name: string; send(c: Client, m: OutMessage): Promise<"recorded" | "sent"> }
export const RecordOnlyMessages: MessageProvider = {
  name: "record",
  async send(c, m) {
    await c.query(`insert into shop_message (entity_id, site_id, sales_order_id, customer_id, channel, to_ref, template, body, provider, status)
                   values ($1,$2,$3,$4,$5,$6,$7,$8,'record','recorded')`,
      [m.entityId, m.siteId, m.orderId, m.customerId, m.channel, m.toRef, m.template, m.body.slice(0, 600)]);
    return "recorded";
  },
};
/** The review seam: ask a buyer to review what they bought. 'record' only files the request. */
export interface ReviewProvider { name: string; request(c: Client, r: { entityId: string; productId: string; orderId: string; customerId: string }): Promise<void> }
export const RecordOnlyReviews: ReviewProvider = {
  name: "record",
  async request(c, r) {
    await c.query(`insert into shop_review (entity_id, product_id, sales_order_id, customer_id, provider, status)
                   values ($1,$2,$3,$4,'record','requested') on conflict (sales_order_id, product_id) do nothing`,
      [r.entityId, r.productId, r.orderId, r.customerId]);
  },
};
export const maskPhone = (d: string) => `***-***-${d.slice(-4)}`;
export const maskEmail = (e: string) => { const [u, h] = e.split("@"); return `${u.slice(0, 1)}***@${h}`; };

// ------------------------------------------------------------ the order --

async function findOrCreateCustomer(c: Client, entityId: string, inp: CheckoutIn, homeLocationId: string): Promise<string> {
  const hit = await q<{ id: string }>(c, `select id from customer where entity_id = $1 and lower(email) = $2`, [entityId, inp.email]);
  if (hit[0]) return hit[0].id;
  const num = await one<{ n: string }>(c, `select next_doc_no($1, 'web_customer', 'W-') n /* unscoped: numbering function takes the entity */`, [entityId]);
  const r = await one<{ id: string }>(c, `
    insert into customer (entity_id, number, name, email, phone, home_location_id, marketing_ok)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [entityId, num.n, inp.name, inp.email, inp.phone, homeLocationId, inp.marketingOk]);
  return r.id;
}

export type Placed = { duplicate: boolean; order: Awaited<ReturnType<typeof orderView>> };

/**
 * Place a web order. One transaction: customer, order, lines, card, receipt,
 * ledger, reservation. The cart id is the order's external_ref and is locked
 * first, so a double submit returns the first order instead of a second one.
 */
export async function placeWebOrder(c: Client, site: Site, inp: CheckoutIn, scope: Scope,
  provider: PaymentProvider = providerFor(site), messages: MessageProvider = RecordOnlyMessages, reviews: ReviewProvider = RecordOnlyReviews): Promise<Placed> {
  need(scope.entityId === site.entity_id, "That store belongs to another company.");
  const trade = inp.trade ?? null;
  const channel = trade ? "b2b" : "web";
  await c.query(`select pg_advisory_xact_lock(hashtext($1)) /* unscoped: a lock keyed by company and cart */`, [`shop:${site.entity_id}:${inp.cartId}`]);
  const prior = await q<{ id: string }>(c,
    `select id from sales_order where entity_id = $1 and channel = $3 and external_ref = $2${trade ? " and customer_id = $4" : ""}`,
    trade ? [site.entity_id, inp.cartId, channel, trade.customerId] : [site.entity_id, inp.cartId, channel]);
  if (prior[0]) return { duplicate: true, order: (await orderView(c, site.entity_id, prior[0].id))! };

  const b = await buildOrder(c, site, inp, true);
  need(b.totalMinor > 0n, "There is nothing to pay for.");
  let customerId: string;
  if (trade) {
    const cu = await q<{ id: string }>(c, `select id from customer where id = $1 and entity_id = $2 and status <> 'inactive'`, [trade.customerId, site.entity_id]);
    need(cu.length, "That trade account cannot order right now.");
    customerId = trade.customerId;
    // On account: what is owed, plus what is on order and not yet billed, plus this order, must fit under the limit.
    if (trade.onAccount) {
      const { creditCheck } = await import("./ar.ts");
      // The customer row is the lock: two on-account orders at once queue here, so the second sees the first as on order.
      await c.query(`select id from customer where id = $1 and entity_id = $2 for update`, [customerId, site.entity_id]);
      const pending = await one<{ s: string }>(c, `
        select coalesce(sum(greatest(so.total_minor - so.paid_minor - coalesce((select sum(i.charged_minor) from customer_invoice i
                 where i.entity_id = so.entity_id and i.sales_order_id = so.id), 0), 0)), 0)::text s
          from sales_order so where so.entity_id = $1 and so.customer_id = $2 and so.status in ('open','fulfilling')`, [site.entity_id, customerId]);
      const chk = await creditCheck(c, site.entity_id, customerId, b.totalMinor + BigInt(pending.s), null);
      need(chk.ok, chk.ok ? "" : `This order can't go on account: ${chk.reason.replace(/; an owner or controller can approve it with a reason$/, "")}. Pay by card, or ask the store to raise the limit.`);
    }
  } else {
    customerId = await findOrCreateCustomer(c, site.entity_id, inp, inp.pickupLocationId ?? site.tax_location_id ?? site.web_location_id);
  }
  let addressId: string | null = null;
  if (inp.address) {
    const hasDefault = await q<{ id: string }>(c, `select id from customer_address where entity_id = $1 and customer_id = $2 and is_default`, [site.entity_id, customerId]);
    addressId = (await one<{ id: string }>(c, `
      insert into customer_address (entity_id, customer_id, label, line1, line2, city, state, postal, is_default)
      values ($1,$2,$9,$3,$4,$5,$6,$7,$8) returning id`,
      [site.entity_id, customerId, inp.address.line1, inp.address.line2, inp.address.city, inp.address.state, inp.address.postal, !hasDefault.length,
       (trade?.shipLabel || "Web order").slice(0, 60)])).id;
  }
  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'order', 'SO-') n /* unscoped: numbering function takes the entity */`, [site.entity_id])).n;
  const order = await one<{ id: string }>(c, `
    insert into sales_order (entity_id, number, channel, location_id, customer_id, status, fulfillment, ship_address_id,
                             promised_on, external_ref, notes)
    values ($1,$2,$10,$3,$4,'open',$5,$6,$7,$8,$9) returning id`,
    [site.entity_id, number, b.orderLocationId, customerId, inp.fulfillment, addressId, b.promisedOn, inp.cartId,
     [trade ? `Trade order${trade.reference ? ` (${trade.reference})` : ""}${trade.resaleCert ? `, for resale under certificate ${trade.resaleCert}` : ""}${trade.onAccount ? ", on account" : ""}`
       : `Web order from ${site.display_name}`, inp.notes].filter(Boolean).join(". "), channel]);
  let seq = 1;
  const setLines = new Map<number, string[]>();
  for (const l of b.lines) {
    const row = await one<{ id: string }>(c, `
      insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, tax_minor, config, fulfil_from_id, discount_minor)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [site.entity_id, order.id, seq++, l.productId, l.sku, l.description, l.qty, l.unitPriceMinor.toString(), l.taxMinor.toString(),
       JSON.stringify(l.config), l.fulfilFromId, l.discountMinor.toString()]);
    await tax.writeLineTax(c, site.entity_id, order.id, row.id, l.taxRows, b.place, tax.classOf(l.kind));
    if (l.setIndex != null) {
      setLines.set(l.setIndex, [...(setLines.get(l.setIndex) ?? []), row.id]);
      // a piece in a cover that is not stocked is made for the customer
      if (l.special) await c.query(`update sales_order_line set line_status = 'on_order' where id = $1 and entity_id = $2`, [row.id, site.entity_id]);
    }
  }
  for (const st of b.sets) await sectionals.recordSet(c, site.entity_id, { orderId: order.id, priced: st.priced, lineIds: setLines.get(st.setIndex) ?? [], channel: "web" });
  if (b.fee && b.fee.minor > 0n) {
    const fp = site.fee_product_id ? await q<{ sku: string }>(c, `select sku from product where id = $1 and entity_id = $2`, [site.fee_product_id, site.entity_id]) : [];
    const row = await one<{ id: string }>(c, `
      insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, tax_minor, fulfil_from_id)
      values ($1,$2,$3,$4,$5,$6,1,$7,$8,$9) returning id`,
      [site.entity_id, order.id, seq++, fp[0] ? site.fee_product_id : null, fp[0]?.sku ?? "WEB-FEE", b.fee.label,
       b.fee.minor.toString(), b.fee.taxMinor.toString(), b.orderLocationId]);
    await tax.writeLineTax(c, site.entity_id, order.id, row.id, b.fee.taxRows, b.place, b.fee.cls);
  }
  await c.query(`select sales_order_retotal($1) /* unscoped: the order id was just created for this entity */`, [order.id]);
  const tot = await one<{ total_minor: string }>(c, `select total_minor from sales_order where id = $1 and entity_id = $2`, [order.id, site.entity_id]);
  need(BigInt(tot.total_minor) === b.totalMinor, "The order total did not add up; nothing was charged.");
  // The coupon is counted against this order before the card is touched; a code used up meanwhile stops the order here.
  if (b.coupon) {
    const crm = await import("./crm.ts");
    try { await crm.redeemCoupon(c, site.entity_id, null, { code: b.coupon.code, orderId: order.id, channel: "web", discountMinor: b.coupon.discountMinor, subtotalMinor: b.coupon.merchandiseMinor }); }
    catch (e) { if (e instanceof crm.CrmError) throw new ShopError(e.message); throw e; }
  }

  // Stock first: if reserving fails, the card is never touched.
  await reserveOrder(c, site.entity_id, order.id);

  // On account: no card; the account is billed (net terms) when the goods are handed over.
  if (!trade?.onAccount) {
  const auth = await provider.authorize({ amountMinor: b.totalMinor, token: inp.paymentToken, reference: number });
  if (!auth.approved) throw new ShopError(auth.reason);
  try {
    await provider.capture(auth.authRef, b.totalMinor);
    const rno = (await one<{ n: string }>(c, `select next_doc_no($1, 'receipt', 'R-') n /* unscoped: numbering function takes the entity */`, [site.entity_id])).n;
    const rec = await one<{ id: string }>(c, `
      insert into customer_receipt (entity_id, number, customer_id, sales_order_id, location_id, channel, method, amount_minor, reference)
      values ($1,$2,$3,$4,$5,'web','card',$6,$7) returning id`,
      [site.entity_id, rno, customerId, order.id, b.orderLocationId, b.totalMinor.toString(), `${auth.brand} ending ${auth.last4}, ${provider.name} ${auth.authRef}`]);
    await c.query(`
      insert into shop_payment (entity_id, site_id, sales_order_id, receipt_id, provider, token_ref, brand, last4, auth_ref, amount_minor, status)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'captured')`,
      [site.entity_id, site.id, order.id, rec.id, provider.name, inp.paymentToken.slice(0, 80), auth.brand, auth.last4, auth.authRef, b.totalMinor.toString()]);
    await postReceipt(c, scope, rec.id);
  } catch (e) {
    await provider.void(auth.authRef).catch(() => undefined);
    throw e;
  }
  }

  await c.query(`
    insert into shop_cart (site_id, id, entity_id, email, lines, item_count, subtotal_minor, sales_order_id)
    values ($1,$2,$3,$4,'[]',0,0,$5)
    on conflict (site_id, id) do update set sales_order_id = excluded.sales_order_id, email = excluded.email, updated_at = now()`,
    [site.id, inp.cartId, site.entity_id, inp.email, order.id]);

  const track = trade ? `/trade/${site.slug}/` : `/shop/${site.slug}/#/status`;
  if (inp.phone) await messages.send(c, { entityId: site.entity_id, siteId: site.id, orderId: order.id, customerId, channel: "sms",
    toRef: maskPhone(inp.phone), template: "order_confirmed", body: `${site.display_name}: order ${number} is confirmed. Track it at ${track}` });
  await messages.send(c, { entityId: site.entity_id, siteId: site.id, orderId: order.id, customerId, channel: "email",
    toRef: maskEmail(inp.email), template: "order_confirmed", body: `Thanks for your order ${number} from ${site.display_name}.` });
  for (const pid of trade ? [] : new Set(b.lines.filter((l) => !["warranty", "service"].includes(l.kind)).map((l) => l.productId))) {
    await reviews.request(c, { entityId: site.entity_id, productId: pid, orderId: order.id, customerId });
  }
  return { duplicate: false, order: (await orderView(c, site.entity_id, order.id))! };
}

// ----------------------------------------------------------- order status --

const LINE_WORDS: Record<string, string> = {
  open: "Being prepared", reserved: "Set aside for you", on_order: "On order", ready: "Ready",
  fulfilled: "Delivered / picked up", returned: "Returned", cancelled: "Cancelled",
};
const ORDER_WORDS: Record<string, string> = {
  draft: "Not placed", open: "Confirmed", fulfilling: "On its way", fulfilled: "Complete", closed: "Complete", cancelled: "Cancelled",
};

/** An order as its customer may see it. */
export async function orderView(c: Client, entityId: string, orderId: string) {
  const o = (await q<{ number: string; channel: string; status: string; fulfillment: string; promised_on: string | null; ordered_at: string;
    subtotal_minor: string; tax_minor: string; total_minor: string; paid_minor: string; location: string; customer: string | null;
    line1: string | null; city: string | null; state: string | null; postal: string | null }>(c, `
    select so.number, so.channel, so.status, so.fulfillment, so.promised_on::text, so.ordered_at, so.subtotal_minor, so.tax_minor,
           so.total_minor, so.paid_minor, l.name location, cu.name customer, a.line1, a.city, a.state, a.postal
      from sales_order so join location l on l.id = so.location_id
      left join customer cu on cu.id = so.customer_id
      left join customer_address a on a.id = so.ship_address_id
     where so.id = $1 and so.entity_id = $2`, [orderId, entityId]))[0];
  if (!o) return null;
  const lines = await q<{ description: string; qty: string; unit_price_minor: string; tax_minor: string; line_status: string }>(c, `
    select description, qty, unit_price_minor, tax_minor, line_status from sales_order_line
     where entity_id = $1 and sales_order_id = $2 order by seq`, [entityId, orderId]);
  const pay = await q<{ brand: string | null; last4: string | null }>(c,
    `select brand, last4 from shop_payment where entity_id = $1 and sales_order_id = $2 order by created_at limit 1`, [entityId, orderId]);
  return {
    number: o.number, channel: o.channel, status: o.status, statusText: ORDER_WORDS[o.status] ?? o.status, fulfillment: o.fulfillment,
    promisedOn: o.promised_on, orderedAt: o.ordered_at, location: o.location, customer: o.customer,
    shipTo: o.line1 ? `${o.line1}, ${o.city}, ${o.state} ${o.postal}` : null,
    subtotalMinor: o.subtotal_minor, taxMinor: o.tax_minor, totalMinor: o.total_minor, paidMinor: o.paid_minor,
    balanceMinor: (BigInt(o.total_minor) - BigInt(o.paid_minor)).toString(),
    card: pay[0]?.last4 ? `${pay[0].brand} ending ${pay[0].last4}` : null,
    lines: lines.map((l) => ({ description: l.description, qty: Number(l.qty), unitPriceMinor: l.unit_price_minor,
      lineMinor: BigInt(Math.round(Number(l.qty) * Number(l.unit_price_minor))).toString(), statusText: LINE_WORDS[l.line_status] ?? l.line_status })),
  };
}

/** Order lookup by number and email. Says the same thing whether the number or the email was wrong. */
export async function lookupOrder(c: Client, site: Site, number: unknown, email: unknown) {
  const n = clean(number, 30).toUpperCase(), e = clean(email, 120).toLowerCase();
  need(n && EMAIL.test(e), "Enter the order number and the email you used.");
  const r = await q<{ id: string }>(c, `
    select so.id from sales_order so join customer cu on cu.id = so.customer_id
     where so.entity_id = $1 and upper(so.number) = $2 and lower(cu.email) = $3 and so.status <> 'draft'`, [site.entity_id, n, e]);
  need(r[0], "We couldn't find an order with that number and email.");
  return orderView(c, site.entity_id, r[0].id);
}

// ============================================================ back office --

export type SiteIn = Partial<{
  id: string; slug: string; displayName: string; tagline: string; brandPrimary: string; brandAccent: string; logoUrl: string;
  webLocationId: string; taxLocationId: string; pickupLocationIds: string[]; deliveryFeeMinor: bigint; freeDeliveryOverMinor: bigint | null;
  deliveryDays: number; shipFeeMinor: bigint; shipDays: number; mtoBaseDays: number; backorderDays: number; feeProductId: string | null;
  financingUrl: string; policies: string;
}>;

const HEX = /^#[0-9a-fA-F]{6}$/;
const U = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function saveSite(c: Client, entityId: string, s: SiteIn): Promise<string> {
  const slug = (s.slug ?? "").toLowerCase().trim();
  need(SLUG.test(slug), "The web address must be 2 to 40 letters, numbers or dashes, starting with a letter or number.");
  need(!["assets", "api", "admin"].includes(slug), `"${slug}" is reserved; choose another web address.`);
  const name = clean(s.displayName, 80);
  need(name.length >= 1, "Give the store a name.");
  need(!s.brandPrimary || HEX.test(s.brandPrimary), "The brand color must look like #23324a.");
  need(!s.brandAccent || HEX.test(s.brandAccent), "The accent color must look like #c08a3e.");
  const logo = (s.logoUrl ?? "").trim();
  need(!logo || /^(\/[A-Za-z0-9/._-]*|data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+)$/.test(logo),
    "The logo must be a path on this site (/...) or a data: image. Images from other sites are blocked by the store's security policy.");
  const fin = (s.financingUrl ?? "").trim();
  need(!fin || /^https:\/\/[^\s<>"]+$/.test(fin), "The financing link must start with https://.");
  need(s.webLocationId && U.test(s.webLocationId), "Choose the web location sales are credited to.");
  const pick = (s.pickupLocationIds ?? []).filter((x) => U.test(x));
  const ints = (v: number | undefined, d: number, max: number, what: string) => {
    const n = v == null ? d : Number(v); need(Number.isInteger(n) && n >= 0 && n <= max, `${what} must be a whole number from 0 to ${max}.`); return n;
  };
  const args = [entityId, slug, name, clean(s.tagline, 140) || null, s.brandPrimary || "#1f2a44", s.brandAccent || "#b8964b", logo || null,
    s.webLocationId, s.taxLocationId && U.test(s.taxLocationId) ? s.taxLocationId : null, pick,
    (s.deliveryFeeMinor ?? 0n).toString(), s.freeDeliveryOverMinor ? s.freeDeliveryOverMinor.toString() : null,
    ints(s.deliveryDays, 5, 60, "Delivery days"), (s.shipFeeMinor ?? 0n).toString(), ints(s.shipDays, 4, 60, "Shipping days"),
    ints(s.mtoBaseDays, 35, 365, "Made-to-order days"), ints(s.backorderDays, 21, 365, "Backorder days"),
    s.feeProductId && U.test(s.feeProductId) ? s.feeProductId : null, fin || null, (s.policies ?? "").slice(0, 4000) || null];
  need((s.deliveryFeeMinor ?? 0n) >= 0n && (s.shipFeeMinor ?? 0n) >= 0n, "Fees cannot be negative.");
  const taken = await q<{ id: string; entity_id: string }>(c, `select id, entity_id from shop_site where slug = $1 /* unscoped: web addresses are unique across the install */`, [slug]);
  if (taken[0] && taken[0].id !== s.id) throw new ShopError("Another store already uses that web address.");
  if (s.id) {
    need(U.test(s.id), "No such store.");
    const r = await q<{ id: string }>(c, `
      update shop_site set slug=$2, display_name=$3, tagline=$4, brand_primary=$5, brand_accent=$6, logo_url=$7, web_location_id=$8,
        tax_location_id=$9, pickup_location_ids=$10, delivery_fee_minor=$11, free_delivery_over_minor=$12, delivery_days=$13,
        ship_fee_minor=$14, ship_days=$15, mto_base_days=$16, backorder_days=$17, fee_product_id=$18, financing_url=$19, policies=$20
       where entity_id = $1 and id = $21 returning id`, [...args, s.id]);
    need(r[0], "No such store.");
    return r[0].id;
  }
  return (await one<{ id: string }>(c, `
    insert into shop_site (entity_id, slug, display_name, tagline, brand_primary, brand_accent, logo_url, web_location_id, tax_location_id,
      pickup_location_ids, delivery_fee_minor, free_delivery_over_minor, delivery_days, ship_fee_minor, ship_days, mto_base_days,
      backorder_days, fee_product_id, financing_url, policies)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning id`, args)).id;
}

export async function setSiteStatus(c: Client, entityId: string, siteId: string, status: string) {
  need(["draft", "live"].includes(status), "A store is live or draft.");
  const r = await q<{ id: string }>(c, `update shop_site set status = $3 where entity_id = $1 and id = $2 returning id`, [entityId, siteId, status]);
  need(r[0], "No such store.");
}

export async function setWebVisible(c: Client, entityId: string, productId: string, visible: boolean) {
  const p = (await q<{ id: string; name: string; status: string; kind: string }>(c,
    `select id, name, status, kind from product where id = $1 and entity_id = $2`, [productId, entityId]))[0];
  need(p, "No such product.");
  if (visible) {
    need(p.status === "active", `${p.name} is ${p.status}; only active products can be published.`);
    need(!["fee", "gift_card"].includes(p.kind), `${p.name} is a ${p.kind.replace("_", " ")} and is not sold as a product online.`);
  }
  await c.query(`update product set web_visible = $3, updated_at = now() where id = $1 and entity_id = $2`, [productId, entityId, visible]);
}

export async function productsForPublishing(c: Client, entityId: string, search: string) {
  const s = `%${search.replace(/[%_\\]/g, "")}%`;
  return q<{ id: string; sku: string; name: string; kind: string; category: string | null; price_minor: string; status: string; web_visible: boolean; available: string }>(c, `
    select p.id, p.sku, p.name, p.kind, p.category, p.price_minor, p.status, p.web_visible,
           (select coalesce(sum(greatest(a.available,0)),0) from product_availability a where a.entity_id = p.entity_id and a.product_id = p.id)::text available
      from product p where p.entity_id = $1 and p.kind not in ('fee','gift_card')
       and ($2 = '%%' or p.name ilike $2 or p.sku ilike $2 or p.category ilike $2)
     order by p.web_visible desc, p.category nulls last, p.name limit 300`, [entityId, s]);
}

export async function webOrders(c: Client, entityId: string, status: string) {
  return q(c, `
    select so.id, so.number, so.status, so.fulfillment, so.ordered_at, so.promised_on::text, so.total_minor, so.paid_minor,
           cu.name customer, cu.email, l.name location,
           (select count(*) from sales_order_line x where x.sales_order_id = so.id and x.entity_id = so.entity_id)::int lines,
           (select count(*) from sales_order_line x where x.sales_order_id = so.id and x.entity_id = so.entity_id and x.line_status = 'on_order')::int on_order
      from sales_order so left join customer cu on cu.id = so.customer_id join location l on l.id = so.location_id
     where so.entity_id = $1 and so.channel = 'web' and ($2 = '' or so.status = $2)
     order by so.ordered_at desc limit 200`, [entityId, status]);
}

export async function abandonedCarts(c: Client, entityId: string, olderThanMinutes = 60) {
  return q(c, `
    select s.slug, k.id cart_id, k.email, k.lines, k.item_count, k.subtotal_minor, k.created_at, k.updated_at
      from shop_cart k join shop_site s on s.id = k.site_id
     where k.entity_id = $1 and k.sales_order_id is null and k.item_count > 0
       and k.updated_at < now() - make_interval(mins => $2)
     order by k.updated_at desc limit 200`, [entityId, olderThanMinutes]);
}

export async function messagesAndReviews(c: Client, entityId: string) {
  const messages = await q(c, `
    select m.channel, m.to_ref, m.template, m.body, m.provider, m.status, m.created_at, so.number
      from shop_message m left join sales_order so on so.id = m.sales_order_id
     where m.entity_id = $1 order by m.created_at desc limit 100`, [entityId]);
  const reviews = await q(c, `
    select r.status, r.provider, r.rating, r.created_at, p.name product, so.number, cu.name customer
      from shop_review r join product p on p.id = r.product_id left join sales_order so on so.id = r.sales_order_id
      left join customer cu on cu.id = r.customer_id
     where r.entity_id = $1 order by r.created_at desc limit 100`, [entityId]);
  return { messages, reviews };
}

// ------------------------------------------------------ customers, history --

export async function findCustomers(c: Client, entityId: string, search: string) {
  const s = `%${search.replace(/[%_\\]/g, "")}%`;
  return q(c, `
    select cu.id, cu.number, cu.name, cu.email, cu.phone,
           (select count(*) from sales_order so where so.customer_id = cu.id and so.entity_id = cu.entity_id)::int orders,
           (select array_agg(distinct so.channel) from sales_order so where so.customer_id = cu.id and so.entity_id = cu.entity_id) channels
      from customer cu where cu.entity_id = $1
       and ($2 = '%%' or cu.name ilike $2 or cu.email ilike $2 or cu.phone ilike $2 or cu.number ilike $2)
     order by cu.name limit 50`, [entityId, s]);
}

/** One customer's orders and payments through every door: web, POS, phone. */
export async function customerHistory(c: Client, entityId: string, customerId: string) {
  if (!U.test(customerId)) return null;
  const cu = (await q(c, `select id, number, name, email, phone, status, created_at from customer where id = $1 and entity_id = $2`, [customerId, entityId]))[0];
  if (!cu) return null;
  const orders = await q(c, `
    select so.id, so.number, so.channel, so.status, so.fulfillment, so.ordered_at, so.total_minor, so.paid_minor, l.name location,
           (select string_agg(x.description, '; ' order by x.seq) from sales_order_line x where x.sales_order_id = so.id and x.entity_id = so.entity_id) items
      from sales_order so join location l on l.id = so.location_id
     where so.entity_id = $1 and so.customer_id = $2 order by so.ordered_at desc limit 200`, [entityId, customerId]);
  const receipts = await q(c, `
    select r.number, r.channel, r.method, r.amount_minor, r.received_at, r.voided_at, so.number order_number
      from customer_receipt r left join sales_order so on so.id = r.sales_order_id
     where r.entity_id = $1 and r.customer_id = $2 order by r.received_at desc limit 200`, [entityId, customerId]);
  const totals = { orders: orders.length, spentMinor: receipts.filter((r) => !r.voided_at).reduce((a, r) => a + BigInt(r.amount_minor as string), 0n).toString(),
    channels: [...new Set(orders.map((o) => o.channel as string))] };
  return { customer: cu, totals, orders, receipts };
}

// ----------------------------------------------------------- endless aisle --

/** The web catalog, seen from one store: what is on its floor, at the DC, or made to order. */
export async function aisleCatalog(c: Client, entityId: string, locationId: string, search: string, category: string) {
  need(U.test(locationId), "Choose a store.");
  const loc = (await q<{ id: string; kind: string }>(c, `select id, kind from location where id = $1 and entity_id = $2`, [locationId, entityId]))[0];
  need(loc, "No such store.");
  const s = `%${search.replace(/[%_\\]/g, "")}%`;
  return q(c, `
    select p.id, p.sku, p.name, p.kind, p.brand, p.category, p.subcategory, p.color, p.price_minor, p.ship_class,
      (select coalesce(sum(greatest(a.available,0)),0) from product_availability a where a.entity_id = p.entity_id and a.product_id = p.id and a.location_id = $2)::text here,
      (select coalesce(sum(greatest(a.available,0)),0) from product_availability a where a.entity_id = p.entity_id and a.product_id = p.id and a.location_kind = 'warehouse')::text dc,
      (select coalesce(sum(t.qty),0) from inv_in_transit t where t.entity_id = p.entity_id and t.product_id = p.id)::text arriving,
      (select min(t.arriving_on)::text from inv_in_transit t where t.entity_id = p.entity_id and t.product_id = p.id) arriving_on,
      (select count(*) from product_option_group g where g.entity_id = p.entity_id and g.product_id = p.id)::int option_groups,
      exists (select 1 from sectional_family f where f.entity_id = p.entity_id and f.product_id = p.id and f.active) sectional
      from product p where p.entity_id = $1 and p.web_visible and p.status = 'active' and p.kind not in ('fee','gift_card')
       and ($3 = '%%' or p.name ilike $3 or p.sku ilike $3 or p.brand ilike $3)
       and ($4 = '' or p.category = $4)
     order by p.category, p.name limit 300`, [entityId, locationId, s, category]);
}

export async function productOptions(c: Client, entityId: string, productId: string) {
  need(U.test(productId), "No such product.");
  const groups = await q<{ id: string; code: string; label: string; required: boolean; multi: boolean }>(c,
    `select id, code, label, required, multi from product_option_group where entity_id = $1 and product_id = $2 order by seq`, [entityId, productId]);
  const opts = await q<{ group_id: string; code: string; label: string; price_delta_minor: string; lead_days: number; swatch: string | null }>(c,
    `select group_id, code, label, price_delta_minor, lead_days, swatch from product_option where entity_id = $1 and active and group_id = any($2::uuid[]) order by seq`,
    [entityId, groups.map((g) => g.id)]);
  return groups.map((g) => ({ code: g.code, label: g.label, required: g.required, multi: g.multi,
    options: opts.filter((o) => o.group_id === g.id).map((o) => ({ code: o.code, label: o.label, priceDeltaMinor: o.price_delta_minor, leadDays: o.lead_days, swatch: o.swatch })) }));
}

/**
 * Hand a tablet cart to the register: a draft POS order at this store, every
 * line priced by priceConfigured. POS opens it, takes payment and reserves.
 */
export async function aisleHandoff(c: Client, entityId: string, personId: string, b: { locationId: unknown; customerId: unknown; lines: unknown; note: unknown }) {
  const locationId = String(b.locationId ?? "");
  need(U.test(locationId), "Choose the store this sale belongs to.");
  const loc = (await q<{ id: string; kind: string; name: string }>(c, `select id, kind, name from location where id = $1 and entity_id = $2`, [locationId, entityId]))[0];
  need(loc && loc.kind !== "web", "Choose one of the company's stores.");
  let customerId: string | null = null;
  if (b.customerId) {
    customerId = String(b.customerId);
    need(U.test(customerId) && (await q(c, `select 1 from customer where id = $1 and entity_id = $2`, [customerId, entityId])).length, "No such customer.");
  }
  const lines = parseLines(b.lines);
  need(lines.length, "The tablet cart is empty.");
  const number = (await one<{ n: string }>(c, `select next_doc_no($1, 'order', 'SO-') n /* unscoped: numbering function takes the entity */`, [entityId])).n;
  const order = await one<{ id: string }>(c, `
    insert into sales_order (entity_id, number, channel, location_id, customer_id, salesperson_id, status, fulfillment, notes, created_by)
    values ($1,$2,'pos',$3,$4,$5,'draft','carry',$6,$5) returning id`,
    [entityId, number, locationId, customerId, personId, ["Endless aisle cart from the store tablet", clean(b.note, 200)].filter(Boolean).join(". ")]);
  const wh = (await q<{ id: string }>(c, `select id from location where entity_id = $1 and kind = 'warehouse' order by code limit 1`, [entityId]))[0]?.id ?? locationId;
  let seq = 1;
  for (const l of lines) {
    const p = (await q<{ id: string; kind: string; web_visible: boolean; status: string; name: string }>(c,
      `select id, kind, web_visible, status, name from product where id = $1 and entity_id = $2`, [l.productId, entityId]))[0];
    need(p && p.status === "active", "Something on the tablet is not for sale.");
    if (await sectionals.isFamily(c, entityId, p!.id)) {
      // A sectional from the tablet: one line per piece, the set recorded, stocked pieces from here or the DC.
      need(l.sectional, `Choose the pieces of the ${p!.name}.`);
      const built = await sectionals.priceBuild(c, entityId, p!.id, l.sectional!);
      const ids: string[] = [];
      for (const x of built.parts) {
        const here = Number((await q<{ a: string }>(c, `select coalesce(sum(available),0)::text a from product_availability where entity_id = $1 and product_id = $2 and location_id = $3`,
          [entityId, x.productId, locationId]))[0]?.a ?? 0);
        const row = await one<{ id: string }>(c, `
          insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, config, fulfil_from_id, line_status)
          values ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10) returning id`,
          [entityId, order.id, seq++, x.productId, x.sku, x.description.slice(0, 300), x.netMinor.toString(), JSON.stringify(x.config),
           !x.special && here >= 1 ? locationId : wh, x.special ? "on_order" : "open"]);
        ids.push(row.id);
      }
      await sectionals.recordSet(c, entityId, { orderId: order.id, priced: built, lineIds: ids, channel: "aisle", by: personId });
      continue;
    }
    const pr = await priceConfigured(c, entityId, p!.id, l.choices);
    const here = Number((await q<{ a: string }>(c, `select coalesce(sum(available),0)::text a from product_availability where entity_id = $1 and product_id = $2 and location_id = $3`,
      [entityId, p!.id, locationId]))[0]?.a ?? 0);
    await c.query(`
      insert into sales_order_line (entity_id, sales_order_id, seq, product_id, sku, description, qty, unit_price_minor, config, fulfil_from_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [entityId, order.id, seq++, p!.id, pr.sku, pr.description, l.qty, pr.unitPriceMinor.toString(), JSON.stringify(pr.config),
       p!.kind === "stock" && here >= l.qty ? locationId : wh]);
  }
  await c.query(`select sales_order_retotal($1) /* unscoped: the order id was just created for this entity */`, [order.id]);
  const so = await one<{ number: string; total_minor: string }>(c, `select number, total_minor from sales_order where id = $1 and entity_id = $2`, [order.id, entityId]);
  return { id: order.id, number: so.number, totalMinor: so.total_minor, store: loc!.name };
}

/** Price for the tablet: same function as the web and the register. */
export async function aislePrice(c: Client, entityId: string, productId: string, choices: Choice[]) {
  need(U.test(productId), "No such product.");
  const pr = await priceConfigured(c, entityId, productId, choices);
  return { unitPriceMinor: pr.unitPriceMinor.toString(), description: pr.description, leadDays: pr.leadDays };
}
