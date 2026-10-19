import type { AspectRatio, GenerationMode, JobOptions, ReferenceRef, ReferenceRole } from './types';
import { ASPECT_RATIOS } from './types';
import { normalizePrompt, fnv1a } from './util';

/** One row as it comes out of an import, before it becomes a job. */
export interface RowDraft {
  line: number;
  name?: string;
  prompt: string;
  mode?: GenerationMode;
  options: JobOptions;
  /** Raw reference names (file names or @aliases) still to be resolved against the asset library. */
  referenceNames: { role: ReferenceRole; name: string }[];
  vars: Record<string, string>;
  warnings: string[];
}

export interface ImportResult {
  rows: RowDraft[];
  warnings: string[];
  duplicates: { line: number; duplicateOf: number }[];
  columns?: ColumnMapping;
}

// ---------- TXT ----------

export type TxtSplit = 'auto' | 'line' | 'blank-line' | 'delimiter';

/**
 * Splits a text file into prompts.
 * - line: one prompt per non-empty line
 * - blank-line: paragraphs separated by an empty line (multi-line prompts)
 * - delimiter: `---` or `@@@NEXT@@@` on its own line
 * - auto: delimiter if present, else blank-line if any paragraph spans lines, else line
 * Lines starting with `#` or `//` are comments.
 */
