// The trade portal page. Everything shown comes from /trade/<slug>/api; data
// is placed with textContent only (never innerHTML). The session token lives
// in sessionStorage and goes in the x-trade-session header; it is never in a
// cookie, so no other site can ride on it. Prices shown are the server's:
// orders send products, options and quantities, never a price. Card numbers
// never pass through this page: the test processor uses tokens.
(() => {
'use strict';

const SLUG = document.body.dataset.slug;
const API = `/trade/${SLUG}/api`;
const $ = (s, r = document) => r.querySelector(s);
const KEY = `trade.${SLUG}.session`;

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
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (m) => USD.format(Number(m || 0) / 100);
const DAYF = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const day = (iso) => (iso ? DAYF.format(new Date(String(iso).slice(0, 10) + 'T00:00:00Z')) : '');
const cap = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
function newId() { const b = new Uint8Array(16); crypto.getRandomValues(b); return 't' + [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 26); }
const sess = {
  get() { try { return sessionStorage.getItem(KEY) || ''; } catch (_) { return ''; } },
  set(v) { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch (_) { /* private mode */ } },
};
let toastT = 0;
function toast(text) { const t = $('#toast'); t.textContent = text; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3800); }

class SignedOut extends Error {}
async function call(path, body) {
  const headers = { accept: 'application/json' };
  const tok = sess.get();
  if (tok) headers['x-trade-session'] = tok;
  const opts = body === undefined ? { method: 'GET', headers, cache: 'no-store', credentials: 'omit' }
    : { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-erp-shop': '1' }, body: JSON.stringify(body), cache: 'no-store', credentials: 'omit' };
  let res;
  try { res = await fetch(API + path, opts); } catch (_) { throw new Error('We couldn’t reach the store. Check your connection and try again.'); }
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty */ }
  if (res.status === 401) { sess.set(''); throw new SignedOut((data && data.error) || 'Sign in again.'); }
  if (!res.ok) throw new Error((data && data.error) || `Something went wrong (${res.status}). Try again.`);
  return data;
}
const get = (p) => call(p);
const post = (p, b) => call(p, b || {});

// ------------------------------------------------------------- helpers
const wrap = (...kids) => el('div', { class: 'tr-wrap' }, ...kids);
const card = (...kids) => el('section', { class: 'tr-card' }, ...kids);
const row = (label, amount, cls) => el('div', { class: 'tr-row' + (cls ? ' ' + cls : '') }, el('span', { text: label }), el('span', { class: 'amt', text: amount }));
const field = (label, control, hint, wide) => el('label', { class: 'tr-field' + (wide ? ' wide' : '') }, el('span', { text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null);
const input = (attrs) => el('input', { type: 'text', ...attrs });
const select = (options, value, attrs) => el('select', attrs || {}, options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value ?? '') || null }, l)));
const chip = (tone, text) => el('span', { class: 'tr-chip ' + (tone || ''), text });
const errBox = () => el('div', { 'aria-live': 'polite' });
const showErr = (box, e) => box.replaceChildren(el('div', { class: 'tr-err', role: 'alert', text: e.message || String(e) }));
const loading = () => el('div', { class: 'loading' }, el('span', { class: 'spin' }), 'Loading…');
const setMain = (...kids) => $('#main').replaceChildren(...kids);
async function busy(btn, fn) {
  const was = btn.textContent; btn.disabled = true; btn.textContent = 'Working…';
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = was; }
}
const btn = (label, onclick, primary) => el('button', { type: 'button', class: 'btn' + (primary ? ' primary' : ''), onclick }, label);
const smallBtn = (label, onclick) => el('button', { type: 'button', class: 'btn tr-small', onclick }, label);
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const CARDS = [['tok_test_visa_4242', 'Visa ending 4242 (test: approves)'], ['tok_test_mastercard_4444', 'Mastercard ending 4444 (test: approves)'], ['tok_test_decline', 'Card ending 0002 (test: declines)']];
const STATUS = { draft: 'Not placed', open: 'Confirmed', fulfilling: 'Partly delivered', fulfilled: 'Complete', closed: 'Complete', cancelled: 'Cancelled' };
const TONE = { open: 'good', fulfilling: 'warn', fulfilled: 'good', closed: 'good', cancelled: 'bad' };

let ME = null;
function nav(on) {
  const n = $('#nav');
  if (!sess.get()) { n.hidden = true; n.replaceChildren(); return; }
  n.hidden = false;
  const links = [['#/', 'Account'], ['#/catalog', 'Catalog'], ['#/projects', 'Projects'], ['#/orders', 'Orders'], ['#/invoices', 'Invoices']];
  n.replaceChildren(...links.map(([h, l]) => el('a', { href: h, class: on === h ? 'on' : null, 'aria-current': on === h ? 'page' : null, text: l })),
    el('button', { type: 'button', text: 'Sign out', onclick: async () => { try { await post('/signout'); } catch (_) { /* gone already */ } sess.set(''); ME = null; go('#/'); } }));
}

