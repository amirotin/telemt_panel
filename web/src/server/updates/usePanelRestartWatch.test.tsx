import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client as apiClient } from "../../lib/api/generated/client.gen";
import { getHealthQueryKey, getUpdatesQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { UpdateRun, UpdatesStatus } from "../../lib/api/generated/types.gen";
import { usePanelRestartWatch } from "./usePanelRestartWatch";

type Pending = { path: string; resolve: (response: Response) => void };
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let pending: Pending[];
let runID: string;
const originalConfig = apiClient.getConfig();
const version = "v1.0.0-rc.2";

function Probe() {
  const watch = usePanelRestartWatch(true, runID, version);
  return <p>{watch.status}{watch.failure?.detail}</p>;
}

async function render() {
  await act(async () => root.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}

async function reply(path: string, data: unknown) {
  const index = pending.findIndex((request) => request.path === path);
  expect(index).toBeGreaterThanOrEqual(0);
  await act(async () => {
    pending.splice(index, 1)[0].resolve(Response.json(data));
    await vi.advanceTimersByTimeAsync(1);
  });
}

function updates(run: UpdateRun): UpdatesStatus {
  return { lock_held: false, targets: [{ target: "panel", current_version: "1.0.0-rc.1", releases: [], journal: [run] }] };
}

function journal(id: string, phase: UpdateRun["phase"], detail?: string): UpdateRun {
  return { target: "panel", run_id: id, phase, version_to: version, started_at: "2026-10-03T10:00:05Z", detail };
}

beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  runID = "current";
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  apiClient.setConfig({ baseUrl: "http://localhost", fetch: (input) => new Promise((resolve) => pending.push({ path: new URL((input as Request).url).pathname, resolve })) });
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  apiClient.setConfig(originalConfig);
  vi.useRealTimers();
});

describe("usePanelRestartWatch", () => {
  it("ignores cached probes and another run's failure until fresh health confirms", async () => {
    queryClient.setQueryData(getHealthQueryKey(), { version: "1.0.0-rc.2" });
    queryClient.setQueryData(getUpdatesQueryKey(), updates(journal("previous", "failed", "previous error")));
    queryClient.setQueryData(["panel-restart-health", runID, version], { version: "1.0.0-rc.2" });
    queryClient.setQueryData(["panel-restart-updates", runID, version], updates(journal("previous", "failed", "previous error")));
    await render();
    expect(container.textContent).toBe("wait");
    await reply("/api/updates", updates(journal("previous", "rolled_back", "previous error")));
    await reply("/api/health", { version: "1.0.0-rc.1" });
    expect(container.textContent).toBe("wait");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await reply("/api/health", { version: "1.0.0-rc.2" });
    expect(container.textContent).toBe("reload");
  });

  it("waits for live readiness after startup reports done", async () => {
    await render();
    await reply("/api/updates", updates(journal("current", "done")));
    expect(container.textContent).toBe("wait");
    await reply("/api/health", { version: "1.0.0-rc.2" });
    expect(container.textContent).toBe("reload");
  });

  it("reports a fresh current failure with its real detail", async () => {
    await render();
    await reply("/api/updates", updates(journal("current", "failed", "rollback restore failed: permission denied")));
    expect(container.textContent).toBe("failedrollback restore failed: permission denied");
    expect(queryClient.getQueryData<UpdatesStatus>(getUpdatesQueryKey())?.targets[0].journal?.[0].detail).toBe("rollback restore failed: permission denied");
  });

  it("ignores an earlier run's health request that completes during a new watch", async () => {
    runID = "previous";
    await render();
    runID = "current";
    await render();
    await reply("/api/health", { version: "1.0.0-rc.2" });
    expect(container.textContent).toBe("wait");
    await reply("/api/health", { version: "1.0.0-rc.2" });
    expect(container.textContent).toBe("reload");
  });
});
