// Tear sheets: a printable, photo-rich page for a quote (or any order) and
// for one product. Rendered on the server as plain HTML with no script at
// all, styled by one nonce'd style block, with @media print rules. Photos come
// through the catalog's own same-origin image cache and are embedded as data
// URLs, which the page's policy (img-src 'self' data:) allows.
//
// Staff open them from the order view or the catalog (signed in). A customer
// gets a link with a random token (only its hash is kept), sent through the
// customer message channel; the token is the only key and opens that one
// sheet, read only, until it expires or is replaced.
import { createHash, randomBytes } from "node:crypto";
import type { Client, Scope } from "../../packages/core/db.ts";
import { q, one, audit } from "../../packages/core/db.ts";
import * as cat from "../../packages/core/catalog.ts";
import { messageCustomer } from "../../packages/core/fleet.ts";
import { PublicPage } from "./kit.ts";

export class SheetError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new SheetError(msg); };

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!));
const usd = (m: bigint | string | number) => { const n = BigInt(m); const neg = n < 0n; const a = neg ? -n : n;
  return `${neg ? "-" : ""}$${(a / 100n).toLocaleString("en-US")}.${String(a % 100n).padStart(2, "0")}`; };
const day = (s: string | null | undefined) => {
  if (!s) return "";
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** How photos are fetched when the cache has none: the catalog's own (the checks hand in a fake). */
export type SheetEnv = { imageFetch?: cat.ImageFetch; maxPhotos?: number };

async function photo(c: Client, entityId: string, productId: string, seq: number, env: SheetEnv): Promise<string | null> {
  try { return (await cat.productImage(c, entityId, productId, seq, env.imageFetch))?.dataUrl ?? null; }
  catch { return null; }   // a photo that cannot be had leaves a plain card, never a broken page
}

const DIM_KEYS = /^(width|depth|height|length|seat_height|seat_depth|arm_height|dimensions|w|d|h)$/i;
function dimensions(p: { attributes: Record<string, unknown> | null; cubic_ft: string | null; weight_lb: string | null }): string {
  const a = p.attributes ?? {};
  const out: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    if (!DIM_KEYS.test(k) || v == null || typeof v === "object") continue;
    const label = k.length === 1 ? { w: "W", d: "D", h: "H" }[k.toLowerCase()]! : k.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase());
    out.push(`${label} ${v}${/^\d+(\.\d+)?$/.test(String(v)) ? '"' : ""}`);
  }
  if (p.weight_lb) out.push(`${Number(p.weight_lb)} lb`);
  if (p.cubic_ft) out.push(`${Number(p.cubic_ft)} cu ft`);
  return out.join(" · ");
}

const STYLE = `
*{box-sizing:border-box}
body{font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d232b;margin:0;background:#f4f2ee}
.page{max-width:920px;margin:0 auto;padding:20px 16px 40px;background:#fff}
header{display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1d232b;padding-bottom:12px;margin-bottom:16px}
header h1{font-size:24px;margin:0}
header .co{font-weight:700;font-size:18px}
.muted{color:#5b6470;font-size:13.5px}
.who{display:flex;flex-wrap:wrap;gap:6px 24px;margin:0 0 16px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:14px}
.card{border:1px solid #dcd8d0;border-radius:12px;overflow:hidden;background:#fff;break-inside:avoid;page-break-inside:avoid;display:flex;flex-direction:column}
.card .ph{aspect-ratio:4/3;background:#eeeae3;display:grid;place-items:center;color:#8a8f96;font-size:13px}
.card .ph img{width:100%;height:100%;object-fit:cover;display:block}
.card .bd{padding:10px 12px 12px;display:flex;flex-direction:column;gap:4px;flex:1}
.card .nm{font-weight:650;font-size:16px}
.card .opts{margin:2px 0 0;padding:0;list-style:none;font-size:13.5px}
.card .opts li{margin:1px 0}
.row{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.row .amt{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.price{font-size:18px;font-weight:700}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,200px),1fr));gap:10px;margin-bottom:14px}
.gallery img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:10px;border:1px solid #dcd8d0}
.totals{margin:18px 0 0 auto;max-width:340px;border-top:1px solid #dcd8d0;padding-top:8px}
.totals .row{padding:3px 0}
.totals .grand{font-weight:750;font-size:17px;border-top:1px solid #1d232b;margin-top:4px;padding-top:6px}
.note{margin-top:18px;padding:10px 12px;border-radius:10px;background:#f6f3ec;font-size:14px}
footer{margin-top:22px;border-top:1px solid #dcd8d0;padding-top:10px;font-size:13px;color:#5b6470}
.groups{margin:6px 0 0;padding:0;list-style:none}
.groups li{margin:4px 0}
@media print{
  body{background:#fff;font-size:12pt}
  .page{max-width:none;padding:0}
  .noprint{display:none}
  .cards{grid-template-columns:repeat(2,1fr)}
  a{color:inherit;text-decoration:none}
  @page{margin:12mm}
}`;

