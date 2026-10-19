#!/usr/bin/env node
// FlowForge license keys (Ed25519). Keep tools/license/private.key secret and backed up:
// anyone with it can mint Pro keys, and losing it means existing keys cannot be reissued.
//
//   node tools/license.mjs keygen                       create the key pair (once)
//   node tools/license.mjs sign --sub buyer@x.com --plan pro --days 31 [--lid ORDER123]
//   node tools/license.mjs sign --sub buyer@x.com --plan lifetime
//   node tools/license.mjs verify FF1.xxx.yyy
//
// A payment webhook (Stripe, Lemon Squeezy, Paddle...) only needs to call `sign` and email the key.

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'license');
const PRIV = join(dir, 'private.key');
const PUB = join(dir, 'public.key.txt');
const b64url = (b) => Buffer.from(b).toString('base64url');

function args() {
  const out = {};
  const a = process.argv.slice(3);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) out[a[i].slice(2)] = a[i + 1]?.startsWith('--') || a[i + 1] === undefined ? true : a[++i];
  return out;
}

function rawPublic(keyObj) {
  // SPKI DER for Ed25519 is a 12-byte prefix + 32-byte key.
  return createPublicKey(keyObj).export({ format: 'der', type: 'spki' }).subarray(12);
}

const cmd = process.argv[2];
if (cmd === 'keygen') {
  if (existsSync(PRIV) && !args().force) {
    console.error(`${PRIV} already exists. Re-running would invalidate every key you have issued. Use --force only if you mean it.`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(PRIV, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const pub = b64url(rawPublic(privateKey));
  writeFileSync(PUB, `${pub}\n`);
  console.log(`Private key: ${PRIV}  (secret, back it up, never commit)`);
  console.log(`Public key:  ${pub}`);
  console.log('Put the public key in packages/core/src/license.ts (LICENSE_PUBLIC_KEY_B64) and rebuild.');
} else if (cmd === 'sign') {
  const a = args();
  if (!a.sub) throw new Error('--sub customer email or id is required');
  const plan = a.plan ?? 'pro';
  if (!['pro', 'lifetime'].includes(plan)) throw new Error('--plan must be pro or lifetime');
  const now = Math.floor(Date.now() / 1000);
  const exp = plan === 'lifetime' && !a.days ? null : now + Number(a.days ?? 31) * 86400;
  const payload = { v: 1, sub: String(a.sub), plan, iat: now, exp, lid: String(a.lid ?? b64url(randomBytes(9))), devices: a.devices ? Number(a.devices) : undefined };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const key = createPrivateKey(readFileSync(PRIV));
  const sig = sign(null, Buffer.from(`FF1.${body}`), key);
  console.log(`FF1.${body}.${b64url(sig)}`);
} else if (cmd === 'verify') {
  const token = process.argv[3] ?? '';
  const [v, body, sig] = token.split('.');
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(readFileSync(PUB, 'utf8').trim(), 'base64url')]), format: 'der', type: 'spki' });
  const ok = v === 'FF1' && verify(null, Buffer.from(`FF1.${body}`), pub, Buffer.from(sig ?? '', 'base64url'));
  console.log(ok ? 'valid' : 'INVALID', JSON.parse(Buffer.from(body ?? '', 'base64url').toString() || 'null'));
} else {
  console.log('usage: keygen | sign --sub EMAIL [--plan pro|lifetime] [--days N] [--lid ID] | verify KEY');
}
