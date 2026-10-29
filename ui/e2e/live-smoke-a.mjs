import { chromium } from "playwright";

/**
 * Real-node smoke: v5 issue/burn + v8 delegate auto-advance, with A as the LCA.
 *
 * Topology: A (7511) is the root; C (7513) and D (7509) are its children.
 * A holds 100.00 against each. C pays D 10.00 at address "1". A's tab is
 * closed before the payment, so only A's background delegate may apply the
 * paired LCA delta: C 90.00, D 110.00, and A's audit non-empty.
 *
 * B (7512) and its stale payment are deliberately unused.
 *
 * Run from ui/: node e2e/live-smoke-a.mjs
 */
const WEBAPP = "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const NODES = [
  { port: 7511, name: "A-root", allowCreate: false },
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
    await app.locator("#delegate-install-button").click();
    await waitGone(app, "#delegate-install", 180_000);
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

  const address = await app.locator("#board-address-value").textContent().catch(() => null);
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

async function saveDetails(node, slot, userId) {
  const { app } = node;
  await app.locator(".slot").nth(slot).click();
  await waitFor(app, "#editor", 10_000);
  await app.locator("#contact-select").selectOption(userId);
  await sleep(300);
  // Selecting the already-saved contact is a no-op and leaves Save disabled;
  // the link exists, so closing is the correct result.
  if (await app.locator("#save-button").isDisabled()) {
    await app.locator("#cancel-button").click();
    await waitGone(app, "#editor", 10_000);
    return;
  }
  await app.locator("#save-button").click();
  await waitGone(app, "#editor", 40_000);
}

async function currentCents(node) {
  const text = await node.app.locator("#adjust-current").textContent().catch(() => "0.00");
  return Math.round(Number((text ?? "0.00").replace(/,/g, "")) * 100);
}

async function adjustTo(node, slot, targetCents, note) {
  const { app } = node;
  await app.locator(".slot").nth(slot).click();
  await waitFor(app, "#editor", 10_000);
  const current = await currentCents(node);
  if (current === targetCents) {
    await app.locator("#cancel-button").click();
    await waitGone(app, "#editor", 10_000);
    return;
  }
  const delta = targetCents - current;
  if (delta < 0) await app.locator("#adjust-burn").check();
  await app.locator("#adjust-amount").fill((Math.abs(delta) / 100).toFixed(2));
  if (note) await app.locator("#adjust-note").fill(note);
  await app.locator("#adjust-submit").click();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const text = await app.locator("#adjust-status").textContent().catch(() => "");
    if (text && text.trim().length > 0) break;
    await sleep(250);
  }
  await app.locator("#cancel-button").click();
  await waitGone(app, "#editor", 10_000);
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

async function withdrawOffer(node) {
  const { app } = node;
  if (!(await visible(app, "#payment-withdraw"))) return false;
  console.log("[payment] withdrawing C's old offer");
  await waitUntil(
    "the withdraw control to enable",
    async () => (!(await app.locator("#payment-withdraw").isDisabled()) ? true : "disabled"),
    30_000,
  );
  await app.locator("#payment-withdraw").click();
  // The status region keeps stale text when it is hidden, so visibility of the
  // control (and the now-enabled Make-a-payment button) is the real signal.
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

async function offerPayment(node, address, user, amount) {
  const { app } = node;
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
  const [A, C, D] = opened;

  for (const node of opened) {
    console.log(
      `${node.node.name}: ${node.pubkey} address=${JSON.stringify(node.address)} consoleErrors=${node.errors.length}`,
    );
  }
  console.log("[A delegate]", JSON.stringify(await delegateFacts(A)));
  await A.app.locator("#details-summary").click(); // collapse again

  // Address book entries needed by slots/parents. D's board already names A.
  await ensureContact(A, "C-source", C.pubkey);
  await ensureContact(A, "D-destination", D.pubkey);
  await ensureContact(C, "D-destination", D.pubkey);
  await ensureContact(C, "A-root", A.pubkey);
  await ensureContact(D, "A-root", A.pubkey);

  // C's outstanding offer (src 03, dst 01) must go before the parent move.
  await withdrawOffer(C);

  // A is the root LCA: slot 0 -> C, slot 1 -> D, 100.00 against each.
  await saveDetails(A, 0, C.pubkey);
  await saveDetails(A, 1, D.pubkey);
  await adjustTo(A, 0, 10_000, "smoke issue to C");
  await adjustTo(A, 1, 10_000, "smoke issue to D");

  await setParent(C, A.pubkey);
  await setParent(D, A.pubkey);

  for (const node of [A, C, D]) await reload(node);
  const cAddr = (await C.app.locator("#board-address-value").textContent()).trim();
  const dAddr = (await D.app.locator("#board-address-value").textContent()).trim();
  console.log(`[topology] C address=${JSON.stringify(cAddr)} D address=${JSON.stringify(dAddr)}`);
  if (cAddr !== "0" || dAddr !== "1") {
    throw new Error(`unexpected addresses: C=${JSON.stringify(cAddr)} D=${JSON.stringify(dAddr)}`);
  }
  for (const node of [C, D]) {
    const amount = await node.app.locator("#parent-value-amount").textContent().catch(() => "?");
    console.log(`[topology] ${node.node.name} liability=${amount}`);
  }

  await offerPayment(C, "1", D.pubkey, "10.00");
  console.log("[payment] offered 10.00 from C to D at address 1");
  console.log("[payment] closing A's tab; only A's background delegate may act");
  await A.page.close();

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
    const A2 = await openNode(browser, A.node);
    opened.push(A2);
    console.log("[debug] A delegate", JSON.stringify(await delegateFacts(A2)));
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

  // Reopen A and read the delegate audit; it should name the LCA step.
  const A2 = await openNode(browser, A.node);
  opened.push(A2);
  const facts = await delegateFacts(A2);
  console.log("[delegate] A", JSON.stringify(facts));
  if (facts.audit.length === 0) {
    throw new Error("A's delegate audit is empty after the LCA pair");
  }

  // Restore the live D board to a root; its own slots/contacts stay untouched.
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
