import { useCallback, useEffect, useMemo, useState } from 'react';
import { MESSAGE_LEVEL } from '@webhdc/core';
import { useHdc } from '../hdc/HdcProvider';
import { cleanTerminalText, formatError, shellQuote } from '../utils/format';
import { InstallPanel } from './InstallPanel';
import { Panel } from './Panel';
import shared from '../styles/shared.module.css';
import styles from './AppsPanel.module.css';

interface AppDetail {
  version: string;
  versionCode: string;
  minCompatible: string;
  raw: string;
}

type DetailState = Record<string, AppDetail | 'loading' | undefined>;

/** 解析 `bm dump -a` 输出中的 bundle 名（跳过 "ID:"、"100:" 等行）。 */
function parseBundleNames(output: string): string[] {
  const names = new Set<string>();
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line || line === 'ID:' || line.endsWith(':')) {
      continue;
    }
    if (/^[A-Za-z][\w-]*(\.[\w-]+)+$/u.test(line)) {
      names.add(line);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function pick(text: string, pattern: RegExp): string {
  return text.match(pattern)?.[1] ?? '—';
}

export function AppsPanel() {
  const { client, connected } = useHdc();
  const [apps, setApps] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<DetailState>({});
  const [pending, setPending] = useState<string | null>(null);
  const [keepData, setKeepData] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.exec('bm dump -a', { timeout: 30_000 });
      const names = parseBundleNames(cleanTerminalText(result.stdout));
      if (names.length === 0) {
        const fail = result.messages.find((message) => message.level === MESSAGE_LEVEL.FAIL);
        if (fail) {
          throw new Error(fail.text.trim() || '读取应用列表失败');
        }
      }
      setApps(names);
    } catch (event) {
      setApps(null);
      setError(formatError(event));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (connected) {
      void refresh();
    } else {
      setApps(null);
      setDetails({});
      setExpanded(null);
      setError(null);
      setNotice(null);
    }
  }, [connected, refresh]);

  const filtered = useMemo(() => {
    if (!apps) {
      return null;
    }
    const keyword = filter.trim().toLowerCase();
    if (!keyword) {
      return apps;
    }
    return apps.filter((name) => name.toLowerCase().includes(keyword));
  }, [apps, filter]);

  const toggleDetail = async (name: string) => {
    if (expanded === name) {
      setExpanded(null);
      return;
    }
    setExpanded(name);
    if (details[name]) {
      return;
    }
    setDetails((prev) => ({ ...prev, [name]: 'loading' }));
    try {
      const result = await client.exec(`bm dump -n ${shellQuote(name)}`, { timeout: 30_000 });
      const text = cleanTerminalText(result.stdout);
      setDetails((prev) => ({
        ...prev,
        [name]: {
          version: pick(text, /"versionName"\s*:\s*"([^"]+)"/u),
          versionCode: pick(text, /"versionCode"\s*:\s*"?(\d+)"?/u),
          minCompatible: pick(text, /"minCompatibleVersionCode"\s*:\s*"?(\d+)"?/u),
          raw: text.trim(),
        },
      }));
    } catch (event) {
      setDetails((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      setError(formatError(event));
    }
  };

  const uninstall = async (name: string) => {
    if (!window.confirm(`确定卸载 ${name}？${keepData ? '（保留数据与缓存）' : ''}`)) {
      return;
    }
    setPending(name);
    setError(null);
    setNotice(null);
    try {
      const keep = keepData ? '-k ' : '';
      const result = await client.exec(`bm uninstall ${keep}-n ${shellQuote(name)}`, {
        timeout: 60_000,
      });
      const out = cleanTerminalText(result.stdout).trim();
      if (/error|fail/iu.test(out)) {
        throw new Error(out || '卸载失败');
      }
      setNotice(`已卸载 ${name}`);
      if (expanded === name) {
        setExpanded(null);
      }
      await refresh();
    } catch (event) {
      setError(`${name} 卸载失败 · ${formatError(event)}`);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className={styles.grid}>
      <InstallPanel />
      <Panel
        kicker="INSTALLED APPS"
        title="已安装应用"
        extra={<span className={shared.badge}>{apps ? `${apps.length} 个` : '—'}</span>}
      >
        <div className={styles.tools}>
          <input
            className={`${shared.input} ${styles.filterInput}`}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="按包名过滤"
            spellCheck={false}
            disabled={!connected || !apps}
            aria-label="按包名过滤"
          />
          <button
            className={`${shared.button} ${shared.buttonSecondary}`}
            type="button"
            onClick={() => void refresh()}
            disabled={!connected || loading}
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>

        <label className={styles.keep}>
          <input
            type="checkbox"
            checked={keepData}
            onChange={(event) => setKeepData(event.target.checked)}
          />
          卸载时保留数据与缓存（-k）
        </label>

        {error && <p className={styles.errText}>{error}</p>}
        {notice && <p className={styles.okText}>{notice}</p>}

        <div className={styles.list}>
          {loading && !apps ? (
            <p className={styles.stateText}>正在读取应用列表…</p>
          ) : filtered && filtered.length > 0 ? (
            filtered.map((name) => {
              const detail = details[name];
              const isOpen = expanded === name;
              return (
                <div key={name} className={styles.appRow}>
                  <div className={styles.appHead}>
                    <button
                      className={styles.appNameBtn}
                      type="button"
                      onClick={() => void toggleDetail(name)}
                      title="查看应用详情"
                    >
                      <span className={styles.caret} aria-hidden="true">
                        {isOpen ? '▾' : '▸'}
                      </span>
                      <span className={styles.appName}>{name}</span>
                    </button>
                    <div className={styles.appActions}>
                      <button
                        className={styles.miniBtn}
                        type="button"
                        onClick={() => void toggleDetail(name)}
                      >
                        {isOpen ? '收起' : '详情'}
                      </button>
                      <button
                        className={`${styles.miniBtn} ${styles.miniBtnDanger}`}
                        type="button"
                        onClick={() => void uninstall(name)}
                        disabled={pending !== null}
                      >
                        {pending === name ? '卸载中…' : '卸载'}
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className={styles.detail}>
                      {!detail || detail === 'loading' ? (
                        <p className={styles.stateText}>读取详情…</p>
                      ) : (
                        <>
                          <div className={styles.detailGrid}>
                            <span>
                              版本 <strong>{detail.version}</strong>
                            </span>
                            <span>
                              versionCode <strong>{detail.versionCode}</strong>
                            </span>
                            <span>
                              minCompatible <strong>{detail.minCompatible}</strong>
                            </span>
                          </div>
                          <details className={styles.raw}>
                            <summary>查看 bm dump 原始输出</summary>
                            <pre>{detail.raw}</pre>
                          </details>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          ) : apps ? (
            <p className={styles.stateText}>
              {filter ? '没有匹配的应用' : '设备上没有可列举的应用'}
            </p>
          ) : (
            <p className={styles.stateText}>—</p>
          )}
        </div>
      </Panel>
    </div>
  );
}
