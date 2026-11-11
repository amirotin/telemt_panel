import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { getTelemtConfigQueryKey, getTelemtConfigTomlQueryKey, getTelemtWebAccessQueryKey } from "./api/generated/@tanstack/react-query.gen";
import { invalidateTelemtConfigCaches } from "./invalidateTelemtConfigCaches";

it("expires every config projection without expiring unrelated panel settings", async () => {
  const cache = new QueryClient();
  const keys = [getTelemtConfigQueryKey(), getTelemtConfigTomlQueryKey(), getTelemtWebAccessQueryKey()];
  try {
    for (const key of [...keys, ["panel-settings"]]) cache.setQueryData(key, { revision: "old" });
    await invalidateTelemtConfigCaches(cache);
    for (const key of keys) expect(cache.getQueryState(key)?.isInvalidated).toBe(true);
    expect(cache.getQueryState(["panel-settings"])?.isInvalidated).toBe(false);
  } finally { cache.clear(); }
});
