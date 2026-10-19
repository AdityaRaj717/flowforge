// End-to-end run of the real extension against the mock Flow page. No Google account, no credits.
//   node packages/extension/build.mjs --dev && node packages/extension/test/e2e.mjs
// Env: FF_CHROME=path to a Chromium that allows --load-extension, FF_E2E_DIR=scratch dir, HEADED=1.
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from '../mock/serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(here, '../dist');
const scratch = process.env.FF_E2E_DIR ?? 'D:/tmp_render/flowforge-e2e';
const profile = join(scratch, 'profile');
const downloads = join(scratch, 'downloads');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(downloads, { recursive: true });

function findChrome() {
  if (process.env.FF_CHROME) return process.env.FF_CHROME;
  const base = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    const p = join(base, d, 'chrome-win64', 'chrome.exe');
    if (existsSync(p)) return p;
  }
  return undefined;
}

const server = await startMock();
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findChrome(),
  headless: !process.env.HEADED,
  acceptDownloads: true,
  downloadsPath: downloads,
  viewport: { width: 1280, height: 860 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

const results = [];
const dump = (j) => j && console.log('   ', JSON.stringify({ state: j.state, err: j.err, msg: j.msg, outs: j.outs, hist: j.hist }, null, 1).slice(0, 1500));
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  await sw.evaluate(async (dir) => {
    await chrome.storage.local.set({ 'ff.settings': { devMode: true, settleSec: 2, notifications: false, freshSessionPerJob: true, autoApproveAgent: true, optionStrategy: 'auto', extractLastFrames: 'chains' } });
    await chrome.downloads.setShelfEnabled?.(false);
    return dir;
  }, downloads);

  const flow = await ctx.newPage();
  await flow.goto('http://localhost:5179/');
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?full=1`);
  await panel.waitForSelector('.topbar');

  // Wait for the mock tab to register as a worker.
  const ready = await panel.waitForFunction(async () => {
    const s = await chrome.runtime.sendMessage({ t: 'getState' });
    return s?.ok && s.data.engine.workers.some((w) => w.page === 'ready');
  }, null, { timeout: 20000 }).then(() => true).catch(() => false);
  check('mock Flow tab registers as a ready worker', ready);

  const send = (msg) => panel.evaluate(async (m) => {
    const r = await chrome.runtime.sendMessage(m);
    if (!r?.ok) throw new Error(r?.error ?? 'no reply');
    return r.data;
  }, msg);

  const q = await send({ t: 'createQueue', name: 'E2E', mode: 'text-to-image' });
  await send({ t: 'updateQueue', queueId: q.id, patch: { settings: { delayMinSec: 0, delayMaxSec: 1, backoffBaseSec: 1, backoffMaxSec: 2, maxAttempts: 2, generationTimeoutSec: 60, circuitBreakerFailures: 10 } } });

  // Add prompts through the real UI (quick add box).
  await panel.reload();
  await panel.waitForSelector('textarea');
  await panel.fill('textarea', [
    'a red fox in snow [n: 2] [aspect: 9:16]',
    'a lighthouse at dusk [mode: t2v] [aspect: 16:9]',
    'forbidden thing that flow refuses',
    'approve a castle on a hill',
    'noimage just chat',
  ].join('\n'));
  await panel.click('text=Add to queue');
  await panel.waitForTimeout(800);

  const jobs = () => panel.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('flowforge');
    r.onsuccess = () => {
      const g = r.result.transaction('jobs').objectStore('jobs').getAll();
      g.onsuccess = () => res(g.result.map((j) => ({ id: j.id, i: j.index, state: j.state, mode: j.mode, err: j.error?.code, outs: j.outputs.map((o) => ({ kind: o.kind, w: o.width, h: o.height, saved: !!o.savedPath, path: o.savedPath, lf: !!o.lastFrameAssetId, notes: o.verifyNotes, bytes: o.bytes })), hist: j.history.slice(-8).map((h) => `${h.from}>${h.to} ${h.note ?? ''}`), msg: j.error?.message, refs: j.options.references?.length ?? 0, prompt: j.prompt })));
    };
  }));

  const added = await jobs();
  check('quick add created 5 jobs with inline settings', added.length === 5 && added.find((j) => j.prompt.includes('lighthouse'))?.mode === 'text-to-video', `${added.length} jobs`);

  await send({ t: 'control', queueId: q.id, action: 'start' });
  const terminal = ['succeeded', 'failed', 'policy_blocked', 'unsupported', 'cancelled', 'download_failed', 'verification_failed', 'waiting_for_user'];
  const t0 = Date.now();
  let js = [];
  while (Date.now() - t0 < 240_000) {
    js = await jobs();
    if (js.every((j) => terminal.includes(j.state))) break;
    await panel.waitForTimeout(1500);
  }
  const by = (s) => js.find((j) => j.prompt.includes(s));
  const fox = by('red fox');
  check('image job succeeds with 2 verified 9:16 outputs saved to disk', fox?.state === 'succeeded' && fox.outs.length === 2 && fox.outs.every((o) => o.saved && o.h > o.w), JSON.stringify(fox?.outs.map((o) => [o.w, o.h, o.saved])));
  const lh = by('lighthouse');
  check('video job succeeds and is saved', lh?.state === 'succeeded' && lh.outs[0]?.kind === 'video' && lh.outs[0].saved, `${lh?.state} ${lh?.err ?? ''}`);
  check('policy refusal is skipped, not retried', by('forbidden')?.state === 'policy_blocked', by('forbidden')?.state);
  check('agent approval is clicked automatically', by('castle')?.state === 'succeeded', by('castle')?.state);
  if (by('castle')?.state !== 'succeeded') dump(by('castle'));
  const chat = by('noimage');
  check('text-only answer fails as NO_OUTPUT after retries', chat?.state === 'failed' && chat.err === 'NO_OUTPUT', `${chat?.state} ${chat?.err}`);

  // Captcha must pause the whole queue and wait for the person.
  await send({ t: 'addJobs', queueId: q.id, jobs: [] });
  await panel.fill('textarea', 'captcha please\nafter the captcha');
  await panel.click('text=Add to queue');
  await panel.waitForTimeout(500);
  await send({ t: 'control', queueId: q.id, action: 'start' });
  let paused = false;
  for (let i = 0; i < 40 && !paused; i++) {
    await panel.waitForTimeout(1000);
    const qs = await panel.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('flowforge');
      r.onsuccess = () => {
        const g = r.result.transaction('queues').objectStore('queues').getAll();
        g.onsuccess = () => res(g.result);
      };
    }));
    paused = qs.some((x) => x.status === 'paused' && /verification/i.test(x.pausedReason ?? ''));
  }
  js = await jobs();
  check('captcha pauses the queue for the user', paused && by('captcha please')?.state === 'waiting_for_user' && ['paused', 'queued'].includes(by('after the captcha')?.state), `${by('captcha please')?.state} / ${by('after the captcha')?.state}`);
  if (!paused || by('captcha please')?.state !== 'waiting_for_user') {
    const logs = await panel.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('flowforge');
      r.onsuccess = () => {
        const g = r.result.transaction('logs').objectStore('logs').getAll();
        g.onsuccess = () => res(g.result.sort((a, b) => a.at - b.at).slice(-25).map((l) => `${l.level} ${l.scope} ${l.message}`));
      };
    }));
    console.log(logs.join(String.fromCharCode(10)));
    js.forEach((j) => console.log('   ', j.i, j.state, j.prompt.slice(0, 30)));
  }
  await send({ t: 'control', queueId: q.id, action: 'stop' });
  await flow.reload();
  await panel.waitForTimeout(2500);

  // Storyboard: two video scenes, the second continues from the first one's last frame.
  const sbId = await panel.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('flowforge');
    r.onsuccess = () => {
      const sb = {
        id: 'sb_e2e', name: 'E2E story', aspect: '16:9', style: 'clay animation', characters: [], createdAt: Date.now(), updatedAt: Date.now(),
        scenes: [
          { id: 's1', title: 'Opening', action: 'a clay boat on a pond video', continuity: 'none', mode: 'text-to-video' },
          { id: 's2', title: 'Next', action: 'the boat reaches the shore video', continuity: 'last-frame' },
        ],
      };
      const tx = r.result.transaction('storyboards', 'readwrite');
      tx.objectStore('storyboards').put(sb);
      tx.oncomplete = () => res(sb.id);
    };
  }));
  const run = await send({ t: 'runStoryboard', storyboardId: sbId });
  const t1 = Date.now();
  let chain = [];
  while (Date.now() - t1 < 150_000) {
    chain = (await jobs()).filter((j) => run.jobIds.includes(j.id)).sort((a, b) => a.i - b.i);
    if (chain.length === 2 && chain.every((j) => terminal.includes(j.state))) break;
    await panel.waitForTimeout(1500);
  }
  check('scene 1 saves its last frame', chain[0]?.state === 'succeeded' && chain[0].outs[0]?.lf, `${chain[0]?.state} ${chain[0]?.err ?? ''}`);
  check('scene 2 starts from that frame (frames-to-video with an attached reference)', chain[1]?.state === 'succeeded' && chain[1].mode === 'frames-to-video' && chain[1].refs === 1, `${chain[1]?.state} ${chain[1]?.err ?? ''} mode=${chain[1]?.mode}`);

  if (chain[1]?.state !== 'succeeded') dump(chain[1]);
  const files = readdirSync(downloads);
  check('files landed in the downloads folder', files.length >= 4, `${files.length} files`);

  // Pro features: license, local agent bridge, REST + OpenAI-style API, FFmpeg merge.
  const root = resolve(here, '../../..');
  const privKey = join(root, 'tools/license/private.key');
  if (existsSync(privKey)) {
    const { execFileSync, spawn } = await import('node:child_process');
    const key = execFileSync(process.execPath, [join(root, 'tools/license.mjs'), 'sign', '--sub', 'e2e@test.local', '--plan', 'pro', '--days', '1']).toString().trim();
    const lic = await send({ t: 'setLicense', key });
    check('signed Pro license activates', lic.plan === 'pro' && lic.valid, lic.reason ?? lic.plan);

    const home = join(scratch, 'agent-home');
    const env = { ...process.env, FLOWFORGE_HOME: home, FLOWFORGE_PORT: '47399', FLOWFORGE_QUIET: '1' };
    const cli = join(root, 'packages/agent/dist/cli.mjs');
    const token = execFileSync(process.execPath, [cli, 'token'], { env }).toString().trim();
    const agentProc = spawn(process.execPath, [cli, 'serve'], { env, stdio: 'ignore' });
    try {
      await panel.waitForTimeout(1200);
      await sw.evaluate(async (t) => {
        const cur = (await chrome.storage.local.get('ff.settings'))['ff.settings'] ?? {};
        await chrome.storage.local.set({ 'ff.settings': { ...cur, agentEnabled: true, agentToken: t, agentPort: 47399 } });
      }, token);
      await send({ t: 'agentReconnect' });
      const linked = await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ t: 'getState' }))?.data?.agent?.connected, null, { timeout: 15000 }).then(() => true).catch(() => false);
      check('extension pairs with the local agent', linked);

      const rest = async (method, path, body) => {
        const r = await fetch(`http://127.0.0.1:47399${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
        return r.json();
      };
      const made = await rest('POST', '/v1/jobs', { prompt: 'made through the REST API', aspect: '1:1', outputs: 1, queue: 'API' });
      const done = made.jobIds ? await rest('GET', `/v1/jobs/${made.jobIds[0]}/wait?timeout=120`) : made;
      check('REST job runs in the Flow tab and reports the saved file', done.state === 'succeeded' && !!done.outputs?.[0]?.savedPath, `${done.state ?? done.error} ${done.outputs?.[0]?.savedPath ?? ''}`);
      const oa = await rest('POST', '/v1/images/generations', { prompt: 'openai style request', n: 1, size: '1024x1024', response_format: 'b64_json' });
      check('OpenAI-compatible /v1/images/generations returns image data', (oa.data?.[0]?.b64_json?.length ?? 0) > 1000, oa.error ?? `${oa.data?.length} image(s)`);

      const clips = (await jobs()).filter((j) => j.mode === 'text-to-video' || j.mode === 'frames-to-video').flatMap((j) => j.outs.filter((o) => o.kind === 'video' && o.path).map((o) => o.path));
      const merged = await rest('POST', '/v1/post/merge', { files: clips.slice(0, 3), output: join(scratch, 'merged.mp4') });
      check('agent merges generated clips with FFmpeg', !!merged.output && existsSync(merged.output) && merged.durationSec > 1, merged.error ?? `${clips.length} clips -> ${merged.durationSec?.toFixed?.(1)}s`);
    } finally {
      agentProc.kill();
    }
  } else {
    console.log('SKIP  Pro/agent checks (no tools/license/private.key)');
  }

  // ---- Mock of the real Flow agent UI: Agent settings panel, picker upload, agreement, confirmation ----
  await flow.close();
  const flow2 = await ctx.newPage();
  await flow2.goto('http://localhost:5179/project/agent');
  await panel.waitForFunction(async () => {
    const s = await chrome.runtime.sendMessage({ t: 'getState' });
    return s?.ok && s.data.engine.workers.some((w) => w.page === 'ready' && w.url.includes('/project/agent'));
  }, null, { timeout: 20000 }).catch(() => {});
  const q2 = await send({ t: 'createQueue', name: 'AgentUI', mode: 'text-to-image' });
  await send({ t: 'updateQueue', queueId: q2.id, patch: { settings: { delayMinSec: 0, delayMaxSec: 1, backoffBaseSec: 1, backoffMaxSec: 2, maxAttempts: 2, generationTimeoutSec: 60 } } });
  await panel.evaluate(() => new Promise((res) => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 300;
    c.getContext('2d').fillRect(0, 0, 300, 300);
    c.toBlob((blob) => {
      const r = indexedDB.open('flowforge');
      r.onsuccess = () => {
        const tx = r.result.transaction(['assets', 'blobs'], 'readwrite');
        tx.objectStore('blobs').put(blob, 'b_mira');
        tx.objectStore('assets').put({ id: 'a_mira', name: 'mira.png', kind: 'image', mime: 'image/png', blobKey: 'b_mira', bytes: blob.size, tags: [], aliases: ['mira'], source: 'upload', createdAt: Date.now() });
        tx.oncomplete = () => res(true);
      };
    }, 'image/png');
  }));
  await panel.click('role=tab[name="Queue"]');
  await panel.reload();
  await panel.waitForSelector('select[aria-label="Queue"]');
  await panel.selectOption('select[aria-label="Queue"]', q2.id);
  await panel.fill('textarea', 'a tall tower [aspect: 9:16] [n: 3] [model: Nano Banana Pro]\na portrait of @mira [mode: t2i]');
  await panel.click('text=Add to queue');
  await panel.waitForTimeout(600);
  await send({ t: 'control', queueId: q2.id, action: 'start' });
  const q2jobs = async () => (await jobs()).filter((j) => /tall tower|@mira|red apple/.test(j.prompt));
  let a2 = [];
  for (let i = 0; i < 90; i++) {
    a2 = await q2jobs();
    const t = a2.find((j) => j.prompt.includes('tower'));
    const m = a2.find((j) => j.prompt.includes('@mira'));
    if (t && m && terminal.includes(t.state) && terminal.includes(m.state)) break;
    await panel.waitForTimeout(1000);
  }
  const tower = a2.find((j) => j.prompt.includes('tower'));
  const flowSaved = await flow2.evaluate(() => saved.image);
  check("what's-new dialog is closed automatically", !(await flow2.locator('text=View all changelogs').count()));
  // The tower job set 9:16 x3 + Nano Banana Pro; the next job switched ratio/count back to its own 16:9 x2.
  check('per-job ratio, count and model are set in Flow\'s Agent settings panel', flowSaved.aspect === '16:9' && flowSaved.count === 2 && flowSaved.model === 'Nano Banana Pro', JSON.stringify(flowSaved));
  check('tower job: 3 verified 9:16 images', tower?.state === 'succeeded' && tower.outs.length === 3 && tower.outs.every((o) => o.h > o.w), `${tower?.state} ${tower?.outs.length}`);
  const mira = a2.find((j) => j.prompt.includes('@mira'));
  check('upload agreement pauses for the user instead of being accepted', mira?.state === 'waiting_for_user' && mira.err === 'NEEDS_CONSENT', `${mira?.state} ${mira?.err ?? ''} ${mira?.msg ?? ''}`);
  if (mira?.state !== 'waiting_for_user') dump(mira);

  // The person accepts it in Flow, then resumes.
  await flow2.click('text=I agree').catch(() => {});
  await send({ t: 'control', queueId: q2.id, action: 'resume' });
  for (let i = 0; i < 60; i++) {
    const m = (await q2jobs()).find((j) => j.prompt.includes('@mira'));
    if (m && terminal.includes(m.state) && m.state !== 'waiting_for_user') break;
    await panel.waitForTimeout(1000);
  }
  const mira2 = (await q2jobs()).find((j) => j.prompt.includes('@mira'));
  const usedRef = await flow2.evaluate(() => document.getElementById('log').innerText.includes('1 ref'));
  check('reference image is uploaded through Flow\'s picker and used', mira2?.state === 'succeeded' && mira2.refs === 1 && usedRef, `${mira2?.state} ${mira2?.err ?? ''} refUsed=${usedRef}`);
  if (mira2?.state !== 'succeeded') dump(mira2);

  // "Confirm before generating: Always" → the agent's Generate button is clicked.
  await flow2.evaluate(() => (document.getElementById('always').checked = true));
  await panel.fill('textarea', 'a red apple');
  await panel.click('text=Add to queue');
  await panel.waitForTimeout(500);
  await send({ t: 'control', queueId: q2.id, action: 'start' });
  let apple;
  for (let i = 0; i < 60; i++) {
    apple = (await q2jobs()).find((j) => j.prompt.includes('red apple'));
    if (apple && terminal.includes(apple.state)) break;
    await panel.waitForTimeout(1000);
  }
  const userMsgs = await flow2.evaluate(() => document.querySelectorAll('.msg.user').length);
  check("agent's confirmation button is clicked once, prompt not resubmitted", apple?.state === 'succeeded' && userMsgs === 1, `${apple?.state} userMessages=${userMsgs}`);

  // Workflow canvas renders.
  await panel.click('role=tab[name="Workflow"]');
  await panel.waitForTimeout(800);
  await panel.selectOption('select[aria-label="From template"]', '3-shot chain').catch(() => {});
  await panel.waitForTimeout(1200);
  const nodes = await panel.locator('.ffnode').count();
  check('workflow template renders on the canvas', nodes >= 9, `${nodes} nodes`);
  mkdirSync(join(scratch, 'shots'), { recursive: true });
  await panel.screenshot({ path: join(scratch, 'shots', 'workflow.png') });
  await panel.click('role=tab[name="Queue"]');
  await panel.waitForTimeout(600);
  await panel.setViewportSize({ width: 420, height: 860 });
  await panel.screenshot({ path: join(scratch, 'shots', 'queue.png'), fullPage: false });
  await panel.click('role=tab[name="Library"]');
  await panel.waitForTimeout(800);
  await panel.screenshot({ path: join(scratch, 'shots', 'library.png') });
} catch (e) {
  check('e2e run completed without crashing', false, e.message);
} finally {
  await ctx.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${join(scratch, 'shots')}`);
process.exit(failed.length ? 1 : 0);
