// service module -- service and repair tickets, coverage, parts, visits,
// claims, billing and the department dashboard. See docs/MODULES.md.
//
// Who does what (owner passes every check):
//   sales, cashier, ar_clerk         open tickets (from the counter or the phone)
//   store_manager, dispatcher        triage, assign, parts, schedule, resolve, close
//   store_manager                    goodwill against the rules, $0 replacements, credits/refunds
//   technician                       their own tickets and visits; notes, parts, finishing a visit
//   buyer                            orders the parts
//   store_manager, controller        costs entered by hand
// The public "request service" form is the only door without a sign-in.

import type http from "node:http";
import { tx, type Scope } from "../../packages/core/db.ts";
import * as S from "../../packages/core/service.ts";
import * as fleet from "../../packages/core/fleet.ts";
import { siteBySlug } from "../../packages/core/shop.ts";
import { enabledModules } from "../../packages/core/setup.ts";
import { InventoryError } from "../../packages/core/inventory.ts";
import { ArError } from "../../packages/core/ar.ts";
import { PostingError } from "../../packages/core/posting.ts";
import { rolesOf } from "../actions.ts";
import { ModuleError, PublicPage, PublicAsset, need, requireRole, minor, str, uuid, int,
  type ErpModule, type Client, type Company, type Actor } from "./kit.ts";

const ID = "([0-9a-fA-F-]{36})";
const SLUG = "([a-z0-9][a-z0-9-]{1,39})";

const OPENERS = ["sales", "cashier", "ar_clerk", "store_manager", "dispatcher", "technician"];
const DESK = ["store_manager", "dispatcher"];
const HANDS = ["store_manager", "dispatcher", "technician"];
const STAFF = ["owner", "store_manager", "dispatcher", "sales", "cashier", "ar_clerk", "controller", "buyer", "warehouse", "viewer"];

const scopeOf = (co: Company, a: Actor): Scope => ({ tenantId: co.tenantId, entityId: co.id, actor: { kind: "user", id: a.personId, label: a.label } });

async function plain<R>(fn: () => Promise<R>): Promise<R> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof S.ServiceError || e instanceof fleet.FleetError || e instanceof InventoryError || e instanceof ArError || e instanceof PostingError) {
      throw new ModuleError(e.message);
    }
    throw e;
  }
}

/** Reads: the operator's token sees what the owner sees; a technician alone sees only their own tickets. */
async function viewer(c: Client, co: Company, personId: string | null) {
  if (!personId) return { personId: null as string | null, staff: true, held: new Set(["owner"]) };
  const held = await rolesOf(c, co, personId);
  const staff = STAFF.some((r) => held.has(r));
  need(staff || held.has("technician"), "the service desk is for store staff and technicians");
  return { personId, staff, held };
}
async function techMaySee(c: Client, co: Company, v: { personId: string | null; staff: boolean }, ticketId: string) {
  if (v.staff) return;
  const r = await c.query(`select 1 from service_ticket t where t.entity_id = $1 and t.id = $2 and (t.technician_id = $3
      or exists (select 1 from service_visit sv join delivery_stop s on s.id = sv.stop_id join delivery_route r on r.id = s.route_id
                  where sv.ticket_id = t.id and (r.driver_id = $3 or r.helper_id = $3)))`, [co.id, ticketId, v.personId]);
  need(r.rowCount, "that ticket is not one of yours");
}

function clientIp(req: http.IncomingMessage): string {
  const f = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return f || req.socket?.remoteAddress || "unknown";
}

const money = (v: unknown) => (v === undefined || v === null || v === "" ? null : minor(v));

