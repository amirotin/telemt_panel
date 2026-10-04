import {describe,it,expect} from "vitest";
import {collectConnectionLinks,formatConnectionLink,webProfileIndex} from "./connectionLinks";
import type {UserLinksWire} from "../realtime/topics";
const secret="0123456789abcdef0123456789abcdef";
const hex=(value:string)=>[...new TextEncoder().encode(value)].map(b=>b.toString(16).padStart(2,"0")).join("");
const link=(prefix="",host="proxy.example.org",domain="")=>`tg://proxy?${new URLSearchParams({server:host,port:"443",secret:prefix+secret+(domain?hex(domain):"")})}`;
const links=(override:Partial<UserLinksWire>={}):UserLinksWire=>({classic:[],secure:[],tls:[],tls_domains:[],...override});

describe("connection link projection",()=>{
  it("keeps primary TLS, extra domains and multiple endpoints without duplication",()=>{
    const primary=link("ee","proxy.example.org","main.example.org"),extra=link("ee","proxy.example.org","extra.example.org"),other=link("ee","198.51.100.4","main.example.org");
    const result=collectConnectionLinks(links({tls:[primary,extra,other],tls_domains:[{domain:"extra.example.org",link:extra}]}));
    expect(result).toHaveLength(3);expect(result.filter(l=>l.primary)).toHaveLength(1);expect(result[0]?.domain).toBe("main.example.org");expect(result[2]?.endpoint).toBe("198.51.100.4:443");
  });
  it("keeps all secure/classic entries",()=>{
    expect(collectConnectionLinks(links({secure:[link("dd"),link("dd","198.51.100.2")],classic:[link(),link("","198.51.100.3")]}))).toHaveLength(4);
  });
  it("does not replace a malformed primary with another variant",()=>{
    const result=collectConnectionLinks(links({tls:["invalid",link("ee","p.example","mask.example")]}));expect(result).toHaveLength(1);expect(result[0]?.primary).toBe(false);
  });
  it("preserves query fields in the t.me representation",()=>{
    const l=collectConnectionLinks(links({secure:[link("dd")+"&comment=alice%20phone"]}))[0]!;
    const tg=new URL(l.url),tme=new URL(formatConnectionLink(l,"tme"));expect(tme.origin).toBe("https://t.me");expect(tme.search).toBe(tg.search);
  });
  it("derives WEB from a validated TLS-only secret and preserves profile order",()=>{
    const result=collectConnectionLinks(links({tls:[link("ee","p.example","mask.example")]}),[{host:"web.example",mode:"plain"},{host:"web.example",mode:"dd"}]).filter(l=>l.kind==="web");
    expect(result.map(l=>l.profileMode)).toEqual(["plain","dd"]);expect(result.map(l=>l.primary)).toEqual([true,false]);
    const u=new URL(result[0]!.url);expect(u.hostname).toBe("webproxy");expect(u.searchParams.get("secret")).toBe(secret);expect(u.searchParams.has("port")).toBe(false);expect(u.searchParams.has("comment")).toBe(false);
    expect(formatConnectionLink(result[0]!,"tme")).toBe(result[0]!.url);
  });
  it("does not invent a WEB secret or generate a link for conflicting secrets",()=>{
    const profiles=[{host:"web.example",mode:"dd" as const}];
    expect(collectConnectionLinks(links(),profiles)).toEqual([]);
    const conflict=link("dd").replace(secret,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(collectConnectionLinks(links({classic:[link()],secure:[conflict]}),profiles).some(l=>l.kind==="web")).toBe(false);
  });
  it.each(["classic", "secure", "tls", "tls_domains"] as const)("rejects non-hex %s secrets before deriving plain or path-mounted WEB links",kind=>{
    const raw=link(kind==="classic"?"":kind==="secure"?"dd":"ee","proxy.example.org",kind==="tls"||kind==="tls_domains"?"mask.example.org":"").replace(secret,"gg"+secret.slice(2));
    const original=kind==="tls_domains"?links({tls_domains:[{domain:"mask.example.org",link:raw}]}):links({[kind]:[raw]});
    const profiles=[{host:"web.example.org",mode:"plain" as const},{host:"web.example.org",mode:"dd" as const,basePath:"MixedCase/relay"}];
    expect(collectConnectionLinks(original,profiles)).toEqual([]);
  });
  it.each(["classic", "secure", "tls", "tls_domains"] as const)("accepts uppercase %s secrets for plain and path-mounted WEB links",kind=>{
    const raw=link(kind==="classic"?"":kind==="secure"?"dd":"ee","proxy.example.org",kind==="tls"||kind==="tls_domains"?"mask.example.org":"").replace(secret,secret.toUpperCase());
    const original=kind==="tls_domains"?links({tls_domains:[{domain:"mask.example.org",link:raw}]}):links({[kind]:[raw]});
    const profiles=[{host:"web.example.org",mode:"plain" as const},{host:"web.example.org",mode:"dd" as const,basePath:"MixedCase/relay"}];
    expect(collectConnectionLinks(original,profiles).filter(link=>link.kind==="web").map(link=>link.url)).toEqual([
      "tg://webproxy?server=web.example.org&secret=0123456789abcdef0123456789abcdef",
      "tg://webproxy?server=web.example.org%2FMixedCase%2Frelay&secret=cN0BI0VniavN7wEjRWeJq83v",
    ]);
  });
  it.each(["javascript:alert(1)","tg://resolve?domain=example",`https://evil.example/proxy?server=h&port=443&secret=${secret}`,link()+"&secret="+secret,link().replace("port=443","port=0"),link().replace("port=443","port=65536"),link("ee","p.example","mask.example").slice(0,-1)])("rejects invalid or unrelated proxy URLs: %s",raw=>{
    expect(collectConnectionLinks(links({classic:[raw],tls:[raw]}))).toEqual([]);
  });
  it("indexes only enabled WEB and keeps each account's own profiles",()=>{
    const view={revision:"r",enabled:true,vhosts:[{host:"a.example",public_addr:"198.51.100.1:443",profiles:[{user:"alice",secret_mode:"plain" as const},{user:"bob",secret_mode:"dd" as const}]},{host:"b.example",public_addr:"198.51.100.2:443",profiles:[{user:"alice",secret_mode:"dd" as const}]}]};
    expect(webProfileIndex(view).get("alice")).toEqual([{host:"a.example",mode:"plain"},{host:"b.example",mode:"dd"}]);expect(webProfileIndex({...view,enabled:false}).size).toBe(0);
  });

  it("preserves a WEB vhost's exact case-sensitive path in the account projection",()=>{
    const view={revision:"r",enabled:true,vhosts:[{host:"web.example.org",base_path:"MixedCase/relay",public_addr:"203.0.113.1:443",profiles:[{user:"alice",secret_mode:"dd" as const}]}]};
    expect(webProfileIndex(view).get("alice")).toEqual([{host:"web.example.org",basePath:"MixedCase/relay",mode:"dd"}]);
  });

  it.each([
    ["plain","cAABAgMEBQYHCAkKCwwNDg8"],
    ["dd","cN0AAQIDBAUGBwgJCgsMDQ4P"],
  ] as const)("matches Telemt 3.5.8's path-aware WEB %s reference vector",(mode,encoded)=>{
    const original=links({classic:["tg://proxy?server=proxy.example.com&port=443&secret=000102030405060708090a0b0c0d0e0f"]});
    const profiles=webProfileIndex({revision:"r",enabled:true,vhosts:[{host:"proxy.example.com",base_path:"dobry-cola/super_app",public_addr:"203.0.113.1:443",profiles:[{user:"alice",secret_mode:mode}]}]});
    const web=collectConnectionLinks(original,profiles.get("alice")).find(link=>link.kind==="web")!;
    expect(web.url).toBe(`tg://webproxy?server=proxy.example.com%2Fdobry-cola%2Fsuper_app&secret=${encoded}`);
    expect(web.endpoint).toBe("proxy.example.com/dobry-cola/super_app");
    expect(formatConnectionLink(web,"tme")).toBe(web.url);
  });

  it.each(["/relay","relay/","relay//app","relay%2Fapp","../relay","_relay","пути","relay?other", "a".repeat(129)])("does not generate a WEB link for invalid path %s",base_path=>{
    const profiles=webProfileIndex({revision:"r",enabled:true,vhosts:[{host:"proxy.example.com",base_path,public_addr:"203.0.113.1:443",profiles:[{user:"alice",secret_mode:"plain"}]}]});
    expect(collectConnectionLinks(links({classic:[link()]}),profiles.get("alice")).filter(link=>link.kind==="web")).toEqual([]);
  });
});
