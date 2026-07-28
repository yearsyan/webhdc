import { HdcProvider } from './hdc/HdcProvider';
import { DevicePanel } from './components/DevicePanel';
import { InstallPanel } from './components/InstallPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { TopBar } from './components/TopBar';
import { TransferPanel } from './components/TransferPanel';
import styles from './App.module.css';

export default function App() {
  return (
    <HdcProvider>
      <TopBar />
      <main className={styles.page}>
        <section className={styles.dashboard} aria-label="HDC 控制台">
          <TerminalPanel className={styles.terminal} />
          <DevicePanel className={styles.device} />
          <InstallPanel className={styles.install} />
          <TransferPanel className={styles.transfer} />
        </section>
        <footer className={styles.footer}>
          HDC protocol over WebUSB · 需要桌面版 Chrome / Edge 与安全上下文
        </footer>
      </main>
    </HdcProvider>
  );
}
