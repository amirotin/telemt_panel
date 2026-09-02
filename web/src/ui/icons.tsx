import type { SVGProps } from "react";

// icons.tsx — the app's whole icon set as inline SVG components. No icon
// package: web/README.md's dependency rule keeps the bundle to the
// approved list, and the prototype (v2/design/*.dc.html) draws every glyph
// with the same 24×24 / stroke-2 / currentColor grammar these reproduce.
// Emoji are deliberately NOT used anywhere — they render as a different
// typeface (and a different metric) on every platform, which is what made
// the first shipped shell look unstyled.
//
// Every icon is aria-hidden and sized 1em by default: callers set the box
// with `className="h-4 w-4"` and the color with `text-*`. The accessible
// name always comes from adjacent text or the wrapping control's
// aria-label, never from the icon.

export type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

// --- navigation (prototype sidebar / tab bar) ---

export function IconPeople(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <circle cx="16.5" cy="9" r="2.4" />
      <path d="M16 14.2c2.5.2 4.5 2 4.5 4.3" />
    </Icon>
  );
}

export function IconPulse(props: IconProps) {
  return (
    <Icon {...props}>
      <polyline points="2,12 7,12 10,5 14,19 17,12 22,12" />
    </Icon>
  );
}

export function IconJournal(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 5h16M4 10h16M4 15h10M4 20h7" />
    </Icon>
  );
}

export function IconServer(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
    </Icon>
  );
}

export function IconSummary(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="5" rx="1.5" />
      <rect x="13" y="10" width="8" height="11" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
    </Icon>
  );
}

// --- controls ---

export function IconMore(props: IconProps) {
  return (
    <Icon {...props} strokeWidth={2.4}>
      <circle cx="12" cy="5" r="0.6" />
      <circle cx="12" cy="12" r="0.6" />
      <circle cx="12" cy="19" r="0.6" />
    </Icon>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function IconEdit(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20l4.2-1 10.9-10.9a2.1 2.1 0 0 0-3-3L5.2 16 4 20z" />
      <path d="M14.5 6.5l3 3" />
    </Icon>
  );
}

export function IconMinus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14" />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4 12.5 5 5L20 6.5" />
    </Icon>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" />
    </Icon>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3-3" />
    </Icon>
  );
}

export function IconSort(props: IconProps) {
  return (
    <Icon {...props} strokeWidth={2.2}>
      <path d="M7 4v14M4 15l3 3 3-3M17 20V6M14 9l3-3 3 3" />
    </Icon>
  );
}

export function IconArrowUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Icon>
  );
}

export function IconArrowDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </Icon>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m15 5-7 7 7 7" />
    </Icon>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 5 7 7-7 7" />
    </Icon>
  );
}

export function IconEye(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4l16 16" />
      <path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.3 4.1" />
      <path d="M6.5 7.9A16.7 16.7 0 0 0 2.5 12S6 18.5 12 18.5a9.7 9.7 0 0 0 3.6-.7" />
      <path d="M9.9 10a3 3 0 0 0 4.2 4.2" />
    </Icon>
  );
}

export function IconQr(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="6" height="6" />
      <rect x="14" y="4" width="6" height="6" />
      <rect x="4" y="14" width="6" height="6" />
      <path d="M14 14h3v3h-3zM19 19h1" />
    </Icon>
  );
}

export function IconShare(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3v12M7 8l5-5 5 5" />
      <path d="M4 15v4h16v-4" />
    </Icon>
  );
}

export function IconLogout(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15 17l5-5-5-5" />
      <path d="M20 12H9" />
      <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6" />
    </Icon>
  );
}

export function IconPower(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6 18.4 18.4" />
    </Icon>
  );
}

export function IconStar(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m12 4 2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8z" />
    </Icon>
  );
}

// --- Сервер menu (one per subpage) ---

export function IconWrench(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15.5 3.5a5 5 0 0 0-5.9 6.6L3.6 16.1a2 2 0 0 0 2.8 2.8l6-6a5 5 0 0 0 6.6-5.9l-2.8 2.8-2.4-.6-.6-2.4z" />
    </Icon>
  );
}

export function IconUpgrade(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 20V6M6 12l6-6 6 6" />
      <path d="M5 3h14" />
    </Icon>
  );
}

