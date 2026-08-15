import {
  concatBytes,
  decodeUtf8,
  encodeUtf8,
  readUint32BE,
  toUint8Array,
  writeUint32BE,
  type ByteInput,
} from './bytes.js';
import { HdcError, HdcProtocolError } from './errors.js';
import type { HdcBinaryInput } from './types.js';

/**
 * 与上游 HdcForwardBase::FORWARD_PARAMENTER_BUFSIZE 一致：
 * forward 请求 payload 中 id 之后的保留参数位长度。
 */
export const FORWARD_PARAMETER_SIZE = 8;

export const FORWARD_ENDPOINT_TYPES = Object.freeze([
  'tcp',
  'localabstract',
  'localreserved',
  'localfilesystem',
  'dev',
  'jdwp',
] as const);

export type HdcForwardEndpointType = (typeof FORWARD_ENDPOINT_TYPES)[number];

export interface HdcForwardEndpoint {
  type: HdcForwardEndpointType;
  value: string;
  spec: string;
}

/**
 * 解析 "type:value" 形式的 forward 端点描述（如
 * `tcp:9222`、`localabstract:webview_devtools_remote_123`），
 * 与上游 CheckNodeInfo 的校验行为保持一致。
 */
export function parseForwardEndpoint(spec: string): HdcForwardEndpoint {
  const colon = spec.indexOf(':');
  if (colon <= 0 || colon === spec.length - 1) {
    throw new HdcError(`无效的 forward 端点: ${JSON.stringify(spec)}`, {
      code: 'HDC_FORWARD_INVALID_ENDPOINT',
    });
  }
  const type = spec.slice(0, colon);
  const value = spec.slice(colon + 1);
  if (!(FORWARD_ENDPOINT_TYPES as readonly string[]).includes(type)) {
    throw new HdcError(
      `不支持的 forward 端点类型: ${JSON.stringify(type)}（支持 ${FORWARD_ENDPOINT_TYPES.join('/')}）`,
      { code: 'HDC_FORWARD_UNSUPPORTED_ENDPOINT' },
    );
  }
  if (type === 'tcp') {
    const port = Number(value);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new HdcError(`无效的 tcp 端口: ${JSON.stringify(value)}`, {
        code: 'HDC_FORWARD_INVALID_ENDPOINT',
      });
    }
  }
  return { type: type as HdcForwardEndpointType, value, spec };
}

/**
 * 所有 forward 任务命令的 payload 都以 4 字节大端 context id 开头
 * （对应上游 SendToTask 的 htonl(cid)）。
 */
export function encodeForwardContextId(id: number): Uint8Array {
  const output = new Uint8Array(4);
  writeUint32BE(output, 0, id >>> 0);
  return output;
}

export function decodeForwardContextId(input: ByteInput): number {
  const bytes = toUint8Array(input);
  if (bytes.byteLength < 4) {
    throw new HdcProtocolError(`forward 数据缺少 context id: 仅 ${bytes.byteLength} 字节`);
  }
  return readUint32BE(bytes, 0);
}

/**
 * FORWARD_CHECK / FORWARD_ACTIVE_SLAVE 请求 payload：
 * be32(id) + 8 字节参数位 + 端点字符串 + '\0'
 */
export function encodeForwardRequest(id: number, endpoint: string): Uint8Array {
  return concatBytes(
    encodeForwardContextId(id),
    new Uint8Array(FORWARD_PARAMETER_SIZE),
    encodeUtf8(endpoint),
    Uint8Array.of(0),
  );
}

export function decodeForwardRequest(input: ByteInput): { id: number; endpoint: string } {
  const bytes = toUint8Array(input);
  if (bytes.byteLength < 4 + FORWARD_PARAMETER_SIZE + 1) {
    throw new HdcProtocolError(`forward 请求 payload 不完整: ${bytes.byteLength} 字节`);
  }
  let end = bytes.byteLength;
  while (end > 4 + FORWARD_PARAMETER_SIZE && bytes[end - 1] === 0) {
    end -= 1;
  }
  return {
    id: readUint32BE(bytes, 0),
    endpoint: decodeUtf8(bytes.subarray(4 + FORWARD_PARAMETER_SIZE, end)),
  };
}

/**
 * FORWARD_CHECK_RESULT payload：be32(id) + 1 字节原始状态标志。
 *
 * 注意：该字节不能直接判定 forward 是否成功。原生实现会在成功的 libuv
 * connect status=0 时发送 0，host 侧只把收到结果包本身视为确认。
 */
