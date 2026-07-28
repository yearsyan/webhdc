import {
  concatBytes,
  decodeUtf8,
  encodeUtf8,
  readUint32BE,
  toUint8Array,
  writeUint16BE,
  writeUint32BE,
  type ByteInput,
} from './bytes.js';
import { HDC, USB_OPTION } from './constants.js';
import { HdcProtocolError } from './errors.js';
import { decodeMessage, encodeMessage, getBytes, getString, getVarint } from './protobuf.js';
import type {
  HdcHandshake,
  HdcInteger,
  HdcPacket,
  HdcPayloadProtect,
  HdcTransferConfig,
  HdcTransferPayload,
  HdcUsbHeader,
} from './types.js';

const ASCII_U = 0x55;
const ASCII_B = 0x42;
const ASCII_H = 0x48;
const ASCII_W = 0x57;

export function encodeUsbHeader(
  sessionId: number,
  dataSize: number,
  option: number = USB_OPTION.HEADER,
): Uint8Array {
  const output = new Uint8Array(HDC.USB_HEADER_SIZE);
  output[0] = ASCII_U;
  output[1] = ASCII_B;
  output[2] = option;
  writeUint32BE(output, 3, sessionId);
  writeUint32BE(output, 7, dataSize);
  return output;
}

export function decodeUsbHeader(input: ByteInput): HdcUsbHeader {
  const bytes = toUint8Array(input);
  if (bytes.byteLength !== HDC.USB_HEADER_SIZE || bytes[0] !== ASCII_U || bytes[1] !== ASCII_B) {
    throw new HdcProtocolError('无效的 HDC USB 数据头');
  }
  return {
    option: bytes[2],
    sessionId: readUint32BE(bytes, 3),
    dataSize: readUint32BE(bytes, 7),
  };
}

export function isUsbHeader(input: ByteInput): boolean {
  const bytes = toUint8Array(input);
  return bytes.byteLength === HDC.USB_HEADER_SIZE && bytes[0] === ASCII_U && bytes[1] === ASCII_B;
}

export function encodePayloadProtect({
  channelId,
  command,
  checksum = 0,
  vCode = HDC.PAYLOAD_VCODE,
}: Pick<HdcPayloadProtect, 'channelId' | 'command'> &
  Partial<Pick<HdcPayloadProtect, 'checksum' | 'vCode'>>): Uint8Array {
  return encodeMessage([
    { tag: 1, type: 'varint', value: channelId },
    { tag: 2, type: 'varint', value: command },
    { tag: 3, type: 'varint', value: checksum },
    { tag: 4, type: 'varint', value: vCode },
  ]);
}

export function decodePayloadProtect(input: ByteInput): HdcPayloadProtect {
  const fields = decodeMessage(input);
  return {
    channelId: Number(getVarint(fields, 1)),
    command: Number(getVarint(fields, 2)),
    checksum: Number(getVarint(fields, 3)),
    vCode: Number(getVarint(fields, 4)),
  };
}

export function encodeHdcPacket(
  channelId: number,
  command: number,
  data: ByteInput = new Uint8Array(),
): Uint8Array {
  const payload = toUint8Array(data);
  const protect = encodePayloadProtect({ channelId, command });
  const header = new Uint8Array(HDC.PAYLOAD_HEADER_SIZE);
  header[0] = ASCII_H;
  header[1] = ASCII_W;
  header[4] = HDC.PROTOCOL_VERSION;
  writeUint16BE(header, 5, protect.byteLength);
  writeUint32BE(header, 7, payload.byteLength);
  return concatBytes(header, protect, payload);
}

