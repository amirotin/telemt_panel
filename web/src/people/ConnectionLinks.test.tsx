import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { ConnectionLinks } from "./ConnectionLinks";
import { client } from "../lib/api/generated/client.gen";
import { getLinkSettingsQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import type { UsersTopicUser } from "../realtime/topics";

it("keeps the selected Telegram link kind across a background permission check", async () => {
  const config = client.getConfig(),
    cache = new QueryClient();
  const host = document.createElement("div"),
    root = createRoot(host);
  let hold: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const prefix = "tg://proxy?server=server.example&port=443&secret=";
  const secret = "0123456789abcdef0123456789abcdef";
  const user: UsersTopicUser = {
    username: "alice",
    enabled: true,
    in_runtime: true,
    current_connections: 0,
    active_unique_ips: 0,
    active_unique_ips_list: [],
    recent_unique_ips: 0,
    recent_unique_ips_list: [],
    total_octets: 0,
    links: {
      classic: [prefix + secret],
      secure: [prefix + "dd" + secret],
      tls: [],
      tls_domains: [],
    },
  };
  client.setConfig({
    baseUrl: "http://panel.test",
    fetch: async (request) => {
      if (new URL((request as Request).url).pathname.endsWith("/settings/links")) {
        await hold;
        return Response.json({ allow_address_override: true });
      }
      return Response.json({ revision: "1", sections: {} });
    },
  });
  const classic = () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Classic")!;
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <ConnectionLinks user={user} />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      expect(host.querySelectorAll("select").length).toBe(2);
    });
    act(() => classic().click());
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let check: Promise<void> | undefined;
    await act(async () => {
      check = cache.refetchQueries({ queryKey: getLinkSettingsQueryKey() });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(classic().getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      release!();
      await check;
    });
    expect(classic().getAttribute("aria-pressed")).toBe("true");
  } finally {
    release?.();
    act(() => root.unmount());
    cache.clear();
    client.setConfig(config);
  }
});
