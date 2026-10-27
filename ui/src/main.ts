import "./styles.css";
import {
  OnlineBoard,
  entryFromInputs,
  type BoardBackend,
  type BoardCallbacks,
  type BoardStatus,
} from "./board";
import { createContactsDialog } from "./contacts-dialog";
import { DelegateError } from "./delegate";
import { createDelegateDialog } from "./delegate-dialog";
import { ContractBuildError } from "./freenet";
import { createIdentityDialogs } from "./identity-dialog";
import { OfflineBoard } from "./mock";
import {
  formatCents,
  parseCents,
  SLOT_COUNT,
  stateWarnings,
  validateEntry,
  type Contact,
  type Entry,
  type StateV2,
} from "./state";
import { errorMessage, shorten } from "./util";
import type { DelegateIdentity } from "./delegate";

const isOffline = __OFFLINE_MODE__;

const BOARD_CONFIG = {
  contractCodeHash: __CONTRACT_CODE_HASH__,
  contractWasmUrl: __CONTRACT_WASM_URL__,
  delegateWasmUrl: __DELEGATE_WASM_URL__,
  delegateKeyBytes: __DELEGATE_KEY_BYTES__,
  delegateCodeHashBytes: __DELEGATE_CODE_HASH_BYTES__,
  delegateParamsBytes: __WEBAPP_CONTRACT_ID_BYTES__,
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const statusPill = byId<HTMLSpanElement>("status-pill");
const statusText = byId<HTMLSpanElement>("status-text");
const statusDetail = byId<HTMLParagraphElement>("status-detail");
const identityShort = byId<HTMLElement>("identity-short");
const identityCopy = byId<HTMLButtonElement>("identity-copy");
const identityBackup = byId<HTMLButtonElement>("identity-backup");
const contractShort = byId<HTMLElement>("contract-short");
const contractCopy = byId<HTMLButtonElement>("contract-copy");
const contactsOpen = byId<HTMLButtonElement>("contacts-open");
const contactsCount = byId<HTMLElement>("contacts-count");
const reconnectButton = byId<HTMLButtonElement>("reconnect");

const notice = byId<HTMLDivElement>("notice");
const noticeTitle = byId<HTMLElement>("notice-title");
const noticeText = byId<HTMLParagraphElement>("notice-text");
const noticeAction = byId<HTMLButtonElement>("notice-action");
const noticeDismiss = byId<HTMLButtonElement>("notice-dismiss");

const warningsBox = byId<HTMLDivElement>("warnings");
const warningList = byId<HTMLUListElement>("warning-list");
const boardElement = byId<HTMLDivElement>("board");

const editor = byId<HTMLDialogElement>("editor");
const editorForm = byId<HTMLFormElement>("editor-form");
const editorSlot = byId<HTMLSpanElement>("editor-slot");
const editorTitle = byId<HTMLHeadingElement>("editor-title");
const editorSeq = byId<HTMLParagraphElement>("editor-seq");
const editorClose = byId<HTMLButtonElement>("editor-close");
const valueInput = byId<HTMLInputElement>("value-input");
const valueWarning = byId<HTMLParagraphElement>("value-warning");
const contactSelect = byId<HTMLSelectElement>("contact-select");
const contactAdd = byId<HTMLButtonElement>("contact-add");
const contactHint = byId<HTMLParagraphElement>("contact-hint");
const unitInput = byId<HTMLInputElement>("unit-input");
const noteInput = byId<HTMLTextAreaElement>("note-input");
const editorError = byId<HTMLParagraphElement>("editor-error");
const clearButton = byId<HTMLButtonElement>("clear-button");
const cancelButton = byId<HTMLButtonElement>("cancel-button");
const saveButton = byId<HTMLButtonElement>("save-button");
const srStatus = byId<HTMLParagraphElement>("sr-status");

interface SlotView {
  button: HTMLButtonElement;
  value: HTMLSpanElement;
  unit: HTMLSpanElement;
  label: HTMLSpanElement;
  note: HTMLSpanElement;
  seq: HTMLSpanElement;
  action: HTMLSpanElement;
}

const slotViews: SlotView[] = [];

let boardState: StateV2 | null = null;
let identity: DelegateIdentity | null = null;
let contractKeyFull: string | null = null;
let boardStatus: BoardStatus = "starting";
let busy = false;
let currentSlot = 0;
let noticeRetry: (() => void | Promise<void>) | null = null;

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function shortUserId(userId: string): string {
  return userId.slice(0, 8);
}

function findContact(userId: string): Contact | null {
  return (
    boardState?.contacts.entries.find((contact) => contact.userId === userId) ??
    null
  );
}

function buildSlots(): void {
  for (let index = 0; index < SLOT_COUNT; index++) {
    const button = createElement("button", "slot");
    button.type = "button";
    button.disabled = true;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-controls", "editor");
    button.addEventListener("click", () => openEditor(index));

    const top = createElement("span", "slot-top");
    const indexLabel = createElement(
      "span",
      "slot-index",
      String(index + 1).padStart(2, "0"),
    );
    const seq = createElement("span", "slot-seq", "seq 0");
    top.append(indexLabel, seq);

    const valueLine = createElement("span", "slot-value-line");
    const value = createElement("span", "slot-value", "—");
    const unit = createElement("span", "slot-unit");
    valueLine.append(value, unit);

    const label = createElement("span", "slot-label is-placeholder", "Waiting…");
    const note = createElement("span", "slot-note");
    note.hidden = true;
    const action = createElement("span", "sr-only", "Waiting for the board.");

    // Let the button's own visible content name it, with one hidden action hint.
    // This keeps voice-control labels and screen-reader output in sync.
    button.append(top, valueLine, label, note, action);
    boardElement.append(button);
    slotViews.push({ button, value, unit, label, note, seq, action });
  }
}

function renderBoard(): void {
  const loading =
    !boardState &&
    (boardStatus === "starting" ||
      boardStatus === "connecting" ||
      boardStatus === "identity");
  boardElement.classList.toggle("is-loading", loading);

  if (!boardState) {
    for (const view of slotViews) {
      view.button.disabled = true;
      view.value.textContent = "—";
      view.value.classList.remove("is-long", "is-xlong");
      view.unit.textContent = "";
      view.label.textContent = "Waiting…";
      view.label.classList.remove("is-unknown");
      view.label.title = "";
      view.note.hidden = true;
      view.seq.textContent = "seq 0";
      view.action.textContent = "Waiting for the board.";
    }
    return;
  }

  const state = boardState;
  const editable = boardStatus === "ready" || boardStatus === "offline";
  state.slots.forEach((slot, index) => {
    const view = slotViews[index];
    const entry = slot.entry;
    view.button.disabled = busy || !editable;
    view.button.className = "slot";
    if (entry) view.button.classList.add("is-filled");
    else if (slot.seq > 0) view.button.classList.add("is-tombstone");
    else view.button.classList.add("is-empty");

    const valueText = entry
      ? formatCents(entry.value)
      : slot.seq > 0
        ? "∅"
        : "+";
    view.value.textContent = valueText;
    view.value.classList.toggle(
      "is-long",
      Boolean(entry) && valueText.length > 9 && valueText.length <= 14,
    );
    view.value.classList.toggle("is-xlong", Boolean(entry) && valueText.length > 14);
    view.unit.textContent = entry?.unit ?? "";

    const contact = entry ? findContact(entry.contact) : null;
    view.label.textContent = entry
      ? contact
        ? contact.label
        : `Unknown · ${shortUserId(entry.contact)}`
      : slot.seq > 0
        ? "Cleared"
        : "Empty";
    view.label.classList.toggle("is-placeholder", !entry);
    view.label.classList.toggle("is-unknown", Boolean(entry) && !contact);
    // The full key survives a removed contact; keep it available on hover.
    view.label.title = entry && !contact ? entry.contact : "";

    view.note.textContent = entry?.note ?? "";
    view.note.hidden = !entry?.note;
    view.seq.textContent = `seq ${slot.seq}`;
    view.button.title = entry?.note ?? "";

    const canEdit = editable && !busy;
    view.action.textContent = canEdit
      ? entry
        ? "Edit slot."
        : slot.seq > 0
          ? "Edit or set a new value."
          : "Add a value."
      : "Read-only.";
  });
}

function renderWarnings(): void {
  if (!boardState) {
    warningsBox.hidden = true;
    warningList.replaceChildren();
    return;
  }

  const items = stateWarnings(boardState).map((message) => {
    const li = document.createElement("li");
    li.textContent = message;
    return li;
  });
  warningList.replaceChildren(...items);
  warningsBox.hidden = items.length === 0;
}

function renderIdentity(): void {
  identityBackup.hidden = isOffline || identity === null;
  identityBackup.disabled = identity === null;

  if (!identity) {
    identityShort.textContent = "Not available";
    identityCopy.disabled = true;
    identityCopy.removeAttribute("title");
    return;
  }
  const short = shorten(identity.pubkey);
  identityShort.textContent = short;
  identityShort.title = identity.pubkey;
  identityCopy.disabled = false;
  identityCopy.title = identity.pubkey;
  identityCopy.setAttribute("aria-label", `Copy owner public key ${short}`);
}

function renderContractKey(): void {
  if (!contractKeyFull) {
    contractShort.textContent = "Not derived";
    contractCopy.disabled = true;
    contractCopy.removeAttribute("title");
    return;
  }
  const short = shorten(contractKeyFull);
  contractShort.textContent = short;
  contractShort.title = contractKeyFull;
  contractCopy.disabled = false;
  contractCopy.title = contractKeyFull;
  contractCopy.setAttribute("aria-label", `Copy contract key ${short}`);
}

function renderContactCount(): void {
  const count = boardState?.contacts.entries.length ?? 0;
  contactsCount.textContent = String(count);
  contactsOpen.disabled = boardState === null;
  contactsOpen.setAttribute(
    "aria-label",
    `Address book, ${count} ${count === 1 ? "contact" : "contacts"}`,
  );
}

function renderControls(): void {
  const settling =
    boardStatus === "starting" ||
    boardStatus === "connecting" ||
    boardStatus === "identity";
  reconnectButton.hidden = isOffline;
  reconnectButton.disabled = isOffline || busy || settling;
}

const STATUS_LABELS: Record<BoardStatus, string> = {
  starting: "Starting…",
  connecting: "Connecting…",
  identity: "Identifying…",
  ready: "Connected",
  offline: "Offline mock",
  disconnected: "Disconnected",
  error: "Error",
};

const STATUS_DEFAULT_DETAIL: Record<BoardStatus, string> = {
  starting: "Preparing the board",
  connecting: "Opening the board",
  identity: "Waiting for the delegate",
  ready: "Live board",
  offline: "In-memory mock; changes reset on reload",
  disconnected: "Reconnect when ready",
  error: "See the message above",
};

function renderStatus(detail?: string): void {
  paintStatus(detail);
}

function paintStatus(detail?: string): void {
  statusText.textContent = STATUS_LABELS[boardStatus];
  statusPill.dataset.status = boardStatus;
  statusDetail.textContent =
    detail?.trim() || STATUS_DEFAULT_DETAIL[boardStatus];
  renderControls();
  renderBoard();
}

function setStatus(next: BoardStatus, detail?: string): void {
  const previous = boardStatus;
  boardStatus = next;

  if (
    (next === "starting" || next === "connecting" || next === "identity") &&
    noticeTitle.textContent === "Disconnected" &&
    noticeAction.hidden
  ) {
    hideNotice();
  }

  paintStatus(detail);

  if (next === "disconnected" && previous === "ready") {
    showNotice(
      "warning",
      "Disconnected",
      detail?.trim() ||
        "The connection to the Freenet node closed. Reconnect when ready.",
    );
  }
}

function showNotice(
  kind: "error" | "warning" | "info",
  title: string,
  text: string,
  retry: (() => void | Promise<void>) | null = null,
): void {
  noticeRetry = retry;
  notice.className = `notice notice--${kind}`;
  noticeTitle.textContent = title;
  noticeText.textContent = text;
  noticeAction.hidden = retry === null;
  notice.hidden = false;
}

function hideNotice(): void {
  notice.hidden = true;
  noticeRetry = null;
}

/** Clear a stale error after success, without swallowing a fresh warning. */
function hideErrorNotice(): void {
  if (!notice.hidden && notice.classList.contains("notice--error")) hideNotice();
}

function humanError(error: unknown): string {
  if (error instanceof DelegateError) {
    switch (error.code) {
      case "Missing":
      case "Config":
        return error.message;
      case "Timeout":
        return error.message;
      case "Unavailable":
        return error.message;
      case "Protocol":
        return error.message;
      case "Rejected":
        return error.message;
    }
  }
  return errorMessage(error);
}

function showFatal(error: unknown): void {
  let title = "Could not open the board";

  if (error instanceof ContractBuildError) {
    title =
      error.code === "ContractBuildMismatch"
        ? "Contract build mismatch"
        : "Contract build missing";
  } else if (error instanceof DelegateError) {
    if (error.code === "Missing") title = "Delegate not registered";
    else if (error.code === "Config") title = "Delegate build missing";
    else if (error.code === "Timeout") title = "Delegate did not respond";
    else if (error.code === "Unavailable") title = "Delegate unavailable";
    else if (error.code === "Protocol") title = "Delegate protocol error";
    else title = "Delegate rejected the request";
  }

  if (boardStatus !== "error") {
    setStatus("error", humanError(error));
  }

  showNotice(
    "error",
    title,
    humanError(error),
    isOffline ? null : () => reconnect(),
  );
}

function handleActionError(error: unknown): void {
  const message = humanError(error);
  editorError.textContent = message;
  editorError.hidden = false;
  announce(`Change not saved. ${message}`);

  if (
    error instanceof DelegateError &&
    (error.code === "Missing" || error.code === "Config")
  ) {
    showFatal(error);
  } else if (error instanceof ContractBuildError) {
    showFatal(error);
  } else {
    showNotice("error", "Change not saved", message);
  }
}

function announce(message: string): void {
  srStatus.textContent = "";
  window.setTimeout(() => {
    srStatus.textContent = message;
  }, 20);
}

function setEditorBusy(value: boolean): void {
  busy = value;
  valueInput.disabled = value;
  contactSelect.disabled = value;
  contactAdd.disabled = value;
  unitInput.disabled = value;
  noteInput.disabled = value;
  cancelButton.disabled = value;
  editorClose.disabled = value;
  clearButton.disabled =
    value || !boardState || boardState.slots[currentSlot].entry === null;
  saveButton.textContent = value ? "Saving…" : "Save";
  editorForm.setAttribute("aria-busy", String(value));
  saveButton.setAttribute("aria-busy", String(value));
  updateContactState();
  renderBoard();
  renderControls();

  // Saving closes the dialog while the grid is still disabled. Restore focus
  // once the slot can accept it again; native dialog focus return is too early.
  if (!value && !editor.open) {
    const slotButton = slotViews[currentSlot]?.button;
    if (slotButton && !slotButton.disabled) {
      slotButton.focus({ preventScroll: true });
    }
  }
}

function contactOption(contact: Contact): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = contact.userId;
  option.textContent = `${contact.label} · ${shortUserId(contact.userId)}`;
  option.title = contact.userId;
  return option;
}

