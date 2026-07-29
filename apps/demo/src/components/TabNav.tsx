import { TABS, type TabId } from '../router';
import styles from './TabNav.module.css';

function TabIcon({ id }: { id: TabId }) {
  switch (id) {
    case 'terminal':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="4 6 10 12 4 18" />
          <line x1="13" y1="18" x2="20" y2="18" />
        </svg>
      );
    case 'files':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
        </svg>
      );
    case 'transfer':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M7.5 4v13" />
          <polyline points="4 7.5 7.5 4 11 7.5" />
          <path d="M16.5 20V7" />
          <polyline points="13 16.5 16.5 20 20 16.5" />
        </svg>
      );
    case 'apps':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4" y="4" width="6.5" height="6.5" rx="1.4" />
          <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4" />
          <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4" />
          <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4" />
        </svg>
      );
  }
}

export function TabNav({ active }: { active: TabId }) {
  return (
    <nav className={styles.tabs} aria-label="功能导航">
      <div className={styles.track} role="tablist">
        {TABS.map((tab) => (
          <a
            key={tab.id}
            role="tab"
            aria-selected={active === tab.id}
            href={tab.hash}
            title={tab.desc}
            className={`${styles.tab} ${active === tab.id ? styles.active : ''}`.trim()}
          >
            <span className={styles.icon}>
              <TabIcon id={tab.id} />
            </span>
            <span className={styles.label}>{tab.label}</span>
          </a>
        ))}
      </div>
    </nav>
  );
}
