// The platform screens: the Operator console (the ERP's own team) and the
// account screen (a customer's sign-ins, API tokens and own password).
// Cards and pickers only, so both work on a phone; data goes in with textContent.
(() => {
'use strict';
const E = window.ERP;
const { el, icon, chip, plural, ago, api, openDialog, resultBox, fillDialog, field, select, input, friendly, busy, toast, section, empty, head } = E;

const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const ROLE_LIST = [['owner', 'Owner'], ['controller', 'Controller'], ['approver', 'Approver'], ['ap_clerk', 'A/P clerk'], ['viewer', 'Viewer'],
  ['store_manager', 'Store manager'], ['sales', 'Sales'], ['cashier', 'Cashier'], ['buyer', 'Buyer'], ['warehouse', 'Warehouse'], ['dispatcher', 'Dispatcher'],
  ['driver', 'Driver'], ['ar_clerk', 'A/R clerk'], ['hr', 'HR'], ['web_admin', 'Web admin'], ['marketing', 'Marketing'], ['technician', 'Technician'], ['designer', 'Designer']];
const when = (iso) => (iso ? ago(iso) : 'never');

/** A value shown once, in its own box, with a copy button. */
function copyBox(value) {
  const code = el('code', { text: value });
  const btn = el('button', { class: 'btn', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(value); toast('Copied', 'good'); }
    catch (_) { const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Selected: copy it with your keyboard', 'good'); }
  } }, 'Copy');
  return el('div', { class: 'copybox' }, code, btn);
}
/** Label/value rows; a row with a third part (a function) makes its figure a link to the detail behind it. */
function facts(rows) {
  return el('dl', { class: 'facts' }, rows.filter(Boolean).flatMap(([k, v, go]) => [el('dt', { text: k }),
    go ? el('dd', {}, el('button', { type: 'button', class: 'linkbtn', 'aria-label': `${k}: ${v}, show them`, onclick: (e) => { e.stopPropagation(); go(); } }, String(v)))
       : el('dd', { text: String(v) })]));
}
function card({ title, badge, rows, acts, onClick }) {
  return el('div', { class: 'pcard' + (onClick ? ' click' : ''), onclick: onClick || null, role: onClick ? 'button' : null, tabindex: onClick ? '0' : null,
    onkeydown: onClick ? (e) => { if (e.key === 'Enter') onClick(e); } : null },
  el('div', { class: 'top' }, el('h3', { text: title }), badge || null),
  rows ? facts(rows) : null,
  acts && acts.length ? el('div', { class: 'acts', onclick: (e) => e.stopPropagation() }, acts) : null);
}
/** A dialog with a form: fields, a primary button, and where the answer goes. */
function formDialog(title, sub, fields, goLabel, submit) {
  const d = openDialog(title, sub);
  const out = el('div');
  const go = el('button', { class: 'btn primary', type: 'button' }, goLabel);
  go.addEventListener('click', async () => {
    busy(go, true); out.replaceChildren();
    try { const node = await submit(); if (node) { out.replaceChildren(node); go.remove(); } }
    catch (e) { out.replaceChildren(resultBox('critical', 'fail', 'Not done', friendly(e))); }
    finally { if (go.isConnected) busy(go, false); }
  });
  d.body.append(...fields, el('div', { class: 'dlg-acts' }, go, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Close')), out);
  return d;
}
const statusChip = (t) => (t.kind === 'demo' ? chip('neutral', 'info', 'Demo') : t.status === 'suspended' ? chip('critical', 'hold', 'Suspended') : chip('good', 'ok', 'Active'));
/**
 * Setup mode (0066), as a countdown: ERP setup may approve new vendors and hires until the company goes live,
 * begins trading, or 60 days after its first setup approval. One chip for the customer: the company with the
 * fewest days left, or "not started" while none has a setup approval yet; nothing once every company is live.
 */
function setupChip(list) {
  const open = (list || []).filter((x) => !x.live && x.daysLeft !== 0);
  if (!open.length) return (list || []).some((x) => !x.live) ? chip('neutral', 'clock', 'Setup ended (60 days)') : null;
  const started = open.filter((x) => x.daysLeft != null).sort((a, b) => a.daysLeft - b.daysLeft);
  if (!started.length) return chip('neutral', 'clock', 'Setup: 60 days from first approval');
  const d = started[0].daysLeft;
  return chip(d <= 7 ? 'warning' : 'neutral', 'clock', `Setup: ${plural(d, 'day')} left${open.length > 1 ? ` (${started[0].company})` : ''}`);
}
E.setupChip = setupChip;

// ========================================================= operator console
async function screenOperator() {
  const [list, prospects, jobs, errors] = await Promise.all([api('/api/platform/customers'), api('/api/platform/prospects'), api('/api/platform/jobs'), api('/api/platform/errors?limit=20')]);
  const customers = list.filter((t) => t.kind !== 'demo');
  const demo = list.filter((t) => t.kind === 'demo');
  const sup = E.S.me.viewer.support;
  const top = head('Operator console', [
    el('button', { class: 'btn primary', type: 'button', onclick: newCustomer }, icon('plus'), 'New customer'),
  ], 'The ERP team');
  const open = (t, focus) => () => customerDialog(t.id, focus);
  const custCards = customers.map((t) => card({
    title: t.name, badge: E.frag(statusChip(t), setupChip(t.setup)), onClick: open(t),
    rows: [['Plan', t.plan], ['Companies', t.companies, open(t, 'companies')], ['Stores', t.stores, open(t, 'stores')],
      ['Sign-ins', `${t.users} (${plural(t.people, 'person', 'people')})`, open(t, 'users')],
      ['Services on', t.services.length, open(t, 'services')], ['Last activity', when(t.last_activity), open(t, 'log')]],
    acts: [el('button', { class: 'btn', type: 'button', onclick: () => enterSupport(t) }, icon('user'), 'Support')],
  }));
  const demoCards = demo.map((t) => card({
    title: t.name, badge: statusChip(t), onClick: open(t),
    rows: [['Companies', t.companies, open(t, 'companies')], ['Stores', t.stores, open(t, 'stores')], ['People', t.people, open(t, 'users')],
      ['Last activity', when(t.last_activity), open(t, 'log')]],
    acts: [el('button', { class: 'btn', type: 'button', onclick: () => enterSupport(t) }, icon('user'), 'Open in support mode')],
  }));
  const prospectCards = prospects.map((p) => card({
    title: p.name, badge: p.expired ? chip('neutral', 'clock', 'Expired') : chip('good', 'ok', 'Active'),
    rows: [['Email', p.email], ['Ends', new Date(p.expires_at).toLocaleString()], ['Last sign-in', when(p.last_sign_in_at)]],
    acts: p.expired ? [] : [el('button', { class: 'btn', type: 'button', onclick: (e) => E.act(e.currentTarget, () => api(`/api/platform/prospects/${p.id}/end`, { method: 'POST', body: {} }), 'Demo sign-in ended') }, 'End now')],
  }));
  return E.frag(top,
    sup ? el('p', { class: 'lead', text: `You are in support mode for ${sup.tenantName}.` }) : null,
    section('Customers', plural(customers.length, 'customer'), null,
      customers.length ? el('div', { class: 'cards' }, custCards) : empty('No customers yet', 'Create the first one with New customer.', true)),
    section('Demo', 'Sample data for showing the ERP', null,
      el('div', { class: 'row-acts' },
        el('button', { class: 'btn', type: 'button', onclick: newProspect }, icon('plus'), 'Demo sign-in for a prospect'),
        el('button', { class: 'btn', type: 'button', onclick: resetDemo }, icon('refresh'), 'Reset demo')),
      demoCards.length ? el('div', { class: 'cards' }, demoCards) : empty('No demo loaded', 'Reset demo loads it from the sample data.', true),
    prospectCards.length ? el('div', { class: 'cards' }, prospectCards) : null),
    jobsSection(jobs), errorsSection(errors));
}

// ------------------------------------------------- scheduled jobs, errors
const JOB_TONE = { ok: ['good', 'ok', 'OK'], partial: ['warning', 'warn', 'Partly'], failed: ['critical', 'fail', 'Failed'], running: ['neutral', 'clock', 'Running'], never: ['neutral', 'pending', 'Not run yet'] };
const jobChip = (s) => chip(...(JOB_TONE[s] || JOB_TONE.never));
function jobsSection(d) {
  return section('Scheduled jobs', 'Run inside the server, one runner at a time', null, el('div', { class: 'cards' }, d.jobs.map((j) => card({
    title: j.label, badge: jobChip(j.status), onClick: j.lastRunId ? () => runDialog(j.lastRunId) : null,
    rows: [['Last run', when(j.lastRunAt), j.lastRunId ? () => runDialog(j.lastRunId) : null], ['Next run', j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : 'within a minute'],
      j.error ? ['Error', j.error] : null, j.note ? ['Result', j.note] : null],
    acts: [el('button', { class: 'btn', type: 'button', onclick: (e) => runNow(e.currentTarget, j) }, icon('refresh'), 'Run now')],
  }))));
}
/** Run now: the server queues it and answers at once; this watches the job log for the run and says how it went. */
async function runNow(btn, j) {
  busy(btn, true, 'Queued…');
  try {
    const q = await api(`/api/platform/jobs/${j.id}/run`, { method: 'POST', body: {} });
    toast(q.already ? `${j.label} is already queued` : `${j.label} queued`, 'good');
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      const d = await api(`/api/platform/jobs?job=${encodeURIComponent(j.id)}`);
      const run = d.runs.find((r) => r.trigger === 'manual' && new Date(r.started_at) >= new Date(q.since) && r.status !== 'running');
      if (run) { toast(`${j.label}: ${run.status}${run.error ? ` — ${run.error}` : ''}`, run.status === 'ok' ? 'good' : 'warning'); E.render(); return; }
    }
    toast(`${j.label} is still waiting for the scheduler; it will show in the job log when it runs`, 'warning');
  } catch (e) { toast(friendly(e), 'critical'); }
  finally { if (btn.isConnected) busy(btn, false); }
}
async function runDialog(id) {
  const d = openDialog('Job run', null);
  fillDialog(d, async () => {
    const r = await api(`/api/platform/jobs/runs/${id}`);
    return E.frag(card({ title: r.label, badge: jobChip(r.status), rows: [['Started', new Date(r.started_at).toLocaleString()], ['Finished', r.finished_at ? new Date(r.finished_at).toLocaleString() : 'still running'],
      ['How', `${r.trigger} · ${r.runner}`], r.summary ? ['Summary', r.summary] : null, r.error ? ['Error', r.error] : null] }),
      r.items.length ? el('div', { class: 'cards' }, r.items.map((x) => card({ title: x.company || x.tenant || 'The install', badge: x.ok ? chip('good', 'ok', 'OK') : chip('critical', 'fail', 'Failed'), rows: [['Note', x.note]] })))
        : empty('Nothing per company in this run', null, true),
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, icon('chev', 'back'), 'Back')));
  });
}
function errorsSection(list) {
  const ref = input({ maxlength: '6', placeholder: 'ABC123', autocapitalize: 'characters' });
  const find = el('button', { class: 'btn', type: 'button', onclick: () => { if (ref.value.trim()) errorDialog(ref.value.trim()); } }, 'Look up');
  return section('Server errors', list.length ? `latest ${list.length}` : 'none', null,
    el('div', { class: 'row-acts' }, field('Reference a person read out', ref), find),
    list.length ? el('div', { class: 'cards' }, list.map((x) => card({ title: `ref ${x.ref}`, badge: chip(x.kind === 'request' ? 'warning' : 'critical', 'warn', x.kind.replace(/_/g, ' ')), onClick: () => errorDialog(x.ref),
      rows: [['When', new Date(x.at).toLocaleString()], ['Where', [x.method, x.path].filter(Boolean).join(' ') || '—'], ['Customer', x.tenant || '—'], ['Message', x.message]] })))
      : empty('No server errors', 'Errors a person sees as "ref ABC123" land here.', true));
}
function errorDialog(ref) {
  const d = openDialog(`Error ref ${ref.toUpperCase()}`, null);
  fillDialog(d, async () => {
    const x = await api(`/api/platform/errors/${encodeURIComponent(ref)}`);
    return E.frag(card({ title: x.message, rows: [['When', new Date(x.at).toLocaleString()], ['Kind', x.kind.replace(/_/g, ' ')], ['Where', [x.method, x.path].filter(Boolean).join(' ') || '—'],
      ['Customer', x.tenant || '—'], ['Company', x.company || '—'], ['Who', x.who || '—'], ['Alert sent', x.alerted ? 'yes' : 'no']] }),
      x.stack ? el('pre', { class: 'stack', text: x.stack }) : null,
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, icon('chev', 'back'), 'Back')));
  });
}

