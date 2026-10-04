import { test, expect } from "./fixtures";

test.use({launchOptions:{args:["--use-angle=swiftshader","--enable-unsafe-swiftshader"]}});

test("map/globe themes and expanded lifecycle stay within viewport bounds",async({page,login})=>{
  test.setTimeout(90000);const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await login();await page.goto("/geography?range=7d");
  for(const width of [320,390,768,1440,2560]){
    await page.setViewportSize({width,height:900});await expect(page.locator(".geo-vector")).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),String(width)).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({width:1280,height:900});
  for(let i=0;i<20;i++){
    await page.getByRole("button",{name:"Глобус",exact:true}).click();
    await expect(page.locator(".geo-globe canvas")).toBeVisible();
    expect(await page.locator(".geo-globe canvas").count()).toBe(1);
    if(i===0){await page.getByRole("button",{name:"Развернуть",exact:true}).click();await expect(page.getByRole("dialog").locator("canvas")).toHaveCount(1);await page.keyboard.press("Escape");}
    await page.getByRole("button",{name:"Карта",exact:true}).click();await expect(page.locator(".geo-globe canvas")).toHaveCount(0);
  }
  await page.getByRole("button",{name:"Глобус",exact:true}).click();await expect(page.locator(".geo-globe canvas")).toBeVisible();
  await page.locator(".geo-globe canvas").evaluate(canvas=>{const gl=(canvas as HTMLCanvasElement).getContext("webgl2");gl?.getExtension("WEBGL_lose_context")?.loseContext()});
  await expect(page.locator(".geo-banner").filter({hasText:"3D недоступен. Открыта SVG-карта."})).toBeVisible();
  await expect(page.locator(".geo-vector")).toBeVisible();expect(errors).toEqual([]);
});
