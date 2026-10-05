import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { en, ru } from "../../i18n/testing";
import { gates, initialization, mePoolState, meQuality, meSelftest } from "../__fixtures__/runtime";
import { InitializationPanel } from "./MeInitializationSection";
import { RuntimePanel } from "./MeRuntimeSection";

it.each([[ru, "60 мин", "1 д"], [en, "60 min", "1 d"]])("preserves initialization duration/age scales with localized units", (s, duration, age) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const data = { ...initialization, ready_at_epoch_secs: initialization.started_at_epoch_secs + 3600 };
    act(() => root.render(<InitializationPanel initialization={data} nowMs={(data.started_at_epoch_secs + 86400) * 1000} s={s} />));
    const facts = [...host.querySelectorAll("[data-init-fact]")];
    const reading = (label: string) => facts.find(fact => fact.querySelector("dt")?.textContent === label)?.querySelector("dd")?.textContent;
    expect(reading(s.details.pages.me.view.completed)).toBe(duration);
    expect(reading(s.details.pages.me.view.started)).toBe(age);
    expect(host.querySelectorAll("[data-init-group]")).toHaveLength(6);
    expect(host.querySelectorAll("h2")).toHaveLength(2);
  } finally {
    act(() => root.unmount());
    host.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
});

it("preserves open runtime settings, focus, zero and false through new snapshot data", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const props = { gates, pool: mePoolState, quality: meQuality, selftest: meSelftest, s: ru };
    act(() => root.render(<RuntimePanel {...props} runtimeSettings={{ enabled: false, burst: 0 }} />));
    const details = host.querySelector<HTMLDetailsElement>('[data-testid="me-runtime-settings"]')!;
    const summary = details.querySelector("summary")!;
    summary.focus();
    act(() => summary.click());
    expect(details.open).toBe(true);
    expect([...details.querySelectorAll("dd")].map(row => row.textContent)).toEqual(["0", "false"]);
    act(() => root.render(<RuntimePanel {...props} runtimeSettings={{ enabled: true, burst: 0 }} />));
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(summary);
    expect([...details.querySelectorAll("dd")].map(row => row.textContent)).toEqual(["0", "true"]);
    expect(host.querySelectorAll("h2")).toHaveLength(3);
  } finally {
    act(() => root.unmount());
    host.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
});
