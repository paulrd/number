/**
 * Delegate request/response transport.
 *
 * The number-delegate speaks JSON in `ApplicationMessage.payload` (DESIGN §7).
 * stdlib 0.4.0 still has no public delegate-send API, so we build the flatbuffer
 * request here and hand it to FreenetWsApi's private `sendRequest` through a
 * narrow callback supplied by NumberContract. Responses arrive through the
 * regular ResponseHandler.
 */

import {
  DelegateRequest,
  type DelegateResponse,
} from "@freenetorg/freenet-stdlib";
import { OutboundDelegateMsgType } from "@freenetorg/freenet-stdlib/host-response";
import { stringify as stringifyJsonLossless } from "lossless-json";
import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";
import { ApplicationMessageT } from "@freenetorg/freenet-stdlib/common";
import {
  ApplicationMessagesT,
  ClientRequestT,
  ClientRequestType,
  DelegateCodeT,
  DelegateContainerT,
  DelegateKeyT,
  DelegateRequestType,
  DelegateType,
  InboundDelegateMsgT,
  InboundDelegateMsgType,
  RegisterDelegateT,
  WasmDelegateV1T,
  type ClientRequestT as ClientRequestTable,
} from "@freenetorg/freenet-stdlib/client-request";
import {
  validateAdjustmentList,
  validateChildNameList,
  validateEntry,
  validatePaymentEntry,
  validateSettled,
  type Adjustment,
  type ChildName,
  type Entry,
} from "./state";
import {
  MAX_CONTACT_LABEL_BYTES,
  contactAddressValueProblem,
  contactLabelProblem,
  contactListProblem,
  contactRecordProblem,
  normalizeContactList,
  normalizeContactRecord,
  type ContactRecord,
} from "./contact-rules";
import type { PaymentEntry } from "./payments";
import type { RoomSecretV1 } from "./room-state";
import { delay, errorMessage, isLowerHex, utf8Length } from "./util";

export type DelegateErrorCode =
  | "Missing"
  | "Config"
  | "Timeout"
  | "Unavailable"
  | "Protocol"
  | "Rejected";

export class DelegateError extends Error {
  readonly code: DelegateErrorCode;

  constructor(code: DelegateErrorCode, message: string) {
    super(message);
    this.name = "DelegateError";
    this.code = code;
  }
}

export const MISSING_DELEGATE_MESSAGE =
  "The number-delegate is not registered with this Freenet node. " +
  "Publish the delegate, then rebuild the UI with its key bytes and code hash.";

export function isMissingDelegateError(error: unknown): error is DelegateError {
  return error instanceof DelegateError && error.code === "Missing";
}

export type { ContactRecord } from "./contact-rules";

/** Request for the delegate's `signRoomMembership` command (v11). */
export interface RoomMembershipSignRequest {
  /** Base58 room instance id, 32 bytes. */
  roomId: string;
  /** Room owner verifying key, 64 lowercase hex characters. */
  owner: string;
  /** Room kind tag; only `"ZMR1"` (members room) is supported. */
  tag: string;
  seq: number;
  /** Strictly ascending, duplicate-free member keys; includes the owner. */
  members: string[];
  secrets: RoomSecretV1[];
}

/** Request for the delegate's `signRoomMessage` command (v11). */
export interface RoomMessageSignRequest {
  roomId: string;
  owner: string;
  tag: string;
  epoch: number;
  time: number;
  /** Message body, 1..=1024 decoded bytes as lowercase hex. */
  body: string;
}

/** Delegate-assigned message signature and per-author sequence. */
export interface SignedRoomMessage {
  author: string;
  seq: number;
  sig: string;
}

const ROOM_TAG = "ZMR1";
const ROOM_MAX_BODY_BYTES = 1024;
const ROOM_MAX_SECRET_BLOB_BYTES = 256;

