import { chromium } from "playwright";

/**
 * Real-node smoke: v5 issue/burn + v8 delegate auto-advance, B as the LCA.
 *
 * Topology: A (7511) root; B (7512) child of A at address "0"; C (7513) child
 * of B at slot 3 ("03") and D (7509) child of B at slot 1 ("01"). B holds
 * 100.00 against each. C pays D 10.00 at address "1". B's tab is closed before
 * the payment, so only B's background delegate may apply the paired LCA delta:
 * C 90.00, D 110.00, and B's audit non-empty.
 *
 * This is the original topology; B's stale payment (the only blocker recorded
 * in HANDOFF.md) was cleared afterwards, so B is usable again.
 *
 * Run from ui/: node e2e/live-smoke-b.mjs
 */
const WEBAPP = "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const NODES = [
  { port: 7512, name: "B-lca", allowCreate: false },
  { port: 7513, name: "C-source", allowCreate: false },
  { port: 7509, name: "D-destination", allowCreate: false },
];

const base = (port) => `http://127.0.0.1:${port}/v1/contract/web/${WEBAPP}/`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function visible(app, selector) {
  try {
    return await app.locator(selector).isVisible();
  } catch {
    return false;
  }
}

async function waitForAny(app, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      if (await visible(app, selector)) return selector;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for any of ${selectors.join(", ")}`);
}

async function waitFor(app, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await visible(app, selector)) return;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${selector}`);
}

async function waitGone(app, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await visible(app, selector))) return;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${selector} to disappear`);
}

async function waitUntil(label, predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result === true) return;
      last = typeof result === "string" ? result : "";
    } catch (error) {
      last = String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

async function answerBackgroundPrompt(port, label, done) {
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (!done() && Date.now() < deadline) {
    let items = [];
    try {
      items = await (await fetch(`${origin}/permission/pending`)).json();
    } catch {
      // The node may be shutting down or the forward may hiccup; retry.
    }
    if (items.length > 0) {
      const prompt = items[0];
      await fetch(`${origin}/permission/${encodeURIComponent(prompt.nonce)}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ index: 0 }),
      });
      console.log(`[${label}] answered the node permission prompt`);
      return true;
    }
    await sleep(400);
  }
  return false;
}

async function openNode(browser, { port, name, allowCreate }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  console.log(`[${name}:${port}] loading`);
  await page.goto(base(port), { waitUntil: "domcontentloaded" });
  const app = page.frameLocator("iframe#app");

  await waitForAny(
    app,
    ["#delegate-install", "#identity-setup", '#status-pill[data-status="ready"]', '#status-pill[data-status="error"]'],
    120_000,
  );

  if (await visible(app, "#delegate-install")) {
    console.log(`[${name}] installing the v8 delegate`);
    // A fresh node asks for the node-enforced Background capability when the
    // app-origin registration arrives. The 0.2.151 shell does not render that
    // prompt, so answer it through the node's permission API instead.
    let installed = false;
    const answering = answerBackgroundPrompt(port, name, () => installed);
    await app.locator("#delegate-install-button").click();
    await waitGone(app, "#delegate-install", 180_000);
    installed = true;
    await answering;
  }

  if (await visible(app, "#identity-setup")) {
    if (!allowCreate) {
      throw new Error(
        `${name} has no migrated seed and the first-run dialog appeared; refusing to create a new identity on the live node`,
      );
    }
    console.log(`[${name}] creating a first-run identity`);
    await app.locator("#identity-create").click();
    await waitGone(app, "#identity-setup", 120_000);
  }

  if (await visible(app, "#board-name-dialog")) {
    console.log(`[${name}] naming the board ${name}`);
    await app.locator("#board-name-input").fill(name);
    await app.locator("#board-name-save").click();
    await waitGone(app, "#board-name-dialog", 60_000);
  }

  await waitFor(app, '#status-pill[data-status="ready"]', 240_000).catch(async (error) => {
    const status = await app.locator("#status-pill").getAttribute("data-status").catch(() => "?");
    const text = await app.locator("#status-detail").textContent().catch(() => "?");
    throw new Error(`${name} not ready (status=${status}, detail=${text}): ${error.message}`);
  });

  let pubkey = null;
  const keyDeadline = Date.now() + 30_000;
  while (Date.now() < keyDeadline) {
    pubkey = await app.locator("#identity-short").getAttribute("title").catch(() => null);
    if (pubkey && /^[0-9a-f]{64}$/.test(pubkey)) break;
    await sleep(400);
  }
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) {
    throw new Error(`${name} did not expose a valid owner key (got ${pubkey})`);
  }

  const address = (await app.locator("#board-address-value").textContent().catch(() => "")).trim();
  console.log(`[${name}] ready owner=${pubkey.slice(0, 16)}… address=${JSON.stringify(address)}`);
  return { node: { port, name, allowCreate }, context, page, app, errors, pubkey, address };
}

async function reload(node) {
  await node.page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(node.app, '#status-pill[data-status="ready"]', 180_000);
  await sleep(800);
}

