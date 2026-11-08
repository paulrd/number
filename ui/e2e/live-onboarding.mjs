import { chromium } from "playwright";

/**
 * Live two-identity onboarding smoke (P4d).
 *
 * Two identities, each with its own delegate seed:
 *   owner:     OWNER_PORT / OWNER_WEBAPP (creates or reuses a root zone)
 *   candidate: CANDIDATE_PORT / CANDIDATE_WEBAPP (opens ?root=<owner>)
 *
 * The successful 2026-11-08 run used two app origins on the same live node
 * (7511) so both identities share the node's contract store. A two-node run
 * needs `ADMIT_CODE=1`: the owner copies the signed admission code and the
 * candidate opens it, so the candidate never depends on the owner's zone
 * reaching their node (Freenet GET serves the local copy; see
 * `reports/freenet-stale-contract-reads.md`).
 *
 * Flow: request -> owner interview + message -> Admit through the region
 * designation -> copy admission code (ADMIT_CODE=1) -> Finish admission ->
 * candidate opens ?admit=<code> -> Sign and join.
 *
 * Run from ui/:
 *   OWNER_WEBAPP=... CANDIDATE_WEBAPP=... OWNER_PORT=7511 CANDIDATE_PORT=7512 \
 *     ADMIT_CODE=1 node e2e/live-onboarding.mjs
 */
const OWNER_WEBAPP =
  process.env.OWNER_WEBAPP ?? process.env.WEBAPP_ID ??
  "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const CANDIDATE_WEBAPP = process.env.CANDIDATE_WEBAPP ?? OWNER_WEBAPP;
const OWNER_PORT = Number(process.env.OWNER_PORT ?? 7520);
const CANDIDATE_PORT = Number(process.env.CANDIDATE_PORT ?? 7521);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = (port, webapp) =>
  `http://127.0.0.1:${port}/v1/contract/web/${webapp}/`;

async function visible(app, selector) {
  try {
    return await app.locator(selector).isVisible();
  } catch {
    return false;
  }
}

async function waitFor(app, selector, timeoutMs, label = selector) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await visible(app, selector)) return;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitGone(app, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await visible(app, selector))) return;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${selector} to disappear`);
}

async function answerPrompts(port, stop) {
  const origin = `http://127.0.0.1:${port}`;
  while (!stop()) {
    try {
      const items = await (await fetch(`${origin}/permission/pending`)).json();
      if (items.length > 0) {
        await fetch(`${origin}/permission/${encodeURIComponent(items[0].nonce)}/respond`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ index: 0 }),
        });
        console.log(`[${port}] answered a node permission prompt`);
      }
    } catch {
      // The node may still be starting; retry.
    }
    await sleep(500);
  }
}

async function openApp(browser, port, webapp, query = "") {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  const app = page.frameLocator("iframe#app");

  async function firstRun(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await app.locator("#delegate-install[open]").count().catch(() => 0)) return "install";
      if (await app.locator("#identity-setup[open]").count().catch(() => 0)) return "identity";
      const pill = await app.locator("#status-pill").getAttribute("data-status").catch(() => null);
      if (pill === "ready") return "ready";
      if (pill === "error") return "error";
      await sleep(500);
    }
    return "none";
  }

  let reason = "none";
  for (let attempt = 0; attempt < 2 && (reason === "none" || reason === "error"); attempt += 1) {
    await page.goto(`${base(port, webapp)}${query}`, { waitUntil: "domcontentloaded" });
    reason = await firstRun(180_000);
    if (reason === "none" || reason === "error") {
      console.log(`[${port}] shell not ready (${reason}); reloading`);
      await sleep(2_000);
    }
  }
  if (reason === "none" || reason === "error") {
    throw new Error(`[${port}] the app shell never reached a first-run state`);
  }

  let stopPrompts = false;
  const promptLoop = answerPrompts(port, () => stopPrompts);

  if (reason === "install") {
    console.log(`[${port}] installing the delegate`);
    await app.locator("#delegate-install-button").click();
    await waitGone(app, "#delegate-install", 240_000);
    // The identity probe runs after the install; wait for its outcome.
    reason = await firstRun(180_000);
  }

  if (reason === "identity") {
    console.log(`[${port}] creating a fresh identity`);
    await app.locator("#identity-create").click();
    await waitGone(app, "#identity-setup", 120_000);
  }

  stopPrompts = true;
  await promptLoop;

  const readyDeadline = Date.now() + 240_000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    ready = (await app.locator('#status-pill[data-status="ready"]').count().catch(() => 0)) > 0;
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error(`[${port}] the app never reached ready`);
  let id = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    id = await app.locator("#identity-short").getAttribute("title").catch(() => null);
    if (id && /^[0-9a-f]{64}$/.test(id)) break;
    await sleep(400);
  }
  if (!id || !/^[0-9a-f]{64}$/.test(id)) throw new Error(`[${port}] no owner id`);
  console.log(`[${port}] owner ${id.slice(0, 12)}…`);

  return { context, page, app, id, errors };
}

