import { describe, expect, it } from "vitest";
import {
  buildUserCreateBody,
  buildUserPatch,
  keepAllPatchFields,
  type UserPatchFormState,
} from "./buildUserPatch";

describe("buildUserPatch", () => {
  it("produces an empty object when every field is kept", () => {
    expect(buildUserPatch(keepAllPatchFields())).toEqual({});
  });

  it("omits a kept field's key entirely (not just undefined)", () => {
    const form = keepAllPatchFields();
    const patch = buildUserPatch(form);
    expect(Object.prototype.hasOwnProperty.call(patch, "max_tcp_conns")).toBe(false);
    expect(JSON.stringify(patch)).not.toContain("max_tcp_conns");
  });

  it("sets a cleared field's key to explicit null", () => {
    const form: UserPatchFormState = { ...keepAllPatchFields(), maxTcpConns: { mode: "clear" } };
    const patch = buildUserPatch(form);
    expect(Object.prototype.hasOwnProperty.call(patch, "max_tcp_conns")).toBe(true);
    expect(patch.max_tcp_conns).toBeNull();
    expect(JSON.parse(JSON.stringify(patch))).toEqual({ max_tcp_conns: null });
  });

  it("sets a field's key to the given value", () => {
    const form: UserPatchFormState = {
      ...keepAllPatchFields(),
      maxTcpConns: { mode: "set", value: 42 },
    };
    expect(buildUserPatch(form)).toEqual({ max_tcp_conns: 42 });
  });

  // Exhaustive per-field matrix: every field independently supports all
  // three states, serialized under its own wire key.
  const fieldCases: Array<{
    field: keyof UserPatchFormState;
    wireKey: string;
    value: string | number;
  }> = [
    { field: "userAdTag", wireKey: "user_ad_tag", value: "abcdef" },
    { field: "maxTcpConns", wireKey: "max_tcp_conns", value: 10 },
    { field: "maxUniqueIps", wireKey: "max_unique_ips", value: 3 },
    { field: "dataQuotaBytes", wireKey: "data_quota_bytes", value: 1073741824 },
    { field: "expirationRfc3339", wireKey: "expiration_rfc3339", value: "2026-09-01T00:00:00.000Z" },
    { field: "rateLimitUpBps", wireKey: "rate_limit_up_bps", value: 1000 },
    { field: "rateLimitDownBps", wireKey: "rate_limit_down_bps", value: 2000 },
  ];

  for (const { field, wireKey, value } of fieldCases) {
    describe(`field ${field} (${wireKey})`, () => {
      it("keep -> omitted", () => {
        const patch = buildUserPatch(keepAllPatchFields());
        expect(Object.prototype.hasOwnProperty.call(patch, wireKey)).toBe(false);
      });

      it("clear -> null", () => {
        const form = { ...keepAllPatchFields(), [field]: { mode: "clear" } } as UserPatchFormState;
        const patch = buildUserPatch(form);
        expect((patch as Record<string, unknown>)[wireKey]).toBeNull();
      });

      it("set -> value", () => {
        const form = {
          ...keepAllPatchFields(),
          [field]: { mode: "set", value },
        } as UserPatchFormState;
        const patch = buildUserPatch(form);
        expect((patch as Record<string, unknown>)[wireKey]).toBe(value);
      });
    });
  }

  it("mixes independent states across multiple fields in one patch", () => {
    const form: UserPatchFormState = {
      ...keepAllPatchFields(),
      maxTcpConns: { mode: "clear" },
      dataQuotaBytes: { mode: "set", value: 500 },
      userAdTag: { mode: "keep" },
    };
    const patch = buildUserPatch(form);
    expect(patch).toEqual({ max_tcp_conns: null, data_quota_bytes: 500 });
  });

  it("never emits the secret field (rotation is a separate action)", () => {
    const patch = buildUserPatch(keepAllPatchFields());
    expect(Object.prototype.hasOwnProperty.call(patch, "secret")).toBe(false);
  });
});

describe("buildUserCreateBody", () => {
  it("includes only username/secret/enabled when nothing else is set", () => {
    expect(
      buildUserCreateBody({ username: "alice", secret: "s".repeat(32), enabled: true }),
    ).toEqual({ username: "alice", secret: "s".repeat(32), enabled: true });
  });

  it("includes every optional field when provided", () => {
    const body = buildUserCreateBody({
      username: "bob",
      secret: "s".repeat(32),
      enabled: false,
      userAdTag: "tag",
      maxTcpConns: 5,
      maxUniqueIps: 2,
      dataQuotaBytes: 1000,
      expirationRfc3339: "2026-09-01T00:00:00.000Z",
      rateLimitUpBps: 100,
      rateLimitDownBps: 200,
    });
    expect(body).toEqual({
      username: "bob",
      secret: "s".repeat(32),
      enabled: false,
      user_ad_tag: "tag",
      max_tcp_conns: 5,
      max_unique_ips: 2,
      data_quota_bytes: 1000,
      expiration_rfc3339: "2026-09-01T00:00:00.000Z",
      rate_limit_up_bps: 100,
      rate_limit_down_bps: 200,
    });
  });

  it("omits an empty ad tag rather than sending an empty string", () => {
    const body = buildUserCreateBody({
      username: "carol",
      secret: "s".repeat(32),
      enabled: true,
      userAdTag: "",
    });
    expect(Object.prototype.hasOwnProperty.call(body, "user_ad_tag")).toBe(false);
  });
});
