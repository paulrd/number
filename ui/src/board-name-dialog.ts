/**
 * Board name dialog, in two modes:
 *
 * - required: the own board has no self-entry yet. The dialog is modal, has no
 *   cancel path, and cannot be dismissed with Escape or the backdrop until a
 *   name has been saved.
 * - edit: opened from the Board name row; cancel/backdrop/Escape close it.
 *
 * A name is stored as the owner's own contact entry in the signed address book
 * (`{ label: name, userId: ownOwnerId }`), so it replicates from the same
 * record as the rest of the address book and needs no new key.
 */
import { LIMITS, type Contact } from "./state";
import { errorMessage, utf8Length } from "./util";

export interface BoardNameDialogDeps {
  /** Own contacts, excluding the self-entry. */
  getContacts(): Contact[];
  getOwnOwnerId(): string | null;
  getCurrentName(): string | null;
  saveName(name: string): Promise<void>;
  onSaved(name: string): void;
}

export interface BoardNameDialog {
  /** Open the blocking first-run prompt. */
  requireName(): void;
  /** Open the editable rename dialog. */
  openEdit(currentName: string): void;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const REQUIRED_TITLE = "Name your board";
const EDIT_TITLE = "Rename your board";
const REQUIRED_DESC =
  "This name is how other boards see yours in their path. It is stored in " +
  "your signed address book and can be changed later.";
const EDIT_DESC =
  "Change how other boards see yours in their path. The new name is stored in " +
  "your signed address book.";
const DESCRIPTION_IDS = "board-name-desc board-name-hint";

export function createBoardNameDialog(
  deps: BoardNameDialogDeps,
): BoardNameDialog {
  const dialog = byId<HTMLDialogElement>("board-name-dialog");
  const form = byId<HTMLFormElement>("board-name-form");
  const title = byId<HTMLHeadingElement>("board-name-title");
  const description = byId<HTMLParagraphElement>("board-name-desc");
  const closeButton = byId<HTMLButtonElement>("board-name-close");
  const input = byId<HTMLInputElement>("board-name-input");
  const warning = byId<HTMLParagraphElement>("board-name-warning");
  const error = byId<HTMLParagraphElement>("board-name-error");
  const cancelButton = byId<HTMLButtonElement>("board-name-cancel");
  const saveButton = byId<HTMLButtonElement>("board-name-save");

  let required = false;
  let settled = false;
  let writing = false;
  let initialName = "";

  function updateDescribedBy(): void {
    const ids = [DESCRIPTION_IDS];
    if (!warning.hidden) ids.push("board-name-warning");
    if (!error.hidden) ids.push("board-name-error");
    input.setAttribute("aria-describedby", ids.join(" "));
  }

  function setWarning(message: string | null): void {
    warning.textContent = message ?? "";
    warning.hidden = message === null;
    if (message === null) input.removeAttribute("aria-invalid");
    else input.setAttribute("aria-invalid", "true");
    updateDescribedBy();
  }

  function setError(message: string | null): void {
    error.textContent = message ?? "";
    error.hidden = message === null;
    updateDescribedBy();
  }

  function setWriting(value: boolean): void {
    writing = value;
    input.disabled = value;
    closeButton.disabled = value;
    cancelButton.disabled = value;
    saveButton.disabled = value;
    saveButton.textContent = value ? "Saving…" : "Save name";
    saveButton.setAttribute("aria-busy", String(value));
    form.setAttribute("aria-busy", String(value));
  }

  function setMode(isRequired: boolean): void {
    required = isRequired;
    dialog.classList.toggle("is-required", isRequired);
    title.textContent = isRequired ? REQUIRED_TITLE : EDIT_TITLE;
    description.textContent = isRequired ? REQUIRED_DESC : EDIT_DESC;
    closeButton.hidden = isRequired;
    cancelButton.hidden = isRequired;
  }

  function show(isRequired: boolean, currentName: string): void {
    if (dialog.open) return;
    settled = false;
    initialName = currentName;
    setMode(isRequired);
    setWarning(null);
    setError(null);
    setWriting(false);
    input.value = currentName;
    dialog.showModal();
    input.focus();
    input.select();
  }

  function requireName(): void {
    if (deps.getCurrentName() !== null) return;
    show(true, "");
  }

  function openEdit(currentName: string): void {
    show(false, currentName);
  }

  function nameProblem(name: string): string | null {
    if (name === "") return "Enter a name for this board.";
    if (utf8Length(name) > LIMITS.label) {
      return `Keep the name to ${LIMITS.label} characters or fewer.`;
    }
    if (deps.getContacts().some((contact) => contact.label === name)) {
      return "Another contact already uses this name. Choose a different one.";
    }
    return null;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (writing) return;

    const name = input.value.trim();
    const problem = nameProblem(name);
    if (problem !== null) {
      setWarning(problem);
      input.focus();
      return;
    }

    if (!required && name === initialName.trim()) {
      settled = true;
      dialog.close();
      return;
    }

    if (!deps.getOwnOwnerId()) {
      setError("Your board is not loaded yet. Try again in a moment.");
      return;
    }

    setWarning(null);
    setError(null);
    setWriting(true);
    try {
      await deps.saveName(name);
      settled = true;
      dialog.close();
      deps.onSaved(name);
    } catch (saveError) {
      setError(`Could not save the board name. ${errorMessage(saveError)}`);
      input.focus();
    } finally {
      setWriting(false);
    }
  }

  form.addEventListener("submit", (event) => {
    void submit(event);
  });

  input.addEventListener("input", () => {
    setWarning(null);
    setError(null);
  });

  closeButton.addEventListener("click", () => {
    if (!required && !writing) dialog.close();
  });

  cancelButton.addEventListener("click", () => {
    if (!required && !writing) dialog.close();
  });

  dialog.addEventListener("cancel", (event) => {
    if (required || writing) event.preventDefault();
  });

  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    if (required || writing) return;
    dialog.close();
  });

  dialog.addEventListener("close", () => {
    setWarning(null);
    setError(null);
    // A required prompt cannot be dismissed by anything except a save. If a
    // stray close slips through, reopen rather than leave the board unnamed.
    if (required && !settled) {
      window.setTimeout(() => {
        if (!settled && !dialog.open) {
          dialog.showModal();
          input.focus();
        }
      }, 0);
    }
  });

  return { requireName, openEdit };
}
