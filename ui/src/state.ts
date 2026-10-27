/**
 * Contract state, delta, and summary codecs plus the client-side merge.
 *
 * These shapes are the wire format in DESIGN.md §2–§5. The browser cannot run
 * Ed25519 verification here, but it can enforce every structural and bounds
 * rule, build the canonical signing bytes (for summaries and optimistic
 * digests), and merge with exactly the same max-over-seq/signature rule as the
 * contract. The contract remains the authority; a bad local merge is corrected
 * by the next GET/notification.
 */

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, isLowerHex, utf8Length } from "./util";

export const SLOT_COUNT = 8;
export const STATE_VERSION = 1 as const;

export const LIMITS = {
  label: 64,
  unit: 16,
  note: 512,
} as const;

export const I64_MIN = -(2n ** 63n);
export const I64_MAX = 2n ** 63n - 1n;

export interface Entry {
  value: number;
  label: string | null;
  unit: string | null;
  note: string | null;
}

export interface Slot {
  seq: number;
  entry: Entry | null;
  sig: string | null;
}

export interface StateV1 {
  v: 1;
  slots: Slot[];
}

export interface DeltaSlot {
  i: number;
  seq: number;
  entry: Entry | null;
  sig: string | null;
}

export interface Delta {
  v: 1;
  slots: DeltaSlot[];
}

export type SummarySlot = [seq: number, digest16: string];

export interface Summary {
  v: 1;
  slots: SummarySlot[];
}

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

const textEncoder = new TextEncoder();
const SIGNING_PREFIX = textEncoder.encode("number:v1:slot");
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

/** Validate an exact i64 (JS numbers cannot exactly represent all i64s). */
export function isI64(value: number): boolean {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return false;
  }
  try {
    const big = BigInt(value);
    return big >= I64_MIN && big <= I64_MAX;
  } catch {
    return false;
  }
}

function validateValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "expected a number");
  }
  if (!Number.isInteger(value)) {
    fail(path, "expected an integer");
  }
  if (!isI64(value)) {
    fail(path, "must fit in a signed 64-bit integer");
  }
  return value;
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

/** Validate/normalise one entry. Optional strings become null, never "". */
export function validateEntry(raw: unknown, path = "entry"): Entry {
  const obj = asRecord(raw, path);
  return {
    value: validateValue(obj.value, `${path}.value`),
    label: validateOptionalText(obj.label, `${path}.label`, LIMITS.label),
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
    if (typeof sigRaw !== "string" || !isLowerHex(sigRaw, 128)) {
      fail(`${path}.sig`, "expected 128 lowercase hex characters");
    }
    sig = sigRaw;
  }
  if (seq > 0 && sig === null) {
    fail(path, "seq > 0 requires a signature");
  }

  return { seq, entry, sig };
}

export function validateState(raw: unknown): StateV1 {
  const obj = asRecord(raw, "state");
  if (obj.v !== STATE_VERSION) fail("state.v", "expected 1");
  if (!Array.isArray(obj.slots) || obj.slots.length !== SLOT_COUNT) {
    fail("state.slots", `expected exactly ${SLOT_COUNT} slots`);
  }
  return {
    v: STATE_VERSION,
    slots: obj.slots.map((slot, index) => validateSlot(slot, index)),
  };
}

export function validateDelta(raw: unknown): Delta {
  const obj = asRecord(raw, "delta");
  if (obj.v !== STATE_VERSION) fail("delta.v", "expected 1");
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

  return { v: STATE_VERSION, slots };
}

export function validateSummary(raw: unknown): Summary {
  const obj = asRecord(raw, "summary");
  if (obj.v !== STATE_VERSION) fail("summary.v", "expected 1");
  if (!Array.isArray(obj.slots) || obj.slots.length !== SLOT_COUNT) {
    fail("summary.slots", `expected exactly ${SLOT_COUNT} pairs`);
  }
  const slots = obj.slots.map((pair, index): SummarySlot => {
    const path = `summary.slots[${index}]`;
    if (!Array.isArray(pair) || pair.length !== 2) {
      fail(path, "expected [seq, digest16]");
    }
    const seq = validateSeq(pair[0], `${path}[0]`);
    const digest = pair[1];
    if (typeof digest !== "string" || !isLowerHex(digest, 32)) {
      fail(`${path}[1]`, "expected 32 lowercase hex characters");
    }
    return [seq, digest];
  });
  return { v: STATE_VERSION, slots };
}

