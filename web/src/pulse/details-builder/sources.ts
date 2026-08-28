// Per-source and page-level states for a Details page (spec §14, §19.3).
//
// One state machine over the two transports the panel actually has:
//
//   * SSE topics via `useSnapshot(topic)` — TopicSnapshot{data, ts, stale,
//     error}, where `ts` is in SECONDS and the payload may be wrapped in
//     Telemt's `Gated<T>`;
//   * REST via React Query — TLS fingerprints and `/api/telemt/zero`, where
//     freshness is `dataUpdatedAt` in MILLISECONDS.
//
// Both are normalized into one `freshnessMs`, which is what DetailHeader
// (Task 3) shows as an age.
//
// Ruling R5 — `unsupported` is NOT `disabled` — is taken from the reference
// implementation Task 1 already shipped for TLS
// (widgets/tlsFingerprints.helpers.ts + TlsSourceNotice.tsx): 501
// `capability_absent` means the build predates the route and the only way
// forward is an update, 503 `capability_unavailable` means the admin has a
// switch to flip. This module reuses that vocabulary verbatim — the same
// `variant` prop on caps/Gated and the same `telemt_outdated` hint key —
// rather than inventing a second mechanism; `noticeVariantFor`/`hintKeyFor`
// below are the adapters that hand it to the existing component.
//
// The state ORDER matters and matches TlsSourceNotice's: capability-off
// beats a cached payload, an error with a cached payload is `stale` rather
// than `error`, and a payload that arrived empty is `empty`, not `error`.

import { useMemo } from "react";
import type { GateHintKey } from "../../caps/gateHints";
import type { Dict } from "../../i18n";
import type { TopicSnapshot } from "../../realtime/types";
import type { DataSourceDefinition } from "./model";
import { isCapabilityCode } from "../widgets/tlsFingerprints.helpers";

/**
 * Spec §14's state set. `partial` is produced by the PAGE aggregate only —
 * a single source is never partial, it is one of the other seven.
 */
export type SourceStatus =
  | "loading"
  | "ready"
  | "stale"
  | "partial"
  | "disabled"
  | "unsupported"
  | "error"
  | "empty";

export interface SourceState {
  id: string;
  status: SourceStatus;
  /** Epoch MILLISECONDS of the payload on screen, normalized across transports. */
  freshnessMs: number | null;
  /** Telemt's own short reason token for a disabled capability, printed verbatim after a localized prefix. */
  reason?: string;
  /** Envelope error code, for the `error` status only. */
  code?: string;
  /** True while the last known payload is still worth showing. */
  hasData: boolean;
}

// --- freshness normalization --------------------------------------------

const SECOND_MS = 1000;
// A seconds-valued epoch is ~1.7e9; a ms-valued one ~1.7e12. Anything below
// this threshold is seconds.
const MS_EPOCH_FLOOR = 1e11;

// normalizeFreshness accepts either spelling and returns epoch ms.
// `useSnapshot`'s `ts` is seconds (and, in the polling fallback, comes from
// the CLIENT clock — see realtime/context.tsx), React Query's
// `dataUpdatedAt` is ms.
export function normalizeFreshness(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  return value < MS_EPOCH_FLOOR ? value * SECOND_MS : value;
}

// --- Gated<T> (SSE topics) ----------------------------------------------

export interface GatedLike<T = unknown> {
  enabled: boolean;
  reason?: string;
  generated_at_epoch_secs?: number;
  data?: T | null;
}

export function isGatedLike(value: unknown): value is GatedLike {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { enabled?: unknown }).enabled === "boolean"
  );
}

/**
 * Reason tokens Telemt uses for "this build has no such thing", as opposed
 * to "the admin turned it off". Kept as a set rather than a regex so adding
 * one is an obvious, reviewable change.
 */
const UNSUPPORTED_REASONS = new Set(["capability_absent", "unsupported", "not_implemented"]);

