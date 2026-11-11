// crm screens: Customers (one customer, everything about them), Leads (the
// pipeline), My day (a salesperson's tasks and appointments) and Marketing
// (dashboard, segments, campaigns, coupons). Registers with window.ERP;
// data is placed with textContent only.
(() => {
  'use strict';
  const E = window.ERP;
  if (!E) return;
  const { el, section, coApi, post, register, item, chip, money, ago, dayLabel, empty, head, openDialog, fillDialog,
    resultBox, toast, busy, friendly, tile, tilesRow, go, render, S, tbl, td } = E;

  const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) p.set(k, v); const s = p.toString(); return s ? '?' + s : ''; };
  const field = (label, control, hint, wide) => el('label', { class: 'field' + (wide ? ' wide' : '') }, el('span', { text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null);
  const input = (props) => el('input', Object.assign({ type: 'text' }, props));
  const textarea = (props) => el('textarea', Object.assign({ rows: '3' }, props));
  const select = (options, value, props) => el('select', props || {}, options.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(value ?? '') || null })));
  const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const loadInto = async (box, fn) => {
    box.replaceChildren(E.loadingNode());
    try { box.replaceChildren(...[].concat(await fn())); } catch (e) { box.replaceChildren(E.errorBox(e)); }
  };
  const STAGE = { new: ['neutral', 'New'], contacted: ['neutral', 'Contacted'], appointment: ['warning', 'Appointment'], quoted: ['warning', 'Quoted'], won: ['good', 'Won'], lost: ['critical', 'Lost'] };
  const SOURCE = { walk_in: 'Walk-in', phone: 'Phone', web_form: 'Web form', quote_request: 'Quote request', abandoned_cart: 'Abandoned cart', referral: 'Referral', campaign: 'Campaign', other: 'Other' };
  const KIND = { call: 'Call', text: 'Text', email: 'Email', appointment: 'Appointment', todo: 'To-do' };
  const CONSENT = { opt_in: ['good', 'Yes'], opt_out: ['critical', 'No'], unknown: ['neutral', 'Not asked'] };
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const localInput = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  let LOOK = null;
  const lookups = async () => { if (!LOOK || LOOK.co !== S.co.id) LOOK = Object.assign(await coApi('/crm/lookups'), { co: S.co.id }); return LOOK; };
  E.opener('lead', async (id) => leadDetail(id, await lookups()));
  E.opener('customer', (id) => go('crm', id));
  const doIt = async (btn, fn, ok, after) => {
    busy(btn, true);
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'good'); if (after) await after(r); return r; }
    catch (e) { toast(friendly(e), 'critical'); return null; }
    finally { if (btn.isConnected) busy(btn, false); }
  };
  const picker = (tabs, cur, screen) => field('Section', select(tabs, cur, { 'aria-label': 'Section', onchange: (e) => go(screen, e.target.value) }));

  // ============================================================ customers
  async function screenCustomers(sub) {
    if (sub && /^[0-9a-f-]{36}$/i.test(sub)) return customerPage(sub);
    const box = el('div');
    let q = '';
    const load = () => loadInto(box, async () => {
      const rows = await coApi('/crm/customers' + qs({ q }));
      if (!rows.length) return empty('No customers match', 'Try a name, email, phone, number or tag.', true);
      return el('div', { class: 'panel' }, rows.map((c) => item({
        title: `${c.name} · ${c.number}`, detail: [c.email, c.phone, c.last_purchase ? `last bought ${ago(c.last_purchase)}` : 'no purchases yet'].filter(Boolean).join(' · '),
        badge: c.merged_into ? chip('neutral', 'info', 'Merged') : c.status === 'inactive' ? chip('neutral', 'none', 'Inactive') : (c.tags || []).length ? el('span', {}, c.tags.map((t) => chip('neutral', 'info', t))) : null,
        onClick: () => go('crm', c.merged_into || c.id),
      })));
    });
    load();
    return el('div', {}, head('Customers', [], 'Customers and marketing'),
      section('Find a customer', null, null, field('Search', input({ enterkeyhint: 'search', placeholder: 'Name, email, phone, number or tag', oninput: debounce((e) => { q = e.target.value.trim(); load(); }, 300) })), box));
  }

  async function customerPage(id) {
    const [x, look] = await Promise.all([coApi(`/crm/customers/${id}`), lookups()]);
    const cu = x.customer, pf = x.profile || {};
    const orders = (expect) => E.drillList('customer-orders', 'Every order', { customer: id }, { sub: cu.name, noun: 'order', expect,
      none: 'No orders yet.', note: 'Every channel, newest first. Quotes and cancelled orders are left out.' });
    const acts = [
      el('button', { class: 'btn', type: 'button', onclick: () => go('crm') }, 'All customers'),
      el('button', { class: 'btn', type: 'button', onclick: () => noteDialog({ customerId: id }) }, 'Add note'),
      el('button', { class: 'btn', type: 'button', onclick: () => taskDialog({ customerId: id, title: `Call ${cu.name}` }) }, 'Add task'),
      el('button', { class: 'btn', type: 'button', onclick: () => profileDialog(id, pf) }, 'Edit profile'),
      el('button', { class: 'btn', type: 'button', onclick: () => mergeDialog(cu) }, 'Find duplicates'),
    ];
    const consent = el('div', { class: 'panel' }, x.consent.map((c) => {
      const [tone, word] = CONSENT[c.status];
      const set = (status) => el('button', { class: 'btn', type: 'button', onclick: (e) => doIt(e.currentTarget, () => post('/crm/consent', { customerId: id, channel: c.channel, status, source: 'staff' }),
        'Consent recorded.', () => render()) }, status === 'opt_in' ? 'Record yes' : 'Record no');
      return item({ title: c.channel === 'sms' ? 'Texts' : c.channel === 'call' ? 'Calls' : 'Email', badge: chip(tone, c.status === 'opt_out' ? 'fail' : 'ok', word),
        detail: c.source ? `${c.source}${c.capturedAt ? ', ' + ago(c.capturedAt) : ''}` : 'Never asked', acts: [set(c.status === 'opt_in' ? 'opt_out' : 'opt_in')] });
    }));
    const prefs = [pf.styles && pf.styles.length ? `Style: ${pf.styles.join(', ')}` : null, pf.rooms && pf.rooms.length ? `Rooms: ${pf.rooms.join(', ')}` : null,
      pf.budget_minor ? `Budget about ${money(pf.budget_minor)}` : null, pf.birthday ? `Birthday ${dayLabel(pf.birthday)}` : null,
      pf.preferred_channel ? `Prefers ${pf.preferred_channel === 'sms' ? 'texts' : pf.preferred_channel}` : null].filter(Boolean);
    return el('div', {}, head(cu.name, acts, `Customer ${cu.number}`),
      tilesRow(tile({ label: 'Lifetime sales', value: money(x.lifetimeValueMinor), onClick: () => orders({ minor: x.lifetimeValueMinor }) }),
        tile({ label: 'Orders', value: String(x.orderCount), onClick: () => orders({ count: x.orderCount }) }),
        tile({ label: 'Last purchase', value: x.lastPurchaseAt ? dayLabel(x.lastPurchaseAt.slice(0, 10)) : 'Never', word: true, onClick: () => orders(null) }),
        tile({ label: 'Store credit', value: money(x.storeCreditMinor), tone: x.storeCreditMinor !== '0' ? 'good' : 'neutral',
          onClick: () => E.drillList('store-credit', 'Store credit', { customer: id }, { sub: cu.name, noun: 'entry', plural: 'entries', expect: { minor: x.storeCreditMinor },
            none: 'No store credit issued.', note: 'Credit issued, less credit spent at the register or online.' }) })),
      section('Profile', cu.status === 'inactive' ? 'inactive' : null, null, el('div', { class: 'panel' },
        item({ title: [cu.email, cu.phone].filter(Boolean).join(' · ') || 'No contact details', detail: [cu.home ? `Home store ${cu.home}` : null, `Customer since ${dayLabel(cu.created_at.slice(0, 10))}`].filter(Boolean).join(' · '),
          badge: (pf.tags || []).length ? el('span', {}, pf.tags.map((t) => chip('neutral', 'info', t))) : null, why: prefs.join(' · ') || null }),
        x.household.length || pf.household ? item({ title: `Household: ${pf.household || ''}`, detail: x.household.map((h) => h.name).join(', ') || 'Just them so far' }) : null,
        ...x.relations.map((r) => item({ title: `${r.name} · ${r.number}`, detail: r.relation, onClick: () => go('crm', r.id) })))),
      section('Consent', 'checked every time a campaign sends', null, consent),
      x.openQuotes.length ? section('Open quotes', null, null, el('div', { class: 'panel' }, x.openQuotes.map((qo) => item({ title: qo.number, amount: money(qo.total_minor),
        detail: qo.expires ? `expires ${dayLabel(qo.expires)}` : null })))) : null,
      (x.projects || []).length || x.trade ? section('Room projects', x.trade ? `trade account ${x.trade.number} · ${x.trade.company_name}` : null, null, el('div', { class: 'panel' },
        (x.projects || []).length ? x.projects.map((p) => item({ title: `${p.name} · ${p.number}`, amount: p.budget_minor ? money(p.budget_minor) : null,
          detail: [p.status, p.client_name ? `client ${p.client_name}` : null, `${p.items} item${p.items === 1 ? '' : 's'}`, p.salesperson].filter(Boolean).join(' · '),
          onClick: () => go('projects', 'p:' + p.id) })) : empty('No projects yet', null, true))) : null,
      x.openTasks.length ? section('Open tasks', null, null, el('div', { class: 'panel' }, x.openTasks.map((tk) => item({ title: `${KIND[tk.kind]} · ${tk.title}`, detail: `${tk.assigned} · ${when(tk.due_at)}` })))) : null,
      x.addresses.length ? section('Addresses', null, null, el('div', { class: 'panel' }, x.addresses.map((a) => item({ title: `${a.label}${a.is_default ? ' (default)' : ''}`,
        detail: [a.line1, a.line2, `${a.city}, ${a.state} ${a.postal}`].filter(Boolean).join(', '), why: a.notes || null })))) : null,
      section('Timeline', 'orders, payments, deliveries, service, messages, notes', null, x.timeline.length ? el('div', { class: 'panel' }, x.timeline.slice(0, 60).map((ev) => item({
        title: ev.title, detail: [ev.kind, ev.detail, ago(ev.at)].filter(Boolean).join(' · '), amount: ev.amount ? money(ev.amount) : null }))) : empty('Nothing yet', null, true)));
  }

  function profileDialog(id, pf) {
    const d = openDialog('Edit profile', 'Tags and preferences help segments and salespeople');
    const f = { tags: input({ value: (pf.tags || []).join(', '), placeholder: 'vip, designer' }), styles: input({ value: (pf.styles || []).join(', '), placeholder: 'modern, farmhouse' }),
      rooms: input({ value: (pf.rooms || []).join(', '), placeholder: 'living room, bedroom' }), budget: input({ inputmode: 'decimal', value: pf.budget_minor ? (Number(pf.budget_minor) / 100).toFixed(0) : '' }),
      birthday: input({ type: 'date', value: pf.birthday || '' }), pref: select([['', 'No preference'], ['email', 'Email'], ['sms', 'Text'], ['call', 'Call']], pf.preferred_channel) };
    const save = el('button', { class: 'btn primary', type: 'button', onclick: (e) => doIt(e.currentTarget, () => post(`/crm/customers/${id}/profile`, {
      tags: f.tags.value, styles: f.styles.value, rooms: f.rooms.value, budgetMinor: f.budget.value ? Math.round(Number(f.budget.value) * 100) : null, birthday: f.birthday.value, preferredChannel: f.pref.value,
    }), 'Profile saved.', () => { d.close(); render(); }) }, 'Save');
    d.body.append(el('div', { class: 'form-grid' }, field('Tags', f.tags, 'Comma separated', true), field('Styles', f.styles), field('Rooms', f.rooms), field('Budget ($)', f.budget),
      field('Birthday', f.birthday), field('Prefers', f.pref)), el('div', { class: 'dlg-acts' }, save));
  }

  function noteDialog(target) {
    const d = openDialog('Add a note', null);
    const ta = textarea({ maxlength: '2000' });
    d.body.append(field('Note', ta), el('div', { class: 'dlg-acts' }, el('button', { class: 'btn primary', type: 'button',
      onclick: (e) => doIt(e.currentTarget, () => post('/crm/notes', Object.assign({ body: ta.value }, target)), 'Note added.', () => { d.close(); render(); }) }, 'Add note')));
    ta.focus();
  }

  function mergeDialog(cu) {
    const d = openDialog(`Duplicates of ${cu.name}`, 'Same email, phone or name. Merging moves every order, payment and address to the record you keep.', { wide: true });
    fillDialog(d, async () => {
      const rows = await coApi(`/crm/customers/${cu.id}/duplicates`);
      if (!rows.length) return empty('No likely duplicates', null, true);
      return el('div', { class: 'panel' }, rows.map((x) => item({ title: `${x.name} · ${x.number}`, detail: [x.email, x.phone].filter(Boolean).join(' · '), badge: chip('warning', 'warn', x.why),
        acts: [el('button', { class: 'btn', type: 'button', onclick: async (e) => {
          const why = await E.askReason({ title: `Merge ${x.name} into ${cu.name}?`, lead: `${x.name} (${x.number}) becomes inactive and everything on it moves to ${cu.name} (${cu.number}). This cannot be undone here.`,
            label: 'Why are they the same person?', confirm: 'Merge' });
          if (!why) return;
          await doIt(e.currentTarget, () => post('/crm/merge', { survivorId: cu.id, mergedId: x.id, reason: why }), (r) => `Merged. Moved ${Object.values(r.moved).reduce((a, b) => a + b, 0)} records.`, () => { d.close(); render(); });
        } }, 'Merge into this one')] })));
    });
  }

  // ================================================================ leads
  async function screenLeads(sub) {
    const look = await lookups();
    const tab = ['open', 'mine', 'won', 'lost', 'rules'].includes(sub) ? sub : 'open';
    const body = el('div');
    const nodes = [head('Leads', [el('button', { class: 'btn primary', type: 'button', onclick: () => leadDialog(look) }, 'New lead'),
      el('button', { class: 'btn', type: 'button', onclick: (e) => doIt(e.currentTarget, () => post('/crm/leads/capture-carts'), (r) => r.added ? `${r.added} abandoned cart${r.added === 1 ? '' : 's'} added as leads.` : 'No new abandoned carts.', () => render()) }, 'Pull in abandoned carts')],
      'Customers and marketing'),
      picker([['open', 'Open pipeline'], ['mine', 'Mine'], ['won', 'Won'], ['lost', 'Lost'], ['rules', 'Assignment rules']], tab, 'leads'), body];
    if (tab === 'rules') { body.append(await rulesTab(look)); return el('div', {}, nodes); }
    const box = el('div');
    let stage = tab === 'won' || tab === 'lost' ? tab : '', q = '', store = '';
    const load = () => loadInto(box, async () => {
      let rows = await coApi('/crm/leads' + qs({ stage, q, location: store, mine: tab === 'mine' ? '1' : '' }));
      if (tab === 'open' || tab === 'mine') rows = rows.filter((l) => !['won', 'lost'].includes(l.stage) || stage);
      if (!rows.length) return empty('No leads here', tab === 'mine' ? 'Leads assigned to you show here.' : null, true);
      return el('div', { class: 'panel' }, rows.map((l) => item({
        title: `${l.name} · ${l.number}`, amount: Number(l.estimate_minor) ? money(l.estimate_minor) : null,
        badge: el('span', {}, chip(STAGE[l.stage][0], l.stage === 'won' ? 'ok' : l.stage === 'lost' ? 'fail' : 'clock', STAGE[l.stage][1]), ' ', chip('neutral', 'info', SOURCE[l.source] || l.source)),
        detail: [l.interest, l.assigned || 'Unassigned', l.store, l.next_follow_up_at ? `next ${when(l.next_follow_up_at)}` : null, l.lost_reason].filter(Boolean).join(' · '),
        why: l.duplicate_of ? `Might be ${l.duplicate_name}, an existing customer — check before converting.` : null,
        onClick: () => leadDetail(l.id, look),
      })));
    });
    const filters = el('div', { class: 'form-grid' },
      tab === 'open' || tab === 'mine' ? field('Stage', select([['', 'Every open stage'], ...look.stages.filter((s) => !['won', 'lost'].includes(s)).map((s) => [s, STAGE[s][1]])], '', { onchange: (e) => { stage = e.target.value; load(); } })) : null,
      field('Store', E.storePicker(select([['', 'Every store'], ...look.stores.map((s) => [s.id, s.name])], '', { onchange: (e) => { store = e.target.value; load(); } }))),
      field('Search', input({ enterkeyhint: 'search', placeholder: 'Name, phone, email, interest', oninput: debounce((e) => { q = e.target.value.trim(); load(); }, 300) }), null, true));
    load();
    body.append(section(tab === 'won' ? 'Won' : tab === 'lost' ? 'Lost' : tab === 'mine' ? 'My leads' : 'Open pipeline', null, null, filters, box));
    return el('div', {}, nodes);
  }

  function leadDialog(look) {
    const d = openDialog('New lead', 'Walk-in, phone call, referral…');
    const f = { source: select(look.sources.map((s) => [s, SOURCE[s]]), 'walk_in'), name: input({ maxlength: '80' }), phone: input({ type: 'tel', maxlength: '20' }),
      email: input({ type: 'email', maxlength: '120' }), interest: textarea({ maxlength: '500', placeholder: 'What are they shopping for?' }),
      store: E.storePicker(select([['', 'No store'], ...look.stores.map((s) => [s.id, s.name])], '')), assign: select([['', 'Next in the rotation'], ...look.people.map((p) => [p.id, p.name])], ''),
      estimate: input({ inputmode: 'decimal', placeholder: 'e.g. 2500' }), campaign: select([['', 'None'], ...look.campaigns.map((k) => [k.id, k.name])], ''),
      cEmail: el('input', { type: 'checkbox' }), cSms: el('input', { type: 'checkbox' }) };
    const err = el('div');
    d.body.append(el('div', { class: 'form-grid' }, field('Source', f.source), field('Store', f.store), field('Name', f.name, null, true), field('Mobile', f.phone), field('Email', f.email),
      field('Looking for', f.interest, null, true), field('Budget / estimate ($)', f.estimate), field('Salesperson', f.assign), field('Campaign', f.campaign),
      el('div', { class: 'wide' }, el('label', { class: 'check' }, f.cEmail, el('span', { text: 'They agreed to marketing email' })),
        el('label', { class: 'check' }, f.cSms, el('span', { text: 'They agreed in writing to marketing texts' })))), err,
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
        err.replaceChildren();
        const r = await doIt(e.currentTarget, () => post('/crm/leads', { source: f.source.value, name: f.name.value, phone: f.phone.value, email: f.email.value, interest: f.interest.value,
          locationId: f.store.value || null, assignedTo: f.assign.value || null, estimate: f.estimate.value || null, campaignId: f.campaign.value || null,
          consentEmail: f.cEmail.checked, consentSms: f.cSms.checked }), (r) => `Lead ${r.number} added.`);
        if (r) { d.close(); if (r.matches && r.matches.length) toast(`Matches existing customer ${r.matches[0].name} (${r.matches[0].why}).`, 'warning'); render(); }
      } }, 'Add lead')));
    f.name.focus();
  }

  function leadDetail(id, look) {
    const d = openDialog('Lead', null, { wide: true });
    const reload = () => fillDialog(d, async () => {
      const x = await coApi(`/crm/leads/${id}`);
      const l = x.lead;
      const closed = ['won', 'lost'].includes(l.stage);
      const stageSel = select(look.stages.map((s) => [s, STAGE[s][1]]), l.stage);
      const lost = select([['', 'Why lost?'], ...look.lostReasons.map((r) => [r, r])], '');
      const follow = input({ type: 'datetime-local' });
      const move = el('button', { class: 'btn', type: 'button', onclick: (e) => doIt(e.currentTarget, () => post(`/crm/leads/${id}/stage`, { stage: stageSel.value, lostReason: lost.value,
        followUpAt: follow.value ? new Date(follow.value).toISOString() : null }), 'Lead moved.', () => { reload(); render(); }) }, 'Update');
      const assign = select(look.people.map((p) => [p.id, p.name]), l.assigned_to);
      const convertBtn = el('button', { class: 'btn primary', type: 'button', onclick: (e) => doIt(e.currentTarget, () => post(`/crm/leads/${id}/convert`, {}),
        (r) => r.quote ? `Customer ready; quote ${r.quote.number} is on the register as a draft.` : 'Customer ready. Add what they want to make a quote.', () => { reload(); render(); }) },
        x.items.length ? 'Make customer + quote' : 'Make customer');
      const orderNo = input({ placeholder: 'SO-000123' });
      return el('div', {},
        el('p', { class: 'lead', text: `${l.number} · ${SOURCE[l.source] || l.source}${l.utm_campaign ? ` · campaign ${l.utm_campaign}` : ''}${l.campaign ? ` · ${l.campaign}` : ''}` }),
        tilesRow(tile({ label: 'Stage', value: STAGE[l.stage][1], word: true, tone: STAGE[l.stage][0] }), tile({ label: 'Estimate', value: money(l.estimate_minor) }),
          tile({ label: 'Next follow-up', value: l.next_follow_up_at ? when(l.next_follow_up_at) : 'None', word: true })),
        el('div', { class: 'panel' }, item({ title: l.name, detail: [l.phone, l.email, l.store, l.assigned ? `with ${l.assigned}` : 'Unassigned'].filter(Boolean).join(' · '), why: l.interest || null }),
          x.items.map((it) => item({ title: `${it.qty} × ${it.name}`, detail: 'on the lead for the quote' })),
          l.order_number ? item({ title: `Order ${l.order_number}`, detail: 'linked; the lead is won when it is paid or delivered' }) : null),
        x.matches.length && !l.customer_id ? resultBox('warning', 'warn', 'Possible existing customer', x.matches.map((m) => `${m.name} (${m.number}, ${m.why})`).join('; ')) : null,
        closed ? null : section('Move it along', null, null, el('div', { class: 'form-grid' }, field('Stage', stageSel), field('Lost reason', lost), field('Follow up on', follow), el('div', { class: 'wide dlg-acts' }, move))),
        closed ? null : section('Owner', null, null, el('div', { class: 'form-grid' }, field('Salesperson', assign), el('div', { class: 'dlg-acts' },
          el('button', { class: 'btn', type: 'button', onclick: (e) => doIt(e.currentTarget, () => post(`/crm/leads/${id}/assign`, { assignedTo: assign.value }), 'Reassigned.', () => reload()) }, 'Reassign')))),
        closed ? null : el('div', { class: 'dlg-acts' }, convertBtn,
          el('button', { class: 'btn', type: 'button', onclick: () => taskDialog({ leadId: id, customerId: l.customer_id, title: `Design consultation: ${l.name}`, kind: 'appointment' }, look) }, 'Book consultation'),
          el('button', { class: 'btn', type: 'button', onclick: () => taskDialog({ leadId: id, customerId: l.customer_id, title: `Follow up: ${l.name}` }, look) }, 'Add task'),
          el('button', { class: 'btn', type: 'button', onclick: () => noteDialog({ leadId: id, customerId: l.customer_id }) }, 'Add note')),
        closed || l.order_number ? null : section('Link an order', 'won when it is paid or delivered', null, el('div', { class: 'form-grid' }, field('Order number', orderNo),
          el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: (e) => doIt(e.currentTarget, () => post(`/crm/leads/${id}/link`, { orderNumber: orderNo.value }), 'Order linked.', () => { reload(); render(); }) }, 'Link')))),
        l.customer_id ? el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: () => { d.close(); go('crm', l.customer_id); } }, 'Open customer')) : null,
        section('Tasks', null, null, x.tasks.length ? el('div', { class: 'panel' }, x.tasks.map((tk) => item({ title: `${KIND[tk.kind]} · ${tk.title}`,
          detail: [when(tk.due_at), tk.done_at ? 'done' : tk.cancelled_at ? 'cancelled' : 'open', tk.auto ? 'automatic follow-up' : null].filter(Boolean).join(' · ') }))) : empty('No tasks', null, true)),
        section('History', null, null, el('div', { class: 'panel' }, [...x.notes.map((n) => item({ title: n.body, detail: `${n.by_name || 'someone'} · ${ago(n.created_at)}` })),
          ...x.events.slice().reverse().map((ev) => item({ title: ev.kind === 'assigned' ? `Assigned to ${ev.assignee || 'someone'}` : `${ev.kind}: ${ev.detail || ''}`, detail: [ev.by_name, ago(ev.at)].filter(Boolean).join(' · ') }))])));
    });
    reload();
  }

  async function rulesTab(look) {
    const rows = await coApi('/crm/rules');
    const add = () => {
      const d = openDialog('Round-robin rule', 'New leads that match go to the next person in turn');
      const name = input({ maxlength: '80' }), store = E.storePicker(select([['', 'Any store'], ...look.stores.map((s) => [s.id, s.name])], '')),
        src = select([['', 'Any source'], ...look.sources.map((s) => [s, SOURCE[s]])], '');
      const boxes = look.people.map((p) => el('label', { class: 'check' }, el('input', { type: 'checkbox', value: p.id }), el('span', { text: p.name })));
      d.body.append(el('div', { class: 'form-grid' }, field('Name', name, null, true), field('Store', store), field('Source', src),
        el('div', { class: 'field wide' }, el('span', { text: 'In the rotation' }), el('div', { class: 'checks' }, boxes))),
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn primary', type: 'button', onclick: (e) => doIt(e.currentTarget, () => post('/crm/rules', { name: name.value,
        locationId: store.value || null, source: src.value || null, members: boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value) }), 'Rule saved.', () => { d.close(); render(); }) }, 'Save rule')));
    };
    return section('Assignment rules', 'the most specific match wins', [el('button', { class: 'btn', type: 'button', onclick: add }, 'Add rule')],
      rows.length ? el('div', { class: 'panel' }, rows.map((r) => item({ title: r.name, badge: chip(r.active ? 'good' : 'neutral', r.active ? 'ok' : 'none', r.active ? 'On' : 'Off'),
        detail: [r.store || 'Any store', r.source ? SOURCE[r.source] : 'any source', `next: ${(r.member_names || [])[r.next_index % Math.max(1, (r.member_names || []).length)] || '—'}`].join(' · '),
        why: (r.member_names || []).join(' → ') }))) : empty('No rules', 'Without a rule, new leads wait unassigned for a manager.', true));
  }

  // ================================================================ my day
  function taskDialog(pre, lookIn) {
    const d = openDialog(pre.kind === 'appointment' ? 'Book a design consultation' : 'Add a task', null);
    fillDialog(d, async () => {
      const look = lookIn || await lookups();
      const start = new Date(Date.now() + (pre.kind === 'appointment' ? 86400_000 : 3600_000)); start.setMinutes(0, 0, 0);
      const f = { kind: select(Object.entries(KIND), pre.kind || 'call'), title: input({ value: pre.title || '', maxlength: '140' }), due: input({ type: 'datetime-local', value: localInput(start) }),
        mins: select([['30', '30 min'], ['60', '1 hour'], ['90', '90 min'], ['120', '2 hours']], '60'), store: E.storePicker(select(look.stores.map((s) => [s.id, s.name]), '')),
        who: select(look.people.map((p) => [p.id, p.name]), S.person && S.person.id), notes: textarea({ maxlength: '1000' }) };
      const apptOnly = [field('Length', f.mins), field('Showroom', f.store)];
      const sync = () => { for (const n of apptOnly) n.hidden = f.kind.value !== 'appointment'; };
      f.kind.addEventListener('change', sync);
      const save = el('button', { class: 'btn primary', type: 'button', onclick: (e) => {
        const due = new Date(f.due.value);
        return doIt(e.currentTarget, () => post('/crm/tasks', { kind: f.kind.value, title: f.title.value, dueAt: due.toISOString(), assignedTo: f.who.value,
          endsAt: f.kind.value === 'appointment' ? new Date(due.getTime() + Number(f.mins.value) * 60000).toISOString() : null, locationId: f.kind.value === 'appointment' ? f.store.value : null,
          leadId: pre.leadId || null, customerId: pre.customerId || null, notes: f.notes.value }), 'Saved.', () => { d.close(); render(); });
      } }, 'Save');
      const n = el('div', {}, el('div', { class: 'form-grid' }, field('Kind', f.kind), field('For', f.who), field('What', f.title, null, true), field('When', f.due), ...apptOnly,
        field('Notes', f.notes, null, true)), el('div', { class: 'dlg-acts' }, save));
      sync();
      return n;
    });
  }

  async function screenMyDay(sub) {
    if (!S.person && !sub) return el('div', {}, head('My day', [], 'Customers and marketing'), empty('Pick who you are', 'Choose a person at the top to see their day.', true));
    const look = await lookups();
    const whoId = sub && /^[0-9a-f-]{36}$/i.test(sub) ? sub : S.person.id;
    const whoName = (look.people.find((p) => p.id === whoId) || S.person || {}).name || '';
    const x = await coApi('/crm/my-day' + qs({ person: whoId }));
    const done = (tk, cancel) => async (e) => {
      const outcome = cancel ? 'not needed' : tk.kind === 'appointment' ? 'met' : 'done';
      await doIt(e.currentTarget, () => post(`/crm/tasks/${tk.id}/${cancel ? 'cancel' : 'done'}`, { outcome }), cancel ? 'Task dropped.' : 'Done.', () => render());
    };
    const groups = { Overdue: [], Today: [], 'Coming up': [] };
    const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
    for (const tk of x.tasks) (tk.overdue ? groups.Overdue : new Date(tk.due_at) <= endOfDay ? groups.Today : groups['Coming up']).push(tk);
    const row = (tk) => {
      const phone = tk.customer_phone || tk.lead_phone, email = tk.lead_email;
      const acts = [el('button', { class: 'btn primary', type: 'button', onclick: done(tk) }, 'Done'), el('button', { class: 'btn', type: 'button', onclick: done(tk, true) }, 'Drop')];
      if (phone) acts.unshift(el('a', { class: 'btn', href: `tel:${String(phone).replace(/[^0-9+]/g, '')}` }, 'Call'), el('a', { class: 'btn', href: `sms:${String(phone).replace(/[^0-9+]/g, '')}` }, 'Text'));
      else if (email) acts.unshift(el('a', { class: 'btn', href: `mailto:${email}` }, 'Email'));
      return item({ title: `${KIND[tk.kind]} · ${tk.title}`, badge: tk.overdue ? chip('critical', 'warn', 'Overdue') : tk.kind === 'appointment' ? chip('warning', 'clock', tk.store || 'Showroom') : null,
        detail: [when(tk.due_at), tk.customer || tk.lead_name, tk.lead_number, tk.auto ? 'automatic follow-up' : null].filter(Boolean).join(' · '), why: tk.notes || null, acts,
        onClick: tk.lead_id ? () => leadDetail(tk.lead_id, LOOK) : tk.customer_id ? () => go('crm', tk.customer_id) : null });
    };
    const whose = field('Whose day', select(look.people.map((p) => [p.id, p.name]).concat(look.people.some((p) => S.person && p.id === S.person.id) || !S.person ? [] : [[S.person.id, S.person.name]]), whoId,
      { onchange: (e) => go('myday', e.target.value) }));
    return el('div', {}, head('My day', [el('button', { class: 'btn primary', type: 'button', onclick: () => taskDialog({}) }, 'Add task'),
      el('button', { class: 'btn', type: 'button', onclick: () => taskDialog({ kind: 'appointment', title: 'Design consultation' }) }, 'Book consultation')], whoName),
      whose,
      tilesRow(tile({ label: 'Overdue', value: String(groups.Overdue.length), tone: groups.Overdue.length ? 'critical' : 'good',
          onClick: () => E.drillItems('Overdue', groups.Overdue.map(row), { noun: 'task', expect: { count: x.overdue }, sub: whoName, none: 'Nothing overdue.' }) }),
        tile({ label: 'Due today', value: String(groups.Today.length),
          onClick: () => E.drillItems('Due today', groups.Today.map(row), { noun: 'task', sub: whoName, none: 'Nothing else due today.' }) }),
        tile({ label: 'Open leads', value: String(x.openLeads),
          onClick: () => E.drillList('crm-leads', 'Open leads', { show: 'open', person: whoId }, { noun: 'lead', sub: whoName, expect: { count: x.openLeads }, none: 'No open leads.' }) })),
      ...Object.entries(groups).map(([g, list]) => section(g, list.length ? String(list.length) : null, null, list.length ? el('div', { class: 'panel' }, list.map(row)) : empty(g === 'Overdue' ? 'Nothing overdue' : 'Nothing here', null, true))));
  }

  // ============================================================= marketing
  async function screenMarketing(sub) {
    const tab = ['dashboard', 'segments', 'campaigns', 'coupons'].includes(sub) ? sub : 'dashboard';
    const look = await lookups();
    const body = el('div');
    body.append(await ({ dashboard: dashTab, segments: segmentsTab, campaigns: campaignsTab, coupons: couponsTab })[tab](look));
    return el('div', {}, head('Marketing', [], 'Customers and marketing'),
      picker([['dashboard', 'Dashboard'], ['segments', 'Segments'], ['campaigns', 'Campaigns'], ['coupons', 'Coupons']], tab, 'marketing'), body);
  }

  async function dashTab() {
    const x = await coApi('/crm/dashboard');
    const by = Object.fromEntries(x.pipeline.map((p) => [p.stage, p]));
    const stageRows = ['new', 'contacted', 'appointment', 'quoted', 'won', 'lost'].map((s) => el('tr', {}, td(STAGE[s][1]), td(String(by[s] ? by[s].n : 0), 'm'), td(money(by[s] ? by[s].value : 0), 'm')));
    return el('div', {},
      tilesRow(tile({ label: `Leads, last ${x.days} days`, value: String(x.leads),
          onClick: () => E.drillList('crm-leads', `Leads, last ${x.days} days`, { show: 'window', days: x.days }, { noun: 'lead', expect: { count: x.leads } }) }),
        tile({ label: 'Conversion (won ÷ closed)', value: x.conversionBps == null ? '—' : `${(x.conversionBps / 100).toFixed(0)}%`, tone: x.conversionBps >= 3000 ? 'good' : 'neutral',
          onClick: () => E.drillList('crm-leads', 'Leads closed', { show: 'closed', days: x.days }, { noun: 'lead', expect: { count: x.won + x.lost },
            note: `${x.won} won of ${x.won + x.lost} closed, from leads that came in over the last ${x.days} days.` }) }),
        tile({ label: 'Average first response', value: x.responseMinutes == null ? '—' : x.responseMinutes < 120 ? `${x.responseMinutes} min` : `${(x.responseMinutes / 60).toFixed(1)} h`, tone: x.responseMinutes != null && x.responseMinutes <= 60 ? 'good' : 'warning' ,
          onClick: () => E.drillList('crm-leads', 'Leads answered', { show: 'responded', days: x.days }, { noun: 'lead',
            note: 'Leads from the period that had a first answer; each shows how long it took. The tile is their average.' }) }),
        tile({ label: 'Overdue follow-ups', value: String(x.overdue.reduce((a, o) => a + o.n, 0)), tone: x.overdue.length ? 'critical' : 'good',
          onClick: () => E.drillList('crm-overdue', 'Overdue follow-ups', {}, { noun: 'task', expect: { count: x.overdue.reduce((a, o) => a + o.n, 0) }, none: 'Nothing overdue.',
            note: x.overdue.map((o) => `${o.name} ${o.n}`).join(' · ') || null }) })),
      section('Pipeline by stage', null, null, tbl([['Stage'], ['Leads', 'm'], ['Value', 'm']], stageRows)),
      section('By salesperson', null, null, x.bySales.length ? tbl([['Who'], ['Open', 'm'], ['Won', 'm'], ['Lost', 'm'], ['Reply', 'm']],
        x.bySales.map((r) => el('tr', {}, td(r.who), td(String(r.open), 'm'), td(String(r.won), 'm'), td(String(r.lost), 'm'), td(r.response_min == null ? '—' : r.response_min < 120 ? `${r.response_min} min` : `${(r.response_min / 60).toFixed(1)} h`, 'm')))) : empty('No leads yet', null, true)),
      section('By store', null, null, tbl([['Store'], ['Open', 'm'], ['Won', 'm'], ['Lost', 'm']], x.byStore.map((r) => el('tr', {}, td(r.store), td(String(r.open), 'm'), td(String(r.won), 'm'), td(String(r.lost), 'm'))))),
      section('By source', `last ${x.days} days`, null, tbl([['Source'], ['Leads', 'm'], ['Won', 'm']], x.bySource.map((r) => el('tr', {}, td(SOURCE[r.source] || r.source), td(String(r.n), 'm'), td(String(r.won), 'm'))))),
      section('Campaign return', null, null, x.campaigns.length ? el('div', { class: 'panel' }, x.campaigns.map(campaignItem)) : empty('No campaigns yet', null, true)),
      section('Customers by segment', null, null, el('div', { class: 'panel' }, x.segments.map((s) => item({ title: s.name, amount: `${s.count}`, onClick: () => go('marketing', 'segments') })))));
  }

  const roi = (k) => { const cost = Number(k.cost_minor), rev = Number(k.revenue_minor); return cost ? `${(rev / cost).toFixed(1)}× return` : null; };
  const campaignItem = (k) => item({ title: `${k.name} · ${k.channel === 'sms' ? 'Text' : 'Email'}`, amount: money(k.revenue_minor),
    badge: chip(k.status === 'sent' ? 'good' : k.status === 'scheduled' ? 'warning' : 'neutral', k.status === 'sent' ? 'ok' : 'clock', k.status),
    detail: [`${k.sent} sent`, k.delivered ? `${k.delivered} delivered` : null, k.opened ? `${k.opened} opened` : null, `${k.suppressed} held back (no consent)`,
      k.queued ? `${k.queued} waiting` : null, `${k.redeemed} redeemed`, k.segment ? `to ${k.segment}` : null, roi(k)].filter(Boolean).join(' · ') });

  async function segmentsTab(look) {
    const rows = await coApi('/crm/segments');
    const build = () => {
      const d = openDialog('New segment', 'A saved filter. Consent is checked when a campaign sends, not here.', { wide: true });
      const f = { name: input({ maxlength: '80' }), cat: select([['', 'Any'], ...look.categories.map((c) => [c, c])], ''), sub: input({ placeholder: 'e.g. Sofas' }),
        min: input({ inputmode: 'numeric', placeholder: '6' }), max: input({ inputmode: 'numeric', placeholder: '18' }), plan: el('input', { type: 'checkbox' }),
        store: E.storePicker(select([['', 'Any store'], ...look.stores.map((s) => [s.id, s.name])], '')), spend: input({ inputmode: 'decimal', placeholder: '1000' }),
        lapsed: input({ inputmode: 'numeric', placeholder: '12' }), bday: select([['', 'Any'], ['0', 'This month'], ...['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => [String(i + 1), m])], ''),
        cart: el('input', { type: 'checkbox' }), tag: input({ placeholder: 'vip' }) };
      const filter = () => ({ boughtCategory: f.cat.value, boughtSubcategory: f.sub.value, monthsAgoMin: f.min.value, monthsAgoMax: f.max.value, hasProtectionPlan: f.plan.checked,
        locationId: f.store.value, minSpendMinor: f.spend.value ? String(Math.round(Number(f.spend.value) * 100)) : '', lapsedMonths: f.lapsed.value, birthdayMonth: f.bday.value, abandonedCart: f.cart.checked, tag: f.tag.value });
      const out = el('div');
      const preview = debounce(async () => { try { const r = await post('/crm/segments/preview', { filter: filter() }); out.replaceChildren(resultBox('neutral', 'info', `${r.count} customers`, r.sample.slice(0, 8).map((x) => x.name).join(', '))); } catch (e) { out.replaceChildren(resultBox('warning', 'warn', 'Check the filter', friendly(e))); } }, 350);
      for (const k of Object.values(f)) { k.addEventListener('input', preview); k.addEventListener('change', preview); }
      d.body.append(el('div', { class: 'form-grid' }, field('Name', f.name, null, true), field('Bought from department', f.cat), field('Bought type', f.sub),
        field('Bought at least … months ago', f.min), field('…and at most … months ago', f.max), field('Store', f.store), field('Spent at least ($)', f.spend),
        field('No purchase in the last … months', f.lapsed), field('Birthday month', f.bday), field('Tag', f.tag),
        el('div', { class: 'wide' }, el('label', { class: 'check' }, f.plan, el('span', { text: 'Has a protection plan' })), el('label', { class: 'check' }, f.cart, el('span', { text: 'Has an abandoned web cart' })))),
      out, el('div', { class: 'dlg-acts' }, el('button', { class: 'btn primary', type: 'button', onclick: (e) => doIt(e.currentTarget, () => post('/crm/segments', { name: f.name.value, filter: filter() }), 'Segment saved.', () => { d.close(); render(); }) }, 'Save segment')));
      preview();
    };
    return section('Segments', null, [el('button', { class: 'btn primary', type: 'button', onclick: build }, 'New segment')],
      el('div', { class: 'panel' }, rows.map((s) => item({ title: s.name, amount: `${s.count} customers`, detail: describe(s.filter, look) }))));
  }
  function describe(f, look) {
    const parts = [];
    if (f.boughtCategory || f.boughtSubcategory) parts.push(`bought ${[f.boughtSubcategory, f.boughtCategory].filter(Boolean).join(' / ')}`);
    if (f.monthsAgoMin != null || f.monthsAgoMax != null) parts.push(`${f.monthsAgoMin ?? 0}–${f.monthsAgoMax ?? '∞'} months ago`);
    if (f.hasProtectionPlan) parts.push('has a protection plan');
    if (f.locationId) parts.push(`store ${(look.stores.find((s) => s.id === f.locationId) || {}).name || ''}`);
    if (f.minSpendMinor) parts.push(`spent ${money(f.minSpendMinor)}+`);
    if (f.lapsedMonths) parts.push(`nothing in ${f.lapsedMonths} months`);
    if (f.birthdayMonth != null) parts.push(f.birthdayMonth === 0 ? 'birthday this month' : `birthday in month ${f.birthdayMonth}`);
    if (f.abandonedCart) parts.push('abandoned a web cart');
    if (f.tag) parts.push(`tagged ${f.tag}`);
    return parts.join(' · ') || 'Every active customer';
  }

  async function campaignsTab(look) {
    const [rows, segs] = await Promise.all([coApi('/crm/campaigns'), coApi('/crm/segments')]);
    const write = () => {
      const d = openDialog('New campaign', 'Merge fields: {{first_name}} {{name}} {{store}} {{coupon}}. The unsubscribe link and STOP wording are added for you.', { wide: true });
      const f = { name: input({ maxlength: '80' }), channel: select([['email', 'Email'], ['sms', 'Text']], 'email'), seg: select(segs.map((s) => [s.id, `${s.name} (${s.count})`]), ''),
        subject: input({ maxlength: '150' }), body: textarea({ rows: '6', maxlength: '4000' }), cost: input({ inputmode: 'decimal', placeholder: '0' }), when: input({ type: 'datetime-local' }) };
      const subj = field('Subject', f.subject, null, true);
      f.channel.addEventListener('change', () => { subj.hidden = f.channel.value !== 'email'; });
      d.body.append(el('div', { class: 'form-grid' }, field('Name', f.name, null, true), field('Channel', f.channel), field('Send to', f.seg), subj, field('Message', f.body, null, true),
        field('Cost ($)', f.cost, 'For return on spend'), field('Send at', f.when, 'Blank: when you press Send')),
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn primary', type: 'button', onclick: (e) => doIt(e.currentTarget, () => post('/crm/campaigns', { name: f.name.value, channel: f.channel.value,
        segmentId: f.seg.value, subject: f.subject.value, body: f.body.value, cost: f.cost.value || null, scheduledAt: f.when.value ? new Date(f.when.value).toISOString() : null }), 'Campaign saved as a draft.', () => { d.close(); render(); }) }, 'Save draft')));
    };
    const runDue = el('button', { class: 'btn', type: 'button', onclick: (e) => doIt(e.currentTarget, () => post('/crm/queue/run'), (r) => `${r.sent} sent, ${r.stopped} stopped by consent.`, () => render()) }, 'Send what is due');
    return section('Campaigns', 'messages are recorded, not sent, until a provider is connected', [el('button', { class: 'btn primary', type: 'button', onclick: write }, 'New campaign'), runDue],
      rows.length ? el('div', { class: 'panel' }, rows.map((k) => {
        const it = campaignItem(k);
        if (k.status === 'draft') it.querySelector('.t').after(el('div', { class: 'acts' }, el('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
          e.stopPropagation();
          if (!confirm(`Send "${k.name}" now? Consent is checked for every person.`)) return;
          await doIt(e.currentTarget, () => post(`/crm/campaigns/${k.id}/launch`), (r) => `${r.queued} queued, ${r.suppressed} held back for consent; ${r.sent} sent.`, () => render());
        } }, 'Send')));
        it.addEventListener('click', () => openCampaign(k));
        it.classList.add('click');
        return it;
      })) : empty('No campaigns yet', null, true));
  }
  function openCampaign(k) {
    const d = openDialog(k.name, k.channel === 'sms' ? 'Text campaign' : 'Email campaign', { wide: true });
    fillDialog(d, async () => {
      const x = await coApi(`/crm/campaigns/${k.id}`);
      return el('div', {}, x.campaign.subject ? el('p', { class: 'lead', text: x.campaign.subject }) : null, el('div', { class: 'note' }, el('span', { text: x.campaign.body })),
        section('Recipients', `${x.messages.length}`, null, x.messages.length ? el('div', { class: 'panel' }, x.messages.map((m) => item({ title: m.name || m.to_ref,
          badge: chip(m.status === 'suppressed' ? 'warning' : m.status === 'queued' ? 'neutral' : 'good', m.status === 'suppressed' ? 'warn' : 'ok', m.status),
          detail: [m.to_ref, m.reason, m.status === 'queued' ? `goes ${when(m.send_after)}` : m.sent_at ? `sent ${ago(m.sent_at)}` : null].filter(Boolean).join(' · ') }))) : empty('Not sent yet', null, true)));
    });
  }

  async function couponsTab(look) {
    const rows = await coApi('/crm/coupons');
    const make = () => {
      const d = openDialog('New coupon', 'Works at the register and on the web store, once per order');
      const today = E.isoDay(new Date()), later = E.isoDay(new Date(Date.now() + 30 * 86400_000));   // local days, not UTC's
      const f = { code: input({ maxlength: '24', class: 'upper', placeholder: 'SPRING15' }), kind: select([['percent', 'Percent off'], ['amount', 'Amount off']], 'percent'),
        pct: input({ inputmode: 'decimal', placeholder: '10' }), amt: input({ inputmode: 'decimal', placeholder: '25' }), min: input({ inputmode: 'decimal', placeholder: '0' }),
        starts: input({ type: 'date', value: today }), ends: input({ type: 'date', value: later }), uses: input({ inputmode: 'numeric', placeholder: 'No limit' }),
        camp: select([['', 'No campaign'], ...look.campaigns.map((k) => [k.id, k.name])], ''), once: el('input', { type: 'checkbox', checked: true }),
        pos: el('input', { type: 'checkbox', checked: true }), web: el('input', { type: 'checkbox', checked: true }) };
      const pctF = field('Percent off', f.pct), amtF = field('Amount off ($)', f.amt);
      const sync = () => { pctF.hidden = f.kind.value !== 'percent'; amtF.hidden = f.kind.value !== 'amount'; };
      f.kind.addEventListener('change', sync); sync();
      d.body.append(el('div', { class: 'form-grid' }, field('Code', f.code), field('Kind', f.kind), pctF, amtF, field('Minimum spend ($)', f.min), field('Total uses', f.uses),
        field('Starts', f.starts), field('Ends', f.ends), field('Campaign', f.camp, 'Redemptions count toward it', true),
        el('div', { class: 'wide' }, el('label', { class: 'check' }, f.once, el('span', { text: 'Once per customer' })), el('label', { class: 'check' }, f.pos, el('span', { text: 'At the register' })),
          el('label', { class: 'check' }, f.web, el('span', { text: 'On the web store' })))),
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn primary', type: 'button', onclick: (e) => doIt(e.currentTarget, () => post('/crm/coupons', { code: f.code.value, kind: f.kind.value,
        percent: f.kind.value === 'percent' ? f.pct.value : null, amount: f.kind.value === 'amount' ? f.amt.value : null, minSpend: f.min.value || null, startsOn: f.starts.value, endsOn: f.ends.value,
        maxUses: f.uses.value || null, campaignId: f.camp.value || null, oncePerCustomer: f.once.checked, channels: [f.pos.checked ? 'pos' : null, f.web.checked ? 'web' : null].filter(Boolean) }),
        'Coupon made.', () => { d.close(); render(); }) }, 'Make coupon')));
    };
    return section('Coupons', 'POS: put the discount on the sale, then record the code against the order', [el('button', { class: 'btn primary', type: 'button', onclick: make }, 'New coupon'),
      el('button', { class: 'btn', type: 'button', onclick: redeemDialog }, 'Record a register redemption')],
      rows.length ? el('div', { class: 'panel' }, rows.map((k) => item({ title: k.code, amount: k.kind === 'percent' ? `${k.pct_bps / 100}% off` : `${money(k.amount_minor)} off`,
        badge: chip(k.active ? 'good' : 'neutral', k.active ? 'ok' : 'none', k.active ? 'Active' : 'Ended'),
        detail: [`${dayLabel(k.starts_on)} – ${dayLabel(k.ends_on)}`, k.min_spend_minor !== '0' ? `min ${money(k.min_spend_minor)}` : null, `${k.uses}${k.max_uses ? '/' + k.max_uses : ''} used`,
          `${money(k.discount_minor)} given`, k.channels.map((c) => (c === 'pos' ? 'register' : 'web')).join(' + '), k.campaign].filter(Boolean).join(' · '),
        acts: k.active ? [el('button', { class: 'btn', type: 'button', onclick: (e) => doIt(e.currentTarget, () => post(`/crm/coupons/${k.id}/end`), 'Coupon ended.', () => render()) }, 'End')] : null }))) : empty('No coupons yet', null, true));
  }
  function redeemDialog() {
    const d = openDialog('Record a register redemption', 'The discount must already be on the sale');
    const code = input({ class: 'upper' }), order = input({ placeholder: 'Order id from the sale' });
    d.body.append(field('Code', code), field('Order', order, 'Open the sale on the register and copy its id'), el('div', { class: 'dlg-acts' }, el('button', { class: 'btn primary', type: 'button',
      onclick: (e) => doIt(e.currentTarget, () => post('/crm/coupons/redeem', { code: code.value, orderId: order.value.trim() }), (r) => (r.already ? 'Already recorded for that order.' : 'Redemption recorded.'), () => { d.close(); render(); }) }, 'Record')));
  }

  const ICON = { crm: 'C12 8 3.5|M5 20c0-3.9 3.1-6.2 7-6.2s7 2.3 7 6.2', leads: 'M3 5h18l-7 8v6l-4 2v-8z', day: 'R4 5 16 15|M4 10h16M8 3v4M16 3v4', mkt: 'M4 10v4l12 5V5z|M16 9a3 3 0 0 1 0 6' };
  register('crm', 'Customers', 'crmcust', screenCustomers, 'Retail', { icon: ICON.crm, module: 'crm' });
  register('leads', 'Leads', 'crmleads', screenLeads, 'Retail', { icon: ICON.leads, module: 'leads' });
  register('myday', 'My day', 'crmday', screenMyDay, 'Retail', { icon: ICON.day, module: 'myday' });
  register('marketing', 'Marketing', 'crmmkt', screenMarketing, 'Retail', { icon: ICON.mkt, module: 'marketing' });
})();
