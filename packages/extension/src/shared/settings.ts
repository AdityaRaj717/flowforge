import type { Strategy, TargetId } from './pack';

export interface Settings {
  flowUrl: string;
  /** Start each job in a fresh agent session so earlier prompts don't bleed into the next one. */
  freshSessionPerJob: boolean;
  /** Click Flow's "approve plan" button when the agent asks; it is the run you queued. */
  autoApproveAgent: boolean;
  /** How per-job settings (ratio, count, model) reach Flow. */
  optionStrategy: 'auto' | 'ui' | 'instruction' | 'none';
  extractLastFrames: 'chains' | 'always' | 'never';
  settleSec: number;
  packUrl: string;
  agentEnabled: boolean;
  agentPort: number;
  agentToken: string;
  licenseKey: string;
  notifications: boolean;
  /** Developer mode: allows the local mock Flow page as a worker. */
  devMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  flowUrl: 'https://flow.google.com/',
  freshSessionPerJob: true,
  autoApproveAgent: true,
  optionStrategy: 'auto',
  extractLastFrames: 'chains',
  settleSec: 6,
  packUrl: '',
  agentEnabled: false,
  agentPort: 47321,
  agentToken: '',
  licenseKey: '',
  notifications: true,
  devMode: false,
};

const KEY = 'ff.settings';
const TAUGHT = 'ff.taught';

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(raw[KEY] ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function loadTaught(): Promise<Partial<Record<TargetId, Strategy[]>>> {
  const raw = await chrome.storage.local.get(TAUGHT);
  return raw[TAUGHT] ?? {};
}

export async function saveTaught(t: Partial<Record<TargetId, Strategy[]>>): Promise<void> {
  await chrome.storage.local.set({ [TAUGHT]: t });
}