// gatedStatus applies R5 to a `Gated<T>` wrapper. `enabled:false` is
// normally `disabled`; only an explicitly unsupported reason (or a caller
// that already knows the build is too old) makes it `unsupported`.
export function gatedStatus(
  gated: GatedLike,
  opts: { buildTooOld?: boolean } = {},
): Extract<SourceStatus, "disabled" | "unsupported" | "empty" | "ready"> {
  if (!gated.enabled) {
    return opts.buildTooOld || (gated.reason && UNSUPPORTED_REASONS.has(gated.reason))
      ? "unsupported"
      : "disabled";
  }
  // enabled with no payload is the source being unable to answer this poll,
  // NOT an empty result set (__fixtures__/edges.ts gatedUnavailable).
  if (gated.data === null || gated.data === undefined) return "empty";
  return "ready";
}

// isEmptyPayload — §14's `empty`: "запрос успешен, данных нет". A source that
// answered honestly with `[]`, `{}` or an object whose every top-level value
// is itself an empty container has DATA-less success, which is a different
// thing from an error, from a disabled capability and from still loading.
// A single scalar anywhere at the top level means the source said something.
export function isEmptyPayload(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== "object") return false;
  const values = Object.values(value as Record<string, unknown>).filter((v) => v !== undefined);
  if (values.length === 0) return true;
  return values.every(
    (v) =>
      v === null ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === "object" && Object.keys(v as object).length === 0),
  );
}

// --- SSE topic sources ---------------------------------------------------

export interface TopicSourceInput {
  kind: "topic";
  snapshot: TopicSnapshot<unknown>;
  /** Normalized path to a `Gated<T>` wrapper inside the topic payload. */
  gated?: GatedLike | null;
  /** R5: this Telemt build predates the field entirely (from caps/TelemtInfo.version). */
  buildTooOld?: boolean;
  /** Payload's own generation stamp, when it carries one (seconds or ms). */
  generatedAt?: number | null;
}

// resolveTopicSource extends pulse/diag/DiagTopicState.helpers.ts's
// three-branch decision to the full §14 set. The extra branches are exactly
// the ones the diagnostics pages did not have to make: gated capabilities,
// "answered but empty", and a normalized age.
export function resolveTopicSource(id: string, input: TopicSourceInput): SourceState {
  const { snapshot } = input;
  const freshnessMs = normalizeFreshness(input.generatedAt ?? snapshot.ts);

  if (input.gated) {
    const status = gatedStatus(input.gated, { buildTooOld: input.buildTooOld });
    if (status === "disabled" || status === "unsupported") {
      return {
        id,
        status,
        freshnessMs,
        ...(input.gated.reason ? { reason: input.gated.reason } : {}),
        hasData: false,
      };
    }
    if (status === "empty") {
      return { id, status: "empty", freshnessMs, hasData: false };
    }
  }

  if (snapshot.data === null || snapshot.data === undefined) {
    // Same branch order as decideDiagTopicState: an error with nothing to
    // show is an error; no error and nothing yet is still loading.
    return snapshot.error
      ? { id, status: "error", freshnessMs, code: snapshot.error, hasData: false }
      : { id, status: "loading", freshnessMs, hasData: false };
  }
  if (snapshot.error || snapshot.stale) {
    // A payload we already have plus a failed refresh: keep it, flag it.
    return {
      id,
      status: "stale",
      freshnessMs,
      ...(snapshot.error ? { code: snapshot.error } : {}),
      hasData: true,
    };
  }
  if (isEmptyPayload(input.gated ? input.gated.data : snapshot.data)) {
    return { id, status: "empty", freshnessMs, hasData: false };
  }
  return { id, status: "ready", freshnessMs, hasData: true };
}

// --- React Query sources -------------------------------------------------

/**
 * The narrow slice of a TanStack Query result this module reads — the same
 * structural shape tlsFingerprints.helpers.ts's QueryLike uses, so a test
 * needs no QueryClient.
 */
