import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageToggle } from "./LanguageToggle";
import { getLocalePreference, resetLocaleForTests, setLocalePreference, useStrings } from "./store";
import { applyDocumentLocale } from "./locale";

// The switch is the whole reason the store is a subscribable one rather
// than a module constant: these lock in that flipping it re-renders a
// mounted screen that never touched the toggle, and that the choice
// survives a reload (localStorage) and reaches <html lang>.

let mounted: { container: HTMLElement; root: Root } | null = null;

function renderInto(node: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted = { container, root };
  return container;
}

function chips(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")];
}

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  act(() => setLocalePreference("ru"));
});

// A bystander screen: it reads the dictionary but has nothing to do with
// the language control itself.
function Bystander() {
  const s = useStrings();
  return <p>{s.nav.people}</p>;
}

describe("LanguageToggle", () => {
  it("renders one chip per choice and marks the active one", () => {
    act(() => setLocalePreference("ru"));
    const container = renderInto(<LanguageToggle />);
    const labels = chips(container).map((b) => b.textContent);
    expect(labels).toEqual(["Русский", "English", "Как в браузере"]);
    expect(chips(container).map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
    ]);
  });

  it("switches the language of an unrelated mounted screen", () => {
    act(() => setLocalePreference("ru"));
    const container = renderInto(
      <>
        <LanguageToggle />
        <Bystander />
      </>,
    );
    expect(container.querySelector("p")!.textContent).toBe("Люди");

    act(() => chips(container)[1]!.click());
    expect(container.querySelector("p")!.textContent).toBe("People");
    // Its own labels follow too — no mixed screen, not even for the
    // control that did the switching.
    expect(chips(container).map((b) => b.textContent)).toEqual(["Русский", "English", "Browser"]);
  });

  it("persists the choice per device and updates <html lang>", () => {
    const container = renderInto(<LanguageToggle />);

    act(() => chips(container)[1]!.click());
    expect(localStorage.getItem("telemt-panel:locale:v1")).toBe("en");
    expect(document.documentElement.lang).toBe("en");

    act(() => chips(container)[0]!.click());
    expect(localStorage.getItem("telemt-panel:locale:v1")).toBe("ru");
    expect(document.documentElement.lang).toBe("ru");
  });

  it("stores 'auto' as an explicit choice and re-resolves from the browser", () => {
    const container = renderInto(<LanguageToggle />);

    act(() => chips(container)[2]!.click());
    expect(localStorage.getItem("telemt-panel:locale:v1")).toBe("auto");
    expect(getLocalePreference()).toBe("auto");
    // jsdom's navigator.language is en-US, so "auto" resolves to English.
    expect(document.documentElement.lang).toBe("en");
  });

  it("picks up a preference stored before the store was first read", () => {
    localStorage.setItem("telemt-panel:locale:v1", "en");
    act(() => resetLocaleForTests());
    const container = renderInto(<LanguageToggle />);
    expect(chips(container)[1]!.getAttribute("aria-pressed")).toBe("true");
    applyDocumentLocale("en");
    expect(document.documentElement.lang).toBe("en");
  });
});
