// trade screens: Trade accounts (applications, accounts with terms, resale
// certificates, trade pricing rules, referral commission) and Room projects
// (clienteling, with follow-up settings). Also the room-projects card on the
// POS customer view and the line commission dialog POS opens. Registers with
// window.ERP (see docs/MODULES.md). Phone first: cards, pickers and wrapped
// rows -- no sideways tables; amounts sit on the right. Data is placed with
// textContent only.
(() => {
  'use strict';
  const E = window.ERP;
  const { el, frag, chip, money, dayLabel, plural, cap, coApi, post, go, toast, act, openDialog, resultBox, askReason,
    head, section, tile, tilesRow, empty, item, capped, seg, field, select, input, friendly, S } = E;

  const st = { tab: 'applications', appStatus: 'pending', q: '', projQ: '' };
  const words = (s) => cap(String(s || '').replace(/_/g, ' '));
  const btn = (label, onclick, o = {}) => el('button', { class: 'btn' + (o.primary ? ' primary' : '') + (o.small ? ' small' : ''), type: 'button', onclick }, label);
  const panel = (...kids) => el('div', { class: 'panel' }, ...kids);
  const errSlot = () => el('div');
  const showErr = (slot) => (e) => slot.replaceChildren(resultBox('critical', 'fail', 'Not done', friendly(e)));
  const pct = (bps) => `${(Number(bps || 0) / 100).toFixed(Number(bps) % 100 ? 2 : 0)}%`;
  const toBps = (v) => (v === '' || v == null ? null : Math.round(Number(String(v).replace('%', '')) * 100));
  let OPTS = null;
  async function opts() { if (!OPTS || OPTS.co !== S.co.id) OPTS = { co: S.co.id, ...(await coApi('/trade/options')) }; return OPTS; }
  function formDialog(title, sub, fields, label, send, okText) {
    const d = openDialog(title, sub);
    const err = errSlot();
    const b = btn(label, (e) => act(e.currentTarget, send, okText, { close: d.close, errorInto: showErr(err) }).then(() => { OPTS = null; }), { primary: true });
    d.body.append(el('div', { class: 'form-grid' }, fields), el('div', { class: 'dlg-acts' }, b, btn('Cancel', d.close)), err);
    return d;
  }

  // ===================================================== Trade accounts
  async function screenTrade(sub) {
    const [name, id] = String(sub || '').split(':');
    if (name === 'account' && id) return accountPage(id);
    const o = await opts();
    const tabs = seg([['applications', 'Applications'], ['accounts', 'Accounts'], ['referrals', 'Referrals'], ['pricing', 'Trade pricing']], st.tab, (v) => { st.tab = v; E.render(); });
    tabs.style.flexWrap = 'wrap';
    let body;
    if (st.tab === 'applications') body = await applicationsTab(o);
    else if (st.tab === 'accounts') body = await accountsTab();
    else if (st.tab === 'referrals') body = await referralsTab(o);
    else body = await pricingTab(o);
    return frag(head('Trade accounts', [], 'Designers, contractors, stagers, hospitality'), el('div', { class: 'toolbar' }, tabs), body);
  }

  async function applicationsTab(o) {
    const rows = await coApi(`/trade/applications?status=${st.appStatus}`);
    const filter = seg([['pending', 'Waiting'], ['approved', 'Approved'], ['declined', 'Declined'], ['all', 'All']], st.appStatus, (v) => { st.appStatus = v; E.render(); });
    const list = rows.map((a) => item({
      title: `${a.company_name} · ${a.number}`, badge: chip(a.status === 'pending' ? 'warning' : a.status === 'approved' ? 'good' : 'neutral', a.status === 'pending' ? 'pending' : 'ok', words(a.status)),
      detail: [words(a.kind), a.contact_name, a.email, a.phone, a.resale_number ? `resale ${a.resale_number} (${a.resale_state}${a.resale_expires ? ', to ' + dayLabel(a.resale_expires) : ''})` : 'no resale certificate'].filter(Boolean).join(' · '),
      why: a.decision_note || a.notes || null,
      acts: a.status === 'pending' ? [btn('Approve', () => approveDialog(a, o), { small: true, primary: true }),
        btn('Decline', async (e) => { const why = await askReason({ title: 'Decline the application', sub: a.company_name, label: 'Why', placeholder: 'Not a trade business; could not verify' });
          if (why) act(e.currentTarget, () => post(`/trade/applications/${a.id}/decide`, { decision: 'declined', note: why }), 'Declined'); }, { small: true })] : null,
    }));
    return frag(el('div', { class: 'toolbar' }, filter), section('Applications', plural(rows.length, 'application'), null, rows.length ? panel(capped(list, 20, 'applications')) : empty('Nothing waiting', 'Applications come from the trade portal.', true)));
  }

  function approveDialog(a, o) {
    const list = select(o.priceLists.filter((l) => l.active).map((l) => [l.id, `${l.code} · ${l.name}`]), (o.priceLists.find((l) => l.code === 'TRADE') || {}).id || '');
    const limit = input({ inputmode: 'decimal', placeholder: '0.00 (card only)' }), terms = input({ inputmode: 'numeric', value: '30' });
    const ref = input({ inputmode: 'decimal', placeholder: '0' });
    const rep = select([['', 'Nobody yet'], ...o.people.map((p) => [p.id, p.name])], '');
    const vendor = select([['', 'Not linked'], ...o.vendors.map((v) => [v.id, v.legal_name])], '');
    formDialog('Approve trade account', a.company_name, [
      field('Price list', list, o.priceLists.length ? null : 'A TRADE list is made if there is none.'),
      field('Credit limit', limit, 'Only the controller can set one; leave blank for card only.'), field('Terms (days)', terms),
      field('Referral commission %', ref, 'Paid when a client they bring in buys.'), field('House rep', rep), field('Vendor to pay referrals to', vendor, 'Add them in Payables first if they are not there.'),
    ], 'Approve', () => post(`/trade/applications/${a.id}/decide`, { decision: 'approved', priceListId: list.value || null, creditLimit: limit.value || null,
      termsDays: terms.value || 30, referralBps: toBps(ref.value) ?? 0, repId: rep.value || null, vendorId: vendor.value || null }),
    (r) => r.warnings && r.warnings.length ? r.warnings[0] : `Account ${r.number} opened`);
  }

  async function accountsTab() {
    const rows = await coApi(`/trade/accounts?q=${encodeURIComponent(st.q)}`);
    const q = input({ placeholder: 'Business, number, email', value: st.q, enterkeyhint: 'search', 'aria-label': 'Find an account' });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { st.q = q.value.trim(); E.render(); } });
    const list = rows.map((t) => item({ title: `${t.company_name} · ${t.number}`, amount: money(t.balance_minor),
      badge: chip(t.status === 'active' ? 'good' : 'critical', t.status === 'active' ? 'ok' : 'hold', words(t.status)),
      detail: [words(t.kind), t.contact_name, t.price_list ? `prices ${t.price_list}` : null, Number(t.credit_limit_minor) ? `limit ${money(t.credit_limit_minor)}, net ${t.terms_days}` : 'card only',
        t.referral_bps ? `referral ${pct(t.referral_bps)}` : null, t.open_projects ? plural(t.open_projects, 'open project') : null].filter(Boolean).join(' · '),
      onClick: () => go('trade', 'account:' + t.id) }));
    return frag(el('div', { class: 'toolbar' }, q), section('Accounts', plural(rows.length, 'account'), null, rows.length ? panel(capped(list, 25, 'accounts')) : empty('No trade accounts yet', 'Approve an application to open one.', true)));
  }

  async function accountPage(id) {
    const [x, o] = await Promise.all([coApi(`/trade/accounts/${id}`), opts()]);
    const t = x.account, cr = x.credit;
    const acts = [btn('All accounts', () => { st.tab = 'accounts'; go('trade'); }), btn('Edit', () => editDialog(x, o)), btn('Add resale certificate', () => certDialog(id))];
    if (t.status === 'active') acts.push(btn('Suspend', async (e) => { const why = await askReason({ title: 'Suspend the account', sub: t.company_name, label: 'Why', placeholder: 'Unpaid invoices over 60 days' });
      if (why) act(e.currentTarget, () => post(`/trade/accounts/${id}`, { status: 'suspended', statusReason: why }), 'Suspended; its portal sessions are ended'); }));
    else acts.push(btn('Reopen', (e) => act(e.currentTarget, () => post(`/trade/accounts/${id}`, { status: 'active' }), 'Reopened')));
    return frag(head(t.company_name, acts, `Trade account ${t.number}`),
      tilesRow(tile({ label: 'Owed', value: money(cr.balanceMinor) }), tile({ label: 'On order, unbilled', value: money(cr.onOrderMinor) }),
        tile({ label: 'Available', value: money(cr.availableMinor), tone: Number(cr.availableMinor) > 0 ? 'good' : 'neutral' }), tile({ label: 'Referral owed', value: money(x.referrals.owedMinor) })),
      section('Account', words(t.status), null, panel(
        item({ title: [t.contact_name, t.email, t.phone].filter(Boolean).join(' · '), detail: [words(t.kind), x.rep ? `rep ${x.rep.name}` : 'no rep'].join(' · ') }),
        item({ title: 'Terms', detail: Number(cr.limitMinor) ? `Net ${cr.termsDays}, limit ${money(cr.limitMinor)}${cr.onHold ? ', on hold' : ''}` : 'Card only (no credit limit)' }),
        item({ title: `Prices: ${t.price_list || 'retail'}`, detail: x.rules.length ? x.rules.map((r) => `${r.category || 'Everything else'}: ${r.basis === 'cost_plus' ? 'cost + ' : 'retail - '}${pct(r.bps)}`).join(' · ') : 'No rules on the list yet' }),
        item({ title: 'Referral commission', detail: t.referral_bps ? `${pct(t.referral_bps)} of the ${t.referral_basis === 'margin' ? 'gross margin' : 'sale'}, paid to ${x.vendor ? x.vendor.legal_name : 'no vendor yet (link one)'}` : 'None',
          acts: Number(x.referrals.owedMinor) > 0 ? [btn('Bill it', (e) => act(e.currentTarget, () => post(`/trade/accounts/${id}/bill-referrals`), (r) => `Bill ${r.reference} for ${money(r.totalMinor)} is ${r.status}`), { small: true })] : null }))),
      section('Resale certificates', null, null, x.certificates.length ? panel(x.certificates.map((c) => item({ title: `${c.number} · ${c.state}`, badge: chip(c.current ? 'good' : 'critical', c.current ? 'ok' : 'fail', c.current ? 'Current' : c.status === 'void' ? 'Void' : 'Expired'),
        detail: `${words(c.reason)}${c.expires_on ? ' · expires ' + dayLabel(c.expires_on) : ''}` })))
        : empty('No certificate on file', 'Orders are taxed until one is added.', true)),
      section('Room projects', plural(x.projects.length, 'project'), null, x.projects.length ? panel(x.projects.map(projectItem)) : empty('No projects yet', 'The designer starts them in the portal.', true)),
      section('Orders', null, null, x.orders.length ? panel(capped(x.orders.map((so) => item({ title: so.number, amount: money(so.total_minor), detail: `${words(so.status)} · ${dayLabel(String(so.ordered_at).slice(0, 10))}` })), 8, 'orders'))
        : empty('No orders yet', null, true)));
  }

  function editDialog(x, o) {
    const t = x.account;
    const list = select(o.priceLists.map((l) => [l.id, `${l.code} · ${l.name}`]), t.price_list_id || '');
    const ref = input({ inputmode: 'decimal', value: t.referral_bps ? String(t.referral_bps / 100) : '' });
    const basis = select([['margin', 'Gross margin'], ['sale', 'The sale']], t.referral_basis);
    const vendor = select([['', 'Not linked'], ...o.vendors.map((v) => [v.id, v.legal_name])], t.vendor_id || '');
    const rep = select([['', 'Nobody'], ...o.people.map((p) => [p.id, p.name])], t.rep_id || '');
    const limit = input({ inputmode: 'decimal', value: (Number(x.credit.limitMinor) / 100).toFixed(2) }), terms = input({ inputmode: 'numeric', value: String(x.credit.termsDays) });
    formDialog('Edit trade account', t.company_name, [field('Price list', list), field('Referral commission %', ref), field('Paid on', basis), field('Vendor to pay', vendor), field('House rep', rep),
      field('Credit limit', limit, 'Controller only'), field('Terms (days)', terms, 'Controller only')], 'Save', () => {
      const b = { priceListId: list.value || null, referralBps: toBps(ref.value) ?? 0, referralBasis: basis.value, vendorId: vendor.value || null, repId: rep.value || null };
      if (limit.value !== (Number(x.credit.limitMinor) / 100).toFixed(2) || terms.value !== String(x.credit.termsDays)) Object.assign(b, { creditLimit: limit.value, termsDays: terms.value });
      return post(`/trade/accounts/${t.id}`, b);
    }, 'Saved');
  }

  function certDialog(id) {
    const n = input({ placeholder: 'As printed' }), s = input({ maxlength: '2', placeholder: 'PA' }), e = input({ type: 'date' });
    formDialog('Resale certificate', 'Kept on the customer, used for tax-exempt resale orders', [field('Number', n), field('State', s), field('Expires', e)], 'Save',
      () => post(`/trade/accounts/${id}/certificate`, { number: n.value, state: s.value.toUpperCase(), expiresOn: e.value || null }), 'Certificate on file');
  }

  async function referralsTab(o) {
    const rows = await coApi('/trade/referrals');
    const trig = seg([['delivered', 'On delivery'], ['paid', 'Once paid']], o.referralOn, (v) => act(document.activeElement, () => post('/trade/referral-trigger', { value: v }), 'Saved').then(() => { OPTS = null; }));
    return frag(section('When referral commission is earned', null, null, panel(item({ title: 'Earned', detail: 'Returns give it back the same way.', acts: [trig] }))),
      section('Owed to trade accounts', 'not yet billed', null, rows.length ? panel(rows.map((r) => item({ title: r.company_name, amount: money(r.owed_minor), detail: plural(r.events, 'line'),
        acts: Number(r.owed_minor) > 0 ? [btn('Bill it', (e) => act(e.currentTarget, () => post(`/trade/accounts/${r.trade_account_id}/bill-referrals`), (x) => `Bill ${x.reference} is ${x.status}`), { small: true })] : null })))
        : empty('Nothing owed', 'A referral is earned when a client a designer brought in takes delivery.', true)));
  }

  async function pricingTab(o) {
    const blocks = [];
    for (const l of o.priceLists.filter((x) => x.active)) {
      const rules = await coApi(`/trade/price-lists/${l.id}/rules`);
      blocks.push(section(`${l.code} · ${l.name}`, plural(rules.length, 'rule'), [btn('Add a rule', () => ruleDialog(l, o), { small: true })],
        rules.length ? panel(rules.map((r) => item({ title: r.category || 'Everything else', amount: `${r.basis === 'cost_plus' ? 'cost +' : 'retail -'} ${pct(r.bps)}`,
          acts: [btn('Retire', (e) => act(e.currentTarget, () => post(`/trade/price-lists/${l.id}/rules`, { category: r.category, basis: r.basis, bps: r.bps, active: false }), 'Rule retired'), { small: true })] })))
          : empty('No rules', 'Products priced on the list itself keep their price; everything else sells at retail.', true)));
    }
    return frag(...(blocks.length ? blocks : [empty('No price lists', 'Approving the first application makes a TRADE list.', true)]));
  }

  function ruleDialog(l, o) {
    const cat = select([['', 'Everything else (catch-all)'], ...o.categories.map((c) => [c, c])], '');
    const basis = select([['retail_less', 'Retail less'], ['cost_plus', 'Cost plus']], 'retail_less');
    const p = input({ inputmode: 'decimal', placeholder: '20' });
    formDialog('Trade price rule', l.code, [field('Category', cat), field('Basis', basis), field('Percent', p)], 'Save',
      () => post(`/trade/price-lists/${l.id}/rules`, { category: cat.value || null, basis: basis.value, bps: toBps(p.value) }), 'Rule saved');
  }

  // ======================================================= Room projects
  const projectItem = (p) => item({ title: `${p.name} · ${p.number}`, amount: p.budget_minor ? money(p.budget_minor) : null,
    badge: chip(p.status === 'open' ? 'good' : 'neutral', p.status === 'open' ? 'ok' : 'info', words(p.status)),
    detail: [p.customer, p.trade_account ? `via ${p.trade_account}` : null, p.client_name ? `client ${p.client_name}` : null, plural(p.items, 'item'), p.photos ? plural(p.photos, 'photo') : null, p.salesperson].filter(Boolean).join(' · '),
    onClick: () => go('projects', 'p:' + p.id) });

  async function screenProjects(sub) {
    const [name, id] = String(sub || '').split(':');
    if (name === 'p' && id) return projectPage(id);
    const o = await opts();
    const rows = await coApi(`/trade/projects?q=${encodeURIComponent(st.projQ)}`);
    const q = input({ placeholder: 'Project, customer or client', value: st.projQ, enterkeyhint: 'search', 'aria-label': 'Find a project' });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { st.projQ = q.value.trim(); E.render(); } });
    const f = o.followups;
    const fu = panel(item({ title: 'Quote with no sale', detail: f.quoteNoSale ? `a task for the salesperson after ${plural(f.quoteNoSaleDays, 'day')}` : 'off' }),
      item({ title: 'Care check-in', detail: f.care ? `${plural(f.careDays, 'day')} after delivery` : 'off' }),
      item({ title: 'Protection plan check-in', detail: f.protection ? `${plural(f.protectionDays, 'day')} after delivery` : 'off' }));
    return frag(head('Room projects', [btn('New project', () => newProjectDialog(o), { primary: true }), btn('Follow-up settings', () => followDialog(f)),
      btn('Run follow-ups now', (e) => act(e.currentTarget, () => post('/trade/followups/run'), (r) => `${r.quoteNoSale + r.projectQuotes} quote, ${r.care} care and ${r.protection} protection follow-ups made`))], 'Clienteling'),
      el('div', { class: 'toolbar' }, q),
      section('Projects', plural(rows.length, 'project'), null, rows.length ? panel(capped(rows.map(projectItem), 25, 'projects')) : empty('No projects yet', 'Start one for a customer, or a designer starts one in the trade portal.', true)),
      section('Automatic follow-ups', 'go on the CRM task list, once each', null, fu));
  }

  function customerPicker(onPick) {
    const q = input({ placeholder: 'Name, phone or email', 'aria-label': 'Find a customer' });
    const list = el('div', { class: 'panel' });
    let picked = null;
    q.addEventListener('input', async () => {
      if (q.value.trim().length < 2) { list.replaceChildren(); return; }
      try {
        const rows = await coApi(`/crm/customers?q=${encodeURIComponent(q.value.trim())}`);
        list.replaceChildren(...rows.slice(0, 8).map((c) => item({ title: `${c.name} · ${c.number}`, detail: [c.email, c.phone].filter(Boolean).join(' · '),
          onClick: () => { picked = c; list.replaceChildren(item({ title: `${c.name} · ${c.number}`, badge: chip('good', 'ok', 'Picked') })); onPick(c); } })));
      } catch (e) { list.replaceChildren(resultBox('critical', 'fail', 'Search failed', friendly(e))); }
    });
    return { node: frag(q, list), get: () => picked };
  }

  function newProjectDialog(o, customer) {
    const pick = customer ? null : customerPicker(() => {});
    const name = input({ placeholder: 'Living room 2027' }), budget = input({ inputmode: 'decimal', placeholder: '0.00' });
    const rep = select([['', 'Me'], ...o.people.map((p) => [p.id, p.name])], '');
    formDialog('New room project', customer ? customer.name : null, [customer ? null : field('Customer', pick.node, null, true), field('Project name', name), field('Budget', budget), field('Salesperson', rep)],
      'Start', () => post('/trade/projects', { customerId: customer ? customer.id : (pick.get() || {}).id, name: name.value, budget: budget.value || null, salespersonId: rep.value || null }).then((r) => { go('projects', 'p:' + r.id); return r; }), 'Project started');
  }

  function followDialog(f) {
    const q = input({ inputmode: 'numeric', value: String(f.quoteNoSaleDays) }), c = input({ inputmode: 'numeric', value: String(f.careDays) }), p = input({ inputmode: 'numeric', value: String(f.protectionDays) });
    const on = (v) => select([['1', 'On'], ['0', 'Off']], v ? '1' : '0');
    const qo = on(f.quoteNoSale), co = on(f.care), po = on(f.protection);
    formDialog('Automatic follow-ups', 'Each makes one CRM task per order, ever', [field('Quote with no sale', qo), field('After (days)', q), field('Care check-in', co), field('Days after delivery', c),
      field('Protection plan check-in', po), field('Days after delivery', p)], 'Save', () => post('/trade/followups/settings', {
      quoteNoSaleDays: q.value, careDays: c.value, protectionDays: p.value, quoteNoSale: qo.value === '1', care: co.value === '1', protection: po.value === '1' }), 'Follow-ups saved');
  }

  async function projectPage(id) {
    const p = await coApi(`/trade/projects/${id}`);
    const a = p.client_address || {};
    const dims = [p.length_in, p.width_in, p.height_in].some(Boolean) ? `${p.length_in || '?'}" L × ${p.width_in || '?'}" W × ${p.height_in || '?'}" H` : 'Not measured yet';
    const acts = [btn('All projects', () => go('projects')), btn('Edit', () => editProject(p)), btn('Add a product', () => addItemDialog(p)), btn('Link an order', () => linkDialog(p))];
    if (p.status === 'open') acts.push(btn('Close', (e) => act(e.currentTarget, () => post(`/trade/projects/${id}`, { status: 'closed' }), 'Closed')));
    const photoIn = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': 'Add a photo' });
    photoIn.addEventListener('change', async () => {
      const file = photoIn.files && photoIn.files[0]; if (!file) return;
      try { const dataUrl = await resizeImage(file); act(photoIn, () => post(`/trade/projects/${id}/photos`, { dataUrl, caption: file.name.replace(/\.[a-z]+$/i, '') }), 'Photo added'); }
      catch (e) { toast(friendly(e), 'critical'); }
    });
    return frag(head(p.name, acts, `Room project ${p.number}`),
      tilesRow(tile({ label: 'Items', value: money(p.itemsTotalMinor) }), tile({ label: 'Budget', value: p.budget_minor ? money(p.budget_minor) : '—', word: !p.budget_minor }),
        tile({ label: 'Status', value: words(p.status), word: true })),
      section('Room', null, null, panel(item({ title: dims, detail: (p.openings || []).map((x) => `${words(x.kind)}${x.wall ? ' on ' + x.wall : ''}${x.widthIn ? ` ${x.widthIn}"×${x.heightIn || '?'}"` : ''}`).join(' · ') || 'No doors or windows noted' }),
        item({ title: 'Style', detail: p.style_notes || 'No notes yet' }),
        item({ title: `${p.customer}${p.trade_account ? ' · ' + p.trade_account : ''}${p.household ? ' · household ' + p.household : ''}`,
          detail: [p.client_name ? `client ${p.client_name}` : null, a.line1 ? `${a.line1}, ${a.city}, ${a.state} ${a.postal}` : null, p.salesperson ? `salesperson ${p.salesperson}` : null].filter(Boolean).join(' · ') || null }))),
      section('Products', 'considered, quoted and bought', null, p.items.length ? panel(p.items.map((it) => item({ title: it.description, amount: it.lineMinor ? money(it.lineMinor) : null,
        badge: chip(it.stage === 'bought' ? 'good' : it.stage === 'quoted' ? 'warning' : 'neutral', it.stage === 'bought' ? 'ok' : 'info', words(it.stage)),
        detail: [`${it.qty} × ${it.unitPriceMinor ? money(it.unitPriceMinor) : '—'}`, it.orderNumber ? `order ${it.orderNumber}` : null, it.problem].filter(Boolean).join(' · '),
        acts: it.stage === 'bought' ? null : [select([['considered', 'Considered'], ['quoted', 'Quoted'], ['bought', 'Bought']], it.stage), btn('Remove', (e) => act(e.currentTarget, () => post(`/trade/projects/${id}/items/${it.id}`, { remove: true }), 'Removed'), { small: true })]
          .map((n) => { if (n.tagName === 'SELECT') n.addEventListener('change', () => act(n, () => post(`/trade/projects/${id}/items/${it.id}`, { stage: n.value }), 'Updated')); return n; }) })))
        : empty('Nothing yet', 'Add what the customer is considering.', true)),
      section('Photos', plural(p.photos.length, 'photo'), null, el('div', { class: 'panel' }, el('div', { class: 'trade-photos' }, p.photos.map((x) => el('figure', {},
        el('img', { src: x.data_url, alt: x.caption || 'Room photo' }), el('figcaption', { text: x.caption || '' }),
        btn('Remove', (e) => act(e.currentTarget, () => post(`/trade/projects/${id}/photos/${x.id}/remove`), 'Removed'), { small: true })))), field('Add a photo', photoIn))),
      section('Quotes and orders', null, null, p.orders.length ? panel(p.orders.map((o) => item({ title: `${o.number} · ${words(o.kind)}`, amount: money(o.total_minor), detail: words(o.status) })))
        : empty('None linked yet', null, true)));
  }

  function editProject(p) {
    const a = p.client_address || {};
    const f = { name: input({ value: p.name }), client: input({ value: p.client_name || '' }), line1: input({ value: a.line1 || '' }), city: input({ value: a.city || '' }), state: input({ value: a.state || '', maxlength: '2' }),
      postal: input({ value: a.postal || '' }), L: input({ inputmode: 'decimal', value: p.length_in || '' }), W: input({ inputmode: 'decimal', value: p.width_in || '' }), H: input({ inputmode: 'decimal', value: p.height_in || '' }),
      notes: el('textarea', { maxlength: '2000' }), budget: input({ inputmode: 'decimal', value: p.budget_minor ? (Number(p.budget_minor) / 100).toFixed(2) : '' }),
      openings: el('textarea', { placeholder: 'One per line: door, north, 36, 80' }) };
    f.notes.value = p.style_notes || '';
    f.openings.value = (p.openings || []).map((x) => [x.kind, x.wall || '', x.widthIn || '', x.heightIn || ''].join(', ')).join('\n');
    formDialog('Edit project', p.number, [field('Name', f.name), field('Client', f.client), field('Client street', f.line1, null, true), field('City', f.city), field('State', f.state), field('ZIP', f.postal),
      field('Length (in)', f.L), field('Width (in)', f.W), field('Height (in)', f.H), field('Budget', f.budget), field('Style notes', f.notes, null, true),
      field('Doors and windows', f.openings, 'kind, wall, width, height', true)], 'Save', () => post(`/trade/projects/${p.id}`, { name: f.name.value, clientName: f.client.value,
      clientAddress: f.line1.value || f.postal.value ? { line1: f.line1.value, city: f.city.value, state: f.state.value, postal: f.postal.value } : null,
      lengthIn: f.L.value, widthIn: f.W.value, heightIn: f.H.value, styleNotes: f.notes.value, budget: f.budget.value,
      openings: f.openings.value.split('\n').map((l) => l.split(',').map((s) => s.trim())).filter((x) => x[0]).map(([kind, wall, widthIn, heightIn]) => ({ kind, wall, widthIn, heightIn })) }), 'Saved');
  }

  function addItemDialog(p) {
    const q = input({ placeholder: 'Search products', 'aria-label': 'Search products' });
    const list = el('div', { class: 'panel' });
    let picked = null;
    const qty = input({ inputmode: 'numeric', value: '1' });
    const stage = select([['considered', 'Considered'], ['quoted', 'Quoted']], 'considered');
    q.addEventListener('input', async () => {
      if (q.value.trim().length < 2) return;
      const rows = await coApi(`/shop/products?q=${encodeURIComponent(q.value.trim())}`);
      list.replaceChildren(...rows.slice(0, 8).map((r) => item({ title: r.name, amount: money(r.price_minor), detail: r.sku, onClick: () => { picked = r; list.replaceChildren(item({ title: r.name, badge: chip('good', 'ok', 'Picked') })); } })));
    });
    formDialog('Add a product', p.name, [field('Product', frag(q, list), 'Configured pieces can be added from POS or the portal with their options.', true), field('Quantity', qty), field('Stage', stage)], 'Add',
      () => post(`/trade/projects/${p.id}/items`, { productId: picked ? picked.id : '', qty: Number(qty.value || 1), stage: stage.value }), 'Added');
  }

  function linkDialog(p) {
    const n = input({ placeholder: 'Order id' });
    formDialog('Link an order or quote', 'It must be this customer’s', [field('Order id', n, 'From the order view in POS.')], 'Link', () => post(`/trade/projects/${p.id}/orders`, { orderId: n.value.trim() }), 'Linked');
  }

  // ===================================================== shared with POS
  /** The room projects card for a customer, shown on the POS customer view and wherever a customer is open. */
  async function projectsCard(customer) {
    try {
      const rows = await coApi(`/trade/projects?customer=${customer.id}`);
      const o = await opts();
      return section('Room projects', plural(rows.length, 'project'), [btn('New', () => newProjectDialog(o, customer), { small: true })],
        rows.length ? panel(rows.slice(0, 5).map(projectItem)) : empty('No projects yet', null, true));
    } catch (e) { return null; }
  }

  /** The designer split and outside referral for one sale line (POS opens it from the order view). */
  async function lineCommissionDialog(line, after) {
    const [cur, o] = await Promise.all([coApi(`/trade/lines/${line.id}/commission`), opts()]);
    const prim = (cur.split.find((x) => x.role === 'primary') || {}).app_user_id || '';
    const des = cur.split.find((x) => x.role === 'designer') || {};
    const primary = select([['', 'The order’s salesperson'], ...o.people.map((p) => [p.id, p.name])], prim);
    const designer = select([['', 'No designer'], ...o.people.map((p) => [p.id, p.name])], des.app_user_id || '');
    const share = input({ inputmode: 'decimal', value: des.split_bps ? String(des.split_bps / 100) : '30' });
    const ref = select([['', 'No outside referral'], ...o.accounts.filter((a) => a.referral_bps > 0).map((a) => [a.id, `${a.company_name} (${pct(a.referral_bps)})`])], (cur.referral || {}).trade_account_id || '');
    formDialog('Commission on this line', line.description || line.sku, [field('Primary rep', primary), field('Internal designer', designer), field('Designer’s share %', share),
      field('Referred by (trade account)', ref, 'Earns its referral rate as a payable when this line is delivered.')], 'Save', () => post(`/trade/lines/${line.id}/commission`, {
      primaryId: primary.value || null, designerId: designer.value || null, designerSplitBps: designer.value ? toBps(share.value) : null,
      referralTradeAccountId: ref.value || null, clearReferral: !ref.value }).then((r) => { if (after) after(r); return r; }), 'Commission set');
  }

  E.trade = { projectsCard, lineCommissionDialog };

  const sheet = new CSSStyleSheet();
  sheet.replaceSync('.trade-photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,140px),1fr));gap:8px;padding:8px 16px}.trade-photos figure{margin:0;display:flex;flex-direction:column;gap:4px}'
    + '.trade-photos img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:10px}');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  const ICON_TRADE = 'M4 20V9l8-5 8 5v11|M9 20v-6h6v6|M4 20h16';
  const ICON_ROOM = 'M3 10l9-6 9 6|M5 9v11h14V9|M9 20v-5h6v5';
  E.register('trade', 'Trade accounts', 'tradeacct', screenTrade, 'Retail', { icon: ICON_TRADE, module: 'trade' });
  E.register('projects', 'Room projects', 'roomproj', screenProjects, 'Retail', { icon: ICON_ROOM, module: 'projects' });
})();
