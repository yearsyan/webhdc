import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { MESSAGE_LEVEL, type HdcProgress } from '@webhdc/core';
import { useHdc } from '../hdc/HdcProvider';
import {
  cleanTerminalText,
  formatBytes,
  formatError,
  joinRemotePath,
  parentRemotePath,
  shellQuote,
} from '../utils/format';
import { Panel } from './Panel';
import shared from '../styles/shared.module.css';
import styles from './FileBrowserPanel.module.css';

type EntryKind = 'dir' | 'file' | 'link';

interface FileEntry {
  name: string;
  kind: EntryKind;
  size: number | null;
  mtime: string;
  perms: string;
}

interface ParsedLs {
  entries: FileEntry[];
  errors: string[];
}

interface Notice {
  kind: 'ok' | 'err';
  text: string;
}

interface TransferTask {
  kind: 'up' | 'down';
  name: string;
}

const QUICK_PATHS: ReadonlyArray<readonly [string, string]> = [
  ['/data/local/tmp', 'tmp'],
  ['/storage/media/100/local/files/Docs', 'Docs'],
  ['/', '/'],
];

const KIND_ICON: Record<EntryKind, string> = {
  dir: '📁',
  file: '📄',
  link: '🔗',
};

const DATE_TOKEN = /^[\d:.,-]+$/u;
const MONTH_TOKEN = /^[A-Z][a-z]{2}$/u;

/**
 * 解析 toybox / GNU `ls -lA` 输出，兼容 ISO（2024-01-15 10:30）
 * 与传统（Jan 15 10:30）两种日期格式；名称中的空格会被保留。
 */
