/**
 * Owner-side join-request queue and interview (P4c3a/P4c3b1,
 * `DESIGN-candidates.md` §12.1 and §12.2).
 *
 * A quiet Advanced surface over the owner's own candidate room: read the
 * public queue, switch accepting on or off, dismiss one request at a time (or
 * all of them), copy the zone's bare root id, and interview one requester in
 * the encrypted candidate room. Every write passes the owner's own id to the
 * transport; there is no way to point this panel at another zone's queue.
 *
 * Admission's zone write is P4c3b2 and does not live here. This panel hands off
 * to the region designation, then detects the written slot and finishes
 * admission by rotating the candidate room without the candidate.
 */

import type { CandidateTransport } from "./candidate-client";
import {
  candidateNoteToText,
  candidateRequestId,
  isAccepting,
  latestCandidateMembership,
  type CandidateMembershipV1,
  type CandidateMessageV1,
  type CandidateRequestV1,
  type CandidateStateV1,
} from "./candidate-state";
import {
  admissionAddress,
  admissionSlot,
  interviewBlockReason,
  interviewMembers,
  interviewMembersAfterAdmit,
  interviewState,
  zoneChildren,
} from "./candidate-interview";
import { errorMessage, shorten } from "./util";
import {
  formatRoomTime,
  roomByteLength,
  roomComposerProblem,
  roomMessageCountLabel,
  roomMessageRows,
  roomTimeIso,
  type RoomMessageRow,
} from "./room-panel";
import { roomBodyToText, roomMessageId } from "./room-state";
import {
  ROOM_ENCRYPTED_BODY_BYTE_LIMIT,
  ROOM_LEGACY_BODY_BYTE_LIMIT,
  isEncryptedRoomBody,
  readRoomBody,
  type RoomBodyView,
} from "./room-crypto";
import type { StateV3 } from "./state";

/** Candidate-room tag bound into the body AAD. */
export const INTERVIEW_TAG = "ZCR1";

export interface RequestsPanelDeps {
  /** Candidate-room transport; only the owner's own id is ever passed. */
  transport: CandidateTransport;
  /** The viewer's own owner id, or null while the identity is not ready. */
  ownId(): string | null;
  /** Read the owner's own zone state; null when it is not available. */
  readOwnZone(): Promise<StateV3 | null>;
  /** The owner's own octal address, or null when it is not settled. */
  ownAddress(): Promise<string | null>;
  /** Open the region designation with this candidate prefilled. */
  openAdmit(candidateId: string): Promise<void>;
  announce(message: string): void;
}

export interface RequestsPanel {
  open(): void;
  refresh(): void;
  close(): void;
}

/** Visible note cap; the full text stays in the row's `title`. */
export const REQUEST_NOTE_DISPLAY_LIMIT = 160;

export interface DismissStepFailure {
  id: string;
  error: unknown;
}

