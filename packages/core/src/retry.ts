import type { ErrorCode, JobState, QueueSettings } from './types';

export type FailureClass =
  | 'retry' // transient: back off and try again
  | 'pause_queue' // the account or session needs a human; stop everything, keep progress
  | 'skip' // this prompt will never work as-is; move on
  | 'fatal'; // bug or unknown; fail the job, keep the queue going

export interface FailurePolicy {
  cls: FailureClass;
  /** State the job lands in. */
  state: JobState;
  /** Multiplier on the queue's backoff base (rate limits wait longer than network blips). */
  backoffFactor?: number;
  userMessage: string;
}

// The point of this table is that nothing anti-abuse related is ever "retry". A captcha or an
// unusual-activity notice pauses the queue and waits for the person; it is not worked around.
export const FAILURE_POLICY: Record<ErrorCode, FailurePolicy> = {
  NETWORK: { cls: 'retry', state: 'retry_wait', userMessage: 'Network error; retrying.' },
  TIMEOUT: { cls: 'retry', state: 'retry_wait', userMessage: 'Flow did not finish in time; retrying.' },
  GENERATION_FAILED: { cls: 'retry', state: 'retry_wait', userMessage: 'Flow reported a failed generation; retrying.' },
  NO_OUTPUT: { cls: 'retry', state: 'retry_wait', userMessage: 'No output appeared; retrying.' },
  RATE_LIMIT: { cls: 'retry', state: 'retry_wait', backoffFactor: 4, userMessage: 'Flow is rate limiting; waiting before the next try.' },
  QUEUE_FULL: { cls: 'retry', state: 'retry_wait', backoffFactor: 2, userMessage: 'Flow queue is full; waiting.' },
  DOWNLOAD_FAILED: { cls: 'retry', state: 'download_failed', userMessage: 'Generated, but the download failed. Retry the download from the library.' },
  OUTPUT_MISMATCH: { cls: 'fatal', state: 'verification_failed', userMessage: 'Output does not match what was requested (type, count or shape).' },
  FLOW_TAB_MISSING: { cls: 'pause_queue', state: 'waiting_for_flow', userMessage: 'Open a Google Flow tab to continue.' },
  SIGNED_OUT: { cls: 'pause_queue', state: 'waiting_for_user', userMessage: 'Sign in to Google Flow in the worker tab, then resume.' },
  CAPTCHA: { cls: 'pause_queue', state: 'waiting_for_user', userMessage: 'Flow is asking for a verification. Complete it in the tab, then resume.' },
  UNUSUAL_ACTIVITY: { cls: 'pause_queue', state: 'waiting_for_user', userMessage: 'Flow flagged unusual activity. The queue is paused; wait a while and lower concurrency before resuming.' },
  CREDITS_EXHAUSTED: { cls: 'pause_queue', state: 'waiting_for_user', userMessage: 'Your Flow credits or daily limit are used up.' },
  NEEDS_CONSENT: { cls: 'pause_queue', state: 'waiting_for_user', userMessage: 'Flow is asking you to agree to its terms (for example "Rights to use this image"). Read and accept it yourself in the Flow tab, then resume. FlowForge never accepts agreements for you.' },
  UI_CHANGED: { cls: 'pause_queue', state: 'waiting_for_user', userMessage: 'The Flow page looks different from what the adapter expects. Update FlowForge or recalibrate.' },
  QUOTA_LOCAL: { cls: 'pause_queue', state: 'paused', userMessage: 'Daily FlowForge job limit for your plan reached.' },
  POLICY_VIOLATION: { cls: 'skip', state: 'policy_blocked', userMessage: 'Flow refused this prompt under its content policy. Edit it and requeue.' },
  UNSUPPORTED_MODE: { cls: 'skip', state: 'unsupported', userMessage: 'This mode is not available in your Flow account or UI.' },
  UNSUPPORTED_OPTION: { cls: 'skip', state: 'unsupported', userMessage: 'A requested option (model, ratio, count...) is not available.' },
  ASSET_MISSING: { cls: 'skip', state: 'failed', userMessage: 'A reference asset is missing from the library.' },
  DEPENDENCY_FAILED: { cls: 'skip', state: 'failed', userMessage: 'A job this one depends on did not succeed.' },
  UI_ELEMENT_MISSING: { cls: 'retry', state: 'retry_wait', userMessage: 'A Flow control was not found; retrying after a reload.' },
  CANCELLED: { cls: 'fatal', state: 'cancelled', userMessage: 'Cancelled.' },
  UNKNOWN: { cls: 'fatal', state: 'failed', userMessage: 'Unexpected error.' },
};

export function policyFor(code: ErrorCode): FailurePolicy {
  return FAILURE_POLICY[code] ?? FAILURE_POLICY.UNKNOWN;
}

/**
 * Exponential backoff with full jitter. attempt is 1-based (the attempt that just failed).
 * `rand` is injectable so tests are deterministic.
 */
export function backoffMs(attempt: number, settings: Pick<QueueSettings, 'backoffBaseSec' | 'backoffMaxSec'>, factor = 1, rand = Math.random): number {
  const base = settings.backoffBaseSec * factor;
  const cap = settings.backoffMaxSec;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  // Never below half the computed delay, so a rate limit always gets real breathing room.
  return Math.round((exp / 2 + rand() * (exp / 2)) * 1000);
}

/** Delay between two submissions in the same queue. */
export function interJobDelayMs(settings: Pick<QueueSettings, 'delayMinSec' | 'delayMaxSec'>, rand = Math.random): number {
  const lo = Math.max(0, settings.delayMinSec);
  const hi = Math.max(lo, settings.delayMaxSec);
  return Math.round((lo + rand() * (hi - lo)) * 1000);
}

export interface RetryDecision {
  state: JobState;
  retryAt?: number;
  pauseQueue: boolean;
  message: string;
}

export function decideAfterFailure(
  code: ErrorCode,
  attempts: number,
  maxAttempts: number,
  settings: Pick<QueueSettings, 'backoffBaseSec' | 'backoffMaxSec' | 'skipPolicyBlocked'>,
  now = Date.now(),
  rand = Math.random,
): RetryDecision {
  const p = policyFor(code);
  if (p.cls === 'retry') {
    if (code === 'DOWNLOAD_FAILED') return { state: 'download_failed', pauseQueue: false, message: p.userMessage };
    if (attempts >= maxAttempts) {
      return { state: 'failed', pauseQueue: false, message: `${p.userMessage} Gave up after ${attempts} attempts.` };
    }
    return { state: 'retry_wait', retryAt: now + backoffMs(attempts, settings, p.backoffFactor, rand), pauseQueue: false, message: p.userMessage };
  }
  if (p.cls === 'pause_queue') return { state: p.state, pauseQueue: true, message: p.userMessage };
  if (p.cls === 'skip') {
    return { state: p.state, pauseQueue: code === 'POLICY_VIOLATION' && !settings.skipPolicyBlocked, message: p.userMessage };
  }
  return { state: p.state, pauseQueue: false, message: p.userMessage };
}
