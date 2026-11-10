// Containers and prep: containers and freight from the vendor to the DC
// (stages, what each carries, freight and duty spread into landed cost,
// unloading in part), goods on the road, and the deluxing / touch-up /
// assembly queue warehouse staff work from a phone. Cards and pickers only,
// never a wide table.
(() => {
  'use strict';
  const E = window.ERP;
  if (!E) return;
  const { el, frag, section, head, item, chip, money, openDialog, fillDialog, post, coApi, toast, seg, empty, resultBox,
    plural, shortDay, dayLabel, ago, busy, friendly, go, S, fact, capped, todayIso } = E;

  const TABS = [['containers', 'Containers'], ['transit', 'In transit'], ['prep', 'Prep queue'], ['rules', 'Prep rules'], ['settings', 'Settings']];
  const words = (s) => String(s || '').replace(/_/g, ' ');
  const cap1 = (s) => { const w = words(s); return w.charAt(0).toUpperCase() + w.slice(1); };
  const qty = (n) => { const x = Number(n || 0); return Number.isInteger(x) ? String(x) : x.toFixed(2); };
  const field = (label, control, hint) => el('label', { class: 'field' }, el('span', { text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null);
  const select = (options, value, placeholder) => el('select', {}, placeholder ? el('option', { value: '', text: placeholder }) : null,
    options.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(value ?? '') || null })));
  const input = (attrs) => el('input', Object.assign({ type: 'text' }, attrs));
  const dateInput = (value, label) => el('input', { type: 'date', value: value || '', 'aria-label': label });
  const outBox = () => el('div', { role: 'status', 'aria-live': 'polite' });
  const btn = (text, onclick, opts = {}) => el('button', { class: 'btn' + (opts.small ? ' small' : '') + (opts.primary ? ' primary' : ''), type: 'button', onclick }, text);
  const STAGE_TONE = { booked: 'neutral', departed: 'neutral', at_port: 'warning', customs_cleared: 'warning', on_rail: 'warning', delivered_dc: 'good', unloaded: 'good' };
  const JOB_TONE = { queued: 'neutral', in_progress: 'warning', done: 'good', problem: 'critical', cancelled: 'neutral' };
  const PREP_LABEL = { unbox: 'Unbox', inspect: 'Inspect', touch_up: 'Touch-up', steam: 'Steam', assemble: 'Assemble' };

  /** Run a change: busy, the result in the box (or a toast), then the caller's refresh. */
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

  let opts = null;
  async function options() { if (!opts || opts.co !== S.co.id) opts = { co: S.co.id, ...(await coApi('/wms/options')) }; return opts; }

  /** Pictures from the phone's camera, made small enough to keep (the way service tickets keep theirs). */
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

  // =================================================================== screen
  async function screen(sub) {
    const tab = TABS.some(([k]) => k === sub) ? sub : 'containers';
    const body = await ({ containers: containersTab, transit: transitTab, prep: prepTab, rules: rulesTab, settings: settingsTab })[tab]();
    const pick = select(TABS, tab);
    pick.addEventListener('change', () => go('wms', pick.value));
    return frag(head('Containers and prep', [], `${S.co.name} · inbound freight and the prep queue`),
      el('div', { class: 'toolbar' }, field('Show', pick)), body);
  }

  // ------------------------------------------------------------- containers
  async function containersTab() {
    const [list, o] = await Promise.all([coApi('/wms/containers'), options()]);
    return section('Containers', 'from the vendor to the DC', [btn('Book a container', () => newContainer(o), { small: true, primary: true })],
      el('div', { class: 'panel' }, list.length ? capped(list.map((c) => item({
        title: `${c.container_no || c.number} · ${c.vendor || c.carrier || 'container'}`,
        amount: c.eta_dc ? `DC ${shortDay(c.eta_dc)}` : 'no ETA',
        badge: chip(STAGE_TONE[c.stage] || 'neutral', c.stage === 'unloaded' ? 'ok' : 'info', cap1(c.stage === 'delivered_dc' ? 'at the DC' : c.stage)),
        detail: [c.number, c.dest, plural(c.lines, 'line'), `${qty(c.received)} of ${qty(c.units)} in`, Number(c.costs_minor) ? `${money(c.costs_minor)} freight and fees` : null,
          c.vessel ? `vessel ${c.vessel}` : null, c.bol ? `BOL ${c.bol}` : null].filter(Boolean).join(' · '),
        onClick: () => openContainer(c.id) })), 12, 'containers')
        : [empty('No containers yet.', 'Book one when the vendor confirms the booking, or it opens itself from a ship notice that names it.', true)]));
  }

  function newContainer(o) {
    const d = openDialog('Book a container', 'or a domestic trailer');
    const f = { no: input({ maxlength: '20', placeholder: 'MSCU1234567', autocapitalize: 'characters' }), carrier: input({ maxlength: '80' }),
      vessel: input({ maxlength: '80' }), voyage: input({ maxlength: '40' }), bol: input({ maxlength: '60' }), pol: input({ maxlength: '80', placeholder: 'Ningbo' }),
      pod: input({ maxlength: '80', placeholder: 'Houston' }), dest: E.storePicker(select(o.locations.map((l) => [l.id, l.name]), (o.locations[0] || {}).id)),
      vendor: select(o.vendors.map((v) => [v.id, v.name]), '', 'Vendor (optional)'), eta: dateInput('', 'Expected at the DC') };
    const out = outBox();
    d.body.append(el('div', { class: 'form-grid' }, field('Container or trailer number', f.no), field('Coming into', f.dest), field('Vendor', f.vendor),
      field('Carrier', f.carrier), field('Vessel', f.vessel), field('Voyage', f.voyage), field('Bill of lading', f.bol),
      field('Port of loading', f.pol), field('Port of discharge', f.pod), field('Expected at the DC', f.eta)),
      el('div', { class: 'dlg-acts' }, btn('Book it', (e) => run(e.currentTarget, out, () => post('/wms/containers', { containerNo: f.no.value, destLocationId: f.dest.value,
        vendorId: f.vendor.value || null, carrier: f.carrier.value, vessel: f.vessel.value, voyage: f.voyage.value, bol: f.bol.value, portLoading: f.pol.value,
        portDischarge: f.pod.value, etaDc: f.eta.value }), (r) => `${r.number} booked.`, async (r) => { d.close(); await E.render(); openContainer(r.id); }), { primary: true }),
        btn('Cancel', () => d.close())), out);
  }

  function openContainer(id) {
    const d = openDialog('Container', '', { wide: true });
    const load = () => fillDialog(d, async () => {
      const [c, o] = await Promise.all([coApi(`/wms/containers/${id}`), options()]);
      const h2 = d.dlg.querySelector('h2'); if (h2) h2.textContent = c.container_no || c.number;
      const reload = async () => { await load(); E.render(); };
      const out = outBox();
      return frag(
        el('div', { class: 'facts' }, fact('Ours', c.number), fact('Stage', cap1(c.stage)), fact('Coming into', c.dest || ''), fact('At the DC', c.eta_dc ? dayLabel(c.eta_dc) : 'not known'),
          fact('Carrier', c.carrier || '—'), fact('Vessel', c.vessel || '—'), fact('Bill of lading', c.bol || '—'),
          fact('Ports', [c.port_loading, c.port_discharge].filter(Boolean).join(' → ') || '—')),
        out,
        section('Stages', 'expected and actual days', null, el('div', { class: 'panel' }, c.stages.map((st) => {
          const exp = dateInput(st.expected_on, `${st.label} expected`), act = dateInput(st.actual_on, `${st.label} happened`);
          act.max = todayIso();
          return item({ title: st.label, badge: st.actual_on ? chip('good', 'ok', `done ${shortDay(st.actual_on)}`) : st.expected_on ? chip('neutral', 'clock', `due ${shortDay(st.expected_on)}`) : null,
            why: null, acts: [field('Expected', exp), field('Happened', act), btn('Save', (e) => run(e.currentTarget, out, () => post(`/wms/containers/${id}/stage`,
              { stage: st.stage, expectedOn: exp.value, actualOn: act.value }), (r) => `${st.label} saved${r.etaMoved ? `; ${plural(r.etaMoved, 'PO line')} and the special orders on them now due ${shortDay(r.arrivalOn)}` : ''}.`, reload), { small: true })] });
        }))),
        section('What it carries', null, c.stage === 'unloaded' ? null : [btn('Add PO lines', () => addLines(c, reload), { small: true })],
          el('div', { class: 'panel' }, c.lines.length ? c.lines.map((l) => item({ title: `${l.name} · ${l.sku}`, amount: `${qty(l.received_qty)} of ${qty(l.qty)} in`,
            detail: [`${l.po_number} line ${l.seq}`, `PO cost ${money(l.unit_minor)}`, Number(l.container_landed_minor) ? `freight and fees ${money(l.container_landed_minor)}` : null,
              Number(l.qty) > 0 && (Number(l.landed_minor) || Number(l.container_landed_minor)) ? `lands at ${money(Number(l.unit_minor)
                + (Number(l.ordered) > 0 ? Math.round(Number(l.landed_minor) / Number(l.ordered)) : 0) + Math.round(Number(l.container_landed_minor) / Number(l.qty)))} a unit` : null,
              l.expected_on ? `due ${shortDay(l.expected_on)}` : null].filter(Boolean).join(' · ') }))
            : empty('Nothing on it yet.', 'Add the purchase order lines it carries, with how many of each.', true))),
        section('Freight, drayage, duty and fees', 'spread into each line’s landed cost', [btn('Add a cost', () => addCost(c, o, reload), { small: true })],
          el('div', { class: 'panel' }, c.costs.length ? c.costs.map((k) => item({ title: cap1(k.kind), amount: money(k.amount_minor),
            detail: [`by ${k.basis === 'qty' ? 'quantity' : k.basis}`, k.note, k.by_name, ago(k.created_at)].filter(Boolean).join(' · ') }))
            : empty('No costs yet.', null, true))),
        c.notices.length ? section('Ship notices', null, null, el('div', { class: 'panel' }, c.notices.map((n) => item({ title: `ASN ${n.asn_number}`,
          detail: [n.po_number, n.carrier, n.shipped_on ? `shipped ${shortDay(n.shipped_on)}` : null, n.expected_on ? `due ${shortDay(n.expected_on)}` : null].filter(Boolean).join(' · ') })))) : null,
        c.stage !== 'unloaded' && c.lines.some((l) => Number(l.received_qty) < Number(l.qty))
          ? el('div', { class: 'dlg-acts' }, btn('Unload…', () => unload(c, reload), { primary: true })) : null);
    });
    load();
  }

  function addLines(c, after) {
    const d = openDialog('Put PO lines on the container', c.container_no || c.number);
    fillDialog(d, async () => {
      const rows = (await coApi('/wms/container-lines')).filter((l) => Number(l.room) > 0);
      if (!rows.length) return empty('No open PO lines with anything left to ship.', null, true);
      const pick = select(rows.map((l) => [l.id, `${l.po_number} · ${l.seq}. ${l.name} (${qty(l.room)} left)`]), rows[0].id);
      const n = input({ inputmode: 'decimal', value: qty(rows[0].room), 'aria-label': 'Quantity on the container' });
      pick.addEventListener('change', () => { const r = rows.find((x) => x.id === pick.value); n.value = qty(r ? r.room : 0); });
      const out = outBox();
      return frag(el('div', { class: 'form-grid' }, field('PO line', pick), field('How many are on it', n)),
        el('div', { class: 'dlg-acts' }, btn('Add', (e) => run(e.currentTarget, out, () => post(`/wms/containers/${c.id}/lines`, { lines: [{ poLineId: pick.value, qty: n.value }] }),
          (r) => `On ${r.number}.${r.etaMoved ? ` ${plural(r.etaMoved, 'line')} now follow its arrival day.` : ''}`, async () => { d.close(); await after(); }), { primary: true }),
          btn('Cancel', () => d.close())), out);
    });
  }

  function addCost(c, o, after) {
    const d = openDialog('Freight, duty or fees', c.container_no || c.number);
    const kind = select(o.costKinds.map((k) => [k, cap1(k)]), 'freight');
    const amt = input({ inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'Amount' });
    const basis = select(o.costBases.map((b) => [b, b === 'qty' ? 'By quantity' : `By ${b}`]), 'cube');
    kind.addEventListener('change', () => { basis.value = ['duty', 'tariff'].includes(kind.value) ? 'value' : 'cube'; });
    const note = input({ maxlength: '300', placeholder: 'Invoice number, broker' });
    const out = outBox();
    d.body.append(el('div', { class: 'form-grid' }, field('What', kind), field('Amount', amt), field('Spread', basis, 'Freight usually by cube, duty by value'), field('Note', note)),
      el('div', { class: 'dlg-acts' }, btn('Add', (e) => run(e.currentTarget, out, () => post(`/wms/containers/${c.id}/costs`, { kind: kind.value, amount: amt.value, basis: basis.value, note: note.value }),
        (r) => `Spread over ${plural(r.shares.length, 'share')}; receiving values the goods with it.`, async () => { d.close(); await after(); }), { primary: true }), btn('Cancel', () => d.close())), out);
  }

  function unload(c, after) {
    const d = openDialog('Unload', `${c.container_no || c.number} into ${c.dest || 'the DC'}`, { wide: true });
    const rows = c.lines.filter((l) => Number(l.received_qty) < Number(l.qty)).map((l) => {
      const left = Number(l.qty) - Number(l.received_qty);
      const n = input({ inputmode: 'decimal', value: qty(left), 'aria-label': `Unloaded of ${l.name}` });
      const dmg = input({ inputmode: 'decimal', value: '0', 'aria-label': `Damaged of ${l.name}` });
      return { l, n, dmg, node: item({ title: `${l.name} · ${l.sku}`, amount: `${qty(left)} left`, detail: `${l.po_number} line ${l.seq}`,
        acts: [field('Unloaded', n), field('Damaged', dmg)] }) };
    });
    const out = outBox();
    d.body.append(el('p', { class: 'lead', text: 'Count what came off. Anything left stays on the container for the next receipt.' }),
      el('div', { class: 'panel' }, rows.map((r) => r.node)),
      el('div', { class: 'dlg-acts' }, btn('Receive', (e) => run(e.currentTarget, out, () => post(`/wms/containers/${c.id}/receive`,
        { lines: rows.map((r) => ({ containerLineId: r.l.id, qty: r.n.value, damagedQty: r.dmg.value })) }),
        (r) => `${r.receipts.map((x) => x.poNumber).join(', ')} received${r.receipts.reduce((a, x) => a + x.prepQueued, 0) ? `; ${plural(r.receipts.reduce((a, x) => a + x.prepQueued, 0), 'prep job')} queued` : ''}${r.unloaded ? '. The container is unloaded.' : `. ${plural(r.linesLeft, 'line')} still on it.`}`,
        async () => { await after(); }), { primary: true }), btn('Close', () => d.close())), out);
  }

  // -------------------------------------------------------------- in transit
  async function transitTab() {
    const [rows, o] = await Promise.all([coApi('/wms/in-transit'), options()]);
    const loc = E.storePicker(select(o.locations.map((l) => [l.id, l.name]), '', 'Going anywhere'));
    const list = el('div', { class: 'panel' });
    const paint = (rs) => list.replaceChildren(...(rs.length ? capped(rs.map((r) => item({ title: `${r.name} · ${r.sku}`, amount: `${qty(r.qty)} on the way`,
      badge: chip('neutral', 'clock', r.arriving_on ? `arriving ${shortDay(r.arriving_on)}` : 'no date yet'),
      detail: [r.source === 'po' ? `PO ${r.ref_no}` : `transfer ${r.ref_no}`, `to ${r.to_name}`].join(' · ') })), 15, 'items')
      : [empty('Nothing on the road.', 'Shipped purchase orders and transfers show here until they are received.', true)]));
    loc.addEventListener('change', async () => {
      try { paint(await coApi(`/wms/in-transit?locationId=${encodeURIComponent(loc.value)}`)); } catch (e) { list.replaceChildren(E.errorBox(e)); }
    });
    paint(rows);
    return section('Goods in transit', 'shipped, not yet received', null, el('div', { class: 'toolbar' }, field('Where to', loc)), list);
  }

  // -------------------------------------------------------------- prep queue
  let prepLoc = '', prepStatus = '';
  async function prepTab() {
    const o = await options();
    const loc = E.storePicker(select(o.locations.map((l) => [l.id, l.name]), prepLoc, 'Every location'));
    const list = el('div', { class: 'panel' }, E.loadingNode());
    const label = input({ placeholder: 'Scan a label to queue prep', autocapitalize: 'characters', 'aria-label': 'Piece label' });
    const kind = select(o.prepTypes.map((t) => [t, PREP_LABEL[t] || cap1(t)]), 'touch_up');
    const qout = outBox();
    const load = async () => {
      prepLoc = loc.value;
      try {
        const rows = await coApi(`/wms/prep?locationId=${encodeURIComponent(prepLoc)}${prepStatus ? `&status=${prepStatus}` : ''}`);
        list.replaceChildren(...(rows.length ? capped(rows.map((j) => jobCard(j, load)), 15, 'jobs') : [empty('Nothing to prep.', 'Goods whose product or category needs prep are queued when they are received.', true)]));
      } catch (e) { list.replaceChildren(E.errorBox(e, load)); }
    };
    loc.addEventListener('change', load);
    const segBox = el('div');
    const paintSeg = () => segBox.replaceChildren(seg([['', 'Open'], ['done', 'Done'], ['problem', 'Problems']], prepStatus, (v) => { prepStatus = v; paintSeg(); load(); }));
    paintSeg();
    await load();
    const labor = await coApi('/wms/prep/labor');
    return frag(
      section('Prep queue', 'unbox, inspect, touch-up, steam, assemble', E.canSee('labels') ? [btn('Print labels', () => go('labels', 'prep' + (prepLoc ? ':' + prepLoc : '')), { small: true })] : null,
        el('div', { class: 'toolbar' }, field('Where', loc), segBox), list),
      section('Queue a piece by hand', null, null, el('div', { class: 'form-grid' }, field('Label', label), field('Prep', kind)),
        el('div', { class: 'dlg-acts' }, btn('Queue it', (e) => run(e.currentTarget, qout, () => post('/wms/prep/queue', { label: label.value, prepType: kind.value }),
          (r) => `${r.number} queued.`, async () => { label.value = ''; await load(); }), { primary: true })), qout),
      section('Labor, last 30 days', null, null, el('div', { class: 'panel' }, labor.length ? labor.map((x) => item({ title: PREP_LABEL[x.prep_type] || cap1(x.prep_type),
        amount: `${x.minutes} min`, detail: [plural(x.jobs, 'job'), x.std_minutes ? `standard ${x.std_minutes} min` : null, x.jobs ? `${Math.round(x.minutes / x.jobs)} min a job` : null].filter(Boolean).join(' · ') }))
        : empty('No prep finished yet.', null, true))));
  }

  function jobCard(j, refresh) {
    const acts = [];
    if (j.status === 'queued' || j.status === 'problem') acts.push(btn('Start', (e) => run(e.currentTarget, null, () => post(`/wms/prep/${j.id}/start`), `${j.number} started.`, refresh), { small: true, primary: j.status === 'queued' }));
    if (j.status === 'queued' || j.status === 'in_progress') {
      acts.push(btn('Done', () => doneDialog(j, refresh), { small: true, primary: j.status === 'in_progress' }));
      acts.push(btn('Problem', () => problemDialog(j, refresh), { small: true }));
    }
    return item({ title: `${PREP_LABEL[j.prep_type] || cap1(j.prep_type)} · ${j.name}`,
      amount: j.labor_minutes != null ? `${j.labor_minutes} min` : j.std_minutes ? `std ${j.std_minutes} min` : '',
      badge: chip(JOB_TONE[j.status] || 'neutral', j.status === 'done' ? 'ok' : j.status === 'problem' ? 'warn' : 'info', cap1(j.status)),
      detail: [j.number, j.labels || (Number(j.qty) !== 1 ? `${qty(j.qty)} units` : null), j.bin ? `bin ${j.bin}` : null, j.location, j.order_number ? `for ${j.order_number}` : null,
        j.started_by && j.status === 'in_progress' ? `${j.started_by}, ${ago(j.started_at)}` : null, j.damage ? `on hold ${j.damage}` : null].filter(Boolean).join(' · '),
      why: j.problem || null, acts });
  }

  function doneDialog(j, refresh) {
    const d = openDialog(`${PREP_LABEL[j.prep_type] || cap1(j.prep_type)} done`, `${j.number} · ${j.name}`);
    const mins = input({ inputmode: 'numeric', placeholder: j.started_at ? 'Leave blank to use the time since it started' : 'Minutes it took', 'aria-label': 'Labor minutes' });
    const note = input({ maxlength: '300' });
    const out = outBox();
    d.body.append(el('div', { class: 'form-grid' }, field('Labor minutes', mins), field('Note', note)),
      el('div', { class: 'dlg-acts' }, btn('Mark done', (e) => run(e.currentTarget, out, () => post(`/wms/prep/${j.id}/done`, { laborMinutes: mins.value, note: note.value }),
        (r) => `${r.number} done, ${r.laborMinutes} min.`, async () => { d.close(); await refresh(); }), { primary: true }), btn('Cancel', () => d.close())), out);
  }

  function problemDialog(j, refresh) {
    const d = openDialog('Flag a problem', `${j.number} · ${j.name}`);
    const what = el('textarea', { maxlength: '500', placeholder: 'Gouge on the left arm, broken leg, wrong finish…', 'aria-label': 'What is wrong' });
    const photos = photoPicker();
    const out = outBox();
    d.body.append(el('p', { class: 'lead', text: 'The piece goes on damage hold until it is repaired, claimed or written off.' }),
      field('What is wrong', what), field('Photos', photos.node),
      el('div', { class: 'dlg-acts' }, btn('Put on hold', (e) => run(e.currentTarget, out, () => post(`/wms/prep/${j.id}/problem`, { problem: what.value, photos: photos.value() }),
        (r) => `${r.number}: on damage hold as ${r.damage}.`, async () => { d.close(); await refresh(); }), { primary: true }), btn('Cancel', () => d.close())), out);
  }

  // -------------------------------------------------------------- prep rules
  async function rulesTab() {
    const [rules, o] = await Promise.all([coApi('/wms/prep/rules'), options()]);
    const whatKind = select([['category', 'A whole category'], ['product', 'One product']], 'category');
    const cat = select(o.categories.map((x) => [x, x]), o.categories[0] || '');
    const prod = select(o.products.map((p) => [p.id, `${p.name} · ${p.sku}`]), '');
    const catField = field('Category', cat), prodField = field('Product', prod);
    prodField.hidden = true;
    whatKind.addEventListener('change', () => { catField.hidden = whatKind.value !== 'category'; prodField.hidden = whatKind.value !== 'product'; });
    const boxes = o.prepTypes.map((t) => { const b = el('input', { type: 'checkbox', value: t }); return { t, b, node: el('label', { class: 'field inline' }, b, el('span', { text: PREP_LABEL[t] || cap1(t) })) }; });
    const mins = input({ inputmode: 'numeric', placeholder: 'e.g. 20', 'aria-label': 'Standard minutes' });
    const out = outBox();
    return frag(
      section('Which goods need prep', 'a product’s own rule wins over its category’s', null, el('div', { class: 'panel' }, rules.length ? rules.map((r) => item({
        title: r.product_id ? `${r.name} · ${r.sku}` : `${r.category} (category)`, amount: r.std_minutes ? `${r.std_minutes} min` : '',
        badge: r.active ? chip('good', 'ok', 'on') : chip('neutral', 'info', 'off'), detail: r.prep_types.map((t) => PREP_LABEL[t] || cap1(t)).join(' → '),
        acts: [btn(r.active ? 'Turn off' : 'Turn on', (e) => run(e.currentTarget, null, () => post('/wms/prep/rules', { productId: r.product_id, category: r.product_id ? null : r.category,
          prepTypes: r.prep_types, stdMinutes: r.std_minutes, active: !r.active }), 'Saved.', () => E.render()), { small: true })] }))
        : empty('No prep rules yet.', 'Say which categories or products are deluxed, touched up or assembled before they go out.', true))),
      section('Add or change a rule', null, null, el('div', { class: 'form-grid' }, field('For', whatKind), catField, prodField, field('Standard minutes', mins)),
        el('div', { class: 'panel' }, boxes.map((x) => x.node)),
        el('div', { class: 'dlg-acts' }, btn('Save rule', (e) => run(e.currentTarget, out, () => post('/wms/prep/rules', {
          productId: whatKind.value === 'product' ? prod.value : null, category: whatKind.value === 'category' ? cat.value : null,
          prepTypes: boxes.filter((x) => x.b.checked).map((x) => x.t), stdMinutes: mins.value }), 'Saved. New receipts follow it.', () => E.render()), { primary: true })), out));
  }

  // ---------------------------------------------------------------- settings
  async function settingsTab() {
    const s = await coApi('/wms/settings');
    const two = select([['true', 'Two steps: ship, on the road, receive'], ['false', 'One step: lands when it ships']], String(s.twoStepTransfers));
    const gl = select([['1300', 'Stays in 1300 Merchandise inventory'], ['1310', 'Moves to 1310 Inventory in transit']], s.inTransitGl);
    const days = input({ inputmode: 'numeric', value: String(s.transferDays), 'aria-label': 'Days on the road' });
    const gate = select([['off', 'Let it through'], ['warn', 'Warn'], ['refuse', 'Refuse until prep is done']], s.prepGate);
    const out = outBox();
    return section('Warehouse settings', null, null,
      el('div', { class: 'form-grid' }, field('Transfers between our stores', two), field('Goods on the road (two-step transfers)', gl, 'Ship posts Dr 1310 Cr 1300; receipt reverses it'),
        field('Days a transfer is on the road', days, 'Shown as “arriving on” until it is received'),
        field('Booking or staging goods whose prep is not done', gate)),
      el('div', { class: 'dlg-acts' }, btn('Save', (e) => run(e.currentTarget, out, () => post('/wms/settings', { twoStepTransfers: two.value === 'true', inTransitGl: gl.value,
        transferDays: days.value, prepGate: gate.value }), 'Saved.'), { primary: true })), out);
  }

  E.register('wms', 'Containers and prep', 'box', screen, 'Operations', { module: 'wms' });
})();
