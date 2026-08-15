import { useMemo, useState } from 'react';
import { HdcClient } from '@webhdc/core';
import { useHdc } from '../hdc/HdcProvider';
import { formatError } from '../utils/format';
import shared from '../styles/shared.module.css';
import styles from './EmptyState.module.css';

export function EmptyState() {
  const { status, connecting, connect } = useHdc();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const supported = useMemo(() => HdcClient.isSupported(), []);
  const secure = window.isSecureContext;
  const usable = supported && secure;
  const supportNote = !supported
    ? '当前浏览器不支持 WebUSB，请使用桌面版 Chrome 或 Edge'
    : !secure
      ? 'WebUSB 需要安全上下文，请通过 localhost 或 HTTPS 打开'
      : null;

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

  return (
    <section className={styles.empty} aria-label="未连接设备">
      <div className={styles.iconWrap} aria-hidden="true">
        <svg
          viewBox="0 0 48 48"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="16" y="3" width="16" height="10" rx="2" />
          <path d="M20.5 7.5h1.8M25.7 7.5h1.8" />
          <path d="M18 13v3.5a6 6 0 0 0 12 0V13" />
          <path d="M24 22.5v8a9 9 0 0 1-9 9h-1.5" />
          <circle cx="9.5" cy="39.5" r="3.2" />
        </svg>
      </div>
      <h2>未连接设备</h2>
      <p className={styles.desc}>
        通过 WebUSB 连接 HarmonyOS / OpenHarmony
        设备后，即可在上方切换终端、文件浏览、文件传输、应用管理与 WebView 调试。
      </p>
      {supportNote ? (
        <p className={styles.warn}>{supportNote}</p>
      ) : (
        <button
          className={`${shared.button} ${shared.buttonPrimary}`}
          type="button"
          onClick={handleConnect}
          disabled={busy || !usable}
        >
          {connecting || busy ? '连接中…' : '连接设备'}
        </button>
      )}
      {error && <p className={styles.error}>{error}</p>}
      {!error && status.state === 'error' && <p className={styles.error}>{status.message}</p>}
      <p className={styles.hint}>
        若 USB 接口被占用，请先退出 DevEco Studio 或执行 <code>hdc kill</code> 后重试
      </p>
    </section>
  );
}
