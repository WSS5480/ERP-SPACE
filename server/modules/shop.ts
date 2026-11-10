// shop module -- the omnichannel web store and product customizer.
// See docs/MODULES.md for the contract.
//
// Public side (no token, no session): /shop/<slug>/ serves the storefront
// page; /shop/<slug>/api/* serves only what packages/core/shop.ts builds for
// shoppers, field by field -- never cost, vendor or margin. Public POSTs must
// carry x-erp-shop: 1 (publicRoute enforces it), checkout and order lookup are
// rate limited per client address, and every price is recomputed here.
//
// Back office (token or signed-in session): the "Web store" and "Endless
// aisle" screens, through kit.coGet / kit.coPost like every other module.

import type http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, tx, type Client } from "../../packages/core/db.ts";
import * as shop from "../../packages/core/shop.ts";
import { ModuleError, PublicAsset, PublicPage, requireRole, minor, str, uuid, type ErpModule } from "./kit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const readShop = (name: string): string => {
  try { return readFileSync(join(here, "..", "shop", name), "utf8"); } catch { return ""; }
};
const STORE_HTML = readShop("store.html");
const STORE_JS = readShop("store.js");
const STORE_CSS = readShop("store.css");
const V = Date.now().toString(36);

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

// ------------------------------------------------------------ rate limits --
// In memory, per process: enough to stop a script hammering checkout or
// guessing order numbers. Behind Render's proxy the client address is the
// last x-forwarded-for hop (the one the proxy itself added).
const hits = new Map<string, number[]>();
export function clientIp(req: http.IncomingMessage): string {
  const xf = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return xf.length ? xf[xf.length - 1] : (req.socket?.remoteAddress ?? "?");
}
export const LIMITS = { checkout: { max: 8, ms: 10 * 60_000 }, lookup: { max: 10, ms: 10 * 60_000 }, cart: { max: 240, ms: 10 * 60_000 } };
function limited(req: http.IncomingMessage, bucket: keyof typeof LIMITS): boolean {
  const { max, ms } = LIMITS[bucket];
  const now = Date.now(), key = `${bucket}:${clientIp(req)}`;
  const list = (hits.get(key) ?? []).filter((t) => now - t < ms);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 20_000) for (const [k, v] of hits) if (!v.some((t) => now - t < ms)) hits.delete(k);
  return false;
}
export const _resetLimits = () => hits.clear();
const TOO_MANY: [number, unknown] = [429, { error: "Too many tries from here. Wait a few minutes and try again." }];

// ------------------------------------------------------------- helpers --

