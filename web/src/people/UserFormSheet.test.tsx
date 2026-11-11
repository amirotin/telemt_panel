import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SSEProvider } from "../realtime";
import { client } from "../lib/api/client";
import { getTelemtInfoQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import type { UsersTopicUser } from "../realtime/topics";
import { ru } from "../i18n/testing";
import { UserFormSheet, type UserFormSheetProps } from "./UserFormSheet";
import { ToastViewport } from "../ui/Toast";

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let requests: Request[];
const originalConfig = client.getConfig();
const user: UsersTopicUser = {
  username: "alice", enabled: true, in_runtime: true, current_connections: 0,
  active_unique_ips: 0, active_unique_ips_list: [], recent_unique_ips: 0,
  recent_unique_ips_list: [], total_octets: 0,
  links: { classic: [], secure: [], tls: [], tls_domains: [] },
};

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  requests = [];
  client.setConfig({ baseUrl: "http://panel.test", fetch: (input) => {
    requests.push(input as Request);
    return new Promise(() => {});
  } });
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  client.setConfig(originalConfig);
});

async function render(version: string | undefined, overrides: Partial<UsersTopicUser> = {}, mode: "create" | "edit" = "edit", props: Partial<UserFormSheetProps> = {}) {
  queryClient.setQueryData(getTelemtInfoQueryKey(), { reachable: true, version, capabilities: { user_source_deny:version === "3.5.17", quota: true, runtime_edge: true, reload_api: true, config_api: true, user_enable_disable: true, rotate_secret: true } });
  await act(async () => root.render(<QueryClientProvider client={queryClient}><SSEProvider><UserFormSheet inline open mode={mode} user={{ ...user, ...overrides }} onClose={() => {}} {...props} /></SSEProvider></QueryClientProvider>));
}

function rateInput(direction: "up" | "down"): HTMLInputElement {
  const label = direction === "up" ? ru.people.form.rateUpShort : ru.people.form.rateDownShort;
  return [...container.querySelectorAll("label")].find((item) => item.textContent?.includes(label))!.querySelector("input")!;
}

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => container.querySelector("form")!.requestSubmit());
}

function formInput(label: string): HTMLInputElement {
  return [...container.querySelectorAll("label")].find((item) => item.querySelector("span")?.textContent === label)!.querySelector("input")!;
}

