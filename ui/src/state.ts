/**
 * Contract state, delta, and summary codecs plus the client-side merge.
 *
 * These shapes are the v3 wire format in DESIGN.md §2–§5 and the v3 spec §2.
 * The browser cannot run Ed25519 verification here, but it can enforce every
 * structural and bounds rule, build the canonical signing bytes (for summaries
 * and optimistic digests), and merge with exactly the same
 * max-over-seq/signature rule as the contract. The contract remains the
 * authority; a bad local merge is corrected by the next GET/notification.
 *
 * v3 adds a signed `parent` record (board tree) to the v2 shape. The slot and
 * contacts signing bytes are unchanged from v2, so a v2 state upgrades by
 * adding an empty parent; `validateState`/`decodeState` accept both versions
 * and always return v3.
 */

import { blake3 } from "@noble/hashes/blake3";
import {
  isInteger,
  isSafeNumber,
  parse as parseJsonLossless,
  stringify as stringifyJsonLossless,
} from "lossless-json";
import { bytesToHex, hexToBytes, isLowerHex, utf8Length } from "./util";

export const SLOT_COUNT = 8;
export const MAX_CONTACTS = 64;
export const STATE_VERSION = 3 as const;
/**
 * The predecessor wire version. A v2 state has no parent and is upgraded on
 * read; it is never written.
 */
export const LEGACY_STATE_VERSION = 2 as const;

export const LIMITS = {
  /** Contact label limit, in UTF-8 bytes. */
  label: 64,
  unit: 16,
  note: 512,
} as const;

export const USER_ID_HEX_LEN = 64;

export const SIGNING_DOMAIN_SLOT = "number:v2:slot";
export const SIGNING_DOMAIN_CONTACTS = "number:v2:contacts";
export const SIGNING_DOMAIN_PARENT = "number:v3:parent";

export const I64_MIN = -(2n ** 63n);
export const I64_MAX = 2n ** 63n - 1n;

/** The human-readable cent range for error messages. */
export const CENTS_RANGE = "-92233720368547758.08";
export const CENTS_MAX = "92233720368547758.07";

export interface Contact {
  label: string;
  /** 32-byte Ed25519 public key as 64 lowercase hex characters. */
  userId: string;
}

export interface ContactsRecord {
  seq: number;
  entries: Contact[];
  sig: string | null;
}

export interface Entry {
  /** Exact signed 64-bit count of hundredths. A JS `number` cannot hold the
   * full range, so the wire JSON is parsed losslessly and this is a bigint. */
  value: bigint;
  /** The owner's contact id; mandatory, 64 lowercase hex characters. */
  contact: string;
  unit: string | null;
  note: string | null;
}

export interface Slot {
  seq: number;
  entry: Entry | null;
  sig: string | null;
}

export interface ParentRecord {
  seq: number;
  /** Parent board owner id, or null for a root / cleared parent. */
  userId: string | null;
  sig: string | null;
}

export interface StateV3 {
  v: 3;
  parent: ParentRecord;
  contacts: ContactsRecord;
  slots: Slot[];
}

export interface DeltaSlot {
  i: number;
  seq: number;
  entry: Entry | null;
  sig: string | null;
}

export interface Delta {
  v: 3;
  /** `null` when the parent record is unchanged. */
  parent: ParentRecord | null;
  /** `null` when the contacts record is unchanged. */
  contacts: ContactsRecord | null;
  slots: DeltaSlot[];
}

export type SummarySlot = [seq: number, digest16: string];

export interface Summary {
  v: 3;
  parent: SummarySlot;
  contacts: SummarySlot;
  slots: SummarySlot[];
}

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

const textEncoder = new TextEncoder();
const SLOT_PREFIX = textEncoder.encode(SIGNING_DOMAIN_SLOT);
const CONTACTS_PREFIX = textEncoder.encode(SIGNING_DOMAIN_CONTACTS);
const PARENT_PREFIX = textEncoder.encode(SIGNING_DOMAIN_PARENT);
const ZERO_DIGEST16 = "0".repeat(32);

function fail(path: string, message: string): never {
  throw new StateError(`${path}: ${message}`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function validateSeq(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "expected a non-negative safe integer");
  }
  return value;
}

