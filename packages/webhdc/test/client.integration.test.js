import assert from 'node:assert/strict';
import test from 'node:test';

import { HdcClient } from '../src/index.ts';
import { AUTH_TLV, AUTH_TYPE, COMMAND, USB_OPTION } from '../src/constants.ts';
import {
  decodeHandshake,
  decodeHdcPacket,
  decodeUsbHeader,
  encodeHandshake,
  encodeHdcPacket,
  encodeTransferConfig,
  encodeTransferPayload,
  encodeUsbHeader,
  isUsbHeader,
} from '../src/protocol.ts';
import { encodeStringTlv } from '../src/tlv.ts';

class FakeHdcDevice {
  #readQueue = [];
  #readWaiters = [];
  #outgoingHeader = null;
  #sessionId = 0;

  constructor() {
    this.opened = false;
    this.configuration = null;
    this.configurations = [{ configurationValue: 1 }];
    this.serialNumber = 'FAKE-HDC';
    this.manufacturerName = 'OpenHarmony';
    this.productName = 'Fake HDC Device';
    this.vendorId = 0x12d1;
    this.productId = 0x5000;
  }

  async open() {
    this.opened = true;
  }

  async selectConfiguration() {
    this.configuration = {
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {
              alternateSetting: 0,
              interfaceClass: 0xff,
              interfaceSubclass: 0x50,
              interfaceProtocol: 0x01,
              endpoints: [
                { direction: 'in', type: 'bulk', endpointNumber: 1, packetSize: 512 },
                { direction: 'out', type: 'bulk', endpointNumber: 1, packetSize: 512 },
              ],
            },
          ],
        },
      ],
    };
  }

  async claimInterface() {}

  async releaseInterface() {}

  async close() {
    this.opened = false;
    for (const waiter of this.#readWaiters.splice(0)) {
      waiter.reject(new Error('device closed'));
    }
  }

  async transferOut(_endpoint, input) {
    const bytes = new Uint8Array(input).slice();
    if (isUsbHeader(bytes)) {
      const header = decodeUsbHeader(bytes);
      if (header.option & USB_OPTION.RESET) {
        this.#sessionId = 0;
      } else if (header.option & USB_OPTION.HEADER) {
        this.#sessionId = header.sessionId;
        this.#outgoingHeader = header;
      }
    } else if (this.#outgoingHeader) {
      assert.equal(bytes.byteLength, this.#outgoingHeader.dataSize);
      this.#outgoingHeader = null;
      this.#handlePacket(decodeHdcPacket(bytes));
    }
    return { status: 'ok', bytesWritten: bytes.byteLength };
  }

  async transferIn() {
    if (this.#readQueue.length > 0) {
      return this.#asTransferResult(this.#readQueue.shift());
    }
    return new Promise((resolve, reject) => {
      this.#readWaiters.push({ resolve, reject });
    });
  }

  #asTransferResult(bytes) {
    return {
      status: 'ok',
      data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
  }

  #enqueue(bytes) {
    const waiter = this.#readWaiters.shift();
    if (waiter) {
      waiter.resolve(this.#asTransferResult(bytes));
    } else {
      this.#readQueue.push(bytes);
    }
  }

  #sendPacket(channelId, command, data = new Uint8Array()) {
    const packet = encodeHdcPacket(channelId, command, data);
    this.#enqueue(encodeUsbHeader(this.#sessionId, packet.byteLength));
    this.#enqueue(packet);
  }

  #handlePacket(packet) {
    if (packet.command === COMMAND.KERNEL_HANDSHAKE) {
      const request = decodeHandshake(packet.data);
      this.#sessionId = request.sessionId;
      this.#sendPacket(
        0,
        COMMAND.KERNEL_HANDSHAKE,
        encodeHandshake({
          authType: AUTH_TYPE.OK,
          sessionId: request.sessionId,
          connectKey: request.connectKey,
          version: 'Ver: 3.2.0d',
          buffer: encodeStringTlv({
            [AUTH_TLV.DEVICE_NAME]: 'fake-device',
            [AUTH_TLV.DAEMON_AUTH_STATUS]: 'SUCCESS',
          }),
        }),
      );
      this.#sendPacket(0, COMMAND.KERNEL_CHANNEL_CLOSE, Uint8Array.of(1));
      return;
    }

    if (packet.command === COMMAND.FILE_INIT) {
      this.#sendPacket(packet.channelId, COMMAND.KERNEL_WAKEUP_SLAVE_TASK);
      this.#sendPacket(
        packet.channelId,
        COMMAND.FILE_CHECK,
        encodeTransferConfig({
          fileSize: 3,
          path: 'download.bin',
          optionalName: 'download.bin',
        }),
      );
      return;
    }

    if (packet.command === COMMAND.FILE_BEGIN) {
      this.#sendPacket(
        packet.channelId,
        COMMAND.FILE_DATA,
        encodeTransferPayload(0, Uint8Array.of(0x61, 0x62, 0x63)),
      );
      return;
    }

    if (packet.command === COMMAND.FILE_FINISH && packet.data[0] === 1) {
      this.#sendPacket(packet.channelId, COMMAND.FILE_FINISH, Uint8Array.of(0));
      return;
    }

    if (
      packet.command === COMMAND.KERNEL_CHANNEL_CLOSE &&
      packet.channelId !== 0 &&
      packet.data[0] === 1
    ) {
      this.#sendPacket(packet.channelId, COMMAND.KERNEL_CHANNEL_CLOSE, Uint8Array.of(0));
    }
  }
}

test('HdcClient completes the receiver-side file finish and close handshake', async () => {
  const device = new FakeHdcDevice();
  const client = new HdcClient({
    usb: {
      getDevices: async () => [device],
      requestDevice: async () => device,
    },
  });

  const info = await client.connect(device);
  assert.equal(info.daemon.name, 'fake-device');
  assert.equal(info.daemon.authStatus, 'SUCCESS');

  const result = await client.receiveFile('/data/local/tmp/download.bin');
  assert.deepEqual(result.data, Uint8Array.of(0x61, 0x62, 0x63));
  assert.equal(result.size, 3);
  assert.equal(result.name, 'download.bin');

  await client.disconnect();
});
