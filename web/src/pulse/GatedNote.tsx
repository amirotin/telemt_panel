import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { gateHints, type GateHintKey } from "../caps/gateHints";

export interface GatedNoteProps {
  /** Telemt's own Gated[T] `reason`, passed through as-is when present. */
  reason?: string;
  /** Static "как включить" hint, keyed by capability (caps/gateHints.ts). */
  hint?: GateHintKey;
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
// this is the nested variant, which is why it reuses gateHints rather than
// restating them.
export function GatedNote({ reason, hint, className }: GatedNoteProps) {
  return (
    <div className={cn("rounded-md bg-bg px-3.5 py-3 opacity-75", className)}>
      <p className="text-meta leading-relaxed text-text-muted">
        {ru.gated.disabledPrefix}
        {reason ?? ru.gated.defaultReason}
      </p>
      {hint && (
        <p className="mt-1 text-micro leading-relaxed text-text-faint">
          {ru.gated.howToEnable}: {gateHints[hint]}
        </p>
      )}
    </div>
  );
}