async function ensureContact(node, label, userId) {
  const { app } = node;
  await app.locator("#contacts-open").click();
  await waitFor(app, "#contacts-dialog", 10_000);
  const codes = await app.locator("#contacts-list code").allTextContents();
  const short = userId.slice(0, 8).toLowerCase();
  if (!codes.some((text) => text.toLowerCase().includes(short))) {
    await app.locator("#contact-label-input").fill(label);
    await app.locator("#contact-userid-input").fill(userId);
    await app.locator("#contact-add-button").click();
    await sleep(700);
  }
  await app.locator("#contacts-done").click();
  await waitGone(app, "#contacts-dialog", 10_000);
}

async function setParent(node, parentUserId) {
  const { app } = node;
  await app.locator("#parent-edit").click();
  await waitFor(app, "#parent-dialog", 10_000);
  await app.locator("#parent-select").selectOption(parentUserId);
  await sleep(300);
  if (await app.locator("#parent-save").isDisabled()) {
    await app.locator("#parent-cancel").click();
    await waitGone(app, "#parent-dialog", 10_000);
    return;
  }
  await app.locator("#parent-save").click();
  await waitGone(app, "#parent-dialog", 40_000);
}

async function clearParent(node) {
  const { app } = node;
  if (!(await visible(app, "#parent-clear"))) return;
  await app.locator("#parent-clear").click();
  await sleep(1_200);
}

async function clearStuckIfNeeded(node) {
  const { app } = node;
  // renderPayments is async: the Clear control only appears after the payment
  // status/progress read settles, so wait for that render before deciding.
  await waitUntil(
    "the payments section to render",
    async () => {
      if (await visible(app, "#payment-clear")) return true;
      if (await visible(app, "#payment-status")) return true;
      if (!(await app.locator("#payment-open").isDisabled())) return true;
      return "not rendered";
    },
    45_000,
  );
  if (!(await visible(app, "#payment-clear"))) return false;
  console.log("[B] clearing the stuck payments record");
  await app.locator("#payment-clear").click();
  await waitUntil(
    "the clear to land",
    async () => ((await visible(app, "#payment-clear")) ? "clear still visible" : true),
    60_000,
  );
  await sleep(1_000);
  return true;
}

async function withdrawOffer(node) {
  const { app } = node;
  if (!(await visible(app, "#payment-withdraw"))) return false;
  console.log("[payment] withdrawing C's pending offer");
  await waitUntil(
    "the withdraw control to enable",
    async () => (!(await app.locator("#payment-withdraw").isDisabled()) ? true : "disabled"),
    30_000,
  );
  await app.locator("#payment-withdraw").click();
  await waitUntil(
    "the old offer to disappear",
    async () => {
      if (await visible(app, "#payment-withdraw")) return "withdraw still visible";
      if (await app.locator("#payment-open").isDisabled()) return "payment-open still disabled";
      return true;
    },
    60_000,
  );
  return true;
}

async function offerPayment(node, address, user, amount) {  const { app } = node;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && (await app.locator("#payment-open").isDisabled())) {
    await sleep(400);
  }
  if (await app.locator("#payment-open").isDisabled()) {
    throw new Error(`payment-open is disabled: ${await app.locator("#payment-open").getAttribute("title")}`);
  }
  await app.locator("#payment-open").click();
  await waitFor(app, "#payment-dialog", 10_000);
  await app.locator("#payment-address").fill(address);
  await app.locator("#payment-user").fill(user);
  await app.locator("#payment-amount").fill(amount);

  const submitDeadline = Date.now() + 60_000;
  while (Date.now() < submitDeadline && (await app.locator("#payment-submit").isDisabled())) {
    await sleep(400);
  }
  await app.locator("#payment-submit").click({ timeout: 60_000 });

  const closeDeadline = Date.now() + 60_000;
  while (Date.now() < closeDeadline) {
    if (!(await visible(app, "#payment-dialog"))) return;
    const error = await app.locator("#payment-error").textContent().catch(() => "");
    if (error && error.trim()) throw new Error(`payment rejected: ${error.trim()}`);
    await sleep(500);
  }
  const error = await app.locator("#payment-error").textContent().catch(() => "");
  throw new Error(`payment dialog did not close: ${error}`);
}

async function paymentStatus(node) {
  await reload(node);
  return (await node.app.locator("#payment-status").textContent().catch(() => "")).replace(/\s+/g, " ").trim();
}

async function delegateFacts(node) {
  const { app } = node;
  await app.locator("#details-summary").click();
  await app.locator("#auto-advance-refresh").click().catch(() => {});
  await sleep(1_500);
  const text = async (id) =>
    (await app.locator(id).textContent().catch(() => "?")).replace(/\s+/g, " ").trim();
  return {
    state: await text("#auto-advance-state"),
    hash: await text("#auto-advance-hash"),
    address: await text("#auto-advance-address"),
    scan: await text("#auto-advance-scan"),
    subs: await text("#auto-advance-subs"),
    error: await text("#auto-advance-last-error"),
    audit: await text("#auto-advance-audit"),
  };
}

