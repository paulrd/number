import { describe, expect, it } from "vitest";
import {
  ROOM_BODY_OVERHEAD,
  ROOM_CRYPTO_TAG,
  ROOM_ENCRYPTED_BODY_BYTE_LIMIT,
  RoomCryptoError,
  RoomEpochKeyCache,
  decryptRoomBody,
  encryptRoomBody,
  epochKeyFromHex,
  epochKeyToHex,
  isEncryptedRoomBody,
  readRoomBody,
  roomBodyAad,
  type RoomBodyContext,
} from "./room-crypto";
import { textToRoomBody } from "./room-state";
import { bytesToHex } from "./util";

const OWNER = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
const AUTHOR = "66be7e332c7a453332bd9d0a7f7db055f5c5ef1a06ada66d98b39fb6810c473a";
const OTHER_AUTHOR = "aa".repeat(32);
const ROOM_ID = "9aYjgvx7v5ThiwYDKoKkottXRN6N2MefY4camU4DLFHX";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const CONTEXT: RoomBodyContext = {
  roomId: ROOM_ID,
  owner: OWNER,
  author: AUTHOR,
  epoch: 2,
};

describe("room body envelope", () => {
  it("defaults the AAD tag to ZMR1 and accepts a caller tag", async () => {
    expect(bytesToHex(roomBodyAad(CONTEXT))).toContain(
      bytesToHex(new TextEncoder().encode(ROOM_CRYPTO_TAG)),
    );

    const candidate = { ...CONTEXT, tag: "ZCR1" };
    expect(bytesToHex(roomBodyAad(candidate))).not.toBe(
      bytesToHex(roomBodyAad(CONTEXT)),
    );

    const envelope = await encryptRoomBody(KEY, candidate, "candidate text");
    await expect(
      decryptRoomBody(KEY, candidate, bytesToHex(envelope)),
    ).resolves.toBe("candidate text");
    await expect(
      decryptRoomBody(KEY, CONTEXT, bytesToHex(envelope)),
    ).rejects.toBeInstanceOf(RoomCryptoError);
  });

  it("round-trips text with the exact version || nonce || ciphertext || tag shape", async () => {
    const text = "hello encrypted room";
    const envelope = await encryptRoomBody(KEY, CONTEXT, text);

    expect(envelope[0]).toBe(0x01);
    expect(envelope).toHaveLength(
      new TextEncoder().encode(text).length + ROOM_BODY_OVERHEAD,
    );
    expect(isEncryptedRoomBody(bytesToHex(envelope))).toBe(true);
    await expect(
      decryptRoomBody(KEY, CONTEXT, bytesToHex(envelope)),
    ).resolves.toBe(text);
  });

  it("fails closed on a tampered ciphertext or tag", async () => {
    const envelope = await encryptRoomBody(KEY, CONTEXT, "tamper me");
    const tampered = new Uint8Array(envelope);
    tampered[tampered.length - 1] ^= 0x01;

    await expect(
      decryptRoomBody(KEY, CONTEXT, bytesToHex(tampered)),
    ).rejects.toBeInstanceOf(RoomCryptoError);
    await expect(
      readRoomBody(KEY, CONTEXT, bytesToHex(tampered)),
    ).resolves.toEqual({ kind: "unreadable" });
  });

  it("binds the author, owner, room and epoch into the AAD", async () => {
    const envelope = await encryptRoomBody(KEY, CONTEXT, "bound");
    await expect(
      decryptRoomBody(KEY, { ...CONTEXT, author: OTHER_AUTHOR }, bytesToHex(envelope)),
    ).rejects.toBeInstanceOf(RoomCryptoError);
    await expect(
      decryptRoomBody(KEY, { ...CONTEXT, epoch: 3 }, bytesToHex(envelope)),
    ).rejects.toBeInstanceOf(RoomCryptoError);
  });

  it("treats a non-0x01 body as legacy plaintext", async () => {
    const body = textToRoomBody("legacy hello");
    expect(isEncryptedRoomBody(body)).toBe(false);
    await expect(readRoomBody(null, CONTEXT, body)).resolves.toEqual({
      kind: "plaintext",
      text: "legacy hello",
    });
  });

  it("never falls back to plaintext for an unreadable 0x01 body", async () => {
    // A valid-looking envelope whose tag cannot authenticate.
    const body = bytesToHex(
      new Uint8Array([0x01, ...new Array(ROOM_BODY_OVERHEAD - 1).fill(0)]),
    );
    expect(isEncryptedRoomBody(body)).toBe(true);
    await expect(readRoomBody(KEY, CONTEXT, body)).resolves.toEqual({
      kind: "unreadable",
    });
    await expect(readRoomBody(null, CONTEXT, body)).resolves.toEqual({
      kind: "unreadable",
    });
  });

  it("rejects an empty message and a 996-byte plaintext", async () => {
    await expect(encryptRoomBody(KEY, CONTEXT, "")).rejects.toBeInstanceOf(
      RoomCryptoError,
    );
    await expect(
      encryptRoomBody(KEY, CONTEXT, "a".repeat(ROOM_ENCRYPTED_BODY_BYTE_LIMIT)),
    ).resolves.toBeInstanceOf(Uint8Array);
    await expect(
      encryptRoomBody(
        KEY,
        CONTEXT,
        "a".repeat(ROOM_ENCRYPTED_BODY_BYTE_LIMIT + 1),
      ),
    ).rejects.toBeInstanceOf(RoomCryptoError);
  });
});

describe("epoch key helpers and cache", () => {
  it("validates 32-byte hex keys", () => {
    expect(epochKeyFromHex(epochKeyToHex(KEY))).toEqual(KEY);
    expect(() => epochKeyFromHex("aa")).toThrow(RoomCryptoError);
    expect(() => epochKeyToHex(new Uint8Array(31))).toThrow(RoomCryptoError);
  });

  it("keys the cache by room and epoch and clears by room", () => {
    const cache = new RoomEpochKeyCache();
    const first = new Uint8Array(32).fill(1);
    const second = new Uint8Array(32).fill(2);

    cache.set(ROOM_ID, 1, first);
    cache.set(ROOM_ID, 2, second);
    expect(cache.get(ROOM_ID, 1)).toEqual(first);
    expect(cache.get(ROOM_ID, 3)).toBeNull();

    // Callers get a copy, not the stored buffer.
    cache.get(ROOM_ID, 1)![0] = 9;
    expect(cache.get(ROOM_ID, 1)![0]).toBe(1);

    cache.deleteRoom(ROOM_ID);
    expect(cache.has(ROOM_ID, 1)).toBe(false);
    expect(cache.has(ROOM_ID, 2)).toBe(false);
  });

  it("clears every room on clear()", () => {
    const cache = new RoomEpochKeyCache();
    cache.set(ROOM_ID, 1, new Uint8Array(32));
    cache.set("other", 1, new Uint8Array(32));
    cache.clear();
    expect(cache.get(ROOM_ID, 1)).toBeNull();
    expect(cache.get("other", 1)).toBeNull();
  });
});
