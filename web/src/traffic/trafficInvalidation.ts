import type { QueryClient, QueryKey } from "@tanstack/react-query";

const sharedTrafficFamilies = [
  "getTrafficSummary",
  "getTrafficUsers",
  "getStorageSettings",
  "getAudit",
  "listUsers",
] as const;

const userTrafficFamilies = ["getUserTrafficHistory", "getUser"] as const;

export async function invalidateTrafficQueries(
  queryClient: QueryClient,
  username?: string,
): Promise<void> {
  const queryKeys: QueryKey[] = sharedTrafficFamilies.map((_id) => [{ _id }]);
  for (const _id of userTrafficFamilies) {
    queryKeys.push(username ? [{ _id, path: { username } }] : [{ _id }]);
  }
  await Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}