/**
 * Validate an exact i64. Numbers are accepted for compatibility with tests and
 * callers that hold small literals, but anything outside the safe-integer range
 * must already be a bigint (the lossless JSON parser produces one).
 */
export function isI64(value: bigint | number): boolean {
  if (typeof value === "bigint") return value >= I64_MIN && value <= I64_MAX;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return false;
  }
  return Number.isSafeInteger(value) || value === Number(I64_MIN);
}

function validateValue(value: unknown, path: string): bigint {
  if (typeof value === "bigint") {
    if (value < I64_MIN || value > I64_MAX) {
      fail(path, "must fit in a signed 64-bit integer");
    }
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "expected an integer");
  }
  if (!Number.isInteger(value)) {
    fail(path, "expected an integer");
  }
  if (!Number.isSafeInteger(value)) {
    // A number this large has already been rounded by the time it reaches us.
    // Lossless JSON decoding yields a bigint instead; a plain number here means
    // the caller built it with arithmetic, which cannot be trusted.
    fail(path, "must be an exact integer (use a bigint above 2^53)");
  }
  return BigInt(value);
}

function validateOptionalText(
  value: unknown,
  path: string,
  limit: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(path, "expected a string or null");
  if (value.length === 0) return null; // null and "" are the same on the wire
  const length = utf8Length(value);
  if (length > limit) {
    fail(path, `UTF-8 length ${length} exceeds the ${limit}-byte limit`);
  }
  return value;
}

function validateSignature(value: unknown, path: string): string {
  if (typeof value !== "string" || !isLowerHex(value, 128)) {
    fail(path, "expected 128 lowercase hex characters");
  }
  return value;
}

function validateUserId(value: unknown, path: string): string {
  if (typeof value !== "string" || !isLowerHex(value, USER_ID_HEX_LEN)) {
    fail(path, `expected ${USER_ID_HEX_LEN} lowercase hex characters (a userId)`);
  }
  return value;
}

/** Validate/normalise one contact. Labels are not trimmed here. */
export function validateContact(raw: unknown, path = "contact"): Contact {
  const obj = asRecord(raw, path);
  const label = obj.label;
  if (typeof label !== "string") fail(`${path}.label`, "expected a string");
  if (label.length === 0) fail(`${path}.label`, "must not be empty");
  const length = utf8Length(label);
  if (length > LIMITS.label) {
    fail(
      `${path}.label`,
      `UTF-8 length ${length} exceeds the ${LIMITS.label}-byte limit`,
    );
  }
  return {
    label,
    userId: validateUserId(obj.userId, `${path}.userId`),
  };
}

/**
 * Validate a contact list: at most MAX_CONTACTS entries, no duplicate userId
 * and no duplicate exact label. Order is significant and preserved.
 */
export function validateContactList(
  raw: unknown,
  path = "contacts.entries",
): Contact[] {
  if (!Array.isArray(raw)) fail(path, "expected an array");
  if (raw.length > MAX_CONTACTS) {
    fail(path, `expected at most ${MAX_CONTACTS} contacts`);
  }
  const entries = raw.map((value, index) => validateContact(value, `${path}[${index}]`));
  const userIds = new Set<string>();
  const labels = new Set<string>();
  for (const [index, contact] of entries.entries()) {
    if (userIds.has(contact.userId)) {
      fail(`${path}[${index}].userId`, `duplicate userId ${contact.userId}`);
    }
    userIds.add(contact.userId);
    if (labels.has(contact.label)) {
      fail(`${path}[${index}].label`, `duplicate label ${JSON.stringify(contact.label)}`);
    }
    labels.add(contact.label);
  }
  return entries;
}

/** Validate/normalise the signed contacts record. */
export function validateContacts(raw: unknown, path = "contacts"): ContactsRecord {
  const obj = asRecord(raw, path);
  const seq = validateSeq(obj.seq, `${path}.seq`);
  const entries = validateContactList(obj.entries ?? [], `${path}.entries`);

  let sig: string | null = null;
  if (obj.sig !== undefined && obj.sig !== null) {
    sig = validateSignature(obj.sig, `${path}.sig`);
  }

  if (seq === 0) {
    if (entries.length > 0) {
      fail(path, "seq 0 must have no contacts");
    }
    if (sig !== null) {
      fail(path, "seq 0 must have a null signature");
    }
  } else if (sig === null) {
    fail(path, "seq > 0 requires a signature");
  }

  return { seq, entries, sig };
}

