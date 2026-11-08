import "./styles.css";
import {
  OnlineBoard,
  entryFromInputs,
  type BoardBackend,
  type BoardCallbacks,
  type BoardSnapshot,
  type BoardStatus,
} from "./board";
import { APP_NAME } from "./brand";
import {
  createContactsDialog,
  parseReceiveInvite,
  recipientAddressLine,
  resolveReceiveInvite,
  type ReceiveInvite,
} from "./contacts-dialog";
import {
  DelegateError,
  delegateNeverScanned,
  isDelegateStatusStale,
  type ContactRecord,
  type DelegateIdentity,
  type DelegateStatus,
} from "./delegate";
import { createDelegateDialog } from "./delegate-dialog";
import { ContractBuildError, deriveInstanceId } from "./freenet";
import { createIdentityDialogs } from "./identity-dialog";
import { OfflineBoard } from "./mock";
import { createParentDialog, type ParentDialog } from "./parent-dialog";
import { createOnboardingPanel, stripJoinParams } from "./onboarding-panel";
import { createRequestsPanel } from "./requests-panel";
import { createRoomPanel } from "./room-panel";
import {
  advancePayment,
  createPaymentIntent,
  describeRoute,
  findIncoming,
  isOctalAddress,
  isStuckForeignRecord,
  paymentProgress,
  planPayment,
  planRoute,
  withdrawPayment,
  type IncomingPayment,
  type PaymentDeps,
  type PaymentEntry,
  type PaymentFailure,
} from "./payments";
import { MAX_CONTACTS } from "./contact-rules";
import { pathToAddress } from "./region/paths";
import type { SlotOccupancy, ZoneRegion } from "./region/zone-region";
import {
  formatCents,
  I64_MAX,
  parseCents,
  SLOT_COUNT,
  stateWarnings,
  validateEntry,
  type Adjustment,
  type Entry,
  type StateV3,
} from "./state";
import {
  BoardCache,
  childLink,
  hasLiveChild,
  MAX_TREE_DEPTH,
  octalAddress,
  parentGivenName,
  parentLink,
  parentValueFor,
  type AddressInfo,
  type AddressProblem,
  type LinkInfo,
  type LinkState,
} from "./tree-view";
import { errorMessage, hexToBytes, shorten, utf8Length } from "./util";

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
const detailsBox = byId<HTMLDetailsElement>("details");
const detailsSummary = byId<HTMLElement>("details-summary");
const detailsAttention = byId<HTMLElement>("details-attention");
const autoAdvanceBadge = byId<HTMLElement>("auto-advance-badge");
const autoAdvanceForm = byId<HTMLFormElement>("auto-advance-form");
const autoAdvanceToggle = byId<HTMLInputElement>("auto-advance-toggle");
const autoAdvanceMax = byId<HTMLInputElement>("auto-advance-max");
const autoAdvanceSave = byId<HTMLButtonElement>("auto-advance-save");
const autoAdvanceMaxWarning = byId<HTMLParagraphElement>("auto-advance-max-warning");
const autoAdvanceReason = byId<HTMLParagraphElement>("auto-advance-reason");
const autoAdvanceError = byId<HTMLParagraphElement>("auto-advance-error");
const autoAdvanceState = byId<HTMLElement>("auto-advance-state");
const autoAdvanceHash = byId<HTMLElement>("auto-advance-hash");
const autoAdvanceAddress = byId<HTMLElement>("auto-advance-address");
const autoAdvanceScan = byId<HTMLElement>("auto-advance-scan");
const autoAdvanceSubs = byId<HTMLElement>("auto-advance-subs");
const autoAdvanceStale = byId<HTMLParagraphElement>("auto-advance-stale");
const autoAdvanceRouteAlert = byId<HTMLParagraphElement>("auto-advance-route-alert");
const autoAdvanceLastError = byId<HTMLParagraphElement>("auto-advance-last-error");
const autoAdvanceAudit = byId<HTMLUListElement>("auto-advance-audit");
const autoAdvanceAuditEmpty = byId<HTMLParagraphElement>("auto-advance-audit-empty");
const autoAdvanceRefresh = byId<HTMLButtonElement>("auto-advance-refresh");
const parentName = byId<HTMLElement>("parent-name");
const parentStatus = byId<HTMLSpanElement>("parent-status");
const parentNote = byId<HTMLParagraphElement>("parent-note");
const parentEdit = byId<HTMLButtonElement>("parent-edit");
const parentClear = byId<HTMLButtonElement>("parent-clear");
const parentAdvancedEdit = byId<HTMLButtonElement>("parent-advanced-edit");
const parentAdvancedClear = byId<HTMLButtonElement>("parent-advanced-clear");
const contactsOpen = byId<HTMLButtonElement>("contacts-open");
const contactsCount = byId<HTMLElement>("contacts-count");
const roomBlock = byId<HTMLElement>("room-block");
const roomBlockSummary = byId<HTMLParagraphElement>("room-block-summary");
const roomOpen = byId<HTMLButtonElement>("room-open");
// The room log is an ordered list; role="log" on an <ol> also invalidates the
// native list-item role for axe. Keep the live region and drop the role.
byId<HTMLOListElement>("room-messages").removeAttribute("role");
const reconnectButton = byId<HTMLButtonElement>("reconnect");

const notice = byId<HTMLDivElement>("notice");
const noticeTitle = byId<HTMLElement>("notice-title");
const noticeText = byId<HTMLParagraphElement>("notice-text");
const noticeAction = byId<HTMLButtonElement>("notice-action");
const noticeDismiss = byId<HTMLButtonElement>("notice-dismiss");

const warningsBox = byId<HTMLDivElement>("warnings");
const warningList = byId<HTMLUListElement>("warning-list");
const boardTitle = byId<HTMLHeadingElement>("board-title");
const boardMode = byId<HTMLParagraphElement>("board-mode");
const boardAddress = byId<HTMLElement>("board-address");
const boardAddressValue = byId<HTMLElement>("board-address-value");
const boardAddressNote = byId<HTMLElement>("board-address-note");
const boardRegionState = byId<HTMLElement>("board-region-state");
const parentValueBox = byId<HTMLElement>("parent-value");
const parentValueBoard = byId<HTMLElement>("parent-value-board");
const parentValueSlot = byId<HTMLElement>("parent-value-slot");
const parentValueState = byId<HTMLElement>("parent-value-state");
const parentValueFigure = byId<HTMLParagraphElement>("parent-value-figure");
const parentValueAmount = byId<HTMLElement>("parent-value-amount");
const parentValueUnit = byId<HTMLElement>("parent-value-unit");
const parentValueChange = byId<HTMLParagraphElement>("parent-value-change");
const parentValueNote = byId<HTMLParagraphElement>("parent-value-note");
const parentValueEmpty = byId<HTMLParagraphElement>("parent-value-empty");
const parentAdjustments = byId<HTMLElement>("parent-adjustments");
const parentAdjustmentsMeta = byId<HTMLElement>("parent-adjustments-meta");
const parentAdjustmentsList = byId<HTMLOListElement>("parent-adjustments-list");
const parentAdjustmentsEmpty = byId<HTMLParagraphElement>(
  "parent-adjustments-empty",
);
const boardElement = byId<HTMLDivElement>("board");
const boardHint = byId<HTMLParagraphElement>("board-hint");

const simpleView = byId<HTMLElement>("simple-view");
const advancedView = byId<HTMLElement>("advanced-view");
const viewToggle = byId<HTMLButtonElement>("view-toggle");
const advancedTitle = byId<HTMLHeadingElement>("advanced-title");
const parentValueTitle = byId<HTMLElement>("parent-value-title");

const simplePay = byId<HTMLButtonElement>("simple-pay");
const simplePayReason = byId<HTMLElement>("simple-pay-reason");
const simpleContacts = byId<HTMLButtonElement>("simple-contacts");
const simpleContactsReason = byId<HTMLElement>("simple-contacts-reason");
const simpleReceiveLink = byId<HTMLButtonElement>("simple-receive-link");
const simpleReceiveReason = byId<HTMLElement>("simple-receive-reason");
const simpleReceiveStatus = byId<HTMLElement>("simple-receive-status");
const simplePaymentWaiting = byId<HTMLElement>("simple-payment-waiting");
const simplePaymentReview = byId<HTMLButtonElement>("simple-payment-review");
const simpleChildren = byId<HTMLElement>("simple-children");
const simpleChildrenList = byId<HTMLUListElement>("simple-children-list");
const simpleParent = byId<HTMLElement>("simple-parent");
const simpleParentName = byId<HTMLElement>("simple-parent-name");
const simpleParentReason = byId<HTMLElement>("simple-parent-reason");
const simpleRecordSheet = byId<HTMLElement>("simple-record-sheet");
const simpleAddress = byId<HTMLElement>("simple-address");
const simpleAddressValue = byId<HTMLElement>("simple-address-value");
const simpleAddressNote = byId<HTMLElement>("simple-address-note");
const simpleOwnerCopy = byId<HTMLButtonElement>("simple-owner-copy");
const simpleOwnerId = byId<HTMLElement>("simple-owner-id");
const simpleOwnerStatus = byId<HTMLElement>("simple-owner-status");
const childSlotsTitle = byId<HTMLElement>("child-slots-title");
const childSlotsEmpty = byId<HTMLElement>("child-slots-empty");
const addChildSlot = byId<HTMLButtonElement>("add-child-slot");
const unconfirmedSlots = byId<HTMLElement>("unconfirmed-slots");
const unconfirmedList = byId<HTMLUListElement>("unconfirmed-list");
const unconfirmedEmpty = byId<HTMLElement>("unconfirmed-empty");
const advancedAdjustments = byId<HTMLElement>("advanced-adjustments");
const clearedSlots = byId<HTMLElement>("cleared-slots");

const editor = byId<HTMLDialogElement>("editor");
const editorForm = byId<HTMLFormElement>("editor-form");
const editorSlot = byId<HTMLSpanElement>("editor-slot");
const editorTitle = byId<HTMLHeadingElement>("editor-title");
const editorSeq = byId<HTMLParagraphElement>("editor-seq");
const editorClose = byId<HTMLButtonElement>("editor-close");
const adjustPanel = byId<HTMLElement>("adjust-panel");
const adjustControls = byId<HTMLElement>("adjust-controls");
const adjustChild = byId<HTMLElement>("adjust-child");
const adjustStale = byId<HTMLParagraphElement>("adjust-stale");
const adjustCurrent = byId<HTMLElement>("adjust-current");
const adjustUnit = byId<HTMLElement>("adjust-unit");
const adjustResult = byId<HTMLElement>("adjust-result");
const adjustResultTag = byId<HTMLElement>("adjust-result-tag");
const adjustDirection = byId<HTMLFieldSetElement>("adjust-direction");
const adjustIssue = byId<HTMLInputElement>("adjust-issue");
const adjustBurn = byId<HTMLInputElement>("adjust-burn");
const adjustAmount = byId<HTMLInputElement>("adjust-amount");
const adjustNote = byId<HTMLInputElement>("adjust-note");
const adjustNoteCount = byId<HTMLElement>("adjust-note-count");
const adjustWarning = byId<HTMLParagraphElement>("adjust-warning");
const adjustSubmit = byId<HTMLButtonElement>("adjust-submit");
const adjustStatus = byId<HTMLParagraphElement>("adjust-status");
const adjustEmpty = byId<HTMLParagraphElement>("adjust-empty");
const contactSelect = byId<HTMLSelectElement>("contact-select");
const contactAdd = byId<HTMLButtonElement>("contact-add");
const contactHint = byId<HTMLParagraphElement>("contact-hint");
const unitInput = byId<HTMLInputElement>("unit-input");
const noteInput = byId<HTMLTextAreaElement>("note-input");
const childLinkBox = byId<HTMLElement>("child-link");
const childLinkStatus = byId<HTMLSpanElement>("child-link-status");
const childLinkDetail = byId<HTMLParagraphElement>("child-link-detail");
const editorError = byId<HTMLParagraphElement>("editor-error");
const clearButton = byId<HTMLButtonElement>("clear-button");
const cancelButton = byId<HTMLButtonElement>("cancel-button");
const saveButton = byId<HTMLButtonElement>("save-button");
const srStatus = byId<HTMLParagraphElement>("sr-status");

const paymentsSection = byId<HTMLElement>("payments");
const paymentCheck = byId<HTMLButtonElement>("payment-check");
const paymentNote = byId<HTMLParagraphElement>("payment-note");
const paymentAutoNote = byId<HTMLElement>("payment-auto-note");
const paymentStatus = byId<HTMLElement>("payment-status");
const paymentStatusBadge = byId<HTMLElement>("payment-status-badge");
const paymentStatusTitle = byId<HTMLElement>("payment-status-title");
const paymentStatusDetail = byId<HTMLElement>("payment-status-detail");
const paymentStatusRoute = byId<HTMLElement>("payment-status-route");
const paymentWithdraw = byId<HTMLButtonElement>("payment-withdraw");
const paymentClear = byId<HTMLButtonElement>("payment-clear");
const paymentInbox = byId<HTMLElement>("payment-inbox");
const paymentInboxList = byId<HTMLUListElement>("payment-inbox-list");
const paymentEmpty = byId<HTMLElement>("payment-empty");

const paymentDialog = byId<HTMLDialogElement>("payment-dialog");
const paymentForm = byId<HTMLFormElement>("payment-form");
const paymentClose = byId<HTMLButtonElement>("payment-close");
const paymentRecipient = byId<HTMLSelectElement>("payment-recipient");
const paymentAddressBook = byId<HTMLButtonElement>("payment-address-book");
const paymentRecipientStatus = byId<HTMLParagraphElement>(
  "payment-recipient-status",
);
const paymentDirect = byId<HTMLDetailsElement>("payment-direct");
const paymentAddress = byId<HTMLInputElement>("payment-address");
const paymentUser = byId<HTMLInputElement>("payment-user");
const paymentAmount = byId<HTMLInputElement>("payment-amount");
const paymentWarning = byId<HTMLElement>("payment-warning");
const paymentError = byId<HTMLElement>("payment-error");
const paymentCancel = byId<HTMLButtonElement>("payment-cancel");
const paymentSubmit = byId<HTMLButtonElement>("payment-submit");
const PAYMENT_SUBMIT_LABEL = paymentSubmit.textContent || "Send payment";

interface SlotView {
  button: HTMLButtonElement;
  value: HTMLSpanElement;
  unit: HTMLSpanElement;
  label: HTMLSpanElement;
  id: HTMLSpanElement;
  region: HTMLSpanElement;
  note: HTMLSpanElement;
  seq: HTMLSpanElement;
  action: HTMLSpanElement;
}

interface ViewedBoard {
  ownerId: string;
  state: StateV3;
  /** Only the owner's own board has a private address book. */
  contacts: ContactRecord[];
  codeHash: string;
  legacy: boolean;
}

/** Newest adjustments kept in the child's "Held by parent" band. */
const CHILD_ADJUSTMENT_LIMIT = 4;
const ADJUST_NOTE_BYTES = 128;

const slotViews: SlotView[] = [];

/** The viewer's own board. The app always shows this board. */
let ownState: StateV3 | null = null;
let ownIdentity: DelegateIdentity | null = null;
/** The own board on screen. */
let view: ViewedBoard | null = null;

type ViewMode = "simple" | "advanced";
/** Which surface is painted. Both stay mounted; only visibility changes. */
let viewMode: ViewMode = "simple";
/** True when this page session pushed the `?view=advanced` history entry. */
let pushedAdvancedEntry = false;

/** Which slots are mutual children, keyed by slot index. Repainted async. */
let slotExistence = new Map<number, boolean>();
let slotExistenceOwner: string | null = null;
let slotExistenceRequest = 0;

/** Why the simple Send payment action is disabled, or null when it is usable. */
let paymentBlockedReason: string | null = "Waiting for your zone.";

/** The own parent link's state, or null while it is being checked. */
let ownParentLinkState: LinkState | null = null;
/** The own board's resolved receive address, or null while it is being checked. */
let ownReceiveAddress: AddressInfo | null = null;
let ownReceiveAddressOwner: string | null = null;

const RECEIVE_LINK_LABEL = "Copy receive-payment link";
const RECEIVE_LINK_COPIED_LABEL = "Copied";

let contractKeyFull: string | null = null;
let boardStatus: BoardStatus = "starting";
let busy = false;
/** True while an adjustment is being signed, for the button's own label. */
let adjusting = false;
let currentSlot = 0;
let editorRequest = 0;
/**
 * A contact supplied by an admission handoff. The candidate need not be in the
 * address book yet, so the slot editor carries them as an extra option for
 * this opening only.
 */
let editorPrefillContact: ContactRecord | null = null;
let parentStatusRequest = 0;
let addressRequest = 0;
let parentValueRequest = 0;
let paymentsRequest = 0;
let noticeRetry: (() => void | Promise<void>) | null = null;
/** True while the address book was opened from the parent dialog. */
let addingForParent = false;
/** True while the address book was opened from the payment dialog. */
let addingForPayment = false;
/** True while the payment dialog's submit is in flight. */
let paymentBusy = false;
/** A receive-payment link captured at boot, waiting for the app to be ready. */
let pendingReceiveLink: ReceiveInvite | null = null;
/** True once a link has been resolved (opened, rejected, or handled). */
let receiveLinkSettled = false;
/** A `?room=` owner id captured at boot, waiting for the board to be ready. */
let pendingRoomOwner: string | null = null;
/** True once a room link has been opened or dismissed. */
let roomLinkSettled = false;
/** A raw `?root=` value captured at boot, waiting for the board to be ready. */
let pendingRootValue: string | null = null;
/** True once a root link has been opened or dismissed. */
let rootLinkSettled = false;

