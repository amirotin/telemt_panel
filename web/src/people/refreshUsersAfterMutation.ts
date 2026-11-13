import type { TopicName } from "../realtime";
import type { QueryClient } from "@tanstack/react-query";
import { queryClient } from "../lib/query-client";
import { invalidateTelemtConfigCaches } from "../lib/invalidateTelemtConfigCaches";

// refreshUsersAfterMutation reads the cached users snapshot immediately and
// again after a delay. The second read can pick up changes from the backend's
// mutation pokes; these client reads do not force a fresh Telemt request.
export function refreshUsersAfterMutation(refreshTopic: (topic: TopicName) => Promise<void>, client: QueryClient = queryClient): void {
  void invalidateTelemtConfigCaches(client);
  void refreshTopic("users");
  setTimeout(() => void refreshTopic("users"), 1000);
}
