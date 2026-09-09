import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SectionHeading } from "./SectionHeading";

it("preserves NAT/events heading semantics, spacing and optional meta", () => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<SectionHeading kicker="NAT" title="Servers" meta="12" />);
  expect(container.querySelector("h3")?.textContent).toBe("Servers");
  expect(container.querySelector("h3")?.className).toBe("mt-1 text-h3 font-semibold text-text");
  expect(container.querySelector("header")?.className).toBe("flex flex-wrap items-end justify-between gap-x-4 gap-y-2");
  expect(container.querySelector("header > span")?.className).toBe("text-micro text-text-muted");
  expect(container.querySelector("header > span")?.textContent).toBe("12");
  container.innerHTML = renderToStaticMarkup(<SectionHeading kicker="Events" title="Timeline" />);
  expect(container.querySelector("header > span")).toBeNull();
  expect(container.querySelector("h3")?.textContent).toBe("Timeline");
});
