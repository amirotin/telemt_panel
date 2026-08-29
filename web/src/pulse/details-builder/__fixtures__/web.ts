// WEB runtime fixtures (M4 task 8b).
//
// PROVENANCE — read before editing:
//
//   * `webStatusRunning` and `webStatusNoListener` are REAL responses,
//     recorded from a Telemt built at tag 3.5.5: the first with one WEB
//     listener on 127.0.0.1:18080 and one vhost profile, the second from a
//     config with no `transport = "web"` listener at all. The only edit is
//     `runtime_instance`, replaced with a fixed hex string so tests and
//     screenshots are deterministic. Nothing else was added, removed or
//     reordered — including the 46 `limits` keys and the eight `permits`
//     entries, which are exactly what the Details page has to lay out.
//
//   * `webSessionRows` are SYNTHETIC. A WEB session can only be created by a
//     real Telegram Desktop WEB client completing a bridge handshake against
//     a public TLS terminator, which the recording stand had no way to
//     provide — the recorded `sessions` page was empty. The rows below are
//     built field-for-field from src/web/session/status.rs's SessionRow
//     (`session_ref` and the optional user-agent pair beside the 23
//     flattened status fields) and spread across carriers, states, users and
//     client classes so the Sessions tab's filters have something to filter.
//
// Everything is deterministic: no Math.random, no Date.now.

import type {
  WebControlOperationStatus,
  WebSessionPage,
  WebSessionRow,
} from "../../../lib/api/generated/types.gen";
import type { WebStatus, WebTopic } from "../../../realtime/topics";

/** Recorded: a running WEB runtime with every plane healthy. */
export const webStatusRunning: WebStatus = {
  "lifecycle": "running",
  "lifecycle_epoch": 2,
  "lifecycle_age_ms": 7762,
  "available": true,
  "listeners": [
    "127.0.0.1:18080"
  ],
  "effective_config_enabled": true,
  "runtime": {
    "runtime_instance": "0123456789abcdef0123456789abcdef",
    "generation_id": 1,
    "limits": {
      "max_header_bytes": 16384,
      "max_body_bytes": 2097152,
      "max_frame_payload_bytes": 1048576,
      "carrier_batch_bytes": 2097152,
      "max_frames_per_body": 4096,
      "max_http_connections": 1024,
      "max_http_handlers": 512,
      "max_lane_open_waits_per_session": 16,
      "pending_bytes_per_lane": 8388608,
      "pending_items_per_lane": 1024,
      "websocket_bytes_global": 268435456,
      "websocket_admission_watermark_pct": 75,
      "websocket_eviction_watermark_pct": 90,
      "websocket_http_connection_reserve": 64,
      "max_websocket_evictions_in_flight": 8,
      "max_carrier_learning_entries": 4096,
      "max_body_readers": 32,
      "max_body_bytes_global": 67108864,
      "max_sessions_global": 128,
      "max_sessions_per_ip": 16,
      "max_streams_per_session": 128,
      "max_streams_global": 4096,
      "max_stream_handshakes": 256,
      "max_tombstones_per_session": 4096,
      "pending_bytes_per_session": 33554432,
      "pending_bytes_global": 536870912,
      "pending_items_per_session": 16384,
      "pending_items_global": 262144,
      "control_bytes_per_session": 262144,
      "control_bytes_global": 16777216,
      "max_bootstraps_global": 512,
      "max_bootstraps_per_ip": 64,
      "max_vhosts": 8,
      "max_profiles": 32,
      "max_static_files": 4096,
      "max_static_file_bytes": 8388608,
      "max_static_bytes": 67108864,
      "debug_records_capacity": 65536,
      "debug_bytes_global": 67108864,
      "memory_envelope_bytes": 1342177280,
      "new_bootstraps_per_minute": 1200,
      "new_bootstraps_burst": 256,
      "new_sessions_per_minute": 600,
      "new_sessions_burst": 128,
      "new_streams_per_minute": 6000,
      "new_streams_burst": 512
    },
    "manager": {
      "issuance_enabled": true,
      "issuance_generation": 1,
      "shutdown": false,
      "bootstraps": 0,
      "sessions": 0,
      "closed_tokens": 0,
      "closed_sessions": 0,
      "client_ips": 0,
      "profiles": 0
    },
    "streams": {
      "live": 0,
      "profiles": 0,
      "closed": false
    },
    "budget": {
      "queue_bytes": 0,
      "queue_items": 0,
      "control_bytes": 0,
      "control_items": 0,
      "websocket_bytes": 0,
      "high_water_bytes": 0,
      "owners": 0,
      "closed": false
    },
    "websockets": {
      "entries": 0,
      "claims": 0,
      "evictions_in_flight": 0,
      "closed": false
    },
    "learning": {
      "enabled": false,
      "aggressiveness": "conservative",
      "epoch": 1,
      "entries": 0,
      "capacity": 4096,
      "lifetime_secs": 600,
      "age_ms": 7762
    },
    "debug": {
      "policy": {
        "enabled": false,
        "capture_lifecycle": true,
        "capture_headers": true,
        "capture_timings": true,
        "capture_frames": true,
        "body_capture": "metadata",
        "body_prefix_bytes": 4096,
        "decoy_body_prefix_bytes": 4096,
        "default_window_secs": 180,
        "max_window_secs": 3600
      },
      "policy_generation": 1,
      "epoch": 1,
      "records": 0,
      "records_capacity": 65536,
      "used_bytes": 0,
      "bytes_capacity": 67108864,
      "contention_drops": 0,
      "evictions": 0,
      "byte_truncations": 0,
      "earliest_seq": null,
      "latest_seq": null
    },
    "permits": [
      [
        "http_connections",
        {
          "used": 0,
          "available": 1024,
          "capacity": 1024,
          "closed": false
        }
      ],
      [
        "http_handlers",
        {
          "used": 0,
          "available": 512,
          "capacity": 512,
          "closed": false
        }
      ],
      [
        "lane_polls",
        {
          "used": 0,
          "available": 256,
          "capacity": 256,
          "closed": false
        }
      ],
      [
        "lane_aux_polls",
        {
          "used": 0,
          "available": 128,
          "capacity": 128,
          "closed": false
        }
      ],
      [
        "body_readers",
        {
          "used": 0,
          "available": 32,
          "capacity": 32,
          "closed": false
        }
      ],
      [
        "body_bytes",
        {
          "used": 0,
          "available": 67108864,
          "capacity": 67108864,
          "closed": false
        }
      ],
      [
        "stream_handshakes",
        {
          "used": 0,
          "available": 256,
          "capacity": 256,
          "closed": false
        }
      ],
      [
        "websocket_connections",
        {
          "used": 0,
          "available": 960,
          "capacity": 960,
          "closed": false
        }
      ]
    ],
    "auxiliary_tasks": 1,
    "session_incarnations_created": 0,
    "session_incarnations_closed": 0,
    "streams_opened": 0,
    "streams_rejected": 0,
    "bytes_up": 0,
    "bytes_down": 0,
    "limit_hits": 0,
    "partial": []
  }
};

