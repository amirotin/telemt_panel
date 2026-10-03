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
  JournalSource.instances = [];
  vi.stubGlobal("EventSource", JournalSource);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<DisplayModeProvider><LogStreamViewer service="telemt" onServiceChange={() => {}} /></DisplayModeProvider>));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

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
});