const browser = await chromium.launch({ headless: true });
const opened = [];
try {
  for (const spec of NODES) opened.push(await openNode(browser, spec));
  const [B, C, D] = opened;

  for (const node of opened) {
    console.log(
      `${node.node.name}: ${node.pubkey} address=${JSON.stringify(node.address)} consoleErrors=${node.errors.length}`,
    );
  }
  console.log("[B delegate]", JSON.stringify(await delegateFacts(B)));
  await B.app.locator("#details-summary").click(); // collapse again

  // A terminal record (complete/reversed/blocked) does not block plan_leg
  // check (d); a forward one does. Clear a stuck forward record at the source.
  await clearStuckIfNeeded(B);
  if (await visible(B.app, "#payment-status")) {
    const status = (await B.app.locator("#payment-status").textContent().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    console.log(`[B own payment] ${status.slice(0, 160)}`);
  }
  if (await B.app.locator("#payment-open").isDisabled()) {
    throw new Error("B cannot start a payment, so its own record is still active");
  }

  // Address book entries needed by the parent move.
  await ensureContact(D, "B-lca", B.pubkey);
  await ensureContact(C, "D-destination", D.pubkey);

  // C already points at B (address 03) and B already holds 100.00 on slots 3
  // (C) and 1 (D). Only D's parent link is missing.
  await setParent(D, B.pubkey);

  for (const node of [B, C, D]) await reload(node);
  const bAddr = (await B.app.locator("#board-address-value").textContent()).trim();
  const cAddr = (await C.app.locator("#board-address-value").textContent()).trim();
  const dAddr = (await D.app.locator("#board-address-value").textContent()).trim();
  console.log(`[topology] B=${JSON.stringify(bAddr)} C=${JSON.stringify(cAddr)} D=${JSON.stringify(dAddr)}`);
  if (bAddr !== "0" || cAddr !== "03" || dAddr !== "01") {
    throw new Error(`unexpected addresses: B=${JSON.stringify(bAddr)} C=${JSON.stringify(cAddr)} D=${JSON.stringify(dAddr)}`);
  }
  for (const node of [C, D]) {
    const amount = (await node.app.locator("#parent-value-amount").textContent().catch(() => "?")).trim();
    console.log(`[topology] ${node.node.name} liability=${amount}`);
    if (amount !== "100.00") throw new Error(`${node.node.name} liability is ${amount}, expected 100.00`);
  }

  await withdrawOffer(C);
  await offerPayment(C, "01", D.pubkey, "10.00");
  console.log("[payment] offered 10.00 from C to D at address 01");
  console.log("[payment] closing B's tab; only B's background delegate may act");
  await B.page.close();

  const status = await waitUntil(
    "the payment to complete",
    async () => {
      const current = await paymentStatus(C);
      console.log(`[payment] ${current.slice(0, 160)}`);
      if (/complete/i.test(current)) return true;
      if (/reversed|blocked/i.test(current)) return current;
      return current;
    },
    12 * 60_000,
    15_000,
  ).catch(async (error) => {
    const B2 = await openNode(browser, B.node);
    opened.push(B2);
    console.log("[debug] B delegate", JSON.stringify(await delegateFacts(B2)));
    throw error;
  });
  console.log(`[payment] final: ${status}`);

  await reload(C);
  await reload(D);
  const cLiability = (await C.app.locator("#parent-value-amount").textContent().catch(() => "?")).trim();
  const dLiability = (await D.app.locator("#parent-value-amount").textContent().catch(() => "?")).trim();
  console.log(`[result] C liability=${cLiability} D liability=${dLiability}`);
  if (cLiability !== "90.00" || dLiability !== "110.00") {
    throw new Error(`unexpected post-payment liabilities: C=${cLiability} D=${dLiability}`);
  }

  // Reopen B and read the delegate audit; it should name the LCA step.
  const B2 = await openNode(browser, B.node);
  opened.push(B2);
  const facts = await delegateFacts(B2);
  console.log("[delegate] B", JSON.stringify(facts));
  if (facts.audit.length === 0) {
    throw new Error("B's delegate audit is empty after the LCA pair");
  }
  if (!/\blca\b/i.test(facts.audit)) {
    console.log("[warn] B's audit does not name the lca role; inspect it above");
  }

  // Restore the live D board to a root. Its own slots/contacts stay untouched.
  await clearParent(D);
  await reload(D);
  const dParent = (await D.app.locator("#parent-name").textContent().catch(() => "?")).trim();
  console.log(
    `[cleanup] D parent=${JSON.stringify(dParent)} address=${JSON.stringify((await D.app.locator("#board-address-value").textContent()).trim())}`,
  );

  console.log("SMOKE OK");
} finally {
  await Promise.all(opened.map(({ context }) => context.close().catch(() => {})));
  await browser.close();
}
