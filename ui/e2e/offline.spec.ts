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

/** Switch to the advanced surface (the editor, slots and ledger live there). */
async function openAdvanced(page: Page): Promise<void> {
  if (await page.locator("#advanced-view").isVisible()) return;
  await page.locator("#view-toggle").click();
  await expect(page.locator("#advanced-view")).toBeVisible();
  await expect(page.locator("#simple-view")).toBeHidden();
}

async function openSimple(page: Page): Promise<void> {
  if (await page.locator("#simple-view").isVisible()) return;
  await page.locator("#view-toggle").click();
  await expect(page.locator("#simple-view")).toBeVisible();
  await expect(page.locator("#advanced-view")).toBeHidden();
}

/** Set the own board's parent from the default surface. */
async function setParent(page: Page, userId: string): Promise<void> {
  await openSimple(page);
  await page.locator("#parent-edit").click();
  await expect(page.locator("#parent-dialog")).toBeVisible();
  await page.locator("#parent-select").selectOption(userId);
  await page.locator("#parent-save").click();
  await expect(page.locator("#parent-dialog")).toBeHidden();
}

/** Add a contact through the header address book and close it again. */
async function addContact(
  page: Page,
  label: string,
  rawUserId: string,
  address?: string,
): Promise<void> {
  await openAdvanced(page);
  await page.locator("#contacts-open").click();
  await expect(page.locator("#contacts-dialog")).toBeVisible();
  await page.locator("#contact-label-input").fill(label);
  await page.locator("#contact-userid-input").fill(rawUserId);
  if (address !== undefined) {
    await page.locator("#contact-address-input").fill(address);
  }
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
  await openAdvanced(page);
  const slot = page.locator(".slot").nth(slotIndex);
  if (await slot.isVisible()) await slot.click();
  else await page.locator("#add-child-slot").click();
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
  await openAdvanced(page);
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
  const aliceId = MOCK_CHILD_ID;

  await page.goto("/");

  // The default surface is the record card, three actions and nothing else.
  await expect(page.getByRole("heading", { level: 1, name: "Tally" })).toBeVisible();
  await expect(page.locator("#simple-view")).toBeVisible();
  await expect(page.locator("#advanced-view")).toBeHidden();
  await expect(page.locator("#board-title-name")).toHaveText("My board");
  await expect(page.locator("#board-title")).toContainText("Your Board Name:");
  await expect(
    page.getByRole("heading", { level: 2, name: /Your Board Name: My board/ }),
  ).toBeVisible();
  await expect(page.locator("#simple-pay")).toBeDisabled();
  await expect(page.locator("#simple-pay-reason")).toContainText("no links");
  await expect(page.locator("#simple-view")).not.toContainText(/slot/i);
  await expect(page.locator("#simple-view .button")).toHaveCount(3);

  await openAdvanced(page);
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await expect(page.locator("#identity-short")).toBeVisible();
  await expect(page.locator("#identity-short")).not.toHaveText("Not available");
  await expect(page.locator("#board-name-row")).toBeVisible();
  await expect(page.locator("#board-name")).toHaveText("My board");
  await expect(page.locator("#board-name-dialog")).toBeHidden();
  await expect(page.locator("#contract-short")).not.toHaveText("Not derived");
  await expect(page.locator(".slot")).toHaveCount(8);
  await expect(page.locator("#contacts-count")).toHaveText("0");

  // The editor starts without contacts: a clear hint and a disabled Save. The
  // liability block explains that a contact must be saved first. There are no
  // mutual children yet, so the empty grid offers the add control instead.
  await expect(page.locator("#child-slots-title")).toHaveText("Child slots (0 of 8)");
  await expect(page.locator("#child-slots-empty")).toBeVisible();
  await page.locator("#add-child-slot").click();
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
  await expect(page.locator("#contacts-dialog-count")).toHaveText("0 of 64");
  await page.locator("#contact-label-input").fill("Alice");
  await page.locator("#contact-userid-input").fill(MOCK_CHILD_ID);
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
  await expect(page.locator("#contacts-dialog-count")).toHaveText("1 of 64");

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
    "saved name",
  );
  await page.locator("#contacts-confirm-remove").click();
  await expect(page.locator("#contacts-list")).not.toContainText("Alice");
  await expect(page.locator("#contacts-count")).toHaveText("0");
  await page.locator("#contacts-done").click();

  // The slot keeps the signed name it was given; removing the private contact
  // does not rewrite the board's `childNames` record.
  const firstLabel = page.locator(".slot .slot-label").first();
  await expect(firstLabel).toHaveText("Alice");
  await expect(firstLabel).toHaveAttribute("title", aliceId);
  await expect(page.locator("#board-name")).toHaveText("My board");

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("a saved slot starts at 0.00 and more than two decimals is rejected", async ({
  page,
}) => {
  const errors = watchConsole(page);
  const bobId = MOCK_PAYER_ID;

  await page.goto("/");
  await openAdvanced(page);
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await addContact(page, "Alice", MOCK_CHILD_ID);
  await addContact(page, "Bob", MOCK_PAYER_ID);
  await expect(page.locator("#contacts-count")).toHaveText("2");

  // Details-only save: the value stays at zero hundredths, and an empty amount
  // leaves the issue/burn action disabled with no warning.
  await saveDetails(page, 0, MOCK_CHILD_ID);
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
  await openAdvanced(page);
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await addContact(page, "Bob", MOCK_CHILD_ID);
  await addContact(page, "Carol", MOCK_PAYER_ID);
  const bobId = MOCK_CHILD_ID;
  const carolId = MOCK_PAYER_ID;

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

test("links boards as a tree, sets a parent, and rejects duplicate children", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await expect(page.locator("#simple-view")).toBeVisible();
  await expect(page.locator("#board-title-name")).toHaveText("My board");
  await expect(page.locator("#parent-value-empty")).toContainText("no parent");
  await openAdvanced(page);
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await expect(page.locator("#identity-short")).toBeVisible();
  await expect(page.locator("#board-name-row")).toBeVisible();
  await expect(page.locator("#board-name")).toHaveText("My board");
  await expect(page.locator("#parent-name")).toHaveText("Root");
  // A root's octal address is the empty string, and the simple card is hidden.
  await expect(page.locator("#board-address")).toBeVisible();
  await expect(page.locator("#board-address")).toHaveAttribute("data-address", "");
  await expect(page.locator("#board-address-value")).toHaveText("");
  await expect(page.locator("#parent-value")).toBeHidden();

  await addContact(page, "Child", MOCK_CHILD_ID);
  await addContact(page, "Parent", MOCK_PARENT_ID);
  await addContact(page, "Ghost", GHOST_ID);
  await expect(page.locator("#contacts-count")).toHaveText("3");

  // A child slot is Linked when both signed sides agree.
  await page.locator("#add-child-slot").click();
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

  // The mutual child appears on the default surface. Opening its slot keeps the
  // own board in place: it opens the slot editor, never the child's board.
  await page.locator(".slot").first().click();
  await expect(page.locator("#adjust-current")).toHaveText("3.25");
  await expect(page.locator("#child-link-status")).toHaveText("Linked");
  await page.locator("#cancel-button").click();
  await openSimple(page);
  await expect(page.locator("#simple-children")).toContainText("Child");
  await expect(page.locator("#simple-children")).toContainText("3.25");
  await expect(page.locator("#simple-children button")).toHaveCount(0);

  // No control in the app offers to visit another owner's board.
  await expect(
    page.locator(
      "#breadcrumbs, #breadcrumb-list, #parent-open, #board-home, #child-open, #read-only-badge",
    ),
  ).toHaveCount(0);
  await openAdvanced(page);

  // A one-sided child link is Pending: the parent fixture exists, but its own
  // parent is empty, so it has not added this board as a parent. It leaves the
  // grid and is listed as an unconfirmed fact instead.
  await page.locator("#add-child-slot").click();
  await page.locator("#contact-select").selectOption(MOCK_PARENT_ID);
  await expect(page.locator("#child-link-status")).toHaveText("Pending");
  await expect(page.locator("#child-link-detail")).toContainText(
    "has not set this board as its parent",
  );
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#unconfirmed-list")).toContainText("Parent");
  await expect(page.locator("#child-slots-title")).toHaveText("Child slots (1 of 8)");

  // Setting this board's parent to the child would close a loop, so it is
  // blocked before anything is signed.
  await openSimple(page);
  await page.locator("#parent-edit").click();
  await page.locator("#parent-select").selectOption(MOCK_CHILD_ID);
  await page.locator("#parent-save").click();
  await expect(page.locator("#parent-error")).toContainText("loop");
  await expect(page.locator("#parent-name")).toHaveText("Root");

  // A mutual link is Linked: the parent fixture has a slot pointing here.
  await page.locator("#parent-select").selectOption(MOCK_PARENT_ID);
  await page.locator("#parent-save").click();
  await expect(page.locator("#parent-dialog")).toBeHidden();
  await openAdvanced(page);
  await expect(page.locator("#parent-status")).toHaveText("Linked");
  // There is no control to visit the parent's board.
  await expect(page.locator("#parent-open")).toHaveCount(0);
  // The own board is now a child: the parent's empty address plus slot digit 0.
  await expect(page.locator("#board-address")).toHaveAttribute("data-address", "0");
  await expect(page.locator("#board-address-value")).toHaveText("0");

  // The default surface shows the value as given by the parent.
  await openSimple(page);
  await expect(page.locator("#board-title-name")).toHaveText("My board");
  await expect(page.locator("#parent-value-title")).toContainText("Held by Parent board");
  await expect(page.locator("#parent-value")).toContainText("8.50");
  await expect(page.locator("#parent-value")).toContainText("kg");
  await expect(page.locator("#parent-value-recorded")).toContainText(
    "Recorded by Parent board",
  );
  await openAdvanced(page);

  // The new address chip and adjustments block must pass with a linked parent.
  await page.waitForTimeout(250);
  const parentAccessibility = await new AxeBuilder({ page }).analyze();
  expect(
    parentAccessibility.violations,
    `axe violations:\n${JSON.stringify(parentAccessibility.violations, null, 2)}`,
  ).toEqual([]);

  // Duplicate child ids are rejected before saving.
  await page.locator("#add-child-slot").click();
  await page.locator("#contact-select").selectOption(MOCK_CHILD_ID);
  await expect(page.locator("#contact-hint")).toContainText("already in slot 1");
  await expect(page.locator("#save-button")).toBeDisabled();
  await page.locator("#cancel-button").click();

  // A contact with no board is "Not created yet"; the slot still saves and is
  // listed as an unconfirmed fact.
  await page.locator("#add-child-slot").click();
  await page.locator("#contact-select").selectOption(GHOST_ID);
  await expect(page.locator("#child-link-status")).toHaveText("Not created yet");
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#unconfirmed-list")).toContainText("Ghost");

  // Clearing the parent returns this board to a root.
  await openSimple(page);
  await page.locator("#parent-clear").click();
  await expect(page.locator("#parent-name")).toHaveText("Root");
  await expect(page.locator("#parent-clear")).toBeHidden();
  await expect(page.locator("#parent-edit")).toHaveText("Set parent…");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("shows only mutual children on the default surface", async ({ page }) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await openAdvanced(page);
  await addContact(page, "Child", MOCK_CHILD_ID);
  await addContact(page, "Parent", MOCK_PARENT_ID);

  // Slot 0 points at a board that names this board as its parent, so it is a
  // mutual child. Slot 1 names the Parent fixture, which names no parent.
  await saveDetails(page, 0, MOCK_CHILD_ID);
  await saveDetails(page, 1, MOCK_PARENT_ID);
  await page.waitForTimeout(300);

  await openSimple(page);
  const children = page.locator("#simple-children");
  await expect(children).toBeVisible();
  await expect(children.locator(".simple-child")).toHaveCount(1);
  await expect(children).toContainText("Child");
  await expect(children).toContainText("0.00");
  await expect(children).not.toContainText("Parent");
  await expect(children.locator("button")).toHaveCount(0);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("sets and clears a parent from the default surface", async ({ page }) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await openAdvanced(page);
  await addContact(page, "Parent", MOCK_PARENT_ID);
  await openSimple(page);
  await expect(page.locator("#simple-parent #parent-edit")).toHaveText(
    "Set parent…",
  );
  await expect(page.locator("#simple-parent #parent-clear")).toBeHidden();

  await page.locator("#parent-edit").click();
  await page.locator("#parent-select").selectOption(MOCK_PARENT_ID);
  await page.locator("#parent-save").click();
  await expect(page.locator("#parent-dialog")).toBeHidden();

  await expect(page.locator("#simple-parent-name")).toHaveText("Parent board");
  await expect(page.locator("#parent-edit")).toHaveText("Change parent");
  await expect(page.locator("#parent-clear")).toBeVisible();

  // Advanced keeps one read-only summary, not a second set of controls.
  await openAdvanced(page);
  await expect(page.locator("#parent-name")).toHaveText("Parent board");
  await expect(page.locator("#parent-status")).toHaveText("Linked");
  await expect(page.locator("#advanced-view #parent-edit")).toHaveCount(0);
  await expect(page.locator("#advanced-view #parent-clear")).toHaveCount(0);

  await openSimple(page);
  await page.locator("#parent-clear").click();
  await expect(page.locator("#simple-parent-name")).toHaveText("Root");
  await expect(page.locator("#parent-edit")).toHaveText("Set parent…");
  await expect(page.locator("#parent-clear")).toBeHidden();

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("hides Check for payments when background auto-advance is active", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.addInitScript(() => {
    Object.assign(window, {
      __TALLY_MOCK_DELEGATE__: {
        hasSeed: true,
        identity: null,
        configured: true,
        codeHashes: [],
        matchedCodeHash: null,
        address: "0",
        autoAdvance: true,
        maxAmount: 1_000_000,
        subscriptions: [],
        lastScan: 3,
        lastError: null,
        audit: [],
      },
    });
  });

  await page.goto("/");
  await openAdvanced(page);
  await page.locator("#details-summary").click();
  await expect(page.locator("#details")).toHaveAttribute("open", "");
  await expect(page.locator("#auto-advance-badge")).toHaveText("On");

  await expect(page.locator("#payment-check")).toBeHidden();
  await expect(page.locator("#payment-note")).toHaveText(
    "Your node signs your part as it arrives.",
  );
  await expect(page.locator("#payment-auto-note")).toBeVisible();
  await expect(page.locator("#payment-open-ledger")).toHaveCount(0);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("keeps Check for payments when auto-advance is not active", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await openAdvanced(page);
  await expect(page.locator("#payment-check")).toBeVisible();
  await expect(page.locator("#payment-note")).toHaveText(
    "Payments move one board at a time. Each owner opens their board to sign their leg.",
  );
  await expect(page.locator("#payment-auto-note")).toBeHidden();
  await expect(page.locator("#payment-open-ledger")).toHaveCount(0);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("keeps the contract id in a closed Details section", async ({ page }) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await openAdvanced(page);
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await expect(page.locator("#details")).not.toHaveAttribute("open", "");
  await expect(page.locator("#contract-copy")).toBeHidden();
  await expect(page.locator("#contract-short")).toBeHidden();

  await page.locator("#details-summary").click();
  await expect(page.locator("#details")).toHaveAttribute("open", "");
  await expect(page.locator("#contract-short")).toBeVisible();
  await expect(page.locator("#contract-short")).not.toHaveText("Not derived");
  await expect(page.locator("#contract-copy")).toBeEnabled();

  // Let the connection plate's entrance animation finish before axe reads the
  // computed colours; mid-animation opacity lowers the status pill's contrast.
  await page.waitForTimeout(600);
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
  await openAdvanced(page);
  await expect(page.locator("#board-name-row")).toBeVisible();
  await expect(page.locator("#board-name")).toHaveText("Test board");
  await expect(page.locator("#contacts-count")).toHaveText("0");

  // Let the modal close settle before axe samples the page colours.
  await page.waitForTimeout(250);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("renames the board as a signed name, separate from contact labels", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await openAdvanced(page);
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

  // v6: the board name is its own signed record, not an address-book entry, so
  // it shares no namespace with contact labels.
  await addContact(page, "Alice", ALICE_ID);
  await page.locator("#board-name-edit").click();
  await page.locator("#board-name-input").fill("Alice");
  await page.locator("#board-name-save").click();
  await expect(page.locator("#board-name-dialog")).toBeHidden();
  await expect(page.locator("#board-name")).toHaveText("Alice");
  await expect(page.locator("#contacts-count")).toHaveText("1");

  // A contact may use the board's old name, because the names are private and
  // signed separately.
  await page.locator("#contacts-open").click();
  await page.locator("#contact-label-input").fill("Renamed board");
  await page.locator("#contact-userid-input").fill(BOB_ID);
  await page.locator("#contact-add-button").click();
  await expect(page.locator("#contacts-list")).toContainText("Renamed board");

  // Contact labels still have to be unique among themselves.
  await page.locator("#contact-label-input").fill("Alice");
  await page.locator("#contact-userid-input").fill(CAROL_ID);
  await page.locator("#contact-add-button").click();
  await expect(page.locator("#contact-label-warning")).toContainText(
    "Another contact",
  );
  await page.locator("#contacts-done").click();
  await expect(page.locator("#contacts-count")).toHaveText("2");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("keeps parent-given slot names after contacts are removed", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await addContact(page, "Child", MOCK_CHILD_ID);
  await addContact(page, "Parent", MOCK_PARENT_ID);

  // Set up the child slot and a mutual parent link.
  await page.locator("#add-child-slot").click();
  await page.locator("#contact-select").selectOption(MOCK_CHILD_ID);
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
  await page.locator(".slot").first().click();
  await page.locator("#adjust-amount").fill("2.00");
  await page.locator("#adjust-submit").click();
  await expect(page.locator(".slot .slot-label").first()).toHaveText("Child");
  await page.locator("#cancel-button").click();

  // The parent fixture does not point back, so this one-sided slot is listed as
  // unconfirmed instead of appearing in the child grid.
  await page.locator("#add-child-slot").click();
  await page.locator("#contact-select").selectOption(MOCK_PARENT_ID);
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#unconfirmed-list")).toContainText("Parent");

  await setParent(page, MOCK_PARENT_ID);
  await openAdvanced(page);
  await expect(page.locator("#parent-status")).toHaveText("Linked");
  // The parent row uses the parent board's own signed name, not the private
  // contact label ("Parent").
  await expect(page.locator("#parent-name")).toHaveText("Parent board");

  // Removing the child contact keeps both the signed id and the name this
  // board already gave the slot.
  await page.locator("#contacts-open").click();
  await page.getByRole("button", { name: "Remove Child" }).click();
  await expect(page.locator("#contacts-confirm")).toBeVisible();
  await page.locator("#contacts-confirm-remove").click();
  await expect(page.locator("#contacts-list")).not.toContainText("Child");
  await page.locator("#contacts-done").click();
  await expect(page.locator(".slot .slot-label").first()).toHaveText("Child");

  // The parent row already shows the parent's own name and does not change.
  await page.locator("#contacts-open").click();
  await page.getByRole("button", { name: "Remove Parent" }).click();
  await expect(page.locator("#contacts-confirm")).toBeVisible();
  await page.locator("#contacts-confirm-remove").click();
  await expect(page.locator("#contacts-list")).not.toContainText("Parent");
  await page.locator("#contacts-done").click();
  await expect(page.locator("#parent-name")).toHaveText("Parent board");

  // The default surface uses the name this board gave the slot.
  await openSimple(page);
  await expect(page.locator("#simple-children")).toContainText("Child");
  await openAdvanced(page);
  await page.waitForTimeout(250);

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
  await openAdvanced(page);
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
  await setParent(page, MOCK_PARENT_ID);
  await openAdvanced(page);
  await expect(page.locator("#parent-status")).toHaveText("Linked");
  await openSimple(page);
  await expect(page.locator("#simple-pay")).toBeEnabled();

  await page.locator("#simple-pay").click();
  await expect(page.locator("#payment-dialog")).toBeVisible();
  await page.locator("#payment-direct > summary").click();
  await page.locator("#payment-address").fill("1");
  await page.locator("#payment-user").fill("0".repeat(64));
  await page.locator("#payment-amount").fill("1.00");
  await page.locator("#payment-submit").click();
  await expect(page.locator("#payment-error")).toContainText("does not own");

  await page.locator("#payment-user").fill(MOCK_SIBLING_ID);
  await page.locator("#payment-submit").click();
  await expect(page.locator("#payment-dialog")).toBeHidden();
  await openAdvanced(page);
  await expect(page.locator("#payment-status")).toContainText("Offered");
  await expect(page.locator("#payment-status")).toContainText("Parent");
  await openSimple(page);
  await expect(page.locator("#simple-pay")).toBeDisabled();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("pays a child from the root and a parent from a child", async ({ page }) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await openAdvanced(page);
  await addContact(page, "Child", MOCK_CHILD_ID);
  await addContact(page, "Parent", MOCK_PARENT_ID);
  await saveDetails(page, 1, MOCK_CHILD_ID);

  // The first added slot is index 0, so the child's address is "0".
  // Root -> child: the source's single credit is the implicit issue and the
  // payment is terminal in that one delta.
  await openSimple(page);
  await expect(page.locator("#simple-pay")).toBeEnabled();
  await page.locator("#simple-pay").click();
  await expect(page.locator("#payment-dialog")).toBeVisible();
  await page.locator("#payment-direct > summary").click();
  await page.locator("#payment-address").fill("0");
  await page.locator("#payment-user").fill(MOCK_CHILD_ID);
  await page.locator("#payment-amount").fill("1.00");
  await page.locator("#payment-submit").click();
  await expect(page.locator("#payment-dialog")).toBeHidden();

  await openAdvanced(page);
  await expect(page.locator("#payment-status")).toContainText("Complete");
  await expect(page.locator("#payment-status-route")).toContainText(
    "implicit issue",
  );
  await expect(page.locator(".slot .slot-value").first()).toHaveText("1.00");

  // Child -> parent: become a child of the Parent fixture, then pay the root
  // (the empty address). The parent's debit is the implicit burn.
  await openAdvanced(page);
  await setParent(page, MOCK_PARENT_ID);
  await openAdvanced(page);
  await expect(page.locator("#parent-status")).toHaveText("Linked");
  await openSimple(page);
  await page.locator("#simple-pay").click();
  await expect(page.locator("#payment-dialog")).toBeVisible();
  await page.locator("#payment-direct > summary").click();
  await page.locator("#payment-user").fill(MOCK_PARENT_ID);
  await page.locator("#payment-amount").fill("1.00");
  await page.locator("#payment-submit").click();
  await expect(page.locator("#payment-dialog")).toBeHidden();

  await openAdvanced(page);
  await expect(page.locator("#payment-status")).toContainText("Offered");
  await expect(page.locator("#payment-status-route")).toContainText(
    "implicit burn",
  );
  await expect(page.locator("#payment-status-detail")).toContainText("Parent");
  // Let the dialog/status transitions settle before the contrast check.
  await page.waitForTimeout(250);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("defaults to the simple surface and hides slot wording and branding", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");

  await expect(page.locator("#simple-view")).toBeVisible();
  await expect(page.locator("#advanced-view")).toBeHidden();
  await expect(page.locator("#view-toggle")).toHaveText("Advanced");
  await expect(page.locator("#simple-view .button")).toHaveCount(3);
  await expect(page.locator("#simple-pay")).toBeDisabled();
  await expect(page.locator("#simple-pay-reason")).toBeVisible();
  await expect(page.locator("#simple-contacts")).toBeEnabled();
  await expect(page.locator("#simple-receive-link")).toBeDisabled();
  await expect(page.locator("#simple-receive-reason")).toHaveText(
    "A board with no links cannot receive yet. Add a child or set a parent first.",
  );

  // The default surface never says "slot", and the banned branding phrases do
  // not appear anywhere outside Advanced.
  await expect(page.locator("#simple-view")).not.toContainText(/slot/i);
  const visible = await page.locator("body").innerText();
  expect(visible).not.toMatch(/\bslot/i);
  expect(visible).not.toMatch(/8 slots|eight slots/i);
  await expect(page.locator(".wordmark-tag")).toHaveCount(0);

  await openAdvanced(page);
  await expect(page.locator("#child-slots-title")).toContainText("of 8");
  await expect(page.locator("#simple-view")).toBeHidden();

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("toggles Advanced, mirrors ?view=advanced, and Back leaves Advanced", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await expect(page.locator("#simple-view")).toBeVisible();
  await expect(page).not.toHaveURL(/view=advanced/);

  await page.locator("#view-toggle").click();
  await expect(page.locator("#advanced-view")).toBeVisible();
  await expect(page.locator("#simple-view")).toBeHidden();
  await expect(page.locator("#view-toggle")).toHaveText("Back to the simple view");
  await expect(page).toHaveURL(/\?view=advanced$/);
  await expect(page.locator("#advanced-title")).toBeFocused();

  await page.goBack();
  await expect(page.locator("#simple-view")).toBeVisible();
  await expect(page.locator("#advanced-view")).toBeHidden();
  await expect(page).not.toHaveURL(/view=advanced/);
  await expect(page.locator("#board-title")).toBeFocused();

  // A direct load opens Advanced, and leaving it strips the parameter without
  // adding a history entry that would bounce Back out of the app.
  await page.goto("/?view=advanced");
  await expect(page.locator("#advanced-view")).toBeVisible();
  await expect(page.locator("#view-toggle")).toHaveText("Back to the simple view");
  await page.locator("#view-toggle").click();
  await expect(page.locator("#simple-view")).toBeVisible();
  await expect(page).not.toHaveURL(/view=advanced/);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("copies a receive-payment link with visible feedback", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  // A board with no links cannot receive, so its link is disabled. A root with
  // a child can: its address is the empty string and the link carries it.
  await expect(page.locator("#simple-receive-link")).toBeDisabled();
  await openAdvanced(page);
  await addContact(page, "Parent", MOCK_PARENT_ID);
  await addContact(page, "Child", MOCK_CHILD_ID);
  await saveDetails(page, 1, MOCK_CHILD_ID);
  await openSimple(page);
  await expect(page.locator("#simple-receive-link")).toBeEnabled();
  await page.locator("#simple-receive-link").click();
  await expect(page.locator("#simple-receive-status")).toHaveText(
    "Link copied. Opening it adds your board to their address book.",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "addr=",
  );

  // A settled parent link changes the address to the parent's slot digit.
  await openAdvanced(page);
  await setParent(page, MOCK_PARENT_ID);
  await openAdvanced(page);
  await expect(page.locator("#parent-status")).toHaveText("Linked");
  await openSimple(page);
  await expect(page.locator("#simple-view")).toBeVisible();

  await expect(page.locator("#simple-receive-link")).toBeEnabled();
  await page.locator("#simple-receive-link").click();
  await expect(page.locator("#simple-receive-status")).toHaveText(
    "Link copied. Opening it adds your board to their address book.",
  );
  await expect(page.locator("#simple-receive-link")).toHaveText("Copied");
  await expect(page.locator("#simple-receive-link")).toHaveText(
    "Copy receive-payment link",
    { timeout: 3_000 },
  );

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("?pay=");
  expect(clipboard).toContain("name=My+board");
  expect(clipboard).toContain("addr=0");

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("refuses a receive link from a board with no links or an unsettled address", async ({
  page,
}) => {
  const errors = watchConsole(page);
  const receive = page.locator("#simple-receive-link");
  const reason = page.locator("#simple-receive-reason");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));

  // No links at all: no address and no receive path.
  await expect(receive).toBeDisabled();
  await expect(reason).toHaveText(
    "A board with no links cannot receive yet. Add a child or set a parent first.",
  );
  await receive.evaluate((element) => (element as HTMLButtonElement).click());
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "sentinel",
  );
  await expect(page.locator("#simple-receive-status")).toHaveText("");

  // A one-sided parent link also leaves the address unsettled; send and copy
  // both explain the reason up front instead of failing on the first press.
  await openAdvanced(page);
  await addContact(page, "Sibling", MOCK_SIBLING_ID);
  await setParent(page, MOCK_SIBLING_ID);
  await openAdvanced(page);
  await expect(page.locator("#parent-status")).toHaveText("Pending");
  await openSimple(page);
  await expect(page.locator("#simple-view")).toBeVisible();

  await expect(receive).toBeDisabled();
  await expect(reason).toHaveText(
    "Your address is not settled yet, so a link would not route a payment.",
  );
  await expect(page.locator("#simple-pay")).toBeDisabled();
  await expect(page.locator("#simple-pay-reason")).toHaveText(
    "A board on the path has not confirmed its parent yet. Check your parent link.",
  );

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("chooses a payment recipient from the address book", async ({ page }) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await openAdvanced(page);
  await addContact(page, "No address", MOCK_CHILD_ID);
  await addContact(page, "Sibling", MOCK_SIBLING_ID, "1");
  await addContact(page, "Parent", MOCK_PARENT_ID);

  // A source needs a parent; once linked the default surface can send.
  await setParent(page, MOCK_PARENT_ID);
  await openAdvanced(page);
  await expect(page.locator("#parent-status")).toHaveText("Linked");
  await openSimple(page);
  await expect(page.locator("#simple-pay")).toBeEnabled();

  await page.locator("#simple-pay").click();
  await expect(page.locator("#payment-dialog")).toBeVisible();
  await expect(page.locator("#payment-recipient")).toBeFocused();
  await expect(page.locator("#payment-recipient option").first()).toHaveText(
    "Choose someone…",
  );
  await expect(page.locator("#payment-submit")).toBeDisabled();
  await expect(page.locator("#payment-direct")).not.toHaveAttribute("open", "");

  // The address comes from the contact record, not from the other board.
  await page.locator("#payment-recipient").selectOption(MOCK_CHILD_ID);
  await expect(page.locator("#payment-recipient-status")).toHaveText(
    "No address yet. Ask them for a receive link.",
  );
  await expect(page.locator("#payment-submit")).toBeDisabled();

  // The dialog's own address-book button adds and selects in one step.
  await page.locator("#payment-address-book").click();
  await expect(page.locator("#contacts-dialog")).toBeVisible();
  await page.locator("#contact-label-input").fill("Payer");
  await page.locator("#contact-userid-input").fill(MOCK_PAYER_ID);
  await page.locator("#contact-address-input").fill("3");
  await page.locator("#contact-add-button").click();
  await expect(page.locator("#contacts-dialog")).toBeHidden();
  await expect(page.locator("#payment-dialog")).toBeVisible();
  await expect(page.locator("#payment-recipient")).toHaveValue(MOCK_PAYER_ID);
  await expect(page.locator("#payment-recipient-status")).toHaveText(
    "Address 3",
  );
  await expect(page.locator("#payment-submit")).toBeEnabled();

  // Send through the picker rather than the typed escape hatch.
  await page.locator("#payment-recipient").selectOption(MOCK_SIBLING_ID);
  await expect(page.locator("#payment-recipient-status")).toHaveText(
    "Address 1",
  );
  await page.locator("#payment-amount").fill("1.00");
  await page.locator("#payment-submit").click();
  await expect(page.locator("#payment-dialog")).toBeHidden();
  await openAdvanced(page);
  await expect(page.locator("#payment-status")).toContainText("Offered");
  await expect(page.locator("#payment-status")).toContainText("1.00 along 0 → 1");
  await page.waitForTimeout(300);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("edits a contact and keeps the field it did not touch", async ({ page }) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await openAdvanced(page);
  await addContact(page, "Alice", MOCK_CHILD_ID, "03");
  await page.locator("#contacts-open").click();
  await expect(page.locator("#contacts-dialog")).toBeVisible();

  const row = page.locator(`.contact-row[data-user-id="${MOCK_CHILD_ID}"]`);
  await expect(row.locator(".contact-address")).toHaveText("03");

  // Rename only: the stored address must survive the delegate patch.
  await row.getByRole("button", { name: "Edit Alice" }).click();
  const nameInput = page.getByLabel("Name for Alice");
  await expect(nameInput).toHaveValue("Alice");
  await nameInput.fill("Alicia");
  await page.locator(".contact-edit-save").click();
  await expect(row.locator(".contact-label")).toHaveText("Alicia");
  await expect(row.locator(".contact-address")).toHaveText("03");

  // Change the address only: the label must survive.
  await row.getByRole("button", { name: "Edit Alicia" }).click();
  await page.getByLabel("Octal address for Alicia").fill("4");
  await page.locator(".contact-edit-save").click();
  await expect(row.locator(".contact-label")).toHaveText("Alicia");
  await expect(row.locator(".contact-address")).toHaveText("4");

  // The address field is optional; the root (empty) is not a stored address.
  await page.locator("#contact-label-input").fill("Bob");
  await page.locator("#contact-userid-input").fill(MOCK_PAYER_ID);
  await page.locator("#contact-address-input").fill("");
  await page.locator("#contact-add-button").click();
  const bob = page.locator(`.contact-row[data-user-id="${MOCK_PAYER_ID}"]`);
  await expect(bob.locator(".contact-address")).toHaveText("not set");

  await page.locator("#contacts-done").click();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("prefills and saves a contact from a receive-payment link", async ({
  page,
}) => {
  const errors = watchConsole(page);
  const id = "ab".repeat(32);

  await page.goto(`/?pay=${id}&name=Alice&addr=03`);
  await expect(page.locator("#contacts-dialog")).toBeVisible();
  await expect(page.locator("#contacts-invite")).toBeVisible();
  await expect(page.locator("#contacts-invite-title")).toHaveText(
    "Alice shared their board with you.",
  );
  await expect(page.locator("#contacts-invite-address")).toHaveText("03");
  await expect(page.locator("#contacts-invite-key")).toHaveText(id);
  await expect(page.locator("#contacts-invite")).toContainText(
    "checked again when a payment is planned",
  );
  await expect(page.locator("#contact-label-input")).toHaveValue("Alice");
  await expect(page.locator("#contact-userid-input")).toHaveValue(id);
  await expect(page.locator("#contact-address-input")).toHaveValue("03");
  // Nothing is saved until Add contact, and the link params are gone.
  await expect(page.locator("#contacts-dialog-count")).toHaveText("0 of 64");
  await expect(page).not.toHaveURL(/pay=/);

  await page.locator("#contact-add-button").click();
  await expect(page.locator("#contacts-invite")).toBeHidden();
  await expect(page.locator("#contacts-list")).toContainText("Alice");
  await expect(page.locator("#contacts-dialog-count")).toHaveText("1 of 64");
  await expect(
    page.locator(`.contact-row[data-user-id="${id}"] .contact-address`),
  ).toHaveText("03");

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("waits for the board-name prompt before opening a receive link", async ({
  page,
}) => {
  const errors = watchConsole(page);
  const id = "cd".repeat(32);

  await page.goto(`/?unnamed=1&pay=${id}&name=Alice&addr=03`);
  await expect(page.locator("#board-name-dialog")).toBeVisible();
  await expect(page.locator("#contacts-dialog")).toBeHidden();

  await page.locator("#board-name-input").fill("Test board");
  await page.locator("#board-name-save").click();
  await expect(page.locator("#board-name-dialog")).toBeHidden();
  await expect(page.locator("#contacts-dialog")).toBeVisible();
  await expect(page.locator("#contact-label-input")).toHaveValue("Alice");
  await expect(page.locator("#contact-address-input")).toHaveValue("03");
  await expect(page).not.toHaveURL(/pay=/);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("rejects incomplete, own and duplicate receive links", async ({ page }) => {
  const errors = watchConsole(page);

  await page.goto("/?pay=not-a-key&name=Alice");
  await expect(page.locator("#notice-title")).toHaveText(
    "That link is incomplete",
  );
  await expect(page.locator("#contacts-dialog")).toBeHidden();
  await expect(page).not.toHaveURL(/pay=/);

  await page.goto("/");
  await expect(page.locator("#identity-short")).not.toHaveText("Not available");
  const ownId = await page.locator("#identity-short").getAttribute("title");
  expect(ownId).toMatch(/^[0-9a-f]{64}$/);
  await page.goto(`/?pay=${ownId}&name=Self`);
  await expect(page.locator("#notice-title")).toHaveText(
    "That link is your own board",
  );
  await expect(page.locator("#contacts-dialog")).toBeHidden();
  await expect(page).not.toHaveURL(/pay=/);

  // Offline contacts live only in memory, so add one then hand the app the
  // same link without a reload (a real delegate would already have it).
  await page.goto("/");
  await addContact(page, "Alice", MOCK_CHILD_ID, "03");
  await page.evaluate((id) => {
    const url = new URL(window.location.href);
    url.searchParams.set("pay", id);
    url.searchParams.set("name", "Alice");
    url.searchParams.set("addr", "03");
    history.replaceState(history.state, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, MOCK_CHILD_ID);
  await expect(page.locator("#contacts-dialog")).toBeVisible();
  await expect(page.locator("#contacts-status")).toHaveText(
    "Already in your address book.",
  );
  await expect(
    page.locator(`.contact-row[data-user-id="${MOCK_CHILD_ID}"]`),
  ).toHaveClass(/is-highlighted/);
  await expect(page).not.toHaveURL(/pay=/);

  // A repeat link with a corrected address refreshes the saved contact.
  await page.evaluate((id) => {
    const url = new URL(window.location.href);
    url.searchParams.set("pay", id);
    url.searchParams.set("addr", "4");
    history.replaceState(history.state, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, MOCK_CHILD_ID);
  await expect(
    page.locator(`.contact-row[data-user-id="${MOCK_CHILD_ID}"] .contact-address`),
  ).toHaveText("4");
  await expect(page.locator("#contacts-status")).toHaveText(
    "Already in your address book.",
  );

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});
