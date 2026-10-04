import { test, expect } from "./fixtures";

test("geography has a distinct More entry and one expandable renderer host",async({page,login})=>{
  await login();const nav=page.getByTestId("mobile-bottom-nav");
  await expect(nav.getByRole("link")).toHaveCount(4);
  await nav.getByRole("button",{name:"Ещё",exact:true}).click();
  await page.getByRole("dialog").getByRole("menuitem",{name:"География",exact:true}).click();
  await expect(page.locator(".geo-vector")).toBeVisible();
  await expect(nav.getByRole("button",{name:"Ещё",exact:true})).toHaveClass(/text-accent/);
  const expand=page.getByRole("button",{name:"Развернуть",exact:true});await expand.click();
  await expect(page.getByRole("dialog").locator("[data-geography-renderer]")).toHaveCount(1);
  expect(await page.locator("[data-geography-renderer]").count()).toBe(1);
  await expect(page.getByRole("dialog").getByRole("button",{name:"Приблизить",exact:true})).toBeVisible();
  await page.keyboard.press("Escape");await expect(page.getByRole("dialog")).toHaveCount(0);await expect(expand).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
});
