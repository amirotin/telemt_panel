import type { FC } from "react";
import { ru } from "../../i18n/ru";
import type { DisplayMode } from "../../display-mode";
import type { TopicName } from "../../realtime";
import type { DiagDomain, WidgetId } from "../types";
import { HealthHero } from "./HealthHero";
import { StatRow } from "./StatRow";
import { Problems } from "./Problems";
import { ActiveSessions } from "./ActiveSessions";
import { DcWidget } from "./DcWidget";
import { UpstreamsWidget } from "./UpstreamsWidget";
import { MePoolWidget } from "./MePoolWidget";
import { NatStunWidget } from "./NatStunWidget";
import { SelftestWidget } from "./SelftestWidget";
import { RecentEventsWidget } from "./RecentEventsWidget";
import { SecurityPostureWidget } from "./SecurityPostureWidget";
import { TlsFingerprintsWidget } from "./TlsFingerprintsWidget";

export type FormFactor = "stat" | "card" | "wide" | "table";

export interface WidgetDef {
  id: WidgetId;
  /** Resolved Russian label (ru.pulse.widgets[id]) — not a translation key, per the single-strings-module rule. */
  title: string;
  topics: TopicName[];
  minMode: DisplayMode;
  formFactor: FormFactor;
  /** false only for health_hero — every other widget can be hidden from the layout editor. */
  hideable: boolean;
  /** Links the widget's "Диагностика →" action to a drill-down page, when one exists. */
  diagDomain?: DiagDomain;
  render: FC<{ onHide?: () => void }>;
}

// WIDGETS is the single registry driving the dashboard's catalog (layout
// editor's checkbox list), its default/migrated layout, and its actual
// rendering — 06-ui.md: "один реестр виджетов — каталог и раскладка
// строятся из него, никакого дублирования". health_hero is always first
// and non-hideable; layout.ts's migration/reset logic and the registry
// invariants test both assume that.
export const WIDGETS: WidgetDef[] = [
  {
    id: "health_hero",
    title: ru.pulse.widgets.health_hero,
    topics: ["stats"],
    minMode: "critical",
    formFactor: "wide",
    hideable: false,
    render: HealthHero,
  },
  {
    id: "stat_row",
    title: ru.pulse.widgets.stat_row,
    topics: ["stats"],
    minMode: "basic",
    formFactor: "wide",
    hideable: true,
    render: StatRow,
  },
  {
    id: "problems",
    title: ru.pulse.widgets.problems,
    topics: ["stats", "runtime", "upstreams", "security"],
    minMode: "critical",
    formFactor: "card",
    hideable: true,
    render: Problems,
  },
  {
    id: "active_sessions",
    title: ru.pulse.widgets.active_sessions,
    topics: ["stats"],
    minMode: "basic",
    formFactor: "card",
    hideable: true,
    diagDomain: "connections",
    render: ActiveSessions,
  },
  {
    id: "dc",
    title: ru.pulse.widgets.dc,
    topics: ["upstreams"],
    minMode: "basic",
    formFactor: "table",
    hideable: true,
    diagDomain: "dc",
    render: DcWidget,
  },
  {
    id: "upstreams",
    title: ru.pulse.widgets.upstreams,
    // "runtime" is also subscribed for upstream_quality's compact
    // extended-mode success-rate line (mini-task 2c) — a secondary source,
    // not this widget's primary one.
    topics: ["upstreams", "runtime"],
    minMode: "basic",
    formFactor: "table",
    hideable: true,
    diagDomain: "upstreams",
    render: UpstreamsWidget,
  },
  {
    id: "security_posture",
    title: ru.pulse.widgets.security_posture,
    topics: ["security"],
    minMode: "basic",
    formFactor: "card",
    hideable: true,
    diagDomain: "security",
    render: SecurityPostureWidget,
  },
  {
    id: "me_pool",
    title: ru.pulse.widgets.me_pool,
    topics: ["runtime"],
    minMode: "extended",
    formFactor: "card",
    hideable: true,
    diagDomain: "me",
    render: MePoolWidget,
  },
  {
    id: "nat_stun",
    title: ru.pulse.widgets.nat_stun,
    topics: ["runtime"],
    minMode: "extended",
    formFactor: "card",
    hideable: true,
    diagDomain: "nat",
    render: NatStunWidget,
  },
  {
    id: "selftest",
    title: ru.pulse.widgets.selftest,
    topics: ["runtime"],
    minMode: "extended",
    formFactor: "card",
    hideable: true,
    diagDomain: "me",
    render: SelftestWidget,
  },
  {
    id: "recent_events",
    title: ru.pulse.widgets.recent_events,
    topics: ["runtime"],
    minMode: "extended",
    formFactor: "card",
    hideable: true,
    render: RecentEventsWidget,
  },
  {
    id: "tls_fingerprints",
    title: ru.pulse.widgets.tls_fingerprints,
    topics: ["security"],
    minMode: "extended",
    formFactor: "table",
    hideable: true,
    diagDomain: "security",
    render: TlsFingerprintsWidget,
  },
];

// DEFAULT_LAYOUT is the dashboard's out-of-the-box ordered widget list
// (06-ui.md: "HealthHero, стат-ряд, Проблемы").
export const DEFAULT_LAYOUT: WidgetId[] = ["health_hero", "stat_row", "problems"];

export function getWidgetDef(id: WidgetId): WidgetDef | undefined {
  return WIDGETS.find((w) => w.id === id);
}
