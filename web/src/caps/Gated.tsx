import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import { IconInfo } from "../ui/icons";
import { gateHint, type GateHintKey } from "./gateHints";

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
  /**
   * `disabled` (default) — the feature exists on this build and is switched
   * off. `unsupported` — the build predates it entirely, so the copy points
   * at an update rather than at a setting (ruling R5).
   */
  variant?: "disabled" | "unsupported";
  className?: string;
  children?: ReactNode;
}

// Gated is the ONE render for "this capability/gate is off" (06-ui.md: a
// widget with a disabled source shows this, not emptiness, and never a
// bespoke one-off "unavailable" layout). Wraps a Telemt Gated[T] payload
// (enabled/reason from the wire) or a /api/telemt/info capability flag
// (enabled from useCaps(), reason/hint supplied by the caller).
export function Gated({
  enabled,
  reason,
  hint,
  variant = "disabled",
  className,
  children,
}: GatedProps) {
  const s = useStrings();
  if (enabled) return <>{children}</>;
  const unsupported = variant === "unsupported";

  // The prototype's quiet «Внутренние подсистемы» block: a normal card with
  // muted copy — a gate is a fact about this server's build, not a failure,
  // so it must not read as an error box (the dashed outline it used to have
  // was the loudest thing on the dashboard).
  //
  // The recessive look comes from the token colors alone, NOT from an
  // opacity multiplier on the card: `opacity-75` composited the copy
  // towards the page background and dropped it to 4.12:1 (reason) and
  // 3.20:1 (hint) — below AA. Without it, --text-muted is 6.26:1 dark /
  // 6.33:1 light and --text-faint is 4.69:1 / 5.27:1 on --surface.
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-xl bg-surface p-3.5", className)}>
      <div className="flex items-start gap-2">
        <IconInfo className="mt-0.5 h-4 w-4 shrink-0 text-text-faint" />
        <p className="text-[13px] font-semibold leading-snug text-text-muted">
          {unsupported ? s.gated.unsupportedPrefix : s.gated.disabledPrefix}
          {reason ?? (unsupported ? s.gated.unsupportedReason : s.gated.defaultReason)}
        </p>
      </div>
      {hint && (
        <p className="pl-6 text-meta leading-relaxed text-text-faint">
          {s.gated.howToEnable}: {gateHint(s, hint)}
        </p>
      )}
    </div>
  );
}
