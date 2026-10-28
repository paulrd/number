/**
 * Address book dialog: list, add, and remove contacts.
 *
 * The address book is signed board state, not local settings. Every change goes
 * through `saveContacts`, and the list is re-rendered from the state callback,
 * so two devices editing the same book still converge.
 *
 * When the dialog is opened from the slot editor, a successful add closes the
 * dialog and hands the new contact back so the editor can select it.
 */
import { LIMITS, MAX_CONTACTS, type Contact } from "./state";
import { errorMessage, utf8Length } from "./util";

export interface ContactsDialogDeps {
  getContacts(): Contact[];
  /** How many slots/parent links store this user ID (for the remove warning). */
  getUsedContactCount(userId: string): number;
  saveContacts(entries: Contact[]): Promise<void>;
  announce(message: string): void;
  /** Called after an add made while the dialog was opened from the editor. */
  onAdded(contact: Contact): void;
  /** The self-entry counts toward the contract limit but is not listed here. */
  getMaxContacts?(): number;
  /** Labels reserved by board state, e.g. the board's own name. */
  getReservedLabels?(): string[];
  /** User ids reserved by board state, e.g. the owner's own id. */
  getReservedUserIds?(): string[];
}

export interface ContactsDialog {
  open(options?: { selectOnAdd?: boolean }): void;
  /** Re-render the list and count from the current board state. */
  refresh(): void;
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
  const addButton = byId<HTMLButtonElement>("contact-add-button");
  const formError = byId<HTMLParagraphElement>("contacts-error");

  const confirmBox = byId<HTMLDivElement>("contacts-confirm");
  const confirmText = byId<HTMLParagraphElement>("contacts-confirm-text");
  const confirmCancel = byId<HTMLButtonElement>("contacts-confirm-cancel");
  const confirmRemove = byId<HTMLButtonElement>("contacts-confirm-remove");

  let writing = false;
  let selectOnAdd = false;
  let pendingRemove: Contact | null = null;

  function setWriting(value: boolean): void {
    writing = value;
    labelInput.disabled = value;
    userIdInput.disabled = value;
    addButton.disabled = value;
    addButton.textContent = value ? "Saving…" : "Add contact";
    addButton.setAttribute("aria-busy", String(value));
    form.setAttribute("aria-busy", String(value));
    closeButton.disabled = value;
    doneButton.disabled = value;
    for (const button of list.querySelectorAll("button")) {
      button.disabled = value;
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

  function renderList(): void {
    const contacts = deps.getContacts();

    const rows = contacts.map((contact) => {
      const row = document.createElement("li");
      row.className = "contact-row";
      row.dataset.userId = contact.userId;

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

      main.append(label, id);

      const used = deps.getUsedContactCount(contact.userId);
      if (used > 0) {
        const usage = document.createElement("span");
        usage.className = "contact-usage";
        usage.textContent = used === 1 ? "1 slot" : `${used} slots`;
        main.append(usage);
      }

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button button--small button--danger contacts-remove";
      remove.textContent = "Remove";
      remove.disabled = writing;
      remove.setAttribute("aria-label", `Remove ${contact.label}`);
      remove.addEventListener("click", () => requestRemove(contact));

      row.append(main, remove);
      return row;
    });

    list.replaceChildren(...rows);
    empty.hidden = contacts.length > 0;
    countLabel.textContent = `${contacts.length} of ${contactLimit()}`;
  }

  function requestRemove(contact: Contact): void {
    if (writing) return;
    const used = deps.getUsedContactCount(contact.userId);
    if (used === 0) {
      void removeContact(contact);
      return;
    }

    pendingRemove = contact;
    confirmText.textContent =
      used === 1
        ? `“${contact.label}” is linked from this board. That link will show an unknown contact until you choose a new one.`
        : `“${contact.label}” is linked from ${used} places on this board. Those links will show an unknown contact until you choose new ones.`;
    confirmBox.hidden = false;
    confirmBox.scrollIntoView({ block: "nearest" });
    confirmCancel.focus({ preventScroll: true });
  }

  async function write(
    entries: Contact[],
    message: string,
    onSuccess?: () => void,
  ): Promise<boolean> {
    if (writing) return false;
    setWriting(true);
    setError(null);
    let saved = false;
    try {
      await deps.saveContacts(entries);
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

  async function removeContact(contact: Contact): Promise<void> {
    const entries = deps
      .getContacts()
      .filter((entry) => entry.userId !== contact.userId);
    const removed = await write(entries, `Removed ${contact.label}.`, () => {
      if (dialog.open) labelInput.focus({ preventScroll: true });
    });
    if (!removed && dialog.open) {
      // The row is still there; leave focus on it so the error is in context.
      const row = list.querySelector<HTMLElement>(
        `[data-user-id="${contact.userId}"]`,
      );
      row?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    }
  }

  function submitAdd(event: SubmitEvent): void {
    event.preventDefault();
    if (writing) return;

    setError(null);
    const label = labelInput.value.trim();
    const userId = userIdInput.value.trim().toLowerCase();
    const labelIssue = labelProblem(label);
    const userIdIssue = userIdProblem(userId);

    setFieldWarning(labelInput, labelWarning, labelIssue);
    setFieldWarning(userIdInput, userIdWarning, userIdIssue);

    if (labelIssue) {
      labelInput.focus();
      return;
    }
    if (userIdIssue) {
      userIdInput.focus();
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
        "That is your own board's key. It is already saved as the board name.",
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
    const reservedLabels = deps.getReservedLabels?.() ?? [];
    if (reservedLabels.includes(label)) {
      setFieldWarning(
        labelInput,
        labelWarning,
        "This is your board's name. Choose a different name for the contact.",
      );
      labelInput.focus();
      return;
    }

    const contact: Contact = { label, userId };
    void write([...contacts, contact], `Added ${label}.`, () => {
      labelInput.value = "";
      userIdInput.value = "";
      clearWarnings();
      if (selectOnAdd) {
        selectOnAdd = false;
        dialog.close();
        deps.onAdded(contact);
      } else if (dialog.open) {
        labelInput.focus({ preventScroll: true });
      }
    });
  }

  function open(options: { selectOnAdd?: boolean } = {}): void {
    selectOnAdd = options.selectOnAdd === true;
    hideConfirm();
    clearWarnings();
    renderList();
    if (!dialog.open) dialog.showModal();
    title.focus({ preventScroll: true });
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

  confirmCancel.addEventListener("click", () => {
    const contact = pendingRemove;
    hideConfirm();
    // Return focus to the row the warning came from, when it still exists.
    const row = contact
      ? list.querySelector<HTMLElement>(`[data-user-id="${contact.userId}"]`)
      : null;
    row?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
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
    selectOnAdd = false;
    hideConfirm();
    clearWarnings();
  });

  return { open, refresh };
}
