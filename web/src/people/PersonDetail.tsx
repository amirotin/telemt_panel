import {useContext,useState,useRef,useEffect} from "react";
import {Link,useNavigate} from "@tanstack/react-router";
import {useStrings} from "../i18n";
import {formatBytes} from "../lib/format";
import {AsyncState} from "../components/AsyncState";
import {Button} from "../ui/Button";
import {IconChevronLeft,IconMore} from "../ui/icons";
import {PageHeader} from "../ui/PageHeader";
import {useConnectionState} from "../realtime";
import {useUsersTopic,findQuotaEntry} from "./useUsersTopic";
import {useNow} from "./useNow";
import {UserActionSheet,type ActionSheetIntent} from "./UserActionSheet";
import {UserFormSheet} from "./UserFormSheet";
import {PersonQuotaCard,ExpiryLine} from "./PersonSections";
import {PersonTrafficHistory} from "./PersonTrafficHistory";
import {PersonIPHistory,PersonIPHistoryEntry} from "./PersonIPHistory";
import {ConnectionLinks,QuickConnectionLinks} from "./ConnectionLinks";
import {SublinkPanel} from "./SublinkPanel";
import {WebAccessPanel} from "./WebAccessPanel";
import {PeopleContext} from "./PeopleContext";
import {useBulkQuota} from "./bulkQuotaContext";
import {getUserQuota,isOnline,computeUserStatus} from "./users.helpers";
import {useUserFormBlocker} from "./useUserFormBlocker";
import {QuotaScheduleEditor,UserScheduleSummary} from "./QuotaSchedule";

export type PersonTab="overview"|"access"|"ips"|"schedule"|"settings";

