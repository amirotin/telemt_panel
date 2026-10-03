import type { ComponentType } from "react";
import type { Dict } from "../i18n";
import {
  IconGlobe,
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

// Compact navigation keeps four primary destinations and a separate «Ещё»
// action. Desktop sidebar groups may differ without adding a sixth tab.
//
// Люди is still the LANDING section (routes/index.tsx): being second in the
// bar and being where a login lands are two different decisions, and the
// prototype makes both.
export const OPERATIONAL_NAV_ITEMS: readonly NavItem[] = [
  { to: "/overview", labelKey: "overview", Icon: IconSummary },
  { to: "/people", labelKey: "people", Icon: IconPeople },
  { to: "/pulse", labelKey: "pulse", Icon: IconPulse },
  { to: "/journal", labelKey: "journal", Icon: IconJournal },
];

export const MANAGEMENT_NAV_ITEMS: readonly NavItem[] = [
  { to: "/server", labelKey: "server", Icon: IconServer },
  { to: "/web", labelKey: "web", Icon: IconGlobe },
];

export const NAV_ITEMS: readonly NavItem[] = [
  ...OPERATIONAL_NAV_ITEMS,
  ...MANAGEMENT_NAV_ITEMS,
];

export const SIDEBAR_OVERVIEW_NAV_ITEMS: readonly NavItem[] = [
  ...OPERATIONAL_NAV_ITEMS,
  ...MANAGEMENT_NAV_ITEMS.filter((item) => item.to === "/web"),
];

export const SIDEBAR_MANAGEMENT_NAV_ITEMS: readonly NavItem[] =
  MANAGEMENT_NAV_ITEMS.filter((item) => item.to !== "/web");

// isNavItemActive — a tab is current for its own path and for everything
// nested under it (/people/$username, /pulse/diag/$domain, /server/config),
// never for a sibling that merely starts with the same characters.
export function isNavItemActive(to: string, pathname: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}
