import { sha256Hex, sniffMime } from '@flowforge/core';
import type { SelectorPack } from '../shared/pack';
import type { CollectedOutput } from '../shared/messages';
import { inOverlay, isVisible } from './dom';
import { blobToB64 } from '../shared/db';

export interface MediaCandidate {
  key: string;
  el: HTMLImageElement | HTMLVideoElement;
  kind: 'image' | 'video';
  src: string;
}

function excluded(el: Element, pack: SelectorPack): boolean {
  if (inOverlay(el)) return true;
  return pack.media.excludeWithin.some((css) => {
    try {
      return !!el.closest(css);
    } catch {
      return false;
    }
  });
}

function videoSrc(v: HTMLVideoElement): string {
  return v.currentSrc || v.src || v.querySelector('source')?.getAttribute('src') || '';
}

/** Media on the page that look like generation outputs (large, from Flow's media hosts). */
export function listMedia(pack: SelectorPack): MediaCandidate[] {
  const out: MediaCandidate[] = [];
  const seen = new Set<string>();
  document.querySelectorAll('video').forEach((v) => {
    const src = videoSrc(v);
    if (!src || excluded(v, pack) || seen.has(src)) return;
    seen.add(src);
    out.push({ key: src, el: v, kind: 'video', src });
    if (v.poster) seen.add(v.poster);
  });
  document.querySelectorAll('img').forEach((img) => {
    const src = img.currentSrc || img.src;
    if (!src || seen.has(src) || excluded(img, pack)) return;
    if (!img.complete || Math.min(img.naturalWidth, img.naturalHeight) < pack.media.minImageSide) return;
    // Known output hosts are preferred, but any large https image that is not an icon counts,
    // so a CDN change in Flow does not make every job look like it produced nothing.
    if (pack.media.denyHosts.some((h) => src.includes(h))) return;
    if (!pack.media.imageUrlHints.some((h) => src.includes(h)) && !/^https:/.test(src)) return;
    if (!isVisible(img) && !img.closest('[aria-hidden="false"]')) {
      // Off-screen grid items still count; only skip images that are hidden on purpose.
      const cs = getComputedStyle(img);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
    }
    seen.add(src);
    out.push({ key: src, el: img, kind: 'image', src });
  });
  return out;
}

export function snapshotKeys(pack: SelectorPack): Set<string> {
  return new Set(listMedia(pack).map((m) => m.key));
}

/** A video tile is usable once it has metadata; before that Flow is still rendering it. */
export function candidateReady(c: MediaCandidate): boolean {
  if (c.kind === 'image') return (c.el as HTMLImageElement).complete;
  const v = c.el as HTMLVideoElement;
  return v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
}

async function fetchBlob(url: string): Promise<Blob | null> {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

/** Small JPEG preview for the library (max 320px on the long side). */
export async function thumbnail(source: Blob | HTMLVideoElement | HTMLImageElement): Promise<string | undefined> {
  try {
    const bmp = source instanceof Blob ? await createImageBitmap(source) : await createImageBitmap(source);
    const scale = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return await blobToB64(await c.convertToBlob({ type: 'image/jpeg', quality: 0.72 }));
  } catch {
    return undefined;
  }
}

async function imageDims(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const d = { width: bmp.width, height: bmp.height };
    bmp.close();
    return d;
  } catch {
    return null;
  }
}

/** Loads a video blob off-DOM, returns its metadata and (optionally) its final frame as PNG. */
export async function probeVideo(blob: Blob, wantLastFrame: boolean): Promise<{ width: number; height: number; durationSec: number; lastFrame?: Blob } | null> {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      v.onloadedmetadata = () => resolve();
      v.onerror = () => reject(new Error('video decode failed'));
      setTimeout(() => reject(new Error('video metadata timeout')), 20000);
    });
    const meta = { width: v.videoWidth, height: v.videoHeight, durationSec: v.duration };
    if (!wantLastFrame) return meta;
    await new Promise<void>((resolve, reject) => {
      v.onseeked = () => resolve();
      v.onerror = () => reject(new Error('seek failed'));
      v.currentTime = Math.max(0, v.duration - 0.05);
      setTimeout(() => reject(new Error('seek timeout')), 20000);
    });
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    const lastFrame = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    return { ...meta, lastFrame: lastFrame ?? undefined };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
    v.removeAttribute('src');
    v.load();
  }
}

/**
 * Reads an output's bytes to check type, size and shape. If the page cannot fetch it (CORS),
 * we fall back to element metadata and let the service worker download the URL directly.
 */
export async function collect(c: MediaCandidate, wantLastFrame: boolean): Promise<CollectedOutput> {
  const out: CollectedOutput = { kind: c.kind };
  const isHttp = /^https?:/.test(c.src);
  if (isHttp) out.url = c.src;
  const blob = await fetchBlob(c.src);
  if (blob) {
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    out.mime = sniffMime(head) ?? (blob.type || undefined);
    out.bytes = blob.size;
    out.sha256 = await sha256Hex(await blob.arrayBuffer());
    if (c.kind === 'image') {
      const d = await imageDims(blob);
      if (d) Object.assign(out, d);
      out.thumbJpegB64 = await thumbnail(blob);
    } else {
      const p = await probeVideo(blob, wantLastFrame);
      if (p) {
        out.width = p.width;
        out.height = p.height;
        out.durationSec = p.durationSec;
        if (p.lastFrame) {
          out.lastFramePngB64 = await blobToB64(p.lastFrame);
          out.thumbJpegB64 = await thumbnail(p.lastFrame);
        }
      }
      if (!out.thumbJpegB64 && (c.el as HTMLVideoElement).readyState >= 2) out.thumbJpegB64 = await thumbnail(c.el as HTMLVideoElement);
    }
    if (!isHttp) out.dataB64 = await blobToB64(blob);
  } else if (c.kind === 'image') {
    const img = c.el as HTMLImageElement;
    out.width = img.naturalWidth;
    out.height = img.naturalHeight;
    out.thumbJpegB64 = await thumbnail(img); // fails quietly on cross-origin images
  } else {
    const v = c.el as HTMLVideoElement;
    out.width = v.videoWidth;
    out.height = v.videoHeight;
    out.durationSec = v.duration;
  }
  return out;
}
