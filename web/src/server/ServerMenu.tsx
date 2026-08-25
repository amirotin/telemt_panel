import { Link } from "@tanstack/react-router";
import { ru } from "../i18n/ru";

const ITEMS = [
  { to: "/server/config", icon: "🛠", item: ru.server.menu.config },
  { to: "/server/updates", icon: "⬆", item: ru.server.menu.updates },
  { to: "/server/security", icon: "🛡", item: ru.server.menu.security },
  { to: "/server/platform", icon: "🖥", item: ru.server.menu.platform },
  { to: "/server/settings", icon: "⚙", item: ru.server.menu.settings },
] as const;

// ServerMenu — /server: the list-menu landing page (06-ui.md §Сервер), each
// row a full-screen subpage on mobile. On `lg:` this still reads fine as a
// plain list — the subpages themselves are where the two-column layouts
// live, not this menu.
export function ServerMenu() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-text">{ru.server.title}</h1>
      <nav className="flex flex-col gap-2">
        {ITEMS.map(({ to, icon, item }) => (
          <Link
            key={to}
            to={to}
            className="tap-target flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 hover:bg-surface-2"
          >
            <span aria-hidden="true" className="text-xl">
              {icon}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium text-text">{item.title}</span>
              <span className="truncate text-xs text-text-muted">{item.description}</span>
            </span>
            <span aria-hidden="true" className="ml-auto text-text-faint">
              →
            </span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
