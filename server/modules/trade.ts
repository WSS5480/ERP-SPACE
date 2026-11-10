// trade module -- trade and designer accounts, the trade portal, room
// projects (clienteling) and the designer as a commission role.
// See docs/MODULES.md ("Trade accounts, the trade portal, room projects").
//
// Public side, through kit.publicRoute (no token, no staff session):
//   /trade/<slug>/                 the portal page (script from /trade/assets, no inline script)
//   /trade/<slug>/api/apply        apply for an account (POST, x-erp-shop, rate limited)
//   /trade/<slug>/api/code|verify  emailed sign-in code (rate limited; codes and sessions kept hashed)
//   /trade/<slug>/api/*            everything else needs the portal session in x-trade-session,
//                                  and only ever reads or writes that account's own rows
// Back office: the "Trade accounts" and "Room projects" screens through
// kit.coGet / kit.coPost like every other module.

import type http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tx, type Client } from "../../packages/core/db.ts";
import * as shop from "../../packages/core/shop.ts";
import * as trade from "../../packages/core/trade.ts";
import * as projects from "../../packages/core/projects.ts";
import * as tc from "../../packages/core/trade_commission.ts";
import * as cat from "../../packages/core/catalog.ts";
import * as tax from "../../packages/core/tax.ts";
import { createLink } from "./tearsheet.ts";
import { ModuleError, PublicAsset, PublicPage, requireRole, minor, str, uuid, int, type ErpModule, type Company, type Actor } from "./kit.ts";
import { rolesOf } from "../actions.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => { try { return readFileSync(join(here, "..", "shop", name), "utf8"); } catch { return ""; } };
const PORTAL_HTML = read("trade.html");
const PORTAL_JS = read("trade.js");
const PORTAL_CSS = read("trade.css");
const V = Date.now().toString(36);
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

// Who does what in the back office.
export const ROLES = {
  review: ["store_manager", "controller"],                          // decide applications, change an account
  credit: ["controller"],                                           // credit limit and terms (A/R's own rule)
  certs: ["store_manager", "ar_clerk", "controller"],               // resale certificates (POS's rule)
  prices: ["buyer"],                                                // price list rules (catalog's rule)
  projects: ["sales", "store_manager", "designer", "marketing"],    // room projects
  lines: ["sales", "store_manager", "designer", "cashier"],         // a line's designer split and referral
  followups: ["store_manager"],                                     // follow-up settings
  referrals: ["controller", "ap_clerk"],                            // billing referral commission
  view: ["sales", "store_manager", "designer", "controller", "ar_clerk", "marketing", "cashier", "buyer"],
};

const scopeOf = (co: Company, a: Actor) => ({ tenantId: co.tenantId, entityId: co.id, actor: { kind: "user" as const, id: a.personId, label: a.label } });
const refused = (e: unknown): string | null => {
  if ([...trade.TRADE_REFUSALS, tc.TradeCommissionError, cat.CatalogError].some((K) => e instanceof K)) {
    const m = (e as Error).message;
    return m.charAt(0).toUpperCase() + m.slice(1);
  }
  return null;
};
async function bo<R>(fn: () => Promise<R>): Promise<R> {
  try { return await fn(); } catch (e) { const m = refused(e); if (m) throw new ModuleError(m); throw e; }
}
async function viewGuard(c: Client, co: Company, personId: string | null) {
  if (!personId) return;   // the operator's token
  const held = await rolesOf(c, co, personId);
  if (!held.has("owner") && !ROLES.view.some((r) => held.has(r))) throw new ModuleError("trade accounts and room projects are for store staff");
}

// ------------------------------------------------------------ rate limits --
const hits = new Map<string, number[]>();
export const LIMITS = { apply: { max: 5, ms: 60 * 60_000 }, code: { max: 6, ms: 15 * 60_000 }, verify: { max: 20, ms: 15 * 60_000 }, portal: { max: 600, ms: 10 * 60_000 } };
function clientIp(req: http.IncomingMessage): string {
  const xf = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return xf.length ? xf[xf.length - 1] : (req.socket?.remoteAddress ?? "?");
}
function limited(req: http.IncomingMessage, bucket: keyof typeof LIMITS): boolean {
  const { max, ms } = LIMITS[bucket];
  const now = Date.now(), key = `${bucket}:${clientIp(req)}`;
  const list = (hits.get(key) ?? []).filter((t) => now - t < ms);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now); hits.set(key, list);
  if (hits.size > 20_000) for (const [k, v] of hits) if (!v.some((t) => now - t < ms)) hits.delete(k);
  return false;
}
export const _resetLimits = () => hits.clear();
const TOO_MANY: [number, unknown] = [429, { error: "Too many tries from here. Wait a few minutes and try again." }];
const NO_STORE: [number, unknown] = [404, { error: "There is no trade program at this address." }];
const SIGN_IN: [number, unknown] = [401, { error: "Sign in to the trade portal again." }];
const ipHash = (req: http.IncomingMessage, entityId: string) => createHash("sha256").update(`${entityId}|${clientIp(req)}`).digest("hex");

