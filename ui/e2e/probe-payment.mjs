import { chromium } from "playwright";
const WEBAPP = "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const port = Number(process.argv[2] ?? 7513);
const browser = await chromium.launch({ headless: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("console", (m) => errors.push(`${m.type()}: ${m.text()}`));
await page.goto(`http://127.0.0.1:${port}/v1/contract/web/${WEBAPP}/`, { waitUntil: "domcontentloaded" });
const app = page.frameLocator("iframe#app");
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  if ((await app.locator("#status-pill").getAttribute("data-status").catch(() => null)) === "ready") break;
  await sleep(500);
}
try {
  for (const id of ["#payment-status", "#payment-withdraw", "#payment-open", "#payment-clear", "#notice", "#error-notice", "#status-detail"]) {
    const loc = app.locator(id);
    const isVis = await loc.isVisible().catch(() => null);
    const txt = (await loc.textContent().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
    const disabled = await loc.isDisabled().catch(() => null);
    console.log(id, JSON.stringify({ isVis, disabled, txt }));
  }
  console.log("console", JSON.stringify(errors.filter((e) => e.startsWith("error")).slice(-5)));
} finally {
  await context.close();
  await browser.close();
}
