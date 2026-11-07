/**
 * In-memory members-room transport for `VITE_OFFLINE_MODE=1`.
 *
 * Offline mode has no room contract and no delegate, so this mirrors the
 * online transport's observable behaviour with deterministic mock signatures.
 * Nothing verifies those signatures, but the panel treats the state as real:
 * the records keep the contract's shapes, the membership seq advances, and
 * messages stay capped at 200.
 */

import { blake3 } from "@noble/hashes/blake3";
import { RoomError, type RoomTransport } from "./room-client";
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
import { bytesToHex } from "./util";

const encoder = new TextEncoder();

/** Fixed seed time so the seeded message is stable across offline reloads. */
export const OFFLINE_ROOM_WELCOME_TIME = 1_762_500_000_000;

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
  private state: RoomStateV1;

  constructor(private readonly ownerId: string) {
    this.state = seedState(ownerId);
  }

  async read(_ownerId: string): Promise<RoomStateV1 | null> {
    return this.state;
  }

  async updateMembership(
    ownerId: string,
    members: string[],
  ): Promise<RoomStateV1> {
    const owner = ownerId || this.ownerId;
    const nextMembers = sortedUnique([...members, owner]);
    const latest = latestMembership(this.state);
    const seq = (latest?.seq ?? 0) + 1;
    const record: RoomMembershipV1 = {
      seq,
      members: nextMembers,
      secrets: [],
      sig: mockSignature(
        `membership:${seq}:${owner}:${nextMembers.join(",")}`,
      ),
    };
    this.state = {
      ...this.state,
      memberships: [...this.state.memberships, record],
    };
    return this.state;
  }

  async sendMessage(
    ownerId: string,
    bodyBytes: Uint8Array,
  ): Promise<RoomStateV1> {
    if (
      bodyBytes.length < 1 ||
      bodyBytes.length > ROOM_MAX_BODY_BYTES
    ) {
      throw new RoomError(
        "write",
        `room message body must be 1..${ROOM_MAX_BODY_BYTES} bytes`,
      );
    }

    const latest = latestMembership(this.state);
    if (!latest || !latest.members.includes(ownerId)) {
      throw new RoomError(
        "not-member",
        "the room owner is not a member of the latest room epoch",
      );
    }

    const epoch = latest.seq;
    const seq = this.nextSeq(ownerId);
    const time = Date.now();
    const body = bytesToHex(bodyBytes);
    const message: RoomMessageV1 = {
      author: ownerId,
      epoch,
      seq,
      time,
      body,
      sig: mockSignature(
        `message:${ownerId}:${epoch}:${seq}:${time}:${body}`,
      ),
    };

    const messages = [...this.state.messages, message]
      .sort(compareMessages)
      .slice(-ROOM_MAX_MESSAGES);
    this.state = { ...this.state, messages };
    return this.state;
  }

  private nextSeq(author: string): number {
    let max = 0;
    for (const message of this.state.messages) {
      if (message.author === author && message.seq > max) max = message.seq;
    }
    return max + 1;
  }
}
