/**
 * A portable admission credential.
 *
 * Freenet GET serves the local copy of a contract and never refreshes it, so a
 * candidate on another node can read the owner's zone minutes-to-hours stale
 * (see `reports/freenet-stale-contract-reads.md`). Admission therefore must not
 * depend on the owner's zone arriving. Instead the owner hands over the
 * already-signed child-slot record as a copyable code:
 *
 *     "tally-admit1." || base64url(UTF-8 JSON)
 *
 * The signature is the delegate's normal `number:v2:slot` signature over
 * `signingBytes(slot, seq, entry)` (see `state.ts`), verified here against the
 * owner id, which is the owner's Ed25519 verifying key. The candidate then
 * signs `parent` on their own node; no cross-node read is required.
 *
 * What the signature binds: the domain, slot index, seq, value, contact, unit
 * and note. It does not bind a timestamp, the owner's zone address, or the
 * owner's zone id — the owner id is only the key that verification trusts.
 * The address is therefore display-only ("reported by the owner"), and a stale
 * code stays valid until the owner clears or reassigns the slot. The best-effort
 * freshness rule in `crossCheckAdmission` never blocks on a stale read.
 */

import { verifyEd25519 } from "./ed25519";
import {
  SLOT_COUNT,
  signingBytes,
  validateEntry,
  type Entry,
  type Slot,
} from "./state";
import { hexToBytes, isLowerHex } from "./util";

/** Marks a portable admission code so it cannot be confused with a root id. */
export const ADMISSION_CODE_PREFIX = "tally-admit1.";

/** Above this a paste is not one of our codes. */
const MAX_CODE_CHARS = 4096;

/** One verified-or-about-to-be-verified admission record. */
export interface AdmissionCode {
  /** Zone owner id: the Ed25519 verifying key that signed the slot. */
  owner: string;
  /** The admitted contact; always equal to `entry.contact`. */
  candidate: string;
  /** Zero-based slot index, 0..7. */
  slot: number;
  /** The slot's sequence when the owner wrote the designation; > 0. */
  seq: number;
  /** The signed slot entry (value, contact, unit, note). */
  entry: Entry;
  /** Owner-reported octal address of the owner's zone; "" is root. */
  address: string | null;
  /** 128 lowercase hex characters. */
  sig: string;
}

export type AdmissionFailureKind =
  | "format"
  | "version"
  | "bounds"
  | "owner"
  | "candidate"
  | "signature";

export type AdmissionResult =
  | { ok: true; code: AdmissionCode }
  | { ok: false; reason: AdmissionFailureKind };

