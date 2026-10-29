import { chromium } from "playwright";
const WEBAPP = "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
try {
  await page.goto(`http://127.0.0.1:7512/v1/contract/web/${WEBAPP}/`, {
    waitUntil: "domcontentloaded",
  });
  const app = page.frameLocator("iframe#app");
  await app.locator('#status-pill[data-status="ready"]').waitFor({ timeout: 180_000 });
  await sleep(1_000);
  const clear = app.locator("#payment-clear");
  console.log("clear visible", await clear.isVisible().catch(() => false));
  if (await clear.isVisible().catch(() => false)) {
    await clear.click();
    await sleep(3_000);
    console.log(
      "status:",
      (await app.locator("#payment-status").textContent().catch(() => ""))
        .replace(/\s+/g, " ")
        .slice(0, 300),
    );
    console.log("clear visible after", await clear.isVisible().catch(() => false));
  }
  console.log(
    "notice:",
    (await app.locator("#notice, .notice, #error-notice").allTextContents().catch(() => []))
      .join(" | ")
      .slice(0, 300),
  );
} finally {
  await context.close();
  await browser.close();
}