function isBase58Key32(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
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

function validateRoomId(roomId: unknown): asserts roomId is string {
  if (!isBase58Key32(roomId)) {
    throw new DelegateError(
      "Protocol",
      "roomId must be a base58-encoded 32-byte room instance id.",
    );
  }
}

function validateRoomOwner(owner: unknown): asserts owner is string {
  if (typeof owner !== "string" || !isLowerHex(owner, 64)) {
    throw new DelegateError(
      "Protocol",
      "room owner must be 64 lowercase hex characters.",
    );
  }
}

function validateRoomTag(tag: unknown): asserts tag is string {
  if (tag !== ROOM_TAG) {
    throw new DelegateError("Protocol", `room tag must be ${ROOM_TAG}.`);
  }
}

function validateContactLabel(value: unknown, path: string): string {
  const problem = contactLabelProblem(value, path);
  if (problem) throw new DelegateError("Protocol", problem);
  return value as string;
}

function validateContactAddress(value: unknown, path: string): string | null {
  const problem = contactAddressValueProblem(value, path);
  if (problem) throw new DelegateError("Protocol", problem);
  return value === undefined || value === null ? null : (value as string);
}

/** Validate one address-book entry, mirroring the delegate's invariants. */
function validateContactRecord(
  raw: unknown,
  path = "contact",
): ContactRecord {
  const problem = contactRecordProblem(raw, path);
  if (problem) throw new DelegateError("Protocol", problem);
  return normalizeContactRecord(raw);
}

/** Validate the whole address book the delegate returned. */
function validateContactList(raw: unknown): ContactRecord[] {
  const problem = contactListProblem(raw, "contacts");
  if (problem) throw new DelegateError("Protocol", problem);
  return normalizeContactList(raw);
}

export interface DelegateIdentity {
  /** 32-byte Ed25519 verifying key as 64 lowercase hex characters. */
  pubkey: string;
  /** Per-slot next sequence values, 8 entries, each >= 1. */
  nextSeq: number[];
  /** Next sequence value for the signed contacts record, >= 1. */
  contactsNextSeq: number;
  /** Next sequence value for the signed parent record, >= 1. */
  parentNextSeq: number;
  /**
   * Next sequence value for the signed payments record, >= 1. Optional for
   * compatibility with delegates built before v4; normalize with `?? 1`.
   */
  paymentsNextSeq?: number;
  /**
   * Next sequence value for the signed v5 adjustments record, >= 1. Optional
   * for compatibility with delegates built before v5; normalize with `?? 1`.
   */
  adjustmentsNextSeq?: number;
  /**
   * Next sequence value for the signed v6 `childNames` record, >= 1. Optional
   * for compatibility with delegates built before v9; normalize with `?? 1`.
   */
  childNamesNextSeq?: number;
  /**
   * Next sequence value for the signed v6 `selfName` record, >= 1. Optional
   * for compatibility with delegates built before v9; normalize with `?? 1`.
   */
  selfNameNextSeq?: number;
}

/** Default per-payment cap in hundredths (10,000.00); 0 disables the cap. */
export const DEFAULT_MAX_AMOUNT = 1_000_000;

export interface DelegateAuditEntry {
  /** Payment id the delegate acted on. */
  id: string;
  /** Cursor of the payment record it advanced. */
  cursor: number;
  /** Slot indices it signed in that step. */
  slots: number[];
  /** Actor role, e.g. "debit" or "credit". */
  role: string;
}

export interface DelegateStatus {
  hasSeed: boolean;
  /** Present only when `hasSeed` is true. */
  identity: DelegateIdentity | null;
  /**
   * v8 auto-advance fields (DESIGN-v4.1-v5 "Configuration"). A predecessor
   * delegate that predates v8 omits them, so they are normalized to inert
   * defaults rather than rejected.
   */
  configured: boolean;
  /** Base58 contract code hashes the delegate was configured with, newest first. */
  codeHashes: string[];
  /** The hash that resolved the owner's own board; null before configuration. */
  matchedCodeHash: string | null;
  /** Octal owner address the delegate was configured with; null before configuration. */
  address: string | null;
  autoAdvance: boolean;
  maxAmount: number;
  /** Hex instance ids the delegate currently subscribes to. */
  subscriptions: string[];
  /** Timestamp/counter of the delegate's last scan; 0 before the first scan. */
  lastScan: number;
  lastError: string | null;
  /** Bounded audit of recent auto-advance steps (at most 32). */
  audit: DelegateAuditEntry[];
}

/**
 * The delegate is stale when it was configured for a different active contract
 * hash. A stale hash resolves every neighbour to a different instance and
 * silently returns nothing, which is the main operational failure mode.
 *
 * An unconfigured delegate is not stale: there is nothing to compare yet (the
 * UI should show "not configured" instead).
 */
export function isDelegateStatusStale(
  status: Pick<DelegateStatus, "configured" | "matchedCodeHash">,
  activeCodeHash: string,
): boolean {
  if (!status.configured) return false;
  // `configure` clears the matched hash, and a delegate that has not scanned
  // since then reports null. That is "unknown", not a mismatch; treating it as
  // stale false-alarms on every page load until the next 5-minute scan.
  if (status.matchedCodeHash === null) return false;
  return status.matchedCodeHash !== activeCodeHash;
}

/**
 * A configured, enabled delegate that has never completed a scan.
 *
 * This is the observable symptom of a missing node-enforced Background grant:
 * the node never arms lifecycle events or wake-ups, so the component stays
 * inert while its configuration looks healthy. It is also true for the first
 * seconds after installation, before the first wake-up lands; the UI copy says
 * "if this lasts" rather than claiming a failure.
 */
export function delegateNeverScanned(
  status: Pick<DelegateStatus, "configured" | "autoAdvance" | "lastScan">,
): boolean {
  return status.configured && status.autoAdvance && status.lastScan === 0;
}

export interface ExportedSecrets {
  /**
   * Delegate export payload version. v2 carries the private address book and
   * both v6 name counters; v1 (a pre-v9 export) has neither. `?? 1`.
   */
  payloadVersion: number;
  /** 32-byte Ed25519 seed as 64 lowercase hex characters. */
  seed: string;
  nextSeq: number[];
  /** Next sequence value for the signed contacts record, >= 1. */
  contactsNextSeq: number;
  /** Next sequence value for the signed parent record, >= 1. */
  parentNextSeq: number;
  /**
   * Next sequence value for the signed payments record, >= 1. Optional for
   * compatibility with exports from delegates built before v4; `?? 1`.
   */
  paymentsNextSeq?: number;
  /**
   * Next sequence value for the signed v5 adjustments record, >= 1. Optional
   * for compatibility with exports from delegates built before v5; `?? 1`.
   */
  adjustmentsNextSeq?: number;
  /**
   * Next sequence value for the signed v6 `childNames` record, >= 1. Optional
   * for compatibility with exports from delegates built before v9; `?? 1`.
   */
  childNamesNextSeq?: number;
  /**
   * Next sequence value for the signed v6 `selfName` record, >= 1. Optional
   * for compatibility with exports from delegates built before v9; `?? 1`.
   */
  selfNameNextSeq?: number;
  /** The private address book; empty for a v1 payload. */
  contacts: ContactRecord[];
}

type ResponseRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ResponseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((n) => typeof n === "number")) {
    return Uint8Array.from(value);
  }
  return null;
}

/** Extract JSON payloads from the outbound application messages in a response. */
export function parseDelegatePayloads(response: DelegateResponse): unknown[] {
  const values = (response as unknown as { values?: unknown }).values;
  if (!Array.isArray(values)) return [];

  const payloads: unknown[] = [];
  for (const outbound of values) {
    if (!isRecord(outbound)) continue;

    const rawType = outbound.inboundType;
    const type =
      typeof rawType === "function"
        ? (rawType as () => number).call(outbound)
        : rawType;
    if (type !== OutboundDelegateMsgType.common_ApplicationMessage) continue;

    const rawInbound = outbound.inbound;
    const inbound =
      typeof rawInbound === "function"
        ? (rawInbound as () => unknown).call(outbound)
        : rawInbound;
    if (!isRecord(inbound)) continue;

    const payload = toBytes(inbound.payload);
    if (!payload || payload.length === 0) continue;
    try {
      payloads.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)));
    } catch (error) {
      console.warn("[delegate] could not parse application payload:", errorMessage(error));
    }
  }
  return payloads;
}

function classifyDelegateFailure(message: string): DelegateError {
  if (
    /delegate/i.test(message) &&
    /not[\s_-]*found|not[\s_-]*registered|missing|unknown|no such|unavailable/i.test(
      message,
    )
  ) {
    return new DelegateError(
      "Missing",
      `${MISSING_DELEGATE_MESSAGE} (node said: ${message})`,
    );
  }
  return new DelegateError("Rejected", `Delegate request failed: ${message}`);
}