// ------------------------------------------------------------- sign in
function pageSignIn() {
  nav(null);
  const email = input({ type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'you@studio.com' });
  const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '6-digit code' });
  const err = errBox();
  const codeStep = el('div', { class: 'tr-form', hidden: true }, field('Code from the email', code, 'It works for 10 minutes.'));
  const send = btn('Email me a code', async (e) => {
    err.replaceChildren();
    try { const r = await busy(e.currentTarget, () => post('/code', { email: email.value.trim() })); err.replaceChildren(el('div', { class: 'tr-ok', text: r.message })); codeStep.hidden = false; verify.hidden = false; code.focus(); }
    catch (x) { showErr(err, x); }
  }, true);
  const verify = btn('Sign in', async (e) => {
    try {
      const r = await busy(e.currentTarget, () => post('/verify', { email: email.value.trim(), code: code.value.trim() }));
      sess.set(r.token); ME = null; go('#/');
    } catch (x) { showErr(err, x); }
  }, true);
  verify.hidden = true;
  setMain(wrap(el('div', { class: 'tr-wrap tr-narrow' },
    el('h1', { text: 'Trade sign-in' }),
    el('p', { class: 'tr-muted', text: 'Designers, contractors, stagers and hospitality buyers: sign in with the email on your trade account. We email you a code; there is no password.' }),
    card(el('div', { class: 'tr-form' }, field('Email', email)), codeStep, el('div', { class: 'tr-acts' }, send, verify), err),
    card(el('h2', { text: 'No trade account yet?' }), el('p', { class: 'tr-muted', text: 'Apply in a few minutes. We review every application and email you when it is approved.' }),
      el('div', { class: 'tr-acts' }, el('a', { class: 'btn', href: '#/apply', text: 'Apply for a trade account' }))))));
}

function pageApply() {
  nav(null);
  const f = { company: input({ autocomplete: 'organization' }), kind: select([['designer', 'Interior designer'], ['contractor', 'Contractor'], ['stager', 'Home stager'], ['hospitality', 'Hospitality buyer'], ['other', 'Other']], 'designer'),
    contact: input({ autocomplete: 'name' }), email: input({ type: 'email', autocomplete: 'email' }), phone: input({ type: 'tel', autocomplete: 'tel' }), website: input({ type: 'url', placeholder: 'https://' }),
    line1: input({ autocomplete: 'address-line1' }), city: input({ autocomplete: 'address-level2' }), state: input({ maxlength: '2', autocomplete: 'address-level1' }), postal: input({ inputmode: 'numeric', autocomplete: 'postal-code' }),
    resale: input({}), rstate: input({ maxlength: '2' }), rexp: input({ type: 'date' }), notes: el('textarea', { maxlength: '1000' }) };
  const err = errBox();
  const send = btn('Send the application', async (e) => {
    try {
      await busy(e.currentTarget, () => post('/apply', { companyName: f.company.value, kind: f.kind.value, contactName: f.contact.value, email: f.email.value, phone: f.phone.value, website: f.website.value,
        address: { line1: f.line1.value, city: f.city.value, state: f.state.value, postal: f.postal.value }, resaleNumber: f.resale.value, resaleState: f.rstate.value,
        resaleExpires: f.rexp.value || null, notes: f.notes.value }));
      setMain(wrap(el('div', { class: 'tr-wrap tr-narrow' }, el('h1', { text: 'Thank you' }), card(el('p', { text: 'Your application is in. We review it and email you when your trade account is open; then sign in with your email.' }),
        el('div', { class: 'tr-acts' }, el('a', { class: 'btn primary', href: '#/', text: 'Back to sign-in' }))))));
    } catch (x) { showErr(err, x); }
  }, true);
  setMain(wrap(el('div', { class: 'tr-wrap tr-narrow' }, el('h1', { text: 'Apply for a trade account' }),
    card(el('h2', { text: 'Your business' }), el('div', { class: 'tr-form two' }, field('Business name', f.company, null, true), field('Kind of business', f.kind), field('Your name', f.contact),
      field('Email', f.email), field('Phone', f.phone), field('Website', f.website, null, true), field('Street', f.line1, null, true), field('City', f.city), field('State', f.state), field('ZIP', f.postal))),
    card(el('h2', { text: 'Resale certificate' }), el('p', { class: 'tr-muted', text: 'Needed to buy tax-exempt for resale. You can add it later.' }),
      el('div', { class: 'tr-form two' }, field('Certificate number', f.resale, null, true), field('State', f.rstate), field('Expires', f.rexp))),
    card(field('Anything we should know', f.notes), el('div', { class: 'tr-acts' }, send, el('a', { class: 'btn', href: '#/', text: 'Cancel' })), err))));
}

