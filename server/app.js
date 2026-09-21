// Pentex ERP -- the app. Every figure comes from /api; every piece of data is
// placed with textContent. Nothing here decides a rule: the server and the
// engine behind it refuse what is not allowed, and this page shows why.
(() => {
'use strict';

// ================================================================== basics
const $ = (s, root = document) => root.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
// C = circle, D = dashed circle, R = rounded rect, anything else is a path.
const ICONS = {
  ok: 'C12 12 9|M8 12.5l2.7 2.7L16 9.6', clock: 'C12 12 9|M12 7v5l3 2',
  fail: 'M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z|M9.5 9.5l5 5M14.5 9.5l-5 5',
  pending: 'D12 12 9', pause: 'C12 12 9|M10 9v6M14 9v6', warn: 'M12 3.5L21.5 20h-19z|M12 10v4.5M12 17.2v.3',
  hold: 'M12 3l8 3v6c0 5-3.6 8-8 9-4.4-1-8-4-8-9V6z|M12 8.5v4.5M12 16v.3',
  upload: 'M12 15.5V4M7.5 8.5L12 4l4.5 4.5|M4 14.5v4A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-4',
  file: 'M6 3h8l4 4v14H6z|M14 3v4h4|M9 12h6M9 16h6', refresh: 'M20 11.5A8 8 0 1 1 17.3 6|M20 4v5h-5',
  out: 'M9.5 20h-4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4|M15.5 16.5L20 12l-4.5-4.5M20 12H9.5', x: 'M6 6l12 12M18 6L6 18',
  info: 'C12 12 9|M12 11v5.5M12 7.9v.2', server: 'R4 4 16 6.5|R4 13.5 16 6.5|M8 7.25h.01M8 16.75h.01',
  plug: 'M9 3v4M15 3v4|M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0z|M12 16v5', mail: 'R3 5 18 14|M3.5 6.5L12 13l8.5-6.5',
  bolt: 'M13 3L5 13.5h6L10 21l8-10.5h-6z', none: 'D12 12 9|M8.5 12h7', chev: 'M7 10l5 5 5-5',
  home: 'M3.5 11L12 3.5l8.5 7.5|M5.5 9.5V20h13V9.5', check: 'M4 12.5l5 5L20 6.5',
  people: 'C9 8 3.2|M3 20c0-3.4 2.7-5.5 6-5.5s6 2.1 6 5.5|M16 5.5a3.2 3.2 0 0 1 0 6|M17.5 14.9c2 .8 3.5 2.6 3.5 5.1',
  book: 'M6 3h12v18H6z|M9 3v18', cash: 'R3 6 18 12|C12 12 2.6|M6.5 9.5v5M17.5 9.5v5',
  recon: 'M4 8h13l-3-3M20 16H7l3 3', feed: 'M4 5h16M4 12h16M4 19h10', more: 'M5 12h.01M12 12h.01M19 12h.01',
  bank: 'M3 9.5L12 4l9 5.5|M5.5 10.5v7M10 10.5v7M14 10.5v7M18.5 10.5v7|M3.5 20h17', plus: 'M12 5v14M5 12h14',
  building: 'R5 3 14 18|M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2', user: 'C12 8 3.5|M5 20c0-3.9 3.1-6.2 7-6.2s7 2.3 7 6.2',
};
function icon(name, cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i' + (cls ? ' ' + cls : ''));
  s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
  for (const part of (ICONS[name] || '').split('|')) {
    if (!part) continue;
    const kind = part[0], n = part.slice(1).trim().split(/\s+/);
    let e;
    if (kind === 'C' || kind === 'D') {
      e = document.createElementNS(SVGNS, 'circle');
      e.setAttribute('cx', n[0]); e.setAttribute('cy', n[1]); e.setAttribute('r', n[2]);
      if (kind === 'D') e.setAttribute('stroke-dasharray', '2.6 3.1');
    } else if (kind === 'R') {
      e = document.createElementNS(SVGNS, 'rect');
      e.setAttribute('x', n[0]); e.setAttribute('y', n[1]); e.setAttribute('width', n[2]); e.setAttribute('height', n[3]); e.setAttribute('rx', '1.6');
    } else { e = document.createElementNS(SVGNS, 'path'); e.setAttribute('d', part); }
    s.append(e);
  }
  return s;
}
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
const frag = (...kids) => { const f = document.createDocumentFragment(); for (const k of kids.flat(Infinity)) if (k != null && k !== false) f.append(k instanceof Node ? k : document.createTextNode(String(k))); return f; };
const chip = (tone, ic, label, chev) => el('span', { class: 'chip ' + tone }, icon(ic), el('span', { text: label }), chev ? icon('chev', 'chev') : null);

// ------------------------------------------------------------------ words
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (m) => { const n = Number(m || 0) / 100; const s = USD.format(Math.abs(n)); return n < 0 ? '−' + s : s; };
const fmtDay = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const fmtShort = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const fmtDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtStamp = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtLive = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const parseDay = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayLabel = (s) => (s ? fmtDay.format(parseDay(s)) : '');
const shortDay = (s) => (s ? fmtShort.format(parseDay(s)) : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const cap = (s) => { s = String(s || '').trim(); return s ? s[0].toUpperCase() + s.slice(1) : s; };
const sentence = (s) => { s = cap(s); return !s || /[.!?]$/.test(s) ? s : s + '.'; };
const hours = (h) => { const n = Number(h || 0); return (Math.round(n * 100) / 100).toString(); };
function ago(iso) {
  const t = new Date(iso).getTime(); const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return plural(h, 'hour') + ' ago';
  const d = Math.round(h / 24); if (d === 1) return 'yesterday'; if (d < 7) return `${d} days ago`;
  return fmtDate.format(new Date(t));
}
// Dates inside text the server wrote (an entry's description, a match label)
// read as "Sep 11" here. A date inside a bill number, like INV-2026-09-11, is
// left alone.
const human = (s) => String(s == null ? '' : s)
  .replace(/(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/g, (m) => shortDay(m))
  // An older payroll entry wrote its date the long way; it reads the same as the rest.
  .replace(/\b(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) (\d{1,2}) \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}(?: \([^)]*\))?/g, (m, mon, day) => `${mon} ${Number(day)}`);
const ROLE = { owner: 'owner', controller: 'controller', approver: 'approver', ap_clerk: 'A/P clerk', viewer: 'viewer' };
const roles = (list) => (list || []).map((r) => ROLE[r] || r).join(', ');
const subjTitle = (s) => (s.date && s.kind !== 'bill' ? `${s.title} for ${dayLabel(s.date)}` : s.title);
// A bill's number never breaks across lines: "Meridian Supply · MS-260907".
const billName = (vendor, ref) => (ref ? frag(vendor, ' · ', el('span', { class: 'nw', text: ref })) : vendor);
const subjName = (s) => (s.kind === 'bill' && s.vendor ? billName(s.vendor, s.ref) : subjTitle(s));
const subjDetail = (s) => [human(s.detail), s.kind === 'bill' && s.date ? `dated ${shortDay(s.date)}` : null].filter(Boolean).join(' · ');
const size = (n) => (n < 1024 ? `${n} bytes` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const nextBusinessDay = () => { const d = new Date(); do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); return isoDay(d); };
const todayIso = () => isoDay(new Date());

// ------------------------------------------------------------- storage
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
};

// ------------------------------------------------------------------ state
const S = { me: null, companies: [], co: null, people: [], person: null, route: { screen: 'home', sub: '' },
            seq: 0, billTab: 'attention', pnlPeriod: 'mtd', pnlCol: 'total', tbAsOf: null, openGaps: new Set() };

// -------------------------------------------------------------------- api
class Stop extends Error {}
function friendly(e) {
  // fetch() fails with a TypeError when the network does; any other TypeError is a fault in this page.
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) return 'Couldn’t reach the service. A trial service that has been idle takes about a minute to wake; try again shortly.';
  if (e instanceof TypeError || e instanceof ReferenceError) return `This page hit a fault (${e.message}). Reload it; if it happens again, it needs fixing.`;
  return sentence(e && e.message ? e.message : String(e));
}
async function api(path, opts = {}) {
  const headers = { 'x-pentex-erp': '1' };
  if (S.person) headers['x-pentex-as'] = S.person.id;
  let body = opts.body;
  if (body !== undefined && !(body instanceof Blob)) { headers['content-type'] = 'application/json'; body = JSON.stringify(body); }
  const res = await fetch(path, { method: opts.method || 'GET', credentials: 'same-origin', cache: 'no-store', headers, body });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty */ }
  if (res.status === 401) { showSignIn(S.me ? 'Your session has ended. Sign in again.' : ''); throw new Stop(); }
  if (!res.ok) throw new Error((data && data.error) || `The service answered ${res.status}`);
  return data;
}
const coApi = (p, opts) => api(`/api/c/${S.co.id}${p}`, opts);
const post = (p, body) => coApi(p, { method: 'POST', body: body || {} });

// ================================================================= frame
function show(which) {
  $('#boot').hidden = which !== 'boot';
  $('#signin').hidden = which !== 'signin';
  $('#app').hidden = which !== 'app';
}
let toastTimer = 0;
function toast(text, tone) {
  const t = $('#toast');
  t.replaceChildren(icon(tone === 'critical' ? 'fail' : tone === 'warning' ? 'warn' : 'ok'), el('span', { text }));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, tone === 'critical' ? 8000 : 4500);
}
const ORIGINAL = new WeakMap();
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { if (!ORIGINAL.has(btn)) ORIGINAL.set(btn, [...btn.childNodes]); btn.disabled = true; btn.replaceChildren(el('span', { class: 'spin' }), label || 'Working…'); }
  else { btn.disabled = false; if (ORIGINAL.has(btn)) { btn.replaceChildren(...ORIGINAL.get(btn)); ORIGINAL.delete(btn); } }
}
/** Run an action from a button: busy while it runs, a toast after, then redraw. */
async function act(btn, fn, okText, opts = {}) {
  busy(btn, true, opts.busyLabel);
  try {
    const r = await fn();
    if (okText) toast(typeof okText === 'function' ? okText(r) : okText, 'good');
    if (opts.close) opts.close();
    await render();
    return r;
  } catch (e) {
    if (e instanceof Stop) return null;
    if (opts.errorInto) opts.errorInto(e); else toast(friendly(e), 'critical');
    return null;
  } finally { if (btn.isConnected) busy(btn, false); }
}

