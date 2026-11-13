import { test, expect } from "./fixtures";

// The legacy built-stack fixture has no .17 endpoint. Only the new policy
// reads/writes are supplied here; navigation, authentication and layout use
// the built panel. SDK forwarding is covered by backend integration tests.
for (const locale of ["ru", "en"] as const) {
  test.describe(`access policy ${locale}`, () => {
    test.use({ uiLocale: locale });
    test("supports portrait editing, review and precise sparse writes", async ({ page, login }, testInfo) => {
      await login();
      await page.setViewportSize({ width: locale === "ru" ? 360 : 1280, height: 800 });
      await page.route("**/api/telemt/info", async route => {
        const response = await route.fetch(), body = await response.json();
        await route.fulfill({ response, json: { ...body, version: "3.5.17", capabilities: { ...body.capabilities, access_policy: true } } });
      });
      const policy = { user_max_tcp_conns_global_each: 9007199254740992, user_max_unique_ips_global_each: 4, user_max_unique_ips_mode: "active_window", user_max_unique_ips_window_secs: 30, cidr_rate_limits: { "192.0.2.0/24": { up_bps: 1000, down_bps: 2000 } } };
      let captured: Record<string, unknown> | undefined;
      await page.route("**/api/telemt/access-policy", async route => {
        const request = route.request();
        if (request.method() === "PATCH") {
          captured = request.postDataJSON();
          expect(request.headers()["if-match"]).toBe("revision1");
          expect(request.headers()["if-runtime-match"]).toBe("runtime1");
        }
        await route.fulfill({ json: { revision: request.method() === "PATCH" ? "revision2" : "revision1", desired: { ...policy, ...(captured ?? {}), cidr_rate_limits: captured?.["cidr_rate_limits"] === null ? {} : policy.cidr_rate_limits }, effective: policy, runtime: { active_generation: 1, config_epoch: 1, runtime_match: "runtime1" }, published_match: false, effective_scope: "active_config_snapshot", subsystem_convergence: "unknown", apply_mode: "watcher" } });
      });
      await page.goto("/server/security");
      const editor = page.getByTestId("access-policy-editor");
      await expect(editor.locator('[name="user_max_unique_ips_global_each"]')).toHaveValue("4");
      await editor.locator('[name="user_max_unique_ips_global_each"]').fill("5");
      await editor.locator('[name="cidr_rate_limits"]').fill("");
      await editor.getByRole("button", { name: locale === "ru" ? "Сохранить политику" : "Save policy", exact: true }).click();
      await page.getByRole("button", { name: locale === "ru" ? "Подтвердить изменения" : "Confirm changes", exact: true }).click();
      await expect(editor.getByRole("status")).toBeVisible();
      expect(captured).toEqual({ user_max_unique_ips_global_each: 5, cidr_rate_limits: null });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await editor.evaluate(node => node.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: testInfo.outputPath(`access-policy-${locale}.png`) });
    });
  });
}
