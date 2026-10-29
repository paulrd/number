import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  MOCK_CHILD_ID,
  MOCK_PARENT_ID,
  MOCK_PAYER_ID,
  MOCK_SIBLING_ID,
} from "../src/mock";

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

/** Save just the slot details for an empty slot, leaving the value at 0.00. */
async function saveDetails(
  page: Page,
  slotIndex: number,
  userId: string,
): Promise<void> {
  await page.locator(".slot").nth(slotIndex).click();
  await expect(page.locator("#editor")).toBeVisible();
  await page.locator("#contact-select").selectOption(userId);
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
}

/** Open a slot and run one issue/burn from the liability block. */
async function adjust(
  page: Page,
  slotIndex: number,
  direction: "issue" | "burn",
  amount: string,
  note = "",
): Promise<void> {
  await page.locator(".slot").nth(slotIndex).click();
  await expect(page.locator("#editor")).toBeVisible();
  if (direction === "burn") await page.locator("#adjust-burn").check();
  await page.locator("#adjust-amount").fill(amount);
  if (note !== "") await page.locator("#adjust-note").fill(note);
  await expect(page.locator("#adjust-submit")).toBeEnabled();
  await page.locator("#adjust-submit").click();
  await expect(page.locator("#adjust-status")).not.toHaveText("");
  await expect(page.locator("#editor")).toBeVisible();
}

