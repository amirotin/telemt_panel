import {createContext, useMemo, useState, type ReactNode} from "react";
import {useQuery} from "@tanstack/react-query";
import {getTelemtWebAccessOptions} from "../lib/api/generated/@tanstack/react-query.gen";
import {useCaps} from "../caps/useCaps";
import {useSnapshot} from "../realtime";
import type {StatsSnapshot} from "../realtime/topics";
import {webProfileIndex, type LinkFormat, type WebLinkProfile, type MTProtoListenerState} from "./connectionLinks";
import type {UserFilter} from "./users.helpers";

function newListView(){return {search:"",filter:"all" as UserFilter,scrollOffset:0,returnUsername:null as string|null};}

export interface PeopleContextValue {
  profiles: Map<string, WebLinkProfile[]>;
  mtprotoListener?: MTProtoListenerState;
  webUnavailable: boolean;
  readOnly: boolean;
  canResetQuota: boolean;
  canToggle: boolean;
  formats: Map<string, LinkFormat>;
  setFormat: (username: string, format: LinkFormat) => void;
  listView: ReturnType<typeof newListView>;
}
// eslint-disable-next-line react-refresh/only-export-components
export const PeopleContext = createContext<PeopleContextValue>({profiles:new Map(),webUnavailable:false,readOnly:true,canResetQuota:false,canToggle:false,formats:new Map(),setFormat:()=>{},listView:newListView()});

export function PeopleProvider({children}: {children: ReactNode}) {
  // The parent Users route survives detail navigation, but not a section exit.
  const listView = useMemo(()=>newListView(),[]);
  const caps = useCaps();
  const stats = useSnapshot<StatsSnapshot>("stats");
  const readOnly = stats.data?.health?.read_only !== false || stats.stale;
  const web = useQuery({...getTelemtWebAccessOptions(), enabled:!!caps.data?.capabilities.config_api});
  const profiles = useMemo(()=>webProfileIndex(web.data),[web.data]);
  const mtprotoListener = caps.data?.capabilities.config_api && !caps.isError && !web.isError ? web.data?.mtproto_listener ?? "unknown" : "unknown";
  const [formats,setFormats] = useState(new Map<string,LinkFormat>());
  const value = useMemo<PeopleContextValue>(()=>({profiles,mtprotoListener,webUnavailable:web.isError,readOnly,canResetQuota:!readOnly&&!!caps.data?.capabilities.quota,canToggle:!readOnly&&!!caps.data?.capabilities.user_enable_disable,formats,setFormat:(name,format)=>setFormats(prev=>new Map(prev).set(name,format)),listView}),[profiles,mtprotoListener,web.isError,formats,readOnly,caps.data,listView]);
  return <PeopleContext.Provider value={value}>{children}</PeopleContext.Provider>;
}
