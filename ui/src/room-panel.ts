/**
 * Members room panel (P3b2).
 *
 * The contract exposes one room per zone: the owner signs membership, members
 * sign messages, and bodies are opaque bytes. This panel is deliberately a
 * thin view over `RoomTransport`: it reads on open/refresh, never inserts
 * optimistically, and repaints from the state a write returns. Plaintext is
 * called out in the dialog because P3c has not added encryption yet.
 */
import {
  deriveRoomMembers,
  latestMembership,
  roomBodyToText,
  roomMessageId,
  type RoomMembershipV1,
  type RoomMessageV1,
  type RoomStateV1,
} from "./room-state";
import {
  RoomError,
  type RoomErrorCode,
  type RoomTransport,
} from "./room-client";

export interface RoomPanelDeps {
  ownerId(): string | null;
  /** Occupied slot contacts; may include unconfirmed ones, never the owner. */
  zoneContacts(): string[];
  nameFor(userId: string): string | null;
  transport: RoomTransport;
  announce(message: string): void;
}

export interface RoomPanel {
  open(): void;
  refresh(): void;
  close(): void;
}

/** Contract bounds (DESIGN-rooms.md §2). */
export const ROOM_MESSAGE_LIMIT = 200;
export const ROOM_BODY_BYTE_LIMIT = 1024;

export type RoomMembershipState = "none" | "match" | "mismatch" | "error";
export type RoomMemberKind = "owner" | "child" | "stale";
export type RoomMemberState = "in-room" | "not-in-room" | "stale";

export interface RoomMemberRow {
  id: string;
  kind: RoomMemberKind;
  state: RoomMemberState;
}

export interface RoomMessageRow {
  message: RoomMessageV1;
  /** True for an epoch older than the latest signed membership. */
  history: boolean;
  /** The first current-epoch message after retained history. */
  dividerBefore: boolean;
}

export interface RoomMembershipChanges {
  added: string[];
  removed: string[];
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort(compareIds);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Compare the latest signed membership with the member list derived from the
 * zone's occupied slots. `error` is reserved for a failed read, which has no
 * membership data to compare.
 */
export function roomMembershipState(
  signed: RoomMembershipV1 | null,
  expected: readonly string[],
): RoomMembershipState {
  if (signed === null) return "none";
  return sameIds(sortedUnique(signed.members), sortedUnique(expected))
    ? "match"
    : "mismatch";
}

/** Members the owner would add and remove if they re-signed the slot list. */
export function roomMembershipChanges(
  expected: readonly string[],
  signed: RoomMembershipV1 | null,
): RoomMembershipChanges {
  const expectedIds = new Set(expected);
  const signedIds = new Set(signed?.members ?? []);
  return {
    added: sortedUnique(expected).filter((id) => !signedIds.has(id)),
    removed: sortedUnique(signed?.members ?? []).filter(
      (id) => !expectedIds.has(id),
    ),
  };
}

/**
 * Rows for the membership list: the owner first, then contacts in the derived
 * set, then signed members who no longer appear in any occupied slot (stale).
 */
export function roomMemberRows(
  ownerId: string,
  expected: readonly string[],
  signed: RoomMembershipV1 | null,
): RoomMemberRow[] {
  const signedIds = new Set(signed?.members ?? []);
  const expectedIds = new Set(expected);
  const rows: RoomMemberRow[] = [
    {
      id: ownerId,
      kind: "owner",
      state: signedIds.has(ownerId) ? "in-room" : "not-in-room",
    },
  ];

  for (const id of sortedUnique(expected)) {
    if (id === ownerId) continue;
    rows.push({
      id,
      kind: "child",
      state: signedIds.has(id) ? "in-room" : "not-in-room",
    });
  }

  for (const id of sortedUnique(signed?.members ?? [])) {
    if (id === ownerId || expectedIds.has(id)) continue;
    rows.push({ id, kind: "stale", state: "stale" });
  }

  return rows;
}

/**
 * The newest 200 messages in contract order, with a one-time divider before
 * the first current-epoch message. Older epochs stay visible as history.
 */
export function roomMessageRows(
  messages: readonly RoomMessageV1[],
  currentEpoch: number,
): RoomMessageRow[] {
  const ordered = [...messages].sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return compareIds(roomMessageId(a), roomMessageId(b));
  });
  const capped = ordered.slice(-ROOM_MESSAGE_LIMIT);

  let sawHistory = false;
  let insertedDivider = false;
  return capped.map((message) => {
    const history = currentEpoch > 0 && message.epoch < currentEpoch;
    const dividerBefore = !history && sawHistory && !insertedDivider;
    if (history) sawHistory = true;
    if (dividerBefore) insertedDivider = true;
    return { message, history, dividerBefore };
  });
}