test("board mounts, adds a contact, saves a decimal slot, and passes axe", async ({
  page,
}) => {
  const errors = watchConsole(page);
  const aliceId = ALICE_ID.toLowerCase();

  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "number" })).toBeVisible();
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await expect(page.locator("#board-meta")).toBeHidden();
  await expect(page.locator("#identity-short")).toBeVisible();
  await expect(page.locator("#identity-short")).not.toHaveText("Not available");
  await expect(page.locator("#board-name-row")).toBeVisible();
  await expect(page.locator("#board-name")).toHaveText("My board");
  await expect(page.locator("#board-name-dialog")).toBeHidden();
  await expect(page.locator("#contract-short")).not.toHaveText("Not derived");
  await expect(page.locator(".slot")).toHaveCount(8);
  await expect(page.locator("#contacts-count")).toHaveText("0");

  // The editor starts without contacts: a clear hint and a disabled Save. The
  // liability block explains that a contact must be saved first.
  await page.locator(".slot").first().click();
  await expect(page.locator("#adjust-panel")).toBeVisible();
  await expect(page.locator("#adjust-empty")).toBeVisible();
  await expect(page.locator("#adjust-empty")).toContainText(
    "Choose a contact and save the slot first",
  );
  await expect(page.locator("#adjust-controls")).toBeHidden();
  await expect(page.locator("#contact-hint")).toContainText("No contacts yet");
  await expect(page.locator("#save-button")).toBeDisabled();

  // Add the contact from the editor's own button. A successful add selects it
  // and hands focus back to the editor.
  await page.locator("#contact-add").click();
  await expect(page.locator("#contacts-dialog")).toBeVisible();
  await expect(page.locator("#contacts-title")).toBeFocused();
  await expect(page.locator("#contacts-dialog-count")).toHaveText("0 of 63");
  await page.locator("#contact-label-input").fill("Alice");
  await page.locator("#contact-userid-input").fill(ALICE_ID);
  await page.locator("#contact-add-button").click();
  await expect(page.locator("#contacts-dialog")).toBeHidden();
  await expect(page.locator("#contact-select")).toHaveValue(aliceId);
  await expect(page.locator("#contact-select")).toBeFocused();
  await expect(page.locator("#contact-hint")).toBeHidden();
  await expect(page.locator("#save-button")).toBeEnabled();

  // Save details first: with no value typed, the slot is recorded at 0.00.
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator(".slot .slot-value").first()).toHaveText("0.00");
  await expect(page.locator(".slot .slot-label").first()).toHaveText("Alice");
  await expect(page.locator("#contacts-count")).toHaveText("1");

  // Issue is what sets the liability now. 12.5 hundredths -> the board always
  // shows two decimals, and leaving the field normalises the typed shorthand.
  await page.locator(".slot").first().click();
  await expect(page.locator("#adjust-current")).toHaveText("0.00");
  await expect(page.locator("#adjust-controls")).toBeVisible();
  await expect(page.locator("#adjust-issue")).toBeChecked();
  await page.locator("#adjust-amount").fill("12.5");
  await page.locator("#adjust-amount").press("Tab");
  await expect(page.locator("#adjust-amount")).toHaveValue("12.50");
  await expect(page.locator("#adjust-result")).toHaveText("12.50");
  await page.locator("#adjust-submit").click();
  await expect(page.locator("#adjust-status")).toContainText(
    "Issued 12.50. Liability is now 12.50.",
  );
  await expect(page.locator(".slot .slot-value").first()).toHaveText("12.50");
  await expect(page.locator(".slot .slot-label").first()).toHaveText("Alice");

  // Reopening shows the saved liability and the normalised decimal.
  await page.locator("#cancel-button").click();
  await page.locator(".slot").first().click();
  await expect(page.locator("#adjust-current")).toHaveText("12.50");
  await expect(page.locator("#contact-select")).toHaveValue(aliceId);
  await page.locator("#cancel-button").click();

  // The header control opens the same address book.
  await page.locator("#contacts-open").click();
  await expect(page.locator("#contacts-dialog")).toBeVisible();
  await expect(page.locator("#contacts-list")).toContainText("Alice");
  await expect(page.locator("#contacts-list")).not.toContainText("My board");
  await expect(page.locator("#contacts-dialog-count")).toHaveText("1 of 63");

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
  await expect(page.locator("#board-name")).toHaveText("My board");

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("a saved slot starts at 0.00 and more than two decimals is rejected", async ({
  page,
}) => {
  const errors = watchConsole(page);
  const bobId = BOB_ID.toLowerCase();

  await page.goto("/");
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await addContact(page, "Alice", ALICE_ID);
  await addContact(page, "Bob", BOB_ID);
  await expect(page.locator("#contacts-count")).toHaveText("2");

  // Details-only save: the value stays at zero hundredths, and an empty amount
  // leaves the issue/burn action disabled with no warning.
  await saveDetails(page, 0, ALICE_ID.toLowerCase());
  await expect(page.locator(".slot .slot-value").first()).toHaveText("0.00");
  await expect(page.locator(".slot .slot-label").first()).toHaveText("Alice");
  await page.locator(".slot").first().click();
  await expect(page.locator("#adjust-amount")).toHaveValue("");
  await expect(page.locator("#adjust-warning")).toBeHidden();
  await expect(page.locator("#adjust-submit")).toBeDisabled();
  await page.locator("#cancel-button").click();

  // Three decimal places never reaches the board. A different child board is
  // used because a child id may only appear in one slot.
  await saveDetails(page, 1, bobId);
  await page.locator(".slot").nth(1).click();
  await page.locator("#adjust-amount").fill("1.234");
  await expect(page.locator("#adjust-warning")).toBeVisible();
  await expect(page.locator("#adjust-warning")).toContainText("2 decimal places");
  await expect(page.locator("#adjust-amount")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.locator("#adjust-submit")).toBeDisabled();
  await expect(page.locator(".slot .slot-value").nth(1)).toHaveText("0.00");

  // Correcting the amount issues it.
  await page.locator("#adjust-amount").fill("1.23");
  await expect(page.locator("#adjust-warning")).toBeHidden();
  await expect(page.locator("#adjust-submit")).toBeEnabled();
  await page.locator("#adjust-submit").click();
  await expect(page.locator("#adjust-status")).toContainText(
    "Issued 1.23. Liability is now 1.23.",
  );
  await expect(page.locator(".slot .slot-value").nth(1)).toHaveText("1.23");

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("issues and reopens the largest amount the editor accepts exactly", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await addContact(page, "Bob", BOB_ID);
  await addContact(page, "Carol", CAROL_ID);
  const bobId = BOB_ID.toLowerCase();
  const carolId = CAROL_ID.toLowerCase();

  // i64 max is the contract's largest slot value. The editor and the bigint
  // delta path must carry it exactly, without going through a JS float.
  const i64Max = "92233720368547758.07";
  await saveDetails(page, 0, bobId);
  await page.locator(".slot").first().click();
  await page.locator("#adjust-amount").fill(i64Max);
  await page.locator("#adjust-submit").click();
  await expect(page.locator("#adjust-status")).toContainText(
    `Issued ${i64Max}. Liability is now ${i64Max}.`,
  );
  await expect(page.locator(".slot .slot-value").first()).toHaveText(i64Max);

  await page.locator("#cancel-button").click();
  await page.locator(".slot").first().click();
  await expect(page.locator("#adjust-current")).toHaveText(i64Max);
  await page.locator("#cancel-button").click();

  // One hundredth past i64 max is rejected inline, not rounded. A different
  // child board is used because a child id may only appear in one slot.
  await saveDetails(page, 1, carolId);
  await page.locator(".slot").nth(1).click();
  await page.locator("#adjust-amount").fill("92233720368547758.08");
  await expect(page.locator("#adjust-warning")).toBeVisible();
  await expect(page.locator("#adjust-warning")).toContainText(
    "92233720368547758",
  );
  await expect(page.locator("#adjust-submit")).toBeDisabled();
  await expect(page.locator(".slot .slot-value").nth(1)).toHaveText("0.00");

  // Adjustments take a magnitude, not a signed number: a negative amount is
  // rejected rather than treated as a burn.
  await page.locator("#adjust-amount").fill("-92233720368547758.08");
  await expect(page.locator("#adjust-warning")).toBeVisible();
  await expect(page.locator("#adjust-warning")).toContainText(
    "Use a positive amount",
  );
  await expect(page.locator("#adjust-submit")).toBeDisabled();

  // A burn clamps at zero: the exact boundary succeeds, one hundredth more is
  // rejected and the slot keeps its old value.
  await page.locator("#adjust-amount").fill("5.00");
  await page.locator("#adjust-submit").click();
  await expect(page.locator(".slot .slot-value").nth(1)).toHaveText("5.00");

  await page.locator("#adjust-burn").check();
  await expect(page.locator("#adjust-burn")).toBeChecked();
  await page.locator("#adjust-amount").fill("5.01");
  await expect(page.locator("#adjust-warning")).toBeVisible();
  await expect(page.locator("#adjust-warning")).toContainText("below 0.00");
  await expect(page.locator("#adjust-submit")).toBeDisabled();
  await expect(page.locator(".slot .slot-value").nth(1)).toHaveText("5.00");

  await page.locator("#adjust-amount").fill("5.00");
  await page.locator("#adjust-submit").click();
  await expect(page.locator("#adjust-status")).toContainText(
    "Burned 5.00. Liability is now 0.00.",
  );
  await expect(page.locator(".slot .slot-value").nth(1)).toHaveText("0.00");

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("navigates boards as a tree, sets a parent, and rejects duplicate children", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await expect(page.locator("#board-meta")).toBeHidden();
  await expect(page.locator("#identity-short")).toBeVisible();
  await expect(page.locator("#board-name-row")).toBeVisible();
  await expect(page.locator("#board-name")).toHaveText("My board");
  await expect(page.locator("#read-only-badge")).toBeHidden();
  await expect(page.locator("#parent-name")).toHaveText("Root");
  await expect(page.locator("#breadcrumb-list .breadcrumb-current")).toHaveText(
    "My board",
  );
  // A root's octal address is the empty string, and it has no parent value.
  await expect(page.locator("#board-address")).toBeVisible();
  await expect(page.locator("#board-address")).toHaveAttribute("data-address", "");
  await expect(page.locator("#board-address-value")).toHaveText("");
  await expect(page.locator("#parent-value")).toBeHidden();

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
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();

  // The liability itself is recorded by an issue, with a reason the child sees.
  await page.locator(".slot").first().click();
  await page.locator("#adjust-amount").fill("3.25");
  await page.locator("#adjust-note").fill("October allowance");
  await page.locator("#adjust-submit").click();
  await expect(page.locator("#adjust-status")).toContainText(
    "Issued 3.25. Liability is now 3.25.",
  );
  await expect(page.locator(".slot .slot-value").first()).toHaveText("3.25");
  await expect(page.locator(".slot .slot-label").first()).toHaveText("Child");

  // A details-only save keeps the issued liability (and the signed log) while
  // the unit changes.
  await page.locator("#cancel-button").click();
  await page.locator(".slot").first().click();
  await page.locator("#unit-input").fill("kg");
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator(".slot .slot-value").first()).toHaveText("3.25");

  // Open the child board read-only from the editor, then return home.
  await page.locator(".slot").first().click();
  await expect(page.locator("#adjust-current")).toHaveText("3.25");
  await expect(page.locator("#child-link-status")).toHaveText("Linked");
  await page.locator("#child-open").click();
  await expect(page.locator("#board-meta")).toBeVisible();
  await expect(page.locator("#board-meta-label")).toHaveText("Viewing");
  await expect(page.locator("#board-name-row")).toBeHidden();
  await expect(page.locator("#board-owner")).toContainText("Child");
  await expect(page.locator("#read-only-badge")).toBeVisible();
  await expect(page.locator("#board-home")).toBeVisible();
  await expect(page.locator("#contacts-open")).toBeDisabled();
  await expect(page.locator("#parent-edit")).toBeHidden();
  await expect(page.locator("#parent-clear")).toBeHidden();
  await expect(page.locator("#board-mode")).toContainText("Read-only");
  await expect(page.locator("#breadcrumb-list .breadcrumb-current")).toHaveText(
    "Child",
  );
  await expect(page.locator("#breadcrumb-list")).toContainText("My board");
  await expect(page.locator("#parent-name")).toHaveText("My board");
  // The child's address is its parent's address plus the child's slot digit.
  // The own board is still a root here, and slot 0 holds the child.
  await expect(page.locator("#board-address")).toHaveAttribute("data-address", "0");
  await expect(page.locator("#board-address-value")).toHaveText("0");
  // The parent (the own board) holds 3.25 for this child; show it prominently.
  await expect(page.locator("#parent-value")).toBeVisible();
  await expect(page.locator("#parent-value")).toContainText("3.25");
  await expect(page.locator("#parent-value")).toContainText("kg");
  await expect(page.locator("#parent-value")).toContainText("My board");
  // A later details save moves the slot sequence on without changing the value;
  // the band explains that the log is only a hint.
  await expect(page.locator("#parent-value-change")).toBeVisible();
  // The parent's recent adjustment log is child-facing: direction, delta,
  // post value and the reason.
  await expect(page.locator("#parent-adjustments")).toBeVisible();
  const latestAdjustment = page.locator("#parent-adjustments-list .adjustment");
  await expect(latestAdjustment).toHaveCount(1);
  await expect(latestAdjustment).toContainText("Issue");
  await expect(latestAdjustment).toContainText("+3.25");
  await expect(latestAdjustment).toContainText("Liability 3.25");
  await expect(latestAdjustment).toContainText("October allowance");
  // The fixture child has no slots, and they are not editable.
  await expect(page.locator(".slot").first()).toBeDisabled();

  await page.locator("#board-home").click();
  await expect(page.locator("#read-only-badge")).toBeHidden();
  await expect(page.locator("#board-meta")).toBeHidden();
  await expect(page.locator("#board-name-row")).toBeVisible();
  await expect(page.locator("#identity-short")).toBeVisible();
  await expect(page.locator("#breadcrumb-list .breadcrumb-current")).toHaveText(
    "My board",
  );

  // A one-sided child link is Pending: the parent fixture exists, but its own
  // parent is empty, so it has not added this board as a parent.
  await page.locator(".slot").nth(1).click();
  await page.locator("#contact-select").selectOption(MOCK_PARENT_ID);
  await expect(page.locator("#child-link-status")).toHaveText("Pending");
  await expect(page.locator("#child-link-detail")).toContainText(
    "has not set this board as its parent",
  );
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
  await page.locator(".slot").nth(1).click();
  await page.locator("#adjust-amount").fill("1.00");
  await page.locator("#adjust-submit").click();
  await expect(page.locator(".slot .slot-label").nth(1)).toHaveText("Parent");
  await page.locator("#cancel-button").click();

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
  await expect(page.locator("#board-meta")).toBeVisible();
  await expect(page.locator("#board-meta-label")).toHaveText("Viewing");
  await expect(page.locator("#board-name-row")).toBeHidden();
  await expect(page.locator("#board-owner")).toContainText("Parent");
  await expect(page.locator("#read-only-badge")).toBeVisible();
  await expect(page.locator("#breadcrumb-list .breadcrumb-current")).toHaveText(
    "Parent",
  );
  // The parent fixture is a root: its own address is empty and it has no parent.
  await expect(page.locator("#board-address")).toHaveAttribute("data-address", "");
  await expect(page.locator("#parent-value")).toBeHidden();
  await page.locator("#board-home").click();
  await expect(page.locator("#board-meta")).toBeHidden();
  await expect(page.locator("#board-name-row")).toBeVisible();
  await expect(page.locator("#identity-short")).toBeVisible();
  await expect(page.locator("#parent-status")).toHaveText("Linked");
  // The own board's address is the parent's empty address plus slot digit 0,
  // and the parent's value for it is shown prominently.
  await expect(page.locator("#board-address")).toHaveAttribute("data-address", "0");
  await expect(page.locator("#board-address-value")).toHaveText("0");
  await expect(page.locator("#parent-value")).toBeVisible();
  await expect(page.locator("#parent-value")).toContainText("8.50");
  await expect(page.locator("#parent-value")).toContainText("kg");
  await expect(page.locator("#parent-value")).toContainText("Parent");

  // The new address chip and parent-value band must pass with a linked parent.
  const parentAccessibility = await new AxeBuilder({ page }).analyze();
  expect(
    parentAccessibility.violations,
    `axe violations:\n${JSON.stringify(parentAccessibility.violations, null, 2)}`,
  ).toEqual([]);

  // Duplicate child ids are rejected before saving.
  await page.locator(".slot").nth(2).click();
  await page.locator("#contact-select").selectOption(MOCK_CHILD_ID);
  await expect(page.locator("#contact-hint")).toContainText("already in slot 1");
  await expect(page.locator("#save-button")).toBeDisabled();
  await page.locator("#cancel-button").click();

  // A contact with no board is "Not created yet"; the slot still saves.
  await page.locator(".slot").nth(3).click();
  await page.locator("#contact-select").selectOption(GHOST_ID);
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
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

test("keeps the contract id in a closed Details section", async ({ page }) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await expect(page.locator("#details")).not.toHaveAttribute("open", "");
  await expect(page.locator("#contract-copy")).toBeHidden();
  await expect(page.locator("#contract-short")).toBeHidden();

  await page.locator("#details-summary").click();
  await expect(page.locator("#details")).toHaveAttribute("open", "");
  await expect(page.locator("#contract-short")).toBeVisible();
  await expect(page.locator("#contract-short")).not.toHaveText("Not derived");
  await expect(page.locator("#contract-copy")).toBeEnabled();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("requires a board name on first load and cannot be dismissed", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/?unnamed=1");
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await expect(page.locator("#board-name-dialog")).toBeVisible();
  await expect(page.locator("#board-name-title")).toHaveText("Name your board");
  await expect(page.locator("#board-name-close")).toBeHidden();
  await expect(page.locator("#board-name-cancel")).toBeHidden();

  // Required mode: Escape and the backdrop must not dismiss it.
  await page.keyboard.press("Escape");
  await expect(page.locator("#board-name-dialog")).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(page.locator("#board-name-dialog")).toBeVisible();

  const promptAccessibility = await new AxeBuilder({ page }).analyze();
  expect(
    promptAccessibility.violations,
    `axe violations:\n${JSON.stringify(promptAccessibility.violations, null, 2)}`,
  ).toEqual([]);

  await page.locator("#board-name-save").click();
  await expect(page.locator("#board-name-warning")).toContainText("Enter a name");

  await page.locator("#board-name-input").fill("Test board");
  await page.locator("#board-name-save").click();
  await expect(page.locator("#board-name-dialog")).toBeHidden();
  await expect(page.locator("#board-name-row")).toBeVisible();
  await expect(page.locator("#board-name")).toHaveText("Test board");
  await expect(page.locator("#contacts-count")).toHaveText("0");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("renames the board and reserves that name in the address book", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await expect(page.locator("#board-name")).toHaveText("My board");

  await page.locator("#board-name-edit").click();
  await expect(page.locator("#board-name-dialog")).toBeVisible();
  await expect(page.locator("#board-name-title")).toHaveText("Rename your board");
  await expect(page.locator("#board-name-input")).toHaveValue("My board");
  await expect(page.locator("#board-name-cancel")).toBeVisible();

  await page.locator("#board-name-input").fill("Renamed board");
  await page.locator("#board-name-save").click();
  await expect(page.locator("#board-name-dialog")).toBeHidden();
  await expect(page.locator("#board-name")).toHaveText("Renamed board");
  await expect(page.locator("#breadcrumb-list .breadcrumb-current")).toHaveText(
    "Renamed board",
  );

  // A name already used by a contact is rejected in the dialog.
  await addContact(page, "Alice", ALICE_ID);
  await page.locator("#board-name-edit").click();
  await page.locator("#board-name-input").fill("Alice");
  await page.locator("#board-name-save").click();
  await expect(page.locator("#board-name-warning")).toContainText(
    "Another contact",
  );
  await page.locator("#board-name-cancel").click();
  await expect(page.locator("#board-name")).toHaveText("Renamed board");

  // The board name is also reserved when adding a new contact.
  await page.locator("#contacts-open").click();
  await page.locator("#contact-label-input").fill("Renamed board");
  await page.locator("#contact-userid-input").fill(BOB_ID);
  await page.locator("#contact-add-button").click();
  await expect(page.locator("#contact-label-warning")).toContainText(
    "board's name",
  );
  await page.locator("#contacts-done").click();
  await expect(page.locator("#contacts-count")).toHaveText("1");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("falls back to fixture board names when contacts are removed", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await addContact(page, "Child", MOCK_CHILD_ID);
  await addContact(page, "Parent", MOCK_PARENT_ID);

  // Set up the child slot and a mutual parent link.
  await page.locator(".slot").first().click();
  await page.locator("#contact-select").selectOption(MOCK_CHILD_ID);
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
  await page.locator(".slot").first().click();
  await page.locator("#adjust-amount").fill("2.00");
  await page.locator("#adjust-submit").click();
  await expect(page.locator(".slot .slot-label").first()).toHaveText("Child");
  await page.locator("#cancel-button").click();

  await page.locator(".slot").nth(1).click();
  await page.locator("#contact-select").selectOption(MOCK_PARENT_ID);
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
  await page.locator(".slot").nth(1).click();
  await page.locator("#adjust-amount").fill("1.00");
  await page.locator("#adjust-submit").click();
  await expect(page.locator(".slot .slot-label").nth(1)).toHaveText("Parent");
  await page.locator("#cancel-button").click();

  await page.locator("#parent-edit").click();
  await page.locator("#parent-select").selectOption(MOCK_PARENT_ID);
  await page.locator("#parent-save").click();
  await expect(page.locator("#parent-status")).toHaveText("Linked");
  await expect(page.locator("#parent-name")).toHaveText("Parent");

  // Removing the child contact keeps the signed id and falls back to the
  // child board's own name.
  await page.locator("#contacts-open").click();
  await page.getByRole("button", { name: "Remove Child" }).click();
  await expect(page.locator("#contacts-confirm")).toBeVisible();
  await page.locator("#contacts-confirm-remove").click();
  await expect(page.locator("#contacts-list")).not.toContainText("Child");
  await page.locator("#contacts-done").click();
  await expect(page.locator(".slot .slot-label").first()).toHaveText("Child board");

  // The parent row replaces its initial Unknown label with the parent's name.
  await page.locator("#contacts-open").click();
  await page.getByRole("button", { name: "Remove Parent" }).click();
  await expect(page.locator("#contacts-confirm")).toBeVisible();
  await page.locator("#contacts-confirm-remove").click();
  await expect(page.locator("#contacts-list")).not.toContainText("Parent");
  await page.locator("#contacts-done").click();
  await expect(page.locator("#parent-name")).toHaveText("Parent board");

  // The Viewing row and path use the same fallback.
  await page.locator(".slot").first().click();
  await expect(page.locator("#child-link-status")).toHaveText("Linked");
  await page.locator("#child-open").click();
  await expect(page.locator("#board-owner")).toContainText("Child board");
  await expect(page.locator("#breadcrumb-list .breadcrumb-current")).toHaveText(
    "Child board",
  );
  await expect(page.locator("#breadcrumb-list")).toContainText("My board");
  await page.locator("#board-home").click();

  await page.locator("#parent-open").click();
  await expect(page.locator("#board-owner")).toContainText("Parent board");
  await expect(page.locator("#breadcrumb-list .breadcrumb-current")).toHaveText(
    "Parent board",
  );
  await expect(page.locator(".slot .slot-label").first()).toHaveText("My board");
  await page.locator("#board-home").click();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("advances a cooperative payment and offers a source payment", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await addContact(page, "Payer", MOCK_PAYER_ID);
  await addContact(page, "Child", MOCK_CHILD_ID);
  await addContact(page, "Parent", MOCK_PARENT_ID);
  await addContact(page, "Sibling", MOCK_SIBLING_ID);

  // Own board root is the LCA: slot 0 is the payer, slot 1 the destination.
  await saveDetails(page, 0, MOCK_PAYER_ID);
  await adjust(page, 0, "issue", "10.00");
  await expect(page.locator(".slot .slot-value").first()).toHaveText("10.00");
  await page.locator("#cancel-button").click();

  // The destination starts clean; a details-only save records 0.00.
  await saveDetails(page, 1, MOCK_CHILD_ID);
  await expect(page.locator(".slot .slot-value").nth(1)).toHaveText("0.00");

  // The payer fixture has already offered 2.50 through this LCA.
  await expect(page.locator("#payments")).toBeVisible();
  await expect(page.locator("#payment-inbox")).toBeVisible();
  await expect(page.locator("#payment-inbox")).toContainText("2.50");
  await expect(page.locator("#payment-inbox")).toContainText("Payer");
  await page.locator(".payment-advance").first().click();

  await expect(page.locator("#payment-status")).toContainText("Complete");
  await expect(page.locator("#payment-inbox")).toBeHidden();
  await expect(page.locator(".slot .slot-value").first()).toHaveText("7.50");
  await expect(page.locator(".slot .slot-value").nth(1)).toHaveText("2.50");

  // Become a source: set the parent and pay the sibling through it.
  await page.locator("#parent-edit").click();
  await page.locator("#parent-select").selectOption(MOCK_PARENT_ID);
  await page.locator("#parent-save").click();
  await expect(page.locator("#parent-status")).toHaveText("Linked");
  await expect(page.locator("#payment-open")).toBeEnabled();

  await page.locator("#payment-open").click();
  await expect(page.locator("#payment-dialog")).toBeVisible();
  await page.locator("#payment-address").fill("1");
  await page.locator("#payment-user").fill("0".repeat(64));
  await page.locator("#payment-amount").fill("1.00");
  await page.locator("#payment-submit").click();
  await expect(page.locator("#payment-error")).toContainText("does not own");

  await page.locator("#payment-user").fill(MOCK_SIBLING_ID);
  await page.locator("#payment-submit").click();
  await expect(page.locator("#payment-dialog")).toBeHidden();
  await expect(page.locator("#payment-status")).toContainText("Offered");
  await expect(page.locator("#payment-status")).toContainText("Parent");
  await expect(page.locator("#payment-open")).toBeDisabled();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});
