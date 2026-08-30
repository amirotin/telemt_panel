import { Link } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { DcStatus, UpstreamsTopic } from "../../realtime/topics";
import type { State } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { EmptyState } from "../../ui/EmptyState";
import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { WidgetFrame } from "../WidgetFrame";
import { GatedNote } from "../GatedNote";
import { dcEntityKey } from "../details-builder/definitions/dc";
import {
  computeDc,
  dcBoardRows,
  dcNodeAriaLabel,
  dcNodeTone,
  dcRttText,
  dcRttTone,
  dcWriterDots,
  isTestDc,
} from "./dc.helpers";

// The ring's geometry, in the SVG's own 40-unit box: r = 17 with a 2-unit
// stroke leaves the circle just inside the viewBox and its own width at
// ~6 % of the diameter — the "тонкое кольцо" of concept §9, thin enough
// that the number inside it, not the ring, is what the eye lands on first.
const RING_RADIUS = 17;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const RING_STROKE: Record<State, string> = {
  ok: "text-ok",
  warn: "text-warn",
  error: "text-error",
  muted: "text-text-faint",
};

const DOT_ON: Record<State, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  error: "bg-error",
  muted: "bg-text-faint",
};

// DcWidget — «Дата-центры» as concept §8–9's board of DC Nodes, replacing
// the strip of tinted mini-cards the concept calls out by name ("выглядят
// как мини-таблицы, плохо читаются"). Each node is ~88×72: the id inside a
// coverage ring, writers as dots, RTT as a number. The card stays dark
// throughout — a healthy DC is NOT a green tile (§9), the ring is the only
// thing that carries colour.
//
// Two rows on a desktop (§9's «Альтернативная компоновка»: negative ids
// over positive ones, paired by column), three columns on a phone (§21) —
// one markup, because the rows are two separate grids and each wraps on its
// own. The board spans eight of the page's twelve columns and fills them;
// the remaining four are the infrastructure stack beside it (§13).
export function DcWidget({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const topic = useSnapshot<UpstreamsTopic>("upstreams");
  const view = computeDc(topic.data?.dcs ?? null);

  // No "12/12" badge any more: the board IS that count, node for node, and
  // §2.1's rule against saying the same thing twice is also what keeps the
  // title from being truncated to «Дат…» on a 360px header.
  return (
    <WidgetFrame title={s.pulse.widgets.dc} diagDomain="dc" onHide={onHide} stale={topic.stale}>
      {view.status === "loading" && <Skeleton className="h-40 w-full" />}
      {view.status === "disabled" && <GatedNote reason={view.reason} />}
      {view.status === "ok" && view.dcs.length === 0 && <EmptyState title={s.pulse.dc.empty} />}
      {view.status === "ok" && view.dcs.length > 0 && (
        // The board fills the eight columns the widget spans: the nodes and
        // the gutter between them grow with it rather than leaving a
        // centred island of whitespace on either side.
        <div className="flex w-full flex-col gap-2 lg:gap-3">
          {dcBoardRows(view.dcs).map((row) => (
            <ul key={row[0]!.dc} className="grid grid-cols-3 gap-2 lg:grid-cols-6 lg:gap-3">
              {row.map((dc) => (
                <li key={dc.dc}>
                  <DcNode dc={dc} />
                </li>
              ))}
            </ul>
          ))}
        </div>
      )}
    </WidgetFrame>
  );
}

// Exported for DcNode.test.tsx: the node is the piece with the geometry and
// the tones in it, and a test that had to stand up the whole widget would
// need the SSE context as well as the router just to look at one tile.
export function DcNode({ dc }: { dc: DcStatus }) {
  const s = useStrings();
  const tone = dcNodeTone(dc);
  const dots = dcWriterDots(dc);
  const rttWarn = dcRttTone(dc.rtt_ms) === "warn";
  // Never below zero and never past the full circle: Telemt reports
  // coverage as a percentage of the floor, which a DC can exceed.
  const covered = Math.min(Math.max(dc.coverage_pct, 0), 100) / 100;

  return (
    <Link
      to="/pulse/diag/$domain"
      params={{ domain: "dc" }}
      search={{ entity: dcEntityKey(dc) }}
      aria-label={dcNodeAriaLabel(dc, s)}
      data-testid="dc-node"
      className={cn(
        "flex h-full min-h-[72px] flex-col items-center gap-0.5 rounded-lg border border-border bg-surface-2 px-1 py-1 lg:min-h-[84px] lg:gap-1 lg:py-2",
        "transition-colors hover:border-accent/40 hover:bg-surface-3",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      )}
    >
      <span className="relative flex h-8 w-8 items-center justify-center lg:h-10 lg:w-10">
        <svg viewBox="0 0 40 40" className="h-8 w-8 -rotate-90 lg:h-10 lg:w-10" aria-hidden="true">
          <circle
            cx="20"
            cy="20"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-border"
          />
          <circle
            cx="20"
            cy="20"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${RING_CIRCUMFERENCE * covered} ${RING_CIRCUMFERENCE}`}
            className={RING_STROKE[tone]}
            data-testid="dc-ring"
            data-coverage={covered}
          />
        </svg>
        <span
          className={cn(
            "absolute font-mono text-[10px] font-semibold tabular-nums tracking-tight lg:text-[12px]",
            isTestDc(dc) ? "text-text-muted" : "text-text",
          )}
        >
          {dc.dc}
        </span>
      </span>
      <span className="flex items-center gap-1">
        {dots && (
          <span className="flex items-center gap-[3px]" data-testid="dc-dots">
            {dots.map((alive, i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 w-1.5 rounded-full lg:h-2 lg:w-2",
                  alive ? DOT_ON[tone] : "bg-surface-3 ring-1 ring-inset ring-border",
                )}
              />
            ))}
          </span>
        )}
        <span className="font-mono text-[10px] tabular-nums text-text-muted lg:text-[11px]">
          {dc.alive_writers}/{dc.required_writers}
        </span>
      </span>
      <span
        data-testid="dc-rtt"
        className={cn(
          "font-mono text-[10px] tabular-nums lg:text-[11px]",
          rttWarn ? "text-warn" : "text-text-faint",
        )}
      >
        {dcRttText(dc, s)}
      </span>
    </Link>
  );
}
