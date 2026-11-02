/**
 * Address book dialog: list, add, and remove contacts.
 *
 * In v6 the address book is private delegate state, not signed board state.
 * Every change goes through a delegate command (`contacts.add`,
 * `contacts.remove`, `contacts.update`) that returns the resulting list, and
 * the backend repaints from its refreshed cache, so two tabs cannot clobber
 * each other with a whole-list write.
 *
 * When the dialog is opened from the slot editor, a successful add closes the
 * dialog and hands the new contact back so the editor can select it.
 */
import type { ContactRecord } from "./delegate";
import { LIMITS, MAX_CONTACTS } from "./state";
import { errorMessage, utf8Length } from "./util";

export interface ContactsDialogDeps {
  /** The delegate's private address book, label + userId + address. */
  getContacts(): ContactRecord[];
  /** How many slots/parent links store this user ID (for the remove warning). */
  getUsedContactCount(userId: string): number;
  /** Add one entry. The delegate assigns no address until the user sets one. */
  addContact(entry: {
    label: string;
    userId: string;
    address?: string | null;
  }): Promise<ContactRecord[]>;
  /**
   * Change a label and/or address. Callers omit a field they did not touch so
   * the delegate preserves the stored value.
   */
  updateContact(
    userId: string,
    patch: { label?: string; address?: string | null },
  ): Promise<ContactRecord[]>;
  removeContact(userId: string): Promise<ContactRecord[]>;
  announce(message: string): void;
  /** Called after an add made while the dialog was opened from the editor. */
  onAdded(contact: ContactRecord): void;
  /** The delegate caps the book at MAX_CONTACTS entries. */
  getMaxContacts?(): number;
  /** User ids reserved by board state, e.g. the owner's own id. */
  getReservedUserIds?(): string[];
}

/** The invite a receive-payment link carries. */
export interface ReceiveInvite {
  /** 64 lowercase hex characters (the sender's owner key). */
  userId: string;
  /** The sender's board name, when the link carried one. */
  name: string | null;
  /** A valid non-root octal address, or null when absent/invalid. */
  address: string | null;
}

export type ReceiveLinkParse =
  | { kind: "none" }
  | { kind: "incomplete" }
  | { kind: "link"; invite: ReceiveInvite };

export type ReceiveLinkResolution =
  | { kind: "none" }
  | { kind: "incomplete" }
  | { kind: "own" }
  | { kind: "existing"; contact: ContactRecord }
  | { kind: "invite"; invite: ReceiveInvite };

export interface ContactsDialog {
  open(options?: { selectOnAdd?: boolean }): void;
  /** Open prefilled from a receive link; nothing is saved until Add contact. */
  openInvite(invite: ReceiveInvite): void;
  /** Open with an existing contact highlighted, for an already-saved link. */
  openExisting(userId: string): void;
  /** Re-render the list and count from the current board state. */
  refresh(): void;
}

/** Bound on an octal address, matching the delegate and payment code. */
export const MAX_CONTACT_ADDRESS = 32;

/** The address shown in a row: the digits, `root`, or `not set`. */
export function contactAddressLabel(address: string | null | undefined): string {
  if (address === null || address === undefined) return "not set";
  return address === "" ? "root" : address;
}

/**
 * Validate the optional address field. An empty field means "no address yet";
 * otherwise the value must be `root` or 1–32 octal digits. A root address is a
 * real, payable address since a board at the top of a tree can receive from its
 * descendants, and it is stored as the empty string.
 */
export function contactAddressProblem(raw: string): string | null {
  if (raw === "") return null;
  const value = raw.trim();
  if (/^root$/i.test(value)) return null;
  if (!/^[0-7]+$/.test(value)) {
    return "Use digits 0–7 only (or root) for the octal address.";
  }
  if (value.length > MAX_CONTACT_ADDRESS) {
    return `Keep the address to ${MAX_CONTACT_ADDRESS} digits or fewer.`;
  }
  return null;
}

/**
 * Trim and normalise the address field; empty becomes null (no address yet),
 * while the literal `root` becomes the empty string (a real root address).
 */
export function contactAddressValue(raw: string): string | null {
  const address = raw.trim();
  if (address === "") return null;
  return /^root$/i.test(address) ? "" : address;
}

