import { concatBytes, decodeUtf8, encodeUtf8, toUint8Array, type ByteInput } from './bytes.js';
import { HdcProtocolError } from './errors.js';
import type { HdcInteger } from './types.js';

const WIRE_TYPE = Object.freeze({
  VARINT: 0,
  FIXED_64: 1,
  LENGTH_DELIMITED: 2,
  FIXED_32: 5,
});

export interface DecodedVarint {
  value: bigint;
  offset: number;
}

export interface ProtobufField {
  wireType: number;
  value: bigint | Uint8Array;
}

export type ProtobufFields = Map<number, ProtobufField>;

export type ProtobufEncodeField =
  | { tag: number; type: 'varint'; value: HdcInteger }
  | { tag: number; type: 'bytes' | 'string'; value: ByteInput };

export function encodeVarint(input: HdcInteger): Uint8Array {
  let value = typeof input === 'bigint' ? input : BigInt(input);
  if (value < 0n) {
    throw new RangeError('varint 不能为负数');
  }
  const output = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value !== 0n) {
      byte |= 0x80;
    }
    output.push(byte);
  } while (value !== 0n);
  return Uint8Array.from(output);
}

export function decodeVarint(bytes: ByteInput, startOffset = 0): DecodedVarint {
  const input = toUint8Array(bytes);
  let value = 0n;
  let shift = 0n;
  let offset = startOffset;
  while (offset < input.byteLength && shift < 70n) {
    const byte = input[offset];
    value |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      return { value, offset };
    }
    shift += 7n;
  }
  throw new HdcProtocolError('无效或不完整的 protobuf varint');
}

export function encodeVarintField(tag: number, value: HdcInteger): Uint8Array {
  return concatBytes(encodeVarint((tag << 3) | WIRE_TYPE.VARINT), encodeVarint(value));
}

export function encodeBytesField(tag: number, value: ByteInput): Uint8Array {
  const bytes = typeof value === 'string' ? encodeUtf8(value) : toUint8Array(value);
  return concatBytes(
    encodeVarint((tag << 3) | WIRE_TYPE.LENGTH_DELIMITED),
    encodeVarint(bytes.byteLength),
    bytes,
  );
}

export function encodeMessage(fields: readonly ProtobufEncodeField[]): Uint8Array {
  return concatBytes(
    fields.map((field) => {
      if (field.type === 'varint') {
        return encodeVarintField(field.tag, field.value);
      }
      return encodeBytesField(field.tag, field.value);
    }),
  );
}

export function decodeMessage(bytes: ByteInput): ProtobufFields {
  const input = toUint8Array(bytes);
  const fields: ProtobufFields = new Map();
  let offset = 0;
  while (offset < input.byteLength) {
    if (input[offset] === 0) {
      break;
    }
    const tagResult = decodeVarint(input, offset);
    offset = tagResult.offset;
    const tagValue = Number(tagResult.value);
    const tag = tagValue >>> 3;
    const wireType = tagValue & 0x07;
    let value;

    if (wireType === WIRE_TYPE.VARINT) {
      const result = decodeVarint(input, offset);
      value = result.value;
      offset = result.offset;
    } else if (wireType === WIRE_TYPE.LENGTH_DELIMITED) {
      const lengthResult = decodeVarint(input, offset);
      const length = Number(lengthResult.value);
      offset = lengthResult.offset;
      if (length < 0 || offset + length > input.byteLength) {
        throw new HdcProtocolError(`protobuf 字段 ${tag} 长度越界`);
      }
      value = input.slice(offset, offset + length);
      offset += length;
    } else if (wireType === WIRE_TYPE.FIXED_64) {
      if (offset + 8 > input.byteLength) {
        throw new HdcProtocolError(`protobuf fixed64 字段 ${tag} 不完整`);
      }
      value = input.slice(offset, offset + 8);
      offset += 8;
    } else if (wireType === WIRE_TYPE.FIXED_32) {
      if (offset + 4 > input.byteLength) {
        throw new HdcProtocolError(`protobuf fixed32 字段 ${tag} 不完整`);
      }
      value = input.slice(offset, offset + 4);
      offset += 4;
    } else {
      throw new HdcProtocolError(`不支持的 protobuf wire type: ${wireType}`);
    }
    fields.set(tag, { wireType, value });
  }
  return fields;
}

export function getVarint(
  fields: ProtobufFields,
  tag: number,
  fallback: HdcInteger = 0,
): HdcInteger {
  const field = fields.get(tag);
  if (!field) {
    return fallback;
  }
  const value = field.value;
  if (typeof value !== 'bigint') {
    throw new HdcProtocolError(`protobuf 字段 ${tag} 不是 varint`);
  }
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

export function getBytes(fields: ProtobufFields, tag: number): Uint8Array {
  const field = fields.get(tag);
  if (!field) {
    return new Uint8Array();
  }
  if (!(field.value instanceof Uint8Array)) {
    throw new HdcProtocolError(`protobuf 字段 ${tag} 不是 bytes`);
  }
  return field.value;
}

export function getString(fields: ProtobufFields, tag: number, fallback = ''): string {
  const field = fields.get(tag);
  if (!field) {
    return fallback;
  }
  if (!(field.value instanceof Uint8Array)) {
    throw new HdcProtocolError(`protobuf 字段 ${tag} 不是 string`);
  }
  return decodeUtf8(field.value);
}
