import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { getHostQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import { resetLocaleForTests, setLocalePreference } from "../i18n";
import { en, ru } from "../i18n/testing";
import { HistoryNotice } from "./HistoryNotice";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let client: QueryClient | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  client?.clear();
  resetLocaleForTests();
});

async function renderNotice(temporary: boolean, driver = "memory") {
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(getHostQueryKey(), { active_store: driver, history_temporary: temporary });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<QueryClientProvider client={client!}><HistoryNotice /></QueryClientProvider>);
  });
  return container;
}

describe("HistoryNotice", () => {
  it.each(["memory", "sqlite"])("does not warn for intentionally configured %s", async (driver) => {
    const view = await renderNotice(false, driver);
    expect(view.childElementCount).toBe(0);
  });

  it.each(["ru", "en"] as const)("keeps recovery details collapsed and localized in %s", async (locale) => {
    setLocalePreference(locale);
    const s = locale === "ru" ? ru : en;
    const view = await renderNotice(true);
    expect(view.querySelector("summary")?.textContent).toContain(s.shell.historyTemporary);
    expect(view.querySelector("details")?.open).toBe(false);
    expect(view.querySelector("p")?.textContent).toBe(s.shell.historyTemporaryHint);
    expect(view.querySelector("button[aria-label='close']")).toBeNull();
  });

  it("removes the warning when a refreshed host response reports recovery", async () => {
    const view = await renderNotice(true);
    await act(async () => {
      client!.setQueryData(getHostQueryKey(), { active_store: "sqlite", history_temporary: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.childElementCount).toBe(0);
  });
});
