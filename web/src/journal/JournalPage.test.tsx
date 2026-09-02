import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const mountCounts = { logs: 0, actions: 0 };

// Stand-ins for LogsTab/ActionsTab: what matters here is whether
// JournalPage mounts/unmounts them on every tab switch (the bug — each
// switch would reopen LogsTab's SSE connection and reset its ring) or
// keeps a single mount alive for the page's whole lifetime and merely
// hides the inactive one (the fix). A real LogsTab owns a live
// useLogStream EventSource; counting mount effect runs here proves the
// same "exactly one mount" guarantee without spinning one up.
vi.mock("./LogsTab", () => ({
  LogsTab: () => {
    useEffect(() => {
      mountCounts.logs += 1;
    }, []);
    return <div data-testid="logs-tab">logs</div>;
  },
}));
vi.mock("./EventsTab", () => ({
  ActionsTab: () => {
    useEffect(() => {
      mountCounts.actions += 1;
    }, []);
    return <div data-testid="actions-tab">actions</div>;
  },
}));

const { JournalPage } = await import("./JournalPage");

describe("JournalPage tab switching", () => {
  it("keeps both tabs mounted and toggles visibility via hidden, not remounting", () => {
    mountCounts.logs = 0;
    mountCounts.actions = 0;

    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;

    act(() => {
      root = createRoot(container);
      root.render(<JournalPage />);
    });

    // Both mount exactly once up front — the fix mounts both tabs
    // immediately rather than deferring ActionsTab's mount to first visit.
    expect(mountCounts.logs).toBe(1);
    expect(mountCounts.actions).toBe(1);

    const logsPane = container.querySelector<HTMLElement>('[data-testid="logs-tab"]')!.parentElement!;
    const actionsPane = container.querySelector<HTMLElement>('[data-testid="actions-tab"]')!.parentElement!;
    expect(logsPane.hidden).toBe(false);
    expect(actionsPane.hidden).toBe(true);

    const actionsButton = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (el) => el.querySelector("strong")?.textContent === "Действия",
    ) as HTMLButtonElement;
    act(() => actionsButton.click());

    expect(logsPane.hidden).toBe(true);
    expect(actionsPane.hidden).toBe(false);

    const logsButton = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (el) => el.querySelector("strong")?.textContent === "Логи",
    ) as HTMLButtonElement;
    act(() => logsButton.click());

    // Switching back and forth must not have remounted either tab — this
    // is exactly what would drop LogsTab's SSE stream/ring state and open
    // a second EventSource on the next switch back to «Логи».
    expect(mountCounts.logs).toBe(1);
    expect(mountCounts.actions).toBe(1);

    act(() => root.unmount());
    container.remove();
  });
});
