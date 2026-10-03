import {spawn,execFileSync,type ChildProcess} from "node:child_process";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {createServer,type AddressInfo} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";
import {test,expect} from "./fixtures";
import {ADMIN_PASSWORD,ADMIN_USERNAME,MOCK_URL} from "./env";
import {PANEL_BINARY,killAndWait} from "./stack";

test("secret panel prefix survives all navigation and WEB profile link; log failures are actionable",async({page},testInfo)=>{
  test.setTimeout(90000);
  const reservation=createServer();
  await new Promise<void>((resolve,reject)=>{reservation.once("error",reject);reservation.listen(0,"127.0.0.1",resolve);});
  const {port}=reservation.address() as AddressInfo;
  await new Promise<void>((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
  const directory=await mkdtemp(path.join(tmpdir(),"panel-prefix-"));
  const config=path.join(directory,"panel.toml"),prefix="/secret-panel",origin=`http://localhost:${port}`,base=origin+prefix;
  const missingLog=path.join(directory,"not-created.log");
  const passwordHash=execFileSync(PANEL_BINARY,["hash-password"],{input:ADMIN_PASSWORD+"\n",encoding:"utf8",timeout:10000}).trim();
  let child:ChildProcess|undefined,logs="";
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  try{
    await writeFile(config,[`listen = "127.0.0.1:${port}"`,`base_path = "${prefix}"`,`data_dir = "${path.join(directory,"state")}"`,"[auth]",`username = "${ADMIN_USERNAME}"`,`password_hash = "${passwordHash}"`,"[telemt]",`url = "${MOCK_URL}"`,"[store]",'driver = "memory"',"[host]",'service_manager = "none"','log_source = "file"',`log_file = "${missingLog}"`,"[privileges]",'mode = "manual"',""].join("\n"),{mode:0o600});
    child=spawn(PANEL_BINARY,["--config",config],{stdio:["ignore","ignore","pipe"]});
    child.stderr?.on("data",chunk=>{logs=(logs+chunk.toString()).slice(-32000);});
    await expect.poll(async()=>{if(child!.exitCode!==null||child!.signalCode!==null)throw new Error(logs);try{return (await fetch(base+"/api/health",{signal:AbortSignal.timeout(1000)})).status;}catch{return 0;}},{timeout:10000}).toBe(200);
    await page.goto(base+"/login");
    await page.getByLabel("Имя пользователя").fill(ADMIN_USERNAME);
    await page.getByLabel("Пароль",{exact:true}).fill(ADMIN_PASSWORD);
    await page.getByRole("button",{name:"Войти",exact:true}).click();
    await expect(page).toHaveURL(base+"/people");
    for(const width of [390,1280]){
      await page.setViewportSize({width,height:900});
      for(const route of ["/overview","/people","/pulse","/journal","/server","/server/config","/server/settings","/web"]){
        await page.goto(base+route);await expect(page.locator("main h1")).toBeVisible();
        const wrong=await page.locator("a[href]").evaluateAll((links,{origin,prefix})=>links.map(link=>(link as HTMLAnchorElement).href).filter(href=>{const url=new URL(href);return url.origin===origin&&!url.pathname.startsWith(prefix+"/")&&url.pathname!==prefix;}),{origin,prefix});
        expect(wrong,route).toEqual([]);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),route).toBeLessThanOrEqual(1);
      }
    }
    await page.goto(base+"/server/config");
    await page.getByRole("button",{name:/^WEB transport/}).click();
    const users=page.locator("main").getByRole("link",{name:/Открыть.*Пользователи/});
    if(!await users.isVisible())await page.getByRole("button",{name:"Добавить виртуальный хост",exact:true}).click();
    await expect(users).toHaveAttribute("href",prefix+"/people");
    page.on("dialog",dialog=>void dialog.accept());
    await users.click();await expect(page).toHaveURL(base+"/people");
    await page.goto(base+"/journal");
    const notice=page.getByRole("alert");
    await expect(notice).toContainText("Файл журнала не найден");
    await expect(notice).toContainText(missingLog);
    await expect(notice.getByRole("button")).toBeVisible();
    await page.screenshot({path:testInfo.outputPath("prefixed-log-error.png")});
    expect(errors).toEqual([]);
  }finally{
    if(child?.pid)await killAndWait(child);
    if(testInfo.status!==testInfo.expectedStatus)await testInfo.attach("prefixed-panel.log",{body:logs,contentType:"text/plain"});
    await rm(directory,{recursive:true,force:true});
  }
});
