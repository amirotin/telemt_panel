import { useSyncExternalStore } from "react";
import { getStoredTheme, setStoredTheme, subscribeTheme, type Theme } from "./theme";

export function useTheme(): [Theme, (theme: Theme) => void] {
  return [useSyncExternalStore(subscribeTheme, getStoredTheme, getStoredTheme), setStoredTheme];
}
