import { describe, it, expect } from 'vitest';
import {
  splitTxt, parseCsv, rowsFromTable, rowsFromTxt, rowsFromJson, resolveReferences, findMentions,
  expandPrompt, countExpansions, renderFilename, dedupePath,
  transition, IllegalTransition, decideAfterFailure, backoffMs,
  newQueue, newJob, jobsFromRows, jobsFromStoryboard, scenesFromScript,
  validateWorkflow, compileWorkflow, bindNodeRefs, workflowFromJobs,
  verifyOutputs, sniffMime, verifyLicense, bytesToB64url, quotaRemaining, PLANS,
  safeSegment, redact, DEFAULT_QUEUE_SETTINGS,
} from '../src';
import type { Workflow, Storyboard } from '../src';

describe('txt import', () => {
  it('auto-detects one prompt per line and skips comments', () => {
    expect(splitTxt('a cat\n# note\n\nb dog\n').map((p) => p.text)).toEqual(['a cat', 'b dog']);
  });
  it('keeps multi-line prompts separated by blank lines', () => {
    const r = splitTxt('line one\nline two\n\nsecond prompt');
    expect(r.map((p) => p.text)).toEqual(['line one\nline two', 'second prompt']);
    expect(r[1].line).toBe(4);
  });
  it('honours --- and @@@NEXT@@@ delimiters', () => {
    expect(splitTxt('a\n\nstill a\n---\nb\n@@@NEXT@@@\nc').map((p) => p.text)).toEqual(['a\n\nstill a', 'b', 'c']);
  });
  it('parses inline directives', () => {
    const { rows } = rowsFromTxt('[mode: t2v] [aspect: portrait] [n: 3] A fox in snow');
    expect(rows[0]).toMatchObject({ prompt: 'A fox in snow', mode: 'text-to-video', options: { aspect: '9:16', outputs: 3 } });
  });
  it('infers frames-to-video from a start directive', () => {
    const { rows } = rowsFromTxt('[start: hero.png] hero walks forward');
    expect(rows[0].mode).toBe('frames-to-video');
    expect(rows[0].referenceNames).toEqual([{ role: 'start', name: 'hero.png' }]);
  });
});

describe('csv import', () => {
  it('handles quotes, embedded commas, newlines and semicolons', () => {
    expect(parseCsv('a,"b, c","d ""q"""\n1,"x\ny",3')).toEqual([['a', 'b, c', 'd "q"'], ['1', 'x\ny', '3']]);
    expect(parseCsv('p;aspect\nhi;9:16')).toEqual([['p', 'aspect'], ['hi', '9:16']]);
  });
  it('maps headers, unknown columns become vars, flags duplicates', () => {
    const table = parseCsv('Prompt,Ratio,Count,Mode,Hero\nA {{hero}} at dawn,9:16,2,video,Mira\nA {{hero}} at dawn,9:16,2,video,Mira\n,,,,\nsecond,square,9,image,x');
    const res = rowsFromTable(table);
    expect(res.rows).toHaveLength(3);
    expect(res.rows[0]).toMatchObject({ mode: 'text-to-video', options: { aspect: '9:16', outputs: 2 }, vars: { hero: 'Mira' } });
    expect(res.duplicates).toEqual([{ line: 3, duplicateOf: 2 }]);
    expect(res.rows[2].warnings[0]).toMatch(/Outputs must be 1-4/);
  });
});

describe('json import', () => {
  it('accepts arrays of strings and of objects', () => {
    expect(rowsFromJson('["a","b"]').rows.map((r) => r.prompt)).toEqual(['a', 'b']);
    const r = rowsFromJson('{"jobs":[{"prompt":"x","mode":"t2i","options":{"aspect":"1:1","outputs":4}}]}');
    expect(r.rows[0]).toMatchObject({ prompt: 'x', mode: 'text-to-image', options: { aspect: '1:1', outputs: 4 } });
  });
  it('reports invalid json', () => {
    expect(rowsFromJson('{oops').warnings[0]).toMatch(/Invalid JSON/);
  });
});

