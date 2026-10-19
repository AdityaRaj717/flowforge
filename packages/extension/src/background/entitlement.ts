import type { LicenseStatus, QuotaState } from '@flowforge/core';
import { dayKey, nextQuotaReset, quotaRemaining, verifyLicense } from '@flowforge/core';
import { kvGet, kvSet } from '../shared/db';
import { loadSettings } from '../shared/settings';
import { DEFAULT_PACK, isPack, type SelectorPack } from '../shared/pack';

// Plan and quota. The FlowForge quota counts jobs FlowForge submitted today; it is shown next to,
// never mixed with, the Flow credits and limits on the user's Google account.

let cached: LicenseStatus | null = null;

export async function license(force = false): Promise<LicenseStatus> {
  if (cached && !force) return cached;
  const s = await loadSettings();
  cached = await verifyLicense(s.licenseKey);
  return cached;
}

export async function quota(): Promise<{ used: number; remaining: number | null; limit: number | null; resetsAt: number }> {
  const lic = await license();
  const q = await kvGet<QuotaState>('quota', { day: dayKey(), used: 0 });
  const today = dayKey();
  return {
    used: q.day === today ? q.used : 0,
    remaining: quotaRemaining(lic.limits, q, today),
    limit: lic.limits.jobsPerDay,
    resetsAt: nextQuotaReset().getTime(),
  };
}

/** Called when a job is actually submitted to Flow (not when it is queued or retried before submit). */
export async function consumeQuota(): Promise<void> {
  const today = dayKey();
  const q = await kvGet<QuotaState>('quota', { day: today, used: 0 });
  await kvSet('quota', q.day === today ? { day: today, used: q.used + 1 } : { day: today, used: 1 });
}

// ---------- selector pack ----------

let pack: SelectorPack | null = null;

function newer(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { numeric: true }) > 0;
}

export async function currentPack(): Promise<SelectorPack> {
  if (pack) return pack;
  const stored = await kvGet<SelectorPack | null>('pack', null);
  pack = stored && isPack(stored) && newer(stored.version, DEFAULT_PACK.version) ? stored : DEFAULT_PACK;
  return pack;
}

/** Fetches a newer pack (JSON data only, never code) from the configured URL. */
export async function refreshPack(): Promise<{ updated: boolean; version: string; error?: string }> {
  const s = await loadSettings();
  const cur = await currentPack();
  if (!s.packUrl) return { updated: false, version: cur.version, error: 'No pack URL configured.' };
  try {
    const res = await fetch(s.packUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = await res.json();
    if (!isPack(next)) throw new Error('Not a valid selector pack.');
    if (!newer(next.version, cur.version)) return { updated: false, version: cur.version };
    pack = next;
    await kvSet('pack', next);
    return { updated: true, version: next.version };
  } catch (e) {
    return { updated: false, version: cur.version, error: (e as Error).message };
  }
}
