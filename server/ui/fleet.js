// fleet screens: Delivery (dispatch, routes, trucks, zones, crew) and My route
// (the driver's phone). Registers with window.ERP (see docs/MODULES.md).
// Phone first: cards, wrapped rows and pickers -- no sideways tables. Data is
// placed with textContent only.
(() => {
  'use strict';
  const E = window.ERP;
  const { el, frag, icon, chip, money, dayLabel, plural, cap, coApi, post, go, toast, act, openDialog, resultBox, fillDialog,
    askReason, head, section, tile, tilesRow, empty, item, capped, seg, fact, friendly, S } = E;

  const ICON_TRUCK = 'M2.5 6.5h11.5v9.5H2.5z|M14 9.5h4.2l3.3 3.4v3.1H14|C6.5 17.5 1.9|C17.5 17.5 1.9';
  const ICON_PIN = 'M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z|C12 10 2.4';

  // ------------------------------------------------------------ little bits
  const st = { day: null, dc: null, opts: null };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const clock = (m) => { if (m == null) return ''; const h = Math.floor(m / 60) % 24, mm = m % 60; return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const words = (s) => cap(String(s || '').replace(/_/g, ' '));
  const dollars = (minor) => (Number(minor || 0) / 100).toFixed(2);
  const btn = (label, onclick, opts = {}) => el('button', { class: 'btn' + (opts.primary ? ' primary' : '') + (opts.small ? ' small' : ''), type: 'button', onclick, disabled: opts.disabled || null }, opts.ic ? icon(opts.ic) : null, label);
  const field = (label, input, hint) => el('label', { class: 'field' }, el('span', { text: label }), input, hint ? el('span', { class: 'hint', text: hint }) : null);
  const input = (attrs) => el('input', { type: 'text', ...attrs });
  const select = (options, value, attrs = {}) => el('select', attrs, options.map(([v, label]) => el('option', { value: v, selected: String(v) === String(value ?? '') || null }, label)));
  const errSlot = () => el('div');
  const showErr = (slot) => (e) => slot.replaceChildren(resultBox('critical', 'fail', 'Not done', friendly(e)));
  const panel = (...kids) => el('div', { class: 'panel' }, ...kids);
  const STOP_TONE = { scheduled: 'neutral', arrived: 'warning', delivered: 'good', partial: 'warning', failed: 'critical', cancelled: 'neutral' };
  const ROUTE_TONE = { draft: 'neutral', locked: 'warning', in_progress: 'warning', completed: 'good' };
  const VEH_TONE = { active: 'good', out_of_service: 'critical', retired: 'neutral' };
  const stopChip = (s) => chip(STOP_TONE[s] || 'neutral', s === 'delivered' ? 'ok' : s === 'failed' ? 'fail' : s === 'scheduled' ? 'pending' : 'clock', words(s));
  const routeChip = (s) => chip(ROUTE_TONE[s] || 'neutral', s === 'completed' ? 'ok' : s === 'locked' ? 'hold' : s === 'in_progress' ? 'clock' : 'pending', s === 'locked' ? 'Loaded' : words(s));
  const KIND = { delivery: 'Delivery', pickup: 'Pickup', service: 'Service call', will_call: 'Will-call' };

  async function options() {
    if (!st.opts || st.opts.co !== S.co.id) { st.opts = { co: S.co.id, ...(await coApi('/fleet/options')) }; }
    if (!st.day) st.day = st.opts.today;
    if (!st.dc) st.dc = (st.opts.locations.find((l) => l.kind === 'warehouse') || st.opts.locations[0] || {}).id || null;
    return st.opts;
  }
  const dayPicker = () => {
    const i = input({ type: 'date', value: st.day, 'aria-label': 'Day' });
    i.addEventListener('change', () => { if (i.value) { st.day = i.value; E.render(); } });
    i.style.width = 'auto';
    return i;
  };
  const dcPicker = (o) => {
    const s = select(o.locations.filter((l) => l.kind !== 'web').map((l) => [l.id, l.name]), st.dc, { 'aria-label': 'Warehouse' });
    s.addEventListener('change', () => { st.dc = s.value; E.render(); });
    s.style.width = 'auto';
    return s;
  };

  // print: the manifest alone, on paper (CSSOM, so the page's content policy allows it)
  let printRule = false;
  function ensurePrintRule() {
    if (printRule) return;
    for (const sh of document.styleSheets) {
      try {
        sh.insertRule('@media print{body *{visibility:hidden!important}.fleet-print,.fleet-print *{visibility:visible!important}.fleet-print{position:absolute;left:0;top:0;width:100%}.fleet-noprint{display:none!important}}', sh.cssRules.length);
        sh.insertRule('.fleet-stopblock{break-inside:avoid;border-top:1px solid var(--line);padding:12px 16px}', sh.cssRules.length);
        printRule = true; return;
      } catch (_) { /* a sheet we cannot write to */ }
    }
  }

  // ======================================================== Delivery screen
  const TABS = [['today', 'Today'], ['schedule', 'Schedule'], ['routes', 'Routes'], ['trucks', 'Trucks'], ['zones', 'Zones'], ['crew', 'Crew']];
  async function screenFleet(sub) {
    const o = await options();
    const [name, id] = String(sub || 'today').split(':');
    const tab = TABS.some(([k]) => k === name) ? name : name === 'route' || name === 'manifest' ? 'routes' : name === 'truck' ? 'trucks' : 'today';
    const nav = el('div', { class: 'toolbar fleet-noprint' }, seg(TABS, tab, (v) => go('fleet', v)));
    let body;
    if (name === 'route') body = await routeScreen(o, id);
    else if (name === 'manifest') body = await manifestScreen(id);
    else if (name === 'truck') body = await truckScreen(o, id);
    else if (tab === 'schedule') body = await scheduleScreen(o);
    else if (tab === 'routes') body = await routesScreen(o);
    else if (tab === 'trucks') body = await trucksScreen(o);
    else if (tab === 'zones') body = await zonesScreen(o);
    else if (tab === 'crew') body = await crewScreen(o);
    else body = await todayScreen(o);
    return frag(el('div', { class: 'fleet-noprint' }, head('Delivery', null, 'Operations')), nav, body);
  }

  // ------------------------------------------------------------- today
  async function todayScreen() {
    const d = await coApi(`/fleet/home?day=${st.day}`);
    const tiles = tilesRow(
      tile({ label: 'Stops done', value: `${d.stops.done}/${d.stops.total}`, tone: d.stops.failed ? 'warning' : 'neutral', text: d.stops.failed ? plural(d.stops.failed, 'failed stop') : null, ic: 'warn' }),
      tile({ label: 'On time', value: d.onTimePct == null ? '—' : `${d.onTimePct}%`, tone: d.onTimePct != null && d.onTimePct < 90 ? 'warning' : 'neutral' }),
      tile({ label: 'Stops per hour', value: d.stopsPerHour == null ? '—' : String(d.stopsPerHour) }),
      tile({ label: 'Cost per stop', value: d.costPerStopMinor == null ? '—' : money(d.costPerStopMinor), text: `${d.miles} mi planned`, ic: 'info' }));
    const routes = d.routes.map((r) => item({
      title: `${r.number} · ${r.unit_no || 'no truck'}`, amount: `${r.done}/${r.stops}`, badge: routeChip(r.status),
      detail: [r.driver || 'no driver', r.helper, `${r.planned_miles} mi`, r.failed ? plural(r.failed, 'failed stop') : null].filter(Boolean).join(' · '),
      onClick: () => go('fleet', 'route:' + r.id) }));
    const failed = d.failed.map((s) => item({ title: `${s.number} · ${s.customer || ''}`, badge: chip(s.exception === 'partial' ? 'warning' : 'critical', 'warn', words(s.exception || 'failed')),
      detail: [s.route_number, s.exception_reason].filter(Boolean).join(' · ') }));
    const oos = d.outOfService.map((v) => item({ title: v.unit_no, badge: chip('critical', 'fail', 'Out of service'), detail: v.oos_reason, onClick: () => go('fleet', 'truck:' + v.id) }));
    const maint = d.maintenanceDue.map((m) => item({ title: `${m.unit_no} · ${m.task}`, badge: chip(m.state === 'overdue' ? 'critical' : 'warning', 'clock', m.state === 'overdue' ? 'Overdue' : 'Due soon'),
      detail: [m.miles_left != null ? `${m.miles_left} mi left` : null, m.days_left != null ? `${m.days_left} days left` : null].filter(Boolean).join(' · '), onClick: () => go('fleet', 'truck:' + m.vehicle_id) }));
    const flagged = d.flagged.map((f) => item({ title: f.description, amount: `×${f.qty}`, badge: chip(f.outcome === 'picked_up' ? 'neutral' : 'warning', 'warn', f.outcome === 'picked_up' ? 'Returned, check in' : words(f.outcome)),
      detail: [f.stop_number, f.note, f.service_ticket ? `service ticket ${f.service_ticket}` : null].filter(Boolean).join(' · '),
      acts: ['damaged', 'refused'].includes(f.outcome) && !f.service_ticket ? [btn('Open service ticket', (e) => act(e.currentTarget,
        () => post(`/service/tickets/from-stop/${f.id}`), (r) => `Service ticket ${r.number} opened`), { small: true })] : null }));
    const wc = d.willCalls.map((w) => item({ title: `${w.number} · ${w.customer}`, detail: `Order ${w.order_number || ''} · collect at the warehouse`,
      acts: [btn('Release', () => completeDialog({ id: w.id, number: w.number, kind: 'will_call', lines: [] }, true), { small: true })] }));
    return frag(
      el('div', { class: 'toolbar' }, dayPicker(), el('span', { class: 'grow' }),
        d.queue ? btn(`${plural(d.queue, 'order')} to schedule`, () => go('fleet', 'schedule'), { small: true }) : null),
      tiles,
      section('Routes', d.routes.length ? plural(d.routes.length, 'route') : null, null, d.routes.length ? panel(routes) : empty('No routes for this day', 'Build them on the Routes tab.', true)),
      failed.length ? section('Failed and partial deliveries', String(failed.length), null, panel(failed)) : null,
      wc.length ? section('Will-calls waiting', String(wc.length), null, panel(wc)) : null,
      oos.length ? section('Out of service', String(oos.length), null, panel(oos)) : null,
      maint.length ? section('Maintenance due', String(maint.length), null, panel(capped(maint, 6, 'items'))) : null,
      flagged.length ? section('Flagged for the warehouse', String(flagged.length), null, panel(capped(flagged, 6, 'items'))) : null);
  }

  // ------------------------------------------------- map point for an address
  // A stop with no point is never routed. Find it with the map service, or
  // type the latitude and longitude (from any map app: long-press the house).
  function mapFixActs(addressId, label) {
    return [
      btn('Find on map', (e) => act(e.currentTarget, () => post(`/fleet/addresses/${addressId}/locate`), (r) => `Found: ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`), { small: true }),
      btn('Enter position', () => placeDialog(addressId, label), { small: true }),
    ];
  }
  function placeDialog(addressId, label) {
    const d = openDialog('Put it on the map', label || '');
    const err = errSlot();
    const both = input({ placeholder: '40.2601, -76.9336', inputmode: 'decimal', autocomplete: 'off' });
    d.body.append(el('p', { class: 'lead', text: 'In a map app, press and hold on the house; copy the two numbers it shows (latitude, longitude) and paste them here.' }),
      field('Latitude, longitude', both),
      el('div', { class: 'dlg-acts' }, btn('Save', (e) => {
        const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(both.value);
        if (!m) { err.replaceChildren(resultBox('warning', 'warn', 'Two numbers', 'Latitude first, then longitude, separated by a comma.')); return; }
        act(e.currentTarget, () => post(`/fleet/addresses/${addressId}/place`, { lat: m[1], lng: m[2] }), 'Saved on the map', { close: d.close, errorInto: showErr(err) });
      }, { primary: true }), btn('Cancel', d.close)), err);
    both.focus();
  }
  const noPointChip = () => chip('critical', 'warn', 'No map point');

  // ---------------------------------------------------------- schedule
  const isDeliveryManager = () => !!(S.person && S.person.roles.some((r) => ['owner', 'dispatcher', 'store_manager'].includes(r)));
  async function scheduleScreen() {
    const mgr = isDeliveryManager();
    const [queue, stops, lockR, waiting] = await Promise.all([coApi('/fleet/queue'), coApi(`/fleet/stops?day=${st.day}`), coApi(`/fleet/days/lock?day=${st.day}`),
      mgr ? coApi('/fleet/to-confirm') : Promise.resolve([])]);
    const lock = lockR.lock;
    const FROM = { sale: 'booked at the sale', customer_link: 'picked by the customer', dispatch: 'booked by dispatch' };
    const confirmBtn = (x) => btn('Confirm', (e) => act(e.currentTarget, () => post(`/fleet/stops/${x.id}/confirm`), `${x.number} confirmed`), { small: true, primary: true });
    const waitItems = waiting.map((x) => item({ title: `${x.number} · ${x.customer || ''}`, badge: chip('warning', 'clock', 'To confirm'),
      detail: [dayLabel(x.scheduled_on), x.window_label, x.zone_name, x.city, plural(x.pieces, 'piece'), x.order_number, FROM[x.booked_from], x.booked_by ? `by ${x.booked_by}` : null].filter(Boolean).join(' · '),
      acts: [confirmBtn(x), btn('Move', () => rescheduleDialog({ ...x, zone_name: x.zone_name }), { small: true })] }));
    const lockBtn = !mgr ? null : lock
      ? btn('Open the day again', async (e) => {
          const why = await askReason({ title: `Open ${dayLabel(st.day)} again`, sub: 'Sales and customers can book and move stops on it again', label: 'Why', confirm: 'Open it' });
          if (why == null) return;
          await act(e.currentTarget, () => post('/fleet/days/unlock', { day: st.day, reason: why }), 'Day opened');
        }, { small: true })
      : btn('Confirm all and lock day', (e) => act(e.currentTarget, () => post('/fleet/days/lock', { day: st.day }),
          (r) => `${dayLabel(st.day)} locked${r.confirmed ? `; ${plural(r.confirmed, 'stop')} confirmed` : ''}`), { small: true, primary: true });
    const q = queue.map((o) => item({
      title: `${o.number} · ${o.customer}`, amount: money(o.balance_minor),
      badge: !o.zone_name ? chip('critical', 'warn', 'No zone') : !o.has_geo && o.geo_error ? noPointChip() : chip('neutral', 'info', o.zone_name),
      why: !o.has_geo && o.geo_error ? `Not on the map yet: ${o.geo_error}.` : null,
      detail: [`${o.city} ${o.postal}`, plural(o.pieces, 'piece'), `${Math.round(o.cube_ft)} cu ft`, o.waiting_lines ? `${o.waiting_lines} line(s) not in yet` : null, o.promised_on ? `promised ${dayLabel(o.promised_on)}` : null].filter(Boolean).join(' · '),
      acts: [btn('Book', () => bookDialog(o), { small: true, primary: true }), btn('Send link', (e) => sendLink(e.currentTarget, o), { small: true }),
        ...(!o.has_geo && o.geo_error ? mapFixActs(o.address_id, `${o.customer} · ${o.line1}, ${o.city}`) : [])] }));
    const s = stops.map((x) => item({
      title: `${x.number} · ${x.customer || ''}`, badge: x.address_id && !x.has_geo && x.status === 'scheduled' ? noPointChip()
        : x.status === 'scheduled' && !x.confirmed ? chip('warning', 'clock', 'To confirm') : stopChip(x.status),
      why: x.address_id && !x.has_geo ? `Not on the map${x.geo_error ? ': ' + x.geo_error : ''}. It cannot be routed until it is.` : null,
      detail: [KIND[x.kind], x.window_label, x.zone_name, x.city, x.route_number ? `${x.route_number} #${x.seq}` : 'not routed', x.over_capacity_ok ? 'over capacity (override)' : null].filter(Boolean).join(' · '),
      acts: x.status === 'scheduled' && x.kind !== 'will_call' && (mgr || (!x.confirmed && !lock)) ? [mgr && !x.confirmed ? confirmBtn(x) : null, btn('Move', () => rescheduleDialog(x), { small: true }), btn('Cancel…', () => cancelStop(x), { small: true }),
        ...(x.address_id && !x.has_geo ? mapFixActs(x.address_id, `${x.customer || ''} · ${x.line1 || ''}, ${x.city || ''}`) : [])] : null }));
    return frag(
      section('Ready to schedule', queue.length ? plural(queue.length, 'order') : null,
        [btn('Service call', () => adhocDialog('service'), { small: true, ic: 'plus' }), btn('Pickup', () => adhocDialog('pickup'), { small: true, ic: 'plus' })],
        queue.length ? panel(capped(q, 12, 'orders')) : empty('Nothing waiting', 'Delivery orders appear here once the warehouse reserves their goods.', true)),
      el('div', { class: 'toolbar' }, dayPicker(), el('span', { class: 'grow' }),
        btn('Send day-before texts', (e) => act(e.currentTarget, () => post('/fleet/messages/day-before', { day: st.day }), (r) => `${plural(r.sent, 'reminder')} sent`), { small: true })),
      mgr && waitItems.length ? section('Waiting to confirm', plural(waitItems.length, 'stop'), null, panel(capped(waitItems, 12, 'stops'))) : null,
      section(`Booked for ${dayLabel(st.day)}`, [stops.length ? plural(stops.length, 'stop') : null, lock ? `locked${lock.by ? ' by ' + lock.by : ''}` : null].filter(Boolean).join(' · ') || null,
        lockBtn ? [lockBtn] : null,
        lock ? el('div', {}, el('p', { class: 'muted', text: 'This day is locked: sales and the customer link cannot book, move or cancel on it.' }), stops.length ? panel(s) : empty('Nothing booked that day', null, true))
          : stops.length ? panel(s) : empty('Nothing booked that day', null, true)));
  }

  async function sendLink(b, o) {
    await act(b, async () => {
      const r = await post(`/fleet/orders/${o.id}/link`);
      const d = openDialog('Self-scheduling link', `${o.number} · ${o.customer}`);
      const box = input({ value: r.url || (location.origin + r.path), readonly: true });
      d.body.append(el('p', { class: 'lead', text: `Sent to the customer by text (logged). It works for ${r.expiresInDays} days, and replaces any earlier link.` }),
        field('Link', box), el('div', { class: 'dlg-acts' }, btn('Copy', () => { box.select(); navigator.clipboard?.writeText(box.value); toast('Copied', 'good'); }, { primary: true }), btn('Close', d.close)));
      return r;
    }, null);
  }

  function slotPicker(slots, onPick) {
    if (!slots.length) return empty('No open windows', 'Every window in the next two weeks is full or closed.', true);
    const byDay = new Map();
    for (const s of slots) { if (!byDay.has(s.day)) byDay.set(s.day, []); byDay.get(s.day).push(s); }
    return el('div', {}, [...byDay.entries()].map(([day, list]) => el('div', { class: 'field' }, el('span', { text: dayLabel(day) }),
      el('div', { class: 'toolbar' }, list.map((s) => {
        const left = s.caps.stops != null ? `${Math.max(s.caps.stops - s.used.stops, 0)} left` : 'open';
        const b = el('button', { class: 'btn' + (s.fits ? '' : ' small'), type: 'button', disabled: !s.fits || null, onclick: () => onPick(s, b) },
          el('b', { text: s.label }), el('span', { class: 'sub', text: s.fits ? left : 'full' }));
        b.style.minHeight = '48px';
        return b;
      })))));
  }

  function bookDialog(o) {
    const d = openDialog('Book delivery', `${o.number} · ${o.customer} · ${o.city}`);
    const err = errSlot();
    fillDialog(d, async () => {
      const a = await coApi(`/fleet/availability?order=${o.id}&days=21`);
      const override = input({ placeholder: 'Only if a full window must take it' });
      const holder = el('div');
      const draw = () => holder.replaceChildren(slotPicker(a.slots.map((s) => ({ ...s, fits: s.fits || !!override.value.trim() })), (s, b) =>
        act(b, () => post('/fleet/stops', { orderId: o.id, day: s.day, windowId: s.windowId, override: override.value.trim() || undefined }),
          (r) => `${r.number} booked for ${dayLabel(s.day)}, ${s.label}`, { close: d.close, errorInto: showErr(err) })));
      override.addEventListener('input', draw);
      draw();
      return frag(el('p', { class: 'lead', text: `${a.zone.name} · ${plural(a.size.pieces, 'piece')} · about ${a.size.labor} crew minutes at the door.` }),
        holder, field('Override reason (dispatcher)', override, 'Books past the window\'s capacity; the reason is kept with the stop.'), err);
    });
  }

  function rescheduleDialog(x) {
    const d = openDialog('Move stop', `${x.number} · ${x.customer || ''}`);
    const err = errSlot();
    fillDialog(d, async () => {
      const zones = await coApi('/fleet/zones');
      const z = zones.zones.find((zz) => zz.name === x.zone_name);
      if (!z) return empty('No zone', 'That stop has no zone to pick a window in.', true);
      const a = await coApi(`/fleet/availability?zone=${z.id}&days=21`);
      return frag(slotPicker(a.slots, (s, b) => act(b, () => post(`/fleet/stops/${x.id}/reschedule`, { day: s.day, windowId: s.windowId }),
        `Moved to ${dayLabel(s.day)}, ${s.label}`, { close: d.close, errorInto: showErr(err) })), err);
    });
  }

  async function cancelStop(x) {
    const why = await askReason({ title: `Cancel ${x.number}`, sub: x.customer, label: 'Why is it cancelled', confirm: 'Cancel the stop' });
    if (why == null) return;
    try { await post(`/fleet/stops/${x.id}/cancel`, { reason: why }); toast('Stop cancelled', 'good'); E.render(); } catch (e) { toast(friendly(e), 'critical'); }
  }

  function adhocDialog(kind) {
    const d = openDialog(kind === 'service' ? 'New service call' : 'New pickup', 'Find the customer first');
    const err = errSlot();
    const qbox = input({ placeholder: 'Name or phone', autocomplete: 'off' });
    const results = el('div');
    const form = el('div');
    let timer = 0;
    qbox.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (qbox.value.trim().length < 2) { results.replaceChildren(); return; }
        try {
          const list = await coApi(`/fleet/customers?q=${encodeURIComponent(qbox.value.trim())}`);
          results.replaceChildren(list.length ? panel(list.map((cu) => item({ title: cu.name, detail: [cu.number, cu.phone, cu.addresses[0] ? cu.addresses[0].city : 'no address'].filter(Boolean).join(' · '),
            onClick: () => pickCustomer(cu) }))) : empty('No one by that name', null, true));
        } catch (e) { results.replaceChildren(resultBox('critical', 'fail', 'Couldn’t search', friendly(e))); }
      }, 250);
    });
    async function pickCustomer(cu) {
      results.replaceChildren();
      qbox.value = cu.name;
      if (!cu.addresses.length) { form.replaceChildren(resultBox('warning', 'warn', 'No address on file', 'Add the customer\'s address before booking a visit.')); return; }
      const addr = select(cu.addresses.map((a) => [a.id, `${a.label}: ${a.line1}, ${a.city} ${a.postal}`]), cu.addresses[0].id);
      const ord = select([['', 'No order'], ...cu.orders.map((o) => [o.id, o.number])], '');
      const problem = el('textarea', { maxlength: '500', placeholder: kind === 'service' ? 'What is wrong' : 'What is coming back, one item per line' });
      const slots = el('div');
      const zones = await coApi('/fleet/zones');
      const loadSlots = async () => {
        const postal = (cu.addresses.find((a) => a.id === addr.value) || {}).postal;
        const z = zones.zones.find((zz) => zz.active && zz.postal_codes.includes(String(postal).slice(0, 5)));
        if (!z) { slots.replaceChildren(resultBox('warning', 'warn', 'Outside every zone', `Postal code ${postal} is not in a delivery zone.`)); return; }
        const a = await coApi(`/fleet/availability?zone=${z.id}&days=21`);
        slots.replaceChildren(slotPicker(a.slots, (s, b) => act(b, () => post('/fleet/stops', {
          kind, customerId: cu.id, addressId: addr.value, orderId: ord.value || undefined, day: s.day, windowId: s.windowId,
          problem: kind === 'service' ? problem.value : undefined,
          pickupLines: kind === 'pickup' ? problem.value.split('\n').map((l) => l.trim()).filter(Boolean).map((description) => ({ description, qty: 1 })) : undefined,
        }), (r) => `${r.number} booked`, { close: d.close, errorInto: showErr(err) })));
      };
      addr.addEventListener('change', loadSlots);
      form.replaceChildren(field('Address', addr), field('Order (optional)', ord), field(kind === 'service' ? 'Problem' : 'Items', problem), slots);
      loadSlots();
    }
    d.body.append(field('Customer', qbox), results, form, err);
    qbox.focus();
  }

  // ------------------------------------------------------------- routes
  async function routesScreen(o) {
    const [routes, stops] = await Promise.all([coApi(`/fleet/routes?day=${st.day}&dc=${st.dc}`), coApi(`/fleet/stops?day=${st.day}&dc=${st.dc}`)]);
    const loose = stops.filter((s) => !s.route_id && s.status === 'scheduled' && s.kind !== 'will_call');
    const cards = routes.map((r) => item({
      title: `${r.number} · ${r.unit_no || 'no truck'}`, amount: `${r.planned_miles} mi`, badge: routeChip(r.status),
      detail: [r.driver || 'no driver yet', r.helper, plural(r.stops, 'stop'), `${Math.round(r.cube)}/${Math.round(r.cube_cap || 0)} cu ft`,
        `${Math.round(r.weight)}/${Math.round(r.weight_cap || 0)} lb`, `${Math.floor(r.planned_minutes / 60)}h ${r.planned_minutes % 60}m`].filter(Boolean).join(' · '),
      onClick: () => go('fleet', 'route:' + r.id) }));
    const err = errSlot();
    const build = btn(routes.length ? 'Rebuild drafts' : 'Build routes', async (e) => {
      const r = await act(e.currentTarget, () => post('/fleet/routes/build', { day: st.day, dcId: st.dc }),
        (x) => `${plural(x.routes.length, 'route')} built${x.unassigned.length ? `, ${x.unassigned.length} stop(s) left over` : ''}`, { errorInto: showErr(err) });
      if (r && r.unassigned.length) {
        const d = openDialog('Stops left over', 'They need a person to decide');
        d.body.append(panel(r.unassigned.map((u) => item({ title: u.number || 'Stop', detail: cap(u.reason),
          acts: u.noMapPoint && u.addressId ? mapFixActs(u.addressId, u.number) : null }))), el('div', { class: 'dlg-acts' }, btn('Close', d.close)));
      }
    }, { primary: true });
    const addTruck = btn('Add a truck', () => {
      const d = openDialog('Add a route', `${dayLabel(st.day)}`);
      const v = select(o.vehicles.filter((x) => x.status === 'active').map((x) => [x.id, `${x.unit_no} · ${words(x.kind)}`]), '');
      const e2 = errSlot();
      d.body.append(field('Truck', v), el('div', { class: 'dlg-acts' }, btn('Add', (ev) => act(ev.currentTarget, () => post('/fleet/routes', { day: st.day, dcId: st.dc, vehicleId: v.value }),
        'Route added', { close: d.close, errorInto: showErr(e2) }), { primary: true }), btn('Cancel', d.close)), e2);
    }, { small: true });
    return frag(
      el('div', { class: 'toolbar' }, dayPicker(), dcPicker(o), el('span', { class: 'grow' }), addTruck, build), err,
      section('Routes', routes.length ? plural(routes.length, 'route') : null, null, routes.length ? panel(cards) : empty('No routes yet', 'Build them from the day\'s booked stops.', true)),
      loose.length ? section('Not on a route', String(loose.length), null, panel(loose.map((s) => item({ title: `${s.number} · ${s.customer || ''}`,
        badge: s.has_geo ? null : noPointChip(), detail: [KIND[s.kind], s.window_label, s.line1, s.city].filter(Boolean).join(' · '),
        acts: s.has_geo ? null : mapFixActs(s.address_id, `${s.customer || ''} · ${s.line1 || ''}, ${s.city || ''}`) })))) : null);
  }

  async function routeScreen(o, id) {
    const r = await coApi(`/fleet/routes/${id}`);
    const draft = r.status === 'draft';
    const others = (await coApi(`/fleet/routes?day=${r.route_on}&dc=${r.dc_location_id}`)).filter((x) => x.id !== r.id && x.status === 'draft');
    const err = errSlot();
    const acts = [
      draft ? btn('Crew and truck', () => crewDialog(o, r), { small: true }) : null,
      draft ? btn('Re-optimise', (e) => act(e.currentTarget, () => post(`/fleet/routes/${r.id}/reoptimise`), (x) => `${x.beforeMiles} → ${x.miles} mi`, { errorInto: showErr(err) }), { small: true }) : null,
      draft ? btn('Lock (loaded)', (e) => act(e.currentTarget, () => post(`/fleet/routes/${r.id}/lock`), 'Route locked; the order is fixed', { errorInto: showErr(err) }), { small: true, primary: true, ic: 'hold' }) : null,
      r.status === 'locked' ? btn('Unlock', (e) => act(e.currentTarget, () => post(`/fleet/routes/${r.id}/unlock`), 'Unlocked', { errorInto: showErr(err) }), { small: true }) : null,
      btn('Manifest', () => go('fleet', 'manifest:' + r.id), { small: true, ic: 'file' }),
      btn('Load list', () => loadDialog(r), { small: true }),
    ].filter(Boolean);
    const stopCards = r.stops.map((s, i) => item({
      title: `${s.seq}. ${s.customer || ''}`, amount: s.eta || '', badge: stopChip(s.status),
      detail: [KIND[s.kind], s.window_label, `${s.city} ${s.postal}`, plural(s.pieces, 'piece'), s.stairs ? `${s.stairs} flight(s) of stairs` : null, s.number].filter(Boolean).join(' · '),
      why: s.eta_min != null && s.window_end != null && s.eta_min > s.window_end ? `Late: the crew reaches it after ${s.window_label} closes.` : (s.exception_reason || null),
      acts: draft ? [
        btn('Up', (e) => act(e.currentTarget, () => post(`/fleet/stops/${s.id}/move`, { dir: 'up' }), null, { errorInto: showErr(err) }), { small: true, disabled: i === 0 }),
        btn('Down', (e) => act(e.currentTarget, () => post(`/fleet/stops/${s.id}/move`, { dir: 'down' }), null, { errorInto: showErr(err) }), { small: true, disabled: i === r.stops.length - 1 }),
        (() => {
          const m = select([['', 'Move to…'], ...others.map((x) => [x.id, `${x.number} · ${x.unit_no || ''}`]), ['off', 'Take off route']], '', { 'aria-label': 'Move to another route' });
          m.style.width = 'auto';
          m.addEventListener('change', async () => {
            if (!m.value) return;
            try { await post(`/fleet/stops/${s.id}/assign`, { routeId: m.value === 'off' ? null : m.value }); toast('Moved', 'good'); E.render(); } catch (e) { toast(friendly(e), 'critical'); }
          });
          return m;
        })(),
      ] : null }));
    return frag(
      el('div', { class: 'toolbar' }, btn('All routes', () => go('fleet', 'routes'), { small: true }), el('span', { class: 'grow' }), routeChip(r.status)),
      section(`${r.number} · ${dayLabel(r.route_on)}`, null, null, panel(el('div', { class: 'facts' },
        fact('Truck', r.unit_no ? `${r.unit_no} (${words(r.vehicle_status)})` : 'none'), fact('Driver', r.driver || 'none'), fact('Helper', r.helper || 'none'),
        fact('Leaves', clock(r.start_min)), fact('Miles', `${r.planned_miles}`), fact('Time out', `${Math.floor(r.planned_minutes / 60)}h ${r.planned_minutes % 60}m`),
        fact('Load', `${Math.round(r.stops.reduce((a, s) => a + s.cube_ft, 0))}/${Math.round(r.cube_cap || 0)} cu ft`),
        fact('Weight', `${Math.round(r.stops.reduce((a, s) => a + s.weight_lb, 0))}/${Math.round(r.weight_cap || 0)} lb`)))),
      el('div', { class: 'toolbar' }, acts), err,
      section('Stops in order', plural(r.stops.length, 'stop'), null, r.stops.length ? panel(stopCards) : empty('No stops on this route', null, true)));
  }

  function crewDialog(o, r) {
    const d = openDialog('Crew and truck', r.number);
    const err = errSlot();
    const drivers = o.drivers.filter((x) => x.set_up && x.active);
    const v = select([['', 'No truck'], ...o.vehicles.map((x) => [x.id, `${x.unit_no} · ${words(x.kind)}${x.status !== 'active' ? ' (' + words(x.status) + ')' : ''}`])], r.vehicle_id);
    const dr = select([['', 'No driver'], ...drivers.filter((x) => x.kind === 'driver').map((x) => [x.id, `${x.name} · class ${x.license_class}${x.license_expired ? ' · licence expired' : ''}`])], r.driver_id);
    const hp = select([['', 'No helper'], ...drivers.map((x) => [x.id, x.name])], r.helper_id);
    const start = input({ type: 'time', value: `${String(Math.floor(r.start_min / 60)).padStart(2, '0')}:${String(r.start_min % 60).padStart(2, '0')}` });
    d.body.append(field('Truck', v), field('Driver', dr), field('Helper', hp), field('Leaves the warehouse', start),
      el('div', { class: 'dlg-acts' }, btn('Save', (e) => {
        const [h, m] = start.value.split(':').map(Number);
        act(e.currentTarget, () => post(`/fleet/routes/${r.id}/crew`, { vehicleId: v.value || null, driverId: dr.value || null, helperId: hp.value || null, startMin: h * 60 + m }),
          'Crew saved', { close: d.close, errorInto: showErr(err) });
      }, { primary: true }), btn('Cancel', d.close)), err);
  }

  function loadDialog(r) {
    const d = openDialog('Load list', `${r.number} · last stop loads first`);
    fillDialog(d, async () => {
      const l = await coApi(`/fleet/routes/${r.id}/load`);
      return frag(el('p', { class: 'lead', text: l.source === 'inventory' ? 'Pick list from the warehouse module.' : 'From the orders\' lines (the warehouse module\'s pick list is not installed).' }),
        panel(l.load.map((x) => item({ title: `Load ${x.loadSeq}: stop ${x.deliverSeq} · ${x.customer || ''}`, detail: (x.items || []).map((i) => `${i.qty}× ${i.description}${i.from_location ? ' (' + i.from_location + ')' : ''}`).join('; ') || KIND[x.kind] }))),
        el('div', { class: 'dlg-acts' }, btn('Close', d.close)));
    });
  }

  async function manifestScreen(id) {
    ensurePrintRule();
    const m = await coApi(`/fleet/routes/${id}/manifest`);
    const sheet = el('div', { class: 'panel fleet-print' },
      el('div', { class: 'fleet-stopblock' }, el('h2', { text: `Manifest ${m.route.number} · ${dayLabel(m.route.day)}` }),
        el('div', { class: 'sub', text: [m.route.dc, `Truck ${m.route.truck || '—'}`, `Driver ${m.route.driver || '—'}`, m.route.helper ? `Helper ${m.route.helper}` : null, `${m.route.miles} mi`].filter(Boolean).join(' · ') }),
        el('div', { class: 'sub', text: `${plural(m.totals.stops, 'stop')} · ${plural(m.totals.pieces, 'piece')} · collect ${money(m.totals.codMinor)} on delivery · load order: ${m.loadOrder.join(', ')}` })),
      m.stops.map((s) => el('div', { class: 'fleet-stopblock' },
        el('div', { class: 'toolbar' }, el('b', { class: 'grow', text: `${s.seq}. ${s.customer || ''} (${KIND[s.kind]})` }), el('span', { class: 'num', text: `${s.eta || ''} · ${s.window || ''}` })),
        el('div', { text: s.address }),
        el('div', { class: 'sub', text: [s.phone, s.order ? `Order ${s.order}` : null, s.number, s.stairs ? `${s.stairs} flight(s) of stairs` : null].filter(Boolean).join(' · ') }),
        s.notes ? el('div', { class: 'sub', text: `Notes: ${s.notes}` }) : null,
        el('ul', {}, s.items.map((i) => el('li', { text: `${i.qty}× ${i.description}${i.sku ? ' (' + i.sku + ')' : ''} · ${plural(i.pieces, 'piece')}` }))),
        BigInt(s.codMinor) > 0n ? el('div', {}, el('b', { text: `Collect on delivery: ${money(s.codMinor)}` })) : null,
        el('div', { class: 'sub', text: 'Received in good condition: ______________________________   Date: __________' }))));
    return frag(el('div', { class: 'toolbar fleet-noprint' }, btn('Back to route', () => go('fleet', 'route:' + id), { small: true }), el('span', { class: 'grow' }),
      btn('Print', () => window.print(), { primary: true, ic: 'file' })), sheet);
  }

  // ------------------------------------------------------------- trucks
  async function trucksScreen(o) {
    const vs = await coApi('/fleet/vehicles');
    const cards = vs.map((v) => item({
      title: `${v.unit_no} · ${words(v.kind)}`, amount: `${Number(v.odometer_mi).toLocaleString()} mi`,
      badge: chip(VEH_TONE[v.status] || 'neutral', v.status === 'active' ? 'ok' : 'fail', words(v.status)),
      detail: [v.make_model, v.home_name, `${Math.round(v.cube_ft)} cu ft`, `${Math.round(v.max_weight_lb)} lb`, `crew ${v.crew_size}`, v.last_dvir ? `last inspection ${words(v.last_dvir)}` : 'no inspection yet',
        v.maintenance.filter((m) => m.state !== 'ok').length ? `${v.maintenance.filter((m) => m.state !== 'ok').length} service item(s) due` : null].filter(Boolean).join(' · '),
      why: v.oos_reason, onClick: () => go('fleet', 'truck:' + v.id) }));
    return frag(section('Trucks', plural(vs.length, 'vehicle'), [btn('Add vehicle', () => vehicleDialog(o), { small: true, ic: 'plus' })], vs.length ? panel(cards) : empty('No vehicles yet', null, true)));
  }

  function vehicleDialog(o) {
    const d = openDialog('Add vehicle', S.co.name);
    const err = errSlot();
    const f = {
      unitNo: input({ placeholder: 'T-104' }), vinLast6: input({ class: 'upper', maxlength: '6', placeholder: 'Last 6 of the VIN' }),
      plate: input({ class: 'upper' }), plateState: input({ class: 'upper', maxlength: '2' }), kind: select(o.vehicleKinds.map((k) => [k, words(k)]), 'box_truck'),
      makeModel: input({}), modelYear: input({ type: 'number', inputmode: 'numeric' }),
      homeLocationId: select(o.locations.map((l) => [l.id, l.name]), st.dc), cubeFt: input({ type: 'number', inputmode: 'decimal' }),
      maxWeightLb: input({ type: 'number', inputmode: 'numeric' }), maxStops: input({ type: 'number', value: '14' }), crewSize: input({ type: 'number', value: '2' }),
      mpg: input({ type: 'number', inputmode: 'decimal', value: '9' }), odometerMi: input({ type: 'number', inputmode: 'numeric' }), geotabDeviceId: input({ placeholder: 'Optional' }),
      requiresCdl: el('input', { type: 'checkbox', class: 'pickbox' }),
    };
    d.body.append(el('div', { class: 'form-grid' },
      field('Unit number', f.unitNo), field('VIN, last 6 only', f.vinLast6), field('Plate', f.plate), field('Plate state', f.plateState), field('Type', f.kind),
      field('Make and model', f.makeModel), field('Year', f.modelYear), field('Home', f.homeLocationId), field('Cargo space (cu ft)', f.cubeFt), field('Max load (lb)', f.maxWeightLb),
      field('Max stops a day', f.maxStops), field('Crew size', f.crewSize), field('Miles per gallon', f.mpg), field('Odometer', f.odometerMi), field('Geotab device id', f.geotabDeviceId),
      el('label', { class: 'field inline' }, el('span', { text: 'Needs a CDL' }), f.requiresCdl)),
      el('div', { class: 'dlg-acts' }, btn('Add', (e) => act(e.currentTarget, () => post('/fleet/vehicles', Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.type === 'checkbox' ? x.checked : x.value]))),
        'Vehicle added', { close: () => { st.opts = null; d.close(); }, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }

  async function truckScreen(o, id) {
    const v = await coApi(`/fleet/vehicles/${id}`);
    const err = errSlot();
    const simple = (title, fields, path, ok) => () => {
      const d = openDialog(title, v.unit_no);
      const e2 = errSlot();
      const inputs = fields.map(([k, label, attrs]) => [k, attrs && attrs.options ? select(attrs.options, '') : input(attrs || {}), label]);
      d.body.append(el('div', { class: 'form-grid' }, inputs.map(([, i, label]) => field(label, i))),
        el('div', { class: 'dlg-acts' }, btn('Save', (ev) => act(ev.currentTarget, () => post(path, Object.fromEntries(inputs.map(([k, i]) => [k, i.value]))), ok, { close: d.close, errorInto: showErr(e2) }), { primary: true }), btn('Cancel', d.close)), e2);
    };
    const acts = [
      btn('Service', simple('Record a service', [['performedOn', 'Date', { type: 'date', value: st.opts.today }], ['description', 'What was done'], ['vendorName', 'Shop'],
        ['cost', 'Cost ($)', { type: 'text', inputmode: 'decimal' }], ['odometerMi', 'Odometer', { type: 'number' }],
        ['scheduleId', 'Counts as', { options: [['', 'Not a scheduled item'], ...v.schedules.map((s) => [s.id, s.task])] }]], `/fleet/vehicles/${id}/service`, 'Service recorded'), { small: true }),
      btn('Fuel', simple('Log fuel', [['gallons', 'Gallons', { inputmode: 'decimal' }], ['cost', 'Cost ($)', { inputmode: 'decimal' }], ['odometerMi', 'Odometer', { type: 'number' }], ['station', 'Station']],
        `/fleet/vehicles/${id}/fuel`, 'Fuel logged'), { small: true }),
      btn('Odometer', simple('Odometer reading', [['readingMi', 'Miles', { type: 'number', inputmode: 'numeric' }]], `/fleet/vehicles/${id}/odometer`, 'Reading saved'), { small: true }),
      btn('Schedule', simple('Maintenance schedule', [['task', 'Task'], ['everyMiles', 'Every (miles)', { type: 'number' }], ['everyDays', 'Every (days)', { type: 'number' }]],
        `/fleet/vehicles/${id}/schedules`, 'Schedule added'), { small: true }),
      v.status === 'active' ? btn('Take off road…', async () => {
        const why = await askReason({ title: `Take ${v.unit_no} off the road`, label: 'Why', confirm: 'Out of service' });
        if (why == null) return;
        try { await post(`/fleet/vehicles/${id}/status`, { status: 'out_of_service', reason: why }); toast('Out of service', 'good'); E.render(); } catch (e) { showErr(err)(e); }
      }, { small: true }) : btn('Back in service', (e) => act(e.currentTarget, () => post(`/fleet/vehicles/${id}/status`, { status: 'active' }), 'Back in service', { errorInto: showErr(err) }), { small: true }),
    ];
    const maint = v.maintenance.map((m) => item({ title: m.task, badge: chip(m.state === 'overdue' ? 'critical' : m.state === 'due' ? 'warning' : 'good', m.state === 'ok' ? 'ok' : 'clock', m.state === 'ok' ? 'OK' : m.state === 'due' ? 'Due soon' : 'Overdue'),
      detail: [m.every_miles ? `every ${m.every_miles.toLocaleString()} mi` : null, m.every_days ? `every ${m.every_days} days` : null, m.miles_left != null ? `${m.miles_left} mi left` : null, m.days_left != null ? `${m.days_left} days left` : null].filter(Boolean).join(' · ') }));
    const dv = v.dvirs.map((x) => item({ title: `${words(x.kind)} · ${x.driver}`, badge: chip(x.status === 'failed' ? 'critical' : x.status === 'passed' || x.status === 'cleared' ? 'good' : 'warning', x.status === 'failed' ? 'fail' : 'ok', words(x.status)),
      detail: [E.ago(x.submitted_at), x.odometer_mi ? `${x.odometer_mi} mi` : null, x.items.filter((i) => !i.ok).map((i) => `${i.label || i.code}: ${i.note || ''}`).join('; ') || null].filter(Boolean).join(' · '),
      why: x.status === 'cleared' ? `Cleared by ${x.cleared_by}: ${x.clear_note}` : null,
      acts: x.status === 'failed' ? [btn('Clear (manager)…', async () => {
        const note = await askReason({ title: 'Clear the inspection', sub: v.unit_no, label: 'What was fixed', confirm: 'Clear and return to service' });
        if (note != null) { try { await post(`/fleet/dvir/${x.id}/clear`, { note }); toast('Cleared', 'good'); E.render(); } catch (e) { toast(friendly(e), 'critical'); } }
      }, { small: true })] : null }));
    const svc = v.services.map((s) => item({ title: s.description, amount: money(s.cost_minor), detail: [dayLabel(s.performed_on), s.vendor_name, s.odometer_mi ? `${s.odometer_mi} mi` : null].filter(Boolean).join(' · ') }));
    const fuel = v.fuel.map((f) => item({ title: `${f.gallons} gal`, amount: money(f.cost_minor), detail: [dayLabel(f.filled_on), f.station, f.driver, f.odometer_mi ? `${f.odometer_mi} mi` : null].filter(Boolean).join(' · ') }));
    return frag(
      el('div', { class: 'toolbar' }, btn('All trucks', () => go('fleet', 'trucks'), { small: true }), el('span', { class: 'grow' }), chip(VEH_TONE[v.status], v.status === 'active' ? 'ok' : 'fail', words(v.status))),
      v.oos_reason ? resultBox('critical', 'fail', 'Out of service', v.oos_reason) : null,
      section(`${v.unit_no} · ${words(v.kind)}`, null, null, panel(el('div', { class: 'facts' },
        fact('VIN (last 6)', v.vin_last6), fact('Plate', [v.plate, v.plate_state].filter(Boolean).join(' ') || '—'), fact('Home', v.home_name), fact('Odometer', `${Number(v.odometer_mi).toLocaleString()} mi`),
        fact('Cargo', `${v.cube_ft} cu ft`), fact('Max load', `${v.max_weight_lb} lb`), fact('Stops / crew', `${v.max_stops} / ${v.crew_size}`), fact('MPG', String(v.mpg)),
        fact('CDL needed', v.requires_cdl ? 'Yes' : 'No'), fact('Geotab', v.geotab_device_id || 'not linked'), fact('Spent, 12 months', money(v.costYearMinor))))),
      el('div', { class: 'toolbar' }, acts), err,
      section('Maintenance', null, null, maint.length ? panel(maint) : empty('No schedules', null, true)),
      section('Inspections', null, null, dv.length ? panel(capped(dv, 5, 'inspections')) : empty('No inspections yet', null, true)),
      section('Service history', null, null, svc.length ? panel(capped(svc, 5, 'services')) : empty('Nothing recorded', null, true)),
      section('Fuel', null, null, fuel.length ? panel(capped(fuel, 5, 'fill-ups')) : empty('Nothing logged', null, true)));
  }

  // -------------------------------------------------------------- zones
  async function zonesScreen(o) {
    const z = await coApi('/fleet/zones');
    const cards = z.zones.map((x) => item({
      title: `${x.code} · ${x.name}`, amount: money(x.fee_minor), badge: x.active ? chip('good', 'ok', x.dc_name) : chip('neutral', 'pause', 'Inactive'),
      detail: `${x.days.map((d) => DAYS[d]).join(' ')} · ${x.postal_codes.join(', ')}`,
      why: x.windows.map((w) => `${w.label}: ${[w.stops_cap != null ? w.stops_cap + ' stops' : null, w.pieces_cap != null ? w.pieces_cap + ' pcs' : null, w.cube_cap != null ? w.cube_cap + ' cu ft' : null, w.labor_min_cap != null ? w.labor_min_cap + ' crew min' : null].filter(Boolean).join(', ') || 'no limit'}`).join(' · ') || 'No windows yet',
      acts: [btn('Edit', () => zoneDialog(o, x), { small: true }), btn('Add window', () => windowDialog(x), { small: true })] }));
    const bo = z.blackouts.map((b) => item({ title: dayLabel(b.day), detail: `${b.reason} · ${b.zone_id ? (z.zones.find((x) => x.id === b.zone_id) || {}).name : 'every zone'}` }));
    return frag(
      section('Delivery zones', plural(z.zones.length, 'zone'), [btn('Add zone', () => zoneDialog(o, null), { small: true, ic: 'plus' })], z.zones.length ? panel(cards) : empty('No zones yet', null, true)),
      section('Closed days', null, [btn('Close a day', () => blackoutDialog(z.zones), { small: true })], bo.length ? panel(bo) : empty('No closed days ahead', null, true)));
  }
  function zoneDialog(o, x) {
    const d = openDialog(x ? `Edit ${x.code}` : 'Add zone', 'Postal codes, days, fee');
    const err = errSlot();
    const code = input({ class: 'upper', value: x ? x.code : '' }), name = input({ value: x ? x.name : '' });
    const dc = select(o.locations.map((l) => [l.id, l.name]), x ? x.dc_location_id : st.dc);
    const postals = el('textarea', { placeholder: '17025, 17011, …' }); postals.value = x ? x.postal_codes.join(', ') : '';
    const fee = input({ inputmode: 'decimal', value: x ? dollars(x.fee_minor) : '0.00' });
    const days = DAYS.map((label, i) => { const c = el('input', { type: 'checkbox', class: 'pickbox', checked: x ? x.days.includes(i) : i > 0 }); return [i, c, label]; });
    d.body.append(field('Code', code), field('Name', name), field('Served from', dc), field('Postal codes', postals), field('Delivery fee ($)', fee),
      el('div', { class: 'field' }, el('span', { text: 'Delivery days' }), el('div', { class: 'toolbar' }, days.map(([, c, label]) => el('label', { class: 'field inline' }, c, el('span', { text: label }))))),
      el('div', { class: 'dlg-acts' }, btn('Save', (e) => act(e.currentTarget, () => post('/fleet/zones', { id: x ? x.id : undefined, code: code.value, name: name.value, dcLocationId: dc.value,
        postalCodes: postals.value, fee: fee.value, days: days.filter(([, c]) => c.checked).map(([i]) => i) }), 'Zone saved', { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }
  function windowDialog(z) {
    const d = openDialog('Add window', z.name);
    const err = errSlot();
    const f = { label: input({ placeholder: '8–12' }), starts: input({ type: 'time', value: '08:00' }), ends: input({ type: 'time', value: '12:00' }),
      stopsCap: input({ type: 'number', placeholder: 'No limit' }), piecesCap: input({ type: 'number', placeholder: 'No limit' }),
      cubeCap: input({ type: 'number', placeholder: 'No limit' }), laborMinCap: input({ type: 'number', placeholder: 'No limit' }) };
    d.body.append(el('div', { class: 'form-grid' }, field('Label', f.label), field('Starts', f.starts), field('Ends', f.ends), field('Stops a day', f.stopsCap),
      field('Pieces a day', f.piecesCap), field('Cubic feet a day', f.cubeCap), field('Crew minutes a day', f.laborMinCap)),
      el('div', { class: 'dlg-acts' }, btn('Add', (e) => act(e.currentTarget, () => post(`/fleet/zones/${z.id}/windows`, Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value]))),
        'Window added', { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }
  function blackoutDialog(zones) {
    const d = openDialog('Close a delivery day', 'Holiday, inventory count, weather');
    const err = errSlot();
    const day = input({ type: 'date', value: st.day }), zone = select([['', 'Every zone'], ...zones.map((z) => [z.id, z.name])], ''), reason = input({});
    d.body.append(field('Day', day), field('Zone', zone), field('Reason', reason),
      el('div', { class: 'dlg-acts' }, btn('Close the day', (e) => act(e.currentTarget, () => post('/fleet/blackouts', { day: day.value, zoneId: zone.value || null, reason: reason.value }),
        'Day closed', { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }

  // --------------------------------------------------------------- crew
  async function crewScreen() {
    const ds = await coApi(`/fleet/drivers?day=${st.day}`);
    const cards = ds.map((x) => item({
      title: x.name, amount: x.kind === 'driver' && x.license_class ? `Class ${x.license_class}` : '',
      badge: !x.set_up ? chip('warning', 'warn', 'Not set up') : x.license_expired ? chip('critical', 'fail', 'Licence expired') : x.license_expiring ? chip('warning', 'clock', 'Expires soon') : chip('good', 'ok', words(x.kind)),
      detail: [x.license_expires ? `licence to ${dayLabel(x.license_expires)}` : null, x.medical_expires ? `medical to ${dayLabel(x.medical_expires)}` : null, x.default_helper ? `rides with ${x.default_helper}` : null, x.phone].filter(Boolean).join(' · '),
      acts: [btn(x.set_up ? 'Edit' : 'Set up', () => driverDialog(x, ds), { small: true })] }));
    return section('Drivers and helpers', plural(ds.length, 'person', 'people'), null, ds.length ? panel(cards) : empty('Nobody has the driver role', 'Give people the driver role in Setup.', true));
  }
  function driverDialog(x, all) {
    const d = openDialog(x.name, 'Licence and crew');
    const err = errSlot();
    const kind = select([['driver', 'Driver'], ['helper', 'Helper']], x.kind || 'driver');
    const cls = select([['', '—'], ['A', 'A (CDL)'], ['B', 'B (CDL)'], ['C', 'C'], ['D', 'D (non-CDL)']], x.license_class || '');
    const f = { licenseState: input({ class: 'upper', maxlength: '2', value: x.license_state || '' }), licenseLast4: input({ class: 'upper', maxlength: '4', value: x.license_last4 || '', placeholder: 'Last 4 only' }),
      licenseExpires: input({ type: 'date', value: x.license_expires || '' }), medicalExpires: input({ type: 'date', value: x.medical_expires || '' }),
      phone: input({ type: 'tel', value: x.phone || '' }), hourlyCost: input({ inputmode: 'decimal', value: x.hourly_cost_minor != null ? dollars(x.hourly_cost_minor) : '' }) };
    const helper = select([['', 'Nobody'], ...all.filter((y) => y.id !== x.id).map((y) => [y.id, y.name])], x.default_helper_id || '');
    d.body.append(el('div', { class: 'form-grid' }, field('Role on the truck', kind), field('Licence class', cls), field('Licence state', f.licenseState), field('Licence no., last 4', f.licenseLast4),
      field('Licence expires', f.licenseExpires), field('Medical card expires', f.medicalExpires), field('Phone', f.phone), field('Usual helper', helper), field('Cost per hour ($)', f.hourlyCost, 'For the cost-per-stop estimate')),
      el('div', { class: 'dlg-acts' }, btn('Save', (e) => act(e.currentTarget, () => post('/fleet/drivers', { personId: x.id, kind: kind.value, licenseClass: cls.value || null, defaultHelperId: helper.value || null,
        ...Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value])) }), 'Saved', { close: () => { st.opts = null; d.close(); }, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }

  // ====================================================== the driver's phone
  async function screenMyRoute() {
    const o = await options();
    const me = await coApi(`/fleet/my?day=${st.day}`);
    const body = [];
    if (!me.routes.length) body.push(empty('No route for you that day', 'When the dispatcher puts you on a truck, it shows here.', true));
    for (const r of me.routes) {
      const err = errSlot();
      const needsDvir = !r.preTrip || r.preTrip === 'failed';
      const top = [];
      if (r.status === 'locked') {
        top.push(needsDvir ? btn('Pre-trip inspection', () => dvirDialog(o, r), { primary: true, ic: 'check' })
          : btn('Start route', () => odoDialog(`Start ${r.number}`, `/fleet/routes/${r.id}/start`, 'Route started. Drive safe.'), { primary: true, ic: 'bolt' }));
      }
      if (r.status === 'draft') top.push(resultBox('neutral', 'info', 'Not loaded yet', 'The route can change until the warehouse locks it.'));
      if (r.status === 'in_progress' && r.stops.every((s) => !['scheduled', 'arrived'].includes(s.status))) top.push(btn('Finish route', () => odoDialog(`Finish ${r.number}`, `/fleet/routes/${r.id}/finish`, 'Route finished'), { primary: true }));
      top.push(btn('Fuel', () => fuelDialog(r), { small: true }));
      const live = r.status === 'in_progress';
      const nextId = (r.stops.find((s) => ['scheduled', 'arrived'].includes(s.status)) || {}).id;
      const cards = r.stops.map((s) => {
        const open = ['scheduled', 'arrived'].includes(s.status);
        const card = item({
          title: `${s.seq}. ${s.customer || ''}`, amount: s.eta || '', badge: stopChip(s.status),
          detail: [`${s.line1}${s.line2 ? ', ' + s.line2 : ''}, ${s.city}`, s.window_label, KIND[s.kind], plural(s.pieces, 'piece'), s.stairs ? `${s.stairs} flight(s) of stairs` : null,
            BigInt(s.cod_minor || 0) > 0n && s.kind === 'delivery' ? `collect ${money(s.cod_minor)}` : null].filter(Boolean).join(' · '),
          why: [s.address_notes, s.notes, s.problem ? `Problem: ${s.problem}` : null, s.lines.length ? s.lines.map((l) => `${l.qty}× ${l.description}`).join('; ') : null].filter(Boolean).join(' · ') || null,
          acts: open ? [
            el('a', { class: 'btn small', href: s.mapsUrl, target: '_blank', rel: 'noopener' }, 'Navigate'),
            s.phone ? el('a', { class: 'btn small', href: `tel:${s.phone}` }, 'Call') : null,
            live && s.status === 'scheduled' ? btn('Arrived', (e) => act(e.currentTarget, () => post(`/fleet/stops/${s.id}/arrive`), 'Arrived', { errorInto: showErr(err) }), { small: true }) : null,
            live ? btn('Complete', () => completeDialog(s, false), { small: true, primary: s.id === nextId }) : null,
          ] : null });
        return card;
      });
      body.push(section(`${r.number} · ${r.unit_no || ''}`, `${plural(r.stops.length, 'stop')} · ${r.planned_miles} mi`, null,
        el('div', { class: 'toolbar' }, routeChip(r.status), r.preTrip ? chip(r.preTrip === 'failed' ? 'critical' : 'good', r.preTrip === 'failed' ? 'fail' : 'ok', `Pre-trip ${words(r.preTrip)}`) : null, el('span', { class: 'grow' }), top),
        err, panel(cards)));
    }
    return frag(head('My route', null, 'Operations'), el('div', { class: 'toolbar' }, dayPicker()), body);
  }

  function odoDialog(title, path, ok) {
    const d = openDialog(title, 'Odometer reading');
    const err = errSlot();
    const odo = input({ type: 'number', inputmode: 'numeric', placeholder: 'Miles on the dash' });
    d.body.append(field('Odometer', odo, 'Optional; it records the miles driven.'), el('div', { class: 'dlg-acts' },
      btn('Go', (e) => act(e.currentTarget, () => post(path, { odometerMi: odo.value }), ok, { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }

  function fuelDialog(r) {
    const d = openDialog('Log fuel', r.unit_no || '');
    const err = errSlot();
    const g = input({ inputmode: 'decimal', placeholder: '38.4' }), c = input({ inputmode: 'decimal', placeholder: '153.02' }), odo = input({ type: 'number', inputmode: 'numeric' }), s = input({});
    d.body.append(field('Gallons', g), field('Cost ($)', c), field('Odometer', odo), field('Station', s), el('div', { class: 'dlg-acts' },
      btn('Save', (e) => act(e.currentTarget, () => post(`/fleet/vehicles/${r.vehicle_id}/fuel`, { gallons: g.value, cost: c.value, odometerMi: odo.value, station: s.value }), 'Fuel logged',
        { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }

  function dvirDialog(o, r) {
    const d = openDialog('Pre-trip inspection', `${r.unit_no} · every item, before you drive`);
    const err = errSlot();
    const rows = o.dvirItems.map((i) => {
      let ok = null;
      const note = input({ placeholder: 'What is wrong' });
      note.hidden = true;
      const yes = el('button', { class: 'btn', type: 'button' }, icon('check'), 'OK'), no = el('button', { class: 'btn', type: 'button' }, icon('warn'), 'Problem');
      for (const b of [yes, no]) { b.style.minHeight = '48px'; b.style.flex = '1'; }
      const paint = () => { yes.classList.toggle('primary', ok === true); no.classList.toggle('primary', ok === false); note.hidden = ok !== false; };
      yes.addEventListener('click', () => { ok = true; paint(); });
      no.addEventListener('click', () => { ok = false; paint(); note.focus(); });
      const wrap = el('div', { class: 'field' }, el('span', { text: i.label + (i.safety ? '' : ' (not a safety item)') }), el('div', { class: 'toolbar' }, yes, no), note);
      return { i, wrap, get: () => ({ code: i.code, ok, note: note.value }) };
    });
    const odo = input({ type: 'number', inputmode: 'numeric', placeholder: 'Miles on the dash' });
    d.body.append(...rows.map((x) => x.wrap), field('Odometer', odo),
      el('div', { class: 'dlg-acts' }, btn('Submit inspection', async (e) => {
        const items = rows.map((x) => x.get());
        if (items.some((x) => x.ok === null)) { err.replaceChildren(resultBox('warning', 'warn', 'Answer every item', 'Tap OK or Problem on each line.')); return; }
        await act(e.currentTarget, () => post('/fleet/dvir', { vehicleId: r.vehicle_id, items, odometerMi: odo.value }),
          (x) => (x.outOfService ? x.message : x.defects ? 'Inspection saved, defects noted' : 'Inspection passed'), { close: d.close, errorInto: showErr(err) });
      }, { primary: true }), btn('Cancel', d.close)), err);
  }

  function signaturePad() {
    const cv = el('canvas', { width: '600', height: '200', 'aria-label': 'Signature' });
    cv.style.width = '100%'; cv.style.height = '160px'; cv.style.border = '1px solid var(--line-2)'; cv.style.borderRadius = '10px'; cv.style.touchAction = 'none'; cv.style.background = '#fff';
    const g = cv.getContext('2d');
    g.lineWidth = 3; g.lineCap = 'round'; g.strokeStyle = '#111';
    let down = false, inked = false;
    const at = (e) => { const b = cv.getBoundingClientRect(); return [(e.clientX - b.left) * (cv.width / b.width), (e.clientY - b.top) * (cv.height / b.height)]; };
    cv.addEventListener('pointerdown', (e) => { down = true; cv.setPointerCapture(e.pointerId); g.beginPath(); g.moveTo(...at(e)); });
    cv.addEventListener('pointermove', (e) => { if (!down) return; g.lineTo(...at(e)); g.stroke(); inked = true; });
    cv.addEventListener('pointerup', () => { down = false; });
    const clear = btn('Clear', () => { g.clearRect(0, 0, cv.width, cv.height); inked = false; }, { small: true });
    return { node: el('div', {}, cv, el('div', { class: 'toolbar' }, el('span', { class: 'grow sub', text: 'Customer signs with a finger' }), clear)), value: () => (inked ? cv.toDataURL('image/png') : '') };
  }

  // A service visit on the route: what was found and done, time spent, parts used; the service desk takes it from there.
  function serviceDialog(s) {
    const d = openDialog(`Finish visit · ${s.service_ticket}`, `${s.customer || ''} · ${s.service_visit_kind === 'pickup' ? 'Pickup for repair' : 'Service call'}`, { wide: true });
    const err = errSlot();
    const pickup = s.service_visit_kind === 'pickup';
    const outcome = select(pickup ? [['fixed', 'Picked up for the shop'], ['not_home', 'Nobody home'], ['other', 'Could not pick it up']]
      : [['fixed', 'Fixed'], ['needs_parts', 'Needs parts'], ['needs_return', 'Needs to come back to the shop'], ['no_fault', 'No fault found'], ['not_home', 'Nobody home'], ['other', 'Something else']], 'fixed');
    const notes = el('textarea', { maxlength: '2000', placeholder: 'What you found and what you did' });
    const minutes = input({ type: 'number', inputmode: 'numeric', placeholder: '45' });
    const parts = (s.serviceParts || []).map((p) => {
      const cb = el('input', { type: 'checkbox', class: 'pickbox', disabled: !['reserved', 'ready'].includes(p.line_status) || null });
      return { p, cb, node: el('label', { class: 'field inline' }, cb, el('span', { text: `${p.qty}× ${p.name}${['reserved', 'ready'].includes(p.line_status) ? '' : ' (not in hand)'}` })) };
    });
    const recipient = input({ placeholder: 'Name of whoever signed' });
    const sig = signaturePad();
    const photos = el('textarea', { placeholder: 'Photo links, one per line (https://…)' });
    d.body.append(field('How did it go', outcome), field('Work notes', notes), field('Time spent (minutes)', minutes),
      parts.length ? el('div', { class: 'field' }, el('span', { text: 'Parts used' }), parts.map((x) => x.node)) : null,
      !pickup ? field('Signed by', recipient) : null, !pickup ? el('div', { class: 'field' }, el('span', { text: 'Customer signature' }), sig.node) : null,
      field('Photos', photos),
      el('div', { class: 'dlg-acts' }, btn('Finish visit', (e) => act(e.currentTarget, () => post(`/service/visits/${s.service_visit_id}/complete`, {
        outcome: outcome.value, workNotes: notes.value, minutes: minutes.value, recipient: recipient.value, signature: sig.value() || undefined,
        partsUsed: parts.filter((x) => x.cb.checked).map((x) => x.p.id), photos: photos.value.split('\n').map((x) => x.trim()).filter(Boolean),
      }), (r) => `Visit saved; ticket is ${words(r.status)}`, { close: d.close, errorInto: showErr(err) }), { primary: true }), btn('Cancel', d.close)), err);
  }

  function completeDialog(s, willCall) {
    if (s.service_visit_id && !willCall) return serviceDialog(s);
    const d = openDialog(willCall ? `Release ${s.number}` : `Complete stop ${s.seq}`, `${s.customer || ''}${s.kind ? ' · ' + KIND[s.kind] : ''}`, { wide: true });
    const err = errSlot();
    const pickup = s.kind === 'pickup';
    const exc = select([['', 'Everything went as planned'], ['not_home', 'Nobody home'], ['refused', 'Customer refused it'], ['damaged', 'Damaged'], ['partial', 'Only part of it'], ['other', 'Something else']], '');
    const lineSel = (s.lines || []).map((l) => {
      const o = select([[pickup ? 'picked_up' : 'delivered', pickup ? 'Picked up' : 'Delivered'], ['refused', 'Refused'], ['damaged', 'Damaged'], ['not_delivered', pickup ? 'Not picked up' : 'Not delivered']], pickup ? 'picked_up' : 'delivered');
      const note = input({ placeholder: 'Note (optional)' });
      return { l, o, note, node: el('div', { class: 'field' }, el('span', { text: `${l.qty}× ${l.description}` }), o, note) };
    });
    exc.addEventListener('change', () => {
      if (exc.value === 'not_home' || exc.value === 'refused') for (const x of lineSel) x.o.value = exc.value === 'refused' ? 'refused' : 'not_delivered';
    });
    const reason = el('textarea', { maxlength: '500', placeholder: 'What happened, for the customer\'s file' });
    const recipient = input({ placeholder: 'Name of whoever signed' });
    const sig = signaturePad();
    const photos = el('textarea', { placeholder: 'Photo links, one per line (https://…)' });
    const due = BigInt(s.cod_minor || 0);
    const codMethod = select([['', 'Nothing collected'], ['cash', 'Cash'], ['check', 'Check'], ['card', 'Card']], '');
    const codAmt = input({ inputmode: 'decimal', value: due > 0n ? dollars(due) : '' });
    const codRef = input({ placeholder: 'Check no. or card last 4' });
    d.body.append(
      field('How did it go', exc),
      lineSel.length ? el('div', {}, lineSel.map((x) => x.node)) : null,
      field('What happened', reason, 'Needed when anything was not delivered.'),
      !pickup ? field('Received by', recipient) : null,
      !pickup ? el('div', { class: 'field' }, el('span', { text: 'Signature' }), sig.node) : null,
      field('Photos', photos),
      s.kind === 'delivery' || willCall ? el('div', {}, el('div', { class: 'field' }, el('span', { text: due > 0n ? `Balance due: ${money(due)}` : 'Nothing due on this order' })),
        el('div', { class: 'form-grid' }, field('Collected by', codMethod), field('Amount ($)', codAmt), field('Reference', codRef))) : null,
      el('div', { class: 'dlg-acts' }, btn(willCall ? 'Release' : 'Complete stop', (e) => act(e.currentTarget, () => post(`/fleet/stops/${s.id}/complete`, {
        exception: exc.value || undefined, reason: reason.value, recipient: recipient.value, signature: sig.value() || undefined,
        photos: photos.value.split('\n').map((x) => x.trim()).filter(Boolean),
        lines: lineSel.map((x) => ({ id: x.l.id, outcome: x.o.value, note: x.note.value })),
        cod: codMethod.value ? { method: codMethod.value, amount: codAmt.value, reference: codRef.value } : null,
      }), (r) => (r.status === 'delivered' ? 'Done' : r.status === 'partial' ? 'Saved as partial; the rest is flagged' : 'Saved as not delivered'), { close: d.close, errorInto: showErr(err) }), { primary: true }),
      btn('Cancel', d.close)), err);
  }

  E.register('fleet', 'Delivery', 'truck', screenFleet, 'Operations', { icon: ICON_TRUCK });
  E.register('myroute', 'My route', 'pin', screenMyRoute, 'Operations', { icon: ICON_PIN });
})();
