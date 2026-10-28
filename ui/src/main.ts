import "./styles.css";
import {
  OnlineBoard,
  entryFromInputs,
  type BoardBackend,
  type BoardCallbacks,
  type BoardSnapshot,
  type BoardStatus,
} from "./board";
import { createContactsDialog } from "./contacts-dialog";
import { DelegateError, type DelegateIdentity } from "./delegate";
import { createDelegateDialog } from "./delegate-dialog";
import { ContractBuildError, deriveInstanceId } from "./freenet";
import { createIdentityDialogs } from "./identity-dialog";
import { OfflineBoard } from "./mock";
import { createParentDialog, type ParentDialog } from "./parent-dialog";
import {
  formatCents,
  parseCents,
  SLOT_COUNT,
  stateWarnings,
  validateEntry,
  type Contact,
  type Entry,
  type StateV3,
} from "./state";
import {
  BoardCache,
  buildTrail,
  childLink,
  parentLink,
  type LinkState,
  type TrailStep,
} from "./tree-view";
import { errorMessage, hexToBytes, shorten } from "./util";

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
const boardMeta = byId<HTMLElement>("board-meta");
const boardMetaLabel = byId<HTMLElement>("board-meta-label");
const boardOwner = byId<HTMLElement>("board-owner");
const boardCopy = byId<HTMLButtonElement>("board-copy");
const boardHome = byId<HTMLButtonElement>("board-home");
const readOnlyBadge = byId<HTMLElement>("read-only-badge");
const legacyBadge = byId<HTMLElement>("legacy-badge");
const contractShort = byId<HTMLElement>("contract-short");
const contractCopy = byId<HTMLButtonElement>("contract-copy");
const parentName = byId<HTMLElement>("parent-name");
const parentStatus = byId<HTMLSpanElement>("parent-status");
const parentNote = byId<HTMLParagraphElement>("parent-note");
const parentOpen = byId<HTMLButtonElement>("parent-open");
const parentEdit = byId<HTMLButtonElement>("parent-edit");
const parentClear = byId<HTMLButtonElement>("parent-clear");
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
const breadcrumbs = byId<HTMLElement>("breadcrumbs");
const breadcrumbList = byId<HTMLOListElement>("breadcrumb-list");
const breadcrumbWarning = byId<HTMLParagraphElement>("breadcrumb-warning");
const boardTitle = byId<HTMLHeadingElement>("board-title");
const boardMode = byId<HTMLParagraphElement>("board-mode");
const boardElement = byId<HTMLDivElement>("board");
const boardHint = byId<HTMLParagraphElement>("board-hint");

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
const childLinkBox = byId<HTMLElement>("child-link");
const childLinkStatus = byId<HTMLSpanElement>("child-link-status");
const childLinkDetail = byId<HTMLParagraphElement>("child-link-detail");
const childOpen = byId<HTMLButtonElement>("child-open");
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

interface ViewedBoard {
  ownerId: string;
  state: StateV3;
  codeHash: string;
  legacy: boolean;
  isOwn: boolean;
}

const slotViews: SlotView[] = [];

/** The viewer's own board, kept live even while another board is on screen. */
let ownState: StateV3 | null = null;
let ownIdentity: DelegateIdentity | null = null;
/** The board currently on screen: own, or another owner's read-only board. */
let view: ViewedBoard | null = null;

let contractKeyFull: string | null = null;
let boardStatus: BoardStatus = "starting";
let busy = false;
let navigating = false;
let currentSlot = 0;
let currentChildId: string | null = null;
let childLinkOpenable = false;
let editorRequest = 0;
let parentStatusRequest = 0;
let trailRequest = 0;
let noticeRetry: (() => void | Promise<void>) | null = null;
/** True while the address book was opened from the parent dialog. */
let addingForParent = false;

const OWN_BOARD_HINT =
  "Select a slot to set its value, contact, unit, or note. Values show two " +
  "decimal places, and a blank value saves as 0.00. Slots keep the contact's " +
  "key, so renaming a label keeps the link. Every change is signed by the owner " +
  "key and merged by the contract. Clearing a slot records that it was cleared, " +
  "so an older copy cannot bring it back.";

