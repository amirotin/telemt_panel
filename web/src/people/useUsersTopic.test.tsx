import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AsyncState } from "../components/AsyncState";
import { createSSEClient, SSEProvider } from "../realtime";
import { FakeEventSource, fakeEventSourceFactory, latestInstance } from "../realtime/testing/fakeEventSource";
import { useUsersTopic } from "./useUsersTopic";

function Users() {
  const topic = useUsersTopic();
  return <AsyncState isPending={topic.isPending} isError={topic.isError} errorCode={topic.errorCode ?? undefined}
    data={topic.users} stale={topic.stale} skeleton={<span>loading users</span>}>
    {(users) => <span>{users.length ? "users loaded" : "empty users"}</span>}
  </AsyncState>;
}

it("shows the first source failure instead of an endless users loading state and recovers", async () => {
  vi.useFakeTimers();
  FakeEventSource.reset();
  const client = createSSEClient({ eventSourceFactory: fakeEventSourceFactory, debounceMs: 1 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SSEProvider client={client}><Users /></SSEProvider>));
    expect(container.textContent).toContain("loading users");
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    await act(async () => latestInstance().emitSourceError("users", "telemt_config_permission_denied"));
    expect(container.textContent).toMatch(/владельца файла/);
    expect(container.textContent).not.toContain("loading users");
    await act(async () => latestInstance().emitData("users", { users: [], quota: null, quota_supported: false }, 10));
    expect(container.textContent).toContain("empty users");
    await act(async () => latestInstance().emitSourceError("users", "telemt_timeout"));
    expect(container.textContent).toContain("empty users");
    expect(container.textContent).not.toContain("loading users");
  } finally {
    act(() => root.unmount());
    client.dispose();
    container.remove();
    vi.useRealTimers();
  }
});
