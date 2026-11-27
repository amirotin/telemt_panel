import {useContext,useEffect,useMemo,useState} from "react";
import {Link,useNavigate} from "@tanstack/react-router";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {getQuotaSchedule,getUserQuotaSchedule,previewQuotaSchedule,saveQuotaSchedule,saveUserQuotaSchedule} from "../lib/api/generated/sdk.gen";
import type {QuotaScheduleRule,QuotaScheduleView,UserQuotaSchedule} from "../lib/api/generated/types.gen";
import {countLabel,errorMessage,useStrings} from "../i18n";
import {Button} from "../ui/Button";
import {PageHeader} from "../ui/PageHeader";
import {IconChevronLeft} from "../ui/icons";
import {PeopleContext} from "./PeopleContext";
import {apiErrorCode} from "./apiError";
import {useDebouncedValue} from "./useDebouncedValue";
import {useUserFormBlocker} from "./useUserFormBlocker";
import {useNow} from "./useNow";
import {formatScheduleRun} from "./quotaSchedule.helpers";
import "./quotaSchedule.css";

const queryKey=(username?:string)=>["quota-schedule",username??""];
function useSchedule(username?:string){return useQuery({queryKey:queryKey(username),queryFn:async({signal})=>{
  const {data}=username?await getUserQuotaSchedule({path:{username},signal,throwOnError:true}):await getQuotaSchedule({signal,throwOnError:true});return data;
},retry:false,refetchOnWindowFocus:false,refetchInterval:15000});}

function RuleEditor({rule,onChange}:{rule:QuotaScheduleRule;onChange:(rule:QuotaScheduleRule)=>void}){
  const s=useStrings(),t=s.quotaSchedule,set=(patch:Partial<QuotaScheduleRule>)=>onChange({...rule,...patch});
  return <section className="qs-rule">
    <div className="qs-kind" role="group" aria-label={t.kind}>{([["interval",t.interval],["cron","Cron"]] as const).map(([key,label])=><button key={key} type="button" aria-pressed={rule.kind===key} onClick={()=>set({kind:key})}>{label}</button>)}</div>
    {rule.kind==="interval"?<>
      <div className="qs-field"><span>{t.frequency}</span><div className="qs-presets">{[1,7,30].map(days=><button key={days} type="button" aria-pressed={rule.days===days} onClick={()=>set({days})}>{countLabel(s,days,t.dayForms)}</button>)}</div></div>
      <label className="qs-field"><span>{t.days}</span><input aria-label={t.days} aria-describedby="qs-days-hint" type="number" min="1" max="3650000" step="1" inputMode="numeric" required value={rule.days??""} onChange={e=>set({days:e.target.value===""?undefined:Number(e.target.value)})}/><small id="qs-days-hint">{t.daysHint}</small></label>
      <div className="qs-date-grid"><label className="qs-field"><span>{t.start}</span><input type="date" required value={rule.start??""} onChange={e=>set({start:e.target.value})}/></label><label className="qs-field"><span>{t.time}</span><input type="time" required value={rule.time??""} onChange={e=>set({time:e.target.value})}/></label></div><p className="qs-muted">{t.gridNote}</p>
    </>:<>
      <label className="qs-field"><span>{t.cron}</span><input className="qs-cron" aria-label={t.cron} aria-describedby="qs-cron-hint" required maxLength={160} value={rule.cron??""} onChange={e=>set({cron:e.target.value})} spellCheck={false} autoCapitalize="off" autoComplete="off" placeholder="0 0 1 * *"/><small id="qs-cron-hint">{t.cronFields}</small></label>
      <div className="qs-examples">{[["0 0 * * *",t.daily],["0 0 * * MON",t.monday],["0 0 1 * *",t.monthly]].map(([cron,label])=><button type="button" key={cron} onClick={()=>set({cron})}>{label}</button>)}</div><p className="qs-muted">{t.cronNote}</p><a className="qs-help" href="https://crontab.guru/" target="_blank" rel="noopener noreferrer">{t.cronHelp} ↗</a>
    </>}
  </section>;
}