describe('references', () => {
  const assets = [{ id: 'a1', name: 'Mira_Hero.png', aliases: ['mira'] }, { id: 'a2', name: 'castle.jpg', aliases: [] }];
  it('resolves by file stem or alias, case and separator insensitive', () => {
    const r = resolveReferences([{ role: 'start', name: 'mira hero.PNG' }, { role: 'ingredient', name: '@castle' }, { role: 'end', name: 'nope' }], assets);
    expect(r.refs.map((x) => x.assetId)).toEqual(['a1', 'a2']);
    expect(r.missing).toEqual(['nope']);
  });
  it('finds @mentions', () => {
    expect(findMentions('@Mira walks to the @castle', assets).map((m) => m.assetId)).toEqual(['a1', 'a2']);
  });
});

describe('templates', () => {
  it('expands choice groups and vars', () => {
    expect(expandPrompt('a {red|blue} car at {{time}}', { time: 'dawn' })).toEqual(['a red car at dawn', 'a blue car at dawn']);
    expect(countExpansions('{a|b} {c|d|e}')).toBe(6);
    expect(expandPrompt('{a|b} {c|d|e}', {}, 4)).toHaveLength(4);
    expect(expandPrompt('literal \\{x|y\\}')).toEqual(['literal {x|y}']);
  });
  it('renders filenames with sub-folders, padding and variants', () => {
    const job = { id: 'j1', prompt: 'A Cat: on/the "roof"?', mode: 'text-to-image' as const, options: { aspect: '16:9' as const }, vars: { shot: 'wide' } };
    expect(renderFilename('{queue}/{index:03}_{slug}{variant}', { queue: 'My Q', index: 7, variant: 2, variantCount: 4, job })).toBe('My Q/007_a-cat-on-the-roof_v2');
    expect(renderFilename('{var.shot}_{aspect}', { queue: 'q', index: 1, job })).toBe('wide_16x9');
    expect(safeSegment('CON')).toBe('_CON');
  });
  it('dedupes paths', () => {
    expect(dedupePath('a/b.png', new Set(['a/b.png', 'a/b (2).png']))).toBe('a/b (3).png');
  });
});

describe('state machine and retries', () => {
  const q = newQueue('t');
  it('rejects skipping straight to success', () => {
    const j = transition(newJob(q, { prompt: 'x' }, 1), 'preparing');
    expect(() => transition(transition(j, 'submitting'), 'succeeded')).toThrow(IllegalTransition);
  });
  it('never retries captcha or unusual activity', () => {
    for (const code of ['CAPTCHA', 'UNUSUAL_ACTIVITY', 'SIGNED_OUT'] as const) {
      const d = decideAfterFailure(code, 1, 3, DEFAULT_QUEUE_SETTINGS);
      expect(d.pauseQueue).toBe(true);
      expect(d.state).toBe('waiting_for_user');
    }
  });
  it('backs off rate limits harder and gives up at max attempts', () => {
    const d1 = decideAfterFailure('RATE_LIMIT', 1, 3, DEFAULT_QUEUE_SETTINGS, 0, () => 0);
    const d2 = decideAfterFailure('NETWORK', 1, 3, DEFAULT_QUEUE_SETTINGS, 0, () => 0);
    expect(d1.retryAt!).toBeGreaterThan(d2.retryAt!);
    expect(decideAfterFailure('NETWORK', 3, 3, DEFAULT_QUEUE_SETTINGS).state).toBe('failed');
    expect(backoffMs(20, DEFAULT_QUEUE_SETTINGS, 1, () => 1)).toBe(DEFAULT_QUEUE_SETTINGS.backoffMaxSec * 1000);
  });
  it('skips policy blocks without pausing by default', () => {
    expect(decideAfterFailure('POLICY_VIOLATION', 1, 3, DEFAULT_QUEUE_SETTINGS)).toMatchObject({ state: 'policy_blocked', pauseQueue: false });
  });
});

