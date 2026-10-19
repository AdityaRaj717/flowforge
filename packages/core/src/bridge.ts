// Wire protocol between the extension and the optional local agent (WebSocket on 127.0.0.1).
// The extension owns the queue; the agent is a client that submits work and receives events.
// Nothing here ever carries Google cookies or tokens: the agent never talks to Google.

import type { GenerationMode, Job, JobOptions, JobState, LogEvent, Queue } from './types';

export const BRIDGE_DEFAULT_PORT = 47321;
export const BRIDGE_PROTOCOL = 1;

export type AgentToExt =
  | { t: 'hello'; protocol: number; agentVersion: string; token: string }
  | { t: 'enqueue'; reqId: string; queueName?: string; items: { prompt: string; mode?: GenerationMode; options?: JobOptions; name?: string }[]; start?: boolean }
  | { t: 'listJobs'; reqId: string; queueId?: string; states?: JobState[]; limit?: number }
  | { t: 'getJob'; reqId: string; jobId: string }
  | { t: 'listQueues'; reqId: string }
  | { t: 'control'; reqId: string; queueId: string; action: 'start' | 'pause' | 'resume' | 'stop' }
  | { t: 'cancelJob'; reqId: string; jobId: string }
  | { t: 'retryJob'; reqId: string; jobId: string }
  | { t: 'runWorkflow'; reqId: string; workflowId: string; fromNodeId?: string }
  | { t: 'listWorkflows'; reqId: string }
  | { t: 'status'; reqId: string }
  /** The agent reports a post-processing result (e.g. merged file) back to the job/library. */
  | { t: 'postResult'; reqId: string; jobId: string; savedPath: string; ok: boolean; message?: string };

export type ExtToAgent =
  | { t: 'welcome'; protocol: number; extVersion: string; plan: string; localApi: boolean }
  | { t: 'reply'; reqId: string; ok: true; data: unknown }
  | { t: 'reply'; reqId: string; ok: false; error: string }
  | { t: 'jobUpdate'; job: JobSummary }
  | { t: 'queueUpdate'; queue: Pick<Queue, 'id' | 'name' | 'status' | 'pausedReason'> }
  | { t: 'log'; event: LogEvent }
  /** Ask the agent to run FFmpeg work on files already in the Downloads folder. */
  | { t: 'postProcess'; reqId: string; jobId: string; op: 'merge' | 'lastFrame' | 'probe'; files: string[]; output?: string };

export interface JobSummary {
  id: string;
  queueId: string;
  index: number;
  name?: string;
  prompt: string;
  mode: GenerationMode;
  state: JobState;
  attempts: number;
  error?: { code: string; message: string; providerMessage?: string };
  outputs: { kind: string; savedPath?: string; width?: number; height?: number; durationSec?: number; verified?: boolean }[];
  updatedAt: number;
}

export function summarizeJob(j: Job): JobSummary {
  return {
    id: j.id,
    queueId: j.queueId,
    index: j.index,
    name: j.name,
    prompt: j.prompt,
    mode: j.mode,
    state: j.state,
    attempts: j.attempts,
    error: j.error && { code: j.error.code, message: j.error.message, providerMessage: j.error.providerMessage },
    outputs: j.outputs.map((o) => ({ kind: o.kind, savedPath: o.savedPath, width: o.width, height: o.height, durationSec: o.durationSec, verified: o.verified })),
    updatedAt: j.updatedAt,
  };
}
