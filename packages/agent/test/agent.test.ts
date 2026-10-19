import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Agent } from '../src/server';
import * as ff from '../src/ffmpeg';

const port = 47000 + Math.floor(Math.random() * 900);
const token = 'test-token-123';
const dir = mkdtempSync(join(tmpdir(), 'ff-agent-'));
const png = join(dir, 'out.png');
writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4000)]));

let agent: Agent;
let server: Awaited<ReturnType<Agent['listen']>>;
let ext: WebSocket;

const http = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

beforeAll(async () => {
  process.env.FLOWFORGE_QUIET = '1';
  agent = new Agent({ port, token, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  server = await agent.listen();
  // A fake extension: answers enqueue, then reports the job as finished.
  ext = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { headers: { origin: 'chrome-extension://abc' } });
  await new Promise<void>((resolve) => ext.on('open', () => resolve()));
  ext.send(JSON.stringify({ t: 'auth', token, protocol: 1 }));
  ext.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'enqueue') {
      ext.send(JSON.stringify({ t: 'reply', reqId: m.reqId, ok: true, data: { queueId: 'q1', jobIds: ['j1'] } }));
      setTimeout(() => ext.send(JSON.stringify({
        t: 'jobUpdate',
        job: { id: 'j1', queueId: 'q1', index: 1, prompt: m.items[0].prompt, mode: 'text-to-image', state: 'succeeded', attempts: 1, outputs: [{ kind: 'image', savedPath: png }], updatedAt: Date.now() },
      })), 50);
    }
    if (m.t === 'status') ext.send(JSON.stringify({ t: 'reply', reqId: m.reqId, ok: true, data: { workers: [] } }));
  });
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(() => {
  ext?.close();
  server?.close();
});

describe('agent security', () => {
  it('requires the token', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/queues`);
    expect(r.status).toBe(401);
  });
  it('refuses calls from web pages', async () => {
    const r = await http('/v1/status', { headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
  });
  it('refuses a bridge socket with a wrong token', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { headers: { origin: 'chrome-extension://abc' } });
    await new Promise<void>((r) => bad.on('open', () => r()));
    bad.send(JSON.stringify({ t: 'auth', token: 'nope', protocol: 1 }));
    const code = await new Promise<number>((r) => bad.on('close', (c) => r(c)));
    expect(code).toBe(4003);
  });
  it('refuses a bridge socket from a non-extension origin', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { headers: { origin: 'https://evil.example' } });
    const err = await new Promise<boolean>((r) => {
      bad.on('error', () => r(true));
      bad.on('open', () => r(false));
    });
    expect(err).toBe(true);
  });
});

describe('agent API', () => {
  it('reports health and connection', async () => {
    const r = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(r.extensionConnected).toBe(true);
  });
  it('queues jobs and waits for them', async () => {
    const r = await (await http('/v1/jobs', { method: 'POST', body: JSON.stringify({ prompt: 'a cat', aspect: '1:1' }) })).json();
    expect(r.jobIds).toEqual(['j1']);
    const j = await (await http('/v1/jobs/j1/wait?timeout=5')).json();
    expect(j.state).toBe('succeeded');
    expect(j.outputs[0].url).toMatch(/\/v1\/media\/[a-f0-9]{32}\.png$/);
    const media = await fetch(j.outputs[0].url);
    expect(media.headers.get('content-type')).toBe('image/png');
  });
  it('speaks the OpenAI images API', async () => {
    const r = await (await http('/v1/images/generations', { method: 'POST', body: JSON.stringify({ prompt: 'a dog', n: 1, size: '1024x1024', response_format: 'b64_json' }) })).json();
    expect(r.data[0].b64_json.length).toBeGreaterThan(100);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
describe.skipIf(!hasFfmpeg)('ffmpeg tools', () => {
  it('merges clips of different sizes and extracts the last frame', async () => {
    const a = join(dir, 'a.mp4');
    const b = join(dir, 'b.mp4');
    spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=1', '-f', 'lavfi', '-i', 'sine=d=1', '-shortest', a]);
    spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=1', b]);
    const out = join(dir, 'merged.mp4');
    const info = await ff.merge('ffmpeg', 'ffprobe', [a, b], out);
    expect(info.width).toBe(640);
    expect(info.durationSec).toBeGreaterThan(1.8);
    expect(info.hasAudio).toBe(true);
    const frame = await ff.lastFrame('ffmpeg', out, join(dir, 'last.png'));
    expect(existsSync(frame)).toBe(true);
  }, 60_000);
});
