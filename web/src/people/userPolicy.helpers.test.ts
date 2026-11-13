import { expect,it } from "vitest";
import { buildUserCreateBody, buildUserPatch, keepAllPatchFields } from "./buildUserPatch";
import { configuredUserLimit, sourceDenyPatch, sourceDenyLines } from "./userPolicy.helpers";
it("explicitly clears retained denies on supported new-user create, omits them on legacy",()=>{
 const form={username:"alice",secret:"",enabled:true};expect(buildUserCreateBody({...form,sourceDeny:[]})).toEqual({...form,source_deny:[]});expect(buildUserCreateBody(form)).not.toHaveProperty("source_deny");
});
it("preserves omitted, empty and reset patch distinctions",()=>{
 expect(buildUserPatch({...keepAllPatchFields(),sourceDeny:{mode:"keep"}})).not.toHaveProperty("source_deny");
 expect(buildUserPatch({...keepAllPatchFields(),sourceDeny:{mode:"set",value:[]}})).toEqual({source_deny:[]});
 expect(buildUserPatch({...keepAllPatchFields(),sourceDeny:{mode:"clear"}})).toEqual({source_deny:null});
 expect(sourceDenyPatch("",["::/0"])).toEqual({mode:"set",value:[]});expect(sourceDenyPatch("::/0",["::/0"])).toEqual({mode:"keep"});
});
it("uses configured override rather than inherited resolved value to seed and diff forms",()=>{
 expect(configuredUserLimit({max_tcp_conns:7,limits:{desired:{max_tcp_conns:{value:7,configured_override:0,global_value:7,origin:"global_default"}}}} as never,"max_tcp_conns")).toBeUndefined();
 expect(configuredUserLimit({max_tcp_conns:7} as never,"max_tcp_conns")).toBe(7);
});
it("parses newline separated deny rules",()=>{expect(sourceDenyLines(" ::/0\n\n192.0.2.0/24 ")).toEqual(["::/0","192.0.2.0/24"]);});
