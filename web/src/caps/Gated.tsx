import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { Button } from "../ui/Button";
import { gateHints, type GateHintKey } from "./gateHints";

export interface GatedProps {
  /** Whether the gated data/action is actually available right now. */
  enabled: boolean;
  /**
   * Human explanation of why it's off — typically Telemt's own Gated[T]
   * `reason` field, passed through as-is. Falls back to a generic sentence
   * when the source didn't provide one.
   */
  reason?: string;
  /** Static "как включить" hint, keyed by capability (see gateHints.ts). */
  hint?: GateHintKey;
  /** Optional "скрыть виджет" action (06-ui.md: dashboard widgets offer this). */
  onHide?: () => void;
  className?: string;
  children?: ReactNode;
}

// Gated is the ONE render for "this capability/gate is off" (06-ui.md: a
// widget with a disabled source shows this, not emptiness, and never a
// bespoke one-off "unavailable" layout). Wraps a Telemt Gated[T] payload
// (enabled/reason from the wire) or a /api/telemt/info capability flag
// (enabled from useCaps(), reason/hint supplied by the caller).
export function Gated({ enabled, reason, hint, onHide, className, children }: GatedProps) {
  if (enabled) return <>{children}</>;

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-6 text-center",
        className,
      )}
    >
      <p className="text-sm text-text-muted">
        {ru.gated.disabledPrefix}
        {reason ?? ru.gated.defaultReason}
      </p>
      {hint && (
        <p className="text-xs text-text-faint">
          {ru.gated.howToEnable}: {gateHints[hint]}
        </p>
      )}
      {onHide && (
        <Button variant="ghost" onClick={onHide} className="self-center">
          {ru.gated.hideWidget}
        </Button>
      )}
    </div>
  );
}
