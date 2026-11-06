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
      el('p', { class: 'fine', text: `Turns on: ${p.modules.map((m) => MODULE_LABEL[m][0]).join(', ')}` }),
      el('div', { class: 'acts' }, el('button', { class: 'btn' + (last && last.pack === p.id ? '' : ' primary'), type: 'button', disabled: !owner || null,
        onclick: (e) => confirmPack(p, e.currentTarget) }, last && last.pack === p.id ? 'Apply again' : 'Use this setup')))));

    const modules = el('div', { class: 'panel' }, d.allModules.map((m) => {
      const on = d.modules.includes(m);
      const box = el('input', { type: 'checkbox', checked: on, disabled: !owner || null, 'aria-label': MODULE_LABEL[m][0] });
      box.addEventListener('change', () => act(box, () => post('/setup/module', { module: m, enabled: box.checked }),
        `${MODULE_LABEL[m][0]} turned ${box.checked ? 'on' : 'off'}`).then(() => location.reload()));
      return el('label', { class: 'li check-row' }, box,
        el('div', { class: 't' }, MODULE_LABEL[m][0]), el('div', { class: 'd', text: MODULE_LABEL[m][1] }));
    }));

    const locs = el('div', { class: 'panel' }, d.locations.length ? d.locations.map((l) => item({
      title: `${l.name} (${l.code})`,
      detail: [KIND_LABEL[l.kind] || l.kind, [l.address && l.address.city, l.state].filter(Boolean).join(', '),
        l.kind === 'web' ? null : `tax ${pct(l.tax_rate_bps)}`, l.lat != null ? 'on the map' : 'no map point — routing cannot use it'].filter(Boolean).join(' · '),
      badge: l.status === 'active' ? null : chip('neutral', 'pause', 'Closed'),
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
      el('p', { class: 'lead', text: last
        ? `Set up as ${(d.packs.find((p) => p.id === last.pack) || {}).name || last.pack} by ${last.applied_by}, ${ago(last.applied_at)}. Applying a setup only adds; it never removes an account, a setting you changed, or any data.`
        : 'Pick the kind of business this company is. That turns on the right modules and adds the accounts, pick lists and defaults they need. You can change any of it afterwards.' }),
      section('Kind of business', null, null, packCards),
      el('div', { class: 'two' },
        el('div', {}, section('Modules', `${d.modules.length} of ${d.allModules.length} on`, null, modules),
          section('Pick lists', null, null, reasons)),
        el('div', {}, section('Stores and warehouses', `${d.locations.length}`, null, locs),
          section('Bring data over', null, null, imports))));
  }

  function confirmPack(p, btn) {
    const d = openDialog(`Set up as ${p.name.toLowerCase()}?`, E.S.co.name);
    d.body.append(
      el('p', { class: 'lead', text: p.blurb }),
      el('p', { text: `This turns on ${p.modules.map((m) => MODULE_LABEL[m][0]).join(', ')}, and adds the accounts, reason lists and default settings those need. It removes nothing, and settings you already changed stay as you set them.` }),
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

  E.register('business', 'Business setup', 'building', screen, 'Setup');
})();
