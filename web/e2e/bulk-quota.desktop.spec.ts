import {test,expect,openUsersSearch} from "./fixtures";
import {MOCK_URL} from "./env";

test("bulk quota reset confirms all accounts and survives browser reload",async({page,login},testInfo)=>{
  test.setTimeout(90000);
  expect(MOCK_URL).toBe("http://127.0.0.1:48190");
  let next=0;
  await Promise.all(Array.from({length:4},async()=>{
    while(next<2001){const i=next++;const response=await page.request.post(MOCK_URL+"/v1/users",{data:{username:`bulk-${String(i).padStart(4,"0")}`,data_quota_bytes:1500000,enabled:i%3!==0}});expect(response.status()).toBe(201);}
  }));
  await login();await page.setViewportSize({width:390,height:900});
  const before=await(await page.request.get("/api/users")).json();
  const total=before.length;
  await (await openUsersSearch(page)).fill("bulk-0001");
  await expect(page.getByTestId("user-card-bulk-0001")).toBeVisible();
  await page.getByRole("button",{name:"Действия со списком",exact:true}).click();
  await page.getByRole("button",{name:/Сбросить расход квот всем/}).click();
  const dialog=page.getByRole("dialog",{name:"Сброс расхода квот",exact:true});
  const confirmation=dialog.getByRole("checkbox");await expect(confirmation).toBeVisible();
  const body=await dialog.innerText();expect(body.replace(/\s/g,"")).toContain(`Всепользователи·${total}`);
  await expect(dialog.getByRole("button",{name:"Сбросить всем",exact:true})).toBeDisabled();
  await page.screenshot({path:testInfo.outputPath("confirmation-390.png")});
  await confirmation.check();await dialog.getByRole("button",{name:"Сбросить всем",exact:true}).click();
  await dialog.getByRole("button",{name:"Закрыть",exact:true}).click();
  await page.reload();
  const status=page.getByTestId("bulk-quota-status");await expect(status).toBeVisible();await status.click();
  await expect(dialog.getByRole("status")).toHaveText("Расход квот сброшен",{timeout:45000});
  const progress=await(await page.request.get("/api/users/operations/quota-reset")).json();
  expect(progress.operation).toMatchObject({total,confirmed:total,unknown:0,rejected:0,remaining:0,state:"completed"});
  await page.screenshot({path:testInfo.outputPath("result-390.png")});
  const after=await(await page.request.get("/api/users")).json();
  const pick=(data:typeof before)=>data.filter((u:{username:string})=>u.username.startsWith("bulk-")).map((u:{username:string;data_quota_bytes:number;enabled:boolean})=>({name:u.username,limit:u.data_quota_bytes,enabled:u.enabled})).sort((a:{name:string},b:{name:string})=>a.name.localeCompare(b.name));
  expect(pick(after)).toEqual(pick(before));
  const replay=await page.request.post("/api/users/operations/quota-reset",{headers:{"Sec-Fetch-Site":"same-origin"},data:{token:progress.operation.id}});expect(replay.status()).toBe(202);expect((await replay.json()).started_at).toBe(progress.operation.started_at);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
});