function populateContactOptions(
  selectedUserId: string,
  extra?: Contact,
): void {
  const entries = boardState?.contacts.entries ?? [];
  const known = new Set<string>();
  const options: HTMLOptionElement[] = [];

  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Select a contact…";
  options.push(blank);

  const add = (contact: Contact): void => {
    if (known.has(contact.userId)) return;
    known.add(contact.userId);
    options.push(contactOption(contact));
  };

  for (const contact of entries) add(contact);
  if (extra) add(extra);

  // A slot keeps the key it was signed with. Show it even after the contact was
  // removed, and keep it unselectable for saving until a current one is picked.
  if (selectedUserId !== "" && !known.has(selectedUserId)) {
    const unknown = document.createElement("option");
    unknown.value = selectedUserId;
    unknown.textContent = `Unknown · ${shortUserId(selectedUserId)}`;
    unknown.dataset.unknown = "true";
    options.push(unknown);
  }

  contactSelect.replaceChildren(...options);
  contactSelect.value = selectedUserId;
  updateContactState();
}

function updateContactState(): void {
  const entries = boardState?.contacts.entries ?? [];
  const selected = contactSelect.value;
  const known =
    selected !== "" && entries.some((contact) => contact.userId === selected);

  let hint = "";
  if (entries.length === 0) {
    hint = "No contacts yet. Add one to save a slot.";
  } else if (selected === "") {
    hint = "Choose a contact before saving.";
  } else if (!known) {
    hint =
      "This slot's contact is no longer in the address book. Choose a contact to save changes.";
  }
  contactHint.textContent = hint;
  contactHint.hidden = hint === "";

  saveButton.disabled = busy || !known;
}

