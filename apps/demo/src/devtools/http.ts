import type { HdcForward, HdcForwardStream } from '@webhdc/core';

const HEADER_END = Uint8Array.of(13, 10, 13, 10);
const LINE_END = Uint8Array.of(13, 10);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ForwardHttpResponse {
  status: number;
  statusText: string;
  headers: Map<string, string>;
  body: Uint8Array;
  consumed: number;
}

export interface ForwardHttpOptions {
  timeout?: number;
  maxResponseSize?: number;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function findBytes(input: Uint8Array, needle: Uint8Array, start = 0): number {
  outer: for (let index = start; index <= input.byteLength - needle.byteLength; index += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (input[index + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return index;
  }
  return -1;
}

function parseHeaders(bytes: Uint8Array): {
  status: number;
  statusText: string;
  headers: Map<string, string>;
} {
  const lines = decoder.decode(bytes).split('\r\n');
  const statusLine = lines.shift() ?? '';
  const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/u);
  if (!match) {
    throw new Error(`无效的 HTTP 响应状态行：${statusLine || '（空）'}`);
  }
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return { status: Number(match[1]), statusText: match[2] ?? '', headers };
}

function parseChunkedBody(
  input: Uint8Array,
  bodyStart: number,
): { body: Uint8Array; consumed: number } | null {
  let offset = bodyStart;
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const lineEnd = findBytes(input, LINE_END, offset);
    if (lineEnd < 0) {
      return null;
    }
    const sizeText = decoder.decode(input.subarray(offset, lineEnd)).split(';', 1)[0]?.trim() ?? '';
    if (!/^[0-9a-f]+$/iu.test(sizeText)) {
      throw new Error(`无效的 chunked HTTP 长度：${sizeText || '（空）'}`);
    }
    const size = Number.parseInt(sizeText, 16);
    offset = lineEnd + LINE_END.byteLength;
    if (size === 0) {
      if (input.byteLength < offset + 2) {
        return null;
      }
      if (input[offset] === 13 && input[offset + 1] === 10) {
        return { body: joinChunks(chunks, total), consumed: offset + 2 };
      }
      const trailersEnd = findBytes(input, HEADER_END, offset);
      if (trailersEnd < 0) {
        return null;
      }
      return {
        body: joinChunks(chunks, total),
        consumed: trailersEnd + HEADER_END.byteLength,
      };
    }
    if (input.byteLength < offset + size + LINE_END.byteLength) {
      return null;
    }
    if (input[offset + size] !== 13 || input[offset + size + 1] !== 10) {
      throw new Error('chunked HTTP 数据块末尾缺少 CRLF');
    }
    const chunk = input.slice(offset, offset + size);
    chunks.push(chunk);
    total += chunk.byteLength;
    offset += size + LINE_END.byteLength;
  }
}

function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** 增量解析单个 HTTP 响应；数据不足时返回 null。 */
export function tryParseHttpResponse(
  input: Uint8Array,
  { eof = false }: { eof?: boolean } = {},
): ForwardHttpResponse | null {
  const headerEnd = findBytes(input, HEADER_END);
  if (headerEnd < 0) {
    return null;
  }
  const parsed = parseHeaders(input.subarray(0, headerEnd));
  const bodyStart = headerEnd + HEADER_END.byteLength;

  if (
    parsed.status === 101 ||
    parsed.status === 204 ||
    parsed.status === 304 ||
    (parsed.status >= 100 && parsed.status < 200)
  ) {
    return { ...parsed, body: new Uint8Array(), consumed: bodyStart };
  }

  if (/\bchunked\b/iu.test(parsed.headers.get('transfer-encoding') ?? '')) {
    const chunked = parseChunkedBody(input, bodyStart);
    return chunked ? { ...parsed, ...chunked } : null;
  }

  const lengthHeader = parsed.headers.get('content-length');
  if (lengthHeader !== undefined) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`无效的 HTTP Content-Length：${lengthHeader}`);
    }
    if (input.byteLength < bodyStart + length) {
      return null;
    }
    return {
      ...parsed,
      body: input.slice(bodyStart, bodyStart + length),
      consumed: bodyStart + length,
    };
  }

  if (!eof) {
    return null;
  }
  return { ...parsed, body: input.slice(bodyStart), consumed: input.byteLength };
}

function timeoutPromise<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
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

export async function requestForwardHttp(
  forward: HdcForward,
  path: string,
  { timeout = 10_000, maxResponseSize = 8 * 1024 * 1024 }: ForwardHttpOptions = {},
): Promise<ForwardHttpResponse> {
  if (!path.startsWith('/') || /[\r\n]/u.test(path)) {
    throw new Error(`无效的 DevTools HTTP 路径：${path}`);
  }
  const stream = await timeoutPromise(forward.accept(), timeout, `连接 ${forward.remote} 超时`);
  return requestOnStream(stream, path, timeout, maxResponseSize);
}

async function requestOnStream(
  stream: HdcForwardStream,
  path: string,
  timeout: number,
  maxResponseSize: number,
): Promise<ForwardHttpResponse> {
  let buffer: Uint8Array = new Uint8Array();
  let settled = false;
  let unsubscribeData = () => {};
  let unsubscribeClose = () => {};
  let unsubscribeError = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortRequest: (error: unknown) => void = () => {};

  const response = new Promise<ForwardHttpResponse>((resolve, reject) => {
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      unsubscribeData();
      unsubscribeClose();
      unsubscribeError();
    };
    const succeed = (value: ForwardHttpResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      void stream.close().catch(() => {});
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      void stream.close().catch(() => {});
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    abortRequest = fail;
    const parse = (eof = false) => {
      try {
        const value = tryParseHttpResponse(buffer, { eof });
        if (value) {
          succeed(value);
        } else if (eof) {
          fail(new Error('DevTools HTTP 响应在完成前已关闭'));
        }
      } catch (error) {
        fail(error);
      }
    };

    unsubscribeData = stream.onData((chunk) => {
      buffer = concatBytes(buffer, chunk);
      if (buffer.byteLength > maxResponseSize) {
        fail(new Error(`DevTools HTTP 响应超过 ${maxResponseSize} 字节`));
        return;
      }
      parse();
    });
    unsubscribeClose = stream.onClose((error) => {
      if (error) {
        fail(error);
      } else {
        parse(true);
      }
    });
    unsubscribeError = stream.onError(fail);
    if (Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() => fail(new Error(`读取 DevTools HTTP ${path} 超时`)), timeout);
    }
  });

  const request = [
    `GET ${path} HTTP/1.1`,
    'Host: 127.0.0.1:9222',
    'Accept: application/json',
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  try {
    await stream.write(encoder.encode(request));
  } catch (error) {
    abortRequest(error);
  }
  return response;
}

export function decodeHttpBody(response: ForwardHttpResponse): string {
  return decoder.decode(response.body);
}
