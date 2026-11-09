// crm module -- customers, leads, tasks and marketing. See docs/MODULES.md.
//
// Back office through kit.coGet / kit.coPost. Public side, through
// kit.publicRoute: the web store's contact / request-a-quote form
// (POST /shop/<slug>/api/lead, x-erp-shop and a per-address rate limit) and
// the unsubscribe link in every campaign message (/crm/u/<token>).

import type http from "node:http";
import { pool, tx, type Client } from "../../packages/core/db.ts";
import * as crm from "../../packages/core/crm.ts";
import { siteBySlug } from "../../packages/core/shop.ts";
import { ModuleError, PublicAsset, PublicPage, requireRole, minor, str, uuid, int, type ErpModule, type Company, type Actor } from "./kit.ts";
import { rolesOf } from "../actions.ts";

const SELL = ["sales", "store_manager", "marketing"];
const MANAGE = ["store_manager"];
const MARKET = ["marketing", "web_admin"];
const REGISTER = ["cashier", "sales", "store_manager"];

const PUBLIC_BASE = () => (process.env.ERP_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/+$/, "");

async function bo<R>(fn: () => Promise<R>): Promise<R> {
  try { return await fn(); }
  catch (e) { if (crm.CRM_REFUSALS.some((K) => e instanceof K)) throw new ModuleError((e as Error).message); throw e; }
}
const scopeOf = (co: Company, a: Actor) => ({ tenantId: co.tenantId, entityId: co.id, actor: { kind: "user" as const, id: a.personId, label: a.label } });

