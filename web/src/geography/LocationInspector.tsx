import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getGeographyUsersOptions } from "../lib/api/generated/@tanstack/react-query.gen";
import type { GeographyOverview } from "../lib/api/generated/types.gen";
import { useStrings } from "../i18n";
import { Button } from "../ui/Button";
import { placeName } from "./placeNames";
import { geographyErrorCode } from "./queries";

export function LocationInspector({data,groupId,expired}:{data:GeographyOverview;groupId:string;expired:boolean}){
  const strings=useStrings(),s=strings.geography,[pages,setPages]=useState<(string|null)[]>([null]);
  const cursor=pages[pages.length-1];
  const query=useQuery({...getGeographyUsersOptions({query:{snapshot_id:data.snapshot_id,group_id:groupId,limit:50,...(cursor?{cursor}:{})}}),enabled:!expired,staleTime:Infinity,retry:false,refetchOnWindowFocus:false});
  const selected=data.selection;
  const radius=selected&&"location" in selected?selected.location?.accuracy_radius_km:null;
  return <section className="geo-inspector" aria-label={s.users}>
    <header><small>{s.selected}</small><h2>{selected?placeName(selected,strings.locale,s):s.networkLocation}</h2><p>{selected?.unique_ips.toLocaleString(strings.locale)??"—"} IP · {selected?.accounts.toLocaleString(strings.locale)??"—"} {s.accounts}</p></header>
    <p className="geo-note">{s.approximate}</p><p className="geo-note">{radius!==null&&radius!==undefined?`${s.radius}: ${radius} km`:s.radiusUnknown}</p>
    {expired||geographyErrorCode(query.error)==="geography_snapshot_expired"?<p role="status">{s.expired}</p>:query.isError?<p role="alert">{s.error}</p>:query.isPending?<p role="status">{strings.common.loading}</p>:<>
      <div className="geo-user-rows">{query.data?.items.map(user=><Link to="/people/$username" params={{username:user.username}} key={user.username}><strong>{user.username}</strong><span>{user.unique_ips} IP</span></Link>)}</div>
      <footer className="geo-pagination"><span>{s.total}: {query.data?.total??0}</span><Button variant="ghost" disabled={pages.length===1} onClick={()=>setPages(pages.slice(0,-1))}>{s.previous}</Button><Button variant="ghost" disabled={!query.data?.next_cursor} onClick={()=>{if(query.data?.next_cursor)setPages([...pages,query.data.next_cursor])}}>{s.next}</Button></footer>
    </>}
  </section>;
}
