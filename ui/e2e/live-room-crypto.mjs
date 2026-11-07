import { chromium } from "playwright";
import bs58 from "bs58";
import { blake3 } from "@noble/hashes/blake3";
import { ContractKey, FreenetWsApi, GetRequest } from "@freenetorg/freenet-stdlib";

/**
 * Live encrypted-room smoke (P3c).
 *
 * A (7511) enables encryption on its members room (A + B), sends a secret, and
 * B (7512) decrypts it. C (7513), a non-member, sees no plaintext. The raw room
 * state is read over the node's WebSocket to prove the body is ciphertext.
 *
 * Run from ui/: node e2e/live-room-crypto.mjs
 */
const WEBAPP = "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const ROOM_CODE = "DWAtsfi3Ed5kGNZiXFxfU1AfjfGe83iAwb1BWHttFBPM";
const ownerPort = 7511;
const childPort = 7512;
const outsiderPort = 7513;
const stamp = Date.now();
const secret = `encrypted hello ${stamp}`;

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
    await install.click();
    await app.locator("#delegate-install").waitFor({ state: "hidden", timeout: 180_000 });
  }
  await app.locator('#status-pill[data-status="ready"]').waitFor({ state: "attached", timeout: 180_000 });
  return { app };
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

async function waitFor(predicate, timeout = 40_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function readRoomState(port, owner) {
  const code = bs58.decode(ROOM_CODE);
  const ownerBytes = Uint8Array.from(Buffer.from(owner, "hex"));
  const params = concat(new TextEncoder().encode("ZMR1"), ownerBytes);
  const instance = blake3(concat(code, params));
  const key = new ContractKey(instance, code);
  let state = null;
  let resolveState;
  const ready = new Promise((resolve) => (resolveState = resolve));
  const handler = new Proxy(
    {
      onOpen: () => api.get(new GetRequest(key)),
      onContractGet: (response) => {
        try {
          state = JSON.parse(new TextDecoder().decode(Uint8Array.from(response.state)));
        } catch {
          state = null;
        }
        resolveState();
      },
      onErr: () => resolveState(),
    },
    { get: (t, p) => (p in t ? t[p] : () => {}) },
  );
  const api = new FreenetWsApi(new URL(`ws://127.0.0.1:${port}/v1/contract/command`), handler, "");
  await Promise.race([ready, new Promise((r) => setTimeout(r, 15_000))]);
  return state;
}

try {
  const a = await openNode(ownerPort);
  const aId = await ownerId(a.app);
  if (!/^[0-9a-f]{64}$/.test(aId)) throw new Error(`A owner id is not 64-hex: ${aId}`);
  console.log(`A owner: ${aId}`);
  await openAdvanced(a.app);
  await a.app.locator("#room-open").click();
  await a.app.locator("#room-dialog").waitFor({ state: "visible", timeout: 30_000 });
  await a.app.locator("#room-membership-state").waitFor({ state: "visible", timeout: 60_000 });

  const membership = await a.app.locator("#room-membership-state").getAttribute("data-state");
  if (membership !== "match") throw new Error(`A membership is ${membership}, expected match`);

  const encryptButton = a.app.locator("#room-encryption-action");
  const encryptLabel = ((await encryptButton.innerText().catch(() => "")) ?? "").trim();
  console.log(`A encryption action: ${encryptLabel || "(hidden)"}`);
  if (/enable encryption/i.test(encryptLabel)) {
    await encryptButton.click();
    const encrypted = await waitFor(
      async () => (await a.app.locator("#room-encryption-state").getAttribute("data-state")) === "encrypted",
      60_000,
    );
    if (!encrypted) fail("A did not reach an encrypted epoch");
    else console.log("A enabled encryption");
  } else if (!/rotate key/i.test(encryptLabel)) {
    fail("A has no encryption action; delegate v12 may not be active");
  }

  await a.app.locator("#room-message-input").fill(secret);
  await a.app.locator("#room-send").click();
  const aSees = await waitFor(async () =>
    (await a.app.locator("#room-messages").innerText().catch(() => "")).includes(secret),
  );
  if (!aSees) fail("A did not see its own encrypted message");
  const badge = await a.app
    .locator('.room-message[data-encryption="encrypted"]')
    .count()
    .catch(() => 0);
  if (badge === 0) fail("A's message has no encrypted badge");

  const raw = await readRoomState(ownerPort, aId);
  if (raw === null) {
    fail("could not read the raw room state");
  } else {
    const latest = raw.messages?.[raw.messages.length - 1];
    const body = latest?.body ?? "";
    const plaintextHex = Buffer.from(secret, "utf8").toString("hex");
    if (!body.startsWith("01")) fail(`latest body does not start with 01: ${body.slice(0, 16)}`);
    if (body.includes(plaintextHex)) fail("raw body contains the plaintext");
    else console.log("raw body is ciphertext (0x01, no plaintext)");
  }

  const b = await openNode(childPort, `?room=${aId}`);
  const bId = await ownerId(b.app);
  await b.app.locator("#room-dialog").waitFor({ state: "visible", timeout: 60_000 });
  const bSees = await waitFor(async () =>
    (await b.app.locator("#room-messages").innerText().catch(() => "")).includes(secret),
    45_000,
  );
  if (!bSees) fail("B could not decrypt A's message");
  else console.log("B decrypted A's message");

  const c = await openNode(outsiderPort, `?room=${aId}`);
  await c.app.locator("#room-dialog").waitFor({ state: "visible", timeout: 60_000 });
  const unreadableSeen = await waitFor(async () => {
    const body = await c.app.locator("#room-messages").innerText().catch(() => "");
    if (body.includes(secret)) {
      fail("C saw the plaintext");
      return true;
    }
    return (
      (await c.app
        .locator('.room-message[data-encryption="unreadable"]')
        .count()
        .catch(() => 0)) > 0
    );
  }, 45_000);
  if (!unreadableSeen) fail("C has no unreadable-epoch marker");
  else console.log("C saw no plaintext and shows the message as unreadable");

  console.log(failed ? "LIVE ENCRYPTED ROOM SMOKE FAILED" : "LIVE ENCRYPTED ROOM SMOKE OK");
} catch (error) {
  fail(String(error?.stack ?? error));
  console.log("LIVE ENCRYPTED ROOM SMOKE FAILED");
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
process.exit(failed ? 1 : 0);
