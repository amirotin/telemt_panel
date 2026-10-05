import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemtConfigField } from "../../lib/api/generated/types.gen";
import { getStrings } from "../../i18n";
import { WebEditor } from "./WebEditor";
import { StructuredSettingsForm } from "./StructuredSettingsForm";

vi.mock("../useIsDesktop", () => ({ useIsDesktop: () => true }));

const field = (path: string, options?: string[]): TelemtConfigField => ({
  path, options, kind: options ? "enum" : "structure", group: "web", tier: "normal",
  data_type: "String", default_value: "never", doc_hot: true, apply: "runtime reload", secret: false,
});
const fields = [field("web.vhosts"), field("web.vhosts[].decoy.resolve", ["never", "startup"]), field("web.vhosts[].decoy.upstream")];

describe("WEB decoy DNS policy", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  function Harness({ supported = true }: { supported?: boolean }) {
    const [sections, setSections] = useState<Record<string, unknown>>({ web: { vhosts: [{
      host: "proxy.example.com", public_addr: "203.0.113.10:443", profiles: [],
      decoy: { mode: "http_upstream", upstream: "http://backend.internal:8080", resolve: "startup" },
    }] } });
    return <><WebEditor fields={supported ? fields : [fields[0]]} sections={sections} advanced onChange={setSections} /><output>{JSON.stringify(sections)}</output></>;
  }

  it("offers never/startup only when the server catalog supports DNS", () => {
    act(() => root.render(<Harness />));
    const policy = [...container.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.value === "startup"));
    expect(policy).toBeTruthy();
    expect(policy?.value).toBe("startup");
    act(() => root.render(<Harness supported={false} />));
    expect([...container.querySelectorAll("select")].some((select) => [...select.options].some((option) => option.value === "startup"))).toBe(false);
  });

  it("restores the HTTP draft after visiting static mode without leaking resolve into static configuration", () => {
    act(() => root.render(<Harness />));
    const label = getStrings().server.config.catalog.labels["web.vhosts.decoy.mode"];
    const changeMode = (mode: string) => act(() => {
      const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      select.value = mode; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    changeMode("static_directory");
    const snapshot = () => JSON.parse(container.querySelector("output")!.textContent!).web.vhosts[0].decoy;
    expect(snapshot()).not.toHaveProperty("resolve");
    changeMode("http_upstream");
    expect(snapshot()).toEqual({ mode: "http_upstream", upstream: "http://backend.internal:8080", resolve: "startup" });
  });

  it("keeps inactive decoy drafts when navigating to another configuration group", () => {
    function Groups() {
      const [sections, setSections] = useState<Record<string, unknown>>({ web: { vhosts: [{ host: "proxy.example.com", public_addr: "203.0.113.10:443", profiles: [], decoy: { mode: "http_upstream", upstream: "http://backend.internal:8080", resolve: "startup" } }] } });
      return <><StructuredSettingsForm catalog={{ version: "3.5.14", source_commit: "test", documented_fields: fields.length, runtime_additions: [], fields, groups: [{ id: "web", title: "WEB", short: "WEB" }, { id: "diagnostics", title: "Other", short: "Other" }] }} sections={sections} mode="advanced" onChange={setSections} /><output>{JSON.stringify(sections)}</output></>;
    }
    act(() => root.render(<Groups />));
    const label = getStrings().server.config.catalog.labels["web.vhosts.decoy.mode"];
    const changeMode = (mode: string) => act(() => { const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; select.value = mode; select.dispatchEvent(new Event("change", { bubbles: true })); });
    changeMode("static_directory");
    act(() => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Other"))!.click());
    act(() => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("WEB"))!.click());
    changeMode("http_upstream");
    expect(JSON.parse(container.querySelector("output")!.textContent!).web.vhosts[0].decoy.resolve).toBe("startup");
  });

  it("keeps mode drafts through collapse, duplication and removal of an earlier record", () => {
    act(() => root.render(<Harness />));
    const copy = getStrings().server.config.catalog;
    const changeMode = (mode: string) => act(() => { const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${copy.labels["web.vhosts.decoy.mode"]}"]`)!; select.value = mode; select.dispatchEvent(new Event("change", { bubbles: true })); });
    changeMode("static_directory");
    act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${copy.collapseRecord}"]`)!.click());
    act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${copy.expandRecord}"]`)!.click());
    act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${copy.duplicateRecord}"]`)!.click());
    changeMode("http_upstream");
    let vhosts = JSON.parse(container.querySelector("output")!.textContent!).web.vhosts;
    expect(vhosts[1].decoy.resolve).toBe("startup");
    act(() => container.querySelector("article")!.querySelector<HTMLButtonElement>(`button[aria-label="${copy.deleteRecord}"]`)!.click());
    changeMode("static_directory");
    changeMode("http_upstream");
    vhosts = JSON.parse(container.querySelector("output")!.textContent!).web.vhosts;
    expect(vhosts).toHaveLength(1);
    expect(vhosts[0].decoy).toEqual({ mode: "http_upstream", upstream: "http://backend.internal:8080", resolve: "startup" });
  });

  it("clears inactive mode drafts after an explicit document reseed", () => {
    let version = 0;
    let sections: Record<string, unknown> = { web: { vhosts: [{ host: "proxy.example.com", public_addr: "203.0.113.10:443", profiles: [], decoy: { mode: "http_upstream", upstream: "http://backend.internal:8080", resolve: "startup" } }] } };
    const render = () => root.render(<StructuredSettingsForm documentVersion={version} catalog={{ version: "3.5.14", source_commit: "test", documented_fields: fields.length, runtime_additions: [], fields, groups: [{ id: "web", title: "WEB", short: "WEB" }] }} sections={sections} mode="advanced" onChange={(next) => { sections = next; render(); }} />);
    act(render);
    const label = getStrings().server.config.catalog.labels["web.vhosts.decoy.mode"];
    const changeMode = (mode: string) => act(() => { const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; select.value = mode; select.dispatchEvent(new Event("change", { bubbles: true })); });
    changeMode("static_directory");
    version++;
    sections = { web: { vhosts: [{ host: "proxy.example.com", public_addr: "203.0.113.10:443", profiles: [], decoy: { mode: "static_directory", directory: "/fresh", index: "index.html" } }] } };
    act(render);
    changeMode("http_upstream");
    const decoy = (sections["web"] as { vhosts: Array<{ decoy: Record<string, unknown> }> }).vhosts[0].decoy;
    expect(decoy["resolve"]).not.toBe("startup");
    expect(decoy["upstream"]).not.toBe("http://backend.internal:8080");
  });
});
