// edi screens. Registers with window.ERP (see docs/MODULES.md).
// Setup › Vendor EDI: trading partners (per-document channel: EDI, the
// vendor's API feed, email or file; transport; ids; secrets, write-only),
// "Send test 850", the EDI inbox and outbox as document cards with a raw
// view, and "Upload EDI file". Retail › Store orders: a cart per vendor
// against its freight minimums, submit, approve (PO placed and sent by the
// partner's channel), turn down. Phone first: cards and pickers, no tables.
(() => {
  'use strict';
  const E = window.ERP;
  if (!E) return;
  const { el, frag, icon, chip, money, plural, cap, coApi, post, go, toast, act, openDialog, resultBox, fillDialog, askReason,
    head, section, tile, tilesRow, empty, item, capped, seg, fact, friendly, render, shortDay, NARROW } = E;
  /** Tabs: a segmented row on a wide screen, a picker on a phone, so no label is cut off. */
  const tabsOf = (tabs, value, onPick) => {
    if (!NARROW || !NARROW.matches) return seg(tabs, value, onPick);
    const pick = el('select', { 'aria-label': 'Show' }, tabs.map(([k, label]) => el('option', { value: k, text: label, selected: k === value || null })));
    pick.onchange = () => onPick(pick.value);
    return el('label', { class: 'field wide' }, el('span', { text: 'Show' }), pick);
  };

  const field = (label, control, hint, wide) => el('label', { class: 'field' + (wide ? ' wide' : '') }, el('span', { text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null);
  const select = (options, value) => el('select', {}, options.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(value ?? '') || null })));
  const input = (props) => el('input', Object.assign({ type: 'text' }, props));
  const errInto = (box) => (e) => box.replaceChildren(resultBox('critical', 'fail', 'Not done', friendly(e)));
  const day = (s) => (s ? shortDay(String(s).slice(0, 10)) : '');
  const download = (filename, text) => {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/edi-x12' })), download: filename });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };

  const NAMES = { '850': 'Purchase order', '855': 'PO acknowledgment', '856': 'Ship notice', '810': 'Invoice', '832': 'Price catalog', '846': 'Inventory advice',
    '997': 'Functional ack', freight: 'Freight by store', unknown: 'Unreadable file' };
  const CHANNEL_WORDS = { edi: 'EDI', api: 'Vendor API feed', email: 'Email', file: 'File (download / import)', off: 'Not exchanged' };
  const TRANSPORT_WORDS = { manual: 'Manual upload and download', dropfolder: 'Drop folder on the server', van: 'VAN or EDI service (HTTPS)', sftp: 'SFTP (not built yet)', as2: 'AS2 (not built yet)' };
  const STATUS = {
    queued: ['neutral', 'pending', 'Queued'], sent: ['good', 'ok', 'Sent'], received: ['neutral', 'info', 'Received'], applied: ['good', 'ok', 'Applied'],
    quarantined: ['serious', 'hold', 'Quarantined'], acknowledged: ['good', 'ok', 'Acknowledged'], rejected: ['critical', 'fail', 'Rejected'],
    ignored: ['neutral', 'none', 'Ignored'], failed: ['critical', 'fail', 'Failed'],
  };
  const statusChip = (s) => chip(...(STATUS[s] || ['neutral', 'info', cap(s)]));

  function style() {
    if (window.__ediSheet) return;
    const sheet = new CSSStyleSheet();
    window.__ediSheet = sheet;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    sheet.replaceSync(`
.edi-raw{white-space:pre-wrap;word-break:break-all;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:10px 12px;max-height:50vh;overflow:auto;margin:8px 0}
.edi-docs{display:grid;grid-template-columns:1fr;gap:8px;margin:6px 0 10px}
@media (min-width:720px){.edi-docs{grid-template-columns:1fr 1fr}}
.edi-doc{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--panel)}
.edi-doc .k{font-size:12.5px;color:var(--ink-2)}
.edi-seps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.edi-seps input{text-align:center}
.edi-qty{max-width:90px;text-align:right;font-variant-numeric:tabular-nums}
.panel.pad{padding:6px 16px 14px}
.edi-sec{margin:12px 0 4px;font-weight:650}
`);
  }

  // ================================================================ Vendor EDI
  const TABS = [['partners', 'Trading partners'], ['inbox', 'Inbox'], ['outbox', 'Outbox'], ['upload', 'Upload EDI file']];
  async function screen(sub) {
    style();
    const tab = TABS.some(([k]) => k === sub) ? sub : 'partners';
    const body = await ({ partners: tabPartners, inbox: () => tabDocs('in'), outbox: () => tabDocs('out'), upload: tabUpload })[tab]();
    return frag(head('Vendor EDI', [el('button', { class: 'btn primary', type: 'button', onclick: () => go('edi', 'upload') }, icon('plus'), 'Upload EDI file')], 'Setup › Vendors'),
      el('div', { class: 'toolbar' }, tabsOf(TABS, tab, (k) => go('edi', k === 'partners' ? '' : k))), body);
  }

  async function tabPartners() {
    const [d, h] = [await coApi('/edi/partners'), (await coApi('/edi/home')).home];
    const free = d.vendors.filter((v) => !v.has_partner);
    return frag(
      tilesRow(
        tile({ label: 'Trading partners', value: String(h.partners), suffix: `${h.on} on`, tone: 'neutral', ic: 'building', text: 'Vendors set up for EDI' }),
        tile({ label: 'Quarantined', value: String(h.quarantined), tone: Number(h.quarantined) ? 'serious' : 'good', ic: Number(h.quarantined) ? 'warn' : 'ok',
          text: Number(h.quarantined) ? 'Held with a reason; nothing from them applied' : 'Nothing held', onClick: () => go('edi', 'inbox') }),
        tile({ label: 'Waiting to go out', value: String(h.queued), suffix: Number(h.failed) ? `${h.failed} failed` : null, tone: Number(h.failed) ? 'critical' : Number(h.queued) ? 'warning' : 'good',
          ic: 'clock', text: 'Queued or failed documents', onClick: () => go('edi', 'outbox') })),
      section('Trading partners', `${d.partners.length}`, [el('button', { class: 'btn small', type: 'button', onclick: () => openPartner(d, null, free) }, icon('plus'), 'Set up a vendor')],
        el('div', { class: 'panel' }, d.partners.length ? d.partners.map((p) => item({
          title: p.vendor,
          badge: p.edi_enabled ? chip(p.usage === 'P' ? 'good' : 'warning', p.usage === 'P' ? 'ok' : 'info', p.usage === 'P' ? 'EDI on · production' : 'EDI on · test') : chip('neutral', 'none', 'EDI off'),
          detail: [TRANSPORT_WORDS[p.transport], `850 by ${CHANNEL_WORDS[p.documents['850']] || p.documents['850']}`, `status by ${CHANNEL_WORDS[p.documents['855']] || p.documents['855']}`,
            Number(p.queued) ? `${p.queued} waiting` : null, Number(p.quarantined) ? `${p.quarantined} quarantined` : null].filter(Boolean).join(' · '),
          why: p.last_poll_note ? `Last check ${day(p.last_poll_at)}: ${p.last_poll_note}` : p.transport_note,
          onClick: () => openPartner(d, p, free) })) : empty('No trading partners yet.', 'Set up a vendor to send 850s and take in its 855, 856 and 810 by EDI.', true))),
      el('p', { class: 'foot', text: 'Each document goes by its own channel: a vendor can send its catalog, prices, quantities and freight by API feeds (Catalog › Vendors › API setup) and trade POs, acknowledgments, ship notices and invoices by EDI. Freight by store keeps feeding landed cost.' }));
  }

  async function openPartner(list, p, free) {
    const d = openDialog(p ? p.vendor : 'Set up a vendor', p ? 'Trading partner' : 'EDI trading partner', { wide: true, sheet: true });
    const again = () => { d.close(); coApi('/edi/partners').then((l) => openPartner(l, l.partners.find((x) => x.id === p.id), free)); };
    await fillDialog(d, async () => {
      const det = p ? await coApi(`/edi/partners/${p.id}`) : null;
      const cur = det ? det.partner : { documents: {}, transport_config: {}, our_isa_qual: 'ZZ', their_isa_qual: 'ZZ', version: '004010', usage: 'T', element_sep: '*', segment_term: '~', subelement_sep: '>', repetition_sep: '^', transport: 'manual', send_on_approval: true };
      const vendor = select(p ? [[p.vendor_id, p.vendor]] : free.map((v) => [v.id, v.name]), p ? p.vendor_id : free[0] && free[0].id);
      if (p) vendor.disabled = true;
      const on = el('input', { type: 'checkbox', checked: !!cur.edi_enabled });
      const version = select([['004010', '004010'], ['005010', '005010']], cur.version);
      const usage = select([['T', 'Test (ISA15 T)'], ['P', 'Production (ISA15 P)']], cur.usage);
      const oq = input({ value: cur.our_isa_qual, maxlength: '2' }), oid = input({ value: cur.our_isa_id || '', maxlength: '15', placeholder: 'Our ISA id' });
      const tq = input({ value: cur.their_isa_qual, maxlength: '2' }), tid = input({ value: cur.their_isa_id || '', maxlength: '15', placeholder: 'Their ISA id' });
      const ogs = input({ value: cur.our_gs_id || '', maxlength: '15', placeholder: 'Same as ISA' }), tgs = input({ value: cur.their_gs_id || '', maxlength: '15', placeholder: 'Same as ISA' });
      const seps = ['element_sep', 'segment_term', 'subelement_sep', 'repetition_sep'].map((k) => input({ value: cur[k], maxlength: '1', 'aria-label': k.replace('_', ' ') }));
      const sendOnApproval = el('input', { type: 'checkbox', checked: cur.send_on_approval !== false });
      // Channels per document; a new partner starts with the vendor's own API feeds where they exist.
      const defaults = p ? cur.documents : (vendor.value ? (await coApi(`/edi/partners/defaults?vendor=${vendor.value}`)).documents : {});
      const docSel = {};
      const docBox = el('div', { class: 'form-grid' });
      const drawDocs = (docs) => {
        docBox.replaceChildren(...Object.entries(list.channels).map(([k, chans]) => {
          docSel[k] = select(chans.map((c) => [c, CHANNEL_WORDS[c] || c]), docs[k] || chans[0]);
          const feeds = (list.feedFor[k] || []).join(' or ');
          return field(`${k === 'freight' ? '' : k + ' · '}${NAMES[k] || k}`, docSel[k], feeds ? `API means the vendor's ${feeds} feed` : null);
        }));
      };
      drawDocs(defaults);
      if (!p) vendor.onchange = async () => drawDocs((await coApi(`/edi/partners/defaults?vendor=${vendor.value}`)).documents);
      const tc = cur.transport_config || {};
      const transport = select(list.transports.map((t) => [t, TRANSPORT_WORDS[t] || t]), cur.transport);
      const tf = {
        folder: input({ value: tc.folder || '', placeholder: 'coaster' }), host: input({ value: tc.host || '' }), port: input({ value: tc.port || '', inputmode: 'numeric', placeholder: '22' }),
        user: input({ value: tc.user || '' }), inFolder: input({ value: tc.inFolder || '', placeholder: '/out' }), outFolder: input({ value: tc.outFolder || '', placeholder: '/in' }),
        sendUrl: input({ value: tc.sendUrl || '', placeholder: 'https://' }), listUrl: input({ value: tc.listUrl || '', placeholder: 'https://' }), ackUrl: input({ value: tc.ackUrl || '', placeholder: 'https://' }),
        auth: select([['bearer', 'Bearer token'], ['header', 'Key header'], ['basic', 'User and password'], ['none', 'None']], tc.auth || 'bearer'), headerName: input({ value: tc.headerName || '', placeholder: 'x-api-key' }),
        url: input({ value: tc.url || '', placeholder: 'https://' }), as2To: input({ value: tc.as2To || '' }),
      };
      const SHOW = { manual: [], dropfolder: ['folder'], van: ['sendUrl', 'listUrl', 'ackUrl', 'auth', 'headerName', 'user'], sftp: ['host', 'port', 'user', 'inFolder', 'outFolder'], as2: ['url', 'as2To'] };
      const LABEL = { folder: 'Folder name', host: 'Host', port: 'Port', user: 'User', inFolder: 'Their outbox (we read)', outFolder: 'Their inbox (we write)', sendUrl: 'Send address',
        listUrl: 'Inbox address', ackUrl: 'Acknowledge address', auth: 'Authentication', headerName: 'Key header name', url: 'AS2 address', as2To: 'Their AS2 id' };
      const tFields = Object.fromEntries(Object.entries(tf).map(([k, c]) => [k, field(LABEL[k], c)]));
      const SECRETS = { manual: [], dropfolder: [], van: ['vanToken', 'vanApiKey', 'vanPassword'], sftp: ['sftpPassword', 'sftpKey'], as2: ['as2Password'] };
      const setMasked = Object.fromEntries((det ? det.secrets : []).map((x) => [x.name, x.masked]));
      const sIn = Object.fromEntries(list.secretNames.map((n) => [n, input({ type: 'password', autocomplete: 'new-password', placeholder: setMasked[n] ? 'Set; type to replace' : 'Not set' })]));
      const sFields = Object.fromEntries(list.secretNames.map((n) => [n, field(n.replace(/([A-Z])/g, ' $1').toLowerCase(), sIn[n])]));
      const note = el('div');
      const syncT = () => {
        for (const [k, f] of Object.entries(tFields)) f.hidden = !SHOW[transport.value].includes(k);
        for (const [k, f] of Object.entries(sFields)) f.hidden = !SECRETS[transport.value].includes(k);
        note.replaceChildren(transport.value === 'sftp' || transport.value === 'as2'
          ? resultBox('warning', 'warn', `${transport.value.toUpperCase()} is not built yet`, 'The settings and password are kept, and a poll or send says so plainly. Until it is, use a drop folder, a VAN, or download and upload by hand.')
          : transport.value === 'dropfolder' && !list.dropDirSet ? resultBox('warning', 'warn', 'No drop directory on the server', 'Set ERP_EDI_DROP_DIR in the service environment; partner folders sit under it.') : '');
      };
      transport.onchange = syncT; syncT();
      // 850 layout: parties, routing, dates, item ids and references this vendor wants.
      const o = cur.options || {};
      const bt = o.billTo || {}, td = o.td5 || {}, ct = o.contact || {};
      const L = {
        btName: input({ value: bt.name || '', placeholder: 'Bill-to name' }), btCode: input({ value: bt.code || '', placeholder: 'Their code for us' }), btAddr: input({ value: bt.address1 || '' }),
        btCity: input({ value: bt.city || '' }), btState: input({ value: bt.state || '', maxlength: '2' }), btPostal: input({ value: bt.postal || '', inputmode: 'numeric' }),
        vendorN1: el('input', { type: 'checkbox', checked: !!o.vendorN1 }),
        scac: input({ value: td.scac || '', maxlength: '4', placeholder: 'SCAC' }), method: input({ value: td.method || '', maxlength: '2', placeholder: 'M, LT…' }), routing: input({ value: td.routing || '', placeholder: 'Routing / carrier name' }),
        fob: select([['', 'Not sent'], ['PP', 'PP · prepaid'], ['CC', 'CC · collect'], ['PB', 'PB · customer pickup'], ['DF', 'DF · defined by buyer and seller'], ['PC', 'PC · prepaid, charged back']], o.fob || ''),
        shipBy: input({ value: o.shipByDays ?? '', inputmode: 'numeric', placeholder: 'days after order' }), cancelAfter: input({ value: o.cancelAfterDays ?? '', inputmode: 'numeric', placeholder: 'days after order' }),
        ctName: input({ value: ct.name || '' }), ctPhone: input({ value: ct.phone || '', inputmode: 'tel' }), ctEmail: input({ value: ct.email || '', inputmode: 'email' }),
      };
      const ITEM_IDS = [['VN', 'VN · their model'], ['BP', 'BP · our SKU (buyer part)'], ['UP', 'UP · UPC'], ['IN', 'IN · our item number'], ['SK', 'SK · our SKU']];
      const idOn = Object.fromEntries(ITEM_IDS.map(([k]) => [k, el('input', { type: 'checkbox', checked: (o.itemIds || ['VN', 'BP', 'UP']).includes(k) })]));
      const refOn = { IA: el('input', { type: 'checkbox', checked: (o.refs || ['IA', 'CO']).includes('IA') }), CO: el('input', { type: 'checkbox', checked: (o.refs || ['IA', 'CO']).includes('CO') }) };
      const layoutBox = frag(
        el('div', { class: 'edi-sec', text: '850 layout' }),
        el('div', { class: 'form-grid' }, field('Bill to (N1 BT)', L.btName), field('Bill-to code', L.btCode), field('Address', L.btAddr), field('City', L.btCity), field('State', L.btState), field('ZIP', L.btPostal),
          el('label', { class: 'check wide' }, L.vendorN1, 'Send the vendor party (N1 VN) with our account number'),
          field('Carrier SCAC (TD5)', L.scac), field('Method', L.method), field('Routing', L.routing, null, true), field('FOB', L.fob),
          field('Ship by (DTM 010)', L.shipBy), field('Cancel after (DTM 001)', L.cancelAfter),
          field('Buyer contact (PER)', L.ctName), field('Phone', L.ctPhone), field('Email', L.ctEmail)),
        el('div', { class: 'field wide' }, el('span', { text: 'Item ids on each line (PO1), in this order' }), el('div', { class: 'form-grid' }, ITEM_IDS.map(([k, t]) => el('label', { class: 'check' }, idOn[k], t)))),
        el('div', { class: 'field wide' }, el('span', { text: 'References' }), el('div', { class: 'form-grid' }, el('label', { class: 'check' }, refOn.IA, 'REF IA · our account number'), el('label', { class: 'check' }, refOn.CO, 'REF CO · customer order per line'))));
      const options = () => ({
        billTo: L.btName.value ? { name: L.btName.value, code: L.btCode.value, address1: L.btAddr.value, city: L.btCity.value, state: L.btState.value, postal: L.btPostal.value } : null,
        vendorN1: L.vendorN1.checked, td5: L.scac.value || L.routing.value ? { scac: L.scac.value, method: L.method.value, routing: L.routing.value } : null, fob: L.fob.value || null,
        shipByDays: L.shipBy.value, cancelAfterDays: L.cancelAfter.value, itemIds: ITEM_IDS.map(([k]) => k).filter((k) => idOn[k].checked),
        refs: Object.keys(refOn).filter((k) => refOn[k].checked), contact: L.ctName.value || L.ctPhone.value || L.ctEmail.value ? { name: L.ctName.value, phone: L.ctPhone.value, email: L.ctEmail.value } : null,
      });
      const err = el('div');
      const body = () => ({
        partner: { vendor_id: vendor.value, edi_enabled: on.checked, version: version.value, usage: usage.value, our_isa_qual: oq.value, our_isa_id: oid.value, their_isa_qual: tq.value, their_isa_id: tid.value,
          our_gs_id: ogs.value, their_gs_id: tgs.value, element_sep: seps[0].value, segment_term: seps[1].value, subelement_sep: seps[2].value, repetition_sep: seps[3].value,
          documents: Object.fromEntries(Object.entries(docSel).map(([k, s]) => [k, s.value])), transport: transport.value, send_on_approval: sendOnApproval.checked, options: options(),
          transport_config: Object.fromEntries(SHOW[transport.value].map((k) => [k, tf[k].value]).filter(([, v]) => v !== '')) },
        secrets: Object.fromEntries(SECRETS[transport.value].map((k) => [k, sIn[k].value]).filter(([, v]) => v)),
      });
      const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, () => post('/edi/partners', body()), 'Trading partner saved', { errorInto: errInto(err), close: d.close }) }, 'Save');
      const test = p ? el('button', { class: 'btn', type: 'button', onclick: () => act(test, async () => {
        const r = await post(`/edi/partners/${p.id}/test-850`, {});
        if (r.status === 'queued') download(`test-850-${p.vendor.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.edi`, r.text);
        if (r.status === 'failed') throw new Error(r.detail);
        return r;
      }, (r) => `Test 850: ${r.status}${r.detail ? ` (${r.detail})` : ''}`, { errorInto: errInto(err) }) }, 'Send test 850') : null;
      const poll = p ? el('button', { class: 'btn', type: 'button', onclick: () => act(poll, () => post(`/edi/partners/${p.id}/poll`, {}), (r) => r.note, { errorInto: errInto(err), close: again }) }, 'Check for files now') : null;
      const status = p && (p.feeds || []).some((f) => f.purpose === 'acknowledgments')
        ? el('button', { class: 'btn', type: 'button', onclick: () => act(status, () => post(`/edi/partners/${p.id}/poll-status`, {}), (r) => r.runs.map((x) => x.note).join(' · '), { errorInto: errInto(err) }) }, 'Ask the API for order status') : null;
      const feeds = p && p.feeds && p.feeds.length ? section('Vendor API feeds', `${p.feeds.length}`, null, el('div', { class: 'panel' }, p.feeds.map((f) => item({ title: f.name,
        badge: f.active ? (f.last_ok === false ? chip('critical', 'fail', 'Failing') : chip('good', 'ok', 'On')) : chip('neutral', 'none', 'Off'), detail: cap(f.purpose) })))) : null;
      return frag(
        el('p', { class: 'lead', text: 'The ids come from the vendor’s EDI setup sheet. Passwords and keys are stored encrypted and never shown again; type one to replace it.' }),
        el('div', { class: 'form-grid' }, field('Vendor', vendor, null, true), el('label', { class: 'check wide' }, on, 'EDI on for this vendor'), field('X12 version', version), field('Mode', usage),
          field('Our ISA qualifier', oq), field('Our ISA id', oid), field('Their ISA qualifier', tq), field('Their ISA id', tid), field('Our GS id', ogs), field('Their GS id', tgs)),
        field('Separators: element, segment, sub-element, repetition', el('div', { class: 'edi-seps' }, seps), 'Usually * ~ > ^; incoming files say their own in the ISA', true),
        el('div', { class: 'edi-sec', text: 'Which way each document travels' }), docBox,
        el('label', { class: 'check' }, sendOnApproval, 'Send a store order’s PO by this channel as soon as it is approved'),
        layoutBox,
        el('div', { class: 'edi-sec', text: 'How files travel' }), el('div', { class: 'form-grid' }, field('Transport', transport, null, true), Object.values(tFields), Object.values(sFields)), note,
        el('div', { class: 'dlg-acts' }, save, test, poll, status, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Close')), err,
        p ? itemMapSection(p, det.items, again) : null, feeds);
    });
  }

  function itemMapSection(p, items, again) {
    const vi = input({ placeholder: 'Their item number' }), sku = input({ placeholder: 'Our SKU' }), upc = input({ placeholder: 'UPC (optional)', inputmode: 'numeric' });
    const err = el('div');
    const add = el('button', { class: 'btn small', type: 'button', onclick: () => act(add, () => post(`/edi/partners/${p.id}/items`, { items: [{ vendorItem: vi.value, sku: sku.value, upc: upc.value }] }),
      'Mapping saved', { errorInto: errInto(err), close: again }) }, 'Add');
    return section('Item numbers', `${items.length}`, null, el('div', { class: 'panel pad' },
      el('p', { class: 'foot', text: 'Only where the vendor’s EDI item number differs from the vendor model on the product. Inbound lines match by our line number, then this map, then the model or UPC.' }),
      el('div', { class: 'form-grid' }, field('Their item', vi), field('Our SKU', sku), field('UPC', upc)), add, err,
      items.length ? capped(items.map((m) => item({ title: m.vendor_item, detail: `${m.sku} · ${m.name}${m.upc ? ` · UPC ${m.upc}` : ''}${m.active ? '' : ' · off'}` })), 10, 'mappings') : null));
  }

  // ------------------------------------------------------------ inbox / outbox
  const DF = { in: { status: '', type: '' }, out: { status: '', type: '' } };
  async function tabDocs(direction) {
    const f = DF[direction];
    const qs = new URLSearchParams({ direction, limit: '150' });
    if (f.status) qs.set('status', f.status);
    if (f.type) qs.set('type', f.type);
    const d = await coApi(`/edi/documents?${qs}`);
    const st = select([['', 'Every status'], ...Object.entries(STATUS).map(([k, v]) => [k, v[2]])], f.status);
    st.onchange = () => { f.status = st.value; render(); };
    const ty = select([['', 'Every document'], ...['850', '855', '856', '810', '832', '846', '997'].map((k) => [k, `${k} · ${NAMES[k]}`])], f.type);
    ty.onchange = () => { f.type = ty.value; render(); };
    const rows = d.documents.map((x) => item({
      title: `${x.doc_type} · ${NAMES[x.doc_type] || x.doc_type}${x.channel === 'api' ? ' (API)' : ''}`, badge: statusChip(x.status),
      detail: [x.vendor, x.po_number, x.bill_reference ? `bill ${x.bill_reference}` : null, x.isa_control ? `ISA ${x.isa_control}` : null, x.usage === 'T' ? 'test' : null, day(x.created_at)].filter(Boolean).join(' · '),
      why: x.reason || (x.summary && x.summary.applied) || null, onClick: () => openDoc(x.id) }));
    return frag(
      el('div', { class: 'form-grid' }, field('Status', st), field('Document', ty)),
      section(direction === 'in' ? 'Inbox' : 'Outbox', `${d.documents.length}`, null, el('div', { class: 'panel' }, rows.length ? capped(rows, 30, 'documents')
        : empty(direction === 'in' ? 'Nothing received.' : 'Nothing sent.', direction === 'in' ? 'Upload a vendor file, or let the scheduler poll the partner’s transport.' : 'A PO sent by EDI, a test 850 or a 997 shows here.', true))));
  }

  async function openDoc(id) {
    const d = openDialog('EDI document', null, { wide: true, sheet: true });
    await fillDialog(d, async () => {
      const x = await coApi(`/edi/documents/${id}`);
      d.dlg.querySelector('h2').textContent = `${x.doc_type} · ${NAMES[x.doc_type] || x.doc_type}`;
      const raw = el('pre', { class: 'edi-raw', text: x.raw });
      raw.hidden = true;
      const toggle = el('button', { class: 'btn small', type: 'button', onclick: () => { raw.hidden = !raw.hidden; toggle.textContent = raw.hidden ? 'Show raw' : 'Hide raw'; } }, 'Show raw');
      const err = el('div');
      const canRetry = (x.direction === 'in' && x.status === 'quarantined') || (x.direction === 'out' && ['queued', 'failed'].includes(x.status));
      const retry = canRetry ? el('button', { class: 'btn small primary', type: 'button', onclick: () => act(retry, () => post(`/edi/documents/${id}/retry`, {}),
        (r) => `${cap(r.status)}${r.detail && r.detail !== 'applied' ? `: ${r.detail}` : ''}`, { errorInto: errInto(err), close: () => { d.close(); openDoc(id); } }) }, x.direction === 'in' ? 'Apply again' : 'Send again') : null;
      const dl = x.direction === 'out' && x.channel === 'edi' ? el('button', { class: 'btn small', type: 'button', onclick: () => act(dl, async () => {
        const r = await post(`/edi/documents/${id}/download`, {}); download(r.filename, r.text); return r;
      }, 'Downloaded; it counts as sent', { errorInto: errInto(err) }) }, 'Download file') : null;
      const sum = x.summary || {};
      const facts = Object.entries(sum).filter(([, v]) => v != null && typeof v !== 'object').slice(0, 12).map(([k, v]) => fact(cap(k.replace(/([A-Z])/g, ' $1').toLowerCase()), String(v)));
      return frag(
        el('div', { class: 'toolbar' }, statusChip(x.status), x.usage === 'T' ? chip('warning', 'info', 'Test') : null, el('span', { class: 'grow' }), retry, dl, toggle),
        x.reason ? resultBox(x.status === 'quarantined' || x.status === 'failed' || x.status === 'rejected' ? 'serious' : 'neutral', 'info', cap(x.status), x.reason) : null,
        el('div', { class: 'panel' }, el('div', { class: 'facts' },
          fact('Direction', x.direction === 'in' ? 'From the vendor' : 'To the vendor'), fact('Vendor', x.vendor || '—'), fact('Channel', x.channel === 'api' ? 'Vendor API' : 'EDI'),
          fact('Control numbers', [x.isa_control, x.gs_control, x.st_control].filter(Boolean).join(' / ') || '—'), fact('Purchase order', x.po_number || '—'),
          fact('Bill', x.bill_reference ? `${x.bill_reference} (${x.bill_status})` : '—'), fact('File', x.filename || '—'), fact('When', day(x.created_at)), ...facts)),
        x.related && x.related.length ? section('Related', `${x.related.length}`, null, el('div', { class: 'panel' }, x.related.map((r) => item({ title: `${r.doc_type} · ${NAMES[r.doc_type] || ''}`,
          badge: statusChip(r.status), detail: `${r.direction === 'in' ? 'in' : 'out'} · ${day(r.created_at)}`, why: r.reason, onClick: () => { d.close(); openDoc(r.id); } })))) : null,
        err, raw);
    });
  }

  async function tabUpload() {
    const d = await coApi('/edi/partners');
    const who = select([['', 'Whoever the file says (ISA sender)'], ...d.partners.map((p) => [p.id, p.vendor])], '');
    const file = el('input', { type: 'file', accept: '.edi,.x12,.txt,.dat,*/*' });
    const out = el('div');
    const go_ = el('button', { class: 'btn primary', type: 'button', onclick: async () => {
      const f = file.files[0];
      if (!f) { toast('Choose the EDI file first.', 'warning'); return; }
      E.busy(go_, true, 'Reading…');
      try {
        const r = await post('/edi/upload', { text: await f.text(), filename: f.name, partnerId: who.value || null });
        const ok = r.documents.filter((x) => x.status === 'applied').length;
        out.replaceChildren(resultBox(ok === r.documents.length ? 'good' : 'warning', ok === r.documents.length ? 'ok' : 'warn',
          `${ok} of ${plural(r.documents.length, 'document')} applied${r.partner ? ` from ${r.partner}` : ''}`, r.acks.length ? `${plural(r.acks.length, '997')} queued back to the vendor.` : ''),
          el('div', { class: 'edi-docs' }, r.documents.map((x) => el('div', { class: 'edi-doc' }, el('div', {}, statusChip(x.status), ` ${x.type} · ${NAMES[x.type] || ''}`),
            x.reason ? el('div', { class: 'k', text: x.reason }) : null))));
        file.value = '';
      } catch (e) { out.replaceChildren(resultBox('critical', 'fail', 'Not taken in', friendly(e))); }
      finally { E.busy(go_, false); }
    } }, 'Upload and apply');
    return section('Upload EDI file', null, null, el('div', { class: 'panel pad' },
      el('p', { class: 'lead', text: 'An X12 file from a vendor: 855 acknowledgments, 856 ship notices, 810 invoices, 832 catalogs, 846 inventory, 997s. Each document is applied whole or quarantined with the reason; a repeat is ignored.' }),
      el('div', { class: 'form-grid' }, field('From', who), field('File', file)), el('div', { class: 'dlg-acts' }, go_), out));
  }

  // ================================================================ Store orders
  const SO_STATUS = { draft: ['neutral', 'pending', 'Draft'], submitted: ['warning', 'clock', 'Waiting for approval'], approved: ['good', 'ok', 'Approved'], rejected: ['critical', 'fail', 'Turned down'], cancelled: ['neutral', 'none', 'Cancelled'] };
  let SOF = 'submitted';
  async function screenStore() {
    style();
    const d = await coApi(`/edi/store-orders${SOF === 'all' ? '' : `?status=${SOF}`}`);
    const rows = d.orders.map((o) => item({ title: `${o.number} · ${o.vendor}`, amount: money(o.cost_minor), badge: chip(...SO_STATUS[o.status]),
      detail: [o.location, `${plural(Number(o.lines), 'line')}, ${Number(o.units)} pieces`, o.po_number, o.submitted_by_name ? `by ${o.submitted_by_name}` : o.created_by_name, day(o.submitted_at || o.created_at)].filter(Boolean).join(' · '),
      why: o.decision_note || null, onClick: () => openStore(o.id) }));
    return frag(head('Store orders', [el('button', { class: 'btn primary', type: 'button', onclick: () => openCart(null) }, icon('plus'), 'New store order')]),
      el('div', { class: 'toolbar' }, tabsOf([['draft', 'Drafts'], ['submitted', 'To approve'], ['approved', 'Approved'], ['rejected', 'Turned down'], ['all', 'All']], SOF, (k) => { SOF = k; render(); })),
      section('Orders', `${d.orders.length}`, null, el('div', { class: 'panel' }, rows.length ? capped(rows, 25, 'orders') : empty('None here.', null, true))),
      el('p', { class: 'foot', text: 'A store builds a cart for one vendor; the vendor’s freight minimums must be met to submit; a district manager or the purchasing director approves it (not whoever submitted it), which places the PO and sends it by the vendor’s channel.' }));
  }

  /** The cart: a new one (pick store and vendor) or a draft's lines. */
  async function openCart(o) {
    const d = openDialog(o ? `${o.order.number} · cart` : 'New store order', o ? o.order.vendor : 'One vendor per cart', { wide: true, sheet: true });
    const state = { vendor: o ? o.order.vendor_id : '', location: o ? o.order.location_id : '', qty: Object.fromEntries(o ? o.lines.map((l) => [l.product_id, Number(l.qty)]) : []) };
    const draw = async () => fillDialog(d, async () => {
      const f = await coApi(`/edi/store-orders/form${state.vendor ? `?vendor=${state.vendor}` : ''}`);
      if (!f.vendor) return empty('No vendor has anything to order.', null, true);
      state.vendor = f.vendor.id;
      if (!state.location) state.location = (f.locations[0] || {}).id;
      const v = select(f.vendors.map((x) => [x.id, x.name]), state.vendor), loc = select(f.locations.map((l) => [l.id, l.name]), state.location);
      if (o) { v.disabled = true; loc.disabled = true; }
      v.onchange = () => { state.vendor = v.value; state.qty = {}; draw(); };
      loc.onchange = () => { state.location = loc.value; };
      const total = el('div', { class: 'foot' });
      const sum = () => {
        const lines = f.products.filter((p) => state.qty[p.id] > 0);
        total.textContent = `${plural(lines.length, 'line')}, ${lines.reduce((a, p) => a + state.qty[p.id], 0)} pieces, ${money(lines.reduce((a, p) => a + state.qty[p.id] * Number(p.cost_minor), 0))} at cost`;
      };
      const rows = f.products.map((p) => {
        const q = input({ type: 'number', min: '0', inputmode: 'numeric', class: 'edi-qty', value: state.qty[p.id] || '', 'aria-label': `Quantity of ${p.name}` });
        q.oninput = () => { state.qty[p.id] = Number(q.value) || 0; sum(); };
        return item({ title: p.name, amount: money(p.cost_minor), detail: [p.sku, p.category, p.brand, p.vendor_atp && p.vendor_atp.qty != null ? `vendor has ${Number(p.vendor_atp.qty)}` : null].filter(Boolean).join(' · '),
          acts: [el('label', { class: 'field inline' }, el('span', { text: 'Qty' }), q)] });
      });
      sum();
      const err = el('div');
      const lines = () => Object.entries(state.qty).filter(([, n]) => n > 0).map(([productId, qty]) => ({ productId, qty }));
      const save = el('button', { class: 'btn primary', type: 'button', onclick: () => act(save, async () => {
        if (o) return post(`/edi/store-orders/${o.order.id}/lines`, { lines: lines() });
        return post('/edi/store-orders', { vendorId: state.vendor, locationId: state.location, lines: lines() });
      }, 'Cart saved', { errorInto: errInto(err), close: () => { d.close(); if (o) openStore(o.order.id); } }) }, o ? 'Save cart' : 'Save as draft');
      const rules = f.freight.filter((r) => r.active).map((r) => `${r.scope === 'all' ? 'Order' : `${r.scope_value} (${r.scope})`}: ${r.measure === 'qty' ? `${Number(r.minimum)} pieces` : money(r.minimum)}`);
      return frag(el('div', { class: 'form-grid' }, field('Vendor', v), field('Store', loc)),
        rules.length ? resultBox('neutral', 'info', 'Freight minimums', rules.join(' · ')) : null,
        section('Items', `${f.products.length}`, null, el('div', { class: 'panel' }, rows.length ? capped(rows, 40, 'items') : empty('Nothing active from this vendor.', null, true))),
        total, el('div', { class: 'dlg-acts' }, save, el('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Close')), err);
    });
    await draw();
  }

  async function openStore(id) {
    const d = openDialog('Store order', null, { wide: true, sheet: true });
    const again = () => { d.close(); openStore(id); };
    await fillDialog(d, async () => {
      const x = await coApi(`/edi/store-orders/${id}`);
      const o = x.order;
      d.dlg.querySelector('h2').textContent = `${o.number} · ${o.vendor}`;
      const err = el('div');
      const b = (label, fn, ok, primary) => { const btn = el('button', { class: 'btn small' + (primary ? ' primary' : ''), type: 'button', onclick: () => act(btn, fn, ok, { errorInto: errInto(err), close: again }) }, label); return btn; };
      const acts = [];
      if (o.status === 'draft') {
        acts.push(el('button', { class: 'btn small', type: 'button', onclick: () => { d.close(); openCart(x); } }, 'Change cart'));
        acts.push(b('Submit for approval', () => post(`/edi/store-orders/${id}/submit`, {}), 'Submitted for approval', true));
      }
      if (o.status === 'submitted') {
        const note = input({ placeholder: 'Note (optional)' }), over = input({ placeholder: 'Only if over budget: why it should go' });
        acts.push(el('div', { class: 'form-grid wide' }, field('Approval note', note), field('Over budget reason', over, 'The owner places an order over budget, with a reason')));
        acts.push(b('Approve and place PO', () => post(`/edi/store-orders/${id}/approve`, { note: note.value, overBudgetReason: over.value }),
          (r) => `${r.po.number} placed${r.sent ? `; ${r.sent.channel}: ${r.sent.status}${r.sent.detail ? ` (${r.sent.detail})` : ''}` : ''}`, true));
        const rej = el('button', { class: 'btn small', type: 'button', onclick: async () => {
          const why = await askReason({ title: `Turn down ${o.number}`, confirm: 'Turn down' });
          if (why) act(rej, () => post(`/edi/store-orders/${id}/reject`, { reason: why }), 'Turned down', { errorInto: errInto(err), close: again });
        } }, 'Turn down');
        const back = el('button', { class: 'btn small', type: 'button', onclick: async () => {
          const why = await askReason({ title: `Back to draft`, lead: 'The store can change the cart and submit it again.', confirm: 'Send back' });
          if (why) act(back, () => post(`/edi/store-orders/${id}/back`, { reason: why }), 'Back to draft', { errorInto: errInto(err), close: again });
        } }, 'Back to draft');
        acts.push(rej, back);
      }
      if (o.status === 'draft' || o.status === 'submitted') {
        const can = el('button', { class: 'btn small', type: 'button', onclick: async () => {
          const why = await askReason({ title: `Cancel ${o.number}`, confirm: 'Cancel the order' });
          if (why) act(can, () => post(`/edi/store-orders/${id}/cancel`, { reason: why }), 'Cancelled', { errorInto: errInto(err), close: again });
        } }, 'Cancel');
        acts.push(can);
      }
      const short = x.freight.filter((f) => !f.ok);
      return frag(
        el('div', { class: 'toolbar' }, chip(...SO_STATUS[o.status])),
        o.decision_note ? resultBox(o.status === 'rejected' ? 'critical' : 'neutral', 'info', o.status === 'rejected' ? 'Turned down' : 'Note', o.decision_note) : null,
        x.freight.length ? resultBox(short.length ? 'warning' : 'good', short.length ? 'warn' : 'ok', short.length ? 'Freight minimum not met' : 'Freight minimums met', x.freight.map((f) => f.message).join(' · ')) : null,
        el('div', { class: 'panel' }, el('div', { class: 'facts' }, fact('Store', o.location), fact('Vendor', o.vendor), fact('At cost', money(o.cost_minor || 0)),
          fact('Started by', o.created_by_name || '—'), fact('Submitted by', o.submitted_by_name || '—'), fact('Decided by', o.decided_by_name || '—'), fact('Purchase order', o.po_number || '—'))),
        section('Lines', `${x.lines.length}`, null, el('div', { class: 'panel' }, x.lines.length ? x.lines.map((l) => item({ title: l.name, amount: money(Number(l.qty) * Number(l.cost_minor)),
          detail: [`${Number(l.qty)} × ${money(l.cost_minor)}`, l.sku, l.category, l.brand].filter(Boolean).join(' · ') })) : empty('The cart is empty.', null, true))),
        el('div', { class: 'dlg-acts' }, acts), err);
    });
  }

  E.register('edi', 'Vendor EDI', 'feed', screen, 'Setup', { module: 'edi' });
  E.register('storeorders', 'Store orders', 'cart', screenStore, 'Retail', { module: 'edi' });
})();
