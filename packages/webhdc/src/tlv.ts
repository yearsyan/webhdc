import { decodeUtf8, encodeUtf8, toUint8Array, type ByteInput } from './bytes.js';
import { HdcProtocolError } from './errors.js';

const TAG_SIZE = 16;
const LENGTH_SIZE = 16;

export function encodeStringTlv(entries: Record<string, unknown>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [rawTag, rawValue] of Object.entries(entries)) {
    const tag = String(rawTag);
    if (!tag || tag.length > TAG_SIZE) {
      throw new RangeError(`HDC TLV tag 长度无效: ${tag}`);
    }
    const value = String(rawValue);
    const valueBytes = encodeUtf8(value);
    const length = String(valueBytes.byteLength);
    if (length.length > LENGTH_SIZE) {
      throw new RangeError('HDC TLV value 过长');
    }
    parts.push(
      encodeUtf8(tag.padEnd(TAG_SIZE, ' ')),
      encodeUtf8(length.padEnd(LENGTH_SIZE, ' ')),
      valueBytes,
    );
  }
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function decodeStringTlv(input: ByteInput): Record<string, string> {
  const bytes = toUint8Array(input);
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset + TAG_SIZE + LENGTH_SIZE <= bytes.byteLength) {
    const tag = decodeUtf8(bytes.subarray(offset, offset + TAG_SIZE)).replaceAll(' ', '');
    offset += TAG_SIZE;
    const lengthText = decodeUtf8(bytes.subarray(offset, offset + LENGTH_SIZE)).replaceAll(' ', '');
    offset += LENGTH_SIZE;
    const length = Number.parseInt(lengthText, 10);
    if (!tag || !Number.isSafeInteger(length) || length < 0 || offset + length > bytes.byteLength) {
      throw new HdcProtocolError('无效的 HDC 字符串 TLV');
    }
    result[tag] = decodeUtf8(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== bytes.byteLength) {
    throw new HdcProtocolError('HDC 字符串 TLV 尾部存在不完整数据');
  }
  return result;
}

export function encodeBinaryTlv(entries: Iterable<readonly [number, ByteInput]>): Uint8Array {
  const normalized = [...entries].sort(([left], [right]) => left - right);
  const size = normalized.reduce(
    (total, [, value]) => total + 8 + toUint8Array(value).byteLength,
    0,
  );
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const [tag, value] of normalized) {
    const bytes = toUint8Array(value);
    view.setUint32(offset, tag, true);
    view.setUint32(offset + 4, bytes.byteLength, true);
    output.set(bytes, offset + 8);
    offset += 8 + bytes.byteLength;
  }
  return output;
}

export function decodeBinaryTlv(input: ByteInput): Map<number, Uint8Array> {
  const bytes = toUint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Map<number, Uint8Array>();
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) {
      throw new HdcProtocolError('无效的 HDC 二进制 TLV 头');
    }
    const tag = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    offset += 8;
    if (length === 0 || offset + length > bytes.byteLength) {
      throw new HdcProtocolError(`HDC 二进制 TLV ${tag} 长度无效`);
    }
    result.set(tag, bytes.slice(offset, offset + length));
    offset += length;
  }
  return result;
}