export interface AdmissionVerifyOptions {
  /** The viewer's own contact id, or null when the identity is not ready. */
  candidate: string | null;
  /**
   * The zone the flow was opened for (its root or target id). A code naming a
   * different owner is refused so a pasted code cannot silently retarget a
   * flow the candidate already started.
   */
  expectedOwner?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  try {
    const binary = atob(padded + padding);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The octal address bound the tree walk and the region codec share. */
const ADDRESS_RE = /^[0-7]{0,32}$/;

function parseSeq(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

function parseValue(raw: unknown): bigint | null {
  if (typeof raw !== "string" || !/^-?[0-9]+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function parseOptionalText(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw === "string") return raw;
  return undefined;
}

/**
 * Decode a code's text without verifying it. Structural validation only; the
 * result must still go through `verifyAdmissionCode` before it is trusted.
 */
export function decodeAdmissionCode(
  text: string,
): { ok: true; code: AdmissionCode } | { ok: false; reason: AdmissionFailureKind } {
  const compact = text.replace(/\s+/g, "");
  if (compact === "" || compact.length > MAX_CODE_CHARS) {
    return { ok: false, reason: "format" };
  }
  if (!compact.startsWith(ADMISSION_CODE_PREFIX)) {
    return { ok: false, reason: "format" };
  }
  const bytes = fromBase64Url(compact.slice(ADMISSION_CODE_PREFIX.length));
  if (bytes === null) return { ok: false, reason: "format" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, reason: "format" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "format" };
  if (parsed.v !== 1) return { ok: false, reason: "version" };

  const owner = parsed.owner;
  const candidate = parsed.candidate;
  const slot = parsed.slot;
  const sig = parsed.sig;
  if (
    typeof owner !== "string" ||
    !isLowerHex(owner, 64) ||
    typeof candidate !== "string" ||
    !isLowerHex(candidate, 64) ||
    !Number.isSafeInteger(slot) ||
    typeof slot !== "number" ||
    slot < 0 ||
    slot >= SLOT_COUNT ||
    typeof sig !== "string" ||
    !isLowerHex(sig, 128)
  ) {
    return { ok: false, reason: "bounds" };
  }

  const seq = parseSeq(parsed.seq);
  const value = parseValue(parsed.value);
  const unit = parseOptionalText(parsed.unit);
  const note = parseOptionalText(parsed.note);
  if (seq === null || value === null || unit === undefined || note === undefined) {
    return { ok: false, reason: "bounds" };
  }

  let entry: Entry;
  try {
    entry = validateEntry({ value, contact: candidate, unit, note });
    // Rebuild the canonical bytes: bounds are the contract's, not ours.
    signingBytes(slot, seq, entry);
  } catch {
    return { ok: false, reason: "bounds" };
  }

  const address = parsed.address;
  if (address !== null && (typeof address !== "string" || !ADDRESS_RE.test(address))) {
    return { ok: false, reason: "bounds" };
  }

  return {
    ok: true,
    code: {
      owner,
      candidate,
      slot,
      seq,
      entry,
      address: address as string | null,
      sig,
    },
  };
}

/** Encode a code for copying. The JSON is a transport detail, not the signed bytes. */
export function encodeAdmissionCode(code: AdmissionCode): string {
  const json = JSON.stringify({
    v: 1,
    owner: code.owner,
    candidate: code.candidate,
    slot: code.slot,
    seq: String(code.seq),
    value: code.entry.value.toString(),
    unit: code.entry.unit,
    note: code.entry.note,
    address: code.address,
    sig: code.sig,
  });
  return ADMISSION_CODE_PREFIX + toBase64Url(new TextEncoder().encode(json));
}

/**
 * Build the owner's copyable code from a written slot. Null when the slot is
 * not a complete designation (no entry, no signature, or out-of-bounds).
 */
export function buildAdmissionCode(input: {
  owner: string;
  slot: number;
  record: Slot;
  address: string | null;
}): AdmissionCode | null {
  const { owner, slot, record, address } = input;
  if (!isLowerHex(owner, 64)) return null;
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= SLOT_COUNT) return null;
  if (record.entry === null || record.seq <= 0 || record.sig === null) return null;
  if (!isLowerHex(record.sig, 128)) return null;
  try {
    signingBytes(slot, record.seq, record.entry);
  } catch {
    return null;
  }
  if (address !== null && !ADDRESS_RE.test(address)) return null;
  return {
    owner,
    candidate: record.entry.contact,
    slot,
    seq: record.seq,
    entry: record.entry,
    address,
    sig: record.sig,
  };
}

/**
 * Verify a pasted code. `options.candidate` is the viewer's own id; a code for
 * someone else is refused. `options.expectedOwner` refuses a code that would
 * retarget an already-open flow.
 */
export async function verifyAdmissionCode(
  text: string,
  options: AdmissionVerifyOptions,
): Promise<AdmissionResult> {
  const decoded = decodeAdmissionCode(text);
  if (!decoded.ok) return decoded;
  const code = decoded.code;

  if (code.candidate !== code.entry.contact) {
    return { ok: false, reason: "bounds" };
  }
  if (options.candidate === null || code.candidate !== options.candidate) {
    return { ok: false, reason: "candidate" };
  }
  if (options.expectedOwner != null && code.owner !== options.expectedOwner) {
    return { ok: false, reason: "owner" };
  }

  let message: Uint8Array;
  try {
    message = signingBytes(code.slot, code.seq, code.entry);
  } catch {
    return { ok: false, reason: "bounds" };
  }
  const ok = verifyEd25519(
    hexToBytes(code.sig),
    message,
    hexToBytes(code.owner),
  );
  return ok ? { ok: true, code } : { ok: false, reason: "signature" };
}

/** Extract a code from a bare paste, a `?admit=` link, or `admit=<code>`. */
export function admissionCodeFromInput(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith(ADMISSION_CODE_PREFIX)) {
    return trimmed.replace(/\s+/g, "");
  }
  let search: string | null = null;
  const question = trimmed.indexOf("?");
  if (question >= 0) search = trimmed.slice(question);
  else if (trimmed.startsWith("admit=") || trimmed.startsWith("?")) search = trimmed.startsWith("?") ? trimmed : `?${trimmed}`;
  if (search === null) return null;
  const values = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).getAll("admit");
  if (values.length !== 1) return null;
  const value = values[0]!.trim();
  return value.startsWith(ADMISSION_CODE_PREFIX) ? value : null;
}

/** Whether a text is plausibly an admission code (for UI branching). */
export function looksLikeAdmissionCode(text: string): boolean {
  return admissionCodeFromInput(text) !== null;
}

/**
 * Apply the owner-zone freshness rule to a readable copy.
 *
 * Reads are not proof: a node serves its local copy. Only a *higher* seq is
 * definitive, because seq is monotonic. A stale (lower) read must never block
 * the signed handoff, and a same-seq read must agree or something is wrong.
 */
export type AdmissionCrossCheck =
  | { kind: "unreadable" }
  | { kind: "stale" }
  | { kind: "agrees"; slot: Slot }
  | { kind: "changed"; seq: number };

function sameEntry(left: Entry | null, right: Entry): boolean {
  return (
    left !== null &&
    left.value === right.value &&
    left.contact === right.contact &&
    left.unit === right.unit &&
    left.note === right.note
  );
}

export function crossCheckAdmission(
  code: AdmissionCode,
  local: Slot | null,
): AdmissionCrossCheck {
  if (local === null) return { kind: "unreadable" };
  if (local.seq < code.seq) return { kind: "stale" };
  return sameEntry(local.entry, code.entry)
    ? { kind: "agrees", slot: local }
    : { kind: "changed", seq: local.seq };
}

/** The address the code assigns: the owner's reported address plus the digit. */
export function admissionCodeAddress(code: AdmissionCode): string | null {
  return code.address === null ? null : `${code.address}${code.slot}`;
}

/** Readable copy for a failed verification. */
export function admissionFailureText(reason: AdmissionFailureKind): string {
  switch (reason) {
    case "owner":
      return "That admission code belongs to a different zone than the one you opened.";
    case "candidate":
      return "That admission code was issued for a different identity, so it cannot be used here.";
    case "signature":
      return "The admission code's signature did not verify. Ask the owner to copy it again.";
    case "version":
    case "bounds":
      return "That admission code is not valid.";
    case "format":
    default:
      return "That is not an admission code. Paste the code the owner copied, the root id they gave you, or a link carrying it.";
  }
}