async function newCustomer() {
  const { packs, plans } = await api('/api/platform/packs');
  const f = {
    tenant: input({ maxlength: '60', placeholder: 'The business buying the ERP' }), legal: input({ maxlength: '120', placeholder: 'As on its tax filings' }),
    state: select([['', 'Pick a state'], ...STATES.map((s) => [s, s])], ''), pack: select(packs.map((p) => [p.id, p.name]), packs[0] && packs[0].id),
    plan: select(plans.map((p) => [p, p]), 'standard'), ownerName: input({ maxlength: '80' }), ownerEmail: input({ type: 'email', maxlength: '200' }),
    bank: input({ maxlength: '80', placeholder: 'Optional' }), routing: input({ maxlength: '4', inputmode: 'numeric', placeholder: 'Last 4' }), account: input({ maxlength: '4', inputmode: 'numeric', placeholder: 'Last 4' }),
  };
  const blurb = el('p', { class: 'hint', text: (packs[0] || {}).blurb || '' });
  f.pack.addEventListener('change', () => { blurb.textContent = (packs.find((p) => p.id === f.pack.value) || {}).blurb || ''; });
  formDialog('New customer', 'A clean account: the setup pack, no sample data', [
    field('Customer name', f.tenant), field('First company’s legal name', f.legal), field('State', f.state), field('Setup pack', f.pack), blurb,
    field('Plan', f.plan), field('Owner’s name', f.ownerName), field('Owner’s email', f.ownerEmail, 'The invite to set a password goes here.'),
    field('Operating bank', f.bank, 'Left blank, it shows as not set up yet.'), field('Routing number, last 4', f.routing), field('Account number, last 4', f.account),
  ], 'Create and invite', async () => {
    const r = await api('/api/platform/customers', { method: 'POST', body: { tenantName: f.tenant.value, legalName: f.legal.value, state: f.state.value,
      pack: f.pack.value, plan: f.plan.value, ownerName: f.ownerName.value, ownerEmail: f.ownerEmail.value,
      bankName: f.bank.value, routingLast4: f.routing.value, accountLast4: f.account.value } });
    E.render();
    return inviteResult(r, 'Customer created');
  });
}
function inviteResult(r, title) {
  if (!r.inviteLink && r.emailed) return resultBox('good', 'ok', title, r.note || 'The invite is on its way by email.');
  if (!r.inviteLink) return resultBox(r.note && /not connected/.test(r.note) ? 'warning' : 'good', r.note && /not connected/.test(r.note) ? 'warn' : 'ok', title, r.note || 'Done.');
  return E.frag(resultBox('good', 'ok', title, r.emailed ? 'The invite is on its way by email. The link below works too, once, for 7 days.'
    : 'No email is connected, so nothing was sent. Copy this link and send it to them yourself; it works once, for 7 days.'), copyBox(r.inviteLink));
}

