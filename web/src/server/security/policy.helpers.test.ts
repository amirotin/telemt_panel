import { describe, expect, it } from "vitest";
import { policyDraft, policyPatch, rebasePolicyDraft, type PolicyDraft } from "./policy.helpers";
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

describe("CIDR conflict rebase",()=>{
 const A="192.0.2.0/24", B="198.51.100.0/24", C="203.0.113.0/24";
 const original=policyDraft({...policy,cidr_rate_limits:{[A]:{up_bps:1,down_bps:2},[B]:{up_bps:3,down_bps:4}}});
 const fresh=policyDraft({...policy,cidr_rate_limits:{[A]:{up_bps:1,down_bps:2},[B]:{up_bps:30,down_bps:40},[C]:{up_bps:5,down_bps:6}}});
 it("overlays only the local CIDR delta onto fresh rows",()=>{
  const next=rebasePolicyDraft(original,{...original,cidr_rate_limits:`${A} 10 20\n${B} 3 4`},fresh);
  expect(next.cidr_rate_limits).toBe(`${A} 10 20\n${B} 30 40\n${C} 5 6`);
  expect(policyPatch(fresh,next)).toEqual({cidr_rate_limits:{[A]:{up_bps:10,down_bps:20}}});
 });
 it("preserves deliberate per-key removals without deleting newly fetched rules",()=>{
  const next=rebasePolicyDraft(original,{...original,cidr_rate_limits:`${A} 1 2`},fresh);
  expect(next.cidr_rate_limits).toBe(`${A} 1 2\n${C} 5 6`);
  expect(policyPatch(fresh,next)).toEqual({cidr_rate_limits:{[B]:null}});
 });
 it("keeps explicit whole-map clear intent distinct from per-key merge",()=>{
  const next=rebasePolicyDraft(original,{...original,cidr_rate_limits:""},fresh);
  expect(next.cidr_rate_limits).toBe("");expect(policyPatch(fresh,next)).toEqual({cidr_rate_limits:null});
 });
 it("preserves freshly changed CIDRs when only a scalar was edited",()=>{
  const next=rebasePolicyDraft(original,{...original,user_max_unique_ips_global_each:"8"},fresh);
  expect(next.cidr_rate_limits).toBe(fresh.cidr_rate_limits);
  expect(policyPatch(fresh,next)).toEqual({user_max_unique_ips_global_each:8});
 });
 it("never resubmits untouched unsafe globals or CIDR bandwidths during rebase",()=>{
  const unsafe=policyDraft({...policy,cidr_rate_limits:{[A]:{up_bps:1,down_bps:2},[B]:{up_bps:9007199254740992,down_bps:4}}});
  const newer=policyDraft({...policy,cidr_rate_limits:{[A]:{up_bps:1,down_bps:2},[B]:{up_bps:9007199254740994,down_bps:40},[C]:{up_bps:5,down_bps:6}}});
  const next=rebasePolicyDraft(unsafe,{...unsafe,cidr_rate_limits:`${A} 10 20\n${B} 9007199254740992 4`},newer);
  expect(policyPatch(newer,next)).toEqual({cidr_rate_limits:{[A]:{up_bps:10,down_bps:20}}});
 });
});
