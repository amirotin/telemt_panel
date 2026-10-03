import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemtConfigCatalog, TelemtConfigField } from "../../lib/api/generated/types.gen";
import { resetLocaleForTests } from "../../i18n";
import { FieldControl, GenericFields } from "./ConfigFieldControls";
import { buildConfigPatch } from "./configPatch.helpers";

function numberField(dataType: string, kind: "integer" | "decimal" = "decimal"): TelemtConfigField {
  return {
    path: "general.me_pool_min_fresh_ratio",
    kind,
    group: "me",
    data_type: dataType,
    default_value: "0.8",
    doc_hot: true,
    apply: "runtime reload",
    tier: "normal",
    secret: false,
  };
}

describe("numeric config controls", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetLocaleForTests();
  });

  it.each([
    [Math.fround(0.8), "0.8"],
    [Math.fround(0.1), "0.1"],
    [Math.fround(-0.8), "-0.8"],
    [Math.fround(1 / 3), "0.33333334"],
    [Math.fround(1.23456789), "1.2345679"],
    [Math.fround(1e-8), "1e-8"],
    [Math.fround(1e-40), "1e-40"],
    [Math.fround(1e-45), "1e-45"],
    [Math.fround(3.4028234663852886e38), "3.4028235e+38"],
  ])("displays widened f32 value %s as %s without emitting an edit", (value, expected) => {
    const onChange = vi.fn();
    act(() => root.render(<FieldControl field={numberField("f32")} value={value} label="Value" onChange={onChange} />));
    expect(container.querySelector("input")?.value).toBe(expected);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ["f64", "decimal", 0.123456789012345, "0.123456789012345"],
    ["f64", "decimal", 0.800000011920929, "0.800000011920929"],
    ["f32", "decimal", 0.123456789, "0.123456789"],
    ["f32", "decimal", 0.8, "0.8"],
    ["f32", "decimal", 0, "0"],
    ["u64", "integer", 123456789, "123456789"],
    ["f32", "integer", 0.800000011920929, "0.800000011920929"],
  ] as const)("preserves %s %s value %s", (dataType, kind, value, expected) => {
    act(() => root.render(<FieldControl field={numberField(dataType, kind)} value={value} label="Value" onChange={() => {}} />));
    expect(container.querySelector("input")?.value).toBe(expected);
  });

  it("passes an intentional decimal edit to the model as a number", () => {
    const onChange = vi.fn();
    act(() => root.render(<FieldControl field={numberField("f32")} value={0.800000011920929} label="Value" onChange={onChange} />));
    const input = container.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "0.75");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(0.75);
  });

  it("retains the original ratio when another field is edited and saved", () => {
    const ratio = 0.800000011920929;
    const fields = [numberField("f32"), { ...numberField("u64", "integer"), path: "general.middle_proxy_pool_size" }];
    const catalog: TelemtConfigCatalog = {
      version: "3.5.8",
      source_commit: "test",
      documented_fields: fields.length,
      runtime_additions: [],
      groups: [{ id: "me", title: "ME and NAT", short: "ME" }],
      fields,
    };
    const sections = Object.freeze({ general: Object.freeze({ me_pool_min_fresh_ratio: ratio, middle_proxy_pool_size: 2 }) });
    let edited: Record<string, unknown> = sections;
    const onChange = vi.fn((next: Record<string, unknown>) => { edited = next; });
    act(() => root.render(<GenericFields fields={fields} sections={sections} advanced catalog={catalog} onChange={onChange} />));
    expect(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value).toBe("0.8");
    expect(onChange).not.toHaveBeenCalled();
    const poolSize = container.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(poolSize, "3");
      poolSize.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(edited).toEqual({ general: { me_pool_min_fresh_ratio: ratio, middle_proxy_pool_size: 3 } });
    expect(buildConfigPatch(sections, edited)).toEqual({ general: { middle_proxy_pool_size: 3 } });
    expect(sections.general.me_pool_min_fresh_ratio).toBe(ratio);
  });
});
