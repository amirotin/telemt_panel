import type { FC } from "react";
import type { DisplayMode } from "../../display-mode";
import type { TopicName } from "../../realtime";
import type { DiagDomain, WidgetId } from "../types";
import { HealthHero } from "./HealthHero";
import { StatRow } from "./StatRow";
import { Problems } from "./Problems";
import { ActiveSessions } from "./ActiveSessions";
import { OnlineNow } from "./OnlineNow";
import { DcWidget } from "./DcWidget";
import { UpstreamsWidget } from "./UpstreamsWidget";
import { MePoolWidget } from "./MePoolWidget";
import { NatStunWidget } from "./NatStunWidget";
import { SelftestWidget } from "./SelftestWidget";
import { RecentEventsWidget } from "./RecentEventsWidget";
import { SecurityPostureWidget } from "./SecurityPostureWidget";
import { TlsFingerprintsWidget } from "./TlsFingerprintsWidget";

// WidgetSize is the widget's span in Сводка's desktop grid (12 columns
// from `lg:`, one column below it). A widget declares the shape it wants
// and the page turns that into a span class — no widget writes a
// `col-span-*` of its own, and the layout editor's order/hide semantics
// never look at this field.
//
// "tiles" is the one shape that is not a single cell: such a widget renders
// its OWN grid cells as siblings of the other widgets (Показатели's four
// three-column tiles), so the page must not wrap it in a column div.
export type WidgetSize = "third" | "half" | "twoThirds" | "full" | "tiles";

export interface WidgetDef {
  /** Also the dictionary key its title comes from — `s.pulse.widgets[id]`. */
  id: WidgetId;
  /**
   * SSE topics this widget reads. Omitted by a widget whose data comes from
   * a REST endpoint on its own cadence instead of the hub (tls_fingerprints).
   */
  topics?: TopicName[];
  minMode: DisplayMode;
  /** Span on Сводка's 12-column desktop grid; ignored below `lg:`, where every widget is one full-width column. */
  size: WidgetSize;
  /** false only for health_hero — every other widget can be hidden from the layout editor. */
  hideable: boolean;
  /** Links the widget's "Диагностика →" action to a drill-down page, when one exists. */
  diagDomain?: DiagDomain;
  render: FC<{ onHide?: () => void }>;
}

// WIDGETS is the single registry driving the dashboard's catalog (layout
// editor's checkbox list), its default/migrated layout, and its actual
// rendering — 06-ui.md: "один реестр виджетов — каталог и раскладка
// строятся из него, никакого дублирования". The title is NOT stored here:
// it is `s.pulse.widgets[id]` in the active dictionary, resolved where it is
// rendered, so a language switch does not need the registry rebuilt.
// health_hero is always first
// and non-hideable; layout.ts's migration/reset logic and the registry
// invariants test both assume that.
export const WIDGETS: WidgetDef[] = [
  {
    id: "health_hero",
    topics: ["stats"],
    minMode: "critical",
    size: "full",
    hideable: false,
    render: HealthHero,
  },
  {
    id: "stat_row",
    topics: ["stats"],
    minMode: "basic",
    // "tiles": four three-column cells of its own on the desktop grid, one
    // titled card with four rows on a phone (StatRow.tsx).
    size: "tiles",
    hideable: true,
    render: StatRow,
  },
  {
    id: "problems",
    topics: ["stats", "runtime", "upstreams", "security"],
    minMode: "critical",
    size: "third",
    hideable: true,
    render: Problems,
  },
  {
    // «Онлайн сейчас» (06-ui.md §Информационная архитектура): a dashboard
    // widget rather than a fixed page block, so it obeys the same layout,
    // ordering and display-mode rules as everything else on Сводка.
    id: "online_now",
    topics: ["users"],
    minMode: "basic",
    size: "half",
    hideable: true,
    render: OnlineNow,
  },
  {
    id: "active_sessions",
    topics: ["stats"],
    minMode: "basic",
    size: "third",
    hideable: true,
    diagDomain: "connections",
    render: ActiveSessions,
  },
  {
    id: "dc",
    topics: ["upstreams"],
    minMode: "basic",
    size: "half",
    hideable: true,
    diagDomain: "dc",
    render: DcWidget,
  },
  {
    id: "upstreams",
    // "runtime" is also subscribed for upstream_quality's compact
    // extended-mode success-rate line (mini-task 2c) — a secondary source,
    // not this widget's primary one.
    topics: ["upstreams", "runtime"],
    minMode: "basic",
    size: "half",
    hideable: true,
    diagDomain: "upstreams",
    render: UpstreamsWidget,
  },
  {
    id: "security_posture",
    topics: ["security"],
    minMode: "basic",
    size: "third",
    hideable: true,
    diagDomain: "security",
    render: SecurityPostureWidget,
  },
  {
    id: "me_pool",
    topics: ["runtime"],
    minMode: "extended",
    size: "third",
    hideable: true,
    diagDomain: "me",
    render: MePoolWidget,
  },
  {
    id: "nat_stun",
    topics: ["runtime"],
    minMode: "extended",
    size: "third",
    hideable: true,
    diagDomain: "nat",
    render: NatStunWidget,
  },
  {
    id: "selftest",
    topics: ["runtime"],
    minMode: "extended",
    size: "third",
    hideable: true,
    diagDomain: "me",
    render: SelftestWidget,
  },
  {
    id: "recent_events",
    topics: ["runtime"],
    minMode: "extended",
    size: "half",
    hideable: true,
    // M4 task 8 gave the domain a page: the card shows the last few lines,
    // «Диагностика →» opens all fifty with a filter (spec §23.5).
    diagDomain: "events",
    render: RecentEventsWidget,
  },
  {
    // No `topics`: this widget left the SSE topics in M4 task 1 and fetches
    // GET /api/telemt/tls-fingerprints itself (useTlsFingerprints).
    id: "tls_fingerprints",
    minMode: "extended",
    size: "half",
    hideable: true,
    diagDomain: "security",
    render: TlsFingerprintsWidget,
  },
];

// DEFAULT_LAYOUT is the dashboard's out-of-the-box ordered widget list
// (06-ui.md: "HealthHero, стат-ряд, Проблемы", plus «Онлайн сейчас» — the
// prototype's Сводка puts it directly under Проблемы). An existing user's
// stored layout is NOT rewritten to match: migrateLayout only re-inserts
// non-hideable ids, so this is the first-run set, not a forced one.
export const DEFAULT_LAYOUT: WidgetId[] = [
  "health_hero",
  "stat_row",
  "problems",
  "online_now",
];

export function getWidgetDef(id: WidgetId): WidgetDef | undefined {
  return WIDGETS.find((w) => w.id === id);
}
