// FlowForge license server (Cloudflare Worker).
//
//   POST /webhooks/lemonsqueezy   Lemon Squeezy webhook: signs a license key on payment and emails it
//   GET  /revoked                 revocation list: { revoked: [lid...], updated }
//   GET  /revoked/<lid>           { lid, revoked }
//   POST /admin/revoke            { lid, reason? } with "Authorization: Bearer <ADMIN_TOKEN>"
//
// Prices live only in Lemon Squeezy. This worker maps variant ids to plans through the
// VARIANT_PLANS secret, so changing prices never needs a code change.

import type { LicensePayload, PlanId } from '@flowforge/core';
import { importPrivateKey, signLicense } from './sign';

/** The subset of Cloudflare KV this worker uses (tests pass an in-memory version). */
export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

export interface Env {
  LICENSES: KV;
  LS_WEBHOOK_SECRET: string;
  /** PKCS#8 PEM, the contents of tools/license/private.key. Set with `wrangler secret put`. */
  LICENSE_PRIVATE_KEY: string;
  /** JSON: { "<variant id>": { "plan": "pro", "days": 31 } | { "plan": "lifetime" } } */
  VARIANT_PLANS: string;
  /** Extra days added to subscription keys so a late renewal never locks a buyer out. Default 3. */
  GRACE_DAYS?: string;
  /** "true" accepts Lemon Squeezy test-mode orders (for setup). Leave unset in production. */
  ALLOW_TEST_MODE?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  ADMIN_TOKEN?: string;
  /** Test hook: replaces the email sender. */
  sendMail?: (to: string, subject: string, text: string) => Promise<void>;
}

interface VariantPlan {
  plan: Exclude<PlanId, 'free'>;
  days?: number;
}

interface Issued {
  key: string;
  sub: string;
  plan: PlanId;
  exp: number | null;
  emailed: boolean;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
};

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (req.method === 'POST' && url.pathname === '/webhooks/lemonsqueezy') return await webhook(req, env);
    if (req.method === 'GET' && url.pathname === '/revoked') return await revokedList(env);
    if (req.method === 'GET' && url.pathname.startsWith('/revoked/')) {
      const lid = decodeURIComponent(url.pathname.slice('/revoked/'.length));
      return json({ lid, revoked: (await env.LICENSES.get(`revoked:${lid}`)) !== null }, 200, { 'cache-control': 'public, max-age=300' });
    }
    if (req.method === 'POST' && url.pathname === '/admin/revoke') return await adminRevoke(req, env);
    return json({ error: 'not found' }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
}

// ---------- webhook ----------

async function webhook(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get('x-signature') ?? '', env.LS_WEBHOOK_SECRET))) return json({ error: 'bad signature' }, 401);

  const event = JSON.parse(raw) as { meta: { event_name: string; test_mode?: boolean }; data: { id: string; attributes: Record<string, any> } };
  const { event_name } = event.meta;
  const { id, attributes: a } = event.data;
  if ((event.meta.test_mode || a.test_mode) && env.ALLOW_TEST_MODE !== 'true') return json({ ignored: 'test mode' });

  switch (event_name) {
    case 'order_created': {
      // First payment for lifetime and for new subscriptions. Renewals come as subscription_payment_success.
      if (a.status !== 'paid') return json({ ignored: `order status ${a.status}` });
      const vp = variantPlan(env, a.first_order_item?.variant_id);
      if (!vp) return json({ ignored: `variant ${a.first_order_item?.variant_id} is not mapped in VARIANT_PLANS` });
      return issue(env, `ord_${id}`, a.user_email, vp);
    }
    case 'subscription_created':
    case 'subscription_updated':
      // Invoices carry no variant, so remember which variant each subscription is on (it can change plans).
      await env.LICENSES.put(`sub:${id}`, JSON.stringify({ variant_id: a.variant_id, email: a.user_email }));
      return json({ stored: `sub:${id}` });
    case 'subscription_payment_success': {
      if (a.billing_reason === 'initial') return json({ ignored: 'initial payment is keyed by order_created' });
      const sub = await env.LICENSES.get(`sub:${a.subscription_id}`);
      // 500 makes Lemon Squeezy retry, by which time subscription_created has usually arrived.
      if (!sub) return json({ error: `subscription ${a.subscription_id} not seen yet` }, 500);
      const vp = variantPlan(env, JSON.parse(sub).variant_id);
      if (!vp) return json({ ignored: 'subscription variant is not mapped in VARIANT_PLANS' });
      return issue(env, `inv_${id}`, a.user_email, vp);
    }
    case 'order_refunded':
      return revoke(env, `ord_${id}`, 'refunded');
    case 'subscription_payment_refunded':
      return revoke(env, `inv_${id}`, 'refunded');
    default:
      return json({ ignored: event_name });
  }
}

