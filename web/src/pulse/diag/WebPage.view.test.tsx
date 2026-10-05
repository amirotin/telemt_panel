import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en, ru } from "../../i18n/testing";
import {
  webSessionsAll,
  webStatusRunning,
  webTopicUnsupported,
} from "../__fixtures__/web";
import { webPagePayload } from "./web.helpers";
import { GateView, Overview, SessionsView, SessionDetails } from "./WebPage";

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
    expect(host.querySelector('[data-testid="web-flow"]')?.textContent).toContain("Потоков");
    expect(host.querySelectorAll('[data-testid="web-planes"] > div > div')).toHaveLength(3);
  });

  it.each([[ru, "HTTP-соединения", "Потоки"], [en, "HTTP connections", "Streams"]])("localizes ordinary capacity labels while preserving WEB readings", (s, http, streams) => {
    const payload = webPagePayload(webStatusRunning, [webSessionsAll])!;
    act(() => root.render(<Overview payload={payload} s={s} />));
    expect(host.querySelector('[data-web-capacity="http"]')?.textContent).toContain(http);
    expect(host.querySelector('[data-web-capacity="streams"]')?.textContent).toContain(streams);
    expect(host.querySelector('[data-web-capacity="sessions"]')?.textContent).toContain("128");
  });

  it("explains lifetime limit events without marking current capacity as overloaded",()=>{
    const payload=webPagePayload({...webStatusRunning,runtime:{...webStatusRunning.runtime!,limit_hits:7}},null)!;
    act(()=>root.render(<Overview payload={payload} s={ru}/>));
    expect(host.querySelector('[data-testid="web-limit-explanation"]')).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    const help=host.querySelector<HTMLButtonElement>('[data-web-vital="Срабатывания лимитов"] button');
    expect(help).not.toBeNull();
    act(()=>help!.click());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("с запуска");
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("не означает");
    act(()=>document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(host.querySelector('[data-web-vital="Срабатывания лимитов"] .text-warn')).toBeNull();
    expect(host.textContent).not.toContain(ru.details.pages.web.view.pressureTitle);
  });

  it("highlights a currently saturated extra resource rather than a historical rejection",()=>{
    const payload=webPagePayload({...webStatusRunning,capacity:{http_connection_capacity_action:"drop",max_http_overload_connections:64,http_overload_timeout_ms:250,resources:[{resource:"body_readers",unit:"slots",used:4,available:0,limit:4,closed:false}],saturated_resources:["body_readers"],partial:[],rejections:[],http_connection_overload_outcomes:[]}},null)!;
    act(()=>root.render(<Overview payload={payload} s={ru}/>));
    expect(host.querySelector('[data-testid="web-current-pressure"]')?.textContent).toContain("Чтение тел запросов");
    expect(host.querySelector('[data-web-capacity="body_readers"]')?.textContent).toContain("4 / 4");
    expect(host.querySelector('[data-web-capacity="body_readers"]')?.closest("details")?.open).toBe(true);
  });

  it("keeps secondary resource ceilings available without expanding a healthy overview",()=>{
    const payload=webPagePayload({...webStatusRunning,capacity:{http_connection_capacity_action:"drop",max_http_overload_connections:64,http_overload_timeout_ms:250,resources:[{resource:"body_readers",unit:"slots",used:1,available:3,limit:4,closed:false}],saturated_resources:[],partial:[],rejections:[],http_connection_overload_outcomes:[]}},null)!;
    act(()=>root.render(<Overview payload={payload} s={ru}/>));
    expect(host.querySelector('[data-web-capacity="body_readers"]')?.closest("details")?.open).toBe(false);
  });

  it("prefers effective operator admission over the manager's stale issuance flag",()=>{
    const payload=webPagePayload({...webStatusRunning,operator_lifecycle:{state:"paused",epoch:1,age_ms:100,admission_open:false,effective_new_work_admission:false}},null)!;
    act(()=>root.render(<Overview payload={payload} s={ru}/>));
    expect(host.querySelector('[data-web-vital="Выдача сессий"]')?.textContent).toContain("Остановлена");
  });

  it("reports an independently partial capacity snapshot instead of silently hiding budget gauges",()=>{
    const payload=webPagePayload({...webStatusRunning,capacity:{http_connection_capacity_action:"drop",max_http_overload_connections:64,http_overload_timeout_ms:250,resources:[{resource:"body_readers",unit:"slots",used:1,available:3,limit:4,closed:false}],saturated_resources:[],partial:["budget"],rejections:[],http_connection_overload_outcomes:[]}},null)!;
    act(()=>root.render(<Overview payload={payload} s={ru}/>));
    expect(host.textContent).toContain("Снимок получен частично");
    expect(host.textContent).toContain("budget");
    expect(host.querySelector('[data-web-capacity="queue"]')).toBeNull();
    expect(host.querySelector('[data-testid="web-current-pressure"]')).toBeNull();
  });

  it("shows private ingress and actual 3.5.8 rejection causes without claiming external TLS readiness",()=>{
    const payload=webPagePayload({...webStatusRunning,
      ingress:{configured_listeners:1,live_acceptors:0,accepting_connections:false,reason:"acceptor_unavailable",tcp_accept_total:10,tcp_accept_error_total:1},
      capacity:{http_connection_capacity_action:"wait",max_http_overload_connections:64,http_overload_timeout_ms:250,resources:[],saturated_resources:[],partial:[],rejections:[{reason:"session_capacity",total:7},{reason:"operator_paused",total:2}],http_connection_overload_outcomes:[]},
      operator_lifecycle:{state:"paused",epoch:1,age_ms:100,admission_open:false,effective_new_work_admission:false},
    },null)!;
    act(()=>root.render(<Overview payload={payload} s={ru}/>));
    const ingress=host.querySelector('[data-testid="web-ingress"]');
    expect(ingress?.textContent).toContain("0 / 1");
    expect(ingress?.closest('[data-testid="web-runtime"]')).not.toBeNull();
    const help=ingress?.querySelector<HTMLButtonElement>('button');
    expect(help).not.toBeNull();
    act(()=>help!.click());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("не проверяет");
    expect(host.querySelector('[data-web-rejection="session_capacity"]')?.textContent).toContain("7");
    expect(host.querySelector('[data-web-rejection="operator_paused"]')?.textContent).toContain("2");
    expect(host.querySelector('[data-web-rejection="session_capacity"]')?.closest('[data-testid="web-capacity"]')).not.toBeNull();
    expect(host.querySelector('[data-web-rejection="operator_paused"]')?.closest('[data-testid="web-capacity"]')).not.toBeNull();
  });

  it("does not fabricate detailed counters when the older server omits them",()=>{
    const payload=webPagePayload(webStatusRunning,null)!;
    act(()=>root.render(<Overview payload={payload} s={ru}/>));
    expect(host.querySelector('[data-testid="web-rejections"]')).toBeNull();
  });

  it("shows an explicit empty history when detailed rejection counters are available",()=>{
    const payload=webPagePayload({...webStatusRunning,capacity:{http_connection_capacity_action:"drop",max_http_overload_connections:64,http_overload_timeout_ms:250,resources:[],saturated_resources:[],partial:[],rejections:[{reason:"session_capacity",total:0}],http_connection_overload_outcomes:[]}},null)!;
    act(()=>root.render(<Overview payload={payload} s={ru}/>));
    expect(host.querySelector('[data-testid="web-rejections"]')?.textContent).toContain("Отказов не зафиксировано");
    expect(host.querySelectorAll('[data-web-rejection]')).toHaveLength(0);
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
      (button) => button.textContent === "Подготовка",
    );
    expect(provisional).toBeDefined();
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

  it("keeps peer timing distinct from DATA progress and preserves measured zero",()=>{
    const row={...webSessionsAll.sessions[0]!,health_publication:"published",peer_idle_ms:0,reconnect_grace_ms:30000,peer_deadline_remaining_ms:12000};
    act(()=>root.render(<SessionDetails row={row} s={ru} canClose={false} closePending={false} onClose={()=>{}}/>));
    const labels=[...host.querySelectorAll("dt")].map(label=>label.textContent);
    expect(labels).toContain("peer_idle_ms");
    expect(labels).toContain("reconnect_grace_ms");
    expect(labels).toContain("peer_deadline_remaining_ms");
    const peer=[...host.querySelectorAll("dt")].find(label=>label.textContent==="peer_idle_ms");
    expect(peer?.nextElementSibling?.textContent).toContain("0");
    expect(host.textContent).toContain("Опубликовано");
  });

  it("does not show unreported peer observations on older WEB session rows",()=>{
    act(()=>root.render(<SessionDetails row={webSessionsAll.sessions[0]!} s={ru} canClose={false} closePending={false} onClose={()=>{}}/>));
    const labels=[...host.querySelectorAll("dt")].map(label=>label.textContent);
    expect(labels).not.toContain("peer_idle_ms");
    expect(labels).not.toContain("health_publication");
  });
});
