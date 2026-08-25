import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLogStream } from "./useLogStream";
import { FakeEventSource, fakeEventSourceFactory, latestInstance } from "../realtime/testing/fakeEventSource";
import type { LogLine } from "../lib/api/generated/types.gen";

// React-level tests for the hook layer on top of logStream.ts — mirrors
// realtime/context.test.tsx's approach (StrictMode double-invoke, real
// unmount/remount) rather than reaching for a testing-library dependency
// this project doesn't have.

function Consumer({ service, onLine }: { service: string; onLine: (l: LogLine) => void }) {
  useLogStream(service, onLine, { eventSourceFactory: fakeEventSourceFactory });
  return null;
}

function App({ service, onLine }: { service: string; onLine: (l: LogLine) => void }) {
  return (
    <StrictMode>
      <Consumer service={service} onLine={onLine} />
    </StrictMode>
  );
}

let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  FakeEventSource.reset();
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
  root = null;
});

describe("useLogStream under React.StrictMode", () => {
  it("opens exactly one EventSource for the given service despite StrictMode's double-invoked effects", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(<App service="telemt" onLine={() => {}} />);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latestInstance().url).toContain("service=telemt");
  });

  it("delivers lines to the onLine callback", async () => {
    root = createRoot(container);
    const lines: LogLine[] = [];
    await act(async () => {
      root!.render(<App service="telemt" onLine={(l) => lines.push(l)} />);
    });
    const line: LogLine = { ts: "2026-08-25T12:00:00Z", level: "info", msg: "hi" };
    await act(async () => {
      latestInstance().emitLog(line);
    });
    expect(lines).toEqual([line]);
  });

  it("closes the old EventSource and opens a new one when service changes", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(<App service="telemt" onLine={() => {}} />);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    const first = latestInstance();

    await act(async () => {
      root!.render(<App service="panel" onLine={() => {}} />);
    });

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latestInstance().url).toContain("service=panel");
    expect(latestInstance().closed).toBe(false);
  });

  it("closes the EventSource on unmount and reopens on remount", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(<App service="telemt" onLine={() => {}} />);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    const first = latestInstance();

    await act(async () => {
      root!.render(<div />);
    });
    expect(first.closed).toBe(true);

    await act(async () => {
      root!.render(<App service="telemt" onLine={() => {}} />);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latestInstance().closed).toBe(false);
  });
});

// Sanity check that useState-driven service switching (the real
// LogStreamViewer usage, a toolbar toggling local state) exercises the
// exact same close+reopen path as the prop-driven App above.
function Toggler({ onLine }: { onLine: (l: LogLine) => void }) {
  const [service, setService] = useState("telemt");
  useLogStream(service, onLine, { eventSourceFactory: fakeEventSourceFactory });
  return (
    <button type="button" onClick={() => setService("panel")}>
      switch
    </button>
  );
}

describe("useLogStream driven by local component state", () => {
  it("reopens when the owning component's own state switches service", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(<Toggler onLine={() => {}} />);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    const first = latestInstance();

    await act(async () => {
      container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(first.closed).toBe(true);
    expect(latestInstance().url).toContain("service=panel");
  });
});