/** The last auto-advance status the local component reported. */
let autoAdvanceStatus: DelegateStatus | null = null;
/** True once a status read has completed, even when it returned nothing. */
let autoAdvanceStatusReceived = false;
/** Status delivered by the backend callback, used when the property lags. */
let delegateStatusFromCallback: DelegateStatus | null = null;
let autoAdvanceRefreshError: string | null = null;
let autoAdvanceRefreshRequest = 0;
let autoAdvanceRefreshing = false;
let autoAdvanceSaving = false;
/** True while the user has unsaved edits; status repaints must not clobber them. */
let autoAdvanceDirty = false;
/**
 * Whether the own board has a live child. null means "not checked yet"; the
 * check runs only when the delegate reports no scans, because that is the only
 * case where a child makes the missing grant operationally important.
 */
let ownLiveChild: boolean | null = null;
let ownLiveChildRequest = 0;

const OWN_BOARD_HINT =
  "Select a slot to issue or burn the liability it holds for its child, or to " +
  "change the contact, unit, or note. Amounts show two decimal places, and a " +
  "burn cannot take a liability below 0.00. A slot stores the child's key, so " +
  "renaming a contact keeps the link, but the name the child sees is the one " +
  "signed with the slot: rename the contact and save the slot again to change " +
  "it. Every change is signed by the owner key and merged by the contract. " +
  "Clearing a slot records that it was cleared, so an older copy cannot bring " +
  "it back.";

const LINK_LABELS: Record<LinkState, string> = {
  root: "Root",
  linked: "Linked",
  pending: "Pending",
  "not-created": "Not created yet",
  error: "Could not check",
};

const LINK_TITLES: Record<LinkState, string> = {
  root: "This zone has no parent.",
  linked: "Both zones point at each other.",
  pending: "Only one side points at the other yet.",
  "not-created": "No zone exists for this owner yet.",
  error: "This zone could not be read.",
};

/** Short visible reasons for an unresolved octal address. */
const ADDRESS_PROBLEM_LABELS: Record<AddressProblem, string> = {
  pending: "pending",
  "not-created": "not created",
  unreadable: "unreadable",
  loop: "loop",
  truncated: "too deep",
};

/** One-line explanations, used in the chip's title and accessible name. */
const ADDRESS_PROBLEM_REASONS: Record<AddressProblem, string> = {
  pending: "the parent zone has not added this zone yet",
  "not-created": "the parent zone has not been created yet",
  unreadable: "a parent zone could not be read",
  loop: "the parent links form a loop",
  truncated: `the path is more than ${MAX_TREE_DEPTH} zones deep`,
};

const LEGACY_PARENT_NOTE = "Parent zone is on the previous version.";
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

function ownContacts(): ContactRecord[] {
  return backend.contacts;
}

function contactLabel(userId: string): string | null {
  return ownContacts().find((contact) => contact.userId === userId)?.label ?? null;
}

/**
 * How a zone is identified when there is no parent-given or private contact
 * name: the private label on this device, then a shortened owner key. A zone
 * has no public name of its own.
 */
function ownerLabel(ownerId: string): string {
  return contactLabel(ownerId) ?? `Owner ${shortUserId(ownerId)}`;
}

/** Occupied child contacts on the viewed board, deduped and without the owner. */
function zoneRoomContacts(): string[] {
  const current = view;
  if (current === null) return [];
  const owner = ownIdentity?.pubkey ?? null;
  const contacts = new Set<string>();
  for (const slot of current.state.slots) {
    const contact = slot.entry?.contact;
    if (!contact || contact === owner) continue;
    contacts.add(contact);
  }
  return [...contacts];
}

/** The room block exists only with a zone, and its summary says who is in it. */
function renderRoomBlock(): void {
  roomBlock.hidden = view === null;
  if (view === null) return;
  const count = zoneRoomContacts().length;
  roomBlockSummary.textContent =
    count === 0
      ? "Just you so far. Messages are public."
      : `Owner and ${count} child zone${count === 1 ? "" : "s"}. Messages are public.`;
}

/**
 * The backend's issue/burn method, or null when this build cannot sign
 * adjustments (the offline preview). Callers turn null into an explained state
 * instead of a dead button.
 */
type AdjustSigner = (
  slotIndex: number,
  delta: bigint,
  note: string,
) => Promise<void>;

function adjustmentBackend(): AdjustSigner | null {
  const method = backend.issueOrBurn;
  return typeof method === "function" ? method.bind(backend) : null;
}

/** Signed two-decimal amount for a log row: +12.00 or -5.00. */
function formatAdjustmentDelta(delta: bigint): string {
  const magnitude = formatCents(delta < 0n ? -delta : delta);
  return delta > 0n ? `+${magnitude}` : `-${magnitude}`;
}

function ownSnapshot(): BoardSnapshot | null {
  if (!ownState || !ownIdentity) return null;
  return {
    ownerId: ownIdentity.pubkey,
    state: ownState,
    contacts: backend.contacts,
    codeHash: BOARD_CONFIG.contractCodeHash,
    legacy: false,
  };
}

function toView(snapshot: BoardSnapshot): ViewedBoard {
  return {
    ownerId: snapshot.ownerId,
    state: snapshot.state,
    contacts: snapshot.contacts,
    codeHash: snapshot.codeHash,
    legacy: snapshot.legacy,
  };
}

const boardCache = new BoardCache((ownerId) => backend.readBoard(ownerId));

/** Other boards are cached; the own board always comes from live state. */
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
  // The own board's key arrives from the client once the instance resolves,
  // but that callback is tied to the connection lifecycle. Derive it from the
  // code hash and owner key instead, so a reconnect cannot blank the id.
  if (contractKeyFull) return contractKeyFull;
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
    const id = createElement("span", "slot-id");
    id.hidden = true;
    const region = createElement("span", "slot-region");
    region.hidden = true;
    const note = createElement("span", "slot-note");
    note.hidden = true;
    const action = createElement("span", "sr-only", "Waiting for the zone.");

    // Let the button's own visible content name it, with one hidden action hint.
    // This keeps voice-control labels and screen-reader output in sync.
    button.append(top, valueLine, label, id, region, note, action);
    boardElement.append(button);
    slotViews.push({ button, value, unit, label, id, region, note, seq, action });
  }
}

function handleSlotClick(index: number): void {
  if (!view || busy) return;
  openEditor(index);
}

/**
 * Whether a written slot is a child of the own board. The map is keyed by slot
 * index and set only after the child's signed parent points back, so a
 * one-sided slot is excluded. The grid and the count use this one predicate.
 */
function slotExistsForView(
  hasEntry: boolean,
  ownerId: string,
  existenceOwner: string | null,
  existence: ReadonlyMap<number, boolean>,
  index: number,
): boolean {
  return (
    hasEntry &&
    existenceOwner === ownerId &&
    existence.get(index) === true
  );
}

/** Count mutual child slots for the board on screen. */
function countMutualSlots(
  ownerId: string,
  existenceOwner: string | null,
  existence: ReadonlyMap<number, boolean>,
): number {
  if (existenceOwner !== ownerId) return 0;
  let count = 0;
  for (const exists of existence.values()) if (exists) count += 1;
  return count;
}

function renderBoard(): void {
  renderRoomBlock();
  const current = view;
  const loading =
    current === null &&
    (boardStatus === "starting" ||
      boardStatus === "connecting" ||
      boardStatus === "identity");
  boardElement.classList.toggle("is-loading", loading);

  if (current === null) {
    for (const slotView of slotViews) {
      slotView.button.hidden = false;
      slotView.button.disabled = true;
      slotView.value.textContent = "—";
      slotView.value.classList.remove("is-long", "is-xlong");
      slotView.unit.textContent = "";
      slotView.label.textContent = "Waiting…";
      slotView.label.classList.remove("is-unknown");
      slotView.label.title = "";
      slotView.id.textContent = "";
      slotView.id.title = "";
      slotView.id.hidden = true;
      slotView.region.textContent = "";
      slotView.region.title = "";
      slotView.region.hidden = true;
      slotView.note.hidden = true;
      slotView.seq.textContent = "seq 0";
      slotView.action.textContent = "Waiting for the zone.";
    }
    renderChildSlotsMeta();
    renderSimpleChildren();
    renderUnconfirmed();
    return;
  }

  const state = current.state;
  const ready = boardStatus === "ready" || boardStatus === "offline";
  const canEdit = ready && !busy;
  const ownAddress =
    ownReceiveAddressOwner === current.ownerId &&
    ownReceiveAddress !== null &&
    ownReceiveAddress.address !== null
      ? ownReceiveAddress.address
      : null;

  state.slots.forEach((slot, index) => {
    const slotView = slotViews[index];
    const entry = slot.entry;
    // Existence is mutual: the parent has the slot and the child's signed
    // parent names this board. A one-sided slot must not inflate the count.
    const exists = slotExistsForView(
      entry !== null,
      current.ownerId,
      slotExistenceOwner,
      slotExistence,
      index,
    );

    // Empty and one-sided slots stay in the DOM but out of the grid; the
    // Unconfirmed slots block below lists the one-sided ones as facts.
    slotView.button.hidden = !exists;
    slotView.button.disabled = !canEdit;
    slotView.button.className = "slot";
    if (entry) slotView.button.classList.add("is-filled");
    else if (slot.seq > 0) slotView.button.classList.add("is-tombstone");
    else slotView.button.classList.add("is-empty");

    slotView.button.setAttribute("aria-haspopup", "dialog");
    slotView.button.setAttribute("aria-controls", "editor");

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

    // A slot's visible name is the one this board gave it in `childNames`.
    // Without one, fall back to the private contact label, then the short key.
    // A zone has no public name of its own any more.
    const givenName = entry ? parentGivenName(current, entry.contact) : null;
    const labelText = entry
      ? givenName ?? ownerLabel(entry.contact)
      : slot.seq > 0
        ? "Cleared"
        : "Empty";
    const unknownSlotLabel = Boolean(entry) && givenName === null;

    slotView.label.textContent = labelText;
    slotView.label.classList.toggle("is-placeholder", !entry);
    slotView.label.classList.toggle("is-unknown", unknownSlotLabel);
    // The full key stays available on hover even when the name is local.
    slotView.label.title = entry ? entry.contact : "";

    // Advanced only: the child's own user id, shortened, with the full key in
    // the tooltip. The simple children list stays name + value.
    slotView.id.textContent = entry ? shorten(entry.contact) : "";
    slotView.id.title = entry ? entry.contact : "";
    slotView.id.hidden = !entry;

    if (entry && ownAddress !== null) {
      const address = `${ownAddress}${index}`;
      slotView.region.textContent = `region ${address}`;
      slotView.region.title =
        `Slot ${index + 1} · address ${address} · cell ${"abcdefgh"[index]}`;
      slotView.region.hidden = false;
    } else {
      slotView.region.textContent = "";
      slotView.region.title = "";
      slotView.region.hidden = true;
    }

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
      : "Read-only.";
  });

  renderChildSlotsMeta();
  renderSimpleChildren();
  renderUnconfirmed();
}

/**
 * The default surface's read-only child list. It mirrors only the mutual slots
 * the Advanced grid already shows: the slot exists here and the child names
 * this board as its parent. A one-sided slot never appears.
 */
function renderSimpleChildren(): void {
  const current = view;
  if (
    current === null ||
    slotExistenceOwner !== current.ownerId
  ) {
    simpleChildren.hidden = true;
    simpleChildrenList.replaceChildren();
    updateSimpleRecordSheet();
    return;
  }

  const rows: HTMLLIElement[] = [];
  const ownAddress =
    ownReceiveAddressOwner === current.ownerId &&
    ownReceiveAddress !== null &&
    ownReceiveAddress.address !== null
      ? ownReceiveAddress.address
      : null;
  current.state.slots.forEach((slot, index) => {
    const entry = slot.entry;
    if (entry === null || slotExistence.get(index) !== true) return;

    const row = createElement("li", "simple-child");
    const name =
      parentGivenName(current, entry.contact) ?? ownerLabel(entry.contact);
    const label = createElement("span", "simple-child-name", name);
    label.title = entry.contact;
    const value = createElement(
      "span",
      "simple-child-value",
      `${formatCents(entry.value)}${entry.unit ? ` ${entry.unit}` : ""}`,
    );
    const id = createElement("span", "simple-child-id", shorten(entry.contact));
    id.title = entry.contact;
    row.append(label, value, id);
    if (ownAddress !== null) {
      row.append(
        createElement(
          "span",
          "simple-child-address",
          `${ownAddress}${index}`,
        ),
      );
    }
    rows.push(row);
  });

  simpleChildrenList.replaceChildren(...rows);
  simpleChildren.hidden = rows.length === 0;
  updateSimpleRecordSheet();
}

/**
 * Advanced's Child slots heading and empty state. "Exists" means the parent has
 * a written slot and the child's signed parent points back here; the count is
 * the only place the capacity limit may appear on the page.
 */
function renderChildSlotsMeta(): void {
  const current = view;
  if (current === null) {
    childSlotsTitle.textContent = "Child slots";
    childSlotsEmpty.hidden = true;
    addChildSlot.hidden = true;
    return;
  }

  const count = countMutualSlots(
    current.ownerId,
    slotExistenceOwner,
    slotExistence,
  );
  childSlotsTitle.textContent = `Child slots (${count} of 8)`;
  childSlotsEmpty.hidden = count > 0;
  const hasEmpty = current.state.slots.some((slot) => slot.entry === null);
  addChildSlot.hidden = !hasEmpty;
}

function unconfirmedRow(index: number): HTMLLIElement {
  const current = view;
  const row = createElement("li", "unconfirmed-row");
  if (current === null) return row;
  const entry = current.state.slots[index].entry;
  if (entry === null) return row;

  const name =
    parentGivenName(current, entry.contact) ?? ownerLabel(entry.contact);
  const copy = createElement("div", "unconfirmed-copy");
  const title = createElement("span", "unconfirmed-name", name);
  title.title = entry.contact;
  const amount = createElement(
    "span",
    "unconfirmed-amount",
    `${formatCents(entry.value)}${entry.unit ? ` ${entry.unit}` : ""}`,
  );
  const fact = createElement(
    "span",
    "unconfirmed-fact",
    "Their zone does not name this zone as its parent yet.",
  );
  copy.append(title, amount, fact);

  const clear = createElement("button", "button button--small button--danger", "Clear");
  clear.type = "button";
  clear.setAttribute("aria-label", `Clear unconfirmed slot ${index + 1} for ${name}`);
  clear.addEventListener("click", () => {
    void clearUnconfirmedSlot(index);
  });

  const ownAddress =
    ownReceiveAddressOwner === current.ownerId &&
    ownReceiveAddress !== null &&
    ownReceiveAddress.address !== null
      ? ownReceiveAddress.address
      : null;
  if (ownAddress !== null) {
    row.append(
      copy,
      createElement(
        "span",
        "unconfirmed-region",
        `Slot ${index + 1} · region ${ownAddress}${index}`,
      ),
      clear,
    );
  } else {
    row.append(copy, clear);
  }
  return row;
}

function renderUnconfirmed(): void {
  const current = view;
  if (current === null) {
    unconfirmedSlots.hidden = true;
    unconfirmedList.replaceChildren();
    return;
  }

  unconfirmedSlots.hidden = false;
  const indices: number[] = [];
  if (slotExistenceOwner === current.ownerId) {
    current.state.slots.forEach((slot, index) => {
      if (slot.entry !== null && slotExistence.get(index) !== true) {
        indices.push(index);
      }
    });
  }
  unconfirmedList.replaceChildren(...indices.map(unconfirmedRow));
  unconfirmedEmpty.hidden = indices.length > 0;
}

async function clearUnconfirmedSlot(index: number): Promise<void> {
  if (busy) return;
  busy = true;
  renderBoard();
  renderControls();
  renderContactCount();
  try {
    await backend.clear(index);
    hideErrorNotice();
    announce(`Slot ${index + 1} cleared.`);
    renderAll();
  } catch (error) {
    showNotice("error", "Slot not cleared", humanError(error));
  } finally {
    busy = false;
    renderBoard();
    renderControls();
    renderContactCount();
  }
}

/** Re-read which slots are mutual children, then repaint the grid and lists. */
async function refreshSlotExistence(): Promise<void> {
  const current = view;
  if (current === null) {
    slotExistence = new Map();
    slotExistenceOwner = null;
    return;
  }

  const request = ++slotExistenceRequest;
  const ownerId = current.ownerId;
  if (slotExistenceOwner !== ownerId) {
    slotExistence = new Map();
    slotExistenceOwner = ownerId;
  }

  const entries = current.state.slots
    .map((slot, index) => ({ index, contact: slot.entry?.contact ?? null }))
    .filter((item): item is { index: number; contact: string } => item.contact !== null);

  const checks = await Promise.all(
    entries.map(async ({ index, contact }) => {
      if (contact === ownerId) return [index, false] as const;
      try {
        const child = await readBoardForView(contact);
        return [
          index,
          child !== null &&
            !child.legacy &&
            child.state.parent.userId === ownerId,
        ] as const;
      } catch {
        return [index, false] as const;
      }
    }),
  );

  if (request !== slotExistenceRequest || view !== current) return;
  slotExistence = new Map(checks);
  slotExistenceOwner = ownerId;
  renderBoard();
}

