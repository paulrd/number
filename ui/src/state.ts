/**
 * Contract state, delta, and summary codecs plus the client-side merge.
 *
 * These shapes are the v5 wire format in DESIGN.md and DESIGN-v4.1-v5.md.
 * The browser cannot run Ed25519 verification here, but it can enforce every
 * structural and bounds rule, build the canonical signing bytes (for summaries
 * and optimistic digests), and merge with exactly the same max-over-seq/
 * signature rule as the contract. The contract remains the authority; a bad
 * local merge is corrected by the next GET/notification.
 *
 * v5 adds a signed `adjustments` log (issue/burn hints) to the v4 shape. Every
 * earlier signing byte is unchanged, so a v4 state upgrades by adding an empty
 * adjustments record, a v3 state by also adding an empty payments record, and a
 * v2 state by also adding an empty parent. `validateState`/`decodeState` accept
 * v2, v3, v4 and v5 and always return v5.
 */

import { blake3 } from "@noble/hashes/blake3";
import {
  isInteger,
  isSafeNumber,
  parse as parseJsonLossless,
  stringify as stringifyJsonLossless,
} from "lossless-json";
import {
  MAX_PAYMENT_LEGS,
  ZERO_OWNER,
  isOctalAddress,
  type PaymentEntry,
  type PaymentFail,
  type PaymentLeg,
  type PaymentPhase,
  type PaymentStatus,
  type PaymentsRecord,
} from "./payments";
import { bytesToHex, hexToBytes, isLowerHex, utf8Length } from "./util";

export const SLOT_COUNT = 8;
export const MAX_CONTACTS = 64;
/** Phase 1 bound on the payments record's recently settled id list. */
export const MAX_PAYMENT_SETTLED = 8;
/** Bound on the v5 issue/burn adjustment log. */
export const MAX_ADJUSTMENTS = 32;
/** Bound on an adjustment note, in UTF-8 bytes. */
export const MAX_ADJUSTMENT_NOTE_BYTES = 128;
export const STATE_VERSION = 5 as const;
/**
 * The predecessor wire versions. A v4 state has payments but no adjustments; a
 * v3 state has a parent but no payments; a v2 state has neither. All are
 * upgraded on read and never written.
 */
export const V4_STATE_VERSION = 4 as const;
export const V3_STATE_VERSION = 3 as const;
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
export const SIGNING_DOMAIN_PAYMENTS = "number:v4:payments";
export const SIGNING_DOMAIN_ADJUSTMENTS = "number:v5:adjustments";

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

export interface Adjustment {
  /** Slot index this entry applies to, 0..7. */
  slot: number;
  /** The slot write this adjustment describes; > 0. */
  slotSeq: number;
  /** +issue, -burn, non-zero, in hundredths. */
  delta: bigint;
  /** The signed post-value; >= 0. */
  postValue: bigint;
  /** Optional short reason; at most MAX_ADJUSTMENT_NOTE_BYTES UTF-8 bytes. */
  note: string | null;
}

/**
 * The signed v5 issue/burn log. `seq` 0 means empty. A higher-seq record
 * replaces the whole log; this is a child-facing hint, not an audit trail.
 */
export interface Adjustments {
  seq: number;
  /** Oldest first, at most MAX_ADJUSTMENTS. */
  entries: Adjustment[];
  sig: string | null;
}

export interface StateV5 {
  v: 5;
  parent: ParentRecord;
  contacts: ContactsRecord;
  payments: PaymentsRecord;
  adjustments: Adjustments;
  slots: Slot[];
}

/** Compatibility alias: every import that names the current state gets v5. */
export type StateV3 = StateV5;

export interface DeltaSlot {
  i: number;
  seq: number;
  entry: Entry | null;
  sig: string | null;
}

export interface Delta {
  v: 5;
  /** `null` when the parent record is unchanged. */
  parent: ParentRecord | null;
  /** `null` when the contacts record is unchanged. */
  contacts: ContactsRecord | null;
  /** `null` when the payments record is unchanged. */
  payments: PaymentsRecord | null;
  /** `null` when the adjustments record is unchanged. */
  adjustments: Adjustments | null;
  slots: DeltaSlot[];
}

