import {describe,expect,it} from "vitest";
import type {UsersTopicUser} from "../realtime/topics";
import {userListSummary} from "./userList.helpers";

const alice:UsersTopicUser={username:"alice",enabled:true,in_runtime:true,current_connections:2,active_unique_ips:1,active_unique_ips_list:[],recent_unique_ips:0,recent_unique_ips_list:[],total_octets:999999,links:{classic:[],secure:[],tls:[],tls_domains:[]},traffic:{observed_total_bytes:2000,current_month_bytes:500,month_key:202610,observed_since_epoch_secs:1,last_activity_epoch_secs:2,continuity:"normal"}};
describe("userListSummary",()=>{
  it("counts near quotas only from known usage, excluding exhausted and unlimited quotas",()=>{
    const users=[alice,{...alice,username:"bob",current_connections:0},{...alice,username:"carol"},{...alice,username:"dave"},{...alice,username:"unlimited"}];
    const quota={alice:{used_bytes:85,data_quota_bytes:100,last_reset_epoch_secs:0},bob:{used_bytes:100,data_quota_bytes:100,last_reset_epoch_secs:0},carol:{used_bytes:84,data_quota_bytes:100,last_reset_epoch_secs:0},unlimited:{used_bytes:500,data_quota_bytes:0,last_reset_epoch_secs:0}};
    expect(userListSummary(users,quota)).toEqual({connections:8,monthBytes:2500,nearQuota:1});
  });
  it("does not fabricate a complete monthly total if one user lacks traffic history",()=>{
    expect(userListSummary([alice,{...alice,username:"missing",traffic:undefined}],null)).toEqual({connections:4,monthBytes:null,nearQuota:0});
  });
  it("keeps an empty dataset at zero",()=>{
    expect(userListSummary([],null)).toEqual({connections:0,monthBytes:0,nearQuota:0});
  });
});
