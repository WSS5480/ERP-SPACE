// Books, Periods: every month with its status; the month-end checklist, each
// item opening what is behind it; closing a month (anyway, with a reason, when
// the list is not clear); reopening (the owner, with a reason); the year-end
// close to retained earnings and its reopening; and the log of every period
// opened, closed and reopened. Cards and lists only, so it works on a phone;
// every tile and count opens its detail, with Back. textContent only.
(() => {
  'use strict';
  const E = window.ERP;
  const { el, frag, head, section, item, chip, empty, act, post, coApi, plural, money, tile, tilesRow, askReason, openDialog, field, input, resultBox, go, dayLabel } = E;

  const roles = () => (E.S.person && E.S.person.roles) || [];
  const isOwner = () => roles().includes('owner');
  const STATUS = { open: ['good', 'ok', 'Open'], soft_locked: ['neutral', 'pause', 'Soft-locked'], closed: ['neutral', 'hold', 'Closed'] };
  const statusChip = (s) => chip(...(STATUS[s] || STATUS.open));
  const btn = (label, onclick, primary) => el('button', { class: 'btn small' + (primary ? ' primary' : ''), type: 'button', onclick }, label);
  const backBtn = (label, to) => el('button', { class: 'btn', type: 'button', onclick: () => go('periods', to || null) }, E.icon('chev', 'back'), label);
  const SCREEN_LABEL = { payables: 'Payables', pos: 'Point of sale', recon: 'Reconcile', inventory: 'Inventory', salestax: 'Sales tax', settlements: 'Finance settlements', group: 'Group', books: 'Books' };
  const EVENT = { auto_opened: 'Opened on its own', opened: 'Opened by hand', closed: 'Closed', reopened: 'Reopened', year_closed: 'Year closed', year_reopened: 'Year reopened' };

  /** The rows behind one checklist item, each a line with its figure on the right. */
  function rowsOf(x) {
    const rows = x.rows || [];
    if (!rows.length) return empty('Nothing behind this item', x.ok ? 'It is clear.' : x.detail, true);
    return el('div', { class: 'panel' }, rows.map((r) => {
      if (r.kind === 'bill') return item({ title: `${r.vendor || 'Bill'} ${r.number || ''}`.trim(), detail: `${dayLabel(r.invoice_date)} · ${r.status}`, amount: money(r.total_minor), onClick: () => E.go('payables') });
      if (r.kind === 'payroll') return item({ title: 'Payroll run', detail: `Pays ${dayLabel(r.pay_date)} · ${r.status.replace(/_/g, ' ')}`, amount: money(r.net_minor), onClick: () => E.go('payroll') });
      if (r.opened_at) return item({ title: `Drawer ${r.number}`, detail: `${r.store} · opened ${new Date(r.opened_at).toLocaleString()}`, onClick: () => E.go('pos') });
      if (r.posted_on) return item({ title: r.description || 'Bank line', detail: `${r.account} · ${dayLabel(r.posted_on)}`, amount: money(r.amount_minor), onClick: () => E.go('recon') });
      return item({ title: r.account ? `Account ${r.account}` : x.label, detail: r.detail || x.detail, onClick: () => E.go(x.screen) });
    }));
  }

  /** One checklist item in full: what it found, the rows, and the screen that fixes it. Back goes to the month. */
  async function itemScreen(periodId, itemId) {
    const d = await coApi(`/books/periods/${periodId}/checklist`);
    const x = d.items.find((i) => i.id === itemId);
    if (!x) return frag(head('Not found', [backBtn('Back to the month', `p:${periodId}`)], 'Periods'), empty('That checklist item is not here', null));
    return frag(
      head(x.label, [backBtn(`Back to ${d.period.label}`, `p:${periodId}`)], `${d.period.label} · checklist`),
      el('div', { class: 'panel' }, item({ title: x.ok ? 'Clear' : 'Needs attention', detail: x.detail, badge: x.ok ? chip('good', 'ok', 'Clear') : chip('warning', 'warn', plural(x.count, 'item')) })),
      section('What is behind it', x.rows && x.rows.length ? String(x.rows.length) : null, [btn(`Open ${SCREEN_LABEL[x.screen] || x.screen}`, () => E.go(x.screen), true)], rowsOf(x)));
  }

  /** One month: its status, the checklist (each item opens its detail), and close or reopen. */
  async function monthScreen(periodId) {
    const d = await coApi(`/books/periods/${periodId}/checklist`);
    const p = d.period;
    const open = d.items.filter((x) => !x.ok);
    const acts = [];
    if (p.status !== 'closed') {
      acts.push(btn('Close the month', async (e) => {
        const b = e.currentTarget;
        let body = {};
        if (open.length) {
          const why = await askReason({ title: `Close ${p.label} anyway`, lead: `${plural(open.length, 'item')} on the checklist ${open.length === 1 ? 'is' : 'are'} not clear. Closing anyway is recorded with your reason.`, label: 'Why it is fine to close', confirm: 'Close anyway' });
          if (!why) return;
          body = { override: true, reason: why };
        }
        act(b, () => post(`/books/periods/${periodId}/close`, body), `${p.label} closed`).then(() => E.render());
      }, true));
    } else if (isOwner()) {
      acts.push(btn('Reopen', async (e) => {
        const b = e.currentTarget;
        const yc = d.yearClose;
        const lead = yc
          ? `${p.label} is in the year ${yc.fyStart} to ${yc.fyEnd}, which is closed. Reopening it reverses that year's closing entry: the year's income and expenses come back out of retained earnings, and ${p.label} and ${yc.lastMonth} stay open until you close the year again. Postings dated in ${p.label} are allowed again.`
          : 'Postings dated in the month are allowed again until it closes.';
        const why = await askReason({ title: `Reopen ${p.label}`, lead, label: 'Why it is being reopened', confirm: yc ? 'Reopen, and reverse the year close' : 'Reopen' });
        if (why) act(b, () => post(`/books/periods/${periodId}/reopen`, { reason: why }), `${p.label} reopened`).then(() => E.render());
      }));
    }
    return frag(
      head(p.label, [backBtn('Back to periods')], `Periods · ${p.starts_on} to ${p.ends_on}`),
      tilesRow(
        tile({ label: 'Status', value: (STATUS[p.status] || STATUS.open)[2], tone: p.status === 'closed' ? 'neutral' : 'good', ic: p.status === 'closed' ? 'hold' : 'ok' }),
        tile({ label: 'Checklist', value: open.length ? plural(open.length, 'item') : 'Clear', tone: open.length ? 'warning' : 'good', ic: open.length ? 'warn' : 'ok',
          text: open.length ? 'Tap an item below to see what is behind it' : 'Nothing stands in the way of closing' })),
      acts.length ? el('div', { class: 'row-acts' }, acts) : null,
      section('Before closing', `${d.items.length - open.length} of ${d.items.length} clear`, null, el('div', { class: 'panel' }, d.items.map((x) => item({
        title: x.label, detail: x.detail, badge: x.ok ? chip('good', 'ok', 'Clear') : chip('warning', 'warn', x.count > 1 ? String(x.count) : 'Check', true),
        onClick: () => go('periods', `i:${periodId}:${x.id}`) })))));
  }

  /** The months behind a tile: open ones or closed ones. Back to the list. */
  function filtered(d, which) {
    const l = d.periods.filter((p) => (which === 'closed' ? p.status === 'closed' : p.status !== 'closed'));
    return frag(head(which === 'closed' ? 'Closed months' : 'Open months', [backBtn('Back to periods')], 'Periods'),
      l.length ? el('div', { class: 'panel' }, l.map(periodItem)) : empty(which === 'closed' ? 'No month is closed yet' : 'No month is open', null));
  }

  const periodItem = (p) => item({ title: p.label + (p.current ? ' · this month' : ''), detail: `${p.starts_on} to ${p.ends_on}${p.closed_reason ? ` · ${p.closed_reason}` : ''}`,
    amount: plural(p.entries, 'entry', 'entries'), badge: statusChip(p.status), onClick: () => go('periods', `p:${p.id}`) });

  function openMonthDialog() {
    const d = openDialog('Open a month', 'A past month, or one further ahead than months open on their own');
    const f = { month: input({ type: 'month' }), reason: input({ maxlength: '300', placeholder: 'For example: a late bill from last year' }) };
    const err = el('div', { role: 'alert' });
    d.body.append(el('div', { class: 'form-grid' }, field('Month', f.month), field('Why', f.reason, null, true)), err,
      el('div', { class: 'dlg-acts' }, el('button', { class: 'btn', type: 'button', onclick: d.close }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'button', onclick: (e) => act(e.currentTarget, () => post('/books/periods/open', { month: f.month.value, reason: f.reason.value }), 'Month opened',
          { close: d.close, errorInto: (x) => err.replaceChildren(resultBox('critical', 'fail', 'Not opened', E.friendly(x))) }).then(() => E.render()) }, 'Open it')));
  }

  function yearsSection(d) {
    const fy = d.fiscalYear;
    // the last fiscal year that has ended
    const lastEnd = (() => { const y = Number(fy.start.slice(0, 4)), m = Number(fy.start.slice(5, 7)); const end = new Date(Date.UTC(y, m - 1, 0)); return end.toISOString().slice(0, 10); })();
    const live = d.years.find((y) => y.status === 'closed' && y.fy_end === lastEnd);
    const acts = live ? [] : [btn(`Close the year ending ${lastEnd}`, async (e) => {
      const b = e.currentTarget;
      const why = await askReason({ title: 'Close the year', lead: `Every income and expense balance for the year ending ${lastEnd} moves to retained earnings in one closing entry, and its months close. If a month's checklist is not clear, your reason is recorded.`, label: 'Note (needed if a checklist is not clear)', confirm: 'Close the year', optional: true });
      if (why === null || why === undefined) return;
      act(b, () => post('/books/years/close', { fyEnd: lastEnd, override: !!why, reason: why || '' }), (r) => r.already ? 'That year was already closed' : `Year closed: ${money(r.netIncomeMinor)} to retained earnings`).then(() => E.render());
    }, true)];
    return section('Year-end', `This fiscal year: ${fy.start} to ${fy.end}`, acts, d.years.length ? el('div', { class: 'panel' }, d.years.map((y) => item({
      title: `Year ending ${y.fy_end}`, detail: `${y.status === 'closed' ? 'Closed' : 'Reopened'} by ${y.closed_by} · ${new Date(y.closed_at).toLocaleDateString()}`,
      amount: money(y.net_income_minor), badge: statusChip(y.status === 'closed' ? 'closed' : 'open'),
      onClick: y.journal_entry_id ? () => E.openEntry(y.journal_entry_id) : null,
      acts: y.status === 'closed' && isOwner() ? [btn('Reopen', async (e) => {
        const b = e.currentTarget;
        const why = await askReason({ title: `Reopen the year ending ${y.fy_end}`, lead: `The closing entry is reversed: the year's income and expenses come back out of retained earnings. Its months stay closed except the last (${y.fy_end.slice(0, 7)}), which stays open until you close the year again.`, label: 'Why', confirm: 'Reopen the year' });
        if (why) act(b, () => post('/books/years/reopen', { fyEnd: y.fy_end, reason: why }), 'Year reopened').then(() => E.render());
      })] : null }))) : empty('No year closed yet', 'Close a year once it has ended and its months are done.', true));
  }

  async function screen(sub) {
    if (sub && sub.startsWith('p:')) return monthScreen(sub.slice(2));
    if (sub && sub.startsWith('i:')) { const [, pid, iid] = sub.split(':'); return itemScreen(pid, iid); }
    const d = await coApi('/books/periods');
    if (sub === 'open' || sub === 'closed') return filtered(d, sub);
    if (sub === 'log') return frag(head('Period log', [backBtn('Back to periods')], 'Periods'),
      d.events.length ? el('div', { class: 'panel' }, d.events.map((x) => item({ title: `${EVENT[x.kind] || x.kind}: ${x.starts_on} to ${x.ends_on}`, detail: `${x.by_label} · ${new Date(x.at).toLocaleString()}${x.reason ? ` · ${x.reason}` : ''}` }))) : empty('Nothing logged yet', null));
    const current = d.periods.find((p) => p.current);
    return frag(
      head('Periods', [el('button', { class: 'btn', type: 'button', onclick: () => E.go('books') }, E.icon('chev', 'back'), 'Books'),
        el('button', { class: 'btn', type: 'button', onclick: openMonthDialog }, E.icon('plus'), 'Open a month')], `Books · business date ${d.today}`),
      tilesRow(
        tile({ label: 'Open months', value: String(d.counts.open), tone: 'good', ic: 'ok', text: 'Months that take postings', onClick: () => go('periods', 'open') }),
        tile({ label: 'Closed months', value: String(d.counts.closed), tone: 'neutral', ic: 'hold', text: 'Closed after the checklist', onClick: () => go('periods', 'closed') }),
        current ? tile({ label: 'This month', value: current.label, tone: 'neutral', ic: 'clock', text: plural(current.entries, 'entry', 'entries'), onClick: () => go('periods', `p:${current.id}`) }) : null,
        tile({ label: 'Log', value: String(d.events.length), tone: 'neutral', ic: 'file', text: 'Opened, closed, reopened', onClick: () => go('periods', 'log') })),
      el('p', { class: 'foot', text: 'Months open on their own up to two months ahead and within this fiscal year, and three months ahead are kept open every day. A closed month refuses postings until the owner reopens it.' }),
      section('Months', plural(d.periods.length, 'month'), null, d.periods.length ? el('div', { class: 'panel' }, E.capped(d.periods.map(periodItem), 8, 'months')) : empty('No periods yet', null)),
      yearsSection(d));
  }

  E.register('periods', 'Periods', 'book', screen, 'Back office', { module: null });
})();
