import { chromium } from "playwright";

/**
 * Real-node smoke: v4.1 delegate auto-advance + v5 issue/burn.
 *
 * Topology: A (7511) root; B (7512) child of A; C (7513) and D (7509) children
 * of B. B is the LCA for C -> D. B's tab is closed before the payment, so the
 * only actor that can apply the LCA pair is B's background delegate.
 *
 * Run from ui/: node e2e/live-smoke.mjs
 */
const WEBAPP = "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const NODES = [
  { port: 7511, name: "A-root", allowCreate: true },
  { port: 7512, name: "B-lca", allowCreate: true },
  { port: 7513, name: "C-source", allowCreate: true },
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
    console.log(`[${name}] installing v8 delegate`);
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

async function offerPayment(node, address, user, amount) {
  const { app } = node;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (await app.locator("#payment-open").isDisabled())) {
    await sleep(400);
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

async function waitForComplete(node, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await paymentStatus(node);
    console.log(`[payment] ${last.slice(0, 140)}`);
    if (/complete/i.test(last)) return last;
    if (/reversed|blocked/i.test(last)) return last;
    await sleep(15_000);
  }
  throw new Error(`payment did not complete: ${last}`);
}

const browser = await chromium.launch({ headless: true });
const opened = [];
try {
  for (const spec of NODES) opened.push(await openNode(browser, spec));
  const [A, B, C, D] = opened;

  console.log("STAGE 1 OK");
  for (const node of opened) {
    console.log(`${node.node.name}: ${node.pubkey} address=${JSON.stringify(node.address)} consoleErrors=${node.errors.length}`);
  }

  // Address book entries needed by slots/parents.
  await ensureContact(A, "B-lca", B.pubkey);
  await ensureContact(B, "A-root", A.pubkey);
  await ensureContact(B, "C-source", C.pubkey);
  await ensureContact(B, "D-destination", D.pubkey);
  await ensureContact(C, "B-lca", B.pubkey);
  await ensureContact(D, "B-lca", B.pubkey);

  // A becomes root, and its slot 0 names B.
  await clearParent(A);
  await saveDetails(A, 0, B.pubkey);
  await setParent(B, A.pubkey);

  // The existing tree has C in B slot 3 (address 03) and D in B slot 1
  // (address 01). Keep those slots and set each liability to 100.00.
  await adjustTo(B, 3, 10_000, "smoke issue to C");
  await adjustTo(B, 1, 10_000, "smoke issue to D");

  // C and D point at B.
  await setParent(C, B.pubkey);
  await setParent(D, B.pubkey);

  for (const node of [A, B, C, D]) await reload(node);
  for (const node of [C, D]) {
    console.log(`${node.node.name} address=${JSON.stringify(await node.app.locator("#board-address-value").textContent())}`);
  }
  for (const node of [C, D]) {
    const amount = await node.app.locator("#parent-value-amount").textContent().catch(() => "?");
    const log = await node.app.locator("#parent-adjustments-list").textContent().catch(() => "");
    console.log(`${node.node.name} liability=${amount} log=${log.replace(/\s+/g, " ").slice(0, 160)}`);
  }

  // The previous run left a 10.00 offer on C. If it is still live, let the new
  // delegate advance it; otherwise create a fresh one. Closing B's tab before
  // either path means only B's background delegate can apply the LCA pair.
  const cPaymentDisabled = await C.app.locator("#payment-open").isDisabled();
  if (cPaymentDisabled) {
    const existing = (await C.app.locator("#payment-status").textContent().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    console.log(`[payment] existing: ${existing.slice(0, 180)}`);
    if (!/offered/i.test(existing)) {
      throw new Error(`C payment-open is disabled without an offered payment: ${existing}`);
    }
  } else {
    await offerPayment(C, "01", D.pubkey, "10.00");
    console.log("[payment] offered");
  }
  console.log("[payment] closing B's tab");
  await B.page.close();

  let status;
  try {
    status = await waitForComplete(C, 600_000);
  } catch (error) {
    const debugB = await openNode(browser, B.node);
    opened.push(debugB);
    await debugB.app.locator("#details-summary").click();
    await debugB.app.locator("#auto-advance-refresh").click();
    await sleep(1_500);
    console.log(
      "[debug] B scan=",
      await debugB.app.locator("#auto-advance-scan").textContent().catch(() => "?"),
      "subs=",
      await debugB.app.locator("#auto-advance-subs").textContent().catch(() => "?"),
      "error=",
      await debugB.app.locator("#auto-advance-last-error").textContent().catch(() => "?"),
      "audit=",
      (await debugB.app.locator("#auto-advance-audit").textContent().catch(() => "")).replace(/\s+/g, " ").slice(0, 300),
    );
    throw error;
  }
  console.log(`[payment] final: ${status}`);

  await reload(C);
  await reload(D);
  const cLiability = await C.app.locator("#parent-value-amount").textContent().catch(() => "?");
  const dLiability = await D.app.locator("#parent-value-amount").textContent().catch(() => "?");
  console.log(`[result] C liability=${cLiability} D liability=${dLiability}`);
  if (cLiability.trim() !== "90.00" || dLiability.trim() !== "110.00") {
    throw new Error(`unexpected post-payment liabilities: C=${cLiability} D=${dLiability}`);
  }

  // Reopen B and read the delegate's audit; it should name the LCA step.
  const B2 = await openNode(browser, B.node);
  opened.push(B2);
  await B2.app.locator("#details-summary").click();
  await B2.app.locator("#auto-advance-refresh").click();
  await sleep(1_500);
  const scan = await B2.app.locator("#auto-advance-scan").textContent().catch(() => "?");
  const subs = await B2.app.locator("#auto-advance-subs").textContent().catch(() => "?");
  const audit = await B2.app.locator("#auto-advance-audit").textContent().catch(() => "");
  const lastError = await B2.app.locator("#auto-advance-last-error").textContent().catch(() => "");
  console.log(`[delegate] scan=${scan} subs=${subs} audit=${audit.replace(/\s+/g, " ").slice(0, 200)} error=${lastError}`);

  // Restore the live D board to a root; its own slots/contacts were untouched.
  await clearParent(D);
  await reload(D);
  const dParent = await D.app.locator("#parent-name").textContent().catch(() => "?");
  console.log(`[cleanup] D parent=${dParent} address=${JSON.stringify(await D.app.locator("#board-address-value").textContent())}`);

  console.log("STAGE 2 OK");
} finally {
  await Promise.all(opened.map(({ context }) => context.close().catch(() => {})));
  await browser.close();
}