const moneyOrNull = (v: unknown): bigint | null => (v == null || v === "" ? null : minor(v));

export const module: ErpModule = {
  id: "trade",
  register(kit) {
    // ======================================================== public side
    kit.publicRoute("GET", /^\/trade\/assets\/(trade\.js|trade\.css)$/, async (_req, _url, m) => {
      const js = m[1] === "trade.js";
      const text = js ? PORTAL_JS : PORTAL_CSS;
      if (!text) return [404, { error: "not found" }];
      return [200, new PublicAsset(text, js ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8")];
    });
    kit.publicRoute("GET", /^\/trade\/([a-z0-9][a-z0-9-]{1,39})\/?$/, async (_req, _url, m) => {
      const site = await tx({ kind: "system", label: "trade portal" }, (c) => shop.siteBySlug(c, m[1]));
      if (!site || !PORTAL_HTML) return [404, new PublicPage(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><body><p>There is no trade program here.</p></body></html>`)];
      return [200, new PublicPage(PORTAL_HTML.replaceAll("__TITLE__", esc(site.display_name)).replaceAll("__SLUG__", esc(site.slug))
        .replaceAll("__BRAND__", /^#[0-9a-fA-F]{6}$/.test(site.brand_primary) ? site.brand_primary : "#1f2a44")
        .replaceAll("__ACCENT__", /^#[0-9a-fA-F]{6}$/.test(site.brand_accent) ? site.brand_accent : "#b8964b").replaceAll("__V__", V))];
    });

    const API = "^\\/trade\\/([a-z0-9][a-z0-9-]{1,39})\\/api";
    const run = async (req: http.IncomingMessage, slug: string, fn: (c: Client, site: shop.Site) => Promise<[number, unknown]>): Promise<[number, unknown]> => {
      try {
        return await tx({ kind: "system", label: "trade portal" }, async (c) => {
          const site = await shop.siteBySlug(c, slug);
          if (!site) return NO_STORE;
          return fn(c, site);
        });
      } catch (e) { const why = refused(e); if (why) return [422, { error: why }]; throw e; }
    };
    // Open doors: apply, ask for a code, check it.
    kit.publicRoute("POST", new RegExp(`${API}\\/apply$`), (req, _url, m, b) => limited(req, "apply") ? Promise.resolve(TOO_MANY)
      : run(req, m[1], async (c, site) => [200, await trade.submitApplication(c, site, b as trade.ApplicationIn, ipHash(req, site.entity_id))]));
    kit.publicRoute("POST", new RegExp(`${API}\\/code$`), (req, _url, m, b) => limited(req, "code") ? Promise.resolve(TOO_MANY)
      : run(req, m[1], async (c, site) => [200, await trade.requestCode(c, site, b.email, ipHash(req, site.entity_id))]));
    kit.publicRoute("POST", new RegExp(`${API}\\/verify$`), (req, _url, m, b) => limited(req, "verify") ? Promise.resolve(TOO_MANY)
      : run(req, m[1], async (c, site) => {
        // A wrong code is answered, not thrown, so the count of tries is kept.
        const r = await trade.verifyCode(c, site, b.email, b.code);
        return r.ok ? [200, r] : [422, { error: r.error }];
      }));

    // Signed-in doors.
    const session = (req: http.IncomingMessage) => String(req.headers["x-trade-session"] ?? "");
    const signedIn = (method: "GET" | "POST", tail: string, fn: (c: Client, site: shop.Site, s: trade.Session, url: URL, m: RegExpMatchArray, b: Record<string, unknown>) => Promise<unknown>) =>
      kit.publicRoute(method, new RegExp(`${API}${tail}$`), (req, url, m, b) => limited(req, "portal") ? Promise.resolve(TOO_MANY)
        : run(req, m[1], async (c, site) => {
          const tok = session(req);
          const s = await trade.sessionFor(c, site, tok);
          if (!s) return SIGN_IN;
          await trade.touchSession(c, site, tok);
          const out = await fn(c, site, s, url, m, b);
          return out == null ? [404, { error: "That isn't in your account." }] : [200, out];
        }));
    const ID = "([0-9a-fA-F-]{36})";
    kit.publicRoute("POST", new RegExp(`${API}\\/signout$`), (req, _url, m) => run(req, m[1], async (c, site) => { await trade.signOut(c, site, session(req)); return [200, { ok: true }]; }));
    signedIn("GET", "\\/me", (c, site, s) => trade.me(c, site, s));
    signedIn("GET", "\\/catalog", (c, site, s, url) => {
      const p = url.searchParams;
      return trade.catalog(c, site, s, { category: str(p.get("category"), 80) || undefined, q: str(p.get("q"), 80) || undefined, sort: str(p.get("sort"), 20) });
    });
    signedIn("GET", `\\/products\\/${ID}`, (c, site, s, _u, m) => trade.product(c, site, s, m[2]));
    signedIn("POST", "\\/price", (c, site, s, _u, _m, b) => trade.tradePrice(c, site, s, String(b.productId ?? ""), shop.parseChoices(b.choices)));
    signedIn("GET", "\\/projects", (c, site, s) => trade.myProjects(c, site, s));
    signedIn("GET", `\\/projects\\/${ID}`, (c, site, s, _u, m) => trade.myProject(c, site, s, m[2]));
    signedIn("POST", "\\/projects", (c, site, s, _u, _m, b) => trade.createProject(c, site, s, projectIn(b)));
    signedIn("POST", `\\/projects\\/${ID}`, (c, site, s, _u, m, b) => trade.updateProject(c, site, s, m[2], projectIn(b)));
    signedIn("POST", `\\/projects\\/${ID}\\/items`, (c, site, s, _u, m, b) =>
      trade.addProjectItem(c, site, s, m[2], { productId: String(b.productId ?? ""), choices: shop.parseChoices(b.choices), qty: int(b.qty, 1), note: b.note }).then((id) => ({ id })));
    signedIn("POST", `\\/projects\\/${ID}\\/items\\/${ID}`, (c, site, s, _u, m, b) =>
      trade.setProjectItem(c, site, s, m[2], m[3], { qty: b.qty == null ? undefined : int(b.qty, 1), remove: b.remove === true }).then(() => ({ ok: true })));
    signedIn("POST", `\\/projects\\/${ID}\\/photos`, (c, site, s, _u, m, b) => trade.addProjectPhoto(c, site, s, m[2], b.dataUrl, b.caption).then((id) => ({ id })));
    signedIn("POST", `\\/projects\\/${ID}\\/photos\\/${ID}\\/remove`, (c, site, s, _u, m) => trade.removeProjectPhoto(c, site, s, m[2], m[3]).then(() => ({ ok: true })));
    signedIn("POST", "\\/quote", (c, site, s, _u, _m, b) => trade.quoteOrder(c, site, s, orderIn(b)));
    signedIn("POST", "\\/order", (c, site, s, _u, _m, b) => trade.placeOrder(c, site, s, orderIn(b)));
    signedIn("GET", "\\/orders", (c, site, s) => trade.orders(c, site, s));
    signedIn("GET", `\\/orders\\/${ID}`, (c, site, s, _u, m) => trade.order(c, site, s, m[2]));
    signedIn("GET", "\\/invoices", (c, site, s) => trade.invoices(c, site, s));
    signedIn("POST", `\\/invoices\\/${ID}\\/pay`, (c, site, s, _u, m, b) => trade.payInvoice(c, site, s, m[2], { amountMinor: moneyOrNull(b.amount), paymentToken: b.paymentToken }));
    signedIn("POST", "\\/sheet", (c, site, s, _u, _m, b) => trade.sheetLink(c, site, s, { orderId: uuid(b.orderId), productId: uuid(b.productId) }, createLink));

    // ======================================================= back office
    kit.coGet("/trade/applications", async (c, co, url, _m, pid) => { await viewGuard(c, co, pid);
      const st = str(url.searchParams.get("status"), 10); return trade.applications(c, co.id, ["pending", "approved", "declined", "all"].includes(st) ? (st === "all" ? "" : st) : "pending"); });
    kit.coPost("/trade/applications/([0-9a-fA-F-]{36})/decide", async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, ROLES.review, "deciding a trade application");
      const canCredit = held.has("owner") || ROLES.credit.some((r) => held.has(r));
      return bo(() => trade.decideApplication(c, scopeOf(co, a), m[2], {
        decision: str(b.decision, 10) as "approved" | "declined", note: b.note, priceListId: uuid(b.priceListId),
        creditLimitMinor: b.creditLimit == null || b.creditLimit === "" ? undefined : minor(b.creditLimit), termsDays: b.termsDays == null ? undefined : int(b.termsDays, 30),
        referralBps: b.referralBps == null ? undefined : int(b.referralBps, 0), repId: uuid(b.repId), vendorId: uuid(b.vendorId),
      }, canCredit));
    });
    kit.coGet("/trade/accounts", async (c, co, url, _m, pid) => { await viewGuard(c, co, pid);
      return trade.accounts(c, co.id, { q: str(url.searchParams.get("q"), 60), status: str(url.searchParams.get("status"), 10) }); });
    kit.coGet("/trade/accounts/([0-9a-fA-F-]{36})", async (c, co, _url, m, pid) => { await viewGuard(c, co, pid); return trade.account(c, co.id, m[2]); });
    kit.coGet("/trade/options", async (c, co, _url, _m, pid) => {
      await viewGuard(c, co, pid);
      const lists = (await c.query(`select id, code, name, active from price_list where entity_id = $1 order by code`, [co.id])).rows;
      const vendors = (await c.query(`select v.id, v.legal_name from vendor v join vendor_entity ve on ve.vendor_id = v.id and ve.entity_id = $1 where ve.status <> 'inactive' order by v.legal_name`, [co.id])).rows;
      const people = (await c.query(`select distinct u.id, u.name from app_user u join role_grant g on g.app_user_id = u.id
          where u.status = 'active' and g.role in ('sales','store_manager','designer','owner') and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = $2)) order by u.name`, [co.id, co.tenantId])).rows;
      const categories = (await c.query(`select distinct category from product where entity_id = $1 and category is not null and kind not in ('fee','gift_card') order by category`, [co.id])).rows.map((r) => r.category);
      const accounts = (await c.query(`select id, number, company_name, referral_bps from trade_account where entity_id = $1 and status = 'active' order by company_name`, [co.id])).rows;
      return { priceLists: lists, vendors, people, categories, accounts, followups: await projects.followUpSettings(c, co.id), referralOn: await tc.referralTrigger(c, co.id) };
    });
    kit.coPost("/trade/accounts/([0-9a-fA-F-]{36})", async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, ROLES.review, "changing a trade account");
      const canCredit = held.has("owner") || ROLES.credit.some((r) => held.has(r));
      return bo(() => trade.saveAccount(c, scopeOf(co, a), m[2], {
        status: b.status == null ? undefined : str(b.status, 10), statusReason: b.statusReason, priceListId: uuid(b.priceListId),
        referralBps: b.referralBps == null || b.referralBps === "" ? undefined : int(b.referralBps, 0), referralBasis: b.referralBasis == null ? undefined : str(b.referralBasis, 10),
        vendorId: b.vendorId === undefined ? undefined : uuid(b.vendorId), repId: b.repId === undefined ? undefined : uuid(b.repId),
        contactName: b.contactName, phone: b.phone,
        creditLimitMinor: b.creditLimit == null || b.creditLimit === "" ? undefined : minor(b.creditLimit), termsDays: b.termsDays == null || b.termsDays === "" ? undefined : int(b.termsDays, 30),
      }, canCredit));
    });
    kit.coPost("/trade/accounts/([0-9a-fA-F-]{36})/certificate", async (c, co, a, b, m) => {
      await requireRole(c, co, a, ROLES.certs, "keeping a resale certificate on file");
      const acct = await trade.account(c, co.id, m[2]);
      if (!acct) throw new ModuleError("No such trade account.");
      return bo(() => tax.saveCertificate(c, scopeOf(co, a), { customerId: acct.account.customer_id, number: str(b.number, 60), state: str(b.state, 2), reason: "resale", expiresOn: str(b.expiresOn, 10) || null }));
    });
    kit.coPost("/trade/accounts/([0-9a-fA-F-]{36})/bill-referrals", async (c, co, a, _b, m) => {
      await requireRole(c, co, a, ROLES.referrals, "billing referral commission");
      return bo(() => tc.billReferrals(c, scopeOf(co, a), m[2], a.personId));
    });
    kit.coGet("/trade/referrals", async (c, co, _url, _m, pid) => { await viewGuard(c, co, pid); return tc.referralsOwed(c, co.id); });
    kit.coPost("/trade/referral-trigger", async (c, co, a, b) => {
      await requireRole(c, co, a, ROLES.referrals, "choosing when referral commission is earned");
      const v = str(b.value, 10);
      if (!["delivered", "paid"].includes(v)) throw new ModuleError("Referral commission is earned on delivery or once paid.");
      await c.query(`insert into entity_setting (entity_id, key, value, set_by) values ($1,'trade.referral_on',$2,$3)
                     on conflict (entity_id, key) do update set value = excluded.value, set_by = excluded.set_by, set_at = now()`, [co.id, JSON.stringify(v), a.label]);
      return { value: v };
    });
    kit.coGet("/trade/price-lists/([0-9a-fA-F-]{36})/rules", async (c, co, _url, m, pid) => { await viewGuard(c, co, pid); return cat.priceRules(c, co.id, m[2]); });
    kit.coPost("/trade/price-lists/([0-9a-fA-F-]{36})/rules", async (c, co, a, b, m) => {
      await requireRole(c, co, a, ROLES.prices, "changing trade price rules");
      const id = await bo(() => cat.savePriceRule(c, scopeOf(co, a), m[2], { category: str(b.category, 80) || null, basis: str(b.basis, 20), bps: int(b.bps, -1), active: b.active !== false }));
      return { id, rules: await cat.priceRules(c, co.id, m[2]) };
    });

    // Room projects.
    kit.coGet("/trade/projects", async (c, co, url, _m, pid) => { await viewGuard(c, co, pid);
      return projects.projectsFor(c, co.id, { customerId: uuid(url.searchParams.get("customer")), tradeAccountId: uuid(url.searchParams.get("account")),
        q: str(url.searchParams.get("q"), 60), status: (() => { const s = str(url.searchParams.get("status"), 10); return ["open", "won", "closed"].includes(s) ? s : ""; })() }); });
    kit.coGet("/trade/projects/([0-9a-fA-F-]{36})", async (c, co, _url, m, pid) => {
      await viewGuard(c, co, pid);
      // Read-only transaction: pricing each item runs behind a savepoint.
      await c.query("begin read only");
      try {
        const p = await projects.project(c, co.id, m[2]);
        if (!p) return null;
        // Staff see the account's trade prices too, when it is a trade project.
        const list = p.trade_account_id ? (await c.query(`select pl.code from trade_account t join price_list pl on pl.id = t.price_list_id where t.id = $1 and t.entity_id = $2`, [p.trade_account_id, co.id])).rows[0]?.code ?? null : null;
        return list ? await projects.project(c, co.id, m[2], {}, list) : p;
      } finally { await c.query("rollback"); }
    });
    kit.coPost("/trade/projects", async (c, co, a, b) => {
      await requireRole(c, co, a, ROLES.projects, "starting a room project");
      return bo(() => projects.createProject(c, scopeOf(co, a), { ...projectIn(b), customerId: uuid(b.customerId) ?? "", tradeAccountId: uuid(b.tradeAccountId), salespersonId: uuid(b.salespersonId) }));
    });
    kit.coPost("/trade/projects/([0-9a-fA-F-]{36})", async (c, co, a, b, m) => {
      await requireRole(c, co, a, ROLES.projects, "changing a room project");
      return bo(() => projects.updateProject(c, scopeOf(co, a), m[2], { ...projectIn(b), salespersonId: b.salespersonId === undefined ? undefined : uuid(b.salespersonId) }));
    });
    kit.coPost("/trade/projects/([0-9a-fA-F-]{36})/items", async (c, co, a, b, m) => {
      await requireRole(c, co, a, ROLES.projects, "adding to a room project");
      return { id: await bo(() => projects.addItem(c, scopeOf(co, a), m[2], { productId: String(b.productId ?? ""), choices: shop.parseChoices(b.choices), qty: int(b.qty, 1),
        stage: str(b.stage, 12) || undefined, note: b.note })) };
    });
    kit.coPost("/trade/projects/([0-9a-fA-F-]{36})/items/([0-9a-fA-F-]{36})", async (c, co, a, b, m) => {
      await requireRole(c, co, a, ROLES.projects, "changing a room project");
      await bo(() => projects.setItem(c, scopeOf(co, a), m[2], m[3], { stage: str(b.stage, 12) || undefined, qty: b.qty == null ? undefined : int(b.qty, 1), remove: b.remove === true }));
      return { ok: true };
    });
    kit.coPost("/trade/projects/([0-9a-fA-F-]{36})/photos", async (c, co, a, b, m) => {
      await requireRole(c, co, a, ROLES.projects, "adding a photo to a room project");
      return { id: await bo(() => projects.addPhoto(c, scopeOf(co, a), m[2], b.dataUrl, b.caption)) };
    });
    kit.coPost("/trade/projects/([0-9a-fA-F-]{36})/photos/([0-9a-fA-F-]{36})/remove", async (c, co, a, _b, m) => {
      await requireRole(c, co, a, ROLES.projects, "removing a photo");
      await bo(() => projects.removePhoto(c, scopeOf(co, a), m[2], m[3]));
      return { ok: true };
    });
    kit.coPost("/trade/projects/([0-9a-fA-F-]{36})/orders", async (c, co, a, b, m) => {
      await requireRole(c, co, a, ROLES.projects, "linking an order to a room project");
      return bo(() => projects.linkOrder(c, scopeOf(co, a), m[2], uuid(b.orderId) ?? ""));
    });

    // Follow-ups.
    kit.coPost("/trade/followups/settings", async (c, co, a, b) => {
      await requireRole(c, co, a, ROLES.followups, "changing clienteling follow-ups");
      return bo(() => projects.saveFollowUpSettings(c, scopeOf(co, a), {
        quoteNoSaleDays: b.quoteNoSaleDays == null ? undefined : int(b.quoteNoSaleDays, 3), careDays: b.careDays == null ? undefined : int(b.careDays, 30),
        protectionDays: b.protectionDays == null ? undefined : int(b.protectionDays, 365),
        quoteNoSale: b.quoteNoSale == null ? undefined : b.quoteNoSale === true, care: b.care == null ? undefined : b.care === true,
        protection: b.protection == null ? undefined : b.protection === true }));
    });
    kit.coPost("/trade/followups/run", async (c, co, a) => {
      await requireRole(c, co, a, ROLES.followups, "running clienteling follow-ups");
      return projects.runFollowUps(c, scopeOf(co, a));
    });

    // A sale line's designer split and outside referral.
    kit.coGet("/trade/lines/([0-9a-fA-F-]{36})/commission", async (c, co, _url, m, pid) => { await viewGuard(c, co, pid); return tc.lineCommission(c, co.id, m[2]); });
    kit.coPost("/trade/lines/([0-9a-fA-F-]{36})/commission", async (c, co, a, b, m) => {
      await requireRole(c, co, a, ROLES.lines, "splitting a line's commission");
      return bo(() => tc.setLineCommission(c, scopeOf(co, a), m[2], {
        primaryId: b.primaryId === undefined ? undefined : uuid(b.primaryId), designerId: b.designerId === undefined ? undefined : uuid(b.designerId),
        designerSplitBps: b.designerSplitBps == null ? null : int(b.designerSplitBps, 0),
        referralTradeAccountId: uuid(b.referralTradeAccountId), clearReferral: b.clearReferral === true }));
    });
  },
};

function projectIn(b: Record<string, unknown>): projects.ProjectIn {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  return {
    name: has("name") ? b.name : undefined, clientName: has("clientName") ? b.clientName : undefined,
    clientAddress: has("clientAddress") ? (b.clientAddress as Record<string, unknown> | null) : undefined,
    lengthIn: has("lengthIn") ? b.lengthIn : undefined, widthIn: has("widthIn") ? b.widthIn : undefined, heightIn: has("heightIn") ? b.heightIn : undefined,
    openings: has("openings") ? b.openings : undefined, styleNotes: has("styleNotes") ? b.styleNotes : undefined,
    budgetMinor: has("budget") ? moneyOrNull(b.budget) : undefined, status: has("status") ? str(b.status, 10) : undefined,
  };
}

function orderIn(b: Record<string, unknown>): trade.OrderIn {
  return {
    projectId: uuid(b.projectId), lines: b.lines ?? [], fulfillment: str(b.fulfillment, 10), pickupLocationId: uuid(b.pickupLocationId),
    shipTo: (["client", "business", "address"].includes(str(b.shipTo, 10)) ? str(b.shipTo, 10) : "address") as trade.OrderIn["shipTo"],
    address: (b.address as Record<string, unknown>) ?? null, resale: b.resale === true, certificate: str(b.certificate, 60) || null,
    payBy: str(b.payBy, 10) === "account" ? "account" : "card", paymentToken: str(b.paymentToken, 80) || null, notes: b.notes, reference: b.reference,
    cartId: str(b.cartId, 64),
  };
}