function renderClearedSlots(): void {
  if (ownState === null) {
    clearedSlots.textContent = "No cleared slots.";
    return;
  }
  const cleared = ownState.slots
    .map((slot, index) =>
      slot.seq > 0 && slot.entry === null ? index + 1 : null,
    )
    .filter((value): value is number => value !== null);
  clearedSlots.textContent =
    cleared.length === 0
      ? "No cleared slots."
      : `Cleared slots: ${cleared.join(", ")}`;
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
    simpleOwnerId.textContent = "Not available";
    simpleOwnerCopy.disabled = true;
    simpleOwnerCopy.removeAttribute("title");
    simpleOwnerCopy.setAttribute("aria-label", "Copy your user id");
    return;
  }
  const short = shorten(ownIdentity.pubkey);
  identityShort.textContent = short;
  identityShort.title = ownIdentity.pubkey;
  identityCopy.disabled = false;
  identityCopy.title = ownIdentity.pubkey;
  identityCopy.setAttribute("aria-label", `Copy owner public key ${short}`);

  simpleOwnerId.textContent = short;
  simpleOwnerId.title = ownIdentity.pubkey;
  simpleOwnerCopy.disabled = false;
  simpleOwnerCopy.title = ownIdentity.pubkey;
  simpleOwnerCopy.setAttribute("aria-label", `Copy your user id ${short}`);
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
  boardMode.textContent = "Signed · two decimals";
  boardHint.textContent = OWN_BOARD_HINT;
}

/** Paint the discreet octal address on the simple surface. */
function paintSimpleAddress(info: AddressInfo | null): void {
  if (info === null) {
    simpleAddressValue.textContent = "—";
    simpleAddressNote.textContent = "checking";
    simpleAddress.title = "Working out this zone's octal address.";
    return;
  }

  if (info.address === null) {
    const problem: AddressProblem = info.problem ?? "unreadable";
    const reason = ADDRESS_PROBLEM_REASONS[problem];
    simpleAddressValue.textContent = "—";
    simpleAddressNote.textContent = reason;
    simpleAddress.title = `Octal address unavailable: ${reason}.`;
    return;
  }

  if (info.address === "") {
    simpleAddressValue.textContent = "root";
    simpleAddressNote.textContent = "";
    simpleAddress.title =
      "This zone is a root, so its octal address is the empty string.";
    return;
  }

  simpleAddressValue.textContent = info.address;
  simpleAddressNote.textContent = "";
  simpleAddress.title =
    `Octal address ${info.address}. Each digit is a zero-based slot ` +
    "number counted from the root.";
}

/**
 * Derive the octal address and paint both the Advanced chip and the quiet
 * label on the simple surface. The walk is asynchronous, so a late read is
 * ignored unless it still belongs to the current request and zone.
 */
function renderBoardAddress(): void {
  const request = ++addressRequest;
  const current = view;

  if (current) {
    ownReceiveAddress = null;
    ownReceiveAddressOwner = current.ownerId;
    renderSimpleActions();
  }

  if (!current) {
    simpleAddress.hidden = true;
    paintSimpleAddress(null);
    boardAddress.hidden = true;
    boardAddress.removeAttribute("data-address");
    boardAddress.removeAttribute("data-state");
    boardAddressValue.textContent = "";
    boardAddressValue.classList.remove("is-long", "is-xlong");
    boardAddressNote.textContent = "";
    boardAddressNote.hidden = true;
    boardAddress.removeAttribute("title");
    boardAddress.setAttribute("aria-label", "Octal address");
    return;
  }

  simpleAddress.hidden = false;
  paintSimpleAddress(null);

  boardAddress.hidden = false;
  delete boardAddress.dataset.address;
  boardAddress.dataset.state = "checking";
  boardAddressValue.textContent = "";
  boardAddressValue.classList.remove("is-long", "is-xlong");
  boardAddressNote.textContent = "checking";
  boardAddressNote.hidden = false;
  boardAddress.title = "Working out this zone's octal address.";
  boardAddress.setAttribute("aria-label", "Octal address: checking");

  const board = ownSnapshot() ?? current;
  void octalAddress(board, linkDeps).then((info) => {
    if (request !== addressRequest || view !== current) return;

    ownReceiveAddress = info;
    ownReceiveAddressOwner = current.ownerId;
    renderSimpleActions();
    paintSimpleAddress(info);
    // The slot and child rows carry the address, so repaint them once known.
    renderBoard();

    if (info.address === null) {
      const problem: AddressProblem = info.problem ?? "unreadable";
      const reason = ADDRESS_PROBLEM_REASONS[problem];
      boardAddress.dataset.state = "unavailable";
      delete boardAddress.dataset.address;
      boardAddressValue.textContent = "—";
      boardAddressValue.classList.remove("is-long", "is-xlong");
      boardAddressNote.textContent = ADDRESS_PROBLEM_LABELS[problem];
      boardAddressNote.hidden = false;
      boardAddress.title = `Octal address unavailable: ${reason}.`;
      boardAddress.setAttribute(
        "aria-label",
        `Octal address unavailable: ${reason}`,
      );
      return;
    }

    // A root's address is the empty string. Keep the attribute (and the value
    // element's empty text) honest, and let CSS show the em dash.
    boardAddress.dataset.address = info.address;
    if (info.address === "") {
      boardAddress.dataset.state = "root";
      boardAddressValue.textContent = "";
      boardAddressValue.classList.remove("is-long", "is-xlong");
      boardAddressNote.textContent = "root";
      boardAddressNote.hidden = false;
      boardAddress.title =
        "This zone is a root, so its octal address is the empty string.";
      boardAddress.setAttribute("aria-label", "Octal address: root (empty)");
      return;
    }

    boardAddress.dataset.state = "known";
    boardAddressValue.textContent = info.address;
    boardAddressValue.classList.toggle(
      "is-long",
      info.address.length > 8 && info.address.length <= 16,
    );
    boardAddressValue.classList.toggle("is-xlong", info.address.length > 16);
    boardAddressNote.textContent = "";
    boardAddressNote.hidden = true;
    boardAddress.title =
      `Octal address ${info.address}. Each digit is a zero-based slot ` +
      "number counted from the root.";
    boardAddress.setAttribute("aria-label", `Octal address ${info.address}`);
  });
}

/** Slot occupancy in slot order for the region picker. */
function ownSlotOccupancy(): SlotOccupancy[] {
  const current = view;
  const slots: SlotOccupancy[] = [];
  for (let index = 0; index < SLOT_COUNT; index += 1) {
    const entry = current?.state.slots[index]?.entry ?? null;
    if (entry === null) {
      slots.push("free");
      continue;
    }
    const exists =
      current !== null &&
      slotExistenceOwner === current.ownerId &&
      slotExistence.get(index) === true;
    slots.push(exists ? "taken" : "unconfirmed");
  }
  return slots;
}

/**
 * The own zone's octal address, reusing the painted value when it belongs to
 * the zone on screen and resolving it again otherwise.
 */
async function ownRegionAddress(): Promise<string | null> {
  const current = view;
  if (current === null) return null;
  if (
    ownReceiveAddressOwner === current.ownerId &&
    ownReceiveAddress !== null &&
    ownReceiveAddress.address !== null
  ) {
    return ownReceiveAddress.address;
  }
  const info = await octalAddress(ownSnapshot() ?? current, linkDeps);
  return info.address;
}

function paintBoardRegionState(region: ZoneRegion): void {
  let text: string;
  if (region.root) {
    text = "Root · the whole world";
  } else if (region.provisional) {
    text = region.ancestor
      ? `Provisional · shown inside ${pathToAddress(region.ancestor.path)}`
      : "Provisional · the map does not cover this area yet";
  } else if (region.cell) {
    text = `Published · cell ${region.cell.letters}`;
  } else {
    text = "Published";
  }
  boardRegionState.textContent = text;
  boardRegionState.hidden = false;
}

function announceAddressProblem(): void {
  const info =
    ownReceiveAddressOwner === view?.ownerId ? ownReceiveAddress : null;
  const problem: AddressProblem = info?.problem ?? "unreadable";
  announce(`Octal address unavailable: ${ADDRESS_PROBLEM_REASONS[problem]}.`);
}

async function openZoneRegionPicker(): Promise<void> {
  const address = await ownRegionAddress();
  if (address === null) {
    announceAddressProblem();
    return;
  }
  const module = await import("./region/picker");
  module.openZoneRegion({
    address,
    slots: ownSlotOccupancy(),
    onAssign: () => {
      void openAssign().catch((error) => {
        console.error("Could not open the region assignment", error);
      });
    },
    onResolved: paintBoardRegionState,
  });
}

function openPlaceRegionPicker(): void {
  void import("./region/picker")
    .then((module) => module.openRegionPicker())
    .catch((error) => {
      console.error("Could not open the region picker", error);
    });
}

/**
 * Open the assignment picker for the first free slot. Without a settled
 * address, fall back to the old direct editor so the parent can still write.
 */
async function openAssign(): Promise<void> {
  if (!view || !ownState) return;
  const address = await ownRegionAddress();
  if (address === null) {
    const index = ownState.slots.findIndex((slot) => slot.entry === null);
    if (index !== -1) openEditor(index);
    return;
  }
  const module = await import("./region/picker");
  module.openAssignRegion({
    address,
    slots: ownSlotOccupancy(),
    onChoose: (slot) => openEditor(slot),
  });
}

/**
 * Admission handoff: the owner still chooses the free cell, but the slot
 * editor opens with the candidate already selected as its child.
 */
async function openAdmit(candidateId: string): Promise<void> {
  if (!view || !ownState) return;
  const address = await ownRegionAddress();
  if (address === null) {
    const index = ownState.slots.findIndex((slot) => slot.entry === null);
    if (index === -1) {
      throw new Error(
        "Your zone has no free slot. Clear a slot in the editor before admitting.",
      );
    }
    openEditor(index, candidateId);
    return;
  }
  const module = await import("./region/picker");
  module.openAssignRegion({
    address,
    slots: ownSlotOccupancy(),
    onChoose: (slot) => openEditor(slot, candidateId),
  });
}

/**
 * Write this zone's parent with the shared busy/repaint treatment. The parent
 * dialog and the join link's consent step both use it.
 */
async function saveOwnParent(userId: string): Promise<void> {
  if (!view) {
    throw new Error("Your zone is not loaded yet.");
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
}

/**
 * The value the parent board holds for this board, plus the parent's recent
 * issue/burn entries for the slot that names this board. A board with no parent
 * gets no band; its parent row says so instead.
 */
function resetParentValue(): void {
  parentValueBox.removeAttribute("data-state");
  parentValueTitle.textContent = RECORD_EYEBROW;
  parentValueBoard.textContent = "";
  parentValueBoard.removeAttribute("title");
  parentValueSlot.textContent = "";
  parentValueSlot.removeAttribute("title");
  parentValueState.hidden = true;
  parentValueState.textContent = "";
  parentValueState.removeAttribute("data-state");
  parentValueState.removeAttribute("title");
  parentValueFigure.hidden = true;
  parentValueAmount.textContent = "—";
  parentValueAmount.classList.remove("is-long", "is-xlong");
  parentValueUnit.textContent = "";
  parentValueUnit.hidden = true;
  parentValueChange.hidden = true;
  parentValueChange.removeAttribute("title");
  parentValueNote.textContent = "";
  parentValueNote.removeAttribute("title");
  parentValueNote.hidden = true;
  parentValueEmpty.textContent = "";
  parentValueEmpty.hidden = true;
  advancedAdjustments.hidden = true;
  parentAdjustments.hidden = true;
  parentAdjustmentsMeta.textContent = "";
  parentAdjustmentsEmpty.textContent = "";
  parentAdjustmentsEmpty.hidden = true;
  parentAdjustmentsList.replaceChildren();
}

function paintParentAmount(amount: string): void {
  parentValueFigure.hidden = false;
  parentValueAmount.textContent = amount;
  parentValueAmount.classList.toggle(
    "is-long",
    amount.length > 10 && amount.length <= 15,
  );
  parentValueAmount.classList.toggle("is-xlong", amount.length > 15);
}

function adjustmentRow(entry: Adjustment): HTMLLIElement {
  const row = createElement("li", "adjustment");
  row.title = `Recorded at slot sequence ${entry.slotSeq}.`;

  const issue = entry.delta > 0n;
  const tag = createElement("span", "adjustment-tag", issue ? "Issue" : "Burn");
  tag.dataset.dir = issue ? "issue" : "burn";

  const amount = createElement(
    "span",
    "adjustment-amount",
    formatAdjustmentDelta(entry.delta),
  );

  const copy = createElement("span", "adjustment-copy");
  copy.append(
    createElement(
      "span",
      "adjustment-after",
      `Liability ${formatCents(entry.postValue)}`,
    ),
  );

  const note = (entry.note ?? "").trim();
  if (note !== "") {
    const noteLine = createElement("span", "adjustment-note", note);
    noteLine.title = note;
    copy.append(noteLine);
  }

  row.append(tag, amount, copy);
  return row;
}

/**
 * The parent's log for one slot, newest first and bounded. A zone on the
 * previous version has no log at all, so it gets an explained empty state
 * rather than a misleading "nothing yet".
 */
function renderParentAdjustments(options: {
  state: StateV3;
  slot: number;
  slotSeq: number;
  slotValue: bigint;
  legacy: boolean;
  parentLabel: string;
}): void {
  const { state, slot, slotSeq, slotValue, legacy, parentLabel } = options;

  advancedAdjustments.hidden = false;
  parentAdjustments.hidden = false;
  if (legacy) {
    parentAdjustmentsMeta.textContent = "";
    parentAdjustmentsEmpty.textContent =
      `${parentLabel} is on the previous version, which keeps no adjustment ` +
      "log. Only the current value is shown.";
    parentAdjustmentsEmpty.hidden = false;
    return;
  }

  const entries = state.adjustments.entries.filter(
    (entry) => entry.slot === slot,
  );
  const latest = entries[entries.length - 1];
  if (latest !== undefined && slotSeq > latest.slotSeq) {
    // The log is only a hint: the slot was written again after it. Compare the
    // values so a mere unit/note edit is not reported as a payment.
    const valueMoved = slotValue !== latest.postValue;
    parentValueChange.textContent = valueMoved
      ? "Also changed by a payment since the latest adjustment."
      : "Also written after the latest adjustment; the value itself is unchanged.";
    parentValueChange.hidden = false;
    parentValueChange.title =
      "The parent's slot was written again after the latest adjustment. A " +
      "payment, or an edit that kept the value, moves the slot sequence on.";
  }

  parentAdjustments.hidden = false;
  if (entries.length === 0) {
    parentAdjustmentsMeta.textContent = "";
    parentAdjustmentsEmpty.textContent =
      `${parentLabel} has not issued or burned anything in this slot yet.`;
    parentAdjustmentsEmpty.hidden = false;
    return;
  }

  parentAdjustmentsEmpty.hidden = true;
  const recent = entries.slice(-CHILD_ADJUSTMENT_LIMIT).reverse();
  parentAdjustmentsMeta.textContent =
    entries.length > recent.length
      ? `newest first · ${recent.length} of ${entries.length}`
      : "newest first";
  parentAdjustmentsList.replaceChildren(...recent.map(adjustmentRow));
}

const RECORD_EYEBROW = "Balance";

/**
 * The record sheet holds the value recorded above and this zone's children.
 * When there is no usable parent the card is absent, so the sheet is hidden
 * unless children remain; those then take the card's rounded top edge.
 */
function updateSimpleRecordSheet(): void {
  const hasCard = !parentValueBox.hidden;
  const hasChildren = !simpleChildren.hidden;
  simpleRecordSheet.hidden = !hasCard && !hasChildren;
  simpleRecordSheet.classList.toggle(
    "record-sheet--cardless",
    !hasCard && hasChildren,
  );
}

/** The simple view mentions a parent only when there is no usable link. */
function paintParentPrompt(state: LinkState): void {
  simpleParent.hidden = false;
  parentEdit.hidden = false;
  parentEdit.disabled = busy;
  parentClear.hidden = true;

  switch (state) {
    case "root":
      simpleParentName.textContent = "No parent yet";
      simpleParentReason.textContent =
        "A parent records a value above this zone and lets payments move through it.";
      parentEdit.textContent = "Add a parent";
      break;
    case "pending":
      simpleParentName.textContent = "Parent link not confirmed";
      simpleParentReason.textContent =
        "The parent you chose has not added this zone to a slot yet.";
      parentEdit.textContent = "Fix parent link…";
      break;
    case "not-created":
      simpleParentName.textContent = "Parent not found";
      simpleParentReason.textContent =
        `The owner you chose has not opened ${APP_NAME} yet, so there is no zone to link to.`;
      parentEdit.textContent = "Fix parent link…";
      break;
    case "error":
      simpleParentName.textContent = "Parent could not be read";
      simpleParentReason.textContent =
        "The parent link could not be checked. Try again in a moment.";
      parentEdit.textContent = "Fix parent link…";
      break;
    default:
      simpleParentName.textContent = "Parent link checked";
      simpleParentReason.textContent = "";
      parentEdit.textContent = "Add a parent";
  }
}

function paintParentPromptLoading(): void {
  simpleParent.hidden = false;
  parentEdit.hidden = true;
  parentClear.hidden = true;
  simpleParentName.textContent = "Checking your parent link…";
  simpleParentReason.textContent =
    "Working out whether this zone sits under another zone.";
}

function paintSimpleCard(own: BoardSnapshot, info: LinkInfo): void {
  const parentId = own.state.parent.userId;
  if (parentId === null) {
    ownParentLinkState = "root";
    renderSimpleActions();
    parentValueBox.hidden = true;
    paintParentPrompt("root");
    updateSimpleRecordSheet();
    return;
  }

  ownParentLinkState = info.state;
  renderSimpleActions();

  if (info.state !== "linked" || info.snapshot === null) {
    parentValueBox.hidden = true;
    paintParentPrompt(info.state);
    updateSimpleRecordSheet();
    return;
  }

  parentValueBox.hidden = false;
  parentValueBox.dataset.state = "linked";
  simpleParent.hidden = true;
  parentValueTitle.textContent = RECORD_EYEBROW;
  parentValueBoard.textContent = "";
  parentValueBoard.removeAttribute("title");
  parentValueState.hidden = true;

  const value = parentValueFor(info.snapshot, own.ownerId);
  if (value === null) {
    parentValueEmpty.textContent = "No value is recorded above this zone yet.";
    parentValueEmpty.hidden = false;
    updateSimpleRecordSheet();
    return;
  }

  parentValueSlot.textContent = `zero-based slot ${value.slot}`;
  parentValueSlot.title =
    "The slot number in the parent zone. The grid's slot labels are one-based.";

  parentValueFigure.hidden = false;
  paintParentAmount(formatCents(value.entry.value));

  const unit = value.entry.unit ?? "";
  parentValueUnit.textContent = unit;
  parentValueUnit.hidden = unit === "";

  const note = value.entry.note ?? "";
  parentValueNote.textContent = note;
  parentValueNote.title = note;
  parentValueNote.hidden = note === "";

  updateSimpleRecordSheet();
  // Advanced's adjustments block is painted by renderAdvancedAdjustments; the
  // request guard keeps a late read from overwriting a newer zone.
}

/**
 * The advanced Adjustments block describes the own board. On the default
 * surface the record card above is enough; the log stays in Advanced.
 */
function renderAdvancedAdjustments(board: BoardSnapshot, request: number): void {
  const parentId = board.state.parent.userId;
  if (parentId === null) return;

  void parentLink(board, linkDeps).then((info) => {
    if (request !== parentValueRequest) return;
    if (info.state !== "linked" || info.snapshot === null) return;
    const label = ownerLabel(parentId);
    const value = parentValueFor(info.snapshot, board.ownerId);
    if (value === null) return;
    renderParentAdjustments({
      state: info.snapshot.state,
      slot: value.slot,
      slotSeq: info.snapshot.state.slots[value.slot].seq,
      slotValue: value.entry.value,
      legacy: info.snapshot.legacy,
      parentLabel: label,
    });
  });
}

function renderParentValue(): void {
  const request = ++parentValueRequest;
  resetParentValue();

  const own = ownSnapshot();
  if (own === null) {
    ownParentLinkState = null;
    parentValueBox.hidden = true;
    paintParentPromptLoading();
    updateSimpleRecordSheet();
    return;
  }

  ownParentLinkState = own.state.parent.userId === null ? "root" : null;

  if (own.state.parent.userId === null) {
    parentValueBox.hidden = true;
    paintParentPrompt("root");
  } else if (parentValueBox.hidden) {
    // First paint, or a zone that had no usable parent a moment ago: show the
    // check rather than a stale "Add a parent" button.
    paintParentPromptLoading();
  }
  updateSimpleRecordSheet();

  void parentLink(own, linkDeps).then((info) => {
    if (request !== parentValueRequest) return;
    paintSimpleCard(own, info);
  });

  renderAdvancedAdjustments(own, request);
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
    parentAdvancedEdit.hidden = true;
    parentAdvancedClear.hidden = true;
    return;
  }

  const parentId = current.state.parent.userId;

  if (parentId === null) {
    parentName.textContent = "Root";
    parentName.title = "This zone has no parent.";
    parentName.classList.add("is-root");
    parentStatus.hidden = true;
    parentNote.textContent =
      "No parent zone, so no zone holds a liability for this one.";
    parentNote.title =
      "Add a parent from the simple view to record a liability above this zone and receive payments through it.";
    parentNote.hidden = false;
    parentAdvancedEdit.hidden = true;
    parentAdvancedClear.hidden = true;
    return;
  }

  parentName.textContent = ownerLabel(parentId);
  parentName.title = parentId;
  parentName.classList.remove("is-root");
  parentStatus.hidden = false;
  parentStatus.dataset.state = "checking";
  parentStatus.textContent = "Checking…";
  parentStatus.title = "Checking the parent zone.";
  parentNote.hidden = true;
  parentAdvancedEdit.hidden = false;
  parentAdvancedClear.hidden = false;

  const board = ownSnapshot() ?? current;

  void parentLink(board, linkDeps).then((info) => {
    if (request !== parentStatusRequest || view !== current) return;
    paintBadge(parentStatus, info.state);
    parentName.textContent = ownerLabel(parentId);
    parentName.title = parentId;
    const legacyParent = info.snapshot?.legacy === true;
    parentNote.hidden = !legacyParent;
    parentNote.title = LEGACY_PARENT_TITLE;
    if (legacyParent) parentNote.textContent = LEGACY_PARENT_NOTE;
  });
}

