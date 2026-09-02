import { describe, expect, it } from "vitest";
import type { WebAccessView } from "../lib/api/generated/types.gen";
import {
  hasDuplicateWebProfiles,
  webAccessUsernames,
  webProfilesForUser,
} from "./webAccess.helpers";

const access: WebAccessView = {
  revision: "rev-1",
  enabled: true,
  vhosts: [
    {
      host: "one.example",
      public_addr: "203.0.113.1:443",
      profiles: [
        { user: "alice", secret_mode: "plain", max_sessions: 4 },
        { user: "bob", secret_mode: "dd" },
      ],
    },
    {
      host: "two.example",
      public_addr: "203.0.113.2:443",
      profiles: [{ user: "alice", secret_mode: "dd", max_streams: 10 }],
    },
  ],
};

describe("WEB access helpers", () => {
  it("projects all of one user's profiles without leaking the user field", () => {
    expect(webProfilesForUser(access, "alice")).toEqual([
      { vhost: "one.example", secret_mode: "plain", max_sessions: 4 },
      { vhost: "two.example", secret_mode: "dd", max_streams: 10 },
    ]);
  });

  it("collects unique usernames for a scalable People filter", () => {
    expect([...webAccessUsernames(access)].sort()).toEqual(["alice", "bob"]);
  });

  it("detects only duplicate vhost and mode pairs", () => {
    expect(hasDuplicateWebProfiles([
      { vhost: "one.example", secret_mode: "plain" },
      { vhost: "one.example", secret_mode: "dd" },
    ])).toBe(false);
    expect(hasDuplicateWebProfiles([
      { vhost: "one.example", secret_mode: "plain" },
      { vhost: "one.example", secret_mode: "plain" },
    ])).toBe(true);
  });
});
