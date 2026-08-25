import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createSSEClient, type SSEClient } from "./sseClient";
import type { ConnectionSnapshot, TopicName, TopicSnapshot } from "./types";

const SSEClientContext = createContext<SSEClient | null>(null);

// One client for the whole app (Task 4 deliverable C: "ONE EventSource per
// app"). Built lazily at module scope rather than at import time, so tests
// that construct their own SSEProvider client={...} never touch this.
let appClient: SSEClient | null = null;
function getAppClient(): SSEClient {
  if (!appClient) appClient = createSSEClient();
  return appClient;
}

export interface SSEProviderProps {
  /** Test seam — a client built with fakes; the real app never passes this. */
  client?: SSEClient;
  children: ReactNode;
}

export function SSEProvider({ client, children }: SSEProviderProps) {
  const value = useMemo(() => client ?? getAppClient(), [client]);
  return <SSEClientContext.Provider value={value}>{children}</SSEClientContext.Provider>;
}

function useSSEClient(): SSEClient {
  const client = useContext(SSEClientContext);
  if (!client) {
    throw new Error("useTopic/useSnapshot/useConnectionState must be used within <SSEProvider>");
  }
  return client;
}

// useTopic registers this component as a subscriber to `topic` for as long
// as it stays mounted — the client ref-counts subscribers per topic and
// rebuilds the single app-wide EventSource from the union of active topics
// (see sseClient.ts). Multiple components subscribing to the same topic
// share one connection, matching the hub's own "one poll per topic"
// principle (02-hub-sse.md) on the client side.
export function useTopic(topic: TopicName): void {
  const client = useSSEClient();
  useEffect(() => client.subscribeTopic(topic), [client, topic]);
}

// useSnapshot subscribes to `topic` (equivalent to useTopic) and returns its
// current snapshot, re-rendering only this component when that topic
// changes (useSyncExternalStore — no context re-render, no state library).
export function useSnapshot<T = unknown>(topic: TopicName): TopicSnapshot<T> {
  const client = useSSEClient();
  useTopic(topic);
  return useSyncExternalStore(
    useCallback((cb) => client.subscribeTopicListener(topic, cb), [client, topic]),
    useCallback(() => client.getTopicSnapshot<T>(topic), [client, topic]),
  );
}

// useConnectionState exposes the shared connection's status/staleness plus
// a manual retry() action for a visible "reconnecting" UI (Task 4 deliverable C).
export function useConnectionState(): ConnectionSnapshot & { retry: () => void } {
  const client = useSSEClient();
  const state = useSyncExternalStore(
    useCallback((cb) => client.subscribeConnectionListener(cb), [client]),
    useCallback(() => client.getConnectionSnapshot(), [client]),
  );
  const retry = useCallback(() => client.retry(), [client]);
  return { ...state, retry };
}

// useRefreshTopic exposes SSEClient.refreshTopic — a stable per-topic
// "refresh now" function, bound to the app-wide client. Mutation success
// handlers (People's create/edit/delete/enable/rotate-secret/reset-quota/
// sublink-regenerate) call `refreshTopic('users')` so the affected topic
// doesn't sit on its own poll interval before the change is visible.
export function useRefreshTopic(): (topic: TopicName) => Promise<void> {
  const client = useSSEClient();
  return useCallback((topic: TopicName) => client.refreshTopic(topic), [client]);
}

// resetSSEClient clears the app-wide client's cached data and closes its
// connection — called from useLogout so no session-scoped realtime data
// survives into the next login (deliverable A: "logout clears client state
// and SSE").
export function resetSSEClient(): void {
  getAppClient().reset();
}
