import type { FC } from "react";
import type { DisplayMode } from "../../display-mode";
import type { TopicName } from "../../realtime";
import type { DiagDomain, WidgetId } from "../types";
import { HealthHero } from "./HealthHero";
import { StatRow } from "./StatRow";
import { Problems } from "./Problems";
import { OnlineNow } from "./OnlineNow";
import { DcWidget } from "./DcWidget";
import { UpstreamsWidget } from "./UpstreamsWidget";
import { MePoolWidget } from "./MePoolWidget";
import { WebWidget } from "./WebWidget";
import { SelftestWidget } from "./SelftestWidget";
import { RecentEventsWidget } from "./RecentEventsWidget";
import { QuotasWidget } from "./QuotasWidget";
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
export type WidgetSize =
  | "third"
  | "fiveTwelfths"
  | "half"
  | "sevenTwelfths"
  | "twoThirds"
  | "full"
  | "tiles";

// StackId names a COLUMN several widgets share instead of each taking a
// grid cell of its own. Concept §13's infrastructure cards sit beside the
// data-center board rather than under it: the board spans eight columns and
// the stack spans four, and ME / WEB / Апстримы pile up inside that four —
// which a flat twelve-column grid cannot express, since the second card
// after the board would start a new row at column one.
//
// Consecutive visible widgets declaring the same stack become one cell
// (pulse/layout.ts's overviewCells). A widget's own `size` is then the
// stack's business, not its own.
export type StackId = "infra";

/** The column span each stack takes on the desktop grid. */
export const STACK_SIZE: Record<StackId, WidgetSize> = { infra: "third" };

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
  /**
   * Shares a column with the widgets around it instead of taking a grid
   * cell of its own — see StackId. `size` is ignored for such a widget:
   * STACK_SIZE owns the span.
   */
  stack?: StackId;
  /** Links the widget's "Диагностика →" action to a drill-down page, when one exists. */
  diagDomain?: DiagDomain;
  render: FC<{ onHide?: () => void }>;
}

// Concept §14 removed four cards from Сводка's catalog: Безопасность and
// NAT/STUN belong in their sections and not on the front page, «Активные
// сессии» said what the Соединения KPI and «Онлайн сейчас» already say, and
// the uptime card was folded into the status banner (M5 S1). All four
// domains keep their Пульс diagnostics pages — this is the CATALOG shrinking,
// not the data leaving the panel. layout.ts's migrateLayout drops the ids
// from a stored layout on first load, so a device that had one shown simply
// stops showing it.
//
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
    // "runtime" for the gates the banner's route-mode fact and its
    // «Запускается» state read (healthHero.helpers.ts).
    topics: ["stats", "runtime"],
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
    // 5/12 beside «Онлайн сейчас»'s 7/12 (concept §7): the problem rows are
    // short lines, the online rows carry four figures each, and an even
    // split left one card padded and the other cramped.
    size: "fiveTwelfths",
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
    // 7/12 beside «Проблемы»'s 5/12 (concept §7): each row carries a name
    // and three figures, and at half width the figures wrapped.
    size: "sevenTwelfths",
    hideable: true,
    render: OnlineNow,
  },
  {
    id: "dc",
    topics: ["upstreams"],
    minMode: "basic",
    // Eight of twelve columns: the board is six nodes wide on a desktop
    // and three on a phone, and the four columns it leaves are concept
    // §13's infrastructure stack standing beside it.
    size: "twoThirds",
    hideable: true,
    diagDomain: "dc",
    render: DcWidget,
  },
  // ME, WEB and Апстримы are concept §13's infrastructure level. They do
  // not form a row of their own: they STACK in the four columns beside the
  // data-center board, in that order.
  {
    id: "me_pool",
    topics: ["runtime"],
    // In the standard density, not the extended one: §13 calls this level
    // part of the dashboard, and the card is now a five-line summary rather
    // than the pool-internals dump it used to be.
    minMode: "basic",
    size: "third",
    stack: "infra",
    hideable: true,
    // No diagDomain: the card's whole body is the link to /pulse/diag/me,
    // so a second header link to the same page would only be noise.
    render: MePoolWidget,
  },
  {
    id: "web",
    topics: ["web"],
    // §13 counts WEB as part of the dashboard's infrastructure level, so
    // the standard density shows it — including on the builds where all it
    // has to say is «Нет в этой версии».
    minMode: "basic",
    size: "third",
    stack: "infra",
    hideable: true,
    // No diagDomain: the card's whole body is the link to /pulse/diag/web.
    render: WebWidget,
  },
  {
    id: "upstreams",
    // "runtime" is also subscribed for upstream_quality's compact
    // extended-mode success-rate line (mini-task 2c) — a secondary source,
    // not this widget's primary one.
    topics: ["upstreams", "runtime"],
    minMode: "basic",
    size: "third",
    stack: "infra",
    hideable: true,
    diagDomain: "upstreams",
    render: UpstreamsWidget,
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
    // Concept §20 closes the page with the event timeline, which puts it in
    // the standard density rather than behind the extended one.
    minMode: "basic",
    // Half the grid, beside «Квоты и сроки». The rail's row is a marker,
    // one line of words and a relative stamp; at full width the line ran out
    // long before the card did, and coalescing made the rows shorter still.
    size: "half",
    hideable: true,
    // No diagDomain: «Все события →» in the header is that link, and M4
    // task 8's page (all fifty records behind a family filter) is where it
    // goes (spec §23.5).
    render: RecentEventsWidget,
  },
  {
    // «Квоты и сроки» — the people whose access is about to stop working,
    // half the grid beside the event timeline.
    id: "quotas",
    topics: ["users"],
    minMode: "basic",
    size: "half",
    hideable: true,
    // No diagDomain: this is a people question, and «Все люди →» in the
    // header is where it goes.
    render: QuotasWidget,
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

// DEFAULT_LAYOUT is the dashboard's out-of-the-box ordered widget list, in
// concept §20's desktop order: status banner, KPI tiles, Проблемы beside
// Онлайн, the data-center board, the infrastructure row, the event
// timeline. An existing user's stored layout is NOT rewritten to match:
// migrateLayout only re-inserts non-hideable ids, so this is the first-run
// set, not a forced one.
export const DEFAULT_LAYOUT: WidgetId[] = [
  "health_hero",
  "stat_row",
  "problems",
  "online_now",
  "dc",
  "me_pool",
  "recent_events",
];

export function getWidgetDef(id: WidgetId): WidgetDef | undefined {
  return WIDGETS.find((w) => w.id === id);
}