// ------------------------------------------------------------- account
async function me() { if (!ME) ME = await get('/me'); return ME; }

async function pageHome() {
  nav('#/');
  const m = await me();
  const cr = m.credit;
  const certs = m.certificates.length ? el('div', { class: 'tr-list' }, m.certificates.map((x) => el('div', { class: 'tr-item' },
    el('div', { class: 'tr-row' }, el('span', { class: 't', text: `${x.number} · ${x.state}` }), x.current ? chip('good', 'Current') : chip('bad', x.status === 'void' ? 'Void' : 'Expired')),
    el('span', { class: 'd', text: `${cap(x.reason)}${x.expiresOn ? ' · expires ' + day(x.expiresOn) : ' · no expiry'}` }))))
    : el('p', { class: 'tr-muted', text: 'No resale certificate on file. Orders are taxed until you send one to the store.' });
  setMain(wrap(el('h1', { text: m.company }), el('p', { class: 'tr-muted', text: `${m.contact} · ${m.email}${m.priceList ? ' · trade pricing ' + m.priceList : ''}` }),
    // Each figure opens what is behind it: the invoices, the orders, and how the limit is used.
    el('div', { class: 'tr-tiles' },
      el('a', { class: 'tr-tile', href: '#/credit' }, el('span', { class: 'k', text: 'Available on account' }), el('span', { class: 'v', text: money(cr.availableMinor) })),
      el('a', { class: 'tr-tile', href: '#/invoices' }, el('span', { class: 'k', text: 'Owed now' }), el('span', { class: 'v', text: money(cr.balanceMinor) })),
      el('a', { class: 'tr-tile', href: '#/orders' }, el('span', { class: 'k', text: 'On order, not yet billed' }), el('span', { class: 'v', text: money(cr.onOrderMinor) })),
      el('a', { class: 'tr-tile', href: '#/credit' }, el('span', { class: 'k', text: 'Credit limit' }), el('span', { class: 'v', text: money(cr.limitMinor) }))),
    card(el('h2', { text: 'Terms' }), el('p', { text: Number(cr.limitMinor) > 0 ? `Net ${cr.termsDays} on account, up to ${money(cr.limitMinor)}.` : 'Card only for now. Ask the store about terms.' })),
    card(el('h2', { text: 'Resale certificates' }), certs),
    el('div', { class: 'tr-acts' }, el('a', { class: 'btn primary', href: '#/catalog', text: 'Browse at trade prices' }), el('a', { class: 'btn', href: '#/projects', text: 'Your projects' }))));
}

/** How the credit limit is used: what is owed, what is on order, what is left. */
async function pageCredit() {
  nav('#/');
  const cr = (await me()).credit;
  const line = (k, v, href) => el(href ? 'a' : 'div', { class: 'tr-item', href: href || null }, el('div', { class: 'tr-row' }, el('span', { class: 't', text: k }), el('span', { class: 'amt', text: v })));
  setMain(wrap(backLink(), el('h1', { text: 'Your account' }),
    card(el('div', { class: 'tr-list' }, line('Credit limit', money(cr.limitMinor)), line('Less owed now', money(-Number(cr.balanceMinor)), '#/invoices'),
      line('Less on order, not yet billed', money(-Number(cr.onOrderMinor)), '#/orders'), line('Available on account', money(cr.availableMinor))),
      el('p', { class: 'tr-muted', text: Number(cr.limitMinor) > 0 ? `Net ${cr.termsDays} on account. Available never goes below zero.` : 'Card only for now. Ask the store about terms.' }))));
}
/** Back to where you came from in the portal (the phone's Back does the same). */
/** The account summary's on-order figure, over the orders list that holds it. */
const notBilled = () => (ME && ME.credit ? el('div', {}, row('On order, not yet billed', money(ME.credit.onOrderMinor)),
  el('p', { class: 'tr-muted', text: 'Open and part-delivered orders, less what is paid or already invoiced.' })) : null);
// Each portal page's history entry carries its depth in the portal, so Back only steps back to a portal page:
// opened straight onto a page (depth 0), it goes to the account page instead of off the portal.
let DEPTH = -1;
function markDepth() {
  const st = history.state;
  if (!st || typeof st.portal !== 'number') history.replaceState({ ...(st || {}), portal: DEPTH + 1 }, '');
  DEPTH = history.state.portal;
}
const backLink = () => el('div', { class: 'tr-acts' }, el('button', { type: 'button', class: 'btn', text: '‹ Back',
  onclick: () => (history.state && history.state.portal > 0 ? history.back() : go('#/')) }));

