// Warehouse screens: stock and availability, scanning, receiving and the
// dock calendar, transfers, damage and vendor claims, cycle counts and
// adjustments. Phone first: everything is a card or a picker, never a wide table.
(() => {
  'use strict';
  const E = window.ERP;
  if (!E) return;
  const { el, frag, section, head, item, chip, money, openDialog, fillDialog, post, coApi, toast, seg, empty, resultBox,
    tilesRow, tile, plural, dayLabel, shortDay, ago, busy, friendly, go, S, fact, capped, todayIso } = E;

  const ALL_TABS = [['stock', 'Stock'], ['scan', 'Scan'], ['receive', 'Receive'], ['transfers', 'Transfers'], ['damage', 'Damage'], ['counts', 'Counts'], ['adjust', 'Adjust']];
  // One company with one location has nowhere to transfer to; the tab comes back with a second store.
  const multi = () => !E.S.layout || E.S.layout.multiStore || E.S.layout.multiCompany;
  let TABS = ALL_TABS;
  const STATUS_TONE = { in_stock: 'good', reserved: 'neutral', picked: 'neutral', loaded: 'neutral', delivered: 'neutral', damaged: 'serious', in_repair: 'warning',
    vendor_claim: 'warning', as_is: 'warning', returned: 'warning', in_transit: 'neutral', written_off: 'critical', returned_to_vendor: 'neutral',
    open: 'warning', submitted: 'warning', approved: 'good', rejected: 'critical', draft: 'neutral', received: 'good', cancelled: 'neutral', resolved: 'good',
    booked: 'neutral', arrived: 'warning', no_show: 'critical', credited: 'good', denied: 'critical' };
  const words = (s) => String(s || '').replace(/_/g, ' ');
  const statusChip = (s) => chip(STATUS_TONE[s] || 'neutral', s === 'in_stock' || s === 'approved' || s === 'received' ? 'ok' : 'info', words(s));
  const qty = (n) => { const x = Number(n || 0); return Number.isInteger(x) ? String(x) : x.toFixed(2); };
  const field = (label, input, opts = {}) => el('label', { class: 'field' + (opts.wide ? ' wide' : '') }, el('span', { text: label }), input, opts.hint ? el('span', { class: 'hint', text: opts.hint }) : null);
  const select = (options, value, placeholder) => el('select', {}, placeholder ? el('option', { value: '', text: placeholder }) : null,
    options.map(([v, t]) => el('option', { value: v, text: t, selected: v === value || null })));
  const input = (attrs) => el('input', Object.assign({ type: 'text' }, attrs));
  const outBox = () => el('div', { role: 'status', 'aria-live': 'polite' });
  const pad = (node) => { node.style.padding = '4px 16px 14px'; return node; };
  const lines = (text) => String(text || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

  /** Run a change from a dialog button: busy, result in the box, then the caller's refresh. */
  async function run(btn, out, fn, okText, after) {
    busy(btn, true);
    if (out) out.replaceChildren();
    try {
      const r = await fn();
      const msg = typeof okText === 'function' ? okText(r) : okText;
      if (out && msg) out.replaceChildren(resultBox('good', 'ok', 'Done', msg)); else if (msg) toast(msg, 'good');
      if (after) await after(r);
      return r;
    } catch (e) {
      const m = friendly(e);
      if (out) out.replaceChildren(resultBox('critical', 'fail', 'Not done', m)); else toast(m, 'critical');
      return null;
    } finally { if (btn.isConnected) busy(btn, false); }
  }

  let cache = { layout: null, stock: null };
  async function layout() { if (!cache.layout) cache.layout = await coApi('/inventory/layout'); return cache.layout; }
  async function products() { if (!cache.stock) cache.stock = await coApi('/inventory/stock'); return cache.stock; }
  const locOptions = (L) => L.locations.map((l) => [l.id, l.name]);
  const locSelect = (...a) => E.storePicker(select(...a));
  const binOptions = (L, locationId) => L.bins.filter((b) => b.location_id === locationId).map((b) => [b.id, b.code]);
  const productOptions = (P) => P.map((p) => [p.id, `${p.name} · ${p.sku}`]);
  let locFilter = '';

  // =================================================================== screen
  async function screen(sub) {
    cache = { layout: null, stock: null };
    TABS = ALL_TABS.filter(([k]) => k !== 'transfers' || multi());
    const tab = TABS.some(([k]) => k === sub) ? sub : 'stock';
    const body = await ({ stock: stockTab, scan: scanTab, receive: receiveTab, transfers: transfersTab, damage: damageTab, counts: countsTab, adjust: adjustTab })[tab]();
    return frag(head('Warehouse', [], `${S.co.name} · stock and tracking`),
      el('div', { class: 'toolbar' }, field('Show', (() => { const s = select(TABS, tab); s.addEventListener('change', () => go('inventory', s.value)); return s; })())), body);
  }

  // ---------------------------------------------------------------- stock
  async function stockTab() {
    const [ov, L] = await Promise.all([coApi('/inventory/overview'), layout()]);
    const list = el('div', { class: 'panel' }, E.loadingNode());
    const q = input({ placeholder: 'Search by name or SKU', 'aria-label': 'Search products', inputmode: 'search' });
    const loc = locSelect(locOptions(L), locFilter, 'Every location');
    const load = async () => {
      locFilter = loc.value;
      try {
        const rows = await coApi(`/inventory/stock?locationId=${encodeURIComponent(loc.value)}&q=${encodeURIComponent(q.value)}`);
        list.replaceChildren(...(rows.length ? capped(rows.map((p) => item({
          title: p.name, detail: [p.sku, p.category, p.serialized ? 'labelled pieces' : null].filter(Boolean).join(' · '),
          amount: `${qty(p.available)} free`,
          badge: el('span', { class: 'sub', text: `${qty(p.on_hand)} on hand · ${qty(p.reserved)} reserved${Number(p.held) ? ` · ${qty(p.held)} held` : ''}${Number(p.on_order) ? ` · ${qty(p.on_order)} on order` : ''}${p.as_is ? ` · ${p.as_is} as is` : ''}` }),
          onClick: () => openAtp(p.id) })), 12, 'products') : [empty('Nothing matches.', null, true)]));
      } catch (e) { list.replaceChildren(E.errorBox(e, load)); }
    };
    let t = 0;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    loc.addEventListener('change', load);
    load();
    const val = await coApi('/inventory/valuation');
    const byLoc = new Map();
    for (const r of val.rows) { const x = byLoc.get(r.location) || { value: 0, units: 0, cats: [] }; x.value += Number(r.value_minor); x.units += Number(r.units); x.cats.push(r); byLoc.set(r.location, x); }
    return frag(
      tilesRow(
        tile({ label: 'Stock at cost', value: money(ov.valueMinor), ic: 'book', text: Number(ov.inTransitMinor) ? `${money(ov.inTransitMinor)} more in transit` : 'Nothing in transit' }),
        tile({ label: 'Ties to the ledger', value: ov.tie.ties ? 'Yes' : money(ov.tie.differenceMinor), word: ov.tie.ties, tone: ov.tie.ties ? 'good' : 'critical', ic: ov.tie.ties ? 'ok' : 'fail',
          text: `1300 ${money(ov.tie.gl1300Minor)}${Number(ov.tie.gl1310Minor) ? ` + 1310 ${money(ov.tie.gl1310Minor)}` : ''}`, onClick: () => openTie(ov.tie) }),
        tile({ label: 'Damage open', value: String(ov.openDamage), tone: ov.openDamage ? 'warning' : 'good', ic: ov.openDamage ? 'warn' : 'ok', text: 'Repair, claim or write off', onClick: () => go('inventory', 'damage') }),
        tile({ label: 'Counts to approve', value: String(ov.countsToApprove), tone: ov.countsToApprove ? 'warning' : 'good', ic: 'check', text: 'A manager who did not count', onClick: () => go('inventory', 'counts') }),
        tile({ label: 'Deliveries due', value: String(ov.receivingThisWeek), ic: 'clock', text: 'Booked at the dock this week', onClick: () => go('inventory', 'receive') })),
      section('Stock', 'tap a product for availability', null, el('div', { class: 'toolbar' }, el('div', { class: 'grow' }, q), loc), list),
      section('Pick lists', null, [el('button', { class: 'btn small', type: 'button', onclick: openPickPicker }, 'Build a pick list')]),
      section('Value by location', 'on hand at cost', null, el('div', { class: 'panel' },
        byLoc.size ? [...byLoc.entries()].map(([name, x]) => item({ title: name, amount: money(x.value),
          detail: x.cats.map((c) => `${c.category} ${money(c.value_minor)}`).join(' · '), badge: el('span', { class: 'sub', text: `${qty(x.units)} units` }) }))
          : empty('No stock on hand.', null, true))));
  }

  function openTie(t) {
    const d = openDialog('Inventory tie-out', 'Stock at cost against the ledger');
    d.body.append(el('div', { class: 'panel' }, el('div', { class: 'facts' }, fact('Stock at cost', money(t.stockMinor)), fact('In transit', money(t.inTransitMinor)),
      fact('GL 1300 inventory', money(t.gl1300Minor)), fact('GL 1310 in transit', money(t.gl1310Minor)), fact('Difference', money(t.differenceMinor)),
      fact('Ties', t.ties ? 'Yes' : 'No'))),
      t.quantityOutOfStep.length ? section('Quantities out of step', 'cost pool vs stock on hand', null, el('div', { class: 'panel' },
        t.quantityOutOfStep.map((x) => item({ title: x.sku, detail: `costed ${qty(x.pool)} · on hand ${qty(x.stock)}` })))) : null,
      el('p', { class: 'sub', text: 'Receipts post Dr 1300 Cr 2050; sales, returns, transfers, counts and write-offs post the same value their stock moves at average cost.' }));
  }

  function openAtp(productId) {
    const d = openDialog('Available to promise', null, { wide: true });
    fillDialog(d, async () => {
      const a = await coApi(`/inventory/atp/${productId}`);
      const promise = a.promise === 'now' ? 'Can go now' : /^\d{4}-/.test(a.promise) ? `Next in ${dayLabel(a.promise)}` : E.cap(a.promise);
      return frag(
        el('p', { class: 'lead', text: `${a.product.name} · ${a.product.sku}` }),
        el('div', { class: 'panel' }, el('div', { class: 'facts' }, fact('Free now', qty(a.availableNow)), fact('Promise', promise),
          fact('Next PO', a.nextPurchaseOrder ? `${a.nextPurchaseOrder.number}, ${qty(a.nextPurchaseOrder.qty)} due ${a.nextPurchaseOrder.expectedOn ? shortDay(a.nextPurchaseOrder.expectedOn) : 'no date yet'}` : 'None open'),
          fact('As is', qty(a.asIs)))),
        section('By location', null, null, el('div', { class: 'panel' }, a.locations.map((l) => item({ title: l.name, amount: `${qty(l.available)} free`,
          detail: `${qty(l.onHand)} on hand · ${qty(l.reserved)} reserved · ${qty(l.held)} held · ${qty(l.onOrder)} on order`, badge: chip('neutral', 'building', l.kind) })))));
    });
  }

  function openPickPicker() {
    const d = openDialog('Build a pick list', 'Orders with reserved stock', { wide: true });
    fillDialog(d, async () => {
      const orders = await coApi('/inventory/orders-to-pick');
      if (!orders.length) return empty('Nothing to pick.', 'Orders show up here once their stock is reserved.', true);
      const picked = new Set();
      const out = outBox();
      const go2 = el('button', { class: 'btn primary', type: 'button', onclick: () => run(go2, out, () => post('/inventory/pick-list', { orderIds: [...picked] }), null, (r) => showPick(r, out)) }, 'Make the list');
      return frag(el('div', { class: 'panel' }, orders.map((o) => {
        const cb = el('input', { type: 'checkbox', 'aria-label': `Pick ${o.number}`, onchange: (e) => { if (e.target.checked) picked.add(o.id); else picked.delete(o.id); } });
        return item({ pick: cb, title: `${o.number}${o.customer ? ' · ' + o.customer : ''}`, detail: [plural(o.lines, 'line'), o.from_locations, o.promised_on ? `promised ${shortDay(o.promised_on)}` : null].filter(Boolean).join(' · '),
          badge: chip('neutral', 'info', words(o.fulfillment)) });
      })), el('div', { class: 'dlg-acts' }, go2, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Close')), out);
    });
  }
  function showPick(r, out) {
    out.replaceChildren(
      el('div', { class: 'panel' }, el('div', { class: 'facts' }, fact('Pieces', String(r.pieces)), fact('Cube', `${r.cubicFt} cu ft`), fact('Weight', `${r.weightLb} lb`), fact('Short', String(r.short)))),
      el('div', { class: 'panel' }, r.lines.map((l) => item({ title: `${l.orderNumber} · ${l.description}`, amount: `× ${qty(l.qty)}`,
        detail: l.serialized ? l.pieces.map((p) => `${p.label} (${p.carton}) ${p.bin ? 'in ' + p.bin : 'unbinned'}${p.serial ? ' · SN ' + p.serial : ''}${p.lot ? ' · lot ' + p.lot : ''}`).join(' · ') || 'No pieces free'
          : l.bins.map((b) => `${b.bin}: ${qty(b.qty)}`).join(' · ') || `from ${l.location || 'the location'}`,
        badge: l.short ? chip('serious', 'warn', `${l.short} short`) : chip('good', 'ok', l.location || 'ready') }))),
      (r.lotWarnings || []).length ? resultBox('warning', 'warn', 'Lots', r.lotWarnings.join(' · ')) : null);
  }

  // ----------------------------------------------------------------- scan
  async function scanTab() {
    const L = await layout();
    const box = el('div');
    const code = input({ placeholder: 'Scan or type a label, e.g. P000041', autocapitalize: 'characters', autocomplete: 'off', 'aria-label': 'Label' });
    const look = async () => {
      const v = code.value.trim().toUpperCase();
      if (!v) return;
      box.replaceChildren(E.loadingNode());
      try { renderPiece(await coApi(`/inventory/scan/${encodeURIComponent(v)}`)); }
      catch (e) { box.replaceChildren(resultBox('critical', 'fail', 'Not found', friendly(e))); }
    };
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') look(); });
    const ACT = { move: 'Move to bin', pick: 'Picked', unpick: 'Put back', load: 'Loaded on truck', unload: 'Unloaded', unallocate: 'Free from order',
      damage: 'Report damage', as_is: 'Mark as is', clear_as_is: 'Back to regular stock', repair: 'Send to repair', restore: 'Back to stock',
      write_off: 'Write off', vendor_return: 'Returned to vendor' };
    function renderPiece(s) {
      const p = s.piece;
      const out = outBox();
      const again = () => { code.value = p.label; look(); };
      const buttons = s.actions.filter((a) => ACT[a]).map((a) => {
        const b = el('button', { class: 'btn small' + (['pick', 'load', 'restore'].includes(a) ? ' primary' : ''), type: 'button', onclick: () => doAction(a, b) }, ACT[a]);
        return b;
      });
      async function doAction(a, b) {
        if (a === 'move') return pickBin(p, again);
        if (a === 'damage') return reportDamageDialog({ label: p.label }, again);
        if (a === 'as_is') return asIsDialog(p, again);
        let reason = null;
        if (['write_off', 'vendor_return'].includes(a)) { reason = await E.askReason({ title: ACT[a], label: 'Why it leaves stock', confirm: ACT[a] }); if (reason == null) return; }
        await run(b, out, () => post(`/inventory/pieces/${encodeURIComponent(p.label)}/${a}`, { reason }), `${p.label}: ${ACT[a].toLowerCase()}.`, again);
      }
      box.replaceChildren(
        section(`${p.label}`, p.carton_count > 1 ? `carton ${p.carton_seq} of ${p.carton_count}` : null, null,
          el('div', { class: 'panel' }, el('div', { class: 'facts' },
            fact('Product', `${p.name} · ${p.sku}`), fact('Status', words(p.status)), fact('Where', `${p.location}${p.bin ? ' · ' + p.bin : ''}`),
            fact('Order', p.order_number || '—'), p.carton_label ? fact('Carton', p.carton_label) : null,
            p.serial_no ? fact('Serial', p.serial_no) : null, p.lot_code ? fact(p.lot_class === 'finish_batch' ? 'Finish batch' : 'Lot', p.lot_code) : null,
            p.as_is_price_minor ? fact('As-is price', money(p.as_is_price_minor)) : null,
            s.openDamage ? fact('Damage', `${s.openDamage.number}, ${words(s.openDamage.status)}`) : null)),
          buttons.length ? el('div', { class: 'toolbar' }, buttons) : el('p', { class: 'sub', text: 'Nothing to do with it from here.' }), out),
        s.unit.length > 1 ? section('Cartons in this unit', null, null, el('div', { class: 'panel' }, s.unit.map((u) => item({ title: u.label, detail: u.bin || 'unbinned', badge: statusChip(u.status) })))) : null,
        section('History', null, null, el('div', { class: 'panel' }, s.history.length ? s.history.map((h) => item({ title: words(h.kind),
          detail: [h.from_status && h.to_status && h.from_status !== h.to_status ? `${words(h.from_status)} → ${words(h.to_status)}` : null,
            h.to_bin && h.to_bin !== h.from_bin ? `to ${h.to_bin}` : null, h.to_loc && h.to_loc !== h.from_loc ? `at ${h.to_loc}` : null, h.reason, h.by_name].filter(Boolean).join(' · '),
          badge: el('span', { class: 'sub', text: ago(h.at) }) })) : empty('No moves yet.', null, true))));
    }
    function pickBin(p, after) {
      const d = openDialog(`Move ${p.label}`, p.location);
      const bin = select(binOptions(L, p.location_id), p.bin_id, 'Pick a bin');
      const out = outBox();
      const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/inventory/pieces/${encodeURIComponent(p.label)}/move`, { binId: bin.value }),
        'Moved.', async () => { d.close(); await after(); }) }, 'Move it');
      d.body.append(field('To bin', bin), el('div', { class: 'dlg-acts' }, b, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
    }
    function asIsDialog(p, after) {
      const d = openDialog(`Sell ${p.label} as is`, p.name);
      const price = input({ inputmode: 'decimal', placeholder: '0.00' });
      const note = input({ maxlength: '200', placeholder: 'e.g. floor model, scratch on left arm' });
      const out = outBox();
      const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/inventory/pieces/${encodeURIComponent(p.label)}/as_is`, { asIsPrice: price.value, reason: note.value }),
        'Marked as is.', async () => { d.close(); await after(); }) }, 'Mark as is');
      d.body.append(el('div', { class: 'form-grid' }, field('Clearance price', price), field('What is wrong with it', note)), el('div', { class: 'dlg-acts' }, b), out);
    }
    setTimeout(() => code.focus(), 50);
    return frag(section('Scan a label', 'a Bluetooth or USB scanner types the label and presses Enter', null,
      el('div', { class: 'toolbar' }, el('div', { class: 'grow' }, code), el('button', { class: 'btn primary', type: 'button', onclick: look }, 'Look up'))), box);
  }

  function reportDamageDialog(pre, after) {
    const d = openDialog('Report damage', pre.label ? `Piece ${pre.label}` : 'A quantity of an unlabelled product');
    fillDialog(d, async () => {
      const [L, P] = await Promise.all([layout(), products()]);
      const prod = select(productOptions(P.filter((p) => !p.serialized)), '', 'Pick the product');
      const loc = locSelect(locOptions(L), '', 'Pick the location');
      const n = input({ inputmode: 'numeric', value: '1' });
      const source = select([['warehouse', 'Found in the warehouse'], ['showroom', 'Showroom'], ['delivery', 'On a delivery'], ['receiving', 'At receiving']], 'warehouse');
      const desc = el('textarea', { maxlength: '500', placeholder: 'What is wrong, and where on the piece' });
      const photos = el('textarea', { maxlength: '3000', placeholder: 'Photo links (https), one per line' });
      const out = outBox();
      const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post('/inventory/damage', pre.label
        ? { label: pre.label, source: source.value, description: desc.value, photoUrls: lines(photos.value) }
        : { productId: prod.value, locationId: loc.value, qty: n.value, source: source.value, description: desc.value, photoUrls: lines(photos.value) }),
        (r) => `Damage ${r.number} opened. The goods are held until it is resolved.`, async () => { if (after) await after(); }) }, 'Put on damage hold');
      return frag(el('div', { class: 'form-grid' },
        pre.label ? null : field('Product', prod, { wide: true }), pre.label ? null : field('Location', loc), pre.label ? null : field('How many', n),
        field('Where it was found', source), field('Description', desc, { wide: true }), field('Photos', photos, { wide: true, hint: 'Links to photos taken on the phone and uploaded.' })),
        el('div', { class: 'dlg-acts' }, b, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Close')), out);
    });
  }

  // -------------------------------------------------------------- receive
  async function receiveTab() {
    const [r, L] = await Promise.all([coApi('/inventory/receiving'), layout()]);
    const byPo = new Map();
    for (const l of r.purchaseOrders) { const x = byPo.get(l.po_id) || { ...l, lines: [] }; x.lines.push(l); byPo.set(l.po_id, x); }
    const pos = [...byPo.values()];
    const days = new Map();
    for (const a of r.appointments) { const x = days.get(a.day) || []; x.push(a); days.set(a.day, x); }
    const limitOf = (locId) => (r.docks.find((d) => d.location_id === locId) || {}).daily_piece_limit || 200;
    return frag(
      section('Open purchase orders', 'receive in part or in full', null, el('div', { class: 'panel' }, pos.length ? pos.map((po) => {
        const left = po.lines.reduce((a, l) => a + Math.max(0, Number(l.ordered) - Number(l.received)), 0);
        const eta = po.lines.map((l) => l.expected_on).filter(Boolean).sort()[0];
        return item({ title: `${po.number} · ${po.vendor}`, amount: `${qty(left)} to come`, detail: [plural(po.lines.length, 'line'), eta ? `due ${shortDay(eta)}` : null, `ordered ${shortDay(po.ordered_on)}`].filter(Boolean).join(' · '),
          acts: [el('button', { class: 'btn small primary', type: 'button', onclick: () => receiveDialog(po, L, r) }, 'Receive')] });
      }) : empty('No open purchase orders.', 'Purchase orders from purchasing show here until every line is in.', true))),
      section('Dock calendar', 'booked deliveries and the daily piece limit', [el('button', { class: 'btn small', type: 'button', onclick: () => bookDialog(L, pos) }, 'Book a delivery')],
        el('div', { class: 'panel' }, days.size ? [...days.entries()].map(([day, list]) => {
          const pieces = list.filter((a) => ['booked', 'arrived'].includes(a.status)).reduce((s, a) => s + a.expected_pieces, 0);
          const lim = limitOf(list[0].location_id);
          return item({ title: dayLabel(day), amount: `${pieces} of ${lim} pieces`, badge: pieces > lim * 0.9 ? chip('warning', 'warn', 'nearly full') : chip('good', 'ok', 'room'),
            detail: list.map((a) => `${a.window_label || 'any time'}: ${a.vendor || a.carrier || 'delivery'}${a.po_number ? ' (' + a.po_number + ')' : ''}, ${a.expected_pieces} pcs, ${words(a.status)}`).join(' · '),
            acts: list.filter((a) => a.status === 'booked').map((a) => el('button', { class: 'btn small', type: 'button', onclick: (e) => run(e.currentTarget, null,
              () => post(`/inventory/appointments/${a.id}/status`, { status: 'arrived' }), 'Marked arrived.', () => E.render()) }, `${a.vendor || 'Delivery'} arrived`)) });
        }) : empty('Nothing booked.', null, true))),
      section('Recently received', null, null, el('div', { class: 'panel' }, r.recent.length ? r.recent.map((g) => item({ title: g.number, amount: `${qty(g.qty)} units`,
        detail: [dayLabel(g.received_on), g.received_by, plural(g.lines, 'line')].filter(Boolean).join(' · ') })) : empty('Nothing received yet.', null, true))));
  }

  function receiveDialog(po, L, r) {
    const d = openDialog(`Receive ${po.number}`, po.vendor, { wide: true });
    const defaultLoc = po.ship_to_id || (L.locations.find((l) => l.kind === 'warehouse') || L.locations[0] || {}).id;
    const loc = locSelect(locOptions(L), defaultLoc);
    const dock = r.docks.find((x) => x.location_id === loc.value);
    const bin = select(binOptions(L, loc.value), '', dock ? 'The dock’s receiving bin' : 'No bin yet');
    loc.addEventListener('change', () => bin.replaceChildren(el('option', { value: '', text: 'No bin yet' }), binOptions(L, loc.value).map(([v, t]) => el('option', { value: v, text: t }))));
    const note = input({ maxlength: '300', placeholder: 'Carrier, BOL number, anything odd' });
    const rows = po.lines.map((l) => {
      const left = Math.max(0, Number(l.ordered) - Number(l.received));
      const n = input({ inputmode: 'numeric', value: String(left), 'aria-label': `Quantity for line ${l.seq}` });
      const dmg = input({ inputmode: 'numeric', value: '0', 'aria-label': `Damaged on line ${l.seq}` });
      return { l, n, dmg, left, node: el('div', { class: 'li' }, el('div', { class: 't', text: `${l.seq}. ${l.description}` }), el('div', { class: 'amt', text: `${qty(left)} left` }),
        el('div', { class: 'd' }, el('div', { class: 'form-grid' }, field('Arrived', n), field('Of those, damaged', dmg)),
          !l.product_id ? el('div', { class: 'why', text: 'This line names no product yet, so it cannot be received into stock.' }) : null)) };
    });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post('/inventory/receiving', { purchaseOrderId: po.po_id, locationId: loc.value,
      binId: bin.value || null, note: note.value, lines: rows.filter((x) => Number(x.n.value) > 0).map((x) => ({ poLineId: x.l.line_id, qty: x.n.value, damagedQty: x.dmg.value })) }),
      (res) => { const forOrders = res.lines.flatMap((x) => x.reservedFor || []);
        return `Received ${res.lines.reduce((a, x) => a + x.qty, 0)} units at ${money(res.valueMinor)}; ${res.lines.reduce((a, x) => a + x.labels.length, 0)} labels to print${res.poStatus === 'received' ? '. The PO is complete.' : '.'}`
          + (forOrders.length ? ` Reserved for customer order${forOrders.length > 1 ? 's' : ''} ${forOrders.join(', ')}.` : '')
          + (res.backordersReserved ? ` ${plural(res.backordersReserved, 'back order')} now covered.` : ''); },
      (res) => { const labels = res.lines.flatMap((x) => x.labels); if (labels.length) out.append(el('div', { class: 'panel' }, item({ title: 'Labels', detail: labels.join(' '),
        acts: [el('button', { class: 'btn small primary', type: 'button', onclick: () => { d.close(); go('labels', 'receipt:' + res.receiptId); } }, 'Print these labels')] }))); E.render(); }) }, 'Receive');
    d.body.append(el('div', { class: 'form-grid' }, field('Receiving at', loc), field('Put in', bin), field('Note', note, { wide: true })),
      el('div', { class: 'panel' }, rows.map((x) => x.node)), el('div', { class: 'dlg-acts' }, b, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Close')), out);
  }

  function bookDialog(L, pos) {
    const d = openDialog('Book a delivery', 'The dock refuses a day past its piece limit');
    const loc = locSelect(locOptions(L), (L.locations.find((l) => l.kind === 'warehouse') || {}).id);
    const day = input({ type: 'date', min: todayIso(), value: todayIso() });
    const win = input({ maxlength: '40', placeholder: '8–10am' });
    const po = select(pos.map((p) => [p.po_id, `${p.number} · ${p.vendor}`]), '', 'No purchase order');
    const carrier = input({ maxlength: '80', placeholder: 'Carrier' });
    const n = input({ inputmode: 'numeric', placeholder: 'Pieces' });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post('/inventory/appointments', { locationId: loc.value, day: day.value, window: win.value,
      purchaseOrderId: po.value || null, carrier: carrier.value, expectedPieces: n.value }), 'Booked.', async () => { d.close(); E.render(); }) }, 'Book it');
    d.body.append(el('div', { class: 'form-grid' }, field('Dock', loc), field('Day', day), field('Window', win), field('Pieces expected', n), field('Purchase order', po, { wide: true }), field('Carrier', carrier, { wide: true })),
      el('div', { class: 'dlg-acts' }, b), out);
  }

  // ------------------------------------------------------------ transfers
  async function transfersTab() {
    const [list, L, toMove] = await Promise.all([coApi('/inventory/transfers'), layout(), coApi('/inventory/orders-to-move')]);
    return frag(toMove.length ? section('Customer orders to send to their store', 'reserved here, picked up there', null, el('div', { class: 'panel' }, toMove.map((x) => item({
      title: `${x.number}${x.customer ? ' · ' + x.customer : ''}`, detail: `${x.description} × ${qty(x.qty)} · at ${x.from_name}, picked up at ${x.to_name}`,
      acts: [el('button', { class: 'btn small primary', type: 'button', onclick: (e) => run(e.currentTarget, null, () => post('/inventory/transfers',
        { fromId: x.from_id, toId: x.to_id, lines: [{ salesOrderLineId: x.line_id }] }), (r) => `${r.number} drafted; ship it when the truck leaves.`, () => E.render()) }, `Transfer to ${x.to_name}`)] })))) : null,
      section('Transfers', 'ship, then receive at the other end', [el('button', { class: 'btn small primary', type: 'button', onclick: () => newTransfer(L) }, 'New transfer')],
      el('div', { class: 'panel' }, list.length ? list.map((t) => item({ title: `${t.number} · ${t.from_name} → ${t.to_name}`, amount: t.status === 'draft' ? null : money(t.value_minor), badge: statusChip(t.status),
        detail: (t.lines || []).map((l) => `${l.name} × ${qty(l.qty)}`).join(' · '),
        acts: t.status === 'draft' ? [
          el('button', { class: 'btn small primary', type: 'button', onclick: (e) => run(e.currentTarget, null, () => post(`/inventory/transfers/${t.id}/ship`),
            (r) => (r.toCompany ? `Shipped to ${r.toCompany}${r.document ? `: ${r.document}, invoice ${r.invoiceNumber} here and a matching bill there` : ''}.` : 'Shipped; the stock is in transit.'), () => E.render()) }, 'Ship'),
          el('button', { class: 'btn small', type: 'button', onclick: (e) => run(e.currentTarget, null, () => post(`/inventory/transfers/${t.id}/cancel`), 'Cancelled.', () => E.render()) }, 'Cancel')]
          : t.status === 'in_transit' ? [el('button', { class: 'btn small primary', type: 'button', onclick: () => receiveTransfer(t, L) }, 'Receive')] : [] }))
        : empty('No transfers.', null, true))));
  }
  function newTransfer(L) {
    const d = openDialog('New transfer', 'Stock moving between locations', { wide: true });
    fillDialog(d, async () => {
      const P = await products();
      // Another of the client's companies' stores too: shipping there pairs a sale here with a bill there (Group).
      const sib = E.S.layout && !E.S.layout.multiCompany ? [] : await coApi('/group/locations').then((r) => r.locations).catch(() => []);
      const from = locSelect(locOptions(L), (L.locations.find((l) => l.kind === 'warehouse') || {}).id);
      const to = select([...locOptions(L), ...sib.map((l) => [l.id, `${l.name} · ${l.company}`])], '', 'To');
      const rowsBox = el('div', { class: 'panel' });
      const rows = [];
      const addRow = () => {
        const prod = select(productOptions(P), '', 'Product');
        const n = input({ inputmode: 'numeric', value: '1', 'aria-label': 'Quantity' });
        const labels = input({ placeholder: 'Labels (optional)', 'aria-label': 'Labels' });
        rows.push({ prod, n, labels });
        rowsBox.append(el('div', { class: 'li' }, el('div', { class: 't' }, el('div', { class: 'form-grid' }, field('Product', prod, { wide: true }), field('How many', n), field('Specific labels', labels)))));
      };
      addRow();
      const out = outBox();
      const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post('/inventory/transfers', { fromId: from.value, toId: to.value,
        lines: rows.filter((r) => r.prod.value).map((r) => ({ productId: r.prod.value, qty: r.n.value, labels: lines(r.labels.value) })) }),
        (r) => `${r.number} drafted. Ship it when it leaves.`, async () => { d.close(); E.render(); }) }, 'Draft the transfer');
      return frag(el('div', { class: 'form-grid' }, field('From', from), field('To', to)), rowsBox,
        el('div', { class: 'toolbar' }, el('button', { class: 'btn small', type: 'button', onclick: addRow }, 'Another product')),
        el('div', { class: 'dlg-acts' }, b, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Close')), out);
    });
  }
  function receiveTransfer(t, L) {
    const d = openDialog(`Receive ${t.number}`, `at ${t.to_name}`);
    const bin = select(binOptions(L, t.to_location_id), '', 'No bin yet');
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/inventory/transfers/${t.id}/receive`, { binId: bin.value || null }),
      'Received.', async () => { d.close(); E.render(); }) }, 'Received in full');
    d.body.append(el('p', { class: 'lead', text: 'Anything that arrived damaged: receive it, then scan the piece and report the damage.' }), field('Put in', bin), el('div', { class: 'dlg-acts' }, b), out);
  }

  // --------------------------------------------------------------- damage
  async function damageTab() {
    const list = await coApi('/inventory/damage');
    return section('Damage and vendor claims', 'held goods cannot be sold until resolved',
      [el('button', { class: 'btn small', type: 'button', onclick: () => reportDamageDialog({}, () => E.render()) }, 'Report damage')],
      el('div', { class: 'panel' }, list.length ? list.map((d) => {
        const claims = d.claims || [];
        const open = claims.find((c) => !['credited', 'denied'].includes(c.status));
        const acts = [];
        if (d.status === 'open') acts.push(el('button', { class: 'btn small', type: 'button', onclick: (e) => run(e.currentTarget, null, () => post(`/inventory/damage/${d.id}/repair`), 'Sent to repair.', () => E.render()) }, 'Repair'));
        if (['open', 'in_repair'].includes(d.status)) acts.push(el('button', { class: 'btn small', type: 'button', onclick: () => claimDialog(d) }, 'Vendor claim'));
        if (open) acts.push(el('button', { class: 'btn small', type: 'button', onclick: () => claimUpdate(open) }, `Claim ${open.number}`));
        if (d.status !== 'resolved') acts.push(el('button', { class: 'btn small primary', type: 'button', onclick: () => resolveDialog(d) }, 'Resolve'));
        return item({ title: `${d.number} · ${d.name}`, amount: money(Number(d.cost_minor) * Number(d.qty)), badge: statusChip(d.status === 'resolved' ? d.resolution : d.status),
          detail: [d.labels || `${qty(d.qty)} × ${d.sku}`, d.location, words(d.source), d.description, d.photo_urls.length ? plural(d.photo_urls.length, 'photo') : null,
            ...claims.map((c) => `${c.number} ${words(c.status)}${c.credit ? ' ' + money(c.credit) : ''}`)].filter(Boolean).join(' · '), acts });
      }) : empty('No damage open.', null, true)));
  }
  function claimDialog(dm) {
    const d = openDialog('Open a vendor claim', `${dm.number} · ${dm.name}`);
    const amt = input({ inputmode: 'decimal', value: (Number(dm.cost_minor) * Number(dm.qty) / 100).toFixed(2) });
    const ref = input({ maxlength: '80', placeholder: 'Vendor RA or claim number, if you have it' });
    const photos = el('textarea', { placeholder: 'Photo links (https), one per line' });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/inventory/damage/${dm.id}/claim`, { amount: amt.value, vendorRef: ref.value, photoUrls: lines(photos.value) }),
      (r) => `Claim ${r.number} opened.`, async () => { d.close(); E.render(); }) }, 'Open the claim');
    d.body.append(el('div', { class: 'form-grid' }, field('Claim amount', amt), field('Vendor reference', ref), field('Photos', photos, { wide: true })), el('div', { class: 'dlg-acts' }, b), out);
  }
  function claimUpdate(cl) {
    const d = openDialog(`Claim ${cl.number}`, `now ${words(cl.status)}`);
    const st = select([['submitted', 'Submitted to the vendor'], ['approved', 'Vendor approved'], ['credited', 'Credited'], ['denied', 'Denied']], 'credited');
    const credit = input({ inputmode: 'decimal', placeholder: '0.00' });
    const res = input({ maxlength: '300', placeholder: 'Credit memo number, or why it was denied' });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/inventory/claims/${cl.id}`, { status: st.value, credit: credit.value, resolution: res.value }),
      'Updated.', async () => { d.close(); E.render(); }) }, 'Save');
    d.body.append(el('div', { class: 'form-grid' }, field('Status', st), field('Credit', credit), field('How it settled', res, { wide: true })), el('div', { class: 'dlg-acts' }, b), out);
  }
  function resolveDialog(dm) {
    const d = openDialog(`Resolve ${dm.number}`, dm.name);
    const resn = select([['restocked', 'Repaired, back to stock'], ['as_is', 'Sell as is'], ['written_off', 'Write off'], ['returned_to_vendor', 'Returned to the vendor']], 'restocked');
    const price = input({ inputmode: 'decimal', placeholder: 'As-is price' });
    const note = input({ maxlength: '300', placeholder: 'What was done' });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/inventory/damage/${dm.id}/resolve`, { resolution: resn.value, note: note.value, asIsPrice: price.value }),
      (r) => r.journalEntryId ? 'Resolved; the cost went to shrink and damage.' : 'Resolved.', async () => { d.close(); E.render(); }) }, 'Resolve');
    d.body.append(el('div', { class: 'form-grid' }, field('Outcome', resn), field('As-is price', price, { hint: 'Only for sell as is.' }), field('Note', note, { wide: true, hint: 'Write-offs and vendor returns need a store manager.' })),
      el('div', { class: 'dlg-acts' }, b), out);
  }

  // --------------------------------------------------------------- counts
  async function countsTab() {
    const [list, L] = await Promise.all([coApi('/inventory/counts'), layout()]);
    const me = S.person ? S.person.id : null;
    return section('Cycle counts', 'counted by one person, approved by a manager who did not count',
      [el('button', { class: 'btn small primary', type: 'button', onclick: () => newCount(L) }, 'Count a bin')],
      el('div', { class: 'panel' }, list.length ? list.map((c) => item({ title: `${c.number} · ${c.location}${c.bin ? ' · ' + c.bin : ' · unbinned'}`,
        amount: c.variance_minor != null ? money(c.variance_minor) : null, badge: statusChip(c.status),
        detail: [plural(c.lines, 'line'), `by ${c.created_by}`, c.submitted_by ? `submitted by ${c.submitted_by}` : null, c.decided_by ? `${words(c.status)} by ${c.decided_by}` : null, c.decision_note].filter(Boolean).join(' · '),
        why: c.status === 'submitted' && me && (me === c.created_by_id || me === c.submitted_by_id) ? 'You counted this one, so someone else approves it.' : null,
        onClick: () => openCount(c.id) })) : empty('No counts yet.', null, true)));
  }
  function newCount(L) {
    const d = openDialog('Count a bin', 'The sheet lists what the system expects');
    const loc = locSelect(locOptions(L), (L.locations.find((l) => l.kind === 'warehouse') || {}).id);
    const bin = select(binOptions(L, loc.value), '', 'Unbinned stock');
    loc.addEventListener('change', () => bin.replaceChildren(el('option', { value: '', text: 'Unbinned stock' }), binOptions(L, loc.value).map(([v, t]) => el('option', { value: v, text: t }))));
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post('/inventory/counts', { locationId: loc.value, binId: bin.value || null }),
      null, async (r) => { d.close(); await E.render(); openCount(r.id); }) }, 'Start the count');
    d.body.append(el('div', { class: 'form-grid' }, field('Location', loc), field('Bin', bin)), el('div', { class: 'dlg-acts' }, b), out);
  }
  function openCount(id) {
    const d = openDialog('Count sheet', null, { wide: true });
    const load = () => fillDialog(d, async () => {
      const c = await coApi(`/inventory/counts/${id}`);
      const out = outBox();
      const rows = c.lines.map((l) => {
        const n = input({ inputmode: 'numeric', value: l.counted_qty != null ? qty(l.counted_qty) : '', placeholder: 'Count', 'aria-label': `Count of ${l.name}` });
        const scans = el('textarea', { placeholder: 'Scan each label here', 'aria-label': `Labels of ${l.name}` });
        if (l.scanned_labels.length) scans.value = l.scanned_labels.join('\n');
        return { l, n, scans, node: item({ title: l.name, amount: `${qty(l.expected_qty)} expected`,
          detail: [l.sku, l.counted_qty != null ? `counted ${qty(l.counted_qty)}` : null, l.variance_minor != null && l.variance_minor !== '0' ? `variance ${money(l.variance_minor)}` : null].filter(Boolean).join(' · '),
          acts: c.status === 'open' ? [el('div', { class: 'form-grid' }, field('Counted', n), l.serialized ? field('Or scan labels', scans, { hint: 'Scanned labels decide the count.' }) : null)] : [] }) };
      });
      const acts = [];
      if (c.status === 'open') {
        const sb = el('button', { class: 'btn primary', type: 'button', onclick: () => run(sb, out, () => post(`/inventory/counts/${id}/submit`, {
          lines: rows.map((r) => ({ productId: r.l.product_id, countedQty: r.n.value, scannedLabels: lines(r.scans.value) })) }), (r) => `Submitted; variance ${money(r.varianceMinor)}.`, () => { load(); E.render(); }) }, 'Submit the count');
        acts.push(sb);
      }
      if (c.status === 'submitted') {
        const ab = el('button', { class: 'btn primary', type: 'button', onclick: () => run(ab, out, () => post(`/inventory/counts/${id}/decide`, { approve: true }),
          (r) => `Approved; ${money(r.varianceMinor)} posted.`, () => { load(); E.render(); }) }, 'Approve');
        const rb = el('button', { class: 'btn', type: 'button', onclick: async () => { const why = await E.askReason({ title: 'Reject the count', label: 'Why', confirm: 'Reject' });
          if (why) run(rb, out, () => post(`/inventory/counts/${id}/decide`, { approve: false, note: why }), 'Rejected.', () => { load(); E.render(); }); } }, 'Reject');
        acts.push(ab, rb);
      }
      return frag(el('p', { class: 'lead', text: `${c.number} · ${c.location}${c.bin ? ' · ' + c.bin : ''} · ${words(c.status)}` }),
        el('div', { class: 'panel' }, rows.length ? rows.map((r) => r.node) : empty('Nothing expected here.', 'Submit with zero lines, or add what you found from the Adjust tab.', true)),
        el('div', { class: 'dlg-acts' }, acts, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Close')), out);
    });
    load();
  }

  // --------------------------------------------------------------- adjust
  async function adjustTab() {
    const [a, L, P] = await Promise.all([coApi('/inventory/adjustments'), layout(), products()]);
    const loc = locSelect(locOptions(L), (L.locations.find((l) => l.kind === 'warehouse') || {}).id);
    const bin = select(binOptions(L, loc.value), '', 'No bin');
    loc.addEventListener('change', () => bin.replaceChildren(el('option', { value: '', text: 'No bin' }), binOptions(L, loc.value).map(([v, t]) => el('option', { value: v, text: t }))));
    const prod = select(productOptions(P), '', 'Pick the product');
    const n = input({ inputmode: 'numeric', placeholder: '-1 or 2' });
    const reason = select(a.reasons.map((r) => [r, E.cap(words(r))]), '', 'Pick a reason');
    const note = input({ maxlength: '300', placeholder: 'What happened' });
    const labels = input({ placeholder: 'Labels being taken out (labelled products)' });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post('/inventory/adjustments', { locationId: loc.value, binId: bin.value || null,
      productId: prod.value, qty: n.value, reasonCode: reason.value, note: note.value, labels: lines(labels.value) }),
      (r) => `${r.number} posted: ${money(r.valueMinor)} at cost.${r.labels.length ? ' Labels: ' + r.labels.join(' ') : ''}`, () => E.render()) }, 'Post the adjustment');
    return frag(
      section('Adjust stock', 'a store manager posts it, at cost, with a reason', null, el('div', { class: 'panel' }, pad(el('div', {},
        el('div', { class: 'form-grid' }, field('Location', loc), field('Bin', bin), field('Product', prod, { wide: true }), field('Change by', n, { hint: 'Negative takes stock out.' }),
          field('Reason', reason), field('Note', note, { wide: true }), field('Labels', labels, { wide: true })), el('div', { class: 'dlg-acts' }, b), out)))),
      section('Recent adjustments', null, null, el('div', { class: 'panel' }, a.rows.length ? a.rows.map((x) => item({ title: `${x.number} · ${x.name}`, amount: money(x.value_minor),
        detail: [`${Number(x.qty) > 0 ? '+' : ''}${qty(x.qty)} at ${x.location}`, words(x.reason_code), x.note, x.by_name, ago(x.at)].filter(Boolean).join(' · ') })) : empty('None yet.', null, true))));
  }

  E.register('inventory', 'Warehouse', 'box', screen, 'Operations', { icon: 'M3.5 7.5L12 3.5l8.5 4v9L12 20.5l-8.5-4z|M3.5 7.5L12 11.5l8.5-4|M12 11.5v9', module: 'inventory' });
})();