function RecoveryPolicy(){const t=useStrings().quotaSchedule;return <section className="user-section qs-recovery"><h2>{t.recovery}</h2><div className="qs-recovery-line"><span aria-hidden="true">↻</span><div><strong>{t.catchup}</strong><p>{t.catchupNote}</p></div></div><p className="qs-muted">{t.unknownNote}</p></section>;}

function LastRun({view}:{view:QuotaScheduleView}){
  const s=useStrings(),t=s.quotaSchedule,last=view.last;
  return <section className="user-section qs-last"><h2>{t.last}</h2>{!last?<p className="qs-muted">{t.noHistory}</p>:<>
    <strong>{last.state==="running"?t.running:last.state==="completed"&&!last.rejected&&!last.unknown?t.complete:last.state==="skipped"?t.noUsers:t.review}</strong><p className="qs-muted">{formatScheduleRun(last.started_at,view.effective_timezone,s.locale)}</p>
    {last.confirmed===undefined?<p className="qs-muted">{last.state==="interrupted"?t.unknownNote:`${t.runTotal}: ${last.total}`}</p>:<dl className="qs-results">{[[t.confirmed,last.confirmed],[t.rejected,last.rejected],[t.unknown,last.unknown],[t.remaining,last.remaining]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value??"—"}</dd></div>)}</dl>}
    {last.unknown!==undefined&&last.unknown>0&&<p className="qs-warning">{t.unknownNote}</p>}
  </>}</section>;
}

