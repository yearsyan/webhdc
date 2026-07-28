const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type ByteInput =
  string | ArrayBuffer | ArrayBufferView | readonly number[] | null | undefined;

export function toUint8Array(value: ByteInput): Uint8Array {
  if (value == null) {
    return new Uint8Array();
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') {
    return textEncoder.encode(value);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }
  throw new TypeError(`无法转换为 Uint8Array: ${typeof value}`);
}

export function encodeUtf8(value: unknown): Uint8Array {
  return textEncoder.encode(String(value));
}

export function decodeUtf8(value: ByteInput): string {
  return textDecoder.decode(toUint8Array(value));
}

export function concatBytes(...parts: Array<ByteInput | readonly ByteInput[]>): Uint8Array {
  const arrays = parts.flat().map((part) => toUint8Array(part as ByteInput));
  const size = arrays.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of arrays) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function equalBytes(left: ByteInput, right: ByteInput): boolean {
  const a = toUint8Array(left);
  const b = toUint8Array(right);
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

export function bytesToBase64(value: ByteInput): string {
  const bytes = toUint8Array(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}

export function randomUint32(): number {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error('当前环境缺少安全随机数生成器');
  }
  const values = new Uint32Array(1);
  do {
    cryptoApi.getRandomValues(values);
  } while (values[0] === 0);
  return values[0];
}

export function readUint32BE(bytes: ByteInput, offset: number): number {
  const value = toUint8Array(bytes);
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(offset, false);
}

export function writeUint32BE(bytes: ByteInput, offset: number, value: number): void {
  const output = toUint8Array(bytes);
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(offset, value, false);
}

export function writeUint16BE(bytes: ByteInput, offset: number, value: number): void {
  const output = toUint8Array(bytes);
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint16(offset, value, false);
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function withTimeout<T>(
  promise: PromiseLike<T>,
  timeout: number,
  message: string | Error,
  onTimeout?: () => void,
): Promise<T> {
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return Promise.resolve(promise);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(message instanceof Error ? message : new Error(message));
    }, timeout);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

export function toHex(value: number | null | undefined, width = 4): string {
  return Number(value ?? 0)
    .toString(16)
    .padStart(width, '0');
}
