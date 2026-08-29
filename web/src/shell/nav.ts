import type { ComponentType } from "react";
import type { Dict } from "../i18n";
import {
  IconJournal,
  IconPeople,
  IconPulse,
  IconServer,
  IconSummary,
  type IconProps,
} from "../ui/icons";

export interface NavItem {
  to: string;
  /**
   * `labelKey` indexes the active dictionary at render time (`s.nav[labelKey]`):
   * a resolved label here would freeze the navigation to whichever language
   * was active when this module was first imported.
   */
  labelKey: keyof Dict["nav"];
  Icon: ComponentType<IconProps>;
}

// NAV_ITEMS is the app's five sections, in the order 06-ui.md fixes them:
// Сводка · Люди · Пульс · Журнал · Сервер. ONE list, rendered twice by
// Shell.tsx — as the bottom tab bar below `lg:` and as the sidebar above it
// — so the two can never disagree about what the app contains.
//
// Люди is still the LANDING section (routes/index.tsx): being second in the
// bar and being where a login lands are two different decisions, and the
// prototype makes both.
export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/overview", labelKey: "overview", Icon: IconSummary },
  { to: "/people", labelKey: "people", Icon: IconPeople },
  { to: "/pulse", labelKey: "pulse", Icon: IconPulse },
  { to: "/journal", labelKey: "journal", Icon: IconJournal },
  { to: "/server", labelKey: "server", Icon: IconServer },
];

// isNavItemActive — a tab is current for its own path and for everything
// nested under it (/people/$username, /pulse/diag/$domain, /server/config),
// never for a sibling that merely starts with the same characters.
export function isNavItemActive(to: string, pathname: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}
