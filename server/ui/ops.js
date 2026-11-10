// ops screens: Loading dock (piece-by-piece manifest, lanes, print), Haul-away
// (disposal log, state report, rates), Debit memos (payables), Time off
// (requests, approvals, balances, holidays) and the "Absent today" card.
// Registers with window.ERP (see docs/MODULES.md). Phone first: cards, pickers
// and wrapped rows -- no sideways tables; amounts sit on the right. Data is
// placed with textContent only. Styles are a constructed sheet (CSSOM), which
// the page's content policy allows.
(() => {
  'use strict';
  const E = window.ERP;
  const { el, frag, chip, money, dayLabel, plural, cap, coApi, post, go, toast, act, openDialog, resultBox, fillDialog,
    askReason, head, section, tile, tilesRow, empty, item, capped, seg, fact, friendly, S } = E;

  const sheet = new CSSStyleSheet();
  sheet.replaceSync('@media print{body *{visibility:hidden!important}.ops-print,.ops-print *{visibility:visible!important}' +
    '.ops-print{position:absolute;left:0;top:0;width:100%;color:#000;background:#fff;font-size:12px}.ops-noprint{display:none!important}}' +
    '.ops-print .ops-grp{break-inside:avoid;border-top:1px solid #999;padding:8px 4px}.ops-print .ops-row{display:flex;gap:8px;flex-wrap:wrap;padding:2px 0}' +
    '.ops-print .ops-box{display:inline-block;width:12px;height:12px;border:1px solid #000;margin-right:4px}.ops-print h2{margin:0 0 4px;font-size:16px}' +
    '.ops-scan{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}.ops-scan input{flex:1 1 200px;min-width:0;font-size:18px}' +
    '.ops-picks{display:flex;flex-direction:column;gap:6px}.ops-pad{padding:8px 16px 12px}');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  // ------------------------------------------------------------ little bits
  const st = { day: null, dc: null, opts: null, scanFocus: false, memoTab: 'open', memoVendor: '', leaveTab: 'mine', haulTab: 'waiting',
    rpState: 'PA', rpFrom: null, rpTo: null, year: new Date().getFullYear() };
  const words = (s) => cap(String(s || '').replace(/_/g, ' '));
  const btn = (label, onclick, o = {}) => el('button', { class: 'btn' + (o.primary ? ' primary' : '') + (o.small ? ' small' : ''), type: 'button', onclick, disabled: o.disabled || null }, label);
  const field = (label, control, hint) => el('label', { class: 'field' }, el('span', { text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null);
  const input = (attrs) => el('input', { type: 'text', ...attrs });
  const select = (options, value, attrs = {}) => el('select', attrs, options.map(([v, label]) => el('option', { value: v, selected: String(v) === String(value ?? '') || null }, label)));
  const panel = (...kids) => el('div', { class: 'panel' }, ...kids);
  const errSlot = () => el('div');
  const showErr = (slot) => (e) => slot.replaceChildren(resultBox('critical', 'fail', 'Not done', friendly(e)));
  const todayIso = () => E.todayIso();
  const plusDays = (d, k) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
  const hours = (h) => `${Math.round(Number(h || 0) * 100) / 100} h`;
  /** A dialog with fields and one button that posts; the screen redraws after. */
  function formDialog(title, sub, fields, label, send, okText) {
    const d = openDialog(title, sub);
    const err = errSlot();
    const b = btn(label, (e) => act(e.currentTarget, send, okText, { close: d.close, errorInto: showErr(err) }), { primary: true });
    d.body.append(el('div', { class: 'form-grid' }, fields), el('div', { class: 'dlg-acts' }, b, btn('Cancel', d.close)), err);
    return d;
  }
  async function fleetOpts() {
    if (!st.opts || st.opts.co !== S.co.id) st.opts = { co: S.co.id, ...(await coApi('/fleet/options')) };
    if (!st.day) st.day = st.opts.today;
    if (!st.dc) st.dc = (st.opts.locations.find((l) => l.kind === 'warehouse') || st.opts.locations[0] || {}).id || null;
    return st.opts;
  }
  const dayPicker = () => { const i = input({ type: 'date', value: st.day, 'aria-label': 'Day' }); i.addEventListener('change', () => { if (i.value) { st.day = i.value; E.render(); } }); return i; };
  const dcPicker = (o) => { const s = select(o.locations.filter((l) => l.kind !== 'web').map((l) => [l.id, l.name]), st.dc, { 'aria-label': 'Warehouse' }); s.addEventListener('change', () => { st.dc = s.value; E.render(); }); return s; };

  // ====================================================== Loading dock
  const ITEM_TONE = { pending: 'neutral', loaded: 'good', short: 'warning' };
  const itemChip = (x) => chip(ITEM_TONE[x.status] || 'neutral', x.status === 'loaded' ? 'ok' : x.status === 'short' ? 'warn' : 'pending',
    x.status === 'loaded' ? (x.out_of_order ? 'Loaded, out of order' : 'Loaded') : words(x.status));

  async function screenLoading(sub) {
    const o = await fleetOpts();
    const [name, id] = String(sub || '').split(':');
    if (name === 'route' && id) return loadingRoute(id);
    if (name === 'print' && id) return printManifest(id);
    const d = await coApi(`/fleet/loading?day=${st.day}&dc=${st.dc || ''}`);
    const cards = d.routes.map((r) => item({
      title: `${r.number} · ${r.unit_no || 'no truck'}`, amount: r.pieces ? `${r.loaded + r.short}/${r.pieces}` : '',
      badge: r.status !== 'draft' ? chip('good', 'hold', r.status === 'locked' ? 'Locked' : words(r.status)) : r.pieces && !r.pending ? chip('good', 'ok', 'Ready to lock') : chip('neutral', 'pending', r.pieces ? 'Loading' : 'Not started'),
      detail: [r.driver || 'no driver', plural(r.stops, 'stop'), r.lane ? `lane ${r.lane}` : 'no lane yet', r.short ? `${r.short} short` : null].filter(Boolean).join(' · '),
      onClick: () => go('loading', 'route:' + r.id) }));
    const lanes = d.lanes.map((l) => item({ title: `${l.code} · ${l.name}`, badge: l.route_number ? chip('warning', 'hold', l.route_number) : chip('good', 'ok', 'Free'),
      detail: l.active ? l.dc_name : 'not in use' }));
    return frag(head('Loading dock', [btn('Add a lane', () => laneDialog(o), { small: true })], 'Operations'),
      el('div', { class: 'toolbar' }, dayPicker(), dcPicker(o)),
      section('Routes to load', d.routes.length ? plural(d.routes.length, 'route') : null, null, d.routes.length ? panel(cards) : empty('No routes that day', 'Dispatch builds them on Delivery › Routes.', true)),
      section('Staging lanes', `${dayLabel(d.day)}`, null, d.lanes.length ? panel(lanes) : empty('No lanes at this warehouse', 'Add the dock lanes routes are staged in.', true)));
  }

  function laneDialog(o) {
    const dc = select(o.locations.filter((l) => l.kind === 'warehouse' || l.kind === 'store').map((l) => [l.id, l.name]), st.dc);
    const code = input({ placeholder: 'L5', maxlength: '12' }), nm = input({ placeholder: 'Lane 5 (door 7)' });
    formDialog('Add a dock lane', null, [field('Warehouse', dc), field('Code', code), field('Name', nm)], 'Add lane',
      () => post('/fleet/lanes', { dcLocationId: dc.value, code: code.value, name: nm.value }), 'Lane added');
  }

  async function loadingRoute(id) {
    let l = await coApi(`/fleet/routes/${id}/loading`);
    if (!l.prepared && l.route.status === 'draft') { try { l = await post(`/fleet/routes/${id}/loading/prepare`); } catch (e) { toast(friendly(e), 'critical'); } }
    const r = l.route, draft = r.status === 'draft';
    const err = errSlot();
    const scanIn = input({ placeholder: 'Scan or type a label or SKU', autocomplete: 'off', enterkeyhint: 'go', 'aria-label': 'Label or SKU' });
    const scan = async (body) => {
      try {
        const x = await post(`/fleet/routes/${id}/loading/scan`, body);
        toast(x.warning || `Loaded ${x.label} · ${x.left} to go`, x.warning ? 'warning' : 'good');
        st.scanFocus = true; await E.render();
      } catch (e) { err.replaceChildren(resultBox('critical', 'fail', 'Not loaded', friendly(e))); scanIn.select(); }
    };
    scanIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && scanIn.value.trim()) { e.preventDefault(); scan({ code: scanIn.value.trim() }); } });
    const lanes = await coApi(`/fleet/lanes?day=${r.route_on}`);
    const laneSel = select([['', 'No lane'], ...lanes.filter((x) => x.active && (!x.route_id || x.route_id === r.id)).map((x) => [x.id, `${x.code} · ${x.name}`])], r.lane_id || '', { 'aria-label': 'Staging lane' });
    laneSel.addEventListener('change', async () => { try { await post(`/fleet/routes/${id}/lane`, { laneId: laneSel.value || null }); toast('Lane set', 'good'); E.render(); } catch (e) { toast(friendly(e), 'critical'); } });
    const groups = new Map();
    for (const x of l.items) { if (!groups.has(x.load_group)) groups.set(x.load_group, []); groups.get(x.load_group).push(x); }
    const blocks = [...groups.entries()].map(([g, list]) => {
      const f = list[0];
      const left = list.filter((x) => x.status === 'pending').length;
      return section(`Load ${g} · stop ${f.stop_seq} · ${f.customer || ''}`, left ? `${left} to load` : 'done', null, panel(list.map((x) => item({
        title: x.description, badge: itemChip(x),
        detail: [x.label, x.carton, x.bin ? `bin ${x.bin}` : null, x.serial_no ? `SN ${x.serial_no}` : null, x.lot_code ? `lot ${x.lot_code}` : null, f.stop_number].filter(Boolean).join(' · '),
        why: x.status === 'short' ? `Short: ${x.short_reason}` : null,
        acts: !draft ? null : x.status === 'pending' ? [
          btn('Load', () => scan({ itemId: x.id }), { small: true, primary: g === l.nextGroup }),
          btn('Short', async (e) => { const why = await askReason({ title: 'Mark short', sub: x.description, label: 'Why is it not going?', placeholder: 'Not found in the bin; damaged; still at the store' });
            if (why) act(e.currentTarget, () => post(`/fleet/routes/${id}/loading/short`, { itemId: x.id, reason: why }), 'Marked short', { errorInto: showErr(err) }); }, { small: true }),
        ] : [btn('Undo', (e) => act(e.currentTarget, () => post(`/fleet/routes/${id}/loading/undo`, { itemId: x.id }), 'Back on the dock', { errorInto: showErr(err) }), { small: true })],
      }))));
    });
    const t = l.totals;
    if (st.scanFocus) { st.scanFocus = false; setTimeout(() => scanIn.focus(), 0); }
    return frag(
      el('div', { class: 'toolbar' }, btn('All routes', () => go('loading'), { small: true }), el('span', { class: 'grow' }),
        btn('Print manifest', () => go('loading', 'print:' + id), { small: true }), btn('Carton labels', () => go('labels', 'manifest:' + id), { small: true }),
        btn('Route', () => go('fleet', 'route:' + id), { small: true })),
      head(`Load ${r.number}`, null, `${dayLabel(r.route_on)} · ${r.unit_no || 'no truck'} · ${r.dc_name}`),
      tilesRow(tile({ label: 'Loaded', value: `${t.loaded}/${t.pieces}`, tone: t.pending ? 'neutral' : 'good' }),
        tile({ label: 'Short', value: String(t.short), tone: t.short ? 'warning' : 'neutral' }),
        tile({ label: 'Payload', value: r.payloadPct == null ? '—' : `${r.payloadPct}%`, tone: r.payloadPct > 100 ? 'critical' : 'neutral', text: `${Math.round(r.weight)} of ${Math.round(r.weight_cap || 0)} lb`, ic: 'info' }),
        tile({ label: 'Out of order', value: String(t.outOfOrder), tone: t.outOfOrder ? 'warning' : 'neutral' })),
      el('div', { class: 'toolbar' }, field('Staging lane', laneSel),
        el('span', { class: 'grow' }),
        draft && l.canLock ? btn('Lock route (loaded)', (e) => act(e.currentTarget, () => post(`/fleet/routes/${id}/lock`), 'Route locked; the order is fixed', { errorInto: showErr(err) }), { primary: true }) : null,
        !draft ? chip('good', 'hold', r.status === 'locked' ? 'Locked' : words(r.status)) : null),
      draft ? el('div', { class: 'ops-scan' }, scanIn, btn('Load', () => scanIn.value.trim() && scan({ code: scanIn.value.trim() }), { primary: true })) : null,
      draft && l.nextGroup ? el('p', { class: 'lead', text: `Next on: load ${l.nextGroup} (the last stop goes on first).` }) : null,
      err,
      blocks.length ? blocks : empty('Nothing to load', 'The route has no goods on it.', true));
  }

  async function printManifest(id) {
    const l = await coApi(`/fleet/routes/${id}/loading`);
    const m = await coApi(`/fleet/routes/${id}/manifest`);
    const r = l.route;
    const groups = new Map();
    for (const x of l.items) { if (!groups.has(x.load_group)) groups.set(x.load_group, []); groups.get(x.load_group).push(x); }
    const byNumber = new Map(m.stops.map((s) => [s.number, s]));
    const sheetNode = el('div', { class: 'panel ops-print' },
      el('div', { class: 'ops-grp' }, el('h2', { text: `Load manifest ${r.number} · ${dayLabel(r.route_on)}` }),
        el('div', { text: [r.dc_name, `Truck ${r.unit_no || '—'}`, `Driver ${r.driver || '—'}`, r.helper ? `Helper ${r.helper}` : null, `Lane ${r.lane_code || '—'}`].filter(Boolean).join(' · ') }),
        el('div', { text: `${plural(l.totals.pieces, 'piece')} · ${Math.round(r.weight)} of ${Math.round(r.weight_cap || 0)} lb (${r.payloadPct ?? '—'}%) · last stop loads first` })),
      [...groups.entries()].map(([g, list]) => {
        const s = byNumber.get(list[0].stop_number) || {};
        return el('div', { class: 'ops-grp' },
          el('b', { text: `Load ${g} · Stop ${list[0].stop_seq} · ${list[0].stop_number} · ${list[0].customer || ''}` }),
          el('div', { text: [s.address, s.window, s.phone].filter(Boolean).join(' · ') }),
          list.map((x) => el('div', { class: 'ops-row' }, el('span', { class: 'ops-box' }), el('span', { text: `${x.label} · ${x.description}${x.carton ? ' · ' + x.carton : ''}${x.bin ? ' · bin ' + x.bin : ''}${x.serial_no ? ' · SN ' + x.serial_no : ''}${x.lot_code ? ' · lot ' + x.lot_code : ''}${x.status === 'short' ? ' · SHORT: ' + x.short_reason : ''}` }))),
          (s.haulAway || []).length ? el('div', { text: `Haul away: ${s.haulAway.map((h) => `${h.qty}× ${h.description}`).join('; ')}` }) : null);
      }),
      el('div', { class: 'ops-grp', text: 'Loaded by: ____________________   Checked by: ____________________   Time: ________' }));
    return frag(el('div', { class: 'toolbar ops-noprint' }, btn('Back to loading', () => go('loading', 'route:' + id), { small: true }), el('span', { class: 'grow' }),
      btn('Print', () => window.print(), { primary: true })), sheetNode);
  }

  // ==================================================== Haul-away
  const photoPicker = () => {
    const file = el('input', { type: 'file', accept: 'image/*', capture: 'environment' });
    let data = null;
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        const img = new Image();
        img.onload = () => {   // shrink a phone photo to something the server keeps
          const k = Math.min(1, 1280 / Math.max(img.width, img.height));
          const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          data = cv.toDataURL('image/jpeg', 0.7);
        };
        img.src = String(rd.result);
      };
      rd.readAsDataURL(f);
    });
    return { node: file, value: () => data };
  };

  /** Driver: what was actually taken from the door, with a photo. Called from My route. */
  async function recordHaul(stop) {
    const d = openDialog('Haul-away', `${stop.customer || ''} · ${stop.number}`);
    fillDialog(d, async () => {
      const lines = (await coApi(`/fleet/stops/${stop.id}/haul-away`)).filter((h) => h.status === 'planned');
      if (!lines.length) return frag(empty('Nothing left to record', null, true), el('div', { class: 'dlg-acts' }, btn('Close', d.close)));
      const err = errSlot();
      const rows = lines.map((h) => {
        const qty = input({ type: 'number', min: '0', max: String(h.qty), step: '1', value: String(h.qty), inputmode: 'numeric' });
        const note = input({ placeholder: 'If not taken: why' });
        const ph = photoPicker();
        return { h, node: panel(el('div', { class: 'ops-pad' }, el('b', { text: `${h.qty}× ${h.description}` }),
          el('div', { class: 'form-grid' }, field('How many taken', qty), field('Photo', ph.node), field('Note', note)))), qty, note, ph };
      });
      return frag(rows.map((x) => x.node), err, el('div', { class: 'dlg-acts' }, btn('Save', (e) => act(e.currentTarget, async () => {
        for (const x of rows) await post(`/fleet/haul-away/${x.h.id}/record`, { takenQty: Number(x.qty.value || 0), photo: x.ph.value(), note: x.note.value });
      }, 'Haul-away recorded', { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)));
    });
  }

  /** Dispatch or sales: add a haul-away to a booked stop. Called from Delivery › Route. */
  async function addHaul(stop) {
    const setup = await coApi('/fleet/haul-away/setup');
    const cat = select(setup.rates.filter((r) => r.active).map((r) => [r.category, `${r.label} · ${money(r.fee_minor)} each`]), '');
    const qty = input({ type: 'number', min: '1', max: '20', value: '1', inputmode: 'numeric' });
    const desc = input({ placeholder: 'Old queen mattress' }), trade = input({ inputmode: 'decimal', placeholder: '0.00' });
    formDialog('Add haul-away', `${stop.customer || ''} · ${stop.number}`, [field('What', cat), field('How many', qty), field('Describe it', desc),
      field('Trade-in value ($)', trade, 'Credited against the sale when it is taken')], 'Add',
      () => post(`/fleet/stops/${stop.id}/haul-away`, { category: cat.value, qty: Number(qty.value || 1), description: desc.value, tradeIn: trade.value }), 'Haul-away added; the fee is on the order');
  }

  const HAUL_TABS = [['waiting', 'Waiting'], ['log', 'Disposal log'], ['report', 'State report'], ['setup', 'Rates']];
  async function screenHaul() {
    const o = await fleetOpts();
    const tab = st.haulTab;
    const nav = el('div', { class: 'toolbar' }, seg(HAUL_TABS, tab, (v) => { st.haulTab = v; E.render(); }));
    let body;
    if (tab === 'log') {
      const y = st.year;
      const list = await coApi(`/fleet/haul-away/disposals?from=${y}-01-01&to=${y}-12-31`);
      body = section(`Disposals ${y}`, list.length ? plural(list.length, 'load') : null, null, list.length ? panel(list.map((x) => item({
        title: `${x.number} · ${x.facility}`, amount: `${Math.round(x.weight_lb)} lb`, badge: chip(x.method === 'recycler' ? 'good' : 'neutral', 'ok', words(x.method)),
        detail: [dayLabel(x.disposed_on), plural(Number(x.pieces), 'piece'), x.certificate_no ? `cert ${x.certificate_no}` : null, x.state, x.dc_name].filter(Boolean).join(' · ') }))) : empty('Nothing disposed of yet this year', null, true));
    } else if (tab === 'report') {
      body = await reportView();
    } else if (tab === 'setup') {
      body = await haulSetup();
    } else {
      const list = await coApi(`/fleet/haul-away/collected?dc=${st.dc || ''}`);
      const picked = new Set();
      const cards = list.map((x) => {
        const cb = el('input', { type: 'checkbox', 'aria-label': `Pick ${x.description}` });
        cb.addEventListener('change', () => { if (cb.checked) picked.add(x.id); else picked.delete(x.id); });
        return item({ pick: cb, title: `${x.taken_qty ?? x.qty}× ${x.description}`, amount: x.weight_lb ? `${Math.round(x.weight_lb)} lb` : '',
          detail: [words(x.category), x.customer, x.stop_number, x.state, x.taken_at ? dayLabel(String(x.taken_at).slice(0, 10)) : null].filter(Boolean).join(' · ') });
      });
      body = frag(el('div', { class: 'toolbar' }, dcPicker(o), el('span', { class: 'grow' }),
        list.length ? btn('Log a disposal', () => disposalDialog(o, [...picked]), { primary: true, small: true }) : null),
        section('Back at the warehouse', list.length ? plural(list.length, 'item') : null, null, list.length ? panel(cards) : empty('Nothing waiting', 'What the crews take away shows here until it is disposed of.', true)));
    }
    return frag(head('Haul-away', null, 'Operations'), nav, body);
  }

  function disposalDialog(o, ids) {
    if (!ids.length) { toast('Tick what went first', 'warning'); return; }
    const dc = select(o.locations.filter((l) => l.kind !== 'web').map((l) => [l.id, l.name]), st.dc);
    const on = input({ type: 'date', value: todayIso() });
    const method = select([['recycler', 'Recycler'], ['landfill', 'Landfill'], ['donation', 'Donation']], 'recycler');
    const fac = input({ placeholder: 'Keystone Mattress Recycling' }), wt = input({ inputmode: 'decimal', placeholder: 'Leave empty to use the estimate' });
    const cert = input({ placeholder: 'Certificate or receipt number' }), stt = input({ maxlength: '2', placeholder: 'PA' }), note = input({});
    formDialog('Log a disposal', plural(ids.length, 'item'), [field('From', dc), field('Day', on), field('Went to', method), field('Facility', fac), field('Weight (lb)', wt),
      field('Certificate no.', cert, 'Needed for a recycler'), field('State', stt), field('Note', note)], 'Log it',
      () => post('/fleet/haul-away/disposals', { dcLocationId: dc.value, disposedOn: on.value, method: method.value, facility: fac.value, weightLb: wt.value,
        certificateNo: cert.value, state: stt.value, note: note.value, haulIds: ids }), (r) => `${r.number} logged, ${r.weightLb} lb`);
  }

  async function reportView() {
    const setup = await coApi('/fleet/haul-away/setup');
    const y = new Date().getFullYear();
    st.rpFrom = st.rpFrom || `${y}-01-01`; st.rpTo = st.rpTo || todayIso();
    const states = [...new Set(['PA', 'TX', ...setup.programs.map((p) => p.state)])];
    const sSel = select(states.map((s) => [s, s]), st.rpState, { 'aria-label': 'State' });
    const from = input({ type: 'date', value: st.rpFrom, 'aria-label': 'From' }), to = input({ type: 'date', value: st.rpTo, 'aria-label': 'To' });
    for (const [n, k] of [[sSel, 'rpState'], [from, 'rpFrom'], [to, 'rpTo']]) n.addEventListener('change', () => { st[k] = n.value; E.render(); });
    const r = await coApi(`/fleet/haul-away/report?state=${st.rpState}&from=${st.rpFrom}&to=${st.rpTo}`);
    return frag(el('div', { class: 'toolbar' }, sSel, from, to, el('span', { class: 'grow' }), btn('Print', () => window.print(), { small: true })),
      el('div', { class: 'ops-print' },
        el('h2', { text: `${r.program ? r.program.name : r.state} · ${dayLabel(r.from)} to ${dayLabel(r.to)}` }),
        el('p', { class: 'lead', text: r.note + (r.programFeeWords ? ` · program fee ${r.programFeeWords}` : '') }),
        tilesRow(tile({ label: 'Collected', value: String(r.totals.collected) }), tile({ label: 'Recycled', value: r.totals.recycledPct == null ? '—' : `${r.totals.recycledPct}%` }),
          tile({ label: 'Program fees', value: money(r.totals.programFeeMinor) })),
        section('By kind', null, null, r.categories.length ? panel(r.categories.map((c) => item({ title: words(c.category), amount: String(c.collected),
          detail: `recycled ${c.recycled} (${Math.round(c.weight_recycled)} lb) · landfill ${c.landfilled} (${Math.round(c.weight_landfilled)} lb) · donated ${c.donated} · not yet disposed ${c.undisposed}` }))) : empty('Nothing collected in that period', null, true)),
        section('Certificates', null, null, r.certificates.length ? panel(r.certificates.map((c) => item({ title: `${c.certificate_no || 'no certificate'} · ${c.facility}`,
          amount: `${Math.round(c.weight_lb)} lb`, detail: `${c.number} · ${dayLabel(c.disposed_on)} · ${words(c.method)}` }))) : empty('No certificates in that period', null, true))));
  }

  async function haulSetup() {
    const s = await coApi('/fleet/haul-away/setup');
    const rateDialog = (r) => {
      const cat = select(s.categories.map((c) => [c, words(c)]), r ? r.category : 'mattress');
      const label = input({ value: r ? r.label : '' }), prod = select([['', 'No fee'], ...s.feeProducts.map((p) => [p.id, `${p.sku} · ${p.name}`])], r ? r.fee_product_id : '');
      const fee = input({ inputmode: 'decimal', value: r ? (Number(r.fee_minor) / 100).toFixed(2) : '' }), wt = input({ inputmode: 'decimal', value: r ? String(r.est_weight_lb) : '' });
      formDialog(r ? 'Haul-away rate' : 'Add a haul-away rate', null, [field('Kind', cat), field('Label', label), field('Fee product', prod), field('Fee per piece ($)', fee), field('Estimated weight (lb)', wt)],
        'Save', () => post('/fleet/haul-away/rates', { category: cat.value, label: label.value, feeProductId: prod.value || null, fee: fee.value || '0', estWeightLb: wt.value }), 'Rate saved');
    };
    const progDialog = (p) => {
      const stt = input({ maxlength: '2', value: p ? p.state : '' }), nm = input({ value: p ? p.name : '' });
      const fee = input({ inputmode: 'decimal', value: p ? (Number(p.program_fee_minor) / 100).toFixed(2) : '0.00' });
      const req = select([['no', 'No report required'], ['yes', 'The state wants a report']], p && p.report_required ? 'yes' : 'no');
      formDialog(p ? 'State program' : 'Add a state program', null, [field('State', stt), field('Program', nm), field('Program fee per unit ($)', fee), field('Report', req)], 'Save',
        () => post('/fleet/haul-away/programs', { state: stt.value, name: nm.value, programFee: fee.value || '0', reportRequired: req.value === 'yes' }), 'Program saved');
    };
    return frag(
      section('Fees by kind', null, [btn('Add', () => rateDialog(null), { small: true })], panel(s.rates.map((r) => item({ title: r.label, amount: money(r.fee_minor),
        detail: [words(r.category), r.fee_sku, `${r.est_weight_lb} lb each`, r.active ? null : 'not in use'].filter(Boolean).join(' · '), onClick: () => rateDialog(r) })))),
      section('State recycling programs', null, [btn('Add', () => progDialog(null), { small: true })], panel(s.programs.map((p) => item({ title: `${p.state} · ${p.name}`,
        amount: Number(p.program_fee_minor) ? `${money(p.program_fee_minor)}/unit` : '', badge: p.report_required ? chip('warning', 'file', 'Report due') : chip('neutral', 'info', 'No report'),
        detail: p.categories.map(words).join(', '), onClick: () => progDialog(p) })))));
  }

  // ==================================================== Debit memos
  const MEMO_TONE = { pending_approval: 'warning', open: 'good', applied: 'neutral', rejected: 'critical', void: 'neutral' };
  const memoChip = (m) => chip(MEMO_TONE[m.status] || 'neutral', m.status === 'open' ? 'ok' : m.status === 'pending_approval' ? 'clock' : 'info', words(m.status));
  const MEMO_TABS = [['open', 'Open credits'], ['pending_approval', 'To approve'], ['applied', 'Applied'], ['', 'All']];

  async function screenMemos(sub) {
    const [name, id] = String(sub || '').split(':');
    if (name === 'vendor' && id) return vendorStatement(id);
    const d = await coApi(`/payables/memos?status=${st.memoTab}&vendor=${st.memoVendor}`);
    const vSel = select([['', 'Every vendor'], ...d.vendors.map((v) => [v.id, v.name])], st.memoVendor, { 'aria-label': 'Vendor' });
    vSel.addEventListener('change', () => { st.memoVendor = vSel.value; E.render(); });
    const cards = d.memos.map((m) => item({
      title: `${m.number} · ${m.vendor}`, amount: m.status === 'open' ? money(m.left_minor) : money(m.amount_minor), badge: memoChip(m),
      detail: [words(m.source), m.reason, m.ticket_number ? `ticket ${m.ticket_number}` : null, m.vendor_ref ? `vendor ref ${m.vendor_ref}` : null, dayLabel(m.memo_date)].filter(Boolean).join(' · '),
      onClick: () => memoDialog(m.id) }));
    return frag(head('Debit memos', [btn('New memo', () => newMemo(d), { primary: true })], 'Back office'),
      el('div', { class: 'toolbar' }, seg(MEMO_TABS, st.memoTab, (v) => { st.memoTab = v; E.render(); }), vSel,
        st.memoVendor ? btn('Vendor statement', () => go('memos', 'vendor:' + st.memoVendor), { small: true }) : null),
      section('Vendor debit memos', d.memos.length ? plural(d.memos.length, 'memo') : null, null, d.memos.length ? panel(cards)
        : empty('No memos here', 'Service chargebacks to a vendor open one by themselves; damage on receipt or a price difference is written by hand.', true)));
  }

  function newMemo(d) {
    const v = select(d.vendors.map((x) => [x.id, x.name]), st.memoVendor || '');
    const src = select([['damaged_on_receipt', 'Damaged on receipt'], ['price_difference', 'Price difference'], ['short_shipped', 'Short shipped'], ['other', 'Other']], 'damaged_on_receipt');
    const amt = input({ inputmode: 'decimal', placeholder: '0.00' }), why = input({ placeholder: 'Recliner arm cracked on receipt, PO 4471' });
    const ref = input({ placeholder: 'RA or credit number' }), code = input({ placeholder: 'Defaults to 5000 cost of goods', maxlength: '12' });
    formDialog('New debit memo', 'Another person approves it before it counts', [field('Vendor', v), field('Reason', src), field('Amount ($)', amt), field('What happened', why),
      field("Vendor's reference", ref), field('Offset account', code)], 'Send for approval',
      () => post('/payables/memos', { vendorId: v.value, source: src.value, amount: amt.value, reason: why.value, vendorRef: ref.value, offsetCode: code.value }), (r) => `${r.number} written; waiting for approval`);
  }

  function memoDialog(id) {
    const d = openDialog('Debit memo', null);
    fillDialog(d, async () => {
      const m = await coApi(`/payables/memos/${id}`);
      const err = errSlot();
      const acts = [];
      if (m.status === 'pending_approval') {
        acts.push(btn('Approve', (e) => act(e.currentTarget, () => post(`/payables/memos/${id}/approve`), 'Approved; the credit is open', { close: d.close, errorInto: showErr(err) }), { primary: true }));
        acts.push(btn('Turn down', async (e) => { const why = await askReason({ title: 'Turn down the memo', label: 'Why' }); if (why) act(e.currentTarget, () => post(`/payables/memos/${id}/reject`, { note: why }), 'Turned down', { close: d.close, errorInto: showErr(err) }); }));
      }
      let apply = null;
      if (m.status === 'open') {
        const bills = await coApi(`/payables/vendors/${m.vendor_id}/open-bills`);
        const bSel = select(bills.map((b) => [b.id, `${b.reference || 'no ref'} · ${money(b.open_minor)} open`]), '');
        const amt = input({ inputmode: 'decimal', placeholder: `Up to ${money(m.left_minor)}` });
        apply = bills.length ? panel(el('div', { class: 'ops-pad' }, el('div', { class: 'form-grid' }, field('Apply to bill', bSel), field('Amount ($)', amt, 'Empty uses as much as fits')),
          el('div', { class: 'dlg-acts' }, btn('Apply', (e) => act(e.currentTarget, () => post(`/payables/memos/${id}/apply`, { invoiceId: bSel.value, amount: amt.value }),
            (r) => `Applied ${money(r.appliedMinor)}; ${money(r.billLeftMinor)} left on the bill`, { close: d.close, errorInto: showErr(err) }), { primary: true }))))
          : resultBox('neutral', 'info', 'No approved bill to apply it to', 'It stays an open credit until the vendor bills again.');
        acts.push(btn('Void', async (e) => { const why = await askReason({ title: 'Void the memo', label: 'Why' }); if (why) act(e.currentTarget, () => post(`/payables/memos/${id}/void`, { reason: why }), 'Voided', { close: d.close, errorInto: showErr(err) }); }));
      }
      return frag(
        el('div', { class: 'facts' }, fact('Memo', m.number), fact('Vendor', m.vendor), fact('Amount', money(m.amount_minor)), fact('Left', money(m.left_minor)),
          fact('Status', words(m.status)), fact('Reason', `${words(m.source)}: ${m.reason}`), fact('Offset', m.offset_code), fact('Written by', m.created_by_name || '—'),
          m.decided_by_name ? fact('Decided by', `${m.decided_by_name}${m.decision_note ? ' · ' + m.decision_note : ''}`) : null),
        m.applications.length ? section('Applied to', null, null, panel(m.applications.map((a) => item({ title: a.bill_reference || 'bill', amount: money(a.amount_minor),
          detail: [dayLabel(String(a.applied_at).slice(0, 10)), a.applied_by].filter(Boolean).join(' · ') })))) : null,
        apply, err, el('div', { class: 'dlg-acts' }, acts, btn('Vendor statement', () => { d.close(); go('memos', 'vendor:' + m.vendor_id); }), btn('Close', d.close)));
    });
  }

  async function vendorStatement(id) {
    const s = await coApi(`/payables/vendors/${id}/statement`);
    return frag(el('div', { class: 'toolbar' }, btn('All memos', () => go('memos'), { small: true }), el('span', { class: 'grow' }), btn('Print', () => window.print(), { small: true })),
      el('div', { class: 'ops-print' },
        head(`${s.vendor.name}`, null, 'Vendor statement'),
        tilesRow(tile({ label: 'Owed on bills', value: money(s.totals.owedOnBillsMinor) }), tile({ label: 'Open credits', value: money(s.totals.openCreditsMinor), tone: Number(s.totals.openCreditsMinor) ? 'good' : 'neutral' }),
          tile({ label: 'Net owed', value: money(s.totals.netOwedMinor) })),
        section('Account', plural(s.lines.length, 'line'), null, s.lines.length ? panel(s.lines.map((l) => item({ title: `${l.kind === 'bill' ? 'Bill' : 'Debit memo'} ${l.ref || ''}`,
          amount: money(l.amountMinor), badge: chip(l.kind === 'bill' ? 'neutral' : 'good', l.kind === 'bill' ? 'file' : 'ok', words(l.status)), detail: dayLabel(l.date),
          onClick: l.kind === 'debit_memo' ? () => memoDialog(l.id) : null }))) : empty('Nothing on the account', null, true)),
        section('Bills', null, null, s.bills.length ? panel(s.bills.map((b) => item({ title: b.reference || 'bill', amount: money(BigInt(b.total_minor) - BigInt(b.credited_minor) - BigInt(b.paid_minor)),
          detail: `${dayLabel(b.invoice_date)} · total ${money(b.total_minor)} · credits ${money(b.credited_minor)} · paid ${money(b.paid_minor)}` }))) : empty('No bills on the books', null, true))));
  }

  // ==================================================== Time off
  const LEAVE_TONE = { requested: 'warning', approved: 'good', declined: 'critical', cancelled: 'neutral' };
  const reqCard = (r, acts) => item({ title: `${r.employee} · ${r.type}`, amount: hours(r.total_hours), badge: chip(LEAVE_TONE[r.status] || 'neutral', r.status === 'approved' ? 'ok' : 'clock', words(r.status)),
    detail: [r.starts_on === r.ends_on ? dayLabel(r.starts_on) : `${dayLabel(r.starts_on)} to ${dayLabel(r.ends_on)}`, r.note, r.decided_by ? `by ${r.decided_by}` : null].filter(Boolean).join(' · '),
    why: r.decision_note || r.cancel_reason || null, acts });

  async function screenTimeOff() {
    const o = await coApi('/workforce/leave/options');
    const tabs = [['mine', 'My time off'], ...(o.manager ? [['approvals', 'Approvals']] : []), ['holidays', 'Holidays'], ...(o.setup ? [['setup', 'Setup']] : [])];
    if (!tabs.some(([k]) => k === st.leaveTab)) st.leaveTab = 'mine';
    const nav = el('div', { class: 'toolbar' }, seg(tabs, st.leaveTab, (v) => { st.leaveTab = v; E.render(); }));
    let body;
    if (st.leaveTab === 'approvals') body = await approvalsView();
    else if (st.leaveTab === 'holidays') body = await holidaysView(o);
    else if (st.leaveTab === 'setup') body = await leaveSetup(o);
    else body = await mineView(o);
    return frag(head('Time off', null, 'Back office'), nav, body);
  }

  async function mineView(o) {
    if (!o.me.employeeId) return empty('You are not set up as an employee here', 'Time off is asked for by the person it is for. Switch who you are acting as, or ask HR to link you to your employee record.', true);
    const [bal, mine] = await Promise.all([coApi('/workforce/leave/balances'), coApi('/workforce/leave/requests')]);
    const err = errSlot();
    const type = select(o.types.filter((x) => x.active).map((x) => [x.id, x.name]), '');
    const from = input({ type: 'date', value: plusDays(todayIso(), 7) }), to = input({ type: 'date', value: plusDays(todayIso(), 7) });
    const hpd = input({ type: 'number', min: '1', max: '24', step: '0.5', value: '8', inputmode: 'decimal' }), note = input({ placeholder: 'Optional' });
    const ask = btn('Ask for it', (e) => act(e.currentTarget, () => post('/workforce/leave/requests', { leaveTypeId: type.value, startsOn: from.value, endsOn: to.value, hoursPerDay: hpd.value, note: note.value }),
      (r) => `Asked for ${hours(r.totalHours)}; your manager decides`, { errorInto: showErr(err) }), { primary: true });
    return frag(
      tilesRow(...bal.types.filter((x) => x.kind !== 'unpaid').map((x) => tile({ label: x.name, value: hours(x.available), text: x.pending ? `${hours(x.pending)} waiting` : x.cap_hours ? `cap ${hours(x.cap_hours)}` : null, ic: 'info' }))),
      section('Ask for time off', null, null, panel(el('div', { class: 'ops-pad' }, el('div', { class: 'form-grid' }, field('Kind', type), field('First day', from), field('Last day', to),
        field('Hours a day', hpd), field('Note', note)), el('div', { class: 'dlg-acts' }, ask), err))),
      section('My requests', mine.length ? plural(mine.length, 'request') : null, null, mine.length ? panel(mine.map((r) => reqCard(r, r.status === 'requested' ? [
        btn('Withdraw', async (e) => { const why = await askReason({ title: 'Withdraw the request', label: 'Why' }); if (why) act(e.currentTarget, () => post(`/workforce/leave/requests/${r.id}/cancel`, { reason: why }), 'Withdrawn'); }, { small: true })] : null)))
        : empty('No requests yet', null, true)));
  }

  async function approvalsView() {
    const [open, ahead] = await Promise.all([coApi('/workforce/leave/requests?status=requested'), coApi(`/workforce/leave/requests?status=approved&from=${todayIso()}`)]);
    const err = errSlot();
    return frag(err,
      section('Waiting on you', open.length ? plural(open.length, 'request') : null, null, open.length ? panel(open.map((r) => reqCard(r, [
        btn('Approve', (e) => act(e.currentTarget, () => post(`/workforce/leave/requests/${r.id}/approve`), (x) => `Approved${x.shiftsCancelled ? `; ${plural(x.shiftsCancelled, 'shift')} cancelled` : ''}`, { errorInto: showErr(err) }), { small: true, primary: true }),
        btn('Decline', async (e) => { const why = await askReason({ title: 'Decline time off', sub: r.employee, label: 'Why' }); if (why) act(e.currentTarget, () => post(`/workforce/leave/requests/${r.id}/decline`, { note: why }), 'Declined', { errorInto: showErr(err) }); }, { small: true }),
      ]))) : empty('Nothing waiting', 'Requests people make from their phones show here.', true)),
      section('Coming up', ahead.length ? plural(ahead.length, 'person') : null, null, ahead.length ? panel(ahead.map((r) => reqCard(r, [
        btn('Take back', async (e) => { const why = await askReason({ title: 'Take back approved time off', sub: r.employee, label: 'Why' }); if (why) act(e.currentTarget, () => post(`/workforce/leave/requests/${r.id}/cancel`, { reason: why }), 'Taken back', { errorInto: showErr(err) }); }, { small: true })])))
        : empty('Nobody is off in the days ahead', null, true)));
  }

  async function holidaysView(o) {
    const list = await coApi(`/workforce/holidays?year=${st.year}`);
    const y = select([st.year - 1, st.year, st.year + 1].map((v) => [v, String(v)]), st.year, { 'aria-label': 'Year' });
    y.addEventListener('change', () => { st.year = Number(y.value); E.render(); });
    const add = () => {
      const day = input({ type: 'date' }), nm = input({ placeholder: 'Thanksgiving' });
      const closed = select([['yes', 'Stores closed (no deliveries)'], ['no', 'Stores open']], 'yes'), paid = select([['yes', 'Paid holiday'], ['no', 'Unpaid']], 'yes');
      const hrs = input({ type: 'number', min: '1', max: '24', value: '8', inputmode: 'decimal' });
      const body = (confirm) => ({ day: day.value, name: nm.value, storeClosed: closed.value === 'yes', paid: paid.value === 'yes', hours: hrs.value, confirm });
      const done = (r) => (r.blackoutId ? 'Holiday added; deliveries are closed that day' : 'Holiday added') + (r.leaveDaysReturned ? `; ${plural(r.leaveDaysReturned, 'leave day')} given back` : '');
      formDialog('Add a holiday', null, [field('Day', day), field('Name', nm), field('Stores', closed), field('Pay', paid), field('Hours paid', hrs)], 'Add', async () => {
        const r = await post('/workforce/holidays', body(false));
        if (!r.confirmNeeded) return r;
        // stops are booked that day: say which, and add only when the person says so
        const d2 = openDialog('Stops are booked that day', r.warning);
        const err = errSlot();
        d2.body.append(panel(r.stops.map((x) => item({ title: `${x.number} · ${x.customer || ''}`, detail: words(x.kind) }))),
          el('div', { class: 'dlg-acts' }, btn('Add the holiday anyway', (e) => act(e.currentTarget, () => post('/workforce/holidays', body(true)), done, { close: d2.close, errorInto: showErr(err) }), { primary: true }),
            btn('Not now', d2.close)), err);
        return null;
      }, (r) => (r ? done(r) : 'Stops are booked that day; nothing added yet'));
    };
    const cancelHol = async (h, e) => { const why = await askReason({ title: `Cancel ${h.name}`, sub: dayLabel(h.day), label: 'Why' });
      if (why) act(e.currentTarget, () => post(`/workforce/holidays/${h.id}/cancel`, { reason: why }), (r) => `Cancelled${r.blackoutReleased ? '; deliveries open again' : ''}${r.holidayPayCancelled ? `; ${plural(r.holidayPayCancelled, 'holiday payment')} cancelled` : ''}`); };
    return frag(el('div', { class: 'toolbar' }, y, el('span', { class: 'grow' }), o.setup ? btn('Add a holiday', add, { small: true, primary: true }) : null),
      section(`Holidays ${st.year}`, list.length ? plural(list.length, 'day') : null, null, list.length ? panel(list.map((h) => item({ title: h.name, amount: h.paid ? hours(h.hours) : '',
        badge: h.cancelled_at ? chip('neutral', 'info', 'Cancelled') : h.store_closed ? chip('warning', 'hold', 'Stores closed') : chip('neutral', 'info', 'Stores open'),
        detail: [dayLabel(h.day), h.paid ? 'paid' : 'unpaid', h.paid_people ? `holiday pay for ${plural(h.paid_people, 'person', 'people')}` : null].filter(Boolean).join(' · '),
        why: h.cancelled_at ? `Cancelled: ${h.cancel_reason}` : null,
        acts: o.setup && !h.cancelled_at ? [btn('Cancel', (e) => cancelHol(h, e), { small: true })] : null })))
        : empty('No holidays set for that year', null, true)));
  }

  async function leaveSetup(o) {
    const err = errSlot();
    const typeDialog = (x) => {
      const code = input({ value: x ? x.code : '', maxlength: '12' }), nm = input({ value: x ? x.name : '' });
      const kind = select([['vacation', 'Vacation'], ['sick', 'Sick'], ['unpaid', 'Unpaid'], ['other', 'Other']], x ? x.kind : 'vacation');
      const accrual = select([['none', 'Does not accrue'], ['per_hour', 'Per hours worked'], ['per_period', 'Per pay period']], x ? x.accrual : 'none');
      const hrs = input({ inputmode: 'decimal', value: x ? String(x.accrue_hours) : '0' }), per = input({ inputmode: 'decimal', value: x && x.per_hours ? String(x.per_hours) : '', placeholder: 'for every … hours worked' });
      const capH = input({ inputmode: 'decimal', value: x && x.cap_hours != null ? String(x.cap_hours) : '', placeholder: 'No cap' });
      const neg = select([['no', 'Balance cannot go below zero'], ['yes', 'May go below zero']], x && x.allow_negative ? 'yes' : 'no');
      formDialog(x ? 'Leave type' : 'Add a leave type', null, [field('Code', code), field('Name', nm), field('Kind', kind), field('Accrues', accrual), field('Hours earned', hrs),
        field('Per hours worked', per), field('Cap (hours)', capH), field('Balance', neg)], 'Save',
        () => post('/workforce/leave/types', { id: x ? x.id : null, code: code.value, name: nm.value, kind: kind.value, accrual: accrual.value, accrueHours: hrs.value,
          perHours: per.value, capHours: capH.value, allowNegative: neg.value === 'yes', paid: kind.value !== 'unpaid', active: true }), 'Saved');
    };
    const period = select(o.periods.map((p) => [p.id, `${p.pay_group} · ${dayLabel(p.starts_on)} to ${dayLabel(p.ends_on)} · ${words(p.status)}`]), '', { 'aria-label': 'Pay period' });
    const adjust = () => {
      const emp = select(o.employees.map((e) => [e.id, e.name]), ''), type = select(o.types.map((t) => [t.id, t.name]), '');
      const h = input({ inputmode: 'decimal', placeholder: '8 or -8' }), note = input({ placeholder: 'Opening balance carried in' });
      formDialog('Change a balance', null, [field('Employee', emp), field('Kind', type), field('Hours (+ or −)', h), field('Why', note)], 'Save',
        () => post('/workforce/leave/adjust', { employeeId: emp.value, leaveTypeId: type.value, hours: h.value, note: note.value }), 'Balance changed');
    };
    return frag(err,
      section('Leave types', null, [btn('Add', () => typeDialog(null), { small: true })], panel(o.types.map((x) => item({ title: `${x.name} (${x.code})`,
        amount: x.accrual === 'none' ? '' : x.accrual === 'per_hour' ? `${x.accrue_hours} h / ${x.per_hours} h` : `${x.accrue_hours} h / period`,
        badge: chip(x.paid ? 'good' : 'neutral', 'info', x.paid ? 'Paid' : 'Unpaid'),
        detail: [words(x.kind), x.cap_hours != null ? `cap ${hours(x.cap_hours)}` : 'no cap', x.allow_negative ? 'may go negative' : null, x.active ? null : 'not offered'].filter(Boolean).join(' · '),
        onClick: () => typeDialog(x) })))),
      section('Pay periods', null, null, panel(el('div', { class: 'ops-pad' }, field('Pay period', period), el('div', { class: 'dlg-acts' },
        btn('Accrue leave', (e) => act(e.currentTarget, () => post('/workforce/leave/accrue', { payPeriodId: period.value }), (r) => `${plural(r.accrued.length, 'accrual')} added`, { errorInto: showErr(err) }), { primary: true }),
        btn('Add leave and holiday pay', (e) => act(e.currentTarget, () => post('/workforce/leave/pay', { payPeriodId: period.value }), (r) => `${plural(r.leaveDays, 'leave day')} and ${plural(r.holidayPay, 'holiday payment')} added`, { errorInto: showErr(err) })),
        btn('Change a balance', adjust))))));
  }

  // ------------------------------------------------- Home: absent today
  E.homeCard(async () => {
    if (S.person && !S.person.roles.some((r) => ['owner', 'hr', 'store_manager'].includes(r))) return null;
    const a = await coApi('/workforce/absent-today');
    if (!a.onLeave.length && !a.noShow.length && !a.holiday) return null;
    const rows = [
      a.holiday ? item({ title: a.holiday.name, badge: chip('warning', 'hold', a.holiday.store_closed ? 'Stores closed' : 'Holiday') }) : null,
      ...a.onLeave.map((x) => item({ title: x.name, amount: hours(x.hours), badge: chip('neutral', 'info', x.type), detail: `back after ${dayLabel(x.back_after)}` })),
      ...a.noShow.map((x) => item({ title: x.name, badge: chip('critical', 'warn', 'Not clocked in'), detail: `shift at ${x.location} from ${x.starts}` })),
    ].filter(Boolean);
    return section('Absent today', plural(a.onLeave.length + a.noShow.length, 'person', 'people'), null, panel(capped(rows, 6, 'people')));
  });

  // the Delivery screens call these
  E.ops = { recordHaul, addHaul };

  const ICON_BOX = 'M3 7.5l9-4.5 9 4.5v9l-9 4.5-9-4.5z|M3 7.5l9 4.5 9-4.5|M12 12v9';
  const ICON_RECYCLE = 'M7 19h10l2-4|M5 15l2-7 5 2|M14 5l5 4-3 5';
  const ICON_MEMO = 'M6 3h9l4 4v14H6z|M9 11h7M9 15h7M9 7h4';
  const ICON_CAL = 'M4 6h16v14H4z|M4 10h16|M8 3v5M16 3v5';
  E.register('loading', 'Loading dock', 'box', screenLoading, 'Operations', { icon: ICON_BOX, module: 'fleet' });
  E.register('haulaway', 'Haul-away', 'recycle', screenHaul, 'Operations', { icon: ICON_RECYCLE, module: 'fleet' });
  E.register('memos', 'Debit memos', 'memo', screenMemos, 'Back office', { icon: ICON_MEMO, module: null });
  E.register('timeoff', 'Time off', 'cal', screenTimeOff, 'Back office', { icon: ICON_CAL, module: 'workforce' });
})();