export interface QuerySourceInput {
  kind: "query";
  isPending: boolean;
  isError: boolean;
  error?: { code?: string } | null;
  data?: unknown;
  dataUpdatedAt?: number;
  /** Set when the payload is a `Gated<T>` envelope (the /api/telemt/* passthroughs). */
  gated?: GatedLike | null;
  buildTooOld?: boolean;
}

// resolveQuerySource maps a REST source onto the same seven states.
//
// The capability mapping is the SAME rule resolveTlsFingerprintsQuery
// applies (`capability_unavailable` -> disabled, `capability_absent` ->
// unsupported); sources.test.ts asserts the two agree case by case, so the
// R5 split cannot drift apart between the widget and the builder.
export function resolveQuerySource(id: string, input: QuerySourceInput): SourceState {
  const freshnessMs = normalizeFreshness(input.dataUpdatedAt ?? null);
  const hasCached = input.gated ? Boolean(input.gated.data) : input.data !== undefined;

  if (input.isError) {
    const code = input.error?.code ?? "internal_error";
    if (isCapabilityCode(code)) {
      return {
        id,
        status: code === "capability_absent" ? "unsupported" : "disabled",
        freshnessMs,
        hasData: false,
      };
    }
    if (hasCached) return { id, status: "stale", freshnessMs, code, hasData: true };
    return { id, status: "error", freshnessMs, code, hasData: false };
  }
  if (input.isPending || input.data === undefined) {
    return { id, status: "loading", freshnessMs, hasData: false };
  }
  if (input.gated) {
    const status = gatedStatus(input.gated, { buildTooOld: input.buildTooOld });
    if (status !== "ready") {
      return {
        id,
        status,
        freshnessMs,
        ...(input.gated.reason ? { reason: input.gated.reason } : {}),
        hasData: false,
      };
    }
  }
  if (isEmptyPayload(input.gated ? input.gated.data : input.data)) {
    return { id, status: "empty", freshnessMs, hasData: false };
  }
  return { id, status: "ready", freshnessMs, hasData: true };
}

export type DetailSourceInput = TopicSourceInput | QuerySourceInput;

export function resolveSource(id: string, input: DetailSourceInput): SourceState {
  return input.kind === "topic" ? resolveTopicSource(id, input) : resolveQuerySource(id, input);
}

// --- page aggregate ------------------------------------------------------

export interface PageSourcesState {
  /** Per-source states, keyed by DataSourceDefinition.id. */
  byId: Record<string, SourceState>;
  /** The one status the header shows (spec §14). */
  status: SourceStatus;
  /** Newest freshness across every source that has data. */
  freshnessMs: number | null;
  /** Ids of sources that are not usable right now — what `partial` refers to. */
  degraded: string[];
}

// Ranking for "which single status describes the page". A required source
// failing outranks everything; otherwise a working page with a broken
// optional source is `partial`, which is precisely the §14 rule that a
// global error must not replace the sections that DO work.
const READY_LIKE = new Set<SourceStatus>(["ready", "stale", "empty"]);

export function aggregateSources(
  definitions: readonly DataSourceDefinition[],
  byId: Record<string, SourceState>,
): PageSourcesState {
  const states = definitions.map((d) => byId[d.id]).filter((s): s is SourceState => Boolean(s));
  const degraded = definitions
    .filter((d) => {
      const st = byId[d.id];
      return st !== undefined && !READY_LIKE.has(st.status);
    })
    .map((d) => d.id);

  const freshnessMs = states.reduce<number | null>((best, s) => {
    if (s.freshnessMs === null) return best;
    return best === null || s.freshnessMs > best ? s.freshnessMs : best;
  }, null);

  const requiredStates = definitions
    .filter((d) => d.required)
    .map((d) => byId[d.id])
    .filter((s): s is SourceState => Boolean(s));

  let status: SourceStatus;
  const blockedRequired = requiredStates.find(
    (s) => s.status === "error" || s.status === "disabled" || s.status === "unsupported",
  );
  if (states.length === 0) {
    status = "loading";
  } else if (blockedRequired) {
    status = blockedRequired.status;
  } else if (requiredStates.some((s) => s.status === "loading") && !states.some((s) => s.hasData)) {
    status = "loading";
  } else if (degraded.length > 0 && states.some((s) => s.hasData)) {
    status = "partial";
  } else if (states.some((s) => s.status === "stale")) {
    status = "stale";
  } else if (states.every((s) => s.status === "empty")) {
    status = "empty";
  } else if (states.some((s) => s.status === "loading")) {
    status = "loading";
  } else {
    status = "ready";
  }

  return { byId, status, freshnessMs, degraded };
}

