import { ru, useStrings } from "../../i18n";
import { Chip } from "../../ui/Chip";
import { Input } from "../../ui/Input";
import { SectionLabel } from "../../ui/SectionLabel";
import type { ReloadPolicyState, ReloadMode } from "./reloadPolicy";

const MODES: ReadonlyArray<{ value: ReloadMode; label: string }> = [
  { value: "none", label: ru.server.config.reloadPolicy.none },
  { value: "instant", label: ru.server.config.reloadPolicy.instant },
  { value: "drain", label: ru.server.config.reloadPolicy.drain },
];

// ReloadPolicyPicker — the prototype's segmented pill strip rather than a
// <select>: three fixed, non-destructive choices that the admin re-picks
// often, all worth seeing at once before pressing Сохранить.
export function ReloadPolicyPicker({
  value,
  onChange,
}: {
  value: ReloadPolicyState;
  onChange: (next: ReloadPolicyState) => void;
}) {
  const s = useStrings();
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{s.server.config.reloadPolicy.label}</SectionLabel>
      <div className="flex flex-wrap items-center gap-1.5">
        {MODES.map((mode) => (
          <Chip
            key={mode.value}
            active={value.mode === mode.value}
            onClick={() => onChange({ ...value, mode: mode.value })}
          >
            {mode.label}
          </Chip>
        ))}
        {value.mode === "drain" && (
          <label className="flex items-center gap-2 pl-1">
            <span className="text-micro text-text-muted">
              {s.server.config.reloadPolicy.timeoutLabel}
            </span>
            <Input
              type="number"
              inputMode="numeric"
              className="w-24"
              value={value.timeoutSecs}
              onChange={(e) =>
                onChange({ ...value, timeoutSecs: Number(e.target.value) || 1 })
              }
            />
          </label>
        )}
      </div>
    </div>
  );
}
