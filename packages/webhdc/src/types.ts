export type HdcInteger = number | bigint;

export type HdcBinaryInput =
  string | ArrayBuffer | ArrayBufferView | readonly number[] | Uint8Array;

export interface HdcUsbDeviceFilter {
  vendorId?: number;
  productId?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
  serialNumber?: string;
}

export interface HdcUsbEndpoint {
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
  endpointNumber: number;
  packetSize: number;
}

export interface HdcUsbAlternateInterface {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  endpoints: readonly HdcUsbEndpoint[];
}

export interface HdcUsbInterface {
  interfaceNumber: number;
  alternates: readonly HdcUsbAlternateInterface[];
}

export interface HdcUsbConfiguration {
  configurationValue: number;
  interfaces: readonly HdcUsbInterface[];
}

export interface HdcUsbInTransferResult {
  status: string;
  data?: DataView;
}

export interface HdcUsbOutTransferResult {
  status: string;
  bytesWritten?: number;
}

export interface HdcUsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber?: string;
  readonly manufacturerName?: string;
  readonly productName?: string;
  readonly configurations: readonly HdcUsbConfiguration[];
  opened: boolean;
  configuration: HdcUsbConfiguration | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<HdcUsbInTransferResult>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<HdcUsbOutTransferResult>;
  clearHalt(direction: 'in' | 'out', endpointNumber: number): Promise<void>;
}

export interface HdcUsbApi {
  requestDevice(options: { filters: readonly HdcUsbDeviceFilter[] }): Promise<HdcUsbDevice>;
  getDevices(): Promise<HdcUsbDevice[]>;
}

export interface HdcInterfaceInfo {
  interfaceNumber: number;
  alternateSetting: number;
  inputEndpoint: number;
  outputEndpoint: number;
  packetSize: number;
}

export interface HdcDaemonInfo {
  version: string;
  name: string;
  message: string;
  authStatus: string;
  shellOption: string;
  supportFeatures: string[];
}

export interface HdcDeviceInfo {
  serialNumber: string;
  manufacturerName: string;
  productName: string;
  vendorId: number;
  productId: number;
  vendorIdHex: string;
  productIdHex: string;
  interface: HdcInterfaceInfo;
  daemon: HdcDaemonInfo | null;
}

export interface HdcMessage {
  level: number;
  text: string;
  channelId?: number;
}

export interface HdcPacket {
  protocolVersion: number;
  channelId: number;
  command: number;
  checksum: number;
  vCode: number;
  data: Uint8Array;
}

export interface HdcProgress {
  transferred: number;
  total: number;
  ratio: number;
}

export interface HdcExecResult {
  channelId: number;
  stdout: string;
  data: Uint8Array;
  messages: HdcMessage[];
}

export interface HdcShellCloseResult {
  channelId: number;
}

export interface HdcFileSendResult {
  channelId: number;
  name: string;
  remotePath: string;
  size: number;
  transferred: number;
  messages: HdcMessage[];
}

export interface HdcFileReceiveResult {
  channelId: number;
  name: string;
  remotePath: string;
  size: number;
  data: Uint8Array | null;
  blob: Blob | null;
  messages: HdcMessage[];
}

export interface HdcWritable {
  getWriter(): WritableStreamDefaultWriter<Uint8Array>;
}

export type HdcLogLevel = 'debug' | 'info' | 'error';

export type HdcStatusState =
  | 'opening'
  | 'handshake'
  | 'authorizing'
  | 'authorization-required'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface HdcStatus {
  state: HdcStatusState;
  message: string;
}

export interface HdcLogEntry {
  level: HdcLogLevel;
  message: string;
  detail?: unknown;
}

export interface HdcAuthorizationRequest {
  hostName: string;
  message?: string;
}

export interface HdcClientEventMap {
  connect: HdcDeviceInfo;
  disconnect: undefined;
  error: Error;
  status: HdcStatus;
  log: HdcLogEntry;
  message: HdcMessage;
  packet: HdcPacket;
  authorizationrequired: HdcAuthorizationRequest;
}

export interface HdcUsbHeader {
  option: number;
  sessionId: number;
  dataSize: number;
}

export interface HdcPayloadProtect {
  channelId: number;
  command: number;
  checksum: number;
  vCode: number;
}

export interface HdcHandshake {
  banner: string;
  authType: number;
  sessionId: number;
  connectKey: string;
  buffer: Uint8Array;
  version: string;
}

export interface HdcTransferConfig {
  fileSize: HdcInteger;
  atime: HdcInteger;
  mtime: HdcInteger;
  options: string;
  path: string;
  optionalName: string;
  updateIfNew: boolean;
  compressType: number;
  holdTimestamp: boolean;
  functionName: string;
  clientCwd: string;
  reserve1: string;
  reserve2: string;
}

export interface HdcTransferPayload {
  index: HdcInteger;
  compressType: number;
  compressSize: number;
  uncompressSize: number;
  data: Uint8Array;
}