/** The line shown under the payment recipient picker. */
export function recipientAddressLine(address: string | null | undefined): string {
  if (address === null || address === undefined) {
    return "No address yet. Ask them for a receive link.";
  }
  return address === "" ? "Root of their tree" : `Address ${address}`;
}

/**
 * Build the smallest update patch for a row edit. Omitting an unchanged field
 * lets the delegate preserve it, so a rename never clears a stored address and
 * an address edit never drops the label.
 */
export function contactUpdatePatch(
  contact: ContactRecord,
  draft: { label: string; address: string },
): { label?: string; address?: string | null } {
  const patch: { label?: string; address?: string | null } = {};
  const label = draft.label.trim();
  if (label !== contact.label) patch.label = label;
  const address = contactAddressValue(draft.address);
  if (address !== contact.address) patch.address = address;
  return patch;
}

/**
 * Parse `?pay=<64 hex>&name=<label>&addr=<octal>` from a receive-payment link.
 * `pay` is required and must be a lowercase 64-hex key; a bad `addr` is ignored
 * rather than fatal. A link carrying only `name`/`addr` is incomplete.
 */
export function parseReceiveInvite(search: string): ReceiveLinkParse {
  const params = new URLSearchParams(search);
  const pay = params.get("pay");
  const name = params.get("name");
  const addr = params.get("addr");
  if (pay === null) {
    return name === null && addr === null
      ? { kind: "none" }
      : { kind: "incomplete" };
  }
  if (!/^[0-9a-f]{64}$/.test(pay)) return { kind: "incomplete" };

  const trimmedName = name?.trim() ?? "";
  // The empty value is the root address, which can receive from its subtree.
  const address = addr !== null && /^[0-7]{0,32}$/.test(addr) ? addr : null;
  return {
    kind: "link",
    invite: {
      userId: pay,
      name: trimmedName === "" ? null : trimmedName.slice(0, 64),
      address,
    },
  };
}

