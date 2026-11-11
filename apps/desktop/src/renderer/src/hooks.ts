import { useCallback, useEffect, useState } from 'react';
import type { Settings, SystemStatus } from '@rec-it/ipc-contract';
import { backend } from './api';

export function useBackendConnection(): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => backend.onConnectionChange(setConnected), []);
  return connected;
}

/** Live system status: fetched on connect, then kept current by statusChanged events. */
export function useSystemStatus(): {
  status: SystemStatus | null;
  refresh: () => Promise<void>;
  refreshing: boolean;
} {
  const connected = useBackendConnection();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => backend.on('system.statusChanged', setStatus), []);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void backend.invoke('system.getStatus', {}).then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [connected]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setStatus(await backend.invoke('system.refresh', {}));
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { status, refresh, refreshing };
}

export function useSettings(): {
  settings: Settings | null;
  update: (patch: Partial<Settings>) => Promise<void>;
} {
  const connected = useBackendConnection();
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => backend.on('settings.changed', setSettings), []);
  useEffect(() => {
    if (connected) void backend.invoke('settings.get', {}).then(setSettings);
  }, [connected]);
  const update = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await backend.invoke('settings.update', patch));
  }, []);
  return { settings, update };
}

/** Round-trip time to the backend, measured every 10 s while connected. */
export function useBackendLatency(): number | null {
  const connected = useBackendConnection();
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const measure = async () => {
      const sentAt = performance.now();
      try {
        await backend.invoke('app.ping', { sentAt: Date.now() });
        if (!cancelled) setMs(performance.now() - sentAt);
      } catch {
        if (!cancelled) setMs(null);
      }
    };
    void measure();
    const timer = setInterval(() => void measure(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connected]);
  return connected ? ms : null;
}
