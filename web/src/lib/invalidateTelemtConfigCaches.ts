import type { QueryClient } from "@tanstack/react-query";
import { getTelemtConfigQueryKey, getTelemtConfigTomlQueryKey, getTelemtWebAccessQueryKey } from "./api/generated/@tanstack/react-query.gen";

// Each projection carries the same whole-config revision from Telemt.
export async function invalidateTelemtConfigCaches(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: getTelemtConfigQueryKey() }),
    client.invalidateQueries({ queryKey: getTelemtConfigTomlQueryKey() }),
    client.invalidateQueries({ queryKey: getTelemtWebAccessQueryKey() }),
  ]);
}
