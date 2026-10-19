import type { Job, LogEvent } from '@flowforge/core';
import { ADAPTER_VERSION, PRODUCT_VERSION, newQueue, redact } from '@flowforge/core';
import type { FromWorker, PanelRequest, PanelResponse, UiMapReport } from '../shared/messages';
import { PANEL_PORT, WORKER_PORT } from '../shared/messages';
import { getAll, kvSet } from '../shared/db';
import { loadSettings, loadTaught, saveSettings, saveTaught } from '../shared/settings';
import type { TargetId } from '../shared/pack';
import { currentPack, license, quota, refreshPack } from './entitlement';
import { cancelJob, control, engineStatus, ensureTimer, init, redownload, retryJobs, tick } from './engine';
import { bridgeStatus, connectBridge, startBridgeEvents } from './bridge';
import { runStoryboard, runWorkflow } from './runners';
import { deleteJobs, deleteQueue, jobsOf, load, log, saveJob, saveJobs, saveQueue, state } from './store';
import { attachWorker, injectExisting, isFlowUrl, onWorkerMessage, openFlowTab, sendTo, workers } from './workers';
import { startTrustedInput } from './trusted';

startTrustedInput();

const ready = (async () => {
  await load();
  init();
  startBridgeEvents();
  void connectBridge();
})();

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create('ff-heartbeat', { periodInMinutes: 0.5 });
  chrome.alarms.create('ff-pack', { periodInMinutes: 360 });
  const s = await loadSettings();
  await injectExisting(s.devMode);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('ff-heartbeat', { periodInMinutes: 0.5 });
});

// MV3 evicts idle service workers; the alarm wakes us so running queues keep their schedule.
chrome.alarms.onAlarm.addListener(async (a) => {
  await ready;
  if (a.name === 'ff-heartbeat') {
    ensureTimer();
    void tick();
    void connectBridge();
  }
  if (a.name === 'ff-pack') void refreshPack();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === WORKER_PORT) {
    void ready.then(() => attachWorker(port));
  }
  if (port.name === PANEL_PORT) {
    // The panel keeps a port open while visible; that alone keeps the worker alive.
    port.onDisconnect.addListener(() => {});
  }
});

// Sign-in redirects leave Flow's origin, where the content script cannot see them.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const w = workers.get(tabId);
  if (w && /accounts\.google\.com/.test(info.url)) {
    w.page = 'signed_out';
    await log('warn', 'flow', `Flow tab ${tabId} went to Google sign-in.`);
  }
  const s = await loadSettings();
  if (isFlowUrl(info.url, s.devMode) && info.status === 'complete' && !workers.has(tabId)) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
  }
});

// ---------- one-shot replies from workers (calibration, scans, probes) ----------

type Waiter = { match: (m: FromWorker) => boolean; resolve: (m: FromWorker) => void };
const waiters = new Set<Waiter>();
onWorkerMessage((_w, m) => {
  for (const wt of waiters) if (wt.match(m)) {
    waiters.delete(wt);
    wt.resolve(m);
  }
});
function awaitWorker<T extends FromWorker>(match: (m: FromWorker) => boolean, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const wt: Waiter = { match, resolve: resolve as (m: FromWorker) => void };
    waiters.add(wt);
    setTimeout(() => {
      if (waiters.delete(wt)) reject(new Error('The Flow tab did not answer.'));
    }, ms);
  });
}

async function activeWorker() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const w = (tab?.id && workers.get(tab.id)) || [...workers.values()][0];
  if (!w) throw new Error('Open a Google Flow tab first.');
  return w;
}

// ---------- side panel API ----------

chrome.runtime.onMessage.addListener((msg: PanelRequest, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !('t' in msg) || (msg as { t: string }).t === 'changed') return false;
  void (async () => {
    await ready;
    try {
      sendResponse({ ok: true, data: await handle(msg) } satisfies PanelResponse);
    } catch (e) {
      sendResponse({ ok: false, error: (e as Error).message } satisfies PanelResponse);
    }
  })();
  return true;
});

