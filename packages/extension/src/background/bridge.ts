import type { AgentToExt, ExtToAgent, Job } from '@flowforge/core';
import { BRIDGE_PROTOCOL, PRODUCT_VERSION, summarizeJob, newQueue, newJob } from '@flowforge/core';
import { loadSettings } from '../shared/settings';
import { getAll } from '../shared/db';
import { license } from './entitlement';
import { control, cancelJob, retryJobs, setPostProcessor, engineStatus } from './engine';
import { jobsOf, log, onChange, onLog, saveJobs, saveQueue, state } from './store';
import { runWorkflow } from './runners';

// WebSocket client for the optional local agent (REST / MCP / CLI / FFmpeg).
// The agent listens on 127.0.0.1 only and must present the pairing token the user copied from it.
// It never receives Google cookies or tokens; it asks the extension to queue work and gets events.

let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let authed = false;
export const bridgeStatus = { connected: false, error: '' as string, agentVersion: '' };
const pending = new Map<string, (r: { ok: boolean; savedPath?: string; message?: string }) => void>();
let lastJobSent = new Map<string, number>();

function send(m: ExtToAgent) {
  if (ws?.readyState === WebSocket.OPEN && authed) ws.send(JSON.stringify(m));
}

export async function connectBridge(force = false) {
  const s = await loadSettings();
  const lic = await license();
  if (!s.agentEnabled || !s.agentToken) {
    disconnect('Local agent is off.');
    return;
  }
  if (!lic.limits.localApi) {
    disconnect(`The local API is part of Pro (you are on ${lic.limits.label}).`);
    return;
  }
  if (ws && !force && ws.readyState <= WebSocket.OPEN) return;
  disconnect('');
  try {
    ws = new WebSocket(`ws://127.0.0.1:${s.agentPort}/bridge`);
  } catch (e) {
    bridgeStatus.error = (e as Error).message;
    schedule();
    return;
  }
  ws.onopen = () => {
    ws!.send(JSON.stringify({ t: 'auth', token: s.agentToken, protocol: BRIDGE_PROTOCOL }));
  };
  ws.onmessage = (ev) => void onMessage(ev.data as string);
  ws.onclose = () => {
    bridgeStatus.connected = false;
    authed = false;
    setPostProcessor(null);
    schedule();
  };
  ws.onerror = () => {
    bridgeStatus.error = 'Agent not reachable on 127.0.0.1.';
  };
}

function disconnect(reason: string) {
  if (retry) clearTimeout(retry);
  retry = null;
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  ws = null;
  authed = false;
  bridgeStatus.connected = false;
  bridgeStatus.error = reason;
  setPostProcessor(null);
}

function schedule() {
  if (retry) return;
  retry = setTimeout(() => {
    retry = null;
    void connectBridge();
  }, 5000);
}

