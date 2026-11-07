import { describe, expect, it } from "vitest";
import {
  ROOM_BODY_BYTE_LIMIT,
  ROOM_MESSAGE_LIMIT,
  formatRoomTime,
  roomComposerProblem,
  roomErrorCodeOf,
  roomMemberRows,
  roomMembershipChanges,
  roomMembershipState,
  roomMessageCountLabel,
  roomMessageRows,
  roomTargetLabel,
  roomTimeIso,
} from "./room-panel";
import type {
  RoomMembershipV1,
  RoomMessageV1,
} from "./room-state";

const OWNER = "aa".repeat(32);
const ALICE = "bb".repeat(32);
const BOB = "cc".repeat(32);
const CAROL = "dd".repeat(32);

function membership(
  members: string[],
  seq = 1,
): RoomMembershipV1 {
  return { seq, members, secrets: [], sig: "" };
}

function message(overrides: Partial<RoomMessageV1> = {}): RoomMessageV1 {
  return {
    author: ALICE,
    epoch: 1,
    seq: 1,
    time: 1_762_500_000_000,
    body: "68656c6c6f",
    sig: "1".repeat(128),
    ...overrides,
  };
}

function uniqueSig(index: number): string {
  return (index + 1).toString(16).padStart(128, "0");
}

describe("roomMembershipState", () => {
  it("is none without a signed membership", () => {
    expect(roomMembershipState(null, [OWNER])).toBe("none");
  });

  it("ignores order and duplicates when comparing members", () => {
    const signed = membership([ALICE, OWNER, ALICE]);
    expect(roomMembershipState(signed, [OWNER, ALICE])).toBe("match");
  });

  it("reports a mismatch when the derived set differs", () => {
    const signed = membership([OWNER, ALICE]);
    expect(roomMembershipState(signed, [OWNER, ALICE, BOB])).toBe("mismatch");
  });
});

describe("roomMembershipChanges", () => {
  it("lists the members a re-sign would add and remove", () => {
    const signed = membership([OWNER, ALICE, CAROL]);
    expect(
      roomMembershipChanges([OWNER, ALICE, BOB], signed),
    ).toEqual({ added: [BOB], removed: [CAROL] });
  });

  it("treats the first membership as all additions", () => {
    expect(roomMembershipChanges([OWNER, ALICE], null)).toEqual({
      added: [OWNER, ALICE],
      removed: [],
    });
  });
});

describe("roomMemberRows", () => {
  it("puts the owner first and marks stale signed members", () => {
    const signed = membership([OWNER, ALICE, CAROL]);
    const rows = roomMemberRows(OWNER, [OWNER, ALICE, BOB], signed);
    expect(rows).toEqual([
      { id: OWNER, kind: "owner", state: "in-room" },
      { id: ALICE, kind: "child", state: "in-room" },
      { id: BOB, kind: "child", state: "not-in-room" },
      { id: CAROL, kind: "stale", state: "stale" },
    ]);
  });

  it("shows every derived child as not in room before the first signature", () => {
    const rows = roomMemberRows(OWNER, [OWNER, ALICE], null);
    expect(rows).toEqual([
      { id: OWNER, kind: "owner", state: "not-in-room" },
      { id: ALICE, kind: "child", state: "not-in-room" },
    ]);
  });

  it("renders a foreign room from its signed membership alone", () => {
    const signed = membership([OWNER, ALICE, CAROL]);
    const rows = roomMemberRows(OWNER, [BOB], signed, false);
    expect(rows).toEqual([
      { id: OWNER, kind: "owner", state: "in-room" },
      { id: ALICE, kind: "child", state: "in-room" },
      { id: CAROL, kind: "child", state: "in-room" },
    ]);
  });
});

