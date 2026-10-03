import type {CSSProperties} from "react";
import {formatBytes} from "../lib/format";
import {localeOf,useStrings} from "../i18n";
import {IconMore,IconRefresh,IconShield} from "../ui/icons";
import {computeUserStatus,getUserQuota,isOnline} from "./users.helpers";
import {QuickConnectionLinks} from "./ConnectionLinks";
import {useUserRowGestures,type SwipeSide} from "./useUserRowGestures";
import type {UsersTopicQuotaEntry,UsersTopicUser} from "../realtime/topics";

export interface UserCardProps {
  user:UsersTopicUser; quotaEntry:UsersTopicQuotaEntry|undefined; now:number;
  gesturesEnabled?:boolean; swipeSide?:SwipeSide;
  canResetQuota?:boolean; canToggle?:boolean;
  onOpen:()=>void; onActions:(anchor?:DOMRect)=>void;
  onResetQuota:()=>void; onToggle:()=>void; onSwipeChange:(side:SwipeSide)=>void;
}

export function UserCard({user,quotaEntry,now,gesturesEnabled=false,swipeSide=null,canResetQuota=false,canToggle=false,onOpen,onActions,onResetQuota,onToggle,onSwipeChange}:UserCardProps) {
  const s=useStrings(),t=s.people.workspace;
  const quota=getUserQuota(user,quotaEntry);
  const exhausted=quota.limitBytes!==null&&quota.limitBytes>0&&quota.usedBytes!==null&&quota.usedBytes>=quota.limitBytes;
  const status=computeUserStatus(user,quota,now);
  const online=isOnline(user);
  const statusText=status==="active"?(online?s.people.online:s.people.offline):s.people.status[status];
  const {gestureProps,activationProps,onTap,offset,dragging}=useUserRowGestures({enabled:gesturesEnabled,side:swipeSide,onChange:onSwipeChange,onOpen,onMenu:()=>onActions(),description:t.gestureHelp});
  const used=quota.usedBytes===null?"—":formatBytes(quota.usedBytes,s);
  const limit=quota.limitBytes===null?t.unlimited:formatBytes(quota.limitBytes,s);
  const quotaText=quota.usedBytes===null?t.quotaUnknown:`${used} / ${limit}`;
  const ratio=quota.limitBytes!==null&&quota.usedBytes!==null?Math.min(100,Math.max(0,quota.usedBytes/quota.limitBytes*100)):null;
  const near=ratio!==null&&ratio>=85&&ratio<100;
  const observed=user.traffic?formatBytes(user.traffic.observed_total_bytes,s):"—";
  const expires=user.expiration_rfc3339?new Date(user.expiration_rfc3339):null;
  const validExpiry=expires!==null&&!Number.isNaN(expires.getTime());
  const expiry=validExpiry?new Intl.DateTimeFormat(localeOf(s),{day:"2-digit",month:"2-digit",...(expires.getFullYear()!==new Date(now).getFullYear()?{year:"numeric" as const}:{})}).format(expires):s.people.detail.noExpiry;
  let hue=0;for(const character of user.username)hue=(hue*31+character.codePointAt(0)!)%360;
  const avatarStyle={"--avatar-hue":hue} as CSSProperties;
  const style:CSSProperties={transform:gesturesEnabled?`translateX(${offset}px)`:undefined};
  return <article className="user-row-shell" data-testid="user-row" data-user={user.username} data-swipe={swipeSide??"closed"} data-quota-warning={exhausted} data-tone={status==="expired"||status==="quota_exhausted"?"danger":status==="not_in_runtime"?"warn":"normal"} {...activationProps} onKeyDown={e=>{if(e.target instanceof Node&&e.currentTarget.contains(e.target)&&(e.key==="ContextMenu"||(e.shiftKey&&e.key==="F10"))){e.preventDefault();onActions();}}}>
    {gesturesEnabled&&<>
      <div className="user-side user-side-quota" aria-hidden={swipeSide!=="left"}><span>{t.usedQuota}</span><strong>{quotaText}</strong><button type="button" aria-label={`${t.resetQuota} ${user.username}`} tabIndex={swipeSide==="left"?0:-1} disabled={!canResetQuota||quota.usedBytes===null} onClick={onResetQuota}><IconRefresh/>{t.resetQuota}</button></div>
      <button type="button" className={`user-side user-side-access ${user.enabled?"":"enable"}`} aria-label={`${user.enabled?s.people.actions.disable:s.people.actions.enable} ${user.username}`} aria-hidden={swipeSide!=="right"} tabIndex={swipeSide==="right"?0:-1} disabled={!canToggle} onClick={onToggle}><IconShield/><strong>{user.enabled?s.people.actions.disable:s.people.actions.enable}</strong></button>
    </>}
    <div className="user-row-face" {...gestureProps} style={style} data-dragging={dragging} onClick={e=>{if(e.target instanceof Element&&e.currentTarget.contains(e.target)&&!e.target.closest("button,a,input,select"))onTap();}} onContextMenu={e=>{if(e.target instanceof Node&&e.currentTarget.contains(e.target)){e.preventDefault();onActions();}}}>
      <button type="button" className="user-identity" data-testid={`user-card-${user.username}`} aria-label={`${t.openPerson} ${user.username}`} aria-description={exhausted?t.exhausted:undefined} onClick={onTap}><span className="user-avatar" style={avatarStyle} data-muted={!user.enabled} aria-hidden="true">{Array.from(user.username)[0]?.toUpperCase()}</span><span><strong title={user.username}>{user.username}</strong><small className={status!=="active"?"text-warn":online?"text-ok":"text-text-muted"}><i aria-hidden="true"/>{statusText}</small></span></button>
      <div className="user-col-now"><strong>{user.current_connections}</strong><span>{s.people.list.connectionsShort}</span><small aria-label={`${user.active_unique_ips} ${s.people.activeIps}`} title={`${user.active_unique_ips} ${s.people.activeIps}`}>{user.active_unique_ips} {gesturesEnabled?s.people.meta.ipShort:s.people.activeIps}</small></div>
      <div className="user-col-traffic">
        {quota.limitBytes!==null?<><div className={`user-traffic-pill ${exhausted?"danger":near?"warn":""}`} data-quota-fill style={{"--quota-fill":`${ratio??0}%`} as CSSProperties} role={ratio===null?undefined:"progressbar"} aria-label={t.usedQuota} aria-valuemin={ratio===null?undefined:0} aria-valuemax={ratio===null?undefined:100} aria-valuenow={ratio??undefined} aria-valuetext={quotaText} title={s.people.list.quotaHint}><strong data-quota-used>{used}</strong><span>{s.people.meta.of} {limit}</span></div><small>{ratio===null?t.quotaUnknown:s.people.list.telemtQuota} · <span data-observed-traffic>{s.people.list.observed} {observed}</span></small></>:<><div className="user-traffic-pill unlimited"><strong data-observed-traffic>{observed}</strong><span>{s.people.list.noQuota}</span></div><small>{user.traffic?s.people.list.panelTraffic:s.people.list.noTraffic}</small></>}
      </div>
      <div className="user-col-expiry"><span className={`user-expiry ${status==="expired"?"expired":""}`} title={validExpiry?expires.toLocaleString(localeOf(s)):s.people.detail.noExpiry}>{validExpiry?`${expires.getTime()<=now?s.people.list.expired:s.people.list.until} ${expiry}`:expiry}</span></div>
      <div className="user-row-actions" inert={gesturesEnabled&&swipeSide!==null}><QuickConnectionLinks user={user}/><button type="button" className="user-menu-trigger" aria-label={`${s.people.actions.menu} ${user.username}`} onClick={e=>onActions(gesturesEnabled?undefined:e.currentTarget.getBoundingClientRect())}><IconMore/></button></div>
    </div>
  </article>;
}
