import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { TechnicalSection } from "./TechnicalSection";
import { SourceNotice } from "./SourceNotice";

it("keeps native technical disclosure and keyboard focus across prepared-child updates", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    act(() => root.render(<TechnicalSection title="Technical" description="Source fields"><dl><dt>api_read_only</dt><dd>false</dd></dl></TechnicalSection>));
    const details = host.querySelector("details")!;
    const summary = host.querySelector("summary")!;
    expect(details.open).toBe(false);
    summary.focus();
    act(() => summary.click());
    expect(details.open).toBe(true);
    act(() => root.render(<TechnicalSection title="Technical" description="Source fields"><dl><dt>api_read_only</dt><dd>true</dd></dl></TechnicalSection>));
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(summary);
    expect(host.querySelector("dd")?.textContent).toBe("true");
  } finally {
    act(() => root.unmount());
    host.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
});

it("renders prepared source copy and lets the caller own retry state and focus", () => {
  function Caller() {
    const [retries, setRetries] = useState(0);
    return <SourceNotice title="Source error" description="Retry without leaving this page" level={2}>
      <button type="button" onClick={() => setRetries(value => value + 1)}>Retry · {retries}</button>
    </SourceNotice>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    act(() => root.render(<Caller />));
    expect(host.querySelector("h2")?.textContent).toBe("Source error");
    expect(host.querySelector("p")?.textContent).toBe("Retry without leaving this page");
    const retry = host.querySelector("button")!;
    retry.focus();
    act(() => retry.click());
    expect(retry.textContent).toBe("Retry · 1");
    expect(document.activeElement).toBe(retry);
  } finally {
    act(() => root.unmount());
    host.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  }
});