function parseLs(output: string): ParsedLs {
  const entries: FileEntry[] = [];
  const errors: string[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('total ')) {
      continue;
    }
    if (/^(ls|stat|cd):/u.test(line)) {
      errors.push(line);
      continue;
    }
    const match = line.match(/^([bcdlps-])([rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(.+)$/u);
    if (!match) {
      continue;
    }
    const [, type, perms, sizeText, rest] = match;
    const tokens = rest.split(/\s+/u);
    let dateCount = 0;
    while (dateCount < 3 && dateCount < tokens.length - 1) {
      const token = tokens[dateCount];
      if (DATE_TOKEN.test(token) || MONTH_TOKEN.test(token)) {
        dateCount += 1;
      } else {
        break;
      }
    }
    let name = tokens.slice(dateCount).join(' ');
    if (!name || name === '.' || name === '..') {
      continue;
    }
    const kind: EntryKind = type === 'd' ? 'dir' : type === 'l' ? 'link' : 'file';
    if (kind === 'link') {
      const arrow = name.indexOf(' -> ');
      if (arrow !== -1) {
        name = name.slice(0, arrow);
      }
    }
    entries.push({
      name,
      kind,
      size: kind === 'file' ? Number(sizeText) : null,
      mtime: tokens.slice(0, dateCount).join(' '),
      perms,
    });
  }
  entries.sort((a, b) => {
    const rank = (entry: FileEntry) => (entry.kind === 'file' ? 1 : 0);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  return { entries, errors };
}

/** `ls -lA` 解析失败时的兜底：用 `ls -1Ap` 仅列出名称。 */
async function listNamesOnly(client: ReturnType<typeof useHdc>['client'], dir: string) {
  const result = await client.exec(`ls -1Ap ${shellQuote(dir)}`, { timeout: 15_000 });
  const entries: FileEntry[] = [];
  for (const rawLine of cleanTerminalText(result.stdout).split('\n')) {
    const line = rawLine.trim();
    if (!line || /^(ls|stat):/u.test(line)) {
      continue;
    }
    const isDir = line.endsWith('/');
    const name = isDir ? line.slice(0, -1) : line.replace(/[*@|=]$/u, '');
    if (!name || name === '.' || name === '..') {
      continue;
    }
    entries.push({ name, kind: isDir ? 'dir' : 'file', size: null, mtime: '', perms: '' });
  }
  entries.sort((a, b) => {
    const rank = (entry: FileEntry) => (entry.kind === 'file' ? 1 : 0);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  return entries;
}

export function FileBrowserPanel() {
  const { client, connected } = useHdc();
  const [path, setPath] = useState('/data/local/tmp');
  const [pathInput, setPathInput] = useState('/data/local/tmp');
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<TransferTask | null>(null);
  const [progress, setProgress] = useState<HdcProgress | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingRow, setPendingRow] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(
    async (dir: string) => {
      const target = dir.trim() || '/';
      setLoading(true);
      setListError(null);
      setNotice(null);
      try {
        const result = await client.exec(`ls -lA ${shellQuote(target)}`, { timeout: 15_000 });
        const text = cleanTerminalText(result.stdout);
        let parsed = parseLs(text);
        const failMessage = result.messages
          .find((message) => message.level === MESSAGE_LEVEL.FAIL)
          ?.text.trim();
        if (parsed.entries.length === 0) {
          if (parsed.errors.length > 0) {
            throw new Error(parsed.errors.join('\n'));
          }
          if (failMessage) {
            throw new Error(failMessage);
          }
          if (text.trim()) {
            // 有输出但一行都没解析出来，退化为仅列名称
            parsed = { entries: await listNamesOnly(client, target), errors: [] };
          }
        }
        setEntries(parsed.entries);
        setPath(target);
        setPathInput(target);
        if (parsed.errors.length > 0) {
          setListError(parsed.errors.join(' · '));
        }
      } catch (error) {
        setEntries(null);
        setListError(formatError(error));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    if (connected) {
      void load(pathRef.current);
    } else {
      setEntries(null);
      setListError(null);
      setNotice(null);
      setTransfer(null);
      setProgress(null);
    }
  }, [connected, load]);

  const runChecked = async (command: string): Promise<void> => {
    const result = await client.exec(command, { timeout: 30_000 });
    const out = cleanTerminalText(result.stdout).trim();
    const fail = result.messages.find((message) => message.level === MESSAGE_LEVEL.FAIL);
    if (fail && fail.text.trim()) {
      throw new Error(fail.text.trim());
    }
    if (/permission denied|not permitted|no such file|cannot|failed|error/iu.test(out)) {
      throw new Error(out || command);
    }
  };

  const download = async (name: string) => {
    if (transfer) {
      return;
    }
    const remote = joinRemotePath(pathRef.current, name);
    setTransfer({ kind: 'down', name });
    setProgress(null);
    setNotice(null);
    try {
      const result = await client.receiveFile(remote, {
        timeout: 600_000,
        onProgress: setProgress,
      });
      if (result.blob) {
        const url = URL.createObjectURL(result.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = result.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
      setNotice({ kind: 'ok', text: `已下载 ${result.name} · ${formatBytes(result.size)}` });
    } catch (error) {
      setNotice({ kind: 'err', text: `下载失败 · ${formatError(error)}` });
    } finally {
      setTransfer(null);
      setProgress(null);
    }
  };

  const handleUploadPick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || transfer) {
      return;
    }
    const remote = joinRemotePath(pathRef.current, file.name);
    setTransfer({ kind: 'up', name: file.name });
    setProgress(null);
    setNotice(null);
    try {
      const result = await client.sendFile(file, remote, {
        timeout: 600_000,
        onProgress: setProgress,
      });
      setNotice({
        kind: 'ok',
        text: `已上传 ${file.name} · ${formatBytes(result.size)} → ${result.remotePath}`,
      });
      await load(pathRef.current);
    } catch (error) {
      setNotice({ kind: 'err', text: `上传失败 · ${formatError(error)}` });
    } finally {
      setTransfer(null);
      setProgress(null);
    }
  };

  const mkdir = async () => {
    const name = window.prompt('新建文件夹名称');
    const trimmed = name?.trim();
    if (!trimmed) {
      return;
    }
    setNotice(null);
    try {
      await runChecked(`mkdir -p -- ${shellQuote(joinRemotePath(pathRef.current, trimmed))}`);
      setNotice({ kind: 'ok', text: `已创建 ${trimmed}` });
      await load(pathRef.current);
    } catch (error) {
      setNotice({ kind: 'err', text: `创建失败 · ${formatError(error)}` });
    }
  };

  const remove = async (entry: FileEntry) => {
    const target = joinRemotePath(pathRef.current, entry.name);
    const label = entry.kind === 'dir' ? '目录（含内容，递归）' : '文件';
    if (!window.confirm(`删除${label} ${target}？`)) {
      return;
    }
    setPendingRow(entry.name);
    setNotice(null);
    try {
      await runChecked(`rm -rf -- ${shellQuote(target)}`);
      setNotice({ kind: 'ok', text: `已删除 ${entry.name}` });
      await load(pathRef.current);
    } catch (error) {
      setNotice({ kind: 'err', text: `删除失败 · ${formatError(error)}` });
    } finally {
      setPendingRow(null);
    }
  };

  const submitPath = (event: FormEvent) => {
    event.preventDefault();
    void load(pathInput);
  };

  const percent =
    transfer && progress ? Math.round(Math.min(1, Math.max(0, progress.ratio)) * 100) : 0;
  const segments = path.split('/').filter(Boolean);
  const controlsDisabled = !connected || loading || transfer !== null;

  return (
    <Panel kicker="FILE BROWSER" title="文件浏览器" className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.crumbRow}>
          <button
            className={`${shared.button} ${shared.buttonSecondary} ${styles.upButton}`}
            type="button"
            onClick={() => void load(parentRemotePath(path))}
            disabled={controlsDisabled || path === '/'}
            title="上一级目录"
          >
            ↑ 上级
          </button>
          <div className={styles.crumbs} role="navigation" aria-label="当前路径">
            <button
              className={`${styles.crumb} ${segments.length === 0 ? styles.current : ''}`.trim()}
              type="button"
              onClick={() => void load('/')}
              disabled={controlsDisabled}
            >
              根
            </button>
            {segments.map((segment, index) => {
              const segmentPath = `/${segments.slice(0, index + 1).join('/')}`;
              const isCurrent = index === segments.length - 1;
              return (
                <span key={segmentPath} className={styles.crumbItem}>
                  <span className={styles.sep} aria-hidden="true">
                    /
                  </span>
                  <button
                    className={`${styles.crumb} ${isCurrent ? styles.current : ''}`.trim()}
                    type="button"
                    onClick={() => void load(segmentPath)}
                    disabled={controlsDisabled || isCurrent}
                  >
                    {segment}
                  </button>
                </span>
              );
            })}
          </div>
          <button
            className={`${shared.button} ${shared.buttonQuiet} ${styles.refreshButton}`}
            type="button"
            onClick={() => void load(path)}
            disabled={controlsDisabled}
            title="刷新当前目录"
          >
            ⟳
          </button>
        </div>

        <div className={styles.actionRow}>
          <form className={styles.pathForm} onSubmit={submitPath}>
            <input
              className={shared.input}
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              spellCheck={false}
              disabled={!connected || loading}
              placeholder="输入远端路径"
              aria-label="远端路径"
            />
            <button
              className={`${shared.button} ${shared.buttonSecondary}`}
              type="submit"
              disabled={!connected || loading}
            >
              前往
            </button>
          </form>
          <div className={styles.chips}>
            {QUICK_PATHS.map(([dir, label]) => (
              <button
                key={dir}
                className={styles.chipBtn}
                type="button"
                onClick={() => void load(dir)}
                disabled={controlsDisabled}
                title={dir}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className={`${shared.button} ${shared.buttonSecondary}`}
            type="button"
            onClick={() => uploadRef.current?.click()}
            disabled={controlsDisabled}
          >
            上传到此目录
          </button>
          <button
            className={`${shared.button} ${shared.buttonSecondary}`}
            type="button"
            onClick={mkdir}
            disabled={controlsDisabled}
          >
            新建文件夹
          </button>
          <input ref={uploadRef} type="file" hidden onChange={handleUploadPick} />
        </div>
      </div>

      <div className={styles.tableWrap} style={{ opacity: loading && entries ? 0.55 : 1 }}>
        {loading && !entries ? (
          <p className={styles.stateRow}>读取目录中…</p>
        ) : listError ? (
          <p className={`${styles.stateRow} ${styles.errText}`}>{listError}</p>
        ) : entries && entries.length > 0 ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>名称</th>
                <th className={styles.colSize}>大小</th>
                <th className={styles.colTime}>修改时间</th>
                <th className={styles.colActions}>操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.name} title={entry.perms ? `权限 ${entry.perms}` : undefined}>
                  <td>
                    <button
                      className={styles.nameBtn}
                      type="button"
                      onClick={() =>
                        entry.kind === 'file'
                          ? void download(entry.name)
                          : void load(joinRemotePath(path, entry.name))
                      }
                      disabled={transfer !== null}
                    >
                      <span className={styles.fileIcon} aria-hidden="true">
                        {KIND_ICON[entry.kind]}
                      </span>
                      <span className={styles.name}>{entry.name}</span>
                    </button>
                  </td>
                  <td className={styles.colSize}>
                    {entry.kind === 'file' && entry.size !== null ? formatBytes(entry.size) : '—'}
                  </td>
                  <td className={styles.colTime}>{entry.mtime || '—'}</td>
                  <td className={styles.colActions}>
                    {entry.kind === 'file' && (
                      <button
                        className={styles.miniBtn}
                        type="button"
                        onClick={() => void download(entry.name)}
                        disabled={transfer !== null}
                      >
                        下载
                      </button>
                    )}
                    <button
                      className={`${styles.miniBtn} ${styles.miniBtnDanger}`}
                      type="button"
                      onClick={() => void remove(entry)}
                      disabled={pendingRow !== null || transfer !== null}
                    >
                      {pendingRow === entry.name ? '删除中' : '删除'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className={styles.stateRow}>空目录</p>
        )}
      </div>

      <div className={shared.progressTrack} aria-hidden="true">
        <span className={shared.progressBar} style={{ width: `${percent}%` }} />
      </div>
      <p
        className={`${styles.statusLine} ${
          notice ? (notice.kind === 'err' ? styles.statusErr : styles.statusOk) : ''
        }`.trim()}
      >
        {transfer
          ? `${transfer.kind === 'up' ? '上传' : '下载'} ${transfer.name} · ${percent}%`
          : (notice?.text ?? '点击目录进入，点击文件直接下载')}
      </p>
    </Panel>
  );
}
