import assert from 'node:assert/strict';
import test from 'node:test';

import { deferred, encodeUtf8 } from '../src/bytes.ts';
import { COMMAND, USB_OPTION } from '../src/constants.ts';
import { decodeUsbHeader, encodeHdcPacket, encodeUsbHeader } from '../src/protocol.ts';
import { HdcWebUsbTransport } from '../src/index.ts';

function makeDevice(readQueue) {
  const pendingRead = deferred();
  return {
    opened: false,
    configuration: null,
    configurations: [{ configurationValue: 1 }],
    serialNumber: 'TEST',
    vendorId: 0x12d1,
    productId: 0x5000,
    writes: [],
    async open() {
      this.opened = true;
    },
    async selectConfiguration() {
      this.configuration = {
        interfaces: [
          {
            interfaceNumber: 2,
            alternates: [
              {
                alternateSetting: 0,
                interfaceClass: 0xff,
                interfaceSubclass: 0x50,
                interfaceProtocol: 0x01,
                endpoints: [
                  { direction: 'in', type: 'bulk', endpointNumber: 1, packetSize: 512 },
                  { direction: 'out', type: 'bulk', endpointNumber: 2, packetSize: 512 },
                ],
              },
            ],
          },
        ],
      };
    },
    async claimInterface() {},
    async releaseInterface() {},
    async close() {
      this.opened = false;
      pendingRead.reject(new Error('closed'));
    },
    async transferOut(endpoint, data) {
      this.writes.push({ endpoint, data: new Uint8Array(data).slice() });
      return { status: 'ok', bytesWritten: data.byteLength };
    },
    async transferIn() {
      if (readQueue.length > 0) {
        const bytes = readQueue.shift();
        return {
          status: 'ok',
          data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        };
      }
      return pendingRead.promise;
    },
  };
}

test('WebUSB transport resets and drains stale data before reading UB-framed blocks', async () => {
  const sessionId = 0x12345678;
  const hdcPacket = encodeHdcPacket(7, COMMAND.KERNEL_ECHO_RAW, encodeUtf8('ready'));
  const device = makeDevice([
    encodeHdcPacket(99, COMMAND.KERNEL_ECHO_RAW, encodeUtf8('stale')),
    encodeUsbHeader(sessionId, hdcPacket.byteLength),
    hdcPacket,
  ]);
  const received = deferred();
  const transport = new HdcWebUsbTransport({
    usb: { requestDevice() {}, getDevices() {} },
    sessionId,
    onBlock: (block) => received.resolve(block),
    onError: () => {},
  });

  await transport.open(device);
  assert.deepEqual(await received.promise, hdcPacket);
  assert.deepEqual(decodeUsbHeader(device.writes[0].data), {
    option: USB_OPTION.RESET,
    sessionId: 0,
    dataSize: 0,
  });

  const outgoing = new Uint8Array(512);
  await transport.sendBlock(outgoing);
  assert.equal(device.writes.length, 4);
  assert.equal(device.writes[1].data.byteLength, 11);
  assert.equal(device.writes[2].data.byteLength, 512);
  assert.equal(device.writes[3].data.byteLength, 11);
  await transport.close();
});
