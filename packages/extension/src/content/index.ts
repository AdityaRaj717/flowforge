// Content script for Flow tabs: a worker that runs one job at a time for the service worker.
// It holds no queue state of its own; if this tab reloads, the service worker notices and decides.

import { ADAPTER_VERSION } from '@flowforge/core';
import { DEFAULT_PACK } from '../shared/pack';
import type { FromWorker, PageState, ToWorker } from '../shared/messages';
import { WORKER_PORT } from '../shared/messages';
import { runJob, JobFailure } from './adapter';
import { detectPageState } from './detect';
import { find, wakeAll } from './dom';
import { scanUi, showBadge, teach } from './calibrate';

declare global {
  interface Window {
    __flowforgeWorker?: boolean;
  }
}

if (!window.__flowforgeWorker) {
  window.__flowforgeWorker = true;
  start();
}

function start() {
  let port: chrome.runtime.Port | null = null;
  let busyJobId: string | undefined;
  let cancelFor: string | undefined;
  let lastPage: PageState | null = null;
  let pack = DEFAULT_PACK;
  let taught = {};

  const send = (m: FromWorker) => {
    try {
      port?.postMessage(m);
    } catch {
      /* reconnect handles it */
    }
  };

  const connect = () => {
    try {
      port = chrome.runtime.connect({ name: WORKER_PORT });
    } catch {
      // Extension was reloaded; this content script is orphaned. Stop quietly.
      return;
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // The service worker restarts often in MV3; come back and report what we are doing.
      setTimeout(connect, 1000);
    });
    send({ t: 'hello', url: location.href, page: detectPageState(pack, taught), visible: !document.hidden, adapterVersion: ADAPTER_VERSION, busyJobId });
  };

  async function onMessage(msg: ToWorker) {
    switch (msg.t) {
      case 'tick':
        wakeAll();
        reportPage();
        break;
      case 'probe': {
        pack = msg.pack;
        taught = msg.taught;
        const found: Record<string, { ok: boolean; via?: string }> = {};
        for (const id of Object.keys(pack.targets) as (keyof typeof pack.targets)[]) {
          const f = find(id, pack, taught, { visible: id !== 'fileInput' });
          found[id] = { ok: !!f, via: f?.via };
        }
        send({ t: 'probeResult', found, page: detectPageState(pack, taught) });
        break;
      }
      case 'scanUi':
        send({ t: 'uiMap', report: scanUi() });
        break;
      case 'calibrate': {
        const label = msg.pack.targets[msg.target]?.label ?? msg.target;
        const r = await teach(label);
        send({ t: 'calibrated', target: msg.target, strategy: r.strategy, preview: r.preview });
        break;
      }
      case 'cancel':
        if (busyJobId === msg.jobId) cancelFor = msg.jobId;
        break;
      case 'run': {
        if (busyJobId) {
          send({ t: 'failure', jobId: msg.job.id, code: 'QUEUE_FULL', message: 'This tab is already running a job.', submitted: false });
          return;
        }
        busyJobId = msg.job.id;
        cancelFor = undefined;
        pack = msg.pack;
        taught = msg.taught;
        showBadge(`FlowForge is running: ${msg.job.name ?? msg.job.prompt.slice(0, 60)}`);
        try {
          const res = await runJob({
            job: msg.job,
            settings: msg.settings,
            refs: msg.refs,
            pack,
            taught,
            cancelled: () => cancelFor === msg.job.id,
            progress: (state, note) => send({ t: 'progress', jobId: msg.job.id, state, note }),
          });
          send({ t: 'result', jobId: msg.job.id, outputs: res.outputs, observed: res.observed, notes: res.notes });
        } catch (e) {
          const f = e instanceof JobFailure ? e : new JobFailure('UNKNOWN', (e as Error)?.message ?? String(e), false);
          send({ t: 'failure', jobId: msg.job.id, code: f.code, message: f.message, providerMessage: f.providerMessage, submitted: f.submitted });
        } finally {
          busyJobId = undefined;
          showBadge(null);
        }
        break;
      }
    }
  }

  function reportPage() {
    const page = busyJobId ? 'busy' : detectPageState(pack, taught);
    if (page !== lastPage) {
      lastPage = page;
      send({ t: 'page', page, visible: !document.hidden, url: location.href });
    }
  }

  document.addEventListener('visibilitychange', () => send({ t: 'page', page: lastPage ?? 'loading', visible: !document.hidden, url: location.href }));
  connect();
}