/** Classify a link against this owner and the current private address book. */
export function resolveReceiveInvite(
  search: string,
  ownUserId: string | null,
  contacts: ContactRecord[],
): ReceiveLinkResolution {
  const parsed = parseReceiveInvite(search);
  if (parsed.kind !== "link") return parsed;
  if (ownUserId !== null && parsed.invite.userId === ownUserId) {
    return { kind: "own" };
  }
  const existing = contacts.find(
    (contact) => contact.userId === parsed.invite.userId,
  );
  return existing === undefined
    ? { kind: "invite", invite: parsed.invite }
    : { kind: "existing", contact: existing };
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function shortUserId(userId: string): string {
  return userId.slice(0, 8);
}

function labelProblem(label: string): string | null {
  if (label === "") return "Enter a name for the contact.";
  if (utf8Length(label) > LIMITS.label) {
    return `Keep the name to ${LIMITS.label} characters or fewer.`;
  }
  return null;
}

function userIdProblem(userId: string): string | null {
  if (userId === "") return "Enter the contact's user ID.";
  if (!/^[0-9a-f]{64}$/.test(userId)) {
    return "A user ID is 64 letters and numbers (0–9 and a–f). Check it and try again.";
  }
  return null;
}

export function createContactsDialog(
  deps: ContactsDialogDeps,
): ContactsDialog {
  const dialog = byId<HTMLDialogElement>("contacts-dialog");
  const title = byId<HTMLHeadingElement>("contacts-title");
  const list = byId<HTMLUListElement>("contacts-list");
  const empty = byId<HTMLParagraphElement>("contacts-empty");
  const countLabel = byId<HTMLSpanElement>("contacts-dialog-count");
  const closeButton = byId<HTMLButtonElement>("contacts-close");
  const doneButton = byId<HTMLButtonElement>("contacts-done");

  const form = byId<HTMLFormElement>("contact-form");
  const labelInput = byId<HTMLInputElement>("contact-label-input");
  const labelWarning = byId<HTMLParagraphElement>("contact-label-warning");
  const userIdInput = byId<HTMLInputElement>("contact-userid-input");
  const userIdWarning = byId<HTMLParagraphElement>("contact-userid-warning");
  const addressInput = byId<HTMLInputElement>("contact-address-input");
  const addressWarning = byId<HTMLParagraphElement>("contact-address-warning");
  const addButton = byId<HTMLButtonElement>("contact-add-button");
  const formError = byId<HTMLParagraphElement>("contacts-error");
  const statusLine = byId<HTMLParagraphElement>("contacts-status");

  const inviteBox = byId<HTMLElement>("contacts-invite");
  const inviteTitle = byId<HTMLHeadingElement>("contacts-invite-title");
  const inviteAddress = byId<HTMLElement>("contacts-invite-address");
  const inviteKey = byId<HTMLElement>("contacts-invite-key");

  const confirmBox = byId<HTMLDivElement>("contacts-confirm");
  const confirmText = byId<HTMLParagraphElement>("contacts-confirm-text");
  const confirmCancel = byId<HTMLButtonElement>("contacts-confirm-cancel");
  const confirmRemove = byId<HTMLButtonElement>("contacts-confirm-remove");

  let writing = false;
  let selectOnAdd = false;
  let pendingRemove: ContactRecord | null = null;
  /** A row to emphasise when the link named a saved contact. */
  let highlightUserId: string | null = null;
  /** The row currently being renamed/edited inline. */
  let editingUserId: string | null = null;

  function setWriting(value: boolean): void {
    writing = value;
    labelInput.disabled = value;
    userIdInput.disabled = value;
    addressInput.disabled = value;
    addButton.disabled = value;
    addButton.textContent = value ? "Saving…" : "Add contact";
    addButton.setAttribute("aria-busy", String(value));
    form.setAttribute("aria-busy", String(value));
    closeButton.disabled = value;
    doneButton.disabled = value;
    for (const button of list.querySelectorAll("button")) {
      button.disabled = value;
    }
    for (const field of list.querySelectorAll("input")) {
      field.disabled = value;
    }
    confirmRemove.disabled = value;
    confirmCancel.disabled = value;
  }

  function setError(message: string | null): void {
    if (message === null) {
      formError.hidden = true;
      formError.textContent = "";
      return;
    }
    formError.textContent = message;
    formError.hidden = false;
  }

  function setFieldWarning(
    input: HTMLInputElement,
    warning: HTMLParagraphElement,
    message: string | null,
  ): void {
    if (message === null) {
      warning.hidden = true;
      warning.textContent = "";
      input.removeAttribute("aria-invalid");
      return;
    }
    warning.textContent = message;
    warning.hidden = false;
    input.setAttribute("aria-invalid", "true");
  }

  function clearWarnings(): void {
    setFieldWarning(labelInput, labelWarning, null);
    setFieldWarning(userIdInput, userIdWarning, null);
    setFieldWarning(addressInput, addressWarning, null);
    setError(null);
  }

  function hideConfirm(): void {
    pendingRemove = null;
    confirmBox.hidden = true;
    confirmText.textContent = "";
  }

  function contactLimit(): number {
    const requested = deps.getMaxContacts?.();
    if (requested === undefined) return MAX_CONTACTS;
    return Math.min(MAX_CONTACTS, Math.max(0, Math.floor(requested)));
  }

  function focusRowButton(userId: string, className: string): void {
    const row = list.querySelector<HTMLElement>(
      `[data-user-id="${userId}"]`,
    );
    row?.querySelector<HTMLButtonElement>(`.${className}`)?.focus({
      preventScroll: true,
    });
  }

  function renderEditRow(contact: ContactRecord): HTMLLIElement {
    const row = document.createElement("li");
    row.className = "contact-row contact-row--editing";
    row.dataset.userId = contact.userId;

    const form = document.createElement("form");
    form.className = "contact-edit-form";
    form.noValidate = true;

    const fields = document.createElement("div");
    fields.className = "contact-edit-fields";

    const labelField = document.createElement("label");
    labelField.className = "field";
    const labelCaption = document.createElement("span");
    labelCaption.textContent = "Name";
    const labelFieldInput = document.createElement("input");
    labelFieldInput.type = "text";
    labelFieldInput.maxLength = 64;
    labelFieldInput.autocomplete = "off";
    labelFieldInput.spellcheck = false;
    labelFieldInput.value = contact.label;
    labelFieldInput.setAttribute("aria-label", `Name for ${contact.label}`);
    labelField.append(labelCaption, labelFieldInput);

    const addressField = document.createElement("label");
    addressField.className = "field";
    const addressCaption = document.createElement("span");
    addressCaption.textContent = "Octal address (optional)";
    const addressFieldInput = document.createElement("input");
    addressFieldInput.type = "text";
    addressFieldInput.inputMode = "numeric";
    addressFieldInput.autocomplete = "off";
    addressFieldInput.autocapitalize = "off";
    addressFieldInput.spellcheck = false;
    addressFieldInput.placeholder = "e.g. 03";
    addressFieldInput.value = contact.address ?? "";
    addressFieldInput.setAttribute(
      "aria-label",
      `Octal address for ${contact.label}`,
    );
    addressField.append(addressCaption, addressFieldInput);

    const warning = document.createElement("p");
    warning.className = "field-warning";
    warning.setAttribute("role", "status");
    warning.hidden = true;

    fields.append(labelField, addressField, warning);

    const actions = document.createElement("div");
    actions.className = "contact-actions contact-edit-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "button button--small button--quiet contact-edit-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      editingUserId = null;
      renderList();
      focusRowButton(contact.userId, "contact-edit");
    });
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "button button--small button--primary contact-edit-save";
    save.textContent = "Save";
    actions.append(cancel, save);

    form.append(fields, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveEdit(contact, labelFieldInput, addressFieldInput, warning);
    });

    row.append(form);
    return row;
  }

  async function saveEdit(
    contact: ContactRecord,
    labelFieldInput: HTMLInputElement,
    addressFieldInput: HTMLInputElement,
    warning: HTMLParagraphElement,
  ): Promise<void> {
    if (writing) return;
    const label = labelFieldInput.value.trim();
    const rawAddress = addressFieldInput.value.trim();
    const labelIssue = labelProblem(label);
    const addressIssue = contactAddressProblem(rawAddress);

    if (labelIssue !== null) {
      setFieldWarning(labelFieldInput, warning, labelIssue);
      labelFieldInput.focus();
      return;
    }
    setFieldWarning(labelFieldInput, warning, null);
    if (addressIssue !== null) {
      setFieldWarning(addressFieldInput, warning, addressIssue);
      addressFieldInput.focus();
      return;
    }
    setFieldWarning(addressFieldInput, warning, null);

    const duplicate = deps
      .getContacts()
      .some(
        (other) => other.userId !== contact.userId && other.label === label,
      );
    if (duplicate) {
      setFieldWarning(
        labelFieldInput,
        warning,
        "Another contact already uses this name.",
      );
      labelFieldInput.focus();
      return;
    }

    const patch = contactUpdatePatch(contact, {
      label,
      address: rawAddress,
    });
    if (patch.label === undefined && patch.address === undefined) {
      editingUserId = null;
      renderList();
      focusRowButton(contact.userId, "contact-edit");
      return;
    }

    editingUserId = null;
    await write(
      () => deps.updateContact(contact.userId, patch),
      `Updated ${label}.`,
      () => {
        renderList();
        focusRowButton(contact.userId, "contact-edit");
      },
    );
  }

  function renderList(): void {
    const contacts = deps.getContacts();

    const rows = contacts.map((contact) => {
      if (editingUserId === contact.userId) return renderEditRow(contact);

      const row = document.createElement("li");
      row.className = "contact-row";
      row.dataset.userId = contact.userId;
      if (highlightUserId === contact.userId) {
        row.classList.add("is-highlighted");
        row.tabIndex = -1;
        row.setAttribute("aria-current", "true");
      }

      const main = document.createElement("div");
      main.className = "contact-main";

      const label = document.createElement("span");
      label.className = "contact-label";
      label.textContent = contact.label;

      const id = document.createElement("code");
      id.className = "contact-id";
      id.textContent = shortUserId(contact.userId);
      id.title = contact.userId;
      const fullId = document.createElement("span");
      fullId.className = "sr-only";
      fullId.textContent = ` Full user ID ${contact.userId}.`;
      id.append(fullId);

      const address = document.createElement("span");
      address.className = "contact-address";
      address.dataset.address = contact.address ?? "";
      address.textContent = contactAddressLabel(contact.address);
      address.setAttribute(
        "aria-label",
        contact.address === null
          ? "No address"
          : `Address ${contact.address}`,
      );

      main.append(label, id, address);

      const used = deps.getUsedContactCount(contact.userId);
      if (used > 0) {
        const usage = document.createElement("span");
        usage.className = "contact-usage";
        usage.textContent = used === 1 ? "in use" : `in ${used} places`;
        main.append(usage);
      }

      const actions = document.createElement("div");
      actions.className = "contact-actions";

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "button button--small button--quiet contact-edit";
      edit.textContent = "Edit";
      edit.disabled = writing;
      edit.setAttribute("aria-label", `Edit ${contact.label}`);
      edit.addEventListener("click", () => {
        editingUserId = contact.userId;
        renderList();
        list
          .querySelector<HTMLInputElement>(
            `[data-user-id="${contact.userId}"] .contact-edit-fields input`,
          )
          ?.focus({ preventScroll: true });
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button button--small button--danger contacts-remove";
      remove.textContent = "Remove";
      remove.disabled = writing;
      remove.setAttribute("aria-label", `Remove ${contact.label}`);
      remove.addEventListener("click", () => requestRemove(contact));

      actions.append(edit, remove);
      row.append(main, actions);
      return row;
    });

    list.replaceChildren(...rows);
    empty.hidden = contacts.length > 0;
    countLabel.textContent = `${contacts.length} of ${contactLimit()}`;

    if (highlightUserId !== null) {
      list
        .querySelector<HTMLElement>(".contact-row.is-highlighted")
        ?.scrollIntoView({ block: "nearest" });
    }
  }

  function requestRemove(contact: ContactRecord): void {
    if (writing) return;
    const used = deps.getUsedContactCount(contact.userId);
    if (used === 0) {
      void removeContact(contact);
      return;
    }

    pendingRemove = contact;
    confirmText.textContent =
      used === 1
        ? `“${contact.label}” is linked from this zone. The signed slot keeps its saved name until you save the slot with another contact.`
        : `“${contact.label}” is linked from ${used} places on this zone. Each signed slot keeps its saved name until you save it with another contact.`;
    confirmBox.hidden = false;
    confirmBox.scrollIntoView({ block: "nearest" });
    confirmCancel.focus({ preventScroll: true });
  }

  async function write(
    action: () => Promise<ContactRecord[]>,
    message: string,
    onSuccess?: () => void,
  ): Promise<boolean> {
    if (writing) return false;
    setWriting(true);
    setError(null);
    let saved = false;
    try {
      await action();
      deps.announce(message);
      hideConfirm();
      saved = true;
    } catch (error) {
      setError(`Could not save the address book. ${errorMessage(error)}`);
    } finally {
      setWriting(false);
    }
    // Move focus only once the controls are interactive again; a focus call on
    // a disabled field (or a row that was just replaced) goes nowhere.
    if (saved) onSuccess?.();
    return saved;
  }

  async function removeContact(contact: ContactRecord): Promise<void> {
    const removed = await write(
      () => deps.removeContact(contact.userId),
      `Removed ${contact.label}.`,
      () => {
        if (dialog.open) labelInput.focus({ preventScroll: true });
      },
    );
    if (!removed && dialog.open) {
      // The row is still there; leave focus on it so the error is in context.
      focusRowButton(contact.userId, "contacts-remove");
    }
  }

  function submitAdd(event: SubmitEvent): void {
    event.preventDefault();
    if (writing) return;

    setError(null);
    const label = labelInput.value.trim();
    const userId = userIdInput.value.trim().toLowerCase();
    const rawAddress = addressInput.value.trim();
    const labelIssue = labelProblem(label);
    const userIdIssue = userIdProblem(userId);
    const addressIssue = contactAddressProblem(rawAddress);

    setFieldWarning(labelInput, labelWarning, labelIssue);
    setFieldWarning(userIdInput, userIdWarning, userIdIssue);
    setFieldWarning(addressInput, addressWarning, addressIssue);

    if (labelIssue) {
      labelInput.focus();
      return;
    }
    if (userIdIssue) {
      userIdInput.focus();
      return;
    }
    if (addressIssue) {
      addressInput.focus();
      return;
    }

    const contacts = deps.getContacts();
    const limit = contactLimit();
    if (contacts.length >= limit) {
      setError(
        `The address book holds up to ${limit} contacts. Remove one before adding another.`,
      );
      addButton.focus();
      return;
    }
    const reservedUserIds = deps.getReservedUserIds?.() ?? [];
    if (reservedUserIds.includes(userId)) {
      setFieldWarning(
        userIdInput,
        userIdWarning,
        "That is your own zone's key, so it cannot be a contact.",
      );
      userIdInput.focus();
      return;
    }
    if (contacts.some((contact) => contact.userId === userId)) {
      setFieldWarning(
        userIdInput,
        userIdWarning,
        "This user ID is already in the address book.",
      );
      userIdInput.focus();
      return;
    }
    if (contacts.some((contact) => contact.label === label)) {
      setFieldWarning(
        labelInput,
        labelWarning,
        "Another contact already uses this name.",
      );
      labelInput.focus();
      return;
    }

    const address = contactAddressValue(rawAddress);
    const contact: ContactRecord = { label, userId, address };
    void write(
      () => deps.addContact({ label, userId, address }),
      `Added ${label}.`,
      () => {
        labelInput.value = "";
        userIdInput.value = "";
        addressInput.value = "";
        inviteBox.hidden = true;
        clearWarnings();
        if (selectOnAdd) {
          selectOnAdd = false;
          dialog.close();
          deps.onAdded(contact);
        } else if (dialog.open) {
          renderList();
          labelInput.focus({ preventScroll: true });
        }
      },
    );
  }

  function setStatus(message: string): void {
    statusLine.textContent = message;
    statusLine.hidden = message === "";
  }

  function showInvite(next: ReceiveInvite): void {
    setStatus("");
    const suggested = next.name ?? shortUserId(next.userId);
    inviteTitle.textContent = `${suggested} shared their zone with you.`;
    inviteAddress.textContent = contactAddressLabel(next.address);
    inviteKey.textContent = next.userId;
    inviteBox.hidden = false;
    labelInput.value = suggested;
    userIdInput.value = next.userId;
    addressInput.value = next.address ?? "";
  }

  function reveal(): void {
    renderList();
    if (!dialog.open) dialog.showModal();
  }

  function open(options: { selectOnAdd?: boolean } = {}): void {
    selectOnAdd = options.selectOnAdd === true;
    inviteBox.hidden = true;
    highlightUserId = null;
    editingUserId = null;
    setStatus("");
    hideConfirm();
    clearWarnings();
    renderList();
    if (!dialog.open) dialog.showModal();
    title.focus({ preventScroll: true });
  }

  function openInvite(next: ReceiveInvite): void {
    selectOnAdd = false;
    highlightUserId = null;
    editingUserId = null;
    hideConfirm();
    clearWarnings();
    showInvite(next);
    renderList();
    reveal();
    title.focus({ preventScroll: true });
  }

  function openExisting(userId: string): void {
    selectOnAdd = false;
    inviteBox.hidden = true;
    editingUserId = null;
    hideConfirm();
    clearWarnings();
    highlightUserId = userId;
    setStatus("Already in your address book.");
    renderList();
    reveal();
    const row = list.querySelector<HTMLElement>(
      `[data-user-id="${userId}"]`,
    );
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  }

  function refresh(): void {
    renderList();
  }

  form.addEventListener("submit", submitAdd);

  labelInput.addEventListener("input", () => {
    setFieldWarning(labelInput, labelWarning, null);
    setError(null);
  });
  userIdInput.addEventListener("input", () => {
    setFieldWarning(userIdInput, userIdWarning, null);
    setError(null);
  });
  addressInput.addEventListener("input", () => {
    setFieldWarning(addressInput, addressWarning, null);
    setError(null);
  });

  confirmCancel.addEventListener("click", () => {
    const contact = pendingRemove;
    hideConfirm();
    // Return focus to the row the warning came from, when it still exists.
    if (contact) focusRowButton(contact.userId, "contacts-remove");
  });

  confirmRemove.addEventListener("click", () => {
    const contact = pendingRemove;
    hideConfirm();
    // The button that had focus is gone; park focus somewhere stable while the
    // write runs, then move it to the form on success.
    title.focus({ preventScroll: true });
    if (contact) void removeContact(contact);
  });

  closeButton.addEventListener("click", () => dialog.close());
  doneButton.addEventListener("click", () => dialog.close());

  dialog.addEventListener("cancel", (event) => {
    if (writing) event.preventDefault();
  });

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && !writing) dialog.close();
  });

  dialog.addEventListener("close", () => {
    // `close()` queues its event; a fast reopen (for example a receive link
    // resolved in the same tick) can make it arrive after `showModal()`.
    if (dialog.open) return;
    selectOnAdd = false;
    inviteBox.hidden = true;
    highlightUserId = null;
    editingUserId = null;
    setStatus("");
    hideConfirm();
    clearWarnings();
  });

  return { open, openInvite, openExisting, refresh };
}
