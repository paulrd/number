/**
 * Candidates-room state v1 (`DESIGN-candidates.md` §2, §5).
 *
 * This module is the client-side mirror of `candidate/src/lib.rs`: canonical
 * compact JSON encoding, the merge join, derived request ids and the small
 * helpers the UI needs. Memberships and messages are exactly the members-room
 * records, so their parsers/encoders come from `room-state.ts`.
 *
 * Validation here is deliberately *loose*: the contract is authoritative and
 * rejects bad signatures, ordering and epoch membership. We only reject shapes
 * that would make the client throw or render nonsense.
 */

import { blake3 } from "@noble/hashes/blake3";
import {
  encodeRoomMembership,
  encodeRoomMessage,
  parseRoomMembership,
  parseRoomMessage,
  roomMessageId,
  type RoomMembershipV1,
  type RoomMessageV1,
} from "./room-state";
import { bytesToHex, hexToBytes, isLowerHex } from "./util";

/** Membership and message records are shared with the members room. */
export type CandidateMembershipV1 = RoomMembershipV1;
export type CandidateMessageV1 = RoomMessageV1;

/** One requester-signed queue entry. The requester need not be a member. */
export interface CandidateRequestV1 {
  /** Requester public key, 64 lowercase hex characters. */
  requester: string;
  /** Deepest zone-address cell, 0..32 characters from `0`..`7`; empty is the world. */
  want_cell: string;
  /** Requester-supplied milliseconds; orders display and eviction only. */
  time: number;
  /** Opaque note, 0..256 decoded bytes as lowercase hex. */
  note: string;
  /** Requester signature over the canonical request bytes. */
  sig: string;
}

/** One owner-signed request dismissal. */
export interface CandidateDismissalV1 {
  /** Derived request id, 32 lowercase hex characters. */
  id: string;
  /** Owner signature over the canonical dismissal bytes. */
  sig: string;
}

/** One owner-signed accepting flag. `seq` is monotone. */
export interface CandidateConfigV1 {
  /** Monotone sequence, always `> 0`. */
  seq: number;
  /** The owner's zone-open flag. */
  accepting: boolean;
  /** Owner signature over the canonical config bytes. */
  sig: string;
}

/** Full candidate-room state v1. `config` is required and may be `null`. */
export interface CandidateStateV1 {
  v: 1;
  memberships: CandidateMembershipV1[];
  messages: CandidateMessageV1[];
  requests: CandidateRequestV1[];
  dismissals: CandidateDismissalV1[];
  config: CandidateConfigV1 | null;
}

/** An incoming update: a full state or incremental records. */
export interface CandidateDeltaV1 {
  v: 1;
  /** Full state catch-up; mutually exclusive with the incremental fields. */
  full?: CandidateStateV1;
  memberships?: CandidateMembershipV1[];
  messages?: CandidateMessageV1[];
  requests?: CandidateRequestV1[];
  dismissals?: CandidateDismissalV1[];
  /** Absent means "no config change". */
  config?: CandidateConfigV1;
}

/** Retained requests: the bounded public queue (`MAX_REQUESTS`). */
export const CANDIDATE_MAX_REQUESTS = 8;
/** Retained owner dismissals (`MAX_DISMISSALS`). */
export const CANDIDATE_MAX_DISMISSALS = 64;
/** Retained membership revisions (`MAX_MEMBERSHIPS`). */
export const CANDIDATE_MAX_MEMBERSHIPS = 32;
/** Owners plus eight slots (`MAX_MEMBERS`). */
export const CANDIDATE_MAX_MEMBERS = 9;
/** Retained messages (`MAX_MESSAGES`). */
export const CANDIDATE_MAX_MESSAGES = 200;
/** Largest decoded message body (`MAX_BODY_BYTES`). */
export const CANDIDATE_MAX_BODY_BYTES = 1024;
/** Largest decoded secret blob (`MAX_SECRET_BLOB_BYTES`). */
export const CANDIDATE_MAX_SECRET_BLOB_BYTES = 256;
/** Largest decoded request note (`MAX_NOTE_BYTES`). */
export const CANDIDATE_MAX_NOTE_BYTES = 256;
/** Longest `want_cell` string (`MAX_WANT_CELL_CHARS`). */
export const CANDIDATE_MAX_WANT_CELL_CHARS = 32;

