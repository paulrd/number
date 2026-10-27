import { expect, test } from "@playwright/test";

/**
 * Gateway tier: the deployed/local web container shell plus the sandboxed
 * iframe. This is read-only liveness: it does not need an owner identity or a
 * disposable board, and it does not mutate contract state.
 *
 * Run with:
 *   FREENET_BASE_URL=http://127.0.0.1:7510/v1/contract/web/<id>/ \
 *     npm run test:e2e:gateway
 */
const BASE_URL = process.env.FREENET_BASE_URL;
const SKIP = !BASE_URL || !/\/v1\/contract\/web\//.test(BASE_URL);

const FATAL_CONSOLE_PATTERNS = [
  /Content Security Policy/i,
  /Refused to (load|apply|execute|connect)/i,
  /Failed to load resource/i,
  /net::ERR_/i,
];

test.describe("gateway smoke", () => {
  test.skip(SKIP, "set FREENET_BASE_URL to a /v1/contract/web/... URL");

  test("shell, iframe, identity, and board mount", async ({ page }) => {
    const fatal: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        FATAL_CONSOLE_PATTERNS.some((pattern) => pattern.test(message.text()))
      ) {
        fatal.push(message.text());
      }
    });
    page.on("pageerror", (error) => fatal.push(String(error)));
    page.on("requestfailed", (request) =>
      fatal.push(
        `requestfailed: ${request.url()} (${request.failure()?.errorText})`,
      ),
    );

    // Absolute URL: a leading "/" would resolve to the node dashboard and drop
    // the /v1/contract/web/<id>/ path.
    await page.goto(BASE_URL!, { waitUntil: "domcontentloaded" });

    await expect(page.locator("iframe#app")).toHaveAttribute(
      "src",
      /__sandbox=1/,
      { timeout: 10_000 },
    );

    const app = page.frameLocator("iframe#app");
    await expect(
      app.getByRole("heading", { level: 1, name: "number" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(app.locator("#status-pill")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 30_000 },
    );
    await expect(app.locator("#identity-short")).not.toHaveText("Not available");
    await expect(app.locator("#contract-short")).not.toHaveText("Not derived");

    expect(fatal, `fatal console/network errors:\n${fatal.join("\n")}`).toEqual([]);
  });
});
