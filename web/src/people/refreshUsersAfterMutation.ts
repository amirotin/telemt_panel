import type { TopicName } from "../realtime";

// refreshUsersAfterMutation is called from every user-mutation success
// handler (create, patch, delete, enable/disable, rotate-secret,
// reset-quota, sub-link regenerate) so the "users" topic doesn't sit on
// its own ~10s poll interval before the change is visible on the list/
// detail screens. Calls refreshTopic('users') once immediately and once
// more ~1s later, covering Telemt's own ~50ms mutation-apply debounce plus
// the panel SDK's read-after-write retry (07-telemt-sdk.md) in case the
// very first call races either of those.
//
// Known limitation (verified against the real hub — see
// task-5-report.md's "Fix round 1" section): internal/hub.Hub.Snapshot
// serves a topic's poller-owned cached value without a fresh upstream
// fetch whenever that topic already has an active SSE subscriber
// (`t.running && t.hasData`) — which is exactly the state the "users"
// topic is in whenever a People screen showing this mutation's result is
// open. In that situation, calling this (any number of times, at any
// delay) does not shorten the visible staleness window below the topic's
// own poll interval; it only helps when no SSE subscriber currently holds
// the topic open (e.g. the fallback-poll path, or a future caller with no
// live People screen mounted). Flagged to the controller as a backend
// contract gap rather than worked around here — see the report.
export function refreshUsersAfterMutation(refreshTopic: (topic: TopicName) => Promise<void>): void {
  void refreshTopic("users");
  setTimeout(() => void refreshTopic("users"), 1000);
}