export async function validSignature(raw: string, header: string, secret: string): Promise<boolean> {
  if (!secret || !header) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

function variantPlan(env: Env, variantId: unknown): VariantPlan | null {
  const map = JSON.parse(env.VARIANT_PLANS || '{}') as Record<string, VariantPlan>;
  const vp = map[String(variantId)];
  return vp && (vp.plan === 'pro' || vp.plan === 'lifetime') ? vp : null;
}

async function issue(env: Env, lid: string, email: string, vp: VariantPlan): Promise<Response> {
  if (!email) return json({ error: 'order has no email' }, 400);
  // Lemon Squeezy retries webhooks, so a lid is signed once and only the email is retried.
  const existing = await env.LICENSES.get(`issued:${lid}`);
  let rec: Issued;
  if (existing) {
    rec = JSON.parse(existing);
    if (rec.emailed) return json({ lid, duplicate: true });
  } else {
    const now = Math.floor(Date.now() / 1000);
    const grace = Number(env.GRACE_DAYS ?? 3);
    const exp = vp.plan === 'lifetime' && !vp.days ? null : now + (Number(vp.days ?? 31) + grace) * 86400;
    const payload: LicensePayload = { v: 1, sub: email, plan: vp.plan, iat: now, exp, lid };
    const key = await signLicense(payload, await importPrivateKey(env.LICENSE_PRIVATE_KEY));
    rec = { key, sub: email, plan: vp.plan, exp, emailed: false };
    await env.LICENSES.put(`issued:${lid}`, JSON.stringify(rec));
  }
  await mailKey(env, rec);
  rec.emailed = true;
  await env.LICENSES.put(`issued:${lid}`, JSON.stringify(rec));
  return json({ lid, issued: true });
}

async function mailKey(env: Env, rec: Issued): Promise<void> {
  const until = rec.exp === null ? 'It does not expire.' : `It is valid until ${new Date(rec.exp * 1000).toUTCString()}; renewals email a new key.`;
  const text = [
    'Thanks for buying FlowForge.',
    '',
    'Your license key:',
    '',
    rec.key,
    '',
    `Paste it in the FlowForge side panel under Settings > Plan. ${until}`,
    '',
    'FlowForge is an independent tool and is not affiliated with Google.',
  ].join('\n');
  const subject = 'Your FlowForge license key';
  if (env.sendMail) return env.sendMail(rec.sub, subject, text);
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw new Error('RESEND_API_KEY and MAIL_FROM must be set to email keys.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [rec.sub], subject, text }),
  });
  if (!res.ok) throw new Error(`Email failed: ${res.status} ${await res.text()}`);
}

// ---------- revocation ----------

async function revoke(env: Env, lid: string, reason: string): Promise<Response> {
  await env.LICENSES.put(`revoked:${lid}`, JSON.stringify({ at: Math.floor(Date.now() / 1000), reason }));
  return json({ lid, revoked: true });
}

async function revokedList(env: Env): Promise<Response> {
  const revoked: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.LICENSES.list({ prefix: 'revoked:', cursor });
    revoked.push(...page.keys.map((k) => k.name.slice('revoked:'.length)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return json({ revoked, updated: Math.floor(Date.now() / 1000) }, 200, { 'cache-control': 'public, max-age=300' });
}

async function adminRevoke(req: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN || req.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);
  const { lid, reason } = (await req.json()) as { lid?: string; reason?: string };
  if (!lid) return json({ error: 'lid is required' }, 400);
  return revoke(env, lid, reason ?? 'manual');
}
