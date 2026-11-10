// shop screens: "Web store" (orders, products, carts left behind, customers,
// settings, messages) and "Endless aisle" (the store tablet). Registers with
// window.ERP (see docs/MODULES.md). Data is placed with textContent only.
(() => {
  'use strict';
  const E = window.ERP;
  if (!E) return;
  const { el, section, coApi, post, register, item, chip, money, ago, dayLabel, empty, seg, head, openDialog, fillDialog,
    resultBox, toast, busy, friendly, tile, tilesRow, go, render, S, shortDay } = E;
  void seg;

  const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) p.set(k, v); const s = p.toString(); return s ? '?' + s : ''; };
  const field = (label, input, note, wide) => el('label', { class: 'field' + (wide ? ' wide' : '') }, el('span', { text: label }), input, note ? el('span', { class: 'hint', text: note }) : null);
  const input = (props) => el('input', Object.assign({ type: 'text' }, props));
  const select = (options, value, props) => el('select', props || {}, options.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(value ?? '') || null })));
  const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const CH = { web: ['neutral', 'Web'], pos: ['good', 'Store'], phone: ['neutral', 'Phone'], marketplace: ['neutral', 'Marketplace'], b2b: ['neutral', 'B2B'] };
  const ST = { draft: 'warning', open: 'neutral', fulfilling: 'neutral', fulfilled: 'good', closed: 'good', cancelled: 'critical' };
  const FUL = { pickup: 'Pickup', delivery: 'Delivery', ship: 'Parcel', carry: 'Carry-out' };
  const loadInto = async (box, fn) => {
    box.replaceChildren(E.loadingNode());
    try { box.replaceChildren(...[].concat(await fn())); } catch (e) { box.replaceChildren(E.errorBox(e)); }
  };

  // ============================================================ web store
  const TABS = [['orders', 'Orders'], ['products', 'Products'], ['carts', 'Carts left'], ['customers', 'Customers'], ['settings', 'Settings'], ['messages', 'Messages']];

  async function screenShop(sub) {
    const tab = TABS.some(([k]) => k === sub) ? sub : 'orders';
    const body = el('div');
    const picker = select(TABS, tab, { 'aria-label': 'Web store section', onchange: (e) => go('shop', e.target.value) });
    const nodes = [head('Web store', [], 'Retail'), field('Section', picker), body];
    const f = { orders: tabOrders, products: tabProducts, carts: tabCarts, customers: tabCustomers, settings: tabSettings, messages: tabMessages }[tab];
    body.append(await f());
    return el('div', {}, nodes);
  }

  async function tabOrders() {
    const box = el('div');
    let status = '';
    const load = () => loadInto(box, async () => {
      const rows = await coApi('/shop/orders' + qs({ status }));
      if (!rows.length) return empty('No web orders yet', 'Orders placed on the storefront land here as ordinary sales orders.', true);
      return el('div', { class: 'panel' }, rows.map((o) => item({
        title: `${o.number} · ${o.customer || 'Guest'}`,
        detail: [FUL[o.fulfillment] || o.fulfillment, o.location, ago(o.ordered_at), `${o.lines} line${o.lines === 1 ? '' : 's'}`,
          o.on_order ? `${o.on_order} on order` : null, o.promised_on ? `promised ${dayLabel(o.promised_on)}` : null].filter(Boolean).join(' · '),
        amount: money(o.total_minor),
        badge: chip(ST[o.status] || 'neutral', o.status === 'cancelled' ? 'fail' : 'ok', o.status),
        why: BigInt(o.total_minor) > BigInt(o.paid_minor) ? `${money(BigInt(o.total_minor) - BigInt(o.paid_minor))} still owed` : null,
        onClick: () => openOrder(o.id, o.number),
      })));
    });
    const filter = select([['', 'Every status'], ['open', 'Open'], ['fulfilling', 'Fulfilling'], ['fulfilled', 'Fulfilled'], ['closed', 'Closed'], ['cancelled', 'Cancelled']], '',
      { onchange: (e) => { status = e.target.value; load(); } });
    load();
    return section('Online orders', 'channel: web', [filter], box);
  }
  function openOrder(id, number) {
    const d = openDialog(`Order ${number}`, 'Web order', { wide: true });
    fillDialog(d, async () => {
      const o = await coApi(`/shop/orders/${id}`);
      return el('div', {},
        tilesRow(tile({ label: 'Total', value: money(o.totalMinor) }), tile({ label: 'Paid', value: money(o.paidMinor), tone: o.balanceMinor === '0' ? 'good' : 'warning' }),
          tile({ label: 'Status', value: o.statusText, word: true })),
        section('Lines', o.card || '', null, el('div', { class: 'panel' }, o.lines.map((l) => item({ title: `${l.qty} × ${l.description}`, detail: l.statusText, amount: money(l.lineMinor) })))),
        el('p', { class: 'foot', text: [o.customer, FUL[o.fulfillment], o.fulfillment === 'pickup' ? o.location : o.shipTo, o.promisedOn ? `promised ${dayLabel(o.promisedOn)}` : null].filter(Boolean).join(' · ') }));
    });
  }

  async function tabProducts() {
    const box = el('div');
    let q = '';
    const load = () => loadInto(box, async () => {
      const rows = await coApi('/shop/products' + qs({ q }));
      if (!rows.length) return empty('No products match', 'Try another name or SKU.', true);
      return el('div', { class: 'panel' }, rows.map((p) => {
        const btn = el('button', { class: 'btn' + (p.web_visible ? '' : ' primary'), type: 'button', onclick: async () => {
          busy(btn, true, p.web_visible ? 'Hiding…' : 'Publishing…');
          try { await post('/shop/products/visible', { productId: p.id, visible: !p.web_visible }); toast(p.web_visible ? `${p.name} is off the web store.` : `${p.name} is on the web store.`, 'good'); load(); }
          catch (e) { toast(friendly(e), 'critical'); busy(btn, false); }
        } }, p.web_visible ? 'Unpublish' : 'Publish');
        return item({ title: p.name, detail: [p.sku, p.category, p.kind === 'configurable' ? 'made to order' : `${Number(p.available)} available`, p.status !== 'active' ? p.status : null].filter(Boolean).join(' · '),
          amount: money(p.price_minor), badge: chip(p.web_visible ? 'good' : 'neutral', p.web_visible ? 'ok' : 'none', p.web_visible ? 'On the web' : 'Not online'), acts: [btn] });
      }));
    });
    const search = input({ enterkeyhint: 'search', placeholder: 'Search name, SKU or category', oninput: debounce((e) => { q = e.target.value.trim(); load(); }, 300) });
    load();
    return section('Publish to the web store', 'Only active products can be published', null, field('Find a product', search), box);
  }

  async function tabCarts() {
    const rows = await coApi('/shop/carts?minutes=60');
    if (!rows.length) return section('Carts left behind', 'idle over an hour', null, empty('No carts left behind', 'Shoppers who leave items in a cart for over an hour show up here.', true));
    return section('Carts left behind', `${rows.length} idle over an hour`, null, el('div', { class: 'panel' }, rows.map((k) => item({
      title: k.email || 'Shopper without an email yet',
      detail: [(k.lines || []).map((l) => `${l.qty} × ${l.name}`).join(', '), `last active ${ago(k.updated_at)}`].join(' · '),
      amount: money(k.subtotal_minor),
      why: k.email ? 'Has an email: a follow-up can go out when a messaging provider is connected.' : null,
    }))));
  }

  async function tabCustomers() {
    const box = el('div');
    let q = '';
    const load = () => loadInto(box, async () => {
      const rows = await coApi('/shop/customers' + qs({ q }));
      if (!rows.length) return empty('No customers match', null, true);
      return el('div', { class: 'panel' }, rows.map((cu) => item({
        title: `${cu.name} · ${cu.number}`, detail: [cu.email, cu.phone, `${cu.orders} order${cu.orders === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
        badge: (cu.channels || []).length ? el('span', {}, (cu.channels || []).map((c) => chip((CH[c] || CH.web)[0], 'ok', (CH[c] || [0, c])[1]))) : null,
        onClick: () => openHistory(cu.id, cu.name),
      })));
    });
    const search = input({ enterkeyhint: 'search', placeholder: 'Name, email, phone or number', oninput: debounce((e) => { q = e.target.value.trim(); load(); }, 300) });
    load();
    return section('Customer history across channels', 'web and store orders together', null, field('Find a customer', search), box);
  }
  function openHistory(id, name) {
    const d = openDialog(name, 'Every order and payment, any channel', { wide: true });
    fillDialog(d, async () => {
      const h = await coApi(`/shop/customers/${id}`);
      return el('div', {},
        tilesRow(tile({ label: 'Orders', value: String(h.totals.orders) }), tile({ label: 'Paid in', value: money(h.totals.spentMinor) }),
          tile({ label: 'Channels', value: h.totals.channels.map((c) => (CH[c] || [0, c])[1]).join(', ') || 'None', word: true })),
        section('Orders', null, null, h.orders.length ? el('div', { class: 'panel' }, h.orders.map((o) => item({
          title: `${o.number} · ${(CH[o.channel] || [0, o.channel])[1]}`, detail: [o.items, o.location, ago(o.ordered_at)].filter(Boolean).join(' · '),
          amount: money(o.total_minor), badge: chip(ST[o.status] || 'neutral', 'ok', o.status) }))) : empty('No orders', null, true)),
        section('Payments', null, null, h.receipts.length ? el('div', { class: 'panel' }, h.receipts.map((r) => item({
          title: `${r.number} · ${r.method}`, detail: [(CH[r.channel] || [0, r.channel])[1], r.order_number, ago(r.received_at), r.voided_at ? 'voided' : null].filter(Boolean).join(' · '),
          amount: money(r.amount_minor) }))) : empty('No payments', null, true)));
    });
  }

  async function tabSettings() {
    const data = await coApi('/shop/sites');
    const locs = data.locations;
    const forms = data.sites.map((s) => siteForm(s, locs, data.feeProducts));
    const addBtn = el('button', { class: 'btn', type: 'button', onclick: () => { addBtn.replaceWith(siteForm(null, locs, data.feeProducts)); } }, 'Add a storefront');
    return el('div', {}, forms.length ? forms : empty('No storefront yet', 'Set one up below.', true), data.sites.length ? addBtn : siteForm(null, locs, data.feeProducts));
  }
  function siteForm(s, locs, fees) {
    const v = (x) => (x == null ? '' : String(x));
    const dollars = (m) => (m == null || m === '' ? '' : (Number(m) / 100).toFixed(2));
    const web = locs.filter((l) => l.kind === 'web');
    const f = {
      slug: input({ value: v(s && s.slug), maxlength: '40', placeholder: 'buddys' }),
      displayName: input({ value: v(s && s.display_name), maxlength: '80' }),
      tagline: input({ value: v(s && s.tagline), maxlength: '140' }),
      brandPrimary: input({ type: 'color', value: (s && s.brand_primary) || '#1f2a44' }),
      brandAccent: input({ type: 'color', value: (s && s.brand_accent) || '#b8964b' }),
      logoUrl: input({ value: v(s && s.logo_url), placeholder: '/path or data:image/…' }),
      webLocationId: select((web.length ? web : locs).map((l) => [l.id, l.name]), s && s.web_location_id),
      taxLocationId: select([['', 'None'], ...locs.filter((l) => l.kind !== 'web').map((l) => [l.id, `${l.name} (${(l.tax_rate_bps / 100).toFixed(2)}%)`])], s && s.tax_location_id),
      deliveryFee: input({ inputmode: 'decimal', value: dollars(s ? s.delivery_fee_minor : 9900) }),
      freeDeliveryOver: input({ inputmode: 'decimal', value: dollars(s && s.free_delivery_over_minor), placeholder: 'blank = never free' }),
      deliveryDays: input({ inputmode: 'numeric', value: v(s ? s.delivery_days : 5) }),
      shipFee: input({ inputmode: 'decimal', value: dollars(s ? s.ship_fee_minor : 1499) }),
      shipDays: input({ inputmode: 'numeric', value: v(s ? s.ship_days : 4) }),
      mtoBaseDays: input({ inputmode: 'numeric', value: v(s ? s.mto_base_days : 35) }),
      backorderDays: input({ inputmode: 'numeric', value: v(s ? s.backorder_days : 21) }),
      feeProductId: select([['', 'None'], ...fees.map((p) => [p.id, `${p.name} (${p.sku})`])], s && s.fee_product_id),
      financingUrl: input({ inputmode: 'url', value: v(s && s.financing_url), placeholder: 'https://…' }),
      policies: el('textarea', { maxlength: '4000', rows: '5' }),
    };
    f.policies.value = v(s && s.policies);
    const picks = locs.filter((l) => l.kind === 'store' || l.kind === 'outlet').map((l) => {
      const cb = el('input', { type: 'checkbox', value: l.id, checked: !!(s && s.pickup_location_ids.includes(l.id)) });
      return el('label', { class: 'check' }, cb, el('span', { text: l.name }));
    });
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: async () => {
      busy(save, true, 'Saving…'); err.replaceChildren();
      try {
        await post('/shop/sites/save', { id: s && s.id, slug: f.slug.value, displayName: f.displayName.value, tagline: f.tagline.value,
          brandPrimary: f.brandPrimary.value, brandAccent: f.brandAccent.value, logoUrl: f.logoUrl.value, webLocationId: f.webLocationId.value,
          taxLocationId: f.taxLocationId.value || null, pickupLocationIds: picks.map((p) => p.querySelector('input')).filter((x) => x.checked).map((x) => x.value),
          deliveryFee: f.deliveryFee.value || '0', freeDeliveryOver: f.freeDeliveryOver.value || null, deliveryDays: f.deliveryDays.value,
          shipFee: f.shipFee.value || '0', shipDays: f.shipDays.value, mtoBaseDays: f.mtoBaseDays.value, backorderDays: f.backorderDays.value,
          feeProductId: f.feeProductId.value || null, financingUrl: f.financingUrl.value, policies: f.policies.value });
        toast('Storefront saved.', 'good'); render();
      } catch (e) { err.replaceChildren(resultBox('critical', 'fail', 'Not saved', friendly(e))); busy(save, false); }
    } }, s ? 'Save changes' : 'Create storefront');
    const acts = [save];
    if (s) {
      const live = s.status === 'live';
      const tog = el('button', { class: 'btn', type: 'button', onclick: async () => {
        busy(tog, true);
        try { await post('/shop/sites/status', { siteId: s.id, status: live ? 'draft' : 'live' }); toast(live ? 'Storefront is closed to shoppers.' : 'Storefront is live.', 'good'); render(); }
        catch (e) { toast(friendly(e), 'critical'); busy(tog, false); }
      } }, live ? 'Take offline' : 'Go live');
      acts.push(tog, el('a', { class: 'btn', href: `/shop/${s.slug}/`, target: '_blank', rel: 'noopener' }, 'Open storefront'));
    }
    return section(s ? s.display_name : 'New storefront', s ? `${s.status === 'live' ? 'Live' : 'Draft'} at /shop/${s.slug}/` : 'draft until you go live', null,
      el('div', { class: 'form-grid' },
        field('Web address', f.slug, 'The store lives at /shop/<this>/'), field('Store name', f.displayName), field('Tagline', f.tagline),
        field('Brand color', f.brandPrimary), field('Accent color', f.brandAccent),
        field('Logo', f.logoUrl, 'A path on this site or a data: image. Images on other sites are blocked by the page’s security policy.'),
        field('Web sales credited to', f.webLocationId), field('Tax rate when shipping from a place with none', f.taxLocationId),
        el('div', { class: 'field wide' }, el('span', { text: 'Pickup stores' }), el('div', { class: 'checks' }, picks)),
        field('Delivery fee ($)', f.deliveryFee), field('Free delivery over ($)', f.freeDeliveryOver), field('Delivery days (business, DC to door)', f.deliveryDays),
        field('Parcel shipping fee ($)', f.shipFee), field('Parcel days', f.shipDays),
        field('Made-to-order base days', f.mtoBaseDays, 'Option lead times add to this.'), field('Backorder days', f.backorderDays),
        field('Fee posts as', f.feeProductId), field('Financing application link', f.financingUrl, 'Shown on product pages and at checkout.'),
        field('Policies shown to shoppers', f.policies, null, true),
        field('Card processor', input({ value: 'Test processor (approves test tokens; nothing is charged)', disabled: true })),
        field('Texts and reviews', input({ value: 'Recorded only; nothing is sent until a provider is connected', disabled: true })),
        el('div', { class: 'wide' }, err, el('div', { class: 'dlg-acts' }, acts))));
  }

  async function tabMessages() {
    const m = await coApi('/shop/messages');
    return el('div', {},
      section('Texts and emails', 'recorded, not sent', null, m.messages.length ? el('div', { class: 'panel' }, m.messages.map((x) => item({
        title: `${x.channel === 'sms' ? 'Text' : 'Email'} to ${x.to_ref}`, detail: [x.number, x.template.replace(/_/g, ' '), ago(x.created_at)].filter(Boolean).join(' · '),
        badge: chip('neutral', 'info', x.status), why: x.body }))) : empty('Nothing recorded yet', 'Order confirmations appear here once the store takes an order.', true)),
      section('Review requests', 'recorded, not sent', null, m.reviews.length ? el('div', { class: 'panel' }, m.reviews.map((x) => item({
        title: x.product, detail: [x.customer, x.number, ago(x.created_at)].filter(Boolean).join(' · '),
        badge: chip(x.status === 'published' ? 'good' : 'neutral', 'info', x.status) }))) : empty('No review requests yet', null, true)));
  }

  register('shop', 'Web store', 'shopbag', screenShop, 'Retail', { icon: 'M5 8h14l-1.2 12H6.2z|M9 8V6.5a3 3 0 0 1 6 0V8' });

  // ======================================================== endless aisle
  // The tablet cart lives here between screens, per company.
  const AISLE = { co: null, location: '', q: '', category: '', lines: [], customer: null };
  const aisleTotal = () => AISLE.lines.reduce((a, l) => a + BigInt(l.unitPriceMinor) * BigInt(l.qty), 0n);

  async function screenAisle() {
    if (AISLE.co !== S.co.id) Object.assign(AISLE, { co: S.co.id, location: '', q: '', category: '', lines: [], customer: null });
    const first = await coApi('/shop/aisle' + qs({ location: AISLE.location }));
    if (!first.stores.length) return el('div', {}, head('Endless aisle', [], 'Retail'), empty('No stores yet', 'Add a store in Setup first.', true));
    AISLE.location = first.location;
    const box = el('div');
    const cartBox = el('div');
    const paint = (data) => {
      if (!data.products.length) { box.replaceChildren(empty('Nothing matches', 'Only products published to the web store show here.', true)); return; }
      box.replaceChildren(el('div', { class: 'panel' }, data.products.map((p) => {
        const where = p.kind === 'warranty' || p.kind === 'service' ? 'Service, nothing to stock'
          : p.kind === 'configurable' || p.kind === 'special_order' ? 'Made to order'
          : Number(p.here) > 0 ? `${Number(p.here)} on this floor` : Number(p.dc) > 0 ? `${Number(p.dc)} at the DC`
          : Number(p.arriving) > 0 ? `${Number(p.arriving)} arriving${p.arriving_on ? ' on ' + shortDay(p.arriving_on) : ''}` : 'On order';
        const add = el('button', { class: 'btn primary', type: 'button', onclick: () => addAisle(p, paintCart) }, p.option_groups ? 'Choose options' : 'Add');
        return item({ title: p.name, detail: [p.brand, p.sku, where].filter(Boolean).join(' · '), amount: (p.option_groups ? 'from ' : '') + money(p.price_minor),
          badge: chip(Number(p.here) > 0 ? 'good' : 'neutral', Number(p.here) > 0 ? 'ok' : 'info', Number(p.here) > 0 ? 'Here' : p.option_groups ? 'Custom' : p.kind === 'warranty' || p.kind === 'service' ? 'Service' : Number(p.dc) > 0 ? 'At DC' : 'Order'), acts: [add] });
      })));
    };
    const reload = debounce(async () => {
      box.replaceChildren(E.loadingNode());
      try { paint(await coApi('/shop/aisle' + qs({ location: AISLE.location, q: AISLE.q, category: AISLE.category }))); }
      catch (e) { box.replaceChildren(E.errorBox(e)); }
    }, 250);
    const storeSel = select(first.stores.map((s) => [s.id, s.name]), AISLE.location, { onchange: (e) => { AISLE.location = e.target.value; reload(); } });
    const catSel = select([['', 'Every department'], ...first.categories.map((c) => [c, c])], AISLE.category, { onchange: (e) => { AISLE.category = e.target.value; reload(); } });
    const search = input({ enterkeyhint: 'search', value: AISLE.q, placeholder: 'Search the whole catalog', oninput: (e) => { AISLE.q = e.target.value.trim(); reload(); } });
    function paintCart() {
      const custLabel = el('span', { text: AISLE.customer ? `${AISLE.customer.name} (${AISLE.customer.number})` : 'No customer yet — the register can add one' });
      const pickCust = el('button', { class: 'btn', type: 'button', onclick: () => pickCustomer(() => paintCart()) }, AISLE.customer ? 'Change' : 'Find customer');
      const send = el('button', { class: 'btn primary', type: 'button', disabled: !AISLE.lines.length || null, onclick: async () => {
        busy(send, true, 'Sending…');
        try {
          const r = await post('/shop/aisle/handoff', { locationId: AISLE.location, customerId: AISLE.customer && AISLE.customer.id,
            lines: AISLE.lines.map((l) => ({ productId: l.productId, choices: l.choices, qty: l.qty })) });
          toast(`Sent to the register at ${r.store} as draft ${r.number}, ${money(r.totalMinor)}.`, 'good');
          AISLE.lines = []; AISLE.customer = null; paintCart();
        } catch (e) { toast(friendly(e), 'critical'); busy(send, false); }
      } }, 'Send to register');
      cartBox.replaceChildren(section('Tablet cart', AISLE.lines.length ? money(aisleTotal()) : 'empty', null,
        AISLE.lines.length ? el('div', { class: 'panel' }, AISLE.lines.map((l, i) => item({
          title: `${l.qty} × ${l.description}`, amount: money(BigInt(l.unitPriceMinor) * BigInt(l.qty)),
          acts: [el('button', { class: 'btn', type: 'button', onclick: () => { AISLE.lines.splice(i, 1); paintCart(); } }, 'Remove')] })))
          : empty('Nothing on the tablet yet', 'Add from the catalog; prices come from the same engine as the register and the web.', true),
        el('div', { class: 'field' }, el('span', { text: 'Customer' }), custLabel, el('div', { class: 'dlg-acts' }, pickCust, send))));
    }
    paint(first);
    paintCart();
    return el('div', {}, head('Endless aisle', [], 'Retail'),
      el('p', { class: 'lead', text: 'Browse everything the company sells — on this floor, at the distribution center, or made to order — and hand the cart to the register as a draft sale.' }),
      section('Catalog', null, null, field('Store', storeSel), field('Department', catSel), field('Search', search), box),
      cartBox);
  }
  function addAisle(p, after) {
    if (!p.option_groups) {
      const hit = AISLE.lines.find((l) => l.productId === p.id && !l.choices.length);
      if (hit) hit.qty = Math.min(20, hit.qty + 1);
      else AISLE.lines.push({ productId: p.id, choices: [], qty: 1, unitPriceMinor: p.price_minor, description: p.name });
      toast(`${p.name} added.`, 'good'); after(); return;
    }
    const d = openDialog(p.name, 'Choose options; the price is the register’s and the web’s');
    fillDialog(d, async () => {
      const groups = await coApi(`/shop/aisle/options/${p.id}`);
      const picks = groups.map((g) => select(g.options.map((o) => [o.code, `${o.label}${Number(o.priceDeltaMinor) ? ' (+' + money(o.priceDeltaMinor) + ')' : ''}${o.leadDays ? `, +${o.leadDays} days` : ''}`]), g.options[0] && g.options[0].code));
      const price = el('div', { class: 'k' });
      const err = el('div');
      let last = null;
      const choices = () => groups.map((g, i) => ({ group: g.code, option: picks[i].value }));
      const reprice = async () => {
        try { last = await post('/shop/aisle/price', { productId: p.id, choices: choices() }); price.textContent = `${money(last.unitPriceMinor)} · ${last.description}`; err.replaceChildren(); }
        catch (e) { last = null; err.replaceChildren(resultBox('critical', 'fail', 'Can’t price that', friendly(e))); }
      };
      for (const s of picks) s.addEventListener('change', reprice);
      await reprice();
      const add = el('button', { class: 'btn primary', type: 'button', onclick: () => {
        if (!last) return;
        AISLE.lines.push({ productId: p.id, choices: choices(), qty: 1, unitPriceMinor: last.unitPriceMinor, description: last.description });
        d.close(); toast('Added to the tablet cart.', 'good'); after();
      } }, 'Add to tablet cart');
      return el('div', {}, groups.map((g, i) => field(g.label, picks[i])), price, err, el('div', { class: 'dlg-acts' }, add));
    });
  }
  function pickCustomer(after) {
    const d = openDialog('Find a customer', 'Search by name, email or phone');
    const box = el('div');
    const run = debounce(async (q) => {
      await loadInto(box, async () => {
        const rows = await coApi('/shop/customers' + qs({ q }));
        if (!rows.length) return empty('No match', 'The register can create the customer.', true);
        return el('div', { class: 'panel' }, rows.map((cu) => item({ title: cu.name, detail: [cu.number, cu.email, cu.phone].filter(Boolean).join(' · '),
          onClick: () => { AISLE.customer = { id: cu.id, name: cu.name, number: cu.number }; d.close(); after(); } })));
      });
    }, 250);
    const s = input({ enterkeyhint: 'search', placeholder: 'Start typing', oninput: (e) => run(e.target.value.trim()) });
    d.body.append(field('Customer', s), box);
    s.focus();
    run('');
  }

  register('aisle', 'Endless aisle', 'tablet', screenAisle, 'Retail', { icon: 'R6 3 12 18|M10.5 18h3' });
})();
