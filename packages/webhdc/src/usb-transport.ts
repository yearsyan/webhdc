import { concatBytes, toUint8Array, type ByteInput } from './bytes.js';
import { HDC, HDC_USB_FILTERS, HDC_USB_INTERFACE, USB_OPTION } from './constants.js';
import { HdcDisconnectedError, HdcProtocolError, HdcUnsupportedError } from './errors.js';
import { decodeUsbHeader, encodeUsbHeader, isUsbHeader } from './protocol.js';
import type {
  HdcInterfaceInfo,
  HdcUsbApi,
  HdcUsbDevice,
  HdcUsbDeviceFilter,
  HdcUsbEndpoint,
} from './types.js';

interface HdcInterfaceBinding {
  interfaceNumber: number;
  alternateSetting: number;
  input: HdcUsbEndpoint;
  output: HdcUsbEndpoint;
}

export interface HdcTransportOptions {
  usb?: HdcUsbApi;
  sessionId: number;
  onBlock?: (block: Uint8Array) => void | Promise<void>;
  onError?: (error: Error) => void;
}

export interface HdcRequestDeviceOptions {
  filters?: readonly HdcUsbDeviceFilter[];
}

function getNavigatorUsb(): HdcUsbApi | undefined {
  return (globalThis.navigator as (Navigator & { usb?: HdcUsbApi }) | undefined)?.usb;
}

function getUsbApi(usb?: HdcUsbApi): HdcUsbApi {
  const api = usb ?? getNavigatorUsb();
  if (!api) {
    throw new HdcUnsupportedError();
  }
  return api;
}

function findHdcInterface(device: HdcUsbDevice): HdcInterfaceBinding | null {
  const configuration = device.configuration;
  if (!configuration) {
    return null;
  }
  for (const usbInterface of configuration.interfaces) {
    for (const alternate of usbInterface.alternates) {
      if (
        alternate.interfaceClass !== HDC_USB_INTERFACE.classCode ||
        alternate.interfaceSubclass !== HDC_USB_INTERFACE.subclassCode ||
        alternate.interfaceProtocol !== HDC_USB_INTERFACE.protocolCode
      ) {
        continue;
      }
      const input: HdcUsbEndpoint | undefined = alternate.endpoints.find(
        (endpoint) => endpoint.direction === 'in' && endpoint.type === 'bulk',
      );
      const output: HdcUsbEndpoint | undefined = alternate.endpoints.find(
        (endpoint) => endpoint.direction === 'out' && endpoint.type === 'bulk',
      );
      if (input && output) {
        return {
          interfaceNumber: usbInterface.interfaceNumber,
          alternateSetting: alternate.alternateSetting,
          input,
          output,
        };
      }
    }
  }
  return null;
}

export class HdcWebUsbTransport {
  #usb: HdcUsbApi;
  #device: HdcUsbDevice | null;
  #interface: HdcInterfaceBinding | null;
  #sessionId: number;
  #running: boolean;
  #writeQueue: Promise<unknown>;
  #onBlock?: (block: Uint8Array) => void | Promise<void>;
  #onError?: (error: Error) => void;

  constructor({ usb, sessionId, onBlock, onError }: HdcTransportOptions) {
    this.#usb = getUsbApi(usb);
    this.#device = null;
    this.#interface = null;
    this.#sessionId = sessionId;
    this.#running = false;
    this.#writeQueue = Promise.resolve();
    this.#onBlock = onBlock;
    this.#onError = onError;
  }

  static isSupported(usb?: HdcUsbApi): boolean {
    return Boolean(usb ?? getNavigatorUsb());
  }

  get device(): HdcUsbDevice | null {
    return this.#device;
  }

  get interfaceInfo(): HdcInterfaceInfo | null {
    if (!this.#interface) {
      return null;
    }
    return {
      interfaceNumber: this.#interface.interfaceNumber,
      alternateSetting: this.#interface.alternateSetting,
      inputEndpoint: this.#interface.input.endpointNumber,
      outputEndpoint: this.#interface.output.endpointNumber,
      packetSize: this.#interface.output.packetSize,
    };
  }

  async requestDevice(options: HdcRequestDeviceOptions = {}): Promise<HdcUsbDevice> {
    const filters = options.filters ?? HDC_USB_FILTERS;
    return this.#usb.requestDevice({ filters });
  }

  async getDevices(): Promise<HdcUsbDevice[]> {
    const devices = await this.#usb.getDevices();
    return devices.filter((device) => {
      if (!device.configuration) {
        return true;
      }
      return Boolean(findHdcInterface(device));
    });
  }

