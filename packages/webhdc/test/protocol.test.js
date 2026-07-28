import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_TYPE,
  COMMAND,
  HDC,
  decodeHandshake,
  decodeHdcPacket,
  decodeTransferConfig,
  decodeTransferPayload,
  decodeUsbHeader,
  encodeHandshake,
  encodeHdcPacket,
  encodePayloadProtect,
  encodeTransferConfig,
  encodeTransferPayload,
  encodeUsbHeader,
} from '../src/index.ts';
import { concatBytes, encodeUtf8 } from '../src/bytes.ts';
import { decodeMessage, decodeVarint, encodeVarint } from '../src/protobuf.ts';
import { decodeStringTlv, encodeStringTlv } from '../src/tlv.ts';

test('varint supports the full uint64 range used by HDC', () => {
  for (const value of [0n, 1n, 127n, 128n, 0xffffffffn, 0x1234567890abcdefn]) {
    const encoded = encodeVarint(value);
    const decoded = decodeVarint(encoded);
    assert.equal(decoded.value, value);
    assert.equal(decoded.offset, encoded.byteLength);
  }
});

test('USB header matches the packed C++ USBHead layout', () => {
  const bytes = encodeUsbHeader(0x12345678, 0x01020304);
  assert.deepEqual([...bytes], [0x55, 0x42, 0x01, 0x12, 0x34, 0x56, 0x78, 0x01, 0x02, 0x03, 0x04]);
  assert.deepEqual(decodeUsbHeader(bytes), {
    option: 1,
    sessionId: 0x12345678,
    dataSize: 0x01020304,
  });
});

test('PayloadProtect emits zero-valued fields like SerialStruct', () => {
  const bytes = encodePayloadProtect({
    channelId: 0x1234,
    command: COMMAND.UNITY_EXECUTE,
  });
  assert.deepEqual([...bytes], [0x08, 0xb4, 0x24, 0x10, 0xe9, 0x07, 0x18, 0x00, 0x20, 0x09]);
});

test('HDC packet round trips command and binary payload', () => {
  const payload = Uint8Array.of(0, 1, 2, 255);
  const packet = encodeHdcPacket(42, COMMAND.FILE_DATA, payload);
  assert.equal(packet[0], 'H'.charCodeAt(0));
  assert.equal(packet[1], 'W'.charCodeAt(0));
  assert.equal(packet[4], HDC.PROTOCOL_VERSION);
  const decoded = decodeHdcPacket(packet);
  assert.equal(decoded.channelId, 42);
  assert.equal(decoded.command, COMMAND.FILE_DATA);
  assert.deepEqual(decoded.data, payload);
});

test('SessionHandShake keeps all six official fields', () => {
  const encoded = encodeHandshake({
    authType: AUTH_TYPE.PUBLIC_KEY,
    sessionId: 0xfeedbeef,
    connectKey: 'SERIAL',
    buffer: Uint8Array.of(0, 12, 255),
    version: 'Ver: 3.2.0d',
  });
  const fields = decodeMessage(encoded);
  assert.deepEqual([...fields.keys()], [1, 2, 3, 4, 5, 6]);
  const decoded = decodeHandshake(encoded);
  assert.equal(decoded.banner, 'OHOS HDC');
  assert.equal(decoded.authType, AUTH_TYPE.PUBLIC_KEY);
  assert.equal(decoded.sessionId, 0xfeedbeef);
  assert.equal(decoded.connectKey, 'SERIAL');
  assert.deepEqual(decoded.buffer, Uint8Array.of(0, 12, 255));
  assert.equal(decoded.version, 'Ver: 3.2.0d');
});

test("string TLV matches HDC's fixed 16-byte tag and length fields", () => {
  const encoded = encodeStringTlv({
    authtype: '1',
    supportfeatures: 'heartbeat',
  });
  assert.equal(
    new TextDecoder().decode(encoded.subarray(0, 32)),
    'authtype        1               ',
  );
  assert.deepEqual(decodeStringTlv(encoded), {
    authtype: '1',
    supportfeatures: 'heartbeat',
  });
});

test('TransferConfig and 64-byte file payload prefix round trip', () => {
  const config = encodeTransferConfig({
    fileSize: 123_456,
    path: '/data/local/tmp/demo.txt',
    optionalName: 'demo.txt',
    updateIfNew: true,
  });
  assert.deepEqual(decodeTransferConfig(config), {
    fileSize: 123_456,
    atime: 0,
    mtime: 0,
    options: '',
    path: '/data/local/tmp/demo.txt',
    optionalName: 'demo.txt',
    updateIfNew: true,
    compressType: 0,
    holdTimestamp: false,
    functionName: '',
    clientCwd: '',
    reserve1: '',
    reserve2: '',
  });

  const body = encodeUtf8('HarmonyOS');
  const payload = encodeTransferPayload(4096, body);
  assert.equal(payload.byteLength, HDC.TRANSFER_PREFIX_SIZE + body.byteLength);
  assert.deepEqual(decodeTransferPayload(payload), {
    index: 4096,
    compressType: 0,
    compressSize: body.byteLength,
    uncompressSize: body.byteLength,
    data: body,
  });
});

test('multiple HDC frames remain independent USB blocks', () => {
  const first = encodeHdcPacket(1, COMMAND.KERNEL_ECHO_RAW, encodeUtf8('a'));
  const second = encodeHdcPacket(2, COMMAND.KERNEL_ECHO_RAW, encodeUtf8('b'));
  const stream = concatBytes(first, second);
  assert.equal(stream.byteLength, first.byteLength + second.byteLength);
  assert.equal(decodeHdcPacket(first).channelId, 1);
  assert.equal(decodeHdcPacket(second).channelId, 2);
});
