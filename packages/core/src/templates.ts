import type { CharacterSheet, Job } from './types';
import { safeSegment, slugify } from './util';

// ---------- prompt templates ----------

/**
 * Expands `{a|b|c}` choice groups into every combination, and fills `{{var}}` from vars.
 *   "a {red|blue} car at {dawn|night}" -> 4 prompts
 * Escaped braces (`\{`) are left alone. `limit` guards against accidental explosions.
 */
export function expandPrompt(template: string, vars: Record<string, string> = {}, limit = 500): string[] {
  const filled = fillVars(template, vars);
  const parts: (string | string[])[] = [];
  const re = /(?<!\\)\{([^{}]*\|[^{}]*)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(filled))) {
    parts.push(filled.slice(last, m.index));
    parts.push(m[1].split('|').map((s) => s.trim()));
    last = m.index + m[0].length;
  }
  parts.push(filled.slice(last));
  let acc = [''];
  for (const p of parts) {
    if (typeof p === 'string') acc = acc.map((a) => a + p);
    else {
      const next: string[] = [];
      for (const a of acc) for (const opt of p) {
        next.push(a + opt);
        if (next.length >= limit) break;
      }
      acc = next.slice(0, limit);
    }
  }
  return acc.map((s) => s.replace(/\\([{}])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim()).filter(Boolean);
}

export function countExpansions(template: string): number {
  const re = /(?<!\\)\{([^{}]*\|[^{}]*)\}/g;
  let n = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) n *= m[1].split('|').length;
  return n;
}

export function fillVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, k) => (k in vars ? vars[k] : all));
}

/** Continuity text appended for characters attached to a job, so every scene restates the locks. */
export function characterBlock(sheets: CharacterSheet[]): string {
  if (!sheets.length) return '';
  const lines = sheets.map((c) => {
    const bits = [c.description, c.wardrobe && `wearing ${c.wardrobe}`, ...(c.locks ?? [])].filter(Boolean);
    const avoid = c.avoid?.length ? ` Avoid: ${c.avoid.join(', ')}.` : '';
    return `${c.displayName}: ${bits.join('; ')}.${avoid}`;
  });
  return `\n\nCharacters (keep consistent): ${lines.join(' ')}`;
}

// ---------- filenames ----------

export interface FilenameContext {
  queue: string;
  project?: string;
  index: number;
  variant?: number; // 1-based output index within the job
  variantCount?: number;
  job: Pick<Job, 'id' | 'name' | 'prompt' | 'mode' | 'options' | 'vars'>;
  date?: Date;
}

/**
 * Tokens: {queue} {project} {index} {index:03} {name} {slug} {mode} {model} {aspect} {date} {time}
 *         {variant} (empty for single outputs, "_v2" otherwise) {n} (raw variant number) {id} {var.xxx}
 * `/` in the template creates sub-folders. Each segment is sanitised separately.
 */
export function renderFilename(template: string, ctx: FilenameContext): string {
  const d = ctx.date ?? new Date();
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const many = (ctx.variantCount ?? 1) > 1;
  const tokens: Record<string, string> = {
    queue: ctx.queue,
    project: ctx.project ?? ctx.queue,
    name: ctx.job.name ?? slugify(ctx.job.prompt, 32),
    slug: slugify(ctx.job.prompt, 40),
    mode: ctx.job.mode,
    model: ctx.job.options.model ?? 'default',
    aspect: (ctx.job.options.aspect ?? '').replace(':', 'x'),
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`,
    time: `${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}`,
    variant: many ? `_v${ctx.variant ?? 1}` : '',
    n: String(ctx.variant ?? 1),
    id: ctx.job.id,
  };
  const out = template.replace(/\{([\w.]+)(?::(\d+))?\}/g, (all, key: string, width?: string) => {
    if (key === 'index') return width ? pad(ctx.index, Number(width)) : String(ctx.index);
    if (key.startsWith('var.')) return ctx.job.vars?.[key.slice(4)] ?? '';
    return key in tokens ? tokens[key] : all;
  });
  return out
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(safeSegment)
    .join('/');
}

/** Appends " (2)", " (3)"... until the path is unused. */
export function dedupePath(path: string, taken: Set<string>): string {
  if (!taken.has(path.toLowerCase())) return path;
  const dot = path.lastIndexOf('.');
  const base = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
  for (let i = 2; i < 10000; i++) {
    const p = `${base} (${i})${ext}`;
    if (!taken.has(p.toLowerCase())) return p;
  }
  return `${base}_${Date.now()}${ext}`;
}