function shell(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style nonce="__NONCE__">${STYLE}</style></head>
<body><main class="page">${body}</main></body></html>`;
}

type Store = { name: string; address: Record<string, string> | null; company: string };
function storeBlock(s: Store) {
  const a = s.address ?? {};
  return [s.name, a.line1, a.city ? `${a.city}, ${a.state ?? ""} ${a.postal ?? ""}`.trim() : null, a.phone].filter(Boolean).map(esc).join(" · ");
}

/** A quote's (or order's) tear sheet. */
export async function orderSheet(c: Client, entityId: string, orderId: string, env: SheetEnv = {}): Promise<string | null> {
  const h = (await q<{ number: string; kind: string | null; status: string; ordered_at: string; quote_expires_on: string | null;
    subtotal_minor: string; discount_minor: string; tax_minor: string; total_minor: string; paid_minor: string; customer: string | null; location: string;
    address: Record<string, string> | null; company: string; salesperson: string | null; tax_exempt_ref: string | null }>(c, `
    select so.number, po.kind, so.status, so.ordered_at, po.quote_expires_on::text, so.subtotal_minor, so.discount_minor, so.tax_minor, so.total_minor,
           so.paid_minor, cu.name customer, l.name location, l.address, e.name company, u.name salesperson, po.tax_exempt_ref
      from sales_order so join location l on l.id = so.location_id join entity e on e.id = so.entity_id
      left join pos_order po on po.sales_order_id = so.id left join customer cu on cu.id = so.customer_id left join app_user u on u.id = so.salesperson_id
     where so.id = $1 and so.entity_id = $2`, [orderId, entityId]))[0];
  if (!h) return null;
  const lines = await q<{ id: string; product_id: string | null; description: string; qty: string; unit_price_minor: string; discount_minor: string;
    config: Record<string, { label: string }[]> | null; kind: string | null; name: string | null; attributes: Record<string, unknown> | null; cubic_ft: string | null; weight_lb: string | null }>(c, `
    select l.id, l.product_id, l.description, l.qty, l.unit_price_minor, l.discount_minor, l.config, p.kind, p.name, p.attributes, p.cubic_ft, p.weight_lb
      from sales_order_line l left join product p on p.id = l.product_id left join pos_line pl on pl.sales_order_line_id = l.id
     where l.entity_id = $1 and l.sales_order_id = $2 and l.line_status <> 'cancelled' and coalesce(pl.role, 'item') = 'item' order by l.seq`, [entityId, orderId]);
  const groupLabels = new Map((await q<{ product_id: string; code: string; label: string }>(c, `select product_id, code, label from product_option_group where entity_id = $1
     and product_id = any($2)`, [entityId, lines.map((l) => l.product_id).filter(Boolean)])).map((g) => [`${g.product_id}|${g.code}`, g.label]));
  const max = env.maxPhotos ?? 12;
  let shown = 0;
  const cards: string[] = [];
  for (const l of lines) {
    const goods = l.kind && !["fee", "service", "warranty"].includes(l.kind);
    const img = goods && l.product_id && shown < max ? await photo(c, entityId, l.product_id, 1, env) : null;
    if (img) shown++;
    const opts = Object.entries(l.config ?? {}).filter(([, v]) => Array.isArray(v) && v.length)
      .map(([g, v]) => `<li><b>${esc(groupLabels.get(`${l.product_id}|${g}`) ?? g)}:</b> ${esc(v.map((x) => x.label).join(", "))}</li>`).join("");
    const net = BigInt(Math.round(Number(l.qty) * Number(l.unit_price_minor))) - BigInt(l.discount_minor);
    const dims = goods ? dimensions(l) : "";
    cards.push(`<article class="card">${goods ? `<div class="ph">${img ? `<img src="${esc(img)}" alt="${esc(l.name ?? l.description)}">` : "Photo to come"}</div>` : ""}
<div class="bd"><div class="nm">${esc(l.name ?? l.description)}</div>${l.name && l.description !== l.name ? `<div class="muted">${esc(l.description)}</div>` : ""}
${opts ? `<ul class="opts">${opts}</ul>` : ""}${dims ? `<div class="muted">${esc(dims)}</div>` : ""}
<div class="row"><span class="muted">${Number(l.qty)} × ${usd(l.unit_price_minor)}${BigInt(l.discount_minor) ? `, ${usd(l.discount_minor)} off` : ""}</span><span class="amt price">${usd(net)}</span></div></div></article>`);
  }
  const quote = h.kind === "quote";
  const title = `${quote ? "Quote" : "Order"} ${h.number}`;
  const body = `<header><div><div class="co">${esc(h.company)}</div><div class="muted">${storeBlock({ name: h.location, address: h.address, company: h.company })}</div></div>
<div><h1>${esc(title)}</h1><div class="muted">${esc(day(String(h.ordered_at)))}</div></div></header>
<div class="who">${h.customer ? `<div><span class="muted">Prepared for</span><br><b>${esc(h.customer)}</b></div>` : ""}${h.salesperson ? `<div><span class="muted">Your salesperson</span><br><b>${esc(h.salesperson)}</b></div>` : ""}
${h.quote_expires_on ? `<div><span class="muted">Prices good until</span><br><b>${esc(day(h.quote_expires_on))}</b></div>` : ""}</div>
<section class="cards">${cards.join("\n") || `<p class="muted">Nothing on this ${quote ? "quote" : "order"} yet.</p>`}</section>
<div class="totals"><div class="row"><span>Subtotal</span><span class="amt">${usd(BigInt(h.subtotal_minor) - BigInt(h.discount_minor))}</span></div>
<div class="row"><span>Sales tax${h.tax_exempt_ref ? " (exempt)" : ""}</span><span class="amt">${usd(h.tax_minor)}</span></div>
<div class="row grand"><span>Total</span><span class="amt">${usd(h.total_minor)}</span></div>
${BigInt(h.paid_minor) ? `<div class="row"><span>Paid</span><span class="amt">${usd(h.paid_minor)}</span></div>` : ""}</div>
${quote && h.quote_expires_on ? `<p class="note">This quote is good until ${esc(day(h.quote_expires_on))}. Made-to-order pieces are ordered once a deposit is taken; stocked pieces are not held unless the store says so.</p>` : ""}
<footer>${esc(h.company)} · ${storeBlock({ name: h.location, address: h.address, company: h.company })}<span class="noprint"> · Print this page from your browser for a paper copy.</span></footer>`;
  return shell(`${title} · ${h.company}`, body);
}

/** One product's tear sheet: photos, what it can be made in, dimensions, price, and the store to ask at. */
export async function productSheet(c: Client, entityId: string, productId: string, env: SheetEnv = {}, locationId: string | null = null): Promise<string | null> {
  const p = (await q<{ id: string; sku: string; name: string; brand: string | null; collection: string | null; color: string | null; description: string | null;
    price_minor: string; kind: string; attributes: Record<string, unknown> | null; cubic_ft: string | null; weight_lb: string | null; status: string; company: string }>(c, `
    select p.id, p.sku, p.name, p.brand, p.collection, p.color, p.description, p.price_minor, p.kind, p.attributes, p.cubic_ft, p.weight_lb, p.status, e.name company
      from product p join entity e on e.id = p.entity_id where p.id = $1 and p.entity_id = $2`, [productId, entityId]))[0];
  if (!p) return null;
  const store = (await q<{ name: string; address: Record<string, string> | null }>(c, `select name, address from location where entity_id = $1 and status = 'active'
     and kind in ('store','outlet') order by (id = $2) desc, code limit 1`, [entityId, locationId]))[0] ?? { name: "", address: null };
  const seqs = await q<{ seq: number; alt: string | null }>(c, `select seq, alt from product_image where entity_id = $1 and product_id = $2 order by seq limit $3`,
    [entityId, productId, Math.min(env.maxPhotos ?? 4, 6)]);
  const imgs: string[] = [];
  for (const s of seqs) { const d = await photo(c, entityId, productId, s.seq, env); if (d) imgs.push(`<img src="${esc(d)}" alt="${esc(s.alt ?? p.name)}">`); }
  const groups = await q<{ label: string; required: boolean; options: { label: string; delta: string }[] | null }>(c, `
    select g.label, g.required, (select json_agg(json_build_object('label', o.label, 'delta', o.price_delta_minor::text) order by o.seq)
      from product_option o where o.group_id = g.id and o.entity_id = g.entity_id and o.active) options
      from product_option_group g where g.entity_id = $1 and g.product_id = $2 order by g.seq`, [entityId, productId]);
  const dims = dimensions(p);
  const body = `<header><div><div class="co">${esc(p.company)}</div><div class="muted">${storeBlock({ ...store, company: p.company })}</div></div>
<div><h1>${esc(p.name)}</h1><div class="muted">${esc([p.brand, p.collection, p.color, p.sku].filter(Boolean).join(" · "))}</div></div></header>
${imgs.length ? `<section class="gallery">${imgs.join("")}</section>` : `<p class="muted">Photos to come.</p>`}
<div class="row"><span class="muted">${groups.length ? "From" : "Price"}</span><span class="amt price">${usd(p.price_minor)}</span></div>
${p.description ? `<p>${esc(p.description)}</p>` : ""}${dims ? `<p class="muted">${esc(dims)}</p>` : ""}
${groups.length ? `<h2>Make it yours</h2><ul class="groups">${groups.map((g) => `<li><b>${esc(g.label)}${g.required ? "" : " (optional)"}:</b> ${esc((g.options ?? [])
    .map((o) => `${o.label}${BigInt(o.delta) ? ` (${BigInt(o.delta) > 0n ? "+" : ""}${usd(o.delta)})` : ""}`).join("; "))}</li>`).join("")}</ul>` : ""}
<p class="note">Prices and availability change; ask the store for a quote with your choices.</p>
<footer>${esc(p.company)} · ${storeBlock({ ...store, company: p.company })}<span class="noprint"> · Print this page from your browser for a paper copy.</span></footer>`;
  return shell(`${p.name} · ${p.company}`, body);
}

// ------------------------------------------------------------- links

/** A link for the customer to a quote's or a product's sheet. Any earlier link to the same thing is replaced. */
export async function createLink(c: Client, scope: Scope, e: { orderId?: string | null; productId?: string | null; customerId?: string | null; days?: number }) {
  need(!!e.orderId !== !!e.productId, "a tear sheet is for one order or one product");
  let expires = new Date(Date.now() + Math.min(Math.max(e.days ?? 30, 1), 90) * 86400000);
  let customer = e.customerId ?? null;
  if (e.orderId) {
    const o = await q<{ customer_id: string | null; quote_expires_on: string | null; number: string }>(c, `select so.customer_id, po.quote_expires_on::text, so.number
       from sales_order so left join pos_order po on po.sales_order_id = so.id where so.id = $1 and so.entity_id = $2`, [e.orderId, scope.entityId]);
    need(o.length, "no such order");
    customer = customer ?? o[0].customer_id;
    if (o[0].quote_expires_on) expires = new Date(o[0].quote_expires_on + "T23:59:59Z");
    await c.query(`update tear_sheet_link set revoked_at = now() where entity_id = $1 and sales_order_id = $2 and revoked_at is null`, [scope.entityId, e.orderId]);
  } else {
    const p = await q(c, `select id from product where id = $1 and entity_id = $2`, [e.productId, scope.entityId]);
    need(p.length, "no such product");
  }
  if (customer) {
    const cu = await q(c, `select id from customer where id = $1 and entity_id = $2`, [customer, scope.entityId]);
    need(cu.length, "no such customer");
  }
  const token = randomBytes(24).toString("base64url");
  const row = await one<{ id: string }>(c, `insert into tear_sheet_link (entity_id, sales_order_id, product_id, customer_id, token_sha256, expires_at, created_by)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`, [scope.entityId, e.orderId ?? null, e.productId ?? null, customer, sha(token), expires.toISOString(), scope.actor.id || null]);
  await audit(c, scope, { table: "tear_sheet_link", rowId: row.id, action: "insert", after: { orderId: e.orderId ?? null, productId: e.productId ?? null, expires: expires.toISOString() } });
  return { id: row.id, token, path: `/sheet/${token}`, expiresAt: expires.toISOString(), customerId: customer };
}

/** Text or email the customer the link, through the customer message log. */
export async function sendLink(c: Client, scope: Scope, e: { orderId?: string | null; productId?: string | null; customerId?: string | null; baseUrl: string }) {
  const link = await createLink(c, scope, e);
  need(link.customerId, "pick the customer to send it to");
  const what = e.orderId
    ? `your quote ${(await one<{ number: string }>(c, `select number from sales_order where id = $1 and entity_id = $2`, [e.orderId, scope.entityId])).number}`
    : (await one<{ name: string }>(c, `select name from product where id = $1 and entity_id = $2`, [e.productId, scope.entityId])).name;
  const url = `${e.baseUrl}${link.path}`;
  const msgId = await messageCustomer(c, scope, { customerId: link.customerId!, orderId: e.orderId ?? null, kind: "tear_sheet",
    body: `here is ${what}, with photos and prices: ${url}` });
  need(msgId, "that customer has no phone or email to send it to");
  const m = await one<{ channel: string; status: string; to_addr: string }>(c, `select channel, status, to_addr from customer_message where id = $1 and entity_id = $2`, [msgId, scope.entityId]);
  return { ...link, url, messageId: msgId, channel: m.channel, status: m.status, to: m.to_addr };
}

/** The public page behind a link. Not found, expired or replaced all read the same way to a stranger. */
export async function publicSheet(c: Client, token: string, env: SheetEnv = {}): Promise<PublicPage | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const r = await q<{ id: string; entity_id: string; sales_order_id: string | null; product_id: string | null; live: boolean }>(c, `
    select id, entity_id, sales_order_id, product_id, (revoked_at is null and expires_at > now()) live from tear_sheet_link
     where token_sha256 = $1 /* unscoped: the token names its company */`, [sha(token)]);
  if (!r.length || !r[0].live) return null;
  const k = r[0];
  await c.query(`update tear_sheet_link set opened_count = opened_count + 1 where id = $1 and entity_id = $2`, [k.id, k.entity_id]);
  const html = k.sales_order_id ? await orderSheet(c, k.entity_id, k.sales_order_id, env) : await productSheet(c, k.entity_id, k.product_id!, env);
  return html ? new PublicPage(html) : null;
}

export const notFoundPage = () => new PublicPage(shell("Link not found", `<h1>This link is not available</h1><p>It may have expired or been replaced by a newer one. Ask the store to send it again.</p>`));