function openEditor(index: number): void {
  if (!boardState || busy) return;

  currentSlot = index;
  const slot = boardState.slots[index];
  const entry = slot.entry;

  editorSlot.textContent = String(index + 1).padStart(2, "0");
  editorTitle.textContent = `Slot ${index + 1}`;
  editorSeq.textContent =
    slot.seq === 0 ? "Never written" : `Signed at sequence ${slot.seq}`;
  valueInput.value = entry ? formatCents(entry.value) : "";
  unitInput.value = entry?.unit ?? "";
  noteInput.value = entry?.note ?? "";
  clearButton.disabled = entry === null;
  clearButton.textContent = entry === null ? "Clear slot" : "Clear slot";

  editorError.hidden = true;
  editorError.textContent = "";
  valueInput.removeAttribute("aria-invalid");
  populateContactOptions(entry?.contact ?? "");
  updateValueWarning();

  if (!editor.open) editor.showModal();
  valueInput.focus();
  valueInput.select();
}

function closeEditor(): void {
  if (editor.open) editor.close();
}

const VALUE_DESCRIBED_BY = "value-hint";

function setValueWarning(message: string | null, invalid = false): void {
  if (message === null) {
    valueWarning.hidden = true;
    valueWarning.textContent = "";
    valueInput.removeAttribute("aria-invalid");
    valueInput.setAttribute("aria-describedby", VALUE_DESCRIBED_BY);
    return;
  }

  valueWarning.textContent = message;
  valueWarning.hidden = false;
  valueInput.setAttribute(
    "aria-describedby",
    `${VALUE_DESCRIBED_BY} value-warning`,
  );
  if (invalid) valueInput.setAttribute("aria-invalid", "true");
  else valueInput.removeAttribute("aria-invalid");
}

