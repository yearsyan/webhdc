import { useState, type ChangeEvent, type FormEvent } from 'react';
import type { HdcProgress } from '@webhdc/core';
import { useHdc } from '../hdc/HdcProvider';
import { formatBytes, formatError, joinRemotePath } from '../utils/format';
import { Panel } from './Panel';
import shared from '../styles/shared.module.css';
import styles from './TransferPanel.module.css';

export function TransferPanel({ className }: { className?: string }) {
  const { client, connected } = useHdc();
  const [file, setFile] = useState<File | null>(null);
  const [uploadPath, setUploadPath] = useState('/data/local/tmp/');
  const [downloadPath, setDownloadPath] = useState('/data/local/tmp/');
  const [busy, setBusy] = useState<'upload' | 'download' | null>(null);
  const [progress, setProgress] = useState<HdcProgress | null>(null);
  const [statusText, setStatusText] = useState('尚无传输任务');

  const percent = progress ? Math.round(Math.min(1, Math.max(0, progress.ratio)) * 100) : 0;

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    setFile(picked);
    if (picked && uploadPath.trimEnd().endsWith('/')) {
      setUploadPath(joinRemotePath(uploadPath, picked.name));
    }
  };

  const handleUpload = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) {
      setStatusText('请先选择一个本地文件');
      return;
    }
    setBusy('upload');
    setProgress(null);
    setStatusText('正在建立上传通道…');
    try {
      const result = await client.sendFile(file, uploadPath, {
        onProgress: setProgress,
      });
      setProgress({ transferred: result.size, total: result.size, ratio: 1 });
      setStatusText(`上传完成 · ${formatBytes(result.size)} → ${result.remotePath}`);
    } catch (error) {
      setStatusText(`上传失败 · ${formatError(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleDownload = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('download');
    setProgress(null);
    setStatusText('正在建立下载通道…');
    try {
      const result = await client.receiveFile(downloadPath, {
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
      setProgress({ transferred: result.size, total: result.size, ratio: 1 });
      setStatusText(`下载完成 · ${result.name} · ${formatBytes(result.size)}`);
    } catch (error) {
      setStatusText(`下载失败 · ${formatError(error)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel kicker="FILE TRANSFER" title="文件传输" className={className}>
      <div className={styles.columns}>
        <form className={styles.form} onSubmit={handleUpload}>
          <h3>上传到设备</h3>{' '}
          <label
            className={`${shared.filePicker} ${!connected || busy ? shared.filePickerDisabled : ''}`.trim()}
          >
            <input type="file" onChange={handleFileChange} disabled={!connected || busy !== null} />
            <span className={shared.fileName}>
              {file ? `${file.name} · ${formatBytes(file.size)}` : '选择本地文件'}
            </span>
            <strong>＋</strong>
          </label>
          <label className={shared.field}>
            <span>远端路径</span>
            <input
              value={uploadPath}
              onChange={(event) => setUploadPath(event.target.value)}
              spellCheck={false}
              disabled={!connected || busy !== null}
            />
          </label>
          <button
            className={`${shared.button} ${shared.buttonSecondary}`}
            type="submit"
            disabled={!connected || busy !== null}
          >
            {busy === 'upload' ? '上传中…' : '上传'}
          </button>
        </form>

        <form className={styles.form} onSubmit={handleDownload}>
          <h3>从设备下载</h3>
          <label className={shared.field}>
            <span>远端文件</span>
            <input
              value={downloadPath}
              onChange={(event) => setDownloadPath(event.target.value)}
              spellCheck={false}
              disabled={!connected || busy !== null}
            />
          </label>
          <p>文件将由浏览器保存到默认下载目录。</p>
          <button
            className={`${shared.button} ${shared.buttonSecondary}`}
            type="submit"
            disabled={!connected || busy !== null}
          >
            {busy === 'download' ? '下载中…' : '下载'}
          </button>
        </form>
      </div>

      <div className={shared.progressTrack} aria-hidden="true">
        <span className={shared.progressBar} style={{ width: `${percent}%` }} />
      </div>
      <p className={styles.status}>{statusText}</p>
    </Panel>
  );
}