// Per-address brake on the public form and the unsubscribe link.
const hits = new Map<string, number[]>();
export const LIMITS = { lead: { max: 6, ms: 10 * 60_000 }, unsub: { max: 30, ms: 10 * 60_000 } };
function limited(req: http.IncomingMessage, bucket: keyof typeof LIMITS) {
  const xf = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ip = xf.length ? xf[xf.length - 1] : (req.socket?.remoteAddress ?? "?");
  const { max, ms } = LIMITS[bucket]; const now = Date.now(); const key = `${bucket}:${ip}`;
  const list = (hits.get(key) ?? []).filter((t) => now - t < ms);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now); hits.set(key, list);
  if (hits.size > 20_000) for (const [k, v] of hits) if (!v.some((t) => now - t < ms)) hits.delete(k);
  return false;
}
export const _resetLimits = () => hits.clear();

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const UNSUB_JS = `(() => {
  const b = document.getElementById('go'); const out = document.getElementById('out');
  if (!b) return;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await fetch(location.pathname, { method: 'POST', headers: { 'x-erp-shop': '1', 'content-type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      out.textContent = r.ok ? d.message : (d.error || 'That did not work. Try again.');
      if (r.ok) b.hidden = true; else b.disabled = false;
    } catch (_) { out.textContent = 'Could not reach us. Try again.'; b.disabled = false; }
  });
})();`;
function unsubPage(title: string, text: string, button: boolean) {
  return new PublicPage(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style nonce="__NONCE__">body{font:17px/1.5 system-ui,sans-serif;margin:0;padding:48px 20px;color:#1d1c1a;background:#f6f3ee}main{max-width:32rem;margin:0 auto;background:#fff;border-radius:14px;padding:28px}
h1{font-size:24px;margin:0 0 10px}button{font:inherit;font-weight:650;min-height:50px;padding:0 24px;border-radius:999px;border:0;background:#23324a;color:#fff;cursor:pointer;margin-top:16px}
#out{margin-top:14px;font-weight:600}</style>
<script src="/crm/assets/unsub.js" defer></script>
<main><h1>${esc(title)}</h1><p>${esc(text)}</p>${button ? `<button id="go" type="button">Unsubscribe</button>` : ""}<p id="out" role="status"></p></main></html>`);
}

export const module: ErpModule = {
  id: "crm",
  register(kit) {
    // ===================================================== public side
    kit.publicRoute("POST", /^\/shop\/([a-z0-9][a-z0-9-]{1,39})\/api\/lead$/, async (req, _url, m, b) => {
      if (limited(req, "lead")) return [429, { error: "Too many messages from here. Wait a few minutes and try again." }];
      try {
        return await tx({ kind: "system", label: "web store lead form" }, async (c) => {
          const site = await siteBySlug(c, m[1]);
          if (!site) return [404, { error: "There is no store at this address." }] as [number, unknown];
          if (str(b.website, 100)) return [200, { ok: true, message: "Thanks — we'll be in touch soon." }] as [number, unknown];   // honeypot: bots fill it
          const kind = b.kind === "quote" ? "quote_request" : "web_form";
          const pid = uuid(b.productId);
          const store = uuid(b.pickupLocationId);
          if (pid) {
            const ok = await c.query(`select 1 from product where id = $1 and entity_id = $2 and web_visible`, [pid, site.entity_id]);
            if (!ok.rowCount) throw new crm.CrmError("That product is not on this store.");
          }
          const r = await crm.createLead(c, site.entity_id, null, {
            source: kind, name: b.name, email: b.email, phone: b.phone, interest: str(b.message, 500),
            locationId: store && site.pickup_location_ids.includes(store) ? store : null,
            items: pid ? [{ productId: pid, choices: Array.isArray(b.choices) ? b.choices.slice(0, 12) : [], qty: int(b.qty, 1) }] : [],
            utmSource: b.utmSource ?? "web store", utmMedium: b.utmMedium ?? (kind === "quote_request" ? "quote request" : "contact form"), utmCampaign: b.utmCampaign,
            consent: { email: b.consentEmail === true, sms: b.consentSms === true, source: "web store form" },
          });
          return [200, { ok: true, reference: r.number, message: "Thanks — someone from the store will be in touch within one business day." }] as [number, unknown];
        });
      } catch (e) {
        if (crm.CRM_REFUSALS.some((K) => e instanceof K)) return [422, { error: (e as Error).message }];
        throw e;
      }
    });

    kit.publicRoute("GET", /^\/crm\/assets\/unsub\.js$/, async () => [200, new PublicAsset(UNSUB_JS, "text/javascript; charset=utf-8")]);
    kit.publicRoute("GET", /^\/crm\/u\/([A-Za-z0-9_-]{20,64})$/, async (_req, _url, m) => {
      const c = await pool.connect();
      try {
        const info = await crm.unsubscribeInfo(c, m[1]);
        if (!info) return [404, unsubPage("That link has expired", "This unsubscribe link is not valid. Reply to any message and we will take you off the list.", false)];
        return [200, unsubPage(`Unsubscribe from ${info.company}`, `Stop marketing ${info.channel === "sms" ? "texts" : "emails"} from ${info.company}? Order and delivery updates still come through.`, true)];
      } finally { c.release(); }
    });
    kit.publicRoute("POST", /^\/crm\/u\/([A-Za-z0-9_-]{20,64})$/, async (req, _url, m) => {
      if (limited(req, "unsub")) return [429, { error: "Too many tries from here. Wait a few minutes." }];
      try {
        const r = await tx({ kind: "system", label: "unsubscribe link" }, (c) => crm.unsubscribe(c, m[1]));
        return [200, { ok: true, message: `Done. You won't get marketing ${r.channel === "sms" ? "texts" : "emails"} from ${r.company} any more.` }];
      } catch (e) {
        if (e instanceof crm.CrmError) return [422, { error: e.message }];
        throw e;
      }
    });

    // ===================================================== back office
    const roles = async (c: Client, co: Company, a: Actor) => rolesOf(c, co, a.personId);

    kit.coGet("/crm/lookups", async (c, co) => ({
      people: await crm.salespeople(c, co.id),
      stores: (await c.query(`select id, name, kind from location where entity_id = $1 and status = 'active' and kind in ('store','outlet') order by name`, [co.id])).rows,
      stages: crm.STAGES, sources: crm.SOURCES, lostReasons: crm.LOST_REASONS,
      categories: (await c.query(`select distinct category from product where entity_id = $1 and category is not null order by 1`, [co.id])).rows.map((r) => r.category),
      campaigns: (await c.query(`select id, name from crm_campaign where entity_id = $1 order by created_at desc`, [co.id])).rows,
    }));
    kit.coGet("/crm/dashboard", async (c, co, url) => {
      await crm.syncLeadOutcomes(c, co.id);
      return crm.dashboard(c, co.id, url.searchParams.get("days") ? Math.max(7, Math.min(730, int(url.searchParams.get("days"), 90))) : 90);
    });

    // customers
    kit.coGet("/crm/customers", (c, co, url) => {
      const s = `%${str(url.searchParams.get("q"), 80).replace(/[%_\\]/g, "")}%`;
      return c.query(`select cu.id, cu.number, cu.name, cu.email, cu.phone, cu.status, pf.tags, pf.merged_into,
          (select max(ordered_at) from sales_order so where so.entity_id = cu.entity_id and so.customer_id = cu.id and so.status not in ('draft','cancelled')) last_purchase
          from customer cu left join crm_profile pf on pf.customer_id = cu.id
         where cu.entity_id = $1 and ($2 = '%%' or cu.name ilike $2 or cu.email ilike $2 or cu.phone ilike $2 or cu.number ilike $2 or $3 = any(pf.tags))
         order by (cu.status = 'inactive'), cu.name limit 100`, [co.id, s, str(url.searchParams.get("q"), 40).toLowerCase()]).then((r) => r.rows);
    });
    // Read-only transaction: the timeline reads optional tables (service) behind savepoints.
    kit.coGet("/crm/customers/([0-9a-fA-F-]{36})", async (c, co, _url, m) => {
      await c.query("begin read only");
      try { return await crm.customer360(c, co.id, m[2]); } finally { await c.query("rollback"); }
    });
    kit.coGet("/crm/customers/([0-9a-fA-F-]{36})/duplicates", async (c, co, _url, m) => {
      const cu = (await c.query(`select name, email, phone from customer where id = $1 and entity_id = $2`, [m[2], co.id])).rows[0];
      return cu ? crm.findDuplicates(c, co.id, { email: cu.email, phone: cu.phone, name: cu.name, exceptId: m[2] }) : [];
    });
    kit.coPost("/crm/customers/([0-9a-fA-F-]{36})/profile", async (c, co, a, b, m) => {
      await requireRole(c, co, a, SELL, "updating a customer profile");
      await bo(() => crm.saveProfile(c, co.id, m[2], b));
      return { ok: true };
    });
    kit.coPost("/crm/consent", async (c, co, a, b) => {
      await requireRole(c, co, a, SELL, "recording consent");
      await bo(() => crm.recordConsent(c, co.id, uuid(b.customerId) ?? "", str(b.channel, 10) as crm.Channel, str(b.status, 10) as "opt_in", str(b.source, 60) || "staff", a.personId, str(b.evidence, 300) || null));
      return { ok: true };
    });
    kit.coPost("/crm/notes", async (c, co, a, b) => {
      await requireRole(c, co, a, SELL, "adding a note");
      await bo(() => crm.addNote(c, co.id, a.personId, { customerId: uuid(b.customerId), leadId: uuid(b.leadId), body: b.body }));
      return { ok: true };
    });
    kit.coPost("/crm/households", async (c, co, a, b) => {
      await requireRole(c, co, a, SELL, "grouping a household");
      return { id: await bo(() => crm.setHousehold(c, co.id, Array.isArray(b.customerIds) ? b.customerIds.map(String) : [], str(b.name, 80))) };
    });
    kit.coPost("/crm/relations", async (c, co, a, b) => {
      await requireRole(c, co, a, SELL, "linking related contacts");
      await bo(() => crm.relate(c, co.id, uuid(b.customerId) ?? "", uuid(b.relatedId) ?? "", str(b.relation, 40)));
      return { ok: true };
    });
    kit.coPost("/crm/merge", async (c, co, a, b) => {
      await requireRole(c, co, a, MANAGE, "merging customers");
      return bo(() => crm.mergeCustomers(c, scopeOf(co, a), uuid(b.survivorId) ?? "", uuid(b.mergedId) ?? "", str(b.reason, 300), a.personId));
    });

    // leads
    kit.coGet("/crm/leads", async (c, co, url, _m, personId) => {
      await crm.syncLeadOutcomes(c, co.id);
      return crm.leads(c, co.id, { stage: str(url.searchParams.get("stage"), 20), q: str(url.searchParams.get("q"), 80),
        assignedTo: uuid(url.searchParams.get("assignedTo")), locationId: uuid(url.searchParams.get("location")),
        mine: url.searchParams.get("mine") === "1" ? personId : null });
    });
    kit.coGet("/crm/leads/([0-9a-fA-F-]{36})", (c, co, _url, m) => crm.leadDetail(c, co.id, m[2]));
    kit.coPost("/crm/leads", async (c, co, a, b) => {
      await requireRole(c, co, a, SELL, "adding a lead");
      return bo(() => crm.createLead(c, co.id, a.personId, {
        source: str(b.source, 20), name: b.name, email: b.email, phone: b.phone, interest: b.interest, locationId: uuid(b.locationId),
        assignedTo: uuid(b.assignedTo), utmSource: b.utmSource, utmMedium: b.utmMedium, utmCampaign: b.utmCampaign, campaignId: uuid(b.campaignId),
        referredBy: uuid(b.referredBy), estimateMinor: b.estimate ? minor(b.estimate) : 0n, customerId: uuid(b.customerId),
        items: Array.isArray(b.items) ? (b.items as { productId: string }[]) : [],
        consent: { email: b.consentEmail === true, sms: b.consentSms === true, source: "in store, recorded by staff" },
      }));
    });
    kit.coPost("/crm/leads/([0-9a-fA-F-]{36})/stage", async (c, co, a, b, m) => {
      await requireRole(c, co, a, SELL, "moving a lead");
      await bo(() => crm.moveLead(c, co.id, a.personId, m[2], str(b.stage, 20), { lostReason: b.lostReason, followUpAt: str(b.followUpAt, 40) || null }));
      return { ok: true };
    });
    kit.coPost("/crm/leads/([0-9a-fA-F-]{36})/assign", async (c, co, a, b, m) => {
      await requireRole(c, co, a, MANAGE, "reassigning a lead");
      await bo(() => crm.assignLead(c, co.id, a.personId, m[2], uuid(b.assignedTo) ?? ""));
      return { ok: true };
    });
    kit.coPost("/crm/leads/([0-9a-fA-F-]{36})/convert", async (c, co, a, b, m) => {
      await requireRole(c, co, a, ["sales", "store_manager"], "turning a lead into a customer and a quote");
      return bo(async () => crm.convertLead(c, scopeOf(co, a), await roles(c, co, a), m[2], { locationId: uuid(b.locationId), useCustomerId: uuid(b.customerId) }));
    });
    kit.coPost("/crm/leads/([0-9a-fA-F-]{36})/link", async (c, co, a, b, m) => {
      await requireRole(c, co, a, SELL, "linking an order to a lead");
      await bo(() => crm.linkOrder(c, co.id, a.personId, m[2], str(b.orderNumber, 30)));
      return { ok: true };
    });
    kit.coPost("/crm/leads/capture-carts", async (c, co, a) => {
      await requireRole(c, co, a, SELL, "pulling in abandoned carts");
      return { added: await crm.captureAbandonedCarts(c, co.id) };
    });
    kit.coGet("/crm/rules", (c, co) => c.query(`select r.id, r.name, r.location_id, r.source, r.members, r.next_index, r.active, l.name store,
        (select array_agg(u.name order by array_position(r.members, u.id)) from app_user u where u.id = any(r.members)) member_names
        from crm_assignment_rule r left join location l on l.id = r.location_id where r.entity_id = $1 order by r.active desc, r.name`, [co.id]).then((r) => r.rows));
    kit.coPost("/crm/rules", async (c, co, a, b) => {
      await requireRole(c, co, a, MANAGE, "setting lead assignment");
      return { id: await bo(() => crm.saveRule(c, co.id, { id: uuid(b.id), name: b.name, locationId: uuid(b.locationId), source: str(b.source, 20) || null,
        members: Array.isArray(b.members) ? b.members.map(String) : [], active: b.active !== false })) };
    });

    // tasks
    kit.coGet("/crm/my-day", async (c, co, url, _m, personId) => {
      const who = uuid(url.searchParams.get("person")) ?? personId;
      if (!who) throw new ModuleError("Pick who you are acting as to see their day.");
      return crm.myDay(c, co.id, who);
    });
    kit.coPost("/crm/tasks", async (c, co, a, b) => {
      await requireRole(c, co, a, SELL, "adding a task");
      return { id: await bo(() => crm.createTask(c, co.id, a.personId, { assignedTo: uuid(b.assignedTo) ?? a.personId, kind: str(b.kind, 20), title: b.title,
        dueAt: str(b.dueAt, 40), endsAt: str(b.endsAt, 40) || null, locationId: uuid(b.locationId), customerId: uuid(b.customerId), leadId: uuid(b.leadId), notes: b.notes })) };
    });
    kit.coPost("/crm/tasks/([0-9a-fA-F-]{36})/(done|cancel)", async (c, co, a, b, m) => {
      await requireRole(c, co, a, SELL, "closing a task");
      await bo(() => crm.completeTask(c, co.id, a.personId, m[2], b.outcome, m[3] === "cancel"));
      return { ok: true };
    });

    // marketing
    kit.coGet("/crm/segments", (c, co) => crm.segments(c, co.id));
    kit.coPost("/crm/segments/preview", async (c, co, _a, b) => {
      const members = await bo(async () => crm.segmentMembers(c, co.id, crm.parseFilter(b.filter)));
      return { count: members.length, sample: members.slice(0, 20) };
    });
    kit.coPost("/crm/segments", async (c, co, a, b) => {
      await requireRole(c, co, a, MARKET, "saving a segment");
      return { id: await bo(() => crm.saveSegment(c, co.id, a.personId, { id: uuid(b.id), name: b.name, filter: b.filter })) };
    });
    kit.coGet("/crm/campaigns", (c, co) => crm.campaignResults(c, co.id));
    kit.coGet("/crm/campaigns/([0-9a-fA-F-]{36})", async (c, co, _url, m) => {
      const k = (await c.query(`select * from crm_campaign where id = $1 and entity_id = $2`, [m[2], co.id])).rows[0];
      if (!k) return null;
      const msgs = (await c.query(`select m.to_ref, m.status, m.reason, m.send_after, m.sent_at, cu.name from crm_message m left join customer cu on cu.id = m.customer_id
         where m.entity_id = $1 and m.campaign_id = $2 order by m.status, cu.name limit 500`, [co.id, m[2]])).rows;
      return { campaign: k, messages: msgs };
    });
    kit.coPost("/crm/campaigns", async (c, co, a, b) => {
      await requireRole(c, co, a, MARKET, "writing a campaign");
      return { id: await bo(() => crm.saveCampaign(c, co.id, a.personId, { id: uuid(b.id), name: b.name, channel: str(b.channel, 10), segmentId: uuid(b.segmentId) ?? "",
        subject: b.subject, body: b.body, costMinor: b.cost ? minor(b.cost) : 0n, scheduledAt: str(b.scheduledAt, 40) || null })) };
    });
    kit.coPost("/crm/campaigns/([0-9a-fA-F-]{36})/launch", async (c, co, a, _b, m) => {
      await requireRole(c, co, a, MARKET, "sending a campaign");
      const r = await bo(() => crm.launchCampaign(c, co.id, m[2], PUBLIC_BASE()));
      const sent = await crm.processQueue(c, co.id);
      return { ...r, ...sent };
    });
    kit.coPost("/crm/queue/run", async (c, co, a) => {
      await requireRole(c, co, a, MARKET, "sending what is due");
      return crm.processQueue(c, co.id);
    });
    kit.coGet("/crm/coupons", (c, co) => crm.coupons(c, co.id));
    kit.coPost("/crm/coupons", async (c, co, a, b) => {
      await requireRole(c, co, a, MARKET, "making a coupon");
      return { id: await bo(() => crm.saveCoupon(c, co.id, a.personId, { code: b.code, campaignId: uuid(b.campaignId), kind: str(b.kind, 10),
        pctBps: b.percent != null && b.percent !== "" ? Math.round(Number(b.percent) * 100) : null, amountMinor: b.amount ? minor(b.amount) : null,
        minSpendMinor: b.minSpend ? minor(b.minSpend) : 0n, startsOn: str(b.startsOn, 10), endsOn: str(b.endsOn, 10),
        maxUses: b.maxUses ? int(b.maxUses) : null, oncePerCustomer: b.oncePerCustomer !== false,
        channels: Array.isArray(b.channels) ? b.channels.map(String) : undefined })) };
    });
    kit.coPost("/crm/coupons/([0-9a-fA-F-]{36})/end", async (c, co, a, _b, m) => {
      await requireRole(c, co, a, MARKET, "ending a coupon");
      await bo(() => crm.endCoupon(c, co.id, m[2]));
      return { ok: true };
    });
    // The register checks a code and, once the discount is on the sale, records it against the order.
    kit.coPost("/crm/coupons/check", async (c, co, a, b) => {
      await requireRole(c, co, a, REGISTER, "checking a coupon");
      const r = await bo(() => crm.checkCoupon(c, co.id, b.code, { channel: "pos", subtotalMinor: minor(b.subtotal ?? 0), customerId: uuid(b.customerId) }));
      return { code: r.code, label: r.label, discountMinor: r.discountMinor };
    });
    kit.coPost("/crm/coupons/redeem", async (c, co, a, b) => {
      await requireRole(c, co, a, REGISTER, "redeeming a coupon");
      return bo(() => crm.redeemCoupon(c, co.id, a.personId, { code: b.code, orderId: uuid(b.orderId) ?? "", channel: "pos" }));
    });
  },
};
