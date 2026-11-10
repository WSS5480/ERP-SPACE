// group screen. Registers with window.ERP (see docs/MODULES.md).
// Back office → Group: the client's companies together.
//   View         P&L for a range and balance sheet as of a day: each company
//                side by side, what is eliminated, and the combined total. On a
//                phone, one card per account group with the per-company
//                breakdown folded inside.
//   Inter-company  per pair of companies, due from against due to, with Settle;
//                the matching documents (sales invoice / bill pairs); Bill a
//                sibling company; a one-sided entry.
//   Settings     the transfer price (cost, or cost plus a markup) and the
//                sibling customer and vendor links.
// Home gets an "Inter-company out of balance" card for the owner and the
// controller when a pair does not net to zero. Data goes in with textContent only.
(() => {
  'use strict';
  const E = window.ERP;
  if (!E) return;
  const { S, el, frag, chip, money, plural, coApi, post, go, act, openDialog, resultBox, fillDialog,
    head, section, tile, tilesRow, empty, item, seg, fact, friendly, render, todayIso, NARROW, tbl, td, field, select, input } = E;

  const B = (v) => BigInt(String(v == null ? '0' : v));
  const errInto = (box) => (e) => box.replaceChildren(resultBox('critical', 'fail', 'Not done', friendly(e)));
  const F = { tab: 'view', from: null, to: null, asOf: null, pick: null, open: {} };

  function style() {
    if (window.__grpSheet) return;
    const sheet = new CSSStyleSheet();
    window.__grpSheet = sheet;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    sheet.replaceSync(`
.gr-controls{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end;margin:0 0 12px}
.gr-controls .field{min-width:140px;flex:1 1 140px}
.gr-cos{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 0 10px}
.gr-card{border:1px solid var(--line-2);border-radius:14px;background:var(--panel);margin:0 0 10px;overflow:hidden}
.gr-card > .gr-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:12px 14px}
.gr-card > .gr-top b{font-size:15.5px}
.gr-amt{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;font-weight:650}
.gr-rows{padding:0 14px 10px}
.gr-row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-top:1px solid var(--line-1, rgba(0,0,0,.06));font-size:14px}
.gr-row .gr-amt{font-weight:560}
.gr-row.el{color:var(--muted)}
.gr-row.tot{font-weight:700}
.gr-card details{border-top:1px solid var(--line-2)}
.gr-card summary{cursor:pointer;padding:9px 14px;font-size:14px;display:flex;justify-content:space-between;gap:12px;list-style:none}
.gr-card summary::-webkit-details-marker{display:none}
.gr-card summary .gr-name{overflow-wrap:anywhere}
.gr-card details .gr-rows{padding:0 14px 10px 26px}
.gr-ic{font-size:12px;font-weight:650;color:var(--muted);margin-left:6px}
.gr-tbl td.first{min-width:180px}
.gr-tbl tr.sec td{font-weight:700;padding-top:14px}
.gr-tbl tr.sum td{font-weight:650;border-top:1px solid var(--line-2)}
.gr-tbl tr.total td{font-weight:750;border-top:2px solid var(--line-2)}
.gr-tbl td.el, .gr-tbl th.el{color:var(--muted)}
.gr-pair .facts{grid-template-columns:repeat(2,minmax(0,1fr))}
`);
  }

  const visible = (s) => s.groups.filter((x) => x.accounts.length);

  // ================================================================ screen
  async function screen(sub) {
    style();
    if (sub && ['view', 'ic', 'settings'].includes(sub)) F.tab = sub;
    if (!S.person) return frag(head('Group', null, 'Back office'), el('div', { class: 'panel' }, empty('Pick who you are first.', 'The group view is for the owner and the companies’ controllers.', true)));
    const d = await coApi('/group');
    if (d.total < 2) {
      return frag(head('Group', null, 'Back office'), el('div', { class: 'panel' }, empty('This client has one company.',
        'Group accounting starts when a second company is set up under the same client: consolidated statements, inter-company billing and settling.', true)));
    }
    if (!d.viewable.length) {
      return frag(head('Group', null, 'Back office'), el('div', { class: 'panel' }, empty('Not for this person.',
        'The group view is for the owner, or a controller in every company it includes.', true)));
    }
    const off = d.net ? d.net.pairs.filter((p) => !p.balanced).length + d.net.ties.filter((x) => !x.ties).length : 0;
    const tabs = el('div', { class: 'toolbar' }, seg([['view', 'Group view'], ['ic', 'Inter-company', off || null], ['settings', 'Settings']], F.tab,
      (v) => { F.tab = v; go('group', v); }));
    const body = F.tab === 'ic' ? icTab(d) : F.tab === 'settings' ? settingsTab(d) : await viewTab(d);
    const billBtn = el('button', { class: 'btn primary', type: 'button', onclick: () => openBill(d) }, 'Bill a sibling company');
    return frag(head('Group', [billBtn], 'Back office'),
      el('p', { class: 'lead', text: `${plural(d.total, 'company', 'companies')} under ${S.co.tenant_name || 'this client'}. Inter-company balances are eliminated from the combined total; each company keeps its own books.` }),
      tabs, body);
  }

  // ============================================================ group view
  async function viewTab(d) {
    const today = todayIso();
    F.from = F.from || today.slice(0, 8) + '01';
    F.to = F.to || today;
    F.asOf = F.asOf || F.to;
    if (!F.pick) F.pick = d.viewable.map((x) => x.id);
    const from = input({ type: 'date', value: F.from }), to = input({ type: 'date', value: F.to }), asOf = input({ type: 'date', value: F.asOf });
    const boxes = d.companies.map((x) => [x, el('input', { type: 'checkbox', checked: F.pick.includes(x.id) })]);
    const out = el('div');
    const show = el('button', { class: 'btn primary', type: 'button', onclick: () => {
      F.from = from.value || F.from; F.to = to.value || F.to; F.asOf = asOf.value || F.to;
      F.pick = boxes.filter(([, b]) => b.checked).map(([x]) => x.id);
      draw();
    } }, 'Show');
    const draw = async () => {
      out.replaceChildren(E.loadingNode());
      try {
        const v = await coApi(`/group/view?companies=${encodeURIComponent(F.pick.join(','))}&from=${F.from}&to=${F.to}&asOf=${F.asOf}`);
        out.replaceChildren(drawView(v));
      } catch (e) { out.replaceChildren(resultBox('critical', 'fail', 'Can’t show that', friendly(e))); }
    };
    draw();
    return frag(
      el('div', { class: 'gr-cos', role: 'group', 'aria-label': 'Companies to include' }, boxes.map(([x, b]) => el('label', { class: 'check' }, b, x.name))),
      el('div', { class: 'gr-controls' }, field('P&L from', from), field('to', to), field('Balance sheet as of', asOf), show),
      out);
  }

  function drawView(v) {
    const cos = v.companies;
    const ni = v.netIncome;
    const bc = v.balanceCheck;
    const el0 = v.eliminations;
    const tiles = tilesRow(
      tile({ label: 'Combined net income', value: money(ni.combinedMinor), tone: B(ni.combinedMinor) < 0n ? 'warning' : 'good' }),
      tile({ label: 'Sum of the companies', value: money(ni.sumMinor) }),
      tile({ label: 'Eliminated from P&L', value: money(el0.totalPnlMinor), tone: 'neutral' }),
      tile({ label: 'Due from / to eliminated', value: money(el0.dueFromMinor), suffix: B(el0.dueFromMinor) === B(el0.dueToMinor) ? ' each' : ` / ${money(el0.dueToMinor)}` }));
    const warn = bc.balanced ? null : resultBox('serious', 'warn', 'The combined balance sheet is off',
      `Between these companies, due from and due to differ by ${money(bc.combinedMinor)}. Open Inter-company to see which pair, then settle it.`);
    const margin = B(el0.marginInStockMinor) !== 0n ? el('p', { class: 'foot', text: `Markup on goods bought from a sibling and still in stock (${money(el0.marginInStockMinor)}) is taken out of inventory and earnings; markup on goods since sold outside the group or written off (${money(el0.markupRealizedMinor)} in this period) is taken out of cost of goods. At cost (the default transfer price) there is none.` }) : null;
    const pnl = v.groups.filter((g) => g.statement === 'pnl');
    const bs = v.groups.filter((g) => g.statement === 'bs');
    const niRow = { label: 'Net income', ...ni };
    const body = NARROW.matches
      ? frag(section('Profit and loss', `${E.shortDay(v.from)} to ${E.shortDay(v.to)}`, null, cards(pnl, cos), totalCard(niRow, cos)),
          section('Balance sheet', `as of ${E.shortDay(v.asOf)}`, null, cards(bs, cos)))
      : frag(section('Profit and loss', `${E.shortDay(v.from)} to ${E.shortDay(v.to)}`, null, el('div', { class: 'panel' }, table(pnl, cos, niRow))),
          section('Balance sheet', `as of ${E.shortDay(v.asOf)}`, null, el('div', { class: 'panel' }, table(bs, cos, null))));
    return frag(tiles, warn, body, margin,
      el('p', { class: 'foot', text: 'Combined = the companies added together, less what is eliminated: amounts due between them (1195, 2190), inter-company sales and cost (4090, 5090), and margin still in stock.' }));
  }

  /** Phone: one card per account group; the per-company breakdown and the accounts fold inside. */
  function cards(groups, cos) {
    const shown = groups.filter((g) => g.accounts.length);
    if (!shown.length) return el('div', { class: 'panel' }, empty('Nothing posted.', null, true));
    return frag(shown.map((g) => {
      const key = 'g-' + g.id;
      const split = el('details', { open: F.open[key] ? true : null, ontoggle: (e) => { F.open[key] = e.currentTarget.open; } },
        el('summary', {}, el('span', { text: 'By company' }), el('span', { class: 'gr-amt', text: plural(cos.length, 'company', 'companies') })),
        el('div', { class: 'gr-rows' }, rowsFor(g, cos)));
      const accts = el('details', {},
        el('summary', {}, el('span', { text: 'Accounts' }), el('span', { class: 'gr-amt', text: String(g.accounts.length) })),
        g.accounts.map((a) => el('details', {},
          el('summary', {}, el('span', { class: 'gr-name' }, `${a.code === 'earnings' ? '' : a.code + ' '}${a.name}`, a.intercompany ? el('span', { class: 'gr-ic', text: 'inter-company' }) : null),
            el('span', { class: 'gr-amt', text: money(a.combinedMinor) })),
          el('div', { class: 'gr-rows' }, rowsFor(a, cos)))));
      return el('div', { class: 'gr-card' },
        el('div', { class: 'gr-top' }, el('b', { text: g.label }), el('span', { class: 'gr-amt', text: money(g.combinedMinor) })),
        split, accts);
    }));
  }
  function totalCard(t, cos) {
    return el('div', { class: 'gr-card' }, el('div', { class: 'gr-top' }, el('b', { text: t.label }), el('span', { class: 'gr-amt', text: money(t.combinedMinor) })),
      el('div', { class: 'gr-rows' }, rowsFor(t, cos)));
  }
  function rowsFor(x, cos) {
    return frag(cos.map((c) => el('div', { class: 'gr-row' }, el('span', { text: c.name }), el('span', { class: 'gr-amt', text: money(x.byCompany[c.id]) }))),
      B(x.eliminatedMinor) !== 0n ? el('div', { class: 'gr-row el' }, el('span', { text: 'Eliminated' }), el('span', { class: 'gr-amt', text: money(-B(x.eliminatedMinor)) })) : null,
      el('div', { class: 'gr-row tot' }, el('span', { text: 'Combined' }), el('span', { class: 'gr-amt', text: money(x.combinedMinor) })));
  }

  /** Wide screens: companies side by side, then eliminations and the combined total. Numbers sit right under right-aligned headers. */
  function table(groups, cos, total) {
    const rows = [];
    const nums = (x) => [...cos.map((c) => td(money(x.byCompany[c.id]), 'm')), td(B(x.eliminatedMinor) ? money(-B(x.eliminatedMinor)) : '—', 'm el'), td(money(x.combinedMinor), 'm')];
    for (const g of groups.filter((x) => x.accounts.length)) {
      rows.push(el('tr', { class: 'sec' }, el('td', { class: 'first', text: g.label }), cos.map(() => el('td')), el('td'), el('td')));
      for (const a of g.accounts) rows.push(el('tr', {}, el('td', { class: 'first' }, `${a.code === 'earnings' ? '' : a.code + ' '}${a.name}`, a.intercompany ? el('span', { class: 'gr-ic', text: 'inter-company' }) : null), nums(a)));
      rows.push(el('tr', { class: 'sum' }, el('td', { class: 'first', text: `Total ${g.label.toLowerCase()}` }), nums(g)));
    }
    if (total) rows.push(el('tr', { class: 'total' }, el('td', { class: 'first', text: total.label }), nums(total)));
    if (!rows.length) return empty('Nothing posted.', null, true);
    return tbl([['Account', 'first'], ...cos.map((c) => [c.name, 'm']), ['Eliminated', 'm el'], ['Combined', 'm']], rows, { cls: 'gr-tbl' });
  }

  // ======================================================== inter-company
  function icTab(d) {
    const n = d.net;
    const pairs = n ? n.pairs.filter((p) => p.active || !p.balanced) : [];
    const ties = n ? n.ties.filter((x) => !x.ties) : [];
    const oneSide = el('button', { class: 'btn small', type: 'button', onclick: () => openAdjust(d) }, 'One-sided entry');
    return frag(
      section('Net to zero', 'what each company says the other owes', [oneSide],
        el('div', { class: 'panel' }, pairs.length ? pairs.map((p) => pairItem(p, d)) : empty('Nothing is owed between the companies.', 'Inter-company sales, transfers and charges show here until they are settled.', true))),
      ties.length ? section('Posted outside Group', null, null, el('div', { class: 'panel' }, ties.map((x) => item({
        title: x.name, amount: money(x.untrackedMinor), badge: chip('serious', 'warn', 'Not tracked'),
        detail: 'An amount sits in 1195 or 2190 that was not booked through Group, so no pair carries it. Reverse it in Books and book it here as a one-sided entry.' })))) : null,
      section('Documents', 'each one a sales invoice and a matching bill', null,
        el('div', { class: 'panel' }, d.documents.length ? d.documents.map(docItem) : empty('No inter-company documents yet.', 'Ship a transfer to another company’s store, or bill a sibling company.', true))),
      d.settlements.length ? section('Settlements', null, null, el('div', { class: 'panel' }, d.settlements.map((x) => item({
        title: `${x.number} · ${x.payer} paid ${x.payee}`, amount: money(x.amount_minor),
        detail: [E.dayLabel(x.settled_on), B(x.payer_difference_minor) || B(x.payee_difference_minor) ? `difference written off: ${x.reason}` : null].filter(Boolean).join(' · ') })))) : null);
  }

  function pairItem(p, d) {
    const badge = p.balanced ? chip('good', 'ok', 'Nets to zero') : chip('serious', 'warn', `Off by ${money(p.differenceMinor)}`);
    const said = (x, other) => B(x.netMinor) > 0n ? `${x.name} says ${other.name} owes it ${money(x.netMinor)}` : B(x.netMinor) < 0n ? `${x.name} says it owes ${other.name} ${money(-B(x.netMinor))}` : `${x.name} shows nothing open with ${other.name}`;
    const canSettle = d.viewable.some((x) => x.id === p.a.id) && d.viewable.some((x) => x.id === p.b.id);
    const settle = canSettle && p.active ? el('button', { class: 'btn small primary', type: 'button', onclick: () => openSettle(p) }, 'Settle') : null;
    return el('div', { class: 'gr-pair' }, item({ title: `${p.a.name} ↔ ${p.b.name}`, badge,
      amount: B(p.a.netMinor) !== 0n ? money(B(p.a.netMinor) < 0n ? -B(p.a.netMinor) : p.a.netMinor) : null,
      detail: [said(p.a, p.b), said(p.b, p.a), p.openDocuments ? plural(p.openDocuments, 'open document') : null].filter(Boolean).join(' · '),
      acts: settle ? [settle] : null }));
  }

  function docItem(x) {
    const st = x.status === 'settled' ? chip('good', 'ok', 'Settled')
      : B(x.paid_minor) > 0n ? chip('warning', 'clock', `Part-paid, ${money(B(x.amount_minor) - B(x.paid_minor))} left`) : chip('warning', 'clock', 'Open');
    return item({ title: `${x.number} · ${x.from_name} → ${x.to_name}`, amount: money(x.amount_minor), badge: st,
      detail: [x.description, x.kind === 'goods' ? `cost ${money(x.cost_minor)}${x.basis === 'cost_plus' ? ` + ${(x.markup_bps / 100).toFixed(2).replace(/\.00$/, '')}%` : ''}` : 'charge',
        x.invoice_number ? `invoice ${x.invoice_number}` : null, x.bill_reference ? `bill ${x.bill_reference}` : null,
        x.to_transfer_number ? `landed as ${x.to_transfer_number}` : null, x.settlement_number ? `settled by ${x.settlement_number}` : null, E.dayLabel(x.doc_date)].filter(Boolean).join(' · ') });
  }

  function openSettle(p) {
    const payerIsA = B(p.a.netMinor) < 0n || (B(p.a.netMinor) === 0n && B(p.b.netMinor) > 0n);
    const payer = payerIsA ? p.a : p.b, payee = payerIsA ? p.b : p.a;
    const owes = B(payer.netMinor) < 0n ? -B(payer.netMinor) : 0n;
    const dlg = openDialog(`Settle ${p.a.name} and ${p.b.name}`, `${payer.name} pays ${payee.name}`);
    const amt = input({ inputmode: 'decimal', value: (Number(owes) / 100).toFixed(2), 'aria-label': 'Amount paid', disabled: p.balanced ? null : true });
    const why = el('textarea', { rows: '2', maxlength: '300', placeholder: p.balanced ? 'Optional' : 'Why the two books differ' });
    const err = el('div');
    const go2 = el('button', { class: 'btn primary', type: 'button', onclick: () => act(go2, () => post('/group/settle', { a: p.a.id, with: p.b.id, amount: p.balanced ? amt.value : null, reason: why.value }),
      (r) => `${r.number}: ${r.payer} paid ${r.payee} ${money(r.amountMinor)}; ${plural(r.documents, 'document')} settled${B(r.leftOpenMinor) > 0n ? `, ${money(r.leftOpenMinor)} still open` : ''}.`, { errorInto: errInto(err), close: dlg.close }) }, 'Record the payment');
    dlg.body.append(
      p.balanced ? resultBox('good', 'ok', 'The two books agree', `${payer.name} owes ${payee.name} ${money(owes)}. Paying all of it clears both sides and marks their open invoices and bills paid; paying less leaves the rest open, and the oldest documents are paid first.`)
        : resultBox('serious', 'warn', `The books differ by ${money(p.differenceMinor)}`, `${payer.name}’s books say it owes ${money(owes)}, so that is the payment; ${payee.name}’s say it is owed ${money(payee.netMinor)}. The difference is written off to 6800 in the book it sits in: give a reason. Over the group’s write-off limit only the owner can.`),
      el('div', { class: 'form-grid' }, field('Amount paid', amt, `From ${payer.name}’s operating account to ${payee.name}’s`), field('Reason', why, null, true)),
      el('div', { class: 'dlg-acts' }, go2, el('button', { class: 'btn', type: 'button', onclick: dlg.close }, 'Cancel')), err);
  }

  function openBill(d) {
    const dlg = openDialog('Bill a sibling company', `${S.co.name} bills one of the client’s other companies`, { wide: true });
    fillDialog(dlg, async () => {
      const L = await coApi('/group/locations');
      const others = d.companies.filter((x) => x.id !== S.co.id);
      const to = select(others.map((x) => [x.id, x.name]), others[0] && others[0].id);
      const theirs = el('div');
      let toLoc = null;
      const drawTheirs = () => {
        toLoc = select([['', 'No particular store'], ...L.locations.filter((l) => l.entity_id === to.value).map((l) => [l.id, l.name])], '');
        theirs.replaceChildren(field('Their store', toLoc, 'Where the cost lands in their books'));
      };
      to.onchange = drawTheirs; drawTheirs();
      const desc = input({ placeholder: 'Delivery for October, 42 stops' }), amt = input({ inputmode: 'decimal', placeholder: '0.00' });
      const err = el('div');
      const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post('/group/bill', { to: to.value, description: desc.value, amount: amt.value,
        toLocationId: toLoc.value || null }), (r) => `${r.number}: invoice ${r.invoiceNumber} here, a matching bill there.`, { errorInto: errInto(err), close: dlg.close }) }, 'Bill them');
      return frag(
        el('p', { class: 'lead', text: 'Makes a matching pair: a sales invoice here (Dr 1195 due from, Cr 4090 inter-company sales) and a bill in their books (Dr 5090 inter-company cost, Cr 2190 due to). It is settled in Group, not in a payment run.' }),
        el('div', { class: 'form-grid' }, field('Company billed', to), theirs, field('What for', desc, null, true), field('Amount', amt)),
        el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: dlg.close }, 'Cancel')), err);
    });
  }

  function openAdjust(d) {
    const dlg = openDialog('One-sided inter-company entry', `${S.co.name}’s books only`);
    const others = d.companies.filter((x) => x.id !== S.co.id);
    const other = select(others.map((x) => [x.id, x.name]), others[0] && others[0].id);
    const kind = select([['charge', 'They owe us (Dr 1195 due from)'], ['credit', 'We owe them (Cr 2190 due to)']], 'charge');
    const amt = input({ inputmode: 'decimal', placeholder: '0.00' }), code = input({ value: '6800', maxlength: '20' });
    const why = el('textarea', { rows: '2', maxlength: '300', placeholder: 'What it is, and why the other company has not booked it yet' });
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post('/group/adjust', { counterparty: other.value, kind: kind.value, amount: amt.value,
      offsetCode: code.value, reason: why.value }), 'Booked here; the pair shows out of balance until the other company books its side.', { errorInto: errInto(err), close: dlg.close }) }, 'Book it');
    dlg.body.append(
      resultBox('neutral', 'info', 'Only this company’s side', 'Use it when the other company will book its side later. Until it does, the pair shows as out of balance on the net-to-zero check.'),
      el('div', { class: 'form-grid' }, field('Other company', other), field('Which way', kind), field('Amount', amt), field('Other account', code, 'An ordinary account, not 1195, 2190, 4090 or 5090'),
        field('Reason', why, null, true)),
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: dlg.close }, 'Cancel')), err);
  }

  // ============================================================ settings
  function settingsTab(d) {
    const st = d.settings || { basis: 'cost', markupBps: 0, writeoffCapMinor: '0' };
    const cap = input({ inputmode: 'decimal', value: (Number(st.writeoffCapMinor || 0) / 100).toFixed(2), 'aria-label': 'Write-off limit' });
    const basis = select([['cost', 'Cost (average cost when it leaves)'], ['cost_plus', 'Cost plus a markup']], st.basis);
    const pct = input({ inputmode: 'decimal', value: st.basis === 'cost_plus' ? String(st.markupBps / 100) : '', placeholder: '10', disabled: st.basis === 'cost' ? true : null });
    basis.onchange = () => { pct.disabled = basis.value === 'cost'; };
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post('/group/settings', { basis: basis.value, markupPct: pct.value || 0, writeoffCap: cap.value }),
      'Group settings saved', { errorInto: errInto(err) }) }, 'Save');
    const link = el('button', { class: 'btn', type: 'button', onclick: () => act(link, () => post('/group/links'),
      (r) => (r.customers || r.vendorLinks ? `${plural(r.customers, 'customer')} and ${plural(r.vendorLinks, 'vendor link')} added` : 'Every company is already linked')) }, 'Link them now');
    return frag(
      section('Transfer price and write-offs', 'for stock moving between companies', null, el('div', { class: 'panel' },
        el('div', { class: 'form-grid' }, field('Priced at', basis), field('Markup %', pct, 'Applies to new transfers'),
          field('Write-off limit', cap, 'A controller may write off an inter-company difference up to this to 6800; above it, only the owner. Only the owner changes it.')),
        el('div', { class: 'dlg-acts' }, save), err)),
      section('Sibling links', d.links.complete ? 'every company is linked' : 'made on first use, or now', [link],
        el('div', { class: 'panel' }, d.links.pairs.map((p) => item({ title: `${p.company} → ${p.sibling}`,
          badge: p.linked ? chip('good', 'ok', 'Linked') : chip('neutral', 'pending', 'Not yet'),
          detail: p.linked ? `${p.sibling} is customer ${p.customerNumber} and a vendor in ${p.company}` : `${p.sibling} becomes a customer and a vendor of ${p.company} on first use` })))));
  }

  E.register('group', 'Group', 'building', screen, 'Back office');

  // ============================================================== Home
  E.homeCard(async () => {
    if (!S.person || (S.modules && !S.modules.includes('group'))) return null;
    if (!S.person.roles.some((r) => r === 'owner' || r === 'controller')) return null;
    const r = await coApi('/group/home');
    if (!r.show) return null;
    style();
    return section('Inter-company out of balance', null, null, el('div', { class: 'panel' },
      r.pairs.map((p) => item({ title: `${p.a.name} ↔ ${p.b.name}`, amount: money(p.differenceMinor), badge: chip('serious', 'warn', 'Does not net to zero'),
        detail: `${p.a.name} shows ${money(p.a.netMinor)} net, ${p.b.name} ${money(p.b.netMinor)}. Settle it, or book the missing side.`, onClick: () => go('group', 'ic') })),
      r.untracked.map((x) => item({ title: x.name, amount: money(x.untrackedMinor), badge: chip('serious', 'warn', 'Posted outside Group'),
        detail: 'An amount in 1195 or 2190 that no pair carries.', onClick: () => go('group', 'ic') }))));
  });

  NARROW.addEventListener('change', () => { if (S.co && S.route.screen === 'group' && !document.querySelector('dialog[open]')) render(); });
})();