export type SummarySlot = [seq: number, digest16: string];

export interface Summary {
  v: 5;
  parent: SummarySlot;
  contacts: SummarySlot;
  payments: SummarySlot;
  adjustments: SummarySlot;
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
const PAYMENTS_PREFIX = textEncoder.encode(SIGNING_DOMAIN_PAYMENTS);
const ADJUSTMENTS_PREFIX = textEncoder.encode(SIGNING_DOMAIN_ADJUSTMENTS);
const ZERO_DIGEST16 = "0".repeat(32);

const PAYMENT_PHASE_TAGS: Record<PaymentPhase, number> = {
  forward: 0,
  reverse: 1,
  terminal: 2,
};

const PAYMENT_STATUS_TAGS: Record<PaymentStatus, number> = {
  offered: 0,
  acted: 1,
  complete: 2,
  reversing: 3,
  reversed: 4,
  aborted: 5,
  blocked: 6,
  superseded: 7,
};

const PAYMENT_FAIL_TAGS: Record<PaymentFail, number> = {
  negative: 1,
  "no-destination": 2,
  busy: 3,
  refused: 4,
  "address-mismatch": 5,
  blocked: 6,
  superseded: 7,
};

const MAX_PAYMENT_CURSOR = 64;

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

/** Validate/normalise one applied payment leg. */
export function validatePaymentLeg(raw: unknown, path = "leg"): PaymentLeg {
  const obj = asRecord(raw, path);
  const slot = obj.slot;
  if (
    typeof slot !== "number" ||
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    slot >= SLOT_COUNT
  ) {
    fail(`${path}.slot`, `expected an integer in 0..${SLOT_COUNT - 1}`);
  }
  const seq = validateSeq(obj.seq, `${path}.seq`);
  if (seq === 0) fail(`${path}.seq`, "must be greater than 0");
  const postValue = validateValue(obj.postValue, `${path}.postValue`);
  const sig = validateSignature(obj.sig, `${path}.sig`);
  return { slot, seq, postValue, sig };
}

function validatePaymentAddress(value: unknown, path: string): string {
  if (typeof value !== "string" || !isOctalAddress(value)) {
    fail(path, "expected an octal address of at most 32 digits 0..7");
  }
  return value;
}

function validatePaymentPhase(value: unknown, path: string): PaymentPhase {
  if (typeof value !== "string" || !(value in PAYMENT_PHASE_TAGS)) {
    fail(path, "expected forward, reverse or terminal");
  }
  return value as PaymentPhase;
}

function validatePaymentStatus(value: unknown, path: string): PaymentStatus {
  if (typeof value !== "string" || !(value in PAYMENT_STATUS_TAGS)) {
    fail(path, "expected a known payment status");
  }
  return value as PaymentStatus;
}

function validatePaymentFail(value: unknown, path: string): PaymentFail | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !(value in PAYMENT_FAIL_TAGS)) {
    fail(path, "expected null or a known payment failure");
  }
  return value as PaymentFail;
}

