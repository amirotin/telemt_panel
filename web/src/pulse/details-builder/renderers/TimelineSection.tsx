import { useMemo } from "react";
import { fill, useStrings } from "../../../i18n";
import { cn } from "../../../lib/cn";
import { formatValue } from "../formatting";
import type { TimelineSectionDefinition } from "../model";
import type { CollectionSectionInstance } from "../resolveSections";
import { SectionFrame } from "./SectionFrame";
import { EmptyNote, RevealMore } from "./NodeTree";
import { countStatuses, markerForTone, toneForStatus, type TimelineTone } from "./timeline.helpers";
import { isSectionExpanded, type DetailRenderContext } from "./context";

export interface TimelineSectionProps {
  instance: CollectionSectionInstance;
  /** Owns the status/step/details/duration accessors (§9.5). */
  definition?: TimelineSectionDefinition<unknown, unknown>;
  ctx: DetailRenderContext;
}

const TONE_DOT: Record<TimelineTone, string> = {
  ok: "text-ok",
  neutral: "text-text-muted",
  muted: "text-text-faint",
  warn: "text-warn",
  error: "text-error",
};

// TimelineSection is §9.5: initialization components and sequenced events
// as ONE step per element — status, title, details and duration together,
// never four KV rows per element. Sixteen init components are a stepper you
// read top to bottom; flattened they were 141 rows nobody read.
//
// The order is the PAYLOAD's order: a sequence means something (Telemt
// emits its components in the order it ran them, its events by descending
// `seq`), so this renderer never sorts. That is also why it needs no frozen
// order: nothing here can reorder except the source itself.
//
// Time is rendered twice on purpose (§13): the relative age is what a
// reader wants at a glance, the absolute stamp stays reachable as the
// element's title — the `timestamp` unit produces both in one call.
export function TimelineSection({ instance, definition, ctx }: TimelineSectionProps) {
  const s = useStrings();
  const expanded = isSectionExpanded(instance.id, instance.defaultExpanded, ctx.expandedSections);

  const steps = useMemo(
    () =>
      instance.items.map((item, index) => {
        const status = definition?.status?.(item) ?? "";
        return {
          key: instance.itemKeys[index] ?? String(index),
          status,
          tone: toneForStatus(status),
          title: definition?.step?.(item) ?? instance.itemKeys[index] ?? String(index),
          details: definition?.details?.(item) ?? null,
          durationMs: definition?.durationMs?.(item) ?? null,
          atEpochMs: definition?.atEpochMs?.(item) ?? null,
        };
      }),
    [instance.items, instance.itemKeys, definition],
  );

  // The status tally reads as a section NOTE under the title, the way the
  // render draws "14 ready · 2 skipped": as header trailing it would sit in
  // a shrink-0 column and squeeze the title to one letter per line on a
  // 360 px screen, since the tally is data and can name three event types.
  const summary = countStatuses(steps.map((step) => step.status));
  const note = summary.map((entry) => `${entry.count} ${entry.status}`).join(" · ");
  const description = [instance.description?.(s), note === "" ? undefined : note]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");

  const limit = ctx.visibleLimit(instance.id, instance.paging.initial);
  const shown = steps.slice(0, limit);

  return (
    <SectionFrame
      id={instance.id}
      title={instance.title(s)}
      {...(description === "" ? {} : { description })}
      {...(instance.presence === "absent" ? {} : { count: steps.length })}
      expanded={expanded}
      onToggle={() => ctx.toggleSection(instance.id)}
    >
      {instance.presence === "absent" ? (
        <EmptyNote text={s.details.collection.absentTitle} />
      ) : instance.presence === "empty" ? (
        <EmptyNote text={s.details.collection.emptyTitle} />
      ) : (
        <>
          {/* The rail is drawn by the list, not by each row, so the line
              between two steps does not break on a row that wraps. */}
          <ol className="relative flex flex-col py-1 before:absolute before:bottom-4 before:left-[9px] before:top-4 before:w-px before:bg-border">
            {shown.map((step) => (
              <li key={step.key} className="relative flex items-start gap-3 py-2">
                <span
                  className={cn(
                    "z-10 mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-surface-2 text-[10px]",
                    TONE_DOT[step.tone],
                  )}
                  aria-hidden="true"
                >
                  {markerForTone(step.tone)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[12.5px] font-semibold text-text">
                    {step.title}
                  </span>
                  {step.details !== null && step.details !== "" && (
                    <span className="mt-0.5 block break-words text-meta text-text-muted">
                      {step.details}
                    </span>
                  )}
                  {/* The status word is data (§11.2). It is printed in the
                      right column whenever it carries information the
                      marker does not — an untimed step, or any state that
                      is not plain "ok" — and stays available to a screen
                      reader in the one case where it is not drawn. */}
                  {!showsStatus(step) && <span className="sr-only">{step.status}</span>}
                </span>
                <StepTime
                  durationMs={step.durationMs}
                  atEpochMs={step.atEpochMs}
                  status={step.status}
                  showStatus={showsStatus(step)}
                  tone={step.tone}
                  ctx={ctx}
                />
              </li>
            ))}
          </ol>
          <RevealMore
            shown={shown.length}
            total={steps.length}
            onReveal={() =>
              ctx.revealMore(instance.id, instance.paging.step, instance.paging.initial)
            }
            label={s.details.collection.showMore}
            countLabel={fill(s.details.collection.shownTemplate, {
              shown: String(shown.length),
              total: String(steps.length),
            })}
          />
        </>
      )}
    </SectionFrame>
  );
}

// showsStatus decides whether the status WORD is drawn beside the step. A
// timed step that simply succeeded says everything with its duration and
// its marker; an untimed one (an event) and anything that is not plain "ok"
// (skipped, failed, retrying) does not.
function showsStatus(step: { durationMs: number | null; tone: TimelineTone }): boolean {
  return step.durationMs === null || step.tone !== "ok";
}

// StepTime is the right-hand column: the duration when the step took time,
// the moment when it only happened, and the status word where it adds
// something — the render's "skipped" column.
function StepTime({
  durationMs,
  atEpochMs,
  status,
  showStatus,
  tone,
  ctx,
}: {
  durationMs: number | null;
  atEpochMs: number | null;
  status: string;
  showStatus: boolean;
  tone: TimelineTone;
  ctx: DetailRenderContext;
}) {
  const s = useStrings();
  const duration =
    durationMs === null
      ? null
      : formatValue(durationMs, s, { nowMs: ctx.nowMs, unit: "milliseconds" });
  const moment =
    atEpochMs === null ? null : formatValue(atEpochMs, s, { nowMs: ctx.nowMs, unit: "timestamp" });

  return (
    <span className="max-w-[42%] shrink-0 break-words text-right">
      {duration !== null && (
        <span className="block font-mono text-micro tabular-nums text-text-muted">
          {duration.text}
        </span>
      )}
      {moment !== null && (
        <span
          className="block font-mono text-micro tabular-nums text-text-faint"
          title={moment.title}
        >
          {moment.text}
        </span>
      )}
      {showStatus && (
        <span className={cn("block break-words font-mono text-micro", TONE_DOT[tone])}>
          {status}
        </span>
      )}
    </span>
  );
}
