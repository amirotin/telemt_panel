import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SSEProvider } from "../realtime";
import { client } from "../lib/api/client";
import { FakeEventSource } from "../realtime/testing/fakeEventSource";
import { UserActionSheet, type ActionSheetIntent } from "./UserActionSheet";
import { intentToView } from "./actionSheet.helpers";
import type { UsersTopicUser } from "../realtime/topics";
import {
  getTrafficSummaryQueryKey,
  getUserIpHistoryQueryKey,
  getUserTrafficHistoryQueryKey,
} from "../lib/api/generated/@tanstack/react-query.gen";
import { ru } from "../i18n/testing";
import { PeopleContext, type PeopleContextValue } from "./PeopleContext";

const { resetTrafficRequest } = vi.hoisted(() => ({
  resetTrafficRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/api/generated/@tanstack/react-query.gen", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../lib/api/generated/@tanstack/react-query.gen")
  >();
  return {
    ...original,
    resetUserTrafficMutation: () => ({ mutationFn: resetTrafficRequest }),
  };
});

// Regression cover for the toggle-enabled confirmation: the decision the
// admin confirms must be the one they asked for, not whatever the live
// "users" topic happens to say by the time they tap "Отключить".

function makeUser(overrides: Partial<UsersTopicUser> = {}): UsersTopicUser {
  return {
    username: "alice",
    enabled: true,
    in_runtime: true,
    current_connections: 0,
    active_unique_ips: 0,
    active_unique_ips_list: [],
    recent_unique_ips: 0,
    recent_unique_ips_list: [],
    total_octets: 0,
    links: { classic: [], secure: [], tls: [], tls_domains: [] },
    ...overrides,
  };
}

describe("intentToView", () => {
  it("freezes nextEnabled as the opposite of the user's state at open time", () => {
    expect(intentToView("toggle-enabled", makeUser({ enabled: true }))).toEqual({
      kind: "confirm-toggle-enabled",
      nextEnabled: false,
    });
    expect(intentToView("toggle-enabled", makeUser({ enabled: false }))).toEqual({
      kind: "confirm-toggle-enabled",
      nextEnabled: true,
    });
  });

  it("maps every other intent to its step", () => {
    expect(intentToView("menu", null).kind).toBe("menu");
    expect(intentToView("share", null).kind).toBe("share");
    expect(intentToView("qr", null).kind).toBe("qr");
    expect(intentToView("reset-quota", null).kind).toBe("confirm-reset-quota");
    expect(intentToView("delete", null).kind).toBe("confirm-delete");
  });
});

