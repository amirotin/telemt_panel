import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import { gateHint, type GateHintKey } from "../caps/gateHints";

export interface GatedNoteProps {
  /**
   * Telemt's own Gated[T] `reason` (a short token like `feature_disabled`),
   * printed as-is after the localized prefix. Never a sentence composed by
   * the panel — that would put untranslated prose in a localized UI.
   */
  reason?: string;
  /** Static "как включить" hint, keyed by capability (caps/gateHints.ts). */
  hint?: GateHintKey;
  /**
   * `disabled` (default) — the feature exists on this build and is switched
   * off. `unsupported` — the build predates it entirely, so the copy points
   * at an update rather than at a setting (ruling R5).
   */
  variant?: "disabled" | "unsupported";
  className?: string;
}

// GatedNote — Пульс's rendering of "this source is switched off", as the
// prototype draws it: a dimmed *recessed* note inside the widget's card,
// with the reason and the sentence explaining which build/setting turns
// the section on («Внутренние подсистемы — диагностика ME-пулов появилась
// в telemt 3.7…»). Information, not alarm.
//
// caps/Gated is the same state as a standalone *card* (it renders on the
// bare page, and carries the optional "hide" action for gated actions);
// this is the nested variant, which is why it reuses gateHint rather than
// restating them.
export function GatedNote({ reason, hint, variant = "disabled", className }: GatedNoteProps) {
  const s = useStrings();
  const unsupported = variant === "unsupported";
  return (
    <div className={cn("rounded-md bg-bg px-3.5 py-3 opacity-75", className)}>
      <p className="text-meta leading-relaxed text-text-muted">
        {unsupported ? s.gated.unsupportedPrefix : s.gated.disabledPrefix}
        {reason ?? (unsupported ? s.gated.unsupportedReason : s.gated.defaultReason)}
      </p>
      {hint && (
        <p className="mt-1 text-micro leading-relaxed text-text-faint">
          {s.gated.howToEnable}: {gateHint(s, hint)}
        </p>
      )}
    </div>
  );
}
