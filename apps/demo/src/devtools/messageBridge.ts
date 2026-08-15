import type { HdcForward } from '@webhdc/core';
import { devtoolsWebSocketPath } from './discovery';
import { ForwardedWebSocket } from './websocket';

type BridgeStatus =
  | { type: 'frame-ready' }
  | { type: 'frontend-loading' }
  | { type: 'frontend-fallback'; message: string }
  | { type: 'frontend-ready' }
  | { type: 'frontend-error'; message: string };

type BridgeRequest =
  | { type: 'ws-connect'; id: string; url: string; protocols?: string[] }
  | { type: 'ws-send'; id: string; data: string | ArrayBuffer }
  | { type: 'ws-close'; id: string; code?: number; reason?: string }
  | BridgeStatus;

export interface DevtoolsBridgeStatus {
  state: 'loading' | 'open' | 'error' | 'closed';
  message: string;
}

export interface DevtoolsMessageBridgeOptions {
  forward: HdcForward;
  port: MessagePort;
  targetWebSocketUrl: string;
  websocketOrigin: string;
  onStatus?: (status: DevtoolsBridgeStatus) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRequest(value: unknown): BridgeRequest | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }
  if (
    value.type === 'frame-ready' ||
    value.type === 'frontend-loading' ||
    value.type === 'frontend-ready'
  ) {
    return { type: value.type };
  }
  if (value.type === 'frontend-error' && typeof value.message === 'string') {
    return { type: value.type, message: value.message };
  }
  if (value.type === 'frontend-fallback' && typeof value.message === 'string') {
    return { type: value.type, message: value.message };
  }
  if (
    value.type === 'ws-connect' &&
    typeof value.id === 'string' &&
    typeof value.url === 'string'
  ) {
    const protocols = Array.isArray(value.protocols)
      ? value.protocols.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
    return { type: value.type, id: value.id, url: value.url, protocols };
  }
  if (
    value.type === 'ws-send' &&
    typeof value.id === 'string' &&
    (typeof value.data === 'string' || value.data instanceof ArrayBuffer)
  ) {
    return { type: value.type, id: value.id, data: value.data };
  }
  if (value.type === 'ws-close' && typeof value.id === 'string') {
    return {
      type: value.type,
      id: value.id,
      code: typeof value.code === 'number' ? value.code : undefined,
      reason: typeof value.reason === 'string' ? value.reason : undefined,
    };
  }
  return null;
}

export class DevtoolsMessageBridge {
  readonly #forward: HdcForward;
  readonly #port: MessagePort;
  readonly #targetPath: string;
  readonly #websocketOrigin: string;
  readonly #onStatus: NonNullable<DevtoolsMessageBridgeOptions['onStatus']>;
  readonly #connections = new Map<string, ForwardedWebSocket>();
  readonly #connecting = new Set<string>();
  #disposed = false;

  constructor({
    forward,
    port,
    targetWebSocketUrl,
    websocketOrigin,
    onStatus = () => {},
  }: DevtoolsMessageBridgeOptions) {
    this.#forward = forward;
    this.#port = port;
    this.#targetPath = devtoolsWebSocketPath(targetWebSocketUrl);
    this.#websocketOrigin = websocketOrigin;
    this.#onStatus = onStatus;
    port.onmessage = (event: MessageEvent<unknown>) => this.#receive(event.data);
    port.start();
  }

  #receive(value: unknown): void {
    const message = parseRequest(value);
    if (!message || this.#disposed) {
      return;
    }
    if (message.type === 'frame-ready') {
      this.#onStatus({ state: 'loading', message: 'iframe 通信桥已就绪' });
      return;
    }
    if (message.type === 'frontend-loading') {
      this.#onStatus({ state: 'loading', message: '正在加载匹配版本的 DevTools frontend…' });
      return;
    }
    if (message.type === 'frontend-ready') {
      this.#onStatus({ state: 'loading', message: 'DevTools frontend 已加载，正在连接 CDP…' });
      return;
    }
    if (message.type === 'frontend-fallback') {
      this.#onStatus({ state: 'loading', message: message.message });
      return;
    }
    if (message.type === 'frontend-error') {
      this.#onStatus({ state: 'error', message: message.message });
      return;
    }
    if (message.type === 'ws-connect') {
      void this.#connect(message);
      return;
    }
    const connection = this.#connections.get(message.id);
    if (!connection) {
      return;
    }
    if (message.type === 'ws-send') {
      const data =
        typeof message.data === 'string' ? message.data : new Uint8Array(message.data.slice(0));
      void connection.send(data).catch((error: unknown) => this.#postError(message.id, error));
    } else {
      void connection
        .close(message.code ?? 1000, message.reason ?? '')
        .catch((error: unknown) => this.#postError(message.id, error));
    }
  }

  async #connect(message: Extract<BridgeRequest, { type: 'ws-connect' }>): Promise<void> {
    if (this.#connections.has(message.id) || this.#connecting.has(message.id)) {
      this.#postError(message.id, new Error('重复的 WebSocket connection id'));
      return;
    }
    let path: string;
    try {
      path = devtoolsWebSocketPath(message.url);
      if (path !== this.#targetPath) {
        throw new Error(`iframe 尝试连接未授权的 CDP target：${path}`);
      }
    } catch (error) {
      this.#postError(message.id, error);
      this.#post({ type: 'ws-close', id: message.id, code: 1008, reason: 'Target not allowed' });
      return;
    }

    this.#connecting.add(message.id);
    try {
      const connection = await ForwardedWebSocket.connect(
        this.#forward,
        message.url,
        {
          onOpen: () => {
            this.#post({ type: 'ws-open', id: message.id });
            this.#onStatus({ state: 'open', message: 'CDP 已通过 WebHDC 连接' });
          },
          onMessage: (data) => {
            if (typeof data === 'string') {
              this.#post({ type: 'ws-message', id: message.id, data });
            } else {
              const copy = data.slice().buffer;
              this.#post({ type: 'ws-message', id: message.id, data: copy }, [copy]);
            }
          },
          onError: (error) => this.#postError(message.id, error),
          onClose: (code, reason, wasClean) => {
            this.#connections.delete(message.id);
            this.#post({ type: 'ws-close', id: message.id, code, reason, wasClean });
            this.#onStatus({ state: 'closed', message: `CDP 已断开（${code}）` });
          },
        },
        { origin: this.#websocketOrigin, protocols: message.protocols },
      );
      if (this.#disposed) {
        await connection.close().catch(() => {});
      } else {
        this.#connections.set(message.id, connection);
      }
    } catch (error) {
      this.#postError(message.id, error);
      this.#post({ type: 'ws-close', id: message.id, code: 1006, reason: '' });
    } finally {
      this.#connecting.delete(message.id);
    }
  }

  #postError(id: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#post({ type: 'ws-error', id, message });
    this.#onStatus({ state: 'error', message });
  }

  #post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
    if (!this.#disposed) {
      this.#port.postMessage(message, transfer);
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#port.close();
    for (const connection of this.#connections.values()) {
      void connection.close().catch(() => {});
    }
    this.#connections.clear();
  }
}
