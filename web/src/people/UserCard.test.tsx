import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsersTopicUser } from "../realtime/topics";
import { UserCard } from "./UserCard";
import { PeopleContext } from "./PeopleContext";
import type {SwipeSide} from "./useUserRowGestures";

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
      const [swipeSide, setSwipeSide] = useState<SwipeSide>(initialSwipeOpen?"left":null);
      return (
        <UserCard
          user={user}
          quotaEntry={undefined}
          now={Date.now()}
          gesturesEnabled
          swipeSide={swipeSide}
          onOpen={onOpen}
          onResetQuota={vi.fn()}
          onToggle={vi.fn()}
          onActions={() => { setSwipeSide(null); onActions(); }}
          onSwipeChange={setSwipeSide}
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

    const row = container.querySelector<HTMLElement>(".user-row-face")!;
    const shell = container.querySelector<HTMLElement>(".user-row-shell")!;
    expect(shell.dataset["swipe"]).toBe("left");

    act(() => row.dispatchEvent(pointerEvent("pointerdown", 220, 100)));
    act(() => vi.advanceTimersByTime(500));
    expect(onActions).toHaveBeenCalledTimes(1);

    act(() => row.dispatchEvent(pointerEvent("pointerup", 120, 100)));
    act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(shell.dataset["swipe"]).toBe("closed");
    expect(container.querySelector(".user-side-quota")?.getAttribute("aria-hidden")).toBe("true");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens quick actions after a horizontal swipe without also opening the user", () => {
    const { onOpen } = renderCard();
    const row = container.querySelector<HTMLElement>(".user-row-face")!;
    const shell = container.querySelector<HTMLElement>(".user-row-shell")!;

    act(() => row.dispatchEvent(pointerEvent("pointerdown", 220, 100)));
    act(() => row.dispatchEvent(pointerEvent("pointermove", 120, 102)));
    act(() => row.dispatchEvent(pointerEvent("pointerup", 120, 102)));

    expect(shell.dataset["swipe"]).toBe("left");
    expect(container.querySelector(".user-side-quota")?.getAttribute("aria-hidden")).toBe("false");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps the ordinary click as the discoverable primary action", () => {
    const { onOpen } = renderCard();
    const row = container.querySelector<HTMLElement>(".user-identity")!;

    act(() => row.click());

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  function renderDisplay(overrides: Partial<UsersTopicUser> = {}, usedBytes?: number, onOpen=vi.fn()) {
    act(() => root.render(<PeopleContext.Provider value={{ profiles:new Map(), webUnavailable:false, readOnly:false, canResetQuota:true, canToggle:true, formats:new Map(), setFormat:()=>{}, listView:{search:"",filter:"all",scrollOffset:0,returnUsername:null} }}>
      <UserCard user={{...user,...overrides}} quotaEntry={usedBytes===undefined?undefined:{used_bytes:usedBytes,data_quota_bytes:2048,last_reset_epoch_secs:0}} now={Date.now()} gesturesEnabled onOpen={onOpen} onActions={vi.fn()} onResetQuota={vi.fn()} onToggle={vi.fn()} onSwipeChange={vi.fn()}/>
    </PeopleContext.Provider>));
  }

  it("fills the quota indicator from quota usage, not accumulated panel traffic", () => {
    renderDisplay({data_quota_bytes:2048,traffic:{observed_total_bytes:8192,current_month_bytes:4096,month_key:202610,observed_since_epoch_secs:1,last_activity_epoch_secs:2,continuity:"normal"}},1024);
    expect(container.querySelector<HTMLElement>("[data-quota-fill]")?.style.getPropertyValue("--quota-fill")).toBe("50%");
    expect(container.querySelector("[data-quota-used]")?.textContent).toBe("1.0 КБ");
    expect(container.querySelector("[data-observed-traffic]")?.textContent).toContain("8.0 КБ");
  });

  it("keeps unavailable quota usage unknown rather than showing a false zero", () => {
    renderDisplay({data_quota_bytes:2048});
    expect(container.querySelector("[data-quota-used]")?.textContent).toBe("—");
    expect(container.querySelector("[data-quota-fill]")?.getAttribute("role")).not.toBe("progressbar");
    expect(container.querySelector("[data-observed-traffic]")?.textContent).toContain("—");
  });

  it("shows expired access and a visible menu on phones, with a decorative avatar", () => {
    renderDisplay({username:"ёж",expiration_rfc3339:"2020-01-01T00:00:00Z"});
    expect(container.querySelector(".user-identity small")?.textContent).toBe("Истёк срок");
    expect(container.querySelector(".user-avatar")?.textContent).toBe("Ё");
    expect(container.querySelector(".user-avatar")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('button[aria-label="Действия ёж"]')).not.toBeNull();
  });

  it("does not navigate the row when clicking inside the manual-copy portal",async()=>{
    const onOpen=vi.fn();
    renderDisplay({links:{...user.links,tls:["tg://proxy?server=proxy.example.org&port=443&secret=ee0123456789abcdef0123456789abcdef6578616d706c652e6f7267"]}},undefined,onOpen);
    await act(async()=>{container.querySelector<HTMLButtonElement>('[aria-label="Копировать EE · alice"]')!.click();});
    const title=document.querySelector<HTMLElement>('[role="dialog"] h2');
    expect(title).not.toBeNull();
    act(()=>title!.click());
    expect(onOpen).not.toHaveBeenCalled();
  });
});