/** Recorded: the same route on a build started with no WEB listener. */
export const webStatusNoListener: WebStatus = {
  "lifecycle": "no_web_listener",
  "lifecycle_epoch": 2,
  "lifecycle_age_ms": 755,
  "available": false,
  "reason": "no_web_listener",
  "listeners": [],
  "effective_config_enabled": false
};

/**
 * A poll that lost the try_lock on four of the six planes. Derived from the
 * recorded snapshot rather than hand-written, so only the contention itself
 * differs: `null` planes plus their names in `partial`, which is what the
 * page renders as a per-section "plane busy" badge.
 */
export const webStatusPartialPlanes: WebStatus = {
  ...webStatusRunning,
  runtime: {
    ...webStatusRunning.runtime!,
    manager: null,
    budget: null,
    learning: null,
    debug: null,
    partial: ["manager", "budget", "learning", "debug"],
  },
};

/** The `web` topic as the hub publishes it, for each of the three states. */
export const webTopicRunning: WebTopic = {
  status: { enabled: true, data: webStatusRunning },
};
export const webTopicDisabled: WebTopic = {
  status: { enabled: false, reason: "no_web_listener", data: webStatusNoListener },
};
export const webTopicUnsupported: WebTopic = {
  status: { enabled: false, reason: "capability_absent" },
};

const CARRIERS = ["https-lanes", "websocket", "https", "websocket-lanes"] as const;
const STATES = ["healthy", "committed", "provisional", "closing"] as const;
const CLASSES = ["bridge", "legacy", "browser-hint", "ios"] as const;
const USERS = ["web-user", "alice"] as const;
const AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TelegramDesktop/5.7.2",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) TelegramDesktop/5.7.2",
  "",
] as const;

