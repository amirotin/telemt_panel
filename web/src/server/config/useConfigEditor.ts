import { useRef, useState } from "react";

/**
 * A revision plus the sections it describes — GET /api/telemt/config's
 * payload, widened: `sections` here is a plain JSON object rather than the
 * wire type's map of section-object-or-null, because the raw editor hands
 * back whatever the admin typed (a section can transiently be any JSON
 * value) and the rebase merge produces the same open shape.
 */
export interface ConfigSnapshot {
  revision: string;
  sections: Record<string, unknown>;
}

export interface ConfigEditorState {
  /** The revision the working copy was built from — what If-Match sends. */
  baseline: ConfigSnapshot | null;
  /** The working copy the forms read/write. */
  edited: Record<string, unknown> | null;
  setEdited: (next: Record<string, unknown>) => void;
  /** Current draft for async mutation callbacks, without relying on a stale render closure. */
  getEdited: () => Record<string, unknown> | null;
  /** Re-seeds the baseline and optionally keeps a rebased working copy. */
  seed: (fresh: ConfigSnapshot, workingCopy?: Record<string, unknown>) => void;
  /** Changes only on an explicit seed, so uncontrolled editors can remount safely. */
  documentVersion: number;
}

// useConfigEditor owns the Конфигурация page's editing session: `baseline`
// (the revision + sections the working copy started from) and `edited`
// (what the forms mutate). Seeded once, the first time GET /api/telemt/config
// resolves — a render-time conditional set (React's documented "adjusting
// state during rendering" pattern, matching journal/useDefaultLevels.ts's
// own reasoning: this project's eslint-plugin-react-hooks config flags
// setState inside a useEffect body) rather than a useEffect.
//
// Every later baseline change is explicit, through `seed`, never automatic
// from the query cache: a background refetch (react-query revalidating on
// window focus, say) must never silently discard an in-progress edit out
// from under the admin. `seed` is called only after a successful PATCH
// (re-baselining to the new revision) or after the admin confirms
// "перезагрузить и повторить" on a 409 revision-conflict banner.
export function useConfigEditor(queryData: ConfigSnapshot | undefined): ConfigEditorState {
  const [baseline, setBaseline] = useState<ConfigSnapshot | null>(null);
  const [edited, setEditedState] = useState<Record<string, unknown> | null>(null);
  const editedRef = useRef<Record<string, unknown> | null>(null);
  const [documentVersion, setDocumentVersion] = useState(0);

  if (queryData && !baseline) {
    setBaseline(queryData);
    setEditedState(queryData.sections);
  }

  function setEdited(next: Record<string, unknown>) {
    editedRef.current = next;
    setEditedState(next);
  }

  function seed(fresh: ConfigSnapshot, workingCopy = fresh.sections) {
    setBaseline(fresh);
    editedRef.current = workingCopy;
    setEditedState(workingCopy);
    setDocumentVersion((version) => version + 1);
  }

  return {
    baseline,
    edited,
    setEdited,
    getEdited: () => editedRef.current,
    seed,
    documentVersion,
  };
}
