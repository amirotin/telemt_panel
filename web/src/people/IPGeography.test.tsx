import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { setLocalePreference } from "../i18n";
import type { GeoIpResult } from "../lib/api/generated/types.gen";
import { IPGeography } from "./IPGeography";

let root: Root | undefined;
let view: HTMLDivElement;
const record: GeoIpResult = { state: "found", country_code: "NL", country_name: "Netherlands", country_name_ru: "Нидерланды", city: "", city_ru: "", asn: 64500, organization: "Example network" };
async function mount(geo: GeoIpResult | null) {
  view = document.createElement("div"); document.body.append(view); root = createRoot(view);
  await act(async () => root!.render(<IPGeography geo={geo} />));
}
afterEach(() => { if (root) act(() => root!.unmount()); view?.remove(); root = undefined; setLocalePreference("ru"); });
describe("IP geography presentation", () => {
  it("uses English data in the English UI", async () => {
    setLocalePreference("en"); await mount(record);
    expect(view.textContent).toContain("Netherlands");
    expect(view.textContent).not.toContain("Нидерланды");
  });
  it("falls back to the English country name and shows an ASN-only record without fake country", async () => {
    await mount({ ...record, country_name_ru: "" }); expect(view.textContent).toContain("Netherlands");
    await act(async () => root!.render(<IPGeography geo={{ ...record, country_code: "", country_name: "", country_name_ru: "" }} />));
    expect(view.textContent).toBe("AS64500 · Example network");
    expect(view.querySelector(".person-ip-country-code")).toBeNull();
  });
  it.each([null, { ...record, state: "not_found" as const }])("does not display stale fields on missing matches", async geo => {
    await mount(geo); expect(view.textContent).toBe("Нет данных в базе");
  });
});
