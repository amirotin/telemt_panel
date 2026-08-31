import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ru } from "../../i18n";
import {
  webSessionsAll,
  webStatusRunning,
  webTopicUnsupported,
} from "../details-builder/__fixtures__/web";
import { webPagePayload } from "./web.helpers";
import { GateView, Overview, SessionsView } from "./WebPage";

describe("WEB redesigned surfaces", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("renders the approved overview hierarchy from real WEB fields", () => {
    const payload = webPagePayload(webStatusRunning, [webSessionsAll]);
    expect(payload).not.toBeNull();
    act(() => root.render(<Overview payload={payload!} s={ru} />));

    expect(host.querySelectorAll("[data-web-vital]")).toHaveLength(5);
    expect(host.querySelectorAll("[data-web-capacity]")).toHaveLength(5);
    expect(host.querySelector('[data-web-capacity="sessions"]')?.textContent).toContain("128");
    expect(host.querySelector('[data-testid="web-flow"]')?.textContent).toContain("Streams");
    expect(host.querySelectorAll('[data-testid="web-planes"] > div > div')).toHaveLength(3);
  });

  it("reveals sessions gradually and filters loaded rows", () => {
    const payload = webPagePayload(webStatusRunning, [webSessionsAll]);
    const onIntent = vi.fn();
    const onOpenSession = vi.fn();
    act(() =>
      root.render(
        <SessionsView
          payload={payload!}
          pending={false}
          error={false}
          fetchingMore={false}
          hasMore={false}
          closePending={false}
          canClose
          issuanceEnabled
          onRetry={vi.fn()}
          onLoadMore={vi.fn()}
          onIntent={onIntent}
          onOpenSession={onOpenSession}
          s={ru}
        />,
      ),
    );

    expect(host.querySelectorAll("[data-web-session]")).toHaveLength(8);
    act(() => host.querySelector<HTMLButtonElement>("[data-web-session] button")!.click());
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession.mock.calls[0]?.[0]).toMatchObject({ session_ref: expect.any(String) });
    const showMore = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Показать ещё"),
    );
    expect(showMore).toBeDefined();
    act(() => showMore!.click());
    expect(host.querySelectorAll("[data-web-session]")).toHaveLength(16);

    const provisional = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Provisional",
    );
    act(() => provisional!.click());
    const states = [...host.querySelectorAll("[data-web-session-state]")].map((node) =>
      node.getAttribute("data-web-session-state"),
    );
    expect(states).toHaveLength(6);
    expect(states.every((state) => state === "provisional")).toBe(true);
  });

  it("renders capability absence without fake runtime metrics", () => {
    expect(webTopicUnsupported.status?.reason).toBe("capability_absent");
    act(() => root.render(<GateView unsupported s={ru} />));
    expect(host.querySelector('[data-web-gate="unsupported"]')?.textContent).toContain(
      "CAPABILITY_ABSENT",
    );
    expect(host.querySelectorAll("[data-web-vital]")).toHaveLength(0);
  });
});