async function onMessage(raw: string) {
  let m: AgentToExt | { t: 'authOk'; agentVersion: string } | { t: 'authFail'; reason: string } | { t: 'postDone'; reqId: string; ok: boolean; savedPath?: string; message?: string };
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.t === 'authOk') {
    authed = true;
    bridgeStatus.connected = true;
    bridgeStatus.error = '';
    bridgeStatus.agentVersion = m.agentVersion;
    const lic = await license();
    send({ t: 'welcome', protocol: BRIDGE_PROTOCOL, extVersion: PRODUCT_VERSION, plan: lic.plan, localApi: lic.limits.localApi });
    setPostProcessor(
      (jobId, op, files, output) =>
        new Promise((resolve) => {
          const reqId = `pp_${jobId}_${Date.now()}`;
          pending.set(reqId, resolve);
          send({ t: 'postProcess', reqId, jobId, op, files, output });
          setTimeout(() => pending.has(reqId) && (pending.delete(reqId), resolve({ ok: false, message: 'agent did not answer in 10 minutes' })), 600_000);
        }),
    );
    await log('info', 'agent', `Local agent ${m.agentVersion} connected.`);
    return;
  }
  if (m.t === 'authFail') {
    disconnect(`Agent rejected the pairing token: ${m.reason}`);
    return;
  }
  if (m.t === 'postDone') {
    pending.get(m.reqId)?.(m);
    pending.delete(m.reqId);
    return;
  }
  if (!authed) return;
  const reply = (reqId: string, data: unknown) => send({ t: 'reply', reqId, ok: true, data });
  const fail = (reqId: string, error: string) => send({ t: 'reply', reqId, ok: false, error });
  try {
    switch (m.t) {
      case 'status':
        return reply(m.reqId, { ...engineStatus(), plan: (await license()).plan, queues: [...state.queues.values()].map((q) => ({ id: q.id, name: q.name, status: q.status })) });
      case 'listQueues':
        return reply(m.reqId, [...state.queues.values()].map((q) => ({ id: q.id, name: q.name, status: q.status, pausedReason: q.pausedReason, jobs: jobsOf(q.id).length })));
      case 'listJobs': {
        let jobs = m.queueId ? jobsOf(m.queueId) : [...state.jobs.values()];
        if (m.states?.length) jobs = jobs.filter((j) => m.states!.includes(j.state));
        jobs.sort((a, b) => b.updatedAt - a.updatedAt);
        return reply(m.reqId, jobs.slice(0, m.limit ?? 100).map(summarizeJob));
      }
      case 'getJob': {
        const j = state.jobs.get(m.jobId);
        return j ? reply(m.reqId, summarizeJob(j)) : fail(m.reqId, 'job not found');
      }
      case 'enqueue': {
        const name = m.queueName || 'API';
        let q = [...state.queues.values()].find((x) => x.name === name);
        if (!q) q = await saveQueue(newQueue(name, m.items[0]?.mode ?? 'text-to-image'));
        const start = jobsOf(q.id).reduce((mx, j) => Math.max(mx, j.index), 0) + 1;
        const jobs: Job[] = m.items.map((it, i) => newJob(q!, { prompt: it.prompt, mode: it.mode, options: it.options, name: it.name }, start + i));
        await saveJobs(jobs);
        if (m.start !== false && q.status !== 'running') await control(q.id, 'start');
        await log('info', 'agent', `Agent queued ${jobs.length} job(s) in "${q.name}".`, { queueId: q.id });
        return reply(m.reqId, { queueId: q.id, jobIds: jobs.map((j) => j.id) });
      }
      case 'control':
        await control(m.queueId, m.action);
        return reply(m.reqId, { ok: true });
      case 'cancelJob':
        await cancelJob(m.jobId);
        return reply(m.reqId, { ok: true });
      case 'retryJob':
        await retryJobs([m.jobId]);
        return reply(m.reqId, { ok: true });
      case 'listWorkflows': {
        const wfs = await getAll<{ id: string; name: string; nodes: unknown[] }>('workflows');
        return reply(m.reqId, wfs.map((w) => ({ id: w.id, name: w.name, nodes: w.nodes.length })));
      }
      case 'runWorkflow':
        return reply(m.reqId, await runWorkflow(m.workflowId, m.fromNodeId));
      default:
        return fail((m as { reqId: string }).reqId, `unknown request ${(m as { t: string }).t}`);
    }
  } catch (e) {
    fail((m as { reqId: string }).reqId, (e as Error).message);
  }
}

// Stream job and queue changes to the agent so its REST/MCP clients can wait on them.
export function startBridgeEvents() {
  onChange((stores) => {
    if (!bridgeStatus.connected) return;
    if (stores.includes('jobs')) {
      for (const j of state.jobs.values()) {
        if ((lastJobSent.get(j.id) ?? 0) >= j.updatedAt) continue;
        lastJobSent.set(j.id, j.updatedAt);
        send({ t: 'jobUpdate', job: summarizeJob(j) });
      }
      if (lastJobSent.size > 20_000) lastJobSent = new Map();
    }
    if (stores.includes('queues')) state.queues.forEach((q) => send({ t: 'queueUpdate', queue: { id: q.id, name: q.name, status: q.status, pausedReason: q.pausedReason } }));
  });
  onLog((event) => {
    if (event.level !== 'debug') send({ t: 'log', event });
  });
}
