import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import { StatusStrip } from "./StatusStrip";
import { HeaderMenu } from "./HeaderMenu";
import { NAV_ITEMS, isNavItemActive } from "./nav";
import { useKeyboardInset } from "./useKeyboardInset";
import { useLogout } from "../auth/useLogout";
import { IconLogout } from "../ui/icons";

// BrandMark — the square "T" tile from the prototype's sidebar/login. The
// letter is the product name's own initial rather than a separate asset, so
// there is nothing to keep in sync and nothing extra to ship.
export function BrandMark({ className }: { className?: string }) {
  const s = useStrings();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "brand-gradient inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm",
        "text-[13px] font-bold leading-none text-white",
        className,
      )}
    >
      {s.app.title.slice(0, 1)}
    </span>
  );
}

// Shell — the app frame every authed route renders inside (_authed.tsx):
// bottom tab bar on mobile, sidebar from `lg:` up, plus the global status
// readout and header menu (design-brief.md §Навигация). Mobile-first: the
// sidebar is `hidden lg:flex`, the tab bar is `lg:hidden`.
export function Shell({ children }: { children: ReactNode }) {
  const s = useStrings();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const keyboardInset = useKeyboardInset();
  const logout = useLogout();
  const ownsLayout = pathname === "/people" || pathname.startsWith("/people/");

  return (
    <div className="flex h-dvh flex-col overflow-hidden lg:flex-row">
      <aside className="hidden w-[216px] shrink-0 flex-col border-r border-border bg-surface px-2.5 py-4 lg:flex">
        <div className="flex items-center gap-2.5 px-2.5 pb-4">
          <BrandMark />
          <span className="flex-1 truncate text-sm font-bold text-text">{s.app.title}</span>
        </div>

        {/* Deliberately unlabelled: the tab bar below owns the
            "Основная навигация" accessible name, and only ever one of the
            two is rendered (`hidden lg:flex` / `lg:hidden`) — two
            same-named navigation landmarks would be a worse a11y tree, not
            a better one, and e2e/desktop.spec.ts asserts the tab bar is
            the hidden one at `lg:`. */}
        <nav className="flex flex-col gap-0.5">
          {NAV_ITEMS.map(({ to, labelKey, Icon }) => (
            <Link
              key={to}
              to={to}
              className={cn(
                // 06-ui.md's design system asks 44px of every interactive
                // element, and the sidebar was the one place still at 40.
                "tap-target flex items-center gap-2.5 rounded-md px-2.5 text-row font-semibold",
                "text-text-faint transition-colors hover:bg-surface-2 hover:text-text",
                "data-[status=active]:bg-accent/14 data-[status=active]:text-accent",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {s.nav[labelKey]}
            </Link>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-2 pt-4">
          <StatusStrip variant="card" />
          {/* The overflow menu lives here rather than in the brand row:
              216px of sidebar cannot hold a 44px target next to the
              product name without truncating it. */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => logout.mutate({})}
              disabled={logout.isPending}
              className={cn(
                "tap-target flex flex-1 items-center gap-2.5 rounded-md px-2.5 text-row font-medium",
                "text-text-faint transition-colors hover:bg-surface-2 hover:text-text",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <IconLogout className="h-4 w-4 shrink-0" />
              {s.auth.signOut}
            </button>
            <HeaderMenu />
          </div>
        </div>
      </aside>

      {/* min-w-0 as well as min-h-0: a flex row item defaults to
          min-width:auto, so without this the content column refuses to
          shrink below its own min-content width and pushes the page wider
          than the viewport — which clipped the right edge of Люди's
          Инспектор panel off-screen. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2.5 border-b border-border bg-surface px-4 py-2 pt-safe lg:hidden">
          <BrandMark />
          <span className="flex-1 truncate text-sm font-bold text-text">{s.app.title}</span>
          <HeaderMenu />
        </header>
        <div className="shrink-0 border-b border-border bg-surface px-4 py-2 lg:hidden">
          <StatusStrip />
        </div>

        {/* Люди owns its own box: on `lg:` it is a two-column layout (list
            + Инспектор) whose columns scroll independently, and its rows
            are full-bleed, so the shell must not impose padding or a
            single outer scroller on it. Every other section gets the
            standard page gutter and one scroller. */}
        <main
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            ownsLayout ? "overflow-hidden" : "overflow-y-auto px-4 py-4 pb-[76px] lg:pb-4",
          )}
        >
          {children}
        </main>

        <nav
          className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface pb-safe lg:hidden"
          style={{ bottom: keyboardInset }}
          aria-label={s.shell.navLabel}
        >
          {NAV_ITEMS.map(({ to, labelKey, Icon }) => {
            const active = isNavItemActive(to, pathname);
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  "tap-target flex flex-1 flex-col items-center justify-center gap-1 py-1.5",
                  "text-[10px] font-semibold transition-colors",
                  active ? "text-accent" : "text-text-faint",
                )}
                aria-current={active ? "page" : undefined}
              >
                <Icon className="h-5 w-5" />
                {s.nav[labelKey]}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
