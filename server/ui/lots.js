// lots screens: Serials and lots (recall search, capture by scan, one lot per
// order, strict mode, how products are matched), Labels (carton, bin and
// price-tag labels as a .zpl download, sent to a network printer, or a print
// page; templates and printers) and Finance settlements (lender files,
// exceptions, fee variances, chargebacks, what each lender owes).
// Registers with window.ERP (see docs/MODULES.md). Phone first: cards and
// pickers, no sideways tables; amounts sit on the right. Data is placed with
// textContent only.
(() => {
  'use strict';
  const E = window.ERP;
  const { el, frag, chip, money, plural, cap, coApi, post, go, toast, act, openDialog, resultBox, head, section, tile, tilesRow,
    empty, item, capped, seg, friendly, S, field, select, input, dayLabel } = E;

  const words = (s) => cap(String(s || '').replace(/_/g, ' '));
  const btn = (label, onclick, o = {}) => el('button', { class: 'btn' + (o.primary ? ' primary' : '') + (o.small ? ' small' : ''), type: 'button', onclick, disabled: o.disabled || null }, label);
  const panel = (...kids) => el('div', { class: 'panel' }, ...kids);
  const errSlot = () => el('div');
  const showErr = (slot) => (e) => slot.replaceChildren(resultBox('critical', 'fail', 'Not done', friendly(e)));
  const LOT_WORD = { dye_lot: 'Dye lot', finish_batch: 'Finish batch', batch: 'Batch' };
  /** Card or account numbers (13-19 digits) never show whole: only their last four. */
  const mask = (v) => (v == null ? v : String(v).replace(/(?:\d[ -]?){12,18}\d/g, (m) => '…' + m.replace(/\D/g, '').slice(-4)));
  // the label source tabs wrap on a phone rather than running off the side
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('.lots-wrap .seg{display:flex;flex-wrap:wrap;max-width:100%;gap:4px}.lots-wrap .seg>*{flex:1 1 auto;min-width:0}');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  /** Run fn, show what came back in slot (no full redraw unless asked). */
  async function run(b, slot, fn, ok, redraw) {
    b.disabled = true;
    try { const r = await fn(); if (ok) slot.replaceChildren(resultBox('good', 'ok', 'Done', typeof ok === 'function' ? ok(r) : ok)); if (redraw) await E.render(); return r; }
    catch (e) { slot.replaceChildren(resultBox('critical', 'fail', 'Not done', friendly(e))); return null; }
    finally { if (b.isConnected) b.disabled = false; }
  }
  function formDialog(title, sub, fields, label, send, okText) {
    const d = openDialog(title, sub);
    const err = errSlot();
    const b = btn(label, (e) => act(e.currentTarget, send, okText, { close: d.close, errorInto: showErr(err) }), { primary: true });
    d.body.append(el('div', { class: 'form-grid' }, fields), el('div', { class: 'dlg-acts' }, b, btn('Cancel', d.close)), err);
    return d;
  }

  // =================================================== Serials and lots
  async function screenLots() {
    const st = await coApi('/lots/settings');
    // recall and service search
    const q = input({ placeholder: 'Serial number or dye lot', autocapitalize: 'characters', enterkeyhint: 'search', 'aria-label': 'Serial or lot' });
    const found = el('div');
    const search = async () => {
      if (!q.value.trim()) return;
      try {
        const rows = await coApi(`/lots/search?q=${encodeURIComponent(q.value.trim())}`);
        found.replaceChildren(rows.length ? panel(capped(rows.map((r) => item({
          title: `${r.serial_no || r.label} · ${r.name}`,
          badge: chip(r.status === 'delivered' ? 'good' : 'neutral', r.status === 'delivered' ? 'ok' : 'pending', words(r.status)),
          detail: [r.lot_code ? `${LOT_WORD[r.lot_class] || 'Lot'} ${r.lot_code}` : 'no lot recorded', r.sku, r.labels, r.location,
            r.po_number ? `came on ${r.po_number}` : null].filter(Boolean).join(' · '),
          why: r.order_number ? `${r.order_number}${r.customer ? ' · ' + r.customer : ''}${r.phone ? ' · ' + r.phone : ''}${r.delivered_on ? ' · delivered ' + dayLabel(r.delivered_on) : ''}${r.stop_number ? ' · stop ' + r.stop_number : ''}` : null,
        })), 20, 'units')) : empty('Nothing found', 'No unit carries that serial or lot.', true));
      } catch (e) { found.replaceChildren(resultBox('critical', 'fail', 'Not searched', friendly(e))); }
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });

    // capture by scan
    const lbl = input({ placeholder: 'Scan the carton label', autocapitalize: 'characters', 'aria-label': 'Piece label' });
    const sn = input({ placeholder: 'Vendor serial', autocapitalize: 'characters', 'aria-label': 'Serial number' });
    const lot = input({ placeholder: 'Dye lot or finish batch', autocapitalize: 'characters', 'aria-label': 'Lot' });
    const capOut = errSlot();
    const save = btn('Save', (e) => run(e.currentTarget, capOut, () => post(`/lots/pieces/${encodeURIComponent(lbl.value.trim())}`,
      { ...(sn.value.trim() ? { serial: sn.value } : {}), ...(lot.value.trim() ? { lot: lot.value } : {}) }),
      (r) => `${r.label}: serial ${r.serial || 'none'}, lot ${r.lot || 'none'}`), { primary: true });

    // one lot per order
    const ono = input({ placeholder: 'Order number', autocapitalize: 'characters', 'aria-label': 'Order number' });
    const resOut = errSlot();
    const reserve = btn('Reserve pieces', (e) => run(e.currentTarget, resOut, async () => {
      const o = await coApi(`/lots/find-order?no=${encodeURIComponent(ono.value.trim())}`);
      const r = await post(`/lots/orders/${o.id}/reserve`, {});
      if (r.warnings.length) setTimeout(() => resOut.append(resultBox('warning', 'warn', 'Lots are mixed', r.warnings.join(' · '))), 0);
      return r;
    }, (r) => `${r.order}: ${plural(r.allocated, 'piece')} reserved${r.short ? `, ${r.short} not in stock` : ''}.`), { primary: true });

    const strictSeg = seg([['false', 'Warn when lots mix'], ['true', 'Refuse to mix lots']], String(st.strict), async (v) => {
      try { await post('/lots/settings', { strict: v === 'true' }); toast(v === 'true' ? 'Lots are strict now' : 'Lots warn only', 'good'); await E.render(); }
      catch (e) { toast(friendly(e), 'critical'); }
    });
    const products = st.products.filter((p) => p.serialized);
    const pCards = products.map((p) => item({
      title: `${p.name} · ${p.sku}`, badge: p.lot_class ? chip('good', 'ok', LOT_WORD[p.lot_class]) : chip('neutral', 'info', 'No lot'),
      detail: p.lot_class ? `matched as ${p.lot_group || [p.collection, p.color].filter(Boolean).join(' ') || 'itself'}` : 'not matched on an order',
      onClick: () => productDialog(p) }));
    return frag(
      head('Serials and lots', [], 'Operations · recalls, service and matching dye lots'),
      section('Find by serial or lot', 'recalls and service', null, el('div', { class: 'toolbar' }, q, btn('Search', search, { primary: true })), found),
      section('Record a serial or lot', 'scan a label, type what is on the vendor tag', null,
        el('div', { class: 'form-grid' }, field('Label', lbl), field('Serial', sn), field('Lot', lot)), el('div', { class: 'dlg-acts' }, save), capOut),
      section('Reserve pieces for an order', 'one dye lot or finish batch per cover', null,
        el('div', { class: 'toolbar' }, ono, reserve), resOut),
      section('When lots would mix', null, null, el('div', { class: 'toolbar' }, strictSeg)),
      section('How products are matched', products.length ? plural(products.length, 'product') : null, null,
        products.length ? panel(capped(pCards, 15, 'products')) : empty('No products tracked piece by piece', null, true)));
  }

  function productDialog(p) {
    const cls = select([['', 'Not matched'], ['dye_lot', 'Dye lot (upholstery, leather)'], ['finish_batch', 'Finish batch (wood case goods)'], ['batch', 'Batch']], p.lot_class || '');
    const grp = input({ value: p.lot_group || '', placeholder: [p.collection, p.color].filter(Boolean).join(' ') || 'Cover or finish name', maxlength: '80' });
    formDialog(p.name, p.sku, [field('Match by', cls), field('Cover or finish', grp, 'Pieces with the same name here should share a lot on an order')], 'Save',
      () => post(`/lots/products/${p.id}`, { lotClass: cls.value || null, lotGroup: grp.value }), 'Saved');
  }

  // ================================================================ Labels
  const lb = { source: 'receipt', id: '', locationId: '', labels: '', skus: '', templateId: '', printerId: '' };
  const SOURCES = [['receipt', 'Receipt'], ['prep', 'Prep queue'], ['manifest', 'Manifest'], ['pieces', 'Pieces'], ['bins', 'Bins'], ['tags', 'Price tags']];
  const KIND_OF = { receipt: 'carton', prep: 'carton', manifest: 'carton', pieces: 'carton', bins: 'bin', tags: 'price_tag' };

  function body() {
    const b = { source: lb.source, templateId: lb.templateId || null };
    if (['receipt', 'manifest'].includes(lb.source)) b.id = lb.id;
    if (['prep', 'bins'].includes(lb.source)) b.locationId = lb.locationId || null;
    if (lb.source === 'pieces') b.labels = lb.labels;
    if (lb.source === 'tags') b.skus = lb.skus;
    return b;
  }
  function printHref() {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(body())) if (v) p.set(k, String(v));
    if (S.person) p.set('as', S.person.id);
    return `/api/c/${S.co.id}/labels/print?${p}`;
  }

  async function screenLabels(sub) {
    const o = await coApi('/labels/options');
    const [k, v] = String(sub || '').split(':');
    if (k && SOURCES.some(([s]) => s === k)) { lb.source = k; if (k === 'prep') lb.locationId = v || ''; else if (v) lb.id = v; history.replaceState(null, '', `#/${S.co.id}/labels`); }
    const kind = KIND_OF[lb.source];
    const srcSeg = seg(SOURCES, lb.source, (x) => { lb.source = x; lb.id = ''; lb.templateId = ''; E.render(); });
    let pick;
    if (lb.source === 'receipt') {
      if (!lb.id && o.receipts[0]) lb.id = o.receipts[0].id;
      pick = select(o.receipts.map((r) => [r.id, `${r.number} · ${dayLabel(r.received_on)} · ${plural(r.lines, 'line')}`]), lb.id);
      pick.addEventListener('change', () => { lb.id = pick.value; });
      pick = field('Received', pick);
    } else if (lb.source === 'manifest') {
      if (!lb.id && o.routes[0]) lb.id = o.routes[0].id;
      pick = select(o.routes.map((r) => [r.id, `${r.number} · ${dayLabel(r.route_on)} · ${plural(r.pieces, 'piece')}`]), lb.id);
      pick.addEventListener('change', () => { lb.id = pick.value; });
      pick = field('Route', pick);
    } else if (lb.source === 'prep' || lb.source === 'bins') {
      const s = E.storePicker(select([['', lb.source === 'prep' ? 'Every location' : 'Pick a location'], ...o.locations.map((l) => [l.id, l.name])], lb.locationId));
      s.addEventListener('change', () => { lb.locationId = s.value; });
      pick = field(lb.source === 'prep' ? `Where (${plural(o.prepOpen, 'open job')})` : 'Location', s);
    } else {
      const ta = el('textarea', { rows: '3', placeholder: lb.source === 'tags' ? 'SKUs, one per line or separated by commas' : 'Scan piece labels, one per line', 'aria-label': 'List' });
      ta.value = lb.source === 'tags' ? lb.skus : lb.labels;
      ta.addEventListener('input', () => { if (lb.source === 'tags') lb.skus = ta.value; else lb.labels = ta.value; });
      pick = field(lb.source === 'tags' ? 'Products' : 'Pieces', ta, null, true);
    }
    const tpls = o.templates.filter((t) => t.kind === kind && t.active);
    const tSel = select([['', `Company default (${(tpls.find((t) => t.is_default) || o.defaults[kind]).name})`], ...tpls.map((t) => [t.id, `${t.name} · ${t.width_in} × ${t.height_in} in`])], lb.templateId);
    tSel.addEventListener('change', () => { lb.templateId = tSel.value; });
    const printers = o.printers.filter((p) => p.active);
    const pSel = select(printers.length ? printers.map((p) => [p.id, `${p.name}${p.location ? ' · ' + p.location : ''}`]) : [['', 'No printer set up']], lb.printerId || (printers[0] || {}).id || '');
    pSel.addEventListener('change', () => { lb.printerId = pSel.value; });
    const out = errSlot();
    const download = btn('Download .zpl', (e) => run(e.currentTarget, out, async () => {
      const r = await post('/labels/zpl', body());
      const a = el('a', { href: URL.createObjectURL(new Blob([r.zpl], { type: 'application/octet-stream' })), download: r.filename });
      document.body.append(a); a.click(); a.remove();
      return r;
    }, (r) => `${plural(r.labels, 'label')} (${r.template}) downloaded as ${r.filename}`), { primary: true });
    const send = btn('Send to printer', (e) => run(e.currentTarget, out, () => post('/labels/send', { ...body(), printerId: pSel.value }),
      (r) => `${plural(r.labels, 'label')} sent to ${r.printer}`), { disabled: !printers.length });
    const page = el('a', { class: 'btn', href: '#', target: '_blank', rel: 'noopener', onclick: (e) => { e.currentTarget.href = printHref(); } }, 'Print page (Dymo, desktop)');

    const tCards = o.templates.map((t) => item({ title: `${t.name}`, badge: t.is_default ? chip('good', 'ok', 'Default') : !t.active ? chip('neutral', 'info', 'Off') : null,
      detail: `${words(t.kind)} · ${t.width_in} × ${t.height_in} in · ${t.dpi} dpi · ${t.fields.map(words).join(', ')}`, onClick: () => templateDialog(o, t) }));
    const prCards = o.printers.map((p) => item({ title: p.name, badge: p.active ? chip('good', 'ok', 'On') : chip('neutral', 'info', 'Off'),
      detail: [`${p.host}:${p.port}`, p.location].filter(Boolean).join(' · '), onClick: () => printerDialog(o, p) }));
    const jobs = o.jobs.map((j) => item({ title: `${words(j.how)} · ${j.source}`, amount: plural(j.labels, 'label'),
      badge: chip(j.status === 'failed' ? 'critical' : 'good', j.status === 'failed' ? 'fail' : 'ok', words(j.status)),
      detail: [j.printer, j.by_name, dayLabel(String(j.at).slice(0, 10))].filter(Boolean).join(' · '), why: j.error || null }));
    return frag(
      head('Labels', [], 'Operations · cartons, bins and price tags'),
      section('Print', null, null, el('div', { class: 'toolbar lots-wrap' }, srcSeg), el('div', { class: 'form-grid' }, pick, field('Template', tSel), field('Printer', pSel)),
        el('div', { class: 'dlg-acts' }, download, send, page), out),
      section('Templates', 'size and fields, per kind of label', [btn('Add a template', () => templateDialog(o, null), { small: true })],
        o.templates.length ? panel(tCards) : empty('Built-in sizes in use', 'Carton 4 × 6, bin 4 × 2, price tag 4 × 3, at 203 dpi.', true)),
      section('Network printers', 'set up by the owner; private addresses only', [btn('Add a printer', () => printerDialog(o, null), { small: true })],
        o.printers.length ? panel(prCards) : empty('No printers yet', 'Labels can still be downloaded or printed from the page.', true)),
      section('Recently printed', null, null, o.jobs.length ? panel(capped(jobs, 8, 'jobs')) : empty('Nothing printed yet', null, true)));
  }

  function templateDialog(o, t) {
    const kind = select(o.kinds.map((k) => [k, words(k)]), t ? t.kind : 'carton');
    const name = input({ value: t ? t.name : '', maxlength: '60', placeholder: 'Carton 4 × 6' });
    const w = input({ inputmode: 'decimal', value: t ? String(t.width_in) : '4' }), h = input({ inputmode: 'decimal', value: t ? String(t.height_in) : '6' });
    const dpi = select([['203', '203 dpi'], ['300', '300 dpi'], ['600', '600 dpi']], t ? String(t.dpi) : '203');
    const box = el('div', { class: 'form-grid' });
    let ticks = [];
    const paint = () => {
      const chosen = t && t.kind === kind.value ? t.fields : o.defaults[kind.value].fields;
      ticks = o.fields[kind.value].map((f) => { const c = el('input', { type: 'checkbox', checked: chosen.includes(f) || null, 'aria-label': words(f) }); return [f, c]; });
      box.replaceChildren(...ticks.map(([f, c]) => el('label', { class: 'field' }, el('span', { text: words(f) }), c)));
    };
    kind.addEventListener('change', paint); paint();
    const def = el('input', { type: 'checkbox', checked: t && t.is_default ? true : null, 'aria-label': 'Company default' });
    const on = el('input', { type: 'checkbox', checked: !t || t.active ? true : null, 'aria-label': 'In use' });
    formDialog(t ? 'Change template' : 'Add a label template', 'What prints and how big', [field('Kind', kind), field('Name', name), field('Width (in)', w), field('Height (in)', h), field('Resolution', dpi),
      field('Company default', def), field('In use', on), el('div', { class: 'field wide' }, el('span', { text: 'Fields' }), box)], 'Save',
      () => post('/labels/templates', { id: t ? t.id : null, kind: kind.value, name: name.value, widthIn: Number(w.value), heightIn: Number(h.value), dpi: Number(dpi.value),
        fields: ticks.filter(([, c]) => c.checked).map(([f]) => f), isDefault: def.checked, active: on.checked }), 'Template saved');
  }

  function printerDialog(o, p) {
    const name = input({ value: p ? p.name : '', maxlength: '60', placeholder: 'Dock Zebra' });
    const host = input({ value: p ? p.host : '', placeholder: '192.168.1.50', inputmode: 'decimal' });
    const port = input({ value: p ? String(p.port) : '9100', inputmode: 'numeric' });
    const loc = E.storePicker(select([['', 'Any location'], ...o.locations.map((l) => [l.id, l.name])], p ? p.location_id || '' : ''));
    const on = el('input', { type: 'checkbox', checked: !p || p.active ? true : null, 'aria-label': 'In use' });
    formDialog(p ? 'Change printer' : 'Add a network printer', 'The owner only. A fixed private address (10.x, 172.16-31.x, 192.168.x), port 9100.',
      [field('Name', name), field('Address', host, 'An IP address; host names are not accepted'), field('Port', port), field('Where', loc), field('In use', on)], 'Save',
      () => post('/labels/printers', { id: p ? p.id : null, name: name.value, host: host.value, port: port.value, locationId: loc.value || null, active: on.checked }), 'Printer saved');
  }

  // ===================================================== Finance settlements
  async function screenSettlements() {
    const d = await coApi('/settlements');
    const ag = d.aging;
    const tiles = ag.lenders.map((l) => tile({ label: l.name, value: money(l.owedMinor), tone: l.exceptions ? 'warning' : 'neutral',
      text: l.exceptions ? `${plural(l.exceptions, 'exception')}` : 'owed to us', ic: l.exceptions ? 'warn' : 'info' }));
    const agingCards = ag.lenders.map((l) => item({ title: l.name, amount: money(l.owedMinor),
      detail: `0-30 ${money(l.current)} · 31-60 ${money(l.d31_60)} · 61-90 ${money(l.d61_90)} · 90+ ${money(l.over90)} · holdbacks ${money(l.holdbackMinor)}`
        + (Number(l.refundsDueBackMinor) ? ` · refunds to reverse ${money(l.refundsDueBackMinor)}` : ''),
      why: [l.reopened ? `${plural(l.reopened, 'chargeback')} reopened` : null, l.feeFlags ? `${plural(l.feeFlags, 'fee')} off the plan rate` : null].filter(Boolean).join(' · ') || null,
      acts: [btn('Set up file', () => lenderDialog(d, d.lenders.find((x) => x.id === l.companyId)), { small: true })] }));
    const exc = d.exceptions.map((x) => item({ title: `${x.company} · ${x.number} row ${x.row_no}`, amount: money(x.net_minor), badge: chip('warning', 'warn', words(x.kind)),
      detail: [x.auth_code ? `auth ${mask(x.auth_code)}` : null, x.account_last4 ? `account …${x.account_last4}` : null, x.txn_on].filter(Boolean).join(' · '), why: mask(x.exception),
      acts: [btn('Settle', () => exceptionDialog(d, x), { small: true, primary: true })] }));
    const aside = (d.setAside || []).map((x) => item({ title: `${x.company} · ${x.number} row ${x.row_no}`, amount: money(x.net_minor), badge: chip('neutral', 'hold', 'In 2195'),
      detail: [x.auth_code ? `auth ${mask(x.auth_code)}` : null, x.account_last4 ? `account …${x.account_last4}` : null, x.txn_on].filter(Boolean).join(' · '), why: mask(x.reason),
      acts: [btn('Apply to a sale', () => exceptionDialog(d, { ...x, exception: 'Set aside in 2195 unapplied finance deposits; pick the sale it pays.', applyOnly: true }), { small: true })] }));
    const vari = d.variances.map((x) => item({ title: `${x.company} · ${x.receipt}`, amount: money(x.fee_variance_minor),
      detail: `${x.plan || 'plan'} · sale ${money(x.gross_minor)} · fee taken ${money(x.fee_minor)} · plan rate ${money(x.expected_fee_minor)}`, badge: chip('warning', 'warn', 'Fee off') }));
    const reo = d.reopened.map((x) => item({ title: `${x.company} · ${x.receipt}`, amount: money(x.amount_minor), why: mask(x.chargeback_reason),
      detail: `charged back ${dayLabel(x.on_day)} · waiting to be funded again`,
      acts: [btn('Write off', async (e) => { const why = await E.askReason({ title: 'Write off the chargeback', sub: `${x.receipt} · ${money(x.amount_minor)} to 6915`, label: 'Why will it not be funded again?' });
        if (why) act(e.currentTarget, () => post(`/settlements/sales/${x.id}/charge-off`, { reason: why }), 'Written off'); }, { small: true })] }));
    const imps = d.imports.map((x) => item({ title: `${x.number} · ${x.company}`, amount: money(x.net_minor),
      badge: x.exceptions ? chip('warning', 'warn', plural(x.exceptions, 'exception')) : x.bank_linked ? chip('good', 'ok', 'In the bank') : chip('neutral', 'pending', 'Posted'),
      detail: [mask(x.filename), `${x.matched} of ${x.rows} matched`, x.deposit_on ? `deposit ${dayLabel(x.deposit_on)}` : null, x.imported_by].filter(Boolean).join(' · '), onClick: () => importDialog(x) }));
    return frag(
      head('Finance settlements', [btn('Import a file', () => importFile(d), { primary: true })], 'Back office · what lenders owe and what they sent'),
      tiles.length ? tilesRow(...tiles) : null,
      section('What each lender owes', `1110 ${money(ag.gl1110Minor)} · 1115 ${money(ag.gl1115Minor)}${Number(ag.differenceMinor) ? ` · ${money(ag.differenceMinor)} in 1110 not explained` : ''}`, null, ag.lenders.length ? panel(agingCards) : empty('No finance companies', 'Add them in Receivables.', true)),
      section('Exceptions', d.exceptions.length ? plural(d.exceptions.length, 'row') : null, null, d.exceptions.length ? panel(capped(exc, 10, 'rows')) : empty('Nothing waiting', 'Every row of every file matched a financed sale.')),
      section('Set aside (2195)', `${money(ag.gl2195Minor)} unapplied`, null, aside.length ? panel(capped(aside, 10, 'rows')) : empty('Nothing set aside', null, true)),
      section('Fees off the plan rate', null, null, d.variances.length ? panel(capped(vari, 10, 'fees')) : empty('Every fee matched its plan', null, true)),
      section('Chargebacks reopened', null, null, d.reopened.length ? panel(reo) : empty('None open', null, true)),
      section('Files imported', null, null, d.imports.length ? panel(capped(imps, 10, 'files')) : empty('No files yet', null, true)));
  }

  function lenderDialog(d, l) {
    if (!l) return;
    const m = l.remit_mapping || {};
    const col = (k, ph) => input({ value: m[k] || '', placeholder: ph, maxlength: '60', 'aria-label': k });
    const f = { date: col('date', 'Funding Date'), auth: col('auth', 'Auth Code'), account: col('account', 'Account'), gross: col('gross', 'Sale Amount'), fee: col('fee', 'Discount'),
      holdback: col('holdback', 'Holdback'), net: col('net', 'Net'), kind: col('kind', 'Type'), reason: col('reason', 'Reason'), plan: col('plan', 'Plan') };
    const fmt = select([['MM/DD/YYYY', 'MM/DD/YYYY'], ['YYYY-MM-DD', 'YYYY-MM-DD'], ['DD/MM/YYYY', 'DD/MM/YYYY']], m.dateFormat || 'MM/DD/YYYY');
    const bank = select([['', 'Undeposited funds (1050)'], ...d.banks.map((b) => [b.id, b.name])], l.bank_account_id || '');
    const tol = input({ inputmode: 'decimal', value: (Number(l.fee_tolerance_minor) / 100).toFixed(2) });
    const mode = select([['reopen', 'Reopen the sale (the lender owes it again)'], ['expense', 'Write it off to 6915']], l.chargeback_mode);
    const plans = d.plans.filter((p) => p.company_id === l.id).map((p) => `${p.code} ${(p.fee_bps / 100).toFixed(2)}%`).join(', ');
    formDialog(`${l.name} settlement file`, plans ? `Plan rates: ${plans}` : 'Column names as they appear in the file header',
      [field('Date column', f.date), field('Date format', fmt), field('Auth code column', f.auth), field('Account column', f.account), field('Sale amount column', f.gross),
        field('Fee column', f.fee), field('Holdback column', f.holdback), field('Net column', f.net), field('Type column', f.kind), field('Reason column', f.reason), field('Plan column', f.plan),
        field('Deposits land in', bank), field('Fee tolerance ($)', tol), field('A chargeback', mode)], 'Save',
      () => post(`/settlements/lenders/${l.id}`, { mapping: { ...Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value.trim() || undefined])), dateFormat: fmt.value },
        bankAccountId: bank.value || null, feeTolerance: tol.value, chargebackMode: mode.value }), 'Saved');
  }

  function importFile(d) {
    const co = select(d.lenders.map((l) => [l.id, l.name]), (d.lenders[0] || {}).id);
    const file = el('input', { type: 'file', accept: '.csv,text/csv,text/plain', 'aria-label': 'Settlement file' });
    const dep = input({ type: 'date', 'aria-label': 'Deposit date' });
    const dd = openDialog('Import a settlement file', 'The lender’s remittance CSV');
    const out = errSlot();
    const go_ = btn('Import', (e) => run(e.currentTarget, out, async () => {
      const f = file.files[0];
      if (!f) throw new Error('Pick the file first');
      const text = await f.text();
      return post('/settlements/import', { companyId: co.value, filename: f.name, text, depositOn: dep.value || null });
    }, (r) => `${r.number}: ${r.matched} of ${r.rows} rows matched${r.exceptions ? `, ${plural(r.exceptions, 'exception')}` : ''}${r.feeFlags ? `, ${plural(r.feeFlags, 'fee')} off the plan rate` : ''}. `
      + (r.bankLinked ? 'Linked to the bank.' : r.bankNote || ''), true), { primary: true });
    dd.body.append(el('div', { class: 'form-grid' }, field('Finance company', co), field('File', file), field('Deposit date', dep, 'Leave empty to use the file’s last date')),
      el('div', { class: 'dlg-acts' }, go_, btn('Close', dd.close)), out);
  }

  function exceptionDialog(d, x) {
    const sales = d.sales.filter((s) => s.company_id === x.company_id && (x.kind === 'funding' ? s.status === 'awaiting_funding' : Number(s.funded_gross_minor) > 0));
    const pick = select([['', 'Pick the financed sale'], ...sales.map((s) => [s.id, `${s.receipt} · ${s.customer || ''} · ${money(s.left_minor)} left of ${money(s.amount_minor)}${s.auth_code ? ' · ' + mask(s.auth_code) : ''}`])], '');
    const why = input({ placeholder: 'Or set it aside: why', maxlength: '300' });
    const dd = openDialog('Settle an exception', `${x.company} · ${x.number} row ${x.row_no} · ${money(x.net_minor)}`);
    const out = errSlot();
    const b1 = btn('Match and post', (e) => act(e.currentTarget, () => post(`/settlements/lines/${x.id}/resolve`, { financedSaleId: pick.value }), 'Posted', { close: dd.close, errorInto: showErr(out) }), { primary: true });
    const b2 = x.applyOnly ? null : btn('Set aside', (e) => act(e.currentTarget, () => post(`/settlements/lines/${x.id}/resolve`, { dismissReason: why.value }),
      Number(x.net_minor) ? 'Set aside in 2195' : 'Set aside', { close: dd.close, errorInto: showErr(out) }));
    dd.body.append(el('p', { class: 'lead', text: mask(x.exception) }), el('div', { class: 'form-grid' }, field('Financed sale', pick), x.applyOnly ? null : field('Reason', why, Number(x.net_minor) ? 'The money still goes to the bank, held in 2195 until it is applied' : null)),
      el('div', { class: 'dlg-acts' }, b1, b2), out);
  }

  async function importDialog(x) {
    const dd = openDialog(`${x.number} · ${x.company}`, x.filename || 'settlement file');
    try {
      const rows = await coApi(`/settlements/imports/${x.id}`);
      dd.body.append(el('div', { class: 'panel' }, rows.map((r) => item({ title: `Row ${r.row_no} · ${words(r.kind)}${r.receipt ? ' · ' + r.receipt : ''}`, amount: money(r.net_minor),
        badge: r.status === 'posted' ? (r.fee_flag ? chip('warning', 'warn', 'Fee off') : chip('good', 'ok', 'Posted')) : r.status === 'exception' ? chip('warning', 'warn', 'Exception') : chip('neutral', 'info', r.status === 'suspense' ? 'In 2195' : 'Set aside'),
        detail: [r.auth_code ? `auth ${mask(r.auth_code)}` : null, r.account_last4 ? `…${r.account_last4}` : null, r.gross_minor !== '0' ? `sale ${money(r.gross_minor)}` : null,
          r.fee_minor !== '0' ? `fee ${money(r.fee_minor)}` : null, r.holdback_minor !== '0' ? `holdback ${money(r.holdback_minor)}` : null, r.chargeback_mode ? words(r.chargeback_mode) : null].filter(Boolean).join(' · '),
        why: mask(r.exception) || mask(r.reason) || (r.fee_flag ? `plan rate ${money(r.expected_fee_minor)}, off by ${money(r.fee_variance_minor)}` : null) }))));
    } catch (e) { dd.body.append(resultBox('critical', 'fail', 'Not loaded', friendly(e))); }
  }

  E.register('lots', 'Serials and lots', 'box', screenLots, 'Operations', { module: 'lots' });
  E.register('labels', 'Labels', 'tag', screenLabels, 'Operations', { module: 'labels' });
  E.register('settlements', 'Finance settlements', 'cash', screenSettlements, 'Back office', { module: 'settlements' });
})();
