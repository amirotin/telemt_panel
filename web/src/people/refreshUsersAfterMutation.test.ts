import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshUsersAfterMutation } from "./refreshUsersAfterMutation";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("refreshUsersAfterMutation", () => {
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
