import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshUsersAfterMutation } from "./refreshUsersAfterMutation";
import { queryClient } from "../lib/query-client";
import { getTelemtConfigQueryKey, getTelemtConfigTomlQueryKey, getTelemtWebAccessQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  queryClient.clear();
  vi.useRealTimers();
});

describe("refreshUsersAfterMutation", () => {
  it("expires WEB access and both config projections after a user mutation", () => {
    const keys = [getTelemtConfigQueryKey(), getTelemtConfigTomlQueryKey(), getTelemtWebAccessQueryKey()];
    for (const key of keys) queryClient.setQueryData(key, { revision: "old" });
    refreshUsersAfterMutation(vi.fn().mockResolvedValue(undefined));
    for (const key of keys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });
  it("calls refreshTopic('users') immediately", () => {
    const refreshTopic = vi.fn().mockResolvedValue(undefined);
    refreshUsersAfterMutation(refreshTopic);
    expect(refreshTopic).toHaveBeenCalledTimes(1);
    expect(refreshTopic).toHaveBeenCalledWith("users");
  });

  it("calls refreshTopic('users') again ~1s later", () => {
    const refreshTopic = vi.fn().mockResolvedValue(undefined);
    refreshUsersAfterMutation(refreshTopic);

    vi.advanceTimersByTime(999);
    expect(refreshTopic).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(refreshTopic).toHaveBeenCalledTimes(2);
  });

  it("never calls any topic other than 'users'", () => {
    const refreshTopic = vi.fn().mockResolvedValue(undefined);
    refreshUsersAfterMutation(refreshTopic);
    vi.advanceTimersByTime(2000);
    for (const call of refreshTopic.mock.calls) {
      expect(call[0]).toBe("users");
    }
  });
});
