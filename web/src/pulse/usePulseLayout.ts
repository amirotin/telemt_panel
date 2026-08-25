import { useCallback, useState } from "react";
import {
  getStoredLayout,
  hideWidget,
  moveWidget,
  resetLayout as resetLayoutStore,
  setStoredLayout,
  showWidget,
  type Layout,
} from "./layout";
import type { WidgetId } from "./types";

// usePulseLayout is the one place PulseDashboard reads/writes the layout
// store — plain useState (not useSyncExternalStore) since the value only
// changes through this hook's own actions (no other tab/component writes
// it concurrently), matching DisplayModeContext's own reasoning.
export function usePulseLayout() {
  const [layout, setLayoutState] = useState<Layout>(() => getStoredLayout());

  const persist = useCallback((next: Layout) => {
    setStoredLayout(next);
    setLayoutState(next);
  }, []);

  const move = useCallback(
    (id: WidgetId, direction: "up" | "down") => persist(moveWidget(layout, id, direction)),
    [layout, persist],
  );
  const show = useCallback((id: WidgetId) => persist(showWidget(layout, id)), [layout, persist]);
  const hide = useCallback((id: WidgetId) => persist(hideWidget(layout, id)), [layout, persist]);
  const reset = useCallback(() => setLayoutState(resetLayoutStore()), []);

  return { layout, move, show, hide, reset };
}
