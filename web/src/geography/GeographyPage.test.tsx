import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { getGeographyQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import { overview } from "./testFixtures";
import { GeographyView } from "./GeographyPage";

it.each(["unavailable","empty"] as const)("distinguishes %s from a measured zero",async(state)=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  const data=overview({state,totals:state==="unavailable"?null:{unique_ips:0,accounts:0,country_count:0,location_count:0},quality:null,countries:[],points:[]});
  client.setQueryData(getGeographyQueryKey({query:{range:"now",family:"all"}}),data);
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  try{await act(async()=>root.render(<QueryClientProvider client={client}><GeographyView search={{range:"now",family:"all",country:null,location:null,view:"map"}} onSearch={()=>{}}/></QueryClientProvider>));
    expect(container.querySelector('[data-geography-stat="ips"]')?.textContent).toContain(state==="unavailable"?"—":"0");
    expect(container.textContent).toContain(state==="unavailable"?"Источник пока недоступен":"В выбранном периоде IP не наблюдались");
  }finally{act(()=>root.unmount());client.clear();container.remove();}
});

it("keeps lower-bound disclosure for an incomplete empty observation",async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});const data=overview({state:"empty",totals:{unique_ips:0,accounts:0,country_count:0,location_count:0},points:[],countries:[]});data.source.partial=true;
  client.setQueryData(getGeographyQueryKey({query:{range:"now",family:"all"}}),data);const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  try{await act(async()=>root.render(<QueryClientProvider client={client}><GeographyView search={{range:"now",family:"all",country:null,location:null,view:"map"}} onSearch={vi.fn()}/></QueryClientProvider>));expect(container.textContent).toContain("нижняя граница");expect(container.textContent).not.toContain("В выбранном периоде IP не наблюдались");}finally{act(()=>root.unmount());container.remove();client.clear()}
});
