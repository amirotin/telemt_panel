import type { SessionInfo } from "../../lib/api/generated/types.gen";
import { IconDesktop, IconDevice } from "../../ui/icons";

export function SessionIcon({ session }: { session: SessionInfo }) {
  const mobile = /iphone|ipad|android/i.test(session.user_agent_label ?? "");
  return (
    <span
      aria-hidden="true"
      className={
        session.current
          ? "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ok/12 text-ok"
          : "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"
      }
    >
      {mobile ? <IconDevice /> : <IconDesktop />}
    </span>
  );
}
