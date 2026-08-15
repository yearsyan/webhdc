import { useCallback, useEffect, useMemo, useRef, type SyntheticEvent } from 'react';
import type { HdcForward } from '@webhdc/core';
import { devtoolsWebSocketPath, type DevtoolsTarget } from '../devtools/discovery';
import { DevtoolsMessageBridge, type DevtoolsBridgeStatus } from '../devtools/messageBridge';
import styles from './DevtoolsPanel.module.css';

interface DevtoolsFrameProps {
  forward: HdcForward;
  target: DevtoolsTarget;
  frontendUrl: string;
  onStatus: (status: DevtoolsBridgeStatus) => void;
}

function makeFrameUrl(target: DevtoolsTarget, frontendUrl: string): string {
  const frame = new URL(`${import.meta.env.BASE_URL}devtools-frame.html`, window.location.origin);
  const frontend = new URL(frontendUrl);
  frame.searchParams.set(
    'ws',
    `webhdc.invalid${devtoolsWebSocketPath(target.webSocketDebuggerUrl)}`,
  );
  for (const [name, value] of frontend.searchParams) {
    if (name !== 'ws' && name !== 'wss' && name !== 'remoteBase') {
      frame.searchParams.append(name, value);
    }
  }
  return frame.toString();
}

export function DevtoolsFrame({ forward, target, frontendUrl, onStatus }: DevtoolsFrameProps) {
  const bridgeRef = useRef<DevtoolsMessageBridge | null>(null);
  const frameUrl = useMemo(() => makeFrameUrl(target, frontendUrl), [target, frontendUrl]);

  const attach = useCallback(
    (event: SyntheticEvent<HTMLIFrameElement>) => {
      bridgeRef.current?.dispose();
      const contentWindow = event.currentTarget.contentWindow;
      if (!contentWindow) {
        onStatus({ state: 'error', message: '无法访问 DevTools iframe' });
        return;
      }
      const channel = new MessageChannel();
      bridgeRef.current = new DevtoolsMessageBridge({
        forward,
        port: channel.port1,
        targetWebSocketUrl: target.webSocketDebuggerUrl,
        // Chromium 会放行其官方托管 frontend 的远程调试 Origin。
        websocketOrigin: new URL(frontendUrl).origin,
        onStatus,
      });
      contentWindow.postMessage(
        { type: 'webhdc-devtools-init', frontendUrl },
        window.location.origin,
        [channel.port2],
      );
    },
    [forward, frontendUrl, onStatus, target.webSocketDebuggerUrl],
  );

  useEffect(
    () => () => {
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
    },
    [forward, frontendUrl, target.webSocketDebuggerUrl],
  );

  return (
    <iframe
      key={`${forward.channelId}:${target.id}:${frontendUrl}`}
      className={styles.devtoolsFrame}
      src={frameUrl}
      onLoad={attach}
      title={`DevTools · ${target.title}`}
      sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads allow-modals"
      allow="clipboard-read; clipboard-write"
      referrerPolicy="no-referrer"
    />
  );
}
