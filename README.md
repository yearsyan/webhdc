# webhdc

`webhdc` 是一个通过 WebUSB 在浏览器中直接连接 HarmonyOS / OpenHarmony
设备的 HDC 客户端。它不依赖本机 `hdc server`，协议实现参考了同级目录中的
`developtools_hdc_standard`，并按当前 HDC 3.x 的握手与 RSA-PSS 鉴权流程做了兼容。

## 工作区

这是一个基于 pnpm 的 monorepo：

- `packages/webhdc`：零运行时依赖的纯 TypeScript HDC/WebUSB 库，构建时
  通过 tsup 打包为单一 ESM 文件与单一 `.d.ts` 类型文件。
- `apps/demo`：依赖 `@webhdc/core` 的 Vite + React + TypeScript 演示页面
  （CSS Modules 样式），提供设备信息、远程终端、文件传输与 HAP 安装。

当前实现包括：

- HDC USB 接口发现与占用；
- `UB` USB 分帧和 `HW` HDC 数据包编解码；
- HDC 3.x 握手、设备授权和 RSA-PSS 3072/SHA-512 签名；
- 一次性命令、交互式 shell；
- 单文件上传和下载（无压缩模式）；
- 通道生命周期、超时、取消、错误与进度事件；
- IndexedDB 持久化浏览器主机密钥。

## 运行 Demo

要求 Node.js 20+、pnpm，以及支持 WebUSB 的桌面版 Chrome 或 Edge。

```bash
pnpm install
pnpm dev
```

随后打开 Vite 输出的 `http://localhost:5173`。WebUSB 要求安全上下文；
`localhost` 可直接使用，非本机部署应使用 HTTPS。

连接前需要：

1. 在设备上开启 USB 调试。
2. 停止会独占 USB 接口的 DevEco Studio/HDC 服务，例如执行 `hdc kill`。
3. 点击页面中的“连接设备”并在浏览器设备选择器中选中 HDC 设备。
4. 首次连接时，在设备屏幕上确认新的 HDC 主机公钥。

## 使用库

`requestDevice()` 必须从用户点击等浏览器用户手势中调用：

```ts
import { HdcClient } from '@webhdc/core';

const client = new HdcClient();

connectButton.addEventListener('click', async () => {
  const usbDevice = await client.requestDevice();
  const info = await client.connect(usbDevice);
  console.log(info);

  const result = await client.exec('param get const.product.model');
  console.log(result.stdout);
});
```

交互式 shell：

```ts
const shell = await client.openShell({
  onData: (bytes) => terminal.write(bytes),
});

await shell.writeText('pwd\n');
await shell.close();
```

文件传输：

```ts
await client.sendFile(file, `/data/local/tmp/${file.name}`, {
  onProgress: ({ ratio }) => console.log(ratio),
});

const result = await client.receiveFile('/data/local/tmp/report.txt');
const url = URL.createObjectURL(result.blob);
```

更多 API 见 [`packages/webhdc/README.md`](packages/webhdc/README.md)，协议映射见
[`docs/protocol.md`](docs/protocol.md)。

## 验证

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm check
```

core 使用严格 TypeScript 配置。协议测试覆盖 USB/HDC 数据头、protobuf wire
format、握手、TLV、文件块和模拟 WebUSB 读写；Demo 的生产构建由 Vite 完成。

## 当前边界

- 目标是当前 HDC 3.x 设备；旧版仅 RSA 加密的鉴权流程未实现。
- WebUSB 目前主要由桌面 Chromium 浏览器提供，Firefox 和 Safari 不支持。
- 文件传输实现单文件、无压缩模式；目录同步、LZ4、应用安装、端口转发、JDWP
  等命令尚未封装。
- `sendCommand()` 和导出的协议编解码器可用于继续扩展其他 HDC 命令。

## 协议来源

- 本地参考：`../developtools_hdc_standard`
- 当前上游：[OpenHarmony developtools_hdc](https://gitee.com/openharmony/developtools_hdc)
- 使用说明：[OpenHarmony HDC 文档](https://gitee.com/openharmony/docs/blob/master/en/device-dev/subsystems/subsys-toolchain-hdc-guide.md)
