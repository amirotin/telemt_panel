import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';

interface ServerMessage {
  type: 'data' | 'error';
  endpoint: string;
  data?: unknown;
  error?: string;
  timestamp: number;
}

type DataMap = Record<string, unknown>;
type ErrorMap = Record<string, string>;
type Subscriber = { endpoints: string[]; interval: number };

interface WsContextValue {
  data: DataMap;
  errors: ErrorMap;
  connected: boolean;
  subscribe: (id: string, endpoints: string[], interval?: number) => void;
  unsubscribe: (id: string) => void;
  refresh: () => void;
}

export const WsContext = createContext<WsContextValue>({
  data: {},
  errors: {},
  connected: false,
  subscribe: () => {},
  unsubscribe: () => {},
  refresh: () => {},
});

export function useWsProvider(): WsContextValue {
  const [data, setData] = useState<DataMap>({});
  const [errors, setErrors] = useState<ErrorMap>({});
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const subscribers = useRef<Map<string, Subscriber>>(new Map());

  const getAggregated = useCallback(() => {
    const endpointIntervals = new Map<string, number>();
    for (const sub of subscribers.current.values()) {
      for (const ep of sub.endpoints) {
        const existing = endpointIntervals.get(ep);
        if (!existing || sub.interval < existing) {
          endpointIntervals.set(ep, sub.interval);
        }
      }
    }
    return endpointIntervals;
  }, []);

  const sendSubscriptions = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;

    const agg = getAggregated();
    if (agg.size === 0) return;

    // Group by interval
    const byInterval = new Map<number, string[]>();
    for (const [ep, interval] of agg) {
      const list = byInterval.get(interval) || [];
      list.push(ep);
      byInterval.set(interval, list);
    }

    // Send subscription for the smallest interval with all endpoints
    // (server handles one subscription at a time, so merge into one)
    const allEndpoints = [...agg.keys()];
    const minInterval = Math.min(...agg.values());

    ws.send(JSON.stringify({
      type: 'subscribe',
      endpoints: allEndpoints,
      interval: minInterval,
    }));
  }, [getAggregated]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = (window as any).__BASE_PATH__ || '';
    const ws = new WebSocket(`${proto}//${window.location.host}${base}/api/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      sendSubscriptions();
    };

    ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      if (msg.type === 'data') {
        setData(prev => ({ ...prev, [msg.endpoint]: msg.data }));
        setErrors(prev => {
          if (!prev[msg.endpoint]) return prev;
          const next = { ...prev };
          delete next[msg.endpoint];
          return next;
        });
      } else if (msg.type === 'error') {
        setErrors(prev => ({ ...prev, [msg.endpoint]: msg.error || 'unknown error' }));
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();
  }, [sendSubscriptions]);

  // Connect once on mount
  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const subscribe = useCallback((id: string, endpoints: string[], interval = 5) => {
    subscribers.current.set(id, { endpoints, interval });
    sendSubscriptions();
  }, [sendSubscriptions]);

  const unsubscribe = useCallback((id: string) => {
    subscribers.current.delete(id);
    sendSubscriptions();
  }, [sendSubscriptions]);

  const refresh = useCallback(() => {
    sendSubscriptions();
  }, [sendSubscriptions]);

  return { data, errors, connected, subscribe, unsubscribe, refresh };
}

// Hook for pages to subscribe to specific endpoints
export function useWsSubscription(id: string, endpoints: string[], interval = 5) {
  const ctx = useContext(WsContext);
  const endpointsKey = endpoints.join(',');

  useEffect(() => {
    ctx.subscribe(id, endpoints, interval);
    return () => ctx.unsubscribe(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, endpointsKey, interval]);

  return {
    data: ctx.data,
    errors: ctx.errors,
    connected: ctx.connected,
    refresh: ctx.refresh,
  };
}

// Helper to get typed data from the map
export function useEndpoint<T>(dataMap: DataMap, endpoint: string): T | null {
  return (dataMap[endpoint] as T) ?? null;
}
