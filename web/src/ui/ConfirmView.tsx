import { Button } from "./Button";
import { useStrings } from "../i18n";

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
// regenerate sub-link): a description plus
// cancel/confirm, no native confirm(). Originally extracted out of
// UserActionSheet so SublinkPanel's own "перевыпустить" uses the exact
// same confirmation step rather than a second copy that could drift;
// promoted to ui/ as the shared confirmation primitive.
export function ConfirmView({
  description,
  confirmLabel,
  danger,
  pending,
  onCancel,
  onConfirm,
}: ConfirmViewProps) {
  const s = useStrings();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text">{description}</p>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={pending} className="flex-1">
          {s.people.actions.cancel}
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={pending} className="flex-1">
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
