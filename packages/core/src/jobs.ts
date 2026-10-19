import type { GenerationMode, Job, JobOptions, Queue, ReferenceRef, Storyboard, CharacterSheet } from './types';
import { DEFAULT_QUEUE_SETTINGS, MODE_OUTPUT } from './types';
import type { RowDraft } from './importers';
import { expandPrompt, characterBlock } from './templates';
import { uid, fnv1a, normalizePrompt } from './util';
import { ADAPTER_VERSION } from './product';

export function newQueue(name: string, mode: GenerationMode = 'text-to-image', now = Date.now()): Queue {
  return {
    id: uid('q'),
    name,
    status: 'idle',
    settings: { ...DEFAULT_QUEUE_SETTINGS },
    defaults: { mode, outputs: MODE_OUTPUT[mode] === 'image' ? 2 : 1, aspect: '16:9' },
    createdAt: now,
    updatedAt: now,
  };
}

export interface NewJobInput {
  prompt: string;
  mode?: GenerationMode;
  options?: JobOptions;
  name?: string;
  vars?: Record<string, string>;
  dependsOn?: string[];
  references?: ReferenceRef[];
  workflowId?: string;
  nodeId?: string;
}

export function newJob(queue: Queue, input: NewJobInput, index: number, now = Date.now()): Job {
  const mode = input.mode ?? queue.defaults.mode;
  const { mode: _m, ...defaultOpts } = queue.defaults;
  const options: JobOptions = { ...defaultOpts, ...stripUndefined(input.options ?? {}) };
  // A video row in an image queue should not inherit "4 images per prompt" (and vice versa).
  if (MODE_OUTPUT[mode] !== MODE_OUTPUT[queue.defaults.mode] && input.options?.outputs === undefined) options.outputs = 1;
  if (input.references?.length) options.references = input.references;
  const id = uid('j');
  return {
    id,
    queueId: queue.id,
    // Unique per job, but stable for this job across retries and service-worker restarts.
    idempotencyKey: `${id}:${fnv1a(normalizePrompt(input.prompt) + mode)}`,
    index,
    name: input.name,
    prompt: input.prompt,
    mode,
    options,
    state: 'queued',
    attempts: 0,
    maxAttempts: queue.settings.maxAttempts,
    history: [{ from: 'draft', to: 'queued', at: now }],
    outputs: [],
    vars: input.vars,
    dependsOn: input.dependsOn,
    workflowId: input.workflowId,
    nodeId: input.nodeId,
    createdAt: now,
    updatedAt: now,
    adapterVersion: ADAPTER_VERSION,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

/** Rows to jobs, expanding `{a|b}` prompt templates. Returns how many rows were dropped by the cap. */
export function jobsFromRows(queue: Queue, rows: (RowDraft & { references?: ReferenceRef[] })[], startIndex: number, expansionLimit: number) {
  const jobs: Job[] = [];
  let truncated = 0;
  let index = startIndex;
  for (const r of rows) {
    const prompts = expandPrompt(r.prompt, r.vars, expansionLimit + 1);
    if (prompts.length > expansionLimit) truncated += prompts.length - expansionLimit;
    for (const p of prompts.slice(0, expansionLimit)) {
      jobs.push(newJob(queue, { prompt: p, mode: r.mode, options: r.options, name: r.name, vars: r.vars, references: r.references }, index++));
    }
  }
  return { jobs, truncated };
}

// ---------- storyboard ----------

export function storyboardPrompt(sb: Storyboard, scene: Storyboard['scenes'][number], sheets: CharacterSheet[]): string {
  const parts = [
    scene.shot && `${scene.shot} shot`,
    scene.action,
    scene.location && `Location: ${scene.location}.`,
    scene.camera && `Camera: ${scene.camera}.`,
    scene.dialogue && `Dialogue: "${scene.dialogue}"`,
    sb.style && `Style: ${sb.style}.`,
  ].filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim() + characterBlock(sheets);
}

/**
 * Compiles scenes into jobs. `last-frame` continuity makes a scene start from the previous
 * scene's final frame and wait for it; `same-references` reuses the character images.
 */
export function jobsFromStoryboard(queue: Queue, sb: Storyboard, sheetsById: Map<string, CharacterSheet>, startIndex: number): Job[] {
  const jobs: Job[] = [];
  let prev: Job | undefined;
  sb.scenes.forEach((scene, i) => {
    const castIds = scene.characters?.length ? scene.characters : sb.characters;
    const sheets = castIds.map((id) => sheetsById.get(id)).filter(Boolean) as CharacterSheet[];
    const refs: ReferenceRef[] = [];
    let mode: GenerationMode = scene.mode ?? 'text-to-video';
    let dependsOn: string[] | undefined;
    if (scene.continuity === 'last-frame' && prev && MODE_OUTPUT[prev.mode] === 'video') {
      refs.push({ role: 'start', assetId: `lastframe:${prev.id}` });
      mode = 'frames-to-video';
      dependsOn = [prev.id];
    } else if ((scene.continuity === 'same-references' || !scene.mode) && castIds.length && mode === 'text-to-video') {
      castIds.forEach((id) => refs.push({ role: 'ingredient', assetId: id }));
      mode = 'ingredients-to-video';
    }
    const job = newJob(
      queue,
      {
        prompt: storyboardPrompt(sb, scene, sheets),
        mode,
        name: scene.title || `Scene ${i + 1}`,
        options: { aspect: sb.aspect, durationSec: scene.durationSec, outputs: 1, folder: sb.name },
        references: refs,
        dependsOn,
        vars: { scene: String(i + 1), storyboard: sb.name },
      },
      startIndex + i,
    );
    jobs.push(job);
    prev = job;
  });
  return jobs;
}

/** Rough script -> scenes splitter: paragraphs become scenes, quoted lines become dialogue. */
export function scenesFromScript(script: string): Storyboard['scenes'] {
  return script
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p, i) => {
      const dlg = /["“]([^"”]+)["”]/.exec(p)?.[1];
      const heading = /^(?:scene\s*\d+[:.)-]?\s*|int\.|ext\.)(.*)$/im.exec(p.split('\n')[0]);
      const body = heading ? p.split('\n').slice(1).join(' ').trim() || heading[1] : p.replace(/\n/g, ' ');
      return {
        id: uid('sc'),
        title: heading?.[1]?.trim() || `Scene ${i + 1}`,
        action: body.replace(/["“][^"”]+["”]/g, '').replace(/\s+/g, ' ').trim() || body,
        dialogue: dlg,
        continuity: i === 0 ? 'none' : 'last-frame',
      } as Storyboard['scenes'][number];
    });
}
