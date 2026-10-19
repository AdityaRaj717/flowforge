// Shared data model. The extension, the side panel and the local agent all speak these shapes,
// so a job created from a CSV row, a workflow node or a REST call is the same object.

export type MediaKind = 'image' | 'video';

export type GenerationMode =
  | 'text-to-image'
  | 'image-to-image'
  | 'text-to-video'
  | 'frames-to-video' // start frame, optional end frame
  | 'ingredients-to-video'
  | 'extend-video';

export const MODE_OUTPUT: Record<GenerationMode, MediaKind> = {
  'text-to-image': 'image',
  'image-to-image': 'image',
  'text-to-video': 'video',
  'frames-to-video': 'video',
  'ingredients-to-video': 'video',
  'extend-video': 'video',
};

export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
export const ASPECT_RATIOS: AspectRatio[] = ['16:9', '9:16', '1:1', '4:3', '3:4'];

/** How a reference asset is used by a generation. Order inside a role matters. */
export type ReferenceRole = 'start' | 'end' | 'ingredient' | 'style' | 'character' | 'source';

export interface ReferenceRef {
  role: ReferenceRole;
  /** Asset id in the local library, or `job:<jobId>[#n]` / `lastframe:<jobId>` for chained outputs. */
  assetId: string;
}

export interface JobOptions {
  model?: string;
  aspect?: AspectRatio;
  /** Outputs requested per prompt (1-4). */
  outputs?: number;
  /** Video duration in seconds where the model allows choosing it. */
  durationSec?: number;
  /** Download quality: '720p' | '1080p' | '4k' | '1k' | '2k'. Upstream plan decides what is allowed. */
  downloadQuality?: string;
  references?: ReferenceRef[];
  negativePrompt?: string;
  /** Sub-folder under the download root. Supports filename template tokens. */
  folder?: string;
  filenameTemplate?: string;
  /** Free-form tags shown in the library. */
  tags?: string[];
}

export type JobState =
  // happy path
  | 'draft'
  | 'queued'
  | 'preparing'
  | 'submitting'
  | 'generating'
  | 'verifying'
  | 'downloading'
  | 'succeeded'
  // waiting / recoverable
  | 'blocked' // waiting on a dependency (e.g. previous scene's last frame)
  | 'waiting_for_flow' // no usable Flow tab
  | 'waiting_for_user' // captcha, sign-in, unusual-activity notice, confirmation needed
  | 'retry_wait'
  | 'paused'
  | 'cancel_requested'
  // terminal failures
  | 'cancelled'
  | 'failed'
  | 'unsupported'
  | 'policy_blocked'
  | 'download_failed'
  | 'verification_failed';

export const TERMINAL_STATES: JobState[] = [
  'succeeded', 'cancelled', 'failed', 'unsupported', 'policy_blocked', 'download_failed', 'verification_failed',
];
export const ACTIVE_STATES: JobState[] = ['preparing', 'submitting', 'generating', 'verifying', 'downloading'];

export type ErrorCode =
  | 'NETWORK'
  | 'FLOW_TAB_MISSING'
  | 'SIGNED_OUT'
  | 'CAPTCHA'
  | 'UNUSUAL_ACTIVITY'
  | 'RATE_LIMIT'
  | 'QUEUE_FULL'
  | 'CREDITS_EXHAUSTED'
  | 'POLICY_VIOLATION'
  | 'UNSUPPORTED_MODE'
  | 'UNSUPPORTED_OPTION'
  | 'UI_ELEMENT_MISSING'
  | 'UI_CHANGED'
  | 'NEEDS_CONSENT'
  | 'TIMEOUT'
  | 'GENERATION_FAILED'
  | 'NO_OUTPUT'
  | 'OUTPUT_MISMATCH'
  | 'DOWNLOAD_FAILED'
  | 'ASSET_MISSING'
  | 'DEPENDENCY_FAILED'
  | 'QUOTA_LOCAL'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface JobError {
  code: ErrorCode;
  message: string;
  /** Text shown by Flow, if any (refusal reason etc.). Never contains tokens. */
  providerMessage?: string;
  at: number;
}

export interface Transition {
  from: JobState;
  to: JobState;
  at: number;
  note?: string;
}

