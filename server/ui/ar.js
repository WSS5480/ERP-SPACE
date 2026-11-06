// ar screens: receivables. Registers with window.ERP (see docs/MODULES.md).
// Phone first: every list is cards (ERP.item), amounts sit on the right,
// sections are picked from a dropdown, and nothing scrolls sideways.
// Data is placed with textContent only (ERP.el), never innerHTML.
(() => {
  'use strict';
  const E = window.ERP;
  const { el, frag, money, section, head, item, tile, tilesRow, empty, chip, coApi, post, act, openDialog, fillDialog, resultBox,
    friendly, fact, go, plural, cap, todayIso, busy, toast, render, capped } = E;

  // Printing a statement prints only the statement.
  // The page's CSP refuses inline <style> and style attributes; a constructed
  // stylesheet is CSSOM, which it allows.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('@media print{body *{visibility:hidden!important}.ar-print,.ar-print *{visibility:visible!important}' +
    '.ar-print{position:absolute;left:0;top:0;width:100%}.ar-noprint{display:none!important}}' +
    '.ar-pick{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 14px}.ar-pick select{min-width:200px}' +
    '.ar-stmt-h{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:14px 16px}.ar-sub{color:var(--ink-2);font-size:13.5px}' +
    '.ar-pad{padding:4px 16px 12px}');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  let LABEL = 'Receivables';
  const B = (v) => Number(v || 0);
  // Postgres prints '2026-11-06 18:40:00.12+00'; make it ISO so every browser reads it.
  const isoTs = (t) => String(t || '').replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
  const fmtDay = (d) => (d ? E.dayLabel(String(d).slice(0, 10)) : '');
  const pct = (bps) => `${(Number(bps || 0) / 100).toFixed(2).replace(/\.00$/, '')}%`;
  const BUCKETS = [['current', 'Current'], ['d1_30', '1–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['d90_plus', 'Over 90 days']];

  function setLabel(label) {
    if (!label || label === LABEL) return;
    LABEL = label;
    E.register('ar', LABEL, 'cash', screen, 'Back office');
    const a = document.querySelector('#nav a[href$="/ar"]');
    if (a) for (const n of a.childNodes) if (n.nodeType === 3) n.textContent = LABEL;
  }

  // ------------------------------------------------------------ form bits
  const input = (props) => el('input', Object.assign({ type: 'text' }, props));
  const moneyIn = (placeholder) => input({ inputmode: 'decimal', placeholder: placeholder || '0.00', autocomplete: 'off' });
  const select = (opts, value) => el('select', {}, opts.map(([v, t]) => el('option', { value: v, text: t, selected: v === value || null })));
  const field = (label, control, hint, wide) => el('label', { class: 'field' + (wide ? ' wide' : '') }, el('span', { text: label }), control,
    hint ? el('span', { class: 'hint', text: hint }) : null);
  const METHODS = [['cash', 'Cash'], ['card', 'Card'], ['check', 'Check'], ['ach', 'ACH / bank transfer'], ['store_credit', 'Store credit'], ['gift_card', 'Gift card'], ['other', 'Other']];

  /** A dialog with fields and one button that posts; the screen redraws after. */
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
  const facts = (...pairs) => el('div', { class: 'panel' }, el('div', { class: 'facts' }, pairs.filter(Boolean).map(([k, v]) => fact(k, v))));
  const panel = (...kids) => el('div', { class: 'panel' }, kids);
  const list = (nodes, emptyText) => panel(nodes.length ? nodes : empty(emptyText, null, true));
  const tieChip = (diff) => Number(diff) === 0 ? chip('good', 'ok', 'Ties to the books') : chip('serious', 'warn', `Off by ${money(diff)}`);

  // ------------------------------------------------------------ the screen
  const SECTIONS = [['', 'Overview'], ['customers', 'Customers'], ['calls', 'Collections'], ['contracts', 'Installment contracts'],
    ['finance', 'Finance companies'], ['writeoffs', 'Write-offs'], ['deposits', 'Deposits held'], ['settings', 'Settings']];

  function picker(cur) {
    const s = select(SECTIONS, cur);
    s.addEventListener('change', () => go('ar', s.value));
    return el('div', { class: 'ar-pick ar-noprint' }, el('span', { class: 'ar-sub', text: 'Show' }), s);
  }

  async function screen(sub) {
    const [kind, id] = String(sub || '').split('~');
    if (kind === 'account') return account(id);
    if (kind === 'statement') return statement(id);
    if (kind === 'contract') return contract(id);
    const body = kind === 'customers' ? await customers() : kind === 'calls' ? await calls() : kind === 'contracts' ? await contracts()
      : kind === 'finance' ? await finance() : kind === 'writeoffs' ? await writeoffs() : kind === 'deposits' ? await deposits()
      : kind === 'settings' ? await settings() : await overview();
    return frag(head(LABEL, []), picker(kind || ''), body);
  }

  // ------------------------------------------------------------ overview
  async function overview() {
    const d = await coApi('/ar/summary');
    setLabel(d.label);
    const t = d.aging;
    const past = B(t.total) - B(t.current) - B(t.unapplied);
    return frag(
      tilesRow(
        tile({ label: `${d.label} owed`, value: money(t.total), tone: 'neutral', ic: 'book', text: Number(d.differenceMinor) === 0 ? 'Ties to GL 1100' : `GL 1100 off by ${money(d.differenceMinor)}` }),
        tile({ label: 'Past due', value: money(past), tone: past > 0 ? 'warning' : 'good', ic: past > 0 ? 'warn' : 'ok', text: `${money(t.d90_plus)} over 90 days`, onClick: () => go('ar', 'calls') }),
        tile({ label: 'To call today', value: String(d.callList), tone: d.callList ? 'warning' : 'good', ic: 'clock', text: 'Collections list', onClick: () => go('ar', 'calls') }),
        tile({ label: 'Deposits held', value: money(d.deposits.totalMinor), tone: Number(d.deposits.differenceMinor) === 0 ? 'neutral' : 'serious', ic: 'cash',
          text: Number(d.deposits.differenceMinor) === 0 ? 'Ties to GL 2300' : `GL 2300 off by ${money(d.deposits.differenceMinor)}`, onClick: () => go('ar', 'deposits') })),
      section('Aging', `as of ${fmtDay(todayIso())}`, [tieChip(d.differenceMinor)],
        list([...BUCKETS.map(([k, label]) => item({ title: label, amount: money(t[k]) })),
          B(t.unapplied) ? item({ title: 'Unapplied cash on accounts', amount: money(t.unapplied) }) : null,
          item({ title: 'Total', amount: money(t.total), detail: `GL 1100 says ${money(d.glMinor)}` })].filter(Boolean), 'Nothing owed.')),
      section(`By ${E.S.co.locationLabel ? E.S.co.locationLabel.toLowerCase() : 'store'}`, null, null,
        list(d.byLocation.map((r) => item({ title: r.name, amount: money(r.total),
          detail: `Current ${money(r.current)} · 1–30 ${money(r.d1_30)} · 31–60 ${money(r.d31_60)} · 61–90 ${money(r.d61_90)} · 90+ ${money(r.d90_plus)}` })), 'Nothing owed.')),
      section('Waiting on someone', null, null, list([
        d.pendingWriteoffs.n ? item({ title: `${plural(d.pendingWriteoffs.n, 'write-off')} to approve`, amount: money(d.pendingWriteoffs.s), onClick: () => go('ar', 'writeoffs') }) : null,
        d.awaitingFunding.n ? item({ title: `${plural(d.awaitingFunding.n, 'financed sale')} not yet funded`, amount: money(d.awaitingFunding.totalMinor), onClick: () => go('ar', 'finance') }) : null,
        d.activeContracts ? item({ title: `${plural(d.activeContracts, 'installment contract')} open`, onClick: () => go('ar', 'contracts') }) : null,
      ].filter(Boolean), 'Nothing waiting.')));
  }

  // ----------------------------------------------------------- customers
  async function customers() {
    const box = el('div');
    const search = input({ type: 'search', placeholder: 'Name, account number or phone' });
    const load = async () => {
      box.replaceChildren(E.loadingNode());
      try {
        const rows = await coApi(`/ar/customers?q=${encodeURIComponent(search.value.trim())}`);
        box.replaceChildren(list(capped(rows.map((r) => item({
          title: r.name, amount: money(r.balance_minor),
          detail: [r.number, r.phone, r.house_account ? `limit ${money(r.credit_limit_minor)}, net ${r.terms_days}` : null].filter(Boolean).join(' · '),
          badge: r.status === 'hold' ? chip('serious', 'hold', 'On hold') : r.house_account ? chip('neutral', 'book', 'House account') : null,
          onClick: () => go('ar', `account~${r.id}`) })), 25, 'customers'), 'No customers match.'));
      } catch (e) { box.replaceChildren(E.errorBox(e, load)); }
    };
    let timer = 0;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
    await load();
    return frag(el('div', { class: 'ar-pick' }, search), box);
  }

  // ------------------------------------------------------------- account
  async function account(id) {
    const d = await coApi(`/ar/customers/${id}`);
    setLabel(d.label);
    const cu = d.customer;
    const ag = d.aging;
    const actions = [
      el('button', { class: 'btn primary', type: 'button', onclick: () => payDialog(d) }, 'Take a payment'),
      el('button', { class: 'btn', type: 'button', onclick: () => go('ar', `statement~${id}`) }, 'Statement'),
      el('button', { class: 'btn', type: 'button', onclick: () => contactDialog(cu) }, 'Log a contact'),
      el('button', { class: 'btn', type: 'button', onclick: () => termsDialog(d) }, 'Account terms'),
      el('button', { class: 'btn', type: 'button', onclick: () => noteDialog(cu) }, 'Add a note'),
    ];
    if (B(d.unappliedMinor) > 0) actions.push(el('button', { class: 'btn', type: 'button', onclick: (e) => act(e.currentTarget, () => post(`/ar/customers/${id}/apply`, {}), (r) => `Applied ${money(r.appliedMinor)}`) }, 'Apply credits'));
    return frag(
      head(cu.name, actions, `${LABEL} · ${cu.number}`),
      el('p', { class: 'ar-noprint' }, el('button', { class: 'linkbtn', type: 'button', onclick: () => go('ar', 'customers') }, '← All customers')),
      facts(['Balance', money(d.balanceMinor)], ['Past due', money(B(ag.total) - B(ag.current) - B(ag.unapplied))],
        cu.house_account ? ['Credit limit', money(cu.credit_limit_minor)] : ['House account', 'No'],
        cu.house_account ? ['Available', money(d.availableCreditMinor)] : null,
        ['Terms', cu.house_account ? `Net ${cu.terms_days} days` : 'Due on delivery'], ['Status', cap(cu.status)],
        ['Unapplied cash', money(d.unappliedMinor)], ['Store credit', money(d.storeCreditMinor)],
        ['Deposits held', money(d.deposits.reduce((a, x) => a + B(x.held_minor), 0))], ['Phone', cu.phone || '—'], ['Email', cu.email || '—'],
        ['Collector', cu.collector || '—']),
      section('Open invoices', null, null, list(d.openInvoices.map((i) => item({
        title: i.number, amount: money(i.open_minor), detail: `${cap(i.kind.replace('_', ' '))} · dated ${fmtDay(i.invoice_date)} · due ${fmtDay(i.due_date)}`,
        badge: i.due_date < todayIso() && B(i.open_minor) > 0 ? chip('warning', 'clock', `${Math.round((Date.parse(todayIso()) - Date.parse(i.due_date)) / 864e5)} days late`) : null,
        onClick: () => invoiceDialog(i.id),
        acts: B(i.open_minor) > 0 ? [
          i.kind === 'sale' ? el('button', { class: 'btn small', type: 'button', onclick: () => contractDialog(i) }, 'Finance in house') : null,
          el('button', { class: 'btn small', type: 'button', onclick: () => writeoffDialog({ invoiceId: i.id, label: i.number, open: i.open_minor }) }, 'Write off'),
        ].filter(Boolean) : [] })), 'Nothing open.')),
      d.deposits.length ? section('Deposits held on orders', null, null, list(d.deposits.map((x) => item({ title: x.number, amount: money(x.held_minor),
        detail: `${cap(x.status)} · order ${money(x.total_minor)}, paid ${money(x.paid_minor)}` })), '')) : null,
      d.contracts.length ? section('Installment contracts', null, null, list(d.contracts.map((k) => item({ title: k.number, amount: money(k.balance_minor),
        detail: `${money(k.payment_minor)} a month · ${pct(k.apr_bps)} APR · ${cap(k.status.replace('_', ' '))}`, onClick: () => go('ar', `contract~${k.id}`) })), '')) : null,
      section('Promises and contacts', null, null, list([
        ...d.promises.slice(0, 5).map((p) => item({ title: `Promise: ${money(p.amount_minor)} by ${fmtDay(p.promised_on)}`,
          badge: chip(p.status === 'kept' ? 'good' : p.status === 'broken' ? 'serious' : 'neutral', p.status === 'kept' ? 'ok' : p.status === 'broken' ? 'warn' : 'clock', cap(p.status)) })),
        ...d.actions.slice(0, 10).map((x) => item({ title: `${cap(x.kind)}${x.outcome ? ': ' + x.outcome.replace(/_/g, ' ') : ''}`, detail: `${E.ago(isoTs(x.at))} · ${x.by || ''}`, why: x.notes || null })),
      ], 'No contacts yet.')),
      section('Notes', null, null, list(d.notes.map((n) => item({ title: n.body, detail: `${n.author || ''} · ${fmtDay(n.created_at)}` })), 'No notes.')),
      section('Recent receipts', null, null, list(capped(d.receipts.map((r) => item({ title: `${r.number} · ${cap(r.method.replace('_', ' '))}`, amount: money(r.amount_minor),
        detail: `${fmtDay(r.received_at)} · ${r.on_account ? 'on account' : r.order_number ? 'deposit on ' + r.order_number : 'no order'}${r.voided_at ? ' · voided' : ''}` })), 8, 'receipts'), 'No receipts.')),
      section('Orders', null, null, list(capped(d.orders.map((o) => item({ title: `${o.number} · ${o.location}`, amount: money(o.total_minor),
        detail: `${fmtDay(o.ordered_on)} · ${cap(o.status)} · paid ${money(o.paid_minor)}` })), 8, 'orders'), 'No orders.')));
  }

  function invoiceDialog(id) {
    const d = openDialog('Invoice', null, { wide: true });
    fillDialog(d, async () => {
      const x = await coApi(`/ar/invoices/${id}`);
      const i = x.invoice;
      return frag(
        facts(['Invoice', i.number], ['Customer', i.customer || 'Cash sale'], ['Dated', fmtDay(i.invoice_date)], ['Due', fmtDay(i.due_date)],
          ['Total', money(i.total_minor)], ['From deposits', money(i.deposit_applied_minor)], ['Charged', money(i.charged_minor)], ['Open', money(x.openMinor)]),
        section('Lines', null, null, list(x.lines.map((l) => item({ title: l.description, amount: money(l.net_minor),
          detail: `${l.sku || ''} · ${Number(l.qty)} × ${money(l.unit_price_minor)}${Number(l.discount_minor) ? ' less ' + money(l.discount_minor) : ''} · tax ${money(l.tax_minor)}` })), 'No lines.')),
        section('Activity', null, null, list(x.activity.map((a) => item({ title: `${cap(a.kind.replace(/_/g, ' '))}${a.receipt ? ' ' + a.receipt : ''}`, amount: money(a.amount_minor),
          detail: `${fmtDay(a.occurred_on)}${a.memo ? ' · ' + a.memo : ''}` })), 'Nothing yet.')));
    });
  }

  function payDialog(d) {
    const cu = d.customer;
    formDialog('Take a payment', cu.name, () => {
      const amount = moneyIn(), method = select(METHODS, 'cash'), ref = input({ maxlength: '40', placeholder: 'Check number, last 4' });
      const target = select([['oldest', 'Oldest invoices first'], ...d.openInvoices.filter((i) => B(i.open_minor) > 0).map((i) => [`inv:${i.id}`, `${i.number} (owes ${money(i.open_minor)})`]),
        ...d.orders.filter((o) => !['cancelled', 'draft', 'closed', 'fulfilled'].includes(o.status)).map((o) => [`ord:${o.id}`, `Deposit on order ${o.number}`])], 'oldest');
      const over = select([['unapplied', 'Leave it on the account'], ['store_credit', 'Make it store credit']], 'unapplied');
      return { amount, method, ref, target, over, lead: `Balance ${money(d.balanceMinor)}. A payment goes to invoices; a deposit is held on an order until it is delivered.`,
        fields: [field('Amount', amount), field('Paid by', method), field('Goes to', target, null, true), field('Anything over', over), field('Reference', ref)] };
    }, 'Take it', (p) => {
      const t = p.target.value;
      const body = { amount: p.amount.value, method: p.method.value, reference: p.ref.value, overpayment: p.over.value };
      if (t.startsWith('inv:')) body.apply = [{ invoiceId: t.slice(4), amount: p.amount.value }];
      if (t.startsWith('ord:')) body.salesOrderId = t.slice(4);
      return post(`/ar/customers/${cu.id}/payments`, body);
    }, (r) => `Receipt ${r.number} taken${Number(r.unappliedMinor) ? `, ${money(r.unappliedMinor)} left on account` : ''}${Number(r.storeCreditMinor) ? `, ${money(r.storeCreditMinor)} to store credit` : ''}`);
  }

  function termsDialog(d) {
    const cu = d.customer;
    formDialog('Account terms', `${cu.name} · controller or owner`, () => {
      const house = select([['yes', 'Yes, may charge to the account'], ['no', 'No']], cu.house_account ? 'yes' : 'no');
      const limit = moneyIn(); limit.value = (B(cu.credit_limit_minor) / 100).toFixed(2);
      const terms = input({ inputmode: 'numeric', value: String(cu.terms_days) });
      const status = select([['active', 'Active'], ['hold', 'On hold: no new charges'], ['inactive', 'Inactive']], cu.status);
      const late = select([['yes', 'Charge late fees'], ['no', 'No late fees']], cu.late_fees ? 'yes' : 'no');
      const via = select([['email', 'Email'], ['mail', 'Mail'], ['none', 'Do not send']], cu.statement_via);
      return { house, limit, terms, status, late, via, fields: [field('House account', house, null, true), field('Credit limit', limit), field('Terms (days)', terms),
        field('Status', status), field('Late fees', late), field('Statements by', via)] };
    }, 'Save', (p) => post(`/ar/customers/${cu.id}/account`, { houseAccount: p.house.value === 'yes', creditLimit: p.limit.value, termsDays: p.terms.value,
      status: p.status.value, lateFees: p.late.value === 'yes', statementVia: p.via.value }), 'Account terms saved');
    // An override is also a controller's call; offer it in the same place.
    setTimeout(() => {
      const dl = document.querySelector('dialog[open] .dlg-acts');
      if (dl) dl.append(el('button', { class: 'btn', type: 'button', onclick: () => { document.querySelector('dialog[open]').close(); overrideDialog(cu); } }, 'Approve a charge over the limit'));
    });
  }

  function overrideDialog(cu) {
    formDialog('Approve a charge over the limit', cu.name, () => {
      const upTo = moneyIn(), reason = el('textarea', { maxlength: '500', placeholder: 'Why this is all right' });
      return { upTo, reason, lead: 'Covers one charge up to this amount, the next time a sale for this customer is handed over.',
        fields: [field('Up to', upTo), field('Reason', reason, null, true)] };
    }, 'Approve', (p) => post(`/ar/customers/${cu.id}/overrides`, { upTo: p.upTo.value, reason: p.reason.value }), 'Override approved');
  }

  function noteDialog(cu) {
    formDialog('Add a note', cu.name, () => { const body = el('textarea', { maxlength: '2000' }); return { body, fields: [field('Note', body, null, true)] }; },
      'Save note', (p) => post(`/ar/customers/${cu.id}/notes`, { body: p.body.value }), 'Note saved');
  }

  function contactDialog(cu, templates) {
    formDialog('Log a contact', `${cu.name}${cu.phone ? ' · ' + cu.phone : ''}`, () => {
      const kind = select([['call', 'Phone call'], ['visit', 'Visit'], ['note', 'Note']], 'call');
      const outcome = select([['no_answer', 'No answer'], ['left_message', 'Left a message'], ['promised', 'Promised to pay'], ['callback', 'Call back later'],
        ['refused', 'Refused'], ['disputed', 'Disputes the balance'], ['wrong_number', 'Wrong number'], ['paid', 'Says it is paid'], ['other', 'Other']], 'no_answer');
      const notes = el('textarea', { maxlength: '2000' });
      const pOn = input({ type: 'date', min: todayIso() }), pAmt = moneyIn();
      const cb = input({ type: 'datetime-local' });
      const pf = [field('Promised date', pOn), field('Promised amount', pAmt)], cf = [field('Call back at', cb)];
      const sync = () => { for (const f of pf) f.hidden = outcome.value !== 'promised'; for (const f of cf) f.hidden = outcome.value !== 'callback' && outcome.value !== 'no_answer' && outcome.value !== 'left_message'; };
      outcome.addEventListener('change', sync); setTimeout(sync);
      return { kind, outcome, notes, pOn, pAmt, cb, fields: [field('Contact', kind), field('Outcome', outcome), ...pf, ...cf, field('Notes', notes, null, true)] };
    }, 'Save', (p) => post(`/ar/collections/${cu.id}/actions`, { kind: p.kind.value, outcome: p.outcome.value, notes: p.notes.value,
      callbackAt: p.cb.value ? new Date(p.cb.value).toISOString() : null,
      promise: p.outcome.value === 'promised' ? { on: p.pOn.value, amount: p.pAmt.value } : undefined }), 'Contact logged');
    void templates;
  }

  function sendDialog(cu, templates) {
    formDialog('Send a reminder', cu.name, () => {
      const t = select(templates.map((x) => [x.code, `${x.name} (${x.channel})`]), templates[0] && templates[0].code);
      return { t, lead: 'The message is filled in and recorded as sent. No text, email or letter provider is connected yet, so nothing actually leaves the ERP.',
        fields: [field('Template', t, null, true)] };
    }, 'Record as sent', (p) => post(`/ar/collections/${cu.id}/send`, { template: p.t.value }), (r) => `Recorded: ${r.subject || r.body.slice(0, 60)}`);
  }

  function writeoffDialog(target) {
    formDialog('Ask for a write-off', `${target.label} · ${money(target.open)} open`, () => {
      const amount = moneyIn(); amount.value = (B(target.open) / 100).toFixed(2);
      const method = select([['', 'Company default'], ['allowance', 'Against the allowance (1190)'], ['direct', 'Straight to bad debt (6900)']], '');
      const reason = el('textarea', { maxlength: '500' });
      return { amount, method, reason, lead: 'A controller or the owner approves it, and it cannot be the person who asked.',
        fields: [field('Amount', amount), field('Method', method), field('Reason', reason, null, true)] };
    }, 'Ask', (p) => post('/ar/writeoffs', { invoiceId: target.invoiceId || null, contractId: target.contractId || null, amount: p.amount.value,
      method: p.method.value || undefined, reason: p.reason.value }), 'Write-off waiting on approval');
  }

  function contractDialog(inv) {
    formDialog('Finance in house', `${inv.number} · ${money(inv.open_minor)} open`, (d) => {
      const principal = moneyIn(); principal.value = (B(inv.open_minor) / 100).toFixed(2);
      const apr = input({ inputmode: 'decimal', value: '19.99' }), term = input({ inputmode: 'numeric', value: '12' });
      const first = input({ type: 'date', min: todayIso() });
      const preview = el('div');
      const show = async () => {
        try {
          const r = await coApi(`/ar/amortize?principal=${encodeURIComponent(principal.value)}&apr=${encodeURIComponent(apr.value)}&term=${encodeURIComponent(term.value)}&first=${first.value || todayIso()}`);
          preview.replaceChildren(resultBox('neutral', 'info', `${money(r.paymentMinor)} a month for ${plural(r.rows.length, 'month')}`, `${money(r.totalInterestMinor)} interest over the term.`));
        } catch (e) { preview.replaceChildren(resultBox('warning', 'warn', 'Check the terms', friendly(e))); }
      };
      for (const x of [principal, apr, term, first]) x.addEventListener('change', show);
      setTimeout(show); void d;
      return { principal, apr, term, first, fields: [field('Amount financed', principal), field('APR %', apr), field('Months', term),
        field('First payment due', first, 'Empty: a month from today.'), el('div', { class: 'field wide' }, preview)] };
    }, 'Open the contract', (p) => post('/ar/contracts', { invoiceId: inv.id, principal: p.principal.value, apr: p.apr.value, termMonths: p.term.value,
      firstDueOn: p.first.value || undefined }), (r) => `Contract ${r.number} opened at ${money(r.paymentMinor)} a month`);
  }

  // ----------------------------------------------------------- statement
  async function statement(id) {
    const today = todayIso();
    const from = input({ type: 'date', value: today.slice(0, 8) + '01' }), to = input({ type: 'date', value: today });
    const box = el('div', { class: 'ar-print' });
    const load = async () => {
      box.replaceChildren(E.loadingNode());
      try {
        const s = await coApi(`/ar/customers/${id}/statement?from=${from.value}&to=${to.value}`);
        setLabel(s.label);
        box.replaceChildren(
          panel(el('div', { class: 'ar-stmt-h' },
            el('div', {}, el('b', { text: s.company.legal_name || s.company.name }), el('div', { class: 'ar-sub', text: 'Statement of account' })),
            el('div', {}, el('b', { text: s.customer.name }), el('div', { class: 'ar-sub', text: `Account ${s.customer.number}` }),
              el('div', { class: 'ar-sub', text: `${fmtDay(s.from)} to ${fmtDay(s.to)}` })))),
          facts(['Opening balance', money(s.opening)], ['Charges', money(s.charges)], ['Payments and credits', money(s.credits)], ['Closing balance', money(s.closing)]),
          section('Activity', null, null, list(s.lines.map((l) => item({ title: `${l.what}${l.ref && !l.what.includes(l.ref) ? ' · ' + l.ref : ''}`,
            amount: money(Number(l.charges) - Number(l.credits)), detail: `${fmtDay(l.on)} · balance ${money(l.balance)}` })), 'No activity in these dates.')),
          section('How late', null, null, facts(...BUCKETS.map(([k, label]) => [label, money(s.aging[k])]))),
          s.ties ? null : resultBox('serious', 'warn', 'The lines do not add up to the closing balance', 'Tell the controller.'));
      } catch (e) { box.replaceChildren(E.errorBox(e, load)); }
    };
    from.addEventListener('change', load); to.addEventListener('change', load);
    await load();
    return frag(
      head('Statement', [el('button', { class: 'btn primary', type: 'button', onclick: () => window.print() }, 'Print')], LABEL),
      el('div', { class: 'ar-pick ar-noprint' }, el('button', { class: 'linkbtn', type: 'button', onclick: () => go('ar', `account~${id}`) }, '← Account'),
        field('From', from), field('To', to)), box);
  }

  // --------------------------------------------------------- collections
  async function calls() {
    const d = await coApi('/ar/collections');
    setLabel(d.label);
    return frag(
      el('div', { class: 'ar-pick' },
        el('button', { class: 'btn', type: 'button', onclick: (e) => act(e.currentTarget, () => post('/ar/collections/refresh', {}), (r) => `${r.kept} kept, ${r.broken} broken`) }, 'Update promises'),
        el('button', { class: 'btn', type: 'button', onclick: (e) => act(e.currentTarget, () => post('/ar/late-fees', {}), (r) => r.charged ? `${plural(r.charged, 'late fee')} charged, ${money(r.totalMinor)}` : 'No late fees due') }, 'Charge late fees')),
      section('Today’s call list', `${plural(d.list.length, 'account')}, most urgent first`, null, list(d.list.map((x) => item({
        title: x.name, amount: money(x.pastDueMinor),
        badge: chip(x.tier === 3 ? 'serious' : x.tier === 2 ? 'warning' : 'neutral', x.tier === 3 ? 'warn' : 'clock', x.reason),
        detail: [x.phone, `balance ${money(x.balanceMinor)}`, x.lastContact ? `last: ${x.lastContact.kind}${x.lastContact.outcome ? ' (' + x.lastContact.outcome.replace(/_/g, ' ') + ')' : ''}` : 'never contacted'].filter(Boolean).join(' · '),
        why: `1–30 ${money(x.buckets.d1_30)} · 31–60 ${money(x.buckets.d31_60)} · 61–90 ${money(x.buckets.d61_90)} · 90+ ${money(x.buckets.d90_plus)}`,
        acts: [
          x.phone ? el('a', { class: 'btn small', href: `tel:${x.phone}` }, 'Call') : null,
          el('button', { class: 'btn small primary', type: 'button', onclick: () => contactDialog({ id: x.customerId, name: x.name, phone: x.phone }) }, 'Log it'),
          d.templates.length ? el('button', { class: 'btn small', type: 'button', onclick: () => sendDialog({ id: x.customerId, name: x.name }, d.templates) }, 'Send reminder') : null,
          el('button', { class: 'btn small', type: 'button', onclick: () => go('ar', `account~${x.customerId}`) }, 'Account'),
        ].filter(Boolean) })), 'Nobody to call today.')));
  }

  // ---------------------------------------------------------- contracts
  async function contracts() {
    const rows = await coApi('/ar/contracts');
    return section('Installment contracts', plural(rows.length, 'contract'), null, list(rows.map((k) => item({
      title: `${k.number} · ${k.customer}`, amount: money(k.balance_minor),
      detail: `${money(k.payment_minor)} a month · ${pct(k.apr_bps)} APR · ${k.next_due ? 'next due ' + fmtDay(k.next_due) : 'nothing due'}`,
      badge: k.status !== 'active' ? chip(k.status === 'paid_off' ? 'good' : 'serious', k.status === 'paid_off' ? 'ok' : 'warn', cap(k.status.replace('_', ' ')))
        : k.late_installments ? chip('warning', 'clock', `${plural(k.late_installments, 'payment')} late`) : null,
      onClick: () => go('ar', `contract~${k.id}`) })), 'No contracts yet. Open one from a customer’s invoice.'));
  }

  async function contract(id) {
    const d = await coApi(`/ar/contracts/${id}`);
    const k = d.contract, po = d.payoff;
    const live = k.status === 'active' || k.status === 'defaulted';
    const btn = (label, fn, primary) => el('button', { class: 'btn' + (primary ? ' primary' : ''), type: 'button', onclick: fn }, label);
    const actions = live ? [
      btn('Take a payment', () => formDialog('Contract payment', `${k.number} · payoff today ${money(po.payoffMinor)}`, () => {
        const amount = moneyIn(); amount.value = (B(k.payment_minor) / 100).toFixed(2);
        const method = select(METHODS.filter(([m]) => !['gift_card'].includes(m)), 'cash'), ref = input({ maxlength: '40' });
        return { amount, method, ref, lead: 'Interest due is paid first, then principal. The exact payoff amount closes the contract.',
          fields: [field('Amount', amount), field('Paid by', method), field('Reference', ref)] };
      }, 'Take it', (p) => post(`/ar/contracts/${id}/pay`, { amount: p.amount.value, method: p.method.value, reference: p.ref.value }),
      (r) => `${r.number}: ${money(r.principalMinor)} principal, ${money(r.interestMinor)} interest${r.paidOff ? '. Paid off.' : ''}`), true),
      btn('Change terms', () => formDialog('Change the terms', k.number, () => {
        const kind = select([['defer', 'Defer payments'], ['extend', 'Extend the term'], ['refinance', 'Refinance at a new rate']], 'defer');
        const months = input({ inputmode: 'numeric', value: '1' }), term = input({ inputmode: 'numeric', value: String(k.term_months) });
        const apr = input({ inputmode: 'decimal', value: (k.apr_bps / 100).toFixed(2) }), reason = el('textarea', { maxlength: '500' });
        const fm = field('Months to defer', months), ft = field('Months left after the change', term), fa = field('New APR %', apr);
        const sync = () => { fm.hidden = kind.value !== 'defer'; ft.hidden = kind.value === 'defer'; fa.hidden = kind.value !== 'refinance'; };
        kind.addEventListener('change', sync); setTimeout(sync);
        return { kind, months, term, apr, reason, lead: 'Extending or refinancing needs a controller. Interest already due is carried into the first new payment.',
          fields: [field('Change', kind), fm, ft, fa, field('Reason', reason, null, true)] };
      }, 'Change it', (p) => post(`/ar/contracts/${id}/restructure`, { kind: p.kind.value, months: p.months.value, termMonths: p.term.value,
        apr: p.kind.value === 'refinance' ? p.apr.value : undefined, reason: p.reason.value }), 'Terms changed')),
      btn(k.status === 'defaulted' ? 'Take out of default' : 'Put in default', () => formDialog(k.status === 'defaulted' ? 'Take out of default' : 'Put in default', k.number, () => {
        const reason = el('textarea', { maxlength: '500' }); return { reason, fields: [field('Reason', reason, null, true)] };
      }, 'Save', (p) => post(`/ar/contracts/${id}/default`, { defaulted: k.status !== 'defaulted', reason: p.reason.value }), 'Saved')),
      k.status === 'defaulted' ? btn('Record a repossession', () => formDialog('Goods taken back', `${k.number} · a record only; nothing posts`, () => {
        const items = el('textarea', { maxlength: '1000', placeholder: 'What is being taken back' }), on = input({ type: 'date' });
        return { items, on, fields: [field('Items', items, null, true), field('Scheduled for', on)] };
      }, 'Record', (p) => post(`/ar/contracts/${id}/repossession`, { items: p.items.value, scheduledOn: p.on.value || null }), 'Recorded')) : null,
      btn('Write off', () => writeoffDialog({ contractId: id, label: k.number, open: po.principalMinor })),
    ].filter(Boolean) : [];
    return frag(
      head(`${k.number} · ${k.customer}`, actions, `${LABEL} · installment contract`),
      el('p', {}, el('button', { class: 'linkbtn', type: 'button', onclick: () => go('ar', 'contracts') }, '← All contracts')),
      facts(['Status', cap(k.status.replace('_', ' '))], ['Financed', money(k.principal_minor)], ['APR', pct(k.apr_bps)], ['Payment', `${money(k.payment_minor)} a month`],
        ['Principal left', money(po.principalMinor)], ['Interest due', money(po.interestDueMinor)], ['Payoff today', money(po.payoffMinor)], ['From invoice', k.invoice_number || '—']),
      d.repossessions.length ? section('Repossession', null, null, list(d.repossessions.map((r) => item({ title: r.items, badge: chip('neutral', 'info', cap(r.status.replace('_', ' '))),
        detail: [r.scheduled_on ? 'scheduled ' + fmtDay(r.scheduled_on) : null, r.recovered_on ? 'recovered ' + fmtDay(r.recovered_on) : null, r.condition].filter(Boolean).join(' · '),
        acts: live || k.status === 'charged_off' ? [el('button', { class: 'btn small', type: 'button', onclick: () => formDialog('Update the repossession', r.items, () => {
          const st = select([['requested', 'Requested'], ['scheduled', 'Scheduled'], ['recovered', 'Recovered'], ['not_recovered', 'Not recovered'], ['closed', 'Closed']], r.status);
          const on = input({ type: 'date' }), cond = input({ maxlength: '200', value: r.condition || '' });
          return { st, on, cond, fields: [field('Status', st), field('Recovered on', on), field('Condition', cond, null, true)] };
        }, 'Save', (p) => post(`/ar/contracts/${id}/repossession`, { id: r.id, status: p.st.value, recoveredOn: p.on.value || null, condition: p.cond.value }), 'Updated') }, 'Update')] : [] })), '')) : null,
      section('Schedule', null, null, list(d.schedule.map((s) => item({
        title: `${s.version > 1 ? 'v' + s.version + ' · ' : ''}#${s.seq} due ${fmtDay(s.due_on)}`, amount: money(s.payment_minor),
        detail: `principal ${money(s.principal_minor)} · interest ${money(s.interest_minor)}${Number(s.paid_principal_minor) + Number(s.paid_interest_minor) ? ` · paid ${money(Number(s.paid_principal_minor) + Number(s.paid_interest_minor))}` : ''}`,
        badge: s.status === 'paid' ? chip('good', 'ok', 'Paid') : s.status === 'superseded' ? chip('neutral', 'pause', 'Replaced')
          : s.due_on < todayIso() ? chip('warning', 'clock', 'Late') : null })), 'No schedule.')),
      section('History', null, null, list(d.events.map((e) => item({ title: cap(e.kind.replace('_', ' ')), detail: `${fmtDay(e.at)} · ${e.by || ''}`, why: e.reason || null })), '')));
  }

  // ------------------------------------------------------------ finance
  async function finance() {
    const d = await coApi('/ar/finance');
    const picked = new Set();
    const settleBtn = el('button', { class: 'btn primary', type: 'button', disabled: true, onclick: () => {
      const rows = d.awaiting.filter((x) => picked.has(x.id));
      const gross = rows.reduce((a, x) => a + B(x.amount_minor), 0), fee = rows.reduce((a, x) => a + B(x.expected_fee_minor), 0);
      formDialog('Record the lender’s funding', `${plural(rows.length, 'sale')}, ${money(gross)}`, () => {
        const funded = moneyIn(); funded.value = ((gross - fee) / 100).toFixed(2);
        const ref = input({ maxlength: '60', placeholder: 'Batch or deposit reference' }), on = input({ type: 'date', value: todayIso(), max: todayIso() });
        return { funded, ref, on, lead: `The plans say the lender keeps ${money(fee)}. Whatever they actually kept is posted to 6910 and shown against that.`,
          fields: [field('Amount they sent', funded), field('Reference', ref), field('Funded on', on)] };
      }, 'Record', (p) => post('/ar/finance/settlements', { companyId: rows[0].company_id, saleIds: rows.map((x) => x.id), funded: p.funded.value, reference: p.ref.value, fundedOn: p.on.value }),
      (r) => `Fee ${money(r.feeMinor)}${Number(r.varianceMinor) ? `, ${money(r.varianceMinor)} off what the plans say` : ', as expected'}`);
    } }, 'Record funding');
    const companyOf = (id) => (d.companies.find((x) => x.id === id) || {}).name || '';
    const cascadeAmt = moneyIn('Amount to finance'), cascadeOut = el('div');
    const cascadeBtn = el('button', { class: 'btn', type: 'button', onclick: async () => {
      busy(cascadeBtn, true, 'Checking…');
      try {
        const r = await coApi(`/ar/finance/cascade?amount=${encodeURIComponent(cascadeAmt.value)}`);
        cascadeOut.replaceChildren(list(r.lenders.map((l, i) => item({ title: `${i + 1}. ${l.name}`, badge: l === r.next || (r.next && l.id === r.next.id) ? chip('good', 'ok', 'Ask first') : !l.plans.length ? chip('neutral', 'info', 'No plan fits') : null,
          detail: l.plans.map((p) => `${p.name} (lender keeps ${pct(p.fee_bps)})`).join(' · ') || 'Nothing for this amount' })), 'No lenders set up.'));
      } catch (e) { cascadeOut.replaceChildren(resultBox('warning', 'warn', 'Check the amount', friendly(e))); } finally { busy(cascadeBtn, false); }
    } }, 'Who to ask');
    return frag(
      tilesRow(tile({ label: 'Owed by lenders', value: money(d.owedMinor), tone: 'neutral', ic: 'bank', text: Number(d.differenceMinor) === 0 ? 'Ties to GL 1110' : `GL 1110 off by ${money(d.differenceMinor)}` })),
      section('Waiting on funding', 'pick the sales one deposit pays for', [settleBtn], list(d.awaiting.map((x) => {
        const box = el('input', { type: 'checkbox', 'aria-label': `Pick ${x.receipt}`, onchange: (e) => {
          if (e.target.checked) {
            const first = d.awaiting.find((y) => picked.has(y.id));
            if (first && first.company_id !== x.company_id) { e.target.checked = false; toast('One deposit comes from one lender; pick sales from the same one.', 'warning'); return; }
            picked.add(x.id);
          } else picked.delete(x.id);
          settleBtn.disabled = !picked.size;
        } });
        return item({ title: `${x.customer || 'Customer'} · ${x.receipt}`, amount: money(x.amount_minor), pick: box,
          detail: `${companyOf(x.company_id)} · ${x.plan || ''} · lender keeps ${money(x.expected_fee_minor)} · ${fmtDay(x.on_date)}` });
      }), 'Nothing waiting on a lender.')),
      d.unrecorded.length ? section('Financing receipts with no plan', 'say which lender and plan', null, list(d.unrecorded.map((r) => item({
        title: `${r.number} · ${r.customer || ''}`, amount: money(r.amount_minor), detail: fmtDay(r.on_date),
        acts: [el('button', { class: 'btn small', type: 'button', onclick: () => formDialog('Which plan', r.number, () => {
          const plan = select(d.plans.filter((p) => p.active).map((p) => [p.id, `${companyOf(p.company_id)}: ${p.name}`]));
          return { plan, fields: [field('Plan', plan, null, true)] };
        }, 'Save', (p) => post('/ar/finance/sales', { receiptId: r.id, planId: p.plan.value }), 'Recorded') }, 'Pick the plan')] })), '')) : null,
      section('Lender order', null, null, el('div', { class: 'ar-pick' }, cascadeAmt, cascadeBtn), cascadeOut),
      section('Lenders and plans', null, null, list(d.companies.map((co) => item({ title: `${co.cascade_rank}. ${co.name}`, badge: co.status !== 'active' ? chip('neutral', 'pause', 'Inactive') : null,
        detail: d.plans.filter((p) => p.company_id === co.id).map((p) => `${p.name}: lender keeps ${pct(p.fee_bps)}, ${money(p.min_amount_minor)}${p.max_amount_minor ? '–' + money(p.max_amount_minor) : ' and up'}`).join(' · ') || 'No plans' })), 'No lenders set up.')),
      section('Fundings', null, null, list(d.settlements.map((s) => item({ title: `${s.company} · ${s.reference}`, amount: money(s.funded_minor),
        detail: `${fmtDay(s.funded_on)} · sales ${money(s.gross_minor)} · fee ${money(s.fee_minor)}`,
        badge: Number(s.variance_minor) === 0 ? chip('good', 'ok', 'Fee as expected') : chip('warning', 'warn', `Fee off by ${money(s.variance_minor)}`) })), 'No fundings yet.')));
  }

  // ---------------------------------------------------------- write-offs
  async function writeoffs() {
    const rows = await coApi('/ar/writeoffs');
    const me = E.S.person ? E.S.person.id : null;
    return section('Write-offs', 'a second person approves each one', null, list(rows.map((w) => item({
      title: `${w.customer} · ${w.target}`, amount: money(w.amount_minor),
      detail: `${w.method === 'direct' ? 'Bad debt (6900)' : 'Allowance (1190)'} · asked by ${w.requested_by_name || '?'} ${fmtDay(w.requested_at)}${w.decided_by_name ? ` · ${w.status} by ${w.decided_by_name}` : ''}${Number(w.recovered_minor) ? ` · ${money(w.recovered_minor)} recovered` : ''}`,
      why: w.reason, badge: chip(w.status === 'posted' ? 'good' : w.status === 'rejected' ? 'neutral' : 'warning', w.status === 'posted' ? 'ok' : w.status === 'rejected' ? 'x' : 'clock', cap(w.status)),
      acts: w.status === 'pending' ? (w.requested_by === me ? [el('span', { class: 'ar-sub', text: 'Someone else approves this one.' })] : [
        el('button', { class: 'btn small primary', type: 'button', onclick: (e) => act(e.currentTarget, () => post(`/ar/writeoffs/${w.id}/decide`, { decision: 'approved' }), 'Written off') }, 'Approve'),
        el('button', { class: 'btn small', type: 'button', onclick: async (e) => { const note = await E.askReason({ title: 'Reject the write-off', confirm: 'Reject' }); if (note) act(e.target, () => post(`/ar/writeoffs/${w.id}/decide`, { decision: 'rejected', note }), 'Rejected'); } }, 'Reject')])
        : w.status === 'posted' && Number(w.recovered_minor) < Number(w.amount_minor) ? [el('button', { class: 'btn small', type: 'button', onclick: () => formDialog('Money in on a written-off balance', `${w.customer} · ${w.target}`, () => {
          const amount = moneyIn(), method = select(METHODS.filter(([m]) => ['cash', 'card', 'check', 'ach', 'other'].includes(m)), 'cash');
          return { amount, method, lead: 'It is reinstated and collected in one go: the allowance (or bad debt) is credited back.', fields: [field('Amount', amount), field('Paid by', method)] };
        }, 'Record', (p) => post(`/ar/writeoffs/${w.id}/recover`, { amount: p.amount.value, method: p.method.value }), 'Recovery recorded') }, 'Record a recovery')] : [] })), 'No write-offs.'));
  }

  // ------------------------------------------------------------ deposits
  async function deposits() {
    const d = await coApi('/ar/deposits');
    return frag(
      tilesRow(tile({ label: 'Deposits held', value: money(d.totalMinor), tone: Number(d.differenceMinor) === 0 ? 'good' : 'serious', ic: Number(d.differenceMinor) === 0 ? 'ok' : 'warn',
        text: Number(d.differenceMinor) === 0 ? `Ties to GL 2300 (${money(d.glMinor)})` : `GL 2300 says ${money(d.glMinor)}; off by ${money(d.differenceMinor)}` })),
      d.unposted.length ? section('Taken but never posted', 'these explain a difference', null, list(d.unposted.map((r) => item({ title: r.number, amount: money(r.amount_minor), detail: fmtDay(r.received_at) })), '')) : null,
      section('Held on orders', 'paid and not yet delivered', null, list(d.orders.map((o) => item({ title: `${o.number} · ${o.customer || 'No customer'}`, amount: money(o.held_minor),
        detail: `${o.location} · ${cap(o.status)} · paid ${money(o.paid_minor)}, applied ${money(o.applied_minor)}` })), 'No deposits held.')),
      d.unassigned.length ? section('Taken with no order', null, null, list(d.unassigned.map((r) => item({ title: `${r.number} · ${r.customer || ''}`, amount: money(r.amount_minor), detail: fmtDay(r.received_at) })), '')) : null);
  }

  // ------------------------------------------------------------ settings
  async function settings() {
    const s = await coApi('/ar/settings');
    const enabled = select([['yes', 'Charge late fees'], ['no', 'Do not charge late fees']], s.late_fee_enabled ? 'yes' : 'no');
    const rate = input({ inputmode: 'decimal', value: (s.late_fee_bps / 100).toFixed(2) }), grace = input({ inputmode: 'numeric', value: String(s.late_fee_grace_days) });
    const min = moneyIn(); min.value = (B(s.late_fee_min_minor) / 100).toFixed(2);
    const max = moneyIn('No cap'); max.value = s.late_fee_max_minor === null ? '' : (B(s.late_fee_max_minor) / 100).toFixed(2);
    const terms = input({ inputmode: 'numeric', value: String(s.default_terms_days) }), callAfter = input({ inputmode: 'numeric', value: String(s.call_after_days) });
    const method = select([['allowance', 'Against the allowance (1190)'], ['direct', 'Straight to bad debt (6900)']], s.writeoff_method);
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post('/ar/settings', { lateFeeEnabled: enabled.value === 'yes', lateFeeRate: rate.value,
      graceDays: grace.value, minFee: min.value, maxFee: max.value, defaultTerms: terms.value, writeoffMethod: method.value, callAfterDays: callAfter.value }), 'Settings saved') }, 'Save');
    return section('Policy', 'a controller or the owner changes these', [save], panel(el('div', { class: 'form-grid ar-pad' },
      field('Late fees', enabled), field('Rate a month (%)', rate, 'On the overdue balance of each invoice, once a month.'), field('Grace days', grace),
      field('Minimum fee', min), field('Maximum fee', max), field('Default terms (days)', terms), field('Write-offs go', method),
      field('On the call list after (days late)', callAfter))));
  }

  E.register('ar', LABEL, 'cash', screen, 'Back office');
  void render; void capped;
})();
