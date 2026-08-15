const OFFICIAL_FRONTEND_HOST = 'chrome-devtools-frontend.appspot.com';
// Chrome 132.0.6834.89 的 Chromium DEPS 所固定的 DevTools frontend revision。
// 部分厂商 WebView 返回私有 WebKit revision，官方 serve_rev 不存在该构建，
// 此时用同一浏览器版本的官方 hosted frontend 作为 CDP 兼容回退。
const COMPATIBLE_FRONTEND_URL =
  'https://chrome-devtools-frontend.appspot.com/serve_rev/@f2f3682c9db8ca427f8c64f0402cc2c5152c6c24/inspector.html';

interface FrameInitMessage {
  type: 'webhdc-devtools-init';
  frontendUrl: string;
}

interface ParentMessage {
  type: string;
  id?: string;
  data?: unknown;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  message?: string;
}

type EventHandler<T extends Event> = ((this: MessageChannelWebSocket, event: T) => unknown) | null;

let bridgePort: MessagePort | null = null;
const sockets = new Map<string, MessageChannelWebSocket>();

function post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
  bridgePort?.postMessage(message, transfer);
}

function normalizeProtocols(protocols?: string | string[]): string[] {
  if (protocols === undefined) {
    return [];
  }
  return Array.isArray(protocols) ? [...protocols] : [protocols];
}

function copyBuffer(input: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (input instanceof ArrayBuffer) {
    return input.slice(0);
  }
  return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
}

class MessageChannelWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = MessageChannelWebSocket.CONNECTING;
  readonly OPEN = MessageChannelWebSocket.OPEN;
  readonly CLOSING = MessageChannelWebSocket.CLOSING;
  readonly CLOSED = MessageChannelWebSocket.CLOSED;
  readonly url: string;
  readonly extensions = '';
  readonly protocol = '';
  readonly #id: string;
  readonly #protocols: string[];
  readyState = MessageChannelWebSocket.CONNECTING;
  bufferedAmount = 0;
  binaryType: BinaryType = 'blob';
  onopen: EventHandler<Event> = null;
  onmessage: EventHandler<MessageEvent> = null;
  onerror: EventHandler<Event> = null;
  onclose: EventHandler<CloseEvent> = null;
  #sendQueue = Promise.resolve();

  constructor(url: string | URL, protocols?: string | string[]) {
    super();
    if (!bridgePort) {
      throw new DOMException('WebHDC bridge 尚未初始化', 'InvalidStateError');
    }
    this.url = new URL(url, window.location.href).href;
    this.#protocols = normalizeProtocols(protocols);
    this.#id = crypto.randomUUID();
    sockets.set(this.#id, this);
    post({ type: 'ws-connect', id: this.#id, url: this.url, protocols: this.#protocols });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== MessageChannelWebSocket.OPEN) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError');
    }
    const size =
      typeof data === 'string'
        ? new TextEncoder().encode(data).byteLength
        : data instanceof Blob
          ? data.size
          : ArrayBuffer.isView(data)
            ? data.byteLength
            : data.byteLength;
    this.bufferedAmount += size;
    this.#sendQueue = this.#sendQueue
      .then(async () => {
        if (typeof data === 'string') {
          post({ type: 'ws-send', id: this.#id, data });
        } else {
          const buffer =
            data instanceof Blob
              ? await data.arrayBuffer()
              : copyBuffer(data as ArrayBuffer | ArrayBufferView);
          post({ type: 'ws-send', id: this.#id, data: buffer }, [buffer]);
        }
      })
      .catch((error: unknown) =>
        this.receiveError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        this.bufferedAmount = Math.max(0, this.bufferedAmount - size);
      });
  }

  close(code = 1000, reason = ''): void {
    if (
      this.readyState === MessageChannelWebSocket.CLOSING ||
      this.readyState === MessageChannelWebSocket.CLOSED
    ) {
      return;
    }
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException('Invalid WebSocket close code', 'InvalidAccessError');
    }
    if (new TextEncoder().encode(reason).byteLength > 123) {
      throw new DOMException('WebSocket close reason is too long', 'SyntaxError');
    }
    this.readyState = MessageChannelWebSocket.CLOSING;
    void this.#sendQueue.then(() => post({ type: 'ws-close', id: this.#id, code, reason }));
  }

  receiveOpen(): void {
    if (this.readyState !== MessageChannelWebSocket.CONNECTING) {
      return;
    }
    this.readyState = MessageChannelWebSocket.OPEN;
    this.emit(new Event('open'), this.onopen);
  }

  receiveMessage(data: unknown): void {
    if (this.readyState !== MessageChannelWebSocket.OPEN) {
      return;
    }
    let eventData = data;
    if (data instanceof ArrayBuffer) {
      eventData = this.binaryType === 'arraybuffer' ? data : new Blob([data]);
    }
    this.emit(new MessageEvent('message', { data: eventData }), this.onmessage);
  }

  receiveError(message: string): void {
    console.error(`[webhdc-devtools] ${message}`);
    this.emit(new Event('error'), this.onerror);
  }

  receiveClose(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === MessageChannelWebSocket.CLOSED) {
      return;
    }
    this.readyState = MessageChannelWebSocket.CLOSED;
    sockets.delete(this.#id);
    this.emit(new CloseEvent('close', { code, reason, wasClean }), this.onclose);
  }

  private emit<T extends Event>(event: T, handler: EventHandler<T>): void {
    try {
      handler?.call(this, event);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
    this.dispatchEvent(event);
  }
}

function receiveParentMessage(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return;
  }
  const message = value as ParentMessage;
  if (typeof message.id !== 'string') {
    return;
  }
  const socket = sockets.get(message.id);
  if (!socket) {
    return;
  }
  if (message.type === 'ws-open') {
    socket.receiveOpen();
  } else if (message.type === 'ws-message') {
    socket.receiveMessage(message.data);
  } else if (message.type === 'ws-error') {
    socket.receiveError(message.message ?? 'WebHDC WebSocket bridge error');
  } else if (message.type === 'ws-close') {
    socket.receiveClose(message.code ?? 1006, message.reason ?? '', message.wasClean ?? false);
  }
}

function installWebSocketBridge(port: MessagePort): void {
  bridgePort = port;
  port.onmessage = (event: MessageEvent<unknown>) => receiveParentMessage(event.data);
  port.start();
  Object.defineProperty(window, 'WebSocket', {
    configurable: true,
    writable: true,
    value: MessageChannelWebSocket,
  });
}

/** 让官方远端 ES module worker 通过同源 blob 壳启动。 */
function installCrossOriginWorkerBridge(): void {
  const NativeWorker = window.Worker;
  class CrossOriginWorker extends NativeWorker {
    constructor(scriptURL: string | URL, options: WorkerOptions = {}) {
      const resolved = new URL(scriptURL, document.baseURI);
      if (
        resolved.origin === window.location.origin ||
        resolved.protocol === 'blob:' ||
        resolved.protocol === 'data:' ||
        resolved.hostname !== OFFICIAL_FRONTEND_HOST
      ) {
        super(resolved, options);
        return;
      }
      const source =
        options.type === 'module'
          ? `import ${JSON.stringify(resolved.href)};`
          : `importScripts(${JSON.stringify(resolved.href)});`;
      const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      super(blobUrl, options);
      const release = () => URL.revokeObjectURL(blobUrl);
      this.addEventListener('message', release, { once: true });
      this.addEventListener('error', release, { once: true });
      window.setTimeout(release, 60_000);
    }
  }
  Object.defineProperty(window, 'Worker', {
    configurable: true,
    writable: true,
    value: CrossOriginWorker,
  });
}

function officialUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.hostname !== OFFICIAL_FRONTEND_HOST || !/^https?:$/u.test(url.protocol)) {
    throw new Error('只允许加载 Chromium 官方托管的 DevTools frontend');
  }
  url.protocol = 'https:';
  url.username = '';
  url.password = '';
  url.searchParams.delete('ws');
  url.searchParams.delete('wss');
  return url;
}

function resolveOfficialAsset(raw: string, base: URL): string {
  const asset = new URL(raw, base);
  if (asset.hostname !== OFFICIAL_FRONTEND_HOST || asset.protocol !== 'https:') {
    throw new Error(`DevTools frontend 引用了非官方资源：${asset.href}`);
  }
  return asset.href;
}

function bootstrapElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#webhdc-bootstrap');
}

