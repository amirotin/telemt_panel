import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { startDevServer, stopDevServer } from "./devServer";

// e2e/details.spec.ts — spec §27.3's interaction matrix against the real
// Details builder on /dev/details:
//
//   tap entity · keyboard open/close · accordion preservation ·
//   search/filter/sort preservation · swipe and pager · the system Back
//   gesture from the left edge · portrait → landscape → portrait with an
//   entity open and with a SURFACE open · a swipe that must not page while
//   that surface is up · a realtime update during a scroll and with a
//   surface open.
//
// It runs against the vite DEV server rather than the built binary
// (playwright.config.ts's `details` project): /dev/details is dropped from
// the production bundle on purpose, so this is the only way to drive the
// builder over production-sized fixtures end to end. Everything on the
// page is a fixture, so no backend is involved.

const PAGE_CHIPS = {
  dc: "DC",
  tls: "Security / TLS",
} as const;

async function openHarness(page: Page, which: keyof typeof PAGE_CHIPS): Promise<void> {
  await page.goto("/dev/details");
  const switcher = page.getByTestId("dev-details-switcher");
  await expect(switcher).toBeVisible();
  if ((await switcher.getAttribute("open")) === null) {
    await switcher.locator("summary").click();
  }
  await switcher.getByRole("button", { name: PAGE_CHIPS[which], exact: true }).click();
}

/** A pointer stream the bounded swipe can read (§16.2). */
async function drag(
  page: Page,
  selector: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const common = { pointerId: 1, pointerType: "touch", isPrimary: true, bubbles: true };
  await page.dispatchEvent(selector, "pointerdown", {
    ...common,
    clientX: from.x,
    clientY: from.y,
  });
  await page.dispatchEvent(selector, "pointermove", {
    ...common,
    clientX: Math.round((from.x + to.x) / 2),
    clientY: Math.round((from.y + to.y) / 2),
  });
  await page.dispatchEvent(selector, "pointerup", { ...common, clientX: to.x, clientY: to.y });
}

// A realtime frame, delivered without touching the scroll position or the
// focus — see the two call sites for why that matters.
async function pushFrame(page: Page): Promise<void> {
  await page.getByTestId("dev-details-push").dispatchEvent("click");
}

function selectedEntity(page: Page) {
  return page.getByTestId("entity-selector").locator('[aria-pressed="true"]');
}

// The vite dev server this project needs, started for THIS spec only —
// the other two projects drive the built binary and must not wait for it
// (see e2e/devServer.ts).
test.beforeAll(async () => {
  test.setTimeout(150_000);
  await startDevServer();
});

test.afterAll(async () => {
  await stopDevServer();
});

// Nothing on this page should ever log to the console; a scenario that
// produces one is a failure even if its assertions pass. Collected rather
// than thrown from the listener: an exception raised inside an event
// handler surfaces as an unhandled error with no attribution to the step
// that caused it.
const consoleErrors: string[] = [];

test.beforeEach(({ page }) => {
  consoleErrors.length = 0;
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`page error: ${err.message}`));
});

test.afterEach(() => {
  expect(consoleErrors).toEqual([]);
});

test("tapping an entity row opens the detail surface, and closing returns focus", async ({
  page,
}) => {
  await openHarness(page, "tls");
  const row = page.locator("#by_fingerprint-panel li button").first();
  const identity = (await row.textContent()) ?? "";
  await row.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // §17: the surface carries EVERY remaining field of the record.
  await expect(dialog).toContainText("ja3_raw");

  await page.getByRole("button", { name: /закрыть|close/i }).click();
  await expect(dialog).toHaveCount(0);
  // §17: "focus возвращается на исходную строку после закрытия".
  await expect(page.locator("#by_fingerprint-panel li button").first()).toBeFocused();
  expect(identity.length).toBeGreaterThan(0);
});

test("opens and closes the surface from the keyboard alone", async ({ page }) => {
  await openHarness(page, "tls");
  const row = page.locator("#by_fingerprint-panel li button").first();
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toBeFocused();

  // §21's roving tabindex: the arrow keys move inside the list, and the
  // row they land on is the one Enter opens.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a realtime frame keeps the accordion, the search and the sort (§19.1)", async ({ page }) => {
  await openHarness(page, "tls");

  // Collapse a section by hand, type a query, choose a sort.
  const capture = page.locator("#capture-panel");
  const captureHeader = page.locator('[aria-controls="capture-panel"]');
  await captureHeader.click();
  const collapsed = await captureHeader.getAttribute("aria-expanded");
  expect(collapsed).toBe("false");
  await expect(capture).toBeHidden();

  const search = page.locator("#by_fingerprint-panel input[type=search]");
  await search.fill("t13d");
  const sort = page.locator("#by_fingerprint-panel select");
  await sort.selectOption("last_seen_epoch_secs");
  const rowsBefore = await page.locator("#by_fingerprint-panel li").count();
  expect(rowsBefore).toBeGreaterThan(0);

  // …and push a new payload through the same components a live frame
  // would.
  await page.getByTestId("dev-details-push").click();

  await expect(captureHeader).toHaveAttribute("aria-expanded", "false");
  await expect(search).toHaveValue("t13d");
  await expect(sort).toHaveValue("last_seen_epoch_secs");
  await expect(page.locator("#by_fingerprint-panel li")).toHaveCount(rowsBefore);
});

