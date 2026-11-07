import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ROOM_MAX_MESSAGES,
  deriveRoomMembers,
  encodeRoomDelta,
  encodeRoomState,
  latestMembership,
  mergeRoomStates,
  parseRoomDelta,
  parseRoomState,
  roomBodyToText,
  roomDigest,
  roomMessageId,
  textToRoomBody,
  type RoomMembershipV1,
  type RoomMessageV1,
  type RoomStateV1,
} from "./room-state";
import { bytesToHex, hexToBytes } from "./util";

interface Golden {
  owner_vk_hex: string;
  state: RoomStateV1;
  state_bytes_hex: string;
  digest: string;
  message: { id: string };
}

const golden: Golden = JSON.parse(
  readFileSync(
    new URL("../../fixtures/rooms/golden_v1.json", import.meta.url),
    "utf-8",
  ),
);

const OWNER = golden.owner_vk_hex;
const AUTHOR = golden.state.messages[0].author;
const EPOCH = golden.state.memberships[0].seq;

function membership(
  seq: number,
  overrides: Partial<RoomMembershipV1> = {},
): RoomMembershipV1 {
  return {
    seq,
    members: [OWNER],
    secrets: [],
    // Unique per seq so merge ties can be exercised deterministically.
    sig: seq.toString(16).padStart(128, "0"),
    ...overrides,
  };
}

function message(index: number, overrides: Partial<RoomMessageV1> = {}): RoomMessageV1 {
  return {
    author: AUTHOR,
    epoch: EPOCH,
    seq: index + 1,
    time: index,
    body: "01",
    // Unique raw signature per index; id = BLAKE3(these bytes)[0..16].
    sig: (index + 1).toString(16).padStart(128, "0"),
    ...overrides,
  };
}

describe("room state golden vector", () => {
  it("decodes the golden state bytes", () => {
    const state = parseRoomState(hexToBytes(golden.state_bytes_hex));
    expect(state).toEqual(golden.state);
  });

  it("re-encodes the golden state byte-identically", () => {
    const state = parseRoomState(hexToBytes(golden.state_bytes_hex));
    expect(bytesToHex(encodeRoomState(state))).toBe(golden.state_bytes_hex);
  });

  it("matches the golden digest and message id", () => {
    const state = parseRoomState(hexToBytes(golden.state_bytes_hex));
    expect(roomDigest(state)).toBe(golden.digest);
    expect(roomMessageId(state.messages[0])).toBe(golden.message.id);
    expect(latestMembership(state)?.seq).toBe(EPOCH);
  });

  it("rejects malformed states with a typed error", () => {
    expect(() => parseRoomState(new TextEncoder().encode("{}"))).toThrow(
      /expected 1/,
    );
    const bad = new TextEncoder().encode(
      JSON.stringify({ v: 2, memberships: [], messages: [] }),
    );
    expect(() => parseRoomState(bad)).toThrow(/expected 1/);
  });
});

