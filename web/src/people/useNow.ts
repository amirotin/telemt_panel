import { useEffect, useState } from "react";

// useNow re-renders its caller periodically so time-relative computations
// (expiry status, countdown text) stay correct even when no new SSE frame
// has arrived to trigger a render on its own. 30s is frequent enough that
// an expiry crossing "now" shows up promptly without a per-second re-render
// cost across a whole user list.
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
