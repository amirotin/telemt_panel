import { fill, useStrings } from "../../i18n";
import { Card } from "../../ui/Card";
import { StatePill } from "../../ui/StatePill";
import { GatedNote } from "../GatedNote";
import type { DataSourceDefinition } from "./model";
import type { PageSourcesState, SourceState } from "./sources";
import { hintKeyFor, noticeVariantFor, sourceStatusLabel, sourceStatusShortLabel } from "./sources";
import type { GateHintKey } from "../../caps";

export interface AttentionSummaryProps {
  sources: PageSourcesState;
  definitions: readonly DataSourceDefinition[];
  /** Per-source "как включить" hint for a capability that is merely switched off. */
  disabledHints?: Record<string, GateHintKey>;
}

// AttentionSummary is §6's attention node and §14's partial-response rule
// made visible: when SOME sources are unusable, the page says which ones
// and why, and every working section stays exactly where it was. A global
// error banner replacing the page is precisely what the spec forbids.
//
// A capability that is off or missing reuses the existing GatedNote (R5's
// disabled-vs-unsupported split), so the Details pages and the dashboard
// widgets explain a gate with the same words.
export function AttentionSummary({
  sources,
  definitions,
  disabledHints,
}: AttentionSummaryProps) {
  const s = useStrings();
  // `loading` counts as degraded for the page aggregate (nothing is on
  // screen yet), but it is not something to draw attention TO: the skeleton
  // already says the page is loading, and an amber "problems: 1" card over
  // it would report a normal first render as a fault.
  const degraded = definitions
    .map((d) => sources.byId[d.id])
    .filter(
      (state): state is SourceState =>
        state !== undefined && state.status !== "loading" && sources.degraded.includes(state.id),
    );

  if (degraded.length === 0) return null;

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatePill state={sources.status === "error" ? "error" : "warn"}>
          {sourceStatusShortLabel(sources.status, s)}
        </StatePill>
        <span className="text-meta text-text-muted">
          {fill(s.details.attention.degradedTemplate, { count: degraded.length })}
        </span>
      </div>
      {degraded.map((state) => {
        const variant = noticeVariantFor(state);
        if (variant) {
          const hint = hintKeyFor(state, disabledHints?.[state.id]);
          return (
            <GatedNote
              key={state.id}
              variant={variant}
              {...(state.reason !== undefined ? { reason: state.reason } : {})}
              {...(hint !== undefined ? { hint } : {})}
            />
          );
        }
        return (
          <p key={state.id} className="text-meta text-text-muted">
            <span className="font-mono">{state.id}</span> — {sourceStatusLabel(state.status, s)}
            {state.code !== undefined && ` (${state.code})`}
          </p>
        );
      })}
    </Card>
  );
}
