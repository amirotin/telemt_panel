import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayModeProvider } from "../display-mode";
import { ru } from "../i18n/testing";
import { LogStreamViewer } from "./LogStreamViewer";

class JournalSource extends EventTarget {
  static instances: JournalSource[] = [];
  readyState = 0;
  closed = false;
  constructor() { super(); JournalSource.instances.push(this); }
  close() { this.closed = true; this.readyState = 2; }
  emit(name: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  JournalSource.instances = [];
  vi.stubGlobal("EventSource", JournalSource);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<DisplayModeProvider><LogStreamViewer service="telemt" onServiceChange={() => {}} /></DisplayModeProvider>));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Journal source states", () => {
  it.each(["native", "backoff", "manual"])("replaces file history after %s reconnect and keeps real repeated lines", reconnect => {
    let source = JournalSource.instances[0];
    const line = { ts: "2026-10-03T12:00:00Z", level: "info", msg: "repeated file entry" };
    act(() => {
      source.emit("open", {});
      source.emit("log_reset", { source: "file" });
      source.emit("log", line);
      source.emit("log", line);
    });
    if (reconnect === "native") {
      act(() => {
        source.readyState = 0;
        source.emit("error", {});
        source.readyState = 1;
        source.emit("open", {});
      });
    } else if (reconnect === "backoff") {
      act(() => source.emit("log_end", {}));
      act(() => vi.advanceTimersByTime(1000));
      source = JournalSource.instances[1];
    } else {
      act(() => source.emit("log_source_error", {
        code: "log_source_error", message: "safe diagnostic", source: "file",
        service: "telemt", reason: "permission_denied",
      }));
      const retry = [...container.querySelectorAll("button")].find(button => button.textContent === ru.journal.retryStream);
      act(() => retry!.click());
      source = JournalSource.instances[1];
    }
    act(() => {
      source.emit("open", {});
      source.emit("log_reset", { source: "file" });
      source.emit("log", line);
      source.emit("log", line);
    });
    expect(container.textContent?.match(/repeated file entry/g)).toHaveLength(2);
  });

  it("removes old entries when the reconnected file is empty", () => {
    const source = JournalSource.instances[0];
    act(() => {
      source.emit("open", {});
      source.emit("log", { ts: "2026-10-03T12:00:00Z", level: "info", msg: "old file content" });
      source.emit("log_reset", { source: "file" });
    });
    expect(container.textContent).not.toContain("old file content");
    expect(container.textContent).toContain(ru.journal.emptyTitle);
  });

  it("retains paused rows until resume, then replaces them with reconnected file history", () => {
    const source = JournalSource.instances[0];
    act(() => source.emit("log", { ts: "2026-10-03T12:00:00Z", level: "info", msg: "paused visible row" }));
    const pause = [...container.querySelectorAll("button")].find(button => button.textContent === ru.journal.pause);
    expect(pause).toBeDefined();
    act(() => pause!.click());
    act(() => {
      source.emit("log", { ts: "2026-10-03T12:00:01Z", level: "info", msg: "old pending row" });
      source.emit("log_reset", { source: "file" });
      source.emit("log", { ts: "2026-10-03T12:00:02Z", level: "info", msg: "refreshed file row" });
    });
    expect(container.textContent).toContain("paused visible row");
    expect(container.textContent).not.toContain("refreshed file row");
    const resume = [...container.querySelectorAll("button")].find(button => button.textContent === ru.journal.resume);
    act(() => resume!.click());
    expect(container.textContent).not.toContain("paused visible row");
    expect(container.textContent).not.toContain("old pending row");
    expect(container.textContent).toContain("refreshed file row");
  });

  it("applies an empty file snapshot on resume without moving paused rows early", () => {
    const source = JournalSource.instances[0];
    act(() => source.emit("log", { ts: "2026-10-03T12:00:00Z", level: "info", msg: "paused file content" }));
    act(() => [...container.querySelectorAll("button")].find(button => button.textContent === ru.journal.pause)!.click());
    act(() => source.emit("log_reset", { source: "file" }));
    expect(container.textContent).toContain("paused file content");
    act(() => [...container.querySelectorAll("button")].find(button => button.textContent === ru.journal.resume)!.click());
    expect(container.textContent).not.toContain("paused file content");
  });

  it("does not claim the source is connected while it is still connecting", () => {
    expect(container.textContent).not.toContain(ru.journal.emptyDescription);
  });

  it("shows source failure and retry while retaining already received lines", () => {
    const source = JournalSource.instances[0];
    act(() => source.emit("log", { ts: "2026-10-03T12:00:00Z", level: "info", msg: "retained service line" }));
    act(() => source.emit("log_source_error", {
      code: "log_source_error", message: "safe diagnostic", source: "file", service: "telemt",
      target: "/var/log/private-telemt.log", reason: "permission_denied",
    }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("/var/log/private-telemt.log");
    expect(container.textContent).toContain("retained service line");
    act(() => vi.advanceTimersByTime(60_000));
    expect(JournalSource.instances).toHaveLength(1);
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent === ru.journal.retryStream);
    expect(retry).toBeDefined();
    act(() => retry!.click());
    expect(JournalSource.instances).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("retained service line");
  });

  it("does not describe a normally ended empty stream as connected", () => {
    act(() => JournalSource.instances[0].emit("log_end", {}));
    expect(container.textContent).not.toContain(ru.journal.emptyDescription);
  });

  it("retains lines and shows reconnection while automatically reopening after EOF", () => {
    act(() => JournalSource.instances[0].emit("log", {
      ts: "2026-10-03T12:00:00Z", level: "info", msg: "line before EOF",
    }));
    act(() => JournalSource.instances[0].emit("log_end", {}));
    expect(container.textContent).toContain("line before EOF");
    expect(container.textContent).toContain(ru.journal.reconnecting);
    act(() => vi.advanceTimersByTime(1000));
    expect(JournalSource.instances).toHaveLength(2);
    expect(container.textContent).toContain("line before EOF");
  });

  it("shows a transient source notice through reconnect until a healthy frame arrives", () => {
    act(() => JournalSource.instances[0].emit("log", {
      ts: "2026-10-03T12:00:00Z", level: "info", msg: "line before daemon failure",
    }));
    act(() => JournalSource.instances[0].emit("log_source_error", {
      code: "log_source_error", message: "safe diagnostic", source: "docker", service: "telemt",
      target: "telemt-container", reason: "daemon_unavailable",
    }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("telemt-container");
    expect(container.textContent).toContain(ru.journal.reconnecting);
    act(() => vi.advanceTimersByTime(1000));
    expect(JournalSource.instances).toHaveLength(2);
    act(() => JournalSource.instances[1].emit("open", {}));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain("line before daemon failure");
    act(() => JournalSource.instances[1].emit("heartbeat", {}));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("line before daemon failure");
  });
});
