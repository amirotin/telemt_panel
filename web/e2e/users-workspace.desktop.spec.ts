import {test,expect,openUsersSearch} from "./fixtures";

for(const width of [390,1280]) {
  test(`user workspace preserves exact settings and dedicated navigation (${width}px)`,async({page,login},testInfo)=>{
    await login();await page.setViewportSize({width,height:1000});
    const username=width===390?"new":`form-${Date.now()}`;
    const created=await page.request.post("/api/users",{headers:{"Sec-Fetch-Site":"same-origin"},data:{username,secret:"0123456789abcdef0123456789abcdef",data_quota_bytes:1500000,max_tcp_conns:4}});
    expect(created.status()).toBe(201);
    try {
      await page.goto(`/people/${username}?tab=settings`);
      await expect(page.getByRole("heading",{name:username,exact:true})).toBeVisible();
      await expect(page.locator(".person-inspector-panel,.people-square-avatar")).toHaveCount(0);
      const field=page.locator(".user-inline-form").getByLabel("Макс. соединений",{exact:true});
      await expect(field).toHaveValue("4");await field.fill("13");
      await page.getByRole("button",{name:"Обзор",exact:true}).click();
      await expect(page.getByRole("dialog",{name:"Отменить изменения?"})).toBeVisible();
      await page.getByRole("button",{name:"Остаться",exact:true}).click();await expect(field).toHaveValue("13");
      const patch=page.waitForRequest(r=>r.method()==="PATCH"&&new URL(r.url()).pathname===`/api/users/${username}`);
      await page.getByTestId("user-form-submit").click();
      const request=await patch;expect(request.postDataJSON()).toEqual({max_tcp_conns:13});
      await expect(page.getByRole("button",{name:"Обзор",exact:true})).toHaveAttribute("aria-current","page");
      const saved=await (await page.request.get(`/api/users/${username}`)).json();
      expect(saved.data_quota_bytes).toBe(1500000);expect(saved.max_tcp_conns).toBe(13);
      await page.screenshot({path:testInfo.outputPath("person-overview.png"),fullPage:true});
      await page.getByRole("link",{name:"Назад",exact:true}).click();
      await (await openUsersSearch(page)).fill(username);
      await page.getByTestId(`user-card-${username}`).click();await expect(page.getByRole("heading",{name:username,exact:true})).toBeVisible();
      await page.goBack();await expect(page.getByPlaceholder("Поиск по имени")).toHaveValue(username);
    }finally{await page.request.delete(`/api/users/${username}`,{headers:{"Sec-Fetch-Site":"same-origin"}});}
  });

  test(`real API-shaped link choices and phone actions (${width}px)`,async({page,login},testInfo)=>{
    await login();await page.setViewportSize({width,height:1000});
    await page.context().grantPermissions(["clipboard-read","clipboard-write"]);
    const secret="0123456789abcdef0123456789abcdef";
    const proxy=(prefix:string,domain="")=>`tg://proxy?server=proxy.example.org&port=443&secret=${prefix}${secret}${Buffer.from(domain).toString("hex")}`;
    const primary=proxy("ee","main.example.org"),extra=proxy("ee","cdn.example.net");
    await page.route("**/api/telemt/web-access",route=>route.fulfill({json:{revision:"test",enabled:true,vhosts:[{host:"web.example.org",public_addr:"198.51.100.1:443",profiles:[{user:"alice",secret_mode:"plain"},{user:"alice",secret_mode:"dd"}]}]}}));
    // Supply a bounded, contract-shaped SSE snapshot; writes in the other
    // test use the real panel and mock Telemt unchanged.
    await page.route("**/api/events?*",async route=>{
      const snapshot=await (await page.request.get("/api/snapshot?topics=users,stats")).json();
      const alice=snapshot.users.users.find((u:{username:string})=>u.username==="alice");
      alice.links={classic:[proxy("")],secure:[proxy("dd")],tls:[primary,extra],tls_domains:[{domain:"cdn.example.net",link:extra}]};
      const ts=Math.floor(Date.now()/1000);
      await route.fulfill({contentType:"text/event-stream",body:"retry: 60000\n\n"+Object.entries(snapshot).map(([topic,v])=>`event: ${topic}\ndata: ${JSON.stringify({ts,v})}\n\n`).join("")});
    });
    await page.goto("/people");await (await openUsersSearch(page)).fill("alice");
    const row=page.locator('[data-user="alice"]');
    const format=row.getByRole("button",{name:/^Формат ссылок alice:/});
    await expect(format).toBeVisible();await format.click();
    await row.getByRole("button",{name:"Копировать EE · alice",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(primary.replace("tg://proxy?","https://t.me/proxy?"));
    await row.getByRole("button",{name:"Копировать WEB · alice",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(`tg://webproxy?server=web.example.org&secret=${secret}`);
    await expect(row.getByRole("button",{name:/Копировать Classic/})).toHaveCount(0);
    if(width<=650){
      const cdp=await page.context().newCDPSession(page);
      const b=await row.boundingBox();expect(b).not.toBeNull();const x=b!.x+b!.width-12,y=b!.y+24;
      await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y}]});
      for(let i=1;i<=8;i++){await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x:x-i*15,y}]});await page.waitForTimeout(16);}
      await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
      await expect(row).toHaveAttribute("data-swipe","left");await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.waitForTimeout(200);await page.screenshot({path:testInfo.outputPath("quota-swipe.png")});
      await page.keyboard.press("Escape");
    }
    await page.getByTestId("user-card-alice").click();await page.getByRole("button",{name:"Доступ",exact:true}).click();
    await expect(page.getByRole("combobox",{name:"Адрес / домен / профиль",exact:true})).toBeVisible();
    const options=page.getByRole("combobox",{name:"Адрес / домен / профиль",exact:true});
    await expect(options.locator("option")).toHaveCount(2);await expect(options).toHaveValue(primary);
    await page.screenshot({path:testInfo.outputPath("user-access.png"),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  });
}
