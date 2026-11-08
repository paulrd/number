/**
 * Candidates-room client (`DESIGN-candidates.md`, P4c).
 *
 * The candidate room is a standalone parameterised contract:
 *
 *   parameters  = b"ZCR1" || owner_vk            // 36 bytes
 *   instance_id = BLAKE3(code_hash_bytes || parameters)
 *
 * The code hash is pinned at build time (`__CANDIDATE_CODE_HASH__`); a room is
 * never derived from a fetched WASM. The client owns its own WebSocket
 * connection to the node's contract endpoint and talks to the candidate
 * contract directly. The delegate is only used for signing.
 */

import { blake3 } from "@noble/hashes/blake3";
import {
  FreenetRoomConnection,
  type RoomConnection,
  type RoomEpochKey,
  type RoomSigner,
} from "./room-client";
import {
  decodeCodeHash,
  deriveContractKey,
  deriveContractKeyTFromParts,
  deriveInstanceIdFromBytes,
  encodeBase58,
} from "./freenet";
import {
  CANDIDATE_MAX_NOTE_BYTES,
  candidateRequestId,
  encodeCandidateDelta,
  encodeCandidateState,
  latestCandidateConfig,
  latestCandidateMembership,
  parseCandidateState,
  textToCandidateNote,
  type CandidateDeltaV1,
  type CandidateMembershipV1,
  type CandidateMessageV1,
  type CandidateRequestV1,
  type CandidateStateV1,
} from "./candidate-state";
import {
  ROOM_ENCRYPTED_BODY_BYTE_LIMIT,
  ROOM_LEGACY_BODY_BYTE_LIMIT,
  encryptRoomBody,
  roomEpochKeyCache,
} from "./room-crypto";
import type {
  CandidateConfigSignRequest,
  CandidateDismissalSignRequest,
  CandidateRequestSignRequest,
  OpenedRoomSecret,
  SealedRoomEpoch,
  SignedCandidateConfig,
  SignedCandidateDismissal,
  SignedCandidateRequest,
} from "./delegate";
import { bytesToHex, errorMessage, hexToBytes, isLowerHex } from "./util";
import type { ContractKeyT } from "@freenetorg/freenet-stdlib/common";
import type { ContractKey } from "@freenetorg/freenet-stdlib";

const CANDIDATE_TAG = "ZCR1";
const CANDIDATE_TAG_BYTES = new Uint8Array([0x5a, 0x43, 0x52, 0x31]);
const CANDIDATE_PARAMETERS_LEN = 36;
const SIGNATURE_HEX_LEN = 128;

export type CandidateErrorCode =
  | "config"
  | "connection"
  | "read"
  | "write"
  | "sign"
  | "crypto"
  | "not-member"
  | "not-owner"
  | "wasm";

export class CandidateError extends Error {
  readonly code: CandidateErrorCode;

  constructor(code: CandidateErrorCode, message: string) {
    super(message);
    this.name = "CandidateError";
    this.code = code;
  }
}

function wrapCandidateError(
  code: CandidateErrorCode,
  error: unknown,
): CandidateError {
  if (error instanceof CandidateError) return error;
  return new CandidateError(code, errorMessage(error));
}

function candidateCodeHashBase58(): string {
  return typeof __CANDIDATE_CODE_HASH__ === "string"
    ? __CANDIDATE_CODE_HASH__
    : "";
}

function candidateCodeHashBytes(): Uint8Array {
  const injected =
    typeof __CANDIDATE_CODE_HASH_BYTES__ === "undefined"
      ? []
      : __CANDIDATE_CODE_HASH_BYTES__;
  return Uint8Array.from(Array.isArray(injected) ? injected : []);
}