function delayedPatch() {
  const completions: Array<(response: Response) => void> = [];
  client.setConfig({ baseUrl: "http://panel.test", fetch: (input) => {
    requests.push(input as Request);
    return new Promise<Response>((resolve) => { completions.push(resolve); });
  } });
  return async (data: Partial<UsersTopicUser>, status = 200, index = 0) => {
    await act(async () => {
      completions[index]!(Response.json(status === 200 ? { ...user, ...data } : { error: "telemt_unavailable" }, { status }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  };
}

describe("user edit save acknowledgement", () => {
  it("keeps later edits dirty and bases the next PATCH on canonical confirmed fields", async () => {
    const finish = delayedPatch();
    const onClose = vi.fn(), onDirtyChange = vi.fn();
    await render("3.5.8", { max_tcp_conns: 4, max_unique_ips: 2, data_quota_bytes: 1500000 }, "edit", { onClose, onDirtyChange });
    await enter(formInput(ru.people.form.maxConnections), "41");
    await submit();
    await enter(formInput(ru.people.form.maxConnections), "42");
    await finish({ max_tcp_conns: 41, max_unique_ips: 7, data_quota_bytes: 2500001 });
    expect(onClose).not.toHaveBeenCalled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(formInput(ru.people.form.maxConnections).value).toBe("42");
    expect(formInput(ru.people.form.maxIps).value).toBe("7");
    await submit();
    expect(requests).toHaveLength(2);
    expect(await requests[1]!.json()).toEqual({ max_tcp_conns: 42 });
  });

  it("closes a confirmed unchanged draft only after clearing its dirty flag", async () => {
    const finish = delayedPatch();
    const events: string[] = [];
    await render("3.5.8", {}, "edit", { onClose: () => events.push("close"), onDirtyChange: (dirty) => events.push(`dirty:${dirty}`) });
    await enter(formInput(ru.people.form.maxConnections), "41");
    await submit();
    await finish({ max_tcp_conns: 41 });
    expect(events).toContain("close");
    expect(events[events.indexOf("close") - 1]).toBe("dirty:false");
  });

  it("preserves a late clear, quota unit, expiration and fractional rate for the next PATCH", async () => {
    const finish = delayedPatch();
    const onClose = vi.fn();
    await render("3.5.8", { data_quota_bytes: 2147483648, max_tcp_conns: 4 }, "edit", { onClose });
    await enter(formInput(ru.people.form.maxConnections), "41");
    await submit();
    await enter(formInput(ru.people.form.maxConnections), "");
    await act(async () => { const select = container.querySelector("select")!; select.value = "MB"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await enter(formInput(ru.people.form.expirationShort), "2026-12-31");
    await enter(rateInput("up"), "1.5");
    await finish({ max_tcp_conns: 41, data_quota_bytes: 3221225472 });
    expect(onClose).not.toHaveBeenCalled();
    expect(formInput(ru.people.form.quota).value).toBe("2");
    expect(container.querySelector("select")!.value).toBe("MB");
    await submit();
    expect(await requests[1]!.json()).toEqual({ max_tcp_conns: null, data_quota_bytes: 2097152, expiration_rfc3339: "2026-12-31T23:59:59.000Z", rate_limit_up_bps: 1500000 });
  });

  it("preserves later edits after a failed PATCH", async () => {
    const finish = delayedPatch();
    const onClose = vi.fn(), onDirtyChange = vi.fn();
    await render("3.5.8", {}, "edit", { onClose, onDirtyChange });
    await enter(formInput(ru.people.form.maxConnections), "41");
    await submit();
    await enter(formInput(ru.people.form.maxConnections), "42");
    await finish({}, 502);
    expect(onClose).not.toHaveBeenCalled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(formInput(ru.people.form.maxConnections).value).toBe("42");
    await submit();
    expect(await requests[1]!.json()).toEqual({ max_tcp_conns: 42 });
  });

  it.each(["different user", "reopened same user"])("ignores a success from a previous session after %s", async (session) => {
    const finish = delayedPatch();
    const onClose = vi.fn(), onSaved = vi.fn(), onDirtyChange = vi.fn();
    const props = { onClose, onSaved, onDirtyChange };
    await render("3.5.8", {}, "edit", props);
    await enter(formInput(ru.people.form.maxConnections), "41");
    await submit();
    if (session === "reopened same user") await render("3.5.8", {}, "edit", { ...props, open: false });
    await render("3.5.8", { username: session === "different user" ? "bob" : "alice" }, "edit", props);
    await enter(formInput(ru.people.form.maxConnections), "52");
    await finish({ max_tcp_conns: 41 });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(formInput(ru.people.form.maxConnections).value).toBe("52");
    await submit();
    expect(await requests[1]!.json()).toEqual({ max_tcp_conns: 52 });
  });
});

describe("Telemt user rate bounds", () => {
  it("blocks an out-of-range rate when creating a user", async () => {
    await render("3.5.8", {}, "create");
    await enter(container.querySelector<HTMLInputElement>('[data-testid="user-form-username"]')!, "bob");
    await enter(rateInput("up"), "100001");
    await submit();
    expect(requests).toHaveLength(0);
  });

  it.each(["up", "down"] as const)("blocks a newly entered %s rate above the 3.5.8 bound", async (direction) => {
    await render("3.5.8");
    const input = rateInput(direction);
    await enter(input, "100000.000001");
    expect(input.validity.rangeOverflow).toBe(true);
    await submit();
    expect(requests).toHaveLength(0);
  });

  it("accepts zero, the maximum, and fractional rates within the bound", async () => {
    await render("3.5.8");
    const input = rateInput("up");
    for (const value of ["0", "100000", "1.5", ""]) {
      await enter(input, value);
      expect(input.checkValidity()).toBe(true);
    }
    await enter(input, "100000");
    await submit();
    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toMatchObject({ rate_limit_up_bps: 100000000000 });
  });

  it.each(["v3.5.8", "3.5.8+build.1", "3.5.9", "3.5.9-rc.1", "3.6.0", "4.0.0"])("recognizes the bounded rate contract on %s", async (version) => {
    await render(version);
    expect(rateInput("up").max).toBe("100000");
    expect(rateInput("down").max).toBe("100000");
  });

  it.each(["3.5.5", "3.5.7", "3.5.8-rc.1", "3.5", "3.5.8garbage", "999999999999999999999.0.0", "unknown", undefined])("preserves earlier/unknown %s rate semantics", async (version) => {
    await render(version);
    const input = rateInput("up");
    await enter(input, "100001");
    expect(input.validity.rangeOverflow).toBe(false);
    await submit();
    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toMatchObject({ rate_limit_up_bps: 100001000000 });
  });

  it("keeps an untouched existing high rate and omits it from an unrelated patch", async () => {
    await render("3.5.8", { rate_limit_up_bps: 200000000000 });
    expect(rateInput("up").value).toBe("200000");
    await enter(rateInput("down"), "5");
    await submit();
    expect(requests).toHaveLength(1);
    expect(await requests[0].json()).toEqual({ rate_limit_down_bps: 5000000 });
    expect(rateInput("up").value).toBe("200000");
  });

  it("applies the bound when an existing high rate is changed", async () => {
    await render("3.5.8", { rate_limit_up_bps: 200000000000 });
    const input = rateInput("up");
    await enter(input, "190000");
    expect(input.validity.rangeOverflow).toBe(true);
    await submit();
    expect(requests).toHaveLength(0);
    expect(input.value).toBe("190000");
  });

  it("blocks negative newly entered rates on the bounded version", async () => {
    await render("3.5.8");
    const input = rateInput("down");
    await enter(input, "-1");
    expect(input.validity.rangeUnderflow).toBe(true);
    await submit();
    expect(requests).toHaveLength(0);
  });
});

it("shows config permission guidance after failed user creation and retains the form", async () => {
  const toastContainer = document.createElement("div");
  document.body.append(toastContainer);
  const toastRoot = createRoot(toastContainer);
  client.setConfig({ baseUrl: "http://panel.test", fetch: (input) => {
    requests.push(input as Request);
    return Promise.resolve(Response.json({
      code: "telemt_config_permission_denied", message: "HTTP 500 · internal_error · #42",
    }, { status: 502 }));
  } });
  try {
    await act(async () => toastRoot.render(<ToastViewport />));
    await render("3.5.14", {}, "create");
    const username = container.querySelector<HTMLInputElement>('[data-testid="user-form-username"]')!;
    await enter(username, "bob");
    await submit();
    await vi.waitFor(() => {
      expect(toastContainer.textContent).toMatch(/владельца файла/);
      expect(toastContainer.textContent).toContain("HTTP 500 · internal_error · #42");
    });
    expect(username.value).toBe("bob");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  } finally {
    act(() => toastRoot.unmount());
    toastContainer.remove();
  }
});

describe("UTC expiry calendar", () => {
  it("normalizes an existing offset instant to its UTC calendar date without rewriting it", async () => {
    await render("3.5.8", { expiration_rfc3339: "2026-12-01T01:30:00+03:00" });
    const input = formInput(ru.people.form.expirationShort);
    expect(input.value).toBe("2026-11-30");
    expect(input.closest("label")?.textContent).toContain("UTC");
    await enter(formInput(ru.people.form.maxConnections), "5");
    await submit();
    expect(await requests[0]!.json()).toEqual({ max_tcp_conns: 5 });
  });
});

describe("source deny form compatibility",()=>{
 it("shows no deny input on legacy",async()=>{await render("3.5.16",{},"create");expect(container.querySelector("textarea")).toBeNull();});
 it("clears orphan denies for new supported accounts",async()=>{
  await render("3.5.17",{},"create");
  expect(container.querySelector("textarea")).not.toBeNull();
  await enter(container.querySelector<HTMLInputElement>('[data-testid="user-form-username"]')!,"newuser");await submit();
  expect(await requests[0]!.json()).toHaveProperty("source_deny",[]);
 });
 it("seeds inherited limits with an empty override and preserves them when editing another field",async()=>{
  const inherited={value:7,configured_override:0,global_value:7,origin:"global_default" as const};
  await render("3.5.17",{max_tcp_conns:7,limits:{desired:{max_tcp_conns:inherited,max_unique_ips:inherited},effective:null,effective_scope:"active_config_snapshot",subsystem_convergence:"unknown"}});
  expect(formInput(ru.people.form.maxConnections).value).toBe("");
  await enter(formInput(ru.people.form.maxIps),"3");await submit();expect(await requests[0]!.json()).toEqual({max_unique_ips:3});
 });
});
it("keeps untouched deny rules omitted while editing another field",async()=>{
 await render("3.5.17",{source_deny:["::/0"]});
 await enter(formInput(ru.people.form.maxConnections),"3");await submit();expect(await requests[0]!.json()).toEqual({max_tcp_conns:3});
});

it("clears source-deny rules explicitly from the user form",async()=>{
 await render("3.5.17",{source_deny:["::/0"]});
 await act(async()=>{const el=container.querySelector("textarea")!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(el,"");el.dispatchEvent(new Event("input",{bubbles:true}));});
 await submit();expect(await requests[0]!.json()).toEqual({source_deny:[]});
});
it("preserves dirty deny edits and blocks other writes if support disappears",async()=>{
 await render("3.5.17",{source_deny:["::/0"]});
 await act(async()=>{const el=container.querySelector("textarea")!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(el,"192.0.2.0/24");el.dispatchEvent(new Event("input",{bubbles:true}));});
 await enter(formInput(ru.people.form.maxConnections),"3");
 await act(async()=>{queryClient.setQueryData(getTelemtInfoQueryKey(),{reachable:true,version:"3.5.16",capabilities:{user_source_deny:false}});await new Promise(resolve=>setTimeout(resolve,30));});
 expect(container.querySelector("textarea")?.value).toBe("192.0.2.0/24");
 expect(container.textContent).toContain(ru.accessPolicy.sourceUnavailable);
 expect(container.querySelector<HTMLButtonElement>('[data-testid="user-form-submit"]')!.disabled).toBe(true);
 await submit();expect(requests).toHaveLength(0);
});
it("labels blank .17 connection limits as inheritance for new users",async()=>{
 await render("3.5.17",{},"create");
 expect(formInput(ru.people.form.maxConnections).placeholder).toBe(ru.accessPolicy.inherited);
 expect(formInput(ru.people.form.maxIps).placeholder).toBe(ru.accessPolicy.inherited);
 expect(container.textContent).toContain(ru.accessPolicy.inheritHint);
});
