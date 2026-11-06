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
        tile({ label: 'Active', value: String(counts.active || 0), tone: 'good', ic: 'ok', text: 'Selling now' }),
        tile({ label: 'Drafts', value: String(counts.draft || 0), tone: counts.draft ? 'warning' : 'neutral', ic: 'pending', text: 'Need a price or a look', onClick: () => { F.status = 'draft'; render(); } }),
        tile({ label: 'Floor samples', value: String(counts.floor_sample || 0), tone: 'neutral', ic: 'hold', text: 'Sell as-is, never reorder', onClick: () => { F.status = 'floor_sample'; render(); } }),
        tile({ label: 'Dropped', value: String(counts.drop || 0), tone: counts.drop ? 'serious' : 'neutral', ic: 'warn', text: 'Sell through, never reorder', onClick: () => { F.status = 'drop'; render(); } })),
      el('div', { class: 'pc-toolbar' }, search, vSel, cSel, sSel),
      section('Products', `${d.total}`, null,
        el('div', { class: 'panel' }, rows.length ? rows : empty('Nothing matches.', 'Clear a filter, or add a product.', true),
          d.total > d.items.length ? el('button', { class: 'more-row', type: 'button', onclick: () => { F.limit = Math.min(F.limit + 100, 200); render(); } }, `Show more of ${d.total}`) : null)));
  }

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
    const lSel = select(fo.locations.map((l) => [l.id, `Landed at ${l.name}`]), M.location || d.locationId);
    for (const [s, k] of [[vSel, 'vendor'], [cSel, 'category'], [lSel, 'location']]) s.onchange = () => { M[k] = s.value; render(); };
    const low = d.items.filter((x) => x.margin_bps != null && x.margin_bps < 4000);
    const rows = d.items.map((x) => item({
      title: x.name, amount: pct(x.margin_bps),
      detail: `${x.sku} · ticket ${money(x.price_minor)} · landed ${money(x.landed_minor)} (cost ${money(x.cost_minor)} + freight ${money(x.freight_minor)})${x.map_minor ? ` · MAP ${money(x.map_minor)}` : ''}`,
      badge: x.below_map ? chip('critical', 'warn', 'Under MAP') : x.promo_minor ? chip('warning', 'clock', `${x.promo_name}: ${money(x.promo_minor)} at ${pct(x.promo_margin_bps)}`) : x.status !== 'active' ? statusChip(x.status) : null,
      onClick: () => openProduct(x.id),
    }));
    return frag(
      tilesRow(tile({ label: 'Blended margin', value: pct(d.blendedBps), tone: 'neutral', ic: 'info', text: 'Ticket against landed cost' }),
        tile({ label: 'Under 40%', value: String(low.length), tone: low.length ? 'warning' : 'good', ic: low.length ? 'warn' : 'ok', text: 'Worth a second look' })),
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
    const cs = (await coApi('/catalog/connections')).connections;
    const connOf = (vid) => cs.find((k) => k.vendor_id === vid && k.kind === 'api') || cs.find((k) => k.vendor_id === vid);
    const connChip = (k) => !k ? null : k.last_ok === false ? chip('critical', 'fail', `${cap(k.kind)} feed failing`)
      : k.last_ok ? chip('good', 'ok', `${cap(k.kind)} feed ok`) : chip('neutral', 'pending', `${cap(k.kind)} feed not run yet`);
    return section('Vendors', `${d.vendors.length}`, null,
      el('p', { class: 'lead', text: 'Where orders go, the freight minimum for a prepaid truck, lead time, freight to each place, and the vendor’s feed: catalog, live availability and freight pulled from their API.' }),
      el('div', { class: 'panel' }, d.vendors.map((v) => {
        const k = connOf(v.id);
        const check = k && k.kind === 'api' ? el('button', { class: 'btn small primary', type: 'button', onclick: () => act(check, () => post(`/catalog/connections/${k.id}/run`),
          (r) => (r.ok ? `Pulled: ${r.note}` : `Failed: ${r.note}`)) }, 'Check now') : null;
        return item({
          title: v.name, amount: `${v.lead_days} days`, badge: connChip(k),
          detail: [v.order_email || 'no order email', v.account_no ? `account ${v.account_no}` : null, v.sku_prefix ? `SKUs ${v.sku_prefix}-…` : null,
            Number(v.freight_min_minor) ? `freight min ${money(v.freight_min_minor)}` : null, v.freight_min_qty ? `${v.freight_min_qty} pieces min` : null,
            plural(Number(v.products), 'product'), v.last_import ? `imported ${shortDay(String(v.last_import).slice(0, 10))}` : null].filter(Boolean).join(' · '),
          why: [k && k.last_note ? `Last pull${k.last_run_at ? ` ${shortDay(String(k.last_run_at).slice(0, 10))}` : ''}: ${k.last_note}` : null,
            v.freight.length ? `Freight: ${v.freight.map((f) => `${f.location} ${f.freight_bps / 100}%${Number(f.per_unit_minor) ? ` + ${money(f.per_unit_minor)}` : ''}`).join(' · ')}` : null].filter(Boolean).join(' — ') || null,
          acts: [el('button', { class: 'btn small', type: 'button', onclick: () => openVendor(v) }, 'Edit'),
            el('button', { class: 'btn small', type: 'button', onclick: () => openFreight(v) }, 'Freight'),
            el('button', { class: 'btn small', type: 'button', onclick: () => openConnection(v, k) }, k ? 'Connection' : 'Connect'),
            check,
            el('button', { class: 'btn small', type: 'button', onclick: () => { IMP.vendorId = v.id; go('catalog', 'import'); } }, 'Import file')],
        });
      })));
  }

  async function openConnection(v, k) {
    const fo = await form();
    const cfg = (k && k.config) || {};
    const d = openDialog(`${v.name} connection`, 'Secrets never go here: name a reference, and the key lives in the server’s environment', { wide: true });
    const f = {
      kind: select([['api', 'API pull'], ['manual', 'Manual upload'], ['email', 'Email'], ['sftp', 'SFTP']], k ? k.kind : 'api'),
      adapter: select([['generic', 'Generic JSON API'], ['ashley', 'Ashley (catalog, ATP, freight, orders)']], k ? k.adapter : (/ashley/i.test(v.name) ? 'ashley' : 'generic')),
      url: input({ value: cfg.url || '', placeholder: 'https://…/products' }), pageSize: input({ type: 'number', min: '0', value: cfg.pageSize ?? 250 }),
      authUrl: input({ value: cfg.authUrl || '', placeholder: 'OAuth address, if the vendor uses one' }), customer: input({ value: cfg.customer || '', placeholder: 'Our customer number with them' }),
      cred: input({ value: k ? k.credential_ref || '' : `secret://vendor/${v.name.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, '')}` }),
      cron: input({ value: k ? k.schedule_cron || '' : '', placeholder: '15 5 * * *  (daily 5:15)' }),
      atpOn: el('input', { type: 'checkbox', checked: !!cfg.atpOn }), atpUrl: input({ value: cfg.atpUrl || '', placeholder: 'Ashley’s ATP service (default)' }),
      atpCustomer: input({ value: cfg.atpCustomer || '' }), atpShipTo: input({ value: cfg.atpShipTo || '' }), atpBatch: input({ type: 'number', min: '1', max: '200', value: cfg.atpBatch ?? 40 }),
      freightOn: el('input', { type: 'checkbox', checked: !!cfg.freightOn }), freightUrl: input({ value: cfg.freightUrl || '', placeholder: 'https://…/prices' }),
      poUrl: input({ value: cfg.poUrl || '', placeholder: 'Order service address, to send POs by API' }),
    };
    const shipTos = fo.locations.map((l) => [l, input({ value: (cfg.shipTos || {})[l.id] || '', placeholder: 'their ship-to no.' })]);
    const runsBox = el('div');
    if (k) coApi(`/catalog/connections/${k.id}/runs`).then((r) => runsBox.replaceChildren(section('Recent pulls', `${r.runs.length}`, null, el('div', { class: 'panel' },
      r.runs.length ? r.runs.slice(0, 8).map((x) => item({ title: shortDay(String(x.started_at).slice(0, 10)), badge: chip(x.outcome === 'ok' ? 'good' : 'critical', x.outcome === 'ok' ? 'ok' : 'fail', x.outcome === 'ok' ? 'OK' : 'Failed'),
        detail: [x.note, x.run_by].filter(Boolean).join(' · ') })) : empty('Not run yet.', null, true))))).catch(() => {});
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => {
      const config = { url: f.url.value.trim(), pageSize: Number(f.pageSize.value) || 0, authUrl: f.authUrl.value.trim(), customer: f.customer.value.trim(),
        atpOn: f.atpOn.checked, atpUrl: f.atpUrl.value.trim(), atpCustomer: f.atpCustomer.value.trim(), atpShipTo: f.atpShipTo.value.trim(), atpBatch: Number(f.atpBatch.value) || 40,
        freightOn: f.freightOn.checked, freightUrl: f.freightUrl.value.trim(), poUrl: f.poUrl.value.trim(),
        shipTos: Object.fromEntries(shipTos.filter(([, i]) => i.value.trim()).map(([l, i]) => [l.id, i.value.trim()])) };
      for (const key of Object.keys(config)) if (config[key] === '') delete config[key];
      act(save, () => post('/catalog/connections', { vendorId: v.id, kind: f.kind.value, adapter: f.adapter.value, name: `${v.name} ${f.kind.value}`, config,
        credentialRef: f.cred.value.trim(), scheduleCron: f.kind.value === 'api' || f.kind.value === 'sftp' ? f.cron.value.trim() : '', mapping: k ? k.mapping : {} }),
        'Connection saved', { errorInto: errInto(err), close: d.close });
    } }, 'Save connection');
    d.body.append(
      k ? resultBox(k.credential_set ? 'good' : 'warning', k.credential_set ? 'ok' : 'warn', k.credential_set ? 'Secret is set' : 'Secret not set',
        `The server reads it from ${k.credential_env}. ${k.credential_set ? '' : 'Add it to the service’s environment as JSON, for example {"clientId":"…","clientSecret":"…","atpExternalId":"…","atpKeyCode":"…","atpUser":"…","atpPassword":"…"}.'}`) : null,
      el('div', { class: 'form-grid' }, field('How it connects', f.kind), field('Adapter', f.adapter), field('Catalog address', f.url, 'Paginated JSON; a short page ends the pull', true),
        field('Page size', f.pageSize), field('Our customer no.', f.customer), field('OAuth address', f.authUrl, null, true), field('Credential reference', f.cred, 'Only the name of the secret'),
        field('Schedule (cron)', f.cron),
        el('div', { class: 'form-sec', text: 'Availability (Ashley ATP)' }), el('label', { class: 'check wide' }, f.atpOn, 'Pull vendor quantity and lead time for every model'),
        field('ATP service address', f.atpUrl, null, true), field('ATP customer', f.atpCustomer), field('ATP ship-to', f.atpShipTo), field('Models per call', f.atpBatch),
        el('div', { class: 'form-sec', text: 'Freight by store' }), el('label', { class: 'check wide' }, f.freightOn, 'Pull the vendor’s freight per model to each place'),
        field('Price API address', f.freightUrl, null, true), shipTos.map(([l, i]) => field(`${l.name} ship-to`, i)),
        el('div', { class: 'form-sec', text: 'Sending orders' }), field('Order service address', f.poUrl, 'Leave blank to send by email or file', true)),
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err, runsBox);
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
    const loc = select(fo.locations.map((l) => [l.id, l.name]));
    const pctIn = input({ inputmode: 'decimal', placeholder: '6' }), per = moneyIn(null);
    const fill = () => { const f = v.freight.find((x) => x.location_id === loc.value); pctIn.value = f ? f.freight_bps / 100 : ''; per.value = f ? (Number(f.per_unit_minor) / 100).toFixed(2) : ''; };
    loc.onchange = fill; fill();
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post(`/catalog/vendors/${v.id}/freight`, { locationId: loc.value, pct: pctIn.value || 0, perUnit: per.value || '0' }),
      'Freight saved', { errorInto: errInto(err), close: d.close }) }, 'Save');
    d.body.append(field('To', loc), el('div', { class: 'form-grid' }, field('Percent of cost', pctIn), field('Per unit ($)', per)),
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel')), err);
  }

  // ----------------------------------------------------------------- import
  const IMP = { vendorId: '', csv: '', filename: '', cols: null, mapping: {}, runId: null, show: 'change' };
  async function tabImport() {
    const fo = await form();
    const runs = (await coApi('/catalog/import/runs')).runs;
    const step = el('div');
    const vSel = select([['', 'Which vendor is this file from?'], ...fo.vendors.map((v) => [v.id, v.name])], IMP.vendorId);
    vSel.onchange = () => { IMP.vendorId = vSel.value; };
    const file = el('input', { type: 'file', accept: '.csv,text/csv' });
    file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > 8e6) { toast('That file is over 8 MB; split it.', 'critical'); return; }
      IMP.csv = await f.text(); IMP.filename = f.name; IMP.runId = null;
      try { IMP.cols = await post('/catalog/import/columns', { csv: IMP.csv }); IMP.mapping = { ...IMP.cols.mapping }; drawMap(); }
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
        const r = await post('/catalog/import/preview', { vendorId: IMP.vendorId, csv: IMP.csv, filename: IMP.filename, mapping: IMP.mapping });
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
        tilesRow(tile({ label: 'Add', value: String(run.added), tone: 'good', ic: 'plus', text: 'New products' }), tile({ label: 'Change', value: String(run.changed), tone: run.changed ? 'warning' : 'neutral', ic: 'refresh', text: 'Cost, price, details' }),
          tile({ label: 'Unchanged', value: String(run.unchanged), tone: 'neutral', ic: 'ok', text: 'Same as on file' }), tile({ label: 'Skipped', value: String(run.skipped), tone: run.skipped ? 'serious' : 'neutral', ic: 'warn', text: 'Each says why' })),
        resultBox(run.status === 'applied' ? 'good' : 'neutral', run.status === 'applied' ? 'ok' : 'info', run.status === 'applied' ? 'Built' : 'Preview: nothing has changed yet', `${run.vendor} · ${run.filename || 'file'} · ${run.rows} rows`),
        el('div', { class: 'toolbar' }, seg([['add', 'Added'], ['change', 'Changed'], ['skip', 'Skipped'], ['same', 'Unchanged']], IMP.show, (k) => { IMP.show = k; render(); }), el('span', { class: 'grow' }), drop, apply),
        el('div', { class: 'panel' }, rows.length ? capped(rows, 30, 'rows') : empty('None.', null, true)),
        el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: () => { IMP.runId = null; IMP.cols = null; render(); } }, 'Start another file')));
    } else if (IMP.cols) setTimeout(drawMap, 0);
    return frag(
      el('p', { class: 'lead', text: 'Upload a vendor’s price file, match its columns to ours, preview what it would do, then build. Products are matched by vendor and model number, so the same file twice changes nothing.' }),
      IMP.runId ? null : el('div', { class: 'panel pad' }, el('div', { class: 'form-grid' }, field('Vendor', vSel), field('CSV file', file))),
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
      if (it.status === 'floor_sample') n.append(mk('div', 'promo', 'Floor model · as is'));
      if (it.status === 'drop') n.append(mk('div', 'note', 'Final stock: will not be reordered'));
      if (it.kit) n.append(mk('div', 'note', `Includes ${it.kit.pieces.join(', ')}. Separately ${money(it.kit.component_total_minor)}.`));
      if (it.promotion) n.append(mk('div', 'promo', `${it.promotion.name} · save ${money(it.promotion.savings_minor)}`), mk('div', 'was', money(it.ticket_minor)));
      else if (it.msrp_minor && Number(it.msrp_minor) > Number(it.price_minor)) n.append(mk('div', 'was', `Compare at ${money(it.msrp_minor)}`));
      n.append(mk('div', 'price', `${it.from_options ? 'from ' : ''}${money(it.price_minor)}`), barcodeSvg(doc, it.barcode.bars, it.barcode.text, 2, 50));
      sheet.append(n);
    }
    doc.body.append(bar, sheet);
  }

  E.register('catalog', 'Catalog', 'tag', screen, 'Retail', { icon: 'M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z|C8 8 1.4' });
})();