export const module: ErpModule = {
  id: "service",
  register({ coGet, coPost, publicRoute }) {
    // ------------------------------------------------------------- reads
    coGet("/service/home", async (c, co, _u, _m, p) => {
      const v = await viewer(c, co, p);
      need(v.staff, "the service dashboard is for store staff");
      return plain(() => S.dashboard(c, co.id));
    });
    coGet("/service/options", async (c, co, _u, _m, p) => {
      await viewer(c, co, p);
      const run = async (sql: string, args: unknown[]) => (await c.query(sql, args));
      const [techs, providers, charges, sessions, zones] = [
        await run(`select distinct u.id, u.name from app_user u join role_grant g on g.app_user_id = u.id and g.role = 'technician'
                  and (g.entity_id = $1 or (g.entity_id is null and u.tenant_id = $2)) where u.status = 'active' order by u.name`, [co.id, co.tenantId]),
        await run(`select id, name, phone, hourly_rate_minor::text hourly_rate_minor from service_provider where entity_id = $1 and active order by name`, [co.id]),
        await run(`select id, sku, name, price_minor::text price_minor from product where entity_id = $1 and kind in ('service','fee') and status <> 'discontinued' order by name`, [co.id]),
        await run(`select s.id, s.number, l.name location from pos_session s join location l on l.id = s.location_id where s.entity_id = $1 and s.status = 'open' order by s.opened_at desc`, [co.id]),
        await run(`select id, code, name from delivery_zone where entity_id = $1 and active order by code`, [co.id]),
      ];
      return { technicians: techs.rows, providers: providers.rows, charges: charges.rows, sessions: sessions.rows, zones: zones.rows,
        issueTypes: S.ISSUE_TYPES.map((k) => [k, S.ISSUE_LABEL[k]]), priorities: S.PRIORITIES, coverages: S.COVERAGES, resolutions: S.RESOLUTIONS, outcomes: S.OUTCOMES };
    });
    coGet("/service/tickets", async (c, co, url, _m, p) => {
      const v = await viewer(c, co, p);
      return plain(() => S.tickets(c, co.id, { status: str(url.searchParams.get("status"), 20) || "open", q: str(url.searchParams.get("q"), 60),
        technicianId: v.staff ? (uuid(url.searchParams.get("tech")) ?? null) : v.personId }));
    });
    coGet(`/service/tickets/${ID}`, async (c, co, _u, m, p) => {
      const v = await viewer(c, co, p);
      await techMaySee(c, co, v, m[2]);
      return plain(() => S.ticket(c, co.id, m[2]));
    });
    coGet("/service/customers", async (c, co, url, _m, p) => {
      const v = await viewer(c, co, p);
      need(v.staff || v.held.has("technician"), "looking up customers is for store staff");
      return plain(() => S.customerLookup(c, co.id, str(url.searchParams.get("q"), 60)));
    });
    coGet("/service/parts", async (c, co, url, _m, p) => {
      await viewer(c, co, p);
      const term = str(url.searchParams.get("q"), 60);
      need(term.length >= 2, "type at least two letters of the part name or SKU");
      const r = await c.query(`
        select p.id, p.sku, p.name, p.price_minor::text price_minor, coalesce(v.dba, v.legal_name) vendor,
               coalesce((select sum(s.on_hand - s.reserved) from stock_level s where s.entity_id = p.entity_id and s.product_id = p.id), 0)::float available
          from product p left join vendor v on v.id = p.vendor_id
         where p.entity_id = $1 and p.kind in ('stock','configurable','special_order') and p.status <> 'discontinued'
           and (p.name ilike '%' || $2 || '%' or p.sku ilike '%' || $2 || '%') order by (p.category = 'Parts') desc, p.name limit 25`, [co.id, term]);
      return r.rows;
    });
    coGet("/service/settings", async (c, co, _u, _m, p) => {
      const v = await viewer(c, co, p);
      need(v.staff, "service settings are for store staff");
      return plain(() => S.rules(c, co.id));
    });

    // ----------------------------------------------------------- opening
    coPost("/service/tickets", async (c, co, a, b) => {
      await requireRole(c, co, a, OPENERS, "opening a service ticket");
      return plain(() => S.openTicket(c, scopeOf(co, a), {
        source: str(b.source, 20) || "phone", customerId: uuid(b.customerId), addressId: uuid(b.addressId), orderId: uuid(b.orderId), lineId: uuid(b.lineId),
        pieceLabel: str(b.pieceLabel, 40) || null, productId: uuid(b.productId), contactName: str(b.contactName, 120), contactPhone: str(b.contactPhone, 40),
        contactEmail: str(b.contactEmail, 160), issueType: str(b.issueType, 30), description: str(b.description, 4000), photos: b.photos,
        priority: str(b.priority, 10) || undefined }));
    });
    coPost(`/service/tickets/from-stop/${ID}`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, [...OPENERS, "warehouse", "driver"], "opening a ticket from a delivery");
      return plain(() => S.fromDeliveryException(c, scopeOf(co, a), m[2]));
    });

    // ----------------------------------------------------------- the desk
    coPost(`/service/tickets/${ID}/triage`, async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, DESK, "triaging a ticket");
      return plain(() => S.triage(c, scopeOf(co, a), held, m[2], { coverage: str(b.coverage, 20) || undefined, note: str(b.note, 1000),
        priority: str(b.priority, 10) || undefined, technicianId: b.technicianId === undefined ? undefined : uuid(b.technicianId),
        providerId: b.providerId === undefined ? undefined : uuid(b.providerId) }));
    });
    coPost(`/service/tickets/${ID}/assign`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, DESK, "assigning a ticket");
      return plain(() => S.assign(c, scopeOf(co, a), m[2], { technicianId: uuid(b.technicianId), providerId: uuid(b.providerId) }));
    });
    coPost(`/service/tickets/${ID}/note`, async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, [...OPENERS], "adding a note");
      if (!STAFF.some((r) => held.has(r))) await techMaySee(c, co, { personId: a.personId, staff: false }, m[2]);
      return plain(() => S.addNote(c, scopeOf(co, a), m[2], str(b.note, 1000), b.photos));
    });
    coPost(`/service/tickets/${ID}/status`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, DESK, "moving a ticket along");
      return plain(() => S.setStatus(c, scopeOf(co, a), m[2], str(b.status, 20), str(b.note, 500)));
    });
    coPost(`/service/tickets/${ID}/parts`, async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, HANDS, "adding a part");
      if (!STAFF.some((r) => held.has(r))) await techMaySee(c, co, { personId: a.personId, staff: false }, m[2]);
      return plain(() => S.addPart(c, scopeOf(co, a), held, m[2], { productId: str(b.productId, 40), qty: Number(b.qty ?? 1), kind: str(b.kind, 20), reason: str(b.reason, 500) }));
    });
    coPost(`/service/tickets/${ID}/parts/order`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, [...DESK, "buyer"], "ordering parts");
      return plain(() => S.orderParts(c, scopeOf(co, a), m[2]));
    });
    coPost(`/service/tickets/${ID}/charges`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, HANDS, "adding a charge");
      return plain(() => S.addCharge(c, scopeOf(co, a), m[2], { productId: str(b.productId, 40), qty: Number(b.qty ?? 1), priceMinor: money(b.price) }));
    });
    coPost(`/service/tickets/${ID}/lines/${ID}/cancel`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, DESK, "taking a part or charge off");
      return plain(() => S.cancelLine(c, scopeOf(co, a), m[2], m[3], str(b.reason, 500)));
    });
    coPost(`/service/tickets/${ID}/invoice`, async (c, co, a, _b, m) => {
      await requireRole(c, co, a, [...DESK, "cashier", "ar_clerk"], "invoicing service charges");
      return plain(() => S.invoiceCharges(c, scopeOf(co, a), m[2]));
    });
    coPost(`/service/tickets/${ID}/visits`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, DESK, "booking a service visit");
      return plain(() => S.scheduleVisit(c, scopeOf(co, a), m[2], { kind: str(b.kind, 10), day: str(b.day, 10) || undefined, windowId: uuid(b.windowId) ?? undefined,
        providerId: uuid(b.providerId), notes: str(b.notes, 500), allowToday: true, override: str(b.override, 300) }));
    });
    coPost(`/service/visits/${ID}/complete`, async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, [...HANDS, "driver"], "finishing a service visit");
      const staff = DESK.some((r) => held.has(r)) || held.has("owner");
      if (!staff) {
        const r = await c.query(`select 1 from service_visit sv join delivery_stop s on s.id = sv.stop_id join delivery_route r on r.id = s.route_id
           where sv.entity_id = $1 and sv.id = $2 and (r.driver_id = $3 or r.helper_id = $3)`, [co.id, m[2], a.personId]);
        need(r.rowCount, "that visit is on another technician's route");
      }
      return plain(() => S.completeVisit(c, scopeOf(co, a), m[2], {
        outcome: str(b.outcome, 20), workNotes: str(b.workNotes, 2000), minutes: b.minutes == null || b.minutes === "" ? 0 : int(b.minutes, -1),
        partsUsed: Array.isArray(b.partsUsed) ? b.partsUsed.map(String) : [], recipient: str(b.recipient, 120),
        signature: typeof b.signature === "string" ? b.signature : undefined, photos: Array.isArray(b.photos) ? b.photos.map(String) : [],
        thirdPartyCostMinor: money(b.thirdPartyCost) }));
    });
    coPost(`/service/tickets/${ID}/costs`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, ["store_manager", "controller"], "entering a service cost");
      const amt = money(b.amount);
      need(amt != null, "give the amount");
      return plain(() => S.addCost(c, scopeOf(co, a), m[2], { kind: str(b.kind, 20), amountMinor: amt, chargeTo: str(b.chargeTo, 20) || undefined, note: str(b.note, 300) }));
    });
    coPost(`/service/tickets/${ID}/resolve`, async (c, co, a, b, m) => {
      const held = await requireRole(c, co, a, DESK, "resolving a ticket");
      const tenders = Array.isArray(b.tenders) ? (b.tenders as Record<string, unknown>[]).map((t) => ({ method: str(t.method, 20), amountMinor: minor(t.amount),
        reference: str(t.reference, 40) || null })) : [];
      return plain(() => S.resolve(c, scopeOf(co, a), held, m[2], { type: str(b.type, 30), note: str(b.note, 1000), sessionId: uuid(b.sessionId),
        qty: Number(b.qty ?? 1), tenders }));
    });
    coPost(`/service/tickets/${ID}/close`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, DESK, "closing a ticket");
      return plain(() => S.closeTicket(c, scopeOf(co, a), m[2], str(b.note, 500)));
    });
    coPost(`/service/tickets/${ID}/claims`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, ["store_manager", "buyer"], "filing a vendor claim");
      const amt = money(b.amount);
      need(amt != null, "give the amount claimed");
      return plain(() => S.fileClaim(c, scopeOf(co, a), m[2], { amountMinor: amt, vendorRef: str(b.vendorRef, 60) || undefined, photos: b.photos }));
    });
    coPost(`/service/tickets/${ID}/claims/${ID}`, async (c, co, a, b, m) => {
      await requireRole(c, co, a, ["store_manager", "buyer"], "updating a vendor claim");
      return plain(() => S.updateClaim(c, scopeOf(co, a), m[2], m[3], { status: str(b.status, 20), creditMinor: money(b.credit),
        resolution: str(b.resolution, 500) || undefined, vendorRef: str(b.vendorRef, 60) || undefined }));
    });
    coPost("/service/rules", async (c, co, a, b) => {
      await requireRole(c, co, a, ["store_manager"], "setting warranty rules");
      return plain(() => S.saveRule(c, scopeOf(co, a), { vendorId: uuid(b.vendorId), category: str(b.category, 80) || null, months: Number(b.months),
        covers: Array.isArray(b.covers) ? b.covers.map(String) : undefined, note: str(b.note, 300) }));
    });
    coPost("/service/providers", async (c, co, a, b) => {
      await requireRole(c, co, a, ["store_manager"], "setting up a service company");
      return plain(() => S.saveProvider(c, scopeOf(co, a), { id: uuid(b.id) ?? undefined, name: str(b.name, 120), phone: str(b.phone, 40), email: str(b.email, 160),
        hourlyRateMinor: money(b.hourlyRate), active: b.active !== false }));
    });

    // ------------------------------------------------- the public request form
    const company = async (c: Client, slug: string) => {
      const site = await siteBySlug(c, slug);
      if (!site) return null;
      const mods = await enabledModules(c, site.entity_id);
      if (!(mods as string[]).includes("service")) return null;
      const e = (await c.query<{ tenant_id: string; name: string }>(`select tenant_id, name from entity where id = $1 /* unscoped: the site's own company */`, [site.entity_id])).rows[0];
      return { entityId: site.entity_id, tenantId: e.tenant_id, name: site.display_name ?? e.name };
    };
    const NOT_HERE: [number, unknown] = [404, { error: "There is no service request form here." }];
    publicRoute("GET", /^\/service-request\/assets\/form\.js$/, async () => [200, new PublicAsset(FORM_JS, "text/javascript; charset=utf-8")]);
    publicRoute("GET", new RegExp(`^/service-request/${SLUG}/?$`), async (_req, _url, m) => {
      const ok = await tx({ kind: "system", label: "service request form" }, (c) => company(c, m[1]));
      if (!ok) return NOT_HERE;
      return [200, new PublicPage(FORM_HTML.replaceAll("__SLUG__", m[1]).replaceAll("__NAME__", esc(ok.name)))];
    });
    publicRoute("GET", new RegExp(`^/service-request/${SLUG}/api/info$`), async (_req, _url, m) => {
      const ok = await tx({ kind: "system", label: "service request form" }, (c) => company(c, m[1]));
      if (!ok) return NOT_HERE;
      return [200, { company: ok.name, issueTypes: S.ISSUE_TYPES.map((k) => [k, S.ISSUE_LABEL[k]]),
        maxPhotos: 5 }];
    });
    publicRoute("POST", new RegExp(`^/service-request/${SLUG}/api/request$`), async (req, _url, m, body) => {
      return tx({ kind: "system", label: "web service request" }, async (c) => {
        const ok = await company(c, m[1]);
        if (!ok) return NOT_HERE;
        const scope: Scope = { tenantId: ok.tenantId, entityId: ok.entityId, actor: { kind: "system", label: "web service request" } };
        return [200, await plain(() => S.webRequest(c, scope, clientIp(req), body))] as [number, unknown];
      });
    });
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

