import assert from 'node:assert/strict';
import test from 'node:test';

import { HdcClient } from '../src/index.ts';
import { AUTH_TLV, AUTH_TYPE, COMMAND, USB_OPTION } from '../src/constants.ts';
import {
  decodeForwardContextId,
  decodeForwardData,
  decodeForwardRequest,
  encodeForwardContextId,
  encodeForwardData,
} from '../src/forward.ts';
import { concatBytes } from '../src/bytes.ts';
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

  constructor({ fileContent, forwardCheckOk = true } = {}) {
    this.opened = false;
    this.configuration = null;
    this.configurations = [{ configurationValue: 1 }];
    this.serialNumber = 'FAKE-HDC';
    this.manufacturerName = 'OpenHarmony';
    this.productName = 'Fake HDC Device';
    this.vendorId = 0x12d1;
    this.productId = 0x5000;
    this.fileContent = fileContent ?? Uint8Array.of(0x61, 0x62, 0x63);
    this.execCommands = [];
    this.forwardCheckOk = forwardCheckOk;
    this.forwardChannelId = null;
    this.forwardEndpoint = null;
    this.forwardActive = [];
    this.forwardData = [];
    this.awakenedChannels = new Set();
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

  closeForwardStream(contextId) {
    this.#sendPacket(
      this.forwardChannelId,
      COMMAND.FORWARD_FREE_CONTEXT,
      encodeForwardContextId(contextId),
    );
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

    if (packet.command === COMMAND.KERNEL_WAKEUP_SLAVE_TASK) {
      this.awakenedChannels.add(packet.channelId);
      return;
    }

    if (packet.command === COMMAND.FORWARD_CHECK) {
      assert.ok(
        this.awakenedChannels.has(packet.channelId),
        'forward channel must wake the daemon slave task before checking the endpoint',
      );
      const { id, endpoint } = decodeForwardRequest(packet.data);
      this.forwardChannelId = packet.channelId;
      this.forwardEndpoint = endpoint;
      this.#sendPacket(
        packet.channelId,
        COMMAND.FORWARD_CHECK_RESULT,
        concatBytes(encodeForwardContextId(id), Uint8Array.of(this.forwardCheckOk ? 1 : 0)),
      );
      return;
    }

    if (packet.command === COMMAND.FORWARD_ACTIVE_SLAVE) {
      const { id, endpoint } = decodeForwardRequest(packet.data);
      this.forwardActive.push({ id, endpoint });
      this.#sendPacket(packet.channelId, COMMAND.FORWARD_ACTIVE_MASTER, encodeForwardContextId(id));
      return;
    }

    if (packet.command === COMMAND.FORWARD_DATA) {
      const { id, data } = decodeForwardData(packet.data);
      this.forwardData.push({ id, text: new TextDecoder().decode(data) });
      // echo server: 模拟设备端 socket 回显
      this.#sendPacket(packet.channelId, COMMAND.FORWARD_DATA, encodeForwardData(id, data));
      return;
    }

    if (packet.command === COMMAND.FORWARD_FREE_CONTEXT) {
      this.#sendPacket(
        packet.channelId,
        COMMAND.FORWARD_FREE_CONTEXT,
        encodeForwardContextId(decodeForwardContextId(packet.data)),
      );
      return;
    }

    if (packet.command === COMMAND.UNITY_EXECUTE) {
      const command = new TextDecoder().decode(packet.data);
      this.execCommands.push(command);
      const output = command.startsWith('snapshot_display')
        ? `snapshot success, write to file: ${command.split(' ').at(-1)}`
        : '';
      this.#sendPacket(packet.channelId, COMMAND.KERNEL_ECHO_RAW, new TextEncoder().encode(output));
      this.#sendPacket(packet.channelId, COMMAND.KERNEL_CHANNEL_CLOSE, Uint8Array.of(1));
      return;
    }

    if (packet.command === COMMAND.FILE_INIT) {
      this.#sendPacket(packet.channelId, COMMAND.KERNEL_WAKEUP_SLAVE_TASK);
      this.#sendPacket(
        packet.channelId,
        COMMAND.FILE_CHECK,
        encodeTransferConfig({
          fileSize: this.fileContent.byteLength,
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
        encodeTransferPayload(0, this.fileContent),
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

test('HdcClient forwards a virtual stream to a device abstract socket', async () => {
  const device = new FakeHdcDevice();
  const client = new HdcClient({
    usb: {
      getDevices: async () => [device],
      requestDevice: async () => device,
    },
  });

  await client.connect(device);

  const forward = await client.forward('localabstract:webview_devtools_remote_123');
  assert.equal(forward.remote, 'localabstract:webview_devtools_remote_123');
  assert.equal(device.forwardEndpoint, 'localabstract:webview_devtools_remote_123');

  const stream = await forward.accept();
  assert.ok(stream.contextId > 0);
  assert.equal(device.forwardActive.at(-1)?.endpoint, 'localabstract:webview_devtools_remote_123');

  const received = [];
  const bothReceived = new Promise((resolve) => {
    stream.onData((data) => {
      received.push(new TextDecoder().decode(data));
      if (received.length === 2) {
        resolve();
      }
    });
  });
  const closedEvent = new Promise((resolve) => stream.onClose((error) => resolve(error)));

  await stream.write('ping');
  await stream.write('pong');
  await bothReceived;
  assert.deepEqual(received, ['ping', 'pong']);
  assert.deepEqual(
    device.forwardData.map((entry) => entry.text),
    ['ping', 'pong'],
  );

  // 设备端关闭（例如 webview 退出）
  device.closeForwardStream(stream.contextId);
  assert.equal(await closedEvent, null);
  await stream.closed;
  await assert.rejects(stream.write('late'), { code: 'HDC_FORWARD_CLOSED' });

  // 关闭整个 forward 会话
  await forward.close();
  await forward.closed;
  await client.disconnect();
});

test('HdcClient accepts the zero-valued check acknowledgement emitted by native HDC', async () => {
  const device = new FakeHdcDevice({ forwardCheckOk: false });
  const client = new HdcClient({
    usb: {
      getDevices: async () => [device],
      requestDevice: async () => device,
    },
  });

  await client.connect(device);
  const forward = await client.forward('tcp:9222');
  assert.equal(forward.remote, 'tcp:9222');
  await forward.close();
  await client.disconnect();
});

test('HdcClient rejects forward for invalid endpoints', async () => {
  const device = new FakeHdcDevice();
  const client = new HdcClient({
    usb: {
      getDevices: async () => [device],
      requestDevice: async () => device,
    },
  });

  await client.connect(device);
  await assert.rejects(client.forward('not-an-endpoint'), { code: 'HDC_FORWARD_INVALID_ENDPOINT' });
  await assert.rejects(client.forward('udp:53'), { code: 'HDC_FORWARD_UNSUPPORTED_ENDPOINT' });
  await client.disconnect();
});

test('HdcClient captures a screenshot via shell command and pulls it back', async () => {
  const jpegBytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9);
  const device = new FakeHdcDevice({ fileContent: jpegBytes });
  const client = new HdcClient({
    usb: {
      getDevices: async () => [device],
      requestDevice: async () => device,
    },
  });

  await client.connect(device);
  const result = await client.captureScreenshot();

  assert.equal(result.size, jpegBytes.byteLength);
  assert.deepEqual(result.data, jpegBytes);
  assert.match(result.name, /^hdc-web-screenshot-\d+\.jpeg$/u);
  assert.equal(result.remotePath, `/data/local/tmp/${result.name}`);
  assert.match(result.stdout, /snapshot success/u);
  assert.equal(result.blob?.type, 'image/jpeg');

  const [snapshotCommand, cleanupCommand] = device.execCommands;
  assert.match(snapshotCommand, /^snapshot_display -f \/data\/local\/tmp\//u);
  assert.equal(cleanupCommand, `rm -f ${result.remotePath}`);

  await client.disconnect();
});
