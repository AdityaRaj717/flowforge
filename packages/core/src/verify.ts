import type { AspectRatio, GenerationMode, MediaKind, OutputFile } from './types';
import { MODE_OUTPUT } from './types';

// Output checks. A job is only "succeeded" when what came back matches what was asked for,
// because Flow can accept a request and quietly ignore part of it.

const RATIO: Record<AspectRatio, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4 };

export interface VerifyInput {
  mode: GenerationMode;
  aspect?: AspectRatio;
  requestedOutputs?: number;
  outputs: Pick<OutputFile, 'kind' | 'width' | 'height' | 'bytes' | 'mime' | 'durationSec'>[];
  /** Fraction of tolerance for the aspect check (crops/rounding). */
  aspectTolerance?: number;
}

export interface VerifyResult {
  ok: boolean;
  /** Hard problems: wrong media type, empty files, nothing returned. */
  errors: string[];
  /** Soft problems: fewer variations than asked, aspect off. Shown, but the job still succeeds. */
  warnings: string[];
}

export function verifyOutputs(v: VerifyInput): VerifyResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const want: MediaKind = MODE_OUTPUT[v.mode];
  if (!v.outputs.length) errors.push('No outputs were produced.');
  v.outputs.forEach((o, i) => {
    const n = i + 1;
    if (o.kind !== want) errors.push(`Output ${n} is ${o.kind}, expected ${want}.`);
    if (o.bytes !== undefined && o.bytes < 1024) errors.push(`Output ${n} is ${o.bytes} bytes; looks empty or truncated.`);
    if (o.mime && !o.mime.startsWith(`${want}/`)) errors.push(`Output ${n} has type ${o.mime}.`);
    if (v.aspect && o.width && o.height) {
      const got = o.width / o.height;
      const exp = RATIO[v.aspect];
      const tol = v.aspectTolerance ?? 0.06;
      if (Math.abs(got - exp) / exp > tol) warnings.push(`Output ${n} is ${o.width}x${o.height}, not ${v.aspect}.`);
    }
    if (want === 'video' && o.durationSec !== undefined && o.durationSec < 0.5) errors.push(`Output ${n} video is ${o.durationSec}s long.`);
  });
  if (v.requestedOutputs && v.outputs.length && v.outputs.length < v.requestedOutputs) {
    warnings.push(`Asked for ${v.requestedOutputs} outputs, got ${v.outputs.length}.`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Sniff media type from the first bytes, so a mislabeled blob is caught. */
export function sniffMime(head: Uint8Array): string | undefined {
  const h = (i: number) => head[i];
  if (h(0) === 0x89 && h(1) === 0x50 && h(2) === 0x4e && h(3) === 0x47) return 'image/png';
  if (h(0) === 0xff && h(1) === 0xd8 && h(2) === 0xff) return 'image/jpeg';
  if (h(0) === 0x52 && h(1) === 0x49 && h(2) === 0x46 && h(3) === 0x46 && h(8) === 0x57 && h(9) === 0x45) return 'image/webp';
  if (h(4) === 0x66 && h(5) === 0x74 && h(6) === 0x79 && h(7) === 0x70) return 'video/mp4';
  if (h(0) === 0x1a && h(1) === 0x45 && h(2) === 0xdf && h(3) === 0xa3) return 'video/webm';
  return undefined;
}

export function extForMime(mime?: string): string {
  switch (mime) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'video/webm': return '.webm';
    case 'video/mp4': return '.mp4';
    default: return mime?.startsWith('video/') ? '.mp4' : '.png';
  }
}
