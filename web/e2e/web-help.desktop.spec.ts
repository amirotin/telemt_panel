import { expect, test } from "./fixtures";

test("WEB help is hoverable, keyboard-accessible and stays inside the desktop viewport", async ({page,login}) => {
  await login();
  await page.goto("/pulse/diag/web");
  const help=page.getByRole("button",{name:"Что означают срабатывания лимитов",exact:true});
  const tooltip=page.getByRole("tooltip");
  await expect(help).toBeVisible();
  await expect(tooltip).toHaveCount(0);
  await help.hover();
  await expect(tooltip).toBeVisible();
  await tooltip.hover();
  await expect(tooltip).toBeVisible();
  const box=await tooltip.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x+box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await page.keyboard.press("Tab");
  await help.focus();
  await expect(tooltip).toBeVisible();
  await help.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await expect(help).toBeFocused();
});

test.describe("touch help",()=>{
  test.use({hasTouch:true,isMobile:true,viewport:{width:390,height:844}});
  test("opens and closes on tap without trapping page scrolling or moving the layout",async({page,login})=>{
    await login();
    await page.goto("/pulse/diag/web");
    const help=page.getByRole("button",{name:"Что означают срабатывания лимитов",exact:true});
    const tooltip=page.getByRole("tooltip");
    await expect(help).toBeVisible();
    const before=await page.getByTestId("web-vitals").boundingBox();
    await help.tap();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("не означает перегрузку");
    expect(await page.getByTestId("web-vitals").boundingBox()).toMatchObject({width:before!.width,height:before!.height});
    const box=await tooltip.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x+box!.width).toBeLessThanOrEqual(390);
    await tooltip.tap();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(tooltip).toHaveCount(0);
    await help.tap();
    await expect(tooltip).toBeVisible();
    await help.tap();
    await expect(tooltip).toHaveCount(0);
    await help.tap();
    await expect(tooltip).toBeVisible();
    await page.touchscreen.tap(5,5);
    await expect(tooltip).toHaveCount(0);
    expect(await page.evaluate(()=>document.body.style.overflow)).not.toBe("hidden");
  });
});
