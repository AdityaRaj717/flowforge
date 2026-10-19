import type { Asset, ErrorCode, Job, OutputFile, Queue, ReferenceRef } from '@flowforge/core';
import {
  ACTIVE_STATES, MODE_OUTPUT, decideAfterFailure, dedupePath, extForMime, interJobDelayMs, isTerminal,
  renderFilename, requeue, transition, uid, verifyOutputs,
} from '@flowforge/core';
import type { CollectedOutput, FromWorker, RefPayload, RunSettings } from '../shared/messages';
import { blobToB64, b64ToBlob, put as dbPut } from '../shared/db';
import { loadSettings, loadTaught } from '../shared/settings';
import { consumeQuota, currentPack, license, quota } from './entitlement';
import { dataUrl, download } from './downloads';
import { announce, getAsset, getBlob, jobsOf, load, log, saveAsset, saveJob, saveQueue, state } from './store';
import { idleWorkers, onWorkerGone, onWorkerMessage, sendTo, tickAll, workers, type Worker } from './workers';

// The scheduler. Rules it keeps:
//  - a job is persisted in its new state before anything irreversible happens;
//  - nothing is resubmitted automatically once Flow may have accepted it, unless the failure
//    clearly came back from Flow (then the retry policy decides);
//  - anything that smells like anti-abuse (captcha, unusual activity, sign-in) pauses the queue
//    for the person instead of being retried.

const lastSubmitAt = new Map<string, number>(); // queueId -> ts
const nextAllowedAt = new Map<string, number>(); // queueId -> ts (inter-job delay)
const consecutiveFailures = new Map<string, number>();
const orphanGraceUntil = { t: 0 };
// Jobs this service-worker instance is verifying or downloading right now. Anything else found in
// those states was interrupted by a restart.
const inProcess = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export type PostProcessFn = (jobId: string, op: 'merge', files: string[], output: string) => Promise<{ ok: boolean; savedPath?: string; message?: string }>;
let postProcess: PostProcessFn | null = null;
export function setPostProcessor(fn: PostProcessFn | null) {
  postProcess = fn;
}

export function init() {
  // After a service-worker restart, give content scripts a moment to reconnect and claim the
  // jobs they are still running before any of them is treated as lost.
  orphanGraceUntil.t = Date.now() + 12_000;
  onWorkerMessage(handleWorkerMessage);
  onWorkerGone(handleWorkerGone);
  ensureTimer();
}

export function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => void tick(), 2000);
}

function anyRunning(): boolean {
  return [...state.queues.values()].some((q) => q.status === 'running' || q.status === 'stopping') ||
    [...state.jobs.values()].some((j) => ACTIVE_STATES.includes(j.state));
}

async function setJob(j: Job, to: Job['state'], note?: string, patch: Partial<Job> = {}): Promise<Job> {
  const next = { ...transition(j, to, note), ...patch };
  await saveJob(next);
  return next;
}

// ---------- queue controls ----------

export async function control(queueId: string, action: 'start' | 'pause' | 'resume' | 'stop') {
  const q = state.queues.get(queueId);
  if (!q) throw new Error('Queue not found.');
  if (action === 'start' || action === 'resume') {
    const lic = await license();
    if (!lic.limits.multiQueue) {
      const other = [...state.queues.values()].find((x) => x.id !== q.id && x.status === 'running');
      if (other) throw new Error(`The ${lic.limits.label} plan runs one queue at a time ("${other.name}" is running).`);
    }
    // Jobs paused or waiting on the person go back in line.
    for (const j of jobsOf(queueId)) {
      if (j.state === 'paused' || j.state === 'waiting_for_user' || j.state === 'waiting_for_flow') await setJob(j, 'queued', 'resumed');
    }
    q.status = 'running';
    q.pausedReason = undefined;
    consecutiveFailures.set(q.id, 0);
    await saveQueue(q);
    await log('info', 'queue', `Queue "${q.name}" ${action === 'start' ? 'started' : 'resumed'}.`, { queueId });
  } else if (action === 'pause') {
    await pauseQueue(q, 'Paused by you. Jobs already generating will finish.');
  } else {
    q.status = 'stopping';
    await saveQueue(q);
    for (const j of jobsOf(queueId)) {
      if (j.state === 'queued' || j.state === 'retry_wait' || j.state === 'blocked') await setJob(j, 'paused', 'queue stopped');
      else if (ACTIVE_STATES.includes(j.state) && j.state !== 'downloading' && j.state !== 'verifying') await requestCancel(j);
    }
    q.status = 'idle';
    await saveQueue(q);
    await log('info', 'queue', `Queue "${q.name}" stopped.`, { queueId });
  }
  ensureTimer();
  void tick();
}