/** Validate/normalise the signed parent record. */
export function validateParent(raw: unknown, path = "parent"): ParentRecord {
  const obj = asRecord(raw, path);
  const seq = validateSeq(obj.seq, `${path}.seq`);

  let userId: string | null = null;
  if (obj.userId !== undefined && obj.userId !== null) {
    userId = validateUserId(obj.userId, `${path}.userId`);
  }

  let sig: string | null = null;
  if (obj.sig !== undefined && obj.sig !== null) {
    sig = validateSignature(obj.sig, `${path}.sig`);
  }

  if (seq === 0) {
    if (userId !== null) fail(path, "seq 0 must have a null userId");
    if (sig !== null) fail(path, "seq 0 must have a null signature");
  } else {
    // seq > 0 always signs a record, even when userId is null (cleared).
    if (sig === null) fail(path, "seq > 0 requires a signature");
  }

  return { seq, userId, sig };
}

/** Validate/normalise one entry. Optional strings become null, never "". */
export function validateEntry(raw: unknown, path = "entry"): Entry {
  const obj = asRecord(raw, path);
  return {
    // `value` is optional on the wire; absent means zero.
    value: validateValue(obj.value === undefined ? 0 : obj.value, `${path}.value`),
    contact: validateUserId(obj.contact, `${path}.contact`),
    unit: validateOptionalText(obj.unit, `${path}.unit`, LIMITS.unit),
    note: validateOptionalText(obj.note, `${path}.note`, LIMITS.note),
  };
}

export function validateSlot(raw: unknown, index: number, path = `slots[${index}]`): Slot {
  const obj = asRecord(raw, path);
  const seq = validateSeq(obj.seq, `${path}.seq`);
  const entryRaw = obj.entry ?? null;
  const sigRaw = obj.sig ?? null;

  if (seq === 0 && entryRaw !== null) {
    fail(path, "seq 0 must have a null entry");
  }
  if (seq === 0 && sigRaw !== null) {
    fail(path, "seq 0 must have a null signature");
  }

  let entry: Entry | null = null;
  if (entryRaw !== null) {
    entry = validateEntry(entryRaw, `${path}.entry`);
  }

  let sig: string | null = null;
  if (sigRaw !== null) {
    sig = validateSignature(sigRaw, `${path}.sig`);
  }
  if (seq > 0 && sig === null) {
    fail(path, "seq > 0 requires a signature");
  }

  return { seq, entry, sig };
}

export function validateState(raw: unknown): StateV3 {
  const obj = asRecord(raw, "state");
  let parent: ParentRecord;
  if (obj.v === STATE_VERSION) {
    parent = validateParent(obj.parent, "state.parent");
  } else if (obj.v === LEGACY_STATE_VERSION) {
    // v2 never had a parent field. Explicitly reject it rather than silently
    // dropping signed data; the client upgrade adds an empty parent.
    if (obj.parent !== undefined) {
      fail("state.parent", "a v2 state must not carry a parent record");
    }
    parent = emptyParent();
  } else {
    fail("state.v", `expected ${LEGACY_STATE_VERSION} or ${STATE_VERSION}`);
  }

  const contacts = validateContacts(obj.contacts, "state.contacts");
  if (!Array.isArray(obj.slots) || obj.slots.length !== SLOT_COUNT) {
    fail("state.slots", `expected exactly ${SLOT_COUNT} slots`);
  }
  return {
    v: STATE_VERSION,
    parent,
    contacts,
    slots: obj.slots.map((slot, index) => validateSlot(slot, index)),
  };
}

