import { describe, expect, it } from "vitest";
import { webStatusNoListener, webStatusPartialPlanes, webStatusRunning } from "../__fixtures__/web";
import { webPagePayload } from "./web.helpers";

const observability = {
  ingress: {
    configured_listeners: 2, live_acceptors: 1, accepting_connections: false,
    reason: "acceptor_unavailable", tcp_accept_total: 91, tcp_accept_error_total: 3,
  },
  capacity: {
    http_connection_capacity_action: "future_action", max_http_overload_connections: 4, http_overload_timeout_ms: 800,
    resources: [{ resource: "future_resource", unit: "credits", used: 3, available: 7, limit: 10, closed: false }],
    saturated_resources: [], partial: ["budget"], rejections: [{ reason: "future_rejection", total: 11 }],
    http_connection_overload_outcomes: [{ outcome: "future_outcome", total: 5 }],
  },
  decoy_upstream: { outcomes: [{ outcome: "connect_timeout", total: 7 }], last_outcome: "connect_timeout", last_outcome_age_ms: 0 },
  decoy_fasttrack: { mode: "future_mode", requests: [{ disposition: "future_disposition", total: 2 }] },
  carrier_negotiation: {
    selections: [{ carrier: "future_carrier", disposition: "future_selection", total: 3 }],
    reported_failures: [{ carrier: "future_carrier", phase: "future_phase", reason: "future_failure", total: 4 }],
    learning_outcomes: [{ carrier: "future_carrier", outcome: "future_learning", total: 5 }],
  },
  lifecycle_counters: {
    bridge_recovery_secs: 40,
    session_closures: [{ carrier: "future_carrier", reason: "future_close", total: 6 }],
    session_observations: [{ carrier: "future_carrier", observation: "future_observation", total: 7 }],
    bridge_recovery_events: [{ event: "future_event", total: 8 }],
  },
  operator_lifecycle: {
    state: "future_state", epoch: 9, age_ms: 500, admission_open: false, effective_new_work_admission: false,
    drain: { operation_id: "drain-id", state: "future_drain", outcome: "future_terminal", timeout_secs: 30,
      started_epoch_millis: 1000, deadline_epoch_millis: 31000, completed_epoch_millis: 0,
      remaining_sessions: 2, remaining_streams: 3, remaining_websockets: 1, force_close_signalled: true },
  },
};

describe("WEB observability payload projection", () => {
  it("preserves the 3.5.8 transport status and process-lifetime counter domains", () => {
    expect(webPagePayload({ ...webStatusRunning, ...observability }, null)).toMatchObject(observability);
  });

  it("does not manufacture transport status on the older recorded fixture", () => {
    const payload = webPagePayload(webStatusRunning, null);
    for (const key of Object.keys(observability)) expect(payload).not.toHaveProperty(key);
    expect(payload).toMatchObject({ available: true, lifecycle: "running", runtime: { generation_id: 1, partial: [] } });
  });

  it("preserves explicit null telemetry groups", () => {
    const absent = {
      ingress: null, capacity: null, decoy_upstream: null, decoy_fasttrack: null,
      carrier_negotiation: null, lifecycle_counters: null, operator_lifecycle: null,
    };
    expect(webPagePayload({ ...webStatusRunning, ...absent }, null)).toMatchObject(absent);
  });

  it("keeps contended runtime planes and transport capacity partial markers", () => {
    expect(webPagePayload({ ...webStatusPartialPlanes, ...observability }, null)).toMatchObject({
      capacity: { partial: ["budget"], resources: [{ resource: "future_resource", available: 7 }] },
      runtime: { manager: null, budget: null, learning: null, debug: null, partial: ["manager", "budget", "learning", "debug"] },
    });
  });

  it("keeps process observations when the runtime is unavailable", () => {
    const payload = webPagePayload({
      ...webStatusNoListener,
      ingress: { ...observability.ingress, configured_listeners: 0, live_acceptors: 0, reason: "no_web_listener" },
      capacity: { ...observability.capacity, resources: [], saturated_resources: [], partial: ["runtime"] },
      decoy_upstream: { outcomes: [] },
      lifecycle_counters: observability.lifecycle_counters,
    }, null);
    expect(payload).toMatchObject({
      available: false, reason: "no_web_listener", ingress: { accepting_connections: false },
      capacity: { resources: [], partial: ["runtime"], rejections: [{ reason: "future_rejection", total: 11 }] },
      decoy_upstream: { outcomes: [] }, lifecycle_counters: { bridge_recovery_secs: 40 },
    });
    expect(payload).not.toHaveProperty("runtime");
    expect(payload).not.toHaveProperty("operator_lifecycle");
  });
});
