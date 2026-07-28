# @webhdc/core

面向浏览器的纯 TypeScript HDC 3.x 客户端，通过 WebUSB 直接连接
HarmonyOS/OpenHarmony 设备。包本身没有运行时依赖，构建时使用 tsup 打包为单一 ESM 文件（`dist/index.js`）与单一
`.d.ts` 类型文件（`dist/index.d.ts`），并附带 source map。

TypeScript 项目无需额外安装 WebUSB 类型包；`HdcUsbApi`、`HdcUsbDevice`、
事件映射、操作参数和返回值类型均由 `@webhdc/core` 直接导出。

## 环境

- 支持 WebUSB 和 Web Crypto 的 Chromium 浏览器；
- `localhost` 或 HTTPS 安全上下文；
- 设备暴露 class `0xff`、subclass `0x50`、protocol `0x01` 的 HDC USB 接口。

## 连接

```ts
import { HdcClient } from '@webhdc/core';

const client = new HdcClient({
  hostName: 'my-web-debugger',
  logger(level, message, detail) {
    console.log(level, message, detail);
  },
});

client.on('authorizationrequired', () => {
  console.log('请在设备上确认 USB 调试授权');
});

const device = await client.requestDevice();
const info = await client.connect(device);
```

浏览器要求 `requestDevice()` 在用户手势中执行。对已经授权过的设备，也可以使用：

```ts
const devices = await client.getDevices();
await client.connect(devices[0]);
```

## 命令和 Shell

```ts
const result = await client.exec('uname -a', {
  timeout: 30_000,
  onOutput(bytes) {
    console.log(new TextDecoder().decode(bytes));
  },
  onMessage(message) {
    console.log(message.level, message.text);
  },
});

console.log(result.stdout);
```

```ts
const shell = await client.openShell({
  onData(bytes) {
    terminal.write(bytes);
  },
});

await shell.writeText('ls -la /data/local/tmp\n');
await shell.close();
await shell.closed;
```

## 文件

上传可接收浏览器 `File`/`Blob`，也可接收 `Uint8Array`：

```ts
await client.sendFile(file, '/data/local/tmp/example.bin', {
  timeout: 120_000,
  onProgress({ transferred, total, ratio }) {
    console.log(transferred, total, ratio);
  },
});
```

下载默认在内存中返回 `Uint8Array` 和 `Blob`：

```ts
const result = await client.receiveFile('/data/local/tmp/example.bin');
console.log(result.data, result.blob);
```

也可以传入支持 `getWriter()` 的 `WritableStream`，避免把大文件全部保存在内存：

```ts
await client.receiveFile('/data/local/tmp/large.bin', {
  writable: fileWritableStream,
});
```

## 取消与断开

`exec`、`openShell`、`sendFile` 和 `receiveFile` 均支持 `AbortSignal`。完成后调用：

```ts
await client.disconnect();
```

## 事件

`client.on(type, listener)` 支持以下事件：

- `status`：连接状态与人类可读提示；
- `connect` / `disconnect`；
- `authorizationrequired`：设备端需要用户确认；
- `message`：HDC `KERNEL_ECHO` 消息；
- `packet`：未被高层 API 消费的数据包；
- `log` / `error`。

## 低层扩展

包导出了 `COMMAND`、`HdcWebUsbTransport` 及 USB/HDC/握手/文件 protobuf
编解码器。连接后可用 `client.sendCommand(channelId, command, data)` 发送尚未封装的
命令。
