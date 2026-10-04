import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { getGeographySettingsQueryKey } from "../lib/api/generated/@tanstack/react-query.gen";
import { GeographySettings } from "./GeographySettings";
import { client as apiClient } from "../lib/api/client";

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

it("allows retrying a failed settings request and restores the form",async()=>{
  const config=apiClient.getConfig();let attempts=0;
  apiClient.setConfig({baseUrl:"http://localhost",fetch:async()=>++attempts===1?Response.json({code:"internal_error"},{status:500}):Response.json({server_location:{mode:"hidden",label:"",public_ip:null,latitude:null,longitude:null}})});
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  try{
    await act(async()=>{root.render(<QueryClientProvider client={client}><GeographySettings/></QueryClientProvider>)});
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30))});
    const retry=Array.from(container.querySelectorAll("button")).find(button=>button.textContent==="Повторить");
    expect(retry).toBeDefined();
    await act(async()=>{retry!.click();await new Promise(resolve=>setTimeout(resolve,30))});
    expect(container.querySelector("form")).not.toBeNull();
    expect(container.querySelector("input[maxlength='80']")).not.toBeNull();
  }finally{act(()=>root.unmount());container.remove();client.clear();apiClient.setConfig(config)}
});
