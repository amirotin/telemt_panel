import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dict } from "./dict";
import { ru } from "./ru";
import { en } from "./en";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./loadDictionary", () => ({ loadDictionary: load }));

function deferred() {
  let resolve!: (value: Dict) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Dict>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  load.mockReset();
  localStorage.setItem("telemt-panel:locale:v1", "ru");
  document.documentElement.lang = "ru";
});

describe("asynchronous locale changes", () => {
  it("initializes only the selected dictionary", async () => {
    const next = deferred();
    load.mockReturnValue(next.promise);
    const store = await import("./store");
    const initialized = store.initializeLocale();
    expect(store.isLocaleReady()).toBe(false);
    expect(store.getLocaleLoadState().pending).toBe("ru");
    next.resolve(ru);
    expect(await initialized).toBe(true);
    expect(store.getStrings().nav.people).toBe("Люди");
    expect(store.isLocaleReady()).toBe(true);
    expect(load.mock.calls).toEqual([["ru"]]);
  });

  it("keeps dictionary, preference and document language unchanged until ready", async () => {
    load.mockResolvedValueOnce(ru);
    const store = await import("./store");
    await store.initializeLocale();
    const next = deferred();
    load.mockReturnValue(next.promise);
    const change = store.setLocalePreference("en");
    expect(store.getStrings()).toBe(ru);
    expect(store.getLocalePreference()).toBe("ru");
    expect(document.documentElement.lang).toBe("ru");
    expect(localStorage.getItem("telemt-panel:locale:v1")).toBe("ru");
    next.resolve(en);
    expect(await change).toBe(true);
    expect(store.getStrings()).toBe(en);
    expect(store.getLocalePreference()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("telemt-panel:locale:v1")).toBe("en");
  });

  it("keeps the working locale after failure and permits retry", async () => {
    load.mockResolvedValueOnce(ru).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(en);
    const store = await import("./store");
    await store.initializeLocale();
    expect(await store.setLocalePreference("en")).toBe(false);
    expect(store.getStrings()).toBe(ru);
    expect(store.getLocaleLoadState()).toEqual({ pending: null, error: "en" });
    expect(localStorage.getItem("telemt-panel:locale:v1")).toBe("ru");
    expect(await store.setLocalePreference("en")).toBe(true);
    expect(store.getStrings()).toBe(en);
    expect(store.getLocaleLoadState()).toEqual({ pending: null, error: null });
  });

  it("ignores a stale success after the user selects the current locale again", async () => {
    load.mockResolvedValueOnce(ru);
    const store = await import("./store");
    await store.initializeLocale();
    const next = deferred();
    load.mockReturnValue(next.promise);
    const stale = store.setLocalePreference("en");
    expect(await store.setLocalePreference("ru")).toBe(true);
    next.resolve(en);
    expect(await stale).toBe(false);
    expect(store.getStrings()).toBe(ru);
    expect(store.getLocaleLoadState()).toEqual({ pending: null, error: null });
    expect(document.documentElement.lang).toBe("ru");
  });

  it("ignores an error from a superseded selection", async () => {
    load.mockResolvedValueOnce(ru);
    const store = await import("./store");
    await store.initializeLocale();
    const next = deferred();
    load.mockReturnValue(next.promise);
    const stale = store.setLocalePreference("en");
    await store.setLocalePreference("ru");
    next.reject(new Error("offline"));
    expect(await stale).toBe(false);
    expect(store.getLocaleLoadState()).toEqual({ pending: null, error: null });
  });

  it("shares in-flight loading and keeps the last explicit preference", async () => {
    load.mockResolvedValueOnce(ru);
    const store = await import("./store");
    await store.initializeLocale();
    const next = deferred();
    load.mockReturnValue(next.promise);
    const first = store.setLocalePreference("en");
    const last = store.setLocalePreference("auto");
    next.resolve(en);
    expect(await first).toBe(false);
    expect(await last).toBe(true);
    expect(store.getLocalePreference()).toBe("auto");
    expect(store.getStrings()).toBe(en);
    expect(load.mock.calls).toEqual([["ru"], ["en"]]);
    await store.setLocalePreference("ru");
    await store.setLocalePreference("en");
    expect(load.mock.calls).toEqual([["ru"], ["en"]]);
  });

  it("can retry initial loading without an available dictionary", async () => {
    load.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(ru);
    const store = await import("./store");
    expect(await store.initializeLocale()).toBe(false);
    expect(store.isLocaleReady()).toBe(false);
    expect(store.getLocaleLoadState().error).toBe("ru");
    expect(await store.initializeLocale()).toBe(true);
    expect(store.getStrings()).toBe(ru);
  });

  it("switches successfully even when preference storage is unavailable", async () => {
    load.mockResolvedValueOnce(ru).mockResolvedValueOnce(en);
    const store = await import("./store");
    await store.initializeLocale();
    const brokenStorage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    try {
      expect(await store.setLocalePreference("en")).toBe(true);
      expect(store.getStrings()).toBe(en);
      expect(document.documentElement.lang).toBe("en");
    } finally {
      brokenStorage.mockRestore();
    }
  });
});