export function splitTxt(text: string, mode: TxtSplit = 'auto'): { text: string; line: number }[] {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const isComment = (l: string) => /^\s*(#|\/\/)/.test(l);
  const isDelim = (l: string) => /^\s*(-{3,}|@@@NEXT@@@|={3,})\s*$/.test(l);

  let m = mode;
  if (m === 'auto') {
    if (lines.some(isDelim)) m = 'delimiter';
    else {
      // Multi-line prompts only when blank lines actually separate them; a plain block of
      // lines is one prompt per line, which is what people paste most.
      const paras = src.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      m = paras.length > 1 && paras.some((p) => p.split('\n').filter((l) => !isComment(l)).length > 1) ? 'blank-line' : 'line';
    }
  }

  const out: { text: string; line: number }[] = [];
  if (m === 'line') {
    lines.forEach((l, i) => {
      if (l.trim() && !isComment(l)) out.push({ text: l.trim(), line: i + 1 });
    });
    return out;
  }
  const breakOn = m === 'delimiter' ? isDelim : (l: string) => !l.trim();
  let buf: string[] = [];
  let start = 1;
  const flush = () => {
    const t = buf.filter((l) => !isComment(l)).join('\n').trim();
    if (t) out.push({ text: t, line: start });
    buf = [];
  };
  lines.forEach((l, i) => {
    if (breakOn(l)) {
      flush();
      start = i + 2;
    } else {
      if (!buf.length) start = i + 1;
      buf.push(l);
    }
  });
  flush();
  return out;
}

// ---------- CSV ----------

/** RFC 4180 CSV parser (quotes, escaped quotes, newlines in fields). Detects , ; and tab. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const d = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === d) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function detectDelimiter(src: string): string {
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

export function toCsv(rows: (string | number | undefined)[][]): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = v === undefined ? '' : String(v);
          return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\r\n');
}

// ---------- Column mapping (CSV, XLSX, Sheets) ----------

export type Field =
  | 'prompt' | 'name' | 'mode' | 'model' | 'aspect' | 'outputs' | 'duration' | 'quality'
  | 'start' | 'end' | 'ingredients' | 'style' | 'character' | 'source'
  | 'negative' | 'folder' | 'filename' | 'tags' | 'ignore' | 'var';

export type ColumnMapping = Record<number, { field: Field; varName?: string }>;

const HEADER_ALIASES: [Field, RegExp][] = [
  ['prompt', /^(prompt|prompts|text|description|scene prompt|caption)$/i],
  ['name', /^(name|title|id|scene|shot)$/i],
  ['mode', /^(mode|type|generation|task)$/i],
  ['model', /^(model|engine)$/i],
  ['aspect', /^(aspect|ratio|aspect ratio|size|orientation)$/i],
  ['outputs', /^(outputs|count|variations|n|number|images|videos)$/i],
  ['duration', /^(duration|length|seconds|secs?)$/i],
  ['quality', /^(quality|resolution|download quality)$/i],
  ['start', /^(start|start frame|first frame|image|input image|frame)$/i],
  ['end', /^(end|end frame|last frame)$/i],
  ['ingredients', /^(ingredients?|references?|refs?|components?)$/i],
  ['style', /^(style|style ref|style reference)$/i],
  ['character', /^(characters?|cast)$/i],
  ['source', /^(source|source image|base image)$/i],
  ['negative', /^(negative|negative prompt|avoid)$/i],
  ['folder', /^(folder|subfolder|directory|dir)$/i],
  ['filename', /^(filename|file name|output name)$/i],
  ['tags', /^(tags?|labels?)$/i],
];

/** Guess a mapping from a header row. Unknown headers become template variables. */
export function guessMapping(header: string[]): ColumnMapping {
  const map: ColumnMapping = {};
  header.forEach((h, i) => {
    const t = h.trim();
    const hit = HEADER_ALIASES.find(([, re]) => re.test(t));
    if (hit) map[i] = { field: hit[0] };
    else if (t) map[i] = { field: 'var', varName: t.replace(/\s+/g, '_').toLowerCase() };
    else map[i] = { field: 'ignore' };
  });
  if (!Object.values(map).some((m) => m.field === 'prompt')) {
    // No prompt header: the longest-text column is almost always the prompt.
    const idx = header.reduce((best, h, i) => (h.length > (header[best]?.length ?? 0) ? i : best), 0);
    map[idx] = { field: 'prompt' };
  }
  return map;
}

export function looksLikeHeader(row: string[]): boolean {
  return row.some((c) => HEADER_ALIASES.some(([, re]) => re.test(c.trim())));
}

const MODE_ALIASES: [GenerationMode, RegExp][] = [
  ['text-to-image', /^(t2i|image|img|text[- _]?to[- _]?image|create image|picture)$/i],
  ['image-to-image', /^(i2i|edit|image[- _]?to[- _]?image|transform)$/i],
  ['text-to-video', /^(t2v|video|text[- _]?to[- _]?video)$/i],
  ['frames-to-video', /^(i2v|f2v|frames?|image[- _]?to[- _]?video|frames?[- _]?to[- _]?video|animate)$/i],
  ['ingredients-to-video', /^(ingredients?|r2v|ingredients?[- _]?to[- _]?video|reference[- _]?to[- _]?video)$/i],
  ['extend-video', /^(extend|continue|extend[- _]?video)$/i],
];

export function parseMode(v: string): GenerationMode | undefined {
  const t = v.trim();
  if (!t) return undefined;
  return MODE_ALIASES.find(([, re]) => re.test(t))?.[0];
}

export function parseAspect(v: string): AspectRatio | undefined {
  const t = v.trim().toLowerCase().replace(/\s/g, '').replace('x', ':');
  if (!t) return undefined;
  if (ASPECT_RATIOS.includes(t as AspectRatio)) return t as AspectRatio;
  if (/^(landscape|wide|horizontal)$/.test(t)) return '16:9';
  if (/^(portrait|vertical|tall|story|shorts|reel)$/.test(t)) return '9:16';
  if (/^(square)$/.test(t)) return '1:1';
  return undefined;
}

function splitList(v: string): string[] {
  return v.split(/[|,;\n]/).map((s) => s.trim()).filter(Boolean);
}

export function rowsFromTable(table: string[][], mapping?: ColumnMapping, hasHeader?: boolean): ImportResult {
  const warnings: string[] = [];
  if (!table.length) return { rows: [], warnings: ['File is empty.'], duplicates: [] };
  const header = hasHeader ?? looksLikeHeader(table[0]);
  const columns = mapping ?? (header ? guessMapping(table[0]) : { 0: { field: 'prompt' as Field } });
  const body = header ? table.slice(1) : table;
  const rows: RowDraft[] = [];

  body.forEach((cells, i) => {
    const line = i + (header ? 2 : 1);
    const r: RowDraft = { line, prompt: '', options: {}, referenceNames: [], vars: {}, warnings: [] };
    for (const [colStr, m] of Object.entries(columns)) {
      const v = (cells[Number(colStr)] ?? '').trim();
      if (!v) continue;
      switch (m.field) {
        case 'prompt': r.prompt = v; break;
        case 'name': r.name = v; break;
        case 'mode': {
          const mode = parseMode(v);
          if (mode) r.mode = mode;
          else r.warnings.push(`Unknown mode "${v}"`);
          break;
        }
        case 'model': r.options.model = v; break;
        case 'aspect': {
          const a = parseAspect(v);
          if (a) r.options.aspect = a;
          else r.warnings.push(`Unknown aspect "${v}"`);
          break;
        }
        case 'outputs': {
          const n = parseInt(v, 10);
          if (n >= 1 && n <= 4) r.options.outputs = n;
          else r.warnings.push(`Outputs must be 1-4, got "${v}"`);
          break;
        }
        case 'duration': {
          const n = parseFloat(v);
          if (n > 0) r.options.durationSec = n;
          break;
        }
        case 'quality': r.options.downloadQuality = v.toLowerCase(); break;
        case 'start': r.referenceNames.push({ role: 'start', name: v }); break;
        case 'end': r.referenceNames.push({ role: 'end', name: v }); break;
        case 'source': r.referenceNames.push({ role: 'source', name: v }); break;
        case 'style': splitList(v).forEach((n) => r.referenceNames.push({ role: 'style', name: n })); break;
        case 'ingredients': splitList(v).forEach((n) => r.referenceNames.push({ role: 'ingredient', name: n })); break;
        case 'character': splitList(v).forEach((n) => r.referenceNames.push({ role: 'character', name: n })); break;
        case 'negative': r.options.negativePrompt = v; break;
        case 'folder': r.options.folder = v; break;
        case 'filename': r.options.filenameTemplate = v; break;
        case 'tags': r.options.tags = splitList(v); break;
        case 'var': if (m.varName) r.vars[m.varName] = v; break;
        case 'ignore': break;
      }
    }
    if (!r.prompt) {
      if (cells.some((c) => c.trim())) warnings.push(`Row ${line}: no prompt, skipped.`);
      return;
    }
    if (r.referenceNames.length && !r.mode) r.mode = inferModeFromRefs(r.referenceNames.map((x) => x.role));
    rows.push(r);
  });
  return { rows, warnings, duplicates: findDuplicates(rows), columns };
}

function inferModeFromRefs(roles: ReferenceRole[]): GenerationMode | undefined {
  if (roles.includes('start') || roles.includes('end')) return 'frames-to-video';
  if (roles.includes('ingredient') || roles.includes('character')) return 'ingredients-to-video';
  if (roles.includes('source')) return 'image-to-image';
  return undefined;
}

export function rowsFromTxt(text: string, split: TxtSplit = 'auto'): ImportResult {
  const rows: RowDraft[] = splitTxt(text, split).map(({ text: t, line }) => {
    const r: RowDraft = { line, prompt: t, options: {}, referenceNames: [], vars: {}, warnings: [] };
    return applyInlineDirectives(r);
  });
  return { rows, warnings: [], duplicates: findDuplicates(rows) };
}

/**
 * Inline directives let a plain TXT carry per-row settings without a spreadsheet:
 *   [mode: t2v] [aspect: 9:16] [n: 2] [model: Veo 3.1 Fast] [start: hero.png] A cat surfing
 */
export function applyInlineDirectives(r: RowDraft): RowDraft {
  const re = /\[(\w[\w ]*?)\s*:\s*([^\]]+)\]/g;
  let prompt = r.prompt;
  let m: RegExpExecArray | null;
  const found: string[] = [];
  while ((m = re.exec(r.prompt))) {
    const key = m[1].toLowerCase().trim();
    const val = m[2].trim();
    let used = true;
    if (key === 'mode') r.mode = parseMode(val) ?? r.mode;
    else if (key === 'aspect' || key === 'ratio') r.options.aspect = parseAspect(val) ?? r.options.aspect;
    else if (key === 'n' || key === 'outputs' || key === 'count') r.options.outputs = Math.min(4, Math.max(1, parseInt(val, 10) || 1));
    else if (key === 'model') r.options.model = val;
    else if (key === 'duration') r.options.durationSec = parseFloat(val) || undefined;
    else if (key === 'name') r.name = val;
    else if (key === 'folder') r.options.folder = val;
    else if (key === 'start' || key === 'end' || key === 'source') r.referenceNames.push({ role: key, name: val });
    else if (key === 'ref' || key === 'ingredient' || key === 'ingredients') splitList(val).forEach((n) => r.referenceNames.push({ role: 'ingredient', name: n }));
    else if (key === 'style') r.referenceNames.push({ role: 'style', name: val });
    else if (key === 'character' || key === 'char') splitList(val).forEach((n) => r.referenceNames.push({ role: 'character', name: n }));
    else used = false;
    if (used) found.push(m[0]);
  }
  for (const f of found) prompt = prompt.replace(f, '');
  r.prompt = prompt.replace(/[ \t]{2,}/g, ' ').trim();
  if (r.referenceNames.length && !r.mode) r.mode = inferModeFromRefs(r.referenceNames.map((x) => x.role));
  return r;
}

