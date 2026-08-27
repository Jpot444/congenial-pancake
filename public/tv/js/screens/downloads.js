/*
 * Downloads — what the box has fetched, and what it is fetching now.
 *
 * The two-step rule this screen exists to make legible: a download onto the
 * box is a CACHE, not an offline copy. Reaching it still means reaching the
 * Pi. "Save to device" is the second step, and the only one that survives
 * airplane mode. The screen says so rather than letting the word "downloaded"
 * imply something it does not mean.
 *
 * One at a time is the box's rule, not a nicety — the account allows a single
 * connection, and a download pauses itself while anyone is watching.
 */

import { el, clear, gb, rate, pct } from '../ui.js';
import { getDownloads, pauseDownload, retryDownload } from '../api.js';
import { state, refreshHealth } from '../state.js';

let jobs = [];
let free = null;
let queued = 0;

export async function render(host, app) {
  let data;
  try {
    data = await getDownloads();
  } catch (err) {
    clear(host).append(el('div', 'empty', `Downloads did not load: ${err.message}`));
    return;
  }
  jobs = data.items || [];
  free = data.freeBytes;
  queued = data.queued || 0;

  const root = el('div', 'downloads');
  root.append(head());
  root.append(actions());
  root.append(jobList());
  clear(host).append(root);
}

function head() {
  const wrap = el('div', 'dl-head');
  const left = el('div');
  left.style.minWidth = '0';
  left.append(el('div', 'eyebrow', 'DOWNLOADS · ON THE BOX'));
  left.append(el('div', 'page-title', 'One at a time'));
  left.append(el('div', 'dl-blurb',
    'The box copy is a cache, not an offline copy — reaching it still means reaching the Pi. '
    + 'Save to device is the step that survives airplane mode.'));
  wrap.append(left);

  const facts = el('div', 'dl-facts');
  const prefs = state.prefs || {};
  const limit = prefs.downloadLimit;
  facts.append(el('span', null, Number.isFinite(limit)
    ? `Allowance · ${gb(prefs.downloadUsed || 0)} of ${gb(limit)} used`
    : 'Allowance · no limit for this profile'));
  facts.append(el('span', null, free === null || free === undefined
    ? 'Free space unknown · floor 2 GB'
    : `Free space ${gb(free)} · floor 2 GB`));
  wrap.append(facts);
  return wrap;
}

function actions() {
  const row = el('div', 'dl-actions rowblock');
  const paused = jobs.filter((j) => j.status === 'paused' || j.status === 'error').length;

  const resume = el('div', 'action-pill primary');
  resume.dataset.r = 1;
  resume.dataset.c = 0;
  resume.dataset.kind = 'resumeall';
  resume.dataset.lift = 'none';
  resume.textContent = paused ? `RESUME ALL · ${paused} STOPPED` : 'NOTHING TO RESUME';
  row.append(resume);

  const health = el('div', 'action-pill');
  health.dataset.r = 1;
  health.dataset.c = 1;
  health.dataset.kind = 'health';
  health.dataset.lift = 'none';
  health.textContent = 'PI HEALTH';
  row.append(health);
  return row;
}

function jobList() {
  const list = el('div', 'episodes');
  if (!jobs.length) {
    list.append(el('div', 'empty',
      'Nothing downloaded yet. Open a film or a season and choose Download.'));
    return list;
  }

  jobs.forEach((job, i) => {
    const row = el('div', 'job rowblock');
    row.dataset.r = 2 + i;
    row.dataset.c = 0;
    row.dataset.kind = 'job';
    row.dataset.lift = 'none';
    row._job = job;

    row.append(el('span', 'job-tag', tagFor(job)));

    const mid = el('div', 'job-mid');
    const line = el('div', 'job-line');
    line.append(el('span', 'job-name', job.name));
    line.append(el('span', 'job-size', job.total ? gb(job.total) : ''));
    mid.append(line);

    const track = el('span', 'bar');
    const fill = el('span', toneFor(job));
    fill.style.width = `${job.status === 'done' ? 100 : pct(job.bytes, job.total)}%`;
    track.append(fill);
    mid.append(track);
    row.append(mid);

    const status = el('span', `job-state ${stateClass(job)}`, stateText(job));
    row.append(status);
    row.append(el('span', 'job-action', actionFor(job)));
    list.append(row);
  });
  return list;
}

