import {test,expect,openUsersSearch} from "./fixtures";

test("reference user cards adapt without hiding data or expanding 2000 accounts into the DOM",async({page,login},testInfo)=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await login();
  const snapshot=await (await page.request.get("/api/snapshot?topics=users,stats")).json();
  const base=snapshot.users.users.find((user:{username:string})=>user.username==="alice");
  const secret="0123456789abcdef0123456789abcdef";
  base.links={classic:[],secure:[`tg://proxy?server=proxy.example.org&port=443&secret=dd${secret}`],tls:[`tg://proxy?server=proxy.example.org&port=443&secret=ee${secret}6578616d706c652e6f7267`],tls_domains:[]};
  const users=Array.from({length:2000},(_,i)=>({...base,username:i===0?"alice":`reference-${String(i).padStart(4,"0")}`,current_connections:2000-i,active_unique_ips:1000,expiration_rfc3339:"2015-10-03T00:00:00Z",data_quota_bytes:2048,traffic:{observed_total_bytes:8192,current_month_bytes:4096,month_key:202610,observed_since_epoch_secs:1,last_activity_epoch_secs:2,continuity:"normal"}}));
  snapshot.users={...snapshot.users,users,quota:Object.fromEntries(users.map(user=>[user.username,{used_bytes:1024,data_quota_bytes:2048,last_reset_epoch_secs:1}]))};
  await page.route("**/api/telemt/web-access",route=>route.fulfill({json:{revision:"test",enabled:true,vhosts:[{host:"web.example.org",public_addr:"198.51.100.1:443",profiles:[{user:"alice",secret_mode:"plain"}]}]}}));
  await page.route("**/api/events?*",route=>route.fulfill({contentType:"text/event-stream",body:"retry: 60000\n\n"+Object.entries(snapshot).map(([topic,v])=>`event: ${topic}\ndata: ${JSON.stringify({ts:Math.floor(Date.now()/1000),v})}\n\n`).join("")}));
  await page.goto("/people");
  for(const width of [320,390,768,1280,2560,3840]){
    await page.setViewportSize({width,height:900});
    const search=await openUsersSearch(page);await search.fill("");
    const row=page.locator('[data-user="alice"]');await expect(row).toBeVisible();
    await expect(row.locator(".user-avatar")).toHaveText("A");
    await expect(row.locator("[data-quota-fill]")).toHaveCSS("--quota-fill","50%");
    await expect(row.locator("[data-observed-traffic]")).toContainText("8.0 КБ");
    await expect(row.getByRole("button",{name:"Действия alice",exact:true})).toBeVisible();
    if(width===768)expect(await page.locator(".user-virtual-row").first().evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(" ").length)).toBe(2);
    const dimensions=await row.evaluate(node=>({width:node.clientWidth,height:node.clientHeight,faceWidth:node.querySelector(".user-row-face")!.scrollWidth,faceHeight:node.querySelector(".user-row-face")!.scrollHeight}));
    expect(dimensions.faceWidth).toBeLessThanOrEqual(dimensions.width+1);
    expect(dimensions.faceHeight).toBeLessThanOrEqual(dimensions.height+1);
    const traffic=await row.locator(".user-col-traffic").boundingBox();
    const connections=await row.locator(".user-col-now").boundingBox();
    if(width<1280)expect(connections!.y+connections!.height).toBeLessThanOrEqual(traffic!.y);
    if(width>=1280){
      const expiry=await row.locator(".user-expiry").boundingBox();
      const links=await row.locator(".user-copy-toolbar").boundingBox();
      expect(expiry!.x+expiry!.width).toBeLessThan(links!.x);
    }
    expect(await page.getByTestId("user-row").count()).toBeLessThan(40);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({path:testInfo.outputPath(`users-${width}.png`)});
    await search.fill("reference-1999");await expect(page.getByTestId("user-row")).toHaveCount(1);
    await expect(page.getByTestId("user-card-reference-1999")).toBeVisible();
    await search.fill("alice");
  }
  delete snapshot.users.quota.alice;
  await page.setViewportSize({width:320,height:900});await page.reload();
  const unknown=page.locator('[data-user="alice"]');
  await expect(unknown.locator("[data-quota-used]")).toHaveText("—");
  const boxes=await unknown.evaluate(node=>{
    const box=(selector:string)=>{const rect=node.querySelector(selector)!.getBoundingClientRect();return {top:rect.top,bottom:rect.bottom};};
    return {connections:box(".user-col-now"),traffic:box(".user-col-traffic"),actions:box(".user-row-actions")};
  });
  expect(boxes.connections.bottom).toBeLessThanOrEqual(boxes.traffic.top);
  expect(boxes.traffic.bottom).toBeLessThanOrEqual(boxes.actions.top);
  await page.setViewportSize({width:1280,height:900});
  await (await openUsersSearch(page)).fill("");
  await expect(page.getByRole("tab",{name:/^Все/})).toContainText("2 000");
  const scroll=page.locator(".people-list-scroll");
  await scroll.evaluate(node=>{node.scrollTop=50000;});
  const firstVisible=()=>scroll.evaluate(node=>{
    const top=node.getBoundingClientRect().top;
    return [...node.querySelectorAll<HTMLElement>("[data-user]")].find(row=>row.getBoundingClientRect().bottom>top)?.dataset["user"];
  });
  await expect.poll(firstVisible).toBe("reference-0510");
  for(const width of [768,390,1280]){
    await page.setViewportSize({width,height:900});
    await expect.poll(firstVisible).toBe("reference-0510");
  }
  await scroll.evaluate(node=>{node.scrollTop=195000;});
  await expect.poll(firstVisible).toBe("reference-1989");
  for(const width of [900,768,390,1280]){
    await page.setViewportSize({width,height:900});
    await expect(page.locator('[data-user="reference-1989"]')).toBeInViewport();
  }
  await page.setViewportSize({width:390,height:900});
  await expect(page.locator(".users-reference-list")).toHaveAttribute("data-layout","cards");
  await scroll.evaluate(node=>{node.scrollTop=510*260+200;});
  await expect.poll(firstVisible).toBe("reference-0510");
  await page.setViewportSize({width:1280,height:900});
  await expect.poll(firstVisible).toBe("reference-0510");
  expect(errors).toEqual([]);
});
