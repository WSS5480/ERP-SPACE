// The web store page. Everything shown comes from /shop/<slug>/api; data is
// placed with textContent only. Prices shown here are the server's: the cart
// sends product, options and quantity, never a price, and checkout is priced
// again on the server. Card numbers never pass through this page: the test
// processor uses tokens, and a real one tokenises in its own field.
(() => {
'use strict';

const SLUG = document.body.dataset.slug;
const API = `/shop/${SLUG}/api`;
const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (s, r = document) => r.querySelector(s);

// ------------------------------------------------------------------ basics
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}
function sv(tag, attrs, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, String(v));
  for (const k of kids.flat(Infinity)) if (k) n.append(k);
  return n;
}
const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (m) => { const n = Number(m || 0) / 100; return Number.isInteger(n) ? USD0.format(n) : USD2.format(n); };
const money2 = (m) => USD2.format(Number(m || 0) / 100);
const DAYF = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const day = (iso) => (iso ? DAYF.format(new Date(iso + 'T00:00:00Z')) : '');
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } },
};
const sess = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (_) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } },
};
function newId() {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return 'c' + [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 26);
}
let toastT = 0;
function toast(text) { const t = $('#toast'); t.textContent = text; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3800); }

async function call(path, body) {
  const opts = body === undefined
    ? { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'omit' }
    : { method: 'POST', headers: { 'content-type': 'application/json', 'x-erp-shop': '1' }, body: JSON.stringify(body), cache: 'no-store', credentials: 'omit' };
  let res;
  try { res = await fetch(API + path, opts); } catch (_) { throw new Error('We couldn’t reach the store. Check your connection and try again.'); }
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty */ }
  if (!res.ok) throw new Error((data && data.error) || `Something went wrong (${res.status}). Try again.`);
  return data;
}
const get = (p) => call(p);
const post = (p, b) => call(p, b || {});

// ------------------------------------------------------------------ state
const KEY = `shop.${SLUG}.cart`;
const S = { site: null, cart: store.get(KEY) || { id: newId(), lines: [] }, priced: null, seq: 0 };
if (!S.cart.id || !/^[A-Za-z0-9_-]{8,64}$/.test(S.cart.id) || !Array.isArray(S.cart.lines)) S.cart = { id: newId(), lines: [] };
const saveCart = () => { store.set(KEY, S.cart); paintCount(); };
const lineKey = (productId, choices, sectional) => productId + '|' + JSON.stringify(choices || [])
  + (sectional ? '|' + JSON.stringify([sectional.layout || null, sectional.pieces || [], sectional.cover || null, (sectional.pieceOptions || []).map((o) => (o || []).map((c) => [c.group, c.option]))]) : '');
function paintCount() {
  const n = S.cart.lines.reduce((a, l) => a + l.qty, 0);
  const c = $('#cart-count'); c.textContent = String(n); c.hidden = !n;
  $('#cart-link').setAttribute('aria-label', n ? `Cart, ${n} item${n === 1 ? '' : 's'}` : 'Cart, empty');
}
async function syncCart(email) {
  const r = await post('/cart', { cartId: S.cart.id, lines: S.cart.lines.map((l) => ({ productId: l.productId, choices: l.choices, qty: l.qty, sectional: l.sectional || undefined })), email: email || undefined });
  if (r.converted) { S.cart = { id: newId(), lines: [] }; saveCart(); return syncCart(); }
  S.priced = r;
  return r;
}
function addToCart(productId, choices, qty, name, sectional) {
  const k = lineKey(productId, choices, sectional);
  const hit = sectional ? null : S.cart.lines.find((l) => lineKey(l.productId, l.choices, l.sectional) === k);
  if (hit) hit.qty = Math.min(20, hit.qty + qty); else S.cart.lines.push(sectional ? { productId, choices, qty: 1, name, sectional } : { productId, choices, qty, name });
  saveCart();
  syncCart().catch(() => undefined);
}

// --------------------------------------------------------- illustrations
// Photography is not in the catalog yet, and the page's security policy only
// allows same-origin images, so each product is drawn: a silhouette in its color.
const COLORS = { cobblestone: '#9b958b', whitewash: '#e7e1d6', cappuccino: '#5d4232', grey: '#8e9196', gray: '#8e9196', white: '#f2f0ea',
  ivory: '#efe6d3', navy: '#27325e', black: '#2a2a2a', brown: '#6b4a34', oak: '#b88a57', walnut: '#5b3a29', beige: '#d8c8ad', blue: '#3c5a8a', green: '#4d6b4f' };
