// Configurator screens: Sectionals (families, pieces, layouts, covers and
// grades, option rules) and As-is grades (condition grade per piece, its
// price, tags, and as-is stock by grade and age). It also gives POS and the
// endless aisle the sectional builder (ERP.sectionalBuilder) and the plan
// drawing (ERP.drawLayout). Cards and pickers only, never a wide table; data
// is placed with textContent, and the plan is SVG made with createElementNS.
(() => {
  'use strict';
  const E = window.ERP;
  if (!E) return;
  const { el, frag, section, head, item, chip, money, openDialog, fillDialog, post, coApi, toast, empty, resultBox,
    plural, busy, friendly, go, S, fact, capped, render } = E;

  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs, ...kids) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, String(v));
    for (const k of kids.flat(Infinity)) if (k) n.append(k);
    return n;
  };
  const field = (label, control, hint, wide) => el('label', { class: 'field' + (wide ? ' wide' : '') }, el('span', { text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null);
  const select = (options, value, placeholder) => el('select', {}, placeholder != null ? el('option', { value: '', text: placeholder }) : null,
    options.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(value ?? '') || null })));
  const input = (attrs) => el('input', Object.assign({ type: 'text' }, attrs));
  const outBox = () => el('div', { role: 'status', 'aria-live': 'polite' });
  const btn = (text, onclick, o = {}) => el('button', { class: 'btn' + (o.small ? ' small' : '') + (o.primary ? ' primary' : ''), type: 'button', onclick }, text);
  const words = (s) => String(s || '').replace(/^laf_/, 'LAF ').replace(/^raf_/, 'RAF ').replace(/_/g, ' ');
  const dollars = (m) => (Number(m || 0) / 100).toFixed(2);
  const inches = (n) => `${Number(n)}"`;
  const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  async function run(b, out, fn, okText, after) {
    busy(b, true);
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
    } finally { if (b.isConnected) busy(b, false); }
  }

  // ================================================================ the plan
  /** The sectional seen from above, from the rectangles the server worked out (inches). */
  function drawLayout(g) {
    if (!g || !g.pieces || !g.pieces.length) return el('div', { class: 'sub', text: 'Pick pieces to see the plan.' });
    const pad = 4, W = g.viewW + pad * 2, H = g.viewH + pad * 2;
    const r = (x, fill) => sv('rect', { x: x.x + pad, y: x.y + pad, width: x.w, height: x.h, fill, stroke: '#3d3a36', 'stroke-width': 0.6, rx: 1 });
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', preserveAspectRatio: 'xMidYMid meet', class: 'cfg-plan',
      'aria-label': `Plan: ${g.widthIn} by ${g.depthIn} inches, seats ${g.seats}` },
      g.pieces.map((p) => sv('g', {}, r(p, p.free ? '#efe9df' : '#e3d9c8'), p.back.map((b) => r(b, '#b9ab94')), p.arms.map((a) => r(a, '#9c8b72')),
        sv('text', { x: p.x + pad + p.w / 2, y: p.y + pad + p.h / 2 + 2, 'font-size': 5, 'text-anchor': 'middle', fill: '#2b2925' }, document.createTextNode(p.label)))));
    // keep it from towering on a phone: the plan's own proportions, capped
    svg.setAttribute('height', String(Math.min(260, Math.round(320 * H / Math.max(W, 1)))));
    return svg;
  }
  const dot = (hex) => sv('svg', { viewBox: '0 0 10 10', width: 14, height: 14, 'aria-hidden': 'true' }, sv('circle', { cx: 5, cy: 5, r: 4.5, fill: hex || '#cccccc', stroke: '#555', 'stroke-width': 0.5 }));

  // ============================================================ the builder
  /**
   * The sectional builder used by POS, the endless aisle and the Sectionals
   * screen: layout or pieces, the cover (filtered by grade and color), each
   * piece's options, and the server's price and plan.
   */
  function sectionalBuilder({ productId, family, onPriced }) {
    const st = { layout: '', pieces: [], cover: family.stockCover || '', opts: [], priced: null, grade: '', color: '' };
    const first = family.layouts.find((l) => l.popular) || family.layouts[0];
    if (first) { st.layout = first.code; st.pieces = first.pieces.slice(); st.opts = st.pieces.map(() => ({})); }
    const byCode = new Map(family.pieces.map((p) => [p.code, p]));
    const planBox = el('div', { class: 'cfg-planbox' }), sumBox = el('div'), err = el('div'), piecesBox = el('div'), coverBox = el('div');
    const allowed = (group, piece) => {
      if (group === 'recline' && piece.motion !== 'none') return false;
      const only = family.rules.filter((r) => r.kind === 'only_on' && r.group === group);
      return !only.length || only.some((r) => r.pieceTypes.includes(piece.type));
    };
    const build = () => {
      const lay = family.layouts.find((l) => l.code === st.layout);
      return { layout: lay && lay.pieces.join('|') === st.pieces.join('|') ? lay.code : null, pieces: st.pieces.slice(), cover: st.cover || null,
        pieceOptions: st.opts.map((m) => Object.entries(m).filter(([, v]) => v).map(([group, option]) => ({ group, option }))) };
    };
    const reprice = debounce(async () => {
      err.replaceChildren();
      if (!st.pieces.length) { planBox.replaceChildren(drawLayout(null)); sumBox.replaceChildren(); st.priced = null; if (onPriced) onPriced(null); return; }
      try {
        const r = await post('/cfg/price', { productId, sectional: build() });
        st.priced = r;
        planBox.replaceChildren(drawLayout(r.geometry));
        sumBox.replaceChildren(el('div', { class: 'facts' }, fact('Overall', `${inches(r.widthIn)} W × ${inches(r.depthIn)} D`), fact('Seats', String(r.seats)),
          fact('Cover', r.cover ? `${r.cover.name}, grade ${r.cover.grade}` : 'None'), fact('Truck', `${r.cubicFt} cu ft · ${r.weightLb} lb`)),
        el('div', { class: 'panel' }, r.pieces.map((x) => item({ title: `${x.position}. ${x.name}`, amount: money(x.priceMinor),
          detail: [Number(x.gradeAdderMinor) ? `grade +${money(x.gradeAdderMinor)}` : null, ...x.options.map((o) => o.label), x.madeToOrder ? 'made to order' : 'ships from stock'].filter(Boolean).join(' · ') })),
          Number(r.bundleDiscountMinor) ? item({ title: `Bundle discount (${r.bundleDiscountBps / 100}%)`, amount: `−${money(r.bundleDiscountMinor)}` }) : null,
          item({ title: el('b', { text: 'Sectional price' }), amount: money(r.totalMinor), detail: r.madeToOrder ? `Made to order${r.leadDays ? `, about ${r.leadDays} days extra lead` : ''}` : 'All pieces in the stock cover' })));
        if (onPriced) onPriced(r);
      } catch (e) {
        st.priced = null; if (onPriced) onPriced(null);
        err.replaceChildren(resultBox('warning', 'warn', 'Not a sectional that can be sold', friendly(e)));
      }
    }, 200);
    const layoutSel = select(family.layouts.map((l) => [l.code, l.name]), st.layout, 'Custom: pick the pieces');
    layoutSel.addEventListener('change', () => {
      st.layout = layoutSel.value;
      const l = family.layouts.find((x) => x.code === st.layout);
      if (l) { st.pieces = l.pieces.slice(); st.opts = st.pieces.map(() => ({})); }
      paintPieces(); reprice();
    });
    function paintPieces() {
      const move = (i, d) => { const j = i + d; if (j < 0 || j >= st.pieces.length) return; [st.pieces[i], st.pieces[j]] = [st.pieces[j], st.pieces[i]]; [st.opts[i], st.opts[j]] = [st.opts[j], st.opts[i]]; st.layout = ''; layoutSel.value = ''; paintPieces(); reprice(); };
      const rows = st.pieces.map((code, i) => {
        const p = byCode.get(code) || { name: code, type: '', motion: 'none' };
        const pickers = family.options.filter((g) => allowed(g.code, p)).map((g) => {
          const s = select(g.options.map((o) => [o.code, `${o.label}${Number(o.priceDeltaMinor) ? ` (+${money(o.priceDeltaMinor)})` : ''}`]), st.opts[i][g.code] || '', `No ${g.label.toLowerCase()}`);
          s.setAttribute('aria-label', `${g.label} on piece ${i + 1}`);
          s.addEventListener('change', () => { st.opts[i][g.code] = s.value; reprice(); });
          return field(g.label, s);
        });
        return el('div', { class: 'li' }, el('div', { class: 't', text: `${i + 1}. ${p.name}` }),
          el('div', { class: 'd', text: [words(p.type), p.motion && p.motion !== 'none' ? `${p.motion} recline` : null, p.widthIn ? `${inches(p.widthIn)} × ${inches(p.depthIn)}` : null, p.seats != null ? plural(p.seats, 'seat') : null].filter(Boolean).join(' · ') }),
          pickers.length ? el('div', { class: 'form-grid' }, pickers) : null,
          el('div', { class: 'acts' }, btn('Move left', () => move(i, -1), { small: true }), btn('Move right', () => move(i, 1), { small: true }),
            btn('Remove', () => { st.pieces.splice(i, 1); st.opts.splice(i, 1); st.layout = ''; layoutSel.value = ''; paintPieces(); reprice(); }, { small: true })));
      });
      const addSel = select(family.pieces.filter((p) => p.active !== false).map((p) => [p.code, `${p.name} · ${money(p.priceMinor)}`]), '', 'Add a piece');
      addSel.addEventListener('change', () => { if (!addSel.value) return; st.pieces.push(addSel.value); st.opts.push({}); st.layout = ''; layoutSel.value = ''; paintPieces(); reprice(); });
      piecesBox.replaceChildren(el('div', { class: 'panel' }, rows.length ? rows : empty('No pieces yet', 'Pick a layout or add pieces left to right, as you face it.', true)),
        field('Add a piece (it goes on the right end)', addSel));
    }
    function paintCovers() {
      const grades = family.grades.map((g) => [g.code, `${g.label}${g.uplift_bps ? ` (+${g.uplift_bps / 100}%)` : ''}`]);
      const colors = [...new Set(family.covers.map((c) => c.colorFamily))].map((c) => [c, c]);
      const gSel = select(grades, st.grade, 'Every grade'), cSel = select(colors, st.color, 'Every color');
      gSel.addEventListener('change', () => { st.grade = gSel.value; paintCovers(); });
      cSel.addEventListener('change', () => { st.color = cSel.value; paintCovers(); });
      const list = family.covers.filter((c) => (!st.grade || c.grade === st.grade) && (!st.color || c.colorFamily === st.color));
      const chips = el('div', { class: 'toolbar', role: 'group', 'aria-label': 'Covers' }, list.map((c) =>
        el('button', { type: 'button', class: 'btn small' + (st.cover === c.code ? ' primary' : ''), 'aria-pressed': String(st.cover === c.code),
          onclick: () => { st.cover = c.code; paintCovers(); reprice(); } }, dot(c.hex), ` ${c.name} · ${c.grade}${family.stockCover === c.code ? ' · stocked' : ''}`)));
      const cur = family.covers.find((c) => c.code === st.cover);
      coverBox.replaceChildren(el('div', { class: 'form-grid' }, field('Grade', gSel), field('Color', cSel)),
        list.length ? chips : empty('No cover matches', 'Clear a filter.', true),
        cur ? el('p', { class: 'sub', text: [cur.name, cur.content, cur.cleaning ? `cleaning ${cur.cleaningCode}: ${cur.cleaning}` : null].filter(Boolean).join(' · ') }) : null);
    }
    paintPieces(); paintCovers(); reprice();
    const node = el('div', { class: 'cfg-builder' },
      field('Layout', layoutSel, 'Popular layouts, or build your own left to right as you face it.'),
      section('Pieces', null, null, piecesBox),
      family.covers.length ? section('Cover', null, null, coverBox) : null,
      section('Plan and price', null, null, planBox, err, sumBox));
    return { node, build, priced: () => st.priced };
  }

  /** A dialog with the builder: fetch the family, build, then hand the build and its price to the caller. */
  function sectionalDialog({ productId, title, sub, actLabel, extra, onAdd }) {
    const d = openDialog(title, sub || 'Build the sectional; the price is the register’s and the web’s', { wide: true });
    fillDialog(d, async () => {
      const family = await coApi(`/cfg/families/${productId}`);
      const add = el('button', { class: 'btn primary', type: 'button', disabled: true }, actLabel || 'Add');
      const b = sectionalBuilder({ productId, family, onPriced: (r) => { add.disabled = !r; } });
      const ex = extra ? extra() : null;
      add.addEventListener('click', () => { const r = b.priced(); if (!r) return; onAdd(b.build(), r, ex); d.close(); });
      return frag(b.node, ex ? ex.node : null, el('div', { class: 'dlg-acts' }, add, btn('Cancel', d.close)));
    });
  }
  Object.assign(E, { drawLayout, sectionalBuilder, sectionalDialog });

  // ============================================================ Sectionals
  const TABS = [['families', 'Sectionals'], ['covers', 'Covers and grades'], ['rules', 'Option rules']];
  let OPTS = null;
  const options = async (fresh) => { if (fresh || !OPTS || OPTS.co !== S.co.id) OPTS = { co: S.co.id, ...(await coApi('/cfg/options')) }; return OPTS; };

  async function screenSectionals(sub) {
    const [tab, id] = String(sub || '').split('/');
    const t = TABS.some(([k]) => k === tab) ? tab : 'families';
    const o = await options(true);
    const pick = select(TABS, t);
    pick.addEventListener('change', () => go('sectionals', pick.value));
    const body = t === 'covers' ? await coversTab(o) : t === 'rules' ? await rulesTab(o) : id ? await familyDetail(o, id) : familiesTab(o);
    return frag(head('Sectionals', [], `${S.co.name} · pieces, layouts, covers and option rules`), el('div', { class: 'toolbar' }, field('Show', pick)), body);
  }

  function familiesTab(o) {
    const add = btn('New sectional', () => newFamilyDialog(o), { primary: true });
    return section('Sectional families', plural(o.families.length, 'family'), [add],
      o.families.length ? el('div', { class: 'panel' }, o.families.map((f) => item({ title: f.name, onClick: () => go('sectionals', `families/${f.product_id}`),
        detail: [f.sku, plural(f.pieces, 'piece'), plural(f.layouts, 'layout'), f.grade_table || 'no grade table', `${f.min_pieces}–${f.max_pieces} pieces`,
          f.bundle_discount_bps ? `${f.bundle_discount_bps / 100}% bundle discount` : null, f.sold ? `${f.sold} sold` : null].filter(Boolean).join(' · '),
        badge: chip(f.active ? 'good' : 'neutral', f.active ? 'ok' : 'info', f.active ? 'Selling' : 'Off') })))
        : empty('No sectionals yet', 'Make one, then add its pieces and popular layouts.', true));
  }
  function newFamilyDialog(o) {
    const d = openDialog('New sectional', 'A family of pieces, each its own SKU');
    const sku = input({ maxlength: '40', autocapitalize: 'characters' }), name = input({ maxlength: '200' }), price = input({ inputmode: 'decimal', placeholder: '0.00' });
    const vendor = select(o.vendors.map((v) => [v.id, v.name]), '', 'Pick the vendor');
    const out = outBox();
    const b = btn('Make it', () => run(b, out, () => post('/cfg/families', { sku: sku.value, name: name.value, vendorId: vendor.value || null, price: price.value || 0 }),
      null, (r) => { d.close(); go('sectionals', `families/${r.id}`); }), { primary: true });
    d.body.append(el('div', { class: 'form-grid' }, field('SKU', sku), field('Name', name), field('Vendor', vendor), field('“From” price', price, 'What the web and the tag show before a build.')),
      el('div', { class: 'dlg-acts' }, b, btn('Cancel', d.close)), out);
  }

  async function familyDetail(o, id) {
    const f = await coApi(`/cfg/families/${id}`);
    if (!f) return empty('No such sectional', null, true);
    const tables = o.gradeTables.map((t) => [t.id, t.name]);
    const min = input({ inputmode: 'numeric', value: String(f.minPieces) }), max = input({ inputmode: 'numeric', value: String(f.maxPieces) });
    const bpct = input({ inputmode: 'decimal', value: String(f.bundleDiscountBps / 100) }), bmin = input({ inputmode: 'numeric', value: String(f.bundleMinPieces) });
    const table = select(tables, f.gradeTableId || '', 'No grade table');
    const stock = select(f.covers.map((c) => [c.code, `${c.name} (${c.grade})`]), f.stockCover || '', 'Nothing stocked: every piece is made to order');
    const notes = input({ maxlength: '1000', value: f.notes || '' });
    const out = outBox();
    const save = btn('Save', () => run(save, out, () => post('/cfg/families', { productId: id, minPieces: min.value, maxPieces: max.value, bundlePct: bpct.value,
      bundleMinPieces: bmin.value, gradeTableId: table.value || null, stockCover: stock.value || null, notes: notes.value }), 'Saved.', () => render()), { primary: true });
    const pieceList = el('div', { class: 'panel' }, f.pieces.length ? f.pieces.map((p) => item({ title: p.name, amount: money(p.priceMinor),
      detail: [p.code, words(p.type), p.motion !== 'none' ? `${p.motion} recline` : null, `${inches(p.widthIn)} × ${inches(p.depthIn)}`, plural(p.seats, 'seat'),
        p.sku, p.vendorSku ? `vendor ${p.vendorSku}` : null, p.cubicFt != null ? `${p.cubicFt} cu ft` : null, p.weightLb != null ? `${p.weightLb} lb` : null, `cost ${money(p.costMinor)}`].filter(Boolean).join(' · '),
      badge: p.active ? null : chip('neutral', 'info', 'off'), acts: [btn('Change', () => pieceDialog(o, f, p), { small: true })] })) : [empty('No pieces yet', null, true)]);
    const layoutList = el('div', { class: 'panel' }, f.layouts.length ? f.layouts.map((l) => item({ title: l.name, detail: `${l.code} · ${l.pieces.join(' / ')}`,
      acts: [btn('Try it', () => tryDialog(f, l.code), { small: true })] })) : [empty('No popular layouts yet', null, true)]);
    return frag(
      section(f.name, f.sku, [btn('Try a build', () => tryDialog(f, null), { primary: true }), btn('All sectionals', () => go('sectionals', 'families'))],
        el('div', { class: 'panel' }, el('div', { class: 'form-grid' }, field('Fewest pieces', min), field('Most pieces', max), field('Bundle discount %', bpct, 'Off the sum of the pieces.'),
          field('Bundle from (pieces)', bmin), field('Grade table', table), field('Stocked cover', stock, 'Pieces in this cover reserve stock; any other cover is a special order.'),
          field('Notes', notes, null, true)), el('div', { class: 'dlg-acts' }, save), out)),
      section('Pieces', plural(f.pieces.length, 'piece'), [btn('Add a piece', () => pieceDialog(o, f, null))], pieceList),
      section('Popular layouts', 'Checked like any build when saved', [btn('Add a layout', () => layoutDialog(f))], layoutList));
  }
  function pieceDialog(o, f, p) {
    const d = openDialog(p ? p.name : 'New piece', p ? p.sku : 'Its own SKU, made in the catalog');
    const code = input({ maxlength: '40', value: p ? p.code : '' }), type = select(o.pieceTypes.map((t) => [t.code, t.label]), p ? p.type : 'laf_sofa');
    const motion = select(o.motions.map((m) => [m, m]), p ? p.motion : 'none');
    const w = input({ inputmode: 'decimal', value: p ? String(p.widthIn) : '' }), dp = input({ inputmode: 'decimal', value: p ? String(p.depthIn) : '' });
    const h = input({ inputmode: 'decimal', value: p && p.heightIn ? String(p.heightIn) : '' }), seats = input({ inputmode: 'numeric', value: p ? String(p.seats) : '' });
    const sku = input({ maxlength: '40', value: p ? p.sku : '', disabled: p ? true : null }), name = input({ maxlength: '200', value: p ? p.name : '' });
    const price = input({ inputmode: 'decimal', value: p ? dollars(p.priceMinor) : '' }), cost = input({ inputmode: 'decimal', value: p ? dollars(p.costMinor) : '' });
    const cube = input({ inputmode: 'decimal', value: p && p.cubicFt != null ? String(p.cubicFt) : '' }), wt = input({ inputmode: 'decimal', value: p && p.weightLb != null ? String(p.weightLb) : '' });
    const vsku = input({ maxlength: '60', value: p && p.vendorSku ? p.vendorSku : '' });
    const out = outBox();
    const b = btn('Save', () => run(b, out, () => post(`/cfg/families/${f.productId}/pieces`, { code: code.value, pieceType: type.value, motion: motion.value, widthIn: w.value,
      depthIn: dp.value, heightIn: h.value, seats: seats.value, productId: p ? p.productId : null, sku: p ? undefined : sku.value, name: name.value, price: price.value, cost: cost.value,
      cubicFt: cube.value, weightLb: wt.value, vendorSku: vsku.value }), null, () => { d.close(); render(); }), { primary: true });
    d.body.append(el('div', { class: 'form-grid' }, field('Piece code', code, 'How layouts name it, like laf-sofa.'), field('Kind of piece', type), field('Motion', motion),
      field('Width (in)', w), field('Depth (in)', dp), field('Height (in)', h), field('Seats', seats), field('SKU', sku), field('Name', name), field('Price', price), field('Cost', cost),
      field('Cube (cu ft)', cube), field('Weight (lb)', wt), field('Vendor SKU', vsku)), el('div', { class: 'dlg-acts' }, b, btn('Cancel', d.close)), out);
  }
  function layoutDialog(f) {
    const d = openDialog('New popular layout', f.name);
    const code = input({ maxlength: '60', placeholder: '3pc-sofa-wedge-loveseat' }), name = input({ maxlength: '160', placeholder: '3-pc LAF sofa / wedge / RAF loveseat' });
    const pieces = input({ maxlength: '400', placeholder: 'laf-sofa, wedge, raf-loveseat' });
    const out = outBox();
    const b = btn('Save', () => run(b, out, () => post(`/cfg/families/${f.productId}/layouts`, { code: code.value, name: name.value, pieces: pieces.value }), null, () => { d.close(); render(); }), { primary: true });
    d.body.append(el('div', { class: 'form-grid' }, field('Code', code), field('Name', name), field('Pieces, left to right', pieces, `Codes: ${f.pieces.map((p) => p.code).join(', ')}`, true)),
      el('div', { class: 'dlg-acts' }, b, btn('Cancel', d.close)), out);
  }
  function tryDialog(f, layout) {
    const d = openDialog(`Try a build: ${f.name}`, 'Nothing is sold from here', { wide: true });
    const fam = layout ? { ...f, layouts: [...f.layouts.filter((l) => l.code === layout), ...f.layouts.filter((l) => l.code !== layout)] } : f;
    d.body.append(sectionalBuilder({ productId: f.productId, family: fam }).node);
  }

  async function coversTab(o) {
    const f = { table: o.gradeTables[0] ? o.gradeTables[0].id : '', grade: '', color: '', retired: false };
    const box = el('div');
    const tSel = select(o.gradeTables.map((t) => [t.id, t.name]), f.table, 'Every grade table');
    const gSel = select([], '', 'Every grade'), cSel = select(o.colorFamilies.map((c) => [c, c]), '', 'Every color');
    const ret = el('input', { type: 'checkbox' });
    const fillGrades = () => { const t = o.gradeTables.find((x) => x.id === tSel.value); gSel.replaceChildren(el('option', { value: '', text: 'Every grade' }), ...(t ? t.grades : []).map((g) => el('option', { value: g.code, text: g.label }))); };
    const load = async () => {
      box.replaceChildren(E.loadingNode());
      try {
        const qs = new URLSearchParams({ ...(tSel.value ? { table: tSel.value } : {}), ...(gSel.value ? { grade: gSel.value } : {}), ...(cSel.value ? { color: cSel.value } : {}), ...(ret.checked ? { retired: '1' } : {}) });
        const rows = await coApi(`/cfg/swatches?${qs}`);
        box.replaceChildren(rows.length ? el('div', { class: 'panel' }, capped(rows.map((s) => item({ title: frag(dot(s.hex), ` ${s.name}`),
          detail: [s.code, `grade ${s.grade}`, s.material, s.colorFamily, s.content, s.cleaningCode ? `cleaning ${s.cleaningCode}` : null, s.vendorCode ? `vendor ${s.vendorCode}` : null,
            s.discontinuedOn ? `discontinued ${s.discontinuedOn}` : null].filter(Boolean).join(' · '),
          badge: s.discontinuedOn ? chip('warning', 'warn', 'Retired') : null, acts: [btn('Change', () => swatchDialog(o, s), { small: true })] })), 30, 'covers'))
          : empty('No covers match', null, true));
      } catch (e) { box.replaceChildren(E.errorBox(e)); }
    };
    tSel.addEventListener('change', () => { fillGrades(); load(); });
    for (const x of [gSel, cSel, ret]) x.addEventListener('change', load);
    fillGrades(); load();
    const grades = el('div', { class: 'panel' }, o.gradeTables.length ? o.gradeTables.map((t) => item({ title: t.name, detail: [t.code, t.vendor,
      t.grades.map((g) => `${g.code}${g.adders.length ? ` (${g.adders.length} adders)` : g.uplift_bps ? ` +${g.uplift_bps / 100}%` : ''}`).join(', ')].filter(Boolean).join(' · '),
      acts: [btn('Edit grades', () => gradeDialog(o, t), { small: true })] })) : [empty('No grade tables yet', null, true)]);
    return frag(section('Vendor grade tables', null, [btn('New grade table', () => gradeDialog(o, null))], grades),
      section('Swatch library', null, [btn('Add a cover', () => swatchDialog(o, null), { primary: true })],
        el('div', { class: 'form-grid' }, field('Grade table', tSel), field('Grade', gSel), field('Color', cSel), el('label', { class: 'check' }, ret, el('span', { text: ' Show retired covers' }))), box));
  }
  function gradeDialog(o, t) {
    const d = openDialog(t ? t.name : 'New grade table', 'Adders per piece type; with none, the percent uplift on the piece price', { wide: true });
    const code = input({ maxlength: '24', value: t ? t.code : '', autocapitalize: 'characters' }), name = input({ maxlength: '120', value: t ? t.name : '' });
    const vendor = select(o.vendors.map((v) => [v.id, v.name]), t ? t.vendor_id || '' : '', 'No vendor');
    const rows = [];
    const list = el('div');
    const addRow = (g) => {
      const gc = input({ maxlength: '12', value: g ? g.code : '', 'aria-label': 'Grade code' }), gl = input({ maxlength: '60', value: g ? g.label : '', 'aria-label': 'Label' });
      const up = input({ inputmode: 'decimal', value: g ? String(g.uplift_bps / 100) : '0', 'aria-label': 'Uplift %' }), cu = input({ inputmode: 'decimal', value: g ? String(g.cost_uplift_bps / 100) : '0', 'aria-label': 'Cost uplift %' });
      const adders = o.pieceTypes.map((pt) => { const a = g && g.adders.find((x) => x.piece_type === pt.code); return { pt, price: input({ inputmode: 'decimal', value: a ? dollars(a.price_adder_minor) : '', placeholder: '—', 'aria-label': `${pt.label} adder` }),
        cost: input({ inputmode: 'decimal', value: a ? dollars(a.cost_adder_minor) : '', placeholder: '—', 'aria-label': `${pt.label} cost adder` }) }; });
      const det = el('details', {}, el('summary', { text: 'Adders per piece type (price, cost)' }), el('div', { class: 'form-grid' }, adders.map((a) => field(a.pt.label, el('div', { class: 'toolbar' }, a.price, a.cost)))));
      rows.push({ gc, gl, up, cu, adders });
      list.append(el('div', { class: 'li' }, el('div', { class: 'form-grid' }, field('Grade', gc), field('Label', gl), field('Uplift %', up), field('Cost uplift %', cu)), det));
    };
    (t ? t.grades : [null]).forEach(addRow);
    const out = outBox();
    const b = btn('Save', () => run(b, out, () => post('/cfg/grade-tables', { code: code.value, name: name.value, vendorId: vendor.value || null,
      grades: rows.filter((r) => r.gc.value.trim()).map((r) => ({ code: r.gc.value, label: r.gl.value, upliftPct: r.up.value, costUpliftPct: r.cu.value,
        adders: r.adders.filter((a) => a.price.value.trim()).map((a) => ({ pieceType: a.pt.code, price: a.price.value, cost: a.cost.value || 0 })) })) }), null, () => { d.close(); render(); }), { primary: true });
    d.body.append(el('div', { class: 'form-grid' }, field('Code', code), field('Name', name), field('Vendor', vendor)), list,
      el('div', { class: 'dlg-acts' }, btn('Add a grade', () => addRow(null)), b, btn('Cancel', d.close)), out);
  }
  function swatchDialog(o, s) {
    const d = openDialog(s ? s.name : 'New cover', 'Fabric or leather, in one vendor grade');
    const table = select(o.gradeTables.map((t) => [t.id, t.name]), s ? s.gradeTableId : (o.gradeTables[0] || {}).id);
    const code = input({ maxlength: '60', value: s ? s.code : '' }), name = input({ maxlength: '120', value: s ? s.name : '' }), grade = input({ maxlength: '12', value: s ? s.grade : '' });
    const material = select([['fabric', 'Fabric'], ['performance', 'Performance fabric'], ['leather', 'Leather'], ['vinyl', 'Vinyl']], s ? s.material : 'fabric');
    const color = select(o.colorFamilies.map((c) => [c, c]), s ? s.colorFamily : 'neutral'), colorName = input({ maxlength: '60', value: s && s.color ? s.color : '' });
    const content = input({ maxlength: '160', value: s && s.content ? s.content : '' });
    const clean = select(Object.entries(o.cleaning).map(([k, v]) => [k, `${k}: ${v}`]), s ? s.cleaningCode || '' : '', 'Not given');
    const vcode = input({ maxlength: '60', value: s && s.vendorCode ? s.vendorCode : '' }), img = input({ maxlength: '1000', value: s && s.imageUrl ? s.imageUrl : '', placeholder: 'https://…' });
    const hex = input({ maxlength: '7', value: s && s.hex ? s.hex : '', placeholder: '#1f2a44' }), disc = el('input', { type: 'date', value: s && s.discontinuedOn ? s.discontinuedOn : '' });
    const out = outBox();
    const b = btn('Save', () => run(b, out, () => post('/cfg/swatches', { tableId: table.value, code: code.value, name: name.value, grade: grade.value, material: material.value,
      colorFamily: color.value, color: colorName.value, content: content.value, cleaningCode: clean.value, vendorCode: vcode.value, imageUrl: img.value, hex: hex.value,
      discontinuedOn: disc.value }), null, () => { d.close(); render(); }), { primary: true });
    const photo = el('div');
    if (s && s.hasImage) coApi(`/cfg/swatches/${s.id}/image`).then((r) => { if (r && r.dataUrl) photo.replaceChildren(el('img', { src: r.dataUrl, alt: s.name, width: '120' })); }).catch(() => undefined);
    d.body.append(photo, el('div', { class: 'form-grid' }, field('Grade table', table), field('Code', code), field('Cover name', name), field('Grade', grade), field('Material', material),
      field('Color family', color), field('Color', colorName), field('Content', content), field('Cleaning code', clean), field('Vendor code', vcode), field('Swatch photo', img, 'Fetched once and kept, like product photos.'),
      field('Swatch color', hex), field('Discontinued on', disc)), el('div', { class: 'dlg-acts' }, b, btn('Cancel', d.close)), out);
  }

  async function rulesTab(o) {
    const products = [...o.families.map((f) => [f.product_id, `${f.name} (sectional)`]), ...o.configurable.filter((p) => !o.families.some((f) => f.product_id === p.id)).map((p) => [p.id, p.name])];
    const pSel = select(products, products[0] ? products[0][0] : '');
    const box = el('div');
    const load = async () => {
      box.replaceChildren(E.loadingNode());
      try {
        const rows = await coApi(`/cfg/rules?product=${encodeURIComponent(pSel.value)}`);
        box.replaceChildren(rows.length ? el('div', { class: 'panel' }, rows.map((r) => item({
          title: `${r.group_code}${r.option_code ? ` = ${r.option_code}` : ''} ${r.kind === 'only_on' ? 'only on' : r.kind} ${r.kind === 'only_on' ? r.piece_types.map(words).join(', ') : `${r.target_group}${r.target_options.length ? ` = ${r.target_options.join(' or ')}` : ''}`}`,
          detail: r.message || null, acts: [btn('Retire', async (e) => {
            const me = e.currentTarget;
            const why = await E.askReason({ title: 'Retire this rule', label: 'Why', confirm: 'Retire it' });
            if (why) await E.act(me, () => post(`/cfg/rules/${r.id}/retire`, { reason: why }), 'Rule retired.');
          }, { small: true })] }))) : empty('No rules on this product', 'Every combination of its options can be sold.', true));
      } catch (e) { box.replaceChildren(E.errorBox(e)); }
    };
    pSel.addEventListener('change', load);
    if (products.length) load();
    return section('Option rules', 'Requires, excludes, only on these pieces', [btn('Add a rule', () => ruleDialog(o, pSel.value), { primary: true })],
      field('Product', pSel), box);
  }
  function ruleDialog(o, productId) {
    const d = openDialog('New option rule', 'Checked at the register, on the tablet and on the web');
    const group = input({ maxlength: '40', placeholder: 'headrest' }), option = input({ maxlength: '60', placeholder: 'power-headrest (blank: any)' });
    const kind = select([['requires', 'requires'], ['excludes', 'excludes'], ['only_on', 'is only on these pieces']], 'requires');
    const tg = input({ maxlength: '40', placeholder: 'recline' }), to = input({ maxlength: '200', placeholder: 'power (blank: any)' });
    const pts = input({ maxlength: '400', placeholder: o.pieceTypes.slice(0, 3).map((p) => p.code).join(', ') });
    const msg = input({ maxlength: '300', placeholder: 'A power headrest needs power recline.' });
    const out = outBox();
    const b = btn('Save', () => run(b, out, () => post('/cfg/rules', { productId, group: group.value, option: option.value, kind: kind.value, targetGroup: tg.value,
      targetOptions: to.value, pieceTypes: pts.value, message: msg.value }), null, () => { d.close(); render(); }), { primary: true });
    d.body.append(el('div', { class: 'form-grid' }, field('Option group', group), field('Option', option), field('Rule', kind), field('Target group', tg, 'For requires and excludes.'),
      field('Target options', to, 'Comma separated.'), field('Piece types', pts, 'For only on: comma separated.', true), field('What the salesperson is told', msg, null, true)),
      el('div', { class: 'dlg-acts' }, b, btn('Cancel', d.close)), out);
  }

  // ============================================================ As-is grades
  function photoPicker(max = 4) {
    const list = [];
    const out = el('div', { class: 'sub' });
    const file = el('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, 'aria-label': 'Add photos' });
    file.addEventListener('change', async () => {
      for (const f of [...file.files].slice(0, max - list.length)) {
        try {
          const url = URL.createObjectURL(f);
          const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('not a picture')); i.src = url; });
          const k = Math.min(1, 1400 / Math.max(img.width, img.height));
          const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          URL.revokeObjectURL(url);
          list.push(cv.toDataURL('image/jpeg', 0.8));
        } catch (_) { toast(`${f.name} is not a picture`, 'warning'); }
      }
      out.textContent = list.length ? plural(list.length, 'photo') + ' ready' : '';
      file.value = '';
    });
    return { node: el('div', {}, file, out), value: () => list.slice() };
  }

  async function screenAsIs() {
    const o = await options(true);
    const label = input({ maxlength: '40', placeholder: 'Scan or type the label, like P000123', autocapitalize: 'characters', 'aria-label': 'Piece label' });
    const pieceBox = el('div');
    const look = async () => {
      const v = label.value.trim();
      if (!v) return;
      pieceBox.replaceChildren(E.loadingNode());
      try { pieceBox.replaceChildren(pieceCard(o, await coApi(`/cfg/condition/${encodeURIComponent(v)}`))); }
      catch (e) { pieceBox.replaceChildren(E.errorBox(e)); }
    };
    label.addEventListener('keydown', (e) => { if (e.key === 'Enter') look(); });
    const locSel = select(o.locations.map((l) => [l.id, l.name]), '', 'Every location');
    const repBox = el('div');
    const loadRep = async () => {
      repBox.replaceChildren(E.loadingNode());
      try {
        const r = await coApi(`/cfg/asis/report${locSel.value ? `?location=${locSel.value}` : ''}`);
        const cards = r.grades.filter((g) => g.pieces).map((g) => item({ title: g.words, amount: money(g.priceMinor),
          detail: `${plural(g.pieces, 'piece')} · retail ${money(g.retailMinor)} · ${g.byAge.filter((a) => a.pieces).map((a) => `${a.pieces} ${a.bucket}`).join(', ')}` }));
        const items = r.items.map((x) => item({ title: `${x.label} · ${x.name}`, amount: x.price_minor ? money(x.price_minor) : '—',
          detail: [x.gradeWords, x.location, `${x.age_days} days`, x.status.replace(/_/g, ' '), `retail ${money(x.retail_minor)}`].join(' · '),
          onClick: () => { label.value = x.label; look(); } }));
        const tags = btn('Print tags for these', () => printTags(r.items.map((x) => x.label)), { small: true });
        repBox.replaceChildren(cards.length ? el('div', { class: 'panel' }, cards) : empty('No as-is stock', null, true),
          items.length ? section('Pieces', plural(items.length, 'piece'), [tags], el('div', { class: 'panel' }, capped(items, 25, 'pieces'))) : null);
      } catch (e) { repBox.replaceChildren(E.errorBox(e)); }
    };
    locSel.addEventListener('change', loadRep);
    loadRep();
    const rules = o.conditionRules;
    const ins = o.conditions.map((g) => ({ g, i: input({ inputmode: 'decimal', value: String(rules[g.code] / 100), 'aria-label': `${g.label} %` }) }));
    const rout = outBox();
    const rsave = btn('Save', () => run(rsave, rout, () => post('/cfg/condition/rules', Object.fromEntries(ins.map((x) => [x.g.code, x.i.value]))), 'Saved.'), { primary: true });
    return frag(head('As-is grades', [], `${S.co.name} · condition, price and age of as-is, floor and returned pieces`),
      section('Grade a piece', null, null, el('div', { class: 'toolbar' }, el('div', { class: 'grow' }, label), btn('Look up', look, { primary: true })), pieceBox),
      section('As-is stock by grade and age', null, null, field('Location', locSel), repBox),
      section('Price per grade', 'Share of retail; the owner or controller sets it', null,
        el('div', { class: 'panel' }, el('div', { class: 'form-grid' }, ins.map((x) => field(`${x.g.label} %`, x.i))), el('div', { class: 'dlg-acts' }, rsave), rout)));
  }
  function pieceCard(o, x) {
    const cur = x.current;
    const grade = select(o.conditions.map((g) => [g.code, g.label]), cur ? cur.grade : 'good');
    const source = select([['as_is', 'As-is piece'], ['floor_sample', 'Floor sample'], ['return', 'Customer return']], cur ? cur.source : (x.status === 'returned' ? 'return' : 'as_is'));
    const notes = el('textarea', { maxlength: '1000', placeholder: 'Scuff on the left arm, small tear under the cushion…' });
    const photos = photoPicker();
    const price = input({ inputmode: 'decimal', placeholder: 'Leave blank for the grade price' }), why = input({ maxlength: '300', placeholder: 'Why the price differs' });
    const est = el('b');
    const showEst = () => { const pct = o.conditionRules[grade.value]; est.textContent = `${money(Math.round(Number(x.retailMinor) * pct / 10000))} (${pct / 100}% of ${money(x.retailMinor)})`; };
    grade.addEventListener('change', showEst); showEst();
    const out = outBox();
    const b = btn('Grade it', () => run(b, out, () => post(`/cfg/condition/${encodeURIComponent(x.label)}/grade`, { grade: grade.value, source: source.value, notes: notes.value,
      photos: photos.value(), price: price.value || null, reason: why.value || null }), (r) => `${r.label} is ${r.current.gradeWords}, ${money(r.current.price_minor)}.`,
      (r) => b.closest('.cfg-piece').replaceWith(pieceCard(o, r))), { primary: true });
    return el('div', { class: 'panel cfg-piece' },
      item({ title: `${x.label} · ${x.name}`, amount: cur ? money(cur.price_minor) : null, detail: [x.sku, x.location, x.status.replace(/_/g, ' '), cur ? `${cur.gradeWords}${cur.override_reason ? ' · price set by hand: ' + cur.override_reason : ''}` : 'not graded yet'].join(' · '),
        acts: [btn('Print tag', () => printTags([x.label]), { small: true })] }),
      el('div', { class: 'form-grid' }, field('Grade', grade), field('What it is', source), field('Grade price', est), field('Price by hand', price, 'Store manager only.'),
        field('Reason', why), field('Notes', notes, null, true), field('Photos', photos.node, null, true)),
      el('div', { class: 'dlg-acts' }, b), out,
      x.history.length > 1 ? section('Earlier gradings', null, null, el('div', { class: 'panel' }, x.history.filter((h) => h.superseded_at).map((h) =>
        item({ title: `${o.conditions.find((g) => g.code === h.grade).label} · ${money(h.price_minor)}`, detail: [h.graded_by, new Date(h.graded_at).toLocaleString(), h.notes].filter(Boolean).join(' · ') })))) : null);
  }
  function barcodeSvg(doc, bars, text, unit, h) {
    const total = bars.reduce((a, b) => a + b, 0) + 20;
    const s = doc.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', `0 0 ${total * unit} ${h + 12}`); s.setAttribute('width', String(total * unit)); s.setAttribute('height', String(h + 12));
    let x = 10 * unit;
    bars.forEach((w, i) => { if (i % 2 === 0) { const r = doc.createElementNS(SVGNS, 'rect'); r.setAttribute('x', String(x)); r.setAttribute('y', '0'); r.setAttribute('width', String(w * unit)); r.setAttribute('height', String(h)); s.append(r); } x += w * unit; });
    const t = doc.createElementNS(SVGNS, 'text'); t.setAttribute('x', String(total * unit / 2)); t.setAttribute('y', String(h + 10)); t.setAttribute('font-size', '10'); t.setAttribute('text-anchor', 'middle'); t.textContent = text; s.append(t);
    return s;
  }
  async function printTags(labels) {
    if (!labels.length) return;
    let items;
    try { items = await coApi(`/cfg/asis/tags?labels=${encodeURIComponent(labels.slice(0, 60).join(','))}`); } catch (e) { toast(friendly(e), 'critical'); return; }
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to print tags.', 'warning'); return; }
    const doc = w.document;
    doc.title = 'As-is tags';
    const css = new w.CSSStyleSheet();
    css.replaceSync(`body{font:14px system-ui,sans-serif;margin:0;padding:12px}.bar{margin-bottom:12px;display:flex;gap:12px;align-items:center}
      .sheet{display:flex;flex-wrap:wrap;gap:10px}.tag{width:3.4in;border:1px dashed #bbb;padding:.15in;box-sizing:border-box;break-inside:avoid}
      .tag h1{font-size:16px;margin:0 0 4px}.g{font-size:20px;font-weight:800;letter-spacing:.02em}.p{font-size:28px;font-weight:800}.was{text-decoration:line-through;color:#666}
      .n{font-size:12px;color:#333;margin:4px 0}@media print{.bar{display:none}body{padding:0}}`);
    doc.adoptedStyleSheets = [css];
    const mk = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const bar = mk('div', 'bar'); const pb = mk('button', null, 'Print'); pb.onclick = () => w.print();
    bar.append(pb, mk('span', null, `${items.length} as-is tags · ${S.co.name}`));
    const sheet = mk('div', 'sheet');
    for (const it of items) {
      const n = mk('div', 'tag');
      n.append(mk('div', 'n', 'AS IS · FINAL SALE'), mk('h1', null, it.name), mk('div', 'g', `Condition: ${it.gradeWords}`),
        it.notes ? mk('div', 'n', it.notes) : mk('div', 'n', it.sku), mk('div', 'was', `Retail ${money(it.retailMinor)}`), mk('div', 'p', it.priceMinor ? money(it.priceMinor) : 'Ask'),
        barcodeSvg(doc, it.barcode.bars, it.barcode.text, 1.5, 40));
      sheet.append(n);
    }
    doc.body.append(bar, sheet);
  }

  E.register('sectionals', 'Sectionals', 'sofa', screenSectionals, 'Retail', { icon: 'M3 15.5v-5a2 2 0 0 1 2-2h4v4h12v3|M3 15.5h18v3H3z|M9 8.5v-2h10a2 2 0 0 1 2 2v4', module: 'catalog' });
  E.register('asis', 'As-is grades', 'grade', screenAsIs, 'Operations', { icon: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z', module: 'inventory' });
})();
