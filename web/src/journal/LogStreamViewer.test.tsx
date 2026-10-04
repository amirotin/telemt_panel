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
