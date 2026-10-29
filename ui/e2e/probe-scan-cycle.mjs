import { chromium } from "playwright";
const WEBAPP = "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const port = Number(process.argv[2] ?? 7512);
const waitMs = Number(process.argv[3] ?? 360_000);
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
async function facts(tag) {
  await app.locator("#details-summary").click().catch(() => {});
  await app.locator("#auto-advance-refresh").click().catch(() => {});
  await sleep(1500);
  const text = async (id) => (await app.locator(id).textContent().catch(() => "?")).replace(/\s+/g, " ").trim();
  console.log(tag, JSON.stringify({
    state: await text("#auto-advance-state"),
    hash: await text("#auto-advance-hash"),
    address: await text("#auto-advance-address"),
    scan: await text("#auto-advance-scan"),
    subs: await text("#auto-advance-subs"),
    error: await text("#auto-advance-last-error"),
    audit: await text("#auto-advance-audit"),
  }));
  await app.locator("#details-summary").click().catch(() => {});
}
try {
  await facts("t0");
  console.log(`waiting ${Math.round(waitMs / 1000)}s for a scan...`);
  await sleep(waitMs);
  await facts("t1");
} finally {
  await context.close();
  await browser.close();
}