async function pauseQueue(q: Queue, reason: string) {
  q.status = 'paused';
  q.pausedReason = reason;
  await saveQueue(q);
  for (const j of jobsOf(q.id)) {
    if (j.state === 'queued' || j.state === 'retry_wait') await setJob(j, 'paused', reason);
  }
  await log('warn', 'queue', `Queue "${q.name}" paused: ${reason}`, { queueId: q.id });
  notify('Queue paused', `${q.name}: ${reason}`);
}

async function requestCancel(j: Job) {
  const w = j.workerTabId ? workers.get(j.workerTabId) : undefined;
  if (w) sendTo(w, { t: 'cancel', jobId: j.id });
  if (j.state === 'preparing' || j.state === 'submitting' || j.state === 'generating') await setJob(j, 'cancel_requested', 'cancel requested');
  if (!w) await setJob(state.jobs.get(j.id)!, 'cancelled', 'no worker');
}

export async function cancelJob(jobId: string) {
  const j = state.jobs.get(jobId);
  if (!j || isTerminal(j.state)) return;
  if (ACTIVE_STATES.includes(j.state)) return requestCancel(j);
  await setJob(j, 'cancelled', 'cancelled by you');
}

export async function retryJobs(ids: string[]) {
  for (const id of ids) {
    const j = state.jobs.get(id);
    if (!j || ACTIVE_STATES.includes(j.state)) continue;
    if (j.state === 'download_failed') {
      await redownload(id);
      continue;
    }
    const n = requeue(j);
    await saveJob(n);
  }
  void tick();
}

// ---------- scheduling ----------

export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    tickAll();
    const now = Date.now();
    await recoverStale(now);
    for (const q of state.queues.values()) {
      if (q.status !== 'running') continue;
      await scheduleQueue(q, now);
    }
    if (!anyRunning() && timer) {
      clearInterval(timer);
      timer = null;
    }
  } catch (e) {
    await log('error', 'engine', `Scheduler error: ${(e as Error).message}`);
  } finally {
    ticking = false;
  }
}

function depsState(j: Job): 'ok' | 'wait' | 'failed' {
  if (!j.dependsOn?.length) return 'ok';
  for (const id of j.dependsOn) {
    const d = state.jobs.get(id);
    if (!d) return 'failed';
    if (d.state === 'succeeded') continue;
    if (isTerminal(d.state)) return 'failed';
    return 'wait';
  }
  return 'ok';
}

async function scheduleQueue(q: Queue, now: number) {
  const jobs = jobsOf(q.id);
  for (const j of jobs) {
    if (j.state === 'retry_wait' && (j.nextRetryAt ?? 0) <= now) await setJob(j, 'queued', 'retry due');
    if (j.state === 'blocked' && depsState(j) === 'ok') await setJob(j, 'queued', 'dependency ready');
  }
  const lic = await license();
  const active = jobs.filter((j) => ACTIVE_STATES.includes(j.state)).length;
  const limit = Math.min(q.settings.concurrency, lic.limits.maxConcurrency);
  if (active >= limit) return;
  if ((nextAllowedAt.get(q.id) ?? 0) > now) return;

  const fresh = jobsOf(q.id);
  // Merge steps wait silently for the local agent instead of churning between states.
  const next = fresh.find((j) => j.state === 'queued' && !(j.vars?.op === 'merge' && !postProcess));
  if (!next) {
    const left = fresh.filter((j) => !isTerminal(j.state)).length;
    if (left === 0 && active === 0) await finishQueue(q, fresh);
    return;
  }
  const dep = depsState(next);
  if (dep === 'failed') {
    await failJob(next, 'DEPENDENCY_FAILED', 'A job this one depends on did not succeed.', false);
    return;
  }
  if (dep === 'wait') {
    await setJob(next, 'blocked', 'waiting for dependency');
    return;
  }

  if (next.vars?.op === 'merge') return runMerge(q, next);

  const qta = await quota();
  if (qta.remaining !== null && qta.remaining <= 0) {
    await pauseQueue(q, `Daily ${lic.limits.label} limit of ${qta.limit} jobs reached. It resets at ${new Date(qta.resetsAt).toLocaleTimeString()}.`);
    return;
  }

  const worker = idleWorkers().find((w) => !fresh.some((j) => j.workerTabId === w.tabId && ACTIVE_STATES.includes(j.state)));
  if (!worker) {
    if (!workers.size && next.state === 'queued') {
      await setJob(next, 'waiting_for_flow', 'no Flow tab connected');
      notifyOnce('noflow', 'Open Google Flow', 'FlowForge needs a signed-in Google Flow tab to run your queue.');
    }
    return;
  }
  await dispatch(q, next, worker);
}

