import { chromium } from "playwright";
const WEBAPP = "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const browser = await chromium.launch({ headless: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(port) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/v1/contract/web/${WEBAPP}/`, { waitUntil: "domcontentloaded" });
  const app = page.frameLocator("iframe#app");
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const status = await app.locator("#status-pill").getAttribute("data-status").catch(() => null);
    if (status === "ready") break;
    if (await app.locator("#delegate-install").isVisible().catch(() => false)) {
      await app.locator("#delegate-install-button").click().catch(() => {});
    }
    if (await app.locator("#board-name-dialog").isVisible().catch(() => false)) {
      await app.locator("#board-name-input").fill(`probe-${port}`).catch(() => {});
      await app.locator("#board-name-save").click({ timeout: 60_000 }).catch(() => {});
    }
    await sleep(500);
  }
  return { context, page, app };
}

const b = await open(7512);
try {
  console.log("[B] address", await b.app.locator("#board-address-value").textContent().catch(() => "?"));
  console.log("[B] labels", await b.app.locator(".slot .slot-label").allTextContents());
  console.log("[B] values", await b.app.locator(".slot .slot-value").allTextContents());
  await b.app.locator("#details-summary").click();
  await b.app.locator("#auto-advance-refresh").click().catch(() => {});
  await sleep(2_000);
  for (const id of ["#auto-advance-scan", "#auto-advance-subs", "#auto-advance-audit", "#auto-advance-last-error", "#auto-advance-state", "#auto-advance-hash", "#auto-advance-address"]) {
    console.log(`[B] ${id}:`, JSON.stringify((await b.app.locator(id).textContent().catch(() => "?")).replace(/\s+/g, " ").slice(0, 400)));
  }
  console.log("[B] audit html", (await b.app.locator("#auto-advance-audit").innerHTML().catch(() => "")).slice(0, 1200));
} finally {
  await b.context.close();
}

const c = await open(7513);
try {
  console.log("[C] address", await c.app.locator("#board-address-value").textContent().catch(() => "?"));
  console.log("[C] payment-status", JSON.stringify((await c.app.locator("#payment-status").textContent().catch(() => "?")).replace(/\s+/g, " ").slice(0, 500)));
  console.log("[C] parent-value", JSON.stringify(await c.app.locator("#parent-value-amount").textContent().catch(() => "?")));
  console.log("[C] parent-change", JSON.stringify(await c.app.locator("#parent-value-change").textContent().catch(() => "")));
  console.log("[C] parent-log", (await c.app.locator("#parent-adjustments-list").textContent().catch(() => "")).replace(/\s+/g, " ").slice(0, 500));
} finally {
  await c.context.close();
}

const d = await open(7509);
try {
  console.log("[D] address", await d.app.locator("#board-address-value").textContent().catch(() => "?"));
  console.log("[D] parent-name", JSON.stringify(await d.app.locator("#parent-name").textContent().catch(() => "?")));
  console.log("[D] parent-value", JSON.stringify(await d.app.locator("#parent-value-amount").textContent().catch(() => "?")));
  console.log("[D] parent-log", (await d.app.locator("#parent-adjustments-list").textContent().catch(() => "")).replace(/\s+/g, " ").slice(0, 500));
} finally {
  await d.context.close();
}

await browser.close();
