import { useCallback, useEffect, useRef, useState } from 'react';
import type { Asset, Job, LicenseStatus, LogEvent, Queue, Storyboard, Workflow } from '@flowforge/core';
import type { Broadcast, PanelRequest, PanelResponse } from '../shared/messages';
import type { Settings } from '../shared/settings';
import type { Strategy, TargetId } from '../shared/pack';
import * as db from '../shared/db';
import { PANEL_PORT } from '../shared/messages';

export async function call<T = unknown>(req: PanelRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as PanelResponse<T> | undefined;
  if (!res) throw new Error('FlowForge background did not answer. Reload the extension.');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

// Keep the service worker awake while the panel is open.
try {
  chrome.runtime.connect({ name: PANEL_PORT });
} catch {
  /* ignore in tests */
}

const subs = new Set<(stores: string[]) => void>();
chrome.runtime.onMessage.addListener((m: Broadcast) => {
  if (m?.t === 'changed') subs.forEach((s) => s(m.stores));
});

/** Re-runs `load` whenever one of `stores` changes. */
export function useLive<T>(stores: string[], load: () => Promise<T>, initial: T, deps: unknown[] = []): [T, () => void] {
  const [v, setV] = useState<T>(initial);
  const loadRef = useRef(load);
  loadRef.current = load;
  const refresh = useCallback(() => {
    loadRef.current().then(setV).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const fn = (changed: string[]) => {
      if (changed.some((c) => stores.includes(c))) refresh();
    };
    subs.add(fn);
    return () => void subs.delete(fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [v, refresh];
}

export interface PanelState {
  version: string;
  adapterVersion: string;
  packVersion: string;
  license: Pick<LicenseStatus, 'plan' | 'valid' | 'reason' | 'limits'> & { sub?: string; exp?: number | null };
  quota: { used: number; remaining: number | null; limit: number | null; resetsAt: number };
  engine: { workers: { tabId: number; page: string; visible: boolean; busyJobId?: string; url: string; adapterVersion: string }[]; running: boolean };
  agent: { connected: boolean; error: string; agentVersion: string };
  settings: Settings;
  taught: Partial<Record<TargetId, Strategy[]>>;
}

export function usePanelState(): [PanelState | null, () => void] {
  const [s, refresh] = useLive<PanelState | null>(['queues', 'jobs', 'settings'], () => call<PanelState>({ t: 'getState' }), null);
  useEffect(() => {
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);
  return [s, refresh];
}

export const useQueues = () => useLive<Queue[]>(['queues'], async () => (await db.getAll<Queue>('queues')).sort((a, b) => a.createdAt - b.createdAt), []);
export const useJobs = (queueId?: string) =>
  useLive<Job[]>(['jobs'], async () => (queueId ? (await db.getAllByIndex<Job>('jobs', 'queueId', queueId)).sort((a, b) => a.index - b.index) : []), [], [queueId]);
export const useAllJobs = () => useLive<Job[]>(['jobs'], () => db.getAll<Job>('jobs'), []);
export const useAssets = () => useLive<Asset[]>(['assets'], async () => (await db.getAll<Asset>('assets')).sort((a, b) => b.createdAt - a.createdAt), []);
export const useWorkflows = () => useLive<Workflow[]>(['workflows'], async () => (await db.getAll<Workflow>('workflows')).sort((a, b) => b.updatedAt - a.updatedAt), []);
export const useStoryboards = () => useLive<Storyboard[]>(['storyboards'], async () => (await db.getAll<Storyboard>('storyboards')).sort((a, b) => b.updatedAt - a.updatedAt), []);
export const useLogs = () => useLive<LogEvent[]>(['logs'], async () => (await db.getAll<LogEvent>('logs')).sort((a, b) => b.at - a.at).slice(0, 800), []);

/** Writes for stores the panel owns (assets, workflows, storyboards); queues/jobs go through the worker. */
export async function putLocal(store: 'assets' | 'workflows' | 'storyboards', value: unknown) {
  await db.put(store, value);
  broadcastLocal(store);
}
export async function delLocal(store: 'assets' | 'workflows' | 'storyboards', id: string) {
  await db.del(store, id);
  broadcastLocal(store);
}
function broadcastLocal(store: string) {
  subs.forEach((s) => s([store]));
  chrome.runtime.sendMessage({ t: 'changed', stores: [store] } satisfies Broadcast).catch(() => {});
}

const urlCache = new Map<string, string>();
export async function blobUrl(key?: string): Promise<string | undefined> {
  if (!key) return undefined;
  if (urlCache.has(key)) return urlCache.get(key);
  const b = await db.get<Blob>('blobs', key);
  if (!b) return undefined;
  const u = URL.createObjectURL(b);
  urlCache.set(key, u);
  return u;
}

export function useBlobUrl(key?: string): string | undefined {
  const [u, setU] = useState<string | undefined>(key ? urlCache.get(key) : undefined);
  useEffect(() => {
    let live = true;
    blobUrl(key).then((x) => live && setU(x));
    return () => {
      live = false;
    };
  }, [key]);
  return u;
}

export function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadText(name: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
