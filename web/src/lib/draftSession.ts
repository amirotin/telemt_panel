export interface VersionedDraft<T> {
  value: T;
  revision: string | null;
}

export interface DraftSession<T> {
  sessionKey: string;
  baseline: VersionedDraft<T>;
  draft: T;
  remote: VersionedDraft<T> | null;
}

export interface SubmittedDraft<T> {
  sessionKey: string;
  value: T;
  revision: string | null;
  requestId: number;
}

export function receiveRemote<T>(state: DraftSession<T>, fresh: VersionedDraft<T>, equal: (a: T, b: T) => boolean): DraftSession<T> {
  if (fresh.revision === state.baseline.revision && equal(fresh.value, state.baseline.value)) return state;
  // A GET of the confirmed revision can canonicalize submitted values while
  // a different remote revision remains an unresolved conflict.
  if (fresh.revision !== null && fresh.revision === state.baseline.revision) {
    return {
      ...state,
      baseline: fresh,
      draft: equal(state.draft, state.baseline.value) ? fresh.value : state.draft,
      remote: state.remote?.revision === fresh.revision ? null : state.remote,
    };
  }
  if (state.remote?.revision === fresh.revision && equal(state.remote.value, fresh.value)) return state;
  if (!state.remote && equal(state.draft, state.baseline.value)) {
    return { ...state, baseline: fresh, draft: fresh.value, remote: null };
  }
  return { ...state, remote: fresh };
}

export function acknowledgeSubmitted<T>(state: DraftSession<T>, submitted: SubmittedDraft<T>, confirmed: VersionedDraft<T>, equal: (a: T, b: T) => boolean): DraftSession<T> {
  if (state.sessionKey !== submitted.sessionKey) return state;
  const remote = state.remote;
  const canonical = remote && remote.revision !== null && remote.revision === confirmed.revision ? remote : confirmed;
  const matchesConfirmation = remote && equal(remote.value, canonical.value) && remote.revision === canonical.revision;
  return {
    ...state,
    baseline: canonical,
    draft: equal(state.draft, submitted.value) ? canonical.value : state.draft,
    remote: matchesConfirmation ? null : remote,
  };
}

export function discardToRemote<T>(state: DraftSession<T>): DraftSession<T> {
  const baseline = state.remote ?? state.baseline;
  return { ...state, baseline, draft: baseline.value, remote: null };
}
