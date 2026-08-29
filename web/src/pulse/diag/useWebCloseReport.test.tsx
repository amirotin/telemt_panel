import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ru } from "../../i18n/ru";
import type { WebControlOperationStatus } from "../../lib/api/generated/types.gen";
import { useWebCloseReport, type WebCloseReportInput } from "./useWebCloseReport";

// The toasts are the observable half of the report, so they are captured
// here rather than rendered — what is under test is HOW MANY times the
// effect fires, which the viewport would hide behind its own dedupe.
const toasts: Array<[string, string]> = [];
vi.mock("../../ui/Toast", () => ({
  pushToast: (message: string, variant = "default") => {
    toasts.push([message, variant]);
    return 0;
  },
}));

const completed: WebControlOperationStatus = {
  operation_id: "wo1.0123456789abcdef0123456789abcdef.0000000000000001",
  state: "completed",
  high_water_session_ref: "ws1.0123456789abcdef0123456789abcdef.0000000000000018",
  scanned: 24,
  matched: 2,
  close_signalled: 2,
  conflicted: 0,
  requested: 2,
  created_epoch_millis: 1_756_000_000_000,
  updated_epoch_millis: 1_756_000_000_500,
};

let mounted: { container: HTMLElement; root: Root } | null = null;

function Probe(props: WebCloseReportInput) {
  useWebCloseReport(props);
  return null;
}

function render(node: ReactNode): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<StrictMode>{node}</StrictMode>));
  mounted = { container, root };
}

function rerender(node: ReactNode): void {
  act(() => mounted!.root.render(<StrictMode>{node}</StrictMode>));
}

beforeEach(() => {
  toasts.length = 0;
});

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

describe("reporting a WEB close operation", () => {
  it("reports a completed operation ONCE despite StrictMode's double-invoked effects", () => {
    // The bug this replaces: the report was a bare `if` in the render body,
    // and StrictMode re-invokes render with the pre-update guard — so the
    // toast fired twice and invalidateQueries ran during render.
    const settled = vi.fn();
    const moved = vi.fn();
    render(
      <Probe
        operationId={completed.operation_id}
        data={completed}
        error={null}
        onSettled={settled}
        onRegistryMoved={moved}
      />,
    );
    expect(toasts).toEqual([[ru.details.pages.web.closeDoneTemplate.replace("{count}", "2"), "ok"]]);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(moved).toHaveBeenCalledTimes(1);

    // A re-render with the same payload — a poll that answered again before
    // the caller cleared the id — must not report a second time.
    rerender(
      <Probe
        operationId={completed.operation_id}
        data={{ ...completed }}
        error={null}
        onSettled={settled}
        onRegistryMoved={moved}
      />,
    );
    expect(toasts).toHaveLength(1);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("adds the conflicted count as its own toast", () => {
    render(
      <Probe
        operationId={completed.operation_id}
        data={{ ...completed, close_signalled: 1, conflicted: 1 }}
        error={null}
        onSettled={() => {}}
        onRegistryMoved={() => {}}
      />,
    );
    expect(toasts).toHaveLength(2);
    expect(toasts[1]).toEqual([
      ru.details.pages.web.closeConflictTemplate.replace("{count}", "1"),
      "default",
    ]);
  });

  it("says nothing at all while the operation is still running", () => {
    const settled = vi.fn();
    render(
      <Probe
        operationId={completed.operation_id}
        data={{ ...completed, state: "running" }}
        error={null}
        onSettled={settled}
        onRegistryMoved={() => {}}
      />,
    );
    expect(toasts).toEqual([]);
    expect(settled).not.toHaveBeenCalled();
  });

  it("reports a failed operation as an error and still stops the poll", () => {
    const settled = vi.fn();
    render(
      <Probe
        operationId={completed.operation_id}
        data={{ ...completed, state: "failed" }}
        error={null}
        onSettled={settled}
        onRegistryMoved={() => {}}
      />,
    );
    expect(toasts).toEqual([[ru.details.pages.web.closeFailed, "error"]]);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("surfaces a FAILING poll with Telemt's own code and stops asking", () => {
    // An id older than Telemt's 32-operation retention answers 404 forever.
    const settled = vi.fn();
    render(
      <Probe
        operationId={completed.operation_id}
        data={undefined}
        error={{ code: "web_operation_not_found", message: "" }}
        onSettled={settled}
        onRegistryMoved={() => {}}
      />,
    );
    expect(toasts).toEqual([[ru.errors.web_operation_not_found, "error"]]);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("does not report a poll error while nothing is in flight", () => {
    const settled = vi.fn();
    render(
      <Probe
        operationId={null}
        data={undefined}
        error={{ code: "web_runtime_mismatch", message: "" }}
        onSettled={settled}
        onRegistryMoved={() => {}}
      />,
    );
    expect(toasts).toEqual([]);
    expect(settled).not.toHaveBeenCalled();
  });
});