export function IconShield(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3 5 6v5.5c0 4.3 3 8.1 7 9.5 4-1.4 7-5.2 7-9.5V6z" />
    </Icon>
  );
}

// IconShieldAlert — the shield with an exclamation: refused/rejected
// traffic, as opposed to IconShield's plain "security posture" glyph.
export function IconShieldAlert(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3 5 6v5.5c0 4.3 3 8.1 7 9.5 4-1.4 7-5.2 7-9.5V6z" />
      <path d="M12 8.5v3.8M12 15.6h.01" />
    </Icon>
  );
}

// IconTag — a version/build label (the Сводка banner's «версия Telemt»).
export function IconTag(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 11.6V4.5a1 1 0 0 1 1-1h7.1a1 1 0 0 1 .7.3l8 8a1 1 0 0 1 0 1.4l-7.1 7.1a1 1 0 0 1-1.4 0l-8-8a1 1 0 0 1-.3-.7z" />
      <path d="M7.6 7.6h.01" />
    </Icon>
  );
}

export function IconPlatform(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </Icon>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.7 15H3.5a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.2-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 4.3V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.3 1.1z" />
    </Icon>
  );
}

// --- Пульс / Журнал / Сервер (D2) ---

export function IconChevronDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function IconChevronUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 15 6-6 6 6" />
    </Icon>
  );
}

export function IconPause(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </Icon>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 4.5v15l12-7.5z" />
    </Icon>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
    </Icon>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 11a8 8 0 1 0-.7 4.3" />
      <path d="M20 4v7h-7" />
    </Icon>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </Icon>
  );
}

export function IconActivity(props: IconProps) {
  return (
    <Icon {...props}>
      <polyline points="2,12 7,12 10,5 14,19 17,12 22,12" />
    </Icon>
  );
}

export function IconTraffic(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 21V9m0 0L4.5 12.5M8 9l3.5 3.5" />
      <path d="M16 3v12m0 0 3.5-3.5M16 15l-3.5-3.5" />
    </Icon>
  );
}

export function IconLink(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </Icon>
  );
}

export function IconGlobe(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
    </Icon>
  );
}

export function IconDevice(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <path d="M12 18h.01" />
    </Icon>
  );
}

export function IconDesktop(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="4" width="19" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </Icon>
  );
}

export function IconTerminal(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 8 4 4-4 4M12 16h7" />
    </Icon>
  );
}

export function IconWarning(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.5 2.8 20h18.4z" />
      <path d="M12 10v4M12 17.2h.01" />
    </Icon>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </Icon>
  );
}

export function IconUserPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10" cy="8" r="3.4" />
      <path d="M3.5 20c0-3.2 2.9-5.5 6.5-5.5" />
      <path d="M17 13v6M14 16h6" />
    </Icon>
  );
}

// --- events timeline (concept §15's category glyphs) ---
//
// The concept names six categories with typographic stand-ins — `↻ ◎ ⇄ ♙ ⚠
// ✕`. Four of them already had a glyph here (IconRefresh, IconPeople,
// IconWarning, IconClose); these two are the ones that did not, drawn in
// the same 24×24 / stroke-2 grammar so a timeline rail reads as one set.

// IconTarget — `◎`, a listener: concentric rings around a bound port.
export function IconTarget(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.2" />
    </Icon>
  );
}

// IconSwap — `⇄`, routing and fallback: two arrows pointing opposite ways.
export function IconSwap(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9h15M15.5 5.5 19 9l-3.5 3.5" />
      <path d="M20 17H5M8.5 13.5 5 17l3.5 3.5" />
    </Icon>
  );
}

export function IconTelegram(props: IconProps) {
  return (
    <Icon {...props} fill="currentColor" stroke="none">
      <path d="M21.9 4.6 18.9 19c-.2 1-.8 1.2-1.6.8l-4.6-3.4-2.2 2.1c-.2.3-.5.5-.9.5l.3-4.6L18.3 7c.4-.3-.1-.5-.6-.2L7.4 13.3 3 11.9c-1-.3-1-1 .2-1.4l17.3-6.7c.8-.3 1.5.2 1.4.8z" />
    </Icon>
  );
}