function parseJson(input: Uint8Array | string, label: string): unknown {
  const text =
    typeof input === "string"
      ? input
      : new TextDecoder("utf-8", { fatal: true }).decode(input);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StateError(
      `${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export function decodeState(input: Uint8Array | string): StateV1 {
  return validateState(parseJson(input, "state"));
}

export function encodeState(state: StateV1): Uint8Array {
  return textEncoder.encode(JSON.stringify(validateState(state)));
}

export function decodeDelta(input: Uint8Array | string): Delta {
  return validateDelta(parseJson(input, "delta"));
}

export function encodeDelta(delta: Delta): Uint8Array {
  return textEncoder.encode(JSON.stringify(validateDelta(delta)));
}

export function decodeSummary(input: Uint8Array | string): Summary {
  return validateSummary(parseJson(input, "summary"));
}

export function encodeSummary(summary: Summary): Uint8Array {
  return textEncoder.encode(JSON.stringify(validateSummary(summary)));
}

export function emptySlot(): Slot {
  return { seq: 0, entry: null, sig: null };
}

export function emptyState(): StateV1 {
  return {
    v: STATE_VERSION,
    slots: Array.from({ length: SLOT_COUNT }, emptySlot),
  };
}

export function cloneEntry(entry: Entry | null): Entry | null {
  return entry === null ? null : { ...entry };
}

export function cloneSlot(slot: Slot): Slot {
  return { seq: slot.seq, entry: cloneEntry(slot.entry), sig: slot.sig };
}

export function cloneState(state: StateV1): StateV1 {
  return { v: STATE_VERSION, slots: state.slots.map(cloneSlot) };
}

/**
 * Canonical signing bytes from DESIGN §2. Kept byte-for-byte in sync with the
 * contract and delegate; used by the client only to compute summary digests
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

  const label = validatedEntry?.label ?? "";
  const unit = validatedEntry?.unit ?? "";
  const note = validatedEntry?.note ?? "";
  const labelBytes = textEncoder.encode(label);
  const unitBytes = textEncoder.encode(unit);
  const noteBytes = textEncoder.encode(note);

  const length =
    SIGNING_PREFIX.length +
    1 + // slot index
    8 + // seq u64 LE
    1 + // entry tag
    (validatedEntry === null
      ? 0
      : 8 + 4 + labelBytes.length + 4 + unitBytes.length + 4 + noteBytes.length);

  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let offset = 0;

  out.set(SIGNING_PREFIX, offset);
  offset += SIGNING_PREFIX.length;

  out[offset] = slotIndex;
  offset += 1;

  view.setBigUint64(offset, BigInt(validatedSeq), true);
  offset += 8;

  out[offset] = validatedEntry === null ? 0 : 1;
  offset += 1;

  if (validatedEntry !== null) {
    view.setBigInt64(offset, BigInt(validatedEntry.value), true);
    offset += 8;

    for (const bytes of [labelBytes, unitBytes, noteBytes]) {
      view.setUint32(offset, bytes.length, true);
      offset += 4;
      out.set(bytes, offset);
      offset += bytes.length;
    }
  }

  return out;
}

/** First 16 bytes of BLAKE3(signing bytes), as 32 lowercase hex chars. */
export function slotDigest16(index: number, slot: Slot): string {
  if (slot.seq === 0) return ZERO_DIGEST16;
  return bytesToHex(blake3(signingBytes(index, slot.seq, slot.entry)).slice(0, 16));
}

export function summaryFromState(state: StateV1): Summary {
  const validated = validateState(state);
  return {
    v: STATE_VERSION,
    slots: validated.slots.map((slot, index) => [
      slot.seq,
      slotDigest16(index, slot),
    ]),
  };
}

/**
 * Delta the contract would produce for `theirs` (DESIGN §4): include a slot iff
 * ours is strictly newer, or same seq with a different canonical digest. When
 * the states are converged this returns a literally empty slot list.
 */
export function computeDelta(ours: StateV1, theirs: StateV1): Delta {
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

  return { v: STATE_VERSION, slots };
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
  return entry === null
    ? "null"
    : JSON.stringify([entry.value, entry.label, entry.unit, entry.note]);
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

export function mergeStates(a: StateV1, b: StateV1): StateV1 {
  const left = validateState(a);
  const right = validateState(b);
  return {
    v: STATE_VERSION,
    slots: left.slots.map((slot, index) => mergeSlot(slot, right.slots[index])),
  };
}

/** Apply a delta slot-wise (DESIGN §5). Incoming slots may lose the merge. */
export function mergeDelta(state: StateV1, delta: Delta): StateV1 {
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
  return { v: STATE_VERSION, slots };
}

/** Non-fatal issues the UI should call out (DESIGN §2 i64 note). */
export function stateWarnings(state: StateV1): string[] {
  const warnings: string[] = [];
  state.slots.forEach((slot, index) => {
    if (slot.entry !== null && !Number.isSafeInteger(slot.entry.value)) {
      warnings.push(
        `Slot ${index + 1}: ${slot.entry.value} is outside JavaScript's safe integer range ` +
          `(±${Number.MAX_SAFE_INTEGER}); display or editing may round it.`,
      );
    }
  });
  return warnings;
}

/** Normalise a form string: blank/whitespace-only becomes null. */
export function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
