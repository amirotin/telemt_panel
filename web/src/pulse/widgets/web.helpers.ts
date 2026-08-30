import type { Gated, WebStatus } from "../../realtime/topics";
import type { State } from "../../ui/StatePill";

/**
 * The WEB card's own vocabulary for concept §11's states, plus the two the
 * concept never had to name because it assumed a build that has WEB at all.
 *
 * `unsupported` is the state this panel meets most often in the field: WEB
 * arrived in Telemt 3.5.3, and a 3.4.x proxy simply has no
 * /v1/runtime/web/* route. That is not an error and not a switch anyone can
 * flip — it is a version, and the card says so calmly.
 */
export type WebCardState =
  | "running"
  | "starting"
  | "draining"
  | "disabled"
  | "unsupported"
  | "unavailable";

export interface WebCardView {
  state: WebCardState;
  tone: State;
  /**
   * A card with nothing to count: two lines, the title and the state. Both
   * closures (`disabled`, `unsupported`) and the momentary `unavailable`
   * take it — concept §17's «WEB может отображаться компактно».
   */
  compact: boolean;
  /** Telemt's own reason/lifecycle token, shown on a card that is not simply running. */
  reason?: string;
  listeners: string[];
  /** Live sessions from the manager plane; null when that plane was contended this poll. */
  sessions: number | null;
  /** Rejections against a WEB limit; null when the runtime plane is absent. */
  limitHits: number | null;
}

/**
 * The reason token hub.go puts on the gate when the route is missing
 * entirely (internal/hub/hub.go's webGateReasonUnsupported). It is the
 * panel's own vocabulary rather than Telemt's, which is exactly why it is
 * named here instead of matched as a literal at the call site.
 */
export const WEB_REASON_UNSUPPORTED = "capability_absent";

/**
 * Lifecycles that mean the runtime is on its way out. All three are one
 * state to a reader of the front page: WEB is going away and the sessions
 * it still holds are finishing.
 */
const DRAINING_LIFECYCLES = new Set(["draining", "drained", "deadline_exceeded"]);

const TONE: Record<WebCardState, State> = {
  running: "ok",
  starting: "warn",
  draining: "warn",
  disabled: "muted",
  unsupported: "muted",
  unavailable: "muted",
};

function view(
  state: WebCardState,
  rest: Partial<Omit<WebCardView, "state" | "tone" | "compact">> = {},
): WebCardView {
  return {
    state,
    tone: TONE[state],
    compact: state === "disabled" || state === "unsupported" || state === "unavailable",
    listeners: [],
    sessions: null,
    limitHits: null,
    ...rest,
  };
}

/**
 * computeWebCard reads the "web" topic's gated status.
 *
 * Unlike every other Gated[T] payload the dashboard renders, a CLOSED WEB
 * gate still carries data — hub.go keeps `lifecycle`, `listeners` and
 * `effective_config_enabled` precisely because they are what explain the
 * closure. So this does not go through resolveGated: `enabled` decides the
 * tone, the lifecycle decides the words, and the two are read separately.
 */
export function computeWebCard(status: Gated<WebStatus> | null | undefined): WebCardView {
  if (!status) return view("unavailable");
  if (status.reason === WEB_REASON_UNSUPPORTED) return view("unsupported");

  const data = status.data;
  if (!data) {
    return view("unavailable", status.reason ? { reason: status.reason } : {});
  }

  const runtime = data.runtime ?? null;
  const facts = {
    listeners: data.listeners,
    sessions: runtime?.manager?.sessions ?? null,
    limitHits: runtime?.limit_hits ?? null,
  };
  const lifecycle = data.lifecycle;

  if (lifecycle === "starting") return view("starting", { ...facts, reason: lifecycle });
  if (DRAINING_LIFECYCLES.has(lifecycle)) return view("draining", { ...facts, reason: lifecycle });
  if (lifecycle === "no_web_listener" || !data.effective_config_enabled) {
    return view("disabled", data.reason ? { reason: data.reason } : {});
  }
  if (status.enabled && data.available) return view("running", facts);

  // Available says no while the lifecycle claims something this panel does
  // not know — report the lifecycle verbatim rather than picking the
  // nearest state for it (§11.2).
  return view("unavailable", { ...facts, reason: data.reason ?? lifecycle });
}