// ------------------------------------------------------------------ dialogs
function openDialog(title, sub, opts = {}) {
  const dlg = el('dialog', { class: [opts.wide ? 'wide' : '', opts.sheet ? 'sheet' : ''].join(' ').trim() || null, 'aria-label': title });
  const body = el('div', { class: 'dlg-b' });
  // A piece that is not there (null or false) is left out, as el() leaves it
  // out; the DOM's own append() would print it as the word "null".
  body.append = (...kids) => Element.prototype.append.call(body, frag(...kids));
  const close = () => { if (dlg.open) dlg.close(); };
  dlg.append(el('div', { class: 'dlg-h' },
    el('div', {}, el('h2', { text: title }), sub ? el('div', { class: 'sub', text: sub }) : null),
    el('button', { class: 'icon-btn x', type: 'button', 'aria-label': 'Close', onclick: close }, icon('x'))), body);
  dlg.addEventListener('close', () => { dlg.remove(); if (opts.onClose) opts.onClose(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, body, close };
}
function resultBox(tone, ic, title, text) {
  return el('div', { class: 'result ' + tone }, icon(ic), el('div', {}, el('b', { text: title }), text ? el('span', { text }) : null));
}
function loadingNode(text) { return el('div', { class: 'loading' }, el('span', { class: 'spin' }), text || 'Loading…'); }
async function fillDialog(d, loader) {
  d.body.replaceChildren(loadingNode());
  try { d.body.replaceChildren(await loader()); }
  catch (e) { if (!(e instanceof Stop)) d.body.replaceChildren(resultBox('critical', 'fail', 'Couldn’t load it', friendly(e))); }
}
/** Ask for a reason. Resolves to the text, or null if they cancel. */
function askReason({ title, sub, label, placeholder, confirm, optional, lead }) {
  return new Promise((resolve) => {
    let answered = false;
    const d = openDialog(title, sub, { onClose: () => { if (!answered) resolve(null); } });
    const ta = el('textarea', { maxlength: '500', placeholder: placeholder || '' });
    const err = el('div');
    const go = el('button', { class: 'btn primary', type: 'button', onclick: () => {
      const v = ta.value.trim();
      if (!v && !optional) { err.replaceChildren(resultBox('warning', 'warn', 'Say why first', 'A reason goes with it, so the next person knows what happened.')); ta.focus(); return; }
      answered = true; resolve(v); d.close();
    } }, confirm || 'Confirm');
    d.body.append(lead ? el('p', { class: 'lead', text: lead }) : null,
      el('label', { class: 'field' }, el('span', { text: label || 'Why' }), ta),
      el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
    ta.focus();
  });
}

// ---------------------------------------------------------------- pieces
function head(title, actions, eyebrow) {
  return el('div', { class: 'head' },
    el('div', {}, el('p', { class: 'eyebrow', text: eyebrow || S.co.name }), el('h1', { text: title })),
    actions && actions.length ? el('div', { class: 'actions' }, actions) : null);
}
function section(title, note, actions, ...kids) {
  return el('section', { class: 'block' },
    el('div', { class: 'block-head' }, el('h2', { class: 'eyebrow', text: title }),
      note ? el('span', { class: 'note-r', text: note }) : null,
      actions && actions.length ? el('div', { class: 'actions' }, actions) : null),
    ...kids);
}
function tile({ label, value, suffix, tone, ic, text, word, onClick }) {
  const v = el('div', { class: 'v' + (word ? ' word' : '') }, el('span', { text: value }), suffix ? el('small', { text: suffix }) : null);
  // The figure is sized to the tile: its width in characters goes to the
  // stylesheet, which scales the type so $1,331,392.54 fits on one line.
  if (!word) v.style.setProperty('--n', String(Math.max(6, String(value).length + (suffix ? suffix.length * 0.5 + 0.4 : 0))));
  return el(onClick ? 'button' : 'div', { class: `tile tone-${tone || 'neutral'}`, type: onClick ? 'button' : null, onclick: onClick || null },
    el('div', { class: 'tl', text: label }), v,
    text ? el('div', { class: 's' }, icon(ic || 'info'), el('span', { text })) : null);
}
/** A row of tiles whose figures share one size: the longest one sets it. */
function tilesRow(...list) {
  const row = el('div', { class: 'tiles' }, list);
  const vs = [...row.querySelectorAll('.v:not(.word)')];
  const n = Math.max(6, ...vs.map((v) => Number(v.style.getPropertyValue('--n')) || 6));
  for (const v of vs) v.style.setProperty('--n', String(n));
  return row;
}
function empty(title, sub, quiet) {
  return el('div', { class: 'empty' + (quiet ? ' quiet' : '') }, icon(quiet ? 'info' : 'ok'),
    el('div', {}, el('b', { text: title }), sub ? el('div', { class: 'sub', text: sub }) : null));
}
function item({ title, detail, amount, badge, why, acts, onClick, pick }) {
  return el('div', { class: 'li' + (onClick ? ' click' : '') + (pick ? ' with-pick' : ''), onclick: onClick || null,
    tabindex: onClick ? '0' : null, role: onClick ? 'button' : null,
    onkeydown: onClick ? (e) => { if (e.key === 'Enter') onClick(e); } : null },
    pick ? el('div', { class: 'pick' }, pick) : null,
    el('div', { class: 't' }, title),
    amount ? el('div', { class: 'amt', text: amount }) : null,
    badge ? el('div', { class: 'b' }, badge) : null,
    detail ? el('div', { class: 'd', text: detail }) : null,
    why ? el('div', { class: 'why', text: why }) : null,
    acts && acts.length ? el('div', { class: 'acts', onclick: (e) => e.stopPropagation() }, acts) : null);
}
/** A long list shows its first few, and the rest on a tap. */
function capped(nodes, n, what) {
  if (nodes.length <= n + 2) return nodes;
  const rest = nodes.slice(n);
  const btn = el('button', { class: 'more-row', type: 'button', onclick: () => btn.replaceWith(...rest) }, `Show ${rest.length} more${what ? ' ' + what : ''}`);
  return [...nodes.slice(0, n), btn];
}
function seg(options, value, onChange) {
  return el('div', { class: 'seg', role: 'group' }, options.map(([v, label, n]) =>
    el('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => onChange(v) }, label, n != null ? el('span', { class: 'n', text: String(n) }) : null)));
}
function errorBox(e, retry) {
  return el('div', { class: 'alert', role: 'alert' }, icon('fail'),
    el('div', {}, el('div', { text: friendly(e) }), retry ? el('button', { class: 'linkbtn', type: 'button', onclick: retry }, 'Try again') : null));
}
function trialBanner() {
  if (!S.me || !S.me.trial) return null;
  const ends = S.me.trialEnds ? ` Render deletes this database on ${fmtDate.format(parseDay(S.me.trialEnds))}.` : '';
  return el('div', { class: 'banner' }, icon('info'), el('span', { text: `Trial environment with placeholder companies and made-up activity.${ends} Nothing real should go in yet.` }));
}
const tbl = (headRow, rows, opts = {}) => el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' + (opts.cls ? ' ' + opts.cls : '') },
  el('thead', {}, el('tr', {}, headRow.map(([t, cls]) => el('th', { class: cls || null, text: t })))), el('tbody', {}, rows)));
const td = (text, cls) => el('td', { class: cls || null }, text);

// ============================================================ navigation
const SCREENS = [
  ['home', 'Home', 'home'], ['approvals', 'Approvals', 'check'], ['payables', 'Payables', 'file'], ['payroll', 'Payroll', 'people'],
  ['books', 'Books', 'book'], ['cash', 'Cash', 'cash'], ['recon', 'Reconcile', 'recon'], ['feeds', 'Feeds', 'feed'], ['setup', 'Setup', 'building'],
];
const TABS = ['home', 'approvals', 'payables', 'books'];
let badgeCount = 0;
function go(screen, sub) { location.hash = `#/${S.co.id}/${screen}${sub ? '/' + sub : ''}`; }
function renderNav() {
  const cur = S.route.screen;
  const badge = (name) => (name === 'approvals' && badgeCount ? el('span', { class: 'badge', text: String(badgeCount), 'aria-label': `${badgeCount} waiting on you` }) : null);
  $('#nav').replaceChildren(...SCREENS.map(([name, label, ic]) =>
    el('a', { href: `#/${S.co.id}/${name}`, class: cur === name ? 'on' : null, 'aria-current': cur === name ? 'page' : null }, icon(ic), label, badge(name))));
  $('#tabbar').replaceChildren(
    ...TABS.map((name) => { const [, label, ic] = SCREENS.find((s) => s[0] === name);
      return el('a', { href: `#/${S.co.id}/${name}`, class: cur === name ? 'on' : null }, icon(ic), label === 'Payables' ? 'Bills' : label, badge(name)); }),
    el('button', { type: 'button', class: TABS.includes(cur) ? null : 'on', onclick: openMore }, icon('more'), 'More'));
  $('#co-name').textContent = S.co.name;
  $('#as-name').textContent = S.person ? `${S.person.name}${S.person.roles.length ? ' · ' + roles(S.person.roles) : ''}` : 'Pick a person';
  $('#who').replaceChildren('Signed in as ', el('b', { text: S.me.viewer.name }));
}
function openMore() {
  const d = openDialog('More', S.co.name, { sheet: true });
  d.body.append(el('div', { class: 'menu' },
    SCREENS.filter(([n]) => !TABS.includes(n)).map(([name, label, ic]) =>
      el('button', { type: 'button', class: S.route.screen === name ? 'on' : null, onclick: () => { d.close(); go(name); } }, icon(ic), label)),
    el('button', { type: 'button', onclick: () => { d.close(); render(); } }, icon('refresh'), 'Refresh'),
    el('button', { type: 'button', onclick: () => { d.close(); signOut(); } }, icon('out'), 'Sign out')));
}
function openCompanyPicker() {
  const d = openDialog('Switch company', `${plural(S.companies.length, 'company', 'companies')} kept here`, { sheet: true });
  const groups = new Map();
  for (const c of S.companies) { if (!groups.has(c.tenant_name)) groups.set(c.tenant_name, []); groups.get(c.tenant_name).push(c); }
  const pick = (c) => el('button', { type: 'button', class: c.id === S.co.id ? 'on' : null,
    onclick: async () => { d.close(); await setCompany(c); go(S.route.screen); } },
    icon('building'), el('span', {}, c.name, el('span', { class: 'sub', text: ` · ${c.vertical === 'rto' ? 'rent-to-own' : c.vertical}` })));
  for (const [tenant, list] of groups) {
    d.body.append(el('div', { class: 'group' }, el('div', { class: 'k', text: `Client: ${tenant}` }), el('div', { class: 'menu' }, list.map(pick))));
  }
  d.body.append(el('div', { class: 'group' }, el('div', { class: 'menu' },
    el('button', { type: 'button', onclick: () => { d.close(); openNewCompany(); } }, icon('plus'), 'Add a company'))));
}
function openPersonPicker() {
  const d = openDialog('Act as', `Whose approvals and whose name go on what you do in ${S.co.name}`, { sheet: true });
  d.body.append(
    el('p', { class: 'lead', text: 'The rules follow the person: the one who enters a bill cannot approve it, and whoever builds a run cannot release it. Switch here to see each person’s queue.' }),
    el('div', { class: 'menu' }, S.people.map((p) => el('button', { type: 'button', class: S.person && p.id === S.person.id ? 'on' : null,
      onclick: () => { setPerson(p); d.close(); renderNav(); render(); } },
      icon('user'), el('span', {}, p.name, el('span', { class: 'sub', text: p.roles.length ? ` · ${roles(p.roles)}` : ' · no roles here' }))))));
}
function setPerson(p) { S.person = p; if (p) store.set(`erp.as.${S.co.id}`, p.id); }
/**
 * The version running, and when it went live, under the name top left: every
 * deploy changes both. The page loads app.js?v=<version>-<start time in base 36>,
 * so the start time comes from there; without it, the version alone shows.
 */
function showVersion() {
  const brand = $('.side-top .brand');
  if (!brand || !S.me) return;
  const tag = document.querySelector('script[src*="app.js?v="]');
  const v = tag ? new URL(tag.src, location.href).searchParams.get('v') || '' : '';
  const at = v.includes('-') ? Number.parseInt(v.slice(v.lastIndexOf('-') + 1), 36) : NaN;
  const since = Number.isFinite(at) && at > 0 ? `Deployed ${fmtLive.format(new Date(at))}` : null;
  let line = brand.querySelector('.ver');
  if (!line) { line = el('span', { class: 'ver' }); brand.append(line); }
  line.replaceChildren(el('span', { text: `Version ${S.me.version}` }), since ? el('span', { text: since }) : '');
}
/** Overriding a gate or writing an entry is a sign-off: the controller's or the owner's. The server checks it too. */
const signsOff = () => !!(S.person && S.person.roles.some((r) => r === 'controller' || r === 'owner'));
async function setCompany(c) {
  S.co = c;
  store.set('erp.company', c.id);
  S.people = await api(`/api/c/${c.id}/people`);
  const saved = store.get(`erp.as.${c.id}`);
  const byName = S.people.find((p) => p.name.toLowerCase() === (S.me.viewer.name || '').toLowerCase());
  const owner = S.people.find((p) => p.roles.includes('owner'));
  setPerson(S.people.find((p) => p.id === saved) || byName || owner || S.people[0] || null);
  S.billTab = 'attention';
}
function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { co: parts[0] || null, screen: parts[1] || 'home', sub: parts[2] || '' };
}
async function onRoute() {
  const r = parseHash();
  if (!S.co) return;
  if (r.co && r.co !== S.co.id) {
    const c = S.companies.find((x) => x.id === r.co);
    if (c) { try { await setCompany(c); } catch (e) { if (!(e instanceof Stop)) toast(friendly(e), 'critical'); return; } }
  }
  S.route = { screen: SCREENS.some(([n]) => n === r.screen) ? r.screen : 'home', sub: r.sub };
  renderNav();
  await render();
}
async function refreshBadge() {
  try {
    const a = await coApi('/approvals');
    badgeCount = a.mine.length;
    renderNav();
  } catch (_) { /* the screen will show any error */ }
}
async function render() {
  const seq = ++S.seq;
  const main = $('#main');
  main.replaceChildren(loadingNode());
  try {
    const node = await RENDER[S.route.screen](S.route.sub);
    if (seq !== S.seq) return;
    main.replaceChildren(node, el('footer', { class: 'pagefoot' },
      el('span', { text: `Signed in as ${S.me.viewer.name}` }), el('span', { text: `Version ${S.me.version}` }),
      el('span', { text: 'Times are in your time zone' })));
  } catch (e) {
    if (e instanceof Stop || seq !== S.seq) return;
    main.replaceChildren(errorBox(e, () => render()));
  }
  refreshBadge();
}

// ================================================================= home
async function screenHome() {
  const d = await coApi('/home');
  const mine = d.approvals.mine;
  const tiles = tilesRow(
    tile({ label: 'Cash in the books', value: money(d.cash.total), tone: 'neutral', ic: 'bank', text: `Operating ${money(d.cash.operating)}`, onClick: () => go('cash') }),
    tile({ label: 'Waiting on you', value: String(mine.length), suffix: 'to decide', tone: mine.length ? 'warning' : 'good', ic: mine.length ? 'clock' : 'ok',
      text: mine.length ? (d.approvals.othersCount ? `${d.approvals.othersCount} more waiting on others` : 'Tap to decide') : (d.approvals.othersCount ? `Nothing for you; ${d.approvals.othersCount} waiting on others` : 'Nothing waiting'),
      onClick: () => go('approvals') }),
    tile({ label: 'Bills due in 7 days', value: money(d.bills.due7), tone: d.bills.overdue_n ? 'serious' : 'neutral', ic: d.bills.overdue_n ? 'warn' : 'file',
      text: d.bills.overdue_n ? `${plural(d.bills.overdue_n, 'bill')} past due, ${money(d.bills.overdue)}` : plural(d.bills.due7_n, 'bill'), onClick: () => go('payables', 'topay') }),
    tile({ label: 'Net this month', value: money(d.month.net), tone: 'neutral', ic: 'book',
      text: `${money(d.month.revenue)} in, ${money(d.month.expenses)} out`, onClick: () => go('books') }));

  const items = [];
  for (const a of mine) items.push(item({ title: subjName(a.subject), detail: [`From ${a.maker_name}, ${ago(a.created_at)}`, a.steps > 1 ? `step ${a.step_seq} of ${a.steps}` : null].filter(Boolean).join(' · '),
    amount: a.amount_minor != null ? money(a.amount_minor) : null, badge: chip('warning', 'clock', 'Yours to approve'), onClick: () => openApproval(a) }));
  for (const b of d.attention) items.push(item({ title: billName(b.vendor, b.reference), detail: sentence(human(b.reason || '')),
    amount: money(b.total_minor), badge: billChip(b.status), onClick: () => openBill(b.id) }));
  for (const t of d.sweepsOverdue) items.push(item({ title: `Move ${money(t.amount_minor)} in from ${t.from_account}`,
    detail: `Was due ${dayLabel(t.due_on)}${t.owner ? ` · on ${t.owner}’s list` : ''}`, badge: chip('serious', 'warn', 'Sweep late'), onClick: () => go('cash') }));
  if (d.recon.lines || d.recon.late) items.push(item({ title: 'Money nobody has matched yet',
    detail: [d.recon.lines ? `${plural(d.recon.lines, 'bank line')} to explain` : null, d.recon.late ? `${plural(d.recon.late, 'store deposit')} late at the bank` : null].filter(Boolean).join(' · '),
    badge: chip('warning', 'warn', 'To look at'), onClick: () => go('recon') }));
  // Each pay group runs on its own schedule; any that needs a hand shows here.
  const periods = d.payroll || [];
  for (const p of periods) {
    const next = payrollNext(p);
    if (next) items.push(item({ title: `Payroll · ${p.pay_group}`, detail: `${next} · pays ${dayLabel(p.pay_date)}`,
      badge: chip('neutral', 'clock', 'To run'), onClick: () => go('payroll') }));
  }
  if (d.feeds.quarantined || d.feeds.failing) items.push(item({ title: 'Feeds', detail: [d.feeds.quarantined ? `${plural(d.feeds.quarantined, 'file')} held for review` : null, d.feeds.failing ? `${plural(d.feeds.failing, 'feed')} failing` : null].filter(Boolean).join(' · '),
    badge: chip('serious', 'hold', 'To look at'), onClick: () => go('feeds') }));

  const waitingOnOwner = [d.hires ? plural(d.hires, 'new hire') : null, d.payChanges ? plural(d.payChanges, 'pay change') : null].filter(Boolean);
  const payrollCard = !d.payGroups
    ? [empty('No payroll here yet', `Set up a pay group for ${S.co.name} from Payroll.`, true)]
    : [...(periods.length ? periods.map((p) => item({ title: p.pay_group, detail: `Pays ${dayLabel(p.pay_date)} · ${payrollStatusText(p)}`,
          amount: p.net_minor ? money(p.net_minor) : null, onClick: () => go('payroll') }))
        : [item({ title: 'Every pay period is posted', detail: 'Open the next one from Payroll', onClick: () => go('payroll') })]),
       waitingOnOwner.length ? item({ title: `${waitingOnOwner.join(' and ')} waiting on the owner`, detail: 'They take effect once the owner approves',
         badge: chip('warning', 'clock', 'Waiting'), onClick: () => go('approvals') }) : null];
  const f = d.feeds;
  const idle = f.total - f.healthy - f.failing - f.stale;
  const feedsCard = item({
    title: !f.total ? 'No feeds set up yet' : f.healthy === f.total ? `All ${f.total} feeds healthy` : idle === f.total ? `${plural(f.total, 'feed')} set up, none running yet` : `${f.healthy} of ${plural(f.total, 'feed')} healthy`,
    detail: [f.failing ? `${f.failing} failing` : null, f.stale ? `${f.stale} gone quiet` : null, f.quarantined ? `${plural(f.quarantined, 'file')} held for review` : null].filter(Boolean).join(' · ')
      || (idle === f.total && f.total ? 'Statements come in by hand upload until the bank connections are set up' : 'Bank statements, bills and takings coming in'),
    badge: f.failing ? chip('critical', 'fail', 'Failing') : f.stale || f.quarantined ? chip('warning', 'warn', 'To look at') : null,
    onClick: () => go('feeds') });

  return frag(
    head('Home', [el('button', { class: 'btn primary', type: 'button', onclick: () => openNewBill() }, icon('plus'), 'New bill')]),
    trialBanner(), tiles,
    el('div', { class: 'two', style: null },
      section('Needs a person', items.length ? `${items.length} open` : null, null,
        el('div', { class: 'panel' }, items.length ? items : empty('Nothing is waiting on a person.', 'Approvals, bills stopped at the gates, late sweeps and unmatched money show up here.'))),
      el('div', {},
        section('Payroll', null, null, el('div', { class: 'panel' }, payrollCard)),
        section('Feeds', null, null, el('div', { class: 'panel' }, feedsCard)))));
}
/** What a pay group's open period needs from a person now, or null if it is waiting on time or on someone else. */
function payrollNext(p) {
  if (p.run_status === 'building') return 'Built; send it for approval';
  if (p.run_status === 'pending_release') return p.approval_status === 'open' ? null : 'Approved; release it for funding';
  if (p.run_status === 'released') return 'Released; post it to the books';
  if (p.run_status || !p.period_over) return null;
  if (p.to_approve > 0) return `${plural(p.to_approve, 'timecard')} to approve, then build the run`;
  if (p.status === 'timecards_approved') return 'Timecards approved; build the run';
  if (!p.timecards && p.salaried) return 'Salaried; build the run';
  return null;
}
function payrollStatusText(p) {
  const range = `${shortDay(p.starts_on)} to ${shortDay(p.ends_on)}`;
  if (p.run_status === 'pending_release') return p.approval_status === 'open' ? 'Built and waiting on approval' : 'Approved; release it for funding';
  if (p.run_status === 'building') return 'Built; send it for approval';
  if (p.run_status === 'released') return 'Released; post it to the books';
  if (p.status === 'timecards_approved') return 'Timecards approved; build the run';
  if (p.status === 'open' && !p.timecards) {
    if (p.salaried) return p.period_over ? 'Salaried; build the run' : `Salaried; the period runs ${range}`;
    return `Period ${range}; no time in yet`;
  }
  if (p.status === 'open') return p.period_over ? `${plural(p.to_approve, 'timecard')} to approve` : `Time coming in for ${range}; ${plural(p.timecards, 'timecard')} so far`;
  return cap(String(p.status).replace('_', ' '));
}

// ============================================================ approvals
async function screenApprovals() {
  const d = await coApi('/approvals');
  const held = d.roles.length ? d.roles.join(', ') : 'no roles here';
  return frag(
    head('Approvals', [el('button', { class: 'btn', type: 'button', onclick: openPersonPicker }, icon('user'), 'Switch person')]),
    el('p', { class: 'lead', text: `Acting as ${S.person ? S.person.name : 'nobody'} (${held}). Each decision is recorded against that person, and the maker of anything can never be the one who approves it.` }),
    section('Waiting on you', d.mine.length ? `${d.mine.length}` : null, null,
      el('div', { class: 'panel' }, d.mine.length ? d.mine.map((a) => approvalItem(a, true)) : empty('Nothing is waiting on you.', d.others.length ? 'What is open needs someone else; see below.' : null))),
    section('Waiting on someone else', d.others.length ? `${d.others.length}` : null, null,
      el('div', { class: 'panel' }, d.others.length ? d.others.map((a) => approvalItem(a, false)) : empty('Nothing else is open.', null, true))),
    section('Recently decided', null, null,
      el('div', { class: 'panel' }, d.recent.length ? d.recent.map((r) => item({
        title: subjName(r.subject), detail: `${cap(r.decision)} by ${r.actor_name || 'someone'} as ${r.required_role} · ${ago(r.decided_at)}${r.note ? ' · “' + r.note + '”' : ''}`,
        amount: r.amount_minor != null ? money(r.amount_minor) : null,
        badge: r.decision === 'approved' ? chip('good', 'ok', 'Approved') : chip('critical', 'fail', 'Rejected'),
        onClick: r.subject.link ? () => openSubject(r.subject.link) : null })) : empty('Nothing decided yet.', null, true))));
}
function approvalItem(a, canDecide) {
  const step = a.steps > 1 ? `step ${a.step_seq} of ${a.steps}` : null;
  return item({
    title: subjName(a.subject),
    detail: [subjDetail(a.subject), `from ${a.maker_name}, ${ago(a.created_at)}`, canDecide ? [step, `as ${a.step_role_word}`].filter(Boolean).join(', ') : step].filter(Boolean).join(' · '),
    amount: a.amount_minor != null ? money(a.amount_minor) : null,
    badge: canDecide ? chip('warning', 'clock', 'Your turn') : chip('neutral', 'pending', 'Waiting'),
    why: canDecide ? null : sentence(a.why),
    acts: canDecide ? decisionButtons(a) : (a.subject.link ? [el('button', { class: 'btn small', type: 'button', onclick: () => openSubject(a.subject.link) }, 'Open')] : null),
  });
}
function decisionButtons(a, after) {
  const yes = el('button', { class: 'btn small primary', type: 'button', onclick: () => decide(a, 'approved', yes, after) }, icon('check'), 'Approve');
  const no = el('button', { class: 'btn small', type: 'button', onclick: () => decide(a, 'rejected', no, after) }, 'Reject…');
  return [yes, no, a.subject.link ? el('button', { class: 'btn small', type: 'button', onclick: () => openSubject(a.subject.link) }, 'Open') : null];
}
async function decide(a, decision, btn, after) {
  let note = '';
  let callback = false;
  if (decision === 'rejected') {
    note = await askReason({ title: 'Reject this?', sub: subjTitle(a.subject), label: 'Why', confirm: 'Reject', placeholder: 'e.g. Wrong store coded; please re-enter against Socorro.' });
    if (note == null) return;
  } else if (a.subject.kind === 'vendor_bank') {
    note = await askCallback(a);
    if (note == null) return;
    callback = true;
  }
  await act(btn, () => post(`/approvals/${a.id}`, { decision, note, callback }), (r) =>
    r.status === 'approved' ? (a.subject_type === 'invoice' ? 'Approved, and posted to the books.'
      : a.subject.kind === 'vendor_bank' ? 'Approved. The new details are in use; the first payment to them waits three days.' : 'Approved.')
    : r.status === 'rejected' ? 'Rejected, with your reason on record.' : 'Your step is done; it moves on to the next person.', { close: after });
}
/**
 * New bank details for a vendor are approved only after a call to the phone
 * already on file. Resolves to what the approver writes about the call, or null.
 */
function askCallback(a) {
  const cb = a.subject.callback || {};
  return new Promise((resolve) => {
    let answered = false;
    const d = openDialog('Call the vendor back first', subjTitle(a.subject), { onClose: () => { if (!answered) resolve(null); } });
    const called = el('input', { type: 'checkbox' });
    const ta = el('textarea', { maxlength: '500', placeholder: 'e.g. Spoke to Dana in accounts at 10:40; she read back the new routing and account endings.' });
    const err = el('div');
    const recent = cb.phoneChangedAt && Date.now() - new Date(cb.phoneChangedAt).getTime() < 60 * 86400000;
    const go = el('button', { class: 'btn primary', type: 'button', disabled: !cb.phone || null, onclick: () => {
      const v = ta.value.trim();
      if (!called.checked) { err.replaceChildren(resultBox('warning', 'warn', 'Make the call first', 'Tick the box once they have confirmed the new details on the phone.')); return; }
      if (!v) { err.replaceChildren(resultBox('warning', 'warn', 'Say who you spoke to', 'It goes on the record with your approval.')); ta.focus(); return; }
      answered = true; resolve(v); d.close();
    } }, icon('check'), 'Approve');
    d.body.append(
      el('p', { class: 'lead', text: 'New bank details are how most payment fraud starts: a letter or an email that looks like the vendor, asking for payments to go somewhere new. Call the number already on file, never one given with the request, and have them confirm the new details.' }),
      el('div', { class: 'panel' }, el('div', { class: 'facts' },
        fact('Call', cb.phone || 'No phone on file'), fact('Ask for', cb.contact || 'Accounts receivable'),
        el('div', { class: 'wide2' }, el('span', { class: 'k', text: 'They should confirm' }), el('div', { class: 'fv', text: a.subject.detail })))),
      !cb.phone ? resultBox('critical', 'fail', 'No phone on file', 'This cannot be approved until the vendor has a phone number on file to call back. Reject it, or put the number on the vendor first.') : null,
      recent ? resultBox('serious', 'warn', 'The phone on file changed recently', `It was changed ${ago(cb.phoneChangedAt)}. Whoever sent new bank details may have changed the phone too. Check the number against an old bill or the vendor’s own website before you call.`) : null,
      el('label', { class: 'check' }, called, 'I called that number, and they confirmed the new details'),
      el('label', { class: 'field' }, el('span', { text: 'Who you spoke to, and when' }), ta),
      el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  });
}
function openApproval(a) {
  const d = openDialog(subjTitle(a.subject), [subjDetail(a.subject), a.amount_minor != null ? money(a.amount_minor) : null].filter(Boolean).join(' · '));
  d.body.append(
    el('p', { class: 'lead', text: `From ${a.maker_name}, ${ago(a.created_at)}. ${a.steps > 1 ? `Step ${a.step_seq} of ${a.steps}, for` : 'For'} the ${a.step_role_word}.` }),
    el('div', { class: 'dlg-acts' }, decisionButtons(a, d.close)));
}
function openSubject(link) {
  const [kind, id] = link.split(':');
  if (kind === 'bill') openBill(id);
  if (kind === 'payrun') openRegister(id);
  if (kind === 'payment') openPaymentRun(id);
  if (kind === 'person') openPerson(id);
  if (kind === 'vendor') openVendor(id);
  if (kind === 'vendors') go('payables', 'vendors');
}

// ============================================================= payables
const BILL_STATUS = {
  exception: ['serious', 'hold', 'Stopped'], held: ['serious', 'hold', 'Held'], pending: ['warning', 'clock', 'Awaiting approval'],
  approved: ['good', 'ok', 'Approved'], scheduled: ['good', 'clock', 'In a run'], paid: ['neutral', 'ok', 'Paid'],
  rejected: ['critical', 'fail', 'Rejected'], captured: ['neutral', 'pending', 'Captured'], validated: ['neutral', 'pending', 'Checking'],
};
const billChip = (status) => { const [t, i, l] = BILL_STATUS[status] || ['neutral', 'info', status]; return chip(t, i, l); };

async function screenPayables(sub) {
  const view = sub === 'runs' ? 'runs' : sub === 'vendors' ? 'vendors' : 'bills';
  if (['attention', 'topay', 'paid', 'rejected', 'all'].includes(sub)) S.billTab = sub;
  const views = seg([['bills', 'Bills'], ['runs', 'Payment runs'], ['vendors', 'Vendors']], view, (v) => go('payables', v === 'bills' ? S.billTab : v));
  const actions = [el('button', { class: 'btn primary', type: 'button', onclick: () => openNewBill() }, icon('plus'), 'New bill')];
  const top = frag(head('Payables', actions), el('div', { class: 'toolbar' }, views));
  if (view === 'runs') return frag(top, await paymentRunsView());
  if (view === 'vendors') return frag(top, await vendorsView());
  const d = await coApi(`/bills?tab=${S.billTab}`);
  const tabs = seg([['attention', 'Needs a person', d.counts.attention.n], ['topay', 'To pay', d.counts.topay.n], ['paid', 'Paid', d.counts.paid.n],
    ['rejected', 'Rejected', d.counts.rejected.n], ['all', 'All', d.counts.all.n]], d.tab, (v) => go('payables', v));
  const rows = d.rows.map((b) => item({
    title: billName(b.vendor, b.reference),
    detail: [b.stores, `dated ${shortDay(b.invoice_date)}`, b.due_date ? (b.days_past_due && ['approved', 'scheduled', 'pending'].includes(b.status) ? `${b.days_past_due} days past due` : `due ${shortDay(b.due_date)}`) : null,
      b.status === 'pending' && b.waiting_on ? `waiting on the ${ROLE[b.waiting_on] || b.waiting_on}` : null, b.pay_date ? `paid ${shortDay(b.pay_date)}` : null].filter(Boolean).join(' · '),
    amount: money(b.total_minor), badge: billChip(b.status),
    why: ['exception', 'held'].includes(b.status) && b.reason ? sentence(human(b.reason)) : null,
    onClick: () => openBill(b.id),
  }));
  const note = d.tab === 'topay' && d.counts.topay.n ? el('div', { class: 'toolbar' }, el('span', { class: 'grow sub', text: `${money(d.counts.topay.total)} approved and not yet paid.` }),
    el('button', { class: 'btn', type: 'button', onclick: () => go('payables', 'runs') }, 'Build a payment run')) : null;
  return frag(top, el('div', { class: 'toolbar' }, tabs), note,
    el('div', { class: 'panel' }, rows.length ? rows : empty(d.tab === 'attention' ? 'No bills need a person.' : 'Nothing here.', d.tab === 'attention' ? 'Bills stopped at the gates, held as possible duplicates or waiting on approval show up here.' : null, d.tab !== 'attention')));
}

function openBill(id) {
  const d = openDialog('Bill', null, { wide: true });
  fillDialog(d, async () => {
    const [b, ap] = await Promise.all([coApi(`/bills/${id}`), coApi('/approvals').catch(() => ({ mine: [], others: [] }))]);
    d.dlg.querySelector('h2').replaceChildren(billName(b.vendor, b.reference));
    const mine = ap.mine.find((x) => x.subject_id === id);
    const other = ap.others.find((x) => x.subject_id === id);
    const reason = b.timeline.length ? b.timeline[b.timeline.length - 1].reason : null;
    const acts = [];
    let signOffNote = null;
    if (['exception', 'held'].includes(b.status)) {
      const signs = signsOff();
      const entered = S.person && b.created_by === S.person.id;
      if (!signs || entered) signOffNote = entered ? 'You entered this bill, so someone else has to let it through.' : 'The controller or the owner can let it through; anyone can reject it.';
      const acc = el('button', { class: 'btn primary', type: 'button', disabled: (!signs || entered) || null, onclick: async () => {
        const why = await askReason({ title: b.status === 'held' ? 'Not a duplicate?' : 'Let it through?', sub: `${b.vendor} ${b.reference || ''}`,
          lead: 'It goes on to approval, or straight to the books if it is under the approval threshold.', label: 'Why it is fine', confirm: 'Let it through',
          placeholder: b.status === 'held' ? 'e.g. Separate meter at the Palestine store.' : 'e.g. Compressor replaced; quote attached.' });
        if (why == null) return;
        await act(acc, () => post(`/bills/${id}/accept`, { reason: why }), (r) => r.status === 'approved' ? 'Approved and posted.' : 'Sent on for approval.', { close: d.close });
      } }, b.status === 'held' ? 'Not a duplicate…' : 'Let it through…');
      const rej = el('button', { class: 'btn', type: 'button', onclick: async () => {
        const why = await askReason({ title: 'Reject this bill?', sub: `${b.vendor} ${b.reference || ''}`, label: 'Why', confirm: 'Reject' });
        if (why == null) return;
        await act(rej, () => post(`/bills/${id}/reject`, { reason: why }), 'Rejected.', { close: d.close });
      } }, 'Reject…');
      acts.push(acc, rej);
    }
    if (mine) acts.push(...decisionButtons(mine, d.close).filter((x) => x && x.textContent !== 'Open'));
    if (b.status === 'approved') acts.push(el('button', { class: 'btn', type: 'button', onclick: () => { d.close(); go('payables', 'runs'); } }, 'Pay it in a run'));
    return frag(
      el('div', { class: 'toolbar' }, el('span', { class: 'big', text: money(b.total_minor) }), billChip(b.status),
        b.kind === 'merchandise' ? chip('neutral', 'file', 'Merchandise') : null),
      ['exception', 'held'].includes(b.status) && reason ? resultBox('serious', 'hold', b.status === 'held' ? 'Held as a possible duplicate' : 'Stopped at the gates',
        [sentence(human(reason)), signOffNote].filter(Boolean).join(' ')) : null,
      b.status === 'pending' ? resultBox('warning', 'clock', mine ? 'Waiting on you' : 'Waiting on approval',
        mine ? (mine.steps > 1 ? `Step ${mine.step_seq} of ${mine.steps}, as the ${mine.step_role_word}.` : `As the ${mine.step_role_word}.`) : other ? sentence(other.why) : '') : null,
      acts.length ? el('div', { class: 'dlg-acts' }, acts) : null,
      el('div', { class: 'panel', style: null }, el('div', { class: 'facts' },
        fact('Bill date', dayLabel(b.invoice_date)), fact('Due', b.due_date ? dayLabel(b.due_date) : '—'),
        fact('Entered by', b.created_by_name || '—'),
        b.usual_minor != null ? fact('Usually bills', money(b.usual_minor)) : fact('Read with', b.confidence_bps ? `${Math.round(b.confidence_bps / 100)}% confidence` : '—'))),
      section('Coded to', null, null, el('div', { class: 'panel' }, b.lines.map((l) => item({
        title: `${l.code} ${l.account}`, detail: [l.store || 'Company', l.description].filter(Boolean).join(' · '), amount: money(l.amount_minor) })))),
      b.requests.length ? section('Approvals', null, null, el('div', { class: 'panel' }, b.requests.flatMap((r) => (r.steps || []).map((s) => item({
        title: `Step ${s.seq}: ${s.role}`, detail: s.decision ? `${cap(s.decision)} by ${s.actor} · ${ago(s.at)}${s.note ? ' · “' + s.note + '”' : ''}` : `Waiting · made by ${r.maker_name}`,
        badge: s.decision === 'approved' ? chip('good', 'ok', 'Approved') : s.decision === 'rejected' ? chip('critical', 'fail', 'Rejected') : chip('neutral', 'pending', 'Open') }))))) : null,
      b.payments.length ? section('Paid', null, null, el('div', { class: 'panel' }, b.payments.map((p) => item({ title: `Payment run for ${dayLabel(p.pay_date)}`, detail: `${p.method.toUpperCase()} · ${p.run_status}`,
        amount: money(p.amount_minor), onClick: () => openPaymentRun(p.run_id) })))) : null,
      b.entries.length ? section('In the books', null, null, el('div', { class: 'panel' }, b.entries.map((e) => item({ title: human(e.description), detail: `${dayLabel(e.posting_date)} · ${e.source_type === 'invoice' ? 'the bill posted' : e.source_type === 'payment' ? 'the payment' : e.source_type}`, onClick: () => openEntry(e.id) })))) : null,
      section('What happened', null, null, el('div', { class: 'panel' }, el('ul', { class: 'timeline' }, b.timeline.map((t) => el('li', {},
        el('div', { text: t.to_status ? `${cap(t.from_status || 'new')} → ${t.to_status}${t.reason ? ': ' + human(t.reason) : ''}` : cap(human(t.reason || t.action)) }),
        el('div', { class: 'when', text: `${fmtStamp.format(new Date(t.at))} · ${t.actor_label}` })))))));
  });
}
const fact = (k, v) => el('div', {}, el('span', { class: 'k', text: k }), el('div', { class: 'fv', text: v }));

async function openNewBill() {
  const d = openDialog('New bill', `${S.co.name} · entered as ${S.person ? S.person.name : 'nobody'}`);
  fillDialog(d, async () => {
    const o = await coApi('/options');
    if (!o.vendors.length) return frag(empty('No vendors yet', `Add a vendor for ${S.co.name} first, under Payables → Vendors.`, true));
    const vendor = el('select', { required: true }, el('option', { value: '', text: 'Pick the vendor' }), o.vendors.map((v) => el('option', { value: v.id, text: v.name })));
    const ref = el('input', { type: 'text', maxlength: '60', placeholder: 'e.g. INV-40182' });
    const date = el('input', { type: 'date', value: todayIso() });
    const due = el('input', { type: 'date' });
    const amount = el('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00' });
    const acct = el('select', {}, el('option', { value: '', text: 'Pick the account' }), o.accounts.map((a) => el('option', { value: a.id, text: `${a.code} ${a.name}` })));
    const storeSel = el('select', {}, el('option', { value: '', text: 'Company-wide' }), o.stores.map((s) => el('option', { value: s.id, text: s.name })));
    const desc = el('input', { type: 'text', maxlength: '200', placeholder: 'Optional' });
    const out = el('div', { role: 'status', 'aria-live': 'polite' });
    vendor.addEventListener('change', () => {
      const v = o.vendors.find((x) => x.id === vendor.value);
      if (!v) return;
      if (v.default_gl_account_id) acct.value = v.default_gl_account_id;
      if (v.default_profit_object_id) storeSel.value = v.default_profit_object_id;
      due.placeholder = `${v.terms_days} days`;
    });
    const go = el('button', { class: 'btn primary', type: 'button', onclick: async () => {
      busy(go, true, 'Checking…');
      out.replaceChildren();
      const refV = ref.value.trim();
      try {
        const r = await post('/bills', { vendorId: vendor.value, reference: ref.value, invoiceDate: date.value, dueDate: due.value || null,
          amount: amount.value, glAccountId: acct.value, storeId: storeSel.value || null, description: desc.value });
        const map = {
          approved: ['good', 'ok', 'Approved and posted', 'It cleared every gate and sits under the approval threshold.'],
          pending: ['warning', 'clock', 'Sent for approval', 'It is over the approval threshold; it is in the approver’s queue now.'],
          exception: ['serious', 'hold', 'Stopped at the gates', `${sentence(human(r.reason))} It is under Needs a person, where the controller can let it through or reject it.`],
          held: ['serious', 'hold', 'Held as a possible duplicate', `${sentence(human(r.reason))} It is under Needs a person.`],
        }[r.status] || ['neutral', 'info', cap(r.status), sentence(human(r.reason))];
        out.replaceChildren(resultBox(map[0], map[1], `${refV}: ${map[2].toLowerCase()}`, map[3]));
        [ref, amount, desc].forEach((x) => { x.value = ''; });
        render();
      } catch (e) {
        if (!(e instanceof Stop)) out.replaceChildren(resultBox('critical', 'fail', 'Not entered', friendly(e)));
      } finally { busy(go, false); }
    } }, 'Enter the bill');
    return frag(
      el('p', { class: 'lead', text: 'It goes through the same gates as a bill that arrives by email: the vendor must be set up, the amount must match what that vendor usually bills, and duplicates are held.' }),
      el('div', { class: 'form-grid' },
        el('label', { class: 'field wide' }, el('span', { text: 'Vendor' }), vendor),
        el('label', { class: 'field' }, el('span', { text: 'Bill number' }), ref),
        el('label', { class: 'field' }, el('span', { text: 'Amount' }), amount),
        el('label', { class: 'field' }, el('span', { text: 'Bill date' }), date),
        el('label', { class: 'field' }, el('span', { text: 'Due date' }), due, el('span', { class: 'hint', text: 'Left empty, it follows the vendor’s terms.' })),
        el('label', { class: 'field' }, el('span', { text: 'Account' }), acct),
        el('label', { class: 'field' }, el('span', { text: 'Store' }), storeSel),
        el('label', { class: 'field wide' }, el('span', { text: 'Description' }), desc)),
      el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Close')), out);
  });
}

async function paymentRunsView() {
  const d = await coApi('/payment-runs');
  const picked = new Set(d.eligible.map((b) => b.id));
  const totalEl = el('span', { class: 'grow sub' });
  const updateTotal = () => {
    const t = d.eligible.filter((b) => picked.has(b.id)).reduce((s, b) => s + Number(b.total_minor), 0);
    totalEl.textContent = `${plural(picked.size, 'bill')} picked, ${money(t)}`;
    build.disabled = picked.size === 0;
  };
  const payDate = el('input', { type: 'date', value: nextBusinessDay(), min: todayIso() });
  const achOk = d.operating && d.operating.ach_origination_enabled;
  const method = el('select', {}, achOk ? el('option', { value: 'ach', text: 'ACH' }) : null, el('option', { value: 'check', text: 'Check' }));
  const build = el('button', { class: 'btn primary', type: 'button', onclick: () => act(build, () => post('/payment-runs', { payDate: payDate.value, method: method.value, invoiceIds: [...picked] }),
    (r) => `Run built: ${plural(r.bills, 'bill')}, ${money(r.total)}. Send it for approval next.`) }, 'Build the run');
  const rows = d.eligible.map((b) => {
    const box = el('input', { type: 'checkbox', class: 'pickbox', checked: true, 'aria-label': `Pay ${b.vendor} ${b.reference || ''}`,
      onchange: (e) => { e.target.checked ? picked.add(b.id) : picked.delete(b.id); updateTotal(); } });
    return item({ pick: box, title: billName(b.vendor, b.reference),
      detail: b.due_date ? (b.days_past_due ? `${b.days_past_due} days past due` : `due ${dayLabel(b.due_date)}`) : `dated ${dayLabel(b.invoice_date)}`, amount: money(b.total_minor) });
  });
  updateTotal();
  const runs = d.runs.map((r) => runItem(r, d));
  return frag(
    section('Ready to pay', d.eligible.length ? `${d.eligible.length} approved` : null, null,
      d.eligible.length ? frag(
        el('div', { class: 'panel' }, rows),
        el('div', { class: 'toolbar', style: null }, totalEl),
        el('div', { class: 'form-grid' },
          el('label', { class: 'field' }, el('span', { text: 'Pay date' }), payDate),
          el('label', { class: 'field' }, el('span', { text: 'Pay by' }), method,
            el('span', { class: 'hint', text: d.operating ? `From ${d.operating.name}, ${d.operating.bank_name} ••${d.operating.account_last4}` : 'No operating account set up' }))),
        el('div', { class: 'dlg-acts' }, build),
        el('p', { class: 'foot', text: 'A run is built by one person and released by another, after the controller approves it. Release pays the bills in the books; the bank file itself is still to build.' }))
      : el('div', { class: 'panel' }, empty('Nothing approved is waiting to be paid.', 'Approved bills show up here to be picked into a run.', true))),
    section('Runs', null, null, el('div', { class: 'panel' }, runs.length ? runs : empty('No payment runs yet.', null, true))));
}
function runStatusChip(r) {
  if (r.status === 'building') return chip('neutral', 'pending', 'Being built');
  if (r.status === 'pending_release') return r.approval_status === 'open' ? chip('warning', 'clock', 'Awaiting approval') : chip('warning', 'clock', 'Ready to release');
  if (r.status === 'released') return chip('good', 'ok', 'Released and posted');
  if (r.status === 'settled') return chip('good', 'ok', 'Cleared the bank');
  return chip('neutral', 'pause', cap(r.status));
}
function runItem(r) {
  const acts = [];
  const mine = S.person && r.built_by === S.person.id;
  if (r.status === 'building') {
    const sub = el('button', { class: 'btn small primary', type: 'button', onclick: () => act(sub, () => post(`/payment-runs/${r.id}/submit`),
      (x) => x.approval ? 'Sent to the controller for approval.' : 'No approval needed at this amount; it can be released.') }, 'Send for approval');
    acts.push(sub);
  }
  if (r.status === 'pending_release' && r.approval_status !== 'open') {
    const rel = el('button', { class: 'btn small primary', type: 'button', disabled: mine || null,
      onclick: () => act(rel, () => post(`/payment-runs/${r.id}/release`), (x) => `Released: ${plural(x.bills, 'bill')} paid, ${money(x.total)} out of the operating account in the books.`) }, 'Release');
    acts.push(rel);
  }
  if (['building', 'pending_release'].includes(r.status)) {
    const cancel = el('button', { class: 'btn small', type: 'button', onclick: async () => {
      const ok = await askReason({ title: 'Cancel this run?', sub: `Pay date ${dayLabel(r.pay_date)}`, label: 'Why', confirm: 'Cancel the run', lead: 'The bills go back to Ready to pay.' });
      if (ok == null) return;
      await act(cancel, () => post(`/payment-runs/${r.id}/cancel`), 'Run cancelled.');
    } }, 'Cancel…');
    acts.push(cancel);
  }
  acts.push(el('button', { class: 'btn small', type: 'button', onclick: () => openPaymentRun(r.id) }, 'Open'));
  const why = r.status === 'pending_release' && r.approval_status === 'open' ? `Waiting on the ${ROLE[r.waiting_on] || r.waiting_on || 'approver'}; approve it from Approvals when acting as them.`
    : mine && r.status === 'pending_release' ? 'You built this run, so someone else has to release it.' : null;
  return item({ title: `Pay date ${dayLabel(r.pay_date)} · ${r.method.toUpperCase()}`,
    detail: `${plural(r.payments, 'bill')} · built by ${r.built_by_name}${r.released_by_name ? ` · released by ${r.released_by_name}` : ''}`,
    amount: money(r.total_minor), badge: runStatusChip(r), why, acts });
}
function openPaymentRun(id) {
  const d = openDialog('Payment run', null, { wide: true });
  fillDialog(d, async () => {
    const r = await coApi(`/payment-runs/${id}`);
    d.dlg.querySelector('h2').textContent = `Payment run for ${dayLabel(r.pay_date)}`;
    return frag(el('div', { class: 'toolbar' }, el('span', { class: 'big', text: money(r.total_minor) }), runStatusChip(r)),
      el('p', { class: 'lead', text: `${r.method.toUpperCase()} from ${r.bank_account || 'the operating account'}${r.account_last4 ? ' ••' + r.account_last4 : ''}. Built by ${r.built_by_name}${r.released_by_name ? `, released by ${r.released_by_name}` : ''}.` }),
      el('div', { class: 'panel' }, r.payment_list.map((p) => item({ title: billName(p.vendor, p.reference), detail: `${cap(p.status)}${p.due_date ? ' · was due ' + shortDay(p.due_date) : ''}`,
        amount: money(p.amount_minor), onClick: () => openBill(p.invoice_id) }))));
  });
}

async function vendorsView() {
  const v = await coApi('/vendors');
  return frag(
    el('div', { class: 'toolbar' }, el('span', { class: 'grow sub', text: `${plural(v.length, 'vendor')} set up for ${S.co.name}.` }),
      el('button', { class: 'btn', type: 'button', onclick: openAddVendor }, icon('plus'), 'Add vendor')),
    el('div', { class: 'panel' }, v.length ? v.map((x) => item({
      title: x.name, detail: [x.city && x.state ? `${x.city}, ${x.state}` : x.state, x.gl_code ? `codes to ${x.gl_code} ${x.gl_name}` : null, `${x.terms_days}-day terms`, plural(x.bills, 'bill'),
        x.last_bill ? `last ${shortDay(x.last_bill)}` : null, x.is_1099 ? '1099' : null, x.w9_on_file ? null : 'no W-9', x.bank_last4 ? `pays to ••${x.bank_last4}` : null].filter(Boolean).join(' · '),
      amount: Number(x.open_minor) ? `${money(x.open_minor)} open` : null,
      badge: x.status === 'hold' ? chip('warning', 'clock', 'Awaiting approval') : x.status !== 'active' ? chip('neutral', 'pause', cap(x.status))
        : x.bank_change_pending ? chip('warning', 'clock', 'Bank change waiting') : null,
      onClick: () => openVendor(x.id) })) : empty('No vendors yet.', null, true)),
    el('p', { class: 'foot', text: 'Only the last four digits of a vendor’s bank numbers are kept here. New bank details need the controller and the owner, each after calling the vendor back on the phone already on file.' }));
}

const TAX_CLASS = { individual: 'Individual', sole_prop: 'Sole proprietor', partnership: 'Partnership', c_corp: 'C corporation', s_corp: 'S corporation', llc: 'LLC', other: 'Other' };
const formSec = (text) => el('h3', { class: 'form-sec wide', text });
const checkbox = (label, checked) => { const box = el('input', { type: 'checkbox', checked: !!checked }); return { box, node: el('label', { class: 'check wide' }, box, label) }; };

/** The vendor fields a person types, for adding and for editing. */
function vendorForm(o, v) {
  v = v || {};
  const f = {
    taxClass: select([['', 'Not known yet'], ...Object.entries(TAX_CLASS)], v.tax_classification || ''),
    tin: input({ maxlength: '4', inputmode: 'numeric', placeholder: 'Last 4 only', value: v.tin_last4 || '' }),
    w9: checkbox('W-9 on file', v.w9_on_file), is1099: checkbox('Gets a 1099', v.is_1099),
    addr1: input({ maxlength: '120', value: v.address_line1 || '' }), addr2: input({ maxlength: '120', placeholder: 'Optional', value: v.address_line2 || '' }),
    city: input({ maxlength: '60', value: v.city || '' }), state: input({ maxlength: '2', class: 'upper', placeholder: 'TX', value: v.state || '' }),
    zip: input({ maxlength: '10', inputmode: 'numeric', value: v.postal_code || '' }),
    remit: input({ maxlength: '300', placeholder: 'Only if payments go somewhere other than the address', value: v.remit_to || '' }),
    contact: input({ maxlength: '80', placeholder: 'e.g. Accounts receivable', value: v.contact_name || '' }),
    phone: input({ type: 'tel', maxlength: '25', placeholder: '(555) 555-0100', value: v.contact_phone || '' }),
    email: input({ type: 'email', maxlength: '120', value: v.contact_email || '' }),
    terms: input({ type: 'number', min: '0', max: '120', value: String(v.terms_days ?? 30) }),
    acct: select([['', 'None yet'], ...o.accounts.map((a) => [a.id, `${a.code} ${a.name}`])], v.default_gl_account_id || ''),
    store: select([['', 'Company-wide'], ...o.stores.map((s) => [s.id, s.name])], v.default_profit_object_id || ''),
  };
  const body = () => ({ taxClassification: f.taxClass.value, tinLast4: f.tin.value, w9OnFile: f.w9.box.checked, is1099: f.is1099.box.checked,
    addressLine1: f.addr1.value, addressLine2: f.addr2.value, city: f.city.value, state: f.state.value, postalCode: f.zip.value, remitTo: f.remit.value,
    contactName: f.contact.value, contactPhone: f.phone.value, contactEmail: f.email.value,
    termsDays: Number(f.terms.value), glAccountId: f.acct.value || null, storeId: f.store.value || null });
  const fields = [
    formSec('Tax papers'),
    field('Tax classification', f.taxClass), field('Tax ID', f.tin, 'The last four digits; the full number stays on the W-9'),
    f.w9.node, f.is1099.node,
    formSec('Address'),
    field('Street', f.addr1, null, true), field('Suite or unit', f.addr2, null, true),
    field('City', f.city), field('State', f.state), field('ZIP code', f.zip), field('Remit payments to', f.remit, null, true),
    formSec('Who to call'),
    field('Contact', f.contact), field('Phone', f.phone, 'The number a bank change is called back on'), field('Email', f.email, null, true),
    formSec('How they bill'),
    field('Payment terms (days)', f.terms), field('Usual account', f.acct), field('Usual store', f.store),
  ];
  return { f, body, fields };
}

function openAddVendor() {
  const d = openDialog('Add a vendor', `${S.co.name} · added as ${S.person ? S.person.name : 'nobody'}`, { wide: true });
  fillDialog(d, async () => {
    const o = await coApi('/options');
    const name = input({ maxlength: '120', placeholder: 'Legal name, as on the W-9' });
    const dba = input({ maxlength: '120', placeholder: 'Optional' });
    const vf = vendorForm(o, null);
    const out = el('div');
    const go = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go, () => post('/vendors', { name: name.value, dba: dba.value, ...vf.body() }),
      (r) => r.status === 'active' ? 'Vendor added.' : 'Vendor added; it can take bills once the controller approves it.',
      { close: d.close, errorInto: (e) => out.replaceChildren(resultBox('critical', 'fail', 'Not added', friendly(e))) }) }, 'Add vendor');
    return frag(
      el('p', { class: 'lead', text: 'A new vendor waits on the controller’s approval before bills from it can go through. Bank details are added afterwards, from the vendor, and are approved separately.' }),
      el('div', { class: 'form-grid' }, field('Legal name', name, null, true), field('Trading as', dba), el('div'), vf.fields),
      el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
  });
}

const BANK_STATUS = { current: ['good', 'ok', 'In use'], pending: ['warning', 'clock', 'Waiting on approval'], superseded: ['neutral', 'pause', 'Replaced'], rejected: ['critical', 'fail', 'Rejected'] };
const recently = (iso, days) => iso && Date.now() - new Date(iso).getTime() < days * 86400000;

/** One vendor: the record, its bank details over time, and its bills. */
function openVendor(id) {
  const d = openDialog('Vendor', null, { wide: true });
  fillDialog(d, async () => {
    const [v, ap] = await Promise.all([coApi(`/vendors/${id}`), coApi('/approvals').catch(() => ({ mine: [], others: [] }))]);
    d.dlg.querySelector('h2').textContent = v.name;
    const signs = signsOff();
    const edit = el('button', { class: 'btn', type: 'button', disabled: !signs || null, onclick: () => { d.close(); openEditVendor(v); } }, 'Edit details…');
    const bank = el('button', { class: 'btn', type: 'button', onclick: () => { d.close(); openVendorBank(v); } }, 'New bank details…');
    const pendingBank = v.banks.find((b) => b.status === 'pending');
    const mine = pendingBank ? ap.mine.find((x) => x.subject_id === pendingBank.id) : null;
    const waiting = pendingBank ? ap.others.find((x) => x.subject_id === pendingBank.id) : null;
    const address = [v.address_line1, v.address_line2, [v.city, [v.state, v.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ');
    return frag(
      el('p', { class: 'lead', text: [v.dba && v.dba !== v.legal_name ? `Legal name ${v.legal_name}` : null, TAX_CLASS[v.tax_classification] || null,
        v.tin_last4 ? `tax ID ••${v.tin_last4}` : null, v.is_1099 ? 'gets a 1099' : null, v.w9_on_file ? 'W-9 on file' : 'no W-9 on file'].filter(Boolean).join(' · ') }),
      v.status === 'hold' ? resultBox('warning', 'clock', 'Waiting on approval', 'Bills from this vendor go through once the controller approves it.') : null,
      recently(v.phone_changed_at, 60) ? resultBox('serious', 'warn', 'The phone on file changed recently',
        `Changed ${ago(v.phone_changed_at)}. A call-back to a number changed alongside new bank details proves nothing; check it against an old bill or the vendor’s own website.`) : null,
      el('div', { class: 'panel' }, el('div', { class: 'facts' },
        fact('Address', address || '—'), fact('Contact', [v.contact_name, v.contact_phone].filter(Boolean).join(' · ') || '—'),
        fact('Email', v.contact_email || '—'), fact('Terms', `${v.terms_days} days`),
        fact('Usually codes to', v.gl_code ? `${v.gl_code} ${v.gl_name}` : '—'), fact('Usual store', v.store || 'Company-wide'),
        v.remit_to ? fact('Remit to', v.remit_to) : null, fact('Added', `${fmtDate.format(new Date(v.created_at))}${v.created_by_name ? ' by ' + v.created_by_name : ''}`))),
      el('div', { class: 'dlg-acts' }, edit, bank),
      signs ? null : el('p', { class: 'foot', text: 'Changing a vendor’s details is for the controller or the owner, because the phone on file is what bank changes are checked against.' }),
      section('Bank details', null, null,
        mine ? el('div', { class: 'dlg-acts' }, decisionButtons(mine, d.close).filter((x) => x && x.textContent !== 'Open')) : null,
        el('div', { class: 'panel' }, v.banks.length ? v.banks.map((b) => {
          const [tone, ic, label] = BANK_STATUS[b.status] || ['neutral', 'info', b.status];
          const held = String(b.account_ref || '').replace(/^held at:\s*/i, '');
          return item({ title: `${b.bank_name || 'Bank'} · routing ••${b.routing_last4} · account ••${b.account_last4}`,
            detail: [b.status === 'current' ? (b.cooling_off ? `first payment waits until ${fmtStamp.format(new Date(b.hold_until))}` : b.effective_from ? `in use since ${shortDay(isoDay(new Date(b.effective_from)))}` : 'in use')
              : b.status === 'pending' ? `entered by ${b.created_by_name || 'someone'} ${ago(b.created_at)}` : null,
              held && !held.startsWith('vault://') ? `full numbers: ${held}` : null,
              b.callback_note && b.status !== 'pending' ? `“${b.callback_note}”` : null].filter(Boolean).join(' · '),
            badge: chip(tone, ic, label), why: b.status === 'pending' && waiting ? sentence(waiting.why) : null });
        }) : empty('No bank details on file', 'Payments go by check until bank details are added and approved.', true))),
      v.bills.length ? section('Recent bills', null, null, el('div', { class: 'panel' }, v.bills.map((b) => item({ title: billName(v.name, b.reference),
        detail: `dated ${shortDay(b.invoice_date)}`, amount: money(b.total_minor), badge: billChip(b.status), onClick: () => { d.close(); openBill(b.id); } })))) : null);
  });
}

function openEditVendor(v) {
  const d = openDialog(`Edit ${v.name}`, 'Recorded with your name. A change to the phone number is flagged on the vendor for sixty days.', { wide: true });
  fillDialog(d, async () => {
    const o = await coApi('/options');
    const vf = vendorForm(o, v);
    const out = el('div');
    const go = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go, () => post(`/vendors/${v.id}`, vf.body()), 'Vendor details saved.',
      { close: d.close, errorInto: (e) => out.replaceChildren(resultBox('critical', 'fail', 'Not saved', friendly(e))) }) }, 'Save');
    return frag(el('div', { class: 'form-grid' }, vf.fields),
      el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
  });
}

function openVendorBank(v) {
  const d = openDialog(`New bank details for ${v.name}`, 'Nothing changes until the controller and the owner approve');
  const bankName = input({ maxlength: '80', placeholder: 'e.g. First Keystone Bank' });
  const routing = input({ maxlength: '4', inputmode: 'numeric', placeholder: 'Last 4' });
  const account = input({ maxlength: '4', inputmode: 'numeric', placeholder: 'Last 4' });
  const heldAt = input({ maxlength: '120', placeholder: 'e.g. The payee record at our bank' });
  const reason = el('textarea', { maxlength: '500', placeholder: 'e.g. Letter on their letterhead, received Sep 18; asked them to confirm by phone.' });
  const out = el('div');
  const go = el('button', { class: 'btn primary', type: 'button', disabled: !v.contact_phone || null, onclick: () => act(go, () => post(`/vendors/${v.id}/bank`, {
    bankName: bankName.value, routingLast4: routing.value, accountLast4: account.value, heldAt: heldAt.value, reason: reason.value }),
    (r) => r.approval ? 'Sent for approval. The controller, then the owner, call the vendor back before approving.' : 'Bank details saved.',
    { close: d.close, errorInto: (e) => out.replaceChildren(resultBox('critical', 'fail', 'Not sent', friendly(e))) }) }, 'Send for approval');
  d.body.append(
    el('p', { class: 'lead', text: `Only the last four digits are kept here; the full numbers stay where payments are sent from. The controller and then the owner each call ${v.contact_phone || 'the phone on file'} before approving, and the first payment to the new account waits three days after that.` }),
    !v.contact_phone ? resultBox('warning', 'warn', 'No phone on file', 'Put the vendor’s phone number on its details first: the call-back is made to a number already on file, never to one that came with the new details.') : null,
    el('div', { class: 'form-grid' }, field('Bank', bankName, null, true), field('Routing number', routing, 'Last four digits'), field('Account number', account, 'Last four digits'),
      field('Where the full numbers are kept', heldAt, null, true), field('How the new details arrived', reason, 'Goes to both approvers', true)),
    el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
}

// ============================================================== payroll
const FREQ = { weekly: 'Weekly', biweekly: 'Every two weeks', semimonthly: 'Twice a month', monthly: 'Monthly' };
const PER_YEAR = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dollars = (m) => (Number(m || 0) / 100).toFixed(2);
const payText = (e) => (e.pay_type === 'salary' ? `${money(e.base_rate_minor)} a year` : `${money(e.base_rate_minor)} an hour`);
const lagText = (n) => (Number(n) === 0 ? 'pays on the last day' : `pays ${plural(Number(n), 'day')} after`);
/** A labelled field; the label's first span is its name. */
const field = (label, control, hint, wide) => el('label', { class: 'field' + (wide ? ' wide' : '') }, el('span', { text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null);
const select = (options, value) => el('select', {}, options.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(value ?? '') || null })));
const input = (props) => el('input', Object.assign({ type: 'text' }, props));

function groupState(g, runs) {
  const p = g.current;
  const run = p && p.run_id ? runs.find((r) => r.id === p.run_id) : null;
  const acts = [];
  let state = '';
  if (!p) {
    state = 'Every pay period is posted.';
    const next = el('button', { class: 'btn primary', type: 'button', onclick: () => act(next, () => post('/payroll/next-period', { payGroupId: g.id }),
      (x) => `${x.group}: ${shortDay(x.starts_on)} to ${shortDay(x.ends_on)} opened, paid ${dayLabel(x.pay_date)}.`) }, 'Open the next period');
    acts.push(next);
  } else if (!run) {
    if (p.to_approve > 0) {
      state = `${plural(p.to_approve, 'timecard')} to approve.`;
      const ap = el('button', { class: 'btn primary', type: 'button', onclick: () => act(ap, () => post(`/payroll/periods/${p.id}/approve-timecards`), (r) => `${plural(r.approved, 'timecard')} approved.`) }, 'Approve timecards');
      acts.push(ap);
    } else if (p.exceptions > 0) {
      state = `${plural(p.exceptions, 'timecard')} with exceptions to resolve first.`;
    } else if (p.timecards === 0 && !g.salaried) {
      state = 'No time has come in for this period yet.';
    } else {
      state = p.timecards ? 'Timecards approved. Build the register next.' : 'Salaried pay needs no timecards. Build the register when you are ready.';
      const b = el('button', { class: 'btn primary', type: 'button', onclick: () => act(b, () => post(`/payroll/periods/${p.id}/build`), (r) => `Built: ${plural(r.employees, 'person', 'people')}, net ${money(r.net)}.`) }, 'Build the run');
      acts.push(b);
    }
  } else if (run.status === 'building') {
    state = 'Built. Send it to the owner for approval.';
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => act(b, () => post(`/payroll/runs/${run.id}/request`), 'Sent to the owner for approval.') }, 'Send for approval');
    acts.push(b);
  } else if (run.status === 'pending_release' && run.approval_status === 'open') {
    state = `Waiting on the ${ROLE[run.waiting_on] || run.waiting_on || 'owner'} to approve the register. Approve it from Approvals when acting as them.`;
    acts.push(el('button', { class: 'btn', type: 'button', onclick: () => go('approvals') }, 'Go to Approvals'));
  } else if (run.status === 'pending_release') {
    const mine = S.person && run.built_by === S.person.id;
    state = mine ? 'Approved. You built it, so someone else has to release it.' : 'Approved. Release it for funding.';
    const b = el('button', { class: 'btn primary', type: 'button', disabled: mine || null, onclick: () => act(b, () => post(`/payroll/runs/${run.id}/release`), 'Released for funding.') }, 'Release');
    acts.push(b);
  } else if (run.status === 'released') {
    state = 'Released. Post it to the books.';
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => act(b, () => post(`/payroll/runs/${run.id}/post`), 'Posted: wages by store, taxes and deductions payable.') }, 'Post to the books');
    acts.push(b);
  }
  if (p && p.timecards) acts.push(el('button', { class: 'btn', type: 'button', onclick: () => openTimecards(p) }, 'Timecards'));
  if (run) acts.push(el('button', { class: 'btn', type: 'button', onclick: () => openRegister(run.id) }, 'Register'));
  return el('div', { class: 'panel' },
    p ? el('div', { class: 'facts' }, fact('Pay date', dayLabel(p.pay_date)), fact('Period', `${shortDay(p.starts_on)} to ${shortDay(p.ends_on)}`),
      fact(g.salaried && !p.timecards ? 'People' : 'Time in', g.salaried && !p.timecards ? `${plural(g.people, 'person', 'people')}, salaried` : `${hours(p.hours)} hours, ${plural(p.employees, 'person', 'people')}`),
      fact('Net pay', run ? money(run.net_minor) : 'Not built yet')) : null,
    el('div', { class: 'li' }, el('div', { class: 't', text: state }), el('div', { class: 'acts' }, acts)));
}

