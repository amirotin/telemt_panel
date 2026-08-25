import { ru } from "../../i18n/ru";
import { Select } from "../../ui/Select";
import { Input } from "../../ui/Input";
import type { ReloadPolicyState, ReloadMode } from "./reloadPolicy";

export function ReloadPolicyPicker({
  value,
  onChange,
}: {
  value: ReloadPolicyState;
  onChange: (next: ReloadPolicyState) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">{ru.server.config.reloadPolicy.label}</span>
        <Select
          value={value.mode}
          onChange={(e) => onChange({ ...value, mode: e.target.value as ReloadMode })}
          className="w-44"
        >
          <option value="none">{ru.server.config.reloadPolicy.none}</option>
          <option value="instant">{ru.server.config.reloadPolicy.instant}</option>
          <option value="drain">{ru.server.config.reloadPolicy.drain}</option>
        </Select>
      </label>
      {value.mode === "drain" && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">{ru.server.config.reloadPolicy.timeoutLabel}</span>
          <Input
            type="number"
            inputMode="numeric"
            className="w-28"
            value={value.timeoutSecs}
            onChange={(e) => onChange({ ...value, timeoutSecs: Number(e.target.value) || 1 })}
          />
        </label>
      )}
    </div>
  );
}
