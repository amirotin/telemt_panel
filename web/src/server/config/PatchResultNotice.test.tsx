import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { PatchResultNotice } from "./PatchResultNotice";
import { getStrings } from "../../i18n";
import type { TelemtConfigPatchResult } from "../../lib/api/generated/types.gen";

// DOM-rendering test in the StatePill.test.tsx style (react-dom/client +
// act, no testing-library). Assertions read the active dictionary rather
// than hardcoding Russian, so the test says nothing about which locale
// jsdom resolved to.
function render(result: TelemtConfigPatchResult): { container: HTMLDivElement; cleanup: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <PatchResultNotice
        result={result}
        canRestartTelemt
        onReloadNow={() => {}}
        onRestartNow={() => {}}
        reloadPending={false}
        restartPending={false}
      />,
    );
  });
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("PatchResultNotice", () => {
  it("names the deferred fields when Telemt reported them", () => {
    const { container, cleanup } = render({
      revision: "cfg-2",
      changed: ["web"],
      process_restart_required: true,
      deferred_process_fields: ["web.limits"],
    });

    const mono = container.querySelector("p.text-text-muted span.font-mono");
    expect(mono?.textContent).toBe("web.limits");
    expect(container.textContent).toContain(getStrings().server.config.processRestartNotice);

    cleanup();
  });

  it("renders no dangling colon or empty field span when the list is empty", () => {
    const { container, cleanup } = render({
      revision: "cfg-2",
      changed: ["web"],
      process_restart_required: true,
      deferred_process_fields: [],
    });

    const s = getStrings();
    // The restart prompt is still there — only the "…:" + field list form
    // is gone, replaced by the self-contained sentence.
    expect(container.textContent).toContain(s.server.config.processRestartNoticeNoFields);
    expect(container.textContent).not.toContain(s.server.config.processRestartNotice);
    expect(container.querySelector("p.text-text-muted span.font-mono")).toBeNull();

    cleanup();
  });

  it("omits the restart block entirely when no restart is required", () => {
    const { container, cleanup } = render({
      revision: "cfg-2",
      changed: ["general"],
      process_restart_required: false,
      deferred_process_fields: [],
    });

    const s = getStrings();
    expect(container.textContent).not.toContain(s.server.config.processRestartNoticeNoFields);
    expect(container.textContent).not.toContain(s.server.config.restartNow);

    cleanup();
  });
});
