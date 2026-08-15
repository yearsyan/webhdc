import type { HdcForward, HdcForwardStream } from '@webhdc/core';
import { tryParseHttpResponse } from './http';

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder('utf-8', { fatal: true });
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_FRAME_SIZE = 32 * 1024 * 1024;

export interface ParsedWebSocketFrame {
  fin: boolean;
  opcode: number;
  masked: boolean;
  payload: Uint8Array;
}

export interface ForwardedWebSocketCallbacks {
  onOpen: () => void;
  onMessage: (data: string | Uint8Array) => void;
  onError: (error: Error) => void;
  onClose: (code: number, reason: string, wasClean: boolean) => void;
}

export interface ForwardedWebSocketOptions {
  timeout?: number;
  origin?: string;
  protocols?: string[];
  maxFrameSize?: number;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
}

function joinBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function withTimeout<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeout);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 编码一帧 WebSocket 数据。客户端帧传入 4 字节 mask，服务端测试帧传 null。 */
export function encodeWebSocketFrame(
  opcode: number,
  payload: Uint8Array,
  mask: Uint8Array | null = randomBytes(4),
  fin = true,
): Uint8Array {
  if (opcode < 0 || opcode > 0x0f) {
    throw new Error(`无效的 WebSocket opcode：${opcode}`);
  }
  if (mask !== null && mask.byteLength !== 4) {
    throw new Error('WebSocket mask 必须为 4 字节');
  }
  const length = payload.byteLength;
  const lengthBytes = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const headerSize = 2 + lengthBytes + (mask ? 4 : 0);
  const output = new Uint8Array(headerSize + length);
  output[0] = (fin ? 0x80 : 0) | opcode;
  output[1] = mask ? 0x80 : 0;
  if (lengthBytes === 0) {
    output[1] |= length;
  } else if (lengthBytes === 2) {
    output[1] |= 126;
    new DataView(output.buffer).setUint16(2, length, false);
  } else {
    output[1] |= 127;
    new DataView(output.buffer).setBigUint64(2, BigInt(length), false);
  }
  const payloadOffset = 2 + lengthBytes + (mask ? 4 : 0);
  if (mask) {
    output.set(mask, 2 + lengthBytes);
    for (let index = 0; index < length; index += 1) {
      output[payloadOffset + index] = payload[index] ^ mask[index % 4];
    }
  } else {
    output.set(payload, payloadOffset);
  }
  return output;
}

export class WebSocketFrameParser {
  #buffer: Uint8Array = new Uint8Array();
  readonly #maxFrameSize: number;

  constructor(maxFrameSize = DEFAULT_MAX_FRAME_SIZE) {
    this.#maxFrameSize = maxFrameSize;
  }

  push(chunk: Uint8Array): ParsedWebSocketFrame[] {
    this.#buffer = concatBytes(this.#buffer, chunk);
    const frames: ParsedWebSocketFrame[] = [];

    while (this.#buffer.byteLength >= 2) {
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (rsv !== 0) {
        throw new Error('收到包含未知 RSV 位的 WebSocket 帧');
      }
      if (length === 126) {
        if (this.#buffer.byteLength < 4) {
          break;
        }
        length = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + 2, 2).getUint16(
          0,
          false,
        );
        offset += 2;
      } else if (length === 127) {
        if (this.#buffer.byteLength < 10) {
          break;
        }
        const wideLength = new DataView(
          this.#buffer.buffer,
          this.#buffer.byteOffset + 2,
          8,
        ).getBigUint64(0, false);
        if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('WebSocket 帧长度超出 JavaScript 安全整数范围');
        }
        length = Number(wideLength);
        offset += 8;
      }
      if (length > this.#maxFrameSize) {
        throw new Error(`WebSocket 帧超过 ${this.#maxFrameSize} 字节`);
      }
      let mask: Uint8Array | null = null;
      if (masked) {
        if (this.#buffer.byteLength < offset + 4) {
          break;
        }
        mask = this.#buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (this.#buffer.byteLength < offset + length) {
        break;
      }
      const payload = this.#buffer.slice(offset, offset + length);
      if (mask) {
        for (let index = 0; index < payload.byteLength; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      frames.push({ fin, opcode, masked, payload });
      this.#buffer = this.#buffer.slice(offset + length);
    }

    return frames;
  }
}

async function expectedAccept(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', encoder.encode(`${key}${WEBSOCKET_GUID}`));
  return bytesToBase64(new Uint8Array(digest));
}