export function decodeForwardCheckResult(input: ByteInput): { id: number; success: boolean } {
  const bytes = toUint8Array(input);
  if (bytes.byteLength < 5) {
    throw new HdcProtocolError(`forward 检查结果 payload 不完整: ${bytes.byteLength} 字节`);
  }
  return { id: readUint32BE(bytes, 0), success: bytes[4] !== 0 };
}

/**
 * FORWARD_DATA payload：be32(id) + 裸数据
 */
export function encodeForwardData(id: number, data: ByteInput): Uint8Array {
  return concatBytes(encodeForwardContextId(id), toUint8Array(data));
}

export function decodeForwardData(input: ByteInput): { id: number; data: Uint8Array } {
  const bytes = toUint8Array(input);
  if (bytes.byteLength < 4) {
    throw new HdcProtocolError(`forward 数据 payload 不完整: ${bytes.byteLength} 字节`);
  }
  return { id: readUint32BE(bytes, 0), data: bytes.slice(4) };
}

/**
 * FORWARD_FREE_CONTEXT / FORWARD_ACTIVE_MASTER payload：仅 be32(id)
 */
export function encodeForwardFreeContext(id: number): Uint8Array {
  return encodeForwardContextId(id);
}

export interface HdcForwardStreamOptions {
  contextId: number;
  remote: string;
  closed: Promise<void>;
  write: (data: Uint8Array) => Promise<number>;
  close: () => Promise<void>;
  onData: (listener: (data: Uint8Array) => void) => () => void;
  onClose: (listener: (error: Error | null) => void) => () => void;
  onError: (listener: (error: Error) => void) => () => void;
}

/**
 * 一条已建立的 forward 虚拟流：浏览器端为 master 的本地端点，
 * 设备端由 daemon 连接到 remote 端点。双向裸字节流。
 */
export class HdcForwardStream {
  readonly contextId: number;
  readonly remote: string;
  /** 流完全关闭后 resolve（无论由哪一侧发起，永不 reject） */
  readonly closed: Promise<void>;
  #write: (data: Uint8Array) => Promise<number>;
  #close: () => Promise<void>;
  #onData: (listener: (data: Uint8Array) => void) => () => void;
  #onClose: (listener: (error: Error | null) => void) => () => void;
  #onError: (listener: (error: Error) => void) => () => void;

  constructor({
    contextId,
    remote,
    closed,
    write,
    close,
    onData,
    onClose,
    onError,
  }: HdcForwardStreamOptions) {
    this.contextId = contextId;
    this.remote = remote;
    this.closed = closed;
    this.#write = write;
    this.#close = close;
    this.#onData = onData;
    this.#onClose = onClose;
    this.#onError = onError;
  }

  /** 向设备端写入数据，resolve 为实际写入的字节数 */
  write(data: HdcBinaryInput): Promise<number> {
    return this.#write(toUint8Array(data));
  }

  /** 主动关闭本流（通知设备端释放 context） */
  close(): Promise<void> {
    return this.#close();
  }

  /** 订阅设备端发来的数据，返回退订函数 */
  onData(listener: (data: Uint8Array) => void): () => void {
    return this.#onData(listener);
  }

  /** 订阅流关闭（error 为 null 表示正常关闭，否则为关闭原因） */
  onClose(listener: (error: Error | null) => void): () => void {
    return this.#onClose(listener);
  }

  /** 订阅流异常（缓冲溢出、会话断开等），随后流会被关闭 */
  onError(listener: (error: Error) => void): () => void {
    return this.#onError(listener);
  }
}

export interface HdcForwardConstructorOptions {
  channelId: number;
  remote: string;
  closed: Promise<void>;
  accept: () => Promise<HdcForwardStream>;
  close: () => Promise<void>;
}

/**
 * 一次 forward 会话（对应 daemon 侧一个 forward task / 一条 channel）。
 * 本地端点是虚拟的：每次调用 accept() 相当于一个本地客户端接入，
 * 返回与设备端点建立连接后的 HdcForwardStream。
 */
export class HdcForward {
  readonly channelId: number;
  readonly remote: string;
  /** forward 会话关闭后 resolve（channel 关闭，永不 reject） */
  readonly closed: Promise<void>;
  #accept: () => Promise<HdcForwardStream>;
  #close: () => Promise<void>;

  constructor({ channelId, remote, closed, accept, close }: HdcForwardConstructorOptions) {
    this.channelId = channelId;
    this.remote = remote;
    this.closed = closed;
    this.#accept = accept;
    this.#close = close;
  }

  /** 接受一个虚拟的本地客户端接入，resolve 为已连通的流 */
  accept(): Promise<HdcForwardStream> {
    return this.#accept();
  }

  /** 关闭整个 forward 会话（关闭底层 channel，daemon 释放所有 context） */
  close(): Promise<void> {
    return this.#close();
  }
}
