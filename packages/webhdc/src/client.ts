import {
  concatBytes,
  decodeUtf8,
  deferred,
  encodeUtf8,
  randomUint32,
  toHex,
  toUint8Array,
  type ByteInput,
  type Deferred,
} from './bytes.js';
import { AUTH_TLV, AUTH_TYPE, COMMAND, HDC, MESSAGE_LEVEL } from './constants.js';
import { HdcKeyStore, defaultHostName } from './auth.js';
import { Emitter } from './emitter.js';
import { HdcDisconnectedError, HdcError, HdcProtocolError, HdcTimeoutError } from './errors.js';
import {
  decodeHandshake,
  decodeHdcPacket,
  decodeTransferConfig,
  decodeTransferPayload,
  encodeHandshake,
  encodeHdcPacket,
  encodeTransferConfig,
  encodeTransferPayload,
  quoteHdcArgument,
} from './protocol.js';
import { decodeStringTlv, encodeStringTlv } from './tlv.js';
import { HdcWebUsbTransport } from './usb-transport.js';
import type {
  HdcBinaryInput,
  HdcClientEventMap,
  HdcDeviceInfo,
  HdcExecResult,
  HdcFileReceiveResult,
  HdcFileSendResult,
  HdcHandshake,
  HdcInteger,
  HdcInterfaceInfo,
  HdcLogLevel,
  HdcMessage,
  HdcPacket,
  HdcProgress,
  HdcShellCloseResult,
  HdcStatusState,
  HdcTransferConfig,
  HdcUsbApi,
  HdcUsbDevice,
  HdcUsbDeviceFilter,
  HdcWritable,
} from './types.js';

const DEFAULT_OPERATION_TIMEOUT = 30_000;
const DEFAULT_AUTH_TIMEOUT = 120_000;

interface FileSourceOptions {
  name?: string;
  lastModified?: number;
}

interface FileSource {
  size: number;
  name: string;
  lastModified: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

type ChannelType = 'exec' | 'shell' | 'file-send' | 'file-receive';
type ChannelResult = HdcExecResult | HdcShellCloseResult | HdcFileSendResult | HdcFileReceiveResult;

interface InternalChannel {
  id: number;
  type: ChannelType;
  deferred: Deferred<ChannelResult>;
  timer: ReturnType<typeof setTimeout> | null;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
  closed: boolean;
  closing: boolean;
  chunks: Uint8Array[];
  messages: HdcMessage[];
  onOutput?: (data: Uint8Array) => void;
  onMessage?: (message: HdcMessage) => void;
  source: FileSource | null;
  remotePath: string;
  onProgress?: (progress: HdcProgress) => void;
  transferred: number;
  started: boolean;
  finished: boolean;
  pump: Promise<void> | null;
  writable: HdcWritable | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  expectedOffset: number;
  config: HdcTransferConfig | null;
  finishRequested: boolean;
}

export interface HdcClientOptions {
  usb?: HdcUsbApi;
  keyStore?: HdcKeyStore;
  hostName?: string;
  version?: string;
  logger?: (level: HdcLogLevel, message: string, detail?: unknown) => void;
  authTimeout?: number;
}

export interface HdcRequestDeviceOptions {
  filters?: readonly HdcUsbDeviceFilter[];
}

export interface HdcExecOptions {
  timeout?: number;
  signal?: AbortSignal;
  onOutput?: (data: Uint8Array) => void;
  onMessage?: (message: HdcMessage) => void;
}

export interface HdcShellOptions {
  timeout?: number;
  signal?: AbortSignal;
  onData?: (data: Uint8Array) => void;
  onMessage?: (message: HdcMessage) => void;
}

export interface HdcFileSendOptions {
  name?: string;
  lastModified?: number;
  timeout?: number;
  signal?: AbortSignal;
  updateIfNew?: boolean;
  onProgress?: (progress: HdcProgress) => void;
}

export interface HdcFileReceiveOptions {
  timeout?: number;
  signal?: AbortSignal;
  writable?: HdcWritable;
  onProgress?: (progress: HdcProgress) => void;
}

interface HdcShellConstructorOptions {
  channelId: number;
  closed: Promise<HdcShellCloseResult>;
  write: (data: Uint8Array) => Promise<number>;
  close: () => Promise<HdcShellCloseResult>;
}

function asSafeNumber(value: HdcInteger, label: string): number {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new HdcProtocolError(`${label} 超出 JavaScript 安全整数范围`);
    }
    return Number(value);
  }
  return value;
}

