import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { buildMapModel } from "./mapModel";
import { overview } from "./testFixtures";
import { VectorMap } from "./VectorMap";

function pointer(type: string, pointerId: number, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

it("prevents expanded wheel scrolling and preserves inline page scrolling", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const model = buildMapModel(overview(), { country: null, location: null });
  const cameraRef = { current: { zoom: 1, x: 0, y: 0 } };
  try {
    act(() => root.render(<VectorMap model={model} expanded onSelect={() => {}} cameraRef={cameraRef} />));
    const svg = container.querySelector("svg")!;
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    act(() => svg.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    expect(cameraRef.current.zoom).toBeGreaterThan(1);

    act(() => root.render(<VectorMap model={model} expanded={false} onSelect={() => {}} cameraRef={cameraRef} />));
    const inlineZoom = cameraRef.current.zoom;
    const inlineWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    act(() => svg.dispatchEvent(inlineWheel));
    expect(inlineWheel.defaultPrevented).toBe(false);
    expect(cameraRef.current.zoom).toBe(inlineZoom);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("accumulates wheel zoom before React commits a render", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const cameraRef = { current: { zoom: 1, x: 0, y: 0 } };
  try {
    act(() => root.render(<VectorMap model={buildMapModel(overview(), { country: null, location: null })} expanded onSelect={() => {}} cameraRef={cameraRef} />));
    const svg = container.querySelector("svg")!;
    act(() => {
      svg.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 }));
      svg.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 }));
    });
    expect(cameraRef.current.zoom).toBeCloseTo(Math.exp(.2));
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it.each(["pointerup", "pointercancel"])("rebases the remaining finger after pinch %s", (endEvent) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const cameraRef = { current: { zoom: 1, x: 0, y: 0 } };
  const box = vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 480, height: 250, top: 0, left: 0, right: 480, bottom: 250, x: 0, y: 0, toJSON: () => ({}) });
  try {
    act(() => root.render(<VectorMap model={buildMapModel(overview(), { country: null, location: null })} expanded onSelect={() => {}} cameraRef={cameraRef} />));
    const svg = container.querySelector("svg")!;
    let pinched = cameraRef.current;
    act(() => {
      svg.dispatchEvent(pointer("pointerdown", 1, 100, 100));
      svg.dispatchEvent(pointer("pointerdown", 2, 200, 100));
      svg.dispatchEvent(pointer("pointermove", 2, 300, 100));
      pinched = { ...cameraRef.current };
      svg.dispatchEvent(pointer(endEvent, 2, 300, 100));
      svg.dispatchEvent(pointer("pointermove", 1, 101, 100));
    });
    expect(pinched.zoom).toBe(2);
    expect(cameraRef.current.zoom).toBe(pinched.zoom);
    expect(cameraRef.current.x - pinched.x).toBeCloseTo(2);
    expect(cameraRef.current.y).toBe(pinched.y);
  } finally {
    act(() => root.unmount());
    container.remove();
    box.mockRestore();
  }
});

it("selects the actual zero-coordinate point without trusted tooltip HTML", () => {
  const container=document.createElement("div");document.body.append(container);
  const root=createRoot(container);const onSelect=vi.fn();const data=overview();data.points[0].name="<img src=x onerror=alert(1)>";
  try {
    act(()=>root.render(<VectorMap model={buildMapModel(data,{country:null,location:null})} expanded={false} onSelect={onSelect}/>));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    const point=container.querySelector<SVGGElement>("[data-geo-point]")!;
    act(()=>point.dispatchEvent(new MouseEvent("click",{bubbles:true})));
    expect(onSelect).toHaveBeenCalledWith({country:"DE",location:"city:DE:1"});
    expect(container.querySelector("svg")?.style.touchAction).toBe("pan-y pinch-zoom");
  } finally {act(()=>root.unmount());container.remove();}
});

it("restores inline tapping after an expanded drag",()=>{
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container),selected=vi.fn();const model=buildMapModel(overview(),{country:null,location:null});
  try {
    act(()=>root.render(<VectorMap model={model} expanded onSelect={selected}/>));
    const svg=container.querySelector("svg")!;
    act(()=>{svg.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,clientX:10,clientY:10}));svg.dispatchEvent(new MouseEvent("pointermove",{bubbles:true,clientX:40,clientY:40}));svg.dispatchEvent(new MouseEvent("pointerup",{bubbles:true,clientX:40,clientY:40}))});
    act(()=>root.render(<VectorMap model={model} expanded={false} onSelect={selected}/>));
    const point=container.querySelector("[data-geo-point]")!;
    act(()=>{point.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true}));point.dispatchEvent(new MouseEvent("click",{bubbles:true}))});
    expect(selected).toHaveBeenCalledWith({country:"DE",location:"city:DE:1"});
  }finally{act(()=>root.unmount());container.remove()}
});
