import { useEffect, useState } from 'react';

export type TabId = 'terminal' | 'files' | 'transfer' | 'screenshot' | 'apps';

export interface TabDef {
  id: TabId;
  hash: string;
  label: string;
  desc: string;
}

export const TABS: readonly TabDef[] = [
  { id: 'terminal', hash: '#/terminal', label: '终端', desc: '一次性命令与交互式 Shell' },
  {
    id: 'files',
    hash: '#/files',
    label: '文件浏览',
    desc: '浏览设备文件系统，进入目录、下载与删除',
  },
  {
    id: 'transfer',
    hash: '#/transfer',
    label: '文件传输',
    desc: '向设备发送文件，或从设备下载文件',
  },
  {
    id: 'screenshot',
    hash: '#/screenshot',
    label: '屏幕截图',
    desc: '抓取设备屏幕画面，预览并下载',
  },
  { id: 'apps', hash: '#/apps', label: '应用管理', desc: '安装 HAP、查看已安装应用与卸载' },
];

const KNOWN_HASHES = new Map<string, TabId>(TABS.map((tab) => [tab.hash, tab.id]));

function resolveHash(hash: string): TabId {
  return KNOWN_HASHES.get(hash) ?? 'terminal';
}

export function currentTab(): TabId {
  return resolveHash(window.location.hash);
}

export function useHashRoute(): TabId {
  const [tab, setTab] = useState<TabId>(currentTab);

  useEffect(() => {
    const onHashChange = () => setTab(currentTab());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return tab;
}