function defaultLogger(): void {}

function normalizeFileSource(
  input: Blob | HdcBinaryInput,
  options: FileSourceOptions = {},
): FileSource {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const file = input as Blob & Partial<Pick<File, 'name' | 'lastModified'>>;
    return {
      size: input.size,
      name: options.name ?? file.name ?? 'upload.bin',
      lastModified: options.lastModified ?? file.lastModified ?? Date.now(),
      read: async (start: number, end: number) =>
        new Uint8Array(await input.slice(start, end).arrayBuffer()),
    };
  }
  const bytes = toUint8Array(input as HdcBinaryInput);
  return {
    size: bytes.byteLength,
    name: options.name ?? 'upload.bin',
    lastModified: options.lastModified ?? Date.now(),
    read: async (start: number, end: number) => bytes.slice(start, end),
  };
}

function makeDeviceInfo(device: HdcUsbDevice, interfaceInfo: HdcInterfaceInfo): HdcDeviceInfo {
  return {
    serialNumber: device.serialNumber ?? '',
    manufacturerName: device.manufacturerName ?? '',
    productName: device.productName ?? '',
    vendorId: device.vendorId,
    productId: device.productId,
    vendorIdHex: `0x${toHex(device.vendorId)}`,
    productIdHex: `0x${toHex(device.productId)}`,
    interface: interfaceInfo,
    daemon: null,
  };
}

export class HdcShell {
  readonly channelId: number;
  readonly closed: Promise<HdcShellCloseResult>;
  #write: (data: Uint8Array) => Promise<number>;
  #close: () => Promise<HdcShellCloseResult>;

  constructor({ channelId, closed, write, close }: HdcShellConstructorOptions) {
    this.channelId = channelId;
    this.closed = closed;
    this.#write = write;
    this.#close = close;
  }

  write(data: HdcBinaryInput): Promise<number> {
    return this.#write(toUint8Array(data));
  }

  writeText(text: string): Promise<number> {
    return this.#write(encodeUtf8(text));
  }

  close(): Promise<HdcShellCloseResult> {
    return this.#close();
  }
}

export class HdcClient {
  #usb?: HdcUsbApi;
  #keyStore: HdcKeyStore;
  #hostName: string;
  #version: string;
  #logger: NonNullable<HdcClientOptions['logger']>;
  #authTimeout: number;
  #events: Emitter<HdcClientEventMap>;
  #transport: HdcWebUsbTransport | null;
  #sessionId: number;
  #nextChannelId: number;
  #channels: Map<number, InternalChannel>;
  #handshake: Deferred<HdcDeviceInfo> | null;
  #connected: boolean;
  #connecting: boolean;
  #deviceInfo: HdcDeviceInfo | null;

  constructor({
    usb,
    keyStore = new HdcKeyStore(),
    hostName = defaultHostName(),
    version = HDC.VERSION,
    logger = defaultLogger,
    authTimeout = DEFAULT_AUTH_TIMEOUT,
  }: HdcClientOptions = {}) {
    this.#usb = usb;
    this.#keyStore = keyStore;
    this.#hostName = hostName;
    this.#version = version;
    this.#logger = logger;
    this.#authTimeout = authTimeout;
    this.#events = new Emitter<HdcClientEventMap>();
    this.#transport = null;
    this.#sessionId = 0;
    this.#nextChannelId = randomUint32();
    this.#channels = new Map<number, InternalChannel>();
    this.#handshake = null;
    this.#connected = false;
    this.#connecting = false;
    this.#deviceInfo = null;
  }

  static isSupported(usb?: HdcUsbApi): boolean {
    return HdcWebUsbTransport.isSupported(usb);
  }

  get connected(): boolean {
    return this.#connected;
  }

  get connecting(): boolean {
    return this.#connecting;
  }

  get device(): HdcUsbDevice | null {
    return this.#transport?.device ?? null;
  }

  get deviceInfo(): HdcDeviceInfo | null {
    return this.#deviceInfo;
  }

  on<K extends keyof HdcClientEventMap>(
    type: K,
    listener: (event: HdcClientEventMap[K]) => void,
  ): () => void {
    return this.#events.on(type, listener);
  }

