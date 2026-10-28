import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { MOCK_CHILD_ID, MOCK_PARENT_ID } from "../src/mock";

/**
 * Offline tier: the real built UI, the real state codec/merge code, and the
 * in-memory mock backend. No Freenet node or gateway is involved.
 */

const ALICE_ID = "ABCDEF0123456789".repeat(4);
const BOB_ID = "2222222222222222".repeat(4);
const GHOST_ID = "3333333333333333".repeat(4);
const CAROL_ID = "4444444444444444".repeat(4);

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

/** Add a contact through the header address book and close it again. */
async function addContact(
  page: Page,
  label: string,
  rawUserId: string,
): Promise<void> {
  await page.locator("#contacts-open").click();
  await expect(page.locator("#contacts-dialog")).toBeVisible();
  await page.locator("#contact-label-input").fill(label);
  await page.locator("#contact-userid-input").fill(rawUserId);
  await page.locator("#contact-add-button").click();
  await expect(page.locator("#contacts-list")).toContainText(label);
  // The saved id is normalised to lowercase on the way in.
  await expect(
    page
      .locator("#contacts-list code")
      .filter({ hasText: rawUserId.toLowerCase().slice(0, 8) }),
  ).toBeVisible();
  await page.locator("#contacts-done").click();
  await expect(page.locator("#contacts-dialog")).toBeHidden();
}

