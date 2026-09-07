import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import { StatusStrip } from "./StatusStrip";
import { HeaderMenu } from "./HeaderMenu";
import {
  MANAGEMENT_NAV_ITEMS,
  OPERATIONAL_NAV_ITEMS,
  isNavItemActive,
  type NavItem,
} from "./nav";
import { useKeyboardInset } from "./useKeyboardInset";
import { useLogout } from "../auth/useLogout";
import { Sheet } from "../ui/Sheet";
import { IconLogout, IconMore, IconSettings } from "../ui/icons";

export function BrandMark({ className }: { className?: string }) {
  const s = useStrings();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "brand-gradient inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm",
        "text-[13px] font-bold leading-none text-brand-text",
        className,
      )}
    >
      {s.app.title.slice(0, 1)}
    </span>
  );
}

// One information architecture in three geometries. The full sidebar starts
// only when its 240px width still leaves the Overview grid enough room.
export function Shell({ children }: { children: ReactNode }) {
  const s = useStrings();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const keyboardInset = useKeyboardInset();
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [railMoreOpen, setRailMoreOpen] = useState(false);
  const ownsLayout = pathname === "/people" || pathname.startsWith("/people/");
  const managementActive = MANAGEMENT_NAV_ITEMS.some((item) => isNavItemActive(item.to, pathname));

  useEffect(() => {
    if (!railMoreOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRailMoreOpen(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [railMoreOpen]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden min-[600px]:flex-row">
      <FullSidebar pathname={pathname} />

      <aside data-testid="navigation-rail" className="relative hidden w-16 shrink-0 flex-col items-center border-r border-border bg-surface py-3 min-[600px]:flex min-[1180px]:hidden">
        <BrandMark className="h-8 w-8" />
        <nav className="mt-5 flex flex-col gap-2" aria-label={s.shell.navLabel}>
          {OPERATIONAL_NAV_ITEMS.map((item) => (
            <RailLink key={item.to} item={item} active={isNavItemActive(item.to, pathname)} />
          ))}
        </nav>
        <button
          type="button"
          className={cn(
            "tap-target mt-auto flex w-11 items-center justify-center rounded-lg text-text-faint transition-colors hover:bg-surface-2 hover:text-text",
            (managementActive || railMoreOpen) && "bg-accent/14 text-accent",
          )}
          aria-label={s.nav.more}
          aria-haspopup="menu"
          aria-expanded={railMoreOpen}
          onClick={() => setRailMoreOpen((open) => !open)}
        >
          <IconMore className="h-5 w-5" />
        </button>
        {railMoreOpen && (
          <>
            <button
              type="button"
              className="fixed inset-0 z-30 cursor-default"
              aria-label={s.common.close}
              onClick={() => setRailMoreOpen(false)}
            />
            <div className="fixed bottom-3 left-[72px] z-40 w-64 rounded-xl border border-border bg-surface p-2 shadow-2xl">
              <SecondaryLinks onNavigate={() => setRailMoreOpen(false)} />
            </div>
          </>
        )}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <main
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            ownsLayout
              ? "overflow-hidden"
              : "overflow-y-auto px-4 py-4 pb-[76px] min-[600px]:pb-4",
          )}
        >
          <div
            className="mx-auto flex min-h-0 w-full max-w-[1440px] flex-1 flex-col"
            data-testid="page-frame"
          >
            {children}
          </div>
        </main>

        <nav
          data-testid="mobile-bottom-nav"
          className="fixed inset-x-0 bottom-0 z-40 flex min-h-[60px] border-t border-border bg-surface pb-safe min-[600px]:hidden"
          style={{ bottom: keyboardInset }}
          aria-label={s.shell.navLabel}
        >
          {OPERATIONAL_NAV_ITEMS.map((item) => (
            <BottomLink key={item.to} item={item} active={isNavItemActive(item.to, pathname)} />
          ))}
          <button
            type="button"
            className={cn(
              "tap-target flex flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[10px] font-semibold",
              managementActive || mobileMoreOpen ? "text-accent" : "text-text-faint",
            )}
            aria-label={s.nav.more}
            aria-haspopup="dialog"
            aria-expanded={mobileMoreOpen}
            onClick={() => setMobileMoreOpen(true)}
          >
            <span
              className={cn(
                "flex h-7 min-w-10 items-center justify-center rounded-lg",
                (managementActive || mobileMoreOpen) && "bg-accent/14",
              )}
            >
              <IconMore className="h-5 w-5" />
            </span>
            {s.nav.more}
          </button>
        </nav>
      </div>

      <Sheet
        open={mobileMoreOpen}
        onClose={() => setMobileMoreOpen(false)}
        title={s.nav.more}
        placement="bottom"
      >
        <SecondaryLinks onNavigate={() => setMobileMoreOpen(false)} />
      </Sheet>
    </div>
  );
}

function FullSidebar({ pathname }: { pathname: string }) {
  const s = useStrings();
  const logout = useLogout();
  return (
    <aside data-testid="full-sidebar" className="hidden w-[240px] shrink-0 flex-col border-r border-border bg-surface px-3 py-4 min-[1180px]:flex">
      <div className="flex items-center gap-2.5 px-2.5 pb-5">
        <BrandMark />
        <span className="flex-1 truncate text-sm font-bold text-text">{s.app.title}</span>
      </div>
      <SidebarGroup label={s.shell.overviewGroup} items={OPERATIONAL_NAV_ITEMS} pathname={pathname} />
      <SidebarGroup
        label={s.shell.managementGroup}
        items={MANAGEMENT_NAV_ITEMS}
        pathname={pathname}
        className="mt-5"
      />
      <div className="mt-auto flex flex-col gap-2 pt-4">
        <StatusStrip variant="card" />
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
  );
}

function SidebarGroup({
  label,
  items,
  pathname,
  className,
}: {
  label: string;
  items: readonly NavItem[];
  pathname: string;
  className?: string;
}) {
  const s = useStrings();
  return (
    <div className={className}>
      <p className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-faint">
        {label}
      </p>
      <nav className="flex flex-col gap-1" aria-label={`${s.shell.navLabel}: ${label}`}>
        {items.map(({ to, labelKey, Icon }) => {
          const active = isNavItemActive(to, pathname);
          return (
            <Link
              key={to}
              to={to}
              aria-current={active ? "page" : undefined}
              className={cn(
                "tap-target flex items-center gap-3 rounded-lg px-3 text-row font-semibold",
                "text-text-faint transition-colors hover:bg-surface-2 hover:text-text",
                active && "bg-accent/14 text-accent",
              )}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              {s.nav[labelKey]}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  const s = useStrings();
  const { to, labelKey, Icon } = item;
  return (
    <Link
      to={to}
      title={s.nav[labelKey]}
      aria-label={s.nav[labelKey]}
      aria-current={active ? "page" : undefined}
      className={cn(
        "tap-target flex w-11 items-center justify-center rounded-lg text-text-faint transition-colors hover:bg-surface-2 hover:text-text",
        active && "bg-accent/14 text-accent",
      )}
    >
      <Icon className="h-5 w-5" />
    </Link>
  );
}

function BottomLink({ item, active }: { item: NavItem; active: boolean }) {
  const s = useStrings();
  const { to, labelKey, Icon } = item;
  return (
    <Link
      to={to}
      className={cn(
        "tap-target flex flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[10px] font-semibold",
        active ? "text-accent" : "text-text-faint",
      )}
      aria-current={active ? "page" : undefined}
    >
      <span className={cn("flex h-7 min-w-10 items-center justify-center rounded-lg", active && "bg-accent/14")}>
        <Icon className="h-5 w-5" />
      </span>
      {s.nav[labelKey]}
    </Link>
  );
}

function SecondaryLinks({ onNavigate }: { onNavigate: () => void }) {
  const s = useStrings();
  const logout = useLogout();
  return (
    <div role="menu" className="flex flex-col gap-1">
      {MANAGEMENT_NAV_ITEMS.map(({ to, labelKey, Icon }) => (
        <Link
          key={to}
          to={to}
          role="menuitem"
          onClick={onNavigate}
          className="tap-target flex items-center gap-3 rounded-lg px-3 text-row font-semibold text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          <Icon className="h-5 w-5 shrink-0" />
          {s.nav[labelKey]}
        </Link>
      ))}
      <Link
        to="/server/settings"
        role="menuitem"
        onClick={onNavigate}
        className="tap-target flex items-center gap-3 rounded-lg px-3 text-row font-semibold text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
      >
        <IconSettings className="h-5 w-5 shrink-0" />
        {s.shell.panelSettings}
      </Link>
      <div className="my-1 border-t border-border" />
      <button
        type="button"
        role="menuitem"
        disabled={logout.isPending}
        onClick={() => logout.mutate({})}
        className="tap-target flex items-center gap-3 rounded-lg px-3 text-left text-row font-semibold text-text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
      >
        <IconLogout className="h-5 w-5 shrink-0" />
        {s.auth.signOut}
      </button>
    </div>
  );
}
