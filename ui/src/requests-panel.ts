/**
 * Owner-side join-request queue (P4c3a, `DESIGN-candidates.md` §12.1).
 *
 * A quiet Advanced surface over the owner's own candidate room: read the
 * public queue, switch accepting on or off, dismiss one request at a time (or
 * all of them), and copy the zone's join link. Every write passes the owner's
 * own id to the transport; there is no way to point this panel at another
 * zone's queue.
 *
 * No interview or admission action lives here. Those are §12.2.
 */

import type { CandidateTransport } from "./candidate-client";
import {
  candidateNoteToText,
  candidateRequestId,
  isAccepting,
  type CandidateRequestV1,
  type CandidateStateV1,
} from "./candidate-state";
import { errorMessage, shorten } from "./util";

export interface RequestsPanelDeps {
  /** Candidate-room transport; only the owner's own id is ever passed. */
  transport: CandidateTransport;
  /** The viewer's own owner id, or null while the identity is not ready. */
  ownId(): string | null;
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
 * `<origin><pathname>?root=<ownId>` with every other query parameter and the
 * fragment removed. This is the link others open to ask to join (§3.2).
 */
export function joinLink(
  origin: string,
  pathname: string,
  ownerId: string,
): string {
  const url = new URL(pathname === "" ? "/" : pathname, origin);
  url.search = "";
  url.hash = "";
  url.searchParams.set("root", ownerId);
  return url.toString();
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

/** Readable sentences for queue actions; contract detail stays out of them. */
export function requestsErrorText(
  error: unknown,
  action: "read" | "accepting" | "dismiss",
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

  const prefix =
    action === "accepting"
      ? "Accepting was not changed."
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
  let manualLink: string | null = null;

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
    const busy = acceptingBusy || clearing || dismissing !== null;
    const initialLoading = loading && !loaded;

    dialog.dataset.state = waiting
      ? "waiting"
      : initialLoading
        ? "loading"
        : loadError !== null && !loaded
          ? "error"
          : "ready";

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
      (loadError !== null && !loaded) ||
      requests.length > 0;
    emptyLine.tabIndex = -1;
    list.hidden = requests.length === 0;
    list.replaceChildren();
    for (const request of requests) {
      list.append(renderRow(request, busy));
    }

    copyButton.disabled = waiting || copying;
    copyButton.textContent = copying ? "Copying…" : "Copy join link";
    copyButton.setAttribute("aria-busy", String(copying));
    linkField.hidden = manualLink === null;
    linkInput.value = manualLink ?? "";
    if (copying) {
      copyStatus.textContent = "Copying the join link…";
    } else if (copied) {
      copyStatus.textContent = "Copied.";
    } else if (manualLink !== null) {
      copyStatus.textContent =
        "The clipboard is unavailable. Select the link and copy it manually.";
    } else {
      copyStatus.textContent = "";
    }

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

    foot.append(message, dismissButton);
    item.append(head, note, foot);
    return item;
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
      render();
      return;
    }

    loading = true;
    loadError = null;
    render();

    try {
      const state = await deps.transport.read(owner);
      if (token !== readToken || run !== generation) return;
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
      if (announceResult) {
        deps.announce(
          state === null || state.requests.length === 0
            ? "Join request queue refreshed. No open requests."
            : `Join request queue refreshed. ${requestCountLabel(
                state.requests.length,
              )}.`,
        );
      }
    } catch (error) {
      if (token !== readToken || run !== generation) return;
      loadError = requestsErrorText(error, "read");
      deps.announce(loadError);
    } finally {
      if (token === readToken && run === generation) {
        loading = false;
        render();
      }
    }
  }

  async function setAccepting(desired: boolean): Promise<void> {
    if (acceptingBusy || clearing || dismissing !== null) return;
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
    if (dismissing !== null || clearing || acceptingBusy) return;
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
    if (clearing || dismissing !== null || acceptingBusy) return;
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

  async function copyJoinLink(): Promise<void> {
    const owner = ownId();
    if (owner === null || copying) return;
    const link = joinLink(
      window.location.origin,
      window.location.pathname,
      owner,
    );
    const run = generation;

    copying = true;
    copied = false;
    manualLink = null;
    render();

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("the clipboard is unavailable");
      }
      await navigator.clipboard.writeText(link);
      if (run !== generation) return;
      copied = true;
      deps.announce("Join link copied.");
    } catch {
      if (run !== generation) return;
      manualLink = link;
      deps.announce(
        "The clipboard is unavailable. The join link is shown for manual copying.",
      );
    } finally {
      if (run === generation) {
        copying = false;
        render();
        if (manualLink !== null) {
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
    manualLink = null;
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
    void copyJoinLink();
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
    const target = lastFocus;
    lastFocus = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  });

  render();

  return { open, refresh, close };
}