const KEY_HEX_LEN = 64;
const SIGNATURE_HEX_LEN = 128;
const DIGEST_HEX_LEN = 32;

/** A malformed candidate state/delta. Always thrown by the parsers. */
export class CandidateFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateFormatError";
  }
}

function fail(path: string, message: string): never {
  throw new CandidateFormatError(`${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && isLowerHex(value, KEY_HEX_LEN);
}

function isSignature(value: unknown): value is string {
  return typeof value === "string" && isLowerHex(value, SIGNATURE_HEX_LEN);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && isLowerHex(value, DIGEST_HEX_LEN);
}

function isLowerHexBytes(
  value: unknown,
  minBytes: number,
  maxBytes: number,
): value is string {
  if (typeof value !== "string" || value.length % 2 !== 0) return false;
  const bytes = value.length / 2;
  return bytes >= minBytes && bytes <= maxBytes && /^[0-9a-f]*$/.test(value);
}

/** Whether `value` is 0..32 characters from `0`..`7`. */
function isValidWantCell(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= CANDIDATE_MAX_WANT_CELL_CHARS &&
    /^[0-7]*$/.test(value)
  );
}

/** Decode and shape-check one request record. */
export function parseCandidateRequest(
  raw: unknown,
  path: string,
): CandidateRequestV1 {
  if (!isRecord(raw)) fail(path, "request must be an object");
  if (!isKey(raw.requester)) {
    fail(`${path}.requester`, "expected 64 lowercase hex characters");
  }
  if (!isValidWantCell(raw.want_cell)) {
    fail(
      `${path}.want_cell`,
      `expected 0..${CANDIDATE_MAX_WANT_CELL_CHARS} characters from 0..7`,
    );
  }
  if (typeof raw.time !== "number" || !Number.isSafeInteger(raw.time)) {
    fail(`${path}.time`, "expected a safe integer");
  }
  if (!isLowerHexBytes(raw.note, 0, CANDIDATE_MAX_NOTE_BYTES)) {
    fail(
      `${path}.note`,
      `expected 0..${CANDIDATE_MAX_NOTE_BYTES} decoded bytes as lowercase hex`,
    );
  }
  if (!isSignature(raw.sig)) {
    fail(`${path}.sig`, "expected 128 lowercase hex characters");
  }
  return {
    requester: raw.requester,
    want_cell: raw.want_cell,
    time: raw.time,
    note: raw.note,
    sig: raw.sig,
  };
}

/** Decode and shape-check one dismissal record. */
export function parseCandidateDismissal(
  raw: unknown,
  path: string,
): CandidateDismissalV1 {
  if (!isRecord(raw)) fail(path, "dismissal must be an object");
  if (!isDigest(raw.id)) {
    fail(`${path}.id`, "expected 32 lowercase hex characters");
  }
  if (!isSignature(raw.sig)) {
    fail(`${path}.sig`, "expected 128 lowercase hex characters");
  }
  return { id: raw.id, sig: raw.sig };
}

/** Decode and shape-check one config record. */
export function parseCandidateConfig(
  raw: unknown,
  path: string,
): CandidateConfigV1 {
  if (!isRecord(raw)) fail(path, "config must be an object");
  if (!isPositiveSafeInteger(raw.seq)) {
    fail(`${path}.seq`, "expected a positive safe integer");
  }
  if (typeof raw.accepting !== "boolean") {
    fail(`${path}.accepting`, "expected a boolean");
  }
  if (!isSignature(raw.sig)) {
    fail(`${path}.sig`, "expected 128 lowercase hex characters");
  }
  return { seq: raw.seq, accepting: raw.accepting, sig: raw.sig };
}

function parseStateValue(raw: unknown, path: string): CandidateStateV1 {
  if (!isRecord(raw)) fail(path, "state must be an object");
  if (raw.v !== 1) fail(`${path}.v`, "expected 1");
  if (!Array.isArray(raw.memberships)) {
    fail(`${path}.memberships`, "expected an array");
  }
  if (!Array.isArray(raw.messages)) fail(`${path}.messages`, "expected an array");
  if (!Array.isArray(raw.requests)) fail(`${path}.requests`, "expected an array");
  if (!Array.isArray(raw.dismissals)) {
    fail(`${path}.dismissals`, "expected an array");
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "config")) {
    fail(`${path}.config`, "expected the config field (null when absent)");
  }
  const config =
    raw.config === null ? null : parseCandidateConfig(raw.config, `${path}.config`);

  const memberships = raw.memberships.map((record, index) =>
    parseRoomMembership(record, `${path}.memberships[${index}]`),
  );
  const messages = raw.messages.map((message, index) =>
    parseRoomMessage(message, `${path}.messages[${index}]`),
  );
  const requests = raw.requests.map((request, index) =>
    parseCandidateRequest(request, `${path}.requests[${index}]`),
  );
  const dismissals = raw.dismissals.map((dismissal, index) =>
    parseCandidateDismissal(dismissal, `${path}.dismissals[${index}]`),
  );
  if (messages.length > 0 && memberships.length === 0) {
    fail(path, "messages require at least one membership record");
  }
  return { v: 1, memberships, messages, requests, dismissals, config };
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
    fail(
      what,
      `invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** Decode and shape-check a full candidate state. */
export function parseCandidateState(bytes: Uint8Array): CandidateStateV1 {
  return parseStateValue(decodeJson(bytes, "candidate state"), "candidate state");
}

/** Encode a request record in the contract's field order. */
export function encodeCandidateRequest(record: CandidateRequestV1): object {
  return {
    requester: record.requester,
    want_cell: record.want_cell,
    time: record.time,
    note: record.note,
    sig: record.sig,
  };
}

/** Encode a dismissal record in the contract's field order. */
export function encodeCandidateDismissal(record: CandidateDismissalV1): object {
  return { id: record.id, sig: record.sig };
}

/** Encode a config record in the contract's field order. */
export function encodeCandidateConfig(record: CandidateConfigV1): object {
  return { seq: record.seq, accepting: record.accepting, sig: record.sig };
}

/**
 * Encode a state deterministically as compact JSON, matching
 * `serde_json::to_vec` field order:
 * `v, memberships, messages, requests, dismissals, config`.
 */
export function encodeCandidateState(state: CandidateStateV1): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(encodeStateValue(state)));
}