export interface DismissRunResult {
  /** The last state a successful dismissal returned, or null. */
  state: CandidateStateV1 | null;
  cleared: string[];
  failed: DismissStepFailure[];
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

/** `world` for the empty cell, otherwise `cell 003`. */
export function formatRequestCell(wantCell: string): string {
  return wantCell === "" ? "world" : `cell ${wantCell}`;
}

/** The requester's shortened id; the full key goes in the element's title. */
export function shortRequester(requester: string): string {
  return shorten(requester);
}

/** Decode the contract's lowercase-hex note for display. */
export function requestNoteText(noteHex: string): string {
  try {
    return candidateNoteToText(noteHex);
  } catch {
    return "Unreadable note";
  }
}

/**
 * Cap a note for display without splitting a surrogate pair. The unclamped
 * text is still available to the caller for the element's `title`.
 */
export function notePreview(
  text: string,
  limit = REQUEST_NOTE_DISPLAY_LIMIT,
): { text: string; truncated: boolean } {
  const characters = Array.from(text);
  if (characters.length <= limit) return { text, truncated: false };
  return {
    text: `${characters.slice(0, limit).join("").trimEnd()}…`,
    truncated: true,
  };
}

/** The request time as a full ISO string, or null when it is not a date. */
export function requestTimeIso(milliseconds: number): string | null {
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

let timeFormatter: Intl.DateTimeFormat | null = null;

/** A local, human-readable request time. */
export function formatRequestTime(milliseconds: number): string {
  const iso = requestTimeIso(milliseconds);
  if (iso === null) return "Unknown time";
  if (timeFormatter === null) {
    timeFormatter = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }
  try {
    return timeFormatter.format(new Date(iso));
  } catch {
    return iso;
  }
}

export function requestCountLabel(count: number): string {
  if (count === 0) return "No open requests";
  return count === 1 ? "1 open request" : `${count} open requests`;
}

/**
 * The portable share artifact: the zone's bare owner id. A Freenet app is
 * served by each person's own node, so a URL from this node is not shareable;
 * the join field accepts the 64-hex id (or a link that carries it).
 */
export function shareRootId(ownerId: string): string {
  return ownerId.trim().toLowerCase();
}

/** Visible copy feedback for the root id, or "" when there is nothing to say. */
export function rootIdCopyStatus(
  mode: "idle" | "copying" | "copied" | "manual",
): string {
  if (mode === "copying") return "Copying the root id…";
  if (mode === "copied") return "Copied.";
  if (mode === "manual") {
    return "The clipboard is unavailable. Select the root id and copy it manually.";
  }
  return "";
}

/** The screen-reader sentence for a root-id copy attempt. */
export function rootIdCopyAnnouncement(
  mode: "copied" | "manual",
): string {
  return mode === "copied"
    ? "Root id copied."
    : "The clipboard is unavailable. The root id is shown for manual copying.";
}

/**
 * Dismiss ids one at a time, continuing after a failure so one bad row cannot
 * block the rest. `shouldStop` lets the panel abandon the run when its dialog
 * closes or its owner changes.
 */
export async function dismissSequentially(
  ids: readonly string[],
  dismiss: (id: string) => Promise<CandidateStateV1>,
  shouldStop: () => boolean = () => false,
): Promise<DismissRunResult> {
  const cleared: string[] = [];
  const failed: DismissStepFailure[] = [];
  let state: CandidateStateV1 | null = null;

  for (const id of ids) {
    if (shouldStop()) break;
    try {
      state = await dismiss(id);
      cleared.push(id);
    } catch (error) {
      failed.push({ id, error });
    }
  }
  return { state, cleared, failed };
}

/** "Cleared 2 requests. 1 request remains." with singular forms. */
export function clearSummary(cleared: number, remaining: number): string {
  const base =
    cleared === 0
      ? "No requests cleared."
      : cleared === 1
        ? "Cleared 1 request."
        : `Cleared ${cleared} requests.`;
  if (remaining === 0) {
    return cleared === 0 ? `${base} Nothing remains.` : base;
  }
  return `${base} ${
    remaining === 1 ? "1 request remains." : `${remaining} requests remain.`
  }`;
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

export type RequestsAction =
  | "read"
  | "zone"
  | "accepting"
  | "dismiss"
  | "interview"
  | "message"
  | "end"
  | "admit"
  | "finish";

/** Readable sentences for queue actions; contract detail stays out of them. */
export function requestsErrorText(
  error: unknown,
  action: RequestsAction,
): string {
  const code = errorCode(error);
  if (action === "read") {
    if (code === "connection") {
      return "You're offline. Check your connection, then try again.";
    }
    if (code === "wasm" || code === "config") {
      return "The request room could not be prepared. Reload the page and try again.";
    }
    return "The request queue could not be read. Try again.";
  }
  if (action === "zone") {
    if (code === "connection") {
      return "Your zone's members could not be checked while offline. Try again.";
    }
    return "Your zone's members could not be read. Try again.";
  }

  const prefix =
    action === "accepting"
      ? "Accepting was not changed."
      : action === "interview"
        ? "The interview was not started."
        : action === "message"
          ? "The message was not sent."
          : action === "end"
            ? "The interview was not ended."
            : action === "admit"
              ? "The slot editor could not be opened."
              : action === "finish"
                ? "Admission was not finished."
                : "The request was not dismissed.";
  switch (code) {
    case "connection":
      return `${prefix} Check your connection and try again.`;
    case "sign":
      return `${prefix} Make sure your identity is ready, then try again.`;
    case "not-owner":
      return `${prefix} Only this zone's owner can do that.`;
    case "read":
      return `${prefix} The confirmation could not be read. Refresh to check.`;
    case "wasm":
    case "config":
      return `${prefix} Reload the page and try again.`;
    case "write":
      return `${prefix} Try again in a moment.`;
    default:
      return `${prefix} ${errorMessage(error)}`;
  }
}

export function requestRows(
  state: CandidateStateV1 | null,
): CandidateRequestV1[] {
  // The state is retained newest-last; the owner reads newest first.
  return state === null ? [] : [...state.requests].reverse();
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** The composer cap for the interview's current epoch. */
export function interviewComposerLimit(
  latest: CandidateMembershipV1 | null,
): number {
  return (latest?.secrets.length ?? 0) > 0
    ? ROOM_ENCRYPTED_BODY_BYTE_LIMIT
    : ROOM_LEGACY_BODY_BYTE_LIMIT;
}

/**
 * Messages at the latest interview epoch in contract order, newest last. Older
 * epochs stay in the room as history but are not part of the current
 * conversation.
 */
export function interviewMessageRows(
  messages: readonly CandidateMessageV1[],
  latest: CandidateMembershipV1 | null,
): RoomMessageRow[] {
  if (latest === null) return [];
  return roomMessageRows(
    messages.filter((message) => message.epoch === latest.seq),
    latest.seq,
  );
}

/** Signed members outside the owner and the zone's occupied slots. */
export function interviewOutsideMembers(
  zoneState: StateV3 | null,
  ownerId: string,
  members: readonly string[],
): string[] {
  const known = new Set([
    ownerId,
    ...(zoneState === null ? [] : zoneChildren(ownerId, zoneState)),
  ]);
  return [...new Set(members.filter((member) => !known.has(member)))].sort();
}

export interface InterviewCandidateView {
  candidate: string | null;
  /** A client-visible inconsistency, or null when the state is coherent. */
  warning: string | null;
}

/**
 * Resolve the candidate shown in the interview section.
 *
 * The signed membership is authoritative. `invited` is the requester the owner
 * just invited: it covers a membership that dedupes the candidate (the offline
 * self-request flow), where the candidate is also the owner. A membership with
 * several outsiders is reported rather than guessed at.
 */
export function interviewCandidateView(
  candidateState: CandidateStateV1 | null,
  zoneState: StateV3 | null,
  ownerId: string,
  invited: string | null = null,
): InterviewCandidateView {
  if (candidateState === null) return { candidate: null, warning: null };
  const latest = latestCandidateMembership(candidateState);
  if (latest === null) return { candidate: null, warning: null };
  if (zoneState === null) {
    return {
      candidate: null,
      warning: "Your zone could not be read, so the interview cannot be checked.",
    };
  }

  const outsiders = interviewOutsideMembers(
    zoneState,
    ownerId,
    latest.members,
  );
  if (outsiders.length > 1) {
    return {
      candidate: null,
      warning:
        "The candidate room lists more than one candidate. End the interview before continuing.",
    };
  }

  const state = interviewState(candidateState, zoneState, ownerId);
  if (state?.candidate !== null && state?.candidate !== undefined) {
    return { candidate: state.candidate, warning: null };
  }

  if (
    invited !== null &&
    outsiders.length === 0 &&
    latest.members.includes(invited)
  ) {
    // Covers a deduped self invite and the admission handoff: once the zone
    // slot names the candidate, they stop counting as an outsider but the
    // interview round is still active until admission finishes.
    return { candidate: invited, warning: null };
  }
  if (invited !== null && outsiders.includes(invited)) {
    return { candidate: invited, warning: null };
  }
  return { candidate: null, warning: null };
}

/**
 * Hard lock: a composer only opens while `[owner] ∪ children ∪ candidate`
 * equals the latest signed membership. A removal that skips rotation would
 * leave the old epoch readable, so sending is refused instead.
 */
export function interviewMembershipLock(
  ownerId: string,
  zoneState: StateV3 | null,
  candidate: string | null,
  latest: CandidateMembershipV1 | null,
): string | null {
  if (latest === null) {
    return "The interview has no signed membership yet.";
  }
  if (zoneState === null) {
    return "Your zone could not be read, so messages are locked.";
  }
  if (candidate === null) {
    return "There is no active candidate in the interview.";
  }
  if (!sameMembers(interviewMembers(ownerId, zoneState, candidate), latest.members)) {
    return "Your zone's members and the interview membership disagree. End the interview before sending.";
  }
  return null;
}

/** The membership to sign when the interview ends: owner plus zone children. */
export function interviewRemainingMembers(
  ownerId: string,
  zoneState: StateV3,
): string[] {
  return [...new Set([ownerId, ...zoneChildren(ownerId, zoneState)])].sort();
}

/**
 * Membership to sign when admission finishes: the zone's members with the
 * newly admitted candidate dropped from the candidate room.
 */
export function admissionFinishMembers(
  ownerId: string,
  zoneState: StateV3,
  admitted: string,
): string[] {
  return interviewMembersAfterAdmit(ownerId, zoneState, admitted);
}

/** A written designation, ready to show in the interview section. */
export interface AdmissionView {
  /** Zero-based slot index. */
  slot: number;
  /** "Slot 3 written" with a one-based slot label. */
  label: string;
  /** The zero-based slot digit. */
  digit: string;
  /** `ownAddress + digit`, or null while the owner address is unknown. */
  address: string | null;
  /** "Region 25", or null while the owner address is unknown. */
  region: string | null;
}

/**
 * Derive the admission result from the zone the owner just wrote. Null until a
 * slot names the candidate, which is how the panel notices the handoff landed.
 */
export function admissionView(
  zoneState: StateV3 | null,
  candidate: string | null,
  ownAddress: string | null,
): AdmissionView | null {
  if (zoneState === null || candidate === null) return null;
  const slot = admissionSlot(zoneState, candidate);
  if (slot === null) return null;
  const address =
    ownAddress === null ? null : admissionAddress(ownAddress, slot);
  return {
    slot,
    label: `Slot ${slot + 1} written`,
    digit: String(slot),
    address,
    region: address === null ? null : `Region ${address}`,
  };
}

/** The screen-reader sentence for a newly detected designation. */
export function admissionAnnouncement(view: AdmissionView): string {
  return view.region === null ? `${view.label}.` : `${view.label}. ${view.region}.`;
}

/** A read sentence when admission cannot start because the zone is full. */
export const ADMISSION_NO_FREE_SLOT =
  "Your zone has no free slot. Clear a slot in the editor before admitting.";

/**
 * How a stored body renders. Legacy bodies decode as plaintext; a `0x01`
 * envelope is either the cached decrypted text or null while pending. It is
 * never decoded as plaintext.
 */
export function interviewBodyView(
  bodyHex: string,
  cached: RoomBodyView | undefined,
): RoomBodyView | null {
  if (!isEncryptedRoomBody(bodyHex)) {
    try {
      return { kind: "plaintext", text: roomBodyToText(bodyHex) };
    } catch {
      return { kind: "unreadable" };
    }
  }
  return cached ?? null;
}

export function createRequestsPanel(deps: RequestsPanelDeps): RequestsPanel {
  const dialog = byId<HTMLDialogElement>("requests-dialog");
  const title = byId<HTMLHeadingElement>("requests-title");
  const openButton = byId<HTMLButtonElement>("requests-open");
  const closeButton = byId<HTMLButtonElement>("requests-close");
  const doneButton = byId<HTMLButtonElement>("requests-done");

  const acceptingForm = byId<HTMLFormElement>("requests-accepting-form");
  const acceptingToggle = byId<HTMLInputElement>("requests-accepting");
  const acceptingState = byId<HTMLParagraphElement>("requests-accepting-state");
  const acceptingError = byId<HTMLParagraphElement>("requests-accepting-error");

  const count = byId<HTMLSpanElement>("requests-count");
  const queueTitle = byId<HTMLHeadingElement>("requests-queue-title");
  const refreshButton = byId<HTMLButtonElement>("requests-refresh");
  const clearButton = byId<HTMLButtonElement>("requests-clear");
  const clearConfirm = byId<HTMLDivElement>("requests-clear-confirm");
  const clearConfirmText = byId<HTMLParagraphElement>("requests-clear-confirm-text");
  const clearCancel = byId<HTMLButtonElement>("requests-clear-cancel");
  const clearConfirmButton = byId<HTMLButtonElement>(
    "requests-clear-confirm-button",
  );
  const clearStatus = byId<HTMLParagraphElement>("requests-clear-status");

  const loadingLine = byId<HTMLParagraphElement>("requests-loading");
  const errorLine = byId<HTMLParagraphElement>("requests-error");
  const retryButton = byId<HTMLButtonElement>("requests-retry");
  const emptyLine = byId<HTMLParagraphElement>("requests-empty");
  const list = byId<HTMLUListElement>("requests-list");
  const statusLine = byId<HTMLParagraphElement>("requests-status");

  const copyButton = byId<HTMLButtonElement>("requests-copy-link");
  const copyStatus = byId<HTMLParagraphElement>("requests-copy-status");
  const linkField = byId<HTMLElement>("requests-link-field");
  const linkInput = byId<HTMLInputElement>("requests-link-input");

  const interviewSection = byId<HTMLElement>("interview-section");
  const interviewTitle = byId<HTMLHeadingElement>("interview-title");
  const interviewStateLabel = byId<HTMLSpanElement>("interview-state");
  const interviewCandidate = byId<HTMLElement>("interview-candidate");
  const interviewRefresh = byId<HTMLButtonElement>("interview-refresh");
  const interviewCount = byId<HTMLSpanElement>("interview-message-count");
  const interviewLoading = byId<HTMLParagraphElement>("interview-loading");
  const interviewError = byId<HTMLParagraphElement>("interview-error");
  const interviewWarning = byId<HTMLParagraphElement>("interview-warning");
  const interviewEmpty = byId<HTMLParagraphElement>("interview-empty");
  const interviewMessages = byId<HTMLOListElement>("interview-messages");
  const interviewComposer = byId<HTMLFormElement>("interview-composer");
  const interviewInput = byId<HTMLTextAreaElement>("interview-message-input");
  const interviewHint = byId<HTMLParagraphElement>("interview-message-hint");
  const interviewSend = byId<HTMLButtonElement>("interview-send");
  const interviewComposerError = byId<HTMLParagraphElement>(
    "interview-composer-error",
  );
  const interviewEnd = byId<HTMLButtonElement>("interview-end");
  const interviewEndConfirm = byId<HTMLDivElement>("interview-end-confirm");
  const interviewEndConfirmText = byId<HTMLParagraphElement>(
    "interview-end-confirm-text",
  );
  const interviewEndCancel = byId<HTMLButtonElement>("interview-end-cancel");
  const interviewEndConfirmButton = byId<HTMLButtonElement>(
    "interview-end-confirm-button",
  );

  const interviewAdmit = byId<HTMLButtonElement>("interview-admit");
  const interviewAdmission = byId<HTMLElement>("interview-admission");
  const interviewAdmissionResult = byId<HTMLParagraphElement>(
    "interview-admission-result",
  );
  const interviewAdmissionRegion = byId<HTMLParagraphElement>(
    "interview-admission-region",
  );
  const interviewFinish = byId<HTMLButtonElement>("interview-finish");
  const interviewFinishConfirm = byId<HTMLDivElement>(
    "interview-finish-confirm",
  );
  const interviewFinishConfirmText = byId<HTMLParagraphElement>(
    "interview-finish-confirm-text",
  );
  const interviewFinishCancel = byId<HTMLButtonElement>(
    "interview-finish-cancel",
  );
  const interviewFinishConfirmButton = byId<HTMLButtonElement>(
    "interview-finish-confirm-button",
  );

  let current: CandidateStateV1 | null = null;
  /** A successful read happened; `current === null` is then a missing room. */
  let loaded = false;
  let loading = false;
  let loadError: string | null = null;
  let readToken = 0;
  let generation = 0;

  let acceptingBusy = false;
  let acceptingPending: boolean | null = null;
  let acceptingErrorText: string | null = null;

  let dismissing: string | null = null;
  let rowErrors = new Map<string, string>();
  let clearing = false;
  let clearConfirmPending = false;
  let clearMessage: string | null = null;

  let copying = false;
  let copied = false;
  let manualId: string | null = null;

  /** The owner's own zone, read alongside the candidate room. */
  let zoneState: StateV3 | null = null;
  let zoneLoaded = false;
  let zoneError: string | null = null;
  /** The owner's octal address, used only to spell the admitted address. */
  let ownAddressValue: string | null = null;

  /** Set after an invite so a deduped candidate (the offline self flow) shows. */
  let invitedCandidate: string | null = null;
  /** A membership write (invite, end or finish) is in flight. */
  let interviewWriting = false;
  let interviewStartingId: string | null = null;
  let interviewActionError: string | null = null;
  let interviewEndingConfirm = false;
  let finishingConfirm = false;
  let sendingInterviewMessage = false;
  let interviewComposerErrorText: string | null = null;
  /** Decrypted/plaintext bodies keyed by message id; epoch keys stay in crypto. */
  let interviewViews = new Map<string, RoomBodyView>();
  let interviewDecrypting = false;
  /** Invalidates in-flight decryption when the room/identity changes or closes. */
  let interviewGeneration = 0;
  /** Focus the interview heading once when it appears for this opening. */
  let interviewFocusWanted = false;
  /** The last active interview announced by a read, to avoid repeating it. */
  let announcedInterview: string | null = null;
  /** The last designation announced by a read, to avoid repeating it. */
  let announcedAdmission: string | null = null;
  /** The designation key that already took focus. */
  let admissionFocusKey: string | null = null;
  let admissionFocusPending = false;

  let lastFocus: HTMLElement | null = null;
  let liveStatus = "";

  function ownId(): string | null {
    return deps.ownId();
  }

  function acceptingValue(): boolean {
    return current === null || isAccepting(current);
  }

  function displayedAccepting(): boolean {
    return acceptingPending ?? acceptingValue();
  }

  function rows(): CandidateRequestV1[] {
    return requestRows(current);
  }

  function rowIds(): string[] {
    return rows().map((request) => candidateRequestId(request));
  }

  function latestInterview(): CandidateMembershipV1 | null {
    return current === null ? null : latestCandidateMembership(current);
  }

  function candidateView(): InterviewCandidateView {
    const owner = ownId();
    if (owner === null) return { candidate: null, warning: null };
    return interviewCandidateView(current, zoneState, owner, invitedCandidate);
  }

  function candidateId(): string | null {
    return candidateView().candidate;
  }

  /** The designation written for the active candidate, if any. */
  function currentAdmission(): AdmissionView | null {
    return admissionView(zoneState, candidateId(), ownAddressValue);
  }

  function hasFreeSlot(): boolean {
    return zoneState?.slots.some((slot) => slot.entry === null) ?? false;
  }

  function interviewVisible(): boolean {
    const view = candidateView();
    return view.candidate !== null || view.warning !== null;
  }

  function interviewLock(): string | null {
    const owner = ownId();
    if (owner === null) return "Waiting for your identity.";
    return interviewMembershipLock(
      owner,
      zoneState,
      candidateId(),
      latestInterview(),
    );
  }

  function anyWriteBusy(): boolean {
    return (
      acceptingBusy ||
      clearing ||
      dismissing !== null ||
      interviewWriting ||
      sendingInterviewMessage
    );
  }

  function clearInterviewViews(): void {
    interviewViews = new Map();
    interviewDecrypting = false;
    interviewGeneration += 1;
  }

  function showInterviewHeading(): void {
    if (!dialog.open || !interviewVisible()) return;
    if (!interviewFocusWanted) return;
    interviewFocusWanted = false;
    interviewTitle.focus({ preventScroll: true });
  }

  function setStatus(message: string): void {
    if (liveStatus === message) return;
    liveStatus = message;
    statusLine.textContent = message;
  }

  function focusQueueEnd(): void {
    const buttons = list.querySelectorAll<HTMLButtonElement>(".requests-dismiss");
    if (buttons.length > 0) {
      buttons[0]!.focus({ preventScroll: true });
    } else {
      emptyLine.focus({ preventScroll: true });
    }
  }

  function render(): void {
    const owner = ownId();
    const waiting = owner === null;
    const requests = rows();
    const busy = anyWriteBusy();
    const initialLoading = loading && !loaded;
    const interview = interviewVisible();

    dialog.dataset.state = waiting
      ? "waiting"
      : initialLoading
        ? "loading"
        : loadError !== null && !loaded
          ? "error"
          : "ready";
    dialog.dataset.interview = String(interview);

    acceptingToggle.checked = displayedAccepting();
    acceptingToggle.disabled = waiting || initialLoading || busy;
    acceptingToggle.setAttribute(
      "aria-busy",
      String(acceptingBusy || initialLoading),
    );

    if (waiting) {
      acceptingState.textContent =
        "Waiting for your identity before the zone's request queue can be read.";
    } else if (acceptingBusy) {
      acceptingState.textContent = "Saving the accepting setting…";
    } else if (initialLoading) {
      acceptingState.textContent = "Reading the accepting setting…";
    } else if (loadError !== null && !loaded) {
      acceptingState.textContent =
        "Accepting is unknown until the queue can be read.";
    } else if (current === null) {
      acceptingState.textContent =
        "The request room has not been created yet. This zone accepts requests by default.";
    } else if (current.config === null) {
      acceptingState.textContent =
        "Accepting by default. No accepting setting has been saved yet.";
    } else {
      acceptingState.textContent = displayedAccepting()
        ? "Accepting join requests."
        : "Not accepting join requests.";
    }

    acceptingError.hidden = acceptingErrorText === null;
    acceptingError.textContent = acceptingErrorText ?? "";

    count.textContent = requestCountLabel(requests.length);
    clearButton.hidden = clearConfirmPending || requests.length === 0 || waiting;
    clearButton.disabled = busy || loading;
    clearButton.textContent = clearing ? "Clearing…" : "Clear all";
    refreshButton.disabled = busy || loading;
    refreshButton.textContent = loading ? "Refreshing…" : "Refresh";

    clearConfirm.hidden = !clearConfirmPending;
    clearConfirmText.textContent =
      requests.length === 1
        ? "Dismiss the 1 open request? This cannot be undone."
        : `Dismiss all ${requests.length} open requests? This cannot be undone.`;
    clearConfirmButton.disabled = busy;
    clearCancel.disabled = busy;

    clearStatus.hidden = clearMessage === null;
    clearStatus.textContent = clearMessage ?? "";

    loadingLine.hidden = !loading;
    loadingLine.textContent = loaded ? "Refreshing requests…" : "Reading requests…";

    errorLine.hidden = loadError === null;
    errorLine.textContent = loadError ?? "";
    retryButton.hidden = loadError === null;

    emptyLine.hidden =
      waiting ||
      loading ||
      interview ||
      (loadError !== null && !loaded) ||
      requests.length > 0;
    emptyLine.tabIndex = -1;
    list.hidden = requests.length === 0;
    list.replaceChildren();
    for (const request of requests) {
      list.append(renderRow(request, busy));
    }

    copyButton.disabled = waiting || copying;
    copyButton.textContent = copying ? "Copying…" : "Copy root id";
    copyButton.setAttribute("aria-busy", String(copying));
    linkField.hidden = manualId === null;
    linkInput.value = manualId ?? "";
    const copyMode = copying
      ? "copying"
      : copied
        ? "copied"
        : manualId !== null
          ? "manual"
          : "idle";
    copyStatus.textContent = rootIdCopyStatus(copyMode);

    renderInterview(busy);

    if (waiting) {
      setStatus("Waiting for your identity.");
    } else if (initialLoading) {
      setStatus("Reading join requests.");
    } else if (loadError !== null && !loaded) {
      setStatus("The join request queue could not be read.");
    } else if (!loading) {
      setStatus(
        requests.length === 0
          ? "No open join requests."
          : `${requestCountLabel(requests.length)}.`,
      );
    }
  }

  function renderRow(
    request: CandidateRequestV1,
    busy: boolean,
  ): HTMLLIElement {
    const id = candidateRequestId(request);
    const item = document.createElement("li");
    item.className = "requests-row";
    item.dataset.requestId = id;
    item.dataset.dismissing = String(dismissing === id);

    const head = document.createElement("div");
    head.className = "requests-row-head";

    const requester = document.createElement("code");
    requester.className = "requests-requester";
    requester.textContent = shortRequester(request.requester);
    requester.title = request.requester;
    requester.setAttribute("aria-label", `Requester ${request.requester}`);

    const cell = document.createElement("span");
    cell.className = "requests-cell";
    cell.textContent = formatRequestCell(request.want_cell);
    cell.title =
      request.want_cell === "" ? "The whole world" : request.want_cell;

    const time = document.createElement("time");
    time.className = "requests-time";
    const iso = requestTimeIso(request.time);
    if (iso !== null) time.dateTime = iso;
    time.textContent = formatRequestTime(request.time);
    time.title = iso ?? "Unknown time";

    head.append(requester, cell, time);

    const fullNote = requestNoteText(request.note);
    const emptyNote = fullNote.trim() === "";
    const preview = notePreview(fullNote);
    const note = document.createElement("p");
    note.className = "requests-note";
    note.dataset.empty = String(emptyNote);
    note.textContent = emptyNote ? "No note" : preview.text;
    note.title = emptyNote ? "" : fullNote;

    const foot = document.createElement("div");
    foot.className = "requests-row-foot";

    const rowError = rowErrors.get(id);
    const message = document.createElement("p");
    message.className = "requests-row-error";
    message.setAttribute("role", "alert");
    message.hidden = rowError === undefined;
    message.textContent = rowError ?? "";

    const owner = ownId();
    let blockReason: string | null = null;
    if (owner === null) {
      blockReason = "Waiting for your identity.";
    } else if (interviewVisible()) {
      blockReason =
        candidateId() === request.requester
          ? "The interview is already open."
          : "An interview is already in progress.";
    } else if (zoneState === null) {
      blockReason = zoneError ?? "Your zone could not be read.";
    } else {
      blockReason = interviewBlockReason(
        current,
        zoneState,
        owner,
        request.requester,
      );
    }

    const block = document.createElement("p");
    block.className = "requests-row-block";
    block.hidden = blockReason === null;
    block.textContent = blockReason ?? "";

    const interviewButton = document.createElement("button");
    interviewButton.type = "button";
    interviewButton.className =
      "button button--small button--primary requests-interview";
    interviewButton.dataset.requestId = id;
    interviewButton.textContent =
      interviewStartingId === id ? "Starting…" : "Interview";
    interviewButton.disabled = busy || blockReason !== null;
    interviewButton.setAttribute("aria-busy", String(interviewStartingId === id));
    interviewButton.setAttribute(
      "aria-label",
      blockReason === null
        ? `Interview ${shortRequester(request.requester)}`
        : `Interview unavailable: ${blockReason}`,
    );
    if (blockReason !== null) interviewButton.title = blockReason;
    interviewButton.addEventListener("click", () => {
      void startInterview(id, request.requester);
    });

    const dismissButton = document.createElement("button");
    dismissButton.type = "button";
    dismissButton.className = "button button--small button--quiet requests-dismiss";
    dismissButton.dataset.requestId = id;
    dismissButton.textContent =
      dismissing === id ? "Dismissing…" : "Dismiss";
    dismissButton.disabled = busy;
    dismissButton.setAttribute(
      "aria-label",
      `Dismiss request from ${shortRequester(request.requester)}`,
    );
    dismissButton.addEventListener("click", () => {
      void dismissRequest(id);
    });

    foot.append(message, block, interviewButton, dismissButton);
    item.append(head, note, foot);
    return item;
  }

  function interviewAuthorLabel(author: string): string {
    return author === ownId() ? "You" : `Member ${author.slice(0, 8)}`;
  }

  function renderInterview(busy: boolean): void {
    const owner = ownId();
    const view = candidateView();
    const visible = view.candidate !== null || view.warning !== null;
    interviewSection.hidden = !visible;

    if (!visible) {
      interviewEndConfirm.hidden = true;
      interviewEndingConfirm = false;
      interviewFinishConfirm.hidden = true;
      finishingConfirm = false;
      interviewAdmission.hidden = true;
      interviewAdmit.hidden = true;
      interviewFinish.hidden = true;
      admissionFocusKey = null;
      admissionFocusPending = false;
      interviewMessages.replaceChildren();
      interviewEmpty.hidden = true;
      interviewWarning.hidden = true;
      interviewError.hidden = true;
      interviewLoading.hidden = true;
      return;
    }

    const id = view.candidate;
    interviewCandidate.textContent =
      id === null ? "Unknown candidate" : shorten(id);
    if (id === null) interviewCandidate.removeAttribute("title");
    else interviewCandidate.title = id;
    interviewCandidate.setAttribute(
      "aria-label",
      id === null ? "Candidate unknown" : `Candidate ${id}`,
    );
    interviewStateLabel.textContent =
      id === null
        ? "Needs attention"
        : currentAdmission() !== null
          ? "Slot written"
          : "Interviewing";
    interviewStateLabel.dataset.state = id === null ? "warning" : "active";
    interviewWarning.hidden = view.warning === null;
    interviewWarning.textContent = view.warning ?? "";

    const admission = id === null ? null : currentAdmission();
    interviewAdmission.hidden = admission === null;
    interviewAdmissionResult.textContent = admission?.label ?? "";
    interviewAdmissionRegion.hidden = admission?.region === null ||
      admission?.region === undefined;
    interviewAdmissionRegion.textContent = admission?.region ?? "";

    if (admission === null) {
      admissionFocusKey = null;
    } else {
      const key = `${id}:${admission.slot}`;
      if (key !== admissionFocusKey) {
        admissionFocusKey = key;
        if (dialog.open) admissionFocusPending = true;
      }
    }

    const latest = latestInterview();
    const allMessages = current?.messages ?? [];
    const rows = interviewMessageRows(allMessages, latest);
    const atEpoch =
      latest === null
        ? 0
        : allMessages.filter((message) => message.epoch === latest.seq).length;
    interviewCount.textContent = roomMessageCountLabel(atEpoch, rows.length);

    interviewMessages.replaceChildren();
    for (const row of rows) {
      const item = document.createElement("li");
      item.className = "room-message";
      item.dataset.history = String(row.history);
      item.dataset.self = String(row.message.author === owner);

      const head = document.createElement("div");
      head.className = "room-message-head";

      const author = document.createElement("span");
      author.className = "room-message-author";
      author.textContent = interviewAuthorLabel(row.message.author);
      author.title = row.message.author;
      head.append(author);

      const cached = interviewViews.get(roomMessageId(row.message));
      const bodyView = interviewBodyView(row.message.body, cached);
      const encryption =
        bodyView === null ? "pending" : bodyView.kind;
      item.dataset.encryption = encryption;

      const badge = document.createElement("span");
      badge.className = "room-message-badge room-message-encryption";
      badge.dataset.state = encryption;
      badge.textContent =
        encryption === "encrypted"
          ? "Encrypted"
          : encryption === "plaintext"
            ? "Unencrypted"
            : encryption === "unreadable"
              ? "Not readable"
              : "Decrypting";
      head.append(badge);

      const time = document.createElement("time");
      time.className = "room-message-time";
      const iso = roomTimeIso(row.message.time);
      if (iso !== null) time.dateTime = iso;
      time.textContent = formatRoomTime(row.message.time);
      time.title = iso ?? "Unknown time";
      head.append(time);

      const body = document.createElement("p");
      body.className = "room-message-body";
      if (bodyView === null) {
        body.textContent = "Reading encrypted message…";
      } else if (bodyView.kind === "unreadable") {
        body.textContent = "Not readable for this epoch";
      } else {
        body.textContent = bodyView.text;
      }

      item.append(head, body);
      interviewMessages.append(item);
    }

    interviewEmpty.hidden = rows.length > 0 || loading;
    interviewEmpty.textContent = "No messages yet. Say hello.";

    const actionError = interviewActionError ?? zoneError;
    interviewError.hidden = actionError === null;
    interviewError.textContent = actionError ?? "";
    interviewLoading.hidden = !(loading && (current === null || !zoneLoaded));

    const lock = interviewLock();
    const encrypted = (latest?.secrets.length ?? 0) > 0;
    const limit = interviewComposerLimit(latest);
    const text = interviewInput.value;
    const bytes = roomByteLength(text);
    const over = bytes > limit;
    const problem = roomComposerProblem(text, limit);
    const canSend =
      id !== null &&
      latest !== null &&
      lock === null &&
      !busy &&
      !loading;

    interviewInput.disabled = !canSend;
    interviewInput.setAttribute("aria-invalid", over ? "true" : "false");
    interviewComposer.classList.toggle("is-over", over);
    interviewComposer.setAttribute(
      "aria-busy",
      String(sendingInterviewMessage),
    );
    interviewSend.disabled = !canSend || problem !== null;
    interviewSend.textContent = sendingInterviewMessage ? "Sending…" : "Send";
    interviewSend.setAttribute(
      "aria-busy",
      String(sendingInterviewMessage),
    );

    interviewHint.classList.toggle("is-warning", over && canSend);
    if (owner === null) {
      interviewHint.textContent = "Waiting for your identity.";
    } else if (loading) {
      interviewHint.textContent = "Reading the interview…";
    } else if (!zoneLoaded) {
      interviewHint.textContent = "Reading your zone…";
    } else if (lock !== null) {
      interviewHint.textContent = lock;
    } else if (latest === null) {
      interviewHint.textContent = "The interview has no signed membership yet.";
    } else if (over) {
      interviewHint.textContent = `Too long: ${bytes} / ${limit} bytes.`;
    } else {
      interviewHint.textContent = `${bytes} / ${limit} bytes${
        encrypted ? " (encrypted)" : ""
      }. Enter sends; Shift+Enter adds a line.`;
    }

    interviewComposerError.hidden = interviewComposerErrorText === null;
    interviewComposerError.textContent = interviewComposerErrorText ?? "";

    const canEnd = id !== null && latest !== null && !busy && !loading;
    interviewEnd.hidden = interviewEndingConfirm || finishingConfirm;
    interviewEnd.disabled = !canEnd;
    interviewEndConfirm.hidden = !interviewEndingConfirm;
    interviewEndConfirmText.textContent =
      id === null
        ? ""
        : `End the interview with ${shorten(id)}? This removes them from the candidate room. Old messages stay in the room.${
            admission === null
              ? ""
              : ` Slot ${admission.slot + 1} stays written in your zone; clear it from the editor if they do not join.`
          }`;
    interviewEndCancel.disabled = busy;
    interviewEndConfirmButton.disabled = busy;
    interviewEndConfirmButton.textContent = interviewWriting
      ? "Ending…"
      : "End interview";

    const canAdmit = id !== null && latest !== null && !busy && !loading;
    interviewAdmit.hidden = admission !== null || finishingConfirm;
    interviewAdmit.disabled = !canAdmit;
    interviewAdmit.setAttribute("aria-busy", "false");
    interviewFinish.hidden = admission === null || finishingConfirm;
    interviewFinish.disabled = admission === null || busy || loading;
    interviewFinishConfirm.hidden = !finishingConfirm;
    interviewFinishConfirmText.textContent =
      id === null
        ? ""
        : `Finish admission for ${shorten(id)}? The written slot stays in your zone. The candidate room drops them and rotates its keys; old messages stay as history.`;
    interviewFinishCancel.disabled = busy;
    interviewFinishConfirmButton.disabled = busy;
    interviewFinishConfirmButton.textContent = interviewWriting
      ? "Finishing…"
      : "Finish admission";

    interviewRefresh.disabled = busy || loading;
    interviewRefresh.textContent = loading ? "Refreshing…" : "Refresh";

    if (admissionFocusPending) {
      admissionFocusPending = false;
      interviewAdmissionResult.focus({ preventScroll: true });
    }

    if (id !== null) void ensureInterviewDecryption();
  }

  async function load(announceResult: boolean): Promise<void> {
    const owner = ownId();
    const token = (readToken += 1);
    const run = generation;

    if (owner === null) {
      current = null;
      loaded = false;
      loading = false;
      loadError = null;
      zoneState = null;
      zoneLoaded = false;
      zoneError = null;
      clearInterviewViews();
      render();
      return;
    }

    loading = true;
    loadError = null;
    zoneError = null;
    render();

    try {
      const [candidateResult, zoneResult, addressResult] =
        await Promise.allSettled([
          deps.transport.read(owner),
          deps.readOwnZone(),
          deps.ownAddress(),
        ]);
      if (token !== readToken || run !== generation) return;

      if (candidateResult.status === "fulfilled") {
        const state = candidateResult.value;
        current = state;
        loaded = true;
        loadError = null;
        const known = new Set(
          state === null
            ? []
            : state.requests.map((request) => candidateRequestId(request)),
        );
        for (const id of [...rowErrors.keys()]) {
          if (!known.has(id)) rowErrors.delete(id);
        }
      } else {
        loadError = requestsErrorText(candidateResult.reason, "read");
        deps.announce(loadError);
      }

      if (zoneResult.status === "fulfilled") {
        zoneState = zoneResult.value;
        zoneLoaded = true;
        zoneError = null;
      } else {
        zoneState = null;
        zoneLoaded = false;
        zoneError = requestsErrorText(zoneResult.reason, "zone");
        deps.announce(zoneError);
      }

      ownAddressValue =
        addressResult.status === "fulfilled" ? addressResult.value : null;

      const active = candidateView();
      const key =
        active.candidate === null
          ? null
          : `${active.candidate}:${latestInterview()?.seq ?? 0}`;
      if (key !== null && key !== announcedInterview) {
        deps.announce(
          `Interview with ${shortRequester(active.candidate!)} is active.`,
        );
      }
      announcedInterview = key;

      const admission = currentAdmission();
      const admissionKey =
        admission === null || active.candidate === null
          ? null
          : `${active.candidate}:${admission.slot}`;
      if (admission !== null && admissionKey !== announcedAdmission) {
        deps.announce(admissionAnnouncement(admission));
      }
      announcedAdmission = admissionKey;

      if (announceResult) {
        if (candidateResult.status === "fulfilled") {
          const state = candidateResult.value;
          deps.announce(
            state === null || state.requests.length === 0
              ? "Join request queue refreshed. No open requests."
              : `Join request queue refreshed. ${requestCountLabel(
                  state.requests.length,
                )}.`,
          );
        }
      }
    } finally {
      if (token === readToken && run === generation) {
        loading = false;
        render();
        showInterviewHeading();
      }
    }
  }

  async function ensureInterviewDecryption(): Promise<void> {
    if (interviewDecrypting) return;
    const owner = ownId();
    const state = current;
    if (owner === null || state === null || zoneState === null) return;
    const latest = latestCandidateMembership(state);
    if (latest === null) return;

    const rows = interviewMessageRows(state.messages, latest);
    const pending = rows.filter(
      (row) =>
        isEncryptedRoomBody(row.message.body) &&
        !interviewViews.has(roomMessageId(row.message)),
    );
    if (pending.length === 0) return;

    const generation = interviewGeneration;
    const roomId = deps.transport.roomIdFor(owner);
    interviewDecrypting = true;
    try {
      let key: Uint8Array | null = null;
      try {
        key = await deps.transport.epochKeyFor(owner, latest);
      } catch {
        // A missing or foreign blob is "not readable", never plaintext.
        key = null;
      }
      if (generation !== interviewGeneration) return;

      for (const row of pending) {
        const view = await readRoomBody(
          key,
          {
            roomId,
            owner,
            author: row.message.author,
            epoch: row.message.epoch,
            tag: INTERVIEW_TAG,
          },
          row.message.body,
        );
        if (generation !== interviewGeneration) return;
        interviewViews.set(roomMessageId(row.message), view);
      }
    } finally {
      interviewDecrypting = false;
    }

    if (generation === interviewGeneration && current === state) {
      render();
    }
  }

  async function startInterview(
    requestId: string,
    requester: string,
  ): Promise<void> {
    if (anyWriteBusy()) return;
    const owner = ownId();
    if (owner === null) return;
    const run = generation;

    interviewWriting = true;
    interviewStartingId = requestId;
    interviewActionError = null;
    interviewComposerErrorText = null;
    interviewEndingConfirm = false;
    rowErrors.delete(requestId);
    render();

    try {
      const [nextZone, nextCandidate] = await Promise.all([
        deps.readOwnZone(),
        deps.transport.read(owner),
      ]);
      if (run !== generation || ownId() !== owner) return;
      if (nextZone === null) {
        interviewActionError = "Your zone could not be read. Try again.";
        deps.announce(interviewActionError);
        return;
      }

      zoneState = nextZone;
      zoneLoaded = true;
      zoneError = null;
      current = nextCandidate;
      loaded = true;
      loadError = null;

      const reason = interviewBlockReason(
        current,
        nextZone,
        owner,
        requester,
      );
      if (reason !== null) {
        rowErrors.set(requestId, reason);
        deps.announce(reason);
        return;
      }

      const members = interviewMembers(owner, nextZone, requester);
      const afterInvite = await deps.transport.updateMembership(
        owner,
        members,
        { encrypt: true },
      );
      if (run !== generation || ownId() !== owner) return;
      current = afterInvite;
      loaded = true;
      invitedCandidate = requester;
      interviewFocusWanted = true;
      announcedInterview = `${requester}:${
        latestCandidateMembership(afterInvite)?.seq ?? 0
      }`;

      let warning: string | null = null;
      try {
        current = await deps.transport.dismiss(owner, requestId);
      } catch (error) {
        // The invite already landed; the request staying is a warning, not a
        // reason to roll the interview back.
        const dismissError = requestsErrorText(error, "dismiss");
        warning = `The interview started, but the request remains in the queue. ${dismissError}`;
        rowErrors.set(requestId, warning);
      }
      if (run !== generation || ownId() !== owner) return;
      deps.announce(
        warning ?? `Interview started with ${shortRequester(requester)}.`,
      );
    } catch (error) {
      if (run !== generation || ownId() !== owner) return;
      interviewActionError = requestsErrorText(error, "interview");
      deps.announce(interviewActionError);
    } finally {
      if (run === generation) {
        interviewWriting = false;
        interviewStartingId = null;
        render();
        showInterviewHeading();
      }
    }
  }

  async function admitCandidate(): Promise<void> {
    if (anyWriteBusy()) return;
    const candidate = candidateId();
    if (candidate === null) return;

    if (zoneState !== null && !hasFreeSlot()) {
      interviewActionError = ADMISSION_NO_FREE_SLOT;
      deps.announce(interviewActionError);
      render();
      return;
    }

    interviewActionError = null;
    finishingConfirm = false;
    render();

    try {
      await deps.openAdmit(candidate);
    } catch (error) {
      interviewActionError = requestsErrorText(error, "admit");
      deps.announce(interviewActionError);
      render();
    }
  }

  async function finishAdmission(): Promise<void> {
    if (anyWriteBusy()) return;
    const owner = ownId();
    const candidate = candidateId();
    if (owner === null || candidate === null) return;
    const run = generation;

    interviewWriting = true;
    finishingConfirm = false;
    interviewActionError = null;
    interviewComposerErrorText = null;
    render();

    try {
      const nextZone = await deps.readOwnZone();
      if (run !== generation || ownId() !== owner) return;
      if (nextZone === null) {
        interviewActionError =
          "Your zone could not be read, so admission was not finished.";
        deps.announce(interviewActionError);
        return;
      }

      zoneState = nextZone;
      zoneLoaded = true;
      zoneError = null;
      const members = admissionFinishMembers(owner, nextZone, candidate);
      const state = await deps.transport.updateMembership(owner, members, {
        encrypt: true,
      });
      if (run !== generation || ownId() !== owner) return;
      current = state;
      loaded = true;
      loadError = null;
      invitedCandidate = null;
      announcedInterview = null;
      announcedAdmission = null;
      admissionFocusKey = null;
      admissionFocusPending = false;
      clearInterviewViews();
      deps.announce("Admission finished.");
    } catch (error) {
      if (run !== generation || ownId() !== owner) return;
      interviewActionError = requestsErrorText(error, "finish");
      deps.announce(interviewActionError);
    } finally {
      if (run === generation) {
        interviewWriting = false;
        render();
        if (dialog.open) {
          if (!interviewVisible()) {
            queueTitle.focus({ preventScroll: true });
          } else {
            interviewFinish.focus({ preventScroll: true });
          }
        }
      }
    }
  }

  async function endInterview(): Promise<void> {
    if (anyWriteBusy()) return;
    const owner = ownId();
    if (owner === null) return;
    const candidate = candidateId();
    const run = generation;

    interviewWriting = true;
    interviewEndingConfirm = false;
    interviewActionError = null;
    interviewComposerErrorText = null;
    render();

    try {
      const nextZone = await deps.readOwnZone();
      if (run !== generation || ownId() !== owner) return;
      if (nextZone === null) {
        interviewActionError = "Your zone could not be read. Try again.";
        deps.announce(interviewActionError);
        return;
      }

      zoneState = nextZone;
      zoneLoaded = true;
      zoneError = null;
      const members = interviewRemainingMembers(owner, nextZone);
      const state = await deps.transport.updateMembership(owner, members, {
        encrypt: true,
      });
      if (run !== generation || ownId() !== owner) return;
      current = state;
      loaded = true;
      loadError = null;
      invitedCandidate = null;
      announcedInterview = null;
      announcedAdmission = null;
      clearInterviewViews();
      const writtenSlot =
        candidate === null ? null : admissionSlot(nextZone, candidate);
      deps.announce(
        writtenSlot === null
          ? "Interview ended."
          : `Interview ended. Slot ${writtenSlot + 1} stays written in your zone; clear it from the editor if they do not join.`,
      );
    } catch (error) {
      if (run !== generation || ownId() !== owner) return;
      interviewActionError = requestsErrorText(error, "end");
      deps.announce(interviewActionError);
    } finally {
      if (run === generation) {
        interviewWriting = false;
        render();
        if (dialog.open) queueTitle.focus({ preventScroll: true });
      }
    }
  }

  async function sendInterviewMessage(): Promise<void> {
    if (anyWriteBusy()) return;
    const owner = ownId();
    if (owner === null) return;
    const candidate = candidateId();
    const latest = latestInterview();
    if (candidate === null || latest === null) return;

    const lock = interviewMembershipLock(
      owner,
      zoneState,
      candidate,
      latest,
    );
    if (lock !== null) {
      interviewComposerErrorText = lock;
      render();
      interviewInput.focus({ preventScroll: true });
      return;
    }

    const limit = interviewComposerLimit(latest);
    const text = interviewInput.value;
    const problem = roomComposerProblem(text, limit);
    if (problem !== null) {
      interviewComposerErrorText = problem;
      render();
      interviewInput.focus({ preventScroll: true });
      return;
    }

    const run = generation;
    sendingInterviewMessage = true;
    interviewComposerErrorText = null;
    render();

    try {
      const next = await deps.transport.sendMessage(
        owner,
        new TextEncoder().encode(text),
      );
      if (run !== generation || ownId() !== owner) return;
      current = next;
      loaded = true;
      loadError = null;
      interviewInput.value = "";
      deps.announce("Message sent.");
    } catch (error) {
      if (run !== generation || ownId() !== owner) return;
      interviewComposerErrorText = requestsErrorText(error, "message");
      deps.announce(interviewComposerErrorText);
    } finally {
      if (run === generation) {
        sendingInterviewMessage = false;
        render();
        if (dialog.open) interviewInput.focus({ preventScroll: true });
      }
    }
  }


  async function setAccepting(desired: boolean): Promise<void> {
    if (anyWriteBusy()) return;
    const owner = ownId();
    if (owner === null) return;
    if (desired === acceptingValue()) {
      render();
      return;
    }

    const run = generation;
    acceptingBusy = true;
    acceptingPending = desired;
    acceptingErrorText = null;
    render();

    try {
      const state = await deps.transport.setAccepting(owner, desired);
      if (run !== generation || ownId() !== owner) return;
      current = state;
      loaded = true;
      loadError = null;
      rowErrors.clear();
      deps.announce(
        desired ? "Accepting join requests." : "Not accepting join requests.",
      );
    } catch (error) {
      if (run !== generation || ownId() !== owner) return;
      acceptingErrorText = requestsErrorText(error, "accepting");
      deps.announce(acceptingErrorText);
    } finally {
      if (run === generation) {
        acceptingBusy = false;
        acceptingPending = null;
        render();
      }
    }
  }

  async function dismissRequest(id: string): Promise<void> {
    if (anyWriteBusy()) return;
    const owner = ownId();
    if (owner === null) return;
    const run = generation;

    dismissing = id;
    rowErrors.delete(id);
    render();

    try {
      const state = await deps.transport.dismiss(owner, id);
      if (run !== generation || ownId() !== owner) return;
      current = state;
      loaded = true;
      loadError = null;
      deps.announce("Join request dismissed.");
    } catch (error) {
      if (run !== generation || ownId() !== owner) return;
      rowErrors.set(id, requestsErrorText(error, "dismiss"));
      deps.announce("The join request was not dismissed.");
    } finally {
      if (run === generation) {
        dismissing = null;
        render();
        focusQueueEnd();
      }
    }
  }

  async function clearAll(): Promise<void> {
    if (anyWriteBusy()) return;
    const owner = ownId();
    if (owner === null) return;
    const ids = rowIds();
    if (ids.length === 0) {
      clearConfirmPending = false;
      render();
      return;
    }

    const run = generation;
    clearing = true;
    clearConfirmPending = false;
    clearMessage = null;
    rowErrors = new Map();
    render();

    try {
      const result = await dismissSequentially(
        ids,
        (id) => deps.transport.dismiss(owner, id),
        () => run !== generation || ownId() !== owner,
      );

      if (run !== generation || ownId() !== owner) return;

      if (result.state !== null) {
        current = result.state;
        loaded = true;
        loadError = null;
      }
      for (const failure of result.failed) {
        rowErrors.set(
          failure.id,
          requestsErrorText(failure.error, "dismiss"),
        );
      }
      const remaining =
        current?.requests.length ?? ids.length - result.cleared.length;
      clearMessage = clearSummary(result.cleared.length, remaining);
      deps.announce(clearMessage);
    } finally {
      if (run === generation) {
        clearing = false;
        render();
        focusQueueEnd();
      }
    }
  }

  async function copyRootId(): Promise<void> {
    const owner = ownId();
    if (owner === null || copying) return;
    const id = shareRootId(owner);
    const run = generation;

    copying = true;
    copied = false;
    manualId = null;
    render();

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("the clipboard is unavailable");
      }
      await navigator.clipboard.writeText(id);
      if (run !== generation) return;
      copied = true;
      deps.announce(rootIdCopyAnnouncement("copied"));
    } catch {
      if (run !== generation) return;
      manualId = id;
      deps.announce(rootIdCopyAnnouncement("manual"));
    } finally {
      if (run === generation) {
        copying = false;
        render();
        if (manualId !== null) {
          linkInput.focus({ preventScroll: true });
          linkInput.select();
        }
      }
    }
  }

  function open(): void {
    generation += 1;
    readToken += 1;
    current = null;
    loaded = false;
    loading = false;
    loadError = null;
    zoneState = null;
    zoneLoaded = false;
    zoneError = null;
    ownAddressValue = null;
    // Keep `invitedCandidate`: closing and reopening the panel must not lose an
    // admission handoff once the written slot makes the candidate a child.
    interviewWriting = false;
    interviewStartingId = null;
    interviewActionError = null;
    interviewEndingConfirm = false;
    finishingConfirm = false;
    sendingInterviewMessage = false;
    interviewComposerErrorText = null;
    interviewFocusWanted = true;
    announcedInterview = null;
    announcedAdmission = null;
    admissionFocusKey = null;
    admissionFocusPending = false;
    clearInterviewViews();
    acceptingBusy = false;
    acceptingPending = null;
    acceptingErrorText = null;
    dismissing = null;
    rowErrors = new Map();
    clearing = false;
    clearConfirmPending = false;
    clearMessage = null;
    copying = false;
    copied = false;
    manualId = null;
    liveStatus = "";

    render();

    if (!dialog.open) {
      const active = document.activeElement;
      lastFocus =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      dialog.showModal();
    }
    title.focus({ preventScroll: true });
    void load(false);
  }

  function refresh(): void {
    if (!dialog.open) return;
    clearMessage = null;
    clearConfirmPending = false;
    interviewActionError = null;
    interviewComposerErrorText = null;
    interviewEndingConfirm = false;
    finishingConfirm = false;
    void load(true);
  }

  function close(): void {
    if (dialog.open) dialog.close();
  }

  acceptingForm.addEventListener("submit", (event) => {
    event.preventDefault();
  });

  acceptingToggle.addEventListener("change", () => {
    void setAccepting(acceptingToggle.checked);
  });

  refreshButton.addEventListener("click", () => {
    refresh();
  });

  retryButton.addEventListener("click", () => {
    refresh();
  });

  clearButton.addEventListener("click", () => {
    if (clearButton.hidden || clearing) return;
    clearConfirmPending = true;
    clearMessage = null;
    render();
    clearConfirmButton.focus({ preventScroll: true });
  });

  clearCancel.addEventListener("click", () => {
    clearConfirmPending = false;
    render();
    clearButton.focus({ preventScroll: true });
  });

  clearConfirmButton.addEventListener("click", () => {
    void clearAll();
  });

  copyButton.addEventListener("click", () => {
    void copyRootId();
  });

  interviewRefresh.addEventListener("click", () => {
    refresh();
  });

  interviewEnd.addEventListener("click", () => {
    if (interviewEnd.hidden || interviewEnd.disabled) return;
    interviewEndingConfirm = true;
    finishingConfirm = false;
    render();
    interviewEndConfirmButton.focus({ preventScroll: true });
  });

  interviewEndCancel.addEventListener("click", () => {
    interviewEndingConfirm = false;
    render();
    interviewEnd.focus({ preventScroll: true });
  });

  interviewEndConfirmButton.addEventListener("click", () => {
    void endInterview();
  });

  interviewAdmit.addEventListener("click", () => {
    if (interviewAdmit.hidden || interviewAdmit.disabled) return;
    void admitCandidate();
  });

  interviewFinish.addEventListener("click", () => {
    if (interviewFinish.hidden || interviewFinish.disabled) return;
    finishingConfirm = true;
    interviewEndingConfirm = false;
    render();
    interviewFinishConfirmButton.focus({ preventScroll: true });
  });

  interviewFinishCancel.addEventListener("click", () => {
    finishingConfirm = false;
    render();
    interviewFinish.focus({ preventScroll: true });
  });

  interviewFinishConfirmButton.addEventListener("click", () => {
    void finishAdmission();
  });

  interviewComposer.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendInterviewMessage();
  });

  interviewInput.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      !interviewInput.disabled
    ) {
      event.preventDefault();
      interviewComposer.requestSubmit();
    }
  });

  interviewInput.addEventListener("input", () => {
    if (interviewComposerErrorText !== null) {
      interviewComposerErrorText = null;
      interviewComposerError.hidden = true;
      interviewComposerError.textContent = "";
    }
    render();
  });

  closeButton.addEventListener("click", close);
  doneButton.addEventListener("click", close);
  openButton.addEventListener("click", open);

  dialog.addEventListener("close", () => {
    generation += 1;
    readToken += 1;
    loading = false;
    acceptingBusy = false;
    acceptingPending = null;
    dismissing = null;
    clearing = false;
    clearConfirmPending = false;
    interviewWriting = false;
    interviewStartingId = null;
    interviewEndingConfirm = false;
    finishingConfirm = false;
    sendingInterviewMessage = false;
    interviewFocusWanted = false;
    admissionFocusPending = false;
    clearInterviewViews();
    const target = lastFocus;
    lastFocus = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  });

  render();

  return { open, refresh, close };
}