export function validateDelta(raw: unknown): Delta {
  const obj = asRecord(raw, "delta");
  if (obj.v !== STATE_VERSION) fail("delta.v", `expected ${STATE_VERSION}`);

  const parent =
    obj.parent === undefined || obj.parent === null
      ? null
      : validateParent(obj.parent, "delta.parent");

  const contacts =
    obj.contacts === undefined || obj.contacts === null
      ? null
      : validateContacts(obj.contacts, "delta.contacts");

  if (!Array.isArray(obj.slots)) fail("delta.slots", "expected an array");

  const seen = new Set<number>();
  const slots: DeltaSlot[] = obj.slots.map((rawSlot, index) => {
    const path = `delta.slots[${index}]`;
    const slotObj = asRecord(rawSlot, path);
    const i = slotObj.i;
    if (
      typeof i !== "number" ||
      !Number.isSafeInteger(i) ||
      i < 0 ||
      i >= SLOT_COUNT
    ) {
      fail(`${path}.i`, `expected an integer in 0..${SLOT_COUNT - 1}`);
    }
    if (seen.has(i)) fail(`${path}.i`, `duplicate slot index ${i}`);
    seen.add(i);
    const validated = validateSlot(slotObj, i, path);
    return { i, ...validated };
  });

  return { v: STATE_VERSION, parent, contacts, slots };
}

function validateSummaryPair(raw: unknown, path: string): SummarySlot {
  if (!Array.isArray(raw) || raw.length !== 2) {
    fail(path, "expected [seq, digest16]");
  }
  const seq = validateSeq(raw[0], `${path}[0]`);
  const digest = raw[1];
  if (typeof digest !== "string" || !isLowerHex(digest, 32)) {
    fail(`${path}[1]`, "expected 32 lowercase hex characters");
  }
  return [seq, digest];
}

export function validateSummary(raw: unknown): Summary {
  const obj = asRecord(raw, "summary");
  if (obj.v !== STATE_VERSION) fail("summary.v", `expected ${STATE_VERSION}`);
  const parent = validateSummaryPair(obj.parent, "summary.parent");
  const contacts = validateSummaryPair(obj.contacts, "summary.contacts");
  if (!Array.isArray(obj.slots) || obj.slots.length !== SLOT_COUNT) {
    fail("summary.slots", `expected exactly ${SLOT_COUNT} pairs`);
  }
  return {
    v: STATE_VERSION,
    parent,
    contacts,
    slots: obj.slots.map((pair, index) =>
      validateSummaryPair(pair, `summary.slots[${index}]`),
    ),
  };
}

/**
 * Parse JSON without losing i64 precision.
 *
 * Integers that fit a JS number stay numbers (so seq/i/v keep their types in
 * the validators); only values outside the safe range become bigints. A `value`
 * above 2^53 therefore arrives exact instead of rounded.
 */
function parseExactJson(text: string): unknown {
  return parseJsonLossless(text, undefined, {
    parseNumber: (value) =>
      isInteger(value)
        ? isSafeNumber(value)
          ? Number(value)
          : BigInt(value)
        : parseFloat(value),
  });
}

