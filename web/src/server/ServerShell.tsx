import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ru } from "../i18n/ru";
import { IconChevronLeft } from "../ui/icons";

// ServerShell — the page frame every Сервер subpage renders inside: back
// link to the menu + title. Mirrors pulse/diag/DiagShell's own minimal
// frame (same reasoning: each subpage's body differs enough that a
// heavier shared layout wouldn't save much).
//
// The back affordance is the prototype's bare accent chevron with an
// aria-label, not a "← Сервер" text link: a second visible «Сервер» on the
// page competes with the tab bar's own Сервер item for the same name.
export function ServerShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="-ml-2 flex items-center gap-0.5">
        <Link
          to="/server"
          aria-label={ru.server.back}
          className="tap-target flex items-center justify-center text-[20px] text-accent"
        >
          <IconChevronLeft aria-hidden="true" />
        </Link>
        <h1 className="min-w-0 truncate text-[18px] font-bold text-text">
          {title}
        </h1>
      </div>
      {children}
    </div>
  );
}
