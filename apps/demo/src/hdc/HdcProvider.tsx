import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { HdcClient, type HdcDeviceInfo, type HdcStatus, type HdcStatusState } from '@webhdc/core';

interface HdcContextValue {
  client: HdcClient;
  status: HdcStatus;
  device: HdcDeviceInfo | null;
  connected: boolean;
  connecting: boolean;
  connect: () => Promise<HdcDeviceInfo>;
  disconnect: () => Promise<void>;
}

const HdcContext = createContext<HdcContextValue | null>(null);

const IDLE_STATUS: HdcStatus = { state: 'disconnected', message: '等待连接' };

const CONNECTING_STATES: ReadonlySet<HdcStatusState> = new Set([
  'opening',
  'handshake',
  'authorizing',
  'authorization-required',
]);

export function HdcProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new HdcClient({
        logger(level, message, detail) {
          if (level === 'error') {
            console.error(`[hdc] ${message}`, detail ?? '');
          } else if (level === 'info') {
            console.info(`[hdc] ${message}`, detail ?? '');
          }
        },
      }),
  );
  const [status, setStatus] = useState<HdcStatus>(IDLE_STATUS);
  const [device, setDevice] = useState<HdcDeviceInfo | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const subscriptions = [
      client.on('status', setStatus),
      client.on('connect', (info) => {
        setDevice(info);
        setConnected(true);
      }),
      client.on('disconnect', () => {
        setDevice(null);
        setConnected(false);
      }),
    ];
    return () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
    };
  }, [client]);

  const connect = useCallback(async () => {
    const authorized = await client.getDevices();
    const picked = authorized.length === 1 ? authorized[0] : await client.requestDevice();
    return client.connect(picked);
  }, [client]);

  const disconnect = useCallback(async () => {
    await client.disconnect();
  }, [client]);

  const value = useMemo<HdcContextValue>(
    () => ({
      client,
      status,
      device,
      connected,
      connecting: CONNECTING_STATES.has(status.state),
      connect,
      disconnect,
    }),
    [client, status, device, connected, connect, disconnect],
  );

  return <HdcContext.Provider value={value}>{children}</HdcContext.Provider>;
}

export function useHdc(): HdcContextValue {
  const context = useContext(HdcContext);
  if (!context) {
    throw new Error('useHdc 必须在 <HdcProvider> 内使用');
  }
  return context;
}