// ------------------------------------------------------------- catalog
const ph = (p) => el('div', { class: 'ph', 'aria-hidden': 'true', text: (p.category || p.name || '').slice(0, 1) });
async function pageCatalog(qs) {
  nav('#/catalog');
  const m = await me();
  const params = new URLSearchParams(qs || '');
  const q = input({ type: 'search', placeholder: 'Search the catalog', value: params.get('q') || '', 'aria-label': 'Search' });
  const catSel = select([['', 'All categories'], ...m.store.categories.map((c) => [c.name, c.name])], params.get('category') || '', { 'aria-label': 'Category' });
  const apply = () => go(`#/catalog?${new URLSearchParams({ q: q.value.trim(), category: catSel.value })}`);
  catSel.addEventListener('change', apply);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
  const list = await get(`/catalog?${new URLSearchParams({ q: params.get('q') || '', category: params.get('category') || '' })}`);
  setMain(wrap(el('h1', { text: 'Catalog at trade prices' }), el('div', { class: 'tr-form two' }, field('Search', q), field('Category', catSel)),
    list.products.length ? el('div', { class: 'tr-grid' }, list.products.map((p) => el('a', { class: 'tr-prod', href: `#/p/${p.id}` }, ph(p), el('div', { class: 'bd' },
      el('span', { class: 'tr-muted', text: [p.brand, p.category].filter(Boolean).join(' · ') }), el('b', { text: p.name }),
      el('div', { class: 'tr-row' }, el('span', { class: 'was', text: money(p.retailMinor) }), el('span', { class: 'amt', text: p.tradeMinor ? `${p.configurable ? 'from ' : ''}${money(p.tradeMinor)}` : 'Price on request' }))))))
      : el('p', { class: 'tr-muted', text: 'Nothing matches. Try another search.' })));
}

async function pageProduct(id) {
  nav('#/catalog');
  const [p, projects] = await Promise.all([get(`/products/${id}`), get('/projects')]);
  const picked = {};
  for (const d of p.defaults || []) picked[d.group] = d.option;
  const priceRow = el('div', { class: 'tr-row' }, el('span', { class: 'was', text: money(p.retailMinor) }), el('span', { class: 'amt', text: money(p.tradeMinor) }));
  const desc = el('p', { class: 'tr-muted', text: '' });
  const err = errBox();
  const choices = () => Object.entries(picked).filter(([, v]) => v).map(([group, option]) => ({ group, option }));
  async function reprice() {
    try { const r = await post('/price', { productId: id, choices: choices() });
      priceRow.replaceChildren(el('span', { class: 'was', text: `Retail ${money(r.retailMinor)}` }), el('span', { class: 'amt', text: `Trade ${money(r.unitPriceMinor)}` })); desc.textContent = r.description; err.replaceChildren(); }
    catch (x) { showErr(err, x); }
  }
  const opts = (p.options || []).map((g) => {
    const s = select([...(g.required ? [] : [['', 'None']]), ...g.options.map((o) => [o.code, `${o.label}${Number(o.priceDeltaMinor) ? ` (${Number(o.priceDeltaMinor) > 0 ? '+' : ''}${money(o.priceDeltaMinor)} retail)` : ''}`])], picked[g.code] || '');
    s.addEventListener('change', () => { picked[g.code] = s.value; reprice(); });
    return field(g.label + (g.required ? '' : ' (optional)'), s);
  });
  const qty = input({ type: 'number', min: '1', max: '50', value: '1', inputmode: 'numeric' });
  const projSel = select([['', 'Pick a project'], ...projects.filter((x) => x.status === 'open').map((x) => [x.id, `${x.name}${x.client_name ? ' · ' + x.client_name : ''}`])], '');
  const add = btn('Add to project', async (e) => {
    if (!projSel.value) { showErr(err, new Error('Pick the project to add it to, or start one under Projects.')); return; }
    try { await busy(e.currentTarget, () => post(`/projects/${projSel.value}/items`, { productId: id, choices: choices(), qty: Number(qty.value || 1) })); toast('Added to the project'); }
    catch (x) { showErr(err, x); }
  }, true);
  const sheet = btn('Tear sheet', async (e) => {
    try { const r = await busy(e.currentTarget, () => post('/sheet', { productId: id })); window.open(r.path, '_blank', 'noopener'); } catch (x) { showErr(err, x); }
  });
  setMain(wrap(el('a', { href: '#/catalog', text: '‹ Catalog' }), el('h1', { text: p.name }), el('p', { class: 'tr-muted', text: [p.brand, p.collection, p.color].filter(Boolean).join(' · ') }),
    card(priceRow, desc, p.description ? el('p', { text: p.description }) : null, opts.length ? el('div', { class: 'tr-form two' }, opts) : null,
      p.sectional
        ? el('p', { class: 'tr-muted', text: 'Sectionals are built with your rep for now: tell us the pieces, layout and cover you want and we will quote it to your project. The tear sheet shows the family.' })
        : el('div', { class: 'tr-form two' }, field('Quantity', qty), field('Project', projSel)),
      el('div', { class: 'tr-acts' }, p.sectional ? null : add, sheet), err)));
  if (opts.length) reprice();
}

