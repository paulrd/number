/**
 * Members-room state v1 (`DESIGN-rooms.md` §2, §5).
 *
 * This module is the client-side mirror of `room/src/lib.rs`: canonical compact
 * JSON encoding, the merge join, and the small derived helpers the UI needs.
 * Validation here is deliberately *loose*: the contract is authoritative and
 * rejects bad signatures, epochs and ordering. We only reject shapes that would
 * make the client throw or render nonsense.
 */

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, hexToBytes, isLowerHex } from "./util";

export interface RoomSecretV1 {
  /** Member public key, 64 lowercase hex characters. */
  recipient: string;
  /** Opaque blob (P3c: an ECIES-wrapped epoch key), lowercase hex. */
  blob: string;
}

export interface RoomMembershipV1 {
  /** Revision and epoch, always `> 0`. */
  seq: number;
  /** Strictly ascending, duplicate-free member keys, including the owner. */
  members: string[];
  /** Empty, or exactly one blob per member in ascending member order. */
  secrets: RoomSecretV1[];
  /** Owner signature over the canonical membership bytes. */
  sig: string;
}

export interface RoomMessageV1 {
  /** Author public key, 64 lowercase hex characters. */
  author: string;
  /** Membership epoch the message belongs to, always `> 0`. */
  epoch: number;
  /** Author-assigned per-author sequence, always `> 0`. */
  seq: number;
  /** Author-supplied milliseconds; orders display and eviction only. */
  time: number;
  /** Opaque body (plaintext in P3b, ciphertext from P3c), lowercase hex. */
  body: string;
  /** Author signature over the canonical message bytes. */
  sig: string;
}

export interface RoomStateV1 {
  v: 1;
  memberships: RoomMembershipV1[];
  messages: RoomMessageV1[];
}

export interface RoomDeltaV1 {
  v: 1;
  /** Full state catch-up; mutually exclusive with the incremental fields. */
  full?: RoomStateV1;
  memberships?: RoomMembershipV1[];
  messages?: RoomMessageV1[];
}

export const ROOM_MAX_MESSAGES = 200;
export const ROOM_MAX_BODY_BYTES = 1024;

/** Retained membership revisions (`MAX_MEMBERSHIPS` in the contract). */
const ROOM_MAX_MEMBERSHIPS = 32;
/** Owners plus eight slots (`MAX_MEMBERS` in the contract). */
const ROOM_MAX_MEMBERS = 9;
/** Largest decoded secret blob (`MAX_SECRET_BLOB_BYTES` in the contract). */
const ROOM_MAX_SECRET_BLOB_BYTES = 256;

const KEY_HEX_LEN = 64;
const SIGNATURE_HEX_LEN = 128;

/** A malformed room state/delta. Always thrown as this type by the parsers. */
export class RoomFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomFormatError";
  }
}

