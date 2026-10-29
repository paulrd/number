import { chromium } from "playwright";
const WEBAPP = "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
try {
  await page.goto(`http://127.0.0.1:7509/v1/contract/web/${WEBAPP}/`, { waitUntil: "domcontentloaded" });
  const app = page.frameLocator("iframe#app");
  await app.locator('#status-pill[data-status="ready"]').waitFor({ timeout: 180_000 });
  console.log("before parent", JSON.stringify(await app.locator("#parent-name").textContent().catch(() => "?")), "address", JSON.stringify(await app.locator("#board-address-value").textContent().catch(() => "?")));
  if (await app.locator("#parent-clear").isVisible().catch(() => false)) {
    await app.locator("#parent-clear").click();
    await new Promise((r) => setTimeout(r, 2_000));
  }
  console.log("after parent", JSON.stringify(await app.locator("#parent-name").textContent().catch(() => "?")), "address", JSON.stringify(await app.locator("#board-address-value").textContent().catch(() => "?")));
  console.log("parent band visible", await app.locator("#parent-value").isVisible().catch(() => false));
} finally {
  await context.close();
  await browser.close();
}
