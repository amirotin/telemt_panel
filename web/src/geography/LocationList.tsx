import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getGeographyLocationsOptions } from "../lib/api/generated/@tanstack/react-query.gen";
import { useStrings } from "../i18n";
import { Button } from "../ui/Button";
import { geographyErrorCode } from "./queries";
import { hasGeometry } from "./world";
import type { GeographySelection } from "./model";
import { placeName } from "./placeNames";

export function LocationList({snapshotId,selection,expired,onSelect,onPaging,kind,onKind}:{snapshotId:string;selection:GeographySelection;expired:boolean;onSelect:(s:GeographySelection)=>void;onPaging:(paused:boolean)=>void;kind:"country"|"location";onKind:(kind:"country"|"location")=>void}){
  const strings=useStrings(),s=strings.geography;
  const [pages,setPages]=useState<(string|null)[]>([null]);
  const cursor=pages[pages.length-1];
  const query=useQuery({...getGeographyLocationsOptions({query:{snapshot_id:snapshotId,kind,limit:50,...(kind==="location"&&selection.country?{country:selection.country}:{}),...(cursor?{cursor}:{})}}),enabled:!expired,staleTime:Infinity,retry:false,refetchOnWindowFocus:false,placeholderData:(previous,previousQuery)=>{
    const prior=(previousQuery?.queryKey[0] as {query?:{kind?:string;country?:string;cursor?:string}}|undefined)?.query;
    return !expired&&prior?.kind===kind&&prior.country===(kind==="location"?selection.country??undefined:undefined)&&prior.cursor===(cursor??undefined)?previous:undefined;
  }});
  const code=geographyErrorCode(query.error);
  return <section className="geo-list-card" aria-label={s.locations} aria-busy={query.isFetching}>
    <div className="geo-list-tabs">{(["country","location"] as const).map(value=><button type="button" key={value} aria-pressed={kind===value} onClick={()=>{onKind(value);setPages([null]);onPaging(false)}}>{value==="country"?s.countries:s.locations}</button>)}</div>
    {expired||code==="geography_snapshot_expired"?<p role="status" className="geo-list-message">{s.expired}</p>:query.isError?<p role="alert" className="geo-list-message">{s.error}</p>:query.isPending?<p role="status" className="geo-list-message">{strings.common.loading}</p>:<>
      <div className="geo-place-rows">{query.data?.items.map(item=><button key={item.id} type="button" className="geo-place-row" aria-disabled={query.isPlaceholderData||undefined} aria-pressed={item.id===selection.location||kind==="country"&&item.country_code===selection.country} onClick={()=>{if(!query.isPlaceholderData)onSelect(kind==="country"?{country:item.country_code,location:null}:{country:selection.country,location:item.id})}}>
        <span><strong>{placeName(item,strings.locale,s)}</strong><small>{"location" in item&&!item.location?s.noCoordinates:"location" in item?s.approximate:!hasGeometry(item.country_code)?s.noGeometry:s.countries}</small></span>
        <span className="geo-place-count"><strong>{item.unique_ips.toLocaleString(strings.locale)}</strong><small>{item.accounts.toLocaleString(strings.locale)} · {s.accounts}</small></span>
      </button>)}</div>
      <footer className="geo-pagination"><span>{s.total}: {query.data?.total??0}</span><Button variant="ghost" disabled={pages.length===1||query.isPlaceholderData} onClick={()=>{const next=pages.slice(0,-1);setPages(next);onPaging(next.length>1)}}>{s.previous}</Button><Button variant="ghost" disabled={!query.data?.next_cursor||query.isPlaceholderData} onClick={()=>{if(query.data?.next_cursor){setPages([...pages,query.data.next_cursor]);onPaging(true)}}}>{s.next}</Button></footer>
    </>}
  </section>;
}