async function openAdvanced(app) {
  if (!(await app.locator("#advanced-view").isVisible())) {
    await app.locator("#view-toggle").click();
  }
  await waitFor(app, "#advanced-view", 30_000, "advanced view");
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const allErrors = [];
  try {
    const owner = await openApp(browser, OWNER_PORT, OWNER_WEBAPP);
    const candidate = await openApp(
      browser,
      CANDIDATE_PORT,
      CANDIDATE_WEBAPP,
      `?root=${owner.id}`,
    );
    allErrors.push(...owner.errors, ...candidate.errors);

    // The candidate's root link opens after the first-run prompts.
    await waitFor(candidate.app, "#join-dialog", 120_000, "join dialog");
    await waitFor(candidate.app, "#join-place-title", 120_000, "place step");
    console.log("[candidate] root accepted; choosing a point");

    await candidate.app.locator("#join-lat").fill("10");
    await candidate.app.locator("#join-lng").fill("10");
    await candidate.app.locator("#join-point").click();
    await waitFor(candidate.app, "#join-result", 120_000, "match result");
    await candidate.app.locator("#join-note").fill("Live smoke from the candidate");
    await candidate.app.locator("#join-submit").click();
    await waitFor(candidate.app, "#join-status-queued", 120_000, "queued status");
    console.log("[candidate] request queued");

    // Give the request time to propagate, then the owner moderates it.
    await openAdvanced(owner.app);
    await owner.app.locator("#requests-open").click();
    await waitFor(owner.app, "#requests-dialog", 30_000, "requests dialog");

    let row = false;
    const rowDeadline = Date.now() + 180_000;
    while (!row && Date.now() < rowDeadline) {
      await owner.app.locator("#requests-refresh").click().catch(() => {});
      await sleep(3_000);
      row = (await owner.app.locator(".requests-row").count()) > 0;
    }
    if (!row) throw new Error("the owner never saw the request");
    console.log("[owner] request visible; starting the interview");

    await owner.app.locator(".requests-interview").first().click();
    await waitFor(owner.app, "#interview-section", 60_000, "interview");
    await owner.app.locator("#interview-message-input").fill("Hello from the owner");
    await owner.app.locator("#interview-send").click();
    await waitFor(owner.app, "#interview-messages >> text=Hello from the owner", 60_000, "interview message");

    await owner.app.locator("#interview-admit").click();
    const cardsDeadline = Date.now() + 120_000;
    let cardCount = 0;
    while (Date.now() < cardsDeadline && cardCount === 0) {
      cardCount = await owner.app.locator("#region-assign-cards .region-assign-card").count().catch(() => 0);
      if (cardCount === 0) await sleep(500);
    }
    if (cardCount === 0) throw new Error("the assign picker never showed cells");
    const freeRadio = owner.app.locator('#region-assign-cards input[type="radio"]:not([disabled])').first();
    await freeRadio.check();
    await owner.app.locator("#region-assign-choose").click();
    await waitFor(owner.app, "#editor", 30_000, "slot editor");
    const contact = await owner.app.locator("#contact-select").inputValue();
    if (contact !== candidate.id) {
      throw new Error(`slot editor did not prefill the candidate (got ${contact})`);
    }
    await owner.app.locator("#save-button").click();
    await waitGone(owner.app, "#editor", 60_000);

    await owner.app.locator("#interview-refresh").click().catch(() => {});
    await waitFor(owner.app, "#interview-admission", 60_000, "admission result");
    const slotText = (await owner.app.locator("#interview-admission-result").textContent()) ?? "";
    const regionText = (await owner.app.locator("#interview-admission-region").textContent()) ?? "";
    console.log(`[owner] ${slotText.trim()} / ${regionText.trim()}`);

    // Portable admission code: the supported cross-node handoff. The owner
    // copies the signed designation and the candidate pastes it, so the
    // candidate never needs the owner's zone to reach their node.
    let admissionCode = null;
    if (process.env.ADMIT_CODE === "1") {
      await owner.context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await owner.app.locator("#admission-code-copy").click();
      await waitFor(owner.app, "#admission-code-copy-status", 20_000, "admission code status");
      admissionCode = await owner.page.evaluate(() => navigator.clipboard.readText());
      if (!admissionCode.startsWith("tally-admit1.")) {
        throw new Error("the owner's copy did not yield an admission code");
      }
      console.log("[owner] admission code copied");
    }

    await owner.app.locator("#interview-finish").click();
    await waitFor(owner.app, "#interview-finish-confirm", 30_000, "finish confirm");
    await owner.app.locator("#interview-finish-confirm-button").click();
    await waitGone(owner.app, "#interview-section", 60_000);
    console.log("[owner] admission finished; membership rotated");

    // Candidate admission. With ADMIT_CODE the code is the handoff and no
    // target-zone read is involved; otherwise wait for the watch or Check again.
    let admitted = false;
    if (admissionCode !== null) {
      console.log("[candidate] opening the admission code on its own node");
      await candidate.page.goto(
        `${base(CANDIDATE_PORT, CANDIDATE_WEBAPP)}?admit=${encodeURIComponent(admissionCode)}`,
        { waitUntil: "domcontentloaded" },
      );
      await waitFor(candidate.app, "#join-status-admitted", 120_000, "admitted from code");
      await waitFor(candidate.app, "#join-admitted-source", 20_000, "admission source");
      const source = (await candidate.app.locator("#join-admitted-source").textContent()) ?? "";
      if (!source.includes("Admission code")) {
        throw new Error(`unexpected admission source: ${source.trim()}`);
      }
      admitted = true;
    } else {
      admitted = await visible(candidate.app, "#join-status-admitted");
      if (!admitted && process.env.EXPECT_WATCH === "1") {
        console.log("[candidate] waiting on the target-zone watch");
        const watchDeadline = Date.now() + 120_000;
        while (!admitted && Date.now() < watchDeadline) {
          await sleep(1_000);
          admitted = await visible(candidate.app, "#join-status-admitted");
        }
        console.log(`[candidate] watch auto-update: ${admitted}`);
      }
      if (!admitted) {
        const admitDeadline = Date.now() + 180_000;
        while (!admitted && Date.now() < admitDeadline) {
          await candidate.app.locator("#join-status-check").click().catch(() => {});
          await sleep(4_000);
          admitted = await visible(candidate.app, "#join-status-admitted");
        }
        console.log(`[candidate] manual Check again: ${admitted}`);
      }
    }
    if (!admitted) throw new Error("the candidate never saw the admission");
    const admittedSlot = ((await candidate.app.locator("#join-admitted-slot").textContent()) ?? "").trim();
    const admittedAddress = ((await candidate.app.locator("#join-admitted-address").textContent()) ?? "").trim();
    const blocked = await visible(candidate.app, "#join-admitted-blocked");
    console.log(`[candidate] admitted: ${admittedSlot} / ${admittedAddress} (blocked=${blocked})`);
    if (blocked) throw new Error("the candidate's own zone was not admissible");

    await candidate.app.locator("#join-admitted-sign").click();
    await waitFor(candidate.app, "#join-admitted-done", 120_000, "join completion");
    console.log("[candidate] signed parent; join complete");

    // Both sides should now report the mutual address, not a one-sided link.
    await candidate.app.locator("#join-close").click().catch(() => {});
    await openAdvanced(candidate.app);
    await sleep(2_000);
    const candidateAddress = ((await candidate.app.locator("#board-address-value").textContent()) ?? "").trim();
    await owner.app.locator("#requests-close").click().catch(() => {});
    await owner.app.locator("#view-toggle").click().catch(() => {});
    await sleep(1_000);
    const ownerSlotText = ((await owner.app.locator("#board").textContent()) ?? "").replace(/\s+/g, " ");
    console.log(JSON.stringify({
      candidateId: candidate.id,
      candidateAddress,
      ownerHasCandidate: ownerSlotText.includes(candidate.id.slice(0, 8)),
      errors: allErrors,
    }, null, 2));
    if (!candidateAddress) throw new Error("the candidate has no address after signing");
    if (allErrors.length > 0) throw new Error(`console errors: ${allErrors.join(" | ")}`);
    console.log("LIVE ONBOARDING OK");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