function fail(path: string, message: string): never {
  throw new RoomFormatError(`${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRoomKey(value: unknown): value is string {
  return typeof value === "string" && isLowerHex(value, KEY_HEX_LEN);
}

function isRoomSignature(value: unknown): value is string {
  return typeof value === "string" && isLowerHex(value, SIGNATURE_HEX_LEN);
}

function isLowerHexBytes(
  value: unknown,
  minBytes: number,
  maxBytes: number,
): value is string {
  if (typeof value !== "string" || value.length % 2 !== 0) return false;
  const bytes = value.length / 2;
  return (
    bytes >= minBytes &&
    bytes <= maxBytes &&
    /^[0-9a-f]*$/.test(value)
  );
}

function parseSecret(raw: unknown, path: string): RoomSecretV1 {
  if (!isRecord(raw)) fail(path, "secret must be an object");
  if (!isRoomKey(raw.recipient)) {
    fail(`${path}.recipient`, "expected 64 lowercase hex characters");
  }
  if (!isLowerHexBytes(raw.blob, 1, ROOM_MAX_SECRET_BLOB_BYTES)) {
    fail(
      `${path}.blob`,
      `expected 1..${ROOM_MAX_SECRET_BLOB_BYTES} decoded bytes as lowercase hex`,
    );
  }
  return { recipient: raw.recipient, blob: raw.blob };
}

/** Decode and shape-check one membership record. */
export function parseRoomMembership(
  raw: unknown,
  path: string,
): RoomMembershipV1 {
  if (!isRecord(raw)) fail(path, "membership must be an object");
  if (!isPositiveSafeInteger(raw.seq)) {
    fail(`${path}.seq`, "expected a positive safe integer");
  }
  if (!Array.isArray(raw.members)) fail(`${path}.members`, "expected an array");
  if (raw.members.length < 1 || raw.members.length > ROOM_MAX_MEMBERS) {
    fail(
      `${path}.members`,
      `expected 1..${ROOM_MAX_MEMBERS} members, got ${raw.members.length}`,
    );
  }
  const members: string[] = [];
  for (let index = 0; index < raw.members.length; index++) {
    const member = raw.members[index];
    if (typeof member !== "string" || !isRoomKey(member)) {
      fail(`${path}.members[${index}]`, "expected 64 lowercase hex characters");
    }
    if (index > 0 && members[index - 1] >= member) {
      fail(`${path}.members`, "members must be strictly ascending");
    }
    members.push(member);
  }

  if (!Array.isArray(raw.secrets)) fail(`${path}.secrets`, "expected an array");
  if (raw.secrets.length !== 0 && raw.secrets.length !== members.length) {
    fail(`${path}.secrets`, "expected empty or one blob per member");
  }
  const secrets = raw.secrets.map((secret, index) =>
    parseSecret(secret, `${path}.secrets[${index}]`),
  );
  for (let index = 0; index < secrets.length; index++) {
    if (secrets[index].recipient !== members[index]) {
      fail(
        `${path}.secrets[${index}].recipient`,
        "must match the member at the same index",
      );
    }
  }

  if (!isRoomSignature(raw.sig)) {
    fail(`${path}.sig`, "expected 128 lowercase hex characters");
  }
  return { seq: raw.seq, members, secrets, sig: raw.sig };
}

/** Decode and shape-check one message record. */
export function parseRoomMessage(
  raw: unknown,
  path: string,
): RoomMessageV1 {
  if (!isRecord(raw)) fail(path, "message must be an object");
  if (!isRoomKey(raw.author)) {
    fail(`${path}.author`, "expected 64 lowercase hex characters");
  }
  if (!isPositiveSafeInteger(raw.epoch)) {
    fail(`${path}.epoch`, "expected a positive safe integer");
  }
  if (!isPositiveSafeInteger(raw.seq)) {
    fail(`${path}.seq`, "expected a positive safe integer");
  }
  if (typeof raw.time !== "number" || !Number.isSafeInteger(raw.time)) {
    fail(`${path}.time`, "expected a safe integer");
  }
  if (!isLowerHexBytes(raw.body, 1, ROOM_MAX_BODY_BYTES)) {
    fail(
      `${path}.body`,
      `expected 1..${ROOM_MAX_BODY_BYTES} decoded bytes as lowercase hex`,
    );
  }
  if (!isRoomSignature(raw.sig)) {
    fail(`${path}.sig`, "expected 128 lowercase hex characters");
  }
  return {
    author: raw.author,
    epoch: raw.epoch,
    seq: raw.seq,
    time: raw.time,
    body: raw.body,
    sig: raw.sig,
  };
}

function parseStateValue(raw: unknown, path: string): RoomStateV1 {
  if (!isRecord(raw)) fail(path, "state must be an object");
  if (raw.v !== 1) fail(`${path}.v`, "expected 1");
  if (!Array.isArray(raw.memberships)) {
    fail(`${path}.memberships`, "expected an array");
  }
  if (!Array.isArray(raw.messages)) fail(`${path}.messages`, "expected an array");

  const memberships = raw.memberships.map((record, index) =>
    parseRoomMembership(record, `${path}.memberships[${index}]`),
  );
  const messages = raw.messages.map((message, index) =>
    parseRoomMessage(message, `${path}.messages[${index}]`),
  );
  if (messages.length > 0 && memberships.length === 0) {
    fail(path, "messages require at least one membership record");
  }
  return { v: 1, memberships, messages };
}

function decodeJson(bytes: Uint8Array, what: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(what, "bytes are not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(what, `invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Decode and shape-check a full room state. */
export function parseRoomState(bytes: Uint8Array): RoomStateV1 {
  return parseStateValue(decodeJson(bytes, "room state"), "room state");
}

/**
 * Encode a state deterministically as compact JSON, matching
 * `serde_json::to_vec` field order:
 * `v, memberships, messages`; membership `seq, members, secrets, sig`;
 * secret `recipient, blob`; message `author, epoch, seq, time, body, sig`.
 */
export function encodeRoomState(state: RoomStateV1): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(encodeStateValue(state)));
}