function parseJson(input: Uint8Array | string, label: string): unknown {
  const text =
    typeof input === "string"
      ? input
      : new TextDecoder("utf-8", { fatal: true }).decode(input);
  try {
    return parseExactJson(text);
  } catch (error) {
    throw new StateError(
      `${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export function decodeState(input: Uint8Array | string): StateV3 {
  return validateState(parseJson(input, "state"));
}

/**
 * Canonical JSON for the wire. `stringifyJsonLossless` emits bigint values as
 * unquoted integers, which is exactly what the contract's serde_json expects.
 */
function encodeJson(value: unknown): Uint8Array {
  return textEncoder.encode(stringifyJsonLossless(value));
}

export function encodeState(state: StateV3): Uint8Array {
  return encodeJson(validateState(state));
}

export function decodeDelta(input: Uint8Array | string): Delta {
  return validateDelta(parseJson(input, "delta"));
}

export function encodeDelta(delta: Delta): Uint8Array {
  return encodeJson(validateDelta(delta));
}

export function decodeSummary(input: Uint8Array | string): Summary {
  return validateSummary(parseJson(input, "summary"));
}

export function encodeSummary(summary: Summary): Uint8Array {
  return encodeJson(validateSummary(summary));
}

export function emptyParent(): ParentRecord {
  return { seq: 0, userId: null, sig: null };
}

export function emptyContacts(): ContactsRecord {
  return { seq: 0, entries: [], sig: null };
}

export function emptySlot(): Slot {
  return { seq: 0, entry: null, sig: null };
}

export function emptyState(): StateV3 {
  return {
    v: STATE_VERSION,
    parent: emptyParent(),
    contacts: emptyContacts(),
    slots: Array.from({ length: SLOT_COUNT }, emptySlot),
  };
}

export function cloneEntry(entry: Entry | null): Entry | null {
  return entry === null ? null : { ...entry };
}

export function cloneSlot(slot: Slot): Slot {
  return { seq: slot.seq, entry: cloneEntry(slot.entry), sig: slot.sig };
}

export function cloneContacts(record: ContactsRecord): ContactsRecord {
  return {
    seq: record.seq,
    entries: record.entries.map((entry) => ({ ...entry })),
    sig: record.sig,
  };
}

export function cloneParent(record: ParentRecord): ParentRecord {
  return { seq: record.seq, userId: record.userId, sig: record.sig };
}

export function cloneState(state: StateV3): StateV3 {
  return {
    v: STATE_VERSION,
    parent: cloneParent(state.parent),
    contacts: cloneContacts(state.contacts),
    slots: state.slots.map(cloneSlot),
  };
}

/**
 * Canonical slot signing bytes from spec §2.3. Kept byte-for-byte in sync with
 * the contract and delegate; used by the client only to compute summary digests
 * and to display/reconcile what was signed.
 */
export function signingBytes(
  slotIndex: number,
  seq: number,
  entry: Entry | null,
): Uint8Array {
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex >= SLOT_COUNT) {
    throw new StateError(`slot index must be in 0..${SLOT_COUNT - 1}`);
  }
  const validatedSeq = validateSeq(seq, "seq");
  const validatedEntry = entry === null ? null : validateEntry(entry);
  if (validatedSeq === 0 && validatedEntry !== null) {
    throw new StateError("seq 0 must have a null entry");
  }

  const contact = validatedEntry?.contact ?? "";
  const contactBytes = contact === "" ? new Uint8Array(0) : hexToBytes(contact);
  const unitBytes = textEncoder.encode(validatedEntry?.unit ?? "");
  const noteBytes = textEncoder.encode(validatedEntry?.note ?? "");

  const length =
    SLOT_PREFIX.length +
    1 + // slot index
    8 + // seq u64 LE
    1 + // entry tag
    (validatedEntry === null
      ? 0
      : 8 + // value i64 LE
        contactBytes.length +
        4 + unitBytes.length +
        4 + noteBytes.length);

  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let offset = 0;

  out.set(SLOT_PREFIX, offset);
  offset += SLOT_PREFIX.length;

  out[offset] = slotIndex;
  offset += 1;

  view.setBigUint64(offset, BigInt(validatedSeq), true);
  offset += 8;

  out[offset] = validatedEntry === null ? 0 : 1;
  offset += 1;

  if (validatedEntry !== null) {
    view.setBigInt64(offset, validatedEntry.value, true);
    offset += 8;

    out.set(contactBytes, offset);
    offset += contactBytes.length;

    for (const bytes of [unitBytes, noteBytes]) {
      view.setUint32(offset, bytes.length, true);
      offset += 4;
      out.set(bytes, offset);
      offset += bytes.length;
    }
  }

  return out;
}

/** Canonical contacts signing bytes from spec §2.4. */
export function contactsSigningBytes(
  seq: number,
  entries: Contact[],
): Uint8Array {
  const validatedSeq = validateSeq(seq, "seq");
  const validatedEntries = validateContactList(entries);

  let length = CONTACTS_PREFIX.length + 8 + 4;
  for (const entry of validatedEntries) {
    length += 4 + textEncoder.encode(entry.label).length + 32;
  }

  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let offset = 0;

  out.set(CONTACTS_PREFIX, offset);
  offset += CONTACTS_PREFIX.length;

  view.setBigUint64(offset, BigInt(validatedSeq), true);
  offset += 8;

  view.setUint32(offset, validatedEntries.length, true);
  offset += 4;

  for (const entry of validatedEntries) {
    const labelBytes = textEncoder.encode(entry.label);
    view.setUint32(offset, labelBytes.length, true);
    offset += 4;
    out.set(labelBytes, offset);
    offset += labelBytes.length;
    out.set(hexToBytes(entry.userId), offset);
    offset += 32;
  }

  return out;
}

/**
 * Canonical parent signing bytes from spec §2/§3:
 *   b"number:v3:parent" || seq u64 LE || tag u8 || (userId 32 raw when tag == 1)
 * seq 0 is never signed; the digest is zeros for it.
 */
export function parentSigningBytes(
  seq: number,
  userId: string | null,
): Uint8Array {
  const validatedSeq = validateSeq(seq, "seq");
  const hasParent = userId !== null;
  const userIdBytes = hasParent ? hexToBytes(validateUserId(userId, "userId")) : null;

  const out = new Uint8Array(
    PARENT_PREFIX.length + 8 + 1 + (userIdBytes === null ? 0 : 32),
  );
  const view = new DataView(out.buffer);
  let offset = 0;

  out.set(PARENT_PREFIX, offset);
  offset += PARENT_PREFIX.length;

  view.setBigUint64(offset, BigInt(validatedSeq), true);
  offset += 8;

  out[offset] = hasParent ? 1 : 0;
  offset += 1;

  if (userIdBytes !== null) {
    out.set(userIdBytes, offset);
  }

  return out;
}

/** First 16 bytes of BLAKE3(parent signing bytes); zeros at seq 0. */
export function parentDigest16(record: ParentRecord): string {
  if (record.seq === 0) return ZERO_DIGEST16;
  return bytesToHex(
    blake3(parentSigningBytes(record.seq, record.userId)).slice(0, 16),
  );
}

/** First 16 bytes of BLAKE3(signing bytes), as 32 lowercase hex chars. */
export function slotDigest16(index: number, slot: Slot): string {
  if (slot.seq === 0) return ZERO_DIGEST16;
  return bytesToHex(blake3(signingBytes(index, slot.seq, slot.entry)).slice(0, 16));
}

export function contactsDigest16(record: ContactsRecord): string {
  if (record.seq === 0) return ZERO_DIGEST16;
  return bytesToHex(
    blake3(contactsSigningBytes(record.seq, record.entries)).slice(0, 16),
  );
}

export function summaryFromState(state: StateV3): Summary {
  const validated = validateState(state);
  return {
    v: STATE_VERSION,
    parent: [validated.parent.seq, parentDigest16(validated.parent)],
    contacts: [validated.contacts.seq, contactsDigest16(validated.contacts)],
    slots: validated.slots.map((slot, index) => [
      slot.seq,
      slotDigest16(index, slot),
    ]),
  };
}

function needsContacts(
  ours: ContactsRecord,
  theirs: ContactsRecord,
): boolean {
  return (
    ours.seq > theirs.seq ||
    (ours.seq === theirs.seq &&
      contactsDigest16(ours) !== contactsDigest16(theirs))
  );
}

function needsParent(ours: ParentRecord, theirs: ParentRecord): boolean {
  return (
    ours.seq > theirs.seq ||
    (ours.seq === theirs.seq &&
      parentDigest16(ours) !== parentDigest16(theirs))
  );
}

/**
 * Delta the contract would produce for `theirs` (spec §2): include parent and
 * contacts when ours is newer or diverged at equal seq; include a slot iff ours
 * is strictly newer, or same seq with a different canonical digest. When the
 * states are converged this returns a literally empty delta.
 */
export function computeDelta(ours: StateV3, theirs: StateV3): Delta {
  const mine = validateState(ours);
  const other = validateState(theirs);
  const slots: DeltaSlot[] = [];

  for (let i = 0; i < SLOT_COUNT; i++) {
    const a = mine.slots[i];
    const b = other.slots[i];
    const qualifies =
      a.seq > b.seq ||
      (a.seq === b.seq && slotDigest16(i, a) !== slotDigest16(i, b));
    if (qualifies) {
      slots.push({ i, seq: a.seq, entry: cloneEntry(a.entry), sig: a.sig });
    }
  }

  return {
    v: STATE_VERSION,
    parent: needsParent(mine.parent, other.parent)
      ? cloneParent(mine.parent)
      : null,
    contacts: needsContacts(mine.contacts, other.contacts)
      ? cloneContacts(mine.contacts)
      : null,
    slots,
  };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function compareSignatures(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const aBytes = new Uint8Array(64);
  const bBytes = new Uint8Array(64);
  // Validation guarantees lowercase 128-hex before this point.
  for (let i = 0; i < 64; i++) {
    aBytes[i] = Number.parseInt(a.slice(i * 2, i * 2 + 2), 16);
    bBytes[i] = Number.parseInt(b.slice(i * 2, i * 2 + 2), 16);
  }
  return compareBytes(aBytes, bBytes);
}

function canonicalEntry(entry: Entry | null): string {
  if (entry === null) return "null";
  return (
    stringifyJsonLossless([entry.value, entry.contact, entry.unit, entry.note]) ??
    "null"
  );
}

function canonicalContacts(record: ContactsRecord): string {
  return (
    stringifyJsonLossless([
      record.seq,
      record.entries.map((entry) => [entry.label, entry.userId]),
    ]) ?? "null"
  );
}

/**
 * Merge the contacts record: higher seq wins, then lexicographically greater
 * signature bytes. Equal seq + sig means the same record for all valid inputs.
 */
export function mergeContacts(
  a: ContactsRecord,
  b: ContactsRecord,
): ContactsRecord {
  const left = validateContacts(a);
  const right = validateContacts(b);
  if (left.seq !== right.seq) {
    return cloneContacts(left.seq > right.seq ? left : right);
  }
  const sigOrder = compareSignatures(left.sig, right.sig);
  if (sigOrder !== 0) return cloneContacts(sigOrder > 0 ? left : right);

  const aCanonical = canonicalContacts(left);
  const bCanonical = canonicalContacts(right);
  if (aCanonical === bCanonical) return cloneContacts(left);
  return cloneContacts(aCanonical > bCanonical ? left : right);
}

/** Merge one slot: higher seq wins, then lexicographically greater sig bytes. */
export function mergeSlot(a: Slot, b: Slot): Slot {
  if (a.seq !== b.seq) return cloneSlot(a.seq > b.seq ? a : b);
  const sigOrder = compareSignatures(a.sig, b.sig);
  if (sigOrder !== 0) return cloneSlot(sigOrder > 0 ? a : b);

  // Equal seq + sig means the same slot for all valid inputs. The entry
  // tie-break only makes the function deterministic for malformed duplicates.
  const aEntry = canonicalEntry(a.entry);
  const bEntry = canonicalEntry(b.entry);
  if (aEntry === bEntry) return cloneSlot(a);
  return cloneSlot(aEntry > bEntry ? a : b);
}

/**
 * Merge the parent record: higher seq wins, then lexicographically greater
 * signature bytes. A null userId at the winning seq is a legal tombstone.
 */
export function mergeParent(a: ParentRecord, b: ParentRecord): ParentRecord {
  const left = validateParent(a);
  const right = validateParent(b);
  if (left.seq !== right.seq) {
    return cloneParent(left.seq > right.seq ? left : right);
  }
  const sigOrder = compareSignatures(left.sig, right.sig);
  if (sigOrder !== 0) return cloneParent(sigOrder > 0 ? left : right);

  // Equal seq + sig means the same record for all valid inputs. The userId
  // tie-break only makes the function deterministic for malformed duplicates.
  const aCanonical = stringifyJsonLossless([left.seq, left.userId]) ?? "null";
  const bCanonical = stringifyJsonLossless([right.seq, right.userId]) ?? "null";
  if (aCanonical === bCanonical) return cloneParent(left);
  return cloneParent(aCanonical > bCanonical ? left : right);
}

export function mergeStates(a: StateV3, b: StateV3): StateV3 {
  const left = validateState(a);
  const right = validateState(b);
  return {
    v: STATE_VERSION,
    parent: mergeParent(left.parent, right.parent),
    contacts: mergeContacts(left.contacts, right.contacts),
    slots: left.slots.map((slot, index) => mergeSlot(slot, right.slots[index])),
  };
}

/** Apply a delta slot-wise (spec §3). Incoming records may lose the merge. */
export function mergeDelta(state: StateV3, delta: Delta): StateV3 {
  const base = validateState(state);
  const incoming = validateDelta(delta);
  const slots = base.slots.map(cloneSlot);
  for (const deltaSlot of incoming.slots) {
    slots[deltaSlot.i] = mergeSlot(slots[deltaSlot.i], {
      seq: deltaSlot.seq,
      entry: deltaSlot.entry,
      sig: deltaSlot.sig,
    });
  }
  return {
    v: STATE_VERSION,
    parent:
      incoming.parent === null
        ? cloneParent(base.parent)
        : mergeParent(base.parent, incoming.parent),
    contacts:
      incoming.contacts === null
        ? cloneContacts(base.contacts)
        : mergeContacts(base.contacts, incoming.contacts),
    slots,
  };
}

/**
 * Non-fatal issues the UI should call out.
 *
 * The full i64 range is supported exactly (lossless JSON), so there is nothing
 * left to warn about here. Kept as the single place for future advisories.
 */
export function stateWarnings(_state: StateV3): string[] {
  return [];
}

/** Normalise a form string: blank/whitespace-only becomes null. */
export function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Build an Entry from raw form strings. The contact userId is trimmed and
 * lowercased; validateEntry still enforces the hex shape.
 */
export function entryFromInputs(
  value: bigint,
  contact: string,
  unit: string,
  note: string,
): Entry {
  return {
    value,
    contact: contact.trim().toLowerCase(),
    unit: optionalText(unit),
    note: optionalText(note),
  };
}

const CENTS_PATTERN = /^([+-]?)(?:(\d+)(?:\.(\d{0,2}))?|\.(\d{1,2}))$/;
const TOO_MANY_DECIMALS = /^[+-]?\d*\.\d{3,}$/;

const CENTS_FORMAT_MESSAGE =
  "Enter an amount with at most 2 decimal places, for example 12.50.";
const CENTS_DECIMALS_MESSAGE = "Amounts can have at most 2 decimal places.";
const CENTS_RANGE_MESSAGE = `Amount must be between ${CENTS_RANGE} and ${CENTS_MAX}.`;

/**
 * Parse a decimal amount into an exact i64 count of hundredths.
 *
 * Blank means zero. Accepts an optional sign, digits, one decimal point and
 * 0–2 fractional digits (so `.5` and `12.` are fine). Rejects exponents,
 * inner spaces, more than 2 decimals and anything non-numeric.
 */
export function parseCents(input: string): bigint {
  if (typeof input !== "string") {
    throw new StateError(CENTS_FORMAT_MESSAGE);
  }
  const text = input.trim();
  if (text === "") return 0n;

  const match = CENTS_PATTERN.exec(text);
  if (!match) {
    throw new StateError(
      TOO_MANY_DECIMALS.test(text) ? CENTS_DECIMALS_MESSAGE : CENTS_FORMAT_MESSAGE,
    );
  }

  const [, sign, wholeRaw, fractionRaw, bareFraction] = match;
  const whole = wholeRaw ?? "0";
  const fraction = (fractionRaw ?? bareFraction ?? "").padEnd(2, "0");
  const magnitude = BigInt(whole) * 100n + BigInt(fraction);
  const cents = sign === "-" ? -magnitude : magnitude;

  if (cents < I64_MIN || cents > I64_MAX) {
    throw new StateError(CENTS_RANGE_MESSAGE);
  }
  return cents;
}

/** Format an exact i64 count of hundredths with exactly two decimal places. */
export function formatCents(cents: bigint): string {
  if (typeof cents !== "bigint") {
    throw new StateError("formatCents expects a bigint number of hundredths.");
  }
  if (cents < I64_MIN || cents > I64_MAX) {
    throw new StateError("cents must fit in a signed 64-bit integer");
  }
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const whole = magnitude / 100n;
  const fraction = magnitude % 100n;
  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(2, "0")}`;
}