// ------------------------------------------------------------ projects
async function pageProjects() {
  nav('#/projects');
  const list = await get('/projects');
  const name = input({ placeholder: 'Living room 2027' }), client = input({ placeholder: 'Client name' });
  const err = errBox();
  const make = btn('Start the project', async (e) => {
    try { const r = await busy(e.currentTarget, () => post('/projects', { name: name.value, clientName: client.value })); go(`#/project/${r.id}`); } catch (x) { showErr(err, x); }
  }, true);
  setMain(wrap(el('h1', { text: 'Projects' }),
    list.length ? el('div', { class: 'tr-list' }, list.map((p) => el('a', { class: 'tr-item', href: `#/project/${p.id}` },
      el('div', { class: 'tr-row' }, el('span', { class: 't', text: p.name }), chip(p.status === 'open' ? 'good' : '', cap(p.status))),
      el('span', { class: 'd', text: [p.number, p.client_name, `${p.items} item${p.items === 1 ? '' : 's'}`, p.budget_minor ? `budget ${money(p.budget_minor)}` : null].filter(Boolean).join(' · ') }))))
      : el('p', { class: 'tr-muted', text: 'No projects yet. Start one for each room or client.' }),
    card(el('h2', { text: 'New project' }), el('div', { class: 'tr-form two' }, field('Project name', name), field('Client', client)), el('div', { class: 'tr-acts' }, make), err)));
}