function updateValueWarning(): void {
  const raw = valueInput.value.trim();
  if (raw === "") {
    setValueWarning(null);
    return;
  }

  // A lone sign or point is a half-typed number, not a mistake yet.
  if (/^[+-]?$/.test(raw) || /^[+-]?\.$/.test(raw)) {
    setValueWarning(null);
    return;
  }

  try {
    parseCents(raw);
    setValueWarning(null);
  } catch (error) {
    setValueWarning(errorMessage(error), true);
  }
}

function showEditorError(message: string, focus: HTMLElement | null): void {
  editorError.textContent = message;
  editorError.hidden = false;
  focus?.focus();
}

async function handleSave(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (busy || !boardState) return;

  const contact = contactSelect.value;
  if (contact === "") {
    showEditorError("Choose a contact before saving.", contactSelect);
    return;
  }

  let value: bigint;
  try {
    value = parseCents(valueInput.value);
  } catch (error) {
    valueInput.setAttribute("aria-invalid", "true");
    showEditorError(errorMessage(error), valueInput);
    return;
  }

  let entry: Entry;
  try {
    entry = entryFromInputs(
      value,
      contact,
      unitInput.value,
      noteInput.value,
    );
    validateEntry(entry);
  } catch (error) {
    showEditorError(errorMessage(error), null);
    return;
  }

  editorError.hidden = true;
  setEditorBusy(true);
  try {
    await backend.save(currentSlot, entry);
    const slotNumber = currentSlot + 1;
    closeEditor();
    hideErrorNotice();
    announce(`Slot ${slotNumber} saved.`);
  } catch (error) {
    handleActionError(error);
  } finally {
    setEditorBusy(false);
  }
}