export interface OutputFile {
  id: string;
  kind: MediaKind;
  /** Remote URL as seen in Flow (signed, short lived). Not persisted in exports. */
  sourceUrl?: string;
  /** Path relative to the Downloads folder once saved. */
  savedPath?: string;
  downloadId?: number;
  bytes?: number;
  sha256?: string;
  mime?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  /** Data URL of the last frame (videos), used for scene chaining. */
  lastFrameAssetId?: string;
  /** Blob key of a small JPEG preview shown in the library. */
  thumbKey?: string;
  verified?: boolean;
  verifyNotes?: string[];
}

export interface Job {
  id: string;
  queueId: string;
  /** Stable key so a reconnect never submits the same row twice. */
  idempotencyKey: string;
  index: number;
  name?: string;
  prompt: string;
  mode: GenerationMode;
  options: JobOptions;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  history: Transition[];
  error?: JobError;
  nextRetryAt?: number;
  /** Lease held by the worker running it; lets a restarted service worker recover stale jobs. */
  leaseUntil?: number;
  workerTabId?: number;
  /** Jobs that must succeed first (scene chains, workflow edges). */
  dependsOn?: string[];
  outputs: OutputFile[];
  /** What Flow actually used, when it can be observed. */
  observed?: { model?: string; aspect?: string; outputs?: number };
  /** Variables available to filename and prompt templates. */
  vars?: Record<string, string>;
  workflowId?: string;
  nodeId?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  adapterVersion?: string;
}

export interface QueueSettings {
  /** Parallel Flow tabs used by this queue. */
  concurrency: number;
  delayMinSec: number;
  delayMaxSec: number;
  maxAttempts: number;
  /** Base backoff for retryable failures; grows exponentially with jitter. */
  backoffBaseSec: number;
  backoffMaxSec: number;
  generationTimeoutSec: number;
  autoDownload: boolean;
  downloadRoot: string;
  filenameTemplate: string;
  /** Stop the whole queue (not just the job) after this many consecutive failures. */
  circuitBreakerFailures: number;
  /** Skip policy-blocked prompts and keep going, rather than pausing the queue. */
  skipPolicyBlocked: boolean;
  notifyOnFinish: boolean;
}

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
  concurrency: 1,
  delayMinSec: 8,
  delayMaxSec: 20,
  maxAttempts: 3,
  backoffBaseSec: 30,
  backoffMaxSec: 900,
  generationTimeoutSec: 600,
  autoDownload: true,
  downloadRoot: 'FlowForge',
  filenameTemplate: '{queue}/{index:03}_{slug}{variant}',
  circuitBreakerFailures: 4,
  skipPolicyBlocked: true,
  notifyOnFinish: true,
};

export type QueueStatus = 'idle' | 'running' | 'paused' | 'stopping';

export interface Queue {
  id: string;
  name: string;
  projectId?: string;
  status: QueueStatus;
  settings: QueueSettings;
  /** Default options applied to rows that leave a field empty. */
  defaults: JobOptions & { mode: GenerationMode };
  createdAt: number;
  updatedAt: number;
  pausedReason?: string;
}

export interface Asset {
  id: string;
  name: string;
  kind: MediaKind;
  mime: string;
  /** Stored blob key in IndexedDB. */
  blobKey: string;
  bytes: number;
  width?: number;
  height?: number;
  tags: string[];
  collection?: string;
  /** Names that `@mention` or filename matching resolve to this asset. */
  aliases: string[];
  /** Character bible fields, when this asset is a character reference. */
  character?: CharacterSheet;
  source: 'upload' | 'generated' | 'lastframe';
  sourceJobId?: string;
  createdAt: number;
}

export interface CharacterSheet {
  displayName: string;
  description: string;
  wardrobe?: string;
  locks?: string[]; // "always red scarf", "left-handed"
  avoid?: string[];
}

export interface Project {
  id: string;
  name: string;
  /** Flow project URL or id the queue should run in, if pinned. */
  flowProjectUrl?: string;
  createdAt: number;
}

export interface LogEvent {
  id: string;
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  jobId?: string;
  queueId?: string;
  data?: Record<string, unknown>;
}

/** A storyboard is a scripted list of scenes that compiles into a chained queue. */
export interface Storyboard {
  id: string;
  name: string;
  aspect: AspectRatio;
  style: string;
  characters: string[]; // asset ids
  scenes: StoryScene[];
  createdAt: number;
  updatedAt: number;
}

export interface StoryScene {
  id: string;
  title: string;
  action: string;
  location?: string;
  shot?: string; // wide, close-up, OTS...
  camera?: string; // dolly in, pan left...
  dialogue?: string;
  characters?: string[];
  continuity: 'none' | 'last-frame' | 'same-references';
  durationSec?: number;
  mode?: GenerationMode;
}
