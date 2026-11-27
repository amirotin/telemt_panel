import { act, useContext, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { QuotaScheduleEditor } from "./QuotaSchedule";
import { PeopleContext } from "./PeopleContext";
import type { QuotaScheduleView } from "../lib/api/generated/types.gen";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../lib/api/generated/sdk.gen", async (load) => ({
  ...(await load<typeof import("../lib/api/generated/sdk.gen")>()),
  getQuotaSchedule: async () => {
    throw new Error("offline");
  },
  previewQuotaSchedule: async () => ({ data: { next_runs: [], effective_timezone: "UTC" } }),
}));

function Editable({ children }: { children: ReactNode }) {
  const access = useContext(PeopleContext);
  return (
    <PeopleContext.Provider value={{ ...access, readOnly: false }}>
      {children}
    </PeopleContext.Provider>
  );
}

it("keeps a dirty schedule and its navigation blocker after a background read fails", async () => {
  const initial: QuotaScheduleView = {
    revision: "v1",
    global: {
      enabled: true,
      timezone: "UTC",
      rule: { kind: "interval", days: 1, start: "2026-01-01", time: "00:00" },
    },
    effective: true,
    durable: true,
    effective_timezone: "UTC",
    server_timezone: "UTC",
    next_runs: [],
    custom_count: 0,
    excluded_count: 0,
  };
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const key = ["quota-schedule", ""];
  client.setQueryData(key, initial);
  const el = document.createElement("div"),
    root = createRoot(el),
    dirty = vi.fn();
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Editable>
            <QuotaScheduleEditor onCancel={() => {}} onDirty={dirty} />
          </Editable>
        </QueryClientProvider>,
      ),
    );
    act(() => el.querySelector<HTMLButtonElement>(".qs-presets button:nth-child(2)")!.click());
    expect(dirty).toHaveBeenLastCalledWith(true);
    await act(async () => {
      await client.refetchQueries({ queryKey: key });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(el.querySelector<HTMLInputElement>("input[type=number]")?.value).toBe("7");
    expect(dirty).toHaveBeenLastCalledWith(true);
    await act(async () => {
      client.setQueryData(key, {
        ...initial,
        revision: "v2",
        global: { ...initial.global, rule: { ...initial.global.rule, days: 30 } },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(el.querySelector<HTMLInputElement>("input[type=number]")?.value).toBe("7");
    act(() => el.querySelector<HTMLButtonElement>(".qs-presets button")!.click());
    expect(el.querySelector<HTMLInputElement>("input[type=number]")?.value).toBe("30");
  } finally {
    act(() => root.unmount());
    client.clear();
  }
});
