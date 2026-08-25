import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SSEProvider } from "../realtime";
import { client } from "../lib/api/client";
import { FakeEventSource } from "../realtime/testing/fakeEventSource";
import { UserActionSheet } from "./UserActionSheet";
import { intentToView } from "./actionSheet.helpers";
import type { UsersTopicUser } from "../realtime/topics";

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

  function render(user: UsersTopicUser) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SSEProvider>
            <UserActionSheet
              open
              intent="toggle-enabled"
              user={user}
              onClose={() => {}}
              onEdit={() => {}}
            />
          </SSEProvider>
        </QueryClientProvider>,
      );
    });
  }

  function confirmButton(): HTMLButtonElement {
    const buttons = Array.from(document.body.querySelectorAll("button"));
    const btn = buttons.find((b) => b.textContent === "Отключить" || b.textContent === "Включить");
    if (!btn) throw new Error(`no confirm button; saw: ${buttons.map((b) => b.textContent).join(" | ")}`);
    return btn as HTMLButtonElement;
  }

  it("keeps the frozen decision when the live user flips mid-confirmation", async () => {
    render(makeUser({ enabled: true }));
    expect(confirmButton().textContent).toBe("Отключить");

    // A "users" topic push lands while the confirmation is on screen and
    // flips the user to disabled.
    render(makeUser({ enabled: false }));
    expect(confirmButton().textContent).toBe("Отключить");

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
});