const tagFor = (job) => (job.kind === 'series'
  ? `S${String(job.season || 0).padStart(2, '0')}`
  : (job.archivePath ? 'DISK' : 'FILM'));

function toneFor(job) {
  if (job.status === 'done') return 'ready';
  if (job.status === 'paused') return 'paused';
  if (job.status === 'error') return 'failed';
  return 'run';
}

function stateClass(job) {
  if (job.status === 'done') return 'state-ready';
  if (job.status === 'paused') return 'state-paused';
  if (job.status === 'error') return 'state-failed';
  return 'state-run';
}

function stateText(job) {
  switch (job.status) {
    case 'done':
      return job.preparing ? 'Converting to MP4…' : 'Ready · plays off local disk';
    case 'downloading':
      return `${gb(job.bytes)} of ${gb(job.total)}${job.bytesPerSec ? ` · ${rate(job.bytesPerSec)}` : ''}`;
    case 'paused':
      return job.autoPaused
        ? 'Paused while somebody is watching'
        : 'Paused · resumes at byte offset';
    case 'queued':
      return 'Queued · one at a time';
    case 'error':
      return `Failed · ${job.error || 'no reason given'}`;
    default:
      return job.status;
  }
}

const actionFor = (job) => ({
  done: 'PLAY · OK',
  downloading: 'PAUSE · OK',
  paused: 'RESUME · OK',
  queued: 'PAUSE · OK',
  error: 'RETRY · OK',
}[job.status] || '');

/* -------------------------------------------------------------- remote ── */

export async function activate(node, app) {
  const kind = node.dataset.kind;

  if (kind === 'resumeall') {
    const stopped = jobs.filter((j) => j.status === 'paused' || j.status === 'error');
    if (!stopped.length) { app.toast('Nothing is paused.'); return; }
    for (const job of stopped) {
      // eslint-disable-next-line no-await-in-loop
      await retryDownload(job.id).catch(() => {});
    }
    app.toast(`Woke ${stopped.length} download${stopped.length === 1 ? '' : 's'}. The box still takes them one at a time.`);
    app.refresh();
    return;
  }

  if (kind === 'health') {
    const health = await refreshHealth();
    if (!health) { app.toast('The box did not answer.'); return; }
    const temp = health.cpu && Number.isFinite(health.cpu.tempC) ? `${Math.round(health.cpu.tempC)}°C` : '—';
    const disk = health.disk ? gb(health.disk.free) : '—';
    const net = health.network ? `${health.network.kind}${health.network.level ? ` · ${health.network.level}` : ''}` : '—';
    app.toast(`Pi · ${temp} · ${disk} free · network ${net}${queued ? ` · ${queued} queued` : ''}`);
    return;
  }

  if (kind !== 'job') return;
  const job = node._job;

  if (job.status === 'done') {
    app.go('vod', {
      kind: 'download',
      id: job.id,
      title: job.name,
      sub: gb(job.total),
      eyebrow: 'ON THE BOX',
      resumeKey: job.resumeKey || '',
      historyKind: job.kind === 'series' ? 'series' : 'movie',
      seriesId: job.seriesId || undefined,
      season: job.season || undefined,
      episode: job.episode || undefined,
      from: 'downloads',
    });
    return;
  }

  try {
    if (job.status === 'downloading' || job.status === 'queued') {
      await pauseDownload(job.id);
      app.toast(`Paused “${job.name}”. The bytes so far stay on the box.`);
    } else {
      await retryDownload(job.id);
      app.toast(`Resuming “${job.name}” from where it stopped.`);
    }
  } catch (err) {
    app.toast(err.message);
  }
  app.refresh();
}
