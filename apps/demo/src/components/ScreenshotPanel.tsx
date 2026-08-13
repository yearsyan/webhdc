import { useEffect, useRef, useState } from 'react';
import type { HdcProgress } from '@webhdc/core';
import { useHdc } from '../hdc/HdcProvider';
import { formatBytes, formatError } from '../utils/format';
import { Panel } from './Panel';
import shared from '../styles/shared.module.css';
import styles from './ScreenshotPanel.module.css';

interface Shot {
  url: string;
  name: string;
  size: number;
}

export function ScreenshotPanel({ className }: { className?: string }) {
  const { client, connected } = useHdc();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<HdcProgress | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [statusText, setStatusText] = useState('尚未截图');
  const shotUrlRef = useRef<string | null>(null);

  // 卸载时释放预览占用的 object URL
  useEffect(
    () => () => {
      if (shotUrlRef.current) {
        URL.revokeObjectURL(shotUrlRef.current);
      }
    },
    [],
  );

  const percent = progress ? Math.round(Math.min(1, Math.max(0, progress.ratio)) * 100) : 0;

  const capture = async () => {
    setBusy(true);
    setProgress(null);
    setStatusText('正在执行截屏命令…');
    try {
      const result = await client.captureScreenshot({
        onProgress: (event) => {
          setProgress(event);
          setStatusText('正在拉取截图…');
        },
      });
      if (result.blob) {
        if (shotUrlRef.current) {
          URL.revokeObjectURL(shotUrlRef.current);
        }
        const url = URL.createObjectURL(result.blob);
        shotUrlRef.current = url;
        setShot({ url, name: result.name, size: result.size });
      }
      setStatusText(`截图完成 · ${result.name} · ${formatBytes(result.size)}`);
    } catch (error) {
      setStatusText(`截图失败 · ${formatError(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!shot) {
      return;
    }
    const link = document.createElement('a');
    link.href = shot.url;
    link.download = shot.name;
    link.click();
  };

  return (
    <Panel
      kicker="SCREENSHOT"
      title="屏幕截图"
      className={className}
      extra={<span className={shared.badge}>{shot ? formatBytes(shot.size) : '—'}</span>}
    >
      <div className={styles.tools}>
        <button
          className={`${shared.button} ${shared.buttonPrimary}`}
          type="button"
          onClick={() => void capture()}
          disabled={!connected || busy}
        >
          {busy ? '截图中…' : '截取屏幕'}
        </button>
        <button
          className={`${shared.button} ${shared.buttonSecondary}`}
          type="button"
          onClick={download}
          disabled={!shot || busy}
        >
          下载图片
        </button>
        <p className={styles.hint}>
          通过 snapshot_display 截屏，拉取到浏览器后自动清理设备临时文件
        </p>
      </div>

      {busy && (
        <div className={shared.progressTrack} aria-hidden="true">
          <span className={shared.progressBar} style={{ width: `${percent}%` }} />
        </div>
      )}
      <p className={styles.status}>{statusText}</p>

      <div className={styles.preview}>
        {shot ? (
          <img className={styles.image} src={shot.url} alt="设备屏幕截图" />
        ) : (
          <p className={styles.placeholder}>连接设备后点击「截取屏幕」</p>
        )}
      </div>
    </Panel>
  );
}
