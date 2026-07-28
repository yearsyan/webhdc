import assert from 'node:assert/strict';
import test from 'node:test';

import { HdcKeyStore } from '../src/auth.ts';
import { base64ToBytes, encodeUtf8 } from '../src/bytes.ts';

function pemToDer(pem) {
  const base64 = pem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s/gu, '');
  return base64ToBytes(base64);
}

test('browser HDC key uses RSA-PSS SHA-512 with a 3072-bit modulus', async () => {
  const store = new HdcKeyStore({ keyId: `test-${Date.now()}` });
  const publicKeyPem = await store.getPublicKeyPem();
  assert.match(publicKeyPem, /^-----BEGIN PUBLIC KEY-----/u);

  const publicKey = await crypto.subtle.importKey(
    'spki',
    pemToDer(publicKeyPem),
    { name: 'RSA-PSS', hash: 'SHA-512' },
    true,
    ['verify'],
  );
  assert.equal(publicKey.algorithm.modulusLength, 3072);

  const challenge = encodeUtf8('01234567890123456789');
  const signature = base64ToBytes(await store.signToken(challenge));
  assert.equal(signature.byteLength, 384);
  assert.equal(
    await crypto.subtle.verify(
      { name: 'RSA-PSS', saltLength: 64 },
      publicKey,
      signature,
      challenge,
    ),
    true,
  );
});
