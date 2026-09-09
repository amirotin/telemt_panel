import type { TopicName } from "../realtime";

// refreshUsersAfterMutation reads the cached users snapshot immediately and
// again after a delay. The second read can pick up changes from the backend's
// mutation pokes; these client reads do not force a fresh Telemt request.
export function refreshUsersAfterMutation(refreshTopic: (topic: TopicName) => Promise<void>): void {
  void refreshTopic("users");
  setTimeout(() => void refreshTopic("users"), 1000);
}
