import type { ReactNode } from 'react';
import { HdcProvider, useHdc } from './hdc/HdcProvider';
import { TABS, useHashRoute, type TabId } from './router';
import { AppsPanel } from './components/AppsPanel';
import { EmptyState } from './components/EmptyState';
import { FileBrowserPanel } from './components/FileBrowserPanel';
import { ScreenshotPanel } from './components/ScreenshotPanel';
import { TabNav } from './components/TabNav';
import { TerminalPanel } from './components/TerminalPanel';
import { TopBar } from './components/TopBar';
import { TransferPanel } from './components/TransferPanel';
import styles from './App.module.css';

const PANELS: ReadonlyArray<{ id: TabId; render: () => ReactNode }> = [
  { id: 'terminal', render: () => <TerminalPanel /> },
  { id: 'files', render: () => <FileBrowserPanel /> },
  { id: 'transfer', render: () => <TransferPanel /> },
  { id: 'screenshot', render: () => <ScreenshotPanel /> },
  { id: 'apps', render: () => <AppsPanel /> },
];

function Workspace() {
  const active = useHashRoute();
  const { connected } = useHdc();

  return (
    <main className={styles.page}>
      <TabNav active={active} />
      {!connected && <EmptyState />}
      {/* 面板常驻挂载，仅切换显隐，保留终端回滚与文件浏览状态 */}
      <div className={`${styles.panels} ${connected ? '' : styles.gone}`.trim()}>
        {PANELS.map(({ id, render }) => {
          const label = TABS.find((tab) => tab.id === id)?.label ?? id;
          return (
            <div
              key={id}
              role="tabpanel"
              aria-label={label}
              className={active === id ? styles.panelShown : styles.gone}
            >
              {render()}
            </div>
          );
        })}
      </div>
      <footer className={styles.footer}>
        HDC protocol over WebUSB · 需要桌面版 Chrome / Edge 与安全上下文
      </footer>
    </main>
  );
}

export default function App() {
  return (
    <HdcProvider>
      <TopBar />
      <Workspace />
    </HdcProvider>
  );
}
