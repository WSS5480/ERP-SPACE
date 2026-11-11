// Admin: Services (which services this company shows) and Connections (email,
// texts, card payments, maps, marketplaces... in one place), with the log of
// what was emailed and texted. Values are placed with textContent only.
(() => {
  'use strict';
  const E = window.ERP;
  const { el, frag, head, section, item, chip, empty, toast, act, openDialog, field, select, input, post, coApi, plural, ago, resultBox, seg, capped } = E;

  const roles = () => (E.S.person && E.S.person.roles) || [];
  const isOwner = () => roles().includes('owner');
  const manages = () => roles().some((r) => r === 'owner' || r === 'controller');
  const GROUPS = ['Back office', 'Retail', 'Operations', 'Setup'];

  /** After a switch: fetch what shows now, and redraw the menu and the screen. */
  async function refreshNav() {
    try { const m = await coApi('/setup/modules'); E.S.modules = m.modules; E.S.layout = m.layout; } catch (_) { /* the next load fixes it */ }
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }

  // ================================================================ services
  // "Apply to all my companies" belongs to the company it was ticked in; another company starts unticked.
  let applyAll = false, applyAllCo = null;
  async function screenServices() {
    const d = await coApi('/admin/services');
    if (applyAllCo !== E.S.co.id) { applyAll = false; applyAllCo = E.S.co.id; }
    const can = manages();
    const many = d.companies.length > 1;
    const L = d.layout;

    const allBox = el('input', { type: 'checkbox', checked: applyAll || null, disabled: !can || null });
    allBox.addEventListener('change', () => { applyAll = allBox.checked; });
    const scopeRow = many ? el('label', { class: 'li check-row' }, allBox,
      el('div', { class: 't', text: 'Apply to all my companies' }),
      el('div', { class: 'd', text: `Switches and presets change ${d.companies.map((x) => x.name).join(', ')} together.` })) : null;

    const layoutWords = L.single ? 'Single store' : [L.multiCompany ? `${plural(L.companies, 'company', 'companies')}` : 'One company', L.multiStore ? `${plural(L.locations, 'location')}` : 'one location'].join(', ');
    const layoutCard = el('div', { class: 'panel' },
      item({ title: layoutWords, detail: L.mode === 'auto'
        ? `Counted: ${plural(L.companies, 'company', 'companies')} in this client, ${plural(L.locations, 'store or warehouse', 'stores and warehouses')} here. Group shows with a second company; store orders, transfers and store pickers with a second location.`
        : `Set by hand to ${L.mode === 'single' ? 'single store' : 'several stores'}; the count says ${plural(L.companies, 'company', 'companies')} and ${plural(L.locations, 'location')}.` }),
      isOwner() ? el('div', { class: 'toolbar' }, seg([['auto', 'Automatic'], ['single', 'Single store'], ['multi', 'Several stores']], L.mode,
        (v) => act(document.activeElement, async () => { const r = await post('/admin/services/layout', { mode: v }); await refreshNav(); return r; }, 'Saved'))) : null);

    const presets = el('div', { class: 'pack-grid' }, d.presets.map((p) => el('div', { class: 'panel pack' },
      el('h3', { text: p.name }), el('p', { class: 'd', text: p.blurb }),
      el('p', { class: 'fine', text: `${plural(p.services.length, 'service')} on${p.pack ? ' · adds the ' + p.pack + ' setup’s accounts and defaults' : ''}` }),
      el('div', { class: 'acts' }, el('button', { class: 'btn', type: 'button', disabled: !can || null, onclick: () => confirmPreset(p, d) }, 'Use this preset')))));

    const byGroup = GROUPS.map((g) => [g, d.services.filter((s) => s.group === g)]).filter(([, l]) => l.length);
    const cards = byGroup.map(([g, list]) => section(g, `${list.filter((s) => s.showing).length} of ${list.length} showing`, null,
      el('div', { class: 'panel' }, list.map((s) => serviceRow(s, can)))));

    return frag(
      head('Services', null, 'Admin'),
      el('p', { class: 'lead', text: 'Turn a service off to hide its screens, Home cards and menu entries for this company. It keeps running underneath: its data, scheduled jobs and postings carry on, and other services still use it, so turning it back on loses nothing.' }),
      can ? null : resultBox('warning', 'warn', 'Only the owner or a controller changes these', 'You can see what is on; switch who you are acting as to change it.'),
      el('div', { class: 'two' },
        el('div', {}, section('This company', null, null, layoutCard), scopeRow ? section('Companies', null, null, el('div', { class: 'panel' }, scopeRow)) : null),
        el('div', {}, section('Always on', null, null, el('div', { class: 'panel' }, item({ title: 'The books and setup',
          detail: 'Home, Approvals, Payables, Books, Chart of accounts, Cash, Reconcile, Feeds, Setup, Business setup, Services and Connections.' }))))),
      section('Presets', 'a starting shape; change any switch afterwards', null, presets),
      cards);
  }

  function serviceRow(s, can) {
    const box = el('input', { type: 'checkbox', checked: s.switchOn || null, disabled: !can || null, 'aria-label': s.name });
    box.addEventListener('change', () => act(box, async () => {
      const r = await post('/admin/services/switch', { service: s.id, enabled: box.checked, allCompanies: applyAll });
      await refreshNav(); return r;
    }, (r) => `${s.name} turned ${r.enabled ? 'on' : 'off'}${r.companies > 1 ? ` in ${r.companies} companies` : ''}${r.alsoOn && r.alsoOn.length ? ' (and what it belongs to)' : ''}`));
    const facts = [
      s.parentName ? `Part of ${s.parentName}: off with it.` : null,
      s.children.length ? `Hides with it: ${s.children.join(', ')}.` : null,
      s.usedBy.length ? `Used by ${s.usedBy.join(', ')} (they keep working).` : null,
      s.needs === 'multi_company' ? 'Shows once there is a second company.' : s.needs === 'multi_store' ? 'Shows once there is a second location.' : null,
    ].filter(Boolean);
    const badge = s.showing ? chip('good', 'ok', 'On') : s.switchOn ? chip('warning', 'hold', `Hidden: ${s.hiddenWhy}`) : chip('neutral', 'pause', 'Off');
    return el('label', { class: 'li check-row' }, box,
      el('div', { class: 't' }, el('span', { text: s.name }), ' ', badge),
      el('div', { class: 'd', text: s.description }),
      facts.length ? el('div', { class: 'f', text: facts.join(' ') }) : null);
  }

  async function confirmPreset(p, d) {
    const all = applyAll && d.companies.length > 1;
    const dlg = openDialog(`Use ${p.name.toLowerCase()}?`, all ? `All ${d.companies.length} companies` : E.S.co.name);
    const names = new Map(d.services.map((s) => [s.id, s.name]));
    const out = el('div');
    const openBox = el('div', {}, E.loadingNode('Checking for open work…'));
    const ok = el('input', { type: 'checkbox' });
    const go = el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget, async () => {
      const r = await post('/admin/services/preset', { preset: p.id, allCompanies: all, confirm: ok.checked });
      await refreshNav(); return r;
    }, (r) => `${p.name} applied${r.companies > 1 ? ` to ${r.companies} companies` : ''}.${r.notes.length ? ' ' + r.notes.join(' ') : ''}`,
    { close: dlg.close, errorInto: (x) => out.replaceChildren(resultBox('critical', 'fail', 'Not applied', E.friendly(x))) }) }, 'Apply');
    dlg.body.append(
      el('p', { class: 'lead', text: p.blurb }),
      el('p', { text: `On: ${p.services.map((x) => names.get(x) || x).join(', ')}. Everything else is switched off (hidden, never deleted).` }),
      p.pack ? el('p', { class: 'fine', text: isOwner() ? 'The matching setup pack also adds the accounts, pick lists and defaults it needs. It only ever adds.' : 'Only the owner adds the matching setup pack’s accounts and defaults; you set the switches.' }) : null,
      openBox, out,
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: dlg.close }, 'Cancel'), go));
    try {
      const r = await coApi(`/admin/services/preset-check?preset=${encodeURIComponent(p.id)}${all ? '&all=1' : ''}`);
      if (!r.open.length) { openBox.replaceChildren(el('p', { class: 'fine', text: 'Nothing it switches off has open work.' })); ok.checked = true; return; }
      go.disabled = true;
      ok.addEventListener('change', () => { go.disabled = !ok.checked; });
      openBox.replaceChildren(resultBox('warning', 'warn', 'These still have open work', 'Their records stay and keep working, but their screens hide until you turn them back on.'),
        el('div', { class: 'panel' }, r.open.map((o) => item({ title: o.name, detail: `${o.count} ${o.what}${all ? ` · ${o.company}` : ''}` }))),
        el('label', { class: 'li check-row' }, ok, el('div', { class: 't', text: 'Switch them off anyway' })));
    } catch (x) { openBox.replaceChildren(resultBox('critical', 'fail', 'Could not check', E.friendly(x))); go.disabled = true; }
  }

  // ============================================================= connections
  const STATUS = { connected: ['good', 'ok', 'Connected'], failing: ['critical', 'fail', 'Failing'], saved: ['warning', 'hold', 'Saved'],
    not_set_up: ['neutral', 'pause', 'Not set up'], later: ['neutral', 'info', 'Coming later'], summary: ['neutral', 'info', 'Own screen'] };
  let connTab = 'connections';

  async function screenConnections(sub) {
    if (sub === 'log' || sub === 'connections' || sub === 'vendor') connTab = sub;
    const tabs = el('div', { class: 'toolbar' }, seg([['connections', 'Connections'], ['vendor', 'Vendor files'], ['log', 'Message log']], connTab, (v) => { connTab = v; VF.view = 'list'; E.render(); }));
    if (connTab === 'log') return frag(head('Connections', null, 'Admin'), tabs, await logView());
    if (connTab === 'vendor') return frag(head('Connections', null, 'Admin'), tabs, await vendorFilesView());
    const d = await coApi('/admin/connections');
    const groups = [...new Set(d.kinds.map((k) => k.group))];
    return frag(
      head('Connections', null, 'Admin'), tabs,
      el('p', { class: 'lead', text: 'Everything this ERP talks to outside, in one place. Set each one for this company, or once for the whole client (a company’s own setting wins). Keys and passwords are stored encrypted and never shown again; you only see that one is set.' }),
      el('div', { class: 'panel pad' }, item({ title: 'Vendor catalog connections are set up per vendor in Catalog → Vendors',
        detail: 'Each vendor’s Catalog connections: API, SFTP, email-in or file import. Files a vendor drops on SFTP, serves over HTTPS or emails (catalogs, prices, inventory, EDI) are under the Vendor files tab.',
        acts: [el('button', { class: 'btn small', type: 'button', onclick: () => E.go('catalog', 'vendors') }, 'Open Catalog → Vendors'),
          el('button', { class: 'btn small', type: 'button', onclick: () => { connTab = 'vendor'; E.render(); } }, 'Vendor files')] })),
      d.secretKey ? null : resultBox('warning', 'warn', 'Keys cannot be stored yet', 'Add ERP_SECRET_KEY (32 random bytes, base64) to the service’s environment; until then settings save but keys and passwords do not.'),
      groups.map((g) => section(g, null, null, el('div', { class: 'pack-grid' }, d.kinds.filter((k) => k.group === g).map(kindCard)))));
  }

  function kindCard(k) {
    const [tone, ic, word] = STATUS[k.status] || STATUS.not_set_up;
    const using = k.using === 'client' ? 'Using the client’s setting' : k.using === 'company' ? 'Set for this company' : null;
    const sum = k.summary ? summaryText(k) : null;
    return el('div', { class: 'panel pack' },
      el('h3', { text: k.name }),
      el('div', {}, chip(tone, ic, word)),
      k.status === 'failing' || k.status === 'saved' ? el('p', { class: 'd', text: k.statusWords }) : null,
      el('p', { class: 'd', text: k.note }),
      sum ? el('p', { class: 'fine', text: sum }) : null,
      using ? el('p', { class: 'fine', text: using }) : null,
      el('div', { class: 'acts' },
        k.link ? el('button', { class: 'btn small', type: 'button', onclick: () => E.go(k.link.screen) }, k.link.label) : null,
        k.manage && k.providers.length ? el('button', { class: 'btn small primary', type: 'button', onclick: () => openKind(k) }, k.company || k.client ? 'Settings' : 'Set up') : null,
        !k.manage && k.state !== 'summary' ? el('span', { class: 'fine', text: 'The owner or a controller sets this up.' }) : null));
  }

  function summaryText(k) {
    const s = k.summary;
    if (k.id === 'vendor_api') return `${plural(s.feeds, 'feed')} for ${plural(s.vendors, 'vendor')}, ${s.active} active${s.failing ? `, ${s.failing} failing` : ''}.`;
    if (k.id === 'edi') return `${plural(s.partners, 'trading partner')}, ${s.enabled} live${s.waiting_on_transport ? `, ${s.waiting_on_transport} waiting on AS2` : ''}.`;
    if (k.id === 'printers') return `${plural(s.printers, 'printer')} set up.`;
    if (k.id === 'bank') return `${plural(s.connections, 'statement connection')}, ${plural(s.statements, 'statement')} imported.`;
    if (k.id === 'card') return `${plural(s.sites, 'web store')} · processor: ${s.processors}.`;
    if (k.id === 'maps') return `In use for routing: ${s.inUse}.`;
    return null;
  }

  function openKind(k) {
    const dlg = openDialog(k.name, E.S.co.name, { wide: true });
    let scope = k.company || !k.client ? 'company' : 'client';
    const draw = () => {
      const cur = scope === 'client' ? k.client : k.company;
      const prov = select(k.providers.map((p) => [p.id, p.name]), cur ? cur.provider : k.providers[0].id);
      const form = el('div', { class: 'form-grid' });
      const boxes = {};
      const fillForm = () => {
        const p = k.providers.find((x) => x.id === prov.value);
        const same = cur && cur.provider === p.id;
        for (const key of Object.keys(boxes)) delete boxes[key];
        form.replaceChildren(...p.fields.map((f) => {
          let ctl;
          const val = same && cur.settings[f.name] != null ? String(cur.settings[f.name]) : '';
          if (f.type === 'select') ctl = select(f.options, val || f.options[0][0]);
          else if (f.secret) ctl = input({ type: 'password', autocomplete: 'new-password', placeholder: same && cur.secrets[f.name] ? 'Set · type to replace' : 'Not set' });
          else ctl = input({ value: val, type: f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : f.type === 'url' ? 'url' : 'text', inputmode: f.type === 'number' ? 'numeric' : null });
          boxes[f.name] = { f, ctl };
          return field(f.label + (f.required ? '' : ' (optional)'), ctl, f.secret && same && cur.secrets[f.name] ? 'Set' : f.hint || null);
        }));
        if (!p.fields.length) form.replaceChildren(el('p', { class: 'd', text: 'Nothing to fill in for this one.' }));
      };
      prov.addEventListener('change', fillForm);
      fillForm();
      const out = el('div', { role: 'status', 'aria-live': 'polite' });
      const say = (tone, ic, t, x) => out.replaceChildren(resultBox(tone, ic, t, x));
      const save = el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget, () => {
        const settings = {}, secrets = {};
        for (const [name, { f, ctl }] of Object.entries(boxes)) { if (f.secret) { if (ctl.value) secrets[name] = ctl.value; } else settings[name] = ctl.value; }
        return post('/admin/connections/save', { kind: k.id, provider: prov.value, scope, settings, secrets });
      }, (r) => r.missing && r.missing.length ? `Saved. Still needed: ${r.missing.join(', ')}.` : 'Saved', { close: dlg.close, errorInto: (x) => say('critical', 'fail', 'Not saved', E.friendly(x)) }) }, 'Save');
      const to = k.test && k.test !== 'webhook' ? input({ placeholder: k.test === 'email' ? 'you@example.com' : k.test === 'sms' ? '+1 555 555 0100' : 'An address to look up', type: k.test === 'email' ? 'email' : 'text' }) : null;
      const test = k.test && cur ? el('button', { class: 'btn', type: 'button', onclick: async (e) => {
        const b = e.currentTarget; E.busy(b, true);
        try { const r = await post('/admin/connections/test', { kind: k.id, scope, to: to ? to.value : '' }); say(r.ok ? 'good' : 'critical', r.ok ? 'ok' : 'fail', r.ok ? 'Working' : 'Not working', r.words); }
        catch (x) { say('critical', 'fail', 'Not tested', E.friendly(x)); }
        finally { if (b.isConnected) E.busy(b, false); }
      } }, 'Test') : null;
      const off = cur ? el('button', { class: 'btn', type: 'button', onclick: (e) => act(e.currentTarget, () => post('/admin/connections/off', { kind: k.id, scope }), 'Turned off', { close: dlg.close }) }, 'Turn off') : null;
      dlg.body.replaceChildren(
        el('p', { class: 'lead', text: k.note }),
        k.state === 'later' || k.state === 'stored' ? resultBox('warning', 'info', 'Nothing is sent yet', 'Keys saved here are stored encrypted, ready for when this is built.') : null,
        el('div', { class: 'toolbar' }, seg([['company', 'This company'], ['client', 'Whole client']], scope, (v) => { scope = v; draw(); })),
        cur && cur.lastError ? resultBox('critical', 'fail', 'Last error', cur.lastError) : null,
        cur ? el('p', { class: 'fine', text: `Saved by ${cur.updatedBy || 'someone'}, ${ago(cur.updatedAt)}${cur.lastOkAt ? ` · last worked ${ago(cur.lastOkAt)}` : ''}` }) : null,
        el('div', { class: 'form-grid' }, field('Provider', prov, null, true)), form,
        to ? el('div', { class: 'form-grid' }, field(k.test === 'geocode' ? 'Test address' : 'Send the test to', to, 'Save first; the test uses what is saved', true)) : null,
        out,
        el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: dlg.close }, 'Close'), off, test, save));
    };
    draw();
  }

  async function logView() {
    const d = await coApi('/admin/messages');
    const can = manages();
    const STAT = { sent: ['good', 'ok', 'Sent'], failed: ['critical', 'fail', 'Failed'], logged: ['neutral', 'info', 'Logged, not sent'], queued: ['warning', 'hold', 'Queued'] };
    const banner = !d.email || !d.sms ? resultBox('warning', 'info', 'Some messages are logged, not sent',
      `${!d.email ? 'No email is connected' : ''}${!d.email && !d.sms ? ' and ' : ''}${!d.sms ? (d.email ? 'No text provider is connected' : 'no text provider') : ''}: those messages are kept here and nothing goes out. Set them up under Connections.`) : null;
    return frag(banner, d.webOnly ? el('p', { class: 'fine', text: 'Showing what the web store and marketing sent.' }) : null, section('Emails and texts', plural(d.messages.length, 'message'), null, el('div', { class: 'panel' }, d.messages.length ? d.messages.map((m) => {
      const [tone, ic, word] = STAT[m.status] || STAT.queued;
      return item({ title: `${m.channel === 'sms' ? 'Text' : m.channel === 'email' ? 'Email' : 'Webhook'} to ${m.to_addr}`,
        detail: [m.subject, m.purpose.replace(/_/g, ' '), m.provider !== 'none' ? m.provider : null, m.provider_ref ? `id ${m.provider_ref}` : null,
          m.error, m.redacted ? 'code kept as ******' : null, ago(m.created_at)].filter(Boolean).join(' · '),
        badge: chip(tone, ic, word),
        acts: can && m.resendable && m.status !== 'queued' ? [el('button', { class: 'btn small', type: 'button', onclick: (e) => act(e.currentTarget, () => post(`/admin/messages/${m.id}/resend`, {}),
          (r) => r.status === 'sent' ? 'Sent again' : r.status === 'logged' ? 'Logged again, not sent' : `Not sent: ${r.error}`) }, 'Resend')] : null });
    }) : empty('Nothing sent yet.', 'Sign-in codes, purchase orders, delivery texts, tear sheets and scheduled reports show here.', true))));
  }

  // ============================================================ vendor files
  // SFTP and HTTPS pulls and vendor email, carrying catalogs, prices, inventory
  // and EDI documents. A list of cards; each number opens what is behind it,
  // with Back. Phone first: cards and pickers, no tables.
  const VF = { view: 'list', id: null, filter: null, vendor: null };
  const KIND = { catalog: 'Catalog', prices: 'Prices', inventory: 'Inventory', edi: 'EDI documents' };
  const CHAN = { sftp: 'SFTP', api: 'HTTPS address', email: 'Email' };
  const FILE_STATUS = { applied: ['good', 'ok', 'Applied'], quarantined: ['serious', 'hold', 'Quarantined'], ignored: ['neutral', 'none', 'Set aside'],
    parsed: ['neutral', 'info', 'Read'], received: ['neutral', 'pending', 'Received'] };
  const VERDICT = { healthy: ['good', 'ok', 'Healthy'], 'never run': ['neutral', 'pending', 'Not run yet'], stale: ['warning', 'clock', 'Stale'],
    failing: ['critical', 'fail', 'Failing'], paused: ['neutral', 'pause', 'Paused'], retired: ['neutral', 'none', 'Retired'], failed: ['critical', 'fail', 'Stopped after failures'], draft: ['neutral', 'pending', 'Draft'] };
  const SCHEDULES = [['0 * * * *', 'Every hour'], ['0 */4 * * *', 'Every 4 hours'], ['30 5 * * *', 'Daily, 5:30 (UTC)'], ['30 5 * * 1-5', 'Weekdays, 5:30 (UTC)'], ['custom', 'Custom (cron)']];
  const vfManage = () => roles().some((r) => r === 'owner' || r === 'controller' || r === 'buyer');
  const fp = (x) => x ? `${x}` : '—';
  const backBtn = (to) => el('button', { class: 'btn', type: 'button', onclick: () => { Object.assign(VF, to || { view: 'list', id: null, filter: null }); E.render(); } }, E.icon('chev', 'back'), 'Back');
  const goVF = (to) => { Object.assign(VF, to); E.render(); };
  const carriesText = (cfg) => (cfg.carries || []).map((x) => `${KIND[x.kind] || x.kind}${x.glob ? ` (${x.glob})` : ''}`).join(', ');
  const kb = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  const copyBox = (text) => {
    const inp = el('input', { value: text, readonly: true, 'aria-label': 'Address', class: 'copy-in' });
    const b = el('button', { class: 'btn small', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied', 'good'); } catch (_) { inp.select(); } } }, 'Copy');
    return el('div', { class: 'copy-row' }, inp, b);
  };

  async function vendorFilesView() {
    if (VF.view === 'conn') return connView();
    if (VF.view === 'held') return heldView();
    if (VF.view === 'files') return filesView();
    const d = await coApi('/vendor-files');
    const can = vfManage();
    const live = d.connections.filter((x) => x.status !== 'retired');
    const vlist = VF.vendor ? live.filter((x) => x.vendor_id === VF.vendor) : live;
    const files = live.reduce((n, x) => n + Number(x.files || 0), 0), quar = live.reduce((n, x) => n + Number(x.quarantined || 0), 0);
    const failing = live.filter((x) => x.verdict === 'failing' || x.status === 'failed').length;
    const allBtn = VF.vendor ? el('button', { class: 'btn small', type: 'button', onclick: () => goVF({ vendor: null }) }, 'All vendors') : null;
    const addBtn = can ? el('button', { class: 'btn small primary', type: 'button', onclick: () => openVendorConn(d, null, VF.vendor) }, E.icon('plus'), 'Add a vendor connection') : null;
    const listSection = connList(d, vlist, allBtn, addBtn);
    if (VF.view === 'connlist') return frag(head('Connections', [backBtn()], 'Vendor files'), listSection);
    return frag(
      el('p', { class: 'lead', text: 'Files your vendors send: catalogs, prices, inventory and EDI documents, from their SFTP server, an HTTPS address, or by email. Each connection belongs to one vendor; files are read through the same mapping as Catalog import and Vendor EDI.' }),
      E.tilesRow(
        E.tile({ label: 'Connections', value: String(live.length), suffix: failing ? `${failing} failing` : null, tone: failing ? 'critical' : 'neutral', ic: failing ? 'fail' : 'feed', text: 'SFTP, HTTPS and email',
          onClick: () => goVF({ view: 'connlist' }) }),
        E.tile({ label: 'Files taken', value: String(files), tone: 'neutral', ic: 'info', text: 'Every file, every connection', onClick: () => goVF({ view: 'files', filter: null }) }),
        E.tile({ label: 'Quarantined', value: String(quar), tone: quar ? 'serious' : 'good', ic: quar ? 'warn' : 'ok', text: quar ? 'Held with a reason; open to see' : 'Nothing held',
          onClick: () => goVF({ view: 'files', filter: 'quarantined' }) }),
        E.tile({ label: 'Mail held', value: String(d.held.length), tone: d.held.length ? 'warning' : 'good', ic: d.held.length ? 'hold' : 'ok',
          text: d.held.length ? 'Waiting for your review' : 'Nothing held', onClick: () => goVF({ view: 'held' }) })),
      section('Vendor email address', null, null, el('div', { class: 'panel pad' },
        d.address ? copyBox(d.address) : resultBox('warning', 'info', 'Inbound email is not set up on this server', 'Set ERP_INBOUND_EMAIL_ADDRESS (the inbound address of your mail service) and ERP_EMAIL_INBOUND_TOKEN. Until then, email connections save but nothing arrives.'),
        el('p', { class: 'fine', text: 'Your company’s own address. Ask each vendor to send files here. A file goes straight to the vendor connection or email-in feed that lists its sender only when the receiving mail server confirms the sender (SPF pass for the sender’s own domain). Forwarded mail, mail sent through a mailing service, and anyone not listed are held for one-tap review: nothing is applied automatically. Each vendor also has its own address, on its card under Catalog, Vendors.' }))),
      listSection);
  }

  function connList(d, vlist, allBtn, addBtn) {
    return section(VF.vendor ? `Connections · ${(d.vendors.find((v) => v.id === VF.vendor) || {}).name || 'one vendor'}` : 'Connections', `${vlist.length}`, [allBtn, addBtn].filter(Boolean), el('div', { class: 'panel' }, vlist.length ? vlist.map((x) => {
        const [tone, ic, word] = VERDICT[x.status !== 'active' ? x.status : x.verdict] || VERDICT['never run'];
        const lr = x.last_run;
        return item({ title: `${x.vendor} · ${x.name}`, badge: chip(tone, ic, word),
          detail: [CHAN[x.channel], carriesText(x.config), x.channel === 'sftp' ? `${x.config.host}${Number(x.config.port) !== 22 ? `:${x.config.port}` : ''} ${x.config.path}` : x.channel === 'api' ? x.config.endpoint : (x.allowed_senders || []).join(', '),
            `${plural(Number(x.files), 'file')}`, Number(x.quarantined) ? `${x.quarantined} quarantined` : null].filter(Boolean).join(' · '),
          why: lr ? `Last run ${ago(lr.started_at)}: ${lr.outcome || 'running'}, ${lr.files_new} new of ${lr.files_seen}${lr.error ? ` — ${lr.error}` : ''}` : x.last_error || null,
          onClick: () => goVF({ view: 'conn', id: x.id, filter: null }) });
      }) : empty('No vendor connections yet.', 'Add one for each vendor that leaves files on its SFTP server, answers from an HTTPS address, or emails them.', true)));
  }

  async function connView() {
    const d = await coApi(`/vendor-files/${VF.id}${VF.filter ? `?status=${VF.filter}` : ''}`);
    const all = VF.filter ? (await coApi(`/vendor-files/${VF.id}`)).files : d.files;
    const x = d.connection, can = vfManage();
    const cfg = x.config || {};
    const out = el('div', { role: 'status', 'aria-live': 'polite' });
    const say = (tone, ic, t, w) => out.replaceChildren(resultBox(tone, ic, t, w));
    const pinBox = el('div');
    const showPin = (p) => pinBox.replaceChildren(p ? el('div', { class: 'facts' },
      E.fact('Server key', fp(p.fingerprint)), E.fact('Recorded', `${p.pinned_by_name || 'someone'}, ${ago(p.pinned_at)}`),
      p.offered_fingerprint ? E.fact('New key shown', p.offered_fingerprint) : null) : x.channel === 'sftp' ? el('p', { class: 'fine', text: 'No server key recorded yet. Press Test: it shows the key and records it, and a different key is refused after that.' }) : null);
    showPin(d.pin);
    const test = el('button', { class: 'btn', type: 'button', onclick: async (e) => {
      const b = e.currentTarget; E.busy(b, true);
      try {
        const r = await post(`/vendor-files/${x.id}/test`, {});
        if (r.channel === 'sftp') {
          const sample = (r.sample || []).slice(0, 5).map((f) => f.name).join(', ');
          say(r.ok ? 'good' : 'critical', r.ok ? 'ok' : 'fail', r.ok ? (r.firstTime ? 'Connected; key recorded' : 'Connected') : r.changed ? 'The server key changed' : 'Not working',
            `${r.words}${r.fingerprint ? ` Key: ${r.fingerprint} (${r.keyType}).` : ''}${sample ? ` Files: ${sample}${r.files > 5 ? '…' : ''}.` : ''}`);
          if (r.changed && isOwner()) out.append(el('div', { class: 'dlg-acts' }, el('button', { class: 'btn primary', type: 'button', onclick: (ev) => act(ev.currentTarget,
            () => post(`/vendor-files/${x.id}/trust-key`, { fingerprint: r.fingerprint }), `New key trusted: ${r.fingerprint}`) }, `Trust the new key ${r.fingerprint}`)));
          else if (r.changed) out.append(el('p', { class: 'fine', text: 'Only the owner can trust a new server key; check with the vendor first.' }));
        } else say(r.ok ? 'good' : 'critical', r.ok ? 'ok' : 'fail', r.ok ? 'Working' : 'Not working', r.words);
        const again = await coApi(`/vendor-files/${x.id}`); showPin(again.pin);
      } catch (ex) { say('critical', 'fail', 'Not tested', E.friendly(ex)); }
      finally { if (b.isConnected) E.busy(b, false); }
    } }, 'Test');
    const run = x.channel !== 'email' ? el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget, () => post(`/vendor-files/${x.id}/run`, {}),
      (r) => (r.ok ? `Done: ${r.words}` : `Failed: ${r.words}`)) }, 'Run now') : null;
    const statusBtn = (to, label) => el('button', { class: 'btn', type: 'button', onclick: (e) => act(e.currentTarget, () => post(`/vendor-files/${x.id}/status`, { status: to }), `${label}: done`) }, label);
    const edit = el('button', { class: 'btn', type: 'button', onclick: async () => openVendorConn(await coApi('/vendor-files'), { ...x, secrets: d.secrets }) }, 'Edit');
    const n = (st) => all.filter((f) => !st || f.status === st).length;
    return frag(
      head(x.name, [backBtn()], `Vendor files · ${CHAN[x.channel]}`),
      el('div', { class: 'panel pad' }, el('div', { class: 'facts' },
        E.fact('Carries', carriesText(cfg) || '—'),
        x.channel === 'sftp' ? E.fact('Server', `${cfg.user}@${cfg.host}${Number(cfg.port) !== 22 ? `:${cfg.port}` : ''} ${cfg.path}`) : null,
        x.channel === 'sftp' ? E.fact('After taking a file', cfg.after === 'move' ? `move to ${cfg.moveTo}` : cfg.after === 'delete' ? 'delete it' : 'leave it') : null,
        x.channel === 'api' ? E.fact('Address', cfg.endpoint) : null,
        x.channel === 'email' ? E.fact('Senders', (x.allowed_senders || []).join(', ')) : null,
        x.schedule_cron ? E.fact('Schedule', (SCHEDULES.find((s2) => s2[0] === x.schedule_cron) || [0, `cron ${x.schedule_cron} (UTC)`])[1]) : null,
        E.fact('Status', x.status), E.fact('Secrets', d.secrets.length ? `${d.secrets.join(', ')} set` : x.channel === 'email' ? 'none (the sender list is its lock)' : 'none set')),
        pinBox, out,
        can ? el('div', { class: 'dlg-acts' }, edit, x.status === 'active' ? statusBtn('paused', 'Pause') : statusBtn('active', 'Turn on'), x.status !== 'retired' ? statusBtn('retired', 'Retire') : null, test, run) : null),
      E.tilesRow(
        E.tile({ label: 'Files', value: String(n(null)), tone: 'neutral', ic: 'info', text: 'Everything taken', onClick: () => goVF({ filter: null }) }),
        E.tile({ label: 'Applied', value: String(n('applied')), tone: 'good', ic: 'ok', text: 'Read and applied', onClick: () => goVF({ filter: 'applied' }) }),
        E.tile({ label: 'Quarantined', value: String(n('quarantined')), tone: n('quarantined') ? 'serious' : 'good', ic: n('quarantined') ? 'warn' : 'ok', text: 'Held with a reason', onClick: () => goVF({ filter: 'quarantined' }) })),
      section(VF.filter ? `Files · ${(FILE_STATUS[VF.filter] || [0, 0, VF.filter])[2]}` : 'Files', `${d.files.length}`, VF.filter ? [el('button', { class: 'btn small', type: 'button', onclick: () => goVF({ filter: null }) }, 'Show all')] : null,
        el('div', { class: 'panel' }, d.files.length ? capped(d.files.map((f) => item({ title: f.origin, badge: chip(...(FILE_STATUS[f.status] || ['neutral', 'info', f.status])),
          detail: [kb(Number(f.byte_size)), f.format, f.rows_parsed != null ? plural(Number(f.rows_parsed), 'row') : null, ago(f.received_at)].filter(Boolean).join(' · '),
          why: f.quarantine_reason || f.note || null,
          acts: can && f.status === 'quarantined' ? [el('button', { class: 'btn small', type: 'button', onclick: async (e) => {
            const why = await E.askReason({ title: 'Set this file aside?', sub: f.origin, label: 'Why', confirm: 'Set aside', lead: 'It stays on record; it leaves the quarantine list.' });
            if (why) act(e.currentTarget, () => post(`/vendor-files/files/${f.id}/dismiss`, { reason: why }), 'Set aside');
          } }, 'Set aside')] : null })), 20, 'files') : empty('No files here.', null, true))),
      section('Runs', `${d.runs.length}`, null, el('div', { class: 'panel' }, d.runs.length ? capped(d.runs.map((r) => item({ title: `${r.trigger} · ${ago(r.started_at)}`,
        badge: chip(...(r.outcome === 'ok' ? ['good', 'ok', 'OK'] : r.outcome === 'partial' ? ['warning', 'warn', 'Partly'] : r.outcome === 'failed' ? ['critical', 'fail', 'Failed'] : ['neutral', 'clock', 'Running'])),
        detail: `${r.files_new} new of ${r.files_seen}${r.files_failed ? `, ${r.files_failed} quarantined` : ''}`, why: r.error || null })), 10, 'runs') : empty('Not run yet.', null, true))));
  }

  async function heldView() {
    const d = await coApi('/vendor-files');
    const can = vfManage();
    const targets = [...d.connections.filter((x) => x.channel === 'email' && x.status === 'active').map((x) => [`c:${x.id}`, `${x.vendor} · ${x.name} (connection)`]),
      ...d.emailFeeds.map((f) => [`f:${f.id}`, `${f.vendor} · ${f.name} (feed)`])];
    const rv = (await coApi('/vendor-files/review')).vendors;
    return frag(head('Mail held', [backBtn()], 'Vendor files'),
      el('p', { class: 'lead', text: 'Nothing here has been read. Mail lands here when the sender could not be confirmed (forwarded mail, a mailing service, a failed SPF or DMARC check), when no vendor lists the sender, when it matches two vendors, or when its vendor is set to always hold for review. Apply runs it through the vendor’s own mapping; Assign sends it somewhere else; Set aside keeps the record.' }),
      el('div', { class: 'panel' }, d.held.length ? d.held.map((h) => item({ title: h.filename, badge: chip('warning', 'hold', h.has_content ? 'Held' : 'Record only'),
        detail: [h.sender, h.vendor ? `for ${h.vendor}` : null, h.suggested ? `would go to ${h.suggested}` : null, h.subject, kb(Number(h.byte_size)), ago(h.received_at)].filter(Boolean).join(' · '), why: h.reason,
        acts: can ? [h.suggested && h.has_content ? el('button', { class: 'btn small primary', type: 'button', onclick: (e) => act(e.currentTarget, () => post(`/vendor-files/held/${h.id}/apply`, {}),
            (r) => `Applied through ${r.to}${r.note ? `: ${r.note}` : ''}`) }, 'Apply') : null,
          targets.length && h.has_content ? el('button', { class: 'btn small', type: 'button', onclick: () => openAssign(h, targets) }, 'Assign') : null,
          el('button', { class: 'btn small', type: 'button', onclick: async (e) => {
            const why = await E.askReason({ title: 'Set this file aside?', sub: `${h.filename} from ${h.sender}`, confirm: 'Set aside' });
            if (why) act(e.currentTarget, () => post(`/vendor-files/held/${h.id}/set-aside`, { reason: why }), 'Set aside');
          } }, 'Set aside')] : null })) : empty('Nothing held.', null, true)),
      section('Review by vendor', `${rv.length}`, null, el('p', { class: 'fine', text: 'Turn on “Always hold” for a vendor to review every file it emails before it is applied, even from a confirmed sender. There is no rule that trusts a sender automatically.' }),
        el('div', { class: 'panel' }, rv.length ? rv.map((v) => {
          const box = el('input', { type: 'checkbox', checked: v.always_hold || null, disabled: !can || null, 'aria-label': `Always hold ${v.vendor}` });
          box.addEventListener('change', () => act(box, () => post(`/vendor-files/vendor/${v.vendor_id}/always-hold`, { on: box.checked }), (r) => r.alwaysHold ? `${v.vendor}: every file held for review` : `${v.vendor}: confirmed senders go straight through`));
          return el('label', { class: 'li check-row' }, box, el('div', { class: 't', text: `Always hold · ${v.vendor}` }),
            el('div', { class: 'd', text: v.held ? `${plural(v.held, 'file')} waiting` : 'Nothing waiting' }));
        }) : empty('No vendor sends email yet.', null, true))));
  }

  /** Files across every vendor connection (or only the quarantined ones): what the Files and Quarantined tiles open. */
  async function filesView() {
    const d = await coApi(`/vendor-files/files${VF.filter ? `?status=${VF.filter}` : ''}`);
    const can = vfManage();
    return frag(head(VF.filter === 'quarantined' ? 'Quarantined files' : 'Files taken', [backBtn()], 'Vendor files'),
      el('div', { class: 'toolbar' }, seg([['', 'All'], ['applied', 'Applied'], ['quarantined', 'Quarantined'], ['ignored', 'Set aside']], VF.filter || '', (v) => goVF({ filter: v || null }))),
      el('div', { class: 'panel' }, d.files.length ? capped(d.files.map((f) => item({ title: f.origin, badge: chip(...(FILE_STATUS[f.status] || ['neutral', 'info', f.status])),
        detail: [`${f.vendor} · ${f.connection}`, kb(Number(f.byte_size)), f.rows_parsed != null ? plural(Number(f.rows_parsed), 'row') : null, ago(f.received_at)].filter(Boolean).join(' · '),
        why: f.quarantine_reason || f.note || null, onClick: () => goVF({ view: 'conn', id: f.connection_id, filter: f.status === 'quarantined' ? 'quarantined' : null }),
        acts: can && f.status === 'quarantined' ? [el('button', { class: 'btn small', type: 'button', onclick: async (e) => {
          const why = await E.askReason({ title: 'Set this file aside?', sub: f.origin, confirm: 'Set aside', lead: 'It stays on record; it leaves the quarantine list.' });
          if (why) act(e.currentTarget, () => post(`/vendor-files/files/${f.id}/dismiss`, { reason: why }), 'Set aside');
        } }, 'Set aside')] : null })), 30, 'files') : empty(VF.filter === 'quarantined' ? 'Nothing quarantined.' : 'No files yet.', null, true)));
  }

  function openAssign(h, targets) {
    const dlg = openDialog('Which vendor is this from?', `${h.filename} · ${h.sender}`);
    const pick = select(targets, targets[0][0]);
    const add = el('input', { type: 'checkbox', checked: true });
    const out = el('div');
    dlg.body.append(el('div', { class: 'form-grid' }, field('Send it to', pick, null, true)),
      el('label', { class: 'li check-row' }, add, el('div', { class: 't', text: `Add ${h.sender} to its sender list` }), el('div', { class: 'd', text: 'Later mail from this sender goes straight there.' })), out,
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: dlg.close }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget, () => {
          const [k, id] = pick.value.split(':');
          return post(`/vendor-files/held/${h.id}/assign`, { connectionId: k === 'c' ? id : null, feedId: k === 'f' ? id : null, addSender: add.checked });
        }, (r) => `Sent to ${r.to}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`, { close: dlg.close, errorInto: (x) => out.replaceChildren(resultBox('critical', 'fail', 'Not assigned', E.friendly(x))) }) }, 'Assign')));
  }

  /** Add or edit a vendor connection. d = the /vendor-files overview (vendors, kinds); x = the connection being edited, or null. */
  function openVendorConn(d, x, vendorId) {
    const dlg = openDialog(x ? `Edit · ${x.name}` : 'Add a vendor connection', 'Vendor files', { wide: true, sheet: true });
    const cfg = (x && x.config) || {};
    let chan = x ? x.channel : 'sftp';
    const vendor = select(d.vendors.map((v) => [v.id, v.name]), x ? x.vendor_id : vendorId || (d.vendors[0] && d.vendors[0].id));
    const name = input({ value: x ? x.name : '', placeholder: 'Coaster SFTP' });
    const carry = {};
    const carryRows = el('div', { class: 'vf-carry' }, d.kinds.map((k) => {
      const cur = (cfg.carries || []).find((c2) => c2.kind === k.id);
      const on = el('input', { type: 'checkbox', checked: !!cur, 'aria-label': k.name });
      const glob = input({ value: cur ? cur.glob || '' : '', placeholder: k.id === 'edi' ? '*.x12 (X12 is also known by its content)' : k.id === 'catalog' ? '*catalog*.csv' : k.id === 'prices' ? '*price*.csv' : '*inventory*.csv', 'aria-label': `${k.name} file pattern` });
      carry[k.id] = { on, glob };
      return el('div', { class: 'vf-carry-row' }, el('label', { class: 'check' }, on, k.name), glob);
    }));
    const schedSel = select(SCHEDULES, SCHEDULES.some((s2) => s2[0] === x?.schedule_cron) ? x.schedule_cron : x?.schedule_cron ? 'custom' : '0 */4 * * *');
    const cron = input({ value: x?.schedule_cron || '', placeholder: '15 6 * * 1-5' });
    const f = { host: input({ value: cfg.host || '', placeholder: 'sftp.vendor.com' }), port: input({ value: cfg.port || '', inputmode: 'numeric', placeholder: '22' }),
      user: input({ value: cfg.user || '' }), path: input({ value: cfg.path || '', placeholder: '/outbound' }),
      after: select([['leave', 'Leave it on the server'], ['move', 'Move it to another folder'], ['delete', 'Delete it from the server']], cfg.after || 'leave'),
      moveTo: input({ value: cfg.moveTo || '', placeholder: '/outbound/done' }), maxMb: input({ value: cfg.maxMb || '', inputmode: 'numeric', placeholder: '20' }),
      endpoint: input({ value: cfg.endpoint || '', placeholder: 'https://files.vendor.com/prices.csv', inputmode: 'url' }),
      auth: select([['none', 'None'], ['basic', 'User and password'], ['bearer', 'Bearer token'], ['header', 'Key in a header']], cfg.auth || 'none'),
      headerName: input({ value: cfg.headerName || '', placeholder: 'x-api-key' }), apiUser: input({ value: x && x.channel === 'api' ? cfg.user || '' : '' }),
      senders: el('textarea', { rows: '2', placeholder: 'orders@vendor.com, @vendor.com', value: (x?.allowed_senders || []).join(', ') }) };
    const have = new Set((x && x.secrets) || []);
    const sec = (n, ph) => input({ type: 'password', autocomplete: 'new-password', placeholder: have.has(n) ? 'Set · type to replace' : ph || 'Not set' });
    const s = { password: sec('password'), privateKey: el('textarea', { rows: '3', placeholder: have.has('privateKey') ? 'Set · paste to replace' : 'Paste an OpenSSH or PEM private key (optional)' }),
      passphrase: sec('passphrase', 'Only if the key has one'), token: sec('token'), apiKey: sec('apiKey'), apiPassword: sec('password') };
    const box = {
      sftp: el('div', { class: 'form-grid' }, field('Host', f.host), field('Port', f.port, '22, or the vendor’s own (1024 or above)'), field('User', f.user), field('Folder', f.path),
        field('After taking a file', f.after), field('Move to', f.moveTo), field('Largest file (MB)', f.maxMb, 'Bigger files are left on the server and listed'),
        field('Password', s.password), field('Private key', s.privateKey, null, true), field('Key passphrase', s.passphrase)),
      api: el('div', { class: 'form-grid' }, field('Address', f.endpoint, 'https only; one call returns one file (CSV, JSON or X12)', true), field('Authentication', f.auth),
        field('User', f.apiUser), field('Key header name', f.headerName), field('Password', s.apiPassword), field('Bearer token', s.token), field('Key', s.apiKey)),
      email: el('div', { class: 'form-grid' }, field('Who sends these files', f.senders, 'Addresses, or @vendor.com for anyone there. Anyone else’s mail is held.', true),
        d.address ? el('div', { class: 'wide' }, el('p', { class: 'fine', text: 'Ask the vendor to send to:' }), copyBox(d.address)) : resultBox('warning', 'info', 'Inbound email is not set up on this server', 'Set ERP_INBOUND_EMAIL_ADDRESS and ERP_EMAIL_INBOUND_TOKEN.')),
    };
    const schedRow = el('div', { class: 'form-grid' }, field('How often to look', schedSel), field('Cron (UTC)', cron));
    const chanSeg = el('div');
    const sync = () => {
      chanSeg.replaceChildren(x ? el('p', { class: 'fine', text: `${CHAN[chan]} (a connection keeps its channel)` }) : seg([['sftp', 'SFTP'], ['api', 'HTTPS address'], ['email', 'Email']], chan, (v) => { chan = v; sync(); }));
      for (const [k, n] of Object.entries(box)) n.hidden = k !== chan;
      schedRow.hidden = chan === 'email';
      cron.closest('.field').hidden = schedSel.value !== 'custom';
      f.moveTo.closest('.field').hidden = f.after.value !== 'move';
      const a = f.auth.value;
      if (chan === 'api') {
        f.apiUser.closest('.field').hidden = a !== 'basic'; f.headerName.closest('.field').hidden = a !== 'header';
        s.apiPassword.closest('.field').hidden = a !== 'basic'; s.token.closest('.field').hidden = a !== 'bearer'; s.apiKey.closest('.field').hidden = a !== 'header';
      }
    };
    schedSel.addEventListener('change', sync); f.after.addEventListener('change', sync); f.auth.addEventListener('change', sync);
    const out = el('div', { role: 'status', 'aria-live': 'polite' });
    const save = el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget, () => {
      const carries = Object.entries(carry).filter(([, v]) => v.on.checked).map(([kind, v]) => ({ kind, glob: v.glob.value.trim() }));
      const conn = { id: x ? x.id : null, vendor_id: vendor.value, name: name.value, channel: chan, carries,
        schedule: schedSel.value === 'custom' ? cron.value : schedSel.value, host: f.host.value, port: f.port.value, user: chan === 'api' ? f.apiUser.value : f.user.value, path: f.path.value,
        after: f.after.value, moveTo: f.moveTo.value, maxMb: f.maxMb.value, endpoint: f.endpoint.value, auth: f.auth.value, headerName: f.headerName.value, senders: f.senders.value };
      const secrets = {};
      const keys = chan === 'sftp' ? ['password', 'privateKey', 'passphrase'] : chan === 'api' ? ['password', 'token', 'apiKey'] : [];
      for (const k of keys) { const box2 = chan === 'api' && k === 'password' ? s.apiPassword : s[k]; if (box2.value) secrets[k] = box2.value; }
      return post('/vendor-files/save', { connection: conn, secrets });
    }, (r) => (chan === 'sftp' ? 'Saved. Press Test to record the server’s key before the first run.' : 'Saved'), { close: () => { dlg.close(); }, errorInto: (ex) => out.replaceChildren(resultBox('critical', 'fail', 'Not saved', E.friendly(ex))) }) }, 'Save');
    dlg.body.append(
      el('div', { class: 'form-grid' }, field('Vendor', vendor), field('Name', name)), chanSeg,
      el('div', { class: 'edi-sec', text: 'What it carries' }), el('p', { class: 'fine', text: 'Tick each kind of file and give its file-name pattern. With more than one kind, each needs its own pattern. A zip is opened and each file in it routed the same way.' }),
      carryRows, el('div', { class: 'edi-sec', text: 'Where the files are' }), box.sftp, box.api, box.email, schedRow, out,
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: dlg.close }, 'Cancel'), save));
    sync();
  }

  (function vfStyle() {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`.vf-carry{display:grid;gap:8px;margin:6px 0 10px}.vf-carry-row{display:grid;grid-template-columns:minmax(0,1fr);gap:4px}
@media (min-width:640px){.vf-carry-row{grid-template-columns:180px minmax(0,1fr);align-items:center}}
.copy-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.copy-row .copy-in{flex:1 1 220px;min-width:0;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.panel.pad{padding:6px 16px 14px}.edi-sec{margin:12px 0 4px;font-weight:650}`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  })();

  /** For other screens (a vendor's card in Catalog, Vendor EDI): open this vendor's connections, or add one. */
  E.vendorFiles = {
    open(vendorId) { VF.view = 'list'; VF.vendor = vendorId || null; connTab = 'vendor'; E.go('connections', 'vendor'); },
    async add(vendorId) { openVendorConn(await coApi('/vendor-files'), null, vendorId); },
    copyBox,
  };

  E.register('services', 'Services', 'building', screenServices, 'Setup', { module: null });
  E.register('connections', 'Connections', 'feed', screenConnections, 'Setup', { module: null });
})();