/** Validate/normalise one payment intent, mirroring the contract's shape rules. */
export function validatePaymentEntry(
  raw: unknown,
  path = "payments.entry",
): PaymentEntry {
  const obj = asRecord(raw, path);

  const id = obj.id;
  if (typeof id !== "string" || !isLowerHex(id, 32)) {
    fail(`${path}.id`, "expected 32 lowercase hex characters");
  }

  const amount = validateValue(obj.amount, `${path}.amount`);
  if (amount <= 0n) fail(`${path}.amount`, "must be greater than 0");

  const cursor = obj.cursor;
  if (
    typeof cursor !== "number" ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > MAX_PAYMENT_CURSOR
  ) {
    fail(
      `${path}.cursor`,
      `expected an integer in 0..${MAX_PAYMENT_CURSOR}`,
    );
  }

  if (!Array.isArray(obj.legs)) fail(`${path}.legs`, "expected an array");
  if (obj.legs.length > MAX_PAYMENT_LEGS) {
    fail(`${path}.legs`, `expected at most ${MAX_PAYMENT_LEGS} legs`);
  }
  const legs = obj.legs.map((leg, index) =>
    validatePaymentLeg(leg, `${path}.legs[${index}]`),
  );
  const seenSlots = new Set<number>();
  for (const [index, leg] of legs.entries()) {
    if (seenSlots.has(leg.slot)) {
      fail(`${path}.legs[${index}].slot`, `duplicate slot ${leg.slot}`);
    }
    seenSlots.add(leg.slot);
  }

  const phase = validatePaymentPhase(obj.phase, `${path}.phase`);
  const status = validatePaymentStatus(obj.status, `${path}.status`);
  const failReason = validatePaymentFail(obj.fail, `${path}.fail`);

  const entry: PaymentEntry = {
    id,
    src: validateUserId(obj.src, `${path}.src`),
    dst: validateUserId(obj.dst, `${path}.dst`),
    amount,
    srcAddr: validatePaymentAddress(obj.srcAddr, `${path}.srcAddr`),
    dstAddr: validatePaymentAddress(obj.dstAddr, `${path}.dstAddr`),
    cursor,
    phase,
    status,
    next: validateUserId(obj.next, `${path}.next`),
    fail: failReason,
    legs,
  };

  // Conservative coherence, matching the contract. Transitional combinations
  // the protocol needs (acted while forward or reverse, aborted during a
  // reverse walk, superseded anywhere) remain legal.
  if (status === "offered" && (cursor !== 0 || legs.length > 0)) {
    fail(path, "an offered payment must have cursor 0 and no legs");
  }
  if (
    (status === "complete" || status === "reversed" || status === "blocked") &&
    phase !== "terminal"
  ) {
    fail(path, `a ${status} payment must be terminal`);
  }
  if (phase === "terminal" && entry.next !== ZERO_OWNER) {
    fail(`${path}.next`, "a terminal payment must have an all-zero next");
  }

  return entry;
}

/** Validate/normalise the bounded, unique `settled` payment-id list. */
export function validateSettled(raw: unknown, path = "settled"): string[] {
  if (!Array.isArray(raw)) fail(path, "expected an array");
  if (raw.length > MAX_PAYMENT_SETTLED) {
    fail(path, `expected at most ${MAX_PAYMENT_SETTLED} settled ids`);
  }
  const seen = new Set<string>();
  return raw.map((value, index) => {
    if (typeof value !== "string" || !isLowerHex(value, 32)) {
      fail(`${path}[${index}]`, "expected 32 lowercase hex characters");
    }
    if (seen.has(value)) {
      fail(`${path}[${index}]`, `duplicate settled id ${value}`);
    }
    seen.add(value);
    return value;
  });
}

/** Validate/normalise the signed payments record. */
export function validatePayments(
  raw: unknown,
  path = "payments",
): PaymentsRecord {
  const obj = asRecord(raw, path);
  const seq = validateSeq(obj.seq, `${path}.seq`);
  const settled = validateSettled(obj.settled, `${path}.settled`);
  const entryRaw = obj.entry ?? null;
  const sigRaw = obj.sig ?? null;

  let entry: PaymentEntry | null = null;
  if (entryRaw !== null) {
    entry = validatePaymentEntry(entryRaw, `${path}.entry`);
  }

  let sig: string | null = null;
  if (sigRaw !== null) {
    sig = validateSignature(sigRaw, `${path}.sig`);
  }

  if (seq === 0) {
    if (settled.length > 0) fail(path, "seq 0 must have no settled ids");
    if (entry !== null) fail(path, "seq 0 must have a null entry");
    if (sig !== null) fail(path, "seq 0 must have a null signature");
  } else if (sig === null) {
    // seq > 0 with a null entry is a legal tombstone, but still signed.
    fail(path, "seq > 0 requires a signature");
  }

  return { seq, settled, entry, sig };
}

