// workforce screens: time clock, schedules, commissions. Registers with
// window.ERP (see docs/MODULES.md). Phone first: the clock is big buttons,
// every list is cards (ERP.item) with amounts on the right, sections are
// picked from a dropdown, nothing scrolls sideways. Times typed into a form
// are sent without a zone and read in the store's own time zone.
(() => {
  'use strict';
  const E = window.ERP;
  const { el, frag, money, section, head, item, tile, tilesRow, empty, chip, coApi, post, act, openDialog, fillDialog, resultBox,
    friendly, fact, go, plural, cap, todayIso, busy, toast } = E;

  // The page's CSP refuses inline <style> and style attributes; a constructed
  // stylesheet is CSSOM, which it allows.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('.wf-pick{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 14px}.wf-pick select{min-width:190px}' +
    '.wf-clock{display:grid;gap:12px;padding:16px}.wf-clock .btn{min-height:64px;font-size:18px;width:100%}' +
    '.wf-state{font-size:15px;color:var(--ink-2)}.wf-sub{color:var(--ink-2);font-size:13.5px}' +
    '@media print{body *{visibility:hidden!important}.wf-print,.wf-print *{visibility:visible!important}.wf-print{position:absolute;left:0;top:0;width:100%}.wf-noprint{display:none!important}}' +
    '.wf-pad{padding:4px 16px 12px}.wf-pad2{padding:14px 16px}');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  const isoTs = (t) => String(t || '').replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
  const clock = (t) => { const d = new Date(isoTs(t)); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const fmtDay = (d) => (d ? E.dayLabel(String(d).slice(0, 10)) : '');
  const pct = (bps) => `${(Number(bps || 0) / 100).toFixed(2).replace(/\.00$/, '')}%`;
  const input = (props) => el('input', Object.assign({ type: 'text' }, props));
  const moneyIn = (ph) => input({ inputmode: 'decimal', placeholder: ph || '0.00', autocomplete: 'off' });
  const select = (opts, value) => el('select', {}, opts.map(([v, t]) => el('option', { value: v, text: t, selected: v === value || null })));
  const field = (label, control, hint, wide) => el('label', { class: 'field' + (wide ? ' wide' : '') }, el('span', { text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null);
  const panel = (...kids) => el('div', { class: 'panel' }, kids);
  const list = (nodes, emptyText) => panel(nodes.length ? nodes : empty(emptyText, null, true));
  const facts = (...pairs) => panel(el('div', { class: 'facts' }, pairs.filter(Boolean).map(([k, v]) => fact(k, v))));
  const KIND = { in: 'Punched in', out: 'Punched out', break_start: 'Break started', break_end: 'Break ended' };
  const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const monday = (iso) => { const d = new Date(iso + 'T12:00:00Z'); const w = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - w); return d.toISOString().slice(0, 10); };
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  function formDialog(title, sub, build, label, send, okText) {
    const d = openDialog(title, sub);
    const out = el('div', { role: 'status', 'aria-live': 'polite' });
    const parts = build(d);
    const btn = el('button', { class: 'btn primary', type: 'button', onclick: () => act(btn, () => send(parts), okText,
      { close: d.close, errorInto: (e) => out.replaceChildren(resultBox('critical', 'fail', 'Not done', friendly(e))) }) }, label);
    d.body.append(parts.lead ? el('p', { class: 'lead', text: parts.lead }) : null, el('div', { class: 'form-grid' }, parts.fields),
      el('div', { class: 'dlg-acts' }, btn, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel')), out);
    return d;
  }

  let OPT = null;
  const options = async () => (OPT && OPT.co === E.S.co.id && OPT.as === (E.S.person && E.S.person.id) ? OPT.data
    : (OPT = { co: E.S.co.id, as: E.S.person && E.S.person.id, data: await coApi('/workforce/options') }).data);
  const isManager = (o) => o.me.roles.some((r) => ['owner', 'store_manager', 'hr'].includes(r));
  const canPlans = (o) => o.me.roles.some((r) => ['owner', 'hr', 'controller'].includes(r));
  const locSelect = (o, value) => select(o.locations.map((l) => [l.id, l.name]), value || (o.locations[0] && o.locations[0].id));

  const SECTIONS = [['', 'My time'], ['board', 'Who is on the clock'], ['exceptions', 'Time to fix'], ['schedule', 'Schedule'],
    ['commissions', 'Commission plans'], ['statement', 'Commission statements'], ['leaderboard', 'Leaderboard']];
  function picker(cur) {
    const s = select(SECTIONS, cur);
    s.addEventListener('change', () => go('workforce', s.value));
    return el('div', { class: 'wf-pick wf-noprint' }, el('span', { class: 'wf-sub', text: 'Show' }), s);
  }

  async function screen(sub) {
    const [kind, arg] = String(sub || '').split('~');
    OPT = null;
    const o = await options();
    const body = kind === 'board' ? await board(o, arg) : kind === 'exceptions' ? await exceptions(o) : kind === 'schedule' ? await schedule(o, arg)
      : kind === 'commissions' ? await commissions(o) : kind === 'statement' ? await statement(o) : kind === 'leaderboard' ? await leaderboard()
      : await myTime(o);
    return frag(head('Time and commissions', []), picker(kind || ''), body);
  }

  // ------------------------------------------------------------- my time
  function geo() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      const t = setTimeout(() => resolve(null), 3000);
      navigator.geolocation.getCurrentPosition((p) => { clearTimeout(t); resolve({ lng: p.coords.longitude, lat: p.coords.latitude }); },
        () => { clearTimeout(t); resolve(null); }, { timeout: 2500, maximumAge: 60000 });
    });
  }

  async function myTime(o) {
    const d = await coApi('/workforce/me');
    if (!d.employee) return list([], `${E.S.person ? E.S.person.name : 'The person you are acting as'} is not set up as an employee here, so there is no clock to punch. Pick yourself under “acting as”, or ask payroll to link your sign-in to your employee record.`);
    const last = d.last;
    const state = !last || last.kind === 'out' ? 'off' : last.kind === 'break_start' ? 'break' : 'on';
    const home = (o.employees.find((x) => x.id === d.employee.id) || {}).home_location_id;
    const loc = locSelect(o, (last && state !== 'off' && last.location_id) || home);
    const pun = (kind, label, primary) => {
      const b = el('button', { class: 'btn' + (primary ? ' primary' : ''), type: 'button', onclick: async () => {
        busy(b, true, 'Saving…');
        const g = await geo();
        busy(b, false);
        act(b, () => post('/workforce/punch', { kind, locationId: loc.value, geo: g || undefined }), (r) => `${KIND[kind]}${r.hours ? ` · ${r.hours} h today` : ''}`);
      } }, label);
      return b;
    };
    const buttons = state === 'off' ? [pun('in', 'Punch in', true)] : state === 'break' ? [pun('break_end', 'End break', true)]
      : [pun('out', 'Punch out', true), pun('break_start', 'Start a break')];
    return frag(
      panel(el('div', { class: 'wf-clock' },
        el('div', {}, el('b', { text: d.employee.name }),
          el('div', { class: 'wf-state', text: state === 'off' ? (last ? `Off the clock since ${clock(last.at)}` : 'Not punched in') : state === 'break' ? `On a break since ${clock(last.at)}` : `On the clock since ${clock(last.at)} at ${last.location}` })),
        field('Store', loc), ...buttons)),
      section('Coming up', 'store time', null, list(d.shifts.map((s) => item({ title: fmtDay(s.on_day), amount: `${s.starts}–${s.ends}`, detail: [s.location, s.role].filter(Boolean).join(' · ') })), 'No shifts scheduled.')),
      section('My hours, two weeks', null, null, list(d.hours.map((h) => item({ title: fmtDay(h.worked_on), amount: `${Number(h.hours).toFixed(2)} h`,
        badge: h.status === 'exception' ? chip('warning', 'warn', 'Needs a fix') : h.status === 'approved' ? chip('good', 'ok', 'Approved') : null })), 'No hours yet.')),
      section('My punches, this week', null, null, list(d.recent.slice().reverse().map((p) => item({ title: KIND[p.kind], detail: `${clock(p.at)} · ${p.location}${p.source === 'manager' ? ' · entered by ' + (p.recorded_by || 'a manager') : ''}`,
        badge: p.voided_at ? chip('neutral', 'x', 'Voided') : null, why: p.reason || p.void_reason || null })), 'No punches yet.')));
  }

  // ---------------------------------------------------------------- board
  function enterPunchDialog(o, emp, kind) {
    formDialog('Enter a punch', `${emp.name} · a manager’s entry, with a reason`, () => {
      const k = select(Object.entries(KIND).map(([v, t]) => [v, t.replace('Punched', 'Punch').replace('started', 'start').replace('ended', 'end')]), kind || 'in');
      const at = input({ type: 'datetime-local', value: nowLocal(), max: nowLocal() });
      const loc = locSelect(o, emp.home_location_id);
      const reason = el('textarea', { maxlength: '500', placeholder: 'Why the clock did not get it' });
      return { k, at, loc, reason, lead: 'The time is the store’s local time.', fields: [field('Punch', k), field('When', at), field('Store', loc), field('Reason', reason, null, true)] };
    }, 'Enter it', (p) => post('/workforce/punch', { employeeId: emp.id, kind: p.k.value, at: p.at.value, locationId: p.loc.value, reason: p.reason.value }),
    (r) => `Entered · ${r.hours} h that day${r.status === 'exception' ? ', still open' : ''}`);
  }

  function punchesDialog(o, emp) {
    const d = openDialog('Punches', `${emp.name} · last two weeks`, { wide: true });
    const load = () => fillDialog(d, async () => {
      const rows = await coApi(`/workforce/punches?employee=${emp.id}&from=${addDays(todayIso(), -14)}&to=${todayIso()}`);
      return list(rows.slice().reverse().map((p) => item({ title: `${KIND[p.kind]} · ${clock(p.at)}`, detail: `${p.location}${p.source === 'manager' ? ' · entered by ' + (p.recorded_by || '') : ''}`,
        why: p.voided_at ? `Voided: ${p.void_reason}` : p.reason || null, badge: p.voided_at ? chip('neutral', 'x', 'Voided') : null,
        acts: p.voided_at ? [] : [el('button', { class: 'btn small', type: 'button', onclick: () => { d.close(); fixDialog(p, emp); } }, 'Change')] })), 'No punches.');
    });
    load();
    void o;
  }

  function fixDialog(p, emp) {
    formDialog('Change a punch', `${emp.name} · ${KIND[p.kind]} ${clock(p.at)}`, () => {
      const how = select([['move', 'Move it to another time'], ['void', 'Void it']], 'move');
      const at = input({ type: 'datetime-local', max: nowLocal() });
      const reason = el('textarea', { maxlength: '500' });
      const fa = field('New time', at);
      how.addEventListener('change', () => { fa.hidden = how.value !== 'move'; });
      return { how, at, reason, lead: 'The original stays on file, voided with your reason. Nobody changes their own time.', fields: [field('Change', how), fa, field('Reason', reason, null, true)] };
    }, 'Save', (x) => post(`/workforce/punches/${p.id}/fix`, { at: x.how.value === 'move' ? x.at.value : null, reason: x.reason.value }), (r) => `Saved · ${r.hours} h that day`);
  }

  async function board(o, locId) {
    const loc = select([['', 'Every store'], ...o.locations.map((l) => [l.id, l.name])], locId || '');
    loc.addEventListener('change', () => go('workforce', loc.value ? `board~${loc.value}` : 'board'));
    const rows = await coApi(`/workforce/clock${locId ? `?location=${locId}` : ''}`);
    const mgr = isManager(o);
    const on = rows.filter((r) => r.last_kind && r.last_kind !== 'out').length;
    return frag(el('div', { class: 'wf-pick' }, loc),
      tilesRow(tile({ label: 'On the clock', value: String(on), tone: 'neutral', ic: 'clock', text: `${plural(rows.length, 'hourly person', 'hourly people')}` })),
      section('Hourly staff', null, null, list(rows.map((r) => {
        const st = !r.last_kind || r.last_kind === 'out' ? ['neutral', 'pause', 'Off'] : r.last_kind === 'break_start' ? ['warning', 'clock', 'On break'] : ['good', 'ok', 'On the clock'];
        const emp = { id: r.employee_id, name: r.name, home_location_id: (o.employees.find((x) => x.id === r.employee_id) || {}).home_location_id };
        return item({ title: r.name, badge: chip(...st), amount: r.today_hours ? `${Number(r.today_hours).toFixed(2)} h` : null,
          detail: [r.position, r.last_at ? `${KIND[r.last_kind]} ${clock(r.last_at)}${r.location ? ' at ' + r.location : ''}` : 'No punches yet'].filter(Boolean).join(' · '),
          acts: mgr ? [el('button', { class: 'btn small', type: 'button', onclick: () => enterPunchDialog(o, emp) }, 'Enter a punch'),
            el('button', { class: 'btn small', type: 'button', onclick: () => punchesDialog(o, emp) }, 'Punches')] : [] });
      }), 'No hourly staff here.')));
  }

  async function exceptions(o) {
    const rows = await coApi('/workforce/exceptions');
    return section('Days still open', 'payroll cannot be built over these', null, list(rows.map((r) => item({
      title: `${r.name} · ${fmtDay(r.worked_on)}`, amount: `${Number(r.hours).toFixed(2)} h`, badge: chip(r.missed ? 'serious' : 'neutral', r.missed ? 'warn' : 'clock', r.label),
      detail: r.open_since ? `In since ${clock(r.open_since)}` : r.detail || '',
      acts: isManager(o) ? [el('button', { class: 'btn small primary', type: 'button', onclick: () => enterPunchDialog(o, { id: r.employee_id, name: r.name,
        home_location_id: (o.employees.find((x) => x.id === r.employee_id) || {}).home_location_id }, 'out') }, 'Enter the missing punch')] : [] })), 'Nothing to fix.'));
  }

  // ------------------------------------------------------------- schedule
  async function schedule(o, arg) {
    const [locId, wk] = String(arg || '').split('@');
    const loc = locSelect(o, locId || undefined);
    const weekStart = wk || monday(todayIso());
    const when = input({ type: 'date', value: weekStart });
    const move = () => go('workforce', `schedule~${loc.value}@${monday(when.value || todayIso())}`);
    loc.addEventListener('change', move); when.addEventListener('change', move);
    const d = await coApi(`/workforce/schedule?location=${loc.value}&week=${weekStart}`);
    const mgr = isManager(o);
    const add = el('button', { class: 'btn primary', type: 'button', onclick: () => formDialog('Add a shift', `${loc.selectedOptions[0].text} · times are the store’s (${d.timezone})`, () => {
      const emp = select(o.employees.filter((x) => x.pay_type === 'hourly' || true).map((x) => [x.id, `${x.name}${x.position ? ' · ' + x.position : ''}`]));
      const day = input({ type: 'date', value: weekStart }), from = input({ type: 'time', value: '10:00' }), to = input({ type: 'time', value: '18:00' });
      const role = input({ maxlength: '40', placeholder: 'Floor, Delivery, Opening' });
      return { emp, day, from, to, role, fields: [field('Who', emp, null, true), field('Day', day), field('From', from), field('To', to), field('Role', role)] };
    }, 'Add', (p) => {
      const end = p.to.value <= p.from.value ? `${addDays(p.day.value, 1)}T${p.to.value}` : `${p.day.value}T${p.to.value}`;
      return post('/workforce/shifts', { employeeId: p.emp.value, locationId: loc.value, startsAt: `${p.day.value}T${p.from.value}`, endsAt: end, role: p.role.value });
    }, 'Shift added') }, 'Add a shift');
    const days = [...Array(7)].map((_, i) => addDays(weekStart, i));
    return frag(
      el('div', { class: 'wf-pick' }, loc, field('Week of', when), el('button', { class: 'btn', type: 'button', onclick: () => go('workforce', `schedule~${loc.value}@${addDays(weekStart, -7)}`) }, '← Week'),
        el('button', { class: 'btn', type: 'button', onclick: () => go('workforce', `schedule~${loc.value}@${addDays(weekStart, 7)}`) }, 'Week →'), mgr ? add : null),
      ...days.map((day) => section(fmtDay(day), null, null, list(d.shifts.filter((s) => s.on_day === day).map((s) => item({
        title: s.name, amount: `${s.starts}–${s.ends}`, detail: [s.role, `${Number(s.hours)} h`, s.notes].filter(Boolean).join(' · '),
        acts: mgr ? [el('button', { class: 'btn small', type: 'button', onclick: (e) => act(e.currentTarget, () => post(`/workforce/shifts/${s.id}/cancel`, {}), 'Shift cancelled') }, 'Cancel')] : [] })), 'Nobody scheduled.'))),
      section('Hours this week', null, null, list(d.people.map((p) => item({ title: p.name, amount: `${p.hours} h`, detail: plural(p.shifts, 'shift'),
        badge: p.hours > 40 ? chip('warning', 'warn', 'Over 40 hours') : null })), 'Nobody scheduled.')));
  }

  // ---------------------------------------------------------- commissions
  async function commissions(o) {
    const d = await coApi('/workforce/commissions');
    const can = canPlans(o);
    const period = select(o.periods.filter((p) => ['open', 'timecards_approved'].includes(p.status)).map((p) => [p.id, `${p.pay_group}: ${fmtDay(p.starts_on)} – ${fmtDay(p.ends_on)}`]));
    const accrueBtn = el('button', { class: 'btn', type: 'button', onclick: () => act(accrueBtn, () => post('/workforce/commissions/accrue', {}),
      (r) => `${plural(r.earned, 'line')} earned, ${plural(r.spiffs, 'spiff')}, ${plural(r.chargebacks, 'chargeback')}: ${money(r.totalMinor)}`) }, 'Accrue now');
    const approveBtn = el('button', { class: 'btn primary', type: 'button', disabled: !period.value || null, onclick: () => act(approveBtn, () => post('/workforce/commissions/approve', { payPeriodId: period.value }),
      (r) => r.approved.length ? `Approved for ${r.approved.map((x) => `${x.name} ${money(x.payout)}`).join(', ')}` : 'Nothing new to approve') }, 'Approve for payroll');
    const planName = (id) => (d.plans.find((p) => p.id === id) || {}).name || '';
    return frag(
      tilesRow(tile({ label: 'Commissions payable (2160)', value: money(d.payableMinor), tone: 'neutral', ic: 'book', text: 'Accrued, not yet paid' })),
      can ? section('Into payroll', 'commission is earned when a sale is handed over', [accrueBtn], panel(el('div', { class: 'form-grid wf-pad' },
        field('Pay period', period, 'Approve before building that payroll.', true), el('div', { class: 'field' }, approveBtn)))) : null,
      section('Earned, not yet approved', null, null, list(d.accrued.map((a) => item({ title: a.name, amount: money(a.amount_minor), detail: plural(a.events, 'line') })), 'Nothing waiting.')),
      section('Plans', null, can ? [el('button', { class: 'btn', type: 'button', onclick: () => planDialog() }, 'New plan')] : null,
        list(d.plans.map((p) => item({ title: p.name, badge: p.active ? null : chip('neutral', 'pause', 'Inactive'),
          detail: `${pct(p.rate_bps)} of ${p.basis === 'margin' ? 'gross margin' : 'the sale'}` +
            d.tiers.filter((t) => t.plan_id === p.id).map((t) => ` · ${pct(t.rate_bps)} past ${money(t.min_monthly_minor)} a month`).join('') +
            d.rules.filter((r) => r.plan_id === p.id).map((r) => ` · ${r.category || r.vendor}: ${pct(r.rate_bps)}`).join(''),
          why: p.notes || null,
          acts: can ? [el('button', { class: 'btn small', type: 'button', onclick: () => tierDialog(p) }, 'Add a tier'),
            el('button', { class: 'btn small', type: 'button', onclick: () => ruleDialog(p, d) }, 'Add a category or vendor rate')] : [] })), 'No plans yet.')),
      section('Who is on which plan', null, can ? [el('button', { class: 'btn', type: 'button', onclick: () => assignDialog(o, d) }, 'Put someone on a plan')] : null,
        list(d.assignments.map((a) => item({ title: a.name, detail: `${a.plan} since ${fmtDay(a.effective_from)}${Number(a.draw_minor) ? ` · draw ${money(a.draw_minor)} a period${a.draw_recoverable ? ', recoverable' : ''}` : ''}`,
          badge: a.on_payroll ? null : chip('warning', 'warn', 'Not on payroll') })), 'Nobody yet.')),
      section('Spiffs', null, can ? [el('button', { class: 'btn', type: 'button', onclick: () => spiffDialog(d) }, 'New spiff')] : null,
        list(d.spiffs.map((s) => item({ title: s.name, amount: `${money(s.amount_minor)} each`, detail: `${s.product ? s.sku + ' ' + s.product : s.vendor} · ${fmtDay(s.starts_on)} – ${fmtDay(s.ends_on)}`,
          badge: s.active ? null : chip('neutral', 'pause', 'Ended'),
          acts: can && s.active ? [el('button', { class: 'btn small', type: 'button', onclick: (e) => act(e.currentTarget, () => post(`/workforce/commissions/spiffs/${s.id}/end`, {}), 'Spiff ended') }, 'End it')] : [] })), 'No spiffs.')),
      section('Recent approvals', null, null, list(d.payouts.map((p) => item({ title: `${p.name} · period ending ${fmtDay(p.ends_on)}`, amount: money(p.payout_minor),
        detail: `commission ${money(p.commission_minor)}${Number(p.topup_minor) ? ` · draw ${money(p.topup_minor)}` : ''}${Number(p.recovered_minor) ? ` · ${money(p.recovered_minor)} draw recovered` : ''}${Number(p.draw_balance_minor) ? ` · ${money(p.draw_balance_minor)} still owed back` : ''}` })), 'None yet.')));
    void planName;
  }

  function planDialog() {
    formDialog('New commission plan', null, () => {
      const name = input({ maxlength: '80' }), basis = select([['sale', '% of the sale'], ['margin', '% of gross margin']], 'sale');
      const rate = input({ inputmode: 'decimal', placeholder: '4' }), notes = input({ maxlength: '300' });
      return { name, basis, rate, notes, fields: [field('Name', name, null, true), field('Pays', basis), field('Rate %', rate), field('Notes', notes, null, true)] };
    }, 'Create', (p) => post('/workforce/commissions/plans', { name: p.name.value, basis: p.basis.value, rate: p.rate.value, notes: p.notes.value }), 'Plan created');
  }
  function tierDialog(plan) {
    formDialog('Add a volume tier', plan.name, () => {
      const from = moneyIn('20000'), rate = input({ inputmode: 'decimal', placeholder: '5' });
      return { from, rate, lead: 'Once a salesperson’s delivered sales for the month pass this, later sales pay this rate.', fields: [field('From monthly sales of', from), field('Rate %', rate)] };
    }, 'Add', (p) => post(`/workforce/commissions/plans/${plan.id}/tiers`, { from: p.from.value, rate: p.rate.value }), 'Tier added');
  }
  function ruleDialog(plan, d) {
    formDialog('A rate for a category or vendor', plan.name, () => {
      const cat = select([['', 'Any category'], ...d.categories.map((c) => [c, c])], ''), ven = select([['', 'Any vendor'], ...d.vendors.map((v) => [v.id, v.name])], '');
      const rate = input({ inputmode: 'decimal', placeholder: '8' });
      return { cat, ven, rate, lead: 'A vendor rate wins over a category rate, and both win over the volume tiers.', fields: [field('Category', cat), field('Vendor', ven), field('Rate %', rate)] };
    }, 'Add', (p) => post(`/workforce/commissions/plans/${plan.id}/rules`, { category: p.cat.value, vendorId: p.ven.value || null, rate: p.rate.value }), 'Rate added');
  }
  function assignDialog(o, d) {
    formDialog('Put someone on a plan', null, () => {
      const who = select(o.sellers.map((s) => [s.id, s.name])), plan = select(d.plans.filter((p) => p.active).map((p) => [p.id, p.name]));
      const from = input({ type: 'date', value: todayIso() }), draw = moneyIn('0.00'), rec = select([['yes', 'Paid back out of later commission'], ['no', 'Not paid back']], 'yes');
      return { who, plan, from, draw, rec, fields: [field('Who', who), field('Plan', plan), field('From', from), field('Draw a pay period', draw, 'Pay is topped up to this when commission falls short.'), field('Draw', rec)] };
    }, 'Save', (p) => post('/workforce/commissions/assignments', { appUserId: p.who.value, planId: p.plan.value, from: p.from.value, draw: p.draw.value || '0', recoverable: p.rec.value === 'yes' }), 'Saved');
  }
  function spiffDialog(d) {
    formDialog('New spiff', 'a set amount per unit, for sales written in its dates', () => {
      const name = input({ maxlength: '80' }), prod = select([['', 'Any product from the vendor below'], ...d.products.map((p) => [p.id, `${p.sku} ${p.name}`])], '');
      const ven = select([['', '—'], ...d.vendors.map((v) => [v.id, v.name])], ''), amt = moneyIn(), from = input({ type: 'date', value: todayIso() }), to = input({ type: 'date' });
      return { name, prod, ven, amt, from, to, fields: [field('Name', name, null, true), field('Product', prod, null, true), field('Or vendor', ven), field('Per unit', amt), field('From', from), field('To', to)] };
    }, 'Create', (p) => post('/workforce/commissions/spiffs', { name: p.name.value, productId: p.prod.value || null, vendorId: p.prod.value ? null : p.ven.value || null,
      amount: p.amt.value, from: p.from.value, to: p.to.value }), 'Spiff created');
  }

  // ----------------------------------------------------------- statements
  async function statement(o) {
    const period = select(o.periods.map((p) => [p.id, `${p.pay_group}: ${fmtDay(p.starts_on)} – ${fmtDay(p.ends_on)}`]));
    const mine = E.S.person ? E.S.person.id : '';
    const who = select(o.sellers.map((s) => [s.id, s.name]), o.sellers.some((s) => s.id === mine) ? mine : undefined);
    const box = el('div', { class: 'wf-print' });
    const load = async () => {
      if (!period.value || !who.value) { box.replaceChildren(empty('Pick a pay period and a person.', null, true)); return; }
      box.replaceChildren(E.loadingNode());
      try {
        const s = await coApi(`/workforce/commissions/statement?period=${period.value}&person=${who.value}`);
        const p = s.payout;
        box.replaceChildren(
          panel(el('div', { class: 'wf-pad2' }, el('b', { text: `Commission statement · ${s.name}` }),
            el('div', { class: 'wf-sub', text: `${fmtDay(s.period.starts_on)} – ${fmtDay(s.period.ends_on)}, paid ${fmtDay(s.period.pay_date)}` }))),
          p ? facts(['Commission', money(p.commission_minor)], ['Chargebacks carried in', money(p.carried_in_minor)], ['Draw guaranteed', money(p.draw_minor)],
            ['Draw paid back', money(p.recovered_minor)], ['Draw paid', money(p.topup_minor)], ['Paid through payroll', money(p.payout_minor)],
            ['Draw still owed back', money(p.draw_balance_minor)]) : resultBox('neutral', 'info', 'Not approved yet', `${money(s.totalMinor)} earned so far in this period.`),
          section('Lines', null, null, list(s.lines.map((l) => item({ title: `${l.order_number} · ${l.description}`, amount: money(l.amount_minor),
            detail: `${fmtDay(l.earned_on)} · ${l.kind === 'spiff' || l.kind === 'spiff_chargeback' ? (l.spiff || 'spiff') : `${pct(l.rate_bps)} of ${money(l.basis_minor)}`}${l.split_bps < 10000 ? ` · ${pct(l.split_bps)} share` : ''}`,
            badge: /chargeback/.test(l.kind) ? chip('warning', 'warn', 'Charged back') : null })), 'No commission lines.')));
      } catch (e) { box.replaceChildren(E.errorBox(e, load)); }
    };
    period.addEventListener('change', load); who.addEventListener('change', load);
    await load();
    return frag(el('div', { class: 'wf-pick wf-noprint' }, field('Pay period', period), field('Person', who),
      el('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Print')), box);
  }

  // ---------------------------------------------------------- leaderboard
  async function leaderboard() {
    const from = input({ type: 'date', value: todayIso().slice(0, 8) + '01' }), to = input({ type: 'date', value: todayIso() });
    const box = el('div');
    const load = async () => {
      box.replaceChildren(E.loadingNode());
      try {
        const d = await coApi(`/workforce/leaderboard?from=${from.value}&to=${to.value}`);
        box.replaceChildren(list(d.rows.map((r, i) => item({ title: `${i + 1}. ${r.name}`, amount: money(r.deliveredMinor),
          detail: `written ${money(r.writtenMinor)} on ${plural(r.orders, 'order')} · margin ${r.marginPct === null ? '—' : r.marginPct + '%'} · commission ${money(r.commissionMinor)}` })), 'No sales in these dates.'));
      } catch (e) { box.replaceChildren(E.errorBox(e, load)); }
    };
    from.addEventListener('change', load); to.addEventListener('change', load);
    await load();
    return frag(el('div', { class: 'wf-pick' }, field('From', from), field('To', to)), el('p', { class: 'wf-sub', text: 'Ranked by delivered sales. Written is what was sold in the dates; delivered is what was handed over.' }), box);
  }

  E.register('workforce', 'Time and commissions', 'clock', screen, 'Back office');
  void toast; void cap;
})();