interface PendingRequest {
  kind:
    | "identity"
    | "sign"
    | "roomMessage"
    | "contacts"
    | "status"
    | "export"
    | "import"
    | "configure"
    | "setAutoAdvance";
  resolve: (payload: ResponseRecord) => void;
  reject: (error: DelegateError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DelegateClient {
  private readonly keyBytes: number[];
  private readonly codeHashBytes: number[];
  private readonly paramsBytes: number[];
  private pending: PendingRequest[] = [];
  private readonly configError: DelegateError | null;

  constructor(
    private readonly send: (request: ClientRequestTable) => void,
    keyBytes: number[],
    codeHashBytes: number[],
    paramsBytes: number[],
  ) {
    this.keyBytes = [...keyBytes];
    this.codeHashBytes = [...codeHashBytes];
    this.paramsBytes = [...paramsBytes];

    if (
      this.keyBytes.length !== 32 ||
      this.codeHashBytes.length !== 32 ||
      this.paramsBytes.length !== 32
    ) {
      this.configError = new DelegateError(
        "Config",
        "Delegate build configuration is missing or invalid: expected 32-byte " +
          "delegate key, 32-byte delegate code hash, and 32-byte webapp id " +
          "parameters. Rebuild the UI after publishing the delegate.",
      );
    } else {
      this.configError = null;
    }
  }

  identity(timeoutMs = 12_000): Promise<DelegateIdentity> {
    return this.request("identity", { cmd: "identity" }, timeoutMs).then(
      (payload) => this.parseIdentity(payload),
    );
  }

  /** Report whether a seed exists without creating one. */
  status(timeoutMs = 5_000): Promise<DelegateStatus> {
    return this.request("status", { cmd: "status" }, timeoutMs).then((payload) =>
      this.parseStatus(payload),
    );
  }

  /**
   * Configure v8 auto-advance. `codeHashes` are base58 code hashes, newest
   * first (the active contract hash, then the legacy generations). `address`
   * is the owner's octal address from the UI and may be "" for a root board.
   *
   * DESIGN's request example lists only `codeHashes` and `address`, while the
   * stored configuration and the pass-1 task list also carry `autoAdvance` and
   * `maxAmount`; both are sent so the delegate can persist the full policy in
   * one request (see DESIGN-v4.1-v5 "Configuration"/"Policy").
   */
  async configure(
    codeHashes: string[],
    address: string,
    autoAdvance = true,
    maxAmount = DEFAULT_MAX_AMOUNT,
    timeoutMs = 5_000,
  ): Promise<void> {
    const validatedHashes = this.validateCodeHashes(codeHashes);
    if (validatedHashes.length === 0) {
      throw new DelegateError("Protocol", "codeHashes must not be empty.");
    }
    if (!/^[0-7]*$/.test(address)) {
      throw new DelegateError(
        "Protocol",
        "address must be an octal string (digits 0-7), including \"\" for a root.",
      );
    }
    if (typeof autoAdvance !== "boolean") {
      throw new DelegateError("Protocol", "autoAdvance must be a boolean.");
    }
    const validatedMaxAmount = this.validateMaxAmount(maxAmount);

    await this.request(
      "configure",
      {
        cmd: "configure",
        codeHashes: validatedHashes,
        address,
        autoAdvance,
        maxAmount: validatedMaxAmount,
      },
      timeoutMs,
    );
  }

  /** Enable or disable auto-advance and (optionally) change its per-payment cap. */
  async setAutoAdvance(
    enabled: boolean,
    maxAmount = DEFAULT_MAX_AMOUNT,
    timeoutMs = 5_000,
  ): Promise<void> {
    if (typeof enabled !== "boolean") {
      throw new DelegateError("Protocol", "enabled must be a boolean.");
    }
    const validatedMaxAmount = this.validateMaxAmount(maxAmount);

    await this.request(
      "setAutoAdvance",
      { cmd: "setAutoAdvance", enabled, maxAmount: validatedMaxAmount },
      timeoutMs,
    );
  }

  /**
   * Install this delegate on the node from the app's bundled WASM.
   *
   * The code is verified against the code hash this build injected before it is
   * sent, so a tampered asset cannot be installed under the app's delegate key.
   * The node's registration response is not a JSON payload we can correlate, so
   * success is confirmed by polling `status` (which only answers once the
   * delegate is in the store).
   */
  async register(code: Uint8Array, timeoutMs = 25_000): Promise<void> {
    if (this.configError) throw this.configError;
    if (code.length === 0) {
      throw new DelegateError("Protocol", "The bundled delegate is empty.");
    }
    const actual = blake3(code);
    const expected = Uint8Array.from(this.codeHashBytes);
    if (
      actual.length !== expected.length ||
      actual.some((byte, index) => byte !== expected[index])
    ) {
      throw new DelegateError(
        "Config",
        "The bundled delegate does not match the code hash this app was built " +
          "for; refusing to install it.",
      );
    }

    try {
      this.send(this.buildRegisterRequest(code));
    } catch (error) {
      throw new DelegateError(
        "Unavailable",
        `Could not send the delegate installation request: ${errorMessage(error)}`,
      );
    }

    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      await delay(400);
      try {
        await this.status(2_000);
        return;
      } catch (error) {
        lastError = error;
        // Missing is expected until the node finishes storing it; a timeout is
        // also "not yet". Anything else (rejection) should stop immediately.
        if (
          !(error instanceof DelegateError) ||
          (error.code !== "Missing" && error.code !== "Timeout")
        ) {
          throw error;
        }
      }
    }

    throw new DelegateError(
      "Unavailable",
      `The node did not register the number-delegate within ${Math.round(
        timeoutMs / 1000,
      )}s. Try again, or install it on the node with fdev.` +
        (lastError ? ` Last response: ${errorMessage(lastError)}` : ""),
    );
  }

  /** Ask a predecessor delegate for its seed and sequence counters. */
  exportSecrets(timeoutMs = 5_000): Promise<ExportedSecrets> {
    return this.request("export", { cmd: "export" }, timeoutMs).then((payload) =>
      this.parseExport(payload),
    );
  }

  /**
   * Restore a predecessor's seed into this fresh delegate.
   *
   * v2 payloads carry the private address book; v1 payloads (a pre-v9 export)
   * have no contacts and no name counters, so those default to empty and 1.
   */
  async importSecrets(
    seed: string,
    nextSeq: number[],
    contactsNextSeq = 1,
    parentNextSeq = 1,
    paymentsNextSeq = 1,
    adjustmentsNextSeq = 1,
    childNamesNextSeq = 1,
    selfNameNextSeq = 1,
    payloadVersion = 1,
    contacts?: ContactRecord[],
    timeoutMs = 5_000,
  ): Promise<void> {
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
      throw new DelegateError(
        "Protocol",
        "Refusing to import a seed that is not 32 bytes of hex.",
      );
    }
    if (payloadVersion !== 1 && payloadVersion !== 2) {
      throw new DelegateError(
        "Protocol",
        `payloadVersion must be 1 or 2, got ${payloadVersion}.`,
      );
    }
    this.validateNextSeq(nextSeq);
    const validatedContactsNextSeq = this.validateContactsNextSeq(contactsNextSeq);
    const validatedParentNextSeq = this.validateParentNextSeq(parentNextSeq);
    const validatedPaymentsNextSeq =
      this.validatePaymentsNextSeq(paymentsNextSeq);
    const validatedAdjustmentsNextSeq =
      this.validateAdjustmentsNextSeq(adjustmentsNextSeq);
    const validatedChildNamesNextSeq =
      this.validateChildNamesNextSeq(childNamesNextSeq);
    const validatedSelfNameNextSeq =
      this.validateSelfNameNextSeq(selfNameNextSeq);

    const message: Record<string, unknown> = {
      cmd: "import",
      seed: seed.toLowerCase(),
      payloadVersion,
      nextSeq,
      contactsNextSeq: validatedContactsNextSeq,
      parentNextSeq: validatedParentNextSeq,
      paymentsNextSeq: validatedPaymentsNextSeq,
      adjustmentsNextSeq: validatedAdjustmentsNextSeq,
      childNamesNextSeq: validatedChildNamesNextSeq,
      selfNameNextSeq: validatedSelfNameNextSeq,
    };
    // Forward the address book when the caller has one (v2); a v1 payload
    // omits it and the delegate restores an empty book.
    if (contacts !== undefined || payloadVersion === 2) {
      message.contacts = validateContactList(contacts ?? []);
    }

    await this.request("import", message, timeoutMs);
  }

