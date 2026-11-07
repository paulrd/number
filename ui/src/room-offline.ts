/**
 * In-memory members-room transport for `VITE_OFFLINE_MODE=1`.
 *
 * Offline mode has no room contract and no delegate, so this mirrors the
 * online transport's observable behaviour with deterministic mock signatures.
 * Nothing verifies those signatures, but the panel treats the state as real:
 * the records keep the contract's shapes, the membership seq advances, and
 * messages stay capped at 200.
 *
 * P3c adds deterministic epoch crypto: `sealEpoch` derives a key from the room
 * id and epoch instead of the delegate's X25519 seal, returns structurally
 * valid 93-byte blobs, and the body envelope is the same AES-GCM one the
 * online transport writes. Nothing is persisted.
 */

import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";
import {
  RoomError,
  type RoomEpochKey,
  type RoomMembershipUpdateOptions,
  type RoomTransport,
} from "./room-client";
import {
  ROOM_ENCRYPTED_BODY_BYTE_LIMIT,
  encryptRoomBody,
  roomEpochKeyCache,
} from "./room-crypto";
import {
  ROOM_MAX_BODY_BYTES,
  ROOM_MAX_MESSAGES,
  latestMembership,
  roomMessageId,
  textToRoomBody,
  type RoomMembershipV1,
  type RoomMessageV1,
  type RoomStateV1,
} from "./room-state";
import { bytesToHex, hexToBytes } from "./util";

const encoder = new TextEncoder();

/** Fixed seed time so the seeded message is stable across offline reloads. */
export const OFFLINE_ROOM_WELCOME_TIME = 1_762_500_000_000;

/** Structural secret blob length (`DESIGN-rooms.md` §7.3). */
const OFFLINE_SECRET_BLOB_BYTES = 93;