function colorFor(name) {
  const k = String(name || '').toLowerCase();
  for (const [w, hex] of Object.entries(COLORS)) if (k.includes(w)) return hex;
  let h = 0; for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ['#a3927a', '#7d8a7a', '#8b7d91', '#9a7b66', '#6f8496'][h % 5];
}
const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16); const ch = (s) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return '#' + [ch(16), ch(8), ch(0)].map((x) => x.toString(16).padStart(2, '0')).join('');
};
function kindOf(p) {
  const s = `${p.subcategory || ''} ${p.category || ''} ${p.name || ''}`.toLowerCase();
  if (/protect|warrant|plan/.test(s)) return 'shield';
  if (/sectional/.test(s)) return 'sectional';
  if (/loveseat/.test(s)) return 'loveseat';
  if (/recliner|chair\b.*power|armchair/.test(s)) return 'recliner';
  if (/sofa|couch/.test(s)) return 'sofa';
  if (/mattress/.test(s)) return 'mattress';
  if (/bed\b|beds/.test(s)) return 'bed';
  if (/nightstand/.test(s)) return 'nightstand';
  if (/dresser|chest/.test(s)) return 'dresser';
  if (/chair/.test(s)) return 'chair';
  if (/table|dining/.test(s)) return 'table';
  if (/lamp|light/.test(s)) return 'lamp';
  if (/pillow|throw/.test(s)) return 'pillows';
  return 'box';
}
/** A product drawing. o.body is the main color, o.legs the leg/wood finish, o.width 0.85-1.15. */
function art(kind, o = {}) {
  const body = o.body || '#b9ab95', dark = shade(body, 0.82), light = shade(body, 1.08), legs = o.legs || '#5b3a29';
  const w = o.width || 1;
  const g = [];
  const R = (x, y, wd, ht, fill, rx = 6) => sv('rect', { x, y, width: wd, height: ht, rx, fill });
  const cx = 200;
  if (kind === 'sofa' || kind === 'loveseat' || kind === 'sectional') {
    const W = (kind === 'loveseat' ? 210 : 290) * w, x0 = cx - W / 2 - (kind === 'sectional' ? 30 : 0);
    g.push(R(x0 + 14, 112, W - 28, 62, dark, 14));                        // back
    const seats = kind === 'loveseat' ? 2 : 3, sw = (W - 64) / seats;
    for (let i = 0; i < seats; i++) g.push(R(x0 + 32 + i * sw + 2, 120, sw - 4, 52, light, 10));   // back cushions
    g.push(R(x0 + 20, 166, W - 40, 40, body, 10));                        // seat
    for (let i = 0; i < seats; i++) g.push(R(x0 + 32 + i * sw + 2, 162, sw - 4, 20, light, 8));
    g.push(R(x0, 138, 38, 78, dark, 14), R(x0 + W - 38, 138, 38, 78, dark, 14));   // arms
    if (kind === 'sectional') g.push(R(x0 + W - 40, 166, 110, 50, body, 12), R(x0 + W + 40, 120, 30, 96, dark, 12), R(x0 + W - 34, 160, 96, 18, light, 8));
    const right = kind === 'sectional' ? x0 + W + 56 : x0 + W - 18;
    g.push(R(x0 + 10, 214, 9, 22, legs, 2), R(right, 214, 9, 22, legs, 2), R(x0 + W / 2 - 4, 214, 8, 18, legs, 2));
  } else if (kind === 'recliner' || kind === 'chair') {
    if (kind === 'recliner') { g.push(R(140, 92, 120, 96, dark, 22), R(126, 150, 148, 56, body, 16), R(118, 132, 34, 80, dark, 14), R(248, 132, 34, 80, dark, 14), R(150, 104, 100, 54, light, 16), R(148, 206, 10, 16, legs, 2), R(242, 206, 10, 16, legs, 2)); }
    else { g.push(R(160, 70, 80, 90, body, 10), R(150, 158, 100, 18, dark, 6), R(156, 176, 8, 70, legs, 2), R(236, 176, 8, 70, legs, 2), R(160, 70, 80, 14, light, 6)); }
  } else if (kind === 'table') {
    g.push(R(80, 128, 240, 16, legs, 4), R(92, 144, 216, 8, shade(legs, 0.8), 2), R(102, 150, 12, 92, legs, 2), R(286, 150, 12, 92, legs, 2));
    g.push(R(60, 100, 44, 70, body, 8), R(296, 100, 44, 70, body, 8));
  } else if (kind === 'bed') {
    g.push(R(92, 70, 216, 100, body, 12), R(110, 86, 180, 70, light, 10), R(80, 150, 240, 46, dark, 8), R(86, 138, 228, 26, '#f4f2ee', 8));
    g.push(R(116, 124, 70, 22, '#ffffff', 10), R(214, 124, 70, 22, '#ffffff', 10), R(84, 196, 10, 26, legs, 2), R(306, 196, 10, 26, legs, 2));
  } else if (kind === 'dresser' || kind === 'nightstand') {
    const W = kind === 'dresser' ? 230 : 120, H = kind === 'dresser' ? 128 : 110, x0 = cx - W / 2, y0 = 212 - H;
    g.push(R(x0 - 6, y0 - 8, W + 12, 12, dark, 3), R(x0, y0, W, H, body, 4));
    const rows = kind === 'dresser' ? 3 : 2, cols = kind === 'dresser' ? 2 : 1;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const dw = (W - 16 - (cols - 1) * 8) / cols, dh = (H - 16 - (rows - 1) * 8) / rows, dx = x0 + 8 + c * (dw + 8), dy = y0 + 8 + r * (dh + 8);
      g.push(R(dx, dy, dw, dh, light, 3), R(dx + dw / 2 - 12, dy + dh / 2 - 2, 24, 4, legs, 2));
    }
    g.push(R(x0 + 6, y0 + H, 10, 16, legs, 2), R(x0 + W - 16, y0 + H, 10, 16, legs, 2));
  } else if (kind === 'mattress') {
    g.push(R(70, 136, 260, 70, '#f6f4ef', 18), R(70, 136, 260, 22, light, 14), R(76, 196, 248, 12, dark, 4));
    for (let i = 0; i < 6; i++) g.push(sv('circle', { cx: 100 + i * 40, cy: 178, r: 3, fill: '#d6d0c4' }));
  } else if (kind === 'lamp') {
    g.push(sv('path', { d: 'M150 70h100l26 74H124z', fill: '#f4ecdc' }), sv('ellipse', { cx: 200, cy: 182, rx: 34, ry: 40, fill: body }), R(194, 140, 12, 12, legs, 2), R(168, 218, 64, 10, dark, 4));
  } else if (kind === 'pillows') {
    g.push(R(110, 104, 110, 104, dark, 22), R(170, 118, 112, 104, body, 22), R(190, 136, 72, 4, light, 2));
  } else if (kind === 'shield') {
    g.push(sv('path', { d: 'M200 64l78 28v54c0 48-34 76-78 88-44-12-78-40-78-88V92z', fill: o.body || '#2f5d50' }), sv('path', { d: 'M168 152l22 22 44-48', fill: 'none', stroke: '#fff', 'stroke-width': 12, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  } else {
    g.push(R(130, 100, 140, 120, body, 10), R(130, 100, 140, 20, light, 8));
  }
  return sv('svg', { viewBox: '0 0 400 300', role: 'img', 'aria-label': o.label || 'Product illustration', preserveAspectRatio: 'xMidYMid slice' },
    sv('rect', { x: 0, y: 0, width: 400, height: 300, fill: '#f1ede6' }),
    sv('rect', { x: 0, y: 222, width: 400, height: 78, fill: '#e7e1d6' }),
    sv('ellipse', { cx: 200, cy: 238, rx: 160, ry: 10, fill: 'rgba(0,0,0,.07)' }),
    g);
}
const photo = (p, o) => el('div', { class: 'ph' }, art(kindOf(p), Object.assign({ body: colorFor(p.color || p.name), label: p.name }, o || {})));

/** What a configured product looks like: fabric swatch on the body, leg finish on the legs, size as width. */
function previewOpts(product, picked) {
  const o = { label: product.name };
  for (const g of product.options || []) {
    const code = picked[g.code]; const opt = g.options.find((x) => x.code === (Array.isArray(code) ? code[0] : code));
    if (!opt) continue;
    const gc = g.code.toLowerCase();
    if (/leg|finish|wood|base/.test(gc) && opt.swatch) o.legs = opt.swatch;
    else if (opt.swatch && !o.body) o.body = opt.swatch;
    if (/size|width|config/.test(gc)) {
      const i = g.options.indexOf(opt);
      if (/sect|chaise/.test(opt.code + ' ' + opt.label.toLowerCase())) o.kind = 'sectional';
      else o.width = 0.88 + Math.min(i, 3) * 0.1;
    }
  }
  return o;
}

// --------------------------------------------------------------- chrome
function paintChrome() {
  const s = S.site;
  document.title = s.name;
  const logo = $('#logo');
  if (s.logoUrl) logo.replaceChildren(el('img', { src: s.logoUrl, alt: s.name }));
  $('#cats').replaceChildren(...s.categories.map((c) => el('a', { href: `#/c/${encodeURIComponent(c.name)}`, text: c.name })));
  $('#foot').replaceChildren(el('div', { class: 'foot-in' },
    el('div', {}, el('b', { text: s.name }), s.tagline ? el('span', { class: 'muted', text: s.tagline }) : null),
    el('div', {}, el('b', { text: 'Shop' }), s.categories.slice(0, 6).map((c) => el('a', { href: `#/c/${encodeURIComponent(c.name)}`, text: c.name }))),
    el('div', {}, el('b', { text: 'Help' }), el('a', { href: '#/status', text: 'Order status' }), el('a', { href: '#/contact', text: 'Contact us' }), el('a', { href: '#/policies', text: 'Delivery, pickup and returns' }),
      s.financingUrl ? el('a', { href: s.financingUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Apply for financing' }) : null),
    el('div', {}, el('b', { text: 'Stores' }), s.pickupStores.map((p) => el('span', { class: 'small muted' }, el('span', { text: p.name }), p.address ? el('br') : null, p.address || '', el('br'))))));
  paintCount();
}
function markNav(cat) { for (const a of document.querySelectorAll('#cats a')) a.classList.toggle('on', !!cat && a.textContent === cat); }
const main = () => $('#main');
function setMain(...kids) { const m = main(); m.replaceChildren(...kids); }
const loading = (t) => el('div', { class: 'loading' }, el('span', { class: 'spin' }), t || 'Loading…');
const errorBox = (e, retry) => el('div', { class: 'wrap' }, el('div', { class: 'alert', role: 'alert', text: e.message || String(e) }), retry ? el('button', { class: 'btn', type: 'button', onclick: retry }, 'Try again') : null);
const crumbs = (...items) => el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, items.map((x, i) => [i ? el('span', { 'aria-hidden': 'true', text: '/' }) : null, x]));
const check = () => sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }));
function availBlock(a) {
  return el('div', { class: 'avail', 'aria-live': 'polite' }, (a.lines || []).map((l) => el('div', { class: l.kind }, check(), el('span', { text: l.text }))));
}
function card(p) {
  const priceLabel = p.configurable ? [el('small', { text: 'From ' }), money(p.priceMinor)] : money(p.priceMinor);
  const badge = { in_stock: 'In stock', ships: 'Ships soon', made_to_order: 'Made to order', backorder: 'On order', service: '' }[p.stock];
  return el('a', { class: 'card', href: `#/p/${p.id}` }, photo(p),
    el('span', { class: 'br', text: [p.brand, p.collection].filter(Boolean).join(' · ') }),
    el('span', { class: 'nm', text: p.name }), el('span', { class: 'pr' }, priceLabel),
    badge ? el('span', {}, el('span', { class: 'badge ' + p.stock, text: badge })) : null);
}

// ----------------------------------------------------------------- pages
async function pageHome() {
  const s = S.site;
  const [list] = await Promise.all([get('/products?sort=featured')]);
  const lead = s.categories[0];
  setMain(
    el('section', { class: 'hero' }, el('div', { class: 'hero-in' },
      el('div', {}, el('p', { class: 'eyebrow', text: 'Delivered, set up, or ready for pickup' }), el('h1', { text: s.tagline || s.name }),
        el('p', { text: 'Shop the showroom online. See what is in stock at your store, or build a sofa your way.' }),
        el('div', { class: 'acts' },
          lead ? el('a', { class: 'btn accent', href: `#/c/${encodeURIComponent(lead.name)}`, text: `Shop ${lead.name.toLowerCase()}` }) : null,
          list.products.some((p) => p.configurable) ? el('a', { class: 'btn ghost', href: `#/p/${list.products.find((p) => p.configurable).id}`, text: 'Design your sofa' }) : null)),
      el('div', { class: 'art' }, art('sofa', { body: '#d8cbb3', legs: '#5b3a29', label: 'A sofa' })))),
    el('div', { class: 'wrap' },
      el('div', { class: 'props' },
        el('div', { class: 'prop' }, el('b', { text: 'Pick up in store' }), el('span', { text: s.pickupStores.length ? `At ${s.pickupStores.map((x) => x.name).join(', ')}.` : 'Ask us about pickup.' })),
        el('div', { class: 'prop' }, el('b', { text: 'White-glove delivery' }), el('span', { text: s.freeDeliveryOverMinor ? `Free on orders over ${money(s.freeDeliveryOverMinor)}; otherwise ${money(s.deliveryFeeMinor)}.` : `${money(s.deliveryFeeMinor)}, set up in the room you choose.` })),
        s.financingUrl ? el('div', { class: 'prop' }, el('b', { text: 'Financing available' }), el('span', {}, 'Take it home now and pay over time. ', el('a', { href: s.financingUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Apply' }))) : null),
      el('section', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: 'Shop by room' })),
        el('div', { class: 'cat-grid' }, s.categories.map((c) => {
          const sample = list.products.find((p) => p.category === c.name);
          return el('a', { class: 'cat', href: `#/c/${encodeURIComponent(c.name)}` },
            sample ? photo(sample) : el('div', { class: 'ph' }, art('box')),
            el('div', { class: 'ct' }, el('b', { text: c.name }), el('span', { text: `${c.count} item${c.count === 1 ? '' : 's'} · from ${money(c.fromMinor)}` })));
        }))),
      el('section', { class: 'sec' }, el('div', { class: 'sec-h' }, el('h2', { text: 'Ready to go' }), el('a', { class: 'link', href: '#/search', text: 'See everything' })),
        el('div', { class: 'grid' }, list.products.slice(0, 8).map(card)))));
}

async function pageList(category, params) {
  const qs = new URLSearchParams();
  if (category) qs.set('category', category);
  for (const k of ['brand', 'color', 'min', 'max', 'sort', 'q']) if (params.get(k)) qs.set(k, params.get(k));
  const r = await get('/products?' + qs.toString());
  markNav(category);
  const go = (k, v) => {
    const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k);
    const tail = p.toString();
    location.hash = (category ? `#/c/${encodeURIComponent(category)}` : '#/search') + (tail ? '?' + tail : '');
  };
  const sel = (label, k, opts) => el('label', {}, label, el('select', { onchange: (e) => go(k, e.target.value) },
    opts.map(([v, t]) => el('option', { value: v, text: t, selected: (params.get(k) || '') === v || null }))));
  const steps = priceSteps(r.facets.minMinor, r.facets.maxMinor);
  const title = category || (params.get('q') ? `Results for “${params.get('q')}”` : 'Everything');
  setMain(el('div', { class: 'wrap' },
    crumbs(el('a', { href: '#/', text: 'Home' }), el('span', { text: title })),
    el('div', { class: 'list-h' }, el('h1', { text: title }), el('span', { class: 'muted', text: `${r.products.length} item${r.products.length === 1 ? '' : 's'}` })),
    el('div', { class: 'filters' },
      sel('Sort', 'sort', [['', 'Featured'], ['price_asc', 'Price, low to high'], ['price_desc', 'Price, high to low'], ['newest', 'Newest'], ['name', 'Name']]),
      r.facets.brands.length > 1 ? sel('Brand', 'brand', [['', 'All brands'], ...r.facets.brands.map((b) => [b, b])]) : null,
      r.facets.colors.length > 1 ? sel('Color', 'color', [['', 'All colors'], ...r.facets.colors.map((b) => [b, b])]) : null,
      sel('From', 'min', [['', 'Any price'], ...steps.map((v) => [String(v), money(v)])]),
      sel('Up to', 'max', [['', 'Any price'], ...steps.map((v) => [String(v), money(v)])]),
      [...params.keys()].some((k) => k !== 'q') ? el('button', { class: 'link clear', type: 'button', onclick: () => { location.hash = category ? `#/c/${encodeURIComponent(category)}` : '#/search'; } }, 'Clear filters') : null),
    r.products.length ? el('div', { class: 'grid' }, r.products.map(card))
      : el('div', { class: 'empty' }, el('p', { text: 'Nothing matches those filters.' }), el('a', { class: 'btn', href: category ? `#/c/${encodeURIComponent(category)}` : '#/', text: 'Clear filters' }))));
}
function priceSteps(lo, hi) {
  const a = Number(lo || 0), b = Number(hi || 0); const out = [];
  for (const v of [5000, 10000, 25000, 50000, 75000, 100000, 150000, 200000, 300000, 500000]) if (v > a && v < b * 1.2) out.push(v);
  return out;
}

/** The plan from above, drawn from the server's rectangles (inches). */
function planSvg(g) {
  if (!g || !g.pieces || !g.pieces.length) return el('p', { class: 'small muted', text: 'Pick pieces to see the plan.' });
  const pad = 4, W = g.viewW + pad * 2, H = g.viewH + pad * 2;
  const r = (x, fill) => sv('rect', { x: x.x + pad, y: x.y + pad, width: x.w, height: x.h, fill, stroke: '#3d3a36', 'stroke-width': 0.6, rx: 1 });
  return sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Plan, ${g.widthIn} by ${g.depthIn} inches, seats ${g.seats}` },
    g.pieces.map((p) => sv('g', {}, r(p, p.free ? '#efe9df' : '#e3d9c8'), p.back.map((b) => r(b, '#b9ab94')), p.arms.map((a) => r(a, '#9c8b72')),
      sv('text', { x: p.x + pad + p.w / 2, y: p.y + pad + p.h / 2 + 2, 'font-size': 5, 'text-anchor': 'middle', fill: '#2b2925' }, document.createTextNode(p.label)))));
}

/** Build a sectional: a popular layout or your own pieces, the cover (by grade and color), each piece's options. */
function sectionalBuilder(p, f, onPriced) {
  const st = { pieces: [], opts: [], cover: f.stockCover || (f.covers[0] && f.covers[0].code) || '', grade: '', color: '', priced: null, seq: 0 };
  const first = f.layouts.find((l) => l.popular) || f.layouts[0];
  if (first) { st.pieces = first.pieces.slice(); st.opts = st.pieces.map(() => ({})); }
  const byCode = new Map(f.pieces.map((x) => [x.code, x]));
  const plan = el('div', { class: 'ph' }), facts = el('div', { class: 'small muted' }), err = el('div'), piecesEl = el('div'), coverEl = el('div');
  const allowed = (g, piece) => (g !== 'recline' || piece.motion === 'none') && (!f.rules.some((r) => r.kind === 'only_on' && r.group === g)
    || f.rules.some((r) => r.kind === 'only_on' && r.group === g && r.pieceTypes.includes(piece.type)));
  const build = () => {
    const lay = f.layouts.find((l) => l.pieces.join('|') === st.pieces.join('|'));
    return { layout: lay ? lay.code : null, pieces: st.pieces.slice(), cover: st.cover || null,
      pieceOptions: st.opts.map((m) => Object.entries(m).filter(([, v]) => v).map(([group, option]) => ({ group, option }))) };
  };
  async function reprice() {
    const my = ++st.seq;
    if (!st.pieces.length) { plan.replaceChildren(planSvg(null)); st.priced = null; onPriced(null); return; }
    try {
      const r = await post('/sectional-price', { productId: p.id, sectional: build() });
      if (my !== st.seq) return;
      st.priced = r; err.replaceChildren();
      plan.replaceChildren(planSvg(r.geometry));
      facts.textContent = `${r.widthIn}" W × ${r.depthIn}" D · seats ${r.seats} · ${r.pieces.length} pieces${Number(r.bundleDiscountMinor) ? ` · set saves ${money(r.bundleDiscountMinor)}` : ''}`;
      onPriced(r);
    } catch (e) { if (my === st.seq) { st.priced = null; onPriced(null); err.replaceChildren(el('div', { class: 'alert', text: e.message })); } }
  }
  const changed = () => { paintPieces(); reprice(); };
  function paintPieces() {
    const lay = el('div', { class: 'chips', role: 'group', 'aria-label': 'Popular layouts' }, f.layouts.map((l) =>
      el('button', { type: 'button', class: 'chip txt', 'aria-pressed': String(l.pieces.join('|') === st.pieces.join('|')),
        onclick: () => { st.pieces = l.pieces.slice(); st.opts = st.pieces.map(() => ({})); changed(); } }, el('span', { text: l.name }))));
    const rows = st.pieces.map((code, i) => {
      const x = byCode.get(code) || { name: code, type: '', motion: 'none' };
      const sels = f.options.filter((g) => allowed(g.code, x)).map((g) => {
        const s = el('select', { 'aria-label': `${g.label}, piece ${i + 1}` }, el('option', { value: '', text: `No ${g.label.toLowerCase()}` }),
          g.options.map((o) => el('option', { value: o.code, text: `${o.label}${Number(o.priceDeltaMinor) ? ` (+${money(o.priceDeltaMinor)})` : ''}`, selected: st.opts[i][g.code] === o.code || null })));
        s.addEventListener('change', () => { st.opts[i][g.code] = s.value; reprice(); });
        return el('label', { class: 'small' }, el('span', { class: 'muted', text: `${g.label} ` }), s);
      });
      return el('div', { class: 'opt' }, el('div', { class: 'opt-h' }, el('span', { text: `${i + 1}. ${x.name}` }),
        el('button', { class: 'link', type: 'button', onclick: () => { st.pieces.splice(i, 1); st.opts.splice(i, 1); changed(); } }, 'Remove')), sels);
    });
    const add = el('select', { 'aria-label': 'Add a piece on the right end' }, el('option', { value: '', text: 'Add a piece on the right end' }),
      f.pieces.map((x) => el('option', { value: x.code, text: `${x.name} · ${money(x.priceMinor)}` })));
    add.addEventListener('change', () => { if (add.value) { st.pieces.push(add.value); st.opts.push({}); changed(); } });
    piecesEl.replaceChildren(el('div', { class: 'opt' }, el('div', { class: 'opt-h' }, el('span', { text: 'Layout' })), lay), ...rows, add);
  }
  function paintCovers() {
    const pick = (label, value, opts, set) => { const s = el('select', { 'aria-label': label }, el('option', { value: '', text: label }), opts.map(([v, t]) => el('option', { value: v, text: t, selected: v === value || null })));
      s.addEventListener('change', () => { set(s.value); paintCovers(); }); return s; };
    const list = f.covers.filter((c) => (!st.grade || c.grade === st.grade) && (!st.color || c.colorFamily === st.color));
    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Covers' }, list.map((c) => {
      const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(st.cover === c.code), onclick: () => { st.cover = c.code; paintCovers(); reprice(); } },
        el('span', { class: 'dot' }), el('span', { text: c.name }), el('span', { class: 'delta', text: `Grade ${c.grade}` }));
      if (c.hex) b.querySelector('.dot').style.setProperty('--sw', c.hex);
      return b;
    }));
    const cur = f.covers.find((c) => c.code === st.cover);
    coverEl.replaceChildren(el('div', { class: 'opt' }, el('div', { class: 'opt-h' }, el('span', { text: 'Cover' }), el('span', { text: cur ? cur.name : 'Choose one' })),
      el('div', { class: 'buyrow' }, pick('Every grade', st.grade, f.grades.map((g) => [g.code, g.label]), (v) => { st.grade = v; }),
        pick('Every color', st.color, [...new Set(f.covers.map((c) => c.colorFamily))].map((c) => [c, c]), (v) => { st.color = v; })),
      list.length ? chips : el('p', { class: 'small muted', text: 'No cover matches; clear a filter.' }),
      cur ? el('p', { class: 'small muted', text: [cur.content, cur.cleaning ? `Cleaning: ${cur.cleaning}` : null].filter(Boolean).join(' · ') } ) : null));
  }
  paintPieces(); paintCovers(); reprice();
  return { plan, node: el('div', {}, piecesEl, coverEl, err, facts), build, priced: () => st.priced };
}

async function pageProduct(id) {
  const p = await get('/products/' + encodeURIComponent(id));
  markNav(p.category);
  if (p.sectional) return pageSectional(p);
  const picked = {};
  for (const d of p.defaults || []) picked[d.group] = d.option;
  let qty = 1, seq = 0;
  const priceEl = el('div', { class: 'price' }, money(p.priceMinor));
  const barPrice = el('span', { class: 'bp', text: money(p.priceMinor) });
  const availEl = el('div', {}, availBlock(p.availability));
  const descEl = el('div', { class: 'small muted' });
  const gallery = el('div', { class: 'ph' });
  const err = el('div');
  const paintPreview = () => {
    const o = p.configurable ? previewOpts(p, picked) : { label: p.name };
    gallery.replaceChildren(art(o.kind || kindOf(p), Object.assign({ body: colorFor(p.color || p.name) }, o)));
  };
  const choiceList = () => Object.entries(picked).filter(([, v]) => v && v.length).map(([group, option]) => ({ group, option }));
  async function reprice() {
    const my = ++seq;
    paintPreview();
    if (!p.options.length) return;
    try {
      const r = await post('/price', { productId: p.id, choices: choiceList() });
      if (my !== seq) return;
      err.replaceChildren();
      priceEl.textContent = money(r.unitPriceMinor); barPrice.textContent = money(r.unitPriceMinor);
      descEl.textContent = r.description;
      availEl.replaceChildren(availBlock(r.availability));
    } catch (e) { if (my === seq) err.replaceChildren(el('div', { class: 'alert', text: e.message })); }
  }
  const optNodes = p.options.map((g) => {
    const label = el('span');
    const sync = () => { const o = g.options.find((x) => x.code === picked[g.code]); label.textContent = o ? o.label : 'Choose one'; };
    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': g.label }, g.options.map((o) => {
      const b = el('button', { type: 'button', class: 'chip' + (o.swatch ? '' : ' txt'), 'aria-pressed': String(picked[g.code] === o.code),
        onclick: () => {
          picked[g.code] = o.code;
          for (const x of chips.children) x.setAttribute('aria-pressed', String(x === b));
          sync(); reprice();
        } },
        o.swatch ? el('span', { class: 'dot' }) : null, el('span', { text: o.label }),
        Number(o.priceDeltaMinor) ? el('span', { class: 'delta', text: (Number(o.priceDeltaMinor) > 0 ? '+' : '−') + money(Math.abs(Number(o.priceDeltaMinor))) }) : null);
      if (o.swatch) b.querySelector('.dot').style.setProperty('--sw', o.swatch);
      return b;
    }));
    sync();
    return el('div', { class: 'opt' }, el('div', { class: 'opt-h' }, el('span', { text: g.label }), label), chips);
  });
  const qtyOut = el('output', { text: '1', 'aria-live': 'polite' });
  const add = () => {
    addToCart(p.id, choiceList(), qty, p.name);
    toast(`${p.name} is in your cart.`);
  };
  const pkg = p.package ? (p.package.kind === 'package'
    ? el('div', { class: 'pkg' }, el('b', { text: Number(p.package.saveMinor) ? `Set price saves ${money(p.package.saveMinor)}` : 'Sold as a set' }),
      el('span', { text: `Bought separately: ${money(p.package.separateMinor)}. Includes:` }),
      el('ul', {}, p.package.includes.map((x) => el('li', {}, el('a', { href: `#/p/${x.productId}`, text: `${x.qty > 1 ? x.qty + ' × ' : ''}${x.name}` })))))
    : el('div', { class: 'pkg' }, el('b', { text: 'Also sold as a set' }),
      el('ul', {}, p.package.partOf.map((x) => el('li', {}, el('a', { href: `#/p/${x.productId}`, text: x.name }), ` — ${money(x.packageMinor)}${Number(x.saveMinor) ? `, save ${money(x.saveMinor)}` : ''}`))))) : null;
  setMain(el('div', { class: 'wrap' },
    crumbs(el('a', { href: '#/', text: 'Home' }), p.category ? el('a', { href: `#/c/${encodeURIComponent(p.category)}`, text: p.category }) : null, el('span', { text: p.name })),
    el('div', { class: 'pdp' },
      el('div', { class: 'gallery' }, gallery, el('p', { class: 'cap', text: p.configurable ? 'Preview updates as you choose. Illustration, not a photo.' : 'Illustration, not a photo.' })),
      el('div', { class: 'buy' },
        el('p', { class: 'eyebrow', text: [p.brand, p.collection].filter(Boolean).join(' · ') || p.category || '' }),
        el('h1', { text: p.name }), priceEl, descEl,
        p.description ? el('p', { class: 'desc', text: p.description }) : null,
        optNodes, err, availEl,
        el('div', { class: 'buyrow' },
          el('div', { class: 'qty' },
            el('button', { type: 'button', 'aria-label': 'One fewer', onclick: () => { qty = Math.max(1, qty - 1); qtyOut.textContent = String(qty); } }, '−'), qtyOut,
            el('button', { type: 'button', 'aria-label': 'One more', onclick: () => { qty = Math.min(20, qty + 1); qtyOut.textContent = String(qty); } }, '+')),
          el('button', { class: 'btn primary', type: 'button', onclick: add }, 'Add to cart')),
        pkg,
        el('details', { class: 'more' }, el('summary', { text: 'Request a quote or ask a question' }),
          leadForm({ kind: 'quote', productId: p.id, choices: () => choiceList(), qty: () => qty, message: `Quote for ${p.name}` })),
        p.financingUrl ? el('div', { class: 'fin' }, el('b', { text: 'Pay over time. ' }), 'Apply in a few minutes and know right away. ',
          el('a', { href: p.financingUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Apply for financing' })) : null,
        el('details', { class: 'more' }, el('summary', { text: 'Delivery, pickup and returns' }), el('p', { text: S.site.policies || 'Ask the store about delivery and returns.' })),
        el('details', { class: 'more' }, el('summary', { text: 'Details' }), el('p', { text: [`SKU ${p.sku}`, p.color ? `Color: ${p.color}` : null, p.subcategory ? `Type: ${p.subcategory}` : null].filter(Boolean).join('\n') })))),
    el('div', { class: 'buybar' }, barPrice, el('button', { class: 'btn primary', type: 'button', onclick: add }, 'Add to cart'))));
  paintPreview();
  if (p.options.length) reprice();
}

async function pageSectional(p) {
  const priceEl = el('div', { class: 'price' }, money(p.priceMinor)), barPrice = el('span', { class: 'bp', text: money(p.priceMinor) });
  const availEl = el('div', {}, availBlock(p.availability));
  const descEl = el('div', { class: 'small muted' });
  const addBtns = [];
  const b = sectionalBuilder(p, p.sectional, (r) => {
    for (const x of addBtns) x.disabled = !r;
    if (!r) return;
    priceEl.textContent = money(r.totalMinor); barPrice.textContent = money(r.totalMinor); descEl.textContent = r.description;
    availEl.replaceChildren(availBlock(r.availability));
  });
  const add = () => { const r = b.priced(); if (!r) return; addToCart(p.id, [], 1, `${p.name} — ${r.layoutName}`, b.build()); toast(`${p.name} is in your cart.`); };
  const mk = () => { const x = el('button', { class: 'btn primary', type: 'button', onclick: add, disabled: true }, 'Add to cart'); addBtns.push(x); return x; };
  setMain(el('div', { class: 'wrap' },
    crumbs(el('a', { href: '#/', text: 'Home' }), p.category ? el('a', { href: `#/c/${encodeURIComponent(p.category)}`, text: p.category }) : null, el('span', { text: p.name })),
    el('div', { class: 'pdp' },
      el('div', { class: 'gallery' }, b.plan, el('p', { class: 'cap', text: 'Your sectional from above. It updates as you build.' })),
      el('div', { class: 'buy' },
        el('p', { class: 'eyebrow', text: [p.brand, p.collection].filter(Boolean).join(' · ') || p.category || '' }),
        el('h1', { text: p.name }), priceEl, descEl, p.description ? el('p', { class: 'desc', text: p.description }) : null,
        b.node, availEl, el('div', { class: 'buyrow' }, mk()),
        el('details', { class: 'more' }, el('summary', { text: 'Delivery, pickup and returns' }),
          el('p', { text: 'A sectional is delivered as a set, every piece on the same truck. ' + (S.site.policies || '') })))),
    el('div', { class: 'buybar' }, barPrice, mk())));
}

async function pageCart() {
  setMain(loading('Checking prices and stock…'));
  const r = await syncCart();
  const byKey = new Map(S.cart.lines.map((l) => [lineKey(l.productId, l.choices, l.sectional), l]));
  const change = (l, qty) => {
    const mine = byKey.get(lineKey(l.productId, l.choices, l.sectional));
    if (mine && mine.sectional && qty > 1) return;
    if (!mine) return;
    if (qty <= 0) S.cart.lines = S.cart.lines.filter((x) => x !== mine); else mine.qty = Math.min(20, qty);
    saveCart(); pageCart().catch(showErr);
  };
  const lines = r.lines.map((l) => el('div', { class: 'line' },
    el('a', { href: `#/p/${l.productId}`, 'aria-hidden': 'true', tabindex: '-1' }, el('div', { class: 'ph' }, art(kindOf(l), { body: colorFor(l.name), label: l.name }))),
    el('div', {},
      el('a', { class: 'nm', href: `#/p/${l.productId}`, text: l.name }),
      l.description !== l.name ? el('div', { class: 'ds', text: l.description.replace(l.name + ' — ', '') }) : null,
      l.plan ? el('div', { class: 'ds', text: `${l.plan.widthIn}" W × ${l.plan.depthIn}" D · seats ${l.plan.seats} · ${l.plan.pieces.length} pieces, delivered together` }) : null,
      el('div', { class: 'av', text: (l.availability.lines[0] || {}).text || '' }),
      el('div', { class: 'row' },
        el('div', { class: 'qty' },
          el('button', { type: 'button', 'aria-label': 'One fewer', onclick: () => change(l, l.qty - 1) }, '−'), el('output', { text: String(l.qty) }),
          el('button', { type: 'button', 'aria-label': 'One more', onclick: () => change(l, l.qty + 1) }, '+')),
        el('span', { class: 'amt', text: money2(l.lineMinor) }),
        el('button', { class: 'link', type: 'button', onclick: () => change(l, 0) }, 'Remove')))));
  const problems = r.problems.map((x) => {
    const mine = S.cart.lines.find((l) => l.productId === x.productId);
    return el('div', { class: 'line bad' }, el('div', { class: 'ph' }, art('box')),
      el('div', {}, el('b', { text: (mine && mine.name) || 'An item' }), el('div', { class: 'ds', text: x.error }),
        el('button', { class: 'link', type: 'button', onclick: () => { S.cart.lines = S.cart.lines.filter((l) => l !== mine); saveCart(); pageCart().catch(showErr); } }, 'Remove')));
  });
  if (!r.lines.length && !problems.length) {
    setMain(el('div', { class: 'wrap narrow' }, el('div', { class: 'empty' }, el('h1', { text: 'Your cart is empty' }),
      el('p', { class: 'muted', text: 'Find something you love and it will wait here.' }), el('a', { class: 'btn primary', href: '#/', text: 'Start shopping' }))));
    return;
  }
  setMain(el('div', { class: 'wrap' },
    crumbs(el('a', { href: '#/', text: 'Home' }), el('span', { text: 'Cart' })),
    el('h1', { text: 'Your cart' }),
    el('div', { class: 'cart' },
      el('div', { class: 'lines' }, lines, problems),
      el('aside', { class: 'summary' },
        el('div', { class: 'sr-row' }, el('span', { text: 'Merchandise' }), el('span', { text: money2(r.subtotalMinor) })),
        el('div', { class: 'sr-row muted small' }, el('span', { text: 'Delivery and tax' }), el('span', { text: 'At checkout' })),
        el('div', { class: 'sr-row tot' }, el('span', { text: 'Subtotal' }), el('span', { text: money2(r.subtotalMinor) })),
        el('a', { class: 'btn primary block', href: '#/checkout', 'aria-disabled': problems.length ? 'true' : null, onclick: (e) => { if (problems.length) { e.preventDefault(); toast('Remove the items that can’t be sold online first.'); } } }, 'Check out'),
        S.site.financingUrl ? el('p', { class: 'small' }, 'Paying over time? ', el('a', { href: S.site.financingUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Apply for financing' })) : null,
        el('a', { class: 'link', href: '#/', text: 'Keep shopping' })))));
}

async function pageCheckout() {
  setMain(loading('Getting checkout ready…'));
  const cart = await syncCart();
  if (!cart.lines.length || cart.problems.length) { location.hash = '#/cart'; return; }
  const s = S.site;
  const saved = sess.get(`shop.${SLUG}.form`) || {};
  const shippable = cart.lines.every((l) => ['parcel', 'carry', 'none'].includes(l.shipClass));
  const f = {
    email: el('input', { type: 'email', autocomplete: 'email', required: true, maxlength: '120', value: saved.email || '' }),
    name: el('input', { type: 'text', autocomplete: 'name', required: true, maxlength: '80', value: saved.name || '' }),
    phone: el('input', { type: 'tel', autocomplete: 'tel', maxlength: '20', value: saved.phone || '', placeholder: 'For delivery updates by text' }),
    marketing: el('input', { type: 'checkbox', checked: !!saved.marketing }),
    line1: el('input', { type: 'text', autocomplete: 'address-line1', maxlength: '100', value: saved.line1 || '' }),
    line2: el('input', { type: 'text', autocomplete: 'address-line2', maxlength: '100', value: saved.line2 || '' }),
    city: el('input', { type: 'text', autocomplete: 'address-level2', maxlength: '60', value: saved.city || '' }),
    state: el('input', { type: 'text', autocomplete: 'address-level1', maxlength: '2', value: saved.state || '', placeholder: 'PA' }),
    postal: el('input', { type: 'text', autocomplete: 'postal-code', inputmode: 'numeric', maxlength: '10', value: saved.postal || '' }),
    notes: el('textarea', { maxlength: '300', placeholder: 'Gate code, stairs, best time to call…' }),
    store: el('select', {}, s.pickupStores.map((p) => el('option', { value: p.id, text: `${p.name}${p.address ? ' — ' + p.address : ''}`, selected: saved.store === p.id || null }))),
  };
  let mode = saved.mode && (saved.mode !== 'ship' || shippable) ? saved.mode : 'delivery';
  if (mode === 'pickup' && !s.pickupStores.length) mode = 'delivery';
  let card = 'tok_test_visa_4242';
  const field = (label, input, cls) => el('label', { class: 'f' + (cls ? ' ' + cls : '') }, label, input);
  const addr = el('div', { class: 'fields' }, field('Street address', f.line1), field('Apartment, suite (optional)', f.line2),
    field('City', f.city, 'third'), field('State', f.state, 'third'), field('ZIP', f.postal, 'third'), field('Delivery notes (optional)', f.notes));
  const pick = el('div', { class: 'fields' }, field('Pick up at', f.store));
  const choice = (value, title, sub, fee, enabled) => {
    const input = el('input', { type: 'radio', name: 'mode', value, checked: mode === value || null, disabled: !enabled || null });
    const row = el('label', { class: 'choice' + (mode === value ? ' on' : '') + (enabled ? '' : ' off') }, input, el('div', {}, el('b', { text: title }), el('span', { text: sub })), el('span', { class: 'fee', text: fee }));
    input.addEventListener('change', () => { mode = value; paintMode(); refresh(); });
    return row;
  };
  const freeOver = s.freeDeliveryOverMinor && Number(cart.subtotalMinor) >= Number(s.freeDeliveryOverMinor);
  const modes = el('div', { class: 'choices' },
    choice('delivery', 'Delivery and setup', 'From our distribution center, set up in your room.', freeOver ? 'Free' : money(s.deliveryFeeMinor), true),
    s.pickupStores.length ? choice('pickup', 'Pick up in store', 'We will text or email when it is ready.', 'Free', true) : null,
    choice('ship', 'Ship by parcel', shippable ? 'Small items only, by carrier to your door.' : 'Not available: something in your cart needs delivery.', money(s.shipFeeMinor), shippable));
  function paintMode() {
    for (const r of modes.querySelectorAll('.choice')) r.classList.toggle('on', r.querySelector('input').checked);
    addr.hidden = mode === 'pickup'; pick.hidden = mode !== 'pickup';
  }
  const cards = el('div', { class: 'choices' }, [
    ['tok_test_visa_4242', 'Visa ending 4242', 'Test card: approves'],
    ['tok_test_mastercard_4444', 'Mastercard ending 4444', 'Test card: approves'],
    ['tok_test_decline', 'Card ending 0002', 'Test card: declines'],
  ].map(([tok, title, sub]) => {
    const input = el('input', { type: 'radio', name: 'card', value: tok, checked: tok === card || null });
    input.addEventListener('change', () => { card = tok; for (const r of cards.querySelectorAll('.choice')) r.classList.toggle('on', r.querySelector('input').checked); });
    return el('label', { class: 'choice' + (tok === card ? ' on' : '') }, input, el('div', {}, el('b', { text: title }), el('span', { text: sub })), el('span'));
  }));
  const sum = el('aside', { class: 'summary' }, loading('Adding it up…'));
  let coupon = '';
  const couponIn = el('input', { type: 'text', maxlength: '24', autocomplete: 'off', placeholder: 'Coupon code' });
  const couponMsg = el('p', { class: 'small', 'aria-live': 'polite' });
  const couponBtn = el('button', { class: 'btn', type: 'button', onclick: () => { coupon = couponIn.value.trim().toUpperCase(); couponMsg.textContent = coupon ? 'Checking…' : ''; refresh(); } }, 'Apply');
  const err = el('div', { 'aria-live': 'assertive' });
  const placeBtn = el('button', { class: 'btn primary block', type: 'submit' }, 'Place order');
  const body = () => ({
    cartId: S.cart.id, lines: S.cart.lines.map((l) => ({ productId: l.productId, choices: l.choices, qty: l.qty, sectional: l.sectional || undefined })),
    email: f.email.value.trim(), name: f.name.value.trim(), phone: f.phone.value.trim(), marketingOk: f.marketing.checked,
    fulfillment: mode, pickupLocationId: mode === 'pickup' ? f.store.value : undefined,
    address: mode === 'pickup' ? undefined : { line1: f.line1.value, line2: f.line2.value, city: f.city.value, state: f.state.value.toUpperCase(), postal: f.postal.value },
    notes: f.notes.value, paymentToken: card, couponCode: coupon || undefined,
  });
  const remember = () => sess.set(`shop.${SLUG}.form`, { email: f.email.value, name: f.name.value, phone: f.phone.value, marketing: f.marketing.checked,
    line1: f.line1.value, line2: f.line2.value, city: f.city.value, state: f.state.value, postal: f.postal.value, store: f.store.value, mode });
  let qseq = 0, qt = 0;
  async function refresh() {
    const my = ++qseq;
    try {
      const b = body(); delete b.paymentToken;
      const r = await post('/quote', b);
      if (my !== qseq) return;
      if (coupon) couponMsg.textContent = r.coupon ? `${r.coupon.label} applied.` : '';
      sum.replaceChildren(el('div', { class: 'contents' },
        el('h2', { text: 'Order summary' }),
        r.lines.map((l) => el('div', { class: 'sr-row small' }, el('span', { text: `${l.qty} × ${l.description}` }), el('span', { text: money2(l.lineMinor) }))),
        el('div', { class: 'sr-row' }, el('span', { text: 'Merchandise' }), el('span', { text: money2(r.merchandiseMinor) })),
        r.coupon ? el('div', { class: 'sr-row' }, el('span', { text: `Coupon ${r.coupon.code}` }), el('span', { text: '−' + money2(r.coupon.discountMinor) })) : null,
        r.fee ? el('div', { class: 'sr-row' }, el('span', { text: r.fee.label }), el('span', { text: Number(r.fee.minor) ? money2(r.fee.minor) : 'Free' })) : null,
        el('div', { class: 'sr-row' }, el('span', { text: `Tax (${(r.taxRateBps / 100).toFixed(r.taxRateBps % 100 ? 2 : 0)}%)` }), el('span', { text: money2(r.taxMinor) })),
        el('div', { class: 'sr-row tot' }, el('span', { text: 'Total' }), el('span', { text: money2(r.totalMinor) })),
        r.promisedOn ? el('p', { class: 'small', text: `${mode === 'pickup' ? 'Ready for pickup' : 'Arrives'} by about ${day(r.promisedOn)}.` }) : null));
    } catch (e) {
      if (my !== qseq) return;
      // A code that doesn't apply is explained by the field and dropped; the rest of the order still adds up.
      if (coupon && /coupon|code|used|expired|purchase of at least|starts on|can't be used/i.test(e.message)) { couponMsg.textContent = e.message; coupon = ''; refresh(); return; }
      sum.replaceChildren(el('h2', { text: 'Order summary' }), el('p', { class: 'small muted', text: e.message }));
    }
  }
  const later = () => { clearTimeout(qt); qt = setTimeout(refresh, 450); };
  for (const k of ['line1', 'city', 'state', 'postal']) f[k].addEventListener('input', later);
  f.store.addEventListener('change', refresh);
  let placing = false;
  async function place(e) {
    e.preventDefault();
    if (placing) return;
    remember();
    placing = true; placeBtn.disabled = true; placeBtn.replaceChildren(el('span', { class: 'spin' }), 'Placing your order…');
    err.replaceChildren();
    try {
      const r = await post('/checkout', body());
      sess.set(`shop.${SLUG}.last`, r.order);
      S.cart = { id: newId(), lines: [] }; saveCart();
      location.hash = '#/order/' + encodeURIComponent(r.order.number);
    } catch (x) {
      err.replaceChildren(el('div', { class: 'alert', role: 'alert', text: x.message }));
      err.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } finally { placing = false; if (placeBtn.isConnected) { placeBtn.disabled = false; placeBtn.textContent = 'Place order'; } }
  }
  setMain(el('div', { class: 'wrap' },
    crumbs(el('a', { href: '#/', text: 'Home' }), el('a', { href: '#/cart', text: 'Cart' }), el('span', { text: 'Checkout' })),
    el('h1', { text: 'Checkout' }),
    el('form', { class: 'co', novalidate: true, onsubmit: place },
      el('div', {},
        el('section', { class: 'panel' }, el('h2', { text: 'Contact' }),
          el('div', { class: 'fields' }, field('Email', f.email), field('Full name', f.name, 'half'), field('Mobile phone (optional)', f.phone, 'half'),
            el('label', { class: 'check' }, f.marketing, 'Send me offers and new arrivals'))),
        el('section', { class: 'panel' }, el('h2', { text: 'How do you want it?' }), modes, addr, pick),
        el('section', { class: 'panel' }, el('h2', { text: 'Coupon' }), el('div', { class: 'coupon' }, couponIn, couponBtn), couponMsg),
        el('section', { class: 'panel' }, el('h2', { text: 'Payment' }), cards,
          el('p', { class: 'testnote', text: 'Test mode: nothing is charged. A live store puts its card processor’s secure field here, and card numbers never reach this store’s server.' }),
          s.financingUrl ? el('p', { class: 'small' }, 'Want to pay over time? ', el('a', { href: s.financingUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Apply for financing' }), ' first, then come back.') : null),
        err, placeBtn),
      sum)));
  paintMode();
  refresh();
}

function orderBlock(o) {
  return [
    el('div', { class: 'facts' },
      el('div', { class: 'fact' }, el('span', { class: 'k', text: 'Order' }), el('span', { class: 'v', text: o.number })),
      el('div', { class: 'fact' }, el('span', { class: 'k', text: 'Status' }), el('span', { class: 'v', text: o.statusText })),
      el('div', { class: 'fact' }, el('span', { class: 'k', text: o.fulfillment === 'pickup' ? 'Pickup at' : o.fulfillment === 'ship' ? 'Shipping to' : 'Delivering to' }),
        el('span', { class: 'v', text: o.fulfillment === 'pickup' ? o.location : (o.shipTo || '') })),
      o.promisedOn ? el('div', { class: 'fact' }, el('span', { class: 'k', text: 'Expected by' }), el('span', { class: 'v', text: day(o.promisedOn) })) : null,
      el('div', { class: 'fact' }, el('span', { class: 'k', text: 'Total' }), el('span', { class: 'v', text: money2(o.totalMinor) })),
      el('div', { class: 'fact' }, el('span', { class: 'k', text: 'Paid' }), el('span', { class: 'v', text: `${money2(o.paidMinor)}${o.card ? ' · ' + o.card : ''}` }))),
    el('div', { class: 'olines' }, o.lines.map((l) => el('div', { class: 'oline' },
      el('div', { class: 'd' }, el('div', { text: `${l.qty} × ${l.description}` }), el('div', { class: 's', text: l.statusText })),
      el('div', { class: 'a', text: money2(l.lineMinor) })))),
  ];
}
function pageOrder(number) {
  const o = sess.get(`shop.${SLUG}.last`);
  if (!o || o.number !== number) { location.hash = '#/status'; return; }
  setMain(el('div', { class: 'wrap narrow' },
    el('div', { class: 'ok-h' }, sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('circle', { cx: 12, cy: 12, r: 10 }), sv('path', { d: 'M7.5 12.5l3 3 6-6.5' })),
      el('h1', { text: 'Thank you — your order is in' })),
    el('p', { class: 'muted', text: `A confirmation is on its way. Keep your order number, ${o.number}, to check on it any time.` }),
    orderBlock(o),
    el('div', { class: 'buyrow' }, el('a', { class: 'btn', href: '#/status', text: 'Check order status' }), el('a', { class: 'btn primary', href: '#/', text: 'Keep shopping' }))));
}
function pageStatus() {
  const num = el('input', { type: 'text', autocomplete: 'off', maxlength: '30', placeholder: 'SO-000123' });
  const em = el('input', { type: 'email', autocomplete: 'email', maxlength: '120' });
  const out = el('div', { 'aria-live': 'polite' });
  const btn = el('button', { class: 'btn primary', type: 'submit' }, 'Find my order');
  setMain(el('div', { class: 'wrap narrow' },
    crumbs(el('a', { href: '#/', text: 'Home' }), el('span', { text: 'Order status' })),
    el('h1', { text: 'Check an order' }),
    el('p', { class: 'muted', text: 'Use the order number from your confirmation and the email you ordered with. Store orders work here too.' }),
    el('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; out.replaceChildren(loading('Looking…'));
      try { const o = await post('/order-status', { number: num.value.trim(), email: em.value.trim() }); out.replaceChildren(...orderBlock(o)); }
      catch (x) { out.replaceChildren(el('div', { class: 'alert', text: x.message })); }
      finally { btn.disabled = false; }
    } }, el('div', { class: 'fields' }, el('label', { class: 'f half' }, 'Order number', num), el('label', { class: 'f half' }, 'Email', em)), el('div', { class: 'buyrow' }, btn)),
    out));
}
/** The contact / request-a-quote form. It becomes a lead for the store's salespeople. */
const UTM_KEY = `shop.${SLUG}.utm`;
function leadForm(o) {
  const saved = sess.get(`shop.${SLUG}.form`) || {};
  const f = { name: el('input', { type: 'text', autocomplete: 'name', maxlength: '80', value: saved.name || '' }),
    email: el('input', { type: 'email', autocomplete: 'email', maxlength: '120', value: saved.email || '' }),
    phone: el('input', { type: 'tel', autocomplete: 'tel', maxlength: '20', value: saved.phone || '' }),
    msg: el('textarea', { maxlength: '500', value: o.message || '' }),
    store: el('select', {}, el('option', { value: '', text: 'Any store' }), S.site.pickupStores.map((p) => el('option', { value: p.id, text: p.name }))),
    em: el('input', { type: 'checkbox' }), sms: el('input', { type: 'checkbox' }),
    trap: el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'sr', 'aria-hidden': 'true' }) };
  f.msg.value = o.message || '';
  const out = el('div', { 'aria-live': 'polite' });
  const btn = el('button', { class: 'btn primary', type: 'submit' }, o.kind === 'quote' ? 'Request a quote' : 'Send');
  const field = (label, input, cls) => el('label', { class: 'f' + (cls ? ' ' + cls : '') }, label, input);
  return el('form', { class: 'leadform', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true; out.replaceChildren();
    try {
      const utm = sess.get(UTM_KEY) || {};
      const r = await post('/lead', { kind: o.kind, name: f.name.value, email: f.email.value, phone: f.phone.value, message: f.msg.value, pickupLocationId: f.store.value || undefined,
        productId: o.productId, choices: o.choices ? o.choices() : undefined, qty: o.qty ? o.qty() : undefined, consentEmail: f.em.checked, consentSms: f.sms.checked, website: f.trap.value,
        utmSource: utm.source, utmMedium: utm.medium, utmCampaign: utm.campaign });
      out.replaceChildren(el('div', { class: 'notice', text: `${r.message}${r.reference ? ` Your reference is ${r.reference}.` : ''}` }));
      btn.hidden = true;
    } catch (x) { out.replaceChildren(el('div', { class: 'alert', role: 'alert', text: x.message })); btn.disabled = false; }
  } },
  el('div', { class: 'fields' }, field('Name', f.name, 'half'), field('Mobile phone', f.phone, 'half'), field('Email', f.email), field('Message', f.msg),
    S.site.pickupStores.length ? field('Nearest store', f.store) : null,
    el('label', { class: 'check' }, f.em, 'Email me offers and new arrivals'),
    el('label', { class: 'check' }, f.sms, 'Text me offers (msg & data rates may apply; reply STOP to opt out)'), f.trap),
  out, el('div', { class: 'buyrow' }, btn));
}
function pageContact() {
  setMain(el('div', { class: 'wrap narrow' }, crumbs(el('a', { href: '#/', text: 'Home' }), el('span', { text: 'Contact us' })),
    el('h1', { text: 'Contact us' }), el('p', { class: 'muted', text: 'Questions, a quote, or a design consultation — a salesperson will get back to you.' }),
    el('div', { class: 'panel' }, leadForm({ kind: 'contact' }))));
}
function pagePolicies() {
  setMain(el('div', { class: 'wrap narrow' }, crumbs(el('a', { href: '#/', text: 'Home' }), el('span', { text: 'Policies' })),
    el('h1', { text: 'Delivery, pickup and returns' }), el('p', { class: 'desc', text: S.site.policies || 'Ask the store.' })));
}

// ---------------------------------------------------------------- router
function showErr(e) { setMain(errorBox(e, route)); }
async function route() {
  const raw = (location.hash || '#/').slice(1);
  const qi = raw.indexOf('?');
  const path = qi < 0 ? raw : raw.slice(0, qi), query = qi < 0 ? '' : raw.slice(qi + 1);
  const parts = path.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch (_) { return x; } });
  const params = new URLSearchParams(query || '');
  markNav(null);
  if (parts[0] !== 'search') $('#q').value = '';
  setMain(loading());
  window.scrollTo(0, 0);
  try {
    if (!parts.length) await pageHome();
    else if (parts[0] === 'c') await pageList(parts.slice(1).join('/'), params);
    else if (parts[0] === 'search') await pageList('', params);
    else if (parts[0] === 'p') await pageProduct(parts[1]);
    else if (parts[0] === 'cart') await pageCart();
    else if (parts[0] === 'checkout') await pageCheckout();
    else if (parts[0] === 'order') pageOrder(parts.slice(1).join('/'));
    else if (parts[0] === 'status') pageStatus();
    else if (parts[0] === 'policies') pagePolicies();
    else if (parts[0] === 'contact') pageContact();
    else await pageHome();
    const h1 = $('#main h1'); if (h1 && parts.length) main().focus({ preventScroll: true });
  } catch (e) { showErr(e); }
}
async function boot() {
  const u = new URLSearchParams(location.search);
  if (u.get('utm_source') || u.get('utm_campaign')) sess.set(UTM_KEY, { source: u.get('utm_source') || '', medium: u.get('utm_medium') || '', campaign: u.get('utm_campaign') || '' });
  try { S.site = await get('/site'); }
  catch (e) { setMain(errorBox(e, boot)); return; }
  paintChrome();
  $('#search').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#q').value.trim(); location.hash = v ? '#/search?q=' + encodeURIComponent(v) : '#/search'; });
  window.addEventListener('hashchange', route);
  window.addEventListener('storage', (e) => { if (e.key === KEY) { S.cart = store.get(KEY) || S.cart; paintCount(); } });
  route();
}
document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
