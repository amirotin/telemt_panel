import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const mountCounts = { logs: 0, events: 0 };

// Stand-ins for LogsTab/EventsTab: what matters here is whether
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
  EventsTab: () => {
    useEffect(() => {
      mountCounts.events += 1;
    }, []);
    return <div data-testid="events-tab">events</div>;
  },
}));

const { JournalPage } = await import("./JournalPage");

describe("JournalPage tab switching", () => {
  it("keeps both tabs mounted and toggles visibility via hidden, not remounting", () => {
    mountCounts.logs = 0;
    mountCounts.events = 0;

    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;

    act(() => {
      root = createRoot(container);
      root.render(<JournalPage />);
    });

    // Both mount exactly once up front — the fix mounts both tabs
    // immediately rather than deferring EventsTab's mount to first visit.
    expect(mountCounts.logs).toBe(1);
    expect(mountCounts.events).toBe(1);

    const logsPane = container.querySelector<HTMLElement>('[data-testid="logs-tab"]')!.parentElement!;
    const eventsPane = container.querySelector<HTMLElement>('[data-testid="events-tab"]')!.parentElement!;
    expect(logsPane.hidden).toBe(false);
    expect(eventsPane.hidden).toBe(true);

    const eventsButton = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (el) => el.textContent === "События",
    ) as HTMLButtonElement;
    act(() => eventsButton.click());

    expect(logsPane.hidden).toBe(true);
    expect(eventsPane.hidden).toBe(false);

    const logsButton = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (el) => el.textContent === "Логи",
    ) as HTMLButtonElement;
    act(() => logsButton.click());

    // Switching back and forth must not have remounted either tab — this
    // is exactly what would drop LogsTab's SSE stream/ring state and open
    // a second EventSource on the next switch back to «Логи».
    expect(mountCounts.logs).toBe(1);
    expect(mountCounts.events).toBe(1);

    act(() => root.unmount());
    container.remove();
  });
});
