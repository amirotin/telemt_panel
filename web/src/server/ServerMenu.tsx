import type { ComponentType } from "react";
import { Link } from "@tanstack/react-router";
import { ru } from "../i18n/ru";
import {
  IconChevronRight,
  IconPlatform,
  IconSettings,
  IconShield,
  IconUpgrade,
  IconWrench,
  type IconProps,
} from "../ui/icons";

const ITEMS: ReadonlyArray<{
  to: string;
  Icon: ComponentType<IconProps>;
  tint: string;
  item: { title: string; description: string };
}> = [
  {
    to: "/server/config",
    Icon: IconWrench,
    tint: "bg-accent/14 text-accent",
    item: ru.server.menu.config,
  },
  {
    to: "/server/updates",
    Icon: IconUpgrade,
    tint: "bg-ok/12 text-ok",
    item: ru.server.menu.updates,
  },
  {
    to: "/server/security",
    Icon: IconShield,
    tint: "bg-warn/12 text-warn",
    item: ru.server.menu.security,
  },
  {
    to: "/server/platform",
    Icon: IconPlatform,
    tint: "bg-surface-2 text-text-muted",
    item: ru.server.menu.platform,
  },
  {
    to: "/server/settings",
    Icon: IconSettings,
    tint: "bg-surface-2 text-text-muted",
    item: ru.server.menu.settings,
  },
];

// ServerMenu — /server: the list-menu landing page (06-ui.md §Сервер), each
// row a full-screen subpage on mobile. On `lg:` this still reads fine as a
// plain list — the subpages themselves are where the two-column layouts
// live, not this menu.
//
// One card holding five hairline-separated rows, like the prototype's
// Сервер artboard: a tinted 32px icon tile, the label, and a chevron. The
// separate-cards-with-gaps version D1 shipped read as five unrelated
// panels rather than one menu.
export function ServerMenu() {
  return (
    <div className="flex flex-col gap-3.5">
      <h1 className="text-title font-extrabold tracking-tight text-text">
        {ru.server.title}
      </h1>
      <nav className="overflow-hidden rounded-2xl bg-surface">
        {ITEMS.map(({ to, Icon, tint, item }) => (
          <Link
            key={to}
            to={to}
            className="flex min-h-[56px] items-center gap-3 border-b border-border px-3.5 py-2 transition-colors last:border-b-0 hover:bg-surface-2"
          >
            <span
              aria-hidden="true"
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[16px] ${tint}`}
            >
              <Icon />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-row font-medium text-text">
                {item.title}
              </span>
              <span className="truncate text-micro text-text-muted">
                {item.description}
              </span>
            </span>
            <IconChevronRight
              aria-hidden="true"
              className="ml-auto h-4 w-4 shrink-0 text-text-faint"
            />
          </Link>
        ))}
      </nav>
    </div>
  );
}