const FOCUS = { companies: 'Companies', stores: 'Stores', users: 'Sign-ins', services: 'Services on', log: 'Platform log', tokens: 'API tokens made in support mode' };
/** A customer's detail. A figure tapped on a card opens just what is behind it, with Back to the whole customer. */
function customerDialog(id, focus) {
  const d = openDialog('Customer', null, { wide: true });
  let t = null;
  let view = focus || null;
  const show = (v) => { view = v; paint(); };
  const back = () => el('button', { class: 'btn', type: 'button', onclick: () => show(null) }, icon('chev', 'back'), 'Back');
  const sections = {
    companies: () => section('Companies', null, null, el('div', { class: 'cards' }, t.companiesList.map((c) => card({ title: c.name, rows: [['Legal name', c.legal_name], ['Pack', c.packs || 'none'], ['Status', c.status]] })))),
    stores: () => section('Stores', null, null, t.storesList.length ? el('div', { class: 'cards' }, t.storesList.map((x) => card({ title: x.name, rows: [['Code', x.code], ['Company', x.company], ['State', x.state || ''], ['Kind', x.kind || 'store']] })))
      : empty('No stores', null, true)),
    users: () => section('Sign-ins', null, null, t.users.length ? el('div', { class: 'cards' }, t.users.map(userCard)) : empty('No sign-ins', null, true)),
    services: () => section('Services on', null, null, t.services.length ? el('div', { class: 'cards' }, t.services.map((x) => card({ title: x }))) : empty('No services on', null, true)),
    log: () => section('Platform log', null, null, t.recent.length ? el('div', { class: 'cards' }, t.recent.map((a) => card({ title: a.action, rows: [['When', new Date(a.at).toLocaleString()], ['Who', a.actor]] })))
      : empty('Nothing recorded yet', null, true)),
    // review of 0066: API tokens made (or rotated) in support mode are no longer allowed; any made before are listed to revoke with the owner
    tokens: () => section('API tokens made in support mode', null, null, (t.tokensMadeInSupport || []).length ? el('div', { class: 'cards' }, t.tokensMadeInSupport.map((k) => card({
      title: k.name || 'API token', badge: k.active ? chip('critical', 'warn', 'Still active') : chip('neutral', 'none', 'Revoked'),
      rows: [['Made', new Date(k.at).toLocaleString()], ['By', k.actor], ['What to do', k.active ? 'Revoke it with the owner unless they asked for it; it acts as the customer, not as support mode.' : 'Nothing; it no longer works.']] })))
      : empty('None', 'No API token was made in support mode.', true)),
  };
  function userCard(u) {
    return card({
      title: u.name, badge: u.status === 'active' ? chip('good', 'ok', u.kind === 'prospect' ? 'Demo' : 'Active') : u.status === 'invited' ? chip('warning', 'clock', 'Invited') : chip('neutral', 'none', 'Off'),
      rows: [['Email', u.email], ['Roles', u.roles.map((r) => `${r.role.replace(/_/g, ' ')} (${r.company})`).join(', ') || 'none'], ['Last sign-in', when(u.last_sign_in_at)]],
      acts: u.status === 'invited' ? [el('button', { class: 'btn', type: 'button', onclick: async (e) => {
        busy(e.currentTarget, true);
        try { const r = await api(`/api/platform/customers/${id}/logins/${u.id}/invite`, { method: 'POST', body: {} }); d.body.prepend(inviteResult(r, 'New invite link')); }
        catch (err) { toast(friendly(err), 'critical'); } finally { if (e.currentTarget) busy(e.currentTarget, false); }
      } }, 'New invite link')] : [],
    });
  }
  function paint() {
    d.dlg.querySelector('h2').textContent = view ? `${t.name}: ${FOCUS[view]}` : t.name;
    if (view) { d.body.replaceChildren(el('div', { class: 'dlg-acts' }, back()), sections[view]()); return; }
    const acts = [el('button', { class: 'btn primary', type: 'button', onclick: () => { d.close(); enterSupport(t); } }, icon('user'), 'Enter support mode')];
    if (t.kind !== 'demo') {
      acts.push(t.status === 'suspended'
        ? el('button', { class: 'btn', type: 'button', onclick: async (e) => { await E.act(e.currentTarget, () => api(`/api/platform/customers/${id}/reactivate`, { method: 'POST', body: {} }), 'Reactivated'); load(); } }, 'Reactivate')
        : el('button', { class: 'btn', type: 'button', onclick: async () => {
          const reason = await E.askReason({ title: `Suspend ${t.name}`, lead: 'Their people cannot sign in and their API tokens stop working. Nothing is deleted; reactivate to reopen.', confirm: 'Suspend' });
          if (reason === null) return;
          try { await api(`/api/platform/customers/${id}/suspend`, { method: 'POST', body: { reason } }); toast('Suspended', 'good'); load(); E.render(); } catch (e) { toast(friendly(e), 'critical'); }
        } }, 'Suspend'));
    }
    d.body.replaceChildren(
      facts([['Status', t.status === 'suspended' ? `Suspended: ${t.status_reason || ''}` : t.kind === 'demo' ? 'Demo' : 'Active'], ['Plan', t.plan],
        ['Companies', t.companies, () => show('companies')], ['Stores', t.stores, () => show('stores')], ['Sign-ins', t.users.length, () => show('users')],
        ['Services on', t.services.length, () => show('services')], ['API tokens', t.activeTokens], ['Last activity', when(t.last_activity), () => show('log')],
        ['Made in support mode', (t.tokensMadeInSupport || []).filter((k) => k.active).length, () => show('tokens')]]),
      setupChip(t.setup) ? el('p', {}, setupChip(t.setup)) : null,
      (t.tokensMadeInSupport || []).some((k) => k.active) ? resultBox('serious', 'warn', 'API tokens made in support mode',
        'A token made by the ERP team in support mode acts as the customer, not as support mode. Revoke it with the owner unless they asked for it.') : null,
      el('div', { class: 'dlg-acts' }, acts),
      sections.companies(), sections.users(), sections.log());
  }
  const load = () => fillDialog(d, async () => { t = await api(`/api/platform/customers/${id}`); paint(); return d.body.firstChild ? E.frag(...d.body.childNodes) : el('div'); });
  load();
}