describe('jobs', () => {
  it('applies queue defaults and expansions with a cap', () => {
    const q = newQueue('t', 'text-to-image');
    const { jobs, truncated } = jobsFromRows(q, [{ line: 1, prompt: '{a|b|c}', options: { aspect: '1:1' }, referenceNames: [], vars: {}, warnings: [] }], 1, 2);
    expect(jobs.map((j) => j.prompt)).toEqual(['a', 'b']);
    expect(truncated).toBe(1);
    expect(jobs[0].options).toMatchObject({ aspect: '1:1', outputs: 2 });
    expect(jobs[0].idempotencyKey).not.toBe(jobs[1].idempotencyKey);
  });
  it('chains storyboard scenes by last frame', () => {
    const q = newQueue('t', 'text-to-video');
    const sb: Storyboard = {
      id: 's', name: 'Short', aspect: '9:16', style: 'pixar-like 3D', characters: ['c1'], createdAt: 0, updatedAt: 0,
      scenes: scenesFromScript('Scene 1: Kitchen\nMira cracks an egg.\n\nShe gasps. "It\'s gold!"'),
    };
    const jobs = jobsFromStoryboard(q, sb, new Map([['c1', { displayName: 'Mira', description: 'a red-haired girl' }]]), 1);
    expect(jobs[0].mode).toBe('ingredients-to-video');
    expect(jobs[1].mode).toBe('frames-to-video');
    expect(jobs[1].dependsOn).toEqual([jobs[0].id]);
    expect(jobs[1].options.references).toEqual([{ role: 'start', assetId: `lastframe:${jobs[0].id}` }]);
    expect(jobs[1].prompt).toMatch(/Dialogue: "It's gold!"/);
    expect(jobs[0].prompt).toMatch(/Mira: a red-haired girl/);
  });
});