describe("roomTargetLabel", () => {
  it("names a parent room and any other foreign room", () => {
    expect(roomTargetLabel(OWNER, OWNER)).toBe("Your parent's room");
    expect(roomTargetLabel(OWNER, ALICE)).toBe("Another zone's room");
    expect(roomTargetLabel(OWNER, null)).toBe("Another zone's room");
  });
});

describe("roomMessageRows", () => {
  it("marks old epochs as history and divides the current epoch once", () => {
    const messages = [
      message({ epoch: 1, time: 100, sig: "1".repeat(128) }),
      message({ epoch: 1, time: 200, sig: "2".repeat(128) }),
      message({ epoch: 2, time: 300, sig: "3".repeat(128) }),
    ];
    const rows = roomMessageRows(messages, 2);
    expect(rows.map((row) => row.history)).toEqual([true, true, false]);
    expect(rows.map((row) => row.dividerBefore)).toEqual([false, false, true]);
  });

  it("keeps only the newest 200 messages", () => {
    const messages = Array.from({ length: ROOM_MESSAGE_LIMIT + 1 }, (_, index) =>
      message({ epoch: 1, time: index, sig: uniqueSig(index) }),
    );
    const rows = roomMessageRows(messages, 1);
    expect(rows).toHaveLength(ROOM_MESSAGE_LIMIT);
    expect(rows[0].message.time).toBe(1);
    expect(rows[rows.length - 1].message.time).toBe(ROOM_MESSAGE_LIMIT);
  });

  it("does not insert a divider when there is no history", () => {
    const rows = roomMessageRows([message({ epoch: 2 })], 2);
    expect(rows).toEqual([
      { message: expect.objectContaining({ epoch: 2 }), history: false, dividerBefore: false },
    ]);
  });
});

describe("roomMessageCountLabel", () => {
  it("names empty, single, full and capped lists", () => {
    expect(roomMessageCountLabel(0, 0)).toBe("No messages");
    expect(roomMessageCountLabel(1, 1)).toBe("1 message");
    expect(roomMessageCountLabel(3, 3)).toBe("3 messages");
    expect(roomMessageCountLabel(250, 200)).toBe("Latest 200 of 250");
  });
});

describe("roomComposerProblem", () => {
  it("rejects empty and whitespace-only messages", () => {
    expect(roomComposerProblem("")).not.toBeNull();
    expect(roomComposerProblem("   \n ")).not.toBeNull();
  });

  it("accepts exactly 1024 UTF-8 bytes and rejects one more", () => {
    expect(roomComposerProblem("a".repeat(ROOM_BODY_BYTE_LIMIT))).toBeNull();
    expect(
      roomComposerProblem("a".repeat(ROOM_BODY_BYTE_LIMIT + 1)),
    ).not.toBeNull();
    expect(roomComposerProblem("é".repeat(512))).toBeNull();
    expect(roomComposerProblem("é".repeat(513))).not.toBeNull();
  });
});

describe("room time", () => {
  it("treats time as milliseconds", () => {
    const value = 1_762_500_000_000;
    expect(roomTimeIso(value)).toBe(new Date(value).toISOString());
    expect(formatRoomTime(value)).not.toBe("Unknown time");
  });

  it("rejects invalid times", () => {
    expect(roomTimeIso(-1)).toBeNull();
    expect(roomTimeIso(Number.NaN)).toBeNull();
    expect(roomTimeIso(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatRoomTime(-1)).toBe("Unknown time");
  });
});

describe("roomErrorCodeOf", () => {
  it("recognises transport error codes without requiring an Error instance", () => {
    expect(roomErrorCodeOf({ code: "connection" })).toBe("connection");
    expect(roomErrorCodeOf({ code: "not-member" })).toBe("not-member");
  });

  it("ignores unknown codes", () => {
    expect(roomErrorCodeOf(null)).toBeNull();
    expect(roomErrorCodeOf(new Error("boom"))).toBeNull();
    expect(roomErrorCodeOf({ code: "mystery" })).toBeNull();
  });
});
