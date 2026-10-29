import { chromium } from "playwright";

/**
 * Background auto-advance readiness across the live nodes.
 *
 * For each node: the number app must hold the node-enforced Background grant,
 * and its delegate must be configured for the board's current address, be
 * auto-advance enabled, have completed at least one scan, subscribe to at
 * least one board, and report no last error.
 *
 * Read-only. Run from ui/: node e2e/readiness.mjs [port...]
 * Exits 1 if any node is not ready.
 */
const WEBAPP = "BZBEeX3Gd7aj5V1KCxFPsWkx4T8j8PUBMvJfGPtvyi4k";
const DEFAULT_PORTS = [7509, 7511, 7512, 7513];
const ports = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n));
const targets = ports.length > 0 ? ports : DEFAULT_PORTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function grantState(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/permission/grants`);
    const body = await response.json();
    const grant = (body.grants ?? []).find(
      (row) => row.app === WEBAPP && row.capability === "background",
    );
    return grant?.state ?? "missing";
  } catch {
    return "unreachable";
  }
}

async function boardFacts(app) {
  await app.locator("#details-summary").click();
  await app.locator("#auto-advance-refresh").click().catch(() => {});
  await sleep(1_500);
  const text = async (id) =>
    (await app.locator(id).textContent().catch(() => "?")).replace(/\s+/g, " ").trim();
  const scanText = await text("#auto-advance-scan");
  const scanMatch = /^pass\s+([\d,]+)$/i.exec(scanText);
  const subsText = await text("#auto-advance-subs");
  const subsMatch = /^(\d+)\s+board/i.exec(subsText);
  return {
    owner: (await app.locator("#identity-short").getAttribute("title").catch(() => "")) ?? "",
    boardAddress: (await app.locator("#board-address-value").textContent().catch(() => "")).trim(),
    state: await text("#auto-advance-state"),
    delegateAddress: await text("#auto-advance-address"),
    autoAdvance: await app.locator("#auto-advance-toggle").isChecked().catch(() => false),
    scan: scanMatch ? Number(scanMatch[1].replace(/,/g, "")) : 0,
    subs: subsMatch ? Number(subsMatch[1]) : 0,
    error: await text("#auto-advance-last-error"),
  };
}

const browser = await chromium.launch({ headless: true });
const rows = [];
let failed = false;
try {
  for (const port of targets) {
    const grant = await grantState(port);
    const context = await browser.newContext();
    const page = await context.newPage();
    const app = page.frameLocator("iframe#app");
    let facts = null;
    try {
      await page.goto(`http://127.0.0.1:${port}/v1/contract/web/${WEBAPP}/`, {
        waitUntil: "domcontentloaded",
      });
      await app.locator('#status-pill[data-status="ready"]').waitFor({ timeout: 180_000 });
      await sleep(1_200);
      facts = await boardFacts(app);
    } finally {
      await context.close();
    }

    const displayAddress = facts.boardAddress === "" ? "root" : facts.boardAddress;
    const problems = [];
    if (grant !== "granted") problems.push(`grant: ${grant}`);
    if (!facts.owner) problems.push("no owner");
    if (!facts.state.startsWith("Configured")) problems.push(`state: ${facts.state}`);
    if (!facts.autoAdvance) problems.push("auto-advance off");
    if (facts.scan === 0) problems.push("no scans");
    if (facts.subs === 0) problems.push("no subscriptions");
    if (facts.error) problems.push(facts.error);
    if (facts.delegateAddress !== displayAddress) {
      problems.push(`address: delegate ${facts.delegateAddress} != board ${displayAddress}`);
    }
    if (problems.length > 0) failed = true;

    rows.push({
      port,
      ready: problems.length === 0,
      grant,
      owner: facts.owner.slice(0, 12),
      address: displayAddress,
      scan: facts.scan,
      subs: facts.subs,
      problems,
    });
  }
} finally {
  await browser.close();
}

for (const row of rows) {
  const status = row.ready ? "READY" : "FAIL ";
  const problems = row.problems.length > 0 ? `  (${row.problems.join("; ")})` : "";
  console.log(
    `${status} :${row.port} grant=${row.grant} owner=${row.owner} address=${JSON.stringify(row.address)} scan=pass ${row.scan} subs=${row.subs}${problems}`,
  );
}
if (failed) {
  console.error("READINESS FAILED");
  process.exit(1);
}
console.log("READINESS OK");
