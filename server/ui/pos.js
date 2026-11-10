// Point-of-sale screens: the selling screen (tablet first), orders and quotes,
// the register drawer with its Z report, and a printable e-receipt.
(() => {
  'use strict';
  const E = window.ERP;
  if (!E) return;
  const { el, frag, section, head, item, chip, money, openDialog, fillDialog, post, coApi, toast, seg, empty, resultBox,
    tilesRow, tile, plural, dayLabel, shortDay, ago, busy, friendly, go, S, fact, todayIso } = E;

  const TABS = [['sell', 'Sell'], ['orders', 'Orders'], ['register', 'Register']];
  const words = (s) => String(s || '').replace(/_/g, ' ');
  const FUL = { carry: 'Take with', pickup: 'Pickup', delivery: 'Delivery', ship: 'Direct ship' };
  const TENDER = { cash: 'Cash', card: 'Card', check: 'Check', financing: 'Financing', gift_card: 'Gift card', store_credit: 'Store credit' };
  const TONE = { draft: 'neutral', open: 'warning', fulfilling: 'warning', fulfilled: 'good', closed: 'good', cancelled: 'neutral',
    reserved: 'good', on_order: 'warning', returned: 'neutral', ready: 'good' };
  const statusChip = (s) => chip(TONE[s] || 'neutral', s === 'fulfilled' || s === 'reserved' ? 'ok' : 'info', words(s));
  const field = (label, input, opts = {}) => el('label', { class: 'field' + (opts.wide ? ' wide' : '') }, el('span', { text: label }), input, opts.hint ? el('span', { class: 'hint', text: opts.hint }) : null);
  const select = (options, value, placeholder) => el('select', {}, placeholder ? el('option', { value: '', text: placeholder }) : null,
    options.map(([v, t]) => el('option', { value: v, text: t, selected: v === value || null })));
  const input = (attrs) => el('input', Object.assign({ type: 'text' }, attrs));
  const outBox = () => el('div', { role: 'status', 'aria-live': 'polite' });
  const pad = (node) => { node.style.padding = '4px 16px 14px'; return node; };
  const dollars = (m) => (Number(m || 0) / 100).toFixed(2);
  const fullDay = (d) => { const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  const isManager = (setup) => setup.roles.includes('owner') || setup.roles.includes('store_manager');

  /** Open delivery windows for an address and the goods going on the truck; a full or locked window cannot be picked. */
  function pickDayDialog({ addressId, items, sub, onPick }) {
    const d = openDialog('Pick delivery day', sub || '');
    fillDialog(d, async () => {
      const a = await coApi(`/fleet/availability?address=${encodeURIComponent(addressId)}&items=${encodeURIComponent(items || '')}&days=21`);
      const byDay = new Map();
      for (const x of a.slots) { if (!byDay.has(x.day)) byDay.set(x.day, []); byDay.get(x.day).push(x); }
      const anyOpen = a.slots.some((x) => x.fits && !x.locked);
      const days = [...byDay.entries()].map(([day, list]) => el('div', { class: 'field' },
        el('span', { text: `${dayLabel(day)}${list.some((x) => x.locked) ? ' · locked by the delivery manager' : ''}` }),
        el('div', { class: 'toolbar' }, list.map((x) => {
          const ok = x.fits && !x.locked;
          const left = x.caps.stops != null ? `${Math.max(x.caps.stops - x.used.stops, 0)} left` : 'open';
          const b = el('button', { class: 'btn', type: 'button', disabled: !ok || null, onclick: () => { d.close(); onPick(x, a.zone.name); } },
            el('b', { text: x.label }), el('span', { class: 'sub', text: x.locked ? 'locked' : x.fits ? left : 'full' }));
          b.style.minHeight = '48px';
          return b;
        }))));
      return frag(el('p', { class: 'lead', text: `${a.zone.name} · ${plural(a.size.pieces, 'piece')} · about ${a.size.labor} crew minutes at the door.` }),
        anyOpen ? null : empty('No open windows', 'Every window in the next three weeks is full, locked or closed. Ask the delivery manager.', true), ...days);
    });
  }

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
    } finally { if (btn && btn.isConnected) busy(btn, false); }
  }

  // The drawer this device rings into, remembered per company.
  const sessKey = () => `erp.pos.session.${S.co.id}`;
  const getSess = () => { try { return localStorage.getItem(sessKey()) || ''; } catch (_) { return ''; } };
  const setSess = (v) => { try { localStorage.setItem(sessKey(), v); } catch (_) { /* private mode */ } };

  // The cart lives in memory while the screen is open.
  let cart = null;
  const newCart = () => ({ kind: 'sale', customer: null, addressId: '', promisedOn: '', delivery: null, lines: [], primary: S.person ? S.person.id : '', second: '', secondPct: 50,
    taxExemptRef: '', notes: '', overrideReason: '', hold: false });

  async function screen(sub) {
    if (sub && sub.startsWith('receipt-')) return receiptPage(sub.slice(8));
    const setup = await coApi('/pos/setup');
    const tab = TABS.some(([k]) => k === sub) ? sub : 'sell';
    const body = await ({ sell: sellTab, orders: ordersTab, register: registerTab })[tab](setup);
    return frag(head('Point of sale', [], `${S.co.name} · ${S.person ? S.person.name : 'nobody'}`),
      el('div', { class: 'toolbar' }, seg(TABS, tab, (v) => go('pos', v))), body);
  }

  // ================================================================== sell
  async function sellTab(setup) {
    if (!cart) cart = newCart();
    // ---- delivery day: the salesperson books it here; the delivery manager confirms and locks it
    const delBox = el('div');
    const hasDelivery = () => cart.lines.some((l) => l.fulfillment === 'delivery' && !l.isFee);
    function drawDelivery() {
      if (!hasDelivery()) { cart.delivery = null; delBox.replaceChildren(); return; }
      const pick = el('button', { class: 'btn' + (cart.delivery ? '' : ' primary'), type: 'button', onclick: () => deliveryDialog() },
        cart.delivery ? 'Change day' : 'Pick delivery day');
      delBox.replaceChildren(el('div', { class: 'panel' }, item({
        title: cart.delivery ? `${dayLabel(cart.delivery.day)} · ${cart.delivery.label}` : 'No delivery day yet',
        detail: !cart.customer ? 'Pick the customer first.' : !cart.addressId ? 'Add the customer’s delivery address first.'
          : cart.delivery ? `${cart.delivery.zone} · booked when the sale is placed; the delivery manager confirms it`
          : 'Pick a day with room while the customer is here.',
        badge: cart.delivery ? chip('good', 'ok', 'Picked') : chip('warning', 'clock', 'To pick'),
        acts: cart.addressId ? [pick, cart.delivery ? el('button', { class: 'btn small', type: 'button', onclick: () => { cart.delivery = null; drawDelivery(); } }, 'Clear') : null].filter(Boolean) : null })));
    }
    function deliveryDialog() {
      const items = cart.lines.filter((l) => l.fulfillment === 'delivery').map((l) => `${l.productId}:${l.qty}`).join(',');
      pickDayDialog({ addressId: cart.addressId, items, sub: cart.customer ? cart.customer.name : '', onPick: (x, zone) => {
        cart.delivery = { day: x.day, windowId: x.windowId, label: x.label, zone }; cart.promisedOn = x.day; drawDelivery(); E.render(); } });
    }
    const open = setup.registers.filter((r) => r.session_id);
    if (!open.length) return section('No register is open', null, null, el('div', { class: 'panel' },
      empty('Open a register first.', 'Payments go into a drawer session, so a cashier or manager opens one on the Register tab.', true),
      pad(el('div', { class: 'dlg-acts' }, el('button', { class: 'btn primary', type: 'button', onclick: () => go('pos', 'register') }, 'Open a register')))));
    let sess = open.find((r) => r.session_id === getSess()) || open[0];
    setSess(sess.session_id);
    const sessSel = select(open.map((r) => [r.session_id, `${r.name} · ${r.session_number}`]), sess.session_id);
    sessSel.addEventListener('change', () => { setSess(sessSel.value); E.render(); });
    const store = setup.stores.find((s) => s.id === sess.location_id) || {};

    // ---- customer
    const custBox = el('div', { class: 'panel' });
    const drawCustomer = () => {
      if (cart.customer) {
        const c = cart.customer;
        const projBox = el('div');
        const addr = select((c.addresses || []).map((a) => [a.id, `${a.label}: ${a.line1}, ${a.city} ${a.state}`]), cart.addressId || ((c.addresses || [])[0] || {}).id || '', 'No address');
        if (cart.addressId !== addr.value) cart.delivery = null;
        cart.addressId = addr.value;
        drawDelivery();
        addr.addEventListener('change', () => { cart.addressId = addr.value; cart.delivery = null; drawDelivery(); });
        // Exempt only under a current certificate on file: picked, never typed.
        const certs = c.certificates || [];
        if (cart.taxExemptRef && !certs.some((x) => x.number === cart.taxExemptRef)) cart.taxExemptRef = '';
        const exempt = select(certs.map((x) => [x.number, `${x.number} · ${x.state} · ${words(x.reason)}${x.expiresOn ? ` · until ${fullDay(x.expiresOn)}` : ''}`]), cart.taxExemptRef, 'Not exempt');
        exempt.addEventListener('change', () => { cart.taxExemptRef = exempt.value; });
        custBox.replaceChildren(item({ title: c.name, detail: [c.number, c.phone, c.email].filter(Boolean).join(' · '),
          acts: [el('button', { class: 'btn small', type: 'button', onclick: () => { cart.customer = null; cart.addressId = ''; cart.taxExemptRef = ''; drawCustomer(); } }, 'Change')] }),
          pad(el('div', { class: 'form-grid' }, field('Deliver to', addr), field('Tax exempt', exempt, { hint: certs.length ? 'Current certificates on file.' : 'Needs a current certificate on file.' }),
            el('div', { class: 'toolbar' }, el('button', { class: 'btn small', type: 'button', onclick: () => addressDialog(c, drawCustomer) }, 'Add an address'),
              el('button', { class: 'btn small', type: 'button', onclick: () => certificateDialog(c, drawCustomer) }, 'Add a certificate')))),
          projBox);
        // The customer's room projects (trade module), so the salesperson sees what they are planning.
        if (E.trade) E.trade.projectsCard(c).then((n) => { if (n && projBox.isConnected) projBox.replaceChildren(n); });
      } else {
        const q = input({ placeholder: 'Name, phone or email', inputmode: 'search', 'aria-label': 'Find a customer' });
        const res = el('div');
        let t = 0;
        q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
          if (q.value.trim().length < 2) { res.replaceChildren(); return; }
          try {
            const rows = await coApi(`/pos/customers?q=${encodeURIComponent(q.value.trim())}`);
            res.replaceChildren(...(rows.length ? rows.map((c) => item({ title: c.name, detail: [c.number, c.phone, c.email].filter(Boolean).join(' · '),
              onClick: () => { cart.customer = c; cart.taxExemptRef = ((c.certificates || [])[0] || {}).number || ''; drawCustomer(); } })) : [empty('No one by that.', null, true)]));
          } catch (e) { res.replaceChildren(E.errorBox(e)); }
        }, 250); });
        custBox.replaceChildren(pad(el('div', {}, el('div', { class: 'toolbar' }, el('div', { class: 'grow' }, q),
          el('button', { class: 'btn small', type: 'button', onclick: () => customerDialog(store, (c) => { cart.customer = c; drawCustomer(); }) }, 'New customer')),
          el('p', { class: 'sub', text: 'Cash-and-carry can go without a customer. Delivery, quotes, layaway and store credit need one.' }))), res);
      }
    };
    drawCustomer();

    // ---- products
    const pq = input({ placeholder: 'Search the catalog', inputmode: 'search', 'aria-label': 'Search products' });
    const pres = el('div', { class: 'panel' });
    const searchProducts = async () => {
      try {
        const rows = await coApi(`/pos/products?locationId=${sess.location_id}&q=${encodeURIComponent(pq.value.trim())}`);
        pres.replaceChildren(...(rows.length ? rows.slice(0, 12).map((p) => item({ title: p.name, amount: money(p.price_minor),
          detail: [p.sku, p.category, ['fee', 'warranty', 'service'].includes(p.kind) ? null : `${Number(p.here)} here · ${Number(p.everywhere)} everywhere`,
            Number(p.arriving) > 0 ? `${Number(p.arriving)} arriving${p.arriving_on ? ' on ' + shortDay(p.arriving_on) : ''}` : null].filter(Boolean).join(' · '),
          badge: p.configurable ? chip('neutral', 'info', 'choose options') : p.kind === 'kit' ? chip('neutral', 'info', 'package') : null,
          onClick: () => addDialog(p, store, drawCart) })) : [empty('Nothing matches.', null, true)]));
      } catch (e) { pres.replaceChildren(E.errorBox(e)); }
    };
    let pt = 0;
    pq.addEventListener('input', () => { clearTimeout(pt); pt = setTimeout(searchProducts, 250); });
    searchProducts();

    // ---- cart
    const cartBox = el('div', { class: 'panel' });
    function drawCart() {
      const rows = cart.lines.map((l, i) => item({ title: l.name, amount: money(l.estimate),
        detail: [`× ${l.qty}`, FUL[l.fulfillment], l.desc !== l.name ? l.desc : null, l.discountPct ? `${l.discountPct}% off` : null].filter(Boolean).join(' · '),
        acts: [el('button', { class: 'btn small', type: 'button', onclick: () => { cart.lines.splice(i, 1); drawCart(); } }, 'Remove')] }));
      const est = cart.lines.reduce((a, l) => a + l.estimate, 0);
      const addOn = (id, label, f) => id ? el('button', { class: 'btn small', type: 'button', onclick: async (e) => {
        const p = (await coApi(`/pos/products/${id}`));
        cart.lines.push({ productId: id, name: p.name, sku: p.sku, desc: p.name, qty: 1, choices: {}, fulfillment: f, discountPct: 0, estimate: Number(p.price_minor), isFee: true });
        drawCart(); void e;
      } }, label) : null;
      cartBox.replaceChildren(...(rows.length ? rows : [empty('The cart is empty.', 'Search above and tap a product.', true)]),
        pad(el('div', {}, el('div', { class: 'toolbar' }, addOn(setup.settings.deliveryProductId, 'Add delivery fee', 'delivery'), addOn(setup.settings.protectionProductId, 'Add protection plan', 'delivery'),
          el('span', { class: 'grow' }), el('b', { text: `${money(est)} before tax` })))));
      drawDelivery();
    }
    drawCart();

    // ---- details and save
    const kind = el('div');
    const holdBox = el('input', { type: 'checkbox', checked: cart.hold || null });
    holdBox.addEventListener('change', () => { cart.hold = holdBox.checked; });
    const holdRow = setup.settings.quoteHoldsAllowed ? el('label', { class: 'check' }, holdBox, el('span', { text: ` Hold the in-stock items for the customer (up to ${plural(setup.settings.quoteHoldMaxDays, 'day')})` })) : null;
    const drawKind = () => { kind.replaceChildren(seg([['sale', 'Sale'], ['quote', 'Quote'], ['layaway', 'Layaway']], cart.kind, (v) => { cart.kind = v; drawKind(); go2.textContent = v === 'quote' ? 'Save the quote' : 'Save and take payment'; }),
      ...(cart.kind === 'quote' && holdRow ? [holdRow] : [])); };
    const promised = input({ type: 'date', min: todayIso(), value: cart.promisedOn });
    promised.addEventListener('change', () => { cart.promisedOn = promised.value; });
    const people = setup.people.map((p) => [p.id, p.name]);
    const primary = select(people, cart.primary, 'Salesperson');
    const second = select(people, cart.second, 'No split');
    const split = input({ inputmode: 'numeric', value: String(cart.secondPct), 'aria-label': 'Second person’s share' });
    primary.addEventListener('change', () => { cart.primary = primary.value; });
    second.addEventListener('change', () => { cart.second = second.value; });
    split.addEventListener('input', () => { cart.secondPct = Number(split.value) || 0; });
    const notes = input({ value: cart.notes, maxlength: '300', placeholder: 'Anything the warehouse or driver should know' });
    notes.addEventListener('input', () => { cart.notes = notes.value; });
    const ovr = input({ value: cart.overrideReason, maxlength: '200', placeholder: 'Why the price is allowed' });
    ovr.addEventListener('input', () => { cart.overrideReason = ovr.value; });
    const out = outBox();
    const go2 = el('button', { class: 'btn primary', type: 'button', onclick: () => run(go2, out, () => post('/pos/orders', {
      kind: cart.kind, locationId: sess.location_id, sessionId: sess.session_id, customerId: cart.customer ? cart.customer.id : null,
      shipAddressId: cart.addressId || null, promisedOn: cart.promisedOn || null,
      delivery: cart.delivery ? { day: cart.delivery.day, windowId: cart.delivery.windowId } : null, taxExemptRef: cart.taxExemptRef || null, notes: cart.notes, overrideReason: cart.overrideReason || undefined,
      salespeople: cart.second && cart.second !== cart.primary ? [{ id: cart.primary, splitPct: 100 - cart.secondPct }, { id: cart.second, splitPct: cart.secondPct }] : cart.primary ? [{ id: cart.primary, splitPct: 100 }] : [],
      lines: cart.lines.map((l) => ({ productId: l.productId, qty: l.qty, choices: l.choices, fulfillment: l.fulfillment, discountPct: l.discountPct || undefined })) }),
      null, async (r) => {
        const k = cart.kind, hold = cart.hold;
        if (k === 'quote' && hold) {
          try { const h = await post(`/pos/orders/${r.id}/hold`, {}); toast(`Holding ${plural(h.linesHeld, 'line')} until ${shortDay(h.heldUntil)}.`, 'good'); }
          catch (e) { toast(`The quote is saved, but nothing is held: ${friendly(e)}`, 'warning'); }
        }
        if (r.taxNotes && r.taxNotes.length) toast(r.taxNotes.join(' '), 'warning');
        cart = newCart(); E.render(); openOrder(r.id, k !== 'quote' && !r.pendingOverrides.length ? 'checkout' : null); }) },
      cart.kind === 'quote' ? 'Save the quote' : 'Save and take payment');
    drawKind();
    return frag(
      section('Register', store.name ? `${store.name}, tax ${(store.tax_rate_bps / 100).toFixed(2)}%` : null, null, el('div', { class: 'toolbar' }, el('div', { class: 'grow' }, sessSel))),
      el('div', { class: 'two' },
        el('div', {}, section('Customer', null, null, custBox), section('Add items', null, null, el('div', { class: 'toolbar' }, el('div', { class: 'grow' }, pq)), pres)),
        el('div', {}, section('Cart', null, null, cartBox), section('Delivery', null, null, delBox),
          section('Details', null, null, el('div', { class: 'panel' }, pad(el('div', {}, kind,
            el('div', { class: 'form-grid' }, field('Promised date', promised, { hint: 'Delivery and pickup.' }), field('Salesperson', primary),
              field('Split with', second), field('Their share %', split), isManager(setup) ? field('Override reason', ovr, { wide: true, hint: 'Fill in to allow a discount past the limit or a price below cost yourself.' }) : null,
              field('Notes', notes, { wide: true })),
            el('div', { class: 'dlg-acts' }, go2, el('button', { class: 'btn', type: 'button', onclick: () => { cart = newCart(); E.render(); } }, 'Clear')), out)))))));
  }

  function addDialog(p, store, after) {
    const d = openDialog(p.name, `${p.sku} · ${money(p.price_minor)}`);
    fillDialog(d, async () => {
      const full = await coApi(`/pos/products/${p.id}`);
      const pickers = (full.groups || []).map((g) => ({ g, sel: select((g.options || []).map((o) => [o.code, `${o.label}${Number(o.delta) ? ` (${Number(o.delta) > 0 ? '+' : ''}${money(o.delta)})` : ''}${o.leadDays ? ` · ${o.leadDays} days` : ''}`]), '', g.required ? `Choose ${g.label.toLowerCase()}` : 'None') }));
      const qty = input({ inputmode: 'numeric', value: '1' });
      const stocked = ['stock', 'configurable', 'special_order', 'kit'].includes(p.kind);
      const ful = select(Object.entries(FUL).filter(([k]) => stocked || k !== 'ship'), p.kind === 'fee' ? 'delivery' : p.kind === 'stock' && Number(p.here) > 0 && p.ship_class === 'carry' ? 'carry'
        : p.kind === 'stock' && Number(p.here) > 0 ? 'carry' : 'delivery');
      const disc = input({ inputmode: 'decimal', placeholder: '0' });
      const price = el('b', { text: money(p.price_minor) });
      let desc = p.name, unit = Number(p.price_minor);
      const reprice = async () => {
        const choices = {};
        for (const x of pickers) if (x.sel.value) choices[x.g.code] = x.sel.value;
        try { const r = await post('/pos/price', { productId: p.id, choices }); unit = Number(r.unitPriceMinor); desc = r.description; price.textContent = money(unit) + (r.leadDays ? ` · ${r.leadDays} days lead` : ''); }
        catch (e) { price.textContent = friendly(e); }
        return choices;
      };
      pickers.forEach((x) => x.sel.addEventListener('change', reprice));
      const add = el('button', { class: 'btn primary', type: 'button', onclick: async () => {
        const choices = await reprice();
        const n = Number(qty.value) || 1, pct = Number(disc.value) || 0;
        cart.lines.push({ productId: p.id, name: p.name, sku: p.sku, desc, qty: n, choices, fulfillment: ful.value, discountPct: pct, estimate: Math.round(unit * n * (1 - pct / 100)) });
        d.close(); after();
      } }, 'Add to cart');
      return frag(el('p', { class: 'lead', text: stocked ? `${Number(p.here)} free here at ${store.name || 'this store'}, ${Number(p.everywhere)} across every location.` : '' }),
        el('div', { class: 'form-grid' }, pickers.map((x) => field(x.g.label, x.sel)), field('Quantity', qty), field('How it goes', ful), field('Discount %', disc, { hint: 'Past the limit needs a manager.' })),
        el('p', {}, 'Price ', price), el('div', { class: 'dlg-acts' }, add, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')));
    });
  }

  function customerDialog(store, after) {
    const d = openDialog('New customer', null);
    const name = input({ maxlength: '120' }), phone = input({ inputmode: 'tel', maxlength: '30' }), email = input({ type: 'email', maxlength: '120' });
    const line1 = input({ maxlength: '120' }), city = input({ maxlength: '60' }), state = input({ maxlength: '2', autocapitalize: 'characters' }), postal = input({ inputmode: 'numeric', maxlength: '10' });
    const kind = select([['person', 'A person'], ['business', 'A business']], 'person');
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post('/pos/customers', { name: name.value, phone: phone.value, email: email.value, kind: kind.value,
      homeLocationId: store.id, address: line1.value ? { line1: line1.value, city: city.value, state: state.value, postal: postal.value } : undefined }), null,
      async (r) => { const rows = await coApi(`/pos/customers?q=${encodeURIComponent(r.number)}`); d.close(); if (rows[0]) after(rows[0]); }) }, 'Add the customer');
    d.body.append(el('div', { class: 'form-grid' }, field('Name', name, { wide: true }), field('Phone', phone), field('Email', email), field('Kind', kind),
      field('Street', line1, { wide: true }), field('City', city), field('State', state), field('Postal code', postal)), el('div', { class: 'dlg-acts' }, b), out);
  }
  function addressDialog(c, after) {
    const d = openDialog('Add an address', c.name);
    const label = input({ value: 'Home', maxlength: '40' }), line1 = input({ maxlength: '120' }), city = input({ maxlength: '60' }), state = input({ maxlength: '2' }), postal = input({ maxlength: '10' });
    const stairs = input({ inputmode: 'numeric', value: '0' }), notes = input({ maxlength: '300', placeholder: 'Gate code, narrow hallway, call first' });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/pos/customers/${c.id}/addresses`, { label: label.value, line1: line1.value, city: city.value,
      state: state.value, postal: postal.value, stairs: stairs.value, notes: notes.value, isDefault: true }), null, async (r) => {
      c.addresses = [{ id: r.id, label: label.value, line1: line1.value, city: city.value, state: state.value.toUpperCase() }, ...(c.addresses || [])];
      cart.addressId = r.id; d.close(); after(); }) }, 'Save the address');
    d.body.append(el('div', { class: 'form-grid' }, field('Label', label), field('Street', line1, { wide: true }), field('City', city), field('State', state), field('Postal code', postal),
      field('Flights of stairs', stairs), field('Notes for the driver', notes, { wide: true })), el('div', { class: 'dlg-acts' }, b), out);
  }

  // ================================================================ orders
  let orderFilter = 'active';
  async function ordersTab() {
    const q = input({ placeholder: 'Order number, customer or phone', inputmode: 'search', 'aria-label': 'Find an order' });
    const list = el('div', { class: 'panel' }, E.loadingNode());
    const F = { active: ['', 'active'], quotes: ['quote', ''], layaway: ['layaway', ''], returns: ['return', ''], all: ['', ''] };
    const load = async () => {
      const [kind, status] = F[orderFilter];
      try {
        const rows = await coApi(`/pos/orders?kind=${kind}&status=${status}&q=${encodeURIComponent(q.value.trim())}`);
        list.replaceChildren(...(rows.length ? rows.map((o) => item({ title: `${o.number}${o.customer ? ' · ' + o.customer : ''}`, amount: money(o.total_minor),
          badge: o.overrides_waiting ? chip('warning', 'clock', 'override waiting') : statusChip(o.kind === 'quote' && o.status === 'draft' ? 'quote' : o.status),
          detail: [words(o.kind), o.channel && o.channel !== 'pos' ? `${o.channel} order` : null, o.location, Number(o.balance_minor) > 0 && o.status !== 'draft' ? `${money(o.balance_minor)} owed` : null,
            o.quote_expires_on ? `good until ${shortDay(o.quote_expires_on)}` : null, o.promised_on ? `promised ${shortDay(o.promised_on)}` : null, ago(o.ordered_at)].filter(Boolean).join(' · '),
          onClick: () => openOrder(o.id) })) : [empty('No orders here.', null, true)]));
      } catch (e) { list.replaceChildren(E.errorBox(e, load)); }
    };
    let t = 0;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    const filt = el('div');
    const drawF = () => filt.replaceChildren(seg([['active', 'Open'], ['quotes', 'Quotes'], ['layaway', 'Layaway'], ['returns', 'Returns'], ['all', 'All']], orderFilter, (v) => { orderFilter = v; drawF(); load(); }));
    drawF();
    load();
    return section('Orders', null, null, el('div', { class: 'toolbar' }, filt, el('div', { class: 'grow' }, q)), list);
  }

  function openOrder(id, next) {
    const d = openDialog('Order', null, { wide: true });
    const reload = () => fillDialog(d, async () => {
      const [o, setup] = await Promise.all([coApi(`/pos/orders/${id}`), coApi('/pos/setup')]);
      const out = outBox();
      const mgr = isManager(setup);
      const lineItems = o.lines.map((l) => item({ title: l.description, amount: money(l.net_minor),
        badge: l.needs_override ? chip('warning', 'clock', 'needs a manager') : statusChip(l.line_status),
        detail: [`${Number(l.qty)} × ${money(l.unit_price_minor)}`, Number(l.discount_minor) ? `${money(l.discount_minor)} off` : null, Number(l.tax_minor) ? `tax ${money(l.tax_minor)}` : null,
          l.role === 'item' ? FUL[l.fulfillment] : null, l.fulfil_from ? `from ${l.fulfil_from}` : null, l.promised_on ? `promised ${shortDay(l.promised_on)}` : null,
          l.override_by ? `allowed by ${l.override_by}: ${l.override_reason}` : null, l.return_reason ? `returned: ${words(l.return_reason)}` : null,
          Number(l.returned_qty) ? `${Number(l.returned_qty)} returned` : null].filter(Boolean).join(' · '),
        why: l.needs_override || null,
        acts: l.needs_override && mgr ? [el('button', { class: 'btn small primary', type: 'button', onclick: async (e) => {
          const why = await E.askReason({ title: 'Allow this price', label: 'Why it is allowed', confirm: 'Allow it' });
          if (why) run(e.currentTarget, out, () => post(`/pos/orders/${id}/override`, { lineId: l.id, reason: why }), 'Allowed.', reload);
        } }, 'Allow')] : [
          // A designer split or an outside trade referral on the line (trade module), until it is handed over.
          ...(E.trade && l.role === 'item' && Number(l.qty) > 0 && !['fulfilled', 'returned', 'cancelled'].includes(l.line_status)
            ? [el('button', { class: 'btn small', type: 'button', onclick: () => E.trade.lineCommissionDialog(l, () => reload()) }, 'Designer / referral')] : [])] }));
      const acts = [];
      const btn = (label, fn, primary) => el('button', { class: 'btn' + (primary ? ' primary' : ''), type: 'button', onclick: fn }, label);
      if (o.kind === 'quote' && o.status === 'draft') acts.push(btn('Convert to a sale', (e) => run(e.currentTarget, out, () => post(`/pos/orders/${id}/convert`), 'Converted. Take payment to place it.', reload), true));
      const holding = o.hold && o.hold.status === 'active';
      if (o.kind === 'quote' && o.status === 'draft') {
        if (!holding && setup.settings.quoteHoldsAllowed) acts.push(btn('Hold stock', (e) => run(e.currentTarget, out, () => post(`/pos/orders/${id}/hold`, {}),
          (r) => `Holding ${plural(r.linesHeld, 'line')} until ${dayLabel(r.heldUntil)}.${r.notHeld ? ` ${plural(r.notHeld, 'line')} could not be held.` : ''}`, reload)));
        if (holding && mgr) acts.push(btn('Extend the hold', () => extendHoldDialog(o, reload)));
        if (holding) acts.push(btn('Let the stock go', async (e) => {
          const why = await E.askReason({ title: 'Let the held stock go', label: 'Why', confirm: 'Let it go', optional: true });
          if (why !== null) run(e.currentTarget, out, () => post(`/pos/orders/${id}/hold/release`, { reason: why }), 'The stock is free again.', reload);
        }));
      }
      if (o.status === 'draft' && o.kind !== 'quote') acts.push(btn('Take payment and place', () => tenderDialog(o, 'checkout', reload, mgr), true));
      if (['open', 'fulfilling', 'fulfilled'].includes(o.status) && Number(o.balance_minor) > 0 && o.kind !== 'return') acts.push(btn('Take a payment', () => tenderDialog(o, 'pay', reload, mgr), true));
      const handable = o.lines.filter((l) => ['pickup', 'carry'].includes(l.fulfillment) && ['reserved', 'ready', 'open'].includes(l.line_status) && l.role === 'item');
      if (['open', 'fulfilling'].includes(o.status) && handable.length) acts.push(btn('Hand over', () => handDialog(o, handable, reload)));
      const returnable = o.lines.filter((l) => l.line_status === 'fulfilled' && Number(l.qty) > Number(l.returned_qty));
      if (o.kind !== 'return' && returnable.length) acts.push(btn('Return or exchange', () => returnDialog(o, returnable, setup, reload)));
      const truckLines = o.lines.filter((l) => l.fulfillment === 'delivery' && l.role === 'item' && !['fee', 'service', 'warranty'].includes(l.kind) && !['cancelled', 'fulfilled'].includes(l.line_status));
      if (['draft', 'open', 'fulfilling'].includes(o.status) && o.kind !== 'return' && o.ship_address_id && truckLines.length && !(o.delivery_stop && o.delivery_stop.confirmed))
        acts.push(btn(o.delivery_stop || o.delivery_day ? 'Change delivery day' : 'Pick delivery day', () => pickDayDialog({ addressId: o.ship_address_id, sub: `${o.number} · ${o.customer || ''}`,
          items: truckLines.map((l) => `${l.product_id || ''}:${Number(l.qty)}`).join(','),
          onPick: async (x) => {
            try {
              const r = await post(`/pos/orders/${id}/delivery-day`, { day: x.day, windowId: x.windowId });
              toast(r.booked ? `Delivery booked for ${dayLabel(x.day)}, ${x.label}.` : (r.note || `Kept ${dayLabel(x.day)}, ${x.label}; it is booked when the sale is placed.`), r.booked || !r.note ? 'good' : 'warning');
              await reload();
            } catch (e) { toast(friendly(e), 'critical'); }
          } })));
      if (o.status === 'draft' && o.customer_id) acts.push(btn(o.tax_exempt_ref ? 'Change tax exemption' : 'Make tax exempt', () => exemptionDialog(o, reload)));
      if (['draft', 'open'].includes(o.status)) acts.push(btn('Cancel', () => cancelDialog(o, reload)));
      if (o.status !== 'cancelled') acts.push(btn(o.signed_at ? 'Sign again' : 'Signature', () => signatureDialog(o, reload)));
      acts.push(btn('Receipt', () => { d.close(); go('pos', 'receipt-' + id); }));
      if (o.kind !== 'return') {
        acts.push(el('a', { class: 'btn', href: `/api/c/${S.co.id}/pos/orders/${id}/tear-sheet`, target: '_blank', rel: 'noopener' }, 'Tear sheet'));
        if (o.sheetLinks && o.sheetLinks.length) acts.push(btn('Stop the shared link', (e) => run(e.currentTarget, out, () => post(`/pos/orders/${id}/tear-sheet/revoke`, {}),
          'The link the customer has no longer opens.', reload)));
        if (o.customer_id && o.status !== 'cancelled') acts.push(btn('Send the tear sheet', (e) => run(e.currentTarget, out, () => post(`/pos/orders/${id}/tear-sheet/send`, {}),
          (r) => `Sent by ${r.channel === 'sms' ? 'text' : 'email'} to ${r.to}${r.status === 'skipped' ? ' (no address on file, so it was not sent)' : ''}. The link works until ${shortDay(r.expiresAt)}.`)));
      }
      if (next === 'checkout' && o.status === 'draft') { next = null; setTimeout(() => tenderDialog(o, 'checkout', reload, mgr), 0); }
      return frag(
        el('p', { class: 'lead', text: `${o.number} · ${words(o.kind)} · ${words(o.status)}${o.original_number ? ` · against ${o.original_number}` : ''}` }),
        el('div', { class: 'panel' }, el('div', { class: 'facts' }, fact('Customer', o.customer || 'Walk-in'), fact('Total', money(o.total_minor)), fact('Paid', money(o.paid_minor)),
          fact('Owed', money(o.balance_minor)), fact('Tax', `${money(o.tax_minor)}${o.tax_exempt_ref ? ' (exempt ' + o.tax_exempt_ref + ')' : ''}`),
          fact('Goes by', FUL[o.fulfillment] || o.fulfillment), o.promised_on ? fact('Promised', dayLabel(o.promised_on)) : null,
          o.quote_expires_on ? fact('Quote good until', dayLabel(o.quote_expires_on)) : null,
          o.hold ? fact('Stock hold', o.hold.status === 'active' ? `${plural(o.hold.lines_held, 'line')} held until ${dayLabel(o.hold.held_until)}${o.hold.extended_by ? ` (extended by ${o.hold.extended_by})` : ''}` : `ended: ${words(o.hold.status)}`) : null,
          o.deposit && Number(o.deposit.requiredMinor) > 0 && o.status === 'draft' ? fact('Deposit needed', money(o.deposit.requiredMinor)) : null,
          o.ship_line1 ? fact('Deliver to', `${o.ship_line1}, ${o.ship_city} ${o.ship_state}`) : null,
          o.delivery_stop ? fact('Delivery', `${o.delivery_stop.number} · ${dayLabel(o.delivery_stop.day)} ${o.delivery_stop.window || ''} · ${o.delivery_stop.confirmed ? 'confirmed' : 'to confirm'}`)
            : o.delivery_day ? fact('Delivery day', `${dayLabel(o.delivery_day)} ${o.delivery_window || ''} · not booked yet`) : null,
          fact('Sold by', o.salespeople.map((p) => `${p.name} ${p.split_bps / 100}%`).join(', ') || '—'),
          Number(o.storeCreditMinor) ? fact('Store credit', money(o.storeCreditMinor)) : null)),
        o.kind === 'layaway' && o.layaway_schedule.length ? section('Layaway schedule', o.paid_off_at ? 'paid off' : null, null, el('div', { class: 'panel' },
          o.layaway_schedule.map((s) => item({ title: dayLabel(s.due), amount: money(s.amount) })))) : null,
        section('Lines', null, null, el('div', { class: 'panel' }, lineItems)),
        o.taxes && o.taxes.length ? section('Sales tax by jurisdiction', null, null, el('div', { class: 'panel' }, o.taxes.map((x) => item({ title: `${x.name} · ${words(x.level)}`,
          amount: money(x.tax_minor), detail: [`${(x.rate_bps / 100).toFixed(2)}%`, x.sourced === 'destination' ? 'where the goods go' : 'at the store',
            Number(x.taxable_minor) ? `on ${money(x.taxable_minor)}` : null, Number(x.exempt_minor) ? `${money(x.exempt_minor)} exempt (${words(x.exempt_reasons || '')})` : null].filter(Boolean).join(' · '),
          why: x.notes || null })))) : null,
        el('div', { class: 'dlg-acts' }, acts), out,
        section('Payments', null, null, el('div', { class: 'panel' }, o.receipts.length ? o.receipts.map((r) => item({ title: `${r.number} · ${TENDER[r.method] || r.method}`, amount: money(r.amount_minor),
          detail: [r.reference, r.received_by, ago(r.received_at)].filter(Boolean).join(' · ') })) : empty('Nothing paid yet.', null, true))),
        o.returns.length ? section('Returns', null, null, el('div', { class: 'panel' }, o.returns.map((r) => item({ title: r.number, amount: money(r.total_minor), onClick: () => { d.close(); openOrder(r.id); } })))) : null,
        section('History', 'who changed this sale', null, el('div', { class: 'panel' }, o.history.map((h) => item({ title: `${words(h.action)}${h.reason ? ': ' + h.reason : ''}`,
          detail: [h.actor_label, Object.entries(h.after || {}).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')].filter(Boolean).join(' · '),
          badge: el('span', { class: 'sub', text: ago(h.at) }) })))));
    });
    reload();
  }

  function tenderRows(box, defaults, opts = {}) {
    const rows = [];
    const add = (method, amount) => {
      const m = select(Object.entries(TENDER), method || 'card');
      const a = input({ inputmode: 'decimal', value: amount != null ? amount : '', placeholder: '0.00', 'aria-label': 'Amount' });
      const r = input({ maxlength: '20', placeholder: 'Last 4, check no., approval no.', 'aria-label': 'Reference' });
      rows.push({ m, a, r });
      box.append(el('div', { class: 'li' }, el('div', { class: 't' }, el('div', { class: 'form-grid' }, field(opts.refund ? 'Refund to' : 'Tender', m), field('Amount', a), field('Reference', r)))));
    };
    for (const [m, a] of defaults) add(m, a);
    return { rows, add, values: () => rows.filter((x) => Number(x.a.value) > 0).map((x) => ({ method: x.m.value, amount: x.a.value, reference: x.r.value })) };
  }

  function tenderDialog(o, mode, after, mgr) {
    const d = openDialog(mode === 'checkout' ? `Place ${o.number}` : `Payment on ${o.number}`, `${money(o.balance_minor)} owed`, { wide: true });
    const box = el('div', { class: 'panel' });
    const t = tenderRows(box, [['card', dollars(o.kind === 'layaway' && mode === 'checkout' ? Math.ceil(Number(o.total_minor) * 0.2) : o.balance_minor)]]);
    const out = outBox();
    const pad2 = mode === 'checkout' ? sigPad() : null;
    // The least that must be paid today when goods will be on order, and a manager's way past it.
    const depBox = el('div');
    const depWhy = input({ maxlength: '300', placeholder: 'Why less is allowed' });
    const dep = o.deposit && mode === 'checkout' && o.kind === 'sale' && Number(o.deposit.requiredMinor) > 0 ? o.deposit : null;
    if (dep) depBox.replaceChildren(resultBox('warning', 'warn', `Deposit needed: at least ${money(dep.requiredMinor)}`,
      `${(dep.specialOrderBps / 100).toFixed(0)}% of the ${money(dep.onOrderMinor)} of goods that will be ordered for the customer${dep.stockedBps ? `, and ${(dep.stockedBps / 100).toFixed(0)}% of the ${money(dep.stockedMinor)} in stock` : ''}.`
        + (mgr ? ' As a store manager you can allow less with a reason below.' : ' Less needs a store manager.')),
      mgr ? pad(el('div', { class: 'form-grid' }, field('Allow a smaller deposit because', depWhy, { wide: true, hint: 'Only if the customer pays less than the minimum. Kept with the sale.' }))) : null);
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/pos/orders/${o.id}/${mode}`, { sessionId: getSess(), tenders: t.values(),
      signature: pad2 && pad2.signed() ? pad2.data() : undefined, signedName: o.customer || '', depositOverrideReason: depWhy.value.trim() || undefined }),
      (r) => [mode === 'checkout' ? `Placed: ${words(r.status)}.` : 'Payment taken.', r.delivery ? (r.delivery.booked ? `Delivery ${r.delivery.number} booked for ${shortDay(r.delivery.day)}${r.delivery.confirmed ? ' and confirmed' : ', waiting for the delivery manager to confirm'}.` : r.delivery.note) : null, r.changeMinor && Number(r.changeMinor) ? `Change due ${money(r.changeMinor)}.` : null,
        Number(r.balanceMinor) > 0 ? `${money(r.balanceMinor)} still owed.` : 'Paid in full.', r.onOrder ? `${plural(r.onOrder, 'line')} on order with the vendor.` : null,
        r.handedOver ? `${plural(r.handedOver, 'line')} handed over.` : null].filter(Boolean).join(' '),
      async () => { await after(); E.render(); }) }, mode === 'checkout' ? 'Place the order' : 'Take it');
    d.body.append(el('p', { class: 'lead', text: o.kind === 'layaway' ? 'A layaway needs its deposit now; the goods wait until it is paid in full.' : 'Split across as many tenders as the customer likes. Cash can be more than owed; the change is shown.' }),
      depBox, box, el('div', { class: 'toolbar' }, el('button', { class: 'btn small', type: 'button', onclick: () => t.add('cash', '') }, 'Another tender')),
      pad2 ? section('Customer signature', 'optional', null, pad2.node) : null,
      el('div', { class: 'dlg-acts' }, b, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Close')), out);
  }

  function certificateDialog(c, after) {
    const d = openDialog('Add a tax-exemption certificate', c.name);
    const number = input({ maxlength: '60', placeholder: 'As printed on the certificate' });
    const state = input({ maxlength: '2', autocapitalize: 'characters', placeholder: 'PA' });
    const reason = select([['resale', 'Resale'], ['government', 'Government'], ['nonprofit', 'Nonprofit'], ['agricultural', 'Agricultural'], ['manufacturing', 'Manufacturing'], ['other', 'Other']], 'resale');
    const expires = input({ type: 'date', min: todayIso() });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/pos/customers/${c.id}/certificates`, { number: number.value,
      state: state.value, reason: reason.value, expiresOn: expires.value || null }), null, async () => {
      c.certificates = [{ number: number.value.trim(), state: state.value.trim().toUpperCase(), reason: reason.value, expiresOn: expires.value || null }, ...(c.certificates || [])];
      cart.taxExemptRef = number.value.trim(); d.close(); toast('Certificate on file.', 'good'); after(); }) }, 'Keep it on file');
    d.body.append(el('p', { class: 'lead', text: 'Keep a copy of the paper certificate. A sale is only exempt in the certificate’s state, and an expired certificate is refused.' }),
      el('div', { class: 'form-grid' }, field('Certificate number', number, { wide: true }), field('State', state), field('Why exempt', reason), field('Expires', expires, { hint: 'Leave empty if it does not expire.' })),
      el('div', { class: 'dlg-acts' }, b, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
  }

  function exemptionDialog(o, after) {
    const d = openDialog('Tax exemption', `${o.number} · ${o.customer || ''}`);
    fillDialog(d, async () => {
      const certs = (await coApi(`/pos/customers/${o.customer_id}/certificates`)).filter((x) => x.current);
      const pick = select(certs.map((x) => [x.number, `${x.number} · ${x.state} · ${words(x.reason)}${x.expires_on ? ` · until ${fullDay(x.expires_on)}` : ''}`]),
        certs.some((x) => x.number === o.tax_exempt_ref) ? o.tax_exempt_ref : '', 'Not exempt');
      const out = outBox();
      const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/pos/orders/${o.id}/exemption`, { taxExemptRef: pick.value || null }),
        'The lines are taxed again.', async () => { await after(); d.close(); }) }, 'Save');
      return frag(el('p', { class: 'lead', text: o.tax_exempt_ref ? `Now exempt under ${o.tax_exempt_ref}. Pick a current certificate, or none to tax the sale.` : 'Pick a current certificate on file.' }),
        field('Certificate', pick), el('div', { class: 'dlg-acts' }, b, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
    });
  }

  function extendHoldDialog(o, after) {
    const d = openDialog('Extend the stock hold', `${o.number} · held until ${dayLabel(o.hold.held_until)}`);
    const until = input({ type: 'date', min: o.hold.held_until, max: o.quote_expires_on || null, value: o.quote_expires_on || '' });
    const why = input({ maxlength: '300', placeholder: 'Why the customer needs longer' });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/pos/orders/${o.id}/hold/extend`, { until: until.value, reason: why.value }),
      'Extended.', async () => { await after(); d.close(); }) }, 'Extend it');
    d.body.append(el('div', { class: 'form-grid' }, field('Hold until', until, { hint: o.quote_expires_on ? `No later than the quote, ${dayLabel(o.quote_expires_on)}.` : null }),
      field('Reason', why, { wide: true })), el('div', { class: 'dlg-acts' }, b, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
  }

  function handDialog(o, lines, after) {
    const d = openDialog(`Hand over from ${o.number}`, 'Pickup at the counter');
    const picked = new Set(lines.map((l) => l.id));
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/pos/orders/${o.id}/fulfil`, { lineIds: [...picked], sessionId: getSess() }),
      (r) => `${plural(r.handedOver, 'line')} handed over.`, async () => { await after(); d.close(); E.render(); }) }, 'Hand them over');
    d.body.append(el('div', { class: 'panel' }, lines.map((l) => item({ pick: el('input', { type: 'checkbox', checked: true, 'aria-label': l.description,
      onchange: (e) => { if (e.target.checked) picked.add(l.id); else picked.delete(l.id); } }), title: l.description, detail: `${Number(l.qty)} · ${words(l.line_status)}` }))),
      el('div', { class: 'dlg-acts' }, b), out);
  }

  function returnDialog(o, lines, setup, after) {
    const d = openDialog(`Return against ${o.number}`, 'Pick what came back', { wide: true });
    const est = el('b');
    const rows = lines.map((l) => {
      const left = Number(l.qty) - Number(l.returned_qty);
      const n = input({ inputmode: 'numeric', value: '0', 'aria-label': `How many ${l.description}` });
      const reason = select(setup.returnReasons.map((r) => [r, E.cap(words(r))]), 'changed_mind');
      const disp = select([['restock', 'Back on the shelf'], ['damage', 'To damage']], 'restock');
      const note = input({ maxlength: '200', placeholder: 'What is wrong' });
      n.addEventListener('input', recalc);
      return { l, n, reason, disp, note, left, node: item({ title: l.description, amount: `${left} can return`,
        acts: [el('div', { class: 'form-grid' }, field('How many', n), field('Reason', reason), ['fee', 'warranty', 'service'].includes(l.kind) ? null : field('Goes', disp), field('Note', note))] }) };
    });
    function recalc() {
      let s = 0;
      for (const r of rows) { const k = Math.min(Number(r.n.value) || 0, r.left); s += Math.round(Number(r.l.net_minor) / Number(r.l.qty)) * k + Math.round(Number(r.l.tax_minor) * k / Number(r.l.qty)); }
      est.textContent = `Refund about ${money(s)}`;
      if (t.rows[0]) t.rows[0].a.value = dollars(s);
    }
    const box = el('div', { class: 'panel' });
    const t = tenderRows(box, [[o.customer ? 'store_credit' : 'cash', '0.00']], { refund: true });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/pos/orders/${o.id}/return`, { sessionId: getSess(),
      lines: rows.filter((r) => Number(r.n.value) > 0).map((r) => ({ lineId: r.l.id, qty: r.n.value, reason: r.reason.value, disposition: r.disp.value, note: r.note.value })),
      tenders: t.values() }), (r) => `Return ${r.number}: ${money(r.refundMinor)} refunded.`, async () => { await after(); E.render(); }) }, 'Take the return');
    recalc();
    d.body.append(el('div', { class: 'panel' }, rows.map((r) => r.node)), el('p', {}, est), section('Refund', 'store credit makes it an exchange', null, box),
      el('div', { class: 'dlg-acts' }, b, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Close')), out);
  }

  function cancelDialog(o, after) {
    const d = openDialog(`Cancel ${o.number}`, Number(o.paid_minor) ? `${money(o.paid_minor)} goes back` : null);
    const why = el('textarea', { maxlength: '300', placeholder: 'Why' });
    const method = select(Object.entries(TENDER), 'card');
    const ref = input({ maxlength: '20', placeholder: 'Last 4 or reference' });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/pos/orders/${o.id}/cancel`, { reason: why.value, sessionId: getSess(),
      refundMethod: Number(o.paid_minor) ? method.value : undefined, reference: ref.value }), 'Cancelled.', async () => { await after(); E.render(); }) }, 'Cancel the order');
    d.body.append(el('div', { class: 'form-grid' }, field('Reason', why, { wide: true }), Number(o.paid_minor) ? field('Refund to', method) : null, Number(o.paid_minor) ? field('Reference', ref) : null),
      el('div', { class: 'dlg-acts' }, b), out);
  }

  function sigPad() {
    const cv = el('canvas', { width: '600', height: '180', 'aria-label': 'Sign here' });
    cv.style.width = '100%'; cv.style.maxWidth = '600px'; cv.style.height = '180px'; cv.style.border = '1px solid var(--line)'; cv.style.borderRadius = '9px'; cv.style.touchAction = 'none';
    cv.style.background = '#fff';
    const ctx = cv.getContext('2d');
    ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
    let down = false, any = false;
    const at = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
    cv.addEventListener('pointerdown', (e) => { down = true; any = true; cv.setPointerCapture(e.pointerId); const [x, y] = at(e); ctx.beginPath(); ctx.moveTo(x, y); });
    cv.addEventListener('pointermove', (e) => { if (!down) return; const [x, y] = at(e); ctx.lineTo(x, y); ctx.stroke(); });
    cv.addEventListener('pointerup', () => { down = false; });
    const clear = el('button', { class: 'btn small', type: 'button', onclick: () => { ctx.clearRect(0, 0, cv.width, cv.height); any = false; } }, 'Clear');
    return { node: el('div', {}, cv, el('div', { class: 'toolbar' }, clear)), signed: () => any, data: () => cv.toDataURL('image/png') };
  }
  function signatureDialog(o, after) {
    const d = openDialog('Customer signature', o.number);
    const p = sigPad();
    const name = input({ value: o.customer || '', maxlength: '120' });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => { if (!p.signed()) { out.replaceChildren(resultBox('warning', 'warn', 'Sign first', 'The box is empty.')); return; }
      run(b, out, () => post(`/pos/orders/${o.id}/signature`, { signature: p.data(), signedName: name.value }), 'Signed.', async () => { d.close(); await after(); }); } }, 'Save the signature');
    d.body.append(p.node, field('Name', name), el('div', { class: 'dlg-acts' }, b), out);
  }

  // =============================================================== register
  async function registerTab(setup) {
    const sessions = await coApi('/pos/sessions');
    const mine = setup.registers;
    return frag(
      section('Registers', 'one drawer session per register', isManager(setup) ? [el('button', { class: 'btn small', type: 'button', onclick: () => registerDialog(setup) }, 'Add a register')] : null,
        el('div', { class: 'panel' }, mine.length ? mine.map((r) => item({ title: `${r.name}`, detail: [r.location, r.session_number ? `${r.session_number} opened by ${r.opened_by} ${ago(r.opened_at)}` : 'closed'].join(' · '),
          badge: r.session_id ? chip('good', 'ok', 'open') : chip('neutral', 'pause', 'closed'),
          acts: r.session_id ? [
            el('button', { class: 'btn small', type: 'button', onclick: () => cashDialog(r) }, 'Cash in or out'),
            el('button', { class: 'btn small', type: 'button', onclick: () => zDialog(r.session_id) }, 'Z report'),
            el('button', { class: 'btn small primary', type: 'button', onclick: () => closeDialog(r, setup) }, 'Close and count')]
            : [el('button', { class: 'btn small primary', type: 'button', onclick: () => openDialogFor(r) }, 'Open')] })) : empty('No registers yet.', null, true))),
      section('Recent sessions', null, null, el('div', { class: 'panel' }, sessions.length ? sessions.map((s) => item({ title: `${s.number} · ${s.register}`,
        amount: s.over_short_minor != null ? (Number(s.over_short_minor) === 0 ? 'balanced' : `${Number(s.over_short_minor) < 0 ? 'short' : 'over'} ${money(Math.abs(Number(s.over_short_minor)))}`) : null,
        detail: [s.location, `opened ${ago(s.opened_at)} by ${s.opened_by}`, s.closed_at ? `closed by ${s.closed_by}` : null].filter(Boolean).join(' · '),
        badge: chip(s.status === 'open' ? 'good' : 'neutral', s.status === 'open' ? 'ok' : 'pause', s.status), onClick: () => zDialog(s.id) })) : empty('None yet.', null, true))));
  }
  function registerDialog(setup) {
    const d = openDialog('Add a register', null);
    const loc = select(setup.stores.filter((s) => s.kind !== 'warehouse').map((s) => [s.id, s.name]), '', 'Store');
    const code = input({ maxlength: '8', placeholder: 'R2' }), name = input({ maxlength: '60', placeholder: 'Front counter 2' });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post('/pos/registers', { locationId: loc.value, code: code.value, name: name.value }), 'Added.', async () => { d.close(); E.render(); }) }, 'Add it');
    d.body.append(el('div', { class: 'form-grid' }, field('Store', loc, { wide: true }), field('Code', code), field('Name', name)), el('div', { class: 'dlg-acts' }, b), out);
  }
  function openDialogFor(r) {
    const d = openDialog(`Open ${r.name}`, r.location);
    const fl = input({ inputmode: 'decimal', value: '200.00' });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post('/pos/sessions', { registerId: r.id, float: fl.value }),
      (x) => `Session ${x.number} open.`, async (x) => { setSess(x.id); d.close(); E.render(); }) }, 'Open the drawer');
    d.body.append(field('Starting float', fl, { hint: 'The cash counted into the drawer now.' }), el('div', { class: 'dlg-acts' }, b), out);
  }
  function cashDialog(r) {
    const d = openDialog('Cash in or out', `${r.name} · ${r.session_number}`);
    const kind = select([['drop', 'Drop to the safe'], ['paid_out', 'Paid out'], ['paid_in', 'Paid in']], 'drop');
    const amt = input({ inputmode: 'decimal', placeholder: '0.00' });
    const note = input({ maxlength: '200', placeholder: 'What it was for' });
    const out = outBox();
    const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/pos/sessions/${r.session_id}/cash`, { kind: kind.value, amount: amt.value, note: note.value }),
      'Recorded.', async () => { d.close(); E.render(); }) }, 'Record it');
    d.body.append(el('div', { class: 'form-grid' }, field('Kind', kind), field('Amount', amt), field('Note', note, { wide: true })), el('div', { class: 'dlg-acts' }, b), out);
  }
  function zView(z) {
    const c = z.cash;
    return frag(
      el('div', { class: 'panel' }, el('div', { class: 'facts' }, fact('Session', `${z.session.number} · ${z.session.register}`), fact('Status', z.session.status),
        fact('Sales', `${z.sales.n} · ${money(z.sales.total)}`), fact('Tax', money(z.sales.tax)), fact('Discounts', money(z.sales.disc)), fact('Returns', `${z.returns.n} · ${money(z.returns.total)}`))),
      section('By tender', null, null, el('div', { class: 'panel' }, z.tenders.length ? z.tenders.map((t) => item({ title: TENDER[t.method] || t.method, amount: money(Number(t.taken) - Number(t.refunded)),
        detail: `${plural(t.n, 'receipt')} · ${money(t.taken)} in${Number(t.refunded) ? ` · ${money(t.refunded)} refunded` : ''}` })) : empty('Nothing taken yet.', null, true))),
      section('Cash drawer', null, null, el('div', { class: 'panel' }, el('div', { class: 'facts' }, fact('Float', money(c.floatMinor)), fact('Cash taken, net', money(c.cashNetMinor)),
        fact('Drops', money(c.dropsMinor)), fact('Paid in / out', `${money(c.paidInMinor)} / ${money(c.paidOutMinor)}`), fact('Should hold', money(c.expectedMinor)),
        c.countedMinor != null ? fact('Counted', money(c.countedMinor)) : null, c.overShortMinor != null ? fact('Over / short', money(c.overShortMinor)) : null))),
      z.salespeople.length ? section('By salesperson', null, null, el('div', { class: 'panel' }, z.salespeople.map((p) => item({ title: p.name, amount: money(p.credit), detail: plural(p.n, 'sale') })))) : null);
  }
  function zDialog(id) {
    const d = openDialog('Z report', null, { wide: true });
    fillDialog(d, async () => frag(zView(await coApi(`/pos/sessions/${id}/z`)), el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Print'))));
  }
  function closeDialog(r, setup) {
    const d = openDialog(`Close ${r.name}`, 'Count the drawer by denomination', { wide: true });
    fillDialog(d, async () => {
      const z = await coApi(`/pos/sessions/${r.session_id}/z`);
      const expected = Number(z.cash.expectedMinor);
      const tot = el('b');
      const inputs = setup.denominations.map((dn) => { const i = input({ inputmode: 'numeric', value: '', placeholder: '0', 'aria-label': `Count of ${money(dn)}` }); i.addEventListener('input', sum); return [dn, i]; });
      function sum() {
        const c = inputs.reduce((a, [dn, i]) => a + dn * (Number(i.value) || 0), 0);
        const diff = c - expected;
        tot.textContent = `Counted ${money(c)} · should be ${money(expected)} · ${diff === 0 ? 'balanced' : (diff < 0 ? 'short ' : 'over ') + money(Math.abs(diff))}`;
      }
      sum();
      const note = input({ maxlength: '300', placeholder: 'Needed if it is over or short' });
      const out = outBox();
      const b = el('button', { class: 'btn primary', type: 'button', onclick: () => run(b, out, () => post(`/pos/sessions/${r.session_id}/close`, {
        counts: Object.fromEntries(inputs.map(([dn, i]) => [String(dn), Number(i.value) || 0])), note: note.value }),
        (x) => `Closed: ${Number(x.overShortMinor) === 0 ? 'balanced' : (Number(x.overShortMinor) < 0 ? 'short ' : 'over ') + money(Math.abs(Number(x.overShortMinor))) + ', posted'}.`,
        async () => { E.render(); }) }, 'Close the drawer');
      return frag(el('div', { class: 'form-grid' }, inputs.map(([dn, i]) => field(dn >= 100 ? `$${dn / 100} ${dn >= 200 ? 'bills' : 'coins'}` : `${dn}¢`, i))),
        el('p', {}, tot), field('Note', note), el('div', { class: 'dlg-acts' }, b), out);
    });
  }

  // ================================================================= receipt
  async function receiptPage(id) {
    const o = await coApi(`/pos/orders/${id}`);
    const addr = o.location_address || {};
    const row = (k, v, strong) => el('div', { class: 'li' }, el('div', { class: 't', text: k }), el('div', { class: 'amt' }, strong ? el('b', { text: v }) : v));
    const paper = el('div', { class: 'panel' }, pad(el('div', {},
      el('h2', { text: o.company }), el('p', { class: 'sub', text: [o.location, addr.line1, addr.city ? `${addr.city}, ${addr.state} ${addr.postal}` : null].filter(Boolean).join(' · ') }),
      el('p', {}, el('b', { text: `${o.kind === 'quote' ? 'Quote' : o.kind === 'return' ? 'Return' : 'Receipt'} ${o.number}` }), ` · ${E.dayLabel(String(o.ordered_at).slice(0, 10))}`),
      o.customer ? el('p', { class: 'sub', text: [o.customer, o.customer_phone, o.ship_line1 ? `${o.ship_line1}, ${o.ship_city} ${o.ship_state}` : null].filter(Boolean).join(' · ') }) : null,
      o.quote_expires_on ? el('p', { class: 'sub', text: `Prices good until ${dayLabel(o.quote_expires_on)}` }) : null)),
      o.lines.filter((l) => l.line_status !== 'cancelled').map((l) => item({ title: l.description, amount: money(l.net_minor),
        detail: [`${Number(l.qty)} × ${money(l.unit_price_minor)}`, Number(l.discount_minor) ? `${money(l.discount_minor)} off` : null, l.role === 'item' ? FUL[l.fulfillment] : null,
          l.promised_on ? `promised ${shortDay(l.promised_on)}` : null].filter(Boolean).join(' · ') })),
      row('Subtotal', money(Number(o.subtotal_minor) - Number(o.discount_minor))), row(`Tax${o.tax_exempt_ref ? ' (exempt ' + o.tax_exempt_ref + ')' : ''}`, money(o.tax_minor)),
      (o.taxes || []).length > 1 ? o.taxes.map((x) => row(`· ${x.name} ${(x.rate_bps / 100).toFixed(2)}%`, money(x.tax_minor))) : null,
      row('Total', money(o.total_minor), true),
      o.receipts.map((r) => row(`${TENDER[r.method] || r.method}${r.reference ? ' ' + r.reference : ''}`, money(r.amount_minor))),
      row('Balance', money(o.balance_minor), true),
      pad(el('div', {}, el('p', { class: 'sub', text: `Sold by ${o.salespeople.map((p) => p.name).join(', ') || '—'}` }),
        o.signature_data_url ? el('div', {}, el('img', { src: o.signature_data_url, alt: `Signature of ${o.signed_name || 'the customer'}`, width: '300' }),
          el('p', { class: 'sub', text: `Signed by ${o.signed_name || 'the customer'}` })) : null,
        el('p', { class: 'sub', text: 'Keep this receipt for returns and protection plan claims.' }))));
    return frag(head(`Receipt ${o.number}`, [el('button', { class: 'btn primary', type: 'button', onclick: () => window.print() }, 'Print'),
      el('button', { class: 'btn', type: 'button', onclick: () => go('pos', 'orders') }, 'Back')], S.co.name), paper);
  }

  E.register('pos', 'Point of sale', 'cash', screen, 'Retail');
})();
