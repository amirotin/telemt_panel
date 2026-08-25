import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ru } from "../../i18n/ru";
import { IconChevronLeft } from "../../ui/icons";

// DiagShell — the one page frame every Диагностика drill-down page renders
// inside: back link + title. Kept deliberately minimal since each page's
// body (KVGroupList, search, gating) differs enough that a heavier shared
// layout wouldn't save much.
//
// The header follows the prototype's sub-page pattern: a 44px accent
// chevron immediately left of an 18px bold title, no separate "Назад" word
// competing with it (the word stays as the link's accessible name).
export function DiagShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1">
        <Link
          to="/pulse"
          aria-label={ru.diag.back}
          className="tap-target -ml-2.5 flex items-center justify-center rounded-full text-[20px] text-accent transition-colors hover:bg-accent/12"
        >
          <IconChevronLeft />
        </Link>
        <h1 className="min-w-0 truncate text-[18px] font-bold text-text">{title}</h1>
      </div>
      {children}
    </div>
  );
}