async function handleClear(): Promise<void> {
  if (busy || !boardState) return;
  const slot = boardState.slots[currentSlot];
  if (slot.entry === null) return;

  editorError.hidden = true;
  setEditorBusy(true);
  try {
    await backend.clear(currentSlot);
    const slotNumber = currentSlot + 1;
    closeEditor();
    hideErrorNotice();
    announce(`Slot ${slotNumber} cleared.`);
  } catch (error) {
    handleActionError(error);
  } finally {
    setEditorBusy(false);
  }
}

async function copyToClipboard(
  text: string,
  label: string,
  button: HTMLButtonElement,
): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopy(text);
    }
    button.classList.add("is-copied");
    window.setTimeout(() => button.classList.remove("is-copied"), 1_300);
    announce(`${label} copied.`);
    return true;
  } catch (error) {
    showNotice(
      "warning",
      "Copy failed",
      `Clipboard access was blocked (${errorMessage(error)}). Select the key and copy it manually.`,
    );
    return false;
  }
}

function fallbackCopy(text: string): void {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("execCommand copy was refused");
}

async function reconnect(): Promise<void> {
  if (isOffline || busy) return;
  hideNotice();
  if (editor.open) closeEditor();
  try {
    await backend.retry();
  } catch (error) {
    showFatal(error);
  }
}

