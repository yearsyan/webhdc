import assert from 'node:assert/strict';
import test from 'node:test';

import {
  devtoolsWebSocketPath,
  parseDevtoolsSockets,
  parseDevtoolsTargets,
  resolveDevtoolsFrontendUrl,
} from '../src/devtools/discovery.ts';
import { tryParseHttpResponse } from '../src/devtools/http.ts';
import {
  encodeWebSocketFrame,
  ForwardedWebSocket,
  WebSocketFrameParser,
} from '../src/devtools/websocket.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const websocketGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

async function websocketAccept(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', encoder.encode(`${key}${websocketGuid}`));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

test('discovers abstract WebView DevTools sockets from /proc/net/unix', () => {
  const output = [
    'Num RefCount Protocol Flags Type St Inode Path',
    '0000: 00000002 00000000 00010000 0001 01 42 @webview_devtools_remote_38532',
    '0001: 00000002 00000000 00010000 0001 01 43 @other_socket',
    '0002: 00000002 00000000 00010000 0001 01 44 /tmp/devtools.sock',
    '0003: 00000002 00000000 00010000 0001 01 45 @webview_devtools_remote_38532',
  ].join('\n');

  assert.deepEqual(parseDevtoolsSockets(output), [
    {
      name: 'webview_devtools_remote_38532',
      pid: '38532',
      raw: '0003: 00000002 00000000 00010000 0001 01 45 @webview_devtools_remote_38532',
    },
  ]);
});

test('parses targets and resolves an official matching frontend revision', () => {
  const [target] = parseDevtoolsTargets(
    JSON.stringify([
      {
        id: 'page-1',
        type: 'page',
        title: 'Example',
        url: 'https://example.com/',
        webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-1',
        devtoolsFrontendUrl:
          'https://chrome-devtools-frontend.appspot.com/serve_rev/@84ca000f76aa74165674247374b0e0802c3f8a89/inspector.html?ws=localhost:9222/devtools/page/page-1',
      },
    ]),
  );

  assert.ok(target);
  assert.equal(devtoolsWebSocketPath(target.webSocketDebuggerUrl), '/devtools/page/page-1');
  assert.equal(
    resolveDevtoolsFrontendUrl(target, null),
    'https://chrome-devtools-frontend.appspot.com/serve_rev/@84ca000f76aa74165674247374b0e0802c3f8a89/inspector.html',
  );
});

test('rejects target-provided non-official frontend and falls back to WebKit revision', () => {
  const [target] = parseDevtoolsTargets(
    JSON.stringify([
      {
        id: 'page-2',
        webSocketDebuggerUrl: 'ws://localhost/devtools/page/page-2',
        devtoolsFrontendUrl: 'https://evil.example/inspector.html',
      },
    ]),
  );
  assert.ok(target);
  assert.equal(
    resolveDevtoolsFrontendUrl(target, { webKitVersion: '537.36 (@abcdef1234567890)' }),
    'https://chrome-devtools-frontend.appspot.com/serve_rev/@abcdef1234567890/inspector.html',
  );
});

test('incrementally parses content-length and chunked HTTP responses', () => {
  const fixed = encoder.encode(
    'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{"a":1}',
  );
  assert.equal(tryParseHttpResponse(fixed.subarray(0, fixed.byteLength - 1)), null);
  const fixedResult = tryParseHttpResponse(fixed);
  assert.equal(fixedResult?.status, 200);
  assert.equal(decoder.decode(fixedResult?.body), '{"a":1}');

  const chunked = encoder.encode(
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n',
  );
  const chunkedResult = tryParseHttpResponse(chunked);
  assert.equal(decoder.decode(chunkedResult?.body), 'Wikipedia');
  assert.equal(chunkedResult?.consumed, chunked.byteLength);
});

test('encodes masked client frames and parses fragmented input', () => {
  const payload = encoder.encode('{"id":1}');
  const encoded = encodeWebSocketFrame(0x01, payload, Uint8Array.of(1, 2, 3, 4));
  assert.equal((encoded[1] & 0x80) !== 0, true);

  const parser = new WebSocketFrameParser();
  assert.deepEqual(parser.push(encoded.subarray(0, 3)), []);
  const [frame] = parser.push(encoded.subarray(3));
  assert.equal(frame?.opcode, 0x01);
  assert.equal(frame?.fin, true);
  assert.equal(frame?.masked, true);
  assert.equal(decoder.decode(frame?.payload), '{"id":1}');
});

test('parses unmasked extended-length server frames', () => {
  const payload = new Uint8Array(70_000).fill(0x61);
  const encoded = encodeWebSocketFrame(0x02, payload, null);
  const [frame] = new WebSocketFrameParser(100_000).push(encoded);
  assert.equal(frame?.masked, false);
  assert.equal(frame?.payload.byteLength, 70_000);
  assert.equal(frame?.payload[69_999], 0x61);
});

test('upgrades and exchanges CDP messages over an HDC forward stream', async () => {
  let receiveData: (data: Uint8Array) => void = () => {};
  let receiveClose: (error: Error | null) => void = () => {};
  const writes: Uint8Array[] = [];
  let handshakeRequest = '';
  const stream = {
    onData(listener: (data: Uint8Array) => void) {
      receiveData = listener;
      return () => {};
    },
    onClose(listener: (error: Error | null) => void) {
      receiveClose = listener;
      return () => {};
    },
    onError() {
      return () => {};
    },
    async write(data: Uint8Array) {
      writes.push(data.slice());
      if (writes.length === 1) {
        handshakeRequest = decoder.decode(data);
        const key = handshakeRequest.match(/Sec-WebSocket-Key:\s*(\S+)/iu)?.[1];
        assert.ok(key);
        const accept = await websocketAccept(key);
        receiveData(
          encoder.encode(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          ),
        );
      }
      return data.byteLength;
    },
    async close() {
      receiveClose(null);
    },
  };
  const forward = {
    remote: 'localabstract:webview_devtools_remote_38532',
    async accept() {
      return stream;
    },
  };
  let opened = false;
  let resolveMessage: (value: string | Uint8Array) => void = () => {};
  const receivedMessage = new Promise<string | Uint8Array>((resolve) => {
    resolveMessage = resolve;
  });

  const connection = await ForwardedWebSocket.connect(
    forward as never,
    'ws://webhdc.invalid/devtools/page/page-1',
    {
      onOpen: () => {
        opened = true;
      },
      onMessage: resolveMessage,
      onError: (error) => assert.fail(error),
      onClose: () => {},
    },
    { origin: 'https://chrome-devtools-frontend.appspot.com' },
  );

  assert.equal(opened, true);
  assert.match(handshakeRequest, /^GET \/devtools\/page\/page-1 HTTP\/1\.1/mu);
  assert.match(handshakeRequest, /Origin: https:\/\/chrome-devtools-frontend\.appspot\.com\r$/mu);

  await connection.send('{"id":1,"method":"Runtime.enable"}');
  const [clientFrame] = new WebSocketFrameParser().push(writes[1] ?? new Uint8Array());
  assert.equal(clientFrame?.masked, true);
  assert.equal(decoder.decode(clientFrame?.payload), '{"id":1,"method":"Runtime.enable"}');

  receiveData(encodeWebSocketFrame(0x01, encoder.encode('{"id":1,"result":{}}'), null));
  assert.equal(await receivedMessage, '{"id":1,"result":{}}');
  await connection.close();
});

test('applies a custom size limit to fragmented WebSocket messages', async () => {
  let receiveData: (data: Uint8Array) => void = () => {};
  const stream = {
    onData(listener: (data: Uint8Array) => void) {
      receiveData = listener;
      return () => {};
    },
    onClose() {
      return () => {};
    },
    onError() {
      return () => {};
    },
    async write(data: Uint8Array) {
      const request = decoder.decode(data);
      if (request.startsWith('GET ')) {
        const key = request.match(/Sec-WebSocket-Key:\s*(\S+)/iu)?.[1];
        assert.ok(key);
        receiveData(
          encoder.encode(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${await websocketAccept(key)}\r\n\r\n`,
          ),
        );
      }
      return data.byteLength;
    },
    async close() {},
  };
  const errors: Error[] = [];
  const connection = await ForwardedWebSocket.connect(
    {
      remote: 'localabstract:webview_devtools_remote_38532',
      async accept() {
        return stream;
      },
    } as never,
    'ws://webhdc.invalid/devtools/page/page-1',
    {
      onOpen: () => {},
      onMessage: () => assert.fail('oversized fragmented message must not be delivered'),
      onError: (error) => errors.push(error),
      onClose: () => {},
    },
    { maxFrameSize: 4, origin: 'https://chrome-devtools-frontend.appspot.com' },
  );

  receiveData(encodeWebSocketFrame(0x01, encoder.encode('abc'), null, false));
  receiveData(encodeWebSocketFrame(0x00, encoder.encode('de'), null));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? '', /超过 4 字节/u);
  await connection.close();
});
