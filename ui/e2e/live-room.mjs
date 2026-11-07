import { chromium } from "playwright";

/**
 * Live members-room smoke (P3b2).
 *
 * A (7511) owns a root-level zone with B (7512) in slot 0. A creates the room's
 * membership, B opens A's room through `?room=` and posts, A sees the message,
 * and C (7513), a non-member, cannot post.
 *
 * Run from ui/: node e2e/live-room.mjs [ownerPort] [childPort] [outsiderPort]
 */
const WEBAPP = "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const [OWNER_PORT, CHILD_PORT, OUTSIDER_PORT] = process.argv.slice(2, 5).map(Number);
const ownerPort = OWNER_PORT || 7511;
const childPort = CHILD_PORT || 7512;
const outsiderPort = OUTSIDER_PORT || 7513;
const stamp = Date.now();
const ownerText = `hello from A ${stamp}`;
const childText = `hello from B ${stamp}`;
const outsiderText = `intruder ${stamp}`;

const browser = await chromium.launch({ headless: true });
const contexts = [];
let failed = false;

function fail(message) {
  failed = true;
  console.log(`FAIL: ${message}`);
}

async function openNode(port, query = "") {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => fail(`pageerror on ${port}: ${error.message}`));
  await page.goto(
    `http://127.0.0.1:${port}/v1/contract/web/${WEBAPP}/${query}`,
    { waitUntil: "domcontentloaded", timeout: 60_000 },
  );
  const app = page.frameLocator("iframe#app");
  const install = app.locator("#delegate-install-button");
  if (await install.isVisible().catch(() => false)) {
    console.log(`${port}: installing the delegate`);
    await install.click();
    await app.locator("#delegate-install").waitFor({ state: "hidden", timeout: 120_000 });
  }
  await app.locator('#status-pill[data-status="ready"]').waitFor({ state: "attached", timeout: 180_000 });
  return { page, app };
}

async function openAdvanced(app) {
  if (!(await app.locator("#advanced-view").isVisible())) {
    await app.locator("#view-toggle").click();
  }
  await app.locator("#advanced-view").waitFor({ state: "visible" });
}

async function ownerId(app) {
  return (await app.locator("#identity-short").getAttribute("title")) ?? "";
}

async function waitText(app, text, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const body = await app.locator("#room-messages").innerText().catch(() => "");
    if (body.includes(text)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

try {
  // A: create the room and its membership, then post.
  const a = await openNode(ownerPort);
  const aId = await ownerId(a.app);
  if (!/^[0-9a-f]{64}$/.test(aId)) throw new Error(`owner A id is not 64-hex: ${aId}`);
  console.log(`A owner: ${aId}`);
  await openAdvanced(a.app);
  await a.app.locator("#room-open").click();
  await a.app.locator("#room-dialog").waitFor({ state: "visible", timeout: 30_000 });
  await a.app.locator("#room-membership-state").waitFor({ state: "visible", timeout: 60_000 });

  let membership = await a.app.locator("#room-membership-state").getAttribute("data-state");
  console.log(`A membership before update: ${membership}`);
  if (membership !== "match") {
    await a.app.locator("#room-update-membership").click();
    await a.app.locator("#room-membership-confirm-update").click();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      membership = await a.app.locator("#room-membership-state").getAttribute("data-state");
      if (membership === "match") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (membership !== "match") fail(`A membership is ${membership}, expected match`);
  }
  if (membership === "match") console.log("A membership: match");

  await a.app.locator("#room-message-input").fill(ownerText);
  await a.app.locator("#room-send").click();
  if (!(await waitText(a.app, ownerText))) fail("A did not see its own message");

  // B: open A's room through the deep link and post.
  const b = await openNode(childPort, `?room=${aId}`);
  const bId = await ownerId(b.app);
  console.log(`B owner: ${bId}`);
  await b.app.locator("#room-dialog").waitFor({ state: "visible", timeout: 60_000 });
  const target = (await b.app.locator("#room-target").innerText().catch(() => "")).trim();
  console.log(`B room target: ${target || "(none)"}`);
  if (!/parent/i.test(target)) fail(`B target label is "${target}", expected "Your parent's room"`);
  await b.app.locator("#room-membership-state").waitFor({ state: "visible", timeout: 60_000 });
  const bMember = await b.app
    .locator(`.room-member-row[data-member-id="${bId}"]`)
    .count()
    .catch(() => 0);
  if (bMember === 0) fail("B is not listed as a member of A's room");

  await b.app.locator("#room-message-input").fill(childText);
  await b.app.locator("#room-send").click();
  if (!(await waitText(b.app, childText))) fail("B did not see its own message");

  // A: refresh and see B's message.
  await a.app.locator("#room-refresh").click();
  if (!(await waitText(a.app, childText, 45_000))) fail("A did not see B's message");

  // C: not a member; the contract must drop the message.
  const c = await openNode(outsiderPort, `?room=${aId}`);
  const cId = await ownerId(c.app);
  console.log(`C owner: ${cId}`);
  await c.app.locator("#room-dialog").waitFor({ state: "visible", timeout: 60_000 });
  await c.app.locator("#room-membership-state").waitFor({ state: "visible", timeout: 60_000 });
  const cInput = c.app.locator("#room-message-input");
  if (await cInput.isDisabled().catch(() => true)) {
    console.log("C: composer is disabled for a non-member");
  } else {
    await cInput.fill(outsiderText);
    await c.app.locator("#room-send").click();
    await new Promise((r) => setTimeout(r, 4_000));
    await c.app.locator("#room-refresh").click();
    await new Promise((r) => setTimeout(r, 2_000));
    const cBody = await c.app.locator("#room-messages").innerText().catch(() => "");
    if (cBody.includes(outsiderText)) fail("C's non-member message was accepted");
    else console.log("C: non-member message rejected");
  }

  console.log(failed ? "LIVE ROOM SMOKE FAILED" : "LIVE ROOM SMOKE OK");
} catch (error) {
  fail(String(error?.stack ?? error));
  console.log("LIVE ROOM SMOKE FAILED");
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
process.exit(failed ? 1 : 0);