async function screenPayroll() {
  const d = await coApi('/payroll');
  const addPerson = el('button', { class: 'btn primary', type: 'button', onclick: () => openHire() }, icon('plus'), 'Add person');
  const addGroup = el('button', { class: 'btn', type: 'button', onclick: () => openAddGroup() }, icon('plus'), 'Add pay group');
  if (!d.groups.length) {
    return frag(head('Payroll', [addGroup]), el('div', { class: 'panel' }, empty(`Payroll is not set up for ${S.co.name} yet.`,
      'Start with a pay group: how often it pays, from which account, and when the first period starts. Then add the people in it.', true)));
  }
  const groups = d.groups.map((g) => section(g.name, `${FREQ[g.frequency] || g.frequency} · ${lagText(g.pay_lag_days)} · ${plural(g.people, 'person', 'people')}`, null, groupState(g, d.runs)));
  const people = d.employees.map((e) => item({
    title: e.name,
    detail: [e.position, e.pay_group, e.store, payText(e)].filter(Boolean).join(' · '),
    badge: e.status === 'applicant' ? chip('warning', 'clock', 'Waiting on approval') : e.status === 'terminated' ? chip('neutral', 'pause', `Left ${shortDay(e.terminated_on)}`)
      : e.status === 'leave' ? chip('neutral', 'pause', 'On leave') : e.pending_change ? chip('warning', 'clock', 'Pay change waiting') : null,
    onClick: () => openPerson(e.id) }));
  const current = people.filter((_, i) => d.employees[i].status !== 'terminated');
  const former = people.filter((_, i) => d.employees[i].status === 'terminated');
  return frag(
    head('Payroll', [addPerson, addGroup]),
    ...groups,
    el('p', { class: 'foot', text: 'Taxes here are illustrative flat rates, not for filing: calculation and filing come from a payroll tax service, still to choose. Whoever builds a run cannot release it, and new hires and pay changes wait on the owner.' }),
    el('div', { class: 'two' },
      el('div', {},
        section('People', `${current.length}`, null, el('div', { class: 'panel' }, current.length ? current : empty('Nobody on payroll yet.', 'Add a person to start.', true))),
        former.length ? section('Left in the last 90 days', null, null, el('div', { class: 'panel' }, former)) : null),
      el('div', {},
        section('Runs', null, null, el('div', { class: 'panel' }, d.runs.length ? capped(d.runs.map((r) => item({
          title: `${r.pay_group} · ${dayLabel(r.pay_date)}`, detail: `${plural(r.employees, 'person', 'people')} · gross ${money(r.gross_minor)} · built by ${r.built_by_name}${r.released_by_name ? `, released by ${r.released_by_name}` : ''}`,
          amount: money(r.net_minor), badge: payrollChip(r), onClick: () => openRegister(r.id) })), 5, 'runs') : empty('No runs yet.', null, true))),
        section('Deductions to send on', null, null, el('div', { class: 'panel' }, d.remittances.length ? d.remittances.map((x) => item({
          title: x.name, detail: `due ${dayLabel(x.due_on)}${x.days_late ? ` · ${x.days_late} days late` : ''}${Number(x.employer_match_minor) ? ` · includes ${money(x.employer_match_minor)} employer match` : ''}`,
          amount: money(BigInt(x.deducted_minor) + BigInt(x.employer_match_minor)), badge: x.days_late ? chip('serious', 'warn', 'Late') : null })) : empty('Nothing waiting to be sent.', null, true))))));
}
function payrollChip(r) {
  return { building: chip('neutral', 'pending', 'Built'), pending_release: r.approval_status === 'open' ? chip('warning', 'clock', 'Awaiting approval') : chip('warning', 'clock', 'Ready to release'),
    released: chip('good', 'clock', 'Released'), posted: chip('good', 'ok', 'Posted'), cancelled: chip('neutral', 'pause', 'Cancelled') }[r.status] || chip('neutral', 'info', r.status);
}
function openRegister(id) {
  const d = openDialog('Payroll register', null, { wide: true });
  fillDialog(d, async () => {
    const r = await coApi(`/payroll/runs/${id}`);
    d.dlg.querySelector('h2').textContent = `Payroll for ${dayLabel(r.pay_date)}`;
    return frag(el('div', { class: 'toolbar' }, el('span', { class: 'big', text: money(r.net_minor) }), el('span', { class: 'sub', text: 'net pay' }), payrollChip(r)),
      el('p', { class: 'lead', text: `${shortDay(r.starts_on)} to ${shortDay(r.ends_on)}. Gross ${money(r.gross_minor)}, employee taxes ${money(r.employee_tax_minor)}, deductions ${money(r.deductions_minor)}, employer taxes ${money(r.employer_tax_minor)}. Taxes: ${r.tax_provider}.` }),
      el('div', { class: 'panel' }, NARROW.matches
        ? r.lines.map((l) => item({ title: l.name, amount: `${money(l.net_minor)} net`,
            detail: [l.store, Number(l.regular_hours) || Number(l.overtime_hours) ? `${hours(l.regular_hours)} h${Number(l.overtime_hours) ? ` + ${hours(l.overtime_hours)} overtime` : ''}` : 'salary', `gross ${money(l.gross_minor)}`,
              `taxes ${money(l.employee_tax_minor)}`, `deductions ${money(l.deductions_minor)}`].filter(Boolean).join(' · ') }))
        : tbl([['Employee', 'first'], ['Store'], ['Hours', 'm'], ['Overtime', 'm'], ['Gross', 'm'], ['Taxes', 'm'], ['Deductions', 'm'], ['Net', 'm']],
          r.lines.map((l) => el('tr', {}, td(l.name, 'first'), td(l.store || ''), td(hours(l.regular_hours), 'm'), td(hours(l.overtime_hours), 'm'),
            td(money(l.gross_minor), 'm'), td(money(l.employee_tax_minor), 'm'), td(money(l.deductions_minor), 'm'), td(money(l.net_minor), 'm'))))));
  });
}
function openTimecards(p) {
  const d = openDialog('Timecards', `${shortDay(p.starts_on)} to ${shortDay(p.ends_on)} · pay date ${dayLabel(p.pay_date)}`, { wide: true });
  fillDialog(d, async () => {
    const rows = await coApi(`/payroll/periods/${p.id}/timecards`);
    if (!rows.length) return empty('No time in yet.', null, true);
    return el('div', { class: 'panel' }, rows.map((r) => item({ title: r.name, amount: `${hours(r.hours)} h`,
      detail: [r.store, plural(r.days, 'day')].filter(Boolean).join(' · '),
      badge: r.exceptions ? chip('serious', 'warn', `${r.exceptions} exceptions`) : r.to_approve ? chip('warning', 'clock', `${r.to_approve} to approve`) : chip('good', 'ok', 'Approved') })));
  });
}