  async open(device: HdcUsbDevice): Promise<void> {
    if (!device) {
      throw new TypeError('缺少 USBDevice');
    }
    this.#device = device;
    if (!device.opened) {
      await device.open();
    }
    if (!device.configuration) {
      const configurationValue = device.configurations[0]?.configurationValue ?? 1;
      await device.selectConfiguration(configurationValue);
    }
    this.#interface = findHdcInterface(device);
    if (!this.#interface) {
      throw new HdcProtocolError(
        '设备没有 HDC WebUSB 接口（需要 class 0xff / subclass 0x50 / protocol 0x01）',
      );
    }
    await device.claimInterface(this.#interface.interfaceNumber);
    if (this.#interface.alternateSetting !== undefined && this.#interface.alternateSetting !== 0) {
      await device.selectAlternateInterface(
        this.#interface.interfaceNumber,
        this.#interface.alternateSetting,
      );
    }
    // Native hdc clears the endpoint before starting a new session. A browser
    // can otherwise receive the tail of the previous host session first.
    await this.sendReset(0);
    this.#running = true;
    void this.#readLoop();
  }

  async sendBlock(block: ByteInput): Promise<number> {
    const data = toUint8Array(block);
    if (!this.#running || !this.#device || !this.#interface) {
      throw new HdcDisconnectedError();
    }
    const packetSize = this.#interface.output.packetSize;
    const task = this.#writeQueue.then(async () => {
      await this.#transferOut(encodeUsbHeader(this.#sessionId, data.byteLength, USB_OPTION.HEADER));
      await this.#transferOut(data);
      if (data.byteLength > 0 && data.byteLength % packetSize === 0) {
        await this.#transferOut(encodeUsbHeader(this.#sessionId, 0, 0));
      }
      return data.byteLength;
    });
    this.#writeQueue = task.catch(() => {});
    return task;
  }

  async sendReset(sessionId = this.#sessionId): Promise<void> {
    if (!this.#device?.opened || !this.#interface) {
      return;
    }
    await this.#transferOut(encodeUsbHeader(sessionId, 0, USB_OPTION.RESET));
  }

  async close({ reset = false }: { reset?: boolean } = {}): Promise<void> {
    if (!this.#device) {
      return;
    }
    this.#running = false;
    try {
      if (reset) {
        await this.sendReset();
      }
    } catch {
      // The device may already be gone.
    }
    try {
      if (this.#device.opened && this.#interface) {
        await this.#device.releaseInterface(this.#interface.interfaceNumber);
      }
    } catch {
      // Releasing a disconnected device is best effort.
    }
    try {
      if (this.#device.opened) {
        await this.#device.close();
      }
    } finally {
      this.#device = null;
      this.#interface = null;
    }
  }

  async #transferOut(bytes: Uint8Array): Promise<void> {
    if (!this.#device || !this.#interface) {
      throw new HdcDisconnectedError();
    }
    const device = this.#device;
    const endpointNumber = this.#interface.output.endpointNumber;
    const result = await device.transferOut(endpointNumber, Uint8Array.from(bytes));
    if (result.status === 'stall') {
      await device.clearHalt('out', endpointNumber);
      throw new HdcProtocolError('HDC USB OUT endpoint stall');
    }
    if (result.status !== 'ok' || result.bytesWritten !== bytes.byteLength) {
      throw new HdcProtocolError(
        `HDC USB 写入不完整：${result.bytesWritten ?? 0}/${bytes.byteLength}`,
      );
    }
  }

  async #readTransfer(length: number): Promise<Uint8Array> {
    if (!this.#device || !this.#interface) {
      throw new HdcDisconnectedError();
    }
    const result = await this.#device.transferIn(this.#interface.input.endpointNumber, length);
    if (result.status === 'stall') {
      await this.#device.clearHalt('in', this.#interface.input.endpointNumber);
      throw new HdcProtocolError('HDC USB IN endpoint stall');
    }
    if (result.status !== 'ok' || !result.data) {
      throw new HdcProtocolError(`HDC USB 读取失败：${result.status}`);
    }
    return new Uint8Array(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength,
    ).slice();
  }

  async #readLoop(): Promise<void> {
    let expectedPayload = 0;
    let chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (this.#running) {
        if (!this.#interface) {
          throw new HdcDisconnectedError();
        }
        const packetSize = this.#interface.input.packetSize;
        const requestSize =
          expectedPayload > 0
            ? Math.min(expectedPayload - received, HDC.MAX_USB_BLOCK_SIZE)
            : packetSize;
        const bytes = await this.#readTransfer(Math.max(requestSize, packetSize));
        if (bytes.byteLength === 0) {
          continue;
        }
        if (isUsbHeader(bytes)) {
          const header = decodeUsbHeader(bytes);
          if (header.option & USB_OPTION.RESET) {
            throw new HdcDisconnectedError('设备请求重置 HDC USB 会话');
          }
          if (header.sessionId !== this.#sessionId) {
            await this.sendReset(header.sessionId);
            continue;
          }
          if (header.option & USB_OPTION.HEADER) {
            expectedPayload = header.dataSize;
            chunks = [];
            received = 0;
          }
          continue;
        }
        if (expectedPayload <= 0) {
          // Ignore data left by an earlier native/browser session. This mirrors
          // the native host's ClearUsbChannel drain loop after a soft reset.
          continue;
        }
        chunks.push(bytes);
        received += bytes.byteLength;
        if (received > expectedPayload) {
          throw new HdcProtocolError(`USB payload 超长：${received}/${expectedPayload}`);
        }
        if (received === expectedPayload) {
          const block = concatBytes(chunks);
          expectedPayload = 0;
          chunks = [];
          received = 0;
          await this.#onBlock?.(block);
        }
      }
    } catch (error) {
      if (this.#running) {
        this.#running = false;
        this.#onError?.(error instanceof Error ? error : new HdcDisconnectedError(String(error)));
      }
    }
  }
}
