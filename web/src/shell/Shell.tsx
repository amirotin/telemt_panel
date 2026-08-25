import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { StatusStrip } from "./StatusStrip";
import { HeaderMenu } from "./HeaderMenu";
import { useKeyboardInset } from "./useKeyboardInset";

const NAV_ITEMS = [
  { to: "/people", label: ru.nav.people, icon: "👤" },
  { to: "/pulse", label: ru.nav.pulse, icon: "❤" },
  { to: "/journal", label: ru.nav.journal, icon: "📄" },
  { to: "/server", label: ru.nav.server, icon: "⚙" },
] as const;

// Shell — the app frame every authed route renders inside (_authed.tsx):
// bottom tab bar on mobile, sidebar from `lg:` up, plus the global status
// strip and header menu (design-brief.md §Навигация). Mobile-first: the
// sidebar is `hidden lg:flex`, the tab bar is `lg:hidden`.
export function Shell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const keyboardInset = useKeyboardInset();

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="hidden w-56 shrink-0 flex-col gap-4 border-r border-border bg-surface p-4 lg:flex">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-text">{ru.app.title}</span>
          <HeaderMenu />
        </div>
        <StatusStrip className="flex-col items-start gap-2" />
        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "tap-target flex items-center gap-3 rounded-lg px-3 text-sm font-medium text-text-muted",
                "hover:bg-surface-2 hover:text-text",
                "data-[status=active]:bg-surface-2 data-[status=active]:text-text",
              )}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-h-dvh flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-2 pt-safe lg:hidden">
          <span className="text-sm font-semibold text-text">{ru.app.title}</span>
          <HeaderMenu />
        </header>
        <div className="border-b border-border bg-surface px-4 py-2 lg:hidden">
          <StatusStrip />
        </div>

        <main className="flex-1 overflow-y-auto px-4 py-4 pb-20 lg:pb-4">{children}</main>

        <nav
          className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface pb-safe lg:hidden"
          style={{ bottom: keyboardInset }}
          aria-label={ru.shell.navLabel}
        >
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "tap-target flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium",
                  active ? "text-accent" : "text-text-muted",
                )}
                aria-current={active ? "page" : undefined}
              >
                <span aria-hidden="true" className="text-base">
                  {item.icon}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
