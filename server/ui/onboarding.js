// Setup checklist: what is left to set up for this company, worked out from
// its data (never ticked by hand). On Home for the owner and controllers until
// it is finished or hidden, and under Setup, Setup checklist. Each step says
// why it matters, opens the screen where it is done, and has a short help
// panel. Also here: the company's own details, opening stock from a CSV and
// bank opening balances. Values are placed with textContent only.
(() => {
  'use strict';
  const E = window.ERP;
  const { el, frag, head, section, item, chip, empty, toast, act, openDialog, field, select, input, post, coApi, plural, ago, resultBox, money, tile, tilesRow } = E;

  const sheet = new CSSStyleSheet();
  sheet.replaceSync('.ob-checks{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}'
    + '.ob-checks li{display:flex;gap:8px;align-items:flex-start;font-size:.92em;line-height:1.35}'
    + '.ob-checks li .mk{flex:0 0 auto;font-weight:600;min-width:3.6em}.ob-checks li.ok .mk{color:var(--good,#1a7f37)}.ob-checks li.no .mk{color:var(--serious,#b35900)}'
    + '.ob-pad{padding:0 16px 12px}.ob-checks li .dt{color:var(--muted,#666)}.ob-step .acts{flex-wrap:wrap}.ob-rows .li .d{white-space:normal}');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  const roles = () => (E.S.person && E.S.person.roles) || [];
  const manages = () => roles().some((r) => r === 'owner' || r === 'controller');
  const isOwner = () => roles().includes('owner');
  const STATUS = { done: ['good', 'ok', 'Done'], todo: ['warning', 'clock', 'To do'], skipped: ['neutral', 'pause', 'Skipped'], optional: ['neutral', 'info', 'Optional'] };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const btn = (label, onclick, primary) => el('button', { class: 'btn small' + (primary ? ' primary' : ''), type: 'button', onclick }, label);

  /** Where a step's button goes: its own screen, or a dialog here. */
  function openStep(s) {
    if (s.id === 'company' || s.sub === 'company') return companyDialog();
    if (s.id === 'opening' || s.sub === 'opening') return openingDialog();
    if (s.id === 'golive') return E.render();
    E.go(s.screen, s.sub || undefined);
  }

  function helpDialog(s) {
    const d = openDialog(s.title, 'What this step is');
    d.body.append(
      el('p', { class: 'lead', text: s.why }),
      el('div', { class: 'k', text: 'What it is' }), el('p', { text: s.what }),
      el('div', { class: 'k', text: s.skippable ? 'If you skip it' : 'Skipping' }), el('p', { text: s.skipped }),
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn primary', type: 'button', onclick: () => { d.close(); openStep(s); } }, s.label),
        el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Close')));
  }

  async function skip(s, b) {
    const why = await E.askReason({ title: `Skip ${s.title.toLowerCase()}?`, sub: E.S.co.name, label: 'Why it is being skipped',
      placeholder: 'e.g. We do not deliver; customers collect from the store.', confirm: 'Skip it', lead: s.skipped });
    if (why == null) return;
    act(b, () => post('/onboarding/skip', { step: s.id, reason: why }), `${s.title} skipped`);
  }

  function checksList(s) {
    return el('ul', { class: 'ob-checks' }, s.checks.map((x) => el('li', { class: x.ok ? 'ok' : 'no' },
      el('span', { class: 'mk', text: x.ok ? 'Done' : 'Needed' }),
      el('span', {}, el('span', { text: x.label }), x.detail ? el('span', { class: 'dt', text: ` · ${x.detail}` }) : null))));
  }

  /** Go-live (0066): what ERP setup approved during setup, for the owner to review, then the Go live button. */
  function setupLine(x) {
    return item({ title: x.title, detail: [x.detail, x.reason ? `Support reason: ${x.reason}` : null, ago(x.at)].filter(Boolean).join(' · '),
      amount: x.amountMinor != null ? money(x.amountMinor) : null,
      badge: x.decision === 'rejected' ? chip('critical', 'fail', 'Rejected during setup') : chip('neutral', 'ok', 'Approved during setup'),
      onClick: x.link ? () => E.openSubject(x.link) : null });
  }
  function setupDrill(list, title) {
    return E.drillItems(title, list.map(setupLine), { noun: 'approval', none: 'Nothing here.',
      foot: 'ERP setup approved these for you in support mode, before go-live. Tap one to open its record; Back returns to the checklist.' });
  }
  function goLivePanel(d, s) {
    const list = s.setupApprovals || [];
    const live = d.wentLive;
    if (live) {
      return el('div', { class: 'ob-pad' }, resultBox('good', 'ok', live.bySale ? 'Trading has begun' : 'Gone live',
        live.bySale ? 'This company has begun trading (money in or out, or a sale, is in its books), so it counts as live: ERP setup no longer approves anything for it.'
          : `Went live ${ago(live.at)}, by ${live.by}${live.setupItems ? `, after reviewing ${plural(live.setupItems, 'approval')} made by ERP setup` : ''}. From then on ERP setup approves nothing for this company.`),
        list.length ? el('button', { class: 'btn small', type: 'button', onclick: () => setupDrill(list, 'Approved by ERP setup') }, `What ERP setup approved (${list.length})`) : null);
    }
    const groups = ['Vendors', 'Employees', 'Opening entries', 'Periods'].map((k) => [k, list.filter((x) => x.kind === k)]).filter(([, l]) => l.length);
    const tick = el('input', { type: 'checkbox' });
    const err = el('div', { role: 'alert' });
    const owner = isOwner() && !E.inSupport();
    const ready = s.status === 'done';
    const go = el('button', { class: 'btn primary', type: 'button', disabled: !owner || !ready || null, onclick: (e) => {
      if (list.length && !tick.checked) { err.replaceChildren(resultBox('warning', 'warn', 'Tick the review first', 'Look over what ERP setup approved, then tick that you reviewed it.')); return; }
      act(e.currentTarget, () => post('/onboarding/go-live', { reviewed: tick.checked ? list.map((x) => x.requestId) : null }), 'Gone live', { errorInto: (x) => err.replaceChildren(resultBox('critical', 'fail', 'Not live yet', E.friendly(x))) });
    } }, E.icon('check'), 'Go live');
    return el('div', { class: 'ob-pad' },
      el('div', { class: 'k', text: 'Approved by ERP setup' }),
      list.length
        ? frag(el('p', { class: 'd', text: `ERP setup approved ${plural(list.length, 'record')} for you in support mode while setting the company up. Look them over before going live; tap one to open it.` }),
          tilesRow(tile({ label: 'Approved during setup', value: String(list.length), tone: 'warning', ic: 'info', text: 'Tap for the list', onClick: () => setupDrill(list, 'Approved by ERP setup') })),
          groups.map(([k, l]) => section(k, String(l.length), null, el('div', { class: 'panel' }, l.map(setupLine)))),
          el('label', { class: 'li check-row' }, tick, el('div', { class: 't', text: 'I’ve reviewed what ERP setup approved' })))
        : el('p', { class: 'd', text: 'ERP setup has not approved anything for this company.' }),
      E.inSupport() ? el('p', { class: 'fine', text: 'Go live is the owner’s own step, signed in as themselves; ERP setup cannot press it in support mode. Until then, ERP setup may approve new vendors, new hires, opening entries and periods.' })
        : !isOwner() ? el('p', { class: 'fine', text: 'Only the owner takes the company live.' })
          : !ready ? el('p', { class: 'fine', text: 'Go live opens once the check above passes.' }) : null,
      el('p', { class: 'fine', text: 'Once you go live, ERP setup approves nothing more for this company, and that cannot be undone.' }),
      el('div', { class: 'dlg-acts' }, go), err);
  }

  function stepCard(s, can, d) {
    const [tone, ic, word] = STATUS[s.status] || STATUS.todo;
    const extra = [];
    if (s.missingAccounts && s.missingAccounts.length) {
      extra.push(el('div', { class: 'k', text: 'Accounts the services that are on post to, not in the chart' }),
        el('ul', { class: 'ob-checks' }, s.missingAccounts.map((m) => el('li', { class: 'no' }, el('span', { class: 'mk', text: m.code }),
          el('span', { text: `${m.inactive ? 'turned off · ' : ''}needed by ${m.services.join(', ')}` })))));
    }
    if (s.skip) extra.push(el('p', { class: 'fine', text: `Skipped by ${s.skip.by}, ${ago(s.skip.at)}: ${s.skip.reason}` }));
    const acts = [
      s.status === 'done' && s.id !== 'golive' ? null : btn(s.label, () => openStep(s), s.status === 'todo'),
      btn('What is this?', () => helpDialog(s)),
      can && s.skippable && s.status === 'todo' ? btn('Skip…', (e) => skip(s, e.currentTarget)) : null,
      can && s.skip && s.status === 'skipped' ? btn('Take back the skip', (e) => act(e.currentTarget, () => post('/onboarding/unskip', { step: s.id }), 'Back on the list')) : null,
    ].filter(Boolean);
    return el('div', { class: 'panel ob-step' }, item({ title: s.title, badge: chip(tone, ic, word), detail: s.why, why: s.detail, acts }),
      el('div', { class: 'ob-pad' }, checksList(s), extra), s.id === 'golive' && d ? goLivePanel(d, s) : null);
  }

  const backBtn = (label, go) => el('button', { class: 'btn', type: 'button', onclick: go }, E.icon('chev'), label);

  /** The steps behind the "Finished" count, by status, each opening its card's screen; Back returns to the checklist. */
  function summary(d) {
    const groups = [['todo', 'Still to do'], ['done', 'Done'], ['skipped', 'Skipped, with a reason'], ['optional', 'Optional here']];
    return frag(
      head(`${d.finished} of ${d.total} finished`, [backBtn('Back to the checklist', () => E.go('checklist'))], 'Setup checklist'),
      groups.map(([st, title]) => { const l = d.steps.filter((s) => s.status === st); return l.length ? section(title, String(l.length), null, el('div', { class: 'panel' }, l.map((s) => item({
        title: s.title, detail: st === 'skipped' && s.skip ? s.skip.reason : s.checks.filter((x) => !x.ok).map((x) => x.label).join(' · ') || s.why,
        badge: chip(...(STATUS[st] || STATUS.todo)), onClick: () => openStep(s) })))) : null; }));
  }

  async function screen(sub) {
    const d = await coApi('/onboarding/checklist');
    if (sub === 'summary') return summary(d);
    const can = manages();
    const left = d.steps.filter((s) => s.status === 'todo');
    const top = tilesRow(
      tile({ label: 'Finished', value: `${d.finished} of ${d.total}`, tone: d.complete ? 'good' : 'warning', ic: d.complete ? 'ok' : 'clock',
        text: d.complete ? 'Every step is done, skipped or optional' : `${plural(left.length, 'step')} to go`,
        onClick: () => E.go('checklist', 'summary') }),
      tile({ label: 'Layout', value: d.layout.single ? 'Single store' : `${plural(d.layout.locations, 'location')}`, word: true, tone: 'neutral', ic: 'building',
        text: d.layout.multiCompany ? `${plural(d.layout.companies, 'company', 'companies')} in this client` : 'Counted from your locations', onClick: () => E.go('services') }));
    const homeNote = d.dismissed
      ? item({ title: 'Hidden from Home', detail: `By ${d.dismissed.by}, ${ago(d.dismissed.at)}. It stays here under Setup.`,
          acts: can ? [btn('Show on Home again', (e) => act(e.currentTarget, () => post('/onboarding/dismiss', { dismissed: false }), 'Back on Home'))] : null })
      : d.complete ? null : item({ title: 'Shown on Home', detail: 'For the owner and controllers until every step is finished.',
          acts: can ? [btn('Hide from Home', (e) => act(e.currentTarget, () => post('/onboarding/dismiss', { dismissed: true }), 'Hidden from Home'))] : null });
    if (sub === 'company') setTimeout(companyDialog, 0);
    if (sub === 'opening') setTimeout(openingDialog, 0);
    return frag(
      head('Setup checklist', [backBtn('Back to Home', () => E.go('home'))], 'Setup'),
      el('p', { class: 'lead', text: 'What is left before this company can trade on the system. Each step turns done by itself when its data is there; nothing is ticked by hand. Steps for services that are off do not show.' }),
      top,
      homeNote ? el('div', { class: 'panel' }, homeNote) : null,
      section('Steps', `${d.finished} of ${d.total}`, null, el('div', {}, d.steps.map((s) => stepCard(s, can, d)))));
  }

  // ------------------------------------------------------- company details
  async function companyDialog() {
    const d = openDialog('Company details', E.S.co.name);
    E.fillDialog(d, async () => {
      const c = await coApi('/onboarding/company');
      const a = c.address || {};
      const f = { legal: input({ value: c.legalName || '', maxlength: '120' }), ein: input({ value: c.einLast4 || '', maxlength: '4', inputmode: 'numeric', placeholder: 'Last 4' }),
        line1: input({ value: a.line1 || '', maxlength: '120', autocomplete: 'address-line1' }), city: input({ value: a.city || '', maxlength: '60' }),
        postal: input({ value: a.postal || '', maxlength: '10' }), state: input({ value: c.state || '', maxlength: '2', autocapitalize: 'characters' }),
        fy: select(MONTHS.map((m, i) => [i + 1, m]), c.fiscalYearStartMonth),
        tz: E.zonePicker(c.timeZone, `Not set (in use now: ${c.zoneInUse})`) };
      if (!c.canChangeYear) f.fy.disabled = true;
      const own = isOwner();
      if (!own) for (const x of Object.values(f)) x.disabled = true;
      const err = el('div', { role: 'alert' });
      return frag(
        own ? null : resultBox('warning', 'warn', 'Only the owner changes these', 'You can see them; switch who you are acting as to change them.'),
        el('div', { class: 'form-grid' }, field('Legal name', f.legal, 'As on its tax filings', true), field('Federal tax id (EIN)', f.ein, 'Last four digits only'),
          field('Fiscal year starts', f.fy, c.canChangeYear ? null : 'Fixed once entries are posted'),
          field('Street', f.line1, null, true), field('City', f.city), field('State', f.state, 'Two letters'), field('ZIP or postal code', f.postal),
          field('Business time zone', f.tz, 'The day a sale, bill or payment is dated; stores can keep their own')),
        err,
        el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel'),
          own ? el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget, () => post('/onboarding/company', { legalName: f.legal.value, einLast4: f.ein.value,
            address: { line1: f.line1.value, city: f.city.value, postal: f.postal.value }, state: f.state.value, fiscalYearStartMonth: c.canChangeYear ? f.fy.value : null, timeZone: f.tz.value }),
            'Company details saved', { close: d.close, errorInto: (x) => err.replaceChildren(resultBox('critical', 'fail', 'Not saved', E.friendly(x))) }) }, 'Save') : null));
    });
  }

  // ------------------------------------------------------ opening balances
  async function openingDialog() {
    const d = openDialog('Opening balances', 'What the old books held on the day you switch', { wide: true });
    E.fillDialog(d, async () => {
      const o = await coApi('/onboarding/opening');
      const can = manages();
      const stockOut = el('div');
      const file = el('input', { type: 'file', accept: '.csv,text/csv' });
      const stockAsOf = input({ type: 'date', value: E.todayIso() });
      const preview = el('button', { class: 'btn primary', type: 'button', disabled: !can || null, onclick: async (e) => {
        const f = file.files && file.files[0];
        if (!f) { toast('Choose a file first', 'critical'); return; }
        const b = e.currentTarget; E.busy(b, true, 'Reading…');
        try { showPreview(stockOut, await post('/onboarding/opening-stock/preview', { filename: f.name, csv: await f.text(), asOf: stockAsOf.value }), d); }
        catch (x) { stockOut.replaceChildren(resultBox('critical', 'fail', 'Not read', E.friendly(x))); }
        finally { if (b.isConnected) E.busy(b, false); }
      } }, 'Preview');
      const runs = o.runs.map((r) => item({ title: `${r.filename || 'Opening stock'} · as of ${r.as_of} · ${r.status === 'applied' ? 'brought in' : 'previewed, not brought in'}`,
        amount: money(r.value_minor), detail: `${plural(r.rows_ok, 'row')} in, ${r.rows_refused} refused · ${r.applied_by || r.created_by} · ${ago(r.applied_at || r.created_at)}` }));
      const banks = o.banks.length ? o.banks.map((b) => b.as_of
        ? item({ title: b.name, amount: money(b.amount_minor), detail: `As of ${b.as_of} · ••${b.account_last4} · entered by ${b.entered_by}`, badge: chip('good', 'ok', 'Entered') })
        : bankRow(b, can, d)) : [empty('No bank accounts yet.', 'Add them under Setup first.', true)];
      return frag(
        el('p', { class: 'lead', text: 'Each balance posts against opening equity (3000), so the books start where the old ones ended. Nothing here is ever posted twice.' }),
        section('Customers’ open balances', null, null, el('div', { class: 'panel' }, item({ title: 'Open receivables', detail: 'Import them from Business setup: one balance per customer reference, posted to 1100.',
          acts: [btn('Open Business setup', () => { d.close(); E.go('business'); })] }))),
        section('Opening stock', null, null, el('div', { class: 'panel' },
          el('div', { class: 'ob-pad' }, el('p', { class: 'd', text: 'CSV with sku, location (its code), bin (optional), qty, unit_cost, serial (optional; several separated by ; one per unit), lot (optional). You see every row first; nothing moves until you bring it in. Each row posts Dr 1300 / Cr 3000 at its unit cost.' }),
            el('div', { class: 'form-grid' }, field('CSV file', file, 'Up to 1 MB and 5,000 rows'), field('As of', stockAsOf, 'The day the old books’ stock is as of; it posts on that day, in an open period'),
              el('div', { class: 'dlg-acts' }, preview)), stockOut),
          runs)),
        section('Bank accounts', null, null, el('div', { class: 'panel' }, banks)),
        el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Close')));
    });
  }

  function showPreview(box, r, d) {
    const can = manages();
    const rows = r.rows.map((x) => item({ title: `Row ${x.row} · ${x.sku || 'no SKU'} at ${x.location || '?'}${x.bin ? ` / ${x.bin}` : ''}`,
      amount: x.action === 'add' ? money(x.valueMinor) : null,
      detail: x.action === 'add' ? [`${x.qty} at ${money(x.unitCostMinor)}`, x.serials.length ? `serials ${x.serials.join(', ')}` : null, x.lot ? `lot ${x.lot}` : null, x.addsToExisting ? x.message : null].filter(Boolean).join(' · ') : x.message,
      badge: x.action !== 'add' ? chip('critical', 'fail', 'Refused') : x.addsToExisting ? chip('warning', 'warn', 'Adds to stock there') : chip('good', 'ok', 'Goes in') }));
    const confirm = el('input', { type: 'checkbox' });
    box.replaceChildren(
      resultBox(r.refused ? 'warning' : 'good', r.refused ? 'warn' : 'ok', `${plural(r.ok, 'row')} ready, ${r.refused} refused`,
        `${r.units} units worth ${money(r.valueMinor)} at cost, posted as of ${r.asOf}. Refused rows stay out; fix them and import them again.`),
      r.addsToExisting ? el('div', {}, resultBox('warning', 'warn', `${plural(r.addsToExisting, 'row')} add to stock already there`,
        'Those products already have stock or movements at that location. Bringing them in adds on top; it does not replace what is there.'),
        el('label', { class: 'li check-row' }, confirm, el('div', { class: 't', text: 'Add them on top of what is there' }))) : null,
      el('div', { class: 'ob-rows' }, E.capped(rows, 20, 'rows')),
      r.ok && can ? el('div', { class: 'dlg-acts' }, el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget,
        () => post('/onboarding/opening-stock/apply', { runId: r.runId, confirm: confirm.checked }),
        (x) => `${plural(x.added, 'row')} brought in, ${money(x.valueMinor)}${x.problems.length ? `; ${x.problems.length} refused` : ''}`, { close: d.close }) }, `Bring ${plural(r.ok, 'row')} in`)) : null);
  }

  function bankRow(b, can, d) {
    const asOf = input({ type: 'date', value: E.todayIso() }), amt = input({ inputmode: 'decimal', placeholder: '0.00' });
    return el('div', { class: 'li' }, el('div', { class: 't', text: `${b.name} ••${b.account_last4}` }),
      el('div', { class: 'd', text: 'Balance on the bank statement the day the books start (negative for an overdraft).' }),
      can ? el('div', { class: 'form-grid' }, field('As of', asOf), field('Balance', amt),
        el('div', { class: 'dlg-acts' }, el('button', { class: 'btn primary small', type: 'button', onclick: (e) => act(e.currentTarget,
          () => post('/onboarding/opening-bank', { bankAccountId: b.id, asOf: asOf.value, amount: amt.value }), `${b.name} opening balance posted`, { close: d.close }) }, 'Post it'))) : null);
  }

  E.openOpening = openingDialog;
  E.openCompanyDetails = companyDialog;

  // The checklist on Home: owner and controllers, until it is finished or hidden.
  E.homeCard(async () => {
    if (!manages()) return null;
    const d = await coApi('/onboarding/home');
    if (!d.show) return null;
    return section('Setup checklist', `${d.finished} of ${d.total} done`, [btn('Open the checklist', () => E.go('checklist'))],
      el('div', { class: 'panel' }, d.next.map((s) => item({ title: s.title, detail: s.why, badge: chip('warning', 'clock', 'To do'),
        acts: [btn(s.label, () => openStep(s), true)] })),
      item({ title: 'Hide this from Home', detail: 'The checklist stays under Setup, Setup checklist.',
        acts: [btn('Hide', (e) => act(e.currentTarget, () => post('/onboarding/dismiss', { dismissed: true }), 'Hidden from Home'))] })));
  }, { module: null });

  E.register('checklist', 'Setup checklist', 'check', screen, 'Setup', { module: null });
})();
