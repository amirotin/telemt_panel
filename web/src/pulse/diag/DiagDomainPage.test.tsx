import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagDomainPage } from "./DiagDomainPage";

vi.mock("./ConnectionsPage", () => ({ ConnectionsPage: () => <div data-testid="page-connections">connections</div> }));
vi.mock("./CountersPage", () => ({ CountersPage: () => <div data-testid="page-counters">counters</div> }));
vi.mock("./DcPage", () => ({ DcPage: () => <div data-testid="page-dc">dc</div> }));
vi.mock("./EventsPage", () => ({ EventsPage: () => <div data-testid="page-events">events</div> }));
vi.mock("./MePage", () => ({ MePage: () => <div data-testid="page-me">me</div> }));
vi.mock("./NatPage", () => ({ NatPage: () => <div data-testid="page-nat">nat</div> }));
vi.mock("./SecurityPage", () => ({ SecurityPage: () => <div data-testid="page-security">security</div> }));
vi.mock("./UpstreamsPage", () => ({ UpstreamsPage: () => <div data-testid="page-upstreams">upstreams</div> }));
vi.mock("./WebPage", () => ({ WebPage: () => <div data-testid="page-web">web</div> }));

describe("DiagDomainPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("selects each of the nine domain modules", async () => {
    for (const domain of ["connections", "counters", "dc", "events", "me", "nat", "security", "upstreams", "web"]) {
      await act(async () => root.render(<DiagDomainPage domain={domain} />));
      expect(container.querySelector(`[data-testid="page-${domain}"]`)).not.toBeNull();
    }
  });

  it.each(["missing", "constructor", "toString", "__proto__"])(
    "renders the not-found state for invalid domain %s",
    async (domain) => {
      await act(async () => root.render(<DiagDomainPage domain={domain} />));
      expect(container.textContent).toContain("Раздел диагностики не найден");
    },
  );
});