export function decodeHdcPacket(input: ByteInput): HdcPacket {
  const bytes = toUint8Array(input);
  if (bytes.byteLength < HDC.PAYLOAD_HEADER_SIZE || bytes[0] !== ASCII_H || bytes[1] !== ASCII_W) {
    throw new HdcProtocolError('无效的 HDC HW 数据头');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const protocolVersion = bytes[4];
  const protectSize = view.getUint16(5, false);
  const dataSize = view.getUint32(7, false);
  const expectedSize = HDC.PAYLOAD_HEADER_SIZE + protectSize + dataSize;
  if (expectedSize !== bytes.byteLength) {
    throw new HdcProtocolError(`HDC 包长度不匹配：期望 ${expectedSize}，实际 ${bytes.byteLength}`);
  }
  const protect = decodePayloadProtect(
    bytes.subarray(HDC.PAYLOAD_HEADER_SIZE, HDC.PAYLOAD_HEADER_SIZE + protectSize),
  );
  if (protect.vCode !== HDC.PAYLOAD_VCODE) {
    throw new HdcProtocolError(`HDC payload vCode 无效: ${protect.vCode}`);
  }
  return {
    protocolVersion,
    ...protect,
    data: bytes.slice(HDC.PAYLOAD_HEADER_SIZE + protectSize),
  };
}

export function encodeHandshake({
  banner = HDC.HANDSHAKE_BANNER,
  authType = 0,
  sessionId = 0,
  connectKey = '',
  buffer = new Uint8Array(),
  version = HDC.VERSION,
}: Partial<HdcHandshake> = {}): Uint8Array {
  return encodeMessage([
    { tag: 1, type: 'string', value: banner },
    { tag: 2, type: 'varint', value: authType },
    { tag: 3, type: 'varint', value: sessionId },
    { tag: 4, type: 'string', value: connectKey },
    { tag: 5, type: 'bytes', value: buffer },
    { tag: 6, type: 'string', value: version },
  ]);
}

export function decodeHandshake(input: ByteInput): HdcHandshake {
  const fields = decodeMessage(input);
  return {
    banner: getString(fields, 1),
    authType: Number(getVarint(fields, 2)),
    sessionId: Number(getVarint(fields, 3)),
    connectKey: getString(fields, 4),
    buffer: getBytes(fields, 5),
    version: getString(fields, 6),
  };
}

export function encodeTransferConfig({
  fileSize = 0,
  atime = 0,
  mtime = 0,
  options = '',
  path = '',
  optionalName = '',
  updateIfNew = false,
  compressType = 0,
  holdTimestamp = false,
  functionName = '',
  clientCwd = '',
  reserve1 = '',
  reserve2 = '',
}: Partial<HdcTransferConfig> = {}): Uint8Array {
  return encodeMessage([
    { tag: 1, type: 'varint', value: fileSize },
    { tag: 2, type: 'varint', value: atime },
    { tag: 3, type: 'varint', value: mtime },
    { tag: 4, type: 'string', value: options },
    { tag: 5, type: 'string', value: path },
    { tag: 6, type: 'string', value: optionalName },
    { tag: 7, type: 'varint', value: updateIfNew ? 1 : 0 },
    { tag: 8, type: 'varint', value: compressType },
    { tag: 9, type: 'varint', value: holdTimestamp ? 1 : 0 },
    { tag: 10, type: 'string', value: functionName },
    { tag: 11, type: 'string', value: clientCwd },
    { tag: 12, type: 'string', value: reserve1 },
    { tag: 13, type: 'string', value: reserve2 },
  ]);
}

export function decodeTransferConfig(input: ByteInput): HdcTransferConfig {
  const fields = decodeMessage(input);
  return {
    fileSize: getVarint(fields, 1),
    atime: getVarint(fields, 2),
    mtime: getVarint(fields, 3),
    options: getString(fields, 4),
    path: getString(fields, 5),
    optionalName: getString(fields, 6),
    updateIfNew: getVarint(fields, 7) !== 0,
    compressType: Number(getVarint(fields, 8)),
    holdTimestamp: getVarint(fields, 9) !== 0,
    functionName: getString(fields, 10),
    clientCwd: getString(fields, 11),
    reserve1: getString(fields, 12),
    reserve2: getString(fields, 13),
  };
}

export function encodeTransferPayload(index: HdcInteger, data: ByteInput): Uint8Array {
  const body = toUint8Array(data);
  const metadata = encodeMessage([
    { tag: 1, type: 'varint', value: index },
    { tag: 2, type: 'varint', value: 0 },
    { tag: 3, type: 'varint', value: body.byteLength },
    { tag: 4, type: 'varint', value: body.byteLength },
  ]);
  if (metadata.byteLength + 1 > HDC.TRANSFER_PREFIX_SIZE) {
    throw new HdcProtocolError('文件传输 metadata 超过 64 字节');
  }
  const output = new Uint8Array(HDC.TRANSFER_PREFIX_SIZE + body.byteLength);
  output.set(metadata, 0);
  output.set(body, HDC.TRANSFER_PREFIX_SIZE);
  return output;
}

export function decodeTransferPayload(input: ByteInput): HdcTransferPayload {
  const bytes = toUint8Array(input);
  if (bytes.byteLength < HDC.TRANSFER_PREFIX_SIZE) {
    throw new HdcProtocolError('文件传输数据小于 64 字节前缀');
  }
  const fields = decodeMessage(bytes.subarray(0, HDC.TRANSFER_PREFIX_SIZE));
  const compressType = Number(getVarint(fields, 2));
  const compressSize = Number(getVarint(fields, 3));
  const uncompressSize = Number(getVarint(fields, 4));
  if (compressType !== 0) {
    throw new HdcProtocolError(`暂不支持压缩类型 ${compressType}`);
  }
  if (
    compressSize !== uncompressSize ||
    HDC.TRANSFER_PREFIX_SIZE + compressSize > bytes.byteLength
  ) {
    throw new HdcProtocolError('文件传输数据长度不匹配');
  }
  return {
    index: getVarint(fields, 1),
    compressType,
    compressSize,
    uncompressSize,
    data: bytes.slice(HDC.TRANSFER_PREFIX_SIZE, HDC.TRANSFER_PREFIX_SIZE + compressSize),
  };
}

export function quoteHdcArgument(value: unknown): string {
  const text = String(value);
  if (!text || /[\s"'\\]/u.test(text)) {
    return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  }
  return text;
}

export function describePacket(packet: HdcPacket): string {
  return `channel=${packet.channelId} command=${packet.command} bytes=${packet.data.byteLength}`;
}

export { decodeUtf8, encodeUtf8 };
