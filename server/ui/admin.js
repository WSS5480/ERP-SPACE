// Admin: Services (which services this company shows) and Connections (email,
// texts, card payments, maps, marketplaces... in one place), with the log of
// what was emailed and texted. Values are placed with textContent only.
(() => {
  'use strict';
  const E = window.ERP;
  const { el, frag, head, section, item, chip, empty, toast, act, openDialog, field, select, input, post, coApi, plural, ago, resultBox, seg } = E;

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
    if (sub === 'log' || sub === 'connections') connTab = sub;
    const tabs = el('div', { class: 'toolbar' }, seg([['connections', 'Connections'], ['log', 'Message log']], connTab, (v) => { connTab = v; E.render(); }));
    if (connTab === 'log') return frag(head('Connections', null, 'Admin'), tabs, await logView());
    const d = await coApi('/admin/connections');
    const groups = [...new Set(d.kinds.map((k) => k.group))];
    return frag(
      head('Connections', null, 'Admin'), tabs,
      el('p', { class: 'lead', text: 'Everything this ERP talks to outside, in one place. Set each one for this company, or once for the whole client (a company’s own setting wins). Keys and passwords are stored encrypted and never shown again; you only see that one is set.' }),
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
    if (k.id === 'edi') return `${plural(s.partners, 'trading partner')}, ${s.enabled} live${s.waiting_on_transport ? `, ${s.waiting_on_transport} waiting on SFTP or AS2` : ''}.`;
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
      const to = k.test && k.test !== 'webhook' ? input({ placeholder: k.test === 'email' ? 'you@example.com' : k.test === 'sms' ? '+1 717 555 0100' : 'An address to look up', type: k.test === 'email' ? 'email' : 'text' }) : null;
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

  E.register('services', 'Services', 'building', screenServices, 'Setup', { module: null });
  E.register('connections', 'Connections', 'feed', screenConnections, 'Setup', { module: null });
})();