function renderContactCount(): void {
  const count = ownContacts().length;
  contactsCount.textContent = String(count);
  contactsOpen.disabled =
    ownState === null || view === null || busy;
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
  parentEdit.disabled = busy;
  parentClear.disabled = busy;
  parentAdvancedEdit.disabled = busy;
  parentAdvancedClear.disabled = busy;
}

function setActionReason(element: HTMLElement, reason: string | null): void {
  element.textContent = reason ?? "";
  element.hidden = reason === null;
}

/**
 * The default surface's three actions. Every disabled control carries a
 * visible reason, and the reason id is already in `aria-describedby` so a
 * screen reader hears it with the control.
 */
function renderSimpleActions(): void {
  const ownBoard = view !== null && ownState !== null;
  const ready = boardStatus === "ready" || boardStatus === "offline";
  const hasParent = ownState !== null && ownState.parent.userId !== null;
  // A slot naming a child is a link: the root can pay down and receive from
  // that child. Only a board with no links at all (and so no slot anywhere)
  // cannot move value.
  const hasChildLink =
    ownState !== null && ownState.slots.some((slot) => slot.entry !== null);
  const hasAnyLink = hasParent || hasChildLink;

  let payReason: string | null = null;
  if (!ownBoard || !ready) payReason = "Waiting for your zone.";
  else if (!hasAnyLink) {
    payReason =
      "A zone with no links cannot pay yet. Add a child or set a parent first.";
  } else if (ownParentLinkState === null) {
    payReason = "Checking your parent link…";
  } else if (ownParentLinkState !== "linked" && !hasChildLink) {
    payReason =
      "A zone on the path has not confirmed its parent yet. Check your parent link.";
  } else if (paymentBlockedReason !== null) {
    payReason = paymentBlockedReason;
  }
  simplePay.disabled = payReason !== null;
  setActionReason(simplePayReason, payReason);

  const contactsReason = ownBoard ? null : "Waiting for your zone.";
  simpleContacts.disabled = contactsReason !== null;
  setActionReason(simpleContactsReason, contactsReason);

  let linkReason: string | null = null;
  if (!ownBoard) linkReason = "Waiting for your zone.";
  else if (ownIdentity === null) linkReason = "Waiting for your identity.";
  else if (!hasAnyLink) {
    linkReason =
      "A zone with no links cannot receive yet. Add a child or set a parent first.";
  } else if (
    ownReceiveAddress === null ||
    ownReceiveAddressOwner !== ownIdentity.pubkey
  ) {
    linkReason = "Checking your address…";
  } else if (ownReceiveAddress.address === null) {
    // The empty string is the root's own address and is a valid receive link.
    linkReason =
      "Your address is not settled yet, so a link would not route a payment.";
  }
  simpleReceiveLink.disabled = linkReason !== null;
  setActionReason(simpleReceiveReason, linkReason);
}

/** Paint visibility for the current view without touching history. */
function paintViewMode(): void {
  const advanced = viewMode === "advanced";
  simpleView.hidden = advanced;
  advancedView.hidden = !advanced;
  viewToggle.textContent = advanced ? "Back to the simple view" : "Advanced";
  viewToggle.setAttribute("aria-expanded", String(advanced));
}

function focusSurface(): void {
  if (viewMode === "advanced") advancedTitle.focus({ preventScroll: true });
  else boardTitle.focus({ preventScroll: true });
}

function initialViewMode(): ViewMode {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "advanced" ? "advanced" : "simple";
}

function stripViewParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("view");
  try {
    window.history.replaceState({ view: "simple" }, "", url);
  } catch {
    // Gateway shells may refuse history writes; the surface still switches.
  }
}

/**
 * Switch surfaces. Advanced is mirrored into `?view=advanced`; leaving uses
 * `history.back()` only for the entry this session pushed, so Back can never
 * bounce out of the app.
 */
function setViewMode(
  mode: ViewMode,
  options: { focus?: boolean; history?: boolean } = {},
): void {
  const focus = options.focus ?? true;
  const writeHistory = options.history ?? true;
  if (mode === viewMode) {
    if (focus) focusSurface();
    return;
  }

  viewMode = mode;
  paintViewMode();

  if (writeHistory) {
    if (mode === "advanced") {
      const url = new URL(window.location.href);
      if (url.searchParams.get("view") !== "advanced") {
        url.searchParams.set("view", "advanced");
        try {
          window.history.pushState({ view: "advanced" }, "", url);
          pushedAdvancedEntry = true;
        } catch {
          // Gateway shells may refuse history writes; the surface still opens.
        }
      }
    } else if (pushedAdvancedEntry) {
      pushedAdvancedEntry = false;
      try {
        window.history.back();
      } catch {
        stripViewParam();
      }
    } else {
      stripViewParam();
    }
  }

  if (mode === "advanced") void refreshSlotExistence();
  if (focus) focusSurface();
}

function renderAll(): void {
  ownLiveChild = null;
  ownLiveChildRequest += 1;
  renderIdentity();
  renderContractKey();
  renderBoard();
  renderWarnings();
  renderContactCount();
  renderBoardHeader();
  renderBoardAddress();
  renderParentValue();
  renderControls();
  renderParentRow();
  renderClearedSlots();
  renderSimpleActions();
  void refreshSlotExistence();
  // Async and request-guarded: a stale read never paints over a newer board.
  void renderPayments();
  renderAutoAdvance();
}

const PAYMENT_BADGES: Record<
  PaymentEntry["status"],
  { label: string; state: string }
> = {
  offered: { label: "Offered", state: "offered" },
  acted: { label: "In progress", state: "in-progress" },
  complete: { label: "Complete", state: "complete" },
  reversing: { label: "Reversing", state: "reversing" },
  reversed: { label: "Reversed", state: "reversed" },
  aborted: { label: "Stopped", state: "aborted" },
  blocked: { label: "Reversal blocked", state: "blocked" },
  superseded: { label: "Superseded", state: "superseded" },
};

/** How a signed payment failure reads in a sentence. */
const PAYMENT_FAIL_REASONS: Record<
  NonNullable<PaymentEntry["fail"]>,
  string
> = {
  negative: "a slot would go below zero",
  "no-destination": "the destination zone is missing",
  busy: "another payment was already in progress",
  refused: "a zone refused the payment",
  "address-mismatch": "a zone did not match the route",
  blocked: "a leg could not be reversed",
  superseded: "a later signed change replaced a leg",
};

const ZERO_PAYMENT_OWNER = "0".repeat(64);

/** The status area's label source: the own address book only. */
function paymentOwnerLabel(ownerId: string): string {
  return ownerLabel(ownerId);
}

function paymentAddresses(entry: PaymentEntry): string {
  return `${entry.srcAddr || "root"} → ${entry.dstAddr || "root"}`;
}

function paintPaymentStatus(display: PaymentEntry): void {
  const badge = PAYMENT_BADGES[display.status];
  paymentStatusBadge.textContent = badge.label;
  paymentStatusBadge.dataset.state = badge.state;
  paymentStatusBadge.removeAttribute("title");
  // The card and the badge both key their colour off the status.
  paymentStatus.dataset.state = badge.state;

  paymentStatusTitle.textContent =
    `${formatCents(display.amount)} along ${paymentAddresses(display)}`;

  const route = planRoute(display.srcAddr, display.dstAddr);
  // The issue/burn is the *meaning* of the single slot write: derive it from
  // the route. Nothing writes an `adjustments` entry for it.
  const implicit =
    "error" in route
      ? []
      : [
          ...(route.debitHops === 0 ? ["implicit issue"] : []),
          ...(route.creditHops === 0 ? ["implicit burn"] : []),
        ];
  const routeText =
    "error" in route
      ? paymentAddresses(display)
      : `${describeRoute(route)}${implicit.length === 0 ? "" : ` · ${implicit.join(" · ")}`}`;
  paymentStatusRoute.textContent = routeText;
  paymentStatusRoute.title = routeText;

  const fail =
    display.fail === null ? "" : PAYMENT_FAIL_REASONS[display.fail];
  let detail: string;
  if (display.status === "complete") {
    detail = "Delivered";
  } else if (display.status === "reversed") {
    detail = "The payment was undone.";
  } else if (display.status === "superseded") {
    detail = "A later signed change replaced the payment.";
  } else if (display.status === "aborted") {
    detail = fail === "" ? "The payment stopped." : `The payment stopped: ${fail}.`;
  } else if (display.status === "blocked") {
    detail =
      fail === ""
        ? "The reversal is blocked."
        : `The reversal is blocked: ${fail}.`;
  } else if (display.status === "reversing") {
    detail =
      fail === ""
        ? "The payment is being reversed."
        : `The payment is being reversed: ${fail}.`;
  } else if ("error" in route) {
    detail = `Hop ${display.cursor}`;
  } else {
    detail = `Hop ${display.cursor} of ${route.hops}`;
  }
  if (display.next !== ZERO_PAYMENT_OWNER) {
    detail += ` Waiting for ${paymentOwnerLabel(display.next)}.`;
  }
  if (
    !("error" in route) &&
    route.debitHops === 0 &&
    display.phase === "forward" &&
    (display.status === "offered" || display.status === "acted")
  ) {
    // Known accepted risk: a downward-only payment issues before the payee
    // consents. Make the stalled state visible instead of leaving it implicit.
    detail +=
      " Issued, not delivered: the credit stays in your slot until you withdraw it or the next zone signs.";
  }
  paymentStatusDetail.textContent = detail;
  paymentStatus.hidden = false;
}

/**
 * The progressed view is settled but this board's own record is still a
 * non-terminal payment it did not source. Painting "Complete" here hides the
 * fact that the board cannot sign anything until the record is cleared.
 */
function paintStuckPayment(entry: PaymentEntry, display: PaymentEntry): void {
  const detail = `A later copy of this payment is ${display.status}, but this zone's own record is still pending. Clear it to continue.`;
  paymentStatusBadge.textContent = "Stuck";
  paymentStatusBadge.dataset.state = "stuck";
  paymentStatusBadge.title = `${detail} The delegate reports Busy for this zone until the record is cleared.`;
  paymentStatus.dataset.state = "stuck";
  paymentStatusTitle.textContent = `${formatCents(entry.amount)} along ${paymentAddresses(entry)}`;
  const route = planRoute(entry.srcAddr, entry.dstAddr);
  const routeText =
    "error" in route ? paymentAddresses(entry) : describeRoute(route);
  paymentStatusRoute.textContent = routeText;
  paymentStatusRoute.title = routeText;
  paymentStatusDetail.textContent = detail;
  paymentStatus.hidden = false;
}

function paymentInboxStatus(entry: PaymentEntry): string {
  const leg = entry.phase === "reverse" ? "Reverse leg" : "Forward leg";
  return entry.fail === null
    ? leg
    : `${leg} · ${PAYMENT_FAIL_REASONS[entry.fail]}`;
}

function renderPaymentInboxItem(item: IncomingPayment): HTMLLIElement {
  const li = createElement("li", "payment-inbox-item");
  const head = createElement("div", "payment-inbox-head");
  const amount = createElement(
    "span",
    "payment-inbox-amount",
    formatCents(item.entry.amount),
  );
  const status = createElement(
    "span",
    "payment-inbox-status",
    paymentInboxStatus(item.entry),
  );
  head.append(amount, status);

  // Payment counterparties are named from this device's private address book;
  // v6 has no public contact list to fall back to.
  const srcLabel = ownerLabel(item.entry.src);
  const dstLabel = ownerLabel(item.entry.dst);
  const meta = createElement(
    "p",
    "payment-inbox-meta",
    `${srcLabel} → ${dstLabel}`,
  );

  const route = planRoute(item.entry.srcAddr, item.entry.dstAddr);
  const routeText =
    "error" in route ? paymentAddresses(item.entry) : describeRoute(route);
  const routeLine = createElement("p", "payment-inbox-route", routeText);
  routeLine.title = routeText;

  const actions = createElement("div", "payment-inbox-actions");
  const advance = createElement(
    "button",
    "payment-advance",
    item.entry.phase === "reverse" ? "Undo my leg" : "Sign my leg",
  );
  advance.type = "button";
  advance.addEventListener("click", () => {
    void advanceIncomingPayment(advance, item);
  });
  actions.append(advance);

  li.append(head, meta, routeLine, actions);
  return li;
}