const RUNTIME_INSTANCE = "0123456789abcdef0123456789abcdef";

/** The canonical `ws1.<instance>.<16 hex>` reference Telemt hands out. */
export function webSessionRef(id: number): string {
  return `ws1.${RUNTIME_INSTANCE}.${id.toString(16).padStart(16, "0")}`;
}

function webSessionRow(i: number): WebSessionRow {
  const agent = AGENTS[i % AGENTS.length]!;
  const state = STATES[i % STATES.length]!;
  const carrier = CARRIERS[i % CARRIERS.length]!;
  return {
    session_ref: webSessionRef(i),
    ...(agent !== "" ? { user_agent: agent, user_agent_id: (0xb200 + i).toString(16).padStart(32, "0") } : {}),
    trace_session_id: i,
    client_ip: `203.0.113.${10 + i}`,
    host: "proxy.example.com",
    user: USERS[i % USERS.length]!,
    key_id: (0xa100 + i).toString(16).padStart(16, "0"),
    carrier,
    attempt: 1 + (i % 3),
    client_class: CLASSES[i % CLASSES.length]!,
    automatic: i % 2 === 0,
    state,
    streams: i % 5,
    tasks: i % 4,
    lanes: i % 6,
    lane_open_waits: i % 2,
    websocket_lane_reservations: i % 3,
    websocket_active: carrier.startsWith("websocket"),
    pending_bytes: 1024 * i,
    pending_items: i,
    control_bytes: 64 * i,
    control_items: i % 7,
    age_ms: 60_000 * i,
    idle_ms: 250 * i,
    // Only a session still negotiating its carrier has a remaining budget;
    // the field is omitted for everybody else.
    ...(state === "provisional" ? { negotiation_remaining_ms: 4200 - 100 * i } : {}),
  };
}

/** Synthetic: 24 rows, matching the count cmd/telemt-mock seeds. */
export const webSessionRows: WebSessionRow[] = Array.from({ length: 24 }, (_, i) =>
  webSessionRow(i + 1),
);

/** The first page of 20, with the cursor that continues it. */
export const webSessionsFirstPage: WebSessionPage = {
  sessions: webSessionRows.slice(0, 20),
  next_cursor: webSessionRef(20),
  scanned: 20,
  scan_truncated: false,
  partial_sessions: 0,
  partial: [],
};

/** The tail, with no cursor. */
export const webSessionsSecondPage: WebSessionPage = {
  sessions: webSessionRows.slice(20),
  next_cursor: null,
  scanned: 24,
  scan_truncated: false,
  partial_sessions: 0,
  partial: [],
};

/** Everything on one page — what the completeness test walks. */
export const webSessionsAll: WebSessionPage = {
  sessions: webSessionRows,
  next_cursor: null,
  scanned: 24,
  scan_truncated: false,
  partial_sessions: 0,
  partial: [],
};

/**
 * A contended manager lock: 200 OK with an EMPTY page and `partial:
 * ["manager"]`. It means "busy", not "no sessions", and the page must not
 * say the latter.
 */
export const webSessionsManagerBusy: WebSessionPage = {
  sessions: [],
  next_cursor: null,
  scanned: 0,
  scan_truncated: false,
  partial_sessions: 0,
  partial: ["manager"],
};

/** A scan that hit Telemt's 1000-candidate ceiling. */
export const webSessionsTruncated: WebSessionPage = {
  ...webSessionsFirstPage,
  scanned: 1000,
  scan_truncated: true,
  partial_sessions: 3,
};

export const webOperationQueued: WebControlOperationStatus = {
  operation_id: `wo1.${RUNTIME_INSTANCE}.0000000000000001`,
  state: "queued",
  high_water_session_ref: webSessionRef(24),
  requested: 1,
  scanned: 0,
  matched: 0,
  close_signalled: 0,
  conflicted: 0,
  created_epoch_millis: 1_756_000_000_000,
  updated_epoch_millis: 1_756_000_000_000,
};

export const webOperationCompleted: WebControlOperationStatus = {
  ...webOperationQueued,
  state: "completed",
  scanned: 24,
  matched: 1,
  close_signalled: 1,
  updated_epoch_millis: 1_756_000_000_500,
};