async function enterSupport(t) {
  const reason = await E.askReason({ title: `Support: ${t.name}`, lead: 'You will see this customer’s companies and may act as their people. It is recorded on their log, with your reason, and a banner shows the whole time.', label: 'Why (the ticket or the request)', confirm: 'Enter support mode' });
  if (reason === null) return;
  try {
    await api(`/api/platform/customers/${t.id}/support`, { method: 'POST', body: { reason } });
    E.S.co = null;
    history.replaceState(null, '', location.pathname);
    E.show('boot');
    await E.boot();
  } catch (e) { toast(friendly(e), 'critical'); }
}

function newProspect() {
  const name = input({ maxlength: '80' }), email = input({ type: 'email', maxlength: '200' });
  const days = select([[1, '1 day'], [3, '3 days'], [7, '7 days'], [14, '14 days'], [30, '30 days']], 7);
  formDialog('Demo sign-in', 'A time-limited sign-in to the demo for a sales prospect', [
    field('Prospect’s name', name), field('Their email (it is their sign-in)', email), field('Lasts', days),
  ], 'Create', async () => {
    const r = await api('/api/platform/prospects', { method: 'POST', body: { name: name.value, email: email.value, days: Number(days.value) } });
    E.render();
    return E.frag(resultBox('good', 'ok', 'Demo sign-in ready', `Send these to the prospect. The password is shown only now. It ends ${new Date(r.expiresAt).toLocaleString()}.`),
      el('p', { class: 'hint', text: 'Email' }), copyBox(r.email), el('p', { class: 'hint', text: 'Password' }), copyBox(r.password));
  });
}

