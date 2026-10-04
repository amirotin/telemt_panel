import { useEffect, useRef } from "react";
import type { RendererProps } from "./model";
import { createGlobeScene } from "./globeScene";

export default function Globe({model,expanded,onSelect,onUnavailable,cameraRef,controlsRef,rotation=false}:RendererProps&{onUnavailable:()=>void;rotation?:boolean}){
  const host=useRef<HTMLDivElement>(null),scene=useRef<ReturnType<typeof createGlobeScene>|null>(null);
  const callbacks=useRef({onSelect,onUnavailable});
  useEffect(()=>{callbacks.current={onSelect,onUnavailable}},[onSelect,onUnavailable]);
  useEffect(()=>{
    const element=host.current;if(!element)return;
    try{
      const instance=createGlobeScene(element,model,{cameraRef,onSelect:selection=>callbacks.current.onSelect(selection),onUnavailable:()=>callbacks.current.onUnavailable()});scene.current=instance;
      if(controlsRef)controlsRef.current={zoom:instance.zoom,reset:instance.reset,focus:instance.focus,motion:instance.setMotion};
      return()=>{instance.dispose();scene.current=null;if(controlsRef)controlsRef.current=null};
    }catch{callbacks.current.onUnavailable()}
    return undefined;
    // Scene lifetime follows this host; model and interaction state update below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  useEffect(()=>{scene.current?.update(model);scene.current?.setExpanded(expanded);scene.current?.setMotion(rotation)},[model,expanded,rotation]);
  return <div ref={host} className="geo-globe" style={{width:"100%",height:"100%"}} aria-hidden="true"/>;
}