describe('workflow', () => {
  const wf: Workflow = {
    id: 'w', name: 'w', createdAt: 0, updatedAt: 0,
    nodes: [
      { id: 'p1', kind: 'prompt', position: { x: 0, y: 0 }, data: { text: 'hero portrait' } },
      { id: 'img', kind: 'image', position: { x: 0, y: 0 }, data: {} },
      { id: 'p2', kind: 'prompt', position: { x: 0, y: 0 }, data: { text: 'hero runs' } },
      { id: 'v1', kind: 'video', position: { x: 0, y: 0 }, data: {} },
      { id: 'lf', kind: 'lastFrame', position: { x: 0, y: 0 }, data: {} },
      { id: 'v2', kind: 'video', position: { x: 0, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e1', source: 'p1', target: 'img', targetHandle: 'prompt' },
      { id: 'e2', source: 'img', target: 'v1', targetHandle: 'start' },
      { id: 'e3', source: 'p2', target: 'v1', targetHandle: 'prompt' },
      { id: 'e4', source: 'v1', target: 'lf', targetHandle: 'video' },
      { id: 'e5', source: 'lf', target: 'v2', targetHandle: 'start' },
      { id: 'e6', source: 'p2', target: 'v2', targetHandle: 'prompt' },
    ],
  };
  it('validates and compiles in dependency order', () => {
    expect(validateWorkflow(wf).filter((i) => i.level === 'error')).toEqual([]);
    const steps = compileWorkflow(wf);
    expect(steps.map((s) => s.nodeId)).toEqual(['img', 'v1', 'v2']);
    expect(steps[1]).toMatchObject({ mode: 'frames-to-video', references: [{ role: 'start', assetId: 'node:img#1' }], dependsOnNodes: ['img'] });
    expect(steps[2].references[0].assetId).toBe('lastframe-node:v1');
    const bound = bindNodeRefs(steps[2].references, new Map([['v1', 'job9']]));
    expect(bound[0].assetId).toBe('lastframe:job9');
  });
  it('runs from a node using only its descendants', () => {
    expect(compileWorkflow(wf, 'v1').map((s) => s.nodeId)).toEqual(['v1', 'v2']);
  });
  it('flags type mismatches, missing inputs and loops', () => {
    const bad: Workflow = { ...wf, edges: [...wf.edges, { id: 'x', source: 'p1', target: 'v2', targetHandle: 'start' }, { id: 'y', source: 'v2', target: 'lf', targetHandle: 'video' }] };
    const msgs = validateWorkflow(bad).map((i) => i.message).join('\n');
    expect(msgs).toMatch(/Cannot plug text into image/);
    expect(msgs).toMatch(/Loop detected/);
    const lonely: Workflow = { ...wf, nodes: [{ id: 'v', kind: 'video', position: { x: 0, y: 0 }, data: {} }], edges: [] };
    expect(validateWorkflow(lonely).map((i) => i.message)).toContain('Generate video: connect "prompt".');
  });
  it('converts a queue into a chained graph', () => {
    const q = newQueue('t', 'text-to-video');
    const jobs = [newJob(q, { prompt: 'a' }, 1), newJob(q, { prompt: 'b' }, 2)];
    const g = workflowFromJobs(jobs, 'g', true);
    expect(validateWorkflow(g).filter((i) => i.level === 'error')).toEqual([]);
    expect(compileWorkflow(g)[1].references[0].assetId).toBe('lastframe-node:g0');
  });
});

describe('verification', () => {
  it('fails wrong media type and empty files, warns on aspect and count', () => {
    const r = verifyOutputs({ mode: 'text-to-video', aspect: '9:16', requestedOutputs: 2, outputs: [{ kind: 'image', width: 100, height: 100, bytes: 10 }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/expected video/);
    expect(r.warnings.join()).toMatch(/not 9:16/);
    expect(verifyOutputs({ mode: 'text-to-image', aspect: '16:9', outputs: [{ kind: 'image', width: 1376, height: 768, bytes: 90000 }] }).ok).toBe(true);
  });
  it('sniffs magic bytes', () => {
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(sniffMime(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBe('video/mp4');
  });
});

describe('license', () => {
  it('verifies an Ed25519-signed key and rejects tampering and expiry', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
    const sign = async (payload: object) => {
      const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
      const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(`FF1.${body}`)));
      return `FF1.${body}.${bytesToB64url(sig)}`;
    };
    const now = Date.now();
    const key = await sign({ v: 1, sub: 'a@b.c', plan: 'pro', iat: now / 1000, exp: now / 1000 + 3600, lid: 'L1' });
    expect((await verifyLicense(key, now, pub)).plan).toBe('pro');
    const tampered = key.replace(/\.([^.]+)\./, (_m, b) => `.${b.slice(0, -2)}xx.`);
    expect((await verifyLicense(tampered, now, pub)).plan).toBe('free');
    const old = await sign({ v: 1, sub: 'a', plan: 'pro', iat: 0, exp: 10, lid: 'L2' });
    expect((await verifyLicense(old, now, pub)).reason).toMatch(/expired/);
    expect((await verifyLicense(undefined, now, pub)).valid).toBe(true);
  });
  it('counts quota per day', () => {
    expect(quotaRemaining(PLANS.free, { day: '2026-10-19', used: 12 }, '2026-10-19')).toBe(18);
    expect(quotaRemaining(PLANS.free, { day: '2026-10-18', used: 30 }, '2026-10-19')).toBe(30);
    expect(quotaRemaining(PLANS.pro, { day: 'x', used: 1e6 }, 'y')).toBeNull();
  });
});

describe('redaction', () => {
  it('strips tokens, signatures and emails', () => {
    const s = redact('cookie: SID=abc123 https://x/y.png?X-Goog-Signature=deadbeef&ok=1 me@mail.com Bearer ya29.AbC');
    expect(s).not.toMatch(/abc123|deadbeef|me@mail|ya29\.AbC/);
  });
});

describe('txt auto split regression', () => {
  it('treats a block of single lines as one prompt per line', () => {
    expect(splitTxt('a\nb\nc').map((p) => p.text)).toEqual(['a', 'b', 'c']);
  });
});
