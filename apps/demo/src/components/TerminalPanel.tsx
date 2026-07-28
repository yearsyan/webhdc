import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type IDisposable } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { MESSAGE_LEVEL, type HdcMessage, type HdcShell } from '@webhdc/core';
import { useHdc } from '../hdc/HdcProvider';
import { formatError } from '../utils/format';
import { Panel } from './Panel';
import shared from '../styles/shared.module.css';
import styles from './TerminalPanel.module.css';

type Mode = 'exec' | 'shell';

const TERMINAL_THEME = {
  background: '#12151a',
  foreground: '#d8dee7',
  cursor: '#539bf5',
  cursorAccent: '#12151a',
  selectionBackground: 'rgba(83, 155, 245, 0.3)',
  black: '#1c2128',
  red: '#f47067',
  green: '#57ab5a',
  yellow: '#c69026',
  blue: '#539bf5',
  magenta: '#b083f0',
  cyan: '#39c5cf',
  white: '#909dab',
  brightBlack: '#636e7b',
  brightRed: '#ff938a',
  brightGreen: '#6bc46d',
  brightYellow: '#daaa3f',
  brightBlue: '#76a8ff',
  brightMagenta: '#c297ff',
  brightCyan: '#56d4dd',
  brightWhite: '#cdd9e5',
};