  /** List the delegate's private address book. */
  listContacts(timeoutMs = 5_000): Promise<ContactRecord[]> {
    return this.request("contacts", { cmd: "contacts" }, timeoutMs).then(
      (payload) => this.parseContacts(payload),
    );
  }

  /** Add one address-book entry; the delegate returns the resulting array. */
  async addContact(
    entry: { label: string; userId: string; address?: string | null },
    timeoutMs = 5_000,
  ): Promise<ContactRecord[]> {
    const validated = validateContactRecord({
      label: entry.label,
      userId: entry.userId,
      address: entry.address ?? null,
    });
    return this.request(
      "contacts",
      {
        cmd: "contacts.add",
        label: validated.label,
        userId: validated.userId,
        address: validated.address,
      },
      timeoutMs,
    ).then((payload) => this.parseContacts(payload));
  }

  /**
   * Change the label and/or address of one entry. An absent `address` leaves
   * the stored address alone; an explicit `null` clears it (the delegate's
   * `Some(None)` distinction).
   */
  async updateContact(
    userId: string,
    patch: { label?: string; address?: string | null },
    timeoutMs = 5_000,
  ): Promise<ContactRecord[]> {
    if (!isLowerHex(userId, 64)) {
      throw new DelegateError(
        "Protocol",
        "userId must be 64 lowercase hex characters.",
      );
    }
    const message: Record<string, unknown> = {
      cmd: "contacts.update",
      userId,
    };
    if (patch.label !== undefined) {
      message.label = validateContactLabel(patch.label, "label");
    }
    if ("address" in patch && patch.address !== undefined) {
      message.address = validateContactAddress(patch.address, "address");
    }
    return this.request("contacts", message, timeoutMs).then((payload) =>
      this.parseContacts(payload),
    );
  }

  /** Remove one address-book entry by userId. */
  async removeContact(
    userId: string,
    timeoutMs = 5_000,
  ): Promise<ContactRecord[]> {
    if (!isLowerHex(userId, 64)) {
      throw new DelegateError(
        "Protocol",
        "userId must be 64 lowercase hex characters.",
      );
    }
    return this.request(
      "contacts",
      { cmd: "contacts.remove", userId },
      timeoutMs,
    ).then((payload) => this.parseContacts(payload));
  }

  async sign(
    slot: number,
    seq: number,
    entry: Entry | null,
    timeoutMs = 15_000,
  ): Promise<string> {
    if (!Number.isInteger(slot) || slot < 0 || slot > 7) {
      throw new DelegateError("Protocol", `slot must be in 0..7, got ${slot}`);
    }
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw new DelegateError("Protocol", `seq must be a positive integer, got ${seq}`);
    }
    const validatedEntry = entry === null ? null : validateEntry(entry);

