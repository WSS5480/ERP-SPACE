// chart of accounts screen. Registers with window.ERP (see docs/MODULES.md).
// Books → Chart of accounts: the chart grouped by type with search; add,
// edit, regroup under headers, choose which companies use an account,
// deactivate (never delete), and load or save the chart as CSV with a
// preview before anything changes. Phone first: rows are cards, numbers
// sit right.
(() => {
  'use strict';
  const E = window.ERP;
  if (!E) return;
  const { S, el, frag, icon, chip, money, plural, cap, coApi, post, go, toast, act, openDialog, resultBox, fillDialog, askReason,
    head, section, tile, tilesRow, empty, item, capped, seg, fact, friendly, render, shortDay } = E;

  const field = (label, control, hint, wide) => el('label', { class: 'field' + (wide ? ' wide' : '') }, el('span', { text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null);
  const select = (options, value) => el('select', {}, options.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(value ?? '') || null })));
  const input = (props) => el('input', Object.assign({ type: 'text' }, props));
  const errInto = (box) => (e) => box.replaceChildren(resultBox('critical', 'fail', 'Not saved', friendly(e)));
  const TYPE = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', revenue: 'Revenue', expense: 'Expenses' };
  const NB = { D: 'Debit', C: 'Credit' };
  const normalFor = (t) => (t === 'asset' || t === 'expense' ? 'D' : 'C');
  const download = (filename, text) => {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: filename });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };

  const F = { q: '', type: 'all', inactive: false, hereOnly: false };
  let IMP = null;   // { runId, show }

  async function screen() {
    const d = await coApi('/chart');
    const search = el('input', { type: 'search', placeholder: 'Code or name', value: F.q, 'aria-label': 'Search the chart', class: 'coa-search' });
    let t = 0;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { F.q = search.value.trim().toLowerCase(); draw(); }, 200); });
    const inactive = el('input', { type: 'checkbox', checked: F.inactive, onchange: (e) => { F.inactive = e.target.checked; draw(); } });
    const here = el('input', { type: 'checkbox', checked: F.hereOnly, onchange: (e) => { F.hereOnly = e.target.checked; draw(); } });
    const counts = Object.fromEntries(Object.keys(TYPE).map((k) => [k, d.accounts.filter((a) => a.account_type === k && a.active).length]));
    const typeSeg = el('div');
    const list = el('div');
    const byId = Object.fromEntries(d.accounts.map((a) => [a.id, a]));
    const depth = (a) => { let n = 0, p = a.parent_id; while (p && byId[p] && n < 20) { n++; p = byId[p].parent_id; } return n; };
    const draw = () => {
      typeSeg.replaceChildren(seg([['all', 'All'], ...Object.entries(TYPE).map(([k, v]) => [k, v, counts[k]])], F.type, (k) => { F.type = k; draw(); }));
      const rows = d.accounts.filter((a) => (F.type === 'all' || a.account_type === F.type) && (F.inactive || a.active) && (!F.hereOnly || a.used_here)
        && (!F.q || a.code.toLowerCase().includes(F.q) || a.name.toLowerCase().includes(F.q)));
      const groups = Object.keys(TYPE).filter((k) => F.type === 'all' || k === F.type).map((k) => {
        const rs = rows.filter((a) => a.account_type === k);
        if (!rs.length) return null;
        return section(TYPE[k], plural(rs.length, 'account'), null, el('div', { class: 'panel' }, capped(rs.map((a) => {
          const n = el('div', {}, item({
            title: `${a.code} · ${a.name}`, amount: a.is_postable && a.used_here && a.posted ? money(a.balance_minor) : null,
            badge: frag(!a.active ? chip('neutral', 'pause', 'Inactive') : null, !a.is_postable ? chip('neutral', 'book', 'Header') : null,
              a.active && !a.used_here ? chip('warning', 'info', 'Not used here') : null),
            detail: [a.parent_code ? `under ${a.parent_code}` : null, `${NB[a.normal_balance]} balance`, plural(Number(a.companies), 'company', 'companies'),
              a.posted ? 'has postings' : 'no postings yet', a.packs.length ? 'the ERP posts to it' : null].filter(Boolean).join(' · '),
            onClick: () => openAccount(a.id, d),
          }));
          const lvl = Math.min(depth(a), 3);
          if (lvl) n.classList.add(`coa-l${lvl}`);
          return n;
        }), 60, 'accounts')));
      }).filter(Boolean);
      list.replaceChildren(...(groups.length ? groups : [el('div', { class: 'panel' }, empty('No account matches.', 'Clear the search, or show inactive accounts.', true))]));
    };
    draw();
    const exp = el('button', { class: 'btn', type: 'button', onclick: () => act(exp, async () => { const r = await coApi('/chart/export'); download(r.filename, r.csv); return r; },
      (r) => `${r.filename} downloaded`) }, icon('file'), 'Export CSV');
    return frag(
      head('Chart of accounts', [el('button', { class: 'btn primary', type: 'button', onclick: () => openAdd(d) }, icon('plus'), 'Add account'),
        el('button', { class: 'btn', type: 'button', onclick: () => openImport(d) }, icon('upload'), 'Import CSV'), exp], 'Books'),
      el('div', { class: 'toolbar' }, seg([['pnl', 'Profit and loss'], ['tb', 'Trial balance'], ['coa', 'Chart of accounts']], 'coa', (v) => (v === 'coa' ? null : go('books', v)))),
      el('p', { class: 'lead', text: `The chart is shared by ${plural(d.companies.length, 'company', 'companies')}; each company chooses the accounts it uses. Accounts are never deleted: one with postings keeps its code and type, and is switched off instead of removed.` }),
      el('div', { class: 'coa-tb' }, search, el('label', { class: 'check' }, here, `Only accounts ${S.co.name} uses`), el('label', { class: 'check' }, inactive, 'Show inactive')),
      typeSeg, list);
  }

  const headersOf = (d, type, exceptId) => d.accounts.filter((a) => !a.is_postable && a.active && a.account_type === type && a.id !== exceptId);

  function openAdd(d, preset) {
    preset = preset || {};
    const dlg = openDialog(preset.replaces ? `New account to replace ${preset.replaces}` : 'Add an account', `${S.co.name} · the chart is shared by the client’s companies`, { wide: true });
    const code = input({ placeholder: '6415', value: preset.code || '', maxlength: '20' }), name = input({ placeholder: 'Telephone and internet', value: preset.name || '' });
    const type = select(Object.entries(TYPE).map(([k, v]) => [k, v.replace(/s$/, '').replace(/ie$/, 'y')]), preset.type || 'expense');
    const nb = select([['D', 'Debit'], ['C', 'Credit']], normalFor(preset.type || 'expense'));
    const parentBox = el('div');
    let parent = null;
    const drawParent = () => { parent = select([['', 'No rollup group'], ...headersOf(d, type.value).map((a) => [a.code, `${a.code} ${a.name}`])], preset.parent || ''); parentBox.replaceChildren(field('Rolls up into', parent, 'A header account, for reports')); };
    type.onchange = () => { nb.value = normalFor(type.value); drawParent(); };
    drawParent();
    const postable = el('input', { type: 'checkbox', checked: preset.postable !== false });
    const desc = el('textarea', { rows: '2', maxlength: '500', placeholder: 'What goes here (optional)' });
    const cos = d.companies.map((c) => [c, el('input', { type: 'checkbox', checked: c.id === S.co.id })]);
    const err = el('div');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post('/chart/accounts', {
      code: code.value.trim(), name: name.value, type: type.value, normalBalance: nb.value, parent: parent.value || null, postable: postable.checked,
      description: desc.value, companies: cos.filter(([, b]) => b.checked).map(([c]) => c.id) }), 'Account added', { errorInto: errInto(err), close: dlg.close }) }, 'Add account');
    dlg.body.append(
      preset.replaces ? resultBox('neutral', 'info', 'Future postings go to the new account', `${preset.replaces} keeps its history. Once the new account is in, point vendors, bill rules and bank accounts at it, then switch ${preset.replaces} off.`) : null,
      el('div', { class: 'form-grid' }, field('Code', code), field('Name', name), field('Type', type), field('Normal balance', nb, 'Set from the type; change it for a contra account'),
        parentBox, el('label', { class: 'check' }, postable, 'Takes postings (unticked: a header for reports)'), field('Description', desc, null, true)),
      el('div', { class: 'form-sec', text: 'Used by' }), el('div', { class: 'coa-cos' }, cos.map(([c, b]) => el('label', { class: 'check' }, b, c.name))),
      el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel')), err);
    code.focus();
  }

  function openAccount(id, d) {
    const dlg = openDialog('Account', null, { wide: true, sheet: true });
    const again = () => { dlg.close(); openAccount(id, d); };
    fillDialog(dlg, async () => {
      const x = await coApi(`/chart/accounts/${id}`);
      const a = x.account;
      dlg.dlg.querySelector('h2').textContent = `${a.code} · ${a.name}`;
      const locked = x.posted;
      const code = input({ value: a.code, disabled: locked || x.packs.length ? true : null }), name = input({ value: a.name });
      const type = select(Object.entries(TYPE).map(([k, v]) => [k, v]), a.account_type);
      if (locked) type.disabled = true;
      const nb = select([['D', 'Debit'], ['C', 'Credit']], a.normal_balance);
      if (locked) nb.disabled = true;
      const parent = select([['', 'No rollup group'], ...headersOf(d, a.account_type, a.id).map((p) => [p.code, `${p.code} ${p.name}`])],
        (d.accounts.find((p) => p.id === a.parent_id) || {}).code || '');
      const postable = el('input', { type: 'checkbox', checked: a.is_postable, disabled: locked && a.is_postable ? true : null });
      const desc = el('textarea', { rows: '2', maxlength: '500', value: a.description || '' });
      const err = el('div');
      const save = el('button', { class: 'btn primary', type: 'button', onclick: () => {
        const body = { name: name.value, description: desc.value, parent: parent.value || null, postable: postable.checked };
        if (!locked && code.value.trim() !== a.code) body.code = code.value.trim();
        if (!locked && type.value !== a.account_type) body.type = type.value;
        if (!locked && nb.value !== a.normal_balance) body.normalBalance = nb.value;
        act(save, () => post(`/chart/accounts/${id}`, body), (r) => (r.changed.length ? 'Saved' : 'Nothing changed'), { errorInto: errInto(err), close: () => { dlg.close(); } });
      } }, 'Save');
      const replace = el('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); openAdd(d, { replaces: a.code, name: a.name, type: a.account_type, parent: (d.accounts.find((p) => p.id === a.parent_id) || {}).code }); } }, 'Make a new account instead…');
      const off = el('button', { class: 'btn', type: 'button', disabled: a.active && x.pointers.length ? true : null, onclick: async () => {
        if (a.active) {
          const why = await askReason({ title: `Switch off ${a.code}?`, label: 'Why', confirm: 'Switch it off', lead: 'It stays in the chart with its history, takes no new postings and drops out of pickers.' });
          if (why) act(off, () => post(`/chart/accounts/${id}`, { active: false, reason: why }), 'Account switched off', { close: again });
        } else act(off, () => post(`/chart/accounts/${id}`, { active: true }), 'Account switched back on', { close: again });
      } }, a.active ? 'Switch off' : 'Switch back on');
      const cos = x.companies.map((c) => [c, el('input', { type: 'checkbox', checked: c.uses })]);
      const cosSave = el('button', { class: 'btn small', type: 'button', onclick: () => act(cosSave, () => post(`/chart/accounts/${id}/companies`, { companies: cos.filter(([, b]) => b.checked).map(([c]) => c.id) }),
        (r) => (r.on || r.off ? `${r.on} switched on, ${r.off} off` : 'No change'), { close: again, errorInto: errInto(err) }) }, 'Save companies');
      return frag(
        el('div', { class: 'toolbar' }, !a.active ? chip('neutral', 'pause', 'Inactive') : chip('good', 'ok', 'Active'), !a.is_postable ? chip('neutral', 'book', 'Header') : null,
          x.posted ? chip('neutral', 'info', 'Has postings') : null, el('span', { class: 'grow' }), off),
        locked ? resultBox('neutral', 'info', 'Code, type and normal balance stay as they are', `${a.code} has postings, so the books keep what they say. To use a different code or type from now on, make a new account and move future postings to it.`) : null,
        x.packs.length ? resultBox('neutral', 'info', 'The ERP posts here by code', `${x.packs.join(', ')} setup. Its code stays ${a.code}.`) : null,
        a.active && x.pointers.length ? resultBox('warning', 'warn', 'Cannot be switched off yet', x.pointers.map((p) => cap(p)).join('. ') + '.') : null,
        el('div', { class: 'form-grid' }, field('Code', code), field('Name', name), field('Type', type), field('Normal balance', nb), field('Rolls up into', parent),
          el('label', { class: 'check' }, postable, 'Takes postings'), field('Description', desc, null, true)),
        el('div', { class: 'dlg-acts' }, save, locked ? replace : null), err,
        section('Companies', null, null, el('div', { class: 'panel' }, x.companies.map((c, i) => item({ title: c.name, amount: money(c.balance_minor),
          pick: cos[i][1], detail: c.uses ? 'uses it' : 'does not use it' }))), el('div', { class: 'dlg-acts' }, cosSave)),
        x.history.length ? section('Changes', null, null, el('div', { class: 'panel' }, x.history.map((h) => item({ title: `${shortDay(String(h.at).slice(0, 10))} · ${h.actor_label}`,
          detail: `${cap(h.action)}${h.reason ? `: ${h.reason}` : ''} ${h.after ? Object.keys(h.after).join(', ') : ''}` })))) : null);
    });
  }

  function openImport(d) {
    const dlg = openDialog('Import a chart of accounts', 'CSV: code, name, type, normal_balance, parent, postable, active, description, companies', { wide: true, sheet: true });
    const file = el('input', { type: 'file', accept: '.csv,text/csv' });
    const out = el('div');
    const show = async (runId, filter) => {
      const r = await coApi(`/chart/import/${runId}${filter ? `?action=${filter}` : ''}`);
      const run = r.run;
      const apply = run.status === 'previewed' ? el('button', { class: 'btn primary', type: 'button', onclick: () => act(apply, () => post(`/chart/import/${runId}/apply`),
        (x) => `Done: ${x.added} added, ${x.updated} updated, ${x.unchanged} unchanged, ${x.refused} refused`, { close: dlg.close }) }, 'Apply') : null;
      out.replaceChildren(frag(
        tilesRow(tile({ label: 'Add', value: String(run.added), tone: 'good', ic: 'plus', text: 'New accounts' }), tile({ label: 'Update', value: String(run.updated), tone: run.updated ? 'warning' : 'neutral', ic: 'refresh', text: 'Name, group, flags' }),
          tile({ label: 'Unchanged', value: String(run.unchanged), tone: 'neutral', ic: 'ok', text: 'Same as the chart' }), tile({ label: 'Refused', value: String(run.refused), tone: run.refused ? 'serious' : 'neutral', ic: 'warn', text: 'Each says why' })),
        resultBox(run.status === 'applied' ? 'good' : 'neutral', run.status === 'applied' ? 'ok' : 'info', run.status === 'applied' ? 'Applied' : 'Preview: nothing has changed yet', `${run.filename || 'file'} · ${run.rows} rows`),
        el('div', { class: 'toolbar' }, seg([['', 'All'], ['add', 'Add'], ['update', 'Update'], ['refuse', 'Refused'], ['same', 'Unchanged']], filter || '', (k) => show(runId, k)), el('span', { class: 'grow' }), apply),
        el('div', { class: 'panel' }, r.rows.length ? capped(r.rows.map((x) => item({
          title: `Row ${x.row_no}${x.code ? ` · ${x.code}` : ''}${x.fields.name ? ` ${x.fields.name}` : ''}`,
          badge: chip(x.action === 'refuse' ? 'critical' : x.action === 'add' ? 'good' : x.action === 'update' ? 'warning' : 'neutral',
            x.action === 'refuse' ? 'fail' : 'ok', { add: 'Add', update: 'Update', same: 'Unchanged', refuse: 'Refused' }[x.action]),
          detail: x.action === 'update' ? Object.entries(x.changes).map(([k, [b, a2]]) => `${k.replace(/_/g, ' ')}: ${b ?? '—'} → ${a2 ?? '—'}`).join(' · ') : '',
          why: x.message ? cap(x.message) : null })), 40, 'rows') : empty('None.', null, true))));
    };
    const pv = el('button', { class: 'btn primary', type: 'button', onclick: async () => {
      const f = file.files[0];
      if (!f) { toast('Choose the CSV file first.', 'warning'); return; }
      E.busy(pv, true, 'Reading…');
      try { const r = await post('/chart/import/preview', { csv: await f.text(), filename: f.name }); await show(r.runId, ''); }
      catch (e) { out.replaceChildren(resultBox('critical', 'fail', 'Not read', friendly(e))); }
      finally { E.busy(pv, false); }
    } }, 'Preview');
    dlg.body.append(el('p', { class: 'lead', text: 'Rows are matched by code. New codes are added; existing ones are updated where the file differs; the same file twice changes nothing. Postable and active are yes or no; companies are names separated by ;. Nothing changes until you apply.' }),
      el('div', { class: 'form-grid' }, field('CSV file', file, 'Export the chart first for a file in the right shape', true)), el('div', { class: 'dlg-acts' }, pv), out);
  }

  // Styles through the CSSOM: the page's policy allows no inline <style>.
  if (!window.__coaSheet) {
    const sh = new CSSStyleSheet();
    sh.replaceSync(`.coa-tb{display:grid;grid-template-columns:1fr;gap:6px 14px;margin:0 0 10px}
@media (min-width:720px){.coa-tb{grid-template-columns:2fr auto auto;align-items:center}}
.coa-search{width:100%;font-size:16px;color:var(--ink);background:var(--panel);border:1px solid var(--line-2);border-radius:9px;padding:9px 11px;min-height:42px}
.coa-l1 .li{padding-left:30px}.coa-l2 .li{padding-left:44px}.coa-l3 .li{padding-left:58px}
.coa-cos{display:flex;flex-wrap:wrap;gap:4px 18px}`);
    window.__coaSheet = sh;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh];
  }

  E.register('chart', 'Chart of accounts', 'book', screen, 'Back office', { module: null });   // part of the books, never switched off
})();