// ---------- JSON ----------

/** Accepts our own export, an array of strings, or an array of objects with prompt-like keys. */
export function rowsFromJson(text: string): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { rows: [], warnings: [`Invalid JSON: ${(e as Error).message}`], duplicates: [] };
  }
  const list: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { jobs?: unknown[] })?.jobs)
      ? (data as { jobs: unknown[] }).jobs
      : Array.isArray((data as { prompts?: unknown[] })?.prompts)
        ? (data as { prompts: unknown[] }).prompts
        : [];
  if (!list.length) return { rows: [], warnings: ['No prompts found in JSON (expected an array, {jobs:[...]} or {prompts:[...]}).'], duplicates: [] };

  const keys = new Set<string>();
  list.forEach((it) => it && typeof it === 'object' && Object.keys(it).forEach((k) => keys.add(k)));
  if (!keys.size) {
    const rows = list
      .map((v, i) => ({ line: i + 1, prompt: String(v ?? '').trim(), options: {}, referenceNames: [], vars: {}, warnings: [] }) as RowDraft)
      .filter((r) => r.prompt);
    return { rows, warnings: [], duplicates: findDuplicates(rows) };
  }
  const header = [...keys];
  const table = list.map((it) =>
    header.map((k) => {
      const v = (it as Record<string, unknown>)?.[k];
      if (v === undefined || v === null) return '';
      if (Array.isArray(v)) return v.join('|');
      if (typeof v === 'object') return '';
      return String(v);
    }),
  );
  // Our own export nests options; flatten the common ones.
  list.forEach((it, i) => {
    const o = (it as { options?: JobOptions })?.options;
    if (!o) return;
    const row = table[i];
    const put = (k: string, v: unknown) => {
      if (v === undefined) return;
      let idx = header.indexOf(k);
      if (idx < 0) {
        header.push(k);
        table.forEach((r) => r.push(''));
        idx = header.length - 1;
      }
      row[idx] = String(v);
    };
    put('model', o.model);
    put('aspect', o.aspect);
    put('outputs', o.outputs);
    put('duration', o.durationSec);
    put('folder', o.folder);
  });
  return rowsFromTable([header, ...table], undefined, true);
}

