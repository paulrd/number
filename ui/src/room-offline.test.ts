import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineRoomTransport, OFFLINE_ROOM_WELCOME_TIME } from "./room-offline";
import {
  ROOM_MAX_MESSAGES,
  latestMembership,
  roomBodyToText,
  type RoomMessageV1,
} from "./room-state";
import { RoomError } from "./room-client";
import { isLowerHex } from "./util";

const OWNER = "aa".repeat(32);
const CHILD = "bb".repeat(32);
const STRANGER = "cc".repeat(32);
const encoder = new TextEncoder();

function bodyText(message: RoomMessageV1): string {
  return roomBodyToText(message.body);
}

describe("OfflineRoomTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds one owner membership and one welcome message", async () => {
    const transport = new OfflineRoomTransport(OWNER);
    const state = await transport.read(OWNER);

    expect(state).not.toBeNull();
    const membership = latestMembership(state!);
    expect(membership).not.toBeNull();
    expect(membership!.seq).toBe(1);
    expect(membership!.members).toEqual([OWNER]);
    expect(membership!.secrets).toEqual([]);
    expect(isLowerHex(membership!.sig, 128)).toBe(true);

    expect(state!.messages).toHaveLength(1);
    const welcome = state!.messages[0];
    expect(welcome.author).toBe(OWNER);
    expect(welcome.epoch).toBe(1);
    expect(welcome.time).toBe(OFFLINE_ROOM_WELCOME_TIME);
    expect(bodyText(welcome)).toBe("Welcome to the members room.");
    expect(isLowerHex(welcome.sig, 128)).toBe(true);
  });

  it("keeps one lazily seeded room per owner", async () => {
    const transport = new OfflineRoomTransport(OWNER);

    const own = await transport.read(OWNER);
    const other = await transport.read(CHILD);

    expect(latestMembership(own!)!.members).toEqual([OWNER]);
    expect(latestMembership(other!)!.members).toEqual([CHILD]);
    expect(own!.messages[0].author).toBe(OWNER);
    expect(other!.messages[0].author).toBe(CHILD);

    // A write to one room is not visible from another.
    await transport.updateMembership(CHILD, [STRANGER]);
    expect((await transport.read(OWNER))!.memberships).toHaveLength(1);
    expect(latestMembership((await transport.read(CHILD))!)!.members).toEqual(
      [CHILD, STRANGER].sort(),
    );
  });

  it("sends as the constructor owner into a foreign room when it is a member", async () => {
    const transport = new OfflineRoomTransport(OWNER);
    await transport.updateMembership(CHILD, [OWNER]);

    const state = await transport.sendMessage(CHILD, encoder.encode("hello parent"));
    const message = state.messages[state.messages.length - 1];

    expect(message.author).toBe(OWNER);
    expect(message.epoch).toBe(2);
    expect(bodyText(message)).toBe("hello parent");
  });

  it("advances the membership seq and normalises the member list", async () => {
    const transport = new OfflineRoomTransport(OWNER);
    const seeded = await transport.read(OWNER);

    const state = await transport.updateMembership(OWNER, [
      CHILD,
      OWNER,
      CHILD,
    ]);
    const membership = latestMembership(state);

    expect(membership!.seq).toBe(2);
    expect(membership!.members).toEqual([OWNER, CHILD].sort());
    expect(isLowerHex(membership!.sig, 128)).toBe(true);
    expect(membership!.sig).not.toBe(latestMembership(seeded!)!.sig);
    // Earlier messages survive a membership update as history.
    expect(state.messages).toEqual(seeded!.messages);
  });

  it("appends a message at the latest epoch with the owner as author", async () => {
    const transport = new OfflineRoomTransport(OWNER);
    await transport.updateMembership(OWNER, [CHILD]);

    const state = await transport.sendMessage(
      OWNER,
      encoder.encode("hello room"),
    );
    const message = state.messages[state.messages.length - 1];

    expect(state.messages).toHaveLength(2);
    expect(message.author).toBe(OWNER);
    expect(message.epoch).toBe(2);
    expect(message.seq).toBeGreaterThan(state.messages[0].seq);
    expect(bodyText(message)).toBe("hello room");
    expect(isLowerHex(message.sig, 128)).toBe(true);

    const next = await transport.sendMessage(OWNER, encoder.encode("again"));
    expect(next.messages).toHaveLength(3);
    const again = next.messages.find((item) => bodyText(item) === "again");
    expect(again?.seq).toBe(message.seq + 1);
  });

  it("rejects a message from a key outside the latest membership", async () => {
    const transport = new OfflineRoomTransport(OWNER);

    await expect(
      transport.sendMessage(STRANGER, encoder.encode("nope")),
    ).rejects.toBeInstanceOf(RoomError);
    await expect(
      transport.sendMessage(STRANGER, encoder.encode("nope")),
    ).rejects.toMatchObject({ code: "not-member" });
  });

  it("caps retained messages at 200, keeping the newest", async () => {
    vi.useFakeTimers();
    const transport = new OfflineRoomTransport(OWNER);
    let now = OFFLINE_ROOM_WELCOME_TIME + 1;

    for (let index = 0; index < 205; index += 1) {
      vi.setSystemTime(now);
      now += 1;
      await transport.sendMessage(OWNER, encoder.encode(`message ${index}`));
    }

    const state = await transport.read(OWNER);
    expect(state!.messages).toHaveLength(ROOM_MAX_MESSAGES);
    expect(bodyText(state!.messages[0])).toBe("message 5");
    expect(bodyText(state!.messages[state!.messages.length - 1])).toBe(
      "message 204",
    );
  });
});
