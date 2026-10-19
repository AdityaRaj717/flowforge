// Plans, feature gates and offline-verifiable license keys.
//
// A license key is `FF1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>`, signed with a
// private key that never ships (tools/license.mjs makes and signs them). The extension and agent
// verify with the public key below, so keys work offline and a payment provider webhook only has
// to call the signer. Revocation and device limits go through the optional license server.

export type PlanId = 'free' | 'pro' | 'lifetime';

export interface PlanLimits {
  label: string;
  /** Jobs FlowForge will start per UTC day. Separate from Google's own credits and limits. */
  jobsPerDay: number | null;
  maxConcurrency: number;
  workflowNodes: number | null;
  storyboardScenes: number | null;
  promptExpansions: number;
  localApi: boolean; // REST, MCP, CLI through the local agent
  postProcessing: boolean; // FFmpeg merges, last-frame extraction in the agent
  multiQueue: boolean; // more than one running queue
}

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    label: 'Free',
    jobsPerDay: 30,
    maxConcurrency: 1,
    workflowNodes: 12,
    storyboardScenes: 6,
    promptExpansions: 20,
    localApi: false,
    postProcessing: false,
    multiQueue: false,
  },
  pro: {
    label: 'Pro',
    jobsPerDay: null,
    maxConcurrency: 3,
    workflowNodes: null,
    storyboardScenes: null,
    promptExpansions: 500,
    localApi: true,
    postProcessing: true,
    multiQueue: true,
  },
  lifetime: {
    label: 'Lifetime',
    jobsPerDay: null,
    maxConcurrency: 3,
    workflowNodes: null,
    storyboardScenes: null,
    promptExpansions: 500,
    localApi: true,
    postProcessing: true,
    multiQueue: true,
  },
};

export interface LicensePayload {
  v: 1;
  sub: string; // customer email or id
  plan: PlanId;
  iat: number; // seconds
  exp: number | null; // seconds; null = no expiry (lifetime)
  lid: string; // license id, for revocation
  devices?: number;
}

export interface LicenseStatus {
  plan: PlanId;
  valid: boolean;
  reason?: string;
  payload?: LicensePayload;
  limits: PlanLimits;
}

// Replace with the output of `node tools/license.mjs keygen` before shipping.
export const LICENSE_PUBLIC_KEY_B64 = 'Csu0toi0YZIG18DUpN2j0iypOwEbJQDfGWd-mIfVP2s';

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToB64url(b: Uint8Array): string {
  let s = '';
  b.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeLicense(key: string): LicensePayload | null {
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'FF1') return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as LicensePayload;
  } catch {
    return null;
  }
}

export async function verifyLicense(key: string | undefined, now = Date.now(), publicKeyB64 = LICENSE_PUBLIC_KEY_B64): Promise<LicenseStatus> {
  const free = (reason?: string): LicenseStatus => ({ plan: 'free', valid: !reason, reason, limits: PLANS.free });
  if (!key?.trim()) return free();
  const parts = key.trim().split('.');
  const payload = decodeLicense(key);
  if (!payload || parts.length !== 3) return free('That does not look like a FlowForge license key.');
  if (publicKeyB64.startsWith('REPLACE')) return free('This build has no license public key configured.');
  try {
    const pub = await crypto.subtle.importKey('raw', b64urlToBytes(publicKeyB64) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify('Ed25519', pub, b64urlToBytes(parts[2]) as BufferSource, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return free('License signature is not valid.');
  } catch (e) {
    return free(`Could not verify license: ${(e as Error).message}`);
  }
  if (payload.exp !== null && payload.exp * 1000 < now) {
    return { plan: 'free', valid: false, reason: `License expired on ${new Date(payload.exp * 1000).toLocaleDateString()}.`, payload, limits: PLANS.free };
  }
  const plan = PLANS[payload.plan] ? payload.plan : 'free';
  return { plan, valid: true, payload, limits: PLANS[plan] };
}

// ---------- local quota ----------

export interface QuotaState {
  day: string;
  used: number;
}

export function quotaRemaining(limits: PlanLimits, q: QuotaState, today: string): number | null {
  if (limits.jobsPerDay === null) return null;
  const used = q.day === today ? q.used : 0;
  return Math.max(0, limits.jobsPerDay - used);
}

export function nextQuotaReset(now = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}