/** Validate/normalise one v5 issue/burn log entry. */
export function validateAdjustment(raw: unknown, path = "adjustment"): Adjustment {
  const obj = asRecord(raw, path);

  const slot = obj.slot;
  if (
    typeof slot !== "number" ||
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    slot >= SLOT_COUNT
  ) {
    fail(`${path}.slot`, `expected an integer in 0..${SLOT_COUNT - 1}`);
  }

  const slotSeq = validateSeq(obj.slotSeq, `${path}.slotSeq`);
  if (slotSeq === 0) fail(`${path}.slotSeq`, "must be greater than 0");

  const delta = validateValue(obj.delta, `${path}.delta`);
  if (delta === 0n) fail(`${path}.delta`, "must be non-zero");

  const postValue = validateValue(obj.postValue, `${path}.postValue`);
  if (postValue < 0n) fail(`${path}.postValue`, "must not be negative");

  // The implied pre-value must be a non-negative i64. `post - delta` covers
  // both directions and detects i64 overflow exactly.
  const preValue = postValue - delta;
  if (preValue < 0n || preValue < I64_MIN || preValue > I64_MAX) {
    fail(
      `${path}.postValue`,
      "implies a pre-value that is negative or outside the signed 64-bit range",
    );
  }

  return {
    slot,
    slotSeq,
    delta,
    postValue,
    note: validateOptionalText(
      obj.note,
      `${path}.note`,
      MAX_ADJUSTMENT_NOTE_BYTES,
    ),
  };
}

/**
 * Validate an adjustment list: at most MAX_ADJUSTMENTS entries, no duplicate
 * `(slot, slotSeq)`, and strictly increasing `slotSeq` within one slot in list
 * order. Deliberately does not compare against `state.slots`: adjustments and
 * slots merge independently, so a cross-check would break convergence.
 */
export function validateAdjustmentList(
  raw: unknown,
  path = "adjustments.entries",
): Adjustment[] {
  if (!Array.isArray(raw)) fail(path, "expected an array");
  if (raw.length > MAX_ADJUSTMENTS) {
    fail(path, `expected at most ${MAX_ADJUSTMENTS} adjustments`);
  }
  const entries = raw.map((value, index) =>
    validateAdjustment(value, `${path}[${index}]`),
  );
  const seen = new Set<string>();
  const lastSeq = new Map<number, number>();
  for (const [index, entry] of entries.entries()) {
    const key = `${entry.slot}:${entry.slotSeq}`;
    if (seen.has(key)) {
      fail(
        `${path}[${index}].slotSeq`,
        `duplicate (slot, slotSeq) ${entry.slot}/${entry.slotSeq}`,
      );
    }
    seen.add(key);
    const previous = lastSeq.get(entry.slot);
    if (previous !== undefined && entry.slotSeq <= previous) {
      fail(
        `${path}[${index}].slotSeq`,
        `slotSeq must increase within slot ${entry.slot}`,
      );
    }
    lastSeq.set(entry.slot, entry.slotSeq);
  }
  return entries;
}

