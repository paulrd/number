import { chromium } from "playwright";
const WEBAPP = "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const browser = await chromium.launch({ headless: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(port) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/v1/contract/web/${WEBAPP}/`, { waitUntil: "domcontentloaded" });
  const app = page.frameLocator("iframe#app");
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const status = await app.locator("#status-pill").getAttribute("data-status").catch(() => null);
    if (status === "ready") break;
    if (await app.locator("#delegate-install").isVisible().catch(() => false)) {
      await app.locator("#delegate-install-button").click().catch(() => {});
    }
    if (await app.locator("#identity-setup").isVisible().catch(() => false)) {
      await app.locator("#identity-create").click().catch(() => {});
    }
    if (await app.locator("#board-name-dialog").isVisible().catch(() => false)) {
      await app.locator("#board-name-input").fill(`probe-${port}`).catch(() => {});
      await app.locator("#board-name-save").click({ timeout: 60_000 }).catch(() => {});
    }
    await sleep(500);
  }
  return { context, page, app, errors };
}

for (const port of process.argv.slice(2).map(Number)) {
  const n = await open(port);
  try {
    const owner = await n.app.locator("#identity-short").getAttribute("title").catch(() => "?");
    console.log(`[${port}] owner=${owner}`);
    console.log(`[${port}] address=${JSON.stringify(await n.app.locator("#board-address-value").textContent().catch(() => "?"))}`);
    console.log(`[${port}] parent=${JSON.stringify((await n.app.locator("#parent-name").textContent().catch(() => "?")).trim())}`);
    console.log(`[${port}] labels=${JSON.stringify(await n.app.locator(".slot .slot-label").allTextContents())}`);
    console.log(`[${port}] values=${JSON.stringify(await n.app.locator(".slot .slot-value").allTextContents())}`);
    console.log(`[${port}] payment=${JSON.stringify((await n.app.locator("#payment-status").textContent().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300))}`);
    console.log(`[${port}] paymentOpenDisabled=${await n.app.locator("#payment-open").isDisabled().catch(() => "?")}`);
    console.log(`[${port}] errors=${JSON.stringify(n.errors.slice(0, 5))}`);
  } finally {
    await n.context.close();
  }
}
await browser.close();
