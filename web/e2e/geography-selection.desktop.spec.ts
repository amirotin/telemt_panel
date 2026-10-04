import { test, expect } from "./fixtures";
import { overview } from "../src/geography/testFixtures";

test("visual fixture supports country/point selection after expansion",async({page,login})=>{
 await login();const data=overview();
 await page.route("**/api/geography**",route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith("/locations"))return route.fulfill({json:{snapshot_id:data.snapshot_id,items:data.countries,total:1,next_cursor:null}});
   if(url.pathname.endsWith("/users"))return route.fulfill({json:{snapshot_id:data.snapshot_id,group_id:"city:DE:1",items:[],total:0,next_cursor:null}});
   return route.fulfill({json:{...data,selection:url.searchParams.has("location")?data.points[0]:null}});
 });
 await page.goto("/geography?range=7d");await expect(page.locator("[data-geo-point]")).toHaveCount(1);
 await page.getByRole("button",{name:"Развернуть",exact:true}).click();
 await page.getByRole("dialog").locator("[data-geo-point]").click();await expect(page).toHaveURL(/location=city%3ADE%3A1/);
 await page.keyboard.press("Escape");
});
