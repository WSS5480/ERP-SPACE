// Business setup: pick what kind of business this is, turn modules on or off,
// set up stores and warehouses, and bring customers and open balances over
// from the old system. Every change is the owner's and is recorded by name.
(() => {
  'use strict';
  const E = window.ERP;
  const { el, frag, head, section, item, chip, empty, toast, act, openDialog, field, select, input, post, coApi, plural, ago } = E;

  const MODULE_LABEL = {
    catalog: ['Catalog', 'Products, options for customizing, vendor catalog imports, price tags'],
    purchasing: ['Purchasing', 'Open-to-buy, order forms, special-order POs, reorder suggestions'],
    inventory: ['Warehouse', 'Bins, piece tracking, receiving, transfers, counts, damage and claims'],
    pos: ['Point of sale', 'Quotes, sales, deposits, layaway, split tenders, returns, drawer close'],
    ar: ['Receivables', 'House accounts, statements, aging, collections, financing, write-offs'],
    workforce: ['Time and commissions', 'Time clock, schedules, commission plans feeding payroll'],
    fleet: ['Fleet and delivery', 'Trucks, delivery windows, route building, driver app, proof of delivery'],
    shop: ['Web store', 'Online store with the product customizer, pickup and delivery'],
    crm: ['Customers and marketing', 'Customer profiles and consent, the lead tracker, follow-ups, campaigns and coupons'],
    reports: ['Reports', 'Report creator and editor: curated datasets, saved and shared reports, schedules, CSV and Excel export'],
    service: ['Service and repair', 'Service tickets from the first call to the fix: parts, visits, who pays and what it cost'],
    group: ['Group accounting', 'The client’s companies together: combined statements with eliminations, inter-company billing, net-to-zero and settle'],
  };
  const KIND_LABEL = { store: 'Store', warehouse: 'Warehouse', outlet: 'Outlet', yard: 'Yard', office: 'Office', web: 'Online' };
  const REASON_LABEL = { return: 'Return reasons', adjustment: 'Stock adjustments', damage: 'Damage', discount: 'Discounts',
    write_off: 'Write-offs', delivery_exception: 'Delivery exceptions', void: 'Voids' };
  const pct = (bps) => `${(Number(bps || 0) / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
  const isOwner = () => !!(E.S.person && E.S.person.roles.includes('owner'));

  async function screen() {
    const d = await coApi('/setup/business');
    const owner = isOwner();
    const last = d.applied[0];

    const packCards = el('div', { class: 'pack-grid' }, d.packs.map((p) => el('div', { class: 'panel pack' + (last && last.pack === p.id ? ' on' : '') },
      el('h3', { text: p.name }),
      el('p', { class: 'd', text: p.blurb }),
      el('p', { class: 'fine', text: `Turns on: ${p.modules.map((m) => (MODULE_LABEL[m] || [m])[0]).join(', ')}` }),
      el('div', { class: 'acts' }, el('button', { class: 'btn' + (last && last.pack === p.id ? '' : ' primary'), type: 'button', disabled: !owner || null,
        onclick: (e) => confirmPack(p, e.currentTarget) }, last && last.pack === p.id ? 'Apply again' : 'Use this setup')))));

    // The switches moved to Admin, Services: every service has its own there, with presets and "apply to all my companies".
    const showing = (E.S.modules || d.modules).length;
    const modules = el('div', { class: 'panel' }, item({ title: 'Services', detail: `${showing} services showing. Switch each service on or off, use a preset, or apply to all your companies.`,
      onClick: () => E.go('services') }));
    const locs = el('div', { class: 'panel' }, d.locations.length ? d.locations.map((l) => item({
      title: `${l.name} (${l.code})`,
      detail: [KIND_LABEL[l.kind] || l.kind, [l.address && l.address.city, l.state].filter(Boolean).join(', '),
        l.kind === 'web' ? null : `tax ${pct(l.tax_rate_bps)}`, l.lat != null ? 'on the map' : 'no map point — routing cannot use it'].filter(Boolean).join(' · '),
      badge: l.status !== 'active' ? chip('neutral', 'pause', 'Closed')
        : (['store', 'outlet'].includes(l.kind) && !Number(l.tax_rate_bps)) ? chip('warning', 'warn', 'No sales tax set') : null,
      acts: owner ? [el('button', { class: 'btn small', type: 'button', onclick: () => openLocation(l) }, 'Edit')] : null,
    })) : empty('No stores or warehouses yet.', null, true));

    const byKind = new Map();
    for (const r of d.reasons) { if (!byKind.has(r.kind)) byKind.set(r.kind, []); byKind.get(r.kind).push(r); }
    const reasons = el('div', { class: 'panel' }, byKind.size ? [...byKind].map(([k, list]) => item({
      title: REASON_LABEL[k] || k, detail: list.filter((r) => r.active).map((r) => r.label).join(' · '),
      acts: owner ? [el('button', { class: 'btn small', type: 'button', onclick: () => openReason(k) }, 'Add')] : null,
    })) : empty('Apply a setup to get the standard lists.', null, true));

    const imports = el('div', { class: 'panel' },
      item({ title: 'Customers', detail: 'CSV with number, name, email, phone, address, city, state, zip, credit_limit, terms_days. Matches on number, then email.',
        acts: [el('button', { class: 'btn small', type: 'button', onclick: () => openImport('customers') }, 'Import…')] }),
      item({ title: 'Open receivables', detail: 'CSV with customer_number (or email), reference, as_of, due_on, balance. Each posts to 1100 against opening equity; a reference is never imported twice.',
        acts: [el('button', { class: 'btn small', type: 'button', onclick: () => openImport('open-ar') }, 'Import…')] }),
      d.imports.map((r) => item({ title: `${r.kind === 'open_ar' ? 'Open receivables' : 'Customers'} · ${r.filename || ''}`,
        detail: `${plural(r.rows_added, 'added', 'added')}, ${r.rows_updated} updated, ${r.rows_refused} refused · ${r.run_by} · ${ago(r.run_at)}` })));

    return frag(
      head('Business setup', owner ? [el('button', { class: 'btn', type: 'button', onclick: () => openLocation(null) }, 'Add a store or warehouse')] : null, 'Setup'),
      d.locations.some((l) => l.status === 'active' && ['store', 'outlet'].includes(l.kind) && !Number(l.tax_rate_bps))
        ? E.resultBox('warning', 'warn', 'A store has no sales tax rate', 'Sales there are rung up with no tax until you set its rate. Edit the store below; a rate of 0% only belongs where no sales tax is due.') : null,
      el('p', { class: 'lead', text: last
        ? `Set up as ${(d.packs.find((p) => p.id === last.pack) || {}).name || last.pack} by ${last.applied_by}, ${ago(last.applied_at)}. Applying a setup only adds; it never removes an account, a setting you changed, or any data.`
        : 'Pick the kind of business this company is. That turns on the right modules and adds the accounts, pick lists and defaults they need. You can change any of it afterwards.' }),
      section('Kind of business', null, null, packCards),
      el('div', { class: 'two' },
        el('div', {}, section('Services', null, null, modules),
          section('Pick lists', null, null, reasons)),
        el('div', {}, section('Stores and warehouses', `${d.locations.length}`, null, locs),
          section('Bring data over', null, null, imports))));
  }

  function confirmPack(p, btn) {
    const d = openDialog(`Set up as ${p.name.toLowerCase()}?`, E.S.co.name);
    d.body.append(
      el('p', { class: 'lead', text: p.blurb }),
      el('p', { text: `This turns on ${p.modules.map((m) => (MODULE_LABEL[m] || [m])[0]).join(', ')}, and adds the accounts, reason lists and default settings those need. It removes nothing, and settings you already changed stay as you set them.` }),
      el('div', { class: 'dlg-acts' },
        el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget, () => post('/setup/pack', { pack: p.id }),
          (r) => `Done: ${plural(r.accountsAdded, 'account')} and ${plural(r.reasonsAdded, 'reason')} added, ${r.modulesOn} modules on`,
          { close: d.close }).then(() => location.reload()) }, 'Apply')));
  }

  function openLocation(l) {
    const d = openDialog(l ? `Edit ${l.name}` : 'Add a store or warehouse', E.S.co.name);
    const a = (l && l.address) || {};
    const f = {
      code: input({ value: l ? l.code : '', maxlength: '10', autocapitalize: 'characters' }),
      name: input({ value: l ? l.name : '', maxlength: '80' }),
      kind: select(Object.entries(KIND_LABEL), l ? l.kind : 'store'),
      line1: input({ value: a.line1 || '', maxlength: '120', autocomplete: 'address-line1' }),
      city: input({ value: a.city || '', maxlength: '60' }),
      state: input({ value: a.state || (l && l.state) || '', maxlength: '2', autocapitalize: 'characters' }),
      postal: input({ value: a.postal || '', maxlength: '10', inputmode: 'numeric' }),
      tax: input({ value: l ? (Number(l.tax_rate_bps) / 100).toString() : '', inputmode: 'decimal', placeholder: '8.25' }),
      lat: input({ value: l && l.lat != null ? String(l.lat) : '', inputmode: 'decimal', placeholder: '40.2601' }),
      lng: input({ value: l && l.lng != null ? String(l.lng) : '', inputmode: 'decimal', placeholder: '-76.9336' }),
    };
    const err = el('div', { class: 'result critical', role: 'alert', hidden: true });
    d.body.append(el('div', { class: 'form-grid' },
      field('Code', f.code, 'Short, like ENL or DC1'), field('Name', f.name), field('Kind', f.kind),
      field('Street', f.line1, null, true), field('City', f.city), field('State', f.state), field('ZIP', f.postal),
      field('Sales tax %', f.tax, 'Charged on taxable sales here'),
      field('Latitude', f.lat, 'For delivery routing'), field('Longitude', f.lng)), err,
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'button', onclick: (e) => {
          const tax = f.tax.value.trim() === '' ? 0 : Math.round(Number(f.tax.value) * 100);
          act(e.currentTarget, () => post('/setup/location', { id: l ? l.id : null, code: f.code.value, name: f.name.value, kind: f.kind.value,
            taxRateBps: tax, address: { line1: f.line1.value, city: f.city.value, state: f.state.value, postal: f.postal.value },
            lat: f.lat.value.trim() || null, lng: f.lng.value.trim() || null }), 'Saved', { close: d.close,
            errorInto: (x) => { err.hidden = false; err.textContent = E.friendly(x); } });
        } }, 'Save')));
  }

  function openReason(kind) {
    const d = openDialog(`Add to ${(REASON_LABEL[kind] || kind).toLowerCase()}`, E.S.co.name);
    const label = input({ maxlength: '80' });
    const restock = el('input', { type: 'checkbox', checked: true });
    d.body.append(el('div', { class: 'form-grid' }, field('Reason', label, null, true),
      kind === 'return' ? el('label', { class: 'check' }, restock, el('span', { text: ' Goes back into sellable stock' })) : null),
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget,
          () => post('/setup/reason', { kind, label: label.value, restock: kind === 'return' ? restock.checked : null }), 'Added', { close: d.close }) }, 'Add')));
  }

  function openImport(kind) {
    const d = openDialog(kind === 'customers' ? 'Import customers' : 'Import open receivables', E.S.co.name);
    const file = el('input', { type: 'file', accept: '.csv,text/csv' });
    const out = el('div');
    d.body.append(field('CSV file', file, 'Up to 200 KB per file; split bigger exports'), out,
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Close'),
        el('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
          const f = file.files && file.files[0];
          if (!f) { toast('Choose a file first', 'critical'); return; }
          const csv = await f.text();
          const r = await act(e.currentTarget, () => post(`/setup/import/${kind}`, { filename: f.name, csv }),
            (x) => `${x.added} added${x.updated != null ? `, ${x.updated} updated` : ''}`);
          if (!r) return;
          out.replaceChildren(r.problems.length ? el('div', { class: 'panel' }, el('p', { class: 'd', text: `${plural(r.problems.length, 'row')} need a look:` }),
            r.problems.slice(0, 50).map((p) => item({ title: `Row ${p.row}`, detail: p.problem }))) : el('p', { class: 'lead', text: 'Every row went in.' }));
        } }, 'Import')));
  }

  E.register('business', 'Business setup', 'building', screen, 'Setup', { module: null });

  // ============================================== sales tax and selling rules
  const LEVEL_LABEL = { state: 'State', county: 'County', city: 'City', special: 'Special district', combined: 'Single store rate' };
  const canTax = () => !!(E.S.person && E.S.person.roles.some((r) => r === 'owner' || r === 'controller'));
  const canRules = () => !!(E.S.person && E.S.person.roles.some((r) => r === 'owner' || r === 'store_manager' || r === 'controller'));
  const yes = (b) => (b ? 'taxed' : 'exempt');
  const padded = (n) => { n.style.padding = '12px 16px 14px'; return n; };
  const areaWords = (a) => a.location_id ? `the ${a.location} store` : a.postal ? `ZIP ${a.postal}` : `all of ${a.state}`;

  async function taxScreen() {
    const [d, pos] = await Promise.all([coApi('/setup/tax'), coApi('/pos/setup').catch(() => null)]);
    const ctl = canTax();
    const src = el('div');
    const drawSrc = () => src.replaceChildren(E.seg([['destination', 'Where the goods go'], ['origin', 'At the store']], d.sourcing, (v) => {
      if (!ctl) { toast('Only the owner or a controller changes this', 'critical'); return; }
      act(src, () => post('/setup/tax/sourcing', { sourcing: v }), v === 'origin' ? 'Deliveries are now taxed at the store' : 'Deliveries are now taxed where they go');
    }));
    drawSrc();
    const stores = el('div', { class: 'panel' }, d.stores.length ? d.stores.map((x) => item({ title: x.name, amount: pct(x.rateBps),
      detail: x.stack.map((j) => `${j.name} ${pct(j.rateBps)}`).join(' + ') || 'No sales tax' })) : empty('No stores yet.', null, true));
    const byState = new Map();
    for (const j of d.jurisdictions) { if (!byState.has(j.state)) byState.set(j.state, []); byState.get(j.state).push(j); }
    const jurs = [...byState.entries()].map(([st, list]) => section(st, plural(list.length, 'jurisdiction'), null, el('div', { class: 'panel' }, list.map((j) => item({
      title: `${j.name} (${j.code})`, amount: j.rate_bps == null ? 'no rate today' : pct(j.rate_bps),
      detail: [LEVEL_LABEL[j.level] || j.level, `delivery ${yes(j.taxes_delivery)}`, `labor ${yes(j.taxes_labor)}`, `protection plans ${yes(j.taxes_warranty)}`,
        j.areas.length ? `applies to ${j.areas.map(areaWords).join(', ')}` : 'applies nowhere yet', j.filing_ref ? `filed under ${j.filing_ref}` : null].filter(Boolean).join(' · '),
      why: j.note || null,
      badge: !j.active ? chip('neutral', 'pause', 'Not in use') : j.for_location_id ? chip('neutral', 'info', 'Single store rate') : null,
      acts: ctl ? [j.for_location_id ? null : el('button', { class: 'btn small', type: 'button', onclick: () => jurisdictionDialog(j) }, 'Edit'),
        el('button', { class: 'btn small', type: 'button', onclick: () => rateDialog(j) }, 'New rate'),
        el('button', { class: 'btn small', type: 'button', onclick: () => areaDialog(j, d) }, 'Where it applies')].filter(Boolean) : null })))));
    let rules = null;
    if (pos && pos.settings) {
      const st = pos.settings;
      const f = { special: input({ inputmode: 'decimal', value: String(st.specialOrderDepositBps / 100) }), stocked: input({ inputmode: 'decimal', value: String(st.stockedDepositBps / 100) }),
        holds: el('input', { type: 'checkbox', checked: st.quoteHoldsAllowed || null }), days: input({ inputmode: 'numeric', value: String(st.quoteHoldMaxDays) }) };
      const edit = canRules();
      for (const x of Object.values(f)) if (!edit) x.disabled = true;
      rules = section('Selling rules', null, null, el('div', { class: 'panel' }, padded(el('div', {}, el('div', { class: 'form-grid' },
        field('Deposit on special orders %', f.special, 'At least this much of goods ordered for the customer is paid when the sale is placed'),
        field('Deposit on stocked goods %', f.stocked, 'Usually 0'),
        el('label', { class: 'check' }, f.holds, el('span', { text: ' Quotes may hold stock for the customer' })),
        field('Longest hold, days', f.days, 'A store manager can extend one, never past the quote')),
        edit ? el('div', { class: 'dlg-acts' }, el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget, () => post('/pos/settings', {
          specialOrderDepositPct: f.special.value, stockedDepositPct: f.stocked.value, quoteHoldsAllowed: f.holds.checked, quoteHoldMaxDays: f.days.value }), 'Selling rules saved') }, 'Save')) : null))));
    }
    return frag(
      head('Sales tax', ctl ? [el('button', { class: 'btn primary', type: 'button', onclick: () => jurisdictionDialog(null) }, 'Add a jurisdiction')] : null, 'Setup'),
      el('p', { class: 'lead', text: 'Each sale is taxed by every jurisdiction where the goods are handed over: the store for take-with and pickup, and for a delivery either the delivery address or the store, as chosen here. Rates come with the dates they apply from. The rates set up for you are placeholders; check them with your accountant.' }),
      section('Deliveries are taxed', null, null, el('div', { class: 'panel' }, padded(el('div', {}, src)))),
      el('div', { class: 'two' },
        el('div', {}, section('What each store charges', 'on taxable goods today', null, stores), rules),
        el('div', {}, jurs.length ? jurs : section('Jurisdictions', null, null, el('div', { class: 'panel' }, empty('None yet.', 'Each store uses its own single rate until jurisdictions are added.', true))))));
  }

  function jurisdictionDialog(j) {
    const d = openDialog(j ? `Edit ${j.name}` : 'Add a jurisdiction', E.S.co.name);
    const levels = Object.entries(LEVEL_LABEL).filter(([k]) => k !== 'combined');
    const f = { code: input({ value: j ? j.code : '', maxlength: '40', autocapitalize: 'characters', placeholder: 'TX-PALESTINE' }),
      name: input({ value: j ? j.name : '', maxlength: '120', placeholder: 'City of Palestine' }), level: select(levels, j ? j.level : 'city'),
      state: input({ value: j ? j.state : '', maxlength: '2', autocapitalize: 'characters' }),
      rate: input({ inputmode: 'decimal', placeholder: '1.5' }), from: input({ type: 'date', value: E.todayIso() }),
      delivery: el('input', { type: 'checkbox', checked: j ? j.taxes_delivery : true }), labor: el('input', { type: 'checkbox', checked: j ? j.taxes_labor : false }),
      plans: el('input', { type: 'checkbox', checked: j ? j.taxes_warranty : true }), active: el('input', { type: 'checkbox', checked: j ? j.active : true }),
      filing: input({ value: j && j.filing_ref ? j.filing_ref : '', maxlength: '60' }), note: input({ value: j && j.note ? j.note : '', maxlength: '300' }) };
    const err = el('div', { class: 'result critical', role: 'alert', hidden: true });
    d.body.append(el('div', { class: 'form-grid' }, field('Code', f.code), field('Name on the return', f.name), field('Level', f.level), field('State', f.state),
      j ? null : field('Rate %', f.rate), j ? null : field('From', f.from),
      el('label', { class: 'check' }, f.delivery, el('span', { text: ' Taxes delivery charges' })), el('label', { class: 'check' }, f.labor, el('span', { text: ' Taxes labor (assembly, installation)' })),
      el('label', { class: 'check' }, f.plans, el('span', { text: ' Taxes protection plans' })), j ? el('label', { class: 'check' }, f.active, el('span', { text: ' In use' })) : null,
      field('Filed under (account or permit)', f.filing), field('Note', f.note, null, true)), err,
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget, () => post('/setup/tax/jurisdictions', { id: j ? j.id : null,
          code: f.code.value, name: f.name.value, level: f.level.value, state: f.state.value, ratePct: f.rate.value, effectiveFrom: f.from.value,
          taxesDelivery: f.delivery.checked, taxesLabor: f.labor.checked, taxesWarranty: f.plans.checked, active: f.active.checked, filingRef: f.filing.value, note: f.note.value }),
          'Saved', { close: d.close, errorInto: (x) => { err.hidden = false; err.textContent = E.friendly(x); } }) }, 'Save')));
  }

  function rateDialog(j) {
    const d = openDialog(`New rate for ${j.name}`, j.rate_bps == null ? 'No rate today' : `Today ${pct(j.rate_bps)}`);
    const rate = input({ inputmode: 'decimal', placeholder: '1.5' }), from = input({ type: 'date', value: E.todayIso() }), note = input({ maxlength: '300' });
    const err = el('div', { class: 'result critical', role: 'alert', hidden: true });
    d.body.append(el('p', { class: 'lead', text: 'The rate in force ends the day before the new one starts. Past sales keep the rate they were charged.' }),
      el('div', { class: 'panel' }, j.rates.map((r) => item({ title: `${dayLabelSafe(r.effective_from)} to ${r.effective_to ? dayLabelSafe(r.effective_to) : 'now'}`, amount: pct(r.rate_bps), detail: r.note || null }))),
      el('div', { class: 'form-grid' }, field('New rate %', rate), field('From', from), field('Note', note, null, true)), err,
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget, () => post(`/setup/tax/jurisdictions/${j.id}/rates`, { ratePct: rate.value,
          effectiveFrom: from.value, note: note.value }), 'Rate added', { close: d.close, errorInto: (x) => { err.hidden = false; err.textContent = E.friendly(x); } }) }, 'Add the rate')));
  }
  const dayLabelSafe = (s) => { try { return E.dayLabel(s); } catch (_) { return s; } };

  function areaDialog(j, d0) {
    const d = openDialog(`Where ${j.name} applies`, j.state);
    const kind = select([['state', `All of ${j.state}`], ['postal', 'One ZIP code'], ['store', 'One store']], 'postal');
    const postal = input({ inputmode: 'numeric', maxlength: '5', placeholder: '75801' });
    const store = select(d0.stores.map((x) => [x.id, x.name]), d0.stores[0] ? d0.stores[0].id : '');
    const err = el('div', { class: 'result critical', role: 'alert', hidden: true });
    d.body.append(el('div', { class: 'panel' }, j.areas.length ? j.areas.map((a) => item({ title: areaWords(a),
      acts: [el('button', { class: 'btn small', type: 'button', onclick: (e) => act(e.currentTarget, () => post('/setup/tax/areas', { id: a.id, remove: true, jurisdictionId: j.id }),
        'Taken off', { close: d.close }) }, 'Take off')] })) : empty('It applies nowhere yet.', null, true)),
      el('div', { class: 'form-grid' }, field('Add', kind), field('ZIP code', postal), field('Store', store)), err,
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Close'),
        el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget, () => post('/setup/tax/areas', { jurisdictionId: j.id,
          state: kind.value === 'store' ? null : j.state, postal: kind.value === 'postal' ? postal.value : null, locationId: kind.value === 'store' ? store.value : null }),
          'Added', { close: d.close, errorInto: (x) => { err.hidden = false; err.textContent = E.friendly(x); } }) }, 'Add')));
  }

  E.register('salestax', 'Sales tax', 'percent', taxScreen, 'Setup', { icon: 'M5 19L19 5|C7.5 7.5 2.5|C16.5 16.5 2.5', module: 'salestax' });
})();