async function advanceIncomingPayment(
  button: HTMLButtonElement,
  item: IncomingPayment,
): Promise<void> {
  const own = ownSnapshot();
  if (own === null) {
    showNotice("error", "Could not advance payment", "Your zone is not loaded yet.");
    return;
  }

  button.disabled = true;
  try {
    await advancePayment(own, item.from, item.entry, paymentDeps);
    // The next inbox/status read must see the other boards' fresh records.
    boardCache.clear();
    showNotice(
      "info",
      "Payment advanced",
      item.entry.phase === "reverse"
        ? "Your leg was undone. The previous zone is asked to undo theirs."
        : "Your leg was signed. The next zone is asked to sign theirs.",
    );
    renderAll();
  } catch (error) {
    button.disabled = false;
    showNotice("error", "Could not advance payment", errorMessage(error));
  }
}

/**
 * Paint the own board's payment status and inbox. Reads are asynchronous, so a
 * late result is dropped unless it still belongs to the current request/board.
 */
async function renderPayments(): Promise<void> {
  const request = ++paymentsRequest;
  const current = view;
  const ready = boardStatus === "ready" || boardStatus === "offline";

  if (!current || !ready) {
    paymentsSection.hidden = true;
    paymentStatus.hidden = true;
    paymentInbox.hidden = true;
    paymentEmpty.hidden = true;
    paymentWithdraw.hidden = true;
    paymentClear.hidden = true;
    simplePaymentWaiting.hidden = true;
    paymentInboxList.replaceChildren();
    paymentBlockedReason = "Waiting for your zone.";
    renderSimpleActions();
    return;
  }

  paymentsSection.hidden = false;
  const own = ownSnapshot() ?? current;
  const entry = own.state.payments.entry;

  let display = entry;
  if (entry !== null) {
    try {
      display = await paymentProgress(own, entry, paymentDeps);
    } catch (error) {
      if (request !== paymentsRequest || view !== current) return;
      console.warn(`Could not read payment progress: ${errorMessage(error)}`);
      display = entry;
    }
    if (request !== paymentsRequest || view !== current) return;
  }

  // A settled payment (complete/reversed/blocked/superseded) no longer blocks a
  // new one, even though the source's own copy may still be the offered record.
  const active = display !== null && display.phase !== "terminal";
  const stuck = isStuckForeignRecord(entry, display, own.ownerId);
  const route = entry === null ? null : planRoute(entry.srcAddr, entry.dstAddr);
  // A `dS = 0` source acts at cursor 1, so withdrawal must still be offered
  // while nothing downstream has advanced past that step.
  const canWithdraw =
    entry !== null &&
    entry.src === own.ownerId &&
    display !== null &&
    display.phase !== "terminal" &&
    (display.cursor === 0 ||
      (route !== null &&
        !("error" in route) &&
        route.debitHops === 0 &&
        display.cursor === 1));
  paymentWithdraw.hidden = !canWithdraw;
  paymentWithdraw.disabled = busy;
  // Clearing is only for a foreign record stuck behind a settled network copy.
  // The source's own record is closed by withdrawing it (which restores a
  // `dS = 0` issue instead of stranding the credit).
  const canClear =
    entry !== null &&
    entry.phase !== "terminal" &&
    entry.src !== own.ownerId &&
    typeof backend.clearStuckPayment === "function";
  paymentClear.hidden = !canClear;
  paymentClear.disabled = busy;
  paymentClear.title = stuck
    ? "Clear this zone's stuck payment record; the network copy is already settled."
    : "Clear this zone's payment record.";
  paymentBlockedReason =
    active || stuck
      ? "A payment is already in progress. Review it under Advanced."
      : null;
  renderSimpleActions();
  // Refreshing the inbox is read-only; never lock it behind an in-flight
  // write. Clicking it clears the cache and repaints.
  paymentCheck.disabled = false;
  paymentCheck.title = "Refresh the payment status and inbox.";

  if (display === null) paymentStatus.hidden = true;
  else if (stuck && entry !== null) paintStuckPayment(entry, display);
  else paintPaymentStatus(display);

  let incoming: IncomingPayment[];
  try {
    incoming = await findIncoming(own, paymentDeps);
  } catch (error) {
    if (request !== paymentsRequest || view !== current) return;
    console.warn(`Could not read incoming payments: ${errorMessage(error)}`);
    paymentInbox.hidden = true;
    simplePaymentWaiting.hidden = true;
    paymentInboxList.replaceChildren();
    paymentEmpty.hidden = display !== null;
    return;
  }
  if (request !== paymentsRequest || view !== current) return;

  paymentInboxList.replaceChildren(
    ...incoming.map((item) => renderPaymentInboxItem(item)),
  );
  paymentInbox.hidden = incoming.length === 0;
  simplePaymentWaiting.hidden = incoming.length === 0;
  paymentEmpty.hidden = display !== null || incoming.length > 0;
}

/* Background payments (delegate auto-advance) ----------------------------- */

const AUTO_ADVANCE_AUDIT_LIMIT = 5;

/**
 * The only place this file touches the backend's auto-advance members. The
 * optional methods are the parallel delegate lane's interface; a backend
 * without them degrades to an unavailable status instead of failing.
 */
function createDelegateControls(source: BoardBackend) {
  return {
    get available(): boolean {
      // The offline mock only exposes a delegate when a test seeds one.
      if (isOffline) return source.delegateStatus != null;
      return (
        typeof source.refreshDelegateStatus === "function" ||
        typeof source.setAutoAdvance === "function" ||
        source.delegateStatus !== undefined
      );
    },
    get controllable(): boolean {
      return typeof source.setAutoAdvance === "function";
    },
    async refresh(): Promise<DelegateStatus | null> {
      if (typeof source.refreshDelegateStatus !== "function") {
        return source.delegateStatus ?? delegateStatusFromCallback;
      }
      return (
        (await source.refreshDelegateStatus()) ??
        source.delegateStatus ??
        delegateStatusFromCallback
      );
    },
    async setAutoAdvance(enabled: boolean, maxAmount: number): Promise<void> {
      if (typeof source.setAutoAdvance !== "function") {
        throw new Error("This build cannot change background payments.");
      }
      await source.setAutoAdvance(enabled, maxAmount);
    },
  };
}

/**
 * `lastScan` is a count of completed scan passes, not a wall-clock time.
 */
function formatScanCount(value: number | null): { text: string; title: string } {
  if (value === null) return { text: "—", title: "No scan reported." };
  if (value <= 0) {
    return { text: "Not yet", title: "No scan pass has completed." };
  }
  const count = Math.trunc(value);
  return {
    text: `pass ${count.toLocaleString()}`,
    title: `${count.toLocaleString()} scan pass${count === 1 ? "" : "es"} since the component started.`,
  };
}

const DELEGATE_ERROR_TEXT: Record<string, string> = {
  "mixed-version":
    "a zone on this route uses a different version, so that payment was skipped",
  "auto-advance-disabled": "auto-advance is off in the local component",
  "address-mismatch":
    "the local component's owner address did not match the zone it read",
  "destination-unknown":
    "the destination zone could not be read, so the payment was skipped",
  "update-failed": "the node did not confirm the signed change",
  "network budget exhausted":
    "this scan used its network requests, so it will try again on the next wake",
  "not configured: send configure first":
    "the local component is not set up yet",
};

function autoAdvanceErrorText(value: string): string {
  return DELEGATE_ERROR_TEXT[value] ?? value;
}

function autoAdvanceMaxText(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "";
  return formatCents(BigInt(Math.trunc(value)));
}

/**
 * The audit entry carries the payment id, not the amount. When that payment is
 * still the board's current record and the step touched one slot, show its
 * amount with the leg's direction. Older, multi-slot, or superseded steps keep
 * just the id, leg, slot, and role.
 */
function formatAuditAmount(amount: bigint, role: string): string | null {
  if (role !== "debit" && role !== "credit") return null;
  const magnitude = amount < 0n ? -amount : amount;
  const signed = role === "debit" ? -magnitude : magnitude;
  const text = formatCents(signed);
  if (role === "credit" && signed >= 0n) return `+${text}`;
  return text.replace("-", "−");
}

function setAutoAdvanceFact(element: HTMLElement, text: string, title = ""): void {
  element.textContent = text;
  if (title === "") element.removeAttribute("title");
  else element.title = title;
}

/**
 * Refresh whether this board has a live child. Only called when the delegate
 * is configured and enabled but has never scanned, so a healthy node pays
 * nothing for it. A stale reply is dropped if the board changed meanwhile.
 */
async function refreshOwnLiveChild(): Promise<void> {
  const own = ownSnapshot();
  if (own === null) return;
  const request = ++ownLiveChildRequest;
  const live = await hasLiveChild(own, linkDeps);
  if (request !== ownLiveChildRequest) return;
  ownLiveChild = live;
  renderAutoAdvance();
}

/**
 * Auto-advance is operationally active only when the component is configured,
 * the switch is on, and a scan has actually completed. `lastScan` is the
 * available proxy for the node having granted background permission.
 */
function autoAdvanceIsActive(status: DelegateStatus | null): boolean {
  return (
    status !== null &&
    status.configured &&
    status.autoAdvance &&
    status.lastScan > 0
  );
}

function renderAutoAdvance(): void {
  const status = autoAdvanceStatus;
  const available = delegateControls.available;
  const online = boardStatus === "ready" || (isOffline && available);
  const controllable = delegateControls.controllable;
  const active = autoAdvanceIsActive(status);
  const neverScanned = status !== null && delegateNeverScanned(status);
  if (neverScanned && ownLiveChild === null) void refreshOwnLiveChild();

  paymentCheck.hidden = active;
  paymentNote.textContent = active
    ? "Your node signs your part as it arrives."
    : "Payments move one zone at a time. Each owner opens their zone to sign their leg.";
  paymentAutoNote.hidden = !active;

  let reason: string | null = null;
  if (!available) {
    reason = isOffline
      ? "The offline preview has no local component, so background payments are unavailable here."
      : "This build cannot read the local component's payment status, so these controls are off.";
  } else if (!online) {
    reason =
      boardStatus === "disconnected"
        ? "Reconnect to this node to change background payments."
        : "Background payments are available once this node is connected.";
  } else if (status === null) {
    reason =
      autoAdvanceRefreshError === null
        ? "The local component has not reported a status yet."
        : `Could not read the status: ${autoAdvanceRefreshError}`;
  } else if (!status.configured) {
    reason =
      "The local component is not set up for this zone, so it has nothing to advance. It is configured when your own zone opens on this node with the current component.";
  } else if (!controllable) {
    reason =
      "This build can show background payments but cannot change them.";
  }

  const canEdit =
    reason === null &&
    status !== null &&
    status.configured &&
    !autoAdvanceSaving;
  autoAdvanceToggle.disabled = !canEdit;
  autoAdvanceMax.disabled = !canEdit;
  autoAdvanceSave.disabled = !canEdit;
  autoAdvanceSave.textContent = autoAdvanceSaving
    ? "Saving…"
    : autoAdvanceDirty
      ? "Save changes"
      : "Save";
  if (autoAdvanceSaving) autoAdvanceForm.setAttribute("aria-busy", "true");
  else autoAdvanceForm.removeAttribute("aria-busy");

  autoAdvanceReason.hidden = reason === null;
  autoAdvanceReason.textContent = reason ?? "";
  autoAdvanceReason.dataset.tone =
    status === null && autoAdvanceRefreshError !== null ? "warning" : "muted";

  autoAdvanceRefresh.disabled =
    !available || autoAdvanceRefreshing || autoAdvanceSaving;
  autoAdvanceRefresh.title = autoAdvanceRefreshing
    ? "Refreshing…"
    : autoAdvanceRefresh.disabled
      ? (reason ?? "Status cannot be refreshed right now.")
      : "Ask the local component for its current status.";

  let badgeLabel = "Checking…";
  let badgeState = "checking";
  let badgeTitle = "Waiting for the local component.";
  if (!available) {
    badgeLabel = "Unavailable";
    badgeState = "unavailable";
    badgeTitle = isOffline
      ? "The offline preview does not run the local component."
      : "This build has no background payment status.";
  } else if (!autoAdvanceStatusReceived) {
    badgeTitle = "No status has arrived yet.";
  } else if (status === null) {
    badgeLabel = "Unavailable";
    badgeState = "unavailable";
    badgeTitle = autoAdvanceRefreshError ?? "The local component did not report a status.";
  } else if (!status.configured) {
    badgeLabel = "Not set up";
    badgeState = "not-configured";
    badgeTitle = "The local component has no owner address for this zone.";
  } else if (neverScanned) {
    badgeLabel = ownLiveChild === true ? "Not advancing" : "No scans";
    badgeState = "stale";
    badgeTitle =
      ownLiveChild === true
        ? "This zone has a live child, so payments can route through it, but this node is not auto-advancing. Reinstall the component so the node asks for background permission."
        : "The component is configured but no scan has run. If this lasts more than a minute, this node has not granted background permission; reinstall the component so the node asks again.";
  } else if (isDelegateStatusStale(status, BOARD_CONFIG.contractCodeHash)) {
    badgeLabel = "Stale";
    badgeState = "stale";
    badgeTitle =
      "The component's contract build does not match this zone, so it cannot find this zone's payments.";
  } else if (status.autoAdvance) {
    badgeLabel = "On";
    badgeState = "on";
    badgeTitle =
      "The component may sign the next leg while this node runs. It can take minutes and is not a guarantee.";
  } else {
    badgeLabel = "Off";
    badgeState = "off";
    badgeTitle = "Auto-advance is off; each leg waits for its owner.";
  }
  autoAdvanceBadge.textContent = badgeLabel;
  autoAdvanceBadge.dataset.state = badgeState;
  autoAdvanceBadge.title = badgeTitle;

  if (!autoAdvanceDirty && status !== null) {
    autoAdvanceToggle.checked = status.autoAdvance;
    const nextMax = autoAdvanceMaxText(status.maxAmount);
    if (autoAdvanceMax.value !== nextMax) autoAdvanceMax.value = nextMax;
  }

  setAutoAdvanceFact(
    autoAdvanceState,
    status === null
      ? autoAdvanceStatusReceived
        ? "Not reported"
        : "Checking…"
      : status.configured
        ? neverScanned
          ? "Configured, no scans"
          : "Configured"
        : "Not configured",
    neverScanned
      ? "No scan has run. If this lasts more than a minute, the node has not granted background permission."
      : "",
  );

  if (status !== null && status.matchedCodeHash !== null) {
    setAutoAdvanceFact(
      autoAdvanceHash,
      shorten(status.matchedCodeHash, 6, 4),
      status.matchedCodeHash,
    );
  } else {
    setAutoAdvanceFact(
      autoAdvanceHash,
      "—",
      status?.configured
        ? "The local component did not report a matching code hash."
        : "",
    );
  }

  if (status !== null && status.address !== null) {
    const address = status.address === "" ? "root" : status.address;
    setAutoAdvanceFact(
      autoAdvanceAddress,
      address,
      status.address === ""
        ? "This zone is a root (empty octal address)."
        : `Octal address ${status.address}`,
    );
  } else {
    setAutoAdvanceFact(autoAdvanceAddress, "—");
  }

  const scan = formatScanCount(status === null ? null : status.lastScan);
  setAutoAdvanceFact(
    autoAdvanceScan,
    scan.text,
    neverScanned
      ? "No scan pass has completed. Background permission may not be granted."
      : scan.title,
  );

  if (status === null) {
    setAutoAdvanceFact(autoAdvanceSubs, "—");
  } else {
    const count = status.subscriptions.length;
    setAutoAdvanceFact(
      autoAdvanceSubs,
      count === 0 ? "None yet" : `${count} zone${count === 1 ? "" : "s"}`,
      count === 0
        ? "No zone subscriptions reported."
        : `Subscribed to ${count} zone instance${count === 1 ? "" : "s"}.`,
    );
  }

  const stale =
    status !== null &&
    isDelegateStatusStale(status, BOARD_CONFIG.contractCodeHash);
  autoAdvanceStale.hidden = !stale;
  autoAdvanceStale.textContent = stale
    ? "The local component's contract build does not match this zone. It cannot see this zone's payments, so enabling auto-advance will not move anything until both are on the same build."
    : "";
  const routeAlert =
    neverScanned && ownLiveChild === true
      ? "This zone can carry payments but won't auto-advance on this node. Reinstall the component so the node asks for background permission."
      : "";
  autoAdvanceRouteAlert.hidden = routeAlert === "";
  autoAdvanceRouteAlert.textContent = routeAlert;
  const attention = stale || routeAlert !== "";
  detailsAttention.hidden = !attention;
  if (attention) {
    detailsSummary.setAttribute(
      "aria-label",
      "Details, background payments need attention",
    );
    detailsSummary.title = stale
      ? "Background payments are using a different contract build than this zone."
      : "A zone with a live child cannot auto-advance on this node.";
  } else {
    detailsSummary.removeAttribute("aria-label");
    detailsSummary.removeAttribute("title");
  }

  const lastError = status === null ? null : status.lastError;
  autoAdvanceLastError.hidden = lastError === null;
  if (lastError !== null) {
    autoAdvanceLastError.textContent = `Last problem: ${autoAdvanceErrorText(lastError)}`;
    autoAdvanceLastError.title = lastError;
  } else {
    autoAdvanceLastError.textContent = "";
    autoAdvanceLastError.removeAttribute("title");
  }

  const actions =
    status === null
      ? []
      : status.audit.slice(-AUTO_ADVANCE_AUDIT_LIMIT).reverse();
  const activePayment = ownState?.payments.entry ?? null;
  autoAdvanceAudit.replaceChildren();
  for (const action of actions) {
    const item = document.createElement("li");
    item.className = "auto-advance-audit-item";

    const label = document.createElement("span");
    label.className = "auto-advance-audit-text";
    if (action.id === "") {
      label.append(document.createTextNode("Advanced a payment"));
    } else {
      label.append(document.createTextNode("Advanced payment "));
      const code = document.createElement("code");
      code.textContent = shorten(action.id, 4, 4);
      code.title = action.id;
      label.append(code);
    }

    const details: string[] = [`leg ${action.cursor}`];
    if (action.slots.length === 1) {
      details.push(`slot ${action.slots[0]}`);
    } else if (action.slots.length > 1) {
      details.push(`slots ${action.slots.join(", ")}`);
    }
    const amount =
      activePayment !== null &&
      activePayment.id === action.id &&
      action.slots.length === 1
        ? formatAuditAmount(activePayment.amount, action.role)
        : null;
    if (amount !== null) details.push(amount);
    else if (action.role !== "") details.push(action.role);
    label.append(document.createTextNode(`, ${details.join(", ")}`));

    if (action.role !== "") {
      item.title =
        action.role === "debit"
          ? "A debit on this zone."
          : action.role === "credit"
            ? "A credit on this zone."
            : action.role;
    }

    item.append(label);
    autoAdvanceAudit.append(item);
  }

  autoAdvanceAudit.hidden = actions.length === 0;
  autoAdvanceAuditEmpty.hidden = actions.length > 0;
  autoAdvanceAuditEmpty.textContent =
    status === null
      ? "No status from the local component yet."
      : "No advances yet. An entry appears here after the component signs a leg.";
}

