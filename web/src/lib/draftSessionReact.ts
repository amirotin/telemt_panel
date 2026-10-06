import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { receiveRemote, type DraftSession, type VersionedDraft } from "./draftSession";

export function useDraftSession<T>(sessionKey: string, fresh: VersionedDraft<T>, equal: (a: T, b: T) => boolean, preserveDraft = false) {
  const [session, setSession] = useState<DraftSession<T>>(() => ({ sessionKey, baseline: fresh, draft: fresh.value, remote: null }));
  const current = useRef(session);
  const received = useRef({ sessionKey, fresh, preserveDraft });
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
      received.current = { sessionKey, fresh, preserveDraft };
      update(() => ({ sessionKey, baseline: fresh, draft: fresh.value, remote: null }));
    } else if (previous.fresh.revision !== fresh.revision || !equal(previous.fresh.value, fresh.value)) {
      received.current = { sessionKey, fresh, preserveDraft };
      update((state) => receiveRemote(state, fresh, equal, preserveDraft));
    } else if (previous.preserveDraft !== preserveDraft) {
      // A protection change cannot turn unchanged cache data into a new
      // GET, especially after a save has confirmed a newer revision.
      received.current = { sessionKey, fresh, preserveDraft };
    }
  }, [sessionKey, fresh, equal, update, preserveDraft]);

  return { session, update, current };
}
