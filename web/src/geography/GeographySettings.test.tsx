import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { getGeographySettingsQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import { GeographySettings } from "./GeographySettings";

it("starts hidden and keeps the configured position separate from the editable draft",async()=>{
  const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity,retry:false}}});
  client.setQueryData(getGeographySettingsQueryKey(),{server_location:{mode:"hidden",label:"",public_ip:null,latitude:null,longitude:null}});
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  try {await act(async()=>root.render(<QueryClientProvider client={client}><GeographySettings/></QueryClientProvider>));
    expect(container.textContent).toContain("Положение сервера Telemt");
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(client.getQueryData(getGeographySettingsQueryKey())).toEqual({server_location:{mode:"hidden",label:"",public_ip:null,latitude:null,longitude:null}});
  }finally{act(()=>root.unmount());client.clear();container.remove();}
});