function startBoard(): void {
  void backend.start().catch((error: unknown) => {
    showFatal(error);
  });
}

const callbacks: BoardCallbacks = {
  onStatus: (status, detail) => setStatus(status, detail),
  onState: (state) => {
    boardState = state;
    renderBoard();
    renderWarnings();
    renderContactCount();
    contactsDialog.refresh();
    // A contacts write can land while the editor is open (the address book is
    // reachable from it). Keep the options honest without losing the selection.
    if (editor.open) populateContactOptions(contactSelect.value);
  },
  onIdentity: (next) => {
    identity = next;
    renderIdentity();
  },
  onContractKey: (key) => {
    contractKeyFull = key;
    renderContractKey();
  },
  onError: (error) => {
    showNotice("error", "Something went wrong", humanError(error));
    announce(`Error: ${humanError(error)}`);
  },
  onWarning: (message) => {
    showNotice("warning", "Notice", message);
  },
};

const backend: BoardBackend = isOffline
  ? new OfflineBoard(callbacks)
  : new OnlineBoard(BOARD_CONFIG, callbacks);

const contactsDialog = createContactsDialog({
  getContacts: () => boardState?.contacts.entries ?? [],
  getUsedContactCount: (userId) =>
    boardState
      ? boardState.slots.filter((slot) => slot.entry?.contact === userId).length
      : 0,
  saveContacts: (entries) => backend.saveContacts(entries),
  announce,
  onAdded: (contact) => {
    populateContactOptions(contact.userId, contact);
    editorError.hidden = true;
    editorError.textContent = "";
    updateContactState();
    contactSelect.focus({ preventScroll: true });
  },
});

const delegateDialog = createDelegateDialog({
  offline: isOffline,
  installDelegate: () => backend.installDelegate(),
  announce,
});

const identityDialogs = createIdentityDialogs({
  offline: isOffline,
  getIdentity: () => identity,
  exportIdentity: () => backend.exportIdentity(),
  importIdentity: (seed, nextSeq, contactsNextSeq) =>
    backend.importIdentity(seed, nextSeq, contactsNextSeq),
  announce,
  copy: copyToClipboard,
  onRestored: () => {
    showNotice(
      "info",
      "Identity restored",
      "This device now uses the restored owner key. The board is loading; " +
        "check that the Identity in the header matches your other device.",
    );
  },
  onCreate: () => {
    announce("Creating a new identity.");
  },
});

// Offline mode never asks for a delegate or an identity, and must never show
// either first-run dialog. Leaving the callbacks unset also keeps the board
// from waiting on one.
if (!isOffline) {
  callbacks.onDelegateRequired = () => delegateDialog.requestInstall();
  callbacks.onIdentityRequired = () => identityDialogs.requestIdentity();
}

buildSlots();
renderBoard();
renderWarnings();
renderIdentity();
renderContractKey();
renderContactCount();
renderStatus();
reconnectButton.hidden = isOffline;

editorClose.addEventListener("click", closeEditor);
cancelButton.addEventListener("click", closeEditor);
clearButton.addEventListener("click", () => {
  void handleClear();
});
editorForm.addEventListener("submit", (event) => {
  void handleSave(event);
});
valueInput.addEventListener("input", updateValueWarning);
contactSelect.addEventListener("change", updateContactState);
contactAdd.addEventListener("click", () => {
  contactsDialog.open({ selectOnAdd: true });
});
contactsOpen.addEventListener("click", () => {
  contactsDialog.open();
});

editor.addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
editor.addEventListener("click", (event) => {
  if (event.target === editor && !busy) closeEditor();
});

identityCopy.addEventListener("click", () => {
  if (identity) void copyToClipboard(identity.pubkey, "Owner public key", identityCopy);
});
identityBackup.addEventListener("click", () => {
  identityDialogs.openManagement();
});
contractCopy.addEventListener("click", () => {
  if (contractKeyFull) {
    void copyToClipboard(contractKeyFull, "Contract key", contractCopy);
  }
});

reconnectButton.addEventListener("click", () => {
  void reconnect();
});

noticeDismiss.addEventListener("click", hideNotice);
noticeAction.addEventListener("click", () => {
  const retry = noticeRetry;
  if (retry) void retry();
});

startBoard();