function ScheduleForm({initial,username,onCancel,onDirty}:{initial:QuotaScheduleView;username?:string;onCancel:()=>void;onDirty:(dirty:boolean)=>void}){
  const s=useStrings(),t=s.quotaSchedule,access=useContext(PeopleContext),cache=useQueryClient();
  const now=useNow();
  const [baseline,setBaseline]=useState(initial),[global,setGlobal]=useState(initial.global);
  const userDraft=(view:QuotaScheduleView):UserQuotaSchedule=>({mode:view.policy?.mode??"inherit",rule:view.policy?.mode==="custom"?view.policy.rule:view.global.rule});
  const [policy,setPolicy]=useState(()=>userDraft(initial));
  const [seenRevision, setSeenRevision] = useState(initial.revision);
  const dirty=username?JSON.stringify(policy)!==JSON.stringify(userDraft(baseline)):JSON.stringify(global)!==JSON.stringify(baseline.global);
  if (!dirty && initial.revision !== seenRevision) {
    setSeenRevision(initial.revision);
    setBaseline(initial);
    setGlobal(initial.global);
    setPolicy(userDraft(initial));
  }
  useEffect(()=>{onDirty(dirty);return()=>onDirty(false);},[dirty,onDirty]);
  const mode=policy.mode,rule=username&&mode==="custom"?policy.rule??global.rule:global.rule;
  const active=username?mode==="custom"||mode==="inherit"&&global.enabled:global.enabled;
  const body=useMemo(()=>({rule,timezone:global.timezone}),[rule,global.timezone]),debounced=useDebouncedValue(body,300);
  const preview=useQuery({queryKey:["quota-schedule-preview",debounced],queryFn:async({signal})=>{
    const {data}=await previewQuotaSchedule({body:debounced,signal,throwOnError:true});return data;
  },retry:false,enabled:!username||mode!=="off",staleTime:30000});
  const waiting=body!==debounced||preview.isPending||preview.isFetching;
  const mustValidate=!username||mode==="custom";
  const readonly=access.readOnly;
  const mutation=useMutation({mutationFn:async()=>{
    const headers={"If-Match":baseline.revision};
    const {data}=username?await saveUserQuotaSchedule({path:{username},headers,body:policy,throwOnError:true}):await saveQuotaSchedule({headers,body:global,throwOnError:true});return data;
  },retry:false,onSuccess:data=>{cache.setQueryData(queryKey(username),data);setBaseline(data);setGlobal(data.global);setPolicy(userDraft(data));onDirty(false);void cache.invalidateQueries({queryKey:["quota-schedule"]});}});
  const zones=useMemo(()=>[...new Set([baseline.server_timezone,global.timezone,"UTC",...Intl.supportedValuesOf("timeZone")])].filter(z=>z!=="server"),[baseline.server_timezone,global.timezone]);
  async function reload(){const {data}=username?await getUserQuotaSchedule({path:{username},throwOnError:true}):await getQuotaSchedule({throwOnError:true});cache.setQueryData(queryKey(username),data);setBaseline(data);setGlobal(data.global);setPolicy(userDraft(data));mutation.reset();}
  const reloadMutation=useMutation({mutationFn:reload,retry:false});
  const error=mutation.error??reloadMutation.error;
  const blocked=readonly||mutation.isPending;
  return <div className="quota-schedule">
    {!username&&<><PageHeader title={t.title} description={t.subtitle} back={<Link to="/people" aria-label={s.people.workspace.back}><IconChevronLeft aria-hidden="true"/>{s.people.title}</Link>} meta={<span className={`qs-state ${global.enabled?"on":""}`}>{global.enabled?t.enabled:t.disabled}</span>}/><div className="qs-counts"><div><strong>{baseline.custom_count}</strong><span>{t.custom}</span></div><div><strong>{baseline.excluded_count}</strong><span>{t.excluded}</span></div><p>{t.tracked}</p></div></>}
    <form onSubmit={e=>{e.preventDefault();if(!blocked&&dirty&&(!mustValidate||!waiting&&!preview.isError))mutation.mutate();}}>
      <div className="qs-layout"><div className="qs-stack"><section className="user-section">
        {username?<><h2>{t.userTitle} · {username}</h2><fieldset className="qs-modes" disabled={blocked}>{([["inherit",t.inherit,global.enabled?t.inherited:t.inheritedOff],["custom",t.custom,t.customNote],["off",t.off,t.offNote]] as const).map(([key,title,note])=><label key={key}><input type="radio" name="user-schedule" checked={mode===key} onChange={()=>setPolicy({...policy,mode:key})}/><span><strong>{title}</strong><small>{note}</small></span></label>)}</fieldset></>:<><label className="qs-switch"><div><strong>{t.common}</strong><span>{t.commonNote}</span></div><input type="checkbox" role="switch" aria-label={t.common} checked={global.enabled} disabled={blocked||!baseline.durable&&!global.enabled} onChange={e=>setGlobal({...global,enabled:e.target.checked})}/></label><p className="qs-muted">{t.independent}</p></>}
        {(!username||mode==="custom")&&<fieldset disabled={blocked}><RuleEditor rule={rule} onChange={next=>username?setPolicy({...policy,rule:next}):setGlobal({...global,rule:next})}/></fieldset>}
        {username&&<p className="qs-muted">{t.timezone}: {global.timezone}. {t.userZoneNote} <Link className="qs-help" to="/people" search={{schedule:true}}>{t.commonLink} →</Link></p>}
      </section>{!username&&<section className="user-section"><h2>{t.timezone}</h2><label className="qs-field"><span>{t.oneZone}</span><select value={global.timezone} disabled={blocked} onChange={e=>setGlobal({...global,timezone:e.target.value})}><option value="server">{t.server} · {baseline.server_timezone}</option>{zones.map(zone=><option key={zone} value={zone}>{zone}</option>)}</select></label><p className="qs-muted">{t.zoneNote}</p></section>}
      {!baseline.durable&&<p className="qs-warning" role="alert">{errorMessage(s,"quota_schedule_storage")}</p>}
      {initial.error&&<p className="qs-warning" role="alert">{errorMessage(s,initial.error)}</p>}
      </div><aside className="qs-stack">{!username||active?<section className="user-section qs-preview" aria-label={t.preview}><span className="qs-kicker">{active?t.upcoming:t.afterEnable}</span><h2>{global.timezone==="server"?baseline.server_timezone:global.timezone}</h2>
        {waiting?<p role="status">{t.pending}</p>:preview.isError?<p className="qs-error" role="alert">{errorMessage(s,apiErrorCode(preview.error)??"network")}</p>:<ol>{preview.data?.next_runs.map((date,i)=><li key={date}><span aria-hidden="true">{i+1}</span><div><strong>{formatScheduleRun(date,preview.data.effective_timezone,s.locale)}</strong><small>{i===0?t.next:t.then}</small></div></li>)}</ol>}
        {!dirty&&initial.next_due&&Date.parse(initial.next_due)<now&&<p className="qs-warning">{t.overdue}</p>}<p className="qs-muted">{t.previewNote}</p>
      </section>:<section className="user-section"><h2>{t.noSchedule}</h2><p>{mode==="off"?t.manualAvailable:t.inheritedOff}</p></section>}<RecoveryPolicy/></aside></div>
      {error&&<div role="alert" className="qs-warning">{errorMessage(s,apiErrorCode(error)??"network")}{apiErrorCode(error)==="quota_schedule_conflict"&&<Button type="button" variant="secondary" disabled={reloadMutation.isPending} onClick={()=>reloadMutation.mutate()}>{t.reload}</Button>}</div>}
      <footer className="qs-save"><span role="status">{readonly?s.people.workspace.readOnly:dirty?t.dirty:mutation.isSuccess?t.saved:t.unchanged}<small>{t.saveNote}</small></span><div className="user-buttons"><Button type="button" variant="secondary" disabled={mutation.isPending} onClick={onCancel}>{s.common.cancel}</Button><Button type="submit" disabled={blocked||!dirty||mustValidate&&(waiting||preview.isError)||active&&!baseline.durable}>{mutation.isPending?s.common.loading:t.save}</Button></div></footer>
    </form>{!username&&<LastRun view={initial}/>}
  </div>;
}

