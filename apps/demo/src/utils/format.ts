export function formatError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotFoundError') {
      return '未选择 USB 设备';
    }
    if (error.name === 'NetworkError') {
      return '无法占用 USB 接口；请先停止本机 hdc server 或退出 DevEco Studio';
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}

export function cleanTerminalText(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
      .replaceAll('\r\n', '\n')
      .replace(/\r(?!\n)/gu, '\n')
  );
}

export function joinRemotePath(dir: string, name: string): string {
  const trimmed = dir.trim() || '/data/local/tmp/';
  return `${trimmed.replace(/\/+$/u, '')}/${name}`;
}

export function parentRemotePath(path: string): string {
  const trimmed = path.replace(/\/+$/u, '');
  if (!trimmed || trimmed === '/') {
    return '/';
  }
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