/** One person's record, with what can be done to it. */
function openPerson(id) {
  const d = openDialog('Person', null, { wide: true });
  fillDialog(d, async () => {
    const e = await coApi(`/payroll/people/${id}`);
    d.dlg.querySelector('h2').textContent = `${e.first_name} ${e.last_name}`;
    const perPeriod = e.pay_type === 'salary' && e.frequency ? ` (${money(BigInt(e.base_rate_minor) / BigInt(PER_YEAR[e.frequency] || 1))} a period)` : '';
    const acts = [];
    if (e.status === 'active' || e.status === 'leave') {
      acts.push(el('button', { class: 'btn', type: 'button', onclick: () => { d.close(); openChangePerson(e); } }, 'Change details or pay…'));
      acts.push(el('button', { class: 'btn', type: 'button', onclick: () => { d.close(); openLeave(e); } }, 'Record leaving…'));
    }
    const status = e.status === 'applicant' ? resultBox('warning', 'clock', 'Waiting on approval', 'Nobody is paid until the owner approves the hire. It is in their Approvals.')
      : e.status === 'terminated' ? resultBox('neutral', 'pause', `Left ${dayLabel(e.terminated_on)}`, 'Their last period pays them up to that day.') : null;
    const pending = e.pending ? resultBox('warning', 'clock', 'Pay change waiting on the owner',
      `${[e.pending.after.base_rate_minor !== e.pending.before.base_rate_minor || e.pending.after.pay_type !== e.pending.before.pay_type
          ? `${money(e.pending.before.base_rate_minor)} ${e.pending.before.pay_type === 'salary' ? 'a year' : 'an hour'} to ${money(e.pending.after.base_rate_minor)} ${e.pending.after.pay_type === 'salary' ? 'a year' : 'an hour'}` : null,
         e.pending.new_group && e.pending.after.pay_group_id !== e.pending.before.pay_group_id ? `moving to ${e.pending.new_group}` : null].filter(Boolean).join(', ')}. Asked by ${e.pending.requested_by}: “${e.pending.reason}”`) : null;
    return frag(
      el('p', { class: 'lead', text: [e.position, e.store, `employee ${e.employee_no}`].filter(Boolean).join(' · ') }),
      status, pending,
      el('div', { class: 'panel' }, el('div', { class: 'facts' },
        fact('Pay group', e.pay_group ? `${e.pay_group}` : '—'), fact('Pay', `${payText(e)}${perPeriod}`),
        fact('Hired', dayLabel(e.hired_on)), fact('Works in', `${e.work_state}${e.comp_class_code ? ` · comp class ${e.comp_class_code}` : ''}`))),
      acts.length ? el('div', { class: 'dlg-acts' }, acts) : null,
      e.pay.length ? section('Recent pay', null, null, el('div', { class: 'panel' }, e.pay.map((p) => item({ title: dayLabel(p.pay_date),
        detail: Number(p.regular_hours) || Number(p.overtime_hours) ? `${hours(p.regular_hours)} h${Number(p.overtime_hours) ? ` + ${hours(p.overtime_hours)} overtime` : ''} · gross ${money(p.gross_minor)}` : `salary · gross ${money(p.gross_minor)}`,
        amount: `${money(p.net_minor)} net` })))) : null,
      e.history.length ? section('What happened', null, null, el('div', { class: 'panel' }, el('ul', { class: 'timeline' }, e.history.map((h) => el('li', {},
        el('div', { text: sentence(human(h.reason || h.action)) }), el('div', { class: 'when', text: `${fmtStamp.format(new Date(h.at))} · ${h.actor_label}` })))))) : null,
      el('p', { class: 'foot', text: 'Tax setup (the W-4 and Social Security number) belongs with the payroll tax service. None of it is kept here.' }));
  });
}

