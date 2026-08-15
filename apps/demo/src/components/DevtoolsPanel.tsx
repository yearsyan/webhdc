import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HdcForward } from '@webhdc/core';
import { useHdc } from '../hdc/HdcProvider';
import {
  DEVTOOLS_SOCKET_COMMAND,
  parseDevtoolsSockets,
  parseDevtoolsTargets,
  parseDevtoolsVersion,
  resolveDevtoolsFrontendUrl,
  type DevtoolsSocket,
  type DevtoolsTarget,
  type DevtoolsVersion,
} from '../devtools/discovery';
import { decodeHttpBody, requestForwardHttp } from '../devtools/http';
import type { DevtoolsBridgeStatus } from '../devtools/messageBridge';
import { cleanTerminalText, formatError } from '../utils/format';
import { Panel } from './Panel';
import { DevtoolsFrame } from './DevtoolsFrame';
import shared from '../styles/shared.module.css';
import styles from './DevtoolsPanel.module.css';

interface MappedDevtools {
  socket: DevtoolsSocket;
  forward: HdcForward;
  targets: DevtoolsTarget[];
  version: DevtoolsVersion | null;
}

async function readJson(forward: HdcForward, path: string): Promise<string> {
  const response = await requestForwardHttp(forward, path);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${path} 返回 HTTP ${response.status} ${response.statusText}`.trim());
  }
  return decodeHttpBody(response);
}

async function readTargets(forward: HdcForward): Promise<DevtoolsTarget[]> {
  try {
    return parseDevtoolsTargets(await readJson(forward, '/json/list'));
  } catch (error) {
    const fallback = parseDevtoolsTargets(await readJson(forward, '/json'));
    if (fallback.length === 0) {
      throw error;
    }
    return fallback;
  }
}

function socketTitle(socket: DevtoolsSocket): string {
  return socket.pid ? `WebView · PID ${socket.pid}` : 'WebView DevTools';
}

function targetTitle(target: DevtoolsTarget): string {
  const title = target.title.trim();
  return title && title !== 'Untitled' ? title : target.url || target.id;
}

function ExpandIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 2H2v4" />
      <path d="M10 2h4v4" />
      <path d="M14 10v4h-4" />
      <path d="M2 10v4h4" />
    </svg>
  );
}

function CompressIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 6h4V2" />
      <path d="M14 6h-4V2" />
      <path d="M14 10h-4v4" />
      <path d="M2 10h4v4" />
    </svg>
  );
}

export function DevtoolsPanel() {
  const { client, connected } = useHdc();
  const [sockets, setSockets] = useState<DevtoolsSocket[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [mapping, setMapping] = useState<string | null>(null);
  const [mapped, setMapped] = useState<MappedDevtools | null>(null);
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<DevtoolsBridgeStatus | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const sessionRef = useRef<MappedDevtools | null>(null);
  const operationRef = useRef(0);

  const closeMapped = useCallback(async () => {
    const current = sessionRef.current;
    sessionRef.current = null;
    setMapped(null);
    setActiveTargetId(null);
    setBridgeStatus(null);
    setFullscreen(false);
    if (current) {
      await current.forward.close().catch(() => {});
    }
  }, []);

  const scan = useCallback(async () => {
    if (!connected) {
      return;
    }
    setScanning(true);
    setError(null);
    try {
      const result = await client.exec(DEVTOOLS_SOCKET_COMMAND, { timeout: 15_000 });
      setSockets(parseDevtoolsSockets(cleanTerminalText(result.stdout)));
    } catch (event) {
      setSockets(null);
      setError(`扫描 WebView 调试端口失败 · ${formatError(event)}`);
    } finally {
      setScanning(false);
    }
  }, [client, connected]);

  useEffect(() => {
    if (connected) {
      void scan();
    } else {
      operationRef.current += 1;
      setSockets(null);
      setError(null);
      void closeMapped();
    }
  }, [closeMapped, connected, scan]);

  useEffect(
    () => () => {
      operationRef.current += 1;
      const current = sessionRef.current;
      sessionRef.current = null;
      if (current) {
        void current.forward.close().catch(() => {});
      }
    },
    [],
  );

  const mapSocket = useCallback(
    async (socket: DevtoolsSocket) => {
      const operation = operationRef.current + 1;
      operationRef.current = operation;
      setMapping(socket.name);
      setError(null);
      setBridgeStatus(null);
      await closeMapped();
      let forward: HdcForward | null = null;
      try {
        forward = await client.forward(`localabstract:${socket.name}`, {
          timeout: 15_000,
          highWaterMark: 32 * 1024 * 1024,
        });
        const targets = await readTargets(forward);
        if (targets.length === 0) {
          throw new Error('该 WebView 当前没有可调试页面');
        }
        const version = await readJson(forward, '/json/version')
          .then(parseDevtoolsVersion)
          .catch(() => null);
        if (operationRef.current !== operation) {
          await forward.close().catch(() => {});
          return;
        }
        const session = { socket, forward, targets, version };
        sessionRef.current = session;
        setMapped(session);
        setActiveTargetId(targets[0]?.id ?? null);
      } catch (event) {
        await forward?.close().catch(() => {});
        if (operationRef.current === operation) {
          setError(`映射 ${socket.name} 失败 · ${formatError(event)}`);
        }
      } finally {
        if (operationRef.current === operation) {
          setMapping(null);
        }
      }
    },
    [client, closeMapped],
  );

  const stopMapping = useCallback(() => {
    operationRef.current += 1;
    setMapping(null);
    void closeMapped();
  }, [closeMapped]);

  const activeTarget = useMemo(
    () =>
      mapped?.targets.find((target) => target.id === activeTargetId) ?? mapped?.targets[0] ?? null,
    [activeTargetId, mapped],
  );

  const frontend = useMemo(() => {
    if (!mapped || !activeTarget) {
      return null;
    }
    try {
      return { url: resolveDevtoolsFrontendUrl(activeTarget, mapped.version), error: null };
    } catch (event) {
      return { url: null, error: formatError(event) };
    }
  }, [activeTarget, mapped]);

  const selectTarget = (id: string) => {
    setBridgeStatus(null);
    setActiveTargetId(id);
  };

  // 伪全屏期间锁定页面滚动，并允许 Esc 退出；
  // iframe 聚焦时 Esc 留给 DevTools 自身（抽屉开关），需用标题栏按钮退出。
  useEffect(() => {
    if (!fullscreen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [fullscreen]);

  return (
    <div className={styles.page}>
      <Panel
        kicker="WEBVIEW DEBUGGING"
        title="调试端口"
        extra={
          <button
            type="button"
            className={`${shared.button} ${shared.buttonSecondary}`}
            onClick={() => void scan()}
            disabled={!connected || scanning || mapping !== null}
          >
            {scanning ? '扫描中…' : '重新扫描'}
          </button>
        }
      >
        <div className={styles.commandFlow} aria-label="端口映射流程">
          <div className={styles.commandStep}>
            <span>1</span>
            <div>
              <strong>发现 socket</strong>
              <code>{DEVTOOLS_SOCKET_COMMAND}</code>
            </div>
          </div>
          <i aria-hidden="true">→</i>
          <div className={styles.commandStep}>
            <span>2</span>
            <div>
              <strong>WebHDC 虚拟映射</strong>
              <code>
                hdc fport tcp:9222 localabstract:
                {mapped?.socket.name ?? 'webview_devtools_remote_&lt;PID&gt;'}
              </code>
            </div>
          </div>
          <i aria-hidden="true">→</i>
          <div className={styles.commandStep}>
            <span>3</span>
            <div>
              <strong>CDP bridge</strong>
              <code>iframe ⇄ MessageChannel ⇄ HDC</code>
            </div>
          </div>
        </div>

        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.socketList}>
          {scanning && !sockets ? (
            <p className={styles.empty}>正在读取 /proc/net/unix…</p>
          ) : sockets && sockets.length > 0 ? (
            sockets.map((socket) => {
              const isMapped = mapped?.socket.name === socket.name;
              const isMapping = mapping === socket.name;
              return (
                <div
                  key={socket.name}
                  className={`${styles.socketRow} ${isMapped ? styles.selected : ''}`}
                >
                  <div className={styles.socketMeta}>
                    <span className={styles.socketDot} aria-hidden="true" />
                    <div>
                      <strong>{socketTitle(socket)}</strong>
                      <code title={socket.raw}>{socket.name}</code>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`${shared.button} ${isMapped ? shared.buttonSecondary : shared.buttonPrimary}`}
                    onClick={() => (isMapped ? stopMapping() : void mapSocket(socket))}
                    disabled={mapping !== null && !isMapping}
                  >
                    {isMapping ? '映射中…' : isMapped ? '停止映射' : '打开 DevTools'}
                  </button>
                </div>
              );
            })
          ) : sockets ? (
            <div className={styles.empty}>
              <strong>没有发现 WebView 调试 socket</strong>
              <span>请确认应用中的 WebView 已开启调试并保持页面运行。</span>
            </div>
          ) : (
            <p className={styles.empty}>—</p>
          )}
        </div>
      </Panel>

      {mapped && activeTarget && (
        <section
          className={`${styles.viewer} ${fullscreen ? styles.viewerFullscreen : ''}`.trim()}
          aria-label="WebView DevTools"
        >
          <header className={styles.viewerHeader}>
            <div className={styles.targetTabs} role="tablist" aria-label="可调试页面">
              {mapped.targets.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  role="tab"
                  aria-selected={target.id === activeTarget.id}
                  className={`${styles.targetTab} ${target.id === activeTarget.id ? styles.targetTabActive : ''}`}
                  onClick={() => selectTarget(target.id)}
                  title={target.url || target.title}
                >
                  <span>{targetTitle(target)}</span>
                  <small>{target.type}</small>
                </button>
              ))}
            </div>
            <div className={styles.viewerSide}>
              <div className={styles.bridgeState} data-state={bridgeStatus?.state ?? 'loading'}>
                <span aria-hidden="true" />
                {bridgeStatus?.message ?? '准备 DevTools frontend…'}
              </div>
              <button
                type="button"
                className={styles.viewerAction}
                onClick={() => setFullscreen((value) => !value)}
                title={fullscreen ? '退出全屏（Esc）' : '全屏显示'}
                aria-label={fullscreen ? '退出全屏' : '全屏显示 DevTools'}
                aria-pressed={fullscreen}
              >
                {fullscreen ? <CompressIcon /> : <ExpandIcon />}
              </button>
            </div>
          </header>
          {frontend?.url ? (
            <DevtoolsFrame
              forward={mapped.forward}
              target={activeTarget}
              frontendUrl={frontend.url}
              onStatus={setBridgeStatus}
            />
          ) : (
            <div className={styles.frameError}>
              <strong>无法启动 DevTools frontend</strong>
              <span>{frontend?.error ?? '设备没有返回前端地址'}</span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