/** Message count summary; the panel never receives more than 200 anyway. */
export function roomMessageCountLabel(total: number, shown: number): string {
  if (total === 0) return "No messages";
  if (total > shown) return `Latest ${shown} of ${total}`;
  return total === 1 ? "1 message" : `${total} messages`;
}

export function roomByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Composer validation: non-empty and within the 1024-byte body cap. */
export function roomComposerProblem(text: string): string | null {
  if (text.trim() === "") return "Write a message first.";
  const bytes = roomByteLength(text);
  if (bytes > ROOM_BODY_BYTE_LIMIT) {
    return `Keep the message to ${ROOM_BODY_BYTE_LIMIT} bytes or fewer. This one is ${bytes} bytes.`;
  }
  return null;
}

/** Room `time` is author-supplied milliseconds (DESIGN-rooms.md §2). */
export function roomTimeIso(milliseconds: number): string | null {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

let timeFormatter: Intl.DateTimeFormat | null = null;

export function formatRoomTime(milliseconds: number): string {
  const iso = roomTimeIso(milliseconds);
  if (iso === null) return "Unknown time";
  if (timeFormatter === null) {
    timeFormatter = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  try {
    return timeFormatter.format(new Date(iso));
  } catch {
    return iso;
  }
}

const ROOM_ERROR_CODES: readonly RoomErrorCode[] = [
  "config",
  "connection",
  "read",
  "write",
  "sign",
  "not-member",
  "wasm",
];

export function roomErrorCodeOf(error: unknown): RoomErrorCode | null {
  if (error instanceof RoomError) return error.code;
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      (ROOM_ERROR_CODES as readonly string[]).includes(code)
    ) {
      return code as RoomErrorCode;
    }
  }
  return null;
}

function actionErrorText(
  code: RoomErrorCode | null,
  action: "membership" | "message",
): string {
  const prefix =
    action === "membership" ? "Membership not updated." : "Message not sent.";
  switch (code) {
    case "connection":
      return `${prefix} You're offline. Check your connection, then try again.`;
    case "config":
      return `${prefix} This build has no room configuration. Publish the room contract and reload.`;
    case "sign":
      return `${prefix} The delegate could not sign it. Make sure it is installed and ready.`;
    case "not-member":
      return `${prefix} This key is not a member of the room's current membership.`;
    case "write":
      return `${prefix} The change could not be saved. Try again.`;
    case "read":
      return `${prefix} The room could not be read. Choose Refresh and try again.`;
    case "wasm":
      return `${prefix} The room contract could not load. Reload the page and try again.`;
    default:
      return `${prefix} Something went wrong. Try again.`;
  }
}

