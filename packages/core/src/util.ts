// Small helpers with no platform dependencies (run in the service worker, the page and Node).

export function uid(prefix = ''): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const s = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
  return prefix ? `${prefix}_${s}` : s;
}

/** FNV-1a 32-bit, hex. Fast and stable; used for idempotency keys and duplicate detection, not security. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizePrompt(p: string): string {
  return p.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function slugify(text: string, max = 48): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9À-￿]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s.slice(0, max).replace(/-+$/g, '') || 'untitled');
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Make one path segment safe on Windows, macOS and Linux. */
export function safeSegment(seg: string): string {
  let s = seg.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!s) s = '_';
  if (RESERVED.test(s)) s = `_${s}`;
  return s.slice(0, 120);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function dayKey(ts = Date.now()): string {
  // UTC day; quota resets are shown to the user in their local time.
  return new Date(ts).toISOString().slice(0, 10);
}

/** Strip anything that looks like a credential before it reaches a log or a diagnostics export. */
export function redact(text: string): string {
  return text
    .replace(/(authorization|cookie|x-goog-[a-z-]+|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(ya29\.[\w-]+|AIza[\w-]{20,})/g, '[redacted]')
    .replace(/([?&](?:token|key|sig|signature|at|f\.sid|X-Goog-Signature|Expires)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]');
}
