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
  dcWriterRatio,
  isTestDc,
  type DcBoardRowKind,
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

// The writers bar's fill, same semantic set as the ring: one glance says
// how far from the floor this data center is, whatever that floor is.
const BAR_FILL: Record<State, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  error: "bg-error",
  muted: "bg-text-faint",
};

const ROW_LABEL_KEY: Record<DcBoardRowKind, "rowMedia" | "rowMain"> = {
  media: "rowMedia",
  main: "rowMain",
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
        <div className="flex w-full flex-col gap-2.5 lg:gap-3">
          {dcBoardRows(view.dcs).map((row) => (
            // The row label is what tells «-5» from «5»: the two halves used
            // to be told apart by a muted ring, and that muting was wrong
            // (a media group is production traffic). One quiet word each.
            <section key={row.kind} className="flex flex-col gap-1">
              <h3
                data-testid={`dc-row-${row.kind}`}
                className="text-micro font-semibold uppercase tracking-[0.06em] text-text-faint"
              >
                {s.pulse.dc[ROW_LABEL_KEY[row.kind]]}
              </h3>
              <ul className="grid grid-cols-3 gap-2 lg:grid-cols-6 lg:gap-3">
                {row.dcs.map((dc) => (
                  <li key={dc.dc}>
                    <DcNode dc={dc} />
                  </li>
                ))}
              </ul>
            </section>
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
  const writers = dcWriterRatio(dc);
  const test = isTestDc(dc);
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
        "relative flex h-full min-h-[72px] flex-col items-center gap-0.5 rounded-lg border border-border bg-surface-2 px-1 py-1 lg:min-h-[84px] lg:gap-1 lg:py-2",
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
            data-testid="dc-track"
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
          {/* The test site's ring is DASHED, and the dashes are cut into it
              rather than drawn under it: a dashed TRACK is completely
              hidden by a full-coverage arc, i.e. invisible on exactly the
              nodes that are healthy. This overlay strokes the tile's own
              background over the ring in `pathLength` units, so the gaps
              land the same way at any radius and any coverage. */}
          {test && (
            <circle
              cx="20"
              cy="20"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              pathLength="100"
              strokeDasharray="2.4 5.6"
              data-testid="dc-dashes"
              className="text-surface-2"
            />
          )}
        </svg>
        <span className="absolute font-mono text-[10px] font-semibold tabular-nums tracking-tight text-text lg:text-[12px]">
          {dc.dc}
        </span>
      </span>
      {/* Writers as a thin fill bar under the ring: one dot per required
          writer only worked while the floor was small, and the fleet has a
          data center needing ten. The exact numbers stay underneath. */}
      <span className="h-1 w-8 overflow-hidden rounded-full bg-surface-3 lg:w-12" data-testid="dc-writers-bar">
        <span
          data-testid="dc-writers-fill"
          data-fill={writers}
          className={cn("block h-full rounded-full", BAR_FILL[tone])}
          style={{ width: `${writers * 100}%` }}
        />
      </span>
      <span className="flex items-center gap-1 font-mono text-[10px] tabular-nums lg:text-[11px]">
        <span className="text-text-muted">
          {dc.alive_writers}/{dc.required_writers}
        </span>
        <span className="text-border" aria-hidden="true">
          ·
        </span>
        <span data-testid="dc-rtt" className={rttWarn ? "text-warn" : "text-text-faint"}>
          {dcRttText(dc, s)}
        </span>
      </span>
      {test && (
        <span
          data-testid="dc-test-tag"
          aria-hidden="true"
          className="absolute right-1 top-0.5 rounded bg-surface-3 px-1 text-[8px] font-semibold uppercase tracking-[0.06em] text-text-faint"
        >
          {s.pulse.dc.testTag}
        </span>
      )}
    </Link>
  );
}
