import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { TelemtInfo } from "../../lib/api/generated/types.gen";
import { setLocalePreference } from "../../i18n";
import { Problems } from "./Problems";

const feed = vi.hoisted(() => ({ capabilities: {} as TelemtInfo["capabilities"] }));
vi.mock("../../caps", () => ({ useCaps: () => ({ data: { capabilities: feed.capabilities } }) }));
vi.mock("../../realtime", () => ({
  useSnapshot: (topic: string) => ({
    data: topic === "stats" ? { health: { status: "ok", read_only: false }, summary: null, ready: null } : null,
    ts: 1756000000,
    stale: false,
    error: null,
  }),
  useTopicWindow: () => ({ oldest: null }),
}));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));

beforeEach(() => {
  setLocalePreference("ru");
  feed.capabilities = {
    config_schema: true, config_state: true, config_validation: true,
    access_policy: true, user_source_deny: true, read_only: false,
    quota: true, runtime_edge: true, reload_api: true, config_api: true,
    user_enable_disable: true, rotate_secret: true,
  };
});

describe("overview capability warnings", () => {
  it("keeps a writable server with complete capabilities healthy", () => {
    const html = renderToStaticMarkup(<Problems />);
    expect(html).toContain("Проблем не обнаружено");
    expect(html).not.toContain("Недоступна возможность");
  });

  it("does not interpret available metadata as a missing capability", () => {
    feed.capabilities.optional_metadata_unavailable = false;
    expect(renderToStaticMarkup(<Problems />)).toContain("Проблем не обнаружено");
  });

  it("still reports actual missing support", () => {
    feed.capabilities.quota = false;
    const html = renderToStaticMarkup(<Problems />);
    expect(html).toContain("Недоступна возможность: quota");
    expect(html).not.toContain("Недоступна возможность: read_only");
  });
});
