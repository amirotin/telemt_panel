import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { receiveRemote, type DraftSession, type VersionedDraft } from "./draftSession";

export function useDraftSession<T>(sessionKey: string, fresh: VersionedDraft<T>, equal: (a: T, b: T) => boolean) {
  const [session, setSession] = useState<DraftSession<T>>(() => ({ sessionKey, baseline: fresh, draft: fresh.value, remote: null }));
  const current = useRef(session);
  const received = useRef({ sessionKey, fresh });
  const update = useCallback((change: (state: DraftSession<T>) => DraftSession<T>) => {
    const next = change(current.current);
    if (next === current.current) return next;
    current.current = next;
    setSession(next);
    return next;
  }, []);

  useLayoutEffect(() => {
    const previous = received.current;
    if (previous.sessionKey !== sessionKey) {
      received.current = { sessionKey, fresh };
      update(() => ({ sessionKey, baseline: fresh, draft: fresh.value, remote: null }));
    } else if (previous.fresh.revision !== fresh.revision || !equal(previous.fresh.value, fresh.value)) {
      received.current = { sessionKey, fresh };
      update((state) => receiveRemote(state, fresh, equal));
    }
  }, [sessionKey, fresh, equal, update]);

  return { session, update, current };
}
