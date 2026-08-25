import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ru } from "../../i18n/ru";

// DiagShell — the one page frame every Диагностика drill-down page renders
// inside: back link + title. Kept deliberately minimal since each page's
// body (KVGroupList, search, gating) differs enough that a heavier shared
// layout wouldn't save much.
export function DiagShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1">
        <Link
          to="/pulse"
          className="tap-target flex items-center px-2 text-sm font-medium text-accent hover:underline"
        >
          ← {ru.diag.back}
        </Link>
        <h1 className="text-lg font-semibold text-text">{title}</h1>
      </div>
      {children}
    </div>
  );
}
