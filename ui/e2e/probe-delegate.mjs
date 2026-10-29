import { chromium } from "playwright";
const WEBAPP = "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const port = Number(process.argv[2] ?? 7511);
const browser = await chromium.launch({ headless: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/v1/contract/web/${WEBAPP}/`, { waitUntil: "domcontentloaded" });
const app = page.frameLocator("iframe#app");
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  if ((await app.locator("#status-pill").getAttribute("data-status").catch(() => null)) === "ready") break;
  await sleep(500);
}
try {
  await app.locator("#details-summary").click();
  await app.locator("#auto-advance-refresh").click().catch(() => {});
  await sleep(2000);
  for (const id of ["#auto-advance-state", "#auto-advance-hash", "#auto-advance-address", "#auto-advance-scan", "#auto-advance-subs", "#auto-advance-toggle", "#auto-advance-max", "#auto-advance-last-error"]) {
    const val = await app.locator(id).inputValue().catch(async () => await app.locator(id).textContent().catch(() => "?"));
    console.log(id, JSON.stringify((val ?? "").replace(/\s+/g, " ").trim()));
  }
  console.log("#audit", JSON.stringify((await app.locator("#auto-advance-audit").textContent().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300)));
} finally {
  await context.close();
  await browser.close();
}
