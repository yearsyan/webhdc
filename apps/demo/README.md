# @hdc-web/demo

`@webhdc/core` 的演示页面，基于 **Vite + TypeScript + React + CSS Modules**
实现。页面以 hash router 组织为多个功能标签页（`#/terminal`、`#/files`、
`#/transfer`、`#/screenshot`、`#/apps`），未连接设备时展示空状态：

- **终端**：HDC 远程终端（xterm.js 渲染，一次性命令与全双工交互式 shell，
  支持 ANSI 颜色、命令历史与清屏）；
- **文件浏览**：浏览设备文件系统（面包屑导航、进入目录、点击文件直接
  下载、上传到当前目录、新建文件夹、删除）；
- **文件传输**：单文件上传 / 下载（带进度条）；
- **屏幕截图**：执行 `snapshot_display` 截取设备屏幕，拉取到浏览器预览与
  下载（自动清理设备临时文件）；
- **应用管理**：HAP 安装（推送 `.hap` 后执行 `bm install -p`，可自动清理
  远端包）、查看已安装应用（`bm dump -a` + 过滤 + `bm dump -n` 详情）与
  卸载（`bm uninstall -n`，可选保留数据）。

连接设备后，将鼠标悬停（或点击）顶栏的连接状态胶囊即可查看设备信息浮层
（握手信息 + `param get` 设备参数）。

从仓库根目录运行：

```bash
pnpm dev
```

使用桌面版 Chrome 或 Edge 打开 `http://localhost:5173`。连接前请停止本机
HDC server，以便浏览器占用设备的 USB 接口。
