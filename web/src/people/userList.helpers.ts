import type {UsersTopicQuotaEntry,UsersTopicUser} from "../realtime/topics";
import {getUserQuota} from "./users.helpers";

export function userListSummary(users:readonly UsersTopicUser[],quota:Record<string,UsersTopicQuotaEntry>|null) {
  let connections=0,monthBytes:number|null=0,nearQuota=0;
  for(const user of users){
    connections+=user.current_connections;
    if(!user.traffic)monthBytes=null;
    else if(monthBytes!==null)monthBytes+=user.traffic.current_month_bytes;
    const {usedBytes,limitBytes}=getUserQuota(user,quota?.[user.username]);
    if(usedBytes!==null&&limitBytes!==null&&usedBytes>=limitBytes*.85&&usedBytes<limitBytes)nearQuota++;
  }
  return {connections,monthBytes,nearQuota};
}
