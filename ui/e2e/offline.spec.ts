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

const GHOST_ID = "3333333333333333".repeat(4);

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

/**
 * Add a child through the region assignment picker, choosing the lowest free
 * slot (the same slot the old direct path opened), then return to the editor.
 */
async function openAssignEditor(page: Page): Promise<void> {
  await page.locator("#add-child-slot").click();
  await expect(page.locator("#region-dialog")).toBeVisible();
  await expect(page.locator("#region-assign-panel")).toBeVisible();
  await expect(
    page.locator("#region-assign-cards .region-assign-card").first(),
  ).toBeVisible();

  for (let index = 0; index < 8; index += 1) {
    const input = page.locator(
      `#region-assign-cards .region-assign-card[data-slot="${index}"] input`,
    );
    if ((await input.count()) > 0 && (await input.isEnabled())) {
      await input.check();
      break;
    }
  }

  await expect(page.locator("#region-assign-choose")).toBeEnabled();
  await page.locator("#region-assign-choose").click();
  await expect(page.locator("#region-dialog")).toBeHidden();
  await expect(page.locator("#editor")).toBeVisible();
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
  else await openAssignEditor(page);
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

  // The default surface is the zone header, record card, three actions.
  await expect(page.getByRole("heading", { level: 1, name: "Tally" })).toBeVisible();
  await expect(page.locator("#simple-view")).toBeVisible();
  await expect(page.locator("#advanced-view")).toBeHidden();
  await expect(page.locator("#board-title")).toHaveText("Your zone");
  await expect(
    page.getByRole("heading", { level: 2, name: "Your zone" }),
  ).toBeVisible();
  await expect(page.locator("#simple-address")).toBeVisible();
  await expect(page.locator("#simple-address-value")).toHaveText("root");
  await expect(page.locator("#simple-parent")).toBeVisible();
  await expect(page.locator("#simple-parent-name")).toHaveText("No parent yet");
  await expect(page.locator("#parent-edit")).toHaveText("Add a parent");
  await expect(page.locator("#simple-pay")).toBeDisabled();
  await expect(page.locator("#simple-pay-reason")).toContainText("no links");
  await expect(page.locator("#simple-view")).not.toContainText(/slot/i);
  await expect(page.locator("#simple-view .button")).toHaveCount(3);

  await openAdvanced(page);
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await expect(page.locator("#identity-short")).toBeVisible();
  await expect(page.locator("#identity-short")).not.toHaveText("Not available");
  await expect(page.locator("#board-name-row")).toHaveCount(0);
  await expect(page.locator("#board-name-dialog")).toHaveCount(0);
  await expect(page.locator("#contract-short")).not.toHaveText("Not derived");
  await expect(page.locator(".slot")).toHaveCount(8);
  await expect(page.locator("#contacts-count")).toHaveText("0");

  // The editor starts without contacts: a clear hint and a disabled Save. The
  // liability block explains that a contact must be saved first. There are no
  // mutual children yet, so the empty grid offers the add control instead.
  await expect(page.locator("#child-slots-title")).toHaveText("Child slots (0 of 8)");
  await expect(page.locator("#child-slots-empty")).toBeVisible();
  await openAssignEditor(page);
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
  await expect(page.locator("#board-title")).toHaveText("Your zone");
  await expect(page.locator("#simple-parent")).toBeVisible();
  await expect(page.locator("#simple-parent-name")).toHaveText("No parent yet");
  await expect(page.locator("#simple-address-value")).toHaveText("root");
  await openAdvanced(page);
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await expect(page.locator("#identity-short")).toBeVisible();
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
  await openAssignEditor(page);
  await page.locator("#contact-select").selectOption(MOCK_CHILD_ID);
  await expect(page.locator("#child-link-status")).toHaveText("Linked");
  await expect(page.locator("#child-link-detail")).toContainText(
    "lists this zone as its parent",
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
  const childSlotId = page.locator(".slot .slot-id").first();
  await expect(childSlotId).toHaveText(
    `${MOCK_CHILD_ID.slice(0, 8)}…${MOCK_CHILD_ID.slice(-8)}`,
  );
  await expect(childSlotId).toHaveAttribute("title", MOCK_CHILD_ID);
  const childSlotRegion = page.locator(".slot .slot-region").first();
  await expect(childSlotRegion).toBeVisible();
  await expect(childSlotRegion).toHaveText("region 0");
  await expect(childSlotRegion).toHaveAttribute(
    "title",
    "Slot 1 · address 0 · cell a",
  );

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
  await expect(
    page.locator("#simple-children .simple-child-address"),
  ).toHaveText("0");

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
  await openAssignEditor(page);
  await page.locator("#contact-select").selectOption(MOCK_PARENT_ID);
  await expect(page.locator("#child-link-status")).toHaveText("Pending");
  await expect(page.locator("#child-link-detail")).toContainText(
    "has not set this zone as its parent",
  );
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#unconfirmed-list")).toContainText("Parent");
  await expect(page.locator("#child-slots-title")).toHaveText("Child slots (1 of 8)");

  // Setting this zone's parent to the child would close a loop, so it is
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
  // This zone is now a child: the parent's empty address plus slot digit 0.
  await expect(page.locator("#board-address")).toHaveAttribute("data-address", "0");
  await expect(page.locator("#board-address-value")).toHaveText("0");
  await expect(page.locator("#parent-name")).toHaveText("Parent");

  // The default surface shows the value as given by the parent, and it does
  // not mention the parent now that the link is usable.
  await openSimple(page);
  await expect(page.locator("#board-title")).toHaveText("Your zone");
  await expect(page.locator("#simple-address-value")).toHaveText("0");
  await expect(page.locator("#simple-parent")).toBeHidden();
  await expect(page.locator("#parent-value-title")).toHaveText("Balance");
  await expect(page.locator("#parent-value")).toContainText("8.50");
  await expect(page.locator("#parent-value")).toContainText("kg");
  await expect(page.locator("#parent-value")).not.toContainText(
    "You can't change it here.",
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
  await openAssignEditor(page);
  await page.locator("#contact-select").selectOption(MOCK_CHILD_ID);
  await expect(page.locator("#contact-hint")).toContainText("already in slot 1");
  await expect(page.locator("#save-button")).toBeDisabled();
  await page.locator("#cancel-button").click();

  // A contact with no board is "Not created yet"; the slot still saves and is
  // listed as an unconfirmed fact.
  await openAssignEditor(page);
  await page.locator("#contact-select").selectOption(GHOST_ID);
  await expect(page.locator("#child-link-status")).toHaveText("Not created yet");
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#unconfirmed-list")).toContainText("Ghost");

  // A usable parent stays quiet: no change or clear controls on the simple view.
  await openSimple(page);
  await expect(page.locator("#simple-parent")).toBeHidden();
  await expect(page.locator("#parent-clear")).toBeHidden();
  await openAdvanced(page);
  await expect(page.locator("#parent-name")).toHaveText("Parent");
  // Let the advanced surface's entrance animation settle before axe reads it.
  await page.waitForTimeout(600);

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
  const childId = children.locator(".simple-child-id");
  await expect(childId).toHaveText(
    `${MOCK_CHILD_ID.slice(0, 8)}…${MOCK_CHILD_ID.slice(-8)}`,
  );
  await expect(childId).toHaveAttribute("title", MOCK_CHILD_ID);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("adds a parent from the default surface, then keeps it quiet", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await openAdvanced(page);
  await addContact(page, "Parent", MOCK_PARENT_ID);
  await openSimple(page);
  await expect(page.locator("#simple-parent")).toBeVisible();
  await expect(page.locator("#simple-parent-name")).toHaveText("No parent yet");
  await expect(page.locator("#simple-parent #parent-edit")).toHaveText(
    "Add a parent",
  );
  await expect(page.locator("#simple-parent #parent-clear")).toBeHidden();

  await page.locator("#parent-edit").click();
  await page.locator("#parent-select").selectOption(MOCK_PARENT_ID);

  // The parent fixture has this zone in its slot 0, so the candidate must see
  // the assigned region before signing: address 0, cell a. This is the
  // designation the parent wrote first.
  const region = page.locator("#parent-region");
  await expect(region).toBeVisible();
  await expect(page.locator("#parent-region-address")).toHaveText("0");
  await expect(page.locator("#parent-region-cell")).toContainText(
    "Slot 1 · cell a",
  );
  await expect(page.locator("#parent-region-state")).toHaveText(
    "Assigned region",
  );
  await expect(page.locator("#parent-region-warning")).toContainText(
    "Check it on the map",
  );

  await page.locator("#parent-region-map").click();
  await expect(page.locator("#region-review-panel")).toBeVisible();
  await expect(page.locator("#region-review-address")).toHaveText("0");
  await expect(page.locator("#region-review-cell")).toContainText("Cell a");
  await page.locator("#region-review-close").click();
  await expect(page.locator("#region-dialog")).toBeHidden();

  await page.locator("#parent-save").click();
  await expect(page.locator("#parent-dialog")).toBeHidden();

  // A usable parent is not mentioned on the simple view at all.
  await expect(page.locator("#simple-parent")).toBeHidden();
  await expect(page.locator("#parent-edit")).toBeHidden();
  await expect(page.locator("#parent-clear")).toBeHidden();
  expect(await page.locator("#simple-view").innerText()).not.toContain("Parent");
  await expect(page.locator("#parent-value-title")).toHaveText("Balance");

  // Advanced is where a healthy parent is changed or cleared.
  await openAdvanced(page);
  await expect(page.locator("#parent-name")).toHaveText("Parent");
  await expect(page.locator("#parent-status")).toHaveText("Linked");
  await expect(page.locator("#parent-advanced-edit")).toBeVisible();
  await expect(page.locator("#parent-advanced-edit")).toHaveText("Change parent…");
  await expect(page.locator("#parent-advanced-clear")).toBeVisible();
  await expect(page.locator("#parent-advanced-clear")).toHaveText("Clear parent");
  await expect(page.locator("#advanced-view #parent-edit")).toHaveCount(0);
  await expect(page.locator("#advanced-view #parent-clear")).toHaveCount(0);

  // Change opens the same dialog; clearing returns the zone to a root and
  // removes both Advanced controls.
  await page.locator("#parent-advanced-edit").click();
  await expect(page.locator("#parent-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#parent-dialog")).toBeHidden();
  await page.locator("#parent-advanced-clear").click();
  await expect(page.locator("#parent-name")).toHaveText("Root");
  await expect(page.locator("#parent-advanced-edit")).toBeHidden();
  await expect(page.locator("#parent-advanced-clear")).toBeHidden();
  await openSimple(page);
  await expect(page.locator("#simple-parent")).toBeVisible();
  await expect(page.locator("#parent-edit")).toHaveText("Add a parent");

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
    "Payments move one zone at a time. Each owner opens their zone to sign their leg.",
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

test("never asks for a zone name and shows no name controls", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await expect(page.locator("#status-pill")).toHaveAttribute("data-status", "offline");
  await expect(page.locator("#simple-view")).toBeVisible();
  await expect(page.locator("#board-title")).toHaveText("Your zone");
  await expect(page.locator("#board-name-dialog")).toHaveCount(0);
  await expect(page.locator("#board-name")).toHaveCount(0);

  await openAdvanced(page);
  await expect(page.locator("#board-name-row")).toHaveCount(0);
  await expect(page.locator("#board-name-edit")).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toMatch(/board name/i);

  // The only name on the simple view belongs to the children the parent named.
  await openSimple(page);
  expect(await page.locator("#simple-view").innerText()).not.toMatch(/board name/i);

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
  await openAssignEditor(page);
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
  await openAssignEditor(page);
  await page.locator("#contact-select").selectOption(MOCK_PARENT_ID);
  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#unconfirmed-list")).toContainText("Parent");

  await setParent(page, MOCK_PARENT_ID);
  await openAdvanced(page);
  await expect(page.locator("#parent-status")).toHaveText("Linked");
  // The parent row uses this device's private contact label.
  await expect(page.locator("#parent-name")).toHaveText("Parent");

  // Removing the child contact keeps both the signed id and the name this
  // board already gave the slot.
  await page.locator("#contacts-open").click();
  await page.getByRole("button", { name: "Remove Child" }).click();
  await expect(page.locator("#contacts-confirm")).toBeVisible();
  await page.locator("#contacts-confirm-remove").click();
  await expect(page.locator("#contacts-list")).not.toContainText("Child");
  await page.locator("#contacts-done").click();
  await expect(page.locator(".slot .slot-label").first()).toHaveText("Child");

  // The parent row keeps the private contact label even after the contact goes.
  await page.locator("#contacts-open").click();
  await page.getByRole("button", { name: "Remove Parent" }).click();
  await expect(page.locator("#contacts-confirm")).toBeVisible();
  await page.locator("#contacts-confirm-remove").click();
  await expect(page.locator("#contacts-list")).not.toContainText("Parent");
  await page.locator("#contacts-done").click();
  await expect(page.locator("#parent-name")).toHaveText(/^Owner [0-9a-f]{8}$/);

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
    "A zone with no links cannot receive yet. Add a child or set a parent first.",
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

test("shows the owner id on the simple view and copies the full key", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");

  const id = page.locator("#simple-owner-id");
  await expect(id).toBeVisible();
  await expect(id).toHaveText(/^[0-9a-f]{8}…[0-9a-f]{8}$/);
  const full = await id.getAttribute("title");
  if (full === null) throw new Error("the owner id has no full title");
  expect(full).toMatch(/^[0-9a-f]{64}$/);

  // The Advanced identity row shows the same key, also shortened.
  await openAdvanced(page);
  await expect(page.locator("#identity-short")).toHaveText(
    `${full.slice(0, 8)}…${full.slice(-8)}`,
  );

  await openSimple(page);
  await expect(page.locator("#simple-owner-copy")).toBeEnabled();
  await page.locator("#simple-owner-copy").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(full);
  await expect(page.locator("#simple-owner-status")).toHaveText("Copied.");

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
    "Link copied. Opening it adds your zone to their address book.",
  );
  const rootLink = await page.evaluate(() => navigator.clipboard.readText());
  expect(rootLink).toContain("addr=");
  // No parent has named this zone, so the link omits `name`.
  expect(rootLink).not.toContain("name=");

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
    "Link copied. Opening it adds your zone to their address book.",
  );
  await expect(page.locator("#simple-receive-link")).toHaveText("Copied");
  await expect(page.locator("#simple-receive-link")).toHaveText(
    "Copy receive-payment link",
    { timeout: 3_000 },
  );

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("?pay=");
  expect(clipboard).toContain("name=My+zone");
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
    "A zone with no links cannot receive yet. Add a child or set a parent first.",
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
    "A zone on the path has not confirmed its parent yet. Check your parent link.",
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
    "Alice shared their zone with you.",
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

test("opens a receive link without a first-run name prompt", async ({
  page,
}) => {
  const errors = watchConsole(page);
  const id = "cd".repeat(32);

  await page.goto(`/?pay=${id}&name=Alice&addr=03`);
  await expect(page.locator("#board-name-dialog")).toHaveCount(0);
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
    "That link is your own zone",
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

test("region panel shows the root zone and its eight child cells", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await openAdvanced(page);
  await page.locator("#region-open").click();

  await expect(page.locator("#region-dialog")).toBeVisible();
  await expect(page.locator("#region-panel-zone")).toBeVisible();
  await expect(page.locator("#region-zone-address")).toHaveText("root");
  await expect(page.locator("#region-zone-badge")).toHaveText("The world");
  await expect(page.locator("#region-cells li")).toHaveCount(8);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("assignment picker opens the slot editor for the chosen cell", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await openAdvanced(page);
  await page.locator("#add-child-slot").click();

  await expect(page.locator("#region-dialog")).toBeVisible();
  await expect(page.locator("#region-assign-panel")).toBeVisible();
  const cards = page.locator("#region-assign-cards .region-assign-card");
  await expect(cards).toHaveCount(8);

  // Without a location no cell is preselected; choose the slot-0 card
  // explicitly, so the assertion below tests the chosen-cell handoff rather
  // than the ranking order.
  const firstFree = page.locator(
    '#region-assign-cards .region-assign-card[data-slot="0"] input',
  );
  await firstFree.check();
  await expect(page.locator("#region-assign-choose")).toBeEnabled();
  await page.locator("#region-assign-choose").click();

  await expect(page.locator("#region-dialog")).toBeHidden();
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#editor-title")).toHaveText("Slot 1");

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("region picker resolves a point from sample data", async ({ page }) => {
  const errors = watchConsole(page);
  const external: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (
      !url.startsWith("http://127.0.0.1:4173") &&
      !url.startsWith("data:") &&
      !url.startsWith("blob:")
    ) {
      external.push(url);
    }
  });

  await page.goto("/");
  await openAdvanced(page);
  await page.locator("#region-open").click();
  await expect(page.locator("#region-dialog")).toBeVisible();
  // The zone mode opens first; the place lookup lives behind its tab.
  await expect(page.locator("#region-panel-zone")).toBeVisible();
  await page.locator("#region-tab-place").click();
  await expect(page.locator("#region-panel-place")).toBeVisible();

  await page.locator("#region-lat").fill("1");
  await page.locator("#region-lng").fill("1");
  await page.locator("#region-form button[type=submit]").click();

  await expect(page.locator("#region-path")).toHaveText("aa");
  await expect(page.locator("#region-octal")).toHaveText("00");
  await expect(page.locator("#region-depth")).toHaveText("2");
  await expect(page.locator("#region-population")).toHaveText("1");
  await expect(page.locator("#region-children tr")).toHaveCount(8);
  await expect(page.locator("#region-source")).toContainText("Sample");

  expect(external).toEqual([]);
  const results = await new AxeBuilder({ page })
    .include("#region-dialog")
    .analyze();
  expect(results.violations).toEqual([]);
  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("opens the members room, shows the plaintext notice, and sends a message", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await openAdvanced(page);
  await expect(page.locator("#room-block")).toBeVisible();
  await expect(page.locator("#room-block-summary")).toHaveText(
    "Just you so far. Messages are public.",
  );

  await page.locator("#room-open").click();
  await expect(page.locator("#room-dialog")).toBeVisible();
  await expect(page.locator("#room-plaintext-notice")).toBeVisible();
  await expect(page.locator("#room-membership-state")).toBeVisible();
  await expect(page.locator("#room-membership-state")).toHaveAttribute(
    "data-state",
    "match",
  );
  await expect(page.locator(".room-message")).toHaveCount(1);

  await page.locator("#room-message-input").fill("Hello from the offline room.");
  await page.locator("#room-send").click();
  await expect(page.locator(".room-message")).toHaveCount(2);
  await expect(
    page.locator(".room-message").filter({ hasText: "Hello from the offline room." }),
  ).toBeVisible();

  // Let the dialog entrance settle before axe reads computed colours.
  await page.waitForTimeout(250);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("enables encryption, sends a ciphertext body, and decrypts it in the DOM", async ({
  page,
}) => {
  const errors = watchConsole(page);
  const plaintext = "encrypted offline hello";
  const plaintextHex = Buffer.from(plaintext, "utf8").toString("hex");

  await page.goto("/");
  await openAdvanced(page);
  await page.locator("#room-open").click();
  await expect(page.locator("#room-dialog")).toBeVisible();
  await expect(page.locator("#room-membership-state")).toHaveAttribute(
    "data-state",
    "match",
  );

  await expect(page.locator("#room-encryption-state")).toHaveAttribute(
    "data-state",
    "plaintext",
  );
  await expect(page.locator("#room-encryption-state")).toHaveText(
    "Not encrypted",
  );
  await expect(page.locator("#room-plaintext-notice")).toContainText(
    "plaintext",
  );

  await expect(page.locator("#room-encryption-action")).toHaveText(
    "Enable encryption",
  );
  await page.locator("#room-encryption-action").click();
  await expect(page.locator("#room-encryption-state")).toHaveAttribute(
    "data-state",
    "encrypted",
    { timeout: 10_000 },
  );
  await expect(page.locator("#room-encryption-action")).toHaveText("Rotate key");
  await expect(page.locator("#room-plaintext-notice")).toContainText(
    "encrypted for its current members",
  );

  await page.locator("#room-message-input").fill(plaintext);
  await page.locator("#room-send").click();
  const sent = page.locator(".room-message").filter({ hasText: plaintext });
  await expect(sent).toBeVisible();
  await expect(sent).toHaveAttribute("data-encryption", "encrypted");
  await expect(
    sent.locator(".room-message-encryption"),
  ).toHaveAttribute("data-state", "encrypted");

  const ownId = await page.locator("#identity-short").getAttribute("title");
  const stored = await page.evaluate((owner) => {
    const hook = (window as unknown as {
      __TALLY_OFFLINE_ROOM_STATE__?: (ownerId: string) => {
        messages?: Array<{ body?: string }>;
      } | null;
    }).__TALLY_OFFLINE_ROOM_STATE__;
    const state = hook ? hook(owner) : null;
    const messages = state?.messages ?? [];
    return messages.length === 0 ? null : (messages[messages.length - 1].body ?? null);
  }, ownId ?? "");

  expect(stored).not.toBeNull();
  expect(stored!.startsWith("01")).toBe(true);
  expect(stored).not.toContain(plaintextHex);
  expect(stored).not.toContain(plaintext);

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("offers a membership update after adding a child and keeps old messages as history", async ({
  page,
}) => {
  const errors = watchConsole(page);

  await page.goto("/");
  await openAdvanced(page);
  await addContact(page, "Child", MOCK_CHILD_ID);
  await saveDetails(page, 0, MOCK_CHILD_ID);

  await expect(page.locator("#room-block-summary")).toHaveText(
    "Owner and 1 child zone. Messages are public.",
  );
  await page.locator("#room-open").click();
  await expect(page.locator("#room-dialog")).toBeVisible();
  await expect(page.locator("#room-membership-state")).toHaveAttribute(
    "data-state",
    "mismatch",
  );
  await expect(page.locator("#room-mismatch")).toBeVisible();

  // Hard lock: a slot/membership mismatch disables the composer, not warns.
  await expect(page.locator("#room-message-input")).toBeDisabled();
  await expect(page.locator("#room-send")).toBeDisabled();
  await expect(page.locator("#room-message-hint")).toContainText(
    "Membership is out of date. Update it before sending",
  );

  await page.locator("#room-update-membership").click();
  await expect(page.locator("#room-membership-confirm-update")).toBeVisible();
  await page.locator("#room-membership-confirm-update").click();
  await expect(page.locator("#room-membership-state")).toHaveAttribute(
    "data-state",
    "match",
  );
  await expect(page.locator("#room-message-input")).toBeEnabled();

  // The seeded epoch-1 message survives the seq-2 membership as history.
  await expect(page.locator(".room-message").first()).toHaveAttribute(
    "data-history",
    "true",
  );

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("opens a parent's members room from a ?room= deep link", async ({
  page,
}) => {
  const errors = watchConsole(page);

  // The link is queued until the offline identity and zone are ready, then the
  // room dialog opens on its own (no Advanced-only control is involved).
  await page.goto(`/?room=${MOCK_PARENT_ID}`);
  await expect(page.locator("#room-dialog")).toBeVisible();
  await expect(page.locator("#room-plaintext-notice")).toBeVisible();

  // The heading shows the target owner short id, with the full id in its title.
  await expect(page.locator("#room-title")).toContainText(
    MOCK_PARENT_ID.slice(0, 8),
  );
  await expect(page.locator("#room-title")).toHaveAttribute(
    "title",
    MOCK_PARENT_ID,
  );
  await expect(page.locator("#room-target")).toHaveText("Another zone's room");

  // A foreign room has no owner controls and no local-slot comparison.
  await expect(page.locator("#room-update-membership")).toBeHidden();
  await expect(page.locator("#room-mismatch")).toBeHidden();
  await expect(page.locator(".room-member-row")).toHaveCount(1);
  await expect(page.locator(".room-member-row")).toHaveAttribute(
    "data-state",
    "in-room",
  );

  // The offline parent room is seeded owner-only. The contract only lets a
  // member send, and the own id is not in that membership, so the composer is
  // blocked with the existing not-member reason instead of sending.
  await expect(page.locator("#room-message-input")).toBeDisabled();
  await expect(page.locator("#room-send")).toBeDisabled();
  await expect(page.locator("#room-message-hint")).toContainText(
    "not a member of the room's current membership",
  );

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("joins a zone from Advanced with a root id, a point, and a signed request", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await openAdvanced(page);

  await expect(page.locator("#identity-short")).toHaveAttribute(
    "title",
    /^[0-9a-f]{64}$/,
  );
  const ownerId = await page.locator("#identity-short").getAttribute("title");
  expect(ownerId).toMatch(/^[0-9a-f]{64}$/);

  await page.locator("#join-open").click();
  await expect(page.locator("#join-dialog")).toBeVisible();
  await expect(page.locator("#join-title")).toBeFocused();

  await page.locator("#join-root-input").fill(ownerId!);
  await page.locator("#join-root-continue").click();

  await expect(page.locator("#join-place-title")).toBeVisible();
  await page.locator("#join-lat").fill("10");
  await page.locator("#join-lng").fill("10");
  await page.locator("#join-point").click();

  await expect(page.locator("#join-result")).toBeVisible();
  await expect(page.locator("#join-result-title")).toBeFocused();
  await expect(page.locator("#join-chain")).toContainText("root");
  await expect(
    page.locator('#join-chain .onboarding-chain-row[data-target="true"]'),
  ).toContainText("your target");
  await expect(page.locator("#join-target-address")).toContainText(
    "the root zone",
  );
  await expect(page.locator("#join-target-slots")).toHaveText("0 / 8 slots taken");
  await expect(page.locator("#join-target-accepting")).toContainText(
    "Accepting requests",
  );

  await expect(page.locator("#join-assigned-slot")).toHaveText("Slot 1");
  await expect(page.locator("#join-assigned-digit")).toContainText(
    "zero-based digit 0",
  );
  await expect(page.locator("#join-assigned-address")).toHaveText("0");
  await expect(page.locator("#join-assigned-badge")).toHaveText("Published");

  await expect(page.locator("#join-public-id")).toHaveText(ownerId!);
  await expect(page.locator("#join-public-cell")).toHaveText("cell 01");
  await page.locator("#join-note").fill("Hello from the offline test");
  await expect(page.locator("#join-note-count")).toContainText("/ 256 bytes");
  await expect(page.locator("#join-public-note")).toHaveText(
    "Hello from the offline test",
  );

  await expect(page.locator("#join-submit")).toBeEnabled();
  await page.locator("#join-submit").click();
  await expect(page.locator("#join-request-success")).toBeVisible();
  await expect(page.locator("#join-request-success")).toContainText(
    "Waiting for the owner to interview you.",
  );
  await expect(page.locator("#join-request-id")).not.toHaveText("");
  await expect(page.locator("#join-submit")).toBeDisabled();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test("opens discovery from a ?root= link and clears it only when closed", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await expect(page.locator("#identity-short")).toHaveAttribute(
    "title",
    /^[0-9a-f]{64}$/,
  );
  const ownerId = await page.locator("#identity-short").getAttribute("title");

  await page.goto(`/?root=${ownerId}`);
  await expect(page.locator("#join-dialog")).toBeVisible();
  await expect(page.locator("#join-root-input")).toHaveValue(ownerId!);
  await expect(page.locator("#join-place-title")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("root")).toBe(ownerId);

  await page.locator("#join-close").click();
  await expect(page.locator("#join-dialog")).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]root=/);
  expect(new URL(page.url()).searchParams.has("root")).toBe(false);
  expect(errors).toEqual([]);
});

test("keeps a duplicate ?root= value and explains it", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await expect(page.locator("#identity-short")).toHaveAttribute(
    "title",
    /^[0-9a-f]{64}$/,
  );
  const ownerId = await page.locator("#identity-short").getAttribute("title");

  await page.goto(`/?root=${ownerId}&root=${ownerId}`);
  await expect(page.locator("#join-dialog")).toBeVisible();
  await expect(page.locator("#join-root-error")).toBeVisible();
  await expect(page.locator("#join-root-error")).toContainText(
    "not a root link or id",
  );
  await expect(page.locator("#join-root-input")).toHaveValue(
    `${ownerId} ${ownerId}`,
  );
  await expect(page.locator("#join-root-continue")).toBeEnabled();
  expect(errors).toEqual([]);
});

test("reviews and moderates the owner's join-request queue", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await openAdvanced(page);

  await expect(page.locator("#identity-short")).toHaveAttribute(
    "title",
    /^[0-9a-f]{64}$/,
  );
  const ownerId = await page.locator("#identity-short").getAttribute("title");
  expect(ownerId).toMatch(/^[0-9a-f]{64}$/);

  // Use the real join flow to put one request into the own zone's queue.
  await page.locator("#join-open").click();
  await expect(page.locator("#join-dialog")).toBeVisible();
  await page.locator("#join-root-input").fill(ownerId!);
  await page.locator("#join-root-continue").click();
  await expect(page.locator("#join-place-title")).toBeVisible();
  await page.locator("#join-lat").fill("10");
  await page.locator("#join-lng").fill("10");
  await page.locator("#join-point").click();
  await expect(page.locator("#join-result")).toBeVisible();
  await page.locator("#join-note").fill("Offline queue check");
  await page.locator("#join-submit").click();
  await expect(page.locator("#join-request-success")).toBeVisible();
  await page.locator("#join-close").click();
  await expect(page.locator("#join-dialog")).toBeHidden();

  await expect(page.locator("#requests-block")).toBeVisible();
  await page.locator("#requests-open").click();
  await expect(page.locator("#requests-dialog")).toBeVisible();
  await expect(page.locator("#requests-title")).toBeFocused();

  await expect(page.locator("#requests-count")).toHaveText("1 open request");
  const row = page.locator("#requests-list .requests-row");
  await expect(row).toHaveCount(1);
  const requester = row.locator(".requests-requester");
  await expect(requester).toHaveText(
    `${ownerId!.slice(0, 8)}…${ownerId!.slice(-8)}`,
  );
  await expect(requester).toHaveAttribute("title", ownerId!);
  await expect(row.locator(".requests-cell")).toHaveText("cell 01");
  await expect(row.locator(".requests-note")).toHaveText("Offline queue check");
  await expect(row.locator(".requests-time")).toHaveAttribute(
    "title",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );

  // The switch reflects the stored state and writes through the transport.
  const accepting = page.locator("#requests-accepting");
  await expect(accepting).toBeChecked();
  await accepting.uncheck();
  await expect(page.locator("#requests-accepting-state")).toHaveText(
    "Not accepting join requests.",
  );
  await accepting.check();
  await expect(page.locator("#requests-accepting-state")).toHaveText(
    "Accepting join requests.",
  );

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  // Dismiss the only row and land on the empty queue.
  await row.locator(".requests-dismiss").click();
  await expect(page.locator("#requests-list .requests-row")).toHaveCount(0);
  await expect(page.locator("#requests-empty")).toBeVisible();
  await expect(page.locator("#requests-empty")).toContainText(
    "No open requests yet",
  );
  await expect(page.locator("#requests-count")).toHaveText("No open requests");

  // Copy the join link, or accept the manual field when the clipboard is
  // unavailable in this browser context.
  await page.locator("#requests-copy-link").click();
  await expect
    .poll(async () => {
      const status = (await page.locator("#requests-copy-status").textContent())?.trim();
      if (status === "Copied.") return "copied";
      if (await page.locator("#requests-link-field").isVisible()) return "manual";
      return "pending";
    })
    .not.toBe("pending");

  if (await page.locator("#requests-link-field").isVisible()) {
    const link = new URL(
      await page.locator("#requests-link-input").inputValue(),
    );
    expect(link.searchParams.get("root")).toBe(ownerId);
    expect([...link.searchParams.keys()]).toEqual(["root"]);
  } else {
    await expect(page.locator("#requests-copy-status")).toHaveText("Copied.");
  }

  await page.locator("#requests-done").click();
  await expect(page.locator("#requests-dialog")).toBeHidden();
  await expect(page.locator("#requests-open")).toBeFocused();
  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});


test("interviews a requester in the candidate room and ends the round", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await openAdvanced(page);

  await expect(page.locator("#identity-short")).toHaveAttribute(
    "title",
    /^[0-9a-f]{64}$/,
  );
  const ownerId = await page.locator("#identity-short").getAttribute("title");
  expect(ownerId).toMatch(/^[0-9a-f]{64}$/);

  // Use the real join flow to put one request into the own zone's queue.
  await page.locator("#join-open").click();
  await expect(page.locator("#join-dialog")).toBeVisible();
  await page.locator("#join-root-input").fill(ownerId!);
  await page.locator("#join-root-continue").click();
  await expect(page.locator("#join-place-title")).toBeVisible();
  await page.locator("#join-lat").fill("10");
  await page.locator("#join-lng").fill("10");
  await page.locator("#join-point").click();
  await expect(page.locator("#join-result")).toBeVisible();
  await page.locator("#join-note").fill("Offline interview check");
  await page.locator("#join-submit").click();
  await expect(page.locator("#join-request-success")).toBeVisible();
  await page.locator("#join-close").click();
  await expect(page.locator("#join-dialog")).toBeHidden();

  await page.locator("#requests-open").click();
  await expect(page.locator("#requests-dialog")).toBeVisible();
  await expect(page.locator("#requests-title")).toBeFocused();

  const row = page.locator("#requests-list .requests-row");
  await expect(row).toHaveCount(1);
  const interviewButton = row.locator(".requests-interview");
  await expect(interviewButton).toBeEnabled();
  await interviewButton.click();

  await expect(page.locator("#interview-section")).toBeVisible();
  await expect(page.locator("#interview-title")).toBeFocused();
  await expect(page.locator("#interview-state")).toHaveText("Interviewing");
  await expect(page.locator("#interview-candidate")).toHaveText(
    `${ownerId!.slice(0, 8)}…${ownerId!.slice(-8)}`,
  );
  await expect(page.locator("#interview-candidate")).toHaveAttribute(
    "title",
    ownerId!,
  );
  await expect(page.locator("#interview-empty")).toBeVisible();
  await expect(page.locator("#interview-empty")).toContainText(
    "No messages yet. Say hello.",
  );
  await expect(page.locator("#requests-count")).toHaveText("No open requests");
  await expect(page.locator("#requests-list .requests-row")).toHaveCount(0);

  // The offline candidate transport is plaintext: expect the Unencrypted badge.
  await page.locator("#interview-message-input").fill("Hello from the interview");
  await page.locator("#interview-send").click();
  const sent = page.locator("#interview-messages .room-message");
  await expect(sent).toHaveCount(1);
  await expect(sent.locator(".room-message-body")).toHaveText(
    "Hello from the interview",
  );
  await expect(
    sent.locator(".room-message-encryption"),
  ).toHaveText("Unencrypted");
  await expect(page.locator("#interview-empty")).toBeHidden();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  // Ending is confirmed, removes the candidate, and returns to the empty queue.
  await page.locator("#interview-end").click();
  await expect(page.locator("#interview-end-confirm")).toBeVisible();
  await expect(page.locator("#interview-end-confirm-button")).toBeFocused();
  await page.locator("#interview-end-confirm-button").click();
  await expect(page.locator("#interview-section")).toBeHidden();
  await expect(page.locator("#requests-empty")).toBeVisible();
  await expect(page.locator("#requests-empty")).toContainText(
    "No open requests yet",
  );
  await expect(page.locator("#requests-count")).toHaveText("No open requests");
  await expect(page.locator("#interview-messages .room-message")).toHaveCount(0);

  const afterAccessibility = await new AxeBuilder({ page }).analyze();
  expect(
    afterAccessibility.violations,
    `axe violations:\n${JSON.stringify(afterAccessibility.violations, null, 2)}`,
  ).toEqual([]);
  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("admits a requester through the slot editor and finishes admission", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await openAdvanced(page);

  await expect(page.locator("#identity-short")).toHaveAttribute(
    "title",
    /^[0-9a-f]{64}$/,
  );
  const ownerId = await page.locator("#identity-short").getAttribute("title");
  expect(ownerId).toMatch(/^[0-9a-f]{64}$/);

  // The offline harness can only request its own zone, so the requester is the
  // owner id; the slot prefill and the admission summary use that id.
  await page.locator("#join-open").click();
  await expect(page.locator("#join-dialog")).toBeVisible();
  await page.locator("#join-root-input").fill(ownerId!);
  await page.locator("#join-root-continue").click();
  await expect(page.locator("#join-place-title")).toBeVisible();
  await page.locator("#join-lat").fill("10");
  await page.locator("#join-lng").fill("10");
  await page.locator("#join-point").click();
  await expect(page.locator("#join-result")).toBeVisible();
  await page.locator("#join-note").fill("Offline admission check");
  await page.locator("#join-submit").click();
  await expect(page.locator("#join-request-success")).toBeVisible();
  await page.locator("#join-close").click();
  await expect(page.locator("#join-dialog")).toBeHidden();

  await page.locator("#requests-open").click();
  await expect(page.locator("#requests-dialog")).toBeVisible();
  await page.locator("#requests-list .requests-row .requests-interview").click();
  await expect(page.locator("#interview-section")).toBeVisible();
  await expect(page.locator("#interview-state")).toHaveText("Interviewing");
  await expect(page.locator("#interview-admit")).toBeVisible();
  await expect(page.locator("#interview-admit")).toBeEnabled();
  await expect(page.locator("#interview-finish")).toBeHidden();

  // Admit opens the existing region designation flow; choose the lowest free
  // cell, then the slot editor opens prefilled with the candidate.
  await page.locator("#interview-admit").click();
  await expect(page.locator("#region-dialog")).toBeVisible();
  await expect(page.locator("#region-assign-panel")).toBeVisible();
  await expect(
    page.locator("#region-assign-cards .region-assign-card").first(),
  ).toBeVisible();
  for (let index = 0; index < 8; index += 1) {
    const input = page.locator(
      `#region-assign-cards .region-assign-card[data-slot="${index}"] input`,
    );
    if ((await input.count()) > 0 && (await input.isEnabled())) {
      await input.check();
      break;
    }
  }
  await expect(page.locator("#region-assign-choose")).toBeEnabled();
  await page.locator("#region-assign-choose").click();
  await expect(page.locator("#region-dialog")).toBeHidden();
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#contact-select")).toHaveValue(ownerId!);
  await expect(page.locator("#contact-select option:checked")).toHaveText(
    `Requester · ${ownerId!.slice(0, 8)}`,
  );
  await expect(page.locator("#contact-hint")).toBeHidden();

  await page.locator("#save-button").click();
  await expect(page.locator("#editor")).toBeHidden();

  // The refresh reads the zone again and notices the written designation.
  await page.locator("#interview-refresh").click();
  await expect(page.locator("#interview-admission")).toBeVisible();
  await expect(page.locator("#interview-admission-result")).toHaveText(
    "Slot 1 written",
  );
  await expect(page.locator("#interview-admission-result")).toBeFocused();
  await expect(page.locator("#interview-admission-region")).toHaveText(
    "Region 0",
  );
  await expect(page.locator("#interview-state")).toHaveText("Slot written");
  await expect(page.locator("#interview-admit")).toBeHidden();
  await expect(page.locator("#interview-finish")).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    `axe violations:\n${JSON.stringify(accessibility.violations, null, 2)}`,
  ).toEqual([]);

  // Finishing is confirmed and rotates the candidate room without the
  // candidate. The written slot intentionally stays in the owner's zone.
  await page.locator("#interview-finish").click();
  await expect(page.locator("#interview-finish-confirm")).toBeVisible();
  await expect(page.locator("#interview-finish-confirm-button")).toBeFocused();
  await page.locator("#interview-finish-confirm-button").click();
  await expect(page.locator("#interview-section")).toBeHidden();
  await expect(page.locator("#requests-count")).toHaveText("No open requests");
  await expect(page.locator("#requests-list .requests-row")).toHaveCount(0);
  await expect(page.locator("#requests-queue-title")).toBeFocused();

  // Reopening cannot resurrect the interview: the candidate room no longer
  // lists the candidate.
  await page.locator("#requests-done").click();
  await expect(page.locator("#requests-dialog")).toBeHidden();
  await page.locator("#requests-open").click();
  await expect(page.locator("#requests-dialog")).toBeVisible();
  await expect(page.locator("#interview-section")).toBeHidden();
  await expect(page.locator("#requests-count")).toHaveText("No open requests");
  await page.locator("#requests-done").click();

  // The one-sided slot is written with the requester as its contact, visible
  // in the advanced surface's unconfirmed list.
  const unconfirmed = page.locator("#unconfirmed-list .unconfirmed-row");
  await expect(unconfirmed).toHaveCount(1);
  await expect(unconfirmed.locator(".unconfirmed-name")).toHaveAttribute(
    "title",
    ownerId!,
  );

  const afterAccessibility = await new AxeBuilder({ page }).analyze();
  expect(
    afterAccessibility.violations,
    `axe violations:\n${JSON.stringify(afterAccessibility.violations, null, 2)}`,
  ).toEqual([]);
  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});
