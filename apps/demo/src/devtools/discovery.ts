export const DEVTOOLS_SOCKET_COMMAND = 'cat /proc/net/unix | grep devtools';

const OFFICIAL_FRONTEND_HOST = 'chrome-devtools-frontend.appspot.com';

export interface DevtoolsSocket {
  name: string;
  pid: string | null;
  raw: string;
}

export interface DevtoolsTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  description: string;
  faviconUrl: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl?: string;
  devtoolsFrontendUrlCompat?: string;
}

export interface DevtoolsVersion {
  browser?: string;
  protocolVersion?: string;
  webKitVersion?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field : '';
}

/** 解析 `/proc/net/unix` 中可用于 `localabstract:` 的 DevTools socket。 */
export function parseDevtoolsSockets(output: string): DevtoolsSocket[] {
  const sockets = new Map<string, DevtoolsSocket>();
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || !/devtools/iu.test(line)) {
      continue;
    }
    const path = line.split(/\s+/u).at(-1) ?? '';
    if (!path.startsWith('@') || !/devtools/iu.test(path)) {
      continue;
    }
    const name = path.slice(1);
    if (!name || /[\0\r\n]/u.test(name)) {
      continue;
    }
    const pid = name.match(/(?:remote|devtools)[_-](\d+)(?:\D|$)/iu)?.[1] ?? null;
    sockets.set(name, { name, pid, raw: line });
  }
  return [...sockets.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function parseDevtoolsTargets(json: string): DevtoolsTarget[] {
  const parsed: unknown = JSON.parse(json);
  const values = Array.isArray(parsed) ? parsed : isRecord(parsed) ? [parsed] : [];
  const targets: DevtoolsTarget[] = [];

  for (const value of values) {
    if (!isRecord(value)) {
      continue;
    }
    const webSocketDebuggerUrl = stringField(value, 'webSocketDebuggerUrl');
    if (!webSocketDebuggerUrl) {
      continue;
    }
    const id =
      stringField(value, 'id') ||
      (() => {
        try {
          return new URL(webSocketDebuggerUrl).pathname.split('/').filter(Boolean).at(-1) ?? '';
        } catch {
          return '';
        }
      })();
    if (!id) {
      continue;
    }
    targets.push({
      id,
      type: stringField(value, 'type') || 'page',
      title: stringField(value, 'title') || 'Untitled',
      url: stringField(value, 'url'),
      description: stringField(value, 'description'),
      faviconUrl: stringField(value, 'faviconUrl'),
      webSocketDebuggerUrl,
      devtoolsFrontendUrl: stringField(value, 'devtoolsFrontendUrl') || undefined,
      devtoolsFrontendUrlCompat: stringField(value, 'devtoolsFrontendUrlCompat') || undefined,
    });
  }
  return targets;
}

export function parseDevtoolsVersion(json: string): DevtoolsVersion {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    return {};
  }
  return {
    browser: stringField(parsed, 'Browser') || undefined,
    protocolVersion: stringField(parsed, 'Protocol-Version') || undefined,
    webKitVersion: stringField(parsed, 'WebKit-Version') || undefined,
  };
}

function officialFrontendUrl(raw: string): string | null {
  const candidate = raw.trim();
  if (!candidate) {
    return null;
  }
  try {
    const url = new URL(candidate.startsWith('//') ? `https:${candidate}` : candidate);
    if (url.hostname !== OFFICIAL_FRONTEND_HOST || !/^https?:$/u.test(url.protocol)) {
      return null;
    }
    url.protocol = 'https:';
    url.username = '';
    url.password = '';
    url.searchParams.delete('ws');
    url.searchParams.delete('wss');
    return url.toString();
  } catch {
    return null;
  }
}

function findRevision(values: Array<string | undefined>): string | null {
  for (const value of values) {
    const revision = value?.match(/@([0-9a-z]{7,40})/iu)?.[1];
    if (revision) {
      return revision;
    }
  }
  return null;
}

/**
 * 只接受 Chromium 官方托管的前端。若 target 仅给出 `devtools://` 地址，
 * 则从 WebKit revision 构造同版本的 `serve_rev` URL。
 */
export function resolveDevtoolsFrontendUrl(
  target: DevtoolsTarget,
  version: DevtoolsVersion | null,
): string {
  const candidates = [target.devtoolsFrontendUrlCompat, target.devtoolsFrontendUrl];
  for (const candidate of candidates) {
    const url = candidate ? officialFrontendUrl(candidate) : null;
    if (url) {
      return url;
    }
  }

  const revision = findRevision([...candidates, version?.webKitVersion]);
  if (revision) {
    return `https://${OFFICIAL_FRONTEND_HOST}/serve_rev/@${revision}/inspector.html`;
  }
  throw new Error('设备没有提供可用的 Chrome DevTools frontend revision');
}

export function devtoolsWebSocketPath(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`无效的 WebSocket 调试地址：${url}`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`不支持的 WebSocket 调试地址：${url}`);
  }
  return `${parsed.pathname}${parsed.search}`;
}
