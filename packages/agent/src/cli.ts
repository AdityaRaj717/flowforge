import { readFileSync } from 'node:fs';
import { PRODUCT_VERSION, rowsFromTxt } from '@flowforge/core';
import { CONFIG_DIR, loadConfig, rotateToken } from './config';
import { Agent } from './server';
import { api } from './client';
import { ffmpegVersion } from './ffmpeg';

const HELP = `FlowForge agent ${PRODUCT_VERSION}: local API, MCP server and FFmpeg tools for the FlowForge extension.

  flowforge-agent serve                 start the agent on 127.0.0.1 (keep it running)
  flowforge-agent token [--rotate]      print the pairing token for the extension
  flowforge-agent mcp                   MCP server over stdio (point Claude/Cursor at this)
  flowforge-agent status                extension, plan, Flow tabs, queues
  flowforge-agent gen "prompt" [...]    queue prompts   --mode t2v --aspect 9:16 -n 2 --model "..." --queue NAME --wait
  flowforge-agent gen --file prompts.txt
  flowforge-agent jobs [--state failed] [--limit 20]
  flowforge-agent wait JOB_ID [--timeout 600]
  flowforge-agent merge out.mp4 a.mp4 b.mp4 ...
  flowforge-agent lastframe clip.mp4 [out.png]
  flowforge-agent doctor                check FFmpeg, config and the connection

Config and token live in ${CONFIG_DIR}. The agent never sees your Google session.`;

const MODE_ALIAS: Record<string, string> = { t2i: 'text-to-image', i2i: 'image-to-image', t2v: 'text-to-video', i2v: 'frames-to-video', f2v: 'frames-to-video', ingredients: 'ingredients-to-video' };

function flags(argv: string[]) {
  const pos: string[] = [];
  const f: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) f[k] = true;
      else {
        f[k] = v;
        i++;
      }
    } else if (a === '-n') f.n = argv[++i];
    else pos.push(a);
  }
  return { pos, f };
}

const out = (v: unknown) => process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n`);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, f } = flags(rest);
  switch (cmd) {
    case 'serve': {
      const cfg = loadConfig();
      const agent = new Agent(cfg);
      try {
        await agent.listen();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`Port ${cfg.port} is busy. Is another agent running? Set FLOWFORGE_PORT to use a different one.`);
        throw e;
      }
      const ff = await ffmpegVersion(cfg.ffmpeg);
      process.stderr.write(
        `FlowForge agent ${PRODUCT_VERSION} on http://127.0.0.1:${cfg.port}\n` +
          `Pairing token: ${cfg.token}\n` +
          `Paste it in FlowForge → Settings → Local agent, then tick "Connect to the local agent".\n` +
          `FFmpeg: ${ff ?? 'not found (merging and frame tools will fail; set FFMPEG_PATH)'}\n`,
      );
      return;
    }
    case 'token': {
      const cfg = f.rotate ? rotateToken() : loadConfig();
      out(cfg.token);
      return;
    }
    case 'mcp': {
      const { runMcp } = await import('./mcp');
      await runMcp();
      return;
    }
    case 'status':
      return out(await api('GET', '/v1/status'));
    case 'gen': {
      let prompts = pos;
      if (typeof f.file === 'string') prompts = rowsFromTxt(readFileSync(f.file, 'utf8')).rows.map((r) => r.prompt);
      if (!prompts.length) throw new Error('Give at least one prompt, or --file prompts.txt');
      const mode = typeof f.mode === 'string' ? MODE_ALIAS[f.mode] ?? f.mode : undefined;
      const r = await api<{ queueId: string; jobIds: string[] }>('POST', '/v1/jobs', {
        items: prompts.map((prompt) => ({ prompt })),
        mode,
        options: { aspect: f.aspect, outputs: f.n ? Number(f.n) : undefined, model: f.model, durationSec: f.duration ? Number(f.duration) : undefined },
        queue: typeof f.queue === 'string' ? f.queue : 'CLI',
      });
      if (!f.wait) return out(r);
      for (const id of r.jobIds) {
        const j = await api<{ state: string; outputs: { savedPath?: string }[]; error?: { message: string } }>('GET', `/v1/jobs/${id}/wait?timeout=${f.timeout ?? 900}`);
        out(`${id}  ${j.state}  ${j.outputs?.map((o) => o.savedPath).filter(Boolean).join('  ') || j.error?.message || ''}`);
      }
      return;
    }
    case 'jobs':
      return out(await api('GET', `/v1/jobs?limit=${f.limit ?? 20}${typeof f.state === 'string' ? `&state=${f.state}` : ''}${typeof f.queue === 'string' ? `&queue=${f.queue}` : ''}`));
    case 'wait':
      if (!pos[0]) throw new Error('wait JOB_ID');
      return out(await api('GET', `/v1/jobs/${pos[0]}/wait?timeout=${f.timeout ?? 600}`));
    case 'merge':
      if (pos.length < 2) throw new Error('merge OUT.mp4 CLIP1 CLIP2 ...');
      return out(await api('POST', '/v1/post/merge', { output: pos[0], files: pos.slice(1), loudnorm: !!f.loudnorm }));
    case 'lastframe':
      if (!pos[0]) throw new Error('lastframe CLIP [OUT.png]');
      return out(await api('POST', '/v1/post/lastframe', { file: pos[0], output: pos[1] }));
    case 'doctor': {
      const cfg = loadConfig();
      out(`config     ${CONFIG_DIR}`);
      out(`port       ${cfg.port}`);
      out(`ffmpeg     ${(await ffmpegVersion(cfg.ffmpeg)) ?? 'NOT FOUND'}`);
      try {
        const s = await api<{ extensionConnected: boolean; plan?: string }>('GET', '/v1/status');
        out(`agent      running`);
        out(`extension  ${s.extensionConnected ? `connected (${s.plan} plan)` : 'not connected: enable it in FlowForge Settings'}`);
      } catch (e) {
        out(`agent      ${(e as Error).message}`);
      }
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return out(HELP);
    case '--version':
    case 'version':
      return out(PRODUCT_VERSION);
    default:
      throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

main().catch((e) => {
  process.stderr.write(`flowforge-agent: ${(e as Error).message}\n`);
  process.exit(1);
});