async function refreshAutoAdvanceStatus(announceResult = false): Promise<void> {
  if (!delegateControls.available) {
    autoAdvanceStatusReceived = true;
    autoAdvanceRefreshError = null;
    autoAdvanceStatus = null;
    renderAutoAdvance();
    if (announceResult) {
      announce(
        isOffline
          ? "Background payment status is unavailable in the offline preview."
          : "This build has no background payment status.",
      );
    }
    return;
  }

  const request = ++autoAdvanceRefreshRequest;
  autoAdvanceRefreshing = true;
  renderAutoAdvance();
  try {
    const next = await delegateControls.refresh();
    if (request !== autoAdvanceRefreshRequest) return;
    autoAdvanceStatusReceived = true;
    autoAdvanceRefreshError = null;
    autoAdvanceStatus = next;
    if (announceResult) {
      announce(
        next === null
          ? "The local component did not report a background payment status."
          : "Background payment status checked.",
      );
    }
  } catch (error) {
    if (request !== autoAdvanceRefreshRequest) return;
    autoAdvanceStatusReceived = true;
    autoAdvanceStatus = null;
    autoAdvanceRefreshError = errorMessage(error);
    if (announceResult) {
      announce(
        `Could not read background payment status: ${autoAdvanceRefreshError}`,
      );
    }
  } finally {
    if (request === autoAdvanceRefreshRequest) {
      autoAdvanceRefreshing = false;
      renderAutoAdvance();
    }
  }
}

function showAutoAdvanceMaxWarning(message: string): void {
  autoAdvanceMaxWarning.textContent = message;
  autoAdvanceMaxWarning.hidden = false;
  autoAdvanceMax.setAttribute("aria-invalid", "true");
  autoAdvanceMax.focus();
}

function clearAutoAdvanceMaxWarning(): void {
  if (autoAdvanceMaxWarning.hidden) return;
  autoAdvanceMaxWarning.hidden = true;
  autoAdvanceMaxWarning.textContent = "";
  autoAdvanceMax.removeAttribute("aria-invalid");
}

async function handleAutoAdvanceSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (autoAdvanceSaving) return;

  const status = autoAdvanceStatus;
  if (
    status === null ||
    !status.configured ||
    !delegateControls.controllable ||
    boardStatus !== "ready" ||
    isOffline
  ) {
    renderAutoAdvance();
    return;
  }

  autoAdvanceMaxWarning.hidden = true;
  autoAdvanceMaxWarning.textContent = "";
  autoAdvanceMax.removeAttribute("aria-invalid");
  autoAdvanceError.hidden = true;
  autoAdvanceError.textContent = "";

  let cents: bigint;
  try {
    if (autoAdvanceMax.value.trim() === "") {
      throw new Error("Enter an amount, or 0 to remove the cap.");
    }
    cents = parseCents(autoAdvanceMax.value);
  } catch (error) {
    showAutoAdvanceMaxWarning(errorMessage(error));
    return;
  }
  if (cents < 0n) {
    showAutoAdvanceMaxWarning("Enter zero or a positive amount.");
    return;
  }
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    showAutoAdvanceMaxWarning("That amount is too large.");
    return;
  }

  const enabled = autoAdvanceToggle.checked;
  const maxAmount = Number(cents);
  autoAdvanceSaving = true;
  renderAutoAdvance();

  try {
    await delegateControls.setAutoAdvance(enabled, maxAmount);
    autoAdvanceDirty = false;
    if (autoAdvanceStatus !== null) {
      autoAdvanceStatus = { ...autoAdvanceStatus, autoAdvance: enabled, maxAmount };
    }
    announce(
      `Background payments saved. Auto-advance is ${enabled ? "on" : "off"} with a maximum of ${formatCents(cents)} per payment.`,
    );
    void refreshAutoAdvanceStatus();
  } catch (error) {
    autoAdvanceDirty = true;
    autoAdvanceError.textContent = errorMessage(error);
    autoAdvanceError.hidden = false;
    announce(`Could not save background payments: ${errorMessage(error)}`);
  } finally {
    autoAdvanceSaving = false;
    renderAutoAdvance();
  }
}

function clearPaymentMessages(): void {
  paymentWarning.hidden = true;
  paymentWarning.textContent = "";
  paymentError.hidden = true;
  paymentError.textContent = "";
  paymentAddress.removeAttribute("aria-invalid");
  paymentUser.removeAttribute("aria-invalid");
  paymentAmount.removeAttribute("aria-invalid");
}

function showPaymentWarning(
  message: string,
  focus: HTMLInputElement | null = null,
): void {
  paymentWarning.textContent = message;
  paymentWarning.hidden = false;
  paymentError.hidden = true;
  paymentError.textContent = "";
  if (focus !== null) {
    focus.setAttribute("aria-invalid", "true");
    focus.focus();
  }
}

function showPaymentError(message: string): void {
  paymentError.textContent = message;
  paymentError.hidden = false;
  paymentWarning.hidden = true;
  paymentWarning.textContent = "";
}

function paymentProblemMessage(failure: PaymentFailure): string {
  switch (failure.problem) {
    case "negative":
      return "A slot on the route would go below 0.00. Nothing was signed.";
    case "address-mismatch":
      return "The user id does not own the zone at that address.";
    case "busy":
      return "This zone already has a payment in progress.";
    case "no-destination":
      return "There is no zone at that address.";
    case "pending":
      return `A zone on the path has not confirmed its parent yet. ${failure.detail}`;
    case "not-created":
      return `A zone on the path has not been created yet. ${failure.detail}`;
    case "legacy":
      return `A zone on the path is still on the previous version; its owner must open the new app once. ${failure.detail}`;
    case "invalid-address":
      return "Use only digits 0–7 for the octal address.";
    case "overflow":
      return "The destination slot cannot hold that amount.";
    default:
      return failure.detail;
  }
}

function selectedPaymentContact(): ContactRecord | null {
  const userId = paymentRecipient.value;
  if (userId === "") return null;
  return ownContacts().find((contact) => contact.userId === userId) ?? null;
}

/** Paint the selected contact's stored address, without reading their board. */
function updatePaymentRecipient(): void {
  const contact = selectedPaymentContact();
  let line = "";
  if (contact !== null) {
    line =
      ownIdentity !== null && contact.userId === ownIdentity.pubkey
        ? "That is your own zone. Choose someone else."
        : contact.address === null
          ? recipientAddressLine(null)
          : contact.address === ""
            ? "Root address"
            : recipientAddressLine(contact.address);
  }
  paymentRecipientStatus.textContent = line;
  paymentRecipientStatus.hidden = line === "";
  refreshPaymentSubmit();
}

/** Keep the submit state honest: a contact needs an address, not this board. */
function refreshPaymentSubmit(): void {
  if (paymentBusy) {
    paymentSubmit.disabled = true;
    return;
  }
  const contact = selectedPaymentContact();
  let blocked = false;
  let title = "";
  if (contact !== null) {
    if (ownIdentity !== null && contact.userId === ownIdentity.pubkey) {
      blocked = true;
      title = "Choose a contact other than this zone.";
    } else if (contact.address === null) {
      blocked = true;
      title = "That contact has no address yet. Ask them for a receive link.";
    }
  } else {
    const address = paymentAddress.value.trim();
    const user = paymentUser.value.trim();
    if (!/^[0-9a-f]{64}$/i.test(user)) {
      blocked = true;
      title = "Enter the recipient's 64-character user id.";
    } else if (address !== "" && !isOctalAddress(address)) {
      blocked = true;
      title = "Use digits 0–7 only for the octal address (empty is the root).";
    }
  }
  paymentSubmit.disabled = blocked;
  paymentSubmit.title = title;
}

function populatePaymentRecipients(selectedUserId: string): void {
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Choose someone…";
  const options = [blank];
  for (const contact of ownContacts()) {
    const option = document.createElement("option");
    option.value = contact.userId;
    option.textContent = contact.label;
    option.title = contact.userId;
    options.push(option);
  }
  paymentRecipient.replaceChildren(...options);
  const known = ownContacts().some(
    (contact) => contact.userId === selectedUserId,
  );
  paymentRecipient.value = known ? selectedUserId : "";
  updatePaymentRecipient();
}

function openPaymentDialog(): void {
  if (paymentDialog.open) return;
  paymentForm.reset();
  paymentDirect.open = false;
  clearPaymentMessages();
  paymentBusy = false;
  paymentSubmit.textContent = PAYMENT_SUBMIT_LABEL;
  populatePaymentRecipients("");
  paymentDialog.showModal();
  paymentRecipient.focus();
}

function closePaymentDialog(): void {
  if (paymentDialog.open) paymentDialog.close();
}

async function handlePaymentSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  clearPaymentMessages();

  const contact = selectedPaymentContact();
  let address: string;
  let user: string;
  if (contact !== null) {
    if (ownIdentity !== null && contact.userId === ownIdentity.pubkey) {
      showPaymentWarning("That is your own zone. Choose someone else.");
      return;
    }
    if (contact.address === null) {
      showPaymentWarning(
        "That contact has no address yet. Ask them for a receive link.",
      );
      return;
    }
    address = contact.address;
    user = contact.userId;
  } else {
    // The empty address is the root; it is a valid destination and source.
    address = paymentAddress.value.trim();
    if (address !== "" && !isOctalAddress(address)) {
      showPaymentWarning(
        "Use only digits 0–7 for the octal address (empty is the root).",
        paymentAddress,
      );
      return;
    }

    user = paymentUser.value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(user)) {
      showPaymentWarning(
        "The user id must be 64 hexadecimal characters.",
        paymentUser,
      );
      return;
    }
  }

  let amount: bigint;
  try {
    amount = parseCents(paymentAmount.value);
  } catch (error) {
    showPaymentWarning(errorMessage(error), paymentAmount);
    return;
  }
  if (amount <= 0n) {
    showPaymentWarning("Enter an amount greater than zero.", paymentAmount);
    return;
  }

  const own = ownSnapshot();
  if (own === null) {
    showPaymentError("Your zone is not loaded yet.");
    return;
  }

  paymentBusy = true;
  paymentSubmit.disabled = true;
  paymentSubmit.textContent = "Checking…";
  paymentForm.setAttribute("aria-busy", "true");
  paymentWarning.textContent = "Checking the route…";
  paymentWarning.hidden = false;
  paymentError.hidden = true;
  paymentError.textContent = "";

  try {
    const plan = await planPayment(own, address, user, amount, paymentDeps);
    if ("ok" in plan) {
      showPaymentError(paymentProblemMessage(plan));
      return;
    }

    const sourceSeq = Math.max(
      own.state.payments.seq + 1,
      ownIdentity?.paymentsNextSeq ?? 1,
    );
    const intent = createPaymentIntent(plan, sourceSeq);
    // A `dS = 0` source publishes the intent already carrying its single leg
    // (the implicit issue) in the same delta.
    await backend.savePayment(intent, plan.sourceStep?.slots ?? []);
    const terminal = intent.phase === "terminal";

    // The just-signed intent lives on this board; drop cached neighbour reads
    // so the next status/inbox pass sees the new record.
    boardCache.clear();
    closePaymentDialog();
    hideErrorNotice();
    showNotice(
      "info",
      terminal ? "Payment sent" : "Payment offered",
      terminal
        ? "The destination was credited in the same step."
        : "Each owner on the path must open their zone to sign their leg.",
    );
    announce(terminal ? "Payment sent." : "Payment offered.");
    renderAll();
  } catch (error) {
    showPaymentError(errorMessage(error));
  } finally {
    paymentBusy = false;
    paymentSubmit.textContent = PAYMENT_SUBMIT_LABEL;
    paymentForm.removeAttribute("aria-busy");
    refreshPaymentSubmit();
  }
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
  starting: "Preparing the zone",
  connecting: "Opening the zone",
  identity: "Waiting for the delegate",
  ready: "Live zone",
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
  // The payment panel depends on the ready state; a status transition must
  // repaint it even when no state/identity callback follows.
  void renderPayments();
  renderAutoAdvance();
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

  if (next === "ready" && previous !== "ready") {
    void refreshAutoAdvanceStatus();
  }
  tryOpenReceiveLink();
  tryOpenRoomLink();
  tryOpenRootLink();

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
  let title = "Could not open the zone";

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
  contactSelect.disabled = value;
  contactAdd.disabled = value;
  unitInput.disabled = value;
  noteInput.disabled = value;
  cancelButton.disabled = value;
  editorClose.disabled = value;
  clearButton.disabled =
    value || !ownState || ownState.slots[currentSlot].entry === null;
  saveButton.textContent = value ? "Saving…" : "Save details";
  editorForm.setAttribute("aria-busy", String(value));
  saveButton.setAttribute("aria-busy", String(value));
  renderAdjust();
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

function contactOption(contact: ContactRecord): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = contact.userId;
  option.textContent = `${contact.label} · ${shortUserId(contact.userId)}`;
  option.title = contact.userId;
  return option;
}

function populateContactOptions(
  selectedUserId: string,
  extra?: ContactRecord,
): void {
  const entries = ownContacts();
  const known = new Set<string>();
  const options: HTMLOptionElement[] = [];

  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Select a contact…";
  options.push(blank);

  const add = (contact: ContactRecord, admission = false): void => {
    if (known.has(contact.userId)) return;
    known.add(contact.userId);
    const option = contactOption(contact);
    if (admission) {
      // An admission handoff's candidate is not an address-book contact yet.
      option.dataset.admission = "true";
      option.textContent = `Requester · ${shortUserId(contact.userId)}`;
    }
    options.push(option);
  };

  for (const contact of entries) add(contact);
  if (extra) add(extra);
  if (editorPrefillContact) add(editorPrefillContact, true);

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
    // The offline harness can only ask to join its own zone, so admission there
    // would prefill this zone as its own child. A deployed zone still cannot
    // name itself; keep that rejection outside offline mode.
    if (isOffline && editorPrefillContact?.userId === contact) return null;
    return "A slot's child must be a different zone. Choose another contact.";
  }
  const otherIndex =
    ownState?.slots.findIndex(
      (slot, index) => index !== currentSlot && slot.entry?.contact === contact,
    ) ?? -1;
  if (otherIndex !== -1) {
    return `That zone is already in slot ${otherIndex + 1}. Each child can use only one slot.`;
  }
  return null;
}