function encodeStateValue(state: CandidateStateV1): object {
  return {
    v: 1 as const,
    memberships: state.memberships.map(encodeRoomMembership),
    messages: state.messages.map(encodeRoomMessage),
    requests: state.requests.map(encodeCandidateRequest),
    dismissals: state.dismissals.map(encodeCandidateDismissal),
    config: state.config === null ? null : encodeCandidateConfig(state.config),
  };
}

/** Decode and shape-check an incoming delta. */
export function parseCandidateDelta(bytes: Uint8Array): CandidateDeltaV1 {
  const raw = decodeJson(bytes, "candidate delta");
  if (!isRecord(raw)) fail("candidate delta", "delta must be an object");
  if (raw.v !== 1) fail("candidate delta.v", "expected 1");

  const full =
    raw.full === undefined
      ? undefined
      : parseStateValue(raw.full, "candidate delta.full");
  const memberships =
    raw.memberships === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(raw.memberships)) {
            fail("candidate delta.memberships", "expected an array");
          }
          return raw.memberships.map((record, index) =>
            parseRoomMembership(
              record,
              `candidate delta.memberships[${index}]`,
            ),
          );
        })();
  const messages =
    raw.messages === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(raw.messages)) {
            fail("candidate delta.messages", "expected an array");
          }
          return raw.messages.map((message, index) =>
            parseRoomMessage(message, `candidate delta.messages[${index}]`),
          );
        })();
  const requests =
    raw.requests === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(raw.requests)) {
            fail("candidate delta.requests", "expected an array");
          }
          return raw.requests.map((request, index) =>
            parseCandidateRequest(
              request,
              `candidate delta.requests[${index}]`,
            ),
          );
        })();
  const dismissals =
    raw.dismissals === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(raw.dismissals)) {
            fail("candidate delta.dismissals", "expected an array");
          }
          return raw.dismissals.map((dismissal, index) =>
            parseCandidateDismissal(
              dismissal,
              `candidate delta.dismissals[${index}]`,
            ),
          );
        })();
  const config =
    raw.config === undefined || raw.config === null
      ? undefined
      : parseCandidateConfig(raw.config, "candidate delta.config");

  if (
    full !== undefined &&
    ((memberships?.length ?? 0) > 0 ||
      (messages?.length ?? 0) > 0 ||
      (requests?.length ?? 0) > 0 ||
      (dismissals?.length ?? 0) > 0 ||
      config !== undefined)
  ) {
    fail("candidate delta", "full is mutually exclusive with incremental fields");
  }
  return { v: 1, full, memberships, messages, requests, dismissals, config };
}

