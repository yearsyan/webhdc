import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FORWARD_PARAMETER_SIZE,
  decodeForwardCheckResult,
  decodeForwardContextId,
  decodeForwardData,
  decodeForwardRequest,
  encodeForwardContextId,
  encodeForwardData,
  encodeForwardFreeContext,
  encodeForwardRequest,
  parseForwardEndpoint,
} from '../src/index.ts';

test('context id encodes as 4-byte big-endian like htonl', () => {
  assert.deepEqual([...encodeForwardContextId(0x12345678)], [0x12, 0x34, 0x56, 0x78]);
  assert.equal(decodeForwardContextId(Uint8Array.of(0x12, 0x34, 0x56, 0x78)), 0x12345678);
  assert.throws(() => decodeForwardContextId(Uint8Array.of(1, 2)), /context id/u);
});

test('forward request carries id + 8 reserved bytes + endpoint + NUL', () => {
  const endpoint = 'localabstract:webview_devtools_remote_42';
  const bytes = encodeForwardRequest(7, endpoint);
  assert.equal(bytes.byteLength, 4 + FORWARD_PARAMETER_SIZE + endpoint.length + 1);
  assert.equal(bytes[bytes.byteLength - 1], 0);
  assert.deepEqual(
    [...bytes.subarray(4, 4 + FORWARD_PARAMETER_SIZE)],
    new Array(FORWARD_PARAMETER_SIZE).fill(0),
  );
  assert.deepEqual(decodeForwardRequest(bytes), { id: 7, endpoint });
});

test('forward request decoder tolerates extra trailing NULs', () => {
  const bytes = encodeForwardRequest(7, 'tcp:9222');
  const padded = new Uint8Array(bytes.byteLength + 3);
  padded.set(bytes, 0);
  assert.deepEqual(decodeForwardRequest(padded), { id: 7, endpoint: 'tcp:9222' });
});

test('check result parses the success flag byte', () => {
  assert.deepEqual(decodeForwardCheckResult(Uint8Array.of(0, 0, 0, 9, 1)), {
    id: 9,
    success: true,
  });
  assert.deepEqual(decodeForwardCheckResult(Uint8Array.of(0, 0, 0, 9, 0)), {
    id: 9,
    success: false,
  });
  assert.throws(() => decodeForwardCheckResult(Uint8Array.of(0, 0, 0, 9)), /检查结果/u);
});

test('data payload round trips binary chunks', () => {
  const payload = Uint8Array.of(0, 1, 2, 255);
  const bytes = encodeForwardData(0xdeadbeef, payload);
  assert.deepEqual([...bytes.subarray(0, 4)], [0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual(decodeForwardData(bytes), { id: 0xdeadbeef, data: payload });
});

test('free context payload is just the id', () => {
  assert.deepEqual([...encodeForwardFreeContext(0x01020304)], [1, 2, 3, 4]);
});

test('parseForwardEndpoint validates hdc fport endpoint syntax', () => {
  assert.deepEqual(parseForwardEndpoint('tcp:9222'), {
    type: 'tcp',
    value: '9222',
    spec: 'tcp:9222',
  });
  assert.deepEqual(parseForwardEndpoint('localabstract:webview_devtools_remote_1'), {
    type: 'localabstract',
    value: 'webview_devtools_remote_1',
    spec: 'localabstract:webview_devtools_remote_1',
  });
  assert.deepEqual(parseForwardEndpoint('localfilesystem:/tmp/foo.sock'), {
    type: 'localfilesystem',
    value: '/tmp/foo.sock',
    spec: 'localfilesystem:/tmp/foo.sock',
  });
  assert.throws(() => parseForwardEndpoint('missing-colon'), {
    code: 'HDC_FORWARD_INVALID_ENDPOINT',
  });
  assert.throws(() => parseForwardEndpoint(':empty-type'), {
    code: 'HDC_FORWARD_INVALID_ENDPOINT',
  });
  assert.throws(() => parseForwardEndpoint('tcp:'), { code: 'HDC_FORWARD_INVALID_ENDPOINT' });
  assert.throws(() => parseForwardEndpoint('foo:bar'), {
    code: 'HDC_FORWARD_UNSUPPORTED_ENDPOINT',
  });
  assert.throws(() => parseForwardEndpoint('tcp:0'), { code: 'HDC_FORWARD_INVALID_ENDPOINT' });
  assert.throws(() => parseForwardEndpoint('tcp:65536'), { code: 'HDC_FORWARD_INVALID_ENDPOINT' });
  assert.throws(() => parseForwardEndpoint('tcp:not-a-port'), {
    code: 'HDC_FORWARD_INVALID_ENDPOINT',
  });
});