/** Encode a membership record in the contract's field order. */
export function encodeRoomMembership(
  record: RoomMembershipV1,
): object {
  return {
    seq: record.seq,
    members: [...record.members],
    secrets: record.secrets.map((secret) => ({
      recipient: secret.recipient,
      blob: secret.blob,
    })),
    sig: record.sig,
  };
}

/** Encode a message record in the contract's field order. */
export function encodeRoomMessage(message: RoomMessageV1): object {
  return {
    author: message.author,
    epoch: message.epoch,
    seq: message.seq,
    time: message.time,
    body: message.body,
    sig: message.sig,
  };
}

function encodeStateValue(state: RoomStateV1): object {
  return {
    v: 1 as const,
    memberships: state.memberships.map(encodeRoomMembership),
    messages: state.messages.map(encodeRoomMessage),
  };
}

/** Decode and shape-check an incoming delta. */
export function parseRoomDelta(bytes: Uint8Array): RoomDeltaV1 {
  const raw = decodeJson(bytes, "room delta");
  if (!isRecord(raw)) fail("room delta", "delta must be an object");
  if (raw.v !== 1) fail("room delta.v", "expected 1");

  const full =
    raw.full === undefined
      ? undefined
      : parseStateValue(raw.full, "room delta.full");
  const memberships =
    raw.memberships === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(raw.memberships)) {
            fail("room delta.memberships", "expected an array");
          }
          return raw.memberships.map((record, index) =>
            parseRoomMembership(record, `room delta.memberships[${index}]`),
          );
        })();
  const messages =
    raw.messages === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(raw.messages)) {
            fail("room delta.messages", "expected an array");
          }
          return raw.messages.map((message, index) =>
            parseRoomMessage(message, `room delta.messages[${index}]`),
          );
        })();

  if (
    full !== undefined &&
    ((memberships?.length ?? 0) > 0 || (messages?.length ?? 0) > 0)
  ) {
    fail("room delta", "full is mutually exclusive with incremental fields");
  }
  return { v: 1, full, memberships, messages };
}

/**
 * Encode a delta as compact JSON with the contract's field order
 * (`v, full, memberships, messages`). Empty incremental arrays are omitted,
 * like `skip_serializing_if = "Vec::is_empty"` in the Rust struct.
 */