function websocketRequest(url: URL, key: string, origin: string, protocols: string[]): string {
  const protocolHeader =
    protocols.length > 0 ? [`Sec-WebSocket-Protocol: ${protocols.join(', ')}`] : [];
  return [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    'Host: 127.0.0.1:9222',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Origin: ${origin}`,
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    ...protocolHeader,
    '',
    '',
  ].join('\r\n');
}

type ConnectionState = 'connecting' | 'open' | 'closing' | 'closed';

/** WebSocket wire protocol over one `HdcForwardStream`. */
export class ForwardedWebSocket {
  readonly #stream: HdcForwardStream;
  readonly #callbacks: ForwardedWebSocketCallbacks;
  readonly #parser: WebSocketFrameParser;
  readonly #maxMessageSize: number;
  readonly #key: string;
  #state: ConnectionState = 'connecting';
  #incoming: Uint8Array = new Uint8Array();
  #drainQueue = Promise.resolve();
  #writeQueue = Promise.resolve();
  #fragmentOpcode: number | null = null;
  #fragments: Uint8Array[] = [];
  #fragmentSize = 0;
  #handshakeResolve: (() => void) | null = null;
  #handshakeReject: ((error: Error) => void) | null = null;
  #closeCode = 1006;
  #closeReason = '';
  #closeWasClean = false;
  #reportedClose = false;
  #unsubscribeData: () => void;
  #unsubscribeClose: () => void;
  #unsubscribeError: () => void;

  private constructor(
    stream: HdcForwardStream,
    callbacks: ForwardedWebSocketCallbacks,
    maxFrameSize: number,
  ) {
    this.#stream = stream;
    this.#callbacks = callbacks;
    this.#parser = new WebSocketFrameParser(maxFrameSize);
    this.#maxMessageSize = maxFrameSize;
    this.#key = bytesToBase64(randomBytes(16));
    this.#unsubscribeData = stream.onData((data) => this.#receive(data));
    this.#unsubscribeClose = stream.onClose((error) => this.#streamClosed(error));
    this.#unsubscribeError = stream.onError((error) => this.#fail(error));
  }

  static async connect(
    forward: HdcForward,
    rawUrl: string,
    callbacks: ForwardedWebSocketCallbacks,
    {
      timeout = 10_000,
      origin = window.location.origin,
      protocols = [],
      maxFrameSize = DEFAULT_MAX_FRAME_SIZE,
    }: ForwardedWebSocketOptions = {},
  ): Promise<ForwardedWebSocket> {
    const url = new URL(rawUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error(`不支持的 WebSocket URL：${rawUrl}`);
    }
    if (protocols.some((protocol) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(protocol))) {
      throw new Error('WebSocket 子协议包含非法字符');
    }
    const stream = await withTimeout(
      forward.accept(),
      timeout,
      `连接 ${forward.remote} 的 WebSocket 超时`,
    );
    const connection = new ForwardedWebSocket(stream, callbacks, maxFrameSize);
    try {
      await connection.#start(url, origin, protocols, timeout);
      return connection;
    } catch (error) {
      await stream.close().catch(() => {});
      throw error;
    }
  }

  async #start(url: URL, origin: string, protocols: string[], timeout: number): Promise<void> {
    const handshake = new Promise<void>((resolve, reject) => {
      this.#handshakeResolve = resolve;
      this.#handshakeReject = reject;
    });
    await this.#stream.write(encoder.encode(websocketRequest(url, this.#key, origin, protocols)));
    await withTimeout(handshake, timeout, `等待 ${url.pathname} WebSocket Upgrade 超时`);
  }

  #receive(data: Uint8Array): void {
    if (this.#state === 'closed') {
      return;
    }
    this.#incoming = concatBytes(this.#incoming, data);
    this.#drainQueue = this.#drainQueue
      .then(() => this.#drain())
      .catch((error: unknown) => this.#fail(error));
  }

  async #drain(): Promise<void> {
    if (this.#state === 'connecting') {
      const response = tryParseHttpResponse(this.#incoming);
      if (!response) {
        return;
      }
      this.#incoming = this.#incoming.slice(response.consumed);
      if (response.status !== 101) {
        throw new Error(
          `WebSocket Upgrade 失败：HTTP ${response.status} ${response.statusText}`.trim(),
        );
      }
      if (!/\bwebsocket\b/iu.test(response.headers.get('upgrade') ?? '')) {
        throw new Error('WebSocket Upgrade 响应缺少 Upgrade: websocket');
      }
      const actualAccept = response.headers.get('sec-websocket-accept') ?? '';
      if (actualAccept !== (await expectedAccept(this.#key))) {
        throw new Error('WebSocket Upgrade 的 Sec-WebSocket-Accept 校验失败');
      }
      this.#state = 'open';
      this.#handshakeResolve?.();
      this.#handshakeResolve = null;
      this.#handshakeReject = null;
      this.#callbacks.onOpen();
    }

    if (this.#state !== 'open' && this.#state !== 'closing') {
      return;
    }
    const frames = this.#parser.push(this.#incoming);
    this.#incoming = new Uint8Array();
    for (const frame of frames) {
      await this.#handleFrame(frame);
    }
  }

  async #handleFrame(frame: ParsedWebSocketFrame): Promise<void> {
    if (frame.masked) {
      throw new Error('设备端发送了不符合协议的 masked WebSocket 帧');
    }
    const isControl = frame.opcode >= 0x08;
    if (isControl && (!frame.fin || frame.payload.byteLength > 125)) {
      throw new Error('WebSocket 控制帧格式无效');
    }

    if (frame.opcode === 0x08) {
      if (frame.payload.byteLength === 1) {
        throw new Error('WebSocket Close 帧长度无效');
      }
      const code =
        frame.payload.byteLength >= 2
          ? new DataView(frame.payload.buffer, frame.payload.byteOffset, 2).getUint16(0, false)
          : 1000;
      const reason =
        frame.payload.byteLength > 2 ? fatalDecoder.decode(frame.payload.subarray(2)) : '';
      this.#state = 'closing';
      this.#closeCode = code;
      this.#closeReason = reason;
      this.#closeWasClean = true;
      await this.#writeFrame(0x08, frame.payload).catch(() => {});
      await this.#stream.close().catch(() => {});
      this.#finishClose();
      return;
    }
    if (frame.opcode === 0x09) {
      await this.#writeFrame(0x0a, frame.payload);
      return;
    }
    if (frame.opcode === 0x0a) {
      return;
    }
    if (frame.opcode !== 0x00 && frame.opcode !== 0x01 && frame.opcode !== 0x02) {
      throw new Error(`不支持的 WebSocket opcode：${frame.opcode}`);
    }

    if (frame.opcode === 0x00) {
      if (this.#fragmentOpcode === null) {
        throw new Error('收到没有起始帧的 WebSocket continuation');
      }
    } else {
      if (this.#fragmentOpcode !== null) {
        throw new Error('上一条 WebSocket 分片消息尚未结束');
      }
      this.#fragmentOpcode = frame.opcode;
    }
    this.#fragments.push(frame.payload);
    this.#fragmentSize += frame.payload.byteLength;
    if (this.#fragmentSize > this.#maxMessageSize) {
      throw new Error(`WebSocket 分片消息超过 ${this.#maxMessageSize} 字节`);
    }
    if (!frame.fin) {
      return;
    }
    const opcode = this.#fragmentOpcode;
    const payload = joinBytes(this.#fragments);
    this.#fragmentOpcode = null;
    this.#fragments = [];
    this.#fragmentSize = 0;
    this.#callbacks.onMessage(opcode === 0x01 ? fatalDecoder.decode(payload) : payload);
  }

  #writeFrame(opcode: number, payload: Uint8Array): Promise<void> {
    const frame = encodeWebSocketFrame(opcode, payload);
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#stream.write(frame);
    });
    return this.#writeQueue;
  }

  async send(data: string | Uint8Array): Promise<void> {
    if (this.#state !== 'open') {
      throw new Error('WebSocket 尚未打开或已经关闭');
    }
    try {
      await this.#writeFrame(
        typeof data === 'string' ? 0x01 : 0x02,
        typeof data === 'string' ? encoder.encode(data) : data,
      );
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async close(code = 1000, reason = ''): Promise<void> {
    if (this.#state === 'closed' || this.#state === 'closing') {
      return;
    }
    if (!Number.isInteger(code) || code < 1000 || code > 4999) {
      throw new Error(`无效的 WebSocket close code：${code}`);
    }
    const reasonBytes = encoder.encode(reason);
    if (reasonBytes.byteLength > 123) {
      throw new Error('WebSocket close reason 不能超过 123 字节');
    }
    this.#state = 'closing';
    this.#closeCode = code;
    this.#closeReason = reason;
    this.#closeWasClean = true;
    const payload = new Uint8Array(2 + reasonBytes.byteLength);
    new DataView(payload.buffer).setUint16(0, code, false);
    payload.set(reasonBytes, 2);
    await this.#writeFrame(0x08, payload).catch(() => {});
    await this.#stream.close().catch(() => {});
    this.#finishClose();
  }

  #streamClosed(error: Error | null): void {
    if (error) {
      this.#callbacks.onError(error);
    }
    if (this.#state === 'connecting') {
      this.#handshakeReject?.(error ?? new Error('WebSocket Upgrade 前连接已关闭'));
    }
    this.#state = 'closed';
    this.#finishClose();
  }

  #fail(error: unknown): void {
    if (this.#state === 'closed') {
      return;
    }
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.#callbacks.onError(normalized);
    this.#handshakeReject?.(normalized);
    this.#handshakeResolve = null;
    this.#handshakeReject = null;
    this.#state = 'closed';
    void this.#stream.close().catch(() => {});
    this.#finishClose();
  }

  #finishClose(): void {
    if (this.#reportedClose) {
      return;
    }
    this.#reportedClose = true;
    this.#state = 'closed';
    this.#unsubscribeData();
    this.#unsubscribeClose();
    this.#unsubscribeError();
    this.#callbacks.onClose(this.#closeCode, this.#closeReason, this.#closeWasClean);
  }
}
