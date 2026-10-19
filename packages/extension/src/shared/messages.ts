import type { ErrorCode, Job, JobState, ReferenceRole, MediaKind } from '@flowforge/core';
import type { SelectorPack, Strategy, TargetId } from './pack';

export const WORKER_PORT = 'flowforge-worker';
export const PANEL_PORT = 'flowforge-panel';

export type PageState =
  | 'ready'
  | 'loading'
  | 'signed_out'
  | 'captcha'
  | 'unusual_activity'
  | 'not_flow' // landing/about page, no composer
  | 'busy'
  | 'ui_unknown';

export interface WorkerHello {
  t: 'hello';
  url: string;
  page: PageState;
  visible: boolean;
  adapterVersion: string;
  busyJobId?: string;
}

export interface RefPayload {
  role: ReferenceRole;
  name: string;
  mime: string;
  dataB64: string;
}

export interface CollectedOutput {
  kind: MediaKind;
  url?: string; // http(s) source; downloaded directly by chrome.downloads
  dataB64?: string; // for blob: sources, or when direct download is not possible
  mime?: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  sha256?: string;
  lastFramePngB64?: string;
  thumbJpegB64?: string;
}

export interface RunSettings {
  freshSession: boolean;
  autoApprove: boolean;
  optionStrategy: 'auto' | 'ui' | 'instruction' | 'none';
  timeoutSec: number;
  extractLastFrame: boolean;
  settleSec: number;
}

export type ToWorker =
  | { t: 'run'; job: Job; settings: RunSettings; refs: RefPayload[]; pack: SelectorPack; taught: Partial<Record<TargetId, Strategy[]>> }
  | { t: 'cancel'; jobId: string }
  | { t: 'tick' }
  | { t: 'calibrate'; target: TargetId; pack: SelectorPack }
  | { t: 'scanUi' }
  | { t: 'probe'; pack: SelectorPack; taught: Partial<Record<TargetId, Strategy[]>> };

export type FromWorker =
  | WorkerHello
  | { t: 'page'; page: PageState; visible: boolean; url: string }
  | { t: 'progress'; jobId: string; state: JobState; note?: string }
  | { t: 'result'; jobId: string; outputs: CollectedOutput[]; observed?: Job['observed']; notes: string[] }
  | { t: 'failure'; jobId: string; code: ErrorCode; message: string; providerMessage?: string; submitted: boolean }
  | { t: 'calibrated'; target: TargetId; strategy: Strategy | null; preview?: string }
  | { t: 'uiMap'; report: UiMapReport }
  | { t: 'probeResult'; found: Record<string, { ok: boolean; via?: string }>; page: PageState };

export interface UiMapReport {
  url: string;
  at: number;
  controls: { tag: string; role?: string; ariaLabel?: string; text?: string; placeholder?: string; testId?: string; visible: boolean }[];
  media: { tag: string; src: string; w: number; h: number }[];
}

// ---- side panel <-> background (request/response over runtime messages) ----

export type PanelRequest =
  | { t: 'getState' }
  /** From the content script: media on Flow's CDN is cross-origin there, but not for the extension. */
  | { t: 'fetchMedia'; url: string }
  | { t: 'createQueue'; name: string; mode?: string }
  | { t: 'updateQueue'; queueId: string; patch: Record<string, unknown> }
  | { t: 'deleteQueue'; queueId: string }
  | { t: 'addJobs'; queueId: string; jobs: Job[] }
  | { t: 'updateJob'; jobId: string; patch: Partial<Job> }
  | { t: 'deleteJobs'; jobIds: string[] }
  | { t: 'reorderJobs'; queueId: string; orderedIds: string[] }
  | { t: 'control'; queueId: string; action: 'start' | 'pause' | 'resume' | 'stop' }
  | { t: 'retryJobs'; jobIds: string[] }
  | { t: 'cancelJob'; jobId: string }
  | { t: 'redownload'; jobId: string }
  | { t: 'openFlow' }
  | { t: 'calibrate'; target: TargetId }
  | { t: 'clearTaught'; target?: TargetId }
  | { t: 'scanUi' }
  | { t: 'probe' }
  | { t: 'setLicense'; key: string }
  | { t: 'refreshPack' }
  | { t: 'runWorkflow'; workflowId: string; fromNodeId?: string; queueId?: string }
  | { t: 'runStoryboard'; storyboardId: string; queueId?: string }
  | { t: 'exportDiagnostics' }
  | { t: 'agentReconnect' };

export type PanelResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export interface Broadcast {
  t: 'changed';
  stores: string[];
}