export function QuotaScheduleEditor({username,onCancel,onDirty}:{username?:string;onCancel:()=>void;onDirty:(dirty:boolean)=>void}){
  const s=useStrings(),query=useSchedule(username);
  if(!query.data)return <>{!username&&<PageHeader title={s.quotaSchedule.title} description={s.quotaSchedule.subtitle} back={<Link to="/people" aria-label={s.people.workspace.back}><IconChevronLeft aria-hidden="true"/>{s.people.title}</Link>}/>}{query.isPending?<p role="status">{s.common.loading}</p>:<div role="alert"><p className="qs-warning">{errorMessage(s,apiErrorCode(query.error)??"network")}</p><Button variant="secondary" onClick={()=>void query.refetch()}>{s.common.retry}</Button></div>}</>;
  return <>
    {query.isError && <div role="alert" className="qs-warning">{errorMessage(s,apiErrorCode(query.error)??"network")} <Button variant="secondary" onClick={()=>void query.refetch()}>{s.common.retry}</Button></div>}
    <ScheduleForm key={username??""} initial={query.data} username={username} onCancel={onCancel} onDirty={onDirty}/>
  </>;
}

export function QuotaSchedulePage(){const navigate=useNavigate(),{setDirty,confirmation}=useUserFormBlocker();return <div className="user-detail-page"><QuotaScheduleEditor onDirty={setDirty} onCancel={()=>void navigate({to:"/people"})}/>{confirmation}</div>;}

export function UserScheduleSummary({username,onEdit}:{username:string;onEdit:()=>void}){
  const s=useStrings(),t=s.quotaSchedule,query=useSchedule(username),v=query.data;
  return <section className="user-section quota-schedule qs-user-summary"><h2>{t.userTitle}</h2>{query.isError?<p className="qs-warning">{errorMessage(s,apiErrorCode(query.error)??"network")}</p>:!v?<p>{s.common.loading}</p>:<><span className={`qs-state ${v.effective?"on":""}`}>{v.policy?.mode==="custom"?t.custom:v.policy?.mode==="off"?t.off:v.global.enabled?t.inherited:t.disabled}</span>{v.effective&&v.next_due&&<strong className="qs-next">{formatScheduleRun(v.next_due,v.effective_timezone,s.locale)}</strong>}</>}<Button variant="secondary" onClick={onEdit}>{t.edit}</Button></section>;
}
