import { test, expect } from "./fixtures";

const pages = [
  "/overview", "/people", "/journal", "/pulse", "/server",
  "/server/settings", "/server/config", "/server/platform", "/server/security", "/server/updates",
  "/pulse/diag/connections", "/pulse/diag/dc", "/pulse/diag/me", "/pulse/diag/upstreams",
  "/pulse/diag/nat", "/pulse/diag/security", "/pulse/diag/events", "/pulse/diag/counters",
  "/web", "/people/alice", "/people?create=true", "/people?schedule=true",
  "/people/a-very-long-user-name-that-must-wrap-without-covering-page-actions-or-navigation",
];

for (const locale of ["ru", "en"] as const) {
  test.describe(locale, () => {
    test.use({ uiLocale: locale });
    test(`page headings share typography, alignment and responsive actions (${locale})`, async ({ page, login }, testInfo) => {
      test.setTimeout(180_000);
      await login();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      for (const width of [390, 768, 1280, 2560]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of pages) {
          await page.goto(path);
          const heading = page.locator("main h1");
          await expect(heading, path).toHaveCount(1);
          if (path === "/overview") await expect(heading).toHaveText(locale === "ru" ? "Сводка" : "Overview");
          await expect(heading, path).toHaveCSS("font-size", width < 768 ? "22px" : "26px");
          await expect(heading, path).toHaveCSS("font-weight", "800");
          const header = page.getByTestId("page-header");
          await expect(header, path).toBeVisible();
          await expect(header, path).not.toContainText(/Загрузка|Loading/);
          if (path === "/people") await expect(page.getByTestId("user-card-alice")).toBeVisible();
          await expect(header, path).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
          // Async detail data can replace its skeleton header between two
          // locator calls. Measure one attached header atomically instead.
          await expect(async()=>{
            const geometry=await header.evaluate(element=>{
              const title=element.querySelector("h1");
              const box=element.getBoundingClientRect();
              if(!element.isConnected||!title||box.width===0)return null;
              return {x:box.x,width:box.width,titleX:title.getBoundingClientRect().x,clipping:[...element.querySelectorAll("h1, button, a")].some(child=>{const rect=child.getBoundingClientRect();return rect.width>0&&(rect.left<box.left-1||rect.right>box.right+1);})};
            });
            expect(geometry,path).not.toBeNull();
            expect(Math.abs(geometry!.titleX-geometry!.x),path).toBeLessThan(1);
            expect(geometry!.x,path).toBe(width>=1180?256:width>=600?80:16);
            expect(geometry!.x+geometry!.width,path).toBeLessThanOrEqual(width-15);
            expect(geometry!.clipping,path).toBe(false);
          }).toPass({timeout:5000});
          expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), path).toBeLessThanOrEqual(1);
          if (["/overview", "/people", "/journal", "/pulse/diag/connections", "/server/settings"].includes(path)) {
            await page.screenshot({ path: testInfo.outputPath(`${path.replaceAll("/", "-")}-${width}.png`) });
          }
        }
      }
      expect(errors).toEqual([]);
    });
  });
}
