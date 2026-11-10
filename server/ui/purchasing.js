// purchasing screens. Registers with window.ERP (see docs/MODULES.md).
// The owner's buying program: overview, the order form (quantities by store
// against budget and freight minimum), the special-order queue, purchase
// orders (acknowledge, landed cost, cancel, send), open-to-buy budgets,
// reorder points and vendor acknowledgment files. Phone first.
(() => {
  'use strict';
  const E = window.ERP;
  if (!E) return;
  const { S, el, frag, icon, chip, money, plural, cap, coApi, post, go, toast, act, openDialog, resultBox, fillDialog, askReason,
    head, section, tile, tilesRow, empty, item, capped, seg, fact, friendly, render, shortDay, todayIso } = E;

  const field = (label, control, hint, wide) => el('label', { class: 'field' + (wide ? ' wide' : '') }, el('span', { text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null);
  const select = (options, value) => el('select', {}, options.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(value ?? '') || null })));
  const input = (props) => el('input', Object.assign({ type: 'text' }, props));
  const errInto = (box) => (e) => box.replaceChildren(resultBox('critical', 'fail', 'Not done', friendly(e)));
  const cents = (dollars) => Math.round(Number(String(dollars || '0').replace(/[$,\s]/g, '')) * 100);
  const thisMonth = () => todayIso().slice(0, 7);

  /** A product photo through the app's own image route (outside images are blocked by the page's policy), fetched when it scrolls into view. */
  const IMG_SEEN = new Map();
  const proxyImg = (productId, seq, alt, cls) => {
    const img = el('img', { alt: alt || '', class: cls || null, width: '76', height: '76' });
    const load = () => {
      const k = `${productId}/${seq}`;
      if (!IMG_SEEN.has(k)) IMG_SEEN.set(k, coApi(`/catalog/image/${productId}/${seq}`).then((r) => r.dataUrl).catch(() => null));
      IMG_SEEN.get(k).then((src) => { if (src) img.src = src; else img.title = 'Photo could not be fetched'; });
    };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); load(); } });
      io.observe(img);
    } else load();
    return img;
  };
  const ACK = { pending: ['neutral', 'pending', 'Waiting on vendor'], accepted: ['good', 'ok', 'Confirmed'], backordered: ['warning', 'clock', 'Backordered'],
    changed: ['warning', 'info', 'Changed'], rejected: ['critical', 'fail', 'Rejected'] };
  const STAT = { open: ['neutral', 'pending', 'Open'], received: ['good', 'ok', 'Received'], closed: ['good', 'ok', 'Closed'], cancelled: ['neutral', 'none', 'Cancelled'] };

  function style() {
    if (window.__purSheet) return;
    const sheet = new CSSStyleSheet();
    window.__purSheet = sheet;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    sheet.replaceSync(`
.po-qty{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;padding:0 16px 12px}
.po-qty label{display:flex;flex-direction:column;gap:3px;font-size:12.5px;color:var(--ink-2)}
.po-qty input{text-align:right;font-variant-numeric:tabular-nums}
.po-qty .sg{color:var(--accent-ink);font-weight:650}
.po-card{border-top:1px solid var(--line)}.po-card:first-child{border-top:0}
.po-card .li{border-top:0}
.po-sum{position:sticky;bottom:calc(var(--tabbar) + 8px);z-index:3;background:var(--panel);border:1px solid var(--line-2);border-radius:12px;box-shadow:var(--shadow);padding:10px 14px;margin-top:14px}
.po-sum .rows{display:flex;flex-direction:column;gap:4px;font-size:14px;margin-bottom:8px}
.po-sum .r{display:flex;justify-content:space-between;gap:10px}.po-sum .r span:last-child{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.po-sum .bad{color:var(--critical);font-weight:650}
.po-meter{height:6px;border-radius:3px;background:var(--neutral-bg);overflow:hidden;margin-top:6px}.po-meter i{display:block;height:100%;background:var(--teal)}
.po-meter.over i{background:var(--critical)}
.po-tb{display:grid;grid-template-columns:1fr;gap:8px;margin:0 0 12px}
@media (min-width:720px){.po-tb{grid-template-columns:2fr 1fr 1fr}}
.po-ack{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;padding:10px;border:1px solid var(--line);border-radius:10px;margin:8px 0;background:var(--soft)}
.panel.pad{padding:6px 16px 14px}.toolbar.flush{margin:0}.qty-in{max-width:90px;text-align:right}
input[type=month]{width:100%;font-size:16px;color:var(--ink);background:var(--panel);border:1px solid var(--line-2);border-radius:9px;padding:9px 11px;min-height:42px}
.po-ack .t{grid-column:1/-1;font-weight:620}.po-ack .field{margin:4px 0}
.po-head{display:grid;grid-template-columns:64px minmax(0,1fr);align-items:start;gap:0;padding-left:12px}
.po-head img,.po-head .po-noimg{width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid var(--line);background:var(--soft);margin-top:12px}
`);
  }

  /** A meter's fill, sized through the CSSOM (the page's policy refuses inline style attributes). */
  const meterBar = (pctv) => { const i = el('i'); i.style.width = `${pctv}%`; return i; };
  const download = (filename, text) => {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: filename });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  const placedToast = (r) => r.placed.length ? `${plural(r.placed.length, 'purchase order')} placed: ${r.placed.map((p) => p.number).join(', ')}` : 'Nothing placed';
  const warnBox = (r) => {
    const w = r.placed.flatMap((p) => p.warnings.map((x) => `${p.number}: ${x}`));
    if (w.length) toast(w.join(' · '), 'warning');
  };

  const TABS = [['overview', 'Overview'], ['order', 'Order form'], ['special', 'Special orders'], ['pos', 'POs'], ['budgets', 'Budgets'], ['reorder', 'Reorder'], ['vendor-files', 'Vendor files']];
  async function screen(sub) {
    style();
    const tab = TABS.some(([k]) => k === sub) ? sub : 'overview';
    const body = await ({ overview: tabOverview, order: tabOrder, special: tabSpecial, pos: tabPOs, budgets: tabBudgets, reorder: tabReorder, 'vendor-files': tabFiles })[tab]();
    return frag(head('Buying', [el('button', { class: 'btn primary', type: 'button', onclick: () => go('purchasing', 'order') }, icon('plus'), 'Order form')]),
      el('div', { class: 'toolbar' }, seg(TABS, tab, (k) => go('purchasing', k === 'overview' ? '' : k))), body);
  }

  // --------------------------------------------------------------- overview
  async function tabOverview() {
    const d = await coApi('/purchasing/home');
    const open = BigInt(d.otb.open), budget = BigInt(d.otb.budget);
    return frag(
      tilesRow(
        tile({ label: 'Open to buy this month', value: money(d.otb.open), tone: open < 0n ? 'critical' : d.otb.over ? 'warning' : 'good', ic: open < 0n ? 'warn' : 'ok',
          text: budget ? `${money(d.otb.committed)} of ${money(d.otb.budget)} committed${d.otb.over ? `; ${plural(d.otb.over, 'budget')} over` : ''}` : 'No budgets set', onClick: () => go('purchasing', 'budgets') }),
        tile({ label: 'Open purchase orders', value: money(d.pos.open_minor), tone: 'neutral', ic: 'file', text: `${plural(Number(d.pos.open_n), 'order')}`, onClick: () => go('purchasing', 'pos') }),
        tile({ label: 'Waiting on vendors', value: String(d.pos.unack_n), suffix: 'unconfirmed', tone: Number(d.pos.late_n) ? 'serious' : Number(d.pos.unack_n) ? 'warning' : 'good', ic: 'clock',
          text: Number(d.pos.late_n) ? `${plural(Number(d.pos.late_n), 'order')} past due` : 'None past due', onClick: () => go('purchasing', 'pos') }),
        tile({ label: 'Customers waiting', value: String(d.queue), suffix: 'special orders', tone: d.queue ? 'warning' : 'good', ic: d.queue ? 'people' : 'ok',
          text: d.queue ? 'Not on a vendor PO yet' : 'Every one is ordered', onClick: () => go('purchasing', 'special') })),
      section('Next steps', null, null, el('div', { class: 'panel' },
        item({ title: 'Reorder suggestions', amount: String(d.suggestions), detail: 'Stock at or below its minimum, counting what is on order and what customers are waiting for', onClick: () => go('purchasing', 'reorder') }),
        item({ title: 'Special-order queue', amount: String(d.queue), detail: 'Customer lines on order with no vendor PO', onClick: () => go('purchasing', 'special') }),
        item({ title: 'Vendor acknowledgments', detail: 'Enter a vendor’s confirmation, or import their 855-style file; dates flow to the customer’s order', onClick: () => go('purchasing', 'vendor-files') }))));
  }

  // ------------------------------------------------------------- order form
  const OF = { vendor: '', month: '', qty: {} };        // qty: productId|locationId -> n
  async function tabOrder() {
    const qs = new URLSearchParams();
    if (OF.vendor) qs.set('vendor', OF.vendor);
    if (OF.month) qs.set('month', OF.month);
    const d = await coApi(`/purchasing/order-form?${qs}`);
    if (!d.vendor) return empty('No vendors with stock items.', 'Add products from a vendor in the catalog first.', true);
    if (OF.vendor !== d.vendor.id) { OF.vendor = d.vendor.id; OF.qty = {}; }
    const vSel = select(d.vendors.map((v) => [v.id, v.name]), d.vendor.id);
    vSel.onchange = () => { OF.vendor = vSel.value; OF.qty = {}; render(); };
    const mIn = input({ type: 'month', value: (OF.month || d.month).slice(0, 7) });
    mIn.onchange = () => { OF.month = mIn.value; render(); };
    const locs = d.locations;
    const locName = Object.fromEntries(locs.map((l) => [l.id, l.name]));
    const sugg = Object.fromEntries((d.suggestions || []).map((s) => [`${s.productId}|${s.locationId}`, s.qty]));
    const products = Object.fromEntries(d.products.map((p) => [p.id, p]));
    const sum = el('div', { class: 'po-sum' });
    const place = el('button', { class: 'btn primary', type: 'button' }, 'Place orders');

    const draw = () => {
      const byLoc = {}, byBudget = {};
      let units = 0;
      for (const [k, n] of Object.entries(OF.qty)) {
        if (!(n > 0)) continue;
        const [pid, lid] = k.split('|'), p = products[pid];
        if (!p) continue;
        const ext = n * Number(p.cost_minor);
        byLoc[lid] = (byLoc[lid] || 0) + ext; units += n;
        const bk = `${p.category}|${lid}`;
        byBudget[bk] = (byBudget[bk] || 0) + ext;
      }
      const total = Object.values(byLoc).reduce((a, b) => a + b, 0);
      const fmin = Number(d.vendor.freight_min_minor);
      const rows = Object.entries(byLoc).map(([lid, v]) => {
        const short = fmin && v < fmin;
        return el('div', { class: 'r' }, el('span', { text: `PO to ${locName[lid]}` }), el('span', { class: short ? 'bad' : null, text: `${money(v)}${short ? ` · ${money(fmin - v)} under freight min` : ''}` }));
      });
      const budgetRows = Object.entries(byBudget).map(([k, v]) => {
        const [catg, lid] = k.split('|');
        const b = d.otb.find((o) => o.category === catg && o.location_id === lid);
        if (!b) return el('div', { class: 'r' }, el('span', { text: `${catg} · ${locName[lid]}` }), el('span', { text: 'no budget' }));
        const left = Number(b.open_minor) - v;
        return el('div', { class: 'r' }, el('span', { text: `${catg} · ${locName[lid]}` }), el('span', { class: left < 0 ? 'bad' : null, text: `${money(left)} left of ${money(b.budget_minor)}` }));
      });
      const metPct = fmin ? Math.min(100, Math.round((total / fmin) * 100)) : 100;
      sum.replaceChildren(
        el('div', { class: 'rows' },
          el('div', { class: 'r' }, el('b', { text: `${plural(units, 'piece')} · ${plural(Object.keys(byLoc).length, 'PO')}` }), el('b', { text: money(total) })), rows, budgetRows,
          fmin ? el('div', {}, el('div', { class: 'r' }, el('span', { text: `Freight minimum ${money(fmin)}` }), el('span', { text: `${metPct}%` })),
            el('div', { class: 'po-meter' + (total < fmin ? ' over' : '') }, meterBar(metPct))) : null),
        el('div', { class: 'toolbar flush' }, el('button', { class: 'btn small', type: 'button', onclick: fillSugg }, 'Fill suggested'),
          el('button', { class: 'btn small', type: 'button', onclick: () => { OF.qty = {}; render(); } }, 'Clear'), el('span', { class: 'grow' }), place));
    };
    const inputs = {};
    const fillSugg = () => { for (const [k, n] of Object.entries(sugg)) { OF.qty[k] = n; if (inputs[k]) inputs[k].value = String(n); } draw(); };
    const cards = d.products.map((p) => {
      const st = Object.fromEntries(p.stock.map((s) => [s.location, s]));
      const rules = Object.fromEntries(p.rules.map((r) => [r.location, r]));
      const atp = p.vendor_atp;
      const frt = Object.fromEntries((p.sku_freight || []).map((f) => [f.location, f.freight]));
      return el('div', { class: 'po-card' },
        el('div', { class: 'po-head' }, p.image ? proxyImg(p.id, 1, '') : el('div', { class: 'po-noimg' }),
          item({ title: p.name, amount: money(p.cost_minor), detail: [p.sku, p.vendor_sku ? `model ${p.vendor_sku}` : null, p.category, p.collection].filter(Boolean).join(' · '),
            badge: atp ? (Number(atp.qty) > 0 ? chip('good', 'ok', `Vendor has ${Number(atp.qty)}${atp.leadDays != null ? ` · ships in ${atp.leadDays}d` : ''}`)
              : chip('warning', 'clock', `Vendor out${atp.leadDays != null ? ` · ETA ${atp.leadDays}d` : ''}`)) : null,
            why: atp && atp.exception ? atp.exception : null })),
        el('div', { class: 'po-qty' }, locs.map((l) => {
          const k = `${p.id}|${l.id}`, s = st[l.id], r = rules[l.id];
          const box = input({ type: 'number', min: '0', step: '1', inputmode: 'numeric', value: OF.qty[k] || '', placeholder: '0', 'aria-label': `${p.name} for ${l.name}` });
          inputs[k] = box;
          box.oninput = () => { OF.qty[k] = Math.max(0, Math.floor(Number(box.value) || 0)); draw(); };
          return el('label', {}, el('span', { text: l.name }), box,
            el('span', { text: `${s ? Number(s.available) : 0} avail · ${s ? Number(s.onOrder) : 0} on order${r ? ` · ${Number(r.min)}/${Number(r.max)}` : ''}${frt[l.id] != null ? ` · freight ${money(frt[l.id])}` : ''}` }),
            sugg[k] ? el('span', { class: 'sg', text: `Suggest ${sugg[k]}` }) : null);
        })));
    });
    place.onclick = async () => {
      const lines = Object.entries(OF.qty).filter(([, n]) => n > 0).map(([k, qty]) => { const [productId, locationId] = k.split('|'); return { productId, locationId, qty }; });
      if (!lines.length) { toast('Put a quantity on at least one line.', 'warning'); return; }
      const send = async (overBudgetReason) => post('/purchasing/order-form', { lines, overBudgetReason });
      busyPlace(true);
      try {
        let r;
        try { r = await send(null); }
        catch (e) {
          if (!/over budget/i.test(e.message) || !/Say why/.test(e.message)) throw e;
          const why = await askReason({ title: 'Over budget', lead: friendly(e).replace(/ Say why it should go anyway\.?$/, ''), label: 'Why it should go anyway', confirm: 'Place anyway' });
          if (!why) return;
          r = await send(why);
        }
        OF.qty = {};
        toast(placedToast(r), 'good');
        warnBox(r);
        go('purchasing', 'pos');
      } catch (e) { toast(friendly(e), 'critical'); }
      finally { busyPlace(false); }
    };
    const busyPlace = (on) => { place.disabled = on; place.textContent = on ? 'Placing…' : 'Place orders'; };
    draw();
    return frag(
      el('div', { class: 'po-tb' }, vSel, mIn, el('div')),
      el('div', { class: 'panel' }, item({ title: d.vendor.name, amount: `${d.vendor.lead_days} days`,
        detail: [d.vendor.order_email ? `orders to ${d.vendor.order_email}` : 'no order email on file', Number(d.vendor.freight_min_minor) ? `freight minimum ${money(d.vendor.freight_min_minor)}` : null,
          d.vendor.freight_min_qty ? `${d.vendor.freight_min_qty} pieces minimum` : null].filter(Boolean).join(' · '),
        why: 'One PO goes to the vendor for each place with quantities. Budgets are for the month the goods are due.' })),
      section('Quantities by place', `${d.products.length} items`, null, el('div', { class: 'panel' }, cards.length ? cards : empty('Nothing to order.', 'This vendor has no active stock items.', true))),
      sum);
  }

  // --------------------------------------------------------- special orders
  async function tabSpecial() {
    const d = await coApi('/purchasing/special-orders');
    const picked = new Set(d.lines.map((l) => l.sales_line_id));
    const go_ = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go_, () => post('/purchasing/special-orders', { lineIds: [...picked] }), placedToast) }, 'Order selected');
    const byVendor = {};
    for (const l of d.lines) (byVendor[l.vendor || 'No vendor'] = byVendor[l.vendor || 'No vendor'] || []).push(l);
    const opts = (cfg) => Object.values(cfg || {}).flat().map((o) => (o && o.vendorCode ? `${o.label} (${o.vendorCode})` : o && o.label)).filter(Boolean).join(', ');
    return frag(
      el('p', { class: 'lead', text: 'Customer lines that are on order and on no vendor PO. Ordering makes one PO per vendor per ship-to; each line keeps the factory’s option codes and stays tied to the customer’s order, so the vendor’s date reaches it.' }),
      d.lines.length ? Object.entries(byVendor).map(([v, ls]) => section(v, plural(ls.length, 'line'), null, el('div', { class: 'panel' }, ls.map((l) => {
        const box = el('input', { type: 'checkbox', class: 'pickbox', checked: true, 'aria-label': `Order ${l.description}`, onchange: (e) => { if (e.target.checked) picked.add(l.sales_line_id); else picked.delete(l.sales_line_id); } });
        return item({ pick: box, title: `${Number(l.qty)} × ${l.description}`, amount: l.order_number,
          detail: [l.customer, `ship to ${l.ship_to}`, shortDay(String(l.ordered_at).slice(0, 10))].filter(Boolean).join(' · '),
          badge: l.vendor_qty != null ? (Number(l.vendor_qty) >= Number(l.qty) ? chip('good', 'ok', `Vendor has ${Number(l.vendor_qty)}`)
            : chip('warning', 'clock', `Vendor short${l.vendor_lead_days != null ? ` · ETA ${l.vendor_lead_days}d` : ''}`)) : null,
          why: opts(l.config) ? `Options: ${opts(l.config)}` : null });
      })))) : section('Queue', null, null, el('div', { class: 'panel' }, empty('Every customer special order is on a vendor PO.', null))),
      d.lines.length ? el('div', { class: 'dlg-acts' }, go_) : null);
  }

  // ------------------------------------------------------------------- POs
  const PF = { status: 'open', vendor: '' };
  async function tabPOs() {
    const qs = new URLSearchParams({ status: PF.status });
    if (PF.vendor) qs.set('vendor', PF.vendor);
    const d = await coApi(`/purchasing/pos?${qs}`);
    const rows = d.pos.map((p) => item({
      title: `${p.number} · ${p.vendor}`, amount: money(p.total_minor),
      detail: [`to ${p.ship_to}`, p.kind === 'special' ? 'special order' : null, `ordered ${shortDay(p.ordered_on)}`, p.expected_on ? `due ${shortDay(p.expected_on)}` : null,
        Number(p.customer_lines) ? plural(Number(p.customer_lines), 'customer line') : null, p.exported_at ? 'sent' : 'not sent'].filter(Boolean).join(' · '),
      badge: p.status !== 'open' ? chip(...STAT[p.status]) : p.late ? chip('serious', 'warn', 'Past due') : p.acknowledged_on ? chip('good', 'ok', 'Confirmed') : chip('neutral', 'pending', 'Waiting on vendor'),
      onClick: () => openPO(p.id) }));
    return frag(
      el('div', { class: 'toolbar' }, seg([['open', 'Open'], ['received', 'Received'], ['cancelled', 'Cancelled'], ['all', 'All']], PF.status, (k) => { PF.status = k; render(); })),
      section('Purchase orders', `${d.pos.length}`, null, el('div', { class: 'panel' }, rows.length ? capped(rows, 25, 'orders') : empty('None here.', null, true))));
  }

  async function openPO(id) {
    const d = openDialog('Purchase order', null, { wide: true, sheet: true });
    const again = () => { d.close(); openPO(id); };
    await fillDialog(d, async () => {
      const x = await coApi(`/purchasing/pos/${id}`);
      const p = x.po;
      d.dlg.querySelector('h2').textContent = `${p.number} · ${p.vendor}`;
      const trail = S.modules && !S.modules.includes('edi') ? null : await coApi(`/edi/pos/${id}/trail`).catch(() => null);
      const open = p.status === 'open';
      const total = x.lines.reduce((a, l) => a + (Number(l.quantity) - Number(l.cancelled_qty)) * Number(l.unit_price_minor), 0);
      const landed = x.lines.reduce((a, l) => a + Number(l.landed_minor), 0);
      const cancel = el('button', { class: 'btn small', type: 'button', onclick: async () => {
        const why = await askReason({ title: `Cancel ${p.number}`, label: 'Why', confirm: 'Cancel the order', lead: 'The goods come off order and the budget comes back. Customer lines on it go back to the special-order queue.' });
        if (why) act(cancel, () => post(`/purchasing/pos/${id}/cancel`, { reason: why }), 'Order cancelled', { close: d.close });
      } }, 'Cancel order');
      const send = el('button', { class: 'btn small', type: 'button', onclick: () => openSend(p, again) }, 'Send to vendor');
      return frag(
        el('div', { class: 'toolbar' }, chip(...STAT[p.status]), p.acknowledged_on ? chip('good', 'ok', `Confirmed ${shortDay(p.acknowledged_on)}`) : null, el('span', { class: 'grow' }),
          open ? el('button', { class: 'btn small primary', type: 'button', onclick: () => openAck(x, again) }, 'Vendor confirmed…') : null,
          open ? el('button', { class: 'btn small', type: 'button', onclick: () => openLanded(x, again) }, 'Freight / landed cost') : null,
          open ? send : null, open ? cancel : null),
        p.cancel_reason ? resultBox('neutral', 'info', 'Cancelled', p.cancel_reason) : null,
        p.over_budget_reason ? resultBox('warning', 'warn', 'Placed over budget', p.over_budget_reason) : null,
        el('div', { class: 'panel' }, el('div', { class: 'facts' },
          fact('Ship to', `${p.ship_to} (${p.ship_to_code})`), fact('Kind', p.kind === 'special' ? 'Special order' : 'Stock'), fact('Ordered', shortDay(p.ordered_on)),
          fact('Expected', p.expected_on ? shortDay(p.expected_on) : '—'), fact('Vendor reference', p.vendor_ref || '—'), fact('Total at cost', money(total)),
          fact('Landed cost added', money(landed)), fact('Sent to vendor', p.exported_at ? shortDay(String(p.exported_at).slice(0, 10)) : 'Not yet'), fact('Placed by', p.created_by_name || '—'))),
        section('Lines', `${x.lines.length}`, null, el('div', { class: 'panel' }, x.lines.map((l) => {
          const openQty = Number(l.quantity) - Number(l.cancelled_qty) - Number(l.received);
          return item({ title: `${l.seq}. ${l.description}`, amount: money((Number(l.quantity) - Number(l.cancelled_qty)) * Number(l.unit_price_minor)),
            badge: chip(...ACK[l.ack_status]),
            detail: [`${Number(l.quantity)} ordered`, Number(l.cancelled_qty) ? `${Number(l.cancelled_qty)} cut` : null, Number(l.received) ? `${Number(l.received)} received` : null,
              `${openQty} open`, `${money(l.unit_price_minor)} each`, Number(l.landed_minor) ? `+ ${money(l.landed_minor)} landed` : null,
              l.expected_on ? `due ${shortDay(l.expected_on)}` : null, l.sku].filter(Boolean).join(' · '),
            why: l.customers && l.customers.length ? `For ${l.customers.map((c) => `${c.customer || 'a customer'} (${c.order})`).join(', ')}; their order shows this date.` : null });
        }))),
        x.sent.length ? section('Sent to vendor', `${x.sent.length}`, null, el('div', { class: 'panel' }, x.sent.map((t) => item({
          title: `${cap(t.method)} · ${t.destination || ''}`, badge: chip(t.status === 'sent' ? 'good' : t.status === 'prepared' ? 'neutral' : 'critical', t.status === 'failed' ? 'fail' : 'ok', cap(t.status)),
          detail: [t.detail, t.vendor_ref ? `their ref ${t.vendor_ref}` : null, t.by_name, shortDay(String(t.sent_at).slice(0, 10))].filter(Boolean).join(' · ') })))) : null,
        trail ? trailSection(trail) : null,
        x.landed.length ? section('Landed cost', null, null, el('div', { class: 'panel' }, x.landed.map((c) => item({
          title: cap(c.kind), amount: money(c.amount_minor), detail: [`spread by ${c.basis === 'qty' ? 'quantity' : c.basis}`, c.note, c.by_name].filter(Boolean).join(' · ') })))) : null);
    });
  }

  /** The PO's EDI and API trail: the 850 out, the vendor's 997, 855, 856 and 810, and the ship notices. */
  const TRAIL_NAMES = { '850': 'Purchase order', '855': 'Acknowledgment', '856': 'Ship notice', '810': 'Invoice', '997': 'Functional ack' };
  const TRAIL_TONE = { sent: 'good', applied: 'good', acknowledged: 'good', queued: 'neutral', received: 'neutral', quarantined: 'serious', failed: 'critical', rejected: 'critical', ignored: 'neutral' };
  function trailSection(t) {
    const docs = t.documents || [], ships = t.shipments || [];
    if (!docs.length && !ships.length) return null;
    return section('EDI and API trail', `${docs.length + ships.length}`, null, el('div', { class: 'panel' },
      docs.map((x) => item({ title: `${x.direction === 'out' ? 'Sent' : 'Received'} ${x.doc_type} · ${TRAIL_NAMES[x.doc_type] || x.doc_type}${x.channel === 'api' ? ' (API)' : ''}`,
        badge: chip(TRAIL_TONE[x.status] || 'neutral', ['quarantined', 'failed', 'rejected'].includes(x.status) ? 'warn' : 'ok', cap(x.status)),
        detail: [x.isa_control ? `ISA ${x.isa_control}` : null, x.bill_reference ? `bill ${x.bill_reference} (${x.bill_status})` : null, shortDay(String(x.created_at).slice(0, 10))].filter(Boolean).join(' · '),
        why: x.reason || (x.summary && x.summary.applied) || null, onClick: () => go('edi', x.direction === 'in' ? 'inbox' : 'outbox') })),
      ships.map((sh) => item({ title: `Ship notice ${sh.asn_number}`, badge: chip(sh.status === 'in_transit' ? 'warning' : 'good', sh.status === 'in_transit' ? 'clock' : 'ok', sh.status === 'in_transit' ? 'In transit' : cap(sh.status)),
        detail: [sh.carrier, sh.tracking ? `tracking ${sh.tracking}` : null, sh.shipped_on ? `shipped ${shortDay(sh.shipped_on)}` : null, sh.expected_on ? `due ${shortDay(sh.expected_on)}` : null,
          (sh.lines || []).map((l) => `line ${l.seq}: ${Number(l.qty)}`).join(', ')].filter(Boolean).join(' · ') }))));
  }

  function openSend(p, done) {
    const d = openDialog(`Send ${p.number}`, p.vendor);
    const how = select([['partner', 'The vendor’s own channel (EDI 850 or its order API, from Vendor EDI)'], ['email', `Email to ${p.order_email || 'the vendor (no address on file)'}`],
      ['file', 'Download the order file (850-style CSV)'], ['api', 'The vendor’s order API']], S.modules && !S.modules.includes('edi') ? (p.order_email ? 'email' : 'file') : 'partner');
    const err = el('div');
    const go_ = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go_, async () => {
      const r = how.value === 'partner' ? await post(`/edi/pos/${p.id}/send`, {}) : await post(`/purchasing/pos/${p.id}/send`, { method: how.value });
      if (r.file && (how.value === 'file' || r.status === 'prepared')) download(r.file.filename, r.file.csv);
      if (r.status === 'failed') throw new Error(r.detail);
      return r;
    }, (r) => `${cap(r.status)}: ${r.detail}`, { errorInto: errInto(err), close: () => { d.close(); done(); } }) }, 'Send');
    d.body.append(el('p', { class: 'lead', text: 'Every attempt is logged on the order, including failures. The vendor’s acknowledgment comes back through Vendor files.' }),
      field('How', how), el('div', { class: 'dlg-acts' }, go_), err);
  }

  function openAck(x, done) {
    const d = openDialog(`Vendor confirmed ${x.po.number}`, 'Each line’s answer and date; dates flow to customer orders', { wide: true });
    const ref = input({ placeholder: 'Their order or ack number', value: x.po.vendor_ref || '' });
    const all = input({ type: 'date' });
    const rows = x.lines.filter((l) => Number(l.quantity) > Number(l.cancelled_qty) && l.ack_status !== 'rejected').map((l) => {
      const st = select([['accepted', 'Confirmed'], ['backordered', 'Backordered'], ['changed', 'Fewer than ordered'], ['rejected', 'Rejected']], l.ack_status === 'pending' ? 'accepted' : l.ack_status);
      const date = input({ type: 'date', value: l.expected_on || '' }), qty = input({ type: 'number', min: '0', value: Number(l.quantity) - Number(l.cancelled_qty), inputmode: 'numeric' });
      const fq = field('Quantity they will ship', qty);
      const sync = () => { fq.hidden = st.value !== 'changed'; };
      st.onchange = sync; sync();
      return { node: el('div', { class: 'po-ack' }, el('div', { class: 't', text: `${l.seq}. ${l.description}` }), field('Answer', st), field('Ship date', date), fq),
        read: () => ({ lineId: l.id, status: st.value, expectedOn: date.value || all.value || null, qty: st.value === 'changed' ? qty.value : null }) };
    });
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post(`/purchasing/pos/${x.po.id}/ack`, { vendorRef: ref.value, expectedOn: all.value || null, lines: rows.map((r) => r.read()) }),
      'Acknowledgment recorded', { errorInto: errInto(err), close: () => { d.close(); done(); } }) }, 'Record');
    d.body.append(el('div', { class: 'form-grid' }, field('Vendor reference', ref), field('Ship date for every line', all, 'Or set each line below')), rows.map((r) => r.node),
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  function openLanded(x, done) {
    const d = openDialog(`Landed cost on ${x.po.number}`, 'Spread over the open lines, recorded on the PO for receiving to value');
    const kind = select([['freight', 'Freight'], ['duty', 'Duty'], ['fuel', 'Fuel surcharge'], ['other', 'Other']], 'freight');
    const amt = input({ inputmode: 'decimal', placeholder: '0.00' }), basis = select([['value', 'By value'], ['qty', 'By quantity'], ['cube', 'By cube']], 'value');
    const note = input({ placeholder: 'Carrier invoice 4471' });
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post(`/purchasing/pos/${x.po.id}/landed`, { kind: kind.value, amount: amt.value, basis: basis.value, note: note.value }),
      'Landed cost added', { errorInto: errInto(err), close: () => { d.close(); done(); } }) }, 'Add');
    d.body.append(el('div', { class: 'form-grid' }, field('Kind', kind), field('Amount ($)', amt), field('Spread', basis), field('Note', note)),
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  // --------------------------------------------------------------- budgets
  let BM = '';
  async function tabBudgets() {
    const d = await coApi(`/purchasing/budgets?month=${BM || thisMonth()}`);
    const mIn = input({ type: 'month', value: d.month.slice(0, 7), 'aria-label': 'Month' });
    mIn.onchange = () => { BM = mIn.value; render(); };
    const byLoc = {};
    for (const r of d.rows) (byLoc[r.location] = byLoc[r.location] || []).push(r);
    const sum = (k) => d.rows.reduce((a, r) => a + Number(r[k]), 0);
    return frag(
      el('div', { class: 'po-tb' }, mIn, el('button', { class: 'btn', type: 'button', onclick: () => openBudget(d) }, icon('plus'), 'Set a budget'), el('div')),
      tilesRow(tile({ label: 'Budget', value: money(sum('budget_minor')), tone: 'neutral', ic: 'info', text: 'Planned buying for the month' }),
        tile({ label: 'Committed', value: money(sum('committed_minor')), tone: 'neutral', ic: 'file', text: 'On open stock POs due this month' }),
        tile({ label: 'Open to buy', value: money(sum('open_minor')), tone: sum('open_minor') < 0 ? 'critical' : 'good', ic: sum('open_minor') < 0 ? 'warn' : 'ok', text: 'Placing a PO takes it; cancelling gives it back' })),
      Object.keys(byLoc).length ? Object.entries(byLoc).map(([loc, rs]) => section(loc, null, null, el('div', { class: 'panel' }, rs.map((r) => {
        const used = Number(r.budget_minor) ? Math.round((Number(r.committed_minor) / Number(r.budget_minor)) * 100) : 100;
        return el('div', { class: 'li' }, el('div', { class: 't', text: r.category }), el('div', { class: 'amt', text: money(r.open_minor) }),
          el('div', { class: 'd' }, `${money(r.committed_minor)} committed of ${money(r.budget_minor)}`,
            el('div', { class: 'po-meter' + (used > 100 ? ' over' : '') }, meterBar(Math.min(100, used)))));
      }))))
        : section('Budgets', null, null, el('div', { class: 'panel' }, empty('No budgets for this month.', 'The owner sets one per category and place; stock POs then spend it.', true))),
      el('p', { class: 'foot', text: 'Special orders are bought against a customer’s sale, so they do not spend open-to-buy. Only the owner sets budgets or places a PO over one, and says why.' }));
  }

  function openBudget(d) {
    const dl = openDialog('Set a budget', 'Owner only');
    const month = input({ type: 'month', value: d.month.slice(0, 7) });
    const cat = input({ list: 'po-cats', placeholder: 'Living room' }), loc = select(d.locations.map((l) => [l.id, l.name]));
    const amt = input({ inputmode: 'decimal', placeholder: '15000.00' });
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post('/purchasing/budgets', { month: month.value, category: cat.value, locationId: loc.value, budget: amt.value }),
      'Budget set', { errorInto: errInto(err), close: dl.close }) }, 'Save');
    dl.body.append(el('datalist', { id: 'po-cats' }, d.categories.map((c) => el('option', { value: c }))),
      el('div', { class: 'form-grid' }, field('Month', month), field('Place', loc), field('Category', cat), field('Budget ($)', amt)),
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => dl.close() }, 'Cancel')), err);
  }

  // ---------------------------------------------------------------- reorder
  async function tabReorder() {
    const [s, rules] = [await coApi('/purchasing/replenishment'), await coApi('/purchasing/reorder-rules')];
    const picked = new Set(s.suggestions.map((x) => `${x.product_id}|${x.location_id}`));
    const qty = {};
    const order = el('button', { class: 'btn primary', type: 'button', onclick: () => act(order, async () => {
      const lines = s.suggestions.filter((x) => picked.has(`${x.product_id}|${x.location_id}`))
        .map((x) => ({ productId: x.product_id, locationId: x.location_id, qty: Number(qty[`${x.product_id}|${x.location_id}`].value) }));
      const r = await post('/purchasing/order-form', { lines });
      warnBox(r);
      return r;
    }, placedToast) }, 'Order selected');
    const rows = s.suggestions.map((x) => {
      const k = `${x.product_id}|${x.location_id}`;
      qty[k] = input({ type: 'number', min: '1', value: x.suggest, inputmode: 'numeric', class: 'qty-in', 'aria-label': `Quantity of ${x.name}` });
      const box = el('input', { type: 'checkbox', class: 'pickbox', checked: true, 'aria-label': `Order ${x.name}`, onchange: (e) => { if (e.target.checked) picked.add(k); else picked.delete(k); } });
      return item({ pick: box, title: `${x.name} → ${x.location}`, amount: `${x.suggest} to buy`,
        detail: `${x.sku} · ${x.vendor} · ${Number(x.available)} available + ${Number(x.on_order)} on order − ${Number(x.backordered)} waiting = ${x.projected}; min ${Number(x.min_qty)}, max ${Number(x.max_qty)}`,
        acts: [el('label', { class: 'field inline' }, el('span', { text: 'Order' }), qty[k])] });
    });
    return frag(
      section('Suggestions', `${s.suggestions.length}`, null, el('div', { class: 'panel' }, rows.length ? rows : empty('Nothing at or under its minimum.', 'Stock, plus what is on order, less customers waiting, is above every reorder point.'))),
      rows.length ? el('div', { class: 'dlg-acts' }, order) : null,
      section('Reorder points', `${rules.rules.length}`, [el('button', { class: 'btn small', type: 'button', onclick: () => openRule(null) }, icon('plus'), 'Reorder point')],
        el('div', { class: 'panel' }, rules.rules.length ? capped(rules.rules.map((r) => item({ title: `${r.name} · ${r.location}`, amount: `${Number(r.min_qty)} / ${Number(r.max_qty)}`,
          detail: `${r.sku}${r.active ? '' : ' · off'}`, onClick: () => openRule(r) })), 15, 'points') : empty('No reorder points.', null, true))));
  }

  async function openRule(r) {
    const d = openDialog(r ? `${r.name} · ${r.location}` : 'New reorder point', 'At or under the minimum, buy up to the maximum');
    const prods = (await coApi('/catalog/products?kind=stock&status=active&limit=200')).items;
    const fo = await coApi('/purchasing/budgets');
    const prod = select(prods.map((p) => [p.id, `${p.name} · ${p.sku}`]), r && r.product_id), loc = select(fo.locations.map((l) => [l.id, l.name]), r && r.location_id);
    const min = input({ type: 'number', min: '0', value: r ? Number(r.min_qty) : '' }), max = input({ type: 'number', min: '1', value: r ? Number(r.max_qty) : '' });
    const on = el('input', { type: 'checkbox', checked: !r || r.active });
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post('/purchasing/reorder-rules', { productId: prod.value, locationId: loc.value, min: min.value, max: max.value, active: on.checked }),
      'Reorder point saved', { errorInto: errInto(err), close: d.close }) }, 'Save');
    d.body.append(el('div', { class: 'form-grid' }, field('Product', prod, null, true), field('Place', loc, null, true), field('Minimum', min), field('Maximum', max),
      el('label', { class: 'check wide' }, on, 'On')), el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  // ------------------------------------------------------------ vendor files
  async function tabFiles() {
    const [runs, fo] = [await coApi('/purchasing/ack-runs'), await coApi('/purchasing/order-form')];
    const vSel = select(fo.vendors.map((v) => [v.id, v.name]), fo.vendor && fo.vendor.id);
    const onlyNew = el('input', { type: 'checkbox', checked: true });
    const exp = el('button', { class: 'btn primary', type: 'button', onclick: () => act(exp, async () => {
      const r = await post('/purchasing/export', { vendorId: vSel.value, onlyNew: onlyNew.checked });
      if (!r.lines) throw new Error(onlyNew.checked ? 'Every open order for that vendor has been sent already' : 'That vendor has no open orders');
      download(r.filename, r.csv);
      return r;
    }, (r) => `${plural(r.orders, 'order')}, ${plural(r.lines, 'line')} in ${r.filename}${r.orderEmail ? `; send to ${r.orderEmail}` : ''}`) }, 'Download orders');
    const file = el('input', { type: 'file', accept: '.csv,text/csv' });
    const out = el('div');
    const imp = el('button', { class: 'btn primary', type: 'button', onclick: async () => {
      const f = file.files[0];
      if (!f) { toast('Choose the vendor’s file first.', 'warning'); return; }
      E.busy(imp, true, 'Importing…');
      try {
        const r = await post('/purchasing/acks/import', { csv: await f.text(), filename: f.name });
        out.replaceChildren(resultBox(r.problems.length ? 'warning' : 'good', r.problems.length ? 'warn' : 'ok', `${r.applied} of ${r.rows} rows applied`,
          r.problems.length ? r.problems.map((p) => `Row ${p.row}: ${p.message}`).join(' · ') : 'Dates are on the POs and the customers’ orders.'));
      } catch (e) { out.replaceChildren(resultBox('critical', 'fail', 'Not imported', friendly(e))); }
      finally { E.busy(imp, false); }
    } }, 'Import acknowledgments');
    return frag(
      section('Send orders (850-style CSV)', null, null, el('div', { class: 'panel pad' },
        el('div', { class: 'form-grid' }, field('Vendor', vSel), el('label', { class: 'check' }, onlyNew, 'Only orders not sent before')),
        el('p', { class: 'foot', text: 'One row per open line: PO, ship-to, requested date, vendor model, our SKU, UPC, option codes, quantity and cost. A resend is marked purpose 05.' }), exp)),
      section('Vendor acknowledgments (855-style CSV)', null, null, el('div', { class: 'panel pad' },
        field('File', file, 'Columns: po_number, line or vendor_sku, status (accept / backorder / change / reject, or IA IB IC IR), qty, ship_date, vendor_ref'), imp, out)),
      section('Past imports', `${runs.runs.length}`, null, el('div', { class: 'panel' }, runs.runs.length ? capped(runs.runs.map((r) => item({
        title: r.filename || 'acknowledgment file', amount: `${r.applied}/${r.rows}`, detail: [r.by_name, shortDay(String(r.created_at).slice(0, 10))].filter(Boolean).join(' · '),
        why: r.problems.length ? r.problems.slice(0, 4).map((p) => `Row ${p.row}: ${p.message}`).join(' · ') : null })), 8, 'files') : empty('None yet.', null, true))));
  }

  E.register('purchasing', 'Buying', 'cart', screen, 'Retail', { icon: 'M3 4h2.5l2.2 11h10.6l2-8H7|C9.5 19 1.3|C17 19 1.3' });
})();