function openingRow(o) {
  const kind = select([['door', 'Door'], ['window', 'Window'], ['opening', 'Open archway']], o.kind || 'window', { 'aria-label': 'Kind' });
  const wall = input({ value: o.wall || '', placeholder: 'Wall', 'aria-label': 'Wall' });
  const w = input({ inputmode: 'decimal', value: o.widthIn || '', placeholder: 'Width in', 'aria-label': 'Width in inches' });
  const h = input({ inputmode: 'decimal', value: o.heightIn || '', placeholder: 'Height in', 'aria-label': 'Height in inches' });
  const box = el('div', { class: 'tr-opening' }, kind, wall, w, h);
  box.append(btn('Remove', () => box.remove()));
  box.read = () => ({ kind: kind.value, wall: wall.value, widthIn: w.value || null, heightIn: h.value || null });
  return box;
}

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('That photo could not be read.'));
    r.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a photo.'));
      img.onload = () => {
        const max = 1600, k = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', 0.8));
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

async function pageProject(id) {
  nav('#/projects');
  const [p, m] = await Promise.all([get(`/projects/${id}`), me()]);
  const a = p.client_address || {};
  const f = { name: input({ value: p.name }), client: input({ value: p.client_name || '' }), line1: input({ value: a.line1 || '' }), city: input({ value: a.city || '' }),
    state: input({ value: a.state || '', maxlength: '2' }), postal: input({ value: a.postal || '', inputmode: 'numeric' }),
    L: input({ inputmode: 'decimal', value: p.length_in || '' }), W: input({ inputmode: 'decimal', value: p.width_in || '' }), H: input({ inputmode: 'decimal', value: p.height_in || '' }),
    notes: el('textarea', { maxlength: '2000' }), budget: input({ inputmode: 'decimal', value: p.budget_minor ? (Number(p.budget_minor) / 100).toFixed(2) : '' }) };
  f.notes.value = p.style_notes || '';
  const openings = el('div', { class: 'tr-form' }, (p.openings || []).map(openingRow));
  const err = errBox();
  const save = btn('Save the project', async (e) => {
    try {
      await busy(e.currentTarget, () => post(`/projects/${id}`, { name: f.name.value, clientName: f.client.value,
        clientAddress: f.line1.value || f.postal.value ? { line1: f.line1.value, city: f.city.value, state: f.state.value, postal: f.postal.value } : null,
        lengthIn: f.L.value, widthIn: f.W.value, heightIn: f.H.value, openings: [...openings.children].map((x) => x.read()), styleNotes: f.notes.value, budget: f.budget.value }));
      toast('Project saved'); render();
    } catch (x) { showErr(err, x); }
  }, true);
  const photoIn = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': 'Add a photo' });
  photoIn.addEventListener('change', async () => {
    const file = photoIn.files && photoIn.files[0]; if (!file) return;
    try { const dataUrl = await resizeImage(file); await post(`/projects/${id}/photos`, { dataUrl, caption: file.name.replace(/\.[a-z]+$/i, '') }); toast('Photo added'); render(); } catch (x) { showErr(err, x); }
  });
  const items = p.items.length ? el('div', { class: 'tr-list' }, p.items.map((it) => {
    const q = input({ type: 'number', min: '1', max: '50', value: String(it.qty), inputmode: 'numeric', 'aria-label': 'Quantity' });
    q.addEventListener('change', async () => { try { await post(`/projects/${id}/items/${it.id}`, { qty: Number(q.value) }); render(); } catch (x) { showErr(err, x); } });
    return el('div', { class: 'tr-item' }, el('div', { class: 'tr-row' }, el('span', { class: 't', text: it.description }), el('span', { class: 'amt', text: it.lineMinor ? money(it.lineMinor) : '' })),
      el('span', { class: 'd', text: [cap(it.stage), it.unitPriceMinor ? `${money(it.unitPriceMinor)} each` : it.problem, it.orderNumber ? `order ${it.orderNumber}` : null].filter(Boolean).join(' · ') }),
      it.stage === 'bought' ? null : el('div', { class: 'tr-acts tr-itemacts' }, field('Qty', q), smallBtn('Remove', async () => { try { await post(`/projects/${id}/items/${it.id}`, { remove: true }); render(); } catch (x) { showErr(err, x); } })));
  })) : el('p', { class: 'tr-muted', text: 'Nothing yet. Add pieces from the catalog.' });
  setMain(wrap(el('a', { href: '#/projects', text: '‹ Projects' }), el('h1', { text: p.name }), el('p', { class: 'tr-muted', text: [p.number, p.client_name, p.quoted_at ? 'quoted ' + day(p.quoted_at) : null].filter(Boolean).join(' · ') }),
    card(el('h2', { text: 'Pieces' }), items, row('Total at trade prices', money(p.itemsTotalMinor)), p.budget_minor ? row('Budget', money(p.budget_minor)) : null,
      el('div', { class: 'tr-acts' }, el('a', { class: 'btn', href: '#/catalog', text: 'Add from the catalog' }))),
    p.items.some((i) => i.stage !== 'bought') ? orderCard(p, m) : null,
    card(el('h2', { text: 'Room and client' }), el('div', { class: 'tr-form two' }, field('Project name', f.name), field('Client', f.client), field('Client street', f.line1, null, true), field('City', f.city),
      field('State', f.state), field('ZIP', f.postal), field('Length (in)', f.L), field('Width (in)', f.W), field('Ceiling height (in)', f.H), field('Budget', f.budget), field('Style notes', f.notes, null, true)),
      el('h3', { text: 'Doors and windows' }), openings, el('div', { class: 'tr-acts' }, btn('Add a door or window', () => openings.append(openingRow({}))), save), err),
    card(el('h2', { text: 'Photos' }), p.photos.length ? el('div', { class: 'tr-photos' }, p.photos.map((x) => el('figure', {}, el('img', { src: x.data_url, alt: x.caption || 'Room photo' }),
      el('figcaption', { class: 'tr-muted', text: x.caption || '' }), btn('Remove', async () => { try { await post(`/projects/${id}/photos/${x.id}/remove`); render(); } catch (e) { showErr(err, e); } }))))
      : el('p', { class: 'tr-muted', text: 'No photos yet.' }), field('Add a photo', photoIn)),
    p.orders.length ? card(el('h2', { text: 'Orders' }), el('div', { class: 'tr-list' }, p.orders.map((o) => el('a', { class: 'tr-item', href: `#/order/${o.id}` },
      el('div', { class: 'tr-row' }, el('span', { class: 't', text: o.number }), el('span', { class: 'amt', text: money(o.total_minor) })), el('span', { class: 'd', text: STATUS[o.status] || o.status }))))) : null));
}

function orderCard(p, m) {
  const ful = select([['delivery', 'Delivery'], ['pickup', 'Pick up at a store'], ['ship', 'Parcel shipping']], 'delivery');
  const shipTo = select([['client', 'Ship to the client'], ['business', 'Ship to my business'], ['address', 'Another address']], p.client_address && p.client_address.line1 ? 'client' : 'business');
  const store = select(m.store.pickupStores.map((s) => [s.id, s.name]), '');
  const ad = { line1: input({ placeholder: 'Street' }), city: input({ placeholder: 'City' }), state: input({ placeholder: 'State', maxlength: '2' }), postal: input({ placeholder: 'ZIP', inputmode: 'numeric' }) };
  const addrBox = el('div', { class: 'tr-form two' }, field('Street', ad.line1, null, true), field('City', ad.city), field('State', ad.state), field('ZIP', ad.postal));
  const resale = el('input', { type: 'checkbox' });
  const canAccount = Number(m.credit.limitMinor) > 0;
  const payBy = select([...(canAccount ? [['account', `On account (net ${m.credit.termsDays})`]] : []), ['card', 'Card']], canAccount ? 'account' : 'card');
  const cardSel = select(CARDS, CARDS[0][0], { 'aria-label': 'Card' });
  const ref = input({ placeholder: 'Your PO or reference' });
  const out = el('div'); const err = errBox();
  const cart = newId();
  const show = () => { addrBox.hidden = !(ful.value !== 'pickup' && shipTo.value === 'address'); shipTo.parentElement.hidden = ful.value === 'pickup'; store.parentElement.hidden = ful.value !== 'pickup'; cardSel.parentElement.hidden = payBy.value !== 'card'; };
  const body = () => ({ projectId: p.id, fulfillment: ful.value, shipTo: shipTo.value, pickupLocationId: store.value || null,
    address: { line1: ad.line1.value, city: ad.city.value, state: ad.state.value, postal: ad.postal.value }, resale: resale.checked, payBy: payBy.value, paymentToken: cardSel.value, reference: ref.value, cartId: cart });
  const quote = btn('Price it (quote)', async (e) => {
    try {
      const q = await busy(e.currentTarget, () => post('/quote', body()));
      out.replaceChildren(el('div', { class: 'tr-list' }, q.lines.map((l) => el('div', { class: 'tr-item' }, el('div', { class: 'tr-row' }, el('span', { text: `${l.qty} × ${l.description}` }), el('span', { class: 'amt', text: money(l.lineMinor) }))))),
        q.fee ? row(q.fee.label, money(q.fee.minor)) : null, row(q.resale ? 'Sales tax (resale exempt where the certificate applies)' : 'Sales tax', money(q.taxMinor)), row('Total', money(q.totalMinor), 'grand'),
        q.onAccount ? el('p', { class: 'tr-muted', text: `Available on account: ${money(q.credit.availableMinor)}.` }) : null);
      err.replaceChildren();
    } catch (x) { showErr(err, x); }
  });
  const place = btn('Place the order', async (e) => {
    try { const r = await busy(e.currentTarget, () => post('/order', body())); ME = null; toast(`Order ${r.order.number} placed`); go(`#/order/${r.orderId}`); } catch (x) { showErr(err, x); }
  }, true);
  for (const s of [ful, shipTo, payBy]) s.addEventListener('change', show);
  const c = card(el('h2', { text: 'Quote and order' }), el('div', { class: 'tr-form two' }, field('How it gets there', ful), field('Ship to', shipTo), field('Store', store), field('Pay', payBy), field('Card', cardSel), field('Reference', ref)),
    addrBox, el('label', { class: 'tr-check' }, resale, el('span', { text: 'For resale (tax exempt under our resale certificate)' })),
    el('p', { class: 'tr-muted', text: 'Shipped to a client without resale, the order is taxed where it is delivered. Test mode: no card is charged.' }),
    el('div', { class: 'tr-acts' }, quote, place), out, err);
  setTimeout(show, 0);
  return c;
}

// -------------------------------------------------------------- orders
async function pageOrders() {
  nav('#/orders');
  const list = await get('/orders');
  setMain(wrap(backLink(), el('h1', { text: 'Orders' }), notBilled(), list.length ? el('div', { class: 'tr-list' }, list.map((o) => el('a', { class: 'tr-item', href: `#/order/${o.id}` },
    el('div', { class: 'tr-row' }, el('span', { class: 't', text: o.number }), el('span', { class: 'amt', text: money(o.total_minor) })),
    el('span', { class: 'd', text: [day(o.ordered_at), o.project, o.delivery_on ? 'delivery ' + day(o.delivery_on) : o.promised_on ? 'expected ' + day(o.promised_on) : null].filter(Boolean).join(' · ') }),
    el('span', {}, chip(TONE[o.status] || '', STATUS[o.status] || o.status)))))
    : el('p', { class: 'tr-muted', text: 'No orders yet.' })));
}

async function pageOrder(id) {
  nav('#/orders');
  const o = await get(`/orders/${id}`);
  const err = errBox();
  const sheet = btn('Tear sheet', async (e) => { try { const r = await busy(e.currentTarget, () => post('/sheet', { orderId: id })); window.open(r.path, '_blank', 'noopener'); } catch (x) { showErr(err, x); } });
  setMain(wrap(el('a', { href: '#/orders', text: '‹ Orders' }), el('h1', { text: `Order ${o.number}` }), el('p', {}, chip(TONE[o.status] || '', o.statusText)),
    card(el('div', { class: 'tr-list' }, o.lines.map((l) => el('div', { class: 'tr-item' }, el('div', { class: 'tr-row' }, el('span', { class: 't', text: `${l.qty} × ${l.description}` }), el('span', { class: 'amt', text: money(l.lineMinor) })),
      el('span', { class: 'd', text: l.statusText })))), row('Sales tax', money(o.taxMinor)), row('Total', money(o.totalMinor)), row('Paid', money(o.paidMinor)),
      o.shipTo ? el('p', { class: 'tr-muted', text: `Ships to ${o.shipTo}` }) : null, o.promisedOn ? el('p', { class: 'tr-muted', text: `Expected ${day(o.promisedOn)}` }) : null),
    card(el('h2', { text: 'Delivery' }), o.deliveries.length ? el('div', { class: 'tr-list' }, o.deliveries.map((d) => el('div', { class: 'tr-item' }, el('div', { class: 'tr-row' },
      el('span', { class: 't', text: d.scheduled_on ? day(d.scheduled_on) : 'Date to come' }), chip(d.status === 'delivered' ? 'good' : '', cap(d.status))))))
      : el('p', { class: 'tr-muted', text: 'The store books the delivery once everything is in.' })),
    card(el('h2', { text: 'Invoices' }), o.invoices.length ? el('div', { class: 'tr-list' }, o.invoices.map((i) => el('a', { class: 'tr-item', href: '#/invoices' },
      el('div', { class: 'tr-row' }, el('span', { class: 't', text: i.number }), el('span', { class: 'amt', text: money(i.total_minor) })), el('span', { class: 'd', text: `due ${day(i.due_date)} · ${cap(i.status)}` }))))
      : el('p', { class: 'tr-muted', text: 'Invoiced when the goods are delivered.' })),
    el('div', { class: 'tr-acts' }, sheet), err));
}

async function pageInvoices() {
  nav('#/invoices');
  const d = await get('/invoices');
  const err = errBox();
  const items = d.invoices.map((i) => {
    const open = Number(i.openMinor) > 0;
    const cardSel = select(CARDS, CARDS[0][0], { 'aria-label': 'Card' });
    const key = newId();   // one key per invoice on this page: a second press of the same payment is refused, not charged
    const pay = btn(`Pay ${money(i.openMinor)}`, async (e) => {
      try { const r = await busy(e.currentTarget, () => post(`/invoices/${i.id}/pay`, { paymentToken: cardSel.value, key })); ME = null; toast(`Paid ${money(r.paidMinor)} · ${r.card}`); render(); } catch (x) { showErr(err, x); }
    }, true);
    return el('div', { class: 'tr-item' }, el('div', { class: 'tr-row' }, el('span', { class: 't', text: `${i.number}${i.order_number ? ' · ' + i.order_number : ''}` }), el('span', { class: 'amt', text: money(i.total_minor) })),
      el('span', { class: 'd', text: `${day(i.invoice_date)} · due ${day(i.due_date)}` }), el('span', {}, open ? chip(i.pastDue ? 'bad' : 'warn', `${money(i.openMinor)} open${i.pastDue ? ', past due' : ''}`) : chip('good', 'Paid')),
      open ? el('div', { class: 'tr-acts' }, field('Card', cardSel), pay) : null);
  });
  setMain(wrap(backLink(), el('h1', { text: 'Invoices' }), row('Owed now', money(d.credit.balanceMinor)),
    row('Open on these invoices', money(d.invoices.reduce((a, i) => a + Math.max(0, Number(i.openMinor) || 0), 0))), items.length ? el('div', { class: 'tr-list' }, items) : el('p', { class: 'tr-muted', text: 'No invoices yet.' }),
    el('p', { class: 'tr-muted', text: 'Test mode: no card is charged.' }), err));
}

// --------------------------------------------------------------- router
async function render() {
  markDepth();
  const h = location.hash || '#/';
  const [path, qs] = h.slice(1).split('?');
  const parts = path.split('/').filter(Boolean);
  try {
    if (parts[0] === 'apply') return pageApply();
    if (!sess.get()) return pageSignIn();
    setMain(loading());
    if (!parts.length) return await pageHome();
    if (parts[0] === 'catalog') return await pageCatalog(qs);
    if (parts[0] === 'p' && parts[1]) return await pageProduct(parts[1]);
    if (parts[0] === 'projects') return await pageProjects();
    if (parts[0] === 'project' && parts[1]) return await pageProject(parts[1]);
    if (parts[0] === 'orders') return await pageOrders();
    if (parts[0] === 'order' && parts[1]) return await pageOrder(parts[1]);
    if (parts[0] === 'invoices') return await pageInvoices();
    if (parts[0] === 'credit') return await pageCredit();
    return await pageHome();
  } catch (e) {
    if (e instanceof SignedOut) { ME = null; return pageSignIn(); }
    setMain(wrap(el('div', { class: 'tr-err', role: 'alert', text: e.message || String(e) }), el('div', { class: 'tr-acts' }, btn('Try again', render))));
  }
}
window.addEventListener('hashchange', render);
render();
})();
