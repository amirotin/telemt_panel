import { useCallback, useEffect, useRef, useState } from "react";
import { createLogStream, type LogStreamClient, type LogStreamOptions, type LogStreamSnapshot } from "./logStream";
import type { LogLine } from "../lib/api/generated/types.gen";

export interface UseLogStreamResult extends LogStreamSnapshot {
  retry: () => void;
}

// useLogStream owns exactly one logStream.ts client for as long as this
// component stays mounted with the same `service`: opens on mount, closes
// on unmount, and closes + reopens whenever `service` changes (Task 7
// brief B: "on source switch → close and reopen; on tab unmount → close").
//
// Lines are pushed to the `onLine` callback rather than returned as hook
// state — LogStreamViewer owns the ring buffer via useReducer (logRing.ts),
// so a fast-moving stream doesn't force this hook's own state (and every
// consumer of its snapshot) to re-render on every single line.
export function useLogStream(
  service: string,
  onLine: (line: LogLine) => void,
  options?: LogStreamOptions,
): UseLogStreamResult {
  const [snapshot, setSnapshot] = useState<LogStreamSnapshot>({ status: "connecting", stale: false });
  const clientRef = useRef<LogStreamClient | null>(null);
  // Refs so the effect below depends on `service` alone — a new `onLine`/
  // `options` identity every render (an inline arrow function, a fresh
  // object literal) must not tear down and reopen the connection. Updated
  // via their own effects (not assigned directly in the render body) per
  // eslint-plugin-react-hooks' refs rule — a ref write only ever needs to
  // be visible to a later effect/event handler, never to this render.
  const onLineRef = useRef(onLine);
  useEffect(() => {
    onLineRef.current = onLine;
  }, [onLine]);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    const client = createLogStream(service, optionsRef.current);
    clientRef.current = client;
    setSnapshot(client.getSnapshot());
    const unsubState = client.subscribe(() => setSnapshot(client.getSnapshot()));
    const unsubLine = client.onLine((line) => onLineRef.current(line));
    return () => {
      unsubState();
      unsubLine();
      client.close();
      clientRef.current = null;
    };
  }, [service]);

  const retry = useCallback(() => clientRef.current?.retry(), []);

  return { ...snapshot, retry };
}