function resetDemo() {
  const confirm = input({ maxlength: '20', placeholder: 'RESET DEMO' });
  formDialog('Reset demo', 'Wipes the demo companies and loads the sample data again', [
    el('p', { class: 'lead', text: 'Only the demo is touched: customers are never part of a reset. Prospects’ demo sign-ins are kept. Type RESET DEMO to go ahead.' }),
    field('Confirm', confirm),
  ], 'Reset the demo', async () => {
    const r = await api('/api/platform/demo/reset', { method: 'POST', body: { confirm: confirm.value.trim() } });
    E.render();
    return resultBox('good', 'ok', 'Demo reset', `${plural(r.rowsRemoved, 'row')} removed from ${plural(r.tablesCleared, 'table')}, ${plural(r.seeds, 'sample file')} loaded, ${plural(r.loginsKept, 'demo sign-in')} kept.`);
  });
}

// ===================================================================== account
async function screenAccount() {
  const S = E.S;
  const owner = E.managesAccount();
  const blocks = [head('Account', [], S.me.viewer.tenantName || (S.me.viewer.support && S.me.viewer.support.tenantName) || 'Your account')];
  if (E.isCustomer()) {
    blocks.push(section('You', null, null, card({ title: S.me.viewer.name, rows: [['Email', S.me.viewer.email], S.me.viewer.prospect ? ['Demo sign-in ends', new Date(S.me.viewer.expiresAt).toLocaleString()] : null],
      acts: S.me.viewer.prospect ? [] : [el('button', { class: 'btn', type: 'button', onclick: changePassword }, 'Change password')] })));
  }
  if (owner) {
    const [users, tokens] = await Promise.all([api('/api/tenant/users'), api('/api/tenant/tokens')]);
    // support mode never mints an identity that is not support mode: no invites or links, no new or rotated tokens (the owner does these)
    const sup = E.inSupport();
    const supNote = sup ? el('p', { class: 'fine', text: 'In support mode you cannot invite people, send invite links, or make or rotate API tokens: each would give a sign-in or a key that is not support mode. The owner does these from Account, signed in as themselves. Revoking a token is still allowed.' }) : null;
    blocks.push(section('Sign-ins', plural(users.length, 'person', 'people'), null,
      sup ? supNote : el('div', { class: 'row-acts' }, el('button', { class: 'btn primary', type: 'button', onclick: inviteSomeone }, icon('plus'), 'Invite someone')),
      el('div', { class: 'cards' }, users.map((u) => card({
        title: u.name, badge: u.status === 'active' ? chip('good', 'ok', 'Active') : u.status === 'invited' ? chip('warning', 'clock', 'Invited') : chip('neutral', 'none', 'Off'),
        rows: [['Email', u.email], ['Roles', u.roles.map((r) => `${r.role.replace(/_/g, ' ')} (${r.company})`).join(', ') || 'none'], ['Last sign-in', when(u.last_sign_in_at)]],
        acts: userActs(u),
      })))));
    const live = tokens.filter((k) => k.status === 'active');
    blocks.push(section('API tokens', 'For your own integrations, like a catalog app', null,
      sup ? null : el('div', { class: 'row-acts' }, el('button', { class: 'btn', type: 'button', onclick: newToken }, icon('plus'), 'New token')),
      live.length ? el('div', { class: 'cards' }, live.map((k) => card({
        title: k.name, badge: chip('good', 'ok', 'Active'),
        rows: [['Starts', `${k.prefix}…`], ['Made', `${new Date(k.created_at).toLocaleDateString()} by ${k.created_by}`], ['Last used', when(k.last_used_at)]],
        acts: [sup ? null : el('button', { class: 'btn', type: 'button', onclick: () => tokenAction(k, 'rotate') }, 'Rotate'), el('button', { class: 'btn', type: 'button', onclick: () => tokenAction(k, 'revoke') }, 'Revoke')].filter(Boolean),
      }))) : empty('No API tokens', 'A token is shown once when it is made; only its fingerprint is kept here.', true)));
  }
  return E.frag(...blocks);
}
function userActs(u) {
  const me = E.isCustomer() && u.person_id === E.S.me.viewer.personId;
  const post = (path, ok) => (e) => E.act(e.currentTarget, () => api(path, { method: 'POST', body: {} }), ok);
  if (u.status === 'invited' && E.inSupport()) return [];
  if (u.status === 'invited') return [el('button', { class: 'btn', type: 'button', onclick: async (e) => {
    busy(e.currentTarget, true);
    try { const r = await api(`/api/tenant/users/${u.id}/invite`, { method: 'POST', body: {} }); const d = openDialog('New invite link', u.email); d.body.append(inviteResult(r, 'Invite sent again')); }
    catch (err) { toast(friendly(err), 'critical'); } finally { busy(e.currentTarget, false); }
  } }, 'New invite link')];
  if (me) return [];
  return u.status === 'active' ? [el('button', { class: 'btn', type: 'button', onclick: post(`/api/tenant/users/${u.id}/disable`, 'Sign-in turned off') }, 'Turn off')]
    : [el('button', { class: 'btn', type: 'button', onclick: post(`/api/tenant/users/${u.id}/enable`, 'Sign-in turned on') }, 'Turn on')];
}
function inviteSomeone() {
  const S = E.S;
  const name = input({ maxlength: '80' }), email = input({ type: 'email', maxlength: '200' });
  const company = select(S.companies.map((c) => [c.id, c.name]), S.co && S.co.id);
  const boxes = ROLE_LIST.map(([v, t]) => el('label', { class: 'check' }, el('input', { type: 'checkbox', value: v }), el('span', { text: t })));
  formDialog('Invite someone', 'They choose their own password from the emailed link', [
    field('Name', name), field('Email', email), field('Company', company), el('fieldset', { class: 'field roles' }, el('legend', { text: 'Roles' }), ...boxes),
  ], 'Send invite', async () => {
    const roles = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
    const r = await api('/api/tenant/users', { method: 'POST', body: { name: name.value, email: email.value, entityId: company.value, roles } });
    E.render();
    return inviteResult(r, 'Invite ready');
  });
}
function newToken() {
  const name = input({ maxlength: '60', placeholder: 'Catalog app' });
  formDialog('New API token', 'Send it as Authorization: Bearer <token>; it opens only your companies', [field('What uses it', name)], 'Make token', async () => {
    const r = await api('/api/tenant/tokens', { method: 'POST', body: { name: name.value } });
    E.render();
    return E.frag(resultBox('good', 'ok', 'Token made', 'Copy it now: it is shown only this once. Only a fingerprint is kept.'), copyBox(r.token));
  });
}
async function tokenAction(k, what) {
  if (what === 'revoke') {
    const reason = await E.askReason({ title: `Revoke ${k.name}`, lead: 'Anything using it stops working at once.', confirm: 'Revoke', optional: true });
    if (reason === null) return;
    try { await api(`/api/tenant/tokens/${k.id}/revoke`, { method: 'POST', body: {} }); toast('Revoked', 'good'); E.render(); } catch (e) { toast(friendly(e), 'critical'); }
    return;
  }
  try {
    const r = await api(`/api/tenant/tokens/${k.id}/rotate`, { method: 'POST', body: {} });
    const d = openDialog('Rotated', k.name);
    d.body.append(resultBox('good', 'ok', 'New token', 'The old one stopped working. Copy the new one now; it is shown only this once.'), copyBox(r.token));
    E.render();
  } catch (e) { toast(friendly(e), 'critical'); }
}
function changePassword() {
  const cur = input({ type: 'password', autocomplete: 'current-password' }), next = input({ type: 'password', autocomplete: 'new-password' }), again = input({ type: 'password', autocomplete: 'new-password' });
  formDialog('Change password', 'At least 10 characters', [field('Current password', cur), field('New password', next), field('The same again', again)], 'Change it', async () => {
    if (next.value !== again.value) throw new Error('The new passwords do not match.');
    await api('/api/account/password', { method: 'POST', body: { current: cur.value, next: next.value } });
    return resultBox('good', 'ok', 'Password changed', 'Your other sessions have ended; this one carries on.');
  });
}

E.register('operator', 'Operator console', 'server', screenOperator, 'Platform', { module: null });
E.register('account', 'Account', 'user', screenAccount, 'Account', { module: null });
})();