export function PersonDetail({username,tab="overview"}:{username:string;tab?:PersonTab}) {
  const s=useStrings(),t=s.people.workspace,topic=useUsersTopic(),connection=useConnectionState(),now=useNow();
  const access=useContext(PeopleContext),navigate=useNavigate();
  const bulkQuota=useBulkQuota();
  const [intent,setIntent]=useState<ActionSheetIntent|null>(null);
  const {setDirty,confirmation}=useUserFormBlocker();
  const tabNav=useRef<HTMLElement>(null);
  useEffect(()=>{const nav=tabNav.current,selected=nav?.querySelector<HTMLElement>('[aria-current="page"]');if(!nav||!selected)return;const n=nav.getBoundingClientRect(),b=selected.getBoundingClientRect();if(b.left<n.left)nav.scrollLeft-=n.left-b.left;else if(b.right>n.right)nav.scrollLeft+=b.right-n.right;},[tab,topic.isPending]);
  function select(next:PersonTab){void navigate({to:"/people/$username",params:{username},search:{tab:next},replace:true});}
  return <div className="user-detail-page">
    {(topic.isPending || topic.isError || !topic.users.some(user=>user.username===username)) && <PageHeader title={username} back={<Link to="/people" aria-label={s.common.back}><IconChevronLeft aria-hidden="true"/>{s.people.title}</Link>}/>}
    <AsyncState isPending={topic.isPending} isError={topic.isError} errorCode={topic.errorCode??undefined} data={topic.users} isEmpty={users=>!users.some(u=>u.username===username)} emptyTitle={s.people.notFoundTitle} stale={topic.stale||connection.stale} onRetry={connection.retry}>
      {users=>{
        const user=users.find(u=>u.username===username)!;
        const quota=getUserQuota(user,findQuotaEntry(topic.quota,username));
        const state=computeUserStatus(user,quota,now);
        return <>
          <PageHeader title={username} back={<Link to="/people" aria-label={s.common.back}><IconChevronLeft aria-hidden="true"/>{s.people.title}</Link>} meta={<span className={state!=="active"?"text-warn":isOnline(user)?"text-ok":"text-text-muted"}>{state==="active"?(isOnline(user)?s.people.online:s.people.offline):s.people.status[state]}</span>} actions={<><QuickConnectionLinks user={user}/><Button variant="secondary" disabled={access.readOnly||topic.stale} onClick={()=>select("settings")}>{s.people.actions.edit}</Button><button type="button" className="user-menu-trigger" aria-label={s.people.actions.menu} onClick={()=>setIntent("menu")}><IconMore/></button></>}/>
          {tab!=="settings"&&<div className="user-vitals">{[[s.people.connections,String(user.current_connections),s.people.now],[s.people.activeIps,String(user.active_unique_ips),user.max_unique_ips?`${s.people.meta.of} ${user.max_unique_ips}`:t.unlimited],[t.totalTraffic,user.traffic?formatBytes(user.traffic.observed_total_bytes,s):"—",t.totalNote]].map(([label,value,note])=><div key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}</div>}
          <nav ref={tabNav} className="user-detail-tabs" aria-label={username}>{(["overview","access","ips","schedule","settings"] as const).map(key=><button type="button" key={key} aria-current={tab===key?"page":undefined} onClick={()=>select(key)}>{key==="schedule"?s.quotaSchedule.tab:t[key]}</button>)}</nav>
          {tab==="schedule"&&<QuotaScheduleEditor username={username} onDirty={setDirty} onCancel={()=>select("overview")}/>}
          {tab==="overview"&&<div className="user-detail-grid"><div className="user-detail-main"><section className="user-section"><PersonTrafficHistory username={username} traffic={user.traffic}/></section><section className="user-section"><PersonIPHistoryEntry username={username}/><Button variant="secondary" onClick={()=>select("ips")}>{t.ips} →</Button></section></div><div className="user-detail-aside"><section className="user-section"><h2>{t.quota}</h2><p className="user-note">{t.usedQuota} · Telemt</p><PersonQuotaCard quota={quota}/><Button variant="secondary" disabled={!access.canResetQuota||bulkQuota.running||topic.stale||quota.usedBytes===null} onClick={()=>setIntent("reset-quota")}>{t.resetQuota}</Button><p className="user-note">{t.resetNote}</p></section><UserScheduleSummary username={username} onEdit={()=>select("schedule")}/><section className="user-section"><h2>{t.conditions}</h2><dl className="user-facts"><div><dt>{s.people.form.expiry}</dt><dd><ExpiryLine expirationRfc3339={user.expiration_rfc3339} now={now}/></dd></div><div><dt>{s.people.runtimeState}</dt><dd>{user.in_runtime?s.people.runtimeLoaded:s.people.status.not_in_runtime}</dd></div><div><dt>{s.people.webAccess.title}</dt><dd>{access.profiles.get(username)?.length??0}</dd></div></dl></section></div></div>}
          {tab==="access"&&<div className="user-detail-grid"><div className="user-detail-main"><ConnectionLinks user={user}/><section className="user-section"><h2>{t.subscription}</h2><SublinkPanel username={username}/></section></div><section className="user-section"><WebAccessPanel username={username} readOnly={access.readOnly||topic.stale}/></section></div>}
          {tab==="ips"&&<section className="user-section"><PersonIPHistory username={username}/></section>}
          {tab==="settings"&&<><p className="user-note">{access.readOnly?t.readOnly:""}</p><UserFormSheet inline open mode="edit" user={user} disabled={access.readOnly||topic.stale} onDirtyChange={setDirty} onClose={()=>select("overview")}/></>}
          <UserActionSheet key={intent??"closed"} open={intent!==null} intent={intent??"menu"} user={user} readOnly={access.readOnly||topic.stale} onClose={()=>setIntent(null)} onEdit={()=>select("settings")} onOpenPerson={()=>select("overview")} onOpenAccess={()=>select("access")} onDeleted={()=>void navigate({to:"/people"})}/>
        </>;
      }}
    </AsyncState>
    {confirmation}
  </div>;
}