/** The fields a hire and a change share. */
async function personForm(e) {
  const o = await coApi('/options');
  const f = {
    first: input({ maxlength: '60', value: e ? e.first_name : '' }), last: input({ maxlength: '60', value: e ? e.last_name : '' }),
    position: input({ maxlength: '60', list: 'erp-positions', placeholder: 'e.g. Sales associate', value: e ? e.position || '' : '' }),
    group: select([['', 'Pick the pay group'], ...o.payGroups.map((g) => [g.id, `${g.name} (${(FREQ[g.frequency] || '').toLowerCase()})`])], e ? e.pay_group_id : ''),
    payType: select([['hourly', 'Hourly'], ['salary', 'Salary']], e ? e.pay_type : 'hourly'),
    rate: input({ inputmode: 'decimal', placeholder: '0.00', value: e ? dollars(e.base_rate_minor) : '' }),
    store: select([['', 'Company-wide'], ...o.stores.map((s) => [s.id, s.name])], e ? e.profit_object_id : ''),
    state: input({ maxlength: '2', list: 'erp-states', placeholder: 'TX', value: e ? e.work_state : '' }),
    comp: input({ maxlength: '4', inputmode: 'numeric', placeholder: 'Optional', value: e ? e.comp_class_code || '' : '' }),
  };
  const rateField = field('Hourly rate', f.rate);
  const syncRate = () => { rateField.querySelector('span').textContent = f.payType.value === 'salary' ? 'Annual salary' : 'Hourly rate'; f.rate.placeholder = f.payType.value === 'salary' ? 'e.g. 52000' : 'e.g. 18.50'; };
  f.payType.addEventListener('change', syncRate); syncRate();
  const lists = frag(el('datalist', { id: 'erp-positions' }, o.positions.map((p) => el('option', { value: p }))),
    el('datalist', { id: 'erp-states' }, o.states.map((s) => el('option', { value: s }))));
  return { f, o, rateField, lists };
}

async function openHire() {
  const d = openDialog('Add a person', `${S.co.name} · entered by ${S.person ? S.person.name : 'nobody'}`, { wide: true });
  fillDialog(d, async () => {
    const { f, o, rateField, lists } = await personForm(null);
    if (!o.payGroups.length) return empty('Set up a pay group first', 'A person is paid on a pay group’s schedule. Add one from the Payroll screen.', true);
    const hired = input({ type: 'date', value: todayIso() });
    const no = input({ maxlength: '20', placeholder: 'Next free number' });
    const out = el('div');
    const go = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go, () => post('/payroll/people', {
      firstName: f.first.value, lastName: f.last.value, position: f.position.value, payGroupId: f.group.value, payType: f.payType.value, rate: f.rate.value,
      storeId: f.store.value || null, workState: f.state.value, compClassCode: f.comp.value, hiredOn: hired.value, employeeNo: no.value }),
      (r) => r.status === 'active' ? `Added as ${r.employeeNo}.` : `Entered as ${r.employeeNo}. Nobody is paid until the owner approves the hire.`,
      { close: d.close, errorInto: (e) => out.replaceChildren(resultBox('critical', 'fail', 'Not added', friendly(e))) }) }, 'Add person');
    return frag(lists,
      el('p', { class: 'lead', text: 'The owner approves every hire before any run can pay them. Tax setup (the W-4 and Social Security number) happens with the payroll tax service, never here.' }),
      el('div', { class: 'form-grid' },
        field('First name', f.first), field('Last name', f.last),
        field('Position', f.position), field('Pay group', f.group, 'How often they are paid'),
        field('Pay type', f.payType), rateField,
        field('Store', f.store), field('Works in (state)', f.state, 'Two letters, for tax and comp'),
        field('Hire date', hired), field('Workers’ comp class', f.comp),
        field('Employee number', no, 'Left empty, the next free number')),
      el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
  });
}

function openChangePerson(e) {
  const d = openDialog(`Change ${e.first_name} ${e.last_name}`, 'Position, store, state and comp class change now. Pay, pay type and pay group wait on the owner.', { wide: true });
  fillDialog(d, async () => {
    const { f, lists, rateField } = await personForm(e);
    const reason = el('textarea', { maxlength: '500', placeholder: 'e.g. Promoted to store manager from October' });
    const out = el('div');
    const go = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go, () => post(`/payroll/people/${e.id}`, {
      position: f.position.value, storeId: f.store.value || null, workState: f.state.value, compClassCode: f.comp.value,
      payGroupId: f.group.value, payType: f.payType.value, rate: f.rate.value, reason: reason.value }),
      (r) => r.pay ? (r.approval ? 'Pay change sent to the owner for approval.' : 'Pay changed.') : r.details ? 'Details changed.' : 'Nothing was different.',
      { close: d.close, errorInto: (x) => out.replaceChildren(resultBox('critical', 'fail', 'Not changed', friendly(x))) }) }, 'Save');
    return frag(lists,
      el('div', { class: 'form-grid' },
        field('Position', f.position), field('Store', f.store),
        field('Works in (state)', f.state), field('Workers’ comp class', f.comp),
        field('Pay group', f.group), field('Pay type', f.payType), rateField),
      field('Why', reason, 'Goes on the record, and to the owner with any pay change'),
      el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
  });
}

function openLeave(e) {
  const d = openDialog(`${e.first_name} ${e.last_name} is leaving`, 'Their last period still pays them up to the last day worked.');
  const day = input({ type: 'date', value: todayIso() });
  const reason = el('textarea', { maxlength: '500', placeholder: 'e.g. Resigned; two weeks’ notice given' });
  const out = el('div');
  const go = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go, () => post(`/payroll/people/${e.id}/end`, { terminatedOn: day.value, reason: reason.value }),
    'Recorded. They stay on the record, off future runs.', { close: d.close, errorInto: (x) => out.replaceChildren(resultBox('critical', 'fail', 'Not recorded', friendly(x))) }) }, 'Record leaving');
  d.body.append(field('Last day worked', day), field('Why', reason),
    el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
}

function openAddGroup() {
  const d = openDialog('Add a pay group', `${S.co.name} · a schedule some people are paid on`, { wide: true });
  fillDialog(d, async () => {
    const o = await coApi('/options');
    if (!o.payrollBanks.length) return empty('No account to pay from', 'Add the payroll or operating bank account in Setup first.', true);
    const name = input({ maxlength: '60', placeholder: 'e.g. Managers, semimonthly' });
    const freq = select(Object.entries(FREQ), 'weekly');
    const start = input({ type: 'date' });
    const startHint = el('span', { class: 'hint' });
    const lag = input({ type: 'number', min: '0', max: '31', value: '5' });
    const dow = select(DOW.map((n, i) => [i, n]), 0);
    const ot = input({ type: 'number', min: '1', max: '60', value: '40' });
    const bank = select(o.payrollBanks.map((b) => [b.id, `${b.name}, ${b.bank_name} ••${b.account_last4}`]), o.payrollBanks[0].id);
    const sync = () => {
      const f = freq.value;
      startHint.textContent = f === 'semimonthly' ? 'The 1st or the 16th; periods run the 1st to the 15th and the 16th to the month’s end'
        : f === 'monthly' ? 'The 1st; periods are calendar months' : f === 'biweekly' ? 'Any day; each period is 14 days' : 'Any day; each period is 7 days';
      if (f === 'semimonthly' || f === 'monthly') { if (lag.value === '5') lag.value = '0'; } else if (lag.value === '0') lag.value = '5';
    };
    freq.addEventListener('change', sync); sync();
    const out = el('div');
    const go = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go, () => post('/payroll/groups', {
      name: name.value, frequency: freq.value, firstStartsOn: start.value, payLagDays: Number(lag.value), workweekStartDow: Number(dow.value),
      overtimeAfterHours: Number(ot.value), bankAccountId: bank.value }),
      (r) => `Pay group set up. First period ${shortDay(r.firstPeriod.startsOn)} to ${shortDay(r.firstPeriod.endsOn)}, paid ${dayLabel(r.firstPeriod.payDate)}.`,
      { close: d.close, errorInto: (x) => out.replaceChildren(resultBox('critical', 'fail', 'Not set up', friendly(x))) }) }, 'Set up pay group');
    return frag(
      el('div', { class: 'form-grid' },
        field('Name', name), field('How often', freq),
        el('label', { class: 'field' }, el('span', { text: 'First period starts' }), start, startHint),
        field('Pay date', lag, 'Days after a period ends; a weekend moves to the Friday before'),
        field('Workweek starts', dow, 'Overtime is counted per workweek. Weekly and biweekly groups count from the period start'),
        field('Overtime after (hours a week)', ot),
        field('Paid from', bank, null, true)),
      el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
  });
}

// ================================================================ setup
const ROLE_LIST = [['owner', 'Owner', 'Approves payroll, hires and pay changes; changes setup'],
  ['controller', 'Controller', 'Signs off stopped bills and vendor details; approves by the company’s rules'],
  ['approver', 'Approver', 'Approves bills by the company’s rules'], ['ap_clerk', 'A/P clerk', 'Enters bills'],
  ['viewer', 'Viewer', 'Sees everything; no rule asks them to approve']];
const PURPOSE = { operating: 'Operating', deposit: 'Store deposits', payroll: 'Payroll', tax: 'Tax' };
const SUBJECT = { invoice: 'Bills', payment_run: 'Payment runs', payroll_run: 'Payroll runs', vendor: 'New vendors', vendor_bank_account: 'Vendor bank details',
  employee: 'New hires', employee_change: 'Pay changes', journal_entry: 'Journal entries', fiscal_period: 'Closing a month' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KIND = { rto: 'Rent-to-own', retail: 'Retail', trucking: 'Trucking', services: 'Services' };
const UNIT = { rto: ['Store', 'Stores'], retail: ['Store', 'Stores'], trucking: ['Truck', 'Trucks'], services: ['Job', 'Jobs'] };
const isOwner = () => !!(S.person && S.person.roles.includes('owner'));

/** Refresh who can act here after the people or their roles change, keeping the person picked. */
async function refreshPeople() {
  S.people = await coApi('/people');
  const same = S.person && S.people.find((p) => p.id === S.person.id);
  setPerson(same || S.people[0] || null);
  renderNav();
}

async function screenSetup() {
  const d = await coApi('/setup');
  const c = d.company;
  const [one, many] = UNIT[c.vertical] || ['Store', 'Stores'];
  const owner = isOwner();
  const ownerBtn = (label, fn) => el('button', { class: 'btn small', type: 'button', disabled: !owner || null, onclick: fn }, icon('plus'), label);
  return frag(
    head('Setup', [el('button', { class: 'btn', type: 'button', onclick: () => openNewCompany() }, icon('plus'), 'Add a company')]),
    el('p', { class: 'lead', text: owner ? `What ${c.name} is made of: its ${many.toLowerCase()}, bank accounts, the people who act for it and the rules they approve by. Changes here are the owner’s, and each one is recorded with their name.`
      : `Acting as ${S.person ? S.person.name : 'nobody'}, who is not an owner of ${c.name}: everything here can be seen, and only the owner changes it.` }),
    section('Company', null, null, el('div', { class: 'panel' }, el('div', { class: 'facts' },
      fact('Name', c.name), fact('Legal name', c.legal_name || '—'), fact('Client', `${c.client} · ${(KIND[c.vertical] || c.vertical).toLowerCase()}`),
      fact('Fiscal year ends', MONTHS[(c.fiscal_year_end_month || 12) - 1]), fact('EIN', c.ein_last4 ? `••${c.ein_last4}` : 'Not entered')))),
    el('div', { class: 'two' },
      el('div', {},
        section(many, `${d.stores.length}`, [ownerBtn(`Add ${one.toLowerCase()}`, () => openAddStore(c, one))],
          el('div', { class: 'panel' }, d.stores.length ? d.stores.map((s) => item({ title: s.name,
            detail: [s.code, s.state, s.kind === 'company' ? 'company-wide' : null, s.people ? `${plural(s.people, 'person', 'people')} on payroll` : null].filter(Boolean).join(' · '),
            badge: s.status === 'active' ? null : chip('neutral', 'pause', cap(s.status)) })) : empty(`No ${many.toLowerCase()} yet.`, null, true))),
        section('Bank accounts', `${d.banks.length}`, [ownerBtn('Add account', () => openAddBank(d.stores, one))],
          el('div', { class: 'panel' }, d.banks.length ? d.banks.map((b) => item({ title: b.name,
            detail: [PURPOSE[b.purpose] || b.purpose, `${b.bank_name} ••${b.account_last4}`, b.location, `books to ${b.gl_code}`, b.ach_origination_enabled ? 'sends ACH' : null].filter(Boolean).join(' · '),
            badge: b.status === 'active' ? null : chip('neutral', 'pause', cap(b.status)) })) : empty('No bank accounts yet.', null, true)),
          el('p', { class: 'foot', text: 'Only the last four digits of an account are kept here; the full numbers stay with the bank.' }))),
      el('div', {},
        section('People and roles', `${d.people.length}`, [ownerBtn('Add person', () => openAddPerson())],
          el('div', { class: 'panel' }, d.people.map((p) => item({ title: p.name,
            detail: [p.email, p.own_roles.some((r) => !p.client_roles.includes(r)) ? p.own_roles.filter((r) => !p.client_roles.includes(r)).map((r) => ROLE[r] || r).join(', ') : null,
              p.client_roles.length ? `${p.client_roles.map((r) => ROLE[r] || r).join(', ')} for every ${c.client} company` : null,
              p.own_roles.length || p.client_roles.length ? null : 'no roles here'].filter(Boolean).join(' · '),
            acts: owner ? [el('button', { class: 'btn small', type: 'button', onclick: () => openRoles(p) }, 'Roles…')] : null })))),
        section('Approval rules', null, null,
          el('div', { class: 'panel' }, d.policies.length ? d.policies.map((p) => item({ title: SUBJECT[p.subject_type] || cap(p.subject_type.replace(/_/g, ' ')),
            detail: `${Number(p.min_amount_minor) ? `From ${money(p.min_amount_minor)}: approved` : 'Approved'} by the ${p.steps.join(', then the ')}${p.requires_callback ? ', each after a call-back to the number on file' : ''}` }))
            : empty('No approval rules', 'Nothing here needs a second person yet.', true)),
          el('p', { class: 'foot', text: 'The rules were set up with the company to fit the roles its people hold. Changing them from this screen is still to build.' })))));
}

function openAddStore(c, one) {
  const d = openDialog(`Add a ${one.toLowerCase()}`, S.co.name);
  const code = input({ maxlength: '12', class: 'upper', placeholder: 'e.g. ENL' });
  const name = input({ maxlength: '60', placeholder: one === 'Store' ? 'e.g. Enola' : '' });
  const state = input({ maxlength: '2', class: 'upper', placeholder: 'PA' });
  const out = el('div');
  const go = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go, () => post('/setup/stores', { code: code.value, name: name.value, state: state.value }),
    `${one} added.`, { close: d.close, errorInto: (e) => out.replaceChildren(resultBox('critical', 'fail', 'Not added', friendly(e))) }) }, `Add ${one.toLowerCase()}`);
  d.body.append(el('div', { class: 'form-grid' }, field('Short code', code, 'Letters and numbers, on reports'), field('Name', name),
      one === 'Store' ? field('State', state, 'Two letters') : null),
    el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
  code.focus();
}

