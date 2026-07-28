import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { HdcProgress } from '@webhdc/core';
import { useHdc } from '../hdc/HdcProvider';
import { cleanTerminalText, formatBytes, formatError, joinRemotePath } from '../utils/format';
import { Panel } from './Panel';
import shared from '../styles/shared.module.css';
import styles from './InstallPanel.module.css';

type Stage = 'idle' | 'uploading' | 'installing' | 'cleaning' | 'done' | 'error';

type LogKind = 'info' | 'ok' | 'err';

interface LogLine {
  id: number;
  kind: LogKind;
  text: string;
}

const KIND_CLASS: Record<LogKind, string> = {
  info: styles.info,
  ok: styles.ok,
  err: styles.err,
};

export function InstallPanel({ className }: { className?: string }) {
  const { client, connected } = useHdc();
  const [file, setFile] = useState<File | null>(null);
  const [remoteDir, setRemoteDir] = useState('/data/local/tmp/');
  const [cleanup, setCleanup] = useState(true);
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState<HdcProgress | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logIdRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  const busy = stage === 'uploading' || stage === 'installing' || stage === 'cleaning';
  const percent =
    stage === 'uploading' && progress
      ? Math.round(Math.min(1, Math.max(0, progress.ratio)) * 100)
      : 0;

  useEffect(() => {
    const element = logRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [logs]);

  const log = (kind: LogKind, text: string) => {
    setLogs((prev) => [...prev.slice(-199), { id: ++logIdRef.current, kind, text }]);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    if (picked && !picked.name.toLowerCase().endsWith('.hap')) {
      log('err', `${picked.name} 不是 .hap 包`);
      setFile(null);
      event.target.value = '';
      return;
    }
    setFile(picked);
  };

  const install = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) {
      log('err', '请先选择 .hap 安装包');
      return;
    }
    const remotePath = joinRemotePath(remoteDir, file.name);
    setLogs([]);
    setProgress(null);
    setStage('uploading');
    try {
      log('info', `① 上传 ${file.name}（${formatBytes(file.size)}）→ ${remotePath}`);
      await client.sendFile(file, remotePath, {
        timeout: 300_000,
        onProgress: setProgress,
      });
      log('ok', '上传完成');

      setStage('installing');
      log('info', `② 执行 bm install -p "${remotePath}"`);
      const result = await client.exec(`bm install -p "${remotePath}"`, {
        timeout: 120_000,
      });
      const output = cleanTerminalText(result.stdout).trim();
      if (output) {
        log('info', output);
      }
      if (/success/iu.test(output)) {
        log('ok', '安装成功 ✔');
      } else {
        log('err', '未在安装输出中确认成功，请检查上方日志');
      }

      if (cleanup) {
        setStage('cleaning');
        await client.exec(`rm -f "${remotePath}"`).catch(() => {});
        log('info', '③ 已删除远端安装包');
      }
      setStage('done');
    } catch (error) {
      log('err', `安装失败 · ${formatError(error)}`);
      setStage('error');
    } finally {
      setProgress(null);
    }
  };

  return (
    <Panel
      kicker="APP INSTALL"
      title="安装 HAP"
      className={className}
      extra={<span className={`${shared.badge} ${shared.badgeOutline}`}>bm</span>}
    >
      <form className={styles.form} onSubmit={install}>
        <label
          className={`${shared.filePicker} ${!connected || busy ? shared.filePickerDisabled : ''}`.trim()}
        >
          <input
            type="file"
            accept=".hap"
            onChange={handleFileChange}
            disabled={!connected || busy}
          />
          <span className={shared.fileName}>
            {file ? `${file.name} · ${formatBytes(file.size)}` : '选择 .hap 安装包'}
          </span>
          <strong>＋</strong>
        </label>

        <label className={shared.field}>
          <span>推送目录</span>
          <input
            value={remoteDir}
            onChange={(event) => setRemoteDir(event.target.value)}
            spellCheck={false}
            disabled={!connected || busy}
          />
        </label>

        <label className={styles.check}>
          <input
            type="checkbox"
            checked={cleanup}
            onChange={(event) => setCleanup(event.target.checked)}
            disabled={busy}
          />
          安装完成后删除远端安装包
        </label>

        <button
          className={`${shared.button} ${shared.buttonPrimary} ${styles.submit}`}
          type="submit"
          disabled={!connected || busy || !file}
        >
          {stage === 'uploading'
            ? `上传中 ${percent}%`
            : stage === 'installing'
              ? '安装中…'
              : stage === 'cleaning'
                ? '清理中…'
                : '安装'}
        </button>
      </form>

      <div className={shared.progressTrack} aria-hidden="true">
        <span
          className={shared.progressBar}
          style={{ width: stage === 'uploading' ? `${percent}%` : '0%' }}
        />
      </div>

      {logs.length > 0 && (
        <div ref={logRef} className={styles.log} role="log" aria-live="polite">
          {logs.map((line) => (
            <div key={line.id} className={KIND_CLASS[line.kind]}>
              {line.text}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
