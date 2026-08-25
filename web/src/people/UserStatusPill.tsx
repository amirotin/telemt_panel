import { StatePill, type State } from "../ui/StatePill";
import { useStrings } from "../i18n";
import type { UserStatus } from "./users.helpers";

const STATE_BY_STATUS: Record<UserStatus, State> = {
  active: "ok",
  disabled: "muted",
  expired: "error",
  quota_exhausted: "warn",
  not_in_runtime: "warn",
};

export function UserStatusPill({ status, className }: { status: UserStatus; className?: string }) {
  const s = useStrings();
  return (
    <StatePill state={STATE_BY_STATUS[status]} className={className}>
      {s.people.status[status]}
    </StatePill>
  );
}