/** Byte-compatible stand-in for a 64-byte Ed25519 signature. */
function mockSignature(label: string): string {
  const bytes = new Uint8Array(64);
  bytes.set(blake3(encoder.encode(`number:room:offline:${label}:0`)), 0);
  bytes.set(blake3(encoder.encode(`number:room:offline:${label}:1`)), 32);
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

/** Deterministic 32-byte stand-in for a room instance id in offline mode. */
export function offlineRoomId(ownerId: string): string {
  return bs58.encode(
    blake3(encoder.encode(`number:room:offline-room:${ownerId}`)),
  );
}

/** `blake3(roomId || epoch_le || "offline")`, the offline epoch key. */
export function offlineEpochKey(ownerId: string, epoch: number): Uint8Array {
  return blake3(
    concat([
      bs58.decode(offlineRoomId(ownerId)),
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
  const label = `number:room:offline:secret:${roomId}:${ownerId}:${epoch}:${recipient}`;
  const blob = new Uint8Array(OFFLINE_SECRET_BLOB_BYTES);
  blob[0] = 1;
  blob.set(blake3(encoder.encode(`${label}:eph`)), 1);
  blob.set(blake3(encoder.encode(`${label}:nonce`)).slice(0, 12), 33);
  blob.set(blake3(encoder.encode(`${label}:ct`)), 45);
  blob.set(blake3(encoder.encode(`${label}:tag`)).slice(0, 16), 77);
  return bytesToHex(blob);
}

function compareMessages(a: RoomMessageV1, b: RoomMessageV1): number {
  if (a.time !== b.time) return a.time - b.time;
  const aId = roomMessageId(a);
  const bId = roomMessageId(b);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

function seedState(ownerId: string): RoomStateV1 {
  const membership: RoomMembershipV1 = {
    seq: 1,
    members: [ownerId],
    secrets: [],
    sig: mockSignature(`membership:seed:${ownerId}`),
  };
  const welcome: RoomMessageV1 = {
    author: ownerId,
    epoch: 1,
    seq: 1,
    time: OFFLINE_ROOM_WELCOME_TIME,
    body: textToRoomBody("Welcome to the members room."),
    sig: mockSignature(`message:seed:${ownerId}`),
  };
  return { v: 1, memberships: [membership], messages: [welcome] };
}

export class OfflineRoomTransport implements RoomTransport {
  /** One lazily seeded room per owner id, so a deep link can read a parent room. */
  private readonly rooms = new Map<string, RoomStateV1>();

  constructor(private readonly ownerId: string) {}

  private roomFor(ownerId: string): RoomStateV1 {
    let state = this.rooms.get(ownerId);
    if (state === undefined) {
      state = seedState(ownerId);
      this.rooms.set(ownerId, state);
    }
    return state;
  }

  private ownerFor(ownerId: string): string {
    return ownerId || this.ownerId;
  }

  roomIdFor(ownerId: string): string {
    return offlineRoomId(this.ownerFor(ownerId));
  }

  async read(ownerId: string): Promise<RoomStateV1 | null> {
    return this.roomFor(this.ownerFor(ownerId));
  }

  async sealEpoch(
    ownerId: string,
    epoch: number,
    members: string[],
  ): Promise<RoomEpochKey> {
    const owner = this.ownerFor(ownerId);
    const roomId = offlineRoomId(owner);
    const epochKey = offlineEpochKey(owner, epoch);
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
      throw new RoomError("crypto", "offline room secret is not valid hex");
    }
    if (bytes.length !== OFFLINE_SECRET_BLOB_BYTES || bytes[0] !== 0x01) {
      throw new RoomError(
        "crypto",
        "offline room secret is not a 93-byte version-1 blob",
      );
    }
    const key = offlineEpochKey(owner, epoch);
    roomEpochKeyCache.set(offlineRoomId(owner), epoch, key);
    return key;
  }

  async epochKeyFor(
    ownerId: string,
    membership: RoomMembershipV1,
  ): Promise<Uint8Array | null> {
    if (membership.secrets.length === 0) return null;
    if (!membership.secrets.some((entry) => entry.recipient === this.ownerId)) {
      return null;
    }
    const owner = this.ownerFor(ownerId);
    const roomId = offlineRoomId(owner);
    const cached = roomEpochKeyCache.get(roomId, membership.seq);
    if (cached !== null) return cached;
    const key = offlineEpochKey(owner, membership.seq);
    roomEpochKeyCache.set(roomId, membership.seq, key);
    return key;
  }

  async updateMembership(
    ownerId: string,
    members: string[],
    options: RoomMembershipUpdateOptions = {},
  ): Promise<RoomStateV1> {
    const owner = this.ownerFor(ownerId);
    const state = this.roomFor(owner);
    const nextMembers = sortedUnique([...members, owner]);
    const latest = latestMembership(state);
    const seq = (latest?.seq ?? 0) + 1;
    const encrypt = options.encrypt ?? (latest?.secrets.length ?? 0) > 0;

    const sealed = encrypt
      ? await this.sealEpoch(owner, seq, nextMembers)
      : null;
    const record: RoomMembershipV1 = {
      seq,
      members: nextMembers,
      secrets: sealed?.secrets ?? [],
      sig: mockSignature(
        `membership:${seq}:${owner}:${nextMembers.join(",")}:${
          sealed?.epochKey ? bytesToHex(sealed.epochKey) : "plaintext"
        }`,
      ),
    };
    const next = {
      ...state,
      memberships: [...state.memberships, record],
    };
    this.rooms.set(owner, next);
    return next;
  }

  async sendMessage(
    roomOwnerId: string,
    bodyBytes: Uint8Array,
  ): Promise<RoomStateV1> {
    const owner = this.ownerFor(roomOwnerId);
    const state = this.roomFor(owner);
    const author = this.ownerId;
    const latest = latestMembership(state);
    if (!latest || !latest.members.includes(author)) {
      throw new RoomError(
        "not-member",
        "the sender is not a member of the latest room epoch",
      );
    }

    const epoch = latest.seq;
    const encrypted = latest.secrets.length > 0;
    const max = encrypted ? ROOM_ENCRYPTED_BODY_BYTE_LIMIT : ROOM_MAX_BODY_BYTES;
    if (bodyBytes.length < 1 || bodyBytes.length > max) {
      throw new RoomError(
        "write",
        `room message body must be 1..${max} bytes in this epoch`,
      );
    }

    let body: string;
    if (encrypted) {
      const key = await this.epochKeyFor(owner, latest);
      if (key === null) {
        throw new RoomError(
          "crypto",
          "this key has no epoch secret for the current membership",
        );
      }
      const envelope = await encryptRoomBody(
        key,
        {
          roomId: offlineRoomId(owner),
          owner,
          author,
          epoch,
        },
        new TextDecoder("utf-8", { fatal: false }).decode(bodyBytes),
      );
      body = bytesToHex(envelope);
    } else {
      body = bytesToHex(bodyBytes);
    }

    const seq = this.nextSeq(state, author);
    const time = Date.now();
    const message: RoomMessageV1 = {
      author,
      epoch,
      seq,
      time,
      body,
      sig: mockSignature(`message:${author}:${epoch}:${seq}:${time}:${body}`),
    };

    const messages = [...state.messages, message]
      .sort(compareMessages)
      .slice(-ROOM_MAX_MESSAGES);
    const next = { ...state, messages };
    this.rooms.set(owner, next);
    return next;
  }

  /** Offline e2e hook: a copy of the stored room state (never plaintext bodies). */
  snapshot(ownerId: string): RoomStateV1 | null {
    const state = this.rooms.get(this.ownerFor(ownerId));
    return state === undefined
      ? null
      : (JSON.parse(JSON.stringify(state)) as RoomStateV1);
  }

  private nextSeq(state: RoomStateV1, author: string): number {
    let max = 0;
    for (const message of state.messages) {
      if (message.author === author && message.seq > max) max = message.seq;
    }
    return max + 1;
  }
}
