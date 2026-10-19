import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentToExt, ExtToAgent, JobSummary, GenerationMode, JobOptions } from '@flowforge/core';
import { BRIDGE_PROTOCOL, PRODUCT_VERSION, TERMINAL_STATES } from '@flowforge/core';
import type { AgentConfig } from './config';
import * as ff from './ffmpeg';

// The agent never talks to Google. It is a local front door (REST, OpenAI-style, MCP via REST)
// that asks the FlowForge extension to queue work, and an FFmpeg runner for finished files.

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Distribute<T> = T extends unknown ? Omit<T, 'reqId'> : never;
type AgentRequest = Distribute<Extract<AgentToExt, { reqId: string }>>;

export class Agent {
  private ext: WebSocket | null = null;
  private extInfo: { extVersion?: string; plan?: string; localApi?: boolean } = {};
  private pending = new Map<string, Pending>();
  readonly jobs = new Map<string, JobSummary>();
  private waiters = new Map<string, Set<(j: JobSummary) => void>>();
  private media = new Map<string, string>(); // random id -> absolute path the extension saved
  private logs: string[] = [];

  constructor(public cfg: AgentConfig) {}

  get connected() {
    return !!this.ext && this.ext.readyState === this.ext.OPEN;
  }

  status() {
    return { agentVersion: PRODUCT_VERSION, extensionConnected: this.connected, ...this.extInfo, knownJobs: this.jobs.size };
  }