/** Validate/normalise the signed v5 adjustments record. */
export function validateAdjustments(
  raw: unknown,
  path = "adjustments",
): Adjustments {
  const obj = asRecord(raw, path);
  const seq = validateSeq(obj.seq, `${path}.seq`);
  const entries = validateAdjustmentList(obj.entries ?? [], `${path}.entries`);

  let sig: string | null = null;
  if (obj.sig !== undefined && obj.sig !== null) {
    sig = validateSignature(obj.sig, `${path}.sig`);
  }

  if (seq === 0) {
    if (entries.length > 0) fail(path, "seq 0 must have no adjustments");
    if (sig !== null) fail(path, "seq 0 must have a null signature");
  } else if (sig === null) {
    fail(path, "seq > 0 requires a signature");
  }

  return { seq, entries, sig };
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

export function validateState(raw: unknown): StateV5 {
  const obj = asRecord(raw, "state");
  let parent: ParentRecord;
  let payments: PaymentsRecord;
  let adjustments: Adjustments;
  if (obj.v === STATE_VERSION) {
    parent = validateParent(obj.parent, "state.parent");
    payments = validatePayments(obj.payments, "state.payments");
    adjustments = validateAdjustments(obj.adjustments, "state.adjustments");
  } else if (obj.v === V4_STATE_VERSION) {
    parent = validateParent(obj.parent, "state.parent");
    payments = validatePayments(obj.payments, "state.payments");
    // v4 never had an adjustments field. Reject it rather than silently
    // dropping signed data; the client upgrade adds an empty record.
    if (obj.adjustments !== undefined) {
      fail(
        "state.adjustments",
        "a v4 state must not carry an adjustments record",
      );
    }
    adjustments = emptyAdjustments();
  } else if (obj.v === V3_STATE_VERSION) {
    parent = validateParent(obj.parent, "state.parent");
    // v3 never had a payments or adjustments field. Reject them rather than
    // silently dropping signed data; the client upgrade adds empty records.
    if (obj.payments !== undefined) {
      fail("state.payments", "a v3 state must not carry a payments record");
    }
    if (obj.adjustments !== undefined) {
      fail(
        "state.adjustments",
        "a v3 state must not carry an adjustments record",
      );
    }
    payments = emptyPayments();
    adjustments = emptyAdjustments();
  } else if (obj.v === LEGACY_STATE_VERSION) {
    // v2 never had a parent, payments or adjustments field. Explicitly reject
    // them rather than silently dropping signed data; the upgrade adds empty
    // records.
    if (obj.parent !== undefined) {
      fail("state.parent", "a v2 state must not carry a parent record");
    }
    if (obj.payments !== undefined) {
      fail("state.payments", "a v2 state must not carry a payments record");
    }
    if (obj.adjustments !== undefined) {
      fail(
        "state.adjustments",
        "a v2 state must not carry an adjustments record",
      );
    }
    parent = emptyParent();
    payments = emptyPayments();
    adjustments = emptyAdjustments();
  } else {
    fail(
      "state.v",
      `expected ${LEGACY_STATE_VERSION}, ${V3_STATE_VERSION}, ${V4_STATE_VERSION} or ${STATE_VERSION}`,
    );
  }

  const contacts = validateContacts(obj.contacts, "state.contacts");
  if (!Array.isArray(obj.slots) || obj.slots.length !== SLOT_COUNT) {
    fail("state.slots", `expected exactly ${SLOT_COUNT} slots`);
  }
  return {
    v: STATE_VERSION,
    parent,
    contacts,
    payments,
    adjustments,
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

  const payments =
    obj.payments === undefined || obj.payments === null
      ? null
      : validatePayments(obj.payments, "delta.payments");

  const adjustments =
    obj.adjustments === undefined || obj.adjustments === null
      ? null
      : validateAdjustments(obj.adjustments, "delta.adjustments");

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

  return {
    v: STATE_VERSION,
    parent,
    contacts,
    payments,
    adjustments,
    slots,
  };
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
  const payments = validateSummaryPair(obj.payments, "summary.payments");
  const adjustments = validateSummaryPair(
    obj.adjustments,
    "summary.adjustments",
  );
  if (!Array.isArray(obj.slots) || obj.slots.length !== SLOT_COUNT) {
    fail("summary.slots", `expected exactly ${SLOT_COUNT} pairs`);
  }
  return {
    v: STATE_VERSION,
    parent,
    contacts,
    payments,
    adjustments,
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

export function emptyPayments(): PaymentsRecord {
  return { seq: 0, settled: [], entry: null, sig: null };
}

export function emptyAdjustments(): Adjustments {
  return { seq: 0, entries: [], sig: null };
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
    payments: emptyPayments(),
    adjustments: emptyAdjustments(),
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

export function clonePayment(entry: PaymentEntry | null): PaymentEntry | null {
  if (entry === null) return null;
  return {
    ...entry,
    legs: entry.legs.map((leg) => ({ ...leg })),
  };
}

export function clonePayments(record: PaymentsRecord): PaymentsRecord {
  return {
    seq: record.seq,
    settled: [...record.settled],
    entry: clonePayment(record.entry),
    sig: record.sig,
  };
}

export function cloneAdjustment(entry: Adjustment): Adjustment {
  return {
    slot: entry.slot,
    slotSeq: entry.slotSeq,
    delta: entry.delta,
    postValue: entry.postValue,
    note: entry.note,
  };
}

export function cloneAdjustments(record: Adjustments): Adjustments {
  return {
    seq: record.seq,
    entries: record.entries.map(cloneAdjustment),
    sig: record.sig,
  };
}

export function cloneState(state: StateV3): StateV3 {
  return {
    v: STATE_VERSION,
    parent: cloneParent(state.parent),
    contacts: cloneContacts(state.contacts),
    payments: clonePayments(state.payments),
    adjustments: cloneAdjustments(state.adjustments),
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

/**
 * Canonical payments signing bytes from DESIGN-payments.md:
 *   domain || seq u64 LE || settled_count u8 || each settled id (16 raw)
 *   || tag u8 || entry fields when tag == 1.
 * Kept byte-for-byte in sync with the contract and delegate; used here for
 * summary digests.
 */
export function paymentsSigningBytes(
  seq: number,
  settled: string[],
  entry: PaymentEntry | null,
): Uint8Array {
  const validatedSeq = validateSeq(seq, "seq");
  const validatedSettled = validateSettled(settled);
  const validatedEntry = entry === null ? null : validatePaymentEntry(entry);
  if (validatedSeq === 0 && validatedEntry !== null) {
    throw new StateError("seq 0 must have a null entry");
  }
  if (validatedSeq === 0 && validatedSettled.length > 0) {
    throw new StateError("seq 0 must have no settled ids");
  }

  const settledBytes = validatedSettled.length * 16;
  const header =
    PAYMENTS_PREFIX.length + 8 + 1 + settledBytes + 1; // + entry tag

  const writeHeader = (out: Uint8Array): number => {
    const view = new DataView(out.buffer);
    let offset = 0;
    out.set(PAYMENTS_PREFIX, offset);
    offset += PAYMENTS_PREFIX.length;
    view.setBigUint64(offset, BigInt(validatedSeq), true);
    offset += 8;
    out[offset] = validatedSettled.length;
    offset += 1;
    for (const id of validatedSettled) {
      out.set(hexToBytes(id), offset);
      offset += 16;
    }
    return offset;
  };

  if (validatedEntry === null) {
    const out = new Uint8Array(header);
    const offset = writeHeader(out);
    out[offset] = 0;
    return out;
  }

  const idBytes = hexToBytes(validatedEntry.id);
  const srcBytes = hexToBytes(validatedEntry.src);
  const dstBytes = hexToBytes(validatedEntry.dst);
  const nextBytes = hexToBytes(validatedEntry.next);
  const srcAddrBytes = textEncoder.encode(validatedEntry.srcAddr);
  const dstAddrBytes = textEncoder.encode(validatedEntry.dstAddr);

  const legSize = 1 + 8 + 8 + 64;
  let length =
    header +
    16 +
    32 +
    32 +
    8 +
    4 +
    srcAddrBytes.length +
    4 +
    dstAddrBytes.length +
    1 +
    1 +
    1 +
    1 +
    32 +
    1;
  length += validatedEntry.legs.length * legSize;

  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let offset = writeHeader(out);

  out[offset] = 1;
  offset += 1;

  out.set(idBytes, offset);
  offset += 16;
  out.set(srcBytes, offset);
  offset += 32;
  out.set(dstBytes, offset);
  offset += 32;

  view.setBigInt64(offset, validatedEntry.amount, true);
  offset += 8;

  for (const bytes of [srcAddrBytes, dstAddrBytes]) {
    view.setUint32(offset, bytes.length, true);
    offset += 4;
    out.set(bytes, offset);
    offset += bytes.length;
  }

  out[offset] = validatedEntry.cursor;
  offset += 1;
  out[offset] = PAYMENT_PHASE_TAGS[validatedEntry.phase];
  offset += 1;
  out[offset] = PAYMENT_STATUS_TAGS[validatedEntry.status];
  offset += 1;
  out[offset] =
    validatedEntry.fail === null ? 0 : PAYMENT_FAIL_TAGS[validatedEntry.fail];
  offset += 1;

  out.set(nextBytes, offset);
  offset += 32;

  out[offset] = validatedEntry.legs.length;
  offset += 1;

  for (const leg of validatedEntry.legs) {
    out[offset] = leg.slot;
    offset += 1;
    view.setBigUint64(offset, BigInt(leg.seq), true);
    offset += 8;
    view.setBigInt64(offset, leg.postValue, true);
    offset += 8;
    out.set(hexToBytes(leg.sig), offset);
    offset += 64;
  }

  return out;
}

/** First 16 bytes of BLAKE3(payments signing bytes); zeros at seq 0. */
export function paymentsDigest16(record: PaymentsRecord): string {
  if (record.seq === 0) return ZERO_DIGEST16;
  return bytesToHex(
    blake3(
      paymentsSigningBytes(record.seq, record.settled, record.entry),
    ).slice(0, 16),
  );
}

/**
 * Canonical v5 adjustments signing bytes:
 *   b"number:v5:adjustments" || seq u64 LE || count u32 LE
 *   || for each entry: slot u8 || slotSeq u64 LE || delta i64 LE
 *      || postValue i64 LE || note_len u32 LE || note bytes.
 * Kept byte-for-byte in sync with the contract and delegate; used here for
 * summary digests.
 */
export function adjustmentsSigningBytes(
  seq: number,
  entries: Adjustment[],
): Uint8Array {
  const validatedSeq = validateSeq(seq, "seq");
  const validatedEntries = validateAdjustmentList(entries);
  if (validatedSeq === 0 && validatedEntries.length > 0) {
    throw new StateError("seq 0 must have no adjustments");
  }

  const noteBytes = validatedEntries.map((entry) =>
    textEncoder.encode(entry.note ?? ""),
  );
  let length = ADJUSTMENTS_PREFIX.length + 8 + 4;
  for (const bytes of noteBytes) {
    length += 1 + 8 + 8 + 8 + 4 + bytes.length;
  }

  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let offset = 0;

  out.set(ADJUSTMENTS_PREFIX, offset);
  offset += ADJUSTMENTS_PREFIX.length;

  view.setBigUint64(offset, BigInt(validatedSeq), true);
  offset += 8;

  view.setUint32(offset, validatedEntries.length, true);
  offset += 4;

  for (const [index, entry] of validatedEntries.entries()) {
    out[offset] = entry.slot;
    offset += 1;
    view.setBigUint64(offset, BigInt(entry.slotSeq), true);
    offset += 8;
    view.setBigInt64(offset, entry.delta, true);
    offset += 8;
    view.setBigInt64(offset, entry.postValue, true);
    offset += 8;
    const bytes = noteBytes[index];
    view.setUint32(offset, bytes.length, true);
    offset += 4;
    out.set(bytes, offset);
    offset += bytes.length;
  }

  return out;
}

/** First 16 bytes of BLAKE3(adjustments signing bytes); zeros at seq 0. */
export function adjustmentsDigest16(record: Adjustments): string {
  if (record.seq === 0) return ZERO_DIGEST16;
  return bytesToHex(
    blake3(adjustmentsSigningBytes(record.seq, record.entries)).slice(0, 16),
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
    payments: [validated.payments.seq, paymentsDigest16(validated.payments)],
    adjustments: [
      validated.adjustments.seq,
      adjustmentsDigest16(validated.adjustments),
    ],
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

function needsPayments(
  ours: PaymentsRecord,
  theirs: PaymentsRecord,
): boolean {
  return (
    ours.seq > theirs.seq ||
    (ours.seq === theirs.seq &&
      paymentsDigest16(ours) !== paymentsDigest16(theirs))
  );
}

function needsAdjustments(
  ours: Adjustments,
  theirs: Adjustments,
): boolean {
  return (
    ours.seq > theirs.seq ||
    (ours.seq === theirs.seq &&
      adjustmentsDigest16(ours) !== adjustmentsDigest16(theirs))
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
    payments: needsPayments(mine.payments, other.payments)
      ? clonePayments(mine.payments)
      : null,
    adjustments: needsAdjustments(mine.adjustments, other.adjustments)
      ? cloneAdjustments(mine.adjustments)
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

/**
 * Merge the payments record: higher seq wins, then lexicographically greater
 * signature bytes. A tombstone at a higher seq clears the active payment.
 */
export function mergePayments(
  a: PaymentsRecord,
  b: PaymentsRecord,
): PaymentsRecord {
  const left = validatePayments(a);
  const right = validatePayments(b);
  if (left.seq !== right.seq) {
    return clonePayments(left.seq > right.seq ? left : right);
  }
  const sigOrder = compareSignatures(left.sig, right.sig);
  if (sigOrder !== 0) return clonePayments(sigOrder > 0 ? left : right);

  // Equal seq + sig means the same record for all valid inputs. The canonical
  // tie-break only makes the function deterministic for malformed duplicates.
  const aCanonical = stringifyJsonLossless([
    left.seq,
    left.settled,
    left.entry === null
      ? null
      : [
          left.entry.id,
          left.entry.src,
          left.entry.dst,
          left.entry.cursor,
          left.entry.status,
        ],
  ]);
  const bCanonical = stringifyJsonLossless([
    right.seq,
    right.settled,
    right.entry === null
      ? null
      : [
          right.entry.id,
          right.entry.src,
          right.entry.dst,
          right.entry.cursor,
          right.entry.status,
        ],
  ]);
  if (aCanonical === bCanonical) return clonePayments(left);
  return clonePayments((aCanonical ?? "") > (bCanonical ?? "") ? left : right);
}

/**
 * Merge the v5 adjustments record: higher seq wins, then lexicographically
 * greater signature bytes. The whole log is replaced, never unioned: a higher
 * seq is the owner's current view, and a child treats it as a hint.
 */
export function mergeAdjustments(a: Adjustments, b: Adjustments): Adjustments {
  const left = validateAdjustments(a);
  const right = validateAdjustments(b);
  if (left.seq !== right.seq) {
    return cloneAdjustments(left.seq > right.seq ? left : right);
  }
  const sigOrder = compareSignatures(left.sig, right.sig);
  if (sigOrder !== 0) return cloneAdjustments(sigOrder > 0 ? left : right);

  // Equal seq + sig means the same record for all valid inputs. The canonical
  // tie-break only makes the function deterministic for malformed duplicates.
  const canonical = (record: Adjustments): string =>
    stringifyJsonLossless([
      record.seq,
      record.entries.map((entry) => [
        entry.slot,
        entry.slotSeq,
        entry.delta,
        entry.postValue,
        entry.note,
      ]),
    ]) ?? "null";
  const aCanonical = canonical(left);
  const bCanonical = canonical(right);
  if (aCanonical === bCanonical) return cloneAdjustments(left);
  return cloneAdjustments(aCanonical > bCanonical ? left : right);
}

export function mergeStates(a: StateV3, b: StateV3): StateV3 {
  const left = validateState(a);
  const right = validateState(b);
  return {
    v: STATE_VERSION,
    parent: mergeParent(left.parent, right.parent),
    contacts: mergeContacts(left.contacts, right.contacts),
    payments: mergePayments(left.payments, right.payments),
    adjustments: mergeAdjustments(left.adjustments, right.adjustments),
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
    payments:
      incoming.payments === null
        ? clonePayments(base.payments)
        : mergePayments(base.payments, incoming.payments),
    adjustments:
      incoming.adjustments === null
        ? cloneAdjustments(base.adjustments)
        : mergeAdjustments(base.adjustments, incoming.adjustments),
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
