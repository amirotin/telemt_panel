import { Link } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { DcStatus, UpstreamsTopic } from "../../realtime/topics";
import { Skeleton } from "../../ui/Skeleton";
import { EmptyState } from "../../ui/EmptyState";
import { StatePill } from "../../ui/StatePill";
import { fill, formatNumber, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { WidgetFrame } from "../WidgetFrame";
import { GatedNote } from "../GatedNote";
import { dcEntityKey } from "../details-builder/definitions/dc";
import {
  computeDc,
  dcCoverageState,
  dcNodeAriaLabel,
  dcRouteState,
  dcRouteGroups,
  dcRttTone,
  type DcRouteGroup,
} from "./dc.helpers";

type RouteKind = "main" | "media";
type RouteState = "ok" | "warn" | "error";

const COVERAGE_GRADIENT: Record<RouteState, string> = {
  ok: "linear-gradient(180deg, rgba(63, 185, 80, .30), rgba(63, 185, 80, .06))",
  warn: "linear-gradient(180deg, rgba(210, 153, 34, .30), rgba(210, 153, 34, .06))",
  error: "linear-gradient(180deg, rgba(248, 81, 73, .30), rgba(248, 81, 73, .06))",
};

// +N and −N are one logical DC with two independently monitored routes.
// Coverage is the tank level, while RTT stays the dominant numeric value.
export function DcWidget() {
  const s = useStrings();
  const topic = useSnapshot<UpstreamsTopic>("upstreams");
  const view = computeDc(topic.data?.dcs ?? null);
  const groups = view.status === "ok" ? dcRouteGroups(view.dcs) : [];
  const hasAttention = view.status === "ok" && view.dcs.some((dc) => dcRouteState(dc) !== "ok");

  return (
    <WidgetFrame
      title={s.pulse.widgets.dc}
      diagDomain="dc"
      stale={topic.stale}
      badge={
        view.status === "ok" && view.dcs.length > 0 ? (
          <span
            className={cn(
              "shrink-0 whitespace-nowrap text-micro font-semibold tabular-nums text-accent",
              hasAttention && "text-warn",
            )}
          >
            <span className="sm:hidden">
              {fill(s.pulse.dc.fleetCount, { count: formatNumber(s, groups.length) })}
            </span>
            <span className="hidden sm:inline">
              {fill(s.pulse.dc.groupCount, {
                groups: formatNumber(s, groups.length),
                routes: formatNumber(s, view.dcs.length),
              })}
            </span>
          </span>
        ) : undefined
      }
    >
      {view.status === "loading" && <Skeleton className="h-64 w-full" />}
      {view.status === "disabled" && <GatedNote reason={view.reason} />}
      {view.status === "ok" && view.dcs.length === 0 && <EmptyState title={s.pulse.dc.empty} />}
      {view.status === "ok" && view.dcs.length > 0 && (
        <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 xl:grid-cols-3" data-testid="dc-board">
          {groups.map((group, index) => (
            <DcGroup key={group.id} group={group} index={index} />
          ))}
        </div>
      )}
    </WidgetFrame>
  );
}

function groupState(group: DcRouteGroup<DcStatus>): RouteState {
  const states = [group.main, group.media].filter((dc): dc is DcStatus => dc !== undefined).map(dcRouteState);
  if (states.includes("error")) return "error";
  if (states.includes("warn")) return "warn";
  return "ok";
}

function stateLabel(state: RouteState, s: ReturnType<typeof useStrings>) {
  if (state === "error") return s.pulse.dc.state.unavailable;
  if (state === "warn") return s.pulse.dc.state.attention;
  return s.pulse.dc.state.healthy;
}

function DcGroup({ group, index }: { group: DcRouteGroup<DcStatus>; index: number }) {
  const s = useStrings();
  const state = groupState(group);
  const name = fill(s.pulse.dc.mainName, { dc: formatNumber(s, group.id) });

  return (
    <section
      aria-label={`${name}: ${stateLabel(state, s)}`}
      className={cn(
        "relative min-w-0 border-border/60",
        index > 0 && "border-t pt-4",
        index < 2 && "sm:border-t-0 sm:pt-0",
        index >= 2 && "sm:border-t sm:pt-4",
        index < 3 && "xl:border-t-0 xl:pt-0",
        index >= 3 && "xl:border-t xl:pt-4",
      )}
      data-state={state}
      data-testid={`dc-group-${group.id}`}
    >
      {index % 2 === 1 && (
        <span
          aria-hidden="true"
          data-testid="dc-divider-vertical"
          className="absolute -left-2 inset-y-0 hidden w-px bg-border/60 sm:block xl:hidden"
        />
      )}
      {index % 3 !== 0 && (
        <span
          aria-hidden="true"
          data-testid="dc-divider-vertical"
          className="absolute -left-2 inset-y-0 hidden w-px bg-border/60 xl:block"
        />
      )}
      <div className="mb-2 flex h-6 items-start gap-2 px-0.5">
        <h3 className="text-[14px] font-semibold leading-[18px] text-text">{name}</h3>
        {group.id === 203 && (
          <span className="rounded-md bg-accent/15 px-1.5 py-0.5 text-[9px] font-extrabold uppercase leading-[14px] text-accent">
            {s.pulse.dc.cdn}
          </span>
        )}
        <StatePill state={state} className="ml-auto !px-2 !py-0.5">
          {stateLabel(state, s)}
        </StatePill>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        {group.main ? <DcRoute dc={group.main} kind="main" /> : <MissingRoute kind="main" />}
        {group.media ? <DcRoute dc={group.media} kind="media" /> : <MissingRoute kind="media" />}
      </div>
    </section>
  );
}

function DcRoute({ dc, kind }: { dc: DcStatus; kind: RouteKind }) {
  const s = useStrings();
  const coverageState = dcCoverageState(dc);
  const coverage = Math.max(0, Math.min(100, dc.coverage_pct));
  const rttWarning = dcRttTone(dc.rtt_ms) === "warn";
  const rtt = dc.rtt_ms === null ? "—" : formatNumber(s, Math.round(dc.rtt_ms));
  const signedId = dc.dc < 0 ? `−${formatNumber(s, Math.abs(dc.dc))}` : `+${formatNumber(s, dc.dc)}`;

  return (
    <Link
      to="/pulse/diag/$domain"
      params={{ domain: "dc" }}
      search={{ entity: dcEntityKey(dc) }}
      aria-label={dcNodeAriaLabel(dc, s)}
      data-rtt-warning={rttWarning}
      data-testid={`dc-card-${dc.dc}`}
      className={cn(
        "group relative block h-[116px] min-w-0 overflow-hidden rounded-[10px] border border-border-strong bg-surface-sunken outline-none transition-colors",
        "hover:border-accent/45 focus-visible:ring-2 focus-visible:ring-accent",
      )}
    >
      <span
        aria-hidden="true"
        data-testid="dc-coverage-fill"
        data-coverage={coverage}
        className={cn("absolute inset-x-0 bottom-0", coverage < 100 && "border-t-2")}
        style={{
          height: `${coverage}%`,
          borderTopColor: coverageState === "error" ? "#f85149" : coverageState === "warn" ? "#d29922" : "#3fb950",
          background: COVERAGE_GRADIENT[coverageState],
        }}
      />

      <div className="relative z-[1] flex items-center gap-1.5 px-[11px] pt-[9px]">
        <span
          aria-hidden="true"
          className={cn(
            "h-[7px] w-[7px] shrink-0 rounded-full",
            coverageState === "error" ? "bg-error" : coverageState === "warn" ? "bg-warn" : "bg-ok",
          )}
        />
        <strong className="text-[13px] leading-4 text-text">
          {kind === "media" ? s.pulse.dc.mediaRoute : s.pulse.dc.mainRoute}
        </strong>
        <small className="font-mono text-[10px] tabular-nums text-text-muted">{signedId}</small>
      </div>

      <CoverageScale />

      <div className="absolute bottom-2 left-[11px] right-[29px] z-[1]">
        <div className="flex items-baseline gap-1 whitespace-nowrap">
          <strong
            className={cn(
              "font-mono text-[24px] leading-6 tracking-[-0.045em] text-text",
              rttWarning && "text-warn",
            )}
          >
            {rtt}
          </strong>
          <span className={cn("text-[9px] text-text-muted", rttWarning && "text-warn")}>
            {s.pulse.dc.rttUnit} RTT
          </span>
        </div>
        <div className="mt-0.5 flex items-baseline gap-1 whitespace-nowrap">
          <strong
            className={cn(
              "text-[11px] text-text",
              coverageState !== "ok" && (coverageState === "error" ? "text-error" : "text-warn"),
            )}
          >
            {formatNumber(s, dc.alive_writers)}/{formatNumber(s, dc.required_writers)}
          </strong>
          <span className="text-[10px] lowercase text-text-muted">{s.pulse.dc.writers}</span>
        </div>
      </div>
    </Link>
  );
}

function CoverageScale() {
  const marks = [
    { value: 100, className: "top-0", labelClassName: "top-1" },
    { value: 66, className: "top-[34%]", labelClassName: "top-1/2 -translate-y-1/2" },
    { value: 33, className: "top-[67%]", labelClassName: "top-1/2 -translate-y-1/2" },
    { value: 0, className: "bottom-0", labelClassName: "bottom-[3px]" },
  ] as const;

  return (
    <span
      aria-hidden="true"
      data-testid="dc-coverage-scale"
      className="pointer-events-none absolute inset-y-1.5 right-1.5 z-[1] w-6"
    >
      <span className="absolute inset-y-0 right-0 w-px bg-text-muted/30" />
      {marks.map((mark) => (
        <i
          key={mark.value}
          className={cn("absolute right-0 h-px w-2 border-t border-text-muted/40 not-italic", mark.className)}
        >
          <b
            className={cn(
              "absolute right-2.5 font-mono text-[8px] font-semibold leading-none text-text/45",
              mark.labelClassName,
            )}
          >
            {mark.value}
          </b>
        </i>
      ))}
    </span>
  );
}

function MissingRoute({ kind }: { kind: RouteKind }) {
  const s = useStrings();
  return (
    <div className="flex h-[116px] min-w-0 flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-border-strong bg-surface-sunken px-2 text-center text-micro text-text-faint">
      <span className="h-[7px] w-[7px] rounded-full bg-text-faint" aria-hidden="true" />
      <span>{kind === "media" ? s.pulse.dc.mediaRoute : s.pulse.dc.mainRoute}</span>
      <span>{s.pulse.dc.routeMissing}</span>
    </div>
  );
}