const REMOTE_BOARD_HINT =
  "You are viewing another owner's board. It is read-only here, and only the " +
  "owner can change its values. Select a filled slot to open that child board, " +
  "or use Home to return to your own board.";

const LINK_LABELS: Record<LinkState, string> = {
  root: "Root",
  linked: "Linked",
  pending: "Pending",
  "not-created": "Not created yet",
  error: "Could not check",
};

const LINK_TITLES: Record<LinkState, string> = {
  root: "This board has no parent.",
  linked: "Both boards point at each other.",
  pending: "Only one side points at the other yet.",
  "not-created": "No board exists for this owner yet.",
  error: "This board could not be read.",
};

const LEGACY_BOARD_TITLE =
  "This board is on the previous version. Its owner must open the new app to set a parent.";
const LEGACY_PARENT_NOTE = "Parent board is on the previous version.";
const LEGACY_PARENT_TITLE =
  "The parent cannot set its own parent until its owner opens the new app, but this edge is still valid.";

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

function ownContacts(): Contact[] {
  return ownState?.contacts.entries ?? [];
}

/** Resolve a board owner to a contact label, preferring the given books. */
function labelForOwner(ownerId: string, ...sources: Contact[][]): string {
  if (ownIdentity && ownerId === ownIdentity.pubkey) return "Your board";
  for (const entries of sources) {
    const contact = entries.find((entry) => entry.userId === ownerId);
    if (contact) return contact.label;
  }
  return `Unknown · ${shortUserId(ownerId)}`;
}

function findContact(state: StateV3, userId: string): Contact | null {
  return state.contacts.entries.find((contact) => contact.userId === userId) ?? null;
}

function ownSnapshot(): BoardSnapshot | null {
  if (!ownState || !ownIdentity) return null;
  return {
    ownerId: ownIdentity.pubkey,
    state: ownState,
    codeHash: BOARD_CONFIG.contractCodeHash,
    legacy: false,
  };
}

function toView(snapshot: BoardSnapshot): ViewedBoard {
  return {
    ownerId: snapshot.ownerId,
    state: snapshot.state,
    codeHash: snapshot.codeHash,
    legacy: snapshot.legacy,
    isOwn: ownIdentity !== null && snapshot.ownerId === ownIdentity.pubkey,
  };
}

const boardCache = new BoardCache((ownerId) => backend.readBoard(ownerId));

/** Remote boards are cached; the own board always comes from live state. */
async function readBoardForView(ownerId: string): Promise<BoardSnapshot | null> {
  if (ownIdentity && ownerId === ownIdentity.pubkey) return ownSnapshot();
  return boardCache.get(ownerId);
}

const linkDeps = {
  readBoard: readBoardForView,
};

/** Contract key shown in the header: the viewed board's instance id. */
function currentContractKey(): string | null {
  if (!view) return null;
  if (view.isOwn) return contractKeyFull;
  try {
    return deriveInstanceId(view.codeHash, hexToBytes(view.ownerId)).base58;
  } catch {
    return null;
  }
}

function paintBadge(element: HTMLElement, state: LinkState): void {
  element.dataset.state = state;
  element.textContent = LINK_LABELS[state];
  element.title = LINK_TITLES[state];
  element.hidden = false;
}