async function loadFrontend(rawUrl: string): Promise<void> {
  const preferredUrl = officialUrl(rawUrl);
  post({ type: 'frontend-loading' });
  const { frontendUrl, source } = await fetchFrontendEntry(preferredUrl);
  await warmCriticalFrontendAssets(frontendUrl);
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  const scripts = [...parsed.querySelectorAll<HTMLScriptElement>('script[src]')];
  if (scripts.length === 0) {
    throw new Error('DevTools frontend 入口中没有可加载的脚本');
  }

  const base = document.createElement('base');
  base.href = new URL('.', frontendUrl).href;
  document.head.prepend(base);
  document.title = parsed.title || 'DevTools';

  for (const sourceStyle of parsed.querySelectorAll<HTMLStyleElement>('style')) {
    const style = document.createElement('style');
    style.textContent = sourceStyle.textContent;
    document.head.append(style);
  }
  for (const sourceLink of parsed.querySelectorAll<HTMLLinkElement>(
    'link[rel="stylesheet"][href]',
  )) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = resolveOfficialAsset(sourceLink.getAttribute('href') ?? '', frontendUrl);
    document.head.append(link);
  }

  const parsedBody = parsed.body;
  document.body.className = parsedBody.className || 'undocked';
  document.body.id = parsedBody.id || '-blink-dev-tools';
  bootstrapElement()?.remove();

  await Promise.all(
    scripts.map(
      (sourceScript) =>
        new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.type = sourceScript.type || 'text/javascript';
          script.src = resolveOfficialAsset(sourceScript.getAttribute('src') ?? '', frontendUrl);
          script.referrerPolicy = 'no-referrer';
          script.onload = () => resolve();
          script.onerror = () => reject(new Error(`加载 DevTools 脚本失败：${script.src}`));
          document.head.append(script);
        }),
    ),
  );
  post({ type: 'frontend-ready' });
}

/**
 * DevTools 会给 locale 请求设置很短的超时。先在模块图开始并发下载前填充
 * HTTP cache，避免远端 serve_rev 连接繁忙时 locale 初始化直接失败。
 */
async function warmCriticalFrontendAssets(frontendUrl: URL): Promise<void> {
  const localeUrl = new URL('core/i18n/locales/en-US.json', new URL('.', frontendUrl));
  try {
    const response = await fetch(localeUrl, {
      cache: 'force-cache',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    await response.arrayBuffer();
  } catch (error) {
    console.warn('[webhdc-devtools] 预取 en-US locale 失败，将由 frontend 重试', error);
  }
}

async function fetchFrontendEntry(
  preferredUrl: URL,
): Promise<{ frontendUrl: URL; source: string }> {
  const fallbackUrl = officialUrl(COMPATIBLE_FRONTEND_URL);
  const candidates =
    preferredUrl.href === fallbackUrl.href ? [preferredUrl] : [preferredUrl, fallbackUrl];
  const failures: string[] = [];

  for (const frontendUrl of candidates) {
    try {
      const response = await fetch(frontendUrl, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (frontendUrl.href !== preferredUrl.href) {
        const message = '设备版本 frontend 不可用，已切换到 Chromium 官方兼容版本';
        console.warn(`[webhdc-devtools] ${message}`);
        post({ type: 'frontend-fallback', message });
      }
      return { frontendUrl, source: await response.text() };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`下载 DevTools frontend 入口失败：${failures.join('；')}`);
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[webhdc-devtools] DevTools frontend 启动失败', error);
  const element = bootstrapElement() ?? document.body.appendChild(document.createElement('pre'));
  element.id = 'webhdc-bootstrap';
  element.dataset.error = 'true';
  element.textContent = `DevTools frontend 启动失败\n${message}`;
  post({ type: 'frontend-error', message });
}

function isInitMessage(value: unknown): value is FrameInitMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'webhdc-devtools-init' &&
    'frontendUrl' in value &&
    typeof value.frontendUrl === 'string'
  );
}

function initialize(event: MessageEvent<unknown>): void {
  if (
    event.source !== window.parent ||
    event.origin !== window.location.origin ||
    !isInitMessage(event.data) ||
    !event.ports[0]
  ) {
    return;
  }
  window.removeEventListener('message', initialize);
  installWebSocketBridge(event.ports[0]);
  installCrossOriginWorkerBridge();
  post({ type: 'frame-ready' });
  void loadFrontend(event.data.frontendUrl).catch(showError);
}

window.addEventListener('message', initialize);