function updateContactState(): void {
  const entries = ownContacts();
  const selected = contactSelect.value;
  const selectedOption = contactSelect.selectedOptions[0];
  const known =
    selected !== "" &&
    (entries.some((contact) => contact.userId === selected) ||
      selectedOption?.dataset.admission === "true");

  let hint = "";
  let invalid = false;
  if (entries.length === 0 && !known) {
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

  if (contactId === null) {
    childLinkBox.hidden = true;
    childLinkDetail.hidden = true;
    childLinkDetail.textContent = "";
    return;
  }

  childLinkBox.hidden = false;
  childLinkStatus.hidden = false;
  childLinkStatus.dataset.state = "checking";
  childLinkStatus.textContent = "Checking…";
  childLinkStatus.title = "Checking the child zone.";
  childLinkDetail.textContent = "";
  childLinkDetail.hidden = true;
  void refreshChildLink(contactId, editorRequest);
}

async function refreshChildLink(
  contactId: string,
  generation: number,
): Promise<void> {
  const info = await childLink(ownIdentity?.pubkey ?? "", contactId, linkDeps);
  if (generation !== editorRequest || !editor.open) return;

  const label = ownerLabel(contactId);
  const legacyChild = info.snapshot?.legacy === true;
  childLinkStatus.dataset.state = info.state;
  childLinkStatus.textContent = LINK_LABELS[info.state];
  childLinkStatus.title = legacyChild
    ? "This child is on the previous version and has no parent record yet."
    : LINK_TITLES[info.state];

  let detail = "";
  if (info.state === "linked") {
    detail = `${label} lists this zone as its parent.`;
  } else if (legacyChild) {
    detail =
      `${label} is on the previous version. Child owner must open the v3 app ` +
      "to link back.";
  } else if (info.state === "pending") {
    detail = `${label} has not set this zone as its parent yet.`;
  } else if (info.state === "not-created") {
    detail = `${label} has not opened ${APP_NAME} yet.`;
  } else if (info.state === "error") {
    detail = `Could not check this zone: ${info.error ?? "the read failed"}.`;
  }

  childLinkDetail.textContent = detail;
  childLinkDetail.hidden = detail === "";
}

type AdjustDirection = "issue" | "burn";

/** A validated issue/burn, in exact hundredths. */
interface AdjustPlan {
  direction: AdjustDirection;
  magnitude: bigint;
  delta: bigint;
  note: string;
  current: bigint;
  result: bigint;
}

interface AdjustState {
  /** Why the block cannot be used at all (offline, no saved child). */
  unavailable: string | null;
  /** Blocking problem with what is typed. */
  error: string | null;
  amountInvalid: boolean;
  noteInvalid: boolean;
  plan: AdjustPlan | null;
}

function currentAdjustDirection(): AdjustDirection {
  return adjustBurn.checked ? "burn" : "issue";
}

function savedEntry(): Entry | null {
  return ownState?.slots[currentSlot]?.entry ?? null;
}

/**
 * Validate the adjustment block from the current controls and slot. Nothing is
 * written here; the plan is what a successful submit would sign. An empty
 * amount is "nothing typed yet": the action stays disabled with no error, so a
 * finished save does not leave a warning behind.
 */
function planAdjustment(): AdjustState {
  const entry = savedEntry();
  const canSign = adjustmentBackend() !== null;
  const direction = currentAdjustDirection();

  let unavailable: string | null = null;
  if (!canSign) {
    unavailable =
      "Issue and burn need the online build. This preview cannot sign an adjustment.";
  } else if (entry === null || entry.contact === "") {
    unavailable =
      "Choose a contact and save the slot first. Issue and burn change a " +
      "liability that is already recorded for a child.";
  }

  const raw = adjustAmount.value.trim();
  let magnitude = 0n;
  let error: string | null = null;
  let amountInvalid = false;
  let noteInvalid = false;

  if (unavailable === null && raw !== "") {
    // A lone sign or point is half-typed, not a mistake yet.
    if (!/^[+-]?$/.test(raw) && !/^[+-]?\.$/.test(raw)) {
      try {
        magnitude = parseCents(raw);
      } catch (parseError) {
        error = errorMessage(parseError);
        amountInvalid = true;
      }

      if (error === null) {
        if (magnitude < 0n) {
          error = "Use a positive amount, then choose Issue or Burn.";
          amountInvalid = true;
        } else if (magnitude === 0n) {
          error = "Enter an amount above 0.00.";
        }
      }
    }
  }

  const current = entry?.value ?? 0n;
  const delta = direction === "burn" ? -magnitude : magnitude;
  const result = current + delta;

  if (unavailable === null && error === null) {
    if (result < 0n) {
      error =
        `A burn cannot take the liability below 0.00. ` +
        `You can burn up to ${formatCents(current)}.`;
      amountInvalid = true;
    } else if (result > I64_MAX) {
      error =
        "That amount would take the liability past the largest value a slot " +
        "can hold.";
      amountInvalid = true;
    }
  }

  const note = adjustNote.value.trim();
  const noteBytes = utf8Length(adjustNote.value);
  if (unavailable === null && error === null && noteBytes > ADJUST_NOTE_BYTES) {
    error =
      `The reason is ${noteBytes} bytes. Keep it to ${ADJUST_NOTE_BYTES} bytes.`;
    noteInvalid = true;
  }

  const plan: AdjustPlan | null =
    unavailable === null && error === null && magnitude > 0n
      ? {
          direction,
          magnitude,
          delta,
          note,
          current,
          result,
        }
      : null;

  return { unavailable, error, amountInvalid, noteInvalid, plan };
}

/** Paint the whole issue/burn block from state plus the controls. */
function renderAdjust(): void {
  const entry = savedEntry();
  const child = entry?.contact ?? "";

  adjustChild.textContent =
    child === "" ? "Not set" : ownerLabel(child);
  adjustChild.classList.toggle("is-empty", child === "");
  if (child === "") adjustChild.removeAttribute("title");
  else adjustChild.title = child;

  adjustCurrent.textContent = formatCents(entry?.value ?? 0n);
  const unit = entry?.unit ?? "";
  adjustUnit.textContent = unit;
  adjustUnit.hidden = unit === "";

  const state = planAdjustment();
  const available = state.unavailable === null;
  const direction = currentAdjustDirection();

  adjustPanel.dataset.state = available ? "ready" : "unavailable";
  adjustControls.hidden = !available;
  adjustEmpty.textContent = state.unavailable ?? "";
  adjustEmpty.hidden = available;

  const noteBytes = utf8Length(adjustNote.value);
  adjustNoteCount.textContent = `${noteBytes} / ${ADJUST_NOTE_BYTES} bytes`;
  adjustNoteCount.classList.toggle("is-warning", noteBytes > ADJUST_NOTE_BYTES);

  const magnitude = state.plan?.magnitude ?? 0n;
  const preview = state.plan?.result ?? entry?.value ?? 0n;
  const belowZero = preview < 0n;
  adjustResult.textContent = formatCents(belowZero ? 0n : preview);
  adjustResult.dataset.state = belowZero
    ? "below-zero"
    : direction === "burn"
      ? "burn"
      : "issue";

  const showTag = state.plan !== null && magnitude > 0n;
  adjustResultTag.hidden = !showTag;
  if (showTag) {
    adjustResultTag.textContent =
      direction === "burn"
        ? `lowered by ${formatCents(magnitude)}`
        : `raised by ${formatCents(magnitude)}`;
  }

  adjustWarning.textContent = state.error ?? "";
  adjustWarning.hidden = state.error === null;
  if (state.amountInvalid) adjustAmount.setAttribute("aria-invalid", "true");
  else adjustAmount.removeAttribute("aria-invalid");
  if (state.noteInvalid) adjustNote.setAttribute("aria-invalid", "true");
  else adjustNote.removeAttribute("aria-invalid");
  adjustAmount.setAttribute(
    "aria-describedby",
    state.amountInvalid
      ? "adjust-amount-hint adjust-warning"
      : "adjust-amount-hint",
  );
  adjustNote.setAttribute(
    "aria-describedby",
    state.noteInvalid ? "adjust-note-hint adjust-warning" : "adjust-note-hint",
  );

  // A new contact in the select is not the child the saved liability belongs to
  // until the details are saved. Say so rather than adjusting the wrong slot.
  const pendingContact = contactSelect.value;
  const contactMoved =
    entry !== null && pendingContact !== "" && pendingContact !== entry.contact;
  adjustStale.hidden = !contactMoved;
  if (contactMoved) {
    adjustStale.textContent =
      "The contact selected below has not been saved. Save the slot details " +
      "first; until then, adjustments apply to the child named above.";
  }

  adjustAmount.disabled = busy;
  adjustNote.disabled = busy;
  adjustDirection.disabled = busy;
  adjustSubmit.disabled = busy || state.plan === null;
  adjustSubmit.textContent = adjusting
    ? "Signing…"
    : direction === "burn"
      ? "Burn"
      : "Issue";
  adjustSubmit.setAttribute("aria-busy", String(adjusting));
}

async function handleAdjust(): Promise<void> {
  if (busy || !view || !ownState) return;
  const sign = adjustmentBackend();
  if (sign === null) return;

  const state = planAdjustment();
  if (state.plan === null) {
    // Re-render so the blocking reason is visible and focusable context is set.
    renderAdjust();
    if (state.error !== null) showEditorError(state.error, adjustAmount);
    return;
  }

  const { delta, magnitude, note, result } = state.plan;
  const slotNumber = currentSlot + 1;
  const verb = delta > 0n ? "Issued" : "Burned";

  editorError.hidden = true;
  editorError.textContent = "";
  adjustStatus.textContent = "";
  adjusting = true;
  setEditorBusy(true);
  try {
    await sign(currentSlot, delta, note);
    hideErrorNotice();
    adjustAmount.value = "";
    adjustNote.value = "";
    adjustStatus.textContent =
      `${verb} ${formatCents(magnitude)}. ` +
      `Liability is now ${formatCents(result)}.`;
    announce(
      `${verb} ${formatCents(magnitude)} on slot ${slotNumber}. ` +
        `Liability is now ${formatCents(result)}.`,
    );
  } catch (error) {
    handleActionError(error);
  } finally {
    adjusting = false;
    setEditorBusy(false);
  }
}

function openEditor(index: number, prefillContact?: string): void {
  if (!ownState || !ownIdentity || busy || !view) return;

  currentSlot = index;
  const slot = ownState.slots[index];
  const entry = slot.entry;

  // An admission handoff prefills a free slot with the candidate. An occupied
  // slot keeps the key it was signed with.
  const prefill =
    entry === null && prefillContact !== undefined && prefillContact !== ""
      ? {
          label: shortUserId(prefillContact),
          userId: prefillContact,
          address: null,
        }
      : null;
  editorPrefillContact = prefill;
  const selectedContact = entry?.contact ?? prefill?.userId ?? "";

  editorSlot.textContent = String(index + 1).padStart(2, "0");
  editorTitle.textContent = `Slot ${index + 1}`;
  editorSeq.textContent =
    slot.seq === 0 ? "Never written" : `Signed at sequence ${slot.seq}`;
  unitInput.value = entry?.unit ?? "";
  noteInput.value = entry?.note ?? "";
  clearButton.disabled = entry === null;
  clearButton.textContent = "Clear slot";

  editorError.hidden = true;
  editorError.textContent = "";
  adjustAmount.value = "";
  adjustNote.value = "";
  adjustStatus.textContent = "";
  adjustIssue.checked = true;
  adjustBurn.checked = false;
  populateContactOptions(selectedContact);
  renderAdjust();
  setChildLink(selectedContact === "" ? null : selectedContact);

  if (!editor.open) editor.showModal();
  if (adjustControls.hidden) contactSelect.focus();
  else adjustAmount.focus();
}

function closeEditor(): void {
  if (editor.open) editor.close();
  editorPrefillContact = null;
}

function showEditorError(message: string, focus: HTMLElement | null): void {
  editorError.textContent = message;
  editorError.hidden = false;
  focus?.focus();
}

async function handleSave(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (busy || !ownState || !view) return;

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

  // The value is no longer edited here. Issue and burn own the liability; a
  // details save keeps whatever the slot already holds so a contact, unit or
  // note change cannot rewrite the amount.
  const value = ownState.slots[currentSlot].entry?.value ?? 0n;

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
  if (busy || !ownState || !view) return;
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
  status: HTMLElement | null = null,
): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopy(text);
    }
    button.classList.add("is-copied");
    window.setTimeout(() => button.classList.remove("is-copied"), 1_300);
    if (status) {
      status.textContent = "Copied.";
      window.setTimeout(() => {
        if (status.textContent === "Copied.") status.textContent = "";
      }, 2_000);
    }
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

/**
 * Receive-payment links carry `?pay=<owner id>&name=<label>&addr=<octal>`.
 * Parse them at boot, before the board paints, and keep the invite pending
 * until the delegate/identity prompts have settled. Resolving the
 * link opens the address book prefilled and drops the params with
 * `replaceState`.
 */
function maybeOpenReceiveLink(): void {
  if (receiveLinkSettled) return;
  const parsed = parseReceiveInvite(window.location.search);
  if (parsed.kind === "none") return;
  if (parsed.kind === "incomplete") {
    receiveLinkSettled = true;
    stripReceiveLinkParams();
    showNotice(
      "warning",
      "That link is incomplete",
      "The link is missing a valid zone key. Ask for a new receive-payment link.",
    );
    announce("That link is incomplete.");
    return;
  }
  pendingReceiveLink = parsed.invite;
  tryOpenReceiveLink();
}

/** True once boot prompts and the board are past the point of covering the dialog. */
function receiveLinkReady(): boolean {
  if (pendingReceiveLink === null) return false;
  if (ownIdentity === null || ownState === null) return false;
  if (boardStatus !== "ready" && boardStatus !== "offline") return false;
  return (
    document.querySelector(
      "#delegate-install[open], #identity-setup[open], #identity-manage[open]",
    ) === null
  );
}

/** Open the queued invite once the app is past its first-run prompts. */
function tryOpenReceiveLink(): void {
  if (receiveLinkSettled || pendingReceiveLink === null) return;
  if (!receiveLinkReady()) return;

  const incoming = pendingReceiveLink;
  const resolved = resolveReceiveInvite(
    window.location.search,
    ownIdentity?.pubkey ?? null,
    ownContacts(),
  );
  receiveLinkSettled = true;
  pendingReceiveLink = null;
  stripReceiveLinkParams();

  if (resolved.kind === "own") {
    showNotice(
      "info",
      "That link is your own zone",
      "You cannot add your own zone to your address book.",
    );
    announce("That link is your own zone.");
    return;
  }
  if (resolved.kind === "existing") {
    void openExistingReceiveContact(
      resolved.contact.userId,
      incoming.address,
    );
    return;
  }
  if (resolved.kind !== "invite") {
    // The URL changed while the prompts were open; nothing to show.
    return;
  }
  contactsDialog.openInvite(resolved.invite);
}

/** `?room=` carries exactly one 64-character lowercase hex owner id. */
function roomOwnerFromLocation(): string | null {
  const value = new URLSearchParams(window.location.search).get("room");
  return value !== null && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/**
 * Room deep links are queued like receive links: the dialog must not open over
 * the delegate/identity prompts, and the board's identity and zone must exist
 * before the panel can read the room.
 */
function maybeOpenRoomLink(): void {
  if (roomLinkSettled) return;
  const owner = roomOwnerFromLocation();
  if (owner === null) return;
  pendingRoomOwner = owner;
  tryOpenRoomLink();
}

function roomLinkReady(): boolean {
  if (pendingRoomOwner === null) return false;
  if (ownIdentity === null || ownState === null) return false;
  if (boardStatus !== "ready" && boardStatus !== "offline") return false;
  return (
    document.querySelector(
      "#delegate-install[open], #identity-setup[open], #identity-manage[open]",
    ) === null
  );
}

function tryOpenRoomLink(): void {
  if (roomLinkSettled || pendingRoomOwner === null) return;
  if (!roomLinkReady()) return;

  const owner = pendingRoomOwner;
  roomLinkSettled = true;
  pendingRoomOwner = null;
  roomPanel.open(owner);
}

/**
 * A root link opens the discovery surface. It is queued exactly like `?room=`
 * so it never appears over a first-run dialog. The raw value is kept: an
 * invalid or duplicate parameter stays in the field with a readable error.
 */
function maybeOpenRootLink(): void {
  if (rootLinkSettled) return;
  const values = new URLSearchParams(window.location.search).getAll("root");
  if (values.length === 0) return;
  pendingRootValue = values.length === 1 ? values[0]! : values.join(" ");
  tryOpenRootLink();
}

function rootLinkReady(): boolean {
  if (pendingRootValue === null) return false;
  if (ownIdentity === null || ownState === null) return false;
  if (boardStatus !== "ready" && boardStatus !== "offline") return false;
  return (
    document.querySelector(
      "#delegate-install[open], #identity-setup[open], #identity-manage[open]",
    ) === null
  );
}

function tryOpenRootLink(): void {
  if (rootLinkSettled || pendingRootValue === null) return;
  if (!rootLinkReady()) return;

  const value = pendingRootValue;
  rootLinkSettled = true;
  pendingRootValue = null;
  joinPanel.open(value);
}

/** Drop the join link's hints without disturbing the view/history entry. */
function stripRootParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("root") && !url.searchParams.has("target")) return;
  stripJoinParams(url);
  window.history.replaceState(window.history.state, "", url);
}

/**
 * A repeat link opens the saved row. When it carries a different address, the
 * delegate updates the contact first so a corrected link is not ignored.
 */
async function openExistingReceiveContact(
  userId: string,
  address: string | null,
): Promise<void> {
  const contact = ownContacts().find((candidate) => candidate.userId === userId);
  if (contact !== undefined && address !== null && address !== contact.address) {
    try {
      await backend.updateContact(userId, { address });
    } catch (error) {
      showNotice(
        "warning",
        "Could not update the address",
        errorMessage(error),
      );
    }
  }
  contactsDialog.openExisting(userId);
  announce("Already in your address book.");
}

