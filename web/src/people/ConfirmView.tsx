import { Button } from "../ui/Button";
import { ru } from "../i18n/ru";

export interface ConfirmViewProps {
  description: string;
  confirmLabel: string;
  danger?: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

// ConfirmView — the one "are you sure?" step every irreversible/disruptive
// action goes through (delete, reset quota, enable/disable, rotate secret,
// regenerate sub-link): a description plus cancel/confirm, no native
// confirm(). Extracted out of UserActionSheet so SublinkPanel's own
// "перевыпустить" (which invalidates the currently distributed link) uses
// the exact same confirmation step rather than a second copy that could
// drift.
export function ConfirmView({
  description,
  confirmLabel,
  danger,
  pending,
  onCancel,
  onConfirm,
}: ConfirmViewProps) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text">{description}</p>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={pending} className="flex-1">
          {ru.people.actions.cancel}
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={pending} className="flex-1">
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
