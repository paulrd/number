/**
 * Discovery surface for a `?root=` invite (P4c2).
 *
 * The dialog is a thin DOM view over `region/onboarding.ts`: validate a root,
 * pick a point, show the walk to the target, preview the assigned cell, and
 * write one signed request into the target's candidate room. The map is loaded
 * lazily and is decorative; the coordinate form and the lists are the keyboard
 * path.
 */

import {
  admissionCodeAddress,
  admissionCodeFromInput,
  admissionFailureText,
  crossCheckAdmission,
  encodeAdmissionCode,
  verifyAdmissionCode,
  type AdmissionCode,
  type AdmissionCrossCheck,
  type AdmissionResult,
} from "./admission";
import type { BoardSnapshot } from "./board";
import type { CandidateTransport } from "./candidate-client";
import {
  CANDIDATE_MAX_NOTE_BYTES,
  CANDIDATE_MAX_REQUESTS,
  candidateNoteToText,
  candidateRequestId,
  isAccepting,
  latestCandidateMembership,
  textToCandidateNote,
  type CandidateMembershipV1,
  type CandidateRequestV1,
  type CandidateStateV1,
} from "./candidate-state";
import {
  admissionAddress,
  admissionBlockReason,
  joinCheck,
  type JoinCheck,
} from "./candidate-interview";
import {
  INTERVIEW_TAG,
  interviewBodyView,
  interviewComposerLimit,
  interviewMembershipLock,
  interviewMessageRows,
} from "./requests-panel";
import {
  formatRoomTime,
  roomByteLength,
  roomComposerProblem,
  roomMessageCountLabel,
  roomTimeIso,
  type RoomMessageRow,
} from "./room-panel";
import { roomMessageId } from "./room-state";
import {
  isEncryptedRoomBody,
  readRoomBody,
  type RoomBodyView,
} from "./room-crypto";
import type { StateV3 } from "./state";
import { emptyState } from "./state";
import {
  BlobReader,
  ContractSource,
  FixtureSource,
  contractKeyFromInstance,
  type RegionSource,
} from "./region/source";
import {
  REGIONS_MANIFEST_CODE_HASH,
  REGIONS_MANIFEST_INSTANCE,
} from "./region/constants";
import { RegionDataset } from "./region/dataset";
import { buildFixture } from "./region/fixture";
import {
  findTarget,
  parseRootInput,
  resolveZoneAddress,
  validateRoot,
  type ChainZone,
  type MatchResult,
  type ZoneReader,
} from "./region/onboarding";
import { resolveZoneRegion, type SlotOccupancy } from "./region/zone-region";
import type { RegionRow } from "./region/wire";
import { errorMessage, shorten, utf8Length } from "./util";
import type { LatLngExpression, LatLngTuple, LayerGroup, Map } from "leaflet";
import type { GeometryCollection, Topology } from "topojson-specification";

type LeafletModule = typeof import("leaflet");
type TargetMatch = Extract<MatchResult, { kind: "target" }>;
type SaturatedMatch = Extract<MatchResult, { kind: "saturated" }>;

export interface OnboardingPanelDeps {
  /** Read one zone by owner id; the onboarding walk uses board snapshots. */
  readBoard(ownerId: string): Promise<BoardSnapshot | null>;
  /** Candidate-room transport for the target's queue and the request write. */
  transport: CandidateTransport;
  /** The requester's own owner id, or null while the identity is not ready. */
  selfId(): string | null;
  /** Subscribe to a target zone's updates; the returned cleanup is idempotent. */
  watchBoard(ownerId: string, onChange: () => void): () => void;
  /** Write the consent signature: this zone's parent is the target zone. */
  saveParent(targetOwnerId: string): Promise<void>;
  announce(message: string): void;
  /** Called when the dialog closes or admission completes: drop `?root=`. */
  onSettled(): void;
  /**
   * Verify a pasted admission code. Defaults to the real signature check; the
   * offline harness supplies a stub.
   */
  verifyAdmission?: (
    text: string,
    options: { candidate: string | null; expectedOwner?: string | null },
  ) => Promise<AdmissionResult>;
}

export interface OnboardingPanel {
  /** Open with a raw link/id to prefill, or null for an empty field. */
  open(prefill?: string | null): void;
  close(): void;
}

const NOTE_LIMIT = CANDIDATE_MAX_NOTE_BYTES;
const QUEUE_LIMIT = CANDIDATE_MAX_REQUESTS;
const WORLD_VIEW: LatLngExpression = [20, 0];
const WORLD_ZOOM = 1;
const LETTERS = "abcdefgh";

let map: Map | null = null;
let layer: LayerGroup | null = null;
let leaflet: LeafletModule | null = null;

/** `12 / 256 bytes`, or a warning when the note is too long. */
export function noteByteLabel(note: string): string {
  const bytes = utf8Length(note);
  if (bytes > NOTE_LIMIT) {
    return `${bytes} / ${NOTE_LIMIT} bytes — too long`;
  }
  return `${bytes} / ${NOTE_LIMIT} bytes`;
}

/** `world` for the empty cell, otherwise `cell 012`. */
export function formatWantCell(wantCell: string): string {
  return wantCell === "" ? "world" : `cell ${wantCell}`;
}

/** `root` for the empty address, otherwise the octal address. */
export function chainAddress(address: string): string {
  return address === "" ? "root" : address;
}

/** A local sentence for the reasons `validateRoot` returns. */
export function rootErrorText(reason: string): string {
  if (/mutual parent/.test(reason)) {
    return "That id belongs to a child zone, not a root. Ask for the root's link instead.";
  }
  if (/unreadable/.test(reason)) {
    return "That zone could not be read. Check the link or root id and try again.";
  }
  if (/64 lowercase hex/.test(reason)) {
    return "A root id is 64 lowercase hex characters.";
  }
  return `That root could not be used: ${reason}.`;
}

/**
 * Accepting state and queue count for the candidate room, in one line. A
 * missing state is the contract's initial state: accepting, with no queue.
 */
export function candidateStatusLine(state: CandidateStateV1 | null): string {
  const accepting = state === null || isAccepting(state);
  const waiting = state?.requests.length ?? 0;
  const verb = accepting ? "Accepting requests" : "Not accepting requests";
  return `${verb} · ${waiting} of ${QUEUE_LIMIT} waiting`;
}

/** A readable request failure; no contract detail is hidden in a toast. */
export function requestErrorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "connection") {
    return "Could not reach the zone's request queue. Check your connection and try again.";
  }
  if (code === "write") {
    return "The zone did not accept the request. Try again in a moment.";
  }
  if (code === "sign") {
    return "The request could not be signed. Make sure your identity is ready, then try again.";
  }
  if (code === "read") {
    return "The request was sent, but its confirmation could not be read. Reopen this screen to check.";
  }
  if (code === "wasm" || code === "config") {
    return "The request room could not be prepared. Rebuild the app and try again.";
  }
  return `The request could not be sent: ${errorMessage(error)}`;
}

/**
 * The request id of the newest queue entry matching this requester, cell and
 * note. Offline and online transports both return the state after the write.
 */
export function requestIdFor(
  state: CandidateStateV1,
  requester: string,
  wantCell: string,
  note: string,
): string | null {
  const encoded = textToCandidateNote(note);
  let best: { id: string; time: number } | null = null;
  for (const request of state.requests) {
    if (
      request.requester !== requester ||
      request.want_cell !== wantCell ||
      request.note !== encoded
    ) {
      continue;
    }
    const id = candidateRequestId(request);
    if (best === null || request.time >= best.time) {
      best = { id, time: request.time };
    }
  }
  if (best !== null) return best.id;

  // A non-canonical note encoding is unlikely, but the id still comes from the
  // requester's newest entry rather than a guessed value.
  let newest: { id: string; time: number } | null = null;
  for (const request of state.requests) {
    if (request.requester !== requester) continue;
    const id = candidateRequestId(request);
    if (newest === null || request.time >= newest.time) {
      newest = { id, time: request.time };
    }
  }
  return newest?.id ?? null;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

/** The three pending states the join link can show; `none` returns to place. */
export type JoinStatusKind = "queued" | "invited" | "admitted";

/** The sentence announced and shown when a status view opens. */
export function joinStatusMessage(kind: JoinStatusKind): string {
  if (kind === "queued") return "Request sent. Waiting for the owner.";
  if (kind === "invited") return "You're invited to interview.";
  return "You've been admitted";
}

/** `Slot 3` with a one-based label. */
export function admittedSlotLabel(slot: number): string {
  return `Slot ${slot + 1}`;
}

/** `zero-based digit 2, cell c` for an admitted slot. */
export function admittedDigitLabel(slot: number): string {
  return `zero-based digit ${slot}, cell ${LETTERS[slot] ?? "?"}`;
}

/**
 * The assigned address, or null when the target address could not be resolved.
 * A root address is the empty string, so the address is just the digit.
 */
export function admittedAddressText(
  targetAddress: string | null,
  slot: number,
): string | null {
  return targetAddress === null ? null : admissionAddress(targetAddress, slot);
}

/** The displayed note for a queued request, including the empty case. */
export function requestNoteDisplay(noteHex: string): string {
  try {
    const text = candidateNoteToText(noteHex);
    return text.trim() === "" ? "(no note)" : text;
  } catch {
    return "Unreadable note";
  }
}

/** A chat author label from the candidate's point of view. */
export function interviewAuthorLabel(
  author: string,
  selfId: string | null,
  targetId: string,
): string {
  if (selfId !== null && author === selfId) return "You";
  if (author === targetId) return "Owner";
  return `Member ${author.slice(0, 8)}`;
}

/** Readable interview write failures. */
export function interviewErrorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "connection") {
    return "The message was not sent. Check your connection and try again.";
  }
  if (code === "sign") {
    return "The message could not be signed. Make sure your identity is ready, then try again.";
  }
  if (code === "not-member") {
    return "You are no longer in the interview. Check again to see where you stand.";
  }
  if (code === "crypto") {
    return "The message could not be encrypted. Check again and try once more.";
  }
  return `The message was not sent: ${errorMessage(error)}`;
}