/** The fields of one bank account, shared by Setup and a new company. storeCodes() lists the stores to pick from. */
function bankFields(storeCodes, init, unit) {
  init = init || {};
  const f = {
    purpose: select(Object.entries(PURPOSE), init.purpose || 'operating'),
    name: input({ maxlength: '60', placeholder: 'e.g. Operating', value: init.name || '' }),
    bankName: input({ maxlength: '80', placeholder: 'e.g. First Keystone Bank' }),
    routing: input({ maxlength: '4', inputmode: 'numeric', placeholder: 'Last 4' }),
    account: input({ maxlength: '4', inputmode: 'numeric', placeholder: 'Last 4' }),
    store: el('select', {}),
    ach: checkbox('Sends ACH payments from it', false),
  };
  const fillStores = () => {
    const keep = f.store.value;
    f.store.replaceChildren(el('option', { value: '', text: 'Company-wide' }), ...storeCodes().map(([code, name]) => el('option', { value: code, text: `${name} (${code})` })));
    f.store.value = keep;
  };
  fillStores();
  f.store.addEventListener('focus', fillStores);
  f.store.addEventListener('mousedown', fillStores);
  const value = () => ({ purpose: f.purpose.value, name: f.name.value, bankName: f.bankName.value, routingLast4: f.routing.value,
    accountLast4: f.account.value, storeCode: f.store.value || null, ach: f.ach.box.checked });
  const blank = () => !f.name.value.trim() && !f.bankName.value.trim() && !f.routing.value.trim() && !f.account.value.trim();
  const storeField = field('Store', f.store, 'A deposit account belongs to a store');
  const setUnit = (one) => {
    storeField.querySelector('span').textContent = one;
    storeField.querySelector('.hint').textContent = `A deposit account belongs to a ${one.toLowerCase()}`;
  };
  setUnit(unit || 'Store');
  const fields = [field('Used for', f.purpose), field('Name', f.name), field('Bank', f.bankName, null, true),
    field('Routing number', f.routing, 'Last four digits'), field('Account number', f.account, 'Last four digits'),
    storeField, f.ach.node];
  return { f, value, blank, fields, setUnit, focus: () => f.name.focus() };
}

function openAddBank(stores, one) {
  const d = openDialog('Add a bank account', S.co.name, { wide: true });
  const b = bankFields(() => stores.filter((s) => s.kind !== 'company').map((s) => [s.code, s.name]), { purpose: 'deposit' }, one);
  const out = el('div');
  const go = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go, () => post('/setup/banks', b.value()),
    'Account added.', { close: d.close, errorInto: (e) => out.replaceChildren(resultBox('critical', 'fail', 'Not added', friendly(e))) }) }, 'Add account');
  d.body.append(el('p', { class: 'lead', text: 'Only the last four digits are kept here. The full numbers stay with the bank and in the secrets store the bank connection reads.' }),
    el('div', { class: 'form-grid' }, b.fields),
    el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
}

/** Role checkboxes. Roles held for every company of the client show ticked and fixed. */
function roleChecks(own, clientWide) {
  own = own || []; clientWide = clientWide || [];
  const boxes = ROLE_LIST.map(([code, label, hint]) => {
    const fixed = clientWide.includes(code);
    const box = el('input', { type: 'checkbox', checked: fixed || own.includes(code), disabled: fixed || null, value: code });
    return { code, box, fixed, node: el('label', { class: 'check role' }, box, el('span', {}, el('b', { text: label }), el('span', { class: 'sub', text: fixed ? ' · held for every company of the client' : ` · ${hint}` }))) };
  });
  return { node: el('div', { class: 'checks' }, boxes.map((b) => b.node)), value: () => boxes.filter((b) => !b.fixed && b.box.checked).map((b) => b.code) };
}

function openAddPerson() {
  const d = openDialog('Add a person', `Someone who acts for ${S.co.name}`);
  const name = input({ maxlength: '80' });
  const email = input({ type: 'email', maxlength: '120' });
  const rc = roleChecks([], []);
  const out = el('div');
  const go = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go, async () => { const r = await post('/setup/people', { name: name.value, email: email.value, roles: rc.value() }); await refreshPeople(); return r; },
    'Added. They can be picked under Act as.', { close: d.close, errorInto: (e) => out.replaceChildren(resultBox('critical', 'fail', 'Not added', friendly(e))) }) }, 'Add person');
  d.body.append(el('p', { class: 'lead', text: 'A person here is someone who enters or approves things, not an employee on payroll; those are added from Payroll. Their roles decide what waits on them.' }),
    el('div', { class: 'form-grid' }, field('Name', name), field('Email', email)),
    el('div', { class: 'k', text: 'Roles' }), rc.node,
    el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
  name.focus();
}

function openRoles(p) {
  const d = openDialog(`Roles for ${p.name}`, `What waits on them in ${S.co.name}`);
  const rc = roleChecks(p.own_roles, p.client_roles);
  const out = el('div');
  const go = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go, async () => { const r = await post(`/setup/people/${p.id}/roles`, { roles: rc.value() }); await refreshPeople(); return r; },
    'Roles saved.', { close: d.close, errorInto: (e) => out.replaceChildren(resultBox('critical', 'fail', 'Not saved', friendly(e))) }) }, 'Save roles');
  d.body.append(el('p', { class: 'lead', text: 'Someone never approves what they entered themselves, whatever roles they hold. The company always keeps at least one owner.' }), rc.node,
    el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
}

/** Rows of the same fields: one more on a tap, any one taken out. */
function rowList(make, addLabel, initial) {
  const rows = [];
  const list = el('div', { class: 'rowlist' });
  const add = (init) => {
    const r = make(init || {});
    const box = el('div', { class: 'rowbox' }, el('div', { class: 'form-grid' }, r.fields));
    box.append(el('button', { class: 'icon-btn rm', type: 'button', 'aria-label': 'Take this one out', onclick: () => { rows.splice(rows.indexOf(r), 1); box.remove(); } }, icon('x')));
    rows.push(r); list.append(box);
    return r;
  };
  for (const init of initial) add(init);
  const more = el('button', { class: 'btn small', type: 'button', onclick: () => add({}).focus() }, icon('plus'), addLabel);
  return { node: el('div', {}, list, more), rows };
}