test("board mounts, adds a contact, saves a decimal slot, and passes axe", async ({
  page,
}) => {
  const errors = watchConsole(page);
  const aliceId = ALICE_ID.toLowerCase();

  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "number" })).toBeVisible();
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await expect(page.locator("#identity-short")).not.toHaveText("Not available");
  await expect(page.locator("#contract-short")).not.toHaveText("Not derived");
  await expect(page.locator(".slot")).toHaveCount(8);
  await expect(page.locator("#contacts-count")).toHaveText("0");

  // The editor starts without contacts: a clear hint and a disabled Save.
  await page.locator(".slot").first().click();
  await expect(page.locator("#value-input")).toBeVisible();
  await expect(page.locator("#contact-hint")).toContainText("No contacts yet");
  await expect(page.locator("#save-button")).toBeDisabled();

  // Add the contact from the editor's own button. A successful add selects it
  // and hands focus back to the editor.
  await page.locator("#contact-add").click();
  await expect(page.locator("#contacts-dialog")).toBeVisible();
  await expect(page.locator("#contacts-title")).toBeFocused();
  await page.locator("#contact-label-input").fill("Alice");
  await page.locator("#contact-userid-input").fill(ALICE_ID);
  await page.locator("#contact-add-button").click();
  await expect(page.locator("#contacts-dialog")).toBeHidden();
  await expect(page.locator("#contact-select")).toHaveValue(aliceId);
  await expect(page.locator("#contact-select")).toBeFocused();
  await expect(page.locator("#contact-hint")).toBeHidden();
  await expect(page.locator("#save-button")).toBeEnabled();

  // 12.5 hundredths -> the board always shows two decimals.
  await page.locator("#value-input").fill("12.5");
  await page.locator("#save-button").click();
  await expect(page.locator(".slot .slot-value").first()).toHaveText("12.50");
  await expect(page.locator(".slot .slot-label").first()).toHaveText("Alice");
  await expect(page.locator("#contacts-count")).toHaveText("1");

  // Reopening shows the normalised decimal, not the typed shorthand.
  await page.locator(".slot").first().click();
  await expect(page.locator("#value-input")).toHaveValue("12.50");
  await expect(page.locator("#contact-select")).toHaveValue(aliceId);
  await page.locator("#cancel-button").click();

  // The header control opens the same address book.
  await page.locator("#contacts-open").click();
  await expect(page.locator("#contacts-dialog")).toBeVisible();
  await expect(page.locator("#contacts-list")).toContainText("Alice");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  await page.locator("#contacts-done").click();

  // Removing a contact that slots use warns first, then the grid shows the
  // shortened key instead of a stale label.
  await page.locator("#contacts-open").click();
  await page.locator(".contacts-remove").click();
  await expect(page.locator("#contacts-confirm")).toBeVisible();
  await expect(page.locator("#contacts-confirm-text")).toContainText(
    "unknown contact",
  );
  await page.locator("#contacts-confirm-remove").click();
  await expect(page.locator("#contacts-list")).not.toContainText("Alice");
  await expect(page.locator("#contacts-count")).toHaveText("0");
  await page.locator("#contacts-done").click();

  const firstLabel = page.locator(".slot .slot-label").first();
  await expect(firstLabel).toHaveText("Unknown · abcdef01");
  await expect(firstLabel).toHaveAttribute("title", aliceId);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("a blank value saves as 0.00 and more than two decimals is rejected", async ({
  page,
}) => {
  const errors = watchConsole(page);
  const aliceId = ALICE_ID.toLowerCase();

  await page.goto("/");
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await addContact(page, "Alice", ALICE_ID);
  await addContact(page, "Bob", BOB_ID);
  await expect(page.locator("#contacts-count")).toHaveText("2");

  // Blank value: optional, stored as zero hundredths.
  await page.locator(".slot").first().click();
  await page.locator("#contact-select").selectOption(aliceId);
  await page.locator("#value-input").fill("");
  await page.locator("#save-button").click();
  await expect(page.locator(".slot .slot-value").first()).toHaveText("0.00");
  await expect(page.locator(".slot .slot-label").first()).toHaveText("Alice");

  // Three decimal places never reaches the board. A different child board is
  // used because a child id may only appear in one slot.
  await page.locator(".slot").nth(1).click();
  await page.locator("#contact-select").selectOption(BOB_ID.toLowerCase());
  await page.locator("#value-input").fill("1.234");
  await expect(page.locator("#value-warning")).toBeVisible();
  await expect(page.locator("#value-warning")).toContainText("2 decimal places");
  await expect(page.locator("#value-input")).toHaveAttribute("aria-invalid", "true");

  await page.locator("#save-button").click();
  await expect(page.locator("#editor-error")).toBeVisible();
  await expect(page.locator(".slot .slot-value").nth(1)).toHaveText("+");

  // Correcting the value saves it.
  await page.locator("#value-input").fill("1.23");
  await expect(page.locator("#value-warning")).toBeHidden();
  await page.locator("#save-button").click();
  await expect(page.locator(".slot .slot-value").nth(1)).toHaveText("1.23");

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("saves and reopens the full cents range exactly", async ({ page }) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await addContact(page, "Bob", BOB_ID);
  await addContact(page, "Carol", CAROL_ID);
  const bobId = BOB_ID.toLowerCase();

  // 92233720368547758.07 is i64 max cents and not representable as a JS number.
  const max = "92233720368547758.07";
  await page.locator(".slot").first().click();
  await page.locator("#contact-select").selectOption(bobId);
  await page.locator("#value-input").fill(max);
  await page.locator("#save-button").click();
  await expect(page.locator(".slot .slot-value").first()).toHaveText(max);

  await page.locator(".slot").first().click();
  await expect(page.locator("#value-input")).toHaveValue(max);
  await page.locator("#cancel-button").click();

  // One hundredth past the bound is rejected inline, not rounded. A different
  // child board is used because a child id may only appear in one slot.
  await page.locator(".slot").nth(1).click();
  await page.locator("#contact-select").selectOption(CAROL_ID.toLowerCase());
  await page.locator("#value-input").fill("92233720368547758.08");
  await expect(page.locator("#value-warning")).toBeVisible();
  await expect(page.locator("#value-warning")).toContainText(
    "92233720368547758",
  );
  await page.locator("#save-button").click();
  await expect(page.locator("#editor-error")).toBeVisible();
  await expect(page.locator(".slot .slot-value").nth(1)).toHaveText("+");

  // The negative bound is exact too.
  const min = "-92233720368547758.08";
  await page.locator("#value-input").fill(min);
  await expect(page.locator("#value-warning")).toBeHidden();
  await page.locator("#save-button").click();
  await expect(page.locator(".slot .slot-value").nth(1)).toHaveText(min);

  await page.locator(".slot").nth(1).click();
  await expect(page.locator("#value-input")).toHaveValue(min);
  await page.locator("#cancel-button").click();

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("navigates boards as a tree, sets a parent, and rejects duplicate children", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await expect(page.locator("#read-only-badge")).toBeHidden();
  await expect(page.locator("#parent-name")).toHaveText("Root");
  await expect(page.locator("#breadcrumb-list .breadcrumb-current")).toHaveText(
    "Your board",
  );

  await addContact(page, "Child", MOCK_CHILD_ID);
  await addContact(page, "Parent", MOCK_PARENT_ID);
  await addContact(page, "Ghost", GHOST_ID);
  await expect(page.locator("#contacts-count")).toHaveText("3");

  // A child slot is Linked when both signed sides agree.
  await page.locator(".slot").first().click();
  await page.locator("#contact-select").selectOption(MOCK_CHILD_ID);
  await expect(page.locator("#child-link-status")).toHaveText("Linked");
  await expect(page.locator("#child-link-detail")).toContainText(
    "lists this board as its parent",
  );
  await page.locator("#value-input").fill("3.25");
  await page.locator("#save-button").click();
  await expect(page.locator(".slot .slot-value").first()).toHaveText("3.25");
  await expect(page.locator(".slot .slot-label").first()).toHaveText("Child");

  // Open the child board read-only from the editor, then return home.
  await page.locator(".slot").first().click();
  await expect(page.locator("#child-link-status")).toHaveText("Linked");
  await page.locator("#child-open").click();
  await expect(page.locator("#read-only-badge")).toBeVisible();
  await expect(page.locator("#board-home")).toBeVisible();
  await expect(page.locator("#contacts-open")).toBeDisabled();
  await expect(page.locator("#parent-edit")).toBeHidden();
  await expect(page.locator("#parent-clear")).toBeHidden();
  await expect(page.locator("#board-mode")).toContainText("Read-only");
  await expect(page.locator("#breadcrumb-list .breadcrumb-current")).toHaveText(
    "Child",
  );
  await expect(page.locator("#breadcrumb-list")).toContainText("Your board");
  // The fixture child has no slots, and they are not editable.
  await expect(page.locator(".slot").first()).toBeDisabled();

  await page.locator("#board-home").click();
  await expect(page.locator("#read-only-badge")).toBeHidden();
  await expect(page.locator("#breadcrumb-list .breadcrumb-current")).toHaveText(
    "Your board",
  );

  // A one-sided child link is Pending: the parent fixture exists, but its own
  // parent is empty, so it has not added this board as a parent.
  await page.locator(".slot").nth(1).click();
  await page.locator("#contact-select").selectOption(MOCK_PARENT_ID);
  await expect(page.locator("#child-link-status")).toHaveText("Pending");
  await expect(page.locator("#child-link-detail")).toContainText(
    "has not set this board as its parent",
  );
  await page.locator("#value-input").fill("1.00");
  await page.locator("#save-button").click();
  await expect(page.locator(".slot .slot-label").nth(1)).toHaveText("Parent");

  // Setting this board's parent to the child would close a loop, so it is
  // blocked before anything is signed.
  await page.locator("#parent-edit").click();
  await page.locator("#parent-select").selectOption(MOCK_CHILD_ID);
  await page.locator("#parent-save").click();
  await expect(page.locator("#parent-error")).toContainText("loop");
  await expect(page.locator("#parent-name")).toHaveText("Root");

  // A mutual link is Linked: the parent fixture has a slot pointing here.
  await page.locator("#parent-select").selectOption(MOCK_PARENT_ID);
  await page.locator("#parent-save").click();
  await expect(page.locator("#parent-status")).toHaveText("Linked");
  await page.locator("#parent-open").click();
  await expect(page.locator("#read-only-badge")).toBeVisible();
  await expect(page.locator("#breadcrumb-list .breadcrumb-current")).toHaveText(
    "Parent",
  );
  await page.locator("#board-home").click();
  await expect(page.locator("#parent-status")).toHaveText("Linked");

  // Duplicate child ids are rejected before saving.
  await page.locator(".slot").nth(2).click();
  await page.locator("#contact-select").selectOption(MOCK_CHILD_ID);
  await expect(page.locator("#contact-hint")).toContainText("already in slot 1");
  await expect(page.locator("#save-button")).toBeDisabled();
  await page.locator("#cancel-button").click();

  // A contact with no board is "Not created yet"; the slot still saves.
  await page.locator(".slot").nth(3).click();
  await page.locator("#contact-select").selectOption(GHOST_ID);
  await page.locator("#value-input").fill("1.00");
  await page.locator("#save-button").click();
  await expect(page.locator(".slot .slot-label").nth(3)).toHaveText("Ghost");
  await page.locator(".slot").nth(3).click();
  await expect(page.locator("#child-link-status")).toHaveText("Not created yet");
  await expect(page.locator("#child-open")).toBeDisabled();
  await page.locator("#cancel-button").click();

  // Clearing the parent returns this board to a root.
  await page.locator("#parent-clear").click();
  await expect(page.locator("#parent-name")).toHaveText("Root");
  await expect(page.locator("#parent-clear")).toBeHidden();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});