// A plain, phone-first page. Its script is served from our own origin (CSP
// script-src 'self'); its one style block carries the response's nonce.
const FORM_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Request service · __NAME__</title>
<style nonce="__NONCE__">
:root{--ink:#1d2433;--soft:#5b6475;--line:#d9dde5;--brand:#23324a;--bg:#f6f7f9}
*{box-sizing:border-box}body{margin:0;font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
main{max-width:640px;margin:0 auto;padding:20px 16px 48px}h1{font-size:24px;margin:8px 0 4px}p.sub{color:var(--soft);margin:0 0 18px}
form{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px}
label{display:block;margin:0 0 14px}label>span{display:block;font-weight:650;font-size:14px;margin-bottom:6px}
input,select,textarea{width:100%;font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:#fff}
textarea{min-height:120px}.row{display:grid;grid-template-columns:1fr;gap:0 12px}@media(min-width:560px){.row{grid-template-columns:1fr 1fr}}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
button{width:100%;min-height:50px;font:inherit;font-weight:700;border:0;border-radius:12px;background:var(--brand);color:#fff;cursor:pointer}
button:disabled{opacity:.6}.msg{margin:14px 0 0;padding:12px 14px;border-radius:10px;display:none}.msg.ok{display:block;background:#e7f5ec}
.msg.err{display:block;background:#fdecec}.thumbs{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.thumbs span{font-size:13px;color:var(--soft)}
small{color:var(--soft)}
</style></head><body><main>
<h1>Request service</h1><p class="sub">__NAME__ · Tell us what is wrong and we will call to set up the next step.</p>
<form id="f" data-slug="__SLUG__" novalidate>
<div class="row"><label><span>Your name</span><input name="name" autocomplete="name" required maxlength="120"></label>
<label><span>Phone</span><input name="phone" type="tel" autocomplete="tel" maxlength="40"></label></div>
<div class="row"><label><span>Email</span><input name="email" type="email" autocomplete="email" maxlength="160"></label>
<label><span>ZIP code</span><input name="postal" inputmode="numeric" autocomplete="postal-code" maxlength="10"></label></div>
<label><span>Order number <small>(on your receipt, if you have it)</small></span><input name="orderNumber" maxlength="30" placeholder="SO-000123"></label>
<label><span>What kind of problem</span><select name="issueType" id="issue"></select></label>
<label><span>What is wrong</span><textarea name="description" maxlength="2000" required placeholder="Which piece, what happened, and since when."></textarea></label>
<label><span>Photos <small>(up to 5)</small></span><input type="file" id="photos" accept="image/*" multiple><div class="thumbs" id="thumbs"></div></label>
<label class="hp" aria-hidden="true"><span>Website</span><input name="website" tabindex="-1" autocomplete="off"></label>
<button id="go" type="submit">Send request</button>
<div class="msg" id="msg" role="status"></div>
</form></main><script src="/service-request/assets/form.js" defer></script></body></html>`;

const FORM_JS = `(() => {
  'use strict';
  const f = document.getElementById('f'), msg = document.getElementById('msg'), go = document.getElementById('go');
  const slug = f.dataset.slug, started = Date.now(), photos = [];
  const say = (cls, text) => { msg.className = 'msg ' + cls; msg.textContent = text; };
  fetch('/service-request/' + slug + '/api/info').then((r) => r.json()).then((d) => {
    const sel = document.getElementById('issue');
    for (const [v, label] of d.issueTypes || []) { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.append(o); }
  }).catch(() => {});
  const shrink = (file) => new Promise((ok, bad) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, 1400 / Math.max(img.width, img.height)); const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url); ok(cv.toDataURL('image/jpeg', 0.8)); };
    img.onerror = () => bad(new Error('That file is not a picture.')); img.src = url;
  });
  document.getElementById('photos').addEventListener('change', async (e) => {
    const t = document.getElementById('thumbs');
    for (const file of [...e.target.files].slice(0, 5 - photos.length)) {
      try { photos.push(await shrink(file)); const s = document.createElement('span'); s.textContent = '✓ ' + file.name; t.append(s); }
      catch (err) { say('err', err.message); }
    }
    e.target.value = '';
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f).entries());
    body.photos = photos; body.elapsedMs = Date.now() - started;
    go.disabled = true; go.textContent = 'Sending…';
    try {
      const r = await fetch('/service-request/' + slug + '/api/request', { method: 'POST', headers: { 'content-type': 'application/json', 'x-erp-shop': '1' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Something went wrong; please call the store.');
      f.querySelectorAll('input,select,textarea').forEach((x) => { x.disabled = true; });
      say('ok', d.number ? 'Thank you. Your request number is ' + d.number + '. We will call you within one business day.' : 'Thank you. We have your request and will call you within one business day.');
      go.hidden = true;
    } catch (err) { say('err', err.message.charAt(0).toUpperCase() + err.message.slice(1)); go.disabled = false; go.textContent = 'Send request'; }
  });
})();`;
