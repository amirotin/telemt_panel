import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsersTopicUser } from "../realtime/topics";
import { UserCard } from "./UserCard";

const user: UsersTopicUser = {
  username: "alice",
  enabled: true,
  in_runtime: true,
  current_connections: 1,
  active_unique_ips: 1,
  active_unique_ips_list: ["192.0.2.1"],
  recent_unique_ips: 1,
  recent_unique_ips_list: ["192.0.2.1"],
  total_octets: 1024,
  links: { classic: [], secure: [], tls: [], tls_domains: [] },
};

function pointerEvent(type: string, clientX: number, clientY: number): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "touch" },
  });
  return event;
}

describe("UserCard gestures", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function renderCard({ initialSwipeOpen = false, onOpen = vi.fn(), onActions = vi.fn() } = {}) {
    function Harness() {
      const [swipeOpen, setSwipeOpen] = useState(initialSwipeOpen);
      return (
        <UserCard
          user={user}
          quotaEntry={undefined}
          now={Date.now()}
          gesturesEnabled
          swipeOpen={swipeOpen}
          onOpen={onOpen}
          onAccess={vi.fn()}
          onActions={() => { setSwipeOpen(false); onActions(); }}
          onSwipeOpen={() => setSwipeOpen(true)}
          onSwipeClose={() => setSwipeOpen(false)}
        />
      );
    }

    act(() => root.render(<Harness />));
    return { onOpen, onActions };
  }

  it("lets long press win over an open swipe and restores the row before opening actions", () => {
    const onOpen = vi.fn();
    const onActions = vi.fn();
    renderCard({ initialSwipeOpen: true, onOpen, onActions });

    const row = container.querySelector<HTMLElement>(".people-user-row")!;
    const shell = container.querySelector<HTMLElement>(".people-user-shell")!;
    expect(shell.classList.contains("is-swiped")).toBe(true);

    act(() => row.dispatchEvent(pointerEvent("pointerdown", 220, 100)));
    act(() => vi.advanceTimersByTime(500));
    expect(onActions).toHaveBeenCalledTimes(1);

    act(() => row.dispatchEvent(pointerEvent("pointerup", 120, 100)));
    act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(shell.classList.contains("is-swiped")).toBe(false);
    expect(container.querySelector(".people-swipe-actions")?.getAttribute("aria-hidden")).toBe("true");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens quick actions after a horizontal swipe without also opening the user", () => {
    const { onOpen } = renderCard();
    const row = container.querySelector<HTMLElement>(".people-user-row")!;
    const shell = container.querySelector<HTMLElement>(".people-user-shell")!;

    act(() => row.dispatchEvent(pointerEvent("pointerdown", 220, 100)));
    act(() => row.dispatchEvent(pointerEvent("pointermove", 120, 102)));
    act(() => row.dispatchEvent(pointerEvent("pointerup", 120, 102)));

    expect(shell.classList.contains("is-swiped")).toBe(true);
    expect(container.querySelector(".people-swipe-actions")?.getAttribute("aria-hidden")).toBe("false");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps the ordinary click as the discoverable primary action", () => {
    const { onOpen } = renderCard();
    const row = container.querySelector<HTMLElement>(".people-user-row")!;

    act(() => row.click());

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