/** A new company, for a client already here or a new one: who it is, its stores, bank accounts and people. */
function openNewCompany() {
  const d = openDialog('Add a company', 'Everything it needs to start: its stores, where its money is, and who acts for it', { wide: true });
  fillDialog(d, async () => {
    const clients = await api('/api/clients');
    const client = select([...clients.map((t) => [t.id, `${t.name} (${plural(t.companies, 'company', 'companies')})`]), ['new', 'A new client…']], S.co.tenant_id || (clients[0] && clients[0].id) || 'new');
    const clientName = input({ maxlength: '60', placeholder: 'The business this company belongs to' });
    const vertical = select(Object.entries(KIND), 'rto');
    const chartFrom = select([...clients.map((t) => [t.id, `Copy ${t.name}’s chart (${t.accounts} accounts)`]), ['', 'Only the accounts the ERP posts to']], S.co.tenant_id || (clients[0] ? clients[0].id : ''));
    const newClient = el('div', { class: 'form-grid' }, field('Client name', clientName), field('Kind of business', vertical), field('Chart of accounts', chartFrom, 'A new client starts from a copy; it can be changed after', true));
    const name = input({ maxlength: '60', placeholder: 'e.g. Buddy’s Home Furnishings West' });
    const legal = input({ maxlength: '120', placeholder: 'As on its tax filings' });
    const ein = input({ maxlength: '4', inputmode: 'numeric', placeholder: 'Last 4' });
    const fy = select(MONTHS.map((m, i) => [i + 1, m]), 12);
    const verticalNow = () => (client.value === 'new' ? vertical.value : (clients.find((t) => t.id === client.value) || {}).vertical || 'rto');
    const storeHead = formSec('Stores');
    const stores = rowList(() => {
      const code = input({ maxlength: '12', class: 'upper', placeholder: 'e.g. ENL' });
      const nm = input({ maxlength: '60' });
      const st = input({ maxlength: '2', class: 'upper', placeholder: 'PA' });
      return { fields: [field('Short code', code), field('Name', nm), field('State', st)], focus: () => code.focus(),
        value: () => (code.value.trim() || nm.value.trim() ? { code: code.value, name: nm.value, state: st.value } : null) };
    }, 'Add another', [{}]);
    const storeCodes = () => stores.rows.map((r) => r.value()).filter(Boolean).map((s) => [s.code.trim().toUpperCase(), s.name.trim() || s.code]);
    const unitNow = () => (UNIT[verticalNow()] || UNIT.rto)[0];
    const banks = rowList((init) => bankFields(storeCodes, init, unitNow()), 'Add another account', [{ purpose: 'operating', name: 'Operating' }]);
    const people = rowList(() => {
      const nm = input({ maxlength: '80' });
      const em = input({ type: 'email', maxlength: '120' });
      const rc = roleChecks([], []);
      return { fields: [field('Name', nm), field('Email', em), el('div', { class: 'wide' }, rc.node)], focus: () => nm.focus(),
        value: () => (nm.value.trim() || em.value.trim() ? { name: nm.value, email: em.value, roles: rc.value() } : null) };
    }, 'Add another person', [{}]);
    const sync = () => {
      newClient.hidden = client.value !== 'new';
      const [one, many] = UNIT[verticalNow()] || UNIT.rto;
      storeHead.textContent = many;
      for (const r of banks.rows) r.setUnit(one);
    };
    client.addEventListener('change', sync); vertical.addEventListener('change', sync); sync();
    const out = el('div');
    const setUp = el('button', { class: 'btn primary', type: 'button', onclick: async () => {
      out.replaceChildren();
      const body = { clientId: client.value === 'new' ? null : client.value, clientName: clientName.value, vertical: vertical.value, chartFrom: chartFrom.value || null,
        name: name.value, legalName: legal.value, einLast4: ein.value, fiscalYearEndMonth: Number(fy.value),
        stores: stores.rows.map((r) => r.value()).filter(Boolean), banks: banks.rows.filter((r) => !r.blank()).map((r) => r.value()),
        people: people.rows.map((r) => r.value()).filter(Boolean) };
      busy(setUp, true, 'Setting it up…');
      try {
        const r = await api('/api/companies', { method: 'POST', body });
        S.me = await api('/api/me');
        S.companies = S.me.companies;
        const c = S.companies.find((x) => x.id === r.id);
        d.close();
        if (c) { await setCompany(c); go('setup'); }
        toast(r.warning || `${body.name.trim()} is set up.`, r.warning ? 'warning' : 'good');
      } catch (e) {
        if (!(e instanceof Stop)) out.replaceChildren(resultBox('critical', 'fail', 'Not set up', friendly(e)));
      } finally { if (setUp.isConnected) busy(setUp, false); }
    } }, 'Set up the company');
    return frag(
      el('div', { class: 'form-grid' },
        formSec('Client'), field('Belongs to', client, 'A client’s companies share one chart of accounts and one vendor list', true)),
      newClient,
      el('div', { class: 'form-grid' },
        formSec('Company'), field('Name', name), field('Legal name', legal), field('EIN', ein, 'Last four digits only'), field('Fiscal year ends', fy),
        storeHead),
      stores.node,
      el('div', { class: 'form-grid' }, formSec('Bank accounts')),
      el('p', { class: 'lead', text: 'Exactly one operating account. Only the last four digits are kept here; the full numbers stay with the bank.' }),
      banks.node,
      el('div', { class: 'form-grid' }, formSec('People')),
      el('p', { class: 'lead', text: 'Who enters and approves things for this company, not the employees on payroll. At least one owner; with two or more people, nobody approves what they entered.' }),
      people.node,
      el('p', { class: 'foot', text: 'The approval rules are set up to fit the roles given here, and a year of monthly periods is opened for the books.' }),
      el('div', { class: 'dlg-acts' }, setUp, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
  });
}

// ================================================================ books
function periodRange(key) {
  const t = new Date(); const y = t.getFullYear(), m = t.getMonth();
  if (key === 'last') return [isoDay(new Date(y, m - 1, 1)), isoDay(new Date(y, m, 0))];
  if (key === 'qtd') return [isoDay(new Date(y, Math.floor(m / 3) * 3, 1)), isoDay(t)];
  if (key === 'ytd') return [isoDay(new Date(y, 0, 1)), isoDay(t)];
  return [isoDay(new Date(y, m, 1)), isoDay(t)];
}
async function screenBooks(sub) {
  const view = sub === 'tb' ? 'tb' : 'pnl';
  const top = frag(head('Books'), el('div', { class: 'toolbar' }, seg([['pnl', 'Profit and loss'], ['tb', 'Trial balance']], view, (v) => go('books', v))));
  return view === 'tb' ? frag(top, await trialBalanceView()) : frag(top, await pnlView());
}
const SECTIONS = [['Revenue', (c) => c.startsWith('4')], ['Cost of merchandise', (c) => c.startsWith('5')], ['Operating expenses', (c) => c.startsWith('6')], ['Other expenses', (c) => /^[789]/.test(c)]];
const NARROW = window.matchMedia('(max-width: 719px)');
NARROW.addEventListener('change', () => { if (S.co && S.route.screen === 'books' && !document.querySelector('dialog[open]')) render(); });
async function pnlView() {
  const [from, to] = periodRange(S.pnlPeriod);
  const d = await coApi(`/books/pnl?from=${from}&to=${to}`);
  const periods = seg([['mtd', 'This month'], ['last', 'Last month'], ['qtd', 'Quarter'], ['ytd', 'Year']], S.pnlPeriod, (v) => { S.pnlPeriod = v; render(); });
  const bar = frag(el('div', { class: 'toolbar' }, periods), el('p', { class: 'sub', text: `${dayLabel(from)} to ${dayLabel(to)}. Tap any amount to see the entries behind it.` }));
  if (!d.accounts.length) return frag(bar, el('div', { class: 'panel' }, empty('Nothing posted in this period.', null, true)));
  // A store with nothing posted in the period gets no column.
  let cols = d.stores.filter((s) => d.accounts.some((a) => Number(a.byStore[s.id] || 0) !== 0));
  let pickCol = null;
  if (NARROW.matches) {
    // On a phone, one column at a time: the total, or one store.
    if (S.pnlCol !== 'total' && !cols.some((s) => s.id === S.pnlCol)) S.pnlCol = 'total';
    pickCol = el('div', { class: 'toolbar' }, seg([['total', 'All'], ...cols.map((s) => [s.id, s.name])], S.pnlCol, (v) => { S.pnlCol = v; render(); }));
    cols = S.pnlCol === 'total' ? [] : cols.filter((s) => s.id === S.pnlCol);
  }
  const showTotal = !pickCol || S.pnlCol === 'total';
  const cell = (acct, store, amount) => el('td', { class: 'm' }, Number(amount || 0) === 0 ? el('span', { class: 'muted', text: '—' })
    : el('button', { class: 'cellbtn', type: 'button', onclick: () => openAccount(acct, store, from, to), 'aria-label': `${acct.name}, ${store ? store.name : 'all stores'}: ${money(amount)}` }, money(amount)));
  const sumBy = (accts, sid) => accts.reduce((s, a) => s + BigInt(sid ? (a.byStore[sid] || '0') : a.total), 0n);
  const rows = [];
  const totals = {};
  for (const [name, test] of SECTIONS) {
    const accts = d.accounts.filter((a) => test(a.code) && (showTotal || cols.some((s) => Number(a.byStore[s.id] || 0) !== 0)));
    if (!accts.length) continue;
    rows.push(el('tr', { class: 'sec' }, el('td', { class: 'first', text: name }), cols.map(() => el('td')), showTotal ? el('td') : null));
    for (const a of accts) rows.push(el('tr', {}, el('td', { class: 'first', text: `${a.code} ${a.name}` }), cols.map((s) => cell(a, s, a.byStore[s.id])), showTotal ? cell(a, null, a.total) : null));
    rows.push(el('tr', { class: 'sum' }, el('td', { class: 'first', text: `Total ${name.toLowerCase()}` }), cols.map((s) => td(money(sumBy(accts, s.id)), 'm')), showTotal ? td(money(sumBy(accts, null)), 'm') : null));
    totals[name] = accts;
  }
  const revenue = totals['Revenue'] || [];
  const costs = [].concat(totals['Cost of merchandise'] || [], totals['Operating expenses'] || [], totals['Other expenses'] || []);
  rows.push(el('tr', { class: 'total' }, el('td', { class: 'first', text: 'Net income' }),
    cols.map((s) => td(money(sumBy(revenue, s.id) - sumBy(costs, s.id)), 'm')), showTotal ? td(money(sumBy(revenue, null) - sumBy(costs, null)), 'm') : null));
  return frag(bar, pickCol, el('div', { class: 'panel' }, tbl([['Account', 'first'], ...cols.map((s) => [s.name, 'm']), showTotal ? ['Total', 'm'] : null].filter(Boolean), rows)),
    d.stores.some((s) => s.id === 'none') ? el('p', { class: 'foot', text: '“Company” holds costs not tied to a store: employer payroll taxes, card fees and the like.' }) : null);
}
function openAccount(acct, store, from, to) {
  const d = openDialog(`${acct.code} ${acct.name}`, `${store ? store.name : 'All stores'} · ${dayLabel(from)} to ${dayLabel(to)}`, { wide: true });
  const storeId = store ? store.id : null;
  fillDialog(d, async () => {
    const r = await coApi(`/books/account/${encodeURIComponent(acct.code)}?from=${from}&to=${to}${storeId ? '&store=' + storeId : ''}`);
    const revenue = r.account.account_type === 'revenue';
    const amt = (l) => revenue ? BigInt(l.credit_minor) - BigInt(l.debit_minor) : BigInt(l.debit_minor) - BigInt(l.credit_minor);
    const total = r.lines.reduce((s, l) => s + amt(l), 0n);
    return frag(el('div', { class: 'toolbar' }, el('span', { class: 'big', text: money(total) }), el('span', { class: 'sub', text: plural(r.lines.length, 'entry', 'entries') })),
      el('div', { class: 'panel' }, r.lines.length ? capped(r.lines.map((l) => item({ title: human(l.description), detail: [dayLabel(l.posting_date), l.store || (l.bank_account ? l.bank_account : 'Company'), human(l.memo)].filter(Boolean).join(' · '),
        amount: money(amt(l)), onClick: () => openEntry(l.entry_id) })), 40, 'entries') : empty('No entries.', null, true)));
  });
}
function openEntry(id) {
  const d = openDialog('Journal entry', null, { wide: true });
  fillDialog(d, async () => {
    const e = await coApi(`/books/entry/${id}`);
    d.dlg.querySelector('h2').textContent = human(e.description);
    const dr = e.lines.reduce((s, l) => s + BigInt(l.debit_minor), 0n), cr = e.lines.reduce((s, l) => s + BigInt(l.credit_minor), 0n);
    const src = e.source ? el('button', { class: 'btn', type: 'button', onclick: () => openSubject(`${e.source.kind}:${e.source.id}`) }, e.source.label) : null;
    const SOURCE = { invoice: 'a bill', payment: 'a payment run', payroll: 'payroll', manual: 'entered by hand', bank_transfer: 'a sweep', pos: 'store takings', reconciliation: 'reconciliation' };
    return frag(
      el('p', { class: 'lead', text: `${dayLabel(e.posting_date)} · from ${SOURCE[e.source_type] || e.source_type} · posted by ${e.posted_by_name || e.actor_kind}${e.posted_at ? ', ' + fmtStamp.format(new Date(e.posted_at)) : ''}` }),
      el('div', { class: 'panel' }, NARROW.matches
        ? [...e.lines.map((l) => item({ title: `${l.code} ${l.account}`, detail: [l.store || l.bank_account, human(l.memo)].filter(Boolean).join(' · '),
              amount: Number(l.debit_minor) ? `${money(l.debit_minor)} Dr` : `${money(l.credit_minor)} Cr` })),
           item({ title: dr === cr ? 'Balanced' : 'Out of balance', amount: `${money(dr)} each side`, badge: dr === cr ? chip('good', 'ok', 'Balanced') : chip('critical', 'fail', 'Out') })]
        : tbl([['Account', 'first'], ['Where'], ['Debit', 'm'], ['Credit', 'm']], [
          ...e.lines.map((l) => el('tr', {}, td(`${l.code} ${l.account}${l.memo ? ' — ' + human(l.memo) : ''}`, 'first'), td(l.store || l.bank_account || ''),
            td(Number(l.debit_minor) ? money(l.debit_minor) : '', 'm'), td(Number(l.credit_minor) ? money(l.credit_minor) : '', 'm'))),
          el('tr', { class: 'total' }, td('Total', 'first'), td(dr === cr ? 'Balanced' : 'Out of balance'), td(money(dr), 'm'), td(money(cr), 'm'))])),
      el('p', { class: 'foot', text: 'Entries are never edited. A correction is a reversing entry, with its own date and reason.' }),
      src ? el('div', { class: 'dlg-acts' }, src) : null);
  });
}
async function trialBalanceView() {
  const asOf = S.tbAsOf || todayIso();
  const d = await coApi(`/books/trial-balance?asOf=${asOf}`);
  const date = el('input', { type: 'date', value: asOf, onchange: (e) => { S.tbAsOf = e.target.value; render(); } });
  let dr = 0n, cr = 0n;
  const rows = [];
  // On a phone, one balance column with credits marked Cr; on a wider screen, debit and credit columns.
  const one = NARROW.matches;
  for (const [type, label] of [['asset', 'Assets'], ['liability', 'Liabilities'], ['equity', 'Equity'], ['revenue', 'Revenue'], ['expense', 'Expenses']]) {
    const list = d.rows.filter((r) => r.account_type === type && BigInt(r.balance_minor) !== 0n);
    if (!list.length) continue;
    rows.push(el('tr', { class: 'sec' }, td(label, 'first'), el('td'), one ? null : el('td')));
    for (const r of list) {
      const b = BigInt(r.balance_minor);
      if (b > 0n) dr += b; else cr -= b;
      rows.push(one
        ? el('tr', {}, td(`${r.code} ${r.name}`, 'first'), td(b > 0n ? money(b) : `${money(-b)} Cr`, 'm'))
        : el('tr', {}, td(`${r.code} ${r.name}`, 'first'), td(b > 0n ? money(b) : '', 'm'), td(b < 0n ? money(-b) : '', 'm')));
    }
  }
  if (one) {
    rows.push(el('tr', { class: 'total' }, td('Debits', 'first'), td(money(dr), 'm')), el('tr', { class: 'total' }, td('Credits', 'first'), td(money(cr), 'm')));
  } else rows.push(el('tr', { class: 'total' }, td('Total', 'first'), td(money(dr), 'm'), td(money(cr), 'm')));
  return frag(
    el('div', { class: 'toolbar' }, el('label', { class: 'field inline' }, el('span', { text: 'As of' }), date),
      dr === cr ? chip('good', 'ok', 'Balanced') : chip('critical', 'fail', `Out by ${money(dr - cr)}`)),
    el('div', { class: 'panel' }, d.rows.length ? tbl(one ? [['Account', 'first'], ['Balance', 'm']] : [['Account', 'first'], ['Debit', 'm'], ['Credit', 'm']], rows) : empty('Nothing posted yet.', null, true)),
    section('Periods', null, null, el('div', { class: 'panel' }, d.periods.map((p) => item({ title: `${fmtDate.format(parseDay(p.starts_on)).replace(/ \d+,/, '')}`,
      detail: `${dayLabel(p.starts_on)} to ${dayLabel(p.ends_on)}`, badge: p.status === 'open' ? chip('good', 'ok', 'Open') : p.status === 'soft_locked' ? chip('neutral', 'pause', 'Soft-locked') : chip('neutral', 'hold', 'Closed') })))),
    el('p', { class: 'foot', text: 'A soft-locked month still takes a late entry for the day; a closed month takes nothing.' }));
}

// ================================================================= cash
async function screenCash() {
  const d = await coApi('/cash');
  const total = d.positions.reduce((s, p) => s + BigInt(p.ledger_balance_minor), 0n);
  const op = d.positions.find((p) => p.purpose === 'operating');
  const waiting = d.waiting.reduce((s, w) => s + BigInt(w.balance_minor), 0n);
  const open = d.transfers.filter((t) => ['expected', 'planned'].includes(t.status));
  const tiles = tilesRow(
    tile({ label: 'Cash in the books', value: money(total), tone: 'neutral', ic: 'bank', text: plural(d.positions.length, 'account') }),
    tile({ label: 'Operating account', value: op ? money(op.ledger_balance_minor) : '—', tone: 'neutral', ic: 'bank', text: op ? `${op.bank_name} ••${op.account_last4}` : 'None set up' }),
    tile({ label: 'Still at the stores', value: money(waiting), tone: waiting ? 'warning' : 'good', ic: waiting ? 'clock' : 'ok', text: waiting ? `${plural(d.waiting.length, 'store account')} to sweep in` : 'Everything swept in' }),
    tile({ label: 'Sweeps in flight', value: String(open.length), tone: open.some((t) => t.overdue) ? 'serious' : open.length ? 'warning' : 'good',
      ic: open.some((t) => t.overdue) ? 'warn' : open.length ? 'clock' : 'ok',
      text: open.some((t) => t.overdue) ? `${open.filter((t) => t.overdue).length} late` : open.length ? 'To confirm when they land' : 'Nothing outstanding' }));
  const rows = d.positions.map((p) => item({ title: p.name,
    detail: `${p.bank_name} ••${p.account_last4}${p.location_name ? ' · ' + p.location_name : ''} · ${p.last_statement_minor != null ? `bank said ${money(p.last_statement_minor)} on ${shortDay(p.last_statement_on)}` : 'no bank statement yet'}`,
    amount: money(p.ledger_balance_minor) }));
  const plan = el('button', { class: 'btn primary', type: 'button', onclick: () => act(plan, () => post('/cash/plan'),
    (r) => r.planned.length ? `${plural(r.planned.length, 'sweep')} planned: ${r.planned.map((p) => `${p.fromAccount} ${money(p.amountMinor)} (${p.method === 'bank_zba' ? 'the bank' : p.method === 'ach_pull' ? 'we pull it' : 'by hand'})`).join('; ')}.` : 'Nothing at the stores to sweep.') }, 'Plan today’s sweeps');
  const methodText = { bank_zba: 'the bank sweeps it overnight', ach_pull: 'we pull it by ACH', manual: 'someone moves it by hand' };
  const transfers = d.transfers.map((t) => {
    const acts = [];
    if (['expected', 'planned'].includes(t.status)) {
      const b = el('button', { class: 'btn small primary', type: 'button', onclick: () => act(b, () => post(`/cash/transfers/${t.id}/confirm`), `Confirmed: ${money(t.amount_minor)} from ${t.from_account} is in, and posted.`) }, 'It arrived');
      acts.push(b);
    }
    return item({ title: `${t.from_account} → ${t.to_account}`,
      detail: `${dayLabel(t.transfer_date)} · ${methodText[t.method] || t.method}${t.assigned_to && t.status === 'planned' ? ` · ${t.assigned_to}’s to do` : ''}${t.confirmed_by ? ` · confirmed by ${t.confirmed_by}` : ''}`,
      amount: money(t.amount_minor),
      badge: t.overdue ? chip('serious', 'warn', 'Late') : t.status === 'expected' ? chip('warning', 'clock', 'Bank to sweep') : t.status === 'planned' ? chip('warning', 'clock', 'To move by hand')
        : t.status === 'sent' ? chip('good', 'ok', 'Pulled') : t.status === 'settled' ? chip('good', 'ok', 'Arrived') : chip('neutral', 'pause', cap(t.status)),
      acts });
  });
  const how = d.coverage ? `${plural(d.coverage.branches, 'store account')}: ${d.coverage.by_the_bank} swept by the bank, ${d.coverage.by_us} pulled by us, ${d.coverage.by_hand} moved by hand.` : 'No sweep rules set up.';
  return frag(head('Cash', [plan]), tiles,
    section('Accounts', 'in the books', null, el('div', { class: 'panel' }, rows)),
    section('Sweeps into operating', how, null, el('div', { class: 'panel' }, transfers.length ? capped(transfers, Math.max(8, open.length)) : empty('No sweeps yet.', null, true))),
    el('p', { class: 'foot', text: 'Nothing is booked until the money moves: a sweep the bank does is confirmed against its statement, and one done by hand stays on someone’s list until they say it arrived. Confirm the ones in flight before planning today’s, or the same money would be counted twice.' }));
}

// ======================================================== reconciliation
async function screenRecon() {
  const d = await coApi('/recon');
  const auto = d.byMethod.filter((m) => m.method !== 'manual').reduce((s, m) => s + m.n, 0);
  const manual = d.byMethod.filter((m) => m.method === 'manual').reduce((s, m) => s + m.n, 0);
  const late = d.deposits.filter((x) => x.days_late > 0);
  const fees = d.accounts.reduce((s, a) => s + BigInt(a.fees_minor), 0n);
  const runAll = el('button', { class: 'btn primary', type: 'button', onclick: () => act(runAll, () => post('/recon/run'),
    (r) => r.lines ? `${r.matched} of ${plural(r.lines, 'open line')} matched${Number(r.fees) ? `, ${money(r.fees)} of card fees posted` : ''}.` : 'Nothing open to match.') }, 'Run matching');
  return frag(head('Reconcile', [runAll]),
    tilesRow(
      tile({ label: 'Bank lines to explain', value: String(d.lines.length), tone: d.lines.length ? 'warning' : 'good', ic: d.lines.length ? 'warn' : 'ok', text: d.lines.length ? 'Match them, or book them' : 'Every line explained' }),
      tile({ label: 'Store deposits not in yet', value: String(d.deposits.length), tone: late.length ? 'serious' : 'neutral', ic: late.length ? 'warn' : 'clock', text: late.length ? `${late.length} late at the bank` : 'None late' }),
      tile({ label: 'Matched', value: String(auto + manual), tone: 'neutral', ic: 'ok', text: `${auto} automatically, ${manual} by a person` }),
      tile({ label: 'Card fees posted', value: money(fees), tone: 'neutral', ic: 'cash', text: 'Settlements come in net of fees' })),
    section('Bank lines nobody has explained', null, null, el('div', { class: 'panel' }, d.lines.length ? d.lines.map((l) => item({
      title: l.description, detail: `${l.account_name} · ${dayLabel(l.posted_on)}${l.days_open ? ` · open ${l.days_open} days` : ''}`, amount: money(l.amount_minor),
      acts: [el('button', { class: 'btn small primary', type: 'button', onclick: () => openMatch(l) }, 'Match or book…')] })) : empty('Every bank line is explained.', null))),
    section('Store deposits the bank has not shown yet', d.deposits.length ? `${d.deposits.length}, ${late.length} late` : null, null, el('div', { class: 'panel' }, d.deposits.length ? capped(
      [...d.deposits].sort((a, b) => b.days_late - a.days_late).map((x) => item({
        title: `${x.location_name} · ${x.method} takings for ${shortDay(x.business_date)}`, detail: `into ${x.account_name} · expected ${dayLabel(x.expected_on)}`, amount: money(x.amount_minor),
        badge: x.days_late > 0 ? chip('serious', 'warn', `${plural(x.days_late, 'day')} late`) : chip('neutral', 'clock', 'Due') })), Math.max(5, late.length), 'deposits') : empty('Every deposit has landed.', null))),
    section('Accounts', null, null, el('div', { class: 'panel' }, d.accounts.map((a) => item({ title: a.name,
      detail: [`${a.bank_name} ••${a.account_last4}`, `${plural(a.lines_total, 'bank line')}, ${a.lines_open} open`, a.deposits_open ? `${plural(a.deposits_open, 'deposit')} waiting` : null,
        a.last_run ? `matched ${ago(a.last_run)}` : 'never matched'].filter(Boolean).join(' · '),
      badge: a.lines_open ? chip('warning', 'warn', `${a.lines_open} to explain`) : a.lines_total ? chip('good', 'ok', 'All explained') : chip('neutral', 'pending', 'No lines yet') })))),
    section('Recent matches', null, null, el('div', { class: 'panel' }, d.matches.length ? capped(d.matches.map((m) => item({
      title: m.description, detail: `${m.account_name} · ${dayLabel(m.posted_on)} · ${matchText(m)}${m.matched_by ? ' · by ' + m.matched_by : ''}`, amount: money(m.amount_minor),
      badge: m.method === 'manual' ? chip('neutral', 'user', 'By a person') : chip('good', 'ok', METHOD[m.method] || cap(m.method)) })), 6, 'matches') : empty('Nothing matched yet.', null, true))),
    el('p', { class: 'foot', text: 'The matchers run most-certain first: a sweep landing, a payment clearing, an exact store deposit, a card settlement net of fees, then several days banked together. Whatever is left is a question for a person.' }));
}
const METHOD = { exact: 'Exact', tolerance: 'Net of fees', batch: 'Days together', manual: 'By a person' };
function matchText(m) {
  const what = { pos_deposit: 'store takings', bank_transfer: 'a sweep', payment: 'a payment', journal_line: 'an entry in the books' }[m.matched_kind] || m.matched_kind;
  return m.method === 'tolerance' ? `${what}, net of ${money(-Number(m.variance_minor))} fees` : m.method === 'batch' ? `${what}, several days together` : what;
}
function openMatch(line) {
  const d = openDialog(line.description, `${line.account_name} · ${dayLabel(line.posted_on)} · ${money(line.amount_minor)}`);
  fillDialog(d, async () => {
    const [c, o] = await Promise.all([coApi(`/recon/lines/${line.statement_line_id}/candidates`), coApi('/options')]);
    let pick = null;
    const note = el('input', { type: 'text', maxlength: '300', placeholder: 'e.g. Two days’ takings banked together' });
    const out = el('div');
    const list = c.candidates.length ? el('div', { class: 'panel' }, c.candidates.map((x) => {
      const radio = el('input', { type: 'radio', name: 'cand', class: 'pickbox', 'aria-label': x.label, onchange: () => { pick = x; } });
      return item({ pick: radio, title: human(x.label), detail: `${dayLabel(x.on_date)}${Number(x.gap) ? ` · ${money(x.gap)} different` : ' · same amount'}`, amount: money(x.amount_minor) });
    })) : el('div', { class: 'panel' }, empty('Nothing open near this date to match it to.', 'Book it to an account instead, below.', true));
    const match = el('button', { class: 'btn primary', type: 'button', onclick: () => {
      if (!pick) { out.replaceChildren(resultBox('warning', 'warn', 'Pick what it matches', null)); return; }
      act(match, () => post(`/recon/lines/${line.statement_line_id}/match`, { kind: pick.kind, targetId: pick.id, note: note.value }), 'Matched, with your note on record.',
        { close: d.close, errorInto: (e) => out.replaceChildren(resultBox('critical', 'fail', 'Not matched', friendly(e))) });
    } }, 'Match');
    const acct = el('select', {}, el('option', { value: '', text: 'Pick an account' }), o.bookable.map((a) => el('option', { value: a.id, text: `${a.code} ${a.name}` })));
    const why = el('input', { type: 'text', maxlength: '200', placeholder: Number(line.amount_minor) > 0 ? 'e.g. Interest paid by the bank' : 'e.g. Monthly service charge' });
    const book = el('button', { class: 'btn', type: 'button', onclick: () => act(book, () => post(`/recon/lines/${line.statement_line_id}/book`, { glAccountId: acct.value, note: why.value }),
      'Booked and matched.', { close: d.close, errorInto: (e) => out.replaceChildren(resultBox('critical', 'fail', 'Not booked', friendly(e))) }) }, 'Book it');
    return frag(
      section('Match it to', null, null, list, c.candidates.length ? frag(el('label', { class: 'field' }, el('span', { text: 'Why these belong together' }), note), el('div', { class: 'dlg-acts' }, match)) : null),
      section('Or book it', 'bank interest, a fee, a returned item', null, signsOff()
        ? frag(el('div', { class: 'form-grid' }, el('label', { class: 'field' }, el('span', { text: 'Account' }), acct), el('label', { class: 'field' }, el('span', { text: 'What it is' }), why)),
            el('div', { class: 'dlg-acts' }, book))
        : el('p', { class: 'lead', text: 'Booking it writes an entry in the books, which is for the controller or the owner. Switch person, or leave it for them.' })), out);
  });
}

// ================================================================ feeds
const CHANNEL = { manual_upload: ['Hand upload', 'upload'], sftp: ['SFTP', 'server'], api: ['Bank API', 'plug'], email: ['Email', 'mail'], webhook: ['Webhook', 'bolt'] };
const TRIGGER = { manual: 'By hand', schedule: 'On schedule', webhook: 'Delivered', retry: 'Retried' };
function groupAccounts(rows) {
  const m = new Map();
  for (const r of rows) {
    let a = m.get(r.bank_account_id);
    if (!a) { a = { ...r, feeds: [] }; m.set(r.bank_account_id, a); }
    if (r.connection_id) a.feeds.push({ id: r.connection_id, name: r.connection_name, channel: r.channel, status: r.connection_status });
  }
  return [...m.values()];
}
function feedState(c) {
  if (c.status === 'failed') return { tone: 'critical', icon: 'fail', label: 'Stopped', note: 'Stopped after five failures in a row' };
  if (c.status === 'paused') return { tone: 'neutral', icon: 'pause', label: 'Paused' };
  if (c.status === 'draft') return { tone: 'neutral', icon: 'pending', label: 'Draft' };
  if (c.status === 'retired') return { tone: 'neutral', icon: 'pause', label: 'Retired' };
  if (c.verdict === 'failing') return { tone: 'critical', icon: 'fail', label: 'Failing', note: `${plural(c.consecutive_failures, 'failure')} in a row` };
  if (c.verdict === 'stale') return { tone: 'warning', icon: 'clock', label: 'Stale', note: `Nothing new in ${plural(c.days_since_success, 'day')}` };
  if (c.verdict === 'healthy') return { tone: 'good', icon: 'ok', label: 'Healthy' };
  if (c.steps.length) return { tone: 'neutral', icon: 'pending', label: 'Not connected' };
  return { tone: 'neutral', icon: 'pending', label: c.channel === 'manual_upload' ? 'No uploads yet' : c.mode === 'pull' ? 'Not run yet' : 'No deliveries yet' };
}
async function screenFeeds() {
  const d = await coApi('/feeds');
  const accounts = groupAccounts(d.accounts);
  const targets = d.connections.filter((c) => c.channel === 'manual_upload' && c.status === 'active' && c.source_code === 'bank_statement');
  const cs = d.connections;
  const failing = cs.filter((c) => c.status === 'failed' || (c.status === 'active' && c.verdict === 'failing')).length;
  const stale = cs.filter((c) => c.status === 'active' && c.verdict === 'stale').length;
  const healthy = cs.filter((c) => c.status === 'active' && c.verdict === 'healthy').length;
  const idle = cs.length - failing - stale - healthy;
  const missing = accounts.reduce((s, a) => s + a.missing_days, 0);
  const behind = accounts.filter((a) => a.missing_days > 0).length;
  const never = accounts.filter((a) => a.never).length;
  const oldest = d.quarantine.reduce((m, f) => Math.max(m, f.days_open || 0), 0);
  const last = cs.filter((c) => c.last_file_at).sort((a, b) => (a.last_file_at < b.last_file_at ? 1 : -1))[0];
  const tiles = tilesRow(
    tile({ label: 'Feeds healthy', value: String(healthy), suffix: `of ${cs.length}`, ...(!cs.length ? { tone: 'neutral', ic: 'pending', text: 'No feeds set up yet' }
      : failing ? { tone: 'critical', ic: 'fail', text: `${plural(failing, 'feed')} failing` }
      : stale ? { tone: 'warning', ic: 'clock', text: `${stale} stale: nothing new in 3+ days` } : idle ? { tone: 'neutral', ic: 'pending', text: `${idle} not running yet` } : { tone: 'good', ic: 'ok', text: 'Every feed is healthy' }) }),
    tile({ label: 'Held for review', value: String(d.quarantine.length), suffix: d.quarantine.length === 1 ? 'file' : 'files',
      ...(d.quarantine.length ? { tone: 'serious', ic: 'hold', text: oldest ? `Oldest waiting ${plural(oldest, 'day')}` : 'Waiting on a person' } : { tone: 'good', ic: 'ok', text: 'Nothing held for review' }) }),
    tile({ label: 'Missing statement days', value: String(missing), ...(missing ? { tone: 'warning', ic: 'warn', text: `${plural(behind, 'account')} behind, last 30 days${never ? `; ${never} with none yet` : ''}` }
      : never ? { tone: 'neutral', ic: 'pending', text: `${plural(never, 'account')} with no statement yet` } : { tone: 'good', ic: 'ok', text: 'Nothing missing in the last 30 days' }) }),
    last ? tile({ label: 'Last file in', value: ago(last.last_file_at), word: true, tone: 'neutral', ic: 'file', text: last.name })
      : tile({ label: 'Last file in', value: 'None yet', word: true, tone: 'neutral', ic: 'file', text: targets.length ? 'Upload a statement to start' : 'No files have come in' }));

  const rows = accounts.map((a) => {
    const up = a.feeds.find((f) => targets.some((t) => t.id === f.id));
    const open = S.openGaps.has(a.bank_account_id);
    const gaps = a.never ? chip('neutral', 'pending', 'No statement yet') : !a.missing_days ? chip('good', 'ok', 'Complete') : el('button', { class: 'chip-btn', type: 'button', 'aria-expanded': String(open), onclick: (e) => {
      const btn = e.currentTarget; const list = document.getElementById('days-' + a.bank_account_id); const now = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(now)); list.hidden = !now; now ? S.openGaps.add(a.bank_account_id) : S.openGaps.delete(a.bank_account_id);
    } }, chip(a.missing_days > 3 ? 'serious' : 'warning', 'warn', `${plural(a.missing_days, 'weekday')} missing`, true));
    const feed = a.feeds.length ? a.feeds.map((f) => { const [label, ic] = CHANNEL[f.channel] || [f.channel, 'none']; return el('div', {}, el('span', { class: 'feed' }, icon(ic), label + (f.status === 'active' ? '' : ` (${f.status})`))); })
      : el('span', { class: 'feed none' }, icon('none'), 'No feed yet');
    return el('div', { class: up ? 'row has-act' : 'row' },
      el('div', { class: 'c-acct' }, el('div', { class: 'acct-name', text: a.account_name }), el('div', { class: 'sub', text: `${a.bank_name} ••${a.account_last4}${a.location ? ` · ${a.location} store` : ''}` })),
      el('div', { class: 'c-feed' }, el('span', { class: 'k', text: 'Feed' }), feed),
      el('div', { class: 'c-thru' }, el('span', { class: 'k', text: 'Latest statement' }), a.through ? el('span', { class: 'num', text: dayLabel(a.through) }) : el('span', { class: 'sub', text: 'None yet' })),
      el('div', { class: 'c-miss' }, el('span', { class: 'k', text: 'Missing, last 30 days' }), gaps),
      el('div', { class: 'c-act' }, up ? el('button', { class: 'btn small', type: 'button', onclick: () => openUpload(targets, up.id, accounts), 'aria-label': `Upload a statement for ${a.account_name}` }, icon('upload'), 'Upload') : null),
      a.missing_days ? el('div', { class: 'c-days', id: 'days-' + a.bank_account_id, hidden: !open },
        el('span', { class: 'k', text: `No statement for ${a.account_name} on` }), el('div', { class: 'days' }, a.missing_dates.map((s) => el('span', { class: 'day num', text: dayLabel(s) })))) : null);
  });
  const attention = [];
  for (const f of d.quarantine) attention.push(item({ title: f.origin, detail: `Held for review · ${f.connection_name} · ${ago(f.received_at)}`, why: sentence(f.reason), badge: chip('serious', 'hold', 'Held'),
    acts: [el('button', { class: 'btn small', type: 'button', onclick: async (e) => {
      const btn = e.currentTarget;
      const why = await askReason({ title: 'Dismiss this file?', sub: f.origin, lead: 'It stays on record, but leaves the list. Your name and your reason go in the audit trail.', label: 'Why', confirm: 'Dismiss file', placeholder: 'e.g. A PDF, not an export. Uploaded the BAI2 file instead.' });
      if (why == null) return;
      await act(btn, () => post(`/feeds/files/${f.file_id}/dismiss`, { reason: why }), 'Dismissed, with your reason on record.');
    } }, 'Dismiss…')] }));
  for (const c of cs) {
    if (!(c.status === 'failed' || (c.status === 'active' && (c.verdict === 'failing' || c.verdict === 'stale')))) continue;
    const st = feedState(c);
    attention.push(item({ title: c.name, detail: `${st.label} · ${st.note}`, why: c.last_error ? sentence(c.last_error) : null, badge: chip(st.tone, st.icon, st.label) }));
  }
  const connRow = (c) => {
    const st = feedState(c); const [label, ic] = CHANNEL[c.channel] || [c.channel, 'none'];
    return el('div', { class: 'conn' },
      el('div', { class: 'n', text: c.name }), el('div', { class: 'cs' }, chip(st.tone, st.icon, st.label)),
      el('div', { class: 'meta' }, el('span', { class: 'feed' }, icon(ic), label), el('span', { text: c.source_name }), c.account_name ? el('span', { text: `${c.account_name} ••${c.account_last4}` }) : null),
      c.steps.length ? el('div', { class: 'steps' }, el('span', { class: 'k', text: 'Waiting on' }), c.steps.map((s) => el('div', { class: 'step' }, el('span', { class: 'tag ' + s.kind, text: s.kind === 'setup' ? 'Setup' : 'Build' }), el('span', { text: s.text }))))
        : el('div', { class: 'steps' }, el('div', { class: 'step' }, el('span', { class: 'tag ready', text: 'Ready' }), el('span', { text: c.channel === 'manual_upload' ? 'Upload files from this page' : 'Nothing left to set up' }))),
      el('div', { class: 'last', text: c.last_file_at ? `Last file ${ago(c.last_file_at)}` : c.last_attempt_at ? `Last tried ${ago(c.last_attempt_at)}` : 'No files yet' }));
  };
  const inbound = cs.filter((c) => c.direction === 'inbound'), outbound = cs.filter((c) => c.direction === 'outbound');
  const runResult = (r) => r.files_failed ? ['serious', 'hold', `${plural(r.files_failed, 'file')} held`] : r.outcome === 'failed' ? ['critical', 'fail', 'Failed']
    : r.files_new ? ['good', 'ok', plural(r.files_new, 'new file')] : r.files_seen ? ['neutral', 'info', 'Nothing new'] : !r.outcome ? ['neutral', 'clock', 'Running'] : ['neutral', 'info', 'Nothing waiting'];
  return frag(
    head('Feeds and statements', targets.length ? [el('button', { class: 'btn primary', type: 'button', onclick: () => openUpload(targets, targets[0].id, accounts) }, icon('upload'), 'Upload statement')] : null),
    trialBanner(), tiles,
    section('Bank statements', plural(accounts.length, 'account'), null, el('div', { class: 'panel' },
      el('div', { class: 'row head', 'aria-hidden': 'true' }, el('div', { class: 'c-acct', text: 'Account' }), el('div', { class: 'c-feed', text: 'Feed' }),
        el('div', { class: 'c-thru', text: 'Latest statement' }), el('div', { class: 'c-miss', text: 'Missing, last 30 days' }), el('div', { class: 'c-act' })), rows),
      el('p', { class: 'foot', text: 'Missing counts weekdays in the last 30 days with no statement on file, starting from each account’s first statement. Bank holidays are not excluded yet, so a holiday shows as a missing day.' })),
    section('Needs a person', attention.length ? `${attention.length} open` : null, null, el('div', { class: 'panel' }, attention.length ? attention
      : empty('Nothing is waiting on a person.', 'Files held for review, and feeds that fail or go quiet, show up here.'))),
    section('Connections', `${cs.filter((c) => !c.steps.length).length} of ${cs.length} ready`, null, el('div', { class: 'panel' },
      cs.length ? frag(inbound.length ? el('div', { class: 'subhead', text: 'Coming in' }) : null, inbound.map(connRow), outbound.length ? el('div', { class: 'subhead', text: 'Going out' }) : null, outbound.map(connRow))
        : empty(`No feeds set up for ${S.co.name} yet.`, null, true)),
      el('p', { class: 'foot', text: 'Setup is something to arrange with a bank or service. Build is code still to write. Scheduled pulls need Render’s paid plan; until then a pull feed runs only when asked.' })),
    section('Recent activity', null, null, el('div', { class: 'panel' }, d.runs.length ? d.runs.map((r) => { const [tone, ic, label] = runResult(r);
      return item({ title: r.connection_name, detail: `${TRIGGER[r.trigger] || r.trigger} · ${ago(r.started_at)}${r.error ? ' · ' + sentence(r.error) : ''}`, badge: chip(tone, ic, label) }); })
      : empty('Nothing has run yet.', targets.length ? 'Upload a statement and it will show up here.' : null, true))));
}

// A made-up but well-formed BAI2 week for trying the upload in the trial.
function rng(seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return () => { h = (h + 0x6D2B79F5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function lastWeekdays(n) {
  const out = []; const d = new Date(); d.setHours(12, 0, 0, 0);
  while (out.length < n) { d.setDate(d.getDate() - 1); if (d.getDay() >= 1 && d.getDay() <= 5) out.unshift(isoDay(d)); }
  return out;
}
function sampleWeek(target, accounts) {
  const clean = (s) => String(s).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const yymmdd = (s) => s.slice(2, 4) + s.slice(5, 7) + s.slice(8, 10);
  const cents = (r, lo, hi) => Math.round((lo + r() * (hi - lo)) * 100);
  const deposits = accounts.filter((a) => a.purpose === 'deposit');
  const payroll = accounts.find((a) => a.purpose === 'payroll');
  const days = lastWeekdays(5);
  const next = parseDay(days[days.length - 1]); next.setDate(next.getDate() + 1);
  const fileDay = isoDay(next);
  const recs = [`01,FIRSTVALLEY,PENTEX,${yymmdd(fileDay)},0600,${yymmdd(fileDay)}01,,,2/`];
  let open = cents(rng(`${target.account_last4}|${days[0]}|open`), 150000, 210000), fileTotal = 0;
  for (const day of days) {
    const r = rng(`${target.account_last4}|${day}|upload`); const dow = parseDay(day).getDay(); const lines = [];
    for (const a of deposits) { const same = a.bank_name === target.bank_name; lines.push([same ? '275' : '165', cents(r, 2400, 7400), `SAMPLE ${same ? 'ZBA SWEEP FROM' : 'ACH SWEEP FROM'} ${clean(a.account_name)} XX${a.account_last4}`]); }
    if (dow === 2) lines.push(['455', cents(r, 1100, 1650), 'SAMPLE VALLEY POWER ELECTRIC ACH DEBIT']);
    if (dow === 3) lines.push(['475', cents(r, 850, 2400), 'SAMPLE CHECK PAID', 'CHECK 10231']);
    if (dow === 4 && payroll) lines.push(['495', cents(r, 3000, 4400), `SAMPLE TRANSFER TO PAYROLL XX${payroll.account_last4}`]);
    if (dow === 5) lines.push(['455', cents(r, 2100, 3400), 'SAMPLE FRANCHISE ROYALTY ACH DEBIT']);
    const net = lines.reduce((s, l) => s + (Number(l[0]) >= 400 && Number(l[0]) <= 699 ? -l[1] : l[1]), 0);
    const close = open + net; const acct = [`03,000000${target.account_last4},USD,010,${open},,,015,${close},,/`]; let control = open + close;
    lines.forEach((l, i) => { acct.push(`16,${l[0]},${l[1]},0,U${yymmdd(day)}${String(i + 1).padStart(2, '0')},,${l[2]}/`); if (l[3]) acct.push(`88,${l[3]}/`); control += l[1]; });
    acct.push(`49,${control},${acct.length + 1}/`);
    const group = [`02,PENTEX,FIRSTVALLEY,1,${yymmdd(day)},2400,USD,2/`, ...acct]; group.push(`98,${control},1,${group.length + 1}/`);
    recs.push(...group); fileTotal += control; open = close;
  }
  recs.push(`99,${fileTotal},${days.length},${recs.length + 1}/`);
  return { name: `sample-${clean(target.account_name).toLowerCase().replace(/ /g, '-')}-${days[0]}-to-${days[days.length - 1]}.bai`, text: recs.join('\n') + '\n' };
}
function openUpload(targets, id, accounts) {
  let target = targets.find((t) => t.id === id) || targets[0];
  let file = null;
  const d = openDialog('Upload a statement', `${target.account_name} · ${target.bank_name} ••${target.account_last4}`);
  const input = el('input', { type: 'file' });
  const pt = el('span', { class: 'pt', text: 'Choose a file' }), ps = el('span', { class: 'ps', text: 'Tap to pick one, or drop it here' });
  const warn = el('div');
  const out = el('div', { role: 'status', 'aria-live': 'polite' });
  const go = el('button', { class: 'btn primary', type: 'button', disabled: true, onclick: () => send(file, file.name) }, icon('upload'), 'Upload');
  const setPicked = (f) => {
    file = f; pt.textContent = f ? f.name : 'Choose a file'; ps.textContent = f ? size(f.size) : 'Tap to pick one, or drop it here';
    const n = f ? f.name.toLowerCase() : ''; const kind = !f ? '' : /\.pdf$/.test(n) ? 'a PDF' : /\.(xlsx?|numbers)$/.test(n) ? 'a spreadsheet' : /\.(jpe?g|png|heic|gif|webp)$/.test(n) ? 'a picture' : '';
    const big = f && f.size > 20 * 1024 * 1024;
    warn.replaceChildren(big ? resultBox('warning', 'warn', 'Too large', 'This file is over 20 MB, which is more than the ERP accepts.')
      : kind ? resultBox('warning', 'warn', `This looks like ${kind}`, 'The ERP reads BAI2, OFX and QFX exports, so it will be held for review. Most banks offer those under “export” or “download transactions”.') : '');
    go.disabled = !f || big;
  };
  input.addEventListener('change', () => { setPicked(input.files[0] || null); out.replaceChildren(); });
  const describe = (r, name) => {
    const f = (r.files || [])[0];
    if (!r.fresh) return resultBox('neutral', 'info', 'Already on file', `${name}: this exact file came in before, so nothing was added. Sending the same file twice is harmless.`);
    if (f && f.status === 'quarantined') return resultBox('serious', 'hold', 'Held for review', `${name}: ${sentence(f.reason)} It is listed under Needs a person.`);
    if (f && f.status === 'applied') {
      const span = !f.days ? '' : f.days === 1 ? ` (${dayLabel(f.first_day)})` : ` (${dayLabel(f.first_day)} to ${dayLabel(f.last_day)})`;
      return resultBox('good', 'ok', 'Statement read', f.rows_parsed ? `${name}: ${plural(f.rows_parsed, 'new transaction')} from ${plural(f.days, 'statement day')}${span}.` : `${name}: every transaction in it was already on file${span}.`);
    }
    return resultBox('neutral', 'info', 'Received', `${plural(r.fresh, 'file')} received.`);
  };
  async function send(blob, name) {
    busy(go, true, 'Uploading…'); out.replaceChildren();
    try {
      const r = await api(`/api/connections/${encodeURIComponent(target.id)}/upload?filename=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
      out.replaceChildren(describe(r, name)); input.value = ''; setPicked(null); render();
    } catch (e) { if (!(e instanceof Stop)) out.replaceChildren(resultBox('critical', 'fail', 'Not uploaded', friendly(e))); }
    finally { busy(go, false); go.disabled = !file; }
  }
  d.body.append(
    targets.length > 1 ? el('label', { class: 'field' }, el('span', { text: 'Account' }), el('select', { onchange: (e) => { target = targets.find((t) => t.id === e.target.value); } },
      targets.map((t) => el('option', { value: t.id, text: `${t.account_name} ••${t.account_last4}`, selected: t.id === target.id || null })))) : null,
    el('p', { class: 'lead', text: `A BAI2, OFX or QFX file exported from the bank, up to 20 MB. The account number in the file has to end in ${target.account_last4}. Anything the ERP can’t read is held for review, never thrown away.` }),
    el('label', { class: 'pick-file' }, input, el('span', { class: 'pi' }, icon('file')), el('span', {}, pt, ps)), warn,
    el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Close')), out,
    S.me.trial ? el('p', { class: 'foot' }, 'No export handy? ', el('button', { type: 'button', class: 'linkbtn', onclick: () => { const s = sampleWeek(target, accounts); send(new Blob([s.text], { type: 'text/plain' }), s.name); } }, 'Upload a sample week'),
      ': five weekdays of made-up activity for this account, every line marked SAMPLE. Trial only.') : null);
}

const RENDER = { home: screenHome, approvals: screenApprovals, payables: screenPayables, payroll: screenPayroll, books: screenBooks, cash: screenCash, recon: screenRecon, feeds: screenFeeds, setup: screenSetup };

// ================================================================ sign in
function showSignIn(msg) {
  show('signin');
  $('#si-msg').textContent = msg || 'Use the operator access key.';
  $('#si-err').hidden = true;
  for (const dl of document.querySelectorAll('dialog[open]')) dl.close();
  ($('#si-name').value ? $('#si-key') : $('#si-name')).focus();
}
async function signIn(ev) {
  ev.preventDefault();
  const name = $('#si-name').value.trim(), key = $('#si-key').value.trim();
  const err = $('#si-err');
  const fail = (title, text) => { err.replaceChildren(icon('fail'), el('div', {}, el('b', { text: title }), el('span', { text }))); err.hidden = false; };
  if (!name || !key) { fail(name ? 'Paste the access key' : 'Put your name in', name ? 'It is the ERP_API_TOKEN value in Render.' : 'Everything you do here is recorded against it.'); (name ? $('#si-key') : $('#si-name')).focus(); return; }
  const go = $('#si-go');
  busy(go, true, 'Signing in…'); err.hidden = true;
  try {
    const res = await fetch('/session', { method: 'POST', credentials: 'same-origin', headers: { 'x-pentex-erp': '1', 'content-type': 'application/json' }, body: JSON.stringify({ name, key }) });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error) || `The service answered ${res.status}`);
    $('#si-key').value = '';
    show('boot');
    await boot();
  } catch (e) { fail('Not signed in', friendly(e)); }
  finally { busy(go, false); }
}
async function signOut() {
  try { await fetch('/session/end', { method: 'POST', credentials: 'same-origin', headers: { 'x-pentex-erp': '1' } }); } catch (_) { /* gone anyway */ }
  S.me = null; S.co = null;
  showSignIn('Signed out.');
}

// =================================================================== boot
async function boot() {
  try {
    S.me = await api('/api/me');
    S.companies = S.me.companies;
    showVersion();
    if (!S.companies.length) { $('#boot-msg').replaceChildren('No companies are set up in this database yet.'); $('#boot .spin').hidden = true; return; }
    const r = parseHash();
    const pickId = r.co || store.get('erp.company') || S.me.defaultCompany;
    const c = S.companies.find((x) => x.id === pickId) || S.companies.find((x) => x.id === S.me.defaultCompany) || S.companies[0];
    await setCompany(c);
    S.route = { screen: SCREENS.some(([n]) => n === r.screen) ? r.screen : 'home', sub: r.sub };
    show('app');
    if (r.co !== c.id) history.replaceState(null, '', `#/${c.id}/${S.route.screen}${S.route.sub ? '/' + S.route.sub : ''}`);
    renderNav();
    await render();
  } catch (e) {
    if (e instanceof Stop) return;
    $('#boot-msg').replaceChildren(el('div', { text: friendly(e) }), el('button', { class: 'btn', type: 'button', onclick: () => { $('#boot-msg').replaceChildren('Loading…'); $('#boot .spin').hidden = false; boot(); } }, 'Try again'));
    $('#boot .spin').hidden = true;
  }
}
function wire() {
  for (const b of document.querySelectorAll('[data-act="refresh"]')) { b.prepend(icon('refresh')); b.addEventListener('click', () => render()); }
  for (const b of document.querySelectorAll('[data-act="signout"]')) { b.prepend(icon('out')); b.addEventListener('click', signOut); }
  $('#co-switch').append(icon('chev'));
  $('#as-switch').append(icon('chev'));
  $('#co-switch').addEventListener('click', openCompanyPicker);
  $('#as-switch').addEventListener('click', openPersonPicker);
  $('#si-form').addEventListener('submit', signIn);
  window.addEventListener('hashchange', onRoute);
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (S.co && hiddenAt && Date.now() - hiddenAt > 60000 && !document.querySelector('dialog[open]')) render();
  });
}
wire();
boot();
})();
