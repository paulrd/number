import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Offline tier: the real built UI, the real state codec/merge code, and the
 * in-memory mock backend. No Freenet node or gateway is involved.
 */
test("board mounts, saves a slot, and passes axe", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "number" })).toBeVisible();
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await expect(page.locator("#identity-short")).not.toHaveText("Not available");
  await expect(page.locator("#contract-short")).not.toHaveText("Not derived");
  await expect(page.locator(".slot")).toHaveCount(8);

  // Exercise one real interaction, not just first paint.
  await page.locator(".slot").first().click();
  await expect(page.locator("#value-input")).toBeVisible();
  await page.locator("#value-input").fill("42");
  await page.locator("#save-button").click();
  await expect(page.locator(".slot .slot-value").first()).toHaveText("42");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});
