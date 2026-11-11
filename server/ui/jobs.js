// Setup, Scheduled jobs (the owner): what runs on its own, when it last ran,
// when it runs next, and how it went for this company. A job opens its recent
// runs; a run opens what it did here; Back returns. textContent only.
(() => {
  'use strict';
  const E = window.ERP;
  const { el, frag, head, section, item, chip, empty, coApi, go, tile, tilesRow, ago } = E;

  const STATUS = { ok: ['good', 'ok', 'OK'], partial: ['warning', 'warn', 'Partly'], failed: ['critical', 'fail', 'Failed'], running: ['neutral', 'clock', 'Running'], never: ['neutral', 'pending', 'Not run yet'] };
  const st = (s) => chip(...(STATUS[s] || STATUS.never));
  const when = (iso) => (iso ? `${new Date(iso).toLocaleString()} (${ago(iso)})` : 'not yet');
  const every = (m) => (m >= 1440 ? `every ${m / 1440 === 1 ? 'day' : `${m / 1440} days`}` : m >= 60 ? `every ${m / 60 === 1 ? 'hour' : `${m / 60} hours`}` : `every ${m} minutes`);
  const back = (label, sub) => el('button', { class: 'btn', type: 'button', onclick: () => go('jobs', sub || null) }, E.icon('chev', 'back'), label);

  async function runScreen(id, job) {
    const r = await coApi(`/admin/jobs/runs/${id}`);
    return frag(head(r.label, [back(job ? 'Back to the job' : 'Back to scheduled jobs', job ? `j:${job}` : null)], `Run of ${new Date(r.started_at).toLocaleString()}`),
      el('div', { class: 'panel' }, item({ title: r.what, detail: `Started ${when(r.started_at)}${r.finished_at ? ` · finished ${new Date(r.finished_at).toLocaleTimeString()}` : ''}`, badge: st(r.status) }),
        r.error ? item({ title: 'Error', detail: r.error }) : null, r.summary ? item({ title: 'For this company', detail: r.summary }) : null),
      section('What it did here', r.items.length ? String(r.items.length) : null, null, r.items.length ? el('div', { class: 'panel' }, r.items.map((x) => item({
        title: x.note, detail: new Date(x.at).toLocaleString(), badge: x.ok ? chip('good', 'ok', 'OK') : chip('critical', 'fail', 'Failed') }))) : empty('Nothing to do for this company in this run', null, true)));
  }

  async function jobScreen(job) {
    const d = await coApi(`/admin/jobs?job=${encodeURIComponent(job)}`);
    const j = d.jobs.find((x) => x.id === job);
    if (!j) return frag(head('Not found', [back('Back to scheduled jobs')]), empty('No such job', null));
    return frag(head(j.label, [back('Back to scheduled jobs')], 'Scheduled jobs'),
      el('div', { class: 'panel' }, item({ title: j.what, detail: `Runs ${every(j.everyMin)} · next ${j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : 'within a minute'}`, badge: st(j.status) })),
      section('Recent runs', String(d.runs.length), null, d.runs.length ? el('div', { class: 'panel' }, d.runs.map((r) => item({
        title: new Date(r.started_at).toLocaleString(), detail: r.error || r.summary || '', badge: st(r.status), onClick: () => go('jobs', `r:${r.id}:${job}`) }))) : empty('No runs yet', null, true)));
  }

  async function screen(sub) {
    if (sub && sub.startsWith('r:')) { const [, id, job] = sub.split(':'); return runScreen(id, job); }
    if (sub && sub.startsWith('j:')) return jobScreen(sub.slice(2));
    const d = await coApi('/admin/jobs');
    if (sub === 'all') return frag(head('All jobs', [back('Back to scheduled jobs')], 'Scheduled jobs'), el('div', { class: 'panel' }, d.jobs.map((j) => item({
      title: j.label, detail: `${j.what} Runs ${every(j.everyMin)}.`, badge: st(j.status), onClick: () => go('jobs', `j:${j.id}`) }))));
    const bad = d.jobs.filter((j) => j.status === 'failed' || j.status === 'partial');
    const lastAny = d.jobs.map((j) => j.lastRunAt).filter(Boolean).sort().pop();
    return frag(head('Scheduled jobs', null, 'Setup'),
      tilesRow(
        tile({ label: 'Jobs', value: String(d.jobs.length), tone: 'neutral', ic: 'clock', text: 'Run on their own by the server', onClick: () => go('jobs', 'all') }),
        tile({ label: 'Need a look', value: String(bad.length), tone: bad.length ? 'critical' : 'good', ic: bad.length ? 'fail' : 'ok', text: bad.length ? bad.map((j) => j.label).join(', ') : 'Every last run went fine',
          onClick: bad.length ? () => go('jobs', `j:${bad[0].id}`) : null }),
        tile({ label: 'Last run', value: lastAny ? ago(lastAny) : 'not yet', word: true, tone: 'neutral', ic: 'refresh' })),
      section('Jobs', null, null, el('div', { class: 'panel' }, d.jobs.map((j) => item({
        title: j.label, detail: `${every(j.everyMin)} · last ${when(j.lastRunAt)} · next ${j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : 'soon'}`,
        why: j.error || null, badge: st(j.status), onClick: () => go('jobs', `j:${j.id}`) })))),
      section('Recent runs', null, null, d.runs.length ? el('div', { class: 'panel' }, E.capped(d.runs.map((r) => item({
        title: `${(d.jobs.find((j) => j.id === r.job) || {}).label || r.job} · ${new Date(r.started_at).toLocaleString()}`, detail: r.error || r.summary || '', badge: st(r.status),
        onClick: () => go('jobs', `r:${r.id}`) })), 10, 'runs')) : empty('No runs yet', 'The server runs due jobs within a minute or two of starting.', true)));
  }

  E.register('jobs', 'Scheduled jobs', 'clock', screen, 'Setup', { module: null });
})();
