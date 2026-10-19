// Signs FlowForge license keys in the same format as tools/license.mjs:
// `FF1.<base64url(payload JSON)>.<base64url(Ed25519 signature over "FF1.<payload>")>`.
// Uses Web Crypto only, so it runs in Cloudflare Workers and in Node 20+.

import { bytesToB64url, type LicensePayload } from '@flowforge/core';

/** Import the PKCS#8 PEM that `tools/license.mjs keygen` writes (tools/license/private.key). */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  if (!b64) throw new Error('LICENSE_PRIVATE_KEY is empty.');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
}

export async function signLicense(payload: LicensePayload, key: CryptoKey): Promise<string> {
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(`FF1.${body}`));
  return `FF1.${body}.${bytesToB64url(new Uint8Array(sig))}`;
}
