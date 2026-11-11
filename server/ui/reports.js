// reports screens. Registers with window.ERP (see docs/MODULES.md).
// The report list (folders, pinned, starters), a report's run view (prompts,
// chart, results that page on the server, drill-down to the rows behind a
// total and on to the journal entry, CSV / Excel / print, pin, schedule,
// history) and the editor: Data -> Columns -> Filters -> Group & totals ->
// Chart -> Save, with a live preview. Phone first: results are cards on a
// phone and an aligned table on a wider screen; pickers, never free SQL.
(() => {
  'use strict';
  const E = window.ERP;
  if (!E) return;
  const { S, el, frag, icon, chip, money, plural, coApi, post, go, toast, openDialog, resultBox, fillDialog, head, section, empty, item, seg,
    friendly, render, tbl, td, NARROW, openEntry, loadingNode, busy, shortDay, dayLabel, ago, sentence } = E;

  const field = (label, control, hint) => el('label', { class: 'field' }, el('span', { text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null);
  const select = (options, value, props) => el('select', props || {}, options.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(value ?? '') || null })));
  const input = (props) => el('input', Object.assign({ type: 'text' }, props));
  const btn = (label, onclick, cls, ic) => el('button', { class: 'btn' + (cls ? ' ' + cls : ''), type: 'button', onclick }, ic ? icon(ic) : null, label);
  const fmtMonth = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' });
  const fmtDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const pd = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const ROLE_WORD = { controller: 'Controller', viewer: 'Viewer', approver: 'Approver', ap_clerk: 'A/P clerk', store_manager: 'Store manager', sales: 'Sales',
    cashier: 'Cashier', buyer: 'Buyer', warehouse: 'Warehouse', dispatcher: 'Dispatcher', driver: 'Driver', ar_clerk: 'A/R clerk', hr: 'HR', web_admin: 'Web admin' };
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  E.register('reports', 'Reports', 'chart', screen, 'Back office', { icon: 'M4 20h16|M7 16.5v-5M12 16.5V7M17 16.5v-8', module: 'reports' });

  function style() {
    if (window.__repSheet) return;
    const sheet = new CSSStyleSheet();
    window.__repSheet = sheet;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    sheet.replaceSync(`
.rp-steps{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
.rp-steps button{appearance:none;border:1px solid var(--line-2);background:var(--panel);color:var(--ink);border-radius:999px;padding:6px 12px;font:inherit;font-size:13.5px;font-weight:620;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.rp-steps button .n{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--neutral-bg);font-size:12px}
.rp-steps button[aria-current="step"]{background:var(--btn);color:var(--btn-ink);border-color:var(--btn)}
.rp-steps button[aria-current="step"] .n{background:rgba(255,255,255,.2)}
.rp-pane{padding:14px 16px}
.rp-cardl{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 8px;background:var(--panel)}
.rp-cardl .top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rp-cardl .top .nm{font-weight:650;flex:1 1 140px;min-width:0;overflow-wrap:anywhere}
.rp-cardl .sub{font-size:13px;color:var(--ink-2);margin-top:2px}
.rp-ctl{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:8px}
.rp-ctl>*{flex:1 1 150px;min-width:0}
.rp-ctl .field{margin:0}
.rp-ctl .tiny{flex:0 0 auto}
.rp-icon{appearance:none;border:1px solid var(--line);background:var(--panel);border-radius:8px;width:34px;height:34px;display:inline-grid;place-items:center;cursor:pointer;color:var(--ink-2);flex:none}
.rp-icon:disabled{opacity:.4;cursor:default}
.rp-icon svg{width:16px;height:16px}
.rp-icon .up{transform:rotate(180deg)}
.rp-ds{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.rp-ds button{appearance:none;text-align:left;border:1px solid var(--line);background:var(--panel);border-radius:12px;padding:12px 14px;font:inherit;color:var(--ink);cursor:pointer}
.rp-ds button[aria-pressed="true"]{outline:2px solid var(--accent);border-color:transparent}
.rp-ds button b{display:block;margin-bottom:3px}
.rp-ds button span{font-size:13px;color:var(--ink-2)}
.rp-fold{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);margin:14px 0 8px}
.rp-acts{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}
.rp-prompts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));gap:4px 14px;padding:4px 16px 12px}
.rp-meta{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:13.5px;color:var(--ink-2);margin:0 0 10px}
.rp-pager{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:10px 16px;border-top:1px solid var(--line)}
.rp-rc{border-top:1px solid var(--line);padding:11px 16px}
.rp-rc:first-child{border-top:0}
.rp-rc.click{cursor:pointer}
.rp-rc.sub{background:var(--soft)}
.rp-rc.total{background:var(--head);font-weight:650}
.rp-rc .h{font-weight:650;overflow-wrap:anywhere;margin-bottom:6px;display:flex;gap:8px;justify-content:space-between}
.rp-rc .h .k{color:var(--ink-2);font-weight:600;font-size:12.5px;white-space:nowrap}
.rp-rc dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 12px;margin:0;font-size:14px}
.rp-rc dt{color:var(--ink-2);min-width:0;overflow-wrap:anywhere}
.rp-rc dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;min-width:0}
.rp-rc dd.t{text-align:right}
.tbl tr.rp-click{cursor:pointer}
.rp-bars{padding:12px 16px;display:flex;flex-direction:column;gap:6px}
.rp-bar{display:grid;grid-template-columns:minmax(0,9.5rem) minmax(0,1fr) auto;gap:10px;align-items:center;font-size:13.5px}
.rp-bar .l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
.rp-bar .tr{height:14px;position:relative}
.rp-bar .fi{position:absolute;left:0;top:0;bottom:0;background:var(--teal);border-radius:0 4px 4px 0;min-width:2px}
.rp-bar .fi.neg{background:var(--ink-2)}
.rp-bar .v{font-variant-numeric:tabular-nums;color:var(--ink-2);text-align:right;white-space:nowrap}
.rp-bar:hover .fi{filter:brightness(.9)}
.rp-line{padding:12px 16px 6px}
.rp-line svg{display:block;width:100%;height:170px;overflow:visible}
.rp-line .ax{display:flex;justify-content:space-between;font-size:12.5px;color:var(--ink-2);margin-top:4px;gap:8px}
.rp-line .tip{font-size:13px;color:var(--ink-2);min-height:18px}
.rp-chart-h{display:flex;justify-content:space-between;gap:10px;padding:12px 16px 0;font-size:13px;color:var(--ink-2)}
@media (min-width:1100px){.rp-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px;align-items:start}}
.rp-print{display:none}
@media print{
  body *{visibility:hidden!important}
  .rp-print,.rp-print *{visibility:visible!important}
  .rp-print{display:block!important;position:absolute;left:0;top:0;width:100%;padding:0 4mm;font-size:11px;color:#000;background:#fff}
  .rp-print table{width:100%;border-collapse:collapse}
  .rp-print th,.rp-print td{border-bottom:1px solid #bbb;padding:3px 5px;text-align:left}
  .rp-print .m{text-align:right}
  .rp-print tr.sum td{font-weight:700;background:#f2f2f2}
  .rp-print tr.total td{font-weight:800;border-top:2px solid #000}
  .rp-print h1{font-size:16px;margin:0 0 4px}
  .rp-print p{margin:0 0 8px}
}`);
  }

  // ------------------------------------------------------------ catalog & formats
  let CAT = null;
  async function catalog() {
    const key = `${S.co.id}:${S.person && S.person.id}`;
    if (!CAT || CAT.key !== key) CAT = { key, data: await coApi('/reports/catalog') };
    return CAT.data;
  }
  const dsOf = (cat, id) => cat.datasets.find((d) => d.id === id);
  const fieldOf = (ds, id) => ds && ds.fields.find((f) => f.id === id);

  function bucketText(b, v) {
    if (v == null || v === '') return '(blank)';
    const d = pd(v);
    if (b === 'month') return fmtMonth.format(d);
    if (b === 'year') return String(d.getFullYear());
    if (b === 'quarter') return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
    if (b === 'week') return `Week of ${shortDay(v)}`;
    return dayLabel(v);
  }
  function fmt(c, v) {
    if (c.role === 'group') {
      if (c.bucket) return bucketText(c.bucket, v);
      if (v == null || v === '') return '(blank)';
    }
    if (v == null || v === '') return '';
    switch (c.type) {
      case 'money': return money(v);
      case 'percent': return `${(Number(v) * 100).toFixed(1)}%`;
      case 'number': return NUM.format(Number(v));
      case 'date': return fmtDate.format(pd(v));
      case 'bool': return v === true || v === 'true' ? 'Yes' : 'No';
      default: return String(v);
    }
  }
  const isNum = (c) => c.align === 'right';

  async function download(r) {
    let blob;
    if (r.base64) {
      const bin = atob(r.base64); const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      blob = new Blob([u], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    } else blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: r.filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(r.note || `${plural(r.rows, 'row')} exported to ${r.filename}`, r.note ? 'warning' : 'good');
  }

  // ------------------------------------------------------------ results
  /**
   * A result: chart, a line of what it covers, rows (cards on a phone, a
   * table wider), and a pager. opts.onDrill(keys, label) for a grouped row;
   * GL detail rows open their journal entry.
   */
  function resultView(res, opts = {}) {
    const groups = res.columns.filter((c) => c.role === 'group');
    const measures = res.columns.filter((c) => c.role !== 'group');
    const keysOf = (row) => groups.slice(0, row._depth ?? groups.length).map((c) => row[c.key] ?? null);
    const titleOf = (row) => groups.slice(0, row._depth ?? groups.length).map((c) => fmt(c, row[c.key])).join(' · ');
    const clickOf = (row) => {
      if (res.mode === 'grouped' && opts.onDrill) return () => opts.onDrill(keysOf(row), titleOf(row));
      if (row._entry && res.entryField) return () => openEntry(row._entry);
      return null;
    };
    const parts = [];
    if (res.chart && res.chart.points.length && opts.chart !== false) parts.push(chartView(res.chart, groups[0]));
    const from = res.count ? res.offset + 1 : 0, to = res.offset + res.rows.length;
    parts.push(el('div', { class: 'rp-meta' },
      el('span', { text: res.count ? `Rows ${from}–${to} of ${res.count}${res.capped ? '+' : ''}` : 'No rows' }),
      res.filters.map((f) => chip('neutral', 'info', `${f.label} ${f.text}`)),
      el('span', { text: `as of ${dayLabel(res.asOf)}` })));
    if (!res.rows.length) { parts.push(el('div', { class: 'panel' }, empty('Nothing matches.', 'Change a filter or the period and run it again.', true))); return frag(parts); }

    let body;
    if (NARROW.matches) {
      const card = (row, kind) => {
        const click = kind === 'total' ? null : clickOf(row);
        const head = kind === 'total' ? 'Total' : groups.length ? (titleOf(row) || '(blank)') + (kind === 'sub' ? ' — subtotal' : '') : null;
        const shown = groups.length ? measures : measures.slice(head ? 0 : 1);
        const first = !groups.length && kind !== 'total' ? measures[0] : null;
        return el('div', { class: 'rp-rc' + (kind === 'sub' ? ' sub' : '') + (kind === 'total' ? ' total' : '') + (click ? ' click' : ''),
          onclick: click, role: click ? 'button' : null, tabindex: click ? '0' : null, onkeydown: click ? (e) => { if (e.key === 'Enter') click(); } : null },
          el('div', { class: 'h' }, el('span', { text: head || fmt(first, row[first.key]) || '—' }), first && !head ? el('span', { class: 'k', text: first.label }) : null),
          el('dl', {}, shown.filter((c) => !(kind === 'total' && row[c.key] == null)).map((c) => [el('dt', { text: c.label }), el('dd', { text: fmt(c, row[c.key]) || '—' })])));
      };
      body = el('div', { class: 'panel' }, res.rows.map((row) => card(row, (row._depth ?? groups.length) < groups.length ? 'sub' : 'row')),
        res.total ? card(res.total, 'total') : null);
    } else {
      const head = res.columns.map((c, i) => [c.label, (isNum(c) ? 'm' : '') + (i === 0 ? ' first' : '')]);
      const rows = res.rows.map((row) => {
        const depth = row._depth ?? groups.length;
        const click = clickOf(row);
        return el('tr', { class: [depth < groups.length ? 'sum' : '', click ? 'rp-click' : ''].join(' ').trim() || null, onclick: click,
          tabindex: click ? '0' : null, onkeydown: click ? (e) => { if (e.key === 'Enter') click(); } : null },
          res.columns.map((c, i) => {
            let text = fmt(c, row[c.key]);
            if (c.role === 'group' && i >= depth) text = i === depth ? 'Subtotal' : '';
            return td(text, (isNum(c) ? 'm' : '') + (i === 0 ? ' first' : ''));
          }));
      });
      if (res.total) rows.push(el('tr', { class: 'total' }, res.columns.map((c, i) =>
        td(i === 0 && (c.role === 'group' || res.total[c.key] == null) ? 'Total' : c.role === 'group' ? '' : fmt(c, res.total[c.key]), (isNum(c) ? 'm' : '') + (i === 0 ? ' first' : '')))));
      body = el('div', { class: 'panel' }, tbl(head, rows));
    }
    parts.push(body);
    if (opts.onPage && res.count > res.rows.length) {
      const prev = btn('Previous', () => opts.onPage(Math.max(0, res.offset - res.size)), null);
      const next = btn('Next', () => opts.onPage(res.offset + res.rows.length), null);
      prev.disabled = res.offset === 0; next.disabled = to >= res.count;
      body.append(el('div', { class: 'rp-pager' }, prev, el('span', { class: 'sub', text: `${from}–${to} of ${res.count}` }), next));
    }
    if (res.mode === 'grouped' && opts.onDrill) parts.push(el('p', { class: 'foot', text: 'Tap a row to see the records behind it.' }));
    else if (res.entryField) parts.push(el('p', { class: 'foot', text: 'Tap a row to open its journal entry.' }));
    return frag(parts);
  }

  /** One measure across the first group: horizontal bars (labels wrap nothing, fit a phone) or a line. */
  function chartView(ch, g) {
    const pts = ch.points;
    const vals = pts.map((p) => Number(p.value || 0));
    const max = Math.max(...vals.map(Math.abs), 1);
    const valText = (v) => fmt({ type: ch.valueType }, v);
    const label = (p) => fmt(g || { role: 'group', bucket: ch.bucket }, p.key);
    const top = el('div', { class: 'rp-chart-h' }, el('span', { text: ch.label }), el('span', { text: plural(pts.length, ch.bucket ? 'period' : 'group') }));
    if (ch.type === 'bar') {
      return el('div', { class: 'panel', role: 'img', 'aria-label': `${ch.label} by ${g ? g.label : 'group'}` }, top, el('div', { class: 'rp-bars' },
        pts.map((p, i) => el('div', { class: 'rp-bar', title: `${label(p)}: ${valText(p.value)}` },
          el('span', { class: 'l', text: label(p) }),
          el('span', { class: 'tr' }, (() => { const f = el('span', { class: 'fi' + (vals[i] < 0 ? ' neg' : '') }); f.style.width = `${(Math.abs(vals[i]) / max) * 100}%`; return f; })()),
          el('span', { class: 'v', text: valText(p.value) })))));
    }
    // Line: drawn in a 1000×170 box; the stroke keeps its width however wide the panel is.
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1000 170'); svg.setAttribute('preserveAspectRatio', 'none');
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1;
    const x = (i) => (pts.length === 1 ? 500 : (i / (pts.length - 1)) * 1000), y = (v) => 160 - ((v - lo) / span) * 150;
    const base = document.createElementNS(NS, 'line');
    for (const [k, v] of [['x1', 0], ['x2', 1000], ['y1', y(0)], ['y2', y(0)]]) base.setAttribute(k, String(v));
    base.setAttribute('stroke', 'var(--line-2)'); base.setAttribute('vector-effect', 'non-scaling-stroke');
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', vals.map((v, i) => `${x(i)},${y(v)}`).join(' '));
    line.setAttribute('fill', 'none'); line.setAttribute('stroke', 'var(--teal)'); line.setAttribute('stroke-width', '2');
    line.setAttribute('vector-effect', 'non-scaling-stroke'); line.setAttribute('stroke-linejoin', 'round');
    svg.append(base, line);
    const tip = el('div', { class: 'tip', text: `Highest ${valText(String(Math.max(...vals)))}` });
    pts.forEach((p, i) => {
      const hit = document.createElementNS(NS, 'rect');
      const w = 1000 / Math.max(1, pts.length);
      hit.setAttribute('x', String(Math.max(0, x(i) - w / 2))); hit.setAttribute('width', String(w)); hit.setAttribute('y', '0'); hit.setAttribute('height', '170');
      hit.setAttribute('fill', 'transparent');
      const t = document.createElementNS(NS, 'title'); t.textContent = `${label(p)}: ${valText(p.value)}`; hit.append(t);
      hit.addEventListener('mouseenter', () => { tip.textContent = `${label(p)}: ${valText(p.value)}`; });
      svg.append(hit);
    });
    return el('div', { class: 'panel', role: 'img', 'aria-label': `${ch.label} by ${g ? g.label : 'group'}` }, top,
      el('div', { class: 'rp-line' }, tip, svg, el('div', { class: 'ax' }, el('span', { text: label(pts[0]) }), pts.length > 1 ? el('span', { text: label(pts[pts.length - 1]) }) : null)));
  }

  function openDrill(source, params, keys, title) {
    const d = openDialog(title || 'Rows', 'The records behind this row', { wide: true });
    const load = (offset) => fillDialog(d, async () => {
      const res = await post('/reports/drill', { ...source, params, keys, offset, size: 50 });
      return resultView(res, { onPage: load, chart: false });
    });
    load(0);
  }

  // ------------------------------------------------------------ prompts
  /** Controls for the filters a report asks for at run time. Returns {node, values()}. */
  function prompts(cat, def, saved) {
    const ds = dsOf(cat, def.dataset);
    const asked = def.filters.map((f, i) => [f, i]).filter(([f]) => f.ask);
    if (!asked.length || !ds) return { node: null, values: () => ({}) };
    const getters = {};
    const nodes = asked.map(([f, i]) => {
      const fd = fieldOf(ds, f.field);
      const prev = saved[i] || {};
      const box = el('div');
      const draw = (op) => {
        const v1 = valueControl(fd, op, prev.op === op ? prev.value : f.op === op ? f.value : undefined, cat, ds);
        const v2 = op === 'between' ? valueControl(fd, op, prev.op === op ? prev.value2 : f.value2, cat, ds) : null;
        const opSel = fd.type === 'date' ? select([['relative', 'Period'], ['between', 'Between dates'], ['on_or_after', 'From'], ['on_or_before', 'Up to']], op) : null;
        if (opSel) opSel.addEventListener('change', () => draw(opSel.value));
        box.replaceChildren(field(f.label || fd.label, el('div', { class: 'rp-ctl' }, opSel, v1.node, v2 ? v2.node : null)));
        getters[i] = () => ({ op, value: v1.get(), value2: v2 ? v2.get() : undefined });
      };
      draw(prev.op || f.op);
      return box;
    });
    return { node: el('div', { class: 'rp-prompts' }, nodes), values: () => Object.fromEntries(Object.entries(getters).map(([i, g]) => [i, g()])) };
  }

  /** The input for one filter value, by field type and operator. */
  function valueControl(fd, op, value, cat, ds) {
    if (['blank', 'not_blank', 'is_true', 'is_false'].includes(op)) return { node: null, get: () => undefined };
    if (op === 'relative') {
      const s = select(Object.entries(cat.relative), value || 'this_month', { 'aria-label': 'Period' });
      return { node: s, get: () => s.value };
    }
    if (op === 'within_days' || op === 'older_than_days') {
      const i = input({ type: 'number', min: '0', max: '3650', value: value ?? 90, inputmode: 'numeric', 'aria-label': 'Days' });
      return { node: i, get: () => i.value };
    }
    if (op === 'in' || op === 'not_in') {
      const i = input({ value: Array.isArray(value) ? value.join(', ') : value || '', placeholder: 'one, another', 'aria-label': 'Values' });
      const pick = el('button', { class: 'btn tiny', type: 'button', onclick: () => pickValues(ds, fd, i) }, 'Pick');
      return { node: el('div', { class: 'rp-ctl' }, i, pick), get: () => i.value.split(',').map((x) => x.trim()).filter(Boolean) };
    }
    if (fd.type === 'date') { const i = input({ type: 'date', value: value || '', 'aria-label': fd.label }); return { node: i, get: () => i.value }; }
    if (fd.type === 'money') { const i = input({ inputmode: 'decimal', value: value ?? '', placeholder: '0.00', 'aria-label': `${fd.label} in dollars` }); return { node: i, get: () => i.value }; }
    if (fd.type === 'number') { const i = input({ type: 'number', step: 'any', value: value ?? '', 'aria-label': fd.label }); return { node: i, get: () => i.value }; }
    const i = input({ value: value ?? '', 'aria-label': fd.label });
    return { node: i, get: () => i.value };
  }

  function pickValues(ds, fd, target) {
    const d = openDialog(`Pick ${fd.label.toLowerCase()}`, ds.label);
    fillDialog(d, async () => {
      const r = await post('/reports/values', { dataset: ds.id, field: fd.id });
      const have = new Set(target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
      const boxes = r.values.map((v) => { const b = el('input', { type: 'checkbox', checked: have.has(v.toLowerCase()) }); return [v, b]; });
      return frag(r.values.length ? el('div', { class: 'panel' }, boxes.map(([v, b]) => el('label', { class: 'li check-row' }, b, el('div', { class: 't', text: v }))))
        : empty('No values yet.', null, true),
        el('div', { class: 'dlg-acts' }, btn('Use these', () => { target.value = boxes.filter(([, b]) => b.checked).map(([v]) => v).join(', '); target.dispatchEvent(new Event('change')); d.close(); }, 'primary'),
          btn('Cancel', () => d.close())));
    });
  }

  // ------------------------------------------------------------ screen
  async function screen(sub) {
    style();
    if (!S.person) throw new Error('Pick who you are acting as; reports show what that person may see');
    if (sub === 'new') return editor(null);
    if (sub === 'tax-filing') return taxFiling();
    if (/^e-[0-9a-f-]{36}$/i.test(sub)) return editor(sub.slice(2));
    if (/^r-[0-9a-f-]{36}$/i.test(sub)) return runView(sub.slice(2));
    return listView();
  }

  let QUERY = '';
  async function listView() {
    const d = await coApi('/reports');
    const box = el('div');
    const search = input({ type: 'search', placeholder: 'Find a report', value: QUERY, 'aria-label': 'Find a report' });
    const draw = () => {
      const qy = QUERY.trim().toLowerCase();
      const list = d.reports.filter((r) => !qy || `${r.name} ${r.description || ''} ${r.folder} ${r.datasetLabel}`.toLowerCase().includes(qy));
      const row = (r) => item({ title: r.name,
        detail: [r.description, r.datasetLabel, r.starter ? 'Starter' : r.owner_id === S.person.id ? 'Yours' : `By ${r.owner_name || 'someone'}`,
          r.shared === 'company' ? 'Shared with everyone' : r.shared === 'roles' ? `Shared with ${r.share_roles.map((x) => ROLE_WORD[x] || x).join(', ')}` : 'Private'].filter(Boolean).join(' · '),
        badge: r.schedule ? chip('neutral', 'clock', `${r.schedule.every[0].toUpperCase()}${r.schedule.every.slice(1)}`) : r.pinned ? chip('good', 'ok', 'On Home') : null,
        onClick: () => go('reports', 'r-' + r.id) });
      const folders = new Map();
      for (const r of list) { if (!folders.has(r.folder)) folders.set(r.folder, []); folders.get(r.folder).push(r); }
      const pinned = list.filter((r) => r.pinned);
      box.replaceChildren(frag(
        pinned.length && !qy ? section('Pinned to Home', null, null, el('div', { class: 'panel' }, pinned.map(row))) : null,
        [...folders.entries()].map(([f, rs]) => section(f, plural(rs.length, 'report'), null, el('div', { class: 'panel' }, rs.map(row)))),
        list.length ? null : el('div', { class: 'panel' }, empty(qy ? 'No report matches.' : 'No reports yet.', 'Make one with New report.', true))));
    };
    search.addEventListener('input', () => { QUERY = search.value; draw(); });
    draw();
    return frag(head('Reports', [btn('Sales tax filing', () => go('reports', 'tax-filing'), null, 'file'), btn('New report', () => go('reports', 'new'), 'primary', 'plus')]),
      el('div', { class: 'toolbar' }, el('div', { class: 'grow' }, search)),
      box,
      el('p', { class: 'foot', text: 'Reports show only what the person you are acting as may see. Starters come with the modules you have on; make your own with New report or by duplicating one.' }));
  }

  // ------------------------------------------------------ sales tax filing
  // Per jurisdiction for a period: gross, exempt by reason, taxable, tax, returns;
  // tied to GL 2100 with any difference shown first. Cards, never a wide table.
  const TAXP = { from: '', to: '' };
  async function taxFiling() {
    const iso = E.isoDay;   // the local calendar day, not UTC's
    const now = new Date();
    if (!TAXP.from) { TAXP.from = iso(new Date(now.getFullYear(), now.getMonth(), 1)); TAXP.to = iso(now); }
    const from = input({ type: 'date', value: TAXP.from, 'aria-label': 'First day' }), to = input({ type: 'date', value: TAXP.to, 'aria-label': 'Last day' });
    const out = el('div');
    const month = (k) => { const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1)); const e = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0));
      from.value = iso(m); to.value = k === 0 ? iso(now) : iso(e); load(); };
    const row = (k, v, strong) => el('div', { class: 'li' }, el('div', { class: 't', text: k }), el('div', { class: 'amt' }, strong ? el('b', { text: v }) : v));
    async function load() {
      TAXP.from = from.value; TAXP.to = to.value;
      out.replaceChildren(loadingNode('Adding up the period…'));
      try {
        const f = await coApi(`/reports/tax-filing?from=${encodeURIComponent(from.value)}&to=${encodeURIComponent(to.value)}`);
        const tie = f.tie;
        // Each total is the jurisdictions' figures added up: one row per jurisdiction.
        const byJur = (title, col, note) => E.drillItems(title, f.rows.map((r) => E.item({ title: `${r.name} · ${r.state}`, amount: money(r[col]),
          detail: [r.code, r.level, r.filingRef ? `filed under ${r.filingRef}` : null].filter(Boolean).join(' · ') })),
          { noun: 'jurisdiction', totalMinor: f.rows.reduce((a, r) => a + BigInt(r[col] || 0), 0n).toString(), expect: { minor: f.totals[col] }, sub: `${from.value} to ${to.value}`,
            note: note || 'Each jurisdiction’s share; a sale counts in every jurisdiction that taxes it, so the state, county and city rows each include it.' });
        out.replaceChildren(frag(
          resultBox(tie.ties ? 'good' : 'critical', tie.ties ? 'ok' : 'warn', tie.ties ? 'Ties to GL 2100' : 'Does not tie to GL 2100', tie.note),
          tie.beforeNote ? resultBox('warning', 'warn', 'Tax from before the upgrade', tie.beforeNote) : null,
          f.collection && !f.collection.ok ? section('Tax under/over-collected', money(f.collection.underCollectedMinor), null, el('div', { class: 'panel' },
            resultBox('warning', 'warn', `Tax ${Number(f.collection.underCollectedMinor) > 0 ? 'under' : 'over'}-collected`, f.collection.note),
            f.collection.lines.map((x) => item({ title: `${x.order_number} · ${x.sku} · ${x.code}`, amount: money(x.differenceMinor),
              detail: `charged ${money(x.tax)}, owed ${money(x.owed)}` })))) : null,
          f.uncoveredZips && f.uncoveredZips.length ? section('ZIPs with no local tax set up', plural(f.uncoveredZips.length, 'ZIP'), null, el('div', { class: 'panel' },
            f.uncoveredZips.map((z) => item({ title: `${z.state} ${z.postal}`, amount: money(z.tax), detail: `${plural(z.lines, 'line')} taxed without a local rate; add the local jurisdictions in Setup → Sales tax` })))) : null,
          E.tilesRow(E.tile({ label: 'Gross sales', value: money(f.totals.grossMinor), onClick: () => byJur('Gross sales', 'grossMinor') }),
            E.tile({ label: 'Taxable sales', value: money(f.totals.taxableMinor), onClick: () => byJur('Taxable sales', 'taxableMinor') }),
            E.tile({ label: 'Tax collected', value: money(f.totals.taxMinor), onClick: () => byJur('Tax collected', 'taxMinor') }),
            E.tile({ label: 'Net tax due', value: money(f.totals.netTaxMinor), tone: 'good', onClick: () => byJur('Net tax due', 'netTaxMinor', 'Tax collected, less tax given back on returns.') })),
          f.rows.length ? f.rows.map((r) => section(`${r.name} · ${r.state}`, `${r.code}${r.filingRef ? ' · filed under ' + r.filingRef : ''}`, null, el('div', { class: 'panel' },
            row('Gross sales', money(r.grossMinor)), row('Exempt sales', money(r.exemptMinor)),
            Object.entries(r.exemptBy).map(([k, v]) => row(`· ${f.reasons[k] || k}`, money(v))),
            row('Taxable sales', money(r.taxableMinor)), row('Tax collected', money(r.taxMinor)),
            row('Returns', money(r.returnsMinor)), row('Tax refunded on returns', money(r.returnsTaxMinor)), row('Net tax due', money(r.netTaxMinor), true))))
            : el('div', { class: 'panel' }, empty('Nothing reached the ledger in this period.', null, true)),
          el('div', { class: 'panel' }, row('GL 2100, sales and returns', money(tie.glSalesMinor)), row('Jurisdictions together', money(tie.collectedMinor)),
            row('GL 2100, other entries (manual, bills)', money(tie.glOtherMinor)),
            row('Difference', money(tie.differenceMinor), true), row('Paid to the state (left out of the tie)', money(tie.glRemittedMinor)))));
      } catch (e) { out.replaceChildren(resultBox('critical', 'fail', 'The filing did not load', friendly(e))); }
    }
    const exp = btn('Export CSV', async (e) => {
      const b = e.currentTarget; busy(b, true, 'Exporting…');
      try { await download(await post('/reports/tax-filing/export', { from: from.value, to: to.value })); }
      catch (err) { toast(friendly(err), 'critical'); } finally { busy(b, false); }
    }, 'primary', 'file');
    load();
    return frag(head('Sales tax filing', [exp, btn('All reports', () => go('reports', ''))]),
      el('p', { class: 'lead', text: 'What to file, per jurisdiction, for sales that reached the ledger in the period (handed over or returned). The jurisdictions’ total is checked against GL 2100.' }),
      el('div', { class: 'rp-acts' }, btn('This month', () => month(0)), btn('Last month', () => month(-1)),
        field('From', from), field('To', to), btn('Show', () => load(), null, 'refresh')),
      out);
  }

  const PARAMS = new Map();   // report id -> last prompt values, kept while the page is open

  async function runView(id) {
    const [d, cat] = await Promise.all([coApi(`/reports/${id}`), catalog()]);
    const r = d.report;
    const def = r.definition;
    const saved = PARAMS.get(id) || {};
    const pr = prompts(cat, def, saved);
    const out = el('div');
    const source = { reportId: id };
    let offset = 0;
    const runIt = async (b, off) => {
      offset = off || 0;
      const params = pr.values();
      PARAMS.set(id, params);
      if (b) busy(b, true, 'Running…');
      out.replaceChildren(loadingNode('Running the report…'));
      try {
        const res = await post('/reports/run', { ...source, params, offset });
        out.replaceChildren(resultView(res, { onDrill: (keys, label) => openDrill(source, params, keys, label), onPage: (o) => runIt(null, o) }));
      } catch (e) { out.replaceChildren(resultBox('critical', 'fail', 'The report did not run', friendly(e))); }
      finally { if (b && b.isConnected) busy(b, false); }
    };
    const runBtn = btn('Run', (e) => runIt(e.currentTarget, 0), 'primary', 'refresh');
    const exportBtn = (label, format) => btn(label, async (e) => {
      const b = e.currentTarget; busy(b, true, 'Exporting…');
      try { await download(await post('/reports/export', { ...source, params: pr.values(), format })); }
      catch (err) { toast(friendly(err), 'critical'); } finally { busy(b, false); }
    }, null, 'file');
    const pinBtn = btn(d.pinned ? 'Unpin from Home' : 'Pin to Home', async (e) => {
      const b = e.currentTarget; busy(b, true);
      try { await post(`/reports/${id}/pin`, { on: !d.pinned }); toast(d.pinned ? 'Taken off Home' : 'Pinned to Home', 'good'); render(); }
      catch (err) { toast(friendly(err), 'critical'); busy(b, false); }
    }, null, 'home');
    const acts = [runBtn, exportBtn('CSV', 'csv'), exportBtn('Excel', 'xlsx'), btn('Print', (e) => printReport(e.currentTarget, r, source, pr.values()), null, 'file'), pinBtn,
      r.canEdit ? btn(r.schedule ? 'Schedule…' : 'Schedule', () => openSchedule(r), null, 'clock') : null,
      btn('Save a snapshot', async (e) => {
        const b = e.currentTarget; busy(b, true, 'Saving…');
        try { const s = await post(`/reports/${id}/snapshot`, {}); toast(s.problem ? sentence(s.problem) : `Snapshot kept: ${plural(s.rows, 'row')}`, s.problem ? 'warning' : 'good'); }
        catch (err) { toast(friendly(err), 'critical'); } finally { busy(b, false); }
      }, null, 'ok'),
      btn('History', () => openHistory(r, d.snapshots), null, 'clock'),
      r.canDelete ? btn('Delete', () => confirmDelete(r), null, 'x') : null];
    const sched = r.schedule ? `Runs ${r.schedule.every}${r.schedule.every === 'weekly' ? ' on ' + DOW[r.schedule.weekday ?? 1] + 's' : r.schedule.every === 'monthly' ? ` on day ${r.schedule.monthday ?? 1}` : ''}, next ${dayLabel(r.next_run_on)}` : null;
    const page = frag(
      head(r.name, [r.canEdit ? btn('Edit', () => go('reports', 'e-' + id), null, 'file') : null, btn('Duplicate', () => duplicate(r), null, 'plus')].filter(Boolean), r.folder),
      el('p', { class: 'lead', text: [r.description, `${dsOf(cat, r.dataset)?.label || r.dataset}`, `version ${r.version}`, r.updated_by_name ? `saved by ${r.updated_by_name} ${ago(r.updated_at)}` : null, sched].filter(Boolean).join(' · ') }),
      el('div', { class: 'rp-acts' }, acts.filter(Boolean)),
      pr.node ? section('Run it for', null, null, el('div', { class: 'panel' }, pr.node)) : null,
      out);
    runIt(null, 0);
    return page;
  }

  async function duplicate(r) {
    try { const x = await post(`/reports/${r.id}/duplicate`, {}); toast('Copied. This one is yours to change.', 'good'); go('reports', 'e-' + x.id); }
    catch (e) { toast(friendly(e), 'critical'); }
  }
  function confirmDelete(r) {
    const d = openDialog('Delete this report?', r.name);
    d.body.append(el('p', { class: 'lead', text: 'It leaves everyone’s list, its schedule stops and its pins come off Home. The record of it and its versions is kept.' }),
      el('div', { class: 'dlg-acts' }, btn('Delete it', async (e) => {
        const b = e.currentTarget; busy(b, true);
        try { await post(`/reports/${r.id}/delete`, {}); d.close(); toast('Report deleted', 'good'); go('reports'); }
        catch (err) { busy(b, false); d.body.append(resultBox('critical', 'fail', 'Not deleted', friendly(err))); }
      }, 'primary'), btn('Keep it', () => d.close())));
  }

  function openSchedule(r) {
    const s = r.schedule || { every: '', weekday: 1, monthday: 1, to: [] };
    const d = openDialog('Schedule', r.name);
    const every = select([['', 'Not scheduled'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month']], s.every);
    const wd = select(DOW.map((x, i) => [i, x]), s.weekday ?? 1);
    const md = select(Array.from({ length: 28 }, (_, i) => [i + 1, String(i + 1)]), s.monthday ?? 1);
    const people = S.people.map((p) => { const b = el('input', { type: 'checkbox', checked: (s.to || []).includes(p.id) }); return [p, b]; });
    const when = el('div');
    const drawWhen = () => when.replaceChildren(every.value === 'weekly' ? field('On', wd) : every.value === 'monthly' ? field('On day', md, 'Days 1 to 28, so every month has one') : '');
    every.addEventListener('change', drawWhen); drawWhen();
    const err = el('div');
    d.body.append(field('How often', every), when,
      el('div', { class: 'field' }, el('span', { text: 'Email it to' }), el('div', { class: 'panel' }, people.map(([p, b]) =>
        el('label', { class: 'li check-row' }, b, el('div', { class: 't', text: p.name }), el('div', { class: 'd', text: (p.roles || []).map((x) => ROLE_WORD[x] || x).join(', ') }))))),
      el('p', { class: 'foot', text: 'Each run keeps a snapshot here (see History) and prepares an email to these people. Email goes out once a mail service is connected; until then it waits as prepared.' }),
      el('div', { class: 'dlg-acts' }, btn('Save schedule', async (e) => {
        const b = e.currentTarget; busy(b, true);
        try {
          const x = await post(`/reports/${r.id}/schedule`, { every: every.value || null, weekday: Number(wd.value), monthday: Number(md.value), to: people.filter(([, c]) => c.checked).map(([p]) => p.id) });
          d.close(); toast(x.schedule ? `Scheduled; first run ${dayLabel(x.nextRunOn)}` : 'Schedule stopped', 'good'); render();
        } catch (er) { busy(b, false); err.replaceChildren(resultBox('critical', 'fail', 'Not saved', friendly(er))); }
      }, 'primary'), btn('Cancel', () => d.close())), err);
  }

  function openHistory(r, snaps) {
    const d = openDialog('History', r.name, { wide: true });
    fillDialog(d, async () => {
      const v = await coApi(`/reports/${r.id}/versions`);
      const TRIG = { schedule: 'Scheduled run', manual: 'Kept by hand' };
      return frag(
        section('Snapshots', snaps.length ? plural(snaps.length, 'run') : null, null, el('div', { class: 'panel' }, snaps.length ? snaps.map((s) => item({
          title: `${TRIG[s.trigger] || s.trigger} · ${new Date(s.run_at).toLocaleString()}`,
          detail: [s.problem ? sentence(s.problem) : plural(s.row_count, 'row'), s.run_by_name ? `as ${s.run_by_name}` : null, `version ${s.version}`, s.delivery ? `email ${s.delivery}` : null].filter(Boolean).join(' · '),
          badge: s.problem ? chip('warning', 'warn', 'Did not run') : null,
          onClick: s.problem ? null : () => openSnapshot(r, s) })) : empty('No snapshots yet.', 'A scheduled run, or Save a snapshot, keeps one here.', true))),
        section('Versions', plural(v.versions.length, 'version'), null, el('div', { class: 'panel' }, v.versions.map((x) => item({
          title: `Version ${x.version}: ${x.name}`, detail: [x.changed_by_name || 'Starter', new Date(x.changed_at).toLocaleString()].join(' · ') })))));
    });
  }
  function openSnapshot(r, s) {
    const d = openDialog(r.name, `Snapshot of ${new Date(s.run_at).toLocaleString()}`, { wide: true });
    fillDialog(d, async () => {
      const x = await coApi(`/reports/${r.id}/snapshots/${s.id}`);
      return x.result ? resultView(x.result, {}) : resultBox('warning', 'warn', 'This run did not produce rows', sentence(x.problem || ''));
    });
  }

  async function printReport(b, r, source, params) {
    busy(b, true, 'Preparing…');
    try {
      const res = await post('/reports/run', { ...source, params, size: 200 });
      const groups = res.columns.filter((c) => c.role === 'group');
      const sheet = el('div', { class: 'rp-print' }, el('h1', { text: r.name }),
        el('p', { text: [S.co.name, `as of ${fmtDate.format(pd(res.asOf))}`, ...res.filters.map((f) => `${f.label} ${f.text}`),
          res.count > res.rows.length ? `first ${res.rows.length} of ${res.count} rows` : plural(res.count, 'row')].join(' · ') }),
        el('table', {}, el('thead', {}, el('tr', {}, res.columns.map((c) => el('th', { class: isNum(c) ? 'm' : null, text: c.label })))),
          el('tbody', {}, res.rows.map((row) => {
            const depth = row._depth ?? groups.length;
            return el('tr', { class: depth < groups.length ? 'sum' : null }, res.columns.map((c, i) =>
              el('td', { class: isNum(c) ? 'm' : null, text: c.role === 'group' && i >= depth ? (i === depth ? 'Subtotal' : '') : fmt(c, row[c.key]) })));
          }), res.total ? el('tr', { class: 'total' }, res.columns.map((c, i) => el('td', { class: isNum(c) ? 'm' : null,
            text: i === 0 && (c.role === 'group' || res.total[c.key] == null) ? 'Total' : c.role === 'group' ? '' : fmt(c, res.total[c.key]) }))) : null)));
      document.body.append(sheet);
      const done = () => { sheet.remove(); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      window.print();
      setTimeout(done, 60000);
    } catch (e) { toast(friendly(e), 'critical'); }
    finally { busy(b, false); }
  }

  // ------------------------------------------------------------ editor
  const STEPS = [['data', 'Data'], ['columns', 'Columns'], ['filters', 'Filters'], ['group', 'Group & totals'], ['chart', 'Chart'], ['save', 'Save']];
  const DRAFTS = new Map();     // route -> draft, so a redraw keeps unsaved work

  async function editor(id) {
    const cat = await catalog();
    const key = id ? 'e-' + id : 'new';
    let D = DRAFTS.get(key);
    if (!D) {
      if (id) {
        const x = (await coApi(`/reports/${id}`)).report;
        if (!x.canEdit) throw new Error('Only the person who made this report can change it; duplicate it to make your own');
        D = { id, version: x.version, name: x.name, description: x.description || '', folder: x.folder, shared: x.shared, shareRoles: x.share_roles || [],
          def: JSON.parse(JSON.stringify(x.definition)), step: 'columns' };
      } else D = { id: null, version: null, name: '', description: '', folder: 'My reports', shared: 'private', shareRoles: [], def: null, step: 'data' };
      DRAFTS.set(key, D);
    }
    const root = el('div');
    const preview = el('div');
    let timer = 0, seq = 0;
    const ds = () => D.def && dsOf(cat, D.def.dataset);
    const grouped = () => !!(D.def && D.def.groupBy && D.def.groupBy.length);

    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!D.def) { preview.replaceChildren(el('div', { class: 'panel' }, empty('Pick the data first.', 'The preview shows the first rows as you build.', true))); return; }
        const my = ++seq;
        preview.replaceChildren(loadingNode('Previewing…'));
        try {
          // A filter still being filled in is left out of the preview rather than stopping it.
          const ready = (f) => f.ask || ['blank', 'not_blank', 'is_true', 'is_false'].includes(f.op) || (f.value !== undefined && (f.op !== 'between' || f.value2 !== undefined));
          const res = await post('/reports/run', { definition: { ...D.def, filters: D.def.filters.filter(ready) }, preview: true });
          if (my !== seq) return;
          const skipped = D.def.filters.length - D.def.filters.filter(ready).length;
          preview.replaceChildren(frag(resultView(res, { onDrill: (keys, label) => openDrill({ definition: { ...D.def, filters: D.def.filters.filter(ready) } }, {}, keys, label) }),
            skipped ? el('p', { class: 'foot', text: `${plural(skipped, 'filter')} without a value yet ${skipped === 1 ? 'is' : 'are'} left out of the preview.` }) : null,
            el('p', { class: 'foot', text: `Preview: the first ${res.rows.length} rows. Prompts left empty are not applied here.` })));
        } catch (e) { if (my === seq) preview.replaceChildren(resultBox('warning', 'warn', 'Not ready to run yet', friendly(e))); }
      }, 350);
    };
    const changed = () => { draw(); refresh(); };

    const draw = () => {
      const stepNav = el('nav', { class: 'rp-steps', 'aria-label': 'Steps' }, STEPS.map(([k, label], i) =>
        el('button', { type: 'button', 'aria-current': D.step === k ? 'step' : null, disabled: !D.def && k !== 'data' ? true : null,
          onclick: () => { D.step = k; draw(); } }, el('span', { class: 'n', text: String(i + 1) }), label)));
      const i = STEPS.findIndex(([k]) => k === D.step);
      const nav = el('div', { class: 'dlg-acts' },
        i > 0 ? btn('Back', () => { D.step = STEPS[i - 1][0]; draw(); }) : null,
        i < STEPS.length - 1 ? btn('Next', () => { D.step = STEPS[i + 1][0]; draw(); }, 'primary', null) : null);
      if (!D.def) nav.lastChild && (nav.lastChild.disabled = true);
      const pane = { data: stepData, columns: stepColumns, filters: stepFilters, group: stepGroup, chart: stepChart, save: stepSave }[D.step]();
      root.replaceChildren(stepNav, el('div', { class: 'panel rp-pane' }, pane, nav));
    };

    // -- data
    const stepData = () => {
      const folders = new Map();
      for (const d of cat.datasets) { if (!folders.has(d.folder)) folders.set(d.folder, []); folders.get(d.folder).push(d); }
      return frag(el('p', { class: 'lead', text: 'What is the report about? Each set of data is checked and scoped to this company; you only see the ones your roles allow.' }),
        [...folders.entries()].map(([f, list]) => [el('div', { class: 'rp-fold', text: f }), el('div', { class: 'rp-ds' }, list.map((d) =>
          el('button', { type: 'button', 'aria-pressed': String(!!D.def && D.def.dataset === d.id), onclick: () => pickDataset(d) },
            el('b', { text: d.label }), el('span', { text: d.description }))))]));
    };
    const pickDataset = (d) => {
      if (D.def && D.def.dataset === d.id) { D.step = 'columns'; draw(); return; }
      const first = (t) => d.fields.find((f) => f.type === t);
      const amount = ['net', 'amount', 'total', 'value', 'open', 'gross'].map((k) => d.fields.find((f) => f.id === k)).find(Boolean);
      const cols = [d.fields.find((f) => f.id === d.dateField), first('text'), amount || first('money') || first('number')].filter(Boolean);
      D.def = { dataset: d.id, columns: [...new Set(cols)].map((f) => ({ id: f.id, field: f.id })), filters: [], groupBy: [], subtotals: false, grandTotal: true, sort: null, limit: null, chart: null };
      if (!D.name) D.name = d.label;
      D.step = 'columns';
      changed();
    };

    // -- columns
    const colId = (base) => { let idv = base.replace(/[^a-z0-9_]/g, '_').slice(0, 20) || 'c'; let n = 2; while (D.def.columns.some((c) => c.id === idv)) idv = `${base.slice(0, 18)}_${n++}`; return idv; };
    const colLabel = (c) => {
      if (c.label) return c.label;
      const f = fieldOf(ds(), c.field);
      return f ? f.label : c.calc ? 'Calculated' : c.id;
    };
    const calcText = (c) => c.calc.kind === 'pct_total' ? `% of total of ${refLabel(c.calc.of)}` : c.calc.kind === 'margin'
      ? `(${refLabel(c.calc.revenue)} − ${refLabel(c.calc.cost)}) ÷ ${refLabel(c.calc.revenue)}` : c.calc.expr;
    const refLabel = (rid) => { const c = D.def.columns.find((x) => x.id === rid); if (c) return colLabel(c); const f = fieldOf(ds(), rid); return f ? f.label : rid; };
    const stepColumns = () => {
      const d = ds();
      const cols = D.def.columns;
      const move = (i, by) => { const [c] = cols.splice(i, 1); cols.splice(i + by, 0, c); changed(); };
      const groupedFields = new Set((D.def.groupBy || []).filter((g) => !g.bucket).map((g) => g.field));
      const cards = cols.map((c, i) => {
        const f = c.field && fieldOf(d, c.field);
        const lab = input({ value: c.label || '', placeholder: f ? f.label : 'Name', 'aria-label': 'Column name', onchange: (e) => { c.label = e.target.value.trim() || undefined; refresh(); } });
        const agg = grouped() && f ? select(f.aggs.map((a) => [a, cat.aggs[a]]), c.agg || (f.agg ? 'sum' : f.type === 'bool' ? 'count_true' : 'count_distinct'),
          { 'aria-label': 'Total as', onchange: (e) => { c.agg = e.target.value; refresh(); } }) : null;
        return el('div', { class: 'rp-cardl' },
          el('div', { class: 'top' }, el('span', { class: 'nm', text: colLabel(c) }),
            el('button', { class: 'rp-icon', type: 'button', 'aria-label': 'Move up', disabled: i === 0 || null, onclick: () => move(i, -1) }, icon('chev', 'up')),
            el('button', { class: 'rp-icon', type: 'button', 'aria-label': 'Move down', disabled: i === cols.length - 1 || null, onclick: () => move(i, 1) }, icon('chev')),
            el('button', { class: 'rp-icon', type: 'button', 'aria-label': 'Remove column', onclick: () => {
              cols.splice(i, 1);
              if (D.def.sort && D.def.sort.by === c.id) D.def.sort = null;
              if (D.def.chart && D.def.chart.col === c.id) D.def.chart = null;
              changed();
            } }, icon('x'))),
          el('div', { class: 'sub', text: c.calc ? `Calculated: ${calcText(c)}` : `${f ? f.label : c.field}${f && f.hint ? ' — ' + f.hint : ''}${groupedFields.has(c.field) ? ' (shown as its group)' : ''}` }),
          el('div', { class: 'rp-ctl' }, field('Heading', lab), agg ? field('Total as', agg) : null));
      });
      const avail = d.fields.filter((f) => !cols.some((c) => c.field === f.id));
      const add = select([['', 'Add a column…'], ...avail.map((f) => [f.id, f.label])], '', { 'aria-label': 'Add a column' });
      add.addEventListener('change', () => { if (!add.value) return; cols.push({ id: colId(add.value), field: add.value }); changed(); });
      return frag(el('p', { class: 'lead', text: grouped() ? 'Columns are totalled for each group. Pick how each one totals.' : 'One row per record. Order the columns and rename their headings.' }),
        cards.length ? cards : empty('No columns yet.', null, true),
        el('div', { class: 'rp-ctl' }, add, el('button', { class: 'btn tiny', type: 'button', onclick: openCalc }, icon('plus'), 'Calculated column')));
    };
    const openCalc = () => {
      const d = ds();
      const nums = D.def.columns.filter((c) => c.field && (() => { const f = fieldOf(d, c.field); return f && (f.agg || ['count', 'count_distinct', 'count_true'].includes(c.agg)); })());
      const numFields = d.fields.filter((f) => f.agg);
      const refs = [...nums.map((c) => [c.id, `${colLabel(c)} (column)`]), ...numFields.filter((f) => !nums.some((c) => c.field === f.id && c.id === f.id)).map((f) => [f.id, f.label])];
      const dlg = openDialog('Calculated column', 'Worked out in the database from this report’s own columns');
      let kind = 'margin';
      const box = el('div'); const err = el('div');
      const name = input({ placeholder: 'Heading', 'aria-label': 'Heading' });
      const a = select(refs, (refs.find(([v]) => /net|sale|amount/.test(v)) || refs[0] || [''])[0]);
      const b = select(refs, (refs.find(([v]) => /cost/.test(v)) || refs[1] || refs[0] || [''])[0]);
      const expr = input({ placeholder: 'net - cost', 'aria-label': 'Formula', spellcheck: 'false', autocapitalize: 'off' });
      const fmtSel = select([['number', 'Number'], ['money', 'Money'], ['percent', 'Percent']], 'number');
      const drawK = () => {
        box.replaceChildren(seg([['margin', 'Margin %'], ['pct_total', '% of total'], ['expr', 'Formula']], kind, (v) => { kind = v; drawK(); }),
          kind === 'margin' ? frag(field('Sales', a), field('Cost', b), el('p', { class: 'foot', text: '(Sales − cost) ÷ sales, on each row and on the totals.' }))
            : kind === 'pct_total' ? frag(field('Share of', a), el('p', { class: 'foot', text: 'Each row’s share of the grand total.' }))
              : frag(field('Formula', expr, 'Column names, numbers and + − × ÷ with brackets. Tap a name to add it.'),
                el('div', { class: 'rp-ctl' }, refs.map(([v, t]) => el('button', { class: 'btn tiny', type: 'button', onclick: () => { expr.value = `${expr.value}${expr.value && !/[\s(]$/.test(expr.value) ? ' ' : ''}${v}`; expr.focus(); } }, t))),
                field('Show as', fmtSel)),
          field('Heading', name));
      };
      drawK();
      dlg.body.append(box, el('div', { class: 'dlg-acts' }, btn('Add it', () => {
        const calc = kind === 'margin' ? { kind, revenue: a.value, cost: b.value } : kind === 'pct_total' ? { kind, of: a.value } : { kind, expr: expr.value.trim() };
        if (kind === 'expr' && !calc.expr) { err.replaceChildren(resultBox('warning', 'warn', 'Write the formula first', null)); return; }
        D.def.columns.push({ id: colId(kind === 'margin' ? 'margin_pct' : kind === 'pct_total' ? 'share' : 'calc'), calc, label: name.value.trim() || undefined,
          format: kind === 'expr' ? fmtSel.value : 'percent' });
        dlg.close(); changed();
      }, 'primary'), btn('Cancel', () => dlg.close())), err);
    };

    // -- filters
    const stepFilters = () => {
      const d = ds();
      const fl = D.def.filters;
      const cards = fl.map((f, i) => {
        const fd = fieldOf(d, f.field);
        const fsel = select(d.fields.map((x) => [x.id, x.label]), f.field, { 'aria-label': 'Field' });
        fsel.addEventListener('change', () => { const nf = fieldOf(d, fsel.value); fl[i] = { field: nf.id, op: nf.ops[0], ask: f.ask, label: f.ask ? nf.label : undefined }; changed(); });
        const osel = select(fd.ops.map((o) => [o, cat.ops[o]]), f.op, { 'aria-label': 'Test' });
        osel.addEventListener('change', () => { f.op = osel.value; delete f.value; delete f.value2; changed(); });
        const v1 = valueControl(fd, f.op, f.value, cat, d);
        const v2 = f.op === 'between' ? valueControl(fd, f.op, f.value2, cat, d) : null;
        const sync = () => { const a = v1.get(); f.value = a === '' || (Array.isArray(a) && !a.length) ? undefined : a; if (v2) { const b2 = v2.get(); f.value2 = b2 === '' ? undefined : b2; } refresh(); };
        for (const n of [v1.node, v2 && v2.node]) if (n) { n.addEventListener('change', sync); }
        if (f.op === 'relative' && f.value === undefined) f.value = v1.get();
        const ask = el('input', { type: 'checkbox', checked: !!f.ask });
        ask.addEventListener('change', () => { f.ask = ask.checked; f.label = ask.checked ? (f.label || fd.label) : undefined; changed(); });
        return el('div', { class: 'rp-cardl' },
          el('div', { class: 'top' }, el('span', { class: 'nm', text: fd.label }),
            el('button', { class: 'rp-icon', type: 'button', 'aria-label': 'Remove filter', onclick: () => { fl.splice(i, 1); changed(); } }, icon('x'))),
          el('div', { class: 'rp-ctl' }, fsel, osel, v1.node, v2 ? v2.node : null),
          el('label', { class: 'check', style: null }, ask, ' Ask for this when the report runs'),
          f.ask ? field('Prompt', input({ value: f.label || '', 'aria-label': 'Prompt', onchange: (e) => { f.label = e.target.value.trim() || fd.label; } })) : null);
      });
      const add = select([['', 'Add a filter…'], ...d.fields.map((x) => [x.id, x.label])], '', { 'aria-label': 'Add a filter' });
      add.addEventListener('change', () => { if (!add.value) return; const fd = fieldOf(d, add.value); fl.push({ field: fd.id, op: fd.ops[0], ask: fd.type === 'date', label: fd.type === 'date' ? 'Period' : undefined }); changed(); });
      return frag(el('p', { class: 'lead', text: 'Every filter must hold. A filter set to ask is filled in each time the report runs (a period, a store, a range).' }),
        cards.length ? cards : empty('No filters: every record counts.', null, true), el('div', { class: 'rp-ctl' }, add));
    };

    // -- group & totals
    const stepGroup = () => {
      const d = ds();
      const gb = D.def.groupBy;
      const groupable = d.fields.filter((f) => f.type !== 'money');
      const levels = gb.map((g, i) => {
        const fsel = select(groupable.map((f) => [f.id, f.label]), g.field, { 'aria-label': `Group level ${i + 1}` });
        fsel.addEventListener('change', () => { gb[i] = { field: fsel.value }; if (fieldOf(d, fsel.value).type === 'date') gb[i].bucket = 'month'; fixAfterGroup(); changed(); });
        const fd = fieldOf(d, g.field);
        const bsel = fd.type === 'date' ? select(Object.entries(cat.buckets), g.bucket || 'day', { 'aria-label': 'By' }) : null;
        if (bsel) bsel.addEventListener('change', () => { g.bucket = bsel.value; changed(); });
        return el('div', { class: 'rp-cardl' }, el('div', { class: 'top' }, el('span', { class: 'nm', text: `Level ${i + 1}` }),
          el('button', { class: 'rp-icon', type: 'button', 'aria-label': 'Remove level', onclick: () => { gb.splice(i, 1); fixAfterGroup(); changed(); } }, icon('x'))),
          el('div', { class: 'rp-ctl' }, field('Group by', fsel), bsel ? field('By', bsel) : null));
      });
      const add = gb.length < 3 ? select([['', gb.length ? 'Add a level…' : 'Group by…'], ...groupable.map((f) => [f.id, f.label])], '', { 'aria-label': 'Add a group level' }) : null;
      if (add) add.addEventListener('change', () => { if (!add.value) return; const g = { field: add.value }; if (fieldOf(d, add.value).type === 'date') g.bucket = 'month'; gb.push(g); fixAfterGroup(); changed(); });
      const sub = el('input', { type: 'checkbox', checked: !!D.def.subtotals, disabled: gb.length < 2 || null });
      sub.addEventListener('change', () => { D.def.subtotals = sub.checked; changed(); });
      const gt = el('input', { type: 'checkbox', checked: D.def.grandTotal !== false });
      gt.addEventListener('change', () => { D.def.grandTotal = gt.checked; changed(); });
      const sortOpts = [['', 'Natural order'], ...gb.map((g, i) => [`g${i}`, `Level ${i + 1}: ${fieldOf(d, g.field).label}`]),
        ...D.def.columns.filter((c) => !(gb.some((g) => g.field === c.field && !g.bucket))).map((c) => [c.id, colLabel(c)])];
      const sortSel = select(sortOpts, D.def.sort ? D.def.sort.by : '', { 'aria-label': 'Sort by' });
      const dirSel = select([['desc', 'Largest / newest first'], ['asc', 'Smallest / A to Z first']], D.def.sort ? D.def.sort.dir : 'desc', { 'aria-label': 'Direction' });
      const setSort = () => { D.def.sort = sortSel.value ? { by: sortSel.value, dir: dirSel.value } : null; refresh(); };
      sortSel.addEventListener('change', setSort); dirSel.addEventListener('change', setSort);
      const lim = input({ type: 'number', min: '1', max: String(cat.limits.limitMax), value: D.def.limit || '', placeholder: 'All rows', inputmode: 'numeric', 'aria-label': 'Row limit' });
      lim.addEventListener('change', () => { const n = Number(lim.value); D.def.limit = lim.value && n >= 1 ? Math.min(Math.trunc(n), cat.limits.limitMax) : null; refresh(); });
      return frag(el('p', { class: 'lead', text: 'Group rows to total them: up to three levels, dates by day, week, month, quarter or year.' }),
        levels, add ? el('div', { class: 'rp-ctl' }, add) : null,
        el('label', { class: 'check' }, sub, ' Subtotal each group', gb.length < 2 ? el('span', { class: 'hint', text: ' (needs two levels)' }) : null),
        el('label', { class: 'check' }, gt, ' Grand total'),
        el('div', { class: 'rp-ctl' }, field('Sort by', sortSel), field('Direction', dirSel), field('Show at most', lim, 'Top 25 is a sort plus a limit of 25')));
    };
    const fixAfterGroup = () => {
      if (!D.def.groupBy.length) { D.def.chart = null; D.def.subtotals = false; for (const c of D.def.columns) delete c.agg; }
      if (D.def.groupBy.length < 2) D.def.subtotals = false;
      if (D.def.sort && /^g\d$/.test(D.def.sort.by) && Number(D.def.sort.by[1]) >= D.def.groupBy.length) D.def.sort = null;
    };

    // -- chart
    const stepChart = () => {
      if (!grouped()) return frag(el('p', { class: 'lead', text: 'A chart draws one column across the first group level. Group the report first.' }),
        btn('Go to Group & totals', () => { D.step = 'group'; draw(); }));
      const d = ds();
      const nums = D.def.columns.filter((c) => c.calc || (() => { const f = fieldOf(d, c.field); return f && (f.agg || ['count', 'count_distinct', 'count_true'].includes(c.agg)); })())
        .filter((c) => !D.def.groupBy.some((g) => g.field === c.field && !g.bucket));
      const ch = D.def.chart;
      const type = seg([['none', 'No chart'], ['bar', 'Bars'], ['line', 'Line']], ch ? ch.type : 'none', (v) => {
        D.def.chart = v === 'none' || !nums.length ? null : { type: v, col: ch && nums.some((c) => c.id === ch.col) ? ch.col : nums[0].id }; changed();
      });
      const colSel = ch ? select(nums.map((c) => [c.id, colLabel(c)]), ch.col, { 'aria-label': 'Chart this column' }) : null;
      if (colSel) colSel.addEventListener('change', () => { D.def.chart.col = colSel.value; refresh(); });
      return frag(el('p', { class: 'lead', text: `Bars or a line for one column, by ${fieldOf(d, D.def.groupBy[0].field).label.toLowerCase()}. Bars suit stores and people; a line suits months.` }),
        type, colSel ? field('Chart this column', colSel) : null, nums.length ? null : el('p', { class: 'foot', text: 'Add a number column to chart it.' }));
    };

    // -- save
    const stepSave = () => {
      const name = input({ value: D.name, maxlength: '120', 'aria-label': 'Name', oninput: (e) => { D.name = e.target.value; } });
      const desc = el('textarea', { maxlength: '500', 'aria-label': 'Description', oninput: (e) => { D.description = e.target.value; } }, D.description);
      const folder = input({ value: D.folder, maxlength: '60', list: 'rp-folders', 'aria-label': 'Folder', oninput: (e) => { D.folder = e.target.value; } });
      const list = el('datalist', { id: 'rp-folders' }, ['Sales', 'Inventory', 'Purchasing', 'Finance', 'People', 'Operations', 'My reports'].map((f) => el('option', { value: f })));
      const roleBox = el('div');
      const drawRoles = () => roleBox.replaceChildren(D.shared === 'roles' ? el('div', { class: 'panel' }, cat.shareRoles.map((rl) => {
        const b = el('input', { type: 'checkbox', checked: D.shareRoles.includes(rl) });
        b.addEventListener('change', () => { D.shareRoles = b.checked ? [...D.shareRoles, rl] : D.shareRoles.filter((x) => x !== rl); });
        return el('label', { class: 'li check-row' }, b, el('div', { class: 't', text: ROLE_WORD[rl] || rl }));
      })) : '');
      const share = seg([['private', 'Only me'], ['roles', 'Some roles'], ['company', 'Everyone here']], D.shared, (v) => { D.shared = v; draw(); });
      drawRoles();
      const err = el('div');
      const save = async (b, asNew) => {
        busy(b, true, 'Saving…'); err.replaceChildren();
        const body = { name: D.name, description: D.description, folder: D.folder, shared: D.shared, shareRoles: D.shareRoles, definition: D.def };
        try {
          const x = D.id && !asNew ? await post(`/reports/${D.id}`, { ...body, version: D.version }) : await post('/reports', asNew ? { ...body, shared: 'private', name: D.name } : body);
          DRAFTS.delete(key);
          toast(D.id && !asNew ? `Saved as version ${x.version}` : 'Report saved', 'good');
          go('reports', 'r-' + x.id);
        } catch (e) { busy(b, false); err.replaceChildren(resultBox('critical', 'fail', 'Not saved', friendly(e))); }
      };
      return frag(field('Name', name), field('Description', desc, 'What it answers, for whoever opens it next'), field('Folder', folder), list,
        el('div', { class: 'field' }, el('span', { text: 'Who can open it' }), share), roleBox,
        el('p', { class: 'foot', text: 'People it is shared with still see only data their own roles allow. Schedules and emails are set from the report once it is saved.' }),
        el('div', { class: 'dlg-acts' }, btn(D.id ? 'Save changes' : 'Save report', (e) => save(e.currentTarget, false), 'primary', 'ok'),
          D.id ? btn('Save as a new report', (e) => save(e.currentTarget, true)) : null,
          btn('Discard changes', () => { DRAFTS.delete(key); go('reports', D.id ? 'r-' + D.id : ''); })), err);
    };

    draw(); refresh();
    return frag(head(D.id ? `Edit: ${D.name}` : 'New report', [btn('Close', () => go('reports', D.id ? 'r-' + D.id : ''), null, 'x')], 'Reports'),
      el('div', { class: 'rp-two' }, root, section('Preview', null, null, preview)));
  }

  // Pinned reports on Home.
  E.homeCard(async () => {
    if (!S.person || (S.modules && !S.modules.includes('reports'))) return null;
    style();
    const r = await coApi('/reports/pinned');
    if (!r.reports.length) return null;
    return section('Pinned reports', null, null, el('div', { class: 'panel' }, r.reports.map((x) => item({
      title: x.name, detail: [x.folder, x.datasetLabel, x.last_run_at ? `last snapshot ${ago(x.last_run_at)}` : null].filter(Boolean).join(' · '),
      onClick: () => go('reports', 'r-' + x.id) }))));
  });

  // A phone turned sideways or a window resized redraws results as cards or a table.
  NARROW.addEventListener('change', () => { if (S.co && S.route.screen === 'reports' && !document.querySelector('dialog[open]')) render(); });
})();
