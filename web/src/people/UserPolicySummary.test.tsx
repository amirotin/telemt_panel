import { renderToStaticMarkup } from "react-dom/server";
import { expect,it,vi } from "vitest";
import { UserPolicySummary } from "./UserPolicySummary";
import { ru } from "../i18n/testing";
vi.mock("@tanstack/react-router",()=>({Link:({children}:{children:React.ReactNode})=><a>{children}</a>}));
it.each([true,false,null])("distinguishes deny publication status %s",required=>{
 const output=renderToStaticMarkup(<UserPolicySummary user={{source_deny:["::/0"],source_deny_status:{effective:required===null?null:[],runtime_reload_required:required,apply_mode:"generation_reload",reload_endpoint:"POST /v1/system/reload",effective_scope:"request_generation_snapshot"}}}/>);
 expect(output).toContain(required===null?ru.accessPolicy.reloadUnknown:required?ru.accessPolicy.reloadRequired:ru.accessPolicy.reloadCurrent);
 if(required!==false)expect(output).toContain(ru.accessPolicy.reloadLink);
});
it("preserves unlimited and inherited provenance with unknown effective limits",()=>{
 const limit={value:7,configured_override:0,global_value:7,origin:"global_default" as const};
 const output=renderToStaticMarkup(<UserPolicySummary user={{limits:{desired:{max_tcp_conns:limit,max_unique_ips:{...limit,value:null,global_value:0,origin:"unlimited"}},effective:null,effective_scope:"active_config_snapshot",subsystem_convergence:"unknown"}}}/>);
 expect(output).toContain(ru.accessPolicy.inherited);expect(output).toContain(ru.accessPolicy.unlimited);expect(output).toContain(ru.accessPolicy.unknown);
});