export function TerminalPanel({ className }: { className?: string }) {
  const { client, connected } = useHdc();
  const [mode, setMode] = useState<Mode>('exec');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const shellRef = useRef<HdcShell | null>(null);
  const stdinRef = useRef<IDisposable | null>(null);
  const lastByteRef = useRef(0x0a);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const draftRef = useRef('');

  // 初始化 xterm 实例
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      disableStdin: true,
      fontFamily:
        'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.45,
      scrollback: 8000,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        // 容器尚未完成布局时忽略
      }
    };
    safeFit();
    const observer = new ResizeObserver(safeFit);
    observer.observe(container);
    termRef.current = term;
    term.writeln('\x1b[2mHDC WebUSB console ready.\x1b[0m');
    term.writeln('\x1b[2m「命令」执行一次性指令；「交互」打开完整 shell。\x1b[0m');
    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  const write = useCallback((data: string | Uint8Array) => {
    termRef.current?.write(data);
  }, []);

  const writeLine = useCallback((line = '') => write(`${line}\r\n`), [write]);

  const showMessage = useCallback(
    (message: HdcMessage) => {
      if (message.level === MESSAGE_LEVEL.FAIL) {
        writeLine(`\x1b[31m[Fail]\x1b[0m ${message.text}`);
      } else if (message.level === MESSAGE_LEVEL.INFO) {
        writeLine(`\x1b[2m[Info] ${message.text}\x1b[0m`);
      } else {
        writeLine(message.text);
      }
    },
    [writeLine],
  );

  const detachShellStdin = useCallback(() => {
    stdinRef.current?.dispose();
    stdinRef.current = null;
    const term = termRef.current;
    if (term) {
      term.options.disableStdin = true;
    }
  }, []);

  // 设备断开后回收交互 shell，并回到命令模式
  useEffect(() => {
    if (connected) {
      return;
    }
    const shell = shellRef.current;
    shellRef.current = null;
    detachShellStdin();
    setMode('exec');
    void shell?.close().catch(() => {});
  }, [connected, detachShellStdin]);

  const handleShellClosed = useCallback(
    (shell: HdcShell, error?: unknown) => {
      if (shellRef.current !== shell) {
        return;
      }
      shellRef.current = null;
      detachShellStdin();
      setMode('exec');
      if (error) {
        writeLine(`\x1b[31m[Error]\x1b[0m ${formatError(error)}`);
      } else {
        writeLine('\x1b[2m[ shell 已关闭 ]\x1b[0m');
      }
    },
    [detachShellStdin, writeLine],
  );

  const switchMode = async (next: Mode) => {
    if (next === mode || !connected || busy) {
      return;
    }
    const term = termRef.current;
    if (!term) {
      return;
    }
    setBusy(true);
    try {
      if (next === 'shell') {
        writeLine('\x1b[2mOpening interactive shell…\x1b[0m');
        const shell = await client.openShell({
          onData: (data) => termRef.current?.write(data),
          onMessage: showMessage,
        });
        shellRef.current = shell;
        term.options.disableStdin = false;
        stdinRef.current = term.onData((data) => {
          void shell.writeText(data).catch(() => {});
        });
        shell.closed.then(
          () => handleShellClosed(shell),
          (error) => handleShellClosed(shell, error),
        );
        term.focus();
      } else {
        const shell = shellRef.current;
        shellRef.current = null;
        detachShellStdin();
        await shell?.close().catch(() => {});
      }
      setMode(next);
    } catch (error) {
      writeLine(`\x1b[31m[Error]\x1b[0m ${formatError(error)}`);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const runCommand = async (event: FormEvent) => {
    event.preventDefault();
    const command = input.trim();
    if (!command) {
      return;
    }
    setInput('');
    historyRef.current.push(command);
    historyIndexRef.current = -1;
    draftRef.current = '';
    write(`\x1b[1;34m$\x1b[0m \x1b[1m${command}\x1b[0m\r\n`);
    setBusy(true);
    lastByteRef.current = 0x0a;
    try {
      await client.exec(command, {
        onOutput: (data) => {
          if (data.length > 0) {
            lastByteRef.current = data[data.length - 1];
          }
          write(data);
        },
        onMessage: showMessage,
      });
      if (lastByteRef.current !== 0x0a) {
        write('\r\n');
      }
    } catch (error) {
      writeLine(`\x1b[31m[Error]\x1b[0m ${formatError(error)}`);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const history = historyRef.current;
    if (event.key === 'ArrowUp' && history.length > 0) {
      event.preventDefault();
      if (historyIndexRef.current === -1) {
        draftRef.current = input;
        historyIndexRef.current = history.length - 1;
      } else {
        historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
      }
      setInput(history[historyIndexRef.current]);
    } else if (event.key === 'ArrowDown' && historyIndexRef.current !== -1) {
      event.preventDefault();
      historyIndexRef.current += 1;
      if (historyIndexRef.current >= history.length) {
        historyIndexRef.current = -1;
        setInput(draftRef.current);
      } else {
        setInput(history[historyIndexRef.current]);
      }
    }
  };

  return (
    <Panel
      tone="terminal"
      kicker="TERMINAL"
      title="远程终端"
      className={className}
      extra={
        <div className={styles.segmented} role="group" aria-label="终端模式">
          {(['exec', 'shell'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`${styles.seg} ${mode === item ? styles.segActive : ''}`.trim()}
              onClick={() => switchMode(item)}
              disabled={!connected || busy}
            >
              {item === 'exec' ? '命令' : '交互'}
            </button>
          ))}
        </div>
      }
    >
      <div className={styles.viewport}>
        <div ref={containerRef} className={styles.termHost} />
      </div>
      {mode === 'exec' ? (
        <form className={styles.inputRow} onSubmit={runCommand}>
          <span className={styles.prompt} aria-hidden="true">
            $
          </span>
          <input
            ref={inputRef}
            className={styles.commandInput}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={connected ? '输入命令，回车执行（↑↓ 翻阅历史）' : '连接设备后可执行命令'}
            autoComplete="off"
            spellCheck={false}
            disabled={!connected}
          />
          <button
            className={`${shared.button} ${shared.buttonPrimary}`}
            type="submit"
            disabled={!connected || busy || !input.trim()}
          >
            {busy ? '执行中…' : '运行'}
          </button>
          <button
            className={styles.ghostDark}
            type="button"
            onClick={() => termRef.current?.clear()}
          >
            清屏
          </button>
        </form>
      ) : (
        <div className={styles.shellHint}>
          交互模式：直接在上方终端中键入；输入 <code>exit</code> 或切回「命令」结束会话。
        </div>
      )}
    </Panel>
  );
}