function candidateWasmUrl(): string {
  return typeof __CANDIDATE_WASM_URL__ === "string" && __CANDIDATE_WASM_URL__
    ? __CANDIDATE_WASM_URL__
    : "./number_candidate.wasm";
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Signer surface the candidate client needs. */
export interface CandidateSigner extends RoomSigner {
  signCandidateRequest(
    request: CandidateRequestSignRequest,
  ): Promise<SignedCandidateRequest>;
  signCandidateDismissal(
    request: CandidateDismissalSignRequest,
  ): Promise<SignedCandidateDismissal>;
  signCandidateConfig(
    request: CandidateConfigSignRequest,
  ): Promise<SignedCandidateConfig>;
}

/** Options for a candidate membership write. */
export interface CandidateMembershipUpdateOptions {
  /**
   * Seal fresh epoch secrets for the new membership. Defaults to true when the
   * latest membership is already encrypted, false for a plaintext room.
   */
  encrypt?: boolean;
}

/** Options for a public ask request. `note` is UTF-8 text. */
export interface CandidateAskOptions {
  /** Deepest zone-address cell, 0..32 characters from `0`..`7`. */
  wantCell: string;
  /** Opaque note text; encoded as lowercase hex and capped at 256 bytes. */
  note: string;
}

/** b"ZCR1" || owner_vk (36 bytes). */
export function candidateParameters(ownerId: string): Uint8Array {
  if (!isLowerHex(ownerId, 64)) {
    throw new CandidateError(
      "config",
      "candidate owner must be 64 lowercase hex characters",
    );
  }
  const parameters = new Uint8Array(CANDIDATE_PARAMETERS_LEN);
  parameters.set(CANDIDATE_TAG_BYTES, 0);
  parameters.set(hexToBytes(ownerId), 4);
  return parameters;
}

/**
 * Derive the candidate room's instance id and both key forms.
 *
 * `codeHashBase58` is injectable for tests; production always uses the
 * build-time pinned hash.
 */
export function candidateInstanceId(
  ownerId: string,
  codeHashBase58: string = candidateCodeHashBase58(),
): { id: string; key: ContractKey; keyT: ContractKeyT } {
  if (!codeHashBase58) {
    throw new CandidateError(
      "config",
      "candidate code hash is missing; rebuild the UI through scripts/build.sh",
    );
  }
  let codeHashBytes: Uint8Array;
  try {
    codeHashBytes = decodeCodeHash(codeHashBase58);
  } catch (error) {
    throw new CandidateError("config", errorMessage(error));
  }
  const parameters = candidateParameters(ownerId);
  const instance = deriveInstanceIdFromBytes(codeHashBytes, parameters);
  return {
    id: instance.base58,
    key: deriveContractKey(codeHashBase58, parameters),
    keyT: deriveContractKeyTFromParts(codeHashBytes, parameters),
  };
}

export interface CandidateTransport {
  read(ownerId: string): Promise<CandidateStateV1 | null>;
  /** Create the instance from the bundled raw WASM when it is absent. */
  ensure(ownerId: string): Promise<void>;
  /** Write one requester-signed ask and confirm it landed. */
  request(
    ownerId: string,
    options: CandidateAskOptions,
  ): Promise<CandidateStateV1>;
  /** Owner-only accepting flag write, monotone in `seq`. */
  setAccepting(
    ownerId: string,
    accepting: boolean,
  ): Promise<CandidateStateV1>;
  /** Owner-only dismissal of one request id. */
  dismiss(
    ownerId: string,
    requestId: string,
  ): Promise<CandidateStateV1>;
  updateMembership(
    ownerId: string,
    members: string[],
    options?: CandidateMembershipUpdateOptions,
  ): Promise<CandidateStateV1>;
  sendMessage(ownerId: string, body: Uint8Array): Promise<CandidateStateV1>;
  /** Seal a fresh epoch key for `members` with tag `ZCR1`. */
  sealEpoch(
    ownerId: string,
    epoch: number,
    members: string[],
  ): Promise<RoomEpochKey>;
  /** Open one owner-signed secret blob for the local viewer. */
  openEpoch(
    ownerId: string,
    epoch: number,
    blob: string,
  ): Promise<Uint8Array>;
  /** Cached epoch key for `membership`, opening the viewer's own blob on demand. */
  epochKeyFor(
    ownerId: string,
    membership: CandidateMembershipV1,
  ): Promise<Uint8Array | null>;
  /** Base58 candidate room id used in body/secret AAD (32 decoded bytes). */
  roomIdFor(ownerId: string): string;
  close(): void;
}

export interface OnlineCandidateTransportOptions {
  /** Injected transport for tests; production creates a WebSocket connection. */
  connection?: RoomConnection;
  /** Build-time pinned code hash; defaults to `__CANDIDATE_CODE_HASH__`. */
  codeHashBase58?: string;
  /** Build-time pinned code hash bytes; defaults to `__CANDIDATE_CODE_HASH_BYTES__`. */
  codeHashBytes?: Uint8Array;
  /** Bundled raw WASM URL; defaults to `__CANDIDATE_WASM_URL__`. */
  wasmUrl?: string;
}

/** The shared connection type already filters one contract key per instance. */
export type CandidateConnection = RoomConnection;

export class OnlineCandidateTransport implements CandidateTransport {
  private readonly codeHashBase58: string;
  private readonly codeHashBytes: Uint8Array;
  private readonly wasmUrl: string;
  private connection: RoomConnection | null;

  constructor(
    private readonly signer: CandidateSigner,
    options: OnlineCandidateTransportOptions = {},
  ) {
    this.codeHashBase58 =
      options.codeHashBase58 ?? candidateCodeHashBase58();
    if (options.codeHashBytes) {
      this.codeHashBytes = Uint8Array.from(options.codeHashBytes);
    } else if (options.codeHashBase58) {
      try {
        this.codeHashBytes = decodeCodeHash(options.codeHashBase58);
      } catch (error) {
        throw new CandidateError("config", errorMessage(error));
      }
    } else {
      this.codeHashBytes = candidateCodeHashBytes();
    }
    this.codeHashBase58 =
      this.codeHashBase58 ||
      (this.codeHashBytes.length === 32 ? encodeBase58(this.codeHashBytes) : "");
    this.wasmUrl = options.wasmUrl ?? candidateWasmUrl();
    this.connection = options.connection ?? null;
  }

  /**
   * Ensure the candidate instance exists. A missing instance is created by
   * PUTting the bundled raw WASM (verified against the pinned hash) with the
   * static empty v1 state.
   */
  async ensure(ownerId: string): Promise<void> {
    const existing = await this.read(ownerId);
    if (existing) return;

    if (this.codeHashBytes.length !== 32) {
      throw new CandidateError(
        "wasm",
        "candidate code hash bytes are missing; rebuild the UI through scripts/build.sh",
      );
    }

    let wasm: Uint8Array;
    try {
      const response = await fetch(this.wasmUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      wasm = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new CandidateError(
        "wasm",
        `could not load the candidate WASM from ${this.wasmUrl}: ${errorMessage(error)}`,
      );
    }

    if (wasm.length === 0) {
      throw new CandidateError("wasm", `${this.wasmUrl} is empty`);
    }
    if (!equalBytes(blake3(wasm), this.codeHashBytes)) {
      throw new CandidateError(
        "wasm",
        `the bundled ${this.wasmUrl} does not match the pinned candidate code hash; ` +
          "rebuild the candidate and the UI",
      );
    }

    const parameters = candidateParameters(ownerId);
    const initialState = encodeCandidateState({
      v: 1,
      memberships: [],
      messages: [],
      requests: [],
      dismissals: [],
      config: null,
    });
    try {
      await this.connectionOrCreate().put(parameters, wasm, initialState);
    } catch (error) {
      throw wrapCandidateError("write", error);
    }
  }

  async read(ownerId: string): Promise<CandidateStateV1 | null> {
    const parameters = candidateParameters(ownerId);
    let bytes: Uint8Array | null;
    try {
      bytes = await this.connectionOrCreate().get(parameters);
    } catch (error) {
      throw wrapCandidateError("connection", error);
    }
    if (bytes === null) return null;
    try {
      return parseCandidateState(bytes);
    } catch (error) {
      throw new CandidateError("read", errorMessage(error));
    }
  }

  /**
   * Write one requester-signed ask (a one-request delta) and re-read to confirm
   * the derived request id is present. The contract skips invalid deltas, so an
   * accepted UPDATE is not proof.
   */
  async request(
    ownerId: string,
    options: CandidateAskOptions,
  ): Promise<CandidateStateV1> {
    const note = textToCandidateNote(options.note);
    if (note.length / 2 > CANDIDATE_MAX_NOTE_BYTES) {
      throw new CandidateError(
        "write",
        `candidate note must be at most ${CANDIDATE_MAX_NOTE_BYTES} bytes`,
      );
    }
    await this.ensure(ownerId);
    const time = Date.now();

    let signed: SignedCandidateRequest;
    try {
      signed = await this.signer.signCandidateRequest({
        owner: ownerId,
        time,
        wantCell: options.wantCell,
        note,
      });
    } catch (error) {
      throw wrapCandidateError("sign", error);
    }
    if (!isLowerHex(signed.requester, 64)) {
      throw new CandidateError(
        "sign",
        "delegate returned a malformed candidate requester",
      );
    }
    if (!isLowerHex(signed.requestId, 32)) {
      throw new CandidateError(
        "sign",
        "delegate returned a malformed candidate request id",
      );
    }
    if (!isLowerHex(signed.sig, SIGNATURE_HEX_LEN)) {
      throw new CandidateError(
        "sign",
        "delegate returned a malformed candidate request signature",
      );
    }

    const record: CandidateRequestV1 = {
      requester: signed.requester,
      want_cell: options.wantCell,
      time,
      note,
      sig: signed.sig,
    };
    if (candidateRequestId(record) !== signed.requestId) {
      throw new CandidateError(
        "sign",
        "delegate returned a candidate request id that does not match the signature",
      );
    }
    await this.sendDelta(ownerId, { v: 1, requests: [record] });

    const after = await this.read(ownerId);
    if (!after) {
      throw new CandidateError(
        "read",
        "candidate state is unavailable after the request",
      );
    }
    if (
      !after.requests.some(
        (item) => candidateRequestId(item) === signed.requestId,
      )
    ) {
      throw new CandidateError(
        "write",
        "the candidate contract did not accept the request",
      );
    }
    return after;
  }

  /**
   * Owner-only accepting flag write. `seq = (latest config seq ?? 0) + 1`;
   * merge keeps the greatest `(seq, sig)`.
   */
  async setAccepting(
    ownerId: string,
    accepting: boolean,
  ): Promise<CandidateStateV1> {
    this.assertOwner(ownerId);
    await this.ensure(ownerId);
    const current = await this.read(ownerId);
    if (!current) {
      throw new CandidateError(
        "read",
        "candidate state is unavailable after ensure()",
      );
    }
    const latest = latestCandidateConfig(current);
    const seq = (latest?.seq ?? 0) + 1;

    let signed: SignedCandidateConfig;
    try {
      signed = await this.signer.signCandidateConfig({
        owner: ownerId,
        seq,
        accepting,
      });
    } catch (error) {
      throw wrapCandidateError("sign", error);
    }
    if (signed.seq !== seq) {
      throw new CandidateError(
        "sign",
        `delegate signed candidate config seq ${String(signed.seq)}, expected ${seq}`,
      );
    }
    if (!isLowerHex(signed.sig, SIGNATURE_HEX_LEN)) {
      throw new CandidateError(
        "sign",
        "delegate returned a malformed candidate config signature",
      );
    }

    await this.sendDelta(ownerId, {
      v: 1,
      config: { seq, accepting, sig: signed.sig },
    });
    const after = await this.read(ownerId);
    if (!after) {
      throw new CandidateError(
        "read",
        "candidate state is unavailable after the config write",
      );
    }
    if (after.config?.seq !== seq || after.config.sig !== signed.sig) {
      throw new CandidateError(
        "write",
        `candidate config seq ${seq} was not accepted by the contract`,
      );
    }
    return after;
  }

  /** Owner-only dismissal of one request id; confirmed against a re-read. */
  async dismiss(
    ownerId: string,
    requestId: string,
  ): Promise<CandidateStateV1> {
    this.assertOwner(ownerId);
    if (!isLowerHex(requestId, 32)) {
      throw new CandidateError(
        "write",
        "candidate request id must be 32 lowercase hex characters",
      );
    }
    await this.ensure(ownerId);

    let signed: SignedCandidateDismissal;
    try {
      signed = await this.signer.signCandidateDismissal({
        owner: ownerId,
        id: requestId,
      });
    } catch (error) {
      throw wrapCandidateError("sign", error);
    }
    if (signed.id !== requestId) {
      throw new CandidateError(
        "sign",
        "delegate signed a different candidate request id",
      );
    }
    if (!isLowerHex(signed.sig, SIGNATURE_HEX_LEN)) {
      throw new CandidateError(
        "sign",
        "delegate returned a malformed candidate dismissal signature",
      );
    }

    await this.sendDelta(ownerId, {
      v: 1,
      dismissals: [{ id: requestId, sig: signed.sig }],
    });
    const after = await this.read(ownerId);
    if (!after) {
      throw new CandidateError(
        "read",
        "candidate state is unavailable after the dismissal",
      );
    }
    const applied = after.dismissals.find((item) => item.id === requestId);
    if (!applied || applied.sig !== signed.sig) {
      throw new CandidateError(
        "write",
        "the candidate contract did not accept the dismissal",
      );
    }
    if (after.requests.some((item) => candidateRequestId(item) === requestId)) {
      throw new CandidateError(
        "write",
        "the dismissed candidate request is still present in the state",
      );
    }
    return after;
  }

  /**
   * Publish membership `max(latest.seq + 1, nextMembershipSeq)`. When the epoch
   * is encrypted (or `encrypt` is requested) the delegate seals a fresh key
   * with the `ZCR1` tag first; the signature covers the same members/secrets.
   */
  async updateMembership(
    ownerId: string,
    members: string[],
    options: CandidateMembershipUpdateOptions = {},
  ): Promise<CandidateStateV1> {
    const normalized = this.normalizeMembers(ownerId, members);
    await this.ensure(ownerId);
    const current = await this.read(ownerId);
    if (!current) {
      throw new CandidateError(
        "read",
        "candidate state is unavailable after ensure()",
      );
    }

    const latest = latestCandidateMembership(current);
    const encrypt = options.encrypt ?? (latest?.secrets.length ?? 0) > 0;
    const roomId = this.instanceId(ownerId);
    const provisionalSeq = (latest?.seq ?? 0) + 1;

    let seq = provisionalSeq;
    let secrets: CandidateMembershipV1["secrets"] = [];

    if (encrypt) {
      let sealed = await this.sealEpoch(ownerId, provisionalSeq, normalized);
      seq = Math.max(provisionalSeq, sealed.nextMembershipSeq);
      if (seq !== provisionalSeq) {
        sealed = await this.sealEpoch(ownerId, seq, normalized);
        seq = Math.max(seq, sealed.nextMembershipSeq);
      }
      secrets = sealed.secrets;
      roomEpochKeyCache.set(roomId, seq, sealed.epochKey);
    }

    let sig: string;
    try {
      sig = await this.signer.signRoomMembership({
        roomId,
        owner: ownerId,
        tag: CANDIDATE_TAG,
        seq,
        members: normalized,
        secrets,
      });
    } catch (error) {
      throw wrapCandidateError("sign", error);
    }
    if (!isLowerHex(sig, SIGNATURE_HEX_LEN)) {
      throw new CandidateError(
        "sign",
        "delegate returned a malformed candidate membership signature",
      );
    }

    const record: CandidateMembershipV1 = {
      seq,
      members: normalized,
      secrets,
      sig,
    };
    await this.sendDelta(ownerId, { v: 1, memberships: [record] });

    const after = await this.read(ownerId);
    if (!after) {
      throw new CandidateError(
        "read",
        "candidate state is unavailable after the update",
      );
    }
    const applied = after.memberships.find((item) => item.seq === seq);
    if (!applied || applied.sig !== sig) {
      throw new CandidateError(
        "write",
        `candidate membership seq ${seq} was not accepted by the contract`,
      );
    }
    return after;
  }

  /**
   * Publish one message at the latest membership epoch. In an encrypted epoch
   * the body is AES-GCM sealed with the cached epoch key and the `ZCR1` AAD.
   */
  async sendMessage(
    ownerId: string,
    body: Uint8Array,
  ): Promise<CandidateStateV1> {
    await this.ensure(ownerId);
    const current = await this.read(ownerId);
    if (!current) {
      throw new CandidateError(
        "read",
        "candidate state is unavailable after ensure()",
      );
    }
    const latest = latestCandidateMembership(current);
    if (!latest || !latest.members.includes(ownerId)) {
      throw new CandidateError(
        "not-member",
        "the candidate room owner is not a member of the latest epoch",
      );
    }

    const epoch = latest.seq;
    const encrypted = latest.secrets.length > 0;
    const roomId = this.instanceId(ownerId);
    let author = ownerId;
    let bodyHex: string;

    if (encrypted) {
      if (!this.canEncrypt()) {
        throw new CandidateError(
          "crypto",
          "this delegate cannot send encrypted candidate messages; update the delegate to v12",
        );
      }
      if (body.length < 1 || body.length > ROOM_ENCRYPTED_BODY_BYTE_LIMIT) {
        throw new CandidateError(
          "write",
          `encrypted candidate plaintext must be 1..${ROOM_ENCRYPTED_BODY_BYTE_LIMIT} bytes`,
        );
      }
      const signedIn = this.signer.authorId?.() ?? null;
      if (signedIn === null) {
        throw new CandidateError(
          "crypto",
          "the local delegate identity is unavailable before sending",
        );
      }
      author = signedIn;
      const key =
        roomEpochKeyCache.get(roomId, epoch) ??
        (await this.epochKeyFor(ownerId, latest));
      if (key === null) {
        throw new CandidateError(
          "crypto",
          "this key has no epoch secret for the current membership",
        );
      }
      let envelope: Uint8Array;
      try {
        envelope = await encryptRoomBody(
          key,
          { roomId, owner: ownerId, author, epoch, tag: CANDIDATE_TAG },
          new TextDecoder("utf-8", { fatal: false }).decode(body),
        );
      } catch (error) {
        throw wrapCandidateError("crypto", error);
      }
      bodyHex = bytesToHex(envelope);
    } else {
      if (body.length < 1 || body.length > ROOM_LEGACY_BODY_BYTE_LIMIT) {
        throw new CandidateError(
          "write",
          `candidate message body must be 1..${ROOM_LEGACY_BODY_BYTE_LIMIT} bytes`,
        );
      }
      bodyHex = bytesToHex(body);
    }

    const time = Date.now();

    let signed: { author: string; seq: number; sig: string };
    try {
      signed = await this.signer.signRoomMessage({
        roomId,
        owner: ownerId,
        tag: CANDIDATE_TAG,
        epoch,
        time,
        body: bodyHex,
      });
    } catch (error) {
      throw wrapCandidateError("sign", error);
    }
    if (!isLowerHex(signed.author, 64)) {
      throw new CandidateError(
        "sign",
        "delegate returned a malformed candidate message author",
      );
    }
    if (encrypted && signed.author !== author) {
      throw new CandidateError(
        "sign",
        "the delegate signed as a different key than the epoch secret's recipient",
      );
    }
    if (!Number.isSafeInteger(signed.seq) || signed.seq <= 0) {
      throw new CandidateError(
        "sign",
        "delegate returned an invalid candidate message seq",
      );
    }
    if (!isLowerHex(signed.sig, SIGNATURE_HEX_LEN)) {
      throw new CandidateError(
        "sign",
        "delegate returned a malformed candidate message signature",
      );
    }

    const message: CandidateMessageV1 = {
      author: signed.author,
      epoch,
      seq: signed.seq,
      time,
      body: bodyHex,
      sig: signed.sig,
    };
    await this.sendDelta(ownerId, { v: 1, messages: [message] });

    const after = await this.read(ownerId);
    if (!after) {
      throw new CandidateError(
        "read",
        "candidate state is unavailable after the message",
      );
    }
    if (!after.messages.some((item) => item.sig === signed.sig)) {
      throw new CandidateError(
        "write",
        "the candidate contract did not accept the message; check membership and epoch",
      );
    }
    return after;
  }

  /** Delegate v12+: sealed epochs are available on this signer. */
  private canEncrypt(): boolean {
    const version = this.signer.delegateVersion?.() ?? 0;
    return (
      version >= 12 &&
      typeof this.signer.sealRoomEpoch === "function" &&
      typeof this.signer.openRoomSecret === "function"
    );
  }

  async sealEpoch(
    ownerId: string,
    epoch: number,
    members: string[],
  ): Promise<RoomEpochKey> {
    if (!this.canEncrypt()) {
      throw new CandidateError(
        "crypto",
        "this delegate cannot seal candidate epochs; update the delegate to v12",
      );
    }
    const roomId = this.instanceId(ownerId);
    let sealed: SealedRoomEpoch;
    try {
      sealed = await this.signer.sealRoomEpoch!({
        roomId,
        owner: ownerId,
        tag: CANDIDATE_TAG,
        epoch,
        members,
      });
    } catch (error) {
      throw wrapCandidateError("sign", error);
    }
    roomEpochKeyCache.set(roomId, epoch, sealed.epochKey);
    return {
      epochKey: sealed.epochKey,
      secrets: sealed.secrets,
      nextMembershipSeq: sealed.nextMembershipSeq,
    };
  }

  async openEpoch(
    ownerId: string,
    epoch: number,
    blob: string,
  ): Promise<Uint8Array> {
    if (!this.canEncrypt()) {
      throw new CandidateError(
        "crypto",
        "this delegate cannot open candidate epochs; update the delegate to v12",
      );
    }
    const roomId = this.instanceId(ownerId);
    let opened: OpenedRoomSecret;
    try {
      opened = await this.signer.openRoomSecret!({
        roomId,
        owner: ownerId,
        tag: CANDIDATE_TAG,
        epoch,
        blob,
      });
    } catch (error) {
      throw wrapCandidateError("sign", error);
    }
    roomEpochKeyCache.set(roomId, epoch, opened.epochKey);
    return opened.epochKey;
  }

  async epochKeyFor(
    ownerId: string,
    membership: CandidateMembershipV1,
  ): Promise<Uint8Array | null> {
    const roomId = this.instanceId(ownerId);
    const cached = roomEpochKeyCache.get(roomId, membership.seq);
    if (cached !== null) return cached;
    if (membership.secrets.length === 0) return null;

    const author = this.signer.authorId?.() ?? null;
    if (author === null) return null;
    const secret = membership.secrets.find(
      (entry) => entry.recipient === author,
    );
    if (!secret) return null;
    return this.openEpoch(ownerId, membership.seq, secret.blob);
  }

  roomIdFor(ownerId: string): string {
    return this.instanceId(ownerId);
  }

  close(): void {
    this.connection?.close();
  }

  private assertOwner(ownerId: string): void {
    const local = this.signer.authorId?.() ?? null;
    if (local !== null && local !== ownerId) {
      throw new CandidateError(
        "not-owner",
        "only the zone owner may write the candidate config or dismiss requests",
      );
    }
  }

  private async sendDelta(
    ownerId: string,
    delta: CandidateDeltaV1,
  ): Promise<void> {
    const parameters = candidateParameters(ownerId);
    try {
      await this.connectionOrCreate().update(
        parameters,
        encodeCandidateDelta(delta),
      );
    } catch (error) {
      throw wrapCandidateError("write", error);
    }
  }

  private normalizeMembers(ownerId: string, members: string[]): string[] {
    if (!Array.isArray(members)) {
      throw new CandidateError("write", "candidate members must be an array");
    }
    const unique = [...new Set(members)];
    unique.sort();
    if (unique.length < 1 || unique.length > 9) {
      throw new CandidateError(
        "write",
        "candidate membership must contain 1..9 members",
      );
    }
    for (const member of unique) {
      if (!isLowerHex(member, 64)) {
        throw new CandidateError(
          "write",
          "candidate members must be 64 lowercase hex characters",
        );
      }
    }
    if (!unique.includes(ownerId)) {
      throw new CandidateError(
        "not-member",
        "candidate membership must include the room owner",
      );
    }
    return unique;
  }

  private instanceId(ownerId: string): string {
    return candidateInstanceId(ownerId, this.codeHashBase58).id;
  }

  private connectionOrCreate(): RoomConnection {
    if (!this.connection) {
      if (!this.codeHashBase58) {
        throw new CandidateError(
          "config",
          "candidate code hash is missing; rebuild the UI through scripts/build.sh",
        );
      }
      this.connection = new FreenetRoomConnection(this.codeHashBase58);
    }
    return this.connection;
  }
}
