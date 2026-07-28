import { useEffect, useMemo, useState } from 'react';
import { HdcClient } from '@webhdc/core';
import { useHdc } from '../hdc/HdcProvider';
import { formatError } from '../utils/format';
import shared from '../styles/shared.module.css';
import styles from './TopBar.module.css';

export function TopBar() {
  const { client, status, connected, connecting, connect, disconnect } = useHdc();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => client.on('error', (event) => setError(formatError(event))), [client]);

  const supported = useMemo(() => HdcClient.isSupported(), []);
  const secure = window.isSecureContext;
  const usable = supported && secure;

  const supportNote = !supported
    ? '当前浏览器不支持 WebUSB，请使用桌面版 Chrome 或 Edge'
    : !secure
      ? 'WebUSB 需要安全上下文，请通过 localhost 或 HTTPS 打开'
      : null;

  const dotState = connected
    ? 'connected'
    : connecting
      ? 'connecting'
      : status.state === 'error'
        ? 'error'
        : 'offline';

  const handleConnect = async () => {
    setError(null);
    setBusy(true);
    try {
      await connect();
    } catch (event) {
      setError(formatError(event));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      await disconnect();
    } catch (event) {
      setError(formatError(event));
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className={styles.topbar}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>H</span>
          <span className={styles.brandText}>
            <strong>HDC WebUSB Console</strong>
            <small>浏览器直连 HarmonyOS / OpenHarmony 设备</small>
          </span>
        </div>
        <div className={styles.actions}>
          {supportNote && <span className={styles.note}>{supportNote}</span>}
          {error && (
            <span className={styles.error} title={error}>
              {error}
            </span>
          )}
          <span className={styles.statusPill}>
            <span className={styles.dot} data-state={dotState} aria-hidden="true" />
            {status.message}
          </span>
          {connected ? (
            <button
              className={`${shared.button} ${shared.buttonQuiet}`}
              type="button"
              onClick={handleDisconnect}
              disabled={busy}
            >
              断开
            </button>
          ) : (
            <button
              className={`${shared.button} ${shared.buttonPrimary}`}
              type="button"
              onClick={handleConnect}
              disabled={busy || !usable}
            >
              {connecting ? '连接中…' : '连接设备'}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