/** Public reads run in a read-only transaction so nothing they touch can change. */
async function readOnly<R>(fn: (c: Client) => Promise<R>): Promise<R> {
  const c = await pool.connect();
  try {
    await c.query("begin read only");
    const out = await fn(c);
    await c.query("rollback");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally { c.release(); }
}
const refused = (e: unknown): string | null => (shop.SHOP_REFUSALS.some((K) => e instanceof K) ? (e as Error).message : null);
/** Back-office calls: the shop's refusals become the kit's, so they come back as sentences. */
async function bo<R>(fn: () => Promise<R>): Promise<R> {
  try { return await fn(); } catch (e) { const m = refused(e); if (m) throw new ModuleError(m); throw e; }
}
const NO_STORE: [number, unknown] = [404, { error: "There is no store at this address." }];
const moneyOrNull = (v: unknown): bigint | null => (v == null || v === "" ? null : minor(v));

function notFoundPage(): PublicPage {
  return new PublicPage(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Store not found</title><link rel="stylesheet" href="/shop/assets/store.css?v=${V}">
<body class="plain"><main class="wrap narrow"><h1>There is no store here</h1><p>Check the address, or the store may not be open yet.</p></main></body></html>`);
}

export const module: ErpModule = {
  id: "shop",
  register(kit) {
    // ======================================================== public side
    kit.publicRoute("GET", /^\/shop\/assets\/(store\.js|store\.css)$/, async (_req, _url, m) => {
      const js = m[1] === "store.js";
      const text = js ? STORE_JS : STORE_CSS;
      if (!text) return [404, { error: "not found" }];
      return [200, new PublicAsset(text, js ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8")];
    });

    kit.publicRoute("GET", /^\/shop\/([a-z0-9][a-z0-9-]{1,39})\/?$/, async (_req, _url, m) => {
      const site = await readOnly((c) => shop.siteBySlug(c, m[1]));
      if (!site || !STORE_HTML) return [404, notFoundPage()];
      const html = STORE_HTML
        .replaceAll("__TITLE__", esc(site.display_name))
        .replaceAll("__SLUG__", esc(site.slug))
        .replaceAll("__BRAND__", /^#[0-9a-fA-F]{6}$/.test(site.brand_primary) ? site.brand_primary : "#1f2a44")
        .replaceAll("__ACCENT__", /^#[0-9a-fA-F]{6}$/.test(site.brand_accent) ? site.brand_accent : "#b8964b")
        .replaceAll("__V__", V);
      return [200, new PublicPage(html)];
    });

    const API = "^\\/shop\\/([a-z0-9][a-z0-9-]{1,39})\\/api";
    const pubGet = (tail: string, fn: (c: Client, site: shop.Site, url: URL, m: RegExpMatchArray) => Promise<unknown>) =>
      kit.publicRoute("GET", new RegExp(`${API}${tail}$`), async (_req, url, m) => {
        try {
          return await readOnly(async (c) => {
            const site = await shop.siteBySlug(c, m[1]);
            if (!site) return NO_STORE;
            const out = await fn(c, site, url, m);
            return out == null ? [404, { error: "That isn't in this store." }] as [number, unknown] : [200, out] as [number, unknown];
          });
        } catch (e) { const why = refused(e); if (why) return [422, { error: why }]; throw e; }
      });
    const pubPost = (tail: string, bucket: keyof typeof LIMITS,
      fn: (c: Client, site: shop.Site, body: Record<string, unknown>, req: http.IncomingMessage) => Promise<unknown>) =>
      kit.publicRoute("POST", new RegExp(`${API}${tail}$`), async (req, _url, m, body) => {
        if (limited(req, bucket)) return TOO_MANY;
        try {
          return await tx({ kind: "system", label: "web store" }, async (c) => {
            const site = await shop.siteBySlug(c, m[1]);
            if (!site) return NO_STORE;
            return [200, await fn(c, site, body, req)] as [number, unknown];
          });
        } catch (e) { const why = refused(e); if (why) return [422, { error: why }]; throw e; }
      });

    pubGet("\\/site", (c, site) => shop.pubSite(c, site));
    pubGet("\\/products", (c, site, url) => {
      const p = url.searchParams;
      const money = (k: string) => { const v = p.get(k); return v && /^\d{1,9}$/.test(v) ? BigInt(v) : null; };
      return shop.pubProducts(c, site, {
        category: str(p.get("category"), 80) || undefined, brand: str(p.get("brand"), 80) || undefined,
        color: str(p.get("color"), 80) || undefined, minMinor: money("min"), maxMinor: money("max"),
        sort: str(p.get("sort"), 20), q: str(p.get("q"), 80) || undefined,
      });
    });
    pubGet("\\/products\\/([0-9a-f-]{36})", (c, site, _url, m) => shop.pubProduct(c, site, m[2]));

    pubPost("\\/price", "cart", (c, site, b) => shop.pubPrice(c, site, String(b.productId ?? ""), shop.parseChoices(b.choices)));
    pubPost("\\/sectional-price", "cart", (c, site, b) => shop.pubSectionalPrice(c, site, String(b.productId ?? ""), shop.parseBuild(b.sectional)));
    pubPost("\\/cart", "cart", (c, site, b) => { return shop.saveCart(c, site, String(b.cartId ?? ""), b.lines ?? [], b.email); });
    pubPost("\\/quote", "cart", (c, site, b) => shop.quote(c, site, shop.parseCheckout(b, true)));
    pubPost("\\/checkout", "checkout", async (c, site, b) => {
      const inp = shop.parseCheckout(b);
      const placed = await shop.placeWebOrder(c, site, inp, { tenantId: site.tenant_id, entityId: site.entity_id, actor: { kind: "system", label: `web store ${site.slug}` } });
      return placed;
    });
    pubPost("\\/order-status", "lookup", (c, site, b) => shop.lookupOrder(c, site, b.number, b.email));

    // ======================================================= back office
    const SETTINGS = ["web_admin"];
    const AISLE = ["web_admin", "store_manager", "sales"];

    kit.coGet("/shop/sites", async (c, co) => {
      const sites = await shop.sitesOf(c, co.id);
      const locations = await c.query(`select id, code, name, kind, tax_rate_bps from location where entity_id = $1 and status = 'active' and kind not in ('in_transit','dropship') order by kind, name`, [co.id]);
      const fees = await c.query(`select id, sku, name, price_minor from product where entity_id = $1 and kind = 'fee' and status = 'active' order by name`, [co.id]);
      return { sites, locations: locations.rows, feeProducts: fees.rows };
    });
    kit.coPost("/shop/sites/save", async (c, co, a, b) => {
      await requireRole(c, co, a, SETTINGS, "changing the web store");
      const id = await bo(() => shop.saveSite(c, co.id, {
        id: uuid(b.id) ?? undefined, slug: str(b.slug, 40), displayName: str(b.displayName, 80), tagline: str(b.tagline, 140),
        brandPrimary: str(b.brandPrimary, 7), brandAccent: str(b.brandAccent, 7), logoUrl: str(b.logoUrl, 200_000),
        webLocationId: uuid(b.webLocationId) ?? "", taxLocationId: uuid(b.taxLocationId) ?? undefined,
        pickupLocationIds: Array.isArray(b.pickupLocationIds) ? b.pickupLocationIds.map((x) => uuid(x)).filter((x): x is string => !!x) : [],
        deliveryFeeMinor: minor(b.deliveryFee ?? 0), freeDeliveryOverMinor: moneyOrNull(b.freeDeliveryOver),
        deliveryDays: Number(b.deliveryDays ?? 5), shipFeeMinor: minor(b.shipFee ?? 0), shipDays: Number(b.shipDays ?? 4),
        mtoBaseDays: Number(b.mtoBaseDays ?? 35), backorderDays: Number(b.backorderDays ?? 21),
        feeProductId: uuid(b.feeProductId), financingUrl: str(b.financingUrl, 500), policies: str(b.policies, 4000),
      }));
      return { id };
    });
    kit.coPost("/shop/sites/status", async (c, co, a, b) => {
      await requireRole(c, co, a, SETTINGS, "opening or closing the web store");
      await bo(() => shop.setSiteStatus(c, co.id, uuid(b.siteId) ?? "", str(b.status, 10)));
      return { ok: true };
    });

    kit.coGet("/shop/products", (c, co, url) => shop.productsForPublishing(c, co.id, str(url.searchParams.get("q"), 80)));
    kit.coPost("/shop/products/visible", async (c, co, a, b) => {
      await requireRole(c, co, a, SETTINGS, "publishing products to the web store");
      await bo(() => shop.setWebVisible(c, co.id, uuid(b.productId) ?? "", b.visible === true));
      return { ok: true };
    });

    kit.coGet("/shop/orders", (c, co, url) => shop.webOrders(c, co.id, (() => {
      const s = str(url.searchParams.get("status"), 20);
      return ["open", "fulfilling", "fulfilled", "closed", "cancelled"].includes(s) ? s : "";
    })()));
    kit.coGet("/shop/orders/([0-9a-fA-F-]{36})", (c, co, _url, m) => shop.orderView(c, co.id, m[2]));
    kit.coGet("/shop/carts", (c, co, url) => shop.abandonedCarts(c, co.id, Math.max(0, Math.min(10_080, Number(url.searchParams.get("minutes") ?? 60) || 60))));
    kit.coGet("/shop/messages", (c, co) => shop.messagesAndReviews(c, co.id));
    kit.coGet("/shop/customers", (c, co, url) => shop.findCustomers(c, co.id, str(url.searchParams.get("q"), 80)));
    kit.coGet("/shop/customers/([0-9a-fA-F-]{36})", (c, co, _url, m) => shop.customerHistory(c, co.id, m[2]));

    kit.coGet("/shop/aisle", async (c, co, url) => {
      const stores = (await c.query(`select id, name, kind from location where entity_id = $1 and status = 'active' and kind in ('store','outlet') order by name`, [co.id])).rows;
      const loc = uuid(url.searchParams.get("location")) ?? stores[0]?.id;
      if (!loc) return { stores, products: [], categories: [] };
      const products = await bo(() => shop.aisleCatalog(c, co.id, loc, str(url.searchParams.get("q"), 80), str(url.searchParams.get("category"), 80)));
      const cats = (await c.query(`select distinct category from product where entity_id = $1 and web_visible and status = 'active' and category is not null and kind not in ('fee','gift_card') order by category`, [co.id])).rows.map((r) => r.category);
      return { stores, location: loc, products, categories: cats };
    });
    kit.coGet("/shop/aisle/options/([0-9a-fA-F-]{36})", (c, co, _url, m) => bo(() => shop.productOptions(c, co.id, m[2])));
    kit.coPost("/shop/aisle/price", async (c, co, a, b) => {
      await requireRole(c, co, a, AISLE, "pricing on the store tablet");
      return bo(() => shop.aislePrice(c, co.id, uuid(b.productId) ?? "", shop.parseChoices(b.choices)));
    });
    kit.coPost("/shop/aisle/handoff", async (c, co, a, b) => {
      await requireRole(c, co, a, AISLE, "handing a tablet cart to the register");
      return bo(() => shop.aisleHandoff(c, co.id, a.personId, { locationId: b.locationId, customerId: b.customerId, lines: b.lines, note: b.note }));
    });
  },
};
