// service screens: the service desk (open tickets, a ticket's whole story, new
// tickets, the dashboard, warranty rules and outside companies). Phone first:
// cards, pickers and wrapped facts -- no sideways tables. textContent only.
(() => {
  'use strict';
  const E = window.ERP;
  const { el, frag, icon, chip, money, dayLabel, plural, cap, coApi, post, go, toast, act, openDialog, resultBox, fillDialog,
    askReason, head, section, tile, tilesRow, empty, item, capped, seg, fact, friendly, S } = E;
  E.opener('ticket', (id) => go('service', 'ticket:' + id));

  const ICON_WRENCH = 'M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7a1.6 1.6 0 0 0 2.3 2.3l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.4 2.4-2.1-.5-.5-2.1z';
  const st = { opts: null, status: 'open', q: '' };
  const words = (s) => cap(String(s || '').replace(/_/g, ' '));
  const btn = (label, onclick, o = {}) => el('button', { class: 'btn' + (o.primary ? ' primary' : '') + (o.small ? ' small' : ''), type: 'button', onclick, disabled: o.disabled || null }, o.ic ? icon(o.ic) : null, label);
  const field = (label, input, hint) => el('label', { class: 'field' }, el('span', { text: label }), input, hint ? el('span', { class: 'hint', text: hint }) : null);
  const input = (attrs) => el('input', { type: 'text', ...attrs });
  const select = (options, value, attrs = {}) => el('select', attrs, options.map(([v, label]) => el('option', { value: v, selected: String(v) === String(value ?? '') || null }, label)));
  const errSlot = () => el('div');
  const showErr = (slot) => (e) => slot.replaceChildren(resultBox('critical', 'fail', 'Not done', friendly(e)));
  const panel = (...kids) => el('div', { class: 'panel' }, ...kids);
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const TONE = { new: 'warning', triage: 'warning', awaiting_parts: 'serious', scheduled: 'neutral', in_progress: 'neutral', resolved: 'good', closed: 'good', cancelled: 'neutral' };
  const statusChip = (s) => chip(TONE[s] || 'neutral', s === 'resolved' || s === 'closed' ? 'ok' : s === 'awaiting_parts' ? 'clock' : s === 'new' ? 'pending' : 'info', words(s));
  const COV = { manufacturer: 'Maker’s warranty', protection_plan: 'Protection plan', goodwill: 'Goodwill', billable: 'Customer pays' };
  const PRIO = { urgent: 'critical', high: 'warning', normal: 'neutral', low: 'neutral' };

  async function options() {
    if (!st.opts || st.opts.co !== S.co.id) st.opts = { co: S.co.id, ...(await coApi('/service/options')) };
    return st.opts;
  }
  /** Pictures from the phone's camera, made small enough to keep (about 200 KB each). */
  function photoPicker(max = 6) {
    const list = [];
    const out = el('div', { class: 'sub' });
    const file = el('input', { type: 'file', accept: 'image/*', multiple: true });
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

  // ============================================================== screen
  const TABS = [['open', 'Tickets'], ['new', 'New ticket'], ['dash', 'Dashboard'], ['settings', 'Settings']];
  async function screenService(sub) {
    const [name, id] = String(sub || 'open').split(':');
    const tab = name === 'ticket' ? 'open' : TABS.some(([k]) => k === name) ? name : 'open';
    const nav = el('div', { class: 'toolbar' }, seg(TABS, tab, (v) => go('service', v)));
    let body;
    if (name === 'ticket') body = await ticketScreen(id);
    else if (tab === 'new') body = await newScreen();
    else if (tab === 'dash') body = await dashScreen();
    else if (tab === 'settings') body = await settingsScreen();
    else body = await listScreen();
    return frag(head('Service', [btn('New ticket', () => go('service', 'new'), { primary: true, ic: 'plus' })], 'Operations'), nav, body);
  }

  // ------------------------------------------------------------ tickets
  async function listScreen() {
    const list = await coApi(`/service/tickets?status=${encodeURIComponent(st.status)}&q=${encodeURIComponent(st.q)}`);
    const status = select([['open', 'All open'], ['new', 'New'], ['triage', 'Triage'], ['awaiting_parts', 'Awaiting parts'], ['scheduled', 'Scheduled'],
      ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed'], ['cancelled', 'Cancelled'], ['all', 'Everything']], st.status, { 'aria-label': 'Status' });
    status.style.width = 'auto';
    status.addEventListener('change', () => { st.status = status.value; E.render(); });
    const q = input({ placeholder: 'Ticket, customer, order or words', 'aria-label': 'Search', value: st.q });
    q.style.maxWidth = '320px';
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { st.q = q.value.trim(); E.render(); } });
    const cards = list.map((x) => item({
      title: `${x.number} · ${x.customer || 'unknown caller'}`, amount: x.age_days ? `${x.age_days}d` : 'today', badge: statusChip(x.status),
      detail: [words(x.issue_type), x.product, x.coverage ? COV[x.coverage] : 'not triaged', x.priority !== 'normal' ? `${x.priority} priority` : null,
        x.technician || x.provider, x.next_visit ? `visit ${dayLabel(x.next_visit)}` : null, x.order_number].filter(Boolean).join(' · '),
      why: x.sla_breached ? `Past its due time (${when(x.sla_due_at)}).` : null,
      onClick: () => go('service', 'ticket:' + x.id) }));
    return frag(el('div', { class: 'toolbar' }, status, q, btn('Search', () => { st.q = q.value.trim(); E.render(); }, { small: true })),
      section(st.status === 'open' ? 'Open tickets' : words(st.status), plural(list.length, 'ticket'), null,
        list.length ? panel(capped(cards, 25, 'tickets')) : empty('No tickets here', st.status === 'open' ? 'Nothing waiting on the service desk.' : null, true)));
  }

  // ----------------------------------------------------------- new ticket
  async function newScreen() {
    const o = await options();
    const err = errSlot();
    const src = select([['phone', 'Phone call'], ['pos', 'At the counter'], ['email', 'Email'], ['other', 'Other']], 'phone');
    const issue = select(o.issueTypes, 'defect');
    const prio = select(o.priorities.map((p) => [p, cap(p)]), 'normal');
    const desc = el('textarea', { maxlength: '4000', placeholder: 'Which piece, what is wrong, since when' });
    const label = input({ class: 'upper', placeholder: 'Carton label, if there is one' });
    const photos = photoPicker();
    const picked = { customer: null, line: null };
    const who = el('div');
    const contact = { name: input({ autocomplete: 'off' }), phone: input({ type: 'tel' }), email: input({ type: 'email' }) };
    const contactBox = el('div', { class: 'form-grid' }, field('Caller name', contact.name), field('Phone', contact.phone), field('Email', contact.email));
    const search = input({ placeholder: 'Customer name, phone or order number', autocomplete: 'off' });
    const results = el('div');
    let timer = 0;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (search.value.trim().length < 2) { results.replaceChildren(); return; }
        try {
          const list = await coApi(`/service/customers?q=${encodeURIComponent(search.value.trim())}`);
          results.replaceChildren(list.length ? panel(list.map((cu) => item({ title: cu.name, detail: [cu.number, cu.phone, plural(cu.lines.length, 'item')].filter(Boolean).join(' · '),
            onClick: () => pick(cu) }))) : empty('No customer found', 'Fill in the caller below instead.', true));
        } catch (e) { results.replaceChildren(resultBox('warning', 'warn', 'Couldn’t search', friendly(e))); }
      }, 250);
    });
    function pick(cu) {
      picked.customer = cu; results.replaceChildren(); search.value = cu.name;
      contactBox.hidden = true;
      const line = select([['', 'Not about a particular item'], ...cu.lines.map((l) => [l.line_id, `${l.number} · ${l.description} (${dayLabel(l.ordered_at)})`])], '');
      line.addEventListener('change', () => { picked.line = line.value || null; });
      who.replaceChildren(resultBox('good', 'ok', cu.name, [cu.phone, cu.number].filter(Boolean).join(' · ')), field('Which item', line),
        btn('Someone else', () => { picked.customer = null; picked.line = null; who.replaceChildren(); contactBox.hidden = false; search.value = ''; }, { small: true }));
    }
    const go_ = btn('Open ticket', (e) => act(e.currentTarget, async () => {
      const r = await post('/service/tickets', { source: src.value, customerId: picked.customer ? picked.customer.id : null, lineId: picked.line,
        contactName: contact.name.value, contactPhone: contact.phone.value, contactEmail: contact.email.value, pieceLabel: label.value.trim() || null,
        issueType: issue.value, priority: prio.value, description: desc.value, photos: photos.value() });
      go('service', 'ticket:' + r.id);
      return r;
    }, (r) => `Ticket ${r.number} opened`, { errorInto: showErr(err) }), { primary: true });
    return section('New service ticket', null, null, panel(el('div', { class: 'facts' }, el('div', { class: 'wide2' },
      field('Customer', search), results, who, contactBox,
      el('div', { class: 'form-grid' }, field('Came in by', src), field('Problem', issue), field('Priority', prio), field('Carton label', label)),
      field('What is wrong', desc), field('Photos', photos.node), el('div', { class: 'dlg-acts' }, go_), err))));
  }

  // --------------------------------------------------------- one ticket
  async function ticketScreen(id) {
    const [t, o] = [await coApi(`/service/tickets/${id}`), await options()];
    const err = errSlot();
    const open = ['new', 'triage', 'awaiting_parts', 'scheduled', 'in_progress'].includes(t.status);
    const doIt = (path, body, ok) => (e) => act(e.currentTarget, () => post(path, body), ok, { errorInto: showErr(err) });
    const acts = [
      open ? btn(t.coverage ? 'Change coverage' : 'Triage', () => triageDialog(t, o), { small: true, primary: !t.coverage }) : null,
      open && t.coverage ? btn('Book visit', () => visitDialog(t, o), { small: true }) : null,
      open && t.coverage ? btn('Add part', () => partDialog(t), { small: true }) : null,
      open && t.coverage === 'billable' ? btn('Add charge', () => chargeDialog(t, o), { small: true }) : null,
      t.parts.some((p) => p.line_status === 'on_order' && !p.po_number && !p.cancelled_at) ? btn('Order parts', doIt(`/service/tickets/${t.id}/parts/order`, {}, (r) => `Ordered on ${r.map((x) => x.number).join(', ')}`), { small: true }) : null,
      t.charges.some((x) => ['open', 'reserved', 'ready'].includes(x.line_status)) ? btn('Invoice charges', doIt(`/service/tickets/${t.id}/invoice`, {}, (r) => `Invoiced ${money(r.totalMinor)}`), { small: true }) : null,
      open && t.coverage ? btn('Resolve', () => resolveDialog(t, o), { small: true }) : null,
      t.status === 'resolved' ? btn('Close ticket', doIt(`/service/tickets/${t.id}/close`, {}, 'Ticket closed'), { small: true, primary: true }) : null,
      btn('Note or photo', () => noteDialog(t), { small: true }),
      t.status !== 'closed' && t.status !== 'cancelled' ? btn('Enter cost', () => costDialog(t), { small: true }) : null,
      t.damage_id ? btn('File vendor claim', () => claimDialog(t), { small: true }) : null,
      ['new', 'triage'].includes(t.status) ? btn('Cancel…', async () => {
        const why = await askReason({ title: `Cancel ${t.number}`, label: 'Why', confirm: 'Cancel ticket' });
        if (why != null) act(document.createElement('button'), () => post(`/service/tickets/${t.id}/status`, { status: 'cancelled', note: why }), 'Ticket cancelled', { errorInto: showErr(err) });
      }, { small: true }) : null,
    ].filter(Boolean);
    const cs = t.coverageSuggestion;
    const coverageBox = t.coverage
      ? resultBox(t.coverage === 'billable' ? 'neutral' : 'good', 'ok', COV[t.coverage], [t.coverage_note, t.coverage_by_name ? `decided by ${t.coverage_by_name}` : null].filter(Boolean).join(' · '))
      : cs ? resultBox('warning', 'info', `Suggested: ${COV[cs.suggested]}`, cap(cs.reason)) : null;
    const parts = t.parts.map((p) => item({
      title: `${p.qty}× ${p.name}`, amount: p.billable ? money(p.price_minor) : 'covered', badge: chip(p.cancelled_at ? 'neutral' : p.used_at ? 'good' : p.line_status === 'reserved' ? 'good' : 'warning',
        p.used_at ? 'ok' : 'clock', p.cancelled_at ? 'Taken off' : p.used_at ? 'Used' : p.line_status === 'reserved' ? 'In hand' : p.line_status === 'on_order' ? (p.po_number ? 'On a PO' : 'Needs ordering') : words(p.line_status)),
      detail: [p.kind === 'replacement' ? 'replacement piece' : 'part', p.sku, p.po_number ? `${p.po_number}${p.expected_on ? ', due ' + dayLabel(p.expected_on) : ''}` : null, p.approval_reason].filter(Boolean).join(' · '),
      acts: !p.used_at && !p.cancelled_at && open ? [btn('Take off…', async () => {
        const why = await askReason({ title: 'Take the part off', sub: p.name, label: 'Why', confirm: 'Take off' });
        if (why != null) act(document.createElement('button'), () => post(`/service/tickets/${t.id}/lines/${p.line_id}/cancel`, { reason: why }), 'Taken off', { errorInto: showErr(err) });
      }, { small: true })] : null }));
    const charges = t.charges.map((x) => item({ title: `${x.qty}× ${x.description}`, amount: money(BigInt(Math.round(x.qty * Number(x.price_minor)))), badge: chip(x.line_status === 'fulfilled' ? 'good' : 'neutral', x.line_status === 'fulfilled' ? 'ok' : 'pending', x.line_status === 'fulfilled' ? 'Invoiced' : words(x.line_status)), detail: x.sku }));
    const visits = t.visits.map((v) => item({
      title: `${v.kind === 'pickup' ? 'Pickup for repair' : 'Visit'} · ${v.scheduled_on ? dayLabel(v.scheduled_on) : ''}${v.window_label ? ', ' + v.window_label : ''}`,
      badge: chip(v.outcome ? (v.outcome === 'fixed' || v.outcome === 'no_fault' ? 'good' : 'warning') : 'neutral', v.outcome ? 'ok' : 'clock', v.outcome ? words(v.outcome) : 'Booked'),
      detail: [v.provider || v.technician || v.driver, v.stop_number, v.route_number, v.minutes ? `${v.minutes} min` : null].filter(Boolean).join(' · '),
      why: v.work_notes || null,
      acts: !v.completed_at && v.provider ? [btn('Record result', () => outsideDialog(t, v), { small: true })] : null }));
    const costs = t.costs.map((x) => item({ title: words(x.kind), amount: money(x.amount_minor), detail: [x.charge_to === 'vendor' ? 'charged back to the vendor' : 'service expense', x.note, when(x.created_at)].filter(Boolean).join(' · ') }));
    const claims = t.claims.map((k) => item({ title: k.number, amount: money(k.amount_claimed_minor), badge: chip(k.status === 'credited' ? 'good' : k.status === 'denied' ? 'critical' : 'neutral', 'info', words(k.status)),
      detail: [k.vendor_ref, k.credit_minor ? `credited ${money(k.credit_minor)}` : null].filter(Boolean).join(' · '),
      acts: ['credited', 'denied'].includes(k.status) ? null : [btn('Update', () => claimUpdateDialog(t, k), { small: true })] }));
    const timeline = t.events.map((e) => item({ title: e.kind === 'status' ? `${e.from_status ? words(e.from_status) + ' → ' : ''}${words(e.to_status)}` : words(e.kind),
      detail: `${when(e.at)} · ${e.by_label}`, why: e.note || null }));
    return frag(
      el('div', { class: 'toolbar' }, btn('All tickets', () => go('service', 'open'), { small: true }), el('span', { class: 'grow' }), statusChip(t.status),
        chip(PRIO[t.priority], 'info', `${cap(t.priority)} priority`)),
      t.sla_breached ? resultBox('critical', 'warn', 'Past its due time', `It was due ${when(t.sla_due_at)}.`) : null,
      section(`${t.number} · ${words(t.issue_type)}`, `opened ${when(t.created_at)} from ${t.source}`, null, panel(el('div', { class: 'facts' },
        fact('Customer', t.customer_name || '—'), fact('Phone', t.customer_phone || t.contact_phone || '—'),
        fact('Address', t.line1 ? `${t.line1}, ${t.city}` : '—'), fact('Item', t.product ? `${t.product}${t.sku ? ' (' + t.sku + ')' : ''}` : '—'),
        fact('Vendor', t.vendor || '—'), fact('Order', t.order_number || '—'), fact('Due', when(t.sla_due_at)),
        fact('Who works it', t.technician || t.provider || 'not assigned'),
        el('div', { class: 'wide2' }, el('span', { class: 'k', text: 'Problem' }), el('div', { class: 'fv', text: t.description })),
        t.resolution_type ? el('div', { class: 'wide2' }, el('span', { class: 'k', text: 'Resolution' }), el('div', { class: 'fv', text: `${words(t.resolution_type)}${t.resolution_note ? ': ' + t.resolution_note : ''}` })) : null,
        t.photos && t.photos.length ? fact('Photos', plural(t.photos.length, 'photo')) : null))),
      coverageBox, el('div', { class: 'toolbar' }, acts), err,
      section('Parts', t.service_order_number || t.billing_order_number ? [t.service_order_number, t.billing_order_number].filter(Boolean).join(' · ') : null, null,
        parts.length ? panel(parts) : empty('No parts', null, true)),
      charges.length ? section('Charges to the customer', t.billing_balance_minor != null ? `balance ${money(t.billing_balance_minor)}` : null, null, panel(charges)) : null,
      section('Visits', null, null, visits.length ? panel(visits) : empty('No visit booked', null, true)),
      costs.length ? section('What it cost', money(t.costTotalMinor), null, panel(costs)) : null,
      claims.length ? section('Vendor claims', null, null, panel(claims)) : null,
      section('Timeline', plural(t.events.length, 'step'), null, panel(capped(timeline.reverse(), 8, 'steps'))));
  }

  function triageDialog(t, o) {
    const d = openDialog(t.coverage ? 'Change who pays' : 'Triage', t.number);
    const err = errSlot();
    const cs = t.coverageSuggestion;
    const cov = select(o.coverages.map((c) => [c, COV[c] + (cs && cs.suggested === c ? ' (suggested)' : '')]), t.coverage || (cs && cs.suggested));
    const note = el('textarea', { maxlength: '1000', placeholder: 'Needed when it is not what the rules suggest' });
    const prio = select(o.priorities.map((p) => [p, cap(p)]), t.priority);
    const tech = select([['', 'Nobody yet'], ...o.technicians.map((x) => [x.id, x.name])], t.technician_id || '');
    const prov = select([['', 'In-house'], ...o.providers.map((x) => [x.id, x.name])], t.provider_id || '');
    d.body.append(cs ? resultBox('neutral', 'info', `The rules say: ${COV[cs.suggested]}`, cap(cs.reason)) : null,
      field('Who pays', cov), field('Why', note), el('div', { class: 'form-grid' }, field('Priority', prio), field('Technician', tech), field('Outside company', prov)),
      el('div', { class: 'dlg-acts' }, btn('Save', (e) => act(e.currentTarget, () => post(`/service/tickets/${t.id}/triage`, { coverage: cov.value, note: note.value, priority: prio.value,
        technicianId: tech.value || null, providerId: prov.value || null }), 'Triaged', { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }

  function partDialog(t) {
    const d = openDialog('Add a part', `${t.number} · ${t.coverage === 'billable' ? 'billed at its price' : 'covered, at no charge'}`);
    const err = errSlot();
    const q = input({ placeholder: 'Part name or SKU', autocomplete: 'off' });
    const list = el('div');
    const qty = input({ type: 'number', value: '1', inputmode: 'numeric' });
    const kind = select([['part', 'A part for the repair'], ['replacement', 'A whole replacement piece']], 'part');
    const reason = input({ placeholder: 'Why it is replaced at no charge (manager)' });
    let timer = 0;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (q.value.trim().length < 2) { list.replaceChildren(); return; }
        try {
          const r = await coApi(`/service/parts?q=${encodeURIComponent(q.value.trim())}`);
          list.replaceChildren(r.length ? panel(r.map((p) => item({ title: p.name, amount: money(p.price_minor), detail: [p.sku, p.vendor, p.available > 0 ? `${p.available} in stock` : 'none in stock'].filter(Boolean).join(' · '),
            acts: [btn('Add', (e) => act(e.currentTarget, () => post(`/service/tickets/${t.id}/parts`, { productId: p.id, qty: qty.value, kind: kind.value, reason: reason.value }),
              (x) => (x.status === 'reserved' ? 'In stock and reserved' : 'On order; order it from the ticket'), { close: d.close, errorInto: showErr(err) }), { small: true, primary: true })] }))) : empty('Nothing by that name', null, true));
        } catch (e) { list.replaceChildren(resultBox('warning', 'warn', 'Couldn’t search', friendly(e))); }
      }, 250);
    });
    d.body.append(el('div', { class: 'form-grid' }, field('Quantity', qty), field('Kind', kind)), field('Reason', reason), field('Find the part', q), list, err);
  }

  function chargeDialog(t, o) {
    const d = openDialog('Add a charge', t.number);
    const err = errSlot();
    const p = select(o.charges.map((x) => [x.id, `${x.name} · ${money(x.price_minor)}`]), o.charges[0] && o.charges[0].id);
    const qty = input({ type: 'number', value: '1', inputmode: 'decimal' });
    const price = input({ inputmode: 'decimal', placeholder: 'Leave empty for the list price' });
    d.body.append(field('Charge', p), el('div', { class: 'form-grid' }, field('Quantity', qty), field('Price each ($)', price)),
      el('div', { class: 'dlg-acts' }, btn('Add', (e) => act(e.currentTarget, () => post(`/service/tickets/${t.id}/charges`, { productId: p.value, qty: qty.value, price: price.value || undefined }),
        'Charge added', { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }

  function visitDialog(t, o) {
    const d = openDialog('Book a visit', `${t.number} · ${t.customer_name || ''}`);
    const err = errSlot();
    const kind = select([['repair', 'Repair in the home'], ['pickup', 'Pick it up for the shop']], 'repair');
    const who = select([['', 'Our technician (on the delivery calendar)'], ...o.providers.map((x) => [x.id, `Outside: ${x.name}`])], t.provider_id || '');
    const day = input({ type: 'date' });
    const slots = el('div');
    const draw = async () => {
      if (who.value) { slots.replaceChildren(field('Day they will go', day), el('div', { class: 'dlg-acts' }, btn('Book', (e) => act(e.currentTarget,
        () => post(`/service/tickets/${t.id}/visits`, { kind: kind.value, providerId: who.value, day: day.value }), 'Visit booked', { close: d.close, errorInto: showErr(err) }), { primary: true }))); return; }
      if (!t.zone_id) { slots.replaceChildren(resultBox('warning', 'warn', 'Outside every delivery zone', 'Add the address’s postal code to a zone, or send an outside company.')); return; }
      slots.replaceChildren(el('div', { class: 'loading' }, 'Finding open windows…'));
      try {
        const a = await coApi(`/fleet/availability?zone=${t.zone_id}&days=21`);
        const byDay = new Map();
        for (const s of a.slots) { if (!byDay.has(s.day)) byDay.set(s.day, []); byDay.get(s.day).push(s); }
        slots.replaceChildren(byDay.size ? el('div', {}, [...byDay.entries()].map(([dd, list]) => el('div', { class: 'field' }, el('span', { text: dayLabel(dd) }),
          el('div', { class: 'toolbar' }, list.map((s) => {
            const b = el('button', { class: 'btn', type: 'button', disabled: !s.fits || null }, el('b', { text: s.label }), el('span', { class: 'sub', text: s.fits ? (s.caps.stops != null ? `${Math.max(s.caps.stops - s.used.stops, 0)} left` : 'open') : 'full' }));
            b.style.minHeight = '48px';
            b.addEventListener('click', () => act(b, () => post(`/service/tickets/${t.id}/visits`, { kind: kind.value, day: s.day, windowId: s.windowId }),
              `Booked for ${dayLabel(s.day)}, ${s.label}`, { close: d.close, errorInto: showErr(err) }));
            return b;
          }))))) : empty('No open windows', 'Every window in the next three weeks is full or closed.', true));
      } catch (e) { slots.replaceChildren(resultBox('critical', 'fail', 'Couldn’t load windows', friendly(e))); }
    };
    who.addEventListener('change', draw);
    d.body.append(el('div', { class: 'form-grid' }, field('What for', kind), field('Who goes', who)), slots, err);
    draw();
  }

  function outsideDialog(t, v) {
    const d = openDialog('Outside company’s result', `${t.number} · ${v.provider}`);
    const err = errSlot();
    const outcome = select([['fixed', 'Fixed'], ['needs_parts', 'Needs parts'], ['no_fault', 'No fault found'], ['not_home', 'Nobody home'], ['other', 'Something else']], 'fixed');
    const notes = el('textarea', { maxlength: '2000', placeholder: 'What they found and did' });
    const minutes = input({ type: 'number', inputmode: 'numeric' });
    const cost = input({ inputmode: 'decimal', placeholder: 'What they will bill us ($)' });
    d.body.append(field('How did it go', outcome), field('Notes', notes), el('div', { class: 'form-grid' }, field('Time (minutes)', minutes), field('Their charge ($)', cost)),
      el('div', { class: 'dlg-acts' }, btn('Save', (e) => act(e.currentTarget, () => post(`/service/visits/${v.id}/complete`, { outcome: outcome.value, workNotes: notes.value,
        minutes: minutes.value, thirdPartyCost: cost.value || undefined }), 'Saved', { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }

  function resolveDialog(t, o) {
    const d = openDialog('Resolve', t.number);
    const err = errSlot();
    const type = select(o.resolutions.map((r) => [r, words(r)]), t.parts.some((p) => p.kind === 'replacement') ? 'replace_item' : 'in_home_repair');
    const note = el('textarea', { maxlength: '1000', placeholder: 'What was done' });
    const refund = el('div');
    const session = select([['', 'Pick the open register'], ...o.sessions.map((x) => [x.id, `${x.number} · ${x.location}`])], '');
    const method = select([['', 'Back the way they paid'], ['store_credit', 'Store credit'], ['cash', 'Cash'], ['card', 'Card'], ['check', 'Check']], '');
    const amount = input({ inputmode: 'decimal', placeholder: 'Amount, when not back the way they paid' });
    const drawRefund = () => refund.replaceChildren(type.value === 'credit_refund' ? el('div', {}, resultBox('neutral', 'info', 'Through the register',
      'The item is taken back on a POS return; it goes to damage, where a vendor claim can start. A store manager does this.'),
      el('div', { class: 'form-grid' }, field('Register', session), field('Refund as', method), field('Amount ($)', amount))) : el('span'));
    type.addEventListener('change', drawRefund);
    drawRefund();
    d.body.append(field('How it was resolved', type), field('What was done', note), refund,
      el('div', { class: 'dlg-acts' }, btn('Resolve', (e) => act(e.currentTarget, () => post(`/service/tickets/${t.id}/resolve`, { type: type.value, note: note.value,
        sessionId: session.value || null, tenders: method.value && amount.value ? [{ method: method.value, amount: amount.value }] : [] }), 'Resolved', { close: d.close, errorInto: showErr(err) }),
        { primary: true }), btn('Cancel', d.close)), err);
  }

  function noteDialog(t) {
    const d = openDialog('Note or photo', t.number);
    const err = errSlot();
    const note = el('textarea', { maxlength: '1000' });
    const photos = photoPicker();
    d.body.append(field('Note', note), field('Photos', photos.node), el('div', { class: 'dlg-acts' }, btn('Save', (e) => act(e.currentTarget,
      () => post(`/service/tickets/${t.id}/note`, { note: note.value, photos: photos.value() }), 'Saved', { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }

  function costDialog(t) {
    const d = openDialog('Enter a cost', t.number);
    const err = errSlot();
    const kind = select([['third_party', 'An outside company’s work'], ['labor', 'Our labour'], ['other', 'Something else']], 'third_party');
    const amount = input({ inputmode: 'decimal' });
    const to = select([['', 'Who carries it, by the coverage'], ['service_expense', 'Service expense'], ['vendor', 'Charge back to the vendor']], '');
    const note = input({});
    d.body.append(el('div', { class: 'form-grid' }, field('Kind', kind), field('Amount ($)', amount), field('Charged to', to), field('For', note)),
      el('div', { class: 'dlg-acts' }, btn('Post', (e) => act(e.currentTarget, () => post(`/service/tickets/${t.id}/costs`, { kind: kind.value, amount: amount.value,
        chargeTo: to.value || undefined, note: note.value }), 'Cost posted', { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }

  function claimDialog(t) {
    const d = openDialog('File a vendor claim', `${t.number} · ${t.vendor || ''}`);
    const err = errSlot();
    const amount = input({ inputmode: 'decimal' }), ref = input({ placeholder: 'Their RMA or claim number' });
    d.body.append(el('div', { class: 'form-grid' }, field('Amount claimed ($)', amount), field('Vendor reference', ref)),
      el('div', { class: 'dlg-acts' }, btn('File', (e) => act(e.currentTarget, () => post(`/service/tickets/${t.id}/claims`, { amount: amount.value, vendorRef: ref.value }),
        (r) => `Claim ${r.number} filed`, { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }
  function claimUpdateDialog(t, k) {
    const d = openDialog(`Claim ${k.number}`, t.number);
    const err = errSlot();
    const status = select([['submitted', 'Submitted'], ['approved', 'Approved'], ['credited', 'Credited'], ['denied', 'Denied']], 'submitted');
    const credit = input({ inputmode: 'decimal', placeholder: 'When credited' }), res = input({ placeholder: 'How it settled' });
    d.body.append(el('div', { class: 'form-grid' }, field('Now', status), field('Credit ($)', credit)), field('Settlement', res),
      el('div', { class: 'dlg-acts' }, btn('Save', (e) => act(e.currentTarget, () => post(`/service/tickets/${t.id}/claims/${k.id}`, { status: status.value, credit: credit.value || undefined,
        resolution: res.value }), 'Claim updated', { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }

  // ---------------------------------------------------------- dashboard
  async function dashScreen() {
    const d = await coApi('/service/home');
    const tiles = tilesRow(
      tile({ label: 'Open tickets', value: String(d.open), tone: d.breached.length ? 'warning' : 'neutral', text: d.breached.length ? `${d.breached.length} past due` : null, ic: 'warn',
        onClick: () => E.drillList('service-open', 'Open service tickets', {}, { noun: 'ticket', expect: { count: d.open }, none: 'No tickets open.', note: 'Soonest due first.' }) }),
      tile({ label: 'Due in 24 hours', value: String(d.dueSoon),
        onClick: () => E.drillList('service-due24', 'Due in the next 24 hours', {}, { noun: 'ticket', expect: { count: d.dueSoon }, none: 'Nothing falls due in the next day.' }) }),
      tile({ label: 'Fixed first visit', value: d.firstTimeFix.pct == null ? '—' : `${d.firstTimeFix.pct}%`, text: d.firstTimeFix.resolvedWithVisits ? `of ${plural(d.firstTimeFix.resolvedWithVisits, 'ticket')}` : null, ic: 'info',
        onClick: () => E.drillList('service-ftf', 'Fixed on the first visit', {}, { noun: 'ticket', expect: { count: d.firstTimeFix.resolvedWithVisits }, none: 'No resolved tickets with repair visits yet.',
          note: `${d.firstTimeFix.fixedFirstTime} of ${d.firstTimeFix.resolvedWithVisits} were fixed (or found no fault) on the first repair visit.` }) }),
      tile({ label: 'Service cost, 30 days', value: money(d.cost30dMinor), text: d.avgDaysToResolve != null ? `${d.avgDaysToResolve} days to resolve` : null, ic: 'clock',
        onClick: () => E.drillList('service-cost30', 'Service cost, last 30 days', {}, { noun: 'cost', expect: { minor: d.cost30dMinor }, none: 'No service costs in the last 30 days.' }) }));
    const order = ['new', 'triage', 'awaiting_parts', 'scheduled', 'in_progress', 'resolved', 'closed', 'cancelled'];
    const byStatus = order.map((s) => [s, (d.byStatus.find((x) => x.status === s) || { n: 0 }).n]).filter(([, n]) => n);
    const statusCards = byStatus.map(([s, n]) => item({ title: words(s), amount: String(n), onClick: () => { st.status = s; go('service', 'open'); } }));
    const ageCards = ['0–2 days', '3–7 days', '8–14 days', '15+ days'].map((b) => item({ title: b, amount: String((d.age.find((x) => x.bucket === b) || { n: 0 }).n),
      onClick: () => E.drillList('service-open', `Open tickets, ${b} old`, { age: b }, { noun: 'ticket', expect: { count: (d.age.find((x) => x.bucket === b) || { n: 0 }).n } }) }));
    const late = d.breached.map((b) => item({ title: `${b.number} · ${b.customer || ''}`, badge: statusChip(b.status), detail: `${cap(b.priority)} priority · due ${when(b.sla_due_at)}`,
      onClick: () => go('service', 'ticket:' + b.id) }));
    const vendors = d.vendors.map((v) => item({ title: v.vendor, amount: v.defect_rate_pct != null ? `${v.defect_rate_pct}%` : '—',
      detail: [`${plural(v.defects, 'defect')} of ${plural(v.units, 'unit')} sold`, `${plural(v.tickets, 'ticket')}`, `cost ${money(v.cost_minor)}`,
        Number(v.charged_back_minor) ? `charged back ${money(v.charged_back_minor)}` : null, Number(v.credited_minor) ? `credited ${money(v.credited_minor)}` : null].filter(Boolean).join(' · ') }));
    const products = d.products.map((p) => item({ title: p.name, amount: String(p.tickets), detail: `${p.sku} · ${plural(p.units, 'unit')} sold` }));
    return frag(tiles,
      el('div', { class: 'two' },
        section('By status', null, null, statusCards.length ? panel(statusCards) : empty('No tickets yet', null, true)),
        section('Open, by age', null, null, panel(ageCards))),
      late.length ? section('Past due', String(late.length), null, panel(capped(late, 8, 'tickets'))) : null,
      section('By vendor', 'defect rate = defect and warranty tickets ÷ units sold, last 12 months', null, vendors.length ? panel(vendors) : empty('Nothing yet', null, true)),
      products.length ? section('Most serviced products', null, null, panel(products)) : null);
  }

  // ----------------------------------------------------------- settings
  async function settingsScreen() {
    const r = await coApi('/service/settings');
    const rules = r.warranty.map((w) => item({ title: [w.vendor || 'Any vendor', w.category || 'any category'].join(' · '), amount: `${w.months} mo`,
      detail: `covers ${w.covers.map(words).join(', ').toLowerCase()}${w.note ? ' · ' + w.note : ''}` }));
    const provs = r.providers.map((p) => item({ title: p.name, amount: p.hourly_rate_minor ? `${money(p.hourly_rate_minor)}/h` : '',
      badge: !p.active ? chip('neutral', 'pause', 'Inactive') : p.vendor_id ? null : chip('warning', 'warn', 'No vendor'),
      detail: [p.phone, p.email].filter(Boolean).join(' · '), acts: [btn('Edit', () => providerDialog(p), { small: true })] }));
    const plans = Object.entries(r.plans || {}).map(([sku, p]) => item({ title: p.name || sku, amount: `${p.years} yr`, detail: `${sku} · covers ${(p.covers || []).map(words).join(', ').toLowerCase()}` }));
    return frag(
      section('Manufacturer warranty', 'the most specific rule wins', [btn('Add rule', ruleDialog, { small: true, ic: 'plus' })], rules.length ? panel(rules) : empty('No rules: nothing is under warranty', null, true)),
      section('Protection plans', 'set in company settings (service.plan_terms)', null, plans.length ? panel(plans) : empty('No plan terms set', 'Plans are read by the years in their SKU (5Y).', true)),
      section('Outside service companies', null, [btn('Add company', () => providerDialog(), { small: true, ic: 'plus' })], provs.length ? panel(provs) : empty('None yet', null, true)));
  }
  function ruleDialog() {
    const d = openDialog('Warranty rule', 'By vendor, category, or both');
    const err = errSlot();
    fillDialog(d, async () => {
      const opts = await coApi('/options');
      const vendor = select([['', 'Any vendor'], ...(opts.vendors || []).map((v) => [v.id, v.name || v.legal_name])], '');
      const cat = input({ placeholder: 'Category, e.g. Mattresses (empty = any)' });
      const months = input({ type: 'number', value: '12', inputmode: 'numeric' });
      const covers = ['defect', 'warranty', 'assembly', 'comfort'].map((k) => { const cb = el('input', { type: 'checkbox', class: 'pickbox', checked: k === 'defect' || k === 'warranty' }); return [k, cb]; });
      return frag(field('Vendor', vendor), el('div', { class: 'form-grid' }, field('Category', cat), field('Months', months)),
        el('div', { class: 'field' }, el('span', { text: 'Covers' }), el('div', { class: 'toolbar' }, covers.map(([k, cb]) => el('label', { class: 'field inline' }, cb, el('span', { text: words(k) }))))),
        el('div', { class: 'dlg-acts' }, btn('Save', (e) => act(e.currentTarget, () => post('/service/rules', { vendorId: vendor.value || null, category: cat.value, months: months.value,
          covers: covers.filter(([, cb]) => cb.checked).map(([k]) => k) }), 'Rule saved', { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
    });
  }
  function providerDialog(p0) {
    const p = p0 && p0.id ? p0 : {};
    const d = openDialog('Outside service company', 'Their visits are accrued until their bill comes through payables');
    const err = errSlot();
    fillDialog(d, async () => {
      const opts = await coApi('/options');
      const f = { name: input({ value: p.name || '' }), phone: input({ type: 'tel', value: p.phone || '' }), email: input({ type: 'email', value: p.email || '' }),
        hourlyRate: input({ inputmode: 'decimal', value: p.hourly_rate_minor ? (Number(p.hourly_rate_minor) / 100).toFixed(2) : '' }),
        vendorId: select([['', 'Pick their vendor'], ...(opts.vendors || []).map((v) => [v.id, v.name || v.legal_name])], p.vendor_id || '') };
      return frag(el('div', { class: 'form-grid' }, field('Name', f.name), field('Phone', f.phone), field('Email', f.email), field('Rate per hour ($)', f.hourlyRate),
          field('Bills us as (vendor)', f.vendorId),
          el('p', { class: 'muted wide', text: 'Bills for their visits code to 2050, which clears what each visit accrued (a vendor with no usual account is switched to 2050). A visit cost can’t be entered until this is set; linking needs the controller.' })),
        el('div', { class: 'dlg-acts' }, btn('Save', (e) => act(e.currentTarget, () => post('/service/providers', { id: p.id || null, ...Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value])) }),
          (r) => (r && r.note ? `Saved. ${r.note}` : 'Saved'), { close: () => { st.opts = null; d.close(); }, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
    });
  }

  E.register('service', 'Service', 'wrench', screenService, 'Operations', { icon: ICON_WRENCH, module: 'service' });
})();