function buildSlots(): void {
  for (let index = 0; index < SLOT_COUNT; index++) {
    const button = createElement("button", "slot");
    button.type = "button";
    button.disabled = true;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-controls", "editor");
    button.addEventListener("click", () => handleSlotClick(index));

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

function handleSlotClick(index: number): void {
  if (!view || busy || navigating) return;
  if (view.isOwn) {
    openEditor(index);
    return;
  }

  const entry = view.state.slots[index].entry;
  if (entry === null) {
    showNotice(
      "info",
      "Empty slot",
      "This slot is empty. The board belongs to another owner and is read-only.",
    );
    return;
  }
  void openBoard(entry.contact);
}

function renderBoard(): void {
  const current = view;
  const loading =
    current === null &&
    (boardStatus === "starting" ||
      boardStatus === "connecting" ||
      boardStatus === "identity");
  boardElement.classList.toggle("is-loading", loading);

  if (current === null) {
    for (const slotView of slotViews) {
      slotView.button.disabled = true;
      slotView.value.textContent = "—";
      slotView.value.classList.remove("is-long", "is-xlong");
      slotView.unit.textContent = "";
      slotView.label.textContent = "Waiting…";
      slotView.label.classList.remove("is-unknown");
      slotView.label.title = "";
      slotView.note.hidden = true;
      slotView.seq.textContent = "seq 0";
      slotView.action.textContent = "Waiting for the board.";
    }
    return;
  }

  const state = current.state;
  const ready = boardStatus === "ready" || boardStatus === "offline";
  const canEdit = current.isOwn && ready && !busy && !navigating;

  state.slots.forEach((slot, index) => {
    const slotView = slotViews[index];
    const entry = slot.entry;
    const canOpen = !current.isOwn && entry !== null && !navigating;

    slotView.button.disabled = !canEdit && !canOpen;
    slotView.button.className = "slot";
    if (entry) slotView.button.classList.add("is-filled");
    else if (slot.seq > 0) slotView.button.classList.add("is-tombstone");
    else slotView.button.classList.add("is-empty");

    if (current.isOwn) {
      slotView.button.setAttribute("aria-haspopup", "dialog");
      slotView.button.setAttribute("aria-controls", "editor");
    } else {
      slotView.button.removeAttribute("aria-haspopup");
      slotView.button.removeAttribute("aria-controls");
    }

    const valueText = entry
      ? formatCents(entry.value)
      : slot.seq > 0
        ? "∅"
        : "+";
    slotView.value.textContent = valueText;
    slotView.value.classList.toggle(
      "is-long",
      Boolean(entry) && valueText.length > 9 && valueText.length <= 14,
    );
    slotView.value.classList.toggle(
      "is-xlong",
      Boolean(entry) && valueText.length > 14,
    );
    slotView.unit.textContent = entry?.unit ?? "";

    const contact = entry ? findContact(state, entry.contact) : null;
    const isOwnContact =
      entry !== null && ownIdentity !== null && entry.contact === ownIdentity.pubkey;
    slotView.label.textContent = entry
      ? isOwnContact
        ? "Your board"
        : contact
          ? contact.label
          : `Unknown · ${shortUserId(entry.contact)}`
      : slot.seq > 0
        ? "Cleared"
        : "Empty";
    slotView.label.classList.toggle("is-placeholder", !entry);
    slotView.label.classList.toggle(
      "is-unknown",
      Boolean(entry) && !contact && !isOwnContact,
    );
    // The full key survives a removed contact; keep it available on hover.
    slotView.label.title = entry && !contact ? entry.contact : "";

    slotView.note.textContent = entry?.note ?? "";
    slotView.note.hidden = !entry?.note;
    slotView.seq.textContent = `seq ${slot.seq}`;
    slotView.button.title = entry?.note ?? "";

    slotView.action.textContent = canEdit
      ? entry
        ? "Edit slot."
        : slot.seq > 0
          ? "Edit or set a new value."
          : "Add a value."
      : canOpen
        ? "Open child board."
        : current.isOwn
          ? "Read-only."
          : "Read-only slot.";
  });
}

function renderWarnings(): void {
  if (!view) {
    warningsBox.hidden = true;
    warningList.replaceChildren();
    return;
  }

  const items = stateWarnings(view.state).map((message) => {
    const li = document.createElement("li");
    li.textContent = message;
    return li;
  });
  warningList.replaceChildren(...items);
  warningsBox.hidden = items.length === 0;
}

function renderIdentity(): void {
  identityBackup.hidden = isOffline || ownIdentity === null;
  identityBackup.disabled = ownIdentity === null;

  if (!ownIdentity) {
    identityShort.textContent = "Not available";
    identityCopy.disabled = true;
    identityCopy.removeAttribute("title");
    return;
  }
  const short = shorten(ownIdentity.pubkey);
  identityShort.textContent = short;
  identityShort.title = ownIdentity.pubkey;
  identityCopy.disabled = false;
  identityCopy.title = ownIdentity.pubkey;
  identityCopy.setAttribute("aria-label", `Copy owner public key ${short}`);
}

function renderContractKey(): void {
  const key = currentContractKey();
  if (!key) {
    contractShort.textContent = "Not derived";
    contractCopy.disabled = true;
    contractCopy.removeAttribute("title");
    return;
  }
  const short = shorten(key);
  contractShort.textContent = short;
  contractShort.title = key;
  contractCopy.disabled = false;
  contractCopy.title = key;
  contractCopy.setAttribute("aria-label", `Copy contract key ${short}`);
}

function renderBoardHeader(): void {
  const current = view;

  if (!current) {
    boardMeta.hidden = true;
    boardMetaLabel.textContent = "Board";
    boardOwner.textContent = "Loading…";
    boardOwner.removeAttribute("title");
    boardCopy.disabled = true;
    boardCopy.removeAttribute("title");
    boardHome.hidden = true;
    readOnlyBadge.hidden = true;
    legacyBadge.hidden = true;
    boardMode.textContent = "Signed · two decimals";
    boardHint.textContent = OWN_BOARD_HINT;
    return;
  }

  const remote = !current.isOwn;
  // On the own board the Identity row already names the board and its owner,
  // so the Board row only appears when a different owner is being viewed.
  boardMeta.hidden = !remote;
  boardMetaLabel.textContent = remote ? "Viewing" : "Board";

  const label = current.isOwn
    ? "Your board"
    : labelForOwner(
        current.ownerId,
        ownContacts(),
        current.state.contacts.entries,
      );
  boardOwner.textContent = current.isOwn
    ? label
    : `${label} · ${shortUserId(current.ownerId)}`;
  boardOwner.title = current.ownerId;
  boardCopy.disabled = false;
  boardCopy.title = current.ownerId;
  boardCopy.setAttribute(
    "aria-label",
    `Copy board owner ${boardOwner.textContent ?? label}`,
  );

  boardHome.hidden = current.isOwn;
  boardHome.disabled = busy || navigating;
  readOnlyBadge.hidden = current.isOwn;
  legacyBadge.hidden = !current.legacy;
  legacyBadge.title = LEGACY_BOARD_TITLE;
  boardMode.textContent = current.isOwn
    ? "Signed · two decimals"
    : `Read-only · ${shortUserId(current.ownerId)}`;
  boardHint.textContent = current.isOwn ? OWN_BOARD_HINT : REMOTE_BOARD_HINT;
}

function renderParentRow(): void {
  const request = ++parentStatusRequest;
  const current = view;

  if (!current) {
    parentName.textContent = "—";
    parentName.removeAttribute("title");
    parentName.classList.remove("is-root");
    parentStatus.hidden = true;
    parentNote.hidden = true;
    parentOpen.hidden = true;
    parentEdit.hidden = true;
    parentClear.hidden = true;
    return;
  }

  const isOwn = current.isOwn;
  const parentId = current.state.parent.userId;
  parentEdit.hidden = !isOwn;
  parentEdit.disabled = busy;
  parentEdit.textContent = parentId === null ? "Set parent…" : "Change";
  parentClear.hidden = !isOwn || parentId === null;
  parentClear.disabled = busy;

  if (parentId === null) {
    parentName.textContent = "Root";
    parentName.title = "This board has no parent.";
    parentName.classList.add("is-root");
    parentStatus.hidden = true;
    parentNote.hidden = true;
    parentOpen.hidden = true;
    return;
  }

  parentName.textContent = labelForOwner(
    parentId,
    current.state.contacts.entries,
    ownContacts(),
  );
  parentName.title = parentId;
  parentName.classList.remove("is-root");
  parentStatus.hidden = false;
  parentStatus.dataset.state = "checking";
  parentStatus.textContent = "Checking…";
  parentStatus.title = "Checking the parent board.";
  parentNote.hidden = true;
  parentOpen.hidden = true;

  const board = isOwn ? (ownSnapshot() ?? current) : current;

  void parentLink(board, linkDeps).then((info) => {
    if (request !== parentStatusRequest || view !== current) return;
    paintBadge(parentStatus, info.state);
    const legacyParent = info.snapshot?.legacy === true;
    parentNote.hidden = !legacyParent;
    parentNote.title = LEGACY_PARENT_TITLE;
    if (legacyParent) parentNote.textContent = LEGACY_PARENT_NOTE;
    // Own boards may visit a pending parent to see its side. Another owner's
    // parent is only followed when the edge is mutual. A legacy parent can
    // still be a mutual parent because its slots are signed and readable.
    const canOpen =
      info.state === "linked" || (isOwn && info.state === "pending");
    parentOpen.hidden = !canOpen;
    parentOpen.disabled = !canOpen;
  });
}

function legacyTrailBadge(step: TrailStep): HTMLElement | null {
  // A pending parent can be legacy too, but "Pending" already explains the
  // missing side; only mark steps that actually make up the mutual path.
  if (!step.legacy || (step.kind !== "current" && step.kind !== "ancestor")) {
    return null;
  }
  const badge = createElement("span", "state-badge breadcrumb-badge");
  badge.dataset.state = "legacy";
  badge.textContent = "Previous version";
  badge.title =
    step.kind === "current"
      ? LEGACY_BOARD_TITLE
      : "This board is on the previous version. Its slots can still be the parent side of a link.";
  return badge;
}

function renderTrailItem(step: TrailStep, current: ViewedBoard): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "breadcrumb-item";
  const label = labelForOwner(
    step.ownerId,
    step.contacts,
    current.state.contacts.entries,
    ownContacts(),
  );
  const legacy = legacyTrailBadge(step);

  if (step.kind === "current") {
    li.classList.add("is-current");
    li.setAttribute("aria-current", "page");
    const span = createElement("span", "breadcrumb-current", label);
    span.title = step.ownerId;
    li.append(span);
    if (legacy) li.append(legacy);
    return li;
  }

  if (step.kind === "ancestor") {
    const button = createElement("button", "breadcrumb-link", label);
    button.type = "button";
    button.title = step.ownerId;
    button.addEventListener("click", () => {
      void openBoard(step.ownerId);
    });
    li.append(button);
    if (legacy) li.append(legacy);
    return li;
  }

  li.classList.add("is-pending");
  const span = createElement("span", "breadcrumb-pending", label);
  span.title = step.ownerId;
  const badge = createElement("span", "state-badge breadcrumb-badge");
  if (step.kind === "pending") {
    badge.dataset.state = "pending";
    badge.textContent = "Pending";
    badge.title = "This board points at a parent that has not added it yet.";
  } else if (step.kind === "not-created") {
    badge.dataset.state = "not-created";
    badge.textContent = "Not created yet";
    badge.title = "No board exists for this owner yet.";
  } else {
    badge.dataset.state = "error";
    badge.textContent = "Unavailable";
    badge.title = "This board could not be read.";
  }
  span.append(" ", badge);
  if (legacy) span.append(" ", legacy);
  li.append(span);
  return li;
}

async function renderTrail(): Promise<void> {
  const request = ++trailRequest;
  const current = view;

  if (!current) {
    breadcrumbs.hidden = true;
    breadcrumbList.replaceChildren();
    breadcrumbWarning.hidden = true;
    return;
  }

  breadcrumbs.hidden = false;
  const trail = await buildTrail(current, linkDeps);
  if (request !== trailRequest || view !== current) return;

  breadcrumbList.replaceChildren(
    ...trail.steps.map((step) => renderTrailItem(step, current)),
  );
  breadcrumbWarning.textContent = trail.warning ?? "";
  breadcrumbWarning.hidden = trail.warning === null;
}

function renderContactCount(): void {
  const count = ownState?.contacts.entries.length ?? 0;
  contactsCount.textContent = String(count);
  contactsOpen.disabled =
    ownState === null || view === null || !view.isOwn || busy || navigating;
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
  boardHome.disabled = busy || navigating;
  parentEdit.disabled = busy || !view?.isOwn;
  parentClear.disabled = busy;
}

function renderAll(): void {
  renderIdentity();
  renderContractKey();
  renderBoard();
  renderWarnings();
  renderContactCount();
  renderBoardHeader();
  renderControls();
  renderParentRow();
  void renderTrail();
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
  childOpen.disabled = value || !childLinkOpenable;
  clearButton.disabled =
    value || !ownState || ownState.slots[currentSlot].entry === null;
  saveButton.textContent = value ? "Saving…" : "Save";
  editorForm.setAttribute("aria-busy", String(value));
  saveButton.setAttribute("aria-busy", String(value));
  updateContactState();
  renderBoard();
  renderControls();
  renderContactCount();

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
  const entries = ownContacts();
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

/** Guidance for a child id that cannot be written into this slot. */
function childProblem(contact: string): string | null {
  if (ownIdentity && contact === ownIdentity.pubkey) {
    return "A slot's child must be a different board. Choose another contact.";
  }
  const otherIndex =
    ownState?.slots.findIndex(
      (slot, index) => index !== currentSlot && slot.entry?.contact === contact,
    ) ?? -1;
  if (otherIndex !== -1) {
    return `That board is already in slot ${otherIndex + 1}. Each child can use only one slot.`;
  }
  return null;
}

function updateContactState(): void {
  const entries = ownContacts();
  const selected = contactSelect.value;
  const known =
    selected !== "" && entries.some((contact) => contact.userId === selected);

  let hint = "";
  let invalid = false;
  if (entries.length === 0) {
    hint = "No contacts yet. Add one to save a slot.";
  } else if (selected === "") {
    hint = "Choose a contact before saving.";
  } else if (!known) {
    hint =
      "This slot's contact is no longer in the address book. Choose a contact to save changes.";
  } else {
    const problem = childProblem(selected);
    if (problem !== null) {
      hint = problem;
      invalid = true;
    }
  }

  contactHint.textContent = hint;
  contactHint.hidden = hint === "";
  contactHint.classList.toggle("is-warning", invalid);

  saveButton.disabled = busy || !known || invalid;
}

function setChildLink(contactId: string | null): void {
  editorRequest += 1;
  childLinkOpenable = false;
  currentChildId = contactId;

  if (contactId === null) {
    childLinkBox.hidden = true;
    childLinkDetail.hidden = true;
    childLinkDetail.textContent = "";
    childOpen.hidden = true;
    childOpen.disabled = true;
    return;
  }

  childLinkBox.hidden = false;
  childLinkStatus.hidden = false;
  childLinkStatus.dataset.state = "checking";
  childLinkStatus.textContent = "Checking…";
  childLinkStatus.title = "Checking the child board.";
  childLinkDetail.textContent = "";
  childLinkDetail.hidden = true;
  childOpen.hidden = false;
  childOpen.disabled = true;
  childOpen.title = "Checking the child board.";
  void refreshChildLink(contactId, editorRequest);
}

async function refreshChildLink(
  contactId: string,
  generation: number,
): Promise<void> {
  const info = await childLink(ownIdentity?.pubkey ?? "", contactId, linkDeps);
  if (generation !== editorRequest || !editor.open) return;

  const label = labelForOwner(contactId, ownContacts());
  const legacyChild = info.snapshot?.legacy === true;
  childLinkStatus.dataset.state = info.state;
  childLinkStatus.textContent = LINK_LABELS[info.state];
  childLinkStatus.title = legacyChild
    ? "This child is on the previous version and has no parent record yet."
    : LINK_TITLES[info.state];

  let detail = "";
  if (info.state === "linked") {
    detail = `${label} lists this board as its parent.`;
  } else if (legacyChild) {
    detail =
      `${label} is on the previous version. Child owner must open the v3 app ` +
      "to link back.";
  } else if (info.state === "pending") {
    detail = `${label} has not set this board as its parent yet.`;
  } else if (info.state === "not-created") {
    detail = `${label} has not opened number yet.`;
  } else if (info.state === "error") {
    detail = `Could not check this board: ${info.error ?? "the read failed"}.`;
  }

  childLinkDetail.textContent = detail;
  childLinkDetail.hidden = detail === "";
  childLinkOpenable = info.state !== "not-created";
  childOpen.disabled = busy || !childLinkOpenable;
  childOpen.title = childLinkOpenable
    ? `Open the child board for ${label}.`
    : `${label} has not created a board yet.`;
}

function openEditor(index: number): void {
  if (!ownState || !ownIdentity || busy || !view?.isOwn) return;

  currentSlot = index;
  const slot = ownState.slots[index];
  const entry = slot.entry;

  editorSlot.textContent = String(index + 1).padStart(2, "0");
  editorTitle.textContent = `Slot ${index + 1}`;
  editorSeq.textContent =
    slot.seq === 0 ? "Never written" : `Signed at sequence ${slot.seq}`;
  valueInput.value = entry ? formatCents(entry.value) : "";
  unitInput.value = entry?.unit ?? "";
  noteInput.value = entry?.note ?? "";
  clearButton.disabled = entry === null;
  clearButton.textContent = "Clear slot";

  editorError.hidden = true;
  editorError.textContent = "";
  valueInput.removeAttribute("aria-invalid");
  populateContactOptions(entry?.contact ?? "");
  updateValueWarning();
  setChildLink(entry?.contact ?? null);

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
  if (busy || !ownState || !view?.isOwn) return;

  const contact = contactSelect.value;
  if (contact === "") {
    showEditorError("Choose a contact before saving.", contactSelect);
    return;
  }

  const problem = childProblem(contact);
  if (problem !== null) {
    showEditorError(problem, contactSelect);
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
  if (busy || !ownState || !view?.isOwn) return;
  const slot = ownState.slots[currentSlot];
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
  boardCache.clear();
  try {
    await backend.retry();
  } catch (error) {
    showFatal(error);
  }
}

function goHome(): void {
  if (!view || view.isOwn) return;
  const snapshot = ownSnapshot();
  if (snapshot === null) return;

  view = toView(snapshot);
  hideErrorNotice();
  renderAll();
  announce("Back on your board.");
  boardTitle.focus({ preventScroll: true });
}

async function openBoard(ownerId: string): Promise<void> {
  if (!ownIdentity || navigating) return;
  if (ownerId === ownIdentity.pubkey) {
    goHome();
    return;
  }
  if (view !== null && !view.isOwn && view.ownerId === ownerId) return;

  navigating = true;
  renderBoardHeader();
  renderBoard();
  renderControls();
  renderContactCount();

  try {
    const snapshot = await readBoardForView(ownerId);
    if (snapshot === null) {
      const label = labelForOwner(
        ownerId,
        ownContacts(),
        view?.state.contacts.entries ?? [],
      );
      showNotice(
        "info",
        "Board not created yet",
        `${label} has not opened number yet, so there is no board to show.`,
      );
      announce("That board has not been created yet.");
      return;
    }

    view = toView(snapshot);
    hideErrorNotice();
    renderAll();
    const label = labelForOwner(
      ownerId,
      ownContacts(),
      view.state.contacts.entries,
    );
    announce(`Viewing ${label}.`);
    boardTitle.focus({ preventScroll: true });
  } catch (error) {
    showNotice("error", "Could not open that board", humanError(error));
    announce("Could not open that board.");
  } finally {
    navigating = false;
    renderBoardHeader();
    renderBoard();
    renderControls();
    renderContactCount();
  }
}

async function clearParent(): Promise<void> {
  if (busy || !view?.isOwn || !ownState?.parent.userId) return;

  busy = true;
  renderBoard();
  renderControls();
  renderContactCount();
  renderParentRow();
  try {
    await backend.saveParent(null);
    hideErrorNotice();
    announce("Parent cleared. This board is a root.");
  } catch (error) {
    showNotice("error", "Parent not cleared", humanError(error));
    announce("Parent not cleared.");
  } finally {
    busy = false;
    renderBoard();
    renderControls();
    renderContactCount();
    renderParentRow();
  }
}

async function handleParentSaved(): Promise<void> {
  const parentId = ownState?.parent.userId ?? null;
  renderAll();

  if (parentId === null) {
    announce("Parent cleared. This board is a root.");
    return;
  }

  const snapshot = ownSnapshot();
  if (snapshot === null) return;
  const info = await parentLink(snapshot, linkDeps);
  const label = labelForOwner(parentId, ownContacts());
  const legacyNote = info.snapshot?.legacy
    ? " The parent board is on the previous version."
    : "";

  if (info.state === "linked") {
    announce(`Parent saved. Linked to ${label}.${legacyNote}`);
  } else if (info.state === "pending") {
    announce(
      `Parent saved. Pending until ${label} adds this board.${legacyNote}`,
    );
  } else if (info.state === "not-created") {
    announce(`Parent saved. ${label} has not created a board yet.`);
  } else {
    announce("Parent saved. The link could not be checked.");
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
    ownState = state;
    if (ownIdentity && (view === null || view.isOwn)) {
      const snapshot = ownSnapshot();
      if (snapshot) view = toView(snapshot);
    }
    renderAll();
    contactsDialog.refresh();
    parentDialog?.refresh();
    // A contacts write can land while the editor is open (the address book is
    // reachable from it). Keep the options honest without losing the selection.
    if (editor.open) {
      populateContactOptions(contactSelect.value);
      updateContactState();
    }
  },
  onIdentity: (next) => {
    ownIdentity = next;
    if (view === null || view.isOwn) {
      const snapshot = ownSnapshot();
      if (snapshot) view = toView(snapshot);
    }
    renderAll();
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

let parentDialog: ParentDialog | null = null;

const contactsDialog = createContactsDialog({
  getContacts: ownContacts,
  getUsedContactCount: (userId) => {
    if (!ownState) return 0;
    const slotUses = ownState.slots.filter(
      (slot) => slot.entry?.contact === userId,
    ).length;
    const parentUse = ownState.parent.userId === userId ? 1 : 0;
    return slotUses + parentUse;
  },
  saveContacts: (entries) => backend.saveContacts(entries),
  announce,
  onAdded: (contact) => {
    if (addingForParent) {
      addingForParent = false;
      parentDialog?.selectContact(contact.userId);
      return;
    }
    if (!editor.open) return;
    populateContactOptions(contact.userId, contact);
    editorError.hidden = true;
    editorError.textContent = "";
    updateContactState();
    setChildLink(contact.userId);
    contactSelect.focus({ preventScroll: true });
  },
});

parentDialog = createParentDialog({
  getContacts: ownContacts,
  getOwnOwnerId: () => ownIdentity?.pubkey ?? null,
  getParent: () => ownState?.parent.userId ?? null,
  readBoard: readBoardForView,
  saveParent: async (userId) => {
    if (!view?.isOwn) {
      throw new Error("Open your own board before changing its parent.");
    }
    busy = true;
    renderBoard();
    renderControls();
    renderContactCount();
    try {
      await backend.saveParent(userId);
    } finally {
      busy = false;
      renderBoard();
      renderControls();
      renderContactCount();
    }
  },
  openContacts: () => {
    addingForParent = true;
    contactsDialog.open({ selectOnAdd: true });
  },
  announce,
  onSaved: () => {
    hideErrorNotice();
    void handleParentSaved();
  },
});

const delegateDialog = createDelegateDialog({
  offline: isOffline,
  installDelegate: () => backend.installDelegate(),
  announce,
});

const identityDialogs = createIdentityDialogs({
  offline: isOffline,
  getIdentity: () => ownIdentity,
  exportIdentity: () => backend.exportIdentity(),
  importIdentity: (seed, nextSeq, contactsNextSeq, parentNextSeq) =>
    backend.importIdentity(seed, nextSeq, contactsNextSeq, parentNextSeq),
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
renderAll();
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
contactSelect.addEventListener("change", () => {
  updateContactState();
  setChildLink(contactSelect.value === "" ? null : contactSelect.value);
});
contactAdd.addEventListener("click", () => {
  addingForParent = false;
  contactsDialog.open({ selectOnAdd: true });
});
contactsOpen.addEventListener("click", () => {
  addingForParent = false;
  contactsDialog.open();
});

editor.addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
editor.addEventListener("click", (event) => {
  if (event.target === editor && !busy) closeEditor();
});

childOpen.addEventListener("click", () => {
  const id = currentChildId;
  if (!id || busy) return;
  closeEditor();
  void openBoard(id);
});

boardHome.addEventListener("click", goHome);
boardCopy.addEventListener("click", () => {
  if (view) {
    void copyToClipboard(view.ownerId, "Board owner", boardCopy);
  }
});
parentEdit.addEventListener("click", () => {
  if (view?.isOwn) parentDialog?.open();
});
parentClear.addEventListener("click", () => {
  void clearParent();
});
parentOpen.addEventListener("click", () => {
  const id = view?.state.parent.userId ?? null;
  if (id !== null) void openBoard(id);
});

identityCopy.addEventListener("click", () => {
  if (ownIdentity) {
    void copyToClipboard(ownIdentity.pubkey, "Owner public key", identityCopy);
  }
});
identityBackup.addEventListener("click", () => {
  identityDialogs.openManagement();
});
contractCopy.addEventListener("click", () => {
  const key = currentContractKey();
  if (key) {
    void copyToClipboard(key, "Contract key", contractCopy);
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
