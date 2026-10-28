/**
 * Parent-link dialog for the own board.
 *
 * A parent is picked from the own address book (or added there), and the save
 * runs a best-effort loop check first: follow the proposed parent's signed
 * `parent.userId` chain (mutual edges are irrelevant here), and block only when
 * this board appears in it. A read failure warns but allows the save, because a
 * missing remote board cannot contain this one as an ancestor.
 */
import type { BoardSnapshot } from "./board";
import type { Contact } from "./state";
import { MAX_TREE_DEPTH, walkParentChain } from "./tree-view";
import { errorMessage } from "./util";

export interface ParentDialogDeps {
  getContacts(): Contact[];
  getOwnOwnerId(): string | null;
  getParent(): string | null;
  readBoard(ownerId: string): Promise<BoardSnapshot | null>;
  saveParent(userId: string | null): Promise<void>;
  /** Open the address book in its "pick the new contact" mode. */
  openContacts(): void;
  announce(message: string): void;
  /** Runs after a successful save; the caller reports the new link status. */
  onSaved(): void | Promise<void>;
}

export interface ParentDialog {
  open(): void;
  /** Select a contact just added from the address book. */
  selectContact(userId: string): void;
  /** Re-render options from the current address book. */
  refresh(): void;
  close(): void;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function shortUserId(userId: string): string {
  return userId.slice(0, 8);
}

interface ChainCheck {
  block: string | null;
  warn: string | null;
}

export function createParentDialog(deps: ParentDialogDeps): ParentDialog {
  const dialog = byId<HTMLDialogElement>("parent-dialog");
  const form = byId<HTMLFormElement>("parent-form");
  const title = byId<HTMLHeadingElement>("parent-dialog-title");
  const closeButton = byId<HTMLButtonElement>("parent-close");
  const select = byId<HTMLSelectElement>("parent-select");
  const addContact = byId<HTMLButtonElement>("parent-add-contact");
  const hint = byId<HTMLParagraphElement>("parent-hint");
  const warning = byId<HTMLParagraphElement>("parent-warning");
  const error = byId<HTMLParagraphElement>("parent-error");
  const saveButton = byId<HTMLButtonElement>("parent-save");
  const cancelButton = byId<HTMLButtonElement>("parent-cancel");

  let writing = false;
  let checking = false;
  let warningAcknowledged = false;

  function setError(message: string | null): void {
    error.textContent = message ?? "";
    error.hidden = message === null;
    if (message !== null) select.setAttribute("aria-invalid", "true");
    else select.removeAttribute("aria-invalid");
  }

  function setWarning(message: string | null): void {
    warning.textContent = message ?? "";
    warning.hidden = message === null;
  }

  function setBusy(): void {
    const busy = writing || checking;
    select.disabled = busy;
    addContact.disabled = busy;
    closeButton.disabled = busy;
    cancelButton.disabled = busy;
    saveButton.disabled = busy || saveWouldDoNothing();
    saveButton.textContent = writing
      ? "Saving…"
      : checking
        ? "Checking…"
        : "Save parent";
    saveButton.setAttribute("aria-busy", String(busy));
    form.setAttribute("aria-busy", String(busy));
  }

  function contactsForParent(): Contact[] {
    const ownId = deps.getOwnOwnerId();
    return deps.getContacts().filter((contact) => contact.userId !== ownId);
  }

  function selectedId(): string | null {
    return select.value === "" ? null : select.value;
  }

  function saveWouldDoNothing(): boolean {
    return selectedId() === deps.getParent();
  }

  function updateHint(): void {
    const contacts = contactsForParent();
    const selected = selectedId();
    let message = "";

    if (contacts.length === 0) {
      message =
        "No contacts yet. Add a contact for the parent board, then choose it here.";
    } else if (selected === null) {
      message =
        "Root boards sit at the top of the tree. Choose a contact to give this board a parent.";
    } else {
      const known = contacts.some((contact) => contact.userId === selected);
      if (!known) {
        message =
          "This parent is no longer in the address book. Choose a contact, or add one first.";
      }
    }

    hint.textContent = message;
    hint.hidden = message === "";
  }

  function renderOptions(preferred?: string | null): void {
    const current = deps.getParent();
    const desired = preferred !== undefined ? preferred : current;
    const contacts = contactsForParent();
    const known = new Set<string>();
    const options: HTMLOptionElement[] = [];

    const root = document.createElement("option");
    root.value = "";
    root.textContent = "No parent (root)";
    options.push(root);

    for (const contact of contacts) {
      if (known.has(contact.userId)) continue;
      known.add(contact.userId);
      const option = document.createElement("option");
      option.value = contact.userId;
      option.textContent = `${contact.label} · ${shortUserId(contact.userId)}`;
      option.title = contact.userId;
      options.push(option);
    }

    // A signed parent stays visible after its contact is removed, but saving it
    // again needs a current contact.
    if (desired !== null && desired !== "" && !known.has(desired)) {
      const unknown = document.createElement("option");
      unknown.value = desired;
      unknown.textContent = `Unknown · ${shortUserId(desired)}`;
      unknown.dataset.unknown = "true";
      options.push(unknown);
    }

    select.replaceChildren(...options);
    select.value = desired === null ? "" : desired;
    setBusy();
    updateHint();
  }

  function fill(): void {
    const current = deps.getParent();
    warningAcknowledged = false;
    title.textContent = current === null ? "Set a parent" : "Change the parent";
    setError(null);
    setWarning(null);
    renderOptions(current);
  }

  async function checkChain(parentId: string, ownId: string): Promise<ChainCheck> {
    // Signed parent.userId pointers only. A pending (one-sided) parent still
    // takes part in a cycle, so mutual status is deliberately not consulted.
    const walk = await walkParentChain(parentId, ownId, deps);

    if (walk.hitOwnerId !== null) {
      return {
        block:
          "That parent already sits below this board, so the two would point at each other in a loop. Choose another board.",
        warn: null,
      };
    }
    if (walk.loop) {
      return {
        block: null,
        warn:
          "The parent's own chain already contains a loop. Saving adds this board to it; you can still save.",
      };
    }
    if (walk.truncated) {
      return {
        block: null,
        warn: `The parent's chain is deeper than ${MAX_TREE_DEPTH} boards, so a loop could not be ruled out. You can still save.`,
      };
    }
    if (walk.error !== null) {
      return {
        block: null,
        warn: `Could not check the parent's board for a loop (${walk.error}). You can still save.`,
      };
    }
    return { block: null, warn: null };
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (writing || checking) return;

    const ownId = deps.getOwnOwnerId();
    const parentId = selectedId();

    setError(null);
    setWarning(null);

    if (parentId !== null) {
      if (ownId === null) {
        setError("Your board is not loaded yet. Try again in a moment.");
        return;
      }
      if (parentId === ownId) {
        setError("A board cannot be its own parent.");
        select.focus();
        return;
      }
      if (!contactsForParent().some((contact) => contact.userId === parentId)) {
        setError(
          "Choose a contact from your address book, or add the parent as a contact first.",
        );
        select.focus();
        return;
      }
    }

    if (parentId === deps.getParent()) {
      dialog.close();
      return;
    }

    if (parentId !== null && ownId !== null) {
      checking = true;
      setBusy();
      const result = await checkChain(parentId, ownId);
      checking = false;
      setBusy();
      if (result.warn !== null) {
        setWarning(result.warn);
        if (!warningAcknowledged) {
          warningAcknowledged = true;
          deps.announce("Check the warning, then save again to continue.");
          saveButton.focus({ preventScroll: true });
          return;
        }
      }
      if (result.block !== null) {
        setError(result.block);
        deps.announce("Parent not saved. That link would make a loop.");
        select.focus();
        return;
      }
    }

    writing = true;
    setBusy();
    try {
      await deps.saveParent(parentId);
      dialog.close();
      // The caller announces the resulting Linked/Pending state.
      void deps.onSaved();
    } catch (saveError) {
      setError(`Could not save the parent. ${errorMessage(saveError)}`);
      deps.announce("Parent not saved.");
    } finally {
      writing = false;
      setBusy();
    }
  }

  function open(): void {
    fill();
    if (!dialog.open) dialog.showModal();
    title.focus({ preventScroll: true });
    select.focus({ preventScroll: true });
  }

  function selectContact(userId: string): void {
    warningAcknowledged = false;
    setError(null);
    setWarning(null);
    renderOptions(userId);
    select.focus({ preventScroll: true });
  }

  function refresh(): void {
    if (!dialog.open || writing || checking) return;
    renderOptions(select.value === "" ? null : select.value);
  }

  function close(): void {
    if (dialog.open && !writing && !checking) dialog.close();
  }

  select.addEventListener("change", () => {
    warningAcknowledged = false;
    setError(null);
    setWarning(null);
    setBusy();
    updateHint();
  });

  addContact.addEventListener("click", () => {
    if (!writing && !checking) deps.openContacts();
  });

  form.addEventListener("submit", (event) => {
    void submit(event);
  });

  closeButton.addEventListener("click", close);
  cancelButton.addEventListener("click", close);

  dialog.addEventListener("cancel", (event) => {
    if (writing || checking) event.preventDefault();
  });

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && !writing && !checking) dialog.close();
  });

  dialog.addEventListener("close", () => {
    setError(null);
    setWarning(null);
  });

  return { open, selectContact, refresh, close };
}
