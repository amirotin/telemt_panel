import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SSEProvider } from "../realtime";
import { client } from "../lib/api/client";
import { getTelemtInfoQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import type { UsersTopicUser } from "../realtime/topics";
import { ru } from "../i18n/testing";
import { UserFormSheet } from "./UserFormSheet";

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let requests: Request[];
const originalConfig = client.getConfig();
const user: UsersTopicUser = {
  username: "alice", enabled: true, in_runtime: true, current_connections: 0,
  active_unique_ips: 0, active_unique_ips_list: [], recent_unique_ips: 0,
  recent_unique_ips_list: [], total_octets: 0,
  links: { classic: [], secure: [], tls: [], tls_domains: [] },
};

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  requests = [];
  client.setConfig({ baseUrl: "http://panel.test", fetch: (input) => {
    requests.push(input as Request);
    return new Promise(() => {});
  } });
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  client.setConfig(originalConfig);
});

async function render(version: string | undefined, overrides: Partial<UsersTopicUser> = {}, mode: "create" | "edit" = "edit") {
  queryClient.setQueryData(getTelemtInfoQueryKey(), { reachable: true, version, capabilities: { quota: true, runtime_edge: true, reload_api: true, config_api: true, user_enable_disable: true, rotate_secret: true } });
  await act(async () => root.render(<QueryClientProvider client={queryClient}><SSEProvider><UserFormSheet inline open mode={mode} user={{ ...user, ...overrides }} onClose={() => {}} /></SSEProvider></QueryClientProvider>));
}

function rateInput(direction: "up" | "down"): HTMLInputElement {
  const label = direction === "up" ? ru.people.form.rateUpShort : ru.people.form.rateDownShort;
  return [...container.querySelectorAll("label")].find((item) => item.textContent?.includes(label))!.querySelector("input")!;
}

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => container.querySelector("form")!.requestSubmit());
}

describe("Telemt user rate bounds", () => {
  it("blocks an out-of-range rate when creating a user", async () => {
    await render("3.5.8", {}, "create");
    await enter(container.querySelector<HTMLInputElement>('[data-testid="user-form-username"]')!, "bob");
    await enter(rateInput("up"), "100001");
    await submit();
    expect(requests).toHaveLength(0);
  });

  it.each(["up", "down"] as const)("blocks a newly entered %s rate above the 3.5.8 bound", async (direction) => {
    await render("3.5.8");
    const input = rateInput(direction);
    await enter(input, "100000.000001");
    expect(input.validity.rangeOverflow).toBe(true);
    await submit();
    expect(requests).toHaveLength(0);
  });

  it("accepts zero, the maximum, and fractional rates within the bound", async () => {
    await render("3.5.8");
    const input = rateInput("up");
    for (const value of ["0", "100000", "1.5", ""]) {
      await enter(input, value);
      expect(input.checkValidity()).toBe(true);
    }
    await enter(input, "100000");
    await submit();
    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toMatchObject({ rate_limit_up_bps: 100000000000 });
  });

  it.each(["v3.5.8", "3.5.8+build.1", "3.5.9", "3.5.9-rc.1", "3.6.0", "4.0.0"])("recognizes the bounded rate contract on %s", async (version) => {
    await render(version);
    expect(rateInput("up").max).toBe("100000");
    expect(rateInput("down").max).toBe("100000");
  });

  it.each(["3.5.5", "3.5.7", "3.5.8-rc.1", "3.5", "3.5.8garbage", "999999999999999999999.0.0", "unknown", undefined])("preserves earlier/unknown %s rate semantics", async (version) => {
    await render(version);
    const input = rateInput("up");
    await enter(input, "100001");
    expect(input.validity.rangeOverflow).toBe(false);
    await submit();
    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toMatchObject({ rate_limit_up_bps: 100001000000 });
  });

  it("keeps an untouched existing high rate and omits it from an unrelated patch", async () => {
    await render("3.5.8", { rate_limit_up_bps: 200000000000 });
    expect(rateInput("up").value).toBe("200000");
    await enter(rateInput("down"), "5");
    await submit();
    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toEqual({ rate_limit_down_bps: 5000000 });
    expect(rateInput("up").value).toBe("200000");
  });

  it("applies the bound when an existing high rate is changed", async () => {
    await render("3.5.8", { rate_limit_up_bps: 200000000000 });
    const input = rateInput("up");
    await enter(input, "190000");
    expect(input.validity.rangeOverflow).toBe(true);
    await submit();
    expect(requests).toHaveLength(0);
    expect(input.value).toBe("190000");
  });

  it("blocks negative newly entered rates on the bounded version", async () => {
    await render("3.5.8");
    const input = rateInput("down");
    await enter(input, "-1");
    expect(input.validity.rangeUnderflow).toBe(true);
    await submit();
    expect(requests).toHaveLength(0);
  });
});
