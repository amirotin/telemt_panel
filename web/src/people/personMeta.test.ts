import { describe, expect, it } from "vitest";
import { personAvatarTone, personBadge, personMeta } from "./personMeta.helpers";
import type { UserQuotaView } from "./users.helpers";

const GB = 1024 ** 3;
const quota: UserQuotaView = { usedBytes: 12 * GB, limitBytes: 50 * GB };
const unlimited: UserQuotaView = { usedBytes: 3 * GB, limitBytes: null };

function user(connections: number, ips = 1) {
  return { current_connections: connections, active_unique_ips: ips };
}

describe("personMeta", () => {
  it("shows connections · IPs · traffic for someone online", () => {
    const meta = personMeta({ user: user(3, 2), status: "active", quota });
    expect(meta.tone).toBe("muted");
    expect(meta.text).toBe("3 соед · 2 IP · 12 ГБ из 50 ГБ");
  });

  it("omits the limit for an unlimited quota", () => {
    expect(personMeta({ user: user(1), status: "active", quota: unlimited }).text).toBe(
      "1 соед · 1 IP · 3.0 ГБ",
    );
  });

  it("falls back to an idle line with no connections", () => {
    const meta = personMeta({ user: user(0), status: "active", quota });
    expect(meta.text).toBe("Не в сети · 12 ГБ из 50 ГБ");
  });

  it("lets a problem status win over the activity line", () => {
    expect(personMeta({ user: user(4), status: "quota_exhausted", quota }).tone).toBe("error");
    expect(personMeta({ user: user(4), status: "quota_exhausted", quota }).text).toContain(
      "Квота исчерпана",
    );
    expect(personMeta({ user: user(4), status: "expired", quota }).tone).toBe("warn");
    expect(personMeta({ user: user(4), status: "disabled", quota }).tone).toBe("faint");
    expect(personMeta({ user: user(4), status: "not_in_runtime", quota }).tone).toBe("warn");
  });
});

describe("personBadge", () => {
  it("shows the live connection count for an active, connected user", () => {
    expect(personBadge({ user: user(3), status: "active" })).toEqual({ text: "3", tone: "accent" });
  });

  it("shows nothing for an idle but healthy user", () => {
    expect(personBadge({ user: user(0), status: "active" })).toBeNull();
  });

  it("shows a word for each attention state", () => {
    expect(personBadge({ user: user(0), status: "quota_exhausted" })?.tone).toBe("error");
    expect(personBadge({ user: user(0), status: "expired" })?.tone).toBe("warn");
    expect(personBadge({ user: user(0), status: "disabled" })?.tone).toBe("muted");
    expect(personBadge({ user: user(0), status: "not_in_runtime" })?.tone).toBe("warn");
  });
});

describe("personAvatarTone", () => {
  it("uses the alert wash for quota/expiry", () => {
    expect(personAvatarTone(user(0), "quota_exhausted")).toBe("alert");
    expect(personAvatarTone(user(0), "expired")).toBe("alert");
  });

  it("uses the flat idle chip when switched off or offline", () => {
    expect(personAvatarTone(user(2), "disabled")).toBe("idle");
    expect(personAvatarTone(user(0), "active")).toBe("idle");
  });

  it("uses the hue gradient for someone actually connected", () => {
    expect(personAvatarTone(user(1), "active")).toBe("hue");
  });
});