/** Readable status-check and consent failures. */
export function statusErrorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "connection") {
    return "Your join status could not be read while offline. Check your connection and try again.";
  }
  return `Your join status could not be read: ${errorMessage(error)}`;
}

export function signJoinErrorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "connection") {
    return "The join could not be signed while offline. Check your connection and try again.";
  }
  if (code === "sign") {
    return "The join could not be signed. Make sure your identity is ready, then try again.";
  }
  return `The join was not signed: ${errorMessage(error)}`;
}

function isOffline(): boolean {
  return import.meta.env.VITE_OFFLINE_MODE === "1";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function occupancyFor(zone: ChainZone): SlotOccupancy[] {
  const free = new Set(zone.freeSlots);
  return Array.from({ length: 8 }, (_, slot) =>
    free.has(slot) ? "free" : "taken",
  );
}

/** The zone that holds this requester's request, invite or slot. */
interface StatusTarget {
  targetId: string;
  targetZone: StateV3;
  candidateState: CandidateStateV1 | null;
  check: Exclude<JoinCheck, { kind: "none" }>;
}

/** Where an admitted view's designation came from. */
type StatusSource = "zone" | "code";

/** Everything one pending view needs, after the four reads. */
interface StatusModel {
  kind: JoinStatusKind;
  targetId: string;
  /** Null only for a code-based admitted view whose owner zone is unreadable. */
  targetZone: StateV3 | null;
  candidateState: CandidateStateV1 | null;
  address: string | null;
  ownZone: StateV3 | null;
  request: CandidateRequestV1 | null;
  slot: number | null;
  completed: boolean;
  /** The portable credential, when the view came from an admission code. */
  admission: AdmissionCode | null;
  source: StatusSource;
  /** Freshness cross-check of the code against the best-effort owner read. */
  crossCheck: AdmissionCrossCheck | null;
  /** The raw code text, so Check again can repeat the code path. */
  codeText: string | null;
}

/** How many zones a link-only status search may read. */
const MAX_STATUS_ZONES = 32;

/** The join link's optional target hint: exactly one 64-hex `target` param. */
export function parseTargetHint(search: string): string | null {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const values = new URLSearchParams(query).getAll("target");
  if (values.length !== 1) return null;
  const value = values[0]!;
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/**
 * Which owner a pasted admission code must name. Prefer the `target` hint: the
 * shared `?root=` can be an ancestor of the zone that actually admitted the
 * candidate (the match walk descends), and a code from that zone must not be
 * refused as "a different zone".
 */
export function expectedAdmissionOwner(
  search: string,
  rootId: string | null,
): string | null {
  return parseTargetHint(search) ?? rootId ?? null;
}

/** Remove the join link's root, target and admission hints, keeping the rest. */
export function stripJoinParams(url: URL): void {
  url.searchParams.delete("root");
  url.searchParams.delete("target");
  url.searchParams.delete("admit");
}

type StatusSearchResult =
  | { kind: "found"; target: StatusTarget }
  | { kind: "none" }
  | { kind: "error"; error: unknown };

export interface StatusWatchOptions {
  /** Subscribe to one target zone; the returned cleanup is called once. */
  watchBoard(ownerId: string, onChange: () => void): () => void;
  /** Re-read the watched target after a debounced notification. */
  recheck(targetId: string): void;
  /** True while a status check is in flight, so a notification can wait. */
  isBusy(): boolean;
  debounceMs?: number;
  setTimeout?(callback: () => void, milliseconds: number): number;
  clearTimeout?(handle: number): void;
}

export interface StatusWatch {
  /** Watch one target, or null to stop. Repeating a target is a no-op. */
  setTarget(targetId: string | null): void;
  /** Schedule a re-check that arrived while a status check was in flight. */
  settled(): void;
  /** Stop the watch and cancel any pending re-check. Idempotent. */
  stop(): void;
  /** The currently watched target, or null. */
  target(): string | null;
}

/**
 * One target-zone watch at a time, with a debounce and a single pending
 * re-check. DOM-free so the lifecycle is unit-testable; the panel supplies the
 * real subscription and status check.
 */
export function createStatusWatch(options: StatusWatchOptions): StatusWatch {
  const schedule =
    options.setTimeout ??
    ((callback, milliseconds) =>
      globalThis.setTimeout(callback, milliseconds) as unknown as number);
  const cancel = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
  const debounceMs = options.debounceMs ?? 500;

  let cleanup: (() => void) | null = null;
  let active: string | null = null;
  let timer: number | null = null;
  let pending = false;

  function clearTimer(): void {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }

  function stop(): void {
    clearTimer();
    pending = false;
    active = null;
    if (cleanup !== null) {
      const run = cleanup;
      cleanup = null;
      run();
    }
  }

  function arm(): void {
    if (timer !== null || active === null) return;
    timer = schedule(() => {
      timer = null;
      if (active === null) return;
      if (options.isBusy()) {
        pending = true;
        return;
      }
      pending = false;
      options.recheck(active);
    }, debounceMs);
  }

  function onUpdate(): void {
    if (active === null) return;
    if (options.isBusy()) {
      pending = true;
      return;
    }
    arm();
  }

  function setTarget(targetId: string | null): void {
    if (targetId === active) return;
    stop();
    if (targetId === null) return;
    active = targetId;
    try {
      const stopFn = options.watchBoard(targetId, onUpdate);
      cleanup = typeof stopFn === "function" ? stopFn : null;
    } catch {
      // A failed subscription leaves Check again as the fallback.
      cleanup = null;
    }
  }

  function settled(): void {
    if (!pending || options.isBusy()) return;
    pending = false;
    arm();
  }

  return { setTarget, settled, stop, target: () => active };
}

export function createOnboardingPanel(
  deps: OnboardingPanelDeps,
): OnboardingPanel {
  const dialog = byId<HTMLDialogElement>("join-dialog");
  const title = byId<HTMLHeadingElement>("join-title");
  const closeButton = byId<HTMLButtonElement>("join-close");

  const rootStep = byId<HTMLElement>("join-root-step");
  const rootTitle = byId<HTMLHeadingElement>("join-root-title");
  const rootForm = byId<HTMLFormElement>("join-root-form");
  const rootInput = byId<HTMLInputElement>("join-root-input");
  const rootContinue = byId<HTMLButtonElement>("join-root-continue");
  const rootError = byId<HTMLElement>("join-root-error");
  const rootStatus = byId<HTMLElement>("join-root-status");

  const discovery = byId<HTMLElement>("join-discovery");
  const placeTitle = byId<HTMLHeadingElement>("join-place-title");
  const placeForm = byId<HTMLFormElement>("join-place-form");
  const latInput = byId<HTMLInputElement>("join-lat");
  const lngInput = byId<HTMLInputElement>("join-lng");
  const pointButton = byId<HTMLButtonElement>("join-point");
  const placeStatus = byId<HTMLElement>("join-place-status");
  const placeCheck = byId<HTMLButtonElement>("join-place-check");
  const placeError = byId<HTMLElement>("join-place-error");
  const mapElement = byId<HTMLElement>("join-map");
  const mapFallback = byId<HTMLElement>("join-map-fallback");

  const loading = byId<HTMLElement>("join-loading");
  const result = byId<HTMLElement>("join-result");
  const resultTitle = byId<HTMLHeadingElement>("join-result-title");
  const resultLede = byId<HTMLElement>("join-result-lede");
  const chainList = byId<HTMLOListElement>("join-chain");

  const targetArea = byId<HTMLElement>("join-target-area");
  const targetId = byId<HTMLElement>("join-target-id");
  const targetAddress = byId<HTMLElement>("join-target-address");
  const targetSlots = byId<HTMLElement>("join-target-slots");
  const targetAccepting = byId<HTMLElement>("join-target-accepting");

  const assignedBadge = byId<HTMLElement>("join-assigned-badge");
  const assignedSlot = byId<HTMLElement>("join-assigned-slot");
  const assignedDigit = byId<HTMLElement>("join-assigned-digit");
  const assignedAddress = byId<HTMLElement>("join-assigned-address");
  const assignedWarning = byId<HTMLElement>("join-assigned-warning");

  const requestForm = byId<HTMLFormElement>("join-request-form");
  const noteInput = byId<HTMLTextAreaElement>("join-note");
  const noteCount = byId<HTMLElement>("join-note-count");
  const publicId = byId<HTMLElement>("join-public-id");
  const publicCell = byId<HTMLElement>("join-public-cell");
  const publicNote = byId<HTMLElement>("join-public-note");
  const submitButton = byId<HTMLButtonElement>("join-submit");
  const requestError = byId<HTMLElement>("join-request-error");
  const requestBlocked = byId<HTMLElement>("join-request-blocked");
  const requestSuccess = byId<HTMLElement>("join-request-success");
  const requestId = byId<HTMLElement>("join-request-id");

  const saturatedArea = byId<HTMLElement>("join-saturated-area");
  const saturatedTitle = byId<HTMLHeadingElement>("join-saturated-title");
  const saturatedReason = byId<HTMLElement>("join-saturated-reason");
  const tryAnother = byId<HTMLButtonElement>("join-try-another");

  const statusStep = byId<HTMLElement>("join-status-step");
  const statusTitle = byId<HTMLHeadingElement>("join-status-title");
  const statusLede = byId<HTMLElement>("join-status-lede");
  const statusLoading = byId<HTMLElement>("join-status-loading");
  const statusError = byId<HTMLElement>("join-status-error");
  const statusQueued = byId<HTMLElement>("join-status-queued");
  const statusSelf = byId<HTMLElement>("join-status-self");
  const statusCell = byId<HTMLElement>("join-status-cell");
  const statusNote = byId<HTMLElement>("join-status-note");

  const statusInvited = byId<HTMLElement>("join-status-invited");
  const interviewTarget = byId<HTMLElement>("join-interview-target");
  const interviewCount = byId<HTMLElement>("join-interview-count");
  const interviewWarning = byId<HTMLElement>("join-interview-warning");
  const interviewLoading = byId<HTMLElement>("join-interview-loading");
  const interviewEmpty = byId<HTMLElement>("join-interview-empty");
  const interviewMessages = byId<HTMLOListElement>("join-interview-messages");
  const interviewComposer = byId<HTMLFormElement>("join-interview-composer");
  const interviewInput = byId<HTMLTextAreaElement>("join-interview-input");
  const interviewHint = byId<HTMLElement>("join-interview-hint");
  const interviewSend = byId<HTMLButtonElement>("join-interview-send");
  const interviewComposerError = byId<HTMLElement>("join-interview-error");

  const statusAdmitted = byId<HTMLElement>("join-status-admitted");
  const admittedBadge = byId<HTMLElement>("join-admitted-badge");
  const admittedSlot = byId<HTMLElement>("join-admitted-slot");
  const admittedDigit = byId<HTMLElement>("join-admitted-digit");
  const admittedAddressEl = byId<HTMLElement>("join-admitted-address");
  const admittedSource = byId<HTMLElement>("join-admitted-source");
  const admittedOwner = byId<HTMLElement>("join-admitted-owner");
  const admittedBlocked = byId<HTMLElement>("join-admitted-blocked");
  const admittedError = byId<HTMLElement>("join-admitted-error");
  const admittedSign = byId<HTMLButtonElement>("join-admitted-sign");
  const admittedDone = byId<HTMLElement>("join-admitted-done");
  const admittedDoneText = byId<HTMLElement>("join-admitted-done-text");

  const statusActions = byId<HTMLElement>("join-status-actions");
  const statusCheck = byId<HTMLButtonElement>("join-status-check");

  let rootId: string | null = null;
  let currentMatch: TargetMatch | null = null;
  let step: "root" | "place" | "status" | "result" = "root";
  let flowGeneration = 0;
  let candidateGeneration = 0;
  let busy = false;
  let pending = false;
  let submitted = false;

  type CandidateRead =
    | { kind: "loading" }
    | { kind: "ready"; state: CandidateStateV1 | null }
    | { kind: "error" };
  let candidateRead: CandidateRead = { kind: "loading" };

  let statusModel: StatusModel | null = null;
  let statusGeneration = 0;
  let statusBusy = false;
  let interviewViews = new globalThis.Map<string, RoomBodyView>();
  let interviewDecrypting = false;
  let sending = false;
  let interviewComposerErrorText: string | null = null;
  let signingJoin = false;

  const statusWatch = createStatusWatch({
    watchBoard: deps.watchBoard,
    isBusy: () => statusBusy,
    recheck: (targetId) => {
      void checkStatus({
        focus: false,
        announceCheck: false,
        targetId,
      });
    },
  });

  let datasetPromise: Promise<RegionDataset> | null = null;
  let mapPromise: Promise<boolean> | null = null;
  let lastFocus: HTMLElement | null = null;

  const reader: ZoneReader = async (ownerId) => {
    const snapshot = await deps.readBoard(ownerId);
    if (snapshot === null) return null;
    return { ownerId: snapshot.ownerId, state: snapshot.state };
  };

  function setStep(
    next: "root" | "place" | "status" | "result",
    focus: boolean,
  ): void {
    step = next;
    rootStep.hidden = next !== "root";
    discovery.hidden = next === "root" || next === "status";
    statusStep.hidden = next !== "status";
    result.hidden = next !== "result";
    if (next !== "result") {
      targetArea.hidden = true;
      saturatedArea.hidden = true;
    }
    if (next === "place") loading.hidden = true;
    if (next === "root") {
      loading.hidden = true;
      clearMap();
    }
    if (focus) {
      const heading =
        next === "root"
          ? rootTitle
          : next === "place"
            ? placeTitle
            : next === "status"
              ? statusTitle
              : resultTitle;
      heading.focus({ preventScroll: false });
    }
  }

  function open(prefill: string | null = null): void {
    flowGeneration += 1;
    candidateGeneration += 1;
    statusGeneration += 1;
    rootId = null;
    currentMatch = null;
    busy = false;
    pending = false;
    submitted = false;
    candidateRead = { kind: "loading" };
    statusModel = null;
    statusBusy = false;
    interviewViews = new globalThis.Map();
    interviewDecrypting = false;
    sending = false;
    interviewComposerErrorText = null;
    signingJoin = false;

    rootInput.value = prefill ?? "";
    rootInput.removeAttribute("aria-invalid");
    rootContinue.textContent = "Continue";
    rootError.hidden = true;
    rootError.textContent = "";
    rootStatus.textContent = "";
    placeError.hidden = true;
    placeError.textContent = "";
    placeStatus.textContent = "";
    requestError.hidden = true;
    requestError.textContent = "";
    requestBlocked.hidden = true;
    requestBlocked.textContent = "";
    requestSuccess.hidden = true;
    requestId.textContent = "";
    requestForm.reset();
    noteInput.disabled = false;
    noteInput.value = "";
    latInput.value = "";
    lngInput.value = "";
    chainList.replaceChildren();
    targetArea.hidden = true;
    saturatedArea.hidden = true;
    loading.hidden = true;
    resetStatusView();
    setStep("root", false);
    updateNote();
    refreshRequestState();
    if (!map || !layer) {
      mapFallback.hidden = true;
      mapElement.dataset.state = "";
    }
    clearMap();

    if (!dialog.open) {
      const active = document.activeElement;
      lastFocus =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      dialog.showModal();
      // showModal() focuses the first control; move focus to the step heading.
      window.requestAnimationFrame(() => {
        if (dialog.open && step === "root") {
          title.focus({ preventScroll: false });
        }
      });
    } else {
      title.focus({ preventScroll: false });
    }

    if (prefill !== null && prefill.trim() !== "") {
      void continueRoot();
    }
  }

  function close(): void {
    if (dialog.open) dialog.close();
  }

  async function continueRoot(): Promise<void> {
    const raw = rootInput.value;
    rootError.hidden = true;
    rootError.textContent = "";
    rootInput.removeAttribute("aria-invalid");
    rootStatus.textContent = "";

    const admissionText = admissionCodeFromInput(raw);
    if (admissionText !== null) {
      await showAdmissionCode(admissionText);
      return;
    }

    const id = parseRootInput(raw);
    if (id === null) {
      showRootError(
        "That is not a root link, root id, or admission code. Paste what you were given.",
      );
      rootInput.focus({ preventScroll: true });
      return;
    }

    const generation = ++flowGeneration;
    busy = true;
    rootForm.setAttribute("aria-busy", "true");
    rootContinue.disabled = true;
    rootContinue.textContent = "Checking…";
    rootStatus.textContent = "Checking that zone…";

    try {
      const valid = await validateRoot(reader, id);
      if (generation !== flowGeneration) return;
      if (!valid.ok) {
        showRootError(rootErrorText(valid.reason));
        rootInput.focus({ preventScroll: true });
        return;
      }

      rootId = id;
      rootInput.removeAttribute("aria-invalid");
      rootError.hidden = true;
      await checkStatus({ focus: true, announceCheck: false });
      if (generation !== flowGeneration) return;
    } catch (error) {
      if (generation !== flowGeneration) return;
      showRootError(
        `That zone could not be checked: ${errorMessage(error)}`,
      );
      rootInput.focus({ preventScroll: true });
    } finally {
      if (generation === flowGeneration) {
        busy = false;
        rootForm.setAttribute("aria-busy", "false");
        rootContinue.disabled = false;
        rootContinue.textContent = "Continue";
      }
    }
  }

  function showRootError(message: string): void {
    rootError.textContent = message;
    rootError.hidden = false;
    rootInput.setAttribute("aria-invalid", "true");
    rootContinue.textContent = "Try again";
    rootStatus.textContent = "";
  }

  /**
   * Admit from the owner's signed code instead of a zone read. The code is the
   * designation; the owner-zone read is only a best-effort freshness check.
   */
  async function showAdmissionCode(text: string): Promise<void> {
    const self = deps.selfId();
    if (self === null) {
      showRootError("Your identity is not ready yet. Try again in a moment.");
      rootInput.focus({ preventScroll: true });
      return;
    }

    // The zone the candidate actually asked, when the flow recorded it: the
    // shared `?root=` can be an ancestor of the zone that admitted them.
    const expectedOwner = expectedAdmissionOwner(
      window.location.search,
      rootId,
    );
    const generation = ++flowGeneration;
    statusGeneration += 1;
    busy = true;
    statusBusy = true;
    rootForm.setAttribute("aria-busy", "true");
    rootContinue.disabled = true;
    rootContinue.textContent = "Checking…";
    rootStatus.textContent = "Checking that admission code…";
    statusCheck.disabled = true;
    statusCheck.textContent = "Checking…";

    try {
      const verify = deps.verifyAdmission ?? verifyAdmissionCode;
      const verified = await verify(text, { candidate: self, expectedOwner });
      if (generation !== flowGeneration) return;
      if (!verified.ok) {
        showRootError(admissionFailureText(verified.reason));
        rootInput.focus({ preventScroll: true });
        return;
      }

      const code = verified.code;
      rootId = code.owner;
      rootInput.removeAttribute("aria-invalid");
      rootError.hidden = true;
      rootError.textContent = "";

      // A read is not proof: only a strictly newer, different slot blocks.
      const view = await reader(code.owner).catch(() => null);
      if (generation !== flowGeneration) return;
      const localSlot =
        view === null ? null : (view.state.slots[code.slot] ?? null);
      const crossCheck = crossCheckAdmission(code, localSlot);

      const ownZone =
        self === code.owner
          ? (view?.state ?? null)
          : ((await reader(self))?.state ?? null);
      if (generation !== flowGeneration) return;

      statusModel = {
        kind: "admitted",
        targetId: code.owner,
        targetZone: view?.state ?? null,
        candidateState: null,
        address: code.address,
        ownZone,
        request: null,
        slot: code.slot,
        completed: false,
        admission: code,
        source: "code",
        crossCheck,
        codeText: text,
      };
      interviewViews = new globalThis.Map();
      interviewComposerErrorText = null;
      admittedError.hidden = true;
      admittedError.textContent = "";
      admittedDone.hidden = true;
      admittedBadge.hidden = true;
      statusLoading.hidden = true;
      statusError.hidden = true;
      statusWatch.stop();
      showStatus(true, true);
    } catch (error) {
      if (generation !== flowGeneration) return;
      showRootError(
        `That admission code could not be checked: ${errorMessage(error)}`,
      );
      rootInput.focus({ preventScroll: true });
    } finally {
      if (generation === flowGeneration) {
        busy = false;
        statusBusy = false;
        rootForm.setAttribute("aria-busy", "false");
        rootContinue.disabled = false;
        rootContinue.textContent = "Continue";
        statusCheck.disabled = false;
        statusCheck.textContent = "Check again";
        statusWatch.settled();
      }
    }
  }

  async function preparePlace(): Promise<void> {
    // The map is lazy: this is the first point at which it can be useful.
    void ensureMap().then((ok) => {
      if (step === "root") return;
      mapFallback.hidden = ok;
      mapElement.dataset.state = ok ? "ready" : "unavailable";
      window.requestAnimationFrame(() => map?.invalidateSize());
    });
    placeError.hidden = true;
    placeError.textContent = "";
  }

  async function ensureDataset(): Promise<RegionDataset> {
    if (datasetPromise === null) {
      datasetPromise = RegionDataset.open(createSource());
      datasetPromise.catch(() => {
        datasetPromise = null;
      });
    }
    return datasetPromise;
  }

  function createSource(): RegionSource {
    if (isOffline()) {
      const fixture = buildFixture();
      return new FixtureSource(fixture.manifestState, fixture.shards);
    }
    if (!REGIONS_MANIFEST_INSTANCE || !REGIONS_MANIFEST_CODE_HASH) {
      throw new Error("Region data is not published yet.");
    }
    return new ContractSource(
      new BlobReader(),
      contractKeyFromInstance(
        REGIONS_MANIFEST_INSTANCE,
        REGIONS_MANIFEST_CODE_HASH,
      ),
    );
  }

  async function ensureMap(): Promise<boolean> {
    if (map !== null && layer !== null) return true;
    if (mapPromise !== null) return mapPromise;

    mapPromise = (async () => {
      try {
        const [module, countriesModule, topojson] = await Promise.all([
          import("leaflet"),
          import("./assets/countries-110m.json"),
          import("topojson-client"),
          import("leaflet/dist/leaflet.css"),
        ]);
        const L = (
          (module as unknown as { default?: LeafletModule }).default ?? module
        ) as LeafletModule;
        leaflet = L;
        map = L.map(mapElement, {
          crs: L.CRS.EPSG4326,
          center: WORLD_VIEW,
          zoom: WORLD_ZOOM,
          minZoom: 1,
          maxZoom: 8,
          worldCopyJump: true,
          attributionControl: false,
          keyboard: false,
          zoomControl: false,
        });
        mapElement.removeAttribute("tabindex");

        const topology = countriesModule.default as unknown as Topology<{
          countries: GeometryCollection;
        }>;
        const geometry = topojson.feature(
          topology,
          topology.objects.countries,
        );
        L.geoJSON(geometry as unknown as GeoJSON.GeoJsonObject, {
          style: () => ({
            className: "join-world",
            weight: 0.5,
            fillOpacity: 1,
          }),
        }).addTo(map);

        layer = L.layerGroup().addTo(map);
        map.on("click", (event) => {
          if (step !== "place" || busy) return;
          latInput.value = String(roundCoordinate(event.latlng.lat));
          lngInput.value = String(roundCoordinate(event.latlng.lng));
          void matchPoint({ lat: event.latlng.lat, lng: event.latlng.lng });
        });
        window.requestAnimationFrame(() => map?.invalidateSize());
        return true;
      } catch {
        map = null;
        layer = null;
        leaflet = null;
        return false;
      } finally {
        mapPromise = null;
      }
    })();
    return mapPromise;
  }

  function roundCoordinate(value: number): number {
    return Math.round(value * 1e5) / 1e5;
  }

  function clearMap(): void {
    layer?.clearLayers();
  }

  async function matchPoint(next: {
    lat: number;
    lng: number;
  }): Promise<void> {
    if (rootId === null) return;
    const generation = ++flowGeneration;
    const targetRoot = rootId;
    busy = true;
    placeError.hidden = true;
    placeError.textContent = "";
    placeStatus.textContent = "Finding the zone that will take you…";
    deps.announce("Finding the zone that will take you.");
    discovery.setAttribute("aria-busy", "true");
    pointButton.disabled = true;
    loading.hidden = false;
    setStep("place", false);
    loading.hidden = false;
    result.hidden = true;
    targetArea.hidden = true;
    saturatedArea.hidden = true;

    try {
      const dataset = await ensureDataset();
      const found = await findTarget(reader, dataset, targetRoot, next);
      if (generation !== flowGeneration) return;

      if (found.kind === "invalid-root") {
        rootId = null;
        showRootError(rootErrorText(found.reason));
        setStep("root", false);
        rootInput.focus({ preventScroll: true });
        return;
      }

      currentMatch = found.kind === "target" ? found : null;
      candidateRead =
        found.kind === "target" ? { kind: "loading" } : { kind: "error" };
      submitted = false;
      pending = false;
      requestForm.reset();
      noteInput.value = "";
      noteInput.disabled = false;
      requestError.hidden = true;
      requestError.textContent = "";
      requestBlocked.hidden = true;
      requestSuccess.hidden = true;
      requestId.textContent = "";
      updateNote();

      renderResult(found);
      setStep("result", true);
      resultTitle.focus({ preventScroll: false });
      void drawMatch(found, dataset, next);

      if (found.kind === "target") {
        const target = found.chain[found.chain.length - 1]!;
        refreshAccepting();
        refreshRequestState();
        void loadCandidate(target.ownerId);
      } else {
        refreshRequestState();
      }
      placeStatus.textContent =
        found.kind === "target"
          ? "Target found. Review the region and send a request."
          : "This branch cannot take you.";
    } catch (error) {
      if (generation !== flowGeneration) return;
      placeStatus.textContent = "";
      placeError.textContent = `The zone match could not be read: ${errorMessage(error)}`;
      placeError.hidden = false;
    } finally {
      if (generation === flowGeneration) {
        busy = false;
        loading.hidden = true;
        discovery.setAttribute("aria-busy", "false");
        pointButton.disabled = false;
        refreshRequestState();
      }
    }
  }

  function renderResult(found: TargetMatch | SaturatedMatch): void {
    result.hidden = false;
    loading.hidden = true;
    renderChain(found.chain, found.kind === "target");
    if (found.kind === "target") {
      targetArea.hidden = false;
      saturatedArea.hidden = true;
      resultLede.textContent =
        found.chain.length === 1
          ? "The first zone with a free slot is the one that can take you."
          : "The walk stops at the first zone on your path with a free slot.";
      renderTarget(found);
    } else {
      targetArea.hidden = true;
      saturatedArea.hidden = false;
      resultLede.textContent =
        "No zone on this branch has a free slot for you.";
      renderSaturated(found);
    }
  }

  function renderChain(chain: readonly ChainZone[], hasTarget: boolean): void {
    const rows = chain.map((zone, index) => {
      const row = document.createElement("li");
      row.className = "onboarding-chain-row";
      const isTarget = hasTarget && index === chain.length - 1;
      row.dataset.target = String(isTarget);
      row.dataset.last = String(index === chain.length - 1);

      const marker = document.createElement("span");
      marker.className = "onboarding-chain-marker";
      marker.setAttribute("aria-hidden", "true");

      const body = document.createElement("span");
      body.className = "onboarding-chain-body";

      const line = document.createElement("span");
      line.className = "onboarding-chain-line";
      const address = document.createElement("code");
      address.className = "onboarding-chain-address";
      address.textContent = chainAddress(zone.address);
      line.append(address);
      if (isTarget) {
        const tag = document.createElement("span");
        tag.className = "onboarding-chain-tag";
        tag.textContent = "your target";
        line.append(tag);
      } else if (index === chain.length - 1) {
        const tag = document.createElement("span");
        tag.className = "onboarding-chain-tag onboarding-chain-tag--stopped";
        tag.textContent = "full";
        line.append(tag);
      }

      const meta = document.createElement("span");
      meta.className = "onboarding-chain-meta";
      meta.textContent =
        `${zone.occupied} of 8 slots taken` +
        (zone.freeSlots.length > 0
          ? ` · ${zone.freeSlots.length} free`
          : " · full");

      body.append(line, meta);
      row.append(marker, body);
      return row;
    });
    chainList.replaceChildren(...rows);
  }

  function renderTarget(found: TargetMatch): void {
    const target = found.chain[found.chain.length - 1]!;
    const assigned = found.assigned;

    targetId.textContent = shorten(target.ownerId);
    targetId.title = target.ownerId;
    targetId.setAttribute("aria-label", `Target owner id ${target.ownerId}`);
    targetAddress.textContent =
      target.address === ""
        ? "the root zone"
        : `at address ${target.address}`;
    targetSlots.textContent = `${target.occupied} / 8 slots taken`;
    refreshAccepting();

    const slot = assigned.slot;
    assignedSlot.textContent = `Slot ${slot + 1}`;
    assignedDigit.textContent = `zero-based digit ${slot}, cell ${LETTERS[slot]}`;
    assignedAddress.textContent =
      assigned.address === "" ? "root" : assigned.address;
    assignedBadge.hidden = false;
    assignedBadge.textContent = assigned.published ? "Published" : "Provisional";
    assignedBadge.dataset.state = assigned.published ? "published" : "provisional";
    const warning = assigned.warning;
    assignedWarning.textContent = warning ?? "";
    assignedWarning.hidden = warning === null;
    assignedWarning.classList.toggle("is-hint", warning === null);

    updatePublicSummary();
    updateNote();
    refreshRequestState();
  }

  function renderSaturated(found: SaturatedMatch): void {
    const last = found.chain[found.chain.length - 1];
    const where = last ? chainAddress(last.address) : "the root";
    saturatedTitle.textContent =
      found.reason === "full" ? "This branch is full" : "This branch is broken";
    saturatedReason.textContent =
      found.reason === "full"
        ? `Every zone from the root to ${where} has all eight slots taken.`
        : `The chain from the root stops at ${where}: the next zone is missing or its parent does not point back.`;
  }

  function updatePublicSummary(): void {
    const found = currentMatch;
    if (!found) return;
    const requester = deps.selfId();
    publicId.textContent = requester ?? "your identity is not ready";
    publicCell.textContent = formatWantCell(found.wantCell);
    const note = noteInput.value;
    publicNote.textContent = note.trim() === "" ? "(no note)" : note;
  }

  function updateNote(): void {
    noteCount.textContent = noteByteLabel(noteInput.value);
    noteCount.classList.toggle(
      "is-warning",
      utf8Length(noteInput.value) > NOTE_LIMIT,
    );
    updatePublicSummary();
    refreshRequestState();
  }

  function refreshAccepting(): void {
    if (currentMatch === null) {
      targetAccepting.textContent = "";
      return;
    }
    if (candidateRead.kind === "loading") {
      targetAccepting.textContent = "Checking the zone's request queue…";
      return;
    }
    if (candidateRead.kind === "error") {
      targetAccepting.textContent =
        "Accepting unknown — the request queue could not be read. You can still send a request.";
      return;
    }
    targetAccepting.textContent = candidateStatusLine(candidateRead.state);
  }

  async function loadCandidate(ownerId: string): Promise<void> {
    const generation = ++candidateGeneration;
    try {
      const state = await deps.transport.read(ownerId);
      if (generation !== candidateGeneration) return;
      candidateRead = { kind: "ready", state };
    } catch {
      if (generation !== candidateGeneration) return;
      candidateRead = { kind: "error" };
    }
    refreshAccepting();
    refreshRequestState();
  }

  /**
   * Find the zone that holds this requester's status. A fresh link has only the
   * root id, so a bounded breadth-first walk checks the root first, then mutual
   * children. Each zone is checked with the shared `joinCheck` rule.
   */
  async function findStatusTarget(
    root: string,
    self: string,
  ): Promise<StatusSearchResult> {
    const queue: Array<{ ownerId: string; parentId: string | null }> = [
      { ownerId: root, parentId: null },
    ];
    const seen = new Set<string>();

    while (queue.length > 0 && seen.size < MAX_STATUS_ZONES) {
      const next = queue.shift()!;
      if (seen.has(next.ownerId)) continue;
      seen.add(next.ownerId);

      let view: Awaited<ReturnType<ZoneReader>>;
      try {
        view = await reader(next.ownerId);
      } catch (error) {
        if (next.ownerId === root) return { kind: "error", error };
        continue;
      }
      if (view === null) {
        if (next.ownerId === root) {
          return {
            kind: "error",
            error: new Error("the root zone could not be read"),
          };
        }
        continue;
      }

      // Only mutual parent edges belong to the discovery tree.
      if (
        next.parentId !== null &&
        view.state.parent.userId !== next.parentId
      ) {
        continue;
      }

      let candidateState: CandidateStateV1 | null;
      try {
        candidateState = await deps.transport.read(next.ownerId);
      } catch (error) {
        // A broken descendant room must not hide a status found elsewhere.
        if (next.ownerId === root) return { kind: "error", error };
        continue;
      }

      const check = joinCheck(candidateState, view.state, self);
      if (check.kind !== "none") {
        return {
          kind: "found",
          target: {
            targetId: next.ownerId,
            targetZone: view.state,
            candidateState,
            check,
          },
        };
      }

      for (const slot of view.state.slots) {
        const contact = slot.entry?.contact;
        if (contact !== undefined && !seen.has(contact)) {
          queue.push({ ownerId: contact, parentId: next.ownerId });
        }
      }
    }

    return { kind: "none" };
  }

  /** Read the one zone named by the URL target hint. */
  async function readTargetStatus(
    targetId: string,
    self: string,
  ): Promise<StatusSearchResult> {
    let view: Awaited<ReturnType<ZoneReader>>;
    try {
      view = await reader(targetId);
    } catch (error) {
      return { kind: "error", error };
    }
    if (view === null) {
      return {
        kind: "error",
        error: new Error("the target zone could not be read"),
      };
    }

    let candidateState: CandidateStateV1 | null;
    try {
      candidateState = await deps.transport.read(targetId);
    } catch (error) {
      return { kind: "error", error };
    }

    const check = joinCheck(candidateState, view.state, self);
    if (check.kind === "none") return { kind: "none" };
    return {
      kind: "found",
      target: {
        targetId,
        targetZone: view.state,
        candidateState,
        check,
      },
    };
  }

  /**
   * Keep the validated root and carry the target so a reload, or Check again,
   * can read one zone instead of walking the tree. A replaceState keeps the
   * current history entry and preserves every other parameter.
   */
  function setTargetHint(targetId: string): void {
    const url = new URL(window.location.href);
    if (rootId !== null) url.searchParams.set("root", rootId);
    url.searchParams.set("target", targetId);
    window.history.replaceState(window.history.state, "", url);
  }

  /**
   * Read the pending state for the current root and show one of queued,
   * invited or admitted. A hint reads one zone; Check again may fall back to
   * the bounded tree walk. `none` falls back to the normal place step.
   */
  async function checkStatus(options: {
    focus: boolean;
    announceCheck: boolean;
    /** A watch re-check names its target even when the URL has no hint. */
    targetId?: string | null;
  }): Promise<void> {
    const root = rootId;
    if (root === null) return;
    if (statusBusy) return;
    const self = deps.selfId();
    if (self === null) {
      await preparePlace();
      setStep("place", true);
      placeStatus.textContent =
        "Waiting for your identity before the join status can be checked.";
      return;
    }

    const hint = options.targetId ?? parseTargetHint(window.location.search);
    if (hint === null && !options.announceCheck) {
      // A fresh link with no hint: offer the place step without a tree walk.
      await preparePlace();
      setStep("place", true);
      placeStatus.textContent = "Zone found. Choose where you are.";
      return;
    }

    const previousKind = statusModel?.kind ?? null;
    const previousTarget = statusModel?.targetId ?? null;
    const generation = ++statusGeneration;
    statusBusy = true;
    statusLoading.hidden = false;
    statusError.hidden = true;
    statusError.textContent = "";
    statusQueued.hidden = true;
    statusInvited.hidden = true;
    statusAdmitted.hidden = true;
    statusActions.hidden = false;
    statusCheck.hidden = false;
    statusCheck.disabled = true;
    statusCheck.textContent = "Checking…";
    statusTitle.textContent = "Checking where you stand…";
    statusLede.textContent = "";
    setStep("status", false);
    if (options.announceCheck) deps.announce("Checking again…");

    try {
      const found =
        hint !== null
          ? await readTargetStatus(hint, self)
          : await findStatusTarget(root, self);
      if (generation !== statusGeneration) return;

      if (found.kind === "error") {
        const message = statusErrorText(found.error);
        statusBusy = false;
        statusCheck.disabled = false;
        statusCheck.textContent = "Check again";
        statusLoading.hidden = true;
        statusError.textContent = message;
        statusError.hidden = false;
        setStep("status", true);
        deps.announce(message);
        return;
      }

      if (found.kind === "none") {
        statusModel = null;
        statusWatch.stop();
        statusBusy = false;
        statusLoading.hidden = true;
        await preparePlace();
        if (generation !== statusGeneration) return;
        setStep("place", true);
        placeStatus.textContent =
          "No request is on file yet. Choose where you are to ask.";
        deps.announce(
          "No request is on file. Choose where you are to ask.",
        );
        return;
      }

      const address = await resolveZoneAddress(
        reader,
        root,
        found.target.targetId,
      ).catch(() => null);
      if (generation !== statusGeneration) return;

      const ownZone =
        found.target.targetId === self
          ? found.target.targetZone
          : ((await reader(self))?.state ?? null);
      if (generation !== statusGeneration) return;

      const check = found.target.check;
      statusModel = {
        kind: check.kind,
        targetId: found.target.targetId,
        targetZone: found.target.targetZone,
        candidateState: found.target.candidateState,
        address,
        ownZone,
        request: check.kind === "queued" ? check.request : null,
        slot: check.kind === "admitted" ? check.slot : null,
        completed: false,
        admission: null,
        source: "zone",
        crossCheck: null,
        codeText: null,
      };
      interviewViews = new globalThis.Map();
      interviewComposerErrorText = null;
      admittedError.hidden = true;
      admittedError.textContent = "";
      admittedDone.hidden = true;
      admittedBadge.hidden = true;
      statusLoading.hidden = true;
      statusError.hidden = true;
      statusBusy = false;
      statusCheck.disabled = false;
      statusCheck.textContent = "Check again";
      const changed =
        previousKind !== statusModel.kind ||
        previousTarget !== statusModel.targetId;
      showStatus(
        options.focus || options.announceCheck,
        options.focus || options.announceCheck || changed,
      );
    } catch (error) {
      if (generation !== statusGeneration) return;
      const message = statusErrorText(error);
      statusBusy = false;
      statusCheck.disabled = false;
      statusCheck.textContent = "Check again";
      statusLoading.hidden = true;
      statusError.textContent = message;
      statusError.hidden = false;
      setStep("status", true);
      deps.announce(message);
    } finally {
      if (generation === statusGeneration) {
        statusBusy = false;
        statusCheck.disabled = false;
        statusCheck.textContent = "Check again";
        statusWatch.settled();
      }
    }
  }

  function showStatus(focus: boolean, announce: boolean): void {
    const model = statusModel;
    if (model === null) return;
    statusLoading.hidden = true;
    statusError.hidden = true;
    setStep("status", false);
    renderStatus();
    if (focus) statusTitle.focus({ preventScroll: false });
    if (announce) deps.announce(joinStatusMessage(model.kind));
  }

  function renderStatus(): void {
    const model = statusModel;
    if (model === null) return;

    statusQueued.hidden = model.kind !== "queued";
    statusInvited.hidden = model.kind !== "invited";
    statusAdmitted.hidden = model.kind !== "admitted";
    const codeAdmitted = model.kind === "admitted" && model.source === "code";
    statusActions.hidden = model.kind === "admitted" && !codeAdmitted;
    // A code-based view keeps Check again available to re-read the owner zone.
    statusCheck.hidden = model.kind === "admitted" && !codeAdmitted;
    statusCheck.disabled = statusBusy;
    statusCheck.textContent = statusBusy ? "Checking…" : "Check again";

    if (model.kind === "queued") {
      statusTitle.textContent = "Request sent";
      statusLede.textContent =
        "Request sent. Waiting for the owner to interview you.";
      renderQueued(model);
    } else if (model.kind === "invited") {
      statusTitle.textContent = "You're invited to interview.";
      statusLede.textContent =
        "The owner is interviewing you in the candidate room. Check again to read new messages.";
      renderInterview(model);
    } else {
      statusTitle.textContent = "You've been admitted";
      statusLede.textContent =
        model.source === "code"
          ? "This admission code names you. Sign and join when you're ready."
          : "The owner wrote a slot for you. Sign and join when you're ready.";
      renderAdmitted(model);
    }

    updateStatusWatch(model);
  }

  /**
   * Keep one target-zone subscription while the queued or invited view is
   * showing. The dialog must stay open for it to be useful.
   */
  function updateStatusWatch(model: StatusModel): void {
    if (!dialog.open) {
      statusWatch.stop();
      return;
    }
    if (model.kind === "queued" || model.kind === "invited") {
      statusWatch.setTarget(model.targetId);
    } else {
      statusWatch.stop();
    }
  }

  function renderQueued(model: StatusModel): void {
    const request = model.request;
    if (request === null) return;
    statusSelf.textContent = deps.selfId() ?? "";
    statusCell.textContent = formatWantCell(request.want_cell);
    statusNote.textContent = requestNoteDisplay(request.note);
    requestId.textContent = candidateRequestId(request);
    requestSuccess.hidden = false;
  }

  function renderInterview(model: StatusModel): void {
    const self = deps.selfId();
    const zone = model.targetZone;
    if (zone === null) {
      // Only a zone read can produce an invited view. This guard exists because
      // `targetZone` is nullable for code-based admitted views.
      interviewMessages.replaceChildren();
      interviewLoading.hidden = true;
      interviewEmpty.hidden = true;
      interviewInput.disabled = true;
      interviewSend.disabled = true;
      return;
    }
    interviewTarget.textContent = shorten(model.targetId);
    interviewTarget.title = model.targetId;
    interviewTarget.setAttribute(
      "aria-label",
      `Interview owner id ${model.targetId}`,
    );
    const latest =
      model.candidateState === null
        ? null
        : latestCandidateMembership(model.candidateState);
    const rows = interviewMessageRows(
      model.candidateState?.messages ?? [],
      latest,
    );
    const atEpoch =
      latest === null
        ? 0
        : (model.candidateState?.messages ?? []).filter(
            (message) => message.epoch === latest.seq,
          ).length;
    interviewCount.textContent = roomMessageCountLabel(atEpoch, rows.length);

    const lock = interviewMembershipLock(
      model.targetId,
      zone,
      self,
      latest,
    );
    interviewWarning.hidden = lock === null;
    interviewWarning.textContent = lock ?? "";

    interviewMessages.replaceChildren();
    for (const row of rows) {
      interviewMessages.append(interviewMessageRow(row, model, self));
    }
    interviewEmpty.hidden = rows.length > 0 || statusBusy;
    interviewLoading.hidden = true;

    const limit = interviewComposerLimit(latest);
    const text = interviewInput.value;
    const bytes = roomByteLength(text);
    const over = bytes > limit;
    const problem = roomComposerProblem(text, limit);
    const canSend =
      latest !== null && lock === null && !statusBusy && !sending;

    interviewInput.disabled = !canSend;
    interviewInput.setAttribute("aria-invalid", over ? "true" : "false");
    interviewComposer.classList.toggle("is-over", over);
    interviewComposer.setAttribute("aria-busy", String(sending));
    interviewSend.disabled = !canSend || problem !== null;
    interviewSend.textContent = sending ? "Sending…" : "Send";
    interviewSend.setAttribute("aria-busy", String(sending));
    statusCheck.disabled = statusBusy || sending;

    interviewHint.classList.toggle("is-warning", over && canSend);
    if (latest === null) {
      interviewHint.textContent =
        "The interview has no signed membership yet.";
    } else if (lock !== null) {
      interviewHint.textContent = lock;
    } else if (over) {
      interviewHint.textContent = `Too long: ${bytes} / ${limit} bytes.`;
    } else {
      interviewHint.textContent = `${bytes} / ${limit} bytes${
        (latest.secrets.length ?? 0) > 0 ? " (encrypted)" : ""
      }. Enter sends; Shift+Enter adds a line.`;
    }

    interviewComposerError.hidden = interviewComposerErrorText === null;
    interviewComposerError.textContent = interviewComposerErrorText ?? "";

    if (latest !== null) {
      const pending = rows.some(
        (row) =>
          isEncryptedRoomBody(row.message.body) &&
          !interviewViews.has(roomMessageId(row.message)),
      );
      if (pending) void decryptInterview(model, latest);
    }
  }

  function interviewMessageRow(
    row: RoomMessageRow,
    model: StatusModel,
    self: string | null,
  ): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "room-message";
    item.dataset.history = String(row.history);
    item.dataset.self = String(
      self !== null && row.message.author === self,
    );

    const head = document.createElement("div");
    head.className = "room-message-head";

    const author = document.createElement("span");
    author.className = "room-message-author";
    author.textContent = interviewAuthorLabel(
      row.message.author,
      self,
      model.targetId,
    );
    author.title = row.message.author;
    head.append(author);

    const cached = interviewViews.get(roomMessageId(row.message));
    const bodyView = interviewBodyView(row.message.body, cached);
    const encryption = bodyView === null ? "pending" : bodyView.kind;
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
    return item;
  }

  async function decryptInterview(
    model: StatusModel,
    latest: CandidateMembershipV1,
  ): Promise<void> {
    if (interviewDecrypting) return;
    interviewDecrypting = true;
    const generation = statusGeneration;
    const rows = interviewMessageRows(
      model.candidateState?.messages ?? [],
      latest,
    );
    const pending = rows.filter(
      (row) =>
        isEncryptedRoomBody(row.message.body) &&
        !interviewViews.has(roomMessageId(row.message)),
    );
    try {
      let key: Uint8Array | null = null;
      try {
        key = await deps.transport.epochKeyFor(model.targetId, latest);
      } catch {
        key = null;
      }
      if (generation !== statusGeneration || statusModel !== model) return;

      const roomId = deps.transport.roomIdFor(model.targetId);
      for (const row of pending) {
        const view = await readRoomBody(
          key,
          {
            roomId,
            owner: model.targetId,
            author: row.message.author,
            epoch: row.message.epoch,
            tag: INTERVIEW_TAG,
          },
          row.message.body,
        );
        if (generation !== statusGeneration || statusModel !== model) return;
        interviewViews.set(roomMessageId(row.message), view);
      }
    } finally {
      interviewDecrypting = false;
    }

    if (generation === statusGeneration && statusModel === model) {
      renderStatus();
    }
  }

  /** A reason the admitted view cannot sign yet, or null when it can. */
  function admittedBlock(model: StatusModel): string | null {
    if (model.completed) return null;
    if (model.crossCheck?.kind === "changed") {
      return "This zone now shows a different admission. Ask the owner for a new code, then check again.";
    }
    if (model.ownZone === null) {
      return "Your zone could not be read, so the join cannot be signed yet. Check again.";
    }
    return admissionBlockReason(model.ownZone);
  }

  function renderAdmitted(model: StatusModel): void {
    const slot = model.slot ?? 0;
    admittedSlot.textContent = admittedSlotLabel(slot);
    admittedDigit.textContent = admittedDigitLabel(slot);
    const address =
      model.source === "code" && model.admission !== null
        ? admissionCodeAddress(model.admission)
        : admittedAddressText(model.address, slot);
    admittedAddressEl.textContent = address ?? "Unavailable";

    admittedOwner.textContent = model.targetId;
    admittedOwner.title = model.targetId;
    admittedSource.hidden = model.source !== "code";
    admittedSource.textContent =
      model.source === "code"
        ? "Admission code signed by the owner, not read from their zone. This node may not show the owner's zone yet."
        : "";

    const block = admittedBlock(model);
    admittedBlocked.hidden = block === null;
    admittedBlocked.textContent = block ?? "";

    admittedSign.hidden = model.completed;
    admittedSign.disabled = model.completed || signingJoin || block !== null;
    admittedSign.textContent = signingJoin ? "Signing…" : "Sign and join";
    admittedDone.hidden = !model.completed;
    admittedDoneText.textContent = model.completed
      ? ` ${shorten(model.targetId)} is now your zone's parent.`
      : "";

    admittedBadge.hidden = true;
    if (!model.completed && address !== null) {
      void loadAdmittedBadge(model);
    }
  }

  async function loadAdmittedBadge(model: StatusModel): Promise<void> {
    const slot = model.slot;
    if (slot === null) return;

    let regionAddress: string | null;
    let occupancy: SlotOccupancy[];
    if (model.source === "code") {
      regionAddress = model.admission?.address ?? null;
      // The labels are irrelevant: only `children[slot].provisional` is read.
      occupancy = Array<SlotOccupancy>(8).fill("free");
    } else {
      regionAddress = model.address;
      if (model.targetZone === null) return;
      occupancy = model.targetZone.slots.map((entry) =>
        entry.entry === null ? "free" : "taken",
      );
    }
    if (regionAddress === null) return;
    const generation = statusGeneration;
    try {
      const dataset = await ensureDataset();
      const region = await resolveZoneRegion(dataset, regionAddress, occupancy);
      if (generation !== statusGeneration || statusModel !== model) return;
      const child = region.children[slot];
      if (child === undefined) return;
      admittedBadge.textContent = child.provisional ? "Provisional" : "Published";
      admittedBadge.dataset.state = child.provisional
        ? "provisional"
        : "published";
      admittedBadge.hidden = false;
    } catch {
      // Without the dataset the address alone is still the record.
    }
  }

  async function sendInterviewMessage(): Promise<void> {
    const model = statusModel;
    if (model === null || model.kind !== "invited" || sending || statusBusy) {
      return;
    }
    const self = deps.selfId();
    if (self === null) return;
    const latest =
      model.candidateState === null
        ? null
        : latestCandidateMembership(model.candidateState);
    if (latest === null) return;

    const zone = model.targetZone;
    if (zone === null) return;
    const lock = interviewMembershipLock(
      model.targetId,
      zone,
      self,
      latest,
    );
    if (lock !== null) {
      interviewComposerErrorText = lock;
      renderStatus();
      interviewInput.focus({ preventScroll: true });
      return;
    }

    const limit = interviewComposerLimit(latest);
    const text = interviewInput.value;
    const problem = roomComposerProblem(text, limit);
    if (problem !== null) {
      interviewComposerErrorText = problem;
      renderStatus();
      interviewInput.focus({ preventScroll: true });
      return;
    }

    const generation = statusGeneration;
    sending = true;
    interviewComposerErrorText = null;
    renderStatus();

    try {
      const next = await deps.transport.sendMessage(
        model.targetId,
        new TextEncoder().encode(text),
      );
      if (generation !== statusGeneration || statusModel !== model) return;
      model.candidateState = next;
      interviewInput.value = "";
      deps.announce("Message sent.");
    } catch (error) {
      if (generation !== statusGeneration || statusModel !== model) return;
      interviewComposerErrorText = interviewErrorText(error);
      deps.announce(interviewComposerErrorText);
    } finally {
      if (generation === statusGeneration && statusModel === model) {
        sending = false;
        renderStatus();
        if (statusModel?.kind === "invited") {
          interviewInput.focus({ preventScroll: true });
        }
      } else {
        sending = false;
      }
    }
  }

  async function signJoin(): Promise<void> {
    const model = statusModel;
    if (model === null || model.kind !== "admitted" || signingJoin) return;
    const block = admittedBlock(model);
    if (block !== null) return;

    const generation = statusGeneration;
    signingJoin = true;
    admittedError.hidden = true;
    admittedError.textContent = "";
    renderStatus();

    try {
      await deps.saveParent(model.targetId);
      if (generation !== statusGeneration || statusModel !== model) return;
      model.completed = true;
      deps.onSettled();
      deps.announce("Joined the zone.");
    } catch (error) {
      if (generation !== statusGeneration || statusModel !== model) return;
      admittedError.textContent = signJoinErrorText(error);
      admittedError.hidden = false;
      deps.announce(admittedError.textContent);
    } finally {
      if (generation === statusGeneration && statusModel === model) {
        signingJoin = false;
        renderStatus();
        if (model.completed) {
          admittedDone.focus({ preventScroll: true });
        }
      } else {
        signingJoin = false;
      }
    }
  }

  function resetStatusView(): void {
    statusWatch.stop();
    statusModel = null;
    statusBusy = false;
    statusLoading.hidden = true;
    statusError.hidden = true;
    statusError.textContent = "";
    statusTitle.textContent = "Checking where you stand…";
    statusLede.textContent = "";
    statusQueued.hidden = true;
    statusInvited.hidden = true;
    statusAdmitted.hidden = true;
    statusActions.hidden = true;
    interviewMessages.replaceChildren();
    interviewWarning.hidden = true;
    interviewWarning.textContent = "";
    interviewLoading.hidden = true;
    interviewEmpty.hidden = true;
    interviewComposerError.hidden = true;
    interviewComposerError.textContent = "";
    admittedBlocked.hidden = true;
    admittedBlocked.textContent = "";
    admittedSource.hidden = true;
    admittedSource.textContent = "";
    admittedOwner.textContent = "";
    admittedOwner.title = "";
    admittedError.hidden = true;
    admittedError.textContent = "";
    admittedDone.hidden = true;
    admittedBadge.hidden = true;
    interviewInput.value = "";
    interviewComposerErrorText = null;
    interviewViews = new globalThis.Map();
    interviewDecrypting = false;
    sending = false;
    signingJoin = false;
  }

  function blockedReason(): string | null {
    if (currentMatch === null) return "Choose a point first.";
    if (deps.selfId() === null) {
      return "Your identity is not ready, so a signed request cannot be sent yet.";
    }
    if (utf8Length(noteInput.value) > NOTE_LIMIT) {
      return `The note is longer than ${NOTE_LIMIT} bytes. Shorten it to send the request.`;
    }
    if (candidateRead.kind === "loading") {
      return "Checking whether the zone is accepting requests…";
    }
    if (candidateRead.kind === "error") return null;
    if (
      candidateRead.state !== null &&
      !isAccepting(candidateRead.state)
    ) {
      return "This zone is not accepting new requests right now. Try again later or ask the owner directly.";
    }
    return null;
  }

  function refreshRequestState(): void {
    if (pending) {
      submitButton.disabled = true;
      submitButton.textContent = "Sending…";
      requestForm.setAttribute("aria-busy", "true");
      noteInput.disabled = true;
      return;
    }
    requestForm.setAttribute("aria-busy", "false");
    if (submitted) {
      submitButton.disabled = true;
      submitButton.textContent = "Request sent";
      noteInput.disabled = true;
      requestBlocked.hidden = true;
      requestBlocked.textContent = "";
      return;
    }
    noteInput.disabled = false;
    submitButton.textContent = "Send join request";
    const blocked = blockedReason();
    submitButton.disabled = blocked !== null;
    requestBlocked.textContent = blocked ?? "";
    requestBlocked.hidden = blocked === null;
  }

  async function submitRequest(): Promise<void> {
    const match = currentMatch;
    if (match === null || pending || submitted) return;
    if (blockedReason() !== null) return;
    const requester = deps.selfId();
    if (requester === null) return;
    const target = match.chain[match.chain.length - 1]!;
    const note = noteInput.value;
    const generation = ++flowGeneration;

    pending = true;
    requestError.hidden = true;
    requestError.textContent = "";
    refreshRequestState();

    try {
      const state = await deps.transport.request(target.ownerId, {
        wantCell: match.wantCell,
        note,
      });
      if (generation !== flowGeneration) return;
      submitted = true;
      setTargetHint(target.ownerId);
      const id =
        requestIdFor(state, requester, match.wantCell, note) ?? "(not reported)";
      requestId.textContent = id;

      const targetZone = (await reader(target.ownerId))?.state ?? null;
      if (generation !== flowGeneration) return;
      const ownZone =
        target.ownerId === requester
          ? targetZone
          : ((await reader(requester))?.state ?? null);
      if (generation !== flowGeneration) return;
      const address = await resolveZoneAddress(
        reader,
        rootId!,
        target.ownerId,
      ).catch(() => null);
      if (generation !== flowGeneration) return;

      const requestRecord =
        state.requests.find(
          (request) => candidateRequestId(request) === id,
        ) ??
        state.requests[state.requests.length - 1] ??
        null;
      const check =
        targetZone === null
          ? requestRecord === null
            ? ({ kind: "none" } as const)
            : ({ kind: "queued", request: requestRecord } as const)
          : joinCheck(state, targetZone, requester);
      if (check.kind === "none") {
        throw new Error("the request was written but not found in the queue");
      }
      statusModel = {
        kind: check.kind,
        targetId: target.ownerId,
        targetZone: targetZone ?? emptyState(),
        candidateState: state,
        address,
        ownZone,
        request: check.kind === "queued" ? check.request : null,
        slot: check.kind === "admitted" ? check.slot : null,
        completed: false,
        admission: null,
        source: "zone",
        crossCheck: null,
        codeText: null,
      };
      interviewViews = new globalThis.Map();
      interviewComposerErrorText = null;
      showStatus(true, true);
    } catch (error) {
      if (generation !== flowGeneration) return;
      requestError.textContent = requestErrorText(error);
      requestError.hidden = false;
    } finally {
      if (generation === flowGeneration) {
        pending = false;
        refreshRequestState();
      }
    }
  }

  async function drawMatch(
    found: TargetMatch | SaturatedMatch,
    dataset: RegionDataset,
    at: { lat: number; lng: number },
  ): Promise<void> {
    const ok = await ensureMap();
    if (!ok || map === null || layer === null || leaflet === null) {
      mapFallback.hidden = false;
      mapElement.dataset.state = "unavailable";
      return;
    }
    const L = leaflet;
    layer.clearLayers();
    const rows: RegionRow[] = [];
    const targetIndex = found.kind === "target" ? found.chain.length - 1 : -1;

    for (let index = 0; index < found.chain.length; index += 1) {
      const zone = found.chain[index]!;
      try {
        const region = await resolveZoneRegion(
          dataset,
          zone.address,
          occupancyFor(zone),
        );
        if (region.cell !== null) {
          const cls =
            index === targetIndex
              ? "join-cell join-cell--target"
              : "join-cell join-cell--chain";
          addCell(L, region.cell, cls);
          rows.push(region.cell);
        }
        if (index === targetIndex && found.kind === "target") {
          const child = region.children[found.assigned.slot];
          // A provisional cell has no geometry. Never invent one.
          if (child?.row) {
            addCell(L, child.row, "join-cell join-cell--assigned");
            rows.push(child.row);
          }
        }
      } catch {
        // A dataset problem is not fatal here: the list is the record.
      }
    }

    L.circleMarker([at.lat, at.lng], {
      radius: 6,
      className: "join-point",
      interactive: false,
    }).addTo(layer);

    if (rows.length > 0) {
      const corners: LatLngTuple[] = [];
      for (const row of rows) {
        corners.push([row.minLat, row.minLon], [row.maxLat, row.maxLon]);
      }
      corners.push([at.lat, at.lng]);
      map.fitBounds(L.latLngBounds(corners), {
        padding: [18, 18],
        maxZoom: 7,
        animate: !prefersReducedMotion(),
      });
    } else {
      map.setView([at.lat, at.lng], 4, {
        animate: !prefersReducedMotion(),
      });
    }
    window.requestAnimationFrame(() => map?.invalidateSize());
  }

  function addCell(
    L: LeafletModule,
    row: RegionRow,
    className: string,
  ): void {
    if (layer === null) return;
    L.rectangle(
      [
        [row.minLat, row.minLon],
        [row.maxLat, row.maxLon],
      ],
      { className, interactive: false },
    ).addTo(layer);
  }

  function resetToRoot(): void {
    flowGeneration += 1;
    candidateGeneration += 1;
    statusGeneration += 1;
    rootId = null;
    currentMatch = null;
    busy = false;
    pending = false;
    submitted = false;
    candidateRead = { kind: "loading" };
    resetStatusView();
    rootStep.hidden = false;
    discovery.hidden = true;
    loading.hidden = true;
    result.hidden = true;
    targetArea.hidden = true;
    saturatedArea.hidden = true;
    placeError.hidden = true;
    placeError.textContent = "";
    placeStatus.textContent = "";
    requestError.hidden = true;
    requestError.textContent = "";
    requestBlocked.hidden = true;
    requestBlocked.textContent = "";
    requestSuccess.hidden = true;
    requestId.textContent = "";
    requestForm.reset();
    noteInput.value = "";
    latInput.value = "";
    lngInput.value = "";
    updateNote();
    clearMap();
    setStep("root", false);
    rootInput.focus({ preventScroll: true });
    rootInput.select();
  }

  function handlePlaceSubmit(): void {
    if (busy) return;
    const latText = latInput.value.trim();
    const lngText = lngInput.value.trim();
    const lat = Number(latText);
    const lng = Number(lngText);
    if (latText === "" || lngText === "") {
      showPlaceError("Enter a latitude and longitude, or click the map.");
      return;
    }
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      showPlaceError(
        "Enter a latitude between -90 and 90 and a longitude between -180 and 180.",
      );
      return;
    }
    void matchPoint({ lat, lng });
  }

  function showPlaceError(message: string): void {
    placeError.textContent = message;
    placeError.hidden = false;
    placeStatus.textContent = "";
  }

  rootForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!busy) void continueRoot();
  });
  placeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    handlePlaceSubmit();
  });
  requestForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitRequest();
  });
  noteInput.addEventListener("input", updateNote);

  statusCheck.addEventListener("click", () => {
    if (statusBusy) return;
    const model = statusModel;
    if (
      model !== null &&
      model.kind === "admitted" &&
      model.source === "code"
    ) {
      // Repeat the code path: a stale zone read must never regress this view.
      const text =
        model.codeText ??
        (model.admission === null
          ? null
          : encodeAdmissionCode(model.admission));
      if (text !== null) {
        void showAdmissionCode(text);
        return;
      }
    }
    void checkStatus({ focus: true, announceCheck: true });
  });

  // The explicit fallback when the URL carries no target hint.
  placeCheck.addEventListener("click", () => {
    if (busy || statusBusy) return;
    void checkStatus({ focus: true, announceCheck: true });
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
    renderStatus();
  });

  admittedSign.addEventListener("click", () => {
    if (admittedSign.disabled) return;
    void signJoin();
  });

  rootInput.addEventListener("input", () => {
    rootInput.removeAttribute("aria-invalid");
    rootError.hidden = true;
    rootError.textContent = "";
    rootContinue.textContent = "Continue";
  });
  closeButton.addEventListener("click", close);
  tryAnother.addEventListener("click", resetToRoot);

  dialog.addEventListener("close", () => {
    flowGeneration += 1;
    candidateGeneration += 1;
    statusGeneration += 1;
    statusBusy = false;
    interviewDecrypting = false;
    pending = false;
    statusWatch.stop();
    deps.onSettled();
    const target = lastFocus;
    lastFocus = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  });

  return { open, close };
}