// --- presentation adapters (reuse, not reinvention) ---------------------

// noticeVariantFor hands a source state to the EXISTING caps/Gated +
// GatedNote `variant` prop (Task 1's R5 split). Returns null when the state
// is not a capability state at all.
export function noticeVariantFor(state: SourceState): "disabled" | "unsupported" | null {
  if (state.status === "disabled") return "disabled";
  if (state.status === "unsupported") return "unsupported";
  return null;
}

// hintKeyFor picks the "как включить" follow-up. An unsupported source is
// always `telemt_outdated` — the string Task 1 added for exactly this — so
// the panel never tells an operator to flip a setting their binary lacks.
export function hintKeyFor(
  state: SourceState,
  disabledHint?: GateHintKey,
): GateHintKey | undefined {
  if (state.status === "unsupported") return "telemt_outdated";
  if (state.status === "disabled") return disabledHint;
  return undefined;
}

export function sourceStatusLabel(status: SourceStatus, s: Dict): string {
  return s.details.state[status];
}

// --- the hook ------------------------------------------------------------

// useDetailSources resolves and aggregates a page's sources.
//
// It deliberately does NOT call useSnapshot/useQuery itself: the number of
// sources is a property of the page DEFINITION, and calling a hook once per
// element of an array is exactly the loop the rules-of-hooks lint forbids
// (and would break the moment a definition gained a source). The page
// component subscribes explicitly — `const upstreams = useSnapshot(...)` —
// and hands the snapshots in here, which also makes every state transition
// in this module testable from a plain object with no React at all.
//
// The result is memoized on the source states themselves, so a realtime
// frame that changes nothing about availability does not produce a new
// object and cannot cascade a re-render into the sections below.
export function useDetailSources(
  definitions: readonly DataSourceDefinition[],
  inputs: Record<string, DetailSourceInput>,
): PageSourcesState {
  // `inputs` is a fresh object on every render by construction (the page
  // rebuilds it from its own hooks), so it cannot be a dependency. Its
  // OBSERVABLE content can: `signature` is exactly that, which is why the
  // exhaustive-deps rule is overridden here rather than obeyed into a memo
  // that never hits.
  const signature = signatureOf(definitions, inputs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const byId = useMemo(() => resolveAll(definitions, inputs), [definitions, signature]);

  return useMemo(() => aggregateSources(definitions, byId), [definitions, byId]);
}

function resolveAll(
  definitions: readonly DataSourceDefinition[],
  inputs: Record<string, DetailSourceInput>,
): Record<string, SourceState> {
  const out: Record<string, SourceState> = {};
  for (const definition of definitions) {
    const input = inputs[definition.id];
    if (!input) continue;
    out[definition.id] = resolveSource(definition.id, input);
  }
  return out;
}

// signatureOf collapses the resolved states into a string, so the memo above
// re-runs only when a source's OBSERVABLE state changes — not on every new
// payload object identity a realtime frame produces (§19.1's "не
// пересоздавать строки только из-за нового object reference").
function signatureOf(
  definitions: readonly DataSourceDefinition[],
  inputs: Record<string, DetailSourceInput>,
): string {
  return definitions
    .map((d) => {
      const input = inputs[d.id];
      if (!input) return `${d.id}:-`;
      const state = resolveSource(d.id, input);
      return `${d.id}:${state.status}:${state.freshnessMs ?? ""}:${state.code ?? ""}:${state.reason ?? ""}:${state.hasData}`;
    })
    .join("|");
}
