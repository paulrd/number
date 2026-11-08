/**
 * In-memory candidate-room transport for `VITE_OFFLINE_MODE=1`.
 *
 * Offline mode has no candidate contract and no delegate, so this mirrors the
 * online transport's observable behaviour with deterministic mock signatures.
 * Nothing verifies those signatures: records keep the contract's shapes, the
 * queue/config rules come from `mergeCandidateStates`, and membership epochs
 * use the same deterministic key/blob scheme as `OfflineRoomTransport`.
 *
 * Bodies stay plaintext in offline mode (as for the room transport's legacy
 * epochs), and nothing is persisted.
 */

import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";
import {
  CandidateError,
  type CandidateAskOptions,
  type CandidateMembershipUpdateOptions,
  type CandidateTransport,
} from "./candidate-client";
import {
  CANDIDATE_MAX_MEMBERS,
  CANDIDATE_MAX_NOTE_BYTES,
  CANDIDATE_MAX_WANT_CELL_CHARS,
  latestCandidateConfig,
  latestCandidateMembership,
  mergeCandidateStates,
  textToCandidateNote,
  type CandidateConfigV1,
  type CandidateDeltaV1,
  type CandidateMembershipV1,
  type CandidateMessageV1,
  type CandidateRequestV1,
  type CandidateStateV1,
} from "./candidate-state";
import type { RoomEpochKey } from "./room-client";
import {
  ROOM_ENCRYPTED_BODY_BYTE_LIMIT,
  ROOM_LEGACY_BODY_BYTE_LIMIT,
  roomEpochKeyCache,
} from "./room-crypto";
import { bytesToHex, hexToBytes, isLowerHex } from "./util";

const encoder = new TextEncoder();

/** Structural secret blob length (`DESIGN-rooms.md` §7.3). */
const OFFLINE_SECRET_BLOB_BYTES = 93;

