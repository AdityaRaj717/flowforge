import { createHmac, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLicense } from '@flowforge/core';
import { handle, type Env, type KV } from '../src/index';

// A throwaway key pair; the real private key never touches tests.
const { privateKey } = generateKeyPairSync('ed25519');
const PRIVATE_PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const PUBLIC_B64 = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
const SECRET = 'whsec_test';

function memoryKV(): KV & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    put: async (k, v) => void map.set(k, v),
    list: async ({ prefix }) => ({ keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
}

function setup() {
  const mail: { to: string; text: string }[] = [];
  const env: Env = {
    LICENSES: memoryKV(),
    LS_WEBHOOK_SECRET: SECRET,
    LICENSE_PRIVATE_KEY: PRIVATE_PEM,
    VARIANT_PLANS: JSON.stringify({ '111': { plan: 'pro', days: 31 }, '222': { plan: 'pro', days: 365 }, '333': { plan: 'lifetime' } }),
    ADMIN_TOKEN: 'admin',
    sendMail: async (to, _s, text) => void mail.push({ to, text }),
  };
  return { env, mail };
}

function hook(event_name: string, id: string, attributes: Record<string, unknown>, signature?: string) {
  const body = JSON.stringify({ meta: { event_name, test_mode: false }, data: { id, attributes } });
  const sig = signature ?? createHmac('sha256', SECRET).update(body).digest('hex');
  return new Request('https://lic.example/webhooks/lemonsqueezy', { method: 'POST', headers: { 'x-signature': sig }, body });
}

const keyFrom = (text: string) => text.match(/FF1\.[\w-]+\.[\w-]+/)![0];

describe('license webhook', () => {
  it('signs a lifetime key that verifyLicense accepts, and emails it once', async () => {
    const { env, mail } = setup();
    const order = { status: 'paid', user_email: 'buyer@example.com', first_order_item: { variant_id: 333 } };
    expect((await handle(hook('order_created', '9001', order), env)).status).toBe(200);
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe('buyer@example.com');

    const status = await verifyLicense(keyFrom(mail[0].text), Date.now(), PUBLIC_B64);
    expect(status.valid).toBe(true);
    expect(status.plan).toBe('lifetime');
    expect(status.payload).toMatchObject({ v: 1, sub: 'buyer@example.com', plan: 'lifetime', exp: null, lid: 'ord_9001' });

    // A retried webhook does not sign or email again.
    await handle(hook('order_created', '9001', order), env);
    expect(mail).toHaveLength(1);
  });

  it('gives subscription keys an expiry with grace, and renews from the stored variant', async () => {
    const { env, mail } = setup();
    await handle(hook('order_created', '1', { status: 'paid', user_email: 'm@example.com', first_order_item: { variant_id: 111 } }), env);
    const first = await verifyLicense(keyFrom(mail[0].text), Date.now(), PUBLIC_B64);
    expect(first.plan).toBe('pro');
    const days = (first.payload!.exp! - first.payload!.iat) / 86400;
    expect(days).toBe(34);

    // Renewal before subscription_created is known: retry later.
    expect((await handle(hook('subscription_payment_success', '50', { subscription_id: 7, billing_reason: 'renewal', user_email: 'm@example.com' }), env)).status).toBe(500);
    await handle(hook('subscription_created', '7', { variant_id: 222, user_email: 'm@example.com' }), env);
    await handle(hook('subscription_payment_success', '50', { subscription_id: 7, billing_reason: 'renewal', user_email: 'm@example.com' }), env);
    const renewed = await verifyLicense(keyFrom(mail[1].text), Date.now(), PUBLIC_B64);
    expect(renewed.valid).toBe(true);
    expect(renewed.payload!.lid).toBe('inv_50');
    expect((renewed.payload!.exp! - renewed.payload!.iat) / 86400).toBe(368);

    // The initial invoice is ignored (order_created already keyed it).
    await handle(hook('subscription_payment_success', '49', { subscription_id: 7, billing_reason: 'initial', user_email: 'm@example.com' }), env);
    expect(mail).toHaveLength(2);
  });

  it('rejects bad signatures, unpaid orders, unmapped variants and test mode', async () => {
    const { env, mail } = setup();
    expect((await handle(hook('order_created', '2', { status: 'paid', user_email: 'x@x.com', first_order_item: { variant_id: 111 } }, 'deadbeef'), env)).status).toBe(401);
    await handle(hook('order_created', '3', { status: 'pending', user_email: 'x@x.com', first_order_item: { variant_id: 111 } }), env);
    await handle(hook('order_created', '4', { status: 'paid', user_email: 'x@x.com', first_order_item: { variant_id: 999 } }), env);
    await handle(hook('order_created', '5', { status: 'paid', test_mode: true, user_email: 'x@x.com', first_order_item: { variant_id: 111 } }), env);
    expect(mail).toHaveLength(0);
  });

  it('puts refunded and manually revoked lids on the revocation list', async () => {
    const { env } = setup();
    await handle(hook('order_refunded', '9001', { status: 'refunded' }), env);
    await handle(hook('subscription_payment_refunded', '50', {}), env);
    expect((await handle(new Request('https://lic.example/admin/revoke', { method: 'POST', body: '{"lid":"x"}' }), env)).status).toBe(401);
    await handle(new Request('https://lic.example/admin/revoke', { method: 'POST', headers: { authorization: 'Bearer admin' }, body: '{"lid":"ord_77","reason":"chargeback"}' }), env);

    const list = (await (await handle(new Request('https://lic.example/revoked'), env)).json()) as { revoked: string[] };
    expect(list.revoked.sort()).toEqual(['inv_50', 'ord_77', 'ord_9001']);
    const one = (await (await handle(new Request('https://lic.example/revoked/ord_1'), env)).json()) as { revoked: boolean };
    expect(one.revoked).toBe(false);
  });
});