export function encodeRoomDelta(delta: RoomDeltaV1): Uint8Array {
  const value: Record<string, unknown> = { v: 1 };
  if (delta.full !== undefined) {
    value.full = encodeStateValue(delta.full);
  }
  if (delta.memberships !== undefined && delta.memberships.length > 0) {
    value.memberships = delta.memberships.map(encodeRoomMembership);
  }
  if (delta.messages !== undefined && delta.messages.length > 0) {
    value.messages = delta.messages.map(encodeRoomMessage);
  }
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Derived message id: `lowercase_hex(BLAKE3(raw_sig)[0..16])`. */
export function roomMessageId(message: RoomMessageV1): string {
  let signature: Uint8Array;
  try {
    signature = hexToBytes(message.sig);
  } catch {
    throw new RoomFormatError("message.sig is not valid hex");
  }
  return bytesToHex(blake3(signature).slice(0, 16));
}

/** State digest: `lowercase_hex(BLAKE3(encodeRoomState(state))[0..16])`. */
export function roomDigest(state: RoomStateV1): string {
  return bytesToHex(blake3(encodeRoomState(state)).slice(0, 16));
}

/** The retained membership with the greatest `seq`, or null. */
export function latestMembership(
  state: RoomStateV1,
): RoomMembershipV1 | null {
  let latest: RoomMembershipV1 | null = null;
  for (const record of state.memberships) {
    if (latest === null || record.seq > latest.seq) latest = record;
  }
  return latest;
}

function compareMessages(a: RoomMessageV1, b: RoomMessageV1): number {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  const aId = roomMessageId(a);
  const bId = roomMessageId(b);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * Join-semilattice merge mirroring `room/src/lib.rs` (`merge_states`):
 *
 * - memberships union by `seq`; equal `seq` keeps the lexicographically greater
 *   signature; ascending; newest 32.
 * - messages union by id; drop unknown epochs and non-members at that epoch;
 *   sort by `(time, id)`; newest 200.
 */
export function mergeRoomStates(
  a: RoomStateV1,
  b: RoomStateV1,
): RoomStateV1 {
  const bySeq = new Map<number, RoomMembershipV1>();
  for (const record of [...a.memberships, ...b.memberships]) {
    const previous = bySeq.get(record.seq);
    if (!previous || record.sig > previous.sig) {
      bySeq.set(record.seq, {
        seq: record.seq,
        members: [...record.members],
        secrets: record.secrets.map((secret) => ({ ...secret })),
        sig: record.sig,
      });
    }
  }
  let memberships = [...bySeq.values()].sort((x, y) => x.seq - y.seq);
  if (memberships.length > ROOM_MAX_MEMBERSHIPS) {
    memberships = memberships.slice(memberships.length - ROOM_MAX_MEMBERSHIPS);
  }

  const membersAt = new Map<number, Set<string>>();
  for (const record of memberships) {
    membersAt.set(record.seq, new Set(record.members));
  }

  const byId = new Map<string, RoomMessageV1>();
  for (const message of [...a.messages, ...b.messages]) {
    const members = membersAt.get(message.epoch);
    if (!members || !members.has(message.author)) continue;
    const id = roomMessageId(message);
    if (!byId.has(id)) byId.set(id, { ...message });
  }
  let messages = [...byId.values()].sort(compareMessages);
  if (messages.length > ROOM_MAX_MESSAGES) {
    messages = messages.slice(messages.length - ROOM_MAX_MESSAGES);
  }

  return { v: 1, memberships, messages };
}

/** `[owner] ∪ contacts`, deduplicated and ascending. */
export function deriveRoomMembers(
  ownerId: string,
  contacts: ReadonlyArray<string>,
): string[] {
  const unique = new Set<string>();
  if (ownerId) unique.add(ownerId);
  for (const contact of contacts) {
    if (contact) unique.add(contact);
  }
  return [...unique].sort();
}

/** UTF-8 text to the contract's lowercase-hex body encoding. */
export function textToRoomBody(text: string): string {
  return bytesToHex(new TextEncoder().encode(text));
}

/**
 * Decode a lowercase-hex body. Invalid UTF-8 becomes U+FFFD replacement
 * characters; malformed hex still raises a typed `RoomFormatError`.
 */
export function roomBodyToText(bodyHex: string): string {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(bodyHex);
  } catch (error) {
    throw new RoomFormatError(
      `room body is not valid hex: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