  off<K extends keyof HdcClientEventMap>(
    type: K,
    listener: (event: HdcClientEventMap[K]) => void,
  ): void {
    this.#events.off(type, listener);
  }

  async requestDevice(options: HdcRequestDeviceOptions = {}): Promise<HdcUsbDevice> {
    const transport = this.#makeTransport(randomUint32());
    return transport.requestDevice(options);
  }

  async getDevices(): Promise<HdcUsbDevice[]> {
    const transport = this.#makeTransport(randomUint32());
    return transport.getDevices();
  }

  async connect(device?: HdcUsbDevice): Promise<HdcDeviceInfo> {
    if (this.#connected) {
      if (!this.#deviceInfo) {
        throw new HdcProtocolError('HDC 已连接但缺少设备信息');
      }
      return this.#deviceInfo;
    }
    if (this.#connecting) {
      if (!this.#handshake) {
        throw new HdcProtocolError('HDC 连接状态无效');
      }
      return this.#handshake.promise;
    }
    if (!device) {
      const devices = await this.getDevices();
      if (devices.length !== 1) {
        throw new HdcError(
          devices.length === 0
            ? '没有已授权的 HDC USB 设备，请先调用 requestDevice()'
            : '存在多个已授权设备，请明确传入 USBDevice',
          { code: 'USB_DEVICE_REQUIRED' },
        );
      }
      [device] = devices;
    }

    this.#connecting = true;
    this.#sessionId = randomUint32();
    this.#transport = this.#makeTransport(this.#sessionId);
    this.#handshake = deferred<HdcDeviceInfo>();
    let authTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      this.#emitStatus('opening', '正在打开 HDC USB 接口');
      await this.#transport.open(device);
      const interfaceInfo = this.#transport.interfaceInfo;
      if (!interfaceInfo) {
        throw new HdcProtocolError('HDC USB 接口尚未就绪');
      }
      this.#deviceInfo = makeDeviceInfo(device, interfaceInfo);
      this.#emitStatus('handshake', '正在与设备建立 HDC 会话');

      const capabilities = encodeStringTlv({
        [AUTH_TLV.AUTH_TYPE]: '1',
      });
      await this.#sendCommand(
        0,
        COMMAND.KERNEL_HANDSHAKE,
        encodeHandshake({
          authType: AUTH_TYPE.NONE,
          sessionId: this.#sessionId,
          connectKey: device.serialNumber ?? '',
          buffer: capabilities,
          version: this.#version,
        }),
        { allowBeforeConnect: true },
      );