describe("room merge", () => {
  it("is commutative, associative and idempotent", () => {
    const base = membership(EPOCH, { members: [AUTHOR, OWNER] });
    const states: RoomStateV1[] = [
      { v: 1, memberships: [base], messages: [message(0), message(1)] },
      { v: 1, memberships: [base], messages: [message(2), message(3)] },
      {
        v: 1,
        memberships: [membership(EPOCH + 1, { members: [AUTHOR, OWNER] })],
        messages: [message(4, { epoch: EPOCH + 1 })],
      },
    ];

    const expected = mergeRoomStates(mergeRoomStates(states[0], states[1]), states[2]);
    expect(mergeRoomStates(states[0], states[1])).toEqual(
      mergeRoomStates(states[1], states[0]),
    );

    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      let result: RoomStateV1 = { v: 1, memberships: [], messages: [] };
      for (const index of order) result = mergeRoomStates(result, states[index]);
      expect(result).toEqual(expected);
    }

    expect(mergeRoomStates(expected, expected)).toEqual(expected);
  });

  it("keeps the greater signature for an equal membership seq", () => {
    const older = membership(4, { sig: "aa".repeat(64) });
    const newer = membership(4, { sig: "bb".repeat(64) });
    const merged = mergeRoomStates(
      { v: 1, memberships: [older], messages: [] },
      { v: 1, memberships: [newer], messages: [] },
    );
    expect(merged.memberships).toHaveLength(1);
    expect(merged.memberships[0].sig).toBe(newer.sig);
  });

  it("evicts the oldest memberships and messages deterministically", () => {
    const memberships = Array.from({ length: 40 }, (_, index) =>
      membership(index + 1),
    );
    const mergedMemberships = mergeRoomStates(
      { v: 1, memberships, messages: [] },
      { v: 1, memberships: [], messages: [] },
    );
    expect(mergedMemberships.memberships).toHaveLength(32);
    expect(mergedMemberships.memberships[0].seq).toBe(9);
    expect(mergedMemberships.memberships[31].seq).toBe(40);

    const messages = Array.from({ length: 205 }, (_, index) => message(index));
    const mergedMessages = mergeRoomStates(
      {
        v: 1,
        memberships: [membership(EPOCH, { members: [AUTHOR, OWNER] })],
        messages: messages.slice(0, 100),
      },
      {
        v: 1,
        memberships: [membership(EPOCH, { members: [AUTHOR, OWNER] })],
        messages: messages.slice(100),
      },
    );
    expect(mergedMessages.messages).toHaveLength(ROOM_MAX_MESSAGES);
    expect(mergedMessages.messages[0].time).toBe(5);
    expect(mergedMessages.messages[ROOM_MAX_MESSAGES - 1].time).toBe(204);
  });

  it("drops messages from unknown epochs and non-members", () => {
    const merged = mergeRoomStates(
      {
        v: 1,
        memberships: [membership(EPOCH, { members: [AUTHOR, OWNER] })],
        messages: [
          message(0),
          message(1, { author: "66".repeat(32) }),
          message(2, { epoch: EPOCH + 5 }),
        ],
      },
      { v: 1, memberships: [], messages: [] },
    );
    expect(merged.messages.map((item) => item.time)).toEqual([0]);
  });
});

describe("room helpers", () => {
  it("derives owner plus deduplicated, ascending contacts", () => {
    const a = "aar".padEnd(64, "0");
    const members = deriveRoomMembers(a, [a, "bb".repeat(32), "11".repeat(32)]);
    expect(members).toEqual(["11".repeat(32), "bb".repeat(32), a].sort());
    expect(new Set(members).size).toBe(members.length);
  });

  it("round-trips UTF-8 text through the body hex", () => {
    for (const text of ["hello room", "héllo → 世界", "🙂"]) {
      const body = textToRoomBody(text);
      expect(roomBodyToText(body)).toBe(text);
      expect(body).toMatch(/^[0-9a-f]+$/);
    }
    expect(roomBodyToText("ff")).toBe("\uFFFD");
  });

  it("encodes and parses deltas in the contract's field order", () => {
    const record = membership(EPOCH);
    const full: RoomStateV1 = {
      v: 1,
      memberships: [record],
      messages: [message(0)],
    };

    const fullBytes = encodeRoomDelta({ v: 1, full });
    expect(parseRoomDelta(fullBytes)).toEqual({ v: 1, full });

    const membershipBytes = encodeRoomDelta({
      v: 1,
      memberships: [record],
    });
    expect(new TextDecoder().decode(membershipBytes)).toBe(
      JSON.stringify({
        v: 1,
        memberships: [JSON.parse(JSON.stringify(record))],
      }),
    );
    expect(parseRoomDelta(membershipBytes)).toEqual({
      v: 1,
      memberships: [record],
    });

    const messageBytes = encodeRoomDelta({ v: 1, messages: [message(0)] });
    expect(parseRoomDelta(messageBytes)).toEqual({
      v: 1,
      messages: [message(0)],
    });
  });

  it("rejects a full delta that also carries incremental fields", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ v: 1, full: golden.state, messages: [golden.state.messages[0]] }),
    );
    expect(() => parseRoomDelta(bytes)).toThrow(/mutually exclusive/);
  });
});
