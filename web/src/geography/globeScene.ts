import { AmbientLight, BackSide, BufferGeometry, CanvasTexture, Color, DirectionalLight, Float32BufferAttribute, InstancedMesh, Line, LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, MeshPhongMaterial, Object3D, OctahedronGeometry, PerspectiveCamera, Raycaster, Scene, SphereGeometry, SRGBColorSpace, Vector2, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { geoEquirectangular, geoGraticule10, geoInterpolate, geoPath } from "d3-geo";
import type { MutableRefObject } from "react";
import type { CameraState, GeographySelection, MapModel } from "./model";
import { features, alpha2ForNumeric } from "./world";
import { pointRadius, weight } from "./mapModel";
import { createFrameScheduler } from "./globeLifecycle";

function position(latitude:number,longitude:number,radius=1.012){const lat=latitude*Math.PI/180,lon=longitude*Math.PI/180;return new Vector3(radius*Math.cos(lat)*Math.cos(lon),radius*Math.sin(lat),-radius*Math.cos(lat)*Math.sin(lon))}
export function createGlobeScene(host:HTMLElement,initial:MapModel,options:{cameraRef?:MutableRefObject<CameraState>;onSelect:(s:GeographySelection)=>void;onUnavailable:()=>void}){
  const renderer=new WebGLRenderer({antialias:true,alpha:true});renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.domElement.style.touchAction="pan-y pinch-zoom";host.append(renderer.domElement);
  const scene=new Scene(),camera=new PerspectiveCamera(40,1,.1,20);camera.position.set(...(options.cameraRef?.current.position??[0,.3,3.3]));
  const controls=new OrbitControls(camera,renderer.domElement);controls.enablePan=false;controls.enableDamping=true;controls.dampingFactor=.12;controls.minDistance=1.7;controls.maxDistance=6;controls.enabled=false;controls.autoRotate=false;controls.autoRotateSpeed=.35;
  const textureCanvas=document.createElement("canvas");textureCanvas.width=2048;textureCanvas.height=1024;
  const context=textureCanvas.getContext("2d");
  if(!context){controls.dispose();renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove();throw new Error("Canvas texture unavailable")}
  const texture=new CanvasTexture(textureCanvas),sphereGeometry=new SphereGeometry(1,64,32),sphereMaterial=new MeshPhongMaterial({map:texture,shininess:12,specular:0x152535}),sphere=new Mesh(sphereGeometry,sphereMaterial);scene.add(sphere);
  const light=new DirectionalLight(0xffffff,1.15);light.position.set(-3,4,5);scene.add(new AmbientLight(0xffffff,.85),light);
  const atmosphereMaterial=new MeshBasicMaterial({color:0x8fcfff,side:BackSide,transparent:true,opacity:.22,depthWrite:false}),atmosphere=new Mesh(sphereGeometry,atmosphereMaterial);atmosphere.scale.setScalar(1.025);scene.add(atmosphere);
  texture.colorSpace=SRGBColorSpace;
  const markerGeometry=new SphereGeometry(1,10,8),markerMaterial=new MeshBasicMaterial({color:0xffffff}),markers=new InstancedMesh(markerGeometry,markerMaterial,200);markers.count=0;scene.add(markers);
  const serverGeometry=new OctahedronGeometry(.035),serverMaterial=new MeshBasicMaterial({color:0xffffff}),server=new Mesh(serverGeometry,serverMaterial);server.visible=false;scene.add(server);
  const arcMaterial=new LineBasicMaterial({color:0x6fa9ff,transparent:true,opacity:.65}),arcGroup=new Object3D();scene.add(arcGroup);
  const media=matchMedia("(prefers-reduced-motion: reduce)");
  let model=initial,disposed=false,visible=true,hidden=document.visibilityState==="hidden",desiredMotion=false;
  function palette(){const css=getComputedStyle(document.documentElement);const token=(name:string,fallback:string)=>{const value=css.getPropertyValue(name).trim();return /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?$/.test(value)?`rgb(${value.split(/\s+/).join(",")})`:value||fallback};return {accent:new Color(token("--geo-data","#4dc5fb")),ocean:new Color(token("--geo-ocean","#0f283c")),land:new Color(token("--geo-land","#627f97")),border:token("--geo-border","#93afc3"),grid:token("--geo-grid","#7ea1bc"),text:new Color(token("--text","#ffffff"))}}
  function paint(){
    const colors=palette(),maximum=Math.max(0,...model.countries.map(c=>c.unique_ips)),countries=new Map(model.countries.map(c=>[c.country_code,c]));
    context!.clearRect(0,0,2048,1024);context!.fillStyle=colors.ocean.getStyle();context!.fillRect(0,0,2048,1024);
    const projection=geoEquirectangular().scale(2048/(2*Math.PI)).translate([1024,512]);const path=geoPath(projection).context(context!);
    context!.beginPath();path(geoGraticule10());context!.strokeStyle=colors.grid;context!.lineWidth=1;context!.globalAlpha=.22;context!.stroke();context!.globalAlpha=1;
    for(const f of features){const code=alpha2ForNumeric(f.id),country=code?countries.get(code):undefined,selected=!!code&&code===model.selection.country;context!.beginPath();path(f);context!.fillStyle=country?colors.land.clone().lerp(colors.accent,.4+weight(country.unique_ips,maximum)*.56).getStyle():colors.land.getStyle();context!.fill();context!.strokeStyle=selected?colors.text.getStyle():country?colors.accent.getStyle():colors.border;context!.lineWidth=selected?3:1;context!.stroke();}
    texture.needsUpdate=true;arcMaterial.color.copy(colors.accent);serverMaterial.color.copy(colors.text);atmosphereMaterial.color.copy(colors.accent);
    const maximumIP=Math.max(0,...model.points.map(p=>p.unique_ips)),height=Math.max(200,host.clientHeight);
    const pointScale=camera.position.length()*Math.tan(20*Math.PI/180)/height;
    markers.count=model.points.length;const matrix=new Matrix4();
    model.points.forEach((point,i)=>{const coord=point.location!;const size=pointRadius(point.unique_ips,maximumIP)*pointScale;matrix.makeScale(size,size,size);matrix.setPosition(position(coord.latitude,coord.longitude));markers.setMatrixAt(i,matrix);markers.setColorAt(i,point.id===model.selection.location?colors.text:colors.accent)});
    markers.instanceMatrix.needsUpdate=true;if(markers.instanceColor)markers.instanceColor.needsUpdate=true;markers.computeBoundingSphere();
    server.visible=!!model.server.location;if(model.server.location)server.position.copy(position(model.server.location.latitude,model.server.location.longitude,1.02));
    for(const child of [...arcGroup.children]){arcGroup.remove(child);(child as Line).geometry.dispose()}
    if(model.server.location){for(const point of model.arcs){const interpolate=geoInterpolate([model.server.location.longitude,model.server.location.latitude],[point.location!.longitude,point.location!.latitude]);const vertices:number[]=[];for(let i=0;i<=48;i++){const t=i/48,[lon,lat]=interpolate(t);const p=position(lat,lon,1.01+.12*Math.sin(Math.PI*t));vertices.push(p.x,p.y,p.z)}const geometry=new BufferGeometry().setAttribute("position",new Float32BufferAttribute(vertices,3));arcGroup.add(new Line(geometry,arcMaterial))}}
  }
  const scheduler=createFrameScheduler(()=>{if(disposed)return false;const changed=controls.update();renderer.render(scene,camera);if(options.cameraRef)options.cameraRef.current={...options.cameraRef.current,position:camera.position.toArray() as [number,number,number]};return !media.matches&&(changed||controls.autoRotate)});
  function activity(){const active=visible&&!hidden;scheduler.setActive(active);controls.enableDamping=!media.matches;controls.autoRotate=desiredMotion&&active&&!media.matches;if(active)scheduler.request()}
  const request=()=>scheduler.request();controls.addEventListener("change",request);
  const visibility=()=>{hidden=document.visibilityState==="hidden";activity()};document.addEventListener("visibilitychange",visibility);media.addEventListener("change",activity);
  const intersection=new IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting??true;activity()});intersection.observe(host);
  const resize=()=>{const width=Math.max(1,host.clientWidth),height=Math.max(1,host.clientHeight);renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();paint();scheduler.request()};
  const sizeObserver=new ResizeObserver(resize);sizeObserver.observe(host);
  const themeObserver=new MutationObserver(()=>{paint();scheduler.request()});themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:["data-theme","class","style"]});
  const raycaster=new Raycaster(),pointer=new Vector2();let down:[number,number]|null=null;
  const pointerDown=(event:PointerEvent)=>{down=[event.clientX,event.clientY]};
  const pointerUp=(event:PointerEvent)=>{if(!down||Math.hypot(event.clientX-down[0],event.clientY-down[1])>6){down=null;return}down=null;const box=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-box.left)/box.width*2-1,-(event.clientY-box.top)/box.height*2+1);raycaster.setFromCamera(pointer,camera);const hit=raycaster.intersectObjects([markers,sphere],false)[0];if(hit?.object===markers&&hit.instanceId!==undefined){const selected=model.points[hit.instanceId];options.onSelect({country:selected.country_code,location:selected.id})}};
  renderer.domElement.addEventListener("pointerdown",pointerDown);renderer.domElement.addEventListener("pointerup",pointerUp);
  const lost=(event:Event)=>{event.preventDefault();if(!disposed){scheduler.setActive(false);options.onUnavailable()}};renderer.domElement.addEventListener("webglcontextlost",lost);
  try{resize();activity()}catch(error){scheduler.dispose();controls.dispose();intersection.disconnect();sizeObserver.disconnect();themeObserver.disconnect();document.removeEventListener("visibilitychange",visibility);media.removeEventListener("change",activity);renderer.domElement.removeEventListener("pointerdown",pointerDown);renderer.domElement.removeEventListener("pointerup",pointerUp);renderer.domElement.removeEventListener("webglcontextlost",lost);texture.dispose();sphereGeometry.dispose();sphereMaterial.dispose();atmosphereMaterial.dispose();markerGeometry.dispose();markerMaterial.dispose();serverGeometry.dispose();serverMaterial.dispose();arcMaterial.dispose();renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove();throw error}
  return {
    update:(next:MapModel)=>{model=next;paint();scheduler.request()},resize,
    setExpanded:(enabled:boolean)=>{controls.enabled=enabled;renderer.domElement.style.touchAction=enabled?"none":"pan-y pinch-zoom";scheduler.request()},
    setMotion:(enabled:boolean)=>{desiredMotion=enabled;activity()},
    zoom:(factor:number)=>{camera.position.multiplyScalar(1/factor);camera.position.clampLength(1.7,6);controls.update();paint();scheduler.request()},
    reset:()=>{camera.position.set(0,.3,3.3);controls.target.set(0,0,0);controls.update();paint();scheduler.request()},
    focus:()=>{const point=model.points.find(p=>p.id===model.selection.location);if(point?.location){camera.position.copy(position(point.location.latitude,point.location.longitude,3.3));controls.update();paint();scheduler.request()}},
    dispose:()=>{if(disposed)return;disposed=true;scheduler.dispose();controls.removeEventListener("change",request);controls.dispose();intersection.disconnect();sizeObserver.disconnect();themeObserver.disconnect();document.removeEventListener("visibilitychange",visibility);media.removeEventListener("change",activity);renderer.domElement.removeEventListener("pointerdown",pointerDown);renderer.domElement.removeEventListener("pointerup",pointerUp);renderer.domElement.removeEventListener("webglcontextlost",lost);for(const child of arcGroup.children)(child as Line).geometry.dispose();arcMaterial.dispose();markerGeometry.dispose();markerMaterial.dispose();serverGeometry.dispose();serverMaterial.dispose();sphereGeometry.dispose();sphereMaterial.dispose();atmosphereMaterial.dispose();texture.dispose();renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove();},
  };
}
