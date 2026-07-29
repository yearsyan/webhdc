# HDC WebUSB 协议映射

本文记录 `@webhdc/core` 使用的 HDC 3.x 子集。实现首先对照本地
`developtools_hdc_standard`，并用当前 OpenHarmony `developtools_hdc` 中的
会话、鉴权和传输代码校准。

## USB 接口与分帧

HDC 使用 vendor-specific USB 接口：

| 字段     | 值                 |
| -------- | ------------------ |
| class    | `0xff`             |
| subclass | `0x50`             |
| protocol | `0x01`             |
| endpoint | 一对 bulk IN / OUT |

每个 HDC block 前有一个独立的 11 字节 `USBHead`：

| 偏移 | 长度 | 内容                                    |
| ---: | ---: | --------------------------------------- |
|    0 |    2 | ASCII `UB`                              |
|    2 |    1 | option，bit 0 为 header，bit 1 为 reset |
|    3 |    4 | session id，大端                        |
|    7 |    4 | block 长度，大端                        |

头和 block 使用不同的 bulk transfer。block 长度正好是 endpoint packet size
整数倍时，发送端再写一个 option 为 0、长度为 0 的 `UB` dummy header，用于结束
USB 传输。

## HDC 数据包

USB block 内是一个 HDC 数据包。固定头同样为 11 字节：

| 偏移 | 长度 | 内容                        |
| ---: | ---: | --------------------------- |
|    0 |    2 | ASCII `HW`                  |
|    2 |    2 | reserve                     |
|    4 |    1 | protocol version，当前为 1  |
|    5 |    2 | `PayloadProtect` 长度，大端 |
|    7 |    4 | payload 长度，大端          |

其后依次是 protobuf wire-format 的 `PayloadProtect` 和命令 payload。
`PayloadProtect` 字段为：

1. `channelId`
2. `command`
3. `checksum`
4. `vCode`，当前固定为 9

HDC 的 `SerialStruct` 会序列化零值，因此编码器也保留所有字段，而不是采用常规
proto3 的零值省略行为。

## 握手与鉴权

握手命令是 `CMD_KERNEL_HANDSHAKE`（1），使用 `SessionHandShake`：

1. `banner`：`OHOS HDC`
2. `authType`
3. `sessionId`
4. `connectKey`
5. `buf`
6. `version`

客户端初始发送 `AUTH_NONE`，并在字符串 TLV 中声明 `authtype=1`，表示支持
RSA 3072/SHA-512。后续流程：

1. 设备返回 `AUTH_PUBLICKEY`。
2. 浏览器生成或读取 IndexedDB 中的 3072 位 RSA-PSS 密钥。
3. 浏览器发送 `hostname + 0x0c + SubjectPublicKeyInfo PEM`。
4. 新主机需要用户在设备端确认；设备随后发送 `AUTH_SIGNATURE` 挑战。
5. 浏览器用 SHA-512、PSS salt length 64 签名，并发送 Base64 签名。
6. 设备返回 `AUTH_OK`；当 TLV 中仍是 `DAEMON_UNAUTH` 时继续等待设备授权，
   不把该消息误判为连接完成。

字符串 TLV 的 tag 和 length 均为 16 字节、用空格补齐，随后紧跟 UTF-8 value。

## 通道

控制消息使用 channel 0。业务 API 分配非零 32 位 channel id：

- 一次性命令：`CMD_UNITY_EXECUTE`（1001），输出为
  `CMD_KERNEL_ECHO_RAW`（10）。
- 交互 shell：`CMD_SHELL_INIT`（2000）和 `CMD_SHELL_DATA`（2001）。
- 结束：`CMD_KERNEL_CHANNEL_CLOSE`（2），一字节计数从 1 递减到 0。

## 文件传输

单文件上传：

1. `CMD_KERNEL_WAKEUP_SLAVETASK`
2. `CMD_FILE_CHECK` + `TransferConfig`
3. 设备返回 `CMD_FILE_BEGIN`
4. 浏览器发送若干 `CMD_FILE_DATA`
5. 双方完成 `CMD_FILE_FINISH` 的 1 → 0 确认
6. 通道关闭

单文件下载：

1. 浏览器发送 `CMD_FILE_INIT`，payload 为 `remotePath localPlaceholder`
2. 设备发送 `CMD_KERNEL_WAKEUP_SLAVETASK` 和 `CMD_FILE_CHECK`
3. 浏览器回复 `CMD_FILE_BEGIN`
4. 设备发送若干 `CMD_FILE_DATA`
5. 浏览器在达到 `TransferConfig.fileSize` 后主动发送 `CMD_FILE_FINISH(1)`
6. 设备回复 `CMD_FILE_FINISH(0)`
7. 浏览器作为传输 slave 发送 `CMD_KERNEL_CHANNEL_CLOSE(1)` 并完成关闭确认

每个文件数据块预留 64 字节 protobuf 前缀，字段为文件偏移、压缩类型、压缩长度和
原始长度。当前实现只声明并接受 `COMPRESS_NONE`。