async function finishQueue(q: Queue, jobs: Job[]) {
  q.status = 'idle';
  await saveQueue(q);
  const ok = jobs.filter((j) => j.state === 'succeeded').length;
  const bad = jobs.length - ok;
  await log('info', 'queue', `Queue "${q.name}" finished: ${ok} done, ${bad} not done.`, { queueId: q.id });
  if (q.settings.notifyOnFinish) notify('Queue finished', `${q.name}: ${ok} done${bad ? `, ${bad} need attention` : ''}.`);
}

async function resolveRefs(j: Job): Promise<RefPayload[]> {
  const out: RefPayload[] = [];
  for (const r of j.options.references ?? []) {
    const blob = await refBlob(r);
    if (!blob) throw Object.assign(new Error(`Reference ${r.assetId} is missing.`), { code: 'ASSET_MISSING' as ErrorCode });
    out.push({ role: r.role, name: `${r.role}_${out.length + 1}${extForMime(blob.type)}`, mime: blob.type || 'image/png', dataB64: await blobToB64(blob) });
  }
  // Frames first: Flow and the instruction text both read attachments in order.
  const rank: Record<string, number> = { source: 0, start: 1, end: 2, character: 3, ingredient: 4, style: 5 };
  return out.sort((a, b) => rank[a.role] - rank[b.role]);
}

