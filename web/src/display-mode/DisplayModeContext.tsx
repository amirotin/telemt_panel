import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { type DisplayMode, getStoredDisplayMode, setStoredDisplayMode } from "./mode";

interface DisplayModeContextValue {
  mode: DisplayMode;
  setMode: (mode: DisplayMode) => void;
}

const DisplayModeContext = createContext<DisplayModeContextValue | null>(null);

// DisplayModeProvider owns the current mode for the whole app — mount once
// near the root (main.tsx). A plain useState is enough here (unlike the SSE
// store): the value changes rarely (user action), so a context re-render on
// change is cheap and there is no need for useSyncExternalStore's
// fine-grained subscription.
export function DisplayModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<DisplayMode>(() => getStoredDisplayMode());

  const setMode = useCallback((next: DisplayMode) => {
    setStoredDisplayMode(next);
    setModeState(next);
  }, []);

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);

  return <DisplayModeContext.Provider value={value}>{children}</DisplayModeContext.Provider>;
}

// useDisplayMode is the single hook every screen/widget reads (and, from
// Настройки/Пульс's switcher, writes) the current display mode through.
export function useDisplayMode(): DisplayModeContextValue {
  const ctx = useContext(DisplayModeContext);
  if (!ctx) throw new Error("useDisplayMode must be used within DisplayModeProvider");
  return ctx;
}