/** Byte-compatible stand-in for a 64-byte Ed25519 signature. */
function mockSignature(label: string): string {
  const bytes = new Uint8Array(64);
  bytes.set(
    blake3(encoder.encode(`number:candidate:offline:${label}:0`)),
    0,
  );
  bytes.set(
    blake3(encoder.encode(`number:candidate:offline:${label}:1`)),
    32,
  );
  return bytesToHex(bytes);
}

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u64le(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

/** Deterministic 32-byte stand-in for a candidate instance id. */
export function offlineCandidateRoomId(ownerId: string): string {
  return bs58.encode(
    blake3(encoder.encode(`number:candidate:offline-room:${ownerId}`)),
  );
}

/** `blake3(roomId || epoch_le || "offline")`, the offline epoch key. */
export function offlineCandidateEpochKey(
  ownerId: string,
  epoch: number,
): Uint8Array {
  return blake3(
    concat([
      bs58.decode(offlineCandidateRoomId(ownerId)),
      u64le(epoch),
      encoder.encode("offline"),
    ]),
  );
}

/** A structurally valid 93-byte blob: version || eph || nonce || ct || tag. */
function offlineSecretBlob(
  roomId: string,
  ownerId: string,
  epoch: number,
  recipient: string,
): string {
  const label = `number:candidate:offline:secret:${roomId}:${ownerId}:${epoch}:${recipient}`;
  const blob = new Uint8Array(OFFLINE_SECRET_BLOB_BYTES);
  blob[0] = 1;
  blob.set(blake3(encoder.encode(`${label}:eph`)), 1);
  blob.set(blake3(encoder.encode(`${label}:nonce`)).slice(0, 12), 33);
  blob.set(blake3(encoder.encode(`${label}:ct`)), 45);
  blob.set(blake3(encoder.encode(`${label}:tag`)).slice(0, 16), 77);
  return bytesToHex(blob);
}

function emptyCandidateState(): CandidateStateV1 {
  return {
    v: 1,
    memberships: [],
    messages: [],
    requests: [],
    dismissals: [],
    config: null,
  };
}

function validateWantCell(wantCell: string): string {
  if (
    typeof wantCell !== "string" ||
    wantCell.length > CANDIDATE_MAX_WANT_CELL_CHARS ||
    !/^[0-7]*$/.test(wantCell)
  ) {
    throw new CandidateError(
      "write",
      `candidate want_cell must be 0..${CANDIDATE_MAX_WANT_CELL_CHARS} characters from 0..7`,
    );
  }
  return wantCell;
}

export class OfflineCandidateTransport implements CandidateTransport {
  /** One lazily created room per owner id. */
  private readonly rooms = new Map<string, CandidateStateV1>();
  /** Monotone per-room request counter (mirrors a signer's unique id). */
  private readonly requestCounters = new Map<string, number>();

  constructor(private readonly ownerId: string) {}

  private stateFor(ownerId: string): CandidateStateV1 {
    let state = this.rooms.get(ownerId);
    if (state === undefined) {
      state = emptyCandidateState();
      this.rooms.set(ownerId, state);
    }
    return state;
  }

  private ownerFor(ownerId: string): string {
    return ownerId || this.ownerId;
  }

  private assertOwner(ownerId: string): string {
    const owner = this.ownerFor(ownerId);
    if (owner !== this.ownerId) {
      throw new CandidateError(
        "not-owner",
        "only the zone owner may write the candidate config or dismiss requests",
      );
    }
    return owner;
  }

  roomIdFor(ownerId: string): string {
    return offlineCandidateRoomId(this.ownerFor(ownerId));
  }

  async ensure(ownerId: string): Promise<void> {
    this.stateFor(this.ownerFor(ownerId));
  }

  async read(ownerId: string): Promise<CandidateStateV1 | null> {
    return this.stateFor(this.ownerFor(ownerId));
  }

  /**
   * One requester-signed ask. The queue is rebuilt with the contract's merge
   * rule, so re-applying the same record dedupes by derived request id.
   */
  async request(
    ownerId: string,
    options: CandidateAskOptions,
  ): Promise<CandidateStateV1> {
    const owner = this.ownerFor(ownerId);
    const wantCell = validateWantCell(options.wantCell);
    const note = textToCandidateNote(options.note);
    if (note.length / 2 > CANDIDATE_MAX_NOTE_BYTES) {
      throw new CandidateError(
        "write",
        `candidate note must be at most ${CANDIDATE_MAX_NOTE_BYTES} bytes`,
      );
    }

    const requester = this.ownerId;
    const time = Date.now();
    const counter = (this.requestCounters.get(owner) ?? 0) + 1;
    this.requestCounters.set(owner, counter);
    const record: CandidateRequestV1 = {
      requester,
      want_cell: wantCell,
      time,
      note,
      sig: mockSignature(
        `request:${requester}:${time}:${wantCell}:${note}:${counter}`,
      ),
    };
    return this.applyDelta(owner, { v: 1, requests: [record] });
  }

  /** Owner-only accepting flag write, monotone in `seq`. */
  async setAccepting(
    ownerId: string,
    accepting: boolean,
  ): Promise<CandidateStateV1> {
    const owner = this.assertOwner(ownerId);
    const state = this.stateFor(owner);
    const latest = latestCandidateConfig(state);
    const seq = (latest?.seq ?? 0) + 1;
    const config: CandidateConfigV1 = {
      seq,
      accepting,
      sig: mockSignature(`config:${owner}:${seq}:${accepting}`),
    };
    return this.applyDelta(owner, { v: 1, config });
  }

  /** Owner-only dismissal of one request id. */
  async dismiss(
    ownerId: string,
    requestId: string,
  ): Promise<CandidateStateV1> {
    const owner = this.assertOwner(ownerId);
    if (!isLowerHex(requestId, 32)) {
      throw new CandidateError(
        "write",
        "candidate request id must be 32 lowercase hex characters",
      );
    }
    return this.applyDelta(owner, {
      v: 1,
      dismissals: [
        { id: requestId, sig: mockSignature(`dismissal:${owner}:${requestId}`) },
      ],
    });
  }

  async updateMembership(
    ownerId: string,
    members: string[],
    options: CandidateMembershipUpdateOptions = {},
  ): Promise<CandidateStateV1> {
    const owner = this.ownerFor(ownerId);
    const normalized = this.normalizeMembers(owner, members);
    const state = this.stateFor(owner);
    const latest = latestCandidateMembership(state);
    const seq = (latest?.seq ?? 0) + 1;
    const encrypt = options.encrypt ?? (latest?.secrets.length ?? 0) > 0;

    const sealed = encrypt
      ? await this.sealEpoch(owner, seq, normalized)
      : null;
    const record: CandidateMembershipV1 = {
      seq,
      members: normalized,
      secrets: sealed?.secrets ?? [],
      sig: mockSignature(
        `membership:${owner}:${seq}:${normalized.join(",")}:${
          sealed?.epochKey ? bytesToHex(sealed.epochKey) : "plaintext"
        }`,
      ),
    };
    return this.applyDelta(owner, { v: 1, memberships: [record] });
  }

  async sendMessage(
    ownerId: string,
    bodyBytes: Uint8Array,
  ): Promise<CandidateStateV1> {
    const owner = this.ownerFor(ownerId);
    const state = this.stateFor(owner);
    const latest = latestCandidateMembership(state);
    const author = this.ownerId;
    if (!latest || !latest.members.includes(author)) {
      throw new CandidateError(
        "not-member",
        "the sender is not a member of the latest candidate epoch",
      );
    }

    const epoch = latest.seq;
    const max =
      latest.secrets.length > 0
        ? ROOM_ENCRYPTED_BODY_BYTE_LIMIT
        : ROOM_LEGACY_BODY_BYTE_LIMIT;
    if (bodyBytes.length < 1 || bodyBytes.length > max) {
      throw new CandidateError(
        "write",
        `candidate message body must be 1..${max} bytes in this epoch`,
      );
    }

    const seq = this.nextSeq(state, author);
    const time = Date.now();
    const body = bytesToHex(bodyBytes);
    const message: CandidateMessageV1 = {
      author,
      epoch,
      seq,
      time,
      body,
      sig: mockSignature(
        `message:${author}:${epoch}:${seq}:${time}:${body}`,
      ),
    };
    return this.applyDelta(owner, { v: 1, messages: [message] });
  }

  async sealEpoch(
    ownerId: string,
    epoch: number,
    members: string[],
  ): Promise<RoomEpochKey> {
    const owner = this.ownerFor(ownerId);
    const roomId = offlineCandidateRoomId(owner);
    const epochKey = offlineCandidateEpochKey(owner, epoch);
    roomEpochKeyCache.set(roomId, epoch, epochKey);
    return {
      epochKey,
      secrets: members.map((recipient) => ({
        recipient,
        blob: offlineSecretBlob(roomId, owner, epoch, recipient),
      })),
      nextMembershipSeq: epoch,
    };
  }

  async openEpoch(
    ownerId: string,
    epoch: number,
    blob: string,
  ): Promise<Uint8Array> {
    const owner = this.ownerFor(ownerId);
    let bytes: Uint8Array;
    try {
      bytes = hexToBytes(blob);
    } catch {
      throw new CandidateError(
        "crypto",
        "offline candidate secret is not valid hex",
      );
    }
    if (bytes.length !== OFFLINE_SECRET_BLOB_BYTES || bytes[0] !== 0x01) {
      throw new CandidateError(
        "crypto",
        "offline candidate secret is not a 93-byte version-1 blob",
      );
    }
    const key = offlineCandidateEpochKey(owner, epoch);
    roomEpochKeyCache.set(offlineCandidateRoomId(owner), epoch, key);
    return key;
  }

  async epochKeyFor(
    ownerId: string,
    membership: CandidateMembershipV1,
  ): Promise<Uint8Array | null> {
    if (membership.secrets.length === 0) return null;
    if (!membership.secrets.some((entry) => entry.recipient === this.ownerId)) {
      return null;
    }
    const owner = this.ownerFor(ownerId);
    const roomId = offlineCandidateRoomId(owner);
    const cached = roomEpochKeyCache.get(roomId, membership.seq);
    if (cached !== null) return cached;
    const key = offlineCandidateEpochKey(owner, membership.seq);
    roomEpochKeyCache.set(roomId, membership.seq, key);
    return key;
  }

  close(): void {
    // Memory-only; keep the state so a manual reconnect is a no-op.
  }

  /**
   * Apply one delta through the same join the contract uses. This keeps
   * request dedupe, dismissal filtering, epoch membership and the per-list
   * caps identical to online mode.
   */
  private applyDelta(
    ownerId: string,
    delta: CandidateDeltaV1,
  ): CandidateStateV1 {
    const next = mergeCandidateStates(this.stateFor(ownerId), {
      v: 1,
      memberships: delta.memberships ?? [],
      messages: delta.messages ?? [],
      requests: delta.requests ?? [],
      dismissals: delta.dismissals ?? [],
      config: delta.config ?? null,
    });
    this.rooms.set(ownerId, next);
    return next;
  }

  private normalizeMembers(ownerId: string, members: string[]): string[] {
    if (!Array.isArray(members)) {
      throw new CandidateError("write", "candidate members must be an array");
    }
    const unique = sortedUnique(members);
    if (unique.length < 1 || unique.length > CANDIDATE_MAX_MEMBERS) {
      throw new CandidateError(
        "write",
        `candidate membership must contain 1..${CANDIDATE_MAX_MEMBERS} members`,
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

  private nextSeq(state: CandidateStateV1, author: string): number {
    let max = 0;
    for (const message of state.messages) {
      if (message.author === author && message.seq > max) max = message.seq;
    }
    return max + 1;
  }
}
