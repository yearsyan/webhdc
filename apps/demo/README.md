# @hdc-web/demo

`@webhdc/core` 的演示页面，基于 **Vite + TypeScript + React + CSS Modules**
实现，提供：

- 设备连接与设备信息查看（握手信息 + `param get` 设备参数）；
- HDC 远程终端（xterm.js 渲染，一次性命令与全双工交互式 shell，支持
  ANSI 颜色、命令历史与清屏）；
- 单文件上传 / 下载（带进度条）；
- HAP 安装（推送 `.hap` 后执行 `bm install -p`，可自动清理远端包）。

从仓库根目录运行：

```bash
pnpm dev
```

使用桌面版 Chrome 或 Edge 打开 `http://localhost:5173`。连接前请停止本机
HDC server，以便浏览器占用设备的 USB 接口。
