import {useContext,useState,type ReactNode} from "react";
import {Link} from "@tanstack/react-router";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {prepareBulkQuotaReset,startBulkQuotaReset} from "../lib/api/generated/sdk.gen";
import {getBulkQuotaResetOptions,getBulkQuotaResetQueryKey} from "../lib/api/generated/@tanstack/react-query.gen";
import {getBasePath} from "../lib/base-path";
import {fill,formatNumber,errorMessage,useStrings} from "../i18n";
import {apiErrorCode} from "./apiError";
import {PeopleContext} from "./PeopleContext";
import {BulkQuotaContext} from "./bulkQuotaContext";
import {Button} from "../ui/Button";
import {Sheet} from "../ui/Sheet";
import {Skeleton} from "../ui/Skeleton";
import "./bulkQuota.css";

const storageKey=()=>`telemt-panel:quota-reset:${getBasePath()}`;
function savedOperation(){try{return sessionStorage.getItem(storageKey())??undefined;}catch{return undefined;}}

export function BulkQuotaProvider({children}:{children:ReactNode}){
  const s=useStrings(),t=s.people.bulkQuota,access=useContext(PeopleContext),queryClient=useQueryClient();
  const [view,setView]=useState<"menu"|"prepare"|"result"|null>(null),[anchor,setAnchor]=useState<DOMRect>();
  const [tracked,setTracked]=useState(savedOperation),[offset,setOffset]=useState(0),[agreed,setAgreed]=useState(false);
  function track(id:string|undefined){setTracked(id);setOffset(0);try{if(id)sessionStorage.setItem(storageKey(),id);else sessionStorage.removeItem(storageKey());}catch{/* In-memory recovery still works if browser storage is disabled. */}}
  const prepare=useMutation({mutationFn:async()=>{const {data}=await prepareBulkQuotaReset({throwOnError:true});return data;},retry:false});
  const start=useMutation({
    mutationFn:async(token:string)=>{const {data}=await startBulkQuotaReset({body:{token},throwOnError:true});return data;},retry:false,
    onMutate:token=>{const previous=tracked;track(token);setView("result");return {previous};},
    onSuccess:operation=>{queryClient.setQueryData(getBulkQuotaResetQueryKey({query:{id:operation.id,offset:0}}),{operation});},
    onError:(error,_token,context)=>{
      const code=apiErrorCode(error);
      if(["quota_confirmation_expired","revision_conflict","no_changes","read_only","capability_absent","quota_reset_busy"].includes(code??"")){
        track(context?.previous);setAgreed(false);prepare.reset();setView("prepare");
      }
    },
    onSettled:()=>{void queryClient.invalidateQueries({queryKey:getBulkQuotaResetQueryKey()});},
  });
  const status=useQuery({
    ...getBulkQuotaResetOptions({query:{id:tracked,offset}}),retry:false,enabled:!start.isPending,
    refetchInterval:query=>{
      if (query.state.error) {
        const code = apiErrorCode(query.state.error);
        if ((!tracked && query.state.data?.operation?.state !== "running") || ["quota_operation_unavailable", "bad_request", "session_expired"].includes(code ?? "") || query.state.errorUpdateCount >= 6) return false;
        return Math.min(30_000, 2_000 * 2 ** query.state.errorUpdateCount);
      }
      if(query.state.data?.operation?.state==="running")return 2000;
      return false;
    },
  });
  const job=status.data?.operation;
  const running=start.isPending||job?.state==="running";
  const attention=!!job&&(job.rejected>0||job.unknown>0||job.state==="stopped");
  const title=running?t.running:job?.state==="stopped"?t.stopped:attention?t.partial:t.completed;
  const number=(v:number)=>formatNumber(s,v);
  function beginPrepare(){setView("prepare");setAgreed(false);start.reset();prepare.reset();prepare.mutate();}
  function current(){track(undefined);setView("result");void queryClient.invalidateQueries({queryKey:getBulkQuotaResetQueryKey()});}
  const problem=start.error??prepare.error;
  const message=(error:unknown)=>apiErrorCode(error)==="no_changes"?t.empty:errorMessage(s,apiErrorCode(error)??"network");
  const close=()=>setView(null);
  return <BulkQuotaContext.Provider value={{running,openMenu:next=>{setAnchor(next);setView("menu");}}}>
    {(job||tracked&&status.isError)&&<button type="button" className={`bq-bar ${attention||status.isError?"attention":""}`} data-testid="bulk-quota-status" onClick={()=>setView("result")}>
      <span className="bq-bar-glyph" aria-hidden="true">↺</span><span><strong>{status.isError?t.review:title}</strong><small>{job?`${number(job.confirmed)} / ${number(job.total)} · ${t.confirmed}`:t.lost}</small></span><span aria-hidden="true">›</span>
    </button>}
    {children}
    <Sheet open={view!==null} title={view==="menu"?t.menu:view==="result"&&job?.trigger==="schedule"?s.quotaSchedule.last:t.title} placement={view==="menu"?"menu":"auto"} anchor={view==="menu"?anchor:undefined} onClose={close}>
      {view==="menu"&&<div className="user-action-groups"><button className="bq-menu-action" type="button" disabled={!access.canResetQuota&&!running} onClick={()=>running?setView("result"):beginPrepare()}><span aria-hidden="true">↺</span><div><strong>{running?t.running:t.action}</strong><small>{t.resultNote}</small></div><span aria-hidden="true">›</span></button><Link className="bq-menu-action" to="/people" search={{schedule:true}} onClick={close}><span aria-hidden="true">◷</span><div><strong>{s.quotaSchedule.title}</strong><small>{s.quotaSchedule.subtitle}</small></div><span aria-hidden="true">›</span></Link></div>}
      {view==="prepare"&&<div className="bq-content">
        {prepare.isPending?<><p role="status">{t.checking}</p><Skeleton className="h-24 w-full"/></>:prepare.data?<>
          <div className="bq-intro"><span className="bq-symbol" aria-hidden="true">↺</span><div><h3>{fill(t.all,{count:number(prepare.data.total)})}</h3><p>{t.scope}</p></div></div>
          <div className="bq-change"><span>{t.change}</span><strong>→ 0</strong></div>
          <div className="bq-preserved"><strong>{t.preserved}</strong><p>{t.preservedNote}</p></div><p>{t.effect}</p>
          <label className="bq-agree"><input type="checkbox" checked={agreed} onChange={e=>setAgreed(e.target.checked)} disabled={!access.canResetQuota}/><span>{fill(t.agree,{count:number(prepare.data.total)})}</span></label><p className="bq-note">{t.expiry}</p>
        </>:null}
        {problem&&<p role="alert" className="bq-warning">{message(problem)}</p>}
        <div className="bq-footer"><Button variant="secondary" onClick={close}>{s.common.cancel}</Button>{prepare.data?<Button variant="danger" disabled={!agreed||!access.canResetQuota||running} onClick={()=>start.mutate(prepare.data!.token)}>{t.start}</Button>:<Button disabled={prepare.isPending||!access.canResetQuota} onClick={beginPrepare}>{t.refresh}</Button>}{apiErrorCode(problem)==="quota_reset_busy"&&<Button variant="secondary" onClick={current}>{t.current}</Button>}</div>
      </div>}
      {view==="result"&&<div className={`bq-content ${attention?"attention":""}`}>
        {start.isPending||status.isPending?<><p role="status">{s.common.loading}</p><Skeleton className="h-24 w-full"/></>:null}
        {status.isError&&<div role="alert"><p className="bq-warning">{job?t.paused:t.lost}</p><Button variant="secondary" onClick={()=>void status.refetch()}>{s.common.retry}</Button><Button variant="secondary" onClick={current}>{t.current}</Button></div>}
        {job&&<>
          <div className="bq-intro"><span className="bq-symbol" aria-hidden="true">{running?"↺":attention?"!":"✓"}</span><div><h3 role="status">{status.isError?t.review:title}</h3><p>{job.reason?(job.reason==="server_stopped"?t.serverStopped:job.reason==="reset_unconfirmed"?t.unconfirmed:errorMessage(s,job.reason)):running?t.progressNote:t.resultNote}</p></div></div>
          <div className="bq-progress-head"><strong>{number(job.processed)} <small>{fill(t.processed,{count:number(job.total)})}</small></strong><span>{Math.round(job.processed/job.total*100)}%</span></div>
          <div className="bq-track" role="progressbar" aria-label={t.running} aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={job.processed}><i style={{width:`${job.processed/job.total*100}%`}}/></div>
          <div className="bq-facts">{[[job.confirmed,t.confirmed],[job.rejected,t.rejected],[job.unknown,t.unknown],[job.remaining,running?t.waiting:t.notSent]].map(([v,label])=><div key={label}><strong>{number(Number(v))}</strong><span>{label}</span></div>)}</div>
          {job.unknown>0&&<p className="bq-warning">{t.unknownNote}</p>}
          {!running&&job.remaining>0&&<p>{fill(t.remainingNote,{count:number(job.remaining)})}</p>}
          {job.issues.length>0&&<div className="bq-issues" aria-label={t.review}>{job.issues.map(issue=><div key={issue.username}><Link to="/people/$username" params={{username:issue.username}} onClick={close}>{issue.username} →</Link><p>{issue.outcome==="unknown"?t.unknownNote:errorMessage(s,issue.code)}</p></div>)}</div>}
          {job.issues_total>50&&<div className="bq-pagination"><span>{fill(t.exceptionPage,{start:offset+1,end:offset+job.issues.length,total:job.issues_total})}</span><Button size="sm" variant="secondary" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-50))}>{t.previous}</Button><Button size="sm" variant="secondary" disabled={job.next_offset===undefined} onClick={()=>setOffset(job.next_offset??offset)}>{t.next}</Button></div>}
          {!running&&attention&&<p className="bq-note">{t.noRetry}</p>}
        </>}
        {!job&&!status.isPending&&!status.isError&&!start.isPending&&<p>{t.lost}</p>}
        {start.isError&&!job&&<p role="alert">{message(start.error)}</p>}
        <div className="bq-footer"><Button onClick={close}>{running?t.collapse:t.done}</Button></div>
      </div>}
    </Sheet>
  </BulkQuotaContext.Provider>;
}