  /** Sends a request to the extension and resolves with its reply. */
  request<T = unknown>(msg: AgentRequest, timeoutMs = 20_000): Promise<T> {
    if (!this.connected) return Promise.reject(new HttpError(503, 'The FlowForge extension is not connected. Open Chrome, enable "Connect to the local agent" in FlowForge Settings and paste the pairing token.'));
    const reqId = randomBytes(8).toString('hex');
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new HttpError(504, 'The extension did not answer in time.'));
      }, timeoutMs);
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ext!.send(JSON.stringify({ ...msg, reqId }));
    });
  }

  waitFor(jobId: string, timeoutMs: number): Promise<JobSummary> {
    const cur = this.jobs.get(jobId);
    if (cur && isDone(cur)) return Promise.resolve(cur);
    return new Promise((resolve) => {
      const set = this.waiters.get(jobId) ?? new Set();
      const done = (j: JobSummary) => {
        clearTimeout(t);
        set.delete(done);
        resolve(j);
      };
      const t = setTimeout(() => {
        set.delete(done);
        resolve(this.jobs.get(jobId) ?? ({ id: jobId, state: 'queued' } as JobSummary));
      }, timeoutMs);
      set.add(done);
      this.waiters.set(jobId, set);
    });
  }

  mediaUrl(path: string): string {
    for (const [id, p] of this.media) if (p === path) return `http://127.0.0.1:${this.cfg.port}/v1/media/${id}${extname(path)}`;
    const id = randomBytes(16).toString('hex');
    this.media.set(id, path);
    return `http://127.0.0.1:${this.cfg.port}/v1/media/${id}${extname(path)}`;
  }

  // ---------- extension socket ----------

  attach(ws: WebSocket) {
    let authed = false;
    const authTimer = setTimeout(() => !authed && ws.close(4001, 'auth timeout'), 5000);
    ws.on('message', async (raw) => {
      let m: (ExtToAgent | { t: 'auth'; token: string; protocol: number }) & Record<string, unknown>;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!authed) {
        if (m.t !== 'auth' || !tokenOk(String(m.token ?? ''), this.cfg.token)) {
          ws.send(JSON.stringify({ t: 'authFail', reason: 'wrong pairing token' }));
          ws.close(4003, 'bad token');
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        if (this.ext && this.ext !== ws) this.ext.close(4000, 'replaced by a newer connection');
        this.ext = ws;
        ws.send(JSON.stringify({ t: 'authOk', agentVersion: PRODUCT_VERSION, protocol: BRIDGE_PROTOCOL }));
        this.log('extension connected');
        return;
      }
      this.onExtMessage(m as ExtToAgent, ws);
    });
    ws.on('close', () => {
      if (this.ext === ws) {
        this.ext = null;
        this.log('extension disconnected');
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new HttpError(503, 'Extension disconnected.'));
          this.pending.delete(id);
        }
      }
    });
  }

  private async onExtMessage(m: ExtToAgent, ws: WebSocket) {
    switch (m.t) {
      case 'welcome':
        this.extInfo = { extVersion: m.extVersion, plan: m.plan, localApi: m.localApi };
        return;
      case 'reply': {
        const p = this.pending.get(m.reqId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(m.reqId);
        if (m.ok) p.resolve(m.data);
        else p.reject(new HttpError(400, m.error));
        return;
      }
      case 'jobUpdate': {
        this.jobs.set(m.job.id, m.job);
        if (this.jobs.size > 50_000) this.jobs.delete(this.jobs.keys().next().value!);
        if (isDone(m.job)) this.waiters.get(m.job.id)?.forEach((w) => w(m.job));
        return;
      }
      case 'log':
        this.log(`[ext] ${m.event.level} ${m.event.scope}: ${m.event.message}`);
        return;
      case 'postProcess': {
        try {
          if (m.op !== 'merge') throw new Error(`unsupported op ${m.op}`);
          const out = resolveOutput(m.output ?? `FlowForge/merged_${Date.now()}.mp4`, m.files[0]);
          await ff.merge(this.cfg.ffmpeg, this.cfg.ffprobe, m.files, out);
          ws.send(JSON.stringify({ t: 'postDone', reqId: m.reqId, ok: true, savedPath: out }));
          this.log(`merged ${m.files.length} clip(s) -> ${out}`);
        } catch (e) {
          ws.send(JSON.stringify({ t: 'postDone', reqId: m.reqId, ok: false, message: (e as Error).message }));
        }
        return;
      }
      default:
        return;
    }
  }

  log(line: string) {
    const l = `${new Date().toISOString()} ${line}`;
    this.logs.push(l);
    if (this.logs.length > 500) this.logs.shift();
    if (process.env.FLOWFORGE_QUIET !== '1') process.stderr.write(`${l}\n`);
  }

  recentLogs() {
    return this.logs.slice(-200);
  }

  // ---------- HTTP ----------

  listen(): Promise<ReturnType<typeof createServer>> {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    const server = createServer((req, res) => {
      this.route(req, res).catch((e) => send(res, e instanceof HttpError ? e.status : 500, { error: (e as Error).message }));
    });
    server.on('upgrade', (req, socket, head) => {
      const origin = String(req.headers.origin ?? '');
      // Only the extension may open the bridge; web pages cannot (their Origin is http(s)).
      if (!req.url?.startsWith('/bridge') || !origin.startsWith('chrome-extension://')) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.cfg.port, '127.0.0.1', () => resolve(server));
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.cfg.port}`);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const origin = req.headers.origin;
    if (origin && !String(origin).startsWith('chrome-extension://')) throw new HttpError(403, 'Browser pages may not call the FlowForge agent.');
    if (p === '/health') return send(res, 200, { ok: true, ...this.status() });

    const media = /^\/v1\/media\/([a-f0-9]{32})(\.\w+)?$/.exec(p);
    if (media && req.method === 'GET') {
      const file = this.media.get(media[1]);
      if (!file || !existsSync(file)) throw new HttpError(404, 'not found');
      res.writeHead(200, { 'content-type': mime(file), 'content-length': statSync(file).size });
      createReadStream(file).pipe(res);
      return;
    }

    const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!tokenOk(auth, this.cfg.token)) throw new HttpError(401, 'Missing or wrong token. Send "Authorization: Bearer <token>" (see `flowforge-agent token`).');
    const body = req.method === 'POST' ? await readJson(req) : {};

    if (req.method === 'GET' && p === '/v1/status') return send(res, 200, { ...this.status(), extension: this.connected ? await this.request({ t: 'status' }).catch((e) => ({ error: e.message })) : null });
    if (req.method === 'GET' && p === '/v1/logs') return send(res, 200, { logs: this.recentLogs() });
    if (req.method === 'GET' && p === '/v1/queues') return send(res, 200, await this.request({ t: 'listQueues' }));
    if (req.method === 'GET' && p === '/v1/jobs') {
      const states = url.searchParams.get('state')?.split(',').filter(Boolean) as JobSummary['state'][] | undefined;
      return send(res, 200, await this.request({ t: 'listJobs', queueId: url.searchParams.get('queue') ?? undefined, states, limit: Number(url.searchParams.get('limit') ?? 100) }));
    }
    if (req.method === 'POST' && p === '/v1/jobs') return send(res, 202, await this.enqueue(body));
    let m = /^\/v1\/jobs\/([\w-]+)$/.exec(p);
    if (m && req.method === 'GET') return send(res, 200, this.decorate(await this.request<JobSummary>({ t: 'getJob', jobId: m[1] })));
    m = /^\/v1\/jobs\/([\w-]+)\/wait$/.exec(p);
    if (m && req.method === 'GET') {
      const j = await this.waitFor(m[1], Math.min(3_600_000, Number(url.searchParams.get('timeout') ?? 600) * 1000));
      return send(res, 200, this.decorate(j));
    }
    m = /^\/v1\/jobs\/([\w-]+)\/(cancel|retry)$/.exec(p);
    if (m && req.method === 'POST') return send(res, 200, await this.request(m[2] === 'cancel' ? { t: 'cancelJob', jobId: m[1] } : { t: 'retryJob', jobId: m[1] }));
    m = /^\/v1\/queues\/([\w-]+)\/(start|pause|resume|stop)$/.exec(p);
    if (m && req.method === 'POST') return send(res, 200, await this.request({ t: 'control', queueId: m[1], action: m[2] as 'start' }));
    if (req.method === 'GET' && p === '/v1/workflows') return send(res, 200, await this.request({ t: 'listWorkflows' }));
    m = /^\/v1\/workflows\/([\w-]+)\/run$/.exec(p);
    if (m && req.method === 'POST') return send(res, 202, await this.request({ t: 'runWorkflow', workflowId: m[1], fromNodeId: body.fromNodeId as string | undefined }));

    // Post-processing on local files.
    if (req.method === 'POST' && p === '/v1/post/merge') {
      const files = (body.files as string[]) ?? [];
      const out = resolveOutput(String(body.output ?? `FlowForge/merged_${Date.now()}.mp4`), files[0]);
      const info = await ff.merge(this.cfg.ffmpeg, this.cfg.ffprobe, files, out, { loudnorm: !!body.loudnorm });
      return send(res, 200, { output: out, ...info });
    }
    if (req.method === 'POST' && p === '/v1/post/lastframe') {
      const file = String(body.file ?? '');
      const out = String(body.output ?? file.replace(/\.\w+$/, '') + '_lastframe.png');
      return send(res, 200, { output: await ff.lastFrame(this.cfg.ffmpeg, file, out) });
    }
    if (req.method === 'POST' && p === '/v1/post/probe') return send(res, 200, await ff.probe(this.cfg.ffprobe, String(body.file ?? '')));
    if (req.method === 'POST' && p === '/v1/post/slideshow') {
      const images = (body.images as string[]) ?? [];
      const out = resolveOutput(String(body.output ?? `FlowForge/slideshow_${Date.now()}.mp4`), images[0]);
      return send(res, 200, { output: await ff.slideshow(this.cfg.ffmpeg, images, out, Number(body.secondsPerImage ?? 3), String(body.size ?? '1920x1080')) });
    }

    // OpenAI-compatible image generation (blocks until the images exist).
    if (req.method === 'POST' && p === '/v1/images/generations') return send(res, 200, await this.openaiImages(body));
    if (req.method === 'GET' && p === '/v1/models') {
      return send(res, 200, { object: 'list', data: ['flow-image', 'flow-video'].map((id) => ({ id, object: 'model', owned_by: 'flowforge' })) });
    }
    throw new HttpError(404, `No route ${req.method} ${p}`);
  }

  async enqueue(body: Record<string, unknown>) {
    const items = Array.isArray(body.items)
      ? (body.items as Record<string, unknown>[])
      : Array.isArray(body.prompts)
        ? (body.prompts as string[]).map((prompt) => ({ prompt }))
        : body.prompt
          ? [{ prompt: body.prompt }]
          : [];
    if (!items.length) throw new HttpError(400, 'Send {"prompt": "..."} or {"prompts": [...]} or {"items": [{prompt, mode, options}]}.');
    const shared = { mode: body.mode as GenerationMode | undefined, options: (body.options as JobOptions | undefined) ?? pickOptions(body) };
    return this.request<{ queueId: string; jobIds: string[] }>({
      t: 'enqueue',
      queueName: (body.queue as string) ?? 'API',
      start: body.start !== false,
      items: items.map((it) => ({
        prompt: String(it.prompt ?? ''),
        mode: (it.mode as GenerationMode) ?? shared.mode,
        options: { ...shared.options, ...((it.options as JobOptions) ?? pickOptions(it)) },
        name: it.name as string | undefined,
      })),
    });
  }

  decorate(j: JobSummary) {
    return { ...j, outputs: j.outputs?.map((o) => ({ ...o, url: o.savedPath && existsSync(o.savedPath) ? this.mediaUrl(o.savedPath) : undefined })) };
  }

  private async openaiImages(body: Record<string, unknown>) {
    const n = Math.max(1, Math.min(4, Number(body.n ?? 1)));
    const size = String(body.size ?? '');
    const aspect = /1792x1024|landscape|16:9/.test(size) ? '16:9' : /1024x1792|portrait|9:16/.test(size) ? '9:16' : /1024x1024|square|1:1/.test(size) ? '1:1' : undefined;
    const r = await this.enqueue({ prompt: body.prompt, mode: 'text-to-image', options: { outputs: n, aspect, model: body.model && !String(body.model).startsWith('flow-') ? body.model : undefined }, queue: 'OpenAI API' });
    const j = await this.waitFor(r.jobIds[0], 15 * 60_000);
    if (j.state !== 'succeeded') throw new HttpError(502, `Generation ${j.state}: ${j.error?.message ?? 'no details'}${j.error?.providerMessage ? ` (Flow: ${j.error.providerMessage})` : ''}`);
    const files = j.outputs.filter((o) => o.savedPath && existsSync(o.savedPath)).map((o) => o.savedPath!);
    const b64 = body.response_format === 'b64_json';
    return {
      created: Math.floor(Date.now() / 1000),
      data: files.map((f) => (b64 ? { b64_json: readFileSync(f).toString('base64'), revised_prompt: j.prompt } : { url: this.mediaUrl(f), revised_prompt: j.prompt })),
    };
  }
}

function pickOptions(o: Record<string, unknown>): JobOptions {
  const out: JobOptions = {};
  if (o.aspect) out.aspect = o.aspect as JobOptions['aspect'];
  if (o.outputs ?? o.n) out.outputs = Number(o.outputs ?? o.n);
  if (o.model) out.model = String(o.model);
  if (o.duration ?? o.durationSec) out.durationSec = Number(o.duration ?? o.durationSec);
  if (o.folder) out.folder = String(o.folder);
  return out;
}

function isDone(j: JobSummary) {
  return TERMINAL_STATES.includes(j.state) || j.state === 'waiting_for_user';
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function tokenOk(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data, null, 2));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, 'Body too large.');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON.');
  }
}

function mime(f: string) {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' } as Record<string, string>)[extname(f).toLowerCase()] ?? 'application/octet-stream';
}

/** Relative outputs go next to the first input (or into ~/Downloads); absolute paths are kept. */
function resolveOutput(out: string, nearFile?: string): string {
  if (isAbsolute(out)) return out;
  if (nearFile && isAbsolute(nearFile)) {
    // Inputs live in Downloads/<root>/...; put "FlowForge/x.mp4" beside them, not in a nested copy.
    return join(dirname(nearFile), out.split(/[\\/]/).pop()!);
  }
  return join(homedir(), 'Downloads', out);
}
