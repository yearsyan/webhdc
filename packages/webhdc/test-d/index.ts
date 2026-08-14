import {
  HdcClient,
  HdcWebUsbTransport,
  type HdcDeviceInfo,
  type HdcExecResult,
  type HdcFileReceiveResult,
  type HdcFileSendResult,
  type HdcForward,
  type HdcForwardStream,
  type HdcScreenshotResult,
  type HdcUsbApi,
} from '@webhdc/core';

declare const usb: HdcUsbApi;
declare const upload: File;

const client = new HdcClient({
  usb,
  logger(level, message, detail) {
    void [level, message, detail];
  },
});

const unsubscribe = client.on('status', ({ state, message }) => {
  void [state, message];
});

const transport = new HdcWebUsbTransport({
  usb,
  sessionId: 1,
  onBlock(bytes) {
    void bytes.byteLength;
  },
});

async function exercisePublicApi(): Promise<void> {
  const device = await client.requestDevice({
    filters: [{ vendorId: 0x12d1, productId: 0x5000 }],
  });
  const info: HdcDeviceInfo = await client.connect(device);
  const command: HdcExecResult = await client.exec('param get const.product.model');
  const sent: HdcFileSendResult = await client.sendFile(upload, '/data/local/tmp/example.hap');
  const received: HdcFileReceiveResult = await client.receiveFile(sent.remotePath);
  const shot: HdcScreenshotResult = await client.captureScreenshot({
    onProgress({ transferred, total, ratio }) {
      void [transferred, total, ratio];
    },
  });

  // DevTools 场景：Fake WebSocket 只需要一条双向字节流
  const forward: HdcForward = await client.forward('localabstract:webview_devtools_remote_123', {
    highWaterMark: 4 * 1024 * 1024,
  });
  const stream: HdcForwardStream = await forward.accept();
  const unsubscribeData = stream.onData((data) => {
    void data.byteLength;
  });
  const unsubscribeClose = stream.onClose((error) => {
    void error;
  });
  const written: number = await stream.write(new TextEncoder().encode('GET /json HTTP/1.1\r\n'));
  await stream.close();
  unsubscribeData();
  unsubscribeClose();
  await forward.close();

  void [info, command.stdout, received.blob, shot.blob, written];
  await client.disconnect();
}

void [exercisePublicApi, transport, unsubscribe];