describe("UserActionSheet — toggle-enabled confirmation", () => {
  let container: HTMLElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let originalES: typeof globalThis.EventSource;

  beforeEach(() => {
    resetTrafficRequest.mockReset();
    resetTrafficRequest.mockResolvedValue(undefined);
    originalFetch = globalThis.fetch;
    originalES = globalThis.EventSource;
    // The SSE provider only needs *an* EventSource to construct; nothing in
    // this test drives it.
    globalThis.EventSource = FakeEventSource as unknown as typeof globalThis.EventSource;
    fetchMock = vi.fn(async (input: unknown) => {
      const url = String((input as Request)?.url ?? input);
      const body = url.includes("/api/telemt/info")
        ? { reachable: true, capabilities: { user_enable_disable: true, rotate_secret: true } }
        : { enabled: false };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    // hey-api's client resolves `fetch` from its own config first (it
    // captured globalThis.fetch at module load), so stubbing the global
    // alone never reaches it.
    // An absolute baseUrl too: the generated client builds `new URL(...)`,
    // which throws on a relative path outside a real document base.
    client.setConfig({
      baseUrl: "http://panel.test",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    client.setConfig({ baseUrl: "", fetch: originalFetch });
    globalThis.EventSource = originalES;
    FakeEventSource.reset();
    vi.restoreAllMocks();
  });

  function render(
    user: UsersTopicUser,
    intent: ActionSheetIntent = "toggle-enabled",
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    }),
    access: Partial<PeopleContextValue> = {},
  ) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PeopleContext.Provider value={{ profiles: new Map(), webUnavailable: false, readOnly: false, canResetQuota: false, canToggle: false, formats: new Map(), setFormat: () => {}, listView: { search: "", filter: "all", scrollOffset: 0, returnUsername: null }, ...access }}><SSEProvider>
            <UserActionSheet
              open
              intent={intent}
              user={user}
              onClose={() => {}}
              onEdit={() => {}}
            />
          </SSEProvider></PeopleContext.Provider>
        </QueryClientProvider>,
      );
    });
    return queryClient;
  }

  function confirmButton(): HTMLButtonElement {
    const buttons = Array.from(document.body.querySelectorAll("button"));
    const btn = buttons.find((b) => b.textContent === "Отключить" || b.textContent === "Включить");
    if (!btn) throw new Error(`no confirm button; saw: ${buttons.map((b) => b.textContent).join(" | ")}`);
    return btn as HTMLButtonElement;
  }

  it("warns that deleting WEB profiles can interrupt other users", () => {
    render(makeUser(), "delete", undefined, { profiles: new Map([["alice", [{ host: "web.example.org", mode: "dd" }]]]) });
    expect(document.body.textContent).toContain("других пользователей");
  });

  it("opens a WEB QR link when MTProto listeners are absent", async () => {
    const wire = { classic: ["tg://proxy?server=127.0.0.1&port=18080&secret=0123456789abcdef0123456789abcdef"], secure: [], tls: [], tls_domains: [] };
    render(makeUser({ links: wire }), "qr", undefined, { profiles: new Map([["alice", [{ host: "web.example.org", mode: "dd" }]]]), mtprotoListener: "absent" });
    await act(async () => { await Promise.resolve(); });
    const open = [...document.querySelectorAll("a")].find(a => a.textContent === "Открыть в Telegram");
    expect(open?.getAttribute("href")).toBe("tg://webproxy?server=web.example.org&secret=dd0123456789abcdef0123456789abcdef");
  });

  it("keeps the frozen decision when the live user flips mid-confirmation", async () => {
    render(makeUser({ enabled: true }));
    expect(confirmButton().textContent).toBe("Отключить");

    // A "users" topic push lands while the confirmation is on screen and
    // flips the user to disabled.
    render(makeUser({ enabled: false }));
    expect(confirmButton().textContent).toBe("Отключить");
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
    await vi.waitFor(()=>expect(confirmButton().disabled).toBe(false));

    await act(async () => {
      confirmButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 50));
    });

    const call = fetchMock.mock.calls
      .map((c) => c[0] as Request)
      .find((req) => String(req?.url ?? "").includes("/enabled"));
    expect(call, "no PUT to /enabled was issued").toBeTruthy();
    expect(call!.method).toBe("PUT");
    // Frozen: the payload is the decision taken at open time (disable),
    // NOT `!user.enabled` re-read after the push (which would be enable).
    await expect(call!.json()).resolves.toEqual({ enabled: false });
  });

  it("freezes the opposite decision for a disabled user", () => {
    render(makeUser({ enabled: false }));
    expect(confirmButton().textContent).toBe("Включить");
    render(makeUser({ enabled: true }));
    expect(confirmButton().textContent).toBe("Включить");
  });

  it("does not refetch or invalidate IP history after a successful traffic reset", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    const trafficKey = getTrafficSummaryQueryKey({ query: { range: "24h" } });
    const ipKey = getUserIpHistoryQueryKey({
      path: { username: "alice" },
      query: { range: "24h" },
    });
    queryClient.setQueryData(trafficKey, { cached: "traffic" });
    queryClient.setQueryData(ipKey, { cached: "ip" });

    let trafficRefetches = 0;
    let ipRefetches = 0;
    const trafficObserver = new QueryObserver(queryClient, {
      queryKey: trafficKey,
      queryFn: async () => ({ fetch: ++trafficRefetches }),
      staleTime: Infinity,
    });
    const ipObserver = new QueryObserver(queryClient, {
      queryKey: ipKey,
      queryFn: async () => ({ fetch: ++ipRefetches }),
      staleTime: Infinity,
    });
    const unsubscribeTraffic = trafficObserver.subscribe(() => {});
    const unsubscribeIP = ipObserver.subscribe(() => {});

    render(makeUser(), "menu", queryClient);
    const openConfirmation = [...document.body.querySelectorAll("button")].find(
      (button) => (button.querySelector("strong")?.textContent ?? button.textContent) === ru.people.actions.resetTraffic,
    );
    if (!openConfirmation) throw new Error("traffic reset action button not found");
    await act(async () => openConfirmation.click());
    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => (button.querySelector("strong")?.textContent ?? button.textContent) === ru.people.actions.resetTraffic,
    );
    if (!confirm) throw new Error("traffic reset confirmation button not found");

    await act(async () => {
      confirm.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(resetTrafficRequest).toHaveBeenCalledOnce();
    expect(trafficRefetches).toBe(1);
    expect(ipRefetches).toBe(0);
    expect(queryClient.getQueryState(ipKey)?.isInvalidated).toBe(false);

    unsubscribeTraffic();
    unsubscribeIP();
  });

  it("invalidates the reset target even if the displayed user changes while pending", async () => {
    let finish!: () => void;
    resetTrafficRequest.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    });
    const aliceKey = getUserTrafficHistoryQueryKey({ path: { username: "alice" }, query: { range: "24h" } });
    const bobKey = getUserTrafficHistoryQueryKey({ path: { username: "bob" }, query: { range: "24h" } });
    queryClient.setQueryData(aliceKey, { cached: "alice" });
    queryClient.setQueryData(bobKey, { cached: "bob" });
    render(makeUser(), "menu", queryClient);
    const resetButton = () => {
      const button = [...document.body.querySelectorAll("button")].find(
        (candidate) => (candidate.querySelector("strong")?.textContent ?? candidate.textContent) === ru.people.actions.resetTraffic,
      );
      if (!button) throw new Error("traffic reset button not found");
      return button;
    };
    await act(async () => resetButton().click());
    await act(async () => resetButton().click());
    await vi.waitFor(() => expect(resetTrafficRequest).toHaveBeenCalledOnce());
    expect(resetTrafficRequest.mock.calls[0][0].path.username).toBe("alice");

    render(makeUser({ username: "bob" }), "menu", queryClient);
    await act(async () => { finish(); });

    await vi.waitFor(() => expect(queryClient.getQueryState(aliceKey)?.isInvalidated).toBe(true));
    expect(queryClient.getQueryState(bobKey)?.isInvalidated).toBe(false);
  });

  it("leaves cached traffic queries untouched when the reset fails", async () => {
    resetTrafficRequest.mockRejectedValueOnce(new Error("reset failed"));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    });
    const trafficKey = getTrafficSummaryQueryKey({ query: { range: "30d" } });
    queryClient.setQueryData(trafficKey, { cached: "traffic" });

    render(makeUser(), "menu", queryClient);
    const openConfirmation = [...document.body.querySelectorAll("button")].find(
      (button) => (button.querySelector("strong")?.textContent ?? button.textContent) === ru.people.actions.resetTraffic,
    );
    if (!openConfirmation) throw new Error("traffic reset action button not found");
    await act(async () => openConfirmation.click());
    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => (button.querySelector("strong")?.textContent ?? button.textContent) === ru.people.actions.resetTraffic,
    );
    if (!confirm) throw new Error("traffic reset confirmation button not found");

    await act(async () => {
      confirm.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(resetTrafficRequest).toHaveBeenCalledOnce();
    expect(queryClient.getQueryState(trafficKey)?.isInvalidated).toBe(false);
  });
});
