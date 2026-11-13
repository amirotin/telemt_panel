import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { setLocalePreference } from "../../i18n";
import { UpdateStepper } from "./UpdateStepper";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  await setLocalePreference("ru");
});

describe("persisted update phases", () => {
  it.each([
    ["ru", "Подготовка пакета", "Проверка целостности", "3 из 6"],
    ["en", "Preparing package", "Verifying", "3 of 6"],
  ] as const)("shows old verifying entries as package preparation in %s", async (locale, label, obsoleteLabel, progress) => {
    await setLocalePreference(locale);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<UpdateStepper phase="verifying" />));

    expect(container.textContent).toContain(label);
    expect(container.textContent).not.toContain(obsoleteLabel);
    expect(container.textContent).toContain(progress);
    expect(container.querySelectorAll("li")).toHaveLength(6);
  });
});