test("a realtime frame during a scroll neither jumps nor closes an open surface", async ({
  page,
}) => {
  await openHarness(page, "tls");
  const scrollBefore = await page.evaluate(() => {
    window.scrollTo(0, 900);
    return window.scrollY;
  });
  expect(scrollBefore).toBeGreaterThan(0);

  // `dispatchEvent`, not `click`: Playwright's click scrolls its target
  // into view first, and the harness button is at the top of the page —
  // the assertion below is about the page NOT moving, so the trigger must
  // not move it either.
  await pushFrame(page);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

  // Now with a surface open — the most disruptive frame the fixtures can
  // produce (the last record overtakes the leader) must not close it.
  await page.locator("#by_fingerprint-panel li button").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const title = await dialog.getByRole("heading").textContent();

  // Same reason, plus one more: with the surface up, the backdrop covers
  // the button a real click would have to reach.
  await pushFrame(page);
  await expect(dialog).toBeVisible();
  expect(await dialog.getByRole("heading").textContent()).toBe(title);
});

test("the pager and a swipe both move one entity, and the edge gesture moves none", async ({
  page,
}) => {
  await openHarness(page, "dc");
  const first = (await selectedEntity(page).textContent()) ?? "";

  await page.getByTestId("entity-pager-next").click();
  const second = (await selectedEntity(page).textContent()) ?? "";
  expect(second).not.toBe(first);

  await page.getByTestId("entity-pager-previous").click();
  await expect(selectedEntity(page)).toHaveText(first);

  // A swipe left is the same step as the pager's next button (§16.2).
  const hero = '[data-testid="detail-hero"]';
  const box = (await page.locator(hero).boundingBox())!;
  const y = Math.round(box.y + box.height / 2);
  await drag(page, hero, { x: 300, y }, { x: 300 - 120, y });
  await expect(selectedEntity(page)).toHaveText(second);

  await drag(page, hero, { x: 180, y }, { x: 180 + 120, y });
  await expect(selectedEntity(page)).toHaveText(first);

  // …and a drag that starts in the left-edge strip belongs to the system
  // Back gesture, not to us.
  await drag(page, hero, { x: 8, y }, { x: 8 + 200, y });
  await expect(selectedEntity(page)).toHaveText(first);

  // A vertical drag scrolls; it never pages.
  await drag(page, hero, { x: 300, y }, { x: 200, y: y + 260 });
  await expect(selectedEntity(page)).toHaveText(first);
});

test("portrait → landscape → portrait keeps the open entity and the layout follows", async ({
  page,
}) => {
  await openHarness(page, "dc");
  await page.getByTestId("entity-pager-next").click();
  await page.getByTestId("entity-pager-next").click();
  const chosen = (await selectedEntity(page).textContent()) ?? "";

  const layout = page.locator("[data-layout]");
  await expect(layout).toHaveAttribute("data-layout", "compact-portrait");

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(layout).toHaveAttribute("data-layout", "compact-landscape");
  await expect(selectedEntity(page)).toHaveText(chosen);
  // R1: the landscape rail, not a desktop master pane.
  const railWidth = await page
    .getByTestId("entity-selector")
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(railWidth).toBeGreaterThanOrEqual(80);
  expect(railWidth).toBeLessThanOrEqual(96);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(layout).toHaveAttribute("data-layout", "compact-portrait");
  await expect(selectedEntity(page)).toHaveText(chosen);
});

test("with a surface open, a swipe pages nothing and a rotation keeps it", async ({ page }) => {
  await openHarness(page, "dc");
  const chosen = (await selectedEntity(page).textContent()) ?? "";

  const row = page.locator("#endpoint_writers-panel button[aria-label]").first();
  await row.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const title = await dialog.getByRole("heading").textContent();

  // §16.2 + §17: the gesture is disarmed while the surface owns the screen.
  // `dispatchEvent` reaches the hero regardless of the backdrop covering
  // it, so this tests the guard rather than the stacking order.
  const hero = '[data-testid="detail-hero"]';
  const box = (await page.locator(hero).boundingBox())!;
  const y = Math.round(box.y + box.height / 2);
  await drag(page, hero, { x: 300, y }, { x: 300 - 140, y });
  await expect(selectedEntity(page)).toHaveText(chosen);
  await expect(dialog).toBeVisible();

  // §17: rotating swaps the bottom sheet for the side sheet without closing
  // it or changing the record it shows.
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator("[data-layout]")).toHaveAttribute("data-layout", "compact-landscape");
  await expect(dialog).toBeVisible();
  expect(await dialog.getByRole("heading").textContent()).toBe(title);
  await expect(selectedEntity(page)).toHaveText(chosen);
});

// Both harness pages, because they fail differently: `tls` is the wide-table
// page, and `dc` is the one with the twelve-entity rail whose attention
// markers widened the document by 286 px until their `sr-only` text was given
// a positioned ancestor. The Go mock serves a single DC, so this fixture-backed
// harness is the only stand that reproduces the twelve-chip rail at all.
for (const domain of ["tls", "dc"] as const) {
  test(`no page scrolls horizontally, in any of the four modes (${domain})`, async ({ page }) => {
    await openHarness(page, domain);
    for (const size of [
      { width: 360, height: 640 },
      { width: 844, height: 390 },
      { width: 768, height: 1024 },
      { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(size);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${domain} ${size.width}×${size.height}`).toBeLessThanOrEqual(0);
    }
  });
}
