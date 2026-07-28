import type { ReactNode } from 'react';
import styles from './Panel.module.css';

interface PanelProps {
  kicker: string;
  title: string;
  extra?: ReactNode;
  tone?: 'default' | 'terminal';
  className?: string;
  children: ReactNode;
}

export function Panel({ kicker, title, extra, tone = 'default', className, children }: PanelProps) {
  const toneClass = tone === 'terminal' ? styles.panelTerminal : '';
  return (
    <article className={`${styles.panel} ${toneClass} ${className ?? ''}`.trim()}>
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>{kicker}</p>
          <h2>{title}</h2>
        </div>
        {extra}
      </div>
      {children}
    </article>
  );
}