// ---------- duplicates ----------

export function findDuplicates(rows: { prompt: string; line: number; options?: JobOptions; mode?: GenerationMode }[]) {
  const seen = new Map<string, number>();
  const dups: { line: number; duplicateOf: number }[] = [];
  for (const r of rows) {
    const key = fnv1a(`${normalizePrompt(r.prompt)}|${r.mode ?? ''}|${r.options?.aspect ?? ''}|${r.options?.model ?? ''}`);
    const prev = seen.get(key);
    if (prev !== undefined) dups.push({ line: r.line, duplicateOf: prev });
    else seen.set(key, r.line);
  }
  return dups;
}

// ---------- reference resolution ----------

export interface AssetIndexEntry { id: string; name: string; aliases: string[] }

function stem(n: string): string {
  return n.toLowerCase().replace(/^@/, '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\s_-]+/g, ' ').trim();
}

/** Resolves file names and @aliases against the library. Returns refs and the names that did not match. */
export function resolveReferences(names: { role: ReferenceRole; name: string }[], assets: AssetIndexEntry[]) {
  const byKey = new Map<string, string>();
  for (const a of assets) {
    byKey.set(stem(a.name), a.id);
    a.aliases.forEach((al) => byKey.set(stem(al), a.id));
  }
  const refs: ReferenceRef[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const id = byKey.get(stem(n.name));
    if (id) refs.push({ role: n.role, assetId: id });
    else missing.push(n.name);
  }
  return { refs, missing };
}

/** Finds `@name` mentions in a prompt that match a library asset (character auto-linking). */
export function findMentions(prompt: string, assets: AssetIndexEntry[]): { assetId: string; mention: string }[] {
  const out: { assetId: string; mention: string }[] = [];
  const re = /@([\p{L}\p{N}_-]+)/gu;
  let m: RegExpExecArray | null;
  const idx = new Map<string, string>();
  for (const a of assets) {
    idx.set(stem(a.name).replace(/ /g, ''), a.id);
    a.aliases.forEach((al) => idx.set(stem(al).replace(/ /g, ''), a.id));
  }
  while ((m = re.exec(prompt))) {
    const id = idx.get(m[1].toLowerCase().replace(/[_-]/g, ''));
    if (id && !out.some((o) => o.assetId === id)) out.push({ assetId: id, mention: m[0] });
  }
  return out;
}
