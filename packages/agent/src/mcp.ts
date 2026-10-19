import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PRODUCT_VERSION } from '@flowforge/core';
import { api } from './client';

// MCP server over stdio. Each tool is a call to the running agent's REST API, so Claude, Cursor
// and other MCP clients drive the same queue the user sees in the side panel.

const MODES = ['text-to-image', 'image-to-image', 'text-to-video', 'frames-to-video', 'ingredients-to-video', 'extend-video'] as const;
const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] });
async function wrap(fn: () => Promise<unknown>) {
  try {
    return text(await fn());
  } catch (e) {
    return fail(e);
  }
}

// The SDK's generic tool() signature makes TypeScript expand every zod schema type and run out
// of memory; registering through this narrower view keeps checking fast. Arguments are still
// validated at runtime by the SDK against the zod shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolFn = (name: string, description: string, shape: Record<string, z.ZodTypeAny>, cb: (args: any) => Promise<unknown> | unknown) => void;

export async function runMcp() {
  const mcp = new McpServer({ name: 'flowforge', version: PRODUCT_VERSION });
  const server = { tool: mcp.tool.bind(mcp) as unknown as ToolFn };

  server.tool('flowforge_status', 'Is the FlowForge extension connected, which plan, which Flow tabs are ready, which queues are running.', {}, () => wrap(() => api('GET', '/v1/status')));


  server.tool(
    'flowforge_generate',
    'Queue one or more Google Flow generations in the user\'s own signed-in Flow tab (uses their Flow credits). Returns job ids; set wait=true to block until they finish and get saved file paths.',
    {
      prompts: z.array(z.string().min(1)).min(1).max(200).describe('One job per prompt. {a|b} variations expand into separate jobs.'),
      mode: z.enum(MODES).default('text-to-image'),
      aspect: z.enum(ASPECTS).optional(),
      outputs: z.number().int().min(1).max(4).optional().describe('Outputs per prompt'),
      model: z.string().optional().describe('Model name as shown in Flow, e.g. "Veo 3.1 - Fast" or "Nano Banana Pro"'),
      durationSec: z.number().optional(),
      queue: z.string().default('MCP').describe('Queue name in FlowForge'),
      wait: z.boolean().default(false),
      waitTimeoutSec: z.number().int().min(10).max(3600).default(900),
    },
    (a) =>
      wrap(async () => {
        const r = await api<{ queueId: string; jobIds: string[] }>('POST', '/v1/jobs', {
          items: (a.prompts as string[]).map((prompt) => ({ prompt })),
          mode: a.mode,
          options: { aspect: a.aspect, outputs: a.outputs, model: a.model, durationSec: a.durationSec },
          queue: a.queue,
        });
        if (!a.wait) return { ...r, note: 'Queued. Use flowforge_wait or flowforge_get_job to follow progress.' };
        const done = [];
        for (const id of r.jobIds as string[]) done.push(await api('GET', `/v1/jobs/${id}/wait?timeout=${a.waitTimeoutSec}`));
        return { queueId: r.queueId, jobs: done };
      }),
  );

  server.tool('flowforge_get_job', 'State, error (including Flow\'s refusal text) and saved files of one job.', { jobId: z.string() }, (a) => wrap(() => api('GET', `/v1/jobs/${a.jobId}`)));

  server.tool(
    'flowforge_wait',
    'Wait until a job finishes (or needs the user) and return it.',
    { jobId: z.string(), timeoutSec: z.number().int().min(5).max(3600).default(600) },
    (a) => wrap(() => api('GET', `/v1/jobs/${a.jobId}/wait?timeout=${a.timeoutSec}`)),
  );

  server.tool(
    'flowforge_list_jobs',
    'Recent jobs, newest first. Filter by queue id and states (e.g. failed,policy_blocked).',
    { queueId: z.string().optional(), states: z.array(z.string()).optional(), limit: z.number().int().min(1).max(500).default(50) },
    (a) => wrap(() => api('GET', `/v1/jobs?limit=${a.limit}${a.queueId ? `&queue=${a.queueId}` : ''}${a.states?.length ? `&state=${a.states.join(',')}` : ''}`)),
  );

  server.tool('flowforge_list_queues', 'All queues with status and job counts.', {}, () => wrap(() => api('GET', '/v1/queues')));

  server.tool(
    'flowforge_queue_control',
    'Start, pause, resume or stop a queue.',
    { queueId: z.string(), action: z.enum(['start', 'pause', 'resume', 'stop']) },
    (a) => wrap(() => api('POST', `/v1/queues/${a.queueId}/${a.action}`)),
  );

  server.tool('flowforge_retry_job', 'Requeue a failed job.', { jobId: z.string() }, (a) => wrap(() => api('POST', `/v1/jobs/${a.jobId}/retry`)));
  server.tool('flowforge_cancel_job', 'Cancel a queued or running job.', { jobId: z.string() }, (a) => wrap(() => api('POST', `/v1/jobs/${a.jobId}/cancel`)));

  server.tool('flowforge_list_workflows', 'Saved visual workflows.', {}, () => wrap(() => api('GET', '/v1/workflows')));
  server.tool(
    'flowforge_run_workflow',
    'Run a saved workflow graph (optionally from one node onward).',
    { workflowId: z.string(), fromNodeId: z.string().optional() },
    (a) => wrap(() => api('POST', `/v1/workflows/${a.workflowId}/run`, { fromNodeId: a.fromNodeId })),
  );

  server.tool(
    'flowforge_merge_videos',
    'Join video files in order into one MP4 with FFmpeg (clips are scaled to match; silent audio added where missing).',
    { files: z.array(z.string()).min(1), output: z.string().optional(), loudnorm: z.boolean().default(false) },
    (a) => wrap(() => api('POST', '/v1/post/merge', a)),
  );
  server.tool('flowforge_last_frame', 'Save the final frame of a video as PNG.', { file: z.string(), output: z.string().optional() }, (a) => wrap(() => api('POST', '/v1/post/lastframe', a)));
  server.tool('flowforge_probe', 'Duration, size, codec and audio presence of a media file.', { file: z.string() }, (a) => wrap(() => api('POST', '/v1/post/probe', a)));

  await mcp.connect(new StdioServerTransport());
}
