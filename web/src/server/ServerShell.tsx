import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ru } from "../i18n/ru";

// ServerShell — the page frame every Сервер subpage renders inside: back
// link to the menu + title. Mirrors pulse/diag/DiagShell's own minimal
// frame (same reasoning: each subpage's body differs enough that a
// heavier shared layout wouldn't save much).
export function ServerShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1">
        <Link
          to="/server"
          className="tap-target flex items-center px-2 text-sm font-medium text-accent hover:underline"
        >
          {ru.server.back}
        </Link>
        <h1 className="text-lg font-semibold text-text">{title}</h1>
      </div>
      {children}
    </div>
  );
}
