import type { FromWorker, PageState, ToWorker } from '../shared/messages';

// Registry of connected Flow tabs. Each tab runs at most one job.

export interface Worker {
  tabId: number;
  windowId: number;
  port: chrome.runtime.Port;
  url: string;
  page: PageState;
  visible: boolean;
  busyJobId?: string;
  connectedAt: number;
  lastSeen: number;
  adapterVersion: string;
}

export const workers = new Map<number, Worker>();

type Handler = (w: Worker, m: FromWorker) => void;
const handlers = new Set<Handler>();
const disconnectHandlers = new Set<(w: Worker) => void>();

export function onWorkerMessage(h: Handler) {
  handlers.add(h);
}
export function onWorkerGone(h: (w: Worker) => void) {
  disconnectHandlers.add(h);
}

export function attachWorker(port: chrome.runtime.Port) {
  const tab = port.sender?.tab;
  if (!tab?.id) return;
  const tabId = tab.id;
  port.onMessage.addListener((m: FromWorker) => {
    let w = workers.get(tabId);
    if (m.t === 'hello') {
      w = {
        tabId,
        windowId: tab.windowId,
        port,
        url: m.url,
        page: m.page,
        visible: m.visible,
        busyJobId: m.busyJobId,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        adapterVersion: m.adapterVersion,
      };
      workers.set(tabId, w);
    }
    if (!w) return;
    w.lastSeen = Date.now();
    if (m.t === 'page') {
      w.page = m.page;
      w.visible = m.visible;
      w.url = m.url;
    }
    handlers.forEach((h) => h(w!, m));
  });
  port.onDisconnect.addListener(() => {
    const w = workers.get(tabId);
    if (w && w.port === port) {
      workers.delete(tabId);
      disconnectHandlers.forEach((h) => h(w));
    }
  });
}

export function sendTo(w: Worker, m: ToWorker): boolean {
  try {
    w.port.postMessage(m);
    return true;
  } catch {
    return false;
  }
}

export function idleWorkers(): Worker[] {
  return [...workers.values()].filter((w) => !w.busyJobId && w.page === 'ready');
}

/** Tick every connected tab so their waits keep moving even when Chrome throttles hidden tabs. */
export function tickAll() {
  workers.forEach((w) => sendTo(w, { t: 'tick' }));
}

export function isFlowUrl(url: string | undefined, devMode: boolean): boolean {
  if (!url) return false;
  return /^https:\/\/(flow\.google\.com|labs\.google\/fx)/.test(url) || (devMode && /^http:\/\/(localhost|127\.0\.0\.1):5179\//.test(url));
}

/** Content scripts only auto-load on navigation; inject into Flow tabs that were already open. */
export async function injectExisting(devMode: boolean) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id || !isFlowUrl(t.url, devMode)) continue;
    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }).catch(() => {});
  }
}

export async function openFlowTab(url: string, devMode: boolean): Promise<chrome.tabs.Tab> {
  const [existing] = (await chrome.tabs.query({})).filter((t) => isFlowUrl(t.url, devMode));
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
    return existing;
  }
  return chrome.tabs.create({ url, active: true });
}
