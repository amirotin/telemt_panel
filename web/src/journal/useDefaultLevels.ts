import { useState } from "react";
import type { DisplayMode } from "../display-mode/mode";
import { defaultLevelsForMode, type LogLevel } from "./logFilter.helpers";

// useDefaultLevels — the level-filter selection, reset to `mode`'s default
// set whenever `mode` itself changes (Task 7 brief C: "critical -> defaults
// to error+warn"). Shared by LogStreamViewer and LogTailFallback.
//
// Uses React's documented "adjusting state during rendering" pattern
// (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
// rather than a useEffect: this project's eslint-plugin-react-hooks config
// flags synchronous setState calls inside an effect body, and the render-
// time comparison also avoids the effect version's extra commit (levels
// briefly still holding the old mode's default before the effect fires).
export function useDefaultLevels(mode: DisplayMode): [Set<LogLevel>, (levels: Set<LogLevel>) => void] {
  const [levels, setLevels] = useState<Set<LogLevel>>(() => defaultLevelsForMode(mode));
  const [levelsMode, setLevelsMode] = useState(mode);

  if (mode !== levelsMode) {
    setLevelsMode(mode);
    setLevels(defaultLevelsForMode(mode));
  }

  return [levels, setLevels];
}
