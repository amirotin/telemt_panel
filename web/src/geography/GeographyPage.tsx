import { useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useStrings } from "../i18n";
import { PageHeader } from "../ui/PageHeader";
import { Button } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import { withBasePath } from "../lib/base-path";
import { validateGeographySearch, type GeographySearch } from "./search";
import { useGeography } from "./useGeography";
import { buildMapModel } from "./mapModel";
import { GeographySurface } from "./GeographySurface";
import { GeographySettings } from "./GeographySettings";
import { LocationList } from "./LocationList";
import { LocationInspector } from "./LocationInspector";
import "./geography.css";

export function GeographyPage(){
  const search=validateGeographySearch(useSearch({strict:false})),navigate=useNavigate();
  return <GeographyView search={search} onSearch={next=>{void navigate({to:"/geography",search:next})}}/>;
}

export function GeographyView({search,onSearch}:{search:GeographySearch;onSearch:(search:GeographySearch)=>void}){
  const strings=useStrings(),s=strings.geography;
  const [settings,setSettings]=useState(false),[paging,setPaging]=useState(false),[refreshEpoch,setRefreshEpoch]=useState(0);
  const [listKind,setListKind]=useState<"country"|"location">("country");
  const paused=!!search.location||paging;
  const state=useGeography(search,paused);
  const data=state.overview,base=state.base;
  const model=useMemo(()=>data?buildMapModel(data,{country:search.country,location:search.location}):null,[data,search.country,search.location]);
  const status=state.stale?"stale":data?.state??base?.state;
  const totals=base?.totals,quality=base?.quality;
  function refresh(){setPaging(false);setRefreshEpoch(refreshEpoch+1);void state.refresh()}
  function choose(next:Partial<GeographySearch>){setPaging(false);onSearch({...search,...next})}
  const stats=[{key:"ips",label:s.ips,value:totals?.unique_ips},{key:"accounts",label:s.accounts,value:totals?.accounts},{key:"countries",label:s.countries,value:totals?.country_count},{key:"coverage",label:s.coverage,value:quality?.coordinate_coverage===null||quality?.coordinate_coverage===undefined?undefined:Math.round(quality.coordinate_coverage*100),percent:true}];
  return <div className="geography-page" data-testid="geography-page">
    <PageHeader title={s.title} description={s.description} actions={<><Button variant="secondary" onClick={()=>setSettings(true)}>{s.settings}</Button><Button onClick={refresh}>{s.refresh}</Button></>}/>
    <div className="geo-filters"><label>{s.range}<select value={search.range} onChange={event=>choose({range:event.target.value as GeographySearch["range"],country:null,location:null})}>{(["now","24h","7d","30d"] as const).map(value=><option key={value} value={value}>{s.ranges[value]}</option>)}</select></label><label>{s.family}<select value={search.family} onChange={event=>choose({family:event.target.value as GeographySearch["family"],country:null,location:null})}><option value="all">{s.all}</option><option value="4">IPv4</option><option value="6">IPv6</option></select></label><Button variant="ghost" onClick={()=>choose({country:null,location:null})}>{s.clear}</Button></div>
    <div className="geo-stats">{stats.map(stat=><div className="geo-stat" data-geography-stat={stat.key} key={stat.key}><span>{stat.label}</span><strong>{stat.value===undefined?"—":`${stat.value.toLocaleString(strings.locale)}${stat.percent?"%":""}`}</strong></div>)}</div>
    <div className="geo-source-line" role="status"><span className={`geo-state-dot geo-state-${status??"loading"}`}/><strong>{status==="empty"&&base?.source.partial?s.partialEmpty:status?s[status]:s.loading}</strong>{state.age!==null&&data?.source.observed_at&&<span>{s.age}: {Math.floor(state.age)} {s.seconds}</span>}{paused&&<span>{s.paused}</span>}</div>
    {state.error&&<div className="geo-banner geo-error" role="alert">{state.error==="geography_snapshot_expired"?s.expired:s.error}<Button variant="ghost" onClick={refresh}>{strings.common.retry}</Button></div>}
    {base?.source.partial&&status!=="partial"&&<p className="geo-banner" role="status">{s.partial}</p>}
    {search.range!=="now"&&<p className="geo-note">{s.historyNote}{base?.source.durable===false?` · ${s.memory}`:""}{base?.source.pending?` · ${s.pending}`:""}</p>}
    {base&&!base.geoip.available&&<div className="geo-banner">{s.geoipOff}<a href={withBasePath("/server/settings#geoip")}>{s.configure}</a></div>}
    <div className="geo-workspace"><div className="geo-map-column">{model?<><GeographySurface model={model} view={search.view} onView={view=>onSearch({...search,view})} onSelect={selection=>choose(selection)}/><p className="geo-map-caption">{s.mapLimit.replace("{n}",String(data?.visible.points??0)).replace("{total}",String(data?.visible.total_coordinate_locations??0))}</p></>:<div className="geo-map-placeholder" role="status">{state.loading?s.loading:state.error?s.error:s.unavailable}</div>}
      {data?.server.state==="unresolved"&&<p className="geo-note">{s.unresolved}</p>}
      {data?.selection&&<div className="geo-selection-summary"><small>{s.selected}</small><strong>{(strings.locale==="ru"?data.selection.name_ru||data.selection.name:data.selection.name)||data.selection.country_code||s.networkLocation}</strong><span>{data.selection.unique_ips} IP · {data.selection.accounts} {s.accounts}</span></div>}
      {data&&search.location&&<LocationInspector key={`${data.snapshot_id}/${search.location}/${refreshEpoch}`} data={data} groupId={search.location} expired={state.expired}/>}
    </div>{base&&<LocationList key={`${search.range}/${search.family}/${search.country??""}/${refreshEpoch}`} snapshotId={base.snapshot_id} selection={{country:search.country,location:search.location}} expired={state.expired} onSelect={selection=>choose(selection)} onPaging={setPaging} kind={listKind} onKind={setListKind}/>}</div>
    <p className="geo-footer-note">{s.approximate} · <a href={withBasePath("/geography-licenses.txt")}>{s.licenses}</a></p>
    <Sheet open={settings} onClose={()=>setSettings(false)} title={s.settingsTitle} placement="form"><GeographySettings/></Sheet>
  </div>;
}
