import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSSEClient, type SSEClient } from "./sseClient";
import { SSEProvider, useSnapshot } from "./context";
import { FakeEventSource, fakeEventSourceFactory } from "./testing/fakeEventSource";
import type { TopicName } from "./types";

// React-level tests for the hook layer (context.tsx) on top of sseClient.ts
// — the ref-counting/debounce unit tests in sseClient.test.ts exercise the
// client directly; these prove React's own render/effect churn (StrictMode's
// deliberate double-invoke, and navigation-style unmount/remount) doesn't
// turn into a reconnect storm once real components are involved.

function Consumer({ topic }: { topic: TopicName }) {
  useSnapshot(topic);
  return null;
}

function App({ client, children }: { client: SSEClient; children: ReactNode }) {
  return (
    <StrictMode>
      <SSEProvider client={client}>{children}</SSEProvider>
    </StrictMode>
  );
}

let container: HTMLElement;
let root: Root | null = null;
let client: SSEClient;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
  client = createSSEClient({ eventSourceFactory: fakeEventSourceFactory, debounceMs: 10 });
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container.remove();
  client.dispose();
  vi.useRealTimers();
});

describe("useTopic/useSnapshot under React.StrictMode", () => {
  it("creates exactly one EventSource despite StrictMode's double-invoked effects", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <App client={client}>
          <Consumer topic="stats" />
        </App>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]?.url).toContain("topics=stats");
    // No further churn once settled.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(FakeEventSource.instances.length).toBe(1);
  });

  it("a People -> Pulse -> People topic-set round trip within the debounce window causes no reconnect storm", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <App client={client}>
          <Consumer topic="users" />
        </App>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]?.url).toContain("topics=users");

    // Rapid nav: People (users) -> Pulse (runtime) -> People (users) again,
    // all inside one debounce window (10ms) — mirrors a user tapping
    // through tabs faster than the connection could ever keep up with.
    await act(async () => {
      root!.render(
        <App client={client}>
          <Consumer topic="runtime" />
        </App>,
      );
    });
    await act(async () => {
      root!.render(
        <App client={client}>
          <Consumer topic="users" />
        </App>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    // Net topic set is back to exactly where it started and the original
    // connection never actually needed to drop — no reconnect storm.
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]?.closed).toBe(false);
    expect(FakeEventSource.instances[0]?.url).toContain("topics=users");
  });

  it("unmounting the last subscriber closes the connection, remounting reopens it", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <App client={client}>
          <Consumer topic="stats" />
        </App>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(FakeEventSource.instances.length).toBe(1);

    await act(async () => {
      root!.render(<App client={client}>{null}</App>);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    expect(client.getConnectionSnapshot().status).toBe("closed");

    await act(async () => {
      root!.render(
        <App client={client}>
          <Consumer topic="stats" />
        </App>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.instances[1]?.closed).toBe(false);
  });
});
