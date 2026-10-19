import type { Job, JobState } from './types';
import { TERMINAL_STATES } from './types';

// Every legal move. Anything not listed throws, which is how "success because a button was
// clicked" bugs get caught: there is no edge from submitting to succeeded.
const EDGES: Record<JobState, JobState[]> = {
  draft: ['queued', 'cancelled'],
  queued: ['preparing', 'blocked', 'paused', 'cancelled', 'waiting_for_flow', 'failed', 'unsupported'],
  blocked: ['queued', 'cancelled', 'failed', 'paused'],
  waiting_for_flow: ['queued', 'preparing', 'paused', 'cancelled'],
  waiting_for_user: ['queued', 'preparing', 'paused', 'cancelled', 'failed'],
  preparing: ['submitting', 'retry_wait', 'waiting_for_user', 'waiting_for_flow', 'unsupported', 'policy_blocked', 'failed', 'cancel_requested', 'paused'],
  submitting: ['generating', 'retry_wait', 'waiting_for_user', 'policy_blocked', 'failed', 'cancel_requested', 'unsupported'],
  generating: ['verifying', 'retry_wait', 'waiting_for_user', 'policy_blocked', 'unsupported', 'failed', 'cancel_requested'],
  verifying: ['downloading', 'succeeded', 'verification_failed', 'retry_wait', 'failed'],
  downloading: ['succeeded', 'download_failed', 'retry_wait'],
  retry_wait: ['queued', 'cancelled', 'paused', 'failed'],
  paused: ['queued', 'cancelled'],
  cancel_requested: ['cancelled'],
  succeeded: ['queued'], // explicit "run again"
  cancelled: ['queued'],
  failed: ['queued'],
  unsupported: ['queued'],
  policy_blocked: ['queued'],
  download_failed: ['downloading', 'queued'],
  verification_failed: ['queued', 'downloading'],
};

export class IllegalTransition extends Error {
  constructor(public from: JobState, public to: JobState) {
    super(`Illegal job transition ${from} -> ${to}`);
  }
}

export function canTransition(from: JobState, to: JobState): boolean {
  return from === to || EDGES[from].includes(to);
}

/** Returns a new job with the transition recorded. Pure: callers persist the result. */
export function transition(job: Job, to: JobState, note?: string, now = Date.now()): Job {
  if (job.state === to) return job;
  if (!canTransition(job.state, to)) throw new IllegalTransition(job.state, to);
  const history = [...job.history, { from: job.state, to, at: now, note }].slice(-60);
  const next: Job = { ...job, state: to, history, updatedAt: now };
  if (to === 'preparing' && !job.startedAt) next.startedAt = now;
  if (isTerminal(to)) {
    next.finishedAt = now;
    next.leaseUntil = undefined;
    next.workerTabId = undefined;
  }
  if (to === 'queued') {
    next.leaseUntil = undefined;
    next.workerTabId = undefined;
    next.nextRetryAt = undefined;
  }
  return next;
}

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Reset a finished or failed job so it runs again, keeping its history. */
export function requeue(job: Job, note = 'requeued by user', now = Date.now()): Job {
  const j = transition(job, 'queued', note, now);
  return { ...j, attempts: 0, error: undefined, outputs: job.state === 'succeeded' ? [] : job.outputs, finishedAt: undefined };
}

export const STATE_LABEL: Record<JobState, string> = {
  draft: 'Draft',
  queued: 'Queued',
  blocked: 'Waiting on dependency',
  waiting_for_flow: 'Waiting for Flow tab',
  waiting_for_user: 'Needs you',
  preparing: 'Preparing',
  submitting: 'Submitting',
  generating: 'Generating',
  verifying: 'Verifying',
  downloading: 'Downloading',
  retry_wait: 'Retry scheduled',
  paused: 'Paused',
  cancel_requested: 'Cancelling',
  succeeded: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed',
  unsupported: 'Unsupported',
  policy_blocked: 'Blocked by policy',
  download_failed: 'Download failed',
  verification_failed: 'Output check failed',
};
