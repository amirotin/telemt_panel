import { useCallback, useEffect, useState } from "react";
import { applyTheme, getStoredTheme, setStoredTheme, type Theme } from "./theme";

// useTheme is the single place the app reads/writes the theme — applies it
// to the DOM on mount and whenever it changes, and persists the choice.
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const update = useCallback((next: Theme) => {
    setStoredTheme(next);
    setTheme(next);
  }, []);

  return [theme, update];
}
