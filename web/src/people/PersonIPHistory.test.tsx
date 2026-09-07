import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getUserIpHistoryQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import type { UserIpHistory } from "../lib/api/generated/types.gen";
import { PersonIPHistory } from "./PersonIPHistory";

let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;
const now = Math.floor(Date.now()/1000);
function history(overrides: Partial<UserIpHistory> = {}): UserIpHistory {
  return {items:[{username:"alice",ip:"2001:db8:85a3:8d3:1319:8a2e:370:7348",family:6,first_observed_at:now-100,last_observed_at:now-10,observations:3,last_source_mask:3,active_now:true}],total:21,matched:21,new:2,next_cursor:"page2",range:"30d",retention_days:30,durable:true,collection:{observed_since:now-200,collected_through:now-10,history_limited:false,collection_gap:false},source:{state:"collecting",last_success_at:now-10,age_secs:10,recent_window_secs:75,pending:false,history_limited:false,collection_gap:false},active_now_count:4,...overrides};
}
function seed(data:UserIpHistory, query = {}, username="alice") {
  client.setQueryData(getUserIpHistoryQueryKey({path:{username},query:{range:"30d",family:"all",q:"",limit:10,cursor:"",...query}}),data);
}
async function mount(data = history()) {
  client = new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});seed(data);
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
  await act(async()=>root!.render(<QueryClientProvider client={client}><PersonIPHistory username="alice" /></QueryClientProvider>));
}
afterEach(()=>{if(root)act(()=>root!.unmount());container?.remove();client?.clear();root=undefined;vi.restoreAllMocks()});

describe("PersonIPHistory",()=>{
  it.each([-60000, 60000])("uses source freshness even when the browser clock differs by %i ms",async offset=>{
    vi.spyOn(Date,"now").mockReturnValue(now*1000+offset);
    await mount();expect(container.querySelector('[data-active-count]')?.textContent).toBe("4");
  });
  it("shows the complete IP and whole-user active count, not the current page count",async()=>{
    await mount();expect(container.textContent).toContain("2001:db8:85a3:8d3:1319:8a2e:370:7348");
    expect(container.querySelector('[data-active-count]')?.textContent).toBe("4");
    expect(container.textContent).toContain("75");
  });
  it("keeps saved addresses but hides live status when the source is unavailable",async()=>{
    const data=history();data.source.state="unavailable";await mount(data);
    expect(container.querySelector('[data-active-count]')?.textContent).toBe("—");
    expect(container.querySelector('[data-ip-state="active"]')).toBeNull();
    expect(container.querySelectorAll('[data-ip-row]').length).toBe(1);
  });
  it("resets pagination when a filter changes",async()=>{
    await mount();seed(history({items:[{...history().items[0],ip:"192.0.2.2",family:4}],next_cursor:""}),{cursor:"page2"});
    seed(history({items:[],matched:0,next_cursor:""}),{family:"6"});
    await act(async()=>container.querySelector<HTMLButtonElement>('[data-next]')!.click());
    expect(container.textContent).toContain("192.0.2.2");
    await act(async()=>{const select=container.querySelector<HTMLSelectElement>('[data-family]')!;select.value="6";select.dispatchEvent(new Event("change",{bubbles:true}))});
    expect(container.querySelectorAll('[data-ip-row]').length).toBe(0);
    expect(container.querySelector<HTMLButtonElement>('[data-previous]')!.disabled).toBe(true);
  });
  it("does not retain another user's addresses after changing identity",async()=>{
    await mount();seed(history({items:[],total:0,matched:0,next_cursor:""}),{},"bob");
    await act(async()=>root!.render(<QueryClientProvider client={client}><PersonIPHistory username="bob" /></QueryClientProvider>));
    expect(container.textContent).not.toContain("2001:db8");
  });
});