      authTimer = setTimeout(() => {
        this.#handshake?.reject(
          new HdcTimeoutError('等待设备 HDC 授权超时，请检查设备上的授权弹窗'),
        );
      }, this.#authTimeout);
      const info = await this.#handshake.promise;
      this.#connected = true;
      this.#emitStatus('connected', 'HDC 已连接');
      this.#events.emit('connect', info);
      return info;
    } catch (error) {
      await this.#transport?.close().catch(() => {});
      this.#transport = null;
      this.#deviceInfo = null;
      this.#failAll(error);
      throw error;
    } finally {
      if (authTimer !== undefined) {
        clearTimeout(authTimer);
      }
      this.#connecting = false;
      this.#handshake = null;
    }
  }

  async disconnect({ reset = false }: { reset?: boolean } = {}): Promise<void> {
    const wasConnected = this.#connected || this.#connecting;
    this.#connected = false;
    this.#connecting = false;
    this.#failAll(new HdcDisconnectedError('HDC 会话已主动断开'));
    const transport = this.#transport;
    this.#transport = null;
    await transport?.close({ reset });
    this.#deviceInfo = null;
    if (wasConnected) {
      this.#emitStatus('disconnected', 'HDC 已断开');
      this.#events.emit('disconnect', undefined);
    }
  }

  async sendCommand(
    channelId: number,
    command: number,
    data: ByteInput = new Uint8Array(),
  ): Promise<number> {
    this.#assertConnected();
    return this.#sendCommand(channelId, command, data);
  }

  async exec(
    command: string,
    { timeout = DEFAULT_OPERATION_TIMEOUT, signal, onOutput, onMessage }: HdcExecOptions = {},
  ): Promise<HdcExecResult> {
    this.#assertConnected();
    const channel = this.#createChannel('exec', timeout, signal);
    channel.chunks = [];
    channel.messages = [];
    channel.onOutput = onOutput;
    channel.onMessage = onMessage;
    try {
      await this.#sendCommand(channel.id, COMMAND.UNITY_EXECUTE, encodeUtf8(command));
      return (await channel.deferred.promise) as HdcExecResult;
    } catch (error) {
      this.#dropChannel(channel, error);
      throw error;
    }
  }

  async openShell({
    timeout = 0,
    signal,
    onData,
    onMessage,
  }: HdcShellOptions = {}): Promise<HdcShell> {
    this.#assertConnected();
    const channel = this.#createChannel('shell', timeout, signal);
    channel.onOutput = onData;
    channel.onMessage = onMessage;
    channel.chunks = [];
    channel.messages = [];
    await this.#sendCommand(channel.id, COMMAND.SHELL_INIT);
    return new HdcShell({
      channelId: channel.id,
      closed: channel.deferred.promise as Promise<HdcShellCloseResult>,
      write: (data: Uint8Array) => this.#sendCommand(channel.id, COMMAND.SHELL_DATA, data),
      close: async () => (await this.#requestChannelClose(channel)) as HdcShellCloseResult,
    });
  }

  async sendFile(
    input: Blob | HdcBinaryInput,
    remotePath: string,
    {
      name,
      lastModified,
      timeout = 120_000,
      signal,
      updateIfNew = false,
      onProgress,
    }: HdcFileSendOptions = {},
  ): Promise<HdcFileSendResult> {
    this.#assertConnected();
    const source = normalizeFileSource(input, { name, lastModified });
    const channel = this.#createChannel('file-send', timeout, signal);
    channel.source = source;
    channel.remotePath = remotePath;
    channel.onProgress = onProgress;
    channel.messages = [];
    channel.transferred = 0;
    channel.started = false;
    channel.finished = false;
    try {
      await this.#sendCommand(channel.id, COMMAND.KERNEL_WAKEUP_SLAVE_TASK);
      await this.#sendCommand(
        channel.id,
        COMMAND.FILE_CHECK,
        encodeTransferConfig({
          fileSize: source.size,
          mtime: 0,
          path: remotePath,
          optionalName: source.name,
          updateIfNew,
          compressType: 0,
          holdTimestamp: false,
        }),
      );
      return (await channel.deferred.promise) as HdcFileSendResult;
    } catch (error) {
      this.#dropChannel(channel, error);
      throw error;
    }
  }

  async receiveFile(
    remotePath: string,
    { timeout = 120_000, signal, writable, onProgress }: HdcFileReceiveOptions = {},
  ): Promise<HdcFileReceiveResult> {
    this.#assertConnected();
    const channel = this.#createChannel('file-receive', timeout, signal);
    channel.remotePath = remotePath;
    channel.writable = writable ?? null;
    channel.writer = writable?.getWriter() ?? null;
    channel.onProgress = onProgress;
    channel.messages = [];
    channel.chunks = [];
    channel.expectedOffset = 0;
    channel.config = null;
    channel.finishRequested = false;
    channel.finished = false;
    try {
      const placeholder = remotePath.split(/[\\/]/u).filter(Boolean).at(-1) || 'download.bin';
      const parameters = `${quoteHdcArgument(remotePath)} ${quoteHdcArgument(placeholder)}`;
      await this.#sendCommand(channel.id, COMMAND.FILE_INIT, encodeUtf8(parameters));
      return (await channel.deferred.promise) as HdcFileReceiveResult;
    } catch (error) {
      this.#dropChannel(channel, error);
      throw error;
    }
  }

  #makeTransport(sessionId: number): HdcWebUsbTransport {
    return new HdcWebUsbTransport({
      usb: this.#usb,
      sessionId,
      onBlock: (block) => this.#handleBlock(block),
      onError: (error) => this.#handleTransportError(error),
    });
  }

  #assertConnected(): void {
    if (!this.#connected || !this.#transport) {
      throw new HdcDisconnectedError('请先连接 HDC 设备');
    }
  }

  async #sendCommand(
    channelId: number,
    command: number,
    data: ByteInput = new Uint8Array(),
    { allowBeforeConnect = false }: { allowBeforeConnect?: boolean } = {},
  ): Promise<number> {
    if ((!this.#connected && !allowBeforeConnect) || !this.#transport) {
      throw new HdcDisconnectedError();
    }
    const packet = encodeHdcPacket(channelId, command, data);
    this.#log('debug', '发送 HDC 数据', {
      channelId,
      command,
      bytes: packet.byteLength,
    });
    return this.#transport.sendBlock(packet);
  }

  async #handleBlock(block: Uint8Array): Promise<void> {
    const packet = decodeHdcPacket(block);
    this.#log('debug', '收到 HDC 数据', {
      channelId: packet.channelId,
      command: packet.command,
      bytes: packet.data.byteLength,
    });
    if (packet.command === COMMAND.KERNEL_HANDSHAKE) {
      await this.#handleHandshake(packet.data);
      return;
    }
    if (packet.command === COMMAND.HEARTBEAT) {
      return;
    }
    if (packet.channelId === 0) {
      await this.#handleControlPacket(packet);
      return;
    }
    const channel = this.#channels.get(packet.channelId);
    if (!channel) {
      if (packet.command === COMMAND.KERNEL_CHANNEL_CLOSE) {
        await this.#acknowledgeClose(packet.channelId, packet.data);
      } else {
        await this.#sendCommand(packet.channelId, COMMAND.KERNEL_CHANNEL_CLOSE, Uint8Array.of(0), {
          allowBeforeConnect: true,
        });
      }
      return;
    }
    await this.#handleChannelPacket(channel, packet);
  }

  async #handleHandshake(data: Uint8Array): Promise<void> {
    const handshake = decodeHandshake(data);
    if (handshake.banner !== HDC.HANDSHAKE_BANNER) {
      throw new HdcProtocolError(`设备返回了无效握手 banner: ${handshake.banner}`);
    }
    if (handshake.authType === AUTH_TYPE.PUBLIC_KEY) {
      this.#emitStatus('authorizing', '正在准备浏览器 HDC 公钥');
      const publicKey = await this.#keyStore.getPublicKeyPem();
      const publicKeyInfo = encodeUtf8(`${this.#hostName}\f${publicKey}`);
      await this.#sendHandshakeResponse(handshake, AUTH_TYPE.PUBLIC_KEY, publicKeyInfo);
      this.#emitStatus('authorization-required', '请在鸿蒙设备上确认 USB 调试授权');
      this.#events.emit('authorizationrequired', {
        hostName: this.#hostName,
      });
      return;
    }
    if (handshake.authType === AUTH_TYPE.SIGNATURE) {
      this.#emitStatus('authorizing', '正在签名设备 HDC 挑战');
      const signature = await this.#keyStore.signToken(handshake.buffer);
      await this.#sendHandshakeResponse(handshake, AUTH_TYPE.SIGNATURE, encodeUtf8(signature));
      return;
    }
    if (handshake.authType === AUTH_TYPE.OK) {
      let details: Record<string, string> = {};
      if (handshake.buffer.byteLength > 0) {
        try {
          details = decodeStringTlv(handshake.buffer);
        } catch {
          details = { raw: decodeUtf8(handshake.buffer) };
        }
      }
      const daemon = {
        version: handshake.version,
        name: details[AUTH_TLV.DEVICE_NAME] ?? '',
        message: details[AUTH_TLV.EMERGENCY_MESSAGE] ?? details.raw ?? '',
        authStatus: details[AUTH_TLV.DAEMON_AUTH_STATUS] ?? '',
        shellOption: details[AUTH_TLV.SHELL_OPTION] ?? '',
        supportFeatures: (details[AUTH_TLV.SUPPORT_FEATURES] ?? '').split(',').filter(Boolean),
      };
      if (this.#deviceInfo) {
        this.#deviceInfo.daemon = daemon;
      }
      if (daemon.authStatus === 'DAEMON_UNAUTH') {
        this.#emitStatus('authorization-required', daemon.message || '请在设备上确认 HDC 调试授权');
        this.#events.emit('authorizationrequired', {
          hostName: this.#hostName,
          message: daemon.message,
        });
        return;
      }
      if (!this.#deviceInfo) {
        throw new HdcProtocolError('HDC 握手缺少设备信息');
      }
      this.#handshake?.resolve(this.#deviceInfo);
      return;
    }
    if (handshake.authType === AUTH_TYPE.FAIL) {
      const message = decodeUtf8(handshake.buffer) || '设备拒绝了 HDC 鉴权';
      this.#handshake?.reject(new HdcError(message, { code: 'HDC_AUTH_FAILED' }));
      return;
    }
    throw new HdcProtocolError(`不支持的 HDC 鉴权类型: ${handshake.authType}`);
  }

  async #sendHandshakeResponse(
    handshake: HdcHandshake,
    authType: number,
    buffer: Uint8Array,
  ): Promise<void> {
    await this.#sendCommand(
      0,
      COMMAND.KERNEL_HANDSHAKE,
      encodeHandshake({
        banner: handshake.banner,
        authType,
        sessionId: handshake.sessionId,
        connectKey: handshake.connectKey,
        buffer,
        version: handshake.version || this.#version,
      }),
      { allowBeforeConnect: true },
    );
  }

  async #handleControlPacket(packet: HdcPacket): Promise<void> {
    if (packet.command === COMMAND.KERNEL_CHANNEL_CLOSE) {
      await this.#acknowledgeClose(0, packet.data);
      return;
    }
    if (packet.command === COMMAND.KERNEL_ECHO) {
      const message = this.#decodeMessage(packet.data);
      this.#events.emit('message', message);
      this.#log(message.level === MESSAGE_LEVEL.FAIL ? 'error' : 'info', message.text);
    }
  }

  async #handleChannelPacket(channel: InternalChannel, packet: HdcPacket): Promise<void> {
    if (packet.command === COMMAND.KERNEL_ECHO_RAW) {
      channel.chunks.push(packet.data);
      channel.onOutput?.(packet.data);
      return;
    }
    if (packet.command === COMMAND.KERNEL_ECHO) {
      const message = this.#decodeMessage(packet.data);
      channel.messages.push(message);
      channel.onMessage?.(message);
      this.#events.emit('message', { ...message, channelId: channel.id });
      return;
    }
    if (packet.command === COMMAND.KERNEL_CHANNEL_CLOSE) {
      await this.#acknowledgeClose(channel.id, packet.data);
      await this.#finishChannel(channel);
      return;
    }
    if (channel.type === 'file-send') {
      await this.#handleFileSend(channel, packet);
      return;
    }
    if (channel.type === 'file-receive') {
      await this.#handleFileReceive(channel, packet);
      return;
    }
    this.#events.emit('packet', packet);
  }

  #decodeMessage(data: Uint8Array): HdcMessage {
    if (data.byteLength === 0) {
      return { level: MESSAGE_LEVEL.INFO, text: '' };
    }
    return {
      level: data[0],
      text: decodeUtf8(data.subarray(1)),
    };
  }

  async #handleFileSend(channel: InternalChannel, packet: HdcPacket): Promise<void> {
    if (packet.command === COMMAND.FILE_BEGIN) {
      if (channel.started) {
        return;
      }
      channel.started = true;
      const hugeBuffer = Boolean(packet.data[0] & 0x01);
      channel.pump = this.#pumpFileSend(channel, hugeBuffer).catch((error) => {
        this.#dropChannel(channel, error);
        this.#requestChannelClose(channel).catch(() => {});
      });
      return;
    }
    if (packet.command === COMMAND.FILE_FINISH) {
      channel.finished = true;
      const count = packet.data[0] ?? 0;
      if (count > 0) {
        await this.#sendCommand(channel.id, COMMAND.FILE_FINISH, Uint8Array.of(count - 1));
      }
    }
  }

  async #pumpFileSend(channel: InternalChannel, hugeBuffer: boolean): Promise<void> {
    const maxPayload = hugeBuffer ? HDC.MAX_HDC_PAYLOAD_SIZE : HDC.STABLE_HDC_PAYLOAD_SIZE;
    const chunkSize = Math.floor(maxPayload * 0.8) - HDC.TRANSFER_PREFIX_SIZE;
    const { source } = channel;
    if (!source) {
      throw new HdcProtocolError('文件发送 channel 缺少数据源');
    }
    if (source.size === 0) {
      await this.#sendCommand(
        channel.id,
        COMMAND.FILE_DATA,
        encodeTransferPayload(0, new Uint8Array()),
      );
      channel.onProgress?.({ transferred: 0, total: 0, ratio: 1 });
      return;
    }
    for (let offset = 0; offset < source.size; offset += chunkSize) {
      if (!this.#channels.has(channel.id)) {
        return;
      }
      const data = await source.read(offset, Math.min(offset + chunkSize, source.size));
      await this.#sendCommand(channel.id, COMMAND.FILE_DATA, encodeTransferPayload(offset, data));
      channel.transferred = offset + data.byteLength;
      channel.onProgress?.({
        transferred: channel.transferred,
        total: source.size,
        ratio: source.size === 0 ? 1 : channel.transferred / source.size,
      });
    }
  }

  async #handleFileReceive(channel: InternalChannel, packet: HdcPacket): Promise<void> {
    if (packet.command === COMMAND.KERNEL_WAKEUP_SLAVE_TASK) {
      return;
    }
    if (packet.command === COMMAND.FILE_CHECK) {
      channel.config = decodeTransferConfig(packet.data);
      channel.config.fileSize = asSafeNumber(channel.config.fileSize, '文件大小');
      const features = new Uint8Array(8);
      features[0] = 0x01;
      await this.#sendCommand(channel.id, COMMAND.FILE_BEGIN, features);
      return;
    }
    if (packet.command === COMMAND.FILE_DATA) {
      const transfer = decodeTransferPayload(packet.data);
      const index = asSafeNumber(transfer.index, '文件偏移');
      if (index !== channel.expectedOffset) {
        throw new HdcProtocolError(`文件块顺序错误：期望 ${channel.expectedOffset}，收到 ${index}`);
      }
      if (channel.writer) {
        await channel.writer.write(transfer.data);
      } else {
        channel.chunks.push(transfer.data);
      }
      channel.expectedOffset += transfer.data.byteLength;
      const total = channel.config ? asSafeNumber(channel.config.fileSize, '文件大小') : 0;
      if (channel.config && channel.expectedOffset > total) {
        throw new HdcProtocolError(`接收文件超过声明大小：${channel.expectedOffset}/${total}`);
      }
      channel.onProgress?.({
        transferred: channel.expectedOffset,
        total,
        ratio: total === 0 ? 1 : channel.expectedOffset / total,
      });
      if (channel.config && channel.expectedOffset === total && !channel.finishRequested) {
        channel.finishRequested = true;
        if (channel.writer) {
          await channel.writer.close();
          channel.writer = null;
        }
        await this.#sendCommand(channel.id, COMMAND.FILE_FINISH, Uint8Array.of(1));
      }
      return;
    }
    if (packet.command === COMMAND.FILE_FINISH) {
      channel.finished = true;
      if (channel.writer) {
        await channel.writer.close();
        channel.writer = null;
      }
      const count = packet.data[0] ?? 0;
      if (count > 0) {
        await this.#sendCommand(channel.id, COMMAND.FILE_FINISH, Uint8Array.of(count - 1));
      } else if (channel.finishRequested && !channel.closing) {
        // The receiver is the file-transfer slave. Native HDC calls
        // TaskFinish after FILE_FINISH reaches zero, which starts channel
        // close. Do not await channel.deferred here: the read loop must remain
        // free to receive the peer's close acknowledgement.
        channel.closing = true;
        await this.#sendCommand(channel.id, COMMAND.KERNEL_CHANNEL_CLOSE, Uint8Array.of(1));
      }
    }
  }

  #createChannel(type: ChannelType, timeout: number, signal?: AbortSignal): InternalChannel {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('操作已取消', 'AbortError');
    }
    let id = this.#nextChannelId;
    do {
      id = (id + 1) >>> 0;
      if (id === 0) {
        id = 1;
      }
    } while (this.#channels.has(id));
    this.#nextChannelId = id;
    const channel: InternalChannel = {
      id,
      type,
      deferred: deferred<ChannelResult>(),
      timer: null,
      abortSignal: signal ?? null,
      abortListener: null,
      closed: false,
      closing: false,
      chunks: [],
      messages: [],
      source: null,
      remotePath: '',
      transferred: 0,
      started: false,
      finished: false,
      pump: null,
      writable: null,
      writer: null,
      expectedOffset: 0,
      config: null,
      finishRequested: false,
    };
    this.#channels.set(id, channel);
    if (Number.isFinite(timeout) && timeout > 0) {
      channel.timer = setTimeout(() => {
        const error = new HdcTimeoutError(`HDC channel ${id} 操作超时`);
        this.#dropChannel(channel, error);
        this.#requestChannelClose(channel).catch(() => {});
      }, timeout);
    }
    if (signal) {
      channel.abortListener = () => {
        const error =
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException('操作已取消', 'AbortError');
        this.#dropChannel(channel, error);
        this.#requestChannelClose(channel).catch(() => {});
      };
      signal.addEventListener('abort', channel.abortListener, { once: true });
      if (signal.aborted) {
        channel.abortListener();
      }
    }
    return channel;
  }

  async #requestChannelClose(channel: InternalChannel): Promise<ChannelResult> {
    if (channel.closing || !this.#transport) {
      return channel.deferred.promise;
    }
    channel.closing = true;
    await this.#sendCommand(channel.id, COMMAND.KERNEL_CHANNEL_CLOSE, Uint8Array.of(1), {
      allowBeforeConnect: true,
    });
    return channel.deferred.promise;
  }

  async #acknowledgeClose(channelId: number, data: Uint8Array): Promise<void> {
    const count = data[0] ?? 0;
    if (count > 0 && this.#transport) {
      await this.#sendCommand(channelId, COMMAND.KERNEL_CHANNEL_CLOSE, Uint8Array.of(count - 1), {
        allowBeforeConnect: true,
      });
    }
  }

  async #finishChannel(channel: InternalChannel): Promise<void> {
    if (channel.closed) {
      return;
    }
    channel.closed = true;
    this.#cleanupChannel(channel);
    if (channel.type === 'exec') {
      const bytes = concatBytes(channel.chunks);
      channel.deferred.resolve({
        channelId: channel.id,
        stdout: decodeUtf8(bytes),
        data: bytes,
        messages: channel.messages,
      });
      return;
    }
    if (channel.type === 'shell') {
      channel.deferred.resolve({ channelId: channel.id });
      return;
    }
    if (channel.type === 'file-send') {
      const failure = channel.messages.find((message) => message.level === MESSAGE_LEVEL.FAIL);
      if (failure && !channel.finished) {
        channel.deferred.reject(new HdcError(failure.text, { code: 'HDC_FILE_SEND_FAILED' }));
      } else {
        if (!channel.source) {
          throw new HdcProtocolError('文件发送 channel 缺少数据源');
        }
        channel.deferred.resolve({
          channelId: channel.id,
          name: channel.source.name,
          remotePath: channel.remotePath,
          size: channel.source.size,
          transferred: channel.transferred,
          messages: channel.messages,
        });
      }
      return;
    }
    if (channel.type === 'file-receive') {
      const failure = channel.messages.find((message) => message.level === MESSAGE_LEVEL.FAIL);
      if (failure && !channel.finished) {
        channel.deferred.reject(new HdcError(failure.text, { code: 'HDC_FILE_RECEIVE_FAILED' }));
        return;
      }
      const data = channel.writer || channel.writable ? null : concatBytes(channel.chunks);
      const blob = data && typeof Blob !== 'undefined' ? new Blob([Uint8Array.from(data)]) : null;
      channel.deferred.resolve({
        channelId: channel.id,
        name: channel.config?.optionalName || 'download.bin',
        remotePath: channel.remotePath,
        size: channel.expectedOffset,
        data,
        blob,
        messages: channel.messages,
      });
    }
  }

  #dropChannel(channel: InternalChannel, error: unknown): void {
    if (channel.closed) {
      return;
    }
    channel.closed = true;
    this.#cleanupChannel(channel);
    channel.writer?.abort(error).catch(() => {});
    channel.deferred.reject(error);
  }

  #cleanupChannel(channel: InternalChannel): void {
    if (channel.timer !== null) {
      clearTimeout(channel.timer);
    }
    if (channel.abortListener) {
      channel.abortSignal?.removeEventListener('abort', channel.abortListener);
      channel.abortListener = null;
      channel.abortSignal = null;
    }
    this.#channels.delete(channel.id);
  }

  #failAll(error: unknown): void {
    this.#handshake?.reject(error);
    for (const channel of [...this.#channels.values()]) {
      this.#dropChannel(channel, error);
    }
  }

  #handleTransportError(error: unknown): void {
    const normalized = error instanceof Error ? error : new HdcDisconnectedError(String(error));
    this.#connected = false;
    this.#connecting = false;
    this.#failAll(normalized);
    this.#emitStatus('error', normalized.message);
    this.#events.emit('error', normalized);
  }

  #emitStatus(state: HdcStatusState, message: string): void {
    this.#events.emit('status', { state, message });
    this.#log('info', message, { state });
  }

  #log(level: HdcLogLevel, message: string, detail?: unknown): void {
    this.#logger(level, message, detail);
    this.#events.emit('log', { level, message, detail });
  }
}
