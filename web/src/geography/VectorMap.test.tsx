import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { buildMapModel } from "./mapModel";
import { overview } from "./testFixtures";
import { VectorMap } from "./VectorMap";

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