/**
 * Encode a delta as compact JSON with the contract's field order
 * (`v, full, memberships, messages, requests, dismissals, config`). Empty
 * incremental arrays are omitted, like `skip_serializing_if` in Rust.
 */
export function encodeCandidateDelta(delta: CandidateDeltaV1): Uint8Array {
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
  if (delta.requests !== undefined && delta.requests.length > 0) {
    value.requests = delta.requests.map(encodeCandidateRequest);
  }
  if (delta.dismissals !== undefined && delta.dismissals.length > 0) {
    value.dismissals = delta.dismissals.map(encodeCandidateDismissal);
  }
  if (delta.config !== undefined) {
    value.config = encodeCandidateConfig(delta.config);
  }
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Derived request id: `lowercase_hex(BLAKE3(raw_sig)[0..16])`. */
export function candidateRequestId(request: CandidateRequestV1): string {
  let signature: Uint8Array;
  try {
    signature = hexToBytes(request.sig);
  } catch {
    throw new CandidateFormatError("request.sig is not valid hex");
  }
  return bytesToHex(blake3(signature).slice(0, 16));
}

/** State digest: `lowercase_hex(BLAKE3(encodeCandidateState(state))[0..16])`. */
export function candidateDigest(state: CandidateStateV1): string {
  return bytesToHex(blake3(encodeCandidateState(state)).slice(0, 16));
}

/** The retained membership with the greatest `(seq, sig)`, or null. */
export function latestCandidateMembership(
  state: CandidateStateV1,
): CandidateMembershipV1 | null {
  let latest: CandidateMembershipV1 | null = null;
  for (const record of state.memberships) {
    if (
      latest === null ||
      record.seq > latest.seq ||
      (record.seq === latest.seq && record.sig > latest.sig)
    ) {
      latest = record;
    }
  }
  return latest;
}

/** The config with the greatest `(seq, sig)`, or null. */
export function latestCandidateConfig(
  state: CandidateStateV1,
): CandidateConfigV1 | null {
  return state.config === null ? null : state.config;
}

/** A state with no config is accepting (the initial state has none). */
export function isAccepting(state: CandidateStateV1): boolean {
  return state.config?.accepting ?? true;
}

function compareRequests(
  a: CandidateRequestV1,
  b: CandidateRequestV1,
): number {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  const aId = candidateRequestId(a);
  const bId = candidateRequestId(b);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

function compareMessages(
  a: CandidateMessageV1,
  b: CandidateMessageV1,
): number {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  const aId = roomMessageId(a);
  const bId = roomMessageId(b);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

function mergeConfigs(
  a: CandidateConfigV1 | null,
  b: CandidateConfigV1 | null,
): CandidateConfigV1 | null {
  if (a === null) return b === null ? null : { ...b };
  if (b === null) return { ...a };
  if (a.seq !== b.seq) return { ...(a.seq > b.seq ? a : b) };
  return { ...(a.sig > b.sig ? a : b) };
}

/**
 * Join-semilattice merge mirroring `candidate/src/lib.rs`:
 *
 * - memberships union by `seq`; equal `seq` keeps the lexicographically greater
 *   signature; ascending; newest 32.
 * - messages union by id; drop unknown epochs and non-members at that epoch;
 *   sort by `(time, id)`; newest 200.
 * - dismissals union by id, keep the greatest signature per id, ascending;
 *   greatest 64 by id.
 * - requests union by id, drop dismissed ids, sort by `(time, id)`; newest 8.
 * - config with the greatest `(seq, sig)`; `null` is the identity.
 */
export function mergeCandidateStates(
  a: CandidateStateV1,
  b: CandidateStateV1,
): CandidateStateV1 {
  const bySeq = new Map<number, CandidateMembershipV1>();
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
  if (memberships.length > CANDIDATE_MAX_MEMBERSHIPS) {
    memberships = memberships.slice(
      memberships.length - CANDIDATE_MAX_MEMBERSHIPS,
    );
  }

  const membersAt = new Map<number, Set<string>>();
  for (const record of memberships) {
    membersAt.set(record.seq, new Set(record.members));
  }

  const messagesById = new Map<string, CandidateMessageV1>();
  for (const message of [...a.messages, ...b.messages]) {
    const members = membersAt.get(message.epoch);
    if (!members || !members.has(message.author)) continue;
    const id = roomMessageId(message);
    if (!messagesById.has(id)) messagesById.set(id, { ...message });
  }
  let messages = [...messagesById.values()].sort(compareMessages);
  if (messages.length > CANDIDATE_MAX_MESSAGES) {
    messages = messages.slice(messages.length - CANDIDATE_MAX_MESSAGES);
  }

  const dismissalSigs = new Map<string, string>();
  for (const dismissal of [...a.dismissals, ...b.dismissals]) {
    const previous = dismissalSigs.get(dismissal.id);
    if (previous === undefined || dismissal.sig > previous) {
      dismissalSigs.set(dismissal.id, dismissal.sig);
    }
  }
  let dismissals = [...dismissalSigs.entries()]
    .map(([id, sig]) => ({ id, sig }))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  if (dismissals.length > CANDIDATE_MAX_DISMISSALS) {
    dismissals = dismissals.slice(
      dismissals.length - CANDIDATE_MAX_DISMISSALS,
    );
  }

  const dismissed = new Set(dismissals.map((dismissal) => dismissal.id));
  const requestsById = new Map<string, CandidateRequestV1>();
  for (const request of [...a.requests, ...b.requests]) {
    const id = candidateRequestId(request);
    if (dismissed.has(id)) continue;
    if (!requestsById.has(id)) requestsById.set(id, { ...request });
  }
  let requests = [...requestsById.values()].sort(compareRequests);
  if (requests.length > CANDIDATE_MAX_REQUESTS) {
    requests = requests.slice(requests.length - CANDIDATE_MAX_REQUESTS);
  }

  return {
    v: 1,
    memberships,
    messages,
    requests,
    dismissals,
    config: mergeConfigs(a.config, b.config),
  };
}

/** UTF-8 text to the contract's lowercase-hex note encoding. */
export function textToCandidateNote(text: string): string {
  return bytesToHex(new TextEncoder().encode(text));
}

/**
 * Decode a lowercase-hex note. Invalid UTF-8 becomes U+FFFD replacement
 * characters; malformed hex raises a typed `CandidateFormatError`.
 */
export function candidateNoteToText(noteHex: string): string {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(noteHex);
  } catch (error) {
    throw new CandidateFormatError(
      `candidate note is not valid hex: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