async function refBlob(r: ReferenceRef): Promise<Blob | undefined> {
  let m = /^job:([^#]+)#(\d+)$/.exec(r.assetId);
  if (m) {
    const src = state.jobs.get(m[1]);
    const o = src?.outputs[Number(m[2]) - 1] ?? src?.outputs[0];
    return o ? getBlob(`out:${o.id}`) : undefined;
  }
  m = /^lastframe:(.+)$/.exec(r.assetId);
  if (m) {
    const src = state.jobs.get(m[1]);
    const id = src?.outputs.find((o) => o.lastFrameAssetId)?.lastFrameAssetId;
    if (!id) return undefined;
    const a = await getAsset(id);
    return a ? getBlob(a.blobKey) : undefined;
  }
  const a = await getAsset(r.assetId);
  return a ? getBlob(a.blobKey) : undefined;
}

function needsLastFrame(j: Job): boolean {
  return [...state.jobs.values()].some((x) => x.options.references?.some((r) => r.assetId === `lastframe:${j.id}`));
}

function needsOutputBlobs(j: Job): boolean {
  return [...state.jobs.values()].some((x) => x.options.references?.some((r) => r.assetId.startsWith(`job:${j.id}#`)));
}

async function dispatch(q: Queue, j: Job, w: Worker) {
  const settings = await loadSettings();
  let refs: RefPayload[];
  try {
    refs = await resolveRefs(j);
  } catch (e) {
    await failJob(j, ((e as { code?: ErrorCode }).code ?? 'ASSET_MISSING'), (e as Error).message, false);
    return;
  }
  const isVideo = MODE_OUTPUT[j.mode] === 'video';
  const run: RunSettings = {
    freshSession: settings.freshSessionPerJob,
    autoApprove: settings.autoApproveAgent,
    optionStrategy: settings.optionStrategy,
    timeoutSec: q.settings.generationTimeoutSec,
    settleSec: settings.settleSec,
    extractLastFrame: isVideo && (settings.extractLastFrames === 'always' || (settings.extractLastFrames === 'chains' && needsLastFrame(j))),
  };
  const leased = await setJob(j, 'preparing', `tab ${w.tabId}`, {
    attempts: j.attempts + 1,
    workerTabId: w.tabId,
    leaseUntil: Date.now() + (q.settings.generationTimeoutSec + 180) * 1000,
    error: undefined,
  });
  w.busyJobId = j.id;
  const ok = sendTo(w, { t: 'run', job: leased, settings: run, refs, pack: await currentPack(), taught: await loadTaught() });
  if (!ok) {
    w.busyJobId = undefined;
    await setJob(leased, 'queued', 'worker vanished before start', { attempts: j.attempts });
    return;
  }
  lastSubmitAt.set(q.id, Date.now());
  nextAllowedAt.set(q.id, Date.now() + interJobDelayMs(q.settings));
  await log('info', 'job', `Started #${j.index}: ${j.name ?? j.prompt.slice(0, 80)}`, { jobId: j.id, queueId: q.id });
}

// ---------- worker events ----------

async function handleWorkerMessage(w: Worker, m: FromWorker) {
  await load();
  if (m.t === 'hello' && m.busyJobId) {
    const j = state.jobs.get(m.busyJobId);
    if (j && ACTIVE_STATES.includes(j.state)) {
      await saveJob({ ...j, workerTabId: w.tabId });
      await log('info', 'engine', `Reattached to running job #${j.index} in tab ${w.tabId}.`, { jobId: j.id });
    }
    return;
  }
  if (m.t === 'page') {
    if (m.page === 'ready') {
      // A Flow tab became usable: release jobs that were waiting for one.
      for (const j of state.jobs.values()) {
        if (j.state === 'waiting_for_flow' && state.queues.get(j.queueId)?.status === 'running') await setJob(j, 'queued', 'Flow tab ready');
      }
      ensureTimer();
    }
    return;
  }
  if (m.t === 'progress') {
    const j = state.jobs.get(m.jobId);
    if (!j || isTerminal(j.state) || j.state === 'cancel_requested') return;
    if (m.state !== j.state && canMove(j, m.state)) {
      await setJob(j, m.state, m.note);
      if (m.state === 'generating' && j.state === 'submitting') await consumeQuota();
    } else if (m.note) {
      await saveJob({ ...j, history: [...j.history, { from: j.state, to: j.state, at: Date.now(), note: m.note }].slice(-60), updatedAt: Date.now() });
    }
    return;
  }
  if (m.t === 'result') {
    w.busyJobId = undefined;
    inProcess.add(m.jobId);
    try {
      await onResult(m.jobId, m.outputs, m.notes);
    } finally {
      inProcess.delete(m.jobId);
    }
    void tick();
    return;
  }
  if (m.t === 'failure') {
    w.busyJobId = undefined;
    const j = state.jobs.get(m.jobId);
    if (!j) return;
    if (j.state === 'submitting' && m.submitted) await consumeQuota();
    if (j.state === 'cancel_requested' || m.code === 'CANCELLED') {
      const asked = j.state === 'cancel_requested' ? j : canMove(j, 'cancel_requested') ? await setJob(j, 'cancel_requested', m.message) : j;
      if (asked.state === 'cancel_requested') await setJob(asked, 'cancelled', m.message);
    } else {
      await failJob(j, m.code, m.message, m.submitted, m.providerMessage);
    }
    void tick();
  }
}

function canMove(j: Job, to: Job['state']) {
  try {
    transition(j, to);
    return true;
  } catch {
    return false;
  }
}

async function handleWorkerGone(w: Worker) {
  const j = [...state.jobs.values()].find((x) => x.workerTabId === w.tabId && ACTIVE_STATES.includes(x.state));
  if (!j) return;
  // Give the tab a chance to come back (reload, service-worker hiccup) before deciding.
  setTimeout(async () => {
    const cur = state.jobs.get(j.id);
    if (!cur || !ACTIVE_STATES.includes(cur.state)) return;
    const back = [...workers.values()].some((x) => x.busyJobId === cur.id);
    if (back) return;
    await onLost(cur, 'The Flow tab closed or reloaded while this job was running.');
  }, 15_000);
}

async function onLost(j: Job, why: string) {
  if (j.state === 'preparing') {
    await setJob(j, 'retry_wait', `${why} Nothing was submitted.`, { nextRetryAt: Date.now() + 5000, attempts: Math.max(0, j.attempts - 1) });
    return;
  }
  if (j.state === 'downloading' || j.state === 'verifying') {
    await setJob(j, j.state === 'downloading' ? 'download_failed' : 'verification_failed', why);
    return;
  }
  // Possibly submitted: never resubmit silently, Flow may already be generating it.
  await setJob(j, 'waiting_for_user', `${why} It may already be generating in Flow. Check Flow's library, then Retry or Skip.`, {
    error: { code: 'TIMEOUT', message: `${why} It may already have been submitted.`, at: Date.now() },
  });
  await log('warn', 'job', `#${j.index} lost after submit; waiting for you to decide.`, { jobId: j.id });
}

async function recoverStale(now: number) {
  if (now < orphanGraceUntil.t) return;
  for (const j of state.jobs.values()) {
    if (!ACTIVE_STATES.includes(j.state) && j.state !== 'cancel_requested') continue;
    const w = j.workerTabId ? workers.get(j.workerTabId) : undefined;
    const workerHasIt = !!w && w.busyJobId === j.id;
    if (j.state === 'cancel_requested' && !w) {
      await setJob(j, 'cancelled', 'worker gone');
      continue;
    }
    if (j.state === 'downloading' || j.state === 'verifying') {
      // The tab collects outputs while "verifying"; after that the service worker checks and
      // downloads them. Only when neither holds the job was it interrupted.
      if (!inProcess.has(j.id) && !(j.state === 'verifying' && w?.busyJobId === j.id)) await setJob(j, j.state === 'downloading' ? 'download_failed' : 'verification_failed', 'Interrupted by a FlowForge restart. Retry to finish.');
      continue;
    }
    if (!w || (j.leaseUntil && j.leaseUntil < now)) {
      await onLost(j, w ? 'The job ran past its time limit.' : 'The Flow tab is gone.');
    } else if (w && !workerHasIt) {
      await onLost(j, 'The Flow tab moved on to other work.');
    }
  }
}

async function failJob(j: Job, code: ErrorCode, message: string, submitted: boolean, providerMessage?: string) {
  const q = state.queues.get(j.queueId)!;
  const d = decideAfterFailure(code, j.attempts, j.maxAttempts, q.settings);
  const error = { code, message, providerMessage, at: Date.now() };
  let target = d.state;
  // Already-submitted jobs that time out may still finish in Flow; ask before resubmitting.
  if (submitted && code === 'TIMEOUT') target = 'waiting_for_user';
  const cur = state.jobs.get(j.id) ?? j;
  await setJob(cur, canMove(cur, target) ? target : 'failed', d.message, { error, nextRetryAt: d.retryAt });
  await log(target === 'retry_wait' ? 'warn' : 'error', 'job', `#${j.index} ${code}: ${message}${providerMessage ? ` | Flow said: ${providerMessage}` : ''}`, { jobId: j.id, queueId: j.queueId });

  const n = (consecutiveFailures.get(q.id) ?? 0) + 1;
  consecutiveFailures.set(q.id, n);
  if (d.pauseQueue) await pauseQueue(q, d.message);
  else if (n >= q.settings.circuitBreakerFailures) await pauseQueue(q, `${n} failures in a row. Check the Flow tab and the activity log before resuming.`);
}

// ---------- results ----------

async function onResult(jobId: string, collected: CollectedOutput[], notes: string[]) {
  let j = state.jobs.get(jobId);
  if (!j) return;
  if (j.state === 'cancel_requested') {
    await setJob(j, 'cancelled', 'finished after cancel; outputs discarded');
    return;
  }
  if (j.state !== 'verifying') j = await setJob(j, 'verifying', notes.join('; ') || undefined);
  const q = state.queues.get(j.queueId)!;
  consecutiveFailures.set(q.id, 0);

  const outputs: OutputFile[] = collected.map((c) => ({
    id: uid('o'), kind: c.kind, sourceUrl: c.url, bytes: c.bytes, mime: c.mime, width: c.width, height: c.height, durationSec: c.durationSec, sha256: c.sha256,
  }));
  const v = verifyOutputs({ mode: j.mode, aspect: j.options.aspect, requestedOutputs: j.options.outputs, outputs });
  outputs.forEach((o) => {
    o.verified = v.ok;
    o.verifyNotes = [...v.errors, ...v.warnings];
  });
  if (!v.ok) {
    await setJob(j, 'verification_failed', v.errors.join(' '), { outputs, error: { code: 'OUTPUT_MISMATCH', message: v.errors.join(' '), at: Date.now() } });
    await log('error', 'verify', `#${j.index} failed checks: ${v.errors.join(' ')}`, { jobId });
    return;
  }
  if (v.warnings.length) await log('warn', 'verify', `#${j.index}: ${v.warnings.join(' ')}`, { jobId });

  // Keep bytes the next steps need: last frames for scene chains, full outputs for workflows,
  // and a thumbnail of everything for the library.
  const keepBlobs = needsOutputBlobs(j);
  for (let i = 0; i < collected.length; i++) {
    const c = collected[i];
    const o = outputs[i];
    if (c.thumbJpegB64) {
      o.thumbKey = `thumb:${o.id}`;
      await saveBlobRaw(o.thumbKey, b64ToBlob(c.thumbJpegB64, 'image/jpeg'));
    }
    if (c.lastFramePngB64) {
      const asset: Asset = {
        id: uid('a'), name: `${j.name ?? `job ${j.index}`} last frame`, kind: 'image', mime: 'image/png', blobKey: uid('b'),
        bytes: Math.round((c.lastFramePngB64.length * 3) / 4), width: c.width, height: c.height, tags: ['last-frame'], aliases: [],
        source: 'lastframe', sourceJobId: j.id, createdAt: Date.now(),
      };
      await saveAsset(asset, b64ToBlob(c.lastFramePngB64, 'image/png'));
      o.lastFrameAssetId = asset.id;
    }
    if (keepBlobs) {
      const blob = c.dataB64 ? b64ToBlob(c.dataB64, c.mime ?? 'image/png') : c.url ? await fetch(c.url, { credentials: 'include' }).then((r) => (r.ok ? r.blob() : undefined)).catch(() => undefined) : undefined;
      if (blob) await saveBlobRaw(`out:${o.id}`, blob);
    }
  }

  if (!q.settings.autoDownload) {
    await setJob(j, 'succeeded', 'outputs verified (auto-download off)', { outputs });
    return;
  }
  j = await setJob(j, 'downloading', undefined, { outputs });
  await downloadOutputs(j, collected);
}

async function saveBlobRaw(key: string, blob: Blob) {
  await dbPut('blobs', blob, key);
}

const takenPaths = new Set<string>();

async function downloadOutputs(j: Job, collected?: CollectedOutput[], again = false) {
  const q = state.queues.get(j.queueId)!;
  const outputs = j.outputs.map((o) => ({ ...o }));
  let failed = 0;
  for (let i = 0; i < outputs.length; i++) {
    const o = outputs[i];
    if (o.savedPath) continue;
    const c = collected?.[i];
    const template = j.options.filenameTemplate || q.settings.filenameTemplate;
    let rel = renderFilename(template, { queue: q.name, index: j.index, variant: i + 1, variantCount: outputs.length, job: j });
    if (j.options.folder) rel = `${renderFilename(j.options.folder, { queue: q.name, index: j.index, job: j })}/${rel.split('/').pop()}`;
    const path = dedupePath(`${q.settings.downloadRoot}/${rel}${extForMime(o.mime ?? (o.kind === 'video' ? 'video/mp4' : 'image/png'))}`, takenPaths);
    takenPaths.add(path.toLowerCase());
    const url = c?.dataB64 ? dataUrl(c.dataB64, c.mime ?? 'application/octet-stream') : o.sourceUrl;
    if (!url) {
      failed++;
      o.verifyNotes = [...(o.verifyNotes ?? []), 'No downloadable source (page blob expired). Re-run to regenerate.'];
      continue;
    }
    try {
      const saved = await download(url, path);
      o.savedPath = saved.path;
      o.downloadId = saved.id;
      if (!o.bytes) o.bytes = saved.bytes;
      if (saved.bytes > 0 && saved.bytes < 1024) throw new Error(`file is only ${saved.bytes} bytes`);
    } catch (e) {
      failed++;
      o.verifyNotes = [...(o.verifyNotes ?? []), `Download failed: ${(e as Error).message}`];
    }
  }
  const cur = state.jobs.get(j.id)!;
  if (again) {
    await saveJob({ ...cur, outputs: outputs.map((o, i) => (o.savedPath ? o : cur.outputs[i])), updatedAt: Date.now() });
    await log(failed ? 'warn' : 'info', 'download', `#${j.index}: downloaded again${failed ? `, ${failed} failed (signed links may have expired)` : ''}.`, { jobId: j.id });
    return;
  }
  if (failed) {
    await setJob(cur, 'download_failed', `${failed} of ${outputs.length} download(s) failed`, {
      outputs, error: { code: 'DOWNLOAD_FAILED', message: `${failed} download(s) failed. Signed links expire, so retry soon.`, at: Date.now() },
    });
    await log('error', 'download', `#${j.index}: ${failed} download(s) failed.`, { jobId: j.id });
  } else {
    await setJob(cur, 'succeeded', `${outputs.length} file(s) saved`, { outputs });
    await log('info', 'job', `#${j.index} done: ${outputs.length} file(s) saved.`, { jobId: j.id });
  }
}

export async function redownload(jobId: string) {
  const j = state.jobs.get(jobId);
  if (!j || !j.outputs.length || inProcess.has(jobId)) return;
  inProcess.add(jobId);
  try {
    // A finished job can be downloaded again without changing its state.
    const moved = j.state === 'succeeded' ? j : await setJob(j, 'downloading', 'retrying download');
    await downloadOutputs({ ...moved, outputs: moved.outputs.map((o) => (j.state === 'succeeded' ? { ...o, savedPath: undefined } : o)) }, undefined, j.state === 'succeeded');
  } finally {
    inProcess.delete(jobId);
  }
}

// ---------- agent post-processing (merge) ----------

async function runMerge(q: Queue, j: Job) {
  const lic = await license();
  if (!lic.limits.postProcessing) {
    await failJob(j, 'UNSUPPORTED_MODE', `Merging clips is part of the Pro plan (you are on ${lic.limits.label}).`, false);
    return;
  }
  if (!postProcess) return;
  const files = (j.dependsOn ?? []).flatMap((id) => state.jobs.get(id)?.outputs.filter((o) => o.kind === 'video' && o.savedPath).map((o) => o.savedPath!) ?? []);
  let cur = await setJob(j, 'preparing', `merging ${files.length} clip(s)`, { attempts: j.attempts + 1 });
  cur = await setJob(cur, 'submitting');
  cur = await setJob(cur, 'generating', 'FFmpeg running in the local agent');
  const out = `${q.settings.downloadRoot}/${renderFilename(q.settings.filenameTemplate, { queue: q.name, index: j.index, job: j })}_merged.mp4`;
  try {
    const r = await postProcess(j.id, 'merge', files, out);
    cur = await setJob(state.jobs.get(j.id)!, 'verifying');
    if (!r.ok) throw new Error(r.message ?? 'merge failed');
    await setJob(cur, 'succeeded', `merged into ${r.savedPath}`, { outputs: [{ id: uid('o'), kind: 'video', savedPath: r.savedPath, verified: true }] });
  } catch (e) {
    await failJob(state.jobs.get(j.id)!, 'GENERATION_FAILED', `Merge failed: ${(e as Error).message}`, false);
  }
}

// ---------- notifications ----------

const notified = new Map<string, number>();
function notifyOnce(key: string, title: string, message: string) {
  const last = notified.get(key) ?? 0;
  if (Date.now() - last < 10 * 60_000) return;
  notified.set(key, Date.now());
  notify(title, message);
}

export async function notify(title: string, message: string) {
  const s = await loadSettings();
  if (!s.notifications) return;
  chrome.notifications?.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: `FlowForge: ${title}`, message, priority: 1 });
}

export function engineStatus() {
  return {
    workers: [...workers.values()].map((w) => ({ tabId: w.tabId, page: w.page, visible: w.visible, busyJobId: w.busyJobId, url: w.url.split('?')[0], adapterVersion: w.adapterVersion })),
    running: anyRunning(),
  };
}

export { announce };