export function createRoomPanel(deps: RoomPanelDeps): RoomPanel {
  const dialog = byId<HTMLDialogElement>("room-dialog");
  const title = byId<HTMLHeadingElement>("room-title");
  const closeButton = byId<HTMLButtonElement>("room-close");
  const doneButton = byId<HTMLButtonElement>("room-done");
  const refreshButton = byId<HTMLButtonElement>("room-refresh");
  const waiting = byId<HTMLParagraphElement>("room-waiting");

  const membershipStateElement = byId<HTMLSpanElement>("room-membership-state");
  const membershipDetail = byId<HTMLParagraphElement>("room-membership-detail");
  const mismatch = byId<HTMLParagraphElement>("room-mismatch");
  const updateButton = byId<HTMLButtonElement>("room-update-membership");
  const confirmBox = byId<HTMLDivElement>("room-membership-confirm");
  const confirmText = byId<HTMLParagraphElement>("room-membership-confirm-text");
  const confirmCancel = byId<HTMLButtonElement>("room-membership-cancel");
  const confirmUpdate = byId<HTMLButtonElement>(
    "room-membership-confirm-update",
  );
  const membershipError = byId<HTMLParagraphElement>("room-membership-error");
  const membersList = byId<HTMLUListElement>("room-members");
  const membersEmpty = byId<HTMLParagraphElement>("room-members-empty");

  const messageCount = byId<HTMLSpanElement>("room-message-count");
  const loadingLine = byId<HTMLParagraphElement>("room-loading");
  const offlineLine = byId<HTMLParagraphElement>("room-offline");
  const errorLine = byId<HTMLParagraphElement>("room-error");
  const emptyLine = byId<HTMLParagraphElement>("room-empty");
  const messagesList = byId<HTMLOListElement>("room-messages");

  const composer = byId<HTMLFormElement>("room-composer");
  const input = byId<HTMLTextAreaElement>("room-message-input");
  const hint = byId<HTMLParagraphElement>("room-message-hint");
  const sendButton = byId<HTMLButtonElement>("room-send");
  const composerError = byId<HTMLParagraphElement>("room-composer-error");
  const statusLine = byId<HTMLParagraphElement>("room-status");

  let current: RoomStateV1 | null = null;
  let currentOwner: string | null = null;
  let loading = false;
  let sending = false;
  let updating = false;
  let offline = false;
  let loadError: string | null = null;
  let membershipActionError: string | null = null;
  let composerErrorText: string | null = null;
  let confirmPending = false;
  let readToken = 0;

  function setStatus(message: string): void {
    statusLine.textContent = message;
  }

  function ownerId(): string | null {
    return deps.ownerId();
  }

  function latestSigned(): RoomMembershipV1 | null {
    return current === null ? null : latestMembership(current);
  }

  function expectedMembers(owner: string): string[] {
    return deriveRoomMembers(owner, deps.zoneContacts());
  }

  function membershipStateFor(owner: string | null): RoomMembershipState {
    if (owner === null) return "none";
    if (offline || loadError !== null) return "error";
    return roomMembershipState(latestSigned(), expectedMembers(owner));
  }

  function displayName(userId: string, owner: string | null): string {
    if (owner !== null && userId === owner) return "You";
    return deps.nameFor(userId) ?? `Member ${userId.slice(0, 8)}`;
  }

  function shortMemberName(userId: string, owner: string | null): string {
    if (owner !== null && userId === owner) return "You";
    return deps.nameFor(userId) ?? userId.slice(0, 8);
  }

  function memberNames(ids: readonly string[], owner: string): string {
    return ids.map((id) => shortMemberName(id, owner)).join(", ");
  }

  function renderComposer(
    owner: string | null,
    state: RoomMembershipState,
  ): void {
    const waitingForOwner = owner === null;
    const busy = loading || sending || updating;
    const text = input.value;
    const bytes = roomByteLength(text);
    const over = bytes > ROOM_BODY_BYTE_LIMIT;
    const canSend =
      !waitingForOwner &&
      !offline &&
      loadError === null &&
      (state === "match" || state === "mismatch") &&
      !busy;

    input.disabled = !canSend;
    input.setAttribute("aria-invalid", over ? "true" : "false");
    composer.classList.toggle("is-over", over);
    composer.setAttribute("aria-busy", String(sending));
    sendButton.disabled =
      !canSend || sending || roomComposerProblem(text) !== null;
    sendButton.textContent = sending ? "Sending…" : "Send";
    sendButton.setAttribute("aria-busy", String(sending));

    hint.classList.toggle("is-warning", over && canSend);
    if (waitingForOwner) {
      hint.textContent = "Waiting for your identity.";
    } else if (offline) {
      hint.textContent = "Messages can't be sent while offline.";
    } else if (loadError !== null) {
      hint.textContent = "The room could not be read. Choose Refresh to retry.";
    } else if (loading) {
      hint.textContent = "Reading the room…";
    } else if (state === "none") {
      hint.textContent = "Create a membership before sending.";
    } else if (state === "error") {
      hint.textContent = "The membership could not be checked.";
    } else if (over) {
      hint.textContent = `Too long: ${bytes} / ${ROOM_BODY_BYTE_LIMIT} bytes.`;
    } else if (state === "mismatch") {
      hint.textContent = `${bytes} / ${ROOM_BODY_BYTE_LIMIT} bytes. Membership is out of date; update it to include new contacts.`;
    } else {
      hint.textContent = `${bytes} / ${ROOM_BODY_BYTE_LIMIT} bytes. Enter sends; Shift+Enter adds a line.`;
    }

    composerError.hidden = composerErrorText === null;
    composerError.textContent = composerErrorText ?? "";
  }

  function renderMembers(owner: string, signed: RoomMembershipV1 | null): void {
    const expected = expectedMembers(owner);
    const rows = roomMemberRows(owner, expected, signed);
    membersList.replaceChildren();

    for (const row of rows) {
      const item = document.createElement("li");
      item.className = "room-member-row";
      item.dataset.kind = row.kind;
      item.dataset.state = row.state;

      const main = document.createElement("div");
      main.className = "room-member-main";

      const name = document.createElement("span");
      name.className = "room-member-name";
      name.textContent =
        row.id === owner
          ? "You"
          : deps.nameFor(row.id) ??
            (row.kind === "stale" ? "Former member" : `Member ${row.id.slice(0, 8)}`);

      const id = document.createElement("code");
      id.className = "room-member-id";
      id.textContent = row.id.slice(0, 8);
      id.title = row.id;

      main.append(name, id);

      if (row.kind === "owner") {
        const tag = document.createElement("span");
        tag.className = "room-member-tag";
        tag.textContent = "Owner";
        main.append(tag);
      }

      const state = document.createElement("span");
      state.className = "room-member-state";
      state.dataset.state = row.state;
      state.textContent =
        row.state === "in-room"
          ? "In room"
          : row.state === "stale"
            ? "Stale"
            : "Not in room";

      item.append(main, state);
      membersList.append(item);
    }
  }

  function renderMessages(owner: string): void {
    const messages = current?.messages ?? [];
    if (current === null) {
      messagesList.replaceChildren();
      return;
    }

    const latest = latestMembership(current);
    const currentEpoch = latest?.seq ?? 0;
    const rows = roomMessageRows(messages, currentEpoch);
    messagesList.replaceChildren();

    for (const row of rows) {
      if (row.dividerBefore) {
        const divider = document.createElement("li");
        divider.className = "room-divider";
        divider.setAttribute("role", "separator");
        divider.setAttribute(
          "aria-label",
          `Current messages, epoch ${currentEpoch}`,
        );
        const label = document.createElement("span");
        label.textContent = `Current epoch ${currentEpoch}`;
        divider.append(label);
        messagesList.append(divider);
      }

      const item = document.createElement("li");
      item.className = "room-message";
      item.dataset.history = String(row.history);
      item.dataset.self = String(row.message.author === owner);

      const head = document.createElement("div");
      head.className = "room-message-head";

      const author = document.createElement("span");
      author.className = "room-message-author";
      author.textContent = displayName(row.message.author, owner);

      head.append(author);

      if (row.history) {
        const badge = document.createElement("span");
        badge.className = "room-message-badge";
        badge.textContent = `History · epoch ${row.message.epoch}`;
        head.append(badge);
      }

      const time = document.createElement("time");
      time.className = "room-message-time";
      const iso = roomTimeIso(row.message.time);
      if (iso !== null) time.dateTime = iso;
      time.textContent = formatRoomTime(row.message.time);
      time.title = iso ?? "Unknown time";
      head.append(time);

      const body = document.createElement("p");
      body.className = "room-message-body";
      try {
        body.textContent = roomBodyToText(row.message.body);
      } catch {
        body.textContent = "This message could not be read.";
      }

      item.append(head, body);
      messagesList.append(item);
    }

    messageCount.textContent = roomMessageCountLabel(
      messages.length,
      rows.length,
    );
  }

  function render(): void {
    const owner = ownerId();
    if (current !== null && currentOwner !== owner) {
      current = null;
      currentOwner = null;
    }
    const state = membershipStateFor(owner);
    const signed = latestSigned();
    const waitingForOwner = owner === null;
    const busy = loading || sending || updating;

    dialog.dataset.state = waitingForOwner
      ? "waiting"
      : offline
        ? "offline"
        : loadError !== null
          ? "error"
          : state;

    waiting.hidden = !waitingForOwner;
    closeButton.disabled = sending || updating;
    doneButton.disabled = sending || updating;
    refreshButton.disabled = loading || sending || updating;

    membershipStateElement.hidden =
      waitingForOwner || (loading && current === null);
    membershipStateElement.dataset.state = state;
    membershipStateElement.textContent =
      state === "match"
        ? "Matches slots"
        : state === "mismatch"
          ? "Needs update"
          : state === "error"
            ? "Couldn't check"
            : "No membership";

    if (waitingForOwner) {
      membershipDetail.textContent =
        "Waiting for your identity before the membership can be checked.";
    } else if (offline) {
      membershipDetail.textContent =
        "The signed membership can't be checked while offline.";
    } else if (loadError !== null) {
      membershipDetail.textContent = "The signed membership couldn't be checked.";
    } else if (loading && current === null) {
      membershipDetail.textContent = "Reading the signed membership…";
    } else if (signed === null) {
      membershipDetail.textContent =
        "No signed membership yet. Create one to write messages here.";
    } else if (state === "match") {
      membershipDetail.textContent = `Signed membership ${signed.seq} matches your occupied slots (${signed.members.length} member${
        signed.members.length === 1 ? "" : "s"
      }).`;
    } else {
      membershipDetail.textContent = `Signed membership ${signed.seq} no longer matches your occupied slots.`;
    }

    const changes =
      owner === null
        ? { added: [], removed: [] }
        : roomMembershipChanges(expectedMembers(owner), signed);
    mismatch.hidden = waitingForOwner || state !== "mismatch";
    mismatch.textContent =
      changes.added.length === 0 && changes.removed.length === 0
        ? "Your occupied slots and the signed membership disagree."
        : `Your occupied slots and the signed membership disagree. ${changes.added.length} to add and ${changes.removed.length} to remove.`;

    const canShowMembers =
      !waitingForOwner &&
      (current !== null || (!offline && loadError === null && !loading));
    membersList.hidden = !canShowMembers;
    membersEmpty.hidden = canShowMembers;
    membersEmpty.textContent = waitingForOwner
      ? "Waiting for your identity."
      : loading && current === null
        ? "Reading the membership…"
        : "Membership is unavailable until the room can be read.";
    if (canShowMembers && owner !== null) {
      renderMembers(owner, signed);
    } else {
      membersList.replaceChildren();
    }

    const canUpdate =
      !waitingForOwner &&
      (state === "none" || state === "mismatch") &&
      !loading &&
      !offline &&
      loadError === null;
    if (!canUpdate) confirmPending = false;
    const showConfirm = canUpdate && confirmPending;

    updateButton.hidden = !canUpdate || showConfirm;
    updateButton.disabled = !canUpdate || busy;
    updateButton.textContent =
      state === "none" ? "Create membership" : "Update membership";

    confirmBox.hidden = !showConfirm;
    confirmUpdate.disabled = !showConfirm || busy;
    confirmCancel.disabled = !showConfirm || busy;
    confirmUpdate.textContent = updating
      ? "Working…"
      : state === "none"
        ? "Create membership"
        : "Update membership";

    if (showConfirm && owner !== null) {
      const addText =
        changes.added.length === 0
          ? "No members are added."
          : `Adds ${memberNames(changes.added, owner)}.`;
      const removeText =
        changes.removed.length === 0
          ? "No members are removed."
          : `Removes ${memberNames(changes.removed, owner)}.`;
      confirmText.textContent =
        state === "none"
          ? `Create the first signed membership? ${addText} Removed members keep earlier messages as history.`
          : `Sign a new membership to match your occupied slots? ${addText} ${removeText} Removed members keep earlier messages as history.`;
    } else {
      confirmText.textContent = "";
    }

    membershipError.hidden = membershipActionError === null;
    membershipError.textContent = membershipActionError ?? "";

    loadingLine.hidden =
      !loading || current !== null || offline || loadError !== null;
    offlineLine.hidden = !offline || waitingForOwner;
    errorLine.hidden = waitingForOwner || offline || loadError === null;
    errorLine.textContent = loadError ?? "";

    if (current === null) {
      messagesList.replaceChildren();
    } else if (owner !== null) {
      renderMessages(owner);
    }

    if (current === null && (loading || offline || loadError !== null)) {
      messageCount.textContent = "—";
    } else if (current !== null) {
      const latest = latestMembership(current);
      const rows = roomMessageRows(current.messages, latest?.seq ?? 0);
      messageCount.textContent = roomMessageCountLabel(
        current.messages.length,
        rows.length,
      );
    } else {
      messageCount.textContent = roomMessageCountLabel(0, 0);
    }

    emptyLine.hidden =
      waitingForOwner ||
      loading ||
      offline ||
      loadError !== null ||
      (current?.messages.length ?? 0) > 0;

    renderComposer(owner, state);
  }

  function handleReadError(error: unknown): void {
    const code = roomErrorCodeOf(error);
    if (code === "connection") {
      offline = true;
      loadError = null;
      deps.announce("The room is offline. Check your connection and refresh.");
      return;
    }
    offline = false;
    loadError =
      code === "config"
        ? "This build has no room configuration. Publish the room contract and reload."
        : code === "wasm"
          ? "The room contract could not load. Reload the page and try again."
          : "The room could not be read. Choose Refresh and try again.";
  }

  function handleActionError(
    error: unknown,
    action: "membership" | "message",
  ): void {
    const code = roomErrorCodeOf(error);
    const message = actionErrorText(code, action);
    if (code === "connection") offline = true;
    if (action === "membership") membershipActionError = message;
    else composerErrorText = message;
    deps.announce(message);
  }

  async function loadRoom(announceResult: boolean): Promise<void> {
    const owner = ownerId();
    const token = (readToken += 1);

    if (owner === null) {
      current = null;
      currentOwner = null;
      loading = false;
      offline = false;
      loadError = null;
      membershipActionError = null;
      confirmPending = false;
      render();
      return;
    }

    if (currentOwner !== owner) {
      current = null;
      currentOwner = null;
    }
    loading = true;
    offline = false;
    loadError = null;
    setStatus("Reading the room…");
    render();

    try {
      const state = await deps.transport.read(owner);
      if (token !== readToken) return;
      if (ownerId() !== owner) {
        render();
        return;
      }
      current = state;
      currentOwner = owner;
      offline = false;
      loadError = null;
      membershipActionError = null;
      composerErrorText = null;
      if (announceResult) {
        deps.announce("Room refreshed.");
        setStatus("Room refreshed.");
      }
    } catch (error) {
      if (token !== readToken) return;
      if (ownerId() !== owner) {
        render();
        return;
      }
      handleReadError(error);
    } finally {
      if (token === readToken) {
        loading = false;
        render();
      }
    }
  }

  async function updateMembership(): Promise<void> {
    const owner = ownerId();
    if (owner === null || updating || sending || loading) return;
    const expected = expectedMembers(owner);

    updating = true;
    membershipActionError = null;
    setStatus("Updating membership…");
    render();

    try {
      const state = await deps.transport.updateMembership(owner, expected);
      if (ownerId() !== owner) return;
      current = state;
      currentOwner = owner;
      offline = false;
      loadError = null;
      membershipActionError = null;
      confirmPending = false;
      deps.announce("Membership updated.");
      setStatus("Membership updated.");
    } catch (error) {
      if (ownerId() !== owner) return;
      handleActionError(error, "membership");
    } finally {
      updating = false;
      render();
    }
  }

  async function sendMessage(): Promise<void> {
    const owner = ownerId();
    if (owner === null || sending || updating || loading) return;
    if (offline || loadError !== null) return;

    const text = input.value;
    const problem = roomComposerProblem(text);
    if (problem !== null) {
      composerErrorText = problem;
      renderComposer(owner, membershipStateFor(owner));
      input.focus({ preventScroll: true });
      return;
    }

    const state = membershipStateFor(owner);
    if (state === "none" || state === "error") {
      composerErrorText =
        state === "none"
          ? "Create a membership before sending."
          : "The membership could not be checked. Refresh and try again.";
      renderComposer(owner, state);
      input.focus({ preventScroll: true });
      return;
    }

    sending = true;
    composerErrorText = null;
    setStatus("Sending message…");
    render();

    try {
      const next = await deps.transport.sendMessage(
        owner,
        new TextEncoder().encode(text),
      );
      if (ownerId() !== owner) return;
      current = next;
      currentOwner = owner;
      input.value = "";
      offline = false;
      loadError = null;
      deps.announce("Message sent.");
      setStatus("Message sent.");
    } catch (error) {
      if (ownerId() !== owner) return;
      handleActionError(error, "message");
    } finally {
      sending = false;
      render();
      if (dialog.open && ownerId() === owner) {
        input.focus({ preventScroll: true });
      }
    }
  }

  function open(): void {
    confirmPending = false;
    membershipActionError = null;
    composerErrorText = null;
    offline = false;
    loadError = null;
    render();
    if (!dialog.open) dialog.showModal();
    title.focus({ preventScroll: true });
    void loadRoom(false);
  }

  function refresh(): void {
    void loadRoom(false);
  }

  function close(): void {
    readToken += 1;
    loading = false;
    confirmPending = false;
    if (dialog.open) dialog.close();
  }

  updateButton.addEventListener("click", () => {
    if (updateButton.hidden) return;
    confirmPending = true;
    render();
    if (!confirmBox.hidden) {
      confirmUpdate.focus({ preventScroll: true });
    }
  });

  confirmCancel.addEventListener("click", () => {
    confirmPending = false;
    render();
    updateButton.focus({ preventScroll: true });
  });

  confirmUpdate.addEventListener("click", () => {
    void updateMembership();
  });

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage();
  });

  input.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      !input.disabled
    ) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  input.addEventListener("input", () => {
    if (composerErrorText !== null) {
      composerErrorText = null;
      composerError.hidden = true;
      composerError.textContent = "";
    }
    const owner = ownerId();
    renderComposer(owner, membershipStateFor(owner));
  });

  refreshButton.addEventListener("click", () => {
    void loadRoom(true);
  });

  closeButton.addEventListener("click", close);
  doneButton.addEventListener("click", close);

  dialog.addEventListener("close", () => {
    readToken += 1;
    loading = false;
    confirmPending = false;
  });

  render();

  return { open, refresh, close };
}
