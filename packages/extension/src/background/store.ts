import type { Asset, Job, LogEvent, Queue, Storyboard, Workflow } from '@flowforge/core';
import { redact, uid } from '@flowforge/core';
import * as db from '../shared/db';
import type { Broadcast } from '../shared/messages';

// In-memory mirror of the queue database. The service worker is the only writer for queues and
// jobs; every mutation is written to IndexedDB before listeners hear about it, so a worker
// eviction at any point loses nothing that was announced.

export const state = {
  queues: new Map<string, Queue>(),
  jobs: new Map<string, Job>(),
  loaded: false,
};

let loading: Promise<void> | null = null;
export function load(): Promise<void> {
  if (state.loaded) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      const [queues, jobs] = await Promise.all([db.getAll<Queue>('queues'), db.getAll<Job>('jobs')]);
      queues.forEach((q) => state.queues.set(q.id, q));
      jobs.forEach((j) => state.jobs.set(j.id, j));
      state.loaded = true;
    })();
  }
  return loading;
}

const pendingStores = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(stores: string[]) => void>();

export function onChange(fn: (stores: string[]) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function announce(...stores: string[]) {
  stores.forEach((s) => pendingStores.add(s));
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const list = [...pendingStores];
    pendingStores.clear();
    const msg: Broadcast = { t: 'changed', stores: list };
    chrome.runtime.sendMessage(msg).catch(() => {});
    listeners.forEach((l) => l(list));
  }, 150);
}

export async function saveQueue(q: Queue): Promise<Queue> {
  q.updatedAt = Date.now();
  state.queues.set(q.id, q);
  await db.put('queues', q);
  announce('queues');
  return q;
}

export async function saveJob(j: Job): Promise<Job> {
  state.jobs.set(j.id, j);
  await db.put('jobs', j);
  announce('jobs');
  return j;
}

export async function saveJobs(js: Job[]): Promise<void> {
  js.forEach((j) => state.jobs.set(j.id, j));
  await db.putMany('jobs', js);
  announce('jobs');
}

export async function deleteJobs(ids: string[]): Promise<void> {
  ids.forEach((id) => state.jobs.delete(id));
  await db.del('jobs', ids);
  announce('jobs');
}

export async function deleteQueue(id: string): Promise<void> {
  const ids = [...state.jobs.values()].filter((j) => j.queueId === id).map((j) => j.id);
  await deleteJobs(ids);
  state.queues.delete(id);
  await db.del('queues', id);
  announce('queues');
}

export function jobsOf(queueId: string): Job[] {
  return [...state.jobs.values()].filter((j) => j.queueId === queueId).sort((a, b) => a.index - b.index);
}

// ---------- assets ----------

export async function saveAsset(a: Asset, blob?: Blob): Promise<Asset> {
  if (blob) await db.put('blobs', blob, a.blobKey);
  await db.put('assets', a);
  announce('assets');
  return a;
}

export async function getAsset(id: string): Promise<Asset | undefined> {
  return db.get<Asset>('assets', id);
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  return db.get<Blob>('blobs', key);
}

export async function getWorkflow(id: string) {
  return db.get<Workflow>('workflows', id);
}

export async function getStoryboard(id: string) {
  return db.get<Storyboard>('storyboards', id);
}

// ---------- logs ----------

let logCount = 0;
export async function log(level: LogEvent['level'], scope: string, message: string, extra: Partial<LogEvent> = {}): Promise<LogEvent> {
  const ev: LogEvent = { id: uid('l'), at: Date.now(), level, scope, message: redact(message), ...extra };
  if (ev.data) ev.data = JSON.parse(redact(JSON.stringify(ev.data)));
  await db.put('logs', ev);
  if (++logCount % 200 === 0) db.trimLogs(5000).catch(() => {});
  announce('logs');
  logListeners.forEach((l) => l(ev));
  return ev;
}

const logListeners = new Set<(e: LogEvent) => void>();
export function onLog(fn: (e: LogEvent) => void) {
  logListeners.add(fn);
}
