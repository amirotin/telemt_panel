import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it } from "vitest";
import { PeopleProvider } from "./PeopleContext";
import { QuickConnectionLinks } from "./ConnectionLinks";
import { SSEProvider } from "../realtime";
import { FakeEventSource } from "../realtime/testing/fakeEventSource";
import { client } from "../lib/api/client";
import { getTelemtInfoQueryKey, getTelemtWebAccessQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import type { UsersTopicUser } from "../realtime/topics";

const originalConfig = client.getConfig();
const originalES = globalThis.EventSource;
let cache: QueryClient;
let root: Root;
let container: HTMLDivElement;
const user: UsersTopicUser = { username: "alice", enabled: true, in_runtime: true, current_connections: 0, active_unique_ips: 0, active_unique_ips_list: [], recent_unique_ips: 0, recent_unique_ips_list: [], total_octets: 0, links: { classic: [], secure: [], tls: ["tg://proxy?server=proxy.example.org&port=443&secret=ee0123456789abcdef0123456789abcdef6578616d706c652e6f7267"], tls_domains: [] } };
const ee = () => [...document.querySelectorAll("button")].find(button => button.textContent === "EE");

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove(); cache?.clear();
  client.setConfig(originalConfig); globalThis.EventSource = originalES; FakeEventSource.reset();
});

it.each(["read failure", "capability lost"])("restores MTProto choices when the cached WEB-only configuration becomes unavailable: %s", async (reason) => {
  client.setConfig({ baseUrl: "http://panel.test", fetch: async () => { throw new Error("config unavailable"); } });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cache.setQueryData(getTelemtInfoQueryKey(), { reachable: true, capabilities: { config_api: true } });
  cache.setQueryData(getTelemtWebAccessQueryKey(), { revision: "r1", enabled: true, mtproto_listener: "absent", vhosts: [{ host: "web.example.org", public_addr: "web.example.org:443", profiles: [{ user: "alice", secret_mode: "dd" }] }] });
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={cache}><SSEProvider><PeopleProvider><QuickConnectionLinks user={user} /></PeopleProvider></SSEProvider></QueryClientProvider>));
  expect(ee()).toBeUndefined();
  await act(async () => {
    if (reason === "read failure") await cache.refetchQueries({ queryKey: getTelemtWebAccessQueryKey() });
    else cache.setQueryData(getTelemtInfoQueryKey(), { reachable: true, capabilities: { config_api: false } });
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  expect(ee()).toBeDefined();
});
