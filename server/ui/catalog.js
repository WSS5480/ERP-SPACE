// catalog screens. Registers with window.ERP (see docs/MODULES.md).
// Products (search, edit, status, cartons, images, packages, options),
// margins, promotions and price lists, special-order templates, vendor
// ordering facts and freight, the vendor feed import, and price tags with
// Code 128 barcodes. Phone first: rows wrap into cards, choices are pickers.
(() => {
  'use strict';
  const E = window.ERP;
  if (!E) return;
  const { S, el, frag, icon, chip, money, plural, cap, coApi, post, go, toast, act, openDialog, resultBox, fillDialog, askReason,
    head, section, tile, tilesRow, empty, item, capped, seg, fact, friendly, render, shortDay, todayIso } = E;

  // ------------------------------------------------------------ pieces
  const field = (label, control, hint, wide) => el('label', { class: 'field' + (wide ? ' wide' : '') }, el('span', { text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null);
  const select = (options, value) => el('select', {}, options.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(value ?? '') || null })));
  const input = (props) => el('input', Object.assign({ type: 'text' }, props));
  const moneyIn = (minor, props) => input(Object.assign({ inputmode: 'decimal', value: minor == null ? '' : (Number(minor) / 100).toFixed(2), placeholder: '0.00' }, props || {}));
  const pct = (bps) => (bps == null ? '—' : `${(Number(bps) / 100).toFixed(1)}%`);
  const errInto = (box) => (e) => box.replaceChildren(resultBox('critical', 'fail', 'Not saved', friendly(e)));
  const STATUS = {
    draft: ['neutral', 'pending', 'Draft'], active: ['good', 'ok', 'Active'], floor_sample: ['warning', 'hold', 'Floor sample'],
    drop: ['serious', 'warn', 'Dropped by vendor'], discontinued: ['critical', 'fail', 'Discontinued'],
  };
  const statusChip = (s) => chip(...(STATUS[s] || ['neutral', 'info', cap(s)]));

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
  const KIND = { stock: 'Stock', configurable: 'Configurable', special_order: 'Special order', kit: 'Package', service: 'Service', fee: 'Fee', warranty: 'Protection plan', gift_card: 'Gift card' };

  function style() {
    if (window.__catSheet) return;
    const sheet = new CSSStyleSheet();
    window.__catSheet = sheet;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    sheet.replaceSync(`
.pc-thumbs{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px}
.pc-thumbs img{width:76px;height:76px;object-fit:cover;border-radius:8px;border:1px solid var(--line);background:var(--soft)}
.pc-rows{display:flex;flex-direction:column;gap:8px;margin:8px 0}
.pc-row{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--soft)}
.pc-row .field{margin:4px 0}.pc-row .wide{grid-column:1/-1}
.pc-row .rm{grid-column:1/-1;justify-self:end}
@media (min-width:760px){.pc-row.opt{grid-template-columns:1.2fr 2fr 1fr 1fr .8fr 1.2fr}.pc-row.opt .rm{grid-column:auto;align-self:end}
  .pc-row.three{grid-template-columns:2fr 1fr 1fr auto}.pc-row.three .rm{grid-column:auto;align-self:end}}
.pc-toolbar{display:grid;grid-template-columns:1fr;gap:8px;margin:0 0 12px}
@media (min-width:720px){.pc-toolbar{grid-template-columns:2fr 1fr 1fr 1fr}}
.pc-map{display:grid;grid-template-columns:1fr;gap:0 14px}
@media (min-width:640px){.pc-map{grid-template-columns:1fr 1fr}}
.pc-req{color:var(--critical);font-weight:700}
.pc-opts{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 12px}
.pc-sw{display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid var(--line-2);vertical-align:-1px;margin-right:5px}
.pc-group{padding:12px 16px;border-top:1px solid var(--line)}.pc-group:first-child{border-top:0}
.pc-group b{display:block;margin-bottom:6px}
.pc-raw{white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:280px;overflow:auto;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:8px}
.form-grid .foot.wide{grid-column:1/-1}
.panel.pad{padding:4px 16px 12px}.panel.pad-g{padding:6px 14px;margin:10px 0}
input[type=search]{width:100%;font-size:16px;color:var(--ink);background:var(--panel);border:1px solid var(--line-2);border-radius:9px;padding:9px 11px;min-height:42px}
`);
  }

  // The current list of products, for pickers (component, price list, promotion).
  let PICK = null;
  async function productPicker(value, filter) {
    if (!PICK) PICK = (await coApi('/catalog/products?limit=200')).items;
    const list = PICK.filter(filter || (() => true));
    return select([['', 'Choose a product…'], ...list.map((p) => [p.id, `${p.name} · ${p.sku}`])], value);
  }
  let FORM = null;
  const form = async () => (FORM = FORM || await coApi('/catalog/form'));

  // ============================================================ the screen
  const TABS = [['products', 'Products'], ['margins', 'Margins'], ['pricing', 'Promotions'], ['templates', 'Templates'], ['vendors', 'Vendors'], ['import', 'Import']];
  const F = { q: '', vendor: '', category: '', status: '', limit: 50 };

  async function screen(sub) {
    style();
    PICK = null; FORM = null;
    const tab = TABS.some(([k]) => k === sub) ? sub : 'products';
    const body = await ({ products: tabProducts, margins: tabMargins, pricing: tabPricing, templates: tabTemplates, vendors: tabVendors, import: tabImport })[tab]();
    return frag(
      head('Catalog', [
        el('button', { class: 'btn', type: 'button', onclick: () => openTags({ vendor: F.vendor, category: F.category }) }, icon('file'), 'Price tags'),
        el('button', { class: 'btn primary', type: 'button', onclick: () => openEdit(null) }, icon('plus'), 'New product')]),
      el('div', { class: 'toolbar' }, seg(TABS, tab, (k) => go('catalog', k === 'products' ? '' : k))),
      body);
  }

  // -------------------------------------------------------------- products
  async function tabProducts() {
    const fo = await form();
    const qs = new URLSearchParams({ q: F.q, limit: String(F.limit) });
    if (F.vendor) qs.set('vendor', F.vendor);
    if (F.category) qs.set('category', F.category);
    if (F.status) qs.set('status', F.status);
    const d = await coApi(`/catalog/products?${qs}`);
    const search = input({ type: 'search', placeholder: 'Name, SKU, model or barcode', value: F.q, 'aria-label': 'Search products' });
    let t = 0;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { F.q = search.value.trim(); F.limit = 50; render(); }, 350); });
    const vSel = select([['', 'All vendors'], ...fo.vendors.map((v) => [v.id, v.name])], F.vendor);
    const cSel = select([['', 'All categories'], ...fo.categories.map((c) => [c.category, `${c.category} (${c.n})`])], F.category);
    const sSel = select([['', 'Any status'], ...fo.statuses.map((s) => [s, (STATUS[s] || [0, 0, s])[2]])], F.status);
    vSel.onchange = () => { F.vendor = vSel.value; F.limit = 50; render(); };
    cSel.onchange = () => { F.category = cSel.value; F.limit = 50; render(); };
    sSel.onchange = () => { F.status = sSel.value; F.limit = 50; render(); };
    const counts = Object.fromEntries(d.statuses.map((s) => [s.status, Number(s.n)]));
    const rows = d.items.map((p) => item({
      title: p.name,
      detail: [p.sku, p.vendor, [p.category, p.subcategory].filter(Boolean).join(' / '), p.kind !== 'stock' ? KIND[p.kind] : null,
        `${Number(p.available)} available`, Number(p.pieces) > 1 ? `${p.pieces} cartons` : null].filter(Boolean).join(' · '),
      amount: money(p.price_minor), badge: statusChip(p.status),
      why: p.below_map ? `Ticket ${money(p.price_minor)} is under the vendor's MAP of ${money(p.map_minor)}.` : null,
      onClick: () => openProduct(p.id),
    }));
    return frag(
      tilesRow(
        tile({ label: 'Active', value: String(counts.active || 0), tone: 'good', ic: 'ok', text: 'Selling now', onClick: () => drillStatus('active', 'Active products', counts.active || 0) }),
        tile({ label: 'Drafts', value: String(counts.draft || 0), tone: counts.draft ? 'warning' : 'neutral', ic: 'pending', text: 'Need a price or a look', onClick: () => drillStatus('draft', 'Draft products', counts.draft || 0) }),
        tile({ label: 'Floor samples', value: String(counts.floor_sample || 0), tone: 'neutral', ic: 'hold', text: 'Sell as-is, never reorder', onClick: () => drillStatus('floor_sample', 'Floor samples', counts.floor_sample || 0) }),
        tile({ label: 'Dropped', value: String(counts.drop || 0), tone: counts.drop ? 'serious' : 'neutral', ic: 'warn', text: 'Sell through, never reorder', onClick: () => drillStatus('drop', 'Dropped products', counts.drop || 0) })),
      el('div', { class: 'pc-toolbar' }, search, vSel, cSel, sSel),
      section('Products', `${d.total}`, null,
        el('div', { class: 'panel' }, rows.length ? rows : empty('Nothing matches.', 'Clear a filter, or add a product.', true),
          d.total > d.items.length ? el('button', { class: 'more-row', type: 'button', onclick: () => { F.limit = Math.min(F.limit + 100, 200); render(); } }, `Show more of ${d.total}`) : null)));
  }

  /** Every product in one status (company-wide, as the tile counts), a page of 200 at a time. */
  function drillStatus(status, title, expect) {
    return E.drill(title, async () => {
      const get = (offset) => coApi(`/catalog/products?${new URLSearchParams({ q: '', status, limit: '200', offset: String(offset) })}`);
      const first = await get(0);
      const row = (p) => item({ title: p.name, amount: money(p.price_minor), badge: statusChip(p.status),
        detail: [p.sku, p.vendor, [p.category, p.subcategory].filter(Boolean).join(' / '), `${Number(p.available)} available`].filter(Boolean).join(' · '), onClick: () => openProduct(p.id) });
      const panel = el('div', { class: 'panel' }, first.items.length ? first.items.map(row) : empty('None.', null, true));
      let shown = first.items.length;
      if (first.total > shown) {
        const more = el('button', { class: 'more-row', type: 'button', onclick: async () => {
          E.busy(more, true, 'Loading…');
          try { const r = await get(shown); shown += r.items.length; more.before(...r.items.map(row)); if (shown >= r.total || !r.items.length) more.remove(); }
          catch (e) { toast(friendly(e), 'critical'); } finally { if (more.isConnected) E.busy(more, false); }
        } }, `Show more of ${first.total}`);
        panel.append(more);
      }
      return frag(E.drillSum({ count: first.total, noun: 'product', expect: { count: expect }, note: 'Every product in this status, any vendor or category. The ticket price is on the right.' }), panel);
    });
  }
  E.opener('product', (id) => openProduct(id));

  async function openProduct(id) {
    const d = openDialog('Product', null, { wide: true, sheet: true });
    const reopen = () => { d.close(); openProduct(id); };
    await fillDialog(d, async () => {
      const x = await coApi(`/catalog/products/${id}`);
      const p = x.product;
      d.dlg.querySelector('h2').textContent = p.name;
      const acts = [
        el('button', { class: 'btn small primary', type: 'button', onclick: () => { d.close(); openEdit(x); } }, 'Edit'),
        el('button', { class: 'btn small', type: 'button', onclick: () => openStatus(p, reopen) }, 'Status…'),
        el('button', { class: 'btn small', type: 'button', onclick: () => openTags({ ids: id }) }, 'Price tag'),
        // A printable sheet for the customer: photos, options, dimensions, price and the store (opens in a new tab).
        el('a', { class: 'btn small', href: `/api/c/${S.co.id}/catalog/products/${id}/tear-sheet`, target: '_blank', rel: 'noopener' }, 'Tear sheet'),
        x.groups.length ? el('button', { class: 'btn small', type: 'button', onclick: () => openPriceCheck(x) }, 'Price it') : null,
      ];
      const kitTotal = x.kit.reduce((a, k) => a + Number(k.qty) * Number(k.price_minor), 0);
      return frag(
        el('div', { class: 'toolbar' }, statusChip(p.status), el('span', { class: 'grow' }), acts),
        p.status_note ? resultBox(p.status === 'active' ? 'neutral' : 'warning', 'info', 'Status note', p.status_note) : null,
        el('div', { class: 'panel' }, el('div', { class: 'facts' },
          fact('SKU', p.sku), fact('Kind', KIND[p.kind] || p.kind), fact('Vendor', p.vendor || '—'), fact('Vendor model', p.vendor_sku || '—'),
          fact('Category', [p.category, p.subcategory].filter(Boolean).join(' / ') || '—'), fact('Collection', [p.collection, p.color].filter(Boolean).join(', ') || '—'),
          fact('Ticket price', money(p.price_minor)), fact('Cost', money(p.cost_minor)), fact('Margin', pct(x.marginBps)),
          fact('MAP', p.map_minor == null ? 'None' : money(p.map_minor)), fact('MSRP', p.msrp_minor == null ? '—' : money(p.msrp_minor)),
          fact('Barcode', p.barcode || `${p.sku} (SKU)`), fact('Cube / weight', `${p.cubic_ft ?? '—'} cu ft · ${p.weight_lb ?? '—'} lb`),
          fact('Web', p.web_visible ? 'Shown online' : 'Not online'))),
        x.priceProblem ? resultBox('warning', 'warn', 'Not sellable as is', cap(x.priceProblem)) : null,
        x.price && x.price.promotion ? resultBox('good', 'ok', `On promotion: ${money(x.price.unitPriceMinor)}`, `${x.price.promotion.name}, saving ${money(x.price.promotion.savingsMinor)}.`) : null,
        section('Stock', null, null, el('div', { class: 'panel' }, x.stock.length ? x.stock.map((s) => item({
          title: s.location, amount: `${Number(s.available)} avail`, detail: `${Number(s.on_hand)} on hand · ${Number(s.reserved)} reserved · ${Number(s.on_order)} on order` }))
          : empty('No stock anywhere.', null, true))),
        p.kind === 'kit' ? section('In this package', x.kit.length ? `pieces ${money(kitTotal)} · package ${money(p.price_minor)}` : null,
          [el('button', { class: 'btn small', type: 'button', onclick: () => openKit(x, reopen) }, 'Edit pieces')],
          el('div', { class: 'panel' }, x.kit.length ? [...x.kit.map((k) => item({ title: `${Number(k.qty)} × ${k.name}`, detail: k.sku, amount: money(Number(k.qty) * Number(k.price_minor)) })),
            kitTotal > Number(p.price_minor) ? item({ title: 'Package saves', amount: money(kitTotal - Number(p.price_minor)) }) : null]
            : empty('No pieces yet.', 'A package needs at least two.', true))) : null,
        x.usedIn.length ? section('Sold in packages', null, null, el('div', { class: 'panel' }, x.usedIn.map((k) => item({ title: k.name, detail: `${k.sku} · ${Number(k.qty)} in each` })))) : null,
        ['configurable', 'special_order'].includes(p.kind) ? section('Options', x.applied.length ? `from ${x.applied.map((a) => a.name).join(', ')}` : null,
          [x.templates.length ? el('button', { class: 'btn small', type: 'button', onclick: () => openApplyTemplate(x, reopen) }, 'Apply template') : null,
           el('button', { class: 'btn small', type: 'button', onclick: () => openGroup(id, null, reopen) }, icon('plus'), 'Group')],
          el('div', { class: 'panel' }, x.groups.length ? x.groups.map((g) => el('div', { class: 'pc-group' },
            el('div', { class: 'toolbar' }, el('b', { text: `${g.label}${g.required ? '' : ' (optional)'}${g.multi ? ', pick any' : ''}` }), el('span', { class: 'grow' }),
              el('button', { class: 'btn small', type: 'button', onclick: () => openGroup(id, g, reopen) }, 'Edit')),
            el('div', { class: 'pc-opts' }, g.options.filter((o) => o.active).map((o) => chip('neutral', 'info',
              `${o.label}${Number(o.price_delta_minor) ? ` +${money(o.price_delta_minor)}` : ''}${o.lead_days ? ` · ${o.lead_days}d` : ''}${o.vendor_code ? ` · ${o.vendor_code}` : ''}`)))))
            : empty('No options yet.', 'Add a group, or apply the vendor’s template.', true))) : null,
        section('Cartons', x.pieces.length ? plural(x.pieces.length, 'piece') : null,
          [el('button', { class: 'btn small', type: 'button', onclick: () => openPieces(x, reopen) }, 'Edit cartons')],
          el('div', { class: 'panel' }, x.pieces.length ? x.pieces.map((c) => item({ title: `${c.seq}. ${c.label}`, amount: `${c.cubic_ft ?? '—'} cu ft`, detail: `${c.weight_lb ?? '—'} lb` }))
            : empty('Ships as one piece.', 'Add cartons when it comes in more than one box; the warehouse scans each.', true))),
        section('Images', x.images.length ? `${x.images.length}` : null,
          [el('button', { class: 'btn small', type: 'button', onclick: () => openImages(x, reopen) }, 'Edit images')],
          el('div', { class: 'panel' }, x.images.length ? el('div', { class: 'pc-thumbs' }, x.images.map((im) => proxyImg(p.id, im.seq, im.alt || p.name)))
            : empty('No images.', null, true))),
        section('Prices and promotions', null, null, el('div', { class: 'panel' }, (() => {
          const rows = [...x.lists.map((l) => item({ title: l.name, detail: `Price list ${l.code}`, amount: money(l.price_minor) })),
            ...x.promos.map((pr) => item({ title: pr.name, detail: `${shortDay(pr.starts_on)} to ${shortDay(pr.ends_on)} · reaches ${pr.reach}${pr.respect_map ? ' · stops at MAP' : ''}`,
              amount: pr.kind === 'percent' ? `${pr.pct_bps / 100}% off` : pr.kind === 'amount_off' ? `${money(pr.amount_minor)} off` : money(pr.amount_minor) }))];
          return rows.length ? rows : empty('Ticket price only.', 'No price list or promotion reaches this product.', true);
        })())),
        x.freight.length ? section('Landed cost by place', null, null, el('div', { class: 'panel' }, x.freight.map((f) => item({
          title: f.location, amount: money(f.landed_minor), detail: `cost + ${f.freight_bps / 100}%${Number(f.per_unit_minor) ? ` + ${money(f.per_unit_minor)}` : ''} freight` })))) : null);
    });
  }

  async function openEdit(x) {
    const fo = await form();
    const p = x ? x.product : { kind: 'stock', ship_class: 'delivery', taxable: true };
    const d = openDialog(x ? `Edit ${p.name}` : 'New product', x ? p.sku : 'A draft until it is priced, or active straight away', { wide: true });
    const f = {
      name: input({ value: p.name || '', maxlength: '200' }), sku: input({ value: p.sku || '', class: 'upper', maxlength: '40', placeholder: 'ASH-2930338' }),
      kind: select(fo.kinds.map((k) => [k, KIND[k] || k]), p.kind), vendor: select([['', 'No vendor'], ...fo.vendors.map((v) => [v.id, v.name])], p.vendor_id),
      vendorSku: input({ value: p.vendor_sku || '', class: 'upper' }), brand: input({ value: p.brand || '' }),
      category: input({ value: p.category || '', list: 'pc-cats' }), subcategory: input({ value: p.subcategory || '' }),
      collection: input({ value: p.collection || '' }), color: input({ value: p.color || '' }),
      price: moneyIn(p.price_minor ?? 0), cost: moneyIn(p.cost_minor ?? 0), map: moneyIn(p.map_minor), msrp: moneyIn(p.msrp_minor),
      barcode: input({ value: p.barcode || '', inputmode: 'numeric' }), shipClass: select(fo.shipClasses.map((s) => [s, cap(s)]), p.ship_class),
      cubicFt: input({ value: p.cubic_ft ?? '', inputmode: 'decimal' }), weightLb: input({ value: p.weight_lb ?? '', inputmode: 'decimal' }),
      description: el('textarea', { maxlength: '4000', value: p.description || '' }),
      taxable: el('input', { type: 'checkbox', checked: p.taxable !== false }), serialized: el('input', { type: 'checkbox', checked: !!p.serialized }),
      webVisible: el('input', { type: 'checkbox', checked: !!p.web_visible }),
      status: select([['draft', 'Draft (not for sale yet)'], ['active', 'Active (selling now)']], 'draft'),
    };
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => {
      const b = { name: f.name.value, sku: f.sku.value.trim().toUpperCase(), kind: f.kind.value, vendorId: f.vendor.value || null, vendorSku: f.vendorSku.value,
        brand: f.brand.value, category: f.category.value, subcategory: f.subcategory.value, collection: f.collection.value, color: f.color.value,
        price: f.price.value || '0', cost: f.cost.value || '0', map: f.map.value || null, msrp: f.msrp.value || null, barcode: f.barcode.value,
        shipClass: f.shipClass.value, cubicFt: f.cubicFt.value || null, weightLb: f.weightLb.value || null, description: f.description.value,
        taxable: f.taxable.checked, serialized: f.serialized.checked, webVisible: f.webVisible.checked };
      if (!x) b.status = f.status.value;
      act(save, async () => {
        const r = x ? await post(`/catalog/products/${p.id}`, b) : await post('/catalog/products', b);
        d.close();
        openProduct(x ? p.id : r.id);
        return r;
      }, x ? 'Saved' : 'Product added', { errorInto: errInto(err) });
    } }, x ? 'Save' : 'Add product');
    d.body.append(
      el('datalist', { id: 'pc-cats' }, fo.categories.map((c) => el('option', { value: c.category }))),
      el('div', { class: 'form-grid' },
        field('Name', f.name, null, true), field('SKU', f.sku), field('Kind', f.kind), x ? null : field('Starts as', f.status, 'Active needs a price'), field('Vendor', f.vendor), field('Vendor model', f.vendorSku),
        field('Brand', f.brand), field('Category', f.category), field('Subcategory', f.subcategory), field('Collection', f.collection), field('Color', f.color),
        el('div', { class: 'form-sec', text: 'Price' }),
        field('Ticket price', f.price), field('Cost', f.cost, 'What the vendor charges us, each'), field('MAP', f.map, 'Minimum advertised price; blank if none'), field('MSRP', f.msrp),
        el('div', { class: 'form-sec', text: 'Handling' }),
        field('Barcode (UPC)', f.barcode, 'Blank prints the SKU'), field('Ships as', f.shipClass), field('Cube (cu ft)', f.cubicFt), field('Weight (lb)', f.weightLb),
        field('Description', f.description, null, true),
        el('label', { class: 'check' }, f.taxable, 'Taxable'), el('label', { class: 'check' }, f.serialized, 'Tracked piece by piece'),
        el('label', { class: 'check' }, f.webVisible, 'Shown in the web store')),
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
    f.name.focus();
  }

  function openStatus(p, done) {
    const d = openDialog('Status', p.name);
    const words = { draft: 'Not for sale yet', active: 'Selling and reordering', floor_sample: 'A showroom piece, sold as-is; never reordered as stock',
      drop: 'The vendor dropped it; sell what is here, never reorder', discontinued: 'Not for sale at all' };
    const sel = select(Object.keys(STATUS).map((s) => [s, STATUS[s][2]]), p.status);
    const hint = el('span', { class: 'hint', text: words[p.status] });
    sel.onchange = () => { hint.textContent = words[sel.value]; };
    const note = el('textarea', { maxlength: '300', placeholder: 'Why: scuffed leg, vendor letter of Oct 3…', value: p.status_note || '' });
    const err = el('div');
    const go_ = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go_, () => post(`/catalog/products/${p.id}/status`, { status: sel.value, note: note.value }),
      'Status changed', { errorInto: errInto(err), close: () => { d.close(); done(); } }) }, 'Change status');
    d.body.append(el('label', { class: 'field' }, el('span', { text: 'Status' }), sel, hint), field('Note', note, 'Floor samples, drops and discontinued items say why'),
      el('div', { class: 'dlg-acts' }, go_, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  /** Rows of small forms that wrap into cards on a phone. */
  function rowEditor(rows, make, addLabel, cls) {
    const box = el('div', { class: 'pc-rows' });
    const add = (r) => {
      const parts = make(r || {});
      const row = el('div', { class: 'pc-row ' + (cls || '') }, parts.nodes, el('button', { class: 'btn small rm', type: 'button', onclick: () => row.remove() }, icon('x'), 'Remove'));
      row._read = parts.read;
      box.append(row);
    };
    rows.forEach(add);
    return { node: frag(box, el('button', { class: 'btn small', type: 'button', onclick: () => add(null) }, icon('plus'), addLabel)),
      read: () => [...box.children].map((r) => r._read()) };
  }

  function openPieces(x, done) {
    const d = openDialog('Cartons', `${x.product.name}: one row per box it ships in`, { wide: true });
    const ed = rowEditor(x.pieces, (c) => {
      const label = input({ value: c.label || '', placeholder: 'Headboard' }), cube = input({ value: c.cubic_ft ?? '', inputmode: 'decimal' }), wt = input({ value: c.weight_lb ?? '', inputmode: 'decimal' });
      return { nodes: [field('Label', label, null, true), field('Cube (cu ft)', cube), field('Weight (lb)', wt)],
        read: () => ({ label: label.value, cubicFt: cube.value || null, weightLb: wt.value || null }) };
    }, 'Carton', 'three');
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post(`/catalog/products/${x.product.id}/pieces`, { pieces: ed.read() }),
      'Cartons saved', { errorInto: errInto(err), close: () => { d.close(); done(); } }) }, 'Save cartons');
    d.body.append(el('p', { class: 'lead', text: 'The product’s cube and weight become the cartons’ totals, so trucks load right.' }), ed.node,
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  function openImages(x, done) {
    const d = openDialog('Images', x.product.name);
    const ta = el('textarea', { rows: '6', placeholder: 'https://…/front.jpg', value: x.images.map((i) => i.url).join('\n') });
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post(`/catalog/products/${x.product.id}/images`,
      { images: ta.value.split(/\s+/).filter(Boolean).map((url) => ({ url })) }), 'Images saved', { errorInto: errInto(err), close: () => { d.close(); done(); } }) }, 'Save images');
    d.body.append(field('Image addresses, one per line; the first is the main photo', ta), el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  async function openKit(x, done) {
    const d = openDialog('Package pieces', `${x.product.name} sells at ${money(x.product.price_minor)}`, { wide: true });
    const pick = await productPicker(null, (p) => p.id !== x.product.id && ['stock', 'configurable', 'special_order'].includes(p.kind));
    const opts = [...pick.options].map((o) => [o.value, o.textContent]);
    const ed = rowEditor(x.kit.map((k) => ({ productId: k.id, qty: Number(k.qty) })), (r) => {
      const s = select(opts, r.productId), qty = input({ type: 'number', min: '1', max: '99', value: r.qty || 1, inputmode: 'numeric' });
      return { nodes: [field('Piece', s, null, true), field('How many', qty)], read: () => ({ productId: s.value, qty: Number(qty.value) }) };
    }, 'Piece', 'three');
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post(`/catalog/products/${x.product.id}/kit`, { components: ed.read().filter((c) => c.productId) }),
      'Package saved', { errorInto: errInto(err), close: () => { d.close(); done(); } }) }, 'Save package');
    d.body.append(el('p', { class: 'lead', text: 'The package keeps its own price; its cost becomes the pieces’ cost. At the register a package sells as its pieces, the price spread across them.' }),
      ed.node, el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  /** The option-group editor: a group's code and label, then a row per option. */
  function groupEditor(g) {
    g = g || { required: true, options: [] };
    const code = input({ value: g.code || '', placeholder: 'fabric', maxlength: '40' }), label = input({ value: g.label || '', placeholder: 'Fabric' });
    const req = el('input', { type: 'checkbox', checked: g.required !== false }), multi = el('input', { type: 'checkbox', checked: !!g.multi });
    const ed = rowEditor((g.options || []).filter((o) => o.active !== false), (o) => {
      const oc = input({ value: o.code || '', placeholder: 'velvet-navy' }), ol = input({ value: o.label || '', placeholder: 'Velvet, navy' });
      const pd = moneyIn(o.price_delta_minor ?? 0), cd = moneyIn(o.cost_delta_minor ?? 0), ld = input({ type: 'number', min: '0', value: o.lead_days ?? 0 });
      const vc = input({ value: o.vendor_code || '', placeholder: 'VV-NAV' });
      return { nodes: [field('Code', oc), field('Label', ol), field('Price +', pd), field('Cost +', cd), field('Lead days', ld), field('Factory code', vc)],
        read: () => ({ code: oc.value.trim().toLowerCase(), label: ol.value, priceDelta: pd.value || '0', costDelta: cd.value || '0', leadDays: ld.value || 0, vendorCode: vc.value }) };
    }, 'Option', 'opt');
    return {
      node: frag(el('div', { class: 'form-grid' }, field('Group code', code, 'lower-case, like fabric'), field('Shown as', label),
        el('label', { class: 'check' }, req, 'Customer must choose'), el('label', { class: 'check' }, multi, 'Can pick more than one')), ed.node),
      read: () => ({ code: code.value.trim().toLowerCase(), label: label.value, required: req.checked, multi: multi.checked, options: ed.read() }),
    };
  }

  function openGroup(productId, g, done) {
    const d = openDialog(g ? `Edit ${g.label}` : 'New option group', 'Options left out are retired, so past orders still read', { wide: true });
    const ge = groupEditor(g);
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post(`/catalog/products/${productId}/options`, ge.read()),
      'Options saved', { errorInto: errInto(err), close: () => { d.close(); done(); } }) }, 'Save group');
    d.body.append(ge.node, el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  function openApplyTemplate(x, done) {
    const d = openDialog('Apply a template', x.product.name);
    const sel = select(x.templates.map((t) => [t.id, t.name]), x.templates[0] && x.templates[0].id);
    const err = el('div');
    const go_ = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go_, () => post(`/catalog/products/${x.product.id}/apply-template`, { templateId: sel.value }),
      (r) => `${plural(r.groups, 'option group')} applied`, { errorInto: errInto(err), close: () => { d.close(); done(); } }) }, 'Apply');
    d.body.append(el('p', { class: 'lead', text: 'Copies the template’s groups and options onto this product. Applying again refreshes them; groups the product has of its own stay.' }),
      field('Template', sel), el('div', { class: 'dlg-acts' }, go_, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  function openPriceCheck(x) {
    const d = openDialog('Price it', x.product.name);
    const sels = x.groups.map((g) => [g, select([['', g.required ? `Choose ${g.label.toLowerCase()}…` : 'None'], ...g.options.filter((o) => o.active).map((o) => [o.code, o.label])], '')]);
    const out = el('div');
    const run = el('button', { class: 'btn primary', type: 'button', onclick: async () => {
      const choices = {};
      for (const [g, s] of sels) if (s.value) choices[g.code] = s.value;
      try {
        const r = await coApi(`/catalog/price/${x.product.id}?choices=${encodeURIComponent(JSON.stringify(choices))}`);
        out.replaceChildren(resultBox('good', 'ok', money(r.unitPriceMinor), `${r.description}. Cost ${money(r.unitCostMinor)}${r.leadDays ? `, ${r.leadDays} more days to make` : ''}.`));
      } catch (e) { out.replaceChildren(resultBox('warning', 'warn', 'Can’t price that', friendly(e))); }
    } }, 'Price');
    d.body.append(sels.map(([g, s]) => field(g.label, s)), el('div', { class: 'dlg-acts' }, run), out);
  }

  // --------------------------------------------------------------- margins
  const M = { vendor: '', category: '', location: '' };
  async function tabMargins() {
    const fo = await form();
    const qs = new URLSearchParams();
    for (const k of Object.keys(M)) if (M[k]) qs.set(k, M[k]);
    const d = await coApi(`/catalog/margins?${qs}`);
    const vSel = select([['', 'All vendors'], ...fo.vendors.map((v) => [v.id, v.name])], M.vendor);
    const cSel = select([['', 'All categories'], ...fo.categories.map((c) => [c.category, c.category])], M.category);
    const lSel = E.storePicker(select(fo.locations.map((l) => [l.id, `Landed at ${l.name}`]), M.location || d.locationId));
    for (const [s, k] of [[vSel, 'vendor'], [cSel, 'category'], [lSel, 'location']]) s.onchange = () => { M[k] = s.value; render(); };
    const low = d.items.filter((x) => x.margin_bps != null && x.margin_bps < 4000);
    const marginRow = (x) => item({ title: x.name, amount: pct(x.margin_bps), onClick: () => openProduct(x.id),
      detail: `${x.sku} · ticket ${money(x.price_minor)} · landed ${money(x.landed_minor)} (cost ${money(x.cost_minor)} + freight ${money(x.freight_minor)})` });
    const rows = d.items.map((x) => item({
      title: x.name, amount: pct(x.margin_bps),
      detail: `${x.sku} · ticket ${money(x.price_minor)} · landed ${money(x.landed_minor)} (cost ${money(x.cost_minor)} + freight ${money(x.freight_minor)})${x.map_minor ? ` · MAP ${money(x.map_minor)}` : ''}`,
      badge: x.below_map ? chip('critical', 'warn', 'Under MAP') : x.promo_minor ? chip('warning', 'clock', `${x.promo_name}: ${money(x.promo_minor)} at ${pct(x.promo_margin_bps)}`) : x.status !== 'active' ? statusChip(x.status) : null,
      onClick: () => openProduct(x.id),
    }));
    return frag(
      tilesRow(tile({ label: 'Blended margin', value: pct(d.blendedBps), tone: 'neutral', ic: 'info', text: 'Ticket against landed cost',
          onClick: () => E.drillItems('Blended margin', [...d.items].sort((a, b) => (a.margin_bps ?? 99999) - (b.margin_bps ?? 99999)).map(marginRow),
            { noun: 'product', note: `${pct(d.blendedBps)} across these products: ticket against landed cost (cost plus freight to the store picked). Lowest margin first.` }) }),
        tile({ label: 'Under 40%', value: String(low.length), tone: low.length ? 'warning' : 'good', ic: low.length ? 'warn' : 'ok', text: 'Worth a second look',
          onClick: () => E.drillItems('Margin under 40%', low.map(marginRow), { noun: 'product', none: 'Every product is at 40% or more.' }) })),
      el('div', { class: 'pc-toolbar' }, lSel, vSel, cSel),
      section('Margin by product', `${d.items.length}`, null, el('div', { class: 'panel' }, rows.length ? capped(rows, 40, 'products') : empty('Nothing to show.', null, true))));
  }

  // ------------------------------------------------- promotions, price lists
  async function tabPricing() {
    const [pr, pl] = [await coApi('/catalog/promotions'), await coApi('/catalog/price-lists')];
    const tone = { live: ['good', 'ok', 'Live'], scheduled: ['neutral', 'clock', 'Scheduled'], over: ['neutral', 'none', 'Over'], ended: ['neutral', 'none', 'Ended early'] };
    return frag(
      section('Promotions', `${pr.promotions.filter((p) => p.state === 'live').length} live`, [el('button', { class: 'btn small primary', type: 'button', onclick: openPromo }, icon('plus'), 'Promotion')],
        el('div', { class: 'panel' }, pr.promotions.length ? capped(pr.promotions.map((p) => item({
          title: p.name, badge: chip(...tone[p.state]),
          amount: p.kind === 'percent' ? `${p.pct_bps / 100}% off` : p.kind === 'amount_off' ? `${money(p.amount_minor)} off` : money(p.amount_minor),
          detail: [`${shortDay(p.starts_on)} to ${shortDay(p.ends_on)}`, p.product ? `${p.product} (${p.sku})` : null, p.vendor, p.category, p.respect_map ? 'stops at MAP' : 'may go under MAP'].filter(Boolean).join(' · '),
          acts: p.state === 'live' || p.state === 'scheduled' ? [el('button', { class: 'btn small', type: 'button', onclick: async (e) => {
            const why = await askReason({ title: `End ${p.name}`, label: 'Why is it ending early?', confirm: 'End it' });
            if (why) act(e.target, () => post(`/catalog/promotions/${p.id}/end`, { reason: why }), 'Promotion ended');
          } }, 'End early')] : null })), 12, 'promotions') : empty('No promotions.', 'A sale with dates: percent or amount off, or a fixed price, for a product, a vendor or a category. The lowest price wins; they never stack.', true)),
        el('p', { class: 'foot', text: 'A promotion that respects MAP never takes the price under the vendor’s minimum advertised price.' })),
      section('Price lists', `${pl.lists.length}`, [el('button', { class: 'btn small', type: 'button', onclick: () => openList(null) }, icon('plus'), 'Price list')],
        el('div', { class: 'panel' }, pl.lists.length ? pl.lists.map((l) => el('div', { class: 'pc-group' },
          el('div', { class: 'toolbar' }, el('b', { text: `${l.name} · ${l.code}` }), l.active ? null : chip('neutral', 'pause', 'Off'), el('span', { class: 'grow' }),
            el('button', { class: 'btn small', type: 'button', onclick: () => openListPrice(l) }, 'Set a price')),
          l.items.length ? l.items.map((i) => item({ title: i.name, detail: `${i.sku} · ticket ${money(i.ticket_minor)}`, amount: money(i.price_minor) }))
            : el('div', { class: 'sub', text: 'No prices yet.' })))
          : empty('No price lists.', 'Contract, employee or outlet prices that replace the ticket price when asked for.', true))));
  }

  async function openPromo() {
    const fo = await form();
    const d = openDialog('New promotion', S.co.name, { wide: true });
    const name = input({ placeholder: 'Labor Day sale' }), kind = select([['percent', 'Percent off'], ['amount_off', 'Amount off'], ['fixed_price', 'Fixed price (one product)']], 'percent');
    const pctIn = input({ inputmode: 'decimal', placeholder: '15' }), amt = moneyIn(null);
    const reach = select([['category', 'A category'], ['vendor', 'A vendor'], ['product', 'One product']], 'category');
    const cat = select(fo.categories.map((c) => [c.category, c.category])), ven = select(fo.vendors.map((v) => [v.id, v.name])), prod = await productPicker(null);
    const from = input({ type: 'date', value: todayIso() }), to = input({ type: 'date' });
    const map = el('input', { type: 'checkbox', checked: true });
    const fPct = field('Percent off', pctIn), fAmt = field('Amount', amt), fCat = field('Category', cat), fVen = field('Vendor', ven), fProd = field('Product', prod, null, true);
    const sync = () => {
      fPct.hidden = kind.value !== 'percent'; fAmt.hidden = kind.value === 'percent';
      if (kind.value === 'fixed_price') reach.value = 'product';
      fCat.hidden = reach.value !== 'category'; fVen.hidden = reach.value !== 'vendor'; fProd.hidden = reach.value !== 'product';
    };
    kind.onchange = sync; reach.onchange = sync; sync();
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post('/catalog/promotions', {
      name: name.value, kind: kind.value, pct: pctIn.value, amount: amt.value, startsOn: from.value, endsOn: to.value, respectMap: map.checked,
      category: reach.value === 'category' ? cat.value : null, vendorId: reach.value === 'vendor' ? ven.value : null, productId: reach.value === 'product' ? prod.value : null,
    }), 'Promotion saved', { errorInto: errInto(err), close: d.close }) }, 'Save promotion');
    d.body.append(el('div', { class: 'form-grid' }, field('Name', name, null, true), field('Kind', kind), fPct, fAmt, field('Reaches', reach), fCat, fVen, fProd,
      field('Starts', from), field('Ends', to), el('label', { class: 'check wide' }, map, 'Never under the vendor’s MAP')),
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  function openList() {
    const d = openDialog('New price list', S.co.name);
    const code = input({ class: 'upper', placeholder: 'CONTRACT' }), name = input({ placeholder: 'Contract pricing' });
    const from = input({ type: 'date' }), to = input({ type: 'date' });
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post('/catalog/price-lists', { code: code.value, name: name.value, startsOn: from.value, endsOn: to.value }),
      'Price list saved', { errorInto: errInto(err), close: d.close }) }, 'Save');
    d.body.append(el('div', { class: 'form-grid' }, field('Code', code), field('Name', name), field('From (optional)', from), field('To (optional)', to)),
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  async function openListPrice(l) {
    const d = openDialog(`Price on ${l.name}`, 'Leave the price blank to take a product off the list');
    const prod = await productPicker(null), price = moneyIn(null);
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post(`/catalog/price-lists/${l.id}/items`, { items: [{ productId: prod.value, price: price.value || null }] }),
      'Price saved', { errorInto: errInto(err), close: d.close }) }, 'Save price');
    d.body.append(field('Product', prod), field('List price', price), el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  // -------------------------------------------------------------- templates
  async function tabTemplates() {
    const d = await coApi('/catalog/templates');
    return section('Special-order templates', `${d.templates.length}`, [el('button', { class: 'btn small primary', type: 'button', onclick: () => openTemplate(null) }, icon('plus'), 'Template')],
      el('p', { class: 'lead', text: 'A vendor’s fabric grades and finishes, or a category’s standard choices, kept once and applied to each product that offers them.' }),
      el('div', { class: 'panel' }, d.templates.length ? d.templates.map((t) => item({
        title: t.name, detail: [t.vendor, t.category, t.groups.map((g) => `${g.label}: ${g.options.filter((o) => o.active).length}`).join(', '), `on ${plural(Number(t.used), 'product')}`].filter(Boolean).join(' · '),
        onClick: () => openTemplate(t) })) : empty('No templates yet.', null, true)));
  }

  async function openTemplate(t) {
    const fo = await form();
    const d = openDialog(t ? t.name : 'New template', 'Groups and options; re-apply to products to refresh them', { wide: true });
    const name = input({ value: t ? t.name : '' }), ven = select([['', 'Any vendor'], ...fo.vendors.map((v) => [v.id, v.name])], t && t.vendor_id);
    const cat = select([['', 'Any category'], ...fo.categories.map((c) => [c.category, c.category])], t && t.category);
    const groups = [];
    const gbox = el('div');
    const addGroup = (g) => { const ge = groupEditor(g); groups.push(ge); gbox.append(el('div', { class: 'panel pad-g' }, ge.node)); };
    (t ? t.groups : [null]).forEach(addGroup);
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post('/catalog/templates', { id: t ? t.id : null, name: name.value,
      vendorId: ven.value || null, category: cat.value || null, groups: groups.map((g) => g.read()) }), 'Template saved', { errorInto: errInto(err), close: d.close }) }, 'Save template');
    d.body.append(el('div', { class: 'form-grid' }, field('Name', name, null, true), field('Vendor', ven), field('Category', cat)), gbox,
      el('button', { class: 'btn small', type: 'button', onclick: () => addGroup(null) }, icon('plus'), 'Option group'),
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  // ---------------------------------------------------------------- vendors
  async function tabVendors() {
    const d = await coApi('/catalog/vendors');
    const feedChip = (v) => !Number(v.feeds) ? null : Number(v.feeds_failing) ? chip('critical', 'fail', `${plural(Number(v.feeds_failing), 'feed')} failing`)
      : v.feeds_last_run ? chip('good', 'ok', `${plural(Number(v.feeds), 'feed')} ok`) : chip('neutral', 'pending', `${plural(Number(v.feeds), 'feed')}, not run yet`);
    return section('Vendors', `${d.vendors.length}`, [addVendorBtn()],
      el('p', { class: 'lead', text: 'Where orders go, the freight minimum for a prepaid truck, lead time, freight to each place, and how each vendor’s catalog comes in: by API, from its SFTP server, by email, or as a file you import.' }),
      d.vendors.length ? null : noVendors(),
      el('div', { class: 'panel' }, d.vendors.map((v) => item({
        title: v.name, amount: `${v.lead_days} days`, badge: feedChip(v),
        detail: [v.order_email || 'no order email', v.account_no ? `account ${v.account_no}` : null, v.sku_prefix ? `SKUs ${v.sku_prefix}-…` : null,
          Number(v.freight_min_minor) ? `freight min ${money(v.freight_min_minor)}` : null, v.freight_min_qty ? `${v.freight_min_qty} pieces min` : null,
          plural(Number(v.products), 'product'), v.last_import ? `imported ${shortDay(String(v.last_import).slice(0, 10))}` : null].filter(Boolean).join(' · '),
        why: [v.freight.length ? `Freight: ${v.freight.map((f) => `${f.location} ${f.freight_bps / 100}%${Number(f.per_unit_minor) ? ` + ${money(f.per_unit_minor)}` : ''}`).join(' · ')}` : null,
          v.inbound_address ? `Email files to ${v.inbound_address}` : null, Number(v.vendor_files) ? `${plural(Number(v.vendor_files), 'file connection')}${Number(v.files_quarantined) ? `, ${v.files_quarantined} quarantined` : ''}` : null].filter(Boolean).join(' · ') || null,
        acts: [el('button', { class: 'btn small primary', type: 'button', onclick: () => openApiSetup(v) }, 'Catalog connections'),
          el('button', { class: 'btn small', type: 'button', onclick: () => openVendor(v) }, 'Edit'),
          el('button', { class: 'btn small', type: 'button', onclick: () => openFreight(v) }, 'Freight'),
          el('button', { class: 'btn small', type: 'button', onclick: () => { IMP.vendorId = v.id; go('catalog', 'import'); } }, 'Import file'),
          E.vendorFiles ? el('button', { class: 'btn small', type: 'button', onclick: () => E.vendorFiles.open(v.id) }, 'Vendor files') : null,
          templateLink('xlsx', 'Download template')],
      }))));
  }

  /** Add a vendor from Catalog (the Payables form, reused); a new company has none until it does. */
  const addVendorBtn = (cls = 'btn small') => (E.openAddVendor ? el('button', { class: cls, type: 'button', onclick: () => E.openAddVendor() }, icon('plus'), 'Add vendor') : null);
  const noVendors = () => el('div', { class: 'panel pad' }, empty('No vendors yet. Add one, then set up how its catalog comes in: API, SFTP, email or file.',
    'Give it a merchandise category (furniture, appliances…) so it shows here; a new vendor may wait on the controller’s approval first.'), el('div', { class: 'dlg-acts' }, addVendorBtn('btn primary')));

  // ------------------------------------------------------- vendor API setup
  const PURPOSE = { products: 'Products', pricing: 'Prices', quantities: 'Quantities', freight: 'Freight by store', images: 'Photos', orders: 'Order sending', acknowledgments: 'Acknowledgments / ship notices' };
  const SECRET_LABEL = { apiKey: 'Key', token: 'Bearer token', password: 'Password', clientSecret: 'Client secret', atpKeyCode: 'ATP KeyCode', atpPassword: 'ATP password', sftpPassword: 'SFTP password', sftpKey: 'SFTP private key', sftpPassphrase: 'Key passphrase' };
  const feedHealth = (f) => f.running ? chip('warning', 'clock', 'Running') : !f.active ? chip('neutral', 'pause', 'Off') : f.last_ok === false ? chip('critical', 'fail', 'Failing')
    : f.last_ok ? chip('good', 'ok', 'OK') : chip('neutral', 'pending', 'Not run yet');
  const schedWords = (f) => f.purpose === 'orders' ? 'sends when you send a PO' : f.every_hours ? `every ${f.every_hours} h` : f.schedule_cron ? `cron ${f.schedule_cron}` : 'on demand';

  async function openApiSetup(v) {
    const d = openDialog(`${v.name} · Catalog connections`, 'How this vendor’s catalog, prices and quantities arrive: API, SFTP, email-in or file import', { wide: true, sheet: true });
    const again = () => { d.close(); openApiSetup(v); };
    await fillDialog(d, async () => {
      const x = await coApi(`/catalog/vendors/${v.id}/feeds`);
      const tplSel = select(x.templates, /ashley/i.test(v.name) ? 'ashley' : 'generic_json');
      const purSel = select(x.purposes.map((p) => [p, PURPOSE[p]]), 'products');
      const waySel = select([['api', 'API'], ['sftp', 'SFTP (their server)'], ['email', 'Email-in'], ['file', 'File import (by hand)']], 'api');
      waySel.addEventListener('change', () => { tplSel.closest('.field').hidden = waySel.value !== 'api'; });
      const addOne = el('button', { class: 'btn small primary', type: 'button', onclick: async () => {
        if (waySel.value === 'file') { d.close(); IMP.vendorId = v.id; go('catalog', 'import'); return; }
        if (waySel.value !== 'api') {
          const k = waySel.value;
          d.close(); openFeedEditor(v, { vendor_id: v.id, purpose: purSel.value, kind: k, template: 'blank', name: uniqueName(`${v.name} ${PURPOSE[purSel.value].toLowerCase()} (${k === 'sftp' ? 'SFTP' : 'email'})`, x.feeds),
            url: '', method: 'GET', response_format: 'csv', paging: { mode: 'none' }, auth: { mode: 'none' }, mapping: {}, options: {}, schedule_cron: k === 'sftp' ? '30 5 * * *' : null }, x);
          return;
        }
        const t = await coApi(`/catalog/vendors/${v.id}/feed-templates?template=${tplSel.value}`);
        let dr = t.drafts.find((y) => y.purpose === purSel.value) || { ...t.drafts[0], purpose: purSel.value, name: `${v.name} ${PURPOSE[purSel.value].toLowerCase()}`, mapping: {} };
        // one tap for another endpoint: same auth shape, borrowing the first feed's keys
        const first = x.feeds.find((f) => f.kind === 'api');
        if (first && !t.drafts.some((y) => y.purpose === purSel.value && tplSel.value !== 'blank')) dr = { ...dr, auth: { ...first.auth }, secrets_from_feed_id: first.id, options: { ...first.options, ...dr.options } };
        if (first && tplSel.value !== 'blank' && !dr.secrets_from_feed_id && first.auth && JSON.stringify(first.auth) === JSON.stringify(dr.auth)) dr.secrets_from_feed_id = first.id;
        dr.name = uniqueName(dr.name, x.feeds);
        d.close(); openFeedEditor(v, { ...dr, vendor_id: v.id }, x);
      } }, icon('plus'), 'Add');
      const addAll = tplSel.value === 'ashley' || /ashley/i.test(v.name) ? el('button', { class: 'btn small', type: 'button', onclick: () => act(addAll, async () => {
        const t = await coApi(`/catalog/vendors/${v.id}/feed-templates?template=ashley`);
        let n = 0;
        for (const dr of t.drafts) { if (x.feeds.some((f) => f.name === dr.name)) continue; await post('/catalog/feeds', { feed: { ...dr, vendor_id: v.id } }); n++; }
        return n;
      }, (n) => `${plural(n, 'Ashley feed')} added; type each one’s keys`, { close: again }) }, 'Add all Ashley feeds') : null;
      const hostBtn = el('button', { class: 'btn small', type: 'button', onclick: () => act(hostBtn, () => post(`/catalog/vendors/${v.id}/host-photos`),
        (r) => `${r.hosted} of ${r.total} photos hosted${r.failed ? `; ${r.failed} could not be fetched` : ''}`, { close: again }) }, 'Host photos now');
      const cards = x.feeds.map((f) => {
        const test = el('button', { class: 'btn small', type: 'button', onclick: () => runTest(test, f, null, null) }, 'Test');
        const run = el('button', { class: 'btn small primary', type: 'button', onclick: () => act(run, () => post(`/catalog/feeds/${f.id}/run`),
          (r) => (r.ok ? `Done: ${r.note}` : `Failed: ${r.note}`), { close: again }) }, 'Run now');
        const stop = el('button', { class: 'btn small', type: 'button', onclick: () => act(stop, () => post(`/catalog/feeds/${f.id}/stop`), 'Stop asked; the run ends at its next call', { close: again }) }, 'Stop runs');
        return item({
          title: f.name, badge: frag(chip('neutral', 'feed', PURPOSE[f.purpose] || f.purpose), ' ', feedHealth(f)),
          detail: [f.kind === 'api' ? hostOf(f.url) : f.kind === 'sftp' ? `SFTP ${f.options.host || ''}${f.options.path ? ` ${f.options.path}` : ''}${f.pin ? ` · key ${String(f.pin.fingerprint).slice(0, 19)}…` : ' · key not recorded yet'}`
            : f.kind === 'email' ? `Email from ${f.options.fromContains || 'no senders yet'}` : f.kind.toUpperCase(), f.kind === 'email' ? 'runs when the mail arrives' : schedWords(f),
            (f.files || []).length ? `last file ${f.files[0].name}, ${shortDay(String(f.files[0].taken_at).slice(0, 10))}` : null, f.secrets.length ? `keys ${f.secrets.map((k) => `${SECRET_LABEL[k.name] || k.name} ${k.masked}`).join(', ')}`
            : f.secrets_from_feed_id ? `keys from ${(x.feeds.find((y) => y.id === f.secrets_from_feed_id) || {}).name || 'another feed'}` : f.credential_ref ? `keys in ${f.credential_env}${f.credential_set ? '' : ' (not set)'}` : 'no keys',
            f.last_run_at ? `last run ${shortDay(String(f.last_run_at).slice(0, 10))}` : null].filter(Boolean).join(' · '),
          why: f.transport_note || f.last_note || null,
          acts: [el('button', { class: 'btn small', type: 'button', onclick: () => { d.close(); openFeedEditor(v, f, x); } }, 'Edit'),
            f.kind !== 'manual' && f.purpose !== 'orders' ? test : null, (f.kind === 'api' || f.kind === 'sftp') && f.purpose !== 'orders' ? run : null,
            (f.files || []).length ? el('button', { class: 'btn small', type: 'button', onclick: () => openFeedFiles(f) }, `Files (${f.files.length})`) : null,
            f.running ? stop : null, el('button', { class: 'btn small', type: 'button', onclick: () => openRuns(f) }, 'History')],
        });
      });
      return frag(
        x.secretKeySet ? null : resultBox('warning', 'warn', 'Passwords cannot be stored here yet', 'Add ERP_SECRET_KEY (32 random bytes, base64) to the service’s environment; then keys typed into a feed are kept encrypted. Until then a feed can read keys from an ERP_SECRET_<NAME> variable.'),
        el('div', { class: 'panel pad' }, el('div', { class: 'form-grid' }, field('Arrives by', waySel), field('For', purSel), field('Start from', tplSel)),
          el('div', { class: 'dlg-acts' }, addOne, addAll)),
        section('Vendor email', null, null, el('div', { class: 'panel pad' },
          x.mail && x.mail.address ? frag(el('p', { class: 'fine', text: `${v.name}’s own address. A file mailed here from a sender listed on one of its email-in feeds runs that feed; anything else is held.` }), copyRow(x.mail.address))
            : resultBox('warning', 'info', 'Inbound email is not set up on this server', 'Set ERP_INBOUND_EMAIL_ADDRESS and ERP_EMAIL_INBOUND_TOKEN; then each vendor gets its own address here.'),
          x.mail && x.mail.held.length ? el('button', { class: 'btn small', type: 'button', onclick: () => { d.close(); E.vendorFiles && E.vendorFiles.open(null); } }, `${x.mail.held.length} held for a person`) : null,
          el('div', { class: 'dlg-acts' }, E.vendorFiles ? el('button', { class: 'btn small', type: 'button', onclick: () => { d.close(); E.vendorFiles.open(v.id); } }, 'Vendor files (SFTP, HTTPS, email, EDI)') : null))),
        section('Feeds', `${x.feeds.length}`, null, el('div', { class: 'panel' }, cards.length ? cards : empty('No feeds yet.', 'Add one: products first, then prices, quantities and freight. Each endpoint is its own feed with its own key.', true))),
        section('Photos', `${x.photos.hosted} of ${x.photos.total} hosted`, [hostBtn],
          el('p', { class: 'foot', text: 'Vendor photo links are copied into the ERP’s own store and served from here, so they show even where outside images are blocked.' })),
        el('p', { class: 'foot', text: 'When a products feed and a prices feed both send cost, the prices feed wins for cost, MAP and MSRP; the products feed sets them only on products it creates. They meet on the vendor’s model number.' }));
    });
  }
  const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return u || 'no address'; } };
  const uniqueName = (n, list) => { let k = n, i = 2; while (list.some((f) => f.name === k)) k = `${n} ${i++}`; return k; };

  /** The files an SFTP or email-in feed took. */
  function openFeedFiles(f) {
    const d = openDialog(`${f.name} · files`, 'Newest first');
    d.body.append(el('div', { class: 'panel' }, (f.files || []).map((x) => item({ title: x.name, amount: x.rows == null ? null : `${x.rows} rows`,
      detail: [x.via === 'sftp' ? 'from SFTP' : `emailed by ${x.sender || 'someone'}`, `${Math.max(1, Math.round(Number(x.byte_size) / 1024))} KB`, shortDay(String(x.taken_at).slice(0, 10))].join(' · ') }))));
  }

  async function openRuns(f) {
    const d = openDialog(`${f.name} · runs`, 'Newest first');
    await fillDialog(d, async () => {
      const r = await coApi(`/catalog/feeds/${f.id}/runs`);
      return el('div', { class: 'panel' }, r.runs.length ? r.runs.map((x) => item({
        title: `${shortDay(String(x.started_at).slice(0, 10))} · ${x.trigger === 'schedule' ? 'scheduled' : x.run_by || 'by hand'}`, amount: `${x.rows} rows`,
        badge: !x.finished_at ? chip('warning', 'clock', 'Running') : chip(x.outcome === 'ok' ? 'good' : 'critical', x.outcome === 'ok' ? 'ok' : 'fail', x.outcome === 'ok' ? 'OK' : 'Failed'),
        detail: x.note || '' })) : empty('Not run yet.', null, true));
    });
  }

  /** Test a feed (saved, or the editor's unsaved state): one call, status, sample, mapped rows. */
  async function runTest(btn, f, draftFn, into) {
    const box = into || openDialog(`Test · ${f.name || 'new feed'}`, 'One call; nothing in the catalog changes', { wide: true }).body;
    box.replaceChildren(E.loadingNode('Calling the vendor…'));
    try {
      const body = draftFn ? draftFn() : { feed: { id: f.id } };
      const r = await post('/catalog/feeds/test', body);
      if (draftFn && r.columns && r.columns.length) LAST_COLS.splice(0, LAST_COLS.length, ...r.columns);
      if (draftFn) refreshColLists();
      const owner = ((E.S.person && E.S.person.roles) || []).includes('owner');
      const sftpPart = r.sftp ? frag(
        resultBox(r.sftp.changed ? 'critical' : r.sftp.fingerprint ? 'good' : 'critical', r.sftp.changed ? 'fail' : r.sftp.fingerprint ? 'ok' : 'fail',
          r.sftp.changed ? 'The server key changed' : r.sftp.fingerprint ? (r.sftp.firstTime ? 'Connected; server key recorded' : 'Connected; server key matches') : 'Not connected', r.sftp.words),
        el('div', { class: 'panel' }, el('div', { class: 'facts' }, fact('Server key', r.sftp.fingerprint || '—'), fact('Files matching', r.sftp.files == null ? '—' : String(r.sftp.files)),
          r.sftp.recorded && r.sftp.changed ? fact('Recorded key', r.sftp.recorded) : null)),
        (r.sftp.sample || []).length ? el('p', { class: 'foot', text: `On the server: ${r.sftp.sample.map((x2) => x2.name).join(', ')}` }) : null,
        r.sftp.changed && owner && f.id ? el('button', { class: 'btn primary', type: 'button', onclick: (ev) => act(ev.currentTarget, () => post(`/catalog/feeds/${f.id}/trust-key`, { fingerprint: r.sftp.fingerprint }),
          `New key trusted: ${r.sftp.fingerprint}`) }, `Trust the new key ${r.sftp.fingerprint}`) : r.sftp.changed ? el('p', { class: 'fine', text: 'Only the owner can trust a new server key; check with the vendor first.' }) : null) : null;
      if (r.address !== undefined) {
        box.replaceChildren(r.address ? frag(resultBox('good', 'ok', 'Ready for the vendor’s email', 'Ask the vendor to send this feed’s file to the address below (or forward it there). A file from one of the listed senders runs this feed; anyone else’s is held under Admin, Connections, Vendor files.'), copyRow(r.address))
          : resultBox('warning', 'info', 'Inbound email is not set up on this server', r.problem || ''));
        return;
      }
      box.replaceChildren(frag(sftpPart,
        resultBox(r.ok ? 'good' : 'warning', r.ok ? 'ok' : 'warn', r.ok ? `Works: ${r.recordsFound} records in the first ${r.sftp ? 'file' : 'call'}` : 'Not ready', r.problem || `Answer ${r.status}; ${r.columns.length} columns.`),
        el('div', { class: 'panel' }, el('div', { class: 'facts' }, fact('Answer', r.status == null ? '—' : String(r.status)), fact('Records', String(r.recordsFound)),
          fact('Calls', String(r.calls)), fact('Address', r.url || '—'))),
        r.missing && r.missing.length ? resultBox('warning', 'warn', 'Required fields with no column', r.missing.join(', ')) : null,
        r.rows && r.rows.length ? section('First rows, mapped to our fields', `${r.rows.length}`, null, el('div', { class: 'panel' }, r.rows.map((row, i) => item({
          title: `Row ${i + 1}${row.vendor_sku ? ` · ${row.vendor_sku}` : ''}`, detail: Object.entries(row).filter(([k]) => k !== 'vendor_sku').map(([k, v2]) => `${k.replace(/_/g, ' ')}: ${v2 || '—'}`).join(' · ') })))) : null,
        r.columns && r.columns.length ? el('details', {}, el('summary', { text: `Columns in the answer (${r.columns.length})` }), el('p', { class: 'foot', text: r.columns.join(' · ') })) : null,
        r.sample ? el('details', {}, el('summary', { text: 'Raw answer (first 2,000 characters, keys masked)' }), el('pre', { class: 'pc-raw', text: r.sample })) : null));
    } catch (e) { box.replaceChildren(resultBox('critical', 'fail', 'Test did not run', friendly(e))); }
  }
  /** An address to copy, wrapped on a phone. */
  const copyRow = (text) => (E.vendorFiles && E.vendorFiles.copyBox ? E.vendorFiles.copyBox(text) : el('p', { class: 'fine', text }));
  const LAST_COLS = [];
  const COL_LISTS = [];
  const refreshColLists = () => { for (const dl of COL_LISTS) if (dl.isConnected) dl.replaceChildren(...LAST_COLS.map((c2) => el('option', { value: c2 }))); };

  /** The feed editor: Connection, Authentication, Request, Response & paging, Freight by store, Price rule, ETL steps, Field mapping, Schedule. */
  function openFeedEditor(v, f0, x) {
    const f = JSON.parse(JSON.stringify(f0));
    f.query_params = f.query_params || {}; f.headers = f.headers || {}; f.paging = f.paging || { mode: 'none' }; f.batching = f.batching || {};
    f.auth = f.auth || { mode: 'none' }; f.options = f.options || {}; f.mapping = f.mapping || {}; f.etl = f.etl || [];
    LAST_COLS.splice(0, LAST_COLS.length, ...Object.values(f.mapping));
    const d = openDialog(f.id ? `Edit · ${f.name}` : `New feed · ${v.name}`, PURPOSE[f.purpose] || f.purpose, { wide: true, sheet: true });
    const back = () => { d.close(); openApiSetup(v); };
    const listId = `pc-cols-${Math.random().toString(36).slice(2)}`;
    const colList = el('datalist', { id: listId }); COL_LISTS.push(colList); refreshColLists();
    const sec = (t) => el('div', { class: 'form-sec', text: t });
    const chk = (on, label) => { const b = el('input', { type: 'checkbox', checked: !!on }); return [b, el('label', { class: 'check wide' }, b, label)]; };
    const optIn = (k, ph) => input({ value: f.options[k] ?? '', placeholder: ph || '' });
    // Connection
    const name = input({ value: f.name || '' }), purpose = select(x.purposes.map((p) => [p, PURPOSE[p]]), f.purpose);
    const kind = select([['api', 'API pull'], ['sftp', 'SFTP pull'], ['email', 'Email in'], ['manual', 'Manual upload']], f.kind || 'api');
    const method = select([['GET', 'GET'], ['POST', 'POST']], f.method || 'GET'), url = input({ value: f.url || '', placeholder: 'https://…', inputmode: 'url' });
    const [active, activeL] = chk(f.active !== false, 'On (runs on its schedule and from Run now)');
    const sftp = { host: optIn('host', 'sftp.vendor.com'), port: optIn('port', '22'), user: optIn('user', 'user'), path: optIn('path', '/outbound/ (folder or one file)'), pattern: optIn('pattern', '*.csv') };
    const email = { fromContains: optIn('fromContains', 'prices@vendor.com, @vendor.com'), subjectContains: optIn('subjectContains', 'price file'), emailPattern: input({ value: f.options.pattern || '', placeholder: '*price*.csv (blank = any CSV, XLSX or zip)' }) };
    sftp.maxMb = optIn('maxMb', '20');
    const sftpBox = el('div', { class: 'form-grid' }, field('Host', sftp.host), field('Port', sftp.port, '22, or the vendor’s own (1024 or above)'), field('User', sftp.user), field('Folder', sftp.path),
      field('File pattern', sftp.pattern, 'CSV, XLSX or a zip of them'), field('Largest file (MB)', sftp.maxMb),
      el('div', { class: 'wide' }, f.pin ? el('p', { class: 'fine', text: `Server key ${f.pin.fingerprint}, recorded by ${f.pin.pinned_by_name || 'someone'} ${shortDay(String(f.pin.pinned_at).slice(0, 10))}. A different key is refused.` })
        : el('p', { class: 'fine', text: 'Save, then Test this feed: it shows the server’s key and records it; a different key is refused after that.' })));
    const emailBox = el('div', { class: 'form-grid' }, field('Who sends it', email.fromContains, 'Addresses, or @vendor.com for anyone there'), field('Subject contains (optional)', email.subjectContains),
      field('Attachment pattern (optional)', email.emailPattern),
      el('div', { class: 'wide' }, x.mail && x.mail.address ? frag(el('p', { class: 'fine', text: `Ask ${v.name} to send the file to:` }), copyRow(x.mail.address))
        : el('p', { class: 'fine', text: 'Inbound email is not set up on this server yet (ERP_INBOUND_EMAIL_ADDRESS).' })));
    const transportNote = el('div');
    // Authentication
    const mode = select([['none', 'None'], ['header', 'Key in a header (e.g. Ocp-Apim-Subscription-Key)'], ['query', 'Key as a query parameter'], ['bearer', 'Bearer token'],
      ['basic', 'Basic (user + password)'], ['oauth2', 'OAuth (client id + secret traded for a token)'], ['auto', 'As the old connection did']], f.auth.mode || 'none');
    const a = { headerName: input({ value: f.auth.headerName || '', placeholder: 'Ocp-Apim-Subscription-Key' }), paramName: input({ value: f.auth.paramName || '', placeholder: 'api_key' }),
      authUrl: input({ value: f.auth.authUrl || '', placeholder: 'Token URL from the vendor’s API documents' }), scope: input({ value: f.auth.scope || '' }),
      clientId: input({ value: f.auth.clientId || '' }), user: input({ value: f.auth.user || '' }),
      atpExternalId: input({ value: f.auth.atpExternalId || '', placeholder: 'e.g. Company3989100' }), atpUser: input({ value: f.auth.atpUser || '', placeholder: 'e.g. AD_…_VP' }) };
    const have = Object.fromEntries((f.secrets || []).map((k) => [k.name, k.masked]));
    const secretBoxes = Object.keys(SECRET_LABEL).map((k) => {
      const i2 = k === 'sftpKey' ? el('textarea', { rows: '3', autocomplete: 'off', spellcheck: 'false', placeholder: have[k] ? `${have[k]} kept — paste to replace` : 'Paste an OpenSSH or PEM private key (optional)' })
        : el('input', { type: 'password', autocomplete: 'new-password', placeholder: have[k] ? `${have[k]} kept — type to replace` : 'type to set' });
      const clr = el('input', { type: 'checkbox' });
      return { k, i: i2, clr, node: field(SECRET_LABEL[k], i2, have[k] ? null : null, false), clrNode: have[k] ? el('label', { class: 'check' }, clr, `Clear the ${SECRET_LABEL[k].toLowerCase()}`) : null };
    });
    const others = (x.feeds || []).filter((y) => y.id !== f.id);
    const borrow = select([['', 'This feed’s own keys'], ...others.map((y) => [y.id, `Use ${y.name}’s keys`])], f.secrets_from_feed_id || '');
    const cref = input({ value: f.credential_ref || '', placeholder: 'secret://vendor/ashley/pricing (optional)' });
    // Request
    const reqFmt = select([['query', 'Query parameters only'], ['json', 'JSON body'], ['xml', 'XML / SOAP body']], f.request_format || 'query');
    const kv = (obj, kph, vph) => rowEditor(Object.entries(obj).map(([k, v2]) => ({ k, v: v2 })), (r) => {
      const ki = input({ value: r.k || '', placeholder: kph }), vi = input({ value: r.v || '', placeholder: vph });
      return { nodes: [field('Name', ki), field('Value', vi)], read: () => [ki.value.trim(), vi.value] };
    }, 'Add', 'three');
    const qp = kv(f.query_params, 'Customer', '3989100 or {{customer}}'), hd = kv(f.headers, 'SOAPAction', 'non-secret header value');
    const body = el('textarea', { rows: '6', value: f.body_template || '', placeholder: '{"skus": [{{#skus}}"{{sku}}",{{/skus}}], "customer": "{{customer}}"}' });
    const o = { customer: optIn('customer', 'your customer number with them'), shipTo: optIn('shipTo', 'ship-to number'), duns: optIn('duns', '052738531') };
    // Response & paging
    const resFmt = select([['json', 'JSON'], ['xml', 'XML'], ['csv', 'CSV']], f.response_format || 'json');
    const recPath = input({ value: f.records_path || '', placeholder: 'JSON path (data.items) or XML element (itemAdvice); blank = find the list' });
    const unwrap = optIn('unwrap', 'XML element whose text is the real document (ATPRequestResult)');
    const pmode = select([['none', 'One call'], ['page', 'Page + size, until a short page'], ['offset', 'Offset + limit'], ['cursor', 'Cursor from the answer'], ['link', 'Next link (answer or Link header)']], f.paging.mode || 'none');
    const pg = (k, ph) => input({ value: f.paging[k] ?? '', placeholder: ph });
    const p = { size: pg('size', '250'), pageParam: pg('pageParam', 'page'), sizeParam: pg('sizeParam', 'limit'), offsetParam: pg('offsetParam', 'offset'),
      cursorPath: pg('cursorPath', 'paging.next_cursor'), cursorParam: pg('cursorParam', 'cursor'), nextPath: pg('nextPath', 'links.next'), totalPath: pg('totalPath', 'metadata.totalRecords') };
    const bsize = input({ type: 'number', min: '0', value: f.batching.size ?? '', placeholder: '40 (blank = no batching)' }), bdelay = input({ type: 'number', min: '0', value: f.batching.delayMs ?? '', placeholder: '1000' });
    const rate = input({ type: 'number', min: '0', value: f.rate_limit_ms ?? 0 }), tmo = input({ type: 'number', min: '1', value: Math.round((f.timeout_ms ?? 30000) / 1000) });
    // Freight by store
    const ships = (x.locations || []).map((l) => [l, input({ value: (f.options.shipTos || {})[l.id] || '', placeholder: 'their ship-to no.' })]);
    const useCodes = el('button', { class: 'btn small', type: 'button', onclick: () => { for (const [l, i2] of ships) if (!i2.value) i2.value = l.code; } }, 'Fill from store codes');
    // Price rule
    const prMode = select([['none', 'Leave retail alone'], ['markup', 'Set retail from cost × markup']], (f.options.priceRule || {}).mode || 'none');
    const prMark = input({ inputmode: 'decimal', value: (f.options.priceRule || {}).markupBps ? (f.options.priceRule.markupBps / 10000).toFixed(2) : '', placeholder: '2.00 (= 2× cost)' });
    const [pr99, pr99L] = chk((f.options.priceRule || {}).ending99, 'End prices in .99 (never under MAP)');
    // ETL
    const ops = [['subtract', '−'], ['percent_off', '− %'], ['add', '+'], ['multiply', '×'], ['fill_blank', 'if blank →']];
    const etl = rowEditor(f.etl, (st) => {
      const out = input({ value: st.out || '', placeholder: 'Promo Cost' }), aIn = input({ value: st.a || '', list: listId, placeholder: 'column' });
      const op = select(ops, st.op || 'subtract'), bIn = input({ value: st.b || '', list: listId, placeholder: 'column or number' });
      return { nodes: [field('New column', out), field('=', aIn), field('Operation', op), field('Column or number', bIn)], read: () => ({ out: out.value.trim(), a: aIn.value.trim(), op: op.value, b: bIn.value.trim() }) };
    }, 'Step', 'opt');
    // Mapping
    const mapBox = el('div', { class: 'pc-map' });
    const mapIns = {};
    const drawMap = () => {
      mapBox.replaceChildren(...(x.fields[purpose.value] || []).map((fl) => {
        const i2 = mapIns[fl.name] || (mapIns[fl.name] = input({ value: f.mapping[fl.name] || '', list: listId, placeholder: 'vendor field' }));
        return el('label', { class: 'field' }, el('span', {}, fl.name.replace(/_/g, ' '), fl.required ? el('span', { class: 'pc-req', text: ' *' }) : null), i2, fl.help ? el('span', { class: 'hint', text: fl.help }) : null);
      }));
    };
    // Schedule
    const every = input({ type: 'number', min: '1', max: '720', value: f.every_hours ?? '', placeholder: '24' }), cron = input({ value: f.schedule_cron || '', placeholder: 'or cron: 15 5 * * *' });
    const alert = optIn('alertEmail', 'who hears when it starts failing');
    const [hostPh, hostPhL] = chk(f.options.hostPhotos, 'Host this vendor’s photos here after each products run');

    const authF = { headerName: field('Key header name', a.headerName, 'Ashley: Ocp-Apim-Subscription-Key'), paramName: field('Key parameter name', a.paramName),
      authUrl: field('OAuth token URL', a.authUrl, null, true), scope: field('OAuth scope', a.scope), clientId: field('Client ID', a.clientId), user: field('User', a.user),
      atpExternalId: field('ATP External ID', a.atpExternalId), atpUser: field('ATP user', a.atpUser) };
    const bodyF = field('Body template — {{customer}} {{shipTo}} {{page}} {{pageSize}} {{offset}} {{cursor}} {{#skus}}{{sku}}{{/skus}} {{skuList}} {{cred.name}} {{#xml}}…{{/xml}}', body, null, true);
    const groups = { sftp: sftpBox, email: emailBox };
    const freightSec = el('div', {}, sec('Freight by store'), el('p', { class: 'foot', text: 'The API is asked once per ship-to (four at a time); a store it will not quote is skipped and named.' }),
      el('div', { class: 'form-grid' }, ships.map(([l, i2]) => field(`${l.name} (${l.code})`, i2))), useCodes,
      (f.options.unmatchedShipTos || []).length ? resultBox('warning', 'warn', 'Ship-to numbers to place', `From the catalog app, not matched to a store: ${f.options.unmatchedShipTos.join(', ')}. Type each beside its store.`) : null);
    const priceSec = el('div', {}, sec('Price rule'), el('div', { class: 'form-grid' }, field('Retail', prMode), field('Markup', prMark), pr99L));
    const sync = () => {
      const k = kind.value;
      for (const [g, n] of Object.entries(groups)) n.hidden = k !== g;
      transportNote.replaceChildren(k === 'sftp' ? resultBox('neutral', 'info', 'Pulled from the vendor’s SFTP server', 'On its schedule, each new file (CSV, XLSX or a zip of them) runs through this feed’s ETL steps and field mapping, as an API answer does. A file is never applied twice.')
        : k === 'email' ? resultBox('neutral', 'info', 'Taken from the vendor’s email', 'When the vendor mails the file to its address below, the attachment runs through this feed’s ETL steps and field mapping. Mail from anyone not listed is held for a person.') : '');
      method.closest('.field').hidden = url.closest('.field').hidden = k !== 'api';
      freightSec.hidden = purpose.value !== 'freight';
      bodyF.hidden = reqFmt.value === 'query' && !body.value.trim();
      // Only the boxes the chosen authentication uses; a key header can ride along with OAuth or basic.
      const m = mode.value, atp = purpose.value === 'quantities' || !!a.atpExternalId.value;
      const showAuth = { headerName: ['header', 'oauth2', 'basic', 'auto'].includes(m), paramName: m === 'query', authUrl: m === 'oauth2', scope: m === 'oauth2', clientId: m === 'oauth2',
        user: m === 'basic' || m === 'auto', atpExternalId: atp, atpUser: atp };
      for (const [k2, n] of Object.entries(authF)) n.hidden = !showAuth[k2];
      const showSec = { apiKey: ['header', 'query', 'oauth2', 'basic', 'auto'].includes(m), token: m === 'bearer' || m === 'auto', password: m === 'basic' || m === 'auto',
        clientSecret: m === 'oauth2' || m === 'auto', atpKeyCode: atp, atpPassword: atp, sftpPassword: kind.value === 'sftp', sftpKey: kind.value === 'sftp', sftpPassphrase: kind.value === 'sftp' };
      for (const sb of secretBoxes) if (sb.wrap) sb.wrap.hidden = !(showSec[sb.k] || have[sb.k]);
      priceSec.hidden = purpose.value !== 'pricing';
      drawMap();
    };
    kind.onchange = sync; purpose.onchange = sync; mode.onchange = sync; reqFmt.onchange = sync;

    const collect = () => {
      const mapping = {}; for (const [k, i2] of Object.entries(mapIns)) if (i2.value.trim() && (x.fields[purpose.value] || []).some((fl) => fl.name === k)) mapping[k] = i2.value.trim();
      const num = (i2) => (i2.value === '' ? undefined : Number(i2.value));
      const paging = { mode: pmode.value };
      for (const [k, i2] of Object.entries(p)) if (i2.value.trim()) paging[k] = k === 'size' ? Number(i2.value) : i2.value.trim();
      const options = { ...f.options };
      const { emailPattern, ...emailRest } = email;
      const byKind = kind.value === 'sftp' ? sftp : kind.value === 'email' ? { ...emailRest, pattern: emailPattern } : {};
      for (const [k, i2] of Object.entries({ ...o, ...byKind, unwrap, alertEmail: alert })) { if (i2.value.trim()) options[k] = i2.value.trim(); else delete options[k]; }
      options.shipTos = Object.fromEntries(ships.filter(([, i2]) => i2.value.trim()).map(([l, i2]) => [l.id, i2.value.trim()]));
      options.priceRule = prMode.value === 'markup' ? { mode: 'markup', markupBps: Math.round(Number(prMark.value || 0) * 10000), ending99: pr99.checked } : { mode: 'none' };
      options.hostPhotos = hostPh.checked;
      const auth = { mode: mode.value };
      for (const [k, i2] of Object.entries(a)) if (i2.value.trim()) auth[k] = i2.value.trim();
      const secrets = {};
      for (const sb of secretBoxes) { if (sb.clr.checked) secrets[sb.k] = null; else if (sb.i.value) secrets[sb.k] = sb.i.value; }
      return { feed: { id: f.id || null, vendor_id: v.id, purpose: purpose.value, name: name.value.trim(), template: f.template || 'blank', kind: kind.value, method: method.value,
        url: url.value.trim(), request_format: reqFmt.value, query_params: Object.fromEntries(qp.read().filter(([k]) => k)), headers: Object.fromEntries(hd.read().filter(([k]) => k)),
        body_template: body.value, response_format: resFmt.value, records_path: recPath.value.trim(), paging,
        batching: num(bsize) ? { size: num(bsize), delayMs: num(bdelay) ?? 0 } : {}, auth, credential_ref: cref.value.trim() || null, secrets_from_feed_id: borrow.value || null,
        mapping, options, etl: etl.read().filter((st) => st.out && st.a), schedule_cron: cron.value.trim() || null, every_hours: num(every) ?? null, active: active.checked,
        rate_limit_ms: Number(rate.value || 0), timeout_ms: Math.round(Number(tmo.value || 30) * 1000) }, secrets };
    };
    const err = el('div'), testBox = el('div');
    const save = (thenRun) => async (e) => {
      const btn = e.currentTarget;
      await act(btn, async () => {
        const r = await post('/catalog/feeds', collect());
        if (thenRun) { const rr = await post(`/catalog/feeds/${r.id}/run`); toast(rr.ok ? `Done: ${rr.note}` : `Failed: ${rr.note}`, rr.ok ? 'good' : 'critical'); }
        return r;
      }, thenRun ? null : 'Feed saved', { errorInto: errInto(err), close: back });
    };
    const testBtn = el('button', { class: 'btn', type: 'button', onclick: () => runTest(testBtn, f, collect, testBox) }, 'Test this feed');
    d.body.append(colList,
      el('div', { class: 'form-grid' },
        sec('Connection'), field('Name', name, null, true), field('Purpose', purpose), field('Arrives by', kind), field('Method', method), field('Address', url, 'https only; placeholders like {{customer}} work here too', true), activeL),
      transportNote, sftpBox, emailBox,
      el('div', { class: 'form-grid' },
        sec('Authentication'), field('How', mode, null, true), authF.headerName, authF.paramName, authF.authUrl, authF.scope, authF.clientId, authF.user,
        authF.atpExternalId, authF.atpUser,
        el('p', { class: 'foot wide', text: 'Keys and passwords are stored encrypted and never shown again; leave a box empty to keep what is there.' }),
        secretBoxes.map((sb) => { sb.wrap = el('div', { class: 'wide' }, sb.node, sb.clrNode); return sb.wrap; }), field('Or use keys from', borrow), field('Or an environment secret', cref, f.credential_env ? `reads ${f.credential_env}${f.credential_set ? '' : ' (not set)'}` : 'ERP_SECRET_<NAME> on the server')),
      el('div', { class: 'form-grid' }, sec('Request'), field('Format', reqFmt), field('Customer no.', o.customer), field('Ship-to', o.shipTo), field('DUNS (Ashley ATP)', o.duns)),
      el('p', { class: 'foot', text: 'Query parameters' }), qp.node, el('p', { class: 'foot', text: 'Headers (no keys here; keys go under Authentication)' }), hd.node,
      bodyF,
      el('div', { class: 'form-grid' }, sec('Response & paging'), field('Answer format', resFmt), field('Records are at', recPath, null, true), field('XML inside element', unwrap, null, true),
        field('Paging', pmode, null, true), field('Page size', p.size), field('Page parameter', p.pageParam), field('Size parameter', p.sizeParam), field('Offset parameter', p.offsetParam),
        field('Cursor at (answer)', p.cursorPath), field('Cursor parameter', p.cursorParam), field('Next link at (answer)', p.nextPath), field('Total records at', p.totalPath),
        field('Models per call', bsize, 'For APIs that take a list of models (Ashley ATP: 40)'), field('Pause between calls (ms)', bdelay), field('Rate limit (ms between pages)', rate), field('Timeout (seconds)', tmo)),
      freightSec, priceSec,
      el('div', {}, sec('ETL steps'), el('p', { class: 'foot', text: 'Computed columns before mapping, as in the catalog app: Promo Cost = RegularCost − Discount. No discount means no promo.' }), etl.node),
      el('div', {}, sec('Field mapping'), el('p', { class: 'foot', text: 'Our field ← their field. Test first and the boxes offer the columns the answer has; blank ones are recognised by name when they can be.' }), mapBox),
      el('div', { class: 'form-grid' }, sec('Schedule'), field('Every N hours', every), field('Or cron (UTC)', cron), field('Alert email', alert, 'Told once when the feed starts failing (needs a mail service)', true), hostPhL),
      el('div', { class: 'dlg-acts' }, testBtn, el('button', { class: 'btn primary', type: 'button', onclick: save(false) }, 'Save'),
        el('button', { class: 'btn', type: 'button', onclick: save(true) }, 'Save & run now'), el('button', { class: 'btn', type: 'button', onclick: back }, 'Back')),
      err, testBox);
    sync();
  }

  function openVendor(v) {
    const d = openDialog(v.name, 'Ordering details');
    const f = { orderEmail: input({ type: 'email', value: v.order_email || '' }), accountNo: input({ value: v.account_no || '' }), skuPrefix: input({ class: 'upper', value: v.sku_prefix || '', maxlength: '8' }),
      leadDays: input({ type: 'number', min: '0', max: '365', value: v.lead_days }), freightMin: moneyIn(v.freight_min_minor), freightMinQty: input({ type: 'number', min: '0', value: v.freight_min_qty }),
      notes: el('textarea', { value: v.notes || '' }) };
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post(`/catalog/vendors/${v.id}`, Object.fromEntries(Object.entries(f).map(([k, n]) => [k, n.value]))),
      'Vendor saved', { errorInto: errInto(err), close: d.close }) }, 'Save');
    d.body.append(el('div', { class: 'form-grid' }, field('Order email', f.orderEmail, null, true), field('Our account no.', f.accountNo), field('SKU prefix', f.skuPrefix, 'New imports become PREFIX-model'),
      field('Lead time (days)', f.leadDays), field('Freight minimum ($)', f.freightMin), field('Or pieces minimum', f.freightMinQty), field('Notes', f.notes, null, true)),
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  async function openFreight(v) {
    const fo = await form();
    const d = openDialog(`Freight from ${v.name}`, 'Percent of cost, a flat amount per unit, or both');
    const loc = E.storePicker(select(fo.locations.map((l) => [l.id, l.name])));
    const pctIn = input({ inputmode: 'decimal', placeholder: '6' }), per = moneyIn(null);
    const fill = () => { const f = v.freight.find((x) => x.location_id === loc.value); pctIn.value = f ? f.freight_bps / 100 : ''; per.value = f ? (Number(f.per_unit_minor) / 100).toFixed(2) : ''; };
    loc.onchange = fill; fill();
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post(`/catalog/vendors/${v.id}/freight`, { locationId: loc.value, pct: pctIn.value || 0, perUnit: per.value || '0' }),
      'Freight saved', { errorInto: errInto(err), close: d.close }) }, 'Save');
    d.body.append(field('To', loc), el('div', { class: 'form-grid' }, field('Percent of cost', pctIn), field('Per unit ($)', per)),
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  /** The catalog import template (one heading per import field, in order): a plain link, so the browser saves it with the session. */
  const templateLink = (ext, label) => el('a', { class: 'btn small', href: `/api/c/${E.S.co.id}/catalog/import/template.${ext}`, download: `vendor-catalog-template.${ext}` }, label);
  const b64 = async (f) => { const bytes = new Uint8Array(await f.arrayBuffer()); let s2 = ''; for (let i = 0; i < bytes.length; i += 0x8000) s2 += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s2); };

  // ----------------------------------------------------------------- import
  const IMP = { vendorId: '', csv: '', filename: '', cols: null, mapping: {}, runId: null, show: 'change' };
  async function tabImport() {
    const fo = await form();
    const runs = (await coApi('/catalog/import/runs')).runs;
    const step = el('div');
    const vSel = select([['', 'Which vendor is this file from?'], ...fo.vendors.map((v) => [v.id, v.name])], IMP.vendorId);
    vSel.onchange = () => { IMP.vendorId = vSel.value; };
    const file = el('input', { type: 'file', accept: '.csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > 8e6) { toast('That file is over 8 MB; split it.', 'critical'); return; }
      const isX = /\.xlsx$/i.test(f.name);
      IMP.xlsx = isX ? await b64(f) : null; IMP.csv = isX ? '' : await f.text(); IMP.filename = f.name; IMP.runId = null;
      try { IMP.cols = await post('/catalog/import/columns', isX ? { xlsx: IMP.xlsx } : { csv: IMP.csv }); IMP.mapping = { ...IMP.cols.mapping }; drawMap(); }
      catch (e) { step.replaceChildren(resultBox('critical', 'fail', 'Couldn’t read it', friendly(e))); }
    };
    const drawMap = () => {
      const c = IMP.cols;
      const sels = c.fields.map((f) => {
        const s = select([['', '— not in this file —'], ...c.headers.map((h) => [h, h])], IMP.mapping[f.name] || '');
        s.onchange = () => { IMP.mapping[f.name] = s.value; miss(); };
        return el('label', { class: 'field' }, el('span', {}, f.name.replace(/_/g, ' '), f.required ? el('span', { class: 'pc-req', text: ' *' }) : null), s, f.help ? el('span', { class: 'hint', text: f.help }) : null);
      });
      const missBox = el('div');
      const miss = () => {
        const m = c.fields.filter((f) => f.required && !IMP.mapping[f.name]).map((f) => f.name.replace(/_/g, ' '));
        missBox.replaceChildren(m.length ? resultBox('warning', 'warn', 'Required fields with no column', m.join(', ')) : resultBox('good', 'ok', 'Every required field has a column', 'Preview shows what building would add and change, before anything does.'));
      };
      miss();
      const pv = el('button', { class: 'btn primary', type: 'button', onclick: () => act(pv, async () => {
        const r = await post('/catalog/import/preview', { vendorId: IMP.vendorId, ...(IMP.xlsx ? { xlsx: IMP.xlsx } : { csv: IMP.csv }), filename: IMP.filename, mapping: IMP.mapping });
        IMP.runId = r.runId; IMP.show = r.change ? 'change' : 'add';
        return r;
      }, (r) => `${r.rows} rows read`) }, 'Preview');
      step.replaceChildren(section(`Map the columns · ${IMP.filename}`, `${c.headers.length} columns`, null,
        el('div', { class: 'panel pad' }, el('div', { class: 'pc-map' }, sels)), missBox,
        c.sample.length ? el('p', { class: 'foot', text: `First row: ${c.sample[0].slice(0, 6).join(' · ')}` }) : null,
        el('div', { class: 'dlg-acts' }, pv)));
    };
    if (IMP.runId) {
      const r = await coApi(`/catalog/import/runs/${IMP.runId}?action=${IMP.show}`);
      const run = r.run;
      const rows = r.rows.map((x) => item({
        title: `Row ${x.row_no}${x.vendor_sku ? ` · ${x.vendor_sku}` : ''}`,
        detail: x.action === 'change' ? Object.entries(x.changes).map(([k, [a, b]]) => `${k.replace(/_minor$/, '').replace(/_/g, ' ')}: ${k.endsWith('_minor') ? money(a) : a ?? '—'} → ${k.endsWith('_minor') ? money(b) : b}`).join(' · ')
          : x.action === 'add' ? [x.fields.name, x.fields.cost_minor ? `cost ${money(x.fields.cost_minor)}` : null, x.fields.price_minor ? `retail ${money(x.fields.price_minor)}` : null].filter(Boolean).join(' · ') : x.fields.name || '',
        why: x.message ? cap(x.message) : null }));
      const apply = run.status === 'previewed' ? el('button', { class: 'btn primary', type: 'button', onclick: () => act(apply, () => post(`/catalog/import/runs/${run.id}/apply`),
        (x) => `Built: ${x.add} added, ${x.change} changed`) }, 'Build it') : null;
      const drop = run.status === 'previewed' ? el('button', { class: 'btn', type: 'button', onclick: () => act(drop, async () => { await post(`/catalog/import/runs/${run.id}/abandon`); IMP.runId = null; }, 'Set aside') }, 'Set aside') : null;
      step.replaceChildren(
        tilesRow(tile({ label: 'Add', value: String(run.added), tone: 'good', ic: 'plus', text: 'New products', onClick: () => { IMP.show = 'add'; render(); } }),
          tile({ label: 'Change', value: String(run.changed), tone: run.changed ? 'warning' : 'neutral', ic: 'refresh', text: 'Cost, price, details', onClick: () => { IMP.show = 'change'; render(); } }),
          tile({ label: 'Unchanged', value: String(run.unchanged), tone: 'neutral', ic: 'ok', text: 'Same as on file', onClick: () => { IMP.show = 'same'; render(); } }),
          tile({ label: 'Skipped', value: String(run.skipped), tone: run.skipped ? 'serious' : 'neutral', ic: 'warn', text: 'Each says why', onClick: () => { IMP.show = 'skip'; render(); } })),
        resultBox(run.status === 'applied' ? 'good' : 'neutral', run.status === 'applied' ? 'ok' : 'info', run.status === 'applied' ? 'Built' : 'Preview: nothing has changed yet', `${run.vendor} · ${run.filename || 'file'} · ${run.rows} rows`),
        el('div', { class: 'toolbar' }, seg([['add', 'Added'], ['change', 'Changed'], ['skip', 'Skipped'], ['same', 'Unchanged']], IMP.show, (k) => { IMP.show = k; render(); }), el('span', { class: 'grow' }), drop, apply),
        el('div', { class: 'panel' }, rows.length ? capped(rows, 30, 'rows') : empty('None.', null, true)),
        el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: () => { IMP.runId = null; IMP.cols = null; render(); } }, 'Start another file')));
    } else if (IMP.cols) setTimeout(drawMap, 0);
    return frag(
      el('p', { class: 'lead', text: 'Upload a vendor’s price file, match its columns to ours, preview what it would do, then build. Products are matched by vendor and model number, so the same file twice changes nothing.' }),
      !IMP.runId && !fo.vendors.length ? noVendors() : null,
      IMP.runId ? null : el('div', { class: 'panel pad' }, el('div', { class: 'form-grid' }, field('Vendor', vSel), field('CSV or Excel (.xlsx) file', file)),
        el('div', { class: 'dlg-acts' }, el('span', { class: 'fine', text: 'Start from our template: one column per field, the required ones dark.' }), templateLink('xlsx', 'Download template (.xlsx)'), templateLink('csv', 'Download template (.csv)'))),
      step,
      section('Past imports', `${runs.length}`, null, el('div', { class: 'panel' }, runs.length ? capped(runs.map((r) => item({
        title: `${r.vendor} · ${r.filename || 'file'}`, detail: `${r.rows} rows: ${r.added} added, ${r.changed} changed, ${r.unchanged} unchanged, ${r.skipped} skipped · ${r.created_by || ''}`,
        badge: chip(r.status === 'applied' ? 'good' : 'neutral', r.status === 'applied' ? 'ok' : 'pending', cap(r.status)),
        onClick: () => { IMP.runId = r.id; IMP.show = 'change'; render(); } })), 8, 'imports') : empty('No imports yet.', null, true))));
  }

  // ------------------------------------------------------------ price tags
  async function openTags(qs) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(qs)) if (v) p.set(k, v);
    const d = openDialog('Price tags', 'Opens a printable page');
    const size = select([['tag', 'Showroom tag (4 × 6 in)'], ['label', 'Shelf label (2 × 1 in)']], 'tag');
    const fo = await form();
    const list = select([['', 'Ticket and promotion prices'], ...fo.priceLists.map((l) => [l.code, `${l.name} prices`])], '');
    const err = el('div');
    const go_ = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go_, async () => {
      if (list.value) p.set('list', list.value);
      const r = await coApi(`/catalog/labels?${p}`);
      if (!r.items.length) throw new Error('Nothing to print: drafts and discontinued items get no tag');
      printTags(r.items, size.value);
      d.close();
      return r;
    }, (r) => `${plural(r.items.length, 'tag')} ready`, { errorInto: errInto(err) }) }, 'Make tags');
    d.body.append(el('p', { class: 'lead', text: qs.ids ? 'This product.' : `Every active product${qs.vendor ? ' from the vendor picked' : ''}${qs.category ? ` in ${qs.category}` : ''}, up to 200.` }),
      field('Size', size), field('Prices', list), el('div', { class: 'dlg-acts' }, go_), err);
  }

  /** A Code 128 symbol from its module widths, as SVG built node by node. */
  function barcodeSvg(doc, bars, text, moduleW, h) {
    const NS = 'http://www.w3.org/2000/svg';
    const quiet = 10, total = bars.reduce((a, b) => a + b, 0) + quiet * 2;
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${total} ${h + 9}`);
    svg.setAttribute('width', String(total * moduleW));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Barcode ${text}`);
    let x = quiet;
    bars.forEach((w, i) => {
      if (i % 2 === 0) {
        const r = doc.createElementNS(NS, 'rect');
        r.setAttribute('x', String(x)); r.setAttribute('y', '0'); r.setAttribute('width', String(w)); r.setAttribute('height', String(h));
        svg.append(r);
      }
      x += w;
    });
    const t = doc.createElementNS(NS, 'text');
    t.setAttribute('x', String(total / 2)); t.setAttribute('y', String(h + 8)); t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', '8');
    t.setAttribute('font-family', 'monospace');
    t.textContent = text;
    svg.append(t);
    return svg;
  }

  function printTags(items, size) {
    const w = window.open('', '_blank');
    if (!w) { toast('The browser blocked the print page; allow pop-ups for this site.', 'critical'); return; }
    const doc = w.document;
    doc.title = `Price tags · ${S.co.name}`;
    const css = new w.CSSStyleSheet();     // the print page inherits this page's policy: no inline <style>
    css.replaceSync(`
      body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;margin:0;padding:12px;color:#111}
      .bar{display:flex;gap:10px;align-items:center;margin-bottom:12px}.bar button{font-size:16px;padding:8px 16px}
      .sheet{display:flex;flex-wrap:wrap;gap:10px}
      .tag{flex:none;width:4in;height:6in;box-sizing:border-box;border:1px solid #bbb;padding:.3in;display:flex;flex-direction:column;page-break-inside:avoid;break-inside:avoid}
      .tag .brand{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:#555}
      .tag h1{font-size:26px;margin:.08in 0;line-height:1.15}.tag .sub{font-size:14px;color:#444}
      .tag .price{font-size:54px;font-weight:800;margin-top:auto;line-height:1}.tag .was{font-size:18px;color:#555;text-decoration:line-through}
      .tag .promo{font-size:16px;font-weight:700;background:#111;color:#fff;padding:3px 8px;align-self:flex-start;margin:.08in 0}
      .tag .note{font-size:13px;color:#333;margin:.06in 0}.tag svg{margin-top:.15in;max-width:100%}
      .label{flex:none;width:2in;height:1in;box-sizing:border-box;border:1px dashed #bbb;padding:.06in .1in;display:flex;flex-direction:column;overflow:hidden;break-inside:avoid}
      .label b{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.label .price{font-size:16px;font-weight:800}.label svg{max-width:100%;height:.42in}
      @media print{.bar{display:none}body{padding:0}.tag,.label{border-color:#ddd}}`);
    doc.adoptedStyleSheets = [css];
    const mk = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const bar = mk('div', 'bar');
    const pb = mk('button', null, 'Print'); pb.onclick = () => w.print();
    bar.append(pb, mk('span', null, `${items.length} ${size === 'tag' ? 'showroom tags' : 'labels'} · ${S.co.name}`));
    const sheet = mk('div', 'sheet');
    for (const it of items) {
      if (size === 'label') {
        const n = mk('div', 'label');
        n.append(mk('b', null, it.name), mk('div', 'price', `${it.from_options ? 'from ' : ''}${money(it.price_minor)}`), barcodeSvg(doc, it.barcode.bars, it.barcode.text, 1, 34));
        sheet.append(n);
        continue;
      }
      const n = mk('div', 'tag');
      n.append(mk('div', 'brand', [it.brand, it.collection].filter(Boolean).join(' · ')), mk('h1', null, it.name),
        mk('div', 'sub', [it.color, it.pieces > 1 ? `${it.pieces} cartons` : null, it.sku].filter(Boolean).join(' · ')));
      if (it.status === 'floor_sample') n.append(mk('div', 'promo', `Floor model · as is${it.condition ? ` · condition ${it.condition.words}` : ''}`));
      if (it.status === 'drop') n.append(mk('div', 'note', 'Final stock: will not be reordered'));
      if (it.kit) n.append(mk('div', 'note', `Includes ${it.kit.pieces.join(', ')}. Separately ${money(it.kit.component_total_minor)}.`));
      if (it.promotion) n.append(mk('div', 'promo', `${it.promotion.name} · save ${money(it.promotion.savings_minor)}`), mk('div', 'was', money(it.ticket_minor)));
      else if (it.msrp_minor && Number(it.msrp_minor) > Number(it.price_minor)) n.append(mk('div', 'was', `Compare at ${money(it.msrp_minor)}`));
      n.append(mk('div', 'price', `${it.from_options ? 'from ' : ''}${money(it.price_minor)}`), barcodeSvg(doc, it.barcode.bars, it.barcode.text, 2, 50));
      sheet.append(n);
    }
    doc.body.append(bar, sheet);
  }

  E.register('catalog', 'Catalog', 'tag', screen, 'Retail', { icon: 'M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z|C8 8 1.4', module: 'catalog' });
})();
