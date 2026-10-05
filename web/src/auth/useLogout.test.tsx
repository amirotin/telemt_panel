import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { useLogout } from "./useLogout";

const mocks = vi.hoisted(() => ({
  logout: vi.fn(), navigate: vi.fn(), reset: vi.fn(), toast: vi.fn(),
}));
vi.mock("../lib/api/generated/@tanstack/react-query.gen", () => ({
  logoutMutation: () => ({ mutationFn: mocks.logout }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: mocks.navigate }) }));
vi.mock("../realtime", () => ({ resetSSEClient: mocks.reset }));
vi.mock("../ui/Toast", () => ({ pushToast: mocks.toast }));

let root: Root | undefined;
let container: HTMLElement | undefined;
let operation: ReturnType<typeof useLogout>;
function Probe() {
  const current = useLogout();
  useEffect(() => { operation = current; }, [current]);
  return null;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(["protected-session-data"], { username: "admin" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  return client;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove(); root = undefined; container = undefined;
  vi.clearAllMocks();
});

it("keeps the session and reports a failed durable logout for retry", async () => {
  mocks.logout.mockRejectedValueOnce({ code: "session_revoke_failed", message: "durable deletion failed" });
  const client = mount();
  await act(async () => { await operation.mutateAsync({}).catch(() => {}); });
  expect(client.getQueryData(["protected-session-data"])).toEqual({ username: "admin" });
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.reset).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(expect.any(String), "error");
});

it("clears session data and navigates after a confirmed logout", async () => {
  mocks.logout.mockResolvedValueOnce(undefined);
  const client = mount();
  await act(async () => { await operation.mutateAsync({}); });
  expect(client.getQueryData(["protected-session-data"])).toBeUndefined();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/login" });
  expect(mocks.reset).toHaveBeenCalledOnce();
});