    const payload = await this.request(
      "sign",
      { cmd: "sign", slot, seq, entry: validatedEntry },
      timeoutMs,
    );
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string" ? payload.error : "sign was rejected",
      );
    }
    const sig = payload.sig;
    if (typeof sig !== "string" || !isLowerHex(sig, 128)) {
      throw new DelegateError(
        "Protocol",
        "Delegate returned a malformed signature (expected 128 lowercase hex characters).",
      );
    }
    return sig;
  }

  /**
   * Sign the owner's `selfName` record at `seq`; a null name signs the cleared
   * tombstone. Reuses the `"sign"` pending kind because the delegate answers
   * `{ok, sig}`, exactly like `signParent`.
   */
  async signSelfName(
    seq: number,
    name: string | null,
    timeoutMs = 15_000,
  ): Promise<string> {
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw new DelegateError("Protocol", `seq must be a positive integer, got ${seq}`);
    }
    if (name !== null) {
      if (typeof name !== "string" || name.length === 0) {
        throw new DelegateError(
          "Protocol",
          "selfName must be null or a non-empty string.",
        );
      }
      const length = utf8Length(name);
      if (length > MAX_CONTACT_LABEL_BYTES) {
        throw new DelegateError(
          "Protocol",
          `selfName is ${length} bytes; maximum is ${MAX_CONTACT_LABEL_BYTES}.`,
        );
      }
    }

    const payload = await this.request(
      "sign",
      { cmd: "signSelfName", seq, name },
      timeoutMs,
    );
    return this.parseSignResponse(payload, "signSelfName");
  }

  /**
   * Sign the whole `childNames` record at `seq`. Entries must be in strictly
   * ascending slot order. Reuses the `"sign"` pending kind (`{ok, sig}`).
   */
  async signChildNames(
    seq: number,
    entries: ChildName[],
    timeoutMs = 15_000,
  ): Promise<string> {
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw new DelegateError("Protocol", `seq must be a positive integer, got ${seq}`);
    }
    let validatedEntries: ChildName[];
    try {
      validatedEntries = validateChildNameList(entries);
    } catch (error) {
      throw new DelegateError("Protocol", errorMessage(error));
    }

    const payload = await this.request(
      "sign",
      { cmd: "signChildNames", seq, entries: validatedEntries },
      timeoutMs,
    );
    return this.parseSignResponse(payload, "signChildNames");
  }

  /** Validate the common `{ok, sig}` reply used by every sign command. */
  private parseSignResponse(
    payload: ResponseRecord,
    command: string,
  ): string {
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string"
          ? payload.error
          : `${command} was rejected`,
      );
    }
    const sig = payload.sig;
    if (typeof sig !== "string" || !isLowerHex(sig, 128)) {
      throw new DelegateError(
        "Protocol",
        "Delegate returned a malformed signature (expected 128 lowercase hex characters).",
      );
    }
    return sig;
  }

  /**
   * Sign the signed parent link. `userId` is the parent board owner, or null to
   * clear the parent (a tombstone at a higher seq). Reuses the `"sign"` pending
   * kind because the delegate answers `{ok, sig}`.
   */
  async signParent(
    seq: number,
    userId: string | null,
    timeoutMs = 15_000,
  ): Promise<string> {
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw new DelegateError("Protocol", `seq must be a positive integer, got ${seq}`);
    }
    if (userId !== null && !isLowerHex(userId, 64)) {
      throw new DelegateError(
        "Protocol",
        "userId must be null or 64 lowercase hex characters.",
      );
    }

    const payload = await this.request(
      "sign",
      { cmd: "signParent", seq, userId },
      timeoutMs,
    );
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string"
          ? payload.error
          : "signParent was rejected",
      );
    }
    const sig = payload.sig;
    if (typeof sig !== "string" || !isLowerHex(sig, 128)) {
      throw new DelegateError(
        "Protocol",
        "Delegate returned a malformed signature (expected 128 lowercase hex characters).",
      );
    }
    return sig;
  }

  /**
   * Sign the payments record at `seq`; a null entry is a legal tombstone.
   * `settled` is the bounded list of recently settled payment ids covered by
   * the signature. Reuses the `"sign"` pending kind because the delegate
   * answers `{ok, sig}`.
   */
  async signPayments(
    seq: number,
    entry: PaymentEntry | null,
    settled: string[],
    timeoutMs = 15_000,
  ): Promise<string> {
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw new DelegateError("Protocol", `seq must be a positive integer, got ${seq}`);
    }
    let validatedEntry: PaymentEntry | null;
    let validatedSettled: string[];
    try {
      validatedEntry = entry === null ? null : validatePaymentEntry(entry);
      validatedSettled = validateSettled(settled);
    } catch (error) {
      throw new DelegateError("Protocol", errorMessage(error));
    }

    const payload = await this.request(
      "sign",
      {
        cmd: "signPayments",
        seq,
        settled: validatedSettled,
        entry: validatedEntry,
      },
      timeoutMs,
    );
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string"
          ? payload.error
          : "signPayments was rejected",
      );
    }
    const sig = payload.sig;
    if (typeof sig !== "string" || !isLowerHex(sig, 128)) {
      throw new DelegateError(
        "Protocol",
        "Delegate returned a malformed signature (expected 128 lowercase hex characters).",
      );
    }
    return sig;
  }

  /**
   * Sign the v5 issue/burn log at `seq`. `entries` is the whole log the
   * signature covers (oldest first, at most 32). The delegate validates the
   * same structural bounds and persists `seq + 1`. Reuses the `"sign"` pending
   * kind because the board serialises writes; the response is `{seq, sig}`.
   */
  async signAdjustment(
    seq: number,
    entries: Adjustment[],
    timeoutMs = 15_000,
  ): Promise<{ seq: number; sig: string }> {
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw new DelegateError("Protocol", `seq must be a positive integer, got ${seq}`);
    }
    let validatedEntries: Adjustment[];
    try {
      validatedEntries = validateAdjustmentList(entries);
    } catch (error) {
      throw new DelegateError("Protocol", errorMessage(error));
    }

    const payload = await this.request(
      "sign",
      { cmd: "signAdjustment", seq, entries: validatedEntries },
      timeoutMs,
    );
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string"
          ? payload.error
          : "signAdjustment was rejected",
      );
    }
    const returnedSeq = payload.seq;
    if (
      typeof returnedSeq !== "number" ||
      !Number.isSafeInteger(returnedSeq) ||
      returnedSeq < seq
    ) {
      throw new DelegateError(
        "Protocol",
        `Delegate returned an invalid signed seq (${String(returnedSeq)}) for ${seq}.`,
      );
    }
    const sig = payload.sig;
    if (typeof sig !== "string" || !isLowerHex(sig, 128)) {
      throw new DelegateError(
        "Protocol",
        "Delegate returned a malformed signature (expected 128 lowercase hex characters).",
      );
    }
    return { seq: returnedSeq, sig };
  }

  /**
   * Sign a members-room membership record (`DESIGN-rooms.md` §3). The delegate
   * assigns the next per-room membership seq; the caller must pass the current
   * record's seq. Returns the 128-hex owner signature.
   */
  async signRoomMembership(
    request: RoomMembershipSignRequest,
    timeoutMs = 15_000,
  ): Promise<string> {
    const { roomId, owner, tag, seq, members, secrets } = request;
    validateRoomId(roomId);
    validateRoomOwner(owner);
    validateRoomTag(tag);
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw new DelegateError(
        "Protocol",
        `room membership seq must be a positive integer, got ${String(seq)}.`,
      );
    }
    if (!Array.isArray(members) || members.length < 1 || members.length > 9) {
      throw new DelegateError(
        "Protocol",
        "room membership must contain 1..9 members.",
      );
    }
    for (let index = 0; index < members.length; index++) {
      const member = members[index];
      if (typeof member !== "string" || !isLowerHex(member, 64)) {
        throw new DelegateError(
          "Protocol",
          `room member ${index} must be 64 lowercase hex characters.`,
        );
      }
      if (index > 0 && members[index - 1] >= member) {
        throw new DelegateError(
          "Protocol",
          "room members must be strictly ascending and duplicate-free.",
        );
      }
    }
    if (!members.includes(owner)) {
      throw new DelegateError(
        "Protocol",
        "room membership must include the room owner.",
      );
    }
    if (!Array.isArray(secrets)) {
      throw new DelegateError("Protocol", "room secrets must be an array.");
    }
    for (let index = 0; index < secrets.length; index++) {
      const secret = secrets[index];
      if (
        typeof secret !== "object" ||
        secret === null ||
        typeof secret.recipient !== "string" ||
        !isLowerHex(secret.recipient, 64)
      ) {
        throw new DelegateError(
          "Protocol",
          `room secret ${index} recipient must be 64 lowercase hex characters.`,
        );
      }
      if (
        !isLowerHexBytes(
          secret.blob,
          1,
          ROOM_MAX_SECRET_BLOB_BYTES,
        )
      ) {
        throw new DelegateError(
          "Protocol",
          `room secret ${index} blob must be 1..${ROOM_MAX_SECRET_BLOB_BYTES} decoded bytes as lowercase hex.`,
        );
      }
    }

    const payload = await this.request(
      "sign",
      {
        cmd: "signRoomMembership",
        roomId,
        owner,
        tag,
        seq,
        members: [...members],
        secrets: secrets.map((secret) => ({
          recipient: secret.recipient,
          blob: secret.blob,
        })),
      },
      timeoutMs,
    );
    return this.parseSignResponse(payload, "signRoomMembership");
  }

  /**
   * Sign one members-room message. The delegate assigns the per-author `seq`;
   * the reply is `{ok, author, seq, sig}` and uses the distinct `roomMessage`
   * pending kind.
   */
  async signRoomMessage(
    request: RoomMessageSignRequest,
    timeoutMs = 15_000,
  ): Promise<SignedRoomMessage> {
    const { roomId, owner, tag, epoch, time, body } = request;
    validateRoomId(roomId);
    validateRoomOwner(owner);
    validateRoomTag(tag);
    if (!Number.isSafeInteger(epoch) || epoch <= 0) {
      throw new DelegateError(
        "Protocol",
        `room message epoch must be a positive integer, got ${String(epoch)}.`,
      );
    }
    if (!Number.isSafeInteger(time)) {
      throw new DelegateError(
        "Protocol",
        `room message time must be a safe integer, got ${String(time)}.`,
      );
    }
    if (!isLowerHexBytes(body, 1, ROOM_MAX_BODY_BYTES)) {
      throw new DelegateError(
        "Protocol",
        `room message body must be 1..${ROOM_MAX_BODY_BYTES} decoded bytes as lowercase hex.`,
      );
    }

    const payload = await this.request(
      "roomMessage",
      { cmd: "signRoomMessage", roomId, owner, tag, epoch, time, body },
      timeoutMs,
    );
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string"
          ? payload.error
          : "signRoomMessage was rejected",
      );
    }
    const author = payload.author;
    if (typeof author !== "string" || !isLowerHex(author, 64)) {
      throw new DelegateError(
        "Protocol",
        "Delegate returned a malformed room message author.",
      );
    }
    const seq = payload.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) {
      throw new DelegateError(
        "Protocol",
        "Delegate returned an invalid room message seq.",
      );
    }
    const sig = payload.sig;
    if (typeof sig !== "string" || !isLowerHex(sig, 128)) {
      throw new DelegateError(
        "Protocol",
        "Delegate returned a malformed signature (expected 128 lowercase hex characters).",
      );
    }
    return { author, seq, sig };
  }

  /** Feed an outbound DelegateResponse into the waiting request queue. */
  handleResponse(response: DelegateResponse): void {
    const payloads = parseDelegatePayloads(response);
    if (this.pending.length === 0) return;

    if (payloads.length === 0) {
      this.rejectAll(
        new DelegateError(
          "Missing",
          `${MISSING_DELEGATE_MESSAGE} The delegate returned no application message.`,
        ),
      );
      return;
    }

    for (const payload of payloads) {
      if (!isRecord(payload)) continue;

      let index = -1;
      if (payload.ok === false) {
        index = 0; // error responses carry no command discriminator
      } else if (typeof payload.hasSeed === "boolean") {
        index = this.pending.findIndex((pending) => pending.kind === "status");
      } else if (typeof payload.seed === "string") {
        index = this.pending.findIndex((pending) => pending.kind === "export");
      } else if (Array.isArray(payload.contacts)) {
        index = this.pending.findIndex((pending) => pending.kind === "contacts");
      } else if (typeof payload.pubkey === "string") {
        index = this.pending.findIndex((pending) => pending.kind === "identity");
      } else if (
        payload.ok === true &&
        typeof payload.author === "string" &&
        typeof payload.seq === "number" &&
        typeof payload.sig === "string"
      ) {
        // Must precede the generic `sig` branch: a room message reply also
        // carries `sig`, but the author/seq fields identify it.
        index = this.pending.findIndex(
          (pending) => pending.kind === "roomMessage",
        );
      } else if (typeof payload.sig === "string") {
        index = this.pending.findIndex((pending) => pending.kind === "sign");
      } else if (
        typeof payload.configured === "boolean" ||
        typeof payload.matchedCodeHash === "string"
      ) {
        index = this.pending.findIndex((pending) => pending.kind === "configure");
      } else if (typeof payload.autoAdvance === "boolean") {
        index = this.pending.findIndex(
          (pending) => pending.kind === "setAutoAdvance",
        );
      } else if (payload.ok === true) {
        // A bare ok is the v8 acknowledgement shape for configure/setAutoAdvance
        // and the v7 shape for import. Prefer the automation requests that are
        // actually in flight, then fall back to import.
        for (const kind of ["configure", "setAutoAdvance", "import"] as const) {
          index = this.pending.findIndex((pending) => pending.kind === kind);
          if (index !== -1) break;
        }
      }

      // The delegate may acknowledge a configure/setAutoAdvance with a status
      // shape (hasSeed plus the automation fields). If no status request is
      // waiting, resolve the automation request instead of dropping it.
      if (index === -1 && payload.ok !== false) {
        for (const kind of ["configure", "setAutoAdvance"] as const) {
          index = this.pending.findIndex((pending) => pending.kind === kind);
          if (index !== -1) break;
        }
      }

      if (index === -1 && isRecord(payload) && typeof payload.error === "string") {
        index = 0;
      }
      if (index < 0) continue;

      const [pending] = this.pending.splice(index, 1);
      clearTimeout(pending.timer);

      if (payload.ok === false) {
        pending.reject(
          classifyDelegateFailure(
            typeof payload.error === "string" ? payload.error : "delegate rejected the request",
          ),
        );
      } else {
        pending.resolve(payload);
      }
    }
  }

  /** Freenet routed a HostError to us; reject anything waiting. */
  handleHostError(message: string): void {
    this.rejectAll(classifyDelegateFailure(message));
  }

  /** Connection closed / manual reconnect. */
  failAll(message = "Connection to the Freenet node was closed."): void {
    this.rejectAll(new DelegateError("Unavailable", message));
  }

  private request(
    kind: PendingRequest["kind"],
    message: object,
    timeoutMs: number,
  ): Promise<ResponseRecord> {
    if (this.configError) return Promise.reject(this.configError);

    return new Promise<ResponseRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((item) => item.timer === timer);
        if (index !== -1) this.pending.splice(index, 1);
        reject(
          new DelegateError(
            "Timeout",
            `The delegate did not answer the ${kind} request within ${Math.round(
              timeoutMs / 1000,
            )}s.`,
          ),
        );
      }, timeoutMs);

      this.pending.push({ kind, resolve, reject, timer });

      try {
        this.send(this.buildRequest(message));
      } catch (error) {
        const index = this.pending.findIndex((item) => item.timer === timer);
        if (index !== -1) this.pending.splice(index, 1);
        clearTimeout(timer);
        reject(
          new DelegateError(
            "Unavailable",
            `Could not send the delegate request: ${errorMessage(error)}`,
          ),
        );
      }
    });
  }

  private buildRegisterRequest(code: Uint8Array): ClientRequestTable {
    const delegateCode = new DelegateCodeT(Array.from(code), this.codeHashBytes);
    const delegateKey = new DelegateKeyT(this.keyBytes, this.codeHashBytes);
    const wasm = new WasmDelegateV1T(this.paramsBytes, delegateCode, delegateKey);
    const container = new DelegateContainerT(DelegateType.WasmDelegateV1, wasm);
    // The node derives its own per-delegate key material and ignores these
    // since freenet-core#4140; zeros are the documented placeholder.
    const register = new RegisterDelegateT(
      container,
      new Array(32).fill(0),
      new Array(24).fill(0),
    );
    const delegateRequest = new DelegateRequest(
      DelegateRequestType.RegisterDelegate,
      register,
    );
    return new ClientRequestT(ClientRequestType.DelegateRequest, delegateRequest);
  }

  private buildRequest(message: object): ClientRequestTable {
    const payload = Array.from(
      new TextEncoder().encode(stringifyJsonLossless(message)),
    );
    const appMessage = new ApplicationMessageT(payload, [], false);
    const inbound = new InboundDelegateMsgT(
      InboundDelegateMsgType.common_ApplicationMessage,
      appMessage,
    );
    const delegateKey = new DelegateKeyT(this.keyBytes, this.codeHashBytes);
    // The node checks BLAKE3(code_hash || params) against the key on every
    // request. The delegate was published with the webapp id as its params,
    // so omitting them here makes the node refuse the request.
    const appMessages = new ApplicationMessagesT(delegateKey, this.paramsBytes, [inbound]);
    const delegateRequest = new DelegateRequest(
      DelegateRequestType.ApplicationMessages,
      appMessages,
    );
    return new ClientRequestT(ClientRequestType.DelegateRequest, delegateRequest);
  }

  private parseIdentity(payload: ResponseRecord): DelegateIdentity {
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string" ? payload.error : "identity was rejected",
      );
    }

    const pubkey = payload.pubkey;
    if (typeof pubkey !== "string" || !/^[0-9a-fA-F]{64}$/.test(pubkey)) {
      throw new DelegateError(
        "Protocol",
        "Delegate identity response has a malformed pubkey (expected 64 hex characters).",
      );
    }

    return {
      pubkey: pubkey.toLowerCase(),
      nextSeq: this.validateNextSeq(payload.nextSeq),
      contactsNextSeq: this.parseContactsNextSeq(payload.contactsNextSeq),
      parentNextSeq: this.parseParentNextSeq(payload.parentNextSeq),
      paymentsNextSeq: this.parsePaymentsNextSeq(payload.paymentsNextSeq),
      adjustmentsNextSeq: this.parseAdjustmentsNextSeq(
        payload.adjustmentsNextSeq,
      ),
      childNamesNextSeq: this.parseChildNamesNextSeq(payload.childNamesNextSeq),
      selfNameNextSeq: this.parseSelfNameNextSeq(payload.selfNameNextSeq),
    };
  }

  private parseStatus(payload: ResponseRecord): DelegateStatus {
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string" ? payload.error : "status was rejected",
      );
    }
    if (typeof payload.hasSeed !== "boolean") {
      throw new DelegateError(
        "Protocol",
        "Delegate status response is missing a boolean hasSeed.",
      );
    }

    return {
      hasSeed: payload.hasSeed,
      identity: payload.hasSeed ? this.parseIdentity(payload) : null,
      ...this.parseAutomationStatus(payload),
    };
  }

  /**
   * Parse the v8 status fields. A predecessor (v7) omits all of them; normalize
   * those to inert defaults so the migration path can still read `status`.
   */
  private parseAutomationStatus(
    payload: ResponseRecord,
  ): Omit<DelegateStatus, "hasSeed" | "identity"> {
    return {
      configured: this.parseOptionalBoolean(payload.configured, "configured"),
      codeHashes:
        payload.codeHashes === undefined
          ? []
          : this.validateCodeHashes(payload.codeHashes),
      matchedCodeHash: this.parseOptionalCodeHash(
        payload.matchedCodeHash,
        "matchedCodeHash",
      ),
      address: this.parseOptionalAddress(payload.address),
      autoAdvance: this.parseOptionalBoolean(payload.autoAdvance, "autoAdvance"),
      maxAmount:
        payload.maxAmount === undefined
          ? DEFAULT_MAX_AMOUNT
          : this.validateMaxAmount(payload.maxAmount),
      subscriptions: this.parseSubscriptions(payload.subscriptions),
      lastScan: this.parseOptionalNonNegativeInteger(payload.lastScan, "lastScan"),
      lastError: this.parseOptionalError(payload.lastError),
      audit: this.parseAudit(payload.audit),
    };
  }

  private validateCodeHashes(value: unknown): string[] {
    if (!Array.isArray(value)) {
      throw new DelegateError(
        "Protocol",
        "codeHashes must be an array of base58 code hashes.",
      );
    }
    const seen = new Set<string>();
    return value.map((entry) => {
      if (typeof entry !== "string") {
        throw new DelegateError("Protocol", "codeHashes entries must be strings.");
      }
      let bytes: Uint8Array;
      try {
        bytes = bs58.decode(entry);
      } catch {
        throw new DelegateError(
          "Protocol",
          `codeHashes entry is not valid base58: ${entry}`,
        );
      }
      if (bytes.length !== 32) {
        throw new DelegateError(
          "Protocol",
          `codeHashes entry must decode to 32 bytes, got ${bytes.length}: ${entry}`,
        );
      }
      if (seen.has(entry)) {
        throw new DelegateError(
          "Protocol",
          `codeHashes contains a duplicate entry: ${entry}`,
        );
      }
      seen.add(entry);
      return entry;
    });
  }

  private validateMaxAmount(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new DelegateError(
        "Protocol",
        "maxAmount must be a non-negative safe integer (0 disables the cap).",
      );
    }
    return value;
  }

  private parseOptionalBoolean(value: unknown, field: string): boolean {
    if (value === undefined) return false;
    if (typeof value !== "boolean") {
      throw new DelegateError(
        "Protocol",
        `Delegate status response has a malformed ${field} (expected a boolean).`,
      );
    }
    return value;
  }

  private parseOptionalCodeHash(value: unknown, field: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      throw new DelegateError(
        "Protocol",
        `Delegate status response has a malformed ${field} (expected base58).`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = bs58.decode(value);
    } catch {
      throw new DelegateError(
        "Protocol",
        `Delegate status response has a malformed ${field} (not base58).`,
      );
    }
    if (bytes.length !== 32) {
      throw new DelegateError(
        "Protocol",
        `Delegate status response has a malformed ${field} (expected 32 bytes).`,
      );
    }
    return value;
  }

  private parseOptionalAddress(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !/^[0-7]*$/.test(value)) {
      throw new DelegateError(
        "Protocol",
        "Delegate status response has a malformed address (expected octal digits).",
      );
    }
    return value;
  }

  private parseSubscriptions(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new DelegateError(
        "Protocol",
        "Delegate status response has malformed subscriptions (expected an array).",
      );
    }
    return value.map((entry) => {
      if (typeof entry !== "string" || !isLowerHex(entry, 64)) {
        throw new DelegateError(
          "Protocol",
          "Delegate status response has a malformed subscription id (expected 64 lowercase hex characters).",
        );
      }
      return entry;
    });
  }

  private parseOptionalNonNegativeInteger(value: unknown, field: string): number {
    if (value === undefined) return 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new DelegateError(
        "Protocol",
        `Delegate status response has a malformed ${field} (expected a non-negative integer).`,
      );
    }
    return value;
  }

  private parseOptionalError(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      throw new DelegateError(
        "Protocol",
        "Delegate status response has a malformed lastError (expected string or null).",
      );
    }
    return value;
  }

  private parseAudit(value: unknown): DelegateAuditEntry[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new DelegateError(
        "Protocol",
        "Delegate status response has a malformed audit (expected an array).",
      );
    }
    return value.map((entry) => {
      if (!isRecord(entry)) {
        throw new DelegateError(
          "Protocol",
          "Delegate status response has a malformed audit entry.",
        );
      }
      const id = entry.id;
      const cursor = entry.cursor;
      const slots = entry.slots;
      const role = entry.role;
      if (typeof id !== "string" || id.length === 0) {
        throw new DelegateError(
          "Protocol",
          "Delegate status response has a malformed audit id.",
        );
      }
      if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) {
        throw new DelegateError(
          "Protocol",
          "Delegate status response has a malformed audit cursor.",
        );
      }
      if (
        !Array.isArray(slots) ||
        slots.some(
          (slot) =>
            typeof slot !== "number" ||
            !Number.isInteger(slot) ||
            slot < 0 ||
            slot > 7,
        )
      ) {
        throw new DelegateError(
          "Protocol",
          "Delegate status response has malformed audit slots.",
        );
      }
      if (typeof role !== "string" || role.length === 0) {
        throw new DelegateError(
          "Protocol",
          "Delegate status response has a malformed audit role.",
        );
      }
      return { id, cursor, slots: [...(slots as number[])], role };
    });
  }

  private parseExport(payload: ResponseRecord): ExportedSecrets {
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string" ? payload.error : "export was rejected",
      );
    }
    const seed = payload.seed;
    if (typeof seed !== "string" || !/^[0-9a-fA-F]{64}$/.test(seed)) {
      throw new DelegateError(
        "Protocol",
        "Delegate export response has a malformed seed (expected 64 hex characters).",
      );
    }

    return {
      payloadVersion: this.parsePayloadVersion(payload.payloadVersion),
      seed: seed.toLowerCase(),
      nextSeq: this.validateNextSeq(payload.nextSeq),
      contactsNextSeq: this.parseContactsNextSeq(payload.contactsNextSeq),
      parentNextSeq: this.parseParentNextSeq(payload.parentNextSeq),
      paymentsNextSeq: this.parsePaymentsNextSeq(payload.paymentsNextSeq),
      adjustmentsNextSeq: this.parseAdjustmentsNextSeq(
        payload.adjustmentsNextSeq,
      ),
      childNamesNextSeq: this.parseChildNamesNextSeq(payload.childNamesNextSeq),
      selfNameNextSeq: this.parseSelfNameNextSeq(payload.selfNameNextSeq),
      contacts: this.parseContactsField(payload.contacts),
    };
  }

  /** Validate a `{ok, contacts}` reply from any address-book command. */
  private parseContacts(payload: ResponseRecord): ContactRecord[] {
    if (payload.ok !== true) {
      throw classifyDelegateFailure(
        typeof payload.error === "string"
          ? payload.error
          : "contacts was rejected",
      );
    }
    return this.parseContactsField(payload.contacts);
  }

  /** A v1 export has no contacts key; an older delegate therefore lists none. */
  private parseContactsField(value: unknown): ContactRecord[] {
    if (value === undefined) return [];
    return validateContactList(value);
  }

  private parsePayloadVersion(value: unknown): number {
    if (value === undefined) return 1;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      (value !== 1 && value !== 2)
    ) {
      throw new DelegateError(
        "Protocol",
        "Delegate export response has a malformed payloadVersion (expected 1 or 2).",
      );
    }
    return value;
  }

  private validateNextSeq(value: unknown): number[] {
    if (
      !Array.isArray(value) ||
      value.length !== 8 ||
      value.some(
        (entry) =>
          typeof entry !== "number" ||
          !Number.isSafeInteger(entry) ||
          entry < 1,
      )
    ) {
      throw new DelegateError(
        "Protocol",
        "Delegate response has malformed nextSeq (expected 8 positive integers).",
      );
    }
    return [...(value as number[])];
  }

  /**
   * A v1 predecessor export has no contacts counter; default it to 1 so the
   * migrated identity can still sign its first address book.
   */
  private parseContactsNextSeq(value: unknown): number {
    if (value === undefined) return 1;
    return this.validateContactsNextSeq(value);
  }

  private validateContactsNextSeq(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new DelegateError(
        "Protocol",
        "contactsNextSeq must be a positive safe integer.",
      );
    }
    return value;
  }

  /**
   * A v4 predecessor export has no parent counter; default it to 1 so the
   * migrated identity can still sign its first parent record.
   */
  private parseParentNextSeq(value: unknown): number {
    if (value === undefined) return 1;
    return this.validateParentNextSeq(value);
  }

  private validateParentNextSeq(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new DelegateError(
        "Protocol",
        "parentNextSeq must be a positive safe integer.",
      );
    }
    return value;
  }

  /**
   * A delegate built before v4 has no payments counter; default it to 1 so the
   * migrated identity can still sign its first payments record.
   */
  private parsePaymentsNextSeq(value: unknown): number {
    if (value === undefined) return 1;
    return this.validatePaymentsNextSeq(value);
  }

  private validatePaymentsNextSeq(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new DelegateError(
        "Protocol",
        "paymentsNextSeq must be a positive safe integer.",
      );
    }
    return value;
  }

  /**
   * A delegate built before v5 has no adjustments counter; default it to 1 so
   * the migrated identity can still sign its first adjustment record.
   */
  private parseAdjustmentsNextSeq(value: unknown): number {
    if (value === undefined) return 1;
    return this.validateAdjustmentsNextSeq(value);
  }

  private validateAdjustmentsNextSeq(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new DelegateError(
        "Protocol",
        "adjustmentsNextSeq must be a positive safe integer.",
      );
    }
    return value;
  }

  /**
   * A delegate built before v9 has no childNames counter; default it to 1 so
   * the migrated identity can still sign its first child-name record.
   */
  private parseChildNamesNextSeq(value: unknown): number {
    if (value === undefined) return 1;
    return this.validateChildNamesNextSeq(value);
  }

  private validateChildNamesNextSeq(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new DelegateError(
        "Protocol",
        "childNamesNextSeq must be a positive safe integer.",
      );
    }
    return value;
  }

  /**
   * A delegate built before v9 has no selfName counter; default it to 1 so the
   * migrated identity can still sign its first self-name record.
   */
  private parseSelfNameNextSeq(value: unknown): number {
    if (value === undefined) return 1;
    return this.validateSelfNameNextSeq(value);
  }

  private validateSelfNameNextSeq(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new DelegateError(
        "Protocol",
        "selfNameNextSeq must be a positive safe integer.",
      );
    }
    return value;
  }

  private rejectAll(error: DelegateError): void {
    const pending = this.pending;
    this.pending = [];
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
  }
}