/** Drop `pay`, `name` and `addr` without disturbing the view/history entry. */
function stripReceiveLinkParams(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("pay");
  url.searchParams.delete("name");
  url.searchParams.delete("addr");
  try {
    window.history.replaceState(window.history.state, "", url);
  } catch {
    // A gateway shell may refuse history writes; the link still opens.
  }
}

/**
 * The name the parent signed for this zone in its `childNames` record, or
 * null when there is no mutual parent or the parent named no slot. The zone
 * has no name of its own, so a receive link omits `name` in that case.
 */
async function ownParentGivenName(): Promise<string | null> {
  const own = ownSnapshot();
  if (own === null || own.state.parent.userId === null) return null;
  const info = await parentLink(own, linkDeps);
  if (info.state !== "linked" || info.snapshot === null) return null;
  return parentGivenName(info.snapshot, own.ownerId);
}

/** `<origin><path>?pay=…&name=…&addr=…`; the address is required. */
function receivePaymentLink(
  ownerId: string,
  name: string | null,
  address: string,
): string {
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set("pay", ownerId);
  if (name !== null && name.trim() !== "") {
    url.searchParams.set("name", name.trim());
  }
  url.searchParams.set("addr", address);
  return url.toString();
}

async function copyReceivePaymentLink(): Promise<void> {
  const own = ownSnapshot();
  if (own === null || ownIdentity === null) {
    renderSimpleActions();
    return;
  }

  simpleReceiveLink.disabled = true;
  simpleReceiveStatus.textContent = "";
  let link = "";
  try {
    const info = await octalAddress(own, linkDeps);
    if (info.address === null) {
      // An unsettled address cannot receive a payment. Never copy a link that
      // would send the recipient into "ask them for a link". The empty string
      // is the root's own address and is a valid link.
      renderSimpleActions();
      return;
    }
    link = receivePaymentLink(
      ownIdentity.pubkey,
      await ownParentGivenName(),
      info.address,
    );
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link);
    } else {
      fallbackCopy(link);
    }
    simpleReceiveStatus.textContent =
      "Link copied. Opening it adds your zone to their address book.";
    simpleReceiveLink.textContent = RECEIVE_LINK_COPIED_LABEL;
    window.setTimeout(() => {
      simpleReceiveLink.textContent = RECEIVE_LINK_LABEL;
    }, 1_300);
    announce("Receive-payment link copied.");
  } catch (error) {
    simpleReceiveStatus.textContent = "";
    showNotice(
      "warning",
      "Could not copy the link",
      `${link === "" ? "The link could not be built." : link} (${errorMessage(error)})`,
    );
  } finally {
    renderSimpleActions();
  }
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

async function clearParent(): Promise<void> {
  if (busy || !view || !ownState?.parent.userId) return;

  busy = true;
  renderBoard();
  renderControls();
  renderContactCount();
  renderParentRow();
  try {
    await backend.saveParent(null);
    hideErrorNotice();
    announce("Parent cleared. This zone is a root.");
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
    announce("Parent cleared. This zone is a root.");
    return;
  }

  const snapshot = ownSnapshot();
  if (snapshot === null) return;
  const info = await parentLink(snapshot, linkDeps);
  const label = ownerLabel(parentId);
  const legacyNote = info.snapshot?.legacy
    ? " The parent zone is on the previous version."
    : "";

  if (info.state === "linked") {
    announce(`Parent saved. Linked to ${label}.${legacyNote}`);
  } else if (info.state === "pending") {
    announce(
      `Parent saved. Pending until ${label} adds this zone to a slot.${legacyNote}`,
    );
  } else if (info.state === "not-created") {
    announce(`Parent saved. ${label} has not opened ${APP_NAME} yet.`);
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
    if (ownIdentity) {
      const snapshot = ownSnapshot();
      if (snapshot) view = toView(snapshot);
    }
    renderAll();
    contactsDialog.refresh();
    if (paymentDialog.open) {
      populatePaymentRecipients(paymentRecipient.value);
    }
    parentDialog?.refresh();
    tryOpenReceiveLink();
    tryOpenRoomLink();
    tryOpenRootLink();
    // A contacts write can land while the editor is open (the address book is
    // reachable from it). Keep the options honest without losing the selection.
    if (editor.open) {
      populateContactOptions(contactSelect.value);
      updateContactState();
      renderAdjust();
    }
  },
  onIdentity: (next) => {
    ownIdentity = next;
    const snapshot = ownSnapshot();
    if (snapshot) view = toView(snapshot);
    renderAll();
    tryOpenReceiveLink();
    tryOpenRoomLink();
    tryOpenRootLink();
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
  onDelegateStatus: (status) => {
    delegateStatusFromCallback = status;
    autoAdvanceStatusReceived = true;
    autoAdvanceRefreshError = null;
    autoAdvanceStatus = status;
    renderAutoAdvance();
  },
};

const backend: BoardBackend = isOffline
  ? new OfflineBoard(callbacks)
  : new OnlineBoard(BOARD_CONFIG, callbacks);

const roomPanel = createRoomPanel({
  ownerId: () => ownIdentity?.pubkey ?? null,
  selfId: () => ownIdentity?.pubkey ?? null,
  parentId: () => ownState?.parent.userId ?? null,
  zoneContacts: zoneRoomContacts,
  nameFor: (userId) =>
    (view === null ? null : parentGivenName(view, userId)) ?? ownerLabel(userId),
  transport: backend.roomTransport,
  announce,
});
roomOpen.addEventListener("click", () => roomPanel.open());

const joinPanel = createOnboardingPanel({
  readBoard: (ownerId) => readBoardForView(ownerId),
  transport: backend.candidateTransport,
  selfId: () => ownIdentity?.pubkey ?? null,
  saveParent: saveOwnParent,
  announce,
  onSettled: stripRootParam,
});

createRequestsPanel({
  transport: backend.candidateTransport,
  ownId: () => ownIdentity?.pubkey ?? null,
  readOwnZone: async () => {
    const ownerId = ownIdentity?.pubkey ?? null;
    if (ownerId === null) return null;
    const snapshot = await backend.readBoard(ownerId);
    return snapshot?.state ?? null;
  },
  ownAddress: ownRegionAddress,
  openAdmit,
  announce,
});

const delegateControls = createDelegateControls(backend);

const paymentDeps: PaymentDeps = {
  readBoard: (id) => readBoardForView(id),
  savePayment: (entry, slots) => backend.savePayment(entry, slots),
};

let parentDialog: ParentDialog | null = null;

const contactsDialog = createContactsDialog({
  getContacts: ownContacts,
  getMaxContacts: () => MAX_CONTACTS,
  // The board's own key is not a contact; labels no longer share a namespace
  // with the board name, so only the userId is reserved.
  getReservedUserIds: () => {
    const ownId = ownIdentity?.pubkey;
    return ownId ? [ownId] : [];
  },
  getUsedContactCount: (userId) => {
    if (!ownState) return 0;
    const slotUses = ownState.slots.filter(
      (slot) => slot.entry?.contact === userId,
    ).length;
    const parentUse = ownState.parent.userId === userId ? 1 : 0;
    return slotUses + parentUse;
  },
  addContact: (entry) => backend.addContact(entry),
  updateContact: (userId, patch) => backend.updateContact(userId, patch),
  removeContact: (userId) => backend.removeContact(userId),
  announce,
  onAdded: (contact) => {
    if (addingForPayment) {
      addingForPayment = false;
      populatePaymentRecipients(contact.userId);
      updatePaymentRecipient();
      if (paymentDialog.open) {
        paymentRecipient.focus({ preventScroll: true });
      }
      return;
    }
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
    renderAdjust();
    setChildLink(contact.userId);
    contactSelect.focus({ preventScroll: true });
  },
});

parentDialog = createParentDialog({
  getContacts: ownContacts,
  getOwnOwnerId: () => ownIdentity?.pubkey ?? null,
  getParent: () => ownState?.parent.userId ?? null,
  readBoard: readBoardForView,
  saveParent: saveOwnParent,
  openContacts: () => {
    addingForParent = true;
    addingForPayment = false;
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
  importIdentity: (
    seed,
    nextSeq,
    contactsNextSeq,
    parentNextSeq,
    paymentsNextSeq,
    adjustmentsNextSeq,
    childNamesNextSeq,
    selfNameNextSeq,
    payloadVersion,
    contacts,
  ) =>
    backend.importIdentity(
      seed,
      nextSeq,
      contactsNextSeq,
      parentNextSeq,
      paymentsNextSeq,
      adjustmentsNextSeq,
      childNamesNextSeq,
      selfNameNextSeq,
      payloadVersion,
      contacts,
    ),
  announce,
  copy: copyToClipboard,
  onRestored: () => {
    showNotice(
      "info",
      "Identity restored",
      "This device now uses the restored owner key. The zone is loading; " +
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

viewMode = initialViewMode();
maybeOpenReceiveLink();
maybeOpenRoomLink();
maybeOpenRootLink();
buildSlots();
renderAll();
paintViewMode();
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
function onAdjustInput(): void {
  // A new draft replaces the old result message.
  if (!busy) adjustStatus.textContent = "";
  renderAdjust();
}

adjustAmount.addEventListener("input", onAdjustInput);
adjustAmount.addEventListener("blur", () => {
  // Normalise to the app's exact two-decimal shape once the user leaves.
  const raw = adjustAmount.value.trim();
  if (raw === "" || /^[+-]?$/.test(raw) || /^[+-]?\.$/.test(raw)) return;
  try {
    const cents = parseCents(raw);
    if (cents >= 0n) adjustAmount.value = formatCents(cents);
  } catch {
    // Keep what was typed; the warning under the field explains it.
  }
  renderAdjust();
});
adjustNote.addEventListener("input", onAdjustInput);
adjustIssue.addEventListener("change", onAdjustInput);
adjustBurn.addEventListener("change", onAdjustInput);

// Enter in the amount or reason runs the adjustment, not the details form.
for (const field of [adjustAmount, adjustNote]) {
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!adjustSubmit.disabled) void handleAdjust();
  });
}
adjustSubmit.addEventListener("click", () => {
  void handleAdjust();
});
contactSelect.addEventListener("change", () => {
  updateContactState();
  setChildLink(contactSelect.value === "" ? null : contactSelect.value);
  renderAdjust();
});
contactAdd.addEventListener("click", () => {
  addingForParent = false;
  addingForPayment = false;
  contactsDialog.open({ selectOnAdd: true });
});
contactsOpen.addEventListener("click", () => {
  addingForParent = false;
  addingForPayment = false;
  contactsDialog.open();
});
viewToggle.addEventListener("click", () => {
  setViewMode(viewMode === "advanced" ? "simple" : "advanced");
});
byId<HTMLButtonElement>("join-open").addEventListener("click", () => {
  joinPanel.open();
});
byId<HTMLButtonElement>("region-open").addEventListener("click", () => {
  void openZoneRegionPicker().catch((error) => {
    console.error("Could not open the region picker", error);
  });
});
byId<HTMLButtonElement>("region-place-open").addEventListener("click", () => {
  openPlaceRegionPicker();
});
simplePay.addEventListener("click", () => {
  if (!simplePay.disabled) openPaymentDialog();
});
simpleContacts.addEventListener("click", () => {
  if (simpleContacts.disabled) return;
  addingForParent = false;
  addingForPayment = false;
  contactsDialog.open();
});
simpleReceiveLink.addEventListener("click", () => {
  if (!simpleReceiveLink.disabled) void copyReceivePaymentLink();
});
simplePaymentReview.addEventListener("click", () => {
  setViewMode("advanced", { focus: false });
  paymentInbox.focus({ preventScroll: true });
});
addChildSlot.addEventListener("click", () => {
  void openAssign().catch((error) => {
    console.error("Could not open the region assignment", error);
  });
});
window.addEventListener("popstate", () => {
  receiveLinkSettled = false;
  pendingReceiveLink = null;
  maybeOpenReceiveLink();
  roomLinkSettled = false;
  pendingRoomOwner = null;
  maybeOpenRoomLink();
  rootLinkSettled = false;
  pendingRootValue = null;
  maybeOpenRootLink();
  const mode: ViewMode =
    new URLSearchParams(window.location.search).get("view") === "advanced"
      ? "advanced"
      : "simple";
  if (mode !== viewMode) setViewMode(mode, { history: false, focus: true });
  else if (mode === "simple") pushedAdvancedEntry = false;
});
paymentRecipient.addEventListener("change", updatePaymentRecipient);
paymentAddressBook.addEventListener("click", () => {
  addingForParent = false;
  addingForPayment = true;
  contactsDialog.open({ selectOnAdd: true });
});
paymentAddress.addEventListener("input", updatePaymentRecipient);
paymentUser.addEventListener("input", updatePaymentRecipient);
paymentDirect.addEventListener("toggle", updatePaymentRecipient);
paymentCheck.addEventListener("click", () => {
  // Force the status/inbox read to look past the session cache.
  boardCache.clear();
  void renderPayments();
});
detailsBox.addEventListener("toggle", () => {
  if (detailsBox.open) void refreshAutoAdvanceStatus();
});
autoAdvanceForm.addEventListener("submit", (event) => {
  void handleAutoAdvanceSubmit(event);
});
autoAdvanceToggle.addEventListener("change", () => {
  autoAdvanceDirty = true;
  if (!autoAdvanceSaving) autoAdvanceSave.textContent = "Save changes";
  autoAdvanceError.hidden = true;
  autoAdvanceError.textContent = "";
});
autoAdvanceMax.addEventListener("input", () => {
  autoAdvanceDirty = true;
  if (!autoAdvanceSaving) autoAdvanceSave.textContent = "Save changes";
  clearAutoAdvanceMaxWarning();
  autoAdvanceError.hidden = true;
  autoAdvanceError.textContent = "";
});
autoAdvanceRefresh.addEventListener("click", () => {
  void refreshAutoAdvanceStatus(true);
});
paymentWithdraw.addEventListener("click", () => {
  void (async () => {
    const own = ownSnapshot();
    if (own === null || own.state.payments.entry === null) return;
    const entry = own.state.payments.entry;
    paymentWithdraw.disabled = true;
    try {
      const saved = await withdrawPayment(own, entry, paymentDeps);
      boardCache.clear();
      if (saved === null) {
        showNotice(
          "info",
          "Offer withdrawn",
          "The source record was cleared before any leg was signed.",
        );
        announce("Payment offer withdrawn.");
      } else if (saved.status === "blocked") {
        showNotice(
          "warning",
          "Payment could not be withdrawn",
          "The issued credit could not be restored, so the record is terminal but the slot is unchanged. Check the slot value.",
        );
        announce("Payment withdrawal was blocked.");
      } else if (saved.status === "superseded") {
        showNotice(
          "warning",
          "Payment already superseded",
          "A later signed write replaced the issued credit, so nothing was overwritten.",
        );
        announce("Payment was already superseded.");
      } else {
        showNotice(
          "info",
          "Payment withdrawn",
          "The issued credit was restored and the payment is terminal.",
        );
        announce("Payment withdrawn.");
      }
      renderAll();
    } catch (error) {
      showNotice("error", "Could not withdraw the payment", errorMessage(error));
      paymentWithdraw.disabled = false;
    }
  })();
});
paymentClear.addEventListener("click", () => {
  void (async () => {
    const clear = backend.clearStuckPayment;
    if (typeof clear !== "function") return;
    paymentClear.disabled = true;
    try {
      await clear.call(backend);
      boardCache.clear();
      showNotice(
        "info",
        "Stuck payment cleared",
        "The zone's payments record is now a tombstone; it can take a new payment.",
      );
      announce("Stuck payment cleared.");
      renderAll();
    } catch (error) {
      showNotice(
        "error",
        "Could not clear the stuck payment",
        errorMessage(error),
      );
      paymentClear.disabled = false;
    }
  })();
});
paymentClose.addEventListener("click", closePaymentDialog);
paymentCancel.addEventListener("click", closePaymentDialog);
paymentForm.addEventListener("submit", (event) => {
  void handlePaymentSubmit(event);
});
paymentDialog.addEventListener("cancel", (event) => {
  if (paymentBusy) event.preventDefault();
});
paymentDialog.addEventListener("click", (event) => {
  if (event.target === paymentDialog && !paymentBusy) {
    closePaymentDialog();
  }
});

editor.addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
editor.addEventListener("click", (event) => {
  if (event.target === editor && !busy) closeEditor();
});

parentEdit.addEventListener("click", () => {
  parentDialog?.open();
});
parentClear.addEventListener("click", () => {
  void clearParent();
});
parentAdvancedEdit.addEventListener("click", () => {
  parentDialog?.open();
});
parentAdvancedClear.addEventListener("click", () => {
  void clearParent();
});

identityCopy.addEventListener("click", () => {
  if (ownIdentity) {
    void copyToClipboard(ownIdentity.pubkey, "Owner public key", identityCopy);
  }
});
simpleOwnerCopy.addEventListener("click", () => {
  if (ownIdentity) {
    void copyToClipboard(
      ownIdentity.pubkey,
      "Your user id",
      simpleOwnerCopy,
      simpleOwnerStatus,
    );
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

// A pending receive link waits for first-run prompts. The dialogs close
// asynchronously, so pick the invite up when any of them finishes.
for (const id of [
  "delegate-install",
  "identity-setup",
  "identity-manage",
]) {
  document.getElementById(id)?.addEventListener("close", () => {
    tryOpenReceiveLink();
    tryOpenRootLink();
  });
}

startBoard();
