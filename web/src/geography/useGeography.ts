import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getGeographyOptions } from "../lib/api/generated/@tanstack/react-query.gen";
import type { GeographyOverview } from "../lib/api/generated/types.gen";
import { geographyErrorCode, removeGeography } from "./queries";
import type { GeographySearch } from "./search";

type Receipt={data:GeographyOverview;at:number};
type Frame={scope:string;base:Receipt;active:Receipt};
const receipts=new WeakMap<GeographyOverview,Receipt>();
function receipt(data:GeographyOverview):Receipt {let entry=receipts.get(data);if(!entry){entry={data,at:performance.now()};receipts.set(data,entry)}return entry;}
function snapshotFailure(code:string|null):boolean{return code==="geography_snapshot_expired"||code==="geography_source_changed"}

export function useGeography(search:GeographySearch,paused:boolean){
  const client=useQueryClient();
  const [visible,setVisible]=useState(()=>document.visibilityState!=="hidden");
  const [mono,setMono]=useState(()=>performance.now());
  const [blockedScope,setBlockedScope]=useState<string|null>(null);
  const [lastFrame,setLastFrame]=useState<Frame|null>(null);
  const scope=`${search.range}/${search.family}`,blocked=blockedScope===scope;
  const selectionScope=`${scope}/${search.country??""}/${search.location??""}`;
  const options=getGeographyOptions({query:{range:search.range,family:search.family}});
  const root=useQuery({...options,select:receipt,retry:(attempt,error)=>attempt<2&&snapshotFailure(geographyErrorCode(error)),retryDelay:attempt=>(attempt+1)*1000,staleTime:10_000,enabled:query=>visible&&!blocked&&(!paused||query.state.data===undefined),refetchInterval:visible&&!paused&&!blocked?(search.range==="now"?15_000:60_000):false,refetchOnWindowFocus:false});
  const base=root.data;
  const baseExpired=!!base&&(Math.max(0,mono-base.at)>=Math.max(0,base.data.expires_at-base.data.served_at)*1000);
  const hasSelection=!!(search.country||search.location);
  const selected=useQuery({...getGeographyOptions({query:{snapshot_id:base?.data.snapshot_id??"",...(search.country?{country:search.country}:{}),...(search.location?{location:search.location}:{})}}),select:receipt,enabled:visible&&!blocked&&!baseExpired&&hasSelection&&!!base,staleTime:Infinity,retry:false,refetchOnWindowFocus:false});
  const active=hasSelection?selected.data:base;
  const rootCode=geographyErrorCode(root.error),selectedCode=geographyErrorCode(selected.error);
  const retryingRoot=root.isFetching&&snapshotFailure(geographyErrorCode(root.failureReason)||rootCode);
  const code=selectedCode||(root.isError&&!retryingRoot?(snapshotFailure(rootCode)?"internal_error":rootCode):null);
  // Publish a snapshot and its selection together. Background selection requests
  // keep the previous frame, while query resets and scope changes clear it.
  const frame=base&&active?{scope:selectionScope,base,active}:base&&lastFrame?.scope===selectionScope?lastFrame:null;
  const shown=frame?.active,shownBase=frame?.base;
  useEffect(()=>{
    if(!base||!active||blocked)return;
    let mounted=true;
    queueMicrotask(()=>{if(mounted)setLastFrame(previous=>previous?.scope===selectionScope&&previous.base===base&&previous.active===active?previous:{scope:selectionScope,base,active})});
    return()=>{mounted=false};
  },[base,active,blocked,selectionScope]);
  useEffect(()=>{
    const timer=setInterval(()=>setMono(performance.now()),1000);return()=>clearInterval(timer);
  },[]);
  const refetch=root.refetch;
  useEffect(()=>{
    const changed=()=>{const next=document.visibilityState!=="hidden";setVisible(next);setMono(performance.now());if(next&&!paused&&!blocked)void refetch({cancelRefetch:false});};
    document.addEventListener("visibilitychange",changed);return()=>document.removeEventListener("visibilitychange",changed);
  },[paused,blocked,refetch]);
  useEffect(()=>{
    if(!snapshotFailure(selectedCode))return;
    queueMicrotask(()=>{setBlockedScope(scope);removeGeography(client)});
  },[selectedCode,scope,client]);
  const elapsed=shown?Math.max(0,mono-shown.at)/1000:0;
  useEffect(()=>client.getQueryCache().subscribe(event=>{
    if(event.type!=="updated"&&event.type!=="removed")return;
    const key=event.query.queryKey[0] as {_id?:string;query?:{snapshot_id?:string;range?:string;family?:string}};
    if(!key||!["getGeography","getGeographyLocations","getGeographyUsers"].includes(key._id??""))return;
    const currentSnapshot=!!key.query?.snapshot_id&&[base?.data.snapshot_id,shownBase?.data.snapshot_id].includes(key.query.snapshot_id);
    const currentRoot=key._id==="getGeography"&&!key.query?.snapshot_id&&`${key.query?.range}/${key.query?.family}`===scope;
    if(event.type==="removed"&&(currentRoot||currentSnapshot)||currentRoot&&event.type==="updated"&&event.query.state.data===undefined)queueMicrotask(()=>setLastFrame(null));
    if(event.type!=="updated"||event.action.type!=="error"||!currentSnapshot)return;
    const failure=geographyErrorCode(event.query.state.error);
    if(failure==="geography_snapshot_expired"||failure==="geography_source_changed")queueMicrotask(()=>{setBlockedScope(scope);removeGeography(client)});
  }),[client,scope,base?.data.snapshot_id,shownBase?.data.snapshot_id]);
  const age=shown?.data.source.age_secs===null?null:(shown?.data.source.age_secs??0)+elapsed;
  const expired=blocked||!!shownBase&&Math.max(0,mono-shownBase.at)>=Math.max(0,shownBase.data.expires_at-shownBase.data.served_at)*1000||!!shown&&(elapsed>=Math.max(0,shown.data.expires_at-shown.data.served_at));
  const stale=shown?.data.state==="stale"||!!shown&&(root.isError||selected.isError||retryingRoot)||search.range==="now"&&age!==null&&age>30;
  return {
    overview:blocked?undefined:shown?.data, base:blocked?undefined:shownBase?.data,
    loading:!shown&&(root.isPending||hasSelection&&selected.isPending),error:blocked?"geography_snapshot_expired":code||(root.isError&&!retryingRoot||selected.isError?"internal_error":null),
    expired,stale,age,refresh:async()=>{setBlockedScope(null);await refetch({cancelRefetch:false});},
  };
}
