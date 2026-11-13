import { expect, test } from "./fixtures";
import QRCode from "qrcode";
import { SEEDED_USER } from "./env";
import type { WebUserAccessUpdate } from "../src/lib/api/generated/types.gen";

// Keep authentication, realtime user data and the built interface real. These
// narrow mutation fixtures leave the shared seeded Telemt instance unchanged.
test("user edits refresh the WEB revision and explicit reload policy survives closing the editor", async ({ page, login }) => {
  await login();
  const baselineResponse = await page.request.get(`/api/users/${SEEDED_USER}`);
  expect(baselineResponse.ok()).toBeTruthy();
  const baseline = await baselineResponse.json();
  let revision = "audit-web-r1";
  let profiles = [{ vhost: "audit.example.com", secret_mode: "plain", max_sessions: 3 }];
  const reads: string[] = [];
  const writes: Array<{ revision: string | undefined; query: URLSearchParams; body: WebUserAccessUpdate }> = [];
  const patched: unknown[] = [];
  const reload = (id: number, mode: "instant" | "drain") => ({
    reload_id: id, target_generation: id, config_revision: revision,
    state: "accepted", mode, failure_policy: "keep_new",
  });
  await page.route("**/api/telemt/web-access", (route) => {
    reads.push(revision);
    return route.fulfill({ json: {
      revision, enabled: true, mtproto_listener: "configured",
      vhosts: [{ host: "audit.example.com", public_addr: "audit.example.com:443", profiles: profiles.map(({ vhost: _vhost, ...profile }) => ({ user: SEEDED_USER, ...profile })) }],
    } });
  });
  await page.route(`**/api/users/${SEEDED_USER}`, (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const patch = route.request().postDataJSON();
    patched.push(patch);
    revision = "audit-web-r2";
    return route.fulfill({ json: { ...baseline, ...patch } });
  });
  await page.route(`**/api/telemt/web-access/users/${SEEDED_USER}*`, (route) => {
    const request = route.request();
    const query = new URL(request.url()).searchParams;
    const body = request.postDataJSON() as WebUserAccessUpdate;
    writes.push({ revision: request.headers()["if-match"], query, body });
    profiles = body.profiles.map((profile) => ({ ...profile, max_sessions: profile.max_sessions ?? 3 }));
    revision = `audit-web-r${writes.length + 2}`;
    return route.fulfill({ status: 202, json: {
      revision, changed: ["web"], reload: reload(70 + writes.length, query.get("reload") === "instant" ? "instant" : "drain"),
    } });
  });
  await page.route("**/api/telemt/reload/7*", (route) => {
    const id = Number(new URL(route.request().url()).pathname.split("/").pop());
    return route.fulfill({ json: { ...reload(id, id === 71 ? "drain" : "instant"), state: id === 71 ? "draining" : "activating", requested_at_epoch_secs: 1794412800 } });
  });

  await page.goto(`/people/${SEEDED_USER}?tab=access`);
  const configure = page.getByRole("button", { name: "Настроить", exact: true });
  await expect(configure).toBeEnabled();
  await expect.poll(() => reads.includes("audit-web-r1")).toBe(true);
  await page.locator(".user-detail-tabs").getByRole("button", { name: "Настройки", exact: true }).click();
  await page.locator(".user-inline-form").getByLabel("Макс. соединений", { exact: true }).fill("41");
  await page.getByTestId("user-form-submit").click();
  await expect.poll(() => patched).toEqual([{ max_tcp_conns: 41 }]);
  // PeopleProvider keeps the original query mounted across local tab changes.
  // A second GET with r2 therefore proves invalidation after the user mutation.
  await expect.poll(() => reads.includes("audit-web-r2")).toBe(true);
  await page.locator(".user-detail-tabs").getByRole("button", { name: "Доступ", exact: true }).click();
  await configure.click();
  const editor = page.getByRole("dialog", { name: "WEB-профили" });
  await expect(editor.getByRole("button", { name: "С drain", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(editor.getByRole("button", { name: "Без reload", exact: true })).toHaveCount(0);
  await editor.getByText("Индивидуальные ограничения", { exact: true }).click();
  await editor.getByLabel("Сессий", { exact: true }).fill("4");
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].revision).toBe("audit-web-r2");
  expect(writes[0].query.get("reload")).toBe("drain");
  expect(writes[0].query.get("timeout_secs")).toBe("30");
  expect(writes[0].body).toEqual({ profiles: [{ vhost: "audit.example.com", secret_mode: "plain", max_sessions: 4 }] });
  await expect(editor).not.toBeVisible();
  const progress = page.getByTestId("web-access-reload");
  await expect(progress).toBeVisible();
  await expect(progress.getByRole("progressbar", { name: "Статус перезагрузки" })).toBeVisible();
  await expect(progress).toContainText("Дренаж");

  await configure.click();
  await editor.getByRole("button", { name: "Сразу", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Сразу", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(editor.getByText(/активн.*(поток|подключ)|разрыв|прерв/i)).toBeVisible();
  await editor.getByText("Индивидуальные ограничения", { exact: true }).click();
  await editor.getByLabel("Сессий", { exact: true }).fill("5");
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].revision).toBe("audit-web-r3");
  expect(writes[1].query.get("reload")).toBe("instant");
  expect(writes[1].query.has("timeout_secs")).toBe(false);
  expect(writes[1].body).toEqual({ profiles: [{ vhost: "audit.example.com", secret_mode: "plain", max_sessions: 5 }] });
  await expect(editor).not.toBeVisible();
  await expect(progress).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});


test("WEB-only access hides MTProto modes and the action menu shares the WEB link", async ({ page, login }) => {
  await login();
  const response = await page.request.get(`/api/users/${SEEDED_USER}`);
  expect(response.ok()).toBeTruthy();
  const user = await response.json();
  expect(user.links.classic.length).toBeGreaterThan(0);
  const secret = new URL(user.links.classic[0]).searchParams.get("secret");
  expect(secret).toMatch(/^[0-9a-f]{32}$/i);
  const expectedLink = `tg://webproxy?server=web.example.org&secret=dd${secret}`;
  await page.route("**/api/telemt/web-access", (route) => route.fulfill({ json: {
    revision: "audit-web-only", enabled: true, mtproto_listener: "absent",
    vhosts: [{ host: "web.example.org", public_addr: "web.example.org:443", profiles: [{ user: SEEDED_USER, secret_mode: "dd" }] }],
  } }));

  await page.goto(`/people/${SEEDED_USER}?tab=access`);
  const modes = page.getByRole("group", { name: "Тип подключения", exact: true });
  await expect(modes.getByRole("button")).toHaveText(["WEB"]);
  await expect(modes.getByRole("button", { name: "WEB", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const mode of ["Classic", "DD", "EE"]) {
    await expect(modes.getByRole("button", { name: mode, exact: true })).toHaveCount(0);
  }
  const quick = page.getByRole("group", { name: `Быстрые ссылки ${SEEDED_USER}`, exact: true });
  await expect(quick.getByRole("button", { name: `Копировать WEB · ${SEEDED_USER}`, exact: true })).toBeEnabled();
  await expect(quick.getByRole("button", { name: /^Копировать / })).toHaveCount(1);
  await page.getByText("Показать выбранную ссылку", { exact: true }).click();
  await expect(page.getByText(expectedLink, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Действия", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: /QR-код/ }).click();
  const qr = page.getByRole("dialog", { name: "QR-код", exact: true });
  await expect(qr.getByRole("link", { name: "Открыть в Telegram", exact: true })).toHaveAttribute("href", expectedLink);
  await expect(qr.getByText(expectedLink, { exact: true })).toBeVisible();
  const expectedSvg = await QRCode.toString(expectedLink, { type: "svg", margin: 1, width: 200 });
  const expectedPaths = [...expectedSvg.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map((match) => match[1]);
  expect(expectedPaths.length).toBeGreaterThan(0);
  await expect.poll(() => qr.locator(".bg-white svg path").evaluateAll((paths) => paths.map((path) => path.getAttribute("d")))).toEqual(expectedPaths);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});
