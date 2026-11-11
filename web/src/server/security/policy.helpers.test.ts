import { describe, expect, it } from "vitest";
import { policyDraft, policyPatch, type PolicyDraft } from "./policy.helpers";
import type { TelemtAccessPolicy } from "../../lib/api/generated/types.gen";

const policy: TelemtAccessPolicy = { user_max_tcp_conns_global_each: 9007199254740992, user_max_unique_ips_global_each: 4, user_max_unique_ips_mode: "active_window", user_max_unique_ips_window_secs: 30, cidr_rate_limits: {"192.0.2.0/24":{up_bps:1,down_bps:2},"::/0":{up_bps:3,down_bps:4}} };
describe("policy patches",()=>{
 it("omits untouched unsafe globals while editing IP mode",()=>{
  const base=policyDraft(policy);expect(policyPatch(base,{...base,user_max_unique_ips_mode:"combined"})).toEqual({user_max_unique_ips_mode:"combined"});
 });
 it("clears an intentionally empty map with null",()=>{
  const base=policyDraft(policy);expect(policyPatch(base,{...base,cidr_rate_limits:""})).toEqual({cidr_rate_limits:null});
 });
 it("merges CIDR edits and explicitly removes deleted keys",()=>{
  const base=policyDraft(policy);expect(policyPatch(base,{...base,cidr_rate_limits:"192.0.2.0/24 5 6"})).toEqual({cidr_rate_limits:{"192.0.2.0/24":{up_bps:5,down_bps:6},"::/0":null}});
 });
 it.each(["9007199254740993","-1","1.2", "1e3"])("rejects unsafe or ambiguous edited integers %s", value=>{
  const base=policyDraft(policy);expect(()=>policyPatch(base,{...base,user_max_unique_ips_global_each:value})).toThrow();
 });
 it("does not resubmit untouched unsafe CIDR values",()=>{
  const base=policyDraft({...policy,cidr_rate_limits:{"::/0":{up_bps:9007199254740992,down_bps:1},"192.0.2.0/24":{up_bps:2,down_bps:3}}});
  const draft:PolicyDraft={...base,cidr_rate_limits:base.cidr_rate_limits.replace("192.0.2.0/24 2 3","192.0.2.0/24 4 5")};
  expect(policyPatch(base,draft)).toEqual({cidr_rate_limits:{"192.0.2.0/24":{up_bps:4,down_bps:5}}});
 });
 it("rejects duplicate CIDRs",()=>{const base=policyDraft(policy);expect(()=>policyPatch(base,{...base,cidr_rate_limits:"::/0 1 2\n::/0 2 3"})).toThrow();});
});