async function handle(msg: PanelRequest): Promise<unknown> {
  switch (msg.t) {
    case 'getState': {
      const lic = await license();
      return {
        version: PRODUCT_VERSION,
        adapterVersion: ADAPTER_VERSION,
        packVersion: (await currentPack()).version,
        license: { plan: lic.plan, valid: lic.valid, reason: lic.reason, limits: lic.limits, sub: lic.payload?.sub, exp: lic.payload?.exp },
        quota: await quota(),
        engine: engineStatus(),
        agent: { ...bridgeStatus },
        settings: await loadSettings(),
        taught: await loadTaught(),
      };
    }
    case 'createQueue': {
      const lic = await license();
      const q = newQueue(msg.name, (msg.mode as Job['mode']) ?? 'text-to-image');
      q.settings.concurrency = Math.min(q.settings.concurrency, lic.limits.maxConcurrency);
      return saveQueue(q);
    }
    case 'updateQueue': {
      const q = state.queues.get(msg.queueId);
      if (!q) throw new Error('Queue not found.');
      const patch = msg.patch as Partial<typeof q>;
      const lic = await license();
      const next = { ...q, ...patch, settings: { ...q.settings, ...(patch.settings ?? {}) }, defaults: { ...q.defaults, ...(patch.defaults ?? {}) } };
      if (next.settings.concurrency > lic.limits.maxConcurrency) next.settings.concurrency = lic.limits.maxConcurrency;
      return saveQueue(next);
    }
    case 'deleteQueue':
      if (state.queues.get(msg.queueId)?.status === 'running') throw new Error('Stop the queue before deleting it.');
      return deleteQueue(msg.queueId);
    case 'addJobs':
      await saveJobs(msg.jobs);
      await log('info', 'queue', `Added ${msg.jobs.length} job(s).`, { queueId: msg.queueId });
      return msg.jobs.length;
    case 'updateJob': {
      const j = state.jobs.get(msg.jobId);
      if (!j) throw new Error('Job not found.');
      if (!['queued', 'paused', 'draft', 'failed', 'policy_blocked', 'unsupported', 'cancelled', 'waiting_for_user', 'verification_failed'].includes(j.state)) {
        throw new Error('Edit the job after it stops running.');
      }
      const { state: _s, history: _h, ...rest } = msg.patch;
      return saveJob({ ...j, ...rest, options: { ...j.options, ...(msg.patch.options ?? {}) }, updatedAt: Date.now() });
    }
    case 'deleteJobs': {
      const active = msg.jobIds.filter((id) => ['preparing', 'submitting', 'generating', 'verifying', 'downloading'].includes(state.jobs.get(id)?.state ?? ''));
      if (active.length) throw new Error('Some selected jobs are running; cancel them first.');
      return deleteJobs(msg.jobIds);
    }
    case 'reorderJobs': {
      const jobs = jobsOf(msg.queueId);
      const pos = new Map(msg.orderedIds.map((id, i) => [id, i + 1]));
      const changed = jobs.filter((j) => pos.has(j.id) && pos.get(j.id) !== j.index).map((j) => ({ ...j, index: pos.get(j.id)!, updatedAt: Date.now() }));
      await saveJobs(changed);
      return changed.length;
    }
    case 'control':
      return control(msg.queueId, msg.action);
    case 'retryJobs':
      return retryJobs(msg.jobIds);
    case 'cancelJob':
      return cancelJob(msg.jobId);
    case 'redownload':
      return redownload(msg.jobId);
    case 'openFlow': {
      const s = await loadSettings();
      await openFlowTab(s.flowUrl, s.devMode);
      return true;
    }
    case 'calibrate': {
      const w = await activeWorker();
      await chrome.tabs.update(w.tabId, { active: true });
      sendTo(w, { t: 'calibrate', target: msg.target, pack: await currentPack() });
      const r = await awaitWorker<Extract<FromWorker, { t: 'calibrated' }>>((m) => m.t === 'calibrated' && m.target === msg.target, 120_000);
      if (!r.strategy) return { saved: false };
      const taught = await loadTaught();
      taught[msg.target] = [r.strategy, ...(taught[msg.target] ?? [])].slice(0, 3);
      await saveTaught(taught);
      await log('info', 'calibrate', `Taught "${msg.target}" → ${JSON.stringify(r.strategy)}`);
      return { saved: true, strategy: r.strategy, preview: r.preview };
    }
    case 'clearTaught': {
      const taught = await loadTaught();
      if (msg.target) delete taught[msg.target as TargetId];
      await saveTaught(msg.target ? taught : {});
      return true;
    }
    case 'probe': {
      const w = await activeWorker();
      sendTo(w, { t: 'probe', pack: await currentPack(), taught: await loadTaught() });
      return awaitWorker((m) => m.t === 'probeResult', 8000);
    }
    case 'scanUi': {
      const w = await activeWorker();
      sendTo(w, { t: 'scanUi' });
      const r = await awaitWorker<Extract<FromWorker, { t: 'uiMap' }>>((m) => m.t === 'uiMap', 8000);
      await kvSet('lastUiMap', r.report);
      return r.report as UiMapReport;
    }
    case 'setLicense': {
      await saveSettings({ licenseKey: msg.key.trim() });
      const lic = await license(true);
      void connectBridge(true);
      return lic;
    }
    case 'refreshPack':
      return refreshPack();
    case 'runWorkflow':
      return runWorkflow(msg.workflowId, msg.fromNodeId, msg.queueId);
    case 'runStoryboard':
      return runStoryboard(msg.storyboardId, msg.queueId);
    case 'agentReconnect':
      await connectBridge(true);
      return { ...bridgeStatus };
    case 'exportDiagnostics': {
      const logs = (await getAll<LogEvent>('logs')).sort((a, b) => a.at - b.at).slice(-2000);
      const jobs = [...state.jobs.values()].map((j) => ({
        id: j.id, queue: j.queueId, index: j.index, mode: j.mode, state: j.state, attempts: j.attempts, error: j.error,
        options: { ...j.options, references: j.options.references?.map((r) => r.role) }, history: j.history.slice(-15),
        outputs: j.outputs.map((o) => ({ kind: o.kind, w: o.width, h: o.height, bytes: o.bytes, verified: o.verified, notes: o.verifyNotes })),
        // Prompts are left out by default: they are the user's work, not diagnostic data.
        promptChars: j.prompt.length,
      }));
      const report = {
        product: 'FlowForge', version: PRODUCT_VERSION, adapterVersion: ADAPTER_VERSION, packVersion: (await currentPack()).version,
        at: new Date().toISOString(), userAgent: navigator.userAgent, engine: engineStatus(), agent: bridgeStatus,
        settings: { ...(await loadSettings()), licenseKey: '[redacted]', agentToken: '[redacted]' }, taught: await loadTaught(),
        queues: [...state.queues.values()].map((q) => ({ id: q.id, status: q.status, settings: q.settings, pausedReason: q.pausedReason })),
        jobs, logs,
      };
      return JSON.parse(redact(JSON.stringify(report)));
    }
  }
}

export {};
